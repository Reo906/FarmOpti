import fs from "node:fs";
import path from "node:path";
import { createDefaultToolRegistry } from "./tools/definitions";
import { ALTERNATIVE_PLANS_PATH, DECISION_TRACE_PATH, EXTERNAL_DIR, OUTPUTS_DIR, PLAN_CHANGE_SUMMARY_PATH, SCHEDULE_PATH, SUMMARY_PATH } from "./paths";
import { readScheduleCsv } from "./csvWriters";
import { logStage, resetRunLog, runLogSteps } from "./runLog";
import { summarizePlanChange } from "./chatbot/planChangeSummary";
import type { DecisionTrace } from "./decisionAnalysis/extractDecisions";
import type { AlternativePlansResult, Candidate, FieldOption, OptimizationSummary, ScheduleRow } from "./types";

/**
 * The optimizer pipeline, expressed as a fixed sequence of tool calls rather
 * than direct function calls. The ORDER here is still decided in code -- an
 * LLM/agent isn't picking what runs next -- but each stage is invoked through
 * the same `registry.call(name, input)` interface an agent would use, so this
 * sequence can be handed to one later without changing how the stages work.
 * See tools/definitions.ts for what each tool does and its input/output shape.
 */
export async function runPipeline(): Promise<void> {
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  const tools = createDefaultToolRegistry();

  // Snapshot the plan as it stood before this run, so the end-of-run summary
  // can report what actually changed (and why it's an improvement) rather
  // than just the raw new numbers. Absent on the very first-ever run.
  const beforeSummary = fs.existsSync(SUMMARY_PATH) ? (JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf-8")) as OptimizationSummary) : null;
  const beforeSchedule: ScheduleRow[] = fs.existsSync(SCHEDULE_PATH) ? readScheduleCsv(SCHEDULE_PATH) : [];

  resetRunLog();

  console.log("[1/6] candidate generation");
  const candidates = await tools.call<Candidate[]>("generate_candidates", {});
  logStage("candidates", `Generated ${candidates.length} candidate actions`, { count: candidates.length });

  console.log("[2/6] field option generation");
  const options = await tools.call<FieldOption[]>("generate_field_options", {});
  logStage("field_options", `Built ${options.length} field option${options.length === 1 ? "" : "s"} to choose between`, { count: options.length });

  console.log("[3/6] global optimisation");
  const { schedule, summary, alternatives } = await tools.call<{
    schedule: ScheduleRow[];
    summary: OptimizationSummary;
    alternatives: AlternativePlansResult;
  }>("generate_alternative_plans", { options });
  console.log(`  wrote ${alternatives.plans.length} plans to ${ALTERNATIVE_PLANS_PATH}`);
  for (const [index, plan] of alternatives.plans.entries()) {
    console.log(
      `  - optimal_schedule_${index + 1}.csv (${plan.plan_id}): ${plan.objective_value_aud} (${plan.optimality_ratio}) ${plan.reason}`,
    );
  }
  logStage("optimise", `Solved to ${summary.status} (${summary.num_scheduled_actions} actions, objective $${summary.total_objective_value_aud.toLocaleString()})`, {
    status: summary.status,
    num_scheduled_actions: summary.num_scheduled_actions,
    objective_value_aud: summary.total_objective_value_aud,
    alternative_plans: alternatives.plans.length,
  });

  console.log("[4/6] decision evidence");
  let trace = await tools.call<DecisionTrace>("extract_decision_trace", { candidates, options, schedule, summary });
  logStage("decision_evidence", `Extracted evidence for ${trace.actions.length} scheduling decisions`, { count: trace.actions.length });

  console.log("[5/6] counterfactual analysis");
  trace = await tools.call<DecisionTrace>("analyse_counterfactuals", { trace, options, schedule, summary, external_variables_dir: EXTERNAL_DIR });
  fs.writeFileSync(DECISION_TRACE_PATH, JSON.stringify(trace, null, 2));
  logStage("counterfactuals", `Analysed ${trace.counterfactuals.length} counterfactual${trace.counterfactuals.length === 1 ? "" : "s"}`, { count: trace.counterfactuals.length });

  console.log("[6/6] retrieval index");
  const index = await tools.call<unknown[]>("build_decision_index", { trace });
  logStage("retrieval_index", `Indexed ${index.length} retrievable facts for the chatbot`, { count: index.length });

  const changeSummary = summarizePlanChange({ beforeSchedule, beforeSummary, afterSchedule: schedule, afterSummary: summary, steps: runLogSteps() });
  fs.writeFileSync(PLAN_CHANGE_SUMMARY_PATH, JSON.stringify(changeSummary, null, 2));

  console.log("complete");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  runPipeline().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
