import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

import type { TrustedCloudArtifactRef } from "../cloud/types.js";
import { assertMvpCandidateChangedFiles } from "./optimizer-worker.js";
import {
  type MvpEvaluatorRuntimeDependencies,
  type MvpEvaluatorRuntimePin,
  type MvpHarborExecutionPort,
  type MvpPiRuntimeMaterialization,
  type MvpPiRuntimeSourcePort,
} from "./evaluator-runtime.js";
import {
  MVP_HARBOR_VERSION,
  type TrustedMvpHarborExecutionPlan,
  type TrustedMvpHarborRequestedInvocation,
  type TrustedMvpHarborRequestedRawOutput,
  type TrustedMvpHarborRequestedRawTrial,
} from "./harbor.js";
import { readOptionalBoundedJson, writeJsonAtomic } from "./mounted-files.js";
import {
  canonicalJson,
  MVP_SCHEMA_VERSION,
  type PrivateRawDiagnostic,
} from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const SAFE_GITHUB_NAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;
const MAXIMUM_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAXIMUM_JSON_BYTES = 32 * 1024 * 1024;
const MAXIMUM_RUNTIME_BYTES = 2 * 1024 * 1024 * 1024;
const MVP_PI_RUNTIME_PACKAGER =
  "/tmp/df-mvp-controller/scripts/package-pi-runtime.mjs";
const MVP_PI_BUN_TARGET = "bun-linux-x64-baseline";
const MVP_PI_RUNTIME_ABI = "linux-x64-glibc";
const MVP_PI_BUILD_POLICY_SHA256 = createHash("sha256")
  .update(
    [
      "dark-factory.mvp-pi-build-policy.v1",
      "npm-ci:ignore-scripts,no-audit,no-fund",
      "biome:check,error-on-warnings",
      "tsgo:noEmit",
      "npm:test",
      "npm:build:offline",
      `bun:build,compile,target=${MVP_PI_BUN_TARGET}`,
      "npm:copy-binary-assets",
      `runtime:${MVP_PI_RUNTIME_ABI}`,
    ].join("\n"),
  )
  .digest("hex");

export function mvpPiBuildRuntimeDigest(input: {
  readonly architecture: "x86_64";
  readonly bunExecutableSha256: string;
  readonly imageDigest: string;
  readonly packagerByteLength: number;
  readonly packagerSha256: string;
}): string {
  if (
    !SHA256.test(input.bunExecutableSha256) ||
    !SHA256.test(input.imageDigest) ||
    !SHA256.test(input.packagerSha256) ||
    !Number.isSafeInteger(input.packagerByteLength) ||
    input.packagerByteLength < 1
  ) {
    throw new Error("Pi build-runtime identity is invalid.");
  }
  return createHash("sha256")
    .update(
      canonicalJson({
        domain: "dark-factory.mvp-pi-build-runtime.v1",
        architecture: input.architecture,
        buildPolicySha256: MVP_PI_BUILD_POLICY_SHA256,
        bunExecutableSha256: input.bunExecutableSha256,
        bunTarget: MVP_PI_BUN_TARGET,
        imageDigest: input.imageDigest,
        packagerByteLength: input.packagerByteLength,
        packagerSha256: input.packagerSha256,
        runtimeAbi: MVP_PI_RUNTIME_ABI,
      }),
    )
    .digest("hex");
}

export interface MvpEvaluatorProcessRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly uid?: number;
  readonly gid?: number;
}

export interface MvpEvaluatorProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface MvpEvaluatorProcessPort {
  run(
    request: MvpEvaluatorProcessRequest,
  ): Promise<MvpEvaluatorProcessResult>;
}

