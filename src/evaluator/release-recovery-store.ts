import type { BrokerFailureCode } from "../broker/ledger.js";
import type { TrustedCanonicalAggregate } from "../broker/service.js";
import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import { assertValidDocument } from "../schemas/registry.js";
import type { SignedResultEnvelope } from "../schemas/trusted.js";
import {
  hashTrustedBehavioralPreparationAbandonment,
  hashTrustedBehavioralPreparationFinalization,
} from "./behavioral-preparation-store.js";
import {
  hashTrustedBehavioralReleaseOrphanFinalization,
  type TrustedBehavioralReleaseFinalization,
  type TrustedBehavioralReleaseOrphanFinalizationReceipt,
} from "./behavioral-release-producer.js";
import {
  assertSafeForLocalPersistence,
  hashTrustedRawArtifactManifest,
  hashTrustedRawArtifactSet,
  type TrustedRawArtifactManifest,
  type TrustedRawDestructionReceipt,
} from "./retention.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FAILURE_CODES = new Set<BrokerFailureCode>([
  "panel-allocation-failed",
  "runtime-attestation-failed",
  "evaluation-failed",
  "normalization-failed",
  "raw-destruction-failed",
  "release-validation-failed",
]);

export type TrustedReleaseRecoveryBehavioralState =
  | {
      readonly status: "none";
    }
  | {
      readonly status: "prepared";
      readonly preparationHash: string;
      readonly sourceResultEnvelopeHash: string;
    }
  | {
      readonly status: "consumed";
      readonly preparationHash: string;
    }
  | {
      readonly status: "finalized";
      readonly preparationHash: string;
      readonly sourceResultEnvelopeHash: string;
      readonly finalizationHash: string;
      readonly finalization: TrustedBehavioralReleaseFinalization;
    }
  | {
      readonly status: "abandoned";
      readonly preparationHash: string;
      readonly sourceResultEnvelopeHash: string;
      readonly finalizationHash: string;
      readonly finalization: TrustedBehavioralReleaseFinalization;
      readonly orphanFinalizationHash: string;
      readonly orphanFinalization: TrustedBehavioralReleaseOrphanFinalizationReceipt;
      readonly abandonmentHash: string;
    };

/**
 * Exact evaluator-private checkpoint written only after a signed raw
 * destruction receipt has been verified. It contains all material needed to
 * continue release finalization and result issuance without a panel lookup,
 * raw-artifact read, Harbor invocation, or task rerun.
 */
export interface TrustedPostDestructionReleaseRecoveryRecord {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-private-post-destruction-release-recovery";
  readonly requestId: string;
  readonly requestHash: string;
  readonly protocolHash: string;
  readonly dispositionAttestationHash: string;
  readonly retentionPolicyHash: string;
  readonly rawManifest: TrustedRawArtifactManifest;
  readonly destructionReceipt: TrustedRawDestructionReceipt;
  readonly aggregate: TrustedCanonicalAggregate;
  readonly behavioral: TrustedReleaseRecoveryBehavioralState;
  readonly status: "open" | "result-issued" | "completed" | "failed";
  readonly envelope: SignedResultEnvelope | null;
  readonly envelopeHash: string | null;
  readonly failureCode: BrokerFailureCode | null;
  readonly revision: number;
  readonly recordHash: string;
}

export interface TrustedReleaseRecoveryResolution {
  readonly status: "missing" | "found";
  readonly requestHash: string;
  readonly protocolHash: string;
  readonly record?: TrustedPostDestructionReleaseRecoveryRecord;
}

export interface TrustedReleaseRecoveryWriteReceipt {
  readonly status: "created" | "already-created" | "advanced" | "already-advanced";
  readonly requestHash: string;
  readonly protocolHash: string;
  readonly revision: number;
  readonly recordHash: string;
}

/**
 * Exact-query-only evaluator-private store. Implementations must be
 * linearizable and durable; production accepts only the trusted-cloud
 * boundary. There is intentionally no list, prefix, or delete method.
 */
export interface TrustedPostDestructionReleaseRecoveryStore {
  readonly boundary: "trusted-cloud" | "test-only-in-memory";

  create(
    record: TrustedPostDestructionReleaseRecoveryRecord,
  ): Promise<TrustedReleaseRecoveryWriteReceipt>;

  resolve(input: {
    readonly requestHash: string;
    readonly protocolHash: string;
  }): Promise<TrustedReleaseRecoveryResolution>;

