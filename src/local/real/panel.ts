import { createHash } from "node:crypto";

export const LOCAL_PANEL_POLICY_VERSION = "local-deterministic-adaptive-panel-v1" as const;
export const LOCAL_PANEL_STATE_SCHEMA_VERSION = 1 as const;
export const LOCAL_PANEL_SIZE = 5 as const;
export const LOCAL_PANEL_REPETITIONS = 3 as const;
export const LOCAL_PANEL_MAX_CHAMPION_MEAN = 0.95 as const;
export const LOCAL_PANEL_MIN_TASK_HEADROOM = 0.01 as const;
export const LOCAL_PANEL_SATURATION_WINDOW = 20 as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SELECTION_REDRAWS = 4_096;
const MAX_CATALOG_TASKS = 10_000;
const MAX_TASK_ID_LENGTH = 1_024;
const MAX_SEED_LENGTH = 4_096;
const METRIC_SCALE = 1_000_000_000_000;

export type LocalTaskDifficulty = "easy" | "medium" | "hard";

/**
 * The real runner may derive baseWeight from any private catalog signals it
 * owns. This policy only requires a finite positive value and applies the
 * campaign's difficulty pressure on top.
 */
export interface LocalTaskCatalogEntry {
  readonly taskId: string;
  readonly revision: string;
  readonly difficulty: LocalTaskDifficulty;
  readonly baseWeight: number;
}

export interface LocalPanelPolicyState {
  readonly schemaVersion: typeof LOCAL_PANEL_STATE_SCHEMA_VERSION;
  readonly policyVersion: typeof LOCAL_PANEL_POLICY_VERSION;
  readonly totalScreens: number;
  readonly saturatedScreens: number;
  readonly consecutiveSaturatedScreens: number;
  readonly recentSaturation: readonly boolean[];
}

export interface LocalPanelSelectionOptions {
  readonly seed: string;
  readonly screenOrdinal: number;
  readonly state: LocalPanelPolicyState;
  readonly excludedTaskIds?: readonly string[];
  readonly excludedPanelDigests?: readonly string[];
}

export interface LocalSelectedPanelTask extends LocalTaskCatalogEntry {
  readonly effectiveWeight: number;
  readonly samplingScore: number;
}

export interface LocalPanelSelection {
  readonly policyVersion: typeof LOCAL_PANEL_POLICY_VERSION;
  readonly seedDigest: string;
  readonly screenOrdinal: number;
  readonly redrawOrdinal: number;
  readonly saturationPressure: number;
  readonly panelDigest: string;
  readonly tasks: readonly LocalSelectedPanelTask[];
}

export interface LocalChampionPanelObservation {
  readonly taskId: string;
  readonly repetition: 1 | 2 | 3;
  readonly reward: number;
  readonly infrastructureValid: boolean;
}

export interface LocalChampionTaskAssessment {
  readonly taskId: string;
  readonly championMeanReward: number;
  readonly theoreticalHeadroom: number;
  readonly canProduceTaskWin: boolean;
}

export interface LocalChampionPanelAssessment {
  readonly policyVersion: typeof LOCAL_PANEL_POLICY_VERSION;
  readonly status: "accepted" | "saturated" | "infrastructure-invalid";
  readonly reason:
    | "surpassable"
    | "aggregate-and-task-headroom-insufficient"
    | "aggregate-headroom-insufficient"
    | "task-headroom-insufficient"
    | "infrastructure-invalid";
  readonly championMeanReward: number;
  readonly theoreticalAggregateHeadroom: number;
  readonly aggregateThresholdSatisfied: boolean;
  readonly everyTaskCanProduceWin: boolean;
  readonly fullyPerfect: boolean;
  readonly taskAssessments: readonly LocalChampionTaskAssessment[];
}

export class LocalPanelPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LocalPanelPolicyError";
  }
}

export function initialLocalPanelPolicyState(): LocalPanelPolicyState {
  return {
    schemaVersion: LOCAL_PANEL_STATE_SCHEMA_VERSION,
    policyVersion: LOCAL_PANEL_POLICY_VERSION,
    totalScreens: 0,
    saturatedScreens: 0,
    consecutiveSaturatedScreens: 0,
    recentSaturation: [],
  };
}

