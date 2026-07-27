import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getDashboardCampaign,
  getDashboardExperiment,
  listDashboardArtifacts,
  listDashboardTaskLogs,
  readDashboardArtifactChunk,
  readDashboardTaskLogChunk,
} from "../../src/local/dashboard/index.js";
import { LOCAL_REAL_SCHEMA_VERSION } from "../../src/local/real/contracts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("dashboard repository", () => {
  it("projects campaign and experiment data without exposing local execution paths", async () => {
    const fixture = await createCampaignFixture();
    const campaign = await getDashboardCampaign(fixture.stateRoot, "campaign-one");
    expect(campaign.operationalStatus).toBe("ready");
    expect(JSON.stringify(campaign)).not.toContain(fixture.secretPath);

    const detail = await getDashboardExperiment(
      fixture.stateRoot,
      "campaign-one",
      "000001-optimization",
    );
    expect(detail.optimizer?.hypothesisSummary).toBe("Improve tool selection");
    expect(detail.optimizerAudit.latestAttemptOrdinal).toBe(1);
    expect(detail.optimizerAudit.credentialValuesRedacted).toBe(true);
    expect(detail.optimizerAudit.attempts[0]).toMatchObject({
      ordinal: 1,
      status: "completed",
      championRevision: "a".repeat(40),
      prompt: "Exact optimizer prompt",
      boundary: {
        taskCatalogVisible: false,
        panelVisible: false,
        graderVisible: false,
        rawEvaluationVisible: false,
      },
      executionContract: {
        model: "claude-opus-5",
        effort: "high",
        maximumCostUsd: 12,
        maximumTurns: 40,
      },
    });
    expect(detail.optimizerAudit.attempts[0]?.environment).toContainEqual({
      name: "ANTHROPIC_FOUNDRY_API_KEY",
      value: null,
      secret: true,
      description: "Credential is present but never persisted.",
    });
    expect(detail.optimizerAudit.attempts[0]?.inputArtifactId).toBeTypeOf("string");
    expect(detail.optimizerAudit.attempts[0]?.transcriptArtifactId).toBeTypeOf("string");
    expect(detail.candidate?.patchArtifactId).toBeTypeOf("string");
    expect(detail.candidate?.validationCommands[0]?.logArtifactId).toBeTypeOf("string");
    expect(detail.championEvaluation?.observations[0]?.reward).toBe(0.8);
    expect(JSON.stringify(detail)).not.toContain(fixture.secretPath);
    expect(JSON.stringify(detail)).not.toContain("result/path");
  });

  it("allowlists wrapper logs while excluding raw evaluator configuration", async () => {
    const fixture = await createCampaignFixture();
    const artifacts = await listDashboardArtifacts(
      fixture.stateRoot,
      "campaign-one",
      "000001-optimization",
    );
    expect(artifacts.some((artifact) => artifact.label.endsWith("harbor/job.stdout.log"))).toBe(
      true,
    );
    expect(artifacts.some((artifact) => artifact.label.endsWith("job-config.json"))).toBe(false);
    expect(
      artifacts.some(
        (artifact) =>
          artifact.label === "receipt.json" ||
          artifact.label === "panel/accepted.json" ||
          artifact.label === "optimizer/receipt.json" ||
          artifact.label === "candidate/receipt.json",
      ),
    ).toBe(false);
    expect(
      artifacts.some((artifact) => artifact.label === "optimizer/attempts/001/input.json"),
    ).toBe(true);
    expect(
      artifacts.some((artifact) => artifact.label === "optimizer/attempts/001/invocation.json"),
    ).toBe(true);
    const optimizerInput = artifacts.find(
      (artifact) => artifact.label === "optimizer/attempts/001/input.json",
    );
    expect(optimizerInput).toBeDefined();
    const optimizerInputChunk = await readDashboardArtifactChunk({
      stateRoot: fixture.stateRoot,
      campaignId: "campaign-one",
      experimentId: "000001-optimization",
      artifactId: optimizerInput?.id ?? "",
    });
    expect(optimizerInputChunk.content).not.toContain(fixture.secretPath);

    const patch = artifacts.find((artifact) => artifact.contentType === "text/x-diff");
    expect(patch).toBeDefined();
    const chunk = await readDashboardArtifactChunk({
      stateRoot: fixture.stateRoot,
      campaignId: "campaign-one",
      experimentId: "000001-optimization",
      artifactId: patch?.id ?? "",
    });
    expect(chunk.content).toContain("+improvement");
    await expect(
      readDashboardArtifactChunk({
        stateRoot: fixture.stateRoot,
        campaignId: "campaign-one",
        experimentId: "..",
        artifactId: patch?.id ?? "",
      }),
    ).rejects.toThrow("escapes its campaign root");
  });

  it("uses the durable active phase for an in-progress experiment", async () => {
    const fixture = await createCampaignFixture();
    const campaign = join(fixture.stateRoot, "real", "campaigns", "campaign-one");
    await rm(join(campaign, "experiments", "000001-optimization", "receipt.json"));
    await writeJson(join(campaign, "runner-state.json"), {
      schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
      campaignId: "campaign-one",
      revision: 1,
      status: "running",
      championRevision: "a".repeat(40),
      nextExperimentNumber: 2,
      activeExperiment: {
        experimentId: "000001-optimization",
        experimentNumber: 1,
        phase: "publication",
        startedAt: "2026-07-27T10:00:00.000Z",
      },
      retainedPanel: null,
      saturationHistory: [],
      completedExperiments: 0,
      promotions: 0,
      totalCostUsd: 0,
      costLedger: [],
      consecutiveInfrastructureFailures: 0,
      stopReason: null,
      blockedReason: null,
      updatedAt: "2026-07-27T10:01:00.000Z",
      containsSecrets: false,
    });

    const detail = await getDashboardExperiment(
      fixture.stateRoot,
      "campaign-one",
      "000001-optimization",
    );
    expect(detail.phase).toBe("publication");
  });

  it("projects incremental Harbor task and trial progress before the arm receipt exists", async () => {
    const fixture = await createCampaignFixture();
    const campaignDirectory = join(fixture.stateRoot, "real", "campaigns", "campaign-one");
    const experimentDirectory = join(campaignDirectory, "experiments", "000001-optimization");
    await writeLiveHarborFixture(campaignDirectory, experimentDirectory, fixture.secretPath);
    await rm(join(experimentDirectory, "receipt.json"));
    await writeJson(join(campaignDirectory, "runner-state.json"), {
      schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
      campaignId: "campaign-one",
      revision: 1,
      status: "running",
      championRevision: "a".repeat(40),
      nextExperimentNumber: 1,
      activeExperiment: {
        experimentId: "000001-optimization",
        experimentNumber: 1,
        phase: "panel-screening",
        startedAt: "2026-07-27T10:00:00.000Z",
      },
      retainedPanel: null,
      saturationHistory: [],
      completedExperiments: 0,
      promotions: 0,
      totalCostUsd: 0,
      costLedger: [],
      consecutiveInfrastructureFailures: 0,
      stopReason: null,
      blockedReason: null,
      updatedAt: "2026-07-27T10:02:00.000Z",
      containsSecrets: false,
    });

    const [campaign, detail] = await Promise.all([
      getDashboardCampaign(fixture.stateRoot, "campaign-one"),
      getDashboardExperiment(fixture.stateRoot, "campaign-one", "000001-optimization"),
    ]);
    const progress = detail.harborProgress;
    expect(progress).toMatchObject({
      arm: "champion",
      panelAttempt: 2,
      status: "running",
      totalTrials: 15,
      completedTrials: 2,
      runningTrials: 1,
      pendingTrials: 12,
      erroredTrials: 0,
      inputTokens: 30,
      cacheTokens: 5,
      outputTokens: 7,
      costUsd: 0.05,
    });
    expect(progress?.trials).toHaveLength(15);
    expect(
      progress?.trials.find((trial) => trial.taskName === "task-1" && trial.status === "completed"),
    ).toMatchObject({ reward: 0, inputTokens: 10, outputTokens: 3, costUsd: 0.02 });
    expect(
      progress?.trials.find((trial) => trial.taskName === "task-2" && trial.status === "completed"),
    ).toMatchObject({ reward: 1, inputTokens: 20, outputTokens: 4, costUsd: 0.03 });
    expect(
      progress?.trials.find((trial) => trial.taskName === "task-3" && trial.status === "running"),
    ).toMatchObject({ reward: null, costUsd: null });
    expect(campaign.harborProgress).toEqual(progress);
    expect(JSON.stringify({ campaign, detail })).not.toContain(fixture.secretPath);
  });

  it("uses a complete terminal trial snapshot over stale Harbor aggregate counters", async () => {
    const fixture = await createCampaignFixture();
    const campaignDirectory = join(fixture.stateRoot, "real", "campaigns", "campaign-one");
    const experimentDirectory = join(campaignDirectory, "experiments", "000001-optimization");
    await writeLiveHarborFixture(campaignDirectory, experimentDirectory, fixture.secretPath);
    const jobName = "df-campaign-one-000001-optimization-champion-p02";
    const jobDirectory = join(campaignDirectory, "harbor", jobName);
    await Promise.all(
      ["task-1__trial-a", "task-2__trial-b", "task-3__trial-c"].map((trialName) =>
        rm(join(jobDirectory, trialName), { recursive: true, force: true }),
      ),
    );
    for (let taskOrdinal = 1; taskOrdinal <= 5; taskOrdinal += 1) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const taskName = `task-${taskOrdinal}`;
        const trialName = `${taskName}__terminal-${attempt}`;
        await mkdir(join(jobDirectory, trialName), { recursive: true, mode: 0o700 });
        await writeJson(
          join(jobDirectory, trialName, "result.json"),
          harborTrialResult(taskName, trialName, 0, 1, 0, 1, 0),
        );
      }
    }
    await writeJson(join(jobDirectory, "result.json"), {
      id: "job-id",
      started_at: "2026-07-27T10:00:00.000Z",
      updated_at: "2026-07-27T10:15:00.000Z",
      finished_at: "2026-07-27T10:15:00.000Z",
      n_total_trials: 15,
      stats: {
        n_completed_trials: 12,
        n_errored_trials: 0,
        n_running_trials: 3,
        n_pending_trials: 0,
        n_cancelled_trials: 0,
      },
    });

    const detail = await getDashboardExperiment(
      fixture.stateRoot,
      "campaign-one",
      "000001-optimization",
    );
    expect(detail.harborProgress).toMatchObject({
      status: "completed",
      totalTrials: 15,
      completedTrials: 15,
      runningTrials: 0,
      pendingTrials: 0,
      erroredTrials: 0,
      cancelledTrials: 0,
    });
  });

  it("tails allowlisted live task logs with boundary-safe credential redaction", async () => {
    const fixture = await createCampaignFixture();
    const campaignDirectory = join(fixture.stateRoot, "real", "campaigns", "campaign-one");
    const experimentDirectory = join(campaignDirectory, "experiments", "000001-optimization");
    const jobName = "df-campaign-one-000001-optimization-champion-p02";
    const trialName = "task-3__trial-c";
    const trialDirectory = join(campaignDirectory, "harbor", jobName, trialName);
    const credential = "fixture-secret-key-0123456789-abcdefghijklmnopqrstuvwxyz";
    const credentialsFile = join(dirname(fixture.secretPath), "foundry.env");
    await mkdir(dirname(credentialsFile), { recursive: true, mode: 0o700 });
    await writeFile(
      credentialsFile,
      [
        "DF_FOUNDRY_BASE_URL=https://fixture.services.ai.azure.com/anthropic",
        "DF_OPTIMIZER_DEPLOYMENT=claude-opus-5",
        "DF_EVALUATED_DEPLOYMENT=claude-opus-4-8",
        `ANTHROPIC_FOUNDRY_API_KEY=${credential}`,
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    await writeLiveHarborFixture(campaignDirectory, experimentDirectory, fixture.secretPath);
    await mkdir(join(trialDirectory, "agent"), { recursive: true, mode: 0o700 });
    const prefix = `${"x".repeat(300_000)}\n`;
    const agentLog = `${prefix}before=${credential};after\n`;
    await writeFile(join(trialDirectory, "agent", "dark-factory-pi.jsonl"), agentLog, "utf8");
    const outside = join(dirname(fixture.secretPath), "outside-verifier.txt");
    await writeFile(outside, "outside sentinel", "utf8");
    await mkdir(join(trialDirectory, "verifier"), { recursive: true, mode: 0o700 });
    await symlink(outside, join(trialDirectory, "verifier", "test-stdout.txt"));

    const index = await listDashboardTaskLogs(fixture.stateRoot, "campaign-one");
    expect(index).toMatchObject({
      experimentId: "000001-optimization",
      arm: "champion",
      panelAttempt: 2,
      status: "running",
      credentialValuesRedacted: true,
    });
    expect(index?.logs.some((log) => log.source === "agent" && log.trialName === trialName)).toBe(
      true,
    );
    expect(index?.logs.some((log) => log.source === "verifier")).toBe(false);
    expect(index?.logs.some((log) => log.label.includes("config"))).toBe(false);
    expect(JSON.stringify(index)).not.toContain(fixture.secretPath);
    expect(JSON.stringify(index)).not.toContain(credential);

    const descriptor = index?.logs.find(
      (log) => log.source === "agent" && log.trialName === trialName,
    );
    expect(descriptor).toBeDefined();
    const tail = await readDashboardTaskLogChunk({
      stateRoot: fixture.stateRoot,
      campaignId: "campaign-one",
      logId: descriptor?.id ?? "",
      tail: true,
      limit: 262_144,
    });
    expect(tail.offset).toBeGreaterThan(0);
    expect(Buffer.byteLength(tail.content, "utf8")).toBeLessThanOrEqual(262_144);
    expect(tail.content).toContain("[REDACTED]");
    expect(tail.content).not.toContain(credential);

    const secretOffset = Buffer.byteLength(prefix, "utf8") + "before=".length;
    const boundary = await readDashboardTaskLogChunk({
      stateRoot: fixture.stateRoot,
      campaignId: "campaign-one",
      logId: descriptor?.id ?? "",
      offset: secretOffset + 7,
      limit: 20,
    });
    expect(boundary.content).not.toContain(credential.slice(7));
    await expect(
      readDashboardTaskLogChunk({
        stateRoot: fixture.stateRoot,
        campaignId: "campaign-one",
        logId: descriptor?.id ?? "",
        offset: descriptor?.sizeBytes ?? 0,
        tail: true,
      }),
    ).rejects.toThrow("range is invalid");
  });
});

