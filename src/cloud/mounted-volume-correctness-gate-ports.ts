import type { KeyLike } from "node:crypto";

import type { ExperimentIdentity } from "../domain/models.js";
import { verifyEd25519Signature } from "../evidence/signatures.js";
import type {
  TrustedCandidateBuildReceiptVerifier,
  TrustedCandidateRuntimeBuildReceipt,
} from "../harness/candidate-build-runner.js";
import type {
  TrustedGitPublicationReceipt,
  TrustedGitPublicationReceiptVerifier,
} from "../harness/git-publication.js";
import {
  TRUSTED_GIT_SOURCE_BUNDLE_REF,
  type TrustedGitSourceReceiptVerifier,
  type TrustedGitSourceSnapshotReceipt,
} from "../harness/git-source.js";
import {
  INTEGRITY_VIOLATION_CODES,
  type IntegrityViolationCode,
} from "../integrity/candidate-scanner.js";
import {
  type AccountedCorrectnessGateReceipt,
  type CorrectnessGateOperation,
  type CorrectnessGateOperationAccounting,
  type CorrectnessGateRecord,
  type CorrectnessGateRecordStore,
  type TrustedCandidateBuildRejectionReceipt,
  type TrustedCandidateSourceIndexPort,
  type TrustedCandidateSourceIndexReceipt,
  type TrustedCloudIntegrityScanReceipt,
  type TrustedCloudIntegrityScanReceiptVerifier,
  trustedCloudIntegrityScanAttestationHash,
} from "../orchestrator/correctness-gate.js";
import { canonicalHash, canonicalJson, computeContentHash } from "../schemas/canonical.js";
import {
  type MountedVolumeDurableStateOptions,
  MountedVolumeTransactionalJsonStore,
} from "./mounted-volume-state.js";
import type { TrustedCloudArtifactRef } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_STORE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_HEAD_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u;
const SAFE_IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,446}@sha256:[a-f0-9]{64}$/u;
const SAFE_SIGNATURE = /^[A-Za-z0-9_-]{86,128}$/u;
const SAFE_ARTIFACT_URI = /^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const SAFE_MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u;
const MAXIMUM_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const MAXIMUM_COST_USD = 1_000_000;
const MAXIMUM_TOKENS = 10_000_000_000;
const MAXIMUM_WALL_TIME_MS = 30 * 24 * 60 * 60_000;

export class MountedVolumeCorrectnessGatePortError extends Error {
  override readonly name = "MountedVolumeCorrectnessGatePortError";
}

function fail(message: string): never {
  throw new MountedVolumeCorrectnessGatePortError(message);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    fail(`${label} is not a plain object.`);
  }
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    fail(`${label} contains non-canonical fields.`);
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function cloneJson<Value>(value: Value, label: string): Value {
  try {
    return JSON.parse(canonicalJson(value)) as Value;
  } catch {
    fail(`${label} is not canonical JSON.`);
  }
}

function assertGitObject(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !GIT_OBJECT_ID.test(value)) {
    fail(`${label} is not a Git object identifier.`);
  }
}

function experimentId(experiment: ExperimentIdentity): string {
  assertExactKeys(
    experiment,
    ["number", "slug", "kind", "parentExperiment", "lineageId", "protocolHash"],
    "Correctness-gate experiment identity",
  );
  if (
    !Number.isSafeInteger(experiment.number) ||
    experiment.number < 1 ||
    !SAFE_SLUG.test(experiment.slug) ||
    (experiment.kind !== "optimization" && experiment.kind !== "shadow") ||
    (experiment.parentExperiment !== null &&
      (!Number.isSafeInteger(experiment.parentExperiment) ||
        experiment.parentExperiment < 0 ||
        experiment.parentExperiment >= experiment.number)) ||
    !SAFE_ID.test(experiment.lineageId) ||
    !SHA256.test(experiment.protocolHash)
  ) {
    fail("Correctness-gate experiment identity is malformed.");
  }
  const id = `${String(experiment.number).padStart(3, "0")}-${experiment.slug}`;
  if (!SAFE_ID.test(id)) {
    fail("Correctness-gate experiment identifier is malformed.");
  }
  return id;
}

function assertArtifact(
  value: unknown,
  expectedMediaType?: string,
  maximumByteLength = MAXIMUM_ARTIFACT_BYTES,
): asserts value is TrustedCloudArtifactRef {
  assertExactKeys(
    value,
    ["uri", "sha256", "mediaType", "byteLength"],
    "Trusted artifact reference",
  );
  const artifact = value as unknown as TrustedCloudArtifactRef;
  if (
    !SAFE_ARTIFACT_URI.test(artifact.uri) ||
    artifact.uri.includes("..") ||
    !SHA256.test(artifact.sha256) ||
    !SAFE_MEDIA_TYPE.test(artifact.mediaType) ||
    (expectedMediaType !== undefined && artifact.mediaType !== expectedMediaType) ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength <= 0 ||
    artifact.byteLength > maximumByteLength
  ) {
    fail("Trusted artifact reference is malformed.");
  }
}

function assertSignatureShape(value: unknown, trustedKeyId: string): void {
  assertExactKeys(
    value,
    ["algorithm", "keyId", "signedAt", "signature"],
    "Trusted receipt signature",
  );
  const signature = value as unknown as {
    readonly algorithm: unknown;
    readonly keyId: unknown;
    readonly signedAt: unknown;
    readonly signature: unknown;
  };
  if (
    signature.algorithm !== "ed25519" ||
    signature.keyId !== trustedKeyId ||
    !isCanonicalTimestamp(signature.signedAt) ||
    typeof signature.signature !== "string" ||
    !SAFE_SIGNATURE.test(signature.signature)
  ) {
    fail("Trusted receipt signature metadata is malformed.");
  }
}

function assertSignedDocument(
  value: Readonly<Record<string, unknown>>,
  verifier: {
    readonly trustedKeyId: string;
    readonly publicKey: KeyLike;
  },
  createdAt: string,
): void {
  assertSignatureShape(value["signature"], verifier.trustedKeyId);
  const signature = value["signature"] as Readonly<Record<string, unknown>>;
  if (
    Date.parse(signature["signedAt"] as string) < Date.parse(createdAt) ||
    !verifyEd25519Signature(value, verifier.publicKey)
  ) {
    fail("Trusted receipt signature is invalid.");
  }
}

function assertHeadRef(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !SAFE_HEAD_REF.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value
      .slice("refs/heads/".length)
      .split("/")
      .some(
        (component) =>
          component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock"),
      )
  ) {
    fail(`${label} is malformed.`);
  }
}

function assertProviderSnapshotMetadata(value: Readonly<Record<string, unknown>>): void {
  if (
    (value["provider"] !== "daytona" &&
      value["provider"] !== "e2b" &&
      value["provider"] !== "modal") ||
    typeof value["sandboxId"] !== "string" ||
    !SAFE_ID.test(value["sandboxId"]) ||
    typeof value["imageReference"] !== "string" ||
    !SAFE_IMAGE_REFERENCE.test(value["imageReference"]) ||
    typeof value["imageDigest"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value["imageDigest"]) ||
    !value["imageReference"].endsWith(`@${value["imageDigest"]}`) ||
    typeof value["networkPolicyHash"] !== "string" ||
    !SHA256.test(value["networkPolicyHash"])
  ) {
    fail("Trusted provider receipt metadata is malformed.");
  }
}

