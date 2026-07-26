import { describe, expect, it, vi } from "vitest";
import {
  MVP_SCHEMA_VERSION,
  runMvpIteration,
  sha256,
  validateMvpExperimentArtifacts,
  hiddenTaskHandle,
  type CachedChampionObservation,
  type ChampionCacheKey,
  type EvaluationEnvironment,
  type HiddenTaskProfile,
  type MvpExperimentArtifacts,
  type PrivateEvaluationRequest,
  type SanitizedDiagnosticBrief,
} from "../../src/mvp/index.js";

describe("MVP loop", () => {
  it("keeps the panel hidden, refreshes cache hits, and persists a fresh promotion", async () => {
    const events: string[] = [];
    let persisted: MvpExperimentArtifacts | undefined;
    const evaluator = vi.fn(async (requests: readonly PrivateEvaluationRequest[]) => {
      events.push(`evaluate:${requests.length}`);
      return requests.map((request) =>
        observation(request, request.arm === "candidate" ? 1 : 0),
      );
    });
    const cachePut = vi.fn(async () => undefined);
    const result = await runMvpIteration(
      {
        optimizer: {
          propose: vi.fn(async (input) => {
            events.push("optimizer");
            expect(JSON.stringify(input)).not.toContain("actual-secret-task");
            expect(input.boundary.taskIdentifiersVisible).toBe(false);
            return proposal();
          }),
        },
        taskCatalog: {
          list: vi.fn(async () => {
            events.push("catalog");
            return taskProfiles();
          }),
          recordOutcomes: vi.fn(async () => undefined),
        },
        evaluator: { evaluateBatch: evaluator },
        sanitizer: {
          sanitize: vi.fn(async () => diagnosticBrief()),
        },
        championCache: {
          get: vi.fn(async (key) => cachedObservation(key, 0)),
          put: cachePut,
        },
        artifacts: {
          persist: vi.fn(async (artifacts) => {
            validateMvpExperimentArtifacts(artifacts);
            persisted = artifacts;
            return "/cloud/experiments/001-change-system-prompt";
          }),
        },
        now: () => new Date("2026-07-26T10:00:00.000Z"),
      },
      {
        experimentNumber: 1,
        slug: "change-system-prompt",
        championRevision: "a".repeat(40),
        environment: environment(),
        previousOutcome: null,
        previousDiagnosticBrief: null,
      },
    );

    expect(events.slice(0, 2)).toEqual(["optimizer", "catalog"]);
    expect(result.decision.disposition).toBe("promote");
    expect(result.decision.evidenceFresh).toBe(true);
    expect(result.cache).toEqual({
      hits: 15,
      misses: 0,
      refreshedForPromotion: 15,
      seededFromPromotion: 15,
    });
    expect(evaluator).toHaveBeenCalledTimes(2);
    expect(
      evaluator.mock.calls.flatMap(([requests]) => requests).length,
    ).toBe(30);
    expect(cachePut).toHaveBeenCalledTimes(30);
    expect(persisted?.privateSelection.tasks).toHaveLength(5);
    expect(persisted?.privateEvaluations.final).toHaveLength(30);
    expect(
      persisted?.privateCache.seededFromPromotedCandidateCellIds,
    ).toHaveLength(15);
    expect(JSON.stringify(persisted?.diagnostics)).not.toContain("actual-secret-task");
  });

  it("uses cached champion evidence for an inconclusive screen without false promotion", async () => {
    const evaluator = vi.fn(async (requests: readonly PrivateEvaluationRequest[]) =>
      requests.map((request) => observation(request, 0.5)),
    );
    const result = await runMvpIteration(
      {
        optimizer: { propose: vi.fn(async () => proposal()) },
        taskCatalog: {
          list: vi.fn(async () => taskProfiles()),
          recordOutcomes: vi.fn(async () => undefined),
        },
        evaluator: { evaluateBatch: evaluator },
        sanitizer: { sanitize: vi.fn(async () => diagnosticBrief()) },
        championCache: {
          get: vi.fn(async (key) => cachedObservation(key, 0.5)),
          put: vi.fn(async () => undefined),
        },
        artifacts: { persist: vi.fn(async () => "/cloud/experiments/001-safe-change") },
      },
      {
        experimentNumber: 1,
        slug: "safe-change",
        championRevision: "a".repeat(40),
        environment: environment(),
        previousOutcome: null,
        previousDiagnosticBrief: null,
      },
    );
    expect(result.decision.disposition).toBe("inconclusive");
    expect(result.decision.evidenceFresh).toBe(false);
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(evaluator.mock.calls[0]?.[0]).toHaveLength(15);
  });

  it("does not poison task weighting with infrastructure-invalid evidence", async () => {
    const recordOutcomes = vi.fn(async () => undefined);
    let persisted: MvpExperimentArtifacts | undefined;
    await runMvpIteration(
      {
        optimizer: { propose: vi.fn(async () => proposal()) },
        taskCatalog: {
          list: vi.fn(async () => taskProfiles()),
          recordOutcomes,
        },
        evaluator: {
          evaluateBatch: vi.fn(async (requests) =>
            requests.map((request, index) => ({
              ...observation(request, 0.5),
              infrastructureValid: index !== 0,
            })),
          ),
        },
        sanitizer: { sanitize: vi.fn(async () => diagnosticBrief()) },
        championCache: {
          get: vi.fn(async () => null),
          put: vi.fn(async () => undefined),
        },
        artifacts: {
          persist: vi.fn(async (artifacts) => {
            persisted = artifacts;
            return "/cloud/experiments/001-infrastructure-invalid";
          }),
        },
      },
      {
        experimentNumber: 1,
        slug: "infrastructure-invalid",
        championRevision: "a".repeat(40),
        environment: environment(),
        previousOutcome: null,
        previousDiagnosticBrief: null,
      },
    );

    expect(recordOutcomes).not.toHaveBeenCalled();
    expect(
      persisted?.privateEvaluations.final.some(
        (item) => !item.infrastructureValid,
      ),
    ).toBe(true);
  });

  it("requires and reuses the previous hidden panel after an inconclusive result", async () => {
    const profiles = taskProfiles();
    const retainedTaskHandles = profiles
      .slice(0, 4)
      .map((profile) => profile.handle)
      .concat(profiles[7]?.handle ?? []);
    let persisted: MvpExperimentArtifacts | undefined;
    await runMvpIteration(
      {
        optimizer: { propose: vi.fn(async () => proposal()) },
        taskCatalog: {
          list: vi.fn(async () =>
            profiles.map((profile, index) => ({
              ...profile,
              previousFailureRate: index === 6 ? 1 : 0,
            })),
          ),
          recordOutcomes: vi.fn(async () => undefined),
        },
        evaluator: {
          evaluateBatch: vi.fn(async (requests) =>
            requests.map((request) => observation(request, 0.5)),
          ),
        },
        sanitizer: { sanitize: vi.fn(async () => diagnosticBrief()) },
        championCache: {
          get: vi.fn(async () => null),
          put: vi.fn(async () => undefined),
        },
        artifacts: {
          persist: vi.fn(async (artifacts) => {
            persisted = artifacts;
            return "/cloud/experiments/002-retain-panel";
          }),
        },
      },
      {
        experimentNumber: 2,
        slug: "retain-panel",
        championRevision: "a".repeat(40),
        environment: environment(),
        previousOutcome: "inconclusive",
        previousDiagnosticBrief: diagnosticBrief(),
        retainedTaskHandles,
      },
    );

    expect(
      persisted?.privateSelection.tasks.map((task) => task.handle),
    ).toEqual(retainedTaskHandles);
  });

  it("fails closed when a rejected iteration omits its private panel", async () => {
    await expect(
      runMvpIteration(
        {
          optimizer: { propose: vi.fn(async () => proposal()) },
          taskCatalog: {
            list: vi.fn(async () => taskProfiles()),
            recordOutcomes: vi.fn(async () => undefined),
          },
          evaluator: {
            evaluateBatch: vi.fn(async (requests) =>
              requests.map((request) => observation(request, 0.5)),
            ),
          },
          sanitizer: { sanitize: vi.fn(async () => diagnosticBrief()) },
          championCache: {
            get: vi.fn(async () => null),
            put: vi.fn(async () => undefined),
          },
          artifacts: {
            persist: vi.fn(async () => "/cloud/experiments/002-missing-panel"),
          },
        },
        {
          experimentNumber: 2,
          slug: "missing-panel",
          championRevision: "a".repeat(40),
          environment: environment(),
          previousOutcome: "reject",
          previousDiagnosticBrief: diagnosticBrief(),
        },
      ),
    ).rejects.toThrow(/retain the preceding hidden panel/u);
  });
});

