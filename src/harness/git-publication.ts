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
import {
  canonicalHash,
  canonicalJson,
  computeContentHash,
} from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import {
  OFFICIAL_PI_UPSTREAM_URL,
  type RepositoryRegistration,
} from "./repository.js";
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
  TrustedGitContractError,
} from "./trusted-git.js";

const EXPERIMENT_ID = /^[0-9]{3,8}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_HEAD_REF =
  /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u;
const SAFE_AUTHORIZATION_ID = /^publication-auth-[a-f0-9]{48}$/u;
const MAXIMUM_AUTHORIZATION_LIFETIME_MS = 24 * 60 * 60_000;
const PUBLICATION_WORKING_DIRECTORY = "/workspace";
const PUBLICATION_WORKER_REMOTE_PATH = "/trusted/git/publication-worker.mjs";
const PUBLICATION_BUNDLE_REMOTE_PATH = "/trusted/git/candidate.bundle";
const PUBLICATION_RESULT_REMOTE_PATH = "/trusted/git/publication-result.json";

export interface TrustedGitPublicationAuthorizationPayload {
  readonly sensitivity: "trusted-git-publication-authorization";
  readonly schemaVersion: 1;
  readonly authorizationId: string;
  readonly registrationId: string;
  readonly originRepositoryHash: string;
  readonly experimentId: string;
  readonly baselineCommit: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly lockSha256: string;
  readonly candidateBundle: TrustedCloudArtifactRef;
  readonly workerSha256: string;
  readonly branchRef: string;
  readonly tagRef: string;
  readonly tagTimestamp: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface TrustedGitPublicationAuthorization
  extends TrustedGitPublicationAuthorizationPayload {
  readonly signature: Signature;
}

export interface TrustedGitPublicationAuthorizationVerifier {
  readonly trustedKeyId: string;
  readonly publicKey: KeyLike;
}

export interface TrustedGitPublicationSpec {
  readonly publicationId: string;
  readonly authorizationHash: string;
  readonly registrationId: string;
  readonly originRepositoryHash: string;
  readonly upstreamRepositoryHash: string;
  readonly upstreamHeadCommit: string;
  readonly upstreamBaseCommit: string;
  readonly bundleRef: string;
  readonly workerArtifact: TrustedCloudArtifactRef;
  readonly candidateBundle: TrustedCloudArtifactRef;
  readonly workerRemotePath: string;
  readonly bundleRemotePath: string;
  readonly resultRemotePath: string;
  readonly command: RemoteCommandSpec;
}

export interface TrustedGitPublicationReceipt {
  readonly sensitivity: "trusted-git-publication";
  readonly schemaVersion: 1;
  readonly publicationId: string;
  readonly authorizationHash: string;
  readonly registrationId: string;
  readonly originRepositoryHash: string;
  readonly upstreamRepositoryHash: string;
  readonly upstreamHeadCommit: string;
  readonly upstreamBaseCommit: string;
  readonly provider: "daytona" | "e2b" | "modal";
  readonly sandboxId: string;
  readonly imageReference: string;
  readonly imageDigest: string;
  readonly networkPolicyHash: string;
  readonly experimentId: string;
  readonly baselineCommit: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly lockSha256: string;
  readonly bundleRef: string;
  readonly branchRef: string;
  readonly tagRef: string;
  readonly branchCommit: string;
  readonly tagObjectId: string;
  readonly tagPeeledCommit: string;
  readonly publicationMode: "atomic-non-force";
  readonly disposition: "published" | "already-published";
  readonly candidateBundleSha256: string;
  readonly workerSha256: string;
  readonly executionReceiptHash: string;
  readonly resultArtifactSha256: string;
  readonly publishedAt: string;
  readonly passed: true;
  readonly signature: Signature;
}

export interface TrustedGitPublicationWorkerResult {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.trusted-git-publication.v1";
  readonly originRepositoryHash: string;
  readonly upstreamRepositoryHash: string;
  readonly upstreamHeadCommit: string;
  readonly upstreamBaseCommit: string;
  readonly experimentId: string;
  readonly baselineCommit: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly lockSha256: string;
  readonly candidateBundleSha256: string;
  readonly bundleRef: string;
  readonly branchRef: string;
  readonly tagRef: string;
  readonly branchCommit: string;
  readonly tagObjectId: string;
  readonly tagPeeledCommit: string;
  readonly publicationMode: "atomic-non-force";
  readonly disposition: "published" | "already-published";
  readonly contentHash: string;
}

export interface TrustedGitPublicationAttestor {
  /**
   * Implementations must load the exact result artifact, require the canonical
   * worker schema through parseTrustedGitPublicationWorkerResult, match both
   * remote refs and the deterministic tag object, and sign only after
   * independently observing those release-safe fields.
   */
  attest(input: {
    readonly sensitivity: "trusted-git-publication-attestation-request";
    readonly lease: SandboxLease;
    readonly authorization: TrustedGitPublicationAuthorization;
    readonly spec: TrustedGitPublicationSpec;
    readonly execution: RemoteExecutionReceipt;
    readonly resultArtifact: TrustedCloudArtifactRef;
  }): Promise<TrustedGitPublicationReceipt>;
}

export interface TrustedGitPublicationReceiptVerifier {
  readonly trustedKeyId: string;
  readonly publicKey: KeyLike;
}

export interface TrustedGitPublicationRunnerOptions {
  readonly provider: CloudSandboxProvider;
  readonly sandbox: SandboxCreateRequest;
  readonly registration: RepositoryRegistration;
  readonly origin: PrivateGitHubOrigin;
  readonly workerArtifact: TrustedCloudArtifactRef;
  readonly authorization: TrustedGitPublicationAuthorization;
  readonly authorizationVerifier: TrustedGitPublicationAuthorizationVerifier;
  readonly attestor: TrustedGitPublicationAttestor;
  readonly receiptVerifier: TrustedGitPublicationReceiptVerifier;
  readonly now?: () => Date;
}

export class TrustedGitPublicationError extends Error {
  override readonly name = "TrustedGitPublicationError";
}

function isCanonicalTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function publicationRefs(experimentId: string): {
  readonly branchRef: string;
  readonly tagRef: string;
} {
  if (!EXPERIMENT_ID.test(experimentId)) {
    throw new TrustedGitContractError("Git publication experiment identifier is invalid.");
  }
  return {
    branchRef: `refs/heads/df/experiment/${experimentId}`,
    tagRef: `refs/tags/df/experiment/${experimentId}/candidate`,
  };
}

export function trustedGitCandidateBundleRef(experimentId: string): string {
  publicationRefs(experimentId);
  return `refs/heads/df/bundle/${experimentId}`;
}

function assertAuthorizedHeadRef(ref: string): void {
  if (
    !SAFE_HEAD_REF.test(ref) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref
      .slice("refs/heads/".length)
      .split("/")
      .some(
        (component) =>
          component.startsWith(".") ||
          component.endsWith(".") ||
          component.endsWith(".lock"),
      )
  ) {
    throw new TrustedGitContractError("Git publication base ref is invalid.");
  }
}

export function createTrustedGitPublicationAuthorizationPayload(input: {
  readonly registration: RepositoryRegistration;
  readonly experimentId: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly lockSha256: string;
  readonly candidateBundle: TrustedCloudArtifactRef;
  readonly workerArtifact: TrustedCloudArtifactRef;
  readonly tagTimestamp: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}): TrustedGitPublicationAuthorizationPayload {
  const refs = publicationRefs(input.experimentId);
  assertSha256(input.registration.registrationId, "Repository registration");
  assertGitObjectId(input.registration.headCommit, "Registered baseline");
  assertAuthorizedHeadRef(input.baseRef);
  assertGitObjectId(input.baseCommit, "Git publication base");
  assertGitObjectId(input.candidateCommit, "Git publication candidate");
  assertGitObjectId(input.candidateTree, "Git publication tree");
  assertSha256(input.lockSha256, "Git publication package lock");
  assertTrustedGitArtifact(
    input.candidateBundle,
    "application/vnd.git.bundle",
    "Candidate Git bundle",
    2 * 1024 * 1024 * 1024,
  );
  assertTrustedGitArtifact(
    input.workerArtifact,
    "text/javascript",
    "Trusted Git publication worker",
    4 * 1024 * 1024,
  );
  const issuedAt = Date.parse(input.issuedAt);
  const expiresAt = Date.parse(input.expiresAt);
  const tagTimestamp = Date.parse(input.tagTimestamp);
  if (
    input.baseCommit === input.candidateCommit ||
    input.baseRef === refs.branchRef ||
    input.lockSha256 !== input.registration.lockSha256 ||
    !isCanonicalTimestamp(input.issuedAt) ||
    !isCanonicalTimestamp(input.expiresAt) ||
    !isCanonicalTimestamp(input.tagTimestamp) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAXIMUM_AUTHORIZATION_LIFETIME_MS ||
    tagTimestamp < issuedAt ||
    tagTimestamp > expiresAt
  ) {
    throw new TrustedGitContractError(
      "Git publication lineage or authorization window is outside policy.",
    );
  }
  const identity = {
    registrationId: input.registration.registrationId,
    originRepositoryHash: input.registration.originFingerprint.repositoryHash,
    experimentId: input.experimentId,
    baselineCommit: input.registration.headCommit,
    baseRef: input.baseRef,
    baseCommit: input.baseCommit,
    candidateCommit: input.candidateCommit,
    candidateTree: input.candidateTree,
    lockSha256: input.lockSha256,
    candidateBundle: input.candidateBundle,
    workerSha256: input.workerArtifact.sha256,
    branchRef: refs.branchRef,
    tagRef: refs.tagRef,
    tagTimestamp: input.tagTimestamp,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
  return {
    sensitivity: "trusted-git-publication-authorization",
    schemaVersion: 1,
    authorizationId: `publication-auth-${canonicalHash(identity).slice(0, 48)}`,
    ...identity,
  };
}

function unsignedAuthorization(
  authorization: TrustedGitPublicationAuthorization,
): TrustedGitPublicationAuthorizationPayload {
  const {
    signature: _signature,
    ...payload
  } = authorization;
  return payload;
}

export function trustedGitPublicationAuthorizationHash(
  authorization: TrustedGitPublicationAuthorization,
): string {
  return canonicalHash(authorization);
}

export function assertTrustedGitPublicationAuthorization(
  authorization: TrustedGitPublicationAuthorization,
  input: {
    readonly registration: RepositoryRegistration;
    readonly workerArtifact: TrustedCloudArtifactRef;
    readonly verifier: TrustedGitPublicationAuthorizationVerifier;
    readonly now: Date;
  },
): void {
  assertExactPlainObjectKeys(
    authorization,
    [
      "sensitivity",
      "schemaVersion",
      "authorizationId",
      "registrationId",
      "originRepositoryHash",
      "experimentId",
      "baselineCommit",
      "baseRef",
      "baseCommit",
      "candidateCommit",
      "candidateTree",
      "lockSha256",
      "candidateBundle",
      "workerSha256",
      "branchRef",
      "tagRef",
      "tagTimestamp",
      "issuedAt",
      "expiresAt",
      "signature",
    ],
    "Git publication authorization",
  );
  assertExactPlainObjectKeys(
    authorization.signature,
    ["algorithm", "keyId", "signedAt", "signature"],
    "Git publication authorization signature",
  );
  const expectedPayload = createTrustedGitPublicationAuthorizationPayload({
    registration: input.registration,
    experimentId: authorization.experimentId,
    baseRef: authorization.baseRef,
    baseCommit: authorization.baseCommit,
    candidateCommit: authorization.candidateCommit,
    candidateTree: authorization.candidateTree,
    lockSha256: authorization.lockSha256,
    candidateBundle: authorization.candidateBundle,
    workerArtifact: input.workerArtifact,
    tagTimestamp: authorization.tagTimestamp,
    issuedAt: authorization.issuedAt,
    expiresAt: authorization.expiresAt,
  });
  const signedDocument = {
    ...unsignedAuthorization(authorization),
    signature: authorization.signature,
  };
  const now = input.now.getTime();
  if (
    authorization.sensitivity !== "trusted-git-publication-authorization" ||
    authorization.schemaVersion !== 1 ||
    !SAFE_AUTHORIZATION_ID.test(authorization.authorizationId) ||
    canonicalHash(unsignedAuthorization(authorization)) !==
      canonicalHash(expectedPayload) ||
    authorization.registrationId !== input.registration.registrationId ||
    authorization.originRepositoryHash !==
      input.registration.originFingerprint.repositoryHash ||
    authorization.baselineCommit !== input.registration.headCommit ||
    authorization.workerSha256 !== input.workerArtifact.sha256 ||
    !Number.isFinite(now) ||
    now < Date.parse(authorization.issuedAt) ||
    now >= Date.parse(authorization.expiresAt) ||
    Date.parse(authorization.tagTimestamp) > now ||
    authorization.signature.algorithm !== "ed25519" ||
    authorization.signature.keyId !== input.verifier.trustedKeyId ||
    !isCanonicalTimestamp(authorization.signature.signedAt) ||
    Date.parse(authorization.signature.signedAt) < Date.parse(authorization.issuedAt) ||
    Date.parse(authorization.signature.signedAt) > Date.parse(authorization.expiresAt) ||
    Date.parse(authorization.signature.signedAt) > now ||
    !verifyEd25519Signature(signedDocument, input.verifier.publicKey)
  ) {
    throw new TrustedGitContractError(
      "Git publication authorization is invalid, expired, or not trusted.",
    );
  }
}

function unsignedPublicationReceipt(
  receipt: TrustedGitPublicationReceipt,
): Readonly<Record<string, unknown>> {
  return {
    sensitivity: receipt.sensitivity,
    schemaVersion: receipt.schemaVersion,
    publicationId: receipt.publicationId,
    authorizationHash: receipt.authorizationHash,
    registrationId: receipt.registrationId,
    originRepositoryHash: receipt.originRepositoryHash,
    upstreamRepositoryHash: receipt.upstreamRepositoryHash,
    upstreamHeadCommit: receipt.upstreamHeadCommit,
    upstreamBaseCommit: receipt.upstreamBaseCommit,
    provider: receipt.provider,
    sandboxId: receipt.sandboxId,
    imageReference: receipt.imageReference,
    imageDigest: receipt.imageDigest,
    networkPolicyHash: receipt.networkPolicyHash,
    experimentId: receipt.experimentId,
    baselineCommit: receipt.baselineCommit,
    baseRef: receipt.baseRef,
    baseCommit: receipt.baseCommit,
    candidateCommit: receipt.candidateCommit,
    candidateTree: receipt.candidateTree,
    lockSha256: receipt.lockSha256,
    bundleRef: receipt.bundleRef,
    branchRef: receipt.branchRef,
    tagRef: receipt.tagRef,
    branchCommit: receipt.branchCommit,
    tagObjectId: receipt.tagObjectId,
    tagPeeledCommit: receipt.tagPeeledCommit,
    publicationMode: receipt.publicationMode,
    disposition: receipt.disposition,
    candidateBundleSha256: receipt.candidateBundleSha256,
    workerSha256: receipt.workerSha256,
    executionReceiptHash: receipt.executionReceiptHash,
    resultArtifactSha256: receipt.resultArtifactSha256,
    publishedAt: receipt.publishedAt,
    passed: receipt.passed,
  };
}

export function gitPublicationReceiptHash(
  receipt: TrustedGitPublicationReceipt,
): string {
  return canonicalHash(unsignedPublicationReceipt(receipt));
}

export function assertTrustedGitPublicationWorkerResult(
  result: unknown,
  input: {
    readonly authorization: TrustedGitPublicationAuthorization;
    readonly spec: TrustedGitPublicationSpec;
  },
): asserts result is TrustedGitPublicationWorkerResult {
  assertExactPlainObjectKeys(
    result,
    [
      "schemaVersion",
      "domain",
      "originRepositoryHash",
      "upstreamRepositoryHash",
      "upstreamHeadCommit",
      "upstreamBaseCommit",
      "experimentId",
      "baselineCommit",
      "baseRef",
      "baseCommit",
      "candidateCommit",
      "candidateTree",
      "lockSha256",
      "candidateBundleSha256",
      "bundleRef",
      "branchRef",
      "tagRef",
      "branchCommit",
      "tagObjectId",
      "tagPeeledCommit",
      "publicationMode",
      "disposition",
      "contentHash",
    ],
    "Git publication worker result",
  );
  const document = result as unknown as TrustedGitPublicationWorkerResult;
  assertGitObjectId(document.tagObjectId, "Published tag object");
  if (
    document.schemaVersion !== 1 ||
    document.domain !== "dark-factory.trusted-git-publication.v1" ||
    document.originRepositoryHash !== input.spec.originRepositoryHash ||
    document.upstreamRepositoryHash !== input.spec.upstreamRepositoryHash ||
    document.upstreamHeadCommit !== input.spec.upstreamHeadCommit ||
    document.upstreamBaseCommit !== input.spec.upstreamBaseCommit ||
    document.experimentId !== input.authorization.experimentId ||
    document.baselineCommit !== input.authorization.baselineCommit ||
    document.baseRef !== input.authorization.baseRef ||
    document.baseCommit !== input.authorization.baseCommit ||
    document.candidateCommit !== input.authorization.candidateCommit ||
    document.candidateTree !== input.authorization.candidateTree ||
    document.lockSha256 !== input.authorization.lockSha256 ||
    document.candidateBundleSha256 !==
      input.authorization.candidateBundle.sha256 ||
    document.bundleRef !== input.spec.bundleRef ||
    document.branchRef !== input.authorization.branchRef ||
    document.tagRef !== input.authorization.tagRef ||
    document.branchCommit !== input.authorization.candidateCommit ||
    document.tagPeeledCommit !== input.authorization.candidateCommit ||
    document.publicationMode !== "atomic-non-force" ||
    !new Set(["published", "already-published"]).has(document.disposition) ||
    typeof document.contentHash !== "string" ||
    document.contentHash !== computeContentHash(document)
  ) {
    throw new TrustedGitContractError(
      "Git publication worker result does not bind the authorized refs.",
    );
  }
}

export function parseTrustedGitPublicationWorkerResult(
  raw: string,
  input: {
    readonly authorization: TrustedGitPublicationAuthorization;
    readonly spec: TrustedGitPublicationSpec;
  },
): TrustedGitPublicationWorkerResult {
  if (
    Buffer.byteLength(raw, "utf8") <= 0 ||
    Buffer.byteLength(raw, "utf8") > 4 * 1024 * 1024
  ) {
    throw new TrustedGitContractError(
      "Git publication worker result size is outside policy.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TrustedGitContractError(
      "Git publication worker result is not valid JSON.",
    );
  }
  assertTrustedGitPublicationWorkerResult(parsed, input);
  if (raw !== `${canonicalJson(parsed)}\n`) {
    throw new TrustedGitContractError(
      "Git publication worker result is not canonical JSON.",
    );
  }
  return parsed;
}

export function createTrustedGitPublicationSpec(input: {
  readonly requestId: string;
  readonly registration: RepositoryRegistration;
  readonly origin: PrivateGitHubOrigin;
  readonly workerArtifact: TrustedCloudArtifactRef;
  readonly authorization: TrustedGitPublicationAuthorization;
}): TrustedGitPublicationSpec {
  assertRegisteredPrivateGitHubOrigin(input.registration, input.origin);
  assertSha256(input.registration.registrationId, "Repository registration");
  assertSha256(
    input.registration.upstreamFingerprint.repositoryHash,
    "Upstream repository identity",
  );
  assertGitObjectId(
    input.registration.upstreamVerification.upstreamHeadCommit,
    "Registered upstream HEAD",
  );
  assertGitObjectId(
    input.registration.upstreamBaseCommit,
    "Registered upstream merge base",
  );
  const authorizationHash = trustedGitPublicationAuthorizationHash(input.authorization);
  const publicationId = `publication-${canonicalHash({
    requestId: input.requestId,
    authorizationHash,
  }).slice(0, 48)}`;
  assertTrustedGitPaths({
    workingDirectory: PUBLICATION_WORKING_DIRECTORY,
    workerRemotePath: PUBLICATION_WORKER_REMOTE_PATH,
    inputRemotePath: PUBLICATION_BUNDLE_REMOTE_PATH,
    outputRemotePath: PUBLICATION_RESULT_REMOTE_PATH,
  });
  const command: RemoteCommandSpec = {
    executable: "/usr/bin/node",
    arguments: [
      PUBLICATION_WORKER_REMOTE_PATH,
      "publish",
      "--remote",
      privateGitHubRemoteUrl(input.origin),
      "--origin-repository-sha256",
      input.registration.originFingerprint.repositoryHash,
      "--upstream",
      OFFICIAL_PI_UPSTREAM_URL,
      "--upstream-repository-sha256",
      input.registration.upstreamFingerprint.repositoryHash,
      "--upstream-head",
      input.registration.upstreamVerification.upstreamHeadCommit,
      "--upstream-base",
      input.registration.upstreamBaseCommit,
      "--bundle",
      PUBLICATION_BUNDLE_REMOTE_PATH,
      "--bundle-sha256",
      input.authorization.candidateBundle.sha256,
      "--baseline",
      input.authorization.baselineCommit,
      "--base-ref",
      input.authorization.baseRef,
      "--base",
      input.authorization.baseCommit,
      "--commit",
      input.authorization.candidateCommit,
      "--tree",
      input.authorization.candidateTree,
      "--lock-sha256",
      input.authorization.lockSha256,
      "--branch-ref",
      input.authorization.branchRef,
      "--tag-ref",
      input.authorization.tagRef,
      "--tag-timestamp",
      input.authorization.tagTimestamp,
      "--experiment",
      input.authorization.experimentId,
      "--authorization-expires-at",
      input.authorization.expiresAt,
      "--result",
      PUBLICATION_RESULT_REMOTE_PATH,
      "--mode",
      "atomic-non-force",
    ],
    workingDirectory: PUBLICATION_WORKING_DIRECTORY,
    timeoutMs: 20 * 60_000,
    environment: {
      CI: "true",
      DF_CLOUD_EXECUTION: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    secretReferences: [input.origin.credential],
  };
  return {
    publicationId,
    authorizationHash,
    registrationId: input.registration.registrationId,
    originRepositoryHash: input.registration.originFingerprint.repositoryHash,
    upstreamRepositoryHash:
      input.registration.upstreamFingerprint.repositoryHash,
    upstreamHeadCommit:
      input.registration.upstreamVerification.upstreamHeadCommit,
    upstreamBaseCommit: input.registration.upstreamBaseCommit,
    bundleRef: trustedGitCandidateBundleRef(
      input.authorization.experimentId,
    ),
    workerArtifact: structuredClone(input.workerArtifact),
    candidateBundle: structuredClone(input.authorization.candidateBundle),
    workerRemotePath: PUBLICATION_WORKER_REMOTE_PATH,
    bundleRemotePath: PUBLICATION_BUNDLE_REMOTE_PATH,
    resultRemotePath: PUBLICATION_RESULT_REMOTE_PATH,
    command,
  };
}

export function assertTrustedGitPublicationReceipt(
  receipt: TrustedGitPublicationReceipt,
  input: {
    readonly lease: SandboxLease;
    readonly authorization: TrustedGitPublicationAuthorization;
    readonly spec: TrustedGitPublicationSpec;
    readonly execution: RemoteExecutionReceipt;
    readonly resultArtifact: TrustedCloudArtifactRef;
    readonly verifier: TrustedGitPublicationReceiptVerifier;
  },
): void {
  assertExactPlainObjectKeys(
    receipt,
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
    "Git publication receipt",
  );
  assertExactPlainObjectKeys(
    receipt.signature,
    ["algorithm", "keyId", "signedAt", "signature"],
    "Git publication receipt signature",
  );
  assertTrustedGitArtifact(
    input.resultArtifact,
    "application/json",
    "Git publication result",
    4 * 1024 * 1024,
  );
  assertGitObjectId(receipt.tagObjectId, "Published tag object");
  const signedDocument = {
    ...unsignedPublicationReceipt(receipt),
    signature: receipt.signature,
  };
  if (
    receipt.sensitivity !== "trusted-git-publication" ||
    receipt.schemaVersion !== 1 ||
    receipt.publicationId !== input.spec.publicationId ||
    receipt.authorizationHash !== input.spec.authorizationHash ||
    receipt.registrationId !== input.authorization.registrationId ||
    receipt.originRepositoryHash !== input.authorization.originRepositoryHash ||
    receipt.upstreamRepositoryHash !== input.spec.upstreamRepositoryHash ||
    receipt.upstreamHeadCommit !== input.spec.upstreamHeadCommit ||
    receipt.upstreamBaseCommit !== input.spec.upstreamBaseCommit ||
    receipt.provider !== input.lease.provider ||
    receipt.sandboxId !== input.lease.sandboxId ||
    receipt.imageReference !== input.lease.imageReference ||
    receipt.imageDigest !== input.lease.imageDigest ||
    receipt.networkPolicyHash !== input.lease.networkPolicyHash ||
    receipt.experimentId !== input.authorization.experimentId ||
    receipt.baselineCommit !== input.authorization.baselineCommit ||
    receipt.baseRef !== input.authorization.baseRef ||
    receipt.baseCommit !== input.authorization.baseCommit ||
    receipt.candidateCommit !== input.authorization.candidateCommit ||
    receipt.candidateTree !== input.authorization.candidateTree ||
    receipt.lockSha256 !== input.authorization.lockSha256 ||
    receipt.bundleRef !== input.spec.bundleRef ||
    receipt.branchRef !== input.authorization.branchRef ||
    receipt.tagRef !== input.authorization.tagRef ||
    receipt.branchCommit !== input.authorization.candidateCommit ||
    receipt.tagPeeledCommit !== input.authorization.candidateCommit ||
    receipt.publicationMode !== "atomic-non-force" ||
    !new Set(["published", "already-published"]).has(receipt.disposition) ||
    receipt.candidateBundleSha256 !== input.authorization.candidateBundle.sha256 ||
    receipt.workerSha256 !== input.authorization.workerSha256 ||
    receipt.executionReceiptHash !== cloudExecutionReceiptHash(input.execution) ||
    receipt.resultArtifactSha256 !== input.resultArtifact.sha256 ||
    !isCanonicalTimestamp(receipt.publishedAt) ||
    Date.parse(receipt.publishedAt) < Date.parse(input.execution.finishedAt) ||
    Date.parse(receipt.publishedAt) >=
      Date.parse(input.authorization.expiresAt) ||
    Date.parse(receipt.publishedAt) > Date.parse(input.lease.expiresAt) ||
    receipt.passed !== true ||
    receipt.signature.algorithm !== "ed25519" ||
    receipt.signature.keyId !== input.verifier.trustedKeyId ||
    !isCanonicalTimestamp(receipt.signature.signedAt) ||
    Date.parse(receipt.signature.signedAt) < Date.parse(receipt.publishedAt) ||
    Date.parse(receipt.signature.signedAt) > Date.parse(input.lease.expiresAt) ||
    !verifyEd25519Signature(signedDocument, input.verifier.publicKey)
  ) {
    throw new TrustedGitContractError(
      "Git publication receipt does not prove the authorized non-force refs.",
    );
  }
}

/**
 * Publishes an already sealed candidate Git bundle. The worker protocol must
 * verify the bundle, lineage, tree, and package lock, create a deterministic
 * annotated tag, and use one atomic Git push with no force refspecs or flags.
 */
export class TrustedGitPublicationRunner {
  readonly #options: TrustedGitPublicationRunnerOptions;
  readonly #spec: TrustedGitPublicationSpec;

  constructor(options: TrustedGitPublicationRunnerOptions) {
    assertTrustedGitSandbox(options.sandbox, options.origin);
    assertRegisteredPrivateGitHubOrigin(options.registration, options.origin);
    assertTrustedGitArtifact(
      options.workerArtifact,
      "text/javascript",
      "Trusted Git publication worker",
      4 * 1024 * 1024,
    );
    const capturedOptions: TrustedGitPublicationRunnerOptions = {
      ...options,
      sandbox: structuredClone(options.sandbox),
      registration: structuredClone(options.registration),
      origin: structuredClone(options.origin),
      workerArtifact: structuredClone(options.workerArtifact),
      authorization: structuredClone(options.authorization),
      authorizationVerifier: {
        trustedKeyId: options.authorizationVerifier.trustedKeyId,
        publicKey: options.authorizationVerifier.publicKey,
      },
      receiptVerifier: {
        trustedKeyId: options.receiptVerifier.trustedKeyId,
        publicKey: options.receiptVerifier.publicKey,
      },
    };
    assertTrustedGitPublicationAuthorization(capturedOptions.authorization, {
      registration: capturedOptions.registration,
      workerArtifact: capturedOptions.workerArtifact,
      verifier: capturedOptions.authorizationVerifier,
      now: (capturedOptions.now ?? (() => new Date()))(),
    });
    this.#spec = createTrustedGitPublicationSpec({
      requestId: capturedOptions.sandbox.requestId,
      registration: capturedOptions.registration,
      origin: capturedOptions.origin,
      workerArtifact: capturedOptions.workerArtifact,
      authorization: capturedOptions.authorization,
    });
    this.#options = capturedOptions;
  }

  async run(): Promise<TrustedGitPublicationReceipt> {
    let lease: SandboxLease | undefined;
    try {
      assertTrustedGitPublicationAuthorization(this.#options.authorization, {
        registration: this.#options.registration,
        workerArtifact: this.#options.workerArtifact,
        verifier: this.#options.authorizationVerifier,
        now: (this.#options.now ?? (() => new Date()))(),
      });
      await requireCompatibleProvider(this.#options.provider, {
        requestId: `probe-${canonicalHash(this.#spec.publicationId).slice(0, 32)}`,
        imageDigest: this.#options.sandbox.imageDigest,
        regionClass: this.#options.sandbox.regionClass,
        resources: this.#options.sandbox.resources,
        requireDockerInDocker: false,
        requireGpu: false,
      });
      lease = await this.#options.provider.create({
        ...this.#options.sandbox,
        requestId: this.#spec.publicationId,
      });
      await this.#options.provider.upload(
        lease,
        structuredClone(this.#spec.workerArtifact),
        this.#spec.workerRemotePath,
      );
      await this.#options.provider.upload(
        lease,
        structuredClone(this.#spec.candidateBundle),
        this.#spec.bundleRemotePath,
      );
      const execution = structuredClone(
        await this.#options.provider.execute(
          lease,
          structuredClone(this.#spec.command),
        ),
      );
      assertSuccessfulCloudExecution(execution, "Git publication");
      const resultArtifact = structuredClone(
        await this.#options.provider.download(
          lease,
          this.#spec.resultRemotePath,
          {
            mediaType: "application/json",
            maximumByteLength: 4 * 1024 * 1024,
          },
        ),
      );
      const receipt = await this.#options.attestor.attest({
        sensitivity: "trusted-git-publication-attestation-request",
        lease: structuredClone(lease),
        authorization: structuredClone(this.#options.authorization),
        spec: structuredClone(this.#spec),
        execution: structuredClone(execution),
        resultArtifact: structuredClone(resultArtifact),
      });
      assertTrustedGitPublicationReceipt(receipt, {
        lease,
        authorization: this.#options.authorization,
        spec: this.#spec,
        execution,
        resultArtifact,
        verifier: this.#options.receiptVerifier,
      });
      return receipt;
    } catch {
      throw new TrustedGitPublicationError(
        "Trusted cloud Git publication failed closed.",
      );
    } finally {
      if (lease !== undefined) {
        try {
          await this.#options.provider.destroy(lease);
        } catch {
          throw new TrustedGitPublicationError(
            "Trusted Git publication sandbox teardown failed; publication is unconfirmed.",
          );
        }
      }
    }
  }
}