function assertSnapshotReceipt(
  value: unknown,
  verifier: TrustedGitSourceReceiptVerifier,
): asserts value is TrustedGitSourceSnapshotReceipt {
  assertExactKeys(
    value,
    [
      "sensitivity",
      "schemaVersion",
      "snapshotId",
      "registrationId",
      "originRepositoryHash",
      "upstreamRepositoryHash",
      "upstreamHeadCommit",
      "upstreamBaseCommit",
      "baselineCommit",
      "provider",
      "sandboxId",
      "imageReference",
      "imageDigest",
      "networkPolicyHash",
      "remoteRef",
      "commitSha",
      "treeSha",
      "lockSha256",
      "archiveMethod",
      "compression",
      "bundleMethod",
      "bundleRef",
      "workerSha256",
      "executionReceiptHash",
      "manifestArtifactSha256",
      "sourceArtifact",
      "sourceBundleArtifact",
      "createdAt",
      "passed",
      "signature",
    ],
    "Stored Git source snapshot",
  );
  const receipt = value as unknown as TrustedGitSourceSnapshotReceipt;
  if (
    receipt.sensitivity !== "trusted-git-source-snapshot" ||
    receipt.schemaVersion !== 2 ||
    !SAFE_ID.test(receipt.snapshotId) ||
    !SHA256.test(receipt.registrationId) ||
    !SHA256.test(receipt.originRepositoryHash) ||
    !SHA256.test(receipt.upstreamRepositoryHash)
  ) {
    fail("Stored Git source snapshot identity is malformed.");
  }
  assertGitObject(receipt.upstreamHeadCommit, "Snapshot upstream HEAD");
  assertGitObject(receipt.upstreamBaseCommit, "Snapshot upstream base");
  assertGitObject(receipt.baselineCommit, "Snapshot baseline");
  assertProviderSnapshotMetadata(receipt as unknown as Readonly<Record<string, unknown>>);
  assertHeadRef(receipt.remoteRef, "Snapshot remote ref");
  assertGitObject(receipt.commitSha, "Snapshot commit");
  assertGitObject(receipt.treeSha, "Snapshot tree");
  if (
    !SHA256.test(receipt.lockSha256) ||
    receipt.archiveMethod !== "git-archive-format-tar" ||
    receipt.compression !== "none" ||
    receipt.bundleMethod !== "git-bundle-v2" ||
    receipt.bundleRef !== TRUSTED_GIT_SOURCE_BUNDLE_REF ||
    !SHA256.test(receipt.workerSha256) ||
    !SHA256.test(receipt.executionReceiptHash) ||
    !SHA256.test(receipt.manifestArtifactSha256) ||
    !isCanonicalTimestamp(receipt.createdAt) ||
    receipt.passed !== true
  ) {
    fail("Stored Git source snapshot payload is malformed.");
  }
  assertArtifact(receipt.sourceArtifact, "application/x-tar", 512 * 1024 * 1024);
  assertArtifact(
    receipt.sourceBundleArtifact,
    "application/vnd.git.bundle",
    2 * 1024 * 1024 * 1024,
  );
  assertSignedDocument(
    receipt as unknown as Readonly<Record<string, unknown>>,
    verifier,
    receipt.createdAt,
  );
}

function assertPublicationReceipt(
  value: unknown,
  verifier: TrustedGitPublicationReceiptVerifier,
): asserts value is TrustedGitPublicationReceipt {
  assertExactKeys(
    value,
    [
      "sensitivity",
      "schemaVersion",
      "publicationId",
      "authorizationHash",
      "registrationId",
      "originRepositoryHash",
      "upstreamRepositoryHash",
      "upstreamHeadCommit",
      "upstreamBaseCommit",
      "provider",
      "sandboxId",
      "imageReference",
      "imageDigest",
      "networkPolicyHash",
      "experimentId",
      "baselineCommit",
      "baseRef",
      "baseCommit",
      "candidateCommit",
      "candidateTree",
      "lockSha256",
      "bundleRef",
      "branchRef",
      "tagRef",
      "branchCommit",
      "tagObjectId",
      "tagPeeledCommit",
      "publicationMode",
      "disposition",
      "candidateBundleSha256",
      "workerSha256",
      "executionReceiptHash",
      "resultArtifactSha256",
      "publishedAt",
      "passed",
      "signature",
    ],
    "Stored Git publication receipt",
  );
  const receipt = value as unknown as TrustedGitPublicationReceipt;
  if (
    receipt.sensitivity !== "trusted-git-publication" ||
    receipt.schemaVersion !== 1 ||
    !SAFE_ID.test(receipt.publicationId) ||
    !SHA256.test(receipt.authorizationHash) ||
    !SHA256.test(receipt.registrationId) ||
    !SHA256.test(receipt.originRepositoryHash) ||
    !SHA256.test(receipt.upstreamRepositoryHash)
  ) {
    fail("Stored Git publication identity is malformed.");
  }
  assertGitObject(receipt.upstreamHeadCommit, "Publication upstream HEAD");
  assertGitObject(receipt.upstreamBaseCommit, "Publication upstream base");
  assertProviderSnapshotMetadata(receipt as unknown as Readonly<Record<string, unknown>>);
  if (!SAFE_ID.test(receipt.experimentId)) {
    fail("Stored Git publication experiment is malformed.");
  }
  assertGitObject(receipt.baselineCommit, "Publication baseline");
  assertHeadRef(receipt.baseRef, "Publication base ref");
  assertGitObject(receipt.baseCommit, "Publication base commit");
  assertGitObject(receipt.candidateCommit, "Publication candidate commit");
  assertGitObject(receipt.candidateTree, "Publication candidate tree");
  assertHeadRef(receipt.bundleRef, "Publication bundle ref");
  assertHeadRef(receipt.branchRef, "Publication branch ref");
  assertGitObject(receipt.branchCommit, "Publication branch commit");
  assertGitObject(receipt.tagObjectId, "Publication tag object");
  assertGitObject(receipt.tagPeeledCommit, "Publication peeled tag");
  if (
    receipt.tagRef !== `refs/tags/df/experiment/${receipt.experimentId}/candidate` ||
    receipt.branchRef !== `refs/heads/df/experiment/${receipt.experimentId}` ||
    receipt.bundleRef !== `refs/heads/df/bundle/${receipt.experimentId}` ||
    receipt.branchCommit !== receipt.candidateCommit ||
    receipt.tagPeeledCommit !== receipt.candidateCommit ||
    !SHA256.test(receipt.lockSha256) ||
    receipt.publicationMode !== "atomic-non-force" ||
    (receipt.disposition !== "published" && receipt.disposition !== "already-published") ||
    !SHA256.test(receipt.candidateBundleSha256) ||
    !SHA256.test(receipt.workerSha256) ||
    !SHA256.test(receipt.executionReceiptHash) ||
    !SHA256.test(receipt.resultArtifactSha256) ||
    !isCanonicalTimestamp(receipt.publishedAt) ||
    receipt.passed !== true
  ) {
    fail("Stored Git publication payload is malformed.");
  }
  assertSignedDocument(
    receipt as unknown as Readonly<Record<string, unknown>>,
    verifier,
    receipt.publishedAt,
  );
}

function assertRuntimeBuildReceipt(
  value: unknown,
  verifier: TrustedCandidateBuildReceiptVerifier,
): asserts value is TrustedCandidateRuntimeBuildReceipt {
  assertExactKeys(
    value,
    [
      "sensitivity",
      "schemaVersion",
      "buildId",
      "experimentId",
      "sandboxId",
      "candidateCommit",
      "candidateTree",
      "lockSha256",
      "buildPolicyHash",
      "architecture",
      "validationLevel",
      "sourceSha256",
      "extractorSha256",
      "packagerSha256",
      "toolchainAttestationHash",
      "commandReceiptHashes",
      "runtimeManifestSha256",
      "runtimeArtifact",
      "builtAt",
      "passed",
      "signature",
    ],
    "Stored candidate build receipt",
  );
  const receipt = value as unknown as TrustedCandidateRuntimeBuildReceipt;
  if (
    receipt.sensitivity !== "trusted-candidate-runtime-build" ||
    receipt.schemaVersion !== 1 ||
    !SAFE_ID.test(receipt.buildId) ||
    !SAFE_ID.test(receipt.experimentId) ||
    !SAFE_ID.test(receipt.sandboxId)
  ) {
    fail("Stored candidate build identity is malformed.");
  }
  assertGitObject(receipt.candidateCommit, "Build candidate commit");
  assertGitObject(receipt.candidateTree, "Build candidate tree");
  if (
    !SHA256.test(receipt.lockSha256) ||
    !SHA256.test(receipt.buildPolicyHash) ||
    receipt.architecture !== "x86_64" ||
    receipt.validationLevel !== "release" ||
    !SHA256.test(receipt.sourceSha256) ||
    !SHA256.test(receipt.extractorSha256) ||
    !SHA256.test(receipt.packagerSha256) ||
    !SHA256.test(receipt.toolchainAttestationHash) ||
    !Array.isArray(receipt.commandReceiptHashes) ||
    receipt.commandReceiptHashes.length < 1 ||
    receipt.commandReceiptHashes.length > 256 ||
    new Set(receipt.commandReceiptHashes).size !== receipt.commandReceiptHashes.length ||
    receipt.commandReceiptHashes.some((hash) => typeof hash !== "string" || !SHA256.test(hash)) ||
    !SHA256.test(receipt.runtimeManifestSha256) ||
    !isCanonicalTimestamp(receipt.builtAt) ||
    receipt.passed !== true
  ) {
    fail("Stored candidate build payload is malformed.");
  }
  assertArtifact(receipt.runtimeArtifact, "application/x-tar");
  assertSignedDocument(
    receipt as unknown as Readonly<Record<string, unknown>>,
    verifier,
    receipt.builtAt,
  );
}

