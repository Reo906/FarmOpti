import summary from '@/data/outputs/optimization_summary.json';
import scheduleCsv from '@/data/outputs/optimal_schedule.csv?raw';
import alternativePlansJson from '@/data/outputs/alternative_plans.json';
import managementPlanCsv from '@/data/external_variables/management_plan.csv?raw';
import weatherCsv from '@/data/external_variables/weather_hourly.csv?raw';
import type { OptimiserCandidate } from '@/app/yallambee-ops';
import type { CropKey } from '@/lib/farm/types';

export interface PersistedScheduleRow {
  option_id: string;
  candidate_id: string;
  plan_id: string;
  field_id: string;
  operation: string;
  target: string;
  start_time: string;
  end_time: string;
  completion_time?: string;
  machine_id: string;
  work_hours?: number;
  workload_hours?: number;
  remaining_workload_hours?: number;
  workers_required: number;
  water_ml: number;
  direct_revenue_aud: number;
  direct_cost_aud: number;
  direct_cash_effect_aud: number;
  state_yield_effect_t_ha: number;
}

export interface PersistedOptimizerSummary {
  status: string;
  total_direct_cash_effect_aud: number;
  total_terminal_value_aud: number;
  total_objective_value_aud: number;
  num_scheduled_actions: number;
  selected_options: Array<{
    option_id: string;
    field_id: string;
    direct_cash_effect_aud: number;
    terminal_value_aud: number;
    objective_value_aud: number;
  }>;
}

export interface ManagementPlanInput {
  plan_id: string;
  field_id: string;
  operation: string;
  target: string;
  amount: string;
  unit: string;
  allowed_from: string;
  allowed_to: string;
  required: boolean;
  depends_on: string;
  min_gap_hours: string;
}

function parseCsvRow(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }

  values.push(value);
  return values;
}

