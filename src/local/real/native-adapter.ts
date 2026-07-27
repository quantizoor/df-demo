import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../../mvp/contracts.js";
import { readLocalFoundryCredentials } from "./config.js";
import {
  LOCAL_REAL_REPETITIONS,
  LOCAL_REAL_SCHEMA_VERSION,
  type LocalRealArmReceipt,
  type LocalRealCampaignConfig,
  type LocalRealCampaignState,
  type LocalRealCandidateReceipt,
  type LocalRealObservation,
  type LocalRealOptimizerReceipt,
  type LocalRealRunnerAdapter,
  type LocalRealRuntime,
  type LocalRealTask,
} from "./contracts.js";
import { publishLocalGitChampion } from "./git-publication.js";
import { runLocalProcess, runLocalProcessChecked } from "./process.js";
import { readLocalRealArtifact, writeLocalRealArtifactOnce } from "./state.js";

const MAXIMUM_CANDIDATE_FILES = 8;
const MAXIMUM_CANDIDATE_DIFF_BYTES = 256 * 1024;
const MAXIMUM_CREDENTIAL_SCAN_FILES = 100_000;
const MAXIMUM_CREDENTIAL_SCAN_FILE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_CREDENTIAL_SCAN_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const ALLOWED_CANDIDATE_ROOTS = [
  "packages/agent/src/",
  "packages/ai/src/",
  "packages/coding-agent/src/",
] as const;
const ALLOWED_CANDIDATE_EXTENSIONS = new Set([".ts", ".tsx"]);
const OPTIMIZER_OUTPUT_FORMAT = "stream-json";
const OPTIMIZER_PERMISSION_MODE = "dontAsk";
const OPTIMIZER_SESSION_PERSISTENCE = false;
const OPTIMIZER_BROWSER_ENABLED = false;
const OPTIMIZER_ALLOWED_TOOLS = ["Read", "Edit", "Write", "Grep", "Glob"] as const;
const OPTIMIZER_DISALLOWED_TOOLS = [
  "Bash",
  "Shell",
  "WebSearch",
  "WebFetch",
  "Agent",
  "Task",
  "NotebookEdit",
] as const;
const OPTIMIZER_SHELL_ENABLED = false;
const OPTIMIZER_NETWORK_TOOLS_ENABLED = false;
const OPTIMIZER_INSTRUCTION_FILES = ["AGENTS.md"] as const;

export interface LocalLinuxExecutionTarget {
  readonly piPlatform: "linux-arm64" | "linux-x64";
  readonly dockerPlatform: "linux/arm64" | "linux/amd64";
}

export function localLinuxExecutionTarget(
  hostArchitecture: string = process.arch,
): LocalLinuxExecutionTarget {
  return hostArchitecture === "arm64"
    ? {
        piPlatform: "linux-arm64",
        dockerPlatform: "linux/arm64",
      }
    : {
        piPlatform: "linux-x64",
        dockerPlatform: "linux/amd64",
      };
}

export function localPiRuntimeCacheDirectory(
  campaignDirectory: string,
  revision: string,
  hostArchitecture: string = process.arch,
): string {
  return join(
    campaignDirectory,
    "runtimes",
    revision,
    localLinuxExecutionTarget(hostArchitecture).piPlatform,
  );
}

export function localCandidateWorktreeDirectory(
  campaignDirectory: string,
  experimentId: string,
): string {
  const match = /^(\d{6})-optimization$/u.exec(experimentId);
  if (match?.[1] === undefined) {
    throw new Error("Candidate experiment identity is invalid");
  }
  return join(campaignDirectory, "worktrees", `c-${match[1]}`);
}

export type HarborTaskIdentity =
  | {
      readonly kind: "name-ref";
      readonly taskName: string;
      readonly taskRevision: string;
    }
  | {
      readonly kind: "git-path";
      readonly taskPath: string;
      readonly taskRevision: string;
    };