function assertAccounting<Receipt>(
  value: unknown,
  operation: CorrectnessGateOperation,
  receipt: Receipt,
): asserts value is CorrectnessGateOperationAccounting {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "sensitivity",
      "operation",
      "receiptHash",
      "aggregateCostUsd",
      "tokens",
      "wallTimeMs",
      "containsTaskIdentifiers",
      "accountingAttestationHash",
    ],
    "Correctness-gate operation accounting",
  );
  const accounting = value as unknown as CorrectnessGateOperationAccounting;
  if (
    accounting.schemaVersion !== 1 ||
    accounting.sensitivity !== "release-safe-correctness-gate-accounting" ||
    accounting.operation !== operation ||
    accounting.receiptHash !== canonicalHash(receipt) ||
    !Number.isFinite(accounting.aggregateCostUsd) ||
    accounting.aggregateCostUsd < 0 ||
    accounting.aggregateCostUsd > MAXIMUM_COST_USD ||
    !Number.isSafeInteger(accounting.tokens) ||
    accounting.tokens < 0 ||
    accounting.tokens > MAXIMUM_TOKENS ||
    !Number.isSafeInteger(accounting.wallTimeMs) ||
    accounting.wallTimeMs < 0 ||
    accounting.wallTimeMs > MAXIMUM_WALL_TIME_MS ||
    accounting.containsTaskIdentifiers !== false ||
    !SHA256.test(accounting.accountingAttestationHash)
  ) {
    fail("Correctness-gate operation accounting is malformed.");
  }
}

function assertAccounted<Receipt>(
  value: unknown,
  operation: CorrectnessGateOperation,
  assertReceipt: (receipt: unknown) => asserts receipt is Receipt,
): asserts value is AccountedCorrectnessGateReceipt<Receipt> {
  assertExactKeys(value, ["receipt", "accounting"], "Accounted correctness-gate receipt");
  const accounted = value as unknown as {
    readonly receipt: unknown;
    readonly accounting: unknown;
  };
  assertReceipt(accounted.receipt);
  assertAccounting(accounted.accounting, operation, accounted.receipt);
}

function expectedScanId(receipt: TrustedCloudIntegrityScanReceipt): string {
  return `scan-${canonicalHash({
    experimentId: receipt.experimentId,
    protocolHash: receipt.protocolHash,
    sourceCommit: receipt.sourceCommit,
    sourceTree: receipt.sourceTree,
    candidateCommit: receipt.candidateCommit,
    candidateTree: receipt.candidateTree,
    lockSha256: receipt.lockSha256,
    hypothesisDocumentHash: receipt.hypothesisDocumentHash,
    candidateDocumentHash: receipt.candidateDocumentHash,
    diffSha256: receipt.diffSha256,
    changedFilesHash: receipt.changedFilesHash,
    candidateBundleSha256: receipt.candidateBundleSha256,
    integrityWorkerSha256: receipt.workerSha256,
    fragmentCatalogHash: receipt.fragmentCatalogHash,
    integrityPolicyHash: receipt.integrityPolicyHash,
  }).slice(0, 48)}`;
}

function assertScanReceipt(
  value: unknown,
  experiment: ExperimentIdentity,
  verifier: TrustedCloudIntegrityScanReceiptVerifier,
): asserts value is TrustedCloudIntegrityScanReceipt {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "sensitivity",
      "scanId",
      "experimentId",
      "protocolHash",
      "sourceCommit",
      "sourceTree",
      "candidateCommit",
      "candidateTree",
      "lockSha256",
      "hypothesisHash",
      "hypothesisDocumentHash",
      "candidateDocumentHash",
      "diffSha256",
      "changedFilesHash",
      "candidateBundleSha256",
      "evidenceManifestSha256",
      "evidenceDiffSha256",
      "observedChangedFilesHash",
      "lineCountsHash",
      "fileModesHash",
      "fragmentCatalogHash",
      "workerSha256",
      "executionReceiptHash",
      "integrityPolicyHash",
      "passed",
      "violationCodes",
      "containsTaskIdentifiers",
      "scannedAt",
      "scanAttestationHash",
      "signature",
    ],
    "Stored integrity scan receipt",
  );
  const receipt = value as unknown as TrustedCloudIntegrityScanReceipt;
  const allowedViolations = new Set<IntegrityViolationCode>(INTEGRITY_VIOLATION_CODES);
  if (
    receipt.schemaVersion !== 2 ||
    receipt.sensitivity !== "release-safe-candidate-integrity-scan" ||
    receipt.scanId !== expectedScanId(receipt) ||
    receipt.experimentId !== experimentId(experiment) ||
    receipt.protocolHash !== experiment.protocolHash
  ) {
    fail("Stored integrity scan identity is malformed.");
  }
  assertGitObject(receipt.sourceCommit, "Scan source commit");
  assertGitObject(receipt.sourceTree, "Scan source tree");
  assertGitObject(receipt.candidateCommit, "Scan candidate commit");
  assertGitObject(receipt.candidateTree, "Scan candidate tree");
  if (
    !SHA256.test(receipt.lockSha256) ||
    !SHA256.test(receipt.hypothesisHash) ||
    !SHA256.test(receipt.hypothesisDocumentHash) ||
    !SHA256.test(receipt.candidateDocumentHash) ||
    !SHA256.test(receipt.diffSha256) ||
    !SHA256.test(receipt.changedFilesHash) ||
    !SHA256.test(receipt.candidateBundleSha256) ||
    !SHA256.test(receipt.evidenceManifestSha256) ||
    !SHA256.test(receipt.evidenceDiffSha256) ||
    !SHA256.test(receipt.observedChangedFilesHash) ||
    !SHA256.test(receipt.lineCountsHash) ||
    !SHA256.test(receipt.fileModesHash) ||
    !SHA256.test(receipt.fragmentCatalogHash) ||
    !SHA256.test(receipt.workerSha256) ||
    !SHA256.test(receipt.executionReceiptHash) ||
    !SHA256.test(receipt.integrityPolicyHash) ||
    typeof receipt.passed !== "boolean" ||
    !Array.isArray(receipt.violationCodes) ||
    new Set(receipt.violationCodes).size !== receipt.violationCodes.length ||
    receipt.violationCodes.some((code) => !allowedViolations.has(code)) ||
    receipt.violationCodes.some((code, index) => {
      const previous = receipt.violationCodes[index - 1];
      return previous !== undefined && previous.localeCompare(code) >= 0;
    }) ||
    receipt.passed !== (receipt.violationCodes.length === 0) ||
    (receipt.passed &&
      (receipt.evidenceDiffSha256 !== receipt.diffSha256 ||
        receipt.observedChangedFilesHash !== receipt.changedFilesHash)) ||
    receipt.containsTaskIdentifiers !== false ||
    !isCanonicalTimestamp(receipt.scannedAt) ||
    receipt.scanAttestationHash !== trustedCloudIntegrityScanAttestationHash(receipt)
  ) {
    fail("Stored integrity scan payload is malformed.");
  }
  assertSignedDocument(
    receipt as unknown as Readonly<Record<string, unknown>>,
    verifier,
    receipt.scannedAt,
  );
}

