import fs from "node:fs";
import { generateCandidates } from "../candidateGeneration";
import { writeCandidateActionsCsv, writeScheduleCsv } from "../csvWriters";
import { runActionCounterfactuals } from "../decisionAnalysis/analyseCounterfactuals";
import { buildDecisionIndex, saveDecisionIndex } from "../decisionAnalysis/buildDecisionIndex";
import { generateDecisionTrace, updateImportance, type DecisionTrace } from "../decisionAnalysis/extractDecisions";
import { generateFieldOptions } from "../fieldOptions";
import { saveFieldOptions } from "../fieldOptionsIO";
import { CANDIDATE_ACTIONS_PATH, DECISION_TRACE_PATH, EXTERNAL_DIR, SCHEDULE_PATH, SUMMARY_PATH } from "../paths";
import { optimizeSchedule } from "../scheduleOptimizer";
import { ExplanationService, LLMClient } from "../chatbot/explanationService";
import { applyConfigChangeProposal } from "../chatbot/configUpdate/applier";
import { ConfigUpdateParser, type ConfigChangeProposal } from "../chatbot/configUpdate/parser";
import type { Candidate, FieldOption, OptimizationScenario, OptimizationSummary, ScheduleRow } from "../types";
import { ToolRegistry } from "./registry";
import type { ToolDefinition } from "./types";

const externalVariablesDirProperty = {
  external_variables_dir: {
    type: "string",
    description: "Override path to the external_variables/ folder (fields.csv, weather_hourly.csv, etc.). Defaults to the real farm data. Only pass a different path for a scenario running against a temporary copy of the inputs.",
  },
};

const generateCandidatesTool: ToolDefinition<{ external_variables_dir?: string }, Candidate[]> = {
  name: "generate_candidates",
  description:
    "Stage 1 of the optimizer pipeline. Enumerates every individually feasible timing for each management-plan operation (harvest, irrigate, spray, fertilise, plant), filtered by weather limits, labour headcount, and machine availability, and scores each one economically. Writes candidate_actions.csv as a side effect. Call this first; generate_field_options depends on its output.",
  input_schema: {
    type: "object",
    properties: externalVariablesDirProperty,
  },
  execute: ({ external_variables_dir } = {}) => {
    const candidates = generateCandidates(external_variables_dir ?? EXTERNAL_DIR);
    writeCandidateActionsCsv(CANDIDATE_ACTIONS_PATH, candidates);
    return candidates;
  },
};

const generateFieldOptionsTool: ToolDefinition<{ external_variables_dir?: string }, FieldOption[]> = {
  name: "generate_field_options",
  description:
    "Stage 2 of the optimizer pipeline. Runs a beam search (width 80, per config.yaml) over each field's candidate timings to find near-optimal action sequences, correctly accounting for how one action changes the field state seen by a later action (e.g. irrigation affecting a subsequent spray's efficacy). Writes field_options.json. Regenerates its own candidates internally, so it can be called without first calling generate_candidates. Its output feeds optimize_schedule.",
  input_schema: {
    type: "object",
    properties: externalVariablesDirProperty,
  },
  execute: ({ external_variables_dir } = {}) => {
    const options = generateFieldOptions(external_variables_dir ?? EXTERNAL_DIR);
    saveFieldOptions(options);
    return options;
  },
};

const optimizeScheduleTool: ToolDefinition<
  { options: FieldOption[]; external_variables_dir?: string; scenario?: OptimizationScenario; max_solver_seconds?: number },
  { schedule: ScheduleRow[]; summary: OptimizationSummary }
> = {
  name: "optimize_schedule",
  description:
    "Stage 3 of the optimizer pipeline. Solves the whole-farm mixed-integer linear program with the HiGHS solver: choose exactly one field option per field, respecting machine double-booking, travel time between fields, daily labour capacity, and daily water capacity, maximizing total financial value (direct cash effect + terminal crop value). Pass `scenario` with forbid_plan_ids/force_plan_ids/force_candidate_ids to test 'what if this specific action were or weren't selected' without touching the underlying farm data -- this is how counterfactual analysis works. Writes optimal_schedule.csv and optimization_summary.json only when called with no scenario override (the real, unconstrained solve).",
  input_schema: {
    type: "object",
    properties: {
      options: { type: "array", description: "Field options from generate_field_options." },
      ...externalVariablesDirProperty,
      scenario: {
        type: "object",
        description: "Optional solver-level override for counterfactual testing.",
        properties: {
          forbid_plan_ids: { type: "array", items: { type: "string" } },
          force_plan_ids: { type: "array", items: { type: "string" } },
          force_candidate_ids: { type: "object" },
        },
      },
      max_solver_seconds: { type: "number", description: "Solver time budget; defaults to config.yaml's global_optimization.max_solver_seconds." },
    },
    required: ["options"],
  },
  execute: async ({ options, external_variables_dir, scenario, max_solver_seconds }) => {
    const result = await optimizeSchedule(options, external_variables_dir ?? EXTERNAL_DIR, scenario, max_solver_seconds);
    if (!scenario) {
      writeScheduleCsv(SCHEDULE_PATH, result.schedule);
      fs.writeFileSync(SUMMARY_PATH, JSON.stringify(result.summary, null, 2));
    }
    return result;
  },
};

