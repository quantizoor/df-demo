import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  allocateValidationQuotas,
  countFreshValidationPanels,
  type HiddenTaskLedgerEntry,
  initialValidationQuotaCarry,
  markShadowReservations,
  releaseSafePanelAttestation,
  reserveShadowSlices,
  type SelectionBucket,
  selectRepairPanel,
  selectRepairPanelFromSource,
  selectValidationPanel,
} from "../../src/evaluation/index.js";
import { makeTask, taskId } from "./fixtures.js";

describe("failure-weighted deterministic selection", () => {
  it("selects exactly 3 hard, 1 uncertain, and the epoch's alternating slot", () => {
    fc.assert(
      fc.property(fc.nat({ max: 10_000 }), (epoch) => {
        const panel = selectRepairPanel(repairPool(), {
          epoch,
          currentExperiment: 20,
          changedComponentRelevance: {},
        });
        expect(panel.tasks).toHaveLength(5);
        expect(panel.quota.hard).toBe(3);
        expect(panel.quota.uncertain).toBe(1);
        expect(panel.quota.easy).toBe(epoch % 2 === 0 ? 1 : 0);
        expect(panel.quota.coverage).toBe(epoch % 2 === 1 ? 1 : 0);
        expect(new Set(panel.tasks.map((task) => task.taskId)).size).toBe(5);
      }),
    );
  });

  it("converges exactly to 60/20/10/10 over ten validation panels", () => {
    let carry = initialValidationQuotaCarry();
    const totals: Record<SelectionBucket, number> = {
      hard: 0,
      uncertain: 0,
      easy: 0,
      coverage: 0,
    };
    for (let panel = 0; panel < 10; panel += 1) {
      const allocation = allocateValidationQuotas(carry);
      for (const bucket of Object.keys(totals) as SelectionBucket[]) {
        totals[bucket] += allocation.quota[bucket];
      }
      carry = allocation.nextCarry;
    }
    expect(totals).toEqual({ hard: 72, uncertain: 24, easy: 12, coverage: 12 });
    expect(carry).toEqual(initialValidationQuotaCarry());
  });

  it("prioritizes earlier failures and is exactly replayable", () => {
    const lowFailure = makeRepairEligible(
      makeTask(1, ["hard"], {
        estimates: {
          ...makeTask(1, ["hard"]).estimates,
          championFailureProbability: 0,
          baselineFailureProbability: 0,
          leaderboardFailureProbability: 0,
          recentFailureProbability: 0,
        },
      }),
    );
    const highFailure = makeRepairEligible(
      makeTask(2, ["hard"], {
        estimates: {
          ...makeTask(2, ["hard"]).estimates,
          championFailureProbability: 1,
          baselineFailureProbability: 1,
          leaderboardFailureProbability: 1,
          recentFailureProbability: 1,
        },
      }),
    );
    const pool = [
      lowFailure,
      highFailure,
      makeRepairEligible(makeTask(3, ["hard"])),
      makeRepairEligible(makeTask(4, ["hard"])),
      makeRepairEligible(makeTask(5, ["uncertain"])),
      makeRepairEligible(makeTask(6, ["easy"])),
      makeRepairEligible(makeTask(7, ["coverage"])),
    ];
    const context = { epoch: 0, currentExperiment: 9, changedComponentRelevance: {} };
    const first = selectRepairPanel(pool, context);
    const replay = selectRepairPanel([...pool].reverse(), context);
    expect(first).toEqual(replay);
    expect(first.tasks.map((task) => task.taskId)).toContain(highFailure.taskId);
    expect(first.tasks.map((task) => task.taskId)).not.toContain(lowFailure.taskId);
  });

  it("uses broker-private changed-component relevance within a bucket", () => {
    const preferred = makeRepairEligible(
      makeTask(901, ["hard"], {
        capabilityStratum: "changed-component",
        estimates: {
          ...makeTask(901, ["hard"]).estimates,
          componentRelevance: 0,
        },
      }),
    );
    const otherwiseEqual = makeRepairEligible(
      makeTask(902, ["hard"], {
        capabilityStratum: "unrelated-component",
        estimates: {
          ...makeTask(902, ["hard"]).estimates,
          componentRelevance: 0,
        },
      }),
    );
    const pool = [
      preferred,
      otherwiseEqual,
      ...repairPool()
        .filter((task) => task.buckets.includes("hard"))
        .slice(0, 2),
      ...repairPool().filter((task) => !task.buckets.includes("hard")),
    ];
    const panel = selectRepairPanel(pool, {
      epoch: 0,
      currentExperiment: 20,
      changedComponentRelevance: {
        "changed-component": 1,
        "unrelated-component": 0,
      },
    });
    const selectedIds = panel.tasks.map((task) => task.taskId);
    expect(selectedIds).toContain(preferred.taskId);
    expect(selectedIds).not.toContain(otherwiseEqual.taskId);
  });

  it("excludes repeatedly exposed non-canaries but permits declared canaries", () => {
    const repeated = makeRepairEligible(
      makeTask(1, ["hard"], {
        exposure: {
          ...makeTask(1, ["hard"]).exposure,
          consecutiveExperiments: 2,
          feedbackReleased: true,
        },
      }),
    );
    const canary = {
      ...repeated,
      taskId: taskId(99),
      regressionCanary: true,
      estimates: {
        ...repeated.estimates,
        championFailureProbability: 1,
        baselineFailureProbability: 1,
        leaderboardFailureProbability: 1,
        recentFailureProbability: 1,
        normalizedCost: 0,
        impossibleProbability: 0,
      },
    };
    const pool = repairPool().filter((task) => task.taskId !== taskId(10));
    const panel = selectRepairPanel([...pool, repeated, canary], {
      epoch: 0,
      currentExperiment: 20,
      changedComponentRelevance: {},
    });
    expect(panel.tasks.map((task) => task.taskId)).not.toContain(repeated.taskId);
    expect(panel.tasks.map((task) => task.taskId)).toContain(canary.taskId);
  });

  it("permits immediate bounded reuse from an explicit discovery source despite ordinary cooldown", () => {
    const source = repairPool().map((task) => ({
      ...task,
      exposure: {
        ...task.exposure,
        consecutiveExperiments: 2,
        repairCooldownThroughExperiment: 99,
      },
    }));
    expect(() =>
      selectRepairPanel(source, {
        epoch: 0,
        currentExperiment: 21,
        changedComponentRelevance: {},
      }),
    ).toThrow();
    expect(
      selectRepairPanelFromSource(source, {
        epoch: 0,
        currentExperiment: 21,
        changedComponentRelevance: {},
      }).tasks,
    ).toHaveLength(5);
  });

  it("keeps repair and hypothesis-informed tasks out of fresh validation", () => {
    const hypothesis = "frozen-hypothesis";
    const pool = validationPool();
    const repairTask = pool[0];
    const informed = pool[1];
    if (repairTask === undefined || informed === undefined) {
      throw new Error("Fixture pool is incomplete");
    }
    const withInformed = pool.map((task) =>
      task.taskId === informed.taskId
        ? {
            ...task,
            exposure: {
              ...task.exposure,
              informedHypothesisDigests: [hypothesis],
            },
          }
        : task,
    );
    const selection = selectValidationPanel(withInformed, {
      frozenHypothesisDigest: hypothesis,
      repairTaskIds: new Set([repairTask.taskId]),
      carry: initialValidationQuotaCarry(),
      currentExperiment: 2,
      changedComponentRelevance: {},
    });
    expect(selection.tasks).toHaveLength(12);
    expect(selection.tasks.map((task) => task.taskId)).not.toContain(repairTask.taskId);
    expect(selection.tasks.map((task) => task.taskId)).not.toContain(informed.taskId);
    expect(releaseSafePanelAttestation(selection)).not.toHaveProperty("tasks");
  });

  it("reserves two disjoint feedback-dark shadow slices before validation capacity", () => {
    const pool = largeBalancedPool(89);
    const reservation = reserveShadowSlices(pool);
    const firstIds = new Set(reservation.slices[0].tasks.map((task) => task.taskId));
    const secondIds = new Set(reservation.slices[1].tasks.map((task) => task.taskId));
    expect(firstIds.size).toBe(12);
    expect(secondIds.size).toBe(12);
    expect([...firstIds].some((task) => secondIds.has(task))).toBe(false);
    expect(reservation.slices.every((slice) => slice.stage === "shadow")).toBe(true);

    const marked = markShadowReservations(pool, reservation);
    expect(marked.filter((task) => task.shadowReserved)).toHaveLength(24);
    expect(countFreshValidationPanels(marked)).toBeLessThanOrEqual(5);
  });
});

