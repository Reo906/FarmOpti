import { CONFIG } from "../config";
import { DecisionRetriever, type RetrievedRecord } from "./retrieveDecisions";
import { ScenarioParser } from "./scenario/parser";
import { ScenarioRunner } from "./scenario/runner";
import { ScenarioValidationError } from "./scenario/validator";
import type { ChatMessage } from "./scenario/parser";

const LLM_CONFIG = CONFIG.explanation.llm;
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
Classify the user's FarmOpti request as exactly one of two modes.

EXPLAIN:
The user is asking about the existing optimisation result, including its decisions, timing, feasibility, alternatives, values, state changes, resources, or reasoning. Use EXPLAIN when the question can be answered from the existing optimisation and its recorded evidence.

SCENARIO:
The user explicitly specifies a changed condition, value, requirement, constraint, availability, assumption, timing, or action and wants FarmOpti to evaluate the result under that changed state. A SCENARIO request must contain a concrete modification to the optimisation problem.

Important distinctions:
- "Why was F2 sprayed?" -> EXPLAIN
- "Could F1 have been harvested later?" -> EXPLAIN
- "Was September 25 considered for F1?" -> EXPLAIN
- "What other harvest dates were feasible for F1?" -> EXPLAIN
- "What if F1 is harvested on September 25?" -> SCENARIO
- "Move F1 harvest to September 25." -> SCENARIO
- "Would profit be higher if F1 were harvested on September 25?" -> SCENARIO
- "Add 3 ML of water on September 20." -> SCENARIO
- "What if wheat price were 450 AUD/t?" -> SCENARIO
- "Don't spray F2." -> SCENARIO

Do not classify a request as SCENARIO merely because it contains words such as could, would, possible, alternative, later, earlier, or why not. Those remain EXPLAIN unless the user actually supplies a changed condition to evaluate.

Return only the structured classification required by the supplied schema.
`.trim();

const CLASSIFICATION_SCHEMA = {
  type: "object",
  properties: { mode: { type: "string", enum: ["explain", "scenario"] } },
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
}

export class ExplanationService {
  retriever: DecisionRetriever;
  llm: LLMClient;
  private scenarioRunner: ScenarioRunner | null = null;
  private scenarioParser: ScenarioParser | null = null;

  constructor() {
    processPrint("[INIT] Initialising explanation service...");
    this.retriever = new DecisionRetriever();
    this.llm = new LLMClient();

    if (SCENARIO_CONFIG.enabled ?? true) {
      this.scenarioRunner = new ScenarioRunner();
      this.scenarioParser = new ScenarioParser(this.llm, this.scenarioRunner.validator);
    }

    processPrint("[INIT] Explanation service ready");
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

  private async classifyRequest(question: string): Promise<"explain" | "scenario"> {
    if (!this.scenarioParser) return "explain";

    processPrint("[CLASSIFY] Classifying request...");
    const start = Date.now();
    let mode: "explain" | "scenario" = "explain";

    try {
      const response = await this.llm.chat(
        [
          { role: "system", content: CLASSIFICATION_PROMPT },
          { role: "user", content: question },
        ],
        { responseSchema: CLASSIFICATION_SCHEMA, maxOutputTokens: 30 },
      );
      mode = String(JSON.parse(response).mode).toLowerCase() as "explain" | "scenario";
    } catch (exc) {
      processPrint(`[CLASSIFY] Invalid classifier response (${exc}) -> EXPLAIN fallback`);
      mode = "explain";
    }

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
      result = await this.scenarioRunner!.run(interpretation);
    } catch (exc: any) {
      processPrint(`[SCENARIO] Re-optimisation failed: ${exc.message ?? exc}`);
      return {
        answer: `FarmOpti understood the requested modification, but could not produce a feasible scenario result: ${exc.message ?? exc}`,
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
