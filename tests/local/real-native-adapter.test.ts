import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  LOCAL_REAL_EVALUATION_CONCURRENCY,
  LOCAL_REAL_OBSERVATIONS_PER_ARM,
  LOCAL_REAL_REPETITIONS,
  LOCAL_REAL_SCHEMA_VERSION,
  LOCAL_REAL_TASKS_PER_PANEL,
  type LocalRealCampaignConfig,
  type LocalRealCampaignState,
  type LocalRealDecision,
  type LocalRealOptimizerReceipt,
  type LocalRealRuntime,
  type LocalRealTask,
} from "../../src/local/real/contracts.js";
import {
  createNativeLocalRealAdapter,
  localCandidateWorktreeDirectory,
  localHarborJobConfiguration,
  localLinuxExecutionTarget,
  localPiCandidateValidationCommands,
  localPiRepositoryPreparationCommands,
  localPiRuntimeCacheDirectory,
  localValidationPath,
  parseHarborTaskIdentity,
  prepareDetachedPiModelData,
  stageCandidateRuntimeBuildLogs,
} from "../../src/local/real/native-adapter.js";
import { LocalProcessAbortedError } from "../../src/local/real/process.js";

const temporaryDirectories: string[] = [];
const execute = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("native local real adapter cancellation", () => {
  it("propagates a cancelled signal into champion Git setup", async () => {
    const fixture = await adapterFixture();
    const controller = new AbortController();
    controller.abort();

    await expect(
      createNativeLocalRealAdapter().ensureChampionRuntime(
        fixture.config,
        fixture.state,
        fixture.experimentDirectory,
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(LocalProcessAbortedError);
  });

  it("propagates a cancelled signal into candidate Git validation", async () => {
    const fixture = await adapterFixture();
    const worktree = join(fixture.root, "candidate-worktree");
    await mkdir(worktree, { recursive: true });
    const optimizer: LocalRealOptimizerReceipt = {
      schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
      experimentId: "000001-optimization",
      championRevision: fixture.state.championRevision,
      worktree,
      transcriptPath: "optimizer/transcript.jsonl",
      stderrPath: "optimizer/stderr.log",
      startedAt: fixture.config.createdAt,
      completedAt: fixture.config.createdAt,
      model: "claude-opus-5",
      costUsd: 1,
      turns: 1,
      hypothesisId: "cancel-git-validation",
      hypothesisSummary: "Cancel candidate Git validation immediately",
      interventionSummary: "Thread the active cancellation signal through Git",
      containsTaskInformation: false,
      containsSecrets: false,
    };
    const controller = new AbortController();
    controller.abort();

    await expect(
      createNativeLocalRealAdapter().validateAndBuild({
        config: fixture.config,
        experimentId: "000001-optimization",
        experimentDirectory: fixture.experimentDirectory,
        optimizer,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(LocalProcessAbortedError);
  });
});

describe("native local real optimizer execution audit", () => {
  it("persists the exact prompt and a sanitized execution contract without the API key", async () => {
    const fixture = await optimizerAuditFixture();
    const previousDecision: LocalRealDecision = {
      schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
      experimentId: "000000-optimization",
      disposition: "reject",
      reason: "aggregate-effect-too-small",
      candidateMeanReward: 0.4,
      championMeanReward: 0.42,
      meanRewardDelta: -0.02,
      taskWins: 1,
      taskLosses: 2,
      taskTies: 2,
      confidenceCandidateBetter: 0.2,
      minimumAggregateDelta: 0.05,
      requiredConfidence: 0.95,
      decidedAt: fixture.config.createdAt,
      containsSecrets: false,
    };

    await createNativeLocalRealAdapter().optimize({
      config: fixture.config,
      state: fixture.state,
      experimentId: "000001-optimization",
      experimentDirectory: fixture.experimentDirectory,
      previousDecision,
    });

    const attemptDirectory = join(fixture.experimentDirectory, "optimizer", "attempts", "001");
    const rawInput = await readFile(join(attemptDirectory, "input.json"), "utf8");
    const optimizerInput = JSON.parse(rawInput) as Record<string, unknown>;
    const capturedInvocation = JSON.parse(
      await readFile(join(attemptDirectory, "claude-config", "captured-invocation.json"), "utf8"),
    ) as {
      readonly arguments: readonly string[];
      readonly promptSha256: string;
      readonly environmentNames: readonly string[];
      readonly apiKeyPresent: boolean;
    };
    const prompt = optimizerInput["prompt"];
    const environment = optimizerInput["environment"] as readonly {
      readonly name: string;
      readonly value: string | null;
      readonly secret: boolean;
    }[];

    expect(prompt).toEqual(expect.any(String));
    expect(optimizerInput["previousDecision"]).toEqual(previousDecision);
    expect(optimizerInput["promptSha256"]).toBe(
      createHash("sha256")
        .update(prompt as string)
        .digest("hex"),
    );
    expect(capturedInvocation.promptSha256).toBe(optimizerInput["promptSha256"]);
    expect(optimizerInput["executionContract"]).toEqual({
      model: "claude-opus-5",
      effort: "high",
      maximumCostUsd: 1,
      maximumTurns: 1,
      timeoutMs: 1_000,
      outputFormat: "stream-json",
      permissionMode: "dontAsk",
      sessionPersistence: false,
      browserEnabled: false,
      allowedTools: ["Read", "Edit", "Write", "Grep", "Glob"],
      disallowedTools: ["Bash", "Shell", "WebSearch", "WebFetch", "Agent", "Task", "NotebookEdit"],
      shellEnabled: false,
      networkToolsEnabled: false,
    });
    expect(capturedInvocation.arguments).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--no-chrome",
      "--bare",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Edit,Write,Grep,Glob",
      "--allowedTools",
      "Read,Edit,Write,Grep,Glob",
      "--disallowedTools",
      "Bash,Shell,WebSearch,WebFetch,Agent,Task,NotebookEdit",
      "--model",
      "claude-opus-5",
      "--effort",
      "high",
      "--max-budget-usd",
      "1.00",
      "--max-turns",
      "1",
    ]);
    expect(capturedInvocation.environmentNames).toEqual(
      expect.arrayContaining(environment.map(({ name }) => name)),
    );
    expect(capturedInvocation.apiKeyPresent).toBe(true);
    expect(environment.find(({ name }) => name === "ANTHROPIC_FOUNDRY_API_KEY")).toMatchObject({
      value: null,
      secret: true,
    });
    for (const name of ["PATH", "HOME", "CLAUDE_CONFIG_DIR"]) {
      expect(environment.find((entry) => entry.name === name)?.value).toBeNull();
    }
    expect(optimizerInput["sourceContext"]).toMatchObject({
      kind: "detached-champion-worktree",
      championRevision: fixture.state.championRevision,
      candidateTree: fixture.candidateTree,
      editableRoots: ["packages/agent/src/", "packages/ai/src/", "packages/coding-agent/src/"],
      instructionFiles: ["AGENTS.md"],
      instructionFileSha256: {
        "AGENTS.md": fixture.agentsSha256,
      },
    });
    expect(rawInput).not.toContain(fixture.apiKey);
  });
});

describe("native local real adapter runtime preparation", () => {
  it("selects native ARM Linux execution on ARM hosts and x64 elsewhere", () => {
    expect(localLinuxExecutionTarget("arm64")).toEqual({
      piPlatform: "linux-arm64",
      dockerPlatform: "linux/arm64",
    });
    expect(localLinuxExecutionTarget("x64")).toEqual({
      piPlatform: "linux-x64",
      dockerPlatform: "linux/amd64",
    });
    expect(localLinuxExecutionTarget("riscv64")).toEqual({
      piPlatform: "linux-x64",
      dockerPlatform: "linux/amd64",
    });
  });

  it("isolates runtime caches by target architecture", () => {
    const campaignDirectory = join("/campaigns", "test-run-2");
    const revision = "a".repeat(40);

    expect(localPiRuntimeCacheDirectory(campaignDirectory, revision, "arm64")).toBe(
      join(campaignDirectory, "runtimes", revision, "linux-arm64"),
    );
    expect(localPiRuntimeCacheDirectory(campaignDirectory, revision, "x64")).toBe(
      join(campaignDirectory, "runtimes", revision, "linux-x64"),
    );
  });

  it("uses a compact durable candidate worktree name", () => {
    const campaignDirectory = join("/state", "real", "campaigns", "test-run-2");

    expect(
      localCandidateWorktreeDirectory(campaignDirectory, "000123-optimization"),
    ).toBe(join(campaignDirectory, "worktrees", "c-000123"));
    expect(() =>
      localCandidateWorktreeDirectory(campaignDirectory, "../candidate"),
    ).toThrow("Candidate experiment identity is invalid");
  });

  it("does not gate baseline runtime creation on a repository-wide check", () => {
    const commands = localPiRepositoryPreparationCommands();

    expect(commands.map((command) => command.label)).toContain("npm-ci");
    expect(commands.map((command) => command.label)).not.toContain("npm-run-check");
    expect(
      commands.some(
        (command) => command.executable === "npm" && command.arguments.join(" ") === "run check",
      ),
    ).toBe(false);
  });

  it("builds workspace package exports before running candidate tests", () => {
    const commands = localPiCandidateValidationCommands([
      "packages/agent/src/harness/tools/edit-diff.ts",
      "packages/coding-agent/src/core/example.ts",
    ]);
    const labels = commands.map((command) => command.label);

    expect(labels).toEqual([
      "npm-ci",
      "npm-run-check-model-data",
      "npm-run-check",
      "npm-run-build-offline",
      "npm-test-agent",
      "npm-test-coding-agent",
    ]);
    expect(labels.indexOf("npm-run-build-offline")).toBeLessThan(labels.indexOf("npm-test-agent"));
    expect(commands.some((command) => command.executable === "./test.sh")).toBe(false);
  });

  it("keeps the active Node toolchain and removes HOME-dependent Volta shims", () => {
    const nodeExecutable = join("/runtime", "node", "bin", "node");
    const nodeBin = dirname(nodeExecutable);
    const voltaBin = join("/Users", "runner", ".volta", "bin");
    const hostPath = [voltaBin, "/usr/local/bin", nodeBin, voltaBin, "/usr/bin"].join(delimiter);

    expect(localValidationPath(hostPath, nodeExecutable).split(delimiter)).toEqual([
      nodeBin,
      "/usr/local/bin",
      "/usr/bin",
    ]);
  });

  it("stages runtime build logs inside the experiment artifact boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-runtime-build-logs-"));
    temporaryDirectories.push(root);
    const experimentDirectory = join(root, "campaign", "experiments", "000001-optimization");
    const runtimeDirectory = join(root, "campaign", "runtimes", "candidate-tree", "linux-arm64");
    await Promise.all([
      mkdir(join(experimentDirectory, "candidate"), { recursive: true }),
      mkdir(runtimeDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(runtimeDirectory, "build.stdout.log"), "runtime build passed\n"),
      writeFile(join(runtimeDirectory, "build.stderr.log"), "build warning\n"),
    ]);

    await expect(
      stageCandidateRuntimeBuildLogs(experimentDirectory, runtimeDirectory),
    ).resolves.toBe("candidate/runtime-build.stdout.log");
    await expect(
      readFile(join(experimentDirectory, "candidate", "runtime-build.stdout.log"), "utf8"),
    ).resolves.toBe("runtime build passed\n");
    await expect(
      readFile(join(experimentDirectory, "candidate", "runtime-build.stderr.log"), "utf8"),
    ).resolves.toBe("build warning\n");
  });

  it("copies the hydrated model-data bytes and replaces a stale destination snapshot", async () => {
    const fixture = await modelDataFixture();
    const manifest = Buffer.from(
      '{\n  "schemaVersion": 3,\n  "files": {"anthropic.json": "fixed-digest"}\n}\n',
    );
    const provider = Buffer.from(
      '{"messages":{"claude-test":{"id":"claude-test","provider":"anthropic"}}}\n',
    );
    await Promise.all([
      writeFile(join(fixture.sourceData, ".manifest.json"), manifest),
      writeFile(join(fixture.sourceData, "anthropic.json"), provider),
      writeFile(join(fixture.destinationData, ".manifest.json"), '{"stale":true}\n'),
      writeFile(join(fixture.destinationData, "stale.json"), '{"stale":true}\n'),
    ]);

    await expect(
      prepareDetachedPiModelData({
        sourceRepository: fixture.sourceRepository,
        worktree: fixture.worktree,
      }),
    ).resolves.toBe("copied");

    expect(await readFile(join(fixture.destinationData, ".manifest.json"))).toEqual(manifest);
    expect(await readFile(join(fixture.destinationData, "anthropic.json"))).toEqual(provider);
    expect((await readdir(fixture.destinationData)).sort()).toEqual([
      ".manifest.json",
      "anthropic.json",
    ]);
  });

  it("rejects a symbolic-link model-data shard", async () => {
    const fixture = await modelDataFixture();
    const externalShard = join(fixture.root, "outside.json");
    await Promise.all([
      writeFile(join(fixture.sourceData, ".manifest.json"), '{"schemaVersion":3}\n'),
      writeFile(externalShard, '{"messages":{}}\n'),
    ]);
    await symlink(externalShard, join(fixture.sourceData, "anthropic.json"));

    await expect(
      prepareDetachedPiModelData({
        sourceRepository: fixture.sourceRepository,
        worktree: fixture.worktree,
      }),
    ).rejects.toThrow("Pi model data snapshot contains an invalid file");
  });

  it("reports a missing canonical model-data snapshot without touching the worktree", async () => {
    const fixture = await modelDataFixture({ createSourceData: false });
    const stale = Buffer.from('{"preserved":true}\n');
    await writeFile(join(fixture.destinationData, "preserved.json"), stale);

    await expect(
      prepareDetachedPiModelData({
        sourceRepository: fixture.sourceRepository,
        worktree: fixture.worktree,
      }),
    ).rejects.toThrow(
      "Pi model data is missing; run npm run hydrate:model-data in the configured Pi repository",
    );
    expect(await readFile(join(fixture.destinationData, "preserved.json"))).toEqual(stale);
  });
});

