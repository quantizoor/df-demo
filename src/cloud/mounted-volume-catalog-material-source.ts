import {
  createTrustedCatalogInventoryQuery,
  createTrustedCatalogObservationQuery,
  type TrustedCatalogInventoryQuery,
  type TrustedCatalogObservationQuery,
  type TrustedTerminalBenchCatalogMaterialSource,
} from "../broker/catalog-genesis-loader.js";
import {
  buildTrustedHiddenCatalogImport,
  type TrustedTaskObservationSet,
  type TrustedTerminalBenchTaskInventory,
} from "../broker/catalog-import.js";
import {
  canonicalHash,
  canonicalJson,
  sha256,
} from "../schemas/canonical.js";
import {
  assertTerminalBench21Pin,
  hashTerminalBench21Pin,
  type TerminalBench21Pin,
} from "../terminal-bench/pin.js";
import type { TrustedArtifactBridge } from "./artifact-bridge.js";
import {
  MountedVolumeTransactionalJsonStore,
  type MountedVolumeDurableStateOptions,
} from "./mounted-volume-state.js";
import type {
  ProductionOptimizeLifecycleRegistrar,
  TrustedProductionOptimizeCloseable,
} from "./production-optimize-composition-owner.js";
import type { VerifyingTrustedJsonArtifactReader } from "./trusted-json-reader.js";
import type { TrustedCloudArtifactRef } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const TRUSTED_URI =
  /^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const DEFAULT_MAXIMUM_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_BUNDLE_BYTES = 64 * 1024 * 1024;
const INVENTORY_KIND = "inventory" as const;
const BASELINE_KIND = "initial-pi-baseline" as const;
const LEADERBOARD_KIND = "comparable-public-leaderboard" as const;

type CatalogMaterialKind =
  | typeof INVENTORY_KIND
  | typeof BASELINE_KIND
  | typeof LEADERBOARD_KIND;

const BUNDLE_KEYS = [
  "schemaVersion",
  "domain",
  "sensitivity",
  "pin",
  "inventory",
  "initialPiBaseline",
  "comparableLeaderboard",
  "bundleHash",
] as const;
const ENTRY_KEYS = [
  "schemaVersion",
  "domain",
  "kind",
  "lookupHash",
  "documentHash",
  "sourceCommitment",
  "artifact",
  "entryHash",
] as const;
const STATE_KEYS = [
  "schemaVersion",
  "sensitivity",
  "revision",
  "datasetPinHash",
  "datasetContentSha256",
  "datasetManifestSha256",
  "registryRevision",
  "taskCount",
  "bundleHash",
  "inventory",
  "initialPiBaseline",
  "comparableLeaderboard",
  "stateCommitment",
] as const;
const ARTIFACT_KEYS = [
  "uri",
  "sha256",
  "mediaType",
  "byteLength",
] as const;

export interface TrustedTerminalBenchCatalogMaterialBundle {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.trusted-terminal-bench-catalog-material-bundle.v1";
  readonly sensitivity:
    "trusted-hidden-terminal-bench-catalog-material";
  readonly pin: TerminalBench21Pin;
  readonly inventory: TrustedTerminalBenchTaskInventory;
  readonly initialPiBaseline: TrustedTaskObservationSet | null;
  readonly comparableLeaderboard: TrustedTaskObservationSet | null;
  readonly bundleHash: string;
}

export interface TrustedCatalogMaterialNormalizerSpec {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.trusted-catalog-material-normalizer-spec.v1";
  readonly executionBoundary: "trusted-cloud-evaluator-only";
  readonly benchmark: "terminal-bench-2.1";
  readonly dataset: "terminal-bench/terminal-bench-2-1";
  readonly datasetPinHash: string;
  readonly datasetContentSha256: string;
  readonly datasetManifestSha256: string;
  readonly registryRevision: 6;
  readonly expectedTaskCount: 89;
  readonly outputMediaType: "application/json";
  readonly outputMustBeCanonicalJsonLine: true;
  readonly mutableAliasesAllowed: false;
  readonly taskRowsMayLeaveTrustedArtifactStore: false;
  readonly maximumOutputBytes: number;
  readonly specHash: string;
}

export interface TrustedCatalogMaterialPublicationReceipt {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.trusted-catalog-material-publication-receipt.v1";
  readonly sensitivity: "release-safe-control";
  readonly status: "published" | "already-published";
  readonly datasetPinHash: string;
  readonly registryRevision: 6;
  readonly taskCount: 89;
  readonly bundleHash: string;
  readonly inventoryHash: string;
  readonly initialPiBaselineSourceCommitment: string | null;
  readonly initialPiBaselineObservationSetHash: string | null;
  readonly comparableLeaderboardSourceCommitment: string | null;
  readonly comparableLeaderboardObservationSetHash: string | null;
  readonly registryCommitment: string;
  readonly containsTaskNames: false;
  readonly containsTaskIdentifiers: false;
  readonly containsObservationRows: false;
  readonly containsArtifactLocations: false;
  readonly receiptHash: string;
}

