import type { BehaviorSummary } from "./behavior.js";
import type { HiddenTaskId } from "./types.js";

export const PRIVACY_POLICY_VERSION = "aggregate-firewall-v1";
export const MIN_DISTINCT_TASKS = 5;
export const MIN_TRAJECTORIES = 20;
export const MIN_GROUP_OBSERVATIONS = 5;

export type BehaviorFeature =
  | "invalid-tool-invocation"
  | "nonzero-without-inspection"
  | "repeated-action"
  | "recovery-after-failure"
  | "replan-after-failure"
  | "verification"
  | "premature-termination"
  | "compaction"
  | "plan-before-execution";
export type BehaviorComparison = "candidate-vs-champion" | "success-vs-failure";
export type SupportBand = "5-9" | "10-19" | "20-49" | "50-plus";

export interface PrivateBehaviorObservation {
  readonly taskId: HiddenTaskId;
  readonly arm: "candidate" | "champion";
  readonly outcome: "pass" | "fail";
  readonly behavior: BehaviorSummary;
}

export interface ReleaseSafeBehaviorCard {
  readonly cardId: string;
  readonly feature: BehaviorFeature;
  readonly comparison: BehaviorComparison;
  readonly direction: "more-in-group-a" | "more-in-group-b";
  readonly effectSizeBand: "small" | "medium" | "large";
  readonly effectEstimate: number;
  readonly interval95: readonly [number, number];
  readonly totalSupportBand: SupportBand;
  readonly groupSupportBands: readonly [SupportBand, SupportBand];
  readonly statement: string;
  readonly containsTaskIdentifiers: false;
  readonly containsLiterals: false;
}

export interface HiddenPrivacyReleaseRecord {
  readonly experimentDigest: string;
  readonly analysisWindowDigest: string;
  readonly taskIds: readonly HiddenTaskId[];
}

export interface HiddenPrivacyBudgetState {
  readonly policyVersion: typeof PRIVACY_POLICY_VERSION;
  readonly maximumReleases: number;
  readonly releasesUsed: number;
  readonly priorReleases: readonly HiddenPrivacyReleaseRecord[];
}

export interface ReleaseSafeBehaviorRelease {
  readonly cards: readonly ReleaseSafeBehaviorCard[];
  readonly suppression:
    | "none"
    | "insufficient-total-support"
    | "insufficient-group-support"
    | "unmatched-comparison"
    | "differencing-risk"
    | "release-budget-exhausted"
    | "already-released"
    | "no-statistically-supported-card";
  readonly containsTaskIdentifiers: false;
}

export interface HiddenBehaviorReleaseDecision {
  readonly release: ReleaseSafeBehaviorRelease;
  readonly nextPrivacyState: HiddenPrivacyBudgetState;
}

const FEATURES: readonly BehaviorFeature[] = [
  "invalid-tool-invocation",
  "nonzero-without-inspection",
  "repeated-action",
  "recovery-after-failure",
  "replan-after-failure",
  "verification",
  "premature-termination",
  "compaction",
  "plan-before-execution",
];

export function createPrivacyBudget(maximumReleases: number): HiddenPrivacyBudgetState {
  if (!Number.isSafeInteger(maximumReleases) || maximumReleases < 1) {
    throw new Error("Privacy release budget must be a positive safe integer");
  }
  return {
    policyVersion: PRIVACY_POLICY_VERSION,
    maximumReleases,
    releasesUsed: 0,
    priorReleases: [],
  };
}

/**
 * Creates a one-shot aggregate release. Hidden membership is used solely to
 * prevent adaptive differencing and is not copied into any returned card.
 */
