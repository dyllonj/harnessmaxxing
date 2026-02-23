import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMessageBus } from '../../helpers/in-memory-message-bus';
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

describe('InMemoryMessageBus', () => {
  let bus: InMemoryMessageBus;

  beforeEach(() => {
    bus = new InMemoryMessageBus();
  });

  it('publish and subscribe — handler called with correct message', async () => {
    const received: Message[] = [];
    await bus.subscribe('test-channel', async (msg) => {
      received.push(msg);
    });

    const msg = createTestMessage({ payload: { greeting: 'hello' } });
    await bus.publish('test-channel', msg);

    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({ greeting: 'hello' });
    expect(received[0].id).toBe('inmem-1');
  });

  it('multiple subscribers — both handlers receive the message', async () => {
    const received1: Message[] = [];
    const received2: Message[] = [];

    await bus.subscribe('test-channel', async (msg) => {
      received1.push(msg);
    });
    await bus.subscribe('test-channel', async (msg) => {
      received2.push(msg);
    });

    await bus.publish('test-channel', createTestMessage());

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  it('unsubscribe — handler not called after unsubscribe', async () => {
    const received: Message[] = [];
    const sub = await bus.subscribe('test-channel', async (msg) => {
      received.push(msg);
    });

    await bus.publish('test-channel', createTestMessage());
    expect(received).toHaveLength(1);

    await sub.unsubscribe();

    await bus.publish('test-channel', createTestMessage());
    expect(received).toHaveLength(1);
  });

  it('message ordering — 3 messages returned in order by getMessages()', async () => {
    await bus.publish('ordered', createTestMessage({ payload: { seq: 1 } }));
    await bus.publish('ordered', createTestMessage({ payload: { seq: 2 } }));
    await bus.publish('ordered', createTestMessage({ payload: { seq: 3 } }));

    const messages = bus.getMessages('ordered');
    expect(messages).toHaveLength(3);
    expect(messages[0].payload['seq']).toBe(1);
    expect(messages[1].payload['seq']).toBe(2);
    expect(messages[2].payload['seq']).toBe(3);
  });

  it('consumer groups — idempotent creation', async () => {
    await bus.createConsumerGroup('ch', 'group-1');
    await bus.createConsumerGroup('ch', 'group-1');
    // No error thrown — passes
  });

  it('acknowledge — getAcknowledged() contains the message ID', async () => {
    await bus.publish('ack-test', createTestMessage());
    const messages = bus.getMessages('ack-test');
    const msgId = messages[0].id;

    await bus.acknowledge('ack-test', 'group', msgId);

    expect(bus.getAcknowledged().has(msgId)).toBe(true);
  });

  it('publishHeartbeat — appears on stream:heartbeats with correct payload', async () => {
    const heartbeat = createTestHeartbeat('agent-1');
    await bus.publishHeartbeat('agent-1', heartbeat);

    const messages = bus.getMessages('stream:heartbeats');
    expect(messages).toHaveLength(1);
    expect(messages[0].payload['agentId']).toBe('agent-1');
    expect(messages[0].payload['heartbeat']).toBeDefined();
  });

  it('subscribeHeartbeats wildcard — pattern * receives all heartbeats', async () => {
    const received: Heartbeat[] = [];
    await bus.subscribeHeartbeats('*', async (hb) => {
      received.push(hb);
    });

    await bus.publishHeartbeat('agent-1', createTestHeartbeat('agent-1'));
    await bus.publishHeartbeat('agent-2', createTestHeartbeat('agent-2'));

    expect(received).toHaveLength(2);
    expect(received[0].agentId).toBe('agent-1');
    expect(received[1].agentId).toBe('agent-2');
  });

  it('subscribeHeartbeats with filter — pattern agent-1* only receives matching agent', async () => {
    const received: Heartbeat[] = [];
    await bus.subscribeHeartbeats('agent-1*', async (hb) => {
      received.push(hb);
    });

    await bus.publishHeartbeat('agent-1', createTestHeartbeat('agent-1'));
    await bus.publishHeartbeat('agent-2', createTestHeartbeat('agent-2'));
    await bus.publishHeartbeat('agent-1-child', createTestHeartbeat('agent-1-child'));

    expect(received).toHaveLength(2);
    expect(received[0].agentId).toBe('agent-1');
    expect(received[1].agentId).toBe('agent-1-child');
  });

  it('concurrent publishers — 100 concurrent publishes all arrive', async () => {
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(bus.publish('concurrent', createTestMessage({ payload: { i } })));
    }
    await Promise.all(promises);

    const messages = bus.getMessages('concurrent');
    expect(messages).toHaveLength(100);
  });

  it('clear resets state — all inspection methods return empty after clear()', async () => {
    await bus.publish('ch1', createTestMessage());
    await bus.acknowledge('ch1', 'g', 'inmem-1');
    await bus.createConsumerGroup('ch1', 'group');

    bus.clear();

    expect(bus.getMessages('ch1')).toHaveLength(0);
    expect(bus.getAcknowledged().size).toBe(0);
  });
});
