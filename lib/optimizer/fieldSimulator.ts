import { loadFarmCalibration, personalisedUnit, personalisedYieldValue, predictResidual } from "./calibration";
import type { FarmCalibration } from "./calibration";
import { CROP_PARAMETERS, RULES } from "./config";
import { getEconomicValue, getField } from "./externalVariables";
import { dateOnlyOf } from "./datetime";
import {
  genericFertiliseYieldEffect,
  genericIrrigateYieldEffect,
  genericNextMoisture,
  genericNextNitrogen,
  genericNextPressure,
  genericSprayYieldEffect,
  normalizeSprayTarget,
  sprayPressureKey,
} from "./genericTransitions";
import { clip, pyRound } from "./numeric";
import type { Candidate, ExternalVariables, FieldRow, FieldStateSnapshot, ManagementPlanRow, OptionAction } from "./types";

export const TRACKED_STATE = [
  "readiness",
  "soil_moisture",
  "soil_temperature_c",
  "expected_yield_t_ha",
  "nitrogen_index",
  "weed_pressure",
  "pest_pressure",
  "disease_pressure",
  "seedbed_readiness",
] as const;

type TrackedKey = (typeof TRACKED_STATE)[number];

interface BaselineRow {
  date: string;
  growth_stage: string;
  [key: string]: string | number;
}

export interface SimResult {
  direct_revenue_aud: number;
  direct_cost_aud: number;
  direct_cash_effect_aud: number;
  state_yield_effect_t_ha: number;
  water_ml: number;
  state_after?: FieldStateSnapshot;
}

export class FieldSimulator {
  private data: ExternalVariables;
  private config: any;
  fieldId: string;
  private field: FieldRow;
  private baseline: BaselineRow[];

  currentCrop: string | null;
  plannedCrop: string;
  planted: boolean;
  newlyPlanted = false;
  harvested = false;
  private currentDate: string | null = null;
  private state: Record<string, number | string> = {};
  private residuals: Record<TrackedKey, number>;
  private decay: Record<string, number>;
  private calibration: FarmCalibration | null;

  constructor(data: ExternalVariables, config: any, fieldId: string, calibration?: FarmCalibration | null) {
    this.data = data;
    this.config = config;
    this.fieldId = fieldId;
    this.calibration = calibration === undefined ? loadFarmCalibration(config) : calibration;
    this.field = getField(data, fieldId);
    this.baseline = data.state
      .filter((s) => s.field_id === fieldId)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) as unknown as BaselineRow[];

    if (this.baseline.length === 0) throw new Error(`No field-state forecast for ${fieldId}`);

    const current = this.field.current_crop.trim().toLowerCase();
    this.currentCrop = current === "" || current === "none" || current === "nan" ? null : current;
    this.plannedCrop = this.field.planned_crop.trim().toLowerCase();
    this.planted = this.currentCrop !== null;

