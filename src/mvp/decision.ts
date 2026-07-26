import {
  type HiddenEvaluationCell,
  MVP_CELL_COUNT,
  MVP_DECISION_POLICY,
  MVP_REPETITIONS_PER_TASK,
  MVP_SCHEMA_VERSION,
  MVP_TASK_COUNT,
  type PrivateEvaluationObservation,
  type ReleaseSafeDecision,
} from "./contracts.js";

export interface MatchedDecisionInput {
  readonly cells: readonly HiddenEvaluationCell[];
  readonly candidate: readonly PrivateEvaluationObservation[];
  readonly champion: readonly PrivateEvaluationObservation[];
  readonly requiredConfidence?: number;
  readonly minimumAggregateDelta?: number;
  readonly taskTieTolerance?: number;
}

export function decideMatchedComparison(input: MatchedDecisionInput): ReleaseSafeDecision {
  const requiredConfidence = input.requiredConfidence ?? 0.95;
  const minimumAggregateDelta = input.minimumAggregateDelta ?? 0.05;
  const taskTieTolerance = input.taskTieTolerance ?? 0.01;
  validateThreshold(requiredConfidence, "Required confidence", true);
  validateThreshold(minimumAggregateDelta, "Minimum aggregate delta", false);
  validateThreshold(taskTieTolerance, "Task tie tolerance", false);
  validateMatchedEvidence(input);

  const candidateByCell = new Map(
    input.candidate.map((observation) => [observation.cellId, observation]),
  );
  const championByCell = new Map(
    input.champion.map((observation) => [observation.cellId, observation]),
  );
  const taskDeltas = input.cells
    .filter((cell) => cell.repetition === 1)
    .map((firstCell) => {
      const taskCells = input.cells.filter(
        (cell) => cell.task.handle === firstCell.task.handle,
      );
      return (
        mean(
          taskCells.map((cell) => requiredObservation(candidateByCell, cell.cellId).reward),
        ) -
        mean(
          taskCells.map((cell) => requiredObservation(championByCell, cell.cellId).reward),
        )
      );
    });

  const taskWins = taskDeltas.filter((delta) => delta > taskTieTolerance).length;
  const taskLosses = taskDeltas.filter((delta) => delta < -taskTieTolerance).length;
  const taskTies = MVP_TASK_COUNT - taskWins - taskLosses;
  const candidateMeanReward = mean(input.candidate.map((observation) => observation.reward));
  const championMeanReward = mean(input.champion.map((observation) => observation.reward));
  const meanRewardDelta = candidateMeanReward - championMeanReward;
  const confidenceCandidateBetter = directionalConfidence(taskWins, taskLosses);
  const confidenceChampionBetter = directionalConfidence(taskLosses, taskWins);
  const evidenceFresh =
    input.candidate.every((observation) => observation.source === "fresh") &&
    input.champion.every((observation) => observation.source === "fresh");
  const completeAndValid =
    input.candidate.every((observation) => observation.infrastructureValid) &&
    input.champion.every((observation) => observation.infrastructureValid);

  let disposition: ReleaseSafeDecision["disposition"] = "inconclusive";
  let reason: ReleaseSafeDecision["reason"];
  if (!completeAndValid) {
    reason = "incomplete-or-invalid-evidence";
  } else if (
    meanRewardDelta >= minimumAggregateDelta &&
    taskWins > taskLosses &&
    confidenceCandidateBetter >= requiredConfidence
  ) {
    if (evidenceFresh) {
      disposition = "promote";
      reason = "candidate-superior";
    } else {
      reason = "fresh-evidence-required";
    }
  } else if (
    meanRewardDelta <= -minimumAggregateDelta &&
    taskLosses > taskWins &&
    confidenceChampionBetter >= requiredConfidence
  ) {
    disposition = "reject";
    reason = "candidate-inferior";
  } else if (Math.abs(meanRewardDelta) < minimumAggregateDelta) {
    reason = "aggregate-effect-too-small";
  } else {
    reason = "insufficient-confidence";
  }

  return {
    schemaVersion: MVP_SCHEMA_VERSION,
    policyVersion: MVP_DECISION_POLICY,
    disposition,
    reason,
    evidenceFresh,
    matchedTaskCount: MVP_TASK_COUNT,
    repetitionsPerTask: MVP_REPETITIONS_PER_TASK,
    candidateObservationCount: MVP_CELL_COUNT,
    championObservationCount: MVP_CELL_COUNT,
    candidateMeanReward: rounded(candidateMeanReward),
    championMeanReward: rounded(championMeanReward),
    meanRewardDelta: rounded(meanRewardDelta),
    taskWins,
    taskLosses,
    taskTies,
    confidenceMethod: "exact-one-sided-cluster-sign-v1",
    confidenceCandidateBetter: rounded(confidenceCandidateBetter),
    confidenceChampionBetter: rounded(confidenceChampionBetter),
    requiredConfidence,
    minimumAggregateDelta,
    containsTaskIdentifiers: false,
    containsPerTaskOutcomes: false,
  };
}