export interface MountedVolumeTrustedCatalogMaterialRegistryOptions {
  readonly pin: TerminalBench21Pin;
  readonly durableState: MountedVolumeDurableStateOptions;
  readonly bridge: TrustedArtifactBridge;
  readonly reader: VerifyingTrustedJsonArtifactReader;
  readonly lifecycle?: ProductionOptimizeLifecycleRegistrar;
  readonly maximumBundleBytes?: number;
}

/**
 * Provider-specific Harbor resolution stays behind this narrow capability.
 * The worker receives only the sealed, task-free normalizer spec and returns
 * one canonical task-bearing bundle directly to the trusted registry process.
 */
export interface TrustedTerminalBenchCatalogNormalizationWorker {
  readonly boundary:
    "trusted-cloud-terminal-bench-catalog-normalization-worker";
  normalize(
    spec: TrustedCatalogMaterialNormalizerSpec,
  ): Promise<string>;
}

interface CatalogMaterialRegistryEntry {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.trusted-catalog-material-registry-entry.v1";
  readonly kind: CatalogMaterialKind;
  readonly lookupHash: string;
  readonly documentHash: string;
  readonly sourceCommitment: string | null;
  readonly artifact: TrustedCloudArtifactRef;
  readonly entryHash: string;
}

interface DurableCatalogMaterialRegistryState {
  readonly schemaVersion: 1;
  readonly sensitivity:
    "trusted-hidden-catalog-material-registry";
  readonly revision: 0 | 1;
  readonly datasetPinHash: string;
  readonly datasetContentSha256: string;
  readonly datasetManifestSha256: string;
  readonly registryRevision: 6;
  readonly taskCount: 89;
  readonly bundleHash: string | null;
  readonly inventory: CatalogMaterialRegistryEntry | null;
  readonly initialPiBaseline: CatalogMaterialRegistryEntry | null;
  readonly comparableLeaderboard: CatalogMaterialRegistryEntry | null;
  readonly stateCommitment: string;
}

interface PersistedBundle {
  readonly bundle: TrustedTerminalBenchCatalogMaterialBundle;
  readonly inventory: CatalogMaterialRegistryEntry;
  readonly initialPiBaseline: CatalogMaterialRegistryEntry | null;
  readonly comparableLeaderboard: CatalogMaterialRegistryEntry | null;
}

interface CapturedOptions {
  readonly pin: TerminalBench21Pin;
  readonly datasetPinHash: string;
  readonly maximumBundleBytes: number;
}

export class MountedVolumeTrustedCatalogMaterialRegistryError extends Error {
  override readonly name =
    "MountedVolumeTrustedCatalogMaterialRegistryError";

  public constructor() {
    super("Trusted hidden catalog material registry failed closed.");
  }
}

function fail(): never {
  throw new MountedVolumeTrustedCatalogMaterialRegistryError();
}

function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail();
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== expected.length ||
    actual.some(
      (key) =>
        typeof key !== "string" ||
        !expected.includes(key) ||
        !Object.hasOwn(
          Object.getOwnPropertyDescriptor(value, key) ?? {},
          "value",
        ),
    )
  ) {
    fail();
  }
}

function cloneCanonical<Value>(value: Value): Value {
  try {
    return JSON.parse(canonicalJson(value)) as Value;
  } catch {
    fail();
  }
}

function deepFreeze<Value>(value: Value): Value {
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

function unchanged(value: object, expected: string): boolean {
  try {
    return canonicalJson(value) === expected;
  } catch {
    return false;
  }
}

function bundleHash(
  bundle: Omit<TrustedTerminalBenchCatalogMaterialBundle, "bundleHash">,
): string {
  return canonicalHash({
    domain:
      "dark-factory.trusted-terminal-bench-catalog-material-bundle-hash.v1",
    bundle,
  });
}

function entryHash(
  entry: Omit<CatalogMaterialRegistryEntry, "entryHash">,
): string {
  return canonicalHash(entry);
}

function stateCommitment(
  state: Omit<
    DurableCatalogMaterialRegistryState,
    "stateCommitment"
  >,
): string {
  return canonicalHash({
    domain:
      "dark-factory.trusted-catalog-material-registry-state-commitment.v1",
    state,
  });
}

function artifactUri(
  datasetPinHash: string,
  kind: CatalogMaterialKind,
  byteHash: string,
): `trusted://${string}` {
  if (!SHA256.test(datasetPinHash) || !SHA256.test(byteHash)) fail();
  return `trusted://catalog-material/v1/${datasetPinHash}/${kind}/${byteHash}`;
}

function assertArtifact(
  value: unknown,
  datasetPinHash: string,
  kind: CatalogMaterialKind,
  maximumBytes: number,
): asserts value is TrustedCloudArtifactRef {
  exactKeys(value, ARTIFACT_KEYS);
  if (
    typeof value.uri !== "string" ||
    !TRUSTED_URI.test(value.uri) ||
    value.uri.includes("..") ||
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256) ||
    value.uri !== artifactUri(datasetPinHash, kind, value.sha256) ||
    value.mediaType !== "application/json" ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) <= 0 ||
    (value.byteLength as number) > maximumBytes
  ) {
    fail();
  }
}

