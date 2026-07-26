import { createPublicKey } from "node:crypto";

import type { TrustedCloudArtifactRef } from "../cloud/types.js";
import type { ExperimentIdentity } from "../domain/models.js";
import { verifyEd25519Signature } from "../evidence/signatures.js";
import {
  TRUSTED_GIT_SOURCE_BUNDLE_REF,
  type TrustedGitSourceSnapshotReceipt,
} from "../harness/git-source.js";
import type { RepositoryRegistration } from "../harness/repository.js";
import type { TrustedGitSourceSnapshotReceiptSource } from "../orchestrator/trusted-port-adapters.js";
import { canonicalHash, canonicalJson, sha256 } from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import type { CloudOptimizerAdapterResolver, OptimizerBundleGitSource } from "./cloud-session.js";
import {
  assertOptimizerBoundArtifactBytesSafe,
  assertOptimizerReleaseArtifactInspectionPolicy,
  maximumOptimizerArtifactInspectionBytes,
  type OptimizerArtifactInspectionKind,
  type OptimizerReleaseArtifactInspectionPolicy,
  type TrustedOptimizerReleaseArtifactReader,
} from "./release-artifact-safety.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,255}$/u;
const SAFE_RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TRUSTED_URI = /^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const MAXIMUM_METADATA_BYTES = 4 * 1024 * 1024;
const MAXIMUM_EVIDENCE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_SOURCE_BUNDLE_BYTES = 256 * 1024 * 1024;

export type OptimizerResolverSignaturePurpose =
  | "git-source-snapshot-receipt"
  | "optimizer-source-only-bootstrap-evidence"
  | "optimizer-proposal-diagnostic-evidence"
  | "optimizer-analysis-evidence";

export interface OptimizerResolverPublicKeyRequest {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.optimizer-resolver-public-key-request.v1";
  readonly purpose: OptimizerResolverSignaturePurpose;
  readonly keyId: string;
  readonly keyVersion: string | null;
  readonly signedAt: string;
  readonly documentHash: string;
  readonly authoritySetHash: string;
  readonly verificationKeySetHash: string;
}

export interface TrustedOptimizerResolverPublicKey {
  readonly boundary: "trusted-cloud-key-material";
  readonly algorithm: "Ed25519";
  readonly purpose: OptimizerResolverSignaturePurpose;
  readonly keyId: string;
  readonly keyVersion: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly revoked: boolean;
  readonly authoritySetHash: string;
  readonly verificationKeySetHash: string;
  readonly publicKeySpkiDer: Uint8Array;
}

/**
 * Production injects a KMS-backed historical key authority. It selects a key
 * by purpose, key ID, optional version, and signing instant; resolver metadata
 * never supplies public key material.
 */
export interface TrustedOptimizerResolverPublicKeyAuthority {
  readonly boundary: "trusted-cloud-optimizer-resolver-public-key-authority";
  resolve(
    request: OptimizerResolverPublicKeyRequest,
  ): Promise<TrustedOptimizerResolverPublicKey | undefined>;
}

export interface TrustedOptimizerResolverArtifactReader {
  readonly boundary: "trusted-cloud";
  readUtf8(artifact: TrustedCloudArtifactRef, maximumBytes: number): Promise<string>;
}

export interface OptimizerProposalDiagnosticEvidenceQuery {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.optimizer-proposal-evidence-query.v1";
  readonly purpose: "proposal-diagnostic";
  readonly campaignId: string;
  readonly experimentId: string;
  readonly diagnosticHash: string;
  readonly releaseId: string;
  readonly actionable: boolean;
  readonly queryHash: string;
}

export interface OptimizerAnalysisEvidenceQuery {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.optimizer-analysis-evidence-query.v1";
  readonly purpose: "analysis";
  readonly campaignId: string;
  readonly experimentId: string;
  readonly hypothesisHash: string;
  readonly hypothesisDocumentHash: string;
  readonly candidateCommit: string;
  readonly candidatePatchHash: string;
  readonly candidateDocumentHash: string;
  readonly repairAttestationHash: string | null;
  readonly validationAttestationHash: string | null;
  readonly releasedEvidenceHash: string | null;
  readonly queryHash: string;
}

export type OptimizerReleasedEvidenceQuery =
  | OptimizerProposalDiagnosticEvidenceQuery
  | OptimizerAnalysisEvidenceQuery;

export interface TrustedOptimizerReleasedEvidenceMetadataSource {
  readonly boundary: "trusted-cloud";
  /**
   * A query returns all exact immutable metadata artifacts matching its
   * content-addressed bindings. The resolver requires exactly one, so hidden
   * ambiguity cannot be resolved by ordering.
   */
  locate(query: OptimizerReleasedEvidenceQuery): Promise<readonly TrustedCloudArtifactRef[]>;
}

interface OptimizerReleasedEvidenceSafety {
  readonly containsTaskIdentifiers: false;
  readonly containsPanelIdentifiers: false;
  readonly containsCellIdentifiers: false;
  readonly containsRawEvidence: false;
  readonly containsGraderIdentifiers: false;
}

interface OptimizerReleasedEvidenceMetadataBase extends OptimizerReleasedEvidenceSafety {
  readonly schemaVersion: 1;
  readonly artifact: TrustedCloudArtifactRef;
  readonly releaseSafetyAttestationHash: string;
  readonly issuedAt: string;
  readonly keyVersion: string;
  readonly metadataHash: string;
  readonly signature: Signature;
}

export interface OptimizerSourceOnlyBootstrapEvidenceMetadata
  extends OptimizerReleasedEvidenceMetadataBase {
  readonly domain: "dark-factory.optimizer-source-only-bootstrap-evidence.v1";
  readonly purpose: "source-only-bootstrap";
  readonly reviewed: true;
  readonly reviewPolicyHash: string;
}

