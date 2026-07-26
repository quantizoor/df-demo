import type { HiddenTaskEstimates } from "../evaluation/types.js";
import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import type { TrustedHiddenTaskSeed } from "./catalog.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_PACKAGE_TASK_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TASK_COUNT = 89;
const INVENTORY_KEYS = [
  "sensitivity",
  "schemaVersion",
  "datasetPinHash",
  "registryRevision",
  "taskCount",
  "createdAt",
  "tasks",
  "inventoryHash",
] as const;
const INVENTORY_TASK_KEYS = [
  "packageTaskName",
  "taskRevisionDigest",
  "capabilityStratum",
  "difficultyStratum",
  "normalizedExpectedCost",
  "scoringEligible",
  "infrastructureValid",
] as const;
const OBSERVATION_SET_KEYS = [
  "sensitivity",
  "schemaVersion",
  "sourceKind",
  "sourceCommitment",
  "datasetPinHash",
  "registryRevision",
  "observedAt",
  "rows",
  "observationSetHash",
] as const;
const OBSERVATION_ROW_KEYS = [
  "packageTaskName",
  "taskRevisionDigest",
  "validAttempts",
  "passedAttempts",
  "meanReward",
  "meanLatencyMs",
  "meanCostUsd",
] as const;
const IMPORT_RESULT_KEYS = [
  "sensitivity",
  "datasetPinHash",
  "inventoryHash",
  "baselineObservationSetHash",
  "leaderboardObservationSetHash",
  "seedSetHash",
  "seeds",
] as const;

export interface TrustedTerminalBenchInventoryTask {
  readonly packageTaskName: string;
  readonly taskRevisionDigest: string;
  readonly capabilityStratum: string;
  readonly difficultyStratum: string;
  readonly normalizedExpectedCost: number;
  readonly scoringEligible: boolean;
  readonly infrastructureValid: boolean;
}

export interface TrustedTerminalBenchTaskInventory {
  readonly sensitivity: "trusted-terminal-bench-task-inventory";
  readonly schemaVersion: 1;
  readonly datasetPinHash: string;
  readonly registryRevision: 6;
  readonly taskCount: 89;
  readonly createdAt: string;
  readonly tasks: readonly TrustedTerminalBenchInventoryTask[];
  readonly inventoryHash: string;
}

export interface TrustedTaskObservationRow {
  readonly packageTaskName: string;
  readonly taskRevisionDigest: string;
  readonly validAttempts: number;
  readonly passedAttempts: number;
  readonly meanReward: number;
  readonly meanLatencyMs: number;
  readonly meanCostUsd: number;
}

export interface TrustedTaskObservationSet {
  readonly sensitivity: "trusted-task-observation-set";
  readonly schemaVersion: 1;
  readonly sourceKind: "initial-pi-baseline" | "comparable-public-leaderboard";
  readonly sourceCommitment: string;
  readonly datasetPinHash: string;
  readonly registryRevision: 6;
  readonly observedAt: string;
  readonly rows: readonly TrustedTaskObservationRow[];
  readonly observationSetHash: string;
}

export interface TrustedHiddenCatalogImport {
  readonly sensitivity: "trusted-hidden-catalog-import";
  readonly datasetPinHash: string;
  readonly inventoryHash: string;
  readonly baselineObservationSetHash: string | null;
  readonly leaderboardObservationSetHash: string | null;
  readonly seedSetHash: string;
  readonly seeds: readonly TrustedHiddenTaskSeed[];
}

export class TrustedCatalogImportError extends Error {
  override readonly name = "TrustedCatalogImportError";
}

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new TrustedCatalogImportError(
      "Trusted catalog import input contains unsupported fields.",
    );
  }
}

function finiteUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function inventoryHashPayload(
  inventory: Omit<TrustedTerminalBenchTaskInventory, "inventoryHash">,
): Readonly<Record<string, unknown>> {
  return {
    sensitivity: inventory.sensitivity,
    schemaVersion: inventory.schemaVersion,
    datasetPinHash: inventory.datasetPinHash,
    registryRevision: inventory.registryRevision,
    taskCount: inventory.taskCount,
    createdAt: inventory.createdAt,
    tasks: inventory.tasks,
  };
}