export interface MvpEvaluatorFileSystemPort {
  makeDirectory(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  readJson(path: string): Promise<unknown>;
  writeJson(path: string, value: unknown): Promise<void>;
  hashFile(path: string): Promise<{
    readonly sha256: string;
    readonly byteLength: number;
  }>;
  secureImportFile(
    source: string,
    destination: string,
    expectedOwnerUid: number,
    maximumBytes: number,
  ): Promise<{
    readonly sha256: string;
    readonly byteLength: number;
  }>;
  listDirectories(path: string): Promise<readonly string[]>;
  makeExecutable(path: string): Promise<void>;
}

export interface CreateNodeMvpEvaluatorDependenciesInput {
  readonly stateRoot: string;
  readonly pin: MvpEvaluatorRuntimePin;
  readonly repository: {
    readonly owner: string;
    readonly name: string;
    readonly baselineCommit: string;
    readonly baselineTree: string;
    readonly packageLockSha256: string;
  };
  /**
   * Opaque Daytona placeholder. It is passed unmodified as the value of a
   * Git HTTPS Authorization header. It is never decoded or copied into Pi.
   */
  readonly githubBasicAuthPlaceholder: string;
  readonly daytona: {
    readonly apiKeyPlaceholder: string;
    readonly apiUrl: string;
    readonly target: string;
  };
  readonly adapterPath: string;
  readonly expectedCandidate: {
    readonly revision: string;
    readonly changedFiles: readonly string[];
  } | null;
  readonly process?: MvpEvaluatorProcessPort;
  readonly files?: MvpEvaluatorFileSystemPort;
}

export async function createNodeMvpEvaluatorDependencies(
  input: CreateNodeMvpEvaluatorDependenciesInput,
): Promise<MvpEvaluatorRuntimeDependencies> {
  assertLinuxDaytona();
  assertNodeOptions(input);
  await assertEvaluatorPrivateRoot(input.stateRoot);
  const processPort = input.process ?? new NodeMvpEvaluatorProcess();
  const files = input.files ?? new NodeMvpEvaluatorFileSystem();
  await verifyPinnedFile(
    files,
    input.pin.harborExecutable,
    input.pin.harborExecutableSha256,
  );
  await verifyPinnedFile(
    files,
    input.pin.bunExecutable,
    input.pin.bunExecutableSha256,
  );
  await verifyPinnedFile(
    files,
    input.adapterPath,
    input.pin.adapterSha256,
  );
  const packager = await files.hashFile(MVP_PI_RUNTIME_PACKAGER);
  const buildRuntimeDigest = mvpPiBuildRuntimeDigest({
    architecture: input.pin.architecture,
    bunExecutableSha256: input.pin.bunExecutableSha256,
    imageDigest: input.pin.imageDigest,
    packagerByteLength: packager.byteLength,
    packagerSha256: packager.sha256,
  });
  return {
    source: new NodeMvpPiRuntimeSource({
      stateRoot: input.stateRoot,
      repository: input.repository,
      githubBasicAuthPlaceholder:
        input.githubBasicAuthPlaceholder,
      bunExecutable: input.pin.bunExecutable,
      buildRuntimeDigest,
      expectedCandidate: input.expectedCandidate,
      process: processPort,
      files,
    }),
    harbor: new NodeMvpHarborExecution({
      stateRoot: input.stateRoot,
      harborExecutable: input.pin.harborExecutable,
      adapterPath: input.adapterPath,
      daytona: input.daytona,
      process: processPort,
      files,
    }),
  };
}

export class NodeMvpPiRuntimeSource
  implements MvpPiRuntimeSourcePort
{
  public constructor(
    private readonly options: {
      readonly stateRoot: string;
      readonly repository: CreateNodeMvpEvaluatorDependenciesInput["repository"];
      readonly githubBasicAuthPlaceholder: string;
      readonly bunExecutable: string;
      readonly buildRuntimeDigest: string;
      readonly expectedCandidate:
        CreateNodeMvpEvaluatorDependenciesInput["expectedCandidate"];
      readonly process: MvpEvaluatorProcessPort;
      readonly files: MvpEvaluatorFileSystemPort;
    },
  ) {}

  public async materialize(input: {
    readonly arm: "candidate" | "champion";
    readonly revision: string;
    readonly championRevision: string;
    readonly expectedChangedFiles: readonly string[] | null;
  }): Promise<MvpPiRuntimeMaterialization> {
    if (
      !REVISION.test(input.revision) ||
      !REVISION.test(input.championRevision)
    ) {
      throw new Error("Pi runtime revision is not a Git object ID.");
    }
    if (
      input.arm === "candidate" &&
      (this.options.expectedCandidate === null ||
        this.options.expectedCandidate.revision !== input.revision ||
        input.expectedChangedFiles === null ||
        !sameStringSet(
          this.options.expectedCandidate.changedFiles,
          input.expectedChangedFiles,
        ))
    ) {
      throw new Error("Candidate source is not bound to its proposal.");
    }
    if (
      input.arm === "champion" &&
      input.expectedChangedFiles !== null
    ) {
      throw new Error("Champion source cannot carry a candidate diff.");
    }
    const runtimeRoot = join(
      this.options.stateRoot,
      "private",
      "runtimes",
    );
    const archivePath = join(
      runtimeRoot,
      `${input.arm}-${input.revision}-${this.options.buildRuntimeDigest}.tar`,
    );
    const manifestPath = `${archivePath}.json`;
    const cached = await readOptionalBoundedJson(manifestPath);
    if (cached !== null) {
      const parsed = parseRuntimeManifest(
        cached,
        input,
        archivePath,
        this.options.buildRuntimeDigest,
      );
      const actual = await this.options.files.hashFile(archivePath);
      if (
        actual.sha256 !== parsed.archiveSha256 ||
        actual.byteLength !== parsed.archiveByteLength
      ) {
        throw new Error("Cached Pi runtime artifact changed.");
      }
      return runtimeMaterialization(parsed, input, archivePath);
    }

    await this.options.files.makeDirectory(runtimeRoot);
    const temporaryRoot = join(
      "/tmp",
      `df-mvp-pi-${input.arm}-${randomUUID()}`,
    );
    const sourceRoot = join(temporaryRoot, "source");
    const tarPath = join(temporaryRoot, "runtime.tar");
    const buildUid = input.arm === "candidate" ? 65_532 : 65_533;
    const buildGid = buildUid;
    const buildHome = join(temporaryRoot, "home");
    await this.options.files.makeDirectory(sourceRoot);
    await this.options.files.makeDirectory(buildHome);
    try {
      await this.#git(["init", "--quiet", sourceRoot], "/tmp");
      await this.#git(
        [
          "-C",
          sourceRoot,
          "remote",
          "add",
          "origin",
          `https://github.com/${this.options.repository.owner}/${this.options.repository.name}.git`,
        ],
        "/tmp",
      );
      await this.#git(
        [
          "-C",
          sourceRoot,
          "fetch",
          "--quiet",
          "--no-tags",
          "--depth=128",
          "origin",
          input.revision,
          input.championRevision,
        ],
        "/tmp",
      );
      await this.#git(
        ["-C", sourceRoot, "checkout", "--quiet", "--detach", input.revision],
        "/tmp",
      );
      const commit = await this.#gitOutput(
        ["-C", sourceRoot, "rev-parse", "HEAD"],
        "/tmp",
      );
      const treeSha = await this.#gitOutput(
        ["-C", sourceRoot, "rev-parse", "HEAD^{tree}"],
        "/tmp",
      );
      if (commit !== input.revision || !REVISION.test(treeSha)) {
        throw new Error("Fetched Pi source does not match its exact revision.");
      }
      if (
        input.revision === this.options.repository.baselineCommit &&
        treeSha !== this.options.repository.baselineTree
      ) {
        throw new Error("Baseline Pi tree changed.");
      }
      if (input.arm === "candidate") {
        if (
          this.options.expectedCandidate === null ||
          this.options.expectedCandidate.revision !== input.revision
        ) {
          throw new Error(
            "Candidate source is not bound to its proposal.",
          );
        }
        const ancestry = (
          await this.#gitOutput(
            [
              "-C",
              sourceRoot,
              "rev-list",
              "--parents",
              "-n",
              "1",
              input.revision,
            ],
            "/tmp",
          )
        ).split(/\s+/u);
        if (
          ancestry.length !== 2 ||
          ancestry[0] !== input.revision ||
          ancestry[1] !== input.championRevision
        ) {
          throw new Error(
            "Candidate must be an exact single-parent child of champion.",
          );
        }
        await this.#git(
          [
            "-C",
            sourceRoot,
            "merge-base",
            "--is-ancestor",
            input.championRevision,
            input.revision,
          ],
          "/tmp",
        );
        const statusLines = (
          await this.#gitOutput(
            [
              "-C",
              sourceRoot,
              "diff",
              "--no-renames",
              "--name-status",
              input.championRevision,
              input.revision,
            ],
            "/tmp",
          )
        )
          .split("\n")
          .filter((line) => line.length > 0);
        if (
          statusLines.some(
            (line) => !/^(?:A|M)\t[^\t]+$/u.test(line),
          )
        ) {
          throw new Error(
            "Candidate diff contains a deletion, rename, or unsupported entry.",
          );
        }
        const changed = statusLines.map(
          (line) => line.split("\t", 2)[1]!,
        );
        assertMvpCandidateChangedFiles(changed);
        if (
          JSON.stringify([...changed].sort()) !==
            JSON.stringify(
              [...this.options.expectedCandidate.changedFiles].sort(),
            ) ||
          JSON.stringify([...changed].sort()) !==
            JSON.stringify(
              [...(input.expectedChangedFiles ?? [])].sort(),
            )
        ) {
          throw new Error(
            "Candidate Git diff disagrees with its proposal.",
          );
        }
        for (const path of changed) {
          const treeEntry = await this.#gitOutput(
            [
              "-C",
              sourceRoot,
              "ls-tree",
              input.revision,
              "--",
              path,
            ],
            "/tmp",
          );
          if (!/^(?:100644|100755) blob [a-f0-9]{40}\t/u.test(treeEntry)) {
            throw new Error(
              "Candidate diff contains a link, submodule, or special mode.",
            );
          }
        }
        const renamedOrModeChanged = await this.#gitOutput(
          [
            "-C",
            sourceRoot,
            "diff",
            "--summary",
            input.championRevision,
            input.revision,
          ],
          "/tmp",
        );
        if (
          renamedOrModeChanged
            .split("\n")
            .filter((line) => line.length > 0)
            .some(
              (line) =>
                !/^ create mode (?:100644|100755) [^\t]+$/u.test(
                  line,
                ),
            )
        ) {
          throw new Error(
            "Candidate diff changes a file mode or identity.",
          );
        }
      }
      const lock = await this.options.files.hashFile(
        join(sourceRoot, "package-lock.json"),
      );
      if (
        lock.sha256 !==
        this.options.repository.packageLockSha256
      ) {
        throw new Error("Pi dependency lock changed.");
      }

      await this.#run(
        "/usr/bin/chown",
        ["-R", `${buildUid}:${buildGid}`, temporaryRoot],
        "/tmp",
        safeBuildEnvironment("/tmp/df-mvp-root-home"),
        5 * 60_000,
      );
      const buildEnvironment = safeBuildEnvironment(buildHome);
      await this.#run(
        "/usr/bin/npm",
        ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        sourceRoot,
        buildEnvironment,
        30 * 60_000,
        buildUid,
        buildGid,
      );
      await this.#run(
        join(sourceRoot, "node_modules", ".bin", "biome"),
        ["check", "--error-on-warnings", "."],
        sourceRoot,
        buildEnvironment,
        15 * 60_000,
        buildUid,
        buildGid,
      );
      await this.#run(
        join(sourceRoot, "node_modules", ".bin", "tsgo"),
        ["--noEmit"],
        sourceRoot,
        buildEnvironment,
        15 * 60_000,
        buildUid,
        buildGid,
      );
      await this.#run(
        "/usr/bin/npm",
        ["test"],
        sourceRoot,
        buildEnvironment,
        60 * 60_000,
        buildUid,
        buildGid,
      );
      await this.#run(
        "/usr/bin/npm",
        ["run", "build:offline"],
        sourceRoot,
        buildEnvironment,
        30 * 60_000,
        buildUid,
        buildGid,
      );
      await this.#run(
        this.options.bunExecutable,
        [
          "build",
          "--compile",
          `--target=${MVP_PI_BUN_TARGET}`,
          "./dist/bun/cli.js",
          "./src/utils/image-resize-worker.ts",
          "--outfile",
          "dist/pi",
        ],
        join(sourceRoot, "packages", "coding-agent"),
        buildEnvironment,
        15 * 60_000,
        buildUid,
        buildGid,
      );
      await this.#run(
        "/usr/bin/npm",
        ["run", "copy-binary-assets"],
        join(sourceRoot, "packages", "coding-agent"),
        buildEnvironment,
        15 * 60_000,
        buildUid,
        buildGid,
      );
      await this.#run(
        "/usr/bin/env",
        [
          "node",
          MVP_PI_RUNTIME_PACKAGER,
          "--source-root",
          sourceRoot,
          "--output",
          tarPath,
          "--commit",
          input.revision,
          "--tree",
          treeSha,
          "--lock",
          lock.sha256,
          "--architecture",
          "x86_64",
          "--build-policy-hash",
          MVP_PI_BUILD_POLICY_SHA256,
          "--validation-level",
          "release",
        ],
        temporaryRoot,
        {
          ...safeBuildEnvironment(buildHome),
          DF_CLOUD_EXECUTION: "1",
          DAYTONA_SANDBOX_ID:
            process.env["DAYTONA_SANDBOX_ID"]!,
        },
        15 * 60_000,
        buildUid,
        buildGid,
      );
      await this.#terminateBuildProcesses(buildUid);
      const artifact = await this.options.files.secureImportFile(
        tarPath,
        archivePath,
        buildUid,
        MAXIMUM_RUNTIME_BYTES,
      );
      const manifest: MvpPiRuntimeManifest = {
        schemaVersion: 2,
        domain: "dark-factory.mvp-pi-runtime.v2",
        arm: input.arm,
        revision: input.revision,
        championRevision: input.championRevision,
        treeSha,
        lockSha256: lock.sha256,
        archiveSha256: artifact.sha256,
        archiveByteLength: artifact.byteLength,
        changedFiles:
          input.expectedChangedFiles === null
            ? []
            : [...input.expectedChangedFiles].sort(),
        buildRuntimeDigest: this.options.buildRuntimeDigest,
      };
      await writeJsonAtomic(manifestPath, manifest);
      return runtimeMaterialization(manifest, input, archivePath);
    } finally {
      try {
        await this.#terminateBuildProcesses(buildUid);
      } finally {
        await this.options.files.removeDirectory(temporaryRoot);
      }
    }
  }

  async #terminateBuildProcesses(uid: number): Promise<void> {
    const environment = safeBuildEnvironment(
      "/tmp/df-mvp-root-home",
    );
    const killed = await this.options.process.run({
      executable: "/usr/bin/pkill",
      arguments: ["-KILL", "-u", String(uid)],
      cwd: "/tmp",
      environment,
      timeoutMs: 60_000,
    });
    if (killed.exitCode !== 0 && killed.exitCode !== 1) {
      throw new Error("Unable to terminate the untrusted build UID.");
    }
    const remaining = await this.options.process.run({
      executable: "/usr/bin/pgrep",
      arguments: ["-u", String(uid)],
      cwd: "/tmp",
      environment,
      timeoutMs: 60_000,
    });
    if (remaining.exitCode !== 1) {
      throw new Error("The untrusted build UID is still active.");
    }
  }

  async #git(
    arguments_: readonly string[],
    cwd: string,
  ): Promise<void> {
    await this.#run(
      "/usr/bin/git",
      arguments_,
      cwd,
      {
        ...safeBuildEnvironment("/tmp/df-mvp-git-home"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0:
          "http.https://github.com/.extraHeader",
        GIT_CONFIG_VALUE_0:
          `Authorization: Basic ${this.options.githubBasicAuthPlaceholder}`,
        GIT_TERMINAL_PROMPT: "0",
      },
      15 * 60_000,
    );
  }

  async #gitOutput(
    arguments_: readonly string[],
    cwd: string,
  ): Promise<string> {
    const result = await this.#run(
      "/usr/bin/git",
      arguments_,
      cwd,
      {
        ...safeBuildEnvironment("/tmp/df-mvp-git-home"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0:
          "http.https://github.com/.extraHeader",
        GIT_CONFIG_VALUE_0:
          `Authorization: Basic ${this.options.githubBasicAuthPlaceholder}`,
        GIT_TERMINAL_PROMPT: "0",
      },
      15 * 60_000,
    );
    return result.stdout.trim();
  }

  async #run(
    executable: string,
    arguments_: readonly string[],
    cwd: string,
    environment: Readonly<Record<string, string>>,
    timeoutMs: number,
    uid?: number,
    gid?: number,
  ): Promise<MvpEvaluatorProcessResult> {
    const result = await this.options.process.run({
      executable,
      arguments: arguments_,
      cwd,
      environment,
      timeoutMs,
      ...(uid === undefined ? {} : { uid }),
      ...(gid === undefined ? {} : { gid }),
    });
    if (result.exitCode !== 0) {
      throw new Error("A sealed Pi source/build step failed.");
    }
    return result;
  }
}

