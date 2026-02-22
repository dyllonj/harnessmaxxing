# AGENTS.md -- harnessmaxxing

> This file is for AI coding agents (Claude, Codex, etc.) working on this codebase.
> It provides implementation patterns, code examples, and decision frameworks
> that are too detailed for CLAUDE.md but critical for producing correct code.
>
> **Before writing any code**, read:
> 1. This file (you are here)
> 2. `docs/rfcs/001-heartbeat-lifecycle.md` -- the full system design
> 3. The relevant sprint doc in `docs/sprints/` for your current task

---

## 1. How to Navigate This Codebase

```
src/
├── types/           # START HERE. All shared types. Read this first.
├── lifecycle/       # State machine. The core of everything.
├── agent/           # Agent base class + tick loop.
├── heartbeat/       # Heartbeat construction + emission.
├── checkpoint/      # CheckpointStore interface + SQLite implementation.
├── bus/             # MessageBus interface + Redis Streams implementation.
├── supervisor/      # Health assessor + recovery engine.
├── effects/         # Side effect ledger.
├── budget/          # Budget types + enforcement.
├── cli/             # CLI commands (spawn, list, inspect, kill, logs).
└── index.ts         # Public API. What users import.
```

### Dependency Order

Modules depend on each other in a strict, acyclic order. Imports must flow left to right:

```
types -> lifecycle -> effects/budget -> checkpoint/bus -> heartbeat -> agent -> supervisor -> cli
```

- `types/` depends on nothing. It defines all shared data shapes.
- `lifecycle/` depends only on `types/`. It defines the state machine and transitions.
- `effects/` and `budget/` depend on `types/` and `lifecycle/`. They are peer modules with no dependency on each other.
- `checkpoint/` and `bus/` depend on `types/`. They define the two extension seam interfaces and their default implementations.
- `heartbeat/` depends on `types/`, `lifecycle/`, `effects/`, and `budget/`. It constructs heartbeat messages from all of these.
- `agent/` depends on everything above. It is the integration point where the tick loop brings all modules together.
- `supervisor/` depends on `agent/`, `heartbeat/`, `bus/`, and `checkpoint/`. It observes agents and acts on health assessments.
- `cli/` depends on everything. It is the outermost shell.

**No circular dependencies.** If you find yourself needing to import from a module that is to the right of your module in this chain, you are either putting code in the wrong module or you need to extract a type into `types/`.

---

## 2. Implementation Patterns

These patterns are mandatory. Every file you write must follow them.

### Pattern: Defining a type

All shared data shapes live in `src/types/`. Use `type`, not `interface` (reserve `interface` for CheckpointStore and MessageBus only).

```typescript
// src/types/heartbeat.ts
export type HealthStatus = 'healthy' | 'degraded' | 'critical';

export type SemanticHealth = {
  status: HealthStatus;
  progress: number;       // 0-1, how far through the current task
  coherence: number;      // 0-1, self-consistency of recent outputs
  confidence: number;     // 0-1, agent's self-reported confidence
  stuckTicks: number;     // consecutive ticks with no meaningful progress
  lastMeaningfulAction: string;
};
```

### Pattern: The two interfaces (and ONLY these two)

These are the only `interface` declarations in the entire codebase. They exist because they are extension seams -- users can swap in their own implementations.

```typescript
// src/checkpoint/checkpoint-store.ts
export interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>;
  loadLatest(agentId: string): Promise<Checkpoint | null>;
  load(agentId: string, epoch?: number): Promise<Checkpoint | null>;
  list(agentId: string): Promise<CheckpointMetadata[]>;
  delete(checkpointId: string): Promise<void>;
  verify(checkpointId: string): Promise<boolean>;
}

// The default implementation is SQLiteCheckpointStore.
```

```typescript
// src/bus/message-bus.ts
export interface MessageBus {
  publish(stream: string, message: unknown): Promise<string>;
  subscribe(stream: string, group: string, consumer: string): Promise<void>;
  read(stream: string, group: string, consumer: string, count?: number): Promise<StreamMessage[]>;
  ack(stream: string, group: string, id: string): Promise<void>;
}

// The default implementation is RedisMessageBus.
```

**Do NOT create new interfaces for anything else.** If you are tempted to write `interface`, stop and use `type` instead. If you genuinely need polymorphism, talk to the human.

### Pattern: Everything else is concrete

Classes that are not interface implementations are concrete. No `abstract` keyword. No method stubs.

