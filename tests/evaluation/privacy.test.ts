import { describe, expect, it } from "vitest";
import {
  assertReleaseContainsNoLiterals,
  createPrivacyBudget,
  type PrivateBehaviorObservation,
  releaseBehaviorCards,
} from "../../src/evaluation/index.js";
import { behaviorWithFailure, behaviorWithoutFailure, digest, taskId } from "./fixtures.js";

describe("aggregate evidence privacy firewall", () => {
  it("releases only statistically supported aggregate cards", () => {
    const result = releaseBehaviorCards({
      observations: pairedObservations(1, 12),
      comparison: "candidate-vs-champion",
      experimentDigest: digest(1_001),
      analysisWindowDigest: digest(2_001),
      privacyState: createPrivacyBudget(5),
      forbiddenLiterals: ["actual-task-name", "/hidden/task/path", "private-package-name"],
    });
    expect(result.release.suppression).toBe("none");
    expect(result.release.cards.length).toBeGreaterThan(0);
    expect(result.release.cards.some((card) => card.feature === "invalid-tool-invocation")).toBe(
      true,
    );
    const serialized = JSON.stringify(result.release);
    expect(serialized).not.toContain("taskId");
    expect(serialized).not.toContain(digest(1));
    expect(serialized).not.toContain("actual-task-name");
    expect(result.release.cards[0]?.totalSupportBand).toBe("20-49");
    expect(result.nextPrivacyState.releasesUsed).toBe(1);
  });

  it("suppresses repair-sized and imbalanced findings", () => {
    const tooSmall = releaseBehaviorCards({
      observations: pairedObservations(1, 5),
      comparison: "candidate-vs-champion",
      experimentDigest: digest(1_001),
      analysisWindowDigest: digest(2_001),
      privacyState: createPrivacyBudget(5),
    });
    expect(tooSmall.release.suppression).toBe("insufficient-total-support");

    const imbalanced = releaseBehaviorCards({
      observations: Array.from({ length: 20 }, (_, index) => ({
        taskId: taskId((index % 5) + 1),
        arm: index < 4 ? ("candidate" as const) : ("champion" as const),
        outcome: "fail" as const,
        behavior: behaviorWithFailure(),
      })),
      comparison: "candidate-vs-champion",
      experimentDigest: digest(1_002),
      analysisWindowDigest: digest(2_002),
      privacyState: createPrivacyBudget(5),
    });
    expect(imbalanced.release.suppression).toBe("insufficient-group-support");
  });

  it("does not let repeated trajectories from one task fake cluster support", () => {
    const observations: PrivateBehaviorObservation[] = [
      ...Array.from({ length: 10 }, () => ({
        taskId: taskId(1),
        arm: "candidate" as const,
        outcome: "fail" as const,
        behavior: behaviorWithFailure(),
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        taskId: taskId(index + 2),
        arm: "champion" as const,
        outcome: "pass" as const,
        behavior: behaviorWithoutFailure(),
      })),
    ];
    const result = releaseBehaviorCards({
      observations,
      comparison: "candidate-vs-champion",
      experimentDigest: digest(1_003),
      analysisWindowDigest: digest(2_003),
      privacyState: createPrivacyBudget(5),
    });
    expect(result.release.suppression).toBe("insufficient-group-support");
  });

  it("blocks overlapping windows whose complement is smaller than five tasks", () => {
    const first = releaseBehaviorCards({
      observations: pairedObservations(1, 12),
      comparison: "candidate-vs-champion",
      experimentDigest: digest(1_001),
      analysisWindowDigest: digest(2_001),
      privacyState: createPrivacyBudget(5),
    });
    const differenced = releaseBehaviorCards({
      observations: pairedObservations(3, 12),
      comparison: "candidate-vs-champion",
      experimentDigest: digest(1_002),
      analysisWindowDigest: digest(2_002),
      privacyState: first.nextPrivacyState,
    });
    expect(differenced.release.suppression).toBe("differencing-risk");
    expect(differenced.release.cards).toEqual([]);
    expect(differenced.nextPrivacyState).toBe(first.nextPrivacyState);
  });

  it("enforces one release per experiment and the cumulative release budget", () => {
    const budget = createPrivacyBudget(1);
    const first = releaseBehaviorCards({
      observations: pairedObservations(1, 12),
      comparison: "candidate-vs-champion",
      experimentDigest: digest(1_001),
      analysisWindowDigest: digest(2_001),
      privacyState: budget,
    });
    const exhausted = releaseBehaviorCards({
      observations: pairedObservations(20, 12),
      comparison: "candidate-vs-champion",
      experimentDigest: digest(1_002),
      analysisWindowDigest: digest(2_002),
      privacyState: first.nextPrivacyState,
    });
    expect(exhausted.release.suppression).toBe("release-budget-exhausted");

    const duplicate = releaseBehaviorCards({
      observations: pairedObservations(1, 12),
      comparison: "candidate-vs-champion",
      experimentDigest: digest(1_001),
      analysisWindowDigest: digest(2_003),
      privacyState: { ...first.nextPrivacyState, maximumReleases: 2 },
    });
    expect(duplicate.release.suppression).toBe("already-released");
  });

  it("suppresses candidate/champion behavior from unmatched hidden task sets", () => {
    const observations = pairedObservations(1, 12).filter(
      (observation) => !(observation.arm === "champion" && observation.taskId === taskId(12)),
    );
    observations.push({
      taskId: taskId(13),
      arm: "champion",
      outcome: "pass",
      behavior: behaviorWithoutFailure(),
    });
    const result = releaseBehaviorCards({
      observations,
      comparison: "candidate-vs-champion",
      experimentDigest: digest(1_004),
      analysisWindowDigest: digest(2_004),
      privacyState: createPrivacyBudget(5),
    });
    expect(result.release.suppression).toBe("unmatched-comparison");
    expect(result.nextPrivacyState.releasesUsed).toBe(0);
  });

  it("rejects malformed, replayable, or overlapping privacy ledgers", () => {
    const first = releaseBehaviorCards({
      observations: pairedObservations(1, 12),
      comparison: "candidate-vs-champion",
      experimentDigest: digest(1_005),
      analysisWindowDigest: digest(2_005),
      privacyState: createPrivacyBudget(5),
    });
    expect(() =>
      releaseBehaviorCards({
        observations: pairedObservations(20, 12),
        comparison: "candidate-vs-champion",
        experimentDigest: digest(1_006),
        analysisWindowDigest: digest(2_006),
        privacyState: {
          ...first.nextPrivacyState,
          releasesUsed: 0,
        },
      }),
    ).toThrow(/privacy-budget state/u);
    expect(() =>
      releaseBehaviorCards({
        observations: pairedObservations(20, 12),
        comparison: "candidate-vs-champion",
        experimentDigest: digest(1_006),
        analysisWindowDigest: digest(2_006),
        privacyState: {
          ...first.nextPrivacyState,
          releasesUsed: 2,
          priorReleases: [
            ...first.nextPrivacyState.priorReleases,
            {
              experimentDigest: digest(1_007),
              analysisWindowDigest: digest(2_007),
              taskIds: first.nextPrivacyState.priorReleases[0]?.taskIds ?? [],
            },
          ],
        },
      }),
    ).toThrow(/task-disjoint/u);
  });

  it("rejects URLs, paths, environment names, stable tokens, and known literals", () => {
    expect(() =>
      assertReleaseContainsNoLiterals({ statement: "see https://private.invalid" }, []),
    ).toThrow(/literal shape/u);
    expect(() =>
      assertReleaseContainsNoLiterals({ statement: "use /private/task/file" }, []),
    ).toThrow(/literal shape/u);
    expect(() => assertReleaseContainsNoLiterals({ statement: "SECRET_API_KEY" }, [])).toThrow(
      /literal shape/u,
    );
    expect(() => assertReleaseContainsNoLiterals({ statement: digest(500) }, [])).toThrow(
      /literal shape/u,
    );
    expect(() =>
      assertReleaseContainsNoLiterals({ statement: "private package" }, ["private package"]),
    ).toThrow(/source literal/u);
  });
});

function pairedObservations(startTask: number, taskCount: number): PrivateBehaviorObservation[] {
  return Array.from({ length: taskCount }, (_, offset) => {
    const hiddenId = taskId(startTask + offset);
    return [
      {
        taskId: hiddenId,
        arm: "candidate" as const,
        outcome: "fail" as const,
        behavior: behaviorWithFailure(),
      },
      {
        taskId: hiddenId,
        arm: "champion" as const,
        outcome: "pass" as const,
        behavior: behaviorWithoutFailure(),
      },
    ];
  }).flat();
}
