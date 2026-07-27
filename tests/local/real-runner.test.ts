import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_REAL_SCHEMA_VERSION,
  type LocalRealArmReceipt,
  type LocalRealCampaignConfig,
  type LocalRealCatalog,
  type LocalRealRunnerAdapter,
  type LocalRealTask,
} from "../../src/local/real/contracts.js";
import { runLocalRealCampaign } from "../../src/local/real/runner.js";
import { initializeLocalRealCampaign, loadLocalRealCampaign } from "../../src/local/real/state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("indefinite local real runner", () => {
  it("rotates a perfect panel before optimization and persists adaptive pressure", async () => {
    const fixture = await campaignFixture("rotation-campaign");
    const events: string[] = [];
    let championAttempt = 0;
    const adapter = fakeAdapter({
      evaluateArm: async (input) => {
        events.push(`${input.arm}-${input.attemptOrdinal}`);
        if (input.arm === "champion") {
          championAttempt += 1;
          return armReceipt(
            input.arm,
            input.revision,
            input.tasks,
            championAttempt === 1 ? 1 : 0.5,
            input.attemptOrdinal,
          );
        }
        return armReceipt(input.arm, input.revision, input.tasks, 0.5, input.attemptOrdinal);
      },
      optimize: async (input) => {
        events.push("optimizer");
        return optimizerReceipt(input.experimentId, input.state.championRevision);
      },
    });

    const result = await runLocalRealCampaign({
      stateRoot: fixture.stateRoot,
      campaignId: fixture.config.campaignId,
      adapter,
      maximumCompletedExperiments: 1,
      now: advancingClock(),
    });

    expect(result).toMatchObject({
      status: "stopped",
      completedThisInvocation: 1,
      completedTotal: 1,
      promotions: 0,
      nextExperimentNumber: 2,
    });
    expect(events).toEqual(["champion-1", "champion-2", "optimizer", "candidate-2"]);
    expect(adapter.publish).not.toHaveBeenCalled();
    const stored = await loadLocalRealCampaign(fixture.stateRoot, fixture.config.campaignId);
    expect(stored.state.saturationHistory).toEqual([true, false]);
    expect(stored.state.retainedPanel?.taskNames).toHaveLength(5);
    expect(stored.catalog.tasks.filter((task) => task.selections > 0)).toHaveLength(10);

    const experiment = join(stored.paths.experiments, "000001-optimization", "panel");
    const first = await readJson(join(experiment, "attempt-001.json"));
    const second = await readJson(join(experiment, "attempt-002.json"));
    expect(first).toMatchObject({
      attempt: {
        championMeanReward: 1,
        disposition: "saturated",
        surpassable: false,
      },
      historyAfter: [true],
    });
    expect(second).toMatchObject({
      attempt: {
        championMeanReward: 0.5,
        disposition: "accepted",
        surpassable: true,
      },
      historyAfter: [true, false],
    });
  });

  it("publishes a superior candidate before advancing the champion", async () => {
    const fixture = await campaignFixture("promotion-campaign");
    const promotedCommit = "b".repeat(40);
    const adapter = fakeAdapter({
      evaluateArm: async (input) =>
        armReceipt(
          input.arm,
          input.revision,
          input.tasks,
          input.arm === "champion" ? 0.5 : 1,
          input.attemptOrdinal,
        ),
      publish: async () => ({
        commit: promotedCommit,
        status: "published" as const,
        experimentRef: "refs/heads/df/experiment/promotion-campaign/000001-optimization",
        championRef: "refs/heads/df/champion/promotion-campaign",
      }),
    });

    const result = await runLocalRealCampaign({
      stateRoot: fixture.stateRoot,
      campaignId: fixture.config.campaignId,
      adapter,
      maximumCompletedExperiments: 1,
      now: advancingClock(),
    });

    expect(adapter.publish).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "stopped",
      promotions: 1,
      championRevision: promotedCommit,
    });
    const stored = await loadLocalRealCampaign(fixture.stateRoot, fixture.config.campaignId);
    expect(stored.state.championRevision).toBe(promotedCommit);
    expect(stored.state.retainedPanel).toBeNull();
    await expect(
      readJson(join(stored.paths.experiments, "000001-optimization", "publication.json")),
    ).resolves.toMatchObject({ commit: promotedCommit });
  });

  it("resumes after a phase-boundary stop without rerunning the accepted champion screen", async () => {
    const fixture = await campaignFixture("resume-campaign");
    const evaluateArm = vi.fn(async (input: Parameters<LocalRealRunnerAdapter["evaluateArm"]>[0]) =>
      armReceipt(input.arm, input.revision, input.tasks, 0.5, input.attemptOrdinal),
    );
    const adapter = fakeAdapter({ evaluateArm });
    let stopChecks = 0;

    const stopped = await runLocalRealCampaign({
      stateRoot: fixture.stateRoot,
      campaignId: fixture.config.campaignId,
      adapter,
      shouldStop: () => {
        stopChecks += 1;
        return stopChecks >= 2;
      },
      now: advancingClock(),
    });
    expect(stopped.status).toBe("stopped");
    expect(stopped.completedThisInvocation).toBe(0);
    expect(evaluateArm).toHaveBeenCalledOnce();

    const resumed = await runLocalRealCampaign({
      stateRoot: fixture.stateRoot,
      campaignId: fixture.config.campaignId,
      adapter,
      resume: true,
      maximumCompletedExperiments: 1,
      now: advancingClock("2026-07-28T00:00:00.000Z"),
    });
    expect(resumed.completedThisInvocation).toBe(1);
    expect(evaluateArm).toHaveBeenCalledTimes(2);
    expect(evaluateArm.mock.calls.filter(([input]) => input.arm === "champion")).toHaveLength(1);
  });

  it("reuses one champion panel across two unchanged inconclusive experiments and resume", async () => {
    const fixture = await campaignFixture("retained-panel-reuse-campaign");
    const ensureChampionRuntime = vi.fn(
      async (
        _config: LocalRealCampaignConfig,
        state: Parameters<LocalRealRunnerAdapter["ensureChampionRuntime"]>[1],
      ) => ({
        revision: state.championRevision,
        tree: "2".repeat(40),
        archivePath: "/fixture/champion.tar.gz",
        archiveSha256: "3".repeat(64),
        piEntrypoint: "pi/pi" as const,
      }),
    );
    const evaluateArm = vi.fn(async (input: Parameters<LocalRealRunnerAdapter["evaluateArm"]>[0]) =>
      armReceipt(input.arm, input.revision, input.tasks, 0.5, input.attemptOrdinal),
    );
    const adapter = fakeAdapter({ ensureChampionRuntime, evaluateArm });

    await runLocalRealCampaign({
      stateRoot: fixture.stateRoot,
      campaignId: fixture.config.campaignId,
      adapter,
      maximumCompletedExperiments: 1,
      now: advancingClock(),
    });

    let stopChecks = 0;
    const stopped = await runLocalRealCampaign({
      stateRoot: fixture.stateRoot,
      campaignId: fixture.config.campaignId,
      adapter,
      resume: true,
      shouldStop: () => {
        stopChecks += 1;
        return stopChecks >= 2;
      },
      now: advancingClock("2026-07-28T00:00:00.000Z"),
    });
    expect(stopped.completedTotal).toBe(1);

    const resumed = await runLocalRealCampaign({
      stateRoot: fixture.stateRoot,
      campaignId: fixture.config.campaignId,
      adapter,
      resume: true,
      maximumCompletedExperiments: 1,
      now: advancingClock("2026-07-29T00:00:00.000Z"),
    });
    expect(resumed.completedTotal).toBe(2);
    expect(ensureChampionRuntime).toHaveBeenCalledOnce();
    expect(evaluateArm.mock.calls.filter(([input]) => input.arm === "champion")).toHaveLength(1);
    expect(evaluateArm.mock.calls.filter(([input]) => input.arm === "candidate")).toHaveLength(2);

    const stored = await loadLocalRealCampaign(fixture.stateRoot, fixture.config.campaignId);
    expect(stored.state.costLedger.filter((entry) => entry.id.includes(":panel:"))).toHaveLength(1);
    await expect(
      readJson(join(stored.paths.experiments, "000002-optimization", "panel", "reused.json")),
    ).resolves.toMatchObject({
      experimentId: "000002-optimization",
      sourceExperimentId: "000001-optimization",
      championRevision: fixture.config.baselineRevision,
      containsSecrets: false,
    });
  });

  it("replays a two-attempt panel journal from its advanced state without double-counting", async () => {
    const fixture = await campaignFixture("panel-journal-campaign");
    let championAttempt = 0;
    const evaluateArm = vi.fn(
      async (input: Parameters<LocalRealRunnerAdapter["evaluateArm"]>[0]) => {
        if (input.arm === "champion") championAttempt += 1;
        return armReceipt(
          input.arm,
          input.revision,
          input.tasks,
          input.arm === "champion" && championAttempt === 1 ? 1 : 0.5,
          input.attemptOrdinal,
        );
      },
    );
    const adapter = fakeAdapter({ evaluateArm });
    let stopChecks = 0;
    const stopped = await runLocalRealCampaign({
      stateRoot: fixture.stateRoot,
      campaignId: fixture.config.campaignId,
      adapter,
      shouldStop: () => {
        stopChecks += 1;
        return stopChecks >= 2;
      },
      now: advancingClock(),
    });
    expect(stopped.completedThisInvocation).toBe(0);

    const stored = await loadLocalRealCampaign(fixture.stateRoot, fixture.config.campaignId);
    const panelDirectory = join(stored.paths.experiments, "000001-optimization", "panel");
    await rm(join(panelDirectory, "accepted.json"));

    const resumed = await runLocalRealCampaign({
      stateRoot: fixture.stateRoot,
      campaignId: fixture.config.campaignId,
      adapter,
      resume: true,
      maximumCompletedExperiments: 1,
      now: advancingClock("2026-07-28T00:00:00.000Z"),
    });
    expect(resumed.completedThisInvocation).toBe(1);
    expect(evaluateArm.mock.calls.filter(([input]) => input.arm === "champion")).toHaveLength(2);
    const recovered = await loadLocalRealCampaign(fixture.stateRoot, fixture.config.campaignId);
    expect(recovered.state.saturationHistory).toEqual([true, false]);
    expect(recovered.catalog.tasks.filter((task) => task.selections > 0)).toHaveLength(10);
    expect(recovered.catalog.tasks.reduce((total, task) => total + task.selections, 0)).toBe(10);
  });

  it("uses an existing experiment receipt as the finalization commit record", async () => {
    const fixture = await campaignFixture("receipt-recovery-campaign");
    await runLocalRealCampaign({
      stateRoot: fixture.stateRoot,
      campaignId: fixture.config.campaignId,
      adapter: fakeAdapter(),
      maximumCompletedExperiments: 1,
      now: advancingClock(),
    });
    const stored = await loadLocalRealCampaign(fixture.stateRoot, fixture.config.campaignId);
    const experiment = (await readJson(
      join(stored.paths.experiments, "000001-optimization", "experiment.json"),
    )) as { readonly startedAt: string };
    await writeFile(
      stored.paths.state,
      `${JSON.stringify(
        {
          ...stored.state,
          status: "running",
          championRevision: fixture.config.baselineRevision,
          nextExperimentNumber: 1,
          activeExperiment: {
            experimentNumber: 1,
            experimentId: "000001-optimization",
            phase: "advance",
            startedAt: experiment.startedAt,
          },
          retainedPanel: null,
          completedExperiments: 0,
          promotions: 0,
          stopReason: null,
          blockedReason: null,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const noReplayAdapter = fakeAdapter({
      ensureChampionRuntime: async () => {
        throw new Error("completed experiment unexpectedly rebuilt its champion");
      },
      evaluateArm: async () => {
        throw new Error("completed experiment unexpectedly reran Harbor");
      },
      optimize: async () => {
        throw new Error("completed experiment unexpectedly reran the optimizer");
      },
      validateAndBuild: async () => {
        throw new Error("completed experiment unexpectedly rebuilt its candidate");
      },
    });
    const recovered = await runLocalRealCampaign({
      stateRoot: fixture.stateRoot,
      campaignId: fixture.config.campaignId,
      adapter: noReplayAdapter,
      maximumCompletedExperiments: 1,
      now: advancingClock("2026-07-29T00:00:00.000Z"),
    });
    expect(recovered).toMatchObject({
      status: "stopped",
      completedThisInvocation: 1,
      completedTotal: 1,
      nextExperimentNumber: 2,
    });
  });
});

function fakeAdapter(overrides: Partial<LocalRealRunnerAdapter> = {}): LocalRealRunnerAdapter & {
  readonly publish: ReturnType<typeof vi.fn<LocalRealRunnerAdapter["publish"]>>;
} {
  const publish = vi.fn<LocalRealRunnerAdapter["publish"]>(
    overrides.publish ??
      (async () => ({
        commit: "b".repeat(40),
        status: "published",
        experimentRef: "refs/heads/df/experiment/fixture/000001-optimization",
        championRef: "refs/heads/df/champion/fixture",
      })),
  );
  return {
    ensureChampionRuntime:
      overrides.ensureChampionRuntime ??
      (async (_config, state) => ({
        revision: state.championRevision,
        tree: "2".repeat(40),
        archivePath: "/fixture/champion.tar.gz",
        archiveSha256: "3".repeat(64),
        piEntrypoint: "pi/pi",
      })),
    evaluateArm:
      overrides.evaluateArm ??
      (async (input) => armReceipt(input.arm, input.revision, input.tasks, 0.5, 1)),
    optimize:
      overrides.optimize ??
      (async (input) => optimizerReceipt(input.experimentId, input.state.championRevision)),
    validateAndBuild:
      overrides.validateAndBuild ??
      (async (input) => ({
        candidate: {
          schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
          experimentId: input.experimentId,
          parentRevision: input.optimizer.championRevision,
          tree: "a".repeat(40),
          changedFiles: ["packages/coding-agent/src/core/example.ts"],
          patchPath: "candidate/candidate.patch",
          patchSha256: "4".repeat(64),
          runtimeArchive: "/fixture/candidate.tar.gz",
          runtimeSha256: "5".repeat(64),
          piEntrypoint: "pi/pi",
          validationCommands: [],
          valid: true,
          invalidReason: null,
          containsSecrets: false,
        },
        runtime: {
          revision: "a".repeat(40),
          tree: "a".repeat(40),
          archivePath: "/fixture/candidate.tar.gz",
          archiveSha256: "5".repeat(64),
          piEntrypoint: "pi/pi",
        },
      })),
    publish,
  };
}

function optimizerReceipt(experimentId: string, championRevision: string) {
  return {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    experimentId,
    championRevision,
    worktree: "/fixture/worktree",
    transcriptPath: "optimizer/transcript.jsonl",
    stderrPath: "optimizer/stderr.log",
    startedAt: "2026-07-27T00:00:01.000Z",
    completedAt: "2026-07-27T00:00:02.000Z",
    model: "claude-opus-5" as const,
    costUsd: 1,
    turns: 2,
    hypothesisId: "fixture-hypothesis",
    hypothesisSummary: "A sufficiently detailed fixture causal hypothesis.",
    interventionSummary: "A sufficiently detailed fixture intervention summary.",
    containsTaskInformation: false as const,
    containsSecrets: false as const,
  };
}

function armReceipt(
  arm: "champion" | "candidate",
  revision: string,
  tasks: readonly LocalRealTask[],
  reward: number,
  ordinal: number,
): LocalRealArmReceipt {
  return {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    arm,
    revision,
    runtimeSha256: "6".repeat(64),
    jobName: `${arm}-${ordinal}`,
    jobDirectory: `/fixture/${arm}-${ordinal}`,
    startedAt: "2026-07-27T00:00:00.000Z",
    completedAt: "2026-07-27T00:00:01.000Z",
    observations: tasks.flatMap((task) =>
      ([1, 2, 3] as const).map((repetition) => ({
        taskName: task.name,
        repetition,
        reward,
        infrastructureValid: true,
        durationMs: 1,
        inputTokens: 1,
        cacheTokens: 0,
        outputTokens: 1,
        costUsd: 0.01,
        trialName: `${task.name}-${repetition}`,
        taskRevision: task.sourceRevision,
        resultPath: `/fixture/${task.name}-${repetition}.json`,
      })),
    ),
    costUsd: 0.15,
    infrastructureValid: true,
    containsSecrets: false,
  };
}

async function campaignFixture(campaignId: string): Promise<{
  readonly stateRoot: string;
  readonly config: LocalRealCampaignConfig;
}> {
  const stateRoot = await mkdtemp(join(tmpdir(), "df-real-runner-"));
  temporaryDirectories.push(stateRoot);
  const config = campaignConfig(campaignId);
  await initializeLocalRealCampaign({
    stateRoot,
    config,
    catalog: taskCatalog(),
    initializedAt: "2026-07-27T00:00:00.000Z",
  });
  return { stateRoot, config };
}

function campaignConfig(campaignId: string): LocalRealCampaignConfig {
  return {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    campaignId,
    createdAt: "2026-07-27T00:00:00.000Z",
    piRepository: "/fixture/pi",
    piOrigin: "git@github.com:parallaxai/df-pi-tbench.git",
    baselineRevision: "1".repeat(40),
    credentialsFile: "/fixture/foundry.env",
    claudeExecutable: "/fixture/claude",
    optimizer: {
      provider: "microsoft-foundry",
      baseUrl: "https://fixture.services.ai.azure.com/anthropic",
      resourceName: "fixture",
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
      maximumPanelAttempts: 3,
      maximumInfrastructureRetries: 1,
    },
    budget: {
      maximumCampaignCostUsd: 100,
      explicitlyUnbounded: false,
    },
    publication: {
      enabled: true,
      remoteName: "origin",
    },
    containsSecrets: false,
  };
}

function taskCatalog(): LocalRealCatalog {
  return {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    dataset: {
      name: "terminal-bench",
      version: "2.0",
      registryUrl: "https://example.invalid/registry.json",
      registrySha256: "7".repeat(64),
    },
    generatedAt: "2026-07-27T00:00:00.000Z",
    tasks: Array.from({ length: 20 }, (_, index) => ({
      name: `task-${String(index + 1).padStart(2, "0")}`,
      difficulty:
        index % 3 === 0
          ? ("hard" as const)
          : index % 3 === 1
            ? ("medium" as const)
            : ("easy" as const),
      sourceRepository: "https://github.com/example/terminal-bench-tasks.git",
      sourceRevision: "8".repeat(40),
      sourcePath: `task-${String(index + 1).padStart(2, "0")}`,
      empiricalFailureRate: 0,
      selections: 0,
    })),
    containsTaskPrompts: false,
    containsSolutions: false,
  };
}

function advancingClock(start = "2026-07-27T00:00:00.000Z"): () => Date {
  let milliseconds = Date.parse(start);
  return () => {
    const value = new Date(milliseconds);
    milliseconds += 1_000;
    return value;
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
