import type { KeyLike } from "node:crypto";

import type { TrustedCloudArtifactRef } from "../cloud/types.js";
import type { ExperimentIdentity } from "../domain/models.js";
import { verifyEd25519Signature } from "../evidence/signatures.js";
import type { TrustedCandidateRuntimeBuildReceipt } from "../harness/candidate-build-runner.js";
import type { TrustedGitPublicationReceipt } from "../harness/git-publication.js";
import {
  TRUSTED_GIT_SOURCE_BUNDLE_REF,
  type TrustedGitSourceSnapshotReceipt,
} from "../harness/git-source.js";
import {
  INTEGRITY_VIOLATION_CODES,
  type IntegrityViolationCode,
} from "../integrity/candidate-scanner.js";
import type {
  CloudOptimizerProposalResult,
  CloudOptimizerSessionRecordStore,
} from "../optimizer/cloud-session.js";
import {
  canonicalHash,
  canonicalJson,
  computeContentHash,
  withContentHash,
} from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import type {
  CorrectnessGateRunner,
  FrozenCandidate,
  FrozenHypothesis,
  GateResult,
} from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_MUTATION_CATEGORY = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SAFE_SOURCE_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const SAFE_HEAD_REF =
  /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u;
const SAFE_IMAGE_REFERENCE =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,446}@sha256:[a-f0-9]{64}$/u;
const SAFE_SIGNATURE = /^[A-Za-z0-9_-]{86,128}$/u;
const MAXIMUM_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const MAXIMUM_COST_USD = 1_000_000;
const MAXIMUM_TOKENS = 10_000_000_000;
const MAXIMUM_WALL_TIME_MS = 30 * 24 * 60 * 60_000;

export const CORRECTNESS_GATE_OPERATIONS = [
  "integrity-scan",
  "candidate-build",
  "git-publication",
  "source-snapshot",
  "source-index",
] as const;

export type CorrectnessGateOperation =
  (typeof CORRECTNESS_GATE_OPERATIONS)[number];

export const PRODUCTION_CORRECTNESS_GATE_ERROR_CODES = [
  "INVALID_CONFIGURATION",
  "PROPOSAL_NOT_FOUND",
  "PROPOSAL_DETACHED",
  "GATE_RECORD_INVALID",
  "INTEGRITY_SCAN_FAILED",
  "CANDIDATE_BUILD_FAILED",
  "GIT_PUBLICATION_FAILED",
  "SOURCE_SNAPSHOT_FAILED",
  "SOURCE_INDEX_FAILED",
] as const;

export type ProductionCorrectnessGateErrorCode =
  (typeof PRODUCTION_CORRECTNESS_GATE_ERROR_CODES)[number];

/**
 * Intentionally carries only a stable release-safe code. Provider errors,
 * repository URLs, changed source lines, and scanner evidence stay inside
 * their trusted cloud boundary.
 */
export class ProductionCorrectnessGateError extends Error {
  override readonly name = "ProductionCorrectnessGateError";
  readonly code: ProductionCorrectnessGateErrorCode;

  constructor(code: ProductionCorrectnessGateErrorCode) {
    super("Production correctness gate failed closed.");
    this.code = code;
  }
}

export interface CorrectnessGateOperationAccounting {
  readonly schemaVersion: 1;
  readonly sensitivity: "release-safe-correctness-gate-accounting";
  readonly operation: CorrectnessGateOperation;
  readonly receiptHash: string;
  readonly aggregateCostUsd: number;
  readonly tokens: number;
  readonly wallTimeMs: number;
  readonly containsTaskIdentifiers: false;
  /**
   * Produced by the trusted operation boundary. The coordinator never creates
   * an attestation or holds a signing key.
   */
  readonly accountingAttestationHash: string;
}

export interface AccountedCorrectnessGateReceipt<Receipt> {
  readonly receipt: Receipt;
  readonly accounting: CorrectnessGateOperationAccounting;
}

/**
 * Release-safe view of the trusted cloud scan. Raw diff bytes, matching
 * fragments, source lines, paths, task IDs, and grader data are forbidden.
 */
export interface TrustedCloudIntegrityScanReceipt {
  readonly schemaVersion: 2;
  readonly sensitivity: "release-safe-candidate-integrity-scan";
  readonly scanId: string;
  readonly experimentId: string;
  readonly protocolHash: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly lockSha256: string;
  readonly hypothesisHash: string;
  readonly hypothesisDocumentHash: string;
  readonly candidateDocumentHash: string;
  readonly diffSha256: string;
  readonly changedFilesHash: string;
  readonly candidateBundleSha256: string;
  readonly evidenceManifestSha256: string;
  readonly evidenceDiffSha256: string;
  readonly observedChangedFilesHash: string;
  readonly lineCountsHash: string;
  readonly fileModesHash: string;
  readonly fragmentCatalogHash: string;
  readonly workerSha256: string;
  readonly executionReceiptHash: string;
  readonly integrityPolicyHash: string;
  readonly passed: boolean;
  readonly violationCodes: readonly IntegrityViolationCode[];
  readonly containsTaskIdentifiers: false;
  readonly scannedAt: string;
  readonly scanAttestationHash: string;
  readonly signature: Signature;
}

export interface TrustedCloudIntegrityScanInput {
  readonly experiment: ExperimentIdentity;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly lockSha256: string;
  readonly hypothesisHash: string;
  readonly hypothesisDocumentHash: string;
  readonly candidateDocumentHash: string;
  readonly changedFiles: readonly string[];
  readonly candidateBundle: TrustedCloudArtifactRef;
  readonly candidateDiff: TrustedCloudArtifactRef;
  readonly integrityPolicyHash: string;
}

export interface TrustedCloudIntegrityScanReceiptVerifier {
  readonly trustedKeyId: string;
  readonly publicKey: KeyLike;
}

export interface TrustedCloudIntegrityScanPort {
  readonly boundary: "trusted-cloud";
  /**
   * Implementations read the immutable diff through a verifying artifact
   * bridge, execute the frozen scanner in a cloud sandbox, retain raw findings
   * inside the trusted boundary, and attest only the release-safe receipt.
   */
  scan(
    input: TrustedCloudIntegrityScanInput,
  ): Promise<
    AccountedCorrectnessGateReceipt<TrustedCloudIntegrityScanReceipt>
  >;
}

export interface TrustedCloudCandidateBuildInput {
  readonly experiment: ExperimentIdentity;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly lockSha256: string;
  readonly candidateBundle: TrustedCloudArtifactRef;
  readonly bundleRef: string;
  readonly diffSha256: string;
  readonly changedFilesHash: string;
  readonly integrityScanReceiptHash: string;
  readonly buildPolicyHash: string;
}

export interface TrustedCandidateBuildRejectionReceipt {
  readonly schemaVersion: 1;
  readonly sensitivity: "release-safe-candidate-build-rejection";
  readonly rejectionId: string;
  readonly experimentId: string;
  readonly protocolHash: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly lockSha256: string;
  readonly buildPolicyHash: string;
  readonly failureCode: "CLOUD_BUILD_GATE_REJECTED";
  readonly containsTaskIdentifiers: false;
  readonly rejectedAt: string;
  readonly buildAttestationHash: string;
}

export type TrustedCandidateBuildGateReceipt =
  | TrustedCandidateRuntimeBuildReceipt
  | TrustedCandidateBuildRejectionReceipt;

export interface TrustedCloudCandidateBuildPort {
  readonly boundary: "trusted-cloud";
  /**
   * Implementations must use the cloud-only candidate build runner (or an
   * equivalently strict implementation) and return only a receipt whose
   * signature and runtime artifact have already been verified.
   */
  build(
    input: TrustedCloudCandidateBuildInput,
  ): Promise<
    AccountedCorrectnessGateReceipt<TrustedCandidateBuildGateReceipt>
  >;
}

export interface TrustedNonForceGitPublicationInput {
  readonly experiment: ExperimentIdentity;
  readonly registrationId: string;
  readonly originRepositoryHash: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly lockSha256: string;
  readonly candidateBundle: TrustedCloudArtifactRef;
  readonly bundleRef: string;
  readonly integrityScanReceiptHash: string;
  readonly buildReceiptHash: string;
}

