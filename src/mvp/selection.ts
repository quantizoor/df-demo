import {
  type HiddenEvaluationCell,
  type HiddenTaskProfile,
  MVP_CELL_COUNT,
  MVP_REPETITIONS_PER_TASK,
  MVP_TASK_COUNT,
  type SelectedHiddenTask,
  sha256,
} from "./contracts.js";

export class MvpSelectionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MvpSelectionError";
  }
}

/**
 * This selector contains no RNG and accepts no seed. Historical failures have
 * the largest weights; underexposure prevents a permanently fixed panel; one
 * explicitly easy task is always retained as a regression/reward-hacking
 * canary.
 */
export function selectFailureWeightedTasks(
  profiles: readonly HiddenTaskProfile[],
): readonly SelectedHiddenTask[] {
  validateProfiles(profiles);

  const canaries = profiles
    .filter((profile) => profile.easyCanary && profile.difficulty === "easy")
    .map((profile) => ({ profile, weight: canaryWeight(profile) }))
    .sort(compareWeightedProfiles);
  const selectedCanary = canaries[0];
  if (selectedCanary === undefined) {
    throw new MvpSelectionError("At least one eligible easy canary is required");
  }

  const weightedCore = profiles
    .filter((profile) => !profile.easyCanary)
    .map((profile) => ({ profile, weight: failureWeight(profile) }))
    .sort(compareWeightedProfiles);
  const selectedCore = weightedCore.slice(0, MVP_TASK_COUNT - 1);
  if (selectedCore.length !== MVP_TASK_COUNT - 1) {
    throw new MvpSelectionError("At least four non-canary tasks are required");
  }

  const selected = [...selectedCore, selectedCanary].map(({ profile, weight }) => ({
    handle: profile.handle,
    revisionDigest: profile.revisionDigest,
    easyCanary: profile.easyCanary,
    weight,
    sensitiveLiterals: [...profile.sensitiveLiterals],
  }));
  if (
    selected.length !== MVP_TASK_COUNT ||
    new Set(selected.map((task) => task.handle)).size !== MVP_TASK_COUNT ||
    selected.filter((task) => task.easyCanary).length !== 1
  ) {
    throw new MvpSelectionError("Selection did not produce four weighted tasks and one canary");
  }
  return selected;
}

/**
 * Resolves a trusted controller's opaque panel commitment against the current
 * private catalog. This deliberately preserves the previous order and task
 * identities after a rejection or inconclusive result while refreshing only
 * catalog-owned metadata.
 */
export function retainHiddenTaskPanel(
  profiles: readonly HiddenTaskProfile[],
  retainedHandles: readonly HiddenTaskProfile["handle"][],
): readonly SelectedHiddenTask[] {
  validateProfiles(profiles);
  if (
    retainedHandles.length !== MVP_TASK_COUNT ||
    new Set(retainedHandles).size !== MVP_TASK_COUNT
  ) {
    throw new MvpSelectionError(
      "A retained panel requires exactly five distinct opaque task handles",
    );
  }
  const profilesByHandle = new Map(profiles.map((profile) => [profile.handle, profile]));
  const selected = retainedHandles.map((handle) => {
    const profile = profilesByHandle.get(handle);
    if (profile === undefined) {
      throw new MvpSelectionError(
        "A retained panel task is absent from the current hidden catalog",
      );
    }
    return {
      handle: profile.handle,
      revisionDigest: profile.revisionDigest,
      easyCanary: profile.easyCanary,
      weight: profile.easyCanary ? canaryWeight(profile) : failureWeight(profile),
      sensitiveLiterals: [...profile.sensitiveLiterals],
    };
  });
  if (
    selected.filter((task) => task.easyCanary).length !== 1 ||
    selected.some(
      (task) => task.easyCanary && profilesByHandle.get(task.handle)?.difficulty !== "easy",
    )
  ) {
    throw new MvpSelectionError("A retained panel must contain exactly one eligible easy canary");
  }
  return selected;
}

export function buildMatchedCells(
  experimentId: string,
  tasks: readonly SelectedHiddenTask[],
): readonly HiddenEvaluationCell[] {
  if (!/^\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(experimentId)) {
    throw new MvpSelectionError("Experiment ID must be a numbered kebab-case folder name");
  }
  if (
    tasks.length !== MVP_TASK_COUNT ||
    new Set(tasks.map((task) => task.handle)).size !== MVP_TASK_COUNT
  ) {
    throw new MvpSelectionError("A matched panel requires exactly five distinct tasks");
  }

  const cells = tasks.flatMap((task, taskIndex) =>
    ([1, 2, 3] as const).map((repetition) => ({
      cellId: sha256(`dark-factory-mvp-cell-v1|${experimentId}|${taskIndex}|${repetition}`),
      task,
      repetition,
    })),
  );
  if (
    cells.length !== MVP_CELL_COUNT ||
    tasks.some(
      (task) =>
        cells.filter((cell) => cell.task.handle === task.handle).length !==
        MVP_REPETITIONS_PER_TASK,
    )
  ) {
    throw new MvpSelectionError("A matched panel requires three cells for each task");
  }
  return cells;
}

function failureWeight(profile: HiddenTaskProfile): number {
  return rounded(
    0.38 * profile.previousFailureRate +
      0.28 * profile.baselineFailureRate +
      0.18 * profile.leaderboardFailureRate +
      0.1 * profile.uncertainty +
      0.11 * profile.underexposure -
      0.04 * profile.normalizedCost -
      Math.min(0.24, profile.consecutiveSelections * 0.08),
  );
}

function canaryWeight(profile: HiddenTaskProfile): number {
  return rounded(
    0.46 * profile.underexposure +
      0.2 * profile.uncertainty +
      0.16 * profile.previousFailureRate +
      0.1 * profile.baselineFailureRate +
      0.08 * profile.leaderboardFailureRate -
      0.03 * profile.normalizedCost -
      Math.min(0.3, profile.consecutiveSelections * 0.1),
  );
}

function compareWeightedProfiles(
  left: { readonly profile: HiddenTaskProfile; readonly weight: number },
  right: { readonly profile: HiddenTaskProfile; readonly weight: number },
): number {
  const delta = right.weight - left.weight;
  return delta === 0 ? left.profile.handle.localeCompare(right.profile.handle) : delta;
}

function validateProfiles(profiles: readonly HiddenTaskProfile[]): void {
  if (new Set(profiles.map((profile) => profile.handle)).size !== profiles.length) {
    throw new MvpSelectionError("The hidden catalog contains duplicate task handles");
  }
  for (const profile of profiles) {
    if (!/^[a-f0-9]{64}$/u.test(profile.handle)) {
      throw new MvpSelectionError("Task handles must be opaque SHA-256 digests");
    }
    if (!/^[a-f0-9]{64}$/u.test(profile.revisionDigest)) {
      throw new MvpSelectionError("Task revisions must be SHA-256 digests");
    }
    for (const value of [
      profile.baselineFailureRate,
      profile.leaderboardFailureRate,
      profile.previousFailureRate,
      profile.uncertainty,
      profile.underexposure,
      profile.normalizedCost,
    ]) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new MvpSelectionError("Selection signals must be finite values in [0, 1]");
      }
    }
    if (!Number.isSafeInteger(profile.consecutiveSelections) || profile.consecutiveSelections < 0) {
      throw new MvpSelectionError("Consecutive selection counts must be non-negative integers");
    }
    if (
      profile.sensitiveLiterals.some(
        (literal) => typeof literal !== "string" || literal.trim().length < 3,
      )
    ) {
      throw new MvpSelectionError("Sensitive literals must contain at least three characters");
    }
  }
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