export interface OptimizerProposalDiagnosticEvidenceMetadata
  extends OptimizerReleasedEvidenceMetadataBase {
  readonly domain: "dark-factory.optimizer-proposal-diagnostic-evidence.v1";
  readonly purpose: "proposal-diagnostic";
  readonly campaignId: string;
  readonly experimentId: string;
  readonly diagnosticHash: string;
  readonly releaseId: string;
  readonly actionable: boolean;
}

export interface OptimizerAnalysisEvidenceMetadata extends OptimizerReleasedEvidenceMetadataBase {
  readonly domain: "dark-factory.optimizer-analysis-evidence.v1";
  readonly purpose: "analysis";
  readonly campaignId: string;
  readonly experimentId: string;
  readonly hypothesisHash: string;
  readonly hypothesisDocumentHash: string;
  readonly candidateCommit: string;
  readonly candidatePatchHash: string;
  readonly candidateDocumentHash: string;
  readonly repairAttestationHash: string | null;
  readonly validationAttestationHash: string | null;
  readonly releasedEvidenceHash: string | null;
}

export type OptimizerReleasedEvidenceMetadata =
  | OptimizerSourceOnlyBootstrapEvidenceMetadata
  | OptimizerProposalDiagnosticEvidenceMetadata
  | OptimizerAnalysisEvidenceMetadata;

export interface ArtifactBackedCloudOptimizerAdapterResolverOptions {
  readonly sourceIndex: TrustedGitSourceSnapshotReceiptSource;
  /**
   * Captured campaign prerequisite produced by trusted registration. The local
   * canonicalPath is never read or released.
   */
  readonly registration: RepositoryRegistration;
  readonly sourceOnlyBootstrapMetadataArtifact: TrustedCloudArtifactRef;
  readonly evidenceSource: TrustedOptimizerReleasedEvidenceMetadataSource;
  readonly artifactReader: TrustedOptimizerResolverArtifactReader;
  /**
   * Independent byte reader for every archive/reference released toward the
   * optimizer. Metadata signatures and contains* booleans are not content
   * inspection and cannot replace this capability.
   */
  readonly releaseArtifactReader: TrustedOptimizerReleaseArtifactReader;
  readonly releaseArtifactInspectionPolicy: OptimizerReleaseArtifactInspectionPolicy;
  readonly keyAuthority: TrustedOptimizerResolverPublicKeyAuthority;
  readonly authoritySetHash: string;
  readonly verificationKeySetHash: string;
  readonly maximumMetadataBytes?: number;
  readonly maximumEvidenceBytes?: number;
}

export class ArtifactBackedCloudOptimizerAdapterResolverError extends Error {
  override readonly name = "ArtifactBackedCloudOptimizerAdapterResolverError";

  constructor() {
    super("Production optimizer input resolution failed closed.");
  }
}

function fail(): never {
  throw new ArtifactBackedCloudOptimizerAdapterResolverError();
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
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
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail();
  }
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

function timestamp(value: unknown): number {
  if (typeof value !== "string") fail();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail();
  }
  return parsed;
}

function experimentId(experiment: ExperimentIdentity): string {
  exactKeys(experiment, [
    "number",
    "slug",
    "kind",
    "parentExperiment",
    "lineageId",
    "protocolHash",
  ]);
  const value = `${experiment.number.toString().padStart(3, "0")}-${experiment.slug}`;
  if (
    !Number.isSafeInteger(experiment.number) ||
    experiment.number < 1 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(experiment.slug) ||
    experiment.slug.length > 64 ||
    experiment.kind !== "optimization" ||
    experiment.parentExperiment === null ||
    !Number.isSafeInteger(experiment.parentExperiment) ||
    experiment.parentExperiment < 0 ||
    experiment.parentExperiment >= experiment.number ||
    !SAFE_ID.test(experiment.lineageId) ||
    !SHA256.test(experiment.protocolHash) ||
    !/^[0-9]{3,8}-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  ) {
    fail();
  }
  return value;
}

function assertArtifact(
  value: unknown,
  mediaType: string,
  maximumBytes: number,
): asserts value is TrustedCloudArtifactRef {
  exactKeys(value, ["uri", "sha256", "mediaType", "byteLength"]);
  const artifact = value as unknown as TrustedCloudArtifactRef;
  if (
    !TRUSTED_URI.test(artifact.uri) ||
    artifact.uri.includes("..") ||
    !SHA256.test(artifact.sha256) ||
    artifact.mediaType !== mediaType ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength <= 0 ||
    artifact.byteLength > maximumBytes
  ) {
    fail();
  }
}

function assertSignature(value: unknown): asserts value is Signature {
  exactKeys(value, ["algorithm", "keyId", "signedAt", "signature"]);
  const signature = value as unknown as Signature;
  if (
    signature.algorithm !== "ed25519" ||
    !SAFE_ID.test(signature.keyId) ||
    !/^[A-Za-z0-9_-]{86,128}$/u.test(signature.signature)
  ) {
    fail();
  }
  timestamp(signature.signedAt);
}

function metadataUnsigned(
  metadata: OptimizerReleasedEvidenceMetadata,
): Readonly<Record<string, unknown>> {
  const unsigned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key !== "metadataHash" && key !== "signature") {
      unsigned[key] = value;
    }
  }
  return unsigned;
}

export function optimizerReleasedEvidenceMetadataHash(
  metadata: OptimizerReleasedEvidenceMetadata,
): string {
  return canonicalHash(metadataUnsigned(metadata));
}