```typescript
// src/lifecycle/state-machine.ts -- NOT an interface. A concrete class.
export class LifecycleStateMachine {
  private state: LifecycleState;

  constructor(initialState: LifecycleState = LifecycleState.UNBORN) {
    this.state = initialState;
  }

  get current(): LifecycleState {
    return this.state;
  }

  apply(trigger: Trigger): LifecycleState {
    const next = TRANSITION_TABLE[this.state]?.[trigger];
    if (!next) {
      throw new IllegalTransitionError(this.state, trigger);
    }
    this.state = next;
    return this.state;
  }
}
```

### Pattern: Agent subclass

This is what users of the framework write. The base `Agent<S>` class provides the tick loop, checkpointing, and heartbeat emission. Users implement `onInitialize` and `onTick`.

```typescript
// Example of what users write (not framework code)
import { Agent, type TickContext } from '@harnessmaxxing/core';

type MyState = {
  count: number;
  results: string[];
};

export class MyAgent extends Agent<MyState> {
  async onInitialize(): Promise<MyState> {
    return { count: 0, results: [] };
  }

  async onTick(ctx: TickContext<MyState>): Promise<void> {
    const result = await ctx.llm.complete(ctx.prompt);
    ctx.state.results.push(result);
    ctx.state.count += 1;

    if (ctx.state.count >= ctx.budget.maxTicks) {
      ctx.requestShutdown('budget exhausted');
    }
  }
}
```

### Pattern: Lifecycle hooks (fire-and-forget events)

Hooks are observers. They do not influence control flow. They do not throw. If a hook handler errors, the error is logged and execution continues.

```typescript
// Hooks don't throw. They log errors and continue.
export type HookHandler<T> = (event: T) => Promise<void>;

export type LifecycleHooks = {
  PRE_SPAWN: HookHandler<PreSpawnEvent>[];
  POST_SPAWN: HookHandler<PostSpawnEvent>[];
  PRE_TICK: HookHandler<PreTickEvent>[];
  POST_TICK: HookHandler<PostTickEvent>[];
  PRE_CHECKPOINT: HookHandler<PreCheckpointEvent>[];
  POST_CHECKPOINT: HookHandler<PostCheckpointEvent>[];
  ON_ERROR: HookHandler<ErrorEvent>[];
  ON_SHUTDOWN: HookHandler<ShutdownEvent>[];
};

// Executing hooks safely:
async function fireHooks<T>(handlers: HookHandler<T>[], event: T, logger: Logger): Promise<void> {
  for (const handler of handlers) {
    try {
      await handler(event);
    } catch (err) {
      logger.error({ err, event }, 'hook handler failed');
      // Continue -- hooks are fire-and-forget
    }
  }
}
```

### Pattern: Error handling in the lifecycle system

Errors in the lifecycle system are lifecycle events. They do not propagate as thrown exceptions (with one exception: `IllegalTransitionError` for programming errors).

```typescript
// CORRECT: Errors become lifecycle events
async function executeTick(agent: Agent, ctx: TickContext): Promise<void> {
  try {
    await agent.onTick(ctx);
    agent.stateMachine.apply('tick_success');
  } catch (err) {
    agent.stateMachine.apply('error');
    agent.emitHeartbeat({
      health: { status: 'critical' },
      error: { message: String(err), stack: (err as Error).stack },
    });
    // The tick loop continues. The supervisor will decide what to do.
  }
}

// WRONG: Throwing from lifecycle code
async function executeTick(agent: Agent, ctx: TickContext): Promise<void> {
  await agent.onTick(ctx); // If this throws, the tick loop dies
  // NO -- unhandled exceptions kill the tick loop
}
```

### Pattern: JSON-serializable state only

All agent state must survive a JSON roundtrip. This is a hard requirement for checkpointing.

```typescript
// CORRECT: JSON-serializable
type GoodState = {
  tasks: string[];
  count: number;
  metadata: Record<string, string>;
  startedAt: number;               // epoch ms, NOT Date
  completedItems: string[];        // array, NOT Set
  lookupTable: Record<string, unknown>; // Record, NOT Map
};

// WRONG: These are NOT JSON-serializable
type BadState = {
  createdAt: Date;          // Use number (epoch ms) instead
  items: Set<string>;       // Use string[] instead
  cache: Map<string, any>;  // Use Record<string, unknown> instead
  connection: WebSocket;    // Non-serializable. Keep outside state.
  callback: () => void;     // Functions are not serializable.
};

// Verification: this must always hold
const state: GoodState = { /* ... */ };
assert.deepStrictEqual(JSON.parse(JSON.stringify(state)), state);
```

