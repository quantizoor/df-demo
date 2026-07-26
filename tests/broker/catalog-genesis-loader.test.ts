import { describe, expect, it } from "vitest";

import {
  TrustedCatalogGenesisLoaderError,
  TrustedTerminalBenchCatalogGenesisLoader,
  type TrustedCatalogInventoryQuery,
  type TrustedCatalogObservationQuery,
  type TrustedTerminalBenchCatalogMaterialSource,
} from "../../src/broker/catalog-genesis-loader.js";
import {
  computeTrustedTaskInventoryHash,
  computeTrustedTaskObservationSetHash,
  type TrustedTaskObservationSet,
  type TrustedTerminalBenchTaskInventory,
} from "../../src/broker/catalog-import.js";
import { canonicalHash } from "../../src/schemas/canonical.js";
import {
  hashTerminalBench21Pin,
  type TerminalBench21Pin,
} from "../../src/terminal-bench/pin.js";

const pin: TerminalBench21Pin = {
  benchmark: "terminal-bench-2.1",
  dataset: "terminal-bench/terminal-bench-2-1",
  registryRevision: 6,
  taskCount: 89,
  datasetContentSha256: "1".repeat(64),
  datasetManifestSha256: "2".repeat(64),
  harborVersion: "0.20.0",
  harborPackageSha256: "3".repeat(64),
  harborExecutableSha256: "4".repeat(64),
  piHarborAdapterSha256: "5".repeat(64),
};

const BASELINE_COMMITMENT = "6".repeat(64);
const LEADERBOARD_COMMITMENT = "7".repeat(64);

