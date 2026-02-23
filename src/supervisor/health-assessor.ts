import pino from 'pino';
import type { Heartbeat } from '../types/heartbeat.js';
import type {
  HealthPolicyConfig,
  HealthVerdict,
  HealthSeverity,
  HealthPolicy,
  RecoveryStrategyType,
} from '../types/supervisor.js';
import { createDefaultHealthPolicyConfig } from '../types/supervisor.js';

const logger = pino({ name: 'health-assessor' });

const SEVERITY_TO_STRATEGY: Record<HealthSeverity, RecoveryStrategyType> = {
  warning: 'hot_restart',
  degraded: 'hot_restart',
  error: 'warm_restart',
  critical: 'escalate',
};

const SEVERITY_RANK: Record<HealthSeverity, number> = {
  warning: 0,
  degraded: 1,
  error: 2,
  critical: 3,
};

type PolicyResult = {
  policy: HealthPolicy;
  severity: HealthSeverity;
  details: string;
} | null;

function checkMissedHeartbeats(
  window: Heartbeat[],
  config: HealthPolicyConfig,
): PolicyResult {
  if (window.length < 2) {
    return null;
  }

  const latest = window[window.length - 1];
  const previous = window[window.length - 2];
  const gap = latest.timestamp - previous.timestamp;
  const threshold = config.maxMissedHeartbeats * config.expectedIntervalMs;

  if (gap < threshold) {
    return null;
  }

  const ratio = gap / (config.maxMissedHeartbeats * config.expectedIntervalMs);
  let severity: HealthSeverity;

  if (ratio >= 3) {
    severity = 'critical';
  } else if (ratio >= 2) {
    severity = 'error';
  } else {
    severity = 'warning';
  }

  return {
    policy: 'missed_heartbeats',
    severity,
    details: `Heartbeat gap ${gap}ms exceeds threshold ${threshold}ms`,
  };
}

function checkStuckTicks(
  heartbeat: Heartbeat,
  config: HealthPolicyConfig,
): PolicyResult {
  const stuckTicks = heartbeat.health.stuckTicks;

  if (stuckTicks < config.maxStuckTicks) {
    return null;
  }

  const severity: HealthSeverity = stuckTicks >= config.maxStuckTicks * 2
    ? 'error'
    : 'degraded';

  return {
    policy: 'stuck_ticks',
    severity,
    details: `Agent stuck for ${stuckTicks} ticks (threshold: ${config.maxStuckTicks})`,
  };
}

function checkBudgetPreemption(
  heartbeat: Heartbeat,
  config: HealthPolicyConfig,
): PolicyResult {
  const { tokensUsed, tokensRemaining } = heartbeat.resources;
  const total = tokensUsed + tokensRemaining;

  if (total === 0) {
    return null;
  }

  const percentUsed = (tokensUsed / total) * 100;

  if (percentUsed >= config.budgetHardLimitPercent) {
    return {
      policy: 'budget_preemption',
      severity: 'critical',
      details: `Budget usage ${percentUsed.toFixed(1)}% exceeds hard limit ${config.budgetHardLimitPercent}%`,
    };
  }

  if (percentUsed >= config.budgetWarningPercent) {
    return {
      policy: 'budget_preemption',
      severity: 'warning',
      details: `Budget usage ${percentUsed.toFixed(1)}% exceeds warning threshold ${config.budgetWarningPercent}%`,
    };
  }

  return null;
}

function checkCoherenceSpiral(
  window: Heartbeat[],
  config: HealthPolicyConfig,
): PolicyResult {
  if (window.length < config.coherenceWindowSize) {
    return null;
  }

  const recent = window.slice(-config.coherenceWindowSize);
  const allBelowThreshold = recent.every(
    (hb) => hb.health.coherence < config.coherenceThreshold,
  );

  if (!allBelowThreshold) {
    return null;
  }

  return {
    policy: 'coherence_spiral',
    severity: 'error',
    details: `Coherence below ${config.coherenceThreshold} for ${config.coherenceWindowSize} consecutive heartbeats`,
  };
}

export class HealthAssessor {
  private windows = new Map<string, Heartbeat[]>();
  private lastSeen = new Map<string, number>();
  private readonly config: HealthPolicyConfig;
  private readonly maxWindowSize: number;

  constructor(config?: HealthPolicyConfig, maxWindowSize = 30) {
    this.config = config ?? createDefaultHealthPolicyConfig();
    this.maxWindowSize = maxWindowSize;
  }

  assess(agentId: string, heartbeat: Heartbeat): HealthVerdict | null {
    if (!this.windows.has(agentId)) {
      this.windows.set(agentId, []);
    }

    const window = this.windows.get(agentId)!;
    window.push(heartbeat);

    if (window.length > this.maxWindowSize) {
      window.splice(0, window.length - this.maxWindowSize);
    }

    this.lastSeen.set(agentId, heartbeat.timestamp);

    const results: PolicyResult[] = [
      checkMissedHeartbeats(window, this.config),
      checkStuckTicks(heartbeat, this.config),
      checkBudgetPreemption(heartbeat, this.config),
      checkCoherenceSpiral(window, this.config),
    ];

    const fired = results.filter((r): r is NonNullable<PolicyResult> => r !== null);

    if (fired.length === 0) {
      return null;
    }

    const worstSeverity = fired.reduce<HealthSeverity>(
      (worst, r) => SEVERITY_RANK[r.severity] > SEVERITY_RANK[worst] ? r.severity : worst,
      fired[0].severity,
    );

    const verdict: HealthVerdict = {
      agentId,
      severity: worstSeverity,
      policiesFired: fired.map((r) => r.policy),
      details: fired.map((r) => r.details).join('; '),
      timestamp: Date.now(),
      recommendedAction: SEVERITY_TO_STRATEGY[worstSeverity],
    };

    logger.warn({ verdict }, 'Health verdict issued');

    return verdict;
  }

  getWindow(agentId: string): Heartbeat[] {
    return [...(this.windows.get(agentId) ?? [])];
  }

  reset(agentId: string): void {
    this.windows.delete(agentId);
    this.lastSeen.delete(agentId);
  }
}
