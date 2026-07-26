import { describe, expect, it } from "vitest";

import { assertCampaignStateTransition } from "../../src/campaign/index.js";
import type { CampaignState } from "../../src/schemas/control.js";
import { HASH_A, initialCampaignStateFixture, LATER } from "./fixtures.js";

const USAGE_LIMIT_PAIRS = [
  ["spentUsd", "maximumUsd"],
  ["tokens", "maximumTokens"],
  ["wallTimeMs", "maximumWallTimeMs"],
  ["attempts", "maximumAttempts"],
  ["privacyReleases", "maximumPrivacyReleases"],
  ["promotionLooks", "maximumPromotionLooks"],
  ["onlineErrorSpent", "maximumOnlineError"],
] as const satisfies readonly (readonly [
  keyof CampaignState["budget"]["usage"],
  keyof CampaignState["budget"]["limits"],
])[];

function transitionWithUsageAboveLimit(
  previous: CampaignState,
  usageField: keyof CampaignState["budget"]["usage"],
  limitField: keyof CampaignState["budget"]["limits"],
): CampaignState {
  const overage = usageField === "onlineErrorSpent" ? 0.01 : 1;
  return {
    ...previous,
    createdAt: LATER,
    provenanceRefs: [
      {
        artifactName: "harness-registration",
        contentHash: previous.harnessRegistrationHash,
      },
      {
        artifactName: "campaign-state",
        contentHash: previous.contentHash,
      },
    ],
    revision: previous.revision + 1,
    previousStateHash: previous.contentHash,
    budget: {
      ...previous.budget,
      usage: {
        ...previous.budget.usage,
        [usageField]: previous.budget.limits[limitField] + overage,
      },
      accountingAttestationHash: HASH_A,
    },
  };
}

describe("campaign budget transition invariants", () => {
  it.each(USAGE_LIMIT_PAIRS)(
    "rejects %s usage above its corresponding %s limit",
    (usageField, limitField) => {
      const previous = initialCampaignStateFixture();
      const next = transitionWithUsageAboveLimit(previous, usageField, limitField);

      expect(() => assertCampaignStateTransition(previous, next)).toThrow(
        `Budget usage ${usageField} cannot exceed limit ${limitField}`,
      );
    },
  );
});
