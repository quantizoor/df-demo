import { describe, expect, it } from "vitest";
import {
  computeProtocolHash,
  diffProtocolInputs,
  requiresNewBaselineLineage,
} from "../../src/core/protocol.js";
import type { ProtocolInputs } from "../../src/domain/models.js";

function protocol(): ProtocolInputs {
  return {
    schemaVersion: "1.0.0",
    mode: "research",
    leaderboardEligibility: "unverified",
    benchmark: {
      name: "terminal-bench",
      version: "2.1",
      datasetRevision: "revision",
      datasetDigest: "digest",
      harborVersion: "harbor",
      timeoutPolicyHash: "timeout",
      resourcePolicyHash: "resources",
    },
    harness: {
      repositoryRegistrationId: "pi",
      forkCommit: "a".repeat(40),
      upstreamCommit: "b".repeat(40),
      lockHash: "lock",
      configurationHash: "configuration",
    },
    optimizer: {
      claudeCodeVersion: "version",
      model: "optimizer-model",
      permissionPolicyHash: "permissions",
      pluginHash: "plugin",
    },
    evaluatedModel: {
      provider: "provider",
      model: "evaluated-model",
      providerVersion: "provider-version",
      reasoning: "high",
      samplingHash: "sampling",
      contextWindow: 100_000,
    },
    sandbox: {
      provider: "daytona",
      imageDigest: "image",
      architecture: "linux-x64",
      regionClass: "region",
      resourceProfile: "resources",
      networkPolicyHash: "network",
    },
    policies: {
      protocol: "1",
      broker: "1",
      weighting: "1",
      normalizer: "1",
      extractor: "1",
      statistics: "1",
      privacy: "1",
      cache: "1",
      decision: "1",
      integrity: "1",
      retention: "1",
    },
  };
}

describe("protocol identity", () => {
  it("is independent of object insertion order", () => {
    const first = protocol();
    const second = {
      ...first,
      policies: {
        retention: "1",
        integrity: "1",
        decision: "1",
        cache: "1",
        privacy: "1",
        statistics: "1",
        extractor: "1",
        normalizer: "1",
        weighting: "1",
        broker: "1",
        protocol: "1",
      },
    };
    expect(computeProtocolHash(first)).toBe(computeProtocolHash(second));
  });

  it("requires a new baseline for any semantic input change", () => {
    const first = protocol();
    const second = {
      ...first,
      evaluatedModel: { ...first.evaluatedModel, reasoning: "medium" },
    };
    expect(requiresNewBaselineLineage(first, second)).toBe(true);
    expect(diffProtocolInputs(first, second)).toEqual([
      {
        path: "evaluatedModel.reasoning",
        before: "high",
        after: "medium",
      },
    ]);
  });

  it("rejects an unverified submission protocol", () => {
    expect(() =>
      computeProtocolHash({
        ...protocol(),
        mode: "submission",
      }),
    ).toThrow(/unverified/u);
  });
});

