export type Budget = {
  tokens: { soft: number; hard: number };
  costUsd: { soft: number; hard: number };
  wallTimeMs: { soft: number; hard: number };
  toolInvocations: { soft: number; hard: number };
};

export type BudgetDimension = 'tokensUsed' | 'estimatedCostUsd' | 'wallTimeMs' | 'toolInvocations' | 'apiCalls';

export type BudgetSnapshot = {
  tokensUsed: number;
  estimatedCostUsd: number;
  wallTimeMs: number;
  toolInvocations: number;
  apiCalls: number;
};

export type BudgetLimits = Record<BudgetDimension, number>;

export type BudgetCheckResult = {
  status: 'ok' | 'soft_limit' | 'hard_limit';
  breachedDimensions: BudgetDimension[];
};

export function checkBudget(budget: Budget, current: BudgetSnapshot): BudgetCheckResult {
  const dimensions: Array<{ dim: BudgetDimension; current: number; soft: number; hard: number }> = [
    { dim: 'tokensUsed', current: current.tokensUsed, soft: budget.tokens.soft, hard: budget.tokens.hard },
    { dim: 'estimatedCostUsd', current: current.estimatedCostUsd, soft: budget.costUsd.soft, hard: budget.costUsd.hard },
    { dim: 'wallTimeMs', current: current.wallTimeMs, soft: budget.wallTimeMs.soft, hard: budget.wallTimeMs.hard },
    { dim: 'toolInvocations', current: current.toolInvocations, soft: budget.toolInvocations.soft, hard: budget.toolInvocations.hard },
  ];

  const hardBreached: BudgetDimension[] = [];
  const softBreached: BudgetDimension[] = [];

  for (const d of dimensions) {
    if (d.current >= d.hard) {
      hardBreached.push(d.dim);
    } else if (d.current >= d.soft) {
      softBreached.push(d.dim);
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
