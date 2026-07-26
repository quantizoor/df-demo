import {
  OFFICIAL_PI_UPSTREAM_URL,
  type RepositoryDoctorReport,
} from "../harness/repository.js";
import {
  TRUSTED_GIT_CREDENTIAL_TARGET,
  type PrivateGitHubOrigin,
} from "../harness/trusted-git.js";

const SAFE_GITHUB_OWNER =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const SAFE_GITHUB_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/u;
const SAFE_GIT_BRANCH = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,238}[A-Za-z0-9])?$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

export interface PiHarnessSourceConfiguration {
  readonly origin: PrivateGitHubOrigin;
  readonly expectedBranch: string;
  readonly expectedCommit: string;
  readonly expectedTree: string;
  readonly expectedLockSha256: string;
  readonly expectedPackageName: typeof PI_CODING_AGENT_PACKAGE;
  readonly expectedPackageVersion: string;
  readonly upstreamUrl: typeof OFFICIAL_PI_UPSTREAM_URL;
}

export interface PiHarnessSourceReadiness {
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
  readonly configuration: PiHarnessSourceConfiguration | null;
}

const REQUIRED = [
  "DF_PI_GITHUB_OWNER",
  "DF_PI_GITHUB_REPOSITORY",
  "DF_PI_BRANCH",
  "DF_PI_BASELINE_COMMIT",
  "DF_PI_BASELINE_TREE",
  "DF_PI_PACKAGE_LOCK_SHA256",
  "DF_PI_CODING_AGENT_VERSION",
  "DF_GITHUB_SECRET_SOURCE",
] as const;

function present(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | null {
  const value = environment[name]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

export function inspectPiHarnessSourceEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PiHarnessSourceReadiness {
  const missing = REQUIRED.filter((name) => present(environment, name) === null);
  const invalid: string[] = [];
  const owner = present(environment, "DF_PI_GITHUB_OWNER");
  const repository = present(environment, "DF_PI_GITHUB_REPOSITORY");
  const branch = present(environment, "DF_PI_BRANCH");
  const commit = present(environment, "DF_PI_BASELINE_COMMIT");
  const tree = present(environment, "DF_PI_BASELINE_TREE");
  const lock = present(environment, "DF_PI_PACKAGE_LOCK_SHA256");
  const packageVersion = present(environment, "DF_PI_CODING_AGENT_VERSION");
  const credentialSource = present(environment, "DF_GITHUB_SECRET_SOURCE");

  if (owner !== null && !SAFE_GITHUB_OWNER.test(owner)) {
    invalid.push("DF_PI_GITHUB_OWNER");
  }
  if (
    repository !== null &&
    (!SAFE_GITHUB_REPOSITORY.test(repository) ||
      repository.startsWith(".") ||
      repository.endsWith(".git"))
  ) {
    invalid.push("DF_PI_GITHUB_REPOSITORY");
  }
  if (
    branch !== null &&
    (!SAFE_GIT_BRANCH.test(branch) ||
      branch.includes("..") ||
      branch.includes("@{") ||
      branch.includes("//") ||
      branch.endsWith("/") ||
      branch.endsWith(".") ||
      branch.endsWith(".lock") ||
      branch
        .split("/")
        .some(
          (component) =>
            component.startsWith(".") ||
            component.endsWith(".") ||
            component.endsWith(".lock"),
        ))
  ) {
    invalid.push("DF_PI_BRANCH");
  }
  if (commit !== null && !GIT_OBJECT_ID.test(commit)) {
    invalid.push("DF_PI_BASELINE_COMMIT");
  }
  if (tree !== null && !GIT_OBJECT_ID.test(tree)) {
    invalid.push("DF_PI_BASELINE_TREE");
  }
  if (lock !== null && !SHA256.test(lock)) {
    invalid.push("DF_PI_PACKAGE_LOCK_SHA256");
  }
  if (packageVersion !== null && !EXACT_SEMVER.test(packageVersion)) {
    invalid.push("DF_PI_CODING_AGENT_VERSION");
  }
  if (
    credentialSource !== null &&
    !SAFE_ENVIRONMENT_NAME.test(credentialSource)
  ) {
    invalid.push("DF_GITHUB_SECRET_SOURCE");
  }

  const normalizedMissing = unique(missing);
  const normalizedInvalid = unique(invalid);
  if (
    normalizedMissing.length > 0 ||
    normalizedInvalid.length > 0 ||
    owner === null ||
    repository === null ||
    branch === null ||
    commit === null ||
    tree === null ||
    lock === null ||
    packageVersion === null ||
    credentialSource === null
  ) {
    return {
      ready: false,
      missing: normalizedMissing,
      invalid: normalizedInvalid,
      configuration: null,
    };
  }

  return {
    ready: true,
    missing: [],
    invalid: [],
    configuration: {
      origin: {
        host: "github.com",
        owner,
        repository,
        credential: {
          sourceEnvironmentName: credentialSource,
          targetEnvironmentName: TRUSTED_GIT_CREDENTIAL_TARGET,
        },
      },
      expectedBranch: branch,
      expectedCommit: commit,
      expectedTree: tree,
      expectedLockSha256: lock,
      expectedPackageName: PI_CODING_AGENT_PACKAGE,
      expectedPackageVersion: packageVersion,
      upstreamUrl: OFFICIAL_PI_UPSTREAM_URL,
    },
  };
}

/**
 * Confirms that the independently observed, read-only checkout identity is
 * exactly the identity the cloud campaign was authorized to snapshot.
 *
 * Remote privacy/writability and upstream lineage are intentionally not
 * accepted here: they must be established by the separate trusted cloud Git
 * verification receipt before baseline initialization.
 */
export function assertPiHarnessDoctorMatchesConfiguration(
  report: RepositoryDoctorReport,
  configuration: PiHarnessSourceConfiguration,
): void {
  if (
    report.branch !== configuration.expectedBranch ||
    report.trackingRef !== `origin/${configuration.expectedBranch}` ||
    report.headCommit !== configuration.expectedCommit ||
    report.treeSha !== configuration.expectedTree ||
    report.lockSha256 !== configuration.expectedLockSha256 ||
    report.clean !== true ||
    report.piMonorepo !== true ||
    report.remotes.length !== 1 ||
    report.remotes[0] !== "origin"
  ) {
    throw new Error(
      "The observed Pi checkout does not match the authorized cloud source identity.",
    );
  }
}
