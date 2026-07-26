import { generateKeyPairSync, type KeyObject } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { TrustedCloudArtifactRef } from "../../src/cloud/types.js";
import { createEd25519Signature } from "../../src/evidence/signatures.js";
import {
  TRUSTED_GIT_SOURCE_BUNDLE_REF,
  type TrustedGitSourceSnapshotReceipt,
} from "../../src/harness/git-source.js";
import { fingerprintRemoteUrl } from "../../src/harness/git.js";
import {
  OFFICIAL_PI_UPSTREAM_URL,
  type RepositoryRegistration,
} from "../../src/harness/repository.js";
import type {
  OptimizerContext,
  RepairAggregate,
  ValidationAggregate,
} from "../../src/orchestrator/contracts.js";
import {
  ArtifactBackedCloudOptimizerAdapterResolver,
  ArtifactBackedCloudOptimizerAdapterResolverError,
  type OptimizerAnalysisEvidenceMetadata,
  type OptimizerProposalDiagnosticEvidenceMetadata,
  type OptimizerReleasedEvidenceMetadata,
  type OptimizerReleasedEvidenceQuery,
  type OptimizerResolverPublicKeyRequest,
  type OptimizerResolverSignaturePurpose,
  type OptimizerSourceOnlyBootstrapEvidenceMetadata,
  type TrustedOptimizerResolverPublicKey,
} from "../../src/optimizer/artifact-backed-resolver.js";
import {
  canonicalHash,
  canonicalJson,
  sha256,
} from "../../src/schemas/canonical.js";

const BASELINE = "a".repeat(40);
const BASELINE_TREE = "b".repeat(40);
const CANDIDATE = "c".repeat(40);
const CANDIDATE_TREE = "d".repeat(40);
const LOCK = "1".repeat(64);
const CAMPAIGN = "campaign-a";
const PROTOCOL = "2".repeat(64);
const AUTHORITY_SET = "3".repeat(64);
const KEY_SET = "4".repeat(64);
const KEY_VERSION = "v1";
const SOURCE_KEY_ID = "source-key-001";
const BOOTSTRAP_KEY_ID = "bootstrap-key-001";
const PROPOSAL_KEY_ID = "proposal-key-001";
const ANALYSIS_KEY_ID = "analysis-key-001";
const sourceKeys = generateKeyPairSync("ed25519");
const bootstrapKeys = generateKeyPairSync("ed25519");
const proposalKeys = generateKeyPairSync("ed25519");
const analysisKeys = generateKeyPairSync("ed25519");
const substitutedKeys = generateKeyPairSync("ed25519");
const bytesByUri = new Map<string, Uint8Array>();

function writeTarText(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = Buffer.from(value, "ascii");
  if (bytes.byteLength > length) throw new Error("tar fixture field");
  target.set(bytes, offset);
}

function tarOctal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\u0000";
}

function tarArchive(
  entries: readonly {
    readonly path: string;
    readonly content: string;
    readonly type?: "file" | "symlink" | "global-pax";
    readonly linkName?: string;
  }[],
): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content, "utf8");
    const header = new Uint8Array(512);
    writeTarText(header, 0, 100, entry.path);
    writeTarText(header, 100, 8, tarOctal(0o644, 8));
    writeTarText(header, 108, 8, tarOctal(0, 8));
    writeTarText(header, 116, 8, tarOctal(0, 8));
    writeTarText(
      header,
      124,
      12,
      tarOctal(
        entry.type === "symlink" ? 0 : content.byteLength,
        12,
      ),
    );
    writeTarText(header, 136, 12, tarOctal(0, 12));
    header.fill(0x20, 148, 156);
    let typeByte = 0x30;
    if (entry.type === "symlink") typeByte = 0x32;
    if (entry.type === "global-pax") typeByte = 0x67;
    header[156] = typeByte;
    if (entry.linkName !== undefined) {
      writeTarText(header, 157, 100, entry.linkName);
    }
    writeTarText(header, 257, 6, "ustar");
    writeTarText(header, 263, 2, "00");
    const checksum = [...header].reduce(
      (total, byte) => total + byte,
      0,
    );
    writeTarText(
      header,
      148,
      8,
      checksum.toString(8).padStart(6, "0") + "\u0000 ",
    );
    blocks.push(header);
    if (entry.type !== "symlink") {
      const padded = new Uint8Array(
        Math.ceil(content.byteLength / 512) * 512,
      );
      padded.set(content);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  return Uint8Array.from(
    Buffer.concat(blocks.map((block) => Buffer.from(block))),
  );
}

function safeReleaseArchive(label: string): Uint8Array {
  return tarArchive([
    {
      path: "release.json",
      content: `${canonicalJson({
        schemaVersion: 1,
        summary: `Generic aggregate evidence ${label}.`,
      })}\n`,
    },
  ]);
}

function gitBundleBytes(label: string): Uint8Array {
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from(
        `# v2 git bundle\n${label} refs/heads/df/bundle/000-source-snapshot\n\nPACK`,
        "ascii",
      ),
      Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]),
    ]),
  );
}

function sourceArchive(
  commit: string,
  entries: Parameters<typeof tarArchive>[0] = [
    {
      path: "package.json",
      content: '{"name":"pi-source"}\n',
    },
  ],
): Uint8Array {
  return tarArchive([
    {
      path: "pax_global_header",
      content: `${commit.length + 12} comment=${commit}\n`,
      type: "global-pax",
    },
    ...entries,
  ]);
}

function sourceArtifact(
  name: string,
  commit: string,
  entries?: Parameters<typeof tarArchive>[0],
): TrustedCloudArtifactRef {
  const bytes = sourceArchive(commit, entries);
  const uri = `trusted://optimizer-resolver/${name}` as const;
  bytesByUri.set(uri, bytes);
  return {
    uri,
    sha256: sha256(bytes),
    mediaType: "application/x-tar",
    byteLength: bytes.byteLength,
  };
}

function sourceBundleArtifact(
  name: string,
  commit: string,
): TrustedCloudArtifactRef {
  const bytes = gitBundleBytes(commit);
  const uri = `trusted://optimizer-resolver/${name}` as const;
  bytesByUri.set(uri, bytes);
  return {
    uri,
    sha256: sha256(bytes),
    mediaType: "application/vnd.git.bundle",
    byteLength: bytes.byteLength,
  };
}

