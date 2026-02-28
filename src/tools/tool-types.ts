export type ToolInputSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
};

export type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

export type RegisteredTool = {
  definition: ToolDefinition;
  handler: ToolHandler;
};

export type ToolRegistry = {
  register(definition: ToolDefinition, handler: ToolHandler): void;
  list(): ToolDefinition[];
  execute(name: string, input: Record<string, unknown>): Promise<unknown>;
  has(name: string): boolean;
  get(name: string): RegisteredTool | undefined;
};

export type ToolSurface = {
  list(): ToolDefinition[];
  execute(name: string, input: Record<string, unknown>): Promise<unknown>;
  has(name: string): boolean;
};