function assertBundle(
  value: unknown,
  expected: CapturedOptions,
): asserts value is TrustedTerminalBenchCatalogMaterialBundle {
  exactKeys(value, BUNDLE_KEYS);
  try {
    assertTerminalBench21Pin(
      value.pin as unknown as TerminalBench21Pin,
    );
  } catch {
    fail();
  }
  const bundle =
    value as unknown as TrustedTerminalBenchCatalogMaterialBundle;
  if (
    bundle.schemaVersion !== 1 ||
    bundle.domain !==
      "dark-factory.trusted-terminal-bench-catalog-material-bundle.v1" ||
    bundle.sensitivity !==
      "trusted-hidden-terminal-bench-catalog-material" ||
    canonicalJson(bundle.pin) !== canonicalJson(expected.pin) ||
    hashTerminalBench21Pin(bundle.pin) !== expected.datasetPinHash ||
    bundle.pin.registryRevision !== 6 ||
    bundle.pin.taskCount !== 89 ||
    !SHA256.test(bundle.bundleHash)
  ) {
    fail();
  }
  try {
    buildTrustedHiddenCatalogImport({
      expectedDatasetPinHash: expected.datasetPinHash,
      inventory: bundle.inventory,
      initialPiBaseline: bundle.initialPiBaseline,
      comparableLeaderboard: bundle.comparableLeaderboard,
    });
  } catch {
    fail();
  }
  const { bundleHash: observedHash, ...unsigned } = bundle;
  if (observedHash !== bundleHash(unsigned)) fail();
}

function assertInventoryQuery(
  value: unknown,
  options: CapturedOptions,
): asserts value is TrustedCatalogInventoryQuery {
  const expected = createTrustedCatalogInventoryQuery(
    options.pin,
    options.datasetPinHash,
  );
  if (canonicalJson(value) !== canonicalJson(expected)) fail();
}

function assertObservationQuery(
  value: unknown,
  options: CapturedOptions,
  inventoryHash: string,
): asserts value is TrustedCatalogObservationQuery {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "sourceKind",
    "sourceCommitment",
    "datasetPinHash",
    "inventoryHash",
    "registryRevision",
    "maximumRows",
    "queryHash",
  ]);
  if (
    (value.sourceKind !== BASELINE_KIND &&
      value.sourceKind !== LEADERBOARD_KIND) ||
    typeof value.sourceCommitment !== "string" ||
    !SHA256.test(value.sourceCommitment)
  ) {
    fail();
  }
  const expected = createTrustedCatalogObservationQuery(
    value.sourceKind,
    value.sourceCommitment,
    options.datasetPinHash,
    inventoryHash,
  );
  if (canonicalJson(value) !== canonicalJson(expected)) fail();
}

function assertEntry(
  value: unknown,
  options: CapturedOptions,
): asserts value is CatalogMaterialRegistryEntry {
  exactKeys(value, ENTRY_KEYS);
  const entry = value as unknown as CatalogMaterialRegistryEntry;
  if (
    entry.schemaVersion !== 1 ||
    entry.domain !==
      "dark-factory.trusted-catalog-material-registry-entry.v1" ||
    ![INVENTORY_KIND, BASELINE_KIND, LEADERBOARD_KIND].includes(
      entry.kind,
    ) ||
    !SHA256.test(entry.lookupHash) ||
    !SHA256.test(entry.documentHash) ||
    (entry.kind === INVENTORY_KIND) !==
      (entry.sourceCommitment === null) ||
    (entry.sourceCommitment !== null &&
      !SHA256.test(entry.sourceCommitment))
  ) {
    fail();
  }
  assertArtifact(
    entry.artifact,
    options.datasetPinHash,
    entry.kind,
    options.maximumBundleBytes,
  );
  const { entryHash: observedHash, ...unsigned } = entry;
  if (
    !SHA256.test(observedHash) ||
    observedHash !== entryHash(unsigned)
  ) {
    fail();
  }
}