export class NodeMvpHarborExecution
  implements MvpHarborExecutionPort
{
  public constructor(
    private readonly options: {
      readonly stateRoot: string;
      readonly harborExecutable: string;
      readonly adapterPath: string;
      readonly daytona: CreateNodeMvpEvaluatorDependenciesInput["daytona"];
      readonly process: MvpEvaluatorProcessPort;
      readonly files: MvpEvaluatorFileSystemPort;
    },
  ) {}

  public async execute(
    plan: TrustedMvpHarborExecutionPlan,
  ): Promise<TrustedMvpHarborRequestedRawOutput> {
    const trials: TrustedMvpHarborRequestedRawTrial[] = [];
    for (const invocation of plan.invocations) {
      const invocationRoot = join(
        this.options.stateRoot,
        "private",
        "harbor-invocations",
        invocation.invocationId,
      );
      const configPath = join(invocationRoot, "config.json");
      await this.options.files.makeDirectory(invocationRoot);
      await this.options.files.writeJson(configPath, invocation.config);
      const result = await this.options.process.run({
        executable: this.options.harborExecutable,
        arguments: ["run", "-c", configPath],
        cwd: invocationRoot,
        environment: {
          CI: "true",
          DF_CLOUD_EXECUTION: "1",
          NO_COLOR: "1",
          PYTHONPATH: dirname(this.options.adapterPath),
          DAYTONA_API_KEY:
            this.options.daytona.apiKeyPlaceholder,
          DAYTONA_API_URL: this.options.daytona.apiUrl,
          DAYTONA_TARGET: this.options.daytona.target,
        },
        timeoutMs:
          plan.basePlan.timeoutSeconds * 1_000 *
            invocation.expectedTrialCount +
          15 * 60_000,
      });
      if (result.exitCode !== 0) {
        throw new Error("Harbor 0.20.0 invocation failed.");
      }
      trials.push(
        ...(await this.#parseInvocation(plan, invocation)),
      );
    }
    return {
      sensitivity: "trusted-mvp-harbor-requested-output",
      schemaVersion: MVP_SCHEMA_VERSION,
      harborVersion: MVP_HARBOR_VERSION,
      experimentId: plan.basePlan.experimentId,
      executionPlanHash: plan.executionPlanHash,
      trials,
    };
  }

  async #parseInvocation(
    plan: TrustedMvpHarborExecutionPlan,
    invocation: TrustedMvpHarborRequestedInvocation,
  ): Promise<readonly TrustedMvpHarborRequestedRawTrial[]> {
    const jobRoot = join(
      plan.basePlan.jobsDirectory,
      invocation.invocationId,
    );
    // Both job and per-trial results are retained only below evaluator-private
    // state. Parsing result.json also proves the expected completed count.
    const job = plainRecord(
      await this.options.files.readJson(join(jobRoot, "result.json")),
    );
    if (job["n_total_trials"] !== invocation.expectedTrialCount) {
      throw new Error("Harbor job result has the wrong trial count.");
    }
    const directories = await this.options.files.listDirectories(
      jobRoot,
    );
    const parsed: ParsedTrial[] = [];
    for (const directory of directories) {
      const resultPath = join(jobRoot, directory, "result.json");
      const trajectoryPath = join(
        jobRoot,
        directory,
        "agent",
        "trajectory.json",
      );
      let result: Readonly<Record<string, unknown>>;
      let trajectory: unknown;
      try {
        result = plainRecord(
          await this.options.files.readJson(resultPath),
        );
        trajectory = await this.options.files.readJson(
          trajectoryPath,
        );
      } catch {
        continue;
      }
      const trajectoryArtifact =
        await this.options.files.hashFile(trajectoryPath);
      parsed.push(
        parseHarborTrial(
          directory,
          result,
          trajectory,
          trajectoryArtifact.sha256,
        ),
      );
    }
    if (parsed.length !== invocation.expectedTrialCount) {
      throw new Error("Harbor output has missing or extra trials.");
    }

    const grouped = new Map<string, ParsedTrial[]>();
    for (const trial of parsed) {
      const key = `${trial.harborTaskName}\0${trial.agentName}`;
      const group = grouped.get(key) ?? [];
      group.push(trial);
      grouped.set(key, group);
    }
    const output: TrustedMvpHarborRequestedRawTrial[] = [];
    for (const group of grouped.values()) {
      group.sort((left, right) =>
        left.directory.localeCompare(right.directory),
      );
      for (const [index, trial] of group.entries()) {
        const attemptOrdinal = (index + 1) as 1 | 2 | 3;
        const expected = invocation.expectedTrials.find(
          (entry) =>
            entry.harborTaskName === trial.harborTaskName &&
            agentName(entry.arm) === trial.agentName &&
            entry.harborAttemptOrdinal === attemptOrdinal,
        );
        if (expected === undefined) {
          throw new Error(
            "Harbor trial cannot be mapped to a sealed repeat.",
          );
        }
        const runtime =
          expected.arm === "candidate"
            ? plan.basePlan.candidateRuntime
            : plan.basePlan.championRuntime;
        output.push({
          invocationId: invocation.invocationId,
          trialId: trial.trialId,
          harborTaskName: trial.harborTaskName,
          agentName: trial.agentName,
          attemptOrdinal,
          runtimeArchiveSha256: runtime.artifact.sha256,
          adapterSha256: plan.basePlan.adapter.artifact.sha256,
          modelProvider: "microsoft-foundry",
          modelDeployment: plan.basePlan.model.deployment,
          endpointHost: plan.basePlan.model.endpointHost,
          passed: trial.reward === 1,
          reward: trial.reward,
          infrastructureValid: trial.infrastructureValid,
          durationMs: trial.durationMs,
          evaluatedAt: trial.evaluatedAt,
          traceArtifactRefs: [
            `trusted://mvp-private/traces/${trial.trajectorySha256}`,
          ],
          rawDiagnostics: trial.rawDiagnostics,
        });
      }
    }
    return output;
  }
}

