import { DarkFactoryError } from "./errors.js";
import type { BudgetLimits, BudgetSnapshot, BudgetUsage } from "../domain/models.js";

const USAGE_FIELDS = [
  "spentUsd",
  "tokens",
  "wallTimeMs",
  "attempts",
  "privacyReleases",
  "promotionLooks",
] as const;

export type BudgetDelta = Partial<BudgetUsage>;

export interface BudgetCheck {
  readonly allowed: boolean;
  readonly exhausted: readonly string[];
  readonly projected: BudgetUsage;
}

function nonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new DarkFactoryError("CONFIG_INVALID", `${name} must be finite and non-negative`, {
      field: name,
    });
  }
}

export function validateBudgetSnapshot(snapshot: BudgetSnapshot): void {
  for (const [field, value] of Object.entries(snapshot.limits)) {
    nonNegativeFinite(`limits.${field}`, value);
  }
  for (const [field, value] of Object.entries(snapshot.usage)) {
    nonNegativeFinite(`usage.${field}`, value);
  }
}

export function checkBudget(snapshot: BudgetSnapshot, delta: BudgetDelta): BudgetCheck {
  validateBudgetSnapshot(snapshot);
  const projected: BudgetUsage = {
    spentUsd: snapshot.usage.spentUsd + (delta.spentUsd ?? 0),
    tokens: snapshot.usage.tokens + (delta.tokens ?? 0),
    wallTimeMs: snapshot.usage.wallTimeMs + (delta.wallTimeMs ?? 0),
    attempts: snapshot.usage.attempts + (delta.attempts ?? 0),
    privacyReleases: snapshot.usage.privacyReleases + (delta.privacyReleases ?? 0),
    promotionLooks: snapshot.usage.promotionLooks + (delta.promotionLooks ?? 0),
  };

  const limitsByUsage: Readonly<Record<(typeof USAGE_FIELDS)[number], number>> = {
    spentUsd: snapshot.limits.maximumUsd,
    tokens: snapshot.limits.maximumTokens,
    wallTimeMs: snapshot.limits.maximumWallTimeMs,
    attempts: snapshot.limits.maximumAttempts,
    privacyReleases: snapshot.limits.maximumPrivacyReleases,
    promotionLooks: snapshot.limits.maximumPromotionLooks,
  };

  const exhausted = USAGE_FIELDS.filter((field) => projected[field] > limitsByUsage[field]);
  return { allowed: exhausted.length === 0, exhausted, projected };
}

export function spendBudget(snapshot: BudgetSnapshot, delta: BudgetDelta): BudgetSnapshot {
  const result = checkBudget(snapshot, delta);
  if (!result.allowed) {
    throw new DarkFactoryError("BUDGET_EXHAUSTED", "The sealed campaign budget would be exceeded", {
      exhausted: result.exhausted,
    });
  }
  return { limits: snapshot.limits, usage: result.projected };
}

export function remainingBudget(snapshot: BudgetSnapshot): BudgetUsage {
  validateBudgetSnapshot(snapshot);
  return {
    spentUsd: Math.max(0, snapshot.limits.maximumUsd - snapshot.usage.spentUsd),
    tokens: Math.max(0, snapshot.limits.maximumTokens - snapshot.usage.tokens),
    wallTimeMs: Math.max(0, snapshot.limits.maximumWallTimeMs - snapshot.usage.wallTimeMs),
    attempts: Math.max(0, snapshot.limits.maximumAttempts - snapshot.usage.attempts),
    privacyReleases: Math.max(
      0,
      snapshot.limits.maximumPrivacyReleases - snapshot.usage.privacyReleases,
    ),
    promotionLooks: Math.max(
      0,
      snapshot.limits.maximumPromotionLooks - snapshot.usage.promotionLooks,
    ),
  };
}