async function writeLiveHarborFixture(
  campaignDirectory: string,
  experimentDirectory: string,
  secretPath: string,
): Promise<void> {
  const jobName = "df-campaign-one-000001-optimization-champion-p02";
  const jobDirectory = join(campaignDirectory, "harbor", jobName);
  const taskNames = ["task-1", "task-2", "task-3", "task-4", "task-5"];
  await mkdir(join(jobDirectory, "task-1__trial-a"), { recursive: true, mode: 0o700 });
  await mkdir(join(jobDirectory, "task-2__trial-b"), { recursive: true, mode: 0o700 });
  await mkdir(join(jobDirectory, "task-3__trial-c"), { recursive: true, mode: 0o700 });
  await writeFile(join(jobDirectory, "job.log"), "Harbor job running\n", "utf8");
  await writeFile(join(jobDirectory, "task-1__trial-a", "trial.log"), "Task one done\n", "utf8");
  await writeFile(join(jobDirectory, "task-2__trial-b", "trial.log"), "Task two done\n", "utf8");
  await writeFile(join(jobDirectory, "task-3__trial-c", "trial.log"), "Task three live\n", "utf8");
  await writeJson(join(experimentDirectory, "harbor", `${jobName}-config.json`), {
    job_name: jobName,
    jobs_dir: secretPath,
    n_attempts: 3,
    agents: [{ kwargs: { runtime_archive_path: join(secretPath, "runtime.tar") } }],
    datasets: [{ task_names: taskNames }],
  });
  await writeJson(join(jobDirectory, "result.json"), {
    id: "job-id",
    started_at: "2026-07-27T10:00:00.000Z",
    updated_at: "2026-07-27T10:02:00.000Z",
    finished_at: null,
    n_total_trials: 15,
    stats: {
      n_completed_trials: 2,
      n_errored_trials: 0,
      n_running_trials: 1,
      n_pending_trials: 12,
      n_cancelled_trials: 0,
      n_input_tokens: 30,
      n_cache_tokens: 5,
      n_output_tokens: 7,
      cost_usd: 0.05,
    },
  });
  await writeJson(
    join(jobDirectory, "task-1__trial-a", "result.json"),
    harborTrialResult("task-1", "task-1__trial-a", 0, 10, 2, 3, 0.02),
  );
  await writeJson(
    join(jobDirectory, "task-2__trial-b", "result.json"),
    harborTrialResult("task-2", "task-2__trial-b", 1, 20, 3, 4, 0.03),
  );
  await writeJson(join(jobDirectory, "task-3__trial-c", "config.json"), {
    trial_name: "task-3__trial-c",
    agent: { kwargs: { runtime_archive_path: secretPath } },
  });
}