export interface TrustedNonForceGitPublicationPort {
  readonly boundary: "trusted-cloud";
  /**
   * Implementations must obtain a short-lived signed authorization and invoke
   * TrustedGitPublicationRunner. Force pushes and mutable-tag replacement are
   * not part of this port.
   */
  publish(
    input: TrustedNonForceGitPublicationInput,
  ): Promise<AccountedCorrectnessGateReceipt<TrustedGitPublicationReceipt>>;
}

export interface TrustedCandidateSourceSnapshotInput {
  readonly experiment: ExperimentIdentity;
  readonly publication: TrustedGitPublicationReceipt;
  readonly publicationReceiptHash: string;
}

export interface TrustedCandidateSourceSnapshotPort {
  readonly boundary: "trusted-cloud";
  /**
   * Implementations invoke the trusted Git source runner against the exact
   * non-force branch established by the publication receipt.
   */
  snapshot(
    input: TrustedCandidateSourceSnapshotInput,
  ): Promise<
    AccountedCorrectnessGateReceipt<TrustedGitSourceSnapshotReceipt>
  >;
}

export interface TrustedCandidateSourceIndexReceipt {
  readonly schemaVersion: 2;
  readonly sensitivity: "release-safe-candidate-source-index";
  readonly indexId: string;
  readonly experimentId: string;
  readonly protocolHash: string;
  readonly registrationId: string;
  readonly originRepositoryHash: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly lockSha256: string;
  readonly sourceArtifactSha256: string;
  readonly sourceBundleArtifactSha256: string;
  readonly snapshotReceiptHash: string;
  readonly indexedAt: string;
  readonly containsTaskIdentifiers: false;
  /**
   * Supplied by the durable trusted index implementation. The gate only binds
   * it; it never fabricates storage/KMS attestations.
   */
  readonly indexAttestationHash: string;
}

export interface TrustedCandidateSourceIndexPort {
  readonly boundary: "trusted-cloud";
  readonly durability: "linearizable";
  index(input: {
    readonly experiment: ExperimentIdentity;
    readonly snapshot: TrustedGitSourceSnapshotReceipt;
    readonly snapshotReceiptHash: string;
  }): Promise<
    AccountedCorrectnessGateReceipt<TrustedCandidateSourceIndexReceipt>
  >;
  /**
   * This is the same commit-keyed index consumed by the blind broker's
   * TrustedGitSourceSnapshotReceiptSource adapter.
   */
  findByCommit(
    candidateCommit: string,
  ): Promise<TrustedGitSourceSnapshotReceipt | undefined>;
}

export interface CorrectnessGateRecord {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.production-correctness-gate.v1";
  readonly experiment: ExperimentIdentity;
  readonly requestHash: string;
  readonly proposalResultHash: string;
  readonly integrityScan: AccountedCorrectnessGateReceipt<TrustedCloudIntegrityScanReceipt>;
  readonly candidateBuild:
    | AccountedCorrectnessGateReceipt<TrustedCandidateBuildGateReceipt>
    | null;
  readonly gitPublication: AccountedCorrectnessGateReceipt<TrustedGitPublicationReceipt> | null;
  readonly sourceSnapshot: AccountedCorrectnessGateReceipt<TrustedGitSourceSnapshotReceipt> | null;
  readonly sourceIndex: AccountedCorrectnessGateReceipt<TrustedCandidateSourceIndexReceipt> | null;
  readonly result: GateResult;
  readonly contentHash: string;
}

export interface CorrectnessGateRecordStore {
  readonly boundary: "trusted-cloud-durable";
  /**
   * Immutable and idempotent by exact experiment identity. A different record
   * at the same identity must be rejected atomically.
   */
  put(record: CorrectnessGateRecord): Promise<void>;
  get(experiment: ExperimentIdentity): Promise<CorrectnessGateRecord | null>;
}

export interface ProductionCorrectnessGateOptions {
  readonly optimizerRecords: CloudOptimizerSessionRecordStore;
  readonly records: CorrectnessGateRecordStore;
  readonly scanner: TrustedCloudIntegrityScanPort;
  readonly builder: TrustedCloudCandidateBuildPort;
  readonly publisher: TrustedNonForceGitPublicationPort;
  readonly snapshotter: TrustedCandidateSourceSnapshotPort;
  readonly sourceIndex: TrustedCandidateSourceIndexPort;
  readonly integrityReceiptVerifier: TrustedCloudIntegrityScanReceiptVerifier;
  readonly integrityPolicyHash: string;
  readonly integrityWorkerSha256: string;
  readonly fragmentCatalogHash: string;
  readonly buildPolicyHash: string;
}