function signaturePurpose(
  metadata: OptimizerReleasedEvidenceMetadata,
): OptimizerResolverSignaturePurpose {
  switch (metadata.purpose) {
    case "source-only-bootstrap":
      return "optimizer-source-only-bootstrap-evidence";
    case "proposal-diagnostic":
      return "optimizer-proposal-diagnostic-evidence";
    case "analysis":
      return "optimizer-analysis-evidence";
  }
}

function commonMetadataKeys(): readonly string[] {
  return [
    "schemaVersion",
    "domain",
    "purpose",
    "artifact",
    "releaseSafetyAttestationHash",
    "containsTaskIdentifiers",
    "containsPanelIdentifiers",
    "containsCellIdentifiers",
    "containsRawEvidence",
    "containsGraderIdentifiers",
    "issuedAt",
    "keyVersion",
    "metadataHash",
    "signature",
  ];
}

function assertMetadataShape(
  value: unknown,
  maximumEvidenceBytes: number,
): asserts value is OptimizerReleasedEvidenceMetadata {
  if (!isPlainRecord(value) || typeof value.purpose !== "string") fail();
  const common = commonMetadataKeys();
  if (value.purpose === "source-only-bootstrap") {
    exactKeys(value, [...common, "reviewed", "reviewPolicyHash"]);
  } else if (value.purpose === "proposal-diagnostic") {
    exactKeys(value, [
      ...common,
      "campaignId",
      "experimentId",
      "diagnosticHash",
      "releaseId",
      "actionable",
    ]);
  } else if (value.purpose === "analysis") {
    exactKeys(value, [
      ...common,
      "campaignId",
      "experimentId",
      "hypothesisHash",
      "hypothesisDocumentHash",
      "candidateCommit",
      "candidatePatchHash",
      "candidateDocumentHash",
      "repairAttestationHash",
      "validationAttestationHash",
      "releasedEvidenceHash",
    ]);
  } else {
    fail();
  }
  const metadata = value as unknown as OptimizerReleasedEvidenceMetadata;
  assertArtifact(metadata.artifact, "application/x-tar", maximumEvidenceBytes);
  assertSignature(metadata.signature);
  if (
    metadata.schemaVersion !== 1 ||
    metadata.containsTaskIdentifiers !== false ||
    metadata.containsPanelIdentifiers !== false ||
    metadata.containsCellIdentifiers !== false ||
    metadata.containsRawEvidence !== false ||
    metadata.containsGraderIdentifiers !== false ||
    !SHA256.test(metadata.releaseSafetyAttestationHash) ||
    !SAFE_ID.test(metadata.keyVersion) ||
    !SHA256.test(metadata.metadataHash) ||
    metadata.metadataHash !== optimizerReleasedEvidenceMetadataHash(metadata) ||
    timestamp(metadata.signature.signedAt) < timestamp(metadata.issuedAt)
  ) {
    fail();
  }
  if (metadata.purpose === "source-only-bootstrap") {
    if (
      metadata.domain !== "dark-factory.optimizer-source-only-bootstrap-evidence.v1" ||
      metadata.reviewed !== true ||
      !SHA256.test(metadata.reviewPolicyHash)
    ) {
      fail();
    }
  } else if (metadata.purpose === "proposal-diagnostic") {
    if (
      metadata.domain !== "dark-factory.optimizer-proposal-diagnostic-evidence.v1" ||
      !SAFE_ID.test(metadata.campaignId) ||
      !/^[0-9]{3,8}-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(metadata.experimentId) ||
      !SHA256.test(metadata.diagnosticHash) ||
      !SAFE_RELEASE_ID.test(metadata.releaseId) ||
      typeof metadata.actionable !== "boolean"
    ) {
      fail();
    }
  } else if (
    metadata.domain !== "dark-factory.optimizer-analysis-evidence.v1" ||
    !SAFE_ID.test(metadata.campaignId) ||
    !/^[0-9]{3,8}-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(metadata.experimentId) ||
    !SHA256.test(metadata.hypothesisHash) ||
    !SHA256.test(metadata.hypothesisDocumentHash) ||
    !GIT_OBJECT.test(metadata.candidateCommit) ||
    !SHA256.test(metadata.candidatePatchHash) ||
    !SHA256.test(metadata.candidateDocumentHash) ||
    (metadata.repairAttestationHash !== null && !SHA256.test(metadata.repairAttestationHash)) ||
    (metadata.validationAttestationHash !== null &&
      !SHA256.test(metadata.validationAttestationHash)) ||
    (metadata.releasedEvidenceHash !== null && !SHA256.test(metadata.releasedEvidenceHash))
  ) {
    fail();
  }
}

function assertPublicKey(
  value: unknown,
  request: OptimizerResolverPublicKeyRequest,
): asserts value is TrustedOptimizerResolverPublicKey {
  exactKeys(value, [
    "boundary",
    "algorithm",
    "purpose",
    "keyId",
    "keyVersion",
    "validFrom",
    "validUntil",
    "revoked",
    "authoritySetHash",
    "verificationKeySetHash",
    "publicKeySpkiDer",
  ]);
  const key = value as unknown as TrustedOptimizerResolverPublicKey;
  const validFrom = timestamp(key.validFrom);
  const validUntil = timestamp(key.validUntil);
  const signedAt = timestamp(request.signedAt);
  if (
    key.boundary !== "trusted-cloud-key-material" ||
    key.algorithm !== "Ed25519" ||
    key.purpose !== request.purpose ||
    key.keyId !== request.keyId ||
    !SAFE_ID.test(key.keyVersion) ||
    (request.keyVersion !== null && key.keyVersion !== request.keyVersion) ||
    key.revoked !== false ||
    key.authoritySetHash !== request.authoritySetHash ||
    key.verificationKeySetHash !== request.verificationKeySetHash ||
    validFrom >= validUntil ||
    signedAt < validFrom ||
    signedAt >= validUntil ||
    !(key.publicKeySpkiDer instanceof Uint8Array) ||
    key.publicKeySpkiDer.byteLength < 32 ||
    key.publicKeySpkiDer.byteLength > 8_192
  ) {
    fail();
  }
}

