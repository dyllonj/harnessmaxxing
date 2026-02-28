import { describe, it, expect } from 'vitest';
import { checkBudget } from '@/types/budget';
import type { Budget, BudgetSnapshot } from '@/types/budget';

function makeBudget(overrides?: Partial<Budget>): Budget {
  return {
    tokens: { soft: 1000, hard: 2000 },
    costUsd: { soft: 10, hard: 20 },
    wallTimeMs: { soft: 60000, hard: 120000 },
    toolInvocations: { soft: 50, hard: 100 },
    ...overrides,
  };
}

function makeSnapshot(overrides?: Partial<BudgetSnapshot>): BudgetSnapshot {
  return {
    tokensUsed: 0,
    estimatedCostUsd: 0,
    wallTimeMs: 0,
    toolInvocations: 0,
    apiCalls: 0,
    ...overrides,
  };
}

describe('checkBudget', () => {
  it('returns ok when all dimensions are below soft limits', () => {
    const result = checkBudget(makeBudget(), makeSnapshot({ tokensUsed: 500, estimatedCostUsd: 5 }));
    expect(result).toEqual({ status: 'ok', breachedDimensions: [] });
  });

  describe('soft_limit', () => {
    it('returns soft_limit when tokens reach soft limit', () => {
      const result = checkBudget(makeBudget(), makeSnapshot({ tokensUsed: 1000 }));
      expect(result.status).toBe('soft_limit');
      expect(result.breachedDimensions).toContain('tokensUsed');
    });

    it('returns soft_limit when costUsd reaches soft limit', () => {
      const result = checkBudget(makeBudget(), makeSnapshot({ estimatedCostUsd: 10 }));
      expect(result.status).toBe('soft_limit');
      expect(result.breachedDimensions).toContain('estimatedCostUsd');
    });

    it('returns soft_limit when wallTimeMs reaches soft limit', () => {
      const result = checkBudget(makeBudget(), makeSnapshot({ wallTimeMs: 60000 }));
      expect(result.status).toBe('soft_limit');
      expect(result.breachedDimensions).toContain('wallTimeMs');
    });

    it('returns soft_limit when toolInvocations reach soft limit', () => {
      const result = checkBudget(makeBudget(), makeSnapshot({ toolInvocations: 50 }));
      expect(result.status).toBe('soft_limit');
      expect(result.breachedDimensions).toContain('toolInvocations');
    });
  });

  describe('hard_limit', () => {
    it('returns hard_limit when tokens reach hard limit', () => {
      const result = checkBudget(makeBudget(), makeSnapshot({ tokensUsed: 2000 }));
      expect(result.status).toBe('hard_limit');
      expect(result.breachedDimensions).toContain('tokensUsed');
    });

    it('returns hard_limit when costUsd reaches hard limit', () => {
      const result = checkBudget(makeBudget(), makeSnapshot({ estimatedCostUsd: 20 }));
      expect(result.status).toBe('hard_limit');
      expect(result.breachedDimensions).toContain('estimatedCostUsd');
    });

    it('returns hard_limit when wallTimeMs reaches hard limit', () => {
      const result = checkBudget(makeBudget(), makeSnapshot({ wallTimeMs: 120000 }));
      expect(result.status).toBe('hard_limit');
      expect(result.breachedDimensions).toContain('wallTimeMs');
    });

    it('returns hard_limit when toolInvocations reach hard limit', () => {
      const result = checkBudget(makeBudget(), makeSnapshot({ toolInvocations: 100 }));
      expect(result.status).toBe('hard_limit');
      expect(result.breachedDimensions).toContain('toolInvocations');
    });
  });

  it('hard_limit takes priority when both hard and soft are exceeded', () => {
    const result = checkBudget(
      makeBudget(),
      makeSnapshot({ tokensUsed: 2000, estimatedCostUsd: 10 }),
    );
    expect(result.status).toBe('hard_limit');
    expect(result.breachedDimensions).toContain('tokensUsed');
  });

  describe('boundary: exact equality triggers the limit', () => {
    it('equal to soft limit triggers soft_limit', () => {
      const result = checkBudget(makeBudget(), makeSnapshot({ tokensUsed: 1000 }));
      expect(result.status).toBe('soft_limit');
    });

    it('equal to hard limit triggers hard_limit', () => {
      const result = checkBudget(makeBudget(), makeSnapshot({ tokensUsed: 2000 }));
      expect(result.status).toBe('hard_limit');
    });

    it('one below soft limit is ok', () => {
      const result = checkBudget(makeBudget(), makeSnapshot({ tokensUsed: 999 }));
      expect(result).toEqual({ status: 'ok', breachedDimensions: [] });
    });
  });
});