interface ProposalBinding {
  readonly result: CloudOptimizerProposalResult;
  readonly experimentId: string;
  readonly requestHash: string;
  readonly proposalResultHash: string;
  readonly hypothesisDocumentHash: string;
  readonly candidateDocumentHash: string;
  readonly changedFilesHash: string;
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

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    throw new ProductionCorrectnessGateError("GATE_RECORD_INVALID");
  }
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  ) {
    throw new ProductionCorrectnessGateError("GATE_RECORD_INVALID");
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function cloneJson<Value>(value: Value): Value {
  return JSON.parse(canonicalJson(value)) as Value;
}

function experimentId(experiment: ExperimentIdentity): string {
  assertExactKeys(experiment, [
    "number",
    "slug",
    "kind",
    "parentExperiment",
    "lineageId",
    "protocolHash",
  ]);
  if (
    !Number.isSafeInteger(experiment.number) ||
    experiment.number < 1 ||
    !SAFE_SLUG.test(experiment.slug) ||
    !["optimization", "shadow"].includes(experiment.kind) ||
    (experiment.parentExperiment !== null &&
      (!Number.isSafeInteger(experiment.parentExperiment) ||
        experiment.parentExperiment < 0 ||
        experiment.parentExperiment >= experiment.number)) ||
    !SAFE_ID.test(experiment.lineageId) ||
    !SHA256.test(experiment.protocolHash)
  ) {
    throw new ProductionCorrectnessGateError("PROPOSAL_DETACHED");
  }
  const id = `${String(experiment.number).padStart(3, "0")}-${experiment.slug}`;
  if (!SAFE_ID.test(id)) {
    throw new ProductionCorrectnessGateError("PROPOSAL_DETACHED");
  }
  return id;
}

function assertArtifact(
  artifact: unknown,
  mediaType: string,
): asserts artifact is TrustedCloudArtifactRef {
  assertExactKeys(artifact, ["uri", "sha256", "mediaType", "byteLength"]);
  const value = artifact as unknown as TrustedCloudArtifactRef;
  if (
    !/^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(
      value.uri,
    ) ||
    value.uri.includes("..") ||
    !SHA256.test(value.sha256) ||
    value.mediaType !== mediaType ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > MAXIMUM_ARTIFACT_BYTES
  ) {
    throw new ProductionCorrectnessGateError("PROPOSAL_DETACHED");
  }
}

function assertFrozenHypothesis(
  value: unknown,
): asserts value is FrozenHypothesis {
  assertExactKeys(value, [
    "hash",
    "sourceBriefHash",
    "causalClaim",
    "intervention",
    "predictedRepairBehavior",
    "predictedFreshEffect",
    "falsificationCriteria",
    "rollbackCondition",
  ]);
  const hypothesis = value as unknown as FrozenHypothesis;
  const boundedText = [
    hypothesis.causalClaim,
    hypothesis.intervention,
    hypothesis.predictedRepairBehavior,
    hypothesis.predictedFreshEffect,
    hypothesis.rollbackCondition,
  ];
  if (
    !SHA256.test(hypothesis.hash) ||
    (hypothesis.sourceBriefHash !== null &&
      !SHA256.test(hypothesis.sourceBriefHash)) ||
    boundedText.some(
      (item) =>
        typeof item !== "string" ||
        item.length < 1 ||
        item.length > 16_384,
    ) ||
    !Array.isArray(hypothesis.falsificationCriteria) ||
    hypothesis.falsificationCriteria.length < 1 ||
    hypothesis.falsificationCriteria.length > 32 ||
    hypothesis.falsificationCriteria.some(
      (item) =>
        typeof item !== "string" || item.length < 1 || item.length > 4_096,
    )
  ) {
    throw new ProductionCorrectnessGateError("PROPOSAL_DETACHED");
  }
}

function assertFrozenCandidate(
  value: unknown,
): asserts value is FrozenCandidate {
  assertExactKeys(value, [
    "commit",
    "patchHash",
    "changedFiles",
    "mutationCategory",
  ]);
  const candidate = value as unknown as FrozenCandidate;
  if (
    !GIT_OBJECT_ID.test(candidate.commit) ||
    !SHA256.test(candidate.patchHash) ||
    !SAFE_MUTATION_CATEGORY.test(candidate.mutationCategory) ||
    !Array.isArray(candidate.changedFiles) ||
    candidate.changedFiles.length < 1 ||
    candidate.changedFiles.length > 12 ||
    new Set(candidate.changedFiles).size !== candidate.changedFiles.length ||
    candidate.changedFiles.some(
      (path) =>
        typeof path !== "string" ||
        path.length > 512 ||
        !SAFE_SOURCE_PATH.test(path) ||
        path.includes("\\") ||
        path.includes("\0"),
    )
  ) {
    throw new ProductionCorrectnessGateError("PROPOSAL_DETACHED");
  }
}

function assertContentHashedRecord(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  assertExactKeys(value, expectedKeys);
  const contentHash = value["contentHash"];
  if (
    typeof contentHash !== "string" ||
    !SHA256.test(contentHash) ||
    contentHash !== computeContentHash(value)
  ) {
    throw new ProductionCorrectnessGateError("PROPOSAL_DETACHED");
  }
}

function assertProposalBinding(
  result: CloudOptimizerProposalResult,
  experiment: ExperimentIdentity,
  hypothesis: FrozenHypothesis,
  candidate: FrozenCandidate,
  expectedIntegrityPolicyHash: string,
): ProposalBinding {
  const id = experimentId(experiment);
  assertExactKeys(result, [
    "proposal",
    "setup",
    "claude",
    "seal",
    "candidateBundle",
    "candidateDiff",
    "sessionState",
    "setupManifestArtifact",
    "claudeManifestArtifact",
    "sealManifestArtifact",
    "executionReceipts",
  ]);
  assertExactKeys(result.proposal, ["hypothesis", "candidate"]);
  assertFrozenHypothesis(result.proposal.hypothesis);
  assertFrozenCandidate(result.proposal.candidate);
  assertFrozenHypothesis(hypothesis);
  assertFrozenCandidate(candidate);
  assertContentHashedRecord(result.setup, [
    "schemaVersion",
    "domain",
    "phase",
    "campaignId",
    "experimentId",
    "sourceMode",
    "registrationId",
    "originRepositoryHash",
    "sourceCommit",
    "sourceTree",
    "lockSha256",
    "pluginArchiveSha256",
    "evidenceArchiveSha256",
    "inputStateSha256",
    "contentHash",
  ]);
  assertContentHashedRecord(result.seal, [
    "schemaVersion",
    "domain",
    "campaignId",
    "experimentId",
    "sourceCommit",
    "candidateCommit",
    "candidateTree",
    "lockSha256",
    "bundleRef",
    "hypothesis",
    "candidate",
    "hypothesisReceiptId",
    "candidateReceiptId",
    "integrityPolicyHash",
    "bundle",
    "diff",
    "state",
    "contentHash",
  ]);
  assertExactKeys(result.seal.bundle, ["sha256", "byteLength"]);
  assertExactKeys(result.seal.diff, ["sha256", "byteLength"]);
  assertExactKeys(result.seal.state, ["sha256", "byteLength"]);
  assertArtifact(
    result.candidateBundle,
    "application/vnd.git.bundle",
  );
  assertArtifact(result.candidateDiff, "text/x-diff");
  assertArtifact(result.sessionState, "application/x-tar");
  assertArtifact(result.setupManifestArtifact, "application/json");
  assertArtifact(result.claudeManifestArtifact, "application/json");
  assertArtifact(result.sealManifestArtifact, "application/json");

  const proposalHypothesisHash = canonicalHash(
    result.proposal.hypothesis,
  );
  const proposalCandidateHash = canonicalHash(result.proposal.candidate);
  const requestHypothesisHash = canonicalHash(hypothesis);
  const requestCandidateHash = canonicalHash(candidate);
  const expectedBundleRef = `refs/heads/df/bundle/${id}`;
  if (
    result.setup.schemaVersion !== 1 ||
    result.setup.domain !== "dark-factory.optimizer-setup.v1" ||
    result.setup.phase !== "proposal" ||
    result.setup.campaignId !== experiment.lineageId ||
    result.setup.experimentId !== id ||
    !["private-github", "trusted-bundle"].includes(
      result.setup.sourceMode,
    ) ||
    !SHA256.test(result.setup.registrationId) ||
    !SHA256.test(result.setup.originRepositoryHash) ||
    !GIT_OBJECT_ID.test(result.setup.sourceCommit) ||
    !GIT_OBJECT_ID.test(result.setup.sourceTree) ||
    !SHA256.test(result.setup.lockSha256) ||
    result.setup.inputStateSha256 !== null ||
    result.seal.schemaVersion !== 1 ||
    result.seal.domain !== "dark-factory.optimizer-proposal.v1" ||
    result.seal.campaignId !== experiment.lineageId ||
    result.seal.experimentId !== id ||
    result.seal.sourceCommit !== result.setup.sourceCommit ||
    result.seal.candidateCommit !== candidate.commit ||
    result.seal.candidateTree === result.setup.sourceTree ||
    !GIT_OBJECT_ID.test(result.seal.candidateTree) ||
    result.seal.lockSha256 !== result.setup.lockSha256 ||
    result.seal.bundleRef !== expectedBundleRef ||
    result.seal.integrityPolicyHash !== expectedIntegrityPolicyHash ||
    candidate.commit === result.setup.sourceCommit ||
    candidate.patchHash !== result.candidateDiff.sha256 ||
    result.candidateBundle.sha256 !== result.seal.bundle.sha256 ||
    result.candidateBundle.byteLength !== result.seal.bundle.byteLength ||
    result.candidateDiff.sha256 !== result.seal.diff.sha256 ||
    result.candidateDiff.byteLength !== result.seal.diff.byteLength ||
    result.sessionState.sha256 !== result.seal.state.sha256 ||
    result.sessionState.byteLength !== result.seal.state.byteLength ||
    proposalHypothesisHash !== requestHypothesisHash ||
    proposalCandidateHash !== requestCandidateHash ||
    canonicalHash(result.seal.hypothesis) !== requestHypothesisHash ||
    canonicalHash(result.seal.candidate) !== requestCandidateHash
  ) {
    throw new ProductionCorrectnessGateError("PROPOSAL_DETACHED");
  }

  const requestHash = canonicalHash({
    experiment,
    hypothesis,
    candidate,
  });
  return {
    result,
    experimentId: id,
    requestHash,
    proposalResultHash: canonicalHash(result),
    hypothesisDocumentHash: requestHypothesisHash,
    candidateDocumentHash: requestCandidateHash,
    changedFilesHash: canonicalHash(candidate.changedFiles),
  };
}

function assertAccounting<Receipt>(
  value: unknown,
  operation: CorrectnessGateOperation,
  receipt: Receipt,
): asserts value is CorrectnessGateOperationAccounting {
  assertExactKeys(value, [
    "schemaVersion",
    "sensitivity",
    "operation",
    "receiptHash",
    "aggregateCostUsd",
    "tokens",
    "wallTimeMs",
    "containsTaskIdentifiers",
    "accountingAttestationHash",
  ]);
  const accounting = value as unknown as CorrectnessGateOperationAccounting;
  if (
    accounting.schemaVersion !== 1 ||
    accounting.sensitivity !==
      "release-safe-correctness-gate-accounting" ||
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
    throw new ProductionCorrectnessGateError("GATE_RECORD_INVALID");
  }
}

function expectedScanId(
  binding: ProposalBinding,
  experiment: ExperimentIdentity,
  integrityPolicyHash: string,
  integrityWorkerSha256: string,
  fragmentCatalogHash: string,
): string {
  return `scan-${canonicalHash({
    experimentId: binding.experimentId,
    protocolHash: experiment.protocolHash,
    sourceCommit: binding.result.setup.sourceCommit,
    sourceTree: binding.result.setup.sourceTree,
    candidateCommit: binding.result.seal.candidateCommit,
    candidateTree: binding.result.seal.candidateTree,
    lockSha256: binding.result.seal.lockSha256,
    hypothesisDocumentHash: binding.hypothesisDocumentHash,
    candidateDocumentHash: binding.candidateDocumentHash,
    diffSha256: binding.result.candidateDiff.sha256,
    changedFilesHash: binding.changedFilesHash,
    candidateBundleSha256: binding.result.candidateBundle.sha256,
    integrityWorkerSha256,
    fragmentCatalogHash,
    integrityPolicyHash,
  }).slice(0, 48)}`;
}

export function trustedCloudIntegrityScanAttestationHash(
  receipt:
    | TrustedCloudIntegrityScanReceipt
    | Omit<
        TrustedCloudIntegrityScanReceipt,
        "scanAttestationHash" | "signature"
      >,
): string {
  const record = receipt as unknown as Readonly<
    Record<string, unknown>
  >;
  const attested: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== "scanAttestationHash" && key !== "signature") {
      attested[key] = value;
    }
  }
  return canonicalHash(attested);
}

