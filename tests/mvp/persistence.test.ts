import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMatchedCells,
  type CachedChampionObservation,
  type ChampionCacheKey,
  championCacheKey,
  type EvaluationEnvironment,
  type HiddenTaskProfile,
  hiddenTaskHandle,
  MountedChampionCache,
  MountedHiddenTaskCatalog,
  MountedMvpCampaignStateStore,
  MVP_SCHEMA_VERSION,
  type MvpExperimentArtifacts,
  type MvpIterationResult,
  type PrivateEvaluationRequest,
  prepareNextMvpOptimization,
  runMvpCampaignIterations,
  type SanitizedDiagnosticBrief,
  selectFailureWeightedTasks,
  sha256,
  type TrustedHarborTaskDefinition,
  validateMvpExperimentArtifacts,
} from "../../src/mvp/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("mounted MVP champion cache", () => {
  it("is full-environment keyed, idempotent, and rejects conflicting evidence", async () => {
    const root = await temporaryRoot();
    const cache = new MountedChampionCache(root);
    const task = selectFailureWeightedTasks(taskProfiles())[0];
    if (task === undefined) {
      throw new Error("Missing selected task");
    }
    const key = championCacheKey({
      task,
      championRevision: "a".repeat(40),
      repetition: 1,
      environment: environment(),
    });
    const observation = cachedObservation(key, 0.5);

    expect(await cache.get(key)).toBeNull();
    await cache.put(key, observation);
    await cache.put(key, observation);
    expect(await cache.get(key)).toEqual(observation);
    await expect(cache.put(key, { ...observation, reward: 0.75 })).rejects.toThrow(
      /different evidence/u,
    );

    const changedEnvironment = {
      ...environment(),
      imageDigest: digest(999),
    };
    const changedKey = championCacheKey({
      task,
      championRevision: "a".repeat(40),
      repetition: 1,
      environment: changedEnvironment,
    });
    expect(await cache.get(changedKey)).toBeNull();
  });
});