function assertBuildRejection(
  value: unknown,
  experiment: ExperimentIdentity,
  scan: TrustedCloudIntegrityScanReceipt,
): asserts value is TrustedCandidateBuildRejectionReceipt {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "sensitivity",
      "rejectionId",
      "experimentId",
      "protocolHash",
      "candidateCommit",
      "candidateTree",
      "lockSha256",
      "buildPolicyHash",
      "failureCode",
      "containsTaskIdentifiers",
      "rejectedAt",
      "buildAttestationHash",
    ],
    "Stored candidate build rejection",
  );
  const receipt = value as unknown as TrustedCandidateBuildRejectionReceipt;
  const expectedId = `build-rejection-${canonicalHash({
    experimentId: experimentId(experiment),
    protocolHash: experiment.protocolHash,
    candidateCommit: scan.candidateCommit,
    candidateTree: scan.candidateTree,
    lockSha256: scan.lockSha256,
    buildPolicyHash: receipt.buildPolicyHash,
  }).slice(0, 48)}`;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.sensitivity !== "release-safe-candidate-build-rejection" ||
    receipt.rejectionId !== expectedId ||
    receipt.experimentId !== experimentId(experiment) ||
    receipt.protocolHash !== experiment.protocolHash ||
    receipt.candidateCommit !== scan.candidateCommit ||
    receipt.candidateTree !== scan.candidateTree ||
    receipt.lockSha256 !== scan.lockSha256 ||
    !SHA256.test(receipt.buildPolicyHash) ||
    receipt.failureCode !== "CLOUD_BUILD_GATE_REJECTED" ||
    receipt.containsTaskIdentifiers !== false ||
    !isCanonicalTimestamp(receipt.rejectedAt) ||
    Date.parse(receipt.rejectedAt) < Date.parse(scan.scannedAt) ||
    !SHA256.test(receipt.buildAttestationHash)
  ) {
    fail("Stored candidate build rejection is malformed.");
  }
}

function assertBuildReceipt(
  value: unknown,
  experiment: ExperimentIdentity,
  scan: TrustedCloudIntegrityScanReceipt,
  verifier: TrustedCandidateBuildReceiptVerifier,
): asserts value is TrustedCandidateRuntimeBuildReceipt | TrustedCandidateBuildRejectionReceipt {
  if (isPlainRecord(value) && value["sensitivity"] === "release-safe-candidate-build-rejection") {
    assertBuildRejection(value, experiment, scan);
    return;
  }
  assertRuntimeBuildReceipt(value, verifier);
  if (
    value.experimentId !== experimentId(experiment) ||
    value.candidateCommit !== scan.candidateCommit ||
    value.candidateTree !== scan.candidateTree ||
    value.lockSha256 !== scan.lockSha256 ||
    Date.parse(value.builtAt) < Date.parse(scan.scannedAt)
  ) {
    fail("Stored candidate build is detached from its scan.");
  }
}

function isBuildRejection(
  receipt: TrustedCandidateRuntimeBuildReceipt | TrustedCandidateBuildRejectionReceipt,
): receipt is TrustedCandidateBuildRejectionReceipt {
  return receipt.sensitivity === "release-safe-candidate-build-rejection";
}

function assertSnapshotMatchesPublication(
  snapshot: TrustedGitSourceSnapshotReceipt,
  publication: TrustedGitPublicationReceipt,
  scan: TrustedCloudIntegrityScanReceipt,
): void {
  if (
    snapshot.registrationId !== publication.registrationId ||
    snapshot.originRepositoryHash !== publication.originRepositoryHash ||
    snapshot.upstreamRepositoryHash !== publication.upstreamRepositoryHash ||
    snapshot.upstreamHeadCommit !== publication.upstreamHeadCommit ||
    snapshot.upstreamBaseCommit !== publication.upstreamBaseCommit ||
    snapshot.baselineCommit !== publication.baselineCommit ||
    snapshot.remoteRef !== publication.branchRef ||
    snapshot.commitSha !== publication.candidateCommit ||
    snapshot.treeSha !== publication.candidateTree ||
    snapshot.lockSha256 !== publication.lockSha256 ||
    snapshot.commitSha !== scan.candidateCommit ||
    snapshot.treeSha !== scan.candidateTree ||
    snapshot.lockSha256 !== scan.lockSha256 ||
    Date.parse(snapshot.createdAt) < Date.parse(publication.publishedAt)
  ) {
    fail("Stored source snapshot is detached from its publication.");
  }
}

function expectedSourceIndexId(input: {
  readonly experiment: ExperimentIdentity;
  readonly snapshot: TrustedGitSourceSnapshotReceipt;
  readonly snapshotReceiptHash: string;
}): string {
  return `source-index-${canonicalHash({
    experimentId: experimentId(input.experiment),
    protocolHash: input.experiment.protocolHash,
    candidateCommit: input.snapshot.commitSha,
    candidateTree: input.snapshot.treeSha,
    lockSha256: input.snapshot.lockSha256,
    sourceArtifactSha256: input.snapshot.sourceArtifact.sha256,
    sourceBundleArtifactSha256: input.snapshot.sourceBundleArtifact.sha256,
    snapshotReceiptHash: input.snapshotReceiptHash,
  }).slice(0, 48)}`;
}

function assertSourceIndexReceipt(
  value: unknown,
  input: {
    readonly experiment: ExperimentIdentity;
    readonly snapshot: TrustedGitSourceSnapshotReceipt;
    readonly snapshotReceiptHash: string;
  },
): asserts value is TrustedCandidateSourceIndexReceipt {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "sensitivity",
      "indexId",
      "experimentId",
      "protocolHash",
      "registrationId",
      "originRepositoryHash",
      "candidateCommit",
      "candidateTree",
      "lockSha256",
      "sourceArtifactSha256",
      "sourceBundleArtifactSha256",
      "snapshotReceiptHash",
      "indexedAt",
      "containsTaskIdentifiers",
      "indexAttestationHash",
    ],
    "Stored candidate source index receipt",
  );
  const receipt = value as unknown as TrustedCandidateSourceIndexReceipt;
  if (
    receipt.schemaVersion !== 2 ||
    receipt.sensitivity !== "release-safe-candidate-source-index" ||
    receipt.indexId !== expectedSourceIndexId(input) ||
    receipt.experimentId !== experimentId(input.experiment) ||
    receipt.protocolHash !== input.experiment.protocolHash ||
    receipt.registrationId !== input.snapshot.registrationId ||
    receipt.originRepositoryHash !== input.snapshot.originRepositoryHash ||
    receipt.candidateCommit !== input.snapshot.commitSha ||
    receipt.candidateTree !== input.snapshot.treeSha ||
    receipt.lockSha256 !== input.snapshot.lockSha256 ||
    receipt.sourceArtifactSha256 !== input.snapshot.sourceArtifact.sha256 ||
    receipt.sourceBundleArtifactSha256 !== input.snapshot.sourceBundleArtifact.sha256 ||
    receipt.snapshotReceiptHash !== input.snapshotReceiptHash ||
    input.snapshotReceiptHash !== canonicalHash(input.snapshot) ||
    !isCanonicalTimestamp(receipt.indexedAt) ||
    Date.parse(receipt.indexedAt) < Date.parse(input.snapshot.createdAt) ||
    receipt.containsTaskIdentifiers !== false ||
    !SHA256.test(receipt.indexAttestationHash)
  ) {
    fail("Stored candidate source index receipt is malformed.");
  }
}

