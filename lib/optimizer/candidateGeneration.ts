import { CANDIDATE_CONFIG, CROP_PARAMETERS, RULES } from "./config";
import {
  getEconomicValue,
  getField,
  getFieldState,
  getLabourForDay,
  getMachineCostPerHour,
  loadExternalVariables,
} from "./externalVariables";
import {
  addDays,
  addHours,
  compareDateOnly,
  formatIso,
} from "./datetime";
import { pyRound, clip } from "./numeric";
import { EXTERNAL_DIR } from "./paths";
import type { ActionResult, Candidate, ExternalVariables, FieldRow, FieldStateRow, ManagementPlanRow, WeatherRow } from "./types";
import {
  actionDayWindow,
  dailyWaterOk,
  machinesAvailableInWindow,
  machinesAvailableOnDay,
  packWorkload,
  requiredWorkloadHours,
  weatherForSegments,
} from "./workload";

function calculateExecutionCost(
  data: ExternalVariables,
  rule: any,
  start: number,
  duration: number,
  machineIds: string[],
): number {
  const machineCost = duration * getMachineCostPerHour(data, machineIds);
  const startDate = formatIso(start).slice(0, 10);
  const labourRate = getEconomicValue(data, startDate, "labour_cost", "worker");
  const labourCost = duration * Number(rule.workers) * labourRate;
  return machineCost + labourCost;
}

function makeResult(
  directRevenue: number,
  directCost: number,
  stateYieldEffect = 0.0,
  waterMl = 0.0,
  candidateScore = 0.0,
): ActionResult {
  return {
    direct_revenue_aud: pyRound(directRevenue, 2),
    direct_cost_aud: pyRound(directCost, 2),
    direct_cash_effect_aud: pyRound(directRevenue - directCost, 2),
    state_yield_effect_t_ha: pyRound(stateYieldEffect, 4),
    water_ml: pyRound(waterMl, 3),
    candidate_score: pyRound(candidateScore, 6),
  };
}

type Evaluator = (
  data: ExternalVariables,
  plan: ManagementPlanRow,
  field: FieldRow,
  state: FieldStateRow,
  weather: WeatherRow[],
  start: number,
  duration: number,
  machineIds: string[],
) => ActionResult | null;

function maxOf(rows: WeatherRow[], key: "rain_mm" | "wind_kmh"): number {
  return rows.reduce((m, r) => Math.max(m, r[key]), -Infinity);
}

const evaluateHarvest: Evaluator = (data, _plan, field, state, weather, start, duration, machineIds) => {
  const rule = RULES.harvest;
  const feasibility = rule.feasibility;

  if (state.readiness < feasibility.min_readiness) return null;
  if (weather.length === 0 || maxOf(weather, "rain_mm") > feasibility.max_rain_mm_per_hour || maxOf(weather, "wind_kmh") > feasibility.max_wind_kmh) {
    return null;
  }

  const area = field.area_ha;
  const crop = getEffectiveCropLocal(field);
  const expectedYield = state.expected_yield_t_ha;
  const startDate = formatIso(start).slice(0, 10);
  const price = getEconomicValue(data, startDate, "crop_price", crop);
  const revenue = area * expectedYield * price;
  const cost = calculateExecutionCost(data, rule, start, duration, machineIds);
  return makeResult(revenue, cost, 0.0, 0.0, revenue - cost);
};

const evaluateIrrigation: Evaluator = (data, plan, field, state, weather, start, duration, machineIds) => {
  const rule = RULES.irrigate;
  const response = rule.response;

  if (field.irrigable !== 1) return null;
  if (weather.length === 0 || maxOf(weather, "rain_mm") > rule.feasibility.max_rain_mm_per_hour) return null;

  const target = plan.amount !== null ? plan.amount : Number(response.default_target_soil_moisture);
  const current = state.soil_moisture;
  if (current >= target) return null;

  const area = field.area_ha;
  const crop = getEffectiveCropLocal(field);
  let expectedYield = state.expected_yield_t_ha;
  if (expectedYield <= 0 && crop in CROP_PARAMETERS) {
    expectedYield = Number(CROP_PARAMETERS[crop].potential_yield_t_per_ha);
  }

  const deficit = clip((target - current) / target, 0.0, 1.0);
  const yieldEffect = expectedYield * deficit * response.max_yield_loss_fraction;
  const waterMl = area * response.water_ml_per_ha;

  const startDate = formatIso(start).slice(0, 10);
  const waterRow = data.water.find((w) => w.date === startDate);
  if (!waterRow) return null;

  const waterPrice = getEconomicValue(data, startDate, "water_cost", "irrigation_water");
  const cost = calculateExecutionCost(data, rule, start, duration, machineIds) + waterMl * waterPrice;
  return makeResult(0.0, cost, yieldEffect, waterMl, yieldEffect);
};

