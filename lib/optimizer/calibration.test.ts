import assert from "node:assert/strict";
import test from "node:test";
import { personaliseValue } from "./calibration/apply.ts";
import { confidenceAlpha } from "./calibration/confidence.ts";
import { generateFieldOptions } from "./fieldOptions.ts";
import { FieldSimulator } from "./fieldSimulator.ts";
import { genericNextMoisture, genericNextPressure } from "./genericTransitions.ts";
import type { FarmCalibration } from "./calibration/types.ts";
import type { Candidate, ExternalVariables, ManagementPlanRow } from "./types.ts";

const START = Date.UTC(2026, 8, 17, 7);

function mockCalibration(overrides: Partial<FarmCalibration> = {}): FarmCalibration {
  return {
    metadata: {
      farm_id: "demo_farm",
      training_rows: 10,
      fields: ["F2"],
      crops: ["canola"],
      model_version: 1,
      trained_at: "2026-01-01T00:00:00Z",
      samples: { irrigation: 5, fertiliser: 5, spray: 5, yield_rows: 5, yield_seasons: 1 },
      support: {
        irrigate: { all: 5, by_crop: { canola: 5 }, by_field_crop: { "F2|canola": 5 } },
        fertilise: { all: 5, by_crop: { canola: 5 }, by_field_crop: { "F2|canola": 5 } },
        spray: { all: 5, by_crop: { canola: 5 }, by_field_crop: { "F2|canola": 5 } },
        yield: { all: 5, by_crop: { canola: 5 }, by_field_crop: { "F2|canola": 5 } },
      },
      feature_names: {},
      confidence_k: 5,
    },
    irrigation: null,
    fertiliser: null,
    spray: null,
    yield: null,
    ...overrides,
  };
}

function mockData(fieldId: string, irrigable: number, moisture = 0.17): ExternalVariables {
  return {
    fields: [
      {
        field_id: fieldId,
        area_ha: 18,
        current_crop: "canola",
        planned_crop: "",
        irrigable,
        x_km: 0,
        y_km: 0,
      },
    ],
    state: [
      {
        date: "2026-09-17",
        field_id: fieldId,
        growth_stage: "vegetative",
        readiness: 0.5,
        soil_moisture: moisture,
        soil_temperature_c: 16,
        expected_yield_t_ha: 2.5,
        nitrogen_index: 0.4,
        weed_pressure: 0.2,
        pest_pressure: 0.15,
        disease_pressure: 0.1,
        seedbed_readiness: 0.8,
      },
    ],
    weather: [],
    labour: [],
    machines: [],
    machineAvailability: [],
    water: [],
    economics: [],
    management: [],
  };
}

function candidate(operation: string, target: string): Candidate {
  return {
    candidate_id: "c1",
    plan_id: "P1",
    field_id: "F2",
    operation,
    target,
    required: false,
    depends_on: "",
    min_gap_hours: 0,
    start_time: START,
    end_time: START + 3_600_000,
    duration_hours: 1,
    machine_type: "irrigator",
    eligible_machine_ids: ["M6"],
    workers_required: 1,
    direct_revenue_aud: 0,
    direct_cost_aud: 10,
    direct_cash_effect_aud: -10,
    state_yield_effect_t_ha: 0,
    water_ml: 4.5,
    candidate_score: 0,
  };
}

function plan(operation: string, target: string, amount: number | null = 0.25): ManagementPlanRow {
  return {
    plan_id: "P1",
    field_id: "F2",
    operation,
    target,
    amount,
    unit: "",
    allowed_from: "2026-09-17",
    allowed_to: "2026-09-26",
    required: false,
    depends_on: "",
    min_gap_hours: null,
  };
}

test("generic fallback: disabled personalisation matches original irrigate transition", () => {
  const simulator = new FieldSimulator(mockData("F2", 1, 0.17), {}, "F2", null);
  const result = simulator.evaluateAndApply(candidate("irrigate", "soil_moisture"), plan("irrigate", "soil_moisture", 0.25));
  assert.ok(result);
  assert.equal(result.state_after?.soil_moisture, genericNextMoisture(0.17, 0.25));
  assert.equal(result.state_after?.soil_moisture, 0.25);
});

test("irrigation residual uses generic + alpha * residual", () => {
  assert.equal(personaliseValue(0.25, 0.04, 0.5), 0.27);
  assert.equal(confidenceAlpha(5, 5), 0.5);

  const calibration = mockCalibration({
    irrigation: { kind: "constant", value: 0.04 },
  });
  const simulator = new FieldSimulator(mockData("F2", 1, 0.17), {}, "F2", calibration);
  const result = simulator.evaluateAndApply(candidate("irrigate", "soil_moisture"), plan("irrigate", "soil_moisture", 0.25));
  assert.ok(result);
  assert.equal(result.state_after?.soil_moisture, 0.27);
});

test("spray_target=weed corrects only weed pressure", () => {
  const calibration = mockCalibration({
    spray: { kind: "constant", value: 0.05 },
  });
  const simulator = new FieldSimulator(mockData("F2", 1, 0.17), {}, "F2", calibration);
  const result = simulator.evaluateAndApply(candidate("spray", "weed_control"), plan("spray", "weed_control", null));
  assert.ok(result);
  const genericWeed = genericNextPressure(0.2, 0.9)!;
  assert.equal(result.state_after?.weed_pressure, personaliseValue(genericWeed, 0.05, 0.5));
  assert.equal(result.state_after?.pest_pressure, 0.15);
  assert.equal(result.state_after?.disease_pressure, 0.1);
});

test("non-irrigable fields do not receive irrigation residuals", () => {
  const calibration = mockCalibration({
    irrigation: { kind: "constant", value: 0.04 },
  });
  const simulator = new FieldSimulator(mockData("F1", 0, 0.17), {}, "F1", calibration);
  const result = simulator.evaluateAndApply(candidate("irrigate", "soil_moisture"), plan("irrigate", "soil_moisture", 0.25));
  assert.ok(result);
  assert.equal(result.state_after?.soil_moisture, 0.25);
});

test("missing calibration model falls back to the generic simulator", () => {
  const simulator = new FieldSimulator(mockData("F2", 1, 0.17), {}, "F2", mockCalibration());
  const result = simulator.evaluateAndApply(candidate("irrigate", "soil_moisture"), plan("irrigate", "soil_moisture", 0.25));
  assert.ok(result);
  assert.equal(result.state_after?.soil_moisture, 0.25);
});

test("residuals cannot move unit-interval states outside [0, 1]", () => {
  const calibration = mockCalibration({
    metadata: {
      ...mockCalibration().metadata,
      support: {
        irrigate: { all: 100, by_crop: {}, by_field_crop: {} },
      },
    },
    irrigation: { kind: "constant", value: 2 },
  });
  const simulator = new FieldSimulator(mockData("F2", 1, 0.17), {}, "F2", calibration);
  const result = simulator.evaluateAndApply(candidate("irrigate", "soil_moisture"), plan("irrigate", "soil_moisture", 0.25));
  assert.ok(result);
  assert.equal(result.state_after?.soil_moisture, 1);
});

test("optimiser still generates field options with personalisation disabled", () => {
  const options = generateFieldOptions();
  const fields = new Set(options.map((option) => option.field_id));
  assert.ok(options.length > 0);
  assert.deepEqual([...fields].sort(), ["F1", "F2", "F3", "F4", "F5", "F6", "F7"]);
});
