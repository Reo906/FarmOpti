import summary from '@/data/outputs/optimization_summary.json';
import scheduleCsv from '@/data/outputs/optimal_schedule.csv?raw';
import managementPlanCsv from '@/data/external_variables/management_plan.csv?raw';
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

export function dashboardPlanFrom(summary: PersistedOptimizerSummary, schedule: PersistedScheduleRow[]): OptimiserCandidate {
  const anchorTime = scheduleAnchorFrom(schedule);
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
    id: 'persisted-optimal',
    label: 'Persisted optimal schedule',
    detail: `${summary.num_scheduled_actions} actions from optimization_summary.json and optimal_schedule.csv.`,
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
