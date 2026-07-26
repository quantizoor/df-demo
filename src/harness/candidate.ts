import { resolve, sep } from "node:path";
import type {
  RemoteCommandSpec,
  SecretReference,
  TrustedCloudArtifactRef,
} from "../cloud/types.js";

export interface GitOperationSpec {
  readonly executable: "git";
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
}

export interface CandidateWorktreeSpec {
  readonly experimentId: string;
  readonly baseCommit: string;
  readonly branchName: string;
  readonly canonicalRepositoryPath: string;
  readonly worktreePath: string;
  readonly createOperation: GitOperationSpec;
}

export interface CandidateBuildSpec {
  readonly experimentId: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly lockSha256: string;
  readonly buildPolicyHash: string;
  readonly architecture: "x86_64";
  readonly sourceArtifact: TrustedCloudArtifactRef;
  readonly extractorArtifact: TrustedCloudArtifactRef;
  readonly packagerArtifact: TrustedCloudArtifactRef;
  readonly workingDirectory: string;
  readonly sourceRemotePath: string;
  readonly extractorRemotePath: string;
  readonly packagerRemotePath: string;
  readonly outputRemotePath: string;
  readonly validationLevel: "focused" | "release";
  readonly commands: readonly RemoteCommandSpec[];
}

export interface CandidateBuildOptions {
  readonly experimentId: string;
  readonly sourceArtifact: TrustedCloudArtifactRef;
  readonly extractorArtifact: TrustedCloudArtifactRef;
  readonly packagerArtifact: TrustedCloudArtifactRef;
  readonly cloudWorkingDirectory: string;
  readonly remoteInputRoot: string;
  readonly remoteOutputRoot: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly lockSha256: string;
  readonly buildPolicyHash: string;
  readonly architecture: "x86_64";
  readonly focusedTestFiles: readonly string[];
  readonly runFullTestSuite: boolean;
}

const EXPERIMENT_ID = /^[0-9]{3,8}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SAFE_TEST_PATH =
  /^(?:packages\/[A-Za-z0-9._-]+\/)?test\/[A-Za-z0-9._/-]+\.test\.ts$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_REMOTE_ROOT = /^\/(?:[A-Za-z0-9._-]+\/)+$/u;

export class CandidateSpecificationError extends Error {
  override readonly name = "CandidateSpecificationError";
}

function assertExperimentId(experimentId: string): void {
  if (!EXPERIMENT_ID.test(experimentId)) {
    throw new CandidateSpecificationError("Experiment identifier is invalid.");
  }
}

function assertCloudPath(path: string): void {
  if (
    !path.startsWith("/") ||
    resolve(path) === "/" ||
    path.includes("/../") ||
    path.includes("\u0000")
  ) {
    throw new CandidateSpecificationError("Cloud working directory is invalid.");
  }
}

function assertRemoteRoot(path: string, label: string): void {
  if (
    !SAFE_REMOTE_ROOT.test(path) ||
    path === "/" ||
    path.includes("/../") ||
    path.includes("\u0000")
  ) {
    throw new CandidateSpecificationError(`${label} is invalid.`);
  }
}

function assertTrustedArtifact(
  artifact: TrustedCloudArtifactRef,
  mediaTypes: ReadonlySet<string>,
  label: string,
): void {
  if (
    !/^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(
      artifact.uri,
    ) ||
    artifact.uri.includes("..") ||
    !SHA256.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength <= 0 ||
    !mediaTypes.has(artifact.mediaType)
  ) {
    throw new CandidateSpecificationError(`${label} must be a trusted cloud artifact.`);
  }
}

export function createCandidateWorktreeSpec(input: {
  readonly experimentId: string;
  readonly baseCommit: string;
  readonly canonicalRepositoryPath: string;
  readonly worktreeRoot: string;
}): CandidateWorktreeSpec {
  assertExperimentId(input.experimentId);
  if (!OBJECT_ID.test(input.baseCommit)) {
    throw new CandidateSpecificationError("Candidate base must be a full Git object identifier.");
  }
  if (!input.canonicalRepositoryPath.startsWith("/") || !input.worktreeRoot.startsWith("/")) {
    throw new CandidateSpecificationError("Repository and worktree roots must be absolute.");
  }
  if (resolve(input.canonicalRepositoryPath) === "/" || resolve(input.worktreeRoot) === "/") {
    throw new CandidateSpecificationError("Repository and worktree roots cannot be filesystem root.");
  }
  const worktreeRoot = resolve(input.worktreeRoot);
  const worktreePath = resolve(worktreeRoot, input.experimentId);
  if (!worktreePath.startsWith(`${worktreeRoot}${sep}`)) {
    throw new CandidateSpecificationError("Candidate worktree escapes its managed root.");
  }
  const branchName = `df/experiment/${input.experimentId}`;
  return {
    experimentId: input.experimentId,
    baseCommit: input.baseCommit,
    branchName,
    canonicalRepositoryPath: resolve(input.canonicalRepositoryPath),
    worktreePath,
    createOperation: {
      executable: "git",
      arguments: [
        "worktree",
        "add",
        "-b",
        branchName,
        worktreePath,
        input.baseCommit,
      ],
      workingDirectory: resolve(input.canonicalRepositoryPath),
    },
  };
}

function remoteCommand(
  executable: string,
  arguments_: readonly string[],
  workingDirectory: string,
  timeoutMs: number,
  secretReferences: readonly SecretReference[],
): RemoteCommandSpec {
  return {
    executable,
    arguments: arguments_,
    workingDirectory,
    timeoutMs,
    environment: {
      CI: "true",
      DF_CLOUD_EXECUTION: "1",
    },
    secretReferences,
  };
}