interface ParsedTrial {
  readonly directory: string;
  readonly trialId: string;
  readonly harborTaskName: string;
  readonly agentName:
    | "dark-factory-candidate"
    | "dark-factory-champion";
  readonly reward: number;
  readonly infrastructureValid: boolean;
  readonly durationMs: number;
  readonly evaluatedAt: string;
  readonly trajectorySha256: string;
  readonly rawDiagnostics: readonly PrivateRawDiagnostic[];
}

function parseHarborTrial(
  directory: string,
  value: Readonly<Record<string, unknown>>,
  trajectory: unknown,
  trajectorySha256: string,
): ParsedTrial {
  const config = plainRecord(value["config"]);
  const agent = plainRecord(config["agent"]);
  const verifier = plainRecord(value["verifier_result"]);
  const rewards = plainRecord(verifier["rewards"]);
  const execution = plainRecord(value["agent_execution"]);
  const taskName = value["task_name"];
  const trialId = value["id"];
  const agentValue = agent["name"];
  const reward = rewards["reward"];
  const started = canonicalTimestamp(execution["started_at"]);
  const finished = canonicalTimestamp(execution["finished_at"]);
  if (
    value["verifier_environment_mode"] !== "separate" ||
    value["exception_info"] !== null ||
    typeof taskName !== "string" ||
    typeof trialId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(trialId) ||
    (agentValue !== "dark-factory-candidate" &&
      agentValue !== "dark-factory-champion") ||
    typeof reward !== "number" ||
    !Number.isFinite(reward) ||
    reward < 0 ||
    reward > 1 ||
    !SHA256.test(trajectorySha256) ||
    Date.parse(finished) < Date.parse(started)
  ) {
    throw new Error("Harbor trial result is malformed.");
  }
  const diagnostics = trajectoryDiagnostics(
    trajectory,
    trajectorySha256,
  );
  if (reward < 1) {
    diagnostics.push({
      kind: "grader",
      code: "bounded-reward-below-one",
      toolName: null,
      message: "The verifier returned a bounded reward below one.",
      evidenceRefs: [
        `trusted://mvp-private/traces/${trajectorySha256}`,
      ],
    });
  }
  return {
    directory,
    trialId,
    harborTaskName: taskName,
    agentName: agentValue,
    reward,
    infrastructureValid: true,
    durationMs: Date.parse(finished) - Date.parse(started),
    evaluatedAt: new Date(Date.parse(finished)).toISOString(),
    trajectorySha256,
    rawDiagnostics: diagnostics.slice(0, 128),
  };
}

