import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { TrustedCloudArtifactRef } from "../../src/cloud/types.js";
import type { ExperimentIdentity } from "../../src/domain/models.js";
import { createEd25519Signature } from "../../src/evidence/signatures.js";
import type { TrustedCandidateRuntimeBuildReceipt } from "../../src/harness/candidate-build-runner.js";
import type { TrustedGitPublicationReceipt } from "../../src/harness/git-publication.js";
import {
  TRUSTED_GIT_SOURCE_BUNDLE_REF,
  type TrustedGitSourceSnapshotReceipt,
} from "../../src/harness/git-source.js";
import type {
  CloudOptimizerAnalysisResult,
  CloudOptimizerProposalResult,
  CloudOptimizerSessionRecordStore,
} from "../../src/optimizer/cloud-session.js";
import type { FrozenCandidate, FrozenHypothesis } from "../../src/orchestrator/contracts.js";
import {
  type AccountedCorrectnessGateReceipt,
  type CorrectnessGateOperation,
  type CorrectnessGateRecord,
  type CorrectnessGateRecordStore,
  ProductionCorrectnessGateRunner,
  type TrustedCandidateBuildRejectionReceipt,
  type TrustedCandidateSourceIndexPort,
  type TrustedCandidateSourceIndexReceipt,
  type TrustedCandidateSourceSnapshotPort,
  type TrustedCloudCandidateBuildPort,
  type TrustedCloudIntegrityScanPort,
  type TrustedCloudIntegrityScanReceipt,
  type TrustedNonForceGitPublicationPort,
  trustedCloudIntegrityScanAttestationHash,
} from "../../src/orchestrator/correctness-gate.js";
import { canonicalHash, canonicalJson, withContentHash } from "../../src/schemas/canonical.js";

const SOURCE_COMMIT = "1".repeat(40);
const SOURCE_TREE = "2".repeat(40);
const CANDIDATE_COMMIT = "3".repeat(40);
const CANDIDATE_TREE = "4".repeat(40);
const LOCK_SHA256 = "5".repeat(64);
const DIFF_SHA256 = "6".repeat(64);
const BUNDLE_SHA256 = "7".repeat(64);
const STATE_SHA256 = "8".repeat(64);
const INTEGRITY_POLICY_HASH = "9".repeat(64);
const INTEGRITY_WORKER_SHA256 = "0".repeat(64);
const FRAGMENT_CATALOG_HASH = "1".repeat(64);
const BUILD_POLICY_HASH = "a".repeat(64);
const REGISTRATION_ID = "b".repeat(64);
const ORIGIN_REPOSITORY_HASH = "c".repeat(64);
const PROTOCOL_HASH = "d".repeat(64);
const IMAGE_DIGEST = `sha256:${"e".repeat(64)}`;
const IMAGE_REFERENCE = `ghcr.io/parallaxai/gate@${IMAGE_DIGEST}`;
const EXPERIMENT_ID = "001-improve-recovery";
const integrityKeys = generateKeyPairSync("ed25519");
const INTEGRITY_KEY_ID = "integrity-scan-key";

const experiment: ExperimentIdentity = {
  number: 1,
  slug: "improve-recovery",
  kind: "optimization",
  parentExperiment: 0,
  lineageId: "campaign-a",
  protocolHash: PROTOCOL_HASH,
};

const hypothesis: FrozenHypothesis = {
  hash: "f".repeat(64),
  sourceBriefHash: null,
  causalClaim: "Generic recovery guidance is incomplete.",
  intervention: "Improve the generic recovery sequence.",
  predictedRepairBehavior: "Failed operations are inspected before retry.",
  predictedFreshEffect: "Small broad reliability improvement.",
  falsificationCriteria: ["No broad recovery improvement."],
  rollbackCondition: "Rollback after a broad regression.",
};