/**
 * Returns the observed saturation frequency over at most the latest twenty
 * valid screens. The empty history deliberately starts with no difficulty
 * pressure; one saturated screen reacts immediately and later successes lower
 * the pressure again.
 */
export function localPanelSaturationPressure(state: LocalPanelPolicyState): number {
  assertLocalPanelPolicyState(state);
  if (state.recentSaturation.length === 0) return 0;
  return rounded(
    state.recentSaturation.filter((saturated) => saturated).length / state.recentSaturation.length,
  );
}

/**
 * Advances only for a complete, infrastructure-valid screen. Callers must not
 * convert infrastructure failures into saturation observations.
 */
export function advanceLocalPanelPolicyState(
  state: LocalPanelPolicyState,
  saturated: boolean,
): LocalPanelPolicyState {
  assertLocalPanelPolicyState(state);
  if (typeof saturated !== "boolean") {
    throw new LocalPanelPolicyError("Panel saturation outcome must be boolean");
  }
  const recentSaturation = [...state.recentSaturation, saturated].slice(
    -LOCAL_PANEL_SATURATION_WINDOW,
  );
  const next: LocalPanelPolicyState = {
    schemaVersion: LOCAL_PANEL_STATE_SCHEMA_VERSION,
    policyVersion: LOCAL_PANEL_POLICY_VERSION,
    totalScreens: state.totalScreens + 1,
    saturatedScreens: state.saturatedScreens + (saturated ? 1 : 0),
    consecutiveSaturatedScreens: saturated ? state.consecutiveSaturatedScreens + 1 : 0,
    recentSaturation,
  };
  assertLocalPanelPolicyState(next);
  return next;
}

/**
 * Strict parser for state loaded from JSON. The returned value contains only
 * JSON primitives and a cloned boolean array.
 */
export function parseLocalPanelPolicyState(value: unknown): LocalPanelPolicyState {
  if (!isRecord(value)) {
    throw new LocalPanelPolicyError("Panel policy state must be an object");
  }
  const keys = Object.keys(value).sort();
  const expected = [
    "consecutiveSaturatedScreens",
    "policyVersion",
    "recentSaturation",
    "saturatedScreens",
    "schemaVersion",
    "totalScreens",
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new LocalPanelPolicyError("Panel policy state has unexpected fields");
  }
  const parsed: LocalPanelPolicyState = {
    schemaVersion: value.schemaVersion as typeof LOCAL_PANEL_STATE_SCHEMA_VERSION,
    policyVersion: value.policyVersion as typeof LOCAL_PANEL_POLICY_VERSION,
    totalScreens: value.totalScreens as number,
    saturatedScreens: value.saturatedScreens as number,
    consecutiveSaturatedScreens: value.consecutiveSaturatedScreens as number,
    recentSaturation: Array.isArray(value.recentSaturation) ? [...value.recentSaturation] : [],
  };
  assertLocalPanelPolicyState(parsed);
  return parsed;
}

/**
 * Deterministic weighted sampling without replacement. Each redraw uses a
 * domain-separated SHA-256 stream and weighted rendezvous keys. Catalog order
 * cannot influence the result, while the seed and screen ordinal make every
 * selection exactly replayable.
 */