function assertSignature(value: unknown): void {
  assertExactKeys(value, [
    "algorithm",
    "keyId",
    "signedAt",
    "signature",
  ]);
  const signature = value as unknown as {
    readonly algorithm: unknown;
    readonly keyId: unknown;
    readonly signedAt: unknown;
    readonly signature: unknown;
  };
  if (
    signature.algorithm !== "ed25519" ||
    typeof signature.keyId !== "string" ||
    !SAFE_ID.test(signature.keyId) ||
    !isCanonicalTimestamp(signature.signedAt) ||
    typeof signature.signature !== "string" ||
    !SAFE_SIGNATURE.test(signature.signature)
  ) {
    throw new ProductionCorrectnessGateError("GATE_RECORD_INVALID");
  }
}

function assertIntegrityScanReceipt(
  value: unknown,
  binding: ProposalBinding,
  experiment: ExperimentIdentity,
  integrityPolicyHash: string,
  integrityWorkerSha256: string,
  fragmentCatalogHash: string,
  verifier: TrustedCloudIntegrityScanReceiptVerifier,
): asserts value is TrustedCloudIntegrityScanReceipt {
  assertExactKeys(value, [
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
  ]);
  const receipt = value as unknown as TrustedCloudIntegrityScanReceipt;
  const violationCodes = new Set<IntegrityViolationCode>(
    INTEGRITY_VIOLATION_CODES,
  );
  if (
    receipt.schemaVersion !== 2 ||
    receipt.sensitivity !==
      "release-safe-candidate-integrity-scan" ||
    receipt.scanId !==
      expectedScanId(
        binding,
        experiment,
        integrityPolicyHash,
        integrityWorkerSha256,
        fragmentCatalogHash,
      ) ||
    receipt.experimentId !== binding.experimentId ||
    receipt.protocolHash !== experiment.protocolHash ||
    receipt.sourceCommit !== binding.result.setup.sourceCommit ||
    receipt.sourceTree !== binding.result.setup.sourceTree ||
    receipt.candidateCommit !== binding.result.seal.candidateCommit ||
    receipt.candidateTree !== binding.result.seal.candidateTree ||
    receipt.lockSha256 !== binding.result.seal.lockSha256 ||
    receipt.hypothesisHash !==
      binding.result.proposal.hypothesis.hash ||
    receipt.hypothesisDocumentHash !==
      binding.hypothesisDocumentHash ||
    receipt.candidateDocumentHash !== binding.candidateDocumentHash ||
    receipt.diffSha256 !== binding.result.candidateDiff.sha256 ||
    receipt.changedFilesHash !== binding.changedFilesHash ||
    receipt.candidateBundleSha256 !==
      binding.result.candidateBundle.sha256 ||
    !SHA256.test(receipt.evidenceManifestSha256) ||
    !SHA256.test(receipt.evidenceDiffSha256) ||
    !SHA256.test(receipt.observedChangedFilesHash) ||
    !SHA256.test(receipt.lineCountsHash) ||
    !SHA256.test(receipt.fileModesHash) ||
    receipt.fragmentCatalogHash !== fragmentCatalogHash ||
    receipt.workerSha256 !== integrityWorkerSha256 ||
    !SHA256.test(receipt.executionReceiptHash) ||
    receipt.integrityPolicyHash !== integrityPolicyHash ||
    typeof receipt.passed !== "boolean" ||
    !Array.isArray(receipt.violationCodes) ||
    new Set(receipt.violationCodes).size !== receipt.violationCodes.length ||
    receipt.violationCodes.some((code) => !violationCodes.has(code)) ||
    receipt.violationCodes.some(
      (code, index) => {
        const previous = receipt.violationCodes[index - 1];
        return (
          previous !== undefined && previous.localeCompare(code) >= 0
        );
      },
    ) ||
    receipt.passed !== (receipt.violationCodes.length === 0) ||
    (receipt.passed &&
      (receipt.evidenceDiffSha256 !== receipt.diffSha256 ||
        receipt.observedChangedFilesHash !==
          receipt.changedFilesHash)) ||
    receipt.containsTaskIdentifiers !== false ||
    !isCanonicalTimestamp(receipt.scannedAt) ||
    receipt.scanAttestationHash !==
      trustedCloudIntegrityScanAttestationHash(receipt)
  ) {
    throw new ProductionCorrectnessGateError("INTEGRITY_SCAN_FAILED");
  }
  assertSignature(receipt.signature);
  if (
    receipt.signature.keyId !== verifier.trustedKeyId ||
    Date.parse(receipt.signature.signedAt) <
      Date.parse(receipt.scannedAt) ||
    !verifyEd25519Signature(
      receipt as unknown as Readonly<Record<string, unknown>>,
      verifier.publicKey,
    )
  ) {
    throw new ProductionCorrectnessGateError("INTEGRITY_SCAN_FAILED");
  }
}

function assertBuildReceipt(
  value: unknown,
  binding: ProposalBinding,
  buildPolicyHash: string,
): asserts value is TrustedCandidateRuntimeBuildReceipt {
  assertExactKeys(value, [
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
  ]);
  const receipt = value as unknown as TrustedCandidateRuntimeBuildReceipt;
  assertArtifact(receipt.runtimeArtifact, "application/x-tar");
  assertSignature(receipt.signature);
  if (
    receipt.sensitivity !== "trusted-candidate-runtime-build" ||
    receipt.schemaVersion !== 1 ||
    !SAFE_ID.test(receipt.buildId) ||
    receipt.experimentId !== binding.experimentId ||
    !SAFE_ID.test(receipt.sandboxId) ||
    receipt.candidateCommit !== binding.result.seal.candidateCommit ||
    receipt.candidateTree !== binding.result.seal.candidateTree ||
    receipt.lockSha256 !== binding.result.seal.lockSha256 ||
    receipt.buildPolicyHash !== buildPolicyHash ||
    receipt.architecture !== "x86_64" ||
    receipt.validationLevel !== "release" ||
    !SHA256.test(receipt.sourceSha256) ||
    !SHA256.test(receipt.extractorSha256) ||
    !SHA256.test(receipt.packagerSha256) ||
    !SHA256.test(receipt.toolchainAttestationHash) ||
    !Array.isArray(receipt.commandReceiptHashes) ||
    receipt.commandReceiptHashes.length < 1 ||
    receipt.commandReceiptHashes.some((hash) => !SHA256.test(hash)) ||
    !SHA256.test(receipt.runtimeManifestSha256) ||
    !isCanonicalTimestamp(receipt.builtAt) ||
    Date.parse(receipt.signature.signedAt) < Date.parse(receipt.builtAt) ||
    receipt.passed !== true
  ) {
    throw new ProductionCorrectnessGateError(
      "CANDIDATE_BUILD_FAILED",
    );
  }
}

function expectedBuildRejectionId(
  binding: ProposalBinding,
  experiment: ExperimentIdentity,
  buildPolicyHash: string,
): string {
  return `build-rejection-${canonicalHash({
    experimentId: binding.experimentId,
    protocolHash: experiment.protocolHash,
    candidateCommit: binding.result.seal.candidateCommit,
    candidateTree: binding.result.seal.candidateTree,
    lockSha256: binding.result.seal.lockSha256,
    buildPolicyHash,
  }).slice(0, 48)}`;
}

