# Sprint 02: Lifecycle State Machine

**Goal:** Implement the core state machine that governs every agent's lifecycle. This is the most critical component — everything depends on it.

**RFC Reference:** Section 4 (Core Concepts — Lifecycle State), Section 5.2 (Agent Lifecycle State Machine)

**Depends on:** Sprint 01 (project scaffolding)

---

## Deliverables

### 1. Lifecycle types (`src/types/lifecycle.ts`)

```typescript
export type LifecycleState =
  | 'UNBORN'
  | 'INITIALIZING'
  | 'RUNNING'
  | 'SLEEPING'
  | 'ERROR'
  | 'CHECKPOINTED'
  | 'RECOVERING'
  | 'DEAD'
  | 'ARCHIVED';

export type Trigger =
  | 'spawn'
  | 'ready'
  | 'init_error'
  | 'sleep'
  | 'wake'
  | 'timer_expired'
  | 'error'
  | 'checkpoint'
  | 'kill'
  | 'budget_exhausted'
  | 'recover'
  | 'restore_failed'
  | 'recovery_success'
  | 'recovery_failed'
  | 'all_strategies_exhausted'
  | 'abandon'
  | 'max_retries'
  | 'resume'
  | 'archive';

export type TransitionEvent = {
  from: LifecycleState;
  to: LifecycleState;
  trigger: Trigger;
  timestamp: number;
};
```

### 2. Lifecycle hook types (`src/types/hooks.ts`)

Define all hook names as a union type. The hooks come from the state transition table in RFC Section 5.2:

```typescript
export type HookName =
  | 'PRE_SPAWN'
  | 'POST_SPAWN'
  | 'ON_INITIALIZE'
  | 'ON_SLEEP'
  | 'ON_WAKE'
  | 'ON_ERROR'
  | 'PRE_CHECKPOINT'
  | 'POST_CHECKPOINT'
  | 'PRE_RECOVERY'
  | 'POST_RECOVERY'
  | 'PRE_DEATH'
  | 'ON_DEATH'
  | 'ON_ARCHIVE'
  | 'POST_RESTORE';
```

Define event payload types for each hook. Define `HookHandler<T>` as a function type `(event: T) => void | Promise<void>`. Define `HookRegistry` as a type mapping hook names to arrays of handlers.

### 3. State machine implementation (`src/lifecycle/state-machine.ts`)

Class `LifecycleStateMachine`:

- Constructor takes optional initial state (default: `UNBORN`)
- Method `apply(trigger: Trigger): TransitionEvent` — applies a trigger, returns the transition event, updates internal state
- Method `canApply(trigger: Trigger): boolean` — checks if a trigger is valid from current state without mutating
- Property `state: LifecycleState` — current state (read-only getter)
- Throws `IllegalTransitionError` for invalid transitions
- Transition table hardcoded as a constant (not dynamic, not configurable)

The transition table must encode all 18 rows from RFC Section 5.2:

| # | From | To | Trigger |
|---|------|-----|---------|
| 1 | UNBORN | INITIALIZING | spawn |
| 2 | INITIALIZING | RUNNING | ready |
| 3 | INITIALIZING | ERROR | init_error |
| 4 | RUNNING | SLEEPING | sleep |
| 5 | RUNNING | ERROR | error |
| 6 | RUNNING | CHECKPOINTED | checkpoint |
| 7 | RUNNING | DEAD | kill |
| 8 | RUNNING | DEAD | budget_exhausted |
| 9 | SLEEPING | RUNNING | wake |
| 10 | SLEEPING | RUNNING | timer_expired |
| 11 | SLEEPING | DEAD | kill |
| 12 | ERROR | RECOVERING | recover |
| 13 | ERROR | DEAD | abandon |
| 14 | ERROR | DEAD | max_retries |
| 15 | CHECKPOINTED | RUNNING | resume |
| 16 | CHECKPOINTED | RECOVERING | restore_failed |
| 17 | RECOVERING | RUNNING | recovery_success |
| 18 | RECOVERING | ERROR | recovery_failed |
| 19 | RECOVERING | DEAD | all_strategies_exhausted |
| 20 | DEAD | ARCHIVED | archive |

