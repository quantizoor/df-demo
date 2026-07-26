import { describe, expect, it, vi } from "vitest";

import type { TrustedCloudArtifactRef } from "../../src/cloud/types.js";
import type { TrustedEvaluationService } from "../../src/evaluator/composition.js";
import {
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "../../src/evaluator/contracts.js";
import {
  ArtifactBackedEvaluationReleaseBundleService,
  evaluationReleaseSignatureVerificationAttestationHash,
  type EvaluationReleaseArtifactPurpose,
  type EvaluationReleaseArtifactQuery,
  type EvaluationReleaseSignatureVerificationRequest,
  type TrustedEvaluationReleaseArtifactReader,
  type TrustedEvaluationReleaseArtifactSource,
  type TrustedEvaluationReleaseSignatureVerifier,
} from "../../src/evaluator/release-bundle-service.js";
import {
  resultEnvelopeBehavioralSourceCommitmentHash,
} from "../../src/evaluator/release-lineage.js";
import type {
  BehavioralEvidence,
  CacheAttestation,
  DiagnosticBrief,
  FailureCards,
} from "../../src/schemas/artifacts.js";
import {
  canonicalHash,
  canonicalJson,
  sha256,
  withContentHash,
} from "../../src/schemas/canonical.js";
import type {
  SignedBehavioralRelease,
  SignedResultEnvelope,
} from "../../src/schemas/trusted.js";

const PROTOCOL_HASH = "a".repeat(64);
const COMPLIANCE_HASH = "b".repeat(64);
const CANDIDATE_COMMIT = "c".repeat(40);
const CHAMPION_COMMIT = "d".repeat(40);
const SUBMITTED_AT = "2026-07-26T10:00:00.000Z";
const CACHE_CLOSED_AT = "2026-07-26T10:05:00.000Z";
const DERIVED_AT = "2026-07-26T10:10:00.000Z";
const EXPIRES_AT = "2026-07-26T12:00:00.000Z";
const NOW = new Date("2026-07-26T11:00:00.000Z");
const SIGNATURE = {
  algorithm: "ed25519" as const,
  keyId: "evaluator-key-1",
  signedAt: DERIVED_AT,
  signature: "A".repeat(86),
};

interface StoredArtifact {
  readonly purpose: EvaluationReleaseArtifactPurpose;
  readonly contentHash: string;
  readonly reference: TrustedCloudArtifactRef;
  readonly raw: string;
}

interface ReleaseFixture {
  readonly request: TrustedEvaluationRequest;
  readonly result: SignedResultEnvelope;
  readonly artifacts: Map<string, StoredArtifact>;
}

function request(): TrustedEvaluationRequest {
  return {
    schemaVersion: 1,
    requestId: "request-001",
    experimentId: "001-generic-recovery",
    runMode: "research",
    stage: "validation",
    submittedAt: SUBMITTED_AT,
    deadlineAt: "2026-07-26T16:00:00.000Z",
    protocolHash: PROTOCOL_HASH,
    complianceManifestHash: COMPLIANCE_HASH,
    candidate: {
      uri: "trusted://harness/candidate",
      commitSha: CANDIDATE_COMMIT,
      treeSha: CANDIDATE_COMMIT,
      archiveSha256: "1".repeat(64),
    },
    champion: {
      uri: "trusted://harness/champion",
      commitSha: CHAMPION_COMMIT,
      treeSha: CHAMPION_COMMIT,
      archiveSha256: "2".repeat(64),
    },
    selection: {
      kind: "fresh-matched-validation",
      taskCount: 12,
      attemptsPerArm: 1,
      pairOrder: "balanced-6-ab-6-ba",
      weightingPolicyHash: "3".repeat(64),
      frozenHypothesisHash: "4".repeat(64),
      hypothesisExclusionAttestationHash: "5".repeat(64),
    },
    executionProfile: {
      provider: "daytona",
      imageDigest: `sha256:${"6".repeat(64)}`,
      regionClass: "eu-standard",
      resources: {
        architecture: "x86_64",
        cpuCores: 4,
        memoryMiB: 8_192,
        diskMiB: 20_000,
      },
      networkPolicyHash: "7".repeat(64),
      protocolHash: PROTOCOL_HASH,
    },
    evaluatedModel: {
      provider: "openai",
      modelId: "gpt-5.6",
      thinkingLevel: "high",
    },
  };
}

function cacheAttestation(): CacheAttestation {
  return withContentHash({
    schemaVersion: "1.0.0",
    createdAt: SUBMITTED_AT,
    provenanceRefs: [],
    experimentNumber: 1,
    cachePolicyVersion: "cache-v1",
    protocolHash: PROTOCOL_HASH,
    aggregateUseStatus: "not-used",
    freshnessAgeBands: [],
    driftStatus: "not-applicable",
    smallCountSuppressionApplied: true,
    sealedWindow: {
      openedAt: SUBMITTED_AT,
      closedAt: CACHE_CLOSED_AT,
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
    derivationHash: "8".repeat(64),
    signature: SIGNATURE,
  }) as CacheAttestation;
}

function resultEnvelope(
  evaluationRequest: TrustedEvaluationRequest,
  cacheHash: string,
  behavioralAggregateHash: string | null,
): SignedResultEnvelope {
  return withContentHash({
    schemaVersion: "1.0.0",
    createdAt: SUBMITTED_AT,
    provenanceRefs: [],
    envelopeId: "envelope-001",
    experimentNumber: 1,
    mode: "research" as const,
    protocolHash: PROTOCOL_HASH,
    oneUseRequest: {
      requestId: evaluationRequest.requestId,
      requestHash: hashEvaluationRequest(evaluationRequest),
      dispositionAttestationHash: "9".repeat(64),
      reuseProhibited: true as const,
    },
    payload: {
      kind: "validation" as const,
      disposition: "promote" as const,
      matchedTaskCount: 12 as const,
      validFreshArmCount: 24 as const,
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
        policyVersion: "online-alpha-spending-v1" as const,
        maximumOnlineError: 0.05,
        gateOrdinal: 1,
        alphaSpent: 0.02,
        cumulativeSpentBefore: 0,
        cumulativeSpentAfter: 0.02,
        remainingAfter: 0.03,
        reservationHash: "a".repeat(64),
        priorStateHash: "b".repeat(64),
        resultingStateHash: "c".repeat(64),
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
        modelUsd: 2,
        sandboxUsd: 1,
        totalUsd: 3,
        wallTimeMs: 2_000,
      },
    },
    derivation: {
      normalizedOutcomeSetHash: "d".repeat(64),
      cacheAttestationHash: cacheHash,
      behavioralAggregateHash,
      rawArtifacts: {
        exported: false as const,
        retentionDisposition: "destroyed" as const,
        retentionPolicyHash: "e".repeat(64),
      },
      derivedAt: DERIVED_AT,
    },
    releaseChecks: {
      schemaPassed: true as const,
      graderCanaryScanPassed: true as const,
      contentFingerprintScanPassed: true as const,
      taskIdentityScanPassed: true as const,
      privacyThresholdPassed: behavioralAggregateHash !== null,
    },
    signature: SIGNATURE,
  }) as SignedResultEnvelope;
}

function artifact(
  purpose: EvaluationReleaseArtifactPurpose,
  document: { readonly contentHash: string },
): StoredArtifact {
  const raw = `${canonicalJson(document)}\n`;
  return {
    purpose,
    contentHash: document.contentHash,
    reference: {
      uri: `trusted://evaluation-release/${purpose}/${document.contentHash}`,
      sha256: sha256(raw),
      mediaType: "application/json",
      byteLength: Buffer.byteLength(raw, "utf8"),
    },
    raw,
  };
}

function fixture(input: {
  readonly diagnostics: boolean;
  readonly legacySourceReference?: boolean;
}): ReleaseFixture {
  const evaluationRequest = request();
  const cache = cacheAttestation();
  const artifacts = new Map<string, StoredArtifact>();
  const store = (value: StoredArtifact): void => {
    artifacts.set(`${value.purpose}:${value.contentHash}`, value);
  };
  store(artifact("cache-attestation", cache));
  if (!input.diagnostics) {
    return {
      request: evaluationRequest,
      result: resultEnvelope(evaluationRequest, cache.contentHash, null),
      artifacts,
    };
  }

  const provisionalResult = resultEnvelope(
    evaluationRequest,
    cache.contentHash,
    "f".repeat(64),
  );
  const sourceHash = input.legacySourceReference
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
    protocolHash: PROTOCOL_HASH,
    policyVersions,
    analysisWindow: {
      openedAt: SUBMITTED_AT,
      closedAt: DERIVED_AT,
      support,
    },
    metrics: [],
    suppressedFindingCountBand: "0" as const,
    releaseChecksPassed: true,
    derivationHash: "1".repeat(64),
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
    expiresAt: EXPIRES_AT,
  }) as DiagnosticBrief;
  const release = withContentHash({
    schemaVersion: "1.0.0",
    createdAt: DERIVED_AT,
    provenanceRefs: [],
    releaseId: brief.releaseId,
    experimentNumber: 1,
    sourceResultEnvelopeHash: sourceHash,
    protocolHash: PROTOCOL_HASH,
    policyVersions,
    support,
    aggregateArtifactHashes: {
      behavioralEvidence: evidence.contentHash,
      failureCards: cards.contentHash,
      diagnosticBrief: brief.contentHash,
    },
    suppressedFindingCountBand: "0" as const,
    releaseOnce: true as const,
    signature: SIGNATURE,
  }) as SignedBehavioralRelease;
  store(artifact("behavioral-release", release));
  store(artifact("behavioral-evidence", evidence));
  store(artifact("failure-cards", cards));
  store(artifact("diagnostic-brief", brief));
  const result = resultEnvelope(
    evaluationRequest,
    cache.contentHash,
    release.contentHash,
  );
  return { request: evaluationRequest, result, artifacts };
}

