import type { EnforcerBudgetSnapshot } from '../types/budget.js';
import type { EffectLedger } from '../effects/effect-ledger.js';

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
  budget: EnforcerBudgetSnapshot;
  recordBudget(usage: Partial<EnforcerBudgetSnapshot>): void;
};

export type { EffectLedger } from '../effects/effect-ledger.js';
