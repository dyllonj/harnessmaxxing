# Sprint 03: Tick Loop & Heartbeat Protocol

**Goal:** Implement the tick loop (the agent's execution cycle) and the heartbeat protocol (structured health telemetry).

**RFC Reference:** Section 5.3 (The Tick Cycle), Section 5.4 (Heartbeat Protocol), Section 4 (Core Concepts — Tick, Heartbeat)

**Depends on:** Sprint 02 (Lifecycle State Machine)

---

## Deliverables

### 1. Heartbeat types (`src/types/heartbeat.ts`)

Must match RFC Section 5.4 exactly:

```typescript
export type HealthStatus = 'healthy' | 'degraded' | 'critical';

export type SemanticHealth = {
  status: HealthStatus;
  progress: number;            // 0-1, self-assessed task progress
  coherence: number;           // 0-1, self-assessed output quality
  confidence: number;          // 0-1, confidence in current approach
  stuckTicks: number;          // consecutive ticks with no meaningful progress
  lastMeaningfulAction: string;
};

export type ResourceConsumption = {
  tokensUsed: number;
  tokensRemaining: number;
  estimatedCostUsd: number;
  wallTimeMs: number;
  apiCalls: number;
  toolInvocations: number;
};

export type ExecutionMetadata = {
  state: LifecycleState;
  currentTask: string | null;
  activeTools: string[];
  pendingEffects: number;
  subAgents: string[];
  contextWindowUsage: number;  // 0-1
  tickDurationMs: number;
  tickRate: number;            // ticks per second
};

export type Heartbeat = {
  // Identity
  agentId: string;
  epoch: number;
  tick: number;
  timestamp: number;

  // Semantic Health
  health: SemanticHealth;

  // Resource Consumption
  resources: ResourceConsumption;

  // Execution Metadata
  execution: ExecutionMetadata;
};
```

Import `LifecycleState` from `@/types/lifecycle`.

### 2. Budget types (`src/types/budget.ts`)

```typescript
export type Budget = {
  tokens: { soft: number; hard: number };
  costUsd: { soft: number; hard: number };
  wallTimeMs: { soft: number; hard: number };
  invocations: { soft: number; hard: number };
};

export type BudgetSnapshot = {
  tokensUsed: number;
  estimatedCostUsd: number;
  wallTimeMs: number;
  invocations: number;
};

export type BudgetCheckResult = 'ok' | 'soft_limit' | 'hard_limit';
```

Implement a pure function:

```typescript
export function checkBudget(budget: Budget, current: BudgetSnapshot): BudgetCheckResult
```

Logic: Check each of the 4 dimensions (tokens, cost, wallTime, invocations). If ANY dimension exceeds its hard limit, return `'hard_limit'`. If ANY dimension exceeds its soft limit (but no hard limits are exceeded), return `'soft_limit'`. Otherwise return `'ok'`.

### 3. Heartbeat builder (`src/heartbeat/heartbeat-builder.ts`)

```typescript
export function buildHeartbeat(
  agentId: string,
  epoch: number,
  tick: number,
  health: SemanticHealth,
  resources: ResourceConsumption,
  execution: ExecutionMetadata,
): Heartbeat
```

- Pure function, no side effects
- Sets `timestamp` to `Date.now()`
- Validates that `agentId` is non-empty, `epoch >= 0`, `tick >= 0`
- Validates that health scores are in [0, 1] range (progress, coherence, confidence, contextWindowUsage)
- Throws if validation fails
- Fills defaults for optional fields: `stuckTicks` defaults to 0, `lastMeaningfulAction` defaults to `'none'`, `activeTools` defaults to `[]`, `subAgents` defaults to `[]`

### 4. Tick context (`src/agent/tick-context.ts`)

Define the `TickContext<S>` type. This is the interface an agent sees during `onTick`:

```typescript
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

// Stub interface for Sprint 07 implementation
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
```

The `sleep()` method does not actually pause execution. It signals to the tick loop that the agent wants to transition to `SLEEPING` state after the current tick completes. The tick loop reads this signal and applies the `sleep` trigger to the state machine.

### 5. Tick loop (`src/agent/tick-loop.ts`)

Implement the 6-step tick cycle from RFC Section 5.3. This can be a class or a standalone function/module.

```typescript
export type TickLoopConfig = {
  baseIntervalMs: number;        // default: 100
  idleIntervalMs: number;        // default: 2000
  sleepIntervalMs: number;       // default: 30000
  checkpointEveryNTicks: number; // default: 10
  maxConsecutiveHeartbeatFailures: number; // default: 5
};

export type TickLoopDeps = {
  stateMachine: LifecycleStateMachine;
  agent: AgentLike;              // interface, not the full Agent class
  heartbeatSink: (heartbeat: Heartbeat) => Promise<void>;
  checkpointSink: (state: unknown) => Promise<void>;
  inboxSource: InboxDrain;
  budget: Budget;
  budgetSnapshot: BudgetSnapshot;
};
```

The tick loop implements the following 6 steps on each iteration:

**Step 1: Budget check.** Call `checkBudget(budget, budgetSnapshot)`. If `hard_limit`, apply `budget_exhausted` trigger to state machine and stop the loop. If `soft_limit`, trigger a checkpoint (step 5 forced).

**Step 2: Process inbox.** Drain the inbox. Lifecycle commands (kill, pause, checkpoint) are processed immediately and may short-circuit the tick. Work items are passed to step 3.

**Step 3: Execute work unit.** Call `agent.onTick(ctx)` wrapped in try/catch. If it throws, apply `error` trigger to the state machine. Do NOT let the error propagate — the tick loop must never crash.

**Step 4: Emit heartbeat.** Call `agent.assessHealth(ctx)` to get semantic health. Build the heartbeat via `buildHeartbeat`. Push to `heartbeatSink`. If heartbeat emission fails, increment a failure counter. If failures exceed `maxConsecutiveHeartbeatFailures`, apply `error` trigger.

**Step 5: Conditional checkpoint.** Checkpoint if: (a) `tick % checkpointEveryNTicks === 0`, or (b) soft budget limit was crossed in step 1, or (c) the agent signaled a checkpoint. Call `agent.onCheckpoint(state)` then `checkpointSink`.

**Step 6: Yield.** Wait for the adaptive interval before next tick. Interval is determined by:
- Active work (onTick did something): `baseIntervalMs` (0-100ms)
- Idle (empty inbox, no work): `idleIntervalMs` (1-5s)
- Sleeping state: `sleepIntervalMs` (30-60s)

The tick loop:
- Increments the tick counter after each completed tick
- Runs in a `while` loop that checks the state machine (stops if state is DEAD, SLEEPING, CHECKPOINTED, ERROR)
- Is the ONLY thing that calls `agent.onTick()`
- Must be stoppable (expose a `stop()` method or use `AbortController`)

### 6. Agent base class stub (`src/agent/agent.ts`)

Abstract class `Agent<S>`:

```typescript
export abstract class Agent<S> {
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
    this.budgetSnapshot = { tokensUsed: 0, estimatedCostUsd: 0, wallTimeMs: 0, invocations: 0 };
  }

  // Required overrides
  abstract onInitialize(): Promise<S>;
  abstract onTick(ctx: TickContext<S>): Promise<void>;

  // Optional overrides with defaults
  assessHealth(ctx: TickContext<S>): SemanticHealth {
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

  async onRestore(state: S): Promise<void> {
    // no-op
  }

  async onError(error: Error): Promise<void> {
    // default: log
  }

  async onShutdown(): Promise<void> {
    // no-op
  }
}
```

The Agent class is NOT responsible for running the tick loop. The tick loop is an external component that drives the agent. The Agent class holds state and provides lifecycle method hooks.

### 7. Wall-clock watchdog (`src/agent/watchdog.ts`)

Independent watchdog that fires on a `setInterval`, decoupled from the tick loop:

```typescript
export type WatchdogConfig = {
  intervalMs: number;  // default: 30000
};

export type WatchdogSignal = {
  agentId: string;
  timestamp: number;
  type: 'watchdog';
};

export class Watchdog {
  constructor(agentId: string, config?: Partial<WatchdogConfig>);
  start(): void;
  stop(): void;
  onSignal(handler: (signal: WatchdogSignal) => void): void;
}
```

- Uses `setInterval` internally
- Emits a lightweight signal with just `agentId` + `timestamp` on each interval
- Works even when the tick loop is blocked (stuck LLM call, long tool execution)
- Must be stoppable (`clearInterval` on `stop()`)
- Does not import or depend on the tick loop

### 8. Tests

#### `test/unit/heartbeat/heartbeat-builder.test.ts`

- Test building a valid heartbeat with all fields
- Test that `timestamp` is set automatically
- Test validation: empty agentId throws, negative epoch throws, negative tick throws
- Test validation: progress outside [0,1] throws, coherence outside [0,1] throws
- Test default values are filled correctly

#### `test/unit/agent/tick-loop.test.ts`

- Test the 6-step cycle executes in order with a mock agent
- Test that `onTick` is called exactly once per tick
- Test adaptive tick rate: mock an active agent (short interval) vs idle agent (long interval)
- Test error handling: `onTick` throws -> state machine transitions to ERROR, loop stops
- Test budget exhaustion: configure a budget with 0 remaining tokens -> `budget_exhausted` trigger fires, loop stops before calling `onTick`
- Test checkpoint trigger: verify checkpoint fires every N ticks
- Test soft budget limit triggers a checkpoint
- Test that the loop stops when state is DEAD
- Test that `stop()` halts the loop

#### `test/unit/budget/budget-check.test.ts`

- Test `ok` when all dimensions are below soft limits
- Test `soft_limit` for each dimension independently (tokens, cost, wallTime, invocations)
- Test `hard_limit` for each dimension independently
- Test that `hard_limit` takes priority over `soft_limit` (if tokens hit hard but cost hit soft, result is `hard_limit`)
- Test edge cases: exact boundary values (equal to soft limit = soft_limit, equal to hard limit = hard_limit)

#### `test/unit/agent/watchdog.test.ts`

- Test that the watchdog emits signals at the configured interval
- Test that `stop()` prevents further signals
- Test that the signal contains the correct agentId and a recent timestamp

---

## Acceptance Criteria

- [ ] Heartbeat type matches RFC Section 5.4 exactly (all fields, all types)
- [ ] Tick loop follows the 6-step sequence from RFC Section 5.3
- [ ] Errors in `onTick()` transition to ERROR state (never a process crash)
- [ ] Budget check runs BEFORE work execution (step 1 before step 3)
- [ ] Hard budget limit stops the tick loop immediately
- [ ] Soft budget limit triggers a checkpoint
- [ ] Adaptive tick rate adjusts interval based on activity level
- [ ] Watchdog fires independently of the tick loop on its own `setInterval`
- [ ] Agent base class has all lifecycle methods from RFC Section 7.1
- [ ] `checkBudget` correctly evaluates all 4 dimensions with soft/hard thresholds
- [ ] All tests pass
- [ ] `npm run typecheck` reports 0 errors

---

## Estimated Scope

Medium-large. ~12 files. This sprint implements the core execution model — the tick loop is the heart of the system.
