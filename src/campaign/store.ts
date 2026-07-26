import { randomUUID } from "node:crypto";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { atomicWriteFile } from "../evidence/atomic.js";
import { canonicalHash, canonicalJson, withContentHash } from "../schemas/canonical.js";
import {
  type CampaignPauseReason,
  type CampaignState,
  type CampaignStopReason,
  CONTROL_SCHEMA_VERSION,
} from "../schemas/control.js";
import { assertValidDocument } from "../schemas/registry.js";
import {
  CampaignAlreadyInitializedError,
  CampaignConflictError,
  CampaignIntegrityError,
  CampaignNotInitializedError,
  CampaignTransitionError,
} from "./errors.js";
import { assertCampaignStateTransition, assertInitialCampaignState } from "./invariants.js";

const SAFE_IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const HASH = /^[a-f0-9]{64}$/u;
const STATE_FILE = /^(?<revision>\d{16})-(?<hash>[a-f0-9]{64})\.json$/u;
const STATE_TEMP_FILE = /^\.\d{16}-[a-f0-9]{64}\.json\.[a-f0-9]{32}\.tmp$/u;

type CampaignMetadataKey =
  | "schemaVersion"
  | "createdAt"
  | "provenanceRefs"
  | "contentHash"
  | "revision"
  | "previousStateHash";

export type CampaignStateData = Omit<CampaignState, CampaignMetadataKey>;
type CampaignStateUpdater = (current: Readonly<CampaignState>) => CampaignStateData;

export interface CampaignStateStoreOptions {
  readonly now?: () => Date;
  readonly lockWaitMs?: number;
  readonly lockRetryMs?: number;
  readonly ledgerTransitionVerifier?: CampaignLedgerTransitionVerifier;
  readonly decisionAttestationVerifier?: CampaignDecisionAttestationVerifier;
  readonly controlAttestationVerifier?: CampaignControlAttestationVerifier;
}

export interface CampaignHistory {
  readonly states: readonly CampaignState[];
  readonly current: CampaignState;
}

export interface ExperimentAllocation {
  readonly experimentNumber: number;
  readonly state: CampaignState;
}

export type CampaignExperimentKind = Exclude<CampaignState["numbering"]["inFlightKind"], null>;

export interface CampaignLedgerPointers {
  readonly brokerExposureStateAttestationHash: string;
  readonly repeatedTestingLedgerHash: string;
  readonly privacyLedgerHash: string;
  readonly cacheStateAttestationHash: string | null;
  readonly publicationQueueHash: string | null;
}

export type CampaignLedgerOperation =
  | {
      readonly kind: "checkpoint";
    }
  | {
      readonly kind: "interruption";
      readonly experimentNumber: number;
    }
  | {
      readonly kind: "seal";
      readonly experimentNumber: number;
      readonly stage: SealExperimentInput["stage"];
      readonly disposition: SealExperimentInput["disposition"];
      readonly nextExperimentSealHash: string;
      readonly decisionAttestationHash: string;
    };

export interface CampaignLedgerTransition {
  readonly campaignId: string;
  readonly protocolHash: string;
  readonly currentStateHash: string;
  readonly currentRevision: number;
  readonly reason: "checkpoint" | "interruption" | "seal";
  readonly previousExperimentSealHash: string;
  readonly operation: CampaignLedgerOperation;
  readonly previous: CampaignLedgerPointers;
  readonly next: CampaignLedgerPointers;
}

export interface CampaignLedgerTransitionVerifier {
  readonly verify: (transition: CampaignLedgerTransition) => Promise<void>;
}

export interface CampaignDecisionAttestation {
  readonly campaignId: string;
  readonly baselineLineageId: string;
  readonly protocolHash: string;
  readonly currentStateHash: string;
  readonly currentRevision: number;
  readonly experimentNumber: number;
  readonly stage: SealExperimentInput["stage"];
  readonly disposition: SealExperimentInput["disposition"];
  readonly candidateCommit: string | null;
  readonly activeChampion: CampaignState["champions"]["active"];
  readonly previousExperimentSealHash: string;
  readonly sealHash: string;
  readonly decisionAttestationHash: string;
  readonly holdoutGeneration: number;
  readonly priorHoldoutAvailabilityAttestationHash: string;
  readonly holdoutAvailabilityAttestationHash: string | null;
  readonly sealedAt: string;
  readonly ledgers: CampaignLedgerPointers;
}

export interface CampaignDecisionAttestationVerifier {
  readonly verify: (attestation: CampaignDecisionAttestation) => Promise<void>;
}

export interface SealExperimentInput {
  readonly experimentNumber: number;
  readonly stage: "pre-validation" | "validation" | "shadow";
  readonly disposition: "promoted" | "rejected" | "inconclusive" | "certified" | "not-certified";
  readonly candidateCommit: string | null;
  readonly sealHash: string;
  readonly decisionAttestationHash: string;
  readonly holdoutAvailabilityAttestationHash: string | null;
  readonly sealedAt: string;
  readonly ledgers: CampaignLedgerPointers;
}

export interface ExtensibleBudgetLimits {
  readonly maximumUsd: number;
  readonly maximumTokens: number;
  readonly maximumWallTimeMs: number;
  readonly maximumAttempts: number;
}

interface CampaignControlAttestationBase {
  readonly campaignId: string;
  readonly protocolHash: string;
  readonly currentStateHash: string;
  readonly authorizationOrAttestationHash: string;
}

export type CampaignControlAttestation =
  | {
      readonly kind: "genesis";
      readonly campaignId: string;
      readonly protocolHash: string;
      readonly initialStateHash: string;
      readonly harnessRegistrationHash: string;
      readonly budgetPolicyHash: string;
      readonly budgetAuthorizationHash: string;
      readonly budgetAccountingAttestationHash: string;
      readonly holdoutPolicyHash: string;
      readonly holdoutAvailabilityAttestationHash: string;
      readonly baselineChampion: CampaignState["champions"]["baseline"];
      readonly initialLedgers: CampaignLedgerPointers;
    }
  | (CampaignControlAttestationBase & {
      readonly kind: "budget-accounting";
      readonly previousUsage: CampaignState["budget"]["usage"];
      readonly nextUsage: CampaignState["budget"]["usage"];
    })
  | (CampaignControlAttestationBase & {
      readonly kind: "budget-extension";
      readonly previousLimits: CampaignState["budget"]["limits"];
      readonly nextLimits: CampaignState["budget"]["limits"];
    })
  | (CampaignControlAttestationBase & {
      readonly kind: "holdout-replenishment";
      readonly previousGeneration: number;
      readonly nextGeneration: number;
      readonly freshValidationSetsRemaining: number;
      readonly shadowSlicesRemaining: number;
      readonly availabilityAttestationHash: string;
    })
  | (CampaignControlAttestationBase & {
      readonly kind: "resume";
      readonly previousRunEpoch: number;
      readonly nextRunEpoch: number;
    })
  | (CampaignControlAttestationBase & {
      readonly kind: "pause";
      readonly reason: CampaignPauseReason;
      readonly pausedAt: string;
    })
  | (CampaignControlAttestationBase & {
      readonly kind: "lock-recovery";
      readonly observedLockHash: string;
    });

export interface CampaignControlAttestationVerifier {
  readonly verify: (attestation: CampaignControlAttestation) => Promise<void>;
}

interface OwnedLock {
  readonly ownerToken: string;
  readonly acquiredAt: string;
  readonly processId: number;
}

interface AcquiredLock {
  readonly record: OwnedLock;
  readonly handle: FileHandle;
}

interface OwnedLockSnapshot {
  readonly record: OwnedLock;
  readonly device: number;
  readonly inode: number;
  readonly contentHash: string;
}

