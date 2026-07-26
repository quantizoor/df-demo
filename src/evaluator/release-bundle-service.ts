import type { TrustedCloudArtifactRef } from "../cloud/types.js";
import type {
  BehavioralEvidence,
  CacheAttestation,
  DiagnosticBrief,
  FailureCards,
} from "../schemas/artifacts.js";
import {
  canonicalHash,
  canonicalJson,
  sha256,
} from "../schemas/canonical.js";
import { assertValidDocument } from "../schemas/registry.js";
import type {
  SignedBehavioralRelease,
  SignedResultEnvelope,
} from "../schemas/trusted.js";
import type { ReleasedEvaluationBundle } from "./canonical-client.js";
import type { TrustedEvaluationService } from "./composition.js";
import {
  assertEvaluationRequest,
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "./contracts.js";
import { resultEnvelopeBehavioralSourceCommitmentHash } from "./release-lineage.js";
import { assertSafeForLocalPersistence } from "./retention.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_KEY_VERSION =
  /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const TRUSTED_URI =
  /^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const DEFAULT_MAXIMUM_ARTIFACT_BYTES = 512 * 1024;
const MAXIMUM_ARTIFACT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAXIMUM_TOTAL_BYTES = 2 * 1024 * 1024;
const MAXIMUM_TOTAL_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAXIMUM_REPLAY_RECORDS = 256;
const MAXIMUM_REPLAY_RECORDS = 4_096;
const DEFAULT_MAXIMUM_CLOCK_SKEW_MS = 5 * 60_000;
const OPTION_KEYS = new Set([
  "service",
  "source",
  "reader",
  "signatureVerifier",
  "maximumArtifactBytes",
  "maximumTotalBytes",
  "maximumReplayRecords",
  "maximumClockSkewMs",
  "now",
]);

export type EvaluationReleaseArtifactPurpose =
  | "cache-attestation"
  | "behavioral-release"
  | "behavioral-evidence"
  | "failure-cards"
  | "diagnostic-brief";

export interface EvaluationReleaseArtifactQuery {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.evaluation-release-artifact-query.v1";
  readonly purpose: EvaluationReleaseArtifactPurpose;
  readonly contentHash: string;
  readonly queryHash: string;
}

/**
 * Resolves immutable release-safe JSON only by a content hash already
 * committed by the signed result or signed behavioral release.
 */
export interface TrustedEvaluationReleaseArtifactSource {
  readonly boundary: "trusted-cloud";
  locate(
    query: EvaluationReleaseArtifactQuery,
  ): Promise<TrustedCloudArtifactRef | undefined>;
}

export interface TrustedEvaluationReleaseArtifactReader {
  readonly boundary: "trusted-cloud";
  readUtf8(
    artifact: TrustedCloudArtifactRef,
    maximumBytes: number,
  ): Promise<string>;
}

export type EvaluationReleaseSignaturePurpose =
  | "result-envelope"
  | "cache-attestation"
  | "behavioral-release";

export type EvaluationReleaseSignedDocument =
  | SignedResultEnvelope
  | CacheAttestation
  | SignedBehavioralRelease;

export interface EvaluationReleaseSignatureVerificationRequest {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.evaluation-release-signature-verification-request.v1";
  readonly purpose: EvaluationReleaseSignaturePurpose;
  readonly documentHash: string;
  readonly keyId: string;
  readonly signedAt: string;
  readonly document: EvaluationReleaseSignedDocument;
}

export interface EvaluationReleaseSignatureVerification {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.evaluation-release-signature-verification.v1";
  readonly purpose: EvaluationReleaseSignaturePurpose;
  readonly documentHash: string;
  readonly keyId: string;
  readonly keyVersion: string;
  readonly signedAt: string;
  readonly verifierAttestationHash: string;
  readonly verified: true;
}

/**
 * The implementation must resolve the historical purpose-specific key version
 * selected by `(purpose, keyId, signedAt)` and apply rotation/revocation
 * policy before returning its deterministic receipt.
 */
export interface TrustedEvaluationReleaseSignatureVerifier {
  readonly boundary:
    "trusted-cloud-evaluation-release-signature-verifier";
  verify(
    request: EvaluationReleaseSignatureVerificationRequest,
  ): Promise<EvaluationReleaseSignatureVerification>;
}

export interface ArtifactBackedEvaluationReleaseBundleServiceOptions {
  readonly service: TrustedEvaluationService;
  readonly source: TrustedEvaluationReleaseArtifactSource;
  readonly reader: TrustedEvaluationReleaseArtifactReader;
  readonly signatureVerifier:
    TrustedEvaluationReleaseSignatureVerifier;
  readonly maximumArtifactBytes?: number;
  readonly maximumTotalBytes?: number;
  readonly maximumReplayRecords?: number;
  readonly maximumClockSkewMs?: number;
  readonly now?: () => Date;
}

interface ReadBudget {
  totalBytes: number;
  readonly artifactUris: Set<string>;
  readonly contentHashes: Set<string>;
}

interface ReplayRecord {
  readonly requestHash: string;
  readonly bundleJson: string;
  readonly verificationEvidenceHash: string;
}

export class EvaluationReleaseBundleServiceError extends Error {
  override readonly name = "EvaluationReleaseBundleServiceError";

  constructor() {
    super("Trusted evaluation release bundle failed closed.");
  }
}

function fail(): never {
  throw new EvaluationReleaseBundleServiceError();
}

function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail();
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key) ||
        !Object.hasOwn(
          Object.getOwnPropertyDescriptor(value, key) ?? {},
          "value",
        ),
    )
  ) {
    fail();
  }
}

