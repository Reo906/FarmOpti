import { CONFIG, type ConfigDict } from "../config";
import { DecisionRetriever, type RetrievedRecord } from "./retrieveDecisions";
import { ScenarioParser } from "./scenario/parser";
import { ScenarioValidationError, ScenarioValidator } from "./scenario/validator";
import type { ScenarioRunner } from "./scenario/runner";
import type { ChatMessage } from "./scenario/parser";
import { ConfigUpdateParser, ConfigUpdateValidationError, type ConfigChangeProposal } from "./configUpdate/parser";
import { applyConfigChangeProposal } from "./configUpdate/applier";
import fs from "node:fs";
import { generateCandidates } from "../candidateGeneration";
import { writeCandidateActionsCsv, writeScheduleCsv } from "../csvWriters";
import { runActionCounterfactuals } from "../decisionAnalysis/analyseCounterfactuals";
import { buildDecisionIndex, saveDecisionIndex } from "../decisionAnalysis/buildDecisionIndex";
import { generateDecisionTrace, updateImportance } from "../decisionAnalysis/extractDecisions";
import { generateFieldOptions } from "../fieldOptions";
import { saveFieldOptions } from "../fieldOptionsIO";
import { optimizeSchedule } from "../scheduleOptimizer";
import { CANDIDATE_ACTIONS_PATH, DECISION_TRACE_PATH, EXTERNAL_DIR, SCHEDULE_PATH, SUMMARY_PATH } from "../paths";
import { readCsv } from "../csv";
import { parseTimestamp } from "../datetime";
import { compareScenarios } from "./scenario/comparator";
import type { OptimizationSummary, ScheduleRow } from "../types";

// config.yaml's explanation.llm can hold either one flat provider config, or
// a set of named provider profiles ("providers") plus which one is "active".
// The LLM_PROVIDER environment variable overrides "active" without editing
// the file -- e.g. keep "ollama" as the checked-in default for local dev and
// set LLM_PROVIDER=groq wherever there's no local model server to talk to.
function resolveLlmConfig(section: ConfigDict): ConfigDict {
  if (!section.providers) return section;
  const name = process.env.LLM_PROVIDER || section.active;
  const profile = section.providers[name];
  if (!profile) {
    const source = process.env.LLM_PROVIDER ? "LLM_PROVIDER environment variable" : "explanation.llm.active in config.yaml";
    throw new Error(`Unknown LLM provider "${name}" (from ${source}). Available: ${Object.keys(section.providers).join(", ")}`);
  }
  return profile;
}

const LLM_CONFIG = resolveLlmConfig(CONFIG.explanation.llm);
const PROCESS_CONFIG = CONFIG.explanation.process_display ?? {};
const SCENARIO_CONFIG = CONFIG.explanation.scenario ?? {};

function processPrint(message: string): void {
  if (PROCESS_CONFIG.enabled ?? true) console.log(message);
}

const SYSTEM_PROMPT = `
You explain decisions made by a mathematical farm optimisation system.

Rules:
1. Use only the supplied optimisation evidence.
2. Never invent a reason that is not supported by the evidence.
3. Answer the exact decision the user asked about.
4. Do not discuss other fields or plans unless they directly affected the target decision.
5. Start with the main reason for the decision.
6. Clearly distinguish direct cash effects, field-state effects, terminal crop value, and whole-farm objective changes.
7. Counterfactual objective changes are the strongest evidence for explaining why optional actions were selected or skipped.
8. A negative direct cash effect does not mean an action was economically harmful if it improves the final whole-farm objective.
9. Never describe a forced counterfactual action as an action selected by the original optimiser.
10. If a counterfactual scenario is infeasible, say only that the alternative could not produce a feasible whole-farm schedule.
11. If the evidence is insufficient to establish a reason, say so.
12. Be concise. Normally answer in one or two short paragraphs.
13. The optimiser made the scheduling decision. You only explain its evidence.
`.trim();

