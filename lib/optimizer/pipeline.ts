import fs from "node:fs";
import path from "node:path";
import { createDefaultToolRegistry } from "./tools/definitions";
import { ALTERNATIVE_PLANS_PATH, DECISION_TRACE_PATH, EXTERNAL_DIR, OUTPUTS_DIR } from "./paths";
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

  console.log("[1/6] candidate generation");
  const candidates = await tools.call<Candidate[]>("generate_candidates", {});

  console.log("[2/6] field option generation");
  const options = await tools.call<FieldOption[]>("generate_field_options", {});

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

  console.log("[4/6] decision evidence");
  let trace = await tools.call<DecisionTrace>("extract_decision_trace", { candidates, options, schedule, summary });

  console.log("[5/6] counterfactual analysis");
  trace = await tools.call<DecisionTrace>("analyse_counterfactuals", { trace, options, schedule, summary, external_variables_dir: EXTERNAL_DIR });
  fs.writeFileSync(DECISION_TRACE_PATH, JSON.stringify(trace, null, 2));

  console.log("[6/6] retrieval index");
  await tools.call("build_decision_index", { trace });

  console.log("complete");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  runPipeline().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
