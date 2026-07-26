import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  Ed25519ResultEnvelopeIssuer,
  Ed25519ResultEnvelopeVerifier,
} from "../../src/broker/issuer.js";
import {
  DurableOneUseRequestLedger,
  emptyOneUseLedgerState,
  hashOneUseClaimRecoveryAuthorization,
  type AtomicOneUseLedgerStore,
  type BrokerFailureCode,
  type OneUseClaim,
  type OneUseLedgerInspection,
  type OneUseLedgerState,
  type OneUseRequestLedger,
} from "../../src/broker/ledger.js";
import {
  TrustedEvaluationBroker,
  type TrustedCanonicalAggregate,
} from "../../src/broker/service.js";
import {
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "../../src/evaluator/contracts.js";
import {
  hashTrustedBehavioralReleaseOrphanFinalization,
  TrustedBehavioralReleaseProducerError,
  type TrustedBehavioralReleaseFinalization,
  type TrustedBehavioralReleaseOrphanFinalizationReceipt,
  type TrustedPostDestructionBehavioralReleaseProducer,
} from "../../src/evaluator/behavioral-release-producer.js";
import {
  hashTrustedBehavioralPreparation,
  hashTrustedBehavioralPreparationAbandonment,
  hashTrustedBehavioralPreparationFinalization,
  type TrustedBehavioralPreparationStore,
} from "../../src/evaluator/behavioral-preparation-store.js";
import type { TrustedPrivateBehavioralPreparation } from "../../src/evaluator/deriver.js";
import { resultEnvelopeBehavioralSourceCommitmentHash } from "../../src/evaluator/release-lineage.js";
import {
  assertPostDestructionReleaseRecoveryTransition,
  sealPostDestructionReleaseRecoveryRecord,
  type TrustedPostDestructionReleaseRecoveryRecord,
  type TrustedPostDestructionReleaseRecoveryStore,
} from "../../src/evaluator/release-recovery-store.js";
import { createOnlineErrorBudget } from "../../src/evaluation/statistics.js";
import {
  createTrustedOnlineErrorBudgetReservation,
  type TrustedOnlineErrorBudgetAuthority,
} from "../../src/evaluator/online-error-authority.js";
import {
  createSignedRawDestructionReceipt,
  createTrustedRawArtifactManifest,
  type TrustedRawDestructionReceipt,
  type TrustedRawDestructionReceiptVerifier,
  type TrustedRawRetentionPolicy,
} from "../../src/evaluator/retention.js";
import { hashNetworkPolicy } from "../../src/cloud/provider.js";
import { hiddenTaskId } from "../../src/evaluation/types.js";
import {
  DARK_FACTORY_PI_HARBOR_IMPORT_PATH,
  createPiHarborAgentSpec,
} from "../../src/terminal-bench/pi-agent.js";
import type { TrustedRawRun } from "../../src/terminal-bench/runner.js";
import type { TrustedMatchedPanel } from "../../src/terminal-bench/trusted.js";

const HASH = "a".repeat(64);
const SECOND_HASH = "b".repeat(64);

const retentionPolicy: TrustedRawRetentionPolicy = {
  policyHash: "c".repeat(64),
  storageRoot: "trusted://raw/evaluator/",
  maximumRetentionMinutes: 60,
  destruction: "crypto-shred",
  encryptionRequired: true,
  localExportAllowed: false,
};
const rawDestructionKey = generateKeyPairSync("ed25519");
const destructionReceiptVerifier: TrustedRawDestructionReceiptVerifier = {
  trustedKeyId: "raw-destruction-key-1",
  publicKey: rawDestructionKey.publicKey,
};

function request(): TrustedEvaluationRequest {
  const networkPolicyHash = hashNetworkPolicy({
    defaultAction: "deny",
    allowDomains: ["api.model.example.test"],
  });
  return {
    schemaVersion: 1,
    requestId: "request-001",
    experimentId: "001-recovery",
    runMode: "research",
    stage: "validation",
    submittedAt: "2026-07-01T00:00:00.000Z",
    deadlineAt: "2026-07-01T06:00:00.000Z",
    protocolHash: HASH,
    complianceManifestHash: SECOND_HASH,
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
      networkPolicyHash,
      protocolHash: HASH,
    },
    evaluatedModel: {
      provider: "openai",
      modelId: "gpt-5.6",
      thinkingLevel: "high",
    },
  };
}

function panel(): TrustedMatchedPanel {
  return {
    sensitivity: "hidden-benchmark-panel",
    leaseId: "lease-001",
    requestId: "request-001",
    stage: "validation",
    sealedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-07-01T06:00:00.000Z",
    dispositionAttestationHash: "6".repeat(64),
    cells: Array.from({ length: 12 }, (_, index) => ({
      sensitivity: "hidden-benchmark-cell" as const,
      taskId: hiddenTaskId((index + 1).toString(16).padStart(64, "0")),
      taskRevisionDigest: (index + 30).toString(16).padStart(64, "0"),
      capabilityStratum: `stratum-${(index % 3) + 1}`,
      replicateOrdinal: 1,
      order: index % 2 === 0 ? ("AB" as const) : ("BA" as const),
    })),
  };
}

function rawRun(): TrustedRawRun {
  const manifest = createTrustedRawArtifactManifest(retentionPolicy, {
    manifestId: "manifest-001",
    createdAt: "2026-07-01T00:03:00.000Z",
    destroyBy: "2026-07-01T00:30:00.000Z",
    artifacts: [
      {
        kind: "atif",
        uri: "trusted://raw/evaluator/atif.json.enc",
        sha256: "1".repeat(64),
        byteLength: 1_024,
        encrypted: true,
      },
      {
        kind: "grader-output",
        uri: "trusted://raw/evaluator/grader.json.enc",
        sha256: "2".repeat(64),
        byteLength: 2_048,
        encrypted: true,
      },
      {
        kind: "harbor-output",
        uri: "trusted://raw/evaluator/harbor.tar.enc",
        sha256: "0".repeat(64),
        byteLength: 4_096,
        encrypted: true,
      },
    ],
  });
  return {
    sensitivity: "raw-terminal-bench-run",
    requestId: "request-001",
    pinHash: "7".repeat(64),
    jobSha256: "8".repeat(64),
    runtimeAttestationHash: "9".repeat(64),
    executions: [
      {
        provider: "daytona",
        sandboxId: "sandbox-001",
        executionId: "execution-001",
        startedAt: "2026-07-01T00:01:00.000Z",
        finishedAt: "2026-07-01T00:02:00.000Z",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        resourceReport: { peakMemoryMiB: 1024, cpuTimeMs: 30_000 },
      },
    ],
    rawBundles: [
      {
        uri: "trusted://raw/evaluator/bundle",
        sha256: "0".repeat(64),
        mediaType: "application/gzip",
        byteLength: 4_096,
      },
    ],
    manifest,
  };
}