  advance(input: {
    readonly requestHash: string;
    readonly protocolHash: string;
    readonly priorRecordHash: string;
    readonly next: TrustedPostDestructionReleaseRecoveryRecord;
  }): Promise<TrustedReleaseRecoveryWriteReceipt>;
}

export class TrustedReleaseRecoveryStoreError extends Error {
  override readonly name = "TrustedReleaseRecoveryStoreError";
}

function fail(message: string): never {
  throw new TrustedReleaseRecoveryStoreError(message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail(`${label} has non-canonical fields.`);
  }
}

function assertTimestamp(value: unknown, label: string): void {
  if (typeof value !== "string") fail(`${label} is malformed.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${label} is not canonical UTC.`);
  }
}

function assertSignature(value: unknown): void {
  if (!isRecord(value)) fail("Destruction signature is malformed.");
  exactKeys(value, ["algorithm", "keyId", "signedAt", "signature"], "Destruction signature");
  if (
    value.algorithm !== "ed25519" ||
    typeof value.keyId !== "string" ||
    !SAFE_ID.test(value.keyId) ||
    typeof value.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86,128}={0,2}$/u.test(value.signature)
  ) {
    fail("Destruction signature is malformed.");
  }
  assertTimestamp(value.signedAt, "Destruction signature time");
}

function assertRawLineage(
  manifest: unknown,
  receipt: unknown,
  retentionPolicyHash: string,
): asserts manifest is TrustedRawArtifactManifest {
  if (!isRecord(manifest) || !isRecord(receipt)) {
    fail("Raw destruction lineage is malformed.");
  }
  exactKeys(
    manifest,
    [
      "manifestId",
      "policyHash",
      "createdAt",
      "destroyBy",
      "localExportAllowed",
      "artifacts",
      "artifactSetHash",
      "manifestHash",
    ],
    "Raw manifest",
  );
  exactKeys(
    receipt,
    [
      "manifestId",
      "manifestHash",
      "policyHash",
      "artifactSetHash",
      "destroyedAt",
      "destruction",
      "artifactCount",
      "verifierAttestationHash",
      "signature",
    ],
    "Raw destruction receipt",
  );
  if (
    typeof manifest.manifestId !== "string" ||
    !SAFE_ID.test(manifest.manifestId) ||
    manifest.policyHash !== retentionPolicyHash ||
    manifest.localExportAllowed !== false ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== 3 ||
    !SHA256.test(String(manifest.artifactSetHash)) ||
    !SHA256.test(String(manifest.manifestHash))
  ) {
    fail("Raw manifest is detached.");
  }
  const kinds = ["atif", "grader-output", "harbor-output"];
  for (const [index, artifact] of manifest.artifacts.entries()) {
    if (!isRecord(artifact)) fail("Raw artifact reference is malformed.");
    exactKeys(
      artifact,
      ["kind", "uri", "sha256", "byteLength", "encrypted"],
      "Raw artifact reference",
    );
    if (
      artifact.kind !== kinds[index] ||
      typeof artifact.uri !== "string" ||
      !/^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(artifact.uri) ||
      typeof artifact.sha256 !== "string" ||
      !SHA256.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.byteLength) ||
      (artifact.byteLength as number) <= 0 ||
      artifact.encrypted !== true
    ) {
      fail("Raw artifact reference is malformed.");
    }
  }
  const typedManifest = manifest as unknown as TrustedRawArtifactManifest;
  if (
    typedManifest.artifactSetHash !== hashTrustedRawArtifactSet(typedManifest.artifacts) ||
    typedManifest.manifestHash !==
      hashTrustedRawArtifactManifest({
        manifestId: typedManifest.manifestId,
        policyHash: typedManifest.policyHash,
        createdAt: typedManifest.createdAt,
        destroyBy: typedManifest.destroyBy,
        localExportAllowed: typedManifest.localExportAllowed,
        artifacts: typedManifest.artifacts,
        artifactSetHash: typedManifest.artifactSetHash,
      }) ||
    receipt.manifestId !== typedManifest.manifestId ||
    receipt.manifestHash !== typedManifest.manifestHash ||
    receipt.policyHash !== retentionPolicyHash ||
    receipt.artifactSetHash !== typedManifest.artifactSetHash ||
    (receipt.destruction !== "delete" && receipt.destruction !== "crypto-shred") ||
    receipt.artifactCount !== 3 ||
    typeof receipt.verifierAttestationHash !== "string" ||
    !SHA256.test(receipt.verifierAttestationHash)
  ) {
    fail("Raw destruction lineage is detached.");
  }
  assertTimestamp(manifest.createdAt, "Raw manifest creation time");
  assertTimestamp(manifest.destroyBy, "Raw manifest destruction deadline");
  assertTimestamp(receipt.destroyedAt, "Raw destruction time");
  assertSignature(receipt.signature);
}

