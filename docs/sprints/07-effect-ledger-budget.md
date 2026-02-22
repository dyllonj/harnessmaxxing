# Sprint 07: Effect Ledger & Budget Enforcement

**Goal:** Implement the side effect tracking system (saga pattern) and the budget enforcement mechanism.

**RFC Reference:** Section 5.8 (Side Effect Tracking), Section 4 (Core Concepts -- Budget, Epoch), Section 5.3 Step 1 (Budget Check)

**Depends on:** Sprint 02 (lifecycle types), Sprint 03 (budget types stub)

---

## Deliverables

### 1. Effect types (`src/types/effect.ts`)

```typescript
export type EffectStatus = 'registered' | 'executing' | 'committed' | 'failed' | 'compensated';

export type EffectType = 'tool_call' | 'message_send' | 'sub_agent_spawn' | 'external_api';

export type Effect = {
  id: string;
  agentId: string;
  tick: number;
  type: EffectType;
  intent: {
    action: string;
    parameters: Record<string, unknown>;
    idempotencyKey?: string;
    compensatingAction?: string;
  };
  status: EffectStatus;
  result?: {
    success: boolean;
    output: unknown;
    sideEffects: string[];
  };
  timestamps: {
    registered: number;
    started?: number;
    completed?: number;
  };
};
```

Export from `src/types/index.ts`.

**Notes on status transitions (enforced by the ledger):**
- `registered` -> `executing` (only valid forward transition from registered)
- `executing` -> `committed` (success)
- `executing` -> `failed` (failure)
- `failed` -> `compensated` (compensation executed)
- No backward transitions. `committed` is terminal. `compensated` is terminal.
- Any invalid transition must throw an `InvalidEffectTransition` error.

### 2. Effect ledger (`src/effects/effect-ledger.ts`)

Class `EffectLedger` tracks all side effects for a single agent.

**Internal state:**
- `effects: Map<string, Effect>` -- all effects indexed by ID.
- `effectOrder: string[]` -- ordered list of effect IDs (insertion order).

**Constructor:**
- Takes `agentId: string`.

**Method `register(intent): Effect`:**
- Creates a new `Effect` with:
  - `id`: UUID v7 (use the `uuid` package, or a monotonic UUID function). If `uuid` does not support v7, use v4 with a timestamp prefix for sortability: `${Date.now().toString(36)}-${uuidv4()}`.
  - `agentId`: from constructor.
  - `tick`: passed as part of intent or as a separate argument. Accept as a second parameter: `register(intent, tick: number)`.
  - `type`: from intent.
  - `status`: `'registered'`.
  - `timestamps.registered`: `Date.now()`.
- Adds to the internal map and order list.
- Returns the created `Effect`.

**Method `markExecuting(effectId: string): void`:**
- Retrieves the effect. If not found, throw `Error('Effect not found: ${effectId}')`.
- If status is not `'registered'`, throw `Error('Invalid transition: ${currentStatus} -> executing')`.
- Sets `status` to `'executing'`, `timestamps.started` to `Date.now()`.

**Method `commit(effectId: string, result?: Effect['result']): void`:**
- Retrieves the effect. If status is not `'executing'`, throw invalid transition error.
- Sets `status` to `'committed'`, `timestamps.completed` to `Date.now()`.
- If `result` is provided, sets `effect.result`.

**Method `fail(effectId: string, error: string): void`:**
- Retrieves the effect. If status is not `'executing'`, throw invalid transition error.
- Sets `status` to `'failed'`, `timestamps.completed` to `Date.now()`.
- Sets `effect.result` to `{ success: false, output: error, sideEffects: [] }`.

**Method `compensate(effectId: string): void`:**
- Retrieves the effect. If status is not `'failed'`, throw invalid transition error.
- Sets `status` to `'compensated'`.

**Method `inspect(): Effect[]`:**
- Returns all effects in insertion order (map the `effectOrder` array to effects).

**Method `getPending(): Effect[]`:**
- Returns effects with status `'registered'` or `'executing'`.

**Method `getCommitted(): Effect[]`:**
- Returns effects with status `'committed'`.

**Method `getFailed(): Effect[]`:**
- Returns effects with status `'failed'`.

**Method `getByTick(tick: number): Effect[]`:**
- Returns all effects for a specific tick.

**Method `serialize(): string`:**
- JSON-stringify an object containing: `{ agentId, effects: this.inspect(), version: 1 }`.
- The `version` field is for future schema migrations.

**Static method `deserialize(json: string): EffectLedger`:**
- Parse the JSON. Create a new `EffectLedger` with the stored `agentId`.
- Restore all effects into the internal map and order list.
- Preserve the original effect IDs, timestamps, and statuses exactly.
- Return the restored ledger.

**Index file** (`src/effects/index.ts`):
- Export `EffectLedger`.

### 3. Budget enforcement (`src/budget/budget-enforcer.ts`)

Class `BudgetEnforcer` tracks cumulative resource consumption and checks against limits.

