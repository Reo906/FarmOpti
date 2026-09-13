import { clip } from "./numeric";

export const UNIT_INTERVAL = { min: 0, max: 1 } as const;

export const SPRAY_TARGET_TO_PLAN: Record<string, string> = {
  weed: "weed_control",
  pest: "pest_control",
  disease: "disease_control",
  weed_control: "weed_control",
  pest_control: "pest_control",
  disease_control: "disease_control",
};

export const SPRAY_PLAN_TO_PRESSURE: Record<string, "weed_pressure" | "pest_pressure" | "disease_pressure"> = {
  weed_control: "weed_pressure",
  pest_control: "pest_pressure",
  disease_control: "disease_pressure",
};

export function normalizeSprayTarget(raw: string | undefined | null): string {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase();
  return SPRAY_TARGET_TO_PLAN[key] ?? key;
}

export function sprayPressureKey(raw: string | undefined | null): "weed_pressure" | "pest_pressure" | "disease_pressure" | null {
  const planTarget = normalizeSprayTarget(raw);
  return SPRAY_PLAN_TO_PRESSURE[planTarget] ?? null;
}

export function genericNextMoisture(moisture: number, target: number): number | null {
  if (moisture >= target) return null;
  return Math.max(moisture, target);
}

export function genericIrrigateYieldEffect(
  moisture: number,
  target: number,
  expectedYield: number,
  maxYieldLossFraction: number,
): number {
  const deficit = clip((target - moisture) / target, 0.0, 1.0);
  return expectedYield * deficit * maxYieldLossFraction;
}

export function genericNextNitrogen(
  currentN: number,
  targetN: number,
  amount: number,
  responseScale: number,
): number | null {
  if (currentN >= targetN || !Number.isFinite(amount)) return null;
  const doseResponse = 1.0 - Math.exp(-amount / responseScale);
  return Math.min(1.0, currentN + (targetN - currentN) * doseResponse);
}

export function genericFertiliseYieldEffect(
  currentN: number,
  targetN: number,
  amount: number,
  expectedYield: number,
  maxYieldGainFraction: number,
  responseScale: number,
): number {
  const deficit = clip((targetN - currentN) / targetN, 0.0, 1.0);
  const doseResponse = 1.0 - Math.exp(-amount / responseScale);
  return expectedYield * deficit * maxYieldGainFraction * doseResponse;
}

export function genericNextPressure(pressure: number, efficacy: number): number | null {
  if (pressure <= 0) return null;
  return pressure * (1.0 - efficacy);
}

export function genericSprayYieldEffect(
  pressure: number,
  expectedYield: number,
  maxYieldLossFraction: number,
  efficacy: number,
): number {
  return expectedYield * pressure * maxYieldLossFraction * efficacy;
}

export function clampUnit(value: number): number {
  return clip(value, 0, 1);
}

export function clampYield(value: number): number {
  return Math.max(0, value);
}