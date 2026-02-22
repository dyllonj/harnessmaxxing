# Sprint 08: CLI & End-to-End Integration

**Goal:** Build the CLI tool, wire all components together, and validate the full end-to-end MVP scenario.

**RFC Reference:** Section 10.1 (MVP success criteria), Section 7.3 (Spawning and Interacting)

**Depends on:** ALL previous sprints (01-07)

---

## Deliverables

### 1. Public API (`src/index.ts`)

This is the ONLY entry point for consumers. Export everything a user needs.

```typescript
// Top-level functions
export { spawn, send, query, kill } from './runtime';

// Agent base class
export { Agent } from './agent/agent';

// Core types
export type { Heartbeat, HeartbeatHealth } from './types/heartbeat';
export type { Checkpoint } from './types/checkpoint';
export type { LifecycleState } from './types/lifecycle';
export type { Budget, BudgetLimits, BudgetSnapshot, BudgetCheckResult, BudgetDimension } from './types/budget';
export type { Effect, EffectStatus, EffectType } from './types/effect';
export type { Message, LifecycleCommand, Subscription } from './types/message';
export type { SupervisorConfig, HealthVerdict, ChildSpec } from './types/supervisor';

// Extension interfaces
export type { CheckpointStore } from './checkpoint/checkpoint-store';
export type { MessageBus } from './bus/message-bus';

// Concrete implementations
export { Supervisor } from './supervisor/supervisor';
export { EffectLedger } from './effects/effect-ledger';
export { BudgetEnforcer } from './budget/budget-enforcer';
export { SQLiteCheckpointStore } from './checkpoint/sqlite-checkpoint-store';
export { RedisMessageBus } from './bus/redis-message-bus';

// Runtime
export { createRuntime } from './runtime';
export type { RuntimeHandle, RuntimeConfig } from './runtime';
```

Adjust import paths to match the actual file structure from previous sprints. The exact paths may differ slightly -- the important thing is that everything is re-exported from this single file.

### 2. Runtime bootstrap (`src/runtime.ts`)

The runtime wires all components together and provides the top-level API.

**Types:**

```typescript
export type RuntimeConfig = {
  redis?: {
    url: string;              // default: 'redis://localhost:6379'
  };
  sqlite?: {
    path: string;             // default: './data/checkpoints.db'
  };
  supervisor?: SupervisorConfig;
  logger?: {
    level: string;            // default: 'info'
  };
};

export type RuntimeHandle = {
  spawn(agentDef: AgentDefinition): Promise<string>;   // returns agent ID
  send(agentId: string, message: unknown): Promise<void>;
  query(agentId: string): Promise<AgentStatus>;
  kill(agentId: string): Promise<void>;
  shutdown(): Promise<void>;
};

export type AgentDefinition = {
  name: string;
  handler: (context: TickContext) => Promise<void>;
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
```

**Function `createRuntime(config?: Partial<RuntimeConfig>): Promise<RuntimeHandle>`:**

1. Merge provided config with defaults.
2. Create a `pino` logger with the configured level.
3. Create a `SQLiteCheckpointStore` with the configured path.
4. Create a `RedisMessageBus` with the configured URL.
5. If `supervisor` config is provided, create a `Supervisor` and call `start()`.
6. Set up signal handlers:
   - `SIGTERM` and `SIGINT`: call `shutdown()` and then `process.exit(0)`.
   - Log "Shutting down gracefully..." on signal receipt.
7. Return a `RuntimeHandle` object.

**RuntimeHandle method implementations:**

- `spawn(agentDef)`:
  - Generate a unique agent ID: `${agentDef.name}-${uuidv4().slice(0, 8)}`.
  - Create the agent instance with the handler, budget, and tick interval.
  - Register as a child with the supervisor (if supervisor exists).
  - Start the agent's tick loop.
  - Return the agent ID.

- `send(agentId, message)`:
  - Publish a message to `stream:commands:{agentId}` via the message bus.
  - The message payload wraps the user-provided message.

- `query(agentId)`:
  - Load the latest checkpoint for this agent from the checkpoint store.
  - Construct and return an `AgentStatus` from the checkpoint data plus any cached last-heartbeat.

- `kill(agentId)`:
  - Publish a `LifecycleCommand` with `type: 'kill'` to `stream:commands:{agentId}`.
  - Remove the agent from the supervisor's children.

- `shutdown()`:
  - Kill all managed agents.
  - Stop the supervisor.
  - Close the message bus.
  - Close the checkpoint store.
  - Log "Runtime shut down."

**Convenience top-level functions** (module-level, for the simple API):

