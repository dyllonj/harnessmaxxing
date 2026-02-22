# Sprint 06: Supervisor

**Goal:** Implement the supervisor: health assessment, recovery engine, and the one_for_one restart strategy.

**RFC Reference:** Section 5.5 (Supervisor Architecture), Section 5.6 (Recovery Strategies -- Hot Restart, Warm Restart only for MVP), Section 7.2 (Supervisor Configuration)

**Depends on:** Sprint 02 (lifecycle), Sprint 03 (heartbeat/tick), Sprint 04 (checkpoint store), Sprint 05 (message bus)

---

## Deliverables

### 1. Supervisor types (`src/types/supervisor.ts`)

```typescript
export type RecoveryStrategyType =
  | 'hot_restart'
  | 'warm_restart'
  | 'context_reconstruction'
  | 'fresh_start'
  | 'escalate';

export type HealthSeverity = 'warning' | 'degraded' | 'error' | 'critical';

export type HealthPolicy =
  | 'missed_heartbeats'
  | 'stuck_ticks'
  | 'coherence_spiral'
  | 'budget_preemption';

export type HealthPolicyConfig = {
  maxMissedHeartbeats: number;    // default: 3
  maxStuckTicks: number;          // default: 5
  coherenceThreshold: number;     // default: 0.3 (below this = spiral)
  coherenceWindowSize: number;    // default: 5 (consecutive ticks below threshold)
  budgetWarningPercent: number;   // default: 80
  budgetHardLimitPercent: number; // default: 95
};

export type RecoveryConfig = {
  maxRestartsPerEpoch: number;    // default: 3
  restartWindow: number;          // milliseconds, default: 300_000 (5 min)
  strategies: RecoveryStrategyType[]; // ordered fallback list, default: ['hot_restart', 'warm_restart', 'escalate']
};

export type ChildSpec = {
  id: string;
  agentId: string;
  config: {
    budget: Budget;
    tickIntervalMs: number;
    checkpointEveryNTicks: number;
  };
};

export type SupervisorConfig = {
  strategy: 'one_for_one';        // MVP only supports one_for_one
  healthPolicy: HealthPolicyConfig;
  recovery: RecoveryConfig;
  children: ChildSpec[];
};

export type HealthVerdict = {
  agentId: string;
  severity: HealthSeverity;
  policiesFired: HealthPolicy[];
  recommendedAction: RecoveryStrategyType;
  timestamp: number;
  details: Record<string, unknown>;
};
```

Import `Budget` from `@/types/heartbeat` (defined in Sprint 03). Export all types from `src/types/index.ts`.

### 2. Health Assessor (`src/supervisor/health-assessor.ts`)

Class `HealthAssessor` evaluates heartbeats against the configured health policies and produces verdicts.

**Constructor:**
- Takes `HealthPolicyConfig`.
- Initializes an internal `Map<string, Heartbeat[]>` to store a sliding window of heartbeats per agent.
- Initializes an internal `Map<string, number>` for last-seen timestamps per agent.

**Sliding window:**
- Default window size: 30 heartbeats per agent.
- When a new heartbeat arrives, push it to the array. If the array exceeds the window size, shift the oldest entry off.

**Method `assess(agentId: string, heartbeat: Heartbeat): HealthVerdict | null`:**

Evaluate all four policies. Collect any that fire into a `policiesFired` array. If none fire, return `null` (agent is healthy).

**Policy evaluation logic:**

1. **Missed heartbeats (`missed_heartbeats`):**
   - Compare `Date.now()` against the last-seen timestamp for this agent.
   - If the gap exceeds `maxMissedHeartbeats * expectedTickInterval`, the policy fires.
   - For the assessor, the expected tick interval is derived from the gap between the two most recent heartbeats in the window (adaptive). If there is only one heartbeat, skip this policy.
   - Severity: `warning` at 1x threshold, `error` at 2x threshold, `critical` at 3x threshold.

2. **Stuck detection (`stuck_ticks`):**
   - Read `heartbeat.health.stuckTicks` from the incoming heartbeat.
   - If `stuckTicks >= config.maxStuckTicks`, the policy fires.
   - Severity: `degraded` at 1x threshold, `error` at 2x threshold.

3. **Budget preemption (`budget_preemption`):**
   - Read `heartbeat.budget.percentUsed` (or compute from `heartbeat.budget.used / heartbeat.budget.limit`).
   - If usage exceeds `budgetHardLimitPercent`, fire with severity `critical`.
   - If usage exceeds `budgetWarningPercent`, fire with severity `warning`.

