import {
  canonicalHash,
  canonicalJson,
} from "../schemas/canonical.js";
import {
  assertTerminalBench21Pin,
  hashTerminalBench21Pin,
  type TerminalBench21Pin,
} from "../terminal-bench/pin.js";
import {
  buildTrustedHiddenCatalogImport,
  type TrustedHiddenCatalogImport,
  type TrustedTaskObservationSet,
  type TrustedTerminalBenchTaskInventory,
} from "./catalog-import.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface TrustedCatalogInventoryQuery {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.trusted-catalog-inventory-query.v1";
  readonly datasetPinHash: string;
  readonly datasetContentSha256: string;
  readonly datasetManifestSha256: string;
  readonly registryRevision: 6;
  readonly expectedTaskCount: 89;
  readonly queryHash: string;
}

export interface TrustedCatalogObservationQuery {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.trusted-catalog-observation-query.v1";
  readonly sourceKind:
    | "initial-pi-baseline"
    | "comparable-public-leaderboard";
  readonly sourceCommitment: string;
  readonly datasetPinHash: string;
  readonly inventoryHash: string;
  readonly registryRevision: 6;
  readonly maximumRows: 89;
  readonly queryHash: string;
}

/**
 * This source is an evaluator/broker-zone authority. It may resolve package
 * task names, but it has no release method and must never be injected into the
 * optimizer process.
 */
export interface TrustedTerminalBenchCatalogMaterialSource {
  readonly boundary:
    "trusted-cloud-terminal-bench-catalog-material-source";
  loadInventory(
    query: TrustedCatalogInventoryQuery,
  ): Promise<TrustedTerminalBenchTaskInventory>;
  loadObservations(
    query: TrustedCatalogObservationQuery,
  ): Promise<TrustedTaskObservationSet>;
}

export interface TrustedCatalogGenesisLoaderOptions {
  readonly pin: TerminalBench21Pin;
  readonly source: TrustedTerminalBenchCatalogMaterialSource;
  /**
   * Null means neutral priors. A non-null value is the exact immutable
   * observation artifact commitment the trusted source must return.
   */
  readonly initialPiBaselineCommitment: string | null;
  /**
   * Null means no comparable public evidence was admitted. This choice is
   * frozen for genesis and cannot be changed after the loader is constructed.
   */
  readonly comparableLeaderboardCommitment: string | null;
}

export interface ReleaseSafeCatalogGenesisReceipt {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.release-safe-catalog-genesis-receipt.v1";
  readonly sensitivity: "release-safe-control";
  readonly benchmark: "terminal-bench-2.1";
  readonly datasetPinHash: string;
  readonly registryRevision: 6;
  readonly taskCount: 89;
  readonly inventoryHash: string;
  readonly baselineObservationSetHash: string | null;
  readonly leaderboardObservationSetHash: string | null;
  readonly seedSetHash: string;
  readonly containsTaskNames: false;
  readonly containsTaskIdentifiers: false;
  readonly containsObservationRows: false;
  readonly receiptHash: string;
}

export interface TrustedLoadedCatalogGenesis {
  readonly sensitivity: "trusted-hidden-catalog-genesis-material";
  /**
   * Deliberately installed as a non-enumerable, immutable own property. Trusted
   * broker code can read it explicitly, while ordinary JSON/canonical logging
   * and object spreading cannot serialize hidden task material.
   */
  readonly hiddenImport: TrustedHiddenCatalogImport;
  readonly releaseSafeReceipt: ReleaseSafeCatalogGenesisReceipt;
}

export class TrustedCatalogGenesisLoaderError extends Error {
  override readonly name =
    "TrustedCatalogGenesisLoaderError";

  public constructor() {
    super("Trusted hidden-catalog genesis loading failed closed.");
  }
}

interface CapturedLoaderOptions {
  readonly pin: TerminalBench21Pin;
  readonly datasetPinHash: string;
  readonly baselineCommitment: string | null;
  readonly leaderboardCommitment: string | null;
  readonly loadInventory:
    TrustedTerminalBenchCatalogMaterialSource["loadInventory"];
  readonly loadObservations:
    TrustedTerminalBenchCatalogMaterialSource["loadObservations"];
}