const CLASSIFICATION_PROMPT = `
Classify the user's FarmOpti request as exactly one of three modes.

EXPLAIN:
The user is asking about the existing optimisation result, including its decisions, timing, feasibility, alternatives, values, state changes, resources, or reasoning. Use EXPLAIN when the question can be answered from the existing optimisation and its recorded evidence.

SCENARIO:
The user wants to see the effect of a hypothetical, ONE-OFF, throwaway change -- "what if", "would it be better if", a single trial condition to compare against the current plan. A scenario never modifies the real farm data; it only tests a possibility.

CONFIG_UPDATE:
The user is telling FarmOpti about a REAL, LASTING change to the farm itself that should be remembered for every future plan: a new or changed piece of equipment, or a permanent adjustment to an operating threshold/limit/rule of thumb. This is not a hypothetical -- the user is reporting a fact ("we bought...", "M3 now costs...", "only spray when...", "raise/lower the ... limit to ...") that should update the underlying configuration, not just be tested once.

Important distinctions:
- "Why was F2 sprayed?" -> EXPLAIN
- "Could F1 have been harvested later?" -> EXPLAIN
- "What if F1 is harvested on September 25?" -> SCENARIO
- "Would profit be higher if F1 were harvested on September 25?" -> SCENARIO
- "Add 3 ML of water on September 20." -> SCENARIO (a one-off day, not a lasting change)
- "Don't spray F2." -> SCENARIO (this run's plan only)
- "We just bought a new harvester, M8, costing $180/hour." -> CONFIG_UPDATE
- "M3's cost per hour is now 45." -> CONFIG_UPDATE
- "Only spray when wind speed is below 15 km/h from now on." -> CONFIG_UPDATE
- "Raise the beam search width to 120." -> CONFIG_UPDATE
- "Never harvest above 40 km/h wind." -> CONFIG_UPDATE

The key test: would the user still want this true next week, for a completely different plan? If yes -> CONFIG_UPDATE. If it's testing one specific hypothetical -> SCENARIO.

Do not classify a request as SCENARIO or CONFIG_UPDATE merely because it contains words such as could, would, possible, alternative, later, earlier, or why not. Those remain EXPLAIN unless the user actually supplies a changed condition to evaluate.

Return only the structured classification required by the supplied schema.
`.trim();

const CLASSIFICATION_SCHEMA = {
  type: "object",
  properties: { mode: { type: "string", enum: ["explain", "scenario", "config_update"] } },
  required: ["mode"],
  additionalProperties: false,
};

const SCENARIO_EXPLANATION_PROMPT = `
You explain the result of a user-requested FarmOpti re-optimisation scenario.

Rules:
1. The baseline schedule is the original optimiser result.
2. The scenario schedule is the result after applying the validated user-requested modification.
3. Use only the supplied scenario comparison and resolved changes.
4. State whether the whole-farm objective increased or decreased.
5. Mention important actions that were added, removed, or rescheduled.
6. Do not invent causal reasons that are not supported by the supplied result.
7. Do not claim the LLM performed the optimisation.
8. Be concise.
`.trim();

interface ChatOptions {
  responseSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
}

export class LLMClient {
  provider: string;
  model: string;
  baseUrl: string;
  temperature: number;
  timeoutSeconds: number;
  maxOutputTokens: number;
  apiKey: string;

  constructor() {
    this.provider = String(LLM_CONFIG.provider).toLowerCase();
    this.model = String(LLM_CONFIG.model);
    this.baseUrl = String(LLM_CONFIG.base_url).replace(/\/+$/, "");
    this.temperature = Number(LLM_CONFIG.temperature);
    this.timeoutSeconds = Number(LLM_CONFIG.timeout_seconds);
    this.maxOutputTokens = Number(LLM_CONFIG.max_output_tokens ?? 250);
    const apiKeyEnv = String(LLM_CONFIG.api_key_env ?? "LLM_API_KEY");
    this.apiKey = process.env[apiKeyEnv] ?? "";
    processPrint(`[INIT] LLM ready | provider=${this.provider} | model=${this.model}`);
  }

