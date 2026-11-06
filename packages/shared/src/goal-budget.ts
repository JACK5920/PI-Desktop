import type { GoalBudget } from "./types/plans.js";

export const GOAL_BUDGET_LIMITS = Object.freeze({
  minRounds: 1,
  maxRounds: 32,
  minTokens: 1,
  maxTokens: Number.MAX_SAFE_INTEGER,
  minDurationMs: 60_000,
  maxDurationMs: 24 * 60 * 60 * 1000,
});

export const DEFAULT_GOAL_BUDGET: Readonly<GoalBudget> = Object.freeze({
  maxRounds: 8,
  maxTokens: 250_000,
  maxDurationMs: 60 * 60 * 1000,
  tokenBudgetUnlimited: true,
});

export function isGoalBudget(value: unknown): value is GoalBudget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const budget = value as Record<string, unknown>;
  return (
    Number.isInteger(budget.maxRounds) &&
    Number(budget.maxRounds) >= GOAL_BUDGET_LIMITS.minRounds &&
    Number(budget.maxRounds) <= GOAL_BUDGET_LIMITS.maxRounds &&
    Number.isSafeInteger(budget.maxTokens) &&
    Number(budget.maxTokens) >= GOAL_BUDGET_LIMITS.minTokens &&
    Number(budget.maxTokens) <= GOAL_BUDGET_LIMITS.maxTokens &&
    Number.isInteger(budget.maxDurationMs) &&
    Number(budget.maxDurationMs) >= GOAL_BUDGET_LIMITS.minDurationMs &&
    Number(budget.maxDurationMs) <= GOAL_BUDGET_LIMITS.maxDurationMs &&
    typeof budget.tokenBudgetUnlimited === "boolean"
  );
}

/** Invalid or absent legacy values fail closed to the documented defaults. */
export function normalizeGoalBudgetDefaults(value: unknown): GoalBudget {
  return isGoalBudget(value) ? { ...value } : { ...DEFAULT_GOAL_BUDGET };
}