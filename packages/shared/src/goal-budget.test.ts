import { describe, expect, it } from "vitest";
import {
  DEFAULT_GOAL_BUDGET,
  isGoalBudget,
  normalizeGoalBudgetDefaults,
} from "./goal-budget.js";

const budget = (overrides: Partial<typeof DEFAULT_GOAL_BUDGET> = {}) => ({
  ...DEFAULT_GOAL_BUDGET,
  ...overrides,
});

describe("Goal budget defaults", () => {
  it("defaults to 8 rounds, 250,000 retained tokens, 60 minutes, and unlimited tokens", () => {
    expect(DEFAULT_GOAL_BUDGET).toEqual({
      maxRounds: 8,
      maxTokens: 250_000,
      maxDurationMs: 60 * 60 * 1000,
      tokenBudgetUnlimited: true,
    });
    expect(normalizeGoalBudgetDefaults(undefined)).toEqual(DEFAULT_GOAL_BUDGET);
    expect(normalizeGoalBudgetDefaults(undefined)).not.toBe(DEFAULT_GOAL_BUDGET);
  });

  it("accepts inclusive round, finite-token, and duration boundaries", () => {
    expect(isGoalBudget(budget({ maxRounds: 1, maxTokens: 1, maxDurationMs: 60_000 }))).toBe(true);
    expect(isGoalBudget(budget({ maxRounds: 32, maxTokens: Number.MAX_SAFE_INTEGER, maxDurationMs: 86_400_000 }))).toBe(true);
    expect(isGoalBudget(budget({ tokenBudgetUnlimited: false }))).toBe(true);
    expect(isGoalBudget(budget({ tokenBudgetUnlimited: true, maxTokens: Number.MAX_SAFE_INTEGER }))).toBe(true);
  });

  it("rejects missing fields, wrong types, and values outside supported bounds", () => {
    const invalidBudgets: unknown[] = [
      null,
      [],
      {},
      { ...budget(), maxRounds: 0 },
      { ...budget(), maxRounds: 33 },
      { ...budget(), maxRounds: 1.5 },
      { ...budget(), maxRounds: "8" },
      { ...budget(), maxTokens: 0 },
      { ...budget(), maxTokens: -1 },
      { ...budget(), maxTokens: 1.5 },
      { ...budget(), maxTokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...budget(), maxTokens: "250000" },
      { ...budget(), maxDurationMs: 59_999 },
      { ...budget(), maxDurationMs: 86_400_001 },
      { ...budget(), maxDurationMs: 60_000.5 },
      { ...budget(), maxDurationMs: "3600000" },
      { ...budget(), tokenBudgetUnlimited: "true" },
      { ...budget(), tokenBudgetUnlimited: undefined },
    ];

    for (const value of invalidBudgets) {
      expect(isGoalBudget(value), JSON.stringify(value)).toBe(false);
      expect(normalizeGoalBudgetDefaults(value), JSON.stringify(value)).toEqual(DEFAULT_GOAL_BUDGET);
    }
  });
});