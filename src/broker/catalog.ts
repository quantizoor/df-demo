import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  allocateValidationQuotas,
  countFreshValidationPanels,
  type HiddenPanelSelection,
  type HiddenSelectedTask,
  type HiddenTaskEstimates,
  type HiddenTaskId,
  type HiddenTaskLedgerEntry,
  initialValidationQuotaCarry,
  markShadowReservations,
  reserveShadowSlices,
  SELECTION_POLICY_VERSION,
  type SelectionBucket,
  selectRepairPanel,
  selectRepairPanelFromSource,
  selectValidationPanel,
  type ValidationQuotaCarry,
} from "../evaluation/index.js";
import { hiddenTaskId } from "../evaluation/types.js";
import {
  assertEvaluationRequest,
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "../evaluator/contracts.js";
import type {
  TrustedHiddenCatalogOutcomeCommitReceipt,
  TrustedHiddenCatalogOutcomeUpdateSink,
  TrustedHiddenCatalogOutcomeUpdateVerifier,
  TrustedSignedHiddenCatalogOutcomeUpdate,
} from "../evaluator/deriver.js";
import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import type { TerminalBench21Pin } from "../terminal-bench/pin.js";
import type { TrustedHiddenTaskCell, TrustedMatchedPanel } from "../terminal-bench/trusted.js";

const TERMINAL_BENCH_21_DATASET = "terminal-bench/terminal-bench-2-1";
const TERMINAL_BENCH_21_TASK_COUNT = 89;
const TERMINAL_BENCH_21_REGISTRY_REVISION = 6;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_PACKAGE_TASK_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const BUCKETS = ["hard", "uncertain", "easy", "coverage"] as const;
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
] as const satisfies readonly (keyof HiddenTaskEstimates)[];
const SEED_KEYS = [
  "packageTaskName",
  "taskRevisionDigest",
  "capabilityStratum",
  "difficultyStratum",
  "buckets",
  "estimates",
  "initialFeedbackReleased",
  "regressionCanary",
  "infrastructureValid",
  "discriminating",
] as const;
const PIN_KEYS = [
  "benchmark",
  "dataset",
  "registryRevision",
  "taskCount",
  "datasetContentSha256",
  "datasetManifestSha256",
  "harborVersion",
  "harborPackageSha256",
  "harborExecutableSha256",
  "piHarborAdapterSha256",
] as const;
const STATE_KEYS = [
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
const SHADOW_SLICE_KEYS = [
  "slice",
  "taskIds",
  "selectedBuckets",
  "consumed",
  "consumedByRequestHash",
] as const;
const ALLOCATION_KEYS = [
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
] as const;
const OUTCOME_COMMITMENT_KEYS = [
  "sensitivity",
  "updateId",
  "requestHash",
  "sourceBindingHash",
  "updateSetHash",
  "signatureHash",
  "observedAt",
  "taskCount",
] as const;
const SIGNED_OUTCOME_UPDATE_KEYS = [
  "sensitivity",
  "schemaVersion",
  "updateId",
  "requestHash",
  "protocolHash",
  "stage",
  "dispositionAttestationHash",
  "rawManifestHash",
  "jobSha256",
  "runtimeAttestationHash",
  "normalizedOutcomeSetHash",
  "environmentFingerprintHash",
  "observedAt",
  "outcomes",
  "updateSetHash",
  "sourceBindingHash",
  "signature",
] as const;
const TASK_OUTCOME_KEYS = [
  "taskId",
  "taskRevisionDigest",
  "capabilityStratum",
  "order",
  "candidate",
  "champion",
] as const;
const ARM_OUTCOME_KEYS = [
  "pass",
  "boundedReward",
  "infrastructureValid",
  "infrastructureInvalidAttemptCount",
  "latencyMs",
  "inputTokens",
  "outputTokens",
  "modelUsd",
  "sandboxUsd",
  "finalAttemptDigest",
] as const;
const SIGNATURE_KEYS = ["algorithm", "keyId", "signedAt", "signature"] as const;
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
const PRIOR_EFFECTIVE_OBSERVATIONS = 4;

export const TRUSTED_HIDDEN_SELECTION_POLICY_HASH = canonicalHash({
  policyVersion: SELECTION_POLICY_VERSION,
  scoreWeights: {
    championFailure: 0.25,
    baselineFailure: 0.15,
    comparableLeaderboardFailure: 0.12,
    recentTrustedFailure: 0.18,
  },
  adaptivePosterior: {
    version: "trusted-hidden-outcomes-v1",
    priorEffectiveObservations: PRIOR_EFFECTIVE_OBSERVATIONS,
    candidateAndChampionFailuresRemainBrokerPrivate: true,
  },
  repairQuota: {
    hard: 3,
    uncertain: 1,
    finalSlot: "alternating-easy-coverage",
  },
  validationQuotaTenths: {
    hard: 6,
    uncertain: 2,
    easy: 1,
    coverage: 1,
  },
  shadowSlices: 2,
  shadowTasksPerSlice: 12,
  deterministic: true,
});

export interface TrustedHiddenTaskSeed {
  readonly packageTaskName: string;
  readonly taskRevisionDigest: string;
  readonly capabilityStratum: string;
  readonly difficultyStratum: string;
  readonly buckets: readonly SelectionBucket[];
  readonly estimates: HiddenTaskEstimates;
  /**
   * True only when task-derived feedback was already irreversibly released
   * before this catalog was imported. Public leaderboard priors belong in the
   * estimates above and do not, by themselves, make a task repair-eligible.
   */
  readonly initialFeedbackReleased: boolean;
  readonly regressionCanary: boolean;
  readonly infrastructureValid: boolean;
  readonly discriminating: boolean;
}

export interface TrustedCatalogHmacKey {
  readonly keyId: string;
  readonly secret: Uint8Array;
}

export interface TrustedShadowSliceState {
  readonly slice: 1 | 2;
  readonly taskIds: readonly HiddenTaskId[];
  readonly selectedBuckets: readonly SelectionBucket[];
  readonly consumed: boolean;
  readonly consumedByRequestHash: string | null;
}

export interface TrustedPanelAllocationRecord {
  readonly sensitivity: "trusted-hidden-panel-allocation";
  readonly requestId: string;
  readonly experimentId: string;
  readonly requestHash: string;
  readonly datasetPinHash: string;
  readonly registryRevision: 6;
  readonly protocolHash: string;
  readonly claimTokenCommitment: string;
  readonly dispositionNonce: string;
  readonly frozenHypothesisDigest: string;
  readonly candidateArchiveSha256: string;
  readonly championArchiveSha256: string;
  readonly repairSourceExperimentId: string | null;
  readonly repairSourceRequestHash: string | null;
  readonly repairAttemptOrdinal: 1 | 2 | null;
  readonly selectedBuckets: readonly SelectionBucket[];
  readonly panel: TrustedMatchedPanel;
}

export interface TrustedHiddenTaskOutcomeStats {
  readonly candidateObservationCount: number;
  readonly candidateFailureCount: number;
  readonly candidateRewardSum: number;
  readonly championObservationCount: number;
  readonly championFailureCount: number;
  readonly championRewardSum: number;
  readonly matchedObservationCount: number;
  readonly discriminationSignalSum: number;
  readonly costObservationCount: number;
  readonly normalizedCostSignalSum: number;
  readonly lastObservedAt: string | null;
}

export interface TrustedHiddenCatalogOutcomeCommitment {
  readonly sensitivity: "trusted-hidden-catalog-outcome-commitment";
  readonly updateId: string;
  readonly requestHash: string;
  readonly sourceBindingHash: string;
  readonly updateSetHash: string;
  readonly signatureHash: string;
  readonly observedAt: string;
  readonly taskCount: number;
}

export interface TrustedStoredHiddenTask extends HiddenTaskLedgerEntry {
  readonly sensitivity: "trusted-hidden-task-record";
  readonly datasetPinHash: string;
  readonly registryRevision: 6;
  readonly packageTaskName: string;
  /** Immutable import priors used to reproduce every posterior estimate. */
  readonly seedEstimates: HiddenTaskEstimates;
  readonly outcomeStats: TrustedHiddenTaskOutcomeStats;
}

/**
 * This state is trusted-cloud-only. It deliberately contains package task
 * names and hidden identifiers so a cloud job builder can resolve a sealed
 * panel without ever returning those names to the controller.
 */
export interface TrustedHiddenCatalogState {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-hidden-task-catalog";
  readonly revision: number;
  readonly datasetPinHash: string;
  readonly registryRevision: 6;
  readonly seedSetCommitment: string;
  readonly taskIdKeyId: string;
  readonly dispositionKeyId: string;
  readonly weightingPolicyHash: string;
  readonly taskOrder: readonly HiddenTaskId[];
  readonly tasks: Readonly<Record<string, TrustedStoredHiddenTask>>;
  readonly validationCarry: ValidationQuotaCarry;
  readonly repairEpoch: number;
  readonly shadowSlices: readonly [TrustedShadowSliceState, TrustedShadowSliceState];
  readonly allocations: Readonly<Record<string, TrustedPanelAllocationRecord>>;
  readonly outcomeUpdates: Readonly<Record<string, TrustedHiddenCatalogOutcomeCommitment>>;
  readonly stateCommitment: string;
}

/**
 * Implementations must execute the callback exactly once inside a linearizable
 * cloud transaction, and must durably commit `next` before resolving. `null`
 * means the catalog has not been imported yet. There is intentionally no
 * process-memory or local-filesystem implementation in production code.
 */
export interface LinearizableHiddenCatalogCasStore {
  transact<Result>(
    operation: (state: TrustedHiddenCatalogState | null) => {
      readonly next: TrustedHiddenCatalogState;
      readonly result: Result;
    },
  ): Promise<Result>;
}

export interface ReleaseSafeHiddenCatalogAttestation {
  readonly sensitivity: "release-safe";
  readonly benchmark: "terminal-bench-2.1";
  readonly datasetPinHash: string;
  readonly taskCount: 89;
  readonly selectionPolicyVersion: typeof SELECTION_POLICY_VERSION;
  readonly catalogIntegrity: "passed";
  readonly repairPanelCapacity: "available" | "unavailable";
  readonly freshValidationPanelCapacityBand: "0" | "1-2" | "3-5" | "6+";
  readonly shadowReservedSliceCount: 2;
  readonly shadowRemainingSliceCount: 0 | 1 | 2;
  readonly containsTaskNames: false;
  readonly containsTaskIdentifiers: false;
  readonly containsPanelHandles: false;
}

/**
 * Structural match for the trusted Terminal-Bench job builder resolver. The
 * returned object must remain inside that trusted deployment.
 */
export interface TrustedResolvedHiddenTask {
  readonly sensitivity: "trusted-hidden-task-resolution";
  readonly taskId: HiddenTaskId;
  readonly taskRevisionDigest: string;
  readonly packageTaskName: string;
}

export interface TrustedHiddenTaskResolver {
  resolve(taskId: HiddenTaskId, taskRevisionDigest: string): Promise<TrustedResolvedHiddenTask>;
}

export interface DurableTrustedHiddenCatalogOptions {
  readonly store: LinearizableHiddenCatalogCasStore;
  readonly datasetPin: TerminalBench21Pin;
  readonly expectedDatasetPinHash: string;
  readonly taskSeeds: readonly TrustedHiddenTaskSeed[];
  readonly taskIdKey: TrustedCatalogHmacKey;
  readonly expectedTaskIdKeyId: string;
  readonly dispositionKey: TrustedCatalogHmacKey;
  readonly expectedDispositionKeyId: string;
  readonly outcomeVerifier: TrustedHiddenCatalogOutcomeUpdateVerifier;
  readonly weightingPolicyHash: string;
  readonly now?: () => Date;
  readonly nonceFactory?: () => Uint8Array;
}

export type TrustedHiddenCatalogErrorCode =
  | "configuration-invalid"
  | "catalog-invalid"
  | "catalog-conflict"
  | "catalog-uninitialized"
  | "allocation-conflict"
  | "allocation-exhausted"
  | "outcome-invalid"
  | "outcome-conflict"
  | "request-invalid"
  | "resolution-failed"
  | "store-failed";

export class TrustedHiddenCatalogError extends Error {
  override readonly name = "TrustedHiddenCatalogError";

  constructor(
    readonly code: TrustedHiddenCatalogErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface CatalogSecrets {
  readonly taskId: Uint8Array;
  readonly disposition: Uint8Array;
}

interface PreparedCatalog {
  readonly seedSetCommitment: string;
  readonly tasks: readonly TrustedStoredHiddenTask[];
  readonly shadowSlices: readonly [TrustedShadowSliceState, TrustedShadowSliceState];
  readonly validationCarry: ValidationQuotaCarry;
}

interface SelectedPanel {
  readonly selection: HiddenPanelSelection;
  readonly nextCarry: ValidationQuotaCarry;
  readonly shadowSlice: 1 | 2 | null;
  readonly repairSourceRequestHash: string | null;
}

function assertExactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "A trusted catalog record has an unsupported shape.",
    );
  }
}