export function computeTrustedTaskInventoryHash(
  inventory: Omit<TrustedTerminalBenchTaskInventory, "inventoryHash">,
): string {
  return canonicalHash({
    domain: "dark-factory.terminal-bench-task-inventory.v1",
    inventory: inventoryHashPayload(inventory),
  });
}

function observationHashPayload(
  observations: Omit<TrustedTaskObservationSet, "observationSetHash">,
): Readonly<Record<string, unknown>> {
  return {
    sensitivity: observations.sensitivity,
    schemaVersion: observations.schemaVersion,
    sourceKind: observations.sourceKind,
    sourceCommitment: observations.sourceCommitment,
    datasetPinHash: observations.datasetPinHash,
    registryRevision: observations.registryRevision,
    observedAt: observations.observedAt,
    rows: observations.rows,
  };
}

export function computeTrustedTaskObservationSetHash(
  observations: Omit<TrustedTaskObservationSet, "observationSetHash">,
): string {
  return canonicalHash({
    domain: "dark-factory.task-observation-set.v1",
    observations: observationHashPayload(observations),
  });
}

function assertInventory(
  inventory: TrustedTerminalBenchTaskInventory,
  expectedDatasetPinHash: string,
): void {
  exactKeys(inventory, INVENTORY_KEYS);
  if (
    inventory.sensitivity !== "trusted-terminal-bench-task-inventory" ||
    inventory.schemaVersion !== 1 ||
    inventory.datasetPinHash !== expectedDatasetPinHash ||
    !SHA256.test(inventory.datasetPinHash) ||
    inventory.registryRevision !== 6 ||
    inventory.taskCount !== TASK_COUNT ||
    inventory.tasks.length !== TASK_COUNT ||
    !Number.isFinite(Date.parse(inventory.createdAt))
  ) {
    throw new TrustedCatalogImportError(
      "Terminal-Bench inventory does not match the exact trusted pin.",
    );
  }
  const names = new Set<string>();
  const revisions = new Set<string>();
  for (const task of inventory.tasks) {
    exactKeys(task, INVENTORY_TASK_KEYS);
    if (
      !SAFE_PACKAGE_TASK_NAME.test(task.packageTaskName) ||
      !SHA256.test(task.taskRevisionDigest) ||
      !SAFE_ID.test(task.capabilityStratum) ||
      !SAFE_ID.test(task.difficultyStratum) ||
      !finiteUnit(task.normalizedExpectedCost) ||
      typeof task.scoringEligible !== "boolean" ||
      typeof task.infrastructureValid !== "boolean" ||
      names.has(task.packageTaskName) ||
      revisions.has(task.taskRevisionDigest)
    ) {
      throw new TrustedCatalogImportError(
        "Terminal-Bench inventory contains an invalid or duplicate task.",
      );
    }
    names.add(task.packageTaskName);
    revisions.add(task.taskRevisionDigest);
  }
  const { inventoryHash, ...unsigned } = inventory;
  if (inventoryHash !== computeTrustedTaskInventoryHash(unsigned)) {
    throw new TrustedCatalogImportError("Terminal-Bench inventory commitment does not reproduce.");
  }
}

