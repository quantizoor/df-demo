import type {
  HiddenPanelSelection,
  HiddenSelectedTask,
  HiddenTaskId,
  HiddenTaskLedgerEntry,
  SelectionBucket,
} from "./types.js";

export const SELECTION_POLICY_VERSION = "failure-weighted-v2";

const BUCKETS = ["hard", "uncertain", "easy", "coverage"] as const;
const TARGET_UNITS: Readonly<Record<SelectionBucket, number>> = {
  hard: 6,
  uncertain: 2,
  easy: 1,
  coverage: 1,
};
const TARGET_DENOMINATOR = 10;

export interface ValidationQuotaCarry {
  readonly hard: number;
  readonly uncertain: number;
  readonly easy: number;
  readonly coverage: number;
}

export interface ValidationQuotaAllocation {
  readonly quota: Readonly<Record<SelectionBucket, number>>;
  readonly nextCarry: ValidationQuotaCarry;
}

export interface HiddenShadowReservation {
  readonly slices: readonly [HiddenPanelSelection, HiddenPanelSelection];
  readonly nextCarry: ValidationQuotaCarry;
}

export interface SelectionContext {
  readonly currentExperiment: number;
  readonly changedComponentRelevance: Readonly<Record<string, number>>;
}

export interface ValidationSelectionContext extends SelectionContext {
  readonly frozenHypothesisDigest: string;
  readonly repairTaskIds: ReadonlySet<HiddenTaskId>;
  readonly carry: ValidationQuotaCarry;
}

export class SelectionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SelectionError";
  }
}

export function initialValidationQuotaCarry(): ValidationQuotaCarry {
  return { hard: 0, uncertain: 0, easy: 0, coverage: 0 };
}

/**
 * Integer carry arithmetic avoids platform-dependent floating point rounding.
 * Carry units are tenths of a task and always sum to zero.
 */
export function allocateValidationQuotas(
  carry: ValidationQuotaCarry,
): ValidationQuotaAllocation {
  validateCarry(carry);
  const idealUnits = Object.fromEntries(
    BUCKETS.map((bucket) => [bucket, 12 * TARGET_UNITS[bucket] + carry[bucket]]),
  ) as Record<SelectionBucket, number>;
  const quota = Object.fromEntries(
    BUCKETS.map((bucket) => [bucket, Math.floor(idealUnits[bucket] / TARGET_DENOMINATOR)]),
  ) as Record<SelectionBucket, number>;

  let remaining = 12 - BUCKETS.reduce((sum, bucket) => sum + quota[bucket], 0);
  const remainderOrder = [...BUCKETS].sort((left, right) => {
    const remainderDelta =
      modulo(idealUnits[right], TARGET_DENOMINATOR) -
      modulo(idealUnits[left], TARGET_DENOMINATOR);
    return remainderDelta === 0 ? BUCKETS.indexOf(left) - BUCKETS.indexOf(right) : remainderDelta;
  });
  for (const bucket of remainderOrder) {
    if (remaining === 0) {
      break;
    }
    quota[bucket] += 1;
    remaining -= 1;
  }
  if (remaining !== 0) {
    throw new SelectionError("Validation quota allocation did not produce twelve slots");
  }

  const nextCarry = Object.fromEntries(
    BUCKETS.map((bucket) => [
      bucket,
      idealUnits[bucket] - quota[bucket] * TARGET_DENOMINATOR,
    ]),
  ) as unknown as ValidationQuotaCarry;
  validateCarry(nextCarry);
  return { quota, nextCarry };
}

export function scoreTask(
  task: HiddenTaskLedgerEntry,
  bucket: SelectionBucket,
  changedComponentRelevance: Readonly<Record<string, number>> = {},
): number {
  const estimate = task.estimates;
  if (
    Object.values(estimate).some(
      (value) => !Number.isFinite(value) || value < 0 || value > 1,
    )
  ) {
    throw new SelectionError("Task estimates must be finite probabilities or normalized scores");
  }
  validateChangedComponentRelevance(changedComponentRelevance);
  const adaptiveComponentRelevance =
    changedComponentRelevance[task.capabilityStratum] ?? estimate.componentRelevance;
  const genericFailureWeight =
    0.25 * estimate.championFailureProbability +
    0.15 * estimate.baselineFailureProbability +
    0.12 * estimate.leaderboardFailureProbability +
    0.18 * estimate.recentFailureProbability;
  const shared =
    0.08 * estimate.discrimination +
    0.07 * adaptiveComponentRelevance +
    0.05 * estimate.underexposure +
    0.04 * estimate.missingCapabilityCoverage -
    0.04 * estimate.normalizedCost -
    0.12 * Math.min(task.exposure.consecutiveExperiments, 3) -
    0.12 * estimate.impossibleProbability;

  const bucketSignal =
    bucket === "hard"
      ? genericFailureWeight
      : bucket === "uncertain"
        ? 0.45 * estimate.outcomeUncertainty + 0.35 * estimate.discrimination
        : bucket === "easy"
          ? 0.35 * (1 - estimate.championFailureProbability) +
            0.2 * (1 - estimate.baselineFailureProbability) +
            0.15 * (1 - estimate.recentFailureProbability)
          : 0.45 * estimate.underexposure + 0.35 * estimate.missingCapabilityCoverage;
  return roundScore(bucketSignal + shared);
}

