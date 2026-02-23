import type {
  BudgetDimension,
  BudgetLimits,
  EnforcerBudgetSnapshot,
  EnforcerBudgetCheckResult,
} from '../types/budget.js';

const DIMENSIONS: BudgetDimension[] = [
  'tokensUsed',
  'estimatedCostUsd',
  'wallTimeMs',
  'invocations',
  'apiCalls',
];

export class BudgetEnforcer {
  private readonly limits: BudgetLimits;
  private readonly softLimitPercent: number;
  private consumption: EnforcerBudgetSnapshot;

  constructor(limits: BudgetLimits, softLimitPercent = 80) {
    this.limits = { ...limits };
    this.softLimitPercent = softLimitPercent;
    this.consumption = {
      tokensUsed: 0,
      estimatedCostUsd: 0,
      wallTimeMs: 0,
      invocations: 0,
      apiCalls: 0,
    };
  }

  record(partial: Partial<EnforcerBudgetSnapshot>): void {
    for (const dim of DIMENSIONS) {
      if (partial[dim] !== undefined) {
        this.consumption[dim] += partial[dim];
      }
    }
  }

  check(): EnforcerBudgetCheckResult {
    const hardBreached: BudgetDimension[] = [];
    const softBreached: BudgetDimension[] = [];

    for (const dim of DIMENSIONS) {
      if (this.consumption[dim] >= this.limits[dim]) {
        hardBreached.push(dim);
      } else if (this.consumption[dim] >= this.limits[dim] * (this.softLimitPercent / 100)) {
        softBreached.push(dim);
      }
    }

    if (hardBreached.length > 0) {
      return { status: 'hard_limit', breachedDimensions: hardBreached };
    }
    if (softBreached.length > 0) {
      return { status: 'soft_limit', breachedDimensions: softBreached };
    }
    return { status: 'ok', breachedDimensions: [] };
  }

  snapshot(): EnforcerBudgetSnapshot {
    return { ...this.consumption };
  }

  restore(snapshot: EnforcerBudgetSnapshot): void {
    this.consumption = { ...snapshot };
  }

  remaining(): Record<BudgetDimension, number> {
    const result = {} as Record<BudgetDimension, number>;
    for (const dim of DIMENSIONS) {
      result[dim] = Math.max(0, this.limits[dim] - this.consumption[dim]);
    }
    return result;
  }

  percentUsed(): Record<BudgetDimension, number> {
    const result = {} as Record<BudgetDimension, number>;
    for (const dim of DIMENSIONS) {
      result[dim] = this.limits[dim] === 0 ? 100 : (this.consumption[dim] / this.limits[dim]) * 100;
    }
    return result;
  }
}