const candidate: FrozenCandidate = {
  commit: CANDIDATE_COMMIT,
  patchHash: DIFF_SHA256,
  changedFiles: ["packages/coding-agent/src/core/system-prompt.ts"],
  mutationCategory: "system-prompt",
};

function artifact(
  name: string,
  sha256: string,
  mediaType: string,
  byteLength = 4_096,
): TrustedCloudArtifactRef {
  return {
    uri: `trusted://correctness-gate/${name}`,
    sha256,
    mediaType,
    byteLength,
  };
}

function proposalResult(
  overrides: { readonly candidate?: FrozenCandidate; readonly candidateTree?: string } = {},
): CloudOptimizerProposalResult {
  const frozenCandidate = overrides.candidate ?? candidate;
  const candidateTree = overrides.candidateTree ?? CANDIDATE_TREE;
  const candidateBundle = artifact("candidate-bundle", BUNDLE_SHA256, "application/vnd.git.bundle");
  const candidateDiff = artifact("candidate-diff", frozenCandidate.patchHash, "text/x-diff");
  const sessionState = artifact("session-state", STATE_SHA256, "application/x-tar");
  const setup = withContentHash({
    schemaVersion: 1 as const,
    domain: "dark-factory.optimizer-setup.v1" as const,
    phase: "proposal" as const,
    campaignId: experiment.lineageId,
    experimentId: EXPERIMENT_ID,
    sourceMode: "private-github" as const,
    registrationId: REGISTRATION_ID,
    originRepositoryHash: ORIGIN_REPOSITORY_HASH,
    sourceCommit: SOURCE_COMMIT,
    sourceTree: SOURCE_TREE,
    lockSha256: LOCK_SHA256,
    pluginArchiveSha256: "0".repeat(64),
    evidenceArchiveSha256: "1".repeat(64),
    inputStateSha256: null,
  });
  const claude = withContentHash({
    schemaVersion: 1 as const,
    domain: "dark-factory.optimizer-claude.v1" as const,
    phase: "proposal" as const,
    campaignId: experiment.lineageId,
    experimentId: EXPERIMENT_ID,
    summary: {
      initialized: true as const,
      pluginLoaded: true as const,
      pluginErrors: [],
      sessionId: "claude-session-001",
      model: "claude-test",
      result: "completed" as const,
      totalCostUsd: 1,
      turns: 3,
    },
    exitCode: 0,
    stderrSha256: "2".repeat(64),
  });
  const seal = withContentHash({
    schemaVersion: 1 as const,
    domain: "dark-factory.optimizer-proposal.v1" as const,
    campaignId: experiment.lineageId,
    experimentId: EXPERIMENT_ID,
    sourceCommit: SOURCE_COMMIT,
    candidateCommit: frozenCandidate.commit,
    candidateTree,
    lockSha256: LOCK_SHA256,
    bundleRef: `refs/heads/df/bundle/${EXPERIMENT_ID}`,
    hypothesis,
    candidate: frozenCandidate,
    hypothesisReceiptId: "hypothesis-receipt-0001",
    candidateReceiptId: "candidate-receipt-0001",
    integrityPolicyHash: INTEGRITY_POLICY_HASH,
    bundle: {
      sha256: candidateBundle.sha256,
      byteLength: candidateBundle.byteLength,
    },
    diff: {
      sha256: candidateDiff.sha256,
      byteLength: candidateDiff.byteLength,
    },
    state: {
      sha256: sessionState.sha256,
      byteLength: sessionState.byteLength,
    },
  });
  const executionReceipt = (executionId: string) => ({
    provider: "daytona" as const,
    sandboxId: "optimizer-sandbox-001",
    executionId,
    startedAt: "2026-07-26T10:00:00.000Z",
    finishedAt: "2026-07-26T10:00:01.000Z",
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    resourceReport: {
      peakMemoryMiB: 128,
      cpuTimeMs: 50,
    },
  });
  return {
    proposal: { hypothesis, candidate: frozenCandidate },
    setup,
    claude,
    seal,
    candidateBundle,
    candidateDiff,
    sessionState,
    setupManifestArtifact: artifact("setup-manifest", "3".repeat(64), "application/json"),
    claudeManifestArtifact: artifact("claude-manifest", "4".repeat(64), "application/json"),
    sealManifestArtifact: artifact("seal-manifest", "5".repeat(64), "application/json"),
    executionReceipts: {
      setup: executionReceipt("optimizer-setup"),
      claude: executionReceipt("optimizer-claude"),
      seal: executionReceipt("optimizer-seal"),
    },
  };
}