```typescript
let defaultRuntime: RuntimeHandle | null = null;

export async function spawn(agentDef: AgentDefinition): Promise<string> {
  if (!defaultRuntime) defaultRuntime = await createRuntime();
  return defaultRuntime.spawn(agentDef);
}

export async function send(agentId: string, message: unknown): Promise<void> {
  if (!defaultRuntime) throw new Error('Runtime not initialized. Call spawn() first.');
  return defaultRuntime.send(agentId, message);
}

export async function query(agentId: string): Promise<AgentStatus> {
  if (!defaultRuntime) throw new Error('Runtime not initialized. Call spawn() first.');
  return defaultRuntime.query(agentId);
}

export async function kill(agentId: string): Promise<void> {
  if (!defaultRuntime) throw new Error('Runtime not initialized. Call spawn() first.');
  return defaultRuntime.kill(agentId);
}
```

### 3. CLI commands (`src/cli/`)

Use `commander` for CLI argument parsing. Each subcommand is a separate file.

#### `src/cli/index.ts`

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { spawnCommand } from './spawn';
import { listCommand } from './list';
import { inspectCommand } from './inspect';
import { killCommand } from './kill';
import { logsCommand } from './logs';

const program = new Command();

program
  .name('harnessmaxxing')
  .description('Agent harness runtime CLI')
  .version('0.1.0');

program.addCommand(spawnCommand);
program.addCommand(listCommand);
program.addCommand(inspectCommand);
program.addCommand(killCommand);
program.addCommand(logsCommand);

program.parse();
```

The shebang line `#!/usr/bin/env node` is required for the bin entry point.

#### `src/cli/spawn.ts` -- `harnessmaxxing spawn <agent-file>`

```typescript
import { Command } from 'commander';
import { createRuntime } from '../runtime';

export const spawnCommand = new Command('spawn')
  .description('Spawn an agent from a definition file')
  .argument('<agent-file>', 'Path to agent definition file (TypeScript or JavaScript)')
  .option('--redis-url <url>', 'Redis connection URL', 'redis://localhost:6379')
  .option('--db-path <path>', 'SQLite database path', './data/checkpoints.db')
  .action(async (agentFile, options) => {
    // 1. Dynamically import the agent file. Expect a default export of AgentDefinition.
    //    Use tsx or dynamic import. The file should be a .ts or .js file.
    // 2. Call createRuntime({ redis: { url: options.redisUrl }, sqlite: { path: options.dbPath } })
    // 3. Call runtime.spawn(agentDef)
    // 4. Print: "Agent spawned: {agentId}"
    // 5. Print: "State: IDLE"
    // 6. Keep the process running (the agent tick loop runs in the background)
    // 7. Handle SIGINT to call runtime.shutdown() and exit
  });
```

#### `src/cli/list.ts` -- `harnessmaxxing list`

```typescript
export const listCommand = new Command('list')
  .description('List all known agents')
  .option('--db-path <path>', 'SQLite database path', './data/checkpoints.db')
  .action(async (options) => {
    // 1. Create a SQLiteCheckpointStore
    // 2. Query for all distinct agent IDs that have checkpoints
    // 3. For each agent, load the latest checkpoint
    // 4. Display a table:
    //    ID | State | Epoch | Tick | Last Checkpoint
    //    ---|-------|-------|------|----------------
    //    agent-abc | WORKING | 2 | 45 | 2024-01-15 14:30:22
    // 5. Use console.table() or format manually with padded columns
  });
```

#### `src/cli/inspect.ts` -- `harnessmaxxing inspect <agent-id>`

```typescript
export const inspectCommand = new Command('inspect')
  .description('Show detailed info for an agent')
  .argument('<agent-id>', 'Agent ID to inspect')
  .option('--db-path <path>', 'SQLite database path', './data/checkpoints.db')
  .action(async (agentId, options) => {
    // 1. Load all checkpoints for this agent from SQLiteCheckpointStore
    // 2. Load the latest checkpoint
    // 3. Display:
    //    Agent: {agentId}
    //    State: {state}
    //    Epoch: {epoch}
    //    Current Tick: {tick}
    //    Checkpoints: {count}
    //
    //    Budget:
    //      Tokens: {used}/{limit} ({percent}%)
    //      Cost: ${used}/${limit}
    //      API Calls: {used}/{limit}
    //      Tool Invocations: {used}/{limit}
    //      Wall Time: {used}ms / {limit}ms
    //
    //    Effect Ledger:
    //      Total Effects: {count}
    //      Committed: {count}
    //      Pending: {count}
    //      Failed: {count}
    //
    //    Checkpoint History (last 10):
    //      #{id} | Epoch {e} | Tick {t} | {timestamp}
    //      ...
  });
```

#### `src/cli/kill.ts` -- `harnessmaxxing kill <agent-id>`