function assertTerminalBenchPin(pin: TerminalBench21Pin): void {
  assertExactKeys(pin, PIN_KEYS);
  if (
    pin.benchmark !== "terminal-bench-2.1" ||
    pin.dataset !== TERMINAL_BENCH_21_DATASET ||
    pin.taskCount !== TERMINAL_BENCH_21_TASK_COUNT ||
    pin.registryRevision !== TERMINAL_BENCH_21_REGISTRY_REVISION ||
    !EXACT_SEMVER.test(pin.harborVersion) ||
    !SHA256.test(pin.datasetContentSha256) ||
    !SHA256.test(pin.datasetManifestSha256) ||
    !SHA256.test(pin.harborPackageSha256) ||
    !SHA256.test(pin.harborExecutableSha256) ||
    !SHA256.test(pin.piHarborAdapterSha256)
  ) {
    throw new TrustedHiddenCatalogError(
      "configuration-invalid",
      "The trusted catalog requires one exact Terminal-Bench 2.1 pin.",
    );
  }
}

function copyAndValidateKey(key: TrustedCatalogHmacKey, expectedKeyId: string): Uint8Array {
  if (
    !SAFE_ID.test(key.keyId) ||
    key.keyId !== expectedKeyId ||
    !(key.secret instanceof Uint8Array) ||
    key.secret.byteLength < 32 ||
    key.secret.byteLength > 128
  ) {
    throw new TrustedHiddenCatalogError(
      "configuration-invalid",
      "A trusted catalog HMAC key does not match its exact configured identity.",
    );
  }
  return Uint8Array.from(key.secret);
}

function hmacHex(secret: Uint8Array, payload: Readonly<Record<string, unknown>>): string {
  return createHmac("sha256", secret).update(canonicalJson(payload)).digest("hex");
}

function equalHex(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function deriveHiddenTaskId(
  secret: Uint8Array,
  keyId: string,
  datasetPin: TerminalBench21Pin,
  seed: Pick<TrustedHiddenTaskSeed, "packageTaskName" | "taskRevisionDigest">,
): HiddenTaskId {
  return hiddenTaskId(
    hmacHex(secret, {
      domain: "dark-factory/hidden-task-id/v1",
      keyId,
      datasetPin,
      packageTaskName: seed.packageTaskName,
      taskRevisionDigest: seed.taskRevisionDigest,
    }),
  );
}

function validateEstimates(estimates: HiddenTaskEstimates): void {
  assertExactKeys(estimates, ESTIMATE_KEYS);
  if (
    ESTIMATE_KEYS.some((key) => {
      const value = estimates[key];
      return !Number.isFinite(value) || value < 0 || value > 1;
    })
  ) {
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "Trusted task estimates must be finite unit-interval values.",
    );
  }
}

function validateSeed(seed: TrustedHiddenTaskSeed): void {
  assertExactKeys(seed, SEED_KEYS);
  validateEstimates(seed.estimates);
  if (
    !SAFE_PACKAGE_TASK_NAME.test(seed.packageTaskName) ||
    !SHA256.test(seed.taskRevisionDigest) ||
    !SAFE_ID.test(seed.capabilityStratum) ||
    !SAFE_ID.test(seed.difficultyStratum) ||
    !Array.isArray(seed.buckets) ||
    seed.buckets.length === 0 ||
    new Set(seed.buckets).size !== seed.buckets.length ||
    seed.buckets.some((bucket) => !BUCKETS.includes(bucket as SelectionBucket)) ||
    typeof seed.initialFeedbackReleased !== "boolean" ||
    typeof seed.regressionCanary !== "boolean" ||
    typeof seed.infrastructureValid !== "boolean" ||
    typeof seed.discriminating !== "boolean"
  ) {
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "A trusted task seed violates the fixed catalog schema.",
    );
  }
}

function seedCommitmentPayload(
  seeds: readonly TrustedHiddenTaskSeed[],
): readonly TrustedHiddenTaskSeed[] {
  return [...seeds].sort((left, right) =>
    left.packageTaskName.localeCompare(right.packageTaskName),
  );
}

function createStoredTask(
  seed: TrustedHiddenTaskSeed,
  taskId: HiddenTaskId,
  datasetPinHash: string,
): TrustedStoredHiddenTask {
  return {
    sensitivity: "trusted-hidden-task-record",
    datasetPinHash,
    registryRevision: 6,
    packageTaskName: seed.packageTaskName,
    taskId,
    taskRevisionDigest: seed.taskRevisionDigest,
    capabilityStratum: seed.capabilityStratum,
    difficultyStratum: seed.difficultyStratum,
    buckets: [...seed.buckets],
    estimates: { ...seed.estimates },
    seedEstimates: { ...seed.estimates },
    outcomeStats: {
      candidateObservationCount: 0,
      candidateFailureCount: 0,
      candidateRewardSum: 0,
      championObservationCount: 0,
      championFailureCount: 0,
      championRewardSum: 0,
      matchedObservationCount: 0,
      discriminationSignalSum: 0,
      costObservationCount: 0,
      normalizedCostSignalSum: 0,
      lastObservedAt: null,
    },
    exposure: {
      total: seed.initialFeedbackReleased ? 1 : 0,
      consecutiveExperiments: 0,
      lastExperiment: null,
      feedbackReleased: seed.initialFeedbackReleased,
      positiveValidationConsumed: false,
      repairCooldownThroughExperiment: null,
      informedHypothesisDigests: [],
    },
    shadowReserved: false,
    regressionCanary: seed.regressionCanary,
    infrastructureValid: seed.infrastructureValid,
    discriminating: seed.discriminating,
  };
}

function prepareCatalog(
  seeds: readonly TrustedHiddenTaskSeed[],
  datasetPin: TerminalBench21Pin,
  taskIdKeyId: string,
  taskIdSecret: Uint8Array,
): PreparedCatalog {
  if (seeds.length !== TERMINAL_BENCH_21_TASK_COUNT) {
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "The trusted import must contain exactly 89 Terminal-Bench 2.1 task seeds.",
    );
  }
  for (const seed of seeds) validateSeed(seed);
  if (
    new Set(seeds.map((seed) => seed.packageTaskName)).size !== seeds.length ||
    new Set(seeds.map((seed) => seed.taskRevisionDigest)).size !== seeds.length
  ) {
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "Trusted task seed names and revisions must each be unique.",
    );
  }

  const sorted = seedCommitmentPayload(seeds);
  const datasetPinHash = canonicalHash(datasetPin);
  const taskIds = new Set<string>();
  const tasks = sorted.map((seed) => {
    const taskId = deriveHiddenTaskId(taskIdSecret, taskIdKeyId, datasetPin, seed);
    if (taskIds.has(taskId)) {
      throw new TrustedHiddenCatalogError(
        "catalog-invalid",
        "The keyed hidden-task namespace contains a collision.",
      );
    }
    taskIds.add(taskId);
    return createStoredTask(seed, taskId, datasetPinHash);
  });

  try {
    const reservation = reserveShadowSlices(tasks, initialValidationQuotaCarry());
    const marked = markShadowReservations(tasks, reservation).map((task) => {
      const original = tasks.find((candidate) => candidate.taskId === task.taskId);
      if (original === undefined) {
        throw new TrustedHiddenCatalogError(
          "catalog-invalid",
          "Trusted shadow reservation failed closed.",
        );
      }
      return {
        ...original,
        shadowReserved: task.shadowReserved,
      };
    });
    const firstIds = reservation.slices[0].tasks.map((task) => task.taskId);
    const secondIds = reservation.slices[1].tasks.map((task) => task.taskId);
    if (
      firstIds.length !== 12 ||
      secondIds.length !== 12 ||
      new Set([...firstIds, ...secondIds]).size !== 24
    ) {
      throw new TrustedHiddenCatalogError(
        "catalog-invalid",
        "Trusted shadow reservation failed closed.",
      );
    }
    return {
      seedSetCommitment: hmacHex(taskIdSecret, {
        domain: "dark-factory/hidden-task-seed-set/v1",
        keyId: taskIdKeyId,
        datasetPin,
        seeds: sorted,
      }),
      tasks: marked,
      shadowSlices: [
        {
          slice: 1,
          taskIds: firstIds,
          selectedBuckets: reservation.slices[0].tasks.map((task) => task.bucket),
          consumed: false,
          consumedByRequestHash: null,
        },
        {
          slice: 2,
          taskIds: secondIds,
          selectedBuckets: reservation.slices[1].tasks.map((task) => task.bucket),
          consumed: false,
          consumedByRequestHash: null,
        },
      ],
      validationCarry: reservation.nextCarry,
    };
  } catch (error) {
    if (error instanceof TrustedHiddenCatalogError) throw error;
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "The trusted catalog cannot reserve its two balanced shadow slices.",
    );
  }
}

