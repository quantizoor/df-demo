import { describe, expect, it } from "vitest";
import { expectedChannels } from "../../src/core/compliance.js";
import {
  type AuthorizationStore,
  authorizeFullEvaluation,
  consumeFullEvaluationAuthorization,
  type FullEvaluationAuthorization,
  type FullEvaluationChallenge,
  type FullEvaluationReadiness,
  prepareFullEvaluation,
} from "../../src/full-eval/authorization.js";

class MemoryAuthorizationStore implements AuthorizationStore {
  readonly challenges = new Map<string, FullEvaluationChallenge>();
  readonly authorizations = new Map<string, FullEvaluationAuthorization>();

  async putChallenge(challenge: FullEvaluationChallenge): Promise<void> {
    this.challenges.set(challenge.challengeId, challenge);
  }
  async getChallenge(challengeId: string): Promise<FullEvaluationChallenge | null> {
    return this.challenges.get(challengeId) ?? null;
  }
  async deleteChallenge(challengeId: string): Promise<void> {
    this.challenges.delete(challengeId);
  }
  async putAuthorization(authorization: FullEvaluationAuthorization): Promise<void> {
    this.authorizations.set(authorization.authorizationId, authorization);
  }
  async getAuthorization(authorizationId: string): Promise<FullEvaluationAuthorization | null> {
    return this.authorizations.get(authorizationId) ?? null;
  }
  async consumeAuthorization(authorizationId: string, usedAt: string): Promise<boolean> {
    const current = this.authorizations.get(authorizationId);
    if (current === undefined || current.usedAt !== null) {
      return false;
    }
    this.authorizations.set(authorizationId, { ...current, usedAt });
    return true;
  }
}

const protocolHash = "a".repeat(64);
const commit = "b".repeat(40);

const readiness: FullEvaluationReadiness = {
  manifest: {
    schemaVersion: "1.0.0",
    mode: "submission",
    leaderboardEligibility: "cleared",
    protocolHash,
    lineageId: "lineage",
    channels: expectedChannels("submission"),
    optimizerHasBenchmarkCredentials: false,
    localRawEvidenceAllowed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    signature: "signature",
    signerKeyId: "key",
  },
  protocol: {
    schemaVersion: "1.0.0",
    mode: "submission",
    leaderboardEligibility: "cleared",
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
      forkCommit: commit,
      upstreamCommit: commit,
      lockHash: "lock",
      configurationHash: "configuration",
    },
    optimizer: {
      claudeCodeVersion: "version",
      model: "model",
      permissionPolicyHash: "permissions",
      pluginHash: "plugin",
    },
    evaluatedModel: {
      provider: "provider",
      model: "model",
      providerVersion: "provider-version",
      reasoning: "reasoning",
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
  },
  protocolHash,
  champions: {
    baselineCommit: commit,
    activeExperiment: 3,
    activeCommit: commit,
    certifiedExperiment: 3,
    certifiedCommit: commit,
    updatedAt: "2026-01-01T00:00:00.000Z",
    sourceSealHash: "c".repeat(64),
  },
  expectedTaskCount: 89,
  trialsPerTask: 5,
  expectedCostUsd: 100,
};

describe("human-only full evaluation", () => {
  it("authorizes and consumes exactly once from an interactive TTY", async () => {
    const store = new MemoryAuthorizationStore();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const challenge = await prepareFullEvaluation(store, readiness, now);
    const authorization = await authorizeFullEvaluation(
      store,
      challenge.challengeId,
      challenge.challenge,
      protocolHash,
      { stdinIsTty: true, source: "interactive-cli", now },
    );
    await expect(
      consumeFullEvaluationAuthorization(store, authorization.authorizationId, protocolHash, {
        stdinIsTty: true,
        source: "interactive-cli",
        now,
      }),
    ).resolves.toBeUndefined();
    await expect(
      consumeFullEvaluationAuthorization(store, authorization.authorizationId, protocolHash, {
        stdinIsTty: true,
        source: "interactive-cli",
        now,
      }),
    ).rejects.toThrow(/missing, used/u);
  });

  it.each(["ci", "claude", "mcp", "background"] as const)(
    "rejects authorization from %s",
    async (source) => {
      const store = new MemoryAuthorizationStore();
      const now = new Date("2026-01-01T00:00:00.000Z");
      const challenge = await prepareFullEvaluation(store, readiness, now);
      await expect(
        authorizeFullEvaluation(store, challenge.challengeId, challenge.challenge, protocolHash, {
          stdinIsTty: false,
          source,
          now,
        }),
      ).rejects.toThrow(/interactive/u);
    },
  );

  it("rejects research mode even if all other fields look ready", async () => {
    const store = new MemoryAuthorizationStore();
    await expect(
      prepareFullEvaluation(
        store,
        {
          ...readiness,
          manifest: {
            ...readiness.manifest,
            mode: "research",
            leaderboardEligibility: "unverified",
            channels: expectedChannels("research"),
          },
        },
        new Date("2026-01-01T00:00:00.000Z"),
      ),
    ).rejects.toThrow(/submission mode/u);
  });
});
