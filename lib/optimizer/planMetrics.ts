import { CANDIDATE_CONFIG } from "./config";
import { ceilToHour, dateOnlyOf, dateOnlyToTimestamp, floorToHour } from "./datetime";
import { getWeatherWindow } from "./externalVariables";
import { weatherForSegments } from "./workload";
import { clip, pyRound } from "./numeric";
import { totalWorkEfficiency } from "./weatherEffects";
import type {
  ExternalVariables,
  FieldOption,
  ManagementPlanRow,
  OptionAction,
  ScheduleMetrics,
  ScheduleRow,
} from "./types";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export interface OptionMetrics {
  option_id: string;
  cost_aud: number;
  water_ml: number;
  risk_score: number;
  mean_start_time: number;
  start_hours: number;
}

export function horizonStartMs(options: FieldOption[]): number {
  let min = Infinity;
  for (const option of options) {
    for (const action of option.actions) {
      if (action.start_time < min) min = action.start_time;
    }
  }
  return Number.isFinite(min) ? min : 0;
}

export function optionCost(option: FieldOption): number {
  return option.actions.reduce((sum, action) => sum + (action.direct_cost_aud ?? 0), 0);
}

export function optionMeanStart(option: FieldOption): number {
  if (option.actions.length === 0) return 0;
  return option.actions.reduce((sum, action) => sum + action.start_time, 0) / option.actions.length;
}

function actionWindowRisk(action: OptionAction, plan: ManagementPlanRow | undefined): number {
  if (!plan) return 0.5;
  const from = dateOnlyToTimestamp(plan.allowed_from);
  const to = dateOnlyToTimestamp(plan.allowed_to) + MS_PER_DAY;
  const span = Math.max(to - from, 1);
  return clip((action.start_time - from) / span, 0, 1);
}

function actionWeatherRisk(action: OptionAction, data: ExternalVariables): number {
  const weather = action.work_segments?.length
    ? weatherForSegments(data, action.work_segments)
    : getWeatherWindow(
        data,
        action.start_time,
        action.duration_hours ?? action.workload_hours ?? (action.end_time - action.start_time) / MS_PER_HOUR,
      );
  if (weather.length === 0) return 0;

  // Risk is the worst loss of work efficiency across the action weather window.
  const minEfficiency = Math.min(...weather.map((row) => totalWorkEfficiency(data.weather, row)));
  return clip(1.0 - minEfficiency, 0.0, 1.0);
}

function residualPressureRisk(option: FieldOption): number {
  const state = option.final_state;
  return Math.max(state.weed_pressure ?? 0, state.pest_pressure ?? 0, state.disease_pressure ?? 0);
}

export function optionRisk(option: FieldOption, data: ExternalVariables): number {
  const planMap = new Map(data.management.map((row) => [String(row.plan_id), row]));
  const actionRisks = option.actions.map((action) => {
    const windowRisk = actionWindowRisk(action, planMap.get(String(action.plan_id)));
    const weatherRisk = actionWeatherRisk(action, data);
    return 0.5 * windowRisk + 0.5 * weatherRisk;
  });
  const averageActionRisk = actionRisks.length === 0 ? 0 : actionRisks.reduce((sum, value) => sum + value, 0) / actionRisks.length;
  return pyRound(averageActionRisk + residualPressureRisk(option), 4);
}

export function buildOptionMetrics(options: FieldOption[], data: ExternalVariables): Map<string, OptionMetrics> {
  const origin = horizonStartMs(options);
  const metrics = new Map<string, OptionMetrics>();

  for (const option of options) {
    const meanStart = optionMeanStart(option);
    metrics.set(option.option_id, {
      option_id: option.option_id,
      cost_aud: pyRound(optionCost(option), 2),
      water_ml: pyRound(
        option.actions.reduce((sum, action) => sum + (action.water_ml ?? 0), 0),
        2,
      ),
      risk_score: optionRisk(option, data),
      mean_start_time: meanStart,
      start_hours: (meanStart - origin) / MS_PER_HOUR,
    });
  }

  return metrics;
}

