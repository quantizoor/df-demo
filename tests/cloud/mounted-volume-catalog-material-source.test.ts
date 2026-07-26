import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createTrustedCatalogInventoryQuery,
  createTrustedCatalogObservationQuery,
  TrustedTerminalBenchCatalogGenesisLoader,
} from "../../src/broker/catalog-genesis-loader.js";
import {
  computeTrustedTaskInventoryHash,
  computeTrustedTaskObservationSetHash,
  type TrustedTaskObservationSet,
  type TrustedTerminalBenchTaskInventory,
} from "../../src/broker/catalog-import.js";
import {
  type TrustedArtifactRuntimeGuard,
  VerifyingTrustedArtifactBridge,
} from "../../src/cloud/artifact-bridge.js";
import { MountedVolumeTrustedArtifactBackend } from "../../src/cloud/mounted-volume-backend.js";
import {
  createTrustedCatalogMaterialNormalizerSpec,
  createTrustedTerminalBenchCatalogMaterialBundle,
  MountedVolumeTrustedCatalogMaterialRegistry,
  MountedVolumeTrustedCatalogMaterialRegistryError,
  type TrustedTerminalBenchCatalogMaterialBundle,
} from "../../src/cloud/mounted-volume-catalog-material-source.js";
import type {
  MountedVolumeDurableStateOptions,
  MountedVolumeStateSemanticsGuard,
} from "../../src/cloud/mounted-volume-state.js";
import { VerifyingTrustedJsonArtifactReader } from "../../src/cloud/trusted-json-reader.js";
import {
  canonicalHash,
  canonicalJson,
} from "../../src/schemas/canonical.js";
import {
  hashTerminalBench21Pin,
  type TerminalBench21Pin,
} from "../../src/terminal-bench/pin.js";

const NOW = "2026-07-26T12:00:00.000Z";
const BASELINE_COMMITMENT = "6".repeat(64);
const LEADERBOARD_COMMITMENT = "7".repeat(64);

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

const runtimeGuard: TrustedArtifactRuntimeGuard = {
  assertTrustedCloudRuntime() {},
};

const semanticsGuard: MountedVolumeStateSemanticsGuard = {
  assertLinearizableStateVolume() {},
};

function durableState(
  root: string,
): MountedVolumeDurableStateOptions {
  return {
    volumeRoot: root,
    storeId: "catalog-material-test",
    controllerInstanceIdHash: "8".repeat(64),
    runtimeGuard,
    semanticsGuard,
    now: () => new Date(NOW),
    nonceFactory: () => "a".repeat(48),
  };
}