class LockHeldError extends Error {
  public constructor() {
    super("Campaign state update lock is held");
    this.name = "LockHeldError";
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isSafeProcessId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertSafeIdentifier(value: string): void {
  if (value.length > 96 || !SAFE_IDENTIFIER.test(value)) {
    throw new CampaignIntegrityError("Invalid campaign id", [value]);
  }
}

function assertHash(value: string, label: string): void {
  if (!HASH.test(value)) {
    throw new CampaignIntegrityError(`${label} must be a lowercase SHA-256 digest`, [value]);
  }
}

function assertCommit(value: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new CampaignIntegrityError("Candidate commit must be a Git object id", [value]);
  }
}

function assertLedgerPointers(pointers: CampaignLedgerPointers): void {
  assertHash(pointers.brokerExposureStateAttestationHash, "Broker exposure state attestation hash");
  assertHash(pointers.repeatedTestingLedgerHash, "Repeated-testing ledger hash");
  assertHash(pointers.privacyLedgerHash, "Privacy ledger hash");
  if (pointers.cacheStateAttestationHash !== null) {
    assertHash(pointers.cacheStateAttestationHash, "Cache state attestation hash");
  }
  if (pointers.publicationQueueHash !== null) {
    assertHash(pointers.publicationQueueHash, "Publication queue hash");
  }
}

function ledgerPointersFromState(state: Readonly<CampaignState>): CampaignLedgerPointers {
  const reconstruction = state.reconstruction;
  if (
    reconstruction.brokerExposureStateAttestationHash === null ||
    reconstruction.repeatedTestingLedgerHash === null ||
    reconstruction.privacyLedgerHash === null
  ) {
    throw new CampaignIntegrityError("Campaign is missing a mandatory reconstruction ledger", [
      state.contentHash,
    ]);
  }
  return {
    brokerExposureStateAttestationHash: reconstruction.brokerExposureStateAttestationHash,
    repeatedTestingLedgerHash: reconstruction.repeatedTestingLedgerHash,
    privacyLedgerHash: reconstruction.privacyLedgerHash,
    cacheStateAttestationHash: reconstruction.cacheStateAttestationHash,
    publicationQueueHash: reconstruction.publicationQueueHash,
  };
}

function budgetIsExhausted(state: CampaignState): boolean {
  const { limits, usage } = state.budget;
  return (
    usage.spentUsd >= limits.maximumUsd ||
    usage.tokens >= limits.maximumTokens ||
    usage.wallTimeMs >= limits.maximumWallTimeMs ||
    usage.attempts >= limits.maximumAttempts ||
    usage.privacyReleases >= limits.maximumPrivacyReleases ||
    usage.promotionLooks >= limits.maximumPromotionLooks ||
    usage.onlineErrorSpent >= limits.maximumOnlineError
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function campaignStateData(state: Readonly<CampaignState>): CampaignStateData {
  return {
    campaignId: state.campaignId,
    mode: state.mode,
    baselineLineageId: state.baselineLineageId,
    protocolHash: state.protocolHash,
    harnessRegistrationHash: state.harnessRegistrationHash,
    control: state.control,
    numbering: state.numbering,
    champions: state.champions,
    budget: state.budget,
    holdout: state.holdout,
    reconstruction: state.reconstruction,
  };
}

function createState(
  data: CampaignStateData,
  revision: number,
  previousStateHash: string | null,
  createdAt: string,
): CampaignState {
  const provenanceRefs = [
    {
      artifactName: "harness-registration",
      contentHash: data.harnessRegistrationHash,
    },
    ...(previousStateHash === null
      ? []
      : [{ artifactName: "campaign-state", contentHash: previousStateHash }]),
  ];
  const value: unknown = withContentHash({
    schemaVersion: CONTROL_SCHEMA_VERSION,
    createdAt,
    provenanceRefs,
    revision,
    previousStateHash,
    ...data,
  });
  assertValidDocument("campaignState", value);
  return value;
}

function stateFileName(state: CampaignState): string {
  const revision = state.revision.toString().padStart(16, "0");
  if (revision.length !== 16) {
    throw new CampaignIntegrityError("Campaign revision exceeds durable filename range", [
      state.revision.toString(),
    ]);
  }
  return `${revision}-${state.contentHash}.json`;
}

async function assertRegularDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new CampaignIntegrityError(`${label} must be a regular directory`, [path]);
  }
}

async function ensureRegularChildDirectory(path: string, label: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
  }
  await assertRegularDirectory(path, label);
}

async function readCanonicalState(path: string): Promise<CampaignState> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new CampaignIntegrityError(`${basename(path)} must be a regular file`, [path]);
  }
  const contents = await readFile(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new CampaignIntegrityError(`${basename(path)} is not valid JSON`, [path], {
      cause: error,
    });
  }
  if (contents !== `${canonicalJson(value)}\n`) {
    throw new CampaignIntegrityError(
      `${basename(path)} is not canonical JSON followed by one newline`,
      [path],
    );
  }
  assertValidDocument("campaignState", value);
  return value;
}

async function readOwnedLockSnapshot(path: string): Promise<OwnedLockSnapshot> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new CampaignIntegrityError("Campaign update lock must be a regular file", [path]);
  }
  const contents = await readFile(path, "utf8");
  const after = await lstat(path);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw new CampaignIntegrityError("Campaign update lock changed while it was inspected", [path]);
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new CampaignIntegrityError("Campaign update lock is not valid JSON", [path], {
      cause: error,
    });
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "acquiredAt,ownerToken,processId"
  ) {
    throw new CampaignIntegrityError("Campaign update lock has an invalid shape", [path]);
  }
  const parsed = value as Readonly<Record<string, unknown>>;
  const ownerToken = parsed["ownerToken"];
  const acquiredAt = parsed["acquiredAt"];
  const processId = parsed["processId"];
  if (
    typeof ownerToken !== "string" ||
    !/^[a-f0-9]{32}$/u.test(ownerToken) ||
    typeof acquiredAt !== "string" ||
    !Number.isFinite(Date.parse(acquiredAt)) ||
    !isSafeProcessId(processId) ||
    contents !== `${canonicalJson(value)}\n`
  ) {
    throw new CampaignIntegrityError("Campaign update lock is malformed", [path]);
  }
  const record: OwnedLock = {
    ownerToken,
    acquiredAt,
    processId,
  };
  return {
    record,
    device: after.dev,
    inode: after.ino,
    contentHash: canonicalHash(record),
  };
}

async function readOwnedLock(path: string): Promise<OwnedLock> {
  return (await readOwnedLockSnapshot(path)).record;
}

/**
 * Append-only, content-addressed campaign state with compare-and-swap writes.
 *
 * Each state transition is one immutable file. There is no mutable "current"
 * pointer: the highest contiguous revision is authoritative, so a completed
 * rename is the commit point and a crash cannot leave split champion/budget
 * state.
 */
export class CampaignStateStore {
  readonly #campaignId: string;
  readonly #root: string;
  readonly #campaignPath: string;
  readonly #statesPath: string;
  readonly #abandonedLocksPath: string;
  readonly #lockPath: string;
  readonly #recoveryLockPath: string;
  readonly #now: () => Date;
  readonly #lockWaitMs: number;
  readonly #lockRetryMs: number;
  readonly #ledgerTransitionVerifier: CampaignLedgerTransitionVerifier | undefined;
  readonly #decisionAttestationVerifier: CampaignDecisionAttestationVerifier | undefined;
  readonly #controlAttestationVerifier: CampaignControlAttestationVerifier | undefined;

