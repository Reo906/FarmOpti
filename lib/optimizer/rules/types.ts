/**
 * A hard scheduling exclusion rule -- the "never send H2 to North 4 within
 * 24 hours of more than 15mm rainfall" concept from the original demo. This
 * is a genuinely different kind of change from a config-update (which edits
 * an existing threshold/machine value): it prohibits a resource/field/
 * operation combination outright, conditioned on a weather trigger, rather
 * than adjusting a number the simulator already uses.
 */
export type RuleTriggerVariable = "rain_mm" | "wind_kmh" | "temperature_c";
export type RuleTriggerOp = "gt" | "gte" | "lt" | "lte";

export interface RuleTrigger {
  variable: RuleTriggerVariable;
  op: RuleTriggerOp;
  value: number;
}

export interface FarmRule {
  id: string;
  description: string;
  /** Machine id this rule restricts, or "any" for every machine. */
  resource: string;
  /** Field id this rule restricts, or "any" for every field. */
  field_id: string;
  /** Operation this rule restricts (harvest/irrigate/spray/fertilise/plant), or "any". */
  operation: string;
  /** null means the rule is unconditional (always prohibited when field/operation/resource match). */
  trigger: RuleTrigger | null;
  /** How many hours after the trigger condition holds the prohibition stays active. Ignored when trigger is null. */
  window_hours: number;
  created_at: string;
}

export type NewFarmRule = Omit<FarmRule, "id" | "created_at">;
