export type Budget = {
  tokens: { soft: number; hard: number };
  costUsd: { soft: number; hard: number };
  wallTimeMs: { soft: number; hard: number };
  invocations: { soft: number; hard: number };
};

export type BudgetSnapshot = {
  tokensUsed: number;
  estimatedCostUsd: number;
  wallTimeMs: number;
  invocations: number;
};

export type BudgetCheckResult = 'ok' | 'soft_limit' | 'hard_limit';

export function checkBudget(budget: Budget, current: BudgetSnapshot): BudgetCheckResult {
  const dimensions: Array<{ current: number; soft: number; hard: number }> = [
    { current: current.tokensUsed, soft: budget.tokens.soft, hard: budget.tokens.hard },
    { current: current.estimatedCostUsd, soft: budget.costUsd.soft, hard: budget.costUsd.hard },
    { current: current.wallTimeMs, soft: budget.wallTimeMs.soft, hard: budget.wallTimeMs.hard },
    { current: current.invocations, soft: budget.invocations.soft, hard: budget.invocations.hard },
  ];

  for (const dim of dimensions) {
    if (dim.current >= dim.hard) {
      return 'hard_limit';
    }
  }

  for (const dim of dimensions) {
    if (dim.current >= dim.soft) {
      return 'soft_limit';
    }
  }

  return 'ok';
}
