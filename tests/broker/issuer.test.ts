import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Ed25519ResultEnvelopeIssuer,
  Ed25519ResultEnvelopeVerifier,
} from "../../src/broker/issuer.js";
import type { TrustedCanonicalAggregate } from "../../src/broker/service.js";
import {
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "../../src/evaluator/contracts.js";
import { assertSafeForLocalPersistence } from "../../src/evaluator/retention.js";

const HASH = "a".repeat(64);

function request(): TrustedEvaluationRequest {
  return {
    schemaVersion: 1,
    requestId: "request-001",
    experimentId: "001-recovery",
    runMode: "research",
    stage: "validation",
    submittedAt: "2026-07-01T00:00:00.000Z",
    deadlineAt: "2026-07-01T06:00:00.000Z",
    protocolHash: HASH,
    complianceManifestHash: "b".repeat(64),
    candidate: {
      uri: "trusted://harness/candidate",
      commitSha: "1".repeat(40),
      treeSha: "1".repeat(40),
      archiveSha256: "1".repeat(64),
    },
    champion: {
      uri: "trusted://harness/champion",
      commitSha: "2".repeat(40),
      treeSha: "2".repeat(40),
      archiveSha256: "2".repeat(64),
    },
    selection: {
      kind: "fresh-matched-validation",
      taskCount: 12,
      attemptsPerArm: 1,
      pairOrder: "balanced-6-ab-6-ba",
      weightingPolicyHash: "3".repeat(64),
      frozenHypothesisHash: "4".repeat(64),
      hypothesisExclusionAttestationHash: "4".repeat(64),
    },
    executionProfile: {
      provider: "daytona",
      imageDigest: `sha256:${"5".repeat(64)}`,
      regionClass: "eu-standard",
      resources: {
        architecture: "x86_64",
        cpuCores: 8,
        memoryMiB: 16_384,
        diskMiB: 100_000,
      },
      networkPolicyHash: "6".repeat(64),
      protocolHash: HASH,
    },
    evaluatedModel: {
      provider: "openai",
      modelId: "gpt-5.6",
      thinkingLevel: "high",
    },
  };
}

function aggregate(evaluationRequest: TrustedEvaluationRequest): TrustedCanonicalAggregate {
  return {
    sensitivity: "trusted-canonical-aggregate",
    requestHash: hashEvaluationRequest(evaluationRequest),
    protocolHash: evaluationRequest.protocolHash,
    rawManifestId: "manifest-001",
    payload: {
      kind: "validation",
      disposition: "inconclusive",
      matchedTaskCount: 12,
      validFreshArmCount: 24,
      invalidArmTotal: 0,
      stratumCount: 3,
      pairOutcomeTotals: {
        bothPass: 3,
        challengerOnlyPass: 3,
        championOnlyPass: 3,
        bothFail: 3,
      },
      weightedAccuracy: {
        medianDelta: 0,
        credibleInterval: { lower: -0.2, upper: 0.2 },
        probabilityPositive: 0.5,
      },
      requiredPosteriorProbability: 0.95,
      onlineGateAuthorized: true,
      onlineErrorBudget: {
        policyVersion: "online-alpha-spending-v1",
        maximumOnlineError: 0.05,
        gateOrdinal: 1,
        alphaSpent: 0.05,
        cumulativeSpentBefore: 0,
        cumulativeSpentAfter: 0.05,
        remainingAfter: 0,
        reservationHash: "3".repeat(64),
        priorStateHash: "4".repeat(64),
        resultingStateHash: "5".repeat(64),
      },
      stratumRegressionVeto: false,
      integrityVeto: false,
      correctnessVeto: false,
      capabilityVeto: false,
      costWithinGuardrail: true,
      latencyWithinGuardrail: true,
      accuracyTradeoffPredeclared: false,
      aggregateCost: {
        inputTokens: 100,
        outputTokens: 50,
        modelUsd: 1,
        sandboxUsd: 0.5,
        totalUsd: 1.5,
        wallTimeMs: 60_000,
      },
    },
    normalizedOutcomeSetHash: "7".repeat(64),
    cacheAttestationHash: "8".repeat(64),
    behavioralAggregateHash: null,
    derivedAt: "2026-07-01T00:04:00.000Z",
    releaseChecks: {
      graderCanaryScanPassed: true,
      contentFingerprintScanPassed: true,
      taskIdentityScanPassed: true,
      privacyThresholdPassed: false,
    },
  };
}

describe("canonical signed evaluator release", () => {
  it("signs only aggregate evidence after attested raw destruction", async () => {
    const evaluationRequest = request();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const issuer = new Ed25519ResultEnvelopeIssuer({
      privateKey,
      keyId: "evaluator-key-1",
      now: () => new Date("2026-07-01T00:11:00.000Z"),
    });
    const envelope = await issuer.issue({
      request: evaluationRequest,
      requestHash: hashEvaluationRequest(evaluationRequest),
      dispositionAttestationHash: "9".repeat(64),
      aggregate: aggregate(evaluationRequest),
      destructionReceipt: {
        manifestId: "manifest-001",
        destroyedAt: "2026-07-01T00:10:00.000Z",
        verifierAttestationHash: "c".repeat(64),
      },
      retentionPolicyHash: "d".repeat(64),
    });
    const verifier = new Ed25519ResultEnvelopeVerifier({
      getVerificationKey: (keyId) =>
        Promise.resolve(keyId === "evaluator-key-1" ? publicKey : undefined),
    });
    await expect(verifier.verify(envelope)).resolves.toBe(true);
    expect(() => assertSafeForLocalPersistence(envelope)).not.toThrow();
    expect(envelope.derivation.rawArtifacts).toEqual({
      exported: false,
      retentionDisposition: "destroyed",
      retentionPolicyHash: "d".repeat(64),
    });
    expect(JSON.stringify(envelope)).not.toContain("manifest-001");
  });

  it("rejects signing before raw destruction", async () => {
    const evaluationRequest = request();
    const { privateKey } = generateKeyPairSync("ed25519");
    const issuer = new Ed25519ResultEnvelopeIssuer({
      privateKey,
      keyId: "evaluator-key-1",
      now: () => new Date("2026-07-01T00:05:00.000Z"),
    });
    await expect(
      issuer.issue({
        request: evaluationRequest,
        requestHash: hashEvaluationRequest(evaluationRequest),
        dispositionAttestationHash: "9".repeat(64),
        aggregate: aggregate(evaluationRequest),
        destructionReceipt: {
          manifestId: "manifest-001",
          destroyedAt: "2026-07-01T00:10:00.000Z",
          verifierAttestationHash: "c".repeat(64),
        },
        retentionPolicyHash: "d".repeat(64),
      }),
    ).rejects.toThrow(/before/u);
  });
});
