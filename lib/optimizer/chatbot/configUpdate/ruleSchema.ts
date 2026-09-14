import path from "node:path";
import { readCsv } from "../../csv";
import { EXTERNAL_DIR } from "../../paths";
import { RULES } from "../../config";
import { loadRules } from "../../rules/store";
import type { FarmRule, NewFarmRule, RuleTrigger } from "../../rules/types";

export class RuleValidationError extends Error {}

export interface RuleChangeInput {
  action: "add" | "remove";
  description?: string;
  resource?: string;
  field_id?: string;
  operation?: string;
  trigger_variable?: string;
  trigger_op?: string;
  trigger_value?: number;
  window_hours?: number;
  rule_id?: string;
}

function knownFields(externalVariablesDir: string): string[] {
  return readCsv(path.join(externalVariablesDir, "fields.csv")).map((f) => f.field_id);
}

function knownMachines(externalVariablesDir: string): string[] {
  return readCsv(path.join(externalVariablesDir, "machines.csv")).map((m) => m.machine_id);
}

export function describeRulesForLlm(externalVariablesDir: string = EXTERNAL_DIR): Record<string, unknown> {
  return {
    purpose:
      "Hard scheduling-exclusion rules: prohibit a (machine, field, operation) combination outright, optionally only when a weather trigger has held at any point in a lookback window before the candidate action's start time. Use rule_action='add' to create a new rule (machine_id/field_id/operation each default to 'any' if omitted, but at least one must be specific -- a rule can't restrict literally everything). An id from known_fields is always a field_id, never a machine_id; an id from known_machines is always a machine_id, never a field_id. Use rule_action='remove' with rule_id to delete an existing rule, only choosing an id from existing_rules below.",
    known_fields: [...knownFields(externalVariablesDir), "any"],
    known_machines: [...knownMachines(externalVariablesDir), "any"],
    known_operations: [...Object.keys(RULES), "any"],
    trigger_variables: ["rain_mm", "wind_kmh", "temperature_c"],
    trigger_ops: { gt: "greater than", gte: "at least", lt: "less than", lte: "at most" },
    existing_rules: loadRules(),
  };
}

export function validateRuleChange(
  input: RuleChangeInput,
  externalVariablesDir: string = EXTERNAL_DIR,
): { action: "add"; rule: NewFarmRule } | { action: "remove"; rule: FarmRule } {
  if (input.action === "remove") {
    const rules = loadRules();
    const found = rules.find((r) => r.id === input.rule_id);
    if (!found) {
      throw new RuleValidationError(
        `Unknown rule id "${input.rule_id}". Existing rule ids: ${rules.map((r) => r.id).join(", ") || "(none -- there are no rules to remove)"}`,
      );
    }
    return { action: "remove", rule: found };
  }

  const fields = knownFields(externalVariablesDir);
  const machines = knownMachines(externalVariablesDir);
  const operations = Object.keys(RULES);

  const resource = input.resource || "any";
  const field_id = input.field_id || "any";
  const operation = input.operation || "any";

  if (resource !== "any" && !machines.includes(resource)) throw new RuleValidationError(`Unknown machine "${resource}"`);
  if (field_id !== "any" && !fields.includes(field_id)) throw new RuleValidationError(`Unknown field "${field_id}"`);
  if (operation !== "any" && !operations.includes(operation)) throw new RuleValidationError(`Unknown operation "${operation}"`);
  if (resource === "any" && field_id === "any" && operation === "any") {
    throw new RuleValidationError("A rule must restrict at least one of machine, field, or operation -- it can't apply to everything.");
  }

  let trigger: RuleTrigger | null = null;
  let window_hours = 0;
  if (input.trigger_variable) {
    const variable = input.trigger_variable;
    if (!["rain_mm", "wind_kmh", "temperature_c"].includes(variable)) throw new RuleValidationError(`Unknown trigger variable "${variable}"`);
    const op = input.trigger_op;
    if (!op || !["gt", "gte", "lt", "lte"].includes(op)) throw new RuleValidationError(`Invalid trigger comparison "${op}"`);
    if (input.trigger_value === undefined || Number.isNaN(input.trigger_value)) throw new RuleValidationError("trigger_value is required when a trigger variable is given");
    if (!input.window_hours || input.window_hours <= 0) throw new RuleValidationError("window_hours must be a positive number when a trigger is given");
    trigger = { variable: variable as RuleTrigger["variable"], op: op as RuleTrigger["op"], value: input.trigger_value };
    window_hours = input.window_hours;
  }

  return {
    action: "add",
    rule: {
      description: input.description?.trim() || "New farm rule",
      resource,
      field_id,
      operation,
      trigger,
      window_hours,
    },
  };
}
