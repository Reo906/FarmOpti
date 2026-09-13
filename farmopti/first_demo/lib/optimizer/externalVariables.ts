import path from "node:path";
import { boolFrom01, num, numOrNull, readCsv, strOrEmpty } from "./csv";
import { combineDateAndTime, parseDateOnly, parseTimestamp } from "./datetime";
import { EXTERNAL_DIR } from "./paths";
import type {
  EconomicsRow,
  ExternalVariables,
  FieldRow,
  FieldStateRow,
  LabourRow,
  MachineAvailabilityRow,
  MachineRow,
  ManagementPlanRow,
  WaterRow,
  WeatherRow,
} from "./types";

export function loadExternalVariables(folder: string = EXTERNAL_DIR): ExternalVariables {
  const fields: FieldRow[] = readCsv(path.join(folder, "fields.csv")).map((r) => ({
    field_id: r.field_id,
    area_ha: num(r.area_ha),
    current_crop: strOrEmpty(r.current_crop),
    planned_crop: strOrEmpty(r.planned_crop),
    irrigable: num(r.irrigable),
    x_km: num(r.x_km),
    y_km: num(r.y_km),
  }));

  const state: FieldStateRow[] = readCsv(path.join(folder, "field_state_daily.csv")).map((r) => ({
    date: parseDateOnly(r.date),
    field_id: r.field_id,
    growth_stage: strOrEmpty(r.growth_stage),
    readiness: num(r.readiness),
    soil_moisture: num(r.soil_moisture),
    soil_temperature_c: num(r.soil_temperature_c),
    expected_yield_t_ha: num(r.expected_yield_t_ha),
    nitrogen_index: num(r.nitrogen_index),
    weed_pressure: num(r.weed_pressure),
    pest_pressure: num(r.pest_pressure),
    disease_pressure: num(r.disease_pressure),
    seedbed_readiness: num(r.seedbed_readiness),
  }));

  const weather: WeatherRow[] = readCsv(path.join(folder, "weather_hourly.csv")).map((r) => ({
    time: parseTimestamp(r.time),
    temperature_c: num(r.temperature_c),
    wind_kmh: num(r.wind_kmh),
    rain_mm: num(r.rain_mm),
  }));

  const labour: LabourRow[] = readCsv(path.join(folder, "labour_availability_daily.csv")).map((r) => ({
    date: parseDateOnly(r.date),
    available_workers: num(r.available_workers),
    workday_start: r.workday_start,
    workday_end: r.workday_end,
  }));

  const machines: MachineRow[] = readCsv(path.join(folder, "machines.csv")).map((r) => ({
    machine_id: r.machine_id,
    machine_type: r.machine_type,
    cost_per_hour_aud: num(r.cost_per_hour_aud),
    current_field: strOrEmpty(r.current_field),
  }));

  const machineAvailability: MachineAvailabilityRow[] = readCsv(
    path.join(folder, "machine_availability_daily.csv"),
  ).map((r) => ({
    date: parseDateOnly(r.date),
    machine_id: r.machine_id,
    available: num(r.available),
    available_from: r.available_from?.trim() ? r.available_from.trim() : null,
    available_to: r.available_to?.trim() ? r.available_to.trim() : null,
  }));

  const water: WaterRow[] = readCsv(path.join(folder, "water_availability_daily.csv")).map((r) => ({
    date: parseDateOnly(r.date),
    available_water_ml: num(r.available_water_ml),
    max_delivery_ml_per_day: num(r.max_delivery_ml_per_day),
  }));

  const economics: EconomicsRow[] = readCsv(path.join(folder, "economics_daily.csv")).map((r) => ({
    date: parseDateOnly(r.date),
    variable_type: r.variable_type,
    item: r.item,
    unit: strOrEmpty(r.unit),
    value: num(r.value),
  }));

  const management: ManagementPlanRow[] = readCsv(path.join(folder, "management_plan.csv")).map((r) => ({
    plan_id: r.plan_id,
    field_id: r.field_id,
    operation: r.operation,
    target: strOrEmpty(r.target),
    amount: numOrNull(r.amount),
    unit: strOrEmpty(r.unit),
    allowed_from: parseDateOnly(r.allowed_from),
    allowed_to: parseDateOnly(r.allowed_to),
    required: boolFrom01(r.required),
    depends_on: strOrEmpty(r.depends_on),
    min_gap_hours: numOrNull(r.min_gap_hours),
  }));

  return { fields, state, weather, labour, machines, machineAvailability, water, economics, management };
}

export function getField(data: ExternalVariables, fieldId: string): FieldRow {
  const row = data.fields.find((f) => f.field_id === fieldId);
  if (!row) throw new Error(`Unknown field: ${fieldId}`);
  return row;
}

export function getEffectiveCrop(field: FieldRow): string {
  const current = field.current_crop.trim().toLowerCase();
  if (current !== "" && current !== "none" && current !== "nan") return current;

  const planned = field.planned_crop.trim().toLowerCase();
  if (planned !== "" && planned !== "none" && planned !== "nan") return planned;

  throw new Error(`Field ${field.field_id} has no current or planned crop`);
}

export function getFieldState(data: ExternalVariables, fieldId: string, date: string): FieldStateRow | null {
  return data.state.find((s) => s.field_id === fieldId && s.date === date) ?? null;
}

export function getWeatherWindow(data: ExternalVariables, start: number, durationHours: number): WeatherRow[] {
  const end = start + durationHours * 3_600_000;
  const startFloor = Math.floor(start / 3_600_000) * 3_600_000;
  const endCeil = Math.ceil(end / 3_600_000) * 3_600_000;
  return data.weather.filter((w) => w.time >= startFloor && w.time < endCeil);
}

export function getEconomicValue(
  data: ExternalVariables,
  date: string,
  variableType: string,
  item: string,
): number {
  const row = data.economics.find(
    (e) => e.date === date && e.variable_type === variableType && e.item === item,
  );
  if (!row) throw new Error(`Missing economic value: ${variableType}/${item} on ${date}`);
  return row.value;
}

export function getLabourForDay(data: ExternalVariables, date: string): LabourRow | null {
  return data.labour.find((l) => l.date === date) ?? null;
}

export function getEligibleMachines(
  data: ExternalVariables,
  machineType: string,
  start: number,
  end: number,
  startDate: string,
): string[] {
  const machines = data.machines.filter((m) => m.machine_type === machineType);
  const eligible: string[] = [];

  for (const machine of machines) {
    const row = data.machineAvailability.find(
      (a) => a.machine_id === machine.machine_id && a.date === startDate,
    );
    if (!row) continue;
    if (row.available !== 1) continue;
    if (row.available_from === null || row.available_to === null) continue;

    const availableFrom = combineDateAndTime(startDate, row.available_from);
    const availableTo = combineDateAndTime(startDate, row.available_to);
    if (start >= availableFrom && end <= availableTo) {
      eligible.push(machine.machine_id);
    }
  }

  return eligible;
}

export function getMachineCostPerHour(data: ExternalVariables, machineIds: string[]): number {
  const rows = data.machines.filter((m) => machineIds.includes(m.machine_id));
  if (rows.length === 0) throw new Error(`No machines found for ${machineIds.join(",")}`);
  return rows.reduce((sum, r) => sum + r.cost_per_hour_aud, 0) / rows.length;
}
