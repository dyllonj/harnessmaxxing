import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Supervisor } from '@/supervisor/supervisor';
import { InMemoryMessageBus } from '../../helpers/in-memory-message-bus';
import { InMemoryCheckpointStore } from '../../helpers/in-memory-checkpoint-store';
import type { Heartbeat } from '@/types/heartbeat';
import type { SupervisorConfig, ChildSpec } from '@/types/supervisor';
import { createDefaultHealthPolicyConfig, createDefaultRecoveryConfig } from '@/types/supervisor';

function createTestHeartbeat(overrides?: Partial<Heartbeat>): Heartbeat {
  return {
    agentId: 'agent-1',
    epoch: 1,
    tick: 1,
    timestamp: Date.now(),
    health: {
      status: 'healthy',
      progress: 0.5,
      coherence: 0.9,
      confidence: 0.85,
      stuckTicks: 0,
      lastMeaningfulAction: 'processed message',
    },
    resources: {
      tokensUsed: 100,
      tokensRemaining: 9900,
      estimatedCostUsd: 0.01,
      wallTimeMs: 5000,
      apiCalls: 2,
      toolInvocations: 1,
    },
    execution: {
      state: 'RUNNING',
      currentTask: 'task-001',
      activeTools: [],
      pendingEffects: 0,
      subAgents: [],
      contextWindowUsage: 0.15,
      tickDurationMs: 250,
      tickRate: 4,
    },
    ...overrides,
  };
}

function createChildSpec(overrides?: Partial<ChildSpec>): ChildSpec {
  return {
    id: 'agent-1',
    agentId: 'agent-1',
    config: {
      budget: {
        tokens: { soft: 8000, hard: 10000 },
        costUsd: { soft: 1, hard: 2 },
        wallTimeMs: { soft: 30000, hard: 60000 },
        toolInvocations: { soft: 50, hard: 100 },
      },
      tickIntervalMs: 5000,
      checkpointEveryNTicks: 10,
    },
    recoveryConfig: createDefaultRecoveryConfig(),
    ...overrides,
  };
}

function createSupervisorConfig(children?: ChildSpec[]): SupervisorConfig {
  return {
    strategy: 'one_for_one',
    healthPolicy: createDefaultHealthPolicyConfig(),
    recovery: createDefaultRecoveryConfig(),
    children: children ?? [createChildSpec()],
  };
}