const extractDecisionTraceTool: ToolDefinition<
  { candidates: Candidate[]; options: FieldOption[]; schedule: ScheduleRow[]; summary: OptimizationSummary; external_variables_dir?: string },
  DecisionTrace
> = {
  name: "extract_decision_trace",
  description:
    "Stage 4 of the optimizer pipeline. Builds the evidence record explaining every management-plan action: whether it was selected or skipped, its financial effect, the field-state change it caused, and nearby feasible timing alternatives. This is the raw evidence the chatbot later explains in plain English -- it does not itself call an LLM.",
  input_schema: {
    type: "object",
    properties: {
      candidates: { type: "array" },
      options: { type: "array" },
      schedule: { type: "array" },
      summary: { type: "object" },
      ...externalVariablesDirProperty,
    },
    required: ["candidates", "options", "schedule", "summary"],
  },
  execute: ({ candidates, options, schedule, summary, external_variables_dir }) =>
    generateDecisionTrace(candidates, options, schedule, summary, external_variables_dir ?? EXTERNAL_DIR),
};

const analyseCounterfactualsTool: ToolDefinition<
  { trace: DecisionTrace; options: FieldOption[]; schedule: ScheduleRow[]; summary: OptimizationSummary; external_variables_dir?: string; max_solver_seconds?: number },
  DecisionTrace
> = {
  name: "analyse_counterfactuals",
  description:
    "Stage 5 of the optimizer pipeline. For every OPTIONAL action, calls optimize_schedule again with that one action forced or forbidden, to measure its true financial contribution to the whole-farm objective. Mutates and returns the decision trace with `counterfactuals` populated and `importance` scores recomputed. This is what lets the chatbot say 'forbidding this action would cost $X' with a real re-solved number instead of a guess.",
  input_schema: {
    type: "object",
    properties: {
      trace: { type: "object" },
      options: { type: "array" },
      schedule: { type: "array" },
      summary: { type: "object" },
      ...externalVariablesDirProperty,
      max_solver_seconds: { type: "number", description: "Per-counterfactual solver time budget (defaults to 5s -- these run many times, so kept short)." },
    },
    required: ["trace", "options", "schedule", "summary"],
  },
  execute: async ({ trace, options, schedule, summary, external_variables_dir, max_solver_seconds }) => {
    trace.counterfactuals = await runActionCounterfactuals(
      trace,
      options,
      schedule,
      summary,
      external_variables_dir ?? EXTERNAL_DIR,
      max_solver_seconds,
    );
    return updateImportance(trace);
  },
};

const buildDecisionIndexTool: ToolDefinition<{ trace: DecisionTrace }, ReturnType<typeof buildDecisionIndex>> = {
  name: "build_decision_index",
  description:
    "Stage 6 (final) of the optimizer pipeline. Converts the decision trace into short, plain-English, independently-retrievable sentences (decision_index.jsonl) ranked by importance. This is the search index the chatbot's retriever queries to find evidence for a user's question.",
  input_schema: {
    type: "object",
    properties: { trace: { type: "object" } },
    required: ["trace"],
  },
  execute: ({ trace }) => {
    const index = buildDecisionIndex(trace);
    saveDecisionIndex(index);
    return index;
  },
};

