/**
 * Anthropic-style tool definition. Each optimizer pipeline stage (and the
 * scenario runner) is exposed through this same shape so any LLM/agent can
 * introspect what's available (`registry.list()`) and invoke it uniformly
 * (`registry.call(name, input)`), instead of the caller needing to know
 * which TS module implements which stage.
 *
 * The sequence these are called in is still decided in code (pipeline.ts) --
 * only the call mechanism is tool-shaped, not the ordering decision.
 */
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema | { type: string; description?: string; [key: string]: unknown }>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  [key: string]: unknown;
}

export interface ToolDefinition<Input = any, Output = any> {
  name: string;
  description: string;
  input_schema: JsonSchema;
  execute: (input: Input) => Promise<Output> | Output;
}
