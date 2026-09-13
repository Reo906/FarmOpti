import type { WeatherRow } from "../types";
import type { FarmRule, RuleTriggerOp } from "./types";

function compare(value: number, op: RuleTriggerOp, threshold: number): boolean {
  switch (op) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
  }
}

/**
 * Whether `rule` prohibits `machineId` from doing `operation` on `fieldId`
 * starting at `start`. An unconditional rule (trigger === null) always
 * applies once field/operation/resource match. A conditional rule applies
 * only if the trigger held at any hour in [start - window_hours, start] --
 * "within 24 hours of more than 15mm rain" means "look back up to 24 hours
 * from the candidate's start time for a hour where rain_mm > 15".
 */
export function ruleProhibits(rule: FarmRule, fieldId: string, operation: string, machineId: string, start: number, weather: WeatherRow[]): boolean {
  if (rule.field_id !== "any" && rule.field_id !== fieldId) return false;
  if (rule.operation !== "any" && rule.operation !== operation) return false;
  if (rule.resource !== "any" && rule.resource !== machineId) return false;

  if (rule.trigger === null) return true;

  const windowStart = start - rule.window_hours * 3_600_000;
  return weather.some((w) => w.time >= windowStart && w.time <= start && compare(w[rule.trigger!.variable], rule.trigger!.op, rule.trigger!.value));
}

/** Removes any machine that an active rule would prohibit for this field/operation/start. */
export function filterEligibleMachines(rules: FarmRule[], fieldId: string, operation: string, machineIds: string[], start: number, weather: WeatherRow[]): string[] {
  if (rules.length === 0) return machineIds;
  return machineIds.filter((machineId) => !rules.some((rule) => ruleProhibits(rule, fieldId, operation, machineId, start, weather)));
}