function canonicalTimestamp(value: unknown): number {
  if (typeof value !== "string") fail();
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    fail();
  }
  return parsed;
}

function readNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail();
  return new Date(value.getTime());
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreezeJson<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
    return Object.freeze(value) as Readonly<T>;
  }
  if (isPlainRecord(value)) {
    for (const item of Object.values(value)) deepFreezeJson(item);
    return Object.freeze(value) as Readonly<T>;
  }
  return value as Readonly<T>;
}

function artifactQuery(
  purpose: EvaluationReleaseArtifactPurpose,
  contentHash: string,
): EvaluationReleaseArtifactQuery {
  if (!SHA256.test(contentHash)) fail();
  const unsigned = {
    schemaVersion: 1 as const,
    domain:
      "dark-factory.evaluation-release-artifact-query.v1" as const,
    purpose,
    contentHash,
  };
  return {
    ...unsigned,
    queryHash: canonicalHash(unsigned),
  };
}

function assertArtifactReference(
  value: unknown,
  maximumBytes: number,
): asserts value is TrustedCloudArtifactRef {
  exactKeys(value, ["uri", "sha256", "mediaType", "byteLength"]);
  const artifact = value as unknown as TrustedCloudArtifactRef;
  if (
    typeof artifact.uri !== "string" ||
    !TRUSTED_URI.test(artifact.uri) ||
    artifact.uri.includes("..") ||
    typeof artifact.sha256 !== "string" ||
    !SHA256.test(artifact.sha256) ||
    artifact.mediaType !== "application/json" ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength <= 0 ||
    artifact.byteLength > maximumBytes
  ) {
    fail();
  }
}

function experimentNumber(request: TrustedEvaluationRequest): number {
  const prefix = request.experimentId.split("-", 1)[0] ?? "";
  const value = Number.parseInt(prefix, 10);
  if (
    !/^\d+$/u.test(prefix) ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    fail();
  }
  return value;
}

function expectedResultKind(
  stage: TrustedEvaluationRequest["stage"],
): "repair" | "validation" | "shadow" {
  if (
    stage === "repair" ||
    stage === "validation" ||
    stage === "shadow"
  ) {
    return stage;
  }
  fail();
}

function assertResultLinks(
  result: SignedResultEnvelope,
  request: TrustedEvaluationRequest,
  requestHash: string,
): void {
  if (
    result.oneUseRequest.requestId !== request.requestId ||
    result.oneUseRequest.requestHash !== requestHash ||
    result.oneUseRequest.reuseProhibited !== true ||
    result.experimentNumber !== experimentNumber(request) ||
    result.mode !== request.runMode ||
    result.protocolHash !== request.protocolHash ||
    result.payload.kind !== expectedResultKind(request.stage) ||
    result.derivation.rawArtifacts.exported !== false ||
    result.derivation.rawArtifacts.retentionDisposition !==
      "destroyed" ||
    result.releaseChecks.schemaPassed !== true ||
    result.releaseChecks.graderCanaryScanPassed !== true ||
    result.releaseChecks.contentFingerprintScanPassed !== true ||
    result.releaseChecks.taskIdentityScanPassed !== true ||
    result.releaseChecks.privacyThresholdPassed !==
      (result.derivation.behavioralAggregateHash !== null)
  ) {
    fail();
  }
}

