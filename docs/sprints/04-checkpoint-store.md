# Sprint 04: Checkpoint Store

**Goal:** Implement the CheckpointStore interface and its SQLite default implementation. This is one of the two extension seams defined by the RFC.

**RFC Reference:** Section 5.7 (Checkpoint Design), Section 6 (Technology Choices — SQLite), Section 7.5 (Interface Definitions)

**Depends on:** Sprint 01 (project setup), Sprint 02 (lifecycle types)

---

## Deliverables

### 1. Checkpoint types (`src/types/checkpoint.ts`)

```typescript
import type { LifecycleState } from './lifecycle';
import type { BudgetSnapshot } from './budget';
import type { Heartbeat } from './heartbeat';

export type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  name?: string;
};

export type Task = {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
};

export type Effect = {
  id: string;
  tick: number;
  type: string;
  action: string;
  description: string;
  status: 'pending' | 'committed' | 'failed';
  timestamp: number;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  error?: string;
};

export type Checkpoint = {
  id: string;              // UUID v7
  agentId: string;
  epoch: number;
  tick: number;
  timestamp: number;

  llmState: {
    systemPrompt: string;
    conversationHistory: Message[];
    contextWindowUsage: number;
    modelId: string;
    temperature: number;
  };

  externalState: {
    taskQueue: Task[];
    completedTasks: Task[];
    keyValueStore: Record<string, unknown>;
    pendingEffects: Effect[];
    committedEffects: Effect[];
  };

  metadata: {
    lifecycleState: LifecycleState;
    parentAgentId: string | null;
    childAgentIds: string[];
    budget: BudgetSnapshot;
    lastHeartbeat: Heartbeat;
    createdAt: number;
    restoredFrom: string | null;
  };

  checksum: string;        // SHA-256
  previousCheckpointId: string | null;
};

export type CheckpointMetadata = {
  id: string;
  agentId: string;
  epoch: number;
  tick: number;
  timestamp: number;
  checksum: string;
};
```

### 2. CheckpointStore interface (`src/checkpoint/checkpoint-store.ts`)

This is one of the two extension seams. The interface must match RFC Section 7.5:

```typescript
export interface CheckpointStore {
  /** Write a checkpoint atomically. */
  save(checkpoint: Checkpoint): Promise<void>;

  /** Load checkpoint by agent ID, optionally filtered by epoch. */
  load(agentId: string, epoch?: number): Promise<Checkpoint | null>;

  /** Load the most recent checkpoint for an agent (highest tick). */
  loadLatest(agentId: string): Promise<Checkpoint | null>;

  /** List metadata for all checkpoints of an agent, ordered by tick descending. */
  list(agentId: string): Promise<CheckpointMetadata[]>;

  /** Delete a checkpoint by ID. */
  delete(checkpointId: string): Promise<void>;

  /** Verify checkpoint integrity by recomputing and comparing checksum. */
  verify(checkpointId: string): Promise<boolean>;
}
```

### 3. Checksum utility (`src/checkpoint/checksum.ts`)

```typescript
import { createHash } from 'node:crypto';

/**
 * Compute SHA-256 checksum of a checkpoint (excluding the checksum field itself).
 * The checkpoint is JSON-serialized with keys sorted for deterministic output.
 */
export function computeChecksum(checkpoint: Omit<Checkpoint, 'checksum'>): string;

/**
 * Verify that a checkpoint's stored checksum matches its computed checksum.
 */
export function verifyChecksum(checkpoint: Checkpoint): boolean;
```

Implementation details:
- Use `JSON.stringify` with a replacer that sorts keys for deterministic serialization
- The `checksum` field must be excluded from the input to `computeChecksum`
- Use SHA-256 via Node.js `crypto` module
- Return the hex-encoded digest
- `verifyChecksum` extracts the stored checksum, recomputes from the rest, and compares

**Key detail:** The serialization must be deterministic. Use a sorted-key JSON serializer. Two checkpoints with the same data must always produce the same checksum regardless of property insertion order.

### 4. SQLite implementation (`src/checkpoint/sqlite-checkpoint-store.ts`)

Class `SQLiteCheckpointStore implements CheckpointStore`:

**Constructor:**
- Takes database path (default: `data/harnessmaxxing.db`)
- Opens the database using `better-sqlite3`
- Creates tables and indexes on first use (auto-migration)
- Enables WAL mode: `PRAGMA journal_mode=WAL`

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  llm_state TEXT NOT NULL,         -- JSON blob
  external_state TEXT NOT NULL,    -- JSON blob
  metadata TEXT NOT NULL,          -- JSON blob
  checksum TEXT NOT NULL,
  previous_checkpoint_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(agent_id, epoch, tick)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_agent_id ON checkpoints(agent_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_agent_epoch ON checkpoints(agent_id, epoch);
```

**Method implementations:**

- **`save(checkpoint)`**: Compute checksum (overwriting any existing checksum on the input), serialize `llmState`, `externalState`, `metadata` as JSON strings, INSERT into the table. Verify the write by reading back the checksum. Wrap in a transaction.

- **`load(agentId, epoch?)`**: SELECT by `agent_id`. If `epoch` is provided, add `AND epoch = ?`. Order by `tick DESC`, LIMIT 1. Deserialize JSON fields. Verify checksum on read — if verification fails, return `null` (treat corrupted checkpoints as missing).

- **`loadLatest(agentId)`**: SELECT by `agent_id`, ORDER BY `tick DESC` LIMIT 1. Same deserialization and verification as `load`.

- **`list(agentId)`**: SELECT `id, agent_id, epoch, tick, timestamp, checksum` FROM checkpoints WHERE `agent_id = ?` ORDER BY `tick DESC`. Return metadata only (no JSON blobs).

- **`delete(checkpointId)`**: DELETE FROM checkpoints WHERE `id = ?`.

- **`verify(checkpointId)`**: Load the full checkpoint by ID, recompute checksum, compare with stored checksum. Return `true` if they match, `false` if they don't or if the checkpoint doesn't exist.

**Important details:**
- All writes MUST be wrapped in transactions for atomicity
- `better-sqlite3` is synchronous but the interface is async (wrap in Promise.resolve or use async wrappers)
- The database file's parent directory must be created if it doesn't exist
- Closing the database should be supported (add a `close()` method, even though it's not on the interface)

### 5. In-memory implementation for tests (`test/helpers/in-memory-checkpoint-store.ts`)

Implements `CheckpointStore` with a `Map<string, Checkpoint>`:

```typescript
export class InMemoryCheckpointStore implements CheckpointStore {
  private store = new Map<string, Checkpoint>();

  async save(checkpoint: Checkpoint): Promise<void>;
  async load(agentId: string, epoch?: number): Promise<Checkpoint | null>;
  async loadLatest(agentId: string): Promise<Checkpoint | null>;
  async list(agentId: string): Promise<CheckpointMetadata[]>;
  async delete(checkpointId: string): Promise<void>;
  async verify(checkpointId: string): Promise<boolean>;
}
```

This implementation must pass the exact same test suite as the SQLite implementation. Factor tests so the same test cases run against both implementations (use Vitest `describe.each` or a shared test factory function).

### 6. Checkpoint test factory (`test/helpers/checkpoint-store-test-factory.ts`)

Create a reusable test factory that runs the full CheckpointStore conformance test suite against any implementation:

```typescript
export function checkpointStoreTests(
  name: string,
  createStore: () => CheckpointStore | Promise<CheckpointStore>,
  cleanup?: () => void | Promise<void>,
): void;
```

This factory defines all the test cases once. Both `sqlite-checkpoint-store.test.ts` and `in-memory-checkpoint-store.test.ts` call this factory with their respective implementations.

### 7. Checkpoint test helper (`test/helpers/checkpoint-factory.ts`)

Create a factory function for building test checkpoints:

```typescript
export function createTestCheckpoint(overrides?: Partial<Checkpoint>): Checkpoint;
```

This generates a valid checkpoint with sensible defaults for all fields. Every field has a reasonable default so tests only need to override the fields they care about. The `id` should default to a new UUID. The `checksum` should be computed from the other fields.

### 8. Tests

#### `test/unit/checkpoint/checksum.test.ts`

- Test that `computeChecksum` produces a valid hex string
- Test that the same checkpoint always produces the same checksum (deterministic)
- Test that different checkpoints produce different checksums
- Test that `verifyChecksum` returns `true` for a valid checkpoint
- Test that `verifyChecksum` returns `false` when any field is modified (bit flip detection)
- Test that property order doesn't affect checksum (sorted keys)
- Test with nested objects and arrays in `keyValueStore`

#### `test/unit/checkpoint/sqlite-checkpoint-store.test.ts`

Uses the test factory. Runs against SQLite with an in-memory or temp-file database:

- CRUD: save a checkpoint, load it back, verify all fields match
- `loadLatest` returns the checkpoint with the highest tick number
- `load` with epoch filter returns only checkpoints from that epoch
- `list` returns metadata (not full checkpoints) ordered by tick descending
- `delete` removes the checkpoint, subsequent `load` returns null
- `verify` returns `true` for valid checkpoints
- `verify` returns `false` for corrupted checkpoints (modify the stored JSON directly via raw SQL)
- Concurrent writes: save two checkpoints in quick succession, both succeed (WAL mode)
- Integrity: a checkpoint with a tampered checksum is treated as missing by `load`
- Empty store: `load`, `loadLatest`, `list` return null/empty without throwing

#### `test/unit/checkpoint/in-memory-checkpoint-store.test.ts`

Uses the same test factory. Runs against the in-memory implementation. Verifies interface compliance — if both implementations pass the same tests, we know the interface contract is well-defined.

---

## Acceptance Criteria

- [ ] `CheckpointStore` interface matches RFC Section 7.5
- [ ] SQLite implementation creates tables automatically on first use
- [ ] WAL mode is enabled (`PRAGMA journal_mode=WAL`)
- [ ] Checksum verification catches corrupted data (modified fields, truncation, invalid JSON)
- [ ] `computeChecksum` is deterministic (same input always produces same output)
- [ ] `loadLatest()` returns the checkpoint with the highest tick number for the agent
- [ ] `load()` with epoch parameter filters correctly
- [ ] `verify()` recomputes and compares checksum, returns boolean
- [ ] All writes are wrapped in transactions (atomic)
- [ ] In-memory and SQLite implementations pass the exact same test suite
- [ ] `list()` returns metadata only, not full checkpoint data
- [ ] Corrupted checkpoints (bad checksum) are treated as missing by `load`
- [ ] All tests pass
- [ ] `npm run typecheck` reports 0 errors

---

## Estimated Scope

Medium. ~10 files (including test helpers). Important correctness requirements around checksums and atomicity.
