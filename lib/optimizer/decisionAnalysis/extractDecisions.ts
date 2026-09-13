import { CANDIDATE_CONFIG, CONFIG } from "../config";
import { loadExternalVariables } from "../externalVariables";
import { FieldSimulator } from "../fieldSimulator";
import { ceilToHour, combineDateAndTime, dateOnlyOf, floorToHour, formatIso } from "../datetime";
import { EXTERNAL_DIR } from "../paths";
import type {
  Candidate,
  ExternalVariables,
  FieldOption,
  ManagementPlanRow,
  OptimizationSummary,
  ScheduleRow,
} from "../types";

export interface StateChange {
  before: unknown;
  after: unknown;
  change?: number;
}

export interface StateTransitionRecord {
  plan_id: string;
  candidate_id: string;
  field_id: string;
  operation: string;
  target: string;
  start_time: string;
  end_time: string;
  state_before: Record<string, unknown>;
  state_after: Record<string, unknown>;
  state_changes: Record<string, StateChange>;
  direct_revenue_aud: number;
  direct_cost_aud: number;
  direct_cash_effect_aud: number;
  state_yield_effect_t_ha: number;
}

export interface AlternativeTime {
  candidate_id: string;
  start_time: string;
  direct_cash_effect_aud: number;
}

export interface TimingInfo {
  feasible_candidate_count: number;
  earliest_feasible_time: string | null;
  latest_feasible_time: string | null;
  selected_time: string | null;
  selected_candidate_id: string | null;
  alternative_times: AlternativeTime[];
}

export interface ActionRecord {
  decision_id: string;
  type: "ACTION_SELECTED" | "ACTION_SKIPPED";
  plan_id: string;
  field_id: string;
  operation: string;
  target: string;
  required: boolean;
  selected: boolean;
  depends_on: string;
  min_gap_hours: number;
  timing: TimingInfo;
  financial: {
    direct_revenue_aud: number;
    direct_cost_aud: number;
    direct_cash_effect_aud: number;
    state_yield_effect_t_ha: number;
  } | null;
  state_transition: StateTransitionRecord | null;
  counterfactual: any;
  importance: number;
}

export interface FieldDecisionRecord {
  decision_id: string;
  type: "FIELD_OPTION_SELECTED";
  field_id: string;
  selected_option_id: string;
  selected_objective_value_aud: number;
  selected_direct_cash_effect_aud: number;
  selected_terminal_value_aud: number;
  best_local_alternative: {
    option_id: string;
    objective_value_aud: number;
    local_value_difference_aud: number;
  } | null;
}

export interface ResourceRecord {
  decision_id: string;
  type: "RESOURCE_UTILISATION";
  resource_type: "machine" | "water" | "labour";
  resource_id?: string;
  date?: string;
  time?: string;
  used_hours?: number;
  available_hours?: number;
  used_ml?: number;
  capacity_ml?: number;
  used_workers?: number;
  available_workers?: number;
  utilisation: number;
  binding: boolean;
  affected_plans?: string[];
}

export interface DecisionTrace {
  generated_at: string;
  summary: OptimizationSummary;
  actions: ActionRecord[];
  field_decisions: FieldDecisionRecord[];
  resources: ResourceRecord[];
  counterfactuals: any[];
}

function stateDiff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, StateChange> {
  const changes: Record<string, StateChange> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of [...keys].sort()) {
    const a = before[key];
    const b = after[key];

    if (typeof a === "number" && typeof b === "number") {
      const delta = Math.round((b - a) * 1e4) / 1e4;
      if (Math.abs(delta) > 1e-9) {
        changes[key] = { before: Math.round(a * 1e4) / 1e4, after: Math.round(b * 1e4) / 1e4, change: delta };
      }
    } else if (a !== b) {
      changes[key] = { before: a, after: b };
    }
  }

  return changes;
}