function assertObservationSet(
  observations: TrustedTaskObservationSet,
  expectedKind: TrustedTaskObservationSet["sourceKind"],
  inventory: TrustedTerminalBenchTaskInventory,
): void {
  exactKeys(observations, OBSERVATION_SET_KEYS);
  if (
    observations.sensitivity !== "trusted-task-observation-set" ||
    observations.schemaVersion !== 1 ||
    observations.sourceKind !== expectedKind ||
    !SHA256.test(observations.sourceCommitment) ||
    observations.datasetPinHash !== inventory.datasetPinHash ||
    observations.registryRevision !== inventory.registryRevision ||
    !Number.isFinite(Date.parse(observations.observedAt)) ||
    observations.rows.length > TASK_COUNT
  ) {
    throw new TrustedCatalogImportError(
      "A trusted observation set is detached from the inventory.",
    );
  }
  const inventoryByName = new Map(inventory.tasks.map((task) => [task.packageTaskName, task]));
  const names = new Set<string>();
  for (const row of observations.rows) {
    exactKeys(row, OBSERVATION_ROW_KEYS);
    const task = inventoryByName.get(row.packageTaskName);
    if (
      task === undefined ||
      row.taskRevisionDigest !== task.taskRevisionDigest ||
      names.has(row.packageTaskName) ||
      !Number.isSafeInteger(row.validAttempts) ||
      row.validAttempts < 1 ||
      !Number.isSafeInteger(row.passedAttempts) ||
      row.passedAttempts < 0 ||
      row.passedAttempts > row.validAttempts ||
      !finiteUnit(row.meanReward) ||
      !Number.isSafeInteger(row.meanLatencyMs) ||
      row.meanLatencyMs < 0 ||
      !Number.isFinite(row.meanCostUsd) ||
      row.meanCostUsd < 0
    ) {
      throw new TrustedCatalogImportError(
        "A trusted observation row is invalid or does not match inventory.",
      );
    }
    names.add(row.packageTaskName);
  }
  const { observationSetHash, ...unsigned } = observations;
  if (observationSetHash !== computeTrustedTaskObservationSetHash(unsigned)) {
    throw new TrustedCatalogImportError("Trusted observation commitment does not reproduce.");
  }
}

function posteriorFailure(row: TrustedTaskObservationRow | undefined): number {
  if (row === undefined) return 0.5;
  return (row.validAttempts - row.passedAttempts + 1) / (row.validAttempts + 2);
}

function posteriorUncertainty(probability: number, attempts: number): number {
  const aleatoric = 4 * probability * (1 - probability);
  const smallSample = 2 / (attempts + 2);
  return Math.min(1, 0.7 * aleatoric + 0.3 * smallSample);
}

function rounded(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000_000_000_000) / 1_000_000_000_000;
}

function seedsHash(result: Omit<TrustedHiddenCatalogImport, "seedSetHash">): string {
  return canonicalHash({
    domain: "dark-factory.hidden-catalog-import.v1",
    datasetPinHash: result.datasetPinHash,
    inventoryHash: result.inventoryHash,
    baselineObservationSetHash: result.baselineObservationSetHash,
    leaderboardObservationSetHash: result.leaderboardObservationSetHash,
    seeds: result.seeds,
  });
}

/**
 * Builds the initial 89-task catalog entirely inside the trusted broker.
 *
 * Every valid task is eligible for every selection bucket. Bucket-specific
 * scoring—not secret task labels—then picks hard failures, uncertain tasks,
 * easy canaries, and underexposed capability coverage. This prevents quota
 * exhaustion and gives every task a nonzero future eligibility floor.
 */
