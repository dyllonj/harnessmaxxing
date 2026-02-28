import { randomUUID } from 'node:crypto';
import type { LifecycleStateMachine } from '../lifecycle/state-machine.js';
import type { LifecycleState } from '../types/lifecycle.js';
import type { Heartbeat, SemanticHealth } from '../types/heartbeat.js';
import type { HookRegistry } from '../types/hooks.js';
import { buildHeartbeat } from '../heartbeat/heartbeat-builder.js';
import type { BudgetEnforcer } from '../budget/budget-enforcer.js';
import type { EffectLedger } from '../effects/effect-ledger.js';
import type { InboxDrain, TickContext } from './tick-context.js';
import type { LlmClient } from '../llm/types.js';
import { createTrackedLlm } from '../llm/create-tracked-llm.js';
import type { ToolRegistry } from '../tools/tool-types.js';
import { createTrackedToolSurface } from '../tools/create-tracked-tool.js';
import type { TaskTracker } from '../tasks/task-tracker.js';
import type { ElicitationRequest, PendingElicitation } from '../elicitation/elicitation-types.js';
import type { SubAgentRequest } from '../spawning/spawning-types.js';

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
  elicitationRequested: boolean;
  elicitationRequest: Omit<ElicitationRequest, 'id'> | null;
  spawnRequests: SubAgentRequest[];
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
  budgetEnforcer: BudgetEnforcer;
  effectLedger: EffectLedger;
  hooks?: HookRegistry;
  clock?: { delay(ms: number): Promise<void> };

  // Layer 1: Execution
  llmClient?: LlmClient;
  toolRegistry?: ToolRegistry;

  // Layer 2: Planning
  taskTracker?: TaskTracker;
  elicitationSink?: (request: ElicitationRequest) => Promise<void>;

  // Layer 3: Delegation
  spawnSink?: (parentAgentId: string, request: SubAgentRequest) => Promise<string>;
  childAgentIds?: string[];
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
  let currentElicitation: PendingElicitation | null = null;

  async function run(): Promise<void> {
    running = true;
    let consecutiveHeartbeatFailures = 0;

    while (running && isRunnable(deps.stateMachine.state)) {
      let forceCheckpoint = false;
      let hadWork = false;

      // Step 1: Budget check
      const budgetResult = deps.budgetEnforcer.check();
      if (budgetResult.status === 'hard_limit') {
        log.warn({ budgetResult: budgetResult.status }, 'Hard budget limit reached');
        deps.stateMachine.apply('budget_exhausted');
        break;
      }
      if (budgetResult.status === 'soft_limit') {
        log.info({ budgetResult: budgetResult.status }, 'Soft budget limit reached, forcing checkpoint');
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
        await deps.hooks?.fire('PRE_KILL', { agentId: deps.agent.agentId, timestamp: Date.now(), reason: 'kill_message' });
        break;
      }
      if (messages.length > 0) {
        hadWork = true;
      }

      // Step 3: Execute work
      const signals: TickSignals = { sleepRequested: false, sleepMs: 0, elicitationRequested: false, elicitationRequest: null, spawnRequests: [] };
      const agentState = deps.agent.state;
      if (agentState === null) {
        log.error({}, 'Agent state is null, cannot execute tick');
        deps.stateMachine.apply('error');
        break;
      }

      const snapshot = deps.budgetEnforcer.snapshot();
      const ctx: TickContext<S> = {
        state: agentState,
        tick: deps.agent.tick,
        epoch: deps.agent.epoch,
        inbox: deps.inboxSource,
        effects: deps.effectLedger,
        sleep(ms: number) {
          signals.sleepRequested = true;
          signals.sleepMs = ms;
        },
        budget: snapshot,
        recordBudget(usage: Partial<import('../types/budget.js').BudgetSnapshot>) {
          deps.budgetEnforcer.record(usage);
        },
        ...(deps.taskTracker ? { tasks: deps.taskTracker } : {}),
      };

      // Layer 1: Wire tools (optional)
      if (deps.toolRegistry) {
        ctx.tools = createTrackedToolSurface(
          deps.toolRegistry,
          deps.effectLedger,
          deps.agent.tick,
          (usage) => deps.budgetEnforcer.record(usage),
        );
      }

      // Layer 2: Wire elicitation (optional)
      if (deps.elicitationSink) {
        ctx.askUser = (request: Omit<ElicitationRequest, 'id'>) => {
          signals.elicitationRequested = true;
          signals.elicitationRequest = request;
        };
      }

      // Layer 3: Wire sub-agent spawning (optional)
      if (deps.spawnSink) {
        ctx.spawnSubAgent = (request: SubAgentRequest) => {
          signals.spawnRequests.push(request);
        };
      }

      // Layer 1: Wire LLM (optional)
      if (deps.llmClient) {
        ctx.llm = createTrackedLlm(
          deps.llmClient,
          deps.effectLedger,
          deps.agent.tick,
          (usage) => deps.budgetEnforcer.record(usage),
        );
      }

      await deps.hooks?.fire('PRE_TICK', { agentId: deps.agent.agentId, timestamp: Date.now(), tickNumber: deps.agent.tick });
      const tickStartMs = Date.now();

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

      const tickDurationMs = Date.now() - tickStartMs;
      await deps.hooks?.fire('POST_TICK', { agentId: deps.agent.agentId, timestamp: Date.now(), tickNumber: deps.agent.tick, durationMs: tickDurationMs });

      // Post-tick: process deferred sub-agent spawn requests
      if (signals.spawnRequests.length > 0 && deps.spawnSink) {
        for (const spawnReq of signals.spawnRequests) {
          try {
            const childId = await deps.spawnSink(deps.agent.agentId, spawnReq);
            deps.childAgentIds?.push(childId);
            log.info({ childId, name: spawnReq.name }, 'Sub-agent spawned');
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            log.warn({ error: error.message, name: spawnReq.name }, 'Sub-agent spawn failed (non-fatal)');
          }
        }
      }

      // Post-tick: handle elicitation (blocks via sleep/wake)
      if (signals.elicitationRequested && signals.elicitationRequest && deps.elicitationSink) {
        const requestId = randomUUID();
        const fullRequest: ElicitationRequest = {
          id: requestId,
          ...signals.elicitationRequest,
        };
        currentElicitation = { request: fullRequest, createdAt: Date.now() };
        await deps.hooks?.fire('PRE_SLEEP', { agentId: deps.agent.agentId, timestamp: Date.now(), reason: 'awaiting_human' });
        log.info({ requestId, question: fullRequest.question }, 'Agent requesting human input, transitioning to sleep');
        await deps.elicitationSink(fullRequest);
        deps.stateMachine.apply('sleep');
        break;
      }

      if (signals.sleepRequested) {
        currentElicitation = null;
        await deps.hooks?.fire('PRE_SLEEP', { agentId: deps.agent.agentId, timestamp: Date.now(), reason: 'agent_requested' });
        log.info({ sleepMs: signals.sleepMs }, 'Agent requested sleep');
        deps.stateMachine.apply('sleep');
        break;
      }

      // Step 4: Emit heartbeat
      const activeToolNames = deps.toolRegistry ? deps.toolRegistry.list().map((t) => t.name) : [];
      const currentTask = deps.taskTracker
        ? (deps.taskTracker.listInProgress()[0]?.description ?? null)
        : null;
      const subAgents = deps.childAgentIds ? [...deps.childAgentIds] : [];

      try {
        const health = deps.agent.assessHealth(ctx);
        const heartbeat = buildHeartbeat(
          deps.agent.agentId,
          deps.agent.epoch,
          deps.agent.tick,
          health,
          {
            tokensUsed: snapshot.tokensUsed,
            tokensRemaining: 0,
            estimatedCostUsd: snapshot.estimatedCostUsd,
            wallTimeMs: snapshot.wallTimeMs,
            apiCalls: snapshot.apiCalls,
            toolInvocations: snapshot.toolInvocations,
          },
          {
            state: deps.stateMachine.state,
            currentTask,
            activeTools: activeToolNames,
            pendingEffects: deps.effectLedger.getPending().length,
            subAgents,
            contextWindowUsage: 0,
            tickDurationMs,
            tickRate: 0,
            pendingElicitation: currentElicitation
              ? { requestId: currentElicitation.request.id, question: currentElicitation.request.question }
              : undefined,
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
          await deps.hooks?.fire('PRE_CHECKPOINT', { agentId: deps.agent.agentId, timestamp: Date.now() });
          const checkpointState = await deps.agent.onCheckpoint(agentState);
          await deps.checkpointSink(checkpointState);
          await deps.hooks?.fire('POST_CHECKPOINT', { agentId: deps.agent.agentId, timestamp: Date.now() });
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