export function selectDeterministicWeightedPanel(
  catalog: readonly LocalTaskCatalogEntry[],
  options: LocalPanelSelectionOptions,
): LocalPanelSelection {
  validateCatalog(catalog);
  validateSelectionOptions(options);
  const pressure = localPanelSaturationPressure(options.state);
  const excludedTasks = new Set(options.excludedTaskIds ?? []);
  const eligible = catalog
    .filter((task) => !excludedTasks.has(task.taskId))
    .map((task) => ({
      ...task,
      effectiveWeight: effectiveTaskWeight(task, pressure),
    }))
    .sort(compareTaskIdentity);
  if (eligible.length < LOCAL_PANEL_SIZE) {
    throw new LocalPanelPolicyError(
      "At least five eligible tasks are required after task exclusions",
    );
  }

  const excludedPanels = new Set(options.excludedPanelDigests ?? []);
  const seedDigest = sha256(options.seed);
  const redrawLimit = Math.min(MAX_SELECTION_REDRAWS, Math.max(64, (excludedPanels.size + 1) * 32));
  for (let redrawOrdinal = 0; redrawOrdinal < redrawLimit; redrawOrdinal += 1) {
    const tasks = eligible
      .map((task) => ({
        ...task,
        samplingScore: weightedSamplingScore(
          seedDigest,
          options.screenOrdinal,
          redrawOrdinal,
          task,
        ),
      }))
      .sort(compareSamplingCandidates)
      .slice(0, LOCAL_PANEL_SIZE)
      .map((task) => ({
        ...task,
        effectiveWeight: rounded(task.effectiveWeight),
        samplingScore: rounded(task.samplingScore),
      }));
    const digest = localPanelDigest(tasks);
    if (!excludedPanels.has(digest)) {
      return {
        policyVersion: LOCAL_PANEL_POLICY_VERSION,
        seedDigest,
        screenOrdinal: options.screenOrdinal,
        redrawOrdinal,
        saturationPressure: pressure,
        panelDigest: digest,
        tasks,
      };
    }
  }
  throw new LocalPanelPolicyError(
    "Unable to select a panel outside the persisted panel exclusions",
  );
}

export function localPanelDigest(
  tasks: readonly Pick<LocalTaskCatalogEntry, "taskId" | "revision">[],
): string {
  if (
    tasks.length !== LOCAL_PANEL_SIZE ||
    new Set(tasks.map((task) => task.taskId)).size !== LOCAL_PANEL_SIZE
  ) {
    throw new LocalPanelPolicyError("A panel digest requires five distinct tasks");
  }
  const identities = tasks
    .map((task) => {
      validateTaskIdentity(task.taskId, task.revision);
      return { taskId: task.taskId, revision: task.revision };
    })
    .sort(compareTaskIdentity);
  return sha256(JSON.stringify({ domain: LOCAL_PANEL_POLICY_VERSION, tasks: identities }));
}

/**
 * A panel is usable only if it has both the requested five-percent aggregate
 * headroom and strictly more than the one-percent tie tolerance on every task
 * cluster. These conditions make it mathematically possible for an all-1
 * candidate to win all five clusters under the current matched decision gate.
 */
export function assessLocalChampionPanel(
  selection: Pick<LocalPanelSelection, "tasks">,
  observations: readonly LocalChampionPanelObservation[],
): LocalChampionPanelAssessment {
  validateAssessmentEvidence(selection.tasks, observations);
  const observationsByTask = new Map(
    selection.tasks.map((task) => [
      task.taskId,
      observations
        .filter((observation) => observation.taskId === task.taskId)
        .sort((left, right) => left.repetition - right.repetition),
    ]),
  );
  const taskAssessments = selection.tasks.map((task): LocalChampionTaskAssessment => {
    const taskObservations = observationsByTask.get(task.taskId);
    if (taskObservations === undefined) {
      throw new LocalPanelPolicyError("Champion evidence omitted a selected task");
    }
    const championMeanReward = rounded(mean(taskObservations.map((item) => item.reward)));
    const theoreticalHeadroom = rounded(1 - championMeanReward);
    return {
      taskId: task.taskId,
      championMeanReward,
      theoreticalHeadroom,
      canProduceTaskWin: theoreticalHeadroom > LOCAL_PANEL_MIN_TASK_HEADROOM,
    };
  });
  const championMeanReward = rounded(mean(observations.map((item) => item.reward)));
  const theoreticalAggregateHeadroom = rounded(1 - championMeanReward);
  const aggregateThresholdSatisfied = championMeanReward <= LOCAL_PANEL_MAX_CHAMPION_MEAN;
  const everyTaskCanProduceWin = taskAssessments.every((task) => task.canProduceTaskWin);
  const fullyPerfect = observations.every((observation) => observation.reward === 1);
  if (observations.some((observation) => !observation.infrastructureValid)) {
    return {
      policyVersion: LOCAL_PANEL_POLICY_VERSION,
      status: "infrastructure-invalid",
      reason: "infrastructure-invalid",
      championMeanReward,
      theoreticalAggregateHeadroom,
      aggregateThresholdSatisfied,
      everyTaskCanProduceWin,
      fullyPerfect,
      taskAssessments,
    };
  }
  // Aggregate headroom is the acceptance criterion. Per-task headroom remains
  // diagnostic only: a panel with some perfect task clusters can still be
  // surpassed overall when its champion mean is at most 0.95.
  if (aggregateThresholdSatisfied) {
    return {
      policyVersion: LOCAL_PANEL_POLICY_VERSION,
      status: "accepted",
      reason: "surpassable",
      championMeanReward,
      theoreticalAggregateHeadroom,
      aggregateThresholdSatisfied,
      everyTaskCanProduceWin,
      fullyPerfect,
      taskAssessments,
    };
  }
  return {
    policyVersion: LOCAL_PANEL_POLICY_VERSION,
    status: "saturated",
    reason: "aggregate-headroom-insufficient",
    championMeanReward,
    theoreticalAggregateHeadroom,
    aggregateThresholdSatisfied,
    everyTaskCanProduceWin,
    fullyPerfect,
    taskAssessments,
  };
}

