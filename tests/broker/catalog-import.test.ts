import { describe, expect, it } from "vitest";
import {
  buildTrustedHiddenCatalogImport,
  computeTrustedTaskInventoryHash,
  computeTrustedTaskObservationSetHash,
  TrustedCatalogImportError,
  type TrustedTaskObservationRow,
  type TrustedTaskObservationSet,
  type TrustedTerminalBenchTaskInventory,
} from "../../src/broker/catalog-import.js";

const DATASET_PIN_HASH = "a".repeat(64);

function inventory(): TrustedTerminalBenchTaskInventory {
  const unsigned = {
    sensitivity:
      "trusted-terminal-bench-task-inventory" as const,
    schemaVersion: 1 as const,
    datasetPinHash: DATASET_PIN_HASH,
    registryRevision: 6 as const,
    taskCount: 89 as const,
    createdAt: "2026-07-01T00:00:00.000Z",
    tasks: Array.from({ length: 89 }, (_, index) => ({
      packageTaskName: `terminal-bench/task-${String(index + 1).padStart(3, "0")}`,
      taskRevisionDigest: (index + 1)
        .toString(16)
        .padStart(64, "0"),
      capabilityStratum: `capability-${index % 9}`,
      difficultyStratum:
        index % 3 === 0 ? "difficult" : "moderate",
      normalizedExpectedCost: (index % 10) / 10,
      scoringEligible: true,
      infrastructureValid: true,
    })),
  };
  return {
    ...unsigned,
    inventoryHash: computeTrustedTaskInventoryHash(unsigned),
  };
}

function observationSet(
  kind: TrustedTaskObservationSet["sourceKind"],
  rows: readonly TrustedTaskObservationRow[],
): TrustedTaskObservationSet {
  const unsigned = {
    sensitivity: "trusted-task-observation-set" as const,
    schemaVersion: 1 as const,
    sourceKind: kind,
    sourceCommitment:
      kind === "initial-pi-baseline"
        ? "b".repeat(64)
        : "c".repeat(64),
    datasetPinHash: DATASET_PIN_HASH,
    registryRevision: 6 as const,
    observedAt: "2026-07-01T01:00:00.000Z",
    rows,
  };
  return {
    ...unsigned,
    observationSetHash:
      computeTrustedTaskObservationSetHash(unsigned),
  };
}

function row(
  taskIndex: number,
  validAttempts: number,
  passedAttempts: number,
): TrustedTaskObservationRow {
  return {
    packageTaskName: `terminal-bench/task-${String(taskIndex).padStart(3, "0")}`,
    taskRevisionDigest: taskIndex
      .toString(16)
      .padStart(64, "0"),
    validAttempts,
    passedAttempts,
    meanReward: passedAttempts / validAttempts,
    meanLatencyMs: 20_000,
    meanCostUsd: 0.25,
  };
}

describe("trusted hidden catalog import", () => {
  it("combines private baseline and comparable leaderboard evidence without releasing it", () => {
    const taskInventory = inventory();
    const baseline = observationSet("initial-pi-baseline", [
      row(1, 20, 0),
      row(2, 20, 20),
    ]);
    const leaderboard = observationSet(
      "comparable-public-leaderboard",
      [row(1, 20, 2), row(2, 20, 20)],
    );
    const imported = buildTrustedHiddenCatalogImport({
      expectedDatasetPinHash: DATASET_PIN_HASH,
      inventory: taskInventory,
      initialPiBaseline: baseline,
      comparableLeaderboard: leaderboard,
    });

    expect(imported.seeds).toHaveLength(89);
    expect(imported.seedSetHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      imported.seeds.every(
        (seed) =>
          seed.initialFeedbackReleased === false &&
          seed.buckets.join(",") ===
            "hard,uncertain,easy,coverage",
      ),
    ).toBe(true);
    const failing = imported.seeds.find(
      (seed) =>
        seed.packageTaskName === "terminal-bench/task-001",
    );
    const easy = imported.seeds.find(
      (seed) =>
        seed.packageTaskName === "terminal-bench/task-002",
    );
    expect(
      failing?.estimates.recentFailureProbability,
    ).toBeGreaterThan(
      easy?.estimates.recentFailureProbability ?? 1,
    );
    expect(easy?.regressionCanary).toBe(true);
  });

  it("rejects inventory, revision, duplicate-row, and source-commitment drift", () => {
    const taskInventory = inventory();
    expect(() =>
      buildTrustedHiddenCatalogImport({
        expectedDatasetPinHash: DATASET_PIN_HASH,
        inventory: {
          ...taskInventory,
          inventoryHash: "f".repeat(64),
        },
        initialPiBaseline: null,
        comparableLeaderboard: null,
      }),
    ).toThrow(TrustedCatalogImportError);

    const duplicated = observationSet("initial-pi-baseline", [
      row(1, 2, 1),
      row(1, 2, 1),
    ]);
    expect(() =>
      buildTrustedHiddenCatalogImport({
        expectedDatasetPinHash: DATASET_PIN_HASH,
        inventory: taskInventory,
        initialPiBaseline: duplicated,
        comparableLeaderboard: null,
      }),
    ).toThrow(TrustedCatalogImportError);

    const detached = observationSet(
      "comparable-public-leaderboard",
      [
        {
          ...row(1, 2, 1),
          taskRevisionDigest: "e".repeat(64),
        },
      ],
    );
    expect(() =>
      buildTrustedHiddenCatalogImport({
        expectedDatasetPinHash: DATASET_PIN_HASH,
        inventory: taskInventory,
        initialPiBaseline: null,
        comparableLeaderboard: detached,
      }),
    ).toThrow(TrustedCatalogImportError);
  });

  it("uses neutral uncertain priors when no comparable observations exist", () => {
    const imported = buildTrustedHiddenCatalogImport({
      expectedDatasetPinHash: DATASET_PIN_HASH,
      inventory: inventory(),
      initialPiBaseline: null,
      comparableLeaderboard: null,
    });
    expect(imported.seeds[0]?.estimates).toMatchObject({
      championFailureProbability: 0.5,
      baselineFailureProbability: 0.5,
      leaderboardFailureProbability: 0.5,
      recentFailureProbability: 0.5,
      underexposure: 1,
    });
  });
});
