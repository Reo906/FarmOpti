import type { ToolDefinition } from "./types";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Anthropic-style tool list, suitable for handing straight to a `tools:` param. */
  list(): { name: string; description: string; input_schema: ToolDefinition["input_schema"] }[] {
    return [...this.tools.values()].map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}. Available: ${[...this.tools.keys()].join(", ")}`);
    return tool;
  }

  async call<Output = unknown>(name: string, input: unknown): Promise<Output> {
    const tool = this.get(name);
    return tool.execute(input) as Promise<Output>;
  }
}