const evaluateSpray: Evaluator = (data, plan, field, state, weather, start, duration, machineIds) => {
  const rule = RULES.spray;
  const response = rule.response;
  const feasibility = rule.feasibility;

  if (weather.length === 0 || maxOf(weather, "rain_mm") > feasibility.max_rain_mm_per_hour || maxOf(weather, "wind_kmh") > feasibility.max_wind_kmh) {
    return null;
  }

  const target = plan.target;
  const targetCfg = response.targets[target];
  if (!targetCfg) throw new Error(`Unknown spray target: ${target}`);

  const pressure = (state as any)[targetCfg.state_variable] as number;
  if (pressure <= 0) return null;

  const area = field.area_ha;
  const expectedYield = state.expected_yield_t_ha;
  const yieldEffect = expectedYield * pressure * response.max_yield_loss_fraction * response.efficacy;

  const startDate = formatIso(start).slice(0, 10);
  const chemicalPrice = getEconomicValue(data, startDate, "input_cost", targetCfg.chemical);
  const chemicalCost = area * response.chemical_l_per_ha * chemicalPrice;
  const cost = calculateExecutionCost(data, rule, start, duration, machineIds) + chemicalCost;
  return makeResult(0.0, cost, yieldEffect, 0.0, yieldEffect);
};

const evaluateFertiliser: Evaluator = (data, plan, field, state, weather, start, duration, machineIds) => {
  const rule = RULES.fertilise;
  const response = rule.response;
  const feasibility = rule.feasibility;

  if (weather.length === 0 || maxOf(weather, "rain_mm") > feasibility.max_rain_mm_per_hour || maxOf(weather, "wind_kmh") > feasibility.max_wind_kmh) {
    return null;
  }

  const currentN = state.nitrogen_index;
  const targetN = Number(response.target_nitrogen_index);
  if (currentN >= targetN) return null;
  if (plan.amount === null) throw new Error("Fertilisation requires an amount");

  const amount = plan.amount;
  const deficit = clip((targetN - currentN) / targetN, 0.0, 1.0);
  const doseResponse = 1.0 - Math.exp(-amount / Number(response.response_scale_kg_per_ha));
  const expectedYield = state.expected_yield_t_ha;
  const yieldEffect = expectedYield * deficit * response.max_yield_gain_fraction * doseResponse;

  const area = field.area_ha;
  const startDate = formatIso(start).slice(0, 10);
  const fertiliserPrice = getEconomicValue(data, startDate, "input_cost", response.fertiliser_item);
  const fertiliserCost = amount * area * fertiliserPrice;
  const cost = calculateExecutionCost(data, rule, start, duration, machineIds) + fertiliserCost;
  return makeResult(0.0, cost, yieldEffect, 0.0, yieldEffect);
};

const evaluatePlanting: Evaluator = (data, plan, field, state, weather, start, duration, machineIds) => {
  const rule = RULES.plant;
  const response = rule.response;
  const feasibility = rule.feasibility;

  if (weather.length === 0 || maxOf(weather, "rain_mm") > feasibility.max_rain_mm_per_hour || maxOf(weather, "wind_kmh") > feasibility.max_wind_kmh) {
    return null;
  }
  if (state.seedbed_readiness < feasibility.min_seedbed_readiness || state.soil_temperature_c < feasibility.min_soil_temperature_c) {
    return null;
  }

  const crop = plan.target.trim().toLowerCase();
  if (!(crop in CROP_PARAMETERS)) throw new Error(`No crop parameters configured for ${crop}`);

  const area = field.area_ha;
  const seedbed = state.seedbed_readiness;
  const moisture = state.soil_moisture;
  const temperature = state.soil_temperature_c;

  const moistureScore = clip(1.0 - Math.abs(moisture - Number(response.ideal_soil_moisture)) / Number(response.soil_moisture_tolerance), 0.0, 1.0);
  const temperatureScore = Math.min(1.0, temperature / Number(response.ideal_soil_temperature_c));
  const suitability = clip(seedbed * moistureScore * temperatureScore, 0.0, 1.0);
  const projectedYield = Number(CROP_PARAMETERS[crop].potential_yield_t_per_ha) * suitability;

  const startDate = formatIso(start).slice(0, 10);
  const seedPrice = getEconomicValue(data, startDate, "input_cost", `${crop}_seed`);
  const seedCost = area * response.seed_rate_kg_per_ha * seedPrice;
  const cost = calculateExecutionCost(data, rule, start, duration, machineIds) + seedCost;
  return makeResult(0.0, cost, projectedYield, 0.0, projectedYield);
};

