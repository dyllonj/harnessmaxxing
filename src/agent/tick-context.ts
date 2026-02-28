import type { BudgetSnapshot } from '../types/budget.js';
import type { EffectLedger } from '../effects/effect-ledger.js';
import type { LlmClient } from '../llm/types.js';
import type { ToolSurface } from '../tools/tool-types.js';
import type { TaskTracker } from '../tasks/task-tracker.js';
import type { ElicitationRequest } from '../elicitation/elicitation-types.js';
import type { SubAgentRequest } from '../spawning/spawning-types.js';

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
  // Layer 0: Core (every agent)
  state: S;
  tick: number;
  epoch: number;
  inbox: InboxDrain;
  budget: BudgetSnapshot;
  recordBudget(usage: Partial<BudgetSnapshot>): void;
  sleep(ms: number): void;

  // Layer 1: Execution (optional)
  effects: EffectLedger;
  llm?: LlmClient;
  tools?: ToolSurface;

  // Layer 2: Planning (optional)
  tasks?: TaskTracker;
  askUser?(request: Omit<ElicitationRequest, 'id'>): void;

  // Layer 3: Delegation (optional)
  spawnSubAgent?(request: SubAgentRequest): void;
};

export type { EffectLedger } from '../effects/effect-ledger.js';