export function parseSchedule(csv: string): PersistedScheduleRow[] {
  const lines = csv.trim().split(/\r?\n/);
  const headers = parseCsvRow(lines[0] ?? '');
  return lines.slice(1).filter(Boolean).map((line) => {
    const values = parseCsvRow(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
    return {
      option_id: row.option_id,
      candidate_id: row.candidate_id,
      plan_id: row.plan_id,
      field_id: row.field_id,
      operation: row.operation,
      target: row.target,
      start_time: row.start_time,
      end_time: row.end_time,
      completion_time: row.completion_time || row.end_time,
      machine_id: row.machine_id,
      work_hours: row.work_hours === undefined || row.work_hours === "" ? undefined : Number(row.work_hours),
      workload_hours: row.workload_hours === undefined || row.workload_hours === "" ? undefined : Number(row.workload_hours),
      remaining_workload_hours: row.remaining_workload_hours === undefined || row.remaining_workload_hours === "" ? undefined : Number(row.remaining_workload_hours),
      workers_required: Number(row.workers_required),
      water_ml: Number(row.water_ml),
      direct_revenue_aud: Number(row.direct_revenue_aud),
      direct_cost_aud: Number(row.direct_cost_aud),
      direct_cash_effect_aud: Number(row.direct_cash_effect_aud),
      state_yield_effect_t_ha: Number(row.state_yield_effect_t_ha),
    };
  });
}

export const persistedSummary = summary as PersistedOptimizerSummary;
export const persistedSchedule = parseSchedule(scheduleCsv);

function parseTimestamp(value: string): number {
  return Date.parse(value.replace(' ', 'T') + 'Z');
}

export interface WeatherWindow {
  start: number;
  end: number;
}

export const HIGH_WIND_KMH = 13;

function weatherWindowsFrom(csv: string, includeHour: (rainMm: number, windKmh: number) => boolean): WeatherWindow[] {
  const hours = csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .flatMap((line) => {
      const values = parseCsvRow(line);
      const start = parseTimestamp(values[0] ?? '');
      const wind = Number(values[2]);
      const rain = Number(values[3]);
      return Number.isFinite(start) && includeHour(rain, wind) ? [start] : [];
    })
    .sort((left, right) => left - right);

  const windows: WeatherWindow[] = [];
  for (const start of hours) {
    const end = start + 3_600_000;
    const last = windows.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else windows.push({ start, end });
  }
  return windows;
}

export function rainWindowsFromWeather(csv: string): WeatherWindow[] {
  return weatherWindowsFrom(csv, (rainMm) => rainMm > 0);
}

export function highWindWindowsFromWeather(csv: string, minSpeed = HIGH_WIND_KMH): WeatherWindow[] {
  return weatherWindowsFrom(csv, (_rainMm, windKmh) => windKmh > minSpeed);
}

export const persistedRainWindows = rainWindowsFromWeather(weatherCsv);
export const persistedHighWindWindows = highWindWindowsFromWeather(weatherCsv);

export function scheduleAnchorFrom(rows: PersistedScheduleRow[]): number {
  return rows.length ? Math.min(...rows.map((row) => parseTimestamp(row.start_time))) : Date.now();
}

export function scheduleEndFrom(rows: PersistedScheduleRow[], anchorTime: number): number {
  return rows.length ? Math.max(...rows.map((row) => parseTimestamp(row.end_time))) : anchorTime;
}

// The true start/end of the persisted schedule, taken across every row (not
// just the first/last line of the CSV, which need not be time-sorted) so the
// timeline can show the schedule's real date range instead of an arbitrary
// fixed window.
export const scheduleAnchorTime = scheduleAnchorFrom(persistedSchedule);
export const scheduleEndTime = scheduleEndFrom(persistedSchedule, scheduleAnchorTime);

export const managementPlanInputs: ManagementPlanInput[] = managementPlanCsv
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .filter(Boolean)
  .map((line) => {
    const values = parseCsvRow(line);
    return {
      plan_id: values[0] ?? '',
      field_id: values[1] ?? '',
      operation: values[2] ?? '',
      target: values[3] ?? '',
      amount: values[4] ?? '',
      unit: values[5] ?? '',
      allowed_from: values[6] ?? '',
      allowed_to: values[7] ?? '',
      required: values[8] === '1',
      depends_on: values[9] ?? '',
      min_gap_hours: values[10] ?? '',
    };
  });

export function dashboardPlanFrom(
  summary: PersistedOptimizerSummary,
  schedule: PersistedScheduleRow[],
  options?: { id?: string; label?: string; detail?: string; anchorTime?: number },
): OptimiserCandidate {
  const anchorTime = options?.anchorTime ?? scheduleAnchorFrom(schedule);
  const blocks = schedule.map((row) => {
    const start = (parseTimestamp(row.start_time) - anchorTime) / 3_600_000;
    const end = (parseTimestamp(row.end_time) - anchorTime) / 3_600_000;
    const operationCrop: CropKey = row.operation === 'harvest' ? 'wheat' : row.operation === 'plant' ? 'barley' : 'canola';
    return {
      m: row.machine_id,
      f: row.field_id,
      name: row.field_id,
      crop: operationCrop,
      s: Math.max(0, start),
      e: Math.max(start + 1, end),
      ha: 0,
    };
  });

  return {
    id: options?.id ?? 'persisted-optimal',
    label: options?.label ?? 'Persisted optimal schedule',
    detail: options?.detail ?? `${summary.num_scheduled_actions} actions from optimization_summary.json and optimal_schedule.csv.`,
    h2: 'off',
    contractor: false,
    sequence: [...new Set(schedule.map((row) => row.field_id))],
    haul: 0,
    blocks,
    harvested: schedule.filter((row) => row.operation === 'harvest').length,
    exposedHa: 0,
    lossValue: 0,
    opCost: summary.total_objective_value_aud - summary.total_direct_cash_effect_aud,
    contractorCost: 0,
    penalty: 0,
    net: summary.total_objective_value_aud,
    truckLimited: false,
    blockedByRule: false,
    deadline: 48,
  };
}

export function persistedDashboardPlan(): OptimiserCandidate {
  return dashboardPlanFrom(persistedSummary, persistedSchedule);
}

export interface PersistedAlternativePlanMetrics {
  total_cost_aud: number;
  total_water_ml: number;
  peak_labour: number;
  risk_score: number;
  mean_start: string;
}

export interface PersistedAlternativePlan {
  plan_id: string;
  label: string;
  reason: string;
  objective_value_aud: number;
  optimality_ratio: number;
  selected_option_ids: string[];
  metrics: PersistedAlternativePlanMetrics;
  summary: PersistedOptimizerSummary;
  schedule: PersistedScheduleRow[];
}

export interface PersistedAlternativePlans {
  baseline_objective_aud: number;
  min_optimality_ratio: number;
  plans: PersistedAlternativePlan[];
}

export interface ResourcePlanDiffs {
  dropped: number;
  added: number;
  rescheduled: number;
}

export interface ResourcePlanOption {
  id: string;
  name: string;
  explanation: string;
  netValueAud: number;
  optimalityPercent: string | null;
  benefit: string;
  diffs: ResourcePlanDiffs | null;
  diffLabel: string | null;
  summary: PersistedOptimizerSummary;
  schedule: PersistedScheduleRow[];
  dashboardPlan: OptimiserCandidate;
  anchorTime: number;
}

const RESOURCE_PLAN_PRESENTATION = [
  { id: 'value', name: 'Max Value', explanation: 'Make me the most money.', benefit: 'value' },
  { id: 'low_cost', name: 'Low Cost', explanation: 'Spend less, while keeping most of the return.', benefit: 'cost' },
  { id: 'low_risk', name: 'Low Risk', explanation: 'Give me a safer, more robust plan.', benefit: 'risk' },
  { id: 'smoother', name: 'Smoother Workload', explanation: 'Make the workload easier to execute.', benefit: 'smooth' },
] as const;

function formatScheduleInstant(value: string | number | undefined, fallback = ''): string {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fallback;
    return new Date(value).toISOString().slice(0, 19);
  }
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  return Number(value);
}

