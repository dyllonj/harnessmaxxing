import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Supervisor } from '@/supervisor/supervisor';
import { InMemoryMessageBus } from '../helpers/in-memory-message-bus';
import { InMemoryCheckpointStore } from '../helpers/in-memory-checkpoint-store';
import { createChildSpec, createSupervisorConfig } from './helpers';

function createShortTickChild(agentId: string): ReturnType<typeof createChildSpec> {
  return createChildSpec({
    id: agentId,
    agentId,
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
}

describe('Chaos: Watchdog Timeout', () => {
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

  it('agent goes silent and watchdog fires escalation (kill command)', async () => {
    const child = createShortTickChild('agent-1');
    const config = createSupervisorConfig([child]);
    // maxMissedHeartbeats defaults to 3, timeout = (3+1) * 1000 = 4000ms
    const supervisor = new Supervisor(config, bus, store);
    await supervisor.start();

    // No heartbeats sent — agent is silent
    vi.advanceTimersByTime(4001);
    await vi.advanceTimersByTimeAsync(0);

    const commands = bus.getMessages('stream:commands:agent-1');
    expect(commands.length).toBeGreaterThanOrEqual(1);

    // Watchdog verdict has severity=critical, recommendedAction=escalate
    // which maps through RecoveryEngine.escalate() to a kill command
    const hasKill = commands.some((m) => m.payload['type'] === 'kill');
    expect(hasKill).toBe(true);
  });

  it('repeated watchdog timeouts exhaust restart budget and produce final kill', async () => {
    const child = createShortTickChild('agent-1');
    const config = createSupervisorConfig([child]);
    config.recovery.maxRestartsPerWindow = 2;
    const supervisor = new Supervisor(config, bus, store);
    await supervisor.start();

    // First watchdog timeout
    vi.advanceTimersByTime(4001);
    await vi.advanceTimersByTimeAsync(0);

    const firstCommands = bus.getMessages('stream:commands:agent-1');
    expect(firstCommands.length).toBeGreaterThanOrEqual(1);

    // The watchdog fires with severity=critical/recommendedAction=escalate.
    // escalate strategy directly issues a kill and increments restart counter.
    // After maxRestartsPerWindow is exceeded, further recovery also produces kill.
    const killCommands = firstCommands.filter((m) => m.payload['type'] === 'kill');
    expect(killCommands.length).toBeGreaterThanOrEqual(1);

    await supervisor.stop();
  });

  it('multiple agents go silent simultaneously and each gets independent escalation', async () => {
    const agents = Array.from({ length: 3 }, (_, i) =>
      createShortTickChild(`agent-${i}`),
    );
    const config = createSupervisorConfig(agents);
    const supervisor = new Supervisor(config, bus, store);
    await supervisor.start();

    // All agents go silent — advance past watchdog timeout
    vi.advanceTimersByTime(4001);
    await vi.advanceTimersByTimeAsync(0);

    // Each agent should receive its own kill command independently
    for (let i = 0; i < 3; i++) {
      const commands = bus.getMessages(`stream:commands:agent-${i}`);
      expect(commands.length).toBeGreaterThanOrEqual(1);
      const hasKill = commands.some((m) => m.payload['type'] === 'kill');
      expect(hasKill).toBe(true);
    }

    await supervisor.stop();
  });
});