  public constructor(root: string, campaignId: string, options: CampaignStateStoreOptions = {}) {
    assertSafeIdentifier(campaignId);
    this.#campaignId = campaignId;
    this.#root = resolve(root);
    this.#campaignPath = join(this.#root, campaignId);
    this.#statesPath = join(this.#campaignPath, "states");
    this.#abandonedLocksPath = join(this.#campaignPath, "abandoned-locks");
    this.#lockPath = join(this.#campaignPath, ".update.lock");
    this.#recoveryLockPath = join(this.#campaignPath, ".recovery.lock");
    this.#now = options.now ?? (() => new Date());
    this.#lockWaitMs = options.lockWaitMs ?? 5_000;
    this.#lockRetryMs = options.lockRetryMs ?? 10;
    this.#ledgerTransitionVerifier = options.ledgerTransitionVerifier;
    this.#decisionAttestationVerifier = options.decisionAttestationVerifier;
    this.#controlAttestationVerifier = options.controlAttestationVerifier;
    if (!Number.isFinite(this.#lockWaitMs) || this.#lockWaitMs < 0) {
      throw new CampaignIntegrityError("lockWaitMs must be finite and non-negative", [
        String(this.#lockWaitMs),
      ]);
    }
    if (!Number.isFinite(this.#lockRetryMs) || this.#lockRetryMs <= 0) {
      throw new CampaignIntegrityError("lockRetryMs must be positive and finite", [
        String(this.#lockRetryMs),
      ]);
    }
  }

  public get campaignId(): string {
    return this.#campaignId;
  }

  public get campaignPath(): string {
    return this.#campaignPath;
  }

  public async initialize(data: CampaignStateData): Promise<CampaignState> {
    const dataSnapshot = deepFreeze(cloneJson(data));
    if (dataSnapshot.campaignId !== this.#campaignId) {
      throw new CampaignIntegrityError("Campaign seed belongs to a different campaign", [
        dataSnapshot.campaignId,
      ]);
    }
    await this.#initializeDirectories();
    return this.#withLock(async (ownerToken) => {
      const existing = await this.#readStates();
      if (existing.length > 0) {
        throw new CampaignAlreadyInitializedError(this.#campaignId);
      }
      const initial = createState(dataSnapshot, 0, null, this.#now().toISOString());
      assertInitialCampaignState(initial);
      await this.#verifyInitialCampaignAttestation(initial);
      await this.#writeState(initial, ownerToken);
      return initial;
    });
  }

  public async read(): Promise<CampaignState> {
    return (await this.reconstruct()).current;
  }

  public async reconstruct(): Promise<CampaignHistory> {
    await this.#initializeDirectories();
    return this.#validateHistory(await this.#readStates());
  }

  public async recoverAbandonedLock(
    expectedContentHash: string,
    authorizationHash: string,
  ): Promise<CampaignState> {
    assertHash(expectedContentHash, "Expected state hash");
    assertHash(authorizationHash, "Controller recovery authorization hash");
    await this.#initializeDirectories();
    const recoveryGuard = await this.#acquireOwnedLock(this.#recoveryLockPath);
    let primaryLock: AcquiredLock | null = null;
    let recoveryGuardReleased = false;
    try {
      const before = await this.reconstruct();
      if (before.current.contentHash !== expectedContentHash) {
        throw new CampaignConflictError(expectedContentHash, before.current.contentHash);
      }
      if (
        before.states.some(
          (state) =>
            state.reconstruction.lastControllerRecoveryAuthorizationHash === authorizationHash,
        )
      ) {
        throw new CampaignTransitionError(
          "Controller recovery authorization hash has already been consumed",
        );
      }
      const abandoned = await readOwnedLockSnapshot(this.#lockPath);
      await this.#verifyControlAttestation({
        kind: "lock-recovery",
        campaignId: before.current.campaignId,
        protocolHash: before.current.protocolHash,
        currentStateHash: before.current.contentHash,
        authorizationOrAttestationHash: authorizationHash,
        observedLockHash: abandoned.contentHash,
      });
      const rechecked = await readOwnedLockSnapshot(this.#lockPath);
      if (
        rechecked.device !== abandoned.device ||
        rechecked.inode !== abandoned.inode ||
        rechecked.contentHash !== abandoned.contentHash ||
        rechecked.record.ownerToken !== abandoned.record.ownerToken
      ) {
        throw new CampaignIntegrityError(
          "Abandoned lock ownership changed before authorized quarantine",
          [abandoned.contentHash, rechecked.contentHash],
        );
      }
      const quarantinePath = join(
        this.#abandonedLocksPath,
        `${Date.now()}-${abandoned.record.ownerToken}-${randomUUID().replaceAll("-", "")}.lock`,
      );
      await rename(this.#lockPath, quarantinePath);
      const quarantined = await readOwnedLockSnapshot(quarantinePath);
      if (
        quarantined.device !== abandoned.device ||
        quarantined.inode !== abandoned.inode ||
        quarantined.contentHash !== abandoned.contentHash ||
        quarantined.record.ownerToken !== abandoned.record.ownerToken
      ) {
        throw new CampaignIntegrityError(
          "Quarantined lock does not match the authorized abandoned lock",
          [abandoned.contentHash, quarantined.contentHash],
        );
      }
      primaryLock = await this.#acquireOwnedLock(this.#lockPath);
      await recoveryGuard.handle.close().catch(() => undefined);
      await this.#releaseOwnedLock(this.#recoveryLockPath, recoveryGuard.record.ownerToken);
      recoveryGuardReleased = true;

      const history = await this.#historyLocked();
      return await this.#compareAndSwapCurrent(
        history.current,
        expectedContentHash,
        (state) => ({
          ...campaignStateData(state),
          reconstruction: {
            ...state.reconstruction,
            lastControllerRecoveryAuthorizationHash: authorizationHash,
            lastControllerRecoveryLockHash: abandoned.contentHash,
          },
        }),
        primaryLock.record.ownerToken,
      );
    } finally {
      if (primaryLock !== null) {
        await primaryLock.handle.close().catch(() => undefined);
        if (recoveryGuardReleased) {
          await this.#releaseLock(primaryLock.record.ownerToken);
        } else {
          await this.#releaseOwnedLock(this.#lockPath, primaryLock.record.ownerToken);
        }
      }
      if (!recoveryGuardReleased) {
        await recoveryGuard.handle.close().catch(() => undefined);
        await this.#releaseOwnedLock(this.#recoveryLockPath, recoveryGuard.record.ownerToken);
      }
    }
  }

  async #compareAndSwap(
    expectedContentHash: string,
    updater: CampaignStateUpdater,
  ): Promise<CampaignState> {
    assertHash(expectedContentHash, "Expected state hash");
    await this.#initializeDirectories();
    return this.#withLock(async (ownerToken) =>
      this.#compareAndSwapLocked(expectedContentHash, updater, ownerToken),
    );
  }

  public async allocateExperiment(
    expectedContentHash: string,
    kind: CampaignExperimentKind,
  ): Promise<ExperimentAllocation> {
    const state = await this.#compareAndSwap(expectedContentHash, (current) => {
      if (current.control.status !== "running") {
        throw new CampaignTransitionError(
          "Experiments can be allocated only while the campaign is running",
        );
      }
      if (current.numbering.inFlightExperimentNumber !== null) {
        throw new CampaignTransitionError(
          "The current in-flight experiment must finish before another is allocated",
        );
      }
      if (budgetIsExhausted(current)) {
        throw new CampaignTransitionError(
          "No experiment can be allocated while a hard campaign budget is exhausted",
        );
      }
      if (kind === "optimization" && current.holdout.freshValidationSetsRemaining === 0) {
        throw new CampaignTransitionError(
          "Optimization cannot continue without fresh-validation capacity",
        );
      }
      if (kind === "shadow" && current.holdout.shadowSlicesRemaining === 0) {
        throw new CampaignTransitionError(
          "Shadow certification cannot continue without a fresh shadow slice",
        );
      }
      const experimentNumber = current.numbering.nextExperimentNumber;
      return {
        ...campaignStateData(current),
        numbering: {
          ...current.numbering,
          nextExperimentNumber: experimentNumber + 1,
          inFlightExperimentNumber: experimentNumber,
          inFlightKind: kind,
        },
      };
    });
    const experimentNumber = state.numbering.inFlightExperimentNumber;
    if (experimentNumber === null) {
      throw new CampaignIntegrityError("Allocated state lost its in-flight pointer", [
        state.contentHash,
      ]);
    }
    return { experimentNumber, state };
  }

