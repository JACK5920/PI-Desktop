import { GOAL_BUDGET_LIMITS, isGoalBudget, type GoalBudget } from "@pi-desktop/shared";

export type GoalBudgetDraft = {
  maxRounds: string;
  maxTokens: string;
  maxDurationMinutes: string;
  tokenBudgetUnlimited: boolean;
};

export type GoalBudgetDraftValidation = {
  budget: GoalBudget | null;
  valid: boolean;
  fields: {
    maxRounds: boolean;
    maxTokens: boolean;
    maxDurationMinutes: boolean;
  };
};

export function goalBudgetDraftFromBudget(budget: GoalBudget): GoalBudgetDraft {
  return {
    maxRounds: String(budget.maxRounds),
    maxTokens: String(budget.maxTokens),
    maxDurationMinutes: String(Math.ceil(budget.maxDurationMs / 60_000)),
    tokenBudgetUnlimited: budget.tokenBudgetUnlimited,
  };
}

export function validateGoalBudgetDraft(draft: GoalBudgetDraft): GoalBudgetDraftValidation {
  const maxRounds = Number(draft.maxRounds);
  const maxTokens = Number(draft.maxTokens);
  const maxDurationMinutes = Number(draft.maxDurationMinutes);
  const budget = {
    maxRounds,
    maxTokens,
    maxDurationMs: maxDurationMinutes * 60_000,
    tokenBudgetUnlimited: draft.tokenBudgetUnlimited,
  };
  const fields = {
    maxRounds:
      Number.isInteger(maxRounds) &&
      maxRounds >= GOAL_BUDGET_LIMITS.minRounds &&
      maxRounds <= GOAL_BUDGET_LIMITS.maxRounds,
    maxTokens:
      Number.isSafeInteger(maxTokens) &&
      maxTokens >= GOAL_BUDGET_LIMITS.minTokens &&
      maxTokens <= GOAL_BUDGET_LIMITS.maxTokens,
    maxDurationMinutes:
      Number.isSafeInteger(maxDurationMinutes) &&
      maxDurationMinutes * 60_000 >= GOAL_BUDGET_LIMITS.minDurationMs &&
      maxDurationMinutes * 60_000 <= GOAL_BUDGET_LIMITS.maxDurationMs,
  };
  const valid = Object.values(fields).every(Boolean) && isGoalBudget(budget);

  return { budget: valid ? budget : null, valid, fields };
}