function trajectoryDiagnostics(
  value: unknown,
  trajectorySha256: string,
): PrivateRawDiagnostic[] {
  const trajectory = plainRecord(value);
  if (
    trajectory["schema_version"] !== "ATIF-v1.7" ||
    !Array.isArray(trajectory["steps"]) ||
    trajectory["steps"].length < 2 ||
    trajectory["steps"].length > 100_000
  ) {
    throw new Error("Pi trajectory is not bounded ATIF v1.7.");
  }
  const toolNames = new Map<string, string>();
  const diagnostics: PrivateRawDiagnostic[] = [];
  for (const rawStep of trajectory["steps"]) {
    const step = plainRecord(rawStep);
    if (Array.isArray(step["tool_calls"])) {
      for (const rawCall of step["tool_calls"]) {
        const call = plainRecord(rawCall);
        if (
          typeof call["tool_call_id"] === "string" &&
          typeof call["function_name"] === "string"
        ) {
          toolNames.set(
            call["tool_call_id"],
            call["function_name"].slice(0, 256),
          );
        }
      }
    }
    if (step["observation"] !== undefined) {
      const observation = plainRecord(step["observation"]);
      if (!Array.isArray(observation["results"])) {
        throw new Error("ATIF observation results are malformed.");
      }
      for (const rawResult of observation["results"]) {
        const result = plainRecord(rawResult);
        const extra = plainRecord(result["extra"]);
        if (extra["is_error"] === true) {
          const id = result["source_call_id"];
          diagnostics.push({
            kind: "tool",
            code: "tool-result-error",
            toolName:
              typeof id === "string"
                ? (toolNames.get(id) ?? null)
                : null,
            message:
              typeof result["content"] === "string"
                ? result["content"].slice(0, 16_384)
                : "A tool call returned an error.",
            evidenceRefs: [
              `trusted://mvp-private/traces/${trajectorySha256}`,
            ],
          });
        }
      }
    }
  }
  return diagnostics;
}

