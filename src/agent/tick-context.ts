import type { BudgetSnapshot } from '../types/budget.js';

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

export type EffectLedger = {
  register(intent: { type: string; action: string; parameters?: unknown; idempotencyKey?: string }): string;
  commit(effectId: string): void;
  fail(effectId: string, error: Error): void;
  pending(): number;
};

export type TickContext<S> = {
  state: S;
  tick: number;
  epoch: number;
  inbox: InboxDrain;
  effects: EffectLedger;
  sleep(ms: number): void;
  budget: BudgetSnapshot;
};
