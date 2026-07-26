import { generateKeyPairSync, type KeyLike } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { TrustedArtifactRuntimeGuard } from "../../src/cloud/artifact-bridge.js";
import {
  MountedVolumeCorrectnessGateRecordStore,
  MountedVolumeTrustedCandidateSourceIndex,
  type TrustedCandidateSourceIndexAttestation,
  type TrustedCandidateSourceIndexAttestationAuthority,
} from "../../src/cloud/mounted-volume-correctness-gate-ports.js";
import type {
  MountedVolumeDurableStateOptions,
  MountedVolumeStateSemanticsGuard,
} from "../../src/cloud/mounted-volume-state.js";
import type { ExperimentIdentity } from "../../src/domain/models.js";
import { createEd25519Signature } from "../../src/evidence/signatures.js";
import type { TrustedCandidateRuntimeBuildReceipt } from "../../src/harness/candidate-build-runner.js";
import type { TrustedGitPublicationReceipt } from "../../src/harness/git-publication.js";
import {
  TRUSTED_GIT_SOURCE_BUNDLE_REF,
  type TrustedGitSourceSnapshotReceipt,
} from "../../src/harness/git-source.js";
import {
  type AccountedCorrectnessGateReceipt,
  type CorrectnessGateOperation,
  type CorrectnessGateRecord,
  type TrustedCandidateSourceIndexReceipt,
  type TrustedCloudIntegrityScanReceipt,
  trustedCloudIntegrityScanAttestationHash,
} from "../../src/orchestrator/correctness-gate.js";
import { canonicalHash, canonicalJson, withContentHash } from "../../src/schemas/canonical.js";

const PROTOCOL_HASH = "1".repeat(64);
const SOURCE_COMMIT = "2".repeat(40);
const SOURCE_TREE = "3".repeat(40);
const CANDIDATE_COMMIT = "4".repeat(40);
const CANDIDATE_TREE = "5".repeat(40);
const LOCK_SHA256 = "6".repeat(64);
const REGISTRATION_ID = "7".repeat(64);
const ORIGIN_REPOSITORY_HASH = "8".repeat(64);
const IMAGE_DIGEST = `sha256:${"9".repeat(64)}`;
const IMAGE_REFERENCE = `ghcr.io/parallaxai/pi@${IMAGE_DIGEST}`;
const TRUSTED_KEY_ID = "correctness-gate-test-key";

const keyPair = generateKeyPairSync("ed25519");

const runtimeGuard: TrustedArtifactRuntimeGuard = {
  assertTrustedCloudRuntime() {},
};

const semanticsGuard: MountedVolumeStateSemanticsGuard = {
  assertLinearizableStateVolume() {},
};

const experiment: ExperimentIdentity = {
  number: 1,
  slug: "durable-source-index",
  kind: "optimization",
  parentExperiment: 0,
  lineageId: "campaign-a",
  protocolHash: PROTOCOL_HASH,
};

function stateOptions(
  root: string,
  controller = "a".repeat(64),
  nonce = "b".repeat(48),
): MountedVolumeDurableStateOptions {
  return {
    volumeRoot: root,
    storeId: "campaign-a",
    controllerInstanceIdHash: controller,
    runtimeGuard,
    semanticsGuard,
    now: () => new Date("2026-07-26T10:05:00.000Z"),
    nonceFactory: () => nonce,
  };
}

function verifier(publicKey: KeyLike = keyPair.publicKey) {
  return {
    trustedKeyId: TRUSTED_KEY_ID,
    publicKey,
  };
}