function assertCacheLinks(
  cache: CacheAttestation,
  result: SignedResultEnvelope,
): void {
  const openedAt = canonicalTimestamp(cache.sealedWindow.openedAt);
  const closedAt = canonicalTimestamp(cache.sealedWindow.closedAt);
  if (
    cache.contentHash !== result.derivation.cacheAttestationHash ||
    cache.experimentNumber !== result.experimentNumber ||
    cache.protocolHash !== result.protocolHash ||
    openedAt > closedAt
  ) {
    fail();
  }
}

function assertDiagnosticLinks(input: {
  readonly result: SignedResultEnvelope;
  readonly release: SignedBehavioralRelease;
  readonly evidence: BehavioralEvidence;
  readonly cards: FailureCards;
  readonly brief: DiagnosticBrief;
}): void {
  const { result, release, evidence, cards, brief } = input;
  const sourceHash =
    resultEnvelopeBehavioralSourceCommitmentHash(result);
  const analysisOpenedAt = canonicalTimestamp(
    evidence.analysisWindow.openedAt,
  );
  const analysisClosedAt = canonicalTimestamp(
    evidence.analysisWindow.closedAt,
  );
  const evidenceCreatedAt = canonicalTimestamp(evidence.createdAt);
  const cardsCreatedAt = canonicalTimestamp(cards.createdAt);
  const briefCreatedAt = canonicalTimestamp(brief.createdAt);
  const releaseCreatedAt = canonicalTimestamp(release.createdAt);
  const resultCreatedAt = canonicalTimestamp(result.createdAt);
  const expiresAt = canonicalTimestamp(brief.expiresAt);
  if (
    result.derivation.behavioralAggregateHash !==
      release.contentHash ||
    release.sourceResultEnvelopeHash !== sourceHash ||
    release.protocolHash !== result.protocolHash ||
    release.experimentNumber !== result.experimentNumber ||
    release.releaseOnce !== true ||
    evidence.sourceEnvelopeHash !== sourceHash ||
    evidence.protocolHash !== result.protocolHash ||
    evidence.experimentNumber !== result.experimentNumber ||
    evidence.releaseChecksPassed !== true ||
    cards.experimentNumber !== result.experimentNumber ||
    brief.experimentNumber !== result.experimentNumber ||
    brief.sourceExperimentNumber !== result.experimentNumber ||
    brief.releaseId !== release.releaseId ||
    release.aggregateArtifactHashes.behavioralEvidence !==
      evidence.contentHash ||
    release.aggregateArtifactHashes.failureCards !==
      cards.contentHash ||
    release.aggregateArtifactHashes.diagnosticBrief !==
      brief.contentHash ||
    release.suppressedFindingCountBand !==
      evidence.suppressedFindingCountBand ||
    cards.behavioralEvidenceHash !== evidence.contentHash ||
    cards.suppressionApplied !== true ||
    brief.aggregateEvidenceHash !== evidence.contentHash ||
    brief.failureCardsHash !== cards.contentHash ||
    canonicalJson(release.policyVersions) !==
      canonicalJson(evidence.policyVersions) ||
    canonicalJson(release.policyVersions) !==
      canonicalJson(cards.policyVersions) ||
    canonicalJson(release.policyVersions) !==
      canonicalJson(brief.policyVersions) ||
    canonicalJson(release.support) !==
      canonicalJson(evidence.analysisWindow.support) ||
    analysisOpenedAt > analysisClosedAt ||
    analysisClosedAt > evidenceCreatedAt ||
    evidenceCreatedAt > cardsCreatedAt ||
    cardsCreatedAt > briefCreatedAt ||
    briefCreatedAt > releaseCreatedAt ||
    releaseCreatedAt > resultCreatedAt ||
    expiresAt <= briefCreatedAt ||
    !release.support.complementaryCountSuppressionPassed ||
    !release.support.differencingBudgetPassed
  ) {
    fail();
  }
  const releasedCards = new Map<string, string>();
  const evidenceMetricIds = new Set(
    evidence.metrics.map((metric) => metric.metricId),
  );
  if (evidenceMetricIds.size !== evidence.metrics.length) fail();
  for (const card of cards.cards) {
    if (
      releasedCards.has(card.cardId) ||
      card.metricIds.some(
        (metricId) => !evidenceMetricIds.has(metricId),
      )
    ) {
      fail();
    }
    releasedCards.set(card.cardId, canonicalJson(card));
  }
  const briefCardIds = new Set<string>();
  for (const card of brief.cards) {
    if (
      briefCardIds.has(card.cardId) ||
      releasedCards.get(card.cardId) !== canonicalJson(card)
    ) {
      fail();
    }
    briefCardIds.add(card.cardId);
  }
}

