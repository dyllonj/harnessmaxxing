import type {
  BudgetDimension,
  BudgetLimits,
  BudgetSnapshot,
  BudgetCheckResult,
} from '../types/budget.js';

const DIMENSIONS: BudgetDimension[] = [
  'tokensUsed',
  'estimatedCostUsd',
  'wallTimeMs',
  'toolInvocations',
  'apiCalls',
];

export class BudgetEnforcer {
  private readonly limits: BudgetLimits;
  private readonly softLimitPercent: number;
  private consumption: BudgetSnapshot;

  constructor(limits: BudgetLimits, softLimitPercent = 80) {
    this.limits = { ...limits };
    this.softLimitPercent = softLimitPercent;
    this.consumption = {
      tokensUsed: 0,
      estimatedCostUsd: 0,
      wallTimeMs: 0,
      toolInvocations: 0,
      apiCalls: 0,
    };
  }

  record(partial: Partial<BudgetSnapshot>): void {
    for (const dim of DIMENSIONS) {
      if (partial[dim] !== undefined) {
        this.consumption[dim] += partial[dim];
      }
    }
  }

  check(): BudgetCheckResult {
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

  snapshot(): BudgetSnapshot {
    return { ...this.consumption };
  }

  restore(snapshot: BudgetSnapshot): void {
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