function asPersistedScheduleRow(row: Record<string, unknown>): PersistedScheduleRow {
  return {
    option_id: String(row.option_id ?? ''),
    candidate_id: String(row.candidate_id ?? ''),
    plan_id: String(row.plan_id ?? ''),
    field_id: String(row.field_id ?? ''),
    operation: String(row.operation ?? ''),
    target: String(row.target ?? ''),
    start_time: formatScheduleInstant(row.start_time as string | number | undefined),
    end_time: formatScheduleInstant(row.end_time as string | number | undefined),
    completion_time: formatScheduleInstant(row.completion_time as string | number | undefined, formatScheduleInstant(row.end_time as string | number | undefined)),
    machine_id: String(row.machine_id ?? ''),
    work_hours: optionalNumber(row.work_hours),
    workload_hours: optionalNumber(row.workload_hours),
    remaining_workload_hours: optionalNumber(row.remaining_workload_hours),
    workers_required: Number(row.workers_required),
    water_ml: Number(row.water_ml),
    direct_revenue_aud: Number(row.direct_revenue_aud),
    direct_cost_aud: Number(row.direct_cost_aud),
    direct_cash_effect_aud: Number(row.direct_cash_effect_aud),
    state_yield_effect_t_ha: Number(row.state_yield_effect_t_ha),
  };
}

function lastRowByManagementPlan(schedule: PersistedScheduleRow[]): Map<string, PersistedScheduleRow> {
  const map = new Map<string, PersistedScheduleRow>();
  for (const row of schedule) map.set(row.plan_id, row);
  return map;
}

export function compareResourcePlanSchedules(baseline: PersistedScheduleRow[], schedule: PersistedScheduleRow[]): ResourcePlanDiffs {
  const previous = lastRowByManagementPlan(baseline);
  const next = lastRowByManagementPlan(schedule);
  let added = 0;
  let dropped = 0;
  let rescheduled = 0;

  for (const planId of new Set([...previous.keys(), ...next.keys()])) {
    const left = previous.get(planId);
    const right = next.get(planId);
    if (!left) added += 1;
    else if (!right) dropped += 1;
    else if (left.candidate_id !== right.candidate_id) rescheduled += 1;
  }

  return { added, dropped, rescheduled };
}