```typescript
export const killCommand = new Command('kill')
  .description('Kill a running agent')
  .argument('<agent-id>', 'Agent ID to kill')
  .option('--redis-url <url>', 'Redis connection URL', 'redis://localhost:6379')
  .option('--timeout <ms>', 'Timeout waiting for death confirmation', '10000')
  .action(async (agentId, options) => {
    // 1. Create a RedisMessageBus
    // 2. Subscribe to stream:heartbeats, filtering for this agent
    // 3. Publish a LifecycleCommand { type: 'kill', targetAgentId: agentId }
    //    to stream:commands:{agentId}
    // 4. Wait for a heartbeat with state DEAD (or timeout)
    // 5. Print: "Agent {agentId} killed." or "Timeout: agent did not confirm death."
    // 6. Close the message bus and exit
  });
```

#### `src/cli/logs.ts` -- `harnessmaxxing logs <agent-id>`

```typescript
export const logsCommand = new Command('logs')
  .description('Stream live heartbeats for an agent')
  .argument('<agent-id>', 'Agent ID to stream logs for')
  .option('--redis-url <url>', 'Redis connection URL', 'redis://localhost:6379')
  .action(async (agentId, options) => {
    // 1. Create a RedisMessageBus
    // 2. Subscribe to heartbeats with pattern matching this agent
    // 3. For each heartbeat, display a live-updating line or table row:
    //
    //    Using ink (React-based terminal UI):
    //    - Render a table component that updates on each heartbeat
    //    - Columns: Tick | State | Health | Coherence | Tokens | Progress | Tick Rate
    //    - Color-code the Health column:
    //      - Green: healthy (no policies fired)
    //      - Yellow: warning
    //      - Red: degraded/error/critical
    //    - Show a running tick rate (ticks per minute, computed from timestamps)
    //
    //    If ink proves too complex for MVP, fall back to simple console.log lines:
    //    [14:30:22] Tick 45 | WORKING | healthy | coherence=0.85 | tokens=1234 | 12 ticks/min
    //
    // 4. Handle SIGINT to unsubscribe and exit cleanly
  });
```

### 4. Bin entry point

Update `package.json`:

```json
{
  "bin": {
    "harnessmaxxing": "./dist/cli/index.js"
  }
}
```

After `npm run build`, users can run `npx harnessmaxxing` or install globally.

Also add/update the scripts section:

```json
{
  "scripts": {
    "build": "tsc",
    "start": "tsx src/cli/index.ts",
    "dev": "tsx watch src/cli/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --project integration",
    "typecheck": "tsc --noEmit",
    "lint": "tsc --noEmit"
  }
}
```

### 5. Example agent (`examples/research-agent.ts`)

A demonstration agent that exercises the full lifecycle.

```typescript
import { AgentDefinition, BudgetLimits } from '../src/index';

const budget: BudgetLimits = {
  tokensUsed: 10000,
  estimatedCostUsd: 1.0,
  wallTimeMs: 120000,       // 2 minutes
  apiCalls: 50,
  toolInvocations: 20,
};

const researchAgent: AgentDefinition = {
  name: 'research-agent',
  config: {
    budget,
    tickIntervalMs: 2000,      // tick every 2 seconds
    checkpointEveryNTicks: 5,  // checkpoint every 5 ticks
  },
  handler: async (context) => {
    // context provides: tick number, effect ledger, budget enforcer, inbox, outbox

    // 1. Check inbox for tasks
    const messages = context.inbox ?? [];
    if (messages.length > 0) {
      console.log(`[Tick ${context.tick}] Processing ${messages.length} message(s)`);
    }

    // 2. Simulate work: register an effect for a mock tool call
    const effect = context.effectLedger.register(
      {
        type: 'tool_call',
        action: 'web_search',
        parameters: { query: `research topic tick ${context.tick}` },
        idempotencyKey: `search-tick-${context.tick}`,
      },
      context.tick,
    );

    // 3. Execute the "tool call" (simulated)
    context.effectLedger.markExecuting(effect.id);
    await simulateLLMCall(context);
    context.effectLedger.commit(effect.id, {
      success: true,
      output: { results: [`result for tick ${context.tick}`] },
      sideEffects: [],
    });

    // 4. Record budget consumption
    context.budgetEnforcer.record({
      tokensUsed: 150 + Math.floor(Math.random() * 100),
      estimatedCostUsd: 0.02,
      apiCalls: 1,
      toolInvocations: 1,
    });

    // 5. Report health
    context.health = {
      coherenceScore: 0.8 + Math.random() * 0.2,
      stuckTicks: 0,
      progress: Math.min(1, context.tick / 20),
      status: 'healthy',
    };
  },
};

async function simulateLLMCall(context: unknown): Promise<void> {
  // Simulate latency
  await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));
}

export default researchAgent;
```

