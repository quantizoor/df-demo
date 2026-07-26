import { createHash, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ArtifactDerivedCandidateIntegrityScanPort,
  type TrustedCandidateGitEvidenceManifest,
  type TrustedCandidateGitEvidenceRunner,
  type TrustedCandidateIntegrityArtifactReader,
  type TrustedCandidateIntegritySigningAuthority,
  type TrustedTaskFragmentHashCatalog,
  taskFragmentCatalogHash,
} from "../../src/cloud/trusted-git-candidate-integrity.js";
import type { TrustedCloudArtifactRef } from "../../src/cloud/types.js";
import { createEd25519Signature } from "../../src/evidence/signatures.js";
import { DEFAULT_PI_SCAN_POLICY_HASH } from "../../src/integrity/candidate-scanner.js";
import type { TrustedCloudIntegrityScanInput } from "../../src/orchestrator/correctness-gate.js";
import { canonicalHash, canonicalJson, withContentHash } from "../../src/schemas/canonical.js";

const keys = generateKeyPairSync("ed25519");
const KEY_ID = "candidate-integrity-test-key";
const SOURCE_COMMIT = "1".repeat(40);
const SOURCE_TREE = "2".repeat(40);
const CANDIDATE_COMMIT = "3".repeat(40);
const CANDIDATE_TREE = "4".repeat(40);
const WORKER_SHA256 = "5".repeat(64);
const PROTOCOL_HASH = "6".repeat(64);
const PATH = "packages/coding-agent/src/core/system-prompt.ts";
const DIFF = [
  `diff --git a/${PATH} b/${PATH}`,
  `index ${"a".repeat(40)}..${"b".repeat(40)} 100644`,
  `--- a/${PATH}`,
  `+++ b/${PATH}`,
  "@@ -1 +1 @@",
  "-old generic prompt",
  "+new generic prompt",
  "",
].join("\n");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(name: string, contents: string, mediaType: string): TrustedCloudArtifactRef {
  return {
    uri: `trusted://candidate-integrity/${name}`,
    sha256: sha256(contents),
    mediaType,
    byteLength: Buffer.byteLength(contents, "utf8"),
  };
}

function catalog(): TrustedTaskFragmentHashCatalog {
  const body = {
    schemaVersion: 1 as const,
    sensitivity: "trusted-task-fragment-hashes" as const,
    protocolHash: PROTOCOL_HASH,
    integrityPolicyHash: DEFAULT_PI_SCAN_POLICY_HASH,
    fragmentHashes: ["f".repeat(64)],
    containsTaskPlaintext: false as const,
    sourceAttestationHash: "7".repeat(64),
  };
  return {
    ...body,
    fragmentCatalogHash: taskFragmentCatalogHash(body),
  };
}

