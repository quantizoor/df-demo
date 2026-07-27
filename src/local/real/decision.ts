import {
  LOCAL_REAL_OBSERVATIONS_PER_ARM,
  LOCAL_REAL_REPETITIONS,
  LOCAL_REAL_SCHEMA_VERSION,
  LOCAL_REAL_TASKS_PER_PANEL,
  type LocalRealArmReceipt,
  type LocalRealDecision,
} from "./contracts.js";

export function decideLocalRealComparison(input: {
  readonly experimentId: string;
  readonly champion: LocalRealArmReceipt;
  readonly candidate: LocalRealArmReceipt;
  readonly decidedAt: string;
}): LocalRealDecision {
  const champion = observationsByTask(input.champion);
  const candidate = observationsByTask(input.candidate);
  const taskNames = [...champion.keys()].sort();
  if (
    taskNames.length !== LOCAL_REAL_TASKS_PER_PANEL ||
    candidate.size !== LOCAL_REAL_TASKS_PER_PANEL ||
    taskNames.some((taskName) => !candidate.has(taskName))
  ) {
    throw new Error("Local real comparison requires the same five tasks in both arms");
  }

  const infrastructureValid =
    input.champion.infrastructureValid &&
    input.candidate.infrastructureValid &&
    input.champion.observations.length === LOCAL_REAL_OBSERVATIONS_PER_ARM &&
    input.candidate.observations.length === LOCAL_REAL_OBSERVATIONS_PER_ARM;
  const taskDeltas = taskNames.map(
    (taskName) => mean(candidate.get(taskName) ?? []) - mean(champion.get(taskName) ?? []),
  );
  const taskWins = taskDeltas.filter((delta) => delta > 0.01).length;
  const taskLosses = taskDeltas.filter((delta) => delta < -0.01).length;
  const taskTies = LOCAL_REAL_TASKS_PER_PANEL - taskWins - taskLosses;
  const candidateMean = mean(input.candidate.observations.map((item) => item.reward));
  const championMean = mean(input.champion.observations.map((item) => item.reward));
  const delta = candidateMean - championMean;
  const confidenceCandidateBetter = directionalConfidence(taskWins, taskLosses);
  const confidenceChampionBetter = directionalConfidence(taskLosses, taskWins);

  let disposition: LocalRealDecision["disposition"] = "inconclusive";
  let reason: LocalRealDecision["reason"];
  if (!infrastructureValid) {
    reason = "infrastructure-invalid";
  } else if (delta >= 0.05 && taskWins > taskLosses && confidenceCandidateBetter >= 0.95) {
    disposition = "promote";
    reason = "candidate-superior";
  } else if (delta <= -0.05 && taskLosses > taskWins && confidenceChampionBetter >= 0.95) {
    disposition = "reject";
    reason = "candidate-inferior";
  } else if (Math.abs(delta) < 0.05) {
    reason = "aggregate-effect-too-small";
  } else {
    reason = "insufficient-confidence";
  }

  return {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    experimentId: input.experimentId,
    disposition,
    reason,
    candidateMeanReward: rounded(candidateMean),
    championMeanReward: rounded(championMean),
    meanRewardDelta: rounded(delta),
    taskWins,
    taskLosses,
    taskTies,
    confidenceCandidateBetter: rounded(confidenceCandidateBetter),
    minimumAggregateDelta: 0.05,
    requiredConfidence: 0.95,
    decidedAt: input.decidedAt,
    containsSecrets: false,
  };
}

export function invalidLocalRealCandidateDecision(input: {
  readonly experimentId: string;
  readonly champion: LocalRealArmReceipt;
  readonly decidedAt: string;
}): LocalRealDecision {
  return {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    experimentId: input.experimentId,
    disposition: "reject",
    reason: "candidate-invalid",
    candidateMeanReward: null,
    championMeanReward: rounded(
      mean(input.champion.observations.map((observation) => observation.reward)),
    ),
    meanRewardDelta: null,
    taskWins: 0,
    taskLosses: 0,
    taskTies: LOCAL_REAL_TASKS_PER_PANEL,
    confidenceCandidateBetter: 0.5,
    minimumAggregateDelta: 0.05,
    requiredConfidence: 0.95,
    decidedAt: input.decidedAt,
    containsSecrets: false,
  };
}

function observationsByTask(receipt: LocalRealArmReceipt): ReadonlyMap<string, readonly number[]> {
  const values = new Map<string, number[]>();
  for (const observation of receipt.observations) {
    const task = values.get(observation.taskName) ?? [];
    task.push(observation.reward);
    values.set(observation.taskName, task);
  }
  if (
    values.size !== LOCAL_REAL_TASKS_PER_PANEL ||
    [...values.values()].some((rewards) => rewards.length !== LOCAL_REAL_REPETITIONS)
  ) {
    throw new Error("Local real arm must contain three observations for each of five tasks");
  }
  return values;
}

function directionalConfidence(wins: number, losses: number): number {
  const discordant = wins + losses;
  if (discordant === 0) return 0.5;
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

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot average an empty local real sample");
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