function assertAggregate(
  value: unknown,
  input: {
    readonly requestHash: string;
    readonly protocolHash: string;
    readonly rawManifestId: string;
  },
): asserts value is TrustedCanonicalAggregate {
  if (!isRecord(value)) fail("Recovery aggregate is malformed.");
  exactKeys(
    value,
    [
      "sensitivity",
      "requestHash",
      "protocolHash",
      "rawManifestId",
      "payload",
      "normalizedOutcomeSetHash",
      "cacheAttestationHash",
      "behavioralAggregateHash",
      "derivedAt",
      "releaseChecks",
    ],
    "Recovery aggregate",
  );
  if (
    value.sensitivity !== "trusted-canonical-aggregate" ||
    value.requestHash !== input.requestHash ||
    value.protocolHash !== input.protocolHash ||
    value.rawManifestId !== input.rawManifestId ||
    !isRecord(value.payload) ||
    (value.payload.kind !== "repair" &&
      value.payload.kind !== "validation" &&
      value.payload.kind !== "shadow") ||
    typeof value.normalizedOutcomeSetHash !== "string" ||
    !SHA256.test(value.normalizedOutcomeSetHash) ||
    typeof value.cacheAttestationHash !== "string" ||
    !SHA256.test(value.cacheAttestationHash) ||
    (value.behavioralAggregateHash !== null &&
      (typeof value.behavioralAggregateHash !== "string" ||
        !SHA256.test(value.behavioralAggregateHash))) ||
    !isRecord(value.releaseChecks)
  ) {
    fail("Recovery aggregate is detached.");
  }
  exactKeys(
    value.releaseChecks,
    [
      "graderCanaryScanPassed",
      "contentFingerprintScanPassed",
      "taskIdentityScanPassed",
      "privacyThresholdPassed",
    ],
    "Recovery aggregate checks",
  );
  if (
    value.releaseChecks.graderCanaryScanPassed !== true ||
    value.releaseChecks.contentFingerprintScanPassed !== true ||
    value.releaseChecks.taskIdentityScanPassed !== true ||
    value.releaseChecks.privacyThresholdPassed !== (value.behavioralAggregateHash !== null)
  ) {
    fail("Recovery aggregate release checks are detached.");
  }
  assertTimestamp(value.derivedAt, "Recovery aggregate derivation time");
  assertSafeForLocalPersistence(value);
}

function assertFinalization(
  value: unknown,
  requestHash: string,
): asserts value is TrustedBehavioralReleaseFinalization {
  if (!isRecord(value)) fail("Behavioral finalization is malformed.");
  exactKeys(
    value,
    ["contentHash", "sourceSetHash", "privacyThresholdPassed", "authorizationHash", "requestHash"],
    "Behavioral finalization",
  );
  if (
    typeof value.contentHash !== "string" ||
    !SHA256.test(value.contentHash) ||
    typeof value.sourceSetHash !== "string" ||
    !SHA256.test(value.sourceSetHash) ||
    value.privacyThresholdPassed !== true ||
    typeof value.authorizationHash !== "string" ||
    !SHA256.test(value.authorizationHash) ||
    value.requestHash !== requestHash
  ) {
    fail("Behavioral finalization is detached.");
  }
}

function assertOrphan(
  value: unknown,
  finalization: TrustedBehavioralReleaseFinalization,
): asserts value is TrustedBehavioralReleaseOrphanFinalizationReceipt {
  if (!isRecord(value)) fail("Behavioral orphan proof is malformed.");
  exactKeys(
    value,
    [
      "status",
      "authorizationHash",
      "requestHash",
      "releaseContentHash",
      "sourceSetHash",
      "orphanedAt",
      "orphanFinalizationHash",
    ],
    "Behavioral orphan proof",
  );
  assertTimestamp(value.orphanedAt, "Behavioral orphan time");
  const typed = value as unknown as TrustedBehavioralReleaseOrphanFinalizationReceipt;
  if (
    typed.status !== "orphaned" ||
    typed.authorizationHash !== finalization.authorizationHash ||
    typed.requestHash !== finalization.requestHash ||
    typed.releaseContentHash !== finalization.contentHash ||
    typed.sourceSetHash !== finalization.sourceSetHash ||
    typed.orphanFinalizationHash !==
      hashTrustedBehavioralReleaseOrphanFinalization({
        authorizationHash: typed.authorizationHash,
        requestHash: typed.requestHash,
        releaseContentHash: typed.releaseContentHash,
        sourceSetHash: typed.sourceSetHash,
        orphanedAt: typed.orphanedAt,
      })
  ) {
    fail("Behavioral orphan proof is detached.");
  }
}