describe("native local real Harbor scheduling", () => {
  it("accepts both Harbor task identity formats with strict string fields", () => {
    expect(
      parseHarborTaskIdentity({
        name: "terminal-bench/regex-chess",
        ref: "a".repeat(40),
      }),
    ).toEqual({
      kind: "name-ref",
      taskName: "regex-chess",
      taskRevision: "a".repeat(40),
    });
    expect(
      parseHarborTaskIdentity({
        git_url: "https://github.com/laude-institute/terminal-bench-datasets.git",
        git_commit_id: "b".repeat(40),
        path: "tasks/regex-chess",
      }),
    ).toEqual({
      kind: "git-path",
      taskPath: "tasks/regex-chess",
      taskRevision: "b".repeat(40),
    });
    expect(() => parseHarborTaskIdentity({ path: "tasks/regex-chess" })).toThrow(
      "Harbor trial identity is invalid",
    );
    expect(() =>
      parseHarborTaskIdentity({
        git_commit_id: "b".repeat(40),
        path: 42,
      }),
    ).toThrow("Harbor trial identity is invalid");
    expect(() =>
      parseHarborTaskIdentity({
        git_commit_id: "b".repeat(40),
        path: "",
      }),
    ).toThrow("Harbor trial identity is invalid");
  });

  it("generates a fixed pool of five workers for the fifteen-trial panel", async () => {
    const fixture = await adapterFixture();
    const tasks: LocalRealTask[] = Array.from(
      { length: LOCAL_REAL_TASKS_PER_PANEL },
      (_, index) => ({
        name: `task-${index + 1}`,
        difficulty: "hard",
        sourceRepository: "https://github.com/laude-institute/terminal-bench-datasets.git",
        sourceRevision: "b".repeat(40),
        sourcePath: `task-${index + 1}`,
        empiricalFailureRate: 0.5,
        selections: 0,
      }),
    );
    const runtime: LocalRealRuntime = {
      revision: fixture.state.championRevision,
      tree: "c".repeat(40),
      archivePath: join(fixture.root, "pi-linux-x64.tar.gz"),
      archiveSha256: "d".repeat(64),
      piEntrypoint: "pi/pi",
    };

    const generated = localHarborJobConfiguration({
      config: fixture.config,
      jobName: "df-test-panel",
      jobsDirectory: join(fixture.root, "harbor"),
      registryPath: join(fixture.root, "registry.json"),
      runtime,
      tasks,
    });
    const taskCount = generated.datasets[0]?.task_names.length ?? 0;

    expect(LOCAL_REAL_EVALUATION_CONCURRENCY).toBe(5);
    expect(generated.n_concurrent_trials).toBe(5);
    expect(generated.n_attempts).toBe(LOCAL_REAL_REPETITIONS);
    expect(generated.environment).toEqual({ force_build: true });
    expect(taskCount).toBe(LOCAL_REAL_TASKS_PER_PANEL);
    expect(generated.n_attempts * taskCount).toBe(LOCAL_REAL_OBSERVATIONS_PER_ARM);
  });
});

async function modelDataFixture(options: { readonly createSourceData?: boolean } = {}): Promise<{
  readonly root: string;
  readonly sourceRepository: string;
  readonly sourceData: string;
  readonly worktree: string;
  readonly destinationData: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "df-real-model-data-"));
  temporaryDirectories.push(root);
  const sourceRepository = join(root, "source");
  const sourceData = join(sourceRepository, "packages", "ai", "src", "providers", "data");
  const worktree = join(root, "worktree");
  const destinationData = join(worktree, "packages", "ai", "src", "providers", "data");
  await Promise.all([
    mkdir(sourceRepository, { recursive: true, mode: 0o700 }),
    mkdir(destinationData, { recursive: true, mode: 0o700 }),
    ...(options.createSourceData === false
      ? []
      : [mkdir(sourceData, { recursive: true, mode: 0o700 })]),
  ]);
  return { root, sourceRepository, sourceData, worktree, destinationData };
}

async function adapterFixture(): Promise<{
  readonly root: string;
  readonly experimentDirectory: string;
  readonly config: LocalRealCampaignConfig;
  readonly state: LocalRealCampaignState;
}> {
  const root = await mkdtemp(join(tmpdir(), "df-real-native-adapter-"));
  temporaryDirectories.push(root);
  const experimentDirectory = join(root, "campaign", "experiments", "000001-optimization");
  await mkdir(experimentDirectory, { recursive: true, mode: 0o700 });
  const timestamp = "2026-07-27T10:00:00.000Z";
  const revision = "a".repeat(40);
  const config: LocalRealCampaignConfig = {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    campaignId: "cancel-campaign",
    createdAt: timestamp,
    piRepository: root,
    piOrigin: "git@github.com:parallaxai/df-pi-tbench.git",
    baselineRevision: revision,
    credentialsFile: join(root, "foundry.env"),
    claudeExecutable: join(root, "claude"),
    optimizer: {
      provider: "microsoft-foundry",
      baseUrl: "https://example.invalid",
      resourceName: "example",
      deployment: "claude-opus-5",
      effort: "high",
      maximumCostUsd: 1,
      maximumTurns: 1,
      timeoutMs: 1_000,
    },
    evaluatedAgent: {
      provider: "microsoft-foundry",
      deployment: "claude-opus-4-8",
      thinking: "high",
    },
    evaluation: {
      harborVersion: "0.20.0",
      datasetName: "terminal-bench",
      datasetVersion: "2.0",
      concurrency: LOCAL_REAL_EVALUATION_CONCURRENCY,
      maximumPanelAttempts: 2,
      maximumInfrastructureRetries: 1,
    },
    budget: {
      maximumCampaignCostUsd: 10,
      explicitlyUnbounded: false,
    },
    publication: {
      enabled: true,
      remoteName: "origin",
    },
    containsSecrets: false,
  };
  const state: LocalRealCampaignState = {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    campaignId: config.campaignId,
    revision: 0,
    status: "running",
    championRevision: revision,
    nextExperimentNumber: 1,
    activeExperiment: null,
    retainedPanel: null,
    saturationHistory: [],
    completedExperiments: 0,
    promotions: 0,
    totalCostUsd: 0,
    costLedger: [],
    consecutiveInfrastructureFailures: 0,
    stopReason: null,
    blockedReason: null,
    updatedAt: timestamp,
    containsSecrets: false,
  };
  return { root, experimentDirectory, config, state };
}

