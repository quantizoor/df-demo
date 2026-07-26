import { reproduceFreshValidationDisposition } from "../core/validation-decision.js";
import {
  allocateOnlineGate,
  assertOnlineGateAllocation,
  jeffreysPosterior,
  type OnlineErrorBudgetState,
  type OnlineGateAllocation,
  type PairedCategoryCounts,
  summarizePairedDirichletJeffreys,
  summarizeWeightedBetaDifference,
} from "./statistics.js";
import type { ArmOrder, HiddenTaskId, SelectionBucket } from "./types.js";

export const REPAIR_GATE_POLICY_VERSION = "repair-gate-v1";
export const VALIDATION_GATE_POLICY_VERSION = "fresh-paired-validation-v1";

export interface RepairTaskEvidence {
  readonly taskId: HiddenTaskId;
  readonly bucket: SelectionBucket;
  readonly stratum: string;
  readonly candidatePass: boolean;
  readonly candidateObservationFresh: true;
  readonly candidateAttempts: 1;
  readonly championEvidence: {
    readonly source: "fresh" | "cache";
    readonly passes: number;
    readonly failures: number;
    readonly presealedFreshControl: boolean;
  };
  readonly targetBehaviorImproved: boolean;
}

export interface RepairGateInput {
  readonly tasks: readonly RepairTaskEvidence[];
  readonly alternatingBucket: "easy" | "coverage";
  readonly presealedStratumWeights: Readonly<Record<string, number>>;
  readonly integrityVeto: boolean;
  readonly capabilityRegressionVeto: boolean;
  readonly costRegressionVeto: boolean;
  readonly latencyRegressionVeto: boolean;
  readonly aggregateCostUsd: number;
  readonly integrationPoints?: number;
}

export interface HiddenRepairGateResult {
  readonly policyVersion: typeof REPAIR_GATE_POLICY_VERSION;
  readonly disposition: "pass" | "fail" | "inconclusive";
  readonly challengerCreated: boolean;
  readonly nonInferiorityProbability: number;
  readonly evidenceRoute: "confirmed-transition" | "target-behavior" | "none";
  readonly repairHasPositivePromotionWeight: false;
  readonly cacheCanEstablishFailToPass: false;
  readonly containsTaskIdentifiers: false;
}

export interface ReleaseSafeRepairGateResult {
  readonly policyVersion: typeof REPAIR_GATE_POLICY_VERSION;
  readonly disposition: "pass" | "fail" | "inconclusive";
  readonly integrityStatus: "pass" | "fail";
  readonly aggregateCostUsd: number;
  readonly diagnosticEvidenceReleased: false;
  readonly containsTaskIdentifiers: false;
}