function assertSourceReceiptShape(
  value: unknown,
): asserts value is TrustedGitSourceSnapshotReceipt {
  exactKeys(value, [
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
  ]);
  const receipt = value as unknown as TrustedGitSourceSnapshotReceipt;
  assertArtifact(
    receipt.sourceArtifact,
    "application/x-tar",
    maximumOptimizerArtifactInspectionBytes("source-tree-tar"),
  );
  assertArtifact(
    receipt.sourceBundleArtifact,
    "application/vnd.git.bundle",
    MAXIMUM_SOURCE_BUNDLE_BYTES,
  );
  assertSignature(receipt.signature);
  if (
    receipt.sensitivity !== "trusted-git-source-snapshot" ||
    receipt.schemaVersion !== 2 ||
    !SAFE_ID.test(receipt.snapshotId) ||
    !SHA256.test(receipt.registrationId) ||
    !SHA256.test(receipt.originRepositoryHash) ||
    !SHA256.test(receipt.upstreamRepositoryHash) ||
    !GIT_OBJECT.test(receipt.upstreamHeadCommit) ||
    !GIT_OBJECT.test(receipt.upstreamBaseCommit) ||
    !GIT_OBJECT.test(receipt.baselineCommit) ||
    !["daytona", "e2b", "modal"].includes(receipt.provider) ||
    !SAFE_ID.test(receipt.sandboxId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,446}@sha256:[a-f0-9]{64}$/u.test(receipt.imageReference) ||
    !/^sha256:[a-f0-9]{64}$/u.test(receipt.imageDigest) ||
    !receipt.imageReference.endsWith(`@${receipt.imageDigest}`) ||
    !SHA256.test(receipt.networkPolicyHash) ||
    !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u.test(receipt.remoteRef) ||
    receipt.remoteRef.includes("..") ||
    receipt.remoteRef.includes("@{") ||
    receipt.remoteRef.includes("//") ||
    receipt.remoteRef.endsWith("/") ||
    receipt.remoteRef.endsWith(".") ||
    receipt.remoteRef.endsWith(".lock") ||
    receipt.remoteRef
      .slice("refs/heads/".length)
      .split("/")
      .some(
        (component) =>
          component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock"),
      ) ||
    !GIT_OBJECT.test(receipt.commitSha) ||
    !GIT_OBJECT.test(receipt.treeSha) ||
    !SHA256.test(receipt.lockSha256) ||
    receipt.archiveMethod !== "git-archive-format-tar" ||
    receipt.compression !== "none" ||
    receipt.bundleMethod !== "git-bundle-v2" ||
    receipt.bundleRef !== TRUSTED_GIT_SOURCE_BUNDLE_REF ||
    !SHA256.test(receipt.workerSha256) ||
    !SHA256.test(receipt.executionReceiptHash) ||
    !SHA256.test(receipt.manifestArtifactSha256) ||
    receipt.passed !== true ||
    timestamp(receipt.signature.signedAt) < timestamp(receipt.createdAt)
  ) {
    fail();
  }
}

function assertRegistration(registration: RepositoryRegistration): void {
  exactKeys(registration, [
    "registrationId",
    "canonicalPath",
    "branch",
    "headCommit",
    "treeSha",
    "lockSha256",
    "upstreamBaseCommit",
    "originFingerprint",
    "upstreamFingerprint",
    "originVerification",
    "upstreamVerification",
  ]);
  exactKeys(registration.originFingerprint, ["transport", "hostHash", "repositoryHash"]);
  exactKeys(registration.upstreamFingerprint, ["transport", "hostHash", "repositoryHash"]);
  exactKeys(registration.originVerification, [
    "private",
    "fetchable",
    "writable",
    "checkedAt",
    "providerAttestationHash",
  ]);
  exactKeys(registration.upstreamVerification, [
    "fetchable",
    "upstreamHeadCommit",
    "mergeBaseCommit",
    "checkedAt",
    "providerAttestationHash",
  ]);
  if (
    !SHA256.test(registration.registrationId) ||
    typeof registration.canonicalPath !== "string" ||
    registration.canonicalPath.length < 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u.test(registration.branch) ||
    !GIT_OBJECT.test(registration.headCommit) ||
    !GIT_OBJECT.test(registration.treeSha) ||
    !SHA256.test(registration.lockSha256) ||
    !GIT_OBJECT.test(registration.upstreamBaseCommit) ||
    !["https", "ssh"].includes(registration.originFingerprint.transport) ||
    !SHA256.test(registration.originFingerprint.hostHash) ||
    !SHA256.test(registration.originFingerprint.repositoryHash) ||
    registration.upstreamFingerprint.transport !== "https" ||
    !SHA256.test(registration.upstreamFingerprint.hostHash) ||
    !SHA256.test(registration.upstreamFingerprint.repositoryHash) ||
    registration.originVerification.private !== true ||
    registration.originVerification.fetchable !== true ||
    registration.originVerification.writable !== true ||
    !SHA256.test(registration.originVerification.providerAttestationHash) ||
    registration.upstreamVerification.fetchable !== true ||
    !GIT_OBJECT.test(registration.upstreamVerification.upstreamHeadCommit) ||
    registration.upstreamVerification.mergeBaseCommit !== registration.upstreamBaseCommit ||
    !SHA256.test(registration.upstreamVerification.providerAttestationHash)
  ) {
    fail();
  }
  timestamp(registration.originVerification.checkedAt);
  timestamp(registration.upstreamVerification.checkedAt);
}