interface MvpPiRuntimeManifest {
  readonly schemaVersion: 2;
  readonly domain: "dark-factory.mvp-pi-runtime.v2";
  readonly arm: "candidate" | "champion";
  readonly revision: string;
  readonly championRevision: string;
  readonly treeSha: string;
  readonly lockSha256: string;
  readonly archiveSha256: string;
  readonly archiveByteLength: number;
  readonly changedFiles: readonly string[];
  readonly buildRuntimeDigest: string;
}

function parseRuntimeManifest(
  value: unknown,
  input: {
    readonly arm: "candidate" | "champion";
    readonly revision: string;
    readonly championRevision: string;
    readonly expectedChangedFiles: readonly string[] | null;
  },
  archivePath: string,
  expectedBuildRuntimeDigest: string,
): MvpPiRuntimeManifest {
  const manifest = plainRecord(value);
  const changedFiles = manifest["changedFiles"];
  if (
    Object.keys(manifest).length !== 11 ||
    manifest["schemaVersion"] !== 2 ||
    manifest["domain"] !== "dark-factory.mvp-pi-runtime.v2" ||
    manifest["arm"] !== input.arm ||
    manifest["revision"] !== input.revision ||
    manifest["championRevision"] !== input.championRevision ||
    !REVISION.test(String(manifest["treeSha"])) ||
    !SHA256.test(String(manifest["lockSha256"])) ||
    !SHA256.test(String(manifest["archiveSha256"])) ||
    manifest["buildRuntimeDigest"] !== expectedBuildRuntimeDigest ||
    !Number.isSafeInteger(manifest["archiveByteLength"]) ||
    (manifest["archiveByteLength"] as number) < 1 ||
    !Array.isArray(changedFiles) ||
    changedFiles.some((path) => typeof path !== "string") ||
    !sameStringSet(
      changedFiles as readonly string[],
      input.expectedChangedFiles ?? [],
    ) ||
    !archivePath.startsWith("/")
  ) {
    throw new Error("Pi runtime manifest is invalid.");
  }
  return manifest as unknown as MvpPiRuntimeManifest;
}