4. **Coherence spiral (`coherence_spiral`):**
   - Look at the last `coherenceWindowSize` heartbeats in the sliding window.
   - If ALL of them have `heartbeat.health.coherenceScore < coherenceThreshold`, the policy fires.
   - Severity: `error`.

**Determining recommended action:**
- Map the highest severity to a recovery strategy:
  - `warning` -> no action (still return the verdict for logging, but `recommendedAction` = `'hot_restart'`)
  - `degraded` -> `'hot_restart'`
  - `error` -> `'warm_restart'`
  - `critical` -> `'escalate'`

**Method `getWindow(agentId: string): Heartbeat[]`:**
- Returns the current sliding window for inspection/testing.

**Method `reset(agentId: string): void`:**
- Clears the sliding window and last-seen timestamp for an agent.

### 3. Recovery Engine (`src/supervisor/recovery-engine.ts`)

Class `RecoveryEngine` executes recovery strategies.

**Constructor:**
- Takes `CheckpointStore` (from Sprint 04), `MessageBus` (from Sprint 05), and `RecoveryConfig`.
- Initializes an internal restart counter: `Map<string, { count: number, windowStart: number }>` per agent.

**Method `recover(verdict: HealthVerdict, strategy: RecoveryStrategyType): Promise<RecoveryResult>`:**

```typescript
export type RecoveryResult = {
  success: boolean;
  strategyUsed: RecoveryStrategyType;
  nextStrategy?: RecoveryStrategyType;
  details: string;
};
```

**Logic:**

1. Check the restart counter for this agent:
   - If `count >= config.maxRestartsPerEpoch` AND we are still within the `restartWindow`, escalate immediately. Return `{ success: false, strategyUsed: strategy, nextStrategy: 'escalate', details: 'max restarts exceeded' }`.
   - If the `restartWindow` has elapsed since `windowStart`, reset the counter to 0.

2. Increment the restart counter.

3. Execute the strategy:

   **`hot_restart`:**
   - Publish a `LifecycleCommand` with `type: 'recover'` to `stream:commands:{verdict.agentId}`.
   - The command payload includes `{ strategy: 'hot_restart', retryCurrentTick: true }`.
   - Return `{ success: true, strategyUsed: 'hot_restart', details: 'recovery command sent' }`.

   **`warm_restart`:**
   - Load the latest checkpoint from `CheckpointStore.getLatest(verdict.agentId)`.
   - If no checkpoint exists, return `{ success: false, ..., nextStrategy: 'fresh_start', details: 'no checkpoint found' }`.
   - Publish a `LifecycleCommand` with `type: 'recover'` to `stream:commands:{verdict.agentId}`.
   - Payload includes `{ strategy: 'warm_restart', checkpointId: checkpoint.id }`.
   - Return `{ success: true, strategyUsed: 'warm_restart', details: 'restoring from checkpoint ${checkpoint.id}' }`.

   **`context_reconstruction`:** Not implemented in MVP. Return `{ success: false, ..., nextStrategy: 'escalate', details: 'not implemented' }`.

   **`fresh_start`:** Not implemented in MVP. Return `{ success: false, ..., nextStrategy: 'escalate', details: 'not implemented' }`.

   **`escalate`:**
   - Publish a `LifecycleCommand` with `type: 'kill'` to `stream:commands:{verdict.agentId}`.
   - Log the escalation with full verdict details.
   - Return `{ success: false, strategyUsed: 'escalate', details: 'agent killed after recovery exhaustion' }`.

**Method `getRestartCount(agentId: string): number`:**
- Returns the current restart count for the agent (for testing/inspection).

**Method `resetCounters(): void`:**
- Clears all restart counters.

### 4. Supervisor (`src/supervisor/supervisor.ts`)

Class `Supervisor` ties health assessment and recovery together.

**Constructor:**
- Takes `SupervisorConfig`, `MessageBus`, and `CheckpointStore`.
- Creates a `HealthAssessor` from `config.healthPolicy`.
- Creates a `RecoveryEngine` from `config.recovery`.
- Initializes a `Map<string, NodeJS.Timeout>` for per-agent watchdog timers.
- Initializes a `Map<string, ChildSpec>` for registered children.

