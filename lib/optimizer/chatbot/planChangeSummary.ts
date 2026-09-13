import { compareScenarios, type ScenarioComparison } from "./scenario/comparator";
import type { OptimizationSummary, ScheduleRow } from "../types";

export interface PlanChangeSummary {
  generated_at: string;
  narrative: string;
  change_bullets: string[];
  positive_bullets: string[];
  steps: string[];
}

function money(value: number): string {
  return `$${Math.abs(Math.round(value)).toLocaleString("en-AU")}`;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
}

function changeBulletsFrom(comparison: ScenarioComparison): string[] {
  const bullets: string[] = [];
  for (const c of comparison.actions_added) {
    bullets.push(`Added: ${c.operation} on ${c.field_id}, ${formatWhen(c.start_time!)}`);
  }
  for (const c of comparison.actions_removed) {
    bullets.push(`Removed: ${c.operation} on ${c.field_id} (was ${formatWhen(c.start_time!)})`);
  }
  for (const c of comparison.actions_rescheduled) {
    const parts: string[] = [];
    if (c.old_start_time !== c.new_start_time) parts.push(`${formatWhen(c.old_start_time!)} -> ${formatWhen(c.new_start_time!)}`);
    if (c.old_machine_id !== c.new_machine_id) parts.push(`${c.old_machine_id} -> ${c.new_machine_id}`);
    bullets.push(`Rescheduled: ${c.operation} on ${c.field_id}${parts.length ? ` (${parts.join(", ")})` : ""}`);
  }
  return bullets;
}

function positiveBulletsFrom(comparison: ScenarioComparison, before: OptimizationSummary, after: OptimizationSummary): string[] {
  const bullets: string[] = [];
  const objectiveDelta = comparison.objective_change_aud;
  if (objectiveDelta > 0) {
    bullets.push(`Whole-farm objective value rose by ${money(objectiveDelta)}, to ${money(after.total_objective_value_aud)}.`);
  } else if (objectiveDelta < 0) {
    bullets.push(`Whole-farm objective value fell by ${money(objectiveDelta)} to satisfy the updated constraints -- a necessary trade-off, now ${money(after.total_objective_value_aud)}.`);
  }

  const cashDelta = after.total_direct_cash_effect_aud - before.total_direct_cash_effect_aud;
  if (cashDelta > 0) bullets.push(`Direct cash effect improved by ${money(cashDelta)}.`);

  const terminalDelta = after.total_terminal_value_aud - before.total_terminal_value_aud;
  if (terminalDelta > 0) bullets.push(`Future crop value carried forward improved by ${money(terminalDelta)}.`);

  const actionsDelta = after.num_scheduled_actions - before.num_scheduled_actions;
  if (actionsDelta > 0) bullets.push(`${actionsDelta} more action${actionsDelta === 1 ? "" : "s"} could be scheduled than before.`);

  const totalChanges = comparison.actions_added.length + comparison.actions_removed.length + comparison.actions_rescheduled.length;
  if (totalChanges === 0) {
    bullets.push("The existing plan already satisfied the new conditions -- nothing had to change.");
  } else if (bullets.length === 0) {
    bullets.push(`The plan adapted to the new conditions with ${totalChanges} change${totalChanges === 1 ? "" : "s"} while holding whole-farm value steady.`);
  }

  return bullets;
}

/** Builds a natural-language, deterministic (no LLM call) summary of what a reoptimization changed and why, from before/after schedule+summary snapshots plus the run log of stages that just executed. */
export function summarizePlanChange(params: {
  beforeSchedule: ScheduleRow[];
  beforeSummary: OptimizationSummary | null;
  afterSchedule: ScheduleRow[];
  afterSummary: OptimizationSummary;
  steps: string[];
}): PlanChangeSummary {
  const { beforeSchedule, beforeSummary, afterSchedule, afterSummary, steps } = params;
  const generated_at = new Date().toISOString();

  if (!beforeSummary) {
    return {
      generated_at,
      narrative: "This is the first optimisation run -- there is no earlier plan to compare against.",
      change_bullets: [],
      positive_bullets: [`Selected ${afterSummary.num_scheduled_actions} actions with a whole-farm objective value of ${money(afterSummary.total_objective_value_aud)}.`],
      steps,
    };
  }

  const comparison = compareScenarios(beforeSchedule, beforeSummary, afterSchedule, afterSummary);
  const change_bullets = changeBulletsFrom(comparison);
  const positive_bullets = positiveBulletsFrom(comparison, beforeSummary, afterSummary);

  const delta = comparison.objective_change_aud;
  const deltaText = delta === 0 ? "unchanged" : `${delta > 0 ? "+" : "-"}${money(delta)}`;
  const narrative = change_bullets.length === 0
    ? "The plan was not changed -- the same schedule is still optimal."
    : `The plan was updated: ${change_bullets.length} action${change_bullets.length === 1 ? "" : "s"} changed. Whole-farm objective value ${deltaText}.`;

  return { generated_at, narrative, change_bullets, positive_bullets, steps };
}
