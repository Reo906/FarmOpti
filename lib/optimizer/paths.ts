import path from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at lib/optimizer/paths.ts.
// The data root (config.yaml, external_variables/, outputs/) lives at
// FarmOpti/data/ so the TypeScript pipeline and chatbot share the generated evidence.
// nothing else in the repo that points at those paths needs to change.
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

// The web chatbot runs inside the Cloudflare Workers (workerd) runtime, whose
// node:url/node:path behave like their POSIX variants even on a Windows host:
// a "file:///C:/..." module URL turns into "/C:/..." instead of "C:\\...".
// That extra leading slash survives path.resolve/path.join unchanged (they're
// self-consistent POSIX string math) and only breaks once it hits an actual
// filesystem call, so it is stripped once here, on the root. Real Node (the
// CLI pipeline) never produces this shape, so this is a no-op there.
function toRealPath(candidate: string): string {
  return /^\/[a-zA-Z]:\//.test(candidate) ? candidate.slice(1) : candidate;
}

export const OPTIMIZER_ROOT = toRealPath(path.resolve(THIS_DIR, "../../data"));
export const CONFIG_PATH = path.join(OPTIMIZER_ROOT, "config.yaml");
export const EXTERNAL_DIR = path.join(OPTIMIZER_ROOT, "external_variables");
export const OUTPUTS_DIR = path.join(OPTIMIZER_ROOT, "outputs");

export const CANDIDATE_ACTIONS_PATH = path.join(OUTPUTS_DIR, "candidate_actions.csv");
export const FIELD_OPTIONS_PATH = path.join(OUTPUTS_DIR, "field_options.json");
export const SCHEDULE_PATH = path.join(OUTPUTS_DIR, "optimal_schedule.csv");
export const SUMMARY_PATH = path.join(OUTPUTS_DIR, "optimization_summary.json");

export function schedulePath(index: number): string {
  return path.join(OUTPUTS_DIR, `optimal_schedule_${index}.csv`);
}
export const ALTERNATIVE_PLANS_PATH = path.join(OUTPUTS_DIR, "alternative_plans.json");
export const DECISION_TRACE_PATH = path.join(OUTPUTS_DIR, "decision_trace.json");
export const DECISION_INDEX_PATH = path.join(OUTPUTS_DIR, "decision_index.jsonl");