interface CorrectnessGateReceiptVerifiers {
  readonly integrityScan: TrustedCloudIntegrityScanReceiptVerifier;
  readonly candidateBuild: TrustedCandidateBuildReceiptVerifier;
  readonly gitPublication: TrustedGitPublicationReceiptVerifier;
  readonly gitSource: TrustedGitSourceReceiptVerifier;
}

function captureVerifier(verifier: {
  readonly trustedKeyId: string;
  readonly publicKey: KeyLike;
}): {
  readonly trustedKeyId: string;
  readonly publicKey: KeyLike;
} {
  if (!SAFE_ID.test(verifier.trustedKeyId)) {
    fail("Correctness-gate trusted verifier key ID is malformed.");
  }
  return Object.freeze({
    trustedKeyId: verifier.trustedKeyId,
    publicKey: verifier.publicKey,
  });
}

function assertGateResultShape(value: unknown): void {
  assertExactKeys(
    value,
    [
      "passed",
      "integrityPassed",
      "protocolHash",
      "checksHash",
      "aggregateCostUsd",
      "tokens",
      "wallTimeMs",
      "failureCode",
    ],
    "Stored correctness-gate result",
  );
}

function assertCorrectnessGateRecord(
  value: unknown,
  verifiers: CorrectnessGateReceiptVerifiers,
): asserts value is CorrectnessGateRecord {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "domain",
      "experiment",
      "requestHash",
      "proposalResultHash",
      "integrityScan",
      "candidateBuild",
      "gitPublication",
      "sourceSnapshot",
      "sourceIndex",
      "result",
      "contentHash",
    ],
    "Durable correctness-gate record",
  );
  const record = value as unknown as CorrectnessGateRecord;
  experimentId(record.experiment);
  if (
    record.schemaVersion !== 1 ||
    record.domain !== "dark-factory.production-correctness-gate.v1" ||
    !SHA256.test(record.requestHash) ||
    !SHA256.test(record.proposalResultHash) ||
    !SHA256.test(record.contentHash) ||
    record.contentHash !== computeContentHash(record)
  ) {
    fail("Durable correctness-gate record metadata is malformed.");
  }
  assertAccounted(
    record.integrityScan,
    "integrity-scan",
    (receipt): asserts receipt is TrustedCloudIntegrityScanReceipt =>
      assertScanReceipt(receipt, record.experiment, verifiers.integrityScan),
  );
  const scan = record.integrityScan.receipt;
  const operationAccounting: CorrectnessGateOperationAccounting[] = [
    record.integrityScan.accounting,
  ];
  let expectedPassed = false;
  let expectedFailureCode: string | null = scan.passed ? null : "INTEGRITY_POLICY_REJECTED";

  if (!scan.passed) {
    if (
      record.candidateBuild !== null ||
      record.gitPublication !== null ||
      record.sourceSnapshot !== null ||
      record.sourceIndex !== null
    ) {
      fail("Rejected integrity record contains downstream receipts.");
    }
  } else {
    if (record.candidateBuild === null) {
      fail("Passing integrity record is missing its build receipt.");
    }
    assertAccounted(
      record.candidateBuild,
      "candidate-build",
      (
        receipt,
      ): asserts receipt is
        | TrustedCandidateRuntimeBuildReceipt
        | TrustedCandidateBuildRejectionReceipt =>
        assertBuildReceipt(receipt, record.experiment, scan, verifiers.candidateBuild),
    );
    operationAccounting.push(record.candidateBuild.accounting);
    const build = record.candidateBuild.receipt;
    if (isBuildRejection(build)) {
      expectedFailureCode = "CANDIDATE_BUILD_FAILED";
      if (
        record.gitPublication !== null ||
        record.sourceSnapshot !== null ||
        record.sourceIndex !== null
      ) {
        fail("Rejected build record contains publication receipts.");
      }
    } else {
      if (
        record.gitPublication === null ||
        record.sourceSnapshot === null ||
        record.sourceIndex === null
      ) {
        fail("Passing build record is missing publication lineage.");
      }
      assertAccounted(
        record.gitPublication,
        "git-publication",
        (receipt): asserts receipt is TrustedGitPublicationReceipt =>
          assertPublicationReceipt(receipt, verifiers.gitPublication),
      );
      const publication = record.gitPublication.receipt;
      if (
        publication.experimentId !== experimentId(record.experiment) ||
        publication.baseCommit !== scan.sourceCommit ||
        publication.candidateCommit !== scan.candidateCommit ||
        publication.candidateTree !== scan.candidateTree ||
        publication.lockSha256 !== scan.lockSha256 ||
        publication.candidateBundleSha256 !== build.sourceSha256 ||
        Date.parse(publication.publishedAt) < Date.parse(build.builtAt)
      ) {
        fail("Stored Git publication is detached from its candidate build.");
      }
      operationAccounting.push(record.gitPublication.accounting);
      assertAccounted(
        record.sourceSnapshot,
        "source-snapshot",
        (receipt): asserts receipt is TrustedGitSourceSnapshotReceipt =>
          assertSnapshotReceipt(receipt, verifiers.gitSource),
      );
      const snapshot = record.sourceSnapshot.receipt;
      assertSnapshotMatchesPublication(snapshot, publication, scan);
      operationAccounting.push(record.sourceSnapshot.accounting);
      assertAccounted(
        record.sourceIndex,
        "source-index",
        (receipt): asserts receipt is TrustedCandidateSourceIndexReceipt =>
          assertSourceIndexReceipt(receipt, {
            experiment: record.experiment,
            snapshot,
            snapshotReceiptHash: canonicalHash(snapshot),
          }),
      );
      operationAccounting.push(record.sourceIndex.accounting);
      expectedPassed = true;
    }
  }

  assertGateResultShape(record.result);
  const accountingAttestations = new Set(
    operationAccounting.map((accounting) => accounting.accountingAttestationHash),
  );
  const receiptHashes = new Set(operationAccounting.map((accounting) => accounting.receiptHash));
  if (
    accountingAttestations.size !== operationAccounting.length ||
    receiptHashes.size !== operationAccounting.length
  ) {
    fail("Correctness-gate operation commitments are not unique.");
  }
  const totals = operationAccounting.reduce(
    (sum, accounting) => ({
      aggregateCostUsd: sum.aggregateCostUsd + accounting.aggregateCostUsd,
      tokens: sum.tokens + accounting.tokens,
      wallTimeMs: sum.wallTimeMs + accounting.wallTimeMs,
    }),
    { aggregateCostUsd: 0, tokens: 0, wallTimeMs: 0 },
  );
  if (
    record.result.passed !== expectedPassed ||
    record.result.integrityPassed !== scan.passed ||
    record.result.protocolHash !== record.experiment.protocolHash ||
    !SHA256.test(record.result.checksHash) ||
    record.result.aggregateCostUsd !== totals.aggregateCostUsd ||
    record.result.tokens !== totals.tokens ||
    record.result.wallTimeMs !== totals.wallTimeMs ||
    record.result.failureCode !== expectedFailureCode
  ) {
    fail("Stored correctness-gate result is detached from its receipts.");
  }
}

interface DurableCorrectnessGateRecordEntry {
  readonly experimentKey: string;
  readonly recordHash: string;
  readonly record: CorrectnessGateRecord;
}

interface DurableCorrectnessGateRecordState {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-correctness-gate-records";
  readonly storeScopeHash: string;
  readonly revision: number;
  readonly records: Readonly<Record<string, DurableCorrectnessGateRecordEntry>>;
}

function storeScopeHash(storeId: string, domain: string): string {
  if (!SAFE_STORE_ID.test(storeId)) {
    fail("Correctness-gate mounted-volume store ID is malformed.");
  }
  return canonicalHash({
    schemaVersion: 1,
    domain,
    storeId,
  });
}

function experimentKey(experiment: ExperimentIdentity): string {
  experimentId(experiment);
  return canonicalHash({
    domain: "dark-factory.correctness-gate-experiment-key.v1",
    experiment,
  });
}