export function buildTrustedHiddenCatalogImport(input: {
  readonly expectedDatasetPinHash: string;
  readonly inventory: TrustedTerminalBenchTaskInventory;
  readonly initialPiBaseline: TrustedTaskObservationSet | null;
  readonly comparableLeaderboard: TrustedTaskObservationSet | null;
}): TrustedHiddenCatalogImport {
  if (!SHA256.test(input.expectedDatasetPinHash)) {
    throw new TrustedCatalogImportError("Expected dataset pin hash is malformed.");
  }
  assertInventory(input.inventory, input.expectedDatasetPinHash);
  if (input.initialPiBaseline !== null) {
    assertObservationSet(input.initialPiBaseline, "initial-pi-baseline", input.inventory);
  }
  if (input.comparableLeaderboard !== null) {
    assertObservationSet(
      input.comparableLeaderboard,
      "comparable-public-leaderboard",
      input.inventory,
    );
  }
  const baselineByName = new Map(
    input.initialPiBaseline?.rows.map((row) => [row.packageTaskName, row]) ?? [],
  );
  const leaderboardByName = new Map(
    input.comparableLeaderboard?.rows.map((row) => [row.packageTaskName, row]) ?? [],
  );
  const stratumSizes = new Map<string, number>();
  for (const task of input.inventory.tasks) {
    stratumSizes.set(task.capabilityStratum, (stratumSizes.get(task.capabilityStratum) ?? 0) + 1);
  }
  const maximumStratumSize = Math.max(...stratumSizes.values());
  const seeds = [...input.inventory.tasks]
    .sort((left, right) => left.packageTaskName.localeCompare(right.packageTaskName))
    .map((task): TrustedHiddenTaskSeed => {
      const baseline = baselineByName.get(task.packageTaskName);
      const leaderboard = leaderboardByName.get(task.packageTaskName);
      const baselineFailure = posteriorFailure(baseline);
      const leaderboardFailure = posteriorFailure(leaderboard);
      const baselineAttempts = baseline?.validAttempts ?? 0;
      const leaderboardAttempts = leaderboard?.validAttempts ?? 0;
      const totalAttempts = baselineAttempts + leaderboardAttempts;
      const recentFailure =
        totalAttempts === 0
          ? 0.5
          : (baselineFailure * baselineAttempts + leaderboardFailure * leaderboardAttempts) /
            totalAttempts;
      const uncertainty = Math.max(
        posteriorUncertainty(baselineFailure, baselineAttempts),
        posteriorUncertainty(leaderboardFailure, leaderboardAttempts),
      );
      const discrimination = 0.5 + 0.5 * Math.abs(baselineFailure - leaderboardFailure);
      const capabilitySize = stratumSizes.get(task.capabilityStratum) ?? 1;
      const missingCapabilityCoverage =
        maximumStratumSize <= 1
          ? 1
          : (maximumStratumSize - capabilitySize) / (maximumStratumSize - 1);
      const persistentFailure = Math.min(baselineFailure, leaderboardFailure);
      const impossibleProbability =
        totalAttempts < 6 ? 0.05 : persistentFailure * (1 - discrimination) * 0.5;
      const estimates: HiddenTaskEstimates = {
        championFailureProbability: rounded(baselineFailure),
        baselineFailureProbability: rounded(baselineFailure),
        leaderboardFailureProbability: rounded(leaderboardFailure),
        recentFailureProbability: rounded(recentFailure),
        outcomeUncertainty: rounded(uncertainty),
        discrimination: rounded(discrimination),
        componentRelevance: 0.5,
        underexposure: rounded(4 / (4 + totalAttempts)),
        missingCapabilityCoverage: rounded(missingCapabilityCoverage),
        normalizedCost: rounded(task.normalizedExpectedCost),
        impossibleProbability: rounded(impossibleProbability),
      };
      return {
        packageTaskName: task.packageTaskName,
        taskRevisionDigest: task.taskRevisionDigest,
        capabilityStratum: task.capabilityStratum,
        difficultyStratum: task.difficultyStratum,
        buckets: ["hard", "uncertain", "easy", "coverage"],
        estimates,
        // Benchmark-derived priors never imply that feedback was released to
        // an optimizer. Experiment 001 therefore remains source-only.
        initialFeedbackReleased: false,
        regressionCanary: task.scoringEligible && totalAttempts >= 4 && recentFailure <= 0.1,
        infrastructureValid: task.infrastructureValid,
        discriminating: task.scoringEligible,
      };
    });
  const unsigned: Omit<TrustedHiddenCatalogImport, "seedSetHash"> = {
    sensitivity: "trusted-hidden-catalog-import",
    datasetPinHash: input.inventory.datasetPinHash,
    inventoryHash: input.inventory.inventoryHash,
    baselineObservationSetHash: input.initialPiBaseline?.observationSetHash ?? null,
    leaderboardObservationSetHash: input.comparableLeaderboard?.observationSetHash ?? null,
    seeds,
  };
  const result: TrustedHiddenCatalogImport = {
    ...unsigned,
    seedSetHash: seedsHash(unsigned),
  };
  exactKeys(result, IMPORT_RESULT_KEYS);
  // Defensive serialization check: undefined or non-finite values must not be
  // able to enter the durable catalog commitment.
  canonicalJson(result);
  return result;
}
