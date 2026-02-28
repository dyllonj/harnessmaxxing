import type { LlmMessage } from '../types/checkpoint.js';

export type TextBlock = {
  type: 'text';
  text: string;
};

export type ToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type LlmToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type LlmCompletionRequest = {
  messages: LlmMessage[];
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  systemPrompt?: string;
  tools?: LlmToolDefinition[];
  tool_choice?: 'auto' | 'any' | { type: 'tool'; name: string };
};

export type LlmTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

export type LlmCompletionResponse = {
  message: LlmMessage;
  content: ContentBlock[];
  usage: LlmTokenUsage;
  modelId: string;
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  raw?: unknown;
};

export type LlmClient = {
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse>;
};

export type LlmClientConfig = {
  modelId: string;
  temperature: number;
  maxTokens: number;
  apiKey: string;
  baseUrl?: string;
};