function stateCommitmentPayload(
  state: Omit<TrustedHiddenCatalogState, "stateCommitment">,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: state.schemaVersion,
    sensitivity: state.sensitivity,
    revision: state.revision,
    datasetPinHash: state.datasetPinHash,
    registryRevision: state.registryRevision,
    seedSetCommitment: state.seedSetCommitment,
    taskIdKeyId: state.taskIdKeyId,
    dispositionKeyId: state.dispositionKeyId,
    weightingPolicyHash: state.weightingPolicyHash,
    taskOrder: state.taskOrder,
    tasks: state.tasks,
    validationCarry: state.validationCarry,
    repairEpoch: state.repairEpoch,
    shadowSlices: state.shadowSlices,
    allocations: state.allocations,
    outcomeUpdates: state.outcomeUpdates,
  };
}

function signState(
  state: Omit<TrustedHiddenCatalogState, "stateCommitment">,
  dispositionSecret: Uint8Array,
  dispositionKeyId: string,
): TrustedHiddenCatalogState {
  return {
    ...state,
    stateCommitment: hmacHex(dispositionSecret, {
      domain: "dark-factory/hidden-catalog-state/v1",
      keyId: dispositionKeyId,
      state: stateCommitmentPayload(state),
    }),
  };
}

function unsignedState(
  state: TrustedHiddenCatalogState,
): Omit<TrustedHiddenCatalogState, "stateCommitment"> {
  return {
    schemaVersion: state.schemaVersion,
    sensitivity: state.sensitivity,
    revision: state.revision,
    datasetPinHash: state.datasetPinHash,
    registryRevision: state.registryRevision,
    seedSetCommitment: state.seedSetCommitment,
    taskIdKeyId: state.taskIdKeyId,
    dispositionKeyId: state.dispositionKeyId,
    weightingPolicyHash: state.weightingPolicyHash,
    taskOrder: state.taskOrder,
    tasks: state.tasks,
    validationCarry: state.validationCarry,
    repairEpoch: state.repairEpoch,
    shadowSlices: state.shadowSlices,
    allocations: state.allocations,
    outcomeUpdates: state.outcomeUpdates,
  };
}

function nextSignedState(
  state: TrustedHiddenCatalogState,
  changes: Partial<
    Pick<
      TrustedHiddenCatalogState,
      | "tasks"
      | "validationCarry"
      | "repairEpoch"
      | "shadowSlices"
      | "allocations"
      | "outcomeUpdates"
    >
  >,
  dispositionSecret: Uint8Array,
  dispositionKeyId: string,
): TrustedHiddenCatalogState {
  return signState(
    {
      ...unsignedState(state),
      ...changes,
      revision: state.revision + 1,
    },
    dispositionSecret,
    dispositionKeyId,
  );
}

function parseExperimentOrdinal(experimentId: string): number {
  const prefix = experimentId.split("-", 1)[0] ?? "";
  const ordinal = Number.parseInt(prefix, 10);
  if (!/^\d+$/u.test(prefix) || !Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new TrustedHiddenCatalogError(
      "request-invalid",
      "The trusted allocation request has an invalid experiment identity.",
    );
  }
  return ordinal;
}

function claimTokenCommitment(secret: Uint8Array, keyId: string, claimToken: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(claimToken)) {
    throw new TrustedHiddenCatalogError(
      "request-invalid",
      "The trusted allocation claim is malformed.",
    );
  }
  return hmacHex(secret, {
    domain: "dark-factory/hidden-catalog-claim/v1",
    keyId,
    claimToken,
  });
}

function dispositionAttestation(
  secret: Uint8Array,
  keyId: string,
  input: {
    readonly nonce: string;
    readonly datasetPinHash: string;
    readonly requestId: string;
    readonly requestHash: string;
    readonly claimTokenCommitment: string;
    readonly leaseId: string;
    readonly stage: "repair" | "validation" | "shadow";
    readonly sealedAt: string;
    readonly expiresAt: string;
  },
): string {
  return hmacHex(secret, {
    domain: "dark-factory/panel-disposition/v1",
    keyId,
    nonce: input.nonce,
    datasetPinHash: input.datasetPinHash,
    requestId: input.requestId,
    requestHash: input.requestHash,
    claimTokenCommitment: input.claimTokenCommitment,
    leaseId: input.leaseId,
    stage: input.stage,
    sealedAt: input.sealedAt,
    expiresAt: input.expiresAt,
  });
}

function capacityBand(count: number): "0" | "1-2" | "3-5" | "6+" {
  if (count <= 0) return "0";
  if (count <= 2) return "1-2";
  if (count <= 5) return "3-5";
  return "6+";
}

function unitInterval(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function stableEstimate(value: number): number {
  return Math.round(unitInterval(value) * 1_000_000_000_000) / 1_000_000_000_000;
}

function posteriorFailure(prior: number, failureCount: number, observationCount: number): number {
  return stableEstimate(
    (prior * PRIOR_EFFECTIVE_OBSERVATIONS + failureCount) /
      (PRIOR_EFFECTIVE_OBSERVATIONS + observationCount),
  );
}

function deriveAdaptiveEstimates(
  seed: HiddenTaskEstimates,
  stats: TrustedHiddenTaskOutcomeStats,
): HiddenTaskEstimates {
  const totalObservations = stats.candidateObservationCount + stats.championObservationCount;
  const totalFailures = stats.candidateFailureCount + stats.championFailureCount;
  const recentFailureProbability = posteriorFailure(
    seed.recentFailureProbability,
    totalFailures,
    totalObservations,
  );
  const championFailureProbability = posteriorFailure(
    seed.championFailureProbability,
    stats.championFailureCount,
    stats.championObservationCount,
  );
  const empiricalUncertainty = 1 - Math.abs(2 * recentFailureProbability - 1);
  const outcomeUncertainty = stableEstimate(
    (seed.outcomeUncertainty * PRIOR_EFFECTIVE_OBSERVATIONS +
      empiricalUncertainty * totalObservations) /
      (PRIOR_EFFECTIVE_OBSERVATIONS + totalObservations),
  );
  const discrimination = stableEstimate(
    (seed.discrimination * PRIOR_EFFECTIVE_OBSERVATIONS + stats.discriminationSignalSum) /
      (PRIOR_EFFECTIVE_OBSERVATIONS + stats.matchedObservationCount),
  );
  const normalizedCost = stableEstimate(
    (seed.normalizedCost * PRIOR_EFFECTIVE_OBSERVATIONS + stats.normalizedCostSignalSum) /
      (PRIOR_EFFECTIVE_OBSERVATIONS + stats.costObservationCount),
  );
  const underexposure = stableEstimate(
    (seed.underexposure * PRIOR_EFFECTIVE_OBSERVATIONS) /
      (PRIOR_EFFECTIVE_OBSERVATIONS + totalObservations),
  );
  const impossibleEvidenceWeight = unitInterval((totalObservations - 6) / 18);
  const persistentFailureSignal =
    recentFailureProbability * (1 - discrimination) * seed.leaderboardFailureProbability;
  const impossibleProbability = stableEstimate(
    seed.impossibleProbability * (1 - impossibleEvidenceWeight) +
      persistentFailureSignal * impossibleEvidenceWeight,
  );
  return {
    ...seed,
    championFailureProbability,
    recentFailureProbability,
    outcomeUncertainty,
    discrimination,
    underexposure,
    normalizedCost,
    impossibleProbability,
  };
}

function validateOutcomeStats(stats: TrustedHiddenTaskOutcomeStats): void {
  assertExactKeys(stats, OUTCOME_STATS_KEYS);
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
    integerCounts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    stats.candidateFailureCount > stats.candidateObservationCount ||
    stats.championFailureCount > stats.championObservationCount ||
    stats.matchedObservationCount > stats.candidateObservationCount ||
    stats.matchedObservationCount > stats.championObservationCount ||
    stats.costObservationCount !==
      stats.candidateObservationCount + stats.championObservationCount ||
    sums.some((value) => !Number.isFinite(value) || value < 0) ||
    stats.candidateRewardSum > stats.candidateObservationCount ||
    stats.championRewardSum > stats.championObservationCount ||
    stats.discriminationSignalSum > stats.matchedObservationCount ||
    stats.normalizedCostSignalSum > stats.costObservationCount ||
    (stats.lastObservedAt === null
      ? stats.costObservationCount !== 0
      : !Number.isFinite(Date.parse(stats.lastObservedAt)))
  ) {
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "A trusted task outcome accumulator is malformed.",
    );
  }
}

function validateTaskRecord(
  task: TrustedStoredHiddenTask,
  expectedId: HiddenTaskId,
  datasetPin: TerminalBench21Pin,
  taskIdSecret: Uint8Array,
  taskIdKeyId: string,
): void {
  validateEstimates(task.estimates);
  validateEstimates(task.seedEstimates);
  validateOutcomeStats(task.outcomeStats);
  const exposure = task.exposure;
  const taskShapeValid =
    task.sensitivity === "trusted-hidden-task-record" &&
    task.datasetPinHash === canonicalHash(datasetPin) &&
    task.registryRevision === TERMINAL_BENCH_21_REGISTRY_REVISION &&
    task.taskId === expectedId &&
    SAFE_PACKAGE_TASK_NAME.test(task.packageTaskName) &&
    SHA256.test(task.taskRevisionDigest) &&
    SAFE_ID.test(task.capabilityStratum) &&
    SAFE_ID.test(task.difficultyStratum) &&
    task.buckets.length > 0 &&
    new Set(task.buckets).size === task.buckets.length &&
    task.buckets.every((bucket) => BUCKETS.includes(bucket)) &&
    typeof task.shadowReserved === "boolean" &&
    typeof task.regressionCanary === "boolean" &&
    typeof task.infrastructureValid === "boolean" &&
    typeof task.discriminating === "boolean" &&
    Number.isSafeInteger(exposure.total) &&
    exposure.total >= 0 &&
    Number.isSafeInteger(exposure.consecutiveExperiments) &&
    exposure.consecutiveExperiments >= 0 &&
    (exposure.lastExperiment === null ||
      (Number.isSafeInteger(exposure.lastExperiment) && exposure.lastExperiment >= 0)) &&
    typeof exposure.feedbackReleased === "boolean" &&
    typeof exposure.positiveValidationConsumed === "boolean" &&
    (exposure.repairCooldownThroughExperiment === null ||
      (Number.isSafeInteger(exposure.repairCooldownThroughExperiment) &&
        exposure.repairCooldownThroughExperiment >= 0)) &&
    exposure.informedHypothesisDigests.every((digest) => SHA256.test(digest)) &&
    new Set(exposure.informedHypothesisDigests).size === exposure.informedHypothesisDigests.length;
  if (!taskShapeValid) {
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "The durable trusted catalog contains an invalid task record.",
    );
  }
  if (
    canonicalJson(task.estimates) !==
    canonicalJson(deriveAdaptiveEstimates(task.seedEstimates, task.outcomeStats))
  ) {
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "Adaptive task estimates do not reproduce from trusted outcome evidence.",
    );
  }
  const derived = deriveHiddenTaskId(taskIdSecret, taskIdKeyId, datasetPin, task);
  if (derived !== task.taskId) {
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "The durable trusted catalog failed keyed task-identity verification.",
    );
  }
}