export interface FreshValidationArm {
  readonly pass: boolean;
  readonly fresh: true;
  readonly cacheUsed: false;
  readonly protocolHash: string;
  readonly environmentFingerprintHash: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface FreshValidationPair {
  readonly taskId: HiddenTaskId;
  readonly stratum: string;
  readonly order: ArmOrder;
  readonly candidate: FreshValidationArm;
  readonly champion: FreshValidationArm;
}

export interface FreshValidationInput {
  readonly pairs: readonly FreshValidationPair[];
  readonly presealedStratumWeights: Readonly<Record<string, number>>;
  readonly expectedProtocolHash: string;
  readonly candidateFrozenAt: string;
  readonly panelSealedAt: string;
  readonly integrityVeto: boolean;
  readonly correctnessVeto: boolean;
  readonly capabilityRegressionVeto: boolean;
  readonly costWithinGuardrail: boolean;
  readonly latencyWithinGuardrail: boolean;
  readonly accuracyTradeoffPredeclared: boolean;
  readonly onlineErrorBudget: OnlineErrorBudgetState;
  /**
   * Trusted evaluators supply the pre-outcome durable reservation. Pure
   * statistical callers may omit it and allocate directly from the state.
   */
  readonly reservedOnlineGate?: OnlineGateAllocation;
  readonly integrationPoints?: number;
}

export interface ReleaseSafeFreshValidationResult {
  readonly policyVersion: typeof VALIDATION_GATE_POLICY_VERSION;
  readonly disposition: "promote" | "reject" | "inconclusive";
  readonly panelConsumed: true;
  readonly validPairCount: 12;
  readonly freshArmCount: 24;
  readonly cacheArmCount: 0;
  readonly probabilityAccuracyDeltaPositive: number;
  readonly posteriorMedianAccuracyDelta: number;
  readonly interval95: readonly [number, number];
  readonly requiredPosteriorProbability: number;
  readonly onlineGateAuthorized: boolean;
  readonly onlineGateAlphaSpent: number;
  readonly stratumRegressionVeto: boolean;
  readonly onlineErrorBudgetAfter: OnlineErrorBudgetState;
  readonly repairCacheHistoryPositiveWeight: 0;
  readonly containsTaskIdentifiers: false;
}

export interface ShadowCertificationInput extends FreshValidationInput {
  readonly aggregateCostUsd: number;
  readonly complianceFlagsPassed: boolean;
}

export interface ReleaseSafeShadowCertificationResult {
  readonly policyVersion: "feedback-dark-shadow-v1";
  readonly disposition: "certified" | "not-certified" | "inconclusive";
  readonly panelConsumed: true;
  readonly complianceFlagsPassed: boolean;
  readonly aggregateCostUsd: number;
  readonly scoreReleased: false;
  readonly diagnosticsReleased: false;
  readonly containsTaskIdentifiers: false;
}

export interface EvaluationAttemptAccounting {
  readonly repairCandidateValidArms: number;
  readonly repairChampionFreshValidArms: number;
  readonly validationFreshValidArms: number;
  readonly infrastructureReplacementAttempts: number;
}

export interface ReleaseSafeAttemptBudgetResult {
  readonly withinBudget: boolean;
  readonly validArmBand: "24" | "25-29" | "30-34" | "outside-budget";
  readonly replacementBand: "0" | "1-2" | "3-4" | "outside-budget";
  readonly hardMaximumAttempts: 38;
  readonly containsPerTaskAccounting: false;
}

export function evaluateRepairGate(input: RepairGateInput): HiddenRepairGateResult {
  if (!Number.isFinite(input.aggregateCostUsd) || input.aggregateCostUsd < 0) {
    throw new Error("Repair aggregate cost must be finite and non-negative");
  }
  validateRepairPanel(input.tasks, input.alternatingBucket);
  const strata = groupByStratum(input.tasks);
  validateStratumWeights(strata.keys(), input.presealedStratumWeights);
  const terms = [...strata.entries()].flatMap(([stratum, tasks]) => {
    const stratumWeight = input.presealedStratumWeights[stratum];
    if (stratumWeight === undefined) {
      throw new Error("Missing preregistered repair stratum weight");
    }
    return tasks.map((task) => ({
      candidate: jeffreysPosterior(task.candidatePass ? 1 : 0, task.candidatePass ? 0 : 1),
      champion: jeffreysPosterior(task.championEvidence.passes, task.championEvidence.failures),
      weight: stratumWeight / tasks.length,
    }));
  });
  const posterior = summarizeWeightedBetaDifference(terms, -0.1, input.integrationPoints);
  const nonInferiorityProbability = posterior.probabilityGreaterThanThreshold;
  const hardVeto =
    input.integrityVeto ||
    input.capabilityRegressionVeto ||
    input.costRegressionVeto ||
    input.latencyRegressionVeto;
  const confirmedTransition = input.tasks.some(
    (task) =>
      task.candidatePass &&
      task.championEvidence.source === "fresh" &&
      task.championEvidence.presealedFreshControl &&
      task.championEvidence.passes === 0 &&
      task.championEvidence.failures === 1,
  );
  const behaviorImprovementCount = input.tasks.filter((task) => task.targetBehaviorImproved).length;
  const evidenceRoute = confirmedTransition
    ? "confirmed-transition"
    : behaviorImprovementCount >= 3
      ? "target-behavior"
      : "none";

  let disposition: HiddenRepairGateResult["disposition"];
  if (hardVeto || nonInferiorityProbability <= 0.05 || evidenceRoute === "none") {
    disposition = "fail";
  } else if (nonInferiorityProbability >= 0.8) {
    disposition = "pass";
  } else {
    disposition = "inconclusive";
  }
  return {
    policyVersion: REPAIR_GATE_POLICY_VERSION,
    disposition,
    challengerCreated: disposition === "pass",
    nonInferiorityProbability,
    evidenceRoute,
    repairHasPositivePromotionWeight: false,
    cacheCanEstablishFailToPass: false,
    containsTaskIdentifiers: false,
  };
}

export function makeReleaseSafeRepairGateResult(
  hidden: HiddenRepairGateResult,
  input: Pick<RepairGateInput, "integrityVeto" | "aggregateCostUsd">,
): ReleaseSafeRepairGateResult {
  return {
    policyVersion: hidden.policyVersion,
    disposition: hidden.disposition,
    integrityStatus: input.integrityVeto ? "fail" : "pass",
    aggregateCostUsd: input.aggregateCostUsd,
    diagnosticEvidenceReleased: false,
    containsTaskIdentifiers: false,
  };
}

export function evaluateFreshValidation(
  input: FreshValidationInput,
): ReleaseSafeFreshValidationResult {
  validateFreshValidation(input);
  const groups = groupByStratum(input.pairs);
  validateStratumWeights(groups.keys(), input.presealedStratumWeights);
  const weightedStrata = [...groups.entries()].map(([stratum, pairs]) => {
    const weight = input.presealedStratumWeights[stratum];
    if (weight === undefined) {
      throw new Error("Missing preregistered validation stratum weight");
    }
    return { counts: pairedCounts(pairs), weight };
  });
  const posterior = summarizePairedDirichletJeffreys(weightedStrata, 0, input.integrationPoints);
  const onlineGate = input.reservedOnlineGate ?? allocateOnlineGate(input.onlineErrorBudget);
  assertOnlineGateAllocation(input.onlineErrorBudget, onlineGate);
  const noStratumRegression = posterior.stratumProbabilityBelowMinusPointOne.every(
    (probability) => probability <= 0.8,
  );
  const disposition = reproduceFreshValidationDisposition({
    probabilityPositive: posterior.probabilityGreaterThanThreshold,
    medianAccuracyDelta: posterior.median,
    requiredPosteriorProbability: onlineGate.requiredPosteriorProbability,
    onlineGateAuthorized: onlineGate.authorized,
    stratumRegressionVeto: !noStratumRegression,
    integrityVeto: input.integrityVeto,
    correctnessVeto: input.correctnessVeto,
    capabilityVeto: input.capabilityRegressionVeto,
    costWithinGuardrail: input.costWithinGuardrail,
    latencyWithinGuardrail: input.latencyWithinGuardrail,
    accuracyTradeoffPredeclared: input.accuracyTradeoffPredeclared,
  });

  return {
    policyVersion: VALIDATION_GATE_POLICY_VERSION,
    disposition,
    panelConsumed: true,
    validPairCount: 12,
    freshArmCount: 24,
    cacheArmCount: 0,
    probabilityAccuracyDeltaPositive: posterior.probabilityGreaterThanThreshold,
    posteriorMedianAccuracyDelta: posterior.median,
    interval95: [posterior.interval95.lower, posterior.interval95.upper],
    requiredPosteriorProbability: onlineGate.requiredPosteriorProbability,
    onlineGateAuthorized: onlineGate.authorized,
    onlineGateAlphaSpent: onlineGate.alphaSpent,
    stratumRegressionVeto: !noStratumRegression,
    onlineErrorBudgetAfter: onlineGate.nextState,
    repairCacheHistoryPositiveWeight: 0,
    containsTaskIdentifiers: false,
  };
}

/**
 * Runs the same fresh-pair gate inside the trusted zone, then deliberately
 * collapses the result to the only shadow information Claude may receive.
 */
export function evaluateShadowCertification(
  input: ShadowCertificationInput,
): ReleaseSafeShadowCertificationResult {
  if (!Number.isFinite(input.aggregateCostUsd) || input.aggregateCostUsd < 0) {
    throw new Error("Shadow aggregate cost must be finite and non-negative");
  }
  const validation = evaluateFreshValidation({
    ...input,
    integrityVeto: input.integrityVeto || !input.complianceFlagsPassed,
  });
  return {
    policyVersion: "feedback-dark-shadow-v1",
    disposition:
      validation.disposition === "promote"
        ? "certified"
        : validation.disposition === "reject"
          ? "not-certified"
          : "inconclusive",
    panelConsumed: true,
    complianceFlagsPassed: input.complianceFlagsPassed,
    aggregateCostUsd: input.aggregateCostUsd,
    scoreReleased: false,
    diagnosticsReleased: false,
    containsTaskIdentifiers: false,
  };
}

export function validateExperimentAttemptBudget(
  accounting: EvaluationAttemptAccounting,
): ReleaseSafeAttemptBudgetResult {
  for (const [field, value] of Object.entries(accounting)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Attempt accounting field ${field} must be a non-negative integer`);
    }
  }
  const validArms =
    accounting.repairCandidateValidArms +
    accounting.repairChampionFreshValidArms +
    accounting.validationFreshValidArms;
  const total = validArms + accounting.infrastructureReplacementAttempts;
  const withinBudget =
    accounting.repairCandidateValidArms === 5 &&
    accounting.repairChampionFreshValidArms <= 5 &&
    accounting.validationFreshValidArms === 24 &&
    accounting.infrastructureReplacementAttempts <= 4 &&
    validArms <= 34 &&
    total <= 38;
  return {
    withinBudget,
    validArmBand:
      validArms === 24
        ? "24"
        : validArms >= 25 && validArms <= 29
          ? "25-29"
          : validArms >= 30 && validArms <= 34
            ? "30-34"
            : "outside-budget",
    replacementBand:
      accounting.infrastructureReplacementAttempts === 0
        ? "0"
        : accounting.infrastructureReplacementAttempts <= 2
          ? "1-2"
          : accounting.infrastructureReplacementAttempts <= 4
            ? "3-4"
            : "outside-budget",
    hardMaximumAttempts: 38,
    containsPerTaskAccounting: false,
  };
}

export function validateShadowAttemptBudget(input: {
  readonly freshValidArms: number;
  readonly infrastructureReplacementAttempts: number;
}): boolean {
  return (
    Number.isSafeInteger(input.freshValidArms) &&
    Number.isSafeInteger(input.infrastructureReplacementAttempts) &&
    input.freshValidArms === 24 &&
    input.infrastructureReplacementAttempts >= 0 &&
    input.infrastructureReplacementAttempts <= 4 &&
    input.freshValidArms + input.infrastructureReplacementAttempts <= 28
  );
}

function validateRepairPanel(
  tasks: readonly RepairTaskEvidence[],
  alternatingBucket: "easy" | "coverage",
): void {
  if (tasks.length !== 5 || new Set(tasks.map((task) => task.taskId)).size !== 5) {
    throw new Error("Repair requires exactly five distinct hidden tasks");
  }
  const bucketCounts = countBuckets(tasks);
  if (
    bucketCounts.hard !== 3 ||
    bucketCounts.uncertain !== 1 ||
    bucketCounts[alternatingBucket] !== 1 ||
    bucketCounts[alternatingBucket === "easy" ? "coverage" : "easy"] !== 0
  ) {
    throw new Error("Repair panel must be 3 hard, 1 uncertain, and 1 alternating task");
  }
  tasks.forEach((task) => {
    if (
      !task.candidateObservationFresh ||
      task.candidateAttempts !== 1 ||
      !Number.isSafeInteger(task.championEvidence.passes) ||
      task.championEvidence.passes < 0 ||
      !Number.isSafeInteger(task.championEvidence.failures) ||
      task.championEvidence.failures < 0 ||
      task.championEvidence.passes + task.championEvidence.failures < 1 ||
      (task.championEvidence.source === "fresh" &&
        task.championEvidence.passes + task.championEvidence.failures !== 1) ||
      (task.championEvidence.source === "cache" && task.championEvidence.presealedFreshControl)
    ) {
      throw new Error("Invalid repair evidence");
    }
  });
}

function validateFreshValidation(input: FreshValidationInput): void {
  if (input.pairs.length !== 12 || new Set(input.pairs.map((pair) => pair.taskId)).size !== 12) {
    throw new Error("Validation requires exactly twelve distinct fresh pairs");
  }
  const orderA = input.pairs.filter((pair) => pair.order === "AB").length;
  if (orderA !== 6 || input.pairs.length - orderA !== 6) {
    throw new Error("Validation arm order must be balanced six AB and six BA");
  }
  const candidateFrozenAt = Date.parse(input.candidateFrozenAt);
  const panelSealedAt = Date.parse(input.panelSealedAt);
  if (
    !Number.isFinite(candidateFrozenAt) ||
    !Number.isFinite(panelSealedAt) ||
    candidateFrozenAt > panelSealedAt
  ) {
    throw new Error("Candidate must be frozen before panel sealing");
  }
  const allStartTimes: number[] = [];
  const environmentFingerprints = new Set<string>();
  for (const pair of input.pairs) {
    const candidateStarted = validateArm(pair.candidate, input.expectedProtocolHash);
    const championStarted = validateArm(pair.champion, input.expectedProtocolHash);
    if (
      candidateStarted < panelSealedAt ||
      championStarted < panelSealedAt ||
      pair.candidate.environmentFingerprintHash !== pair.champion.environmentFingerprintHash ||
      Math.abs(candidateStarted - championStarted) > 24 * 60 * 60 * 1000
    ) {
      throw new Error("Fresh pair violates sealing, environment, or 24-hour matching");
    }
    if (
      (pair.order === "AB" && candidateStarted > championStarted) ||
      (pair.order === "BA" && championStarted > candidateStarted)
    ) {
      throw new Error("Observed validation arm order differs from the presealed order");
    }
    allStartTimes.push(candidateStarted, championStarted);
    environmentFingerprints.add(pair.candidate.environmentFingerprintHash);
  }
  const earliestStart = Math.min(...allStartTimes);
  const latestStart = Math.max(...allStartTimes);
  if (environmentFingerprints.size !== 1 || latestStart - earliestStart > 24 * 60 * 60 * 1000) {
    throw new Error("Validation panel must use one environment cohort inside 24 hours");
  }
  if (new Set(input.pairs.map((pair) => pair.stratum)).size < 2) {
    throw new Error("Validation requires at least two strata");
  }
}

function validateArm(arm: FreshValidationArm, protocolHash: string): number {
  const started = Date.parse(arm.startedAt);
  const completed = Date.parse(arm.completedAt);
  if (
    !arm.fresh ||
    arm.cacheUsed ||
    arm.protocolHash !== protocolHash ||
    arm.environmentFingerprintHash.length === 0 ||
    !Number.isFinite(started) ||
    !Number.isFinite(completed) ||
    completed < started
  ) {
    throw new Error("Validation arms must be fresh, valid, and protocol-matched");
  }
  return started;
}

function pairedCounts(pairs: readonly FreshValidationPair[]): PairedCategoryCounts {
  const counts: PairedCategoryCounts = {
    bothPass: 0,
    challengerOnlyPass: 0,
    championOnlyPass: 0,
    bothFail: 0,
  };
  const mutable = { ...counts };
  pairs.forEach((pair) => {
    if (pair.candidate.pass && pair.champion.pass) {
      mutable.bothPass += 1;
    } else if (pair.candidate.pass) {
      mutable.challengerOnlyPass += 1;
    } else if (pair.champion.pass) {
      mutable.championOnlyPass += 1;
    } else {
      mutable.bothFail += 1;
    }
  });
  return mutable;
}

function groupByStratum<T extends { readonly stratum: string }>(
  values: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  values.forEach((value) => {
    const group = groups.get(value.stratum) ?? [];
    group.push(value);
    groups.set(value.stratum, group);
  });
  return groups;
}

function validateStratumWeights(
  strata: Iterable<string>,
  weights: Readonly<Record<string, number>>,
): void {
  const names = [...strata].sort();
  const weightNames = Object.keys(weights).sort();
  if (
    names.length === 0 ||
    names.join("\u0000") !== weightNames.join("\u0000") ||
    names.some((name) => {
      const weight = weights[name];
      return weight === undefined || !Number.isFinite(weight) || weight <= 0;
    }) ||
    Math.abs(
      names.reduce((sum, name) => {
        const weight = weights[name];
        return sum + (weight ?? 0);
      }, 0) - 1,
    ) > 1e-9
  ) {
    throw new Error("Presealed stratum weights must exactly cover strata and sum to one");
  }
}

function countBuckets(tasks: readonly RepairTaskEvidence[]): Record<SelectionBucket, number> {
  return tasks.reduce<Record<SelectionBucket, number>>(
    (counts, task) => ({ ...counts, [task.bucket]: counts[task.bucket] + 1 }),
    { hard: 0, uncertain: 0, easy: 0, coverage: 0 },
  );
}