const applyScenarioTool: ToolDefinition<{ description: string }, unknown> = {
  name: "apply_scenario",
  description:
    "Applies a user-described change to the farm plan on the fly -- e.g. 'don't spray F2', 'add 3 ML of water on 2026-09-20', 'harvest F1 on 2026-09-25', 'reduce M3's cost per hour to 40'. An LLM compiles the request into a validated, generic modification (target table/action, filter, and either an update to a stored value or a scheduling constraint), then generate_field_options and optimize_schedule are re-run against a TEMPORARY copy of the inputs -- the real farm data under external_variables/ is never modified. Returns a comparison against the current baseline schedule (optimal_schedule.csv). Use this for any data-level 'what if' or one-off constraint change. If the requested change can't be expressed this way (a genuinely new rule/relationship the DSL has no field for), this tool will report that explicitly instead of guessing -- that's a signal a code change is needed, not a scenario.",
  input_schema: {
    type: "object",
    properties: {
      description: { type: "string", description: "The user's request in natural language." },
    },
    required: ["description"],
  },
  execute: async ({ description }) => {
    const service = new ExplanationService();
    return service.answer(description);
  },
};

/**
 * Re-runs the same 6-stage sequence as pipeline.ts, reusing these tools'
 * own execute functions directly (not via the registry, to avoid a circular
 * import between this module and pipeline.ts). Used after a confirmed,
 * persistent config/machine change so decision_trace.json and
 * decision_index.jsonl stay consistent with the new inputs, not just the
 * schedule.
 */
async function rerunFullPipeline(): Promise<OptimizationSummary> {
  const candidates = await generateCandidatesTool.execute({});
  const options = await generateFieldOptionsTool.execute({});
  const { schedule, summary } = await optimizeScheduleTool.execute({ options });
  let trace = await extractDecisionTraceTool.execute({ candidates, options, schedule, summary });
  trace = await analyseCounterfactualsTool.execute({ trace, options, schedule, summary });
  fs.writeFileSync(DECISION_TRACE_PATH, JSON.stringify(trace, null, 2));
  await buildDecisionIndexTool.execute({ trace });
  return summary;
}

function readCurrentSummary(): OptimizationSummary | null {
  if (!fs.existsSync(SUMMARY_PATH)) return null;
  return JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf-8"));
}

const proposeConfigUpdateTool: ToolDefinition<{ description: string }, ConfigChangeProposal> = {
  name: "propose_config_update",
  description:
    "Compiles a user's natural-language request to PERSISTENTLY change an optimizer threshold/parameter (config.yaml) or the equipment roster (machines.csv) into a validated, structured proposal -- e.g. 'only spray when wind is below 15 km/h', 'we bought a new harvester, M8, costing $180/hour', 'M3's cost per hour is now 45'. This does NOT write anything yet -- it only parses and validates against the real schema, returning a proposal for the user to review. Always show the proposal to the user and get explicit confirmation before calling confirm_config_update with it. If the request describes a genuinely new kind of rule (not an existing threshold or machine field), the proposal comes back with kind='unsupported' and a reason -- report that to the user rather than forcing it through.",
  input_schema: {
    type: "object",
    properties: {
      description: { type: "string", description: "The user's request in natural language." },
    },
    required: ["description"],
  },
  execute: async ({ description }) => {
    const parser = new ConfigUpdateParser(new LLMClient());
    return parser.parse(description);
  },
};

const confirmConfigUpdateTool: ToolDefinition<{ proposal: ConfigChangeProposal }, { applied: ConfigChangeProposal; before: OptimizationSummary | null; after: OptimizationSummary }> = {
  name: "confirm_config_update",
  description:
    "Persistently applies a proposal previously returned by propose_config_update -- writing the new value into config.yaml (preserving comments/formatting) or adding/updating a row in machines.csv (and generating its machine_availability_daily.csv rows, for new equipment). Only call this AFTER the user has explicitly confirmed the exact proposal shown to them; never call it directly from a description. After writing, re-runs the full optimizer pipeline so optimal_schedule.csv, decision_trace.json, and decision_index.jsonl all reflect the change, and returns the whole-farm objective value before and after.",
  input_schema: {
    type: "object",
    properties: {
      proposal: { type: "object", description: "The exact, unmodified proposal object returned by propose_config_update." },
    },
    required: ["proposal"],
  },
  execute: async ({ proposal }) => {
    const before = readCurrentSummary();
    applyConfigChangeProposal(proposal);
    const after = await rerunFullPipeline();
    return { applied: proposal, before, after };
  },
};

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(generateCandidatesTool);
  registry.register(generateFieldOptionsTool);
  registry.register(optimizeScheduleTool);
  registry.register(extractDecisionTraceTool);
  registry.register(analyseCounterfactualsTool);
  registry.register(buildDecisionIndexTool);
  registry.register(applyScenarioTool);
  registry.register(proposeConfigUpdateTool);
  registry.register(confirmConfigUpdateTool);
  return registry;
}
