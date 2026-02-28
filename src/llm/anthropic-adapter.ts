import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmClientConfig, LlmCompletionRequest, LlmCompletionResponse, LlmTokenUsage } from './types.js';
import type { LlmMessage } from '../types/checkpoint.js';

// Cost per million tokens (input/output) by model family
const MODEL_PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'claude-opus-4': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-sonnet-4': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-haiku-3-5': { inputPerMillion: 0.8, outputPerMillion: 4 },
  'claude-3-5-sonnet': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-3-5-haiku': { inputPerMillion: 0.8, outputPerMillion: 4 },
  'claude-3-opus': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-3-sonnet': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-3-haiku': { inputPerMillion: 0.25, outputPerMillion: 1.25 },
};

function lookupPricing(modelId: string): { inputPerMillion: number; outputPerMillion: number } {
  // Try exact match first
  if (MODEL_PRICING[modelId]) {
    return MODEL_PRICING[modelId];
  }

  // Try prefix match (e.g. 'claude-sonnet-4-20250514' matches 'claude-sonnet-4')
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    if (modelId.startsWith(prefix)) {
      return pricing;
    }
  }

  // Default fallback
  return { inputPerMillion: 3, outputPerMillion: 15 };
}

function computeCost(
  inputTokens: number,
  outputTokens: number,
  modelId: string,
): number {
  const pricing = lookupPricing(modelId);
  return (inputTokens * pricing.inputPerMillion + outputTokens * pricing.outputPerMillion) / 1_000_000;
}

type AnthropicStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;

function mapStopReason(reason: AnthropicStopReason): 'end_turn' | 'max_tokens' | 'stop_sequence' {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'tool_use':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

function extractSystemPrompt(
  messages: LlmMessage[],
  requestSystemPrompt?: string,
): { system: string | undefined; userMessages: Array<{ role: 'user' | 'assistant'; content: string }> } {
  let system = requestSystemPrompt;
  const userMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = system ? `${system}\n${msg.content}` : msg.content;
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      userMessages.push({ role: msg.role, content: msg.content });
    }
    // 'tool' role messages are skipped in this simple adapter
  }

  return { system, userMessages };
}

export function createAnthropicClient(config: LlmClientConfig): LlmClient {
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  });

  return {
    async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
      const modelId = req.modelId ?? config.modelId;
      const temperature = req.temperature ?? config.temperature;
      const maxTokens = req.maxTokens ?? config.maxTokens;

      const { system, userMessages } = extractSystemPrompt(req.messages, req.systemPrompt);

      if (userMessages.length === 0) {
        throw new Error('At least one user or assistant message is required');
      }

      const response = await client.messages.create({
        model: modelId,
        max_tokens: maxTokens,
        temperature,
        ...(system ? { system } : {}),
        messages: userMessages,
        ...(req.stopSequences ? { stop_sequences: req.stopSequences } : {}),
      });

      const outputText = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const estimatedCostUsd = computeCost(inputTokens, outputTokens, modelId);

      const usage: LlmTokenUsage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimatedCostUsd,
      };

      return {
        message: {
          role: 'assistant',
          content: outputText,
        },
        usage,
        modelId,
        stopReason: mapStopReason(response.stop_reason),
        raw: response,
      };
    },
  };
}