function initialState(
  options: CapturedOptions,
): DurableCatalogMaterialRegistryState {
  const unsigned = {
    schemaVersion: 1 as const,
    sensitivity:
      "trusted-hidden-catalog-material-registry" as const,
    revision: 0 as const,
    datasetPinHash: options.datasetPinHash,
    datasetContentSha256: options.pin.datasetContentSha256,
    datasetManifestSha256:
      options.pin.datasetManifestSha256,
    registryRevision: 6 as const,
    taskCount: 89 as const,
    bundleHash: null,
    inventory: null,
    initialPiBaseline: null,
    comparableLeaderboard: null,
  };
  return {
    ...unsigned,
    stateCommitment: stateCommitment(unsigned),
  };
}

function assertState(
  value: unknown,
  options: CapturedOptions,
): asserts value is DurableCatalogMaterialRegistryState {
  exactKeys(value, STATE_KEYS);
  const state =
    value as unknown as DurableCatalogMaterialRegistryState;
  if (
    state.schemaVersion !== 1 ||
    state.sensitivity !==
      "trusted-hidden-catalog-material-registry" ||
    (state.revision !== 0 && state.revision !== 1) ||
    state.datasetPinHash !== options.datasetPinHash ||
    state.datasetContentSha256 !==
      options.pin.datasetContentSha256 ||
    state.datasetManifestSha256 !==
      options.pin.datasetManifestSha256 ||
    state.registryRevision !== 6 ||
    state.taskCount !== 89 ||
    !SHA256.test(state.stateCommitment)
  ) {
    fail();
  }
  if (state.revision === 0) {
    if (
      state.bundleHash !== null ||
      state.inventory !== null ||
      state.initialPiBaseline !== null ||
      state.comparableLeaderboard !== null
    ) {
      fail();
    }
  } else {
    if (
      state.bundleHash === null ||
      !SHA256.test(state.bundleHash) ||
      state.inventory === null
    ) {
      fail();
    }
    assertEntry(state.inventory, options);
    if (
      state.inventory.kind !== INVENTORY_KIND ||
      state.inventory.lookupHash !==
        createTrustedCatalogInventoryQuery(
          options.pin,
          options.datasetPinHash,
        ).queryHash
    ) {
      fail();
    }
    for (const [
      expectedKind,
      entry,
    ] of [
      [BASELINE_KIND, state.initialPiBaseline],
      [LEADERBOARD_KIND, state.comparableLeaderboard],
    ] as const) {
      if (entry !== null) {
        assertEntry(entry, options);
        if (
          entry.kind !== expectedKind ||
          entry.sourceCommitment === null ||
          entry.lookupHash !==
            createTrustedCatalogObservationQuery(
              expectedKind,
              entry.sourceCommitment,
              options.datasetPinHash,
              state.inventory.documentHash,
            ).queryHash
        ) {
          fail();
        }
      }
    }
  }
  const { stateCommitment: observed, ...unsigned } = state;
  if (observed !== stateCommitment(unsigned)) fail();
}

function captureOptions(
  options: MountedVolumeTrustedCatalogMaterialRegistryOptions,
): CapturedOptions {
  try {
    exactKeys(options, [
      "pin",
      "durableState",
      "bridge",
      "reader",
      ...(options.lifecycle === undefined ? [] : ["lifecycle"]),
      ...(options.maximumBundleBytes === undefined
        ? []
        : ["maximumBundleBytes"]),
    ]);
    assertTerminalBench21Pin(options.pin);
    const maximumBundleBytes =
      options.maximumBundleBytes ??
      DEFAULT_MAXIMUM_BUNDLE_BYTES;
    if (
      options.pin.registryRevision !== 6 ||
      options.pin.taskCount !== 89 ||
      typeof options.bridge?.assertTrustedRuntime !== "function" ||
      typeof options.bridge?.persistVerified !== "function" ||
      options.reader?.boundary !== "trusted-cloud" ||
      typeof options.reader?.readUtf8 !== "function" ||
      (options.lifecycle !== undefined &&
        typeof options.lifecycle.register !== "function") ||
      !Number.isSafeInteger(maximumBundleBytes) ||
      maximumBundleBytes < 64 * 1024 ||
      maximumBundleBytes > MAXIMUM_BUNDLE_BYTES
    ) {
      fail();
    }
    const pin = deepFreeze(cloneCanonical(options.pin));
    return {
      pin,
      datasetPinHash: hashTerminalBench21Pin(pin),
      maximumBundleBytes,
    };
  } catch {
    fail();
  }
}