function optimizerStore(
  proposal: CloudOptimizerProposalResult | null,
): CloudOptimizerSessionRecordStore {
  return {
    put: async () => undefined,
    get: async () => proposal,
    putAnalysis: async () => undefined,
    getAnalysis: async (): Promise<CloudOptimizerAnalysisResult | null> => null,
  };
}

function signature(signedAt: string) {
  return {
    algorithm: "ed25519" as const,
    keyId: "trusted-gate-key-001",
    signedAt,
    signature: "A".repeat(86),
  };
}

function scanReceipt(
  proposal: CloudOptimizerProposalResult,
  passed = true,
): TrustedCloudIntegrityScanReceipt {
  const hypothesisDocumentHash = canonicalHash(hypothesis);
  const candidateDocumentHash = canonicalHash(candidate);
  const changedFilesHash = canonicalHash(candidate.changedFiles);
  const attested: Omit<TrustedCloudIntegrityScanReceipt, "scanAttestationHash" | "signature"> = {
    schemaVersion: 2,
    sensitivity: "release-safe-candidate-integrity-scan",
    scanId: `scan-${canonicalHash({
      experimentId: EXPERIMENT_ID,
      protocolHash: PROTOCOL_HASH,
      sourceCommit: proposal.setup.sourceCommit,
      sourceTree: proposal.setup.sourceTree,
      candidateCommit: proposal.seal.candidateCommit,
      candidateTree: proposal.seal.candidateTree,
      lockSha256: proposal.seal.lockSha256,
      hypothesisDocumentHash,
      candidateDocumentHash,
      diffSha256: proposal.candidateDiff.sha256,
      changedFilesHash,
      candidateBundleSha256: proposal.candidateBundle.sha256,
      integrityWorkerSha256: INTEGRITY_WORKER_SHA256,
      fragmentCatalogHash: FRAGMENT_CATALOG_HASH,
      integrityPolicyHash: INTEGRITY_POLICY_HASH,
    }).slice(0, 48)}`,
    experimentId: EXPERIMENT_ID,
    protocolHash: PROTOCOL_HASH,
    sourceCommit: proposal.setup.sourceCommit,
    sourceTree: proposal.setup.sourceTree,
    candidateCommit: proposal.seal.candidateCommit,
    candidateTree: proposal.seal.candidateTree,
    lockSha256: proposal.seal.lockSha256,
    hypothesisHash: hypothesis.hash,
    hypothesisDocumentHash,
    candidateDocumentHash,
    diffSha256: proposal.candidateDiff.sha256,
    changedFilesHash,
    candidateBundleSha256: proposal.candidateBundle.sha256,
    evidenceManifestSha256: "2".repeat(64),
    evidenceDiffSha256: proposal.candidateDiff.sha256,
    observedChangedFilesHash: changedFilesHash,
    lineCountsHash: "3".repeat(64),
    fileModesHash: "4".repeat(64),
    fragmentCatalogHash: FRAGMENT_CATALOG_HASH,
    workerSha256: INTEGRITY_WORKER_SHA256,
    executionReceiptHash: "5".repeat(64),
    integrityPolicyHash: INTEGRITY_POLICY_HASH,
    passed,
    violationCodes: passed ? [] : ["PROTECTED_PATH"],
    containsTaskIdentifiers: false,
    scannedAt: "2026-07-26T10:01:00.000Z",
  };
  const unsigned = {
    ...attested,
    scanAttestationHash: trustedCloudIntegrityScanAttestationHash(attested),
  };
  return {
    ...unsigned,
    signature: createEd25519Signature(
      unsigned,
      integrityKeys.privateKey,
      INTEGRITY_KEY_ID,
      "2026-07-26T10:01:01.000Z",
    ),
  };
}

