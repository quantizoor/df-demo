import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  assertObjectId,
  fingerprintRemoteUrl,
  type RemoteFingerprint,
  type SensitiveRemoteReference,
  SafeGit,
} from "./git.js";

export interface RemoteVerification {
  readonly private: boolean;
  readonly fetchable: boolean;
  readonly writable: boolean;
  readonly checkedAt: string;
  readonly providerAttestationHash: string;
}

export interface UpstreamLineageVerification {
  readonly fetchable: true;
  readonly upstreamHeadCommit: string;
  readonly mergeBaseCommit: string;
  readonly checkedAt: string;
  readonly providerAttestationHash: string;
}

export interface RemoteVerifier {
  verifyOrigin(
    workingDirectory: string,
    reference: SensitiveRemoteReference,
  ): Promise<RemoteVerification>;

  /**
   * Resolves the merge base in an isolated cloud clone. Implementations must
   * fetch both remotes there; repository registration never mutates or fetches
   * through the operator's canonical local checkout.
   */
  verifyUpstreamLineage(input: {
    readonly origin: SensitiveRemoteReference;
    readonly upstream: SensitiveRemoteReference;
    readonly forkHeadCommit: string;
  }): Promise<UpstreamLineageVerification>;
}

export interface RepositoryDoctorExpectation {
  readonly canonicalPath: string;
  readonly expectedBranch: string;
  readonly expectedTrackingRemote: "origin";
}

export interface RepositoryDoctorReport {
  readonly canonicalPath: string;
  readonly branch: string;
  readonly trackingRef: string;
  readonly headCommit: string;
  readonly treeSha: string;
  readonly lockSha256: string;
  readonly originFingerprint: RemoteFingerprint;
  readonly remotes: readonly string[];
  readonly clean: true;
  readonly piMonorepo: true;
}

export interface RepositoryRegistration {
  readonly registrationId: string;
  readonly canonicalPath: string;
  readonly branch: string;
  readonly headCommit: string;
  readonly treeSha: string;
  readonly lockSha256: string;
  readonly upstreamBaseCommit: string;
  readonly originFingerprint: RemoteFingerprint;
  readonly upstreamFingerprint: RemoteFingerprint;
  readonly originVerification: RemoteVerification;
  readonly upstreamVerification: UpstreamLineageVerification;
}

export const OFFICIAL_PI_UPSTREAM_URL =
  "https://github.com/earendil-works/pi.git" as const;

export class RepositoryPolicyError extends Error {
  override readonly name = "RepositoryPolicyError";
}

function splitLines(value: string): readonly string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function assertExpectedPath(actual: string, expected: string): void {
  if (resolve(actual) !== resolve(expected)) {
    throw new RepositoryPolicyError("Git top-level path does not match the registered repository.");
  }
}

function assertPiPackage(rawPackage: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPackage);
  } catch {
    throw new RepositoryPolicyError("Pi package metadata is not valid JSON.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("name" in parsed) ||
    typeof parsed.name !== "string" ||
    !parsed.name.endsWith("/pi-coding-agent")
  ) {
    throw new RepositoryPolicyError("Repository is not the expected Pi monorepo.");
  }
}

