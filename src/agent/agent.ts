import { LifecycleStateMachine } from '../lifecycle/state-machine.js';
import type { SemanticHealth } from '../types/heartbeat.js';
import type { BudgetSnapshot } from '../types/budget.js';
import type { TickContext } from './tick-context.js';

export abstract class Agent<S extends Record<string, unknown>> {
  readonly agentId: string;
  epoch: number;
  tick: number;
  state: S | null;

  protected stateMachine: LifecycleStateMachine;
  protected budgetSnapshot: BudgetSnapshot;

  constructor(agentId: string) {
    this.agentId = agentId;
    this.epoch = 0;
    this.tick = 0;
    this.state = null;
    this.stateMachine = new LifecycleStateMachine();
    this.budgetSnapshot = { tokensUsed: 0, estimatedCostUsd: 0, wallTimeMs: 0, toolInvocations: 0, apiCalls: 0 };
  }

  abstract onInitialize(): Promise<S>;
  abstract onTick(ctx: TickContext<S>): Promise<void>;

  assessHealth(_ctx: TickContext<S>): SemanticHealth {
    return {
      status: 'healthy',
      progress: 0,
      coherence: 1,
      confidence: 1,
      stuckTicks: 0,
      lastMeaningfulAction: 'none',
    };
  }

  async onCheckpoint(state: S): Promise<S> {
    return state;
  }

  async onRestore(_state: S): Promise<void> {
    // no-op
  }

  async onError(_error: Error): Promise<void> {
    // no-op
  }

  async onShutdown(): Promise<void> {
    // no-op
  }
}
