import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RecoveryEngine } from '@/supervisor/recovery-engine';
import { InMemoryMessageBus } from '../../helpers/in-memory-message-bus';
import { InMemoryCheckpointStore } from '../../helpers/in-memory-checkpoint-store';
import { createTestCheckpoint } from '../../helpers/checkpoint-factory';
import type { HealthVerdict, RecoveryConfig } from '@/types/supervisor';
import { createDefaultRecoveryConfig } from '@/types/supervisor';

function createVerdict(overrides?: Partial<HealthVerdict>): HealthVerdict {
  return {
    agentId: 'agent-1',
    severity: 'error',
    policiesFired: ['stuck_ticks'],
    details: 'Test verdict',
    timestamp: Date.now(),
    recommendedAction: 'warm_restart',
    ...overrides,
  };
}

describe('RecoveryEngine', () => {
  let bus: InMemoryMessageBus;
  let store: InMemoryCheckpointStore;
  let config: RecoveryConfig;
  let engine: RecoveryEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    bus = new InMemoryMessageBus();
    store = new InMemoryCheckpointStore();
    config = createDefaultRecoveryConfig();
    engine = new RecoveryEngine(bus, store, config);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hot restart publishes recover command', async () => {
    const verdict = createVerdict({ recommendedAction: 'hot_restart' });
    const result = await engine.recover(verdict, 'hot_restart');

    expect(result.success).toBe(true);
    expect(result.strategyUsed).toBe('hot_restart');

    const messages = bus.getMessages('stream:commands:agent-1');
    expect(messages).toHaveLength(1);
    expect(messages[0].payload['type']).toBe('recover');
    expect((messages[0].payload['payload'] as Record<string, unknown>)['strategy']).toBe('hot_restart');
    expect((messages[0].payload['payload'] as Record<string, unknown>)['retryCurrentTick']).toBe(true);
  });

  it('warm restart loads checkpoint and includes checkpointId', async () => {
    const checkpoint = createTestCheckpoint({ agentId: 'agent-1' });
    await store.save(checkpoint);

    const verdict = createVerdict();
    const result = await engine.recover(verdict, 'warm_restart');

    expect(result.success).toBe(true);
    expect(result.strategyUsed).toBe('warm_restart');

    const messages = bus.getMessages('stream:commands:agent-1');
    expect(messages).toHaveLength(1);
    expect(messages[0].payload['type']).toBe('recover');
    expect((messages[0].payload['payload'] as Record<string, unknown>)['strategy']).toBe('warm_restart');
    expect((messages[0].payload['payload'] as Record<string, unknown>)['checkpointId']).toBe(checkpoint.id);
  });

  it('warm restart with no checkpoint returns failure with nextStrategy', async () => {
    const verdict = createVerdict();
    const result = await engine.recover(verdict, 'warm_restart');

    expect(result.success).toBe(false);
    expect(result.nextStrategy).toBe('fresh_start');
  });

  it('escalation sends kill command', async () => {
    const verdict = createVerdict({ severity: 'critical', recommendedAction: 'escalate' });
    const result = await engine.recover(verdict, 'escalate');

    expect(result.success).toBe(false);
    expect(result.strategyUsed).toBe('escalate');

    const messages = bus.getMessages('stream:commands:agent-1');
    expect(messages).toHaveLength(1);
    expect(messages[0].payload['type']).toBe('kill');
  });

  it('counter increments and max restarts triggers escalation', async () => {
    config.maxRestartsPerWindow = 2;
    engine = new RecoveryEngine(bus, store, config);

    const verdict = createVerdict({ recommendedAction: 'hot_restart' });

    await engine.recover(verdict, 'hot_restart');
    expect(engine.getRestartCount('agent-1')).toBe(1);

    await engine.recover(verdict, 'hot_restart');
    expect(engine.getRestartCount('agent-1')).toBe(2);

    // Third attempt should hit the limit and escalate
    const result = await engine.recover(verdict, 'hot_restart');
    expect(result.success).toBe(false);
    expect(result.strategyUsed).toBe('escalate');

    // Kill command should have been published
    const messages = bus.getMessages('stream:commands:agent-1');
    const killMessages = messages.filter((m) => m.payload['type'] === 'kill');
    expect(killMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('restart window resets after expiry', async () => {
    config.restartWindowMs = 10_000;
    engine = new RecoveryEngine(bus, store, config);

    const verdict = createVerdict({ recommendedAction: 'hot_restart' });

    await engine.recover(verdict, 'hot_restart');
    expect(engine.getRestartCount('agent-1')).toBe(1);

    // Advance time past the window
    vi.advanceTimersByTime(11_000);

    await engine.recover(verdict, 'hot_restart');
    // Counter should have reset — now at 1 again, not 2
    expect(engine.getRestartCount('agent-1')).toBe(1);
  });

  it('unimplemented strategies return failure', async () => {
    const verdict = createVerdict();

    const result1 = await engine.recover(verdict, 'context_reconstruction');
    expect(result1.success).toBe(false);
    expect(result1.nextStrategy).toBe('escalate');

    const result2 = await engine.recover(verdict, 'fresh_start');
    expect(result2.success).toBe(false);
    expect(result2.nextStrategy).toBe('escalate');
  });

  it('resetCounters() clears all state', async () => {
    const verdict = createVerdict({ recommendedAction: 'hot_restart' });
    await engine.recover(verdict, 'hot_restart');
    expect(engine.getRestartCount('agent-1')).toBe(1);

    engine.resetCounters();
    expect(engine.getRestartCount('agent-1')).toBe(0);
  });
});
