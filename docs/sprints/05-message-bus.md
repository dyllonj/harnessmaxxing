# Sprint 05: Message Bus

**Goal:** Implement the MessageBus interface and its Redis Streams default implementation. This is the second of two extension seams.

**RFC Reference:** Section 5.1 (System Overview -- message flow), Section 6 (Technology Choices -- Redis Streams), Section 7.5 (Interface Definitions)

**Depends on:** Sprint 01 (project setup), Sprint 02 (lifecycle types), Sprint 03 (heartbeat types)

---

## Deliverables

### 1. Message types (`src/types/message.ts`)

Define the core message primitives used by the bus.

```typescript
export type Message = {
  id: string;
  channel: string;
  timestamp: number;
  payload: Record<string, unknown>;
};

export type LifecycleCommand = {
  type: 'kill' | 'checkpoint' | 'pause' | 'resume' | 'recover' | 'budget_update';
  targetAgentId: string;
  timestamp: number;
  nonce: string;
  payload?: Record<string, unknown>;
};

export type Subscription = {
  unsubscribe(): Promise<void>;
};

export type MessageHandler = (message: Message) => Promise<void>;

export type HeartbeatHandler = (heartbeat: Heartbeat) => Promise<void>;
```

`Heartbeat` is imported from `@/types/heartbeat` (defined in Sprint 03). Re-export all message types from `src/types/index.ts`.

### 2. MessageBus interface (`src/bus/message-bus.ts`)

```typescript
import { Message, MessageHandler, Subscription, HeartbeatHandler } from '@/types/message';
import { Heartbeat } from '@/types/heartbeat';

export interface MessageBus {
  publish(channel: string, message: Message): Promise<void>;
  subscribe(channel: string, handler: MessageHandler): Promise<Subscription>;
  createConsumerGroup(channel: string, group: string): Promise<void>;
  acknowledge(channel: string, group: string, messageId: string): Promise<void>;
  publishHeartbeat(agentId: string, heartbeat: Heartbeat): Promise<void>;
  subscribeHeartbeats(pattern: string, handler: HeartbeatHandler): Promise<Subscription>;
}
```

This is a pure interface -- no implementation logic. Export it from `src/bus/index.ts` and from `src/index.ts`.

### 3. Redis Streams implementation (`src/bus/redis-message-bus.ts`)

Class `RedisMessageBus implements MessageBus`.

**Constructor:**
- Takes an optional Redis connection URL (default: `redis://localhost:6379`).
- Creates an `ioredis` client. Creates a second client for blocking reads (Redis requires separate connections for blocking commands).
- Sets up error handlers on both clients that log and do not throw.

**Stream naming convention:**
- Heartbeats: `stream:heartbeats`
- Per-agent commands: `stream:commands:{agentId}`
- System events: `stream:events`

**Method implementations:**

- `publish(channel, message)`:
  - Calls `XADD channel MAXLEN ~ 10000 * field1 value1 ...`.
  - Flatten the message into key-value pairs for Redis. Store the full message JSON under a `data` field for simplicity.
  - Sets the message `id` to the stream entry ID returned by `XADD`.

- `subscribe(channel, handler)`:
  - Generates a unique consumer name (e.g., `consumer-${uuid()}`).
  - Ensures a consumer group exists for the channel (call `createConsumerGroup` internally, catch `BUSYGROUP` errors silently).
  - Spawns an async loop that calls `XREADGROUP GROUP groupName consumerName COUNT 10 BLOCK 5000 STREAMS channel >`.
  - For each message received, deserialize and call `handler(message)`. Auto-acknowledge after successful handler execution.
  - The loop checks an `aborted` flag each iteration.
  - Returns a `Subscription` whose `unsubscribe()` sets the `aborted` flag and breaks the loop.

- `createConsumerGroup(channel, group)`:
  - Calls `XGROUP CREATE channel group 0 MKSTREAM`.
  - Catches `BUSYGROUP` error (group already exists) silently.

- `acknowledge(channel, group, messageId)`:
  - Calls `XACK channel group messageId`.

- `publishHeartbeat(agentId, heartbeat)`:
  - Constructs a `Message` with `channel: 'stream:heartbeats'`, `payload: { agentId, ...heartbeat }`.
  - Calls `this.publish('stream:heartbeats', message)`.

- `subscribeHeartbeats(pattern, handler)`:
  - Subscribes to `stream:heartbeats`.
  - Wraps the internal `MessageHandler` to extract the heartbeat from `message.payload` and call `handler(heartbeat)`.
  - The `pattern` parameter filters heartbeats by `agentId` using a glob match (e.g., `agent-*` matches `agent-123`). If pattern is `*`, all heartbeats pass through.

- `close()`:
  - Disconnects both Redis clients.
  - Aborts all active subscription loops.

**Error handling:**
- Wrap all Redis calls in try/catch. Log errors with `pino`. Never let a Redis error crash the process.
- On connection loss, rely on ioredis built-in reconnect (it does this by default). Log reconnection events.

### 4. In-memory implementation for tests (`test/helpers/in-memory-message-bus.ts`)

Class `InMemoryMessageBus implements MessageBus`.