function assertCorrectnessGateRecordState(
  value: unknown,
  input: {
    readonly scopeHash: string;
    readonly verifiers: CorrectnessGateReceiptVerifiers;
  },
): asserts value is DurableCorrectnessGateRecordState {
  assertExactKeys(
    value,
    ["schemaVersion", "sensitivity", "storeScopeHash", "revision", "records"],
    "Durable correctness-gate record state",
  );
  const state = value as unknown as DurableCorrectnessGateRecordState;
  if (
    state.schemaVersion !== 1 ||
    state.sensitivity !== "trusted-correctness-gate-records" ||
    state.storeScopeHash !== input.scopeHash ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !isPlainRecord(state.records) ||
    state.revision !== Object.keys(state.records).length
  ) {
    fail("Durable correctness-gate record state is malformed.");
  }

  const requestHashes = new Set<string>();
  const proposalHashes = new Set<string>();
  const passingCommits = new Set<string>();
  for (const [key, rawEntry] of Object.entries(state.records)) {
    assertExactKeys(
      rawEntry,
      ["experimentKey", "recordHash", "record"],
      "Durable correctness-gate record entry",
    );
    const entry = rawEntry as unknown as DurableCorrectnessGateRecordEntry;
    assertCorrectnessGateRecord(entry.record, input.verifiers);
    if (
      !SHA256.test(key) ||
      entry.experimentKey !== key ||
      key !== experimentKey(entry.record.experiment) ||
      entry.recordHash !== entry.record.contentHash ||
      requestHashes.has(entry.record.requestHash) ||
      proposalHashes.has(entry.record.proposalResultHash)
    ) {
      fail("Durable correctness-gate record entry is inconsistent.");
    }
    requestHashes.add(entry.record.requestHash);
    proposalHashes.add(entry.record.proposalResultHash);
    const indexedCommit = entry.record.sourceSnapshot?.receipt.commitSha ?? null;
    if (indexedCommit !== null) {
      if (passingCommits.has(indexedCommit)) {
        fail("Candidate commit belongs to more than one correctness record.");
      }
      passingCommits.add(indexedCommit);
    }
  }
}

export interface MountedVolumeCorrectnessGateRecordStoreOptions {
  readonly durableState: MountedVolumeDurableStateOptions;
  readonly integrityScanVerifier: TrustedCloudIntegrityScanReceiptVerifier;
  readonly candidateBuildVerifier: TrustedCandidateBuildReceiptVerifier;
  readonly gitPublicationVerifier: TrustedGitPublicationReceiptVerifier;
  readonly gitSourceVerifier: TrustedGitSourceReceiptVerifier;
}

/**
 * Immutable, experiment-keyed production record store. The complete state,
 * every embedded receipt, every signature, and all available hash lineage are
 * revalidated whenever the mounted-volume envelope is opened.
 */
export class MountedVolumeCorrectnessGateRecordStore implements CorrectnessGateRecordStore {
  readonly boundary = "trusted-cloud-durable" as const;
  readonly #store: MountedVolumeTransactionalJsonStore<DurableCorrectnessGateRecordState>;
  readonly #verifiers: CorrectnessGateReceiptVerifiers;

  public constructor(options: MountedVolumeCorrectnessGateRecordStoreOptions) {
    const scopeHash = storeScopeHash(
      options.durableState.storeId,
      "dark-factory.correctness-gate-record-store-scope.v1",
    );
    const verifiers: CorrectnessGateReceiptVerifiers = {
      integrityScan: captureVerifier(options.integrityScanVerifier),
      candidateBuild: captureVerifier(options.candidateBuildVerifier),
      gitPublication: captureVerifier(options.gitPublicationVerifier),
      gitSource: captureVerifier(options.gitSourceVerifier),
    };
    this.#verifiers = Object.freeze(verifiers);
    this.#store = new MountedVolumeTransactionalJsonStore<DurableCorrectnessGateRecordState>(
      options.durableState,
      `correctness-gate-records-${options.durableState.storeId}`,
      {
        domain: "dark-factory.correctness-gate-record-state.v1",
        initialState: () => ({
          schemaVersion: 1,
          sensitivity: "trusted-correctness-gate-records",
          storeScopeHash: scopeHash,
          revision: 0,
          records: {},
        }),
        assertState(value): asserts value is DurableCorrectnessGateRecordState {
          assertCorrectnessGateRecordState(value, {
            scopeHash,
            verifiers,
          });
        },
        revision: (state) => state.revision,
      },
    );
  }

  public async put(record: CorrectnessGateRecord): Promise<void> {
    const frozen = cloneJson(record, "Correctness-gate record");
    assertCorrectnessGateRecord(frozen, this.#verifiers);
    const key = experimentKey(frozen.experiment);
    return this.#store.transact((state) => {
      const existing = state.records[key];
      if (existing !== undefined) {
        if (canonicalJson(existing.record) !== canonicalJson(frozen)) {
          fail("Correctness-gate experiment identity already binds different content.");
        }
        return { next: state, result: undefined };
      }
      if (
        Object.values(state.records).some(
          (entry) =>
            entry.record.requestHash === frozen.requestHash ||
            entry.record.proposalResultHash === frozen.proposalResultHash ||
            (frozen.sourceSnapshot !== null &&
              entry.record.sourceSnapshot?.receipt.commitSha ===
                frozen.sourceSnapshot.receipt.commitSha),
        )
      ) {
        fail("Correctness-gate commitment already belongs to another experiment.");
      }
      const entry: DurableCorrectnessGateRecordEntry = {
        experimentKey: key,
        recordHash: frozen.contentHash,
        record: frozen,
      };
      return {
        next: {
          ...state,
          revision: state.revision + 1,
          records: {
            ...state.records,
            [key]: entry,
          },
        },
        result: undefined,
      };
    });
  }

  public get(experiment: ExperimentIdentity): Promise<CorrectnessGateRecord | null> {
    const frozen = cloneJson(experiment, "Correctness-gate experiment lookup");
    const key = experimentKey(frozen);
    return this.#store.transact((state) => {
      const entry = state.records[key];
      if (entry === undefined) {
        return { next: state, result: null };
      }
      if (canonicalJson(entry.record.experiment) !== canonicalJson(frozen)) {
        fail("Correctness-gate experiment key collision detected.");
      }
      return {
        next: state,
        result: cloneJson(entry.record, "Stored correctness-gate record"),
      };
    });
  }

  public close(): Promise<void> {
    return this.#store.close();
  }
}

export interface TrustedCandidateSourceIndexAttestationRequest {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-candidate-source-index-attestation-request";
  readonly storeScopeHash: string;
  readonly storageBindingHash: string;
  readonly experiment: ExperimentIdentity;
  readonly snapshotReceiptHash: string;
  readonly indexId: string;
  readonly indexedAt: string;
  readonly containsTaskIdentifiers: false;
}

export interface TrustedCandidateSourceIndexAttestation {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-candidate-source-index-attestation";
  readonly storageBindingHash: string;
  readonly indexAttestationHash: string;
  readonly aggregateCostUsd: number;
  readonly tokens: number;
  readonly wallTimeMs: number;
  readonly accountingAttestationHash: string;
  readonly containsTaskIdentifiers: false;
}

export interface TrustedCandidateSourceIndexAttestationAuthority {
  readonly boundary: "trusted-cloud";
  attest(
    request: TrustedCandidateSourceIndexAttestationRequest,
  ): Promise<TrustedCandidateSourceIndexAttestation>;
}

interface DurableCandidateSourceIndexEntry {
  readonly experiment: ExperimentIdentity;
  readonly snapshotReceiptHash: string;
  readonly snapshot: TrustedGitSourceSnapshotReceipt;
  readonly indexed: AccountedCorrectnessGateReceipt<TrustedCandidateSourceIndexReceipt>;
}

interface DurableCandidateSourceIndexState {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-candidate-source-index";
  readonly storeScopeHash: string;
  readonly revision: number;
  readonly byCommit: Readonly<Record<string, DurableCandidateSourceIndexEntry>>;
}

