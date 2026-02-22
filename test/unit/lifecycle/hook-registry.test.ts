import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { createHookRegistry } from '@/lifecycle/hook-registry';
import type { HookHandler } from '@/types/hooks';

const logger = pino({ level: 'silent' });

describe('createHookRegistry', () => {
  it('calls handler with correct event payload', async () => {
    const registry = createHookRegistry(logger);
    const received: unknown[] = [];
    const handler: HookHandler<unknown> = (event) => {
      received.push(event);
    };

    registry.on('PRE_SPAWN', handler);
    const event = { agentId: 'a1', timestamp: 1000, config: {} };
    await registry.fire('PRE_SPAWN', event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  it('fires multiple handlers in registration order', async () => {
    const registry = createHookRegistry(logger);
    const order: number[] = [];

    const h1: HookHandler<unknown> = () => { order.push(1); };
    const h2: HookHandler<unknown> = () => { order.push(2); };
    const h3: HookHandler<unknown> = () => { order.push(3); };

    registry.on('POST_TICK', h1);
    registry.on('POST_TICK', h2);
    registry.on('POST_TICK', h3);

    await registry.fire('POST_TICK', { agentId: 'a1', timestamp: 1000, tickNumber: 1, durationMs: 50 });

    expect(order).toEqual([1, 2, 3]);
  });

  it('off() removes handler so it is not called on subsequent fire', async () => {
    const registry = createHookRegistry(logger);
    let callCount = 0;
    const handler: HookHandler<unknown> = () => { callCount++; };

    registry.on('PRE_KILL', handler);
    await registry.fire('PRE_KILL', { agentId: 'a1', timestamp: 1000, reason: 'test' });
    expect(callCount).toBe(1);

    registry.off('PRE_KILL', handler);
    await registry.fire('PRE_KILL', { agentId: 'a1', timestamp: 2000, reason: 'test' });
    expect(callCount).toBe(1);
  });

  it('error in one handler does not prevent others from firing', async () => {
    const registry = createHookRegistry(logger);
    const order: number[] = [];

    const h1: HookHandler<unknown> = () => { order.push(1); };
    const h2: HookHandler<unknown> = () => { throw new Error('boom'); };
    const h3: HookHandler<unknown> = () => { order.push(3); };

    registry.on('PRE_SLEEP', h1);
    registry.on('PRE_SLEEP', h2);
    registry.on('PRE_SLEEP', h3);

    await registry.fire('PRE_SLEEP', { agentId: 'a1', timestamp: 1000, reason: 'tired' });

    expect(order).toEqual([1, 3]);
  });

  it('fire() with no handlers is a no-op', async () => {
    const registry = createHookRegistry(logger);
    await expect(
      registry.fire('POST_RESTORE', { agentId: 'a1', timestamp: 1000, checkpointId: 'cp1' }),
    ).resolves.toBeUndefined();
  });

  it('async handlers are awaited', async () => {
    const registry = createHookRegistry(logger);
    const order: number[] = [];

    const h1: HookHandler<unknown> = async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(1);
    };
    const h2: HookHandler<unknown> = () => { order.push(2); };

    registry.on('PRE_CHECKPOINT', h1);
    registry.on('PRE_CHECKPOINT', h2);

    await registry.fire('PRE_CHECKPOINT', { agentId: 'a1', timestamp: 1000 });

    expect(order).toEqual([1, 2]);
  });

  it('async handler errors are caught and others still fire', async () => {
    const registry = createHookRegistry(logger);
    const order: number[] = [];

    const h1: HookHandler<unknown> = async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('async boom');
    };
    const h2: HookHandler<unknown> = () => { order.push(2); };

    registry.on('POST_RECOVER', h1);
    registry.on('POST_RECOVER', h2);

    await registry.fire('POST_RECOVER', {
      agentId: 'a1',
      timestamp: 1000,
      strategy: 'hot_restart',
      success: true,
    });

    expect(order).toEqual([2]);
  });
});
