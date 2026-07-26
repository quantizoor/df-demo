import { describe, expect, it, vi } from "vitest";

import type { ExperimentIdentity } from "../../src/domain/models.js";
import type { ReleasedEvaluationBundle } from "../../src/evaluator/canonical-client.js";
import { hashEvaluationRequest } from "../../src/evaluator/contracts.js";
import { resultEnvelopeBehavioralSourceCommitmentHash } from "../../src/evaluator/release-lineage.js";
import {
  type AtomicBlindBrokerLeaseStore,
  type DurableBlindBrokerLeaseState,
  emptyBlindBrokerLeaseState,
  ProductionBlindBroker,
  type ProductionBlindBrokerOptions,
} from "../../src/orchestrator/blind-broker.js";
import type {
  BehavioralEvidence,
  CacheAttestation,
  DiagnosticBrief,
  FailureCards,
} from "../../src/schemas/artifacts.js";
import { withContentHash } from "../../src/schemas/canonical.js";
import type { SignedBehavioralRelease, SignedResultEnvelope } from "../../src/schemas/trusted.js";

const PROTOCOL = "a".repeat(64);
const COMPLIANCE = "b".repeat(64);
const WEIGHTING = "c".repeat(64);
const CANDIDATE = "d".repeat(40);
const CHAMPION = "e".repeat(40);
const NOW = new Date("2026-07-26T10:00:00.000Z");
const SIGNATURE = {
  algorithm: "ed25519" as const,
  keyId: "evaluator-key-1",
  signedAt: "2026-07-26T10:10:00.000Z",
  signature: "A".repeat(86),
};

class AtomicMemoryLeaseStore implements AtomicBlindBrokerLeaseStore {
  state: DurableBlindBrokerLeaseState = emptyBlindBrokerLeaseState();

  public transact<Result>(
    operation: (state: DurableBlindBrokerLeaseState) => {
      readonly next: DurableBlindBrokerLeaseState;
      readonly result: Result;
    },
  ): Promise<Result> {
    const transaction = operation(this.state);
    this.state = transaction.next;
    return Promise.resolve(transaction.result);
  }
}

function experiment(number = 2): ExperimentIdentity {
  return {
    number,
    slug: "generic-recovery",
    kind: "optimization",
    parentExperiment: number - 1,
    lineageId: "lineage-v1",
    protocolHash: PROTOCOL,
  };
}

