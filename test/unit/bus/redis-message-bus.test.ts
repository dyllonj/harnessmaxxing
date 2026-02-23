import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Redis } from 'ioredis';
import { RedisMessageBus } from '@/bus/redis-message-bus';
import type { Message } from '@/types/message';
import type { Heartbeat } from '@/types/heartbeat';

function createTestMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: '',
    channel: '',
    timestamp: Date.now(),
    payload: { key: 'value' },
    ...overrides,
  };
}

function createTestHeartbeat(agentId: string): Heartbeat {
  return {
    agentId,
    epoch: 1,
    tick: 1,
    timestamp: Date.now(),
    health: {
      status: 'healthy',
      progress: 0.5,
      coherence: 0.9,
      confidence: 0.8,
      stuckTicks: 0,
      lastMeaningfulAction: 'test',
    },
    resources: {
      tokensUsed: 100,
      tokensRemaining: 9900,
      estimatedCostUsd: 0.01,
      wallTimeMs: 1000,
      apiCalls: 1,
      toolInvocations: 0,
    },
    execution: {
      state: 'running',
      currentTask: 'test-task',
      activeTools: [],
      pendingEffects: 0,
      subAgents: [],
      contextWindowUsage: 0.1,
      tickDurationMs: 500,
      tickRate: 2,
    },
  };
}

let redisAvailable = false;

beforeAll(async () => {
  try {
    const client = new Redis({ lazyConnect: true, maxRetriesPerRequest: 1 });
    await client.connect();
    await client.ping();
    redisAvailable = true;
    client.disconnect();
  } catch {
    redisAvailable = false;
  }
});

async function flushStreams(): Promise<void> {
  const client = new Redis();
  const keys = await client.keys('stream:*');
  if (keys.length > 0) {
    await client.del(...keys);
  }
  // Also clean up test channels
  const testKeys = await client.keys('test-*');
  if (testKeys.length > 0) {
    await client.del(...testKeys);
  }
  client.disconnect();
}

describe('RedisMessageBus', () => {
  let bus: RedisMessageBus;

  beforeAll(async () => {
    if (!redisAvailable) return;
    bus = new RedisMessageBus();
  });

  afterAll(async () => {
    if (!redisAvailable) return;
    await bus.close();
  });

  beforeEach(async () => {
    if (!redisAvailable) return;
    await flushStreams();
  });

  it('publish and subscribe round-trip', async ({ skip }) => {
    if (!redisAvailable) skip();

    const received: Message[] = [];
    const sub = await bus.subscribe('test-roundtrip', async (msg) => {
      received.push(msg);
    });

    const msg = createTestMessage({ payload: { test: 'roundtrip' } });
    await bus.publish('test-roundtrip', msg);

    // Wait for async delivery
    await new Promise((r) => setTimeout(r, 1000));

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].payload).toEqual(expect.objectContaining({ test: 'roundtrip' }));

    await sub.unsubscribe();
  });

  it('consumer group creation is idempotent', async ({ skip }) => {
    if (!redisAvailable) skip();

    await bus.createConsumerGroup('test-idempotent', 'my-group');
    await bus.createConsumerGroup('test-idempotent', 'my-group');
    // No error thrown
  });

  it('acknowledgment succeeds', async ({ skip }) => {
    if (!redisAvailable) skip();

    await bus.createConsumerGroup('test-ack', 'ack-group');
    const msg = createTestMessage();
    await bus.publish('test-ack', msg);

    // acknowledge should not throw
    await bus.acknowledge('test-ack', 'ack-group', msg.id);
  });

  it('stream trimming — MAXLEN ~ keeps stream bounded', async ({ skip }) => {
    if (!redisAvailable) skip();

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 15000; i++) {
      promises.push(bus.publish('test-trim', createTestMessage({ payload: { i } })));
    }
    await Promise.all(promises);

    const client = new Redis();
    const len = await client.xlen('test-trim');
    client.disconnect();

    // MAXLEN ~ 10000 is approximate, but should be well under 15000
    expect(len).toBeLessThan(15000);
  }, 30000);

  it('publishHeartbeat round-trip', async ({ skip }) => {
    if (!redisAvailable) skip();

    const received: Heartbeat[] = [];
    const sub = await bus.subscribeHeartbeats('*', async (hb) => {
      received.push(hb);
    });

    await bus.publishHeartbeat('agent-redis-1', createTestHeartbeat('agent-redis-1'));

    await new Promise((r) => setTimeout(r, 1000));

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].agentId).toBe('agent-redis-1');

    await sub.unsubscribe();
  });

  it('subscribeHeartbeats with pattern filter', async ({ skip }) => {
    if (!redisAvailable) skip();

    const received: Heartbeat[] = [];
    const sub = await bus.subscribeHeartbeats('agent-match*', async (hb) => {
      received.push(hb);
    });

    await bus.publishHeartbeat('agent-match-1', createTestHeartbeat('agent-match-1'));
    await bus.publishHeartbeat('agent-other', createTestHeartbeat('agent-other'));

    await new Promise((r) => setTimeout(r, 1000));

    // Should only receive the matching one
    const matching = received.filter((hb) => hb.agentId === 'agent-match-1');
    expect(matching.length).toBeGreaterThanOrEqual(1);
    const others = received.filter((hb) => hb.agentId === 'agent-other');
    expect(others).toHaveLength(0);

    await sub.unsubscribe();
  });

  it('unsubscribe stops delivery', async ({ skip }) => {
    if (!redisAvailable) skip();

    const received: Message[] = [];
    const sub = await bus.subscribe('test-unsub', async (msg) => {
      received.push(msg);
    });

    await bus.publish('test-unsub', createTestMessage({ payload: { before: true } }));
    await new Promise((r) => setTimeout(r, 1000));
    const countBefore = received.length;

    await sub.unsubscribe();
    await new Promise((r) => setTimeout(r, 200));

    await bus.publish('test-unsub', createTestMessage({ payload: { after: true } }));
    await new Promise((r) => setTimeout(r, 1000));

    // After unsubscribe, no new messages should arrive
    expect(received.length).toBe(countBefore);
  });

  it('connection error handling — bad URL does not crash', async ({ skip }) => {
    if (!redisAvailable) skip();

    const badBus = new RedisMessageBus('redis://localhost:59999');
    // publish should not throw, just log
    await badBus.publish('test', createTestMessage());
    await badBus.close();
  });

  it('close cleans up clients', async ({ skip }) => {
    if (!redisAvailable) skip();

    const tempBus = new RedisMessageBus();
    await tempBus.subscribe('test-close', async () => {
      // noop
    });
    await tempBus.close();
    // After close, publishing should not throw (graceful degradation)
    await tempBus.publish('test-close', createTestMessage());
  });
});
