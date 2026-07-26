import type { KeyLike } from "node:crypto";
import { requireCompatibleProvider } from "../cloud/probe.js";
import type {
  CloudSandboxProvider,
  RemoteCommandSpec,
  RemoteExecutionReceipt,
  SandboxCreateRequest,
  SandboxLease,
  TrustedCloudArtifactRef,
} from "../cloud/types.js";
import { verifyEd25519Signature } from "../evidence/signatures.js";
import { canonicalHash, canonicalJson, computeContentHash } from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import type { TrustedGitPublicationReceipt } from "./git-publication.js";
import { OFFICIAL_PI_UPSTREAM_URL, type RepositoryRegistration } from "./repository.js";
import {
  assertExactPlainObjectKeys,
  assertGitObjectId,
  assertRegisteredPrivateGitHubOrigin,
  assertSha256,
  assertSuccessfulCloudExecution,
  assertTrustedGitArtifact,
  assertTrustedGitPaths,
  assertTrustedGitSandbox,
  cloudExecutionReceiptHash,
  type PrivateGitHubOrigin,
  privateGitHubRemoteUrl,
  sameTrustedArtifact,
  TrustedGitContractError,
} from "./trusted-git.js";

const SOURCE_WORKING_DIRECTORY = "/workspace";
const SOURCE_WORKER_REMOTE_PATH = "/trusted/git/source-worker.mjs";
const SOURCE_ARCHIVE_REMOTE_PATH = "/trusted/git/candidate-source.tar";
const SOURCE_BUNDLE_REMOTE_PATH = "/trusted/git/candidate-source.bundle";
const SOURCE_MANIFEST_REMOTE_PATH = "/trusted/git/source-manifest.json";
export const TRUSTED_GIT_SOURCE_BUNDLE_REF = "refs/heads/df/bundle/000-source-snapshot" as const;

export interface GitSourceTarget {
  readonly remoteRef: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly lockSha256: string;
}

export function registeredBaselineGitSourceTarget(
  registration: RepositoryRegistration,
): GitSourceTarget {
  const target = {
    remoteRef: `refs/heads/${registration.branch}`,
    commitSha: registration.headCommit,
    treeSha: registration.treeSha,
    lockSha256: registration.lockSha256,
  };
  assertTarget(target);
  return target;
}

/** Call only after assertTrustedGitPublicationReceipt has accepted the receipt. */
export function publishedCandidateGitSourceTarget(
  receipt: TrustedGitPublicationReceipt,
): GitSourceTarget {
  const target = {
    remoteRef: receipt.branchRef,
    commitSha: receipt.candidateCommit,
    treeSha: receipt.candidateTree,
    lockSha256: receipt.lockSha256,
  };
  assertTarget(target);
  return target;
}

export interface TrustedGitSourceSnapshotSpec {
  readonly snapshotId: string;
  readonly registrationId: string;
  readonly originRepositoryHash: string;
  readonly upstreamRepositoryHash: string;
  readonly upstreamHeadCommit: string;
  readonly upstreamBaseCommit: string;
  readonly baselineCommit: string;
  readonly target: GitSourceTarget;
  readonly workerArtifact: TrustedCloudArtifactRef;
  readonly workerRemotePath: string;
  readonly archiveRemotePath: string;
  readonly bundleRemotePath: string;
  readonly bundleRef: typeof TRUSTED_GIT_SOURCE_BUNDLE_REF;
  readonly manifestRemotePath: string;
  readonly command: RemoteCommandSpec;
}

export interface TrustedGitSourceSnapshotReceipt {
  readonly sensitivity: "trusted-git-source-snapshot";
  readonly schemaVersion: 2;
  readonly snapshotId: string;
  readonly registrationId: string;
  readonly originRepositoryHash: string;
  readonly upstreamRepositoryHash: string;
  readonly upstreamHeadCommit: string;
  readonly upstreamBaseCommit: string;
  readonly baselineCommit: string;
  readonly provider: "daytona" | "e2b" | "modal";
  readonly sandboxId: string;
  readonly imageReference: string;
  readonly imageDigest: string;
  readonly networkPolicyHash: string;
  readonly remoteRef: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly lockSha256: string;
  readonly archiveMethod: "git-archive-format-tar";
  readonly compression: "none";
  readonly bundleMethod: "git-bundle-v2";
  readonly bundleRef: typeof TRUSTED_GIT_SOURCE_BUNDLE_REF;
  readonly workerSha256: string;
  readonly executionReceiptHash: string;
  readonly manifestArtifactSha256: string;
  readonly sourceArtifact: TrustedCloudArtifactRef;
  readonly sourceBundleArtifact: TrustedCloudArtifactRef;
  readonly createdAt: string;
  readonly passed: true;
  readonly signature: Signature;
}

