import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmTokenUsage,
} from '@/llm/types';
import type { LlmMessage } from '@/types/checkpoint';

export type MockLlmClient = LlmClient & {
  getCalls(): LlmCompletionRequest[];
  getCallCount(): number;
  getLastCall(): LlmCompletionRequest | undefined;
  addResponse(response: LlmCompletionResponse): void;
  clear(): void;
};

export type MockLlmConfig = {
  responses?: LlmCompletionResponse[];
};

export function createMockLlm(config?: MockLlmConfig): MockLlmClient {
  const responses: LlmCompletionResponse[] = [...(config?.responses ?? [])];
  const calls: LlmCompletionRequest[] = [];
  let callIndex = 0;

  return {
    async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
      calls.push(req);
      if (callIndex >= responses.length) {
        throw new Error(
          `MockLLM: response queue exhausted after ${callIndex} calls. ` +
          `Add more responses with addResponse() or pass them in the config.`,
        );
      }
      const response = responses[callIndex]!;
      callIndex++;
      return response;
    },

    getCalls(): LlmCompletionRequest[] {
      return [...calls];
    },

    getCallCount(): number {
      return calls.length;
    },

    getLastCall(): LlmCompletionRequest | undefined {
      return calls.length > 0 ? calls[calls.length - 1] : undefined;
    },

    addResponse(response: LlmCompletionResponse): void {
      responses.push(response);
    },

    clear(): void {
      calls.length = 0;
      responses.length = 0;
      callIndex = 0;
    },
  };
}

export function createMockResponse(
  content: string,
  overrides?: Partial<LlmCompletionResponse>,
): LlmCompletionResponse {
  const message: LlmMessage = {
    role: 'assistant',
    content,
  };

  const usage: LlmTokenUsage = {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    estimatedCostUsd: 0.001,
    ...overrides?.usage,
  };

  return {
    message,
    usage,
    modelId: 'mock-model',
    stopReason: 'end_turn',
    ...overrides,
    // Ensure message and usage from overrides are merged properly
    ...(overrides?.message ? { message: overrides.message } : { message }),
    ...(overrides?.usage ? { usage } : { usage }),
  };
}