export function releaseBehaviorCards(input: {
  readonly observations: readonly PrivateBehaviorObservation[];
  readonly comparison: BehaviorComparison;
  readonly experimentDigest: string;
  readonly analysisWindowDigest: string;
  readonly privacyState: HiddenPrivacyBudgetState;
  readonly forbiddenLiterals?: readonly string[];
}): HiddenBehaviorReleaseDecision {
  validatePrivacyState(input.privacyState);
  assertDigest("experimentDigest", input.experimentDigest);
  assertDigest("analysisWindowDigest", input.analysisWindowDigest);
  const distinctTasks = uniqueTaskIds(input.observations);
  if (input.observations.length < MIN_TRAJECTORIES || distinctTasks.length < MIN_DISTINCT_TASKS) {
    return suppressed(input.privacyState, "insufficient-total-support");
  }

  const groups = partitionGroups(input.observations, input.comparison);
  if (
    groups.a.length < MIN_GROUP_OBSERVATIONS ||
    groups.b.length < MIN_GROUP_OBSERVATIONS ||
    uniqueTaskIds(groups.a).length < MIN_DISTINCT_TASKS ||
    uniqueTaskIds(groups.b).length < MIN_DISTINCT_TASKS
  ) {
    return suppressed(input.privacyState, "insufficient-group-support");
  }
  if (
    input.comparison === "candidate-vs-champion" &&
    !sameTaskSet(uniqueTaskIds(groups.a), uniqueTaskIds(groups.b))
  ) {
    return suppressed(input.privacyState, "unmatched-comparison");
  }
  if (input.privacyState.releasesUsed >= input.privacyState.maximumReleases) {
    return suppressed(input.privacyState, "release-budget-exhausted");
  }
  if (
    input.privacyState.priorReleases.some(
      (release) => release.experimentDigest === input.experimentDigest,
    )
  ) {
    return suppressed(input.privacyState, "already-released");
  }
  if (createsDifferencingRisk(distinctTasks, input.privacyState.priorReleases)) {
    return suppressed(input.privacyState, "differencing-risk");
  }

  const cards: ReleaseSafeBehaviorCard[] = [];
  for (const feature of FEATURES) {
    const clusteredA = clusterFeatureTotal(groups.a, feature);
    const clusteredB = clusterFeatureTotal(groups.b, feature);
    const estimate =
      jeffreysRate(clusteredA.featureTotal, clusteredA.taskCount) -
      jeffreysRate(clusteredB.featureTotal, clusteredB.taskCount);
    const standardError = Math.sqrt(
      jeffreysVariance(clusteredA.featureTotal, clusteredA.taskCount) +
        jeffreysVariance(clusteredB.featureTotal, clusteredB.taskCount),
    );
    const lower = Math.max(-1, estimate - 1.96 * standardError);
    const upper = Math.min(1, estimate + 1.96 * standardError);
    if (lower <= 0 && upper >= 0) {
      continue;
    }
    const effectEstimate = coarsen(estimate);
    const card: ReleaseSafeBehaviorCard = {
      cardId: `card-${String(cards.length + 1).padStart(3, "0")}`,
      feature,
      comparison: input.comparison,
      direction: effectEstimate >= 0 ? "more-in-group-a" : "more-in-group-b",
      effectSizeBand: effectBand(Math.abs(effectEstimate)),
      effectEstimate,
      interval95: [coarsen(lower), coarsen(upper)],
      totalSupportBand: supportBand(input.observations.length),
      groupSupportBands: [supportBand(groups.a.length), supportBand(groups.b.length)],
      statement: statementFor(feature, input.comparison, effectEstimate >= 0),
      containsTaskIdentifiers: false,
      containsLiterals: false,
    };
    assertReleaseContainsNoLiterals(card, input.forbiddenLiterals ?? []);
    cards.push(card);
  }

  const nextPrivacyState: HiddenPrivacyBudgetState = {
    ...input.privacyState,
    releasesUsed: input.privacyState.releasesUsed + 1,
    priorReleases: [
      ...input.privacyState.priorReleases,
      {
        experimentDigest: input.experimentDigest,
        analysisWindowDigest: input.analysisWindowDigest,
        taskIds: distinctTasks,
      },
    ],
  };
  return {
    release: {
      cards,
      suppression: cards.length === 0 ? "no-statistically-supported-card" : "none",
      containsTaskIdentifiers: false,
    },
    nextPrivacyState,
  };
}