    this.residuals = Object.fromEntries(TRACKED_STATE.map((k) => [k, 0.0])) as Record<TrackedKey, number>;
    this.decay = config?.state_simulation?.residual_decay_per_day ?? {};
  }

  private baselineFor(date: string): BaselineRow {
    const row = this.baseline.find((b) => b.date === date);
    if (!row) throw new Error(`No baseline state for ${this.fieldId} on ${date}`);
    return row;
  }

  advanceTo(timestamp: number): void {
    const date = dateOnlyOf(timestamp);
    const baseline = this.baselineFor(date);

    if (this.currentDate === null) {
      for (const key of TRACKED_STATE) this.state[key] = Number(baseline[key]);
      this.state.growth_stage = String(baseline.growth_stage);
      this.currentDate = date;
      return;
    }

    if (date === this.currentDate) {
      return;
    }

    const days = daysBetween(this.currentDate, date);
    if (days < 0) throw new Error("FieldSimulator cannot move backward in time");

    for (const key of TRACKED_STATE) {
      const factor = Math.pow(Number(this.decay[key] ?? 1.0), days);
      this.residuals[key] *= factor;
      this.state[key] = Number(baseline[key]) + this.residuals[key];
    }

    this.state.growth_stage = this.newlyPlanted ? "planted" : String(baseline.growth_stage);
    this.currentDate = date;
  }

  private setState(key: TrackedKey, value: number): void {
    const baseline = this.baselineFor(this.currentDate!);
    this.state[key] = value;
    this.residuals[key] = value - Number(baseline[key]);
  }

  private potentialYield(): number {
    if (this.currentCrop && this.currentCrop in CROP_PARAMETERS) {
      return Number(CROP_PARAMETERS[this.currentCrop].potential_yield_t_per_ha);
    }
    return Math.max(0.0, Number(this.state.expected_yield_t_ha ?? 0.0));
  }

  private increaseYield(delta: number): void {
    const current = Number(this.state.expected_yield_t_ha);
    const cap = this.potentialYield();
    let newValue = current + Math.max(0.0, delta);
    if (cap > 0) newValue = Math.min(cap, newValue);
    this.setState("expected_yield_t_ha", newValue);
  }

  private price(date: string, crop?: string | null): number {
    const c = crop ?? this.currentCrop;
    if (!c) throw new Error(`No crop exists on ${this.fieldId}`);
    return getEconomicValue(this.data, date, "crop_price", c);
  }

  evaluateAndApply(candidate: Candidate | OptionAction, plan: ManagementPlanRow): SimResult | null {
    const start = candidate.start_time;
    this.advanceTo(start);

    const operation = candidate.operation.toLowerCase();
    if (this.harvested) return null;
    if (operation !== "plant" && this.currentCrop === null) return null;

    const before = {
      soil_moisture: Number(this.state.soil_moisture ?? 0),
      nitrogen_index: Number(this.state.nitrogen_index ?? 0),
      weed_pressure: Number(this.state.weed_pressure ?? 0),
      pest_pressure: Number(this.state.pest_pressure ?? 0),
      disease_pressure: Number(this.state.disease_pressure ?? 0),
      growth_stage: String(this.state.growth_stage ?? ""),
    };

    let result: SimResult | null;
    switch (operation) {
      case "harvest":
        result = this.evalHarvest(candidate);
        break;
      case "irrigate":
        result = this.evalIrrigate(candidate, plan);
        break;
      case "spray":
        result = this.evalSpray(candidate, plan);
        break;
      case "fertilise":
        result = this.evalFertilise(candidate, plan);
        break;
      case "plant":
        result = this.evalPlant(candidate, plan);
        break;
      default:
        throw new Error(`Unsupported operation in simulator: ${operation}`);
    }

    if (result === null) return null;
    this.applyPersonalisation(operation, plan, before);
    result.state_after = this.snapshot();
    return result;
  }

  private cropName(): string {
    return (this.currentCrop ?? "").trim().toLowerCase();
  }

  private genericYield(): number {
    return Math.max(0.0, Number(this.state.expected_yield_t_ha ?? 0.0));
  }

  personalisedExpectedYield(): number {
    const generic = this.genericYield();
    if (!this.calibration?.yield || this.harvested || !this.currentCrop) return generic;
    return personalisedYieldValue(
      this.calibration,
      this.fieldId,
      this.cropName(),
      {
        field_id: this.fieldId,
        crop: this.cropName(),
        growth_stage: String(this.state.growth_stage ?? ""),
        soil_moisture: Number(this.state.soil_moisture ?? 0),
        nitrogen_index: Number(this.state.nitrogen_index ?? 0),
        weed_pressure: Number(this.state.weed_pressure ?? 0),
        pest_pressure: Number(this.state.pest_pressure ?? 0),
        disease_pressure: Number(this.state.disease_pressure ?? 0),
        generic_expected_yield_t_ha: generic,
      },
      generic,
    );
  }

  private applyPersonalisation(
    operation: string,
    plan: ManagementPlanRow,
    before: {
      soil_moisture: number;
      nitrogen_index: number;
      weed_pressure: number;
      pest_pressure: number;
      disease_pressure: number;
      growth_stage: string;
    },
  ): void {
    if (!this.calibration) return;
    const crop = this.cropName();

    if (operation === "irrigate") {
      if (this.field.irrigable !== 1 || !this.calibration.irrigation) return;
      const generic = Number(this.state.soil_moisture);
      const residual = predictResidual(this.calibration.irrigation, {
        field_id: this.fieldId,
        crop,
        growth_stage: before.growth_stage,
        soil_moisture: before.soil_moisture,
        generic_next_soil_moisture: generic,
      });
      this.setState("soil_moisture", personalisedUnit(this.calibration, "irrigate", this.fieldId, crop, generic, residual));
      return;
    }

    if (operation === "fertilise") {
      if (!this.calibration.fertiliser) return;
      const generic = Number(this.state.nitrogen_index);
      const residual = predictResidual(this.calibration.fertiliser, {
        field_id: this.fieldId,
        crop,
        growth_stage: before.growth_stage,
        nitrogen_index: before.nitrogen_index,
        generic_next_nitrogen_index: generic,
      });
      this.setState("nitrogen_index", personalisedUnit(this.calibration, "fertilise", this.fieldId, crop, generic, residual));
      return;
    }

    if (operation === "spray") {
      if (!this.calibration.spray) return;
      const pressureKey = sprayPressureKey(plan.target);
      if (!pressureKey) return;
      const generic = Math.max(0.0, Number(this.state[pressureKey]));
      const residual = predictResidual(this.calibration.spray, {
        field_id: this.fieldId,
        crop,
        growth_stage: before.growth_stage,
        spray_target: normalizeSprayTarget(plan.target).replace("_control", ""),
        current_target_pressure: Number(before[pressureKey] ?? 0),
        generic_next_target_pressure: generic,
      });
      this.setState(pressureKey, personalisedUnit(this.calibration, "spray", this.fieldId, crop, generic, residual));
    }
  }

  private evalHarvest(candidate: Candidate | OptionAction): SimResult | null {
    const rule = RULES.harvest;
    if (Number(this.state.readiness) < Number(rule.feasibility.min_readiness)) return null;

    const area = this.field.area_ha;
    const expectedYield = this.personalisedExpectedYield();
    const revenue = area * expectedYield * this.price(this.currentDate!);
    const cost = candidate.direct_cost_aud;

    this.harvested = true;
    this.planted = false;
    this.currentCrop = null;
    this.setState("expected_yield_t_ha", 0.0);

    return this.result(revenue, cost, 0.0);
  }

  private evalIrrigate(candidate: Candidate | OptionAction, plan: ManagementPlanRow): SimResult | null {
    const response = RULES.irrigate.response;
    const target = plan.amount !== null ? plan.amount : Number(response.default_target_soil_moisture);
    const moisture = Number(this.state.soil_moisture);
    const nextMoisture = genericNextMoisture(moisture, target);
    if (nextMoisture === null) return null;

    let expectedYield = Number(this.state.expected_yield_t_ha);
    if (expectedYield <= 0) expectedYield = this.potentialYield();

    const yieldEffect = genericIrrigateYieldEffect(
      moisture,
      target,
      expectedYield,
      Number(response.max_yield_loss_fraction),
    );
    const cost = candidate.direct_cost_aud;

    this.setState("soil_moisture", nextMoisture);
    this.increaseYield(yieldEffect);

    return this.result(0.0, cost, yieldEffect, Number((candidate as any).water_ml ?? 0.0));
  }

  private evalSpray(candidate: Candidate | OptionAction, plan: ManagementPlanRow): SimResult | null {
    const response = RULES.spray.response;
    const target = plan.target;
    const targetCfg = response.targets[target];
    if (!targetCfg) throw new Error(`Unknown spray target: ${target}`);

    const pressureKey = targetCfg.state_variable as TrackedKey;
    const pressure = Math.max(0.0, Number(this.state[pressureKey]));
    const nextPressure = genericNextPressure(pressure, Number(response.efficacy));
    if (nextPressure === null) return null;

    const expectedYield = Number(this.state.expected_yield_t_ha);
    const yieldEffect = genericSprayYieldEffect(
      pressure,
      expectedYield,
      Number(response.max_yield_loss_fraction),
      Number(response.efficacy),
    );
    const cost = candidate.direct_cost_aud;

    this.setState(pressureKey, nextPressure);
    this.increaseYield(yieldEffect);

    return this.result(0.0, cost, yieldEffect);
  }

  private evalFertilise(candidate: Candidate | OptionAction, plan: ManagementPlanRow): SimResult | null {
    const response = RULES.fertilise.response;
    const currentN = Number(this.state.nitrogen_index);
    const targetN = Number(response.target_nitrogen_index);

    if (plan.amount === null) return null;
    const amount = plan.amount;
    const nextN = genericNextNitrogen(currentN, targetN, amount, Number(response.response_scale_kg_per_ha));
    if (nextN === null) return null;

    const expectedYield = Number(this.state.expected_yield_t_ha);
    const yieldEffect = genericFertiliseYieldEffect(
      currentN,
      targetN,
      amount,
      expectedYield,
      Number(response.max_yield_gain_fraction),
      Number(response.response_scale_kg_per_ha),
    );
    const cost = candidate.direct_cost_aud;

    this.setState("nitrogen_index", nextN);
    this.increaseYield(yieldEffect);

    return this.result(0.0, cost, yieldEffect);
  }

  private evalPlant(candidate: Candidate | OptionAction, plan: ManagementPlanRow): SimResult | null {
    if (this.currentCrop !== null || this.planted) return null;

    const rule = RULES.plant;
    const response = rule.response;
    const crop = plan.target.trim().toLowerCase();

    if (!(crop in CROP_PARAMETERS)) return null;

    const seedbed = Number(this.state.seedbed_readiness);
    const moisture = Number(this.state.soil_moisture);
    const temperature = Number(this.state.soil_temperature_c);

    if (seedbed < Number(rule.feasibility.min_seedbed_readiness)) return null;
    if (temperature < Number(rule.feasibility.min_soil_temperature_c)) return null;

    const idealMoisture = Number(response.ideal_soil_moisture);
    const tolerance = Number(response.soil_moisture_tolerance);
    const idealTemperature = Number(response.ideal_soil_temperature_c);
    const moistureScore = clip(1.0 - Math.abs(moisture - idealMoisture) / tolerance, 0.0, 1.0);
    const temperatureScore = Math.min(1.0, temperature / idealTemperature);
    const suitability = clip(seedbed * moistureScore * temperatureScore, 0.0, 1.0);
    const expectedYield = Number(CROP_PARAMETERS[crop].potential_yield_t_per_ha) * suitability;
    const cost = candidate.direct_cost_aud;

    this.currentCrop = crop;
    this.planted = true;
    this.newlyPlanted = true;
    this.state.growth_stage = "planted";
    this.setState("expected_yield_t_ha", expectedYield);

    return this.result(0.0, cost, expectedYield);
  }

  terminalValue(timestamp: number): number {
    this.advanceTo(timestamp);

    if (this.harvested || this.currentCrop === null) return 0.0;

    const area = this.field.area_ha;
    const expectedYield = this.personalisedExpectedYield();
    let value = area * expectedYield * this.price(this.currentDate!);

    if (this.newlyPlanted) {
      const remainingCost = Number(this.config?.terminal_value?.newly_planted_remaining_variable_cost_per_ha ?? 0.0);
      value -= area * remainingCost;
    }

    return pyRound(value, 2);
  }

  private result(revenue: number, cost: number, yieldEffect = 0.0, waterMl = 0.0): SimResult {
    return {
      direct_revenue_aud: pyRound(revenue, 2),
      direct_cost_aud: pyRound(cost, 2),
      direct_cash_effect_aud: pyRound(revenue - cost, 2),
      state_yield_effect_t_ha: pyRound(yieldEffect, 4),
      water_ml: pyRound(waterMl, 3),
    };
  }

  snapshot(): FieldStateSnapshot {
    const out: any = {
      crop: this.currentCrop ?? "",
      planted: this.planted,
      newly_planted: this.newlyPlanted,
      harvested: this.harvested,
      growth_stage: this.state.growth_stage ?? "",
    };
    for (const key of TRACKED_STATE) {
      out[key] = pyRound(Number(this.state[key] ?? 0.0), 4);
    }
    out.expected_yield_t_ha = pyRound(this.personalisedExpectedYield(), 4);
    return out as FieldStateSnapshot;
  }
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const msPerDay = 86_400_000;
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / msPerDay);
}
