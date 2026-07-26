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
  readonly custodian: TrustedRawArtifactCustodian;
  readonly issuer: TrustedResultEnvelopeIssuer;
  readonly verifier: TrustedResultEnvelopeVerifier;
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
    aggregate.releaseChecks.taskIdentityScanPassed !== true
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

export class TrustedEvaluationBroker {
  readonly #options: TrustedEvaluationBrokerOptions;

  constructor(options: TrustedEvaluationBrokerOptions) {
    assertRawRetentionPolicy(options.retentionPolicy);
    assertRawDestructionReceiptVerifier(options.destructionReceiptVerifier);
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
      const aggregate = await this.#options.deriver.derive({
        request,
        panel,
        schedule,
        rawRun,
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
      await this.#options.ledger.complete(
        claim.claimToken,
        requestHash,
        panel.dispositionAttestationHash,
        envelope,
      );
      return envelope;
    } catch {
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
      throw new TrustedEvaluationBrokerError(
        failureCode,
        "Trusted evaluation failed closed without releasing hidden benchmark material.",
      );
    }
  }
}