  public async recordBudgetUsage(
    expectedContentHash: string,
    usage: CampaignState["budget"]["usage"],
    accountingAttestationHash: string,
  ): Promise<CampaignState> {
    const usageSnapshot = deepFreeze(cloneJson(usage));
    assertHash(accountingAttestationHash, "Budget accounting attestation hash");
    assertHash(expectedContentHash, "Expected state hash");
    await this.#initializeDirectories();
    return this.#withLock(async (ownerToken) => {
      const history = await this.#historyLocked();
      const current = history.current;
      if (current.contentHash !== expectedContentHash) {
        throw new CampaignConflictError(expectedContentHash, current.contentHash);
      }
      if (
        history.states.some(
          (state) => state.budget.accountingAttestationHash === accountingAttestationHash,
        )
      ) {
        throw new CampaignTransitionError(
          "Budget accounting attestation hash has already been consumed",
        );
      }
      await this.#verifyControlAttestation({
        kind: "budget-accounting",
        campaignId: current.campaignId,
        protocolHash: current.protocolHash,
        currentStateHash: current.contentHash,
        authorizationOrAttestationHash: accountingAttestationHash,
        previousUsage: current.budget.usage,
        nextUsage: usageSnapshot,
      });
      return this.#compareAndSwapCurrent(
        current,
        expectedContentHash,
        (state) => ({
          ...campaignStateData(state),
          budget: {
            ...state.budget,
            usage: usageSnapshot,
            accountingAttestationHash,
          },
        }),
        ownerToken,
      );
    });
  }

  public async extendSpendBudget(
    expectedContentHash: string,
    limits: ExtensibleBudgetLimits,
    authorizationHash: string,
  ): Promise<CampaignState> {
    const limitsSnapshot = deepFreeze(cloneJson(limits));
    assertHash(expectedContentHash, "Expected state hash");
    assertHash(authorizationHash, "Budget extension authorization hash");
    await this.#initializeDirectories();
    return this.#withLock(async (ownerToken) => {
      const history = await this.#historyLocked();
      const current = history.current;
      if (current.contentHash !== expectedContentHash) {
        throw new CampaignConflictError(expectedContentHash, current.contentHash);
      }
      if (history.states.some((state) => state.budget.authorizationHash === authorizationHash)) {
        throw new CampaignTransitionError(
          "Budget extension authorization hash has already been consumed",
        );
      }
      await this.#verifyControlAttestation({
        kind: "budget-extension",
        campaignId: current.campaignId,
        protocolHash: current.protocolHash,
        currentStateHash: current.contentHash,
        authorizationOrAttestationHash: authorizationHash,
        previousLimits: current.budget.limits,
        nextLimits: {
          ...current.budget.limits,
          ...limitsSnapshot,
        },
      });
      return this.#compareAndSwapCurrent(
        current,
        expectedContentHash,
        (state) => ({
          ...campaignStateData(state),
          budget: {
            ...state.budget,
            limits: {
              ...state.budget.limits,
              maximumUsd: limitsSnapshot.maximumUsd,
              maximumTokens: limitsSnapshot.maximumTokens,
              maximumWallTimeMs: limitsSnapshot.maximumWallTimeMs,
              maximumAttempts: limitsSnapshot.maximumAttempts,
            },
            authorizationHash,
          },
        }),
        ownerToken,
      );
    });
  }

  public async replenishHoldout(
    expectedContentHash: string,
    freshValidationSetsRemaining: number,
    shadowSlicesRemaining: number,
    availabilityAttestationHash: string,
    replenishmentAuthorizationHash: string,
  ): Promise<CampaignState> {
    assertHash(expectedContentHash, "Expected state hash");
    assertHash(availabilityAttestationHash, "Holdout availability attestation hash");
    assertHash(replenishmentAuthorizationHash, "Holdout replenishment authorization hash");
    await this.#initializeDirectories();
    return this.#withLock(async (ownerToken) => {
      const history = await this.#historyLocked();
      const current = history.current;
      if (current.contentHash !== expectedContentHash) {
        throw new CampaignConflictError(expectedContentHash, current.contentHash);
      }
      if (
        history.states.some(
          (state) =>
            state.holdout.replenishmentAuthorizationHash === replenishmentAuthorizationHash,
        )
      ) {
        throw new CampaignTransitionError(
          "Holdout replenishment authorization hash has already been consumed",
        );
      }
      if (current.numbering.inFlightExperimentNumber !== null) {
        throw new CampaignTransitionError(
          "Holdout capacity cannot be replenished while an experiment is in flight",
        );
      }
      if (current.control.status === "running") {
        throw new CampaignTransitionError(
          "Holdout replenishment requires a paused or stopped campaign",
        );
      }
      await this.#verifyControlAttestation({
        kind: "holdout-replenishment",
        campaignId: current.campaignId,
        protocolHash: current.protocolHash,
        currentStateHash: current.contentHash,
        authorizationOrAttestationHash: replenishmentAuthorizationHash,
        previousGeneration: current.holdout.generation,
        nextGeneration: current.holdout.generation + 1,
        freshValidationSetsRemaining,
        shadowSlicesRemaining,
        availabilityAttestationHash,
      });
      return this.#compareAndSwapCurrent(
        current,
        expectedContentHash,
        (state) => ({
          ...campaignStateData(state),
          holdout: {
            ...state.holdout,
            freshValidationSetsRemaining,
            shadowSlicesRemaining,
            generation: state.holdout.generation + 1,
            availabilityAttestationHash,
            replenishmentAuthorizationHash,
          },
        }),
        ownerToken,
      );
    });
  }

  public async recordLedgerCheckpoint(
    expectedContentHash: string,
    ledgers: CampaignLedgerPointers,
  ): Promise<CampaignState> {
    const ledgerSnapshot = deepFreeze(cloneJson(ledgers));
    assertLedgerPointers(ledgerSnapshot);
    return this.#compareAndSwapWithVerifiedLedgers(
      expectedContentHash,
      ledgerSnapshot,
      { kind: "checkpoint" },
      (state) => ({
        ...campaignStateData(state),
        reconstruction: {
          ...state.reconstruction,
          ...ledgerSnapshot,
        },
      }),
      null,
    );
  }

  public async sealExperiment(
    expectedContentHash: string,
    input: SealExperimentInput,
  ): Promise<CampaignState> {
    const inputSnapshot = deepFreeze(cloneJson(input));
    assertHash(inputSnapshot.sealHash, "Experiment seal hash");
    assertHash(inputSnapshot.decisionAttestationHash, "Decision attestation hash");
    assertLedgerPointers(inputSnapshot.ledgers);
    if (
      !Number.isSafeInteger(inputSnapshot.experimentNumber) ||
      inputSnapshot.experimentNumber < 1
    ) {
      throw new CampaignIntegrityError("Sealed experiment number is invalid", [
        String(inputSnapshot.experimentNumber),
      ]);
    }
    if (inputSnapshot.holdoutAvailabilityAttestationHash !== null) {
      assertHash(
        inputSnapshot.holdoutAvailabilityAttestationHash,
        "Holdout availability attestation hash",
      );
    }
    if (inputSnapshot.candidateCommit !== null) {
      assertCommit(inputSnapshot.candidateCommit);
    }

    return this.#compareAndSwapWithVerifiedLedgers(
      expectedContentHash,
      inputSnapshot.ledgers,
      {
        kind: "seal",
        experimentNumber: inputSnapshot.experimentNumber,
        stage: inputSnapshot.stage,
        disposition: inputSnapshot.disposition,
        nextExperimentSealHash: inputSnapshot.sealHash,
        decisionAttestationHash: inputSnapshot.decisionAttestationHash,
      },
      (state) => {
        if (state.numbering.inFlightExperimentNumber !== inputSnapshot.experimentNumber) {
          throw new CampaignTransitionError("Only the current in-flight experiment can be sealed");
        }
        const expectedKind = inputSnapshot.stage === "shadow" ? "shadow" : "optimization";
        if (state.numbering.inFlightKind !== expectedKind) {
          throw new CampaignTransitionError(
            `A ${inputSnapshot.stage} decision cannot seal ` +
              `${String(state.numbering.inFlightKind)} work`,
          );
        }
        const promoted =
          inputSnapshot.stage === "validation" && inputSnapshot.disposition === "promoted";
        const certified =
          inputSnapshot.stage === "shadow" && inputSnapshot.disposition === "certified";
        const validDisposition =
          (inputSnapshot.stage === "pre-validation" &&
            (inputSnapshot.disposition === "rejected" ||
              inputSnapshot.disposition === "inconclusive")) ||
          (inputSnapshot.stage === "validation" &&
            (inputSnapshot.disposition === "promoted" ||
              inputSnapshot.disposition === "rejected" ||
              inputSnapshot.disposition === "inconclusive")) ||
          (inputSnapshot.stage === "shadow" &&
            (inputSnapshot.disposition === "certified" ||
              inputSnapshot.disposition === "not-certified" ||
              inputSnapshot.disposition === "inconclusive"));
        if (!validDisposition) {
          throw new CampaignTransitionError(
            `Disposition ${inputSnapshot.disposition} is invalid for ${inputSnapshot.stage}`,
          );
        }
        if (
          (promoted && inputSnapshot.candidateCommit === null) ||
          (!promoted && inputSnapshot.candidateCommit !== null)
        ) {
          throw new CampaignTransitionError(
            "Candidate commit must be present exactly for active promotion",
          );
        }
        const consumesHoldout =
          inputSnapshot.stage === "validation" || inputSnapshot.stage === "shadow";
        if (consumesHoldout && inputSnapshot.holdoutAvailabilityAttestationHash === null) {
          throw new CampaignTransitionError(
            "Validation and shadow decisions require a new holdout attestation",
          );
        }
        if (
          inputSnapshot.stage === "validation" &&
          state.holdout.freshValidationSetsRemaining === 0
        ) {
          throw new CampaignTransitionError(
            "Validation decision cannot consume exhausted fresh capacity",
          );
        }
        if (inputSnapshot.stage === "shadow" && state.holdout.shadowSlicesRemaining === 0) {
          throw new CampaignTransitionError(
            "Shadow decision cannot consume exhausted shadow capacity",
          );
        }

        const nextChampions = promoted
          ? {
              ...state.champions,
              active: {
                experimentNumber: inputSnapshot.experimentNumber,
                commit: inputSnapshot.candidateCommit as string,
                sourceSealHash: inputSnapshot.sealHash,
              },
              updatedAt: inputSnapshot.sealedAt,
            }
          : certified
            ? {
                ...state.champions,
                certified: {
                  experimentNumber: state.champions.active.experimentNumber,
                  commit: state.champions.active.commit,
                  sourceSealHash: inputSnapshot.sealHash,
                },
                updatedAt: inputSnapshot.sealedAt,
              }
            : state.champions;
        const nextHoldout =
          inputSnapshot.stage === "validation"
            ? {
                ...state.holdout,
                freshValidationSetsRemaining: state.holdout.freshValidationSetsRemaining - 1,
                availabilityAttestationHash:
                  inputSnapshot.holdoutAvailabilityAttestationHash as string,
              }
            : inputSnapshot.stage === "shadow"
              ? {
                  ...state.holdout,
                  shadowSlicesRemaining: state.holdout.shadowSlicesRemaining - 1,
                  availabilityAttestationHash:
                    inputSnapshot.holdoutAvailabilityAttestationHash as string,
                }
              : state.holdout;
        return {
          ...campaignStateData(state),
          numbering: {
            ...state.numbering,
            inFlightExperimentNumber: null,
            inFlightKind: null,
          },
          champions: nextChampions,
          holdout: nextHoldout,
          reconstruction: {
            ...state.reconstruction,
            ...inputSnapshot.ledgers,
            lastFullySealedExperimentNumber: inputSnapshot.experimentNumber,
            experimentSealChainHead: inputSnapshot.sealHash,
            lastSealedDecision: {
              experimentNumber: inputSnapshot.experimentNumber,
              stage: inputSnapshot.stage,
              disposition: inputSnapshot.disposition,
              decisionAttestationHash: inputSnapshot.decisionAttestationHash,
              sealedAt: inputSnapshot.sealedAt,
            } as NonNullable<CampaignState["reconstruction"]["lastSealedDecision"]>,
          },
        };
      },
      (state) => this.#verifyDecisionAttestation(state, inputSnapshot),
    );
  }

  public async archiveInterruptedExperiment(
    expectedContentHash: string,
    experimentNumber: number,
    brokerExposureStateAttestationHash: string,
  ): Promise<CampaignState> {
    assertHash(expectedContentHash, "Expected state hash");
    assertHash(brokerExposureStateAttestationHash, "Broker exposure state attestation hash");
    if (!Number.isSafeInteger(experimentNumber) || experimentNumber < 1) {
      throw new CampaignIntegrityError("Interrupted experiment number is invalid", [
        String(experimentNumber),
      ]);
    }
    await this.#initializeDirectories();
    return this.#withLock(async (ownerToken) => {
      const current = (await this.#historyLocked()).current;
      if (
        current.numbering.inFlightExperimentNumber === null &&
        current.numbering.lastInterruptedExperimentNumber === experimentNumber
      ) {
        if (
          current.previousStateHash === expectedContentHash &&
          current.reconstruction.brokerExposureStateAttestationHash ===
            brokerExposureStateAttestationHash
        ) {
          return current;
        }
        throw new CampaignConflictError(expectedContentHash, current.contentHash);
      }
      if (current.contentHash !== expectedContentHash) {
        throw new CampaignConflictError(expectedContentHash, current.contentHash);
      }
      if (current.numbering.inFlightExperimentNumber !== experimentNumber) {
        throw new CampaignTransitionError(
          "Only the current in-flight experiment can be archived as interrupted",
        );
      }
      const nextLedgers = {
        ...ledgerPointersFromState(current),
        brokerExposureStateAttestationHash,
      };
      if (
        current.reconstruction.brokerExposureStateAttestationHash ===
        brokerExposureStateAttestationHash
      ) {
        throw new CampaignTransitionError(
          "Interrupted work requires a new broker-exposure attestation",
        );
      }
      await this.#verifyLedgerTransition(current, nextLedgers, {
        kind: "interruption",
        experimentNumber,
      });
      return this.#compareAndSwapCurrent(
        current,
        expectedContentHash,
        (state) => ({
          ...campaignStateData(state),
          numbering: {
            ...state.numbering,
            inFlightExperimentNumber: null,
            inFlightKind: null,
            lastInterruptedExperimentNumber: experimentNumber,
          },
          reconstruction: {
            ...state.reconstruction,
            ...nextLedgers,
          },
        }),
        ownerToken,
      );
    });
  }

  public async requestStop(
    expectedContentHash: string,
    reason: CampaignStopReason,
  ): Promise<CampaignState> {
    assertHash(expectedContentHash, "Expected state hash");
    await this.#initializeDirectories();
    return this.#withLock(async (ownerToken) => {
      const history = await this.#historyLocked();
      const current = history.current;
      if (current.control.status === "stop-requested" || current.control.status === "stopped") {
        const recordedRequest = history.states.find(
          (state) =>
            state.control.status === "stop-requested" &&
            state.previousStateHash === expectedContentHash &&
            state.control.stopReason === reason,
        );
        if (
          recordedRequest !== undefined &&
          current.control.stopReason === recordedRequest.control.stopReason &&
          current.control.stopRequestedAt === recordedRequest.control.stopRequestedAt
        ) {
          return current;
        }
        throw new CampaignConflictError(expectedContentHash, current.contentHash);
      }
      return this.#compareAndSwapCurrent(
        current,
        expectedContentHash,
        (state) => ({
          ...campaignStateData(state),
          control: {
            ...state.control,
            status: "stop-requested",
            stopRequestedAt: this.#now().toISOString(),
            stopReason: reason,
            stoppedAt: null,
            pausedAt: null,
            pauseReason: null,
            pauseAttestationHash: null,
          },
        }),
        ownerToken,
      );
    });
  }

  public async acknowledgeStopped(expectedContentHash: string): Promise<CampaignState> {
    assertHash(expectedContentHash, "Expected state hash");
    await this.#initializeDirectories();
    return this.#withLock(async (ownerToken) => {
      const history = await this.#historyLocked();
      const current = history.current;
      if (current.control.status === "stopped") {
        const recordedAcknowledgement = history.states.find(
          (state) =>
            state.control.status === "stopped" && state.previousStateHash === expectedContentHash,
        );
        if (
          recordedAcknowledgement !== undefined &&
          current.control.stoppedAt === recordedAcknowledgement.control.stoppedAt &&
          current.control.stopRequestedAt === recordedAcknowledgement.control.stopRequestedAt
        ) {
          return current;
        }
        throw new CampaignConflictError(expectedContentHash, current.contentHash);
      }
      if (current.control.status !== "stop-requested") {
        throw new CampaignTransitionError(
          "A campaign can be acknowledged stopped only after a durable stop request",
        );
      }
      if (current.numbering.inFlightExperimentNumber !== null) {
        throw new CampaignTransitionError(
          "The in-flight experiment must be sealed or archived before stop acknowledgement",
        );
      }
      return this.#compareAndSwapCurrent(
        current,
        expectedContentHash,
        (state) => ({
          ...campaignStateData(state),
          control: {
            ...state.control,
            status: "stopped",
            stoppedAt: this.#now().toISOString(),
          },
        }),
        ownerToken,
      );
    });
  }

  public async pause(
    expectedContentHash: string,
    reason: CampaignPauseReason,
    attestationHash: string,
  ): Promise<CampaignState> {
    assertHash(expectedContentHash, "Expected state hash");
    assertHash(attestationHash, "Pause attestation hash");
    await this.#initializeDirectories();
    return this.#withLock(async (ownerToken) => {
      const history = await this.#historyLocked();
      const current = history.current;
      if (current.control.status === "paused") {
        if (
          current.previousStateHash === expectedContentHash &&
          current.control.pauseReason === reason &&
          current.control.pauseAttestationHash === attestationHash
        ) {
          return current;
        }
        throw new CampaignConflictError(expectedContentHash, current.contentHash);
      }
      if (current.contentHash !== expectedContentHash) {
        throw new CampaignConflictError(expectedContentHash, current.contentHash);
      }
      if (current.control.status !== "running") {
        throw new CampaignTransitionError("Only a running campaign can be paused");
      }
      if (current.numbering.inFlightExperimentNumber !== null) {
        throw new CampaignTransitionError(
          "The in-flight experiment must be sealed or archived before pausing",
        );
      }
      if (reason === "budget-exhausted" && !budgetIsExhausted(current)) {
        throw new CampaignTransitionError(
          "A budget-exhausted pause requires a sealed exhausted budget dimension",
        );
      }
      if (
        reason === "holdout-exhausted" &&
        (current.holdout.freshValidationSetsRemaining > 0 ||
          current.holdout.shadowSlicesRemaining > 0)
      ) {
        throw new CampaignTransitionError(
          "A holdout-exhausted pause requires zero validation and shadow capacity",
        );
      }
      if (history.states.some((state) => state.control.pauseAttestationHash === attestationHash)) {
        throw new CampaignTransitionError("Pause attestation hash has already been consumed");
      }
      const pausedAt = this.#now().toISOString();
      await this.#verifyControlAttestation({
        kind: "pause",
        campaignId: current.campaignId,
        protocolHash: current.protocolHash,
        currentStateHash: current.contentHash,
        authorizationOrAttestationHash: attestationHash,
        reason,
        pausedAt,
      });
      return this.#compareAndSwapCurrent(
        current,
        expectedContentHash,
        (state) => ({
          ...campaignStateData(state),
          control: {
            ...state.control,
            status: "paused",
            stopRequestedAt: null,
            stopReason: null,
            stoppedAt: null,
            pausedAt,
            pauseReason: reason,
            pauseAttestationHash: attestationHash,
          },
        }),
        ownerToken,
      );
    });
  }

  public async resume(
    expectedContentHash: string,
    authorizationHash: string,
  ): Promise<CampaignState> {
    assertHash(expectedContentHash, "Expected state hash");
    assertHash(authorizationHash, "Resume authorization hash");
    await this.#initializeDirectories();
    return this.#withLock(async (ownerToken) => {
      const history = await this.#historyLocked();
      const current = history.current;
      if (current.control.status === "running") {
        if (
          current.previousStateHash === expectedContentHash &&
          current.control.lastResumeAuthorizationHash === authorizationHash
        ) {
          return current;
        }
        throw new CampaignConflictError(expectedContentHash, current.contentHash);
      }
      if (current.contentHash !== expectedContentHash) {
        throw new CampaignConflictError(expectedContentHash, current.contentHash);
      }
      if (current.control.status === "stop-requested") {
        throw new CampaignTransitionError(
          "A pending stop must be durably acknowledged before resume",
        );
      }
      if (current.numbering.inFlightExperimentNumber !== null) {
        throw new CampaignTransitionError(
          "An in-flight experiment must be sealed or archived before resume",
        );
      }
      if (budgetIsExhausted(current)) {
        throw new CampaignTransitionError(
          "Campaign cannot resume while a hard campaign budget is exhausted",
        );
      }
      if (
        current.holdout.freshValidationSetsRemaining === 0 &&
        current.holdout.shadowSlicesRemaining === 0
      ) {
        throw new CampaignTransitionError(
          "Campaign cannot resume without fresh validation or shadow capacity",
        );
      }
      if (
        current.control.status === "paused" &&
        current.control.pauseReason === "budget-exhausted" &&
        budgetIsExhausted(current)
      ) {
        throw new CampaignTransitionError(
          "Budget-exhausted campaign cannot resume before an authorized limit extension",
        );
      }
      if (
        current.control.status === "paused" &&
        current.control.pauseReason === "holdout-exhausted" &&
        current.holdout.freshValidationSetsRemaining === 0 &&
        current.holdout.shadowSlicesRemaining === 0
      ) {
        throw new CampaignTransitionError(
          "Holdout-exhausted campaign cannot resume before authorized replenishment",
        );
      }
      if (
        history.states.some(
          (state) => state.control.lastResumeAuthorizationHash === authorizationHash,
        )
      ) {
        throw new CampaignTransitionError("Resume authorization hash has already been consumed");
      }
      await this.#verifyControlAttestation({
        kind: "resume",
        campaignId: current.campaignId,
        protocolHash: current.protocolHash,
        currentStateHash: current.contentHash,
        authorizationOrAttestationHash: authorizationHash,
        previousRunEpoch: current.control.runEpoch,
        nextRunEpoch: current.control.runEpoch + 1,
      });
      return this.#compareAndSwapCurrent(
        current,
        expectedContentHash,
        (state) => ({
          ...campaignStateData(state),
          control: {
            ...state.control,
            status: "running",
            runEpoch: state.control.runEpoch + 1,
            stopRequestedAt: null,
            stopReason: null,
            stoppedAt: null,
            pausedAt: null,
            pauseReason: null,
            pauseAttestationHash: null,
            lastResumedAt: this.#now().toISOString(),
            lastResumeAuthorizationHash: authorizationHash,
          },
        }),
        ownerToken,
      );
    });
  }

  async #initializeDirectories(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await assertRegularDirectory(this.#root, "Campaign control root");
    await ensureRegularChildDirectory(this.#campaignPath, "Campaign directory");
    await ensureRegularChildDirectory(this.#statesPath, "Campaign state directory");
    await ensureRegularChildDirectory(
      this.#abandonedLocksPath,
      "Abandoned-lock quarantine directory",
    );
  }

  async #readStates(): Promise<readonly CampaignState[]> {
    const entries = await readdir(this.#statesPath, { withFileTypes: true });
    const violations: string[] = [];
    const parsed: {
      readonly name: string;
      readonly revision: number;
      readonly expectedHash: string;
    }[] = [];

    for (const entry of entries) {
      if (STATE_TEMP_FILE.test(entry.name)) {
        if (entry.isFile() && !entry.isSymbolicLink()) {
          continue;
        }
        violations.push(`invalid temporary state entry ${entry.name}`);
        continue;
      }
      const match = STATE_FILE.exec(entry.name);
      if (!entry.isFile() || entry.isSymbolicLink() || match?.groups === undefined) {
        violations.push(`unexpected state entry ${entry.name}`);
        continue;
      }
      const revision = Number.parseInt(match.groups["revision"] ?? "", 10);
      const expectedHash = match.groups["hash"] ?? "";
      if (!Number.isSafeInteger(revision)) {
        violations.push(`unsafe revision in ${entry.name}`);
        continue;
      }
      parsed.push({ name: entry.name, revision, expectedHash });
    }

    parsed.sort((left, right) => left.revision - right.revision);
    const states: CampaignState[] = [];
    for (const [index, file] of parsed.entries()) {
      if (file.revision !== index) {
        violations.push(`expected revision ${index}, found ${file.revision}`);
        continue;
      }
      try {
        const state = await readCanonicalState(join(this.#statesPath, file.name));
        if (
          state.campaignId !== this.#campaignId ||
          state.revision !== file.revision ||
          state.contentHash !== file.expectedHash
        ) {
          violations.push(`file identity mismatch in ${file.name}`);
        }
        states.push(state);
      } catch (error) {
        violations.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (violations.length > 0) {
      throw new CampaignIntegrityError("Campaign state history is invalid", violations);
    }
    return states;
  }

  async #historyLocked(): Promise<CampaignHistory> {
    return this.#validateHistory(await this.#readStates());
  }

  async #validateHistory(states: readonly CampaignState[]): Promise<CampaignHistory> {
    if (states.length === 0) {
      throw new CampaignNotInitializedError(this.#campaignId);
    }
    const initial = states[0];
    if (initial === undefined) {
      throw new CampaignNotInitializedError(this.#campaignId);
    }
    assertInitialCampaignState(initial);
    await this.#verifyInitialCampaignAttestation(initial);
    this.#assertHistoryWideUniqueness(states);
    for (let index = 1; index < states.length; index += 1) {
      const previous = states[index - 1];
      const current = states[index];
      if (previous === undefined || current === undefined) {
        throw new CampaignIntegrityError("Campaign state history is sparse", [index.toString()]);
      }
      assertCampaignStateTransition(previous, current);
      await this.#verifyPersistedTransition(previous, current);
    }
    const current = states.at(-1);
    if (current === undefined) {
      throw new CampaignNotInitializedError(this.#campaignId);
    }
    return { states, current };
  }

  #assertHistoryWideUniqueness(states: readonly CampaignState[]): void {
    const seen = new Map<string, Set<string>>();
    const consume = (label: string, value: string | null): void => {
      if (value === null) {
        return;
      }
      const values = seen.get(label) ?? new Set<string>();
      if (values.has(value)) {
        throw new CampaignIntegrityError(`Campaign history reuses ${label}`, [value]);
      }
      values.add(value);
      seen.set(label, values);
    };

    const initial = states[0];
    if (initial === undefined) {
      return;
    }
    consume("budget authorization", initial.budget.authorizationHash);
    consume("budget accounting attestation", initial.budget.accountingAttestationHash);
    consume("holdout availability attestation", initial.holdout.availabilityAttestationHash);
    consume("experiment seal-chain head", initial.reconstruction.experimentSealChainHead);
    for (const field of [
      "brokerExposureStateAttestationHash",
      "repeatedTestingLedgerHash",
      "privacyLedgerHash",
      "cacheStateAttestationHash",
      "publicationQueueHash",
    ] as const) {
      consume(`reconstruction pointer ${field}`, initial.reconstruction[field]);
    }

    for (let index = 1; index < states.length; index += 1) {
      const previous = states[index - 1];
      const current = states[index];
      if (previous === undefined || current === undefined) {
        continue;
      }
      if (
        current.control.lastResumeAuthorizationHash !== previous.control.lastResumeAuthorizationHash
      ) {
        consume("resume authorization", current.control.lastResumeAuthorizationHash);
      }
      if (current.control.pauseAttestationHash !== previous.control.pauseAttestationHash) {
        consume("pause attestation", current.control.pauseAttestationHash);
      }
      if (current.budget.authorizationHash !== previous.budget.authorizationHash) {
        consume("budget authorization", current.budget.authorizationHash);
      }
      if (current.budget.accountingAttestationHash !== previous.budget.accountingAttestationHash) {
        consume("budget accounting attestation", current.budget.accountingAttestationHash);
      }
      if (
        current.holdout.replenishmentAuthorizationHash !==
        previous.holdout.replenishmentAuthorizationHash
      ) {
        consume(
          "holdout replenishment authorization",
          current.holdout.replenishmentAuthorizationHash,
        );
      }
      if (
        current.holdout.availabilityAttestationHash !== previous.holdout.availabilityAttestationHash
      ) {
        consume("holdout availability attestation", current.holdout.availabilityAttestationHash);
      }
      if (
        current.reconstruction.lastControllerRecoveryAuthorizationHash !==
        previous.reconstruction.lastControllerRecoveryAuthorizationHash
      ) {
        consume(
          "controller recovery authorization",
          current.reconstruction.lastControllerRecoveryAuthorizationHash,
        );
        consume(
          "controller recovery observed-lock hash",
          current.reconstruction.lastControllerRecoveryLockHash,
        );
      }
      if (
        current.reconstruction.lastFullySealedExperimentNumber !==
        previous.reconstruction.lastFullySealedExperimentNumber
      ) {
        consume(
          "decision attestation",
          current.reconstruction.lastSealedDecision?.decisionAttestationHash ?? null,
        );
        consume("experiment seal-chain head", current.reconstruction.experimentSealChainHead);
      }
      for (const field of [
        "brokerExposureStateAttestationHash",
        "repeatedTestingLedgerHash",
        "privacyLedgerHash",
        "cacheStateAttestationHash",
        "publicationQueueHash",
      ] as const) {
        if (current.reconstruction[field] !== previous.reconstruction[field]) {
          consume(`reconstruction pointer ${field}`, current.reconstruction[field]);
        }
      }
    }
  }

  async #verifyPersistedTransition(previous: CampaignState, next: CampaignState): Promise<void> {
    const previousLedgers = ledgerPointersFromState(previous);
    const nextLedgers = ledgerPointersFromState(next);
    const sealAdvanced =
      (next.reconstruction.lastFullySealedExperimentNumber ?? -1) >
      (previous.reconstruction.lastFullySealedExperimentNumber ?? -1);
    const interruptionAdvanced =
      (next.numbering.lastInterruptedExperimentNumber ?? -1) >
      (previous.numbering.lastInterruptedExperimentNumber ?? -1);

    if (sealAdvanced) {
      const decision = next.reconstruction.lastSealedDecision;
      const sealHash = next.reconstruction.experimentSealChainHead;
      if (decision === null || sealHash === null) {
        throw new CampaignIntegrityError(
          "Sealed campaign transition is missing trusted decision evidence",
          [next.contentHash],
        );
      }
      const candidateCommit =
        decision.stage === "validation" && decision.disposition === "promoted"
          ? next.champions.active.commit
          : null;
      const holdoutAvailabilityAttestationHash =
        decision.stage === "validation" || decision.stage === "shadow"
          ? next.holdout.availabilityAttestationHash
          : null;
      const operation: CampaignLedgerOperation = {
        kind: "seal",
        experimentNumber: decision.experimentNumber,
        stage: decision.stage,
        disposition: decision.disposition,
        nextExperimentSealHash: sealHash,
        decisionAttestationHash: decision.decisionAttestationHash,
      };
      const input: SealExperimentInput = {
        experimentNumber: decision.experimentNumber,
        stage: decision.stage,
        disposition: decision.disposition,
        candidateCommit,
        sealHash,
        decisionAttestationHash: decision.decisionAttestationHash,
        holdoutAvailabilityAttestationHash,
        sealedAt: decision.sealedAt,
        ledgers: nextLedgers,
      };
      await this.#verifyLedgerTransition(previous, nextLedgers, operation);
      await this.#verifyDecisionAttestation(previous, input);
    } else if (interruptionAdvanced) {
      const experimentNumber = next.numbering.lastInterruptedExperimentNumber;
      if (experimentNumber === null) {
        throw new CampaignIntegrityError(
          "Interrupted campaign transition lost its experiment number",
          [next.contentHash],
        );
      }
      await this.#verifyLedgerTransition(previous, nextLedgers, {
        kind: "interruption",
        experimentNumber,
      });
    } else if (canonicalJson(previousLedgers) !== canonicalJson(nextLedgers)) {
      await this.#verifyLedgerTransition(previous, nextLedgers, {
        kind: "checkpoint",
      });
    }

    if (canonicalJson(previous.budget.usage) !== canonicalJson(next.budget.usage)) {
      await this.#verifyControlAttestation({
        kind: "budget-accounting",
        campaignId: previous.campaignId,
        protocolHash: previous.protocolHash,
        currentStateHash: previous.contentHash,
        authorizationOrAttestationHash: next.budget.accountingAttestationHash,
        previousUsage: previous.budget.usage,
        nextUsage: next.budget.usage,
      });
    }
    if (canonicalJson(previous.budget.limits) !== canonicalJson(next.budget.limits)) {
      await this.#verifyControlAttestation({
        kind: "budget-extension",
        campaignId: previous.campaignId,
        protocolHash: previous.protocolHash,
        currentStateHash: previous.contentHash,
        authorizationOrAttestationHash: next.budget.authorizationHash,
        previousLimits: previous.budget.limits,
        nextLimits: next.budget.limits,
      });
    }
    if (next.holdout.generation > previous.holdout.generation) {
      const authorizationHash = next.holdout.replenishmentAuthorizationHash;
      if (authorizationHash === null) {
        throw new CampaignIntegrityError(
          "Holdout generation lacks its replenishment authorization",
          [next.contentHash],
        );
      }
      await this.#verifyControlAttestation({
        kind: "holdout-replenishment",
        campaignId: previous.campaignId,
        protocolHash: previous.protocolHash,
        currentStateHash: previous.contentHash,
        authorizationOrAttestationHash: authorizationHash,
        previousGeneration: previous.holdout.generation,
        nextGeneration: next.holdout.generation,
        freshValidationSetsRemaining: next.holdout.freshValidationSetsRemaining,
        shadowSlicesRemaining: next.holdout.shadowSlicesRemaining,
        availabilityAttestationHash: next.holdout.availabilityAttestationHash,
      });
    }
    if (next.control.runEpoch > previous.control.runEpoch) {
      const authorizationHash = next.control.lastResumeAuthorizationHash;
      if (authorizationHash === null) {
        throw new CampaignIntegrityError("Resumed campaign transition lacks its authorization", [
          next.contentHash,
        ]);
      }
      await this.#verifyControlAttestation({
        kind: "resume",
        campaignId: previous.campaignId,
        protocolHash: previous.protocolHash,
        currentStateHash: previous.contentHash,
        authorizationOrAttestationHash: authorizationHash,
        previousRunEpoch: previous.control.runEpoch,
        nextRunEpoch: next.control.runEpoch,
      });
    }
    if (next.control.status === "paused" && previous.control.status !== "paused") {
      const attestationHash = next.control.pauseAttestationHash;
      const reason = next.control.pauseReason;
      const pausedAt = next.control.pausedAt;
      if (attestationHash === null || reason === null || pausedAt === null) {
        throw new CampaignIntegrityError("Paused campaign transition lacks its attested reason", [
          next.contentHash,
        ]);
      }
      await this.#verifyControlAttestation({
        kind: "pause",
        campaignId: previous.campaignId,
        protocolHash: previous.protocolHash,
        currentStateHash: previous.contentHash,
        authorizationOrAttestationHash: attestationHash,
        reason,
        pausedAt,
      });
    }
    if (
      next.reconstruction.lastControllerRecoveryAuthorizationHash !==
      previous.reconstruction.lastControllerRecoveryAuthorizationHash
    ) {
      const authorizationHash = next.reconstruction.lastControllerRecoveryAuthorizationHash;
      const observedLockHash = next.reconstruction.lastControllerRecoveryLockHash;
      if (authorizationHash === null || observedLockHash === null) {
        throw new CampaignIntegrityError(
          "Controller recovery transition lacks its bound lock evidence",
          [next.contentHash],
        );
      }
      await this.#verifyControlAttestation({
        kind: "lock-recovery",
        campaignId: previous.campaignId,
        protocolHash: previous.protocolHash,
        currentStateHash: previous.contentHash,
        authorizationOrAttestationHash: authorizationHash,
        observedLockHash,
      });
    }
  }

  async #compareAndSwapLocked(
    expectedContentHash: string,
    updater: CampaignStateUpdater,
    ownerToken: string,
  ): Promise<CampaignState> {
    const current = (await this.#historyLocked()).current;
    return this.#compareAndSwapCurrent(current, expectedContentHash, updater, ownerToken);
  }

  async #compareAndSwapWithVerifiedLedgers(
    expectedContentHash: string,
    nextLedgers: CampaignLedgerPointers,
    operation: CampaignLedgerOperation,
    updater: CampaignStateUpdater,
    preflight: ((state: Readonly<CampaignState>) => Promise<void>) | null,
  ): Promise<CampaignState> {
    assertHash(expectedContentHash, "Expected state hash");
    assertLedgerPointers(nextLedgers);
    await this.#initializeDirectories();
    return this.#withLock(async (ownerToken) => {
      const current = (await this.#historyLocked()).current;
      if (current.contentHash !== expectedContentHash) {
        throw new CampaignConflictError(expectedContentHash, current.contentHash);
      }
      const verifiedCurrent = deepFreeze(cloneJson(current));
      const verifiedNextLedgers = deepFreeze(cloneJson(nextLedgers));
      const previousLedgers = ledgerPointersFromState(verifiedCurrent);
      if (
        operation.kind === "checkpoint" &&
        canonicalJson(previousLedgers) === canonicalJson(verifiedNextLedgers)
      ) {
        throw new CampaignTransitionError(
          "A ledger checkpoint must advance at least one signed pointer",
        );
      }
      if (
        operation.kind === "interruption" &&
        previousLedgers.brokerExposureStateAttestationHash ===
          verifiedNextLedgers.brokerExposureStateAttestationHash
      ) {
        throw new CampaignTransitionError(
          "Interrupted work requires a new broker-exposure attestation",
        );
      }
      if (
        operation.kind === "seal" &&
        operation.nextExperimentSealHash === verifiedCurrent.reconstruction.experimentSealChainHead
      ) {
        throw new CampaignTransitionError(
          "A sealed experiment must advance to a distinct seal-chain head",
        );
      }
      await this.#verifyLedgerTransition(verifiedCurrent, verifiedNextLedgers, operation);
      if (preflight !== null) {
        await preflight(verifiedCurrent);
      }
      return this.#compareAndSwapCurrent(current, expectedContentHash, updater, ownerToken);
    });
  }

  async #verifyDecisionAttestation(
    current: Readonly<CampaignState>,
    input: SealExperimentInput,
  ): Promise<void> {
    if (this.#decisionAttestationVerifier === undefined) {
      throw new CampaignTransitionError(
        "A trusted decision-attestation verifier is required to seal an experiment",
      );
    }
    const previousExperimentSealHash = current.reconstruction.experimentSealChainHead;
    if (previousExperimentSealHash === null) {
      throw new CampaignIntegrityError("Campaign is missing its experiment seal-chain head", [
        current.contentHash,
      ]);
    }
    const attestation = deepFreeze(
      cloneJson<CampaignDecisionAttestation>({
        campaignId: current.campaignId,
        baselineLineageId: current.baselineLineageId,
        protocolHash: current.protocolHash,
        currentStateHash: current.contentHash,
        currentRevision: current.revision,
        experimentNumber: input.experimentNumber,
        stage: input.stage,
        disposition: input.disposition,
        candidateCommit: input.candidateCommit,
        activeChampion: current.champions.active,
        previousExperimentSealHash,
        sealHash: input.sealHash,
        decisionAttestationHash: input.decisionAttestationHash,
        holdoutGeneration: current.holdout.generation,
        priorHoldoutAvailabilityAttestationHash: current.holdout.availabilityAttestationHash,
        holdoutAvailabilityAttestationHash: input.holdoutAvailabilityAttestationHash,
        sealedAt: input.sealedAt,
        ledgers: input.ledgers,
      }),
    );
    await this.#decisionAttestationVerifier.verify(attestation);
  }

  async #verifyLedgerTransition(
    current: Readonly<CampaignState>,
    next: CampaignLedgerPointers,
    operation: CampaignLedgerOperation,
  ): Promise<void> {
    if (this.#ledgerTransitionVerifier === undefined) {
      throw new CampaignTransitionError(
        "A trusted ledger-transition verifier is required for this operation",
      );
    }
    const previousExperimentSealHash = current.reconstruction.experimentSealChainHead;
    if (previousExperimentSealHash === null) {
      throw new CampaignIntegrityError("Campaign is missing its experiment seal-chain head", [
        current.contentHash,
      ]);
    }
    const transition = deepFreeze(
      cloneJson<CampaignLedgerTransition>({
        campaignId: current.campaignId,
        protocolHash: current.protocolHash,
        currentStateHash: current.contentHash,
        currentRevision: current.revision,
        reason: operation.kind,
        previousExperimentSealHash,
        operation: deepFreeze(cloneJson(operation)),
        previous: ledgerPointersFromState(current),
        next,
      }),
    );
    await this.#ledgerTransitionVerifier.verify(transition);
  }

  async #verifyControlAttestation(attestation: CampaignControlAttestation): Promise<void> {
    if (this.#controlAttestationVerifier === undefined) {
      throw new CampaignTransitionError(
        "A trusted control-attestation verifier is required for this operation",
      );
    }
    await this.#controlAttestationVerifier.verify(deepFreeze(cloneJson(attestation)));
  }

  async #verifyInitialCampaignAttestation(state: CampaignState): Promise<void> {
    await this.#verifyControlAttestation({
      kind: "genesis",
      campaignId: state.campaignId,
      protocolHash: state.protocolHash,
      initialStateHash: state.contentHash,
      harnessRegistrationHash: state.harnessRegistrationHash,
      budgetPolicyHash: state.budget.policyHash,
      budgetAuthorizationHash: state.budget.authorizationHash,
      budgetAccountingAttestationHash: state.budget.accountingAttestationHash,
      holdoutPolicyHash: state.holdout.policyHash,
      holdoutAvailabilityAttestationHash: state.holdout.availabilityAttestationHash,
      baselineChampion: state.champions.baseline,
      initialLedgers: ledgerPointersFromState(state),
    });
  }

  async #compareAndSwapCurrent(
    current: CampaignState,
    expectedContentHash: string,
    updater: CampaignStateUpdater,
    ownerToken: string,
  ): Promise<CampaignState> {
    if (current.contentHash !== expectedContentHash) {
      throw new CampaignConflictError(expectedContentHash, current.contentHash);
    }
    const predecessor = deepFreeze(cloneJson(current));
    const updatedData = cloneJson(updater(predecessor));
    const next = createState(
      updatedData,
      predecessor.revision + 1,
      predecessor.contentHash,
      this.#now().toISOString(),
    );
    assertCampaignStateTransition(predecessor, next);
    await this.#writeState(next, ownerToken);
    return next;
  }

  async #writeState(state: CampaignState, ownerToken: string): Promise<void> {
    /*
     * Recovery and commit share this short-lived guard. A recovery can inspect
     * an owner lock while an operation is doing expensive verification, but it
     * cannot quarantine that lock between the final ownership check and the
     * immutable state-file commit.
     */
    const commitGuard = await this.#acquireOwnedLock(this.#recoveryLockPath);
    try {
      await this.#assertLockOwnership(ownerToken);
      await atomicWriteFile(
        join(this.#statesPath, stateFileName(state)),
        `${canonicalJson(state)}\n`,
      );
    } finally {
      await commitGuard.handle.close().catch(() => undefined);
      await this.#releaseOwnedLock(this.#recoveryLockPath, commitGuard.record.ownerToken);
    }
  }

  async #withLock<T>(operation: (ownerToken: string) => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.#lockWaitMs;
    while (true) {
      let lock: AcquiredLock;
      try {
        lock = await this.#acquireLock();
      } catch (error) {
        if (!(error instanceof LockHeldError) || Date.now() >= deadline) {
          throw error;
        }
        await delay(this.#lockRetryMs);
        continue;
      }
      try {
        return await operation(lock.record.ownerToken);
      } finally {
        await lock.handle.close().catch(() => undefined);
        await this.#releaseLock(lock.record.ownerToken);
      }
    }
  }

  async #acquireLock(): Promise<AcquiredLock> {
    const acquisitionGuard = await this.#acquireOwnedLock(this.#recoveryLockPath);
    try {
      return await this.#acquireOwnedLock(this.#lockPath);
    } finally {
      await acquisitionGuard.handle.close().catch(() => undefined);
      await this.#releaseOwnedLock(this.#recoveryLockPath, acquisitionGuard.record.ownerToken);
    }
  }

  async #acquireOwnedLock(path: string): Promise<AcquiredLock> {
    let handle: FileHandle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new LockHeldError();
      }
      throw error;
    }
    const record: OwnedLock = {
      ownerToken: randomUUID().replaceAll("-", ""),
      acquiredAt: this.#now().toISOString(),
      processId: process.pid,
    };
    try {
      await handle.writeFile(`${canonicalJson(record)}\n`);
      await handle.sync();
      return { record, handle };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }

  async #assertLockOwnership(ownerToken: string): Promise<void> {
    const current = await readOwnedLock(this.#lockPath);
    if (current.ownerToken !== ownerToken) {
      throw new CampaignIntegrityError("Campaign update lock ownership was lost", [
        ownerToken,
        current.ownerToken,
      ]);
    }
  }

  async #releaseLock(ownerToken: string): Promise<void> {
    const deadline = Date.now() + this.#lockWaitMs;
    let releaseGuard: AcquiredLock;
    while (true) {
      try {
        releaseGuard = await this.#acquireOwnedLock(this.#recoveryLockPath);
        break;
      } catch (error) {
        if (!(error instanceof LockHeldError) || Date.now() >= deadline) {
          throw error;
        }
        await delay(this.#lockRetryMs);
      }
    }
    try {
      /*
       * The recovery guard makes the token check and unlink one cooperative
       * critical section. An authorized recovery therefore cannot replace the
       * primary lock between those two operations.
       */
      await this.#releaseOwnedLock(this.#lockPath, ownerToken);
    } finally {
      await releaseGuard.handle.close().catch(() => undefined);
      await this.#releaseOwnedLock(this.#recoveryLockPath, releaseGuard.record.ownerToken);
    }
  }

  async #releaseOwnedLock(path: string, ownerToken: string): Promise<void> {
    try {
      const current = await readOwnedLock(path);
      if (current.ownerToken === ownerToken) {
        await unlink(path);
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
  }
}