function assertSourceBindings(
  receipt: TrustedGitSourceSnapshotReceipt,
  registration: RepositoryRegistration,
  activeChampion: {
    readonly baselineCommit: string;
    readonly activeExperiment: number;
    readonly activeCommit: string;
  },
): void {
  if (
    activeChampion.baselineCommit !== registration.headCommit ||
    receipt.registrationId !== registration.registrationId ||
    receipt.originRepositoryHash !== registration.originFingerprint.repositoryHash ||
    receipt.upstreamRepositoryHash !== registration.upstreamFingerprint.repositoryHash ||
    receipt.upstreamHeadCommit !== registration.upstreamVerification.upstreamHeadCommit ||
    receipt.upstreamBaseCommit !== registration.upstreamBaseCommit ||
    receipt.baselineCommit !== registration.headCommit ||
    receipt.commitSha !== activeChampion.activeCommit
  ) {
    fail();
  }
  if (activeChampion.activeExperiment === 0) {
    if (
      activeChampion.activeCommit !== registration.headCommit ||
      receipt.remoteRef !== `refs/heads/${registration.branch}` ||
      receipt.treeSha !== registration.treeSha ||
      receipt.lockSha256 !== registration.lockSha256
    ) {
      fail();
    }
    return;
  }
  const prefix = activeChampion.activeExperiment.toString().padStart(3, "0");
  if (
    !Number.isSafeInteger(activeChampion.activeExperiment) ||
    activeChampion.activeExperiment < 1 ||
    activeChampion.activeCommit === registration.headCommit ||
    !receipt.remoteRef.startsWith(`refs/heads/df/experiment/${prefix}-`)
  ) {
    fail();
  }
}

export class ArtifactBackedCloudOptimizerAdapterResolver implements CloudOptimizerAdapterResolver {
  readonly #findSource: TrustedGitSourceSnapshotReceiptSource["findByCommit"];
  readonly #locateEvidence: TrustedOptimizerReleasedEvidenceMetadataSource["locate"];
  readonly #readUtf8: TrustedOptimizerResolverArtifactReader["readUtf8"];
  readonly #readReleaseBytes: TrustedOptimizerReleaseArtifactReader["readBytes"];
  readonly #resolveKey: TrustedOptimizerResolverPublicKeyAuthority["resolve"];
  readonly #registration: RepositoryRegistration;
  readonly #bootstrapMetadataArtifact: TrustedCloudArtifactRef;
  readonly #authoritySetHash: string;
  readonly #verificationKeySetHash: string;
  readonly #maximumMetadataBytes: number;
  readonly #maximumEvidenceBytes: number;
  readonly #releaseArtifactInspectionPolicy: OptimizerReleaseArtifactInspectionPolicy;
  readonly #resolved = new Map<string, Readonly<unknown>>();
  readonly #inFlight = new Map<string, Promise<Readonly<unknown>>>();
  readonly #evidenceOwners = new Map<string, string>();
  readonly #inspectedArtifacts = new Map<string, Promise<void>>();