export interface TrustedGitSourceWorkerManifest {
  readonly schemaVersion: 2;
  readonly domain: "dark-factory.trusted-git-source.v2";
  readonly originRepositoryHash: string;
  readonly upstreamRepositoryHash: string;
  readonly upstreamHeadCommit: string;
  readonly upstreamBaseCommit: string;
  readonly baselineCommit: string;
  readonly remoteRef: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly lockSha256: string;
  readonly archiveMethod: "git-archive-format-tar";
  readonly compression: "none";
  readonly archiveSha256: string;
  readonly archiveByteLength: number;
  readonly bundleMethod: "git-bundle-v2";
  readonly bundleRef: typeof TRUSTED_GIT_SOURCE_BUNDLE_REF;
  readonly bundleSha256: string;
  readonly bundleByteLength: number;
  readonly contentHash: string;
}

export interface TrustedGitSourceSnapshotAttestor {
  /**
   * Implementations live in the trusted artifact boundary. They must load the
   * manifest by its exact artifact reference, require canonical JSON with the
   * worker schema through parseTrustedGitSourceWorkerManifest, independently
   * match every lineage/archive/bundle field, and only then sign the
   * release-safe receipt.
   */
  attest(input: {
    readonly sensitivity: "trusted-git-source-attestation-request";
    readonly lease: SandboxLease;
    readonly spec: TrustedGitSourceSnapshotSpec;
    readonly execution: RemoteExecutionReceipt;
    readonly sourceArtifact: TrustedCloudArtifactRef;
    readonly sourceBundleArtifact: TrustedCloudArtifactRef;
    readonly manifestArtifact: TrustedCloudArtifactRef;
  }): Promise<TrustedGitSourceSnapshotReceipt>;
}

export interface TrustedGitSourceReceiptVerifier {
  readonly trustedKeyId: string;
  readonly publicKey: KeyLike;
}

export interface TrustedGitSourceRunnerOptions {
  readonly provider: CloudSandboxProvider;
  readonly sandbox: SandboxCreateRequest;
  readonly registration: RepositoryRegistration;
  readonly origin: PrivateGitHubOrigin;
  readonly target: GitSourceTarget;
  readonly workerArtifact: TrustedCloudArtifactRef;
  readonly attestor: TrustedGitSourceSnapshotAttestor;
  readonly receiptVerifier: TrustedGitSourceReceiptVerifier;
}

export class TrustedGitSourceError extends Error {
  override readonly name = "TrustedGitSourceError";
}

function isCanonicalTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function assertTarget(target: GitSourceTarget): void {
  assertExactPlainObjectKeys(
    target,
    ["remoteRef", "commitSha", "treeSha", "lockSha256"],
    "Git source target",
  );
  if (
    !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u.test(target.remoteRef) ||
    target.remoteRef.includes("..") ||
    target.remoteRef.includes("@{") ||
    target.remoteRef.includes("//") ||
    target.remoteRef.endsWith("/") ||
    target.remoteRef.endsWith(".") ||
    target.remoteRef.endsWith(".lock") ||
    target.remoteRef
      .slice("refs/heads/".length)
      .split("/")
      .some(
        (component) =>
          component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock"),
      )
  ) {
    throw new TrustedGitContractError("Git source remote ref is invalid.");
  }
  assertGitObjectId(target.commitSha, "Git source commit");
  assertGitObjectId(target.treeSha, "Git source tree");
  assertSha256(target.lockSha256, "Git source package lock");
}

