import type { LifecycleStateMachine } from '../lifecycle/state-machine.js';
import type { LifecycleState } from '../types/lifecycle.js';
import type { Heartbeat, SemanticHealth } from '../types/heartbeat.js';
import type { Budget, BudgetSnapshot } from '../types/budget.js';
import { checkBudget } from '../types/budget.js';
import { buildHeartbeat } from '../heartbeat/heartbeat-builder.js';
import type { InboxDrain, InboxMessage, EffectLedger, TickContext } from './tick-context.js';

export type TickLoopConfig = {
  baseIntervalMs: number;
  idleIntervalMs: number;
  sleepIntervalMs: number;
  checkpointEveryNTicks: number;
  maxConsecutiveHeartbeatFailures: number;
};

type TickSignals = {
  sleepRequested: boolean;
  sleepMs: number;
};

export type AgentLike<S extends Record<string, unknown> = Record<string, unknown>> = {
  agentId: string;
  epoch: number;
  tick: number;
  state: S | null;
  onTick(ctx: TickContext<S>): Promise<void>;
  assessHealth(ctx: TickContext<S>): SemanticHealth;
  onCheckpoint(state: S): Promise<S>;
  onError(error: Error): Promise<void>;
};

export type TickLoopDeps<S extends Record<string, unknown> = Record<string, unknown>> = {
  stateMachine: LifecycleStateMachine;
  agent: AgentLike<S>;
  heartbeatSink: (heartbeat: Heartbeat) => Promise<void>;
  checkpointSink: (state: unknown) => Promise<void>;
  inboxSource: InboxDrain;
  budget: Budget;
  budgetSnapshot: BudgetSnapshot;
  clock?: { delay(ms: number): Promise<void> };
};

export type TickLoop = {
  start(): Promise<void>;
  stop(): void;
};

type Logger = {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
};

function createStubEffectLedger(): EffectLedger {
  return {
    register() { return 'stub'; },
    commit() { /* no-op */ },
    fail() { /* no-op */ },
    pending() { return 0; },
  };
}

function isRunnable(state: LifecycleState): boolean {
  const nonRunnable: LifecycleState[] = ['DEAD', 'SLEEPING', 'CHECKPOINTED', 'ERROR', 'ARCHIVED'];
  return !nonRunnable.includes(state);
}

function determineInterval(hadWork: boolean, config: TickLoopConfig): number {
  return hadWork ? config.baseIntervalMs : config.idleIntervalMs;
}

const DEFAULT_CONFIG: TickLoopConfig = {
  baseIntervalMs: 100,
  idleIntervalMs: 2000,
  sleepIntervalMs: 30000,
  checkpointEveryNTicks: 10,
  maxConsecutiveHeartbeatFailures: 5,
};