export function evaluationReleaseSignatureVerificationAttestationHash(
  input: {
    readonly purpose: EvaluationReleaseSignaturePurpose;
    readonly documentHash: string;
    readonly keyId: string;
    readonly keyVersion: string;
    readonly signedAt: string;
  },
): string {
  return canonicalHash({
    schemaVersion: 1,
    domain:
      "dark-factory.evaluation-release-signature-verified-evidence.v1",
    ...input,
    verified: true,
  });
}

function assertVerification(
  value: unknown,
  request: EvaluationReleaseSignatureVerificationRequest,
): asserts value is EvaluationReleaseSignatureVerification {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "purpose",
    "documentHash",
    "keyId",
    "keyVersion",
    "signedAt",
    "verifierAttestationHash",
    "verified",
  ]);
  const verification =
    value as unknown as EvaluationReleaseSignatureVerification;
  if (
    verification.schemaVersion !== 1 ||
    verification.domain !==
      "dark-factory.evaluation-release-signature-verification.v1" ||
    verification.purpose !== request.purpose ||
    verification.documentHash !== request.documentHash ||
    verification.keyId !== request.keyId ||
    typeof verification.keyVersion !== "string" ||
    !SAFE_KEY_VERSION.test(verification.keyVersion) ||
    verification.signedAt !== request.signedAt ||
    verification.verified !== true ||
    typeof verification.verifierAttestationHash !== "string" ||
    verification.verifierAttestationHash !==
      evaluationReleaseSignatureVerificationAttestationHash({
        purpose: request.purpose,
        documentHash: request.documentHash,
        keyId: request.keyId,
        keyVersion: verification.keyVersion,
        signedAt: request.signedAt,
      })
  ) {
    fail();
  }
}

function assertSignatureTime(input: {
  readonly document: EvaluationReleaseSignedDocument;
  readonly earliest: number;
  readonly now: number;
  readonly maximumClockSkewMs: number;
}): void {
  const createdAt = canonicalTimestamp(input.document.createdAt);
  const signedAt = canonicalTimestamp(
    input.document.signature.signedAt,
  );
  if (
    signedAt < createdAt ||
    signedAt < input.earliest ||
    signedAt > input.now + input.maximumClockSkewMs
  ) {
    fail();
  }
}

/**
 * Converts the narrow signed-result evaluator into the complete
 * `ReleasedEvaluationBundle` consumed by `ProductionBlindBroker`.
 *
 * It intentionally contains no HTTP transport and returns no artifact URI.
 */
export class ArtifactBackedEvaluationReleaseBundleService {
  readonly boundary = "trusted-cloud-evaluator-release-bundle" as const;
  readonly #evaluateResult: TrustedEvaluationService["evaluate"];
  readonly #locate: TrustedEvaluationReleaseArtifactSource["locate"];
  readonly #readUtf8: TrustedEvaluationReleaseArtifactReader["readUtf8"];
  readonly #verifySignature:
    TrustedEvaluationReleaseSignatureVerifier["verify"];
  readonly #maximumArtifactBytes: number;
  readonly #maximumTotalBytes: number;
  readonly #maximumReplayRecords: number;
  readonly #maximumClockSkewMs: number;
  readonly #now: () => Date;
  readonly #replays = new Map<string, ReplayRecord>();
  readonly #inFlight = new Map<
    string,
    Promise<ReleasedEvaluationBundle>
  >();