export async function doctorRepository(
  git: SafeGit,
  expectation: RepositoryDoctorExpectation,
): Promise<RepositoryDoctorReport> {
  const canonicalPath = resolve(expectation.canonicalPath);
  if (!expectation.canonicalPath.startsWith("/")) {
    throw new RepositoryPolicyError("Canonical repository path must be absolute.");
  }

  const inside = await git.text(canonicalPath, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") {
    throw new RepositoryPolicyError("Canonical repository is not a Git worktree.");
  }
  assertExpectedPath(
    await git.text(canonicalPath, ["rev-parse", "--show-toplevel"]),
    canonicalPath,
  );

  const dirty = await git.text(canonicalPath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  if (dirty.length > 0) {
    throw new RepositoryPolicyError(
      "Canonical Pi worktree is dirty; Dark Factory will not clean or reset it.",
    );
  }

  const branch = await git.text(canonicalPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch !== expectation.expectedBranch) {
    throw new RepositoryPolicyError("Canonical Pi worktree is on an unexpected branch.");
  }
  const trackingRef = await git.text(canonicalPath, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (trackingRef !== `${expectation.expectedTrackingRemote}/${expectation.expectedBranch}`) {
    throw new RepositoryPolicyError("Canonical branch does not track the designated origin.");
  }

  const headCommit = assertObjectId(await git.text(canonicalPath, ["rev-parse", "HEAD"]));
  const treeSha = assertObjectId(
    await git.text(canonicalPath, ["rev-parse", "HEAD^{tree}"]),
  );
  const remotes = splitLines(await git.text(canonicalPath, ["remote"]));
  if (!remotes.includes("origin")) {
    throw new RepositoryPolicyError("Canonical Pi repository has no origin remote.");
  }
  const originUrl = await git.text(canonicalPath, ["config", "--get", "remote.origin.url"]);
  const originFingerprint = fingerprintRemoteUrl(originUrl);
  assertPiPackage(
    await git.text(canonicalPath, ["show", "HEAD:packages/coding-agent/package.json"]),
  );
  const lockSha256 = createHash("sha256")
    .update((await git.run(canonicalPath, ["show", "HEAD:package-lock.json"])).stdout)
    .digest("hex");

  return {
    canonicalPath,
    branch,
    trackingRef,
    headCommit,
    treeSha,
    lockSha256,
    originFingerprint,
    remotes,
    clean: true,
    piMonorepo: true,
  };
}

export async function registerRepository(
  git: SafeGit,
  remoteVerifier: RemoteVerifier,
  expectation: RepositoryDoctorExpectation,
): Promise<RepositoryRegistration> {
  const report = await doctorRepository(git, expectation);
  const originUrl = await git.text(report.canonicalPath, [
    "config",
    "--get",
    "remote.origin.url",
  ]);
  const originVerification = await remoteVerifier.verifyOrigin(report.canonicalPath, {
    remoteName: "origin",
    url: originUrl,
  });
  if (
    !originVerification.private ||
    !originVerification.fetchable ||
    !originVerification.writable ||
    !Number.isFinite(Date.parse(originVerification.checkedAt)) ||
    !/^[a-f0-9]{64}$/u.test(originVerification.providerAttestationHash)
  ) {
    throw new RepositoryPolicyError(
      "Origin must be verified private, fetchable, and writable before registration.",
    );
  }

  if (report.remotes.includes("upstream")) {
    const upstreamUrl = await git.text(report.canonicalPath, [
      "config",
      "--get",
      "remote.upstream.url",
    ]);
    if (
      fingerprintRemoteUrl(upstreamUrl).repositoryHash !==
      fingerprintRemoteUrl(OFFICIAL_PI_UPSTREAM_URL).repositoryHash
    ) {
      throw new RepositoryPolicyError(
        "Existing upstream does not identify the canonical Pi repository.",
      );
    }
  }

  const upstreamVerification = await remoteVerifier.verifyUpstreamLineage({
    origin: {
      remoteName: "origin",
      url: originUrl,
    },
    upstream: {
      remoteName: "upstream",
      url: OFFICIAL_PI_UPSTREAM_URL,
    },
    forkHeadCommit: report.headCommit,
  });
  const upstreamBaseCommit = assertObjectId(upstreamVerification.mergeBaseCommit);
  assertObjectId(upstreamVerification.upstreamHeadCommit);
  if (
    upstreamVerification.fetchable !== true ||
    !Number.isFinite(Date.parse(upstreamVerification.checkedAt)) ||
    !/^[a-f0-9]{64}$/u.test(upstreamVerification.providerAttestationHash)
  ) {
    throw new RepositoryPolicyError(
      "Canonical upstream lineage could not be verified in the cloud.",
    );
  }
  const upstreamFingerprint = fingerprintRemoteUrl(OFFICIAL_PI_UPSTREAM_URL);
  if (
    upstreamFingerprint.repositoryHash ===
    report.originFingerprint.repositoryHash
  ) {
    throw new RepositoryPolicyError(
      "Private origin and canonical upstream must be distinct repositories.",
    );
  }
  const registrationId = createHash("sha256")
    .update(
      [report.headCommit, report.originFingerprint.repositoryHash, upstreamBaseCommit].join(":"),
    )
    .digest("hex");

  return {
    registrationId,
    canonicalPath: report.canonicalPath,
    branch: report.branch,
    headCommit: report.headCommit,
    treeSha: report.treeSha,
    lockSha256: report.lockSha256,
    upstreamBaseCommit,
    originFingerprint: report.originFingerprint,
    upstreamFingerprint,
    originVerification,
    upstreamVerification,
  };
}

export async function createImmutableBaselineTag(
  _git: SafeGit,
  _registration: RepositoryRegistration,
  tagName: string,
): Promise<never> {
  if (!/^df\/baseline\/[0-9]{3,8}$/u.test(tagName)) {
    throw new RepositoryPolicyError("Baseline tag name is invalid.");
  }
  throw new RepositoryPolicyError(
    "Local baseline tag creation is disabled; use signed non-force cloud Git publication.",
  );
}