### Pattern: Logging with pino

Use pino for all logging. No `console.log`. Always include structured context.

```typescript
import { pino } from 'pino';

const logger = pino({ name: 'lifecycle' });

// CORRECT: structured context
logger.info({ agentId, epoch, state: sm.current }, 'state transition');
logger.error({ err, agentId }, 'tick failed');

// WRONG: string interpolation
logger.info(`Agent ${agentId} transitioned to ${state}`);
console.log('something happened'); // Never use console
```

### Pattern: Importing Node.js built-ins

Always use the `node:` prefix.

```typescript
// CORRECT
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

// WRONG
import { createHash } from 'crypto';
```

---

## 3. Testing Patterns

### Unit tests

Unit tests live in `test/unit/`, mirroring the `src/` structure. They are fast, deterministic, and have no external dependencies (no Redis, no SQLite, no filesystem).

```typescript
// test/unit/lifecycle/state-machine.test.ts
import { describe, it, expect } from 'vitest';
import { LifecycleStateMachine } from '../../../src/lifecycle/state-machine';
import { LifecycleState } from '../../../src/types/lifecycle';
import { IllegalTransitionError } from '../../../src/lifecycle/errors';

describe('LifecycleStateMachine', () => {
  it('starts in UNBORN', () => {
    const sm = new LifecycleStateMachine();
    expect(sm.current).toBe(LifecycleState.UNBORN);
  });

  it('transitions from UNBORN to INITIALIZING on spawn', () => {
    const sm = new LifecycleStateMachine();
    sm.apply('spawn');
    expect(sm.current).toBe(LifecycleState.INITIALIZING);
  });

  it('transitions from INITIALIZING to RUNNING on initialized', () => {
    const sm = new LifecycleStateMachine();
    sm.apply('spawn');
    sm.apply('initialized');
    expect(sm.current).toBe(LifecycleState.RUNNING);
  });

  it('throws IllegalTransitionError on invalid transition', () => {
    const sm = new LifecycleStateMachine();
    // Cannot kill an UNBORN agent
    expect(() => sm.apply('kill')).toThrow(IllegalTransitionError);
  });

  it('reaches TERMINATED through graceful shutdown', () => {
    const sm = new LifecycleStateMachine();
    sm.apply('spawn');
    sm.apply('initialized');
    sm.apply('shutdown');
    sm.apply('shutdown_complete');
    expect(sm.current).toBe(LifecycleState.TERMINATED);
  });
});
```

### Integration tests

Integration tests live in `test/integration/`. They use real SQLite and/or Redis. They are slower and may require setup.

```typescript
// test/integration/checkpoint/sqlite-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteCheckpointStore } from '../../../src/checkpoint/sqlite-store';
import { randomUUID } from 'node:crypto';

describe('SQLiteCheckpointStore', () => {
  let store: SQLiteCheckpointStore;

  beforeEach(() => {
    store = new SQLiteCheckpointStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('saves and loads a checkpoint', async () => {
    const checkpoint = {
      id: randomUUID(),
      agentId: randomUUID(),
      epoch: 1,
      state: { count: 42 },
      timestamp: Date.now(),
      hash: '',
    };
    checkpoint.hash = store.computeHash(checkpoint);

    await store.save(checkpoint);
    const loaded = await store.loadLatest(checkpoint.agentId);

    expect(loaded).toEqual(checkpoint);
  });

  it('verifies checkpoint integrity', async () => {
    const checkpoint = {
      id: randomUUID(),
      agentId: randomUUID(),
      epoch: 1,
      state: { count: 42 },
      timestamp: Date.now(),
      hash: '',
    };
    checkpoint.hash = store.computeHash(checkpoint);

    await store.save(checkpoint);
    expect(await store.verify(checkpoint.id)).toBe(true);
  });
});
```

### Test harness

For agent-level and integration tests, use the test harness. It provides in-memory implementations of all external dependencies.