function cacheAttestation(experimentNumber: number): CacheAttestation {
  return withContentHash({
    schemaVersion: "1.0.0",
    createdAt: "2026-07-26T10:00:00.000Z",
    provenanceRefs: [],
    experimentNumber,
    cachePolicyVersion: "cache-v1",
    protocolHash: PROTOCOL,
    aggregateUseStatus: "not-used",
    freshnessAgeBands: [],
    driftStatus: "not-applicable",
    smallCountSuppressionApplied: true,
    sealedWindow: {
      openedAt: "2026-07-26T10:00:00.000Z",
      closedAt: "2026-07-26T10:05:00.000Z",
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
    derivationHash: "1".repeat(64),
    signature: SIGNATURE,
  }) as CacheAttestation;
}

function releaseFor(
  request: Parameters<ProductionBlindBrokerOptions["evaluator"]["evaluate"]>[0],
  invalidArmTotal = 0,
  withDiagnostics = false,
  legacyDiagnosticSource = false,
): ReleasedEvaluationBundle {
  const cache = cacheAttestation(request.experimentId.startsWith("002-") ? 2 : 1);
  const payload: SignedResultEnvelope["payload"] =
    request.stage === "repair"
      ? {
          kind: "repair",
          disposition: "passed",
          attemptOrdinal: 1,
          integrityStatus: "passed",
          aggregateCost: {
            inputTokens: 10,
            outputTokens: 5,
            modelUsd: 1,
            sandboxUsd: 0.5,
            totalUsd: 1.5,
            wallTimeMs: 1_000,
          },
          policyAttestationHash: "2".repeat(64),
        }
      : {
          kind: "validation",
          disposition: "promote",
          matchedTaskCount: 12,
          validFreshArmCount: 24,
          invalidArmTotal,
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
            modelUsd: 2,
            sandboxUsd: 1,
            totalUsd: 3,
            wallTimeMs: 2_000,
          },
        };
  const behavioralReleaseAlias =
    request.stage === "validation" && withDiagnostics ? "f".repeat(64) : null;
  let result = withContentHash({
    schemaVersion: "1.0.0",
    createdAt: "2026-07-26T10:00:00.000Z",
    provenanceRefs: [],
    envelopeId: `envelope-${request.requestId}`,
    experimentNumber: Number.parseInt(request.experimentId, 10),
    mode: "research" as const,
    protocolHash: PROTOCOL,
    oneUseRequest: {
      requestId: request.requestId,
      requestHash: hashEvaluationRequest(request),
      dispositionAttestationHash: "3".repeat(64),
      reuseProhibited: true as const,
    },
    payload,
    derivation: {
      normalizedOutcomeSetHash: "4".repeat(64),
      cacheAttestationHash: cache.contentHash,
      behavioralAggregateHash: behavioralReleaseAlias,
      rawArtifacts: {
        exported: false as const,
        retentionDisposition: "destroyed" as const,
        retentionPolicyHash: "5".repeat(64),
      },
      derivedAt: "2026-07-26T10:10:00.000Z",
    },
    releaseChecks: {
      schemaPassed: true as const,
      graderCanaryScanPassed: true as const,
      contentFingerprintScanPassed: true as const,
      taskIdentityScanPassed: true as const,
      privacyThresholdPassed: behavioralReleaseAlias !== null,
    },
    signature: SIGNATURE,
  }) as SignedResultEnvelope;
  if (behavioralReleaseAlias !== null) {
    const behavioralSourceHash = legacyDiagnosticSource
      ? result.contentHash
      : resultEnvelopeBehavioralSourceCommitmentHash(result);
    const policies = {
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
      createdAt: "2026-07-26T10:10:00.000Z",
      provenanceRefs: [],
      experimentNumber: result.experimentNumber,
      sourceEnvelopeHash: behavioralSourceHash,
      protocolHash: PROTOCOL,
      policyVersions: policies,
      analysisWindow: {
        openedAt: "2026-07-26T10:00:00.000Z",
        closedAt: "2026-07-26T10:10:00.000Z",
        support,
      },
      metrics: [],
      suppressedFindingCountBand: "0",
      releaseChecksPassed: true,
      derivationHash: "6".repeat(64),
    }) as BehavioralEvidence;
    const cards = withContentHash({
      schemaVersion: "1.0.0",
      createdAt: "2026-07-26T10:10:00.000Z",
      provenanceRefs: [],
      experimentNumber: result.experimentNumber,
      behavioralEvidenceHash: evidence.contentHash,
      cards: [],
      suppressionApplied: true,
      policyVersions: policies,
    }) as FailureCards;
    const brief = withContentHash({
      schemaVersion: "1.0.0",
      createdAt: "2026-07-26T10:10:00.000Z",
      provenanceRefs: [],
      experimentNumber: result.experimentNumber,
      releaseId: `diagnostic-${String(result.experimentNumber)}`,
      sourceExperimentNumber: result.experimentNumber,
      aggregateEvidenceHash: evidence.contentHash,
      failureCardsHash: cards.contentHash,
      policyVersions: policies,
      status: "no-actionable-evidence",
      cards: [],
      limitations: ["No statistically supported generic failure card was available."],
      oneUse: true,
      expiresAt: "2026-07-26T12:00:00.000Z",
    }) as DiagnosticBrief;
    const behavioralRelease = withContentHash({
      schemaVersion: "1.0.0",
      createdAt: "2026-07-26T10:10:00.000Z",
      provenanceRefs: [],
      releaseId: brief.releaseId,
      experimentNumber: result.experimentNumber,
      sourceResultEnvelopeHash: behavioralSourceHash,
      protocolHash: PROTOCOL,
      policyVersions: policies,
      support,
      aggregateArtifactHashes: {
        behavioralEvidence: evidence.contentHash,
        failureCards: cards.contentHash,
        diagnosticBrief: brief.contentHash,
      },
      suppressedFindingCountBand: "0",
      releaseOnce: true,
      signature: SIGNATURE,
    }) as SignedBehavioralRelease;
    const { contentHash: _provisionalContentHash, ...resultWithoutContentHash } = result;
    result = withContentHash({
      ...resultWithoutContentHash,
      derivation: {
        ...result.derivation,
        behavioralAggregateHash: behavioralRelease.contentHash,
      },
    }) as SignedResultEnvelope;
    return {
      result,
      cacheAttestation: cache,
      behavioralRelease,
      behavioralEvidence: evidence,
      failureCards: cards,
      diagnosticBrief: brief,
    };
  }
  return {
    result,
    cacheAttestation: cache,
    behavioralRelease: null,
    behavioralEvidence: null,
    failureCards: null,
    diagnosticBrief: null,
  };
}

