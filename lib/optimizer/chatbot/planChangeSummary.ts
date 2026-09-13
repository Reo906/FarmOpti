import { compareScenarios, type ScenarioComparison } from "./scenario/comparator";
import { processPrint, type LLMClient } from "./llmClient";
import type { OptimizationSummary, ScheduleRow } from "../types";

export interface PlanChangeSummary {
  generated_at: string;
  narrative: string;
  change_bullets: string[];
  positive_bullets: string[];
  steps: string[];
  source: "llm" | "template";
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
      source: "template",
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

  return { generated_at, narrative, change_bullets, positive_bullets, steps, source: "template" };
}

const NARRATION_SCHEMA = {
  type: "object",
  properties: {
    change_bullets: { type: "array", items: { type: "string" } },
    positive_bullets: { type: "array", items: { type: "string" } },
    narrative: { type: "string" },
  },
  required: ["change_bullets", "positive_bullets", "narrative"],
  additionalProperties: false,
};

const NARRATION_SYSTEM_PROMPT = `
You summarise the result of re-running a farm scheduling optimiser after a change.

You are given "steps_taken" (the pipeline stages that just executed, for context on what kind of run this was) and an "evidence" object holding the EXACT set of actions added, removed and rescheduled, plus before/after summary metrics. The evidence is ground truth -- every fact you write must come from it. Never invent a field, operation, time, machine, or number that is not present in the evidence.

Write:
- change_bullets: one bullet per added/removed/rescheduled action in the evidence, in plain English, naming the field and operation from that entry (e.g. "spray on F3", never a plan_id like "P1"), and what changed (added/removed/moved time/changed machine). One short sentence each. Do not omit any action that is in the evidence, and do not add any that are not.
- positive_bullets: 1-4 short bullets explaining the metric deltas honestly.
- narrative: one sentence overall summary.

CRITICAL rule on objective_change_aud, the single most important number: it is the change in whole-farm value, and a NEGATIVE value is bad news, not good news, even though the number itself is written as an unsigned magnitude in the evidence (you must read the sign of objective_change_aud, not the wording around it). Never phrase a fall in objective value as an achievement (e.g. never write "reduced the objective value" as if that were a goal). If objective_change_aud is negative, the bullet must say the value FELL/DROPPED by that amount and explain it as a necessary trade-off for satisfying the new constraint -- do not put a bare negative-value bullet in positive_bullets without that trade-off framing in the same sentence. If objective_change_aud is positive, say the value ROSE/IMPROVED.

Example -- evidence has objective_change_aud: -81490.17, direct_cash_effect delta: +7692:
{
  "change_bullets": ["Removed the spray on F3 that was scheduled for 18 Sep, 22:00."],
  "positive_bullets": [
    "Whole-farm objective value fell by $81,490 to satisfy the new constraint -- a necessary trade-off, not a loss to be concerned about.",
    "Direct cash effect improved by $7,692 despite that trade-off."
  ],
  "narrative": "One action was removed to satisfy the new rule, lowering whole-farm value by $81,490 as an accepted trade-off."
}

Output only the JSON object matching the schema -- no markdown, no extra commentary, no fields beyond the schema.
`.trim();

/**
 * Same output shape as summarizePlanChange(), but has the LLM write the
 * bullet text instead of fixed templates -- the diff (compareScenarios) and
 * the run log still supply the actual facts, so the model's only job is
 * phrasing, not computing the change. Falls back to the deterministic
 * version if the LLM is unavailable or returns something unusable, so a
 * reoptimization never fails just because Ollama isn't running.
 */
export async function narratePlanChange(
  llm: LLMClient,
  params: {
    beforeSchedule: ScheduleRow[];
    beforeSummary: OptimizationSummary | null;
    afterSchedule: ScheduleRow[];
    afterSummary: OptimizationSummary;
    steps: string[];
  },
): Promise<PlanChangeSummary> {
  const fallback = summarizePlanChange(params);
  const { beforeSchedule, beforeSummary, afterSchedule, afterSummary, steps } = params;

  // Nothing to narrate: the very first run has no prior plan, and an
  // unchanged plan is already covered by a clear canned message -- an LLM
  // call would only add latency for a case with no interesting content.
  if (!beforeSummary) return fallback;
  const comparison = compareScenarios(beforeSchedule, beforeSummary, afterSchedule, afterSummary);
  const totalChanges = comparison.actions_added.length + comparison.actions_removed.length + comparison.actions_rescheduled.length;
  if (totalChanges === 0) return fallback;

  try {
    const evidence = {
      added: comparison.actions_added,
      removed: comparison.actions_removed,
      rescheduled: comparison.actions_rescheduled,
      before: {
        objective_value_aud: beforeSummary.total_objective_value_aud,
        direct_cash_effect_aud: beforeSummary.total_direct_cash_effect_aud,
        terminal_value_aud: beforeSummary.total_terminal_value_aud,
        num_scheduled_actions: beforeSummary.num_scheduled_actions,
      },
      after: {
        objective_value_aud: afterSummary.total_objective_value_aud,
        direct_cash_effect_aud: afterSummary.total_direct_cash_effect_aud,
        terminal_value_aud: afterSummary.total_terminal_value_aud,
        num_scheduled_actions: afterSummary.num_scheduled_actions,
      },
      objective_change_aud: comparison.objective_change_aud,
    };

    const raw = await llm.chat(
      [
        { role: "system", content: NARRATION_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ steps_taken: steps, evidence }, null, 2) },
      ],
      { responseSchema: NARRATION_SCHEMA, maxOutputTokens: 700 },
    );

    const parsed = JSON.parse(raw) as { change_bullets?: unknown; positive_bullets?: unknown; narrative?: unknown };
    if (!Array.isArray(parsed.change_bullets) || !Array.isArray(parsed.positive_bullets) || typeof parsed.narrative !== "string") {
      throw new Error("LLM response did not match the expected shape");
    }

    return {
      generated_at: new Date().toISOString(),
      narrative: parsed.narrative,
      change_bullets: parsed.change_bullets.map(String),
      positive_bullets: parsed.positive_bullets.map(String),
      steps,
      source: "llm",
    };
  } catch (error) {
    processPrint(`[CHANGE_SUMMARY] LLM narration failed, using templated summary instead: ${error instanceof Error ? error.message : error}`);
    return fallback;
  }
}