function inventoryFor(
  selectedPin: TerminalBench21Pin = pin,
  createdAt = NOW,
): TrustedTerminalBenchTaskInventory {
  const unsigned = {
    sensitivity:
      "trusted-terminal-bench-task-inventory" as const,
    schemaVersion: 1 as const,
    datasetPinHash: hashTerminalBench21Pin(selectedPin),
    registryRevision: 6 as const,
    taskCount: 89 as const,
    createdAt,
    tasks: Array.from({ length: 89 }, (_, index) => ({
      packageTaskName: `synthetic-suite/case-${String(index + 1).padStart(3, "0")}`,
      taskRevisionDigest: (index + 1)
        .toString(16)
        .padStart(64, "0"),
      capabilityStratum: `capability-${index % 11}`,
      difficultyStratum:
        index % 4 === 0 ? "challenging" : "regular",
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
  selectedInventory = inventoryFor(),
): TrustedTaskObservationSet {
  const rowTask = selectedInventory.tasks[0]!;
  const unsigned = {
    sensitivity: "trusted-task-observation-set" as const,
    schemaVersion: 1 as const,
    sourceKind,
    sourceCommitment,
    datasetPinHash: selectedInventory.datasetPinHash,
    registryRevision: 6 as const,
    observedAt: NOW,
    rows: [
      {
        packageTaskName: rowTask.packageTaskName,
        taskRevisionDigest: rowTask.taskRevisionDigest,
        validAttempts: 5,
        passedAttempts:
          sourceKind === "initial-pi-baseline" ? 1 : 2,
        meanReward:
          sourceKind === "initial-pi-baseline" ? 0.2 : 0.4,
        meanLatencyMs: 20_000,
        meanCostUsd: 0.25,
      },
    ],
  };
  return {
    ...unsigned,
    observationSetHash:
      computeTrustedTaskObservationSetHash(unsigned),
  };
}

function bundle(input: {
  readonly selectedPin?: TerminalBench21Pin;
  readonly selectedInventory?: TrustedTerminalBenchTaskInventory;
  readonly baseline?: TrustedTaskObservationSet | null;
  readonly leaderboard?: TrustedTaskObservationSet | null;
} = {}): TrustedTerminalBenchCatalogMaterialBundle {
  const selectedPin = input.selectedPin ?? pin;
  const selectedInventory =
    input.selectedInventory ?? inventoryFor(selectedPin);
  return createTrustedTerminalBenchCatalogMaterialBundle({
    pin: selectedPin,
    inventory: selectedInventory,
    initialPiBaseline:
      input.baseline === undefined
        ? observations(
            "initial-pi-baseline",
            BASELINE_COMMITMENT,
            selectedInventory,
          )
        : input.baseline,
    comparableLeaderboard:
      input.leaderboard === undefined
        ? observations(
            "comparable-public-leaderboard",
            LEADERBOARD_COMMITMENT,
            selectedInventory,
          )
        : input.leaderboard,
  });
}

function canonicalBundle(
  value: TrustedTerminalBenchCatalogMaterialBundle,
): string {
  return `${canonicalJson(value)}\n`;
}

async function infrastructure() {
  const root = await mkdtemp(
    join(tmpdir(), "df-catalog-material-"),
  );
  const bridge = new VerifyingTrustedArtifactBridge(
    new MountedVolumeTrustedArtifactBackend({
      volumeRoot: join(root, "artifacts"),
      runtimeGuard,
    }),
    runtimeGuard,
  );
  const registry =
    new MountedVolumeTrustedCatalogMaterialRegistry({
      pin,
      durableState: durableState(join(root, "state")),
      bridge,
      reader: new VerifyingTrustedJsonArtifactReader(bridge),
    });
  return { registry };
}

describe("mounted-volume trusted catalog material source", () => {
  it("publishes exact hidden material and exposes only the bounded source", async () => {
    const { registry } = await infrastructure();
    const material = bundle();
    const publication = await registry.publishCanonicalBundle(
      canonicalBundle(material),
    );
    const loader = new TrustedTerminalBenchCatalogGenesisLoader({
      pin,
      source: registry.source,
      initialPiBaselineCommitment: BASELINE_COMMITMENT,
      comparableLeaderboardCommitment:
        LEADERBOARD_COMMITMENT,
    });
    const loaded = await loader.loadOnce();

    expect(loaded.hiddenImport.seeds).toHaveLength(89);
    expect(publication).toMatchObject({
      status: "published",
      taskCount: 89,
      containsTaskNames: false,
      containsTaskIdentifiers: false,
      containsObservationRows: false,
      containsArtifactLocations: false,
    });
    expect(Object.keys(registry.source).sort()).toEqual([
      "boundary",
      "loadInventory",
      "loadObservations",
    ]);
    expect(
      "list" in
        (registry.source as unknown as Record<string, unknown>),
    ).toBe(false);
    expect(
      "locate" in
        (registry.source as unknown as Record<string, unknown>),
    ).toBe(false);
    const released = JSON.stringify({
      publication,
      receipt: loaded.releaseSafeReceipt,
    });
    expect(released).not.toContain("synthetic-suite");
    expect(released).not.toContain("case-001");
    await registry.close();
  });

  it("makes exact republishing idempotent and rejects a replacement", async () => {
    const { registry } = await infrastructure();
    const first = bundle();
    const firstRaw = canonicalBundle(first);

    await expect(
      registry.publishCanonicalBundle(firstRaw),
    ).resolves.toMatchObject({ status: "published" });
    await expect(
      registry.publishCanonicalBundle(firstRaw),
    ).resolves.toMatchObject({
      status: "already-published",
    });

    const changed = bundle({
      selectedInventory: inventoryFor(
        pin,
        "2026-07-26T12:01:00.000Z",
      ),
    });
    await expect(
      registry.publishCanonicalBundle(canonicalBundle(changed)),
    ).rejects.toBeInstanceOf(
      MountedVolumeTrustedCatalogMaterialRegistryError,
    );
    await registry.close();
  });

  it("runs the generic cloud normalizer only once with the sealed spec", async () => {
    const { registry } = await infrastructure();
    const material = bundle({
      baseline: null,
      leaderboard: null,
    });
    const observedSpecs: unknown[] = [];
    const worker = {
      boundary:
        "trusted-cloud-terminal-bench-catalog-normalization-worker" as const,
      async normalize(spec: unknown) {
        observedSpecs.push(spec);
        return canonicalBundle(material);
      },
    };

    await expect(
      registry.normalizeAndPublishOnce(worker),
    ).resolves.toMatchObject({ status: "published" });
    expect(observedSpecs).toHaveLength(1);
    expect(observedSpecs[0]).toMatchObject({
      executionBoundary:
        "trusted-cloud-evaluator-only",
      registryRevision: 6,
      expectedTaskCount: 89,
      mutableAliasesAllowed: false,
      taskRowsMayLeaveTrustedArtifactStore: false,
    });
    await expect(
      registry.normalizeAndPublishOnce(worker),
    ).rejects.toBeInstanceOf(
      MountedVolumeTrustedCatalogMaterialRegistryError,
    );
    expect(observedSpecs).toHaveLength(1);
    await registry.close();
  });

  it("rejects mutable/noncanonical input and a different content pin", async () => {
    const { registry } = await infrastructure();
    const material = bundle();
    await expect(
      registry.publishCanonicalBundle(
        JSON.stringify(material),
      ),
    ).rejects.toBeInstanceOf(
      MountedVolumeTrustedCatalogMaterialRegistryError,
    );

    const otherPin: TerminalBench21Pin = {
      ...pin,
      datasetContentSha256: "9".repeat(64),
    };
    const detached = bundle({ selectedPin: otherPin });
    await expect(
      registry.publishCanonicalBundle(canonicalBundle(detached)),
    ).rejects.toBeInstanceOf(
      MountedVolumeTrustedCatalogMaterialRegistryError,
    );
    await registry.close();
  });

  it("rejects duplicate task names or revision digests before publication", () => {
    const valid = inventoryFor();
    const duplicatedTasks = valid.tasks.map((task, index) =>
      index === 1
        ? {
            ...task,
            packageTaskName:
              valid.tasks[0]!.packageTaskName,
          }
        : task,
    );
    const unsigned = {
      sensitivity: valid.sensitivity,
      schemaVersion: valid.schemaVersion,
      datasetPinHash: valid.datasetPinHash,
      registryRevision: valid.registryRevision,
      taskCount: valid.taskCount,
      createdAt: valid.createdAt,
      tasks: duplicatedTasks,
    };
    const duplicated: TrustedTerminalBenchTaskInventory = {
      ...unsigned,
      inventoryHash:
        computeTrustedTaskInventoryHash(unsigned),
    };

    expect(() =>
      bundle({ selectedInventory: duplicated }),
    ).toThrow(
      MountedVolumeTrustedCatalogMaterialRegistryError,
    );

    const duplicatedRevisionTasks = valid.tasks.map(
      (task, index) =>
        index === 1
          ? {
              ...task,
              taskRevisionDigest:
                valid.tasks[0]!.taskRevisionDigest,
            }
          : task,
    );
    const revisionUnsigned = {
      ...unsigned,
      tasks: duplicatedRevisionTasks,
    };
    expect(() =>
      bundle({
        selectedInventory: {
          ...revisionUnsigned,
          inventoryHash:
            computeTrustedTaskInventoryHash(
              revisionUnsigned,
            ),
        },
      }),
    ).toThrow(
      MountedVolumeTrustedCatalogMaterialRegistryError,
    );
  });

  it("rejects substituted inventory and observation queries", async () => {
    const { registry } = await infrastructure();
    const material = bundle({
      leaderboard: null,
    });
    await registry.publishCanonicalBundle(
      canonicalBundle(material),
    );
    const inventoryQuery = createTrustedCatalogInventoryQuery(
      pin,
      hashTerminalBench21Pin(pin),
    );
    const inventoryUnsigned = {
      schemaVersion: inventoryQuery.schemaVersion,
      domain: inventoryQuery.domain,
      datasetPinHash: inventoryQuery.datasetPinHash,
      datasetContentSha256: "9".repeat(64),
      datasetManifestSha256:
        inventoryQuery.datasetManifestSha256,
      registryRevision: inventoryQuery.registryRevision,
      expectedTaskCount:
        inventoryQuery.expectedTaskCount,
    };
    await expect(
      registry.source.loadInventory({
        ...inventoryUnsigned,
        queryHash: canonicalHash(inventoryUnsigned),
      }),
    ).rejects.toBeInstanceOf(
      MountedVolumeTrustedCatalogMaterialRegistryError,
    );

    const absentObservation =
      createTrustedCatalogObservationQuery(
        "comparable-public-leaderboard",
        LEADERBOARD_COMMITMENT,
        hashTerminalBench21Pin(pin),
        material.inventory.inventoryHash,
      );
    await expect(
      registry.source.loadObservations(absentObservation),
    ).rejects.toBeInstanceOf(
      MountedVolumeTrustedCatalogMaterialRegistryError,
    );
    await registry.close();
  });

  it("seals a cloud-only normalizer spec to the exact revision and hashes", () => {
    const spec =
      createTrustedCatalogMaterialNormalizerSpec(pin);
    expect(spec).toMatchObject({
      executionBoundary:
        "trusted-cloud-evaluator-only",
      registryRevision: 6,
      expectedTaskCount: 89,
      mutableAliasesAllowed: false,
      taskRowsMayLeaveTrustedArtifactStore: false,
    });
    expect(spec.datasetPinHash).toBe(
      hashTerminalBench21Pin(pin),
    );
    expect(spec.specHash).toBe(
      canonicalHash({
        schemaVersion: spec.schemaVersion,
        domain: spec.domain,
        executionBoundary: spec.executionBoundary,
        benchmark: spec.benchmark,
        dataset: spec.dataset,
        datasetPinHash: spec.datasetPinHash,
        datasetContentSha256:
          spec.datasetContentSha256,
        datasetManifestSha256:
          spec.datasetManifestSha256,
        registryRevision: spec.registryRevision,
        expectedTaskCount: spec.expectedTaskCount,
        outputMediaType: spec.outputMediaType,
        outputMustBeCanonicalJsonLine:
          spec.outputMustBeCanonicalJsonLine,
        mutableAliasesAllowed:
          spec.mutableAliasesAllowed,
        taskRowsMayLeaveTrustedArtifactStore:
          spec.taskRowsMayLeaveTrustedArtifactStore,
        maximumOutputBytes: spec.maximumOutputBytes,
      }),
    );
  });
});