describe('Supervisor', () => {
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

  it('start() subscribes to heartbeats and registers children', async () => {
    const config = createSupervisorConfig();
    const supervisor = new Supervisor(config, bus, store);

    await supervisor.start();

    expect(supervisor.getChildren()).toHaveLength(1);
    expect(supervisor.getChildren()[0].agentId).toBe('agent-1');

    await supervisor.stop();
  });

  it('healthy heartbeat produces no commands', async () => {
    const config = createSupervisorConfig();
    const supervisor = new Supervisor(config, bus, store);
    await supervisor.start();

    const hb = createTestHeartbeat();
    await bus.publishHeartbeat('agent-1', hb);

    const commands = bus.getMessages('stream:commands:agent-1');
    expect(commands).toHaveLength(0);

    await supervisor.stop();
  });

  it('unhealthy heartbeat triggers recovery command', async () => {
    const config = createSupervisorConfig();
    const supervisor = new Supervisor(config, bus, store);
    await supervisor.start();

    // Send heartbeat with stuck ticks (above threshold)
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
    await bus.publishHeartbeat('agent-1', hb);

    const commands = bus.getMessages('stream:commands:agent-1');
    expect(commands.length).toBeGreaterThanOrEqual(1);
    expect(commands[0].payload['type']).toBe('recover');

    await supervisor.stop();
  });

  it('watchdog fires on missing heartbeats', async () => {
    const child = createChildSpec({
      id: 'agent-1',
      agentId: 'agent-1',
      config: {
        budget: {
          tokens: { soft: 8000, hard: 10000 },
          costUsd: { soft: 1, hard: 2 },
          wallTimeMs: { soft: 30000, hard: 60000 },
          toolInvocations: { soft: 50, hard: 100 },
        },
        tickIntervalMs: 1000,
        checkpointEveryNTicks: 10,
      },
    });
    const config = createSupervisorConfig([child]);
    // maxMissedHeartbeats defaults to 3, so timeout = (3+1) * 1000 = 4000ms
    const supervisor = new Supervisor(config, bus, store);
    await supervisor.start();

    // Advance past watchdog timeout
    vi.advanceTimersByTime(4001);

    // Allow async handlers to complete
    await vi.advanceTimersByTimeAsync(0);

    const commands = bus.getMessages('stream:commands:agent-1');
    expect(commands.length).toBeGreaterThanOrEqual(1);

    // The watchdog escalation should produce a kill command
    const hasKillOrRecover = commands.some(
      (m) => m.payload['type'] === 'kill' || m.payload['type'] === 'recover',
    );
    expect(hasKillOrRecover).toBe(true);

    await supervisor.stop();
  });

  it('watchdog resets on heartbeat receipt', async () => {
    const child = createChildSpec({
      id: 'agent-1',
      agentId: 'agent-1',
      config: {
        budget: {
          tokens: { soft: 8000, hard: 10000 },
          costUsd: { soft: 1, hard: 2 },
          wallTimeMs: { soft: 30000, hard: 60000 },
          toolInvocations: { soft: 50, hard: 100 },
        },
        tickIntervalMs: 1000,
        checkpointEveryNTicks: 10,
      },
    });
    const config = createSupervisorConfig([child]);
    const supervisor = new Supervisor(config, bus, store);
    await supervisor.start();

    // Advance partway through watchdog window
    vi.advanceTimersByTime(3000);

    // Send a healthy heartbeat, which should reset the watchdog
    const hb = createTestHeartbeat();
    await bus.publishHeartbeat('agent-1', hb);

    // Advance past original timeout but within new watchdog window
    vi.advanceTimersByTime(2000);

    // No commands should have been published (watchdog was reset)
    const commands = bus.getMessages('stream:commands:agent-1');
    expect(commands).toHaveLength(0);

    await supervisor.stop();
  });

  it('one_for_one: only the failed agent is affected', async () => {
    const child1 = createChildSpec({ id: 'agent-1', agentId: 'agent-1' });
    const child2 = createChildSpec({ id: 'agent-2', agentId: 'agent-2' });
    const config = createSupervisorConfig([child1, child2]);
    const supervisor = new Supervisor(config, bus, store);
    await supervisor.start();

    // Send unhealthy heartbeat only for agent-1
    const hb = createTestHeartbeat({
      agentId: 'agent-1',
      health: {
        status: 'degraded',
        progress: 0.5,
        coherence: 0.9,
        confidence: 0.85,
        stuckTicks: 5,
        lastMeaningfulAction: 'stuck',
      },
    });
    await bus.publishHeartbeat('agent-1', hb);

    // agent-1 should have commands
    const commands1 = bus.getMessages('stream:commands:agent-1');
    expect(commands1.length).toBeGreaterThanOrEqual(1);

    // agent-2 should have no commands
    const commands2 = bus.getMessages('stream:commands:agent-2');
    expect(commands2).toHaveLength(0);

    await supervisor.stop();
  });

  it('stop() cleans up subscription and watchdogs', async () => {
    const child = createChildSpec({
      id: 'agent-1',
      agentId: 'agent-1',
      config: {
        budget: {
          tokens: { soft: 8000, hard: 10000 },
          costUsd: { soft: 1, hard: 2 },
          wallTimeMs: { soft: 30000, hard: 60000 },
          toolInvocations: { soft: 50, hard: 100 },
        },
        tickIntervalMs: 1000,
        checkpointEveryNTicks: 10,
      },
    });
    const config = createSupervisorConfig([child]);
    const supervisor = new Supervisor(config, bus, store);
    await supervisor.start();
    await supervisor.stop();

    // Advance past watchdog timeout — should not fire
    vi.advanceTimersByTime(10000);
    await vi.advanceTimersByTimeAsync(0);

    const commands = bus.getMessages('stream:commands:agent-1');
    expect(commands).toHaveLength(0);
  });

  it('addChild() enables monitoring for a new agent', async () => {
    const config = createSupervisorConfig([]);
    const supervisor = new Supervisor(config, bus, store);
    await supervisor.start();

    expect(supervisor.getChildren()).toHaveLength(0);

    supervisor.addChild(createChildSpec({ id: 'agent-new', agentId: 'agent-new' }));

    expect(supervisor.getChildren()).toHaveLength(1);
    expect(supervisor.getChildren()[0].agentId).toBe('agent-new');

    await supervisor.stop();
  });

  it('removeChild() stops monitoring', async () => {
    const child = createChildSpec({
      id: 'agent-1',
      agentId: 'agent-1',
      config: {
        budget: {
          tokens: { soft: 8000, hard: 10000 },
          costUsd: { soft: 1, hard: 2 },
          wallTimeMs: { soft: 30000, hard: 60000 },
          toolInvocations: { soft: 50, hard: 100 },
        },
        tickIntervalMs: 1000,
        checkpointEveryNTicks: 10,
      },
    });
    const config = createSupervisorConfig([child]);
    const supervisor = new Supervisor(config, bus, store);
    await supervisor.start();

    supervisor.removeChild('agent-1');
    expect(supervisor.getChildren()).toHaveLength(0);

    // Watchdog should not fire after removal
    vi.advanceTimersByTime(10000);
    await vi.advanceTimersByTimeAsync(0);

    const commands = bus.getMessages('stream:commands:agent-1');
    expect(commands).toHaveLength(0);

    await supervisor.stop();
  });
});
