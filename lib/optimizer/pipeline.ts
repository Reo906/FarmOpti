import fs from "node:fs";
import path from "node:path";
import { generateCandidates } from "./candidateGeneration";
import { writeCandidateActionsCsv, writeScheduleCsv } from "./csvWriters";
import { runActionCounterfactuals } from "./decisionAnalysis/analyseCounterfactuals";
import { buildDecisionIndex, saveDecisionIndex } from "./decisionAnalysis/buildDecisionIndex";
import { generateDecisionTrace, updateImportance } from "./decisionAnalysis/extractDecisions";
import { generateFieldOptions } from "./fieldOptions";
import { saveFieldOptions } from "./fieldOptionsIO";
import {
  CANDIDATE_ACTIONS_PATH,
  DECISION_TRACE_PATH,
  EXTERNAL_DIR,
  OUTPUTS_DIR,
  SCHEDULE_PATH,
  SUMMARY_PATH,
} from "./paths";
import { optimizeSchedule } from "./scheduleOptimizer";

export async function runPipeline(): Promise<void> {
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

  console.log("[1/6] candidate generation");
  const candidates = generateCandidates();
  writeCandidateActionsCsv(CANDIDATE_ACTIONS_PATH, candidates);

  console.log("[2/6] field option generation");
  const options = generateFieldOptions();
  saveFieldOptions(options);

  console.log("[3/6] global optimisation");
  const { schedule, summary } = await optimizeSchedule(options);
  writeScheduleCsv(SCHEDULE_PATH, schedule);
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));

  console.log("[4/6] decision evidence");
  let trace = generateDecisionTrace(candidates, options, schedule, summary);

  console.log("[5/6] counterfactual analysis");
  trace.counterfactuals = await runActionCounterfactuals(trace, options, schedule, summary, EXTERNAL_DIR);
  trace = updateImportance(trace);
  fs.writeFileSync(DECISION_TRACE_PATH, JSON.stringify(trace, null, 2));

  console.log("[6/6] retrieval index");
  const index = buildDecisionIndex(trace);
  saveDecisionIndex(index);

  console.log("complete");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  runPipeline().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