function effectiveTaskWeight(task: LocalTaskCatalogEntry, pressure: number): number {
  const difficultyFactor = {
    easy: 0,
    medium: 1,
    hard: 3,
  } satisfies Record<LocalTaskDifficulty, number>;
  return task.baseWeight * (1 + pressure * difficultyFactor[task.difficulty]);
}

function weightedSamplingScore(
  seedDigest: string,
  screenOrdinal: number,
  redrawOrdinal: number,
  task: LocalTaskCatalogEntry & { readonly effectiveWeight: number },
): number {
  const digest = createHash("sha256")
    .update(
      [
        LOCAL_PANEL_POLICY_VERSION,
        seedDigest,
        String(screenOrdinal),
        String(redrawOrdinal),
        task.taskId,
        task.revision,
      ].join("\0"),
    )
    .digest();
  const mantissa = digest.readBigUInt64BE(0) >> 11n;
  const uniform = (Number(mantissa) + 0.5) / 2 ** 53;
  return Math.log(uniform) / task.effectiveWeight;
}

function compareSamplingCandidates(
  left: LocalTaskCatalogEntry & {
    readonly effectiveWeight: number;
    readonly samplingScore: number;
  },
  right: LocalTaskCatalogEntry & {
    readonly effectiveWeight: number;
    readonly samplingScore: number;
  },
): number {
  const scoreDelta = right.samplingScore - left.samplingScore;
  return scoreDelta === 0 ? compareTaskIdentity(left, right) : scoreDelta;
}

function compareTaskIdentity(
  left: Pick<LocalTaskCatalogEntry, "taskId" | "revision">,
  right: Pick<LocalTaskCatalogEntry, "taskId" | "revision">,
): number {
  const idOrder = left.taskId.localeCompare(right.taskId);
  return idOrder === 0 ? left.revision.localeCompare(right.revision) : idOrder;
}

function validateCatalog(catalog: readonly LocalTaskCatalogEntry[]): void {
  if (
    catalog.length < LOCAL_PANEL_SIZE ||
    catalog.length > MAX_CATALOG_TASKS ||
    new Set(catalog.map((task) => task.taskId)).size !== catalog.length
  ) {
    throw new LocalPanelPolicyError(
      "Task catalog must contain between five and ten thousand distinct tasks",
    );
  }
  for (const task of catalog) {
    validateTaskIdentity(task.taskId, task.revision);
    if (
      (task.difficulty !== "easy" && task.difficulty !== "medium" && task.difficulty !== "hard") ||
      !Number.isFinite(task.baseWeight) ||
      task.baseWeight <= 0
    ) {
      throw new LocalPanelPolicyError("Catalog task difficulty and base weight must be valid");
    }
  }
}