export function behaviorFeaturePresent(
  behavior: BehaviorSummary,
  feature: BehaviorFeature,
): boolean {
  switch (feature) {
    case "invalid-tool-invocation":
      return behavior.invocationInvalidity !== "none";
    case "nonzero-without-inspection":
      return (
        behavior.nonzeroExitFrequency !== "none" &&
        (behavior.inspectedAfterNonzeroExit === "none" ||
          behavior.inspectedAfterNonzeroExit === "low")
      );
    case "repeated-action":
      return behavior.repeatedActionFrequency !== "none";
    case "recovery-after-failure":
      return behavior.recoveryAfterFailure;
    case "replan-after-failure":
      return behavior.replanAfterFailure;
    case "verification":
      return behavior.verificationPerformed;
    case "premature-termination":
      return behavior.prematureTermination;
    case "compaction":
      return behavior.compactionFrequency !== "none";
    case "plan-before-execution":
      return behavior.planBeforeFirstExecution;
  }
}

/**
 * This is a final defense, not the primary sanitizer. It rejects provided raw
 * literals plus common URL, filesystem, environment-variable, and stable-token
 * shapes. It never returns matched text.
 */
export function assertReleaseContainsNoLiterals(
  release: unknown,
  forbiddenLiterals: readonly string[],
): void {
  const serialized = JSON.stringify(release);
  if (serialized === undefined) {
    throw new Error("A release must be JSON-serializable");
  }
  const lower = serialized.toLocaleLowerCase("en-US");
  for (const literal of forbiddenLiterals) {
    const normalized = literal.trim().toLocaleLowerCase("en-US");
    if (normalized.length >= 4 && lower.includes(normalized)) {
      throw new Error("Release contains a forbidden source literal");
    }
  }
  const intrinsicForbidden = [
    /\bhttps?:\/\//iu,
    /(?:^|[\s"'])\/(?:[a-z0-9._-]+\/)+[a-z0-9._-]+/iu,
    /\b[a-z]:\\(?:[^\\\s"]+\\)+[^\\\s"]+/iu,
    /\$[A-Z_][A-Z0-9_]*/u,
    /\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/u,
    /\b[a-f0-9]{32,}\b/iu,
    /\b\d{8,}\b/u,
  ];
  if (intrinsicForbidden.some((pattern) => pattern.test(serialized))) {
    throw new Error("Release contains a forbidden literal shape");
  }
}

function partitionGroups(
  observations: readonly PrivateBehaviorObservation[],
  comparison: BehaviorComparison,
): {
  readonly a: readonly PrivateBehaviorObservation[];
  readonly b: readonly PrivateBehaviorObservation[];
} {
  return comparison === "candidate-vs-champion"
    ? {
        a: observations.filter((observation) => observation.arm === "candidate"),
        b: observations.filter((observation) => observation.arm === "champion"),
      }
    : {
        a: observations.filter((observation) => observation.outcome === "fail"),
        b: observations.filter((observation) => observation.outcome === "pass"),
      };
}

function createsDifferencingRisk(
  taskIds: readonly HiddenTaskId[],
  priorReleases: readonly HiddenPrivacyReleaseRecord[],
): boolean {
  const current = new Set<string>(taskIds);
  return priorReleases.some((prior) => {
    const previous = new Set<string>(prior.taskIds);
    const overlap = [...current].filter((taskId) => previous.has(taskId)).length;
    // MVP policy is deliberately stricter than pairwise k-support: disjoint
    // release windows prevent three-or-more-query linear reconstruction too.
    return overlap > 0;
  });
}

function uniqueTaskIds(
  observations: readonly PrivateBehaviorObservation[],
): readonly HiddenTaskId[] {
  return [
    ...new Map(
      observations.map((observation) => [observation.taskId, observation.taskId]),
    ).values(),
  ].sort((left, right) => left.localeCompare(right));
}

function clusterFeatureTotal(
  observations: readonly PrivateBehaviorObservation[],
  feature: BehaviorFeature,
): { readonly featureTotal: number; readonly taskCount: number } {
  const byTask = new Map<string, { present: number; total: number }>();
  observations.forEach((observation) => {
    const previous = byTask.get(observation.taskId) ?? { present: 0, total: 0 };
    byTask.set(observation.taskId, {
      present: previous.present + (behaviorFeaturePresent(observation.behavior, feature) ? 1 : 0),
      total: previous.total + 1,
    });
  });
  return {
    featureTotal: [...byTask.values()].reduce(
      (sum, cluster) => sum + cluster.present / cluster.total,
      0,
    ),
    taskCount: byTask.size,
  };
}

function jeffreysRate(count: number, total: number): number {
  return (count + 0.5) / (total + 1);
}

function jeffreysVariance(count: number, total: number): number {
  const alpha = count + 0.5;
  const beta = total - count + 0.5;
  return (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
}

function coarsen(value: number): number {
  const bounded = Math.max(-1, Math.min(1, Math.round(value / 0.05) * 0.05));
  return Number(bounded.toFixed(2));
}

function effectBand(absoluteEffect: number): ReleaseSafeBehaviorCard["effectSizeBand"] {
  return absoluteEffect < 0.2 ? "small" : absoluteEffect < 0.4 ? "medium" : "large";
}

function supportBand(count: number): SupportBand {
  return count < 10 ? "5-9" : count < 20 ? "10-19" : count < 50 ? "20-49" : "50-plus";
}

function statementFor(
  feature: BehaviorFeature,
  comparison: BehaviorComparison,
  positive: boolean,
): string {
  const group =
    comparison === "candidate-vs-champion"
      ? positive
        ? "candidate trajectories"
        : "champion trajectories"
      : positive
        ? "failed trajectories"
        : "successful trajectories";
  const behavior: Readonly<Record<BehaviorFeature, string>> = {
    "invalid-tool-invocation": "invalid tool invocation",
    "nonzero-without-inspection": "nonzero execution without subsequent inspection",
    "repeated-action": "repeated generic action",
    "recovery-after-failure": "recovery after failure",
    "replan-after-failure": "replanning after failure",
    verification: "verification behavior",
    "premature-termination": "premature termination",
    compaction: "context compaction",
    "plan-before-execution": "planning before execution",
  };
  return `${behavior[feature]} was more prevalent in ${group}`;
}

function suppressed(
  state: HiddenPrivacyBudgetState,
  suppression: ReleaseSafeBehaviorRelease["suppression"],
): HiddenBehaviorReleaseDecision {
  return {
    release: { cards: [], suppression, containsTaskIdentifiers: false },
    nextPrivacyState: state,
  };
}

function validatePrivacyState(state: HiddenPrivacyBudgetState): void {
  if (
    state.policyVersion !== PRIVACY_POLICY_VERSION ||
    !Number.isSafeInteger(state.maximumReleases) ||
    state.maximumReleases < 1 ||
    !Number.isSafeInteger(state.releasesUsed) ||
    state.releasesUsed < 0 ||
    state.releasesUsed > state.maximumReleases ||
    state.releasesUsed !== state.priorReleases.length
  ) {
    throw new Error("Invalid privacy-budget state");
  }
  const experiments = new Set<string>();
  const windows = new Set<string>();
  const releasedTasks = new Set<string>();
  for (const release of state.priorReleases) {
    assertDigest("prior experiment digest", release.experimentDigest);
    assertDigest("prior analysis-window digest", release.analysisWindowDigest);
    if (
      experiments.has(release.experimentDigest) ||
      windows.has(release.analysisWindowDigest) ||
      release.taskIds.length < MIN_DISTINCT_TASKS ||
      new Set(release.taskIds).size !== release.taskIds.length
    ) {
      throw new Error("Invalid privacy-budget release ledger");
    }
    experiments.add(release.experimentDigest);
    windows.add(release.analysisWindowDigest);
    for (const taskId of release.taskIds) {
      assertDigest("prior hidden task ID", taskId);
      if (releasedTasks.has(taskId)) {
        throw new Error("Privacy-budget release windows must be task-disjoint");
      }
      releasedTasks.add(taskId);
    }
  }
}

function sameTaskSet(left: readonly HiddenTaskId[], right: readonly HiddenTaskId[]): boolean {
  return left.length === right.length && left.every((taskId, index) => taskId === right[index]);
}

function assertDigest(label: string, value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}
