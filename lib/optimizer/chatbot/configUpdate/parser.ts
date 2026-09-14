import type { ChatMessage, LLMClientLike } from "../scenario/parser";
import { ConfigValidationError, describeConfigForLlm, getConfigLeaf, validateConfigUpdate } from "./schema";
import { describeMachinesForLlm, MachineValidationError, validateMachineChange, type MachineChange } from "./machineSchema";
import { describeRulesForLlm, RuleValidationError, validateRuleChange } from "./ruleSchema";
import type { FarmRule, NewFarmRule } from "../../rules/types";

export class ConfigUpdateValidationError extends Error {}

export type ConfigChangeProposal =
  | { kind: "config_update"; description: string; path: string; previous_value: unknown; new_value: number | boolean | string }
  | { kind: "machine_change"; description: string; change: MachineChange }
  // Constructed either by ConfigUpdateParser.parse() (chat, via ruleSchema.ts)
  // or directly by the Farm Rules UI form's dropdowns/inputs -- both share
  // this shape so either path flows through the same confirm/apply/
  // reoptimize pipeline.
  | { kind: "rule_change"; description: string; action: "add"; rule: NewFarmRule }
  | { kind: "rule_change"; description: string; action: "remove"; rule: FarmRule }
  | { kind: "unsupported"; description: string; reason: string };

// A local 7B model handles "pick one of four shapes, each with its own set of
// optional fields" unreliably in one shot -- it tends to mix up similar-
// looking fields (e.g. writing a field id into a machine_id slot) or default
// to the wrong shape's fields entirely once the schema gets big. Splitting
// into two focused calls -- first just decide the shape, then extract only
// that shape's (small) field set with a prompt written for nothing else --
// mirrors classifyRequest()/runConfigUpdate() and is far more reliable in
// practice than one shared mega-schema.

const SHAPE_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["config_update", "machine_change", "rule_change", "unsupported"] },
    reason: { type: "string" },
  },
  required: ["kind"],
  additionalProperties: false,
};

const SHAPE_PROMPT = `
You decide which of three kinds of PERSISTENT FarmOpti configuration change a request describes (not a one-off simulation -- only these three, or unsupported).

config_update: editing an existing numeric/boolean/string parameter in config.yaml that applies globally to every field/machine doing that operation (a feasibility threshold like max_wind_kmh, a response-curve constant, beam search width, solver time budget, etc). A phrase like "only do X when/below/above Y" with NO specific field or machine named is usually this -- check editable_paths for a name that already means the same concept before deciding otherwise.
- "Only spray when wind speed is below 15 km/h" -> config_update.
- "Don't harvest if wind is over 40 km/h" -> config_update.

machine_change: adding new equipment or changing an existing machine's type/cost/field.
- "We just bought a new harvester, M8, costing $180/hour." -> machine_change.
- "M3's cost per hour is now 45." -> machine_change.

rule_change: a hard scheduling exclusion naming a SPECIFIC field (from known_fields) and/or a SPECIFIC machine (from known_machines) that should avoid an operation -- optionally only when a weather condition holds. This differs from config_update because it targets one field/machine, not every field/machine doing that operation.
- "Never spray F3 within 24 hours of heavy rain" -> rule_change (F3 is a specific field).
- "Don't use M3 for harvesting" -> rule_change (M3 is a specific machine).
- "Remove the rule about F3" or "delete RULE-01" -> rule_change (referencing an existing rule to delete).

unsupported: a genuinely new kind of relationship matching none of the above (e.g. "prioritise wheat fields over canola", "always spray F3 before F2"). Give a one-sentence reason.

Return only the structured classification required by the supplied schema.
`.trim();

const CONFIG_MACHINE_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string" },
    value: { anyOf: [{ type: "number" }, { type: "boolean" }, { type: "string" }] },
    mode: { type: "string", enum: ["add", "update"] },
    machine_id: { type: "string" },
    machine_type: { type: "string" },
    cost_per_hour_aud: { type: "number" },
    current_field: { type: "string" },
    available_from: { type: "string" },
    available_to: { type: "string" },
  },
  additionalProperties: false,
};