function buildReceipt(): TrustedCandidateRuntimeBuildReceipt {
  return {
    sensitivity: "trusted-candidate-runtime-build",
    schemaVersion: 1,
    buildId: "build-001",
    experimentId: EXPERIMENT_ID,
    sandboxId: "build-sandbox-001",
    candidateCommit: CANDIDATE_COMMIT,
    candidateTree: CANDIDATE_TREE,
    lockSha256: LOCK_SHA256,
    buildPolicyHash: BUILD_POLICY_HASH,
    architecture: "x86_64",
    validationLevel: "release",
    sourceSha256: BUNDLE_SHA256,
    extractorSha256: "7".repeat(64),
    packagerSha256: "8".repeat(64),
    toolchainAttestationHash: "9".repeat(64),
    commandReceiptHashes: ["a".repeat(64), "b".repeat(64)],
    runtimeManifestSha256: "c".repeat(64),
    runtimeArtifact: artifact("candidate-runtime", "d".repeat(64), "application/x-tar"),
    builtAt: "2026-07-26T10:02:00.000Z",
    passed: true,
    signature: signature("2026-07-26T10:02:01.000Z"),
  };
}

function buildRejectionReceipt(): TrustedCandidateBuildRejectionReceipt {
  return {
    schemaVersion: 1,
    sensitivity: "release-safe-candidate-build-rejection",
    rejectionId: `build-rejection-${canonicalHash({
      experimentId: EXPERIMENT_ID,
      protocolHash: PROTOCOL_HASH,
      candidateCommit: CANDIDATE_COMMIT,
      candidateTree: CANDIDATE_TREE,
      lockSha256: LOCK_SHA256,
      buildPolicyHash: BUILD_POLICY_HASH,
    }).slice(0, 48)}`,
    experimentId: EXPERIMENT_ID,
    protocolHash: PROTOCOL_HASH,
    candidateCommit: CANDIDATE_COMMIT,
    candidateTree: CANDIDATE_TREE,
    lockSha256: LOCK_SHA256,
    buildPolicyHash: BUILD_POLICY_HASH,
    failureCode: "CLOUD_BUILD_GATE_REJECTED",
    containsTaskIdentifiers: false,
    rejectedAt: "2026-07-26T10:02:00.000Z",
    buildAttestationHash: "0".repeat(64),
  };
}

function publicationReceipt(): TrustedGitPublicationReceipt {
  return {
    sensitivity: "trusted-git-publication",
    schemaVersion: 1,
    publicationId: "publication-001",
    authorizationHash: "e".repeat(64),
    registrationId: REGISTRATION_ID,
    originRepositoryHash: ORIGIN_REPOSITORY_HASH,
    upstreamRepositoryHash: "f".repeat(64),
    upstreamHeadCommit: "6".repeat(40),
    upstreamBaseCommit: "7".repeat(40),
    provider: "daytona",
    sandboxId: "publication-sandbox-001",
    imageReference: IMAGE_REFERENCE,
    imageDigest: IMAGE_DIGEST,
    networkPolicyHash: "0".repeat(64),
    experimentId: EXPERIMENT_ID,
    baselineCommit: SOURCE_COMMIT,
    baseRef: "refs/heads/main",
    baseCommit: SOURCE_COMMIT,
    candidateCommit: CANDIDATE_COMMIT,
    candidateTree: CANDIDATE_TREE,
    lockSha256: LOCK_SHA256,
    bundleRef: `refs/heads/df/bundle/${EXPERIMENT_ID}`,
    branchRef: `refs/heads/df/experiment/${EXPERIMENT_ID}`,
    tagRef: `refs/tags/df/experiment/${EXPERIMENT_ID}/candidate`,
    branchCommit: CANDIDATE_COMMIT,
    tagObjectId: "8".repeat(40),
    tagPeeledCommit: CANDIDATE_COMMIT,
    publicationMode: "atomic-non-force",
    disposition: "published",
    candidateBundleSha256: BUNDLE_SHA256,
    workerSha256: "1".repeat(64),
    executionReceiptHash: "2".repeat(64),
    resultArtifactSha256: "3".repeat(64),
    publishedAt: "2026-07-26T10:03:00.000Z",
    passed: true,
    signature: signature("2026-07-26T10:03:01.000Z"),
  };
}

