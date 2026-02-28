import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import type { MessageBus } from './bus/message-bus.js';
import type { CheckpointStore } from './checkpoint/checkpoint-store.js';
import type { LifecycleState } from './types/lifecycle.js';
import type { Heartbeat, SemanticHealth } from './types/heartbeat.js';
import type { Checkpoint } from './types/checkpoint.js';
import type { Message, Subscription } from './types/message.js';
import type { Budget, BudgetLimits, BudgetSnapshot } from './types/budget.js';
import type { SupervisorConfig, ChildSpec } from './types/supervisor.js';
import type { InboxDrain, InboxMessage, TickContext } from './agent/tick-context.js';
import type { AgentLike, TickLoopDeps, TickLoop } from './agent/tick-loop.js';
import { createTickLoop } from './agent/tick-loop.js';
import { LifecycleStateMachine } from './lifecycle/state-machine.js';
import { BudgetEnforcer } from './budget/budget-enforcer.js';
import { EffectLedger } from './effects/effect-ledger.js';
import { Supervisor } from './supervisor/supervisor.js';
import { buildHeartbeat } from './heartbeat/heartbeat-builder.js';
import { computeChecksum } from './checkpoint/checksum.js';
import { createDefaultRecoveryConfig } from './types/supervisor.js';
import { createHookRegistry } from './lifecycle/hook-registry.js';
import type { HookRegistry } from './types/hooks.js';

export type RuntimeConfig = {
  redis?: { url: string };
  sqlite?: { path: string };
  supervisor?: SupervisorConfig;
  logger?: { level: string };
  _bus?: MessageBus;
  _store?: CheckpointStore;
};

export type RuntimeHandle = {
  spawn(agentDef: AgentDefinition): Promise<string>;
  send(agentId: string, message: Record<string, unknown>): Promise<void>;
  query(agentId: string): Promise<AgentStatus>;
  kill(agentId: string): Promise<void>;
  shutdown(): Promise<void>;
};

export type AgentDefinition = {
  name: string;
  handler: (ctx: TickContext<Record<string, unknown>>) => Promise<void>;
  config: {
    budget: BudgetLimits;
    tickIntervalMs: number;
    checkpointEveryNTicks: number;
  };
};

export type AgentStatus = {
  id: string;
  state: LifecycleState;
  epoch: number;
  tick: number;
  lastHeartbeat?: Heartbeat;
  budgetUsage: BudgetSnapshot;
};

type ManagedAgent = {
  agentLike: AgentLike<Record<string, unknown>>;
  tickLoop: TickLoop;
  stateMachine: LifecycleStateMachine;
  budgetEnforcer: BudgetEnforcer;
  effectLedger: EffectLedger;
  hooks: HookRegistry;
  inboxSubscription: Subscription;
  lastCheckpointId: string | null;
  runPromise: Promise<void>;
  definition: AgentDefinition;
};

function createAgentLikeFromHandler(
  agentId: string,
  handler: (ctx: TickContext<Record<string, unknown>>) => Promise<void>,
): AgentLike<Record<string, unknown>> {
  return {
    agentId,
    epoch: 0,
    tick: 0,
    state: {},
    onTick: handler,
    assessHealth(): SemanticHealth {
      return {
        status: 'healthy',
        progress: 0.5,
        coherence: 1.0,
        confidence: 1.0,
        stuckTicks: 0,
        lastMeaningfulAction: 'tick',
      };
    },
    async onCheckpoint(state: Record<string, unknown>) {
      return state;
    },
    async onError() {
      // no-op
    },
  };
}

function createMessageBusInbox(
  bus: MessageBus,
  agentId: string,
): { inbox: InboxDrain; subscriptionPromise: Promise<Subscription> } {
  const buffer: InboxMessage[] = [];
  const channel = `stream:commands:${agentId}`;

  const subscriptionPromise = bus.subscribe(channel, async (message: Message) => {
    const msgType = (message.payload['type'] as string) ?? 'unknown';
    buffer.push({
      id: message.id,
      type: msgType,
      payload: message.payload,
      timestamp: message.timestamp,
    });
  });

  const inbox: InboxDrain = {
    drain() {
      const msgs = buffer.splice(0, buffer.length);
      return msgs;
    },
    peek() {
      return [...buffer];
    },
    count() {
      return buffer.length;
    },
  };

  return { inbox, subscriptionPromise };
}

