import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RecoveryEngine } from '@/supervisor/recovery-engine';
import { FailingCheckpointStore, FailingMessageBus, createTestHeartbeat } from './helpers';
import type { HealthVerdict } from '@/types/supervisor';
import type { Checkpoint } from '@/types/checkpoint';

function createTestCheckpoint(agentId: string): Checkpoint {
  return {
    id: `cp-${agentId}-1`,
    agentId,
    epoch: 1,
    tick: 10,
    timestamp: Date.now(),
    llmState: {
      systemPrompt: 'test',
      conversationHistory: [],
      contextWindowUsage: 0.1,
      modelId: 'test-model',
      temperature: 0.7,
    },
    externalState: {
      taskQueue: [],
      completedTasks: [],
      keyValueStore: {},
      pendingEffects: [],
      committedEffects: [],
    },
    metadata: {
      lifecycleState: 'RUNNING',
      parentAgentId: null,
      childAgentIds: [],
      budget: {
        tokensUsed: 100,
        estimatedCostUsd: 0.01,
        wallTimeMs: 5000,
        toolInvocations: 1,
        apiCalls: 2,
      },
      lastHeartbeat: createTestHeartbeat({ agentId }),
      createdAt: Date.now(),
      restoredFrom: null,
    },
    checksum: '',
    previousCheckpointId: null,
  };
}

function createVerdict(agentId: string): HealthVerdict {
  return {
    agentId,
    severity: 'error',
    policiesFired: ['stuck_ticks'],
    details: 'Agent stuck for 5 ticks',
    timestamp: Date.now(),
    recommendedAction: 'warm_restart',
  };
}

describe('Chaos: Checkpoint Corruption', () => {
  let bus: FailingMessageBus;
  let store: FailingCheckpointStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    bus = new FailingMessageBus();
    store = new FailingCheckpointStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('corrupted checkpoint falls back to fresh_start', async () => {
    const engine = new RecoveryEngine(bus, store);

    // Save a checkpoint then corrupt it
    const checkpoint = createTestCheckpoint('agent-1');
    await store.save(checkpoint);
    store.corrupt(checkpoint.id);

    // warm_restart should find no valid checkpoint (corrupted = null from load)
    const verdict = createVerdict('agent-1');
    const result = await engine.recover(verdict, 'warm_restart');

    // warm_restart fails because loadLatest returns null for corrupted checkpoints
    expect(result.success).toBe(false);
    expect(result.strategyUsed).toBe('warm_restart');
    expect(result.nextStrategy).toBe('fresh_start');
    expect(result.details).toContain('No checkpoint found');
  });

  it('save failure during checkpoint write is contained', async () => {
    store.failNextSaves(1);

    const checkpoint = createTestCheckpoint('agent-1');
    await expect(store.save(checkpoint)).rejects.toThrow('FailingCheckpointStore: save failure injected');

    // Store should still function after the failure
    await store.save(checkpoint);
    const loaded = await store.loadLatest('agent-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(checkpoint.id);
  });

  it('load failure during warm_restart propagates error', async () => {
    const engine = new RecoveryEngine(bus, store);

    // Save a valid checkpoint first
    const checkpoint = createTestCheckpoint('agent-1');
    await store.save(checkpoint);

    // Make the next load fail
    store.failNextLoads(1);

    const verdict = createVerdict('agent-1');

    // RecoveryEngine.warmRestart() at line 144 doesn't wrap loadLatest() in try-catch.
    // This documents the robustness gap: a load failure propagates as an unhandled rejection.
    await expect(engine.recover(verdict, 'warm_restart')).rejects.toThrow(
      'FailingCheckpointStore: loadLatest failure injected',
    );
  });
});
