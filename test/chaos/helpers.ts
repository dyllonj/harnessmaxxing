import { InMemoryMessageBus } from '../helpers/in-memory-message-bus';
import { InMemoryCheckpointStore } from '../helpers/in-memory-checkpoint-store';
import type { Message } from '@/types/message';
import type { Heartbeat } from '@/types/heartbeat';
import type { ChildSpec, SupervisorConfig } from '@/types/supervisor';
import { createDefaultHealthPolicyConfig, createDefaultRecoveryConfig } from '@/types/supervisor';

export class FailingMessageBus extends InMemoryMessageBus {
  private partitioned = false;
  private failCount = 0;

  partition(): void {
    this.partitioned = true;
  }

  heal(): void {
    this.partitioned = false;
  }

  failNextPublishes(n: number): void {
    this.failCount = n;
  }

  override async publish(channel: string, message: Message): Promise<void> {
    if (this.failCount > 0) {
      this.failCount--;
      throw new Error('FailingMessageBus: publish failure injected');
    }

    if (this.partitioned) {
      // Silently drop — message never arrives
      return;
    }

    return super.publish(channel, message);
  }
}

export class FailingCheckpointStore extends InMemoryCheckpointStore {
  private saveFailCount = 0;
  private loadFailCount = 0;

  failNextSaves(n: number): void {
    this.saveFailCount = n;
  }

  failNextLoads(n: number): void {
    this.loadFailCount = n;
  }

  override async save(checkpoint: Parameters<InMemoryCheckpointStore['save']>[0]): Promise<void> {
    if (this.saveFailCount > 0) {
      this.saveFailCount--;
      throw new Error('FailingCheckpointStore: save failure injected');
    }

    return super.save(checkpoint);
  }

  override async load(agentId: string, epoch?: number): ReturnType<InMemoryCheckpointStore['load']> {
    if (this.loadFailCount > 0) {
      this.loadFailCount--;
      throw new Error('FailingCheckpointStore: load failure injected');
    }

    return super.load(agentId, epoch);
  }

  override async loadLatest(agentId: string): ReturnType<InMemoryCheckpointStore['loadLatest']> {
    if (this.loadFailCount > 0) {
      this.loadFailCount--;
      throw new Error('FailingCheckpointStore: loadLatest failure injected');
    }

    return super.loadLatest(agentId);
  }
}

export function createTestHeartbeat(overrides?: Partial<Heartbeat>): Heartbeat {
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

export function createChildSpec(overrides?: Partial<ChildSpec>): ChildSpec {
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

export function createSupervisorConfig(children?: ChildSpec[]): SupervisorConfig {
  return {
    strategy: 'one_for_one',
    healthPolicy: createDefaultHealthPolicyConfig(),
    recovery: createDefaultRecoveryConfig(),
    children: children ?? [createChildSpec()],
  };
}