export function createTrustedCatalogMaterialNormalizerSpec(
  pinInput: TerminalBench21Pin,
  maximumOutputBytes = DEFAULT_MAXIMUM_BUNDLE_BYTES,
): TrustedCatalogMaterialNormalizerSpec {
  try {
    assertTerminalBench21Pin(pinInput);
    if (
      pinInput.registryRevision !== 6 ||
      pinInput.taskCount !== 89 ||
      !Number.isSafeInteger(maximumOutputBytes) ||
      maximumOutputBytes < 64 * 1024 ||
      maximumOutputBytes > MAXIMUM_BUNDLE_BYTES
    ) {
      fail();
    }
    const pin = cloneCanonical(pinInput);
    const unsigned = {
      schemaVersion: 1 as const,
      domain:
        "dark-factory.trusted-catalog-material-normalizer-spec.v1" as const,
      executionBoundary:
        "trusted-cloud-evaluator-only" as const,
      benchmark: "terminal-bench-2.1" as const,
      dataset:
        "terminal-bench/terminal-bench-2-1" as const,
      datasetPinHash: hashTerminalBench21Pin(pin),
      datasetContentSha256: pin.datasetContentSha256,
      datasetManifestSha256: pin.datasetManifestSha256,
      registryRevision: 6 as const,
      expectedTaskCount: 89 as const,
      outputMediaType: "application/json" as const,
      outputMustBeCanonicalJsonLine: true as const,
      mutableAliasesAllowed: false as const,
      taskRowsMayLeaveTrustedArtifactStore: false as const,
      maximumOutputBytes,
    };
    return deepFreeze({
      ...unsigned,
      specHash: canonicalHash(unsigned),
    });
  } catch {
    fail();
  }
}

/**
 * Normalizes already-resolved, pinned Harbor material. Callers must run this
 * function only in the evaluator/broker trust zone; it deliberately preserves
 * hidden task rows so they can be sealed by the registry.
 */
export function createTrustedTerminalBenchCatalogMaterialBundle(input: {
  readonly pin: TerminalBench21Pin;
  readonly inventory: TrustedTerminalBenchTaskInventory;
  readonly initialPiBaseline: TrustedTaskObservationSet | null;
  readonly comparableLeaderboard: TrustedTaskObservationSet | null;
}): TrustedTerminalBenchCatalogMaterialBundle {
  try {
    exactKeys(input, [
      "pin",
      "inventory",
      "initialPiBaseline",
      "comparableLeaderboard",
    ]);
    assertTerminalBench21Pin(input.pin);
    if (
      input.pin.registryRevision !== 6 ||
      input.pin.taskCount !== 89
    ) {
      fail();
    }
    const pin = cloneCanonical(input.pin);
    const expected: CapturedOptions = {
      pin,
      datasetPinHash: hashTerminalBench21Pin(pin),
      maximumBundleBytes: MAXIMUM_BUNDLE_BYTES,
    };
    const unsigned = {
      schemaVersion: 1 as const,
      domain:
        "dark-factory.trusted-terminal-bench-catalog-material-bundle.v1" as const,
      sensitivity:
        "trusted-hidden-terminal-bench-catalog-material" as const,
      pin,
      inventory: cloneCanonical(input.inventory),
      initialPiBaseline:
        input.initialPiBaseline === null
          ? null
          : cloneCanonical(input.initialPiBaseline),
      comparableLeaderboard:
        input.comparableLeaderboard === null
          ? null
          : cloneCanonical(input.comparableLeaderboard),
    };
    const result = {
      ...unsigned,
      bundleHash: bundleHash(unsigned),
    };
    assertBundle(result, expected);
    return deepFreeze(result);
  } catch {
    fail();
  }
}

function parseCanonicalBundle(
  raw: string,
  options: CapturedOptions,
): TrustedTerminalBenchCatalogMaterialBundle {
  try {
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      raw.charCodeAt(0) === 0xfeff ||
      raw.includes("\u0000") ||
      Buffer.byteLength(raw, "utf8") >
        options.maximumBundleBytes
    ) {
      fail();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isPlainRecord(parsed) ||
      raw !== `${canonicalJson(parsed)}\n`
    ) {
      fail();
    }
    assertBundle(parsed, options);
    return deepFreeze(
      cloneCanonical(
        parsed as unknown as TrustedTerminalBenchCatalogMaterialBundle,
      ),
    );
  } catch {
    fail();
  }
}

function receipt(
  status: TrustedCatalogMaterialPublicationReceipt["status"],
  bundle: TrustedTerminalBenchCatalogMaterialBundle,
  registryCommitment: string,
): TrustedCatalogMaterialPublicationReceipt {
  const unsigned = {
    schemaVersion: 1 as const,
    domain:
      "dark-factory.trusted-catalog-material-publication-receipt.v1" as const,
    sensitivity: "release-safe-control" as const,
    status,
    datasetPinHash: hashTerminalBench21Pin(bundle.pin),
    registryRevision: 6 as const,
    taskCount: 89 as const,
    bundleHash: bundle.bundleHash,
    inventoryHash: bundle.inventory.inventoryHash,
    initialPiBaselineSourceCommitment:
      bundle.initialPiBaseline?.sourceCommitment ?? null,
    initialPiBaselineObservationSetHash:
      bundle.initialPiBaseline?.observationSetHash ?? null,
    comparableLeaderboardSourceCommitment:
      bundle.comparableLeaderboard?.sourceCommitment ?? null,
    comparableLeaderboardObservationSetHash:
      bundle.comparableLeaderboard?.observationSetHash ?? null,
    registryCommitment,
    containsTaskNames: false as const,
    containsTaskIdentifiers: false as const,
    containsObservationRows: false as const,
    containsArtifactLocations: false as const,
  };
  return deepFreeze({
    ...unsigned,
    receiptHash: canonicalHash(unsigned),
  });
}

