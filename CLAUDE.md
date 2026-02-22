# CLAUDE.md -- harnessmaxxing

## Project Overview

harnessmaxxing is a greenfield agent harness platform for persistent, long-running AI agents with tick-based execution, heartbeat monitoring, checkpointing, and Erlang-inspired supervision. The core design is specified in `docs/rfcs/001-heartbeat-lifecycle.md`. Sprint implementation docs live in `docs/sprints/`.

## Tech Stack

- **Runtime:** TypeScript / Node.js 22+
- **Package manager:** npm (NOT yarn, pnpm, or bun)
- **Testing:** vitest
- **Logging:** pino (structured JSON)
- **Message bus:** Redis Streams via `ioredis` (behind `MessageBus` interface)
- **Checkpoint store:** SQLite via `better-sqlite3` (behind `CheckpointStore` interface)
- **CLI:** `commander` + `ink` (React for CLI)
- **Serialization:** JSON throughout
- **Config:** Plain TypeScript objects (no YAML, no TOML, no .env)

## Architecture Rules

- Only TWO interfaces exist: `CheckpointStore` and `MessageBus`. Do not create new interfaces.
- No classes except `Agent` subclasses. Use plain functions and objects everywhere else.
- All agent state must be JSON-serializable. No `Date`, `Map`, `Set`, or class instances in state.
- Agent state type `S` must extend `Record<string, unknown>`.
- Configuration is TypeScript objects passed directly. No env var parsing, no YAML, no TOML.
- No RxJS, no EventEmitters for core data flow. Use the `MessageBus`.
- Lifecycle errors are lifecycle events, not thrown exceptions. The only exception type thrown is `IllegalTransitionError`.

## Code Style

- `strict: true` in tsconfig. No `any`. No `as` casts except in test code.
- Use `type` for data shapes. Reserve `interface` for `CheckpointStore` and `MessageBus` only.
- Separate type exports from value exports: `export type { Heartbeat }` / `export { Agent }`.
- File naming: kebab-case (`lifecycle-state-machine.ts`).
- One export per file for classes. Multiple exports OK for types and pure functions.
- No default exports. Named exports only.
- Use `node:` prefix for Node built-ins: `import { createHash } from 'node:crypto'`.
- Prefer `unknown` over `any`. Narrow types, don't cast.

## Testing Rules

- Unit tests: `test/unit/` mirroring `src/` structure. File naming: `<module>.test.ts`.
- Integration tests (requiring Redis/SQLite): `test/integration/`.
- Use the test harness: `MockLLM`, `InMemoryMessageBus`, `InMemoryCheckpointStore`, `ControllableClock`.
- No mocking frameworks. Use the provided in-memory implementations.
- Every state machine transition needs a test. Every error path needs a test.

## Key Directories

```
src/agent/       -- Agent base class, tick loop
src/supervisor/  -- Health assessor, recovery engine
src/checkpoint/  -- CheckpointStore interface + SQLite impl
src/bus/         -- MessageBus interface + Redis Streams impl
src/heartbeat/   -- Heartbeat types, emission logic
src/lifecycle/   -- State machine, transitions, hooks
src/effects/     -- Side effect ledger
src/budget/      -- Budget types, enforcement
src/cli/         -- Commander + ink CLI
src/types/       -- Shared type definitions
test/unit/       -- Fast, deterministic tests
test/integration/-- Tests requiring Redis/SQLite
test/chaos/      -- Failure injection tests
test/helpers/    -- Test harness, mocks
```

## Before You Code

1. Read the RFC: `docs/rfcs/001-heartbeat-lifecycle.md`
2. Read the sprint doc for your current task: `docs/sprints/`
3. Check `AGENTS.md` for agent-specific patterns
4. Run `npm test` before and after changes
5. Run `npm run typecheck` to verify no type errors

## Common Mistakes

- **Creating new interfaces.** Only `CheckpointStore` and `MessageBus` are interfaces. Everything else is concrete.
- **Using `class` for data structures.** Use `type` + plain objects.
- **Putting business logic in constructors.** Use `onInitialize()` lifecycle hook.
- **Throwing from lifecycle hooks.** Return errors via the event system.
- **Cross-boundary `../` imports.** Import from the package root or within your own module.
- **Adding npm dependencies.** The dep list is intentionally minimal. Ask the human first.
- **Using `console.log`.** Use pino logger.
- **Storing non-serializable values in agent state.** State must survive JSON roundtrip.