function artifact(
  name: string,
  hash: string,
  mediaType: string,
  byteLength = 4096,
): TrustedCloudArtifactRef {
  const uri = `trusted://optimizer-resolver/${name}` as const;
  if (
    mediaType === "application/x-tar" ||
    mediaType === "application/vnd.git.bundle"
  ) {
    const bytes =
      mediaType === "application/x-tar"
        ? safeReleaseArchive(name)
        : gitBundleBytes(hash.slice(0, 40));
    bytesByUri.set(uri, bytes);
    return {
      uri,
      sha256: sha256(bytes),
      mediaType,
      byteLength: bytes.byteLength,
    };
  }
  return {
    uri,
    sha256: hash,
    mediaType,
    byteLength,
  };
}

function tarArtifact(
  name: string,
  entries: Parameters<typeof tarArchive>[0],
): TrustedCloudArtifactRef {
  const bytes = tarArchive(entries);
  const uri = `trusted://optimizer-resolver/${name}` as const;
  bytesByUri.set(uri, bytes);
  return {
    uri,
    sha256: sha256(bytes),
    mediaType: "application/x-tar",
    byteLength: bytes.byteLength,
  };
}

function registration(
  overrides: Partial<RepositoryRegistration> = {},
): RepositoryRegistration {
  return {
    registrationId: "5".repeat(64),
    canonicalPath:
      "/Users/operator/Desktop/Repos/ParallaxAI/pi",
    branch: "main",
    headCommit: BASELINE,
    treeSha: BASELINE_TREE,
    lockSha256: LOCK,
    upstreamBaseCommit: "6".repeat(40),
    originFingerprint: fingerprintRemoteUrl(
      "git@github.com:parallaxai/df-pi-tbench.git",
    ),
    upstreamFingerprint: fingerprintRemoteUrl(
      OFFICIAL_PI_UPSTREAM_URL,
    ),
    originVerification: {
      private: true,
      fetchable: true,
      writable: true,
      checkedAt: "2026-07-26T09:00:00.000Z",
      providerAttestationHash: "7".repeat(64),
    },
    upstreamVerification: {
      fetchable: true,
      upstreamHeadCommit: "8".repeat(40),
      mergeBaseCommit: "6".repeat(40),
      checkedAt: "2026-07-26T09:00:00.000Z",
      providerAttestationHash: "9".repeat(64),
    },
    ...overrides,
  };
}

