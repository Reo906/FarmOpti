import type { ChatMessage, LLMClientLike } from "../scenario/parser";
import { ConfigValidationError, describeConfigForLlm, getConfigLeaf, validateConfigUpdate } from "./schema";
import { describeMachinesForLlm, MachineValidationError, validateMachineChange, type MachineChange } from "./machineSchema";
import type { FarmRule, NewFarmRule } from "../../rules/types";

export class ConfigUpdateValidationError extends Error {}

export type ConfigChangeProposal =
  | { kind: "config_update"; description: string; path: string; previous_value: unknown; new_value: number | boolean | string }
  | { kind: "machine_change"; description: string; change: MachineChange }
  // Constructed directly by the Farm Rules UI form (no LLM involved -- the
  // form's dropdowns/inputs are already unambiguous), but shares the same
  // propose-object shape so it flows through the same confirm/apply/
  // reoptimize pipeline as chat-originated proposals.
  | { kind: "rule_change"; description: string; action: "add"; rule: NewFarmRule }
  | { kind: "rule_change"; description: string; action: "remove"; rule: FarmRule }
  | { kind: "unsupported"; description: string; reason: string };

const SYSTEM_PROMPT = `
You compile a FarmOpti configuration-change request into one of two structured shapes. This is a PERSISTENT change to the real optimizer inputs, not a one-off simulation -- only compile requests that are genuinely about changing a stored threshold/parameter or the equipment roster.

Shape 1 -- config_update: editing an existing numeric/boolean/string parameter in config.yaml (feasibility thresholds like max_wind_kmh, response-curve constants like efficacy, beam search width, solver time budget, etc).
{"kind":"config_update","path":"operations.spray.feasibility.max_wind_kmh","value":15}

Shape 2 -- machine_change: adding new equipment or changing an existing machine's type/cost/field.
{"kind":"machine_change","mode":"add","machine_id":"M8","machine_type":"harvester","cost_per_hour_aud":180}
{"kind":"machine_change","mode":"update","machine_id":"M3","cost_per_hour_aud":45}

Shape 3 -- unsupported: the request describes a genuinely new KIND of rule or relationship that has NO matching path in the supplied editable_paths list at all (e.g. "never use a machine on a field with wet soil", "prioritise wheat fields over canola", "don't spray within 24 hours of harvest"). Do not force these into shape 1 or 2.
{"kind":"unsupported","reason":"This is a new conditional rule, not an existing threshold or machine field."}

Important distinction -- a phrase like "only do X when/below/above Y" is USUALLY just restating an existing feasibility threshold, not a new rule:
- "Only spray when wind speed is below 15 km/h" -- operations.spray.feasibility.max_wind_kmh already exists and IS exactly this limit -> config_update, value 15.
- "Don't harvest if wind is over 40 km/h" -- operations.harvest.feasibility.max_wind_kmh already exists -> config_update, value 40.
- "Never irrigate when there's more than 3mm of rain forecast" -- operations.irrigate.feasibility.max_rain_mm_per_hour already exists -> config_update, value 3.
Before returning unsupported, check every path in editable_paths for one whose name (feasibility limit, response constant) already means the same thing as the request. Only return unsupported if truly nothing in editable_paths matches the concept.

Rules:
1. Use ONLY paths and machine fields present in the supplied FarmOpti context. Never invent a config path or machine_id.
2. Preserve the requested numerical value exactly.
3. For machine_change, machine_id must be an existing id (mode=update) or a new, unused id (mode=add).
4. Return only the structured object required by the supplied schema.
`.trim();

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["config_update", "machine_change", "unsupported"] },
    path: { type: "string" },
    value: { anyOf: [{ type: "number" }, { type: "boolean" }, { type: "string" }] },
    mode: { type: "string", enum: ["add", "update"] },
    machine_id: { type: "string" },
    machine_type: { type: "string" },
    cost_per_hour_aud: { type: "number" },
    current_field: { type: "string" },
    available_from: { type: "string" },
    available_to: { type: "string" },
    reason: { type: "string" },
  },
  required: ["kind"],
  additionalProperties: false,
};

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

  async parse(request: string): Promise<ConfigChangeProposal> {
    const context = {
      config: describeConfigForLlm(),
      machines: describeMachinesForLlm(this.externalVariablesDir),
    };

    const prompt = `FarmOpti configuration schema and current values:
${JSON.stringify(context, null, 2)}

User request:
${request}

Compile this into the supplied configuration-change DSL.`;

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ];

    const response = await this.llm.chat(messages, { responseSchema: RESPONSE_SCHEMA, maxOutputTokens: 400 });

    let parsed: any;
    try {
      parsed = this.extractJson(response);
    } catch (exc) {
      throw new ConfigUpdateValidationError(`Could not parse LLM response as JSON: ${exc}`);
    }

    return this.validate(request, parsed);
  }

  private validate(request: string, parsed: any): ConfigChangeProposal {
    if (parsed.kind === "unsupported") {
      return { kind: "unsupported", description: request, reason: String(parsed.reason ?? "Not expressible as a config or machine change.") };
    }

    if (parsed.kind === "config_update") {
      try {
        const { path, value } = validateConfigUpdate(String(parsed.path ?? ""), parsed.value);
        const leaf = getConfigLeaf(path)!;
        return { kind: "config_update", description: request, path: path.join("."), previous_value: leaf.value, new_value: value };
      } catch (exc) {
        if (exc instanceof ConfigValidationError) throw new ConfigUpdateValidationError(exc.message);
        throw exc;
      }
    }

    if (parsed.kind === "machine_change") {
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

    throw new ConfigUpdateValidationError(`Unknown proposal kind: ${JSON.stringify(parsed.kind)}`);
  }
}