  constructor(options: ArtifactBackedCloudOptimizerAdapterResolverOptions) {
    try {
      if (
        options.sourceIndex.boundary !== "trusted-cloud" ||
        options.evidenceSource.boundary !== "trusted-cloud" ||
        options.artifactReader.boundary !== "trusted-cloud" ||
        options.releaseArtifactReader.boundary !==
          "trusted-cloud-optimizer-release-artifact-reader" ||
        options.keyAuthority.boundary !== "trusted-cloud-optimizer-resolver-public-key-authority" ||
        typeof options.sourceIndex.findByCommit !== "function" ||
        typeof options.evidenceSource.locate !== "function" ||
        typeof options.artifactReader.readUtf8 !== "function" ||
        typeof options.releaseArtifactReader.readBytes !== "function" ||
        typeof options.keyAuthority.resolve !== "function" ||
        !SHA256.test(options.authoritySetHash) ||
        !SHA256.test(options.verificationKeySetHash)
      ) {
        fail();
      }
      const maximumMetadataBytes = options.maximumMetadataBytes ?? MAXIMUM_METADATA_BYTES;
      const maximumEvidenceBytes = options.maximumEvidenceBytes ?? MAXIMUM_EVIDENCE_BYTES;
      if (
        !Number.isSafeInteger(maximumMetadataBytes) ||
        maximumMetadataBytes < 1 ||
        maximumMetadataBytes > MAXIMUM_METADATA_BYTES ||
        !Number.isSafeInteger(maximumEvidenceBytes) ||
        maximumEvidenceBytes < 1 ||
        maximumEvidenceBytes > MAXIMUM_EVIDENCE_BYTES
      ) {
        fail();
      }
      const registration = cloneCanonical(options.registration);
      assertRegistration(registration);
      const releaseArtifactInspectionPolicy = cloneCanonical(
        options.releaseArtifactInspectionPolicy,
      );
      assertOptimizerReleaseArtifactInspectionPolicy(releaseArtifactInspectionPolicy);
      const bootstrapMetadataArtifact = cloneCanonical(options.sourceOnlyBootstrapMetadataArtifact);
      assertArtifact(bootstrapMetadataArtifact, "application/json", maximumMetadataBytes);
      this.#findSource = options.sourceIndex.findByCommit.bind(options.sourceIndex);
      this.#locateEvidence = options.evidenceSource.locate.bind(options.evidenceSource);
      this.#readUtf8 = options.artifactReader.readUtf8.bind(options.artifactReader);
      this.#readReleaseBytes = options.releaseArtifactReader.readBytes.bind(
        options.releaseArtifactReader,
      );
      this.#resolveKey = options.keyAuthority.resolve.bind(options.keyAuthority);
      this.#registration = deepFreezeJson(registration) as RepositoryRegistration;
      this.#bootstrapMetadataArtifact = deepFreezeJson(
        bootstrapMetadataArtifact,
      ) as TrustedCloudArtifactRef;
      this.#authoritySetHash = options.authoritySetHash;
      this.#verificationKeySetHash = options.verificationKeySetHash;
      this.#maximumMetadataBytes = maximumMetadataBytes;
      this.#maximumEvidenceBytes = maximumEvidenceBytes;
      this.#releaseArtifactInspectionPolicy = deepFreezeJson(
        releaseArtifactInspectionPolicy,
      ) as OptimizerReleaseArtifactInspectionPolicy;
    } catch {
      fail();
    }
  }

  async #inspectArtifact(
    artifact: TrustedCloudArtifactRef,
    kind: OptimizerArtifactInspectionKind,
    expectedSourceCommit: string | null,
  ): Promise<void> {
    const frozenArtifact = cloneCanonical(artifact);
    const key = canonicalHash({
      domain: "dark-factory.optimizer-artifact-inspection-cache-key.v1",
      kind,
      artifact: frozenArtifact,
      expectedSourceCommit,
      inspectionPolicyHash: this.#releaseArtifactInspectionPolicy.policyHash,
    });
    const existing = this.#inspectedArtifacts.get(key);
    if (existing !== undefined) {
      await existing;
      return;
    }
    const operation = (async () => {
      const before = canonicalJson(frozenArtifact);
      const maximumBytes = maximumOptimizerArtifactInspectionBytes(kind);
      if (
        frozenArtifact.byteLength > maximumBytes ||
        (kind === "release-evidence-tar" && frozenArtifact.byteLength > this.#maximumEvidenceBytes)
      ) {
        fail();
      }
      const bytes = await this.#readReleaseBytes(frozenArtifact, maximumBytes);
      if (canonicalJson(frozenArtifact) !== before || !(bytes instanceof Uint8Array)) {
        fail();
      }
      assertOptimizerBoundArtifactBytesSafe({
        artifact: frozenArtifact,
        bytes,
        kind,
        policy: this.#releaseArtifactInspectionPolicy,
        expectedSourceCommit,
      });
    })();
    this.#inspectedArtifacts.set(key, operation);
    try {
      await operation;
    } catch {
      fail();
    }
  }

  async #inspectSourceArtifactPair(source: TrustedGitSourceSnapshotReceipt): Promise<void> {
    // Git pack bodies are compressed. Never authorize the bundle from its
    // header scan alone: first inspect the independently materialized source
    // tree whose mandatory PAX comment binds the same signed commit, then
    // require the bundle's sole advertised ref to bind that commit too.
    await this.#inspectArtifact(source.sourceArtifact, "source-tree-tar", source.commitSha);
    await this.#inspectArtifact(source.sourceBundleArtifact, "source-git-bundle", source.commitSha);
  }

  async #verifySignature(
    document: Readonly<Record<string, unknown>>,
    purpose: OptimizerResolverSignaturePurpose,
    keyVersion: string | null,
  ): Promise<void> {
    const signature = document.signature;
    assertSignature(signature);
    const request: OptimizerResolverPublicKeyRequest = {
      schemaVersion: 1,
      domain: "dark-factory.optimizer-resolver-public-key-request.v1",
      purpose,
      keyId: signature.keyId,
      keyVersion,
      signedAt: signature.signedAt,
      documentHash: canonicalHash(document),
      authoritySetHash: this.#authoritySetHash,
      verificationKeySetHash: this.#verificationKeySetHash,
    };
    const authorityInput = cloneCanonical(request);
    const before = canonicalJson(authorityInput);
    const key = await this.#resolveKey(authorityInput);
    if (canonicalJson(authorityInput) !== before || key === undefined) {
      fail();
    }
    assertPublicKey(key, request);
    let publicKey: ReturnType<typeof createPublicKey>;
    try {
      publicKey = createPublicKey({
        key: Buffer.from(key.publicKeySpkiDer),
        format: "der",
        type: "spki",
      });
    } catch {
      fail();
    }
    if (publicKey.asymmetricKeyType !== "ed25519" || !verifyEd25519Signature(document, publicKey)) {
      fail();
    }
  }

  async #readMetadata(
    artifact: TrustedCloudArtifactRef,
  ): Promise<OptimizerReleasedEvidenceMetadata> {
    assertArtifact(artifact, "application/json", this.#maximumMetadataBytes);
    const frozenArtifact = cloneCanonical(artifact);
    const artifactBefore = canonicalJson(frozenArtifact);
    const raw = await this.#readUtf8(frozenArtifact, this.#maximumMetadataBytes);
    if (
      canonicalJson(frozenArtifact) !== artifactBefore ||
      typeof raw !== "string" ||
      Buffer.byteLength(raw, "utf8") !== frozenArtifact.byteLength ||
      sha256(raw) !== frozenArtifact.sha256
    ) {
      fail();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail();
    }
    if (raw !== `${canonicalJson(parsed)}\n`) fail();
    assertMetadataShape(parsed, this.#maximumEvidenceBytes);
    await this.#verifySignature(
      parsed as unknown as Readonly<Record<string, unknown>>,
      signaturePurpose(parsed),
      parsed.keyVersion,
    );
    return deepFreezeJson(cloneCanonical(parsed)) as OptimizerReleasedEvidenceMetadata;
  }

  async #resolveEvidence(
    key: string,
    query: OptimizerReleasedEvidenceQuery | null,
    metadataArtifact: TrustedCloudArtifactRef | null,
    assertBindings: (metadata: OptimizerReleasedEvidenceMetadata) => void,
  ): Promise<Readonly<{ readonly releasedEvidence: TrustedCloudArtifactRef }>> {
    const existing = this.#resolved.get(key);
    if (existing !== undefined) {
      return existing as Readonly<{
        readonly releasedEvidence: TrustedCloudArtifactRef;
      }>;
    }
    const active = this.#inFlight.get(key);
    if (active !== undefined) {
      return (await active) as Readonly<{
        readonly releasedEvidence: TrustedCloudArtifactRef;
      }>;
    }
    const operation = (async () => {
      let exactMetadataArtifact: TrustedCloudArtifactRef;
      if (metadataArtifact !== null) {
        exactMetadataArtifact = cloneCanonical(metadataArtifact);
      } else {
        if (query === null) fail();
        const queryInput = cloneCanonical(query);
        const queryBefore = canonicalJson(queryInput);
        const located = await this.#locateEvidence(queryInput);
        if (
          canonicalJson(queryInput) !== queryBefore ||
          !Array.isArray(located) ||
          located.length !== 1
        ) {
          fail();
        }
        exactMetadataArtifact = cloneCanonical(located[0]);
      }
      const metadata = await this.#readMetadata(exactMetadataArtifact);
      assertBindings(metadata);
      await this.#inspectArtifact(metadata.artifact, "release-evidence-tar", null);
      const owner = this.#evidenceOwners.get(metadata.artifact.sha256);
      if (owner !== undefined && owner !== key) fail();
      this.#evidenceOwners.set(metadata.artifact.sha256, key);
      const result = deepFreezeJson({
        releasedEvidence: cloneCanonical(metadata.artifact),
      });
      this.#resolved.set(key, result);
      return result;
    })().finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, operation);
    return operation;
  }

  public async proposal(input: Parameters<CloudOptimizerAdapterResolver["proposal"]>[0]) {
    try {
      const inputBefore = canonicalJson(input);
      const context = cloneCanonical(input);
      exactKeys(context, [
        "experiment",
        "activeChampion",
        "diagnosticBrief",
        "sourceOnlyBootstrap",
      ]);
      const id = experimentId(context.experiment);
      exactKeys(context.activeChampion, [
        "baselineCommit",
        "activeExperiment",
        "activeCommit",
        "certifiedExperiment",
        "certifiedCommit",
        "updatedAt",
        "sourceSealHash",
      ]);
      if (
        !GIT_OBJECT.test(context.activeChampion.baselineCommit) ||
        !Number.isSafeInteger(context.activeChampion.activeExperiment) ||
        context.activeChampion.activeExperiment < 0 ||
        context.activeChampion.activeExperiment >= context.experiment.number ||
        context.experiment.parentExperiment !== context.activeChampion.activeExperiment ||
        !GIT_OBJECT.test(context.activeChampion.activeCommit) ||
        (context.activeChampion.certifiedExperiment !== null &&
          (!Number.isSafeInteger(context.activeChampion.certifiedExperiment) ||
            context.activeChampion.certifiedExperiment < 0)) ||
        (context.activeChampion.certifiedCommit !== null &&
          !GIT_OBJECT.test(context.activeChampion.certifiedCommit)) ||
        (context.activeChampion.certifiedExperiment === null) !==
          (context.activeChampion.certifiedCommit === null) ||
        timestamp(context.activeChampion.updatedAt) < 0 ||
        !SHA256.test(context.activeChampion.sourceSealHash) ||
        context.sourceOnlyBootstrap !== (context.experiment.number === 1) ||
        context.sourceOnlyBootstrap !== (context.diagnosticBrief === null)
      ) {
        fail();
      }
      const sourceReceipt = await this.#findSource(context.activeChampion.activeCommit);
      if (canonicalJson(input) !== inputBefore || sourceReceipt === undefined) {
        fail();
      }
      const source = cloneCanonical(sourceReceipt);
      assertSourceReceiptShape(source);
      assertSourceBindings(source, this.#registration, context.activeChampion);
      await this.#verifySignature(
        source as unknown as Readonly<Record<string, unknown>>,
        "git-source-snapshot-receipt",
        null,
      );
      await this.#inspectSourceArtifactPair(source);
      if (canonicalJson(input) !== inputBefore) fail();
      const optimizerSource: OptimizerBundleGitSource = {
        mode: "trusted-bundle",
        registrationId: source.registrationId,
        originRepositoryHash: source.originRepositoryHash,
        bundle: cloneCanonical(source.sourceBundleArtifact),
        bundleRef: TRUSTED_GIT_SOURCE_BUNDLE_REF,
        target: {
          remoteRef: TRUSTED_GIT_SOURCE_BUNDLE_REF,
          commitSha: source.commitSha,
          treeSha: source.treeSha,
          lockSha256: source.lockSha256,
        },
      };

      let evidence: Readonly<{
        readonly releasedEvidence: TrustedCloudArtifactRef;
      }>;
      if (context.sourceOnlyBootstrap) {
        const key = `bootstrap:${canonicalHash({
          campaignId: context.experiment.lineageId,
          experimentId: id,
          sourceCommit: source.commitSha,
        })}`;
        evidence = await this.#resolveEvidence(
          key,
          null,
          this.#bootstrapMetadataArtifact,
          (metadata) => {
            if (metadata.purpose !== "source-only-bootstrap") fail();
          },
        );
      } else {
        if (context.diagnosticBrief === null) fail();
        exactKeys(context.diagnosticBrief, ["hash", "releaseId", "actionable"]);
        if (
          !SHA256.test(context.diagnosticBrief.hash) ||
          !SAFE_RELEASE_ID.test(context.diagnosticBrief.releaseId) ||
          typeof context.diagnosticBrief.actionable !== "boolean"
        ) {
          fail();
        }
        const unsigned = {
          schemaVersion: 1 as const,
          domain: "dark-factory.optimizer-proposal-evidence-query.v1" as const,
          purpose: "proposal-diagnostic" as const,
          campaignId: context.experiment.lineageId,
          experimentId: id,
          diagnosticHash: context.diagnosticBrief.hash,
          releaseId: context.diagnosticBrief.releaseId,
          actionable: context.diagnosticBrief.actionable,
        };
        const query: OptimizerProposalDiagnosticEvidenceQuery = {
          ...unsigned,
          queryHash: canonicalHash(unsigned),
        };
        evidence = await this.#resolveEvidence(
          `proposal:${query.queryHash}`,
          query,
          null,
          (metadata) => {
            if (
              metadata.purpose !== "proposal-diagnostic" ||
              metadata.campaignId !== query.campaignId ||
              metadata.experimentId !== query.experimentId ||
              metadata.diagnosticHash !== query.diagnosticHash ||
              metadata.releaseId !== query.releaseId ||
              metadata.actionable !== query.actionable
            ) {
              fail();
            }
          },
        );
      }
      if (canonicalJson(input) !== inputBefore) fail();
      return deepFreezeJson({
        source: optimizerSource,
        releasedEvidence: evidence.releasedEvidence,
      }) as {
        readonly source: OptimizerBundleGitSource;
        readonly releasedEvidence: TrustedCloudArtifactRef;
      };
    } catch {
      fail();
    }
  }

  public async analysis(input: Parameters<CloudOptimizerAdapterResolver["analysis"]>[0]) {
    try {
      const inputBefore = canonicalJson(input);
      const captured = cloneCanonical(input);
      exactKeys(captured, ["experiment", "hypothesis", "candidate", "repair", "validation"]);
      const id = experimentId(captured.experiment);
      exactKeys(captured.hypothesis, [
        "hash",
        "sourceBriefHash",
        "causalClaim",
        "intervention",
        "predictedRepairBehavior",
        "predictedFreshEffect",
        "falsificationCriteria",
        "rollbackCondition",
      ]);
      exactKeys(captured.candidate, ["commit", "patchHash", "changedFiles", "mutationCategory"]);
      if (
        !SHA256.test(captured.hypothesis.hash) ||
        !GIT_OBJECT.test(captured.candidate.commit) ||
        !SHA256.test(captured.candidate.patchHash)
      ) {
        fail();
      }
      if (captured.repair !== null) {
        exactKeys(captured.repair, [
          "disposition",
          "attemptOrdinal",
          "integrityPassed",
          "cacheStatus",
          "aggregateCostUsd",
          "tokens",
          "wallTimeMs",
          "attempts",
          "attestationHash",
        ]);
      }
      if (captured.validation !== null) {
        exactKeys(captured.validation, [
          "disposition",
          "validPairs",
          "validArms",
          "replacementAttempts",
          "probabilityPositive",
          "medianAccuracyDelta",
          "requiredPosteriorProbability",
          "onlineGateAuthorized",
          "onlineErrorBudget",
          "stratumRegressionVeto",
          "integrityVeto",
          "correctnessVeto",
          "capabilityVeto",
          "costWithinGuardrail",
          "latencyWithinGuardrail",
          "accuracyTradeoffPredeclared",
          "aggregateCostUsd",
          "tokens",
          "wallTimeMs",
          "attestationHash",
          "releasedEvidenceHash",
          "behavioralSourceCommitmentHash",
          "attemptAccounting",
        ]);
      }
      const repairAttestationHash = captured.repair?.attestationHash ?? null;
      const validationAttestationHash = captured.validation?.attestationHash ?? null;
      const releasedEvidenceHash = captured.validation?.releasedEvidenceHash ?? null;
      if (
        (repairAttestationHash !== null && !SHA256.test(repairAttestationHash)) ||
        (validationAttestationHash !== null && !SHA256.test(validationAttestationHash)) ||
        (releasedEvidenceHash !== null && !SHA256.test(releasedEvidenceHash))
      ) {
        fail();
      }
      const unsigned = {
        schemaVersion: 1 as const,
        domain: "dark-factory.optimizer-analysis-evidence-query.v1" as const,
        purpose: "analysis" as const,
        campaignId: captured.experiment.lineageId,
        experimentId: id,
        hypothesisHash: captured.hypothesis.hash,
        hypothesisDocumentHash: canonicalHash(captured.hypothesis),
        candidateCommit: captured.candidate.commit,
        candidatePatchHash: captured.candidate.patchHash,
        candidateDocumentHash: canonicalHash(captured.candidate),
        repairAttestationHash,
        validationAttestationHash,
        releasedEvidenceHash,
      };
      const query: OptimizerAnalysisEvidenceQuery = {
        ...unsigned,
        queryHash: canonicalHash(unsigned),
      };
      const evidence = await this.#resolveEvidence(
        `analysis:${query.queryHash}`,
        query,
        null,
        (metadata) => {
          if (
            metadata.purpose !== "analysis" ||
            metadata.campaignId !== query.campaignId ||
            metadata.experimentId !== query.experimentId ||
            metadata.hypothesisHash !== query.hypothesisHash ||
            metadata.hypothesisDocumentHash !== query.hypothesisDocumentHash ||
            metadata.candidateCommit !== query.candidateCommit ||
            metadata.candidatePatchHash !== query.candidatePatchHash ||
            metadata.candidateDocumentHash !== query.candidateDocumentHash ||
            metadata.repairAttestationHash !== query.repairAttestationHash ||
            metadata.validationAttestationHash !== query.validationAttestationHash ||
            metadata.releasedEvidenceHash !== query.releasedEvidenceHash
          ) {
            fail();
          }
        },
      );
      if (canonicalJson(input) !== inputBefore) fail();
      return evidence;
    } catch {
      fail();
    }
  }
}