function runtimeMaterialization(
  manifest: MvpPiRuntimeManifest,
  input: { readonly arm: "candidate" | "champion" },
  archivePath: string,
): MvpPiRuntimeMaterialization {
  const artifact: TrustedCloudArtifactRef = {
    uri: `trusted://mvp-private/runtimes/${manifest.arm}-${manifest.archiveSha256}`,
    sha256: manifest.archiveSha256,
    mediaType: "application/x-tar",
    byteLength: manifest.archiveByteLength,
  };
  return {
    arm: input.arm,
    revision: manifest.revision,
    treeSha: manifest.treeSha,
    lockSha256: manifest.lockSha256,
    archive: {
      arm: input.arm,
      harnessRevision: manifest.revision,
      artifact,
      remotePath: archivePath,
    },
  };
}

export class NodeMvpEvaluatorProcess
  implements MvpEvaluatorProcessPort
{
  public async run(
    request: MvpEvaluatorProcessRequest,
  ): Promise<MvpEvaluatorProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        request.executable,
        [...request.arguments],
        {
          cwd: request.cwd,
          env: { ...request.environment },
          ...(request.uid === undefined
            ? {}
            : { uid: request.uid }),
          ...(request.gid === undefined
            ? {}
            : { gid: request.gid }),
          detached: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      const killProcessGroup = (): void => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      };
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          killProcessGroup();
          reject(error);
        }
      };
      const timer = setTimeout(() => {
        fail(new Error("A sealed subprocess exceeded its timeout."));
      }, request.timeoutMs);
      const append = (
        current: string,
        chunk: Buffer,
      ): string => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAXIMUM_COMMAND_OUTPUT_BYTES) {
          fail(new Error("A sealed subprocess exceeded its output bound."));
          return current;
        }
        return current + chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.once("error", (error) => {
        fail(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          if (
            code === null ||
            outputBytes > MAXIMUM_COMMAND_OUTPUT_BYTES
          ) {
            reject(new Error("A sealed subprocess did not complete."));
          } else {
            resolve({
              exitCode: code,
              stdout,
              stderr,
            });
          }
        }
      });
    });
  }
}