const EVALUATORS: Record<string, Evaluator> = {
  harvest: evaluateHarvest,
  irrigate: evaluateIrrigation,
  spray: evaluateSpray,
  fertilise: evaluateFertiliser,
  plant: evaluatePlanting,
};

// Local re-implementation to avoid a circular import with externalVariables.ts's getEffectiveCrop.
function getEffectiveCropLocal(field: FieldRow): string {
  const current = field.current_crop.trim().toLowerCase();
  if (current !== "" && current !== "none" && current !== "nan") return current;
  const planned = field.planned_crop.trim().toLowerCase();
  if (planned !== "" && planned !== "none" && planned !== "nan") return planned;
  throw new Error(`Field ${field.field_id} has no current or planned crop`);
}

function candidateIdTimestamp(ts: number): string {
  const iso = formatIso(ts); // YYYY-MM-DDTHH:MM:SS
  const [datePart, timePart] = iso.split("T");
  return `${datePart.replace(/-/g, "")}_${timePart.slice(0, 2)}${timePart.slice(3, 5)}`;
}

export function generateCandidates(externalVariablesDir: string = EXTERNAL_DIR): Candidate[] {
  const data = loadExternalVariables(externalVariablesDir);
  const candidates: Candidate[] = [];
  const timeStepHours = Number(CANDIDATE_CONFIG.time_step_hours);

  for (const plan of data.management) {
    const operation = plan.operation.toLowerCase();
    if (!(operation in RULES)) throw new Error(`Unsupported operation: ${operation}`);

    const field = getField(data, plan.field_id);
    const rule = RULES[operation];
    const workload = requiredWorkloadHours(field.area_ha, Number(rule.work_rate_ha_per_hour));
    let currentDate = plan.allowed_from;

    while (compareDateOnly(currentDate, plan.allowed_to) <= 0) {
      const state = getFieldState(data, plan.field_id, currentDate);
      const labour = getLabourForDay(data, currentDate);

      if (!state || !labour || labour.available_workers < Number(rule.workers)) {
        currentDate = addDays(currentDate, 1);
        continue;
      }

      const dayMachines = machinesAvailableOnDay(data, rule.machine_type, currentDate);
      const dayWindow = actionDayWindow(data, currentDate, dayMachines);
      if (!dayWindow) {
        currentDate = addDays(currentDate, 1);
        continue;
      }

      let start = dayWindow.start;

      while (start < dayWindow.end) {
        const segments = packWorkload(data, operation, rule.machine_type, workload, start, plan.allowed_to);
        if (!segments || segments.length === 0) {
          start = addHours(start, timeStepHours);
          continue;
        }

        const first = segments[0];
        const last = segments[segments.length - 1];
        const firstMachines = machinesAvailableInWindow(
          data,
          rule.machine_type,
          first.start_time,
          first.end_time,
          currentDate,
        );
        const machineIds = [...new Set([
          ...firstMachines,
          ...segments.flatMap((segment) => machinesAvailableOnDay(data, rule.machine_type, segment.date)),
        ])];

        if (firstMachines.length > 0) {
          const weather = weatherForSegments(data, segments);
          if (weather.length > 0) {
            const waterMl = operation === "irrigate"
              ? field.area_ha * Number(rule.response.water_ml_per_ha)
              : 0;
            const waterFeasible = operation !== "irrigate" || dailyWaterOk(data, segments, waterMl, workload);
            const actionResult = waterFeasible
              ? EVALUATORS[operation](data, plan, field, state, weather, start, workload, firstMachines)
              : null;
            if (actionResult !== null) {
              candidates.push({
                candidate_id: `${plan.plan_id}_${plan.field_id}_${operation}_${candidateIdTimestamp(start)}`,
                plan_id: plan.plan_id,
                field_id: plan.field_id,
                operation,
                target: plan.target,
                required: plan.required,
                depends_on: plan.depends_on,
                min_gap_hours: plan.min_gap_hours ?? 0.0,
                start_time: first.start_time,
                end_time: last.end_time,
                duration_hours: pyRound(workload, 2),
                workload_hours: pyRound(workload, 4),
                machine_type: rule.machine_type,
                eligible_machine_ids: machineIds.length > 0 ? machineIds : firstMachines,
                workers_required: Number(rule.workers),
                work_segments: segments.map((segment) => ({
                  ...segment,
                  work_hours: pyRound(segment.work_hours, 4),
                })),
                ...actionResult,
              });
            }
          }
        }

        start = addHours(start, timeStepHours);
      }

      currentDate = addDays(currentDate, 1);
    }
  }

  candidates.sort((a, b) => {
    if (a.plan_id !== b.plan_id) return a.plan_id < b.plan_id ? -1 : 1;
    return a.start_time - b.start_time;
  });

  return candidates;
}
