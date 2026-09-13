import { clampUnit, clampYield } from "../genericTransitions";
import { clip } from "../numeric";
import { operationAlpha } from "./confidence";
import { predictResidual } from "./predict";
import type { FarmCalibration } from "./types";

export function personaliseValue(
  generic: number,
  residual: number,
  alpha: number,
  bounds?: { min: number; max: number },
): number {
  const value = generic + alpha * residual;
  if (!bounds) return value;
  return clip(value, bounds.min, bounds.max);
}

export function personalisedUnit(
  calibration: FarmCalibration | null | undefined,
  operation: string,
  fieldId: string,
  crop: string,
  generic: number,
  residual: number,
): number {
  const alpha = operationAlpha(calibration, operation, fieldId, crop);
  return clampUnit(personaliseValue(generic, residual, alpha, { min: 0, max: 1 }));
}

export function personalisedYieldValue(
  calibration: FarmCalibration | null | undefined,
  fieldId: string,
  crop: string,
  features: Record<string, string | number>,
  genericYield: number,
): number {
  if (!calibration?.yield) return clampYield(genericYield);
  const residual = predictResidual(calibration.yield, features);
  const alpha = operationAlpha(calibration, "yield", fieldId, crop);
  return clampYield(personaliseValue(genericYield, residual, alpha));
}