function repairPool(): readonly HiddenTaskLedgerEntry[] {
  return [
    ...Array.from({ length: 5 }, (_, index) => makeRepairEligible(makeTask(10 + index, ["hard"]))),
    ...Array.from({ length: 3 }, (_, index) =>
      makeRepairEligible(makeTask(20 + index, ["uncertain"])),
    ),
    ...Array.from({ length: 3 }, (_, index) => makeRepairEligible(makeTask(30 + index, ["easy"]))),
    ...Array.from({ length: 3 }, (_, index) =>
      makeRepairEligible(makeTask(40 + index, ["coverage"])),
    ),
  ];
}

function validationPool(): readonly HiddenTaskLedgerEntry[] {
  const bucketCounts: Readonly<Record<SelectionBucket, number>> = {
    hard: 12,
    uncertain: 8,
    easy: 6,
    coverage: 6,
  };
  let nextId = 100;
  return (Object.keys(bucketCounts) as SelectionBucket[]).flatMap((bucket) =>
    Array.from({ length: bucketCounts[bucket] }, () => {
      nextId += 1;
      return makeTask(nextId, [bucket]);
    }),
  );
}

function largeBalancedPool(size: number): readonly HiddenTaskLedgerEntry[] {
  const cycle: readonly SelectionBucket[] = [
    "hard",
    "hard",
    "hard",
    "hard",
    "hard",
    "hard",
    "uncertain",
    "uncertain",
    "easy",
    "coverage",
  ];
  return Array.from({ length: size }, (_, index) =>
    makeTask(1_000 + index, [cycle[index % cycle.length] ?? "hard"]),
  );
}

function makeRepairEligible(task: HiddenTaskLedgerEntry): HiddenTaskLedgerEntry {
  return {
    ...task,
    exposure: { ...task.exposure, feedbackReleased: true },
  };
}