async function optimizerAuditFixture(): Promise<{
  readonly root: string;
  readonly experimentDirectory: string;
  readonly config: LocalRealCampaignConfig;
  readonly state: LocalRealCampaignState;
  readonly apiKey: string;
  readonly candidateTree: string;
  readonly agentsSha256: string;
}> {
  const fixture = await adapterFixture();
  const piRepository = join(fixture.root, "pi");
  const agentsContents = "# Optimizer instructions\n\nKeep changes small and task-independent.\n";
  await mkdir(piRepository, { recursive: true, mode: 0o700 });
  await writeFile(join(piRepository, "AGENTS.md"), agentsContents, "utf8");
  await execute("git", ["init", "--quiet"], { cwd: piRepository });
  await execute("git", ["config", "user.name", "Dark Factory Test"], { cwd: piRepository });
  await execute("git", ["config", "user.email", "dark-factory@example.invalid"], {
    cwd: piRepository,
  });
  await execute("git", ["add", "AGENTS.md"], { cwd: piRepository });
  await execute("git", ["commit", "--quiet", "-m", "test baseline"], { cwd: piRepository });
  const revision = (
    await execute("git", ["rev-parse", "HEAD^{commit}"], { cwd: piRepository })
  ).stdout.trim();
  const candidateTree = (
    await execute("git", ["rev-parse", "HEAD^{tree}"], { cwd: piRepository })
  ).stdout.trim();

  const apiKey = "optimizer-test-secret-that-must-not-persist";
  const credentialsFile = join(fixture.root, "foundry.env");
  await writeFile(
    credentialsFile,
    [
      "DF_FOUNDRY_BASE_URL=https://optimizer-audit.services.ai.azure.com/anthropic",
      "DF_OPTIMIZER_DEPLOYMENT=claude-opus-5",
      "DF_EVALUATED_DEPLOYMENT=claude-opus-4-8",
      `ANTHROPIC_FOUNDRY_API_KEY=${apiKey}`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(credentialsFile, 0o600);

  const claudeExecutable = join(fixture.root, "claude-mock.cjs");
  await writeFile(
    claudeExecutable,
    `#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
fs.writeFileSync(
  path.join(process.env.HOME, "captured-invocation.json"),
  JSON.stringify({
    arguments: args.slice(0, -1),
    promptSha256: crypto.createHash("sha256").update(prompt).digest("hex"),
    environmentNames: Object.keys(process.env).sort(),
    apiKeyPresent: typeof process.env.ANTHROPIC_FOUNDRY_API_KEY === "string",
  }),
);
const proposal = JSON.stringify({
  hypothesisId: "persist-execution-contract",
  hypothesisSummary: "Explicit execution contracts improve optimizer audit reproducibility.",
  interventionSummary: "Persist a sanitized manifest beside each optimizer attempt.",
});
for (const event of [
  { type: "system", subtype: "init", model: "claude-opus-5" },
  { type: "assistant" },
  { type: "result", is_error: false, result: proposal, total_cost_usd: 0.01 },
]) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}
`,
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(claudeExecutable, 0o700);

  return {
    ...fixture,
    config: {
      ...fixture.config,
      piRepository,
      baselineRevision: revision,
      credentialsFile,
      claudeExecutable,
    },
    state: {
      ...fixture.state,
      championRevision: revision,
    },
    apiKey,
    candidateTree,
    agentsSha256: createHash("sha256").update(agentsContents).digest("hex"),
  };
}