**Internal state:**
- `messages: Map<string, Message[]>` -- stores all published messages per channel.
- `subscribers: Map<string, MessageHandler[]>` -- active handlers per channel.
- `groups: Map<string, Set<string>>` -- consumer group names per channel.
- `acknowledged: Set<string>` -- set of acknowledged message IDs.

**Method implementations:**

- `publish(channel, message)`:
  - Assigns a sequential ID if not set (e.g., `inmem-1`, `inmem-2`, ...).
  - Appends to the channel's message array.
  - Immediately invokes all registered handlers for that channel (synchronous fan-out via `Promise.all`).

- `subscribe(channel, handler)`:
  - Adds handler to the subscribers map.
  - Returns a `Subscription` whose `unsubscribe()` removes the handler from the array.

- `createConsumerGroup(channel, group)`:
  - Adds the group name to the groups set for that channel. No-op if already exists.

- `acknowledge(channel, group, messageId)`:
  - Adds the messageId to the acknowledged set.

- `publishHeartbeat(agentId, heartbeat)`:
  - Same convenience wrapper logic as Redis implementation.

- `subscribeHeartbeats(pattern, handler)`:
  - Same convenience wrapper logic as Redis implementation.

**Inspection methods (test-only):**

- `getMessages(channel: string): Message[]` -- returns all messages published to a channel.
- `clear(): void` -- resets all internal state.
- `getAcknowledged(): Set<string>` -- returns acknowledged message IDs.

### 5. Tests

#### `test/unit/bus/in-memory-message-bus.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMessageBus } from '../../helpers/in-memory-message-bus';
```

Test cases:

- **publish and subscribe**: Subscribe to a channel, publish a message, verify handler is called with the correct message.
- **multiple subscribers**: Two handlers on the same channel both receive the message.
- **unsubscribe**: Subscribe, unsubscribe, publish -- handler should NOT be called.
- **message ordering**: Publish 3 messages, verify `getMessages()` returns them in order.
- **consumer groups**: Create a group, verify no error. Create the same group again, verify no error (idempotent).
- **acknowledge**: Publish, acknowledge, verify `getAcknowledged()` contains the message ID.
- **publishHeartbeat convenience**: Publish a heartbeat, verify it appears on `stream:heartbeats` channel with correct payload.
- **subscribeHeartbeats convenience**: Subscribe to heartbeats with pattern `*`, publish a heartbeat, verify handler receives the heartbeat object.
- **subscribeHeartbeats with pattern**: Subscribe with pattern `agent-1*`, publish heartbeats for `agent-1` and `agent-2`, verify only `agent-1` heartbeat is received.
- **concurrent publishers**: Use `Promise.all` to publish 100 messages concurrently, verify all 100 arrive and are in the messages array.
- **clear resets state**: Publish messages, call `clear()`, verify `getMessages()` returns empty.

#### `test/unit/bus/redis-message-bus.test.ts`

These tests require a running Redis instance. Gate them behind an environment variable or mark them in a separate Vitest workspace/project for integration tests.

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { RedisMessageBus } from '@/bus/redis-message-bus';
```

Test cases:

- **publish and subscribe round-trip**: Publish a message, subscriber receives it within 10 seconds.
- **consumer group creation**: Create a group, verify no error. Create again, verify idempotent.
- **acknowledgment**: Publish, receive, acknowledge -- verify `XACK` succeeds.
- **stream trimming**: Publish 15000 messages to a channel, verify stream length is approximately 10000 (MAXLEN ~ is approximate).
- **publishHeartbeat**: Publish a heartbeat, subscribe to `stream:heartbeats`, verify receipt.
- **subscribeHeartbeats**: Same as in-memory test but against real Redis.
- **unsubscribe stops delivery**: Subscribe, unsubscribe, publish another message, wait 2 seconds, verify handler was NOT called for the second message.
- **connection error handling**: Disconnect Redis mid-test, verify no crash, verify reconnection.
- **close cleans up**: Call `close()`, verify both clients are disconnected.

Use `beforeAll` to create the `RedisMessageBus` instance and `afterAll` to call `close()`. Use `beforeEach` to flush the test streams (`DEL stream:*`).

---

## Acceptance Criteria

- [ ] `MessageBus` interface matches RFC Section 7.5
- [ ] Redis Streams implementation handles connection errors without crashing
- [ ] Heartbeat convenience methods work correctly (publish and subscribe)
- [ ] Consumer groups enable fan-out (multiple subscribers each get the message)
- [ ] In-memory and Redis implementations pass the same logical test suite
- [ ] Stream trimming via `MAXLEN ~` prevents unbounded growth
- [ ] Subscriptions can be cleanly unsubscribed (no lingering loops or handlers)
- [ ] All types are exported from `src/types/index.ts` and `src/index.ts`
- [ ] `npm run typecheck` reports 0 errors
- [ ] `npm test` passes all unit tests (in-memory tests; Redis tests may be skipped in CI)

---

## Estimated Scope

Medium. ~7 files:
- `src/types/message.ts`
- `src/bus/message-bus.ts`
- `src/bus/redis-message-bus.ts`
- `src/bus/index.ts`
- `test/helpers/in-memory-message-bus.ts`
- `test/unit/bus/in-memory-message-bus.test.ts`
- `test/unit/bus/redis-message-bus.test.ts`
