import type { FarmCalibration, SupportCounts } from "./types";

export function supportCount(support: SupportCounts | undefined, fieldId: string, crop: string): number {
  if (!support) return 0;
  const fieldCrop = support.by_field_crop[`${fieldId}|${crop}`];
  if (fieldCrop) return fieldCrop;
  const cropCount = support.by_crop[crop];
  if (cropCount) return cropCount;
  return support.all ?? 0;
}

export function confidenceAlpha(n: number, k: number): number {
  if (n <= 0 || k < 0) return 0;
  return n / (n + k);
}

export function operationAlpha(
  calibration: FarmCalibration | null | undefined,
  operation: string,
  fieldId: string,
  crop: string,
): number {
  if (!calibration) return 0;
  const k = Number(calibration.metadata.confidence_k ?? 5);
  return confidenceAlpha(supportCount(calibration.metadata.support[operation], fieldId, crop), k);
}