function validatePanelRecord(record: TrustedPanelAllocationRecord): void {
  assertExactKeys(record, ALLOCATION_KEYS);
  const panel = record.panel;
  const expectedCount = panel.stage === "repair" ? 5 : 12;
  const taskIds = panel.cells.map((cell) => cell.taskId);
  const repairBucketCounts = Object.fromEntries(
    BUCKETS.map((bucket) => [
      bucket,
      record.selectedBuckets.filter((selected) => selected === bucket).length,
    ]),
  ) as unknown as Readonly<Record<SelectionBucket, number>>;
  let candidateFirst = 0;
  let championFirst = 0;
  if (
    record.sensitivity !== "trusted-hidden-panel-allocation" ||
    !SAFE_ID.test(record.requestId) ||
    !SAFE_ID.test(record.experimentId) ||
    !SHA256.test(record.requestHash) ||
    !SHA256.test(record.datasetPinHash) ||
    record.registryRevision !== TERMINAL_BENCH_21_REGISTRY_REVISION ||
    !SHA256.test(record.protocolHash) ||
    !SHA256.test(record.claimTokenCommitment) ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(record.dispositionNonce) ||
    !SHA256.test(record.frozenHypothesisDigest) ||
    !SHA256.test(record.candidateArchiveSha256) ||
    !SHA256.test(record.championArchiveSha256) ||
    (record.repairSourceExperimentId !== null && !SAFE_ID.test(record.repairSourceExperimentId)) ||
    (record.repairSourceRequestHash !== null && !SHA256.test(record.repairSourceRequestHash)) ||
    (record.repairAttemptOrdinal !== null &&
      record.repairAttemptOrdinal !== 1 &&
      record.repairAttemptOrdinal !== 2) ||
    (panel.stage === "repair"
      ? record.repairSourceExperimentId === null ||
        record.repairSourceRequestHash === null ||
        record.repairAttemptOrdinal === null
      : record.repairSourceExperimentId !== null ||
        record.repairSourceRequestHash !== null ||
        record.repairAttemptOrdinal !== null) ||
    record.selectedBuckets.length !== expectedCount ||
    record.selectedBuckets.some((bucket) => !BUCKETS.includes(bucket)) ||
    (panel.stage === "repair" &&
      (repairBucketCounts.hard !== 3 ||
        repairBucketCounts.uncertain !== 1 ||
        repairBucketCounts.easy + repairBucketCounts.coverage !== 1)) ||
    panel.sensitivity !== "hidden-benchmark-panel" ||
    (panel.stage !== "repair" && panel.stage !== "validation" && panel.stage !== "shadow") ||
    panel.requestId !== record.requestId ||
    !SAFE_ID.test(panel.leaseId) ||
    !SHA256.test(panel.dispositionAttestationHash) ||
    panel.cells.length !== expectedCount ||
    new Set(taskIds).size !== taskIds.length ||
    !Number.isFinite(Date.parse(panel.sealedAt)) ||
    !Number.isFinite(Date.parse(panel.expiresAt)) ||
    Date.parse(panel.expiresAt) <= Date.parse(panel.sealedAt)
  ) {
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "A durable hidden-panel allocation is malformed.",
    );
  }
  for (const cell of panel.cells) {
    if (
      cell.sensitivity !== "hidden-benchmark-cell" ||
      !SHA256.test(cell.taskId) ||
      !SHA256.test(cell.taskRevisionDigest) ||
      !SAFE_ID.test(cell.capabilityStratum) ||
      cell.replicateOrdinal !== 1 ||
      (cell.order !== "AB" && cell.order !== "BA")
    ) {
      throw new TrustedHiddenCatalogError(
        "catalog-invalid",
        "A durable hidden-panel cell is malformed.",
      );
    }
    if (cell.order === "AB") candidateFirst += 1;
    else championFirst += 1;
  }
  if (panel.stage !== "repair" && (candidateFirst !== 6 || championFirst !== 6)) {
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "A durable matched panel is not deterministically order-balanced.",
    );
  }
}

function validateOutcomeCommitment(
  commitment: TrustedHiddenCatalogOutcomeCommitment,
  expectedUpdateId: string,
): void {
  assertExactKeys(commitment, OUTCOME_COMMITMENT_KEYS);
  if (
    commitment.sensitivity !== "trusted-hidden-catalog-outcome-commitment" ||
    commitment.updateId !== expectedUpdateId ||
    !/^catalog-[a-f0-9]{48}$/u.test(commitment.updateId) ||
    !SHA256.test(commitment.requestHash) ||
    !SHA256.test(commitment.sourceBindingHash) ||
    !SHA256.test(commitment.updateSetHash) ||
    !SHA256.test(commitment.signatureHash) ||
    !Number.isFinite(Date.parse(commitment.observedAt)) ||
    !Number.isSafeInteger(commitment.taskCount) ||
    (commitment.taskCount !== 5 && commitment.taskCount !== 12)
  ) {
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "A durable hidden-outcome commitment is malformed.",
    );
  }
}

function assertCatalogState(
  state: TrustedHiddenCatalogState,
  input: {
    readonly datasetPin: TerminalBench21Pin;
    readonly datasetPinHash: string;
    readonly seedSetCommitment: string;
    readonly taskIdKeyId: string;
    readonly dispositionKeyId: string;
    readonly weightingPolicyHash: string;
    readonly secrets: CatalogSecrets;
  },
): void {
  assertExactKeys(state, STATE_KEYS);
  const expectedCommitment = hmacHex(input.secrets.disposition, {
    domain: "dark-factory/hidden-catalog-state/v1",
    keyId: input.dispositionKeyId,
    state: stateCommitmentPayload(unsignedState(state)),
  });
  if (
    state.schemaVersion !== 1 ||
    state.sensitivity !== "trusted-hidden-task-catalog" ||
    !Number.isSafeInteger(state.revision) ||
    state.revision <= 0 ||
    state.datasetPinHash !== input.datasetPinHash ||
    state.registryRevision !== TERMINAL_BENCH_21_REGISTRY_REVISION ||
    state.seedSetCommitment !== input.seedSetCommitment ||
    state.taskIdKeyId !== input.taskIdKeyId ||
    state.dispositionKeyId !== input.dispositionKeyId ||
    state.weightingPolicyHash !== input.weightingPolicyHash ||
    !equalHex(state.stateCommitment, expectedCommitment) ||
    state.revision !==
      Object.keys(state.allocations).length + Object.keys(state.outcomeUpdates).length + 1 ||
    state.taskOrder.length !== TERMINAL_BENCH_21_TASK_COUNT ||
    new Set(state.taskOrder).size !== TERMINAL_BENCH_21_TASK_COUNT ||
    Object.keys(state.tasks).length !== TERMINAL_BENCH_21_TASK_COUNT ||
    !Number.isSafeInteger(state.repairEpoch) ||
    state.repairEpoch < 0 ||
    state.shadowSlices.length !== 2
  ) {
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "The durable trusted catalog failed its immutable metadata check.",
    );
  }

  try {
    allocateValidationQuotas(state.validationCarry);
  } catch {
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "The durable validation quota carry is invalid.",
    );
  }

  for (const taskId of state.taskOrder) {
    const task = state.tasks[taskId];
    if (task === undefined) {
      throw new TrustedHiddenCatalogError(
        "catalog-invalid",
        "The durable trusted catalog task index is incomplete.",
      );
    }
    validateTaskRecord(task, taskId, input.datasetPin, input.secrets.taskId, input.taskIdKeyId);
  }

  const shadowIds = state.shadowSlices.flatMap((slice) => {
    assertExactKeys(slice, SHADOW_SLICE_KEYS);
    if (
      (slice.slice !== 1 && slice.slice !== 2) ||
      slice.taskIds.length !== 12 ||
      slice.selectedBuckets.length !== 12 ||
      slice.selectedBuckets.some((bucket) => !BUCKETS.includes(bucket)) ||
      new Set(slice.taskIds).size !== 12 ||
      typeof slice.consumed !== "boolean" ||
      (slice.consumed
        ? !SHA256.test(slice.consumedByRequestHash ?? "")
        : slice.consumedByRequestHash !== null)
    ) {
      throw new TrustedHiddenCatalogError(
        "catalog-invalid",
        "The durable shadow reservation is invalid.",
      );
    }
    return slice.taskIds;
  });
  const shadowSet = new Set(shadowIds);
  if (
    state.shadowSlices[0].slice !== 1 ||
    state.shadowSlices[1].slice !== 2 ||
    shadowSet.size !== 24 ||
    state.taskOrder.some((taskId) => {
      const task = state.tasks[taskId];
      return task === undefined || task.shadowReserved !== shadowSet.has(taskId);
    })
  ) {
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "The durable shadow slices are not two disjoint pre-reservations.",
    );
  }

  const records = Object.values(state.allocations);
  const requestIds = new Set<string>();
  const claimCommitments = new Set<string>();
  const leaseIds = new Set<string>();
  let repairCount = 0;
  for (const record of records) {
    validatePanelRecord(record);
    if (
      record.datasetPinHash !== input.datasetPinHash ||
      state.allocations[record.requestHash] !== record ||
      requestIds.has(record.requestId) ||
      claimCommitments.has(record.claimTokenCommitment) ||
      leaseIds.has(record.panel.leaseId)
    ) {
      throw new TrustedHiddenCatalogError(
        "catalog-invalid",
        "The durable allocation ledger contains a replay or collision.",
      );
    }
    const expectedDisposition = dispositionAttestation(
      input.secrets.disposition,
      input.dispositionKeyId,
      {
        nonce: record.dispositionNonce,
        datasetPinHash: input.datasetPinHash,
        requestId: record.requestId,
        requestHash: record.requestHash,
        claimTokenCommitment: record.claimTokenCommitment,
        leaseId: record.panel.leaseId,
        stage: record.panel.stage,
        sealedAt: record.panel.sealedAt,
        expiresAt: record.panel.expiresAt,
      },
    );
    if (!equalHex(record.panel.dispositionAttestationHash, expectedDisposition)) {
      throw new TrustedHiddenCatalogError(
        "catalog-invalid",
        "A durable allocation failed its keyed disposition check.",
      );
    }
    for (const [index, cell] of record.panel.cells.entries()) {
      const task = state.tasks[cell.taskId];
      const selectedBucket = record.selectedBuckets[index];
      if (
        task === undefined ||
        task.taskRevisionDigest !== cell.taskRevisionDigest ||
        task.capabilityStratum !== cell.capabilityStratum ||
        selectedBucket === undefined ||
        (record.panel.stage !== "shadow" && !task.buckets.includes(selectedBucket))
      ) {
        throw new TrustedHiddenCatalogError(
          "catalog-invalid",
          "A durable allocation does not correlate to the trusted task catalog.",
        );
      }
    }
    requestIds.add(record.requestId);
    claimCommitments.add(record.claimTokenCommitment);
    leaseIds.add(record.panel.leaseId);
    if (record.panel.stage === "repair") repairCount += 1;
  }
  if (repairCount !== state.repairEpoch) {
    throw new TrustedHiddenCatalogError(
      "catalog-invalid",
      "The durable repair epoch does not match consumptive allocations.",
    );
  }
  for (const slice of state.shadowSlices) {
    const matching = records.filter(
      (record) =>
        record.panel.stage === "shadow" && record.requestHash === slice.consumedByRequestHash,
    );
    if (
      (slice.consumed && matching.length !== 1) ||
      (!slice.consumed && matching.length !== 0) ||
      (matching[0] !== undefined &&
        (matching[0].panel.cells.some((cell, index) => cell.taskId !== slice.taskIds[index]) ||
          matching[0].selectedBuckets.some(
            (bucket, index) => bucket !== slice.selectedBuckets[index],
          )))
    ) {
      throw new TrustedHiddenCatalogError(
        "catalog-invalid",
        "The durable shadow consumption ledger is inconsistent.",
      );
    }
  }
  const committedRequestHashes = new Set<string>();
  for (const [updateId, commitment] of Object.entries(state.outcomeUpdates)) {
    validateOutcomeCommitment(commitment, updateId);
    const allocation = state.allocations[commitment.requestHash];
    if (
      allocation === undefined ||
      commitment.taskCount !== allocation.panel.cells.length ||
      committedRequestHashes.has(commitment.requestHash)
    ) {
      throw new TrustedHiddenCatalogError(
        "catalog-invalid",
        "A hidden-outcome commitment is detached or replayed.",
      );
    }
    committedRequestHashes.add(commitment.requestHash);
  }
  const repairsBySource = new Map<string, TrustedPanelAllocationRecord[]>();
  for (const record of records) {
    if (record.panel.stage !== "repair") continue;
    const sourceHash = record.repairSourceRequestHash;
    const sourceExperimentId = record.repairSourceExperimentId;
    if (sourceHash === null || sourceExperimentId === null) {
      throw new TrustedHiddenCatalogError(
        "catalog-invalid",
        "A repair allocation lost its discovery source.",
      );
    }
    const source = state.allocations[sourceHash];
    const namedSources = records.filter(
      (candidate) =>
        candidate.experimentId === sourceExperimentId && candidate.panel.stage === "validation",
    );
    const sourceIds = new Set(source?.panel.cells.map((cell) => cell.taskId) ?? []);
    if (
      source === undefined ||
      namedSources.length !== 1 ||
      namedSources[0] !== source ||
      source.panel.stage !== "validation" ||
      source.experimentId !== sourceExperimentId ||
      source.protocolHash !== record.protocolHash ||
      source.datasetPinHash !== record.datasetPinHash ||
      parseExperimentOrdinal(source.experimentId) >= parseExperimentOrdinal(record.experimentId) ||
      !committedRequestHashes.has(source.requestHash) ||
      record.championArchiveSha256 !== source.championArchiveSha256 ||
      record.panel.cells.some((cell) => !sourceIds.has(cell.taskId))
    ) {
      throw new TrustedHiddenCatalogError(
        "catalog-invalid",
        "A repair allocation is detached from committed prior validation evidence.",
      );
    }
    repairsBySource.set(sourceHash, [...(repairsBySource.get(sourceHash) ?? []), record]);
  }
  for (const attempts of repairsBySource.values()) {
    attempts.sort(
      (left, right) => (left.repairAttemptOrdinal ?? 0) - (right.repairAttemptOrdinal ?? 0),
    );
    const first = attempts[0];
    const second = attempts[1];
    if (
      attempts.length > 2 ||
      first?.repairAttemptOrdinal !== 1 ||
      (second !== undefined &&
        (second.repairAttemptOrdinal !== 2 ||
          !committedRequestHashes.has(first.requestHash) ||
          second.candidateArchiveSha256 === first.candidateArchiveSha256 ||
          canonicalJson(second.selectedBuckets) !== canonicalJson(first.selectedBuckets) ||
          second.panel.cells.some(
            (cell, index) =>
              cell.taskId !== first.panel.cells[index]?.taskId ||
              cell.taskRevisionDigest !== first.panel.cells[index]?.taskRevisionDigest ||
              cell.capabilityStratum !== first.panel.cells[index]?.capabilityStratum ||
              cell.order !== first.panel.cells[index]?.order,
          )))
    ) {
      throw new TrustedHiddenCatalogError(
        "catalog-invalid",
        "Repair attempts are not a bounded sequential reuse of one hidden panel.",
      );
    }
  }
}

function createInitialState(
  prepared: PreparedCatalog,
  input: {
    readonly datasetPinHash: string;
    readonly taskIdKeyId: string;
    readonly dispositionKeyId: string;
    readonly weightingPolicyHash: string;
    readonly dispositionSecret: Uint8Array;
  },
): TrustedHiddenCatalogState {
  const tasks = Object.fromEntries(prepared.tasks.map((task) => [task.taskId, task]));
  return signState(
    {
      schemaVersion: 1,
      sensitivity: "trusted-hidden-task-catalog",
      revision: 1,
      datasetPinHash: input.datasetPinHash,
      registryRevision: 6,
      seedSetCommitment: prepared.seedSetCommitment,
      taskIdKeyId: input.taskIdKeyId,
      dispositionKeyId: input.dispositionKeyId,
      weightingPolicyHash: input.weightingPolicyHash,
      taskOrder: prepared.tasks.map((task) => task.taskId),
      tasks,
      validationCarry: prepared.validationCarry,
      repairEpoch: 0,
      shadowSlices: prepared.shadowSlices,
      allocations: {},
      outcomeUpdates: {},
    },
    input.dispositionSecret,
    input.dispositionKeyId,
  );
}

function taskList(state: TrustedHiddenCatalogState): readonly TrustedStoredHiddenTask[] {
  return state.taskOrder.map((taskId) => {
    const task = state.tasks[taskId];
    if (task === undefined) {
      throw new TrustedHiddenCatalogError(
        "catalog-invalid",
        "The durable trusted catalog task index is incomplete.",
      );
    }
    return task;
  });
}

function hasCommittedOutcome(state: TrustedHiddenCatalogState, requestHash: string): boolean {
  return Object.values(state.outcomeUpdates).some(
    (commitment) => commitment.requestHash === requestHash,
  );
}

function repairSourceForRequest(
  state: TrustedHiddenCatalogState,
  request: TrustedEvaluationRequest & {
    readonly stage: "repair";
    readonly selection: Extract<
      TrustedEvaluationRequest["selection"],
      { readonly kind: "repair-reuse" }
    >;
  },
  experimentOrdinal: number,
): {
  readonly source: TrustedPanelAllocationRecord;
  readonly priorAttempt: TrustedPanelAllocationRecord | null;
} {
  const sources = Object.values(state.allocations).filter(
    (record) =>
      record.experimentId === request.selection.sourceExperimentId &&
      record.panel.stage === "validation",
  );
  if (
    sources.length !== 1 ||
    parseExperimentOrdinal(request.selection.sourceExperimentId) >= experimentOrdinal
  ) {
    throw new TrustedHiddenCatalogError(
      "request-invalid",
      "Repair must cite one prior fresh-validation discovery allocation.",
    );
  }
  const source = sources[0];
  if (
    source === undefined ||
    source.protocolHash !== request.protocolHash ||
    source.datasetPinHash !== state.datasetPinHash ||
    source.registryRevision !== TERMINAL_BENCH_21_REGISTRY_REVISION ||
    !hasCommittedOutcome(state, source.requestHash) ||
    request.champion === undefined ||
    request.champion.archiveSha256 !== source.championArchiveSha256
  ) {
    throw new TrustedHiddenCatalogError(
      "request-invalid",
      "Repair source evidence is uncommitted or detached from the active champion.",
    );
  }
  const attempts = Object.values(state.allocations)
    .filter(
      (record) =>
        record.panel.stage === "repair" && record.repairSourceRequestHash === source.requestHash,
    )
    .sort((left, right) => (left.repairAttemptOrdinal ?? 0) - (right.repairAttemptOrdinal ?? 0));
  const expectedAttempt = attempts.length + 1;
  if (expectedAttempt > 2 || request.selection.candidateAttempt !== expectedAttempt) {
    throw new TrustedHiddenCatalogError(
      "allocation-exhausted",
      "A discovery panel permits exactly two sequential repair candidates.",
    );
  }
  const priorAttempt = attempts[0] ?? null;
  if (
    request.selection.candidateAttempt === 2 &&
    (priorAttempt === null ||
      priorAttempt.repairAttemptOrdinal !== 1 ||
      !hasCommittedOutcome(state, priorAttempt.requestHash) ||
      request.candidate.archiveSha256 === priorAttempt.candidateArchiveSha256)
  ) {
    throw new TrustedHiddenCatalogError(
      "request-invalid",
      "Second repair requires a committed first screen and a revised candidate.",
    );
  }
  return { source, priorAttempt };
}

function reuseRepairSelection(attempt: TrustedPanelAllocationRecord): HiddenPanelSelection {
  const tasks: HiddenSelectedTask[] = attempt.panel.cells.map((cell, index) => ({
    taskId: cell.taskId,
    bucket: attempt.selectedBuckets[index] ?? "coverage",
    score: 0,
  }));
  return {
    stage: "repair",
    tasks,
    quota: Object.fromEntries(
      BUCKETS.map((bucket) => [bucket, tasks.filter((task) => task.bucket === bucket).length]),
    ) as unknown as Readonly<Record<SelectionBucket, number>>,
    policyVersion: SELECTION_POLICY_VERSION,
  };
}

function selectForRequest(
  state: TrustedHiddenCatalogState,
  request: TrustedEvaluationRequest,
  experimentOrdinal: number,
): SelectedPanel {
  try {
    if (request.stage === "repair") {
      if (request.selection.kind !== "repair-reuse") {
        throw new TrustedHiddenCatalogError(
          "request-invalid",
          "The repair allocation request violates its frozen selection policy.",
        );
      }
      const repairRequest = request as TrustedEvaluationRequest & {
        readonly stage: "repair";
        readonly selection: Extract<
          TrustedEvaluationRequest["selection"],
          { readonly kind: "repair-reuse" }
        >;
      };
      const { source, priorAttempt } = repairSourceForRequest(
        state,
        repairRequest,
        experimentOrdinal,
      );
      const selection =
        priorAttempt === null
          ? selectRepairPanelFromSource(
              source.panel.cells.map((cell) => {
                const task = state.tasks[cell.taskId];
                if (task === undefined) {
                  throw new TrustedHiddenCatalogError(
                    "catalog-invalid",
                    "Repair source references an absent hidden task.",
                  );
                }
                return task;
              }),
              {
                // Attempt two is an exact replay and must not advance the
                // easy/coverage alternation for the next newly selected
                // discovery subset.
                epoch: Object.values(state.allocations).filter(
                  (record) => record.panel.stage === "repair" && record.repairAttemptOrdinal === 1,
                ).length,
                currentExperiment: experimentOrdinal,
                changedComponentRelevance: {},
              },
            )
          : reuseRepairSelection(priorAttempt);
      return {
        selection,
        nextCarry: state.validationCarry,
        shadowSlice: null,
        repairSourceRequestHash: source.requestHash,
      };
    }
    if (request.stage === "validation") {
      if (
        request.selection.kind !== "fresh-matched-validation" ||
        request.selection.weightingPolicyHash !== state.weightingPolicyHash
      ) {
        throw new TrustedHiddenCatalogError(
          "request-invalid",
          "The validation allocation request violates its frozen selection policy.",
        );
      }
      const validationSelection = request.selection;
      const repairTaskIds = new Set(
        taskList(state)
          .filter((task) =>
            task.exposure.informedHypothesisDigests.includes(
              validationSelection.frozenHypothesisHash,
            ),
          )
          .map((task) => task.taskId),
      );
      const hypothesisRepairs = Object.values(state.allocations)
        .filter(
          (record) =>
            record.panel.stage === "repair" &&
            record.frozenHypothesisDigest === validationSelection.frozenHypothesisHash,
        )
        .sort(
          (left, right) =>
            parseExperimentOrdinal(left.experimentId) - parseExperimentOrdinal(right.experimentId),
        );
      const latestRepair = hypothesisRepairs[hypothesisRepairs.length - 1];
      const currentExperimentRepairs = Object.values(state.allocations).filter(
        (record) => record.panel.stage === "repair" && record.experimentId === request.experimentId,
      );
      if (
        hypothesisRepairs.some((record) => !hasCommittedOutcome(state, record.requestHash)) ||
        currentExperimentRepairs.length > 1 ||
        currentExperimentRepairs.some(
          (record) =>
            !hasCommittedOutcome(state, record.requestHash) ||
            record.candidateArchiveSha256 !== request.candidate.archiveSha256 ||
            record.frozenHypothesisDigest !== validationSelection.frozenHypothesisHash,
        ) ||
        (latestRepair !== undefined &&
          latestRepair.candidateArchiveSha256 !== request.candidate.archiveSha256)
      ) {
        throw new TrustedHiddenCatalogError(
          "request-invalid",
          "Fresh validation requires the committed screened candidate frozen for this hypothesis.",
        );
      }
      const selection = selectValidationPanel(taskList(state), {
        frozenHypothesisDigest: validationSelection.frozenHypothesisHash,
        repairTaskIds,
        carry: state.validationCarry,
        currentExperiment: experimentOrdinal,
        changedComponentRelevance: {},
      });
      return {
        selection,
        nextCarry: selection.nextCarry,
        shadowSlice: null,
        repairSourceRequestHash: null,
      };
    }
    if (request.stage === "shadow") {
      if (request.selection.kind !== "fresh-shadow" || request.selection.feedback !== "disabled") {
        throw new TrustedHiddenCatalogError(
          "request-invalid",
          "The shadow allocation request violates feedback-dark policy.",
        );
      }
      const slice = state.shadowSlices[request.selection.shadowSlice - 1];
      if (slice === undefined || slice.slice !== request.selection.shadowSlice || slice.consumed) {
        throw new TrustedHiddenCatalogError(
          "allocation-exhausted",
          "The requested feedback-dark shadow capacity is unavailable.",
        );
      }
      const tasks: HiddenSelectedTask[] = slice.taskIds.map((taskId, index) => ({
        taskId,
        bucket: slice.selectedBuckets[index] ?? "coverage",
        score: 0,
      }));
      return {
        selection: {
          stage: "shadow",
          tasks,
          quota: Object.fromEntries(
            BUCKETS.map((bucket) => [
              bucket,
              tasks.filter((task) => task.bucket === bucket).length,
            ]),
          ) as unknown as Readonly<Record<SelectionBucket, number>>,
          policyVersion: SELECTION_POLICY_VERSION,
        },
        nextCarry: state.validationCarry,
        shadowSlice: slice.slice,
        repairSourceRequestHash: null,
      };
    }
    throw new TrustedHiddenCatalogError(
      "request-invalid",
      "The trusted catalog accepts only adaptive repair, validation, or shadow panels.",
    );
  } catch (error) {
    if (error instanceof TrustedHiddenCatalogError) throw error;
    throw new TrustedHiddenCatalogError(
      "allocation-exhausted",
      "No policy-compliant hidden panel is available for this request.",
    );
  }
}

function buildCells(
  state: TrustedHiddenCatalogState,
  selected: readonly HiddenSelectedTask[],
): readonly TrustedHiddenTaskCell[] {
  return selected.map((item, index) => {
    const task = state.tasks[item.taskId];
    if (task === undefined) {
      throw new TrustedHiddenCatalogError(
        "catalog-invalid",
        "A selected hidden task is absent from the durable catalog.",
      );
    }
    return {
      sensitivity: "hidden-benchmark-cell",
      taskId: task.taskId,
      taskRevisionDigest: task.taskRevisionDigest,
      capabilityStratum: task.capabilityStratum,
      replicateOrdinal: 1,
      order: index % 2 === 0 ? "AB" : "BA",
    };
  });
}

function consumeTasks(
  state: TrustedHiddenCatalogState,
  selection: HiddenPanelSelection,
  stage: "repair" | "validation" | "shadow",
  experimentOrdinal: number,
  frozenHypothesisDigest: string,
): Readonly<Record<string, TrustedStoredHiddenTask>> {
  const selected = new Set(selection.tasks.map((task) => task.taskId));
  return Object.fromEntries(
    state.taskOrder.map((taskId) => {
      const task = state.tasks[taskId];
      if (task === undefined) {
        throw new TrustedHiddenCatalogError(
          "catalog-invalid",
          "The durable trusted catalog task index is incomplete.",
        );
      }
      if (!selected.has(taskId)) return [taskId, task];
      const wasConsecutive = task.exposure.lastExperiment === experimentOrdinal - 1;
      const informed =
        stage === "repair"
          ? [...new Set([...task.exposure.informedHypothesisDigests, frozenHypothesisDigest])]
          : task.exposure.informedHypothesisDigests;
      const next: TrustedStoredHiddenTask = {
        ...task,
        exposure: {
          ...task.exposure,
          total: task.exposure.total + 1,
          consecutiveExperiments: wasConsecutive ? task.exposure.consecutiveExperiments + 1 : 1,
          lastExperiment: experimentOrdinal,
          // Allocation itself consumes freshness. This intentionally errs on
          // the side of assuming feedback may escape after a crash.
          feedbackReleased: stage === "shadow" ? task.exposure.feedbackReleased : true,
          positiveValidationConsumed:
            task.exposure.positiveValidationConsumed ||
            stage === "validation" ||
            stage === "shadow",
          informedHypothesisDigests: informed,
        },
      };
      return [taskId, next];
    }),
  );
}

function markShadowConsumed(
  slices: TrustedHiddenCatalogState["shadowSlices"],
  sliceNumber: 1 | 2 | null,
  requestHash: string,
): TrustedHiddenCatalogState["shadowSlices"] {
  if (sliceNumber === null) return slices;
  return slices.map((slice) =>
    slice.slice === sliceNumber
      ? {
          ...slice,
          consumed: true,
          consumedByRequestHash: requestHash,
        }
      : slice,
  ) as unknown as TrustedHiddenCatalogState["shadowSlices"];
}

type HiddenArmOutcome = TrustedSignedHiddenCatalogOutcomeUpdate["outcomes"][number]["candidate"];

function assertHiddenArmOutcome(outcome: HiddenArmOutcome): void {
  assertExactKeys(outcome, ARM_OUTCOME_KEYS);
  if (
    typeof outcome.pass !== "boolean" ||
    !Number.isFinite(outcome.boundedReward) ||
    outcome.boundedReward < 0 ||
    outcome.boundedReward > 1 ||
    outcome.infrastructureValid !== true ||
    !Number.isSafeInteger(outcome.infrastructureInvalidAttemptCount) ||
    outcome.infrastructureInvalidAttemptCount < 0 ||
    outcome.infrastructureInvalidAttemptCount > 4 ||
    !Number.isSafeInteger(outcome.latencyMs) ||
    outcome.latencyMs < 0 ||
    !Number.isSafeInteger(outcome.inputTokens) ||
    outcome.inputTokens < 0 ||
    !Number.isSafeInteger(outcome.outputTokens) ||
    outcome.outputTokens < 0 ||
    !Number.isFinite(outcome.modelUsd) ||
    outcome.modelUsd < 0 ||
    !Number.isFinite(outcome.sandboxUsd) ||
    outcome.sandboxUsd < 0 ||
    !SHA256.test(outcome.finalAttemptDigest)
  ) {
    throw new TrustedHiddenCatalogError(
      "outcome-invalid",
      "A trusted hidden arm outcome is malformed.",
    );
  }
}

function assertSignedOutcomeUpdate(
  update: TrustedSignedHiddenCatalogOutcomeUpdate,
  allocation: TrustedPanelAllocationRecord,
): void {
  assertExactKeys(update, SIGNED_OUTCOME_UPDATE_KEYS);
  assertExactKeys(update.signature, SIGNATURE_KEYS);
  const expectedTaskCount = allocation.panel.stage === "repair" ? 5 : 12;
  if (
    update.sensitivity !== "trusted-hidden-catalog-outcome-update" ||
    update.schemaVersion !== 1 ||
    update.requestHash !== allocation.requestHash ||
    update.protocolHash !== allocation.protocolHash ||
    update.stage !== allocation.panel.stage ||
    update.dispositionAttestationHash !== allocation.panel.dispositionAttestationHash ||
    !SHA256.test(update.rawManifestHash) ||
    !SHA256.test(update.jobSha256) ||
    !SHA256.test(update.runtimeAttestationHash) ||
    !SHA256.test(update.normalizedOutcomeSetHash) ||
    !SHA256.test(update.environmentFingerprintHash) ||
    !Number.isFinite(Date.parse(update.observedAt)) ||
    Date.parse(update.observedAt) < Date.parse(allocation.panel.sealedAt) ||
    Date.parse(update.observedAt) > Date.parse(allocation.panel.expiresAt) ||
    update.outcomes.length !== expectedTaskCount ||
    update.signature.algorithm !== "ed25519" ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u.test(update.signature.keyId) ||
    !Number.isFinite(Date.parse(update.signature.signedAt)) ||
    Date.parse(update.signature.signedAt) < Date.parse(update.observedAt) ||
    !/^[A-Za-z0-9_-]{86,128}={0,2}$/u.test(update.signature.signature)
  ) {
    throw new TrustedHiddenCatalogError(
      "outcome-invalid",
      "A trusted hidden outcome update is detached or malformed.",
    );
  }

  const attemptDigests = new Set<string>();
  for (const [index, outcome] of update.outcomes.entries()) {
    assertExactKeys(outcome, TASK_OUTCOME_KEYS);
    const cell = allocation.panel.cells[index];
    if (
      cell === undefined ||
      outcome.taskId !== cell.taskId ||
      outcome.taskRevisionDigest !== cell.taskRevisionDigest ||
      outcome.capabilityStratum !== cell.capabilityStratum ||
      outcome.order !== cell.order ||
      (outcome.order !== "AB" && outcome.order !== "BA") ||
      (allocation.panel.stage === "repair" ? outcome.champion !== null : outcome.champion === null)
    ) {
      throw new TrustedHiddenCatalogError(
        "outcome-invalid",
        "Trusted hidden outcomes do not match the presealed panel order.",
      );
    }
    assertHiddenArmOutcome(outcome.candidate);
    if (attemptDigests.has(outcome.candidate.finalAttemptDigest)) {
      throw new TrustedHiddenCatalogError(
        "outcome-invalid",
        "A final hidden arm attempt was replayed.",
      );
    }
    attemptDigests.add(outcome.candidate.finalAttemptDigest);
    if (outcome.champion !== null) {
      assertHiddenArmOutcome(outcome.champion);
      if (attemptDigests.has(outcome.champion.finalAttemptDigest)) {
        throw new TrustedHiddenCatalogError(
          "outcome-invalid",
          "A final hidden arm attempt was replayed.",
        );
      }
      attemptDigests.add(outcome.champion.finalAttemptDigest);
    }
  }

  const expectedUpdateSetHash = canonicalHash({
    domain: "dark-factory.hidden-catalog-outcome-set.v1",
    outcomes: update.outcomes,
  });
  const expectedSourceBindingHash = canonicalHash({
    domain: "dark-factory.hidden-catalog-outcome-source.v1",
    requestHash: update.requestHash,
    protocolHash: update.protocolHash,
    stage: update.stage,
    dispositionAttestationHash: update.dispositionAttestationHash,
    rawManifestHash: update.rawManifestHash,
    jobSha256: update.jobSha256,
    runtimeAttestationHash: update.runtimeAttestationHash,
    normalizedOutcomeSetHash: update.normalizedOutcomeSetHash,
    environmentFingerprintHash: update.environmentFingerprintHash,
    updateSetHash: update.updateSetHash,
  });
  if (
    update.updateSetHash !== expectedUpdateSetHash ||
    update.sourceBindingHash !== expectedSourceBindingHash ||
    update.updateId !== `catalog-${expectedSourceBindingHash.slice(0, 48)}`
  ) {
    throw new TrustedHiddenCatalogError(
      "outcome-invalid",
      "Trusted hidden outcome commitments do not reproduce.",
    );
  }
}

