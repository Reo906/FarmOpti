import { formatIso } from "../../datetime";
import type { OptimizationSummary, ScheduleRow } from "../../types";

interface ComparisonChange {
  plan_id: string;
  field_id: string;
  operation: string;
  start_time?: string;
  old_start_time?: string;
  new_start_time?: string;
  old_machine_id?: string;
  new_machine_id?: string;
}

export interface ScenarioComparison {
  baseline_objective_aud: number;
  scenario_objective_aud: number;
  objective_change_aud: number;
  baseline_direct_cash_effect_aud: number;
  scenario_direct_cash_effect_aud: number;
  baseline_terminal_value_aud: number;
  scenario_terminal_value_aud: number;
  actions_added: ComparisonChange[];
  actions_removed: ComparisonChange[];
  actions_rescheduled: ComparisonChange[];
  unchanged_plan_count: number;
}

function scheduleByPlan(schedule: ScheduleRow[] | null | undefined): Map<string, ScheduleRow> {
  const map = new Map<string, ScheduleRow>();
  if (!schedule) return map;
  for (const row of schedule) map.set(String(row.plan_id), row);
  return map;
}

export function compareScenarios(
  baselineSchedule: ScheduleRow[],
  baselineSummary: OptimizationSummary,
  scenarioSchedule: ScheduleRow[],
  scenarioSummary: OptimizationSummary,
): ScenarioComparison {
  const baseline = scheduleByPlan(baselineSchedule);
  const scenario = scheduleByPlan(scenarioSchedule);

  const added: ComparisonChange[] = [];
  const removed: ComparisonChange[] = [];
  const rescheduled: ComparisonChange[] = [];
  const unchanged: string[] = [];

  const allPlanIds = new Set([...baseline.keys(), ...scenario.keys()]);

  for (const planId of [...allPlanIds].sort()) {
    const oldRow = baseline.get(planId);
    const newRow = scenario.get(planId);

    if (!oldRow) {
      added.push({
        plan_id: planId,
        field_id: String(newRow!.field_id),
        operation: String(newRow!.operation),
        start_time: formatIso(newRow!.start_time),
      });
      continue;
    }

    if (!newRow) {
      removed.push({
        plan_id: planId,
        field_id: String(oldRow.field_id),
        operation: String(oldRow.operation),
        start_time: formatIso(oldRow.start_time),
      });
      continue;
    }

    const oldCandidate = String(oldRow.candidate_id ?? "");
    const newCandidate = String(newRow.candidate_id ?? "");
    const oldMachine = String(oldRow.machine_id ?? "");
    const newMachine = String(newRow.machine_id ?? "");

    if (oldCandidate !== newCandidate || oldMachine !== newMachine) {
      rescheduled.push({
        plan_id: planId,
        field_id: String(newRow.field_id),
        operation: String(newRow.operation),
        old_start_time: formatIso(oldRow.start_time),
        new_start_time: formatIso(newRow.start_time),
        old_machine_id: oldMachine,
        new_machine_id: newMachine,
      });
    } else {
      unchanged.push(planId);
    }
  }

  const baselineValue = baselineSummary.total_objective_value_aud;
  const scenarioValue = scenarioSummary.total_objective_value_aud;

  return {
    baseline_objective_aud: Math.round(baselineValue * 100) / 100,
    scenario_objective_aud: Math.round(scenarioValue * 100) / 100,
    objective_change_aud: Math.round((scenarioValue - baselineValue) * 100) / 100,
    baseline_direct_cash_effect_aud: baselineSummary.total_direct_cash_effect_aud,
    scenario_direct_cash_effect_aud: scenarioSummary.total_direct_cash_effect_aud,
    baseline_terminal_value_aud: baselineSummary.total_terminal_value_aud,
    scenario_terminal_value_aud: scenarioSummary.total_terminal_value_aud,
    actions_added: added,
    actions_removed: removed,
    actions_rescheduled: rescheduled,
    unchanged_plan_count: unchanged.length,
  };
}