function signedSnapshot(
  overrides: Partial<Omit<TrustedGitSourceSnapshotReceipt, "signature">> = {},
): TrustedGitSourceSnapshotReceipt {
  const unsigned = {
    sensitivity: "trusted-git-source-snapshot" as const,
    schemaVersion: 2 as const,
    snapshotId: "snapshot-durable-001",
    registrationId: REGISTRATION_ID,
    originRepositoryHash: ORIGIN_REPOSITORY_HASH,
    upstreamRepositoryHash: "a".repeat(64),
    upstreamHeadCommit: "b".repeat(40),
    upstreamBaseCommit: "c".repeat(40),
    baselineCommit: SOURCE_COMMIT,
    provider: "daytona" as const,
    sandboxId: "source-sandbox-001",
    imageReference: IMAGE_REFERENCE,
    imageDigest: IMAGE_DIGEST,
    networkPolicyHash: "d".repeat(64),
    remoteRef: "refs/heads/df/experiment/001-durable-source-index",
    commitSha: CANDIDATE_COMMIT,
    treeSha: CANDIDATE_TREE,
    lockSha256: LOCK_SHA256,
    archiveMethod: "git-archive-format-tar" as const,
    compression: "none" as const,
    bundleMethod: "git-bundle-v2" as const,
    bundleRef: TRUSTED_GIT_SOURCE_BUNDLE_REF,
    workerSha256: "e".repeat(64),
    executionReceiptHash: "f".repeat(64),
    manifestArtifactSha256: "0".repeat(64),
    sourceArtifact: {
      uri: "trusted://candidate-sources/commit-001" as const,
      sha256: "1".repeat(64),
      mediaType: "application/x-tar",
      byteLength: 8_192,
    },
    sourceBundleArtifact: {
      uri: "trusted://candidate-sources/commit-001-bundle" as const,
      sha256: "2".repeat(64),
      mediaType: "application/vnd.git.bundle",
      byteLength: 16_384,
    },
    createdAt: "2026-07-26T10:04:00.000Z",
    passed: true as const,
    ...overrides,
  };
  return {
    ...unsigned,
    signature: createEd25519Signature(
      unsigned,
      keyPair.privateKey,
      TRUSTED_KEY_ID,
      "2026-07-26T10:04:01.000Z",
    ),
  };
}

function sourceAuthority() {
  const attest = vi.fn<TrustedCandidateSourceIndexAttestationAuthority["attest"]>(
    async (request) => ({
      schemaVersion: 1,
      sensitivity: "trusted-candidate-source-index-attestation",
      storageBindingHash: request.storageBindingHash,
      indexAttestationHash: canonicalHash({
        domain: "index-attestation",
        binding: request.storageBindingHash,
      }),
      aggregateCostUsd: 0.01,
      tokens: 0,
      wallTimeMs: 3,
      accountingAttestationHash: canonicalHash({
        domain: "index-accounting",
        binding: request.storageBindingHash,
      }),
      containsTaskIdentifiers: false,
    }),
  );
  return {
    boundary: "trusted-cloud" as const,
    attest,
  };
}