export function parseHarborTaskIdentity(value: unknown): HarborTaskIdentity {
  const taskId = asRecord(value, "Harbor task identity");
  const name = taskId["name"];
  const ref = taskId["ref"];
  if (nonemptyString(name) && nonemptyString(ref)) {
    return {
      kind: "name-ref",
      taskName: name.replace(/^terminal-bench\//u, ""),
      taskRevision: ref,
    };
  }
  const path = taskId["path"];
  const gitCommitId = taskId["git_commit_id"];
  if (nonemptyString(path) && nonemptyString(gitCommitId)) {
    return {
      kind: "git-path",
      taskPath: path,
      taskRevision: gitCommitId,
    };
  }
  throw new Error("Harbor trial identity is invalid");
}

interface LocalOptimizerEnvironmentDefinition {
  readonly name: string;
  readonly runtimeValue: string;
  readonly disclosedValue: string | null;
  readonly secret: boolean;
  readonly description: string;
}

interface LocalOptimizerInvocation {
  readonly schemaVersion: typeof LOCAL_REAL_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly championRevision: string;
  readonly attemptOrdinal: number;
  readonly startedAt: string;
  readonly containsSecrets: false;
}

export function createNativeLocalRealAdapter(): LocalRealRunnerAdapter {
  return {
    ensureChampionRuntime: ensureChampionRuntime,
    evaluateArm,
    optimize,
    validateAndBuild,
    publish,
  };
}

async function ensureChampionRuntime(
  config: LocalRealCampaignConfig,
  state: LocalRealCampaignState,
  experimentDirectory: string,
  signal?: AbortSignal,
): Promise<LocalRealRuntime> {
  const campaignDirectory = campaignDirectoryFromExperiment(experimentDirectory);
  const runtimeDirectory = localPiRuntimeCacheDirectory(campaignDirectory, state.championRevision);
  const receiptPath = join(runtimeDirectory, "runtime.json");
  const existing = await readLocalRealArtifact<LocalRealRuntime>(receiptPath);
  if (existing !== null) return existing;

  await ensureCommitAvailable(config, state.championRevision, campaignDirectory, signal);
  const worktree = join(
    campaignDirectory,
    "worktrees",
    `champion-${state.championRevision.slice(0, 16)}`,
  );
  await ensureDetachedWorktree(
    config.piRepository,
    worktree,
    state.championRevision,
    join(runtimeDirectory, "git"),
    signal,
  );
  await prepareDetachedPiModelData({
    sourceRepository: config.piRepository,
    worktree,
  });
  const tree = (
    await gitChecked(worktree, ["rev-parse", "HEAD^{tree}"], join(runtimeDirectory, "git-tree"), {
      signal,
    })
  ).stdout.trim();
  const runtime = await buildPiRuntime({
    worktree,
    revision: state.championRevision,
    tree,
    runtimeDirectory,
    runTests: false,
    ...(signal === undefined ? {} : { signal }),
  });
  await writeLocalRealArtifactOnce(receiptPath, runtime);
  return runtime;
}

async function optimize(input: {
  readonly config: LocalRealCampaignConfig;
  readonly state: LocalRealCampaignState;
  readonly experimentId: string;
  readonly experimentDirectory: string;
  readonly previousDecision: Parameters<LocalRealRunnerAdapter["optimize"]>[0]["previousDecision"];
  readonly signal?: AbortSignal;
}): Promise<LocalRealOptimizerReceipt> {
  const optimizerDirectory = join(input.experimentDirectory, "optimizer");
  const attemptsDirectory = join(optimizerDirectory, "attempts");
  const worktree = localCandidateWorktreeDirectory(
    campaignDirectoryFromExperiment(input.experimentDirectory),
    input.experimentId,
  );
  const credentials = await readLocalFoundryCredentials(input.config.credentialsFile);
  await mkdir(attemptsDirectory, { recursive: true, mode: 0o700 });
  const existingAttempts = await optimizerAttemptDirectories(attemptsDirectory);
  for (const attemptDirectory of existingAttempts) {
    const existingReceipt = await readLocalRealArtifact<LocalRealOptimizerReceipt>(
      join(attemptDirectory, "receipt.json"),
    );
    if (existingReceipt !== null) {
      await ensureDetachedWorktree(
        input.config.piRepository,
        worktree,
        input.state.championRevision,
        join(attemptDirectory, "git-recover-receipt"),
        input.signal,
      );
      return existingReceipt;
    }
    const invocation = await readLocalRealArtifact<LocalOptimizerInvocation>(
      join(attemptDirectory, "invocation.json"),
    );
    const transcriptPath = join(attemptDirectory, "transcript.jsonl");
    const stderrPath = join(attemptDirectory, "stderr.log");
    if (invocation === null || !(await pathExists(transcriptPath))) continue;
    await redactCredentialLogs(transcriptPath, stderrPath, credentials.apiKey);
    let parsed: ReturnType<typeof parseClaudeOptimizerStream>;
    try {
      parsed = parseClaudeOptimizerStream(
        await readFile(transcriptPath, "utf8"),
        input.config.optimizer.deployment,
      );
    } catch {
      continue;
    }
    if (!(await pathExists(worktree))) {
      throw new Error("Completed optimizer transcript has no candidate worktree");
    }
    await ensureDetachedWorktree(
      input.config.piRepository,
      worktree,
      input.state.championRevision,
      join(attemptDirectory, "git-recover-transcript"),
      input.signal,
    );
    const recovered = await optimizerReceiptFromAttempt({
      input,
      worktree,
      attemptDirectory,
      invocation,
      parsed,
    });
    await writeLocalRealArtifactOnce(join(attemptDirectory, "receipt.json"), recovered);
    return recovered;
  }

  if (existingAttempts.length > 0 || (await pathExists(worktree))) {
    await recreateDetachedWorktree({
      repository: input.config.piRepository,
      worktree,
      revision: input.state.championRevision,
      expectedParent: join(campaignDirectoryFromExperiment(input.experimentDirectory), "worktrees"),
      logPrefix: join(optimizerDirectory, "git-worktree-recovery"),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } else {
    await ensureDetachedWorktree(
      input.config.piRepository,
      worktree,
      input.state.championRevision,
      join(optimizerDirectory, "git-worktree"),
      input.signal,
    );
  }

  const attemptOrdinal = existingAttempts.length + 1;
  const attemptDirectory = join(attemptsDirectory, String(attemptOrdinal).padStart(3, "0"));
  await mkdir(attemptDirectory, { recursive: false, mode: 0o700 });
  const claudeConfig = join(attemptDirectory, "claude-config");
  await mkdir(claudeConfig, { recursive: true, mode: 0o700 });
  const transcriptPath = join(attemptDirectory, "transcript.jsonl");
  const stderrPath = join(attemptDirectory, "stderr.log");
  const invocation: LocalOptimizerInvocation = {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    experimentId: input.experimentId,
    championRevision: input.state.championRevision,
    attemptOrdinal,
    startedAt: new Date().toISOString(),
    containsSecrets: false,
  };
  await writeLocalRealArtifactOnce(join(attemptDirectory, "invocation.json"), invocation);
  const prompt = optimizerPrompt({
    experimentId: input.experimentId,
    experimentNumber: input.state.nextExperimentNumber,
    championRevision: input.state.championRevision,
    previousDecision: input.previousDecision,
  });
  const optimizerEnvironment = localOptimizerEnvironment({
    claudeConfig,
    resourceName: credentials.resourceName,
    optimizerDeployment: credentials.optimizerDeployment,
    apiKey: credentials.apiKey,
  });
  const candidateTree = (
    await gitChecked(
      worktree,
      ["rev-parse", "HEAD^{tree}"],
      join(attemptDirectory, "source-tree"),
      { signal: input.signal },
    )
  ).stdout.trim();
  const instructionFileSha256 = {
    "AGENTS.md": await sha256File(join(worktree, "AGENTS.md")),
  };
  await writeLocalRealArtifactOnce(join(attemptDirectory, "input.json"), {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    experimentId: input.experimentId,
    championRevision: input.state.championRevision,
    previousDecision: input.previousDecision,
    prompt,
    promptSha256: sha256(prompt),
    executionContract: {
      model: input.config.optimizer.deployment,
      effort: input.config.optimizer.effort,
      maximumCostUsd: input.config.optimizer.maximumCostUsd,
      maximumTurns: input.config.optimizer.maximumTurns,
      timeoutMs: input.config.optimizer.timeoutMs,
      outputFormat: OPTIMIZER_OUTPUT_FORMAT,
      permissionMode: OPTIMIZER_PERMISSION_MODE,
      sessionPersistence: OPTIMIZER_SESSION_PERSISTENCE,
      browserEnabled: OPTIMIZER_BROWSER_ENABLED,
      allowedTools: [...OPTIMIZER_ALLOWED_TOOLS],
      disallowedTools: [...OPTIMIZER_DISALLOWED_TOOLS],
      shellEnabled: OPTIMIZER_SHELL_ENABLED,
      networkToolsEnabled: OPTIMIZER_NETWORK_TOOLS_ENABLED,
    },
    sourceContext: {
      kind: "detached-champion-worktree",
      championRevision: input.state.championRevision,
      candidateTree,
      readableScope:
        "The full candidate checkout is the process working directory. It and absolute paths are not operating-system filesystem-sandboxed. The prompt permits repository source only and prohibits .git, tests, fixtures, examples, benchmark files, evaluation configuration, absolute external paths, and network access.",
      editableRoots: [...ALLOWED_CANDIDATE_ROOTS],
      instructionFiles: [...OPTIMIZER_INSTRUCTION_FILES],
      instructionFileSha256,
      restrictionsEnforcedBy:
        "Optimizer prompt plus Claude CLI allowed/disallowed tool lists; no operating-system filesystem or network sandbox is applied. Provider API network access is required, while WebSearch and WebFetch are disabled.",
      postRunChangeValidation: `The runner rejects edits outside the declared roots, non-TypeScript files, more than ${MAXIMUM_CANDIDATE_FILES} changed files, or a candidate patch larger than ${MAXIMUM_CANDIDATE_DIFF_BYTES} bytes, then runs repository checks, tests, and a production build.`,
    },
    environment: optimizerEnvironment.map(({ name, disclosedValue, secret, description }) => ({
      name,
      value: disclosedValue,
      secret,
      description,
    })),
    boundary: {
      taskCatalogVisible: false,
      panelVisible: false,
      graderVisible: false,
      rawEvaluationVisible: false,
    },
    containsSecrets: false,
  });
  let result: Awaited<ReturnType<typeof runLocalProcess>>;
  try {
    result = await runLocalProcess({
      executable: input.config.claudeExecutable,
      arguments: localOptimizerArguments(input.config.optimizer, prompt),
      workingDirectory: worktree,
      environment: Object.fromEntries(
        optimizerEnvironment.map(({ name, runtimeValue }) => [name, runtimeValue]),
      ),
      inheritEnvironment: false,
      timeoutMs: input.config.optimizer.timeoutMs,
      maximumOutputBytes: 64 * 1024 * 1024,
      stdoutPath: transcriptPath,
      stderrPath,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      sensitiveValues: [credentials.apiKey],
    });
  } finally {
    await redactCredentialLogs(transcriptPath, stderrPath, credentials.apiKey);
  }
  if (result.exitCode !== 0) {
    throw new Error(`Claude optimizer exited with code ${result.exitCode}`);
  }
  const sanitizedStdout = await readFile(transcriptPath, "utf8");
  const parsed = parseClaudeOptimizerStream(sanitizedStdout, input.config.optimizer.deployment);
  const receipt = await optimizerReceiptFromAttempt({
    input,
    worktree,
    attemptDirectory,
    invocation,
    parsed,
  });
  await writeLocalRealArtifactOnce(join(attemptDirectory, "receipt.json"), receipt);
  return receipt;
}

async function validateAndBuild(input: {
  readonly config: LocalRealCampaignConfig;
  readonly experimentId: string;
  readonly experimentDirectory: string;
  readonly optimizer: LocalRealOptimizerReceipt;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly candidate: LocalRealCandidateReceipt;
  readonly runtime: LocalRealRuntime | null;
}> {
  const candidateDirectory = join(input.experimentDirectory, "candidate");
  await mkdir(candidateDirectory, { recursive: true, mode: 0o700 });
  const validationCommands: {
    command: string;
    logPath: string;
    exitCode: number;
    durationMs: number;
  }[] = [];
  const initialPaths = await candidateChangedFiles(
    input.optimizer.worktree,
    join(candidateDirectory, "git-status-initial"),
    input.signal,
  );
  const initialPathError = candidatePathError(initialPaths);
  if (initialPathError !== null) {
    return {
      candidate: await invalidCandidate({
        input,
        changedFiles: initialPaths,
        reason: initialPathError,
        validationCommands,
      }),
      runtime: null,
    };
  }
  await prepareDetachedPiModelData({
    sourceRepository: input.config.piRepository,
    worktree: input.optimizer.worktree,
  });

  for (const command of localPiCandidateValidationCommands(initialPaths)) {
    const result = await runLocalProcess({
      executable: command.executable,
      arguments: command.arguments,
      workingDirectory: input.optimizer.worktree,
      environment: developmentEnvironment(),
      inheritEnvironment: false,
      timeoutMs: command.timeoutMs,
      maximumOutputBytes: 64 * 1024 * 1024,
      stdoutPath: join(candidateDirectory, `${command.label}.stdout.log`),
      stderrPath: join(candidateDirectory, `${command.label}.stderr.log`),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    validationCommands.push({
      command: [command.executable, ...command.arguments].join(" "),
      logPath: relativeArtifact(
        input.experimentDirectory,
        join(candidateDirectory, `${command.label}.stdout.log`),
      ),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    });
    if (result.exitCode !== 0) {
      return {
        candidate: await invalidCandidate({
          input,
          changedFiles: initialPaths,
          reason: `${command.label}-failed`,
          validationCommands,
        }),
        runtime: null,
      };
    }
  }

  const finalPaths = await candidateChangedFiles(
    input.optimizer.worktree,
    join(candidateDirectory, "git-status-final"),
    input.signal,
  );
  const finalPathError = candidatePathError(finalPaths);
  if (finalPathError !== null) {
    return {
      candidate: await invalidCandidate({
        input,
        changedFiles: finalPaths,
        reason: finalPathError,
        validationCommands,
      }),
      runtime: null,
    };
  }
  const credentials = await readLocalFoundryCredentials(input.config.credentialsFile);
  let containedCredential = false;
  for (const path of finalPaths) {
    containedCredential =
      (await redactCredentialFile(join(input.optimizer.worktree, path), credentials.apiKey)) ||
      containedCredential;
  }
  if (containedCredential) {
    return {
      candidate: await invalidCandidate({
        input,
        changedFiles: finalPaths,
        reason: "candidate-contained-credential",
        validationCommands,
      }),
      runtime: null,
    };
  }
  await gitChecked(
    input.optimizer.worktree,
    ["add", "--", ...finalPaths],
    join(candidateDirectory, "git-add"),
    { signal: input.signal },
  );
  const tree = (
    await gitChecked(
      input.optimizer.worktree,
      ["write-tree"],
      join(candidateDirectory, "git-write-tree"),
      { signal: input.signal },
    )
  ).stdout.trim();
  const parentTree = (
    await gitChecked(
      input.optimizer.worktree,
      ["rev-parse", "HEAD^{tree}"],
      join(candidateDirectory, "git-parent-tree"),
      { signal: input.signal },
    )
  ).stdout.trim();
  const patchPath = join(candidateDirectory, "candidate.patch");
  await gitChecked(
    input.optimizer.worktree,
    ["diff", "--cached", "--binary", "--full-index", `--output=${patchPath}`, "HEAD"],
    join(candidateDirectory, "git-diff"),
    { signal: input.signal },
  );
  await chmod(patchPath, 0o600);
  const patchInformation = await stat(patchPath);
  const patchOversized = patchInformation.size > MAXIMUM_CANDIDATE_DIFF_BYTES;
  const patch = patchOversized ? "" : await readFile(patchPath, "utf8");
  if (tree === parentTree || patchInformation.size < 1 || patchOversized) {
    return {
      candidate: candidateReceipt({
        input,
        tree,
        changedFiles: finalPaths,
        patchPath,
        patch,
        patchSha256: await sha256File(patchPath),
        validationCommands,
        valid: false,
        invalidReason:
          tree === parentTree || patchInformation.size < 1
            ? "candidate-has-no-change"
            : "candidate-diff-oversized",
        runtime: null,
      }),
      runtime: null,
    };
  }

  const runtimeDirectory = localPiRuntimeCacheDirectory(
    campaignDirectoryFromExperiment(input.experimentDirectory),
    tree,
  );
  let runtime: LocalRealRuntime;
  try {
    runtime = await buildPiRuntime({
      worktree: input.optimizer.worktree,
      revision: tree,
      tree,
      runtimeDirectory,
      runTests: false,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const runtimeBuildLogPath = await stageCandidateRuntimeBuildLogs(
      input.experimentDirectory,
      runtimeDirectory,
    );
    validationCommands.push({
      command: `./scripts/build-binaries.sh --skip-install --offline-model-data --platform ${
        localLinuxExecutionTarget().piPlatform
      }`,
      logPath: runtimeBuildLogPath,
      exitCode: 0,
      durationMs:
        (
          await readLocalRealArtifact<{ readonly durationMs: number }>(
            join(runtimeDirectory, "build-command.json"),
          )
        )?.durationMs ?? 0,
    });
  } catch (error) {
    if (input.signal?.aborted === true) throw error;
    return {
      candidate: candidateReceipt({
        input,
        tree,
        changedFiles: finalPaths,
        patchPath,
        patch,
        validationCommands,
        valid: false,
        invalidReason: "candidate-build-failed",
        runtime: null,
      }),
      runtime: null,
    };
  }
  const worktreeDiff = await runLocalProcess({
    executable: "git",
    arguments: ["diff", "--quiet", "--exit-code"],
    workingDirectory: input.optimizer.worktree,
    environment: {
      ...developmentEnvironment(),
      GIT_OPTIONAL_LOCKS: "0",
    },
    inheritEnvironment: false,
    timeoutMs: 5 * 60_000,
    maximumOutputBytes: 1024 * 1024,
    stdoutPath: join(candidateDirectory, "git-worktree-after-build.stdout.log"),
    stderrPath: join(candidateDirectory, "git-worktree-after-build.stderr.log"),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const untrackedAfterBuild = await gitChecked(
    input.optimizer.worktree,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    join(candidateDirectory, "git-untracked-after-build"),
    { signal: input.signal },
  );
  const treeAfterBuild = (
    await gitChecked(
      input.optimizer.worktree,
      ["write-tree"],
      join(candidateDirectory, "git-tree-after-build"),
      { signal: input.signal },
    )
  ).stdout.trim();
  if (
    worktreeDiff.exitCode !== 0 ||
    nulList(untrackedAfterBuild.stdout).length > 0 ||
    treeAfterBuild !== tree
  ) {
    return {
      candidate: candidateReceipt({
        input,
        tree,
        changedFiles: finalPaths,
        patchPath,
        patch,
        validationCommands,
        valid: false,
        invalidReason: "candidate-tree-changed-during-build",
        runtime: null,
      }),
      runtime: null,
    };
  }
  return {
    candidate: candidateReceipt({
      input,
      tree,
      changedFiles: finalPaths,
      patchPath,
      patch,
      validationCommands,
      valid: true,
      invalidReason: null,
      runtime,
    }),
    runtime,
  };
}

async function evaluateArm(input: {
  readonly config: LocalRealCampaignConfig;
  readonly experimentId: string;
  readonly experimentDirectory: string;
  readonly arm: "champion" | "candidate";
  readonly revision: string;
  readonly runtime: LocalRealRuntime;
  readonly tasks: readonly LocalRealTask[];
  readonly attemptOrdinal: number;
  readonly signal?: AbortSignal;
}): Promise<LocalRealArmReceipt> {
  const campaignDirectory = campaignDirectoryFromExperiment(input.experimentDirectory);
  const jobName = [
    "df",
    input.config.campaignId,
    input.experimentId,
    input.arm,
    `p${String(input.attemptOrdinal).padStart(2, "0")}`,
  ].join("-");
  const jobsDirectory = join(campaignDirectory, "harbor");
  const jobDirectory = join(jobsDirectory, jobName);
  const receiptPath = join(input.experimentDirectory, "harbor", `${jobName}.json`);
  const existing = await readLocalRealArtifact<LocalRealArmReceipt>(receiptPath);
  if (existing !== null) return existing;
  const credentials = await readLocalFoundryCredentials(input.config.credentialsFile);
  if (await pathExists(jobDirectory)) {
    await redactCredentialTree(jobDirectory, credentials.apiKey);
    try {
      const parsed = await parseHarborJob(input, jobName, jobDirectory);
      await writeLocalRealArtifactOnce(receiptPath, parsed);
      return parsed;
    } catch {
      // Harbor 0.20 writes job result.json incrementally. Reusing the exact
      // job name/config lets Harbor resume only the missing trials.
    }
  }
  const configPath = join(input.experimentDirectory, "harbor", `${jobName}-config.json`);
  const registryPath = join(input.experimentDirectory, "harbor", `${jobName}-registry.json`);
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeLocalRealArtifactOnce(registryPath, [
    {
      name: input.config.evaluation.datasetName,
      version: input.config.evaluation.datasetVersion,
      description: "Campaign-pinned Terminal-Bench task registry",
      tasks: input.tasks.map((task) => ({
        name: task.name,
        git_url: task.sourceRepository,
        git_commit_id: task.sourceRevision,
        path: task.sourcePath,
      })),
    },
  ]);
  const harborConfig = localHarborJobConfiguration({
    config: input.config,
    jobName,
    jobsDirectory,
    registryPath,
    runtime: input.runtime,
    tasks: input.tasks,
  });
  const serializedConfig = `${JSON.stringify(harborConfig, null, 2)}\n`;
  if (serializedConfig.includes(credentials.apiKey)) {
    throw new Error("Harbor configuration contains a credential");
  }
  await writeFile(configPath, serializedConfig, {
    encoding: "utf8",
    mode: 0o600,
  });
  const adapterDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../assets");
  const productionAdapterDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../terminal-bench/assets",
  );
  const stdoutPath = join(input.experimentDirectory, "harbor", `${jobName}.stdout.log`);
  const stderrPath = join(input.experimentDirectory, "harbor", `${jobName}.stderr.log`);
  const executionTarget = localLinuxExecutionTarget();
  let result: Awaited<ReturnType<typeof runLocalProcess>>;
  try {
    result = await runLocalProcess({
      executable: "uvx",
      arguments: [
        "--python",
        "3.13",
        "--from",
        `harbor==${input.config.evaluation.harborVersion}`,
        "harbor",
        "run",
        "--config",
        configPath,
        "--yes",
      ],
      workingDirectory: input.experimentDirectory,
      environment: {
        PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? dirname(input.experimentDirectory),
        LANG: "C",
        LC_ALL: "C",
        DOCKER_DEFAULT_PLATFORM: executionTarget.dockerPlatform,
        PYTHONPATH: `${adapterDirectory}:${productionAdapterDirectory}`,
        ANTHROPIC_FOUNDRY_API_KEY: credentials.apiKey,
      },
      inheritEnvironment: false,
      timeoutMs: 8 * 60 * 60_000,
      maximumOutputBytes: 64 * 1024 * 1024,
      stdoutPath,
      stderrPath,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      sensitiveValues: [credentials.apiKey],
    });
  } finally {
    await redactCredentialLogs(stdoutPath, stderrPath, credentials.apiKey);
    if (await pathExists(jobDirectory)) {
      await redactCredentialTree(jobDirectory, credentials.apiKey);
    }
  }
  if (result.exitCode !== 0 && !(await pathExists(join(jobDirectory, "result.json")))) {
    throw new Error(`Harbor exited with code ${result.exitCode}`);
  }
  const receipt = await parseHarborJob(input, jobName, jobDirectory);
  await writeLocalRealArtifactOnce(receiptPath, receipt);
  return receipt;
}

export function localHarborJobConfiguration(input: {
  readonly config: LocalRealCampaignConfig;
  readonly jobName: string;
  readonly jobsDirectory: string;
  readonly registryPath: string;
  readonly runtime: LocalRealRuntime;
  readonly tasks: readonly LocalRealTask[];
}) {
  return {
    job_name: input.jobName,
    jobs_dir: input.jobsDirectory,
    n_attempts: LOCAL_REAL_REPETITIONS,
    n_concurrent_trials: input.config.evaluation.concurrency,
    environment: {
      force_build: true,
    },
    agents: [
      {
        name: "dark_factory_pi_local:DarkFactoryPi",
        model_name: `microsoft-foundry/${input.config.evaluatedAgent.deployment}`,
        include_logs: ["dark-factory-pi.jsonl"],
        kwargs: {
          runtime_archive_path: input.runtime.archivePath,
          runtime_sha256: input.runtime.archiveSha256,
          pi_entrypoint: input.runtime.piEntrypoint,
          thinking: input.config.evaluatedAgent.thinking,
          enabled_tools: ["read", "bash", "edit", "write"],
          credential_environment_names: ["ANTHROPIC_FOUNDRY_API_KEY"],
          foundry_resource_name: input.config.optimizer.resourceName,
          model_family: input.config.evaluatedAgent.deployment,
        },
      },
    ],
    datasets: [
      {
        name: input.config.evaluation.datasetName,
        version: input.config.evaluation.datasetVersion,
        registry_path: input.registryPath,
        task_names: input.tasks.map((task) => task.name),
      },
    ],
  };
}

async function publish(input: {
  readonly config: LocalRealCampaignConfig;
  readonly experimentId: string;
  readonly experimentDirectory: string;
  readonly worktree: string;
  readonly parentRevision: string;
  readonly candidateTree: string;
  readonly changedFiles: readonly string[];
  readonly timestamp: string;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly commit: string;
  readonly status: "published" | "already-published";
  readonly experimentRef: string;
  readonly championRef: string;
}> {
  await assertConfiguredPiRemote(
    input.config,
    input.worktree,
    join(input.experimentDirectory, "publication-remote"),
  );
  const decisionText = await readFile(join(input.experimentDirectory, "decision.json"), "utf8");
  const result = await publishLocalGitChampion(
    {
      decision: "promoted",
      campaignId: input.config.campaignId,
      experimentId: input.experimentId,
      candidateWorktree: input.worktree,
      remoteName: input.config.publication.remoteName,
      parentCommit: input.parentRevision,
      evaluatedTree: input.candidateTree,
      commitMessage: `fix(coding-agent): dark factory champion ${input.experimentId}`,
      commitTimestamp: input.timestamp,
      decisionHash: sha256(decisionText),
    },
    {
      persistIntent: async (intent) => {
        await writeLocalRealArtifactOnce(
          join(input.experimentDirectory, "publication-intent.json"),
          intent,
        );
      },
    },
  );
  if (result.status !== "published") {
    throw new Error("Promotion publisher returned a nonpromotion result");
  }
  const localRef = `refs/dark-factory/champions/${input.config.campaignId}`;
  await gitChecked(
    input.worktree,
    ["update-ref", localRef, result.intent.candidateCommit],
    join(input.experimentDirectory, "publication-local-ref"),
  );
  return {
    commit: result.intent.candidateCommit,
    status: result.disposition,
    experimentRef: result.intent.experimentRef,
    championRef: result.intent.championRef,
  };
}

async function buildPiRuntime(input: {
  readonly worktree: string;
  readonly revision: string;
  readonly tree: string;
  readonly runtimeDirectory: string;
  readonly runTests: boolean;
  readonly signal?: AbortSignal;
}): Promise<LocalRealRuntime> {
  const executionTarget = localLinuxExecutionTarget();
  const receiptPath = join(input.runtimeDirectory, "runtime.json");
  const existing = await readLocalRealArtifact<LocalRealRuntime>(receiptPath);
  if (existing !== null) return existing;
  await mkdir(input.runtimeDirectory, { recursive: true, mode: 0o700 });
  const commands: {
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly label: string;
    readonly timeoutMs: number;
  }[] = [...localPiRepositoryPreparationCommands()];
  if (input.runTests) {
    commands.push({
      executable: "./test.sh",
      arguments: [],
      label: "test-sh",
      timeoutMs: 60 * 60_000,
    });
  }
  for (const command of commands) {
    await runLocalProcessChecked({
      executable: command.executable,
      arguments: command.arguments,
      workingDirectory: input.worktree,
      environment: developmentEnvironment(),
      inheritEnvironment: false,
      timeoutMs: command.timeoutMs,
      maximumOutputBytes: 64 * 1024 * 1024,
      stdoutPath: join(input.runtimeDirectory, `${command.label}.stdout.log`),
      stderrPath: join(input.runtimeDirectory, `${command.label}.stderr.log`),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
  const outputDirectory = join(input.runtimeDirectory, "build");
  const build = await runLocalProcessChecked({
    executable: "./scripts/build-binaries.sh",
    arguments: [
      "--skip-install",
      "--offline-model-data",
      "--platform",
      executionTarget.piPlatform,
      "--out",
      outputDirectory,
    ],
    workingDirectory: input.worktree,
    environment: {
      ...developmentEnvironment(),
      COPYFILE_DISABLE: "1",
    },
    inheritEnvironment: false,
    timeoutMs: 90 * 60_000,
    maximumOutputBytes: 64 * 1024 * 1024,
    stdoutPath: join(input.runtimeDirectory, "build.stdout.log"),
    stderrPath: join(input.runtimeDirectory, "build.stderr.log"),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const archivePath = join(outputDirectory, `pi-${executionTarget.piPlatform}.tar.gz`);
  const archiveInformation = await stat(archivePath);
  if (!archiveInformation.isFile() || archiveInformation.size < 1) {
    throw new Error("Pi runtime build did not create its Linux archive");
  }
  const runtime: LocalRealRuntime = {
    revision: input.revision,
    tree: input.tree,
    archivePath,
    archiveSha256: await sha256File(archivePath),
    piEntrypoint: "pi/pi",
  };
  await writeLocalRealArtifactOnce(receiptPath, runtime);
  const buildCommandPath = join(input.runtimeDirectory, "build-command.json");
  if ((await readLocalRealArtifact(buildCommandPath)) === null) {
    await writeLocalRealArtifactOnce(buildCommandPath, {
      command: `./scripts/build-binaries.sh --skip-install --offline-model-data --platform ${executionTarget.piPlatform}`,
      exitCode: build.exitCode,
      durationMs: build.durationMs,
      containsSecrets: false,
    });
  }
  return runtime;
}

export async function stageCandidateRuntimeBuildLogs(
  experimentDirectory: string,
  runtimeDirectory: string,
): Promise<string> {
  const candidateDirectory = join(experimentDirectory, "candidate");
  const stdoutPath = join(candidateDirectory, "runtime-build.stdout.log");
  const stderrPath = join(candidateDirectory, "runtime-build.stderr.log");
  await mkdir(candidateDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    copyFile(join(runtimeDirectory, "build.stdout.log"), stdoutPath),
    copyFile(join(runtimeDirectory, "build.stderr.log"), stderrPath),
  ]);
  return relativeArtifact(experimentDirectory, stdoutPath);
}

export function localPiRepositoryPreparationCommands(): readonly {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly label: string;
  readonly timeoutMs: number;
}[] {
  return [
    {
      executable: "npm",
      arguments: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      label: "npm-ci",
      timeoutMs: 30 * 60_000,
    },
    {
      executable: "npm",
      arguments: ["--prefix", "packages/ai", "run", "check:model-data"],
      label: "npm-run-check-model-data",
      timeoutMs: 5 * 60_000,
    },
  ];
}

export function localPiCandidateValidationCommands(changedFiles: readonly string[]): readonly {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly label: string;
  readonly timeoutMs: number;
}[] {
  const affectedWorkspaces = [
    {
      root: "packages/agent/src/",
      name: "@earendil-works/pi-agent-core",
      label: "npm-test-agent",
    },
    {
      root: "packages/ai/src/",
      name: "@earendil-works/pi-ai",
      label: "npm-test-ai",
    },
    {
      root: "packages/coding-agent/src/",
      name: "@earendil-works/pi-coding-agent",
      label: "npm-test-coding-agent",
    },
  ].filter((workspace) => changedFiles.some((path) => path.startsWith(workspace.root)));
  if (affectedWorkspaces.length === 0) {
    throw new Error("Candidate validation requires at least one affected workspace");
  }
  return [
    ...localPiRepositoryPreparationCommands(),
    {
      executable: "npm",
      arguments: ["run", "check"],
      label: "npm-run-check",
      timeoutMs: 30 * 60_000,
    },
    {
      executable: "npm",
      arguments: ["run", "build:offline"],
      label: "npm-run-build-offline",
      timeoutMs: 30 * 60_000,
    },
    ...affectedWorkspaces.map((workspace) => ({
      executable: "npm",
      arguments: ["test", `--workspace=${workspace.name}`],
      label: workspace.label,
      timeoutMs: 60 * 60_000,
    })),
  ];
}

export async function prepareDetachedPiModelData(input: {
  readonly sourceRepository: string;
  readonly worktree: string;
}): Promise<"copied"> {
  const relativeSegments = ["packages", "ai", "src", "providers", "data"] as const;
  const sourceDirectory = resolve(input.sourceRepository, ...relativeSegments);
  const destinationDirectory = resolve(input.worktree, ...relativeSegments);
  const entries = await readdir(sourceDirectory, { withFileTypes: true }).catch((error) => {
    if (isNodeError(error, "ENOENT")) {
      throw new Error(
        "Pi model data is missing; run npm run hydrate:model-data in the configured Pi repository",
      );
    }
    throw error;
  });
  const names = entries
    .filter((entry) => entry.name === ".manifest.json" || /^[a-z0-9-]+\.json$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (!names.includes(".manifest.json") || names.length < 2 || names.length > 128) {
    throw new Error("Pi model data snapshot is incomplete");
  }

  const files: readonly { readonly name: string; readonly contents: Buffer }[] = await Promise.all(
    names.map(async (name) => {
      const path = join(sourceDirectory, name);
      const information = await lstat(path);
      if (
        information.isSymbolicLink() ||
        !information.isFile() ||
        information.size > 8 * 1024 * 1024
      ) {
        throw new Error("Pi model data snapshot contains an invalid file");
      }
      const contents = await readFile(path);
      JSON.parse(contents.toString("utf8"));
      return { name, contents };
    }),
  );

  const existingDestination = await lstat(destinationDirectory).catch((error) => {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  });
  if (existingDestination?.isSymbolicLink()) {
    throw new Error("Pi model data destination must not be a symbolic link");
  }
  await rm(destinationDirectory, { recursive: true, force: true });
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  await Promise.all(
    files.map(({ name, contents }) =>
      writeFile(join(destinationDirectory, name), contents, { mode: 0o600 }),
    ),
  );
  return "copied";
}

async function parseHarborJob(
  input: Parameters<typeof evaluateArm>[0],
  jobName: string,
  jobDirectory: string,
): Promise<LocalRealArmReceipt> {
  const job = asRecord(
    JSON.parse(await readFile(join(jobDirectory, "result.json"), "utf8")) as unknown,
    "Harbor job result",
  );
  const entries = await readdir(jobDirectory, { withFileTypes: true });
  const rawTrials: {
    readonly taskName: string;
    readonly taskRevision: string;
    readonly trialName: string;
    readonly reward: number;
    readonly infrastructureValid: boolean;
    readonly durationMs: number;
    readonly inputTokens: number;
    readonly cacheTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
    readonly resultPath: string;
  }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const resultPath = join(jobDirectory, entry.name, "result.json");
    if (!(await pathExists(resultPath))) continue;
    const trial = asRecord(
      JSON.parse(await readFile(resultPath, "utf8")) as unknown,
      "Harbor trial result",
    );
    const taskIdentity = parseHarborTaskIdentity(trial["task_id"]);
    const verifier = optionalRecord(trial["verifier_result"]);
    const rewards = optionalRecord(verifier?.["rewards"]);
    const agent = optionalRecord(trial["agent_result"]);
    const trialName = trial["trial_name"];
    if (!nonemptyString(trialName)) {
      throw new Error("Harbor trial identity is invalid");
    }
    const selectedTask =
      taskIdentity.kind === "name-ref"
        ? input.tasks.find((task) => task.name === taskIdentity.taskName)
        : input.tasks.find(
            (task) =>
              task.sourcePath === taskIdentity.taskPath &&
              task.sourceRevision === taskIdentity.taskRevision,
          );
    if (selectedTask === undefined) {
      throw new Error("Harbor returned a task outside the selected panel");
    }
    const rewardValue = rewards?.["reward"];
    const infrastructureValid =
      trial["exception_info"] === null &&
      typeof rewardValue === "number" &&
      Number.isFinite(rewardValue);
    rawTrials.push({
      taskName: selectedTask.name,
      taskRevision: taskIdentity.taskRevision,
      trialName,
      reward: typeof rewardValue === "number" && Number.isFinite(rewardValue) ? rewardValue : 0,
      infrastructureValid,
      durationMs: durationBetween(trial["started_at"], trial["finished_at"]),
      inputTokens: nonnegativeNumber(agent?.["n_input_tokens"]),
      cacheTokens: nonnegativeNumber(agent?.["n_cache_tokens"]),
      outputTokens: nonnegativeNumber(agent?.["n_output_tokens"]),
      costUsd: nonnegativeNumber(agent?.["cost_usd"]),
      resultPath,
    });
  }
  if (rawTrials.length !== input.tasks.length * 3) {
    throw new Error("Harbor job did not return three trials for each selected task");
  }
  const observations: LocalRealObservation[] = [];
  for (const task of input.tasks) {
    const trials = rawTrials
      .filter((trial) => trial.taskName === task.name)
      .sort((left, right) => left.trialName.localeCompare(right.trialName));
    if (trials.length !== 3) {
      throw new Error("Harbor task does not contain exactly three trials");
    }
    trials.forEach((trial, index) => {
      observations.push({
        ...trial,
        repetition: (index + 1) as 1 | 2 | 3,
      });
    });
  }
  const startedAt =
    typeof job["started_at"] === "string" ? job["started_at"] : new Date().toISOString();
  const completedAt =
    typeof job["finished_at"] === "string" ? job["finished_at"] : new Date().toISOString();
  return {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    arm: input.arm,
    revision: input.revision,
    runtimeSha256: input.runtime.archiveSha256,
    jobName,
    jobDirectory,
    startedAt,
    completedAt,
    observations,
    costUsd: rounded(observations.reduce((total, observation) => total + observation.costUsd, 0)),
    infrastructureValid: observations.every((observation) => observation.infrastructureValid),
    containsSecrets: false,
  };
}

function localOptimizerArguments(
  optimizer: LocalRealCampaignConfig["optimizer"],
  prompt: string,
): readonly string[] {
  return [
    "--print",
    "--output-format",
    OPTIMIZER_OUTPUT_FORMAT,
    "--verbose",
    ...(OPTIMIZER_SESSION_PERSISTENCE ? [] : ["--no-session-persistence"]),
    ...(OPTIMIZER_BROWSER_ENABLED ? [] : ["--no-chrome"]),
    "--bare",
    "--permission-mode",
    OPTIMIZER_PERMISSION_MODE,
    "--tools",
    OPTIMIZER_ALLOWED_TOOLS.join(","),
    "--allowedTools",
    OPTIMIZER_ALLOWED_TOOLS.join(","),
    "--disallowedTools",
    OPTIMIZER_DISALLOWED_TOOLS.join(","),
    "--model",
    optimizer.deployment,
    "--effort",
    optimizer.effort,
    "--max-budget-usd",
    optimizer.maximumCostUsd.toFixed(2),
    "--max-turns",
    String(optimizer.maximumTurns),
    prompt,
  ];
}

function localOptimizerEnvironment(input: {
  readonly claudeConfig: string;
  readonly resourceName: string;
  readonly optimizerDeployment: string;
  readonly apiKey: string;
}): readonly LocalOptimizerEnvironmentDefinition[] {
  return [
    {
      name: "PATH",
      runtimeValue: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
      disclosedValue: null,
      secret: false,
      description: "Exact host executable search path intentionally omitted.",
    },
    {
      name: "HOME",
      runtimeValue: input.claudeConfig,
      disclosedValue: null,
      secret: false,
      description: "Private optimizer-attempt configuration directory; absolute path omitted.",
    },
    {
      name: "LANG",
      runtimeValue: "C",
      disclosedValue: "C",
      secret: false,
      description: "Deterministic process locale.",
    },
    {
      name: "LC_ALL",
      runtimeValue: "C",
      disclosedValue: "C",
      secret: false,
      description: "Deterministic process locale override.",
    },
    {
      name: "CI",
      runtimeValue: "true",
      disclosedValue: "true",
      secret: false,
      description: "Non-interactive execution marker.",
    },
    {
      name: "CLAUDE_CONFIG_DIR",
      runtimeValue: input.claudeConfig,
      disclosedValue: null,
      secret: false,
      description: "Private optimizer-attempt configuration directory; absolute path omitted.",
    },
    {
      name: "CLAUDE_CODE_SKIP_PROMPT_HISTORY",
      runtimeValue: "1",
      disclosedValue: "1",
      secret: false,
      description: "Prompt history persistence disabled.",
    },
    {
      name: "CLAUDE_CODE_USE_FOUNDRY",
      runtimeValue: "1",
      disclosedValue: "1",
      secret: false,
      description: "Microsoft Foundry provider mode enabled.",
    },
    {
      name: "ANTHROPIC_FOUNDRY_RESOURCE",
      runtimeValue: input.resourceName,
      disclosedValue: input.resourceName,
      secret: false,
      description: "Microsoft Foundry resource identifier.",
    },
    {
      name: "ANTHROPIC_DEFAULT_OPUS_MODEL",
      runtimeValue: input.optimizerDeployment,
      disclosedValue: input.optimizerDeployment,
      secret: false,
      description: "Optimizer deployment identifier.",
    },
    {
      name: "ANTHROPIC_FOUNDRY_API_KEY",
      runtimeValue: input.apiKey,
      disclosedValue: null,
      secret: true,
      description: "Credential is present at runtime and never persisted.",
    },
    {
      name: "DISABLE_TELEMETRY",
      runtimeValue: "1",
      disclosedValue: "1",
      secret: false,
      description: "Claude CLI telemetry disabled.",
    },
  ];
}

function optimizerPrompt(input: {
  readonly experimentId: string;
  readonly experimentNumber: number;
  readonly championRevision: string;
  readonly previousDecision: Parameters<LocalRealRunnerAdapter["optimize"]>[0]["previousDecision"];
}): string {
  return [
    "You are the task-blind optimizer for the Pi terminal coding-agent harness.",
    "Read AGENTS.md first and obey it.",
    "Inspect only the repository source in this isolated candidate worktree.",
    "Do not seek, infer, name, or encode benchmark tasks, task prompts, graders, solutions, expected outputs, or panel membership.",
    "Do not access .git, environment variables, absolute paths outside this worktree, the network, tests, fixtures, examples, benchmark files, or evaluation configuration.",
    "Form exactly one falsifiable, task-independent hypothesis and make one small general harness improvement.",
    "Edit only TypeScript files below packages/agent/src, packages/ai/src, or packages/coding-agent/src.",
    "Do not add dependencies, change lockfiles, invoke commands, or run tests; the runner validates and builds after you return.",
    "Your final response must be exactly one JSON object with exactly these string fields and no markdown: hypothesisId, hypothesisSummary, interventionSummary.",
    "hypothesisId must be lowercase kebab-case. Each summary must explain the general causal mechanism or intervention without task-specific claims.",
    `Experiment: ${input.experimentId}.`,
    `Experiment number: ${input.experimentNumber}.`,
    `Champion revision: ${input.championRevision}.`,
    `Previous task-free decision: ${JSON.stringify(input.previousDecision)}.`,
  ].join("\n");
}

function parseClaudeOptimizerStream(
  stdout: string,
  expectedModel: string,
): {
  readonly costUsd: number;
  readonly turns: number;
  readonly hypothesisId: string;
  readonly hypothesisSummary: string;
  readonly interventionSummary: string;
} {
  let initialized = false;
  let turns = 0;
  let resultPayload: string | null = null;
  let resultCount = 0;
  let costUsd = 0;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const event = asRecord(JSON.parse(line) as unknown, "Claude stream event");
    if (event["type"] === "system" && event["subtype"] === "init") {
      if (event["model"] !== expectedModel) {
        throw new Error("Claude optimizer initialized a different model");
      }
      initialized = true;
    }
    if (event["type"] === "assistant") turns += 1;
    if (event["type"] === "result") {
      resultCount += 1;
      if (event["is_error"] === true || typeof event["result"] !== "string") {
        throw new Error("Claude optimizer returned an error result");
      }
      resultPayload = event["result"];
      if (typeof event["total_cost_usd"] === "number") costUsd = event["total_cost_usd"];
    }
  }
  if (!initialized || turns < 1 || resultCount !== 1 || resultPayload === null) {
    throw new Error("Claude optimizer stream is incomplete");
  }
  const proposal = asRecord(JSON.parse(resultPayload) as unknown, "Claude optimizer proposal");
  const keys = Object.keys(proposal).sort();
  if (
    canonicalJson(keys) !==
      canonicalJson(["hypothesisId", "hypothesisSummary", "interventionSummary"].sort()) ||
    typeof proposal["hypothesisId"] !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(proposal["hypothesisId"]) ||
    typeof proposal["hypothesisSummary"] !== "string" ||
    proposal["hypothesisSummary"].length < 20 ||
    typeof proposal["interventionSummary"] !== "string" ||
    proposal["interventionSummary"].length < 20 ||
    !Number.isFinite(costUsd) ||
    costUsd < 0
  ) {
    throw new Error("Claude optimizer proposal is malformed");
  }
  return {
    costUsd: rounded(costUsd),
    turns,
    hypothesisId: proposal["hypothesisId"],
    hypothesisSummary: proposal["hypothesisSummary"],
    interventionSummary: proposal["interventionSummary"],
  };
}

async function optimizerAttemptDirectories(attemptsDirectory: string): Promise<readonly string[]> {
  const entries = await readdir(attemptsDirectory, { withFileTypes: true });
  const names = entries.map((entry) => {
    if (!entry.isDirectory() || !/^\d{3}$/u.test(entry.name)) {
      throw new Error("Optimizer attempt storage contains an unexpected entry");
    }
    return entry.name;
  });
  names.sort();
  names.forEach((name, index) => {
    if (name !== String(index + 1).padStart(3, "0")) {
      throw new Error("Optimizer attempt storage is not contiguous");
    }
  });
  return names.map((name) => join(attemptsDirectory, name));
}

async function optimizerReceiptFromAttempt(input: {
  readonly input: Parameters<LocalRealRunnerAdapter["optimize"]>[0];
  readonly worktree: string;
  readonly attemptDirectory: string;
  readonly invocation: LocalOptimizerInvocation;
  readonly parsed: ReturnType<typeof parseClaudeOptimizerStream>;
}): Promise<LocalRealOptimizerReceipt> {
  if (
    input.invocation.schemaVersion !== LOCAL_REAL_SCHEMA_VERSION ||
    input.invocation.experimentId !== input.input.experimentId ||
    input.invocation.championRevision !== input.input.state.championRevision ||
    !Number.isSafeInteger(input.invocation.attemptOrdinal) ||
    input.invocation.attemptOrdinal < 1 ||
    !Number.isFinite(Date.parse(input.invocation.startedAt))
  ) {
    throw new Error("Optimizer invocation checkpoint is invalid");
  }
  const transcriptPath = join(input.attemptDirectory, "transcript.jsonl");
  const transcriptInformation = await stat(transcriptPath);
  return {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    experimentId: input.input.experimentId,
    championRevision: input.input.state.championRevision,
    worktree: input.worktree,
    transcriptPath: relativeArtifact(input.input.experimentDirectory, transcriptPath),
    stderrPath: relativeArtifact(
      input.input.experimentDirectory,
      join(input.attemptDirectory, "stderr.log"),
    ),
    startedAt: input.invocation.startedAt,
    completedAt: new Date(transcriptInformation.mtimeMs).toISOString(),
    model: "claude-opus-5",
    costUsd: input.parsed.costUsd,
    turns: input.parsed.turns,
    hypothesisId: input.parsed.hypothesisId,
    hypothesisSummary: input.parsed.hypothesisSummary,
    interventionSummary: input.parsed.interventionSummary,
    containsTaskInformation: false,
    containsSecrets: false,
  };
}

async function recreateDetachedWorktree(input: {
  readonly repository: string;
  readonly worktree: string;
  readonly revision: string;
  readonly expectedParent: string;
  readonly logPrefix: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  if (dirname(resolve(input.worktree)) !== resolve(input.expectedParent)) {
    throw new Error("Runner refused to recreate a worktree outside its campaign");
  }
  if (await pathExists(input.worktree)) {
    await gitChecked(
      input.repository,
      ["worktree", "remove", "--force", input.worktree],
      `${input.logPrefix}-remove`,
      { signal: input.signal },
    );
  }
  await ensureDetachedWorktree(
    input.repository,
    input.worktree,
    input.revision,
    `${input.logPrefix}-add`,
    input.signal,
  );
}

async function invalidCandidate(input: {
  readonly input: Parameters<typeof validateAndBuild>[0];
  readonly changedFiles: readonly string[];
  readonly reason: string;
  readonly validationCommands: LocalRealCandidateReceipt["validationCommands"];
}): Promise<LocalRealCandidateReceipt> {
  const candidateDirectory = join(input.input.experimentDirectory, "candidate");
  const patchResult = await gitChecked(
    input.input.optimizer.worktree,
    ["diff", "--binary", "--full-index", "HEAD"],
    join(candidateDirectory, "git-invalid-diff"),
    {
      maximumOutputBytes: MAXIMUM_CANDIDATE_DIFF_BYTES + 1,
      signal: input.input.signal,
    },
  ).catch(() => ({ stdout: "" }));
  const patchPath = join(candidateDirectory, "candidate.patch");
  await writeFile(patchPath, patchResult.stdout, { encoding: "utf8", mode: 0o600 });
  const tree = (
    await gitChecked(
      input.input.optimizer.worktree,
      ["rev-parse", "HEAD^{tree}"],
      join(candidateDirectory, "git-invalid-tree"),
      { signal: input.input.signal },
    )
  ).stdout.trim();
  return candidateReceipt({
    input: input.input,
    tree,
    changedFiles: input.changedFiles,
    patchPath,
    patch: patchResult.stdout,
    validationCommands: input.validationCommands,
    valid: false,
    invalidReason: input.reason,
    runtime: null,
  });
}

function candidateReceipt(input: {
  readonly input: Parameters<typeof validateAndBuild>[0];
  readonly tree: string;
  readonly changedFiles: readonly string[];
  readonly patchPath: string;
  readonly patch: string;
  readonly patchSha256?: string;
  readonly validationCommands: LocalRealCandidateReceipt["validationCommands"];
  readonly valid: boolean;
  readonly invalidReason: string | null;
  readonly runtime: LocalRealRuntime | null;
}): LocalRealCandidateReceipt {
  return {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    experimentId: input.input.experimentId,
    parentRevision: input.input.optimizer.championRevision,
    tree: input.tree,
    changedFiles: input.changedFiles,
    patchPath: relativeArtifact(input.input.experimentDirectory, input.patchPath),
    patchSha256: input.patchSha256 ?? sha256(input.patch),
    runtimeArchive: input.runtime?.archivePath ?? null,
    runtimeSha256: input.runtime?.archiveSha256 ?? null,
    piEntrypoint: input.runtime?.piEntrypoint ?? null,
    validationCommands: input.validationCommands,
    valid: input.valid,
    invalidReason: input.invalidReason,
    containsSecrets: false,
  };
}

async function candidateChangedFiles(
  worktree: string,
  logPrefix: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const [tracked, untracked] = await Promise.all([
    gitChecked(worktree, ["diff", "--name-only", "-z", "HEAD"], `${logPrefix}-tracked`, {
      signal,
    }),
    gitChecked(
      worktree,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      `${logPrefix}-untracked`,
      { signal },
    ),
  ]);
  return [...new Set([...nulList(tracked.stdout), ...nulList(untracked.stdout)])].sort();
}

function candidatePathError(paths: readonly string[]): string | null {
  if (paths.length < 1) return "candidate-has-no-change";
  if (paths.length > MAXIMUM_CANDIDATE_FILES) return "candidate-changed-too-many-files";
  for (const path of paths) {
    const finalDot = path.lastIndexOf(".");
    const extension = finalDot < 0 ? "" : path.slice(finalDot);
    if (
      path.startsWith("/") ||
      path.includes("\0") ||
      path === ".." ||
      path.startsWith("../") ||
      path.includes("/../") ||
      !ALLOWED_CANDIDATE_ROOTS.some((root) => path.startsWith(root)) ||
      !ALLOWED_CANDIDATE_EXTENSIONS.has(extension)
    ) {
      return "candidate-changed-protected-path";
    }
  }
  return null;
}

async function ensureDetachedWorktree(
  repository: string,
  worktree: string,
  revision: string,
  logPrefix: string,
  signal?: AbortSignal,
): Promise<void> {
  if (await pathExists(worktree)) {
    const [top, head, branch] = await Promise.all([
      gitChecked(worktree, ["rev-parse", "--show-toplevel"], `${logPrefix}-top`, { signal }),
      gitChecked(worktree, ["rev-parse", "HEAD^{commit}"], `${logPrefix}-head`, { signal }),
      gitChecked(worktree, ["rev-parse", "--abbrev-ref", "HEAD"], `${logPrefix}-branch`, {
        signal,
      }),
    ]);
    if (
      resolve(top.stdout.trim()) !== resolve(worktree) ||
      head.stdout.trim() !== revision ||
      branch.stdout.trim() !== "HEAD"
    ) {
      throw new Error("Existing runner worktree does not match its sealed revision");
    }
    return;
  }
  await mkdir(dirname(worktree), { recursive: true, mode: 0o700 });
  await gitChecked(
    repository,
    ["worktree", "add", "--detach", worktree, revision],
    `${logPrefix}-add`,
    { signal },
  );
}

async function ensureCommitAvailable(
  config: LocalRealCampaignConfig,
  revision: string,
  campaignDirectory: string,
  signal?: AbortSignal,
): Promise<void> {
  const probe = await runLocalProcess({
    executable: "git",
    arguments: ["cat-file", "-e", `${revision}^{commit}`],
    workingDirectory: config.piRepository,
    timeoutMs: 30_000,
    stdoutPath: join(campaignDirectory, "git", `probe-${revision}.stdout.log`),
    stderrPath: join(campaignDirectory, "git", `probe-${revision}.stderr.log`),
    ...(signal === undefined ? {} : { signal }),
  });
  if (probe.exitCode === 0) return;
  await assertConfiguredPiRemote(
    config,
    config.piRepository,
    join(campaignDirectory, "git", `remote-${revision}`),
    signal,
  );
  await gitChecked(
    config.piRepository,
    [
      "fetch",
      "--no-tags",
      config.publication.remoteName,
      `refs/heads/df/champion/${config.campaignId}:refs/dark-factory/champions/${config.campaignId}`,
    ],
    join(campaignDirectory, "git", `fetch-${revision}`),
    { signal },
  );
  await gitChecked(
    config.piRepository,
    ["cat-file", "-e", `${revision}^{commit}`],
    join(campaignDirectory, "git", `verify-${revision}`),
    { signal },
  );
}

async function assertConfiguredPiRemote(
  config: LocalRealCampaignConfig,
  workingDirectory: string,
  logPrefix: string,
  signal?: AbortSignal,
): Promise<void> {
  const remote = await gitChecked(
    workingDirectory,
    ["remote", "get-url", config.publication.remoteName],
    logPrefix,
    { signal },
  );
  if (remote.stdout.trim() !== config.piOrigin) {
    throw new Error("Pi publication remote changed after campaign initialization");
  }
}

async function gitChecked(
  workingDirectory: string,
  arguments_: readonly string[],
  logPrefix: string,
  options: {
    readonly maximumOutputBytes?: number;
    readonly signal?: AbortSignal | undefined;
  } = {},
) {
  return runLocalProcessChecked({
    executable: "git",
    arguments: arguments_,
    workingDirectory,
    environment: {
      ...developmentEnvironment(),
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
    inheritEnvironment: false,
    timeoutMs: 5 * 60_000,
    maximumOutputBytes: options.maximumOutputBytes ?? 16 * 1024 * 1024,
    stdoutPath: `${logPrefix}.stdout.log`,
    stderrPath: `${logPrefix}.stderr.log`,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

/**
 * Keep the Node binary that launched the runner ahead of host PATH entries and
 * remove Volta's HOME-dependent shims. Candidate tests replace HOME with an
 * isolated directory; a Volta package-manager shim cannot resolve its tool
 * inventory there and can recursively invoke itself while probing `pnpm`.
 */
export function localValidationPath(
  hostPath: string | undefined = process.env.PATH,
  nodeExecutable: string = process.execPath,
): string {
  const nodeBin = dirname(resolve(nodeExecutable));
  const entries = (hostPath ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .filter((entry) => resolve(entry) !== nodeBin)
    .filter((entry) => !entry.replaceAll("\\", "/").endsWith("/.volta/bin"));
  return [nodeBin, ...entries].join(delimiter);
}

function developmentEnvironment(): Readonly<Record<string, string>> {
  return {
    PATH: localValidationPath(),
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "C",
    LC_ALL: "C",
    CI: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
}

function campaignDirectoryFromExperiment(experimentDirectory: string): string {
  const experimentsDirectory = dirname(resolve(experimentDirectory));
  if (experimentsDirectory.split(sep).at(-1) !== "experiments") {
    throw new Error("Local real experiment directory is outside its campaign layout");
  }
  return dirname(experimentsDirectory);
}

function relativeArtifact(experimentDirectory: string, path: string): string {
  const relativePath = relative(experimentDirectory, path).split(sep).join("/");
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.includes("\0")
  ) {
    throw new Error("Local real artifact path escapes its experiment");
  }
  return relativePath;
}

function nulList(value: string): readonly string[] {
  return value.split("\0").filter((item) => item.length > 0);
}

function durationBetween(startedAt: unknown, finishedAt: unknown): number {
  if (typeof startedAt !== "string" || typeof finishedAt !== "string") return 0;
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return 0;
  return Math.round(finish - start);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonnegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function asRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function optionalRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const information = await lstat(path);
    return information.isFile() || information.isDirectory();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function redactCredentialLogs(
  stdoutPath: string,
  stderrPath: string,
  credential: string,
): Promise<void> {
  await Promise.all([
    redactCredentialFile(stdoutPath, credential),
    redactCredentialFile(stderrPath, credential),
  ]);
}

async function redactCredentialTree(root: string, credential: string): Promise<void> {
  const pending = [root];
  let files = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined) break;
    const information = await lstat(path);
    if (information.isSymbolicLink()) {
      throw new Error("Harbor credential scan encountered a symbolic link");
    }
    if (information.isDirectory()) {
      const entries = await readdir(path);
      entries.sort().reverse();
      entries.forEach((entry) => {
        pending.push(join(path, entry));
      });
      continue;
    }
    if (!information.isFile()) {
      throw new Error("Harbor credential scan encountered a special file");
    }
    files += 1;
    totalBytes += information.size;
    if (
      files > MAXIMUM_CREDENTIAL_SCAN_FILES ||
      information.size > MAXIMUM_CREDENTIAL_SCAN_FILE_BYTES ||
      totalBytes > MAXIMUM_CREDENTIAL_SCAN_TOTAL_BYTES
    ) {
      throw new Error("Harbor credential scan exceeded its safety bounds");
    }
    await redactCredentialFile(path, credential);
  }
}

async function redactCredentialFile(path: string, credential: string): Promise<boolean> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
  const secret = Buffer.from(credential);
  if (secret.length === 0 || bytes.indexOf(secret) < 0) return false;
  const replacement = Buffer.from("[REDACTED]");
  const chunks: Buffer[] = [];
  let offset = 0;
  while (true) {
    const index = bytes.indexOf(secret, offset);
    if (index < 0) break;
    chunks.push(bytes.subarray(offset, index), replacement);
    offset = index + secret.length;
  }
  chunks.push(bytes.subarray(offset));
  await writeFile(path, Buffer.concat(chunks), { mode: 0o600 });
  return true;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