function assertBuildRejectionReceipt(
  value: unknown,
  binding: ProposalBinding,
  experiment: ExperimentIdentity,
  buildPolicyHash: string,
): asserts value is TrustedCandidateBuildRejectionReceipt {
  assertExactKeys(value, [
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
  ]);
  const receipt = value as unknown as TrustedCandidateBuildRejectionReceipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.sensitivity !==
      "release-safe-candidate-build-rejection" ||
    receipt.rejectionId !==
      expectedBuildRejectionId(binding, experiment, buildPolicyHash) ||
    receipt.experimentId !== binding.experimentId ||
    receipt.protocolHash !== experiment.protocolHash ||
    receipt.candidateCommit !== binding.result.seal.candidateCommit ||
    receipt.candidateTree !== binding.result.seal.candidateTree ||
    receipt.lockSha256 !== binding.result.seal.lockSha256 ||
    receipt.buildPolicyHash !== buildPolicyHash ||
    receipt.failureCode !== "CLOUD_BUILD_GATE_REJECTED" ||
    receipt.containsTaskIdentifiers !== false ||
    !isCanonicalTimestamp(receipt.rejectedAt) ||
    !SHA256.test(receipt.buildAttestationHash)
  ) {
    throw new ProductionCorrectnessGateError(
      "CANDIDATE_BUILD_FAILED",
    );
  }
}

function assertBuildGateReceipt(
  value: unknown,
  binding: ProposalBinding,
  experiment: ExperimentIdentity,
  buildPolicyHash: string,
): asserts value is TrustedCandidateBuildGateReceipt {
  if (
    isPlainRecord(value) &&
    value["sensitivity"] ===
      "release-safe-candidate-build-rejection"
  ) {
    assertBuildRejectionReceipt(
      value,
      binding,
      experiment,
      buildPolicyHash,
    );
    return;
  }
  assertBuildReceipt(value, binding, buildPolicyHash);
}

function isBuildRejection(
  receipt: TrustedCandidateBuildGateReceipt,
): receipt is TrustedCandidateBuildRejectionReceipt {
  return (
    receipt.sensitivity ===
    "release-safe-candidate-build-rejection"
  );
}

function expectedPublicationRefs(experimentIdValue: string): {
  readonly branchRef: string;
  readonly tagRef: string;
} {
  return {
    branchRef: `refs/heads/df/experiment/${experimentIdValue}`,
    tagRef: `refs/tags/df/experiment/${experimentIdValue}/candidate`,
  };
}

function assertPublicationReceipt(
  value: unknown,
  binding: ProposalBinding,
): asserts value is TrustedGitPublicationReceipt {
  assertExactKeys(value, [
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
  ]);
  const receipt = value as unknown as TrustedGitPublicationReceipt;
  assertSignature(receipt.signature);
  const refs = expectedPublicationRefs(binding.experimentId);
  if (
    receipt.sensitivity !== "trusted-git-publication" ||
    receipt.schemaVersion !== 1 ||
    !SAFE_ID.test(receipt.publicationId) ||
    !SHA256.test(receipt.authorizationHash) ||
    receipt.registrationId !== binding.result.setup.registrationId ||
    receipt.originRepositoryHash !==
      binding.result.setup.originRepositoryHash ||
    !SHA256.test(receipt.upstreamRepositoryHash) ||
    !GIT_OBJECT_ID.test(receipt.upstreamHeadCommit) ||
    !GIT_OBJECT_ID.test(receipt.upstreamBaseCommit) ||
    !["daytona", "e2b", "modal"].includes(receipt.provider) ||
    !SAFE_ID.test(receipt.sandboxId) ||
    !SAFE_IMAGE_REFERENCE.test(receipt.imageReference) ||
    !/^sha256:[a-f0-9]{64}$/u.test(receipt.imageDigest) ||
    !receipt.imageReference.endsWith(`@${receipt.imageDigest}`) ||
    !SHA256.test(receipt.networkPolicyHash) ||
    receipt.experimentId !== binding.experimentId ||
    !GIT_OBJECT_ID.test(receipt.baselineCommit) ||
    !SAFE_HEAD_REF.test(receipt.baseRef) ||
    receipt.baseCommit !== binding.result.setup.sourceCommit ||
    receipt.candidateCommit !== binding.result.seal.candidateCommit ||
    receipt.candidateTree !== binding.result.seal.candidateTree ||
    receipt.lockSha256 !== binding.result.seal.lockSha256 ||
    receipt.bundleRef !== binding.result.seal.bundleRef ||
    receipt.branchRef !== refs.branchRef ||
    receipt.tagRef !== refs.tagRef ||
    receipt.branchCommit !== binding.result.seal.candidateCommit ||
    !GIT_OBJECT_ID.test(receipt.tagObjectId) ||
    receipt.tagPeeledCommit !== binding.result.seal.candidateCommit ||
    receipt.publicationMode !== "atomic-non-force" ||
    !["published", "already-published"].includes(receipt.disposition) ||
    receipt.candidateBundleSha256 !==
      binding.result.candidateBundle.sha256 ||
    !SHA256.test(receipt.workerSha256) ||
    !SHA256.test(receipt.executionReceiptHash) ||
    !SHA256.test(receipt.resultArtifactSha256) ||
    !isCanonicalTimestamp(receipt.publishedAt) ||
    Date.parse(receipt.signature.signedAt) <
      Date.parse(receipt.publishedAt) ||
    receipt.passed !== true
  ) {
    throw new ProductionCorrectnessGateError(
      "GIT_PUBLICATION_FAILED",
    );
  }
}

