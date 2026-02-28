import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Supervisor } from '@/supervisor/supervisor';
import { RecoveryEngine } from '@/supervisor/recovery-engine';
import { InMemoryMessageBus } from '../helpers/in-memory-message-bus';
import { InMemoryCheckpointStore } from '../helpers/in-memory-checkpoint-store';
import { createTestHeartbeat, createChildSpec, createSupervisorConfig } from './helpers';
import type { HealthVerdict } from '@/types/supervisor';
import { createDefaultRecoveryConfig } from '@/types/supervisor';

describe('Chaos: Cascade Failure', () => {
  let bus: InMemoryMessageBus;
  let store: InMemoryCheckpointStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    bus = new InMemoryMessageBus();
    store = new InMemoryCheckpointStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('5 agents report stuck_ticks simultaneously and each gets own recovery command (one_for_one)', async () => {
    const agents = Array.from({ length: 5 }, (_, i) =>
      createChildSpec({ id: `agent-${i}`, agentId: `agent-${i}` }),
    );
    const config = createSupervisorConfig(agents);
    const supervisor = new Supervisor(config, bus, store);
    await supervisor.start();

    // All 5 agents report stuck ticks simultaneously
    const heartbeats = agents.map((agent) =>
      createTestHeartbeat({
        agentId: agent.agentId,
        health: {
          status: 'degraded',
          progress: 0.5,
          coherence: 0.9,
          confidence: 0.85,
          stuckTicks: 5,
          lastMeaningfulAction: 'stuck',
        },
      }),
    );

    await Promise.all(
      heartbeats.map((hb) => bus.publishHeartbeat(hb.agentId, hb)),
    );

    // Each agent should have its own recovery command (one_for_one isolation)
    for (let i = 0; i < 5; i++) {
      const commands = bus.getMessages(`stream:commands:agent-${i}`);
      expect(commands.length).toBeGreaterThanOrEqual(1);
      expect(commands[0].payload['type']).toBe('recover');
    }

    await supervisor.stop();
  });

  it('exceeding maxRestartsPerWindow auto-escalates to kill', async () => {
    const recoveryConfig = createDefaultRecoveryConfig();
    recoveryConfig.maxRestartsPerWindow = 3;

    const engine = new RecoveryEngine(bus, store, recoveryConfig);

    const verdict: HealthVerdict = {
      agentId: 'agent-1',
      severity: 'degraded',
      policiesFired: ['stuck_ticks'],
      details: 'Agent stuck',
      timestamp: Date.now(),
      recommendedAction: 'hot_restart',
    };

    // Exhaust the restart budget
    for (let i = 0; i < 3; i++) {
      const result = await engine.recover(verdict, 'hot_restart');
      expect(result.success).toBe(true);
      expect(result.strategyUsed).toBe('hot_restart');
    }

    // Next attempt should auto-escalate to kill
    const result = await engine.recover(verdict, 'hot_restart');
    expect(result.success).toBe(false);
    expect(result.strategyUsed).toBe('escalate');
    expect(result.details).toContain('Max restarts');

    // Verify a kill command was published
    const commands = bus.getMessages('stream:commands:agent-1');
    const killCommands = commands.filter((m) => m.payload['type'] === 'kill');
    expect(killCommands.length).toBeGreaterThanOrEqual(1);
  });

  it('multiple agents hit max restart limit independently', async () => {
    const recoveryConfig = createDefaultRecoveryConfig();
    recoveryConfig.maxRestartsPerWindow = 2;

    const engine = new RecoveryEngine(bus, store, recoveryConfig);

    const verdictA: HealthVerdict = {
      agentId: 'agent-a',
      severity: 'degraded',
      policiesFired: ['stuck_ticks'],
      details: 'Agent stuck',
      timestamp: Date.now(),
      recommendedAction: 'hot_restart',
    };

    const verdictB: HealthVerdict = {
      agentId: 'agent-b',
      severity: 'degraded',
      policiesFired: ['stuck_ticks'],
      details: 'Agent stuck',
      timestamp: Date.now(),
      recommendedAction: 'hot_restart',
    };

    // Exhaust agent-a's budget
    await engine.recover(verdictA, 'hot_restart');
    await engine.recover(verdictA, 'hot_restart');
    const resultA = await engine.recover(verdictA, 'hot_restart');
    expect(resultA.success).toBe(false);
    expect(resultA.strategyUsed).toBe('escalate');

    // agent-b should still have its full budget
    const resultB1 = await engine.recover(verdictB, 'hot_restart');
    expect(resultB1.success).toBe(true);

    const resultB2 = await engine.recover(verdictB, 'hot_restart');
    expect(resultB2.success).toBe(true);

    // Now agent-b hits its limit too
    const resultB3 = await engine.recover(verdictB, 'hot_restart');
    expect(resultB3.success).toBe(false);
    expect(resultB3.strategyUsed).toBe('escalate');
  });
});