The example must be runnable with `tsx examples/research-agent.ts` or via `npx harnessmaxxing spawn examples/research-agent.ts`.

### 6. End-to-end test (`test/integration/e2e.test.ts`)

This test validates the full MVP success criteria from RFC Section 10.1.

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRuntime, RuntimeHandle, AgentDefinition } from '@/index';
import { InMemoryMessageBus } from '../helpers/in-memory-message-bus';
import { SQLiteCheckpointStore } from '@/checkpoint/sqlite-checkpoint-store';
```

Use real SQLite (in-memory or temp file) and `InMemoryMessageBus` (no Redis dependency for CI).

The runtime must accept injected dependencies (message bus and checkpoint store) to support testing. If `createRuntime` does not support dependency injection, add an overload or a `createTestRuntime` function that accepts pre-built components.

**Test scenario (single `it` block or a `describe` block with ordered tests):**

```
1. Spawn an agent
   - Call runtime.spawn(testAgentDef)
   - Verify: returns a non-empty agent ID string
   - Verify: query(agentId) shows state IDLE or WORKING

2. Observe heartbeats
   - Wait for at least 3 heartbeats to be published
   - Verify: each heartbeat has valid structure (tick, health, budget, timestamp)
   - Verify: tick numbers are monotonically increasing

3. Observe multi-step work
   - Wait for at least 5 ticks
   - Verify: effects are being registered and committed in the effect ledger
   - Verify: budget consumption is increasing

4. Simulate crash
   - Directly destroy the agent instance (call an internal stop/crash method)
   - Verify: heartbeats stop arriving
   - Verify: supervisor detects the failure (via watchdog timer)

5. Recover from checkpoint
   - Wait for supervisor to trigger recovery
   - Verify: a new agent instance is spawned
   - Verify: it resumes from the last checkpoint (epoch/tick match)

6. Verify continuation
   - Wait for the recovered agent to produce 3 more ticks
   - Verify: tick numbers continue from where the crash happened (not from 0)
   - Verify: previously committed effects are NOT re-executed (idempotency keys match)

7. Budget exhaustion
   - Spawn a second agent with a very low budget (e.g., tokensUsed: 500)
   - Wait for it to exhaust the budget
   - Verify: agent transitions to a terminal state (BUDGET_EXCEEDED or DEAD)
   - Verify: heartbeat reports the budget breach
```

**Timeouts:** Each step should have a reasonable timeout (5-10 seconds). Use a helper that polls or subscribes and resolves a promise when the condition is met.

**Cleanup:** `afterAll` calls `runtime.shutdown()` and deletes any temp SQLite files.

### 7. Update `tsconfig.json`

Ensure the `examples/` directory is excluded from compilation (it is demonstration code, not part of the build):

```json
{
  "exclude": ["node_modules", "dist", "examples", "test"]
}
```

But ensure `tsx` can still run examples directly.

---

## Acceptance Criteria

- [ ] `src/index.ts` exports all public API surface (functions, classes, types, interfaces)
- [ ] `createRuntime()` wires all components and returns a working `RuntimeHandle`
- [ ] Graceful shutdown on SIGTERM/SIGINT (no orphan processes, no open handles)
- [ ] `harnessmaxxing spawn <agent-file>` creates and starts an agent, prints its ID
- [ ] `harnessmaxxing list` shows all known agents with state, epoch, tick
- [ ] `harnessmaxxing inspect <agent-id>` shows full agent detail (budget, effects, checkpoints)
- [ ] `harnessmaxxing kill <agent-id>` sends kill command and confirms death
- [ ] `harnessmaxxing logs <agent-id>` streams live heartbeats with color-coded health
- [ ] `package.json` has `bin` entry pointing to `dist/cli/index.ts`
- [ ] Example agent runs end-to-end and demonstrates the full lifecycle
- [ ] End-to-end test passes all 7 MVP validation steps
- [ ] `npm run build` produces working JavaScript in `dist/`
- [ ] `npm test` passes all unit, integration, and e2e tests
- [ ] `npm run typecheck` reports 0 errors

---

## Estimated Scope

Large. ~15 files, integration-heavy. This is where everything comes together.
- `src/index.ts` (major update)
- `src/runtime.ts`
- `src/cli/index.ts`
- `src/cli/spawn.ts`
- `src/cli/list.ts`
- `src/cli/inspect.ts`
- `src/cli/kill.ts`
- `src/cli/logs.ts`
- `examples/research-agent.ts`
- `test/integration/e2e.test.ts`
- `package.json` (updates)
- `tsconfig.json` (updates)
- Possible: `src/runtime.test.ts` (unit tests for runtime wiring)
- Possible: test helper `createTestRuntime` if dependency injection is needed