export function selectRepairPanel(
  tasks: readonly HiddenTaskLedgerEntry[],
  context: SelectionContext & { readonly epoch: number },
): HiddenPanelSelection {
  if (!Number.isSafeInteger(context.epoch) || context.epoch < 0) {
    throw new SelectionError("Repair epoch must be a non-negative safe integer");
  }
  const alternating: SelectionBucket = context.epoch % 2 === 0 ? "easy" : "coverage";
  const quota: Record<SelectionBucket, number> = {
    hard: 3,
    uncertain: 1,
    easy: alternating === "easy" ? 1 : 0,
    coverage: alternating === "coverage" ? 1 : 0,
  };
  const selected = selectByQuota(
    tasks.filter((task) => eligibleForRepair(task, context.currentExperiment)),
    quota,
    context.changedComponentRelevance,
  );
  return {
    stage: "repair",
    tasks: selected,
    quota,
    policyVersion: SELECTION_POLICY_VERSION,
  };
}

export function selectValidationPanel(
  tasks: readonly HiddenTaskLedgerEntry[],
  context: ValidationSelectionContext,
): HiddenPanelSelection & { readonly nextCarry: ValidationQuotaCarry } {
  const allocation = allocateValidationQuotas(context.carry);
  const eligible = tasks.filter(
    (task) =>
      eligibleForValidation(task, context.currentExperiment, context.frozenHypothesisDigest) &&
      !context.repairTaskIds.has(task.taskId),
  );
  const selected = selectByQuota(
    eligible,
    allocation.quota,
    context.changedComponentRelevance,
  );
  return {
    stage: "validation",
    tasks: selected,
    quota: allocation.quota,
    policyVersion: SELECTION_POLICY_VERSION,
    nextCarry: allocation.nextCarry,
  };
}

/**
 * Permanently reserves two disjoint twelve-task shadow slices before any
 * adaptive validation capacity is allocated. The returned task IDs remain
 * broker-private.
 */
export function reserveShadowSlices(
  tasks: readonly HiddenTaskLedgerEntry[],
  carry = initialValidationQuotaCarry(),
): HiddenShadowReservation {
  const first = selectValidationPanel(tasks, {
    frozenHypothesisDigest: "shadow-reservation",
    repairTaskIds: new Set<HiddenTaskId>(),
    carry,
    currentExperiment: 0,
    changedComponentRelevance: {},
  });
  const firstIds = new Set(first.tasks.map((task) => task.taskId));
  const second = selectValidationPanel(tasks, {
    frozenHypothesisDigest: "shadow-reservation",
    repairTaskIds: firstIds,
    carry: first.nextCarry,
    currentExperiment: 0,
    changedComponentRelevance: {},
  });
  return {
    slices: [
      { ...first, stage: "shadow" },
      { ...second, stage: "shadow" },
    ],
    nextCarry: second.nextCarry,
  };
}

export function markShadowReservations(
  tasks: readonly HiddenTaskLedgerEntry[],
  reservation: HiddenShadowReservation,
): readonly HiddenTaskLedgerEntry[] {
  const reserved = new Set(
    reservation.slices.flatMap((slice) => slice.tasks.map((task) => task.taskId)),
  );
  if (reserved.size !== 24) {
    throw new SelectionError("Shadow reservation must contain 24 disjoint tasks");
  }
  return tasks.map((task) =>
    reserved.has(task.taskId) ? { ...task, shadowReserved: true } : task,
  );
}

/**
 * Computes the remaining complete fresh-panel budget without disclosing which
 * tasks occupy those panels. It simulates the same deterministic quotas and
 * stops at the first fail-closed allocation.
 */
