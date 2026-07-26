import {
  hashTrustedBehavioralPreparation,
  hashTrustedBehavioralPreparationAbandonment,
  hashTrustedBehavioralPreparationFinalization,
  type TrustedBehavioralPreparationAbandonmentReceipt,
  type TrustedBehavioralPreparationStore,
} from "../evaluator/behavioral-preparation-store.js";
import {
  hashTrustedBehavioralReleaseOrphanFinalization,
  type TrustedBehavioralReleaseFinalization,
  type TrustedBehavioralReleaseOrphanFinalizationReceipt,
  TrustedBehavioralReleaseProducerError,
  type TrustedPostDestructionBehavioralReleaseProducer,
} from "../evaluator/behavioral-release-producer.js";
import {
  assertEvaluationRequest,
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "../evaluator/contracts.js";
import type { TrustedPrivateBehavioralPreparation } from "../evaluator/deriver.js";
import type {
  TrustedOnlineErrorBudgetAuthority,
  TrustedOnlineErrorBudgetReservation,
} from "../evaluator/online-error-authority.js";
import { hashResultEnvelopeBehavioralSourceMaterial } from "../evaluator/release-lineage.js";
import {
  assertPostDestructionReleaseRecoveryRecord,
  hashResultCompletionEnvelope,
  sealPostDestructionReleaseRecoveryRecord,
  type TrustedPostDestructionReleaseRecoveryRecord,
  type TrustedPostDestructionReleaseRecoveryStore,
  type TrustedReleaseRecoveryBehavioralState,
} from "../evaluator/release-recovery-store.js";
import {
  assertRawDestructionReceipt,
  assertRawDestructionReceiptVerifier,
  assertRawRetentionPolicy,
  assertSafeForLocalPersistence,
  type TrustedRawDestructionReceipt,
  type TrustedRawDestructionReceiptVerifier,
  type TrustedRawRetentionPolicy,
} from "../evaluator/retention.js";
import { canonicalHash } from "../schemas/canonical.js";
import { assertValidDocument } from "../schemas/registry.js";
import type { SignedResultEnvelope } from "../schemas/trusted.js";
import type { PiHarborAgentSpec } from "../terminal-bench/pi-agent.js";
import type {
  TerminalBenchCloudRunner,
  TrustedRawRun,
  TrustedTerminalBenchRunRequest,
} from "../terminal-bench/runner.js";
import {
  assertTrustedMatchedPanel,
  createTrustedMatchedArmSchedule,
  type TrustedMatchedArmSchedule,
  type TrustedMatchedPanel,
} from "../terminal-bench/trusted.js";
import {
  assertOneUseClaim,
  assertOneUseLedgerInspection,
  type BrokerFailureCode,
  type OneUseRequestLedger,
} from "./ledger.js";

export interface TrustedPanelAllocator {
  /**
   * Allocation is durable and consumptive: once returned, these hidden cells
   * can never be allocated again where policy requires fresh evidence. The
   * disposition attestation must be a fresh nonce-bound commitment, never a
   * stable digest of panel membership.
   */
  allocateAndConsume(
    request: TrustedEvaluationRequest,
    requestHash: string,
    claimToken: string,
  ): Promise<TrustedMatchedPanel>;
}

export interface TrustedCanonicalAggregate {
  readonly sensitivity: "trusted-canonical-aggregate";
  readonly requestHash: string;
  readonly protocolHash: string;
  readonly rawManifestId: string;
  readonly payload: SignedResultEnvelope["payload"];
  readonly normalizedOutcomeSetHash: string;
  readonly cacheAttestationHash: string;
  readonly behavioralAggregateHash: string | null;
  readonly derivedAt: string;
  readonly releaseChecks: {
    readonly graderCanaryScanPassed: true;
    readonly contentFingerprintScanPassed: true;
    readonly taskIdentityScanPassed: true;
    readonly privacyThresholdPassed: boolean;
  };
}

export interface TrustedCanonicalEvaluationDeriver {
  /**
   * Implementations reduce raw Harbor, Pi structured-event, and grader data
   * through the
   * canonical normalizer/gates. Returned data must contain no task identity,
   * grader prose, command, path, output, or per-task row.
   */
  derive(input: {
    readonly request: TrustedEvaluationRequest;
    readonly panel: TrustedMatchedPanel;
    readonly schedule: TrustedMatchedArmSchedule;
    readonly rawRun: TrustedRawRun;
    readonly onlineErrorReservation: TrustedOnlineErrorBudgetReservation | null;
  }): Promise<TrustedCanonicalAggregate>;
}

export interface TrustedRawArtifactCustodian {
  destroy(rawRun: TrustedRawRun): Promise<TrustedRawDestructionReceipt>;
}

export interface TrustedResultEnvelopeIssuer {
  issue(input: {
    readonly request: TrustedEvaluationRequest;
    readonly requestHash: string;
    readonly dispositionAttestationHash: string;
    readonly aggregate: TrustedCanonicalAggregate;
    readonly destructionReceipt: Pick<
      TrustedRawDestructionReceipt,
      "manifestId" | "destroyedAt" | "verifierAttestationHash"
    >;
    readonly retentionPolicyHash: string;
  }): Promise<SignedResultEnvelope>;
}

export interface TrustedResultEnvelopeVerifier {
  verify(envelope: SignedResultEnvelope): Promise<boolean>;
}

export interface TrustedEvaluationBrokerOptions {
  readonly ledger: OneUseRequestLedger;
  readonly panels: TrustedPanelAllocator;
  readonly runner: Pick<TerminalBenchCloudRunner, "run">;
  readonly deriver: TrustedCanonicalEvaluationDeriver;
  readonly behavioralPreparationStore?: TrustedBehavioralPreparationStore;
  readonly behavioralReleaseProducer?: TrustedPostDestructionBehavioralReleaseProducer;
  readonly releaseRecoveryStore?: TrustedPostDestructionReleaseRecoveryStore;
  readonly custodian: TrustedRawArtifactCustodian;
  readonly issuer: TrustedResultEnvelopeIssuer;
  readonly verifier: TrustedResultEnvelopeVerifier;
  readonly onlineErrorAuthority: TrustedOnlineErrorBudgetAuthority;
  readonly agent: PiHarborAgentSpec;
  readonly retentionPolicy: TrustedRawRetentionPolicy;
  readonly destructionReceiptVerifier: TrustedRawDestructionReceiptVerifier;
}

export type TrustedAdaptiveEvaluationRequest = TrustedEvaluationRequest & {
  readonly stage: "repair" | "validation" | "shadow";
  readonly champion: NonNullable<TrustedEvaluationRequest["champion"]>;
};

export class TrustedEvaluationBrokerError extends Error {
  override readonly name = "TrustedEvaluationBrokerError";
  readonly code: BrokerFailureCode | "request-conflict" | "request-in-flight" | "request-consumed";

  constructor(
    code: BrokerFailureCode | "request-conflict" | "request-in-flight" | "request-consumed",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;

function assertAdaptiveRequest(
  request: TrustedEvaluationRequest,
): asserts request is TrustedAdaptiveEvaluationRequest {
  assertEvaluationRequest(request);
  if (
    (request.stage !== "repair" && request.stage !== "validation" && request.stage !== "shadow") ||
    request.champion === undefined ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u.test(request.requestId)
  ) {
    throw new TrustedEvaluationBrokerError(
      "evaluation-failed",
      "This broker accepts only matched adaptive evaluations.",
    );
  }
}

function payloadKindFor(
  stage: TrustedAdaptiveEvaluationRequest["stage"],
): SignedResultEnvelope["payload"]["kind"] {
  return stage;
}

function experimentNumber(request: TrustedAdaptiveEvaluationRequest): number {
  const prefix = request.experimentId.split("-", 1)[0] ?? "";
  const value = Number.parseInt(prefix, 10);
  if (!/^\d+$/u.test(prefix) || !Number.isSafeInteger(value) || value < 0) {
    throw new TrustedEvaluationBrokerError(
      "release-validation-failed",
      "Experiment identity cannot be represented in a signed release.",
    );
  }
  return value;
}

function assertAggregate(
  aggregate: TrustedCanonicalAggregate,
  request: TrustedAdaptiveEvaluationRequest,
  requestHash: string,
  rawRun: TrustedRawRun,
): void {
  if (
    aggregate.sensitivity !== "trusted-canonical-aggregate" ||
    aggregate.requestHash !== requestHash ||
    aggregate.protocolHash !== request.protocolHash ||
    aggregate.rawManifestId !== rawRun.manifest.manifestId ||
    aggregate.payload.kind !== payloadKindFor(request.stage) ||
    !SHA256.test(aggregate.normalizedOutcomeSetHash) ||
    !SHA256.test(aggregate.cacheAttestationHash) ||
    (aggregate.behavioralAggregateHash !== null &&
      !SHA256.test(aggregate.behavioralAggregateHash)) ||
    !Number.isFinite(Date.parse(aggregate.derivedAt)) ||
    aggregate.releaseChecks.graderCanaryScanPassed !== true ||
    aggregate.releaseChecks.contentFingerprintScanPassed !== true ||
    aggregate.releaseChecks.taskIdentityScanPassed !== true ||
    aggregate.releaseChecks.privacyThresholdPassed !==
      (aggregate.behavioralAggregateHash !== null) ||
    (request.stage !== "validation" && aggregate.behavioralAggregateHash !== null)
  ) {
    throw new TrustedEvaluationBrokerError(
      "normalization-failed",
      "Canonical evaluation derivation failed its correlation or release checks.",
    );
  }
  assertSafeForLocalPersistence(aggregate);
}

function assertEnvelopeLinks(
  envelope: SignedResultEnvelope,
  request: TrustedAdaptiveEvaluationRequest,
  requestHash: string,
  dispositionAttestationHash?: string,
  aggregate?: TrustedCanonicalAggregate,
  retentionPolicyHash?: string,
): void {
  assertValidDocument("signedResultEnvelope", envelope);
  if (
    envelope.oneUseRequest.requestId !== request.requestId ||
    envelope.oneUseRequest.requestHash !== requestHash ||
    envelope.oneUseRequest.reuseProhibited !== true ||
    envelope.protocolHash !== request.protocolHash ||
    envelope.mode !== request.runMode ||
    envelope.experimentNumber !== experimentNumber(request) ||
    envelope.payload.kind !== payloadKindFor(request.stage) ||
    envelope.derivation.rawArtifacts.exported !== false ||
    envelope.derivation.rawArtifacts.retentionDisposition !== "destroyed"
  ) {
    throw new TrustedEvaluationBrokerError(
      "release-validation-failed",
      "Signed evaluator release does not correlate to its one-use request.",
    );
  }
  if (
    dispositionAttestationHash !== undefined &&
    envelope.oneUseRequest.dispositionAttestationHash !== dispositionAttestationHash
  ) {
    throw new TrustedEvaluationBrokerError(
      "release-validation-failed",
      "Signed evaluator release changed its one-use disposition attestation.",
    );
  }
  if (
    aggregate !== undefined &&
    (envelope.derivation.normalizedOutcomeSetHash !== aggregate.normalizedOutcomeSetHash ||
      envelope.derivation.cacheAttestationHash !== aggregate.cacheAttestationHash ||
      envelope.derivation.behavioralAggregateHash !== aggregate.behavioralAggregateHash ||
      envelope.derivation.derivedAt !== aggregate.derivedAt ||
      envelope.releaseChecks.graderCanaryScanPassed !==
        aggregate.releaseChecks.graderCanaryScanPassed ||
      envelope.releaseChecks.contentFingerprintScanPassed !==
        aggregate.releaseChecks.contentFingerprintScanPassed ||
      envelope.releaseChecks.taskIdentityScanPassed !==
        aggregate.releaseChecks.taskIdentityScanPassed ||
      envelope.releaseChecks.privacyThresholdPassed !==
        aggregate.releaseChecks.privacyThresholdPassed)
  ) {
    throw new TrustedEvaluationBrokerError(
      "release-validation-failed",
      "Signed evaluator release changed its canonical aggregate.",
    );
  }
  if (
    retentionPolicyHash !== undefined &&
    envelope.derivation.rawArtifacts.retentionPolicyHash !== retentionPolicyHash
  ) {
    throw new TrustedEvaluationBrokerError(
      "release-validation-failed",
      "Signed evaluator release changed the raw retention policy.",
    );
  }
  assertSafeForLocalPersistence(envelope);
}

function behavioralSourceResultHash(input: {
  readonly request: TrustedAdaptiveEvaluationRequest;
  readonly requestHash: string;
  readonly panel: TrustedMatchedPanel;
  readonly aggregate: TrustedCanonicalAggregate;
  readonly retentionPolicyHash: string;
}): string {
  return hashResultEnvelopeBehavioralSourceMaterial({
    envelopeId: `release-${input.requestHash.slice(0, 24)}`,
    experimentNumber: experimentNumber(input.request),
    mode: input.request.runMode,
    protocolHash: input.request.protocolHash,
    oneUseRequest: {
      requestId: input.request.requestId,
      requestHash: input.requestHash,
      dispositionAttestationHash: input.panel.dispositionAttestationHash,
      reuseProhibited: true,
    },
    normalizedOutcomeSetHash: input.aggregate.normalizedOutcomeSetHash,
    cacheAttestationHash: input.aggregate.cacheAttestationHash,
    rawArtifacts: {
      exported: false,
      retentionDisposition: "destroyed",
      retentionPolicyHash: input.retentionPolicyHash,
    },
    derivedAt: input.aggregate.derivedAt,
  });
}

function behavioralSourceResultHashFromDisposition(input: {
  readonly request: TrustedAdaptiveEvaluationRequest;
  readonly requestHash: string;
  readonly dispositionAttestationHash: string;
  readonly aggregate: TrustedCanonicalAggregate;
  readonly retentionPolicyHash: string;
}): string {
  return hashResultEnvelopeBehavioralSourceMaterial({
    envelopeId: `release-${input.requestHash.slice(0, 24)}`,
    experimentNumber: experimentNumber(input.request),
    mode: input.request.runMode,
    protocolHash: input.request.protocolHash,
    oneUseRequest: {
      requestId: input.request.requestId,
      requestHash: input.requestHash,
      dispositionAttestationHash: input.dispositionAttestationHash,
      reuseProhibited: true,
    },
    normalizedOutcomeSetHash: input.aggregate.normalizedOutcomeSetHash,
    cacheAttestationHash: input.aggregate.cacheAttestationHash,
    rawArtifacts: {
      exported: false,
      retentionDisposition: "destroyed",
      retentionPolicyHash: input.retentionPolicyHash,
    },
    derivedAt: input.aggregate.derivedAt,
  });
}

function assertBehavioralFinalization(
  finalization: TrustedBehavioralReleaseFinalization,
  requestHash: string,
  expectedSourceSetHash?: string,
): void {
  if (
    (expectedSourceSetHash !== undefined && finalization.sourceSetHash !== expectedSourceSetHash) ||
    !SHA256.test(finalization.sourceSetHash) ||
    !SHA256.test(finalization.contentHash) ||
    !SHA256.test(finalization.authorizationHash) ||
    finalization.requestHash !== requestHash ||
    finalization.privacyThresholdPassed !== true
  ) {
    throw new TrustedEvaluationBrokerError(
      "release-validation-failed",
      "Behavioral release finalization is detached.",
    );
  }
}

function attachBehavioralFinalization(
  aggregate: TrustedCanonicalAggregate,
  finalization: TrustedBehavioralReleaseFinalization,
): TrustedCanonicalAggregate {
  return {
    ...aggregate,
    behavioralAggregateHash: finalization.contentHash,
    releaseChecks: {
      ...aggregate.releaseChecks,
      privacyThresholdPassed: true,
    },
  };
}

function assertBehavioralOrphanFinalization(
  receipt: TrustedBehavioralReleaseOrphanFinalizationReceipt,
  finalization: TrustedBehavioralReleaseFinalization,
): void {
  const orphanedAt = Date.parse(receipt.orphanedAt);
  const expectedHash = hashTrustedBehavioralReleaseOrphanFinalization({
    authorizationHash: receipt.authorizationHash,
    requestHash: receipt.requestHash,
    releaseContentHash: receipt.releaseContentHash,
    sourceSetHash: receipt.sourceSetHash,
    orphanedAt: receipt.orphanedAt,
  });
  if (
    receipt.status !== "orphaned" ||
    receipt.authorizationHash !== finalization.authorizationHash ||
    receipt.requestHash !== finalization.requestHash ||
    receipt.releaseContentHash !== finalization.contentHash ||
    receipt.sourceSetHash !== finalization.sourceSetHash ||
    !Number.isFinite(orphanedAt) ||
    new Date(orphanedAt).toISOString() !== receipt.orphanedAt ||
    receipt.orphanFinalizationHash !== expectedHash
  ) {
    throw new TrustedEvaluationBrokerError(
      "release-validation-failed",
      "Behavioral orphan finalization is detached.",
    );
  }
}

function assertBehavioralPreparationAbandonment(
  receipt: TrustedBehavioralPreparationAbandonmentReceipt,
  input: {
    readonly requestHash: string;
    readonly protocolHash: string;
    readonly preparationHash: string;
    readonly sourceResultEnvelopeHash: string;
    readonly finalizationHash: string;
    readonly orphanFinalizationHash: string;
  },
): void {
  const expectedHash = hashTrustedBehavioralPreparationAbandonment(input);
  if (
    (receipt.status !== "abandoned" && receipt.status !== "already-abandoned") ||
    receipt.requestHash !== input.requestHash ||
    receipt.protocolHash !== input.protocolHash ||
    receipt.preparationHash !== input.preparationHash ||
    receipt.sourceResultEnvelopeHash !== input.sourceResultEnvelopeHash ||
    receipt.finalizationHash !== input.finalizationHash ||
    receipt.orphanFinalizationHash !== input.orphanFinalizationHash ||
    receipt.abandonmentHash !== expectedHash
  ) {
    throw new TrustedEvaluationBrokerError(
      "release-validation-failed",
      "Behavioral preparation abandonment is detached.",
    );
  }
}

export class TrustedEvaluationBroker {
  readonly #options: TrustedEvaluationBrokerOptions;

  constructor(options: TrustedEvaluationBrokerOptions) {
    assertRawRetentionPolicy(options.retentionPolicy);
    assertRawDestructionReceiptVerifier(options.destructionReceiptVerifier);
    if (
      (options.behavioralPreparationStore === undefined) !==
      (options.behavioralReleaseProducer === undefined)
    ) {
      throw new TrustedEvaluationBrokerError(
        "release-validation-failed",
        "The durable behavioral preparation store and finalizer must be composed together.",
      );
    }
    if (
      options.releaseRecoveryStore !== undefined &&
      ((options.releaseRecoveryStore.boundary !== "trusted-cloud" &&
        options.releaseRecoveryStore.boundary !== "test-only-in-memory") ||
        typeof options.releaseRecoveryStore.create !== "function" ||
        typeof options.releaseRecoveryStore.resolve !== "function" ||
        typeof options.releaseRecoveryStore.advance !== "function")
    ) {
      throw new TrustedEvaluationBrokerError(
        "release-validation-failed",
        "The post-destruction recovery store is not a trusted exact-query boundary.",
      );
    }
    this.#options = options;
  }

  #assertRecoveryRecord(
    record: TrustedPostDestructionReleaseRecoveryRecord,
    request: TrustedAdaptiveEvaluationRequest,
    requestHash: string,
  ): void {
    assertPostDestructionReleaseRecoveryRecord(record);
    if (
      record.requestId !== request.requestId ||
      record.requestHash !== requestHash ||
      record.protocolHash !== request.protocolHash ||
      record.retentionPolicyHash !== this.#options.retentionPolicy.policyHash ||
      record.aggregate.requestHash !== requestHash ||
      record.aggregate.protocolHash !== request.protocolHash ||
      record.aggregate.payload.kind !== payloadKindFor(request.stage)
    ) {
      throw new TrustedEvaluationBrokerError(
        "release-validation-failed",
        "Post-destruction recovery state is detached from its request.",
      );
    }
    assertRawDestructionReceipt(
      this.#options.retentionPolicy,
      record.rawManifest,
      record.destructionReceipt,
      this.#options.destructionReceiptVerifier,
    );
    if (record.envelope !== null) {
      assertEnvelopeLinks(
        record.envelope,
        request,
        requestHash,
        record.dispositionAttestationHash,
        record.aggregate,
        record.retentionPolicyHash,
      );
    }
  }

  async #resolveRecoveryRecord(
    request: TrustedAdaptiveEvaluationRequest,
    requestHash: string,
  ): Promise<TrustedPostDestructionReleaseRecoveryRecord | null> {
    const store = this.#options.releaseRecoveryStore;
    if (store === undefined) return null;
    const resolution = await store.resolve({
      requestHash,
      protocolHash: request.protocolHash,
    });
    if (
      resolution.requestHash !== requestHash ||
      resolution.protocolHash !== request.protocolHash
    ) {
      throw new TrustedEvaluationBrokerError(
        "release-validation-failed",
        "Release recovery lookup is detached.",
      );
    }
    if (resolution.status === "missing") return null;
    if (resolution.record === undefined) {
      throw new TrustedEvaluationBrokerError(
        "release-validation-failed",
        "Release recovery lookup omitted its exact record.",
      );
    }
    this.#assertRecoveryRecord(resolution.record, request, requestHash);
    return resolution.record;
  }

  async #createRecoveryRecord(
    record: TrustedPostDestructionReleaseRecoveryRecord,
    request: TrustedAdaptiveEvaluationRequest,
    requestHash: string,
  ): Promise<TrustedPostDestructionReleaseRecoveryRecord> {
    const store = this.#options.releaseRecoveryStore;
    if (store === undefined) return record;
    this.#assertRecoveryRecord(record, request, requestHash);
    try {
      const receipt = await store.create(record);
      if (
        (receipt.status !== "created" && receipt.status !== "already-created") ||
        receipt.requestHash !== requestHash ||
        receipt.protocolHash !== request.protocolHash ||
        receipt.revision !== record.revision ||
        receipt.recordHash !== record.recordHash
      ) {
        throw new Error("Detached recovery create receipt.");
      }
    } catch {
      const recovered = await this.#resolveRecoveryRecord(request, requestHash);
      if (recovered === null || recovered.recordHash !== record.recordHash) {
        throw new TrustedEvaluationBrokerError(
          "release-validation-failed",
          "Post-destruction checkpoint durability is ambiguous.",
        );
      }
      return recovered;
    }
    const recovered = await this.#resolveRecoveryRecord(request, requestHash);
    if (recovered === null || recovered.recordHash !== record.recordHash) {
      throw new TrustedEvaluationBrokerError(
        "release-validation-failed",
        "Post-destruction checkpoint could not be read back exactly.",
      );
    }
    return recovered;
  }

  async #advanceRecoveryRecord(
    prior: TrustedPostDestructionReleaseRecoveryRecord,
    next: TrustedPostDestructionReleaseRecoveryRecord,
    request: TrustedAdaptiveEvaluationRequest,
    requestHash: string,
  ): Promise<TrustedPostDestructionReleaseRecoveryRecord> {
    const store = this.#options.releaseRecoveryStore;
    if (store === undefined) return next;
    this.#assertRecoveryRecord(prior, request, requestHash);
    this.#assertRecoveryRecord(next, request, requestHash);
    try {
      const receipt = await store.advance({
        requestHash,
        protocolHash: request.protocolHash,
        priorRecordHash: prior.recordHash,
        next,
      });
      if (
        (receipt.status !== "advanced" && receipt.status !== "already-advanced") ||
        receipt.requestHash !== requestHash ||
        receipt.protocolHash !== request.protocolHash ||
        receipt.revision !== next.revision ||
        receipt.recordHash !== next.recordHash
      ) {
        throw new Error("Detached recovery advance receipt.");
      }
    } catch {
      const recovered = await this.#resolveRecoveryRecord(request, requestHash);
      if (recovered === null || recovered.recordHash !== next.recordHash) {
        throw new TrustedEvaluationBrokerError(
          "release-validation-failed",
          "Post-destruction recovery transition is ambiguous.",
        );
      }
      return recovered;
    }
    const recovered = await this.#resolveRecoveryRecord(request, requestHash);
    if (recovered === null || recovered.recordHash !== next.recordHash) {
      throw new TrustedEvaluationBrokerError(
        "release-validation-failed",
        "Post-destruction recovery transition could not be read back exactly.",
      );
    }
    return recovered;
  }

  #nextRecoveryRecord(
    prior: TrustedPostDestructionReleaseRecoveryRecord,
    changes: Partial<Omit<TrustedPostDestructionReleaseRecoveryRecord, "recordHash" | "revision">>,
  ): TrustedPostDestructionReleaseRecoveryRecord {
    const { recordHash: _recordHash, revision: _revision, ...current } = prior;
    return sealPostDestructionReleaseRecoveryRecord({
      ...current,
      ...changes,
      revision: prior.revision + 1,
    });
  }

  async #initialRecoveryBehavioralState(input: {
    readonly request: TrustedAdaptiveEvaluationRequest;
    readonly requestHash: string;
    readonly dispositionAttestationHash: string;
    readonly aggregate: TrustedCanonicalAggregate;
  }): Promise<TrustedReleaseRecoveryBehavioralState> {
    const preparationStore = this.#options.behavioralPreparationStore;
    if (preparationStore === undefined) {
      return { status: "none" };
    }
    const resolution = await preparationStore.resolve({
      requestHash: input.requestHash,
      protocolHash: input.request.protocolHash,
    });
    if (
      resolution.requestHash !== input.requestHash ||
      resolution.protocolHash !== input.request.protocolHash
    ) {
      throw new TrustedEvaluationBrokerError(
        "release-validation-failed",
        "Behavioral preparation checkpoint lookup is detached.",
      );
    }
    if (resolution.status === "missing") {
      return { status: "none" };
    }
    if (resolution.status !== "prepared") {
      throw new TrustedEvaluationBrokerError(
        "release-validation-failed",
        "A fresh post-destruction checkpoint found non-fresh behavioral state.",
      );
    }
    const preparationHash = hashTrustedBehavioralPreparation(resolution.preparation);
    if (
      preparationHash !== resolution.preparationHash ||
      resolution.preparation.requestHash !== input.requestHash ||
      resolution.preparation.protocolHash !== input.request.protocolHash
    ) {
      throw new TrustedEvaluationBrokerError(
        "release-validation-failed",
        "Behavioral preparation checkpoint is detached.",
      );
    }
    return {
      status: "prepared",
      preparationHash,
      sourceResultEnvelopeHash: behavioralSourceResultHashFromDisposition({
        request: input.request,
        requestHash: input.requestHash,
        dispositionAttestationHash: input.dispositionAttestationHash,
        aggregate: input.aggregate,
        retentionPolicyHash: this.#options.retentionPolicy.policyHash,
      }),
    };
  }

  async #recoverPostDestruction(
    request: TrustedAdaptiveEvaluationRequest,
    requestHash: string,
    initialRecord: TrustedPostDestructionReleaseRecoveryRecord,
  ): Promise<SignedResultEnvelope> {
    this.#assertRecoveryRecord(initialRecord, request, requestHash);
    const recoveredClaim = await this.#options.ledger.recoverInFlight({
      requestId: request.requestId,
      requestHash,
      recoveryRecordHash: initialRecord.recordHash,
    });
    assertOneUseClaim(recoveredClaim);
    if (recoveredClaim.state === "conflict") {
      throw new TrustedEvaluationBrokerError(
        "request-conflict",
        "Recovery found a one-use claim bound to different input.",
      );
    }
    if (recoveredClaim.state === "consumed") {
      if (initialRecord.status !== "failed") {
        throw new TrustedEvaluationBrokerError(
          "release-validation-failed",
          "Consumed ledger state conflicts with an open recovery record.",
        );
      }
      throw new TrustedEvaluationBrokerError(
        "request-consumed",
        "This recovered evaluation was already consumed.",
      );
    }
    if (recoveredClaim.state === "in-flight") {
      throw new TrustedEvaluationBrokerError(
        "request-in-flight",
        "The prior controller could not be fenced for recovery.",
      );
    }
    if (recoveredClaim.state === "completed") {
      if (
        initialRecord.envelope === null ||
        initialRecord.envelopeHash === null ||
        hashResultCompletionEnvelope(recoveredClaim.envelope) !== initialRecord.envelopeHash ||
        canonicalHash({
          domain: "dark-factory.one-use-result-completion-envelope.v1",
          envelope: recoveredClaim.envelope,
        }) !== initialRecord.envelopeHash
      ) {
        throw new TrustedEvaluationBrokerError(
          "release-validation-failed",
          "Completed ledger result is not the exact checkpointed envelope.",
        );
      }
      assertEnvelopeLinks(
        recoveredClaim.envelope,
        request,
        requestHash,
        initialRecord.dispositionAttestationHash,
        initialRecord.aggregate,
        initialRecord.retentionPolicyHash,
      );
      if (!(await this.#options.verifier.verify(recoveredClaim.envelope))) {
        throw new TrustedEvaluationBrokerError(
          "release-validation-failed",
          "Recovered completed result failed signature verification.",
        );
      }
      if (initialRecord.status === "result-issued") {
        await this.#advanceRecoveryRecord(
          initialRecord,
          this.#nextRecoveryRecord(initialRecord, {
            status: "completed",
          }),
          request,
          requestHash,
        );
      } else if (initialRecord.status !== "completed") {
        throw new TrustedEvaluationBrokerError(
          "release-validation-failed",
          "Completed ledger state conflicts with recovery disposition.",
        );
      }
      return recoveredClaim.envelope;
    }

    let current = initialRecord;
    if (current.status === "failed") {
      if (current.failureCode === null) {
        throw new TrustedEvaluationBrokerError(
          "release-validation-failed",
          "Failed recovery state omitted its terminal failure code.",
        );
      }
      await this.#options.ledger.consumeFailure(
        recoveredClaim.claimToken,
        requestHash,
        current.failureCode,
      );
      throw new TrustedEvaluationBrokerError(
        "request-consumed",
        "Recovered terminal failure was reconciled with the one-use ledger.",
      );
    }
    if (current.status === "completed") {
      throw new TrustedEvaluationBrokerError(
        "release-validation-failed",
        "An in-flight ledger claim conflicts with terminal recovery state.",
      );
    }
    let failureCode: BrokerFailureCode = "release-validation-failed";
    let finalizeAttempted = false;
    let finalizeResolved = false;
    let completionAttempted = false;
    let completionKnownNotCommitted = true;
    try {
      if (current.status === "result-issued" && current.behavioral.status === "finalized") {
        const preparationStore = this.#options.behavioralPreparationStore;
        if (preparationStore === undefined) {
          throw new TrustedEvaluationBrokerError(
            "release-validation-failed",
            "Checkpointed finalized result has no preparation authority.",
          );
        }
        const resolution = await preparationStore.resolve({
          requestHash,
          protocolHash: request.protocolHash,
        });
        if (
          resolution.status === "abandoned" &&
          resolution.preparationHash === current.behavioral.preparationHash &&
          resolution.sourceResultEnvelopeHash === current.behavioral.sourceResultEnvelopeHash &&
          resolution.finalizationHash === current.behavioral.finalizationHash
        ) {
          current = await this.#advanceRecoveryRecord(
            current,
            this.#nextRecoveryRecord(current, {
              status: "failed",
              failureCode: "release-validation-failed",
              behavioral: {
                ...current.behavioral,
                status: "abandoned",
                orphanFinalizationHash: resolution.orphanFinalizationHash,
                orphanFinalization: resolution.orphanFinalization,
                abandonmentHash: resolution.abandonmentHash,
              },
            }),
            request,
            requestHash,
          );
          throw new TrustedEvaluationBrokerError(
            "release-validation-failed",
            "A permanently orphaned behavioral release cannot complete a result.",
          );
        }
        if (
          resolution.status !== "finalized" ||
          resolution.preparationHash !== current.behavioral.preparationHash ||
          resolution.sourceResultEnvelopeHash !== current.behavioral.sourceResultEnvelopeHash ||
          resolution.finalizationHash !== current.behavioral.finalizationHash ||
          canonicalHash(resolution.finalization) !== canonicalHash(current.behavioral.finalization)
        ) {
          throw new TrustedEvaluationBrokerError(
            "release-validation-failed",
            "Checkpointed result conflicts with behavioral release state.",
          );
        }
      }
      if (current.status === "open") {
        const preparationStore = this.#options.behavioralPreparationStore;
        const producer = this.#options.behavioralReleaseProducer;
        if (current.behavioral.status === "prepared") {
          if (preparationStore === undefined || producer === undefined) {
            throw new TrustedEvaluationBrokerError(
              "release-validation-failed",
              "Checkpointed behavioral preparation has no trusted recovery ports.",
            );
          }
          const resolution = await preparationStore.resolve({
            requestHash,
            protocolHash: request.protocolHash,
          });
          if (
            resolution.requestHash !== requestHash ||
            resolution.protocolHash !== request.protocolHash
          ) {
            throw new TrustedEvaluationBrokerError(
              "release-validation-failed",
              "Recovered behavioral preparation lookup is detached.",
            );
          }
          if (resolution.status === "prepared") {
            const preparationHash = hashTrustedBehavioralPreparation(resolution.preparation);
            if (
              preparationHash !== current.behavioral.preparationHash ||
              preparationHash !== resolution.preparationHash ||
              current.behavioral.sourceResultEnvelopeHash !==
                behavioralSourceResultHashFromDisposition({
                  request,
                  requestHash,
                  dispositionAttestationHash: current.dispositionAttestationHash,
                  aggregate: current.aggregate,
                  retentionPolicyHash: current.retentionPolicyHash,
                })
            ) {
              throw new TrustedEvaluationBrokerError(
                "release-validation-failed",
                "Recovered behavioral preparation changed.",
              );
            }
            finalizeAttempted = true;
            const finalized = await producer.finalize({
              preparation: resolution.preparation,
              sourceResultEnvelopeHash: current.behavioral.sourceResultEnvelopeHash,
              destructionReceipt: current.destructionReceipt,
            });
            finalizeResolved = true;
            if (finalized === null) {
              const consumption = await preparationStore.consume({
                requestHash,
                protocolHash: request.protocolHash,
              });
              if (
                (consumption.status !== "consumed" && consumption.status !== "already-consumed") ||
                consumption.requestHash !== requestHash ||
                consumption.protocolHash !== request.protocolHash ||
                consumption.preparationHash !== preparationHash
              ) {
                throw new TrustedEvaluationBrokerError(
                  "release-validation-failed",
                  "Recovered preparation consumption is detached.",
                );
              }
              current = await this.#advanceRecoveryRecord(
                current,
                this.#nextRecoveryRecord(current, {
                  behavioral: {
                    status: "consumed",
                    preparationHash,
                  },
                }),
                request,
                requestHash,
              );
            } else {
              assertBehavioralFinalization(
                finalized,
                requestHash,
                resolution.preparation.behaviorSourceSetHash,
              );
              const aggregate = attachBehavioralFinalization(current.aggregate, finalized);
              const finalizationHash = hashTrustedBehavioralPreparationFinalization({
                requestHash,
                protocolHash: request.protocolHash,
                preparationHash,
                sourceResultEnvelopeHash: current.behavioral.sourceResultEnvelopeHash,
                finalization: finalized,
              });
              const receipt = await preparationStore.finalize({
                requestHash,
                protocolHash: request.protocolHash,
                preparationHash,
                sourceResultEnvelopeHash: current.behavioral.sourceResultEnvelopeHash,
                finalization: finalized,
              });
              if (
                (receipt.status !== "finalized" && receipt.status !== "already-finalized") ||
                receipt.requestHash !== requestHash ||
                receipt.protocolHash !== request.protocolHash ||
                receipt.preparationHash !== preparationHash ||
                receipt.sourceResultEnvelopeHash !== current.behavioral.sourceResultEnvelopeHash ||
                receipt.finalizationHash !== finalizationHash
              ) {
                throw new TrustedEvaluationBrokerError(
                  "release-validation-failed",
                  "Recovered behavioral finalization receipt is detached.",
                );
              }
              current = await this.#advanceRecoveryRecord(
                current,
                this.#nextRecoveryRecord(current, {
                  aggregate,
                  behavioral: {
                    status: "finalized",
                    preparationHash,
                    sourceResultEnvelopeHash: current.behavioral.sourceResultEnvelopeHash,
                    finalizationHash,
                    finalization: finalized,
                  },
                }),
                request,
                requestHash,
              );
            }
          } else if (resolution.status === "finalized" || resolution.status === "abandoned") {
            const finalization =
              resolution.status === "finalized"
                ? resolution.finalization
                : {
                    contentHash: resolution.orphanFinalization.releaseContentHash,
                    sourceSetHash: resolution.orphanFinalization.sourceSetHash,
                    privacyThresholdPassed: true as const,
                    authorizationHash: resolution.orphanFinalization.authorizationHash,
                    requestHash: resolution.orphanFinalization.requestHash,
                  };
            const finalizationHash = hashTrustedBehavioralPreparationFinalization({
              requestHash,
              protocolHash: request.protocolHash,
              preparationHash: current.behavioral.preparationHash,
              sourceResultEnvelopeHash: current.behavioral.sourceResultEnvelopeHash,
              finalization,
            });
            if (
              resolution.preparationHash !== current.behavioral.preparationHash ||
              resolution.sourceResultEnvelopeHash !== current.behavioral.sourceResultEnvelopeHash ||
              resolution.finalizationHash !== finalizationHash
            ) {
              throw new TrustedEvaluationBrokerError(
                "release-validation-failed",
                "Recovered durable behavioral finalization changed.",
              );
            }
            const aggregate = attachBehavioralFinalization(current.aggregate, finalization);
            const behavioral: TrustedReleaseRecoveryBehavioralState =
              resolution.status === "finalized"
                ? {
                    status: "finalized",
                    preparationHash: resolution.preparationHash,
                    sourceResultEnvelopeHash: resolution.sourceResultEnvelopeHash,
                    finalizationHash,
                    finalization,
                  }
                : {
                    status: "abandoned",
                    preparationHash: resolution.preparationHash,
                    sourceResultEnvelopeHash: resolution.sourceResultEnvelopeHash,
                    finalizationHash,
                    finalization,
                    orphanFinalizationHash: resolution.orphanFinalizationHash,
                    orphanFinalization: resolution.orphanFinalization,
                    abandonmentHash: resolution.abandonmentHash,
                  };
            current = await this.#advanceRecoveryRecord(
              current,
              this.#nextRecoveryRecord(current, {
                aggregate,
                behavioral,
              }),
              request,
              requestHash,
            );
          } else if (resolution.status === "consumed") {
            if (resolution.preparationHash !== current.behavioral.preparationHash) {
              throw new TrustedEvaluationBrokerError(
                "release-validation-failed",
                "Recovered consumed preparation changed.",
              );
            }
            current = await this.#advanceRecoveryRecord(
              current,
              this.#nextRecoveryRecord(current, {
                behavioral: {
                  status: "consumed",
                  preparationHash: resolution.preparationHash,
                },
              }),
              request,
              requestHash,
            );
          } else {
            throw new TrustedEvaluationBrokerError(
              "release-validation-failed",
              "Checkpointed behavioral preparation is missing.",
            );
          }
        } else if (current.behavioral.status === "finalized") {
          if (preparationStore === undefined || producer === undefined) {
            throw new TrustedEvaluationBrokerError(
              "release-validation-failed",
              "Finalized recovery state has no trusted lifecycle ports.",
            );
          }
          const resolution = await preparationStore.resolve({
            requestHash,
            protocolHash: request.protocolHash,
          });
          if (resolution.status === "abandoned") {
            if (
              resolution.preparationHash !== current.behavioral.preparationHash ||
              resolution.sourceResultEnvelopeHash !== current.behavioral.sourceResultEnvelopeHash ||
              resolution.finalizationHash !== current.behavioral.finalizationHash
            ) {
              throw new TrustedEvaluationBrokerError(
                "release-validation-failed",
                "Recovered abandoned preparation changed.",
              );
            }
            current = await this.#advanceRecoveryRecord(
              current,
              this.#nextRecoveryRecord(current, {
                behavioral: {
                  ...current.behavioral,
                  status: "abandoned",
                  orphanFinalizationHash: resolution.orphanFinalizationHash,
                  orphanFinalization: resolution.orphanFinalization,
                  abandonmentHash: resolution.abandonmentHash,
                },
              }),
              request,
              requestHash,
            );
          } else if (
            resolution.status !== "finalized" ||
            resolution.preparationHash !== current.behavioral.preparationHash ||
            resolution.sourceResultEnvelopeHash !== current.behavioral.sourceResultEnvelopeHash ||
            resolution.finalizationHash !== current.behavioral.finalizationHash ||
            canonicalHash(resolution.finalization) !==
              canonicalHash(current.behavioral.finalization)
          ) {
            throw new TrustedEvaluationBrokerError(
              "release-validation-failed",
              "Recovered finalized preparation is detached.",
            );
          }
        }
        if (current.behavioral.status === "abandoned") {
          throw new TrustedEvaluationBrokerError(
            "release-validation-failed",
            "A permanently orphaned behavioral release cannot issue a result.",
          );
        }
        const envelope = await this.#options.issuer.issue({
          request,
          requestHash,
          dispositionAttestationHash: current.dispositionAttestationHash,
          aggregate: current.aggregate,
          destructionReceipt: current.destructionReceipt,
          retentionPolicyHash: current.retentionPolicyHash,
        });
        assertEnvelopeLinks(
          envelope,
          request,
          requestHash,
          current.dispositionAttestationHash,
          current.aggregate,
          current.retentionPolicyHash,
        );
        if (!(await this.#options.verifier.verify(envelope))) {
          throw new TrustedEvaluationBrokerError(
            "release-validation-failed",
            "Recovered evaluator result failed signature verification.",
          );
        }
        current = await this.#advanceRecoveryRecord(
          current,
          this.#nextRecoveryRecord(current, {
            status: "result-issued",
            envelope,
            envelopeHash: hashResultCompletionEnvelope(envelope),
          }),
          request,
          requestHash,
        );
      }
      if (
        current.status !== "result-issued" ||
        current.envelope === null ||
        current.envelopeHash === null ||
        current.behavioral.status === "abandoned"
      ) {
        throw new TrustedEvaluationBrokerError(
          "release-validation-failed",
          "Recovered release is not eligible for result completion.",
        );
      }
      assertEnvelopeLinks(
        current.envelope,
        request,
        requestHash,
        current.dispositionAttestationHash,
        current.aggregate,
        current.retentionPolicyHash,
      );
      if (!(await this.#options.verifier.verify(current.envelope))) {
        throw new TrustedEvaluationBrokerError(
          "release-validation-failed",
          "Checkpointed result failed signature verification.",
        );
      }
      completionAttempted = true;
      await this.#options.ledger.complete(
        recoveredClaim.claimToken,
        requestHash,
        current.dispositionAttestationHash,
        current.envelope,
      );
      current = await this.#advanceRecoveryRecord(
        current,
        this.#nextRecoveryRecord(current, {
          status: "completed",
        }),
        request,
        requestHash,
      );
      return current.envelope as SignedResultEnvelope;
    } catch (error) {
      failureCode =
        error instanceof TrustedEvaluationBrokerError
          ? error.code === "request-conflict" ||
            error.code === "request-in-flight" ||
            error.code === "request-consumed"
            ? "release-validation-failed"
            : error.code
          : "release-validation-failed";
      if (completionAttempted) {
        try {
          const inspection = await this.#options.ledger.inspect(request.requestId, requestHash);
          assertOneUseLedgerInspection(inspection);
          if (inspection.state === "completed") {
            if (
              current.envelope === null ||
              current.envelopeHash === null ||
              hashResultCompletionEnvelope(inspection.envelope) !== current.envelopeHash
            ) {
              throw new Error("Recovered completion substituted another envelope.");
            }
            assertEnvelopeLinks(
              inspection.envelope,
              request,
              requestHash,
              current.dispositionAttestationHash,
              current.aggregate,
              current.retentionPolicyHash,
            );
            if (!(await this.#options.verifier.verify(inspection.envelope))) {
              throw new Error("Recovered completion failed verification.");
            }
            if (current.status === "result-issued") {
              current = await this.#advanceRecoveryRecord(
                current,
                this.#nextRecoveryRecord(current, {
                  status: "completed",
                }),
                request,
                requestHash,
              );
            }
            return inspection.envelope;
          }
          completionKnownNotCommitted =
            inspection.state === "in-flight" || inspection.state === "consumed";
        } catch {
          completionKnownNotCommitted = false;
        }
      }
      const finalizeFailed = finalizeAttempted && !finalizeResolved;
      const finalizeKnownNotCommitted =
        finalizeFailed &&
        error instanceof TrustedBehavioralReleaseProducerError &&
        error.finalizationDisposition === "known-not-committed";
      let cleanupVerified =
        current.behavioral.status === "none" ||
        current.behavioral.status === "consumed" ||
        current.behavioral.status === "abandoned";
      if (
        completionKnownNotCommitted &&
        current.behavioral.status === "finalized" &&
        this.#options.behavioralReleaseProducer !== undefined &&
        this.#options.behavioralPreparationStore !== undefined
      ) {
        try {
          const orphan = await this.#options.behavioralReleaseProducer.orphan(
            current.behavioral.finalization,
          );
          assertBehavioralOrphanFinalization(orphan, current.behavioral.finalization);
          const abandonment = await this.#options.behavioralPreparationStore.abandon({
            requestHash,
            protocolHash: request.protocolHash,
            preparationHash: current.behavioral.preparationHash,
            sourceResultEnvelopeHash: current.behavioral.sourceResultEnvelopeHash,
            finalizationHash: current.behavioral.finalizationHash,
            orphanFinalization: orphan,
          });
          assertBehavioralPreparationAbandonment(abandonment, {
            requestHash,
            protocolHash: request.protocolHash,
            preparationHash: current.behavioral.preparationHash,
            sourceResultEnvelopeHash: current.behavioral.sourceResultEnvelopeHash,
            finalizationHash: current.behavioral.finalizationHash,
            orphanFinalizationHash: orphan.orphanFinalizationHash,
          });
          current = await this.#advanceRecoveryRecord(
            current,
            this.#nextRecoveryRecord(current, {
              ...(current.status === "result-issued"
                ? {
                    status: "failed" as const,
                    failureCode,
                  }
                : {}),
              behavioral: {
                ...current.behavioral,
                status: "abandoned",
                orphanFinalizationHash: orphan.orphanFinalizationHash,
                orphanFinalization: orphan,
                abandonmentHash: abandonment.abandonmentHash,
              },
            }),
            request,
            requestHash,
          );
          cleanupVerified = true;
        } catch {
          cleanupVerified = false;
        }
      } else if (
        completionKnownNotCommitted &&
        current.behavioral.status === "prepared" &&
        finalizeKnownNotCommitted &&
        this.#options.behavioralPreparationStore !== undefined
      ) {
        try {
          const consumption = await this.#options.behavioralPreparationStore.consume({
            requestHash,
            protocolHash: request.protocolHash,
          });
          if (
            (consumption.status !== "consumed" && consumption.status !== "already-consumed") ||
            consumption.preparationHash !== current.behavioral.preparationHash
          ) {
            throw new Error("Recovered preparation cleanup is detached.");
          }
          current = await this.#advanceRecoveryRecord(
            current,
            this.#nextRecoveryRecord(current, {
              behavioral: {
                status: "consumed",
                preparationHash: current.behavioral.preparationHash,
              },
            }),
            request,
            requestHash,
          );
          cleanupVerified = true;
        } catch {
          cleanupVerified = false;
        }
      } else if (
        current.behavioral.status === "prepared" ||
        (finalizeFailed && !finalizeKnownNotCommitted)
      ) {
        cleanupVerified = false;
      }
      if (completionKnownNotCommitted && cleanupVerified) {
        try {
          if (current.status !== "failed" && current.status !== "completed") {
            current = await this.#advanceRecoveryRecord(
              current,
              this.#nextRecoveryRecord(current, {
                status: "failed",
                failureCode,
              }),
              request,
              requestHash,
            );
          }
          await this.#options.ledger.consumeFailure(
            recoveredClaim.claimToken,
            requestHash,
            failureCode,
          );
        } catch {
          /*
           * Preserve the in-flight claim when either terminal record or
           * ledger acknowledgement is ambiguous. The next fenced recovery
           * reconciles both exact stores.
           */
        }
      }
      throw new TrustedEvaluationBrokerError(
        failureCode,
        "Post-destruction recovery failed closed without rerunning hidden tasks.",
      );
    }
  }

  async evaluate(request: TrustedEvaluationRequest): Promise<SignedResultEnvelope> {
    assertAdaptiveRequest(request);
    experimentNumber(request);
    if (
      request.evaluatedModel.provider !== this.#options.agent.evaluatedModel.provider ||
      request.evaluatedModel.modelId !== this.#options.agent.evaluatedModel.modelId ||
      request.evaluatedModel.thinkingLevel !== this.#options.agent.evaluatedModel.thinkingLevel
    ) {
      throw new TrustedEvaluationBrokerError(
        "evaluation-failed",
        "Pinned Pi agent model does not match the immutable evaluation request.",
      );
    }
    const requestHash = hashEvaluationRequest(request);
    const claim = await this.#options.ledger.claim(request.requestId, requestHash);
    assertOneUseClaim(claim);

    if (claim.state === "conflict") {
      throw new TrustedEvaluationBrokerError(
        "request-conflict",
        "This request identifier is already bound to different immutable input.",
      );
    }
    if (claim.state === "in-flight") {
      const recoveryRecord = await this.#resolveRecoveryRecord(request, requestHash);
      if (recoveryRecord !== null) {
        return this.#recoverPostDestruction(request, requestHash, recoveryRecord);
      }
      throw new TrustedEvaluationBrokerError(
        "request-in-flight",
        "This one-use evaluation is in progress and has no exact post-destruction recovery record.",
      );
    }
    if (claim.state === "consumed") {
      throw new TrustedEvaluationBrokerError(
        "request-consumed",
        "This one-use evaluation was consumed without a releasable result.",
      );
    }
    if (claim.state === "completed") {
      if (claim.requestHash !== requestHash) {
        throw new TrustedEvaluationBrokerError(
          "request-conflict",
          "Completed result does not belong to this immutable request.",
        );
      }
      assertEnvelopeLinks(claim.envelope, request, requestHash);
      let verified = false;
      try {
        verified = await this.#options.verifier.verify(claim.envelope);
      } catch {
        verified = false;
      }
      if (!verified) {
        throw new TrustedEvaluationBrokerError(
          "release-validation-failed",
          "Stored signed evaluator release failed signature verification.",
        );
      }
      const recoveryRecord = await this.#resolveRecoveryRecord(request, requestHash);
      if (
        recoveryRecord !== null &&
        recoveryRecord.status === "result-issued" &&
        recoveryRecord.envelopeHash === hashResultCompletionEnvelope(claim.envelope)
      ) {
        await this.#advanceRecoveryRecord(
          recoveryRecord,
          this.#nextRecoveryRecord(recoveryRecord, {
            status: "completed",
          }),
          request,
          requestHash,
        );
      } else if (
        recoveryRecord !== null &&
        (recoveryRecord.status !== "completed" ||
          recoveryRecord.envelopeHash !== hashResultCompletionEnvelope(claim.envelope))
      ) {
        throw new TrustedEvaluationBrokerError(
          "release-validation-failed",
          "Completed result conflicts with its durable recovery record.",
        );
      }
      return claim.envelope;
    }

    let rawRun: TrustedRawRun | undefined;
    let rawDestroyed = false;
    let panel: TrustedMatchedPanel | undefined;
    let onlineErrorReservation: TrustedOnlineErrorBudgetReservation | null = null;
    let behavioralFinalization: TrustedBehavioralReleaseFinalization | null = null;
    let behavioralPreparationHash: string | null = null;
    let behavioralSourceResultEnvelopeHash: string | null = null;
    let behavioralPreparationFinalizationHash: string | null = null;
    let behavioralFinalizeAttempted = false;
    let behavioralFinalizeResolved = false;
    let completionAttempted = false;
    let attemptedEnvelopeHash: string | null = null;
    let recoveryRecord: TrustedPostDestructionReleaseRecoveryRecord | null = null;
    let recoveryCheckpointAttempted = false;
    let failureCode: BrokerFailureCode = "evaluation-failed";
    try {
      failureCode = "panel-allocation-failed";
      panel = await this.#options.panels.allocateAndConsume(request, requestHash, claim.claimToken);
      assertTrustedMatchedPanel(panel);
      if (panel.requestId !== request.requestId || panel.stage !== request.stage) {
        throw new TrustedEvaluationBrokerError(
          "panel-allocation-failed",
          "Hidden panel lease does not correlate to the one-use request.",
        );
      }
      const attestationBound = await this.#options.ledger.bindDispositionAttestation(
        claim.claimToken,
        requestHash,
        panel.dispositionAttestationHash,
      );
      if (!attestationBound) {
        throw new TrustedEvaluationBrokerError(
          "panel-allocation-failed",
          "One-use disposition attestation was already consumed.",
        );
      }

      failureCode = "evaluation-failed";
      onlineErrorReservation =
        request.stage === "validation"
          ? await this.#options.onlineErrorAuthority.reserve({
              request,
              requestHash,
              dispositionAttestationHash: panel.dispositionAttestationHash,
            })
          : null;

      const schedule = createTrustedMatchedArmSchedule(panel, request.candidate, request.champion);
      const runRequest: TrustedTerminalBenchRunRequest = {
        sensitivity: "hidden-terminal-bench-run-request",
        requestId: request.requestId,
        panel,
        schedule,
        agent: this.#options.agent,
      };
      failureCode = "runtime-attestation-failed";
      rawRun = await this.#options.runner.run(runRequest);

      failureCode = "normalization-failed";
      let aggregate = await this.#options.deriver.derive({
        request,
        panel,
        schedule,
        rawRun,
        onlineErrorReservation,
      });
      assertAggregate(aggregate, request, requestHash, rawRun);

      failureCode = "raw-destruction-failed";
      const destructionReceipt = await this.#options.custodian.destroy(rawRun);
      assertRawDestructionReceipt(
        this.#options.retentionPolicy,
        rawRun.manifest,
        destructionReceipt,
        this.#options.destructionReceiptVerifier,
      );
      rawDestroyed = true;

      failureCode = "release-validation-failed";
      if (this.#options.releaseRecoveryStore !== undefined) {
        const recoveryBehavioral = await this.#initialRecoveryBehavioralState({
          request,
          requestHash,
          dispositionAttestationHash: panel.dispositionAttestationHash,
          aggregate,
        });
        recoveryCheckpointAttempted = true;
        recoveryRecord = await this.#createRecoveryRecord(
          sealPostDestructionReleaseRecoveryRecord({
            schemaVersion: 1,
            sensitivity: "trusted-private-post-destruction-release-recovery",
            requestId: request.requestId,
            requestHash,
            protocolHash: request.protocolHash,
            dispositionAttestationHash: panel.dispositionAttestationHash,
            retentionPolicyHash: this.#options.retentionPolicy.policyHash,
            rawManifest: rawRun.manifest,
            destructionReceipt,
            aggregate,
            behavioral: recoveryBehavioral,
            status: "open",
            envelope: null,
            envelopeHash: null,
            failureCode: null,
            revision: 1,
          }),
          request,
          requestHash,
        );
      }
      const behavioralProducer = this.#options.behavioralReleaseProducer;
      if (behavioralProducer !== undefined) {
        const preparationStore = this.#options.behavioralPreparationStore;
        let preparation: TrustedPrivateBehavioralPreparation | null = null;
        let recoveredFinalization: {
          readonly preparationHash: string;
          readonly sourceResultEnvelopeHash: string;
          readonly finalizationHash: string;
          readonly finalization: TrustedBehavioralReleaseFinalization;
        } | null = null;

        if (preparationStore === undefined) {
          throw new TrustedEvaluationBrokerError(
            "release-validation-failed",
            "Behavioral finalization requires a durable preparation store.",
          );
        }
        const resolution = await preparationStore.resolve({
          requestHash,
          protocolHash: request.protocolHash,
        });
        if (
          resolution.requestHash !== requestHash ||
          resolution.protocolHash !== request.protocolHash
        ) {
          throw new TrustedEvaluationBrokerError(
            "release-validation-failed",
            "Behavioral preparation resolution is detached.",
          );
        }
        if (resolution.status === "prepared") {
          behavioralPreparationHash = hashTrustedBehavioralPreparation(resolution.preparation);
          if (
            behavioralPreparationHash !== resolution.preparationHash ||
            resolution.preparation.requestHash !== requestHash ||
            resolution.preparation.protocolHash !== request.protocolHash
          ) {
            throw new TrustedEvaluationBrokerError(
              "release-validation-failed",
              "Durable behavioral preparation is detached.",
            );
          }
          preparation = resolution.preparation;
        } else if (resolution.status === "finalized") {
          const expectedFinalizationHash = hashTrustedBehavioralPreparationFinalization({
            requestHash,
            protocolHash: request.protocolHash,
            preparationHash: resolution.preparationHash,
            sourceResultEnvelopeHash: resolution.sourceResultEnvelopeHash,
            finalization: resolution.finalization,
          });
          if (
            !SHA256.test(resolution.preparationHash) ||
            resolution.finalizationHash !== expectedFinalizationHash
          ) {
            throw new TrustedEvaluationBrokerError(
              "release-validation-failed",
              "Durable behavioral finalization is detached.",
            );
          }
          behavioralPreparationHash = resolution.preparationHash;
          behavioralSourceResultEnvelopeHash = resolution.sourceResultEnvelopeHash;
          behavioralPreparationFinalizationHash = resolution.finalizationHash;
          recoveredFinalization = resolution;
        } else if (resolution.status === "consumed" || resolution.status === "abandoned") {
          throw new TrustedEvaluationBrokerError(
            "release-validation-failed",
            "Behavioral preparation is already terminal without a releasable result.",
          );
        }

        if (
          request.stage !== "validation" &&
          (preparation !== null || recoveredFinalization !== null)
        ) {
          throw new TrustedEvaluationBrokerError(
            "release-validation-failed",
            "Feedback-dark stages cannot prepare diagnostics.",
          );
        }

        if (preparation !== null || recoveredFinalization !== null) {
          if (
            preparation !== null &&
            (preparation.requestHash !== requestHash ||
              preparation.protocolHash !== request.protocolHash)
          ) {
            throw new TrustedEvaluationBrokerError(
              "release-validation-failed",
              "Behavioral preparation does not belong to this evaluation.",
            );
          }
          const sourceResultEnvelopeHash = behavioralSourceResultHash({
            request,
            requestHash,
            panel,
            aggregate,
            retentionPolicyHash: this.#options.retentionPolicy.policyHash,
          });
          behavioralSourceResultEnvelopeHash = sourceResultEnvelopeHash;
          let finalized: TrustedBehavioralReleaseFinalization | null;
          if (recoveredFinalization !== null) {
            if (recoveredFinalization.sourceResultEnvelopeHash !== sourceResultEnvelopeHash) {
              throw new TrustedEvaluationBrokerError(
                "release-validation-failed",
                "Recovered behavioral finalization names another result.",
              );
            }
            finalized = recoveredFinalization.finalization;
            behavioralFinalization = finalized;
            assertBehavioralFinalization(finalized, requestHash);
          } else {
            behavioralFinalizeAttempted = true;
            finalized = await behavioralProducer.finalize({
              preparation: preparation as TrustedPrivateBehavioralPreparation,
              sourceResultEnvelopeHash,
              destructionReceipt,
            });
            behavioralFinalizeResolved = true;
            if (finalized === null) {
              if (behavioralPreparationHash !== null) {
                const consumption = await preparationStore.consume({
                  requestHash,
                  protocolHash: request.protocolHash,
                });
                if (
                  (consumption.status !== "consumed" &&
                    consumption.status !== "already-consumed") ||
                  consumption.requestHash !== requestHash ||
                  consumption.protocolHash !== request.protocolHash ||
                  consumption.preparationHash !== behavioralPreparationHash
                ) {
                  throw new TrustedEvaluationBrokerError(
                    "release-validation-failed",
                    "Behavioral preparation consumption is detached.",
                  );
                }
                if (recoveryRecord !== null && recoveryRecord.behavioral.status === "prepared") {
                  recoveryRecord = await this.#advanceRecoveryRecord(
                    recoveryRecord,
                    this.#nextRecoveryRecord(recoveryRecord, {
                      behavioral: {
                        status: "consumed",
                        preparationHash: behavioralPreparationHash,
                      },
                    }),
                    request,
                    requestHash,
                  );
                }
              }
            } else {
              behavioralFinalization = finalized;
              assertBehavioralFinalization(
                finalized,
                requestHash,
                (preparation as TrustedPrivateBehavioralPreparation).behaviorSourceSetHash,
              );
              if (behavioralPreparationHash !== null) {
                const expectedFinalizationHash = hashTrustedBehavioralPreparationFinalization({
                  requestHash,
                  protocolHash: request.protocolHash,
                  preparationHash: behavioralPreparationHash,
                  sourceResultEnvelopeHash,
                  finalization: finalized,
                });
                behavioralPreparationFinalizationHash = expectedFinalizationHash;
                const finalizationReceipt = await preparationStore.finalize({
                  requestHash,
                  protocolHash: request.protocolHash,
                  preparationHash: behavioralPreparationHash,
                  sourceResultEnvelopeHash,
                  finalization: finalized,
                });
                if (
                  (finalizationReceipt.status !== "finalized" &&
                    finalizationReceipt.status !== "already-finalized") ||
                  finalizationReceipt.requestHash !== requestHash ||
                  finalizationReceipt.protocolHash !== request.protocolHash ||
                  finalizationReceipt.preparationHash !== behavioralPreparationHash ||
                  finalizationReceipt.sourceResultEnvelopeHash !== sourceResultEnvelopeHash ||
                  finalizationReceipt.finalizationHash !== expectedFinalizationHash
                ) {
                  throw new TrustedEvaluationBrokerError(
                    "release-validation-failed",
                    "Behavioral preparation finalization receipt is detached.",
                  );
                }
                if (recoveryRecord !== null && recoveryRecord.behavioral.status === "prepared") {
                  recoveryRecord = await this.#advanceRecoveryRecord(
                    recoveryRecord,
                    this.#nextRecoveryRecord(recoveryRecord, {
                      aggregate: attachBehavioralFinalization(aggregate, finalized),
                      behavioral: {
                        status: "finalized",
                        preparationHash: behavioralPreparationHash,
                        sourceResultEnvelopeHash,
                        finalizationHash: expectedFinalizationHash,
                        finalization: finalized,
                      },
                    }),
                    request,
                    requestHash,
                  );
                }
              }
            }
          }
          if (finalized !== null) {
            behavioralFinalization = finalized;
            aggregate = attachBehavioralFinalization(aggregate, finalized);
            assertAggregate(aggregate, request, requestHash, rawRun);
          }
        }
      }
      const envelope = await this.#options.issuer.issue({
        request,
        requestHash,
        dispositionAttestationHash: panel.dispositionAttestationHash,
        aggregate,
        destructionReceipt,
        retentionPolicyHash: this.#options.retentionPolicy.policyHash,
      });
      assertEnvelopeLinks(
        envelope,
        request,
        requestHash,
        panel.dispositionAttestationHash,
        aggregate,
        this.#options.retentionPolicy.policyHash,
      );
      if (!(await this.#options.verifier.verify(envelope))) {
        throw new TrustedEvaluationBrokerError(
          "release-validation-failed",
          "Evaluator release signature verification failed.",
        );
      }
      attemptedEnvelopeHash = canonicalHash({
        domain: "dark-factory.one-use-result-completion-envelope.v1",
        envelope,
      });
      if (recoveryRecord !== null) {
        recoveryRecord = await this.#advanceRecoveryRecord(
          recoveryRecord,
          this.#nextRecoveryRecord(recoveryRecord, {
            status: "result-issued",
            envelope,
            envelopeHash: hashResultCompletionEnvelope(envelope),
          }),
          request,
          requestHash,
        );
      }
      completionAttempted = true;
      await this.#options.ledger.complete(
        claim.claimToken,
        requestHash,
        panel.dispositionAttestationHash,
        envelope,
      );
      if (recoveryRecord !== null && recoveryRecord.status === "result-issued") {
        recoveryRecord = await this.#advanceRecoveryRecord(
          recoveryRecord,
          this.#nextRecoveryRecord(recoveryRecord, {
            status: "completed",
          }),
          request,
          requestHash,
        );
      }
      return envelope;
    } catch (error) {
      const behavioralFinalizeFailed = behavioralFinalizeAttempted && !behavioralFinalizeResolved;
      const behavioralFinalizeKnownNotCommitted =
        behavioralFinalizeFailed &&
        error instanceof TrustedBehavioralReleaseProducerError &&
        error.finalizationDisposition === "known-not-committed";
      const behavioralCommitUnsafeToConsume =
        behavioralFinalizeFailed && !behavioralFinalizeKnownNotCommitted;
      let behavioralCleanupUnsafe = behavioralCommitUnsafeToConsume;
      let behavioralPreparationCleanupVerified =
        this.#options.behavioralPreparationStore === undefined;
      let recoveryCleanupVerified = !recoveryCheckpointAttempted;
      let completionKnownNotCommitted = !completionAttempted && !behavioralCommitUnsafeToConsume;
      if (behavioralCommitUnsafeToConsume) {
        failureCode = "release-validation-failed";
      }
      if (completionAttempted) {
        try {
          const inspection = await this.#options.ledger.inspect(request.requestId, requestHash);
          assertOneUseLedgerInspection(inspection);
          if (inspection.state === "completed") {
            if (panel === undefined || attemptedEnvelopeHash === null) {
              throw new Error("Recovered completion has no exact attempted result.");
            }
            const recoveredEnvelopeHash = canonicalHash({
              domain: "dark-factory.one-use-result-completion-envelope.v1",
              envelope: inspection.envelope,
            });
            if (recoveredEnvelopeHash !== attemptedEnvelopeHash) {
              throw new Error("Recovered completion differs from the attempted result.");
            }
            assertEnvelopeLinks(
              inspection.envelope,
              request,
              requestHash,
              panel.dispositionAttestationHash,
            );
            if (
              inspection.envelope.derivation.behavioralAggregateHash !==
              (behavioralFinalization?.contentHash ?? null)
            ) {
              throw new Error("Recovered result does not bind its behavioral release.");
            }
            if (!(await this.#options.verifier.verify(inspection.envelope))) {
              throw new Error("Recovered signed evaluator result failed verification.");
            }
            if (recoveryRecord !== null && recoveryRecord.status === "result-issued") {
              recoveryRecord = await this.#advanceRecoveryRecord(
                recoveryRecord,
                this.#nextRecoveryRecord(recoveryRecord, {
                  status: "completed",
                }),
                request,
                requestHash,
              );
            }
            return inspection.envelope;
          }
          completionKnownNotCommitted =
            inspection.state === "in-flight" || inspection.state === "consumed";
        } catch {
          /*
           * This is deliberately not converted into an orphan. A durable
           * complete may have committed before its acknowledgement failed.
           * Leaving the one-use bundle unreferenced is recoverable; orphaning
           * a bundle already named by a committed result is not.
           */
          completionKnownNotCommitted = false;
          failureCode = "release-validation-failed";
        }
      }
      let orphanFinalization: TrustedBehavioralReleaseOrphanFinalizationReceipt | null = null;
      if (
        completionKnownNotCommitted &&
        behavioralFinalization !== null &&
        this.#options.behavioralReleaseProducer !== undefined
      ) {
        try {
          orphanFinalization =
            await this.#options.behavioralReleaseProducer.orphan(behavioralFinalization);
          assertBehavioralOrphanFinalization(orphanFinalization, behavioralFinalization);
          if (
            this.#options.behavioralPreparationStore !== undefined &&
            behavioralPreparationHash !== null &&
            behavioralSourceResultEnvelopeHash !== null &&
            behavioralPreparationFinalizationHash !== null
          ) {
            try {
              const abandonmentInput = {
                requestHash,
                protocolHash: request.protocolHash,
                preparationHash: behavioralPreparationHash,
                sourceResultEnvelopeHash: behavioralSourceResultEnvelopeHash,
                finalizationHash: behavioralPreparationFinalizationHash,
                orphanFinalization,
              };
              const abandonment =
                await this.#options.behavioralPreparationStore.abandon(abandonmentInput);
              assertBehavioralPreparationAbandonment(abandonment, {
                requestHash,
                protocolHash: request.protocolHash,
                preparationHash: behavioralPreparationHash,
                sourceResultEnvelopeHash: behavioralSourceResultEnvelopeHash,
                finalizationHash: behavioralPreparationFinalizationHash,
                orphanFinalizationHash: orphanFinalization.orphanFinalizationHash,
              });
              if (recoveryRecord !== null && recoveryRecord.behavioral.status === "finalized") {
                recoveryRecord = await this.#advanceRecoveryRecord(
                  recoveryRecord,
                  this.#nextRecoveryRecord(recoveryRecord, {
                    ...(recoveryRecord.status === "result-issued"
                      ? {
                          status: "failed" as const,
                          failureCode,
                        }
                      : {}),
                    behavioral: {
                      ...recoveryRecord.behavioral,
                      status: "abandoned",
                      orphanFinalizationHash: orphanFinalization.orphanFinalizationHash,
                      orphanFinalization,
                      abandonmentHash: abandonment.abandonmentHash,
                    },
                  }),
                  request,
                  requestHash,
                );
              }
              behavioralPreparationCleanupVerified = true;
            } catch {
              behavioralPreparationCleanupVerified = false;
            }
          }
        } catch {
          failureCode = "release-validation-failed";
          completionKnownNotCommitted = false;
          behavioralCleanupUnsafe = true;
        }
      }
      if (this.#options.behavioralPreparationStore !== undefined && !behavioralCleanupUnsafe) {
        try {
          const resolution = await this.#options.behavioralPreparationStore.resolve({
            requestHash,
            protocolHash: request.protocolHash,
          });
          if (
            resolution.requestHash !== requestHash ||
            resolution.protocolHash !== request.protocolHash
          ) {
            throw new Error("Behavioral preparation cleanup is detached.");
          }
          if (resolution.status === "prepared") {
            const preparationHash = hashTrustedBehavioralPreparation(resolution.preparation);
            if (preparationHash !== resolution.preparationHash) {
              throw new Error("Behavioral preparation cleanup hash changed.");
            }
            if (behavioralFinalization !== null && orphanFinalization === null) {
              throw new Error("Committed behavioral release has no orphan finalization.");
            }
            const consumption = await this.#options.behavioralPreparationStore.consume({
              requestHash,
              protocolHash: request.protocolHash,
            });
            if (
              consumption.status === "missing" ||
              consumption.requestHash !== requestHash ||
              consumption.protocolHash !== request.protocolHash ||
              consumption.preparationHash !== preparationHash
            ) {
              throw new Error("Behavioral preparation cleanup did not commit.");
            }
            if (
              recoveryRecord !== null &&
              recoveryRecord.behavioral.status === "prepared" &&
              (consumption.status === "consumed" || consumption.status === "already-consumed")
            ) {
              recoveryRecord = await this.#advanceRecoveryRecord(
                recoveryRecord,
                this.#nextRecoveryRecord(recoveryRecord, {
                  ...(recoveryRecord.status === "result-issued"
                    ? {
                        status: "failed" as const,
                        failureCode,
                      }
                    : {}),
                  behavioral: {
                    status: "consumed",
                    preparationHash,
                  },
                }),
                request,
                requestHash,
              );
            }
            if (consumption.status === "already-abandoned") {
              if (
                orphanFinalization === null ||
                behavioralSourceResultEnvelopeHash === null ||
                behavioralPreparationFinalizationHash === null
              ) {
                throw new Error("Behavioral preparation abandonment has no exact orphan binding.");
              }
              assertBehavioralPreparationAbandonment(consumption, {
                requestHash,
                protocolHash: request.protocolHash,
                preparationHash,
                sourceResultEnvelopeHash: behavioralSourceResultEnvelopeHash,
                finalizationHash: behavioralPreparationFinalizationHash,
                orphanFinalizationHash: orphanFinalization.orphanFinalizationHash,
              });
            } else if (
              consumption.status !== "consumed" &&
              consumption.status !== "already-consumed"
            ) {
              throw new Error("Behavioral preparation cleanup did not commit.");
            }
            behavioralPreparationCleanupVerified = true;
          } else if (resolution.status === "missing" || resolution.status === "consumed") {
            behavioralPreparationCleanupVerified = true;
          } else if (resolution.status === "abandoned") {
            if (behavioralFinalization === null || orphanFinalization === null) {
              throw new Error("Abandoned behavioral preparation has no current orphan proof.");
            }
            assertBehavioralOrphanFinalization(
              resolution.orphanFinalization,
              behavioralFinalization,
            );
            if (
              resolution.orphanFinalizationHash !== orphanFinalization.orphanFinalizationHash ||
              resolution.orphanFinalizationHash !==
                resolution.orphanFinalization.orphanFinalizationHash
            ) {
              throw new Error("Behavioral preparation orphan proof changed.");
            }
            assertBehavioralPreparationAbandonment(resolution, {
              requestHash,
              protocolHash: request.protocolHash,
              preparationHash: resolution.preparationHash,
              sourceResultEnvelopeHash: resolution.sourceResultEnvelopeHash,
              finalizationHash: resolution.finalizationHash,
              orphanFinalizationHash: resolution.orphanFinalizationHash,
            });
            behavioralPreparationCleanupVerified = true;
          } else if (resolution.status === "finalized" && orphanFinalization !== null) {
            const abandonmentInput = {
              requestHash,
              protocolHash: request.protocolHash,
              preparationHash: resolution.preparationHash,
              sourceResultEnvelopeHash: resolution.sourceResultEnvelopeHash,
              finalizationHash: resolution.finalizationHash,
              orphanFinalization,
            };
            const abandonment =
              await this.#options.behavioralPreparationStore.abandon(abandonmentInput);
            assertBehavioralPreparationAbandonment(abandonment, {
              requestHash,
              protocolHash: request.protocolHash,
              preparationHash: resolution.preparationHash,
              sourceResultEnvelopeHash: resolution.sourceResultEnvelopeHash,
              finalizationHash: resolution.finalizationHash,
              orphanFinalizationHash: orphanFinalization.orphanFinalizationHash,
            });
            if (recoveryRecord !== null && recoveryRecord.behavioral.status === "finalized") {
              recoveryRecord = await this.#advanceRecoveryRecord(
                recoveryRecord,
                this.#nextRecoveryRecord(recoveryRecord, {
                  ...(recoveryRecord.status === "result-issued"
                    ? {
                        status: "failed" as const,
                        failureCode,
                      }
                    : {}),
                  behavioral: {
                    ...recoveryRecord.behavioral,
                    status: "abandoned",
                    orphanFinalizationHash: orphanFinalization.orphanFinalizationHash,
                    orphanFinalization,
                    abandonmentHash: abandonment.abandonmentHash,
                  },
                }),
                request,
                requestHash,
              );
            }
            behavioralPreparationCleanupVerified = true;
          } else if (resolution.status === "finalized") {
            behavioralPreparationCleanupVerified = false;
          }
        } catch {
          failureCode = "release-validation-failed";
          behavioralPreparationCleanupVerified = false;
        }
      }
      if (rawRun !== undefined && !rawDestroyed) {
        try {
          const destructionReceipt = await this.#options.custodian.destroy(rawRun);
          assertRawDestructionReceipt(
            this.#options.retentionPolicy,
            rawRun.manifest,
            destructionReceipt,
            this.#options.destructionReceiptVerifier,
          );
          rawDestroyed = true;
        } catch {
          failureCode = "raw-destruction-failed";
        }
      }
      if (completionKnownNotCommitted && behavioralPreparationCleanupVerified) {
        if (recoveryRecord !== null) {
          try {
            const exactRecovery = await this.#resolveRecoveryRecord(request, requestHash);
            if (exactRecovery === null) {
              throw new Error("Post-destruction recovery record disappeared.");
            }
            recoveryRecord = exactRecovery;
            if (recoveryRecord.status !== "failed" && recoveryRecord.status !== "completed") {
              recoveryRecord = await this.#advanceRecoveryRecord(
                recoveryRecord,
                this.#nextRecoveryRecord(recoveryRecord, {
                  status: "failed",
                  failureCode,
                }),
                request,
                requestHash,
              );
            }
            recoveryCleanupVerified = recoveryRecord.status === "failed";
          } catch {
            recoveryCleanupVerified = false;
          }
        }
      }
      if (
        completionKnownNotCommitted &&
        behavioralPreparationCleanupVerified &&
        recoveryCleanupVerified
      ) {
        try {
          await this.#options.ledger.consumeFailure(claim.claimToken, requestHash, failureCode);
        } catch {
          // The outward error remains task-agnostic. Durable ledger monitoring
          // must alert on this fail-closed recovery condition.
        }
      }
      throw new TrustedEvaluationBrokerError(
        failureCode,
        "Trusted evaluation failed closed without releasing hidden benchmark material.",
      );
    }
  }
}