  private async postJson(url: string, payload: unknown, headers: Record<string, string> = {}): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutSeconds * 1000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`LLM request failed (${response.status}): ${body}`);
      }

      return await response.json();
    } catch (exc: any) {
      if (exc.name === "AbortError") throw new Error(`LLM request to ${url} timed out`);
      throw new Error(`Could not connect to LLM at ${url}: ${exc}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async ollama(messages: ChatMessage[], responseSchema?: Record<string, unknown>, maxOutputTokens?: number): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      options: {
        temperature: this.temperature,
        num_predict: maxOutputTokens ?? this.maxOutputTokens,
      },
    };
    if (responseSchema !== undefined) payload.format = responseSchema;
    const result = await this.postJson(`${this.baseUrl}/api/chat`, payload);
    return String(result.message.content).trim();
  }

  private async openaiCompatible(messages: ChatMessage[], responseSchema?: Record<string, unknown>, maxOutputTokens?: number): Promise<string> {
    const url = this.baseUrl.endsWith("/v1") ? `${this.baseUrl}/chat/completions` : `${this.baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
    const payload: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: maxOutputTokens ?? this.maxOutputTokens,
    };
    if (responseSchema !== undefined) {
      payload.response_format = {
        type: "json_schema",
        json_schema: { name: "farmopti_structured_response", strict: true, schema: responseSchema },
      };
    }
    const result = await this.postJson(url, payload, headers);
    return String(result.choices[0].message.content).trim();
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    if (this.provider === "ollama") return this.ollama(messages, options.responseSchema, options.maxOutputTokens);
    if (["openai", "openai_compatible", "compatible"].includes(this.provider)) {
      return this.openaiCompatible(messages, options.responseSchema, options.maxOutputTokens);
    }
    throw new Error(`Unsupported LLM provider: ${this.provider}`);
  }
}

export interface AnswerResult {
  answer: string;
  needs_reoptimization: boolean;
  scenario_error?: boolean;
  scenario_result?: unknown;
  evidence?: RetrievedRecord[];
  config_update_error?: boolean;
  needs_confirmation?: boolean;
  pending_proposal?: ConfigChangeProposal;
}

function describeProposal(proposal: ConfigChangeProposal): string {
  if (proposal.kind === "config_update") {
    return `Change ${proposal.path} from ${JSON.stringify(proposal.previous_value)} to ${JSON.stringify(proposal.new_value)}.`;
  }
  if (proposal.kind === "machine_change") {
    const c = proposal.change;
    if (c.mode === "add") {
      return `Add a new machine ${c.machine_id} (${c.machine_type}) at $${c.cost_per_hour_aud}/hour, available ${c.available_from}-${c.available_to} every day of the current planning horizon.`;
    }
    return `Update machine ${c.machine_id}: type=${c.machine_type}, cost=$${c.cost_per_hour_aud}/hour, current_field=${c.current_field || "(none)"}.`;
  }
  if (proposal.kind === "rule_change") {
    if (proposal.action === "add") return `Add farm rule: ${proposal.rule.description}`;
    return `Remove farm rule ${proposal.rule.id}: ${proposal.rule.description}`;
  }
  return proposal.reason;
}

export class ExplanationService {
  retriever: DecisionRetriever;
  llm: LLMClient;
  private scenarioParser: ScenarioParser | null = null;
  private scenarioRunner: ScenarioRunner | null = null;
  private configUpdateParser: ConfigUpdateParser;