export function countFreshValidationPanels(
  tasks: readonly HiddenTaskLedgerEntry[],
  initialCarry = initialValidationQuotaCarry(),
): number {
  let available = [...tasks];
  let carry = initialCarry;
  let count = 0;
  while (available.length >= 12) {
    try {
      const selected = selectValidationPanel(available, {
        frozenHypothesisDigest: "capacity-audit",
        repairTaskIds: new Set<HiddenTaskId>(),
        carry,
        currentExperiment: 0,
        changedComponentRelevance: {},
      });
      const selectedIds = new Set(selected.tasks.map((task) => task.taskId));
      available = available.filter((task) => !selectedIds.has(task.taskId));
      carry = selected.nextCarry;
      count += 1;
    } catch (error) {
      if (error instanceof SelectionError) {
        break;
      }
      throw error;
    }
  }
  return count;
}

export function eligibleForRepair(
  task: HiddenTaskLedgerEntry,
  currentExperiment: number,
): boolean {
  const cooldown = task.exposure.repairCooldownThroughExperiment;
  return (
    task.infrastructureValid &&
    task.exposure.feedbackReleased &&
    !task.shadowReserved &&
    (cooldown === null || currentExperiment > cooldown) &&
    (task.exposure.consecutiveExperiments < 2 || task.regressionCanary)
  );
}

export function eligibleForValidation(
  task: HiddenTaskLedgerEntry,
  currentExperiment: number,
  frozenHypothesisDigest: string,
): boolean {
  return (
    task.infrastructureValid &&
    task.discriminating &&
    !task.shadowReserved &&
    !task.exposure.feedbackReleased &&
    !task.exposure.positiveValidationConsumed &&
    !task.exposure.informedHypothesisDigests.includes(frozenHypothesisDigest) &&
    (task.exposure.consecutiveExperiments < 2 || task.regressionCanary) &&
    currentExperiment >= 0
  );
}

function selectByQuota(
  tasks: readonly HiddenTaskLedgerEntry[],
  quota: Readonly<Record<SelectionBucket, number>>,
  changedComponentRelevance: Readonly<Record<string, number>>,
): readonly HiddenSelectedTask[] {
  const selectedIds = new Set<string>();
  const selected: HiddenSelectedTask[] = [];
  for (const bucket of BUCKETS) {
    const count = quota[bucket];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new SelectionError(`Invalid quota for ${bucket}`);
    }
    const candidates = tasks
      .filter((task) => task.buckets.includes(bucket) && !selectedIds.has(task.taskId))
      .map((task) => ({
        task,
        score: scoreTask(task, bucket, changedComponentRelevance),
      }))
      .sort(compareCandidates);
    if (candidates.length < count) {
      throw new SelectionError(
        `Insufficient hidden tasks for ${bucket}: needed ${count}, found ${candidates.length}`,
      );
    }
    for (const candidate of candidates.slice(0, count)) {
      selectedIds.add(candidate.task.taskId);
      selected.push({
        taskId: candidate.task.taskId,
        bucket,
        score: candidate.score,
      });
    }
  }
  return selected;
}

function validateChangedComponentRelevance(
  changedComponentRelevance: Readonly<Record<string, number>>,
): void {
  for (const [stratum, relevance] of Object.entries(changedComponentRelevance)) {
    if (
      stratum.length === 0 ||
      !Number.isFinite(relevance) ||
      relevance < 0 ||
      relevance > 1
    ) {
      throw new SelectionError(
        "Changed-component relevance must map non-empty capability strata to finite unit-interval values",
      );
    }
  }
}

function compareCandidates(
  left: { readonly task: HiddenTaskLedgerEntry; readonly score: number },
  right: { readonly task: HiddenTaskLedgerEntry; readonly score: number },
): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  const leftLast = left.task.exposure.lastExperiment ?? Number.NEGATIVE_INFINITY;
  const rightLast = right.task.exposure.lastExperiment ?? Number.NEGATIVE_INFINITY;
  if (leftLast !== rightLast) {
    return leftLast - rightLast;
  }
  if (left.task.exposure.total !== right.task.exposure.total) {
    return left.task.exposure.total - right.task.exposure.total;
  }
  return left.task.taskId.localeCompare(right.task.taskId);
}

function validateCarry(carry: ValidationQuotaCarry): void {
  const values = BUCKETS.map((bucket) => carry[bucket]);
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < -9 || value > 9) ||
    values.reduce((sum, value) => sum + value, 0) !== 0
  ) {
    throw new SelectionError("Validation quota carry must be bounded integer tenths summing to zero");
  }
}

function modulo(value: number, denominator: number): number {
  return ((value % denominator) + denominator) % denominator;
}

function roundScore(value: number): number {
  if (!Number.isFinite(value)) {
    throw new SelectionError("Task selection score inputs must be finite");
  }
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}
