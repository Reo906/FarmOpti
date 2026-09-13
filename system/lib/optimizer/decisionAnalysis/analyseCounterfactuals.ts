import { optimizeSchedule } from "../scheduleOptimizer";
import { formatIso } from "../datetime";
import type { ActionRecord, DecisionTrace } from "./extractDecisions";
import type { FieldOption, OptimizationSummary, ScheduleRow } from "../types";

interface ScheduleChange {
  plan_id: string;
  change: "added" | "removed" | "rescheduled";
  new_candidate_id?: string;
  new_start_time?: string;
  old_candidate_id?: string;
  old_start_time?: string;
}

function scheduleMap(schedule: ScheduleRow[]): Map<string, ScheduleRow> {
  const map = new Map<string, ScheduleRow>();
  for (const row of schedule) map.set(String(row.plan_id), row);
  return map;
}

export function compareSchedules(baselineSchedule: ScheduleRow[], scenarioSchedule: ScheduleRow[]): ScheduleChange[] {
  const baseline = scheduleMap(baselineSchedule);
  const scenario = scheduleMap(scenarioSchedule);
  const changes: ScheduleChange[] = [];

  const allPlanIds = new Set([...baseline.keys(), ...scenario.keys()]);

  for (const planId of [...allPlanIds].sort()) {
    const a = baseline.get(planId);
    const b = scenario.get(planId);

    if (!a) {
      changes.push({
        plan_id: planId,
        change: "added",
        new_candidate_id: String(b!.candidate_id),
        new_start_time: formatIso(b!.start_time),
      });
      continue;
    }

    if (!b) {
      changes.push({
        plan_id: planId,
        change: "removed",
        old_candidate_id: String(a.candidate_id),
        old_start_time: formatIso(a.start_time),
      });
      continue;
    }

    if (String(a.candidate_id) !== String(b.candidate_id)) {
      changes.push({
        plan_id: planId,
        change: "rescheduled",
        old_candidate_id: String(a.candidate_id),
        new_candidate_id: String(b.candidate_id),
        old_start_time: formatIso(a.start_time),
        new_start_time: formatIso(b.start_time),
      });
    }
  }

  return changes;
}

export async function runActionCounterfactuals(
  trace: DecisionTrace,
  options: FieldOption[],
  baselineSchedule: ScheduleRow[],
  baselineSummary: OptimizationSummary,
  externalVariablesDir: string,
  maxSolverSeconds = 5,
): Promise<any[]> {
  const baselineValue = baselineSummary.total_objective_value_aud;
  const optionalActions: ActionRecord[] = trace.actions.filter((r) => !r.required);
  const results: any[] = [];

  for (const record of optionalActions) {
    const planId = String(record.plan_id);
    const selected = Boolean(record.selected);

    const scenario = selected ? { forbid_plan_ids: [planId] } : { force_plan_ids: [planId] };
    const scenarioType = selected ? "FORBID_SELECTED_ACTION" : "FORCE_SKIPPED_ACTION";

    try {
      const { schedule: scenarioSchedule, summary: scenarioSummary } = await optimizeSchedule(
        options,
        externalVariablesDir,
        scenario,
        maxSolverSeconds,
      );

      const scenarioValue = scenarioSummary.total_objective_value_aud;

      results.push({
        decision_id: `${planId}:counterfactual`,
        type: "COUNTERFACTUAL",
        plan_id: planId,
        field_id: record.field_id,
        operation: record.operation,
        baseline_selected: selected,
        scenario: scenarioType,
        feasible: true,
        baseline_objective_aud: Math.round(baselineValue * 100) / 100,
        counterfactual_objective_aud: Math.round(scenarioValue * 100) / 100,
        objective_change_aud: Math.round((scenarioValue - baselineValue) * 100) / 100,
        affected_decisions: compareSchedules(baselineSchedule, scenarioSchedule),
      });
    } catch {
      results.push({
        decision_id: `${planId}:counterfactual`,
        type: "COUNTERFACTUAL",
        plan_id: planId,
        field_id: record.field_id,
        operation: record.operation,
        baseline_selected: selected,
        scenario: scenarioType,
        feasible: false,
        baseline_objective_aud: Math.round(baselineValue * 100) / 100,
        counterfactual_objective_aud: null,
        objective_change_aud: null,
        affected_decisions: [],
      });
    }
  }

  return results;
}

export async function runTimingCounterfactual(
  options: FieldOption[],
  baselineSchedule: ScheduleRow[],
  baselineSummary: OptimizationSummary,
  planId: string,
  candidateId: string,
  externalVariablesDir: string,
  maxSolverSeconds = 5,
): Promise<any> {
  const baselineValue = baselineSummary.total_objective_value_aud;

  try {
    const { schedule: scenarioSchedule, summary: scenarioSummary } = await optimizeSchedule(
      options,
      externalVariablesDir,
      { force_candidate_ids: { [String(planId)]: String(candidateId) } },
      maxSolverSeconds,
    );

    const scenarioValue = scenarioSummary.total_objective_value_aud;

    return {
      type: "TIMING_COUNTERFACTUAL",
      plan_id: String(planId),
      candidate_id: String(candidateId),
      feasible: true,
      baseline_objective_aud: Math.round(baselineValue * 100) / 100,
      counterfactual_objective_aud: Math.round(scenarioValue * 100) / 100,
      objective_change_aud: Math.round((scenarioValue - baselineValue) * 100) / 100,
      affected_decisions: compareSchedules(baselineSchedule, scenarioSchedule),
    };
  } catch {
    return {
      type: "TIMING_COUNTERFACTUAL",
      plan_id: String(planId),
      candidate_id: String(candidateId),
      feasible: false,
      baseline_objective_aud: Math.round(baselineValue * 100) / 100,
      counterfactual_objective_aud: null,
      objective_change_aud: null,
      affected_decisions: [],
    };
  }
}