describe("mounted hidden Harbor catalog", () => {
  it("stores private provenance, resolves opaque cells, and updates selection history once", async () => {
    const root = await temporaryRoot();
    const catalog = new MountedHiddenTaskCatalog(root, "s".repeat(64));
    await catalog.initialize({
      datasetRevision: "terminal-bench-2.1",
      definitions: taskDefinitions(),
    });
    const profiles = await catalog.list();
    expect(profiles).toHaveLength(8);
    expect(profiles[1]?.uncertainty).toBeGreaterThanOrEqual(0.9);
    expect(profiles[0]).not.toHaveProperty("harborTaskLocator");

    const selected = selectFailureWeightedTasks(profiles);
    const cells = buildMatchedCells("001-first-pass", selected);
    const resolved = await catalog.resolveSelectedCells(cells);
    expect(resolved).toHaveLength(15);
    expect(resolved[0]?.harborTaskLocator).toMatch(/^tasks\//u);

    const updates = selected.map((task) => ({
      taskHandle: task.handle,
      experimentId: "001-first-pass",
      candidatePasses: 1,
      championPasses: 2,
      candidateMeanReward: 1 / 3,
      championMeanReward: 2 / 3,
      selected: true as const,
    }));
    await catalog.recordOutcomes("001-first-pass", updates);
    await catalog.recordOutcomes("001-first-pass", updates);
    const updated = await catalog.list();
    expect(
      updated
        .filter((profile) => selected.some((task) => task.handle === profile.handle))
        .every((profile) => profile.consecutiveSelections === 1),
    ).toBe(true);
  });
});

describe("mounted MVP campaign driver", () => {
  it("starts at the frozen baseline, retains an inconclusive panel, and emits task-free receipts", async () => {
    const root = await temporaryRoot();
    const stateStore = new MountedMvpCampaignStateStore(join(root, "campaign"));
    const profiles = taskProfiles();
    const memoryCache = new Map<string, CachedChampionObservation>();
    let persisted: MvpExperimentArtifacts | undefined;
    const receipts = await runMvpCampaignIterations({
      stateStore,
      campaignId: "pi-mvp",
      frozenBaselineRevision: "a".repeat(40),
      slugs: ["first-pass", "second-pass"],
      environment: environment(),
      loopPorts: {
        optimizer: {
          propose: vi.fn(async () => ({
            hypothesisId: "generic-recovery",
            hypothesisSummary: "Improve generic recovery.",
            interventionSummary: "Inspect failures before retrying.",
            candidateRevision: "b".repeat(40),
            changedFiles: ["packages/coding-agent/src/system-prompt.ts"],
          })),
        },
        taskCatalog: {
          list: vi.fn(async () => profiles),
          recordOutcomes: vi.fn(async () => undefined),
        },
        evaluator: {
          evaluateBatch: vi.fn(async (requests: readonly PrivateEvaluationRequest[]) =>
            requests.map((request) => freshObservation(request, 0.5)),
          ),
        },
        sanitizer: { sanitize: vi.fn(async () => diagnosticBrief()) },
        championCache: {
          get: vi.fn(async (key) => memoryCache.get(key.keyDigest) ?? null),
          put: vi.fn(async (key, observation) => {
            memoryCache.set(key.keyDigest, observation);
          }),
        },
        artifacts: {
          persist: vi.fn(async (artifacts) => {
            validateMvpExperimentArtifacts(artifacts);
            persisted = artifacts;
            return `/cloud/experiments/${artifacts.manifest.experimentId}`;
          }),
        },
        now: () => new Date("2026-07-26T10:00:00.000Z"),
      },
      now: () => new Date("2026-07-26T10:00:00.000Z"),
    });

    expect(receipts).toHaveLength(2);
    expect(receipts.every((receipt) => receipt.disposition === "inconclusive")).toBe(true);
    expect(JSON.stringify(receipts)).not.toContain(profiles[0]?.handle);
    expect(JSON.stringify(receipts)).not.toContain("tasks/task-");
    const state = await stateStore.load();
    expect(state.frozenBaselineRevision).toBe("a".repeat(40));
    expect(state.championRevision).toBe("a".repeat(40));
    expect(state.nextExperimentNumber).toBe(3);
    expect(state.retainedTaskHandles).toHaveLength(5);
    expect(persisted?.privateSelection.tasks.map((task) => task.handle)).toEqual(
      state.retainedTaskHandles,
    );

    const prepared = await prepareNextMvpOptimization(stateStore);
    expect(prepared.optimizerInput.experimentNumber).toBe(3);
    const retainedHandle = state.retainedTaskHandles?.[0];
    if (retainedHandle === undefined) {
      throw new Error("Expected retained campaign panel");
    }
    expect(JSON.stringify(prepared)).not.toContain(retainedHandle);
  });

  it("clears retained state after promotion", async () => {
    const root = await temporaryRoot();
    const store = new MountedMvpCampaignStateStore(root);
    const initial = await store.initialize({
      campaignId: "pi-mvp",
      frozenBaselineRevision: "a".repeat(40),
      initializedAt: "2026-07-26T10:00:00.000Z",
    });
    const retained = taskProfiles()
      .slice(0, 5)
      .map((profile) => profile.handle);
    const rejected = iterationResult("001-rejected-change", "reject", "a".repeat(40));
    const afterReject = await store.advance({
      expectedRevision: initial.revision,
      iteration: rejected,
      retainedTaskHandles: retained,
      updatedAt: "2026-07-26T11:00:00.000Z",
    });
    expect(afterReject.retainedTaskHandles).toEqual(retained);

    const promoted = iterationResult("002-promoted-change", "promote", "c".repeat(40));
    const afterPromotion = await store.advance({
      expectedRevision: afterReject.revision,
      iteration: promoted,
      retainedTaskHandles: null,
      updatedAt: "2026-07-26T12:00:00.000Z",
    });
    expect(afterPromotion.retainedTaskHandles).toBeNull();
    expect(afterPromotion.championRevision).toBe("c".repeat(40));
  });
});

function taskDefinitions(): readonly TrustedHarborTaskDefinition[] {
  return Array.from({ length: 8 }, (_, index) => ({
    harborTaskLocator: `tasks/task-${index}`,
    revisionDigest: digest(index + 100),
    difficulty: index === 7 ? ("easy" as const) : ("hard" as const),
    easyCanary: index === 7,
    baselineFailureRate: 0.8,
    baselineProvenance: {
      kind: "trusted-measurement" as const,
      sourceDigest: digest(500),
      datasetRevision: "terminal-bench-2.1",
    },
    graderIsolation: {
      verifierEnvironmentMode: "separate" as const,
      allStepVerifierEnvironmentModesSeparate: true as const,
      sourceDigest: digest(502),
    },
    leaderboard:
      index === 1
        ? ({ kind: "unknown", reason: "not-published" } as const)
        : ({
            kind: "comparable-measurement",
            failureRate: 0.7,
            sourceDigest: digest(501),
            datasetRevision: "terminal-bench-2.1",
          } as const),
    initialFailureRate: 0.8,
    uncertainty: 0.4,
    normalizedCost: 0.2,
    sensitiveLiterals: [`secret-task-${index}`],
  }));
}

function taskProfiles(): readonly HiddenTaskProfile[] {
  return Array.from({ length: 8 }, (_, index) => ({
    handle: hiddenTaskHandle(digest(index + 1)),
    revisionDigest: digest(index + 101),
    difficulty: index === 7 ? ("easy" as const) : ("hard" as const),
    easyCanary: index === 7,
    baselineFailureRate: 0.8,
    leaderboardFailureRate: 0.7,
    previousFailureRate: 0.8,
    uncertainty: 0.5,
    underexposure: 1,
    normalizedCost: 0.2,
    consecutiveSelections: 0,
    sensitiveLiterals: [`secret-task-${index}`],
  }));
}

function environment(): EvaluationEnvironment {
  return {
    terminalBenchVersion: "2.1",
    datasetRevision: "terminal-bench-2.1",
    graderProtocolVersion: "harbor-0.2",
    evaluatorVersion: "df-evaluator-1",
    modelProvider: "microsoft-foundry",
    modelDeployment: "claude-opus-4-8",
    reasoningEffort: "high",
    samplingSettingsDigest: digest(201),
    contextSettingsDigest: digest(202),
    sandboxProvider: "daytona",
    sandboxRegion: "eu",
    imageDigest: digest(203),
    architecture: "arm64",
    resourcesDigest: digest(204),
    networkPolicyDigest: digest(205),
    harnessConfigDigest: digest(206),
    extraConfigDigest: digest(207),
  };
}

function cachedObservation(key: ChampionCacheKey, reward: number): CachedChampionObservation {
  return {
    keyDigest: key.keyDigest,
    taskHandle: key.taskHandle,
    taskRevisionDigest: key.taskRevisionDigest,
    championRevision: key.championRevision,
    repetition: key.repetition,
    environmentDigest: key.environmentDigest,
    passed: reward > 0.5,
    reward,
    infrastructureValid: true,
    durationMs: 100,
    evaluatedAt: "2026-07-26T10:00:00.000Z",
    traceArtifactRefs: ["private/trace.json"],
    rawDiagnostics: [],
  };
}

function freshObservation(request: PrivateEvaluationRequest, reward: number) {
  return {
    schemaVersion: MVP_SCHEMA_VERSION,
    experimentId: request.experimentId,
    cellId: request.cell.cellId,
    taskHandle: request.cell.task.handle,
    taskRevisionDigest: request.cell.task.revisionDigest,
    repetition: request.cell.repetition,
    arm: request.arm,
    harnessRevision: request.harnessRevision,
    environmentDigest: request.environmentDigest,
    source: "fresh" as const,
    passed: reward > 0.5,
    reward,
    infrastructureValid: true,
    durationMs: 100,
    evaluatedAt: "2026-07-26T10:00:00.000Z",
    traceArtifactRefs: ["private/trace.json"],
    rawDiagnostics: [],
  };
}

function diagnosticBrief(): SanitizedDiagnosticBrief {
  return {
    schemaVersion: MVP_SCHEMA_VERSION,
    policyVersion: "closed-vocabulary-task-free-v1",
    cards: [],
    containsTaskIdentifiers: false,
    containsTaskLiterals: false,
    containsGraderSecrets: false,
    containsPerTaskOutcomes: false,
  };
}

function iterationResult(
  experimentId: string,
  disposition: "promote" | "reject",
  championRevision: string,
): MvpIterationResult {
  return {
    experimentId,
    candidateRevision: disposition === "promote" ? championRevision : "b".repeat(40),
    championRevision,
    decision: {
      schemaVersion: MVP_SCHEMA_VERSION,
      policyVersion: "matched-cluster-sign-v1",
      disposition,
      reason: disposition === "promote" ? "candidate-superior" : "candidate-inferior",
      evidenceFresh: true,
      matchedTaskCount: 5,
      repetitionsPerTask: 3,
      candidateObservationCount: 15,
      championObservationCount: 15,
      candidateMeanReward: disposition === "promote" ? 1 : 0,
      championMeanReward: disposition === "promote" ? 0 : 1,
      meanRewardDelta: disposition === "promote" ? 1 : -1,
      taskWins: disposition === "promote" ? 5 : 0,
      taskLosses: disposition === "promote" ? 0 : 5,
      taskTies: 0,
      confidenceMethod: "exact-one-sided-cluster-sign-v1",
      confidenceCandidateBetter: disposition === "promote" ? 0.96875 : 0,
      confidenceChampionBetter: disposition === "promote" ? 0 : 0.96875,
      requiredConfidence: 0.95,
      minimumAggregateDelta: 0.05,
      containsTaskIdentifiers: false,
      containsPerTaskOutcomes: false,
    },
    diagnosticBrief: diagnosticBrief(),
    artifactDirectory: `/cloud/experiments/${experimentId}`,
    cache: {
      hits: 0,
      misses: 15,
      refreshedForPromotion: 0,
      seededFromPromotion: disposition === "promote" ? 15 : 0,
    },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "df-mvp-"));
  roots.push(root);
  return root;
}

function digest(value: number): string {
  return sha256(`fixture-${value}`);
}
