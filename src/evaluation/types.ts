/**
 * Types in this module are broker-private unless their name contains
 * `ReleaseSafe`. Hidden task identifiers must never be serialized into the
 * controller's experiment store.
 */

declare const hiddenTaskIdBrand: unique symbol;
declare const hiddenPanelIdBrand: unique symbol;

export type HiddenTaskId = string & { readonly [hiddenTaskIdBrand]: true };
export type HiddenPanelId = string & { readonly [hiddenPanelIdBrand]: true };

export type SelectionBucket = "hard" | "uncertain" | "easy" | "coverage";
export type EvaluationStage = "repair" | "validation" | "shadow";
export type GateDisposition = "pass" | "fail" | "promote" | "reject" | "inconclusive";
export type ArmOrder = "AB" | "BA";

export interface HiddenTaskEstimates {
  readonly championFailureProbability: number;
  readonly baselineFailureProbability: number;
  readonly leaderboardFailureProbability: number;
  /**
   * Smoothed failure probability across the most recent trusted candidate and
   * champion observations. This is broker-private and is never released to the
   * optimizer.
   */
  readonly recentFailureProbability: number;
  readonly outcomeUncertainty: number;
  readonly discrimination: number;
  readonly componentRelevance: number;
  readonly underexposure: number;
  readonly missingCapabilityCoverage: number;
  readonly normalizedCost: number;
  readonly impossibleProbability: number;
}

export interface HiddenTaskExposure {
  readonly total: number;
  readonly consecutiveExperiments: number;
  readonly lastExperiment: number | null;
  readonly feedbackReleased: boolean;
  readonly positiveValidationConsumed: boolean;
  readonly repairCooldownThroughExperiment: number | null;
  readonly informedHypothesisDigests: readonly string[];
}

export interface HiddenTaskLedgerEntry {
  readonly taskId: HiddenTaskId;
  readonly taskRevisionDigest: string;
  readonly capabilityStratum: string;
  readonly difficultyStratum: string;
  readonly buckets: readonly SelectionBucket[];
  readonly estimates: HiddenTaskEstimates;
  readonly exposure: HiddenTaskExposure;
  readonly shadowReserved: boolean;
  readonly regressionCanary: boolean;
  readonly infrastructureValid: boolean;
  readonly discriminating: boolean;
}

export interface HiddenSelectedTask {
  readonly taskId: HiddenTaskId;
  readonly bucket: SelectionBucket;
  readonly score: number;
}

export interface HiddenPanelSelection {
  readonly stage: EvaluationStage;
  readonly tasks: readonly HiddenSelectedTask[];
  readonly quota: Readonly<Record<SelectionBucket, number>>;
  readonly policyVersion: string;
}

export interface ReleaseSafePanelAttestation {
  readonly stage: EvaluationStage;
  readonly taskCount: number;
  readonly quota: Readonly<Record<SelectionBucket, number>>;
  readonly policyVersion: string;
  readonly deterministicSelection: true;
  readonly containsTaskIdentifiers: false;
}

export function hiddenTaskId(digest: string): HiddenTaskId {
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("A hidden task ID must be a lowercase SHA-256 digest");
  }
  return digest as HiddenTaskId;
}

export function hiddenPanelId(digest: string): HiddenPanelId {
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("A hidden panel ID must be a lowercase SHA-256 digest");
  }
  return digest as HiddenPanelId;
}

export function releaseSafePanelAttestation(
  selection: HiddenPanelSelection,
): ReleaseSafePanelAttestation {
  return {
    stage: selection.stage,
    taskCount: selection.tasks.length,
    quota: selection.quota,
    policyVersion: selection.policyVersion,
    deterministicSelection: true,
    containsTaskIdentifiers: false,
  };
}