function harborTrialResult(
  taskName: string,
  trialName: string,
  reward: number,
  inputTokens: number,
  cacheTokens: number,
  outputTokens: number,
  costUsd: number,
): Record<string, unknown> {
  return {
    id: `${trialName}-id`,
    task_name: taskName,
    task_id: { name: taskName, ref: "2.0" },
    trial_name: trialName,
    started_at: "2026-07-27T10:00:00.000Z",
    finished_at: "2026-07-27T10:01:00.000Z",
    agent_result: {
      n_input_tokens: inputTokens,
      n_cache_tokens: cacheTokens,
      n_output_tokens: outputTokens,
      cost_usd: costUsd,
    },
    verifier_result: { rewards: { reward } },
    exception_info: null,
  };
}

async function createCampaignFixture(): Promise<{
  readonly stateRoot: string;
  readonly secretPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "df-dashboard-"));
  temporaryDirectories.push(root);
  const stateRoot = join(root, "state");
  const secretPath = join(root, "private", "worktree");
  const campaign = join(stateRoot, "real", "campaigns", "campaign-one");
  const experiment = join(campaign, "experiments", "000001-optimization");
  await mkdir(join(experiment, "optimizer"), { recursive: true, mode: 0o700 });
  await mkdir(join(experiment, "optimizer", "attempts", "001"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(experiment, "candidate"), { recursive: true, mode: 0o700 });
  await mkdir(join(experiment, "panel"), { recursive: true, mode: 0o700 });
  await mkdir(join(experiment, "harbor"), { recursive: true, mode: 0o700 });
  for (const directory of ["worktrees", "runtimes", "harbor"]) {
    await mkdir(join(campaign, directory), { recursive: true, mode: 0o700 });
  }
  const now = "2026-07-27T10:00:00.000Z";
  const revision = "a".repeat(40);
  await writeJson(join(campaign, "config.json"), {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    campaignId: "campaign-one",
    createdAt: now,
    piRepository: secretPath,
    piOrigin: "git@github.com:parallaxai/df-pi-tbench.git",
    baselineRevision: revision,
    credentialsFile: join(root, "private", "foundry.env"),
    claudeExecutable: join(root, "private", "claude"),
    optimizer: {
      provider: "microsoft-foundry",
      baseUrl: "https://example.invalid",
      resourceName: "hidden-resource",
      deployment: "claude-opus-5",
      effort: "high",
      maximumCostUsd: 12,
      maximumTurns: 40,
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
      concurrency: 1,
      maximumPanelAttempts: 12,
      maximumInfrastructureRetries: 2,
    },
    budget: { maximumCampaignCostUsd: 100, explicitlyUnbounded: false },
    publication: { enabled: true, remoteName: "origin" },
    containsSecrets: false,
  });
  await writeJson(join(campaign, "runner-state.json"), {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    campaignId: "campaign-one",
    revision: 0,
    status: "initialized",
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
    updatedAt: now,
    containsSecrets: false,
  });
  const tasks = Array.from({ length: 5 }, (_, index) => ({
    name: `task-${index + 1}`,
    difficulty: index > 2 ? "hard" : "medium",
    sourceRepository: "https://github.com/example/tasks",
    sourceRevision: "b".repeat(40),
    sourcePath: `task-${index + 1}`,
    empiricalFailureRate: 0.3,
    selections: 1,
  }));
  await writeJson(join(campaign, "catalog.json"), {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    dataset: {
      name: "terminal-bench",
      version: "2.0",
      registryUrl: "https://example.invalid/registry.json",
      registrySha256: "c".repeat(64),
    },
    generatedAt: now,
    tasks,
    containsTaskPrompts: false,
    containsSolutions: false,
  });
  await writeJson(join(experiment, "experiment.json"), {
    experimentNumber: 1,
    startedAt: now,
  });
  const observations = tasks.flatMap((task) =>
    [1, 2, 3].map((repetition) => ({
      taskName: task.name,
      repetition,
      reward: 0.8,
      infrastructureValid: true,
      durationMs: 100,
      inputTokens: 10,
      cacheTokens: 0,
      outputTokens: 5,
      costUsd: 0.01,
      trialName: "hidden-trial",
      taskRevision: "b".repeat(40),
      resultPath: join(secretPath, "result/path"),
    })),
  );
  const champion = {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    arm: "champion",
    revision,
    runtimeSha256: "d".repeat(64),
    jobName: "hidden-job",
    jobDirectory: secretPath,
    startedAt: now,
    completedAt: now,
    observations,
    costUsd: 0.15,
    infrastructureValid: true,
    containsSecrets: false,
  };
  await writeJson(join(experiment, "panel", "accepted.json"), {
    panelDigest: "panel-one",
    attempt: {
      schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
      experimentId: "000001-optimization",
      ordinal: 1,
      saturationPressure: 0,
      selectedTasks: tasks,
      champion,
      championMeanReward: 0.8,
      taskMeanRewards: Object.fromEntries(tasks.map((task) => [task.name, 0.8])),
      aggregateHeadroomSatisfied: true,
      everyTaskHasHeadroom: true,
      surpassable: true,
      disposition: "accepted",
      recordedAt: now,
      containsSecrets: false,
    },
  });
  await writeJson(join(experiment, "optimizer", "receipt.json"), {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    experimentId: "000001-optimization",
    championRevision: revision,
    worktree: secretPath,
    transcriptPath: join(secretPath, "transcript.jsonl"),
    stderrPath: join(secretPath, "stderr.log"),
    startedAt: now,
    completedAt: now,
    model: "claude-opus-5",
    costUsd: 1,
    turns: 3,
    hypothesisId: "hyp-1",
    hypothesisSummary: "Improve tool selection",
    interventionSummary: "Adjust selection policy",
    containsTaskInformation: false,
    containsSecrets: false,
  });
  await writeJson(join(experiment, "optimizer", "attempts", "001", "invocation.json"), {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    experimentId: "000001-optimization",
    championRevision: revision,
    attemptOrdinal: 1,
    startedAt: now,
    containsSecrets: false,
  });
  await writeJson(join(experiment, "optimizer", "attempts", "001", "input.json"), {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    experimentId: "000001-optimization",
    championRevision: revision,
    previousDecision: null,
    prompt: "Exact optimizer prompt",
    promptSha256: "ignored-and-recomputed",
    boundary: {
      taskCatalogVisible: false,
      panelVisible: false,
      graderVisible: false,
      rawEvaluationVisible: false,
    },
    executionContract: {
      model: "claude-opus-5",
      effort: "high",
      maximumCostUsd: 12,
      maximumTurns: 40,
      timeoutMs: 5_400_000,
      outputFormat: "stream-json",
      permissionMode: "dontAsk",
      sessionPersistence: false,
      browserEnabled: false,
      allowedTools: ["Read", "Edit", "Write", "Grep", "Glob"],
      disallowedTools: ["Bash", "Shell", "WebSearch", "WebFetch"],
      shellEnabled: false,
      networkToolsEnabled: false,
    },
    sourceContext: {
      kind: "detached-git-worktree",
      championRevision: revision,
      readableScope: "The full detached checkout is technically readable.",
      editableRoots: ["packages/agent/src/", "packages/ai/src/", "packages/coding-agent/src/"],
      instructionFiles: ["AGENTS.md"],
      restrictionsEnforcedBy: "Prompt policy plus post-run changed-file validation.",
      postRunChangeValidation: true,
    },
    environment: [
      { name: "LANG", value: "C", secret: false },
      {
        name: "HOME",
        value: null,
        secret: false,
        description: "Isolated per-attempt configuration directory.",
      },
      {
        name: "ANTHROPIC_FOUNDRY_API_KEY",
        value: null,
        secret: true,
        description: "Credential is present but never persisted.",
      },
    ],
    containsSecrets: false,
  });
  await writeJson(join(experiment, "optimizer", "attempts", "001", "receipt.json"), {
    completedAt: now,
    worktree: secretPath,
  });
  await writeFile(
    join(experiment, "optimizer", "attempts", "001", "transcript.jsonl"),
    '{"type":"assistant","message":"safe"}\n',
    "utf8",
  );
  await writeFile(join(experiment, "optimizer", "attempts", "001", "stderr.log"), "safe\n", "utf8");
  await writeJson(join(experiment, "candidate", "receipt.json"), {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    experimentId: "000001-optimization",
    parentRevision: revision,
    tree: "e".repeat(40),
    changedFiles: ["packages/agent/src/index.ts"],
    patchPath: join(secretPath, "candidate.patch"),
    patchSha256: "f".repeat(64),
    runtimeArchive: join(secretPath, "runtime.tar"),
    runtimeSha256: "0".repeat(64),
    piEntrypoint: "pi/pi",
    validationCommands: [
      { command: "npm test", logPath: "candidate/check.stdout.log", exitCode: 0, durationMs: 10 },
    ],
    valid: true,
    invalidReason: null,
    containsSecrets: false,
  });
  await writeFile(join(experiment, "candidate", "candidate.patch"), "+improvement\n", "utf8");
  await writeFile(join(experiment, "candidate", "check.stdout.log"), "passed\n", "utf8");
  await writeFile(join(experiment, "harbor", "job.stdout.log"), "running\n", "utf8");
  await writeJson(join(experiment, "harbor", "job-config.json"), { private: true });
  await writeJson(join(experiment, "receipt.json"), {
    totalExperimentCostUsd: 2,
    completedAt: now,
    candidateEvaluation: { ...champion, arm: "candidate", jobDirectory: secretPath },
  });
  return { stateRoot, secretPath };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}