function assertBehavioral(
  value: unknown,
  input: {
    readonly requestHash: string;
    readonly protocolHash: string;
    readonly aggregate: TrustedCanonicalAggregate;
  },
): asserts value is TrustedReleaseRecoveryBehavioralState {
  if (!isRecord(value) || typeof value.status !== "string") {
    fail("Recovery behavioral state is malformed.");
  }
  if (value.status === "none") {
    exactKeys(value, ["status"], "Recovery behavioral state");
    if (input.aggregate.behavioralAggregateHash !== null) {
      fail("A no-release checkpoint names a behavioral aggregate.");
    }
    return;
  }
  if (value.status === "prepared") {
    exactKeys(
      value,
      ["status", "preparationHash", "sourceResultEnvelopeHash"],
      "Recovery behavioral state",
    );
    if (
      typeof value.preparationHash !== "string" ||
      !SHA256.test(value.preparationHash) ||
      typeof value.sourceResultEnvelopeHash !== "string" ||
      !SHA256.test(value.sourceResultEnvelopeHash) ||
      input.aggregate.behavioralAggregateHash !== null
    ) {
      fail("Prepared recovery state is detached.");
    }
    return;
  }
  if (value.status === "consumed") {
    exactKeys(value, ["status", "preparationHash"], "Recovery behavioral state");
    if (
      typeof value.preparationHash !== "string" ||
      !SHA256.test(value.preparationHash) ||
      input.aggregate.behavioralAggregateHash !== null
    ) {
      fail("Consumed recovery state is detached.");
    }
    return;
  }
  const finalizationKeys = [
    "status",
    "preparationHash",
    "sourceResultEnvelopeHash",
    "finalizationHash",
    "finalization",
  ];
  if (value.status === "finalized") {
    exactKeys(value, finalizationKeys, "Recovery behavioral state");
  } else if (value.status === "abandoned") {
    exactKeys(
      value,
      [...finalizationKeys, "orphanFinalizationHash", "orphanFinalization", "abandonmentHash"],
      "Recovery behavioral state",
    );
  } else {
    fail("Recovery behavioral status is unknown.");
  }
  if (
    typeof value.preparationHash !== "string" ||
    !SHA256.test(value.preparationHash) ||
    typeof value.sourceResultEnvelopeHash !== "string" ||
    !SHA256.test(value.sourceResultEnvelopeHash)
  ) {
    fail("Finalized recovery state is detached.");
  }
  assertFinalization(value.finalization, input.requestHash);
  const finalization = value.finalization as TrustedBehavioralReleaseFinalization;
  const expectedFinalizationHash = hashTrustedBehavioralPreparationFinalization({
    requestHash: input.requestHash,
    protocolHash: input.protocolHash,
    preparationHash: value.preparationHash,
    sourceResultEnvelopeHash: value.sourceResultEnvelopeHash,
    finalization,
  });
  if (
    value.finalizationHash !== expectedFinalizationHash ||
    input.aggregate.behavioralAggregateHash !== finalization.contentHash
  ) {
    fail("Finalized recovery state hash is detached.");
  }
  if (value.status === "abandoned") {
    assertOrphan(value.orphanFinalization, finalization);
    const orphan = value.orphanFinalization as TrustedBehavioralReleaseOrphanFinalizationReceipt;
    if (
      value.orphanFinalizationHash !== orphan.orphanFinalizationHash ||
      value.abandonmentHash !==
        hashTrustedBehavioralPreparationAbandonment({
          requestHash: input.requestHash,
          protocolHash: input.protocolHash,
          preparationHash: value.preparationHash,
          sourceResultEnvelopeHash: value.sourceResultEnvelopeHash,
          finalizationHash: expectedFinalizationHash,
          orphanFinalizationHash: orphan.orphanFinalizationHash,
        })
    ) {
      fail("Abandoned recovery state is detached.");
    }
  }
}

