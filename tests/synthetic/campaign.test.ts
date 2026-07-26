import { describe, expect, it } from "vitest";

import { runSyntheticWalkForwardCampaign } from "../../src/synthetic/campaign.js";

describe("cloud synthetic walk-forward campaign", () => {
  it("promotes only on fresh evidence, preserves the champion on rejection and inconclusive results, and leaks no canary", async () => {
    const receipt = await runSyntheticWalkForwardCampaign();

    expect(receipt.scenarios.map((entry) => entry.observedDisposition)).toEqual(
      ["promoted", "rejected", "inconclusive"],
    );
    expect(receipt.scenarios[1]?.activeCommitHash).toBe(
      receipt.scenarios[0]?.activeCommitHash,
    );
    expect(receipt.scenarios[2]?.activeCommitHash).toBe(
      receipt.scenarios[0]?.activeCommitHash,
    );
    expect(receipt.finalBudgetUsage).toMatchObject({
      attempts: 58,
      privacyReleases: 2,
      promotionLooks: 2,
    });
    expect(JSON.stringify(receipt)).not.toContain(
      "DF_SYNTHETIC_PRIVATE_TASK_CANARY",
    );
    expect(receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/u);
  });
});