function dependencies(input: {
  readonly store?: AtomicMemoryLeaseStore;
  readonly signatureValid?: boolean;
  readonly invalidArmTotal?: number;
  readonly withDiagnostics?: boolean;
  readonly legacyDiagnosticSource?: boolean;
  readonly diagnosticPublishFailures?: number;
}) {
  const store = input.store ?? new AtomicMemoryLeaseStore();
  const requests: Parameters<ProductionBlindBrokerOptions["evaluator"]["evaluate"]>[0][] = [];
  let tokenOrdinal = 0;
  const evaluator = {
    evaluate: vi.fn(async (request) => {
      requests.push(request);
      return releaseFor(
        request,
        input.invalidArmTotal,
        input.withDiagnostics,
        input.legacyDiagnosticSource,
      );
    }),
  };
  let diagnosticPublishFailures = input.diagnosticPublishFailures ?? 0;
  const options: ProductionBlindBrokerOptions = {
    store,
    configurations: {
      resolve: async () => ({
        runMode: "research",
        complianceManifestHash: COMPLIANCE,
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
          protocolHash: PROTOCOL,
        },
        evaluatedModel: {
          provider: "openai",
          modelId: "gpt-5.6",
          thinkingLevel: "high",
        },
        weightingPolicyHash: WEIGHTING,
        requestTtlMs: 60 * 60_000,
      }),
    },
    artifacts: {
      resolve: async (commit) => ({
        uri: `trusted://harness/${commit}`,
        commitSha: commit,
        treeSha: commit,
        archiveSha256: commit === CANDIDATE ? "8".repeat(64) : "9".repeat(64),
      }),
    },
    repairDiscovery: {
      resolve: async ({ discoveryAttestationHash }) => ({
        sourceExperimentId: "001-source",
        discoveryAttestationHash,
      }),
    },
    evaluator,
    signatureVerifier: {
      verify: vi.fn(async () => input.signatureValid ?? true),
    },
    diagnosticPublisher: {
      publishOnce: vi.fn(async ({ diagnosticBrief }) => {
        if (diagnosticPublishFailures > 0) {
          diagnosticPublishFailures -= 1;
          throw new Error("transient publication failure");
        }
        return {
          hash: diagnosticBrief.contentHash,
          releaseId: diagnosticBrief.releaseId,
          actionable: diagnosticBrief.status === "actionable-evidence",
        };
      }),
    },
    now: () => NOW,
    leaseTokenFactory: () => {
      tokenOrdinal += 1;
      return `lease-production-test-${String(tokenOrdinal).padStart(4, "0")}`;
    },
  };
  return { broker: new ProductionBlindBroker(options), store, evaluator, requests };
}