function recoveryRecordMaterial(
  record: Omit<TrustedPostDestructionReleaseRecoveryRecord, "recordHash">,
): Readonly<Record<string, unknown>> {
  return {
    domain: "dark-factory.post-destruction-release-recovery-record.v1",
    record,
  };
}

export function hashPostDestructionReleaseRecoveryRecord(
  record: Omit<TrustedPostDestructionReleaseRecoveryRecord, "recordHash">,
): string {
  return canonicalHash(recoveryRecordMaterial(record));
}

export function sealPostDestructionReleaseRecoveryRecord(
  record: Omit<TrustedPostDestructionReleaseRecoveryRecord, "recordHash">,
): TrustedPostDestructionReleaseRecoveryRecord {
  const sealed = {
    ...record,
    recordHash: hashPostDestructionReleaseRecoveryRecord(record),
  };
  assertPostDestructionReleaseRecoveryRecord(sealed);
  return sealed;
}

export function hashResultCompletionEnvelope(envelope: SignedResultEnvelope): string {
  return canonicalHash({
    domain: "dark-factory.one-use-result-completion-envelope.v1",
    envelope,
  });
}

export function assertPostDestructionReleaseRecoveryRecord(
  value: unknown,
): asserts value is TrustedPostDestructionReleaseRecoveryRecord {
  if (!isRecord(value)) fail("Release recovery record is malformed.");
  exactKeys(
    value,
    [
      "schemaVersion",
      "sensitivity",
      "requestId",
      "requestHash",
      "protocolHash",
      "dispositionAttestationHash",
      "retentionPolicyHash",
      "rawManifest",
      "destructionReceipt",
      "aggregate",
      "behavioral",
      "status",
      "envelope",
      "envelopeHash",
      "failureCode",
      "revision",
      "recordHash",
    ],
    "Release recovery record",
  );
  if (
    value.schemaVersion !== 1 ||
    value.sensitivity !== "trusted-private-post-destruction-release-recovery" ||
    typeof value.requestId !== "string" ||
    !SAFE_ID.test(value.requestId) ||
    typeof value.requestHash !== "string" ||
    !SHA256.test(value.requestHash) ||
    typeof value.protocolHash !== "string" ||
    !SHA256.test(value.protocolHash) ||
    typeof value.dispositionAttestationHash !== "string" ||
    !SHA256.test(value.dispositionAttestationHash) ||
    typeof value.retentionPolicyHash !== "string" ||
    !SHA256.test(value.retentionPolicyHash) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) <= 0 ||
    typeof value.recordHash !== "string" ||
    !SHA256.test(value.recordHash)
  ) {
    fail("Release recovery identity is malformed.");
  }
  assertRawLineage(value.rawManifest, value.destructionReceipt, value.retentionPolicyHash);
  const manifest = value.rawManifest as TrustedRawArtifactManifest;
  assertAggregate(value.aggregate, {
    requestHash: value.requestHash,
    protocolHash: value.protocolHash,
    rawManifestId: manifest.manifestId,
  });
  const aggregate = value.aggregate as TrustedCanonicalAggregate;
  assertBehavioral(value.behavioral, {
    requestHash: value.requestHash,
    protocolHash: value.protocolHash,
    aggregate,
  });
  if (
    value.status !== "open" &&
    value.status !== "result-issued" &&
    value.status !== "completed" &&
    value.status !== "failed"
  ) {
    fail("Release recovery disposition is malformed.");
  }
  if (value.envelope !== null) {
    assertValidDocument("signedResultEnvelope", value.envelope);
    const envelope = value.envelope as SignedResultEnvelope;
    if (
      value.envelopeHash !== hashResultCompletionEnvelope(envelope) ||
      envelope.oneUseRequest.requestId !== value.requestId ||
      envelope.oneUseRequest.requestHash !== value.requestHash ||
      envelope.oneUseRequest.dispositionAttestationHash !== value.dispositionAttestationHash ||
      envelope.protocolHash !== value.protocolHash ||
      envelope.derivation.normalizedOutcomeSetHash !== aggregate.normalizedOutcomeSetHash ||
      envelope.derivation.cacheAttestationHash !== aggregate.cacheAttestationHash ||
      envelope.derivation.behavioralAggregateHash !== aggregate.behavioralAggregateHash ||
      envelope.derivation.derivedAt !== aggregate.derivedAt ||
      canonicalJson(envelope.payload) !== canonicalJson(aggregate.payload)
    ) {
      fail("Recovery result envelope is detached.");
    }
  } else if (value.envelopeHash !== null) {
    fail("Recovery envelope hash exists without an envelope.");
  }
  if (
    (value.status === "open" && value.envelope !== null) ||
    ((value.status === "result-issued" || value.status === "completed") &&
      value.envelope === null) ||
    (value.status === "completed" && value.behavioral.status === "abandoned") ||
    (value.status === "result-issued" &&
      (value.behavioral.status === "prepared" || value.behavioral.status === "abandoned")) ||
    (value.status === "failed" &&
      (value.behavioral.status === "prepared" || value.behavioral.status === "finalized")) ||
    (value.status === "failed") !== (value.failureCode !== null) ||
    (value.failureCode !== null && !FAILURE_CODES.has(value.failureCode as BrokerFailureCode))
  ) {
    fail("Release recovery disposition fields are inconsistent.");
  }
  const { recordHash: _recordHash, ...unsigned } =
    value as unknown as TrustedPostDestructionReleaseRecoveryRecord;
  if (value.recordHash !== hashPostDestructionReleaseRecoveryRecord(unsigned)) {
    fail("Release recovery record hash is detached.");
  }
}