```typescript
// test/integration/agent/recovery.test.ts
import { describe, it, expect } from 'vitest';
import { TestHarness, MockLLM, ControllableClock } from '../../helpers';
import { MyAgent } from './fixtures/my-agent';

describe('agent recovery', () => {
  it('resumes from checkpoint after crash', async () => {
    const harness = new TestHarness({
      agent: MyAgent,
      llm: new MockLLM([
        'response-1', 'response-2', 'response-3',
        'response-4', 'response-5', 'response-6',
        'response-7', 'response-8', 'response-9',
        'response-10',
      ]),
      checkpointInterval: 5,
    });

    await harness.runTicks(10);
    expect(harness.agent.state.count).toBe(10);

    harness.crash();
    await harness.recover();

    // Recovered from checkpoint at tick 5, re-ran ticks 6-10
    expect(harness.agent.epoch).toBe(2);
    expect(harness.agent.lifecycleState).toBe('RUNNING');
    expect(harness.agent.state.count).toBe(10);
  });

  it('replays side effects ledger on recovery', async () => {
    const harness = new TestHarness({
      agent: MyAgent,
      llm: new MockLLM(['response-1', 'response-2']),
      checkpointInterval: 1,
    });

    await harness.runTicks(2);
    const effectsBefore = harness.effects.committed();

    harness.crash();
    await harness.recover();

    // Side effects from before the checkpoint are not re-executed
    expect(harness.effects.committed()).toEqual(effectsBefore);
  });
});
```

### No mocking frameworks

Do not use jest.mock, sinon, or any mocking library. Use the provided in-memory implementations:

- `InMemoryCheckpointStore` -- implements `CheckpointStore` in memory
- `InMemoryMessageBus` -- implements `MessageBus` in memory
- `MockLLM` -- returns canned responses in sequence
- `ControllableClock` -- lets tests advance time manually

```typescript
// CORRECT: Use provided test doubles
const bus = new InMemoryMessageBus();
const store = new InMemoryCheckpointStore();
const clock = new ControllableClock();

// WRONG: Do not use mocking frameworks
vi.mock('../../../src/bus/redis-bus'); // NO
```

---

## 4. Decision Framework

When you are unsure about an implementation choice, use this decision tree.

### "Should this be an interface?"

**NO.** Unless it is `CheckpointStore` or `MessageBus`. Those are the only two extension seams. Everything else is concrete.

### "Should this be a class?"

Only if it is one of these:
- `Agent` -- base class for users to extend
- `LifecycleStateMachine` -- the core state machine
- `Supervisor` -- the health assessor and recovery engine
- `SQLiteCheckpointStore` -- implements `CheckpointStore`
- `RedisMessageBus` -- implements `MessageBus`

Everything else is **types + functions**. If you are writing `class Foo` and `Foo` is not on this list, refactor to a plain function or a type with associated functions.

### "Should I add a dependency?"

**Ask the human first.** The dependency list is intentionally minimal:

| Dependency | Purpose |
|---|---|
| `typescript` | Language |
| `better-sqlite3` | Checkpoint storage |
| `ioredis` | Redis Streams message bus |
| `commander` | CLI argument parsing |
| `ink` | React-based CLI rendering |
| `react` | Required by ink |
| `pino` | Structured logging |
| `vitest` | Testing |
| `fast-check` | Property-based testing |

If your implementation "needs" a dependency not on this list, you are probably overcomplicating it. Reconsider the approach.

### "Where does this code go?"

Follow the module boundaries in the directory structure. Use the dependency order from Section 1:

```
types -> lifecycle -> effects/budget -> checkpoint/bus -> heartbeat -> agent -> supervisor -> cli
```

- **Pure data shapes** go in `types/`.
- **State machine logic** goes in `lifecycle/`.
- **Anything that touches SQLite** goes in `checkpoint/`.
- **Anything that touches Redis** goes in `bus/`.
- **Health assessment and recovery** go in `supervisor/`.
- **The tick loop and agent base class** go in `agent/`.

If your code crosses module boundaries (imports from a module to the right in the chain), it probably belongs in `types/` or you need to restructure.

### "Should I add an abstraction?"

**No.** Write the direct implementation. We will abstract later if a genuine need emerges. Premature abstraction is worse than duplication.

### "Is this state serializable?"

Test it:

```typescript
const roundtripped = JSON.parse(JSON.stringify(state));
assert.deepStrictEqual(roundtripped, state);
```

If this assertion fails, fix the types. Common fixes:
- `Date` -> `number` (epoch milliseconds)
- `Set<T>` -> `T[]`
- `Map<K, V>` -> `Record<K, V>`
- Class instances -> plain objects with a `type` discriminator
- Functions, WebSockets, streams -> keep outside state, reconstruct on recovery

---

## 5. Sprint Workflow

Follow this sequence for every sprint task:

1. **Read the sprint doc** in `docs/sprints/XX-sprint-name.md`. It lists the deliverables, acceptance criteria, and the order to implement them.
2. **Read the relevant RFC sections** referenced in the sprint doc. The RFC is the source of truth for system design. If the sprint doc and the RFC disagree, the RFC wins.
3. **Implement deliverables in order.** They build on each other. Do not skip ahead.
4. **Write tests alongside implementation, not after.** Every file you create in `src/` should have a corresponding test file in `test/unit/` before you move to the next deliverable.
5. **Run `npm test` after every file change.** Do not batch up changes and test at the end.
6. **Run `npm run typecheck` before considering a task done.** Zero type errors is a hard requirement.
7. **Update AGENTS.md or CLAUDE.md** if you discover a pattern worth documenting or a mistake worth preventing.

---

## 6. Redis & SQLite Conventions

### Redis Streams

| Stream | Key pattern | Purpose |
|---|---|---|
| Heartbeats | `stream:heartbeats` | All agents publish heartbeats here |
| Agent commands | `stream:commands:{agentId}` | Per-agent command channel (supervisor -> agent) |
| System events | `stream:events` | Lifecycle events, supervisor decisions |

**Rules:**
- Use `XADD` with `MAXLEN ~ 10000` for automatic stream trimming.
- Heartbeat messages are JSON-serialized `Heartbeat` objects.
- Consumer group for supervisor: `supervisor-group`.
- Each supervisor instance is a unique consumer within the group.
- Always `XACK` after processing a message. Unacknowledged messages get redelivered.

```typescript
// Publishing a heartbeat
await redis.xadd(
  'stream:heartbeats',
  'MAXLEN', '~', '10000',
  '*', // auto-generate ID
  'data', JSON.stringify(heartbeat),
);

// Reading from a consumer group
const messages = await redis.xreadgroup(
  'GROUP', 'supervisor-group', consumerId,
  'COUNT', '100',
  'BLOCK', '5000',
  'STREAMS', 'stream:heartbeats', '>',
);
```

### SQLite

| Setting | Value | Reason |
|---|---|---|
| Database file | `data/harnessmaxxing.db` | Single file, easy to back up |
| Journal mode | WAL | Concurrent readers + single writer |
| Synchronous | NORMAL | Balance between safety and speed |
| Foreign keys | ON | Referential integrity |

**Rules:**
- All writes are wrapped in transactions. No bare `INSERT`/`UPDATE`/`DELETE`.
- Every checkpoint gets a SHA-256 integrity hash computed over its serialized state.
- Use parameterized queries. No string interpolation in SQL.

```typescript
// CORRECT: Parameterized query in a transaction
const insert = db.prepare(`
  INSERT INTO checkpoints (id, agent_id, epoch, state, timestamp, hash)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const saveCheckpoint = db.transaction((checkpoint: Checkpoint) => {
  insert.run(
    checkpoint.id,
    checkpoint.agentId,
    checkpoint.epoch,
    JSON.stringify(checkpoint.state),
    checkpoint.timestamp,
    checkpoint.hash,
  );
});

// WRONG: String interpolation
db.exec(`INSERT INTO checkpoints VALUES ('${id}', '${agentId}', ...)`); // SQL injection risk
```

---

## 7. Naming Conventions

| Thing | Convention | Example |
|---|---|---|
| Files | kebab-case | `lifecycle-state-machine.ts` |
| Types | PascalCase | `LifecycleState`, `Heartbeat`, `SemanticHealth` |
| Functions | camelCase | `emitHeartbeat()`, `applyTransition()`, `computeHash()` |
| Constants | SCREAMING_SNAKE_CASE | `MAX_STUCK_TICKS`, `DEFAULT_TICK_INTERVAL` |
| Agent IDs | UUID v7 | `019475a2-...` (time-sortable) |
| Checkpoint IDs | UUID v7 | `019475a3-...` (time-sortable) |
| Stream names | colon-separated | `stream:heartbeats`, `stream:commands:019475a2` |
| Enum values | SCREAMING_SNAKE_CASE | `UNBORN`, `INITIALIZING`, `RUNNING`, `TERMINATED` |
| Test files | `<module>.test.ts` | `state-machine.test.ts`, `sqlite-store.test.ts` |
| Test descriptions | lowercase, present tense | `'transitions from UNBORN to INITIALIZING on spawn'` |

### File organization

- One class per file for classes.
- Multiple exports OK for types and pure functions.
- Named exports only. No default exports.
- Separate type exports from value exports:

```typescript
// CORRECT
export type { Heartbeat, SemanticHealth, HealthStatus };
export { emitHeartbeat, constructHeartbeat };

// WRONG
export default class Agent { ... } // No default exports
```
