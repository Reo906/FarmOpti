import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanReason } from "./alternativePlans.ts";
import {
  countFieldOptionChanges,
  formatPercentDelta,
  isNearDuplicate,
  isNearDuplicateOfAny,
  jaccardSimilarity,
  peakLabour,
  percentChange,
  scheduleSignature,
  selectedOptionIds,
} from "./planMetrics.ts";
import type { AlternativePlan, ScheduleRow } from "./types.ts";

function row(overrides: Partial<ScheduleRow> & Pick<ScheduleRow, "option_id" | "field_id" | "plan_id" | "start_time">): ScheduleRow {
  return {
    candidate_id: overrides.candidate_id ?? `${overrides.plan_id}_c`,
    operation: overrides.operation ?? "spray",
    target: overrides.target ?? "pest_control",
    end_time: overrides.end_time ?? overrides.start_time + 3_600_000,
    work_hours: overrides.work_hours ?? 1,
    workload_hours: overrides.workload_hours ?? 1,
    remaining_workload_hours: overrides.remaining_workload_hours ?? 0,
    completion_time: overrides.completion_time ?? overrides.end_time ?? overrides.start_time + 3_600_000,
    machine_id: overrides.machine_id ?? "M3",
    workers_required: overrides.workers_required ?? 1,
    water_ml: overrides.water_ml ?? 0,
    direct_revenue_aud: overrides.direct_revenue_aud ?? 0,
    direct_cost_aud: overrides.direct_cost_aud ?? 100,
    direct_cash_effect_aud: overrides.direct_cash_effect_aud ?? -100,
    state_yield_effect_t_ha: overrides.state_yield_effect_t_ha ?? 0,
    ...overrides,
  };
}

const day1 = Date.UTC(2026, 8, 17, 7);
const day2 = Date.UTC(2026, 8, 18, 7);
const day3 = Date.UTC(2026, 8, 19, 7);

test("schedule signature groups same-day operations", () => {
  const schedule = [
    row({ option_id: "F1_O001", field_id: "F1", plan_id: "P01", start_time: day1 }),
    row({ option_id: "F1_O001", field_id: "F1", plan_id: "P01", start_time: day1 + 3_600_000 }),
  ];
  const signature = scheduleSignature(schedule);
  assert.equal(signature.size, 1);
  assert.equal([...signature][0], "F1|P01|2026-09-17");
});

test("jaccard similarity and near-duplicate filter reject same-day clones", () => {
  const baseline = [
    row({ option_id: "F1_O001", field_id: "F1", plan_id: "P01", start_time: day1 }),
    row({ option_id: "F2_O001", field_id: "F2", plan_id: "P02", start_time: day2 }),
  ];
  const sameDayShift = [
    row({ option_id: "F1_O002", field_id: "F1", plan_id: "P01", start_time: day1 + 3_600_000 }),
    row({ option_id: "F2_O002", field_id: "F2", plan_id: "P02", start_time: day2 + 3_600_000 }),
  ];
  const differentDays = [
    row({ option_id: "F1_O003", field_id: "F1", plan_id: "P01", start_time: day2 }),
    row({ option_id: "F2_O003", field_id: "F2", plan_id: "P03", start_time: day3 }),
  ];

  assert.equal(jaccardSimilarity(scheduleSignature(baseline), scheduleSignature(sameDayShift)), 1);
  assert.equal(isNearDuplicate(sameDayShift, baseline, 0.8, 2), true);
  assert.equal(isNearDuplicate(differentDays, baseline, 0.8, 2), false);
  assert.equal(isNearDuplicateOfAny(differentDays, [baseline], 0.8, 2), false);
});

test("countFieldOptionChanges tracks fields that picked a different option", () => {
  const baseline = [
    row({ option_id: "F1_O001", field_id: "F1", plan_id: "P01", start_time: day1 }),
    row({ option_id: "F2_O001", field_id: "F2", plan_id: "P02", start_time: day2 }),
  ];
  const oneChange = [
    row({ option_id: "F1_O009", field_id: "F1", plan_id: "P01", start_time: day1 }),
    row({ option_id: "F2_O001", field_id: "F2", plan_id: "P02", start_time: day2 }),
  ];
  assert.equal(countFieldOptionChanges(baseline, oneChange), 1);
  assert.equal(isNearDuplicate(oneChange, baseline, 0.8, 2), true);
});

test("peak labour uses overlapping worker demand", () => {
  const schedule = [
    row({ option_id: "F1_O001", field_id: "F1", plan_id: "P01", start_time: day1, end_time: day1 + 2 * 3_600_000, workers_required: 2 }),
    row({ option_id: "F2_O001", field_id: "F2", plan_id: "P02", start_time: day1, end_time: day1 + 3_600_000, workers_required: 1 }),
  ];
  assert.equal(peakLabour(schedule), 3);
});

test("selected option ids are unique and sorted", () => {
  const schedule = [
    row({ option_id: "F2_O001", field_id: "F2", plan_id: "P02", start_time: day2 }),
    row({ option_id: "F1_O001", field_id: "F1", plan_id: "P01", start_time: day1 }),
    row({ option_id: "F1_O001", field_id: "F1", plan_id: "P09", start_time: day3 }),
  ];
  assert.deepEqual(selectedOptionIds(schedule), ["F1_O001", "F2_O001"]);
});

test("percent helpers and themed reasons mention the trade-off", () => {
  assert.equal(formatPercentDelta(percentChange(100, 88)), "-12%");
  assert.equal(formatPercentDelta(percentChange(100, 100)), "unchanged");

  const baseline = {
    plan_id: "value",
    schedule: [row({ option_id: "F1_O001", field_id: "F1", plan_id: "P01", start_time: day1 })],
    metrics: { total_cost_aud: 1000, total_water_ml: 4, peak_labour: 4, mean_start_time: day1, risk_score: 1 },
  } as AlternativePlan;
  const cheaper = {
    plan_id: "low_cost",
    optimality_ratio: 0.97,
    schedule: [
      row({ option_id: "F1_O002", field_id: "F1", plan_id: "P01", start_time: day2 }),
      row({ option_id: "F2_O002", field_id: "F2", plan_id: "P03", start_time: day3 }),
    ],
    metrics: { total_cost_aud: 880, total_water_ml: 2, peak_labour: 3, mean_start_time: day2, risk_score: 0.8 },
  } as AlternativePlan;

  const reason = buildPlanReason({ plan_id: "low_cost" }, cheaper, baseline);
  assert.match(reason, /Lower cost\/resource usage/);
  assert.match(reason, /97%/);
  assert.match(reason, /-12%/);
});
