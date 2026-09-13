import path from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at lib/optimizer/paths.ts (app root: FarmOpti/FarmOpti/).
// The data root (config.yaml, external_variables/, outputs/) stays at
// FarmOpti/FarmOpti/optimizer/ -- the same place the Python pipeline used --
// so nothing else in the repo that points at those paths needs to change.
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

export const OPTIMIZER_ROOT = path.resolve(THIS_DIR, "../../optimizer");
export const CONFIG_PATH = path.join(OPTIMIZER_ROOT, "config.yaml");
export const EXTERNAL_DIR = path.join(OPTIMIZER_ROOT, "external_variables");
export const OUTPUTS_DIR = path.join(OPTIMIZER_ROOT, "outputs");

export const CANDIDATE_ACTIONS_PATH = path.join(OUTPUTS_DIR, "candidate_actions.csv");
export const FIELD_OPTIONS_PATH = path.join(OUTPUTS_DIR, "field_options.json");
export const SCHEDULE_PATH = path.join(OUTPUTS_DIR, "optimal_schedule.csv");
export const SUMMARY_PATH = path.join(OUTPUTS_DIR, "optimization_summary.json");
export const DECISION_TRACE_PATH = path.join(OUTPUTS_DIR, "decision_trace.json");
export const DECISION_INDEX_PATH = path.join(OUTPUTS_DIR, "decision_index.jsonl");
