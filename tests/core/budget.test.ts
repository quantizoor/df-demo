import { describe, expect, it } from "vitest";
import { checkBudget, remainingBudget, spendBudget } from "../../src/core/budget.js";
import type { BudgetSnapshot } from "../../src/domain/models.js";

const snapshot: BudgetSnapshot = {
  limits: {
    maximumUsd: 100,
    maximumTokens: 1_000_000,
    maximumWallTimeMs: 60_000,
    maximumAttempts: 38,
    maximumPrivacyReleases: 5,
    maximumPromotionLooks: 5,
  },
  usage: {
    spentUsd: 10,
    tokens: 100,
    wallTimeMs: 1_000,
    attempts: 2,
    privacyReleases: 0,
    promotionLooks: 0,
  },
};

describe("campaign budgets", () => {
  it("projects and spends every budget dimension atomically", () => {
    const result = checkBudget(snapshot, {
      spentUsd: 5,
      tokens: 20,
      wallTimeMs: 100,
      attempts: 1,
      privacyReleases: 1,
      promotionLooks: 1,
    });
    expect(result.allowed).toBe(true);
    expect(spendBudget(snapshot, { attempts: 1 }).usage.attempts).toBe(3);
    expect(snapshot.usage.attempts).toBe(2);
  });

  it("fails closed before a sealed limit is crossed", () => {
    const result = checkBudget(snapshot, { attempts: 37, spentUsd: 91 });
    expect(result.allowed).toBe(false);
    expect(result.exhausted).toEqual(["spentUsd", "attempts"]);
    expect(() => spendBudget(snapshot, { attempts: 37 })).toThrow(/budget/u);
  });

  it("reports non-negative remaining capacity", () => {
    expect(remainingBudget(snapshot)).toMatchObject({
      spentUsd: 90,
      attempts: 36,
      privacyReleases: 5,
    });
  });

  it("rejects invalid values", () => {
    expect(() =>
      checkBudget(
        {
          ...snapshot,
          usage: { ...snapshot.usage, spentUsd: Number.NaN },
        },
        {},
      ),
    ).toThrow(/finite/u);
  });
});

