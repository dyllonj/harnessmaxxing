import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Supervisor } from '@/supervisor/supervisor';
import { RecoveryEngine } from '@/supervisor/recovery-engine';
import { InMemoryCheckpointStore } from '../helpers/in-memory-checkpoint-store';
import { FailingMessageBus, createTestHeartbeat, createChildSpec, createSupervisorConfig } from './helpers';
import type { HealthVerdict } from '@/types/supervisor';
import { createDefaultRecoveryConfig } from '@/types/supervisor';

function createVerdict(agentId: string): HealthVerdict {
  return {
    agentId,
    severity: 'degraded',
    policiesFired: ['stuck_ticks'],
    details: 'Agent stuck for 5 ticks',
    timestamp: Date.now(),
    recommendedAction: 'hot_restart',
  };
}

describe('Chaos: Network Partition', () => {
  let bus: FailingMessageBus;
  let store: InMemoryCheckpointStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    bus = new FailingMessageBus();
    store = new InMemoryCheckpointStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bus partitioned during recovery silently drops command', async () => {
    const engine = new RecoveryEngine(bus, store);

    // Partition the bus — publishes are silently dropped
    bus.partition();

    const verdict = createVerdict('agent-1');
    const result = await engine.recover(verdict, 'hot_restart');

    // RecoveryEngine reports success (it published without error)
    expect(result.success).toBe(true);
    expect(result.strategyUsed).toBe('hot_restart');

    // But the command never arrived
    const commands = bus.getMessages('stream:commands:agent-1');
    expect(commands).toHaveLength(0);
  });

  it('publish throws during recovery and error propagates through supervisor', async () => {
    const config = createSupervisorConfig();
    const supervisor = new Supervisor(config, bus, store);
    await supervisor.start();

    // Make the next publish fail hard
    bus.failNextPublishes(1);

    // Send an unhealthy heartbeat that triggers recovery
    const hb = createTestHeartbeat({
      health: {
        status: 'degraded',
        progress: 0.5,
        coherence: 0.9,
        confidence: 0.85,
        stuckTicks: 5,
        lastMeaningfulAction: 'stuck',
      },
    });

    // The publish failure during recovery will cause the handleHeartbeat promise to reject.
    // Supervisor calls executeRecovery which calls recoveryEngine.recover which calls publishCommand.
    // Since handleHeartbeat is awaited (not fire-and-forget), the error propagates.
    await expect(bus.publishHeartbeat('agent-1', hb)).rejects.toThrow(
      'FailingMessageBus: publish failure injected',
    );

    await supervisor.stop();
  });

  it('partition heals mid-sequence and recovery commands resume delivery', async () => {
    const engine = new RecoveryEngine(bus, store, createDefaultRecoveryConfig());

    // Partition first
    bus.partition();

    const verdict = createVerdict('agent-1');
    await engine.recover(verdict, 'hot_restart');

    // No commands delivered during partition
    expect(bus.getMessages('stream:commands:agent-1')).toHaveLength(0);

    // Heal the partition
    bus.heal();

    // Next recovery should deliver
    await engine.recover(verdict, 'hot_restart');

    const commands = bus.getMessages('stream:commands:agent-1');
    expect(commands).toHaveLength(1);
    expect(commands[0].payload['type']).toBe('recover');
  });
});