function rejectedScan(passed = false): TrustedCloudIntegrityScanReceipt {
  const draft: Omit<
    TrustedCloudIntegrityScanReceipt,
    "scanId" | "scanAttestationHash" | "signature"
  > = {
    schemaVersion: 2,
    sensitivity: "release-safe-candidate-integrity-scan" as const,
    experimentId: "001-durable-source-index",
    protocolHash: PROTOCOL_HASH,
    sourceCommit: SOURCE_COMMIT,
    sourceTree: SOURCE_TREE,
    candidateCommit: CANDIDATE_COMMIT,
    candidateTree: CANDIDATE_TREE,
    lockSha256: LOCK_SHA256,
    hypothesisHash: "2".repeat(64),
    hypothesisDocumentHash: "3".repeat(64),
    candidateDocumentHash: "4".repeat(64),
    diffSha256: "5".repeat(64),
    changedFilesHash: "6".repeat(64),
    candidateBundleSha256: "7".repeat(64),
    evidenceManifestSha256: "8".repeat(64),
    evidenceDiffSha256: "5".repeat(64),
    observedChangedFilesHash: "6".repeat(64),
    lineCountsHash: "9".repeat(64),
    fileModesHash: "a".repeat(64),
    fragmentCatalogHash: "b".repeat(64),
    workerSha256: "c".repeat(64),
    executionReceiptHash: "d".repeat(64),
    integrityPolicyHash: "7".repeat(64),
    passed,
    violationCodes: passed ? [] : ["PROTECTED_PATH"],
    containsTaskIdentifiers: false as const,
    scannedAt: "2026-07-26T10:01:00.000Z",
  };
  const identified = {
    ...draft,
    scanId: `scan-${canonicalHash({
      experimentId: draft.experimentId,
      protocolHash: draft.protocolHash,
      sourceCommit: draft.sourceCommit,
      sourceTree: draft.sourceTree,
      candidateCommit: draft.candidateCommit,
      candidateTree: draft.candidateTree,
      lockSha256: draft.lockSha256,
      hypothesisDocumentHash: draft.hypothesisDocumentHash,
      candidateDocumentHash: draft.candidateDocumentHash,
      diffSha256: draft.diffSha256,
      changedFilesHash: draft.changedFilesHash,
      candidateBundleSha256: draft.candidateBundleSha256,
      integrityWorkerSha256: draft.workerSha256,
      fragmentCatalogHash: draft.fragmentCatalogHash,
      integrityPolicyHash: draft.integrityPolicyHash,
    }).slice(0, 48)}`,
  };
  const unsigned = {
    ...identified,
    scanAttestationHash: trustedCloudIntegrityScanAttestationHash(identified),
  };
  return {
    ...unsigned,
    signature: createEd25519Signature(
      unsigned,
      keyPair.privateKey,
      TRUSTED_KEY_ID,
      "2026-07-26T10:01:01.000Z",
    ),
  };
}

function accountedScan(
  receipt: TrustedCloudIntegrityScanReceipt,
): AccountedCorrectnessGateReceipt<TrustedCloudIntegrityScanReceipt> {
  return accounted("integrity-scan", receipt, 0.02, 4, 20, "9");
}

function accounted<Receipt>(
  operation: CorrectnessGateOperation,
  receipt: Receipt,
  aggregateCostUsd: number,
  tokens: number,
  wallTimeMs: number,
  attestationDigit: string,
): AccountedCorrectnessGateReceipt<Receipt> {
  return {
    receipt,
    accounting: {
      schemaVersion: 1,
      sensitivity: "release-safe-correctness-gate-accounting",
      operation,
      receiptHash: canonicalHash(receipt),
      aggregateCostUsd,
      tokens,
      wallTimeMs,
      containsTaskIdentifiers: false,
      accountingAttestationHash: attestationDigit.repeat(64),
    },
  };
}

function rejectedRecord(
  overrides: {
    readonly proposalResultHash?: string;
    readonly scan?: TrustedCloudIntegrityScanReceipt;
  } = {},
): CorrectnessGateRecord {
  const scan = accountedScan(overrides.scan ?? rejectedScan());
  return withContentHash({
    schemaVersion: 1 as const,
    domain: "dark-factory.production-correctness-gate.v1" as const,
    experiment,
    requestHash: "a".repeat(64),
    proposalResultHash: overrides.proposalResultHash ?? "b".repeat(64),
    integrityScan: scan,
    candidateBuild: null,
    gitPublication: null,
    sourceSnapshot: null,
    sourceIndex: null,
    result: {
      passed: false,
      integrityPassed: false,
      protocolHash: PROTOCOL_HASH,
      checksHash: "c".repeat(64),
      aggregateCostUsd: scan.accounting.aggregateCostUsd,
      tokens: scan.accounting.tokens,
      wallTimeMs: scan.accounting.wallTimeMs,
      failureCode: "INTEGRITY_POLICY_REJECTED",
    },
  }) as CorrectnessGateRecord;
}

function passingScan(): TrustedCloudIntegrityScanReceipt {
  return rejectedScan(true);
}