  constructor() {
    processPrint("[INIT] Initialising explanation service...");
    this.retriever = new DecisionRetriever();
    this.llm = new LLMClient();
    this.configUpdateParser = new ConfigUpdateParser(this.llm);

    if (SCENARIO_CONFIG.enabled ?? true) {
      // Classifying a request and parsing a scenario only need the schema/
      // validation layer (ScenarioValidator), so build that eagerly. The
      // actual ScenarioRunner additionally pulls in the whole-farm LP solver
      // and its WASM loader, which some web runtimes (this one included)
      // cannot resolve outside a real Node process -- so that stays a lazy
      // import in ensureScenarioRunner(), loaded only once a scenario is
      // actually requested, instead of failing every question up front.
      const validator = new ScenarioValidator(EXTERNAL_DIR);
      this.scenarioParser = new ScenarioParser(this.llm, validator);
    }

    processPrint("[INIT] Explanation service ready");
  }

  private async ensureScenarioRunner(): Promise<ScenarioRunner> {
    if (!this.scenarioRunner) {
      const { ScenarioRunner: Runner } = await import("./scenario/runner");
      this.scenarioRunner = new Runner();
    }
    return this.scenarioRunner;
  }

  private compactActionEvidence(action: any): any {
    if (!action) return null;

    const timing = action.timing ?? {};
    const transition = action.state_transition ?? {};
    const counterfactual = action.counterfactual ?? null;
    let compactCounterfactual = null;

    if (counterfactual) {
      compactCounterfactual = {
        scenario: counterfactual.scenario,
        feasible: counterfactual.feasible,
        baseline_objective_aud: counterfactual.baseline_objective_aud,
        counterfactual_objective_aud: counterfactual.counterfactual_objective_aud,
        objective_change_aud: counterfactual.objective_change_aud,
        affected_decisions: (counterfactual.affected_decisions ?? []).slice(0, 5),
      };
    }

    return {
      selected: action.selected,
      required: action.required,
      financial: action.financial,
      timing: {
        selected_time: timing.selected_time,
        selected_candidate_id: timing.selected_candidate_id,
        earliest_feasible_time: timing.earliest_feasible_time,
        latest_feasible_time: timing.latest_feasible_time,
        feasible_candidate_count: timing.feasible_candidate_count,
        alternative_times: (timing.alternative_times ?? []).slice(0, 3),
      },
      state_changes: transition.state_changes,
      counterfactual: compactCounterfactual,
    };
  }

  private compactFieldEvidence(field: any): any {
    if (!field) return null;
    return {
      selected_option_id: field.selected_option_id,
      selected_objective_value_aud: field.selected_objective_value_aud,
      selected_direct_cash_effect_aud: field.selected_direct_cash_effect_aud,
      selected_terminal_value_aud: field.selected_terminal_value_aud,
      best_local_alternative: field.best_local_alternative,
    };
  }

  private buildContext(records: RetrievedRecord[]): { decisions: unknown[]; other_evidence: unknown[] } {
    const plans = new Map<string, any>();
    const other: unknown[] = [];

    for (const record of records) {
      const planId = record.plan_id;
      if (!planId) {
        other.push({ decision_id: record.decision_id, type: record.type, text: record.text });
        continue;
      }

      if (!plans.has(planId)) {
        plans.set(planId, {
          plan_id: planId,
          field_id: record.field_id,
          operation: record.operation,
          target_decision: Boolean(record.target_match),
          retrieved_evidence: [],
          action_evidence: this.compactActionEvidence(record.raw_action_evidence),
          field_evidence: this.compactFieldEvidence(record.raw_field_evidence),
        });
      }

      plans.get(planId).retrieved_evidence.push({ decision_id: record.decision_id, type: record.type, text: record.text });
    }

    return { decisions: [...plans.values()], other_evidence: other };
  }