function dependencies(value: ReleaseFixture): {
  readonly service: TrustedEvaluationService;
  readonly source: TrustedEvaluationReleaseArtifactSource;
  readonly reader: TrustedEvaluationReleaseArtifactReader;
  readonly verifier: TrustedEvaluationReleaseSignatureVerifier;
  readonly evaluate: ReturnType<typeof vi.fn>;
  readonly locate: ReturnType<typeof vi.fn>;
  readonly readUtf8: ReturnType<typeof vi.fn>;
  readonly verify: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn(async () => value.result);
  const locate = vi.fn(async (query: EvaluationReleaseArtifactQuery) => {
    return value.artifacts.get(`${query.purpose}:${query.contentHash}`)
      ?.reference;
  });
  const readUtf8 = vi.fn(async (reference: TrustedCloudArtifactRef) => {
    return [...value.artifacts.values()].find(
      (entry) => entry.reference.uri === reference.uri,
    )?.raw ?? "";
  });
  const verify = vi.fn(
    async (input: EvaluationReleaseSignatureVerificationRequest) => {
      const keyVersion = `${input.purpose}-2026-07`;
      return {
        schemaVersion: 1 as const,
        domain:
          "dark-factory.evaluation-release-signature-verification.v1" as const,
        purpose: input.purpose,
        documentHash: input.documentHash,
        keyId: input.keyId,
        keyVersion,
        signedAt: input.signedAt,
        verifierAttestationHash:
          evaluationReleaseSignatureVerificationAttestationHash({
            purpose: input.purpose,
            documentHash: input.documentHash,
            keyId: input.keyId,
            keyVersion,
            signedAt: input.signedAt,
          }),
        verified: true as const,
      };
    },
  );
  return {
    service: {
      boundary: "trusted-cloud-evaluator-service",
      evaluate,
    },
    source: {
      boundary: "trusted-cloud",
      locate,
    },
    reader: {
      boundary: "trusted-cloud",
      readUtf8,
    },
    verifier: {
      boundary:
        "trusted-cloud-evaluation-release-signature-verifier",
      verify,
    },
    evaluate,
    locate,
    readUtf8,
    verify,
  };
}

