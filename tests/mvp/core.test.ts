import { describe, expect, it } from "vitest";
import {
  assertTaskFreeDiagnosticBrief,
  buildMatchedCells,
  decideMatchedComparison,
  type HiddenTaskProfile,
  hiddenTaskHandle,
  MVP_SCHEMA_VERSION,
  type PrivateEvaluationObservation,
  retainHiddenTaskPanel,
  type SanitizedDiagnosticBrief,
  selectFailureWeightedTasks,
  sha256,
  validateMvpArtifact,
} from "../../src/mvp/index.js";

describe("MVP hidden selection", () => {
  it("is deterministic, failure-weighted, distinct, and always retains one easy canary", () => {
    const profiles = taskProfiles();
    const selected = selectFailureWeightedTasks(profiles);
    const replay = selectFailureWeightedTasks([...profiles].reverse());

    expect(selected).toEqual(replay);
    expect(selected).toHaveLength(5);
    expect(new Set(selected.map((task) => task.handle)).size).toBe(5);
    expect(selected.filter((task) => task.easyCanary)).toHaveLength(1);
    expect(selected.map((task) => task.handle)).toContain(profiles[0]?.handle);

    const cells = buildMatchedCells("001-change-system-prompt", selected);
    expect(cells).toHaveLength(15);
    expect(new Set(cells.map((cell) => cell.cellId)).size).toBe(15);
    for (const task of selected) {
      expect(cells.filter((cell) => cell.task.handle === task.handle)).toHaveLength(3);
    }
  });

  it("fails closed without enough core tasks or an easy canary", () => {
    expect(() =>
      selectFailureWeightedTasks(taskProfiles().filter((profile) => !profile.easyCanary)),
    ).toThrow(/canary/u);
    const profiles = taskProfiles();
    expect(() => selectFailureWeightedTasks([...profiles.slice(0, 3), profiles[7]!])).toThrow(
      /four non-canary/u,
    );
  });

  it("retains the exact opaque panel even when other task weights change", () => {
    const profiles = taskProfiles();
    const first = selectFailureWeightedTasks(profiles);
    const retained = retainHiddenTaskPanel(
      profiles.map((profile, index) => ({
        ...profile,
        previousFailureRate: index === 6 ? 1 : 0,
      })),
      first.map((task) => task.handle),
    );

    expect(retained.map((task) => task.handle)).toEqual(first.map((task) => task.handle));
    expect(retained.filter((task) => task.easyCanary)).toHaveLength(1);
  });
});

describe("MVP matched decision", () => {
  it("promotes only a confident, fresh, task-clustered improvement", () => {
    const cells = buildMatchedCells(
      "001-change-system-prompt",
      selectFailureWeightedTasks(taskProfiles()),
    );
    const candidate = observations(cells, "candidate", 1, "fresh");
    const freshChampion = observations(cells, "champion", 0, "fresh");
    const cachedChampion = observations(cells, "champion", 0, "champion-cache");

    const promoted = decideMatchedComparison({
      cells,
      candidate,
      champion: freshChampion,
    });
    expect(promoted.disposition).toBe("promote");
    expect(promoted.confidenceCandidateBetter).toBe(0.96875);
    expect(promoted.taskWins).toBe(5);
    expect(promoted).not.toHaveProperty("tasks");

    const screened = decideMatchedComparison({
      cells,
      candidate,
      champion: cachedChampion,
    });
    expect(screened.disposition).toBe("inconclusive");
    expect(screened.reason).toBe("fresh-evidence-required");
    expect(screened.evidenceFresh).toBe(false);
  });

  it("rejects a confident regression and refuses unmatched evidence", () => {
    const cells = buildMatchedCells(
      "001-change-system-prompt",
      selectFailureWeightedTasks(taskProfiles()),
    );
    const rejected = decideMatchedComparison({
      cells,
      candidate: observations(cells, "candidate", 0, "fresh"),
      champion: observations(cells, "champion", 1, "champion-cache"),
    });
    expect(rejected.disposition).toBe("reject");

    expect(() =>
      decideMatchedComparison({
        cells,
        candidate: observations(cells, "candidate", 1, "fresh").slice(1),
        champion: observations(cells, "champion", 0, "fresh"),
      }),
    ).toThrow(/fifteen/u);
  });
});

describe("MVP diagnostic release", () => {
  it("accepts only strict, task-free closed-vocabulary cards", () => {
    const brief = diagnosticBrief();
    expect(() => assertTaskFreeDiagnosticBrief(brief, ["actual-secret-task"])).not.toThrow();
    expect(() =>
      validateMvpArtifact("diagnostics", {
        ...brief,
        leakedTask: "anything",
      }),
    ).toThrow(/additional properties/u);
    expect(() => assertTaskFreeDiagnosticBrief(brief, ["tool-invocation"])).toThrow(
      /hidden source literal/u,
    );
  });
});

function taskProfiles(): readonly HiddenTaskProfile[] {
  return Array.from({ length: 8 }, (_, index) => ({
    handle: hiddenTaskHandle(digest(index + 1)),
    revisionDigest: digest(index + 101),
    difficulty:
      index === 7 ? ("easy" as const) : index < 4 ? ("hard" as const) : ("medium" as const),
    easyCanary: index === 7,
    baselineFailureRate: index === 0 ? 1 : 0.5,
    leaderboardFailureRate: index === 0 ? 1 : 0.5,
    previousFailureRate: index === 0 ? 1 : 0.5,
    uncertainty: 0.5,
    underexposure: index === 7 ? 1 : 0.5,
    normalizedCost: 0.2,
    consecutiveSelections: 0,
    sensitiveLiterals: [`actual-secret-task-${index}`],
  }));
}

function observations(
  cells: ReturnType<typeof buildMatchedCells>,
  arm: "candidate" | "champion",
  reward: number,
  source: "fresh" | "champion-cache",
): readonly PrivateEvaluationObservation[] {
  return cells.map((cell) => ({
    schemaVersion: MVP_SCHEMA_VERSION,
    experimentId: "001-change-system-prompt",
    cellId: cell.cellId,
    taskHandle: cell.task.handle,
    taskRevisionDigest: cell.task.revisionDigest,
    repetition: cell.repetition,
    arm,
    harnessRevision: arm === "candidate" ? "b".repeat(40) : "a".repeat(40),
    environmentDigest: digest(999),
    source,
    passed: reward === 1,
    reward,
    infrastructureValid: true,
    durationMs: 100,
    evaluatedAt: "2026-07-26T10:00:00.000Z",
    traceArtifactRefs: ["private/trace.json"],
    rawDiagnostics: [],
  }));
}

function diagnosticBrief(): SanitizedDiagnosticBrief {
  return {
    schemaVersion: MVP_SCHEMA_VERSION,
    policyVersion: "closed-vocabulary-task-free-v1",
    cards: [
      {
        category: "tool-invocation",
        toolClass: "shell",
        cause: "invalid-arguments",
        intervention: "validate-tool-arguments",
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