const CONFIG_UPDATE_PROMPT = `
Compile this request into a config_update: an existing parameter path in config.yaml plus its new value.
{"path":"operations.spray.feasibility.max_wind_kmh","value":15}

Rules:
1. Use ONLY a path present in the supplied editable_paths. Never invent one.
2. Preserve the requested numerical value exactly.
3. Return only the structured object required by the supplied schema.
`.trim();

const MACHINE_CHANGE_PROMPT = `
Compile this request into a machine_change: adding new equipment (mode="add") or changing an existing machine's type/cost/field (mode="update").
{"mode":"add","machine_id":"M8","machine_type":"harvester","cost_per_hour_aud":180}
{"mode":"update","machine_id":"M3","cost_per_hour_aud":45}

Rules:
1. machine_id must be an existing id (mode=update) or a new, unused id (mode=add) -- check existing_machines.
2. Preserve the requested numerical value exactly.
3. Return only the structured object required by the supplied schema.
`.trim();

const RULE_CHANGE_SCHEMA = {
  type: "object",
  properties: {
    rule_action: { type: "string", enum: ["add", "remove"] },
    field_id: { type: "string" },
    machine_id: { type: "string" },
    operation: { type: "string" },
    trigger_variable: { type: "string", enum: ["rain_mm", "wind_kmh", "temperature_c"] },
    trigger_op: { type: "string", enum: ["gt", "gte", "lt", "lte"] },
    trigger_value: { type: "number" },
    window_hours: { type: "number" },
    rule_id: { type: "string" },
  },
  required: ["rule_action"],
  additionalProperties: false,
};

const RULE_CHANGE_PROMPT = `
Compile this request into a hard scheduling-exclusion rule. Set rule_action="add" to create one, or rule_action="remove" with rule_id to delete an existing one (only an id taken from existing_rules).

For rule_action="add", fill in ONLY the fields the request actually restricts, leaving the rest unset:
- field_id: set ONLY if the request names a specific field id. Check known_fields -- an id in known_fields is ALWAYS a field_id.
- machine_id: set ONLY if the request names a specific machine id. Check known_machines -- an id in known_machines is ALWAYS a machine_id, NEVER a field_id.
- operation: set ONLY if the request names a specific operation (from known_operations).
- trigger_variable/trigger_op/trigger_value/window_hours: set ALL FOUR together ONLY if the request names a weather condition (e.g. "within 24 hours of heavy rain" -> trigger_variable="rain_mm", window_hours=24); otherwise leave all four unset.
At least one of field_id/machine_id/operation must end up set -- a rule can't restrict literally everything.

Example -- "Never spray F3 within 24 hours of heavy rain" (F3 is in known_fields, not known_machines):
{"rule_action":"add","field_id":"F3","operation":"spray","trigger_variable":"rain_mm","trigger_op":"gte","trigger_value":0.5,"window_hours":24}

Example -- "Don't use M3 for harvesting" (M3 is in known_machines, no weather condition mentioned):
{"rule_action":"add","machine_id":"M3","operation":"harvest"}

Example -- "Remove RULE-01":
{"rule_action":"remove","rule_id":"RULE-01"}

Return only the structured object required by the supplied schema.
`.trim();

export class ConfigUpdateParser {
  private llm: LLMClientLike;
  private externalVariablesDir?: string;

  constructor(llm: LLMClientLike, externalVariablesDir?: string) {
    this.llm = llm;
    this.externalVariablesDir = externalVariablesDir;
  }