function simulateSelectedOption(data: ExternalVariables, option: FieldOption): StateTransitionRecord[] {
  const fieldId = String(option.field_id);
  const planMap = new Map(data.management.map((p) => [p.plan_id, p]));
  const simulator = new FieldSimulator(data, CONFIG, fieldId);
  const records: StateTransitionRecord[] = [];

  const actions = [...option.actions].sort((a, b) => a.start_time - b.start_time);

  for (const action of actions) {
    const planId = String(action.plan_id);
    const plan = planMap.get(planId)!;

    simulator.advanceTo(action.start_time);
    const before = simulator.snapshot() as unknown as Record<string, unknown>;
    const result = simulator.evaluateAndApply(action, plan);
    if (result === null) continue;

    const after = result.state_after as unknown as Record<string, unknown>;

    records.push({
      plan_id: planId,
      candidate_id: String(action.candidate_id),
      field_id: fieldId,
      operation: String(action.operation),
      target: action.target ?? "",
      start_time: formatIso(action.start_time),
      end_time: formatIso(action.end_time),
      state_before: before,
      state_after: after,
      state_changes: stateDiff(before, after),
      direct_revenue_aud: result.direct_revenue_aud,
      direct_cost_aud: result.direct_cost_aud,
      direct_cash_effect_aud: result.direct_cash_effect_aud,
      state_yield_effect_t_ha: result.state_yield_effect_t_ha,
    });
  }

  return records;
}