function formatDiffLabel(diffs: ResourcePlanDiffs): string | null {
  const parts: string[] = [];
  if (diffs.dropped) parts.push(`${diffs.dropped} dropped`);
  if (diffs.added) parts.push(`${diffs.added} added`);
  if (diffs.rescheduled) parts.push(`${diffs.rescheduled} rescheduled`);
  return parts.length ? parts.join(' · ') : null;
}

function formatMetricBenefit(label: string, baseline: number, value: number): string {
  if (baseline === 0) return value === 0 ? `${label} unchanged` : `${label} changed`;
  const percent = Math.round(((value - baseline) / baseline) * 100);
  if (percent === 0) return `${label} unchanged`;
  return `${label} ${percent < 0 ? '↓' : '↑'}${Math.abs(percent)}%`;
}

function planBenefit(kind: (typeof RESOURCE_PLAN_PRESENTATION)[number]['benefit'], baseline: PersistedAlternativePlan, plan: PersistedAlternativePlan): string {
  if (kind === 'value') return 'Best overall value';
  if (kind === 'cost') return formatMetricBenefit('Input cost', baseline.metrics.total_cost_aud, plan.metrics.total_cost_aud);
  if (kind === 'risk') return formatMetricBenefit('Risk', baseline.metrics.risk_score, plan.metrics.risk_score);
  return formatMetricBenefit('Peak labour', baseline.metrics.peak_labour, plan.metrics.peak_labour);
}

function normalizeAlternativePlan(plan: PersistedAlternativePlan): PersistedAlternativePlan {
  return {
    ...plan,
    schedule: (plan.schedule ?? []).map((row) => asPersistedScheduleRow(row as unknown as Record<string, unknown>)),
  };
}

function pairedResourcePlans(plans: PersistedAlternativePlan[]): Array<{ presentation: (typeof RESOURCE_PLAN_PRESENTATION)[number]; plan: PersistedAlternativePlan }> {
  const byId = new Map(plans.map((plan) => [plan.plan_id, plan]));
  const matched = RESOURCE_PLAN_PRESENTATION.flatMap((presentation) => {
    const plan = byId.get(presentation.id);
    return plan ? [{ presentation, plan }] : [];
  });
  if (matched.length > 0) return matched;
  return plans.slice(0, RESOURCE_PLAN_PRESENTATION.length).map((plan, index) => ({
    presentation: RESOURCE_PLAN_PRESENTATION[index],
    plan,
  }));
}

export function resourcePlanOptionsFrom(data: PersistedAlternativePlans): ResourcePlanOption[] {
  const plans = (data.plans ?? []).map(normalizeAlternativePlan);
  if (plans.length === 0) return [];
  const baseline = plans.find((plan) => plan.plan_id === 'value') ?? plans[0];

  return pairedResourcePlans(plans).map(({ presentation, plan }) => {
    const schedule = plan.schedule;
    const anchorTime = scheduleAnchorFrom(schedule);
    const isBaseline = plan.plan_id === baseline.plan_id;
    const diffs = isBaseline ? null : compareResourcePlanSchedules(baseline.schedule, schedule);
    return {
      id: presentation.id,
      name: presentation.name,
      explanation: presentation.explanation,
      netValueAud: plan.objective_value_aud,
      optimalityPercent: isBaseline || plan.optimality_ratio === 1 ? null : `${(plan.optimality_ratio * 100).toFixed(1)}%`,
      benefit: planBenefit(presentation.benefit, baseline, plan),
      diffs,
      diffLabel: diffs ? formatDiffLabel(diffs) : null,
      summary: plan.summary,
      schedule,
      dashboardPlan: dashboardPlanFrom(plan.summary, schedule, {
        id: presentation.id,
        label: presentation.name,
        detail: presentation.explanation,
        anchorTime,
      }),
      anchorTime,
    };
  });
}

export const persistedAlternativePlans = alternativePlansJson as unknown as PersistedAlternativePlans;
export const persistedResourcePlans = resourcePlanOptionsFrom(persistedAlternativePlans);
export const defaultResourcePlanId = persistedResourcePlans[0]?.id ?? 'value';
