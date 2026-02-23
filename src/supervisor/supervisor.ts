import pino from 'pino';
import type { MessageBus } from '../bus/message-bus.js';
import type { CheckpointStore } from '../checkpoint/checkpoint-store.js';
import type { Heartbeat } from '../types/heartbeat.js';
import type { Subscription } from '../types/message.js';
import type {
  SupervisorConfig,
  ChildSpec,
  HealthVerdict,
  RecoveryStrategyType,
} from '../types/supervisor.js';
import { HealthAssessor } from './health-assessor.js';
import { RecoveryEngine } from './recovery-engine.js';

const logger = pino({ name: 'supervisor' });

export class Supervisor {
  private readonly config: SupervisorConfig;
  private readonly bus: MessageBus;
  private readonly healthAssessor: HealthAssessor;
  private readonly recoveryEngine: RecoveryEngine;
  private readonly children = new Map<string, ChildSpec>();
  private readonly watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  private subscription: Subscription | null = null;

  constructor(
    config: SupervisorConfig,
    bus: MessageBus,
    checkpointStore: CheckpointStore,
  ) {
    this.config = config;
    this.bus = bus;
    this.healthAssessor = new HealthAssessor(config.healthPolicy);
    this.recoveryEngine = new RecoveryEngine(bus, checkpointStore);
  }

  async start(): Promise<void> {
    for (const child of this.config.children) {
      this.addChild(child);
    }

    this.subscription = await this.bus.subscribeHeartbeats(
      '*',
      (heartbeat: Heartbeat) => this.handleHeartbeat(heartbeat),
    );

    logger.info(
      { childCount: this.children.size },
      'Supervisor started',
    );
  }

  async stop(): Promise<void> {
    if (this.subscription) {
      await this.subscription.unsubscribe();
      this.subscription = null;
    }

    for (const [agentId, timer] of this.watchdogs) {
      clearTimeout(timer);
      this.watchdogs.delete(agentId);
    }

    logger.info('Supervisor stopped');
  }

  addChild(spec: ChildSpec): void {
    this.children.set(spec.agentId, spec);
    this.startWatchdog(spec);

    logger.info({ agentId: spec.agentId }, 'Child registered');
  }

  removeChild(agentId: string): void {
    this.children.delete(agentId);

    const timer = this.watchdogs.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.watchdogs.delete(agentId);
    }

    this.healthAssessor.reset(agentId);

    logger.info({ agentId }, 'Child removed');
  }

  getChildren(): ChildSpec[] {
    return [...this.children.values()];
  }

  private async handleHeartbeat(heartbeat: Heartbeat): Promise<void> {
    const { agentId } = heartbeat;
    const child = this.children.get(agentId);

    if (!child) {
      return;
    }

    // Reset watchdog
    this.startWatchdog(child);

    const verdict = this.healthAssessor.assess(agentId, heartbeat);

    if (!verdict) {
      return;
    }

    logger.warn({ verdict }, 'Unhealthy agent detected');

    await this.executeRecovery(verdict, child);
  }

  private async executeRecovery(
    verdict: HealthVerdict,
    child: ChildSpec,
  ): Promise<void> {
    const strategy = this.pickStrategy(verdict, child);

    const result = await this.recoveryEngine.recover(verdict, strategy);

    if (!result.success && result.nextStrategy) {
      logger.warn(
        { agentId: verdict.agentId, failedStrategy: strategy, nextStrategy: result.nextStrategy },
        'Recovery failed, retrying with next strategy',
      );

      await this.recoveryEngine.recover(verdict, result.nextStrategy);
    }
  }

  private pickStrategy(
    verdict: HealthVerdict,
    child: ChildSpec,
  ): RecoveryStrategyType {
    if (child.recoveryConfig.strategies.includes(verdict.recommendedAction)) {
      return verdict.recommendedAction;
    }

    return child.recoveryConfig.strategies[0];
  }

  private startWatchdog(spec: ChildSpec): void {
    const existing = this.watchdogs.get(spec.agentId);
    if (existing) {
      clearTimeout(existing);
    }

    const timeoutMs =
      (this.config.healthPolicy.maxMissedHeartbeats + 1) *
      spec.tickIntervalMs;

    const timer = setTimeout(() => {
      this.onWatchdogTimeout(spec.agentId);
    }, timeoutMs);

    this.watchdogs.set(spec.agentId, timer);
  }

  private onWatchdogTimeout(agentId: string): void {
    const child = this.children.get(agentId);
    if (!child) {
      return;
    }

    logger.error({ agentId }, 'Watchdog timeout — no heartbeat received');

    const verdict: HealthVerdict = {
      agentId,
      severity: 'critical',
      policiesFired: ['missed_heartbeats'],
      details: 'Watchdog timeout: no heartbeat received within expected window',
      timestamp: Date.now(),
      recommendedAction: 'escalate',
    };

    void this.executeRecovery(verdict, child);
  }
}