function assertSnapshotReceipt(
  value: unknown,
  binding: ProposalBinding,
  publication: TrustedGitPublicationReceipt,
): asserts value is TrustedGitSourceSnapshotReceipt {
  assertExactKeys(value, [
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
  assertArtifact(receipt.sourceArtifact, "application/x-tar");
  assertArtifact(
    receipt.sourceBundleArtifact,
    "application/vnd.git.bundle",
  );
  assertSignature(receipt.signature);
  if (
    receipt.sensitivity !== "trusted-git-source-snapshot" ||
    receipt.schemaVersion !== 2 ||
    !SAFE_ID.test(receipt.snapshotId) ||
    receipt.registrationId !== publication.registrationId ||
    receipt.originRepositoryHash !== publication.originRepositoryHash ||
    receipt.upstreamRepositoryHash !== publication.upstreamRepositoryHash ||
    receipt.upstreamHeadCommit !== publication.upstreamHeadCommit ||
    receipt.upstreamBaseCommit !== publication.upstreamBaseCommit ||
    receipt.baselineCommit !== publication.baselineCommit ||
    !["daytona", "e2b", "modal"].includes(receipt.provider) ||
    !SAFE_ID.test(receipt.sandboxId) ||
    !SAFE_IMAGE_REFERENCE.test(receipt.imageReference) ||
    !/^sha256:[a-f0-9]{64}$/u.test(receipt.imageDigest) ||
    !receipt.imageReference.endsWith(`@${receipt.imageDigest}`) ||
    !SHA256.test(receipt.networkPolicyHash) ||
    receipt.remoteRef !== publication.branchRef ||
    receipt.commitSha !== binding.result.seal.candidateCommit ||
    receipt.treeSha !== binding.result.seal.candidateTree ||
    receipt.lockSha256 !== binding.result.seal.lockSha256 ||
    receipt.archiveMethod !== "git-archive-format-tar" ||
    receipt.compression !== "none" ||
    receipt.bundleMethod !== "git-bundle-v2" ||
    receipt.bundleRef !== TRUSTED_GIT_SOURCE_BUNDLE_REF ||
    !SHA256.test(receipt.workerSha256) ||
    !SHA256.test(receipt.executionReceiptHash) ||
    !SHA256.test(receipt.manifestArtifactSha256) ||
    !isCanonicalTimestamp(receipt.createdAt) ||
    Date.parse(receipt.createdAt) < Date.parse(publication.publishedAt) ||
    Date.parse(receipt.signature.signedAt) <
      Date.parse(receipt.createdAt) ||
    receipt.passed !== true
  ) {
    throw new ProductionCorrectnessGateError(
      "SOURCE_SNAPSHOT_FAILED",
    );
  }
}

function assertIndexReceipt(
  value: unknown,
  binding: ProposalBinding,
  experiment: ExperimentIdentity,
  snapshot: TrustedGitSourceSnapshotReceipt,
): asserts value is TrustedCandidateSourceIndexReceipt {
  assertExactKeys(value, [
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
  ]);
  const receipt = value as unknown as TrustedCandidateSourceIndexReceipt;
  const expectedIndexId = `source-index-${canonicalHash({
    experimentId: binding.experimentId,
    protocolHash: experiment.protocolHash,
    candidateCommit: snapshot.commitSha,
    candidateTree: snapshot.treeSha,
    lockSha256: snapshot.lockSha256,
    sourceArtifactSha256: snapshot.sourceArtifact.sha256,
    sourceBundleArtifactSha256:
      snapshot.sourceBundleArtifact.sha256,
    snapshotReceiptHash: canonicalHash(snapshot),
  }).slice(0, 48)}`;
  if (
    receipt.schemaVersion !== 2 ||
    receipt.sensitivity !==
      "release-safe-candidate-source-index" ||
    receipt.indexId !== expectedIndexId ||
    receipt.experimentId !== binding.experimentId ||
    receipt.protocolHash !== experiment.protocolHash ||
    receipt.registrationId !== snapshot.registrationId ||
    receipt.originRepositoryHash !== snapshot.originRepositoryHash ||
    receipt.candidateCommit !== snapshot.commitSha ||
    receipt.candidateTree !== snapshot.treeSha ||
    receipt.lockSha256 !== snapshot.lockSha256 ||
    receipt.sourceArtifactSha256 !== snapshot.sourceArtifact.sha256 ||
    receipt.sourceBundleArtifactSha256 !==
      snapshot.sourceBundleArtifact.sha256 ||
    receipt.snapshotReceiptHash !== canonicalHash(snapshot) ||
    !isCanonicalTimestamp(receipt.indexedAt) ||
    Date.parse(receipt.indexedAt) < Date.parse(snapshot.createdAt) ||
    receipt.containsTaskIdentifiers !== false ||
    !SHA256.test(receipt.indexAttestationHash)
  ) {
    throw new ProductionCorrectnessGateError("SOURCE_INDEX_FAILED");
  }
}

function sumAccounting(
  operations: readonly CorrectnessGateOperationAccounting[],
): Pick<
  GateResult,
  "aggregateCostUsd" | "tokens" | "wallTimeMs"
> {
  return operations.reduce(
    (total, item) => ({
      aggregateCostUsd:
        total.aggregateCostUsd + item.aggregateCostUsd,
      tokens: total.tokens + item.tokens,
      wallTimeMs: total.wallTimeMs + item.wallTimeMs,
    }),
    { aggregateCostUsd: 0, tokens: 0, wallTimeMs: 0 },
  );
}

function checksHash(input: {
  readonly binding: ProposalBinding;
  readonly experiment: ExperimentIdentity;
  readonly scan: AccountedCorrectnessGateReceipt<TrustedCloudIntegrityScanReceipt>;
  readonly build: AccountedCorrectnessGateReceipt<TrustedCandidateBuildGateReceipt> | null;
  readonly publication: AccountedCorrectnessGateReceipt<TrustedGitPublicationReceipt> | null;
  readonly snapshot: AccountedCorrectnessGateReceipt<TrustedGitSourceSnapshotReceipt> | null;
  readonly index: AccountedCorrectnessGateReceipt<TrustedCandidateSourceIndexReceipt> | null;
  readonly accounting: Pick<
    GateResult,
    "aggregateCostUsd" | "tokens" | "wallTimeMs"
  >;
}): string {
  return canonicalHash({
    schemaVersion: 1,
    domain: "dark-factory.production-correctness-gate-checks.v1",
    experiment: input.experiment,
    requestHash: input.binding.requestHash,
    proposalResultHash: input.binding.proposalResultHash,
    sourceCommit: input.binding.result.setup.sourceCommit,
    sourceTree: input.binding.result.setup.sourceTree,
    candidateCommit: input.binding.result.seal.candidateCommit,
    candidateTree: input.binding.result.seal.candidateTree,
    lockSha256: input.binding.result.seal.lockSha256,
    hypothesisHash:
      input.binding.result.proposal.hypothesis.hash,
    hypothesisDocumentHash: input.binding.hypothesisDocumentHash,
    candidateDocumentHash: input.binding.candidateDocumentHash,
    changedFilesHash: input.binding.changedFilesHash,
    candidateBundleSha256:
      input.binding.result.candidateBundle.sha256,
    candidateDiffSha256: input.binding.result.candidateDiff.sha256,
    integrityScanReceiptHash: canonicalHash(input.scan.receipt),
    integrityScanAccountingHash: canonicalHash(input.scan.accounting),
    candidateBuildReceiptHash:
      input.build === null ? null : canonicalHash(input.build.receipt),
    candidateBuildAccountingHash:
      input.build === null ? null : canonicalHash(input.build.accounting),
    gitPublicationReceiptHash:
      input.publication === null
        ? null
        : canonicalHash(input.publication.receipt),
    gitPublicationAccountingHash:
      input.publication === null
        ? null
        : canonicalHash(input.publication.accounting),
    sourceSnapshotReceiptHash:
      input.snapshot === null
        ? null
        : canonicalHash(input.snapshot.receipt),
    sourceSnapshotAccountingHash:
      input.snapshot === null
        ? null
        : canonicalHash(input.snapshot.accounting),
    sourceIndexReceiptHash:
      input.index === null ? null : canonicalHash(input.index.receipt),
    sourceIndexAccountingHash:
      input.index === null ? null : canonicalHash(input.index.accounting),
    aggregateCostUsd: input.accounting.aggregateCostUsd,
    tokens: input.accounting.tokens,
    wallTimeMs: input.accounting.wallTimeMs,
  });
}

function resultForRecord(input: {
  readonly binding: ProposalBinding;
  readonly experiment: ExperimentIdentity;
  readonly scan: AccountedCorrectnessGateReceipt<TrustedCloudIntegrityScanReceipt>;
  readonly build: AccountedCorrectnessGateReceipt<TrustedCandidateBuildGateReceipt> | null;
  readonly publication: AccountedCorrectnessGateReceipt<TrustedGitPublicationReceipt> | null;
  readonly snapshot: AccountedCorrectnessGateReceipt<TrustedGitSourceSnapshotReceipt> | null;
  readonly index: AccountedCorrectnessGateReceipt<TrustedCandidateSourceIndexReceipt> | null;
}): GateResult {
  const operations = [
    input.scan.accounting,
    ...(input.build === null ? [] : [input.build.accounting]),
    ...(input.publication === null
      ? []
      : [input.publication.accounting]),
    ...(input.snapshot === null ? [] : [input.snapshot.accounting]),
    ...(input.index === null ? [] : [input.index.accounting]),
  ];
  const accounting = sumAccounting(operations);
  return {
    passed:
      input.scan.receipt.passed &&
      input.build !== null &&
      !isBuildRejection(input.build.receipt) &&
      input.index !== null,
    integrityPassed: input.scan.receipt.passed,
    protocolHash: input.experiment.protocolHash,
    checksHash: checksHash({ ...input, accounting }),
    ...accounting,
    failureCode: !input.scan.receipt.passed
      ? "INTEGRITY_POLICY_REJECTED"
      : input.build !== null && isBuildRejection(input.build.receipt)
        ? "CANDIDATE_BUILD_FAILED"
        : null,
  };
}

function assertGateResult(
  value: unknown,
  expected: GateResult,
): asserts value is GateResult {
  assertExactKeys(value, [
    "passed",
    "integrityPassed",
    "protocolHash",
    "checksHash",
    "aggregateCostUsd",
    "tokens",
    "wallTimeMs",
    "failureCode",
  ]);
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new ProductionCorrectnessGateError("GATE_RECORD_INVALID");
  }
}

function createRecord(input: {
  readonly experiment: ExperimentIdentity;
  readonly binding: ProposalBinding;
  readonly scan: AccountedCorrectnessGateReceipt<TrustedCloudIntegrityScanReceipt>;
  readonly build: AccountedCorrectnessGateReceipt<TrustedCandidateBuildGateReceipt> | null;
  readonly publication: AccountedCorrectnessGateReceipt<TrustedGitPublicationReceipt> | null;
  readonly snapshot: AccountedCorrectnessGateReceipt<TrustedGitSourceSnapshotReceipt> | null;
  readonly index: AccountedCorrectnessGateReceipt<TrustedCandidateSourceIndexReceipt> | null;
}): CorrectnessGateRecord {
  const result = resultForRecord(input);
  return withContentHash({
    schemaVersion: 1,
    domain: "dark-factory.production-correctness-gate.v1",
    experiment: cloneJson(input.experiment),
    requestHash: input.binding.requestHash,
    proposalResultHash: input.binding.proposalResultHash,
    integrityScan: cloneJson(input.scan),
    candidateBuild: cloneJson(input.build),
    gitPublication: cloneJson(input.publication),
    sourceSnapshot: cloneJson(input.snapshot),
    sourceIndex: cloneJson(input.index),
    result,
  }) as unknown as CorrectnessGateRecord;
}

function assertAccountedReceipt<Receipt>(
  value: unknown,
  operation: CorrectnessGateOperation,
  assertReceipt: (receipt: unknown) => asserts receipt is Receipt,
): asserts value is AccountedCorrectnessGateReceipt<Receipt> {
  assertExactKeys(value, ["receipt", "accounting"]);
  const accounted = value as unknown as {
    readonly receipt: unknown;
    readonly accounting: unknown;
  };
  assertReceipt(accounted.receipt);
  assertAccounting(accounted.accounting, operation, accounted.receipt);
}

function assertRecord(
  value: unknown,
  input: {
    readonly experiment: ExperimentIdentity;
    readonly binding: ProposalBinding;
    readonly integrityPolicyHash: string;
    readonly integrityWorkerSha256: string;
    readonly fragmentCatalogHash: string;
    readonly integrityReceiptVerifier: TrustedCloudIntegrityScanReceiptVerifier;
    readonly buildPolicyHash: string;
  },
): asserts value is CorrectnessGateRecord {
  assertExactKeys(value, [
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
  ]);
  const record = value as unknown as CorrectnessGateRecord;
  if (
    record.schemaVersion !== 1 ||
    record.domain !== "dark-factory.production-correctness-gate.v1" ||
    canonicalJson(record.experiment) !== canonicalJson(input.experiment) ||
    record.requestHash !== input.binding.requestHash ||
    record.proposalResultHash !== input.binding.proposalResultHash ||
    typeof record.contentHash !== "string" ||
    record.contentHash !== computeContentHash(record)
  ) {
    throw new ProductionCorrectnessGateError("GATE_RECORD_INVALID");
  }
  assertAccountedReceipt(
    record.integrityScan,
    "integrity-scan",
    (receipt): asserts receipt is TrustedCloudIntegrityScanReceipt =>
      assertIntegrityScanReceipt(
        receipt,
        input.binding,
        input.experiment,
        input.integrityPolicyHash,
        input.integrityWorkerSha256,
        input.fragmentCatalogHash,
        input.integrityReceiptVerifier,
      ),
  );
  const scan = record.integrityScan;
  if (!scan.receipt.passed) {
    if (
      record.candidateBuild !== null ||
      record.gitPublication !== null ||
      record.sourceSnapshot !== null ||
      record.sourceIndex !== null
    ) {
      throw new ProductionCorrectnessGateError("GATE_RECORD_INVALID");
    }
  } else {
    if (record.candidateBuild === null) {
      throw new ProductionCorrectnessGateError("GATE_RECORD_INVALID");
    }
    assertAccountedReceipt(
      record.candidateBuild,
      "candidate-build",
      (receipt): asserts receipt is TrustedCandidateBuildGateReceipt =>
        assertBuildGateReceipt(
          receipt,
          input.binding,
          input.experiment,
          input.buildPolicyHash,
        ),
    );
    if (isBuildRejection(record.candidateBuild.receipt)) {
      if (
        record.gitPublication !== null ||
        record.sourceSnapshot !== null ||
        record.sourceIndex !== null
      ) {
        throw new ProductionCorrectnessGateError(
          "GATE_RECORD_INVALID",
        );
      }
      assertGateResult(
        record.result,
        resultForRecord({
          binding: input.binding,
          experiment: input.experiment,
          scan: record.integrityScan,
          build: record.candidateBuild,
          publication: null,
          snapshot: null,
          index: null,
        }),
      );
      return;
    }
    if (
      record.gitPublication === null ||
      record.sourceSnapshot === null ||
      record.sourceIndex === null
    ) {
      throw new ProductionCorrectnessGateError("GATE_RECORD_INVALID");
    }
    const publication = record.gitPublication;
    assertAccountedReceipt(
      publication,
      "git-publication",
      (receipt): asserts receipt is TrustedGitPublicationReceipt =>
        assertPublicationReceipt(receipt, input.binding),
    );
    const typedPublication = publication;
    const snapshot = record.sourceSnapshot;
    assertAccountedReceipt(
      snapshot,
      "source-snapshot",
      (receipt): asserts receipt is TrustedGitSourceSnapshotReceipt =>
        assertSnapshotReceipt(
          receipt,
          input.binding,
          typedPublication.receipt,
        ),
    );
    const typedSnapshot = snapshot;
    assertAccountedReceipt(
      record.sourceIndex,
      "source-index",
      (receipt): asserts receipt is TrustedCandidateSourceIndexReceipt =>
        assertIndexReceipt(
          receipt,
          input.binding,
          input.experiment,
          typedSnapshot.receipt,
        ),
    );
  }
  assertGateResult(
    record.result,
    resultForRecord({
      binding: input.binding,
      experiment: input.experiment,
      scan: record.integrityScan,
      build: record.candidateBuild,
      publication: record.gitPublication,
      snapshot: record.sourceSnapshot,
      index: record.sourceIndex,
    }),
  );
}

async function persistAndReadBack(
  store: CorrectnessGateRecordStore,
  record: CorrectnessGateRecord,
  input: Parameters<typeof assertRecord>[1],
): Promise<CorrectnessGateRecord> {
  try {
    await store.put(cloneJson(record));
    const persisted = await store.get(cloneJson(input.experiment));
    if (persisted === null) {
      throw new ProductionCorrectnessGateError("GATE_RECORD_INVALID");
    }
    assertRecord(persisted, input);
    return cloneJson(persisted);
  } catch {
    throw new ProductionCorrectnessGateError("GATE_RECORD_INVALID");
  }
}

export class ProductionCorrectnessGateRunner
  implements CorrectnessGateRunner
{
  readonly #options: ProductionCorrectnessGateOptions;

  constructor(options: ProductionCorrectnessGateOptions) {
    if (
      options.records.boundary !== "trusted-cloud-durable" ||
      options.scanner.boundary !== "trusted-cloud" ||
      options.builder.boundary !== "trusted-cloud" ||
      options.publisher.boundary !== "trusted-cloud" ||
      options.snapshotter.boundary !== "trusted-cloud" ||
      options.sourceIndex.boundary !== "trusted-cloud" ||
      options.sourceIndex.durability !== "linearizable" ||
      !SAFE_ID.test(
        options.integrityReceiptVerifier.trustedKeyId,
      ) ||
      !SHA256.test(options.integrityPolicyHash) ||
      !SHA256.test(options.integrityWorkerSha256) ||
      !SHA256.test(options.fragmentCatalogHash) ||
      !SHA256.test(options.buildPolicyHash)
    ) {
      throw new ProductionCorrectnessGateError(
        "INVALID_CONFIGURATION",
      );
    }
    this.#options = options;
  }

  async run(input: {
    readonly experiment: ExperimentIdentity;
    readonly hypothesis: FrozenHypothesis;
    readonly candidate: FrozenCandidate;
  }): Promise<GateResult> {
    const experiment = cloneJson(input.experiment);
    const hypothesis = cloneJson(input.hypothesis);
    const candidate = cloneJson(input.candidate);
    let proposal: CloudOptimizerProposalResult | null;
    try {
      proposal = await this.#options.optimizerRecords.get(experiment);
    } catch {
      throw new ProductionCorrectnessGateError("PROPOSAL_NOT_FOUND");
    }
    if (proposal === null) {
      throw new ProductionCorrectnessGateError("PROPOSAL_NOT_FOUND");
    }
    let binding: ProposalBinding;
    try {
      binding = assertProposalBinding(
        proposal,
        experiment,
        hypothesis,
        candidate,
        this.#options.integrityPolicyHash,
      );
    } catch {
      throw new ProductionCorrectnessGateError("PROPOSAL_DETACHED");
    }
    const validationInput = {
      experiment,
      binding,
      integrityPolicyHash: this.#options.integrityPolicyHash,
      integrityWorkerSha256:
        this.#options.integrityWorkerSha256,
      fragmentCatalogHash: this.#options.fragmentCatalogHash,
      integrityReceiptVerifier:
        this.#options.integrityReceiptVerifier,
      buildPolicyHash: this.#options.buildPolicyHash,
    };
    let existing: CorrectnessGateRecord | null;
    try {
      existing = await this.#options.records.get(experiment);
    } catch {
      throw new ProductionCorrectnessGateError("GATE_RECORD_INVALID");
    }
    if (existing !== null) {
      try {
        assertRecord(existing, validationInput);
      } catch {
        throw new ProductionCorrectnessGateError(
          "GATE_RECORD_INVALID",
        );
      }
      if (existing.sourceSnapshot !== null) {
        if (existing.gitPublication === null) {
          throw new ProductionCorrectnessGateError(
            "GATE_RECORD_INVALID",
          );
        }
        await this.#resolveIndexedSnapshot(
          existing.sourceSnapshot.receipt,
          binding,
          existing.gitPublication.receipt,
        );
      }
      return cloneJson(existing.result);
    }

    let scan: AccountedCorrectnessGateReceipt<TrustedCloudIntegrityScanReceipt>;
    try {
      scan = cloneJson(
        await this.#options.scanner.scan({
          experiment,
          sourceCommit: proposal.setup.sourceCommit,
          sourceTree: proposal.setup.sourceTree,
          candidateCommit: proposal.seal.candidateCommit,
          candidateTree: proposal.seal.candidateTree,
          lockSha256: proposal.seal.lockSha256,
          hypothesisHash: hypothesis.hash,
          hypothesisDocumentHash: binding.hypothesisDocumentHash,
          candidateDocumentHash: binding.candidateDocumentHash,
          changedFiles: cloneJson(candidate.changedFiles),
          candidateBundle: cloneJson(proposal.candidateBundle),
          candidateDiff: cloneJson(proposal.candidateDiff),
          integrityPolicyHash: this.#options.integrityPolicyHash,
        }),
      );
      assertAccountedReceipt(
        scan,
        "integrity-scan",
        (receipt): asserts receipt is TrustedCloudIntegrityScanReceipt =>
          assertIntegrityScanReceipt(
            receipt,
            binding,
            experiment,
            this.#options.integrityPolicyHash,
            this.#options.integrityWorkerSha256,
            this.#options.fragmentCatalogHash,
            this.#options.integrityReceiptVerifier,
          ),
      );
    } catch (error) {
      if (
        error instanceof ProductionCorrectnessGateError &&
        error.code === "INTEGRITY_SCAN_FAILED"
      ) {
        throw error;
      }
      throw new ProductionCorrectnessGateError(
        "INTEGRITY_SCAN_FAILED",
      );
    }
    if (!scan.receipt.passed) {
      const record = createRecord({
        experiment,
        binding,
        scan,
        build: null,
        publication: null,
        snapshot: null,
        index: null,
      });
      return (
        await persistAndReadBack(
          this.#options.records,
          record,
          validationInput,
        )
      ).result;
    }

    let build: AccountedCorrectnessGateReceipt<TrustedCandidateBuildGateReceipt>;
    try {
      build = cloneJson(
        await this.#options.builder.build({
          experiment,
          sourceCommit: proposal.setup.sourceCommit,
          sourceTree: proposal.setup.sourceTree,
          candidateCommit: proposal.seal.candidateCommit,
          candidateTree: proposal.seal.candidateTree,
          lockSha256: proposal.seal.lockSha256,
          candidateBundle: cloneJson(proposal.candidateBundle),
          bundleRef: proposal.seal.bundleRef,
          diffSha256: proposal.candidateDiff.sha256,
          changedFilesHash: binding.changedFilesHash,
          integrityScanReceiptHash: canonicalHash(scan.receipt),
          buildPolicyHash: this.#options.buildPolicyHash,
        }),
      );
      assertAccountedReceipt(
        build,
        "candidate-build",
        (receipt): asserts receipt is TrustedCandidateBuildGateReceipt =>
          assertBuildGateReceipt(
            receipt,
            binding,
            experiment,
            this.#options.buildPolicyHash,
          ),
      );
    } catch {
      throw new ProductionCorrectnessGateError(
        "CANDIDATE_BUILD_FAILED",
      );
    }
    if (isBuildRejection(build.receipt)) {
      const record = createRecord({
        experiment,
        binding,
        scan,
        build,
        publication: null,
        snapshot: null,
        index: null,
      });
      return (
        await persistAndReadBack(
          this.#options.records,
          record,
          validationInput,
        )
      ).result;
    }

    let publication: AccountedCorrectnessGateReceipt<TrustedGitPublicationReceipt>;
    try {
      publication = cloneJson(
        await this.#options.publisher.publish({
          experiment,
          registrationId: proposal.setup.registrationId,
          originRepositoryHash: proposal.setup.originRepositoryHash,
          sourceCommit: proposal.setup.sourceCommit,
          sourceTree: proposal.setup.sourceTree,
          candidateCommit: proposal.seal.candidateCommit,
          candidateTree: proposal.seal.candidateTree,
          lockSha256: proposal.seal.lockSha256,
          candidateBundle: cloneJson(proposal.candidateBundle),
          bundleRef: proposal.seal.bundleRef,
          integrityScanReceiptHash: canonicalHash(scan.receipt),
          buildReceiptHash: canonicalHash(build.receipt),
        }),
      );
      assertAccountedReceipt(
        publication,
        "git-publication",
        (receipt): asserts receipt is TrustedGitPublicationReceipt =>
          assertPublicationReceipt(receipt, binding),
      );
    } catch {
      throw new ProductionCorrectnessGateError(
        "GIT_PUBLICATION_FAILED",
      );
    }

    let snapshot: AccountedCorrectnessGateReceipt<TrustedGitSourceSnapshotReceipt>;
    try {
      snapshot = cloneJson(
        await this.#options.snapshotter.snapshot({
          experiment,
          publication: cloneJson(publication.receipt),
          publicationReceiptHash: canonicalHash(publication.receipt),
        }),
      );
      assertAccountedReceipt(
        snapshot,
        "source-snapshot",
        (receipt): asserts receipt is TrustedGitSourceSnapshotReceipt =>
          assertSnapshotReceipt(
            receipt,
            binding,
            publication.receipt,
          ),
      );
    } catch {
      throw new ProductionCorrectnessGateError(
        "SOURCE_SNAPSHOT_FAILED",
      );
    }

    let index: AccountedCorrectnessGateReceipt<TrustedCandidateSourceIndexReceipt>;
    try {
      index = cloneJson(
        await this.#options.sourceIndex.index({
          experiment,
          snapshot: cloneJson(snapshot.receipt),
          snapshotReceiptHash: canonicalHash(snapshot.receipt),
        }),
      );
      assertAccountedReceipt(
        index,
        "source-index",
        (receipt): asserts receipt is TrustedCandidateSourceIndexReceipt =>
          assertIndexReceipt(
            receipt,
            binding,
            experiment,
            snapshot.receipt,
          ),
      );
      await this.#resolveIndexedSnapshot(
        snapshot.receipt,
        binding,
        publication.receipt,
      );
    } catch {
      throw new ProductionCorrectnessGateError("SOURCE_INDEX_FAILED");
    }

    const record = createRecord({
      experiment,
      binding,
      scan,
      build,
      publication,
      snapshot,
      index,
    });
    return (
      await persistAndReadBack(
        this.#options.records,
        record,
        validationInput,
      )
    ).result;
  }

  async #resolveIndexedSnapshot(
    expected: TrustedGitSourceSnapshotReceipt,
    binding: ProposalBinding,
    publication: TrustedGitPublicationReceipt,
  ): Promise<TrustedGitSourceSnapshotReceipt> {
    try {
      const resolved = await this.#options.sourceIndex.findByCommit(
        binding.result.seal.candidateCommit,
      );
      if (resolved === undefined) {
        throw new ProductionCorrectnessGateError(
          "SOURCE_INDEX_FAILED",
        );
      }
      assertSnapshotReceipt(resolved, binding, publication);
      if (canonicalHash(resolved) !== canonicalHash(expected)) {
        throw new ProductionCorrectnessGateError(
          "SOURCE_INDEX_FAILED",
        );
      }
      return resolved;
    } catch {
      throw new ProductionCorrectnessGateError("SOURCE_INDEX_FAILED");
    }
  }
}