function normalizedArmCostSignal(outcome: HiddenArmOutcome): number {
  const dollars = outcome.modelUsd + outcome.sandboxUsd;
  const tokens = outcome.inputTokens + outcome.outputTokens;
  return stableEstimate(
    0.5 * (dollars / (1 + dollars)) +
      0.3 * (outcome.latencyMs / (600_000 + outcome.latencyMs)) +
      0.2 * (tokens / (100_000 + tokens)),
  );
}

function accumulator(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function applyOutcomeUpdate(
  state: TrustedHiddenCatalogState,
  allocation: TrustedPanelAllocationRecord,
  update: TrustedSignedHiddenCatalogOutcomeUpdate,
): Readonly<Record<string, TrustedStoredHiddenTask>> {
  const experimentOrdinal = parseExperimentOrdinal(allocation.experimentId);
  const updated = new Map<string, TrustedStoredHiddenTask>();
  for (const outcome of update.outcomes) {
    const task = state.tasks[outcome.taskId];
    if (task === undefined) {
      throw new TrustedHiddenCatalogError(
        "outcome-invalid",
        "A trusted outcome references an absent hidden task.",
      );
    }
    const candidateFailure = outcome.candidate.pass ? 0 : 1;
    const championFailure = outcome.champion === null || outcome.champion.pass ? 0 : 1;
    const matchedIncrement = outcome.champion === null ? 0 : 1;
    const costIncrement =
      normalizedArmCostSignal(outcome.candidate) +
      (outcome.champion === null ? 0 : normalizedArmCostSignal(outcome.champion));
    const stats: TrustedHiddenTaskOutcomeStats = {
      candidateObservationCount: task.outcomeStats.candidateObservationCount + 1,
      candidateFailureCount: task.outcomeStats.candidateFailureCount + candidateFailure,
      candidateRewardSum: accumulator(
        task.outcomeStats.candidateRewardSum + outcome.candidate.boundedReward,
      ),
      championObservationCount: task.outcomeStats.championObservationCount + matchedIncrement,
      championFailureCount:
        task.outcomeStats.championFailureCount + (matchedIncrement === 0 ? 0 : championFailure),
      championRewardSum: accumulator(
        task.outcomeStats.championRewardSum + (outcome.champion?.boundedReward ?? 0),
      ),
      matchedObservationCount: task.outcomeStats.matchedObservationCount + matchedIncrement,
      discriminationSignalSum: accumulator(
        task.outcomeStats.discriminationSignalSum +
          (outcome.champion === null
            ? 0
            : Math.abs(outcome.candidate.boundedReward - outcome.champion.boundedReward)),
      ),
      costObservationCount: task.outcomeStats.costObservationCount + 1 + matchedIncrement,
      normalizedCostSignalSum: accumulator(
        task.outcomeStats.normalizedCostSignalSum + costIncrement,
      ),
      lastObservedAt: update.observedAt,
    };
    const candidateDemonstratedSuccess = outcome.candidate.pass;
    const nextTask: TrustedStoredHiddenTask = {
      ...task,
      estimates: deriveAdaptiveEstimates(task.seedEstimates, stats),
      outcomeStats: stats,
      exposure: {
        ...task.exposure,
        repairCooldownThroughExperiment:
          allocation.panel.stage === "shadow" || !candidateDemonstratedSuccess
            ? task.exposure.repairCooldownThroughExperiment
            : Math.max(task.exposure.repairCooldownThroughExperiment ?? 0, experimentOrdinal + 2),
      },
    };
    updated.set(task.taskId, nextTask);
  }
  return Object.fromEntries(
    state.taskOrder.map((taskId) => [taskId, updated.get(taskId) ?? state.tasks[taskId]]),
  ) as Readonly<Record<string, TrustedStoredHiddenTask>>;
}

/**
 * Durable trusted catalog, panel allocator, and Terminal-Bench task resolver.
 *
 * All methods are intended to run in the trusted cloud broker boundary. The
 * only method whose result may cross that boundary is
 * `releaseSafeHealthAttestation`.
 */
export class DurableTrustedHiddenCatalog
  implements TrustedHiddenTaskResolver, TrustedHiddenCatalogOutcomeUpdateSink
{
  readonly #store: LinearizableHiddenCatalogCasStore;
  readonly #datasetPin: TerminalBench21Pin;
  readonly #datasetPinHash: string;
  readonly #taskIdKeyId: string;
  readonly #dispositionKeyId: string;
  readonly #weightingPolicyHash: string;
  readonly #secrets: CatalogSecrets;
  readonly #prepared: PreparedCatalog;
  readonly #now: () => Date;
  readonly #nonceFactory: () => Uint8Array;
  readonly #outcomeVerifier: TrustedHiddenCatalogOutcomeUpdateVerifier;

  constructor(options: DurableTrustedHiddenCatalogOptions) {
    assertTerminalBenchPin(options.datasetPin);
    const datasetPinHash = canonicalHash(options.datasetPin);
    if (
      !SHA256.test(options.expectedDatasetPinHash) ||
      datasetPinHash !== options.expectedDatasetPinHash ||
      options.weightingPolicyHash !== TRUSTED_HIDDEN_SELECTION_POLICY_HASH
    ) {
      throw new TrustedHiddenCatalogError(
        "configuration-invalid",
        "The trusted catalog pin or weighting policy is not the exact configured value.",
      );
    }
    if (typeof options.outcomeVerifier?.verify !== "function") {
      throw new TrustedHiddenCatalogError(
        "configuration-invalid",
        "The trusted catalog requires a hidden-outcome signature verifier.",
      );
    }
    const taskIdSecret = copyAndValidateKey(options.taskIdKey, options.expectedTaskIdKeyId);
    const dispositionSecret = copyAndValidateKey(
      options.dispositionKey,
      options.expectedDispositionKeyId,
    );
    if (
      options.taskIdKey.keyId === options.dispositionKey.keyId ||
      (taskIdSecret.byteLength === dispositionSecret.byteLength &&
        timingSafeEqual(Buffer.from(taskIdSecret), Buffer.from(dispositionSecret)))
    ) {
      throw new TrustedHiddenCatalogError(
        "configuration-invalid",
        "Hidden-task identity and disposition commitments require separated HMAC keys.",
      );
    }
    this.#store = options.store;
    this.#datasetPin = { ...options.datasetPin };
    this.#datasetPinHash = datasetPinHash;
    this.#taskIdKeyId = options.taskIdKey.keyId;
    this.#dispositionKeyId = options.dispositionKey.keyId;
    this.#weightingPolicyHash = options.weightingPolicyHash;
    this.#secrets = {
      taskId: taskIdSecret,
      disposition: dispositionSecret,
    };
    this.#prepared = prepareCatalog(
      options.taskSeeds,
      this.#datasetPin,
      this.#taskIdKeyId,
      this.#secrets.taskId,
    );
    this.#now = options.now ?? (() => new Date());
    this.#nonceFactory = options.nonceFactory ?? (() => randomBytes(32));
    this.#outcomeVerifier = options.outcomeVerifier;
  }

  async initialize(): Promise<ReleaseSafeHiddenCatalogAttestation> {
    const initial = createInitialState(this.#prepared, {
      datasetPinHash: this.#datasetPinHash,
      taskIdKeyId: this.#taskIdKeyId,
      dispositionKeyId: this.#dispositionKeyId,
      weightingPolicyHash: this.#weightingPolicyHash,
      dispositionSecret: this.#secrets.disposition,
    });
    return this.#sanitized(async () =>
      this.#store.transact((state) => {
        if (state === null) {
          return {
            next: initial,
            result: this.#health(initial),
          };
        }
        this.#assertState(state);
        return { next: state, result: this.#health(state) };
      }),
    );
  }

  async allocateAndConsume(
    request: TrustedEvaluationRequest,
    requestHash: string,
    claimToken: string,
  ): Promise<TrustedMatchedPanel> {
    try {
      assertEvaluationRequest(request);
    } catch {
      throw new TrustedHiddenCatalogError(
        "request-invalid",
        "The trusted allocation request failed immutable validation.",
      );
    }
    const stage = request.stage;
    if (
      !SHA256.test(requestHash) ||
      hashEvaluationRequest(request) !== requestHash ||
      (stage !== "repair" && stage !== "validation" && stage !== "shadow")
    ) {
      throw new TrustedHiddenCatalogError(
        "request-invalid",
        "The trusted allocation request does not match its immutable hash or stage.",
      );
    }
    const claimCommitment = claimTokenCommitment(
      this.#secrets.disposition,
      this.#dispositionKeyId,
      claimToken,
    );
    const experimentOrdinal = parseExperimentOrdinal(request.experimentId);

    return this.#sanitized(async () =>
      this.#store.transact((state) => {
        if (state === null) {
          throw new TrustedHiddenCatalogError(
            "catalog-uninitialized",
            "The trusted catalog must be imported before allocation.",
          );
        }
        this.#assertState(state);
        const existing = state.allocations[requestHash];
        if (existing !== undefined) {
          if (
            existing.requestId !== request.requestId ||
            existing.claimTokenCommitment !== claimCommitment
          ) {
            throw new TrustedHiddenCatalogError(
              "allocation-conflict",
              "The immutable allocation request is bound to a different one-use claim.",
            );
          }
          return { next: state, result: existing.panel };
        }
        if (
          Object.values(state.allocations).some(
            (record) =>
              record.requestId === request.requestId ||
              record.claimTokenCommitment === claimCommitment,
          )
        ) {
          throw new TrustedHiddenCatalogError(
            "allocation-conflict",
            "The one-use allocation identity has already been consumed.",
          );
        }
        const now = this.#now();
        if (!Number.isFinite(now.getTime()) || Date.parse(request.deadlineAt) <= now.getTime()) {
          throw new TrustedHiddenCatalogError(
            "request-invalid",
            "The trusted allocation request is expired.",
          );
        }
        const sealedAt = now.toISOString();
        const nonceBytes = this.#nonceFactory();
        if (
          !(nonceBytes instanceof Uint8Array) ||
          nonceBytes.byteLength < 24 ||
          nonceBytes.byteLength > 64
        ) {
          throw new TrustedHiddenCatalogError(
            "configuration-invalid",
            "The trusted disposition nonce source violated policy.",
          );
        }
        const dispositionNonce = Buffer.from(nonceBytes).toString("base64url");
        const leaseId = `lease-${dispositionNonce}`;
        if (Object.values(state.allocations).some((record) => record.panel.leaseId === leaseId)) {
          throw new TrustedHiddenCatalogError(
            "allocation-conflict",
            "The one-use allocation identity has already been consumed.",
          );
        }

        const selected = selectForRequest(state, request, experimentOrdinal);
        const cells = buildCells(state, selected.selection.tasks);
        const disposition = dispositionAttestation(
          this.#secrets.disposition,
          this.#dispositionKeyId,
          {
            nonce: dispositionNonce,
            datasetPinHash: this.#datasetPinHash,
            requestId: request.requestId,
            requestHash,
            claimTokenCommitment: claimCommitment,
            leaseId,
            stage,
            sealedAt,
            expiresAt: request.deadlineAt,
          },
        );
        const panel: TrustedMatchedPanel = {
          sensitivity: "hidden-benchmark-panel",
          leaseId,
          requestId: request.requestId,
          stage,
          sealedAt,
          expiresAt: request.deadlineAt,
          dispositionAttestationHash: disposition,
          cells,
        };
        const record: TrustedPanelAllocationRecord = {
          sensitivity: "trusted-hidden-panel-allocation",
          requestId: request.requestId,
          experimentId: request.experimentId,
          requestHash,
          datasetPinHash: this.#datasetPinHash,
          registryRevision: 6,
          protocolHash: request.protocolHash,
          claimTokenCommitment: claimCommitment,
          dispositionNonce,
          frozenHypothesisDigest:
            request.selection.kind === "repair-reuse" ||
            request.selection.kind === "fresh-matched-validation"
              ? request.selection.frozenHypothesisHash
              : request.candidate.archiveSha256,
          candidateArchiveSha256: request.candidate.archiveSha256,
          championArchiveSha256:
            request.champion?.archiveSha256 ??
            (() => {
              throw new TrustedHiddenCatalogError(
                "request-invalid",
                "Adaptive panel allocation requires a champion artifact.",
              );
            })(),
          repairSourceExperimentId:
            request.selection.kind === "repair-reuse" ? request.selection.sourceExperimentId : null,
          repairSourceRequestHash: selected.repairSourceRequestHash,
          repairAttemptOrdinal:
            request.selection.kind === "repair-reuse" ? request.selection.candidateAttempt : null,
          selectedBuckets: selected.selection.tasks.map((task) => task.bucket),
          panel,
        };
        const tasks = consumeTasks(
          state,
          selected.selection,
          stage,
          experimentOrdinal,
          request.selection.kind === "repair-reuse" ||
            request.selection.kind === "fresh-matched-validation"
            ? request.selection.frozenHypothesisHash
            : request.candidate.archiveSha256,
        );
        const next = nextSignedState(
          state,
          {
            tasks,
            validationCarry: selected.nextCarry,
            repairEpoch: state.repairEpoch + (stage === "repair" ? 1 : 0),
            shadowSlices: markShadowConsumed(state.shadowSlices, selected.shadowSlice, requestHash),
            allocations: {
              ...state.allocations,
              [requestHash]: record,
            },
          },
          this.#secrets.disposition,
          this.#dispositionKeyId,
        );
        this.#assertState(next);
        return { next, result: panel };
      }),
    );
  }

  async commit(
    update: TrustedSignedHiddenCatalogOutcomeUpdate,
  ): Promise<TrustedHiddenCatalogOutcomeCommitReceipt> {
    let signatureValid = false;
    try {
      signatureValid = await this.#outcomeVerifier.verify(update);
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      throw new TrustedHiddenCatalogError(
        "outcome-invalid",
        "The trusted hidden outcome signature failed verification.",
      );
    }

    return this.#sanitized(async () =>
      this.#store.transact<TrustedHiddenCatalogOutcomeCommitReceipt>((state) => {
        if (state === null) {
          throw new TrustedHiddenCatalogError(
            "catalog-uninitialized",
            "The trusted catalog must be imported before outcome ingestion.",
          );
        }
        this.#assertState(state);
        const existing = state.outcomeUpdates[update.updateId];
        if (existing !== undefined) {
          if (existing.sourceBindingHash !== update.sourceBindingHash) {
            throw new TrustedHiddenCatalogError(
              "outcome-conflict",
              "A hidden outcome update identifier has a conflicting source binding.",
            );
          }
          return {
            next: state,
            result: {
              status: "already-committed" as const,
              updateId: existing.updateId,
              sourceBindingHash: existing.sourceBindingHash,
            },
          };
        }
        if (
          Object.values(state.outcomeUpdates).some(
            (commitment) => commitment.requestHash === update.requestHash,
          )
        ) {
          throw new TrustedHiddenCatalogError(
            "outcome-conflict",
            "The hidden panel already has a committed normalized outcome set.",
          );
        }
        const allocation = state.allocations[update.requestHash];
        if (allocation === undefined) {
          throw new TrustedHiddenCatalogError(
            "outcome-invalid",
            "A hidden outcome update has no presealed allocation.",
          );
        }
        assertSignedOutcomeUpdate(update, allocation);
        const tasks = applyOutcomeUpdate(state, allocation, update);
        const commitment: TrustedHiddenCatalogOutcomeCommitment = {
          sensitivity: "trusted-hidden-catalog-outcome-commitment",
          updateId: update.updateId,
          requestHash: update.requestHash,
          sourceBindingHash: update.sourceBindingHash,
          updateSetHash: update.updateSetHash,
          signatureHash: canonicalHash(update.signature),
          observedAt: update.observedAt,
          taskCount: update.outcomes.length,
        };
        const next = nextSignedState(
          state,
          {
            tasks,
            outcomeUpdates: {
              ...state.outcomeUpdates,
              [update.updateId]: commitment,
            },
          },
          this.#secrets.disposition,
          this.#dispositionKeyId,
        );
        this.#assertState(next);
        return {
          next,
          result: {
            status: "committed" as const,
            updateId: update.updateId,
            sourceBindingHash: update.sourceBindingHash,
          },
        };
      }),
    );
  }

  async resolve(
    taskId: HiddenTaskId,
    taskRevisionDigest: string,
  ): Promise<TrustedResolvedHiddenTask> {
    if (!SHA256.test(taskId) || !SHA256.test(taskRevisionDigest)) {
      throw new TrustedHiddenCatalogError(
        "resolution-failed",
        "Trusted hidden-task resolution failed closed.",
      );
    }
    return this.#sanitized(async () =>
      this.#store.transact((state) => {
        if (state === null) {
          throw new TrustedHiddenCatalogError(
            "catalog-uninitialized",
            "The trusted catalog must be imported before resolution.",
          );
        }
        this.#assertState(state);
        const task = state.tasks[taskId];
        if (task === undefined || task.taskRevisionDigest !== taskRevisionDigest) {
          throw new TrustedHiddenCatalogError(
            "resolution-failed",
            "Trusted hidden-task resolution failed closed.",
          );
        }
        return {
          next: state,
          result: {
            sensitivity: "trusted-hidden-task-resolution" as const,
            taskId: task.taskId,
            taskRevisionDigest: task.taskRevisionDigest,
            packageTaskName: task.packageTaskName,
          },
        };
      }),
    );
  }

  async releaseSafeHealthAttestation(): Promise<ReleaseSafeHiddenCatalogAttestation> {
    return this.#sanitized(async () =>
      this.#store.transact((state) => {
        if (state === null) {
          throw new TrustedHiddenCatalogError(
            "catalog-uninitialized",
            "The trusted catalog must be imported before attestation.",
          );
        }
        this.#assertState(state);
        return { next: state, result: this.#health(state) };
      }),
    );
  }

  #assertState(state: TrustedHiddenCatalogState): void {
    assertCatalogState(state, {
      datasetPin: this.#datasetPin,
      datasetPinHash: this.#datasetPinHash,
      seedSetCommitment: this.#prepared.seedSetCommitment,
      taskIdKeyId: this.#taskIdKeyId,
      dispositionKeyId: this.#dispositionKeyId,
      weightingPolicyHash: this.#weightingPolicyHash,
      secrets: this.#secrets,
    });
  }

  #health(state: TrustedHiddenCatalogState): ReleaseSafeHiddenCatalogAttestation {
    const tasks = taskList(state);
    let repairPanelCapacity: "available" | "unavailable" = "unavailable";
    try {
      selectRepairPanel(tasks, {
        epoch: state.repairEpoch,
        currentExperiment: Number.MAX_SAFE_INTEGER,
        changedComponentRelevance: {},
      });
      repairPanelCapacity = "available";
    } catch {
      repairPanelCapacity = "unavailable";
    }
    let validationCapacity = 0;
    try {
      validationCapacity = countFreshValidationPanels(tasks, state.validationCarry);
    } catch {
      validationCapacity = 0;
    }
    const remaining = state.shadowSlices.filter((slice) => !slice.consumed).length;
    if (remaining !== 0 && remaining !== 1 && remaining !== 2) {
      throw new TrustedHiddenCatalogError(
        "catalog-invalid",
        "The trusted shadow capacity is invalid.",
      );
    }
    return {
      sensitivity: "release-safe",
      benchmark: "terminal-bench-2.1",
      datasetPinHash: this.#datasetPinHash,
      taskCount: 89,
      selectionPolicyVersion: SELECTION_POLICY_VERSION,
      catalogIntegrity: "passed",
      repairPanelCapacity,
      freshValidationPanelCapacityBand: capacityBand(validationCapacity),
      shadowReservedSliceCount: 2,
      shadowRemainingSliceCount: remaining,
      containsTaskNames: false,
      containsTaskIdentifiers: false,
      containsPanelHandles: false,
    };
  }

  async #sanitized<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TrustedHiddenCatalogError) throw error;
      throw new TrustedHiddenCatalogError(
        "store-failed",
        "The trusted catalog transaction failed without releasing hidden task material.",
      );
    }
  }
}