function fail(): never {
  throw new TrustedCatalogGenesisLoaderError();
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(
      value as Readonly<Record<string, unknown>>,
    )) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail();
  }
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  ) {
    fail();
  }
}

function assertOptionalCommitment(value: string | null): void {
  if (value !== null && !SHA256.test(value)) fail();
}

export function createTrustedCatalogInventoryQuery(
  pin: TerminalBench21Pin,
  datasetPinHash: string,
): TrustedCatalogInventoryQuery {
  try {
    assertTerminalBench21Pin(pin);
  } catch {
    fail();
  }
  if (
    pin.registryRevision !== 6 ||
    pin.taskCount !== 89 ||
    !SHA256.test(datasetPinHash) ||
    datasetPinHash !== hashTerminalBench21Pin(pin)
  ) {
    fail();
  }
  const unsigned = {
    schemaVersion: 1 as const,
    domain:
      "dark-factory.trusted-catalog-inventory-query.v1" as const,
    datasetPinHash,
    datasetContentSha256: pin.datasetContentSha256,
    datasetManifestSha256: pin.datasetManifestSha256,
    registryRevision: 6 as const,
    expectedTaskCount: 89 as const,
  };
  return deepFreeze({
    ...unsigned,
    queryHash: canonicalHash(unsigned),
  });
}

export function createTrustedCatalogObservationQuery(
  sourceKind: TrustedCatalogObservationQuery["sourceKind"],
  sourceCommitment: string,
  datasetPinHash: string,
  inventoryHash: string,
): TrustedCatalogObservationQuery {
  if (
    (sourceKind !== "initial-pi-baseline" &&
      sourceKind !== "comparable-public-leaderboard") ||
    !SHA256.test(sourceCommitment) ||
    !SHA256.test(datasetPinHash) ||
    !SHA256.test(inventoryHash)
  ) {
    fail();
  }
  const unsigned = {
    schemaVersion: 1 as const,
    domain:
      "dark-factory.trusted-catalog-observation-query.v1" as const,
    sourceKind,
    sourceCommitment,
    datasetPinHash,
    inventoryHash,
    registryRevision: 6 as const,
    maximumRows: 89 as const,
  };
  return deepFreeze({
    ...unsigned,
    queryHash: canonicalHash(unsigned),
  });
}

function releaseSafeReceipt(
  imported: TrustedHiddenCatalogImport,
): ReleaseSafeCatalogGenesisReceipt {
  const unsigned = {
    schemaVersion: 1 as const,
    domain:
      "dark-factory.release-safe-catalog-genesis-receipt.v1" as const,
    sensitivity: "release-safe-control" as const,
    benchmark: "terminal-bench-2.1" as const,
    datasetPinHash: imported.datasetPinHash,
    registryRevision: 6 as const,
    taskCount: 89 as const,
    inventoryHash: imported.inventoryHash,
    baselineObservationSetHash:
      imported.baselineObservationSetHash,
    leaderboardObservationSetHash:
      imported.leaderboardObservationSetHash,
    seedSetHash: imported.seedSetHash,
    containsTaskNames: false as const,
    containsTaskIdentifiers: false as const,
    containsObservationRows: false as const,
  };
  return deepFreeze({
    ...unsigned,
    receiptHash: canonicalHash(unsigned),
  });
}