  constructor(
    options: ArtifactBackedEvaluationReleaseBundleServiceOptions,
  ) {
    if (!isPlainRecord(options)) fail();
    if (
      Reflect.ownKeys(options).some(
        (key) =>
          typeof key !== "string" ||
          !OPTION_KEYS.has(key) ||
          !Object.hasOwn(
            Object.getOwnPropertyDescriptor(options, key) ?? {},
            "value",
          ),
      )
    ) {
      fail();
    }
    const maximumArtifactBytes =
      options.maximumArtifactBytes ??
      DEFAULT_MAXIMUM_ARTIFACT_BYTES;
    const maximumTotalBytes =
      options.maximumTotalBytes ?? DEFAULT_MAXIMUM_TOTAL_BYTES;
    const maximumReplayRecords =
      options.maximumReplayRecords ??
      DEFAULT_MAXIMUM_REPLAY_RECORDS;
    const maximumClockSkewMs =
      options.maximumClockSkewMs ??
      DEFAULT_MAXIMUM_CLOCK_SKEW_MS;
    const service = options.service;
    const source = options.source;
    const reader = options.reader;
    const signatureVerifier = options.signatureVerifier;
    const evaluateResult = service?.evaluate;
    const locate = source?.locate;
    const readUtf8 = reader?.readUtf8;
    const verifySignature = signatureVerifier?.verify;
    const sourceNow = options.now ?? (() => new Date());
    if (
      service?.boundary !==
        "trusted-cloud-evaluator-service" ||
      source?.boundary !== "trusted-cloud" ||
      reader?.boundary !== "trusted-cloud" ||
      signatureVerifier?.boundary !==
        "trusted-cloud-evaluation-release-signature-verifier" ||
      typeof evaluateResult !== "function" ||
      typeof locate !== "function" ||
      typeof readUtf8 !== "function" ||
      typeof verifySignature !== "function" ||
      !Number.isSafeInteger(maximumArtifactBytes) ||
      maximumArtifactBytes < 1_024 ||
      maximumArtifactBytes > MAXIMUM_ARTIFACT_BYTES ||
      !Number.isSafeInteger(maximumTotalBytes) ||
      maximumTotalBytes < maximumArtifactBytes ||
      maximumTotalBytes > MAXIMUM_TOTAL_BYTES ||
      !Number.isSafeInteger(maximumReplayRecords) ||
      maximumReplayRecords < 1 ||
      maximumReplayRecords > MAXIMUM_REPLAY_RECORDS ||
      !Number.isSafeInteger(maximumClockSkewMs) ||
      maximumClockSkewMs < 0 ||
      maximumClockSkewMs > 60 * 60_000 ||
      typeof sourceNow !== "function"
    ) {
      fail();
    }
    this.#evaluateResult = evaluateResult.bind(service);
    this.#locate = locate.bind(source);
    this.#readUtf8 = readUtf8.bind(reader);
    this.#verifySignature = verifySignature.bind(
      signatureVerifier,
    );
    this.#maximumArtifactBytes = maximumArtifactBytes;
    this.#maximumTotalBytes = maximumTotalBytes;
    this.#maximumReplayRecords = maximumReplayRecords;
    this.#maximumClockSkewMs = maximumClockSkewMs;
    this.#now = (): Date => readNow(sourceNow);
  }

  async #readArtifact(
    purpose: EvaluationReleaseArtifactPurpose,
    contentHash: string,
    budget: ReadBudget,
  ): Promise<unknown> {
    const query = artifactQuery(purpose, contentHash);
    const queryJson = canonicalJson(query);
    const queryInput = cloneCanonical(query);
    const located = await this.#locate(queryInput);
    if (canonicalJson(queryInput) !== queryJson) fail();
    assertArtifactReference(located, this.#maximumArtifactBytes);
    const artifact = deepFreezeJson(
      cloneCanonical(located),
    ) as TrustedCloudArtifactRef;
    if (
      budget.artifactUris.has(artifact.uri) ||
      budget.contentHashes.has(contentHash)
    ) {
      fail();
    }
    budget.artifactUris.add(artifact.uri);
    budget.contentHashes.add(contentHash);
    budget.totalBytes += artifact.byteLength;
    if (
      !Number.isSafeInteger(budget.totalBytes) ||
      budget.totalBytes > this.#maximumTotalBytes
    ) {
      fail();
    }
    const artifactJson = canonicalJson(artifact);
    const artifactInput = cloneCanonical(artifact);
    const raw = await this.#readUtf8(
      artifactInput,
      this.#maximumArtifactBytes,
    );
    if (
      canonicalJson(artifactInput) !== artifactJson ||
      typeof raw !== "string" ||
      Buffer.byteLength(raw, "utf8") !== artifact.byteLength ||
      sha256(raw) !== artifact.sha256
    ) {
      fail();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail();
    }
    if (
      !isPlainRecord(parsed) ||
      raw !== `${canonicalJson(parsed)}\n` ||
      parsed["contentHash"] !== contentHash
    ) {
      fail();
    }
    return deepFreezeJson(cloneCanonical(parsed));
  }

  async #verify(
    purpose: EvaluationReleaseSignaturePurpose,
    document: EvaluationReleaseSignedDocument,
    earliest: number,
    now: number,
  ): Promise<EvaluationReleaseSignatureVerification> {
    assertSignatureTime({
      document,
      earliest,
      now,
      maximumClockSkewMs: this.#maximumClockSkewMs,
    });
    const request: EvaluationReleaseSignatureVerificationRequest = {
      schemaVersion: 1,
      domain:
        "dark-factory.evaluation-release-signature-verification-request.v1",
      purpose,
      documentHash: document.contentHash,
      keyId: document.signature.keyId,
      signedAt: document.signature.signedAt,
      document: cloneCanonical(document),
    };
    const requestJson = canonicalJson(request);
    const requestInput = cloneCanonical(request);
    const verification = await this.#verifySignature(requestInput);
    if (canonicalJson(requestInput) !== requestJson) fail();
    assertVerification(verification, request);
    return cloneCanonical(verification);
  }

  #recordReplay(
    requestId: string,
    requestHash: string,
    bundle: ReleasedEvaluationBundle,
    verifications:
      readonly EvaluationReleaseSignatureVerification[],
  ): void {
    const bundleJson = canonicalJson(bundle);
    const verificationEvidenceHash = canonicalHash(
      verifications.map(
        (verification) => verification.verifierAttestationHash,
      ),
    );
    const previous = this.#replays.get(requestId);
    if (
      previous !== undefined &&
      (previous.requestHash !== requestHash ||
        previous.bundleJson !== bundleJson ||
        previous.verificationEvidenceHash !==
          verificationEvidenceHash)
    ) {
      fail();
    }
    if (previous !== undefined) return;
    if (this.#replays.size >= this.#maximumReplayRecords) {
      const oldest = this.#replays.keys().next().value as
        | string
        | undefined;
      if (oldest !== undefined) this.#replays.delete(oldest);
    }
    this.#replays.set(requestId, {
      requestHash,
      bundleJson,
      verificationEvidenceHash,
    });
  }

  async #assemble(
    request: TrustedEvaluationRequest,
    requestJson: string,
    requestHash: string,
  ): Promise<ReleasedEvaluationBundle> {
    const requestInput = cloneCanonical(request);
    const resultCandidate = await this.#evaluateResult(requestInput);
    if (
      canonicalJson(requestInput) !== requestJson ||
      canonicalJson(request) !== requestJson
    ) {
      fail();
    }
    assertValidDocument("signedResultEnvelope", resultCandidate);
    const resultJson = canonicalJson(resultCandidate);
    const result = deepFreezeJson(
      cloneCanonical(resultCandidate),
    ) as SignedResultEnvelope;
    assertResultLinks(result, request, requestHash);
    const now = this.#now().getTime();
    const submittedAt = canonicalTimestamp(request.submittedAt);
    const verifications: EvaluationReleaseSignatureVerification[] = [
      await this.#verify(
        "result-envelope",
        result,
        Math.max(
          submittedAt,
          canonicalTimestamp(result.derivation.derivedAt),
        ),
        now,
      ),
    ];

    const budget: ReadBudget = {
      totalBytes: 0,
      artifactUris: new Set(),
      contentHashes: new Set(),
    };
    const cacheCandidate = await this.#readArtifact(
      "cache-attestation",
      result.derivation.cacheAttestationHash,
      budget,
    );
    assertValidDocument("cacheAttestation", cacheCandidate);
    const cache = cacheCandidate as CacheAttestation;
    assertCacheLinks(cache, result);
    verifications.push(
      await this.#verify(
        "cache-attestation",
        cache,
        Math.max(
          submittedAt,
          canonicalTimestamp(cache.sealedWindow.closedAt),
        ),
        now,
      ),
    );

    let behavioralRelease: SignedBehavioralRelease | null = null;
    let behavioralEvidence: BehavioralEvidence | null = null;
    let failureCards: FailureCards | null = null;
    let diagnosticBrief: DiagnosticBrief | null = null;
    if (result.derivation.behavioralAggregateHash !== null) {
      if (request.stage !== "validation") fail();
      const releaseCandidate = await this.#readArtifact(
        "behavioral-release",
        result.derivation.behavioralAggregateHash,
        budget,
      );
      assertValidDocument(
        "signedBehavioralRelease",
        releaseCandidate,
      );
      behavioralRelease =
        releaseCandidate as SignedBehavioralRelease;
      verifications.push(
        await this.#verify(
          "behavioral-release",
          behavioralRelease,
          submittedAt,
          now,
        ),
      );

      const evidenceCandidate = await this.#readArtifact(
        "behavioral-evidence",
        behavioralRelease.aggregateArtifactHashes
          .behavioralEvidence,
        budget,
      );
      const cardsCandidate = await this.#readArtifact(
        "failure-cards",
        behavioralRelease.aggregateArtifactHashes.failureCards,
        budget,
      );
      const briefCandidate = await this.#readArtifact(
        "diagnostic-brief",
        behavioralRelease.aggregateArtifactHashes.diagnosticBrief,
        budget,
      );
      assertValidDocument(
        "behavioralEvidence",
        evidenceCandidate,
      );
      assertValidDocument("failureCards", cardsCandidate);
      assertValidDocument("diagnosticBrief", briefCandidate);
      behavioralEvidence = evidenceCandidate as BehavioralEvidence;
      failureCards = cardsCandidate as FailureCards;
      diagnosticBrief = briefCandidate as DiagnosticBrief;
      assertDiagnosticLinks({
        result,
        release: behavioralRelease,
        evidence: behavioralEvidence,
        cards: failureCards,
        brief: diagnosticBrief,
      });
      if (
        canonicalTimestamp(diagnosticBrief.expiresAt) <= now
      ) {
        fail();
      }
    }

    const bundle: ReleasedEvaluationBundle = {
      result,
      cacheAttestation: cache,
      behavioralRelease,
      behavioralEvidence,
      failureCards,
      diagnosticBrief,
    };
    assertSafeForLocalPersistence(bundle);
    if (
      canonicalJson(resultCandidate) !== resultJson ||
      canonicalJson(request) !== requestJson
    ) {
      fail();
    }
    this.#recordReplay(
      request.requestId,
      requestHash,
      bundle,
      verifications,
    );
    return deepFreezeJson(
      cloneCanonical(bundle),
    ) as ReleasedEvaluationBundle;
  }

  public async evaluate(
    request: TrustedEvaluationRequest,
  ): Promise<ReleasedEvaluationBundle> {
    try {
      assertEvaluationRequest(request);
      const requestJson = canonicalJson(request);
      const requestHash = hashEvaluationRequest(request);
      const replay = this.#replays.get(request.requestId);
      if (
        replay !== undefined &&
        replay.requestHash !== requestHash
      ) {
        fail();
      }
      let work = this.#inFlight.get(requestHash);
      if (work === undefined) {
        work = this.#assemble(
          cloneCanonical(request),
          requestJson,
          requestHash,
        );
        this.#inFlight.set(requestHash, work);
      }
      try {
        const bundle = await work;
        if (canonicalJson(request) !== requestJson) fail();
        return cloneCanonical(bundle);
      } finally {
        if (this.#inFlight.get(requestHash) === work) {
          this.#inFlight.delete(requestHash);
        }
      }
    } catch (error) {
      if (error instanceof EvaluationReleaseBundleServiceError) {
        throw error;
      }
      fail();
    }
  }
}
