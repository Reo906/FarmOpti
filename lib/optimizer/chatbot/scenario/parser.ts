import { ScenarioValidationError, ScenarioValidator, type ScenarioInterpretation } from "./validator";

const SYSTEM_PROMPT = `
You compile a FarmOpti scenario request into the supplied generic scenario DSL.
The request has already been classified as a scenario modification. Do not classify it again.

Every scenario change uses:
- target: an exposed FarmOpti entity/table
- where: selectors identifying affected rows/actions
- update: modification to stored input values, and/or
- constraints: scheduling/selection constraints for target="action"

Rules:
1. Use only targets, fields, operators and identifiers present in the supplied FarmOpti context.
2. Never invent plan IDs, field IDs, machine IDs, operation names or candidate IDs.
3. Prefer target="action" when the user refers to harvesting, irrigation, spraying, fertilising, planting, a plan, or changing when an operation occurs.
4. For action timing changes, use constraints.date or constraints.start_time, not table edits or candidate IDs.
5. A request to move/schedule an action to a date/time implies constraints.selected=true unless the user explicitly says selection remains optional.
6. Use YYYY-MM-DD for dates and YYYY-MM-DD HH:MM:SS for datetimes.
7. Use update for water, labour, machines, economics, weather, field state, management values and other exposed input tables.
8. Preserve requested numerical values exactly. Do not guess missing values.
9. Return only the structured scenario object required by the supplied schema.

Examples:

User: What if the harvest day in F1 changes to 2026-09-25?
{"description":"Harvest F1 on 2026-09-25","changes":[{"target":"action","where":{"field_id":{"op":"eq","value":"F1"},"operation":{"op":"eq","value":"harvest"}},"constraints":{"selected":{"op":"eq","value":true},"date":{"op":"eq","value":"2026-09-25"}}}]}

User: Add 3 ML of available water on 2026-09-20.
{"description":"Add 3 ML of water on 2026-09-20","changes":[{"target":"water_availability_daily","where":{"date":{"op":"eq","value":"2026-09-20"}},"update":{"available_water_ml":{"op":"add","value":3.0}}}]}

User: Don't spray F2.
{"description":"Do not spray F2","changes":[{"target":"action","where":{"field_id":{"op":"eq","value":"F2"},"operation":{"op":"eq","value":"spray"}},"constraints":{"selected":{"op":"eq","value":false}}}]}
`.trim();

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMClientLike {
  chat(messages: ChatMessage[], options?: { responseSchema?: Record<string, unknown>; maxOutputTokens?: number }): Promise<string>;
}

export class ScenarioParser {
  private llm: LLMClientLike;
  validator: ScenarioValidator;

  constructor(llm: LLMClientLike, validator?: ScenarioValidator) {
    this.llm = llm;
    this.validator = validator ?? new ScenarioValidator();
  }

  private extractJson(text: string): unknown {
    let trimmed = text.trim();
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, "");
    trimmed = trimmed.replace(/\s*```$/, "");

    try {
      return JSON.parse(trimmed);
    } catch {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(trimmed.slice(start, end + 1));
      }
      throw new Error("Could not locate a JSON object in the LLM response");
    }
  }

  private responseSchema(): Record<string, unknown> {
    const schema = structuredClone(this.validator.responseSchema()) as any;
    delete schema.properties.mode;
    schema.required = schema.required.filter((f: string) => f !== "mode");
    return schema;
  }

  async parse(request: string): Promise<ScenarioInterpretation> {
    const today = new Date().toISOString().slice(0, 10);
    const prompt = `Current date in Australia/Melbourne: ${today}

FarmOpti schema and current identifiers:
${this.validator.describeForLlmJson()}

User scenario request:
${request}

Compile this scenario into the supplied FarmOpti DSL.`;

    const response = await this.llm.chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      { responseSchema: this.responseSchema(), maxOutputTokens: 800 },
    );

    let parsed: any;
    try {
      parsed = this.extractJson(response);
    } catch (exc) {
      throw new ScenarioValidationError(`Could not parse LLM scenario as JSON: ${exc}`);
    }

    return this.validator.validateInterpretation({ mode: "scenario", ...parsed });
  }
}
