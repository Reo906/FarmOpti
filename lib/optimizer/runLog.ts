import fs from "node:fs";
import { RUN_LOG_PATH } from "./paths";

// A run-scoped log of the pipeline stages that just executed, so a
// reoptimization can report back "what we did" alongside "what changed" --
// not just the before/after diff. Reset at the start of a run, appended to
// as each stage completes, and read back once the run is done. It only ever
// holds the most recent run: this is context for a single optimisation, not
// a history log.
export interface RunLogEvent {
  timestamp: string;
  stage: string;
  message: string;
  metrics?: Record<string, unknown>;
}

export function resetRunLog(): void {
  fs.writeFileSync(RUN_LOG_PATH, "");
}

export function logStage(stage: string, message: string, metrics?: Record<string, unknown>): void {
  const event: RunLogEvent = { timestamp: new Date().toISOString(), stage, message, ...(metrics ? { metrics } : {}) };
  fs.appendFileSync(RUN_LOG_PATH, `${JSON.stringify(event)}\n`);
}

export function readRunLog(): RunLogEvent[] {
  if (!fs.existsSync(RUN_LOG_PATH)) return [];
  return fs
    .readFileSync(RUN_LOG_PATH, "utf-8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunLogEvent);
}

export function runLogSteps(): string[] {
  return readRunLog().map((event) => event.message);
}
