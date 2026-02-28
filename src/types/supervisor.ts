import type { Budget } from './budget.js';

export type RecoveryStrategyType =
  | 'hot_restart'
  | 'warm_restart'
  | 'context_reconstruction'
  | 'fresh_start'
  | 'escalate';

export type HealthSeverity = 'warning' | 'degraded' | 'error' | 'critical';

export type HealthPolicy =
  | 'missed_heartbeats'
  | 'stuck_ticks'
  | 'budget_preemption'
  | 'coherence_spiral';

export type HealthPolicyConfig = {
  maxMissedHeartbeats: number;
  expectedIntervalMs: number;
  maxStuckTicks: number;
  budgetWarningPercent: number;
  budgetHardLimitPercent: number;
  coherenceThreshold: number;
  coherenceWindowSize: number;
};

export type RecoveryConfig = {
  strategies: RecoveryStrategyType[];
  maxRestartsPerWindow: number;
  restartWindowMs: number;
};

export type ChildSpec = {
  id: string;
  agentId: string;
  config: {
    budget: Budget;
    tickIntervalMs: number;
    checkpointEveryNTicks: number;
  };
  recoveryConfig?: RecoveryConfig;
};

export type SupervisorConfig = {
  strategy: 'one_for_one';
  healthPolicy: HealthPolicyConfig;
  recovery: RecoveryConfig;
  children: ChildSpec[];
};

export type HealthVerdict = {
  agentId: string;
  severity: HealthSeverity;
  policiesFired: HealthPolicy[];
  details: string;
  timestamp: number;
  recommendedAction: RecoveryStrategyType;
};

export type RecoveryResult = {
  success: boolean;
  strategyUsed: RecoveryStrategyType;
  agentId: string;
  details: string;
  nextStrategy?: RecoveryStrategyType;
};

export function createDefaultHealthPolicyConfig(): HealthPolicyConfig {
  return {
    maxMissedHeartbeats: 3,
    expectedIntervalMs: 5000,
    maxStuckTicks: 5,
    budgetWarningPercent: 85,
    budgetHardLimitPercent: 95,
    coherenceThreshold: 0.3,
    coherenceWindowSize: 5,
  };
}

export function createDefaultRecoveryConfig(): RecoveryConfig {
  return {
    strategies: ['hot_restart', 'warm_restart', 'escalate'],
    maxRestartsPerWindow: 5,
    restartWindowMs: 300_000,
  };
}