function inventory(): TrustedTerminalBenchTaskInventory {
  const unsigned = {
    sensitivity:
      "trusted-terminal-bench-task-inventory" as const,
    schemaVersion: 1 as const,
    datasetPinHash: hashTerminalBench21Pin(pin),
    registryRevision: 6 as const,
    taskCount: 89 as const,
    createdAt: "2026-07-26T00:00:00.000Z",
    tasks: Array.from({ length: 89 }, (_, index) => ({
      packageTaskName: `synthetic-benchmark/case-${String(index + 1).padStart(3, "0")}`,
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

function observations(
  sourceKind: TrustedTaskObservationSet["sourceKind"],
  sourceCommitment: string,
): TrustedTaskObservationSet {
  const task = inventory().tasks[0]!;
  const unsigned = {
    sensitivity: "trusted-task-observation-set" as const,
    schemaVersion: 1 as const,
    sourceKind,
    sourceCommitment,
    datasetPinHash: hashTerminalBench21Pin(pin),
    registryRevision: 6 as const,
    observedAt: "2026-07-26T00:30:00.000Z",
    rows: [
      {
        packageTaskName: task.packageTaskName,
        taskRevisionDigest: task.taskRevisionDigest,
        validAttempts: 3,
        passedAttempts:
          sourceKind === "initial-pi-baseline" ? 0 : 1,
        meanReward:
          sourceKind === "initial-pi-baseline" ? 0 : 1 / 3,
        meanLatencyMs: 25_000,
        meanCostUsd: 0.2,
      },
    ],
  };
  return {
    ...unsigned,
    observationSetHash:
      computeTrustedTaskObservationSetHash(unsigned),
  };
}

function source(input: {
  readonly onInventory?: (
    query: TrustedCatalogInventoryQuery,
  ) => void;
  readonly onObservation?: (
    query: TrustedCatalogObservationQuery,
  ) => void;
  readonly detachedBaseline?: boolean;
} = {}): TrustedTerminalBenchCatalogMaterialSource {
  return {
    boundary:
      "trusted-cloud-terminal-bench-catalog-material-source",
    async loadInventory(query) {
      input.onInventory?.(query);
      return inventory();
    },
    async loadObservations(query) {
      input.onObservation?.(query);
      return observations(
        query.sourceKind,
        input.detachedBaseline === true &&
          query.sourceKind === "initial-pi-baseline"
          ? "8".repeat(64)
          : query.sourceCommitment,
      );
    },
  };
}

describe("trusted Terminal-Bench catalog genesis loader", () => {
  it("loads exact pinned material once and releases hashes only", async () => {
    const inventoryQueries: TrustedCatalogInventoryQuery[] = [];
    const observationQueries: TrustedCatalogObservationQuery[] = [];
    const materialSource = source({
      onInventory: (query) => inventoryQueries.push(query),
      onObservation: (query) => observationQueries.push(query),
    });
    const loader = new TrustedTerminalBenchCatalogGenesisLoader({
      pin,
      source: materialSource,
      initialPiBaselineCommitment: BASELINE_COMMITMENT,
      comparableLeaderboardCommitment:
        LEADERBOARD_COMMITMENT,
    });
    const loaded = await loader.loadOnce();

    expect(loaded.hiddenImport.seeds).toHaveLength(89);
    expect(inventoryQueries).toHaveLength(1);
    expect(observationQueries).toHaveLength(2);
    const inventoryQuery = inventoryQueries[0]!;
    expect(inventoryQuery.queryHash).toBe(
      canonicalHash({
        schemaVersion: inventoryQuery.schemaVersion,
        domain: inventoryQuery.domain,
        datasetPinHash: inventoryQuery.datasetPinHash,
        datasetContentSha256:
          inventoryQuery.datasetContentSha256,
        datasetManifestSha256:
          inventoryQuery.datasetManifestSha256,
        registryRevision: inventoryQuery.registryRevision,
        expectedTaskCount: inventoryQuery.expectedTaskCount,
      }),
    );
    const released = JSON.stringify(loaded.releaseSafeReceipt);
    expect(released).not.toContain("synthetic-benchmark");
    expect(released).not.toContain("case-001");
    expect(Object.keys(loaded)).not.toContain("hiddenImport");
    expect(JSON.stringify(loaded)).not.toContain(
      "synthetic-benchmark",
    );
    expect({ ...loaded }).not.toHaveProperty("hiddenImport");
    expect(loaded.hiddenImport.seeds).toHaveLength(89);
    expect(loaded.releaseSafeReceipt).toMatchObject({
      taskCount: 89,
      containsTaskNames: false,
      containsTaskIdentifiers: false,
      containsObservationRows: false,
    });
    await expect(loader.loadOnce()).rejects.toBeInstanceOf(
      TrustedCatalogGenesisLoaderError,
    );
  });

  it("captures the trusted source before later dependency mutation", async () => {
    const materialSource = source();
    const loader = new TrustedTerminalBenchCatalogGenesisLoader({
      pin,
      source: materialSource,
      initialPiBaselineCommitment: null,
      comparableLeaderboardCommitment: null,
    });
    (
      materialSource as unknown as {
        loadInventory: () => Promise<never>;
      }
    ).loadInventory = async () => {
      throw new Error("redirected");
    };

    await expect(loader.loadOnce()).resolves.toMatchObject({
      sensitivity: "trusted-hidden-catalog-genesis-material",
    });
  });

  it("rejects a detached observation and burns the loader", async () => {
    const loader = new TrustedTerminalBenchCatalogGenesisLoader({
      pin,
      source: source({ detachedBaseline: true }),
      initialPiBaselineCommitment: BASELINE_COMMITMENT,
      comparableLeaderboardCommitment: null,
    });

    await expect(loader.loadOnce()).rejects.toBeInstanceOf(
      TrustedCatalogGenesisLoaderError,
    );
    await expect(loader.loadOnce()).rejects.toBeInstanceOf(
      TrustedCatalogGenesisLoaderError,
    );
  });

  it("rejects a dataset revision other than the sealed 2.1 revision", () => {
    expect(
      () =>
        new TrustedTerminalBenchCatalogGenesisLoader({
          pin: { ...pin, registryRevision: 7 },
          source: source(),
          initialPiBaselineCommitment: null,
          comparableLeaderboardCommitment: null,
        }),
    ).toThrow(TrustedCatalogGenesisLoaderError);
  });
});