Note: Rows 7 and 8 share the same `from` and `to` but have different triggers. Similarly rows 9/10, 13/14. The transition table data structure must handle multiple triggers leading to the same transition.

**Implementation approach:** Use a `Map<LifecycleState, Map<Trigger, LifecycleState>>` or equivalent. The key is `(currentState, trigger)` -> `nextState`. This is a pure lookup — no conditional logic, no guards (guards are a supervisor concern, not a state machine concern for now).

### 4. Hook registry (`src/lifecycle/hook-registry.ts`)

Class `HookRegistry`:

- Method `on(hook: HookName, handler: HookHandler<any>): void` — registers a handler
- Method `off(hook: HookName, handler: HookHandler<any>): void` — removes a handler (by reference equality)
- Method `fire(hook: HookName, event: unknown): Promise<void>` — fires all handlers for a hook in registration order
- Errors in individual handlers are caught and logged (using `pino` or `console.error`) but do not propagate to the caller and do not prevent subsequent handlers from firing
- If no handlers are registered for a hook, `fire` is a no-op

### 5. IllegalTransitionError (`src/lifecycle/errors.ts`)

Custom error class:

```typescript
export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: LifecycleState,
    public readonly trigger: Trigger,
  ) {
    super(`Illegal transition: cannot apply trigger '${trigger}' in state '${from}'`);
    this.name = 'IllegalTransitionError';
  }
}
```

### 6. Export from barrel (`src/lifecycle/index.ts`)

Re-export `LifecycleStateMachine`, `HookRegistry`, `IllegalTransitionError`, and all types from `src/types/lifecycle.ts` and `src/types/hooks.ts`.

### 7. Tests

#### `test/unit/lifecycle/state-machine.test.ts`

Test every valid transition from the table (20 test cases minimum — one per row). Each test:
1. Creates a state machine at the `from` state
2. Calls `apply(trigger)`
3. Asserts the returned `TransitionEvent` has correct `from`, `to`, `trigger`
4. Asserts `machine.state` is now the `to` state

Test every invalid transition from every state. For each of the 9 states, try every trigger that is NOT valid from that state and assert `IllegalTransitionError` is thrown.

Test that the initial state is `UNBORN` when no argument is passed to the constructor.

Test that `canApply` returns `true` for valid triggers and `false` for invalid ones without mutating state.

#### `test/unit/lifecycle/hook-registry.test.ts`

- Test that registering and firing a handler calls the handler with the event
- Test that multiple handlers fire in registration order
- Test that `off` removes a handler (subsequent `fire` does not call it)
- Test that an error in one handler does not prevent other handlers from firing
- Test that `fire` with no registered handlers does not throw
- Test that async handlers are awaited

#### `test/unit/lifecycle/state-machine.property.test.ts`

Property-based test using `fast-check`:

- Generate random sequences of triggers (length 1-100)
- Starting from UNBORN, apply each trigger (catching `IllegalTransitionError` and continuing)
- Assert invariants after each sequence:
  - If the machine reached DEAD, the only valid trigger is `archive`
  - If the machine reached ARCHIVED, no triggers are valid
  - UNBORN is never re-entered after leaving it
  - The state is always one of the 9 valid `LifecycleState` values

Run with at least 1000 iterations.

---

## Acceptance Criteria

- [ ] All 20 transitions from the RFC produce correct state changes
- [ ] Invalid transitions throw `IllegalTransitionError` with correct `from` and `trigger` fields
- [ ] DEAD only transitions to ARCHIVED (via `archive`)
- [ ] ARCHIVED has no outgoing transitions (all triggers throw)
- [ ] UNBORN is not re-enterable (no trigger produces a transition TO UNBORN)
- [ ] Hooks fire in registration order
- [ ] Hook errors do not crash the system or prevent other hooks from firing
- [ ] Property-based tests pass with 1000+ iterations
- [ ] `npm test` passes all tests
- [ ] `npm run typecheck` reports 0 errors

---

## Estimated Scope

Medium. ~8 files, critical correctness requirements. The state machine is small in code but must be exhaustively tested.
