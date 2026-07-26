import { createHash, type KeyLike } from "node:crypto";
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
import { fingerprintRemoteUrl, type RemoteFingerprint } from "./git.js";
import { OFFICIAL_PI_UPSTREAM_URL, type RepositoryRegistration } from "./repository.js";
import {
  assertExactPlainObjectKeys,
  assertGitObjectId,
  assertPrivateGitHubOrigin,
  assertSha256,
  assertSuccessfulCloudExecution,
  assertTrustedGitArtifact,
  assertTrustedGitPaths,
  assertTrustedGitRegistrationSandbox,
  cloudExecutionReceiptHash,
  type PrivateGitHubOrigin,
  privateGitHubRemoteUrl,
  TrustedGitContractError,
} from "./trusted-git.js";

const SAFE_HEAD_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u;
const SAFE_AUTHORIZATION_ID = /^registration-auth-[a-f0-9]{48}$/u;
const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const MAXIMUM_AUTHORIZATION_LIFETIME_MS = 24 * 60 * 60_000;
const REGISTRATION_WORKING_DIRECTORY = "/workspace";
const REGISTRATION_WORKER_REMOTE_PATH = "/trusted/git/registration-worker.mjs";
const REGISTRATION_RESULT_REMOTE_PATH = "/trusted/git/registration-result.json";

export const TRUSTED_PI_CODING_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent" as const;
export const TRUSTED_HARNESS_REGISTRATION_SCHEMA_VERSION = "1.2.0" as const;
export const TRUSTED_PI_ADAPTER_ID = "harbor-pi-print-json" as const;
export const TRUSTED_PI_ADAPTER_EXECUTION_MODE = "print-json" as const;
export const CLOUD_REGISTERED_PI_CANONICAL_PATH = "/trusted/cloud/pi" as const;