export function peakLabour(schedule: ScheduleRow[]): number {
  if (schedule.length === 0) return 0;
  const step = Number(CANDIDATE_CONFIG.time_step_hours) * MS_PER_HOUR;
  const start = floorToHour(Math.min(...schedule.map((row) => row.start_time)));
  const end = ceilToHour(Math.max(...schedule.map((row) => row.end_time)));
  let peak = 0;

  for (let t = start; t < end; t += step) {
    const used = schedule
      .filter((row) => row.start_time <= t && t < row.end_time)
      .reduce((sum, row) => sum + row.workers_required, 0);
    if (used > peak) peak = used;
  }

  return peak;
}

export function computeScheduleMetrics(
  schedule: ScheduleRow[],
  options: FieldOption[],
  data: ExternalVariables,
): ScheduleMetrics {
  const optionById = new Map(options.map((option) => [option.option_id, option]));
  const selectedIds = [...new Set(schedule.map((row) => row.option_id))];
  const selectedMetrics = selectedIds
    .map((id) => optionById.get(id))
    .filter((option): option is FieldOption => option != null)
    .map((option) => optionRisk(option, data));

  return {
    total_cost_aud: pyRound(
      schedule.reduce((sum, row) => sum + (row.direct_cost_aud ?? 0), 0),
      2,
    ),
    total_water_ml: pyRound(
      schedule.reduce((sum, row) => sum + (row.water_ml ?? 0), 0),
      2,
    ),
    peak_labour: peakLabour(schedule),
    mean_start_time: (() => {
      const firstByPlan = new Map<string, number>();
      for (const row of schedule) {
        const current = firstByPlan.get(String(row.plan_id));
        if (current === undefined || row.start_time < current) firstByPlan.set(String(row.plan_id), row.start_time);
      }
      const starts = [...firstByPlan.values()];
      return starts.length === 0 ? 0 : starts.reduce((sum, value) => sum + value, 0) / starts.length;
    })(),
    risk_score: pyRound(
      selectedMetrics.reduce((sum, value) => sum + value, 0),
      4,
    ),
  };
}

export function selectedOptionIds(schedule: ScheduleRow[]): string[] {
  return [...new Set(schedule.map((row) => row.option_id))].sort();
}

export function scheduleSignature(schedule: ScheduleRow[]): Set<string> {
  return new Set(schedule.map((row) => `${row.field_id}|${row.plan_id}|${dateOnlyOf(row.start_time)}`));
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

export function countFieldOptionChanges(a: ScheduleRow[], b: ScheduleRow[]): number {
  const optionsA = new Map<string, string>();
  const optionsB = new Map<string, string>();
  for (const row of a) optionsA.set(row.field_id, row.option_id);
  for (const row of b) optionsB.set(row.field_id, row.option_id);

  const fields = new Set([...optionsA.keys(), ...optionsB.keys()]);
  let changes = 0;
  for (const fieldId of fields) {
    if (optionsA.get(fieldId) !== optionsB.get(fieldId)) changes += 1;
  }
  return changes;
}

export function isNearDuplicate(
  candidate: ScheduleRow[],
  kept: ScheduleRow[],
  maxJaccard: number,
  minFieldOptionChanges: number,
): boolean {
  const candidateSignature = scheduleSignature(candidate);
  const keptSignature = scheduleSignature(kept);
  const similarity = jaccardSimilarity(candidateSignature, keptSignature);
  const fieldChanges = countFieldOptionChanges(candidate, kept);
  return similarity > maxJaccard || fieldChanges < minFieldOptionChanges;
}

export function isNearDuplicateOfAny(
  candidate: ScheduleRow[],
  keptSchedules: ScheduleRow[][],
  maxJaccard: number,
  minFieldOptionChanges: number,
): boolean {
  return keptSchedules.some((schedule) => isNearDuplicate(candidate, schedule, maxJaccard, minFieldOptionChanges));
}

export function percentChange(baseline: number, value: number): number | null {
  if (baseline === 0) return value === 0 ? 0 : null;
  return (value - baseline) / baseline;
}

export function formatPercentDelta(delta: number | null): string {
  if (delta == null) return "changed";
  const rounded = Math.round(delta * 100);
  if (rounded === 0) return "unchanged";
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}