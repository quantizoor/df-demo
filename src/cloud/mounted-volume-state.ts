import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import type {
  LinearizableHiddenCatalogCasStore,
  TrustedHiddenCatalogState,
  TrustedHiddenTaskOutcomeStats,
  TrustedStoredHiddenTask,
} from "../broker/catalog.js";
import {
  emptyOneUseLedgerState,
  type AtomicOneUseLedgerStore,
  type BrokerFailureCode,
  type OneUseLedgerRecord,
  type OneUseLedgerState,
} from "../broker/ledger.js";
import type { ExperimentIdentity } from "../domain/models.js";
import type {
  CloudOptimizerAnalysisResult,
  CloudOptimizerExecutionReceipts,
  CloudOptimizerProposalResult,
  CloudOptimizerSessionRecordStore,
} from "../optimizer/cloud-session.js";
import {
  canonicalHash,
  canonicalJson,
  computeContentHash,
} from "../schemas/canonical.js";
import { assertValidDocument } from "../schemas/registry.js";
import { assertTrustedMatchedPanel } from "../terminal-bench/trusted.js";
import type { TrustedArtifactRuntimeGuard } from "./artifact-bridge.js";
import type {
  RemoteExecutionReceipt,
  TrustedCloudArtifactRef,
} from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_PROVIDER_ID =
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/u;
const SAFE_STORE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_STORE_NAMESPACE =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_URI =
  /^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const SAFE_MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u;
const SAFE_PACKAGE_TASK_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_CHANGED_FILE =
  /^(?:packages\/coding-agent|packages\/agent|packages\/ai|packages\/tui|packages\/utils)\/[A-Za-z0-9._/-]+$/u;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const DEFAULT_MAXIMUM_STATE_BYTES = 128 * 1024 * 1024;
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_NODES = 1_000_000;
const MAXIMUM_JSON_STRING_BYTES = 4 * 1024 * 1024;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const BROKER_FAILURE_CODES = new Set<BrokerFailureCode>([
  "panel-allocation-failed",
  "runtime-attestation-failed",
  "evaluation-failed",
  "normalization-failed",
  "raw-destruction-failed",
  "release-validation-failed",
]);
const SELECTION_BUCKETS = new Set([
  "hard",
  "uncertain",
  "easy",
  "coverage",
]);
const CLOUD_PROVIDERS = new Set(["daytona", "e2b", "modal"]);

const LOCK_KEYS = [
  "schemaVersion",
  "domain",
  "namespace",
  "controllerInstanceIdHash",
  "lockNonce",
  "fenceEpoch",
  "acquiredAt",
  "contentHash",
] as const;
const FENCE_KEYS = [
  "schemaVersion",
  "domain",
  "namespace",
  "fenceEpoch",
  "lockHash",
  "authorizedRecoveryThroughEpoch",
  "stateGeneration",
  "stateEnvelopeHash",
  "updatedAt",
  "contentHash",
] as const;
const RECOVERY_KEYS = [
  "schemaVersion",
  "domain",
  "namespace",
  "authorizationId",
  "priorLockHash",
  "priorFenceEpoch",
  "providerTerminationAttestationHash",
  "authorizedAt",
  "signerKeyId",
  "signatureHash",
] as const;
const STATE_ENVELOPE_KEYS = [
  "schemaVersion",
  "domain",
  "generation",
  "previousEnvelopeHash",
  "writerFenceEpoch",
  "committedAt",
  "stateHash",
  "state",
  "contentHash",
] as const;
const CATALOG_STATE_KEYS = [
  "schemaVersion",
  "sensitivity",
  "revision",
  "datasetPinHash",
  "registryRevision",
  "seedSetCommitment",
  "taskIdKeyId",
  "dispositionKeyId",
  "weightingPolicyHash",
  "taskOrder",
  "tasks",
  "validationCarry",
  "repairEpoch",
  "shadowSlices",
  "allocations",
  "outcomeUpdates",
  "stateCommitment",
] as const;
const STORED_TASK_KEYS = [
  "sensitivity",
  "datasetPinHash",
  "registryRevision",
  "packageTaskName",
  "seedEstimates",
  "outcomeStats",
  "taskId",
  "taskRevisionDigest",
  "capabilityStratum",
  "difficultyStratum",
  "buckets",
  "estimates",
  "exposure",
  "shadowReserved",
  "regressionCanary",
  "infrastructureValid",
  "discriminating",
] as const;
const ESTIMATE_KEYS = [
  "championFailureProbability",
  "baselineFailureProbability",
  "leaderboardFailureProbability",
  "recentFailureProbability",
  "outcomeUncertainty",
  "discrimination",
  "componentRelevance",
  "underexposure",
  "missingCapabilityCoverage",
  "normalizedCost",
  "impossibleProbability",
] as const;
const EXPOSURE_KEYS = [
  "total",
  "consecutiveExperiments",
  "lastExperiment",
  "feedbackReleased",
  "positiveValidationConsumed",
  "repairCooldownThroughExperiment",
  "informedHypothesisDigests",
] as const;
const OUTCOME_STATS_KEYS = [
  "candidateObservationCount",
  "candidateFailureCount",
  "candidateRewardSum",
  "championObservationCount",
  "championFailureCount",
  "championRewardSum",
  "matchedObservationCount",
  "discriminationSignalSum",
  "costObservationCount",
  "normalizedCostSignalSum",
  "lastObservedAt",
] as const;
const LEDGER_STATE_KEYS = [
  "revision",
  "records",
  "usedDispositionAttestations",
  "usedRecoveryAuthorizations",
] as const;
const LEDGER_RECORD_KEYS = [
  "requestHash",
  "claimToken",
  "status",
  "dispositionAttestationHash",
  "ownerInstanceIdHash",
  "claimEpoch",
  "recoveryRecordHash",
  "recoveryAuthorizationHash",
  "envelope",
  "failureCode",
] as const;
const OPTIMIZER_STATE_KEYS = [
  "schemaVersion",
  "sensitivity",
  "revision",
  "proposals",
  "analyses",
] as const;
const OPTIMIZER_RECORD_KEYS = [
  "experiment",
  "resultHash",
  "result",
] as const;
const EXPERIMENT_KEYS = [
  "number",
  "slug",
  "kind",
  "parentExperiment",
  "lineageId",
  "protocolHash",
] as const;

export class MountedVolumeStateStoreError extends Error {
  override readonly name = "MountedVolumeStateStoreError";
}

/**
 * The provider bootstrap must supply this guard only after a cloud canary has
 * established atomic exclusive directory creation, same-volume rename, and
 * durable file sync for this exact mounted-volume class.
 */
export interface MountedVolumeStateSemanticsGuard {
  assertLinearizableStateVolume(input: {
    readonly volumeRoot: string;
    readonly namespace: string;
  }): void;
}

export interface MountedVolumeStateLockObservation {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.mounted-volume-lock.v1";
  readonly namespace: string;
  readonly controllerInstanceIdHash: string;
  readonly lockNonce: string;
  readonly fenceEpoch: number;
  readonly acquiredAt: string;
  readonly contentHash: string;
}

export interface TrustedMountedVolumeLockRecoveryAuthorization {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.mounted-volume-lock-recovery.v1";
  readonly namespace: string;
  readonly authorizationId: string;
  readonly priorLockHash: string;
  readonly priorFenceEpoch: number;
  /**
   * Commitment to provider evidence that the prior controller sandbox is
   * irreversibly destroyed. The authority, not this filesystem adapter,
   * verifies that provider evidence.
   */
  readonly providerTerminationAttestationHash: string;
  readonly authorizedAt: string;
  readonly signerKeyId: string;
  readonly signatureHash: string;
}

export interface TrustedMountedVolumeLockRecoveryAuthority {
  authorize(input: {
    readonly observedLock: MountedVolumeStateLockObservation;
    readonly observedLockHash: string;
  }): Promise<TrustedMountedVolumeLockRecoveryAuthorization | null>;
}

export interface MountedVolumeDurableStateOptions {
  /** Absolute provider-managed mount point; never a workstation directory. */
  readonly volumeRoot: string;
  /** Campaign-scoped identifier used to prevent unrelated state sharing. */
  readonly storeId: string;
  /** Hash of the unique provider controller/sandbox instance identity. */
  readonly controllerInstanceIdHash: string;
  readonly runtimeGuard: TrustedArtifactRuntimeGuard;
  readonly semanticsGuard: MountedVolumeStateSemanticsGuard;
  readonly recoveryAuthority?: TrustedMountedVolumeLockRecoveryAuthority;
  readonly now?: () => Date;
  readonly nonceFactory?: () => string;
  readonly maximumStateBytes?: number;
}

interface LockFenceState {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.mounted-volume-fence.v1";
  readonly namespace: string;
  readonly fenceEpoch: number;
  readonly lockHash: string;
  readonly authorizedRecoveryThroughEpoch: number;
  readonly stateGeneration: number;
  readonly stateEnvelopeHash: string | null;
  readonly updatedAt: string;
  readonly contentHash: string;
}

interface MountedVolumeStateEnvelope<State> {
  readonly schemaVersion: 1;
  readonly domain: string;
  readonly generation: number;
  readonly previousEnvelopeHash: string | null;
  readonly writerFenceEpoch: number;
  readonly committedAt: string;
  readonly stateHash: string;
  readonly state: State;
  readonly contentHash: string;
}

/**
 * Strict codec for a state domain persisted by the mounted-volume
 * transactional store. The assertion must validate the complete durable
 * shape; accepting a partial shape would turn storage corruption into trusted
 * controller state.
 */
export interface MountedVolumeTransactionalStateCodec<State> {
  readonly domain: string;
  readonly initialState: () => State;
  assertState(value: unknown): asserts value is State;
  revision(state: State): number;
}

interface OptimizerStoredRecord<Result> {
  readonly experiment: ExperimentIdentity;
  readonly resultHash: string;
  readonly result: Result;
}

interface OptimizerSessionRecordState {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-optimizer-session-records";
  readonly revision: number;
  readonly proposals: Readonly<
    Record<string, OptimizerStoredRecord<CloudOptimizerProposalResult>>
  >;
  readonly analyses: Readonly<
    Record<string, OptimizerStoredRecord<CloudOptimizerAnalysisResult>>
  >;
}

function isErrno(error: unknown, ...codes: readonly string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    codes.includes(String((error as NodeJS.ErrnoException).code))
  );
}

function fail(message: string): never {
  throw new MountedVolumeStateStoreError(message);
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

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  ) {
    fail(`${label} contains unsupported fields.`);
  }
}

function assertCanonicalJsonTree(value: unknown, label: string): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) break;
    nodes += 1;
    if (nodes > MAXIMUM_JSON_NODES || entry.depth > MAXIMUM_JSON_DEPTH) {
      fail(`${label} exceeds the bounded JSON shape policy.`);
    }
    if (
      entry.value === null ||
      typeof entry.value === "boolean"
    ) {
      continue;
    }
    if (typeof entry.value === "number") {
      if (!Number.isFinite(entry.value)) {
        fail(`${label} contains a non-finite number.`);
      }
      continue;
    }
    if (typeof entry.value === "string") {
      if (
        Buffer.byteLength(entry.value, "utf8") >
        MAXIMUM_JSON_STRING_BYTES
      ) {
        fail(`${label} contains an oversized string.`);
      }
      continue;
    }
    if (Array.isArray(entry.value)) {
      for (const item of entry.value) {
        pending.push({ value: item, depth: entry.depth + 1 });
      }
      continue;
    }
    if (!isPlainRecord(entry.value)) {
      fail(`${label} is not strict JSON.`);
    }
    for (const [key, item] of Object.entries(entry.value)) {
      if (DANGEROUS_KEYS.has(key) || key.includes("\u0000")) {
        fail(`${label} contains an unsafe object key.`);
      }
      pending.push({ value: item, depth: entry.depth + 1 });
    }
  }
}

function canonicalClone<Value>(value: Value, label: string): Value {
  assertCanonicalJsonTree(value, label);
  let serialized: string;
  try {
    serialized = canonicalJson(value);
  } catch {
    fail(`${label} cannot be represented as canonical JSON.`);
  }
  return JSON.parse(serialized) as Value;
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(`${label} is not a canonical UTC timestamp.`);
  }
}

function nowTimestamp(now: () => Date): string {
  const value = now();
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime())
  ) {
    fail("Mounted-volume state clock returned an invalid date.");
  }
  return value.toISOString();
}

function assertContentHash(
  value: Readonly<Record<string, unknown>>,
  label: string,
): void {
  if (
    typeof value.contentHash !== "string" ||
    !SHA256.test(value.contentHash) ||
    value.contentHash !== computeContentHash(value)
  ) {
    fail(`${label} has an invalid content hash.`);
  }
}

function withContentHash<Value extends Readonly<Record<string, unknown>>>(
  value: Value,
): Value & { readonly contentHash: string } {
  const draft = { ...value, contentHash: "" };
  return { ...value, contentHash: computeContentHash(draft) };
}

function assertBoundedRoot(volumeRoot: string): string {
  const root = resolve(volumeRoot);
  if (
    !isAbsolute(volumeRoot) ||
    root === sep ||
    volumeRoot.includes("\u0000") ||
    volumeRoot.split(sep).includes("..")
  ) {
    fail("Mutable state volume root must be a bounded absolute path.");
  }
  return root;
}

async function assertSafeDirectory(
  path: string,
  label: string,
): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch {
    fail(`${label} is missing or unreadable.`);
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path
  ) {
    fail(`${label} is not a real directory.`);
  }
}

async function createAndAssertDirectory(
  path: string,
  label: string,
  recursive: boolean,
): Promise<void> {
  await mkdir(path, { recursive, mode: 0o700 });
  await assertSafeDirectory(path, label);
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch {
    fail(`${label} is missing or unreadable.`);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    fail(`${label} is not a single-link regular file.`);
  }
}

async function readBoundedCanonicalFile(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<unknown> {
  await assertRegularFile(path, label);
  const before = await stat(path);
  if (
    !Number.isSafeInteger(before.size) ||
    before.size <= 0 ||
    before.size > maximumBytes
  ) {
    fail(`${label} size is outside policy.`);
  }
  let handle: FileHandle | undefined;
  let raw: string;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size !== before.size ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev
    ) {
      fail(`${label} changed while it was opened.`);
    }
    raw = await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle?.close();
  }
  if (Buffer.byteLength(raw, "utf8") !== before.size) {
    fail(`${label} changed while it was read.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${label} is not JSON.`);
  }
  assertCanonicalJsonTree(parsed, label);
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch {
    fail(`${label} is not canonical JSON.`);
  }
  if (raw !== `${canonical}\n`) {
    fail(`${label} is not in canonical byte form.`);
  }
  return parsed;
}

async function syncDirectory(path: string, label: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    await handle.sync();
  } catch {
    fail(`${label} could not be durably synchronized.`);
  } finally {
    await handle?.close();
  }
}

async function atomicWriteCanonicalFile(
  input: {
    readonly target: string;
    readonly stagingRoot: string;
    readonly stagingName: string;
    readonly value: unknown;
    readonly maximumBytes: number;
    readonly label: string;
  },
): Promise<void> {
  const serialized = `${canonicalJson(input.value)}\n`;
  if (
    Buffer.byteLength(serialized, "utf8") <= 0 ||
    Buffer.byteLength(serialized, "utf8") > input.maximumBytes
  ) {
    fail(`${input.label} serialized size is outside policy.`);
  }
  const temporary = join(
    input.stagingRoot,
    `${input.stagingName}-${randomBytes(18).toString("hex")}.tmp`,
  );
  let handle: FileHandle | undefined;
  let renamed = false;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      const targetInfo = await lstat(input.target);
      if (
        !targetInfo.isFile() ||
        targetInfo.isSymbolicLink() ||
        targetInfo.nlink !== 1
      ) {
        fail(`${input.label} target is unsafe.`);
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    await rename(temporary, input.target);
    renamed = true;
    const separator = input.target.lastIndexOf(sep);
    if (separator <= 0) fail(`${input.label} has no bounded parent.`);
    await syncDirectory(
      input.target.slice(0, separator),
      `${input.label} parent`,
    );
  } finally {
    await handle?.close();
    if (!renamed) {
      try {
        await rm(temporary, { force: true });
      } catch {
        // The authoritative write still fails; staging cleanup is best effort.
      }
    }
  }
}

function assertLockObservation(
  value: unknown,
  namespace: string,
): asserts value is MountedVolumeStateLockObservation {
  if (!isPlainRecord(value)) fail("Controller lock metadata is not an object.");
  assertExactKeys(value, LOCK_KEYS, "Controller lock metadata");
  if (
    value.schemaVersion !== 1 ||
    value.domain !== "dark-factory.mounted-volume-lock.v1" ||
    value.namespace !== namespace ||
    typeof value.controllerInstanceIdHash !== "string" ||
    !SHA256.test(value.controllerInstanceIdHash) ||
    typeof value.lockNonce !== "string" ||
    !/^[a-f0-9]{48}$/u.test(value.lockNonce) ||
    !Number.isSafeInteger(value.fenceEpoch) ||
    (value.fenceEpoch as number) <= 0
  ) {
    fail("Controller lock metadata is malformed.");
  }
  assertTimestamp(value.acquiredAt, "Controller lock acquisition time");
  assertContentHash(value, "Controller lock metadata");
}

function assertFenceState(
  value: unknown,
  namespace: string,
): asserts value is LockFenceState {
  if (!isPlainRecord(value)) fail("Controller fence state is not an object.");
  assertExactKeys(value, FENCE_KEYS, "Controller fence state");
  if (
    value.schemaVersion !== 1 ||
    value.domain !== "dark-factory.mounted-volume-fence.v1" ||
    value.namespace !== namespace ||
    !Number.isSafeInteger(value.fenceEpoch) ||
    (value.fenceEpoch as number) <= 0 ||
    typeof value.lockHash !== "string" ||
    !SHA256.test(value.lockHash) ||
    !Number.isSafeInteger(value.authorizedRecoveryThroughEpoch) ||
    (value.authorizedRecoveryThroughEpoch as number) < 0 ||
    (value.authorizedRecoveryThroughEpoch as number) >=
      (value.fenceEpoch as number) ||
    !Number.isSafeInteger(value.stateGeneration) ||
    (value.stateGeneration as number) < 0 ||
    (value.stateEnvelopeHash !== null &&
      (typeof value.stateEnvelopeHash !== "string" ||
        !SHA256.test(value.stateEnvelopeHash))) ||
    ((value.stateGeneration as number) === 0) !==
      (value.stateEnvelopeHash === null)
  ) {
    fail("Controller fence state is malformed.");
  }
  assertTimestamp(value.updatedAt, "Controller fence update time");
  assertContentHash(value, "Controller fence state");
}

function assertRecoveryAuthorization(
  value: unknown,
  observed: MountedVolumeStateLockObservation,
): asserts value is TrustedMountedVolumeLockRecoveryAuthorization {
  if (!isPlainRecord(value)) {
    fail("Controller recovery authorization is not an object.");
  }
  assertExactKeys(value, RECOVERY_KEYS, "Controller recovery authorization");
  if (
    value.schemaVersion !== 1 ||
    value.domain !== "dark-factory.mounted-volume-lock-recovery.v1" ||
    value.namespace !== observed.namespace ||
    typeof value.authorizationId !== "string" ||
    !SAFE_ID.test(value.authorizationId) ||
    value.priorLockHash !== observed.contentHash ||
    value.priorFenceEpoch !== observed.fenceEpoch ||
    typeof value.providerTerminationAttestationHash !== "string" ||
    !SHA256.test(value.providerTerminationAttestationHash) ||
    typeof value.signerKeyId !== "string" ||
    !SAFE_ID.test(value.signerKeyId) ||
    typeof value.signatureHash !== "string" ||
    !SHA256.test(value.signatureHash)
  ) {
    fail("Controller recovery authorization does not bind the observed lock.");
  }
  assertTimestamp(value.authorizedAt, "Controller recovery authorization time");
}

class MountedVolumeSingleWriterCoordinator {
  readonly #root: string;
  readonly #namespace: string;
  readonly #controllerInstanceIdHash: string;
  readonly #runtimeGuard: TrustedArtifactRuntimeGuard;
  readonly #semanticsGuard: MountedVolumeStateSemanticsGuard;
  readonly #recoveryAuthority:
    | TrustedMountedVolumeLockRecoveryAuthority
    | undefined;
  readonly #now: () => Date;
  readonly #nonceFactory: () => string;
  readonly #stateRoot: string;
  readonly #locksRoot: string;
  readonly #activeLockPath: string;
  readonly #releasedLocksRoot: string;
  readonly #quarantinedLocksRoot: string;
  readonly #recoveriesRoot: string;
  readonly #stagingRoot: string;
  readonly #fencePath: string;
  #ownedLock: MountedVolumeStateLockObservation | null = null;
  #initialized = false;
  #closing = false;
  #tail: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | null = null;

  constructor(
    options: MountedVolumeDurableStateOptions,
    namespace: string,
  ) {
    this.#root = assertBoundedRoot(options.volumeRoot);
    this.#namespace = namespace;
    this.#controllerInstanceIdHash = options.controllerInstanceIdHash;
    this.#runtimeGuard = options.runtimeGuard;
    this.#semanticsGuard = options.semanticsGuard;
    this.#recoveryAuthority = options.recoveryAuthority;
    this.#now = options.now ?? (() => new Date());
    this.#nonceFactory =
      options.nonceFactory ?? (() => randomBytes(24).toString("hex"));
    this.#stateRoot = join(this.#root, "mutable-state");
    this.#locksRoot = join(this.#stateRoot, "locks");
    this.#activeLockPath = join(this.#locksRoot, namespace);
    this.#releasedLocksRoot = join(this.#stateRoot, "released-locks");
    this.#quarantinedLocksRoot = join(
      this.#stateRoot,
      "quarantined-locks",
    );
    this.#recoveriesRoot = join(this.#stateRoot, "recovery-authorizations");
    this.#stagingRoot = join(this.#stateRoot, ".staging");
    this.#fencePath = join(this.#stateRoot, `fence-${namespace}.json`);
    if (!SHA256.test(this.#controllerInstanceIdHash)) {
      fail("Controller instance identity must be a SHA-256 commitment.");
    }
  }

  get root(): string {
    return this.#stateRoot;
  }

  get stagingRoot(): string {
    return this.#stagingRoot;
  }

  get fenceEpoch(): number {
    if (this.#ownedLock === null) {
      fail("Mutable state coordinator does not own its controller lock.");
    }
    return this.#ownedLock.fenceEpoch;
  }

  async #initializeDirectories(): Promise<void> {
    this.#runtimeGuard.assertTrustedCloudRuntime();
    this.#semanticsGuard.assertLinearizableStateVolume({
      volumeRoot: this.#root,
      namespace: this.#namespace,
    });
    if (this.#initialized) return;
    await createAndAssertDirectory(
      this.#root,
      "Mutable state volume root",
      true,
    );
    await createAndAssertDirectory(
      this.#stateRoot,
      "Mutable state root",
      true,
    );
    for (const [path, label] of [
      [this.#locksRoot, "Mutable state locks root"],
      [this.#releasedLocksRoot, "Released locks root"],
      [this.#quarantinedLocksRoot, "Quarantined locks root"],
      [this.#recoveriesRoot, "Recovery authorization root"],
      [this.#stagingRoot, "Mutable state staging root"],
    ] as const) {
      await createAndAssertDirectory(path, label, true);
    }
    this.#initialized = true;
  }

  async #readActiveLock(): Promise<MountedVolumeStateLockObservation | null> {
    let info: Stats;
    try {
      info = await lstat(this.#activeLockPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(this.#activeLockPath)) !== this.#activeLockPath
    ) {
      fail("Active controller lock is not a real directory.");
    }
    const parsed = await readBoundedCanonicalFile(
      join(this.#activeLockPath, "owner.json"),
      8_192,
      "Active controller lock owner",
    );
    assertLockObservation(parsed, this.#namespace);
    return parsed;
  }

  async #readFence(): Promise<LockFenceState | null> {
    try {
      await lstat(this.#fencePath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
    const parsed = await readBoundedCanonicalFile(
      this.#fencePath,
      8_192,
      "Controller fence state",
    );
    assertFenceState(parsed, this.#namespace);
    return parsed;
  }

  async #persistRecoveryAuthorization(
    authorization: TrustedMountedVolumeLockRecoveryAuthorization,
  ): Promise<void> {
    const hash = canonicalHash(authorization);
    const target = join(
      this.#recoveriesRoot,
      `${authorization.priorLockHash}-${hash}.json`,
    );
    let exists = true;
    try {
      await lstat(target);
    } catch (error) {
      if (isErrno(error, "ENOENT")) exists = false;
      else throw error;
    }
    if (exists) {
      const existing = await readBoundedCanonicalFile(
        target,
        16_384,
        "Controller recovery authorization",
      );
      if (canonicalJson(existing) !== canonicalJson(authorization)) {
        fail("Controller recovery authorization path is not immutable.");
      }
      return;
    }
    await atomicWriteCanonicalFile({
      target,
      stagingRoot: this.#stagingRoot,
      stagingName: "recovery",
      value: authorization,
      maximumBytes: 16_384,
      label: "Controller recovery authorization",
    });
  }

  async #quarantinePriorLock(
    observed: MountedVolumeStateLockObservation,
  ): Promise<number> {
    if (this.#recoveryAuthority === undefined) {
      fail(
        "A prior controller lock exists; provider-attested recovery is required.",
      );
    }
    const authorization = await this.#recoveryAuthority.authorize({
      observedLock: canonicalClone(observed, "Observed controller lock"),
      observedLockHash: observed.contentHash,
    });
    if (authorization === null) {
      fail(
        "The recovery authority did not prove prior controller destruction.",
      );
    }
    assertRecoveryAuthorization(authorization, observed);
    const current = await this.#readActiveLock();
    if (
      current === null ||
      canonicalJson(current) !== canonicalJson(observed)
    ) {
      fail("The active controller lock changed during recovery.");
    }
    await this.#persistRecoveryAuthorization(authorization);
    const quarantinePath = join(
      this.#quarantinedLocksRoot,
      `${observed.fenceEpoch.toString().padStart(16, "0")}-${observed.contentHash}`,
    );
    try {
      await rename(this.#activeLockPath, quarantinePath);
    } catch (error) {
      if (isErrno(error, "ENOENT", "EEXIST", "ENOTEMPTY")) {
        fail("Controller lock recovery lost its exclusive quarantine race.");
      }
      throw error;
    }
    await syncDirectory(this.#locksRoot, "Mutable state locks root");
    await syncDirectory(
      this.#quarantinedLocksRoot,
      "Quarantined locks root",
    );
    return observed.fenceEpoch;
  }

  async #acquireLock(): Promise<void> {
    await this.#initializeDirectories();
    if (this.#ownedLock !== null) {
      await this.assertOwnership();
      return;
    }
    let recoveredEpoch = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = await this.#readActiveLock();
      if (existing !== null) {
        recoveredEpoch = Math.max(
          recoveredEpoch,
          await this.#quarantinePriorLock(existing),
        );
        continue;
      }
      const fence = await this.#readFence();
      const fenceEpoch =
        Math.max(fence?.fenceEpoch ?? 0, recoveredEpoch) + 1;
      if (!Number.isSafeInteger(fenceEpoch) || fenceEpoch <= 0) {
        fail("Controller fence epoch is exhausted.");
      }
      const lockNonce = this.#nonceFactory();
      if (!/^[a-f0-9]{48}$/u.test(lockNonce)) {
        fail("Controller lock nonce factory returned an unsafe value.");
      }
      const lock = withContentHash({
        schemaVersion: 1 as const,
        domain: "dark-factory.mounted-volume-lock.v1" as const,
        namespace: this.#namespace,
        controllerInstanceIdHash: this.#controllerInstanceIdHash,
        lockNonce,
        fenceEpoch,
        acquiredAt: nowTimestamp(this.#now),
      });
      const stagingDirectory = join(
        this.#stagingRoot,
        `lock-${this.#namespace}-${lockNonce}`,
      );
      await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
      try {
        await atomicWriteCanonicalFile({
          target: join(stagingDirectory, "owner.json"),
          stagingRoot: this.#stagingRoot,
          stagingName: "lock-owner",
          value: lock,
          maximumBytes: 8_192,
          label: "Controller lock owner",
        });
        try {
          await rename(stagingDirectory, this.#activeLockPath);
        } catch (error) {
          if (isErrno(error, "EEXIST", "ENOTEMPTY")) {
            await rm(stagingDirectory, { recursive: true, force: true });
            fail("Another trusted controller acquired the state lock.");
          }
          throw error;
        }
      } catch (error) {
        try {
          await rm(stagingDirectory, { recursive: true, force: true });
        } catch {
          // Preserve the authoritative acquisition failure.
        }
        throw error;
      }
      await syncDirectory(this.#locksRoot, "Mutable state locks root");
      const observed = await this.#readActiveLock();
      if (
        observed === null ||
        canonicalJson(observed) !== canonicalJson(lock)
      ) {
        fail("Controller lock ownership could not be verified.");
      }
      this.#ownedLock = lock;
      const nextFence = withContentHash({
        schemaVersion: 1 as const,
        domain: "dark-factory.mounted-volume-fence.v1" as const,
        namespace: this.#namespace,
        fenceEpoch,
        lockHash: lock.contentHash,
        authorizedRecoveryThroughEpoch: Math.max(
          fence?.authorizedRecoveryThroughEpoch ?? 0,
          recoveredEpoch,
        ),
        stateGeneration: fence?.stateGeneration ?? 0,
        stateEnvelopeHash: fence?.stateEnvelopeHash ?? null,
        updatedAt: nowTimestamp(this.#now),
      });
      await atomicWriteCanonicalFile({
        target: this.#fencePath,
        stagingRoot: this.#stagingRoot,
        stagingName: `fence-${this.#namespace}`,
        value: nextFence,
        maximumBytes: 8_192,
        label: "Controller fence state",
      });
      await this.assertOwnership();
      return;
    }
    fail("Controller lock acquisition exceeded the bounded recovery limit.");
  }

  async assertOwnership(): Promise<void> {
    this.#runtimeGuard.assertTrustedCloudRuntime();
    this.#semanticsGuard.assertLinearizableStateVolume({
      volumeRoot: this.#root,
      namespace: this.#namespace,
    });
    if (this.#ownedLock === null) {
      fail("The trusted controller does not own the mutable-state lock.");
    }
    const observed = await this.#readActiveLock();
    const fence = await this.#readFence();
    if (
      observed === null ||
      fence === null ||
      canonicalJson(observed) !== canonicalJson(this.#ownedLock) ||
      fence.fenceEpoch !== this.#ownedLock.fenceEpoch ||
      fence.lockHash !== this.#ownedLock.contentHash
    ) {
      fail("Mutable-state lock ownership or fence continuity was lost.");
    }
  }

  async reconcileStateHead(input: {
    readonly generation: number;
    readonly contentHash: string;
    readonly previousEnvelopeHash: string | null;
    readonly writerFenceEpoch: number;
  } | null): Promise<void> {
    await this.assertOwnership();
    const fence = await this.#readFence();
    if (fence === null || this.#ownedLock === null) {
      fail("Mutable-state fence disappeared during head reconciliation.");
    }
    if (input === null) {
      if (
        fence.stateGeneration !== 0 ||
        fence.stateEnvelopeHash !== null
      ) {
        fail("Mutable state payload was rolled back behind its durable head.");
      }
      return;
    }
    if (
      !Number.isSafeInteger(input.generation) ||
      input.generation <= 0 ||
      !SHA256.test(input.contentHash) ||
      (input.previousEnvelopeHash !== null &&
        !SHA256.test(input.previousEnvelopeHash)) ||
      !Number.isSafeInteger(input.writerFenceEpoch) ||
      input.writerFenceEpoch <= 0 ||
      input.writerFenceEpoch > this.#ownedLock.fenceEpoch
    ) {
      fail("Mutable state head candidate is malformed.");
    }
    if (
      input.generation === fence.stateGeneration &&
      input.contentHash === fence.stateEnvelopeHash
    ) {
      return;
    }
    const authorizedWriter =
      input.writerFenceEpoch === this.#ownedLock.fenceEpoch ||
      input.writerFenceEpoch <= fence.authorizedRecoveryThroughEpoch;
    if (
      !authorizedWriter ||
      input.generation !== fence.stateGeneration + 1 ||
      input.previousEnvelopeHash !== fence.stateEnvelopeHash
    ) {
      fail("Mutable state payload diverges from its durable fence head.");
    }
    const advancedFence = withContentHash({
      schemaVersion: 1 as const,
      domain: "dark-factory.mounted-volume-fence.v1" as const,
      namespace: this.#namespace,
      fenceEpoch: this.#ownedLock.fenceEpoch,
      lockHash: this.#ownedLock.contentHash,
      authorizedRecoveryThroughEpoch:
        fence.authorizedRecoveryThroughEpoch,
      stateGeneration: input.generation,
      stateEnvelopeHash: input.contentHash,
      updatedAt: nowTimestamp(this.#now),
    });
    await atomicWriteCanonicalFile({
      target: this.#fencePath,
      stagingRoot: this.#stagingRoot,
      stagingName: `fence-head-${this.#namespace}`,
      value: advancedFence,
      maximumBytes: 8_192,
      label: "Controller fence state",
    });
    await this.assertOwnership();
  }

  async runExclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.#closing) {
      fail("Mutable state coordinator is closing.");
    }
    let releaseTurn: (() => void) | undefined;
    const turn = new Promise<void>((resolveTurn) => {
      releaseTurn = resolveTurn;
    });
    const predecessor = this.#tail;
    this.#tail = predecessor.then(
      () => turn,
      () => turn,
    );
    await predecessor;
    try {
      await this.#acquireLock();
      await this.assertOwnership();
      return await operation();
    } finally {
      releaseTurn?.();
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = this.#releaseAfterTail();
    return this.#closePromise;
  }

  async #releaseAfterTail(): Promise<void> {
    await this.#tail;
    if (this.#ownedLock === null) return;
    await this.assertOwnership();
    const releasePath = join(
      this.#releasedLocksRoot,
      `${this.#ownedLock.fenceEpoch.toString().padStart(16, "0")}-${this.#ownedLock.contentHash}`,
    );
    try {
      await rename(this.#activeLockPath, releasePath);
    } catch (error) {
      if (isErrno(error, "EEXIST", "ENOTEMPTY", "ENOENT")) {
        fail("Controller lock could not be released without ambiguity.");
      }
      throw error;
    }
    await syncDirectory(this.#locksRoot, "Mutable state locks root");
    await syncDirectory(this.#releasedLocksRoot, "Released locks root");
    this.#ownedLock = null;
  }
}

/**
 * Fenced, linearizable JSON state primitive for trusted-cloud production
 * ports. Domain-specific adapters should expose a narrower interface and
 * provide a complete state validator.
 */
export class MountedVolumeTransactionalJsonStore<State> {
  readonly #coordinator: MountedVolumeSingleWriterCoordinator;
  readonly #codec: MountedVolumeTransactionalStateCodec<State>;
  readonly #storeDirectory: string;
  readonly #statePath: string;
  readonly #maximumStateBytes: number;
  readonly #now: () => Date;

  constructor(
    options: MountedVolumeDurableStateOptions,
    namespace: string,
    codec: MountedVolumeTransactionalStateCodec<State>,
  ) {
    if (!SAFE_STORE_NAMESPACE.test(namespace)) {
      fail("Mounted-volume state namespace is malformed.");
    }
    this.#coordinator = new MountedVolumeSingleWriterCoordinator(
      options,
      namespace,
    );
    this.#codec = codec;
    this.#storeDirectory = join(
      this.#coordinator.root,
      "stores",
      namespace,
    );
    this.#statePath = join(this.#storeDirectory, "state.json");
    this.#maximumStateBytes =
      options.maximumStateBytes ?? DEFAULT_MAXIMUM_STATE_BYTES;
    this.#now = options.now ?? (() => new Date());
    if (
      !Number.isSafeInteger(this.#maximumStateBytes) ||
      this.#maximumStateBytes < 4_096 ||
      this.#maximumStateBytes > 1024 * 1024 * 1024
    ) {
      fail("Mutable state byte limit is outside policy.");
    }
  }

  async #initializeStoreDirectory(): Promise<void> {
    const storesRoot = join(this.#coordinator.root, "stores");
    await createAndAssertDirectory(
      storesRoot,
      "Mutable state stores root",
      true,
    );
    try {
      await mkdir(this.#storeDirectory, {
        recursive: false,
        mode: 0o700,
      });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    await assertSafeDirectory(
      this.#storeDirectory,
      "Mutable state store directory",
    );
  }

  #assertEnvelope(
    value: unknown,
  ): asserts value is MountedVolumeStateEnvelope<State> {
    if (!isPlainRecord(value)) fail("Mutable state envelope is not an object.");
    assertExactKeys(value, STATE_ENVELOPE_KEYS, "Mutable state envelope");
    if (
      value.schemaVersion !== 1 ||
      value.domain !== this.#codec.domain ||
      !Number.isSafeInteger(value.generation) ||
      (value.generation as number) <= 0 ||
      (value.previousEnvelopeHash !== null &&
        (typeof value.previousEnvelopeHash !== "string" ||
          !SHA256.test(value.previousEnvelopeHash))) ||
      (((value.generation as number) === 1) !==
        (value.previousEnvelopeHash === null)) ||
      !Number.isSafeInteger(value.writerFenceEpoch) ||
      (value.writerFenceEpoch as number) <= 0 ||
      typeof value.stateHash !== "string" ||
      !SHA256.test(value.stateHash)
    ) {
      fail("Mutable state envelope metadata is malformed.");
    }
    assertTimestamp(value.committedAt, "Mutable state commit time");
    this.#codec.assertState(value.state);
    if (value.stateHash !== canonicalHash(value.state)) {
      fail("Mutable state payload hash is invalid.");
    }
    assertContentHash(value, "Mutable state envelope");
  }

  async #readEnvelope(): Promise<MountedVolumeStateEnvelope<State> | null> {
    try {
      await lstat(this.#statePath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
    const parsed = await readBoundedCanonicalFile(
      this.#statePath,
      this.#maximumStateBytes,
      "Mutable state envelope",
    );
    this.#assertEnvelope(parsed);
    return parsed;
  }

  async transact<Result>(
    operation: (state: State) => {
      readonly next: State;
      readonly result: Result;
    },
  ): Promise<Result> {
    if (typeof operation !== "function") {
      fail("Mutable state transaction callback is required.");
    }
    return this.#coordinator.runExclusive(async () => {
      await this.#initializeStoreDirectory();
      await this.#coordinator.assertOwnership();
      const currentEnvelope = await this.#readEnvelope();
      await this.#coordinator.reconcileStateHead(
        currentEnvelope === null
          ? null
          : {
              generation: currentEnvelope.generation,
              contentHash: currentEnvelope.contentHash,
              previousEnvelopeHash: currentEnvelope.previousEnvelopeHash,
              writerFenceEpoch: currentEnvelope.writerFenceEpoch,
            },
      );
      const current = canonicalClone(
        currentEnvelope?.state ?? this.#codec.initialState(),
        "Mutable transaction input",
      );
      this.#codec.assertState(current);
      const currentCanonical = canonicalJson(current);
      const currentRevision = this.#codec.revision(current);
      let transition:
        | {
            readonly next: State;
            readonly result: Result;
          }
        | undefined;
      transition = operation(current);
      if (
        transition === undefined ||
        !isPlainRecord(transition) ||
        !Object.hasOwn(transition, "next") ||
        !Object.hasOwn(transition, "result") ||
        Object.keys(transition).length !== 2
      ) {
        fail("Mutable state transaction returned an invalid transition.");
      }
      const next = canonicalClone(
        transition.next,
        "Mutable transaction output",
      );
      this.#codec.assertState(next);
      const nextCanonical = canonicalJson(next);
      const nextRevision = this.#codec.revision(next);
      if (
        (nextCanonical === currentCanonical &&
          nextRevision !== currentRevision) ||
        (nextCanonical !== currentCanonical &&
          nextRevision !== currentRevision + 1)
      ) {
        fail("Mutable state revision is not a single linearized transition.");
      }
      if (
        currentEnvelope !== null &&
        nextCanonical === currentCanonical
      ) {
        await this.#coordinator.assertOwnership();
        return transition.result;
      }
      const envelope = withContentHash({
        schemaVersion: 1 as const,
        domain: this.#codec.domain,
        generation: (currentEnvelope?.generation ?? 0) + 1,
        previousEnvelopeHash: currentEnvelope?.contentHash ?? null,
        writerFenceEpoch: this.#coordinator.fenceEpoch,
        committedAt: nowTimestamp(this.#now),
        stateHash: canonicalHash(next),
        state: next,
      });
      this.#assertEnvelope(envelope);
      await this.#coordinator.assertOwnership();
      await atomicWriteCanonicalFile({
        target: this.#statePath,
        stagingRoot: this.#coordinator.stagingRoot,
        stagingName: "state",
        value: envelope,
        maximumBytes: this.#maximumStateBytes,
        label: "Mutable state envelope",
      });
      await this.#coordinator.reconcileStateHead({
        generation: envelope.generation,
        contentHash: envelope.contentHash,
        previousEnvelopeHash: envelope.previousEnvelopeHash,
        writerFenceEpoch: envelope.writerFenceEpoch,
      });
      const committed = await this.#readEnvelope();
      if (
        committed === null ||
        canonicalJson(committed) !== canonicalJson(envelope)
      ) {
        fail("Mutable state commit could not be read back exactly.");
      }
      return transition.result;
    });
  }

  close(): Promise<void> {
    return this.#coordinator.close();
  }
}

function assertLedgerRecord(
  requestId: string,
  value: unknown,
): asserts value is OneUseLedgerRecord {
  if (!isPlainRecord(value)) fail("One-use ledger record is not an object.");
  assertExactKeys(value, LEDGER_RECORD_KEYS, "One-use ledger record");
  if (
    !SAFE_ID.test(requestId) ||
    typeof value.requestHash !== "string" ||
    !SHA256.test(value.requestHash) ||
    typeof value.claimToken !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.claimToken) ||
    (value.status !== "in-flight" &&
      value.status !== "completed" &&
      value.status !== "consumed") ||
    (value.dispositionAttestationHash !== null &&
      (typeof value.dispositionAttestationHash !== "string" ||
        !SHA256.test(value.dispositionAttestationHash))) ||
    typeof value.ownerInstanceIdHash !== "string" ||
    !SHA256.test(value.ownerInstanceIdHash) ||
    !Number.isSafeInteger(value.claimEpoch) ||
    (value.claimEpoch as number) <= 0 ||
    (value.recoveryRecordHash !== null &&
      (typeof value.recoveryRecordHash !== "string" ||
        !SHA256.test(value.recoveryRecordHash))) ||
    (value.recoveryAuthorizationHash !== null &&
      (typeof value.recoveryAuthorizationHash !== "string" ||
        !SHA256.test(value.recoveryAuthorizationHash))) ||
    (value.failureCode !== null &&
      (typeof value.failureCode !== "string" ||
        !BROKER_FAILURE_CODES.has(value.failureCode as BrokerFailureCode)))
  ) {
    fail("One-use ledger record is malformed.");
  }
  if (value.envelope !== null) {
    assertValidDocument("signedResultEnvelope", value.envelope);
  }
  if (
    ((value.claimEpoch as number) === 1 &&
      (value.recoveryRecordHash !== null ||
        value.recoveryAuthorizationHash !== null)) ||
    ((value.claimEpoch as number) > 1 &&
      (value.recoveryRecordHash === null ||
        value.recoveryAuthorizationHash === null)) ||
    (value.status === "in-flight" &&
      (value.envelope !== null || value.failureCode !== null)) ||
    (value.status === "completed" &&
      (value.envelope === null ||
        value.failureCode !== null ||
        value.dispositionAttestationHash === null)) ||
    (value.status === "consumed" &&
      (value.envelope !== null || value.failureCode === null))
  ) {
    fail("One-use ledger record status fields are inconsistent.");
  }
  if (
    value.status === "completed" &&
    value.envelope !== null &&
    (value.envelope.oneUseRequest.requestId !== requestId ||
      value.envelope.oneUseRequest.requestHash !== value.requestHash ||
      value.envelope.oneUseRequest.dispositionAttestationHash !==
        value.dispositionAttestationHash)
  ) {
    fail("Completed one-use ledger envelope is detached from its record.");
  }
}

function assertOneUseLedgerState(
  value: unknown,
): asserts value is OneUseLedgerState {
  if (!isPlainRecord(value)) fail("One-use ledger state is not an object.");
  assertExactKeys(value, LEDGER_STATE_KEYS, "One-use ledger state");
  if (
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !isPlainRecord(value.records) ||
    !Array.isArray(value.usedDispositionAttestations) ||
    !Array.isArray(value.usedRecoveryAuthorizations)
  ) {
    fail("One-use ledger state is malformed.");
  }
  const claimTokens = new Set<string>();
  const boundAttestations = new Set<string>();
  const boundRecoveryAuthorizations = new Set<string>();
  for (const [requestId, record] of Object.entries(value.records)) {
    assertLedgerRecord(requestId, record);
    if (claimTokens.has(record.claimToken)) {
      fail("One-use ledger claim tokens are not unique.");
    }
    claimTokens.add(record.claimToken);
    if (record.dispositionAttestationHash !== null) {
      if (boundAttestations.has(record.dispositionAttestationHash)) {
        fail("One-use disposition attestation was bound more than once.");
      }
      boundAttestations.add(record.dispositionAttestationHash);
    }
    if (record.recoveryAuthorizationHash !== null) {
      if (
        boundRecoveryAuthorizations.has(
          record.recoveryAuthorizationHash,
        )
      ) {
        fail(
          "One-use claim recovery authorization was bound more than once.",
        );
      }
      boundRecoveryAuthorizations.add(
        record.recoveryAuthorizationHash,
      );
    }
  }
  const usedAttestations = value.usedDispositionAttestations;
  if (
    usedAttestations.some(
      (hash) => typeof hash !== "string" || !SHA256.test(hash),
    ) ||
    new Set(usedAttestations).size !== usedAttestations.length ||
    usedAttestations.length !== boundAttestations.size ||
    usedAttestations.some(
      (hash) => !boundAttestations.has(hash as string),
    )
  ) {
    fail("One-use disposition attestation index is inconsistent.");
  }
  const usedRecoveryAuthorizations =
    value.usedRecoveryAuthorizations;
  if (
    usedRecoveryAuthorizations.some(
      (hash) => typeof hash !== "string" || !SHA256.test(hash),
    ) ||
    new Set(usedRecoveryAuthorizations).size !==
      usedRecoveryAuthorizations.length ||
    [...boundRecoveryAuthorizations].some(
      (hash) => !usedRecoveryAuthorizations.includes(hash),
    )
  ) {
    fail(
      "One-use claim recovery authorization index is inconsistent.",
    );
  }
}

function assertProbabilityRecord(
  value: unknown,
  label: string,
): void {
  if (!isPlainRecord(value)) fail(`${label} is not an object.`);
  assertExactKeys(value, ESTIMATE_KEYS, label);
  if (
    ESTIMATE_KEYS.some((key) => {
      const number = value[key];
      return (
        typeof number !== "number" ||
        !Number.isFinite(number) ||
        number < 0 ||
        number > 1
      );
    })
  ) {
    fail(`${label} contains an invalid normalized estimate.`);
  }
}

function assertStoredTask(
  value: unknown,
  expectedTaskId: string,
  expectedDatasetPinHash: string,
): asserts value is TrustedStoredHiddenTask {
  if (!isPlainRecord(value)) fail("Trusted hidden task is not an object.");
  assertExactKeys(value, STORED_TASK_KEYS, "Trusted hidden task");
  if (
    value.sensitivity !== "trusted-hidden-task-record" ||
    value.datasetPinHash !== expectedDatasetPinHash ||
    value.registryRevision !== 6 ||
    value.taskId !== expectedTaskId ||
    typeof value.packageTaskName !== "string" ||
    !SAFE_PACKAGE_TASK_NAME.test(value.packageTaskName) ||
    typeof value.taskRevisionDigest !== "string" ||
    !SHA256.test(value.taskRevisionDigest) ||
    typeof value.capabilityStratum !== "string" ||
    !SAFE_ID.test(value.capabilityStratum) ||
    typeof value.difficultyStratum !== "string" ||
    !SAFE_ID.test(value.difficultyStratum) ||
    !Array.isArray(value.buckets) ||
    value.buckets.length === 0 ||
    value.buckets.some(
      (bucket) =>
        typeof bucket !== "string" || !SELECTION_BUCKETS.has(bucket),
    ) ||
    new Set(value.buckets).size !== value.buckets.length ||
    typeof value.shadowReserved !== "boolean" ||
    typeof value.regressionCanary !== "boolean" ||
    typeof value.infrastructureValid !== "boolean" ||
    typeof value.discriminating !== "boolean"
  ) {
    fail("Trusted hidden task immutable shape is malformed.");
  }
  assertProbabilityRecord(value.estimates, "Trusted hidden task estimates");
  assertProbabilityRecord(
    value.seedEstimates,
    "Trusted hidden task seed estimates",
  );
  if (!isPlainRecord(value.exposure)) {
    fail("Trusted hidden task exposure is not an object.");
  }
  assertExactKeys(
    value.exposure,
    EXPOSURE_KEYS,
    "Trusted hidden task exposure",
  );
  if (
    !Number.isSafeInteger(value.exposure.total) ||
    (value.exposure.total as number) < 0 ||
    !Number.isSafeInteger(value.exposure.consecutiveExperiments) ||
    (value.exposure.consecutiveExperiments as number) < 0 ||
    (value.exposure.lastExperiment !== null &&
      (!Number.isSafeInteger(value.exposure.lastExperiment) ||
        (value.exposure.lastExperiment as number) < 0)) ||
    typeof value.exposure.feedbackReleased !== "boolean" ||
    typeof value.exposure.positiveValidationConsumed !== "boolean" ||
    (value.exposure.repairCooldownThroughExperiment !== null &&
      (!Number.isSafeInteger(
        value.exposure.repairCooldownThroughExperiment,
      ) ||
        (value.exposure.repairCooldownThroughExperiment as number) < 0)) ||
    !Array.isArray(value.exposure.informedHypothesisDigests) ||
    value.exposure.informedHypothesisDigests.some(
      (hash) => typeof hash !== "string" || !SHA256.test(hash),
    ) ||
    new Set(value.exposure.informedHypothesisDigests).size !==
      value.exposure.informedHypothesisDigests.length
  ) {
    fail("Trusted hidden task exposure is malformed.");
  }
  if (!isPlainRecord(value.outcomeStats)) {
    fail("Trusted hidden task outcome stats are not an object.");
  }
  assertExactKeys(
    value.outcomeStats,
    OUTCOME_STATS_KEYS,
    "Trusted hidden task outcome stats",
  );
  const stats =
    value.outcomeStats as unknown as TrustedHiddenTaskOutcomeStats;
  const integerCounts = [
    stats.candidateObservationCount,
    stats.candidateFailureCount,
    stats.championObservationCount,
    stats.championFailureCount,
    stats.matchedObservationCount,
    stats.costObservationCount,
  ];
  const sums = [
    stats.candidateRewardSum,
    stats.championRewardSum,
    stats.discriminationSignalSum,
    stats.normalizedCostSignalSum,
  ];
  if (
    integerCounts.some(
      (count) =>
        !Number.isSafeInteger(count) || (count as number) < 0,
    ) ||
    sums.some(
      (sum) =>
        typeof sum !== "number" || !Number.isFinite(sum) || sum < 0,
    ) ||
    stats.candidateFailureCount > stats.candidateObservationCount ||
    stats.championFailureCount > stats.championObservationCount ||
    stats.matchedObservationCount > stats.candidateObservationCount ||
    stats.matchedObservationCount > stats.championObservationCount ||
    stats.costObservationCount !==
      stats.candidateObservationCount +
        stats.championObservationCount ||
    (stats.lastObservedAt !== null &&
      !Number.isFinite(Date.parse(stats.lastObservedAt)))
  ) {
    fail("Trusted hidden task outcome stats are malformed.");
  }
}

function hiddenCatalogExperimentOrdinal(
  experimentId: string,
): number {
  const prefix = experimentId.split("-", 1)[0] ?? "";
  const ordinal = Number.parseInt(prefix, 10);
  if (
    !/^\d+$/u.test(prefix) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0
  ) {
    fail("Trusted hidden catalog experiment identity is malformed.");
  }
  return ordinal;
}

function assertTrustedHiddenCatalogStorageState(
  value: unknown,
): asserts value is TrustedHiddenCatalogState {
  if (!isPlainRecord(value)) fail("Trusted hidden catalog is not an object.");
  assertExactKeys(value, CATALOG_STATE_KEYS, "Trusted hidden catalog");
  if (
    value.schemaVersion !== 1 ||
    value.sensitivity !== "trusted-hidden-task-catalog" ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) <= 0 ||
    typeof value.datasetPinHash !== "string" ||
    !SHA256.test(value.datasetPinHash) ||
    value.registryRevision !== 6 ||
    typeof value.seedSetCommitment !== "string" ||
    !SHA256.test(value.seedSetCommitment) ||
    typeof value.taskIdKeyId !== "string" ||
    !SAFE_ID.test(value.taskIdKeyId) ||
    typeof value.dispositionKeyId !== "string" ||
    !SAFE_ID.test(value.dispositionKeyId) ||
    typeof value.weightingPolicyHash !== "string" ||
    !SHA256.test(value.weightingPolicyHash) ||
    typeof value.stateCommitment !== "string" ||
    !SHA256.test(value.stateCommitment) ||
    !Number.isSafeInteger(value.repairEpoch) ||
    (value.repairEpoch as number) < 0 ||
    !Array.isArray(value.taskOrder) ||
    value.taskOrder.length !== 89 ||
    value.taskOrder.some(
      (taskId) => typeof taskId !== "string" || !SHA256.test(taskId),
    ) ||
    new Set(value.taskOrder).size !== 89 ||
    !isPlainRecord(value.tasks) ||
    Object.keys(value.tasks).length !== 89 ||
    !isPlainRecord(value.validationCarry) ||
    !Array.isArray(value.shadowSlices) ||
    value.shadowSlices.length !== 2 ||
    !isPlainRecord(value.allocations) ||
    !isPlainRecord(value.outcomeUpdates)
  ) {
    fail("Trusted hidden catalog metadata is malformed.");
  }
  const catalog = value as unknown as TrustedHiddenCatalogState;
  for (const taskId of catalog.taskOrder) {
    assertStoredTask(
      catalog.tasks[taskId],
      taskId,
      catalog.datasetPinHash,
    );
  }
  if (
    Object.keys(catalog.tasks).some(
      (taskId) =>
        !catalog.taskOrder.includes(
          taskId as (typeof catalog.taskOrder)[number],
        ),
    )
  ) {
    fail("Trusted hidden catalog task index is inconsistent.");
  }
  assertExactKeys(
    catalog.validationCarry,
    ["hard", "uncertain", "easy", "coverage"],
    "Trusted validation carry",
  );
  const carryValues = [
    catalog.validationCarry.hard,
    catalog.validationCarry.uncertain,
    catalog.validationCarry.easy,
    catalog.validationCarry.coverage,
  ];
  if (
    carryValues.some(
      (carry) =>
        !Number.isSafeInteger(carry) ||
        (carry as number) < -9 ||
        (carry as number) > 9,
    ) ||
    carryValues.reduce((sum, carry) => sum + (carry as number), 0) !== 0
  ) {
    fail("Trusted validation carry is malformed.");
  }
  for (const [index, slice] of catalog.shadowSlices.entries()) {
    if (!isPlainRecord(slice)) {
      fail("Trusted shadow slice is not an object.");
    }
    assertExactKeys(
      slice,
      [
        "slice",
        "taskIds",
        "selectedBuckets",
        "consumed",
        "consumedByRequestHash",
      ],
      "Trusted shadow slice",
    );
    if (
      slice.slice !== index + 1 ||
      !Array.isArray(slice.taskIds) ||
      slice.taskIds.length !== 12 ||
      slice.taskIds.some(
        (taskId) =>
          typeof taskId !== "string" ||
          !SHA256.test(taskId) ||
          !Object.hasOwn(catalog.tasks, taskId),
      ) ||
      new Set(slice.taskIds).size !== 12 ||
      !Array.isArray(slice.selectedBuckets) ||
      slice.selectedBuckets.length !== 12 ||
      slice.selectedBuckets.some(
        (bucket) =>
          typeof bucket !== "string" ||
          !SELECTION_BUCKETS.has(bucket),
      ) ||
      typeof slice.consumed !== "boolean" ||
      (slice.consumedByRequestHash !== null &&
        (typeof slice.consumedByRequestHash !== "string" ||
          !SHA256.test(slice.consumedByRequestHash))) ||
      slice.consumed !== (slice.consumedByRequestHash !== null)
    ) {
      fail("Trusted shadow slice is malformed.");
    }
  }
  const allocationRecords = Object.values(catalog.allocations);
  const allocationRequestIds = new Set<string>();
  const allocationClaimCommitments = new Set<string>();
  const allocationLeaseIds = new Set<string>();
  let repairAllocationCount = 0;
  for (const [requestHash, allocation] of Object.entries(
    catalog.allocations,
  )) {
    if (!isPlainRecord(allocation)) {
      fail("Trusted panel allocation is not an object.");
    }
    assertExactKeys(
      allocation,
      [
        "sensitivity",
        "requestId",
        "experimentId",
        "requestHash",
        "datasetPinHash",
        "registryRevision",
        "protocolHash",
        "claimTokenCommitment",
        "dispositionNonce",
        "frozenHypothesisDigest",
        "candidateArchiveSha256",
        "championArchiveSha256",
        "repairSourceExperimentId",
        "repairSourceRequestHash",
        "repairAttemptOrdinal",
        "selectedBuckets",
        "panel",
      ],
      "Trusted panel allocation",
    );
    if (
      allocation.sensitivity !== "trusted-hidden-panel-allocation" ||
      typeof allocation.requestId !== "string" ||
      !SAFE_ID.test(allocation.requestId) ||
      typeof allocation.experimentId !== "string" ||
      !SAFE_ID.test(allocation.experimentId) ||
      typeof allocation.requestHash !== "string" ||
      !SHA256.test(allocation.requestHash) ||
      allocation.requestHash !== requestHash ||
      allocation.datasetPinHash !== catalog.datasetPinHash ||
      allocation.registryRevision !== 6 ||
      typeof allocation.protocolHash !== "string" ||
      !SHA256.test(allocation.protocolHash) ||
      typeof allocation.claimTokenCommitment !== "string" ||
      !SHA256.test(allocation.claimTokenCommitment) ||
      typeof allocation.dispositionNonce !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/u.test(
        allocation.dispositionNonce,
      ) ||
      typeof allocation.frozenHypothesisDigest !== "string" ||
      !SHA256.test(allocation.frozenHypothesisDigest) ||
      typeof allocation.candidateArchiveSha256 !== "string" ||
      !SHA256.test(allocation.candidateArchiveSha256) ||
      typeof allocation.championArchiveSha256 !== "string" ||
      !SHA256.test(allocation.championArchiveSha256) ||
      (allocation.repairSourceExperimentId !== null &&
        (typeof allocation.repairSourceExperimentId !== "string" ||
          !SAFE_ID.test(allocation.repairSourceExperimentId))) ||
      (allocation.repairSourceRequestHash !== null &&
        (typeof allocation.repairSourceRequestHash !== "string" ||
          !SHA256.test(allocation.repairSourceRequestHash))) ||
      (allocation.repairAttemptOrdinal !== null &&
        allocation.repairAttemptOrdinal !== 1 &&
        allocation.repairAttemptOrdinal !== 2) ||
      !Array.isArray(allocation.selectedBuckets) ||
      allocation.selectedBuckets.some(
        (bucket) =>
          typeof bucket !== "string" ||
          !SELECTION_BUCKETS.has(bucket),
      ) ||
      !isPlainRecord(allocation.panel)
    ) {
      fail("Trusted panel allocation is malformed.");
    }
    assertTrustedMatchedPanel(allocation.panel);
    const repair = allocation.panel.stage === "repair";
    const repairBucketCounts = Object.fromEntries(
      [...SELECTION_BUCKETS].map((bucket) => [
        bucket,
        allocation.selectedBuckets.filter(
          (selected) => selected === bucket,
        ).length,
      ]),
    ) as unknown as Readonly<
      Record<"hard" | "uncertain" | "easy" | "coverage", number>
    >;
    if (
      allocation.panel.requestId !== allocation.requestId ||
      (allocation.panel.stage !== "repair" &&
        allocation.panel.stage !== "validation" &&
        allocation.panel.stage !== "shadow") ||
      allocation.selectedBuckets.length !==
        (repair ? 5 : 12) ||
      (repair &&
        (repairBucketCounts.hard !== 3 ||
          repairBucketCounts.uncertain !== 1 ||
          repairBucketCounts.easy +
            repairBucketCounts.coverage !==
            1)) ||
      repair !==
        (allocation.repairSourceExperimentId !== null &&
          allocation.repairSourceRequestHash !== null &&
          allocation.repairAttemptOrdinal !== null) ||
      allocationRequestIds.has(allocation.requestId) ||
      allocationClaimCommitments.has(
        allocation.claimTokenCommitment,
      ) ||
      allocationLeaseIds.has(allocation.panel.leaseId) ||
      allocation.panel.cells.some((cell, index) => {
        const task = catalog.tasks[cell.taskId];
        const selectedBucket = allocation.selectedBuckets[index];
        return (
          task === undefined ||
          task.taskRevisionDigest !== cell.taskRevisionDigest ||
          task.capabilityStratum !== cell.capabilityStratum ||
          selectedBucket === undefined ||
          (allocation.panel.stage !== "shadow" &&
            !task.buckets.includes(selectedBucket))
        );
      })
    ) {
      fail("Trusted panel allocation source lineage is malformed.");
    }
    allocationRequestIds.add(allocation.requestId);
    allocationClaimCommitments.add(
      allocation.claimTokenCommitment,
    );
    allocationLeaseIds.add(allocation.panel.leaseId);
    if (repair) repairAllocationCount += 1;
  }
  if (repairAllocationCount !== catalog.repairEpoch) {
    fail("Trusted repair epoch is inconsistent.");
  }
  const committedRequestHashes = new Set<string>();
  for (const [updateId, commitment] of Object.entries(
    catalog.outcomeUpdates,
  )) {
    if (!isPlainRecord(commitment)) {
      fail("Trusted outcome commitment is not an object.");
    }
    assertExactKeys(
      commitment,
      [
        "sensitivity",
        "updateId",
        "requestHash",
        "sourceBindingHash",
        "updateSetHash",
        "signatureHash",
        "observedAt",
        "taskCount",
      ],
      "Trusted outcome commitment",
    );
    if (
      commitment.sensitivity !==
        "trusted-hidden-catalog-outcome-commitment" ||
      commitment.updateId !== updateId ||
      !/^catalog-[a-f0-9]{48}$/u.test(updateId) ||
      typeof commitment.requestHash !== "string" ||
      !SHA256.test(commitment.requestHash) ||
      typeof commitment.sourceBindingHash !== "string" ||
      !SHA256.test(commitment.sourceBindingHash) ||
      typeof commitment.updateSetHash !== "string" ||
      !SHA256.test(commitment.updateSetHash) ||
      typeof commitment.signatureHash !== "string" ||
      !SHA256.test(commitment.signatureHash) ||
      typeof commitment.observedAt !== "string" ||
      !Number.isFinite(Date.parse(commitment.observedAt)) ||
      (commitment.taskCount !== 5 && commitment.taskCount !== 12) ||
      catalog.allocations[commitment.requestHash] === undefined ||
      catalog.allocations[commitment.requestHash]?.panel.cells
        .length !== commitment.taskCount ||
      committedRequestHashes.has(commitment.requestHash)
    ) {
      fail("Trusted outcome commitment is malformed.");
    }
    committedRequestHashes.add(commitment.requestHash);
  }
  const repairsBySource = new Map<
    string,
    typeof allocationRecords
  >();
  for (const allocation of allocationRecords) {
    if (allocation.panel.stage !== "repair") continue;
    const sourceHash = allocation.repairSourceRequestHash;
    const sourceExperimentId =
      allocation.repairSourceExperimentId;
    if (sourceHash === null || sourceExperimentId === null) {
      fail("Trusted repair source is absent.");
    }
    const source = catalog.allocations[sourceHash];
    const namedSources = allocationRecords.filter(
      (candidate) =>
        candidate.experimentId === sourceExperimentId &&
        candidate.panel.stage === "validation",
    );
    const sourceTaskIds = new Set(
      source?.panel.cells.map((cell) => cell.taskId) ?? [],
    );
    if (
      source === undefined ||
      namedSources.length !== 1 ||
      namedSources[0] !== source ||
      source.panel.stage !== "validation" ||
      source.experimentId !== sourceExperimentId ||
      source.protocolHash !== allocation.protocolHash ||
      source.datasetPinHash !== allocation.datasetPinHash ||
      hiddenCatalogExperimentOrdinal(source.experimentId) >=
        hiddenCatalogExperimentOrdinal(allocation.experimentId) ||
      !committedRequestHashes.has(source.requestHash) ||
      source.championArchiveSha256 !==
        allocation.championArchiveSha256 ||
      allocation.panel.cells.some(
        (cell) => !sourceTaskIds.has(cell.taskId),
      )
    ) {
      fail("Trusted repair source lineage is inconsistent.");
    }
    repairsBySource.set(sourceHash, [
      ...(repairsBySource.get(sourceHash) ?? []),
      allocation,
    ]);
  }
  for (const attempts of repairsBySource.values()) {
    attempts.sort(
      (left, right) =>
        (left.repairAttemptOrdinal ?? 0) -
        (right.repairAttemptOrdinal ?? 0),
    );
    const first = attempts[0];
    const second = attempts[1];
    if (
      attempts.length > 2 ||
      first?.repairAttemptOrdinal !== 1 ||
      (second !== undefined &&
        (second.repairAttemptOrdinal !== 2 ||
          !committedRequestHashes.has(first.requestHash) ||
          second.candidateArchiveSha256 ===
            first.candidateArchiveSha256 ||
          canonicalJson(second.selectedBuckets) !==
            canonicalJson(first.selectedBuckets) ||
          second.panel.cells.some(
            (cell, index) =>
              cell.taskId !== first.panel.cells[index]?.taskId ||
              cell.taskRevisionDigest !==
                first.panel.cells[index]?.taskRevisionDigest ||
              cell.capabilityStratum !==
                first.panel.cells[index]?.capabilityStratum ||
              cell.order !== first.panel.cells[index]?.order,
          )))
    ) {
      fail("Trusted repair attempts are not bounded panel reuse.");
    }
  }
  if (
    catalog.revision !==
    Object.keys(catalog.allocations).length +
      Object.keys(catalog.outcomeUpdates).length +
      1
  ) {
    fail("Trusted hidden catalog revision is inconsistent.");
  }
}

function assertNullableTrustedHiddenCatalogStorageState(
  value: unknown,
): asserts value is TrustedHiddenCatalogState | null {
  if (value !== null) {
    assertTrustedHiddenCatalogStorageState(value);
  }
}

function assertExperimentIdentity(
  value: unknown,
): asserts value is ExperimentIdentity {
  if (!isPlainRecord(value)) fail("Optimizer experiment is not an object.");
  assertExactKeys(value, EXPERIMENT_KEYS, "Optimizer experiment");
  if (
    !Number.isSafeInteger(value.number) ||
    (value.number as number) <= 0 ||
    typeof value.slug !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.slug) ||
    (value.kind !== "baseline" &&
      value.kind !== "optimization" &&
      value.kind !== "shadow") ||
    (value.parentExperiment !== null &&
      (!Number.isSafeInteger(value.parentExperiment) ||
        (value.parentExperiment as number) < 0 ||
        (value.parentExperiment as number) >= (value.number as number))) ||
    typeof value.lineageId !== "string" ||
    !SAFE_ID.test(value.lineageId) ||
    typeof value.protocolHash !== "string" ||
    !SHA256.test(value.protocolHash)
  ) {
    fail("Optimizer experiment identity is malformed.");
  }
}

function optimizerExperimentId(experiment: ExperimentIdentity): string {
  return `${experiment.number.toString().padStart(3, "0")}-${experiment.slug}`;
}

function optimizerRecordKey(experiment: ExperimentIdentity): string {
  return canonicalHash(experiment);
}

function assertArtifactReference(
  value: unknown,
  label: string,
): asserts value is TrustedCloudArtifactRef {
  if (!isPlainRecord(value)) fail(`${label} is not an object.`);
  assertExactKeys(
    value,
    ["uri", "sha256", "mediaType", "byteLength"],
    label,
  );
  if (
    typeof value.uri !== "string" ||
    !SAFE_URI.test(value.uri) ||
    value.uri.includes("..") ||
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256) ||
    typeof value.mediaType !== "string" ||
    !SAFE_MEDIA_TYPE.test(value.mediaType) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 0
  ) {
    fail(`${label} is malformed.`);
  }
}

function assertExecutionReceipt(
  value: unknown,
  label: string,
): asserts value is RemoteExecutionReceipt {
  if (!isPlainRecord(value)) fail(`${label} is not an object.`);
  const required = [
    "provider",
    "sandboxId",
    "executionId",
    "startedAt",
    "finishedAt",
    "exitCode",
    "timedOut",
    "cancelled",
    "resourceReport",
  ];
  const allowed = new Set([...required, "stdout", "stderr"]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    typeof value.provider !== "string" ||
    !CLOUD_PROVIDERS.has(value.provider) ||
    typeof value.sandboxId !== "string" ||
    !SAFE_PROVIDER_ID.test(value.sandboxId) ||
    typeof value.executionId !== "string" ||
    !SAFE_PROVIDER_ID.test(value.executionId) ||
    (value.exitCode !== null &&
      (!Number.isSafeInteger(value.exitCode) ||
        (value.exitCode as number) < 0 ||
        (value.exitCode as number) > 255)) ||
    typeof value.timedOut !== "boolean" ||
    typeof value.cancelled !== "boolean" ||
    !isPlainRecord(value.resourceReport)
  ) {
    fail(`${label} is malformed.`);
  }
  assertTimestamp(value.startedAt, `${label} start`);
  assertTimestamp(value.finishedAt, `${label} finish`);
  if (
    Date.parse(value.finishedAt) < Date.parse(value.startedAt) ||
    value.exitCode !== 0 ||
    value.timedOut ||
    value.cancelled
  ) {
    fail(`${label} does not describe a successful bounded execution.`);
  }
  assertExactKeys(
    value.resourceReport,
    ["peakMemoryMiB", "cpuTimeMs"],
    `${label} resource report`,
  );
  if (
    typeof value.resourceReport.peakMemoryMiB !== "number" ||
    !Number.isFinite(value.resourceReport.peakMemoryMiB) ||
    value.resourceReport.peakMemoryMiB < 0 ||
    typeof value.resourceReport.cpuTimeMs !== "number" ||
    !Number.isFinite(value.resourceReport.cpuTimeMs) ||
    value.resourceReport.cpuTimeMs < 0
  ) {
    fail(`${label} resource report is malformed.`);
  }
  if (value.stdout !== undefined) {
    assertArtifactReference(value.stdout, `${label} stdout`);
  }
  if (value.stderr !== undefined) {
    assertArtifactReference(value.stderr, `${label} stderr`);
  }
}

function assertExecutionReceipts(
  value: unknown,
): void {
  if (!isPlainRecord(value)) {
    fail("Optimizer execution receipts are not an object.");
  }
  assertExactKeys(
    value,
    ["setup", "claude", "seal"],
    "Optimizer execution receipts",
  );
  assertExecutionReceipt(value.setup, "Optimizer setup receipt");
  assertExecutionReceipt(value.claude, "Optimizer Claude receipt");
  assertExecutionReceipt(value.seal, "Optimizer seal receipt");
  const receipts =
    value as unknown as CloudOptimizerExecutionReceipts;
  if (
    receipts.setup.provider !== receipts.claude.provider ||
    receipts.setup.provider !== receipts.seal.provider ||
    receipts.setup.sandboxId !== receipts.claude.sandboxId ||
    receipts.setup.sandboxId !== receipts.seal.sandboxId ||
    new Set([
      receipts.setup.executionId,
      receipts.claude.executionId,
      receipts.seal.executionId,
    ]).size !== 3
  ) {
    fail("Optimizer execution receipts do not share one unique sandbox lineage.");
  }
}

function assertManifest(
  value: unknown,
  input: {
    readonly domain: string;
    readonly campaignId: string;
    readonly experimentId: string;
    readonly phase?: "proposal" | "analysis";
  },
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail(`${label} is not an object.`);
  const keys =
    input.domain === "dark-factory.optimizer-setup.v1"
      ? [
          "schemaVersion",
          "domain",
          "phase",
          "campaignId",
          "experimentId",
          "sourceMode",
          "registrationId",
          "originRepositoryHash",
          "sourceCommit",
          "sourceTree",
          "lockSha256",
          "pluginArchiveSha256",
          "evidenceArchiveSha256",
          "inputStateSha256",
          "contentHash",
        ]
      : input.domain === "dark-factory.optimizer-claude.v1"
        ? [
            "schemaVersion",
            "domain",
            "phase",
            "campaignId",
            "experimentId",
            "summary",
            "exitCode",
            "stderrSha256",
            "contentHash",
          ]
        : input.domain === "dark-factory.optimizer-proposal.v1"
          ? [
              "schemaVersion",
              "domain",
              "campaignId",
              "experimentId",
              "sourceCommit",
              "candidateCommit",
              "candidateTree",
              "lockSha256",
              "bundleRef",
              "hypothesis",
              "candidate",
              "hypothesisReceiptId",
              "candidateReceiptId",
              "integrityPolicyHash",
              "bundle",
              "diff",
              "state",
              "contentHash",
            ]
          : input.domain === "dark-factory.optimizer-analysis.v1"
            ? [
                "schemaVersion",
                "domain",
                "campaignId",
                "experimentId",
                "candidateCommit",
                "analysisHash",
                "rollbackRequired",
                "analysisReceiptId",
                "state",
                "contentHash",
              ]
            : fail(`${label} has an unsupported domain.`);
  assertExactKeys(value, keys, label);
  if (
    value.schemaVersion !== 1 ||
    value.domain !== input.domain ||
    value.campaignId !== input.campaignId ||
    value.experimentId !== input.experimentId ||
    (input.phase !== undefined && value.phase !== input.phase)
  ) {
    fail(`${label} identity is malformed.`);
  }
  if (input.domain === "dark-factory.optimizer-setup.v1") {
    if (
      (value.sourceMode !== "private-github" &&
        value.sourceMode !== "trusted-bundle") ||
      typeof value.registrationId !== "string" ||
      !SHA256.test(value.registrationId) ||
      typeof value.originRepositoryHash !== "string" ||
      !SHA256.test(value.originRepositoryHash) ||
      typeof value.sourceCommit !== "string" ||
      !GIT_OBJECT_ID.test(value.sourceCommit) ||
      typeof value.sourceTree !== "string" ||
      !GIT_OBJECT_ID.test(value.sourceTree) ||
      typeof value.lockSha256 !== "string" ||
      !SHA256.test(value.lockSha256) ||
      typeof value.pluginArchiveSha256 !== "string" ||
      !SHA256.test(value.pluginArchiveSha256) ||
      typeof value.evidenceArchiveSha256 !== "string" ||
      !SHA256.test(value.evidenceArchiveSha256) ||
      (value.inputStateSha256 !== null &&
        (typeof value.inputStateSha256 !== "string" ||
          !SHA256.test(value.inputStateSha256)))
    ) {
      fail(`${label} source binding is malformed.`);
    }
  } else if (input.domain === "dark-factory.optimizer-claude.v1") {
    if (
      value.exitCode !== 0 ||
      typeof value.stderrSha256 !== "string" ||
      !SHA256.test(value.stderrSha256) ||
      !isPlainRecord(value.summary)
    ) {
      fail(`${label} execution fields are malformed.`);
    }
    assertExactKeys(
      value.summary,
      [
        "initialized",
        "pluginLoaded",
        "pluginErrors",
        "sessionId",
        "model",
        "result",
        "totalCostUsd",
        "turns",
      ],
      `${label} summary`,
    );
    if (
      value.summary.initialized !== true ||
      value.summary.pluginLoaded !== true ||
      !Array.isArray(value.summary.pluginErrors) ||
      value.summary.pluginErrors.length !== 0 ||
      (value.summary.sessionId !== null &&
        (typeof value.summary.sessionId !== "string" ||
          value.summary.sessionId.length === 0)) ||
      typeof value.summary.model !== "string" ||
      value.summary.model.length === 0 ||
      value.summary.result !== "completed" ||
      typeof value.summary.totalCostUsd !== "number" ||
      !Number.isFinite(value.summary.totalCostUsd) ||
      value.summary.totalCostUsd < 0 ||
      !Number.isSafeInteger(value.summary.turns) ||
      (value.summary.turns as number) < 1
    ) {
      fail(`${label} summary is malformed.`);
    }
  } else if (
    input.domain === "dark-factory.optimizer-proposal.v1"
  ) {
    if (
      typeof value.sourceCommit !== "string" ||
      !GIT_OBJECT_ID.test(value.sourceCommit) ||
      typeof value.candidateCommit !== "string" ||
      !GIT_OBJECT_ID.test(value.candidateCommit) ||
      typeof value.candidateTree !== "string" ||
      !GIT_OBJECT_ID.test(value.candidateTree) ||
      typeof value.lockSha256 !== "string" ||
      !SHA256.test(value.lockSha256) ||
      typeof value.bundleRef !== "string" ||
      !/^refs\/heads\/df\/bundle\/[0-9]{3,8}-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(
        value.bundleRef,
      ) ||
      typeof value.hypothesisReceiptId !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/u.test(value.hypothesisReceiptId) ||
      typeof value.candidateReceiptId !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/u.test(value.candidateReceiptId) ||
      typeof value.integrityPolicyHash !== "string" ||
      !SHA256.test(value.integrityPolicyHash)
    ) {
      fail(`${label} sealed identities are malformed.`);
    }
    assertSealedArtifactMetadata(value.bundle, `${label} bundle`);
    assertSealedArtifactMetadata(value.diff, `${label} diff`);
    assertSealedArtifactMetadata(value.state, `${label} state`);
  } else {
    if (
      typeof value.candidateCommit !== "string" ||
      !GIT_OBJECT_ID.test(value.candidateCommit) ||
      typeof value.analysisHash !== "string" ||
      !SHA256.test(value.analysisHash) ||
      typeof value.rollbackRequired !== "boolean" ||
      typeof value.analysisReceiptId !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/u.test(value.analysisReceiptId)
    ) {
      fail(`${label} sealed analysis fields are malformed.`);
    }
    assertSealedArtifactMetadata(value.state, `${label} state`);
  }
  assertContentHash(value, label);
}

function assertSealedArtifactMetadata(
  value: unknown,
  label: string,
): asserts value is Readonly<{
  readonly sha256: string;
  readonly byteLength: number;
}> {
  if (!isPlainRecord(value)) fail(`${label} is not an object.`);
  assertExactKeys(value, ["sha256", "byteLength"], label);
  if (
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) <= 0
  ) {
    fail(`${label} is malformed.`);
  }
}

function assertFrozenHypothesis(value: unknown): void {
  if (!isPlainRecord(value)) fail("Frozen hypothesis is not an object.");
  assertExactKeys(
    value,
    [
      "hash",
      "sourceBriefHash",
      "causalClaim",
      "intervention",
      "predictedRepairBehavior",
      "predictedFreshEffect",
      "falsificationCriteria",
      "rollbackCondition",
    ],
    "Frozen hypothesis",
  );
  if (
    typeof value.hash !== "string" ||
    !SHA256.test(value.hash) ||
    (value.sourceBriefHash !== null &&
      (typeof value.sourceBriefHash !== "string" ||
        !SHA256.test(value.sourceBriefHash))) ||
    typeof value.causalClaim !== "string" ||
    value.causalClaim.length === 0 ||
    typeof value.intervention !== "string" ||
    value.intervention.length === 0 ||
    typeof value.predictedRepairBehavior !== "string" ||
    value.predictedRepairBehavior.length === 0 ||
    typeof value.predictedFreshEffect !== "string" ||
    value.predictedFreshEffect.length === 0 ||
    !Array.isArray(value.falsificationCriteria) ||
    value.falsificationCriteria.length === 0 ||
    value.falsificationCriteria.some(
      (criterion) =>
        typeof criterion !== "string" || criterion.length === 0,
    ) ||
    typeof value.rollbackCondition !== "string" ||
    value.rollbackCondition.length === 0
  ) {
    fail("Frozen hypothesis is malformed.");
  }
}

function assertFrozenCandidate(value: unknown): void {
  if (!isPlainRecord(value)) fail("Frozen candidate is not an object.");
  assertExactKeys(
    value,
    [
      "commit",
      "patchHash",
      "changedFiles",
      "mutationCategory",
    ],
    "Frozen candidate",
  );
  if (
    typeof value.commit !== "string" ||
    !GIT_OBJECT_ID.test(value.commit) ||
    typeof value.patchHash !== "string" ||
    !SHA256.test(value.patchHash) ||
    !Array.isArray(value.changedFiles) ||
    value.changedFiles.length === 0 ||
    value.changedFiles.some(
      (path) =>
        typeof path !== "string" ||
        !SAFE_CHANGED_FILE.test(path) ||
        path.includes("..") ||
        path.includes("//"),
    ) ||
    new Set(value.changedFiles).size !== value.changedFiles.length ||
    typeof value.mutationCategory !== "string" ||
    !SAFE_ID.test(value.mutationCategory)
  ) {
    fail("Frozen candidate is malformed.");
  }
}

function assertProposalResult(
  value: unknown,
  experiment: ExperimentIdentity,
): asserts value is CloudOptimizerProposalResult {
  if (!isPlainRecord(value)) fail("Optimizer proposal result is not an object.");
  assertExactKeys(
    value,
    [
      "proposal",
      "setup",
      "claude",
      "seal",
      "candidateBundle",
      "candidateDiff",
      "sessionState",
      "setupManifestArtifact",
      "claudeManifestArtifact",
      "sealManifestArtifact",
      "executionReceipts",
    ],
    "Optimizer proposal result",
  );
  if (!isPlainRecord(value.proposal)) {
    fail("Optimizer proposal is not an object.");
  }
  assertExactKeys(
    value.proposal,
    ["hypothesis", "candidate"],
    "Optimizer proposal",
  );
  assertFrozenHypothesis(value.proposal.hypothesis);
  assertFrozenCandidate(value.proposal.candidate);
  const experimentId = optimizerExperimentId(experiment);
  assertManifest(
    value.setup,
    {
      domain: "dark-factory.optimizer-setup.v1",
      campaignId: experiment.lineageId,
      experimentId,
      phase: "proposal",
    },
    "Optimizer setup manifest",
  );
  assertManifest(
    value.claude,
    {
      domain: "dark-factory.optimizer-claude.v1",
      campaignId: experiment.lineageId,
      experimentId,
      phase: "proposal",
    },
    "Optimizer Claude manifest",
  );
  assertManifest(
    value.seal,
    {
      domain: "dark-factory.optimizer-proposal.v1",
      campaignId: experiment.lineageId,
      experimentId,
    },
    "Optimizer proposal seal",
  );
  if (
    !isPlainRecord(value.seal.bundle) ||
    !isPlainRecord(value.seal.diff) ||
    !isPlainRecord(value.seal.state) ||
    value.seal.candidateCommit !==
      (value.proposal.candidate as Readonly<Record<string, unknown>>).commit ||
    canonicalJson(value.seal.hypothesis) !==
      canonicalJson(value.proposal.hypothesis) ||
    canonicalJson(value.seal.candidate) !==
      canonicalJson(value.proposal.candidate)
  ) {
    fail("Optimizer proposal seal is detached from its proposal.");
  }
  assertSealedArtifactMetadata(
    value.seal.bundle,
    "Optimizer proposal bundle metadata",
  );
  assertSealedArtifactMetadata(
    value.seal.diff,
    "Optimizer proposal diff metadata",
  );
  assertSealedArtifactMetadata(
    value.seal.state,
    "Optimizer proposal state metadata",
  );
  for (const [key, artifact] of [
    ["candidateBundle", value.candidateBundle],
    ["candidateDiff", value.candidateDiff],
    ["sessionState", value.sessionState],
    ["setupManifestArtifact", value.setupManifestArtifact],
    ["claudeManifestArtifact", value.claudeManifestArtifact],
    ["sealManifestArtifact", value.sealManifestArtifact],
  ] as const) {
    assertArtifactReference(artifact, `Optimizer ${key}`);
  }
  const proposalResult =
    value as unknown as CloudOptimizerProposalResult;
  if (
    proposalResult.setup.sourceCommit !==
      proposalResult.seal.sourceCommit ||
    proposalResult.setup.lockSha256 !==
      proposalResult.seal.lockSha256 ||
    proposalResult.seal.bundleRef !==
      `refs/heads/df/bundle/${experimentId}` ||
    proposalResult.proposal.candidate.patchHash !==
      proposalResult.seal.diff.sha256 ||
    proposalResult.candidateBundle.mediaType !==
      "application/vnd.git.bundle" ||
    proposalResult.candidateDiff.mediaType !== "text/x-diff" ||
    proposalResult.sessionState.mediaType !== "application/x-tar" ||
    proposalResult.setupManifestArtifact.mediaType !== "application/json" ||
    proposalResult.claudeManifestArtifact.mediaType !== "application/json" ||
    proposalResult.sealManifestArtifact.mediaType !== "application/json" ||
    proposalResult.candidateBundle.sha256 !==
      proposalResult.seal.bundle.sha256 ||
    proposalResult.candidateBundle.byteLength !==
      proposalResult.seal.bundle.byteLength ||
    proposalResult.candidateDiff.sha256 !==
      proposalResult.seal.diff.sha256 ||
    proposalResult.candidateDiff.byteLength !==
      proposalResult.seal.diff.byteLength ||
    proposalResult.sessionState.sha256 !==
      proposalResult.seal.state.sha256 ||
    proposalResult.sessionState.byteLength !==
      proposalResult.seal.state.byteLength
  ) {
    fail("Optimizer proposal artifacts do not match the seal.");
  }
  assertExecutionReceipts(value.executionReceipts);
}

function assertAnalysisResult(
  value: unknown,
  experiment: ExperimentIdentity,
): asserts value is CloudOptimizerAnalysisResult {
  if (!isPlainRecord(value)) fail("Optimizer analysis result is not an object.");
  assertExactKeys(
    value,
    [
      "analysisHash",
      "rollbackRequired",
      "setup",
      "claude",
      "seal",
      "sessionState",
      "setupManifestArtifact",
      "claudeManifestArtifact",
      "sealManifestArtifact",
      "executionReceipts",
    ],
    "Optimizer analysis result",
  );
  if (
    typeof value.analysisHash !== "string" ||
    !SHA256.test(value.analysisHash) ||
    typeof value.rollbackRequired !== "boolean"
  ) {
    fail("Optimizer analysis result is malformed.");
  }
  const experimentId = optimizerExperimentId(experiment);
  assertManifest(
    value.setup,
    {
      domain: "dark-factory.optimizer-setup.v1",
      campaignId: experiment.lineageId,
      experimentId,
      phase: "analysis",
    },
    "Optimizer analysis setup manifest",
  );
  assertManifest(
    value.claude,
    {
      domain: "dark-factory.optimizer-claude.v1",
      campaignId: experiment.lineageId,
      experimentId,
      phase: "analysis",
    },
    "Optimizer analysis Claude manifest",
  );
  assertManifest(
    value.seal,
    {
      domain: "dark-factory.optimizer-analysis.v1",
      campaignId: experiment.lineageId,
      experimentId,
    },
    "Optimizer analysis seal",
  );
  if (
    value.seal.analysisHash !== value.analysisHash ||
    value.seal.rollbackRequired !== value.rollbackRequired ||
    !isPlainRecord(value.seal.state)
  ) {
    fail("Optimizer analysis result is detached from its seal.");
  }
  assertSealedArtifactMetadata(
    value.seal.state,
    "Optimizer analysis state metadata",
  );
  for (const [key, artifact] of [
    ["sessionState", value.sessionState],
    ["setupManifestArtifact", value.setupManifestArtifact],
    ["claudeManifestArtifact", value.claudeManifestArtifact],
    ["sealManifestArtifact", value.sealManifestArtifact],
  ] as const) {
    assertArtifactReference(artifact, `Optimizer analysis ${key}`);
  }
  const analysisResult =
    value as unknown as CloudOptimizerAnalysisResult;
  if (
    analysisResult.sessionState.mediaType !== "application/x-tar" ||
    analysisResult.setupManifestArtifact.mediaType !== "application/json" ||
    analysisResult.claudeManifestArtifact.mediaType !== "application/json" ||
    analysisResult.sealManifestArtifact.mediaType !== "application/json" ||
    analysisResult.sessionState.sha256 !==
      analysisResult.seal.state.sha256 ||
    analysisResult.sessionState.byteLength !==
      analysisResult.seal.state.byteLength
  ) {
    fail("Optimizer analysis state artifact does not match its seal.");
  }
  assertExecutionReceipts(value.executionReceipts);
}

function emptyOptimizerRecordState(): OptimizerSessionRecordState {
  return {
    schemaVersion: 1,
    sensitivity: "trusted-optimizer-session-records",
    revision: 0,
    proposals: {},
    analyses: {},
  };
}

function assertOptimizerRecordState(
  value: unknown,
): asserts value is OptimizerSessionRecordState {
  if (!isPlainRecord(value)) {
    fail("Optimizer session record state is not an object.");
  }
  assertExactKeys(value, OPTIMIZER_STATE_KEYS, "Optimizer session records");
  if (
    value.schemaVersion !== 1 ||
    value.sensitivity !== "trusted-optimizer-session-records" ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !isPlainRecord(value.proposals) ||
    !isPlainRecord(value.analyses)
  ) {
    fail("Optimizer session record state is malformed.");
  }
  const state = value as unknown as OptimizerSessionRecordState;
  if (
    state.revision !==
    Object.keys(state.proposals).length + Object.keys(state.analyses).length
  ) {
    fail("Optimizer session record revision is inconsistent.");
  }
  for (const [key, record] of Object.entries(state.proposals)) {
    if (!isPlainRecord(record)) {
      fail("Optimizer proposal record is not an object.");
    }
    assertExactKeys(record, OPTIMIZER_RECORD_KEYS, "Optimizer proposal record");
    assertExperimentIdentity(record.experiment);
    assertProposalResult(record.result, record.experiment);
    if (
      key !== optimizerRecordKey(record.experiment) ||
      typeof record.resultHash !== "string" ||
      record.resultHash !== canonicalHash(record.result)
    ) {
      fail("Optimizer proposal record identity is inconsistent.");
    }
  }
  for (const [key, record] of Object.entries(state.analyses)) {
    if (!isPlainRecord(record)) {
      fail("Optimizer analysis record is not an object.");
    }
    assertExactKeys(record, OPTIMIZER_RECORD_KEYS, "Optimizer analysis record");
    assertExperimentIdentity(record.experiment);
    assertAnalysisResult(record.result, record.experiment);
    const proposal = state.proposals[key];
    if (
      key !== optimizerRecordKey(record.experiment) ||
      typeof record.resultHash !== "string" ||
      record.resultHash !== canonicalHash(record.result) ||
      proposal === undefined ||
      canonicalJson(proposal.experiment) !==
        canonicalJson(record.experiment) ||
      record.result.seal.candidateCommit !==
        proposal.result.seal.candidateCommit
    ) {
      fail("Optimizer analysis record identity is inconsistent.");
    }
  }
}

function namespace(
  kind: "one-use-ledger" | "hidden-catalog" | "optimizer-sessions",
  options: MountedVolumeDurableStateOptions,
): string {
  if (!SAFE_STORE_ID.test(options.storeId)) {
    fail("Mounted-volume state store ID is malformed.");
  }
  return `${kind}-${options.storeId}`;
}

/**
 * Production one-use ledger store for the trusted cloud control plane.
 */
export class MountedVolumeAtomicOneUseLedgerStore
  implements AtomicOneUseLedgerStore
{
  readonly #store: MountedVolumeTransactionalJsonStore<OneUseLedgerState>;

  constructor(options: MountedVolumeDurableStateOptions) {
    this.#store = new MountedVolumeTransactionalJsonStore(
      options,
      namespace("one-use-ledger", options),
      {
        domain: "dark-factory.one-use-ledger-state.v1",
        initialState: emptyOneUseLedgerState,
        assertState: assertOneUseLedgerState,
        revision: (state) => state.revision,
      },
    );
  }

  transact<Result>(
    operation: (state: OneUseLedgerState) => {
      readonly next: OneUseLedgerState;
      readonly result: Result;
    },
  ): Promise<Result> {
    return this.#store.transact(operation);
  }

  close(): Promise<void> {
    return this.#store.close();
  }
}

/**
 * Production hidden-catalog CAS store. The storage validator checks every
 * broker-private structural invariant available without catalog HMAC keys;
 * DurableTrustedHiddenCatalog additionally verifies keyed commitments inside
 * the same transaction callback.
 */
export class MountedVolumeLinearizableHiddenCatalogCasStore
  implements LinearizableHiddenCatalogCasStore
{
  readonly #store: MountedVolumeTransactionalJsonStore<
    TrustedHiddenCatalogState | null
  >;

  constructor(options: MountedVolumeDurableStateOptions) {
    this.#store = new MountedVolumeTransactionalJsonStore(
      options,
      namespace("hidden-catalog", options),
      {
        domain: "dark-factory.hidden-catalog-state.v1",
        initialState: () => null,
        assertState: assertNullableTrustedHiddenCatalogStorageState,
        revision: (state) => state?.revision ?? 0,
      },
    );
  }

  transact<Result>(
    operation: (
      state: TrustedHiddenCatalogState | null,
    ) => {
      readonly next: TrustedHiddenCatalogState;
      readonly result: Result;
    },
  ): Promise<Result> {
    return this.#store.transact(operation);
  }

  close(): Promise<void> {
    return this.#store.close();
  }
}

/**
 * Immutable/idempotent proposal and analysis records. Only artifact
 * references, receipts, and signed worker manifests are retained here.
 */
export class MountedVolumeCloudOptimizerSessionRecordStore
  implements CloudOptimizerSessionRecordStore
{
  readonly #store: MountedVolumeTransactionalJsonStore<OptimizerSessionRecordState>;

  constructor(options: MountedVolumeDurableStateOptions) {
    this.#store = new MountedVolumeTransactionalJsonStore(
      options,
      namespace("optimizer-sessions", options),
      {
        domain: "dark-factory.optimizer-session-record-state.v1",
        initialState: emptyOptimizerRecordState,
        assertState: assertOptimizerRecordState,
        revision: (state) => state.revision,
      },
    );
  }

  put(
    experiment: ExperimentIdentity,
    result: CloudOptimizerProposalResult,
  ): Promise<void> {
    assertExperimentIdentity(experiment);
    assertProposalResult(result, experiment);
    const frozenExperiment = canonicalClone(
      experiment,
      "Optimizer proposal experiment",
    );
    const frozenResult = canonicalClone(result, "Optimizer proposal result");
    const key = optimizerRecordKey(frozenExperiment);
    return this.#store.transact((state) => {
      const existing = state.proposals[key];
      if (existing !== undefined) {
        if (
          canonicalJson(existing.experiment) !==
            canonicalJson(frozenExperiment) ||
          existing.resultHash !== canonicalHash(frozenResult)
        ) {
          fail("Optimizer proposal record already contains different content.");
        }
        return { next: state, result: undefined };
      }
      const record: OptimizerStoredRecord<CloudOptimizerProposalResult> = {
        experiment: frozenExperiment,
        resultHash: canonicalHash(frozenResult),
        result: frozenResult,
      };
      return {
        next: {
          ...state,
          revision: state.revision + 1,
          proposals: { ...state.proposals, [key]: record },
        },
        result: undefined,
      };
    });
  }

  get(
    experiment: ExperimentIdentity,
  ): Promise<CloudOptimizerProposalResult | null> {
    assertExperimentIdentity(experiment);
    const key = optimizerRecordKey(experiment);
    return this.#store.transact((state) => {
      const record = state.proposals[key];
      if (
        record !== undefined &&
        canonicalJson(record.experiment) !== canonicalJson(experiment)
      ) {
        fail("Optimizer proposal lookup collided with another experiment.");
      }
      return {
        next: state,
        result:
          record === undefined
            ? null
            : canonicalClone(record.result, "Optimizer proposal record"),
      };
    });
  }

  putAnalysis(
    experiment: ExperimentIdentity,
    result: CloudOptimizerAnalysisResult,
  ): Promise<void> {
    assertExperimentIdentity(experiment);
    assertAnalysisResult(result, experiment);
    const frozenExperiment = canonicalClone(
      experiment,
      "Optimizer analysis experiment",
    );
    const frozenResult = canonicalClone(result, "Optimizer analysis result");
    const key = optimizerRecordKey(frozenExperiment);
    return this.#store.transact((state) => {
      const proposal = state.proposals[key];
      if (
        proposal === undefined ||
        proposal.result.seal.candidateCommit !==
          frozenResult.seal.candidateCommit
      ) {
        fail("Optimizer analysis has no exact sealed proposal.");
      }
      const existing = state.analyses[key];
      if (existing !== undefined) {
        if (
          canonicalJson(existing.experiment) !==
            canonicalJson(frozenExperiment) ||
          existing.resultHash !== canonicalHash(frozenResult)
        ) {
          fail("Optimizer analysis record already contains different content.");
        }
        return { next: state, result: undefined };
      }
      const record: OptimizerStoredRecord<CloudOptimizerAnalysisResult> = {
        experiment: frozenExperiment,
        resultHash: canonicalHash(frozenResult),
        result: frozenResult,
      };
      return {
        next: {
          ...state,
          revision: state.revision + 1,
          analyses: { ...state.analyses, [key]: record },
        },
        result: undefined,
      };
    });
  }

  getAnalysis(
    experiment: ExperimentIdentity,
  ): Promise<CloudOptimizerAnalysisResult | null> {
    assertExperimentIdentity(experiment);
    const key = optimizerRecordKey(experiment);
    return this.#store.transact((state) => {
      const record = state.analyses[key];
      if (
        record !== undefined &&
        canonicalJson(record.experiment) !== canonicalJson(experiment)
      ) {
        fail("Optimizer analysis lookup collided with another experiment.");
      }
      return {
        next: state,
        result:
          record === undefined
            ? null
            : canonicalClone(record.result, "Optimizer analysis record"),
      };
    });
  }

  close(): Promise<void> {
    return this.#store.close();
  }
}
