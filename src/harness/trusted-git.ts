import { canonicalHash } from "../schemas/canonical.js";
import type {
  RemoteExecutionReceipt,
  SandboxCreateRequest,
  SecretReference,
  TrustedCloudArtifactRef,
} from "../cloud/types.js";
import { fingerprintRemoteUrl } from "./git.js";
import type { RepositoryRegistration } from "./repository.js";

export const TRUSTED_GIT_CREDENTIAL_TARGET = "DF_GITHUB_TOKEN" as const;
export const TRUSTED_GIT_PROVIDER_API_HOST = "api.github.com" as const;
export const TRUSTED_GIT_MAXIMUM_LIFETIME_MS = 60 * 60_000;

const SHA256 = /^[a-f0-9]{64}$/u;
const OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SAFE_GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const SAFE_GITHUB_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/u;
const SAFE_ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_IMAGE_REFERENCE =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,446}@sha256:[a-f0-9]{64}$/u;
const SAFE_REMOTE_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const SAFE_WORKING_DIRECTORY = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const TRUSTED_URI = /^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;

export class TrustedGitContractError extends Error {
  override readonly name = "TrustedGitContractError";
}

export interface PrivateGitHubOrigin {
  readonly host: "github.com";
  readonly owner: string;
  readonly repository: string;
  readonly credential: SecretReference;
}

export function assertPrivateGitHubOrigin(
  origin: PrivateGitHubOrigin,
): void {
  assertExactPlainObjectKeys(
    origin,
    ["host", "owner", "repository", "credential"],
    "Private GitHub origin",
  );
  assertExactPlainObjectKeys(
    origin.credential,
    ["sourceEnvironmentName", "targetEnvironmentName"],
    "GitHub credential reference",
  );
  if (
    origin.host !== "github.com" ||
    !SAFE_GITHUB_OWNER.test(origin.owner) ||
    !SAFE_GITHUB_REPOSITORY.test(origin.repository) ||
    origin.repository.startsWith(".") ||
    origin.repository.endsWith(".git") ||
    !SAFE_ENVIRONMENT_NAME.test(origin.credential.sourceEnvironmentName) ||
    origin.credential.targetEnvironmentName !== TRUSTED_GIT_CREDENTIAL_TARGET
  ) {
    throw new TrustedGitContractError(
      "Private GitHub origin configuration is outside policy.",
    );
  }
}

export function assertExactPlainObjectKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TrustedGitContractError(`${label} must be a plain object.`);
  }
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new TrustedGitContractError(`${label} contains non-canonical fields.`);
  }
}

export function assertSha256(value: string, label: string): void {
  if (!SHA256.test(value)) {
    throw new TrustedGitContractError(`${label} is not a SHA-256 digest.`);
  }
}

export function assertGitObjectId(value: string, label: string): void {
  if (!OBJECT_ID.test(value)) {
    throw new TrustedGitContractError(`${label} is not a full Git object identifier.`);
  }
}

export function assertTrustedGitArtifact(
  artifact: TrustedCloudArtifactRef,
  expectedMediaType: string,
  label: string,
  maximumBytes = 4 * 1024 * 1024 * 1024,
): void {
  assertExactPlainObjectKeys(
    artifact,
    ["uri", "sha256", "mediaType", "byteLength"],
    label,
  );
  if (
    !TRUSTED_URI.test(artifact.uri) ||
    artifact.uri.includes("..") ||
    !SHA256.test(artifact.sha256) ||
    artifact.mediaType !== expectedMediaType ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength <= 0 ||
    artifact.byteLength > maximumBytes
  ) {
    throw new TrustedGitContractError(`${label} violates trusted artifact policy.`);
  }
}

export function sameTrustedArtifact(
  left: TrustedCloudArtifactRef,
  right: TrustedCloudArtifactRef,
): boolean {
  return canonicalHash(left) === canonicalHash(right);
}

export function assertRegisteredPrivateGitHubOrigin(
  registration: RepositoryRegistration,
  origin: PrivateGitHubOrigin,
): void {
  assertPrivateGitHubOrigin(origin);
  const fingerprint = fingerprintRemoteUrl(privateGitHubRemoteUrl(origin));
  if (
    fingerprint.hostHash !== registration.originFingerprint.hostHash ||
    fingerprint.repositoryHash !== registration.originFingerprint.repositoryHash ||
    registration.originVerification.private !== true ||
    registration.originVerification.fetchable !== true ||
    registration.originVerification.writable !== true
  ) {
    throw new TrustedGitContractError(
      "Private GitHub origin does not match the verified repository registration.",
    );
  }
}

