import { formatCsvTimestamp } from "./datetime";
import { formatPyBool, formatPyFloat, writeCsv, writeEmptyCsv } from "./csv";
import type { Candidate, ScheduleRow } from "./types";

const CANDIDATE_COLUMNS = [
  { header: "candidate_id", get: (c: Candidate) => c.candidate_id },
  { header: "plan_id", get: (c: Candidate) => c.plan_id },
  { header: "field_id", get: (c: Candidate) => c.field_id },
  { header: "operation", get: (c: Candidate) => c.operation },
  { header: "target", get: (c: Candidate) => c.target },
  { header: "required", get: (c: Candidate) => formatPyBool(c.required) },
  { header: "depends_on", get: (c: Candidate) => c.depends_on },
  { header: "min_gap_hours", get: (c: Candidate) => formatPyFloat(c.min_gap_hours) },
  { header: "start_time", get: (c: Candidate) => formatCsvTimestamp(c.start_time) },
  { header: "end_time", get: (c: Candidate) => formatCsvTimestamp(c.end_time) },
  { header: "duration_hours", get: (c: Candidate) => formatPyFloat(c.duration_hours) },
  { header: "machine_type", get: (c: Candidate) => c.machine_type },
  { header: "eligible_machine_ids", get: (c: Candidate) => c.eligible_machine_ids.join(",") },
  { header: "workers_required", get: (c: Candidate) => String(c.workers_required) },
  { header: "direct_revenue_aud", get: (c: Candidate) => formatPyFloat(c.direct_revenue_aud) },
  { header: "direct_cost_aud", get: (c: Candidate) => formatPyFloat(c.direct_cost_aud) },
  { header: "direct_cash_effect_aud", get: (c: Candidate) => formatPyFloat(c.direct_cash_effect_aud) },
  { header: "state_yield_effect_t_ha", get: (c: Candidate) => formatPyFloat(c.state_yield_effect_t_ha) },
  { header: "water_ml", get: (c: Candidate) => formatPyFloat(c.water_ml) },
  { header: "candidate_score", get: (c: Candidate) => formatPyFloat(c.candidate_score) },
];

export function writeCandidateActionsCsv(filePath: string, candidates: Candidate[]): void {
  if (candidates.length === 0) {
    writeEmptyCsv(filePath, CANDIDATE_COLUMNS);
    return;
  }
  writeCsv(filePath, candidates, CANDIDATE_COLUMNS);
}

const SCHEDULE_COLUMNS = [
  { header: "option_id", get: (r: ScheduleRow) => r.option_id },
  { header: "candidate_id", get: (r: ScheduleRow) => r.candidate_id },
  { header: "plan_id", get: (r: ScheduleRow) => r.plan_id },
  { header: "field_id", get: (r: ScheduleRow) => r.field_id },
  { header: "operation", get: (r: ScheduleRow) => r.operation },
  { header: "target", get: (r: ScheduleRow) => r.target },
  { header: "start_time", get: (r: ScheduleRow) => formatCsvTimestamp(r.start_time) },
  { header: "end_time", get: (r: ScheduleRow) => formatCsvTimestamp(r.end_time) },
  { header: "machine_id", get: (r: ScheduleRow) => r.machine_id },
  { header: "workers_required", get: (r: ScheduleRow) => String(r.workers_required) },
  { header: "water_ml", get: (r: ScheduleRow) => formatPyFloat(r.water_ml) },
  { header: "direct_revenue_aud", get: (r: ScheduleRow) => formatPyFloat(r.direct_revenue_aud) },
  { header: "direct_cost_aud", get: (r: ScheduleRow) => formatPyFloat(r.direct_cost_aud) },
  { header: "direct_cash_effect_aud", get: (r: ScheduleRow) => formatPyFloat(r.direct_cash_effect_aud) },
  { header: "state_yield_effect_t_ha", get: (r: ScheduleRow) => formatPyFloat(r.state_yield_effect_t_ha) },
];

export function writeScheduleCsv(filePath: string, rows: ScheduleRow[]): void {
  if (rows.length === 0) {
    writeEmptyCsv(filePath, SCHEDULE_COLUMNS);
    return;
  }
  writeCsv(filePath, rows, SCHEDULE_COLUMNS);
}