function signedBuild(): TrustedCandidateRuntimeBuildReceipt {
  const body = {
    sensitivity: "trusted-candidate-runtime-build" as const,
    schemaVersion: 1 as const,
    buildId: "build-durable-001",
    experimentId: "001-durable-source-index",
    sandboxId: "build-sandbox-001",
    candidateCommit: CANDIDATE_COMMIT,
    candidateTree: CANDIDATE_TREE,
    lockSha256: LOCK_SHA256,
    buildPolicyHash: "a".repeat(64),
    architecture: "x86_64" as const,
    validationLevel: "release" as const,
    sourceSha256: "b".repeat(64),
    extractorSha256: "c".repeat(64),
    packagerSha256: "d".repeat(64),
    toolchainAttestationHash: "e".repeat(64),
    commandReceiptHashes: ["f".repeat(64)],
    runtimeManifestSha256: "0".repeat(64),
    runtimeArtifact: {
      uri: "trusted://candidate-runtimes/commit-001" as const,
      sha256: "1".repeat(64),
      mediaType: "application/x-tar",
      byteLength: 16_384,
    },
    builtAt: "2026-07-26T10:02:00.000Z",
    passed: true as const,
  };
  return {
    ...body,
    signature: createEd25519Signature(
      body,
      keyPair.privateKey,
      TRUSTED_KEY_ID,
      "2026-07-26T10:02:01.000Z",
    ),
  };
}

function signedPublication(): TrustedGitPublicationReceipt {
  const body = {
    sensitivity: "trusted-git-publication" as const,
    schemaVersion: 1 as const,
    publicationId: "publication-durable-001",
    authorizationHash: "2".repeat(64),
    registrationId: REGISTRATION_ID,
    originRepositoryHash: ORIGIN_REPOSITORY_HASH,
    upstreamRepositoryHash: "a".repeat(64),
    upstreamHeadCommit: "b".repeat(40),
    upstreamBaseCommit: "c".repeat(40),
    provider: "daytona" as const,
    sandboxId: "publication-sandbox-001",
    imageReference: IMAGE_REFERENCE,
    imageDigest: IMAGE_DIGEST,
    networkPolicyHash: "3".repeat(64),
    experimentId: "001-durable-source-index",
    baselineCommit: SOURCE_COMMIT,
    baseRef: "refs/heads/main",
    baseCommit: SOURCE_COMMIT,
    candidateCommit: CANDIDATE_COMMIT,
    candidateTree: CANDIDATE_TREE,
    lockSha256: LOCK_SHA256,
    bundleRef: "refs/heads/df/bundle/001-durable-source-index",
    branchRef: "refs/heads/df/experiment/001-durable-source-index",
    tagRef: "refs/tags/df/experiment/001-durable-source-index/candidate",
    branchCommit: CANDIDATE_COMMIT,
    tagObjectId: "d".repeat(40),
    tagPeeledCommit: CANDIDATE_COMMIT,
    publicationMode: "atomic-non-force" as const,
    disposition: "published" as const,
    candidateBundleSha256: "b".repeat(64),
    workerSha256: "4".repeat(64),
    executionReceiptHash: "5".repeat(64),
    resultArtifactSha256: "6".repeat(64),
    publishedAt: "2026-07-26T10:03:00.000Z",
    passed: true as const,
  };
  return {
    ...body,
    signature: createEd25519Signature(
      body,
      keyPair.privateKey,
      TRUSTED_KEY_ID,
      "2026-07-26T10:03:01.000Z",
    ),
  };
}