function taskProfiles(): readonly HiddenTaskProfile[] {
  return Array.from({ length: 8 }, (_, index) => ({
    handle: hiddenTaskHandle(digest(index + 1)),
    revisionDigest: digest(index + 101),
    difficulty: index === 7 ? ("easy" as const) : ("hard" as const),
    easyCanary: index === 7,
    baselineFailureRate: 0.8,
    leaderboardFailureRate: 0.8,
    previousFailureRate: 0.8,
    uncertainty: 0.5,
    underexposure: index === 7 ? 1 : 0.5,
    normalizedCost: 0.2,
    consecutiveSelections: 0,
    sensitiveLiterals: [`actual-secret-task-${index}`],
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

function proposal() {
  return {
    hypothesisId: "generic-recovery",
    hypothesisSummary: "Generic recovery should inspect failures.",
    interventionSummary: "Improve the generic recovery policy.",
    candidateRevision: "b".repeat(40),
    changedFiles: ["packages/coding-agent/src/system-prompt.ts"],
  };
}

function observation(request: PrivateEvaluationRequest, reward: number) {
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
    rawDiagnostics: [
      {
        kind: "tool" as const,
        code: "tool-failed",
        toolName: "shell",
        message: "actual-secret-task raw grader detail",
        evidenceRefs: ["private/raw.json"],
      },
    ],
  };
}

function cachedObservation(
  key: ChampionCacheKey,
  reward: number,
): CachedChampionObservation {
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
    evaluatedAt: "2026-07-25T10:00:00.000Z",
    traceArtifactRefs: ["private/cached-trace.json"],
    rawDiagnostics: [],
  };
}

function diagnosticBrief(): SanitizedDiagnosticBrief {
  return {
    schemaVersion: MVP_SCHEMA_VERSION,
    policyVersion: "closed-vocabulary-task-free-v1",
    cards: [
      {
        category: "error-recovery",
        toolClass: "shell",
        cause: "nonzero-exit-not-inspected",
        intervention: "inspect-before-retry",
        affectedArm: "candidate",
        direction: "candidate-worse",
        supportBand: "medium",
        confidenceBand: "medium",
      },
    ],
    containsTaskIdentifiers: false,
    containsTaskLiterals: false,
    containsGraderSecrets: false,
    containsPerTaskOutcomes: false,
  };
}

function digest(value: number): string {
  return sha256(`fixture-${value}`);
}
