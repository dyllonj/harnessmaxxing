import type { LlmMessage } from '../types/checkpoint.js';

export type LlmCompletionRequest = {
  messages: LlmMessage[];
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  systemPrompt?: string;
};

export type LlmTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

export type LlmCompletionResponse = {
  message: LlmMessage;
  usage: LlmTokenUsage;
  modelId: string;
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence';
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
