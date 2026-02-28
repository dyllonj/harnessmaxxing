import type { ToolDefinition, ToolHandler, ToolRegistry, RegisteredTool } from './tool-types.js';

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, RegisteredTool>();

  return {
    register(definition: ToolDefinition, handler: ToolHandler): void {
      if (tools.has(definition.name)) {
        throw new Error(`Tool already registered: "${definition.name}"`);
      }
      tools.set(definition.name, { definition, handler });
    },

    list(): ToolDefinition[] {
      return Array.from(tools.values()).map((t) => t.definition);
    },

    async execute(name: string, input: Record<string, unknown>): Promise<unknown> {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`Unknown tool: "${name}". Registered tools: ${Array.from(tools.keys()).join(', ') || '(none)'}`);
      }
      return tool.handler(input);
    },

    has(name: string): boolean {
      return tools.has(name);
    },

    get(name: string): RegisteredTool | undefined {
      return tools.get(name);
    },
  };
}
