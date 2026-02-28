import type { EffectLedger } from '../effects/effect-ledger.js';
import type { BudgetSnapshot } from '../types/budget.js';
import type { LlmClient, LlmCompletionRequest, LlmCompletionResponse } from './types.js';

export function createTrackedLlm(
  inner: LlmClient,
  effectLedger: EffectLedger,
  tick: number,
  recordBudget: (usage: Partial<BudgetSnapshot>) => void,
): LlmClient {
  return {
    async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
      const effect = effectLedger.register(
        {
          type: 'external_api',
          action: 'llm_completion',
          parameters: {
            modelId: req.modelId,
            messageCount: req.messages.length,
          },
          idempotencyKey: undefined,
        },
        tick,
      );

      effectLedger.markExecuting(effect.id);

      let response: LlmCompletionResponse;
      try {
        response = await inner.complete(req);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        effectLedger.fail(effect.id, error.message);
        throw err;
      }

      effectLedger.commit(effect.id, {
        modelId: response.modelId,
        stopReason: response.stopReason,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });

      recordBudget({
        tokensUsed: response.usage.totalTokens,
        estimatedCostUsd: response.usage.estimatedCostUsd,
        apiCalls: 1,
      });

      return response;
    },
  };
}
