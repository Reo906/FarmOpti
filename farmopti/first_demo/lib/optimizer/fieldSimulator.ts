import { CROP_PARAMETERS, RULES } from "./config";
import { getEconomicValue, getField } from "./externalVariables";
import { dateOnlyOf, formatIso } from "./datetime";
import { pyRound, clip } from "./numeric";
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

  constructor(data: ExternalVariables, config: any, fieldId: string) {
    this.data = data;
    this.config = config;
    this.fieldId = fieldId;
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
    result.state_after = this.snapshot();
    return result;
  }

  private evalHarvest(candidate: Candidate | OptionAction): SimResult | null {
    const rule = RULES.harvest;
    if (Number(this.state.readiness) < Number(rule.feasibility.min_readiness)) return null;

    const area = this.field.area_ha;
    const expectedYield = Math.max(0.0, Number(this.state.expected_yield_t_ha));
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

    if (moisture >= target) return null;

    let expectedYield = Number(this.state.expected_yield_t_ha);
    if (expectedYield <= 0) expectedYield = this.potentialYield();

    const deficit = clip((target - moisture) / target, 0.0, 1.0);
    const yieldEffect = expectedYield * deficit * Number(response.max_yield_loss_fraction);
    const cost = candidate.direct_cost_aud;

    this.setState("soil_moisture", Math.max(moisture, target));
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
    if (pressure <= 0) return null;

    const expectedYield = Number(this.state.expected_yield_t_ha);
    const yieldEffect = expectedYield * pressure * Number(response.max_yield_loss_fraction) * Number(response.efficacy);
    const cost = candidate.direct_cost_aud;

    this.setState(pressureKey, pressure * (1.0 - Number(response.efficacy)));
    this.increaseYield(yieldEffect);

    return this.result(0.0, cost, yieldEffect);
  }

  private evalFertilise(candidate: Candidate | OptionAction, plan: ManagementPlanRow): SimResult | null {
    const response = RULES.fertilise.response;
    const currentN = Number(this.state.nitrogen_index);
    const targetN = Number(response.target_nitrogen_index);

    if (currentN >= targetN || plan.amount === null) return null;

    const amount = plan.amount;
    const deficit = clip((targetN - currentN) / targetN, 0.0, 1.0);
    const doseResponse = 1.0 - Math.exp(-amount / Number(response.response_scale_kg_per_ha));
    const expectedYield = Number(this.state.expected_yield_t_ha);
    const yieldEffect = expectedYield * deficit * Number(response.max_yield_gain_fraction) * doseResponse;
    const cost = candidate.direct_cost_aud;

    const newN = currentN + (targetN - currentN) * doseResponse;
    this.setState("nitrogen_index", Math.min(1.0, newN));
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
    const expectedYield = Math.max(0.0, Number(this.state.expected_yield_t_ha));
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
    return out as FieldStateSnapshot;
  }
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const msPerDay = 86_400_000;
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / msPerDay);
}