export interface TrustedGitRegistrationAuthorizationPayload {
  readonly sensitivity: "trusted-git-registration-authorization";
  readonly schemaVersion: 1;
  readonly authorizationId: string;
  readonly originRepositoryHash: string;
  readonly upstreamRepositoryHash: string;
  readonly remoteRef: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly lockSha256: string;
  readonly packageName: typeof TRUSTED_PI_CODING_AGENT_PACKAGE_NAME;
  readonly packageVersion: string;
  readonly harnessRegistrationSchemaVersion: typeof TRUSTED_HARNESS_REGISTRATION_SCHEMA_VERSION;
  readonly adapterId: typeof TRUSTED_PI_ADAPTER_ID;
  readonly adapterExecutionMode: typeof TRUSTED_PI_ADAPTER_EXECUTION_MODE;
  readonly sessionsDisabled: true;
  readonly uncontrolledExtensionsDisabled: true;
  readonly uncontrolledContextFilesDisabled: true;
  readonly workerSha256: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface TrustedGitRegistrationAuthorization
  extends TrustedGitRegistrationAuthorizationPayload {
  readonly signature: Signature;
}

export interface TrustedGitRegistrationAuthorizationVerifier {
  readonly trustedKeyId: string;
  readonly publicKey: KeyLike;
}

export interface TrustedGitRegistrationSpec {
  readonly registrationRequestId: string;
  readonly authorizationHash: string;
  readonly originRepositoryHash: string;
  readonly upstreamRepositoryHash: string;
  readonly remoteRef: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly lockSha256: string;
  readonly packageName: typeof TRUSTED_PI_CODING_AGENT_PACKAGE_NAME;
  readonly packageVersion: string;
  readonly harnessRegistrationSchemaVersion: typeof TRUSTED_HARNESS_REGISTRATION_SCHEMA_VERSION;
  readonly adapterId: typeof TRUSTED_PI_ADAPTER_ID;
  readonly adapterExecutionMode: typeof TRUSTED_PI_ADAPTER_EXECUTION_MODE;
  readonly sessionsDisabled: true;
  readonly uncontrolledExtensionsDisabled: true;
  readonly uncontrolledContextFilesDisabled: true;
  readonly workerArtifact: TrustedCloudArtifactRef;
  readonly workerRemotePath: string;
  readonly resultRemotePath: string;
  readonly command: RemoteCommandSpec;
}

export interface TrustedGitRegistrationWorkerResult {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.trusted-git-registration.v1";
  readonly authorizationHash: string;
  readonly registrationId: string;
  readonly originRepositoryHash: string;
  readonly upstreamRepositoryHash: string;
  readonly remoteRef: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly lockSha256: string;
  readonly packageName: typeof TRUSTED_PI_CODING_AGENT_PACKAGE_NAME;
  readonly packageVersion: string;
  readonly harnessRegistrationSchemaVersion: typeof TRUSTED_HARNESS_REGISTRATION_SCHEMA_VERSION;
  readonly adapterId: typeof TRUSTED_PI_ADAPTER_ID;
  readonly adapterExecutionMode: typeof TRUSTED_PI_ADAPTER_EXECUTION_MODE;
  readonly sessionsDisabled: true;
  readonly uncontrolledExtensionsDisabled: true;
  readonly uncontrolledContextFilesDisabled: true;
  readonly packageJsonSha256: string;
  readonly upstreamHeadCommit: string;
  readonly upstreamBaseCommit: string;
  readonly originPrivate: true;
  readonly originFetchable: true;
  readonly originWritable: true;
  readonly privacyEvidence: "github-rest-private-and-visibility";
  readonly fetchEvidence: "authenticated-ls-remote-and-fetch";
  readonly writeEvidence: "github-rest-permissions-push";
  readonly lineageEvidence: "canonical-upstream-fetched-merge-base";
  readonly providerRepositoryAttestationHash: string;
  readonly lineageAttestationHash: string;
  readonly providerVerifiedAt: string;
  readonly contentHash: string;
}

export interface TrustedGitRegistrationReceipt {
  readonly sensitivity: "trusted-git-registration";
  readonly schemaVersion: 1;
  readonly registrationRequestId: string;
  readonly authorizationHash: string;
  readonly registrationId: string;
  readonly originRepositoryHash: string;
  readonly upstreamRepositoryHash: string;
  readonly remoteRef: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly lockSha256: string;
  readonly packageName: typeof TRUSTED_PI_CODING_AGENT_PACKAGE_NAME;
  readonly packageVersion: string;
  readonly harnessRegistrationSchemaVersion: typeof TRUSTED_HARNESS_REGISTRATION_SCHEMA_VERSION;
  readonly adapterId: typeof TRUSTED_PI_ADAPTER_ID;
  readonly adapterExecutionMode: typeof TRUSTED_PI_ADAPTER_EXECUTION_MODE;
  readonly sessionsDisabled: true;
  readonly uncontrolledExtensionsDisabled: true;
  readonly uncontrolledContextFilesDisabled: true;
  readonly packageJsonSha256: string;
  readonly upstreamHeadCommit: string;
  readonly upstreamBaseCommit: string;
  readonly originPrivate: true;
  readonly originFetchable: true;
  readonly originWritable: true;
  readonly privacyEvidence: "github-rest-private-and-visibility";
  readonly fetchEvidence: "authenticated-ls-remote-and-fetch";
  readonly writeEvidence: "github-rest-permissions-push";
  readonly lineageEvidence: "canonical-upstream-fetched-merge-base";
  readonly providerRepositoryAttestationHash: string;
  readonly lineageAttestationHash: string;
  readonly providerVerifiedAt: string;
  readonly provider: "daytona" | "e2b" | "modal";
  readonly sandboxId: string;
  readonly imageReference: string;
  readonly imageDigest: string;
  readonly networkPolicyHash: string;
  readonly workerSha256: string;
  readonly executionReceiptHash: string;
  readonly resultArtifactSha256: string;
  readonly attestedAt: string;
  readonly passed: true;
  readonly signature: Signature;
}

export interface TrustedGitRegistrationAttestor {
  /**
   * The implementation must load the exact result artifact, parse it through
   * parseTrustedGitRegistrationWorkerResult, and sign only the release-safe
   * fields after matching the signed authorization and cloud execution.
   */
  attest(input: {
    readonly sensitivity: "trusted-git-registration-attestation-request";
    readonly lease: SandboxLease;
    readonly authorization: TrustedGitRegistrationAuthorization;
    readonly spec: TrustedGitRegistrationSpec;
    readonly execution: RemoteExecutionReceipt;
    readonly resultArtifact: TrustedCloudArtifactRef;
  }): Promise<TrustedGitRegistrationReceipt>;
}

export interface TrustedGitRegistrationReceiptVerifier {
  readonly trustedKeyId: string;
  readonly publicKey: KeyLike;
}

export interface TrustedGitRegistrationRunnerOptions {
  readonly provider: CloudSandboxProvider;
  readonly sandbox: SandboxCreateRequest;
  readonly origin: PrivateGitHubOrigin;
  readonly workerArtifact: TrustedCloudArtifactRef;
  readonly authorization: TrustedGitRegistrationAuthorization;
  readonly authorizationVerifier: TrustedGitRegistrationAuthorizationVerifier;
  readonly attestor: TrustedGitRegistrationAttestor;
  readonly receiptVerifier: TrustedGitRegistrationReceiptVerifier;
  readonly now?: () => Date;
}

export interface TrustedGitRegistrationRunResult {
  readonly receipt: TrustedGitRegistrationReceipt;
  readonly registration: RepositoryRegistration;
}

export class TrustedGitRegistrationError extends Error {
  override readonly name = "TrustedGitRegistrationError";
}

function isCanonicalTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function assertHeadRef(ref: string): void {
  if (
    !SAFE_HEAD_REF.test(ref) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock") ||
    ref
      .slice("refs/heads/".length)
      .split("/")
      .some(
        (component) =>
          component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock"),
      )
  ) {
    throw new TrustedGitContractError("Git registration branch ref is invalid.");
  }
}

function branchFromRef(ref: string): string {
  assertHeadRef(ref);
  return ref.slice("refs/heads/".length);
}

function assertPackageMetadata(packageName: string, packageVersion: string): void {
  if (packageName !== TRUSTED_PI_CODING_AGENT_PACKAGE_NAME || !EXACT_SEMVER.test(packageVersion)) {
    throw new TrustedGitContractError("Git registration Pi package metadata is invalid.");
  }
}

function registrationId(input: {
  readonly commitSha: string;
  readonly originRepositoryHash: string;
  readonly upstreamBaseCommit: string;
}): string {
  return createHash("sha256")
    .update(`${input.commitSha}:${input.originRepositoryHash}:${input.upstreamBaseCommit}`)
    .digest("hex");
}

function lineageAttestationHash(input: {
  readonly originRepositoryHash: string;
  readonly upstreamRepositoryHash: string;
  readonly upstreamHeadCommit: string;
  readonly upstreamBaseCommit: string;
  readonly commitSha: string;
}): string {
  return canonicalHash({
    originRepositoryHash: input.originRepositoryHash,
    upstreamRepositoryHash: input.upstreamRepositoryHash,
    upstreamHeadCommit: input.upstreamHeadCommit,
    upstreamBaseCommit: input.upstreamBaseCommit,
    baselineCommit: input.commitSha,
  });
}

export function createTrustedGitRegistrationAuthorizationPayload(input: {
  readonly origin: PrivateGitHubOrigin;
  readonly expectedBranch: string;
  readonly expectedCommit: string;
  readonly expectedTree: string;
  readonly expectedLockSha256: string;
  readonly expectedPackageName: typeof TRUSTED_PI_CODING_AGENT_PACKAGE_NAME;
  readonly expectedPackageVersion: string;
  readonly workerArtifact: TrustedCloudArtifactRef;
  readonly issuedAt: string;
  readonly expiresAt: string;
}): TrustedGitRegistrationAuthorizationPayload {
  assertPrivateGitHubOrigin(input.origin);
  const originFingerprint = fingerprintRemoteUrl(privateGitHubRemoteUrl(input.origin));
  const upstreamFingerprint = fingerprintRemoteUrl(OFFICIAL_PI_UPSTREAM_URL);
  const remoteRef = `refs/heads/${input.expectedBranch}`;
  assertHeadRef(remoteRef);
  assertGitObjectId(input.expectedCommit, "Authorized Pi commit");
  assertGitObjectId(input.expectedTree, "Authorized Pi tree");
  assertSha256(input.expectedLockSha256, "Authorized Pi package lock");
  assertPackageMetadata(input.expectedPackageName, input.expectedPackageVersion);
  assertTrustedGitArtifact(
    input.workerArtifact,
    "text/javascript",
    "Trusted Git registration worker",
    4 * 1024 * 1024,
  );
  const issuedAt = Date.parse(input.issuedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (
    !isCanonicalTimestamp(input.issuedAt) ||
    !isCanonicalTimestamp(input.expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAXIMUM_AUTHORIZATION_LIFETIME_MS
  ) {
    throw new TrustedGitContractError("Git registration authorization window is outside policy.");
  }
  const identity = {
    originRepositoryHash: originFingerprint.repositoryHash,
    upstreamRepositoryHash: upstreamFingerprint.repositoryHash,
    remoteRef,
    commitSha: input.expectedCommit,
    treeSha: input.expectedTree,
    lockSha256: input.expectedLockSha256,
    packageName: input.expectedPackageName,
    packageVersion: input.expectedPackageVersion,
    harnessRegistrationSchemaVersion: TRUSTED_HARNESS_REGISTRATION_SCHEMA_VERSION,
    adapterId: TRUSTED_PI_ADAPTER_ID,
    adapterExecutionMode: TRUSTED_PI_ADAPTER_EXECUTION_MODE,
    sessionsDisabled: true as const,
    uncontrolledExtensionsDisabled: true as const,
    uncontrolledContextFilesDisabled: true as const,
    workerSha256: input.workerArtifact.sha256,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
  return {
    sensitivity: "trusted-git-registration-authorization",
    schemaVersion: 1,
    authorizationId: `registration-auth-${canonicalHash(identity).slice(0, 48)}`,
    ...identity,
  };
}

function unsignedAuthorization(
  authorization: TrustedGitRegistrationAuthorization,
): TrustedGitRegistrationAuthorizationPayload {
  const { signature: _signature, ...payload } = authorization;
  return payload;
}

export function trustedGitRegistrationAuthorizationHash(
  authorization: TrustedGitRegistrationAuthorization,
): string {
  return canonicalHash(authorization);
}

export function assertTrustedGitRegistrationAuthorization(
  authorization: TrustedGitRegistrationAuthorization,
  input: {
    readonly origin: PrivateGitHubOrigin;
    readonly workerArtifact: TrustedCloudArtifactRef;
    readonly verifier: TrustedGitRegistrationAuthorizationVerifier;
    readonly now: Date;
  },
): void {
  assertExactPlainObjectKeys(
    authorization,
    [
      "sensitivity",
      "schemaVersion",
      "authorizationId",
      "originRepositoryHash",
      "upstreamRepositoryHash",
      "remoteRef",
      "commitSha",
      "treeSha",
      "lockSha256",
      "packageName",
      "packageVersion",
      "harnessRegistrationSchemaVersion",
      "adapterId",
      "adapterExecutionMode",
      "sessionsDisabled",
      "uncontrolledExtensionsDisabled",
      "uncontrolledContextFilesDisabled",
      "workerSha256",
      "issuedAt",
      "expiresAt",
      "signature",
    ],
    "Git registration authorization",
  );
  assertExactPlainObjectKeys(
    authorization.signature,
    ["algorithm", "keyId", "signedAt", "signature"],
    "Git registration authorization signature",
  );
  const expected = createTrustedGitRegistrationAuthorizationPayload({
    origin: input.origin,
    expectedBranch: branchFromRef(authorization.remoteRef),
    expectedCommit: authorization.commitSha,
    expectedTree: authorization.treeSha,
    expectedLockSha256: authorization.lockSha256,
    expectedPackageName: authorization.packageName,
    expectedPackageVersion: authorization.packageVersion,
    workerArtifact: input.workerArtifact,
    issuedAt: authorization.issuedAt,
    expiresAt: authorization.expiresAt,
  });
  const signedDocument = {
    ...unsignedAuthorization(authorization),
    signature: authorization.signature,
  };
  const now = input.now.getTime();
  if (
    authorization.sensitivity !== "trusted-git-registration-authorization" ||
    authorization.schemaVersion !== 1 ||
    !SAFE_AUTHORIZATION_ID.test(authorization.authorizationId) ||
    canonicalHash(unsignedAuthorization(authorization)) !== canonicalHash(expected) ||
    authorization.workerSha256 !== input.workerArtifact.sha256 ||
    !Number.isFinite(now) ||
    now < Date.parse(authorization.issuedAt) ||
    now >= Date.parse(authorization.expiresAt) ||
    authorization.signature.algorithm !== "ed25519" ||
    authorization.signature.keyId !== input.verifier.trustedKeyId ||
    !isCanonicalTimestamp(authorization.signature.signedAt) ||
    Date.parse(authorization.signature.signedAt) < Date.parse(authorization.issuedAt) ||
    Date.parse(authorization.signature.signedAt) > Date.parse(authorization.expiresAt) ||
    Date.parse(authorization.signature.signedAt) > now ||
    !verifyEd25519Signature(signedDocument, input.verifier.publicKey)
  ) {
    throw new TrustedGitContractError(
      "Git registration authorization is invalid, expired, or not trusted.",
    );
  }
}

export function createTrustedGitRegistrationSpec(input: {
  readonly requestId: string;
  readonly origin: PrivateGitHubOrigin;
  readonly workerArtifact: TrustedCloudArtifactRef;
  readonly authorization: TrustedGitRegistrationAuthorization;
}): TrustedGitRegistrationSpec {
  assertPrivateGitHubOrigin(input.origin);
  assertTrustedGitArtifact(
    input.workerArtifact,
    "text/javascript",
    "Trusted Git registration worker",
    4 * 1024 * 1024,
  );
  const originFingerprint = fingerprintRemoteUrl(privateGitHubRemoteUrl(input.origin));
  if (
    originFingerprint.repositoryHash !== input.authorization.originRepositoryHash ||
    input.authorization.workerSha256 !== input.workerArtifact.sha256 ||
    input.authorization.harnessRegistrationSchemaVersion !==
      TRUSTED_HARNESS_REGISTRATION_SCHEMA_VERSION ||
    input.authorization.adapterId !== TRUSTED_PI_ADAPTER_ID ||
    input.authorization.adapterExecutionMode !== TRUSTED_PI_ADAPTER_EXECUTION_MODE ||
    input.authorization.sessionsDisabled !== true ||
    input.authorization.uncontrolledExtensionsDisabled !== true ||
    input.authorization.uncontrolledContextFilesDisabled !== true
  ) {
    throw new TrustedGitContractError(
      "Git registration authorization does not identify the configured origin.",
    );
  }
  const authorizationHash = trustedGitRegistrationAuthorizationHash(input.authorization);
  const registrationRequestId = `registration-${canonicalHash({
    requestId: input.requestId,
    authorizationHash,
  }).slice(0, 48)}`;
  assertTrustedGitPaths({
    workingDirectory: REGISTRATION_WORKING_DIRECTORY,
    workerRemotePath: REGISTRATION_WORKER_REMOTE_PATH,
    outputRemotePath: REGISTRATION_RESULT_REMOTE_PATH,
  });
  const command: RemoteCommandSpec = {
    executable: "/usr/bin/node",
    arguments: [
      REGISTRATION_WORKER_REMOTE_PATH,
      "register",
      "--authorization-sha256",
      authorizationHash,
      "--authorization-expires-at",
      input.authorization.expiresAt,
      "--remote",
      privateGitHubRemoteUrl(input.origin),
      "--origin-repository-sha256",
      input.authorization.originRepositoryHash,
      "--ref",
      input.authorization.remoteRef,
      "--commit",
      input.authorization.commitSha,
      "--tree",
      input.authorization.treeSha,
      "--lock-sha256",
      input.authorization.lockSha256,
      "--package-name",
      input.authorization.packageName,
      "--package-version",
      input.authorization.packageVersion,
      "--harness-registration-schema-version",
      input.authorization.harnessRegistrationSchemaVersion,
      "--adapter-id",
      input.authorization.adapterId,
      "--adapter-execution-mode",
      input.authorization.adapterExecutionMode,
      "--sessions-disabled",
      String(input.authorization.sessionsDisabled),
      "--uncontrolled-extensions-disabled",
      String(input.authorization.uncontrolledExtensionsDisabled),
      "--uncontrolled-context-files-disabled",
      String(input.authorization.uncontrolledContextFilesDisabled),
      "--upstream",
      OFFICIAL_PI_UPSTREAM_URL,
      "--upstream-repository-sha256",
      input.authorization.upstreamRepositoryHash,
      "--result",
      REGISTRATION_RESULT_REMOTE_PATH,
    ],
    workingDirectory: REGISTRATION_WORKING_DIRECTORY,
    timeoutMs: 20 * 60_000,
    environment: {
      CI: "true",
      DF_CLOUD_EXECUTION: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    secretReferences: [input.origin.credential],
  };
  return {
    registrationRequestId,
    authorizationHash,
    originRepositoryHash: input.authorization.originRepositoryHash,
    upstreamRepositoryHash: input.authorization.upstreamRepositoryHash,
    remoteRef: input.authorization.remoteRef,
    commitSha: input.authorization.commitSha,
    treeSha: input.authorization.treeSha,
    lockSha256: input.authorization.lockSha256,
    packageName: input.authorization.packageName,
    packageVersion: input.authorization.packageVersion,
    harnessRegistrationSchemaVersion: input.authorization.harnessRegistrationSchemaVersion,
    adapterId: input.authorization.adapterId,
    adapterExecutionMode: input.authorization.adapterExecutionMode,
    sessionsDisabled: input.authorization.sessionsDisabled,
    uncontrolledExtensionsDisabled: input.authorization.uncontrolledExtensionsDisabled,
    uncontrolledContextFilesDisabled: input.authorization.uncontrolledContextFilesDisabled,
    workerArtifact: structuredClone(input.workerArtifact),
    workerRemotePath: REGISTRATION_WORKER_REMOTE_PATH,
    resultRemotePath: REGISTRATION_RESULT_REMOTE_PATH,
    command,
  };
}

export function assertTrustedGitRegistrationWorkerResult(
  result: unknown,
  input: {
    readonly authorization: TrustedGitRegistrationAuthorization;
    readonly spec: TrustedGitRegistrationSpec;
  },
): asserts result is TrustedGitRegistrationWorkerResult {
  assertExactPlainObjectKeys(
    result,
    [
      "schemaVersion",
      "domain",
      "authorizationHash",
      "registrationId",
      "originRepositoryHash",
      "upstreamRepositoryHash",
      "remoteRef",
      "commitSha",
      "treeSha",
      "lockSha256",
      "packageName",
      "packageVersion",
      "harnessRegistrationSchemaVersion",
      "adapterId",
      "adapterExecutionMode",
      "sessionsDisabled",
      "uncontrolledExtensionsDisabled",
      "uncontrolledContextFilesDisabled",
      "packageJsonSha256",
      "upstreamHeadCommit",
      "upstreamBaseCommit",
      "originPrivate",
      "originFetchable",
      "originWritable",
      "privacyEvidence",
      "fetchEvidence",
      "writeEvidence",
      "lineageEvidence",
      "providerRepositoryAttestationHash",
      "lineageAttestationHash",
      "providerVerifiedAt",
      "contentHash",
    ],
    "Git registration worker result",
  );
  const document = result as unknown as TrustedGitRegistrationWorkerResult;
  assertGitObjectId(document.upstreamHeadCommit, "Verified upstream HEAD");
  assertGitObjectId(document.upstreamBaseCommit, "Verified upstream merge base");
  assertSha256(document.packageJsonSha256, "Verified Pi package metadata");
  assertSha256(document.providerRepositoryAttestationHash, "GitHub repository attestation");
  assertSha256(document.lineageAttestationHash, "Git lineage attestation");
  const expectedRegistrationId = registrationId({
    commitSha: input.spec.commitSha,
    originRepositoryHash: input.spec.originRepositoryHash,
    upstreamBaseCommit: document.upstreamBaseCommit,
  });
  const expectedLineageHash = lineageAttestationHash({
    originRepositoryHash: input.spec.originRepositoryHash,
    upstreamRepositoryHash: input.spec.upstreamRepositoryHash,
    upstreamHeadCommit: document.upstreamHeadCommit,
    upstreamBaseCommit: document.upstreamBaseCommit,
    commitSha: input.spec.commitSha,
  });
  if (
    document.schemaVersion !== 1 ||
    document.domain !== "dark-factory.trusted-git-registration.v1" ||
    document.authorizationHash !== input.spec.authorizationHash ||
    document.registrationId !== expectedRegistrationId ||
    document.originRepositoryHash !== input.spec.originRepositoryHash ||
    document.upstreamRepositoryHash !== input.spec.upstreamRepositoryHash ||
    document.remoteRef !== input.spec.remoteRef ||
    document.commitSha !== input.spec.commitSha ||
    document.treeSha !== input.spec.treeSha ||
    document.lockSha256 !== input.spec.lockSha256 ||
    document.packageName !== input.spec.packageName ||
    document.packageVersion !== input.spec.packageVersion ||
    document.harnessRegistrationSchemaVersion !== TRUSTED_HARNESS_REGISTRATION_SCHEMA_VERSION ||
    document.harnessRegistrationSchemaVersion !== input.spec.harnessRegistrationSchemaVersion ||
    document.adapterId !== TRUSTED_PI_ADAPTER_ID ||
    document.adapterId !== input.spec.adapterId ||
    document.adapterExecutionMode !== TRUSTED_PI_ADAPTER_EXECUTION_MODE ||
    document.adapterExecutionMode !== input.spec.adapterExecutionMode ||
    document.sessionsDisabled !== true ||
    document.uncontrolledExtensionsDisabled !== true ||
    document.uncontrolledContextFilesDisabled !== true ||
    document.originPrivate !== true ||
    document.originFetchable !== true ||
    document.originWritable !== true ||
    document.privacyEvidence !== "github-rest-private-and-visibility" ||
    document.fetchEvidence !== "authenticated-ls-remote-and-fetch" ||
    document.writeEvidence !== "github-rest-permissions-push" ||
    document.lineageEvidence !== "canonical-upstream-fetched-merge-base" ||
    document.lineageAttestationHash !== expectedLineageHash ||
    !isCanonicalTimestamp(document.providerVerifiedAt) ||
    typeof document.contentHash !== "string" ||
    document.contentHash !== computeContentHash(document) ||
    trustedGitRegistrationAuthorizationHash(input.authorization) !== input.spec.authorizationHash
  ) {
    throw new TrustedGitContractError(
      "Git registration worker result does not prove the authorized private fork.",
    );
  }
}

export function parseTrustedGitRegistrationWorkerResult(
  raw: string,
  input: {
    readonly authorization: TrustedGitRegistrationAuthorization;
    readonly spec: TrustedGitRegistrationSpec;
  },
): TrustedGitRegistrationWorkerResult {
  if (Buffer.byteLength(raw, "utf8") <= 0 || Buffer.byteLength(raw, "utf8") > 4 * 1024 * 1024) {
    throw new TrustedGitContractError("Git registration worker result size is outside policy.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TrustedGitContractError("Git registration worker result is not valid JSON.");
  }
  assertTrustedGitRegistrationWorkerResult(parsed, input);
  if (raw !== `${canonicalJson(parsed)}\n`) {
    throw new TrustedGitContractError("Git registration worker result is not canonical JSON.");
  }
  return parsed;
}

function unsignedReceipt(
  receipt: TrustedGitRegistrationReceipt,
): Readonly<Record<string, unknown>> {
  const { signature: _signature, ...payload } = receipt;
  return payload;
}

export function gitRegistrationReceiptHash(receipt: TrustedGitRegistrationReceipt): string {
  return canonicalHash(unsignedReceipt(receipt));
}

export function assertTrustedGitRegistrationReceipt(
  receipt: TrustedGitRegistrationReceipt,
  input: {
    readonly lease: SandboxLease;
    readonly authorization: TrustedGitRegistrationAuthorization;
    readonly spec: TrustedGitRegistrationSpec;
    readonly execution: RemoteExecutionReceipt;
    readonly resultArtifact: TrustedCloudArtifactRef;
    readonly verifier: TrustedGitRegistrationReceiptVerifier;
  },
): void {
  assertExactPlainObjectKeys(
    receipt,
    [
      "sensitivity",
      "schemaVersion",
      "registrationRequestId",
      "authorizationHash",
      "registrationId",
      "originRepositoryHash",
      "upstreamRepositoryHash",
      "remoteRef",
      "commitSha",
      "treeSha",
      "lockSha256",
      "packageName",
      "packageVersion",
      "harnessRegistrationSchemaVersion",
      "adapterId",
      "adapterExecutionMode",
      "sessionsDisabled",
      "uncontrolledExtensionsDisabled",
      "uncontrolledContextFilesDisabled",
      "packageJsonSha256",
      "upstreamHeadCommit",
      "upstreamBaseCommit",
      "originPrivate",
      "originFetchable",
      "originWritable",
      "privacyEvidence",
      "fetchEvidence",
      "writeEvidence",
      "lineageEvidence",
      "providerRepositoryAttestationHash",
      "lineageAttestationHash",
      "providerVerifiedAt",
      "provider",
      "sandboxId",
      "imageReference",
      "imageDigest",
      "networkPolicyHash",
      "workerSha256",
      "executionReceiptHash",
      "resultArtifactSha256",
      "attestedAt",
      "passed",
      "signature",
    ],
    "Git registration receipt",
  );
  assertExactPlainObjectKeys(
    receipt.signature,
    ["algorithm", "keyId", "signedAt", "signature"],
    "Git registration receipt signature",
  );
  assertTrustedGitArtifact(
    input.resultArtifact,
    "application/json",
    "Git registration worker result",
    4 * 1024 * 1024,
  );
  assertGitObjectId(receipt.upstreamHeadCommit, "Registered upstream HEAD");
  assertGitObjectId(receipt.upstreamBaseCommit, "Registered upstream merge base");
  assertSha256(receipt.packageJsonSha256, "Registered Pi package metadata");
  assertSha256(
    receipt.providerRepositoryAttestationHash,
    "Registered GitHub repository attestation",
  );
  const expectedRegistrationId = registrationId({
    commitSha: input.spec.commitSha,
    originRepositoryHash: input.spec.originRepositoryHash,
    upstreamBaseCommit: receipt.upstreamBaseCommit,
  });
  const expectedLineageHash = lineageAttestationHash({
    originRepositoryHash: input.spec.originRepositoryHash,
    upstreamRepositoryHash: input.spec.upstreamRepositoryHash,
    upstreamHeadCommit: receipt.upstreamHeadCommit,
    upstreamBaseCommit: receipt.upstreamBaseCommit,
    commitSha: input.spec.commitSha,
  });
  const signedDocument = {
    ...unsignedReceipt(receipt),
    signature: receipt.signature,
  };
  if (
    receipt.sensitivity !== "trusted-git-registration" ||
    receipt.schemaVersion !== 1 ||
    receipt.registrationRequestId !== input.spec.registrationRequestId ||
    receipt.authorizationHash !== input.spec.authorizationHash ||
    receipt.registrationId !== expectedRegistrationId ||
    receipt.originRepositoryHash !== input.spec.originRepositoryHash ||
    receipt.upstreamRepositoryHash !== input.spec.upstreamRepositoryHash ||
    receipt.remoteRef !== input.spec.remoteRef ||
    receipt.commitSha !== input.spec.commitSha ||
    receipt.treeSha !== input.spec.treeSha ||
    receipt.lockSha256 !== input.spec.lockSha256 ||
    receipt.packageName !== input.spec.packageName ||
    receipt.packageVersion !== input.spec.packageVersion ||
    receipt.harnessRegistrationSchemaVersion !== TRUSTED_HARNESS_REGISTRATION_SCHEMA_VERSION ||
    receipt.harnessRegistrationSchemaVersion !== input.spec.harnessRegistrationSchemaVersion ||
    receipt.adapterId !== TRUSTED_PI_ADAPTER_ID ||
    receipt.adapterId !== input.spec.adapterId ||
    receipt.adapterExecutionMode !== TRUSTED_PI_ADAPTER_EXECUTION_MODE ||
    receipt.adapterExecutionMode !== input.spec.adapterExecutionMode ||
    receipt.sessionsDisabled !== true ||
    receipt.uncontrolledExtensionsDisabled !== true ||
    receipt.uncontrolledContextFilesDisabled !== true ||
    receipt.originPrivate !== true ||
    receipt.originFetchable !== true ||
    receipt.originWritable !== true ||
    receipt.privacyEvidence !== "github-rest-private-and-visibility" ||
    receipt.fetchEvidence !== "authenticated-ls-remote-and-fetch" ||
    receipt.writeEvidence !== "github-rest-permissions-push" ||
    receipt.lineageEvidence !== "canonical-upstream-fetched-merge-base" ||
    receipt.lineageAttestationHash !== expectedLineageHash ||
    !isCanonicalTimestamp(receipt.providerVerifiedAt) ||
    Date.parse(receipt.providerVerifiedAt) < Date.parse(input.execution.startedAt) ||
    Date.parse(receipt.providerVerifiedAt) > Date.parse(input.execution.finishedAt) ||
    Date.parse(receipt.providerVerifiedAt) >= Date.parse(input.authorization.expiresAt) ||
    receipt.provider !== input.lease.provider ||
    receipt.sandboxId !== input.lease.sandboxId ||
    receipt.imageReference !== input.lease.imageReference ||
    receipt.imageDigest !== input.lease.imageDigest ||
    receipt.networkPolicyHash !== input.lease.networkPolicyHash ||
    receipt.workerSha256 !== input.spec.workerArtifact.sha256 ||
    receipt.executionReceiptHash !== cloudExecutionReceiptHash(input.execution) ||
    receipt.resultArtifactSha256 !== input.resultArtifact.sha256 ||
    !isCanonicalTimestamp(receipt.attestedAt) ||
    Date.parse(receipt.attestedAt) < Date.parse(input.execution.finishedAt) ||
    Date.parse(receipt.attestedAt) > Date.parse(input.lease.expiresAt) ||
    receipt.passed !== true ||
    receipt.signature.algorithm !== "ed25519" ||
    receipt.signature.keyId !== input.verifier.trustedKeyId ||
    !isCanonicalTimestamp(receipt.signature.signedAt) ||
    Date.parse(receipt.signature.signedAt) < Date.parse(receipt.attestedAt) ||
    Date.parse(receipt.signature.signedAt) > Date.parse(input.lease.expiresAt) ||
    !verifyEd25519Signature(signedDocument, input.verifier.publicKey)
  ) {
    throw new TrustedGitContractError(
      "Git registration receipt does not prove the exact authorized private fork.",
    );
  }
}

function repositoryRegistrationFromReceipt(
  receipt: TrustedGitRegistrationReceipt,
): RepositoryRegistration {
  const upstreamFingerprint = fingerprintRemoteUrl(OFFICIAL_PI_UPSTREAM_URL);
  const originFingerprint: RemoteFingerprint = {
    transport: "https",
    hostHash: upstreamFingerprint.hostHash,
    repositoryHash: receipt.originRepositoryHash,
  };
  return {
    registrationId: receipt.registrationId,
    canonicalPath: CLOUD_REGISTERED_PI_CANONICAL_PATH,
    branch: branchFromRef(receipt.remoteRef),
    headCommit: receipt.commitSha,
    treeSha: receipt.treeSha,
    lockSha256: receipt.lockSha256,
    upstreamBaseCommit: receipt.upstreamBaseCommit,
    originFingerprint,
    upstreamFingerprint,
    originVerification: {
      private: true,
      fetchable: true,
      writable: true,
      checkedAt: receipt.providerVerifiedAt,
      providerAttestationHash: receipt.providerRepositoryAttestationHash,
    },
    upstreamVerification: {
      fetchable: true,
      upstreamHeadCommit: receipt.upstreamHeadCommit,
      mergeBaseCommit: receipt.upstreamBaseCommit,
      checkedAt: receipt.providerVerifiedAt,
      providerAttestationHash: receipt.lineageAttestationHash,
    },
  };
}

/**
 * Registers an exact private Pi fork entirely within a trusted cloud sandbox.
 * The result contains no repository URL, owner, credential, or local path.
 */
export class TrustedGitRegistrationRunner {
  readonly #options: TrustedGitRegistrationRunnerOptions & {
    readonly now: () => Date;
  };
  readonly #spec: TrustedGitRegistrationSpec;

  constructor(options: TrustedGitRegistrationRunnerOptions) {
    assertTrustedGitRegistrationSandbox(options.sandbox, options.origin);
    assertTrustedGitArtifact(
      options.workerArtifact,
      "text/javascript",
      "Trusted Git registration worker",
      4 * 1024 * 1024,
    );
    const now = options.now ?? (() => new Date());
    assertTrustedGitRegistrationAuthorization(options.authorization, {
      origin: options.origin,
      workerArtifact: options.workerArtifact,
      verifier: options.authorizationVerifier,
      now: now(),
    });
    this.#options = {
      provider: options.provider,
      sandbox: structuredClone(options.sandbox),
      origin: structuredClone(options.origin),
      workerArtifact: structuredClone(options.workerArtifact),
      authorization: structuredClone(options.authorization),
      authorizationVerifier: {
        trustedKeyId: options.authorizationVerifier.trustedKeyId,
        publicKey: options.authorizationVerifier.publicKey,
      },
      attestor: options.attestor,
      receiptVerifier: {
        trustedKeyId: options.receiptVerifier.trustedKeyId,
        publicKey: options.receiptVerifier.publicKey,
      },
      now,
    };
    this.#spec = createTrustedGitRegistrationSpec({
      requestId: this.#options.sandbox.requestId,
      origin: this.#options.origin,
      workerArtifact: this.#options.workerArtifact,
      authorization: this.#options.authorization,
    });
  }

  async run(): Promise<TrustedGitRegistrationRunResult> {
    let lease: SandboxLease | undefined;
    let result: TrustedGitRegistrationRunResult | undefined;
    let failure: { readonly error: unknown } | undefined;
    let teardownFailure: { readonly error: unknown } | undefined;
    try {
      assertTrustedGitRegistrationAuthorization(this.#options.authorization, {
        origin: this.#options.origin,
        workerArtifact: this.#options.workerArtifact,
        verifier: this.#options.authorizationVerifier,
        now: this.#options.now(),
      });
      await requireCompatibleProvider(this.#options.provider, {
        requestId: `probe-${canonicalHash(this.#spec.registrationRequestId).slice(0, 32)}`,
        imageDigest: this.#options.sandbox.imageDigest,
        regionClass: this.#options.sandbox.regionClass,
        resources: this.#options.sandbox.resources,
        requireDockerInDocker: false,
        requireGpu: false,
      });
      lease = await this.#options.provider.create({
        ...this.#options.sandbox,
        requestId: this.#spec.registrationRequestId,
      });
      await this.#options.provider.upload(
        lease,
        structuredClone(this.#spec.workerArtifact),
        this.#spec.workerRemotePath,
      );
      const execution = structuredClone(
        await this.#options.provider.execute(lease, structuredClone(this.#spec.command)),
      );
      assertSuccessfulCloudExecution(execution, "Git repository registration");
      const resultArtifact = structuredClone(
        await this.#options.provider.download(lease, this.#spec.resultRemotePath, {
          mediaType: "application/json",
          maximumByteLength: 4 * 1024 * 1024,
        }),
      );
      const receipt = await this.#options.attestor.attest({
        sensitivity: "trusted-git-registration-attestation-request",
        lease: structuredClone(lease),
        authorization: structuredClone(this.#options.authorization),
        spec: structuredClone(this.#spec),
        execution: structuredClone(execution),
        resultArtifact: structuredClone(resultArtifact),
      });
      assertTrustedGitRegistrationReceipt(receipt, {
        lease,
        authorization: this.#options.authorization,
        spec: this.#spec,
        execution,
        resultArtifact,
        verifier: this.#options.receiptVerifier,
      });
      result = {
        receipt,
        registration: repositoryRegistrationFromReceipt(receipt),
      };
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
      throw new TrustedGitRegistrationError(
        "Trusted Git registration sandbox teardown failed; the registration is invalid.",
        {
          cause:
            failure === undefined
              ? teardownFailure.error
              : new AggregateError(
                  [failure.error, teardownFailure.error],
                  "Git registration and sandbox teardown both failed.",
                ),
        },
      );
    }
    if (failure !== undefined || result === undefined) {
      throw new TrustedGitRegistrationError(
        "Trusted cloud Git repository registration failed closed.",
        { cause: failure?.error },
      );
    }
    return result;
  }
}
