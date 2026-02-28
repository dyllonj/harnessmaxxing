import type { BudgetSnapshot } from '../types/budget.js';
import type { EffectLedger } from '../effects/effect-ledger.js';
import type { LlmClient } from '../llm/types.js';

export type InboxMessage = {
  id: string;
  type: string;
  payload: unknown;
  timestamp: number;
};

export type InboxDrain = {
  drain(): InboxMessage[];
  peek(): InboxMessage[];
  count(): number;
};

export type TickContext<S> = {
  state: S;
  tick: number;
  epoch: number;
  inbox: InboxDrain;
  effects: EffectLedger;
  sleep(ms: number): void;
  budget: BudgetSnapshot;
  recordBudget(usage: Partial<BudgetSnapshot>): void;
  llm?: LlmClient;
};

export type { EffectLedger } from '../effects/effect-ledger.js';