function sourceReceipt(input: {
  readonly commit?: string;
  readonly tree?: string;
  readonly lock?: string;
  readonly remoteRef?: string;
  readonly registration?: RepositoryRegistration;
  readonly sourceArtifact?: TrustedCloudArtifactRef;
  readonly sourceBundleArtifact?: TrustedCloudArtifactRef;
  readonly mutate?: (
    body: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
} = {}): TrustedGitSourceSnapshotReceipt {
  const pinned = input.registration ?? registration();
  const body = {
    sensitivity: "trusted-git-source-snapshot" as const,
    schemaVersion: 2 as const,
    snapshotId: "snapshot-optimizer-001",
    registrationId: pinned.registrationId,
    originRepositoryHash:
      pinned.originFingerprint.repositoryHash,
    upstreamRepositoryHash:
      pinned.upstreamFingerprint.repositoryHash,
    upstreamHeadCommit:
      pinned.upstreamVerification.upstreamHeadCommit,
    upstreamBaseCommit: pinned.upstreamBaseCommit,
    baselineCommit: pinned.headCommit,
    provider: "daytona" as const,
    sandboxId: "source-sandbox-001",
    imageReference:
      `ghcr.io/parallax/source@sha256:${"a".repeat(64)}`,
    imageDigest: `sha256:${"a".repeat(64)}`,
    networkPolicyHash: "b".repeat(64),
    remoteRef: input.remoteRef ?? "refs/heads/main",
    commitSha: input.commit ?? BASELINE,
    treeSha: input.tree ?? BASELINE_TREE,
    lockSha256: input.lock ?? LOCK,
    archiveMethod: "git-archive-format-tar" as const,
    compression: "none" as const,
    bundleMethod: "git-bundle-v2" as const,
    bundleRef: TRUSTED_GIT_SOURCE_BUNDLE_REF,
    workerSha256: "c".repeat(64),
    executionReceiptHash: "d".repeat(64),
    manifestArtifactSha256: "e".repeat(64),
    sourceArtifact:
      input.sourceArtifact ??
      sourceArtifact(
        `source-tar-${input.commit ?? BASELINE}`,
        input.commit ?? BASELINE,
      ),
    sourceBundleArtifact:
      input.sourceBundleArtifact ??
      sourceBundleArtifact(
        `source-bundle-${input.commit ?? BASELINE}`,
        input.commit ?? BASELINE,
      ),
    createdAt: "2026-07-26T09:10:00.000Z",
    passed: true as const,
  };
  const signedBody = input.mutate?.(body) ?? body;
  return {
    ...signedBody,
    signature: createEd25519Signature(
      signedBody,
      sourceKeys.privateKey,
      SOURCE_KEY_ID,
      "2026-07-26T09:11:00.000Z",
    ),
  } as unknown as TrustedGitSourceSnapshotReceipt;
}

function context(input: {
  readonly number?: number;
  readonly slug?: string;
  readonly commit?: string;
  readonly activeExperiment?: number;
  readonly brief?: OptimizerContext["diagnosticBrief"];
} = {}): OptimizerContext {
  const number = input.number ?? 1;
  const activeExperiment = input.activeExperiment ?? 0;
  return {
    experiment: {
      number,
      slug: input.slug ?? "source-bootstrap",
      kind: "optimization",
      parentExperiment: activeExperiment,
      lineageId: CAMPAIGN,
      protocolHash: PROTOCOL,
    },
    activeChampion: {
      baselineCommit: BASELINE,
      activeExperiment,
      activeCommit: input.commit ?? BASELINE,
      certifiedExperiment: null,
      certifiedCommit: null,
      updatedAt: "2026-07-26T09:20:00.000Z",
      sourceSealHash: "2".repeat(64),
    },
    diagnosticBrief: input.brief ?? null,
    sourceOnlyBootstrap: number === 1,
  };
}

function commonMetadata(
  evidence: TrustedCloudArtifactRef,
) {
  return {
    schemaVersion: 1 as const,
    artifact: evidence,
    releaseSafetyAttestationHash: "3".repeat(64),
    containsTaskIdentifiers: false as const,
    containsPanelIdentifiers: false as const,
    containsCellIdentifiers: false as const,
    containsRawEvidence: false as const,
    containsGraderIdentifiers: false as const,
    issuedAt: "2026-07-26T09:30:00.000Z",
    keyVersion: KEY_VERSION,
  };
}

function sealMetadata<
  T extends Readonly<Record<string, unknown>>,
>(
  body: T,
  privateKey: KeyObject,
  keyId: string,
): T & {
  readonly metadataHash: string;
  readonly signature: ReturnType<typeof createEd25519Signature>;
} {
  const withHash = {
    ...body,
    metadataHash: canonicalHash(body),
  };
  return {
    ...withHash,
    signature: createEd25519Signature(
      withHash,
      privateKey,
      keyId,
      "2026-07-26T09:31:00.000Z",
    ),
  };
}

function bootstrapMetadata(
  evidence = artifact(
    "bootstrap-evidence",
    "4".repeat(64),
    "application/x-tar",
  ),
): OptimizerSourceOnlyBootstrapEvidenceMetadata {
  return sealMetadata(
    {
      ...commonMetadata(evidence),
      domain:
        "dark-factory.optimizer-source-only-bootstrap-evidence.v1" as const,
      purpose: "source-only-bootstrap" as const,
      reviewed: true as const,
      reviewPolicyHash: "5".repeat(64),
    },
    bootstrapKeys.privateKey,
    BOOTSTRAP_KEY_ID,
  );
}

function proposalMetadata(input: {
  readonly experimentId: string;
  readonly diagnosticHash: string;
  readonly releaseId: string;
  readonly actionable: boolean;
  readonly evidence?: TrustedCloudArtifactRef;
}): OptimizerProposalDiagnosticEvidenceMetadata {
  return sealMetadata(
    {
      ...commonMetadata(
        input.evidence ??
          artifact(
            `proposal-${input.releaseId}`,
            "6".repeat(64),
            "application/x-tar",
          ),
      ),
      domain:
        "dark-factory.optimizer-proposal-diagnostic-evidence.v1" as const,
      purpose: "proposal-diagnostic" as const,
      campaignId: CAMPAIGN,
      experimentId: input.experimentId,
      diagnosticHash: input.diagnosticHash,
      releaseId: input.releaseId,
      actionable: input.actionable,
    },
    proposalKeys.privateKey,
    PROPOSAL_KEY_ID,
  );
}

const hypothesis = {
  hash: "7".repeat(64),
  sourceBriefHash: "8".repeat(64),
  causalClaim: "Generic retry recovery is too weak.",
  intervention: "Add bounded generic recovery guidance.",
  predictedRepairBehavior: "More calls recover after a safe retry.",
  predictedFreshEffect: "Recovery improves without task knowledge.",
  falsificationCriteria: ["No matched improvement."],
  rollbackCondition: "A fresh regression is observed.",
};

const candidate = {
  commit: CANDIDATE,
  patchHash: "9".repeat(64),
  changedFiles: ["packages/coding-agent/src/system-prompt.ts"],
  mutationCategory: "generic-recovery",
};

const inspectionPolicyBody = {
  schemaVersion: 1 as const,
  domain:
    "dark-factory.optimizer-release-artifact-inspection-policy.v1" as const,
  evaluatorPolicyHash: "f".repeat(64),
  allowedReleasePaths: ["release.json"] as readonly string[],
  forbiddenContentFingerprints: [] as readonly string[],
  graderCanaryFingerprints: ["0".repeat(64)] as readonly string[],
};
const inspectionPolicy = {
  ...inspectionPolicyBody,
  policyHash: canonicalHash(inspectionPolicyBody),
};

function policyWithCanary(literal: string) {
  const graderCanaryFingerprints = [
    canonicalHash({
      domain: "dark-factory.release-literal-fingerprint.v1",
      literal: literal.trim().toLocaleLowerCase("en-US"),
    }),
  ];
  const body = {
    ...inspectionPolicyBody,
    graderCanaryFingerprints,
  };
  return {
    ...body,
    policyHash: canonicalHash(body),
  };
}

const repair = {
  disposition: "passed",
  attemptOrdinal: 1,
  integrityPassed: true,
  cacheStatus: "not-used",
  aggregateCostUsd: 1,
  tokens: 100,
  wallTimeMs: 1000,
  attempts: 3,
  attestationHash: "a".repeat(64),
} satisfies RepairAggregate;

function validation(
  releasedEvidenceHash: string | null = "b".repeat(64),
): ValidationAggregate {
  return {
    disposition: "promoted",
    validPairs: 12,
    validArms: 24,
    replacementAttempts: 0,
    probabilityPositive: 0.99,
    medianAccuracyDelta: 0.05,
    requiredPosteriorProbability: 0.95,
    onlineGateAuthorized: true,
    onlineErrorBudget: {
      policyVersion: "online-alpha-spending-v1",
      maximumOnlineError: 0.05,
      gateOrdinal: 1,
      alphaSpent: 0.01,
      cumulativeSpentBefore: 0,
      cumulativeSpentAfter: 0.01,
      remainingAfter: 0.04,
      reservationHash: "d".repeat(64),
      priorStateHash: "e".repeat(64),
      resultingStateHash: "f".repeat(64),
    },
    stratumRegressionVeto: false,
    integrityVeto: false,
    correctnessVeto: false,
    capabilityVeto: false,
    costWithinGuardrail: true,
    latencyWithinGuardrail: true,
    accuracyTradeoffPredeclared: false,
    aggregateCostUsd: 2,
    tokens: 200,
    wallTimeMs: 2000,
    attestationHash: "c".repeat(64),
    releasedEvidenceHash,
    behavioralSourceCommitmentHash:
      releasedEvidenceHash === null ? null : "9".repeat(64),
    attemptAccounting: {
      policyVersion: "validation-attempt-ledger-v1",
      terminalStatus: "complete",
      presealedPairCount: 12,
      presealedArmCount: 24,
      validArmCount: 24,
      attemptedArmCount: 24,
      unresolvedArmCount: 0,
      totalAttemptCount: 24,
      replacementAttemptCount: 0,
      infrastructureFailureCount: 0,
      nonInfrastructureFailureCount: 0,
      containsPanelHandle: false,
      containsTaskIdentifiers: false,
      containsCellIdentifiers: false,
      containsAttemptIdentifiers: false,
      containsEvidenceIdentifiers: false,
    },
  };
}

function analysisMetadata(input: {
  readonly query: Extract<
    OptimizerReleasedEvidenceQuery,
    { readonly purpose: "analysis" }
  >;
  readonly evidence?: TrustedCloudArtifactRef;
  readonly overrides?: Partial<OptimizerAnalysisEvidenceMetadata>;
}): OptimizerAnalysisEvidenceMetadata {
  return sealMetadata(
    {
      ...commonMetadata(
        input.evidence ??
          artifact(
            "analysis-evidence",
            "d".repeat(64),
            "application/x-tar",
          ),
      ),
      domain:
        "dark-factory.optimizer-analysis-evidence.v1" as const,
      purpose: "analysis" as const,
      campaignId: input.query.campaignId,
      experimentId: input.query.experimentId,
      hypothesisHash: input.query.hypothesisHash,
      hypothesisDocumentHash:
        input.query.hypothesisDocumentHash,
      candidateCommit: input.query.candidateCommit,
      candidatePatchHash: input.query.candidatePatchHash,
      candidateDocumentHash: input.query.candidateDocumentHash,
      repairAttestationHash:
        input.query.repairAttestationHash,
      validationAttestationHash:
        input.query.validationAttestationHash,
      releasedEvidenceHash: input.query.releasedEvidenceHash,
      ...input.overrides,
    },
    analysisKeys.privateKey,
    ANALYSIS_KEY_ID,
  ) as OptimizerAnalysisEvidenceMetadata;
}

function metadataArtifact(
  name: string,
  metadata: OptimizerReleasedEvidenceMetadata,
): {
  readonly artifact: TrustedCloudArtifactRef;
  readonly raw: string;
} {
  const raw = `${canonicalJson(metadata)}\n`;
  return {
    artifact: artifact(
      name,
      sha256(raw),
      "application/json",
      Buffer.byteLength(raw, "utf8"),
    ),
    raw,
  };
}

function keyMaterial(
  request: OptimizerResolverPublicKeyRequest,
  options: {
    readonly purpose?: OptimizerResolverSignaturePurpose;
    readonly revoked?: boolean;
    readonly keyVersion?: string;
    readonly publicKey?: KeyObject;
  } = {},
): TrustedOptimizerResolverPublicKey {
  const byPurpose: Record<
    OptimizerResolverSignaturePurpose,
    KeyObject
  > = {
    "git-source-snapshot-receipt": sourceKeys.publicKey,
    "optimizer-source-only-bootstrap-evidence":
      bootstrapKeys.publicKey,
    "optimizer-proposal-diagnostic-evidence":
      proposalKeys.publicKey,
    "optimizer-analysis-evidence": analysisKeys.publicKey,
  };
  return {
    boundary: "trusted-cloud-key-material",
    algorithm: "Ed25519",
    purpose: options.purpose ?? request.purpose,
    keyId: request.keyId,
    keyVersion: options.keyVersion ?? KEY_VERSION,
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z",
    revoked: options.revoked ?? false,
    authoritySetHash: request.authoritySetHash,
    verificationKeySetHash: request.verificationKeySetHash,
    publicKeySpkiDer: new Uint8Array(
      (options.publicKey ?? byPurpose[request.purpose]).export({
        format: "der",
        type: "spki",
      }),
    ),
  };
}

interface FixtureOptions {
  readonly pinnedRegistration?: RepositoryRegistration;
  readonly receipts?: readonly TrustedGitSourceSnapshotReceipt[];
  readonly authorityMutate?: (
    key: TrustedOptimizerResolverPublicKey,
    request: OptimizerResolverPublicKeyRequest,
  ) => TrustedOptimizerResolverPublicKey;
  readonly readerMutatesArtifact?: boolean;
  readonly releaseReaderMutatesArtifact?: boolean;
  readonly policy?: typeof inspectionPolicy;
}

function fixture(options: FixtureOptions = {}) {
  const receipts =
    options.receipts ?? [sourceReceipt()];
  const byCommit = new Map(
    receipts.map((receipt) => [receipt.commitSha, receipt]),
  );
  const rawByUri = new Map<string, string>();
  const locatedByQuery = new Map<
    string,
    readonly TrustedCloudArtifactRef[]
  >();
  const bootstrap = metadataArtifact(
    "bootstrap-metadata",
    bootstrapMetadata(),
  );
  rawByUri.set(bootstrap.artifact.uri, bootstrap.raw);
  const locate = vi.fn(async (query: OptimizerReleasedEvidenceQuery) =>
    locatedByQuery.get(query.queryHash) ?? [],
  );
  const readUtf8 = vi.fn(
    async (
      inputArtifact: TrustedCloudArtifactRef,
    ): Promise<string> => {
      if (options.readerMutatesArtifact) {
        (
          inputArtifact as { sha256: string }
        ).sha256 = "f".repeat(64);
      }
      const raw = rawByUri.get(inputArtifact.uri);
      if (raw === undefined) throw new Error("missing");
      return raw;
    },
  );
  const readBytes = vi.fn(
    async (
      inputArtifact: TrustedCloudArtifactRef,
    ): Promise<Uint8Array> => {
      if (options.releaseReaderMutatesArtifact) {
        (
          inputArtifact as { sha256: string }
        ).sha256 = "f".repeat(64);
      }
      const bytes = bytesByUri.get(inputArtifact.uri);
      if (bytes === undefined) throw new Error("missing");
      return Uint8Array.from(bytes);
    },
  );
  const resolver = new ArtifactBackedCloudOptimizerAdapterResolver({
    sourceIndex: {
      boundary: "trusted-cloud",
      findByCommit: async (commit) => byCommit.get(commit),
    },
    registration:
      options.pinnedRegistration ?? registration(),
    sourceOnlyBootstrapMetadataArtifact: bootstrap.artifact,
    evidenceSource: {
      boundary: "trusted-cloud",
      locate,
    },
    artifactReader: {
      boundary: "trusted-cloud",
      readUtf8,
    },
    releaseArtifactReader: {
      boundary:
        "trusted-cloud-optimizer-release-artifact-reader",
      readBytes,
    },
    releaseArtifactInspectionPolicy:
      options.policy ?? inspectionPolicy,
    keyAuthority: {
      boundary:
        "trusted-cloud-optimizer-resolver-public-key-authority",
      resolve: async (request) => {
        const key = keyMaterial(request);
        return options.authorityMutate?.(key, request) ?? key;
      },
    },
    authoritySetHash: AUTHORITY_SET,
    verificationKeySetHash: KEY_SET,
  });
  return {
    resolver,
    locate,
    readUtf8,
    readBytes,
    rawByUri,
    locatedByQuery,
    addMetadata(
      queryHash: string,
      metadata: OptimizerReleasedEvidenceMetadata,
      name = `metadata-${rawByUri.size}`,
    ) {
      const value = metadataArtifact(name, metadata);
      rawByUri.set(value.artifact.uri, value.raw);
      locatedByQuery.set(queryHash, [value.artifact]);
      return value;
    },
  };
}

function laterContext(input: {
  readonly number?: number;
  readonly slug?: string;
  readonly brief?: OptimizerContext["diagnosticBrief"];
} = {}): OptimizerContext {
  return context({
    number: input.number ?? 2,
    slug: input.slug ?? "use-diagnostic",
    commit: CANDIDATE,
    activeExperiment: 1,
    brief:
      input.brief ?? {
        hash: "e".repeat(64),
        releaseId: "release-001",
        actionable: true,
      },
  });
}

function analysisInput() {
  return {
    experiment: laterContext().experiment,
    hypothesis,
    candidate,
    repair,
    validation: validation(),
  };
}

async function captureAnalysisQuery(
  configured: ReturnType<typeof fixture>,
) {
  const holder: {
    value?: Extract<
      OptimizerReleasedEvidenceQuery,
      { readonly purpose: "analysis" }
    >;
  } = {};
  configured.locate.mockImplementationOnce(async (query) => {
    if (query.purpose === "analysis") holder.value = query;
    return [];
  });
  await expect(
    configured.resolver.analysis(analysisInput()),
  ).rejects.toBeInstanceOf(
    ArtifactBackedCloudOptimizerAdapterResolverError,
  );
  if (holder.value === undefined) {
    throw new Error("query not captured");
  }
  return holder.value;
}

async function captureProposalQuery(
  configured: ReturnType<typeof fixture>,
  proposalContext: OptimizerContext,
) {
  const holder: {
    value?: Extract<
      OptimizerReleasedEvidenceQuery,
      { readonly purpose: "proposal-diagnostic" }
    >;
  } = {};
  configured.locate.mockImplementationOnce(async (query) => {
    if (query.purpose === "proposal-diagnostic") {
      holder.value = query;
    }
    return [];
  });
  await expect(
    configured.resolver.proposal(proposalContext),
  ).rejects.toBeInstanceOf(
    ArtifactBackedCloudOptimizerAdapterResolverError,
  );
  if (holder.value === undefined) {
    throw new Error("proposal query not captured");
  }
  return holder.value;
}

describe("artifact-backed production optimizer resolver", () => {
  it("requires an active grader-canary fingerprint in the inspection policy", () => {
    const body = {
      ...inspectionPolicyBody,
      graderCanaryFingerprints: [] as readonly string[],
    };
    const policy = {
      ...body,
      policyHash: canonicalHash(body),
    };

    expect(() => fixture({ policy })).toThrow(
      ArtifactBackedCloudOptimizerAdapterResolverError,
    );
  });

  it("resolves a signed baseline bundle and fixed bootstrap", async () => {
    const configured = fixture();
    const result = await configured.resolver.proposal(context());

    expect(result.source).toEqual({
      mode: "trusted-bundle",
      registrationId: registration().registrationId,
      originRepositoryHash:
        registration().originFingerprint.repositoryHash,
      bundle: sourceReceipt().sourceBundleArtifact,
      bundleRef: TRUSTED_GIT_SOURCE_BUNDLE_REF,
      target: {
        remoteRef: TRUSTED_GIT_SOURCE_BUNDLE_REF,
        commitSha: BASELINE,
        treeSha: BASELINE_TREE,
        lockSha256: LOCK,
      },
    });
    expect(result.releasedEvidence).toEqual(
      bootstrapMetadata().artifact,
    );
    expect(configured.locate).not.toHaveBeenCalled();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.source)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(
      "/Users/operator",
    );

    const retry = await configured.resolver.proposal(context());
    expect(retry).toEqual(result);
    expect(configured.readUtf8).toHaveBeenCalledTimes(1);
  });

  it("resolves a later proposal only from the exact released brief", async () => {
    const candidateReceipt = sourceReceipt({
      commit: CANDIDATE,
      tree: CANDIDATE_TREE,
      remoteRef:
        "refs/heads/df/experiment/001-source-bootstrap",
    });
    const configured = fixture({
      receipts: [candidateReceipt],
    });
    const proposalContext = laterContext();
    const query = await captureProposalQuery(
      configured,
      proposalContext,
    );
    const metadata = proposalMetadata({
      experimentId: query.experimentId,
      diagnosticHash: query.diagnosticHash,
      releaseId: query.releaseId,
      actionable: query.actionable,
    });
    configured.addMetadata(query.queryHash, metadata);
    configured.locate.mockImplementation(async (value) =>
      configured.locatedByQuery.get(value.queryHash) ?? [],
    );

    const result =
      await configured.resolver.proposal(proposalContext);
    expect(result.source.target.commitSha).toBe(CANDIDATE);
    expect(result.releasedEvidence).toEqual(metadata.artifact);
  });

  it("binds analysis evidence to every proposal and evaluation commitment", async () => {
    const configured = fixture();
    const query = await captureAnalysisQuery(configured);
    const metadata = analysisMetadata({ query });
    configured.addMetadata(query.queryHash, metadata);
    configured.locate.mockImplementation(async (value) =>
      configured.locatedByQuery.get(value.queryHash) ?? [],
    );

    await expect(
      configured.resolver.analysis(analysisInput()),
    ).resolves.toEqual({
      releasedEvidence: metadata.artifact,
    });
  });

  it.each([
    {
      label: "baseline tree",
      receipt: sourceReceipt({ tree: "f".repeat(40) }),
      pinned: registration(),
    },
    {
      label: "registration",
      receipt: sourceReceipt(),
      pinned: registration({ registrationId: "0".repeat(64) }),
    },
    {
      label: "origin",
      receipt: sourceReceipt(),
      pinned: registration({
        originFingerprint: {
          ...registration().originFingerprint,
          repositoryHash: "0".repeat(64),
        },
      }),
    },
  ])("rejects a source with a mismatched $label", async ({ receipt, pinned }) => {
    const configured = fixture({
      receipts: [receipt],
      pinnedRegistration: pinned,
    });
    await expect(
      configured.resolver.proposal(context()),
    ).rejects.toBeInstanceOf(
      ArtifactBackedCloudOptimizerAdapterResolverError,
    );
  });

  it.each([
    ["experiment", "999-other", "e".repeat(64), "release-001", true],
    ["hash", "002-use-diagnostic", "0".repeat(64), "release-001", true],
    ["release", "002-use-diagnostic", "e".repeat(64), "release-999", true],
    ["actionable", "002-use-diagnostic", "e".repeat(64), "release-001", false],
  ])("rejects validly signed proposal metadata with wrong %s", async (
    _label,
    experimentId,
    diagnosticHash,
    releaseId,
    actionable,
  ) => {
    const candidateReceipt = sourceReceipt({
      commit: CANDIDATE,
      tree: CANDIDATE_TREE,
      remoteRef:
        "refs/heads/df/experiment/001-source-bootstrap",
    });
    const configured = fixture({ receipts: [candidateReceipt] });
    const proposalContext = laterContext();
    const query = await captureProposalQuery(
      configured,
      proposalContext,
    );
    configured.addMetadata(
      query.queryHash,
      proposalMetadata({
        experimentId,
        diagnosticHash,
        releaseId,
        actionable,
      }),
    );
    configured.locate.mockImplementation(async (value) =>
      configured.locatedByQuery.get(value.queryHash) ?? [],
    );
    await expect(
      configured.resolver.proposal(proposalContext),
    ).rejects.toBeInstanceOf(
      ArtifactBackedCloudOptimizerAdapterResolverError,
    );
  });

  it("rejects analysis metadata detached from the candidate or released result", async () => {
    const configured = fixture();
    const query = await captureAnalysisQuery(configured);
    configured.addMetadata(
      query.queryHash,
      analysisMetadata({
        query,
        overrides: {
          candidateCommit: "f".repeat(40),
          releasedEvidenceHash: "0".repeat(64),
        },
      }),
    );
    configured.locate.mockImplementation(async (value) =>
      configured.locatedByQuery.get(value.queryHash) ?? [],
    );
    await expect(
      configured.resolver.analysis(analysisInput()),
    ).rejects.toBeInstanceOf(
      ArtifactBackedCloudOptimizerAdapterResolverError,
    );
  });

  it.each(["purpose", "revoked", "substituted", "version"])(
    "rejects %s trusted-key authority output",
    async (mode) => {
      const configured = fixture({
        authorityMutate(key) {
          if (
            key.purpose !==
            "optimizer-source-only-bootstrap-evidence"
          ) {
            return key;
          }
          if (mode === "purpose") {
            return {
              ...key,
              purpose: "optimizer-analysis-evidence",
            };
          }
          if (mode === "revoked") return { ...key, revoked: true };
          if (mode === "version") {
            return { ...key, keyVersion: "v2" };
          }
          return keyMaterial(
            {
              schemaVersion: 1,
              domain:
                "dark-factory.optimizer-resolver-public-key-request.v1",
              purpose: key.purpose,
              keyId: key.keyId,
              keyVersion: key.keyVersion,
              signedAt: "2026-07-26T09:31:00.000Z",
              documentHash: "0".repeat(64),
              authoritySetHash: key.authoritySetHash,
              verificationKeySetHash:
                key.verificationKeySetHash,
            },
            { publicKey: substitutedKeys.publicKey },
          );
        },
      });
      await expect(
        configured.resolver.proposal(context()),
      ).rejects.toBeInstanceOf(
        ArtifactBackedCloudOptimizerAdapterResolverError,
      );
    },
  );

  it("rejects task-shaped metadata extras", async () => {
    const candidateReceipt = sourceReceipt({
      commit: CANDIDATE,
      tree: CANDIDATE_TREE,
      remoteRef:
        "refs/heads/df/experiment/001-source-bootstrap",
    });
    const configured = fixture({ receipts: [candidateReceipt] });
    const proposalContext = laterContext();
    const query = await captureProposalQuery(
      configured,
      proposalContext,
    );
    const valid = proposalMetadata({
      experimentId: query.experimentId,
      diagnosticHash: query.diagnosticHash,
      releaseId: query.releaseId,
      actionable: query.actionable,
    });
    const extra = metadataArtifact(
      "metadata-with-extra",
      {
        ...valid,
        taskName: "must-not-be-representable",
      } as unknown as OptimizerProposalDiagnosticEvidenceMetadata,
    );
    configured.rawByUri.set(extra.artifact.uri, extra.raw);
    configured.locatedByQuery.set(query.queryHash, [extra.artifact]);
    configured.locate.mockImplementation(async (value) =>
      configured.locatedByQuery.get(value.queryHash) ?? [],
    );
    await expect(
      configured.resolver.proposal(proposalContext),
    ).rejects.toBeInstanceOf(
      ArtifactBackedCloudOptimizerAdapterResolverError,
    );
  });

  it.each([
    {
      label: "protected absolute path",
      evidence: tarArtifact("release-with-root-path", [
        {
          path: "release.json",
          content: `${canonicalJson({
            schemaVersion: 1,
            summary: "Inspect /root/private/grader.txt.",
          })}\n`,
        },
      ]),
    },
    {
      label: "encoded printable payload",
      evidence: tarArtifact("release-with-encoded-payload", [
        {
          path: "release.json",
          content: `${canonicalJson({
            schemaVersion: 1,
            summary: Buffer.from(
              "/private/grader/answer.txt",
              "utf8",
            ).toString("base64url"),
          })}\n`,
        },
      ]),
    },
    {
      label: "traversal entry",
      evidence: tarArtifact("release-with-traversal", [
        {
          path: "../leak.json",
          content: `${canonicalJson({
            schemaVersion: 1,
            summary: "Generic aggregate.",
          })}\n`,
        },
      ]),
    },
    {
      label: "link entry",
      evidence: tarArtifact("release-with-link", [
        {
          path: "release.json",
          content: "",
          type: "symlink",
          linkName: "/var/private/grader.json",
        },
      ]),
    },
    {
      label: "nested archive",
      evidence: tarArtifact("release-with-nested-archive", [
        {
          path: "hidden.tar",
          content: "not a nested archive",
        },
      ]),
    },
  ])(
    "opens signed false-flag evidence and rejects its $label",
    async ({ evidence }) => {
      const candidateReceipt = sourceReceipt({
        commit: CANDIDATE,
        tree: CANDIDATE_TREE,
        remoteRef:
          "refs/heads/df/experiment/001-source-bootstrap",
      });
      const configured = fixture({
        receipts: [candidateReceipt],
      });
      const proposalContext = laterContext();
      const query = await captureProposalQuery(
        configured,
        proposalContext,
      );
      configured.addMetadata(
        query.queryHash,
        proposalMetadata({
          experimentId: query.experimentId,
          diagnosticHash: query.diagnosticHash,
          releaseId: query.releaseId,
          actionable: query.actionable,
          evidence,
        }),
      );
      configured.locate.mockImplementation(async (value) =>
        configured.locatedByQuery.get(value.queryHash) ?? [],
      );

      await expect(
        configured.resolver.proposal(proposalContext),
      ).rejects.toBeInstanceOf(
        ArtifactBackedCloudOptimizerAdapterResolverError,
      );
    },
  );

  it("rejects an exact protected canary from archive content", async () => {
    const canary = "violet-orchid-release-needle";
    const candidateReceipt = sourceReceipt({
      commit: CANDIDATE,
      tree: CANDIDATE_TREE,
      remoteRef:
        "refs/heads/df/experiment/001-source-bootstrap",
    });
    const configured = fixture({
      receipts: [candidateReceipt],
      policy: policyWithCanary(canary),
    });
    const proposalContext = laterContext();
    const query = await captureProposalQuery(
      configured,
      proposalContext,
    );
    const evidence = tarArtifact("release-with-canary", [
      {
        path: "release.json",
        content: `${canonicalJson({
          schemaVersion: 1,
          summary: canary,
        })}\n`,
      },
    ]);
    configured.addMetadata(
      query.queryHash,
      proposalMetadata({
        experimentId: query.experimentId,
        diagnosticHash: query.diagnosticHash,
        releaseId: query.releaseId,
        actionable: query.actionable,
        evidence,
      }),
    );
    configured.locate.mockImplementation(async (value) =>
      configured.locatedByQuery.get(value.queryHash) ?? [],
    );

    await expect(
      configured.resolver.proposal(proposalContext),
    ).rejects.toBeInstanceOf(
      ArtifactBackedCloudOptimizerAdapterResolverError,
    );
  });

  it("rejects a release file outside the campaign path allowlist", async () => {
    const candidateReceipt = sourceReceipt({
      commit: CANDIDATE,
      tree: CANDIDATE_TREE,
      remoteRef:
        "refs/heads/df/experiment/001-source-bootstrap",
    });
    const configured = fixture({
      receipts: [candidateReceipt],
    });
    const proposalContext = laterContext();
    const query = await captureProposalQuery(
      configured,
      proposalContext,
    );
    const evidence = tarArtifact("release-with-unlisted-path", [
      {
        path: "unexpected.json",
        content: `${canonicalJson({
          schemaVersion: 1,
          summary: "Generic aggregate evidence.",
        })}\n`,
      },
    ]);
    configured.addMetadata(
      query.queryHash,
      proposalMetadata({
        experimentId: query.experimentId,
        diagnosticHash: query.diagnosticHash,
        releaseId: query.releaseId,
        actionable: query.actionable,
        evidence,
      }),
    );
    configured.locate.mockImplementation(async (value) =>
      configured.locatedByQuery.get(value.queryHash) ?? [],
    );

    await expect(
      configured.resolver.proposal(proposalContext),
    ).rejects.toBeInstanceOf(
      ArtifactBackedCloudOptimizerAdapterResolverError,
    );
  });

  it("rejects protected benchmark material in the signed source tree archive", async () => {
    const protectedSource = sourceArtifact(
      "source-with-benchmark-material",
      BASELINE,
      [
        {
          path: "terminal-bench/tasks/hidden/task.yaml",
          content: "instruction: hidden",
        },
      ],
    );
    const configured = fixture({
      receipts: [
        sourceReceipt({ sourceArtifact: protectedSource }),
      ],
    });

    await expect(
      configured.resolver.proposal(context()),
    ).rejects.toBeInstanceOf(
      ArtifactBackedCloudOptimizerAdapterResolverError,
    );
  });

  it.each([
    {
      label: "source-tree commit header",
      receipt: sourceReceipt({
        sourceArtifact: sourceArtifact(
          "source-with-detached-commit-header",
          CANDIDATE,
        ),
      }),
    },
    {
      label: "Git-bundle advertised commit",
      receipt: sourceReceipt({
        sourceBundleArtifact: sourceBundleArtifact(
          "bundle-with-detached-advertisement",
          CANDIDATE,
        ),
      }),
    },
  ])("rejects a detached $label", async ({ receipt }) => {
    const configured = fixture({ receipts: [receipt] });

    await expect(
      configured.resolver.proposal(context()),
    ).rejects.toBeInstanceOf(
      ArtifactBackedCloudOptimizerAdapterResolverError,
    );
  });

  it("rejects a protected canary hidden in an otherwise ordinary source file", async () => {
    const canary = "violet orchid release needle";
    const protectedSource = sourceArtifact(
      "source-with-protected-canary",
      BASELINE,
      [
        {
          path: "packages/coding-agent/src/constants.ts",
          content: `export const marker = "${canary}";\n`,
        },
      ],
    );
    const configured = fixture({
      receipts: [
        sourceReceipt({ sourceArtifact: protectedSource }),
      ],
      policy: policyWithCanary(canary),
    });

    await expect(
      configured.resolver.proposal(context()),
    ).rejects.toBeInstanceOf(
      ArtifactBackedCloudOptimizerAdapterResolverError,
    );
  });

  it("rejects ambiguous immutable metadata matches", async () => {
    const candidateReceipt = sourceReceipt({
      commit: CANDIDATE,
      tree: CANDIDATE_TREE,
      remoteRef:
        "refs/heads/df/experiment/001-source-bootstrap",
    });
    const configured = fixture({ receipts: [candidateReceipt] });
    const proposalContext = laterContext();
    const query = await captureProposalQuery(
      configured,
      proposalContext,
    );
    const valid = proposalMetadata({
      experimentId: query.experimentId,
      diagnosticHash: query.diagnosticHash,
      releaseId: query.releaseId,
      actionable: query.actionable,
    });
    const first = metadataArtifact("ambiguous-a", valid);
    const second = metadataArtifact("ambiguous-b", valid);
    configured.rawByUri.set(first.artifact.uri, first.raw);
    configured.rawByUri.set(second.artifact.uri, second.raw);
    configured.locatedByQuery.set(query.queryHash, [
      first.artifact,
      second.artifact,
    ]);
    configured.locate.mockImplementation(async (value) =>
      configured.locatedByQuery.get(value.queryHash) ?? [],
    );
    await expect(
      configured.resolver.proposal(proposalContext),
    ).rejects.toBeInstanceOf(
      ArtifactBackedCloudOptimizerAdapterResolverError,
    );
  });

  it("rejects mutation across asynchronous source and reader boundaries", async () => {
    const mutatedReader = fixture({
      readerMutatesArtifact: true,
    });
    await expect(
      mutatedReader.resolver.proposal(context()),
    ).rejects.toBeInstanceOf(
      ArtifactBackedCloudOptimizerAdapterResolverError,
    );

    const mutatedReleaseReader = fixture({
      releaseReaderMutatesArtifact: true,
    });
    await expect(
      mutatedReleaseReader.resolver.proposal(context()),
    ).rejects.toBeInstanceOf(
      ArtifactBackedCloudOptimizerAdapterResolverError,
    );

    const mutableContext = context();
    const receipt = sourceReceipt();
    const bootstrap = metadataArtifact(
      "bootstrap-mutation",
      bootstrapMetadata(),
    );
    const resolver = new ArtifactBackedCloudOptimizerAdapterResolver({
      sourceIndex: {
        boundary: "trusted-cloud",
        async findByCommit() {
          (
            mutableContext.activeChampion as {
              activeCommit: string;
            }
          ).activeCommit = "f".repeat(40);
          return receipt;
        },
      },
      registration: registration(),
      sourceOnlyBootstrapMetadataArtifact: bootstrap.artifact,
      evidenceSource: {
        boundary: "trusted-cloud",
        locate: async () => [],
      },
      artifactReader: {
        boundary: "trusted-cloud",
        readUtf8: async () => bootstrap.raw,
      },
      releaseArtifactReader: {
        boundary:
          "trusted-cloud-optimizer-release-artifact-reader",
        readBytes: async (artifact_) => {
          const bytes = bytesByUri.get(artifact_.uri);
          if (bytes === undefined) throw new Error("missing");
          return Uint8Array.from(bytes);
        },
      },
      releaseArtifactInspectionPolicy: inspectionPolicy,
      keyAuthority: {
        boundary:
          "trusted-cloud-optimizer-resolver-public-key-authority",
        resolve: async (request) => keyMaterial(request),
      },
      authoritySetHash: AUTHORITY_SET,
      verificationKeySetHash: KEY_SET,
    });
    await expect(
      resolver.proposal(mutableContext),
    ).rejects.toBeInstanceOf(
      ArtifactBackedCloudOptimizerAdapterResolverError,
    );
  });

  it("burns cross-query replay while preserving exact retries", async () => {
    const candidateReceipt = sourceReceipt({
      commit: CANDIDATE,
      tree: CANDIDATE_TREE,
      remoteRef:
        "refs/heads/df/experiment/001-source-bootstrap",
    });
    const configured = fixture({ receipts: [candidateReceipt] });
    const sharedEvidence = artifact(
      "shared-evidence",
      "f".repeat(64),
      "application/x-tar",
    );
    const firstContext = laterContext();
    const secondContext = laterContext({
      number: 3,
      slug: "replay-attempt",
      brief: {
        hash: "0".repeat(64),
        releaseId: "release-002",
        actionable: true,
      },
    });
    const queries: OptimizerReleasedEvidenceQuery[] = [];
    configured.locate.mockImplementation(async (value) => {
      queries.push(value);
      return configured.locatedByQuery.get(value.queryHash) ?? [];
    });
    await configured.resolver.proposal(firstContext).catch(
      () => undefined,
    );
    const firstQuery = queries.at(-1);
    if (firstQuery?.purpose !== "proposal-diagnostic") {
      throw new Error("first query missing");
    }
    configured.addMetadata(
      firstQuery.queryHash,
      proposalMetadata({
        experimentId: firstQuery.experimentId,
        diagnosticHash: firstQuery.diagnosticHash,
        releaseId: firstQuery.releaseId,
        actionable: firstQuery.actionable,
        evidence: sharedEvidence,
      }),
    );
    await expect(
      configured.resolver.proposal(firstContext),
    ).resolves.toMatchObject({ releasedEvidence: sharedEvidence });
    await expect(
      configured.resolver.proposal(firstContext),
    ).resolves.toMatchObject({ releasedEvidence: sharedEvidence });
    const reboundEvidence = {
      ...sharedEvidence,
      uri: "trusted://optimizer-resolver/shared-evidence-rebound",
    } as TrustedCloudArtifactRef;
    const sharedBytes = bytesByUri.get(sharedEvidence.uri);
    if (sharedBytes === undefined) {
      throw new Error("shared evidence bytes missing");
    }
    bytesByUri.set(reboundEvidence.uri, sharedBytes);
    const readsBeforeRebound =
      configured.readBytes.mock.calls.length;

    await configured.resolver.proposal(secondContext).catch(
      () => undefined,
    );
    const secondQuery = queries.at(-1);
    if (secondQuery?.purpose !== "proposal-diagnostic") {
      throw new Error("second query missing");
    }
    configured.addMetadata(
      secondQuery.queryHash,
      proposalMetadata({
        experimentId: secondQuery.experimentId,
        diagnosticHash: secondQuery.diagnosticHash,
        releaseId: secondQuery.releaseId,
        actionable: secondQuery.actionable,
        evidence: reboundEvidence,
      }),
    );
    await expect(
      configured.resolver.proposal(secondContext),
    ).rejects.toBeInstanceOf(
      ArtifactBackedCloudOptimizerAdapterResolverError,
    );
    expect(configured.readBytes).toHaveBeenCalledTimes(
      readsBeforeRebound + 1,
    );
  });
});