describe("production blind broker adapter", () => {
  it("runs a matched repair once, burns it automatically, and conservatively charges its seal", async () => {
    const fixture = dependencies({});
    const identity = experiment();
    const lease = await fixture.broker.prepareRepair({
      experiment: identity,
      hypothesisHash: "0".repeat(64),
      candidateCommit: CANDIDATE,
      previousDiscoveryAttestationHash: "1".repeat(64),
      attemptOrdinal: 1,
    });
    const aggregate = await fixture.broker.runRepair({
      experiment: identity,
      leaseToken: lease.leaseToken,
      candidateCommit: CANDIDATE,
      activeChampionCommit: CHAMPION,
    });

    expect(aggregate).toMatchObject({
      disposition: "passed",
      attempts: 9,
      tokens: 15,
      aggregateCostUsd: 1.5,
    });
    expect(fixture.requests[0]?.selection).toEqual({
      kind: "repair-reuse",
      sourceExperimentId: "001-source",
      taskCount: 5,
      attemptsPerTask: 1,
      candidateAttempt: 1,
      frozenHypothesisHash: "0".repeat(64),
    });
    expect(JSON.stringify({ lease, aggregate })).not.toMatch(/taskId|packageTaskName|grader/u);
    expect(Object.values(fixture.store.state.records)[0]?.disposedOutcome).toBe("decided");

    await expect(
      fixture.broker.runRepair({
        experiment: identity,
        leaseToken: lease.leaseToken,
        candidateCommit: CANDIDATE,
        activeChampionCommit: CHAMPION,
      }),
    ).resolves.toEqual(aggregate);
    await expect(
      fixture.broker.runRepair({
        experiment: identity,
        leaseToken: lease.leaseToken,
        candidateCommit: CANDIDATE,
        activeChampionCommit: "f".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "lease-conflict" });
    expect(fixture.evaluator.evaluate).toHaveBeenCalledOnce();
  });

  it("maps exact signed validation replacements and consumes the lease outcome-independently", async () => {
    const fixture = dependencies({ invalidArmTotal: 2 });
    const identity = experiment(1);
    const lease = await fixture.broker.prepareValidation({
      experiment: identity,
      hypothesisHash: "0".repeat(64),
      candidateCommit: CANDIDATE,
      excludedEvidenceHashes: ["1".repeat(64), "2".repeat(64)],
      remainingExperimentAttempts: 38,
      diagnosticReleaseAuthorized: true,
    });
    const aggregate = await fixture.broker.runValidation({
      experiment: identity,
      leaseToken: lease.leaseToken,
      candidateCommit: CANDIDATE,
      activeChampionCommit: CHAMPION,
    });
    expect(aggregate.replacementAttempts).toBe(2);
    expect(aggregate.attemptAccounting).toMatchObject({
      totalAttemptCount: 26,
      replacementAttemptCount: 2,
      infrastructureFailureCount: 2,
      containsTaskIdentifiers: false,
    });
    const disposed = await fixture.broker.consumeOrQuarantine({
      leaseToken: lease.leaseToken,
      attestationHash: lease.attestationHash,
      outcome: "decided",
    });
    expect(disposed.dispositionAttestationHash).toMatch(/^[a-f0-9]{64}$/u);
    await expect(
      fixture.broker.releaseDiagnosticBrief({
        experiment: identity,
        validationAttestationHash: aggregate.attestationHash,
        releaseAuthorized: true,
      }),
    ).resolves.toBeNull();
  });

  it("fails a bad signature closed and permits only started-abandoned quarantine", async () => {
    const fixture = dependencies({ signatureValid: false });
    const identity = experiment(1);
    const lease = await fixture.broker.prepareValidation({
      experiment: identity,
      hypothesisHash: "0".repeat(64),
      candidateCommit: CANDIDATE,
      excludedEvidenceHashes: [],
      remainingExperimentAttempts: 28,
      diagnosticReleaseAuthorized: false,
    });
    await expect(
      fixture.broker.runValidation({
        experiment: identity,
        leaseToken: lease.leaseToken,
        candidateCommit: CANDIDATE,
        activeChampionCommit: CHAMPION,
      }),
    ).rejects.toMatchObject({ code: "release-invalid" });
    await expect(
      Promise.resolve().then(() =>
        fixture.broker.consumeOrQuarantine({
          leaseToken: lease.leaseToken,
          attestationHash: lease.attestationHash,
          outcome: "decided",
        }),
      ),
    ).rejects.toMatchObject({ code: "lease-state-invalid" });
    await expect(
      fixture.broker.consumeOrQuarantine({
        leaseToken: lease.leaseToken,
        attestationHash: lease.attestationHash,
        outcome: "started-abandoned",
      }),
    ).resolves.toEqual({
      dispositionAttestationHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("publishes a signed, privacy-thresholded diagnostic exactly once after decided disposal", async () => {
    const fixture = dependencies({ withDiagnostics: true });
    const identity = experiment(1);
    const lease = await fixture.broker.prepareValidation({
      experiment: identity,
      hypothesisHash: "0".repeat(64),
      candidateCommit: CANDIDATE,
      excludedEvidenceHashes: [],
      remainingExperimentAttempts: 28,
      diagnosticReleaseAuthorized: true,
    });
    const aggregate = await fixture.broker.runValidation({
      experiment: identity,
      leaseToken: lease.leaseToken,
      candidateCommit: CANDIDATE,
      activeChampionCommit: CHAMPION,
    });
    await fixture.broker.consumeOrQuarantine({
      leaseToken: lease.leaseToken,
      attestationHash: lease.attestationHash,
      outcome: "decided",
    });
    const released = await fixture.broker.releaseDiagnosticBrief({
      experiment: identity,
      validationAttestationHash: aggregate.attestationHash,
      releaseAuthorized: true,
    });
    expect(released).toEqual({
      hash: aggregate.releasedEvidenceHash,
      releaseId: "diagnostic-1",
      actionable: false,
    });
    await expect(
      fixture.broker.releaseDiagnosticBrief({
        experiment: identity,
        validationAttestationHash: aggregate.attestationHash,
        releaseAuthorized: true,
      }),
    ).resolves.toEqual(released);
  });

  it("rejects the legacy cyclic full-envelope diagnostic source reference", async () => {
    const fixture = dependencies({
      withDiagnostics: true,
      legacyDiagnosticSource: true,
    });
    const identity = experiment(1);
    const lease = await fixture.broker.prepareValidation({
      experiment: identity,
      hypothesisHash: "0".repeat(64),
      candidateCommit: CANDIDATE,
      excludedEvidenceHashes: [],
      remainingExperimentAttempts: 28,
      diagnosticReleaseAuthorized: true,
    });
    await expect(
      fixture.broker.runValidation({
        experiment: identity,
        leaseToken: lease.leaseToken,
        candidateCommit: CANDIDATE,
        activeChampionCommit: CHAMPION,
      }),
    ).rejects.toMatchObject({ code: "release-invalid" });
  });

  it("burns an unstarted sealed validation without calling the evaluator", async () => {
    const fixture = dependencies({});
    const identity = experiment(1);
    const lease = await fixture.broker.prepareValidation({
      experiment: identity,
      hypothesisHash: "0".repeat(64),
      candidateCommit: CANDIDATE,
      excludedEvidenceHashes: [],
      remainingExperimentAttempts: 28,
      diagnosticReleaseAuthorized: false,
    });
    await fixture.broker.consumeOrQuarantine({
      leaseToken: lease.leaseToken,
      attestationHash: lease.attestationHash,
      outcome: "sealed-unstarted",
    });
    await expect(
      fixture.broker.runValidation({
        experiment: identity,
        leaseToken: lease.leaseToken,
        candidateCommit: CANDIDATE,
        activeChampionCommit: CHAMPION,
      }),
    ).rejects.toMatchObject({ code: "lease-state-invalid" });
    expect(fixture.evaluator.evaluate).not.toHaveBeenCalled();
  });

  it("conservatively quarantines a validation invocation that fails before its durable start claim", async () => {
    const fixture = dependencies({});
    const identity = experiment(1);
    const lease = await fixture.broker.prepareValidation({
      experiment: identity,
      hypothesisHash: "0".repeat(64),
      candidateCommit: CANDIDATE,
      excludedEvidenceHashes: [],
      remainingExperimentAttempts: 28,
      diagnosticReleaseAuthorized: false,
    });
    await expect(
      fixture.broker.runValidation({
        experiment: identity,
        leaseToken: lease.leaseToken,
        candidateCommit: CANDIDATE,
        activeChampionCommit: CANDIDATE,
      }),
    ).rejects.toMatchObject({ code: "lease-invalid" });
    await expect(
      fixture.broker.consumeOrQuarantine({
        leaseToken: lease.leaseToken,
        attestationHash: lease.attestationHash,
        outcome: "started-abandoned",
      }),
    ).resolves.toEqual({
      dispositionAttestationHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("rejects a completed replay against a different champion", async () => {
    const fixture = dependencies({});
    const identity = experiment(1);
    const lease = await fixture.broker.prepareValidation({
      experiment: identity,
      hypothesisHash: "0".repeat(64),
      candidateCommit: CANDIDATE,
      excludedEvidenceHashes: [],
      remainingExperimentAttempts: 28,
      diagnosticReleaseAuthorized: false,
    });
    await fixture.broker.runValidation({
      experiment: identity,
      leaseToken: lease.leaseToken,
      candidateCommit: CANDIDATE,
      activeChampionCommit: CHAMPION,
    });
    await expect(
      fixture.broker.runValidation({
        experiment: identity,
        leaseToken: lease.leaseToken,
        candidateCommit: CANDIDATE,
        activeChampionCommit: "f".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "lease-conflict" });
    expect(fixture.evaluator.evaluate).toHaveBeenCalledOnce();
  });

  it("retries an idempotent diagnostic publication after a transient crash", async () => {
    const fixture = dependencies({
      withDiagnostics: true,
      diagnosticPublishFailures: 1,
    });
    const identity = experiment(1);
    const lease = await fixture.broker.prepareValidation({
      experiment: identity,
      hypothesisHash: "0".repeat(64),
      candidateCommit: CANDIDATE,
      excludedEvidenceHashes: [],
      remainingExperimentAttempts: 28,
      diagnosticReleaseAuthorized: true,
    });
    const aggregate = await fixture.broker.runValidation({
      experiment: identity,
      leaseToken: lease.leaseToken,
      candidateCommit: CANDIDATE,
      activeChampionCommit: CHAMPION,
    });
    await fixture.broker.consumeOrQuarantine({
      leaseToken: lease.leaseToken,
      attestationHash: lease.attestationHash,
      outcome: "decided",
    });
    const release = {
      experiment: identity,
      validationAttestationHash: aggregate.attestationHash,
      releaseAuthorized: true as const,
    };
    await expect(fixture.broker.releaseDiagnosticBrief(release)).rejects.toMatchObject({
      code: "diagnostic-unavailable",
    });
    await expect(fixture.broker.releaseDiagnosticBrief(release)).resolves.toMatchObject({
      hash: aggregate.releasedEvidenceHash,
      releaseId: "diagnostic-1",
    });
  });
});
