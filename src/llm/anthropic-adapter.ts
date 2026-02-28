import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmClientConfig, LlmCompletionRequest, LlmCompletionResponse, LlmTokenUsage, ContentBlock } from './types.js';
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

function mapStopReason(reason: string | null): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'tool_use':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

function stringifyContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

type AnthropicMessageParam = Anthropic.Messages.MessageParam;

function buildMessages(
  messages: LlmMessage[],
  requestSystemPrompt?: string,
): { system: string | undefined; apiMessages: AnthropicMessageParam[] } {
  let system = requestSystemPrompt;
  const apiMessages: AnthropicMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = stringifyContent(msg.content);
      system = system ? `${system}\n${text}` : text;
    } else if (msg.role === 'tool') {
      // Tool result messages become user messages with tool_result content blocks
      const toolContent = stringifyContent(msg.content);
      apiMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.toolCallId ?? '',
          content: toolContent,
        }],
      });
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        apiMessages.push({ role: 'assistant', content: msg.content });
      } else {
        // Map ContentBlock[] to Anthropic content block format
        const anthropicBlocks: Anthropic.Messages.ContentBlockParam[] = msg.content.map((block) => {
          if (block.type === 'text') {
            return { type: 'text' as const, text: block.text };
          }
          if (block.type === 'tool_use') {
            return {
              type: 'tool_use' as const,
              id: block.id,
              name: block.name,
              input: block.input,
            };
          }
          // tool_result blocks should not appear in assistant messages,
          // but handle gracefully by converting to text
          return { type: 'text' as const, text: `[tool_result for ${block.tool_use_id}]: ${block.content}` };
        });
        apiMessages.push({ role: 'assistant', content: anthropicBlocks });
      }
    } else if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        apiMessages.push({ role: 'user', content: msg.content });
      } else {
        const anthropicBlocks: Anthropic.Messages.ContentBlockParam[] = msg.content.map((block) => {
          if (block.type === 'text') {
            return { type: 'text' as const, text: block.text };
          }
          if (block.type === 'tool_result') {
            return {
              type: 'tool_result' as const,
              tool_use_id: block.tool_use_id,
              content: block.content,
            };
          }
          // tool_use blocks should not appear in user messages,
          // but handle gracefully
          return { type: 'text' as const, text: `[tool_use ${block.name}]: ${JSON.stringify(block.input)}` };
        });
        apiMessages.push({ role: 'user', content: anthropicBlocks });
      }
    }
  }

  return { system, apiMessages };
}

function parseResponseContent(responseContent: Anthropic.Messages.ContentBlock[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const block of responseContent) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    }
  }
  return blocks;
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

      const { system, apiMessages } = buildMessages(req.messages, req.systemPrompt);

      if (apiMessages.length === 0) {
        throw new Error('At least one user or assistant message is required');
      }

      const createParams: Anthropic.Messages.MessageCreateParamsNonStreaming = {
        model: modelId,
        max_tokens: maxTokens,
        temperature,
        ...(system ? { system } : {}),
        messages: apiMessages,
        ...(req.stopSequences ? { stop_sequences: req.stopSequences } : {}),
        ...(req.tools ? { tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool['input_schema'],
        })) } : {}),
        ...(req.tool_choice ? {
          tool_choice: typeof req.tool_choice === 'string'
            ? { type: req.tool_choice } as Anthropic.Messages.ToolChoiceAuto | Anthropic.Messages.ToolChoiceAny
            : { type: 'tool' as const, name: req.tool_choice.name },
        } : {}),
      };

      const response = await client.messages.create(createParams);

      const contentBlocks = parseResponseContent(response.content);

      const outputText = contentBlocks
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
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
        content: contentBlocks,
        usage,
        modelId,
        stopReason: mapStopReason(response.stop_reason),
        raw: response,
      };
    },
  };
}