function protectLoadedGenesis(input: {
  readonly hiddenImport: TrustedHiddenCatalogImport;
  readonly releaseSafeReceipt: ReleaseSafeCatalogGenesisReceipt;
}): TrustedLoadedCatalogGenesis {
  const loaded = {
    sensitivity:
      "trusted-hidden-catalog-genesis-material" as const,
    releaseSafeReceipt: input.releaseSafeReceipt,
  } as Omit<TrustedLoadedCatalogGenesis, "hiddenImport"> &
    Partial<Pick<TrustedLoadedCatalogGenesis, "hiddenImport">>;
  Object.defineProperty(loaded, "hiddenImport", {
    value: input.hiddenImport,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(loaded) as TrustedLoadedCatalogGenesis;
}

function captureOptions(
  options: TrustedCatalogGenesisLoaderOptions,
): CapturedLoaderOptions {
  try {
    exactKeys(options, [
      "pin",
      "source",
      "initialPiBaselineCommitment",
      "comparableLeaderboardCommitment",
    ]);
    assertTerminalBench21Pin(options.pin);
    if (
      options.pin.registryRevision !== 6 ||
      options.pin.taskCount !== 89 ||
      options.source.boundary !==
        "trusted-cloud-terminal-bench-catalog-material-source" ||
      typeof options.source.loadInventory !== "function" ||
      typeof options.source.loadObservations !== "function"
    ) {
      fail();
    }
    assertOptionalCommitment(
      options.initialPiBaselineCommitment,
    );
    assertOptionalCommitment(
      options.comparableLeaderboardCommitment,
    );
    const pin = deepFreeze(cloneCanonical(options.pin));
    return {
      pin,
      datasetPinHash: hashTerminalBench21Pin(pin),
      baselineCommitment:
        options.initialPiBaselineCommitment,
      leaderboardCommitment:
        options.comparableLeaderboardCommitment,
      loadInventory:
        options.source.loadInventory.bind(options.source),
      loadObservations:
        options.source.loadObservations.bind(options.source),
    };
  } catch {
    fail();
  }
}

/**
 * Resolves the hidden catalog exactly once. The source is captured at
 * construction, all returned values are canonical snapshots, and any failure
 * consumes the loader so an attacker cannot probe alternate source results.
 */
export class TrustedTerminalBenchCatalogGenesisLoader {
  readonly #options: CapturedLoaderOptions;
  #consumed = false;

  public constructor(
    options: TrustedCatalogGenesisLoaderOptions,
  ) {
    this.#options = captureOptions(options);
  }

  public async loadOnce(): Promise<TrustedLoadedCatalogGenesis> {
    if (this.#consumed) fail();
    this.#consumed = true;
    try {
      const inventory = cloneCanonical(
        await this.#options.loadInventory(
          createTrustedCatalogInventoryQuery(
            this.#options.pin,
            this.#options.datasetPinHash,
          ),
        ),
      );
      const baseline =
        this.#options.baselineCommitment === null
          ? null
          : cloneCanonical(
              await this.#options.loadObservations(
                createTrustedCatalogObservationQuery(
                  "initial-pi-baseline",
                  this.#options.baselineCommitment,
                  this.#options.datasetPinHash,
                  inventory.inventoryHash,
                ),
              ),
            );
      const leaderboard =
        this.#options.leaderboardCommitment === null
          ? null
          : cloneCanonical(
              await this.#options.loadObservations(
                createTrustedCatalogObservationQuery(
                  "comparable-public-leaderboard",
                  this.#options.leaderboardCommitment,
                  this.#options.datasetPinHash,
                  inventory.inventoryHash,
                ),
              ),
            );
      if (
        (baseline !== null &&
          baseline.sourceCommitment !==
            this.#options.baselineCommitment) ||
        (leaderboard !== null &&
          leaderboard.sourceCommitment !==
            this.#options.leaderboardCommitment)
      ) {
        fail();
      }
      const hiddenImport = deepFreeze(
        buildTrustedHiddenCatalogImport({
          expectedDatasetPinHash:
            this.#options.datasetPinHash,
          inventory,
          initialPiBaseline: baseline,
          comparableLeaderboard: leaderboard,
        }),
      );
      const loaded = protectLoadedGenesis({
        hiddenImport,
        releaseSafeReceipt:
          releaseSafeReceipt(hiddenImport),
      });
      canonicalJson(loaded);
      return loaded;
    } catch {
      fail();
    }
  }
}