**Method `start(): Promise<void>`:**
- Register all children from `config.children`.
- Subscribe to `stream:heartbeats` with pattern `*` via `messageBus.subscribeHeartbeats()`.
- The heartbeat handler:
  1. Resets the watchdog timer for this agent (clear old timer, set new one).
  2. Calls `healthAssessor.assess(agentId, heartbeat)`.
  3. If a verdict is returned:
     - Log the verdict (pino, level based on severity).
     - Determine the strategy: use `verdict.recommendedAction`, but respect the ordered `recovery.strategies` list. If the recommended action is not in the list, use the first strategy in the list.
     - Call `recoveryEngine.recover(verdict, strategy)`.
     - If recovery fails and `result.nextStrategy` is provided, call `recover` again with the next strategy (one retry only, to prevent infinite loops).
  4. If no verdict, this is a healthy heartbeat. Optionally log at debug level.
- Set up watchdog timers for each child:
  - Timer fires after `(maxMissedHeartbeats + 1) * child.config.tickIntervalMs` milliseconds.
  - When a watchdog fires, synthesize a `HealthVerdict` with `policiesFired: ['missed_heartbeats']`, severity `critical`.
  - Feed the synthesized verdict into the recovery engine.

**Method `stop(): Promise<void>`:**
- Unsubscribe from the heartbeat stream.
- Clear all watchdog timers.

**Method `addChild(spec: ChildSpec): void`:**
- Registers a new child agent. Sets up its watchdog timer.

**Method `removeChild(agentId: string): void`:**
- Removes a child agent. Clears its watchdog timer. Resets its health assessor window.

**Method `getChildren(): ChildSpec[]`:**
- Returns all registered children.

**`one_for_one` strategy:**
- When recovery is triggered for an agent, ONLY that agent is affected. No sibling agents are restarted or notified. This is the defining characteristic of `one_for_one` and the only strategy implemented in the MVP.

### 5. Index file (`src/supervisor/index.ts`)

Export `HealthAssessor`, `RecoveryEngine`, `Supervisor`, and all types.

### 6. Tests