export function createTickLoop<S extends Record<string, unknown>>(
  deps: TickLoopDeps<S>,
  config?: Partial<TickLoopConfig>,
  logger?: Logger,
): TickLoop {
  const cfg: TickLoopConfig = { ...DEFAULT_CONFIG, ...config };
  const clock = deps.clock ?? { delay: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
  const log: Logger = logger ?? {
    info() { /* no-op */ },
    warn() { /* no-op */ },
    error() { /* no-op */ },
  };

  let running = false;

  async function run(): Promise<void> {
    running = true;
    let consecutiveHeartbeatFailures = 0;

    while (running && isRunnable(deps.stateMachine.state)) {
      let forceCheckpoint = false;
      let hadWork = false;

      // Step 1: Budget check
      const budgetResult = checkBudget(deps.budget, deps.budgetSnapshot);
      if (budgetResult === 'hard_limit') {
        log.warn({ budgetResult }, 'Hard budget limit reached');
        deps.stateMachine.apply('budget_exhausted');
        break;
      }
      if (budgetResult === 'soft_limit') {
        log.info({ budgetResult }, 'Soft budget limit reached, forcing checkpoint');
        forceCheckpoint = true;
      }

      // Step 2: Process inbox
      const messages = deps.inboxSource.drain();
      let killed = false;
      for (const msg of messages) {
        if (msg.type === 'kill') {
          log.info({ messageId: msg.id }, 'Kill message received');
          deps.stateMachine.apply('kill');
          killed = true;
          break;
        }
        if (msg.type === 'checkpoint') {
          forceCheckpoint = true;
        }
      }
      if (killed) {
        break;
      }
      if (messages.length > 0) {
        hadWork = true;
      }

      // Step 3: Execute work
      const signals: TickSignals = { sleepRequested: false, sleepMs: 0 };
      const agentState = deps.agent.state;
      if (agentState === null) {
        log.error({}, 'Agent state is null, cannot execute tick');
        deps.stateMachine.apply('error');
        break;
      }

      const ctx: TickContext<S> = {
        state: agentState,
        tick: deps.agent.tick,
        epoch: deps.agent.epoch,
        inbox: deps.inboxSource,
        effects: createStubEffectLedger(),
        sleep(ms: number) {
          signals.sleepRequested = true;
          signals.sleepMs = ms;
        },
        budget: { ...deps.budgetSnapshot },
      };

      try {
        await deps.agent.onTick(ctx);
        hadWork = true;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error({ error: error.message }, 'onTick threw an error');
        deps.stateMachine.apply('error');
        await deps.agent.onError(error);
        break;
      }

      if (signals.sleepRequested) {
        log.info({ sleepMs: signals.sleepMs }, 'Agent requested sleep');
        deps.stateMachine.apply('sleep');
        break;
      }

      // Step 4: Emit heartbeat
      try {
        const health = deps.agent.assessHealth(ctx);
        const heartbeat = buildHeartbeat(
          deps.agent.agentId,
          deps.agent.epoch,
          deps.agent.tick,
          health,
          {
            tokensUsed: deps.budgetSnapshot.tokensUsed,
            tokensRemaining: 0,
            estimatedCostUsd: deps.budgetSnapshot.estimatedCostUsd,
            wallTimeMs: deps.budgetSnapshot.wallTimeMs,
            apiCalls: 0,
            toolInvocations: deps.budgetSnapshot.invocations,
          },
          {
            state: deps.stateMachine.state,
            currentTask: null,
            activeTools: [],
            pendingEffects: 0,
            subAgents: [],
            contextWindowUsage: 0,
            tickDurationMs: 0,
            tickRate: 0,
          },
        );
        await deps.heartbeatSink(heartbeat);
        consecutiveHeartbeatFailures = 0;
      } catch (err) {
        consecutiveHeartbeatFailures++;
        const error = err instanceof Error ? err : new Error(String(err));
        log.warn({ error: error.message, failures: consecutiveHeartbeatFailures }, 'Heartbeat emission failed');
        if (consecutiveHeartbeatFailures >= cfg.maxConsecutiveHeartbeatFailures) {
          log.error({ failures: consecutiveHeartbeatFailures }, 'Max consecutive heartbeat failures reached');
          deps.stateMachine.apply('error');
          break;
        }
      }

      // Step 5: Conditional checkpoint
      const tickNumber = deps.agent.tick;
      if (forceCheckpoint || (tickNumber > 0 && tickNumber % cfg.checkpointEveryNTicks === 0)) {
        try {
          const checkpointState = await deps.agent.onCheckpoint(agentState);
          await deps.checkpointSink(checkpointState);
          log.info({ tick: tickNumber }, 'Checkpoint saved');
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          log.warn({ error: error.message }, 'Checkpoint failed (non-fatal)');
        }
      }

      // Step 6: Yield
      deps.agent.tick++;
      const interval = determineInterval(hadWork, cfg);
      await clock.delay(interval);
    }

    running = false;
  }

  return {
    start: run,
    stop() {
      running = false;
    },
  };
}