export function createCandidateBuildSpec(options: CandidateBuildOptions): CandidateBuildSpec {
  assertExperimentId(options.experimentId);
  assertCloudPath(options.cloudWorkingDirectory);
  assertRemoteRoot(options.remoteInputRoot, "Remote input root");
  assertRemoteRoot(options.remoteOutputRoot, "Remote output root");
  if (options.remoteInputRoot === options.remoteOutputRoot) {
    throw new CandidateSpecificationError("Input and output roots must be distinct.");
  }
  assertTrustedArtifact(
    options.sourceArtifact,
    new Set(["application/x-tar"]),
    "Candidate source",
  );
  assertTrustedArtifact(
    options.extractorArtifact,
    new Set(["text/javascript", "application/javascript"]),
    "Source extractor",
  );
  assertTrustedArtifact(
    options.packagerArtifact,
    new Set(["text/javascript", "application/javascript"]),
    "Runtime packager",
  );
  if (
    !OBJECT_ID.test(options.candidateCommit) ||
    !OBJECT_ID.test(options.candidateTree) ||
    !SHA256.test(options.lockSha256) ||
    !SHA256.test(options.buildPolicyHash) ||
    options.architecture !== "x86_64"
  ) {
    throw new CandidateSpecificationError(
      "Candidate build lineage or architecture is malformed.",
    );
  }
  for (const testFile of options.focusedTestFiles) {
    if (!SAFE_TEST_PATH.test(testFile) || testFile.includes("..")) {
      throw new CandidateSpecificationError(`Focused test path is invalid: ${testFile}`);
    }
  }

  const secretReferences: readonly SecretReference[] = [];
  const sourceRemotePath = `${options.remoteInputRoot}candidate-source.tar`;
  const extractorRemotePath = `${options.remoteInputRoot}extract-pi-source.mjs`;
  const packagerRemotePath = `${options.remoteInputRoot}package-pi-runtime.mjs`;
  const outputRemotePath =
    `${options.remoteOutputRoot}${options.experimentId}-pi-runtime.tar`;
  const parentWorkingDirectory = resolve(options.cloudWorkingDirectory, "..");
  const commands: RemoteCommandSpec[] = [
    remoteCommand(
      "/usr/bin/node",
      [
        extractorRemotePath,
        "--archive",
        sourceRemotePath,
        "--destination",
        options.cloudWorkingDirectory,
        "--sha256",
        options.sourceArtifact.sha256,
        "--commit",
        options.candidateCommit,
      ],
      parentWorkingDirectory,
      5 * 60_000,
      secretReferences,
    ),
    remoteCommand(
      "npm",
      [
        "ci",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      options.cloudWorkingDirectory,
      15 * 60_000,
      secretReferences,
    ),
    remoteCommand(
      "npx",
      ["--no-install", "biome", "ci", "."],
      options.cloudWorkingDirectory,
      15 * 60_000,
      secretReferences,
    ),
    ...[
      "check:pinned-deps",
      "check:ts-imports",
      "check:shrinkwrap",
      "check:install-lock:coding-agent",
      "check:browser-smoke",
    ].map((script) =>
      remoteCommand(
        "npm",
        ["run", script],
        options.cloudWorkingDirectory,
        10 * 60_000,
        secretReferences,
      ),
    ),
    remoteCommand(
      "npx",
      ["--no-install", "tsgo", "--noEmit"],
      options.cloudWorkingDirectory,
      15 * 60_000,
      secretReferences,
    ),
    ...options.focusedTestFiles.map((testFile) =>
      remoteCommand(
        "node",
        ["node_modules/vitest/dist/cli.js", "--run", testFile],
        options.cloudWorkingDirectory,
        10 * 60_000,
        secretReferences,
      ),
    ),
    ...(options.runFullTestSuite
      ? [
          remoteCommand(
            "npm",
            ["test"],
            options.cloudWorkingDirectory,
            45 * 60_000,
            secretReferences,
          ),
        ]
      : []),
    remoteCommand(
      "npm",
      [
        "run",
        "build:binary",
        "--workspace=@earendil-works/pi-coding-agent",
      ],
      options.cloudWorkingDirectory,
      30 * 60_000,
      secretReferences,
    ),
    remoteCommand(
      "/usr/bin/node",
      [
        packagerRemotePath,
        "--source-root",
        options.cloudWorkingDirectory,
        "--output",
        outputRemotePath,
        "--commit",
        options.candidateCommit,
        "--tree",
        options.candidateTree,
        "--lock",
        options.lockSha256,
        "--architecture",
        options.architecture,
        "--build-policy-hash",
        options.buildPolicyHash,
        "--validation-level",
        options.runFullTestSuite ? "release" : "focused",
      ],
      parentWorkingDirectory,
      10 * 60_000,
      secretReferences,
    ),
  ];
  return {
    experimentId: options.experimentId,
    candidateCommit: options.candidateCommit,
    candidateTree: options.candidateTree,
    lockSha256: options.lockSha256,
    buildPolicyHash: options.buildPolicyHash,
    architecture: options.architecture,
    sourceArtifact: options.sourceArtifact,
    extractorArtifact: options.extractorArtifact,
    packagerArtifact: options.packagerArtifact,
    workingDirectory: options.cloudWorkingDirectory,
    sourceRemotePath,
    extractorRemotePath,
    packagerRemotePath,
    outputRemotePath,
    validationLevel: options.runFullTestSuite ? "release" : "focused",
    commands,
  };
}