function snapshotReceipt(publication = publicationReceipt()): TrustedGitSourceSnapshotReceipt {
  return {
    sensitivity: "trusted-git-source-snapshot",
    schemaVersion: 2,
    snapshotId: "snapshot-001",
    registrationId: publication.registrationId,
    originRepositoryHash: publication.originRepositoryHash,
    upstreamRepositoryHash: publication.upstreamRepositoryHash,
    upstreamHeadCommit: publication.upstreamHeadCommit,
    upstreamBaseCommit: publication.upstreamBaseCommit,
    baselineCommit: publication.baselineCommit,
    provider: "daytona",
    sandboxId: "snapshot-sandbox-001",
    imageReference: IMAGE_REFERENCE,
    imageDigest: IMAGE_DIGEST,
    networkPolicyHash: "4".repeat(64),
    remoteRef: publication.branchRef,
    commitSha: CANDIDATE_COMMIT,
    treeSha: CANDIDATE_TREE,
    lockSha256: LOCK_SHA256,
    archiveMethod: "git-archive-format-tar",
    compression: "none",
    bundleMethod: "git-bundle-v2",
    bundleRef: TRUSTED_GIT_SOURCE_BUNDLE_REF,
    workerSha256: "5".repeat(64),
    executionReceiptHash: "6".repeat(64),
    manifestArtifactSha256: "7".repeat(64),
    sourceArtifact: artifact("candidate-source", "8".repeat(64), "application/x-tar"),
    sourceBundleArtifact: artifact(
      "candidate-source-bundle",
      "a".repeat(64),
      "application/vnd.git.bundle",
    ),
    createdAt: "2026-07-26T10:04:00.000Z",
    passed: true,
    signature: signature("2026-07-26T10:04:01.000Z"),
  };
}

function indexReceipt(
  snapshot: TrustedGitSourceSnapshotReceipt,
): TrustedCandidateSourceIndexReceipt {
  const snapshotReceiptHash = canonicalHash(snapshot);
  return {
    schemaVersion: 2,
    sensitivity: "release-safe-candidate-source-index",
    indexId: `source-index-${canonicalHash({
      experimentId: EXPERIMENT_ID,
      protocolHash: PROTOCOL_HASH,
      candidateCommit: snapshot.commitSha,
      candidateTree: snapshot.treeSha,
      lockSha256: snapshot.lockSha256,
      sourceArtifactSha256: snapshot.sourceArtifact.sha256,
      sourceBundleArtifactSha256: snapshot.sourceBundleArtifact.sha256,
      snapshotReceiptHash,
    }).slice(0, 48)}`,
    experimentId: EXPERIMENT_ID,
    protocolHash: PROTOCOL_HASH,
    registrationId: snapshot.registrationId,
    originRepositoryHash: snapshot.originRepositoryHash,
    candidateCommit: snapshot.commitSha,
    candidateTree: snapshot.treeSha,
    lockSha256: snapshot.lockSha256,
    sourceArtifactSha256: snapshot.sourceArtifact.sha256,
    sourceBundleArtifactSha256: snapshot.sourceBundleArtifact.sha256,
    snapshotReceiptHash,
    indexedAt: "2026-07-26T10:05:00.000Z",
    containsTaskIdentifiers: false,
    indexAttestationHash: "9".repeat(64),
  };
}