function sourceIndexStorageBindingHash(input: {
  readonly storeScopeHash: string;
  readonly experiment: ExperimentIdentity;
  readonly snapshotReceiptHash: string;
  readonly snapshot: TrustedGitSourceSnapshotReceipt;
}): string {
  return canonicalHash({
    schemaVersion: 1,
    domain: "dark-factory.candidate-source-index-storage-binding.v1",
    storeScopeHash: input.storeScopeHash,
    experiment: input.experiment,
    candidateCommit: input.snapshot.commitSha,
    candidateTree: input.snapshot.treeSha,
    lockSha256: input.snapshot.lockSha256,
    sourceArtifact: input.snapshot.sourceArtifact,
    sourceBundleArtifact: input.snapshot.sourceBundleArtifact,
    snapshotReceiptHash: input.snapshotReceiptHash,
  });
}

function assertCandidateSourceIndexState(
  value: unknown,
  input: {
    readonly scopeHash: string;
    readonly sourceVerifier: TrustedGitSourceReceiptVerifier;
  },
): asserts value is DurableCandidateSourceIndexState {
  assertExactKeys(
    value,
    ["schemaVersion", "sensitivity", "storeScopeHash", "revision", "byCommit"],
    "Durable candidate source index state",
  );
  const state = value as unknown as DurableCandidateSourceIndexState;
  if (
    state.schemaVersion !== 1 ||
    state.sensitivity !== "trusted-candidate-source-index" ||
    state.storeScopeHash !== input.scopeHash ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !isPlainRecord(state.byCommit) ||
    state.revision !== Object.keys(state.byCommit).length
  ) {
    fail("Durable candidate source index state is malformed.");
  }
  const snapshotHashes = new Set<string>();
  const indexAttestations = new Set<string>();
  const accountingAttestations = new Set<string>();
  for (const [commit, rawEntry] of Object.entries(state.byCommit)) {
    assertExactKeys(
      rawEntry,
      ["experiment", "snapshotReceiptHash", "snapshot", "indexed"],
      "Durable candidate source index entry",
    );
    const entry = rawEntry as unknown as DurableCandidateSourceIndexEntry;
    experimentId(entry.experiment);
    assertSnapshotReceipt(entry.snapshot, input.sourceVerifier);
    if (
      !GIT_OBJECT_ID.test(commit) ||
      entry.snapshot.commitSha !== commit ||
      entry.snapshotReceiptHash !== canonicalHash(entry.snapshot) ||
      snapshotHashes.has(entry.snapshotReceiptHash)
    ) {
      fail("Durable candidate source index entry is inconsistent.");
    }
    assertAccounted(
      entry.indexed,
      "source-index",
      (receipt): asserts receipt is TrustedCandidateSourceIndexReceipt =>
        assertSourceIndexReceipt(receipt, {
          experiment: entry.experiment,
          snapshot: entry.snapshot,
          snapshotReceiptHash: entry.snapshotReceiptHash,
        }),
    );
    if (
      indexAttestations.has(entry.indexed.receipt.indexAttestationHash) ||
      accountingAttestations.has(entry.indexed.accounting.accountingAttestationHash)
    ) {
      fail("Candidate source index attestations are not unique.");
    }
    snapshotHashes.add(entry.snapshotReceiptHash);
    indexAttestations.add(entry.indexed.receipt.indexAttestationHash);
    accountingAttestations.add(entry.indexed.accounting.accountingAttestationHash);
  }
}

function assertIndexAttestation(
  value: unknown,
  expectedStorageBindingHash: string,
): asserts value is TrustedCandidateSourceIndexAttestation {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "sensitivity",
      "storageBindingHash",
      "indexAttestationHash",
      "aggregateCostUsd",
      "tokens",
      "wallTimeMs",
      "accountingAttestationHash",
      "containsTaskIdentifiers",
    ],
    "Trusted candidate source index attestation",
  );
  const attestation = value as unknown as TrustedCandidateSourceIndexAttestation;
  if (
    attestation.schemaVersion !== 1 ||
    attestation.sensitivity !== "trusted-candidate-source-index-attestation" ||
    attestation.storageBindingHash !== expectedStorageBindingHash ||
    !SHA256.test(attestation.indexAttestationHash) ||
    !Number.isFinite(attestation.aggregateCostUsd) ||
    attestation.aggregateCostUsd < 0 ||
    attestation.aggregateCostUsd > MAXIMUM_COST_USD ||
    !Number.isSafeInteger(attestation.tokens) ||
    attestation.tokens < 0 ||
    attestation.tokens > MAXIMUM_TOKENS ||
    !Number.isSafeInteger(attestation.wallTimeMs) ||
    attestation.wallTimeMs < 0 ||
    attestation.wallTimeMs > MAXIMUM_WALL_TIME_MS ||
    !SHA256.test(attestation.accountingAttestationHash) ||
    attestation.accountingAttestationHash === attestation.indexAttestationHash ||
    attestation.containsTaskIdentifiers !== false
  ) {
    fail("Trusted candidate source index attestation is malformed.");
  }
}

export interface MountedVolumeTrustedCandidateSourceIndexOptions {
  readonly durableState: MountedVolumeDurableStateOptions;
  readonly sourceReceiptVerifier: TrustedGitSourceReceiptVerifier;
  readonly attestationAuthority: TrustedCandidateSourceIndexAttestationAuthority;
}

type CandidateSourceIndexInput = {
  readonly experiment: ExperimentIdentity;
  readonly snapshot: TrustedGitSourceSnapshotReceipt;
  readonly snapshotReceiptHash: string;
};

type CandidateSourceIndexResult =
  AccountedCorrectnessGateReceipt<TrustedCandidateSourceIndexReceipt>;

/**
 * Linearizable commit-keyed source index. It retains the exact signed source
 * snapshot rather than a mutable pointer, and it only exposes a release-safe
 * accounted receipt after a trusted authority has attested the storage
 * binding. Identical retries return the originally committed receipt.
 */
export class MountedVolumeTrustedCandidateSourceIndex implements TrustedCandidateSourceIndexPort {
  readonly boundary = "trusted-cloud" as const;
  readonly durability = "linearizable" as const;
  readonly #store: MountedVolumeTransactionalJsonStore<DurableCandidateSourceIndexState>;
  readonly #scopeHash: string;
  readonly #sourceVerifier: TrustedGitSourceReceiptVerifier;
  readonly #authority: TrustedCandidateSourceIndexAttestationAuthority;
  readonly #now: () => Date;
  readonly #inFlight = new Map<
    string,
    {
      readonly inputHash: string;
      readonly promise: Promise<CandidateSourceIndexResult>;
    }
  >();
  #closePromise: Promise<void> | null = null;

