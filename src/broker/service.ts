import {
  assertEvaluationRequest,
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "../evaluator/contracts.js";
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
  TrustedOnlineErrorBudgetAuthority,
  TrustedOnlineErrorBudgetReservation,
} from "../evaluator/online-error-authority.js";
import {
  hashTrustedBehavioralReleaseOrphanFinalization,
  TrustedBehavioralReleaseProducerError,
  type TrustedBehavioralReleaseFinalization,
  type TrustedBehavioralReleaseOrphanFinalizationReceipt,
  type TrustedPostDestructionBehavioralReleaseProducer,
} from "../evaluator/behavioral-release-producer.js";
import {
  hashTrustedBehavioralPreparation,
  hashTrustedBehavioralPreparationAbandonment,
  hashTrustedBehavioralPreparationFinalization,
  type TrustedBehavioralPreparationAbandonmentReceipt,
  type TrustedBehavioralPreparationStore,
} from "../evaluator/behavioral-preparation-store.js";
import type { TrustedPrivateBehavioralPreparation } from "../evaluator/deriver.js";
import {
  hashResultEnvelopeBehavioralSourceMaterial,
} from "../evaluator/release-lineage.js";
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
  readonly code:
    | BrokerFailureCode
    | "request-conflict"
    | "request-in-flight"
    | "request-consumed";

  constructor(
    code:
      | BrokerFailureCode
      | "request-conflict"
      | "request-in-flight"
      | "request-consumed",
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
    (request.stage !== "repair" &&
      request.stage !== "validation" &&
      request.stage !== "shadow") ||
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
    (request.stage !== "validation" &&
      aggregate.behavioralAggregateHash !== null)
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
    (envelope.derivation.normalizedOutcomeSetHash !==
      aggregate.normalizedOutcomeSetHash ||
      envelope.derivation.cacheAttestationHash !== aggregate.cacheAttestationHash ||
      envelope.derivation.behavioralAggregateHash !==
        aggregate.behavioralAggregateHash ||
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
      dispositionAttestationHash:
        input.panel.dispositionAttestationHash,
      reuseProhibited: true,
    },
    normalizedOutcomeSetHash:
      input.aggregate.normalizedOutcomeSetHash,
    cacheAttestationHash:
      input.aggregate.cacheAttestationHash,
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
    (expectedSourceSetHash !== undefined &&
      finalization.sourceSetHash !== expectedSourceSetHash) ||
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
  const expectedHash =
    hashTrustedBehavioralReleaseOrphanFinalization({
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
  const expectedHash =
    hashTrustedBehavioralPreparationAbandonment(input);
  if (
    (receipt.status !== "abandoned" &&
      receipt.status !== "already-abandoned") ||
    receipt.requestHash !== input.requestHash ||
    receipt.protocolHash !== input.protocolHash ||
    receipt.preparationHash !== input.preparationHash ||
    receipt.sourceResultEnvelopeHash !==
      input.sourceResultEnvelopeHash ||
    receipt.finalizationHash !== input.finalizationHash ||
    receipt.orphanFinalizationHash !==
      input.orphanFinalizationHash ||
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
    this.#options = options;
  }

  async evaluate(request: TrustedEvaluationRequest): Promise<SignedResultEnvelope> {
    assertAdaptiveRequest(request);
    experimentNumber(request);
    if (
      request.evaluatedModel.provider !==
        this.#options.agent.evaluatedModel.provider ||
      request.evaluatedModel.modelId !==
        this.#options.agent.evaluatedModel.modelId ||
      request.evaluatedModel.thinkingLevel !==
        this.#options.agent.evaluatedModel.thinkingLevel
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
      throw new TrustedEvaluationBrokerError(
        "request-in-flight",
        "This one-use evaluation is already in progress.",
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
      return claim.envelope;
    }

    let rawRun: TrustedRawRun | undefined;
    let rawDestroyed = false;
    let panel: TrustedMatchedPanel | undefined;
    let onlineErrorReservation: TrustedOnlineErrorBudgetReservation | null =
      null;
    let behavioralFinalization:
      | TrustedBehavioralReleaseFinalization
      | null = null;
    let behavioralPreparationHash: string | null = null;
    let behavioralSourceResultEnvelopeHash: string | null =
      null;
    let behavioralPreparationFinalizationHash: string | null =
      null;
    let completionAttempted = false;
    let attemptedEnvelopeHash: string | null = null;
    let failureCode: BrokerFailureCode = "evaluation-failed";
    try {
      failureCode = "panel-allocation-failed";
      panel = await this.#options.panels.allocateAndConsume(
        request,
        requestHash,
        claim.claimToken,
      );
      assertTrustedMatchedPanel(panel);
      if (panel.requestId !== request.requestId || panel.stage !== request.stage) {
        throw new TrustedEvaluationBrokerError(
          "panel-allocation-failed",
          "Hidden panel lease does not correlate to the one-use request.",
        );
      }
      const attestationBound =
        await this.#options.ledger.bindDispositionAttestation(
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
              dispositionAttestationHash:
                panel.dispositionAttestationHash,
            })
          : null;

      const schedule = createTrustedMatchedArmSchedule(
        panel,
        request.candidate,
        request.champion,
      );
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
      const behavioralProducer =
        this.#options.behavioralReleaseProducer;
      if (behavioralProducer !== undefined) {
        const preparationStore =
          this.#options.behavioralPreparationStore;
        let preparation:
          | TrustedPrivateBehavioralPreparation
          | null = null;
        let recoveredFinalization:
          | {
              readonly preparationHash: string;
              readonly sourceResultEnvelopeHash: string;
              readonly finalizationHash: string;
              readonly finalization: TrustedBehavioralReleaseFinalization;
            }
          | null = null;

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
          behavioralPreparationHash =
            hashTrustedBehavioralPreparation(
              resolution.preparation,
            );
          if (
            behavioralPreparationHash !==
              resolution.preparationHash ||
            resolution.preparation.requestHash !== requestHash ||
            resolution.preparation.protocolHash !==
              request.protocolHash
          ) {
            throw new TrustedEvaluationBrokerError(
              "release-validation-failed",
              "Durable behavioral preparation is detached.",
            );
          }
          preparation = resolution.preparation;
        } else if (resolution.status === "finalized") {
          const expectedFinalizationHash =
            hashTrustedBehavioralPreparationFinalization({
              requestHash,
              protocolHash: request.protocolHash,
              preparationHash: resolution.preparationHash,
              sourceResultEnvelopeHash:
                resolution.sourceResultEnvelopeHash,
              finalization: resolution.finalization,
            });
          if (
            !SHA256.test(resolution.preparationHash) ||
            resolution.finalizationHash !==
              expectedFinalizationHash
          ) {
            throw new TrustedEvaluationBrokerError(
              "release-validation-failed",
              "Durable behavioral finalization is detached.",
            );
          }
          behavioralPreparationHash =
            resolution.preparationHash;
          behavioralSourceResultEnvelopeHash =
            resolution.sourceResultEnvelopeHash;
          behavioralPreparationFinalizationHash =
            resolution.finalizationHash;
          recoveredFinalization = resolution;
        } else if (
          resolution.status === "consumed" ||
          resolution.status === "abandoned"
        ) {
          throw new TrustedEvaluationBrokerError(
            "release-validation-failed",
            "Behavioral preparation is already terminal without a releasable result.",
          );
        }

        if (
          request.stage !== "validation" &&
          (preparation !== null ||
            recoveredFinalization !== null)
        ) {
          throw new TrustedEvaluationBrokerError(
            "release-validation-failed",
            "Feedback-dark stages cannot prepare diagnostics.",
          );
        }

        if (
          preparation !== null ||
          recoveredFinalization !== null
        ) {
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
          const sourceResultEnvelopeHash =
            behavioralSourceResultHash({
              request,
              requestHash,
              panel,
              aggregate,
              retentionPolicyHash:
                this.#options.retentionPolicy.policyHash,
            });
          behavioralSourceResultEnvelopeHash =
            sourceResultEnvelopeHash;
          let finalized:
            | TrustedBehavioralReleaseFinalization
            | null;
          if (recoveredFinalization !== null) {
            if (
              recoveredFinalization.sourceResultEnvelopeHash !==
                sourceResultEnvelopeHash
            ) {
              throw new TrustedEvaluationBrokerError(
                "release-validation-failed",
                "Recovered behavioral finalization names another result.",
              );
            }
            finalized = recoveredFinalization.finalization;
            behavioralFinalization = finalized;
            assertBehavioralFinalization(
              finalized,
              requestHash,
            );
          } else {
            finalized = await behavioralProducer.finalize({
              preparation: preparation as TrustedPrivateBehavioralPreparation,
              sourceResultEnvelopeHash,
              destructionReceipt,
            });
            if (finalized === null) {
              if (behavioralPreparationHash !== null) {
                const consumption =
                  await preparationStore.consume({
                    requestHash,
                    protocolHash: request.protocolHash,
                  });
                if (
                  (consumption.status !== "consumed" &&
                    consumption.status !==
                      "already-consumed") ||
                  consumption.requestHash !== requestHash ||
                  consumption.protocolHash !==
                    request.protocolHash ||
                  consumption.preparationHash !==
                    behavioralPreparationHash
                ) {
                  throw new TrustedEvaluationBrokerError(
                    "release-validation-failed",
                    "Behavioral preparation consumption is detached.",
                  );
                }
              }
            } else {
              behavioralFinalization = finalized;
              assertBehavioralFinalization(
                finalized,
                requestHash,
                (
                  preparation as TrustedPrivateBehavioralPreparation
                ).behaviorSourceSetHash,
              );
              if (behavioralPreparationHash !== null) {
                const expectedFinalizationHash =
                  hashTrustedBehavioralPreparationFinalization({
                    requestHash,
                    protocolHash: request.protocolHash,
                    preparationHash:
                      behavioralPreparationHash,
                    sourceResultEnvelopeHash,
                    finalization: finalized,
                  });
                behavioralPreparationFinalizationHash =
                  expectedFinalizationHash;
                const finalizationReceipt =
                  await preparationStore.finalize({
                    requestHash,
                    protocolHash: request.protocolHash,
                    preparationHash:
                      behavioralPreparationHash,
                    sourceResultEnvelopeHash,
                    finalization: finalized,
                  });
                if (
                  (finalizationReceipt.status !== "finalized" &&
                    finalizationReceipt.status !==
                      "already-finalized") ||
                  finalizationReceipt.requestHash !== requestHash ||
                  finalizationReceipt.protocolHash !==
                    request.protocolHash ||
                  finalizationReceipt.preparationHash !==
                    behavioralPreparationHash ||
                  finalizationReceipt.sourceResultEnvelopeHash !==
                    sourceResultEnvelopeHash ||
                  finalizationReceipt.finalizationHash !==
                    expectedFinalizationHash
                ) {
                  throw new TrustedEvaluationBrokerError(
                    "release-validation-failed",
                    "Behavioral preparation finalization receipt is detached.",
                  );
                }
              }
            }
          }
          if (finalized !== null) {
            behavioralFinalization = finalized;
            aggregate = attachBehavioralFinalization(
              aggregate,
              finalized,
            );
            assertAggregate(
              aggregate,
              request,
              requestHash,
              rawRun,
            );
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
        domain:
          "dark-factory.one-use-result-completion-envelope.v1",
        envelope,
      });
      completionAttempted = true;
      await this.#options.ledger.complete(
        claim.claimToken,
        requestHash,
        panel.dispositionAttestationHash,
        envelope,
      );
      return envelope;
    } catch (error) {
      const behavioralCommitUnsafeToConsume =
        error instanceof TrustedBehavioralReleaseProducerError &&
        error.finalizationDisposition === "unsafe-to-consume";
      let behavioralCleanupUnsafe =
        behavioralCommitUnsafeToConsume;
      let behavioralPreparationCleanupVerified =
        this.#options.behavioralPreparationStore === undefined;
      let completionKnownNotCommitted =
        !completionAttempted && !behavioralCommitUnsafeToConsume;
      if (behavioralCommitUnsafeToConsume) {
        failureCode = "release-validation-failed";
      }
      if (completionAttempted) {
        try {
          const inspection = await this.#options.ledger.inspect(
            request.requestId,
            requestHash,
          );
          assertOneUseLedgerInspection(inspection);
          if (inspection.state === "completed") {
            if (
              panel === undefined ||
              attemptedEnvelopeHash === null
            ) {
              throw new Error(
                "Recovered completion has no exact attempted result.",
              );
            }
            const recoveredEnvelopeHash = canonicalHash({
              domain:
                "dark-factory.one-use-result-completion-envelope.v1",
              envelope: inspection.envelope,
            });
            if (recoveredEnvelopeHash !== attemptedEnvelopeHash) {
              throw new Error(
                "Recovered completion differs from the attempted result.",
              );
            }
            assertEnvelopeLinks(
              inspection.envelope,
              request,
              requestHash,
              panel.dispositionAttestationHash,
            );
            if (
              inspection.envelope.derivation
                .behavioralAggregateHash !==
              (behavioralFinalization?.contentHash ?? null)
            ) {
              throw new Error(
                "Recovered result does not bind its behavioral release.",
              );
            }
            if (
              !(await this.#options.verifier.verify(
                inspection.envelope,
              ))
            ) {
              throw new Error(
                "Recovered signed evaluator result failed verification.",
              );
            }
            return inspection.envelope;
          }
          completionKnownNotCommitted =
            inspection.state === "in-flight" ||
            inspection.state === "consumed";
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
      let orphanFinalization:
        | TrustedBehavioralReleaseOrphanFinalizationReceipt
        | null = null;
      if (
        completionKnownNotCommitted &&
        behavioralFinalization !== null &&
        this.#options.behavioralReleaseProducer !== undefined
      ) {
        try {
          orphanFinalization =
            await this.#options.behavioralReleaseProducer.orphan(
              behavioralFinalization,
            );
          assertBehavioralOrphanFinalization(
            orphanFinalization,
            behavioralFinalization,
          );
          if (
            this.#options.behavioralPreparationStore !==
              undefined &&
            behavioralPreparationHash !== null &&
            behavioralSourceResultEnvelopeHash !== null &&
            behavioralPreparationFinalizationHash !== null
          ) {
            try {
              const abandonmentInput = {
                requestHash,
                protocolHash: request.protocolHash,
                preparationHash:
                  behavioralPreparationHash,
                sourceResultEnvelopeHash:
                  behavioralSourceResultEnvelopeHash,
                finalizationHash:
                  behavioralPreparationFinalizationHash,
                orphanFinalization,
              };
              const abandonment =
                await this.#options.behavioralPreparationStore.abandon(
                  abandonmentInput,
                );
              assertBehavioralPreparationAbandonment(
                abandonment,
                {
                  requestHash,
                  protocolHash: request.protocolHash,
                  preparationHash:
                    behavioralPreparationHash,
                  sourceResultEnvelopeHash:
                    behavioralSourceResultEnvelopeHash,
                  finalizationHash:
                    behavioralPreparationFinalizationHash,
                  orphanFinalizationHash:
                    orphanFinalization.orphanFinalizationHash,
                },
              );
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
      if (
        this.#options.behavioralPreparationStore !== undefined &&
        !behavioralCleanupUnsafe
      ) {
        try {
          const resolution =
            await this.#options.behavioralPreparationStore.resolve({
              requestHash,
              protocolHash: request.protocolHash,
            });
          if (
            resolution.requestHash !== requestHash ||
            resolution.protocolHash !== request.protocolHash
          ) {
            throw new Error(
              "Behavioral preparation cleanup is detached.",
            );
          }
          if (resolution.status === "prepared") {
            const preparationHash =
              hashTrustedBehavioralPreparation(
                resolution.preparation,
              );
            if (
              preparationHash !== resolution.preparationHash
            ) {
              throw new Error(
                "Behavioral preparation cleanup hash changed.",
              );
            }
            if (
              behavioralFinalization !== null &&
              orphanFinalization === null
            ) {
              throw new Error(
                "Committed behavioral release has no orphan finalization.",
              );
            }
            const consumption =
              await this.#options.behavioralPreparationStore.consume({
                requestHash,
                protocolHash: request.protocolHash,
              });
            if (
              consumption.status === "missing" ||
              consumption.requestHash !== requestHash ||
              consumption.protocolHash !== request.protocolHash ||
              consumption.preparationHash !== preparationHash
            ) {
              throw new Error(
                "Behavioral preparation cleanup did not commit.",
              );
            }
            if (
              consumption.status === "already-abandoned"
            ) {
              if (
                orphanFinalization === null ||
                behavioralSourceResultEnvelopeHash === null ||
                behavioralPreparationFinalizationHash === null
              ) {
                throw new Error(
                  "Behavioral preparation abandonment has no exact orphan binding.",
                );
              }
              assertBehavioralPreparationAbandonment(
                consumption,
                {
                  requestHash,
                  protocolHash: request.protocolHash,
                  preparationHash,
                  sourceResultEnvelopeHash:
                    behavioralSourceResultEnvelopeHash,
                  finalizationHash:
                    behavioralPreparationFinalizationHash,
                  orphanFinalizationHash:
                    orphanFinalization.orphanFinalizationHash,
                },
              );
            } else if (
              consumption.status !== "consumed" &&
              consumption.status !== "already-consumed"
            ) {
              throw new Error(
                "Behavioral preparation cleanup did not commit.",
              );
            }
            behavioralPreparationCleanupVerified = true;
          } else if (
            resolution.status === "missing" ||
            resolution.status === "consumed"
          ) {
            behavioralPreparationCleanupVerified = true;
          } else if (resolution.status === "abandoned") {
            if (
              behavioralFinalization === null ||
              orphanFinalization === null
            ) {
              throw new Error(
                "Abandoned behavioral preparation has no current orphan proof.",
              );
            }
            assertBehavioralOrphanFinalization(
              resolution.orphanFinalization,
              behavioralFinalization,
            );
            if (
              resolution.orphanFinalizationHash !==
                orphanFinalization.orphanFinalizationHash ||
              resolution.orphanFinalizationHash !==
                resolution.orphanFinalization
                  .orphanFinalizationHash
            ) {
              throw new Error(
                "Behavioral preparation orphan proof changed.",
              );
            }
            assertBehavioralPreparationAbandonment(
              resolution,
              {
                requestHash,
                protocolHash: request.protocolHash,
                preparationHash:
                  resolution.preparationHash,
                sourceResultEnvelopeHash:
                  resolution.sourceResultEnvelopeHash,
                finalizationHash:
                  resolution.finalizationHash,
                orphanFinalizationHash:
                  resolution.orphanFinalizationHash,
              },
            );
            behavioralPreparationCleanupVerified = true;
          } else if (
            resolution.status === "finalized" &&
            orphanFinalization !== null
          ) {
            const abandonmentInput = {
              requestHash,
              protocolHash: request.protocolHash,
              preparationHash:
                resolution.preparationHash,
              sourceResultEnvelopeHash:
                resolution.sourceResultEnvelopeHash,
              finalizationHash:
                resolution.finalizationHash,
              orphanFinalization,
            };
            const abandonment =
              await this.#options.behavioralPreparationStore.abandon(
                abandonmentInput,
              );
            assertBehavioralPreparationAbandonment(
              abandonment,
              {
                requestHash,
                protocolHash: request.protocolHash,
                preparationHash:
                  resolution.preparationHash,
                sourceResultEnvelopeHash:
                  resolution.sourceResultEnvelopeHash,
                finalizationHash:
                  resolution.finalizationHash,
                orphanFinalizationHash:
                  orphanFinalization.orphanFinalizationHash,
              },
            );
            behavioralPreparationCleanupVerified = true;
          } else if (
            resolution.status === "finalized"
          ) {
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
      if (
        completionKnownNotCommitted &&
        behavioralPreparationCleanupVerified
      ) {
        try {
          await this.#options.ledger.consumeFailure(
            claim.claimToken,
            requestHash,
            failureCode,
          );
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