#### `test/unit/supervisor/health-assessor.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { HealthAssessor } from '@/supervisor/health-assessor';
```

Test a default `HealthPolicyConfig` with known thresholds. Create mock heartbeats with builder helpers.

Test cases:

- **Healthy heartbeat produces no verdict**: Send a heartbeat with normal values. `assess()` returns `null`.
- **Stuck detection fires**: Send a heartbeat with `stuckTicks` >= `maxStuckTicks`. Verify verdict has `policiesFired: ['stuck_ticks']`.
- **Stuck detection below threshold**: Send heartbeat with `stuckTicks` = `maxStuckTicks - 1`. Returns `null`.
- **Budget warning fires**: Heartbeat with 85% budget usage (above 80% warning threshold). Verify severity `warning`.
- **Budget hard limit fires**: Heartbeat with 96% budget usage. Verify severity `critical`.
- **Coherence spiral fires**: Send `coherenceWindowSize` consecutive heartbeats all with coherence below threshold. Verify policy fires on the last one.
- **Coherence spiral does NOT fire if window is incomplete**: Send fewer than `coherenceWindowSize` low-coherence heartbeats. Returns `null`.
- **Coherence spiral resets**: Send low-coherence heartbeats, then one healthy heartbeat, then more low-coherence. Should not fire because the window was broken.
- **Multiple policies fire simultaneously**: Heartbeat with stuck ticks AND low coherence. Verify `policiesFired` contains both.
- **Sliding window ages out old heartbeats**: Push 40 heartbeats (window size 30). Verify `getWindow()` has exactly 30.
- **Severity escalation**: Verify that higher severity policies produce correspondingly more aggressive `recommendedAction`.
- **Reset clears agent state**: Assess some heartbeats, call `reset(agentId)`, verify `getWindow()` is empty.

#### `test/unit/supervisor/recovery-engine.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { RecoveryEngine } from '@/supervisor/recovery-engine';
import { InMemoryCheckpointStore } from '../../helpers/in-memory-checkpoint-store';
import { InMemoryMessageBus } from '../../helpers/in-memory-message-bus';
```

Create mock `HealthVerdict` objects. Use in-memory implementations for dependencies.

Test cases:

- **Hot restart sends recovery command**: Call `recover()` with `hot_restart`. Verify a `LifecycleCommand` was published to `stream:commands:{agentId}` with `type: 'recover'` and `strategy: 'hot_restart'`.
- **Warm restart loads checkpoint**: Store a checkpoint in the `InMemoryCheckpointStore`. Call `recover()` with `warm_restart`. Verify the command references the checkpoint ID.
- **Warm restart with no checkpoint fails gracefully**: No checkpoint stored. Call `recover()` with `warm_restart`. Verify `success: false` and `nextStrategy` is set.
- **Escalation sends kill command**: Call `recover()` with `escalate`. Verify a kill command was published.
- **Restart counter increments**: Call `recover()` 3 times. Verify `getRestartCount()` returns 3.
- **Max restarts triggers escalation**: Set `maxRestartsPerEpoch: 2`. Call `recover()` 3 times with `hot_restart`. Third call should escalate.
- **Restart window resets counter**: Set `restartWindow: 100`. Call `recover()` twice. Wait 150ms. Call `recover()` again. Counter should have reset, so it should succeed (not escalate).
- **Unimplemented strategies return failure**: Call `recover()` with `context_reconstruction`. Verify `success: false`.
- **resetCounters clears all state**: Recover a few times, call `resetCounters()`, verify `getRestartCount()` returns 0.

#### `test/unit/supervisor/supervisor.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Supervisor } from '@/supervisor/supervisor';
import { InMemoryMessageBus } from '../../helpers/in-memory-message-bus';
import { InMemoryCheckpointStore } from '../../helpers/in-memory-checkpoint-store';
```

Create a `SupervisorConfig` with one child agent. Use in-memory bus and checkpoint store.

Test cases:

- **Start subscribes to heartbeat stream**: Call `start()`. Verify the in-memory bus has a subscriber on `stream:heartbeats`.
- **Healthy heartbeat produces no recovery action**: Publish a healthy heartbeat. Verify no commands were published to the agent's command stream.
- **Unhealthy heartbeat triggers recovery**: Publish a heartbeat with high `stuckTicks`. Verify a recovery command was published.
- **Watchdog timer fires on missing heartbeats**: Start supervisor with a child. Do NOT publish any heartbeats. Use `vi.advanceTimersByTime()` (fake timers) to fast-forward past the watchdog timeout. Verify a recovery action was taken.
- **Watchdog timer resets on heartbeat**: Start supervisor, publish a heartbeat (resets timer), advance time by less than the timeout, publish another heartbeat. Verify no watchdog firing.
- **one_for_one only affects failed agent**: Register two children. Publish unhealthy heartbeat for child A. Verify recovery command was sent ONLY to child A, not child B.
- **Stop cleans up**: Call `start()`, then `stop()`. Verify heartbeat subscription is removed and watchdog timers are cleared.
- **addChild registers new agent**: Call `addChild()` after start. Publish heartbeat for new child. Verify it is assessed.
- **removeChild stops monitoring**: Register a child, call `removeChild()`. Publish heartbeat for removed child. Verify no assessment.

---

## Acceptance Criteria

- [ ] Health assessor correctly evaluates all four MVP policies (missed heartbeats, stuck detection, budget preemption, coherence spiral)
- [ ] Health assessor returns `null` for healthy heartbeats (no false positives)
- [ ] Recovery engine implements hot restart and warm restart strategies
- [ ] Recovery engine escalates when max restarts per epoch are exceeded
- [ ] Recovery engine restart window correctly resets the counter after the time window elapses
- [ ] Supervisor subscribes to heartbeat stream and responds to health verdicts
- [ ] Supervisor watchdog timers detect missing heartbeats
- [ ] `one_for_one` strategy only restarts the failed agent, siblings are unaffected
- [ ] All types are exported from `src/types/index.ts` and `src/index.ts`
- [ ] `npm run typecheck` reports 0 errors
- [ ] All tests pass with in-memory implementations (no Redis or SQLite required)

---

## Estimated Scope

Large. ~10 files, complex interactions:
- `src/types/supervisor.ts`
- `src/supervisor/health-assessor.ts`
- `src/supervisor/recovery-engine.ts`
- `src/supervisor/supervisor.ts`
- `src/supervisor/index.ts`
- `test/unit/supervisor/health-assessor.test.ts`
- `test/unit/supervisor/recovery-engine.test.ts`
- `test/unit/supervisor/supervisor.test.ts`
- Updates to `src/types/index.ts`
- Updates to `src/index.ts`
