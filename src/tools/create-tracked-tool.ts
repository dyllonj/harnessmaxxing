import type { EffectLedger } from '../effects/effect-ledger.js';
import type { BudgetSnapshot } from '../types/budget.js';
import type { ToolRegistry, ToolSurface } from './tool-types.js';

export function createTrackedToolSurface(
  registry: ToolRegistry,
  effectLedger: EffectLedger,
  tick: number,
  recordBudget: (usage: Partial<BudgetSnapshot>) => void,
): ToolSurface {
  return {
    list() {
      return registry.list();
    },

    has(name: string) {
      return registry.has(name);
    },

    async execute(name: string, input: Record<string, unknown>): Promise<unknown> {
      const effect = effectLedger.register(
        {
          type: 'tool_call',
          action: name,
          parameters: input,
          idempotencyKey: undefined,
        },
        tick,
      );

      effectLedger.markExecuting(effect.id);

      let result: unknown;
      try {
        result = await registry.execute(name, input);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        effectLedger.fail(effect.id, error.message);
        throw err;
      }

      effectLedger.commit(effect.id, result);

      recordBudget({
        toolInvocations: 1,
      });

      return result;
    },
  };
}