function sourceIndexReceipt(
  snapshot: TrustedGitSourceSnapshotReceipt,
): TrustedCandidateSourceIndexReceipt {
  const snapshotReceiptHash = canonicalHash(snapshot);
  return {
    schemaVersion: 2,
    sensitivity: "release-safe-candidate-source-index",
    indexId: `source-index-${canonicalHash({
      experimentId: "001-durable-source-index",
      protocolHash: PROTOCOL_HASH,
      candidateCommit: snapshot.commitSha,
      candidateTree: snapshot.treeSha,
      lockSha256: snapshot.lockSha256,
      sourceArtifactSha256: snapshot.sourceArtifact.sha256,
      sourceBundleArtifactSha256: snapshot.sourceBundleArtifact.sha256,
      snapshotReceiptHash,
    }).slice(0, 48)}`,
    experimentId: "001-durable-source-index",
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
    indexAttestationHash: "7".repeat(64),
  };
}

function passingRecord(): CorrectnessGateRecord {
  const scan = accounted("integrity-scan", passingScan(), 1, 1, 10, "8");
  const build = accounted("candidate-build", signedBuild(), 2, 2, 20, "9");
  const publication = accounted("git-publication", signedPublication(), 3, 3, 30, "a");
  const snapshot = signedSnapshot();
  const source = accounted("source-snapshot", snapshot, 4, 4, 40, "b");
  const indexed = accounted("source-index", sourceIndexReceipt(snapshot), 5, 5, 50, "c");
  return withContentHash({
    schemaVersion: 1 as const,
    domain: "dark-factory.production-correctness-gate.v1" as const,
    experiment,
    requestHash: "d".repeat(64),
    proposalResultHash: "e".repeat(64),
    integrityScan: scan,
    candidateBuild: build,
    gitPublication: publication,
    sourceSnapshot: source,
    sourceIndex: indexed,
    result: {
      passed: true,
      integrityPassed: true,
      protocolHash: PROTOCOL_HASH,
      checksHash: "f".repeat(64),
      aggregateCostUsd: 15,
      tokens: 15,
      wallTimeMs: 150,
      failureCode: null,
    },
  }) as CorrectnessGateRecord;
}