export class NodeMvpEvaluatorFileSystem
  implements MvpEvaluatorFileSystemPort
{
  public async makeDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }

  public async removeDirectory(path: string): Promise<void> {
    if (!path.startsWith("/tmp/df-mvp-pi-")) {
      throw new Error("Refusing to remove a non-temporary path.");
    }
    await rm(path, { recursive: true, force: true });
  }

  public async readJson(path: string): Promise<unknown> {
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size < 2 ||
        info.size > MAXIMUM_JSON_BYTES
      ) {
        throw new Error("Private Harbor JSON is outside its bound.");
      }
      return JSON.parse(
        await handle.readFile({ encoding: "utf8" }),
      ) as unknown;
    } finally {
      await handle.close();
    }
  }

  public async writeJson(
    path: string,
    value: unknown,
  ): Promise<void> {
    await writeJsonAtomic(path, value);
  }

  public async hashFile(
    path: string,
  ): Promise<{ readonly sha256: string; readonly byteLength: number }> {
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < 1) {
        throw new Error("Pinned file is unavailable.");
      }
      const hash = createHash("sha256");
      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) {
        hash.update(chunk as Buffer);
      }
      return { sha256: hash.digest("hex"), byteLength: info.size };
    } finally {
      await handle.close();
    }
  }

  public async secureImportFile(
    source: string,
    destination: string,
    expectedOwnerUid: number,
    maximumBytes: number,
  ): Promise<{ readonly sha256: string; readonly byteLength: number }> {
    if (
      !source.startsWith("/tmp/df-mvp-pi-") ||
      !destination.startsWith("/") ||
      !Number.isSafeInteger(expectedOwnerUid) ||
      expectedOwnerUid <= 0 ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1
    ) {
      throw new Error("Secure runtime import parameters are invalid.");
    }
    const sourceHandle = await open(
      source,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    );
    let temporaryPath: string | null = null;
    try {
      const sourceInfo = await sourceHandle.stat();
      if (
        !sourceInfo.isFile() ||
        sourceInfo.uid !== expectedOwnerUid ||
        sourceInfo.nlink !== 1 ||
        sourceInfo.size < 1 ||
        sourceInfo.size > maximumBytes
      ) {
        throw new Error(
          "Untrusted runtime archive failed secure handoff.",
        );
      }
      await mkdir(dirname(destination), {
        recursive: true,
        mode: 0o700,
      });
      temporaryPath = `${destination}.import-${randomUUID()}`;
      const destinationHandle = await open(
        temporaryPath,
        fileConstants.O_WRONLY |
          fileConstants.O_CREAT |
          fileConstants.O_EXCL |
          fileConstants.O_NOFOLLOW,
        0o600,
      );
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      try {
        while (offset < sourceInfo.size) {
          const { bytesRead } = await sourceHandle.read(
            buffer,
            0,
            Math.min(buffer.length, sourceInfo.size - offset),
            offset,
          );
          if (bytesRead < 1) {
            throw new Error(
              "Untrusted runtime archive changed during handoff.",
            );
          }
          hash.update(buffer.subarray(0, bytesRead));
          let written = 0;
          while (written < bytesRead) {
            const result = await destinationHandle.write(
              buffer,
              written,
              bytesRead - written,
              offset + written,
            );
            if (result.bytesWritten < 1) {
              throw new Error("Secure runtime import was incomplete.");
            }
            written += result.bytesWritten;
          }
          offset += bytesRead;
        }
        await destinationHandle.sync();
      } finally {
        await destinationHandle.close();
      }
      const finalSourceInfo = await sourceHandle.stat();
      if (
        finalSourceInfo.dev !== sourceInfo.dev ||
        finalSourceInfo.ino !== sourceInfo.ino ||
        finalSourceInfo.size !== sourceInfo.size ||
        finalSourceInfo.mtimeMs !== sourceInfo.mtimeMs ||
        finalSourceInfo.ctimeMs !== sourceInfo.ctimeMs
      ) {
        throw new Error(
          "Untrusted runtime archive changed during handoff.",
        );
      }
      await rename(temporaryPath, destination);
      temporaryPath = null;
      return {
        sha256: hash.digest("hex"),
        byteLength: sourceInfo.size,
      };
    } finally {
      await sourceHandle.close();
      if (temporaryPath !== null) {
        await rm(temporaryPath, { force: true });
      }
    }
  }

  public async listDirectories(
    path: string,
  ): Promise<readonly string[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
  }

  public async makeExecutable(path: string): Promise<void> {
    await chmod(path, 0o700);
  }
}

function assertNodeOptions(
  input: CreateNodeMvpEvaluatorDependenciesInput,
): void {
  if (
    !SAFE_GITHUB_NAME.test(input.repository.owner) ||
    !SAFE_GITHUB_NAME.test(input.repository.name) ||
    !REVISION.test(input.repository.baselineCommit) ||
    !REVISION.test(input.repository.baselineTree) ||
    !SHA256.test(input.repository.packageLockSha256) ||
    input.githubBasicAuthPlaceholder.length < 1 ||
    input.githubBasicAuthPlaceholder.length > 2_048 ||
    /[\u0000\r\n]/u.test(input.githubBasicAuthPlaceholder) ||
    input.daytona.apiKeyPlaceholder.length < 1 ||
    /[\u0000\r\n]/u.test(input.daytona.apiKeyPlaceholder) ||
    !input.daytona.apiUrl.startsWith("https://") ||
    !/(?:^|[-_.])eu(?:$|[-_.])/iu.test(input.daytona.target)
  ) {
    throw new Error("Node evaluator dependencies are invalid.");
  }
}

function assertLinuxDaytona(): void {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 0 ||
    process.env["DF_CLOUD_EXECUTION"] !== "1" ||
    process.env["DF_MVP_ROLE"] !== "evaluator" ||
    process.env["DAYTONA_SANDBOX_ID"] === undefined
  ) {
    throw new Error(
      "The Node evaluator is restricted to a Daytona Linux role.",
    );
  }
}

function safeBuildEnvironment(
  home: string,
): Readonly<Record<string, string>> {
  return {
    CI: "true",
    HOME: home,
    LC_ALL: "C",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
}

async function assertEvaluatorPrivateRoot(
  stateRoot: string,
): Promise<void> {
  const privateRoot = join(stateRoot, "private");
  const info = await lstat(privateRoot);
  if (
    !info.isDirectory() ||
    info.uid !== 0 ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(
      "Evaluator private state is not root-owned mode 0700.",
    );
  }
}

async function verifyPinnedFile(
  files: MvpEvaluatorFileSystemPort,
  path: string,
  expectedSha256: string,
): Promise<void> {
  const actual = await files.hashFile(path);
  if (actual.sha256 !== expectedSha256) {
    throw new Error("A pinned evaluator executable changed.");
  }
}

function plainRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("Expected a private JSON object.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Harbor timestamp is malformed.");
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new Error("Harbor timestamp is malformed.");
  }
  return new Date(time).toISOString();
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    JSON.stringify([...left].sort()) ===
      JSON.stringify([...right].sort())
  );
}

function agentName(
  arm: "candidate" | "champion",
):
  | "dark-factory-candidate"
  | "dark-factory-champion" {
  return arm === "candidate"
    ? "dark-factory-candidate"
    : "dark-factory-champion";
}
