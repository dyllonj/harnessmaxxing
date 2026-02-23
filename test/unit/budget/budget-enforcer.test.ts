import { describe, it, expect } from 'vitest';
import { BudgetEnforcer } from '@/budget/budget-enforcer';
import type { BudgetLimits, BudgetDimension } from '@/types/budget';

function makeLimits(overrides?: Partial<BudgetLimits>): BudgetLimits {
  return {
    tokensUsed: 1000,
    estimatedCostUsd: 100,
    wallTimeMs: 600000,
    invocations: 500,
    apiCalls: 200,
    ...overrides,
  };
}

describe('BudgetEnforcer', () => {
  it('fresh enforcer reports ok', () => {
    const enforcer = new BudgetEnforcer(makeLimits());
    const result = enforcer.check();
    expect(result.status).toBe('ok');
    expect(result.breachedDimensions).toEqual([]);
  });

  it('recording accumulates', () => {
    const enforcer = new BudgetEnforcer(makeLimits());
    enforcer.record({ tokensUsed: 100 });
    enforcer.record({ tokensUsed: 200 });
    const snap = enforcer.snapshot();
    expect(snap.tokensUsed).toBe(300);
  });

  it('partial recording leaves other dims unchanged', () => {
    const enforcer = new BudgetEnforcer(makeLimits());
    enforcer.record({ tokensUsed: 100 });
    const snap = enforcer.snapshot();
    expect(snap.tokensUsed).toBe(100);
    expect(snap.estimatedCostUsd).toBe(0);
    expect(snap.wallTimeMs).toBe(0);
    expect(snap.invocations).toBe(0);
    expect(snap.apiCalls).toBe(0);
  });

  it('soft limit detection at 80% threshold', () => {
    const enforcer = new BudgetEnforcer(makeLimits({ tokensUsed: 1000 }));
    enforcer.record({ tokensUsed: 850 });
    const result = enforcer.check();
    expect(result.status).toBe('soft_limit');
    expect(result.breachedDimensions).toContain('tokensUsed');
  });

  it('hard limit detection when at limit', () => {
    const enforcer = new BudgetEnforcer(makeLimits({ tokensUsed: 1000 }));
    enforcer.record({ tokensUsed: 1000 });
    const result = enforcer.check();
    expect(result.status).toBe('hard_limit');
    expect(result.breachedDimensions).toContain('tokensUsed');
  });

  it('hard limit detection when over limit', () => {
    const enforcer = new BudgetEnforcer(makeLimits({ tokensUsed: 1000 }));
    enforcer.record({ tokensUsed: 1500 });
    const result = enforcer.check();
    expect(result.status).toBe('hard_limit');
  });

  it('hard limit takes precedence over soft limit', () => {
    const enforcer = new BudgetEnforcer(makeLimits({
      tokensUsed: 1000,
      estimatedCostUsd: 100,
    }));
    enforcer.record({ tokensUsed: 1000, estimatedCostUsd: 85 });
    const result = enforcer.check();
    expect(result.status).toBe('hard_limit');
    expect(result.breachedDimensions).toContain('tokensUsed');
    // soft-breached dims are NOT in the result since hard takes precedence
    expect(result.breachedDimensions).not.toContain('estimatedCostUsd');
  });

  it('multiple dimensions breached', () => {
    const enforcer = new BudgetEnforcer(makeLimits({
      tokensUsed: 1000,
      invocations: 500,
    }));
    enforcer.record({ tokensUsed: 1000, invocations: 500 });
    const result = enforcer.check();
    expect(result.status).toBe('hard_limit');
    expect(result.breachedDimensions).toContain('tokensUsed');
    expect(result.breachedDimensions).toContain('invocations');
  });

  it('each of 5 dimensions independently tracked', () => {
    const dims: BudgetDimension[] = ['tokensUsed', 'estimatedCostUsd', 'wallTimeMs', 'invocations', 'apiCalls'];
    for (const dim of dims) {
      const limits = makeLimits();
      const enforcer = new BudgetEnforcer(limits);
      enforcer.record({ [dim]: limits[dim] });
      const result = enforcer.check();
      expect(result.status).toBe('hard_limit');
      expect(result.breachedDimensions).toEqual([dim]);
    }
  });

  it('snapshot returns a copy', () => {
    const enforcer = new BudgetEnforcer(makeLimits());
    enforcer.record({ tokensUsed: 100 });
    const snap1 = enforcer.snapshot();
    enforcer.record({ tokensUsed: 50 });
    const snap2 = enforcer.snapshot();
    expect(snap1.tokensUsed).toBe(100);
    expect(snap2.tokensUsed).toBe(150);
  });

  it('restore sets consumption', () => {
    const enforcer = new BudgetEnforcer(makeLimits());
    enforcer.record({ tokensUsed: 100, invocations: 10 });
    const snap = enforcer.snapshot();

    const enforcer2 = new BudgetEnforcer(makeLimits());
    enforcer2.restore(snap);
    expect(enforcer2.snapshot()).toEqual(snap);
  });

  it('restore enables checkpoint/resume', () => {
    const enforcer = new BudgetEnforcer(makeLimits({ tokensUsed: 1000 }));
    enforcer.record({ tokensUsed: 500 });
    const saved = enforcer.snapshot();

    // Simulate resume
    const resumed = new BudgetEnforcer(makeLimits({ tokensUsed: 1000 }));
    resumed.restore(saved);
    resumed.record({ tokensUsed: 300 });
    expect(resumed.check().status).toBe('soft_limit');
    resumed.record({ tokensUsed: 200 });
    expect(resumed.check().status).toBe('hard_limit');
  });

  it('remaining returns correct values', () => {
    const enforcer = new BudgetEnforcer(makeLimits({ tokensUsed: 1000 }));
    enforcer.record({ tokensUsed: 300 });
    const rem = enforcer.remaining();
    expect(rem.tokensUsed).toBe(700);
  });

  it('remaining clamps to zero', () => {
    const enforcer = new BudgetEnforcer(makeLimits({ tokensUsed: 1000 }));
    enforcer.record({ tokensUsed: 1500 });
    const rem = enforcer.remaining();
    expect(rem.tokensUsed).toBe(0);
  });

  it('percentUsed is correct', () => {
    const enforcer = new BudgetEnforcer(makeLimits({ tokensUsed: 1000 }));
    enforcer.record({ tokensUsed: 500 });
    const pct = enforcer.percentUsed();
    expect(pct.tokensUsed).toBe(50);
  });

  it('custom soft limit percent', () => {
    const enforcer = new BudgetEnforcer(makeLimits({ tokensUsed: 1000 }), 50);
    enforcer.record({ tokensUsed: 500 });
    const result = enforcer.check();
    expect(result.status).toBe('soft_limit');
    expect(result.breachedDimensions).toContain('tokensUsed');
  });
});