function accounted<Receipt>(
  operation: CorrectnessGateOperation,
  receipt: Receipt,
  ordinal: number,
): AccountedCorrectnessGateReceipt<Receipt> {
  return {
    receipt,
    accounting: {
      schemaVersion: 1,
      sensitivity: "release-safe-correctness-gate-accounting",
      operation,
      receiptHash: canonicalHash(receipt),
      aggregateCostUsd: ordinal,
      tokens: ordinal * 10,
      wallTimeMs: ordinal * 100,
      containsTaskIdentifiers: false,
      accountingAttestationHash: ordinal.toString(16).repeat(64),
    },
  };
}

class MemoryGateRecordStore implements CorrectnessGateRecordStore {
  readonly boundary = "trusted-cloud-durable" as const;
  record: CorrectnessGateRecord | null = null;
  readonly put = vi.fn(async (record: CorrectnessGateRecord) => {
    if (this.record !== null && canonicalJson(this.record) !== canonicalJson(record)) {
      throw new Error("immutable collision");
    }
    this.record = JSON.parse(canonicalJson(record)) as CorrectnessGateRecord;
  });
  readonly get = vi.fn(async (_experiment: ExperimentIdentity) =>
    this.record === null ? null : (JSON.parse(canonicalJson(this.record)) as CorrectnessGateRecord),
  );
}

interface GateHarness {
  readonly runner: ProductionCorrectnessGateRunner;
  readonly records: MemoryGateRecordStore;
  readonly scanner: TrustedCloudIntegrityScanPort;
  readonly builder: TrustedCloudCandidateBuildPort;
  readonly publisher: TrustedNonForceGitPublicationPort;
  readonly snapshotter: TrustedCandidateSourceSnapshotPort;
  readonly sourceIndex: TrustedCandidateSourceIndexPort;
}

