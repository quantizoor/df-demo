import { describe, expect, it } from "vitest";
import {
  assertComparableProtocol,
  assertComplianceManifest,
  expectedChannels,
} from "../../src/core/compliance.js";
import type { ComplianceManifest } from "../../src/domain/models.js";

function manifest(
  mode: ComplianceManifest["mode"],
  eligibility: ComplianceManifest["leaderboardEligibility"],
): ComplianceManifest {
  return {
    schemaVersion: "1.0.0",
    mode,
    leaderboardEligibility: eligibility,
    protocolHash: "a".repeat(64),
    lineageId: "lineage",
    channels: expectedChannels(mode),
    optimizerHasBenchmarkCredentials: false,
    localRawEvidenceAllowed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    signature: "signature",
    signerKeyId: "key",
  };
}

describe("compliance", () => {
  it("keeps research feedback and official evaluation mutually exclusive", () => {
    expect(expectedChannels("research").officialEvaluation).toBe(false);
    expect(expectedChannels("submission").diagnosticBriefs).toBe(false);
    expect(() => assertComplianceManifest(manifest("research", "unverified"))).not.toThrow();
  });

  it("rejects an unverified submission lineage and mixed channels", () => {
    expect(() => assertComplianceManifest(manifest("submission", "unverified"))).toThrow(
      /eligibility/u,
    );
    expect(() =>
      assertComplianceManifest({
        ...manifest("submission", "cleared"),
        channels: expectedChannels("research"),
      }),
    ).toThrow(/channels/u);
  });

  it("rejects unmatched protocols", () => {
    expect(() => assertComparableProtocol("left", "right")).toThrow(/different protocol/u);
  });
});
