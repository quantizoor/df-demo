import type { KeyLike } from "node:crypto";

import { verifyEd25519Signature } from "../evidence/signatures.js";
import type {
  BehavioralEvidence,
  CacheAttestation,
  DiagnosticBrief,
  FailureCards,
} from "../schemas/artifacts.js";
import { canonicalJson } from "../schemas/canonical.js";
import { assertValidDocument } from "../schemas/registry.js";
import type { SignedBehavioralRelease, SignedResultEnvelope } from "../schemas/trusted.js";
import {
  assertEvaluationRequest,
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "./contracts.js";
import { resultEnvelopeBehavioralSourceCommitmentHash } from "./release-lineage.js";
import { assertSafeForLocalPersistence } from "./retention.js";

export interface CanonicalEvaluatorKeyring {
  getVerificationKey(keyId: string): Promise<KeyLike | undefined>;
}

export interface CanonicalEvaluatorTransport {
  submit(
    endpoint: string,
    request: TrustedEvaluationRequest,
    credentialEnvironmentName: string,
  ): Promise<unknown>;
}

export interface CanonicalEvaluatorReplayClaim {
  readonly requestId: string;
  readonly requestHash: string;
  readonly claimedAt: string;
}

/**
 * The claim is intentionally made before transport submission and is never
 * released. A failed or interrupted request therefore burns its one-use panel
 * and must be replaced by the trusted broker rather than retried.
 */
export interface CanonicalEvaluatorReplayLedger {
  claim(claim: CanonicalEvaluatorReplayClaim): Promise<boolean>;
}

/**
 * Suitable for tests and single-process simulations only. Production
 * composition must inject a durable compare-and-swap ledger.
 */
export class EphemeralCanonicalEvaluatorReplayLedger implements CanonicalEvaluatorReplayLedger {
  readonly #requestIds = new Map<string, string>();
  readonly #requestHashes = new Set<string>();

  public claim(claim: CanonicalEvaluatorReplayClaim): Promise<boolean> {
    const previousHash = this.#requestIds.get(claim.requestId);
    if (previousHash !== undefined || this.#requestHashes.has(claim.requestHash)) {
      return Promise.resolve(false);
    }
    this.#requestIds.set(claim.requestId, claim.requestHash);
    this.#requestHashes.add(claim.requestHash);
    return Promise.resolve(true);
  }
}

export interface ReleasedEvaluationBundle {
  readonly result: SignedResultEnvelope;
  readonly cacheAttestation: CacheAttestation;
  readonly behavioralRelease: SignedBehavioralRelease | null;
  readonly behavioralEvidence: BehavioralEvidence | null;
  readonly failureCards: FailureCards | null;
  readonly diagnosticBrief: DiagnosticBrief | null;
}

export interface CanonicalEvaluatorClientOptions {
  readonly endpoint: string;
  readonly credentialEnvironmentName: string;
  readonly transport: CanonicalEvaluatorTransport;
  readonly keyring: CanonicalEvaluatorKeyring;
  readonly replayLedger: CanonicalEvaluatorReplayLedger;
  readonly now?: () => Date;
  readonly maximumClockSkewMs?: number;
}

export class CanonicalEvaluatorClientError extends Error {
  override readonly name = "CanonicalEvaluatorClientError";
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CanonicalEvaluatorClientError(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function normalizeEndpoint(rawEndpoint: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new CanonicalEvaluatorClientError("Trusted evaluator endpoint must be an absolute URL.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0 ||
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "::1"
  ) {
    throw new CanonicalEvaluatorClientError(
      "Trusted evaluator endpoint must be credential-free remote HTTPS.",
    );
  }
  return endpoint.toString().replace(/\/$/u, "");
}

function parseBundle(value: unknown): ReleasedEvaluationBundle {
  const bundle = record(value, "Evaluator release bundle");
  const allowed = new Set([
    "result",
    "cacheAttestation",
    "behavioralRelease",
    "behavioralEvidence",
    "failureCards",
    "diagnosticBrief",
  ]);
  const extra = Object.keys(bundle).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new CanonicalEvaluatorClientError(
      `Evaluator release bundle contains forbidden fields: ${extra.join(", ")}.`,
    );
  }
  assertValidDocument("signedResultEnvelope", bundle.result);
  assertValidDocument("cacheAttestation", bundle.cacheAttestation);
  if (bundle.behavioralRelease !== null) {
    assertValidDocument("signedBehavioralRelease", bundle.behavioralRelease);
  }
  if (bundle.behavioralEvidence !== null) {
    assertValidDocument("behavioralEvidence", bundle.behavioralEvidence);
  }
  if (bundle.failureCards !== null) {
    assertValidDocument("failureCards", bundle.failureCards);
  }
  if (bundle.diagnosticBrief !== null) {
    assertValidDocument("diagnosticBrief", bundle.diagnosticBrief);
  }
  return bundle as unknown as ReleasedEvaluationBundle;
}

async function verifyDocumentSignature(
  document: Readonly<Record<string, unknown>>,
  keyring: CanonicalEvaluatorKeyring,
): Promise<void> {
  const signature = record(document.signature, "Evaluator signature");
  const keyId = signature.keyId;
  if (typeof keyId !== "string") {
    throw new CanonicalEvaluatorClientError("Evaluator signature key ID is missing.");
  }
  const key = await keyring.getVerificationKey(keyId);
  if (key === undefined || !verifyEd25519Signature(document, key)) {
    throw new CanonicalEvaluatorClientError("Evaluator signature is unknown or invalid.");
  }
}

function expectedPayloadKind(
  stage: TrustedEvaluationRequest["stage"],
): "repair" | "validation" | "shadow" {
  if (stage === "repair" || stage === "validation" || stage === "shadow") {
    return stage;
  }
  throw new CanonicalEvaluatorClientError(
    "Canonical adaptive releases support repair, validation, and shadow only.",
  );
}

function assertBundleLinks(
  bundle: ReleasedEvaluationBundle,
  request: TrustedEvaluationRequest,
  requestHash: string,
): void {
  const result = bundle.result;
  if (
    result.oneUseRequest.requestId !== request.requestId ||
    result.oneUseRequest.requestHash !== requestHash ||
    result.protocolHash !== request.protocolHash ||
    result.mode !== request.runMode ||
    result.payload.kind !== expectedPayloadKind(request.stage)
  ) {
    throw new CanonicalEvaluatorClientError(
      "Signed evaluator release does not correlate to its one-use request.",
    );
  }
  if (result.derivation.rawArtifacts.retentionDisposition !== "destroyed") {
    throw new CanonicalEvaluatorClientError(
      "Raw artifacts must be destroyed before a release may cross the trust boundary.",
    );
  }
  const experimentNumber = Number.parseInt(request.experimentId.split("-", 1)[0] ?? "", 10);
  if (!Number.isSafeInteger(experimentNumber) || result.experimentNumber !== experimentNumber) {
    throw new CanonicalEvaluatorClientError("Evaluator experiment identity does not match.");
  }
  if (
    bundle.cacheAttestation.experimentNumber !== experimentNumber ||
    bundle.cacheAttestation.protocolHash !== request.protocolHash ||
    result.derivation.cacheAttestationHash !== bundle.cacheAttestation.contentHash
  ) {
    throw new CanonicalEvaluatorClientError("Cache attestation belongs to another experiment.");
  }

  const diagnosticParts = [
    bundle.behavioralRelease,
    bundle.behavioralEvidence,
    bundle.failureCards,
    bundle.diagnosticBrief,
  ];
  const allDiagnosticPartsPresent = diagnosticParts.every((part) => part !== null);
  const allDiagnosticPartsAbsent = diagnosticParts.every((part) => part === null);
  if (!allDiagnosticPartsPresent && !allDiagnosticPartsAbsent) {
    throw new CanonicalEvaluatorClientError(
      "Behavioral release artifacts must be present or absent as one atomic set.",
    );
  }
  if (request.stage !== "validation" && !allDiagnosticPartsAbsent) {
    throw new CanonicalEvaluatorClientError(
      "Repair and shadow stages cannot release behavioral diagnostics.",
    );
  }
  if (
    allDiagnosticPartsAbsent &&
    (result.derivation.behavioralAggregateHash !== null ||
      result.releaseChecks.privacyThresholdPassed)
  ) {
    throw new CanonicalEvaluatorClientError(
      "A result cannot claim a behavioral aggregate without its atomic signed release.",
    );
  }
  if (allDiagnosticPartsPresent) {
    const release = bundle.behavioralRelease;
    const evidence = bundle.behavioralEvidence;
    const cards = bundle.failureCards;
    const brief = bundle.diagnosticBrief;
    if (release === null || evidence === null || cards === null || brief === null) {
      throw new CanonicalEvaluatorClientError("Unreachable incomplete behavioral release.");
    }
    const sourceResultCommitmentHash = resultEnvelopeBehavioralSourceCommitmentHash(result);
    if (
      release.sourceResultEnvelopeHash !== sourceResultCommitmentHash ||
      result.derivation.behavioralAggregateHash !== release.contentHash ||
      result.releaseChecks.privacyThresholdPassed !== true ||
      release.releaseOnce !== true ||
      release.protocolHash !== request.protocolHash ||
      release.experimentNumber !== experimentNumber ||
      evidence.sourceEnvelopeHash !== sourceResultCommitmentHash ||
      evidence.protocolHash !== request.protocolHash ||
      evidence.experimentNumber !== experimentNumber ||
      evidence.releaseChecksPassed !== true ||
      cards.experimentNumber !== experimentNumber ||
      cards.suppressionApplied !== true ||
      brief.experimentNumber !== experimentNumber ||
      brief.sourceExperimentNumber !== experimentNumber ||
      brief.releaseId !== release.releaseId ||
      evidence.contentHash !== release.aggregateArtifactHashes.behavioralEvidence ||
      cards.contentHash !== release.aggregateArtifactHashes.failureCards ||
      brief.contentHash !== release.aggregateArtifactHashes.diagnosticBrief ||
      release.suppressedFindingCountBand !== evidence.suppressedFindingCountBand ||
      cards.behavioralEvidenceHash !== evidence.contentHash ||
      brief.failureCardsHash !== cards.contentHash ||
      brief.aggregateEvidenceHash !== evidence.contentHash ||
      canonicalJson(release.policyVersions) !== canonicalJson(evidence.policyVersions) ||
      canonicalJson(release.policyVersions) !== canonicalJson(cards.policyVersions) ||
      canonicalJson(release.policyVersions) !== canonicalJson(brief.policyVersions) ||
      canonicalJson(release.support) !== canonicalJson(evidence.analysisWindow.support) ||
      !release.support.complementaryCountSuppressionPassed ||
      !release.support.differencingBudgetPassed
    ) {
      throw new CanonicalEvaluatorClientError(
        "Behavioral release hash lineage is incomplete or inconsistent.",
      );
    }
  }
}

function assertSignedAtWithinPolicy(input: {
  readonly document: Readonly<Record<string, unknown>>;
  readonly label: string;
  readonly earliestMs: number;
  readonly nowMs: number;
  readonly maximumClockSkewMs: number;
}): void {
  const signature = record(input.document.signature, `${input.label} signature`);
  const signedAt =
    typeof signature.signedAt === "string" ? Date.parse(signature.signedAt) : Number.NaN;
  const createdAt =
    typeof input.document.createdAt === "string"
      ? Date.parse(input.document.createdAt)
      : Number.NaN;
  if (
    !Number.isFinite(signedAt) ||
    !Number.isFinite(createdAt) ||
    signedAt < createdAt ||
    signedAt < input.earliestMs - input.maximumClockSkewMs ||
    signedAt > input.nowMs + input.maximumClockSkewMs
  ) {
    throw new CanonicalEvaluatorClientError(
      `${input.label} signature timestamp is outside policy.`,
    );
  }
}

export class CanonicalEvaluatorClient {
  readonly #endpoint: string;
  readonly #credentialEnvironmentName: string;
  readonly #transport: CanonicalEvaluatorTransport;
  readonly #keyring: CanonicalEvaluatorKeyring;
  readonly #replayLedger: CanonicalEvaluatorReplayLedger;
  readonly #now: () => Date;
  readonly #maximumClockSkewMs: number;

  public constructor(options: CanonicalEvaluatorClientOptions) {
    if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(options.credentialEnvironmentName)) {
      throw new CanonicalEvaluatorClientError("Evaluator credential reference is malformed.");
    }
    this.#endpoint = normalizeEndpoint(options.endpoint);
    this.#credentialEnvironmentName = options.credentialEnvironmentName;
    this.#transport = options.transport;
    this.#keyring = options.keyring;
    this.#replayLedger = options.replayLedger;
    this.#now = options.now ?? (() => new Date());
    this.#maximumClockSkewMs = options.maximumClockSkewMs ?? 5 * 60_000;
  }

  public async evaluate(request: TrustedEvaluationRequest): Promise<ReleasedEvaluationBundle> {
    assertEvaluationRequest(request);
    const requestHash = hashEvaluationRequest(request);
    const claimedAt = this.#now().toISOString();
    if (
      !(await this.#replayLedger.claim({
        requestId: request.requestId,
        requestHash,
        claimedAt,
      }))
    ) {
      throw new CanonicalEvaluatorClientError(
        "Evaluator request ID or hash has already been consumed.",
      );
    }
    const bundle = parseBundle(
      await this.#transport.submit(this.#endpoint, request, this.#credentialEnvironmentName),
    );
    await verifyDocumentSignature(
      bundle.result as unknown as Readonly<Record<string, unknown>>,
      this.#keyring,
    );
    await verifyDocumentSignature(
      bundle.cacheAttestation as unknown as Readonly<Record<string, unknown>>,
      this.#keyring,
    );
    if (bundle.behavioralRelease !== null) {
      await verifyDocumentSignature(
        bundle.behavioralRelease as unknown as Readonly<Record<string, unknown>>,
        this.#keyring,
      );
    }
    assertBundleLinks(bundle, request, requestHash);
    const now = this.#now().getTime();
    const submittedAt = Date.parse(request.submittedAt);
    assertSignedAtWithinPolicy({
      document: bundle.result as unknown as Readonly<Record<string, unknown>>,
      label: "Result envelope",
      earliestMs: Math.max(submittedAt, Date.parse(bundle.result.derivation.derivedAt)),
      nowMs: now,
      maximumClockSkewMs: this.#maximumClockSkewMs,
    });
    assertSignedAtWithinPolicy({
      document: bundle.cacheAttestation as unknown as Readonly<Record<string, unknown>>,
      label: "Cache attestation",
      earliestMs: Math.max(submittedAt, Date.parse(bundle.cacheAttestation.sealedWindow.closedAt)),
      nowMs: now,
      maximumClockSkewMs: this.#maximumClockSkewMs,
    });
    if (bundle.behavioralRelease !== null) {
      assertSignedAtWithinPolicy({
        document: bundle.behavioralRelease as unknown as Readonly<Record<string, unknown>>,
        label: "Behavioral release",
        earliestMs: submittedAt,
        nowMs: now,
        maximumClockSkewMs: this.#maximumClockSkewMs,
      });
    }
    if (bundle.diagnosticBrief !== null && Date.parse(bundle.diagnosticBrief.expiresAt) <= now) {
      throw new CanonicalEvaluatorClientError(
        "Diagnostic brief expired before it crossed the trust boundary.",
      );
    }
    assertSafeForLocalPersistence(bundle);
    return bundle;
  }
}