  private extractJson(text: string): any {
    let trimmed = text.trim();
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      return JSON.parse(trimmed);
    } catch {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
      throw new Error("Could not locate a JSON object in the LLM response");
    }
  }

  private async ask(systemPrompt: string, userPrompt: string, responseSchema: Record<string, unknown>): Promise<any> {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    const response = await this.llm.chat(messages, { responseSchema, maxOutputTokens: 400 });
    try {
      return this.extractJson(response);
    } catch (exc) {
      throw new ConfigUpdateValidationError(`Could not parse LLM response as JSON: ${exc}`);
    }
  }

  async parse(request: string): Promise<ConfigChangeProposal> {
    const config = describeConfigForLlm();
    const machines = describeMachinesForLlm(this.externalVariablesDir);
    const rules = describeRulesForLlm(this.externalVariablesDir);

    const shapeParsed = await this.ask(
      SHAPE_PROMPT,
      `FarmOpti context:\n${JSON.stringify({ config, machines, rules }, null, 2)}\n\nUser request:\n${request}\n\nClassify this request.`,
      SHAPE_SCHEMA,
    );

    const kind = String(shapeParsed.kind ?? "unsupported");

    if (kind === "unsupported") {
      return { kind: "unsupported", description: request, reason: String(shapeParsed.reason ?? "Not expressible as a config, machine, or rule change.") };
    }

    if (kind === "config_update") {
      const parsed = await this.ask(
        CONFIG_UPDATE_PROMPT,
        `FarmOpti configuration schema and current values:\n${JSON.stringify(config, null, 2)}\n\nUser request:\n${request}\n\nCompile this into a config_update.`,
        CONFIG_MACHINE_SCHEMA,
      );
      try {
        const { path, value } = validateConfigUpdate(String(parsed.path ?? ""), parsed.value);
        const leaf = getConfigLeaf(path)!;
        return { kind: "config_update", description: request, path: path.join("."), previous_value: leaf.value, new_value: value };
      } catch (exc) {
        if (exc instanceof ConfigValidationError) throw new ConfigUpdateValidationError(exc.message);
        throw exc;
      }
    }

    if (kind === "machine_change") {
      const parsed = await this.ask(
        MACHINE_CHANGE_PROMPT,
        `FarmOpti equipment roster:\n${JSON.stringify(machines, null, 2)}\n\nUser request:\n${request}\n\nCompile this into a machine_change.`,
        CONFIG_MACHINE_SCHEMA,
      );
      try {
        const change = validateMachineChange(
          {
            mode: parsed.mode,
            machine_id: String(parsed.machine_id ?? ""),
            machine_type: parsed.machine_type,
            cost_per_hour_aud: parsed.cost_per_hour_aud,
            current_field: parsed.current_field,
            available_from: parsed.available_from,
            available_to: parsed.available_to,
          },
          this.externalVariablesDir,
        );
        return { kind: "machine_change", description: request, change };
      } catch (exc) {
        if (exc instanceof MachineValidationError) throw new ConfigUpdateValidationError(exc.message);
        throw exc;
      }
    }

    if (kind === "rule_change") {
      const parsed = await this.ask(
        RULE_CHANGE_PROMPT,
        `FarmOpti farm rules context:\n${JSON.stringify(rules, null, 2)}\n\nUser request:\n${request}\n\nCompile this into a rule_change.`,
        RULE_CHANGE_SCHEMA,
      );
      try {
        const result = validateRuleChange(
          {
            action: parsed.rule_action === "remove" ? "remove" : "add",
            description: request,
            resource: parsed.machine_id,
            field_id: parsed.field_id,
            operation: parsed.operation,
            trigger_variable: parsed.trigger_variable,
            trigger_op: parsed.trigger_op,
            trigger_value: parsed.trigger_value,
            window_hours: parsed.window_hours,
            rule_id: parsed.rule_id,
          },
          this.externalVariablesDir,
        );
        return result.action === "add"
          ? { kind: "rule_change", description: request, action: "add", rule: result.rule }
          : { kind: "rule_change", description: request, action: "remove", rule: result.rule };
      } catch (exc) {
        if (exc instanceof RuleValidationError) throw new ConfigUpdateValidationError(exc.message);
        throw exc;
      }
    }

    throw new ConfigUpdateValidationError(`Unknown proposal kind: ${JSON.stringify(kind)}`);
  }
}
