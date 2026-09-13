import { CANDIDATE_CONFIG, RULES } from "./config";
import { addDays, combineDateAndTime, compareDateOnly, dateOnlyOf } from "./datetime";
import { getLabourForDay } from "./externalVariables";
import type { ExternalVariables, MachineAvailabilityRow, WeatherRow, WorkSegment } from "./types";

const MS_PER_HOUR = 3_600_000;

export function requiredWorkloadHours(areaHa: number, workRateHaPerHour: number): number {
  if (workRateHaPerHour <= 0) throw new Error("work_rate_ha_per_hour must be positive");
  return areaHa / workRateHaPerHour;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function configWorkdayBounds(date: string): { start: number; end: number } {
  const startHour = Number(CANDIDATE_CONFIG.workday_start_hour);
  const endHour = Number(CANDIDATE_CONFIG.workday_end_hour);
  return {
    start: combineDateAndTime(date, `${pad2(startHour)}:00`),
    end: combineDateAndTime(date, `${pad2(endHour)}:00`),
  };
}

export function labourWorkdayBounds(data: ExternalVariables, date: string): { start: number; end: number } | null {
  const labour = getLabourForDay(data, date);
  if (!labour || labour.available_workers <= 0) return null;
  return {
    start: combineDateAndTime(date, labour.workday_start),
    end: combineDateAndTime(date, labour.workday_end),
  };
}

export function machineWindowOnDay(row: MachineAvailabilityRow | undefined, date: string): { start: number; end: number } | null {
  if (!row || row.available !== 1 || row.available_from === null || row.available_to === null) return null;
  return {
    start: combineDateAndTime(date, row.available_from),
    end: combineDateAndTime(date, row.available_to),
  };
}

export function intersectWindows(
  ...windows: Array<{ start: number; end: number } | null | undefined>
): { start: number; end: number } | null {
  let start = -Infinity;
  let end = Infinity;
  for (const window of windows) {
    if (!window) return null;
    start = Math.max(start, window.start);
    end = Math.min(end, window.end);
  }
  if (!(start < end)) return null;
  return { start, end };
}

function weatherByHour(data: ExternalVariables): Map<number, WeatherRow> {
  const map = new Map<number, WeatherRow>();
  for (const row of data.weather) map.set(row.time, row);
  return map;
}

export function operationHourFeasible(operation: string, weather: WeatherRow | undefined): boolean {
  if (!weather) return false;
  const feasibility = RULES[operation]?.feasibility ?? {};
  const maxRain = feasibility.max_rain_mm_per_hour;
  const maxWind = feasibility.max_wind_kmh;
  if (maxRain !== undefined && weather.rain_mm > Number(maxRain)) return false;
  if (maxWind !== undefined && weather.wind_kmh > Number(maxWind)) return false;
  return true;
}

export function feasibleHoursInWindow(
  data: ExternalVariables,
  operation: string,
  window: { start: number; end: number },
  weatherMap?: Map<number, WeatherRow>,
): number {
  const byHour = weatherMap ?? weatherByHour(data);
  let hours = 0;
  const startHour = Math.floor(window.start / MS_PER_HOUR) * MS_PER_HOUR;
  for (let t = startHour; t < window.end; t += MS_PER_HOUR) {
    const hourEnd = t + MS_PER_HOUR;
    const overlapStart = Math.max(t, window.start);
    const overlapEnd = Math.min(hourEnd, window.end);
    if (overlapEnd <= overlapStart) continue;
    if (!operationHourFeasible(operation, byHour.get(t))) continue;
    hours += (overlapEnd - overlapStart) / MS_PER_HOUR;
  }
  return hours;
}

export function weatherForWindow(data: ExternalVariables, start: number, durationHours: number): WeatherRow[] {
  const end = start + durationHours * MS_PER_HOUR;
  const startFloor = Math.floor(start / MS_PER_HOUR) * MS_PER_HOUR;
  const endCeil = Math.ceil(end / MS_PER_HOUR) * MS_PER_HOUR;
  return data.weather.filter((w) => w.time >= startFloor && w.time < endCeil);
}

export function weatherForSegments(data: ExternalVariables, segments: WorkSegment[]): WeatherRow[] {
  const seen = new Set<number>();
  const rows: WeatherRow[] = [];
  for (const segment of segments) {
    for (const row of weatherForWindow(data, segment.start_time, segment.work_hours)) {
      if (seen.has(row.time)) continue;
      seen.add(row.time);
      rows.push(row);
    }
  }
  return rows;
}

export function machineCapacityOnDay(data: ExternalVariables, machineId: string, date: string): number {
  const row = data.machineAvailability.find((a) => a.machine_id === machineId && a.date === date);
  const window = machineWindowOnDay(row, date);
  if (!window) return 0;
  return Math.max(0, (window.end - window.start) / MS_PER_HOUR);
}

export function actionDayWindow(
  data: ExternalVariables,
  date: string,
  machineIds: string[],
  notBefore?: number,
): { start: number; end: number } | null {
  const labour = labourWorkdayBounds(data, date);
  const config = configWorkdayBounds(date);
  const machineWindows = machineIds
    .map((id) => machineWindowOnDay(
      data.machineAvailability.find((a) => a.machine_id === id && a.date === date),
      date,
    ))
    .filter((w): w is { start: number; end: number } => w != null);

  const machineUnion = machineWindows.length === 0
    ? null
    : machineWindows.reduce((acc, w) => ({
        start: Math.min(acc.start, w.start),
        end: Math.max(acc.end, w.end),
      }));

  const window = intersectWindows(config, labour, machineUnion);
  if (!window) return null;
  if (notBefore !== undefined && dateOnlyOf(notBefore) === date) {
    const start = Math.max(window.start, notBefore);
    if (!(start < window.end)) return null;
    return { start, end: window.end };
  }
  return window;
}

export function actionDayCapacity(
  data: ExternalVariables,
  operation: string,
  date: string,
  machineIds: string[],
  notBefore?: number,
  weatherMap?: Map<number, WeatherRow>,
): number {
  const labour = getLabourForDay(data, date);
  const workers = Number(RULES[operation]?.workers ?? 0);
  if (!labour || labour.available_workers < workers) return 0;

  const window = actionDayWindow(data, date, machineIds, notBefore);
  if (!window) return 0;
  return feasibleHoursInWindow(data, operation, window, weatherMap);
}

export function machinesOfType(data: ExternalVariables, machineType: string): string[] {
  return data.machines.filter((m) => m.machine_type === machineType).map((m) => m.machine_id);
}

export function machinesAvailableInWindow(
  data: ExternalVariables,
  machineType: string,
  start: number,
  end: number,
  date: string,
): string[] {
  const eligible: string[] = [];
  for (const machine of data.machines.filter((m) => m.machine_type === machineType)) {
    const window = machineWindowOnDay(
      data.machineAvailability.find((a) => a.machine_id === machine.machine_id && a.date === date),
      date,
    );
    if (window && start >= window.start && end <= window.end) eligible.push(machine.machine_id);
  }
  return eligible;
}

export function machinesAvailableOnDay(data: ExternalVariables, machineType: string, date: string): string[] {
  return machinesOfType(data, machineType).filter((id) => machineCapacityOnDay(data, id, date) > 0);
}

export function enumerateDates(from: string, to: string): string[] {
  const dates: string[] = [];
  let current = from;
  while (compareDateOnly(current, to) <= 0) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

export function packWorkload(
  data: ExternalVariables,
  operation: string,
  machineType: string,
  workloadHours: number,
  start: number,
  latestDate: string,
): WorkSegment[] | null {
  if (workloadHours <= 1e-9) return [];

  const weatherMap = weatherByHour(data);
  const segments: WorkSegment[] = [];
  let remaining = workloadHours;
  let currentDate = dateOnlyOf(start);

  while (remaining > 1e-9 && compareDateOnly(currentDate, latestDate) <= 0) {
    const machineIds = machinesAvailableOnDay(data, machineType, currentDate);
    if (machineIds.length === 0) {
      currentDate = addDays(currentDate, 1);
      continue;
    }

    const notBefore = currentDate === dateOnlyOf(start) ? start : undefined;
    const window = actionDayWindow(data, currentDate, machineIds, notBefore);
    const capacity = actionDayCapacity(data, operation, currentDate, machineIds, notBefore, weatherMap);
    const work = Math.min(remaining, capacity);

    if (window && work > 1e-9) {
      segments.push({
        date: currentDate,
        start_time: window.start,
        end_time: window.start + work * MS_PER_HOUR,
        work_hours: work,
      });
      remaining -= work;
    }

    currentDate = addDays(currentDate, 1);
  }

  if (remaining > 1e-6) return null;
  return segments;
}

export function dailyWaterOk(
  data: ExternalVariables,
  segments: WorkSegment[],
  totalWaterMl: number,
  workloadHours: number,
): boolean {
  if (totalWaterMl <= 0 || workloadHours <= 0) return true;
  for (const segment of segments) {
    const portion = totalWaterMl * (segment.work_hours / workloadHours);
    const waterRow = data.water.find((w) => w.date === segment.date);
    if (!waterRow) return false;
    if (portion > waterRow.available_water_ml + 1e-9 || portion > waterRow.max_delivery_ml_per_day + 1e-9) {
      return false;
    }
  }
  return true;
}

export function remainingAfterSegments(workloadHours: number, segments: WorkSegment[]): number[] {
  let remaining = workloadHours;
  return segments.map((segment) => {
    remaining = Math.max(0, remaining - segment.work_hours);
    return remaining;
  });
}