  private async generate(prompt: string, systemPrompt: string = SYSTEM_PROMPT): Promise<string> {
    processPrint(`[LLM] ${this.llm.model} -> generating explanation...`);
    const start = Date.now();
    const answer = await this.llm.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ]);
    const elapsed = (Date.now() - start) / 1000;
    processPrint(PROCESS_CONFIG.show_llm_timing ?? true ? `[LLM] Done (${elapsed.toFixed(2)}s)` : "[LLM] Done");
    return answer;
  }

  private async classifyRequest(question: string): Promise<"explain" | "scenario" | "config_update"> {
    processPrint("[CLASSIFY] Classifying request...");
    const start = Date.now();
    let mode: "explain" | "scenario" | "config_update" = "explain";

    try {
      const response = await this.llm.chat(
        [
          { role: "system", content: CLASSIFICATION_PROMPT },
          { role: "user", content: question },
        ],
        { responseSchema: CLASSIFICATION_SCHEMA, maxOutputTokens: 30 },
      );
      mode = String(JSON.parse(response).mode).toLowerCase() as "explain" | "scenario" | "config_update";
    } catch (exc) {
      processPrint(`[CLASSIFY] Invalid classifier response (${exc}) -> EXPLAIN fallback`);
      mode = "explain";
    }

    if (mode === "scenario" && !this.scenarioParser) mode = "explain";

    const elapsed = (Date.now() - start) / 1000;
    processPrint(`[CLASSIFY] ${mode.toUpperCase()} (${elapsed.toFixed(2)}s)`);
    return mode;
  }

  private async runScenario(question: string): Promise<AnswerResult> {
    processPrint("[SCENARIO] Parsing requested modification...");

    let interpretation;
    try {
      interpretation = await this.scenarioParser!.parse(question);
    } catch (exc) {
      if (exc instanceof ScenarioValidationError) {
        processPrint(`[SCENARIO] Invalid scenario: ${exc.message}`);
        return {
          answer: `I understood this as a scenario change, but could not translate it into a valid FarmOpti modification: ${exc.message}`,
          needs_reoptimization: false,
          scenario_error: true,
        };
      }
      throw exc;
    }

    if (SCENARIO_CONFIG.show_parsed_scenario ?? true) {
      processPrint("[SCENARIO] Validated modification:");
      processPrint(JSON.stringify(interpretation, null, 2));
    }

    processPrint("[SCENARIO] Re-optimising...");
    const start = Date.now();

    let result;
    try {
      const runner = await this.ensureScenarioRunner();
      result = await runner.run(interpretation);
    } catch (exc: any) {
      const message = String(exc?.message ?? exc);
      processPrint(`[SCENARIO] Re-optimisation failed: ${message}`);
      // Re-running the whole-farm solver needs its WASM binary and (for
      // scenarios that change input values or timing) writable temp storage,
      // neither of which this web deployment's runtime can provide. Give a
      // clear, honest answer instead of surfacing that raw platform error.
      const runtimeUnavailable = !(exc instanceof ScenarioValidationError) && /wasm|readAll|file: URL/i.test(message);
      return {
        answer: runtimeUnavailable
          ? "Testing a concrete scenario needs to re-run the whole-farm solver, and this web deployment's runtime can't load it. Ask about the existing schedule's decisions and evidence instead, or run FarmOpti's CLI pipeline to test what-if scenarios."
          : `FarmOpti understood the requested modification, but could not produce a feasible scenario result: ${message}`,
        needs_reoptimization: false,
        scenario_error: true,
      };
    }

    const comparison = result.comparison;
    if (SCENARIO_CONFIG.show_comparison ?? true) {
      processPrint(
        `[SCENARIO] Objective: $${comparison.baseline_objective_aud.toLocaleString()} -> $${comparison.scenario_objective_aud.toLocaleString()} (${comparison.objective_change_aud >= 0 ? "+" : ""}${comparison.objective_change_aud.toLocaleString()})`,
      );
      processPrint(
        `[SCENARIO] Schedule changes | added=${comparison.actions_added.length} | removed=${comparison.actions_removed.length} | rescheduled=${comparison.actions_rescheduled.length}`,
      );
    }

    const elapsed = (Date.now() - start) / 1000;
    processPrint(`[SCENARIO] Re-optimisation complete (${elapsed.toFixed(2)}s)`);

    const prompt = `
The user requested this FarmOpti scenario:
${question}

Validated modification:
${JSON.stringify(result.scenario, null, 2)}

Deterministically resolved changes:
${JSON.stringify(result.resolved_changes, null, 2)}

Comparison against the original optimisation:
${JSON.stringify(result.comparison, null, 2)}

New optimisation summary:
${JSON.stringify(result.summary, null, 2)}

Explain what changed and whether the requested scenario improved or reduced the whole-farm financial objective.
`.trim();

    const answer = await this.generate(prompt, SCENARIO_EXPLANATION_PROMPT);
    return { answer, needs_reoptimization: false, scenario_result: result };
  }

  private async runConfigUpdate(question: string): Promise<AnswerResult> {
    processPrint("[CONFIG] Parsing requested configuration change...");

    let proposal: ConfigChangeProposal;
    try {
      proposal = await this.configUpdateParser.parse(question);
    } catch (exc) {
      if (exc instanceof ConfigUpdateValidationError) {
        processPrint(`[CONFIG] Invalid proposal: ${exc.message}`);
        return {
          answer: `I understood this as a lasting configuration change, but could not translate it into a valid update: ${exc.message}`,
          needs_reoptimization: false,
          config_update_error: true,
        };
      }
      throw exc;
    }

    if (proposal.kind === "unsupported") {
      processPrint(`[CONFIG] Unsupported: ${proposal.reason}`);
      return {
        answer: `This describes a new kind of rule FarmOpti's configuration can't express yet (${proposal.reason}). It isn't an existing threshold or machine field, so I can't apply it as a config update -- this would need new code, not a data change.`,
        needs_reoptimization: false,
        config_update_error: true,
      };
    }

    processPrint(`[CONFIG] Proposed: ${describeProposal(proposal)}`);
    return {
      answer: `I'd make this lasting change: ${describeProposal(proposal)}\n\nThis will persist for every future plan, not just a one-off test. Reply to confirm and I'll apply it and re-run the optimiser, or say no to discard it.`,
      needs_reoptimization: false,
      needs_confirmation: true,
      pending_proposal: proposal,
    };
  }

  /** Persistently applies a proposal from runConfigUpdate() and re-runs the full pipeline. */
  async confirmConfigUpdate(proposal: ConfigChangeProposal): Promise<{ answer: string; before: OptimizationSummary | null; after: OptimizationSummary }> {
    const before = fs.existsSync(SUMMARY_PATH) ? (JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf-8")) as OptimizationSummary) : null;
    const beforeSchedule: ScheduleRow[] = fs.existsSync(SCHEDULE_PATH)
      ? readCsv(SCHEDULE_PATH).map((r) => ({
          option_id: r.option_id,
          candidate_id: r.candidate_id,
          plan_id: r.plan_id,
          field_id: r.field_id,
          operation: r.operation,
          target: r.target,
          start_time: parseTimestamp(r.start_time),
          end_time: parseTimestamp(r.end_time),
          machine_id: r.machine_id,
          workers_required: Number(r.workers_required),
          water_ml: Number(r.water_ml),
          direct_revenue_aud: Number(r.direct_revenue_aud),
          direct_cost_aud: Number(r.direct_cost_aud),
          direct_cash_effect_aud: Number(r.direct_cash_effect_aud),
          state_yield_effect_t_ha: Number(r.state_yield_effect_t_ha),
        }))
      : [];

    processPrint("[CONFIG] Applying change...");
    applyConfigChangeProposal(proposal);

    processPrint("[CONFIG] Re-running the full optimizer pipeline...");
    const candidates = generateCandidates();
    writeCandidateActionsCsv(CANDIDATE_ACTIONS_PATH, candidates);

    const options = generateFieldOptions();
    saveFieldOptions(options);

    const { schedule, summary: after } = await optimizeSchedule(options);
    writeScheduleCsv(SCHEDULE_PATH, schedule);
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(after, null, 2));

    let trace = generateDecisionTrace(candidates, options, schedule, after);
    trace.counterfactuals = await runActionCounterfactuals(trace, options, schedule, after, EXTERNAL_DIR);
    trace = updateImportance(trace);
    fs.writeFileSync(DECISION_TRACE_PATH, JSON.stringify(trace, null, 2));

    const index = buildDecisionIndex(trace);
    saveDecisionIndex(index);

    // The retriever/index were built from the pre-change decision index; reload so
    // subsequent EXPLAIN questions in this same chat session see the new plan.
    this.retriever = new DecisionRetriever();

    const delta = before ? after.total_objective_value_aud - before.total_objective_value_aud : null;
    const deltaText = delta === null ? "" : ` (${delta >= 0 ? "+" : ""}${delta.toFixed(2)} AUD)`;

    let planChangeText = "The plan was not changed.";
    if (before) {
      const comparison = compareScenarios(beforeSchedule, before, schedule, after);
      const { actions_added: added, actions_removed: removed, actions_rescheduled: rescheduled } = comparison;
      if (added.length + removed.length + rescheduled.length === 0) {
        planChangeText = "The plan was not changed -- the same schedule is still optimal.";
      } else {
        const parts: string[] = [];
        if (added.length) parts.push(`${added.length} action${added.length === 1 ? "" : "s"} added`);
        if (removed.length) parts.push(`${removed.length} action${removed.length === 1 ? "" : "s"} removed`);
        if (rescheduled.length) parts.push(`${rescheduled.length} action${rescheduled.length === 1 ? "" : "s"} rescheduled`);
        planChangeText = `The plan was changed: ${parts.join(", ")}.`;
      }
    }

    return {
      answer: `Applied: ${describeProposal(proposal)}\n\n${planChangeText}\n\nRe-optimised whole-farm objective: ${before ? `$${before.total_objective_value_aud.toLocaleString()} -> ` : ""}$${after.total_objective_value_aud.toLocaleString()}${deltaText}.`,
      before,
      after,
    };
  }

  async explainDefault(): Promise<string> {
    processPrint("\n[SUMMARY] Generating important-decision summary");
    const records = this.retriever.getDefaultDecisions();
    const context = this.buildContext(records);
    processPrint(`[CONTEXT] Building context from ${records.length} retrieved records`);

    const prompt = `
Explain the most important decisions in the optimised farm schedule.

Only discuss the major decisions represented in the supplied evidence. Prioritise financially important optional decisions, costly required actions, meaningful field trade-offs, and genuinely important resource constraints.

Optimisation evidence:
${JSON.stringify(context, null, 2)}
`.trim();
    return this.generate(prompt);
  }

  async answer(question: string, returnEvidence = false): Promise<AnswerResult> {
    processPrint(`\n[CHAT] Question: ${question}`);

    const mode = await this.classifyRequest(question);

    if (mode === "scenario") return this.runScenario(question);
    if (mode === "config_update") return this.runConfigUpdate(question);

    processPrint("[RETRIEVAL] Existing decision -> retrieving optimisation evidence");
    const records = this.retriever.retrieve(question);
    const context = this.buildContext(records);
    processPrint(`[CONTEXT] Consolidated ${records.length} retrieved records into ${context.decisions.length} decision context(s)`);

    const prompt = `
Answer this question directly:

${question}

Optimisation evidence:
${JSON.stringify(context, null, 2)}

Instructions:
- Answer only the decision asked about.
- Start with the main reason in the first sentence.
- If this is an optional selected action, use the forbid-action counterfactual as the strongest financial evidence.
- If this is an optional skipped action, use the force-action counterfactual as the strongest financial evidence.
- Use state changes to explain the agronomic mechanism when available.
- Mention timing only if it helps answer the question.
- Do not discuss unrelated plans.
- Do not confuse a counterfactual forced action with the original selected schedule.
- Keep the answer concise.
`.trim();

    const answer = await this.generate(prompt);
    const result: AnswerResult = { answer, needs_reoptimization: false };
    if (returnEvidence) result.evidence = records;
    return result;
  }
}