export function privateGitHubRemoteUrl(origin: PrivateGitHubOrigin): string {
  return `https://${origin.host}/${origin.owner}/${origin.repository}.git`;
}

export function assertTrustedGitSandbox(
  sandbox: SandboxCreateRequest,
  origin: PrivateGitHubOrigin,
): void {
  assertTrustedGitSandboxWithDomains(sandbox, origin, [origin.host]);
}

export function assertTrustedGitRegistrationSandbox(
  sandbox: SandboxCreateRequest,
  origin: PrivateGitHubOrigin,
): void {
  assertTrustedGitSandboxWithDomains(sandbox, origin, [
    origin.host,
    TRUSTED_GIT_PROVIDER_API_HOST,
  ]);
}

function assertTrustedGitSandboxWithDomains(
  sandbox: SandboxCreateRequest,
  origin: PrivateGitHubOrigin,
  allowedDomains: readonly string[],
): void {
  assertPrivateGitHubOrigin(origin);
  if (
    !SAFE_ID.test(sandbox.requestId) ||
    !SAFE_ID.test(sandbox.regionClass) ||
    !/^sha256:[a-f0-9]{64}$/u.test(sandbox.imageDigest) ||
    !SAFE_IMAGE_REFERENCE.test(sandbox.imageReference) ||
    !sandbox.imageReference.endsWith(`@${sandbox.imageDigest}`) ||
    sandbox.resources.architecture !== "x86_64" ||
    !Number.isSafeInteger(sandbox.resources.cpuCores) ||
    sandbox.resources.cpuCores <= 0 ||
    !Number.isSafeInteger(sandbox.resources.memoryMiB) ||
    sandbox.resources.memoryMiB <= 0 ||
    !Number.isSafeInteger(sandbox.resources.diskMiB) ||
    sandbox.resources.diskMiB <= 0 ||
    sandbox.resources.gpuClass !== undefined ||
    sandbox.network.defaultAction !== "deny" ||
    sandbox.network.allowDomains.length !== allowedDomains.length ||
    sandbox.network.allowDomains.some(
      (domain, index) => domain !== allowedDomains[index],
    ) ||
    sandbox.lifetimeMs <= 0 ||
    sandbox.lifetimeMs > TRUSTED_GIT_MAXIMUM_LIFETIME_MS ||
    !Number.isSafeInteger(sandbox.lifetimeMs) ||
    sandbox.secretReferences.length !== 1 ||
    sandbox.secretReferences[0]?.sourceEnvironmentName !==
      origin.credential.sourceEnvironmentName ||
    sandbox.secretReferences[0]?.targetEnvironmentName !==
      origin.credential.targetEnvironmentName
  ) {
    throw new TrustedGitContractError(
      "Trusted Git requires a bounded x86_64 sandbox with only its exact GitHub grants.",
    );
  }
}

export function assertTrustedGitPaths(paths: {
  readonly workingDirectory: string;
  readonly workerRemotePath: string;
  readonly inputRemotePath?: string;
  readonly outputRemotePath: string;
  readonly resultRemotePath?: string;
}): void {
  const remotePaths = [
    paths.workerRemotePath,
    paths.outputRemotePath,
    ...(paths.inputRemotePath === undefined ? [] : [paths.inputRemotePath]),
    ...(paths.resultRemotePath === undefined ? [] : [paths.resultRemotePath]),
  ];
  if (
    !SAFE_WORKING_DIRECTORY.test(paths.workingDirectory) ||
    paths.workingDirectory === "/" ||
    remotePaths.some(
      (path) => !SAFE_REMOTE_PATH.test(path) || path.includes("/../"),
    ) ||
    new Set(remotePaths).size !== remotePaths.length
  ) {
    throw new TrustedGitContractError("Trusted Git cloud paths are invalid or overlap.");
  }
}

export function cloudExecutionReceiptHash(receipt: RemoteExecutionReceipt): string {
  return canonicalHash({
    provider: receipt.provider,
    sandboxId: receipt.sandboxId,
    executionId: receipt.executionId,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    exitCode: receipt.exitCode,
    timedOut: receipt.timedOut,
    cancelled: receipt.cancelled,
    stdout: receipt.stdout ?? null,
    stderr: receipt.stderr ?? null,
    resourceReport: receipt.resourceReport,
  });
}

export function assertSuccessfulCloudExecution(
  receipt: RemoteExecutionReceipt,
  label: string,
): void {
  if (receipt.exitCode !== 0 || receipt.timedOut || receipt.cancelled) {
    throw new TrustedGitContractError(`${label} failed in the trusted cloud sandbox.`);
  }
}