function createCheckpointSink(
  agentId: string,
  agent: AgentLike<Record<string, unknown>>,
  store: CheckpointStore,
  stateMachine: LifecycleStateMachine,
  budgetEnforcer: BudgetEnforcer,
  effectLedger: EffectLedger,
  lastCheckpointIdRef: { value: string | null },
): (state: unknown) => Promise<void> {
  return async (state: unknown) => {
    const id = uuidv4();
    const budgetSnap = budgetEnforcer.snapshot();
    const committed = effectLedger.getCommitted();
    const pending = effectLedger.getPending();

    const checkpointWithoutChecksum: Omit<Checkpoint, 'checksum'> = {
      id,
      agentId,
      epoch: agent.epoch,
      tick: agent.tick,
      timestamp: Date.now(),
      llmState: {
        systemPrompt: '',
        conversationHistory: [],
        contextWindowUsage: 0,
        modelId: '',
        temperature: 0,
      },
      externalState: {
        taskQueue: [],
        completedTasks: [],
        keyValueStore: state as Record<string, unknown>,
        pendingEffects: pending.map((e) => ({
          id: e.id,
          tick: e.tick,
          type: e.type,
          action: e.intent.action,
          description: e.intent.action,
          status: e.status as 'pending' | 'committed' | 'failed',
          timestamp: e.timestamps.registered,
          idempotencyKey: e.intent.idempotencyKey,
        })),
        committedEffects: committed.map((e) => ({
          id: e.id,
          tick: e.tick,
          type: e.type,
          action: e.intent.action,
          description: e.intent.action,
          status: 'committed' as const,
          timestamp: e.timestamps.registered,
          idempotencyKey: e.intent.idempotencyKey,
        })),
      },
      metadata: {
        lifecycleState: stateMachine.state,
        parentAgentId: null,
        childAgentIds: [],
        budget: budgetSnap,
        lastHeartbeat: buildHeartbeat(
          agentId,
          agent.epoch,
          agent.tick,
          { status: 'healthy', progress: 0.5, coherence: 1, confidence: 1, stuckTicks: 0, lastMeaningfulAction: 'checkpoint' },
          { tokensUsed: budgetSnap.tokensUsed, tokensRemaining: 0, estimatedCostUsd: budgetSnap.estimatedCostUsd, wallTimeMs: budgetSnap.wallTimeMs, apiCalls: budgetSnap.apiCalls, toolInvocations: budgetSnap.toolInvocations },
          { state: stateMachine.state, currentTask: null, activeTools: [], pendingEffects: pending.length, subAgents: [], contextWindowUsage: 0, tickDurationMs: 0, tickRate: 0 },
        ),
        createdAt: Date.now(),
        restoredFrom: lastCheckpointIdRef.value,
      },
      previousCheckpointId: lastCheckpointIdRef.value,
    };

    const checksum = computeChecksum(checkpointWithoutChecksum);
    const checkpoint: Checkpoint = { ...checkpointWithoutChecksum, checksum };
    await store.save(checkpoint);
    lastCheckpointIdRef.value = id;
  };
}

function budgetLimitsToSupervisorBudget(limits: BudgetLimits, softPercent = 80): Budget {
  const soft = (v: number) => Math.floor(v * (softPercent / 100));
  return {
    tokens: { soft: soft(limits.tokensUsed), hard: limits.tokensUsed },
    costUsd: { soft: soft(limits.estimatedCostUsd), hard: limits.estimatedCostUsd },
    wallTimeMs: { soft: soft(limits.wallTimeMs), hard: limits.wallTimeMs },
    toolInvocations: { soft: soft(limits.toolInvocations), hard: limits.toolInvocations },
  };
}

