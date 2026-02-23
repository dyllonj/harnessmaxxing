import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthAssessor } from '@/supervisor/health-assessor';
import type { Heartbeat } from '@/types/heartbeat';
import type { HealthPolicyConfig } from '@/types/supervisor';
import { createDefaultHealthPolicyConfig } from '@/types/supervisor';

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

function withHealth(hb: Heartbeat, partial: Partial<Heartbeat['health']>): Heartbeat {
  return { ...hb, health: { ...hb.health, ...partial } };
}

function withResources(hb: Heartbeat, partial: Partial<Heartbeat['resources']>): Heartbeat {
  return { ...hb, resources: { ...hb.resources, ...partial } };
}

describe('HealthAssessor', () => {
  let config: HealthPolicyConfig;
  let assessor: HealthAssessor;

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    config = createDefaultHealthPolicyConfig();
    assessor = new HealthAssessor(config);
  });

  it('returns null for a healthy heartbeat', () => {
    const hb = createTestHeartbeat();
    const verdict = assessor.assess('agent-1', hb);
    expect(verdict).toBeNull();
  });

  it('detects stuck ticks at threshold', () => {
    const hb = withHealth(createTestHeartbeat(), { stuckTicks: 5 });
    const verdict = assessor.assess('agent-1', hb);

    expect(verdict).not.toBeNull();
    expect(verdict!.policiesFired).toContain('stuck_ticks');
    expect(verdict!.severity).toBe('degraded');
    expect(verdict!.recommendedAction).toBe('hot_restart');
  });

  it('does not fire stuck_ticks below threshold', () => {
    const hb = withHealth(createTestHeartbeat(), { stuckTicks: 4 });
    const verdict = assessor.assess('agent-1', hb);
    expect(verdict).toBeNull();
  });

  it('detects stuck ticks at 2x threshold as error', () => {
    const hb = withHealth(createTestHeartbeat(), { stuckTicks: 10 });
    const verdict = assessor.assess('agent-1', hb);

    expect(verdict).not.toBeNull();
    expect(verdict!.severity).toBe('error');
    expect(verdict!.recommendedAction).toBe('warm_restart');
  });

  it('detects budget warning at 85%', () => {
    const hb = withResources(createTestHeartbeat(), {
      tokensUsed: 8500,
      tokensRemaining: 1500,
    });
    const verdict = assessor.assess('agent-1', hb);

    expect(verdict).not.toBeNull();
    expect(verdict!.policiesFired).toContain('budget_preemption');
    expect(verdict!.severity).toBe('warning');
  });

  it('detects budget hard limit at 96%', () => {
    const hb = withResources(createTestHeartbeat(), {
      tokensUsed: 9600,
      tokensRemaining: 400,
    });
    const verdict = assessor.assess('agent-1', hb);

    expect(verdict).not.toBeNull();
    expect(verdict!.policiesFired).toContain('budget_preemption');
    expect(verdict!.severity).toBe('critical');
    expect(verdict!.recommendedAction).toBe('escalate');
  });

  it('skips budget policy when total tokens is zero', () => {
    const hb = withResources(createTestHeartbeat(), {
      tokensUsed: 0,
      tokensRemaining: 0,
    });
    const verdict = assessor.assess('agent-1', hb);
    expect(verdict).toBeNull();
  });

  it('detects coherence spiral after N consecutive low-coherence heartbeats', () => {
    for (let i = 0; i < 5; i++) {
      const hb = withHealth(createTestHeartbeat({ timestamp: 1000 + i * 1000 }), {
        coherence: 0.2,
      });
      const verdict = assessor.assess('agent-1', hb);

      if (i < 4) {
        // Not enough consecutive yet (only fires budget/stuck if applicable)
        expect(
          verdict === null || !verdict.policiesFired.includes('coherence_spiral'),
        ).toBe(true);
      } else {
        expect(verdict).not.toBeNull();
        expect(verdict!.policiesFired).toContain('coherence_spiral');
      }
    }
  });

  it('does not fire coherence_spiral with incomplete window', () => {
    for (let i = 0; i < 3; i++) {
      const hb = withHealth(createTestHeartbeat({ timestamp: 1000 + i * 1000 }), {
        coherence: 0.2,
      });
      assessor.assess('agent-1', hb);
    }

    // Insert a healthy heartbeat to break the chain
    const healthy = createTestHeartbeat({ timestamp: 4000 });
    assessor.assess('agent-1', healthy);

    // Now add one more low coherence — should NOT fire because chain is broken
    const low = withHealth(createTestHeartbeat({ timestamp: 5000 }), { coherence: 0.2 });
    const verdict = assessor.assess('agent-1', low);
    expect(
      verdict === null || !verdict.policiesFired.includes('coherence_spiral'),
    ).toBe(true);
  });

  it('fires multiple policies simultaneously', () => {
    // First heartbeat to establish baseline
    const first = createTestHeartbeat({ timestamp: 1000 });
    assessor.assess('agent-1', first);

    // Second heartbeat with big gap + stuck ticks
    const second = withHealth(
      createTestHeartbeat({ timestamp: 100_000 }),
      { stuckTicks: 5 },
    );
    const verdict = assessor.assess('agent-1', second);

    expect(verdict).not.toBeNull();
    expect(verdict!.policiesFired.length).toBeGreaterThanOrEqual(2);
    expect(verdict!.policiesFired).toContain('missed_heartbeats');
    expect(verdict!.policiesFired).toContain('stuck_ticks');
  });

  it('caps sliding window at maxWindowSize', () => {
    const maxSize = 30;
    for (let i = 0; i < 40; i++) {
      const hb = createTestHeartbeat({ timestamp: 1000 + i * 100 });
      assessor.assess('agent-1', hb);
    }

    expect(assessor.getWindow('agent-1')).toHaveLength(maxSize);
  });

  it('maps severity to correct recommendedAction', () => {
    // warning -> hot_restart
    const warning = withResources(createTestHeartbeat(), {
      tokensUsed: 8500,
      tokensRemaining: 1500,
    });
    const v1 = assessor.assess('agent-1', warning);
    expect(v1!.recommendedAction).toBe('hot_restart');

    // Reset for fresh assessor
    const assessor2 = new HealthAssessor(config);

    // critical -> escalate
    const critical = withResources(createTestHeartbeat(), {
      tokensUsed: 9600,
      tokensRemaining: 400,
    });
    const v2 = assessor2.assess('agent-1', critical);
    expect(v2!.recommendedAction).toBe('escalate');
  });

  it('reset() clears state for an agent', () => {
    const hb = withHealth(createTestHeartbeat(), { stuckTicks: 5 });
    assessor.assess('agent-1', hb);

    expect(assessor.getWindow('agent-1')).toHaveLength(1);

    assessor.reset('agent-1');

    expect(assessor.getWindow('agent-1')).toHaveLength(0);
  });
});