function unsignedSnapshotReceipt(
  receipt: TrustedGitSourceSnapshotReceipt,
): Readonly<Record<string, unknown>> {
  return {
    sensitivity: receipt.sensitivity,
    schemaVersion: receipt.schemaVersion,
    snapshotId: receipt.snapshotId,
    registrationId: receipt.registrationId,
    originRepositoryHash: receipt.originRepositoryHash,
    upstreamRepositoryHash: receipt.upstreamRepositoryHash,
    upstreamHeadCommit: receipt.upstreamHeadCommit,
    upstreamBaseCommit: receipt.upstreamBaseCommit,
    baselineCommit: receipt.baselineCommit,
    provider: receipt.provider,
    sandboxId: receipt.sandboxId,
    imageReference: receipt.imageReference,
    imageDigest: receipt.imageDigest,
    networkPolicyHash: receipt.networkPolicyHash,
    remoteRef: receipt.remoteRef,
    commitSha: receipt.commitSha,
    treeSha: receipt.treeSha,
    lockSha256: receipt.lockSha256,
    archiveMethod: receipt.archiveMethod,
    compression: receipt.compression,
    workerSha256: receipt.workerSha256,
    executionReceiptHash: receipt.executionReceiptHash,
    manifestArtifactSha256: receipt.manifestArtifactSha256,
    sourceArtifact: receipt.sourceArtifact,
    sourceBundleArtifact: receipt.sourceBundleArtifact,
    bundleMethod: receipt.bundleMethod,
    bundleRef: receipt.bundleRef,
    createdAt: receipt.createdAt,
    passed: receipt.passed,
  };
}

export function gitSourceSnapshotReceiptHash(receipt: TrustedGitSourceSnapshotReceipt): string {
  return canonicalHash(unsignedSnapshotReceipt(receipt));
}

export function assertTrustedGitSourceWorkerManifest(
  manifest: unknown,
  input: {
    readonly spec: TrustedGitSourceSnapshotSpec;
    readonly sourceArtifact: TrustedCloudArtifactRef;
    readonly sourceBundleArtifact: TrustedCloudArtifactRef;
  },
): asserts manifest is TrustedGitSourceWorkerManifest {
  assertExactPlainObjectKeys(
    manifest,
    [
      "schemaVersion",
      "domain",
      "originRepositoryHash",
      "upstreamRepositoryHash",
      "upstreamHeadCommit",
      "upstreamBaseCommit",
      "baselineCommit",
      "remoteRef",
      "commitSha",
      "treeSha",
      "lockSha256",
      "archiveMethod",
      "compression",
      "archiveSha256",
      "archiveByteLength",
      "bundleMethod",
      "bundleRef",
      "bundleSha256",
      "bundleByteLength",
      "contentHash",
    ],
    "Git source worker manifest",
  );
  assertTrustedGitArtifact(
    input.sourceArtifact,
    "application/x-tar",
    "Git source manifest archive",
    512 * 1024 * 1024,
  );
  assertTrustedGitArtifact(
    input.sourceBundleArtifact,
    "application/vnd.git.bundle",
    "Git source manifest bundle",
    2 * 1024 * 1024 * 1024,
  );
  const document = manifest as unknown as TrustedGitSourceWorkerManifest;
  if (
    document.schemaVersion !== 2 ||
    document.domain !== "dark-factory.trusted-git-source.v2" ||
    document.originRepositoryHash !== input.spec.originRepositoryHash ||
    document.upstreamRepositoryHash !== input.spec.upstreamRepositoryHash ||
    document.upstreamHeadCommit !== input.spec.upstreamHeadCommit ||
    document.upstreamBaseCommit !== input.spec.upstreamBaseCommit ||
    document.baselineCommit !== input.spec.baselineCommit ||
    document.remoteRef !== input.spec.target.remoteRef ||
    document.commitSha !== input.spec.target.commitSha ||
    document.treeSha !== input.spec.target.treeSha ||
    document.lockSha256 !== input.spec.target.lockSha256 ||
    document.archiveMethod !== "git-archive-format-tar" ||
    document.compression !== "none" ||
    document.archiveSha256 !== input.sourceArtifact.sha256 ||
    document.archiveByteLength !== input.sourceArtifact.byteLength ||
    document.bundleMethod !== "git-bundle-v2" ||
    document.bundleRef !== TRUSTED_GIT_SOURCE_BUNDLE_REF ||
    document.bundleRef !== input.spec.bundleRef ||
    document.bundleSha256 !== input.sourceBundleArtifact.sha256 ||
    document.bundleByteLength !== input.sourceBundleArtifact.byteLength ||
    typeof document.contentHash !== "string" ||
    document.contentHash !== computeContentHash(document)
  ) {
    throw new TrustedGitContractError(
      "Git source worker manifest does not bind the exact archive and bundle.",
    );
  }
}