  public constructor(options: MountedVolumeTrustedCandidateSourceIndexOptions) {
    if (options.attestationAuthority.boundary !== "trusted-cloud") {
      fail("Candidate source index attestation authority is untrusted.");
    }
    this.#scopeHash = storeScopeHash(
      options.durableState.storeId,
      "dark-factory.candidate-source-index-store-scope.v1",
    );
    const sourceVerifier = captureVerifier(options.sourceReceiptVerifier);
    this.#sourceVerifier = sourceVerifier;
    this.#authority = Object.freeze({
      boundary: "trusted-cloud" as const,
      attest: options.attestationAuthority.attest.bind(options.attestationAuthority),
    });
    this.#now = options.durableState.now ?? (() => new Date());
    this.#store = new MountedVolumeTransactionalJsonStore<DurableCandidateSourceIndexState>(
      options.durableState,
      `candidate-source-index-${options.durableState.storeId}`,
      {
        domain: "dark-factory.candidate-source-index-state.v1",
        initialState: () => ({
          schemaVersion: 1,
          sensitivity: "trusted-candidate-source-index",
          storeScopeHash: this.#scopeHash,
          revision: 0,
          byCommit: {},
        }),
        assertState(value): asserts value is DurableCandidateSourceIndexState {
          assertCandidateSourceIndexState(value, {
            scopeHash: storeScopeHash(
              options.durableState.storeId,
              "dark-factory.candidate-source-index-store-scope.v1",
            ),
            sourceVerifier,
          });
        },
        revision: (state) => state.revision,
      },
    );
  }

  async #existingOrConflict(input: {
    readonly experiment: ExperimentIdentity;
    readonly snapshot: TrustedGitSourceSnapshotReceipt;
    readonly snapshotReceiptHash: string;
  }): Promise<AccountedCorrectnessGateReceipt<TrustedCandidateSourceIndexReceipt> | null> {
    return this.#store.transact((state) => {
      const existing = state.byCommit[input.snapshot.commitSha];
      if (existing === undefined) {
        return { next: state, result: null };
      }
      if (
        canonicalJson(existing.experiment) !== canonicalJson(input.experiment) ||
        existing.snapshotReceiptHash !== input.snapshotReceiptHash ||
        canonicalJson(existing.snapshot) !== canonicalJson(input.snapshot)
      ) {
        fail("Candidate commit already binds a different source snapshot.");
      }
      return {
        next: state,
        result: cloneJson(existing.indexed, "Existing candidate source index receipt"),
      };
    });
  }

  public async index(input: CandidateSourceIndexInput): Promise<CandidateSourceIndexResult> {
    if (this.#closePromise !== null) {
      fail("Candidate source index is closing.");
    }
    const frozen = cloneJson(input, "Candidate source index input");
    experimentId(frozen.experiment);
    assertSnapshotReceipt(frozen.snapshot, this.#sourceVerifier);
    if (
      !SHA256.test(frozen.snapshotReceiptHash) ||
      frozen.snapshotReceiptHash !== canonicalHash(frozen.snapshot)
    ) {
      fail("Candidate source index snapshot commitment is invalid.");
    }
    const commit = frozen.snapshot.commitSha;
    const inputHash = canonicalHash(frozen);
    const pending = this.#inFlight.get(commit);
    if (pending !== undefined) {
      if (pending.inputHash !== inputHash) {
        fail("Candidate commit already has a different in-flight source binding.");
      }
      return cloneJson(await pending.promise, "Concurrent candidate source index result");
    }
    const operation = this.#indexValidated(frozen);
    const tracked = operation.finally(() => {
      if (this.#inFlight.get(commit)?.inputHash === inputHash) {
        this.#inFlight.delete(commit);
      }
    });
    this.#inFlight.set(commit, { inputHash, promise: tracked });
    return cloneJson(await tracked, "Candidate source index result");
  }

  async #indexValidated(frozen: CandidateSourceIndexInput): Promise<CandidateSourceIndexResult> {
    const existing = await this.#existingOrConflict(frozen);
    if (existing !== null) return existing;

    let indexedAt: string;
    try {
      indexedAt = this.#now().toISOString();
    } catch {
      fail("Candidate source index clock is invalid.");
    }
    if (
      !isCanonicalTimestamp(indexedAt) ||
      Date.parse(indexedAt) < Date.parse(frozen.snapshot.createdAt)
    ) {
      fail("Candidate source index time precedes its source snapshot.");
    }
    const indexId = expectedSourceIndexId(frozen);
    const storageBindingHash = sourceIndexStorageBindingHash({
      storeScopeHash: this.#scopeHash,
      ...frozen,
    });
    const request: TrustedCandidateSourceIndexAttestationRequest = {
      schemaVersion: 1,
      sensitivity: "trusted-candidate-source-index-attestation-request",
      storeScopeHash: this.#scopeHash,
      storageBindingHash,
      experiment: frozen.experiment,
      snapshotReceiptHash: frozen.snapshotReceiptHash,
      indexId,
      indexedAt,
      containsTaskIdentifiers: false,
    };
    const authorityRequest = cloneJson(request, "Candidate source index attestation request");
    const requestBefore = canonicalJson(authorityRequest);
    let attestation: TrustedCandidateSourceIndexAttestation;
    try {
      attestation = cloneJson(
        await this.#authority.attest(authorityRequest),
        "Candidate source index attestation",
      );
    } catch {
      fail("Candidate source index attestation failed closed.");
    }
    if (canonicalJson(authorityRequest) !== requestBefore) {
      fail("Candidate source index attestation mutated its request.");
    }
    assertIndexAttestation(attestation, storageBindingHash);

    const receipt: TrustedCandidateSourceIndexReceipt = {
      schemaVersion: 2,
      sensitivity: "release-safe-candidate-source-index",
      indexId,
      experimentId: experimentId(frozen.experiment),
      protocolHash: frozen.experiment.protocolHash,
      registrationId: frozen.snapshot.registrationId,
      originRepositoryHash: frozen.snapshot.originRepositoryHash,
      candidateCommit: frozen.snapshot.commitSha,
      candidateTree: frozen.snapshot.treeSha,
      lockSha256: frozen.snapshot.lockSha256,
      sourceArtifactSha256: frozen.snapshot.sourceArtifact.sha256,
      sourceBundleArtifactSha256: frozen.snapshot.sourceBundleArtifact.sha256,
      snapshotReceiptHash: frozen.snapshotReceiptHash,
      indexedAt,
      containsTaskIdentifiers: false,
      indexAttestationHash: attestation.indexAttestationHash,
    };
    const indexed: AccountedCorrectnessGateReceipt<TrustedCandidateSourceIndexReceipt> = {
      receipt,
      accounting: {
        schemaVersion: 1,
        sensitivity: "release-safe-correctness-gate-accounting",
        operation: "source-index",
        receiptHash: canonicalHash(receipt),
        aggregateCostUsd: attestation.aggregateCostUsd,
        tokens: attestation.tokens,
        wallTimeMs: attestation.wallTimeMs,
        containsTaskIdentifiers: false,
        accountingAttestationHash: attestation.accountingAttestationHash,
      },
    };
    assertAccounted(
      indexed,
      "source-index",
      (candidate): asserts candidate is TrustedCandidateSourceIndexReceipt =>
        assertSourceIndexReceipt(candidate, frozen),
    );

    return this.#store.transact((state) => {
      const conflict = state.byCommit[frozen.snapshot.commitSha];
      if (conflict !== undefined) {
        if (
          canonicalJson(conflict.experiment) !== canonicalJson(frozen.experiment) ||
          conflict.snapshotReceiptHash !== frozen.snapshotReceiptHash ||
          canonicalJson(conflict.snapshot) !== canonicalJson(frozen.snapshot)
        ) {
          fail("Candidate commit was concurrently bound to different source bytes.");
        }
        return {
          next: state,
          result: cloneJson(conflict.indexed, "Concurrent candidate source index receipt"),
        };
      }
      const entry: DurableCandidateSourceIndexEntry = {
        experiment: frozen.experiment,
        snapshotReceiptHash: frozen.snapshotReceiptHash,
        snapshot: frozen.snapshot,
        indexed,
      };
      return {
        next: {
          ...state,
          revision: state.revision + 1,
          byCommit: {
            ...state.byCommit,
            [frozen.snapshot.commitSha]: entry,
          },
        },
        result: cloneJson(indexed, "Committed candidate source index receipt"),
      };
    });
  }

  public findByCommit(
    candidateCommit: string,
  ): Promise<TrustedGitSourceSnapshotReceipt | undefined> {
    if (this.#closePromise !== null) {
      fail("Candidate source index is closing.");
    }
    assertGitObject(candidateCommit, "Candidate source index lookup commit");
    return this.#store.transact((state) => {
      const entry = state.byCommit[candidateCommit];
      return {
        next: state,
        result:
          entry === undefined
            ? undefined
            : cloneJson(entry.snapshot, "Indexed Git source snapshot"),
      };
    });
  }

  public close(): Promise<void> {
    if (this.#closePromise === null) {
      this.#closePromise = (async () => {
        await Promise.allSettled([...this.#inFlight.values()].map((entry) => entry.promise));
        await this.#store.close();
      })();
    }
    return this.#closePromise;
  }
}
