import {
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  CanonicalEvaluatorClient,
  EphemeralCanonicalEvaluatorReplayLedger,
  type CanonicalEvaluatorKeyring,
  type CanonicalEvaluatorTransport,
  type ReleasedEvaluationBundle,
} from "../../src/evaluator/canonical-client.js";
import {
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "../../src/evaluator/contracts.js";
import {
  resultEnvelopeBehavioralSourceCommitmentHash,
} from "../../src/evaluator/release-lineage.js";
import {
  createEd25519Signature,
} from "../../src/evidence/signatures.js";
import type {
  BehavioralEvidence,
  DiagnosticBrief,
  FailureCards,
} from "../../src/schemas/artifacts.js";
import {
  withContentHash,
} from "../../src/schemas/canonical.js";
import type {
  SignedBehavioralRelease,
  SignedResultEnvelope,
} from "../../src/schemas/trusted.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CANDIDATE = "c".repeat(40);
const CHAMPION = "d".repeat(40);
const SUBMITTED_AT = "2026-07-26T10:00:00.000Z";
const CLOSED_AT = "2026-07-26T10:30:00.000Z";
const DERIVED_AT = "2026-07-26T11:00:00.000Z";
const NOW = new Date("2026-07-26T12:00:00.000Z");

function request(overrides: Partial<TrustedEvaluationRequest> = {}): TrustedEvaluationRequest {
  return {
    schemaVersion: 1,
    requestId: "request-001",
    experimentId: "001-improve-recovery",
    runMode: "research",
    stage: "validation",
    submittedAt: SUBMITTED_AT,
    deadlineAt: "2026-07-26T16:00:00.000Z",
    protocolHash: HASH_A,
    complianceManifestHash: HASH_B,
    candidate: {
      uri: "trusted://harness/candidate",
      commitSha: CANDIDATE,
      treeSha: CANDIDATE,
      archiveSha256: HASH_A,
    },
    champion: {
      uri: "trusted://harness/champion",
      commitSha: CHAMPION,
      treeSha: CHAMPION,
      archiveSha256: HASH_B,
    },
    selection: {
      kind: "fresh-matched-validation",
      taskCount: 12,
      attemptsPerArm: 1,
      pairOrder: "balanced-6-ab-6-ba",
      weightingPolicyHash: HASH_A,
      frozenHypothesisHash: HASH_B,
      hypothesisExclusionAttestationHash: HASH_B,
    },
    executionProfile: {
      provider: "daytona",
      imageDigest: `sha256:${HASH_A}`,
      regionClass: "eu-standard",
      resources: {
        architecture: "x86_64",
        cpuCores: 4,
        memoryMiB: 8192,
        diskMiB: 20_000,
      },
      networkPolicyHash: HASH_A,
      protocolHash: HASH_A,
    },
    evaluatedModel: {
      provider: "openai",
      modelId: "gpt-5.6",
      thinkingLevel: "high",
    },
    ...overrides,
  };
}

function signedDocument(
  body: Readonly<Record<string, unknown>>,
  privateKey: KeyObject,
  signedAt = DERIVED_AT,
): Readonly<Record<string, unknown>> {
  const signature = createEd25519Signature(
    body,
    privateKey,
    "evaluator-key-1",
    signedAt,
  );
  return withContentHash({ ...body, signature });
}

function releaseBundle(
  evaluationRequest: TrustedEvaluationRequest,
  privateKey: KeyObject,
  overrides: {
    readonly cacheProtocolHash?: string;
    readonly resultCacheHash?: string;
    readonly signedAt?: string;
  } = {},
): unknown {
  const cache = signedDocument(
    {
      schemaVersion: "1.0.0",
      createdAt: SUBMITTED_AT,
      provenanceRefs: [],
      experimentNumber: 1,
      cachePolicyVersion: "cache-v1",
      protocolHash: overrides.cacheProtocolHash ?? evaluationRequest.protocolHash,
      aggregateUseStatus: "not-used",
      freshnessAgeBands: [],
      driftStatus: "not-applicable",
      smallCountSuppressionApplied: true,
      sealedWindow: {
        openedAt: SUBMITTED_AT,
        closedAt: CLOSED_AT,
      },
      repairBudgetCompliant: true,
      aggregateRepairCost: {
        inputTokens: 0,
        outputTokens: 0,
        modelUsd: 0,
        sandboxUsd: 0,
        totalUsd: 0,
        wallTimeMs: 0,
      },
      derivationHash: HASH_A,
    },
    privateKey,
    overrides.signedAt,
  );
  const cacheHash = cache.contentHash;
  if (typeof cacheHash !== "string") {
    throw new Error("Test cache document was not content-addressed");
  }
  const result = signedDocument(
    {
      schemaVersion: "1.0.0",
      createdAt: SUBMITTED_AT,
      provenanceRefs: [],
      envelopeId: "envelope-001",
      experimentNumber: 1,
      mode: "research",
      protocolHash: evaluationRequest.protocolHash,
      oneUseRequest: {
        requestId: evaluationRequest.requestId,
        requestHash: hashEvaluationRequest(evaluationRequest),
        dispositionAttestationHash: HASH_A,
        reuseProhibited: true,
      },
      payload: {
        kind: "validation",
        disposition: "promote",
        matchedTaskCount: 12,
        validFreshArmCount: 24,
        invalidArmTotal: 0,
        stratumCount: 2,
        pairOutcomeTotals: {
          bothPass: 4,
          challengerOnlyPass: 5,
          championOnlyPass: 0,
          bothFail: 3,
        },
        weightedAccuracy: {
          medianDelta: 0.2,
          credibleInterval: { lower: 0.05, upper: 0.4 },
          probabilityPositive: 0.99,
        },
        requiredPosteriorProbability: 0.98,
        onlineGateAuthorized: true,
        onlineErrorBudget: {
          policyVersion: "online-alpha-spending-v1",
          maximumOnlineError: 0.05,
          gateOrdinal: 1,
          alphaSpent: 0.02,
          cumulativeSpentBefore: 0,
          cumulativeSpentAfter: 0.02,
          remainingAfter: 0.03,
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
          inputTokens: 10,
          outputTokens: 10,
          modelUsd: 1,
          sandboxUsd: 0.5,
          totalUsd: 1.5,
          wallTimeMs: 1_000,
        },
      },
      derivation: {
        normalizedOutcomeSetHash: HASH_B,
        cacheAttestationHash: overrides.resultCacheHash ?? cacheHash,
        behavioralAggregateHash: null,
        rawArtifacts: {
          exported: false,
          retentionDisposition: "destroyed",
          retentionPolicyHash: HASH_A,
        },
        derivedAt: DERIVED_AT,
      },
      releaseChecks: {
        schemaPassed: true,
        graderCanaryScanPassed: true,
        contentFingerprintScanPassed: true,
        taskIdentityScanPassed: true,
        privacyThresholdPassed: false,
      },
    },
    privateKey,
    overrides.signedAt,
  );
  return {
    result,
    cacheAttestation: cache,
    behavioralRelease: null,
    behavioralEvidence: null,
    failureCards: null,
    diagnosticBrief: null,
  };
}

function diagnosticReleaseBundle(
  evaluationRequest: TrustedEvaluationRequest,
  privateKey: KeyObject,
  legacySourceReference = false,
): ReleasedEvaluationBundle {
  const base = releaseBundle(
    evaluationRequest,
    privateKey,
  ) as ReleasedEvaluationBundle;
  const {
    contentHash: _baseContentHash,
    signature: _baseSignature,
    ...resultBody
  } = base.result;
  const provisionalResult = signedDocument(
    {
      ...resultBody,
      derivation: {
        ...base.result.derivation,
        behavioralAggregateHash: "f".repeat(64),
      },
      releaseChecks: {
        ...base.result.releaseChecks,
        privacyThresholdPassed: true,
      },
    },
    privateKey,
  ) as unknown as SignedResultEnvelope;
  const sourceHash = legacySourceReference
    ? provisionalResult.contentHash
    : resultEnvelopeBehavioralSourceCommitmentHash(
        provisionalResult,
      );
  const policyVersions = {
    protocol: "protocol-v1",
    broker: "broker-v1",
    extraction: "extraction-v1",
    statistics: "statistics-v1",
    privacy: "privacy-v1",
    weighting: "weighting-v1",
    cache: "cache-v1",
    repeatedTesting: "testing-v1",
    leakScanner: "scanner-v1",
  };
  const support = {
    distinctTaskCountBand: "10-19" as const,
    trajectoryCountBand: "20-39" as const,
    minimumComparedGroupSizeBand: "10-19" as const,
    complementaryCountSuppressionPassed: true,
    differencingBudgetPassed: true,
  };
  const evidence = withContentHash({
    schemaVersion: "1.0.0",
    createdAt: DERIVED_AT,
    provenanceRefs: [],
    experimentNumber: 1,
    sourceEnvelopeHash: sourceHash,
    protocolHash: evaluationRequest.protocolHash,
    policyVersions,
    analysisWindow: {
      openedAt: SUBMITTED_AT,
      closedAt: DERIVED_AT,
      support,
    },
    metrics: [],
    suppressedFindingCountBand: "0" as const,
    releaseChecksPassed: true,
    derivationHash: HASH_A,
  }) as BehavioralEvidence;
  const cards = withContentHash({
    schemaVersion: "1.0.0",
    createdAt: DERIVED_AT,
    provenanceRefs: [],
    experimentNumber: 1,
    behavioralEvidenceHash: evidence.contentHash,
    cards: [],
    suppressionApplied: true,
    policyVersions,
  }) as FailureCards;
  const brief = withContentHash({
    schemaVersion: "1.0.0",
    createdAt: DERIVED_AT,
    provenanceRefs: [],
    experimentNumber: 1,
    releaseId: "diagnostic-001",
    sourceExperimentNumber: 1,
    aggregateEvidenceHash: evidence.contentHash,
    failureCardsHash: cards.contentHash,
    policyVersions,
    status: "no-actionable-evidence" as const,
    cards: [],
    limitations: ["No statistically supported generic pattern was released."],
    oneUse: true as const,
    expiresAt: "2026-07-26T14:00:00.000Z",
  }) as DiagnosticBrief;
  const release = signedDocument(
    {
      schemaVersion: "1.0.0",
      createdAt: DERIVED_AT,
      provenanceRefs: [],
      releaseId: brief.releaseId,
      experimentNumber: 1,
      sourceResultEnvelopeHash: sourceHash,
      protocolHash: evaluationRequest.protocolHash,
      policyVersions,
      support,
      aggregateArtifactHashes: {
        behavioralEvidence: evidence.contentHash,
        failureCards: cards.contentHash,
        diagnosticBrief: brief.contentHash,
      },
      suppressedFindingCountBand: "0",
      releaseOnce: true,
    },
    privateKey,
  ) as unknown as SignedBehavioralRelease;
  const result = signedDocument(
    {
      ...resultBody,
      derivation: {
        ...base.result.derivation,
        behavioralAggregateHash: release.contentHash,
      },
      releaseChecks: {
        ...base.result.releaseChecks,
        privacyThresholdPassed: true,
      },
    },
    privateKey,
  ) as unknown as SignedResultEnvelope;
  return {
    result,
    cacheAttestation: base.cacheAttestation,
    behavioralRelease: release,
    behavioralEvidence: evidence,
    failureCards: cards,
    diagnosticBrief: brief,
  };
}

class StaticKeyring implements CanonicalEvaluatorKeyring {
  public constructor(private readonly key: KeyObject) {}

  public getVerificationKey(keyId: string): Promise<KeyObject | undefined> {
    return Promise.resolve(keyId === "evaluator-key-1" ? this.key : undefined);
  }
}

class StaticTransport implements CanonicalEvaluatorTransport {
  public calls = 0;

  public constructor(private readonly response: unknown) {}

  public submit(): Promise<unknown> {
    this.calls += 1;
    return Promise.resolve(this.response);
  }
}

function client(response: unknown, publicKey: KeyObject): {
  readonly evaluator: CanonicalEvaluatorClient;
  readonly transport: StaticTransport;
} {
  const transport = new StaticTransport(response);
  return {
    evaluator: new CanonicalEvaluatorClient({
      endpoint: "https://trusted-evaluator.example.test/v1",
      credentialEnvironmentName: "DF_EVALUATOR_TOKEN",
      transport,
      keyring: new StaticKeyring(publicKey),
      replayLedger: new EphemeralCanonicalEvaluatorReplayLedger(),
      now: () => NOW,
    }),
    transport,
  };
}

describe("canonical evaluator client", () => {
  it("accepts an authenticated, linked, fresh, release-safe bundle", async () => {
    const evaluationRequest = request();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { evaluator } = client(
      releaseBundle(evaluationRequest, privateKey),
      publicKey,
    );
    await expect(evaluator.evaluate(evaluationRequest)).resolves.toMatchObject({
      result: {
        payload: { kind: "validation", disposition: "promote" },
        derivation: {
          rawArtifacts: { retentionDisposition: "destroyed" },
        },
      },
    });
  });

  it("accepts the cycle-free behavioral source commitment", async () => {
    const evaluationRequest = request();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { evaluator } = client(
      diagnosticReleaseBundle(evaluationRequest, privateKey),
      publicKey,
    );
    const bundle = await evaluator.evaluate(evaluationRequest);
    expect(bundle.behavioralRelease?.sourceResultEnvelopeHash).toBe(
      resultEnvelopeBehavioralSourceCommitmentHash(bundle.result),
    );
  });

  it("rejects the legacy cyclic full-envelope source reference", async () => {
    const evaluationRequest = request();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { evaluator } = client(
      diagnosticReleaseBundle(
        evaluationRequest,
        privateKey,
        true,
      ),
      publicKey,
    );
    await expect(evaluator.evaluate(evaluationRequest)).rejects.toThrow(
      /hash lineage/u,
    );
  });

  it("burns one-use requests before submission and rejects a replay", async () => {
    const evaluationRequest = request();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { evaluator, transport } = client(
      releaseBundle(evaluationRequest, privateKey),
      publicKey,
    );
    await evaluator.evaluate(evaluationRequest);
    await expect(evaluator.evaluate(evaluationRequest)).rejects.toThrow(
      /already been consumed/u,
    );
    expect(transport.calls).toBe(1);
  });

  it("rejects a signed bundle whose cache lineage does not match", async () => {
    const evaluationRequest = request();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { evaluator } = client(
      releaseBundle(evaluationRequest, privateKey, {
        resultCacheHash: HASH_A,
      }),
      publicKey,
    );
    await expect(evaluator.evaluate(evaluationRequest)).rejects.toThrow(
      /cache attestation/u,
    );
  });

  it("rejects a correctly signed but stale release", async () => {
    const evaluationRequest = request();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { evaluator } = client(
      releaseBundle(evaluationRequest, privateKey, {
        signedAt: "2026-07-26T09:00:00.000Z",
      }),
      publicKey,
    );
    await expect(evaluator.evaluate(evaluationRequest)).rejects.toThrow(
      /timestamp is outside policy/u,
    );
  });
});