**Types** (define in `src/types/budget.ts` or extend existing budget types from Sprint 03):

```typescript
export type BudgetDimension = 'tokensUsed' | 'estimatedCostUsd' | 'wallTimeMs' | 'apiCalls' | 'toolInvocations';

export type BudgetLimits = {
  tokensUsed: number;         // max total tokens
  estimatedCostUsd: number;   // max estimated cost
  wallTimeMs: number;         // max wall clock time
  apiCalls: number;           // max API calls
  toolInvocations: number;    // max tool invocations
};

export type BudgetSnapshot = {
  tokensUsed: number;
  estimatedCostUsd: number;
  wallTimeMs: number;
  apiCalls: number;
  toolInvocations: number;
};

export type BudgetCheckResult = {
  status: 'ok' | 'soft_limit' | 'hard_limit';
  breachedDimensions: BudgetDimension[];
};
```

If Sprint 03 already defines a `Budget` type, extend or augment it. Do not duplicate. Import the existing type and add the missing fields.

**Constructor:**
- Takes `limits: BudgetLimits` and an optional `softLimitPercent: number` (default: 80).
- Initializes `consumption: BudgetSnapshot` with all zeros.

**Method `record(consumption: Partial<BudgetSnapshot>): void`:**
- Accumulates each provided dimension into the internal consumption tracker.
- Example: if `consumption.tokensUsed` is 500, add 500 to `this.consumption.tokensUsed`.
- Dimensions not provided are left unchanged.

**Method `check(): BudgetCheckResult`:**
- For each dimension, compare `consumption[dim]` against `limits[dim]`.
- If any dimension exceeds the hard limit (100%), return `{ status: 'hard_limit', breachedDimensions: [...] }`.
- If any dimension exceeds the soft limit (`softLimitPercent`%), return `{ status: 'soft_limit', breachedDimensions: [...] }`.
- Otherwise return `{ status: 'ok', breachedDimensions: [] }`.
- Hard limit takes precedence over soft limit (if both are breached, return `hard_limit`).

**Method `snapshot(): BudgetSnapshot`:**
- Returns a copy of the current cumulative consumption.

**Method `restore(snapshot: BudgetSnapshot): void`:**
- Replaces the internal consumption with the provided snapshot.
- Used when restoring from a checkpoint to resume cumulative tracking.

**Method `remaining(): BudgetSnapshot`:**
- Returns the remaining budget for each dimension: `limits[dim] - consumption[dim]`.
- Clamp to 0 (never negative).

**Method `percentUsed(): Record<BudgetDimension, number>`:**
- Returns the percentage used for each dimension: `(consumption[dim] / limits[dim]) * 100`.

**Index file** (`src/budget/index.ts`):
- Export `BudgetEnforcer`.

### 4. Wire into tick loop

Update the tick context and tick loop from Sprint 03 to integrate the effect ledger and budget enforcer.

**Changes to tick context** (in `src/types/tick.ts` or wherever `TickContext` is defined):
- Replace the stub `effectLedger` with a real `EffectLedger` instance.
- Replace the stub `budget` with a real `BudgetEnforcer` instance.

**Changes to the tick loop** (in `src/agent/` or wherever the tick loop lives):
- **Step 1 (Budget Check):** At the start of each tick, call `budgetEnforcer.check()`.
  - If `hard_limit`: transition agent to `BUDGET_EXCEEDED` state (or equivalent). Skip the tick. Emit a heartbeat with the budget status.
  - If `soft_limit`: log a warning. Continue execution but include the warning in the heartbeat.
  - If `ok`: proceed normally.
- **Step 3 (Tool Execution Wrapping):** When the agent executes a tool call (or any side effect):
  1. Call `effectLedger.register(intent, currentTick)` to get the effect.
  2. Call `effectLedger.markExecuting(effect.id)`.
  3. Execute the actual tool call.
  4. On success: call `effectLedger.commit(effect.id, result)`.
  5. On failure: call `effectLedger.fail(effect.id, errorMessage)`.
  6. After each tool call, call `budgetEnforcer.record({ toolInvocations: 1 })`.
- **After LLM call:** Call `budgetEnforcer.record({ tokensUsed: tokenCount, estimatedCostUsd: cost, apiCalls: 1 })`.

If the tick loop or agent base class does not yet exist in a form that can be modified, document the integration points and add TODO comments where the wiring will happen. The types and classes must still be fully implemented and tested.

### 5. Tests