function releaseService(
  value: ReleaseFixture,
  override?: Partial<ReturnType<typeof dependencies>>,
): {
  readonly evaluator: ArtifactBackedEvaluationReleaseBundleService;
  readonly ports: ReturnType<typeof dependencies>;
} {
  const ports = { ...dependencies(value), ...override };
  return {
    evaluator: new ArtifactBackedEvaluationReleaseBundleService({
      service: ports.service,
      source: ports.source,
      reader: ports.reader,
      signatureVerifier: ports.verifier,
      now: () => NOW,
    }),
    ports,
  };
}

describe("artifact-backed evaluation release bundle service", () => {
  it("assembles the committed atomic bundle with purpose-aware verification", async () => {
    const value = fixture({ diagnostics: true });
    const { evaluator, ports } = releaseService(value);

    const [first, concurrentReplay] = await Promise.all([
      evaluator.evaluate(value.request),
      evaluator.evaluate(value.request),
    ]);
    const originalJson = canonicalJson(first);
    expect(canonicalJson(concurrentReplay)).toBe(originalJson);
    (
      first.result as unknown as {
        envelopeId: string;
      }
    ).envelopeId = "caller-mutated";
    const replay = await evaluator.evaluate(value.request);

    expect(canonicalJson(replay)).toBe(originalJson);
    const queries = ports.locate.mock.calls
      .slice(0, 5)
      .map(([input]) => input as EvaluationReleaseArtifactQuery);
    expect(queries.map((query) => query.purpose)).toEqual([
      "cache-attestation",
      "behavioral-release",
      "behavioral-evidence",
      "failure-cards",
      "diagnostic-brief",
    ]);
    for (const query of queries) {
      const { queryHash, ...unsigned } = query;
      expect(Object.keys(query).sort()).toEqual([
        "contentHash",
        "domain",
        "purpose",
        "queryHash",
        "schemaVersion",
      ]);
      expect(queryHash).toBe(canonicalHash(unsigned));
    }
    expect(
      ports.verify.mock.calls
        .slice(0, 3)
        .map(
          ([input]) =>
            (input as EvaluationReleaseSignatureVerificationRequest)
              .purpose,
        ),
    ).toEqual([
      "result-envelope",
      "cache-attestation",
      "behavioral-release",
    ]);
    expect(
      resultEnvelopeBehavioralSourceCommitmentHash(replay.result),
    ).toBe(
      replay.behavioralRelease?.sourceResultEnvelopeHash,
    );
    expect(ports.evaluate).toHaveBeenCalledTimes(2);
  });

  it("returns only the cache artifact when the result commits no diagnostics", async () => {
    const value = fixture({ diagnostics: false });
    const { evaluator, ports } = releaseService(value);

    await expect(evaluator.evaluate(value.request)).resolves.toMatchObject({
      behavioralRelease: null,
      behavioralEvidence: null,
      failureCards: null,
      diagnosticBrief: null,
    });
    expect(ports.locate).toHaveBeenCalledTimes(1);
    expect(
      ports.verify.mock.calls.map(
        ([input]) =>
          (input as EvaluationReleaseSignatureVerificationRequest)
            .purpose,
      ),
    ).toEqual(["result-envelope", "cache-attestation"]);
  });

  it("fails closed when a completed request replays different release bytes", async () => {
    const value = fixture({ diagnostics: false });
    const {
      contentHash: _contentHash,
      ...resultWithoutContentHash
    } = value.result;
    const changedResult = withContentHash({
      ...resultWithoutContentHash,
      envelopeId: "envelope-replayed-differently",
    }) as SignedResultEnvelope;
    const ports = dependencies(value);
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(value.result)
      .mockResolvedValueOnce(changedResult);
    const evaluator = new ArtifactBackedEvaluationReleaseBundleService({
      service: {
        boundary: "trusted-cloud-evaluator-service",
        evaluate,
      },
      source: ports.source,
      reader: ports.reader,
      signatureVerifier: ports.verifier,
      now: () => NOW,
    });

    await expect(evaluator.evaluate(value.request)).resolves.toBeDefined();
    await expect(evaluator.evaluate(value.request)).rejects.toThrow(
      "failed closed",
    );
  });

  it("rejects legacy full-envelope source references and partial releases", async () => {
    const legacy = fixture({
      diagnostics: true,
      legacySourceReference: true,
    });
    const legacyService = releaseService(legacy).evaluator;
    await expect(legacyService.evaluate(legacy.request)).rejects.toThrow(
      "failed closed",
    );

    const partial = fixture({ diagnostics: true });
    const release = [...partial.artifacts.values()].find(
      (entry) => entry.purpose === "diagnostic-brief",
    );
    if (release === undefined) throw new Error("Missing test brief");
    partial.artifacts.delete(
      `${release.purpose}:${release.contentHash}`,
    );
    await expect(
      releaseService(partial).evaluator.evaluate(partial.request),
    ).rejects.toThrow("failed closed");
  });

  it("rejects byte-valid but noncanonical JSON and forged verifier receipts", async () => {
    const noncanonical = fixture({ diagnostics: false });
    const cache = [...noncanonical.artifacts.values()][0];
    if (cache === undefined) throw new Error("Missing test cache");
    const parsed = JSON.parse(cache.raw) as Readonly<Record<string, unknown>>;
    const raw = `${JSON.stringify(parsed, null, 2)}\n`;
    noncanonical.artifacts.set(
      `${cache.purpose}:${cache.contentHash}`,
      {
        ...cache,
        raw,
        reference: {
          ...cache.reference,
          sha256: sha256(raw),
          byteLength: Buffer.byteLength(raw, "utf8"),
        },
      },
    );
    await expect(
      releaseService(noncanonical).evaluator.evaluate(noncanonical.request),
    ).rejects.toThrow("failed closed");

    const forged = fixture({ diagnostics: false });
    const ports = dependencies(forged);
    const verify = vi.fn(
      async (input: EvaluationReleaseSignatureVerificationRequest) => ({
        schemaVersion: 1 as const,
        domain:
          "dark-factory.evaluation-release-signature-verification.v1" as const,
        purpose: input.purpose,
        documentHash: input.documentHash,
        keyId: input.keyId,
        keyVersion: "wrong-version",
        signedAt: input.signedAt,
        verifierAttestationHash: "f".repeat(64),
        verified: true as const,
      }),
    );
    const evaluator = new ArtifactBackedEvaluationReleaseBundleService({
      service: ports.service,
      source: ports.source,
      reader: ports.reader,
      signatureVerifier: {
        boundary:
          "trusted-cloud-evaluation-release-signature-verifier",
        verify,
      },
      now: () => NOW,
    });
    await expect(evaluator.evaluate(forged.request)).rejects.toThrow(
      "failed closed",
    );
  });

  it("captures methods and detects dependency mutation of sealed inputs", async () => {
    const captured = fixture({ diagnostics: false });
    const capturedPorts = dependencies(captured);
    const evaluator = new ArtifactBackedEvaluationReleaseBundleService({
      service: capturedPorts.service,
      source: capturedPorts.source,
      reader: capturedPorts.reader,
      signatureVerifier: capturedPorts.verifier,
      now: () => NOW,
    });
    (
      capturedPorts.source as unknown as {
        locate: () => Promise<undefined>;
      }
    ).locate = async () => undefined;
    await expect(evaluator.evaluate(captured.request)).resolves.toMatchObject({
      result: { envelopeId: "envelope-001" },
    });

    const mutated = fixture({ diagnostics: false });
    const ports = dependencies(mutated);
    const mutatingLocate = vi.fn(
      async (query: EvaluationReleaseArtifactQuery) => {
        const reference = mutated.artifacts.get(
          `${query.purpose}:${query.contentHash}`,
        )?.reference;
        (
          query as unknown as {
            purpose: EvaluationReleaseArtifactPurpose;
          }
        ).purpose = "diagnostic-brief";
        return reference;
      },
    );
    const mutatingEvaluator =
      new ArtifactBackedEvaluationReleaseBundleService({
        service: ports.service,
        source: {
          boundary: "trusted-cloud",
          locate: mutatingLocate,
        },
        reader: ports.reader,
        signatureVerifier: ports.verifier,
        now: () => NOW,
      });
    await expect(
      mutatingEvaluator.evaluate(mutated.request),
    ).rejects.toThrow("failed closed");

    const verifierMutation = fixture({ diagnostics: false });
    const verifierPorts = dependencies(verifierMutation);
    const mutatingVerify = vi.fn(
      async (
        input: EvaluationReleaseSignatureVerificationRequest,
      ) => {
        const response = await verifierPorts.verify(input);
        (
          input as unknown as {
            purpose: "cache-attestation";
          }
        ).purpose = "cache-attestation";
        return response;
      },
    );
    const verifierMutationEvaluator =
      new ArtifactBackedEvaluationReleaseBundleService({
        service: verifierPorts.service,
        source: verifierPorts.source,
        reader: verifierPorts.reader,
        signatureVerifier: {
          boundary:
            "trusted-cloud-evaluation-release-signature-verifier",
          verify: mutatingVerify,
        },
        now: () => NOW,
      });
    await expect(
      verifierMutationEvaluator.evaluate(verifierMutation.request),
    ).rejects.toThrow("failed closed");
  });
});
