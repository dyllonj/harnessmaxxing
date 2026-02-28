import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { MessageBus } from '../bus/message-bus.js';
import type { CheckpointStore } from '../checkpoint/checkpoint-store.js';
import type { LifecycleCommand, Message } from '../types/message.js';
import type {
  RecoveryConfig,
  HealthVerdict,
  RecoveryResult,
  RecoveryStrategyType,
} from '../types/supervisor.js';
import { createDefaultRecoveryConfig } from '../types/supervisor.js';

const logger = pino({ name: 'recovery-engine' });

type RestartCounter = {
  count: number;
  windowStart: number;
};

async function publishCommand(
  bus: MessageBus,
  agentId: string,
  type: LifecycleCommand['type'],
  payload?: Record<string, unknown>,
): Promise<void> {
  const command: LifecycleCommand = {
    type,
    targetAgentId: agentId,
    timestamp: Date.now(),
    nonce: randomUUID(),
    payload,
  };

  const message: Message = {
    id: '',
    channel: `stream:commands:${agentId}`,
    timestamp: Date.now(),
    payload: { ...command },
  };

  await bus.publish(`stream:commands:${agentId}`, message);
}

export class RecoveryEngine {
  private readonly bus: MessageBus;
  private readonly checkpointStore: CheckpointStore;
  private readonly config: RecoveryConfig;
  private counters = new Map<string, RestartCounter>();

  constructor(
    bus: MessageBus,
    checkpointStore: CheckpointStore,
    config?: RecoveryConfig,
  ) {
    this.bus = bus;
    this.checkpointStore = checkpointStore;
    this.config = config ?? createDefaultRecoveryConfig();
  }

  async recover(
    verdict: HealthVerdict,
    strategy: RecoveryStrategyType,
  ): Promise<RecoveryResult> {
    const { agentId } = verdict;
    const now = Date.now();

    // Get or create restart counter
    let counter = this.counters.get(agentId);
    if (!counter || (now - counter.windowStart) > this.config.restartWindowMs) {
      counter = { count: 0, windowStart: now };
      this.counters.set(agentId, counter);
    }

    // Check restart limit
    if (counter.count >= this.config.maxRestartsPerWindow) {
      logger.error(
        { agentId, count: counter.count, max: this.config.maxRestartsPerWindow },
        'Max restarts exceeded, escalating',
      );

      await publishCommand(this.bus, agentId, 'kill');

      return {
        success: false,
        strategyUsed: 'escalate',
        agentId,
        details: `Max restarts (${this.config.maxRestartsPerWindow}) exceeded within window`,
      };
    }

    counter.count++;

    logger.info(
      { agentId, strategy, restartCount: counter.count },
      'Executing recovery strategy',
    );

    switch (strategy) {
      case 'hot_restart':
        return this.hotRestart(agentId);

      case 'warm_restart':
        return this.warmRestart(agentId);

      case 'context_reconstruction':
      case 'fresh_start':
        return {
          success: false,
          strategyUsed: strategy,
          agentId,
          details: 'not implemented',
          nextStrategy: 'escalate',
        };

      case 'escalate':
        return this.escalate(agentId);
    }
  }

  getRestartCount(agentId: string): number {
    return this.counters.get(agentId)?.count ?? 0;
  }

  resetCounters(): void {
    this.counters.clear();
  }

  private async hotRestart(agentId: string): Promise<RecoveryResult> {
    await publishCommand(this.bus, agentId, 'recover', {
      strategy: 'hot_restart',
      retryCurrentTick: true,
    });

    return {
      success: true,
      strategyUsed: 'hot_restart',
      agentId,
      details: 'Hot restart command published',
    };
  }

  private async warmRestart(agentId: string): Promise<RecoveryResult> {
    const checkpoint = await this.checkpointStore.loadLatest(agentId);

    if (!checkpoint) {
      return {
        success: false,
        strategyUsed: 'warm_restart',
        agentId,
        details: 'No checkpoint found for warm restart',
        nextStrategy: 'fresh_start',
      };
    }

    await publishCommand(this.bus, agentId, 'recover', {
      strategy: 'warm_restart',
      checkpointId: checkpoint.id,
    });

    return {
      success: true,
      strategyUsed: 'warm_restart',
      agentId,
      details: `Warm restart from checkpoint ${checkpoint.id}`,
    };
  }

  private async escalate(agentId: string): Promise<RecoveryResult> {
    await publishCommand(this.bus, agentId, 'kill');

    return {
      success: false,
      strategyUsed: 'escalate',
      agentId,
      details: 'Agent killed via escalation',
    };
  }
}