/**
 * Private content-addressed registry for the one hidden catalog-genesis bundle.
 *
 * This is intentionally separate from MountedVolumeTrustedArtifactRegistry:
 * that registry is task-free and safe to mirror locally, while this sidecar
 * persists task-bearing bytes only in the evaluator/broker trust zone.
 */
export class MountedVolumeTrustedCatalogMaterialRegistry {
  readonly boundary =
    "trusted-cloud-hidden-catalog-material-registry" as const;
  readonly lifecycleId: string;
  readonly lifecycleResource: TrustedProductionOptimizeCloseable;
  readonly source: TrustedTerminalBenchCatalogMaterialSource;
  readonly #options: CapturedOptions;
  readonly #store: MountedVolumeTransactionalJsonStore<DurableCatalogMaterialRegistryState>;
  readonly #assertTrustedRuntime:
    TrustedArtifactBridge["assertTrustedRuntime"];
  readonly #persistVerified: TrustedArtifactBridge["persistVerified"];
  readonly #readUtf8: VerifyingTrustedJsonArtifactReader["readUtf8"];
  #normalizationAttempted = false;

  public constructor(
    options: MountedVolumeTrustedCatalogMaterialRegistryOptions,
  ) {
    this.#options = captureOptions(options);
    options.bridge.assertTrustedRuntime();
    this.#assertTrustedRuntime =
      options.bridge.assertTrustedRuntime.bind(options.bridge);
    this.#persistVerified =
      options.bridge.persistVerified.bind(options.bridge);
    this.#readUtf8 = options.reader.readUtf8.bind(options.reader);
    this.lifecycleId = `catalog-material-${canonicalHash({
      domain:
        "dark-factory.trusted-catalog-material-registry-lifecycle.v1",
      storeId: options.durableState.storeId,
      datasetPinHash: this.#options.datasetPinHash,
    }).slice(0, 24)}`;
    this.#store =
      new MountedVolumeTransactionalJsonStore<DurableCatalogMaterialRegistryState>(
        options.durableState,
        "trusted-hidden-catalog-material-registry-v1",
        {
          domain:
            "dark-factory.trusted-hidden-catalog-material-registry-state.v1",
          initialState: () => initialState(this.#options),
          assertState: (
            value: unknown,
          ): asserts value is DurableCatalogMaterialRegistryState => {
            assertState(value, this.#options);
          },
          revision: (state) => state.revision,
        },
      );
    this.lifecycleResource = Object.freeze({
      boundary:
        "trusted-cloud-production-optimize-lifecycle" as const,
      lifecycleId: this.lifecycleId,
      close: (): Promise<void> => this.close(),
    });
    options.lifecycle?.register(this.lifecycleResource);
    const loadInventory =
      this.#loadInventory.bind(this);
    const loadObservations =
      this.#loadObservations.bind(this);
    this.source = Object.freeze({
      boundary:
        "trusted-cloud-terminal-bench-catalog-material-source" as const,
      loadInventory,
      loadObservations,
    });
  }

  async #snapshot(): Promise<DurableCatalogMaterialRegistryState> {
    return this.#store.transact((state) => ({
      next: state,
      result: cloneCanonical(state),
    }));
  }

  async #persistDocument(
    kind: CatalogMaterialKind,
    lookupHash: string,
    documentHash: string,
    sourceCommitment: string | null,
    document: object,
  ): Promise<CatalogMaterialRegistryEntry> {
    if (
      !SHA256.test(lookupHash) ||
      !SHA256.test(documentHash) ||
      (kind === INVENTORY_KIND) !== (sourceCommitment === null) ||
      (sourceCommitment !== null &&
        !SHA256.test(sourceCommitment))
    ) {
      fail();
    }
    const raw = `${canonicalJson(document)}\n`;
    const bytes = Buffer.from(raw, "utf8");
    if (
      bytes.byteLength <= 0 ||
      bytes.byteLength > this.#options.maximumBundleBytes
    ) {
      fail();
    }
    const byteHash = sha256(bytes);
    const expectedArtifact: TrustedCloudArtifactRef = {
      uri: artifactUri(
        this.#options.datasetPinHash,
        kind,
        byteHash,
      ),
      sha256: byteHash,
      mediaType: "application/json",
      byteLength: bytes.byteLength,
    };
    const artifact = await this.#persistVerified({
      uri: expectedArtifact.uri,
      mediaType: expectedArtifact.mediaType,
      chunks: (async function* () {
        yield bytes;
      })(),
    });
    if (
      canonicalJson(artifact) !==
      canonicalJson(expectedArtifact)
    ) {
      fail();
    }
    const unsigned = {
      schemaVersion: 1 as const,
      domain:
        "dark-factory.trusted-catalog-material-registry-entry.v1" as const,
      kind,
      lookupHash,
      documentHash,
      sourceCommitment,
      artifact: cloneCanonical(artifact),
    };
    const entry: CatalogMaterialRegistryEntry = {
      ...unsigned,
      entryHash: entryHash(unsigned),
    };
    assertEntry(entry, this.#options);
    return deepFreeze(entry);
  }

  async #persistBundle(
    bundle: TrustedTerminalBenchCatalogMaterialBundle,
  ): Promise<PersistedBundle> {
    const inventoryQuery = createTrustedCatalogInventoryQuery(
      this.#options.pin,
      this.#options.datasetPinHash,
    );
    const inventory = await this.#persistDocument(
      INVENTORY_KIND,
      inventoryQuery.queryHash,
      bundle.inventory.inventoryHash,
      null,
      bundle.inventory,
    );
    const persistObservation = async (
      kind: TrustedCatalogObservationQuery["sourceKind"],
      document: TrustedTaskObservationSet | null,
    ): Promise<CatalogMaterialRegistryEntry | null> => {
      if (document === null) return null;
      const query = createTrustedCatalogObservationQuery(
        kind,
        document.sourceCommitment,
        this.#options.datasetPinHash,
        bundle.inventory.inventoryHash,
      );
      return this.#persistDocument(
        kind,
        query.queryHash,
        document.observationSetHash,
        document.sourceCommitment,
        document,
      );
    };
    const initialPiBaseline = await persistObservation(
      BASELINE_KIND,
      bundle.initialPiBaseline,
    );
    const comparableLeaderboard = await persistObservation(
      LEADERBOARD_KIND,
      bundle.comparableLeaderboard,
    );
    return {
      bundle,
      inventory,
      initialPiBaseline,
      comparableLeaderboard,
    };
  }

  public async publishCanonicalBundle(
    raw: string,
  ): Promise<TrustedCatalogMaterialPublicationReceipt> {
    try {
      this.#assertTrustedRuntime();
      const bundle = parseCanonicalBundle(raw, this.#options);
      const current = await this.#snapshot();
      if (current.revision === 1) {
        if (
          current.bundleHash !== bundle.bundleHash ||
          current.inventory?.documentHash !==
            bundle.inventory.inventoryHash ||
          current.initialPiBaseline?.documentHash !==
            (bundle.initialPiBaseline?.observationSetHash ??
              undefined) ||
          current.comparableLeaderboard?.documentHash !==
            (bundle.comparableLeaderboard
              ?.observationSetHash ?? undefined)
        ) {
          fail();
        }
        return receipt(
          "already-published",
          bundle,
          current.stateCommitment,
        );
      }
      const persisted = await this.#persistBundle(bundle);
      const next = await this.#store.transact((state) => {
        if (state.revision !== 0) fail();
        const unsigned = {
          schemaVersion: 1 as const,
          sensitivity:
            "trusted-hidden-catalog-material-registry" as const,
          revision: 1 as const,
          datasetPinHash: this.#options.datasetPinHash,
          datasetContentSha256:
            this.#options.pin.datasetContentSha256,
          datasetManifestSha256:
            this.#options.pin.datasetManifestSha256,
          registryRevision: 6 as const,
          taskCount: 89 as const,
          bundleHash: persisted.bundle.bundleHash,
          inventory: persisted.inventory,
          initialPiBaseline: persisted.initialPiBaseline,
          comparableLeaderboard:
            persisted.comparableLeaderboard,
        };
        const nextState: DurableCatalogMaterialRegistryState = {
          ...unsigned,
          stateCommitment: stateCommitment(unsigned),
        };
        assertState(nextState, this.#options);
        return {
          next: nextState,
          result: cloneCanonical(nextState),
        };
      });
      return receipt(
        "published",
        bundle,
        next.stateCommitment,
      );
    } catch {
      fail();
    }
  }

  public async normalizeAndPublishOnce(
    workerInput: TrustedTerminalBenchCatalogNormalizationWorker,
  ): Promise<TrustedCatalogMaterialPublicationReceipt> {
    if (this.#normalizationAttempted) fail();
    this.#normalizationAttempted = true;
    try {
      this.#assertTrustedRuntime();
      exactKeys(workerInput, ["boundary", "normalize"]);
      if (
        workerInput.boundary !==
          "trusted-cloud-terminal-bench-catalog-normalization-worker" ||
        typeof workerInput.normalize !== "function"
      ) {
        fail();
      }
      const normalize =
        workerInput.normalize.bind(workerInput);
      const spec = createTrustedCatalogMaterialNormalizerSpec(
        this.#options.pin,
        this.#options.maximumBundleBytes,
      );
      const specSnapshot = canonicalJson(spec);
      const raw = await normalize(spec);
      if (canonicalJson(spec) !== specSnapshot) fail();
      return await this.publishCanonicalBundle(raw);
    } catch {
      fail();
    }
  }

  async #readDocument(
    entry: CatalogMaterialRegistryEntry,
  ): Promise<Readonly<Record<string, unknown>>> {
    assertEntry(entry, this.#options);
    const raw = await this.#readUtf8(
      cloneCanonical(entry.artifact),
      this.#options.maximumBundleBytes,
    );
    if (
      typeof raw !== "string" ||
      Buffer.byteLength(raw, "utf8") !==
        entry.artifact.byteLength ||
      sha256(raw) !== entry.artifact.sha256
    ) {
      fail();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail();
    }
    if (
      !isPlainRecord(parsed) ||
      raw !== `${canonicalJson(parsed)}\n`
    ) {
      fail();
    }
    return cloneCanonical(parsed);
  }

  async #readInventoryFromState(
    state: DurableCatalogMaterialRegistryState,
  ): Promise<TrustedTerminalBenchTaskInventory> {
    if (state.revision !== 1 || state.inventory === null) fail();
    const document = await this.#readDocument(state.inventory);
    try {
      buildTrustedHiddenCatalogImport({
        expectedDatasetPinHash: this.#options.datasetPinHash,
        inventory:
          document as unknown as TrustedTerminalBenchTaskInventory,
        initialPiBaseline: null,
        comparableLeaderboard: null,
      });
    } catch {
      fail();
    }
    const inventory =
      document as unknown as TrustedTerminalBenchTaskInventory;
    if (
      inventory.inventoryHash !== state.inventory.documentHash
    ) {
      fail();
    }
    return deepFreeze(cloneCanonical(inventory));
  }

  async #loadInventory(
    queryInput: TrustedCatalogInventoryQuery,
  ): Promise<TrustedTerminalBenchTaskInventory> {
    try {
      this.#assertTrustedRuntime();
      const before = canonicalJson(queryInput);
      const query = cloneCanonical(queryInput);
      assertInventoryQuery(query, this.#options);
      const state = await this.#snapshot();
      if (
        state.revision !== 1 ||
        state.inventory === null ||
        state.inventory.lookupHash !== query.queryHash
      ) {
        fail();
      }
      const result = await this.#readInventoryFromState(state);
      if (!unchanged(queryInput, before)) fail();
      return result;
    } catch {
      fail();
    }
  }

  async #loadObservations(
    queryInput: TrustedCatalogObservationQuery,
  ): Promise<TrustedTaskObservationSet> {
    try {
      this.#assertTrustedRuntime();
      const before = canonicalJson(queryInput);
      const query = cloneCanonical(queryInput);
      const state = await this.#snapshot();
      if (
        state.revision !== 1 ||
        state.inventory === null
      ) {
        fail();
      }
      assertObservationQuery(
        query,
        this.#options,
        state.inventory.documentHash,
      );
      const entry =
        query.sourceKind === BASELINE_KIND
          ? state.initialPiBaseline
          : state.comparableLeaderboard;
      if (
        entry === null ||
        entry.lookupHash !== query.queryHash ||
        entry.sourceCommitment !== query.sourceCommitment
      ) {
        fail();
      }
      const inventory =
        await this.#readInventoryFromState(state);
      const document = await this.#readDocument(entry);
      const observations =
        document as unknown as TrustedTaskObservationSet;
      try {
        buildTrustedHiddenCatalogImport({
          expectedDatasetPinHash:
            this.#options.datasetPinHash,
          inventory,
          initialPiBaseline:
            query.sourceKind === BASELINE_KIND
              ? observations
              : null,
          comparableLeaderboard:
            query.sourceKind === LEADERBOARD_KIND
              ? observations
              : null,
        });
      } catch {
        fail();
      }
      if (
        observations.observationSetHash !==
          entry.documentHash ||
        observations.sourceCommitment !==
          entry.sourceCommitment ||
        !unchanged(queryInput, before)
      ) {
        fail();
      }
      return deepFreeze(cloneCanonical(observations));
    } catch {
      fail();
    }
  }

  public close(): Promise<void> {
    return this.#store.close();
  }
}
