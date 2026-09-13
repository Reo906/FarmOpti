import { clip } from "../numeric";
import {
  genericFertiliseYieldEffect,
  genericIrrigateYieldEffect,
  genericNextMoisture,
  genericNextNitrogen,
  genericNextPressure,
  genericSprayYieldEffect,
  sprayPressureKey,
} from "../genericTransitions";

/**
 * A standalone mirror of FieldSimulator's per-operation transitions, used
 * only to replay historical events into training examples (what would the
 * generic model have predicted here, so the calibration model can learn the
 * residual against what actually happened). Reuses the exact same formulas
 * from genericTransitions.ts as the live simulator and the offline training
 * side both depend on -- this file only adds the state-machine wiring
 * (which fields change for which operation) that FieldSimulator normally
 * provides via its CSV-backed state.
 */
export interface ReplayState {
  crop: string;
  growth_stage: string;
  soil_moisture: number;
  nitrogen_index: number;
  weed_pressure: number;
  pest_pressure: number;
  disease_pressure: number;
  expected_yield_t_ha: number;
  seedbed_readiness: number;
  soil_temperature_c: number;
  planted: boolean;
  harvested: boolean;
}

function num(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function defaultFertiliserAmount(config: any): number {
  return num(config?.operations?.fertilise?.response?.response_scale_kg_per_ha, 60.0);
}

export function irrigateTarget(config: any): number {
  return num(config?.operations?.irrigate?.response?.default_target_soil_moisture, 0.25);
}

export function applyGenericOperation(
  state: ReplayState,
  operation: string,
  row: Record<string, string>,
  config: any,
): ReplayState {
  const next: ReplayState = { ...state };
  const operations = config?.operations ?? {};
  const cropParams = config?.crop_parameters ?? {};
  const op = operation.toLowerCase();

  if (op === "plant") {
    const crop = String(row.next_crop || row.crop || "").trim().toLowerCase();
    next.crop = crop;
    next.planted = true;
    next.growth_stage = "planted";

    const seedbed = num(state.seedbed_readiness, 0.8);
    const moisture = num(state.soil_moisture, 0.0);
    const temperature = num(state.soil_temperature_c, 16.0);
    const response = operations.plant?.response ?? {};
    const idealMoisture = num(response.ideal_soil_moisture, 0.24);
    const tolerance = num(response.soil_moisture_tolerance, 0.1);
    const idealTemperature = num(response.ideal_soil_temperature_c, 18.0);

    const moistureScore = clip(1.0 - Math.abs(moisture - idealMoisture) / tolerance, 0.0, 1.0);
    const temperatureScore = Math.min(1.0, temperature / idealTemperature);
    const suitability = clip(seedbed * moistureScore * temperatureScore, 0.0, 1.0);
    const potential = num(cropParams[crop]?.potential_yield_t_per_ha, 0.0);
    next.expected_yield_t_ha = potential * suitability;
    return next;
  }

  if (op === "irrigate") {
    const response = operations.irrigate?.response ?? {};
    const target = irrigateTarget(config);
    const moisture = num(state.soil_moisture);
    const generic = genericNextMoisture(moisture, target);
    next.soil_moisture = generic === null ? moisture : generic;

    let expected = num(state.expected_yield_t_ha);
    if (expected <= 0) {
      const crop = String(state.crop || "").trim().toLowerCase();
      expected = num(cropParams[crop]?.potential_yield_t_per_ha, 0.0);
    }
    next.expected_yield_t_ha =
      expected + genericIrrigateYieldEffect(moisture, target, expected, num(response.max_yield_loss_fraction, 0.2));
    return next;
  }

  if (op === "fertilise") {
    const response = operations.fertilise?.response ?? {};
    const currentN = num(state.nitrogen_index);
    const targetN = num(response.target_nitrogen_index, 0.75);
    const amount = defaultFertiliserAmount(config);
    const responseScale = num(response.response_scale_kg_per_ha, 60.0);
    const generic = genericNextNitrogen(currentN, targetN, amount, responseScale);
    next.nitrogen_index = generic === null ? currentN : generic;

    const expected = num(state.expected_yield_t_ha);
    next.expected_yield_t_ha =
      expected + genericFertiliseYieldEffect(currentN, targetN, amount, expected, num(response.max_yield_gain_fraction, 0.18), responseScale);
    return next;
  }

  if (op === "spray") {
    const response = operations.spray?.response ?? {};
    const pressureKey = sprayPressureKey(row.spray_target);
    if (pressureKey === null) return next;

    const pressure = Math.max(0.0, num((state as any)[pressureKey], 0.0));
    const efficacy = num(response.efficacy, 0.9);
    const generic = genericNextPressure(pressure, efficacy);
    (next as any)[pressureKey] = generic === null ? pressure : generic;

    const expected = num(state.expected_yield_t_ha);
    next.expected_yield_t_ha = expected + genericSprayYieldEffect(pressure, expected, num(response.max_yield_loss_fraction, 0.25), efficacy);
    return next;
  }

  if (op === "harvest") {
    next.crop = "";
    next.planted = false;
    next.harvested = true;
    next.expected_yield_t_ha = 0.0;
    return next;
  }

  return next;
}