export async function createRuntime(config?: RuntimeConfig): Promise<RuntimeHandle> {
  const redisUrl = config?.redis?.url ?? 'redis://localhost:6379';
  const sqlitePath = config?.sqlite?.path ?? './data/checkpoints.db';
  const logLevel = config?.logger?.level ?? 'info';

  const log = pino({ name: 'runtime', level: logLevel });

  let store: CheckpointStore;
  let bus: MessageBus;
  let ownsBus = false;
  let ownsStore = false;

  if (config?._store) {
    store = config._store;
  } else {
    // Dynamically import to avoid requiring better-sqlite3 when injected
    const { SQLiteCheckpointStore } = await import('./checkpoint/sqlite-checkpoint-store.js') as { SQLiteCheckpointStore: new (path: string) => CheckpointStore };
    store = new SQLiteCheckpointStore(sqlitePath);
    ownsStore = true;
  }

  if (config?._bus) {
    bus = config._bus;
  } else {
    const { RedisMessageBus } = await import('./bus/redis-message-bus.js') as { RedisMessageBus: new (url: string) => MessageBus };
    bus = new RedisMessageBus(redisUrl);
    ownsBus = true;
  }

  let supervisor: Supervisor | null = null;
  if (config?.supervisor) {
    supervisor = new Supervisor(config.supervisor, bus, store);
    void supervisor.start();
  }

  const registry = new Map<string, ManagedAgent>();
  let isShutdown = false;

  const handleSignal = () => {
    void handle.shutdown();
  };
  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);

  async function spawnAgent(agentDef: AgentDefinition): Promise<string> {
    return spawnAgentWithEpoch(agentDef, 0, 0, null);
  }

  async function spawnAgentWithEpoch(
    agentDef: AgentDefinition,
    epoch: number,
    startTick: number,
    restoredState: Record<string, unknown> | null,
  ): Promise<string> {
    const agentId = `${agentDef.name}-${uuidv4().slice(0, 8)}`;
    return registerAgent(agentId, agentDef, epoch, startTick, restoredState);
  }

  async function registerAgent(
    agentId: string,
    agentDef: AgentDefinition,
    epoch: number,
    startTick: number,
    restoredState: Record<string, unknown> | null,
  ): Promise<string> {
    const stateMachine = new LifecycleStateMachine();
    stateMachine.apply('spawn');
    stateMachine.apply('ready');

    const budgetEnforcer = new BudgetEnforcer(agentDef.config.budget);
    const effectLedger = new EffectLedger(agentId);
    const hooks = createHookRegistry(log);
    const agentLike = createAgentLikeFromHandler(agentId, agentDef.handler);
    agentLike.epoch = epoch;
    agentLike.tick = startTick;
    if (restoredState) {
      agentLike.state = restoredState;
    }

    const { inbox, subscriptionPromise } = createMessageBusInbox(bus, agentId);
    const subscription = await subscriptionPromise;

    const lastCheckpointIdRef = { value: null as string | null };
    const heartbeatSink = async (hb: Heartbeat) => {
      await bus.publishHeartbeat(agentId, hb);
    };
    const checkpointSink = createCheckpointSink(
      agentId,
      agentLike,
      store,
      stateMachine,
      budgetEnforcer,
      effectLedger,
      lastCheckpointIdRef,
    );

    const deps: TickLoopDeps<Record<string, unknown>> = {
      stateMachine,
      agent: agentLike,
      heartbeatSink,
      checkpointSink,
      inboxSource: inbox,
      budgetEnforcer,
      effectLedger,
      hooks,
    };

    const tickLoop = createTickLoop(deps, {
      baseIntervalMs: agentDef.config.tickIntervalMs,
      checkpointEveryNTicks: agentDef.config.checkpointEveryNTicks,
    }, {
      info(obj, msg) { log.info(obj, msg); },
      warn(obj, msg) { log.warn(obj, msg); },
      error(obj, msg) { log.error(obj, msg); },
    });

    if (supervisor) {
      const childSpec: ChildSpec = {
        id: agentId,
        agentId,
        config: {
          budget: budgetLimitsToSupervisorBudget(agentDef.config.budget),
          tickIntervalMs: agentDef.config.tickIntervalMs,
          checkpointEveryNTicks: agentDef.config.checkpointEveryNTicks,
        },
      };
      supervisor.addChild(childSpec);
    }

    const runPromise = tickLoop.start();

    const managed: ManagedAgent = {
      agentLike,
      tickLoop,
      stateMachine,
      budgetEnforcer,
      effectLedger,
      hooks,
      inboxSubscription: subscription,
      lastCheckpointId: lastCheckpointIdRef.value,
      runPromise,
      definition: agentDef,
    };

    registry.set(agentId, managed);

    // Recovery handler: when tick loop exits due to error, attempt recovery
    void runPromise.then(() => {
      if (stateMachine.state === 'ERROR' && !isShutdown) {
        void attemptRecovery(agentId, managed);
      }
    });

    return agentId;
  }

  async function attemptRecovery(agentId: string, managed: ManagedAgent): Promise<void> {
    log.info({ agentId }, 'Attempting recovery from checkpoint');

    const latest = await store.loadLatest(agentId);
    if (!latest) {
      log.warn({ agentId }, 'No checkpoint found for recovery, giving up');
      return;
    }

    // Clean up old registration
    await managed.inboxSubscription.unsubscribe();
    registry.delete(agentId);
    if (supervisor) {
      supervisor.removeChild(agentId);
    }

    // Re-register with incremented epoch
    const newEpoch = latest.epoch + 1;
    const restoredState = latest.externalState.keyValueStore;
    await registerAgent(agentId, managed.definition, newEpoch, latest.tick, restoredState);
    log.info({ agentId, newEpoch, fromTick: latest.tick }, 'Recovery successful');
  }

  async function sendMessage(agentId: string, message: Record<string, unknown>): Promise<void> {
    const channel = `stream:commands:${agentId}`;
    const msg: Message = {
      id: '',
      channel,
      timestamp: Date.now(),
      payload: { type: 'user_message', ...message },
    };
    await bus.publish(channel, msg);
  }

  async function queryAgent(agentId: string): Promise<AgentStatus> {
    const managed = registry.get(agentId);
    if (managed) {
      return {
        id: agentId,
        state: managed.stateMachine.state,
        epoch: managed.agentLike.epoch,
        tick: managed.agentLike.tick,
        budgetUsage: managed.budgetEnforcer.snapshot(),
      };
    }

    // Fall back to checkpoint store
    const latest = await store.loadLatest(agentId);
    if (latest) {
      return {
        id: agentId,
        state: latest.metadata.lifecycleState,
        epoch: latest.epoch,
        tick: latest.tick,
        lastHeartbeat: latest.metadata.lastHeartbeat,
        budgetUsage: latest.metadata.budget,
      };
    }

    return {
      id: agentId,
      state: 'DEAD',
      epoch: 0,
      tick: 0,
      budgetUsage: { tokensUsed: 0, estimatedCostUsd: 0, wallTimeMs: 0, toolInvocations: 0, apiCalls: 0 },
    };
  }

  async function killAgent(agentId: string): Promise<void> {
    const channel = `stream:commands:${agentId}`;
    const msg: Message = {
      id: '',
      channel,
      timestamp: Date.now(),
      payload: { type: 'kill' },
    };
    await bus.publish(channel, msg);

    if (supervisor) {
      supervisor.removeChild(agentId);
    }
  }

  async function shutdown(): Promise<void> {
    if (isShutdown) return;
    isShutdown = true;

    log.info('Runtime shutting down');

    process.removeListener('SIGTERM', handleSignal);
    process.removeListener('SIGINT', handleSignal);

    // Stop all tick loops
    for (const [, managed] of registry) {
      managed.tickLoop.stop();
    }

    // Await run promises with a timeout
    const promises = [...registry.values()].map((m) => m.runPromise);
    if (promises.length > 0) {
      await Promise.race([
        Promise.allSettled(promises),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    }

    // Unsubscribe inboxes
    for (const [, managed] of registry) {
      await managed.inboxSubscription.unsubscribe();
    }

    if (supervisor) {
      await supervisor.stop();
    }

    // Close bus/store if they have close methods
    if (ownsBus && 'close' in bus && typeof (bus as Record<string, unknown>)['close'] === 'function') {
      await (bus as unknown as { close(): Promise<void> }).close();
    }
    if (ownsStore && 'close' in store && typeof (store as Record<string, unknown>)['close'] === 'function') {
      (store as unknown as { close(): void }).close();
    }

    registry.clear();
    log.info('Runtime shut down complete');
  }

  const handle: RuntimeHandle = {
    spawn: spawnAgent,
    send: sendMessage,
    query: queryAgent,
    kill: killAgent,
    shutdown,
  };

  return handle;
}

// Module-level convenience functions using a default runtime singleton
let defaultRuntime: RuntimeHandle | null = null;

export async function spawn(agentDef: AgentDefinition): Promise<string> {
  if (!defaultRuntime) {
    defaultRuntime = await createRuntime();
  }
  return defaultRuntime.spawn(agentDef);
}

export async function send(agentId: string, message: Record<string, unknown>): Promise<void> {
  if (!defaultRuntime) {
    throw new Error('No default runtime — call spawn() first or createRuntime() explicitly');
  }
  return defaultRuntime.send(agentId, message);
}

export async function query(agentId: string): Promise<AgentStatus> {
  if (!defaultRuntime) {
    throw new Error('No default runtime — call spawn() first or createRuntime() explicitly');
  }
  return defaultRuntime.query(agentId);
}

export async function kill(agentId: string): Promise<void> {
  if (!defaultRuntime) {
    throw new Error('No default runtime — call spawn() first or createRuntime() explicitly');
  }
  return defaultRuntime.kill(agentId);
}