#### `test/unit/effects/effect-ledger.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { EffectLedger } from '@/effects/effect-ledger';
```

Test cases:

- **Register creates an effect with status registered**: Register an intent, verify the returned effect has `status: 'registered'`, correct `agentId`, correct `tick`, and a valid `id`.
- **Full lifecycle: register -> executing -> committed**: Walk through all transitions. Verify status and timestamps at each step.
- **Full lifecycle: register -> executing -> failed**: Walk through failure path. Verify `result.success` is `false`.
- **Failed -> compensated**: Fail an effect, then compensate it. Verify status is `'compensated'`.
- **Invalid transition: registered -> committed throws**: Attempt to commit a registered (not executing) effect. Expect error.
- **Invalid transition: committed -> registered throws**: Attempt to re-register a committed effect. Expect error.
- **Invalid transition: committed -> executing throws**: Expect error.
- **Invalid transition: registered -> failed throws**: Expect error (must go through executing first).
- **inspect returns all effects in order**: Register 5 effects. Verify `inspect()` returns all 5 in insertion order.
- **getPending returns only non-terminal effects**: Register 3 effects, commit 1, fail 1. `getPending()` should return 1.
- **getCommitted returns only committed**: Commit 2 out of 3. Verify count.
- **getFailed returns only failed**: Fail 1 out of 3. Verify count.
- **getByTick filters correctly**: Register effects on ticks 1, 1, 2, 3. `getByTick(1)` returns 2 effects.
- **Serialization round-trip preserves all data**: Register several effects in various states. Serialize. Deserialize. Verify all effects match exactly (IDs, statuses, timestamps, intents, results).
- **Deserialized ledger continues working**: Deserialize a ledger, then register a new effect. Verify it works.
- **Effect IDs are unique**: Register 100 effects, verify all IDs are distinct.

#### `test/unit/budget/budget-enforcer.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { BudgetEnforcer } from '@/budget/budget-enforcer';
```

Create a `BudgetLimits` with known values for testing (e.g., `tokensUsed: 1000`, `estimatedCostUsd: 10`, `wallTimeMs: 60000`, `apiCalls: 100`, `toolInvocations: 50`).

Test cases:

- **Fresh enforcer reports ok**: No consumption recorded. `check()` returns `{ status: 'ok', breachedDimensions: [] }`.
- **Recording consumption accumulates**: Record `{ tokensUsed: 100 }` twice. `snapshot().tokensUsed` should be 200.
- **Partial consumption recording**: Record `{ tokensUsed: 100, apiCalls: 5 }`. Other dimensions should remain 0.
- **Soft limit detection (tokens)**: Set limits to 1000, soft limit at 80%. Record 850 tokens. `check()` returns `{ status: 'soft_limit', breachedDimensions: ['tokensUsed'] }`.
- **Hard limit detection (tokens)**: Record 1050 tokens (over 1000 limit). `check()` returns `{ status: 'hard_limit', breachedDimensions: ['tokensUsed'] }`.
- **Hard limit takes precedence**: Record tokens past hard limit AND cost past soft limit. `check().status` should be `'hard_limit'`.
- **Multiple dimensions breached**: Record tokens and cost both past soft limit. `breachedDimensions` should contain both.
- **Each dimension independently**: Test soft and hard limit detection for each of the 5 dimensions individually.
- **Snapshot returns copy**: Modify the returned snapshot object. Verify internal state is not affected.
- **Restore sets consumption**: Record 500 tokens. Take snapshot. Record 200 more. Restore the snapshot. `snapshot().tokensUsed` should be 500 (not 700).
- **Restore enables checkpoint/resume**: Record 300 tokens. Snapshot. Create a new `BudgetEnforcer` with same limits. Restore the snapshot. Record 200 more. Total should be 500.
- **Remaining returns correct values**: Limits 1000, consumed 300. `remaining().tokensUsed` should be 700.
- **Remaining clamps to zero**: Consumed 1200 against limit 1000. `remaining().tokensUsed` should be 0 (not -200).
- **percentUsed is correct**: Consumed 250 against limit 1000. `percentUsed().tokensUsed` should be 25.

---

## Acceptance Criteria

- [ ] Effect ledger tracks the full lifecycle of each effect (register -> executing -> committed/failed)
- [ ] Invalid status transitions throw descriptive errors
- [ ] Serialization/deserialization preserves all effect data exactly (IDs, timestamps, statuses, results)
- [ ] Deserialized ledger continues to function (can register new effects)
- [ ] Budget enforcer correctly detects soft and hard limit breaches across all 5 dimensions
- [ ] Budget enforcer accumulates consumption correctly across multiple `record()` calls
- [ ] Budget state survives checkpoint/restore via `snapshot()` and `restore()`
- [ ] `remaining()` clamps to zero, never returns negative values
- [ ] Tick loop integration points are documented (or implemented if the tick loop exists)
- [ ] All types are exported from `src/types/index.ts` and `src/index.ts`
- [ ] `npm run typecheck` reports 0 errors
- [ ] All tests pass

---

## Estimated Scope

Medium. ~8 files:
- `src/types/effect.ts`
- `src/types/budget.ts` (or extend existing)
- `src/effects/effect-ledger.ts`
- `src/effects/index.ts`
- `src/budget/budget-enforcer.ts`
- `src/budget/index.ts`
- `test/unit/effects/effect-ledger.test.ts`
- `test/unit/budget/budget-enforcer.test.ts`