function fixture(
  input: {
    readonly claimedFiles?: readonly string[];
    readonly mutateManifest?: (
      manifest: TrustedCandidateGitEvidenceManifest,
    ) => TrustedCandidateGitEvidenceManifest;
    readonly invalidSigner?: boolean;
  } = {},
) {
  const fragmentCatalog = catalog();
  const diffArtifact = artifact("derived.diff", DIFF, "text/x-diff");
  const candidateBundle: TrustedCloudArtifactRef = {
    uri: "trusted://candidate-integrity/candidate.bundle",
    sha256: "8".repeat(64),
    mediaType: "application/vnd.git.bundle",
    byteLength: 8_192,
  };
  const baseManifest = withContentHash({
    schemaVersion: 1 as const,
    domain: "dark-factory.candidate-git-evidence.v1" as const,
    experimentId: "001-generic-recovery",
    bundleRef: "refs/heads/df/bundle/001-generic-recovery",
    candidateBundleSha256: candidateBundle.sha256,
    candidateBundleByteLength: candidateBundle.byteLength,
    sourceCommit: SOURCE_COMMIT,
    sourceTree: SOURCE_TREE,
    candidateCommit: CANDIDATE_COMMIT,
    candidateTree: CANDIDATE_TREE,
    diffSha256: diffArtifact.sha256,
    diffByteLength: diffArtifact.byteLength,
    changedFiles: [PATH],
    changedFilesHash: canonicalHash([PATH]),
    addedLines: 1,
    deletedLines: 1,
    lineCountsHash: canonicalHash({
      addedLines: 1,
      deletedLines: 1,
    }),
    modes: [
      {
        path: PATH,
        beforeMode: "100644",
        afterMode: "100644",
      },
    ],
    fileModesHash: canonicalHash([
      {
        path: PATH,
        beforeMode: "100644",
        afterMode: "100644",
      },
    ]),
  }) as TrustedCandidateGitEvidenceManifest;
  const selectedManifest = input.mutateManifest?.(baseManifest) ?? baseManifest;
  const { contentHash: _contentHash, ...manifestBody } = selectedManifest;
  const manifest = withContentHash(manifestBody) as TrustedCandidateGitEvidenceManifest;
  const manifestRaw = `${canonicalJson(manifest)}\n`;
  const manifestArtifact = artifact("evidence.json", manifestRaw, "application/json");
  const contents = new Map<string, string>([
    [manifestArtifact.uri, manifestRaw],
    [diffArtifact.uri, DIFF],
  ]);
  const evidenceRunner: TrustedCandidateGitEvidenceRunner = {
    boundary: "trusted-cloud-git-object-evidence",
    derive: vi.fn(async () => ({
      workerSha256: WORKER_SHA256,
      executionReceiptHash: "9".repeat(64),
      completedAt: "2026-07-26T10:00:00.000Z",
      manifestArtifact,
      diffArtifact,
    })),
  };
  const reader: TrustedCandidateIntegrityArtifactReader = {
    boundary: "trusted-cloud-artifact-reader",
    readUtf8: vi.fn(async (ref) => {
      const value = contents.get(ref.uri);
      if (value === undefined) throw new Error("missing");
      return value;
    }),
  };
  const fragmentSource = {
    boundary: "trusted-evaluator-fragment-hashes" as const,
    load: vi.fn(async () => fragmentCatalog),
  };
  const signer: TrustedCandidateIntegritySigningAuthority = {
    boundary: "trusted-cloud-key-material",
    keyId: KEY_ID,
    sign: vi.fn(async (receipt) =>
      createEd25519Signature(
        input.invalidSigner === true ? { ...receipt, passed: !receipt.passed } : receipt,
        keys.privateKey,
        KEY_ID,
        "2026-07-26T10:00:02.000Z",
      ),
    ),
  };
  const port = new ArtifactDerivedCandidateIntegrityScanPort({
    evidenceRunner,
    artifactReader: reader,
    fragmentSource,
    signer,
    accounting: {
      boundary: "trusted-cloud-accounting",
      attest: async () => ({
        aggregateCostUsd: 0.01,
        tokens: 0,
        wallTimeMs: 25,
        accountingAttestationHash: "a".repeat(64),
        containsTaskIdentifiers: false,
      }),
    },
    receiptVerifier: {
      trustedKeyId: KEY_ID,
      publicKey: keys.publicKey,
    },
    integrityPolicyHash: DEFAULT_PI_SCAN_POLICY_HASH,
    workerSha256: WORKER_SHA256,
    fragmentCatalogHash: fragmentCatalog.fragmentCatalogHash,
    now: () => new Date("2026-07-26T10:00:01.000Z"),
  });
  const scanInput: TrustedCloudIntegrityScanInput = {
    experiment: {
      number: 1,
      slug: "generic-recovery",
      kind: "optimization",
      parentExperiment: 0,
      lineageId: "campaign-a",
      protocolHash: PROTOCOL_HASH,
    },
    sourceCommit: SOURCE_COMMIT,
    sourceTree: SOURCE_TREE,
    candidateCommit: CANDIDATE_COMMIT,
    candidateTree: CANDIDATE_TREE,
    lockSha256: "b".repeat(64),
    hypothesisHash: "c".repeat(64),
    hypothesisDocumentHash: "d".repeat(64),
    candidateDocumentHash: "e".repeat(64),
    changedFiles: input.claimedFiles ?? [PATH],
    candidateBundle,
    candidateDiff: diffArtifact,
    integrityPolicyHash: DEFAULT_PI_SCAN_POLICY_HASH,
  };
  return {
    port,
    scanInput,
    evidenceRunner,
    fragmentSource,
    fragmentCatalog,
  };
}

describe("artifact-derived candidate integrity scan port", () => {
  it("signs a release-safe receipt from immutable Git evidence", async () => {
    const item = fixture();
    const result = await item.port.scan(item.scanInput);
    expect(result.receipt).toMatchObject({
      schemaVersion: 2,
      passed: true,
      violationCodes: [],
      candidateBundleSha256: item.scanInput.candidateBundle.sha256,
      evidenceDiffSha256: item.scanInput.candidateDiff.sha256,
      fragmentCatalogHash: item.fragmentCatalog.fragmentCatalogHash,
      workerSha256: WORKER_SHA256,
      containsTaskIdentifiers: false,
    });
    expect(JSON.stringify(result)).not.toContain(PATH);
    expect(JSON.stringify(result)).not.toContain(item.fragmentCatalog.fragmentHashes[0]);
    expect(item.evidenceRunner.derive).toHaveBeenCalledTimes(1);
    const evidenceRequest = vi.mocked(item.evidenceRunner.derive).mock.calls[0]?.[0];
    expect(evidenceRequest).not.toHaveProperty("fragmentHashes");
  });

  it("records a claimed-path substitution as a normal integrity rejection", async () => {
    const item = fixture({
      claimedFiles: ["packages/coding-agent/src/core/tools.ts"],
    });
    await expect(item.port.scan(item.scanInput)).resolves.toMatchObject({
      receipt: {
        passed: false,
        violationCodes: ["DIFF_METADATA_MISMATCH"],
      },
    });
  });

  it("fails closed when the signing authority signs different content", async () => {
    const item = fixture({ invalidSigner: true });
    await expect(item.port.scan(item.scanInput)).rejects.toThrow("failed closed");
  });

  it("fails closed when the evidence manifest changes the immutable candidate tree", async () => {
    const item = fixture({
      mutateManifest: (manifest) => ({
        ...manifest,
        candidateTree: "0".repeat(40),
      }),
    });
    await expect(item.port.scan(item.scanInput)).rejects.toThrow("failed closed");
  });
});