export function buildActionRecords(
  data: ExternalVariables,
  candidates: Candidate[],
  options: FieldOption[],
  schedule: ScheduleRow[],
  summary: OptimizationSummary,
): ActionRecord[] {
  const selectedOptionIds = new Set(summary.selected_options.map((o) => String(o.option_id)));
  const selectedOptions = options.filter((o) => selectedOptionIds.has(String(o.option_id)));

  const transitions = new Map<string, StateTransitionRecord>();
  for (const option of selectedOptions) {
    for (const record of simulateSelectedOption(data, option)) {
      transitions.set(record.plan_id, record);
    }
  }

  const candidatesByPlan = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = candidatesByPlan.get(c.plan_id) ?? [];
    list.push(c);
    candidatesByPlan.set(c.plan_id, list);
  }

  const records: ActionRecord[] = [];

  for (const plan of data.management) {
    const planId = plan.plan_id;
    const selectedRows = schedule.filter((s) => s.plan_id === planId);
    const selected = selectedRows.length > 0;
    const selectedRow = selected ? selectedRows[0] : null;

    const planCandidates = [...(candidatesByPlan.get(planId) ?? [])].sort((a, b) => a.start_time - b.start_time);

    const timing: TimingInfo = {
      feasible_candidate_count: planCandidates.length,
      earliest_feasible_time: null,
      latest_feasible_time: null,
      selected_time: null,
      selected_candidate_id: null,
      alternative_times: [],
    };

    if (planCandidates.length > 0) {
      timing.earliest_feasible_time = formatIso(planCandidates[0].start_time);
      timing.latest_feasible_time = formatIso(planCandidates[planCandidates.length - 1].start_time);
    }

    if (selected && selectedRow) {
      timing.selected_time = formatIso(selectedRow.start_time);
      timing.selected_candidate_id = String(selectedRow.candidate_id);

      const alternatives = planCandidates
        .filter((c) => String(c.candidate_id) !== String(selectedRow.candidate_id))
        .map((c) => ({ candidate: c, distance: Math.abs(c.start_time - selectedRow.start_time) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 5);

      timing.alternative_times = alternatives.map(({ candidate }) => ({
        candidate_id: String(candidate.candidate_id),
        start_time: formatIso(candidate.start_time),
        direct_cash_effect_aud: candidate.direct_cash_effect_aud,
      }));
    }

    const record: ActionRecord = {
      decision_id: `${planId}:action`,
      type: selected ? "ACTION_SELECTED" : "ACTION_SKIPPED",
      plan_id: planId,
      field_id: String(plan.field_id),
      operation: String(plan.operation),
      target: plan.target ?? "",
      required: plan.required,
      selected,
      depends_on: plan.depends_on ?? "",
      min_gap_hours: plan.min_gap_hours ?? 0.0,
      timing,
      financial: null,
      state_transition: transitions.get(planId) ?? null,
      counterfactual: null,
      importance: 0.0,
    };

    if (selected && selectedRow) {
      record.financial = {
        direct_revenue_aud: selectedRow.direct_revenue_aud,
        direct_cost_aud: selectedRow.direct_cost_aud,
        direct_cash_effect_aud: selectedRow.direct_cash_effect_aud,
        state_yield_effect_t_ha: selectedRow.state_yield_effect_t_ha,
      };
    }

    records.push(record);
  }

  return records;
}

export function buildFieldRecords(options: FieldOption[], summary: OptimizationSummary): FieldDecisionRecord[] {
  const selectedIds = new Map(summary.selected_options.map((o) => [String(o.option_id), o]));

  const optionsByField = new Map<string, FieldOption[]>();
  for (const option of options) {
    const list = optionsByField.get(String(option.field_id)) ?? [];
    list.push(option);
    optionsByField.set(String(option.field_id), list);
  }

  const records: FieldDecisionRecord[] = [];

  for (const [fieldId, fieldOptions] of optionsByField) {
    const selected = fieldOptions.find((o) => selectedIds.has(String(o.option_id)))!;

    const alternatives = fieldOptions
      .filter((o) => String(o.option_id) !== String(selected.option_id))
      .sort((a, b) => b.objective_value_aud - a.objective_value_aud);

    const bestAlt = alternatives[0] ?? null;

    records.push({
      decision_id: `${fieldId}:field_option`,
      type: "FIELD_OPTION_SELECTED",
      field_id: fieldId,
      selected_option_id: String(selected.option_id),
      selected_objective_value_aud: selected.objective_value_aud,
      selected_direct_cash_effect_aud: selected.total_direct_cash_effect_aud,
      selected_terminal_value_aud: selected.terminal_value_aud,
      best_local_alternative: bestAlt
        ? {
            option_id: String(bestAlt.option_id),
            objective_value_aud: bestAlt.objective_value_aud,
            local_value_difference_aud: Math.round((selected.objective_value_aud - bestAlt.objective_value_aud) * 100) / 100,
          }
        : null,
    });
  }

  return records;
}

export function buildResourceRecords(data: ExternalVariables, schedule: ScheduleRow[]): ResourceRecord[] {
  if (schedule.length === 0) return [];

  const records: ResourceRecord[] = [];

  const byMachine = new Map<string, ScheduleRow[]>();
  for (const row of schedule) {
    if (!row.machine_id) continue;
    const list = byMachine.get(row.machine_id) ?? [];
    list.push(row);
    byMachine.set(row.machine_id, list);
  }

  for (const [machineId, group] of byMachine) {
    const usedHours = group.reduce((sum, r) => sum + (r.end_time - r.start_time) / 3_600_000, 0);

    const availabilityRows = data.machineAvailability.filter((a) => a.machine_id === machineId && a.available === 1);
    let availableHours = 0.0;
    for (const row of availabilityRows) {
      if (row.available_from === null || row.available_to === null) continue;
      const start = combineDateAndTime(row.date, row.available_from);
      const end = combineDateAndTime(row.date, row.available_to);
      availableHours += Math.max(0.0, (end - start) / 3_600_000);
    }

    const utilisation = availableHours > 0 ? usedHours / availableHours : 0.0;

    records.push({
      decision_id: `machine:${machineId}`,
      type: "RESOURCE_UTILISATION",
      resource_type: "machine",
      resource_id: String(machineId),
      used_hours: Math.round(usedHours * 100) / 100,
      available_hours: Math.round(availableHours * 100) / 100,
      utilisation: Math.round(utilisation * 1e4) / 1e4,
      binding: utilisation >= 0.9,
      affected_plans: group.map((r) => String(r.plan_id)),
    });
  }

  for (const waterRow of data.water) {
    const used = schedule
      .filter((s) => dateOnlyOf(s.start_time) === waterRow.date)
      .reduce((sum, s) => sum + s.water_ml, 0);

    const capacity = Math.min(waterRow.available_water_ml, waterRow.max_delivery_ml_per_day);
    const utilisation = capacity > 0 ? used / capacity : 0.0;

    records.push({
      decision_id: `water:${waterRow.date}`,
      type: "RESOURCE_UTILISATION",
      resource_type: "water",
      date: waterRow.date,
      used_ml: Math.round(used * 1000) / 1000,
      capacity_ml: Math.round(capacity * 100) / 100,
      utilisation: Math.round(utilisation * 1e4) / 1e4,
      binding: utilisation >= 0.9,
    });
  }

  const timeStepMs = Number(CANDIDATE_CONFIG.time_step_hours) * 3_600_000;
  const start = floorToHour(Math.min(...schedule.map((s) => s.start_time)));
  const end = ceilToHour(Math.max(...schedule.map((s) => s.end_time)));

  for (let t = start; t < end; t += timeStepMs) {
    const date = dateOnlyOf(t);
    const labourRow = data.labour.find((l) => l.date === date);
    if (!labourRow) continue;

    const capacity = labourRow.available_workers;
    const active = schedule.filter((s) => s.start_time <= t && s.end_time > t);
    const used = active.reduce((sum, s) => sum + s.workers_required, 0);
    const utilisation = capacity > 0 ? used / capacity : 0.0;

    if (used > 0 || utilisation >= 0.9) {
      records.push({
        decision_id: `labour:${formatIso(t)}`,
        type: "RESOURCE_UTILISATION",
        resource_type: "labour",
        time: formatIso(t),
        used_workers: used,
        available_workers: capacity,
        utilisation: Math.round(utilisation * 1e4) / 1e4,
        binding: utilisation >= 0.9,
        affected_plans: active.map((s) => String(s.plan_id)),
      });
    }
  }

  return records;
}

export function updateImportance(trace: DecisionTrace): DecisionTrace {
  const baseline = Math.abs(trace.summary.total_objective_value_aud) || 1.0;
  const counterfactualByPlan = new Map(trace.counterfactuals.map((x: any) => [String(x.plan_id), x]));

  for (const record of trace.actions) {
    let score = 0.0;

    if (record.required) score += 0.15;

    const financial = record.financial;
    if (financial && financial.direct_cash_effect_aud < 0) {
      score += Math.min(0.2, (Math.abs(financial.direct_cash_effect_aud) / baseline) * 10);
    }

    const counterfactual = counterfactualByPlan.get(record.plan_id);
    if (counterfactual) {
      record.counterfactual = counterfactual;

      const objectiveChange = counterfactual.objective_change_aud;
      if (objectiveChange !== null && objectiveChange !== undefined) {
        const delta = Math.abs(objectiveChange);
        score += Math.min(0.6, (delta / baseline) * 20);
      } else if (counterfactual.feasible === false) {
        score += 0.6;
      }
    }

    if (!record.required) score += 0.1;

    record.importance = Math.min(1.0, Math.round(score * 1e4) / 1e4);
  }

  return trace;
}

export function generateDecisionTrace(
  candidates: Candidate[],
  options: FieldOption[],
  schedule: ScheduleRow[],
  summary: OptimizationSummary,
  externalVariablesDir: string = EXTERNAL_DIR,
): DecisionTrace {
  const data = loadExternalVariables(externalVariablesDir);

  const trace: DecisionTrace = {
    generated_at: new Date().toISOString(),
    summary,
    actions: buildActionRecords(data, candidates, options, schedule, summary),
    field_decisions: buildFieldRecords(options, summary),
    resources: buildResourceRecords(data, schedule),
    counterfactuals: [],
  };

  return updateImportance(trace);
}
