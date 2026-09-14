import { clip } from "./numeric";
import type { WeatherRow } from "./types";

const MS_PER_HOUR = 3_600_000;

/**
 * Generic weather-impact parameters used for every field operation.
 * These are deliberately simple/tuneable MVP coefficients, not crop-specific agronomy.
 */
export const WEATHER_EFFECTS = {
  work: {
    rain_full_efficiency_mm_per_hour: 0.5,
    rain_zero_efficiency_mm_per_hour: 8.0,
    wind_full_efficiency_kmh: 15.0,
    wind_zero_efficiency_kmh: 55.0,
    recent_rain_window_hours: 24,
    recent_rain_zero_trafficability_mm: 40.0,
    min_trafficability_for_work: 0.15,
  },
  field: {
    rain_to_soil_moisture_per_mm: 0.012,
    dry_soil_moisture_loss_per_hour: 0.003,
    trafficability_recovery_per_dry_hour: 0.035,
    trafficability_rain_penalty_per_hour: 0.10,
    trafficability_wet_soil_penalty_per_hour: 0.025,
    wet_soil_threshold: 0.60,
    disease_wet_threshold: 0.62,
    disease_increase_per_wet_hour: 0.012,
    disease_recovery_per_dry_hour: 0.003,
    rain_damage_threshold_mm_per_hour: 10.0,
    rain_damage_per_excess_mm: 0.0015,
    wind_damage_threshold_kmh: 50.0,
    wind_damage_per_excess_kmh: 0.0010,
    max_damage_per_hour: 0.05,
  },
} as const;

function fallingEfficiency(value: number, fullUntil: number, zeroAt: number): number {
  if (value <= fullUntil) return 1.0;
  if (value >= zeroAt) return 0.0;
  return clip(1.0 - (value - fullUntil) / Math.max(zeroAt - fullUntil, 1e-9), 0.0, 1.0);
}

/** Same rain/wind efficiency curve for every operation. */
export function weatherWorkEfficiency(weather: WeatherRow): number {
  const rainEfficiency = fallingEfficiency(
    Number(weather.rain_mm),
    WEATHER_EFFECTS.work.rain_full_efficiency_mm_per_hour,
    WEATHER_EFFECTS.work.rain_zero_efficiency_mm_per_hour,
  );
  const windEfficiency = fallingEfficiency(
    Number(weather.wind_kmh),
    WEATHER_EFFECTS.work.wind_full_efficiency_kmh,
    WEATHER_EFFECTS.work.wind_zero_efficiency_kmh,
  );
  return clip(rainEfficiency * windEfficiency, 0.0, 1.0);
}

/**
 * Approximate post-rain trafficability from the previous 24h rainfall.
 * This lets dry hours immediately after heavy rain remain inefficient/unworkable.
 */
export function recentRainTrafficability(weather: WeatherRow[], timestamp: number): number {
  const windowMs = WEATHER_EFFECTS.work.recent_rain_window_hours * MS_PER_HOUR;
  const from = timestamp - windowMs;
  const rain = weather
    .filter((row) => row.time >= from && row.time < timestamp)
    .reduce((sum, row) => sum + Math.max(0, Number(row.rain_mm)), 0);
  return clip(1.0 - rain / WEATHER_EFFECTS.work.recent_rain_zero_trafficability_mm, 0.0, 1.0);
}

/** Effective work-rate multiplier, including current rain/wind and post-rain trafficability. */
export function totalWorkEfficiency(allWeather: WeatherRow[], row: WeatherRow): number {
  const trafficability = recentRainTrafficability(allWeather, row.time);
  if (trafficability < WEATHER_EFFECTS.work.min_trafficability_for_work) return 0.0;
  return weatherWorkEfficiency(row) * trafficability;
}

export interface WeatherDrivenFieldState {
  soil_moisture: number;
  trafficability: number;
  disease_pressure: number;
  weather_damage_index: number;
}

export interface WeatherFieldTransition extends WeatherDrivenFieldState {
  /** Fraction of remaining undamaged yield lost during this interval. */
  interval_damage_fraction: number;
}

/** Apply one weather interval to the physical/agronomic field state. */
export function applyWeatherToField(
  state: WeatherDrivenFieldState,
  weather: WeatherRow,
  hours = 1.0,
): WeatherFieldTransition {
  const rain = Math.max(0.0, Number(weather.rain_mm));
  const wind = Math.max(0.0, Number(weather.wind_kmh));
  const cfg = WEATHER_EFFECTS.field;

  const rainGain = rain * cfg.rain_to_soil_moisture_per_mm * hours;
  const drying = rain <= 0.05 ? cfg.dry_soil_moisture_loss_per_hour * hours : 0.0;
  const soilMoisture = clip(state.soil_moisture + rainGain - drying, 0.0, 1.0);

  const wetness = clip(
    (soilMoisture - cfg.wet_soil_threshold) / Math.max(1.0 - cfg.wet_soil_threshold, 1e-9),
    0.0,
    1.0,
  );
  const rainPenalty = clip(rain / Math.max(WEATHER_EFFECTS.work.rain_zero_efficiency_mm_per_hour, 1e-9), 0.0, 1.0)
    * cfg.trafficability_rain_penalty_per_hour * hours;
  const wetPenalty = wetness * cfg.trafficability_wet_soil_penalty_per_hour * hours;
  const recovery = rain <= 0.05
    ? cfg.trafficability_recovery_per_dry_hour * (1.0 - wetness) * hours
    : 0.0;
  const trafficability = clip(state.trafficability + recovery - rainPenalty - wetPenalty, 0.0, 1.0);

  const wetForDisease = rain > 0.1 || soilMoisture >= cfg.disease_wet_threshold;
  const diseaseDelta = wetForDisease
    ? cfg.disease_increase_per_wet_hour * (1.0 + wetness) * hours
    : -cfg.disease_recovery_per_dry_hour * hours;
  const diseasePressure = clip(state.disease_pressure + diseaseDelta, 0.0, 1.0);

  const rainExcess = Math.max(0.0, rain - cfg.rain_damage_threshold_mm_per_hour);
  const windExcess = Math.max(0.0, wind - cfg.wind_damage_threshold_kmh);
  const hourlyDamageRate = clip(
    rainExcess * cfg.rain_damage_per_excess_mm + windExcess * cfg.wind_damage_per_excess_kmh,
    0.0,
    cfg.max_damage_per_hour,
  );
  const intervalDamage = 1.0 - Math.pow(1.0 - hourlyDamageRate, Math.max(hours, 0.0));
  const weatherDamageIndex = clip(
    1.0 - (1.0 - state.weather_damage_index) * (1.0 - intervalDamage),
    0.0,
    1.0,
  );

  return {
    soil_moisture: soilMoisture,
    trafficability,
    disease_pressure: diseasePressure,
    weather_damage_index: weatherDamageIndex,
    interval_damage_fraction: intervalDamage,
  };
}