function immutableProjection(
  record: TrustedPostDestructionReleaseRecoveryRecord,
): Readonly<Record<string, unknown>> {
  const aggregate = {
    ...record.aggregate,
    behavioralAggregateHash: null,
    releaseChecks: {
      ...record.aggregate.releaseChecks,
      privacyThresholdPassed: false,
    },
  };
  return {
    schemaVersion: record.schemaVersion,
    sensitivity: record.sensitivity,
    requestId: record.requestId,
    requestHash: record.requestHash,
    protocolHash: record.protocolHash,
    dispositionAttestationHash: record.dispositionAttestationHash,
    retentionPolicyHash: record.retentionPolicyHash,
    rawManifest: record.rawManifest,
    destructionReceipt: record.destructionReceipt,
    aggregate,
  };
}

function allowedBehavioralTransition(
  prior: TrustedReleaseRecoveryBehavioralState,
  next: TrustedReleaseRecoveryBehavioralState,
): boolean {
  if (canonicalJson(prior) === canonicalJson(next)) return true;
  return (
    (prior.status === "prepared" &&
      (next.status === "consumed" || next.status === "finalized") &&
      prior.preparationHash === next.preparationHash) ||
    (prior.status === "finalized" &&
      next.status === "abandoned" &&
      prior.preparationHash === next.preparationHash &&
      prior.sourceResultEnvelopeHash === next.sourceResultEnvelopeHash &&
      prior.finalizationHash === next.finalizationHash &&
      canonicalJson(prior.finalization) === canonicalJson(next.finalization))
  );
}

/**
 * Validates the append-only state machine. Ambiguous transitions preserve the
 * prior record; terminal records are immutable.
 */
export function assertPostDestructionReleaseRecoveryTransition(
  prior: TrustedPostDestructionReleaseRecoveryRecord,
  next: TrustedPostDestructionReleaseRecoveryRecord,
): void {
  assertPostDestructionReleaseRecoveryRecord(prior);
  assertPostDestructionReleaseRecoveryRecord(next);
  if (prior.status === "completed" || prior.status === "failed") {
    if (canonicalJson(prior) !== canonicalJson(next)) {
      fail("A terminal release recovery record is immutable.");
    }
    return;
  }
  if (
    next.revision !== prior.revision + 1 ||
    canonicalJson(immutableProjection(prior)) !== canonicalJson(immutableProjection(next)) ||
    !allowedBehavioralTransition(prior.behavioral, next.behavioral)
  ) {
    fail("Release recovery transition changed immutable lineage.");
  }
  const allowedStatus =
    (prior.status === "open" &&
      (next.status === "open" || next.status === "result-issued" || next.status === "failed")) ||
    (prior.status === "result-issued" &&
      (next.status === "result-issued" || next.status === "completed" || next.status === "failed"));
  if (!allowedStatus) {
    fail("Release recovery disposition regressed.");
  }
  if (
    prior.envelope !== null &&
    (next.envelope === null ||
      canonicalJson(prior.envelope) !== canonicalJson(next.envelope) ||
      prior.envelopeHash !== next.envelopeHash)
  ) {
    fail("A recorded result envelope was changed or removed.");
  }
}