function validateSelectionOptions(options: LocalPanelSelectionOptions): void {
  if (
    typeof options.seed !== "string" ||
    options.seed.length === 0 ||
    options.seed.length > MAX_SEED_LENGTH ||
    options.seed.includes("\0") ||
    !Number.isSafeInteger(options.screenOrdinal) ||
    options.screenOrdinal < 1
  ) {
    throw new LocalPanelPolicyError("Panel seed and screen ordinal are invalid");
  }
  assertLocalPanelPolicyState(options.state);
  const excludedTaskIds = options.excludedTaskIds ?? [];
  if (
    new Set(excludedTaskIds).size !== excludedTaskIds.length ||
    excludedTaskIds.some(
      (taskId) =>
        typeof taskId !== "string" ||
        taskId.length === 0 ||
        taskId.length > MAX_TASK_ID_LENGTH ||
        taskId.includes("\0"),
    )
  ) {
    throw new LocalPanelPolicyError("Excluded task identifiers are invalid");
  }
  const excludedPanelDigests = options.excludedPanelDigests ?? [];
  if (
    new Set(excludedPanelDigests).size !== excludedPanelDigests.length ||
    excludedPanelDigests.some((digest) => !SHA256.test(digest))
  ) {
    throw new LocalPanelPolicyError("Excluded panel digests are invalid");
  }
}

function validateAssessmentEvidence(
  tasks: readonly LocalSelectedPanelTask[],
  observations: readonly LocalChampionPanelObservation[],
): void {
  if (
    tasks.length !== LOCAL_PANEL_SIZE ||
    new Set(tasks.map((task) => task.taskId)).size !== LOCAL_PANEL_SIZE ||
    observations.length !== LOCAL_PANEL_SIZE * LOCAL_PANEL_REPETITIONS
  ) {
    throw new LocalPanelPolicyError(
      "Champion panel assessment requires five tasks and fifteen observations",
    );
  }
  const selectedTaskIds = new Set(tasks.map((task) => task.taskId));
  const identities = new Set<string>();
  for (const observation of observations) {
    const identity = `${observation.taskId}\0${observation.repetition}`;
    if (
      !selectedTaskIds.has(observation.taskId) ||
      (observation.repetition !== 1 &&
        observation.repetition !== 2 &&
        observation.repetition !== 3) ||
      !Number.isFinite(observation.reward) ||
      observation.reward < 0 ||
      observation.reward > 1 ||
      typeof observation.infrastructureValid !== "boolean" ||
      identities.has(identity)
    ) {
      throw new LocalPanelPolicyError(
        "Champion panel observations are malformed or detached from the selection",
      );
    }
    identities.add(identity);
  }
  for (const task of tasks) {
    if (
      observations.filter((observation) => observation.taskId === task.taskId).length !==
      LOCAL_PANEL_REPETITIONS
    ) {
      throw new LocalPanelPolicyError(
        "Every selected task requires exactly three champion observations",
      );
    }
  }
}

function assertLocalPanelPolicyState(
  state: LocalPanelPolicyState,
): asserts state is LocalPanelPolicyState {
  if (
    state.schemaVersion !== LOCAL_PANEL_STATE_SCHEMA_VERSION ||
    state.policyVersion !== LOCAL_PANEL_POLICY_VERSION ||
    !Number.isSafeInteger(state.totalScreens) ||
    state.totalScreens < 0 ||
    !Number.isSafeInteger(state.saturatedScreens) ||
    state.saturatedScreens < 0 ||
    state.saturatedScreens > state.totalScreens ||
    !Number.isSafeInteger(state.consecutiveSaturatedScreens) ||
    state.consecutiveSaturatedScreens < 0 ||
    state.consecutiveSaturatedScreens > state.totalScreens ||
    !Array.isArray(state.recentSaturation) ||
    state.recentSaturation.length > LOCAL_PANEL_SATURATION_WINDOW ||
    state.recentSaturation.length > state.totalScreens ||
    state.recentSaturation.some((item) => typeof item !== "boolean") ||
    state.recentSaturation.filter((item) => item).length > state.saturatedScreens
  ) {
    throw new LocalPanelPolicyError("Panel policy state is invalid");
  }
}

function validateTaskIdentity(taskId: string, revision: string): void {
  if (
    typeof taskId !== "string" ||
    taskId.length === 0 ||
    taskId.length > MAX_TASK_ID_LENGTH ||
    taskId.includes("\0") ||
    typeof revision !== "string" ||
    revision.length === 0 ||
    revision.length > MAX_TASK_ID_LENGTH ||
    revision.includes("\0")
  ) {
    throw new LocalPanelPolicyError("Task identity is invalid");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new LocalPanelPolicyError("Cannot calculate the mean of an empty collection");
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rounded(value: number): number {
  return Math.round(value * METRIC_SCALE) / METRIC_SCALE;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