function validateMatchedEvidence(input: MatchedDecisionInput): void {
  if (
    input.cells.length !== MVP_CELL_COUNT ||
    input.candidate.length !== MVP_CELL_COUNT ||
    input.champion.length !== MVP_CELL_COUNT
  ) {
    throw new Error("A decision requires exactly fifteen cells and fifteen observations per arm");
  }
  const cellIds = input.cells.map((cell) => cell.cellId);
  if (new Set(cellIds).size !== MVP_CELL_COUNT) {
    throw new Error("Matched cell IDs must be unique");
  }
  const taskHandles = new Set(input.cells.map((cell) => cell.task.handle));
  if (taskHandles.size !== MVP_TASK_COUNT) {
    throw new Error("Matched evidence must cover exactly five distinct hidden tasks");
  }
  for (const handle of taskHandles) {
    if (input.cells.filter((cell) => cell.task.handle === handle).length !== 3) {
      throw new Error("Each hidden task must have exactly three repetitions");
    }
  }

  const expectedCells = new Map(input.cells.map((cell) => [cell.cellId, cell]));
  validateArm(input.candidate, "candidate", expectedCells);
  validateArm(input.champion, "champion", expectedCells);
}

function validateArm(
  observations: readonly PrivateEvaluationObservation[],
  expectedArm: "candidate" | "champion",
  expectedCells: ReadonlyMap<string, HiddenEvaluationCell>,
): void {
  if (new Set(observations.map((observation) => observation.cellId)).size !== MVP_CELL_COUNT) {
    throw new Error(`${expectedArm} observations contain duplicate matched cells`);
  }
  for (const observation of observations) {
    const cell = expectedCells.get(observation.cellId);
    if (cell === undefined) {
      throw new Error(`${expectedArm} observation is outside the selected matched panel`);
    }
    if (
      observation.arm !== expectedArm ||
      observation.taskHandle !== cell.task.handle ||
      observation.taskRevisionDigest !== cell.task.revisionDigest ||
      observation.repetition !== cell.repetition
    ) {
      throw new Error(`${expectedArm} observation is detached from its matched cell`);
    }
    if (
      !Number.isFinite(observation.reward) ||
      observation.reward < 0 ||
      observation.reward > 1 ||
      !Number.isSafeInteger(observation.durationMs) ||
      observation.durationMs < 0
    ) {
      throw new Error(`${expectedArm} observation has invalid metrics`);
    }
    if (expectedArm === "candidate" && observation.source !== "fresh") {
      throw new Error("Candidate observations must always be fresh");
    }
  }
}

function directionalConfidence(wins: number, losses: number): number {
  const discordant = wins + losses;
  if (discordant === 0) {
    return 0.5;
  }
  if (wins <= losses) {
    return Math.max(0, 1 - binomialUpperTail(discordant, wins));
  }
  return 1 - binomialUpperTail(discordant, wins);
}

function binomialUpperTail(trials: number, minimumSuccesses: number): number {
  let probability = 0;
  for (let successes = minimumSuccesses; successes <= trials; successes += 1) {
    probability += binomialCoefficient(trials, successes) * 0.5 ** trials;
  }
  return probability;
}

function binomialCoefficient(n: number, k: number): number {
  const boundedK = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= boundedK; index += 1) {
    result = (result * (n - boundedK + index)) / index;
  }
  return result;
}

function requiredObservation(
  observations: ReadonlyMap<string, PrivateEvaluationObservation>,
  cellId: string,
): PrivateEvaluationObservation {
  const observation = observations.get(cellId);
  if (observation === undefined) {
    throw new Error("A matched cell is missing its observation");
  }
  return observation;
}

function validateThreshold(value: number, name: string, openLowerBound: boolean): void {
  if (
    !Number.isFinite(value) ||
    (openLowerBound ? value <= 0 : value < 0) ||
    value >= 1
  ) {
    throw new Error(`${name} must be ${openLowerBound ? "in (0, 1)" : "in [0, 1)"}`);
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