export function parseTrustedGitSourceWorkerManifest(
  raw: string,
  input: {
    readonly spec: TrustedGitSourceSnapshotSpec;
    readonly sourceArtifact: TrustedCloudArtifactRef;
    readonly sourceBundleArtifact: TrustedCloudArtifactRef;
  },
): TrustedGitSourceWorkerManifest {
  if (Buffer.byteLength(raw, "utf8") <= 0 || Buffer.byteLength(raw, "utf8") > 4 * 1024 * 1024) {
    throw new TrustedGitContractError("Git source worker manifest size is outside policy.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TrustedGitContractError("Git source worker manifest is not valid JSON.");
  }
  assertTrustedGitSourceWorkerManifest(parsed, input);
  if (raw !== `${canonicalJson(parsed)}\n`) {
    throw new TrustedGitContractError("Git source worker manifest is not canonical JSON.");
  }
  return parsed;
}

export function createTrustedGitSourceSnapshotSpec(input: {
  readonly requestId: string;
  readonly registration: RepositoryRegistration;
  readonly origin: PrivateGitHubOrigin;
  readonly target: GitSourceTarget;
  readonly workerArtifact: TrustedCloudArtifactRef;
}): TrustedGitSourceSnapshotSpec {
  assertRegisteredPrivateGitHubOrigin(input.registration, input.origin);
  assertSha256(input.registration.registrationId, "Repository registration");
  assertSha256(
    input.registration.upstreamFingerprint.repositoryHash,
    "Upstream repository identity",
  );
  assertGitObjectId(input.registration.headCommit, "Registered baseline");
  assertGitObjectId(
    input.registration.upstreamVerification.upstreamHeadCommit,
    "Registered upstream HEAD",
  );
  assertGitObjectId(input.registration.upstreamBaseCommit, "Registered upstream merge base");
  assertTarget(input.target);
  assertTrustedGitArtifact(
    input.workerArtifact,
    "text/javascript",
    "Trusted Git source worker",
    4 * 1024 * 1024,
  );
  const snapshotId = `snapshot-${canonicalHash({
    requestId: input.requestId,
    registrationId: input.registration.registrationId,
    originRepositoryHash: input.registration.originFingerprint.repositoryHash,
    upstreamRepositoryHash: input.registration.upstreamFingerprint.repositoryHash,
    upstreamHeadCommit: input.registration.upstreamVerification.upstreamHeadCommit,
    upstreamBaseCommit: input.registration.upstreamBaseCommit,
    baselineCommit: input.registration.headCommit,
    target: input.target,
    snapshotSchemaVersion: 2,
    bundleRef: TRUSTED_GIT_SOURCE_BUNDLE_REF,
    workerSha256: input.workerArtifact.sha256,
  }).slice(0, 48)}`;
  assertTrustedGitPaths({
    workingDirectory: SOURCE_WORKING_DIRECTORY,
    workerRemotePath: SOURCE_WORKER_REMOTE_PATH,
    outputRemotePath: SOURCE_ARCHIVE_REMOTE_PATH,
    resultRemotePath: SOURCE_MANIFEST_REMOTE_PATH,
  });
  assertTrustedGitPaths({
    workingDirectory: SOURCE_WORKING_DIRECTORY,
    workerRemotePath: SOURCE_WORKER_REMOTE_PATH,
    outputRemotePath: SOURCE_BUNDLE_REMOTE_PATH,
    resultRemotePath: SOURCE_MANIFEST_REMOTE_PATH,
  });
  if (new Set<string>([SOURCE_ARCHIVE_REMOTE_PATH, SOURCE_BUNDLE_REMOTE_PATH]).size !== 2) {
    throw new TrustedGitContractError("Trusted Git source archive and bundle paths overlap.");
  }
  const command: RemoteCommandSpec = {
    executable: "/usr/bin/node",
    arguments: [
      SOURCE_WORKER_REMOTE_PATH,
      "snapshot",
      "--remote",
      privateGitHubRemoteUrl(input.origin),
      "--origin-repository-sha256",
      input.registration.originFingerprint.repositoryHash,
      "--ref",
      input.target.remoteRef,
      "--commit",
      input.target.commitSha,
      "--tree",
      input.target.treeSha,
      "--lock-sha256",
      input.target.lockSha256,
      "--baseline",
      input.registration.headCommit,
      "--upstream",
      OFFICIAL_PI_UPSTREAM_URL,
      "--upstream-repository-sha256",
      input.registration.upstreamFingerprint.repositoryHash,
      "--upstream-head",
      input.registration.upstreamVerification.upstreamHeadCommit,
      "--upstream-base",
      input.registration.upstreamBaseCommit,
      "--archive",
      SOURCE_ARCHIVE_REMOTE_PATH,
      "--bundle",
      SOURCE_BUNDLE_REMOTE_PATH,
      "--bundle-ref",
      TRUSTED_GIT_SOURCE_BUNDLE_REF,
      "--manifest",
      SOURCE_MANIFEST_REMOTE_PATH,
      "--archive-format",
      "git-archive-tar",
      "--compression",
      "none",
    ],
    workingDirectory: SOURCE_WORKING_DIRECTORY,
    timeoutMs: 20 * 60_000,
    environment: {
      CI: "true",
      DF_CLOUD_EXECUTION: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    secretReferences: [input.origin.credential],
  };
  return {
    snapshotId,
    registrationId: input.registration.registrationId,
    originRepositoryHash: input.registration.originFingerprint.repositoryHash,
    upstreamRepositoryHash: input.registration.upstreamFingerprint.repositoryHash,
    upstreamHeadCommit: input.registration.upstreamVerification.upstreamHeadCommit,
    upstreamBaseCommit: input.registration.upstreamBaseCommit,
    baselineCommit: input.registration.headCommit,
    target: structuredClone(input.target),
    workerArtifact: structuredClone(input.workerArtifact),
    workerRemotePath: SOURCE_WORKER_REMOTE_PATH,
    archiveRemotePath: SOURCE_ARCHIVE_REMOTE_PATH,
    bundleRemotePath: SOURCE_BUNDLE_REMOTE_PATH,
    bundleRef: TRUSTED_GIT_SOURCE_BUNDLE_REF,
    manifestRemotePath: SOURCE_MANIFEST_REMOTE_PATH,
    command,
  };
}

export function assertTrustedGitSourceSnapshotReceipt(
  receipt: TrustedGitSourceSnapshotReceipt,
  input: {
    readonly lease: SandboxLease;
    readonly spec: TrustedGitSourceSnapshotSpec;
    readonly execution: RemoteExecutionReceipt;
    readonly sourceArtifact: TrustedCloudArtifactRef;
    readonly sourceBundleArtifact: TrustedCloudArtifactRef;
    readonly manifestArtifact: TrustedCloudArtifactRef;
    readonly verifier: TrustedGitSourceReceiptVerifier;
  },
): void {
  assertExactPlainObjectKeys(
    receipt,
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
    "Git source snapshot receipt",
  );
  assertExactPlainObjectKeys(
    receipt.signature,
    ["algorithm", "keyId", "signedAt", "signature"],
    "Git source snapshot signature",
  );
  assertTrustedGitArtifact(
    receipt.sourceArtifact,
    "application/x-tar",
    "Attested Git source archive",
    512 * 1024 * 1024,
  );
  assertTrustedGitArtifact(
    input.sourceArtifact,
    "application/x-tar",
    "Downloaded Git source archive",
    512 * 1024 * 1024,
  );
  assertTrustedGitArtifact(
    receipt.sourceBundleArtifact,
    "application/vnd.git.bundle",
    "Attested Git source bundle",
    2 * 1024 * 1024 * 1024,
  );
  assertTrustedGitArtifact(
    input.sourceBundleArtifact,
    "application/vnd.git.bundle",
    "Downloaded Git source bundle",
    2 * 1024 * 1024 * 1024,
  );
  assertTrustedGitArtifact(
    input.manifestArtifact,
    "application/json",
    "Downloaded Git source manifest",
    4 * 1024 * 1024,
  );
  const signedDocument = {
    ...unsignedSnapshotReceipt(receipt),
    signature: receipt.signature,
  };
  if (
    receipt.sensitivity !== "trusted-git-source-snapshot" ||
    receipt.schemaVersion !== 2 ||
    receipt.snapshotId !== input.spec.snapshotId ||
    receipt.registrationId !== input.spec.registrationId ||
    receipt.originRepositoryHash !== input.spec.originRepositoryHash ||
    receipt.upstreamRepositoryHash !== input.spec.upstreamRepositoryHash ||
    receipt.upstreamHeadCommit !== input.spec.upstreamHeadCommit ||
    receipt.upstreamBaseCommit !== input.spec.upstreamBaseCommit ||
    receipt.baselineCommit !== input.spec.baselineCommit ||
    receipt.provider !== input.lease.provider ||
    receipt.sandboxId !== input.lease.sandboxId ||
    receipt.imageReference !== input.lease.imageReference ||
    receipt.imageDigest !== input.lease.imageDigest ||
    receipt.networkPolicyHash !== input.lease.networkPolicyHash ||
    receipt.remoteRef !== input.spec.target.remoteRef ||
    receipt.commitSha !== input.spec.target.commitSha ||
    receipt.treeSha !== input.spec.target.treeSha ||
    receipt.lockSha256 !== input.spec.target.lockSha256 ||
    receipt.archiveMethod !== "git-archive-format-tar" ||
    receipt.compression !== "none" ||
    receipt.bundleMethod !== "git-bundle-v2" ||
    receipt.bundleRef !== TRUSTED_GIT_SOURCE_BUNDLE_REF ||
    receipt.bundleRef !== input.spec.bundleRef ||
    receipt.workerSha256 !== input.spec.workerArtifact.sha256 ||
    receipt.executionReceiptHash !== cloudExecutionReceiptHash(input.execution) ||
    receipt.manifestArtifactSha256 !== input.manifestArtifact.sha256 ||
    !sameTrustedArtifact(receipt.sourceArtifact, input.sourceArtifact) ||
    !sameTrustedArtifact(receipt.sourceBundleArtifact, input.sourceBundleArtifact) ||
    !isCanonicalTimestamp(receipt.createdAt) ||
    Date.parse(receipt.createdAt) < Date.parse(input.execution.finishedAt) ||
    Date.parse(receipt.createdAt) > Date.parse(input.lease.expiresAt) ||
    receipt.passed !== true ||
    receipt.signature.algorithm !== "ed25519" ||
    receipt.signature.keyId !== input.verifier.trustedKeyId ||
    !isCanonicalTimestamp(receipt.signature.signedAt) ||
    Date.parse(receipt.signature.signedAt) < Date.parse(receipt.createdAt) ||
    Date.parse(receipt.signature.signedAt) > Date.parse(input.lease.expiresAt) ||
    !verifyEd25519Signature(signedDocument, input.verifier.publicKey)
  ) {
    throw new TrustedGitContractError(
      "Git source receipt does not attest the exact requested archive and bundle.",
    );
  }
}

/**
 * Produces a source archive and a standalone one-head Git bundle only inside
 * the injected cloud provider. The canonical local Pi checkout is represented
 * solely by immutable registration hashes and is never opened, fetched,
 * tagged, or otherwise mutated here.
 */
export class TrustedGitSourceRunner {
  readonly #options: TrustedGitSourceRunnerOptions;
  readonly #spec: TrustedGitSourceSnapshotSpec;

  constructor(options: TrustedGitSourceRunnerOptions) {
    assertTrustedGitSandbox(options.sandbox, options.origin);
    const capturedOptions: TrustedGitSourceRunnerOptions = {
      ...options,
      sandbox: structuredClone(options.sandbox),
      registration: structuredClone(options.registration),
      origin: structuredClone(options.origin),
      target: structuredClone(options.target),
      workerArtifact: structuredClone(options.workerArtifact),
      receiptVerifier: {
        trustedKeyId: options.receiptVerifier.trustedKeyId,
        publicKey: options.receiptVerifier.publicKey,
      },
    };
    this.#spec = createTrustedGitSourceSnapshotSpec({
      requestId: capturedOptions.sandbox.requestId,
      registration: capturedOptions.registration,
      origin: capturedOptions.origin,
      target: capturedOptions.target,
      workerArtifact: capturedOptions.workerArtifact,
    });
    this.#options = capturedOptions;
  }

  async run(): Promise<TrustedGitSourceSnapshotReceipt> {
    let lease: SandboxLease | undefined;
    let result: TrustedGitSourceSnapshotReceipt | undefined;
    let failure: { readonly error: unknown } | undefined;
    let teardownFailure: { readonly error: unknown } | undefined;
    try {
      await requireCompatibleProvider(this.#options.provider, {
        requestId: `probe-${canonicalHash(this.#spec.snapshotId).slice(0, 32)}`,
        imageDigest: this.#options.sandbox.imageDigest,
        regionClass: this.#options.sandbox.regionClass,
        resources: this.#options.sandbox.resources,
        requireDockerInDocker: false,
        requireGpu: false,
      });
      lease = await this.#options.provider.create({
        ...this.#options.sandbox,
        requestId: this.#spec.snapshotId,
      });
      await this.#options.provider.upload(
        lease,
        structuredClone(this.#spec.workerArtifact),
        this.#spec.workerRemotePath,
      );
      const execution = structuredClone(
        await this.#options.provider.execute(lease, structuredClone(this.#spec.command)),
      );
      assertSuccessfulCloudExecution(execution, "Git source snapshot");
      const sourceArtifact = structuredClone(
        await this.#options.provider.download(lease, this.#spec.archiveRemotePath, {
          mediaType: "application/x-tar",
          maximumByteLength: 512 * 1024 * 1024,
        }),
      );
      const manifestArtifact = structuredClone(
        await this.#options.provider.download(lease, this.#spec.manifestRemotePath, {
          mediaType: "application/json",
          maximumByteLength: 4 * 1024 * 1024,
        }),
      );
      const sourceBundleArtifact = structuredClone(
        await this.#options.provider.download(lease, this.#spec.bundleRemotePath, {
          mediaType: "application/vnd.git.bundle",
          maximumByteLength: 2 * 1024 * 1024 * 1024,
        }),
      );
      const receipt = await this.#options.attestor.attest({
        sensitivity: "trusted-git-source-attestation-request",
        lease: structuredClone(lease),
        spec: structuredClone(this.#spec),
        execution: structuredClone(execution),
        sourceArtifact: structuredClone(sourceArtifact),
        sourceBundleArtifact: structuredClone(sourceBundleArtifact),
        manifestArtifact: structuredClone(manifestArtifact),
      });
      assertTrustedGitSourceSnapshotReceipt(receipt, {
        lease,
        spec: this.#spec,
        execution,
        sourceArtifact,
        sourceBundleArtifact,
        manifestArtifact,
        verifier: this.#options.receiptVerifier,
      });
      result = receipt;
    } catch (error) {
      failure = { error };
    } finally {
      if (lease !== undefined) {
        try {
          await this.#options.provider.destroy(lease);
        } catch (error) {
          teardownFailure = { error };
        }
      }
    }
    if (teardownFailure !== undefined) {
      throw new TrustedGitSourceError(
        "Trusted Git source sandbox teardown failed; the snapshot is invalid.",
        {
          cause:
            failure === undefined
              ? teardownFailure.error
              : new AggregateError(
                  [failure.error, teardownFailure.error],
                  "Git source snapshot and sandbox teardown both failed.",
                ),
        },
      );
    }
    if (failure !== undefined || result === undefined) {
      throw new TrustedGitSourceError("Trusted cloud Git source snapshot failed closed.", {
        cause: failure?.error,
      });
    }
    return result;
  }
}