function gateHarness(
  input: {
    readonly proposal?: CloudOptimizerProposalResult | null;
    readonly scanPassed?: boolean;
    readonly scanMutation?: (
      receipt: TrustedCloudIntegrityScanReceipt,
    ) => TrustedCloudIntegrityScanReceipt;
    readonly buildFailure?: boolean;
    readonly publicationFailure?: boolean;
    readonly snapshotMutation?: (
      receipt: TrustedGitSourceSnapshotReceipt,
    ) => TrustedGitSourceSnapshotReceipt;
  } = {},
): GateHarness {
  const proposal = input.proposal === undefined ? proposalResult() : input.proposal;
  if (proposal === null) {
    const records = new MemoryGateRecordStore();
    const unavailable = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const scanner = {
      boundary: "trusted-cloud" as const,
      scan: unavailable,
    };
    const builder = {
      boundary: "trusted-cloud" as const,
      build: unavailable,
    };
    const publisher = {
      boundary: "trusted-cloud" as const,
      publish: unavailable,
    };
    const snapshotter = {
      boundary: "trusted-cloud" as const,
      snapshot: unavailable,
    };
    const sourceIndex = {
      boundary: "trusted-cloud" as const,
      durability: "linearizable" as const,
      index: unavailable,
      findByCommit: unavailable,
    };
    return {
      runner: new ProductionCorrectnessGateRunner({
        optimizerRecords: optimizerStore(null),
        records,
        scanner,
        builder,
        publisher,
        snapshotter,
        sourceIndex,
        integrityReceiptVerifier: {
          trustedKeyId: INTEGRITY_KEY_ID,
          publicKey: integrityKeys.publicKey,
        },
        integrityPolicyHash: INTEGRITY_POLICY_HASH,
        integrityWorkerSha256: INTEGRITY_WORKER_SHA256,
        fragmentCatalogHash: FRAGMENT_CATALOG_HASH,
        buildPolicyHash: BUILD_POLICY_HASH,
      }),
      records,
      scanner,
      builder,
      publisher,
      snapshotter,
      sourceIndex,
    };
  }

  const records = new MemoryGateRecordStore();
  const scan = (input.scanMutation ?? ((value) => value))(
    scanReceipt(proposal, input.scanPassed ?? true),
  );
  const build = buildReceipt();
  const publication = publicationReceipt();
  const snapshot = (input.snapshotMutation ?? ((value) => value))(snapshotReceipt(publication));
  let indexedSnapshot: TrustedGitSourceSnapshotReceipt | null = null;
  const scanner: TrustedCloudIntegrityScanPort = {
    boundary: "trusted-cloud",
    scan: vi.fn(async () => accounted("integrity-scan", scan, 1)),
  };
  const builder: TrustedCloudCandidateBuildPort = {
    boundary: "trusted-cloud",
    build: vi.fn(async () =>
      accounted(
        "candidate-build",
        input.buildFailure === true ? buildRejectionReceipt() : build,
        2,
      ),
    ),
  };
  const publisher: TrustedNonForceGitPublicationPort = {
    boundary: "trusted-cloud",
    publish: vi.fn(async () => {
      if (input.publicationFailure === true) {
        throw new Error("non-force ref conflict");
      }
      return accounted("git-publication", publication, 3);
    }),
  };
  const snapshotter: TrustedCandidateSourceSnapshotPort = {
    boundary: "trusted-cloud",
    snapshot: vi.fn(async () => accounted("source-snapshot", snapshot, 4)),
  };
  const sourceIndex: TrustedCandidateSourceIndexPort = {
    boundary: "trusted-cloud",
    durability: "linearizable",
    index: vi.fn(async ({ snapshot: indexed }) => {
      indexedSnapshot = indexed;
      return accounted("source-index", indexReceipt(indexed), 5);
    }),
    findByCommit: vi.fn(async () => indexedSnapshot ?? undefined),
  };
  return {
    runner: new ProductionCorrectnessGateRunner({
      optimizerRecords: optimizerStore(proposal),
      records,
      scanner,
      builder,
      publisher,
      snapshotter,
      sourceIndex,
      integrityReceiptVerifier: {
        trustedKeyId: INTEGRITY_KEY_ID,
        publicKey: integrityKeys.publicKey,
      },
      integrityPolicyHash: INTEGRITY_POLICY_HASH,
      integrityWorkerSha256: INTEGRITY_WORKER_SHA256,
      fragmentCatalogHash: FRAGMENT_CATALOG_HASH,
      buildPolicyHash: BUILD_POLICY_HASH,
    }),
    records,
    scanner,
    builder,
    publisher,
    snapshotter,
    sourceIndex,
  };
}

function run(harness: GateHarness, inputCandidate: FrozenCandidate = candidate) {
  return harness.runner.run({
    experiment,
    hypothesis,
    candidate: inputCandidate,
  });
}

