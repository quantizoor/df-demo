import { describe, expect, it } from "vitest";
import { hiddenTaskId } from "../../src/evaluation/types.js";
import {
  createTrustedMatchedArmSchedule,
  type TrustedMatchedPanel,
} from "../../src/terminal-bench/trusted.js";

const candidate = {
  uri: "trusted://harness/candidate" as const,
  commitSha: "a".repeat(40),
  treeSha: "a".repeat(40),
  archiveSha256: "a".repeat(64),
};
const champion = {
  uri: "trusted://harness/champion" as const,
  commitSha: "b".repeat(40),
  treeSha: "b".repeat(40),
  archiveSha256: "b".repeat(64),
};

function panel(): TrustedMatchedPanel {
  return {
    sensitivity: "hidden-benchmark-panel",
    leaseId: "lease-001",
    requestId: "request-001",
    stage: "validation",
    sealedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-07-01T06:00:00.000Z",
    dispositionAttestationHash: "c".repeat(64),
    cells: Array.from({ length: 12 }, (_, index) => ({
      sensitivity: "hidden-benchmark-cell" as const,
      taskId: hiddenTaskId((index + 1).toString(16).padStart(64, "0")),
      taskRevisionDigest: (index + 20).toString(16).padStart(64, "0"),
      capabilityStratum: `stratum-${(index % 3) + 1}`,
      replicateOrdinal: 1,
      order: index % 2 === 0 ? ("AB" as const) : ("BA" as const),
    })),
  };
}

describe("hidden matched-arm schedule", () => {
  it("runs candidate and champion on the exact same twelve task/replicate cells", () => {
    const schedule = createTrustedMatchedArmSchedule(
      panel(),
      candidate,
      champion,
    );
    expect(schedule).toMatchObject({
      executionPolicy: "fresh-matched-pairs",
      cellCount: 12,
      armCount: 24,
      candidateArmCount: 12,
      championArmCount: 12,
      candidateFirstCount: 6,
      championFirstCount: 6,
    });
    for (let cellOrdinal = 0; cellOrdinal < 12; cellOrdinal += 1) {
      const pair = schedule.arms.filter((arm) => arm.cellOrdinal === cellOrdinal);
      expect(pair).toHaveLength(2);
      expect(new Set(pair.map((arm) => arm.arm))).toEqual(
        new Set(["candidate", "champion"]),
      );
      expect(new Set(pair.map((arm) => arm.taskId)).size).toBe(1);
      expect(new Set(pair.map((arm) => arm.replicateOrdinal)).size).toBe(1);
    }
  });

  it("rejects duplicate cells and unbalanced order", () => {
    const valid = panel();
    const duplicated: TrustedMatchedPanel = {
      ...valid,
      cells: [valid.cells[0]!, ...valid.cells.slice(0, 11)],
    };
    expect(() =>
      createTrustedMatchedArmSchedule(duplicated, candidate, champion),
    ).toThrow(/duplicated/u);
    const unbalanced: TrustedMatchedPanel = {
      ...valid,
      cells: valid.cells.map((cell) => ({ ...cell, order: "AB" as const })),
    };
    expect(() =>
      createTrustedMatchedArmSchedule(unbalanced, candidate, champion),
    ).toThrow(/six/u);
  });

  it("rejects identical candidate and champion harnesses", () => {
    expect(() =>
      createTrustedMatchedArmSchedule(panel(), candidate, {
        ...champion,
        commitSha: candidate.commitSha,
      }),
    ).toThrow(/distinct/u);
  });

  it("runs only the five candidate arms during repair screening", () => {
    const validationPanel = panel();
    const repairPanel: TrustedMatchedPanel = {
      ...validationPanel,
      stage: "repair",
      cells: validationPanel.cells.slice(0, 5),
    };
    const schedule = createTrustedMatchedArmSchedule(
      repairPanel,
      candidate,
      champion,
    );
    expect(schedule).toMatchObject({
      executionPolicy: "candidate-only-repair",
      cellCount: 5,
      armCount: 5,
      candidateArmCount: 5,
      championArmCount: 0,
      candidateFirstCount: 0,
      championFirstCount: 0,
    });
    expect(schedule.arms.map((arm) => arm.arm)).toEqual(
      Array.from({ length: 5 }, () => "candidate"),
    );
  });
});