describe("mounted-volume correctness-gate production ports", () => {
  it("indexes one exact signed snapshot once across concurrent retry and controller handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-candidate-source-index-test-"));
    const authority = sourceAuthority();
    const index = new MountedVolumeTrustedCandidateSourceIndex({
      durableState: stateOptions(root),
      sourceReceiptVerifier: verifier(),
      attestationAuthority: authority,
    });
    const snapshot = signedSnapshot();
    const input = {
      experiment,
      snapshot,
      snapshotReceiptHash: canonicalHash(snapshot),
    };

    const [first, concurrent, third] = await Promise.all([
      index.index(input),
      index.index(input),
      index.index(input),
    ]);
    expect(concurrent).toEqual(first);
    expect(third).toEqual(first);
    expect(authority.attest).toHaveBeenCalledTimes(1);
    const resolved = await index.findByCommit(snapshot.commitSha);
    expect(resolved).toEqual(snapshot);

    (snapshot.sourceArtifact as { sha256: string }).sha256 = "f".repeat(64);
    (first.receipt as { sourceArtifactSha256: string }).sourceArtifactSha256 = "e".repeat(64);
    expect(await index.findByCommit(CANDIDATE_COMMIT)).toEqual(signedSnapshot());
    await index.close();

    const successorAuthority = sourceAuthority();
    const successor = new MountedVolumeTrustedCandidateSourceIndex({
      durableState: stateOptions(root, "c".repeat(64), "d".repeat(48)),
      sourceReceiptVerifier: verifier(),
      attestationAuthority: successorAuthority,
    });
    await expect(
      successor.index({
        experiment,
        snapshot: signedSnapshot(),
        snapshotReceiptHash: canonicalHash(signedSnapshot()),
      }),
    ).resolves.toEqual(concurrent);
    expect(successorAuthority.attest).not.toHaveBeenCalled();
    await successor.close();
  });

  it("rejects a second signed snapshot for an already indexed commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-candidate-source-index-test-"));
    const authority = sourceAuthority();
    const index = new MountedVolumeTrustedCandidateSourceIndex({
      durableState: stateOptions(root),
      sourceReceiptVerifier: verifier(),
      attestationAuthority: authority,
    });
    const first = signedSnapshot();
    await index.index({
      experiment,
      snapshot: first,
      snapshotReceiptHash: canonicalHash(first),
    });
    const conflict = signedSnapshot({
      treeSha: "e".repeat(40),
      sourceArtifact: {
        ...first.sourceArtifact,
        sha256: "f".repeat(64),
      },
    });
    await expect(
      index.index({
        experiment,
        snapshot: conflict,
        snapshotReceiptHash: canonicalHash(conflict),
      }),
    ).rejects.toThrow("Candidate commit already binds a different source snapshot.");
    expect(authority.attest).toHaveBeenCalledTimes(1);
    await index.close();
  });

  it("rejects signature tampering before calling the index authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-candidate-source-index-test-"));
    const authority = sourceAuthority();
    const index = new MountedVolumeTrustedCandidateSourceIndex({
      durableState: stateOptions(root),
      sourceReceiptVerifier: verifier(),
      attestationAuthority: authority,
    });
    const snapshot = {
      ...signedSnapshot(),
      treeSha: "f".repeat(40),
    };
    await expect(
      index.index({
        experiment,
        snapshot,
        snapshotReceiptHash: canonicalHash(snapshot),
      }),
    ).rejects.toThrow("Trusted receipt signature is invalid.");
    expect(authority.attest).not.toHaveBeenCalled();
    await index.close();
  });

  it("rejects persisted snapshots under a different trusted keyring", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-candidate-source-index-test-"));
    const index = new MountedVolumeTrustedCandidateSourceIndex({
      durableState: stateOptions(root),
      sourceReceiptVerifier: verifier(),
      attestationAuthority: sourceAuthority(),
    });
    const snapshot = signedSnapshot();
    await index.index({
      experiment,
      snapshot,
      snapshotReceiptHash: canonicalHash(snapshot),
    });
    await index.close();

    const untrustedKey = generateKeyPairSync("ed25519").publicKey;
    const successor = new MountedVolumeTrustedCandidateSourceIndex({
      durableState: stateOptions(root, "c".repeat(64), "d".repeat(48)),
      sourceReceiptVerifier: verifier(untrustedKey),
      attestationAuthority: sourceAuthority(),
    });
    await expect(successor.findByCommit(CANDIDATE_COMMIT)).rejects.toThrow(
      "Trusted receipt signature is invalid.",
    );
    await successor.close();
  });

  it("fails closed when an attestation contains an undeclared field", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-candidate-source-index-test-"));
    const authority: TrustedCandidateSourceIndexAttestationAuthority = {
      boundary: "trusted-cloud",
      attest: async (request) =>
        ({
          schemaVersion: 1,
          sensitivity: "trusted-candidate-source-index-attestation",
          storageBindingHash: request.storageBindingHash,
          indexAttestationHash: "1".repeat(64),
          aggregateCostUsd: 0,
          tokens: 0,
          wallTimeMs: 0,
          accountingAttestationHash: "2".repeat(64),
          containsTaskIdentifiers: false,
          taskId: "forbidden",
        }) as TrustedCandidateSourceIndexAttestation,
    };
    const index = new MountedVolumeTrustedCandidateSourceIndex({
      durableState: stateOptions(root),
      sourceReceiptVerifier: verifier(),
      attestationAuthority: authority,
    });
    const snapshot = signedSnapshot();
    await expect(
      index.index({
        experiment,
        snapshot,
        snapshotReceiptHash: canonicalHash(snapshot),
      }),
    ).rejects.toThrow("contains non-canonical fields");
    await index.close();
  });

  it("validates and preserves the complete signed passing gate lineage", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-correctness-record-test-"));
    const records = new MountedVolumeCorrectnessGateRecordStore({
      durableState: stateOptions(root),
      integrityScanVerifier: verifier(),
      candidateBuildVerifier: verifier(),
      gitPublicationVerifier: verifier(),
      gitSourceVerifier: verifier(),
    });
    const record = passingRecord();
    await records.put(record);
    await expect(records.get(experiment)).resolves.toEqual(record);
    await records.close();
  });

  it("rejects a rehashed record with a tampered publication signature", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-correctness-record-test-"));
    const records = new MountedVolumeCorrectnessGateRecordStore({
      durableState: stateOptions(root),
      integrityScanVerifier: verifier(),
      candidateBuildVerifier: verifier(),
      gitPublicationVerifier: verifier(),
      gitSourceVerifier: verifier(),
    });
    const record = passingRecord();
    if (record.gitPublication === null) {
      throw new Error("Passing fixture is missing its publication.");
    }
    const tamperedReceipt = {
      ...record.gitPublication.receipt,
      signature: {
        ...record.gitPublication.receipt.signature,
        signature: "A".repeat(86),
      },
    };
    const tamperedPublication = {
      receipt: tamperedReceipt,
      accounting: {
        ...record.gitPublication.accounting,
        receiptHash: canonicalHash(tamperedReceipt),
      },
    };
    const tampered = withContentHash({
      ...record,
      gitPublication: tamperedPublication,
    }) as CorrectnessGateRecord;
    await expect(records.put(tampered)).rejects.toThrow("Trusted receipt signature is invalid.");
    await records.close();
  });

  it("persists immutable gate records and rejects a same-identity conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-correctness-record-test-"));
    const records = new MountedVolumeCorrectnessGateRecordStore({
      durableState: stateOptions(root),
      integrityScanVerifier: verifier(),
      candidateBuildVerifier: verifier(),
      gitPublicationVerifier: verifier(),
      gitSourceVerifier: verifier(),
    });
    const record = rejectedRecord();
    await Promise.all([
      records.put(record),
      records.put(JSON.parse(canonicalJson(record)) as CorrectnessGateRecord),
      records.put(JSON.parse(canonicalJson(record)) as CorrectnessGateRecord),
    ]);
    await expect(records.get(experiment)).resolves.toEqual(record);
    await expect(
      records.put(
        rejectedRecord({
          proposalResultHash: "d".repeat(64),
        }),
      ),
    ).rejects.toThrow("experiment identity already binds different content");
    await records.close();

    const successor = new MountedVolumeCorrectnessGateRecordStore({
      durableState: stateOptions(root, "c".repeat(64), "d".repeat(48)),
      integrityScanVerifier: verifier(),
      candidateBuildVerifier: verifier(),
      gitPublicationVerifier: verifier(),
      gitSourceVerifier: verifier(),
    });
    await expect(successor.get(experiment)).resolves.toEqual(record);
    await successor.close();
  });

  it("rejects hidden fields even when every outer hash is recomputed", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-correctness-record-test-"));
    const records = new MountedVolumeCorrectnessGateRecordStore({
      durableState: stateOptions(root),
      integrityScanVerifier: verifier(),
      candidateBuildVerifier: verifier(),
      gitPublicationVerifier: verifier(),
      gitSourceVerifier: verifier(),
    });
    const original = rejectedScan();
    const scan = {
      ...original,
      taskId: "hidden-task",
    } as TrustedCloudIntegrityScanReceipt;
    const accounted = accountedScan(scan);
    const tampered = withContentHash({
      ...rejectedRecord(),
      integrityScan: accounted,
      result: {
        ...rejectedRecord().result,
        aggregateCostUsd: accounted.accounting.aggregateCostUsd,
        tokens: accounted.accounting.tokens,
        wallTimeMs: accounted.accounting.wallTimeMs,
      },
    }) as CorrectnessGateRecord;
    await expect(records.put(tampered)).rejects.toThrow("contains non-canonical fields");
    await records.close();
  });
});