describe("production correctness gate", () => {
  it("binds every trusted receipt and exact accounting into a passing gate", async () => {
    const harness = gateHarness();
    const result = await run(harness);
    expect(result).toMatchObject({
      passed: true,
      integrityPassed: true,
      protocolHash: PROTOCOL_HASH,
      aggregateCostUsd: 15,
      tokens: 150,
      wallTimeMs: 1_500,
      failureCode: null,
    });
    expect(result.checksHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(harness.records.record?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(harness.records.put).toHaveBeenCalledTimes(1);
    expect(harness.scanner.scan).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceCommit: SOURCE_COMMIT,
        sourceTree: SOURCE_TREE,
        candidateCommit: CANDIDATE_COMMIT,
        candidateTree: CANDIDATE_TREE,
        lockSha256: LOCK_SHA256,
        changedFiles: candidate.changedFiles,
      }),
    );
  });

  it("rejects a request detached from the exact persisted proposal", async () => {
    const harness = gateHarness();
    const detachedCandidate = {
      ...candidate,
      mutationCategory: "different-category",
    };
    await expect(run(harness, detachedCandidate)).rejects.toMatchObject({
      code: "PROPOSAL_DETACHED",
    });
    expect(harness.scanner.scan).not.toHaveBeenCalled();
  });

  it("returns a release-safe rejection and stops after a failed integrity scan", async () => {
    const harness = gateHarness({ scanPassed: false });
    await expect(run(harness)).resolves.toMatchObject({
      passed: false,
      integrityPassed: false,
      protocolHash: PROTOCOL_HASH,
      aggregateCostUsd: 1,
      tokens: 10,
      wallTimeMs: 100,
      failureCode: "INTEGRITY_POLICY_REJECTED",
    });
    expect(harness.builder.build).not.toHaveBeenCalled();
    expect(harness.publisher.publish).not.toHaveBeenCalled();
    expect(harness.snapshotter.snapshot).not.toHaveBeenCalled();
    expect(harness.sourceIndex.index).not.toHaveBeenCalled();
  });

  it("rejects task-sensitive fields at the release-safe scan boundary", async () => {
    const harness = gateHarness({
      scanMutation: (receipt) =>
        ({
          ...receipt,
          taskId: "hidden-task-id",
        }) as TrustedCloudIntegrityScanReceipt,
    });
    await expect(run(harness)).rejects.toMatchObject({
      code: "INTEGRITY_SCAN_FAILED",
    });
    expect(harness.builder.build).not.toHaveBeenCalled();
  });

  it("rejects a content-tampered scan signed for different bytes", async () => {
    const harness = gateHarness({
      scanMutation: (receipt) => ({
        ...receipt,
        evidenceManifestSha256: "0".repeat(64),
      }),
    });
    await expect(run(harness)).rejects.toMatchObject({
      code: "INTEGRITY_SCAN_FAILED",
    });
    expect(harness.builder.build).not.toHaveBeenCalled();
  });

  it("rejects safely before publication when the verified cloud build fails", async () => {
    const harness = gateHarness({ buildFailure: true });
    await expect(run(harness)).resolves.toMatchObject({
      passed: false,
      integrityPassed: true,
      aggregateCostUsd: 3,
      tokens: 30,
      wallTimeMs: 300,
      failureCode: "CANDIDATE_BUILD_FAILED",
    });
    expect(harness.publisher.publish).not.toHaveBeenCalled();
  });

  it("treats a non-force publication conflict as an unusable candidate", async () => {
    const harness = gateHarness({ publicationFailure: true });
    await expect(run(harness)).rejects.toMatchObject({
      code: "GIT_PUBLICATION_FAILED",
    });
    expect(harness.snapshotter.snapshot).not.toHaveBeenCalled();
    expect(harness.sourceIndex.index).not.toHaveBeenCalled();
  });

  it("rejects a source snapshot that does not resolve the published tree", async () => {
    const harness = gateHarness({
      snapshotMutation: (receipt) => ({
        ...receipt,
        treeSha: "0".repeat(40),
      }),
    });
    await expect(run(harness)).rejects.toMatchObject({
      code: "SOURCE_SNAPSHOT_FAILED",
    });
    expect(harness.sourceIndex.index).not.toHaveBeenCalled();
  });

  it("replays the durable result without rebuilding or republishing", async () => {
    const harness = gateHarness();
    const first = await run(harness);
    const second = await run(harness);
    expect(second).toEqual(first);
    expect(harness.scanner.scan).toHaveBeenCalledTimes(1);
    expect(harness.builder.build).toHaveBeenCalledTimes(1);
    expect(harness.publisher.publish).toHaveBeenCalledTimes(1);
    expect(harness.snapshotter.snapshot).toHaveBeenCalledTimes(1);
    expect(harness.sourceIndex.index).toHaveBeenCalledTimes(1);
    expect(harness.sourceIndex.findByCommit).toHaveBeenCalledTimes(2);
    expect(harness.records.put).toHaveBeenCalledTimes(1);
  });
});
