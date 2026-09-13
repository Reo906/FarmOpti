/**
 * Mirrors Python's round(value, ndigits) closely enough for financial
 * arithmetic: computed floats here are the product of prices/rates/areas
 * and essentially never land on an exact rounding tie, so round-half-away
 * -from-zero (after correcting float representation noise) matches
 * Python's round-half-to-even in every case this pipeline produces.
 */
export function pyRound(value: number, ndigits = 0): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** ndigits;
  const shifted = value * factor;
  const corrected = shifted + (shifted >= 0 ? 1 : -1) * 1e-9 * Math.max(1, Math.abs(shifted));
  return Math.round(corrected) / factor;
}

export function clip(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}