function aggregate(): TrustedCanonicalAggregate {
  const evaluationRequest = request();
  return {
    sensitivity: "trusted-canonical-aggregate",
    requestHash: hashEvaluationRequest(evaluationRequest),
    protocolHash: HASH,
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
      requiredPosteriorProbability:
        reservation().allocation.requiredPosteriorProbability,
      onlineGateAuthorized: true,
      onlineErrorBudget: reservation().accounting,
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
    normalizedOutcomeSetHash: "d".repeat(64),
    cacheAttestationHash: "e".repeat(64),
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

function reservation() {
  const evaluationRequest = request();
  return createTrustedOnlineErrorBudgetReservation({
    request: evaluationRequest,
    requestHash: hashEvaluationRequest(evaluationRequest),
    dispositionAttestationHash: panel().dispositionAttestationHash,
    stateBefore: createOnlineErrorBudget(
      0.05,
      "null-calibration-v1",
    ),
    reservedAt: "2026-07-01T00:00:30.000Z",
  });
}

function onlineErrorAuthority(): TrustedOnlineErrorBudgetAuthority {
  const reserved = reservation();
  return {
    boundary: "trusted-cloud-online-error-authority",
    reserve: () => Promise.resolve(reserved),
    reconcile: () =>
      Promise.resolve({
        sensitivity: "release-safe-online-error-reconciliation",
        schemaVersion: 1,
        campaignIdHash: "9".repeat(64),
        storeRevision: 1,
        policyVersion: "online-alpha-spending-v1",
        maximumOnlineError:
          reserved.accounting.maximumOnlineError,
        onlineErrorSpent:
          reserved.accounting.cumulativeSpentAfter,
        onlineErrorRemaining: reserved.accounting.remainingAfter,
        gatesSpent: reserved.accounting.gateOrdinal,
        resultingStateHash:
          reserved.accounting.resultingStateHash,
        durableStateCommitment: "8".repeat(64),
        observedAt: "2026-07-01T00:00:31.000Z",
        reconciliationHash: "7".repeat(64),
      }),
  };
}

class FakeLedger implements OneUseRequestLedger {
  claimResult: OneUseClaim = {
    state: "acquired",
    claimToken: "claim-001",
  };
  consumed: BrokerFailureCode | undefined;

  claim(): Promise<OneUseClaim> {
    return Promise.resolve(this.claimResult);
  }

  inspect(): Promise<OneUseLedgerInspection> {
    const current = this.claimResult;
    if (current.state === "acquired") {
      return Promise.resolve({
        state: "in-flight",
        requestHash: hashEvaluationRequest(request()),
        retryAfterMs: 5_000,
      });
    }
    return Promise.resolve(current);
  }

  recoverInFlight(): Promise<OneUseClaim> {
    return Promise.resolve(this.claimResult);
  }

  bindDispositionAttestation(): Promise<boolean> {
    return Promise.resolve(true);
  }

  complete(
    _claimToken: string,
    _requestHash: string,
    _dispositionAttestationHash: string,
    _envelope: Parameters<
      OneUseRequestLedger["complete"]
    >[3],
  ): Promise<void> {
    return Promise.resolve();
  }

  consumeFailure(
    _claimToken: string,
    _requestHash: string,
    failureCode: BrokerFailureCode,
  ): Promise<void> {
    this.consumed = failureCode;
    return Promise.resolve();
  }
}

class CommitThenLoseAcknowledgementLedger extends FakeLedger {
  override complete(
    _claimToken: string,
    requestHash: string,
    _dispositionAttestationHash: string,
    envelope: Parameters<
      OneUseRequestLedger["complete"]
    >[3],
  ): Promise<void> {
    this.claimResult = {
      state: "completed",
      requestHash,
      envelope,
    };
    return Promise.reject(
      new Error("completion acknowledgement lost"),
    );
  }
}

class CommitSubstituteThenLoseAcknowledgementLedger extends FakeLedger {
  override complete(
    _claimToken: string,
    requestHash: string,
    _dispositionAttestationHash: string,
    envelope: Parameters<
      OneUseRequestLedger["complete"]
    >[3],
  ): Promise<void> {
    this.claimResult = {
      state: "completed",
      requestHash,
      envelope: {
        ...envelope,
        signature: {
          ...envelope.signature,
          signature: "A".repeat(86),
        },
      },
    };
    return Promise.reject(
      new Error("substituted completion acknowledgement lost"),
    );
  }
}

class AtomicMemoryStore implements AtomicOneUseLedgerStore {
  state: OneUseLedgerState = emptyOneUseLedgerState();

  transact<Result>(
    operation: (state: OneUseLedgerState) => {
      readonly next: OneUseLedgerState;
      readonly result: Result;
    },
  ): Promise<Result> {
    const transaction = operation(this.state);
    this.state = transaction.next;
    return Promise.resolve(transaction.result);
  }
}

class MemoryReleaseRecoveryStore
  implements TrustedPostDestructionReleaseRecoveryStore
{
  readonly boundary = "test-only-in-memory" as const;

  constructor(
    public record: TrustedPostDestructionReleaseRecoveryRecord,
  ) {}

  create(
    record: TrustedPostDestructionReleaseRecoveryRecord,
  ) {
    if (record.recordHash !== this.record.recordHash) {
      return Promise.reject(new Error("conflicting create"));
    }
    return Promise.resolve({
      status: "already-created" as const,
      requestHash: record.requestHash,
      protocolHash: record.protocolHash,
      revision: record.revision,
      recordHash: record.recordHash,
    });
  }

  resolve(input: {
    readonly requestHash: string;
    readonly protocolHash: string;
  }) {
    if (
      input.requestHash !== this.record.requestHash ||
      input.protocolHash !== this.record.protocolHash
    ) {
      return Promise.resolve({
        status: "missing" as const,
        requestHash: input.requestHash,
        protocolHash: input.protocolHash,
      });
    }
    return Promise.resolve({
      status: "found" as const,
      requestHash: input.requestHash,
      protocolHash: input.protocolHash,
      record: this.record,
    });
  }

  advance(input: {
    readonly requestHash: string;
    readonly protocolHash: string;
    readonly priorRecordHash: string;
    readonly next: TrustedPostDestructionReleaseRecoveryRecord;
  }) {
    if (this.record.recordHash === input.next.recordHash) {
      return Promise.resolve({
        status: "already-advanced" as const,
        requestHash: input.requestHash,
        protocolHash: input.protocolHash,
        revision: input.next.revision,
        recordHash: input.next.recordHash,
      });
    }
    if (this.record.recordHash !== input.priorRecordHash) {
      return Promise.reject(new Error("stale transition"));
    }
    assertPostDestructionReleaseRecoveryTransition(
      this.record,
      input.next,
    );
    this.record = input.next;
    return Promise.resolve({
      status: "advanced" as const,
      requestHash: input.requestHash,
      protocolHash: input.protocolHash,
      revision: input.next.revision,
      recordHash: input.next.recordHash,
    });
  }
}

function destructionReceipt(
  manifest = rawRun().manifest,
  privateKey = rawDestructionKey.privateKey,
): TrustedRawDestructionReceipt {
  return createSignedRawDestructionReceipt({
    policy: retentionPolicy,
    manifest,
    destroyedAt: "2026-07-01T00:10:00.000Z",
    privateKey,
    keyId: destructionReceiptVerifier.trustedKeyId,
    signedAt: "2026-07-01T00:10:00.000Z",
  });
}

function agent() {
  return createPiHarborAgentSpec({
    adapterImportPath: DARK_FACTORY_PI_HARBOR_IMPORT_PATH,
    adapterSha256: "a".repeat(64),
    provider: "openai",
    modelId: "gpt-5.6",
    thinkingLevel: "high",
    enabledTools: ["read", "write", "bash"],
    credentialEnvironmentNames: ["OPENAI_API_KEY"],
    timeoutMs: 3_600_000,
  });
}

function behavioralPreparation(): TrustedPrivateBehavioralPreparation {
  const evaluationRequest = request();
  return {
    sensitivity: "trusted-private-behavioral-preparation",
    requestHash: hashEvaluationRequest(evaluationRequest),
    protocolHash: evaluationRequest.protocolHash,
    experimentNumber: 1,
    behaviorSourceSetHash: "6".repeat(64),
    analysisWindow: {
      openedAt: "2026-07-01T00:01:00.000Z",
      closedAt: "2026-07-01T00:04:00.000Z",
    },
    observations: [],
    policy: {
      diagnosticsEnabled: true,
      comparison: "candidate-vs-champion",
      maximumPrivacyReleases: 8,
      diagnosticTtlMs: 2 * 60 * 60_000,
      policyVersions: {
        protocol: "protocol-v1",
        broker: "broker-v1",
        extraction: "extraction-v1",
        statistics: "statistics-v1",
        privacy: "privacy-v1",
        weighting: "weighting-v1",
        cache: "cache-v1",
        repeatedTesting: "testing-v1",
        leakScanner: "scanner-v1",
      },
    },
    forbiddenReleaseLiterals: [],
    forbiddenContentFingerprints: [],
    graderCanaryFingerprints: [],
  };
}

function orphanFinalization(
  finalization: TrustedBehavioralReleaseFinalization,
): TrustedBehavioralReleaseOrphanFinalizationReceipt {
  const unsigned = {
    authorizationHash: finalization.authorizationHash,
    requestHash: finalization.requestHash,
    releaseContentHash: finalization.contentHash,
    sourceSetHash: finalization.sourceSetHash,
    orphanedAt: "2026-07-01T00:12:00.000Z",
  };
  return {
    status: "orphaned",
    ...unsigned,
    orphanFinalizationHash:
      hashTrustedBehavioralReleaseOrphanFinalization(unsigned),
  };
}

class FakeBehavioralPreparationStore
  implements TrustedBehavioralPreparationStore
{
  readonly boundary = "test-only-in-memory" as const;
  readonly preparation = behavioralPreparation();
  readonly preparationHash =
    hashTrustedBehavioralPreparation(this.preparation);
  state:
    | "prepared"
    | "finalized"
    | "abandoned"
    | "consumed" = "prepared";
  sourceResultEnvelopeHash: string | null = null;
  finalization: TrustedBehavioralReleaseFinalization | null =
    null;
  finalizationHash: string | null = null;
  orphanFinalization:
    | TrustedBehavioralReleaseOrphanFinalizationReceipt
    | null = null;
  abandonmentHash: string | null = null;

  prepare() {
    return Promise.resolve({
      status: "already-prepared" as const,
      requestHash: this.preparation.requestHash,
      protocolHash: this.preparation.protocolHash,
      preparationHash: this.preparationHash,
    });
  }

  resolve() {
    if (
      this.state === "abandoned" &&
      this.sourceResultEnvelopeHash !== null &&
      this.finalizationHash !== null &&
      this.orphanFinalization !== null &&
      this.abandonmentHash !== null
    ) {
      return Promise.resolve({
        status: "abandoned" as const,
        requestHash: this.preparation.requestHash,
        protocolHash: this.preparation.protocolHash,
        preparationHash: this.preparationHash,
        sourceResultEnvelopeHash:
          this.sourceResultEnvelopeHash,
        finalizationHash: this.finalizationHash,
        orphanFinalizationHash:
          this.orphanFinalization.orphanFinalizationHash,
        abandonmentHash: this.abandonmentHash,
        orphanFinalization: this.orphanFinalization,
      });
    }
    if (
      this.state === "finalized" &&
      this.sourceResultEnvelopeHash !== null &&
      this.finalization !== null &&
      this.finalizationHash !== null
    ) {
      return Promise.resolve({
        status: "finalized" as const,
        requestHash: this.preparation.requestHash,
        protocolHash: this.preparation.protocolHash,
        preparationHash: this.preparationHash,
        sourceResultEnvelopeHash:
          this.sourceResultEnvelopeHash,
        finalizationHash: this.finalizationHash,
        finalization: this.finalization,
      });
    }
    if (this.state === "consumed") {
      return Promise.resolve({
        status: "consumed" as const,
        requestHash: this.preparation.requestHash,
        protocolHash: this.preparation.protocolHash,
        preparationHash: this.preparationHash,
      });
    }
    return Promise.resolve({
      status: "prepared" as const,
      requestHash: this.preparation.requestHash,
      protocolHash: this.preparation.protocolHash,
      preparationHash: this.preparationHash,
      preparation: this.preparation,
    });
  }

  finalize(
    input: Parameters<
      TrustedBehavioralPreparationStore["finalize"]
    >[0],
  ) {
    const finalizationHash =
      hashTrustedBehavioralPreparationFinalization(input);
    this.state = "finalized";
    this.sourceResultEnvelopeHash =
      input.sourceResultEnvelopeHash;
    this.finalization = input.finalization;
    this.finalizationHash = finalizationHash;
    return Promise.resolve({
      status: "finalized" as const,
      requestHash: input.requestHash,
      protocolHash: input.protocolHash,
      preparationHash: input.preparationHash,
      sourceResultEnvelopeHash:
        input.sourceResultEnvelopeHash,
      finalizationHash,
    });
  }

  abandon(
    input: Parameters<
      TrustedBehavioralPreparationStore["abandon"]
    >[0],
  ) {
    if (
      (this.state !== "finalized" &&
        this.state !== "abandoned") ||
      this.sourceResultEnvelopeHash !==
        input.sourceResultEnvelopeHash ||
      this.finalizationHash !== input.finalizationHash ||
      input.preparationHash !== this.preparationHash
    ) {
      return Promise.reject(
        new Error("detached abandonment"),
      );
    }
    const abandonmentHash =
      hashTrustedBehavioralPreparationAbandonment({
        requestHash: input.requestHash,
        protocolHash: input.protocolHash,
        preparationHash: input.preparationHash,
        sourceResultEnvelopeHash:
          input.sourceResultEnvelopeHash,
        finalizationHash: input.finalizationHash,
        orphanFinalizationHash:
          input.orphanFinalization.orphanFinalizationHash,
      });
    const status =
      this.state === "abandoned"
        ? ("already-abandoned" as const)
        : ("abandoned" as const);
    this.state = "abandoned";
    this.finalization = null;
    this.orphanFinalization = input.orphanFinalization;
    this.abandonmentHash = abandonmentHash;
    return Promise.resolve({
      status,
      requestHash: input.requestHash,
      protocolHash: input.protocolHash,
      preparationHash: input.preparationHash,
      sourceResultEnvelopeHash:
        input.sourceResultEnvelopeHash,
      finalizationHash: input.finalizationHash,
      orphanFinalizationHash:
        input.orphanFinalization.orphanFinalizationHash,
      abandonmentHash,
    });
  }

  consume(
    input: Parameters<
      TrustedBehavioralPreparationStore["consume"]
    >[0],
  ) {
    if (
      this.state === "abandoned" &&
      this.sourceResultEnvelopeHash !== null &&
      this.finalizationHash !== null &&
      this.orphanFinalization !== null &&
      this.abandonmentHash !== null
    ) {
      return Promise.resolve({
        status: "already-abandoned" as const,
        requestHash: input.requestHash,
        protocolHash: input.protocolHash,
        preparationHash: this.preparationHash,
        sourceResultEnvelopeHash:
          this.sourceResultEnvelopeHash,
        finalizationHash: this.finalizationHash,
        orphanFinalizationHash:
          this.orphanFinalization.orphanFinalizationHash,
        abandonmentHash: this.abandonmentHash,
      });
    }
    if (
      this.state === "finalized" &&
      this.sourceResultEnvelopeHash !== null &&
      this.finalizationHash !== null
    ) {
      return Promise.resolve({
        status: "already-finalized" as const,
        requestHash: input.requestHash,
        protocolHash: input.protocolHash,
        preparationHash: this.preparationHash,
        sourceResultEnvelopeHash:
          this.sourceResultEnvelopeHash,
        finalizationHash: this.finalizationHash,
      });
    }
    const status =
      this.state === "consumed"
        ? ("already-consumed" as const)
        : ("consumed" as const);
    this.state = "consumed";
    return Promise.resolve({
      status,
      requestHash: input.requestHash,
      protocolHash: input.protocolHash,
      preparationHash: this.preparationHash,
    });
  }
}

describe("trusted evaluation broker fail-closed lifecycle", () => {
  it("finalizes diagnostics only after destruction and binds the exact eventual result source", async () => {
    const events: string[] = [];
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    let suppliedSourceHash = "";
    const preparation = behavioralPreparation();
    const preparationHash =
      hashTrustedBehavioralPreparation(preparation);
    const preparationStore: TrustedBehavioralPreparationStore = {
      boundary: "test-only-in-memory",
      prepare: () =>
        Promise.reject(new Error("deriver owns preparation")),
      resolve: () => {
        events.push("resolve-preparation");
        return Promise.resolve({
          status: "prepared",
          requestHash: preparation.requestHash,
          protocolHash: preparation.protocolHash,
          preparationHash,
          preparation,
        });
      },
      finalize: (input) => {
        events.push("finalize-preparation");
        return Promise.resolve({
          status: "finalized",
          requestHash: input.requestHash,
          protocolHash: input.protocolHash,
          preparationHash: input.preparationHash,
          sourceResultEnvelopeHash:
            input.sourceResultEnvelopeHash,
          finalizationHash:
            hashTrustedBehavioralPreparationFinalization(
              input,
          ),
        });
      },
      abandon: () =>
        Promise.reject(new Error("must not abandon")),
      consume: () =>
        Promise.reject(new Error("must not consume")),
    };
    const finalization: TrustedBehavioralReleaseFinalization = {
      contentHash: "7".repeat(64),
      sourceSetHash: "6".repeat(64),
      privacyThresholdPassed: true,
      authorizationHash: "8".repeat(64),
      requestHash: hashEvaluationRequest(request()),
    };
    const producer: TrustedPostDestructionBehavioralReleaseProducer = {
      finalize: (input) => {
        events.push("finalize");
        suppliedSourceHash = input.sourceResultEnvelopeHash;
        expect(input.destructionReceipt.destroyedAt).toBe(
          "2026-07-01T00:10:00.000Z",
        );
        return Promise.resolve(finalization);
      },
      orphan: () => Promise.reject(new Error("must not orphan")),
    };
    const realIssuer = new Ed25519ResultEnvelopeIssuer({
      privateKey,
      keyId: "evaluator-key-1",
      now: () => new Date("2026-07-01T00:11:00.000Z"),
    });
    const broker = new TrustedEvaluationBroker({
      ledger: new DurableOneUseRequestLedger({
        store: new AtomicMemoryStore(),
        controllerInstanceIdHash: "d".repeat(64),
        claimTokenFactory: () => "claim-001",
      }),
      panels: { allocateAndConsume: () => Promise.resolve(panel()) },
      runner: { run: () => Promise.resolve(rawRun()) },
      deriver: {
        derive: () => {
          events.push("derive");
          return Promise.resolve(aggregate());
        },
      },
      behavioralPreparationStore: preparationStore,
      behavioralReleaseProducer: producer,
      custodian: {
        destroy: (run) => {
          events.push("destroy");
          return Promise.resolve(destructionReceipt(run.manifest));
        },
      },
      onlineErrorAuthority: onlineErrorAuthority(),
      issuer: {
        issue: (input) => {
          events.push("issue-result");
          return realIssuer.issue(input);
        },
      },
      verifier: new Ed25519ResultEnvelopeVerifier({
        getVerificationKey: () => Promise.resolve(publicKey),
      }),
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });

    const envelope = await broker.evaluate(request());
    expect(events).toEqual([
      "derive",
      "destroy",
      "resolve-preparation",
      "finalize",
      "finalize-preparation",
      "issue-result",
    ]);
    expect(envelope.derivation.behavioralAggregateHash).toBe(
      finalization.contentHash,
    );
    expect(suppliedSourceHash).toBe(
      resultEnvelopeBehavioralSourceCommitmentHash(envelope),
    );
  });

  it("permanently orphans a committed diagnostic bundle when result issuance fails", async () => {
    const ledger = new FakeLedger();
    const orphan = vi.fn(
      (value: TrustedBehavioralReleaseFinalization) =>
        Promise.resolve(orphanFinalization(value)),
    );
    const preparationStore =
      new FakeBehavioralPreparationStore();
    const producer: TrustedPostDestructionBehavioralReleaseProducer = {
      finalize: () =>
        Promise.resolve({
          contentHash: "7".repeat(64),
          sourceSetHash: "6".repeat(64),
          privacyThresholdPassed: true,
          authorizationHash: "8".repeat(64),
          requestHash: hashEvaluationRequest(request()),
        }),
      orphan,
    };
    const broker = new TrustedEvaluationBroker({
      ledger,
      panels: { allocateAndConsume: () => Promise.resolve(panel()) },
      runner: { run: () => Promise.resolve(rawRun()) },
      deriver: { derive: () => Promise.resolve(aggregate()) },
      behavioralPreparationStore: preparationStore,
      behavioralReleaseProducer: producer,
      custodian: {
        destroy: (run) =>
          Promise.resolve(destructionReceipt(run.manifest)),
      },
      onlineErrorAuthority: onlineErrorAuthority(),
      issuer: {
        issue: () => Promise.reject(new Error("signing unavailable")),
      },
      verifier: { verify: () => Promise.resolve(true) },
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });

    await expect(broker.evaluate(request())).rejects.toMatchObject({
      code: "release-validation-failed",
    });
    expect(orphan).toHaveBeenCalledTimes(1);
    expect(preparationStore.state).toBe("abandoned");
    expect(ledger.consumed).toBe("release-validation-failed");
  });

  it("preserves the request and finalized preparation when orphan reconciliation is unsafe", async () => {
    const ledger = new FakeLedger();
    const preparationStore =
      new FakeBehavioralPreparationStore();
    const consume = vi.spyOn(preparationStore, "consume");
    const orphan = vi.fn(() =>
      Promise.reject(new Error("orphan acknowledgement lost")),
    );
    const broker = new TrustedEvaluationBroker({
      ledger,
      panels: {
        allocateAndConsume: () => Promise.resolve(panel()),
      },
      runner: { run: () => Promise.resolve(rawRun()) },
      deriver: { derive: () => Promise.resolve(aggregate()) },
      behavioralPreparationStore: preparationStore,
      behavioralReleaseProducer: {
        finalize: () =>
          Promise.resolve({
            contentHash: "7".repeat(64),
            sourceSetHash: "6".repeat(64),
            privacyThresholdPassed: true,
            authorizationHash: "8".repeat(64),
            requestHash: hashEvaluationRequest(request()),
          }),
        orphan,
      },
      custodian: {
        destroy: (run) =>
          Promise.resolve(destructionReceipt(run.manifest)),
      },
      onlineErrorAuthority: onlineErrorAuthority(),
      issuer: {
        issue: () =>
          Promise.reject(new Error("signing unavailable")),
      },
      verifier: { verify: () => Promise.resolve(true) },
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });

    await expect(
      broker.evaluate(request()),
    ).rejects.toMatchObject({
      code: "release-validation-failed",
    });
    expect(orphan).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
    expect(preparationStore.state).toBe("finalized");
    expect(ledger.consumed).toBeUndefined();
  });

  it("preserves the request when durable preparation abandonment cannot be reconciled", async () => {
    const ledger = new FakeLedger();
    const preparationStore =
      new FakeBehavioralPreparationStore();
    const abandon = vi
      .spyOn(preparationStore, "abandon")
      .mockRejectedValue(
        new Error("abandonment acknowledgement unavailable"),
      );
    const orphan = vi.fn(
      (value: TrustedBehavioralReleaseFinalization) =>
        Promise.resolve(orphanFinalization(value)),
    );
    const broker = new TrustedEvaluationBroker({
      ledger,
      panels: {
        allocateAndConsume: () => Promise.resolve(panel()),
      },
      runner: { run: () => Promise.resolve(rawRun()) },
      deriver: { derive: () => Promise.resolve(aggregate()) },
      behavioralPreparationStore: preparationStore,
      behavioralReleaseProducer: {
        finalize: () =>
          Promise.resolve({
            contentHash: "7".repeat(64),
            sourceSetHash: "6".repeat(64),
            privacyThresholdPassed: true,
            authorizationHash: "8".repeat(64),
            requestHash: hashEvaluationRequest(request()),
          }),
        orphan,
      },
      custodian: {
        destroy: (run) =>
          Promise.resolve(destructionReceipt(run.manifest)),
      },
      onlineErrorAuthority: onlineErrorAuthority(),
      issuer: {
        issue: () =>
          Promise.reject(new Error("signing unavailable")),
      },
      verifier: { verify: () => Promise.resolve(true) },
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });

    await expect(
      broker.evaluate(request()),
    ).rejects.toMatchObject({
      code: "release-validation-failed",
    });
    expect(orphan).toHaveBeenCalledTimes(1);
    expect(abandon).toHaveBeenCalledTimes(2);
    expect(preparationStore.state).toBe("finalized");
    expect(ledger.consumed).toBeUndefined();
  });

  it("reconciles a committed result after its completion acknowledgement is lost", async () => {
    const ledger = new CommitThenLoseAcknowledgementLedger();
    const orphan = vi.fn(
      (value: TrustedBehavioralReleaseFinalization) =>
        Promise.resolve(orphanFinalization(value)),
    );
    const preparationStore =
      new FakeBehavioralPreparationStore();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const finalization: TrustedBehavioralReleaseFinalization = {
      contentHash: "7".repeat(64),
      sourceSetHash: "6".repeat(64),
      privacyThresholdPassed: true,
      authorizationHash: "8".repeat(64),
      requestHash: hashEvaluationRequest(request()),
    };
    const broker = new TrustedEvaluationBroker({
      ledger,
      panels: { allocateAndConsume: () => Promise.resolve(panel()) },
      runner: { run: () => Promise.resolve(rawRun()) },
      deriver: { derive: () => Promise.resolve(aggregate()) },
      behavioralPreparationStore: preparationStore,
      behavioralReleaseProducer: {
        finalize: () => Promise.resolve(finalization),
        orphan,
      },
      custodian: {
        destroy: (run) =>
          Promise.resolve(destructionReceipt(run.manifest)),
      },
      onlineErrorAuthority: onlineErrorAuthority(),
      issuer: new Ed25519ResultEnvelopeIssuer({
        privateKey,
        keyId: "evaluator-key-1",
        now: () =>
          new Date("2026-07-01T00:11:00.000Z"),
      }),
      verifier: new Ed25519ResultEnvelopeVerifier({
        getVerificationKey: () => Promise.resolve(publicKey),
      }),
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });

    const envelope = await broker.evaluate(request());
    expect(
      envelope.derivation.behavioralAggregateHash,
    ).toBe(finalization.contentHash);
    expect(orphan).not.toHaveBeenCalled();
    expect(ledger.consumed).toBeUndefined();
  });

  it("does not return or orphan a different envelope recovered after completion ambiguity", async () => {
    const ledger =
      new CommitSubstituteThenLoseAcknowledgementLedger();
    const orphan = vi.fn(
      (value: TrustedBehavioralReleaseFinalization) =>
        Promise.resolve(orphanFinalization(value)),
    );
    const preparationStore =
      new FakeBehavioralPreparationStore();
    const { privateKey } = generateKeyPairSync("ed25519");
    const finalization: TrustedBehavioralReleaseFinalization = {
      contentHash: "7".repeat(64),
      sourceSetHash: "6".repeat(64),
      privacyThresholdPassed: true,
      authorizationHash: "8".repeat(64),
      requestHash: hashEvaluationRequest(request()),
    };
    const broker = new TrustedEvaluationBroker({
      ledger,
      panels: {
        allocateAndConsume: () => Promise.resolve(panel()),
      },
      runner: { run: () => Promise.resolve(rawRun()) },
      deriver: { derive: () => Promise.resolve(aggregate()) },
      behavioralPreparationStore: preparationStore,
      behavioralReleaseProducer: {
        finalize: () => Promise.resolve(finalization),
        orphan,
      },
      custodian: {
        destroy: (run) =>
          Promise.resolve(destructionReceipt(run.manifest)),
      },
      onlineErrorAuthority: onlineErrorAuthority(),
      issuer: new Ed25519ResultEnvelopeIssuer({
        privateKey,
        keyId: "evaluator-key-1",
        now: () =>
          new Date("2026-07-01T00:11:00.000Z"),
      }),
      verifier: { verify: () => Promise.resolve(true) },
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });

    await expect(
      broker.evaluate(request()),
    ).rejects.toMatchObject({
      code: "release-validation-failed",
    });
    expect(orphan).not.toHaveBeenCalled();
    expect(ledger.consumed).toBeUndefined();
  });

  it("burns the request and clears private preparation when finalization is known not committed", async () => {
    const ledger = new FakeLedger();
    const preparationStore =
      new FakeBehavioralPreparationStore();
    const consume = vi.spyOn(preparationStore, "consume");
    const issue = vi.fn(() => Promise.reject(new Error("must not issue")));
    const broker = new TrustedEvaluationBroker({
      ledger,
      panels: { allocateAndConsume: () => Promise.resolve(panel()) },
      runner: { run: () => Promise.resolve(rawRun()) },
      deriver: { derive: () => Promise.resolve(aggregate()) },
      behavioralPreparationStore: preparationStore,
      behavioralReleaseProducer: {
        finalize: () =>
          Promise.reject(
            new TrustedBehavioralReleaseProducerError(
              "known-not-committed",
            ),
          ),
        orphan: () => Promise.reject(new Error("must not orphan")),
      },
      custodian: {
        destroy: (run) =>
          Promise.resolve(destructionReceipt(run.manifest)),
      },
      onlineErrorAuthority: onlineErrorAuthority(),
      issuer: { issue },
      verifier: { verify: () => Promise.resolve(true) },
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });

    await expect(broker.evaluate(request())).rejects.toMatchObject({
      code: "release-validation-failed",
    });
    expect(issue).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledWith({
      requestHash: hashEvaluationRequest(request()),
      protocolHash: request().protocolHash,
    });
    expect(preparationStore.state).toBe("consumed");
    expect(ledger.consumed).toBe("release-validation-failed");
  });

  it("preserves one-use state when finalization fails without an explicit non-commit proof", async () => {
    const ledger = new FakeLedger();
    const preparationStore =
      new FakeBehavioralPreparationStore();
    const consume = vi.spyOn(preparationStore, "consume");
    const issue = vi.fn(() =>
      Promise.reject(new Error("must not issue")),
    );
    const broker = new TrustedEvaluationBroker({
      ledger,
      panels: {
        allocateAndConsume: () => Promise.resolve(panel()),
      },
      runner: { run: () => Promise.resolve(rawRun()) },
      deriver: { derive: () => Promise.resolve(aggregate()) },
      behavioralPreparationStore: preparationStore,
      behavioralReleaseProducer: {
        finalize: () =>
          Promise.reject(
            new Error("finalization acknowledgement unavailable"),
          ),
        orphan: () =>
          Promise.reject(new Error("must not orphan")),
      },
      custodian: {
        destroy: (run) =>
          Promise.resolve(destructionReceipt(run.manifest)),
      },
      onlineErrorAuthority: onlineErrorAuthority(),
      issuer: { issue },
      verifier: { verify: () => Promise.resolve(true) },
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });

    await expect(
      broker.evaluate(request()),
    ).rejects.toMatchObject({
      code: "release-validation-failed",
    });
    expect(issue).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(preparationStore.state).toBe("prepared");
    expect(ledger.consumed).toBeUndefined();
  });

  it("preserves the request when private preparation cleanup is not durably acknowledged", async () => {
    const ledger = new FakeLedger();
    const preparationStore =
      new FakeBehavioralPreparationStore();
    const consume = vi
      .spyOn(preparationStore, "consume")
      .mockRejectedValue(
        new Error("preparation consumption acknowledgement lost"),
      );
    const issue = vi.fn(() =>
      Promise.reject(new Error("must not issue")),
    );
    const broker = new TrustedEvaluationBroker({
      ledger,
      panels: {
        allocateAndConsume: () => Promise.resolve(panel()),
      },
      runner: { run: () => Promise.resolve(rawRun()) },
      deriver: { derive: () => Promise.resolve(aggregate()) },
      behavioralPreparationStore: preparationStore,
      behavioralReleaseProducer: {
        finalize: () =>
          Promise.reject(
            new TrustedBehavioralReleaseProducerError(
              "known-not-committed",
            ),
          ),
        orphan: () =>
          Promise.reject(new Error("must not orphan")),
      },
      custodian: {
        destroy: (run) =>
          Promise.resolve(destructionReceipt(run.manifest)),
      },
      onlineErrorAuthority: onlineErrorAuthority(),
      issuer: { issue },
      verifier: { verify: () => Promise.resolve(true) },
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });

    await expect(
      broker.evaluate(request()),
    ).rejects.toMatchObject({
      code: "release-validation-failed",
    });
    expect(issue).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledTimes(1);
    expect(ledger.consumed).toBeUndefined();
  });

  it("preserves the one-use request when release commit reconciliation remains unsafe", async () => {
    const ledger = new FakeLedger();
    const consume = vi.fn(() =>
      Promise.reject(new Error("must not consume")),
    );
    const orphan = vi.fn(
      (value: TrustedBehavioralReleaseFinalization) =>
        Promise.resolve(orphanFinalization(value)),
    );
    const issue = vi.fn(() =>
      Promise.reject(new Error("must not issue")),
    );
    const preparation = behavioralPreparation();
    const preparationHash =
      hashTrustedBehavioralPreparation(preparation);
    const broker = new TrustedEvaluationBroker({
      ledger,
      panels: { allocateAndConsume: () => Promise.resolve(panel()) },
      runner: { run: () => Promise.resolve(rawRun()) },
      deriver: { derive: () => Promise.resolve(aggregate()) },
      behavioralPreparationStore: {
        boundary: "test-only-in-memory",
        prepare: () =>
          Promise.reject(new Error("must not prepare")),
        resolve: () =>
          Promise.resolve({
            status: "prepared",
            requestHash: preparation.requestHash,
            protocolHash: preparation.protocolHash,
            preparationHash,
            preparation,
          }),
        finalize: () =>
          Promise.reject(new Error("must not finalize")),
        abandon: () =>
          Promise.reject(new Error("must not abandon")),
        consume,
      },
      behavioralReleaseProducer: {
        finalize: () =>
          Promise.reject(
            new TrustedBehavioralReleaseProducerError(
              "unsafe-to-consume",
            ),
          ),
        orphan,
      },
      custodian: {
        destroy: (run) =>
          Promise.resolve(destructionReceipt(run.manifest)),
      },
      onlineErrorAuthority: onlineErrorAuthority(),
      issuer: { issue },
      verifier: { verify: () => Promise.resolve(true) },
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });

    await expect(broker.evaluate(request())).rejects.toMatchObject({
      code: "release-validation-failed",
    });
    expect(issue).not.toHaveBeenCalled();
    expect(orphan).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(ledger.consumed).toBeUndefined();
  });

  it("durably reserves online alpha before starting an outcome-bearing runner", async () => {
    const events: string[] = [];
    const ledger = new FakeLedger();
    const broker = new TrustedEvaluationBroker({
      ledger,
      panels: { allocateAndConsume: () => Promise.resolve(panel()) },
      onlineErrorAuthority: {
        boundary: "trusted-cloud-online-error-authority",
        reserve: () => {
          events.push("reserve");
          return Promise.resolve(reservation());
        },
        reconcile: () =>
          Promise.reject(new Error("must not reconcile")),
      },
      runner: {
        run: () => {
          events.push("run");
          return Promise.reject(new Error("provider failed"));
        },
      },
      deriver: {
        derive: () => Promise.reject(new Error("must not derive")),
      },
      custodian: {
        destroy: () => Promise.reject(new Error("must not destroy")),
      },
      issuer: {
        issue: () => Promise.reject(new Error("must not issue")),
      },
      verifier: { verify: () => Promise.resolve(true) },
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });

    await expect(broker.evaluate(request())).rejects.toMatchObject({
      code: "evaluation-failed",
    });
    expect(events).toEqual(["reserve", "run"]);
    expect(ledger.consumed).toBe("evaluation-failed");
  });

  it("returns the same signed result on replay without rerunning hidden cells", async () => {
    const evaluationRequest = request();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const runner = vi.fn(() => Promise.resolve(rawRun()));
    const issuer = new Ed25519ResultEnvelopeIssuer({
      privateKey,
      keyId: "evaluator-key-1",
      now: () => new Date("2026-07-01T00:11:00.000Z"),
    });
    const verifier = new Ed25519ResultEnvelopeVerifier({
      getVerificationKey: () => Promise.resolve(publicKey),
    });
    const broker = new TrustedEvaluationBroker({
      ledger: new DurableOneUseRequestLedger({
        store: new AtomicMemoryStore(),
        controllerInstanceIdHash: "d".repeat(64),
        claimTokenFactory: () => "claim-001",
      }),
      panels: { allocateAndConsume: () => Promise.resolve(panel()) },
      runner: { run: runner },
      deriver: { derive: () => Promise.resolve(aggregate()) },
      custodian: {
        destroy: (run) => Promise.resolve(destructionReceipt(run.manifest)),
      },
      onlineErrorAuthority: onlineErrorAuthority(),
      issuer,
      verifier,
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });
    const first = await broker.evaluate(evaluationRequest);
    const replay = await broker.evaluate(evaluationRequest);
    expect(replay).toEqual(first);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it(
    "destroys raw material and consumes the request when canonical normalization fails",
    async () => {
      const ledger = new FakeLedger();
      const destroy = vi.fn((run: TrustedRawRun) =>
        Promise.resolve(destructionReceipt(run.manifest)),
      );
      const broker = new TrustedEvaluationBroker({
        ledger,
        panels: { allocateAndConsume: () => Promise.resolve(panel()) },
        runner: { run: () => Promise.resolve(rawRun()) },
        deriver: {
          derive: () =>
            Promise.reject(new Error("sensitive hidden task failure detail")),
        },
        custodian: { destroy },
        onlineErrorAuthority: onlineErrorAuthority(),
        issuer: {
          issue: () => Promise.reject(new Error("issuer must not be called")),
        },
        verifier: { verify: () => Promise.resolve(true) },
        agent: agent(),
        retentionPolicy,
        destructionReceiptVerifier,
      });
      const outcome = broker.evaluate(request());
      await expect(outcome).rejects.toMatchObject({
        code: "normalization-failed",
      });
      await expect(outcome).rejects.not.toThrow(/hidden task failure detail/u);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(ledger.consumed).toBe("normalization-failed");
    },
  );

  it("releases nothing when raw destruction cannot be attested", async () => {
    const ledger = new FakeLedger();
    const issue = vi.fn(() => Promise.reject(new Error("must not issue")));
    const broker = new TrustedEvaluationBroker({
      ledger,
      panels: { allocateAndConsume: () => Promise.resolve(panel()) },
      runner: { run: () => Promise.resolve(rawRun()) },
      deriver: {
        derive: () => Promise.resolve(aggregate()),
      },
      custodian: {
        destroy: () => Promise.reject(new Error("storage-specific secret")),
      },
      onlineErrorAuthority: onlineErrorAuthority(),
      issuer: { issue },
      verifier: { verify: () => Promise.resolve(true) },
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });
    await expect(broker.evaluate(request())).rejects.toMatchObject({
      code: "raw-destruction-failed",
    });
    expect(issue).not.toHaveBeenCalled();
    expect(ledger.consumed).toBe("raw-destruction-failed");
  });

  it("releases nothing when destruction is signed by an untrusted key", async () => {
    const ledger = new FakeLedger();
    const issue = vi.fn(() => Promise.reject(new Error("must not issue")));
    const untrustedKey = generateKeyPairSync("ed25519");
    const broker = new TrustedEvaluationBroker({
      ledger,
      panels: { allocateAndConsume: () => Promise.resolve(panel()) },
      runner: { run: () => Promise.resolve(rawRun()) },
      deriver: { derive: () => Promise.resolve(aggregate()) },
      custodian: {
        destroy: (run) =>
          Promise.resolve(
            destructionReceipt(run.manifest, untrustedKey.privateKey),
          ),
      },
      onlineErrorAuthority: onlineErrorAuthority(),
      issuer: { issue },
      verifier: { verify: () => Promise.resolve(true) },
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });

    await expect(broker.evaluate(request())).rejects.toMatchObject({
      code: "raw-destruction-failed",
    });
    expect(issue).not.toHaveBeenCalled();
    expect(ledger.consumed).toBe("raw-destruction-failed");
  });

  it("resumes an exact post-destruction checkpoint after provider-attested predecessor termination without rerunning tasks", async () => {
    const evaluationRequest = request();
    const requestHash =
      hashEvaluationRequest(evaluationRequest);
    const ledgerStore = new AtomicMemoryStore();
    const predecessor = new DurableOneUseRequestLedger({
      store: ledgerStore,
      controllerInstanceIdHash: "3".repeat(64),
      claimTokenFactory: () => "claim-predecessor",
    });
    await predecessor.claim(
      evaluationRequest.requestId,
      requestHash,
    );
    await predecessor.bindDispositionAttestation(
      "claim-predecessor",
      requestHash,
      panel().dispositionAttestationHash,
    );
    const raw = rawRun();
    const recovery = new MemoryReleaseRecoveryStore(
      sealPostDestructionReleaseRecoveryRecord({
        schemaVersion: 1,
        sensitivity:
          "trusted-private-post-destruction-release-recovery",
        requestId: evaluationRequest.requestId,
        requestHash,
        protocolHash: evaluationRequest.protocolHash,
        dispositionAttestationHash:
          panel().dispositionAttestationHash,
        retentionPolicyHash: retentionPolicy.policyHash,
        rawManifest: raw.manifest,
        destructionReceipt: destructionReceipt(
          raw.manifest,
        ),
        aggregate: aggregate(),
        behavioral: { status: "none" },
        status: "open",
        envelope: null,
        envelopeHash: null,
        failureCode: null,
        revision: 1,
      }),
    );
    const successor = new DurableOneUseRequestLedger({
      store: ledgerStore,
      controllerInstanceIdHash: "4".repeat(64),
      claimTokenFactory: () => "claim-successor",
      recoveryAuthority: {
        boundary:
          "trusted-cloud-provider-termination-authority",
        authorize: (observation) => {
          const unsigned = {
            schemaVersion: 1 as const,
            domain:
              "dark-factory.one-use-claim-recovery-authorization.v1" as const,
            authorizationId: "provider-stop-001",
            requestId: observation.requestId,
            requestHash: observation.requestHash,
            recoveryRecordHash:
              observation.recoveryRecordHash,
            dispositionAttestationHash:
              observation.dispositionAttestationHash,
            priorClaimTokenHash:
              observation.priorClaimTokenHash,
            priorOwnerInstanceIdHash:
              observation.priorOwnerInstanceIdHash,
            priorClaimEpoch: observation.priorClaimEpoch,
            successorOwnerInstanceIdHash:
              observation.successorOwnerInstanceIdHash,
            observationHash: observation.observationHash,
            providerTerminationAttestationHash:
              "5".repeat(64),
            authorityAttestationHash: "6".repeat(64),
            authorizedAt: "2026-07-01T00:10:30.000Z",
            signerKeyId: "provider-termination-key",
          };
          return Promise.resolve({
            ...unsigned,
            authorizationHash:
              hashOneUseClaimRecoveryAuthorization(
                unsigned,
              ),
          });
        },
      },
    });
    const { privateKey, publicKey } =
      generateKeyPairSync("ed25519");
    const allocate = vi.fn(() =>
      Promise.reject(new Error("must not allocate")),
    );
    const run = vi.fn(() =>
      Promise.reject(new Error("must not run")),
    );
    const derive = vi.fn(() =>
      Promise.reject(new Error("must not derive")),
    );
    const destroy = vi.fn(() =>
      Promise.reject(new Error("must not destroy")),
    );
    const broker = new TrustedEvaluationBroker({
      ledger: successor,
      panels: { allocateAndConsume: allocate },
      runner: { run },
      deriver: { derive },
      releaseRecoveryStore: recovery,
      custodian: { destroy },
      onlineErrorAuthority: onlineErrorAuthority(),
      issuer: new Ed25519ResultEnvelopeIssuer({
        privateKey,
        keyId: "evaluator-key-1",
        now: () =>
          new Date("2026-07-01T00:11:00.000Z"),
      }),
      verifier: new Ed25519ResultEnvelopeVerifier({
        getVerificationKey: () =>
          Promise.resolve(publicKey),
      }),
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });

    await expect(
      broker.evaluate(evaluationRequest),
    ).resolves.toMatchObject({
      oneUseRequest: {
        requestId: evaluationRequest.requestId,
        requestHash,
      },
    });
    expect(allocate).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(derive).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(recovery.record.status).toBe("completed");
  });

  it("rejects replay mutation before allocating any hidden panel", async () => {
    const ledger = new FakeLedger();
    ledger.claimResult = { state: "conflict" };
    const allocate = vi.fn(() => Promise.resolve(panel()));
    const broker = new TrustedEvaluationBroker({
      ledger,
      panels: { allocateAndConsume: allocate },
      runner: { run: () => Promise.resolve(rawRun()) },
      deriver: { derive: () => Promise.resolve(aggregate()) },
      custodian: {
        destroy: (run) => Promise.resolve(destructionReceipt(run.manifest)),
      },
      onlineErrorAuthority: onlineErrorAuthority(),
      issuer: {
        issue: () => Promise.reject(new Error("must not issue")),
      },
      verifier: { verify: () => Promise.resolve(true) },
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });
    await expect(broker.evaluate(request())).rejects.toMatchObject({
      code: "request-conflict",
    });
    expect(allocate).not.toHaveBeenCalled();
  });
});
