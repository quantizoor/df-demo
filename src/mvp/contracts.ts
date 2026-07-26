import { createHash } from "node:crypto";

export const MVP_SCHEMA_VERSION = "mvp-1.0.0" as const;
export const MVP_SELECTION_POLICY = "deterministic-failure-weighted-v1" as const;
export const MVP_CACHE_POLICY = "full-environment-champion-cache-v1" as const;
export const MVP_DECISION_POLICY = "matched-cluster-sign-v1" as const;
export const MVP_TASK_COUNT = 5 as const;
export const MVP_REPETITIONS_PER_TASK = 3 as const;
export const MVP_CELL_COUNT = 15 as const;

declare const hiddenTaskHandleBrand: unique symbol;

/**
 * A task handle is broker-private. It must be an irreversible digest rather
 * than a Terminal-Bench name, path, or slug.
 */
export type HiddenTaskHandle = string & {
  readonly [hiddenTaskHandleBrand]: true;
};

export function hiddenTaskHandle(value: string): HiddenTaskHandle {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("A hidden task handle must be a lowercase SHA-256 digest");
  }
  return value as HiddenTaskHandle;
}

export interface HiddenTaskProfile {
  readonly handle: HiddenTaskHandle;
  readonly revisionDigest: string;
  readonly difficulty: "hard" | "medium" | "easy";
  readonly easyCanary: boolean;
  readonly baselineFailureRate: number;
  readonly leaderboardFailureRate: number;
  readonly previousFailureRate: number;
  readonly uncertainty: number;
  readonly underexposure: number;
  readonly normalizedCost: number;
  readonly consecutiveSelections: number;
  /**
   * Exact source literals used only by the trusted sanitizer boundary. They
   * are never copied into an optimizer-facing value.
   */
  readonly sensitiveLiterals: readonly string[];
}

export interface SelectedHiddenTask {
  readonly handle: HiddenTaskHandle;
  readonly revisionDigest: string;
  readonly easyCanary: boolean;
  readonly weight: number;
  readonly sensitiveLiterals: readonly string[];
}

export interface HiddenEvaluationCell {
  readonly cellId: string;
  readonly task: SelectedHiddenTask;
  readonly repetition: 1 | 2 | 3;
}

/**
 * Every field which can change benchmark behavior is explicit. extraConfigDigest
 * is a fail-closed commitment to provider-specific settings not represented by
 * the named fields.
 */
export interface EvaluationEnvironment {
  readonly terminalBenchVersion: string;
  readonly datasetRevision: string;
  readonly graderProtocolVersion: string;
  readonly evaluatorVersion: string;
  readonly modelProvider: string;
  readonly modelDeployment: string;
  readonly reasoningEffort: string;
  readonly samplingSettingsDigest: string;
  readonly contextSettingsDigest: string;
  readonly sandboxProvider: string;
  readonly sandboxRegion: string;
  readonly imageDigest: string;
  readonly architecture: string;
  readonly resourcesDigest: string;
  readonly networkPolicyDigest: string;
  readonly harnessConfigDigest: string;
  readonly extraConfigDigest: string;
}

export type EvaluationArm = "candidate" | "champion";
export type ObservationSource = "fresh" | "champion-cache";

export interface PrivateRawDiagnostic {
  readonly kind: "agent" | "tool" | "grader" | "infrastructure";
  readonly code: string;
  readonly toolName: string | null;
  readonly message: string;
  readonly evidenceRefs: readonly string[];
}

export interface PrivateEvaluationRequest {
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly cell: HiddenEvaluationCell;
  readonly arm: EvaluationArm;
  readonly harnessRevision: string;
  readonly environment: EvaluationEnvironment;
  readonly environmentDigest: string;
}

export interface PrivateEvaluationObservation {
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly cellId: string;
  readonly taskHandle: HiddenTaskHandle;
  readonly taskRevisionDigest: string;
  readonly repetition: 1 | 2 | 3;
  readonly arm: EvaluationArm;
  readonly harnessRevision: string;
  readonly environmentDigest: string;
  readonly source: ObservationSource;
  readonly passed: boolean;
  readonly reward: number;
  readonly infrastructureValid: boolean;
  readonly durationMs: number;
  readonly evaluatedAt: string;
  readonly traceArtifactRefs: readonly string[];
  readonly rawDiagnostics: readonly PrivateRawDiagnostic[];
}

export interface ChampionCacheKey {
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly policyVersion: typeof MVP_CACHE_POLICY;
  readonly taskHandle: HiddenTaskHandle;
  readonly taskRevisionDigest: string;
  readonly championRevision: string;
  readonly repetition: 1 | 2 | 3;
  readonly environment: EvaluationEnvironment;
  readonly environmentDigest: string;
  readonly keyDigest: string;
}

export interface CachedChampionObservation {
  readonly keyDigest: string;
  readonly taskHandle: HiddenTaskHandle;
  readonly taskRevisionDigest: string;
  readonly championRevision: string;
  readonly repetition: 1 | 2 | 3;
  readonly environmentDigest: string;
  readonly passed: boolean;
  readonly reward: number;
  readonly infrastructureValid: boolean;
  readonly durationMs: number;
  readonly evaluatedAt: string;
  readonly traceArtifactRefs: readonly string[];
  readonly rawDiagnostics: readonly PrivateRawDiagnostic[];
}

export const DIAGNOSTIC_CATEGORIES = [
  "tool-invocation",
  "tool-selection",
  "command-construction",
  "error-recovery",
  "verification",
  "planning",
  "context-management",
  "dependency",
  "timeout",
  "infrastructure",
] as const;

export const TOOL_CLASSES = [
  "shell",
  "filesystem-read",
  "filesystem-write",
  "search",
  "patch",
  "version-control",
  "package-manager",
  "browser",
  "none",
  "unknown",
] as const;

export const CAUSE_CODES = [
  "invalid-arguments",
  "unsupported-operation",
  "wrong-tool-class",
  "missing-prerequisite",
  "nonzero-exit-not-inspected",
  "repeated-failed-action",
  "insufficient-verification",
  "premature-termination",
  "context-loss",
  "deadline-exceeded",
  "dependency-unavailable",
  "sandbox-failure",
  "unknown",
] as const;

export const INTERVENTION_CODES = [
  "validate-tool-arguments",
  "inspect-before-retry",
  "choose-capability-first",
  "verify-prerequisites",
  "replan-after-failure",
  "add-result-verification",
  "preserve-critical-context",
  "bound-retries",
  "handle-time-budget",
  "no-harness-action",
] as const;

export interface SanitizedDiagnosticCard {
  readonly category: (typeof DIAGNOSTIC_CATEGORIES)[number];
  readonly toolClass: (typeof TOOL_CLASSES)[number];
  readonly cause: (typeof CAUSE_CODES)[number];
  readonly intervention: (typeof INTERVENTION_CODES)[number];
  readonly affectedArm: EvaluationArm | "comparison";
  readonly direction: "candidate-better" | "candidate-worse" | "mixed" | "unknown";
  readonly supportBand: "low" | "medium" | "high";
  readonly confidenceBand: "low" | "medium" | "high";
}

export interface SanitizedDiagnosticBrief {
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly policyVersion: "closed-vocabulary-task-free-v1";
  readonly cards: readonly SanitizedDiagnosticCard[];
  readonly containsTaskIdentifiers: false;
  readonly containsTaskLiterals: false;
  readonly containsGraderSecrets: false;
  readonly containsPerTaskOutcomes: false;
}

export interface OptimizerInput {
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly experimentNumber: number;
  readonly championRevision: string;
  readonly previousOutcome: "promote" | "reject" | "inconclusive" | null;
  readonly diagnosticBrief: SanitizedDiagnosticBrief | null;
  readonly boundary: {
    readonly taskCatalogVisible: false;
    readonly taskIdentifiersVisible: false;
    readonly taskPromptsVisible: false;
    readonly graderVisible: false;
    readonly rawTracesVisible: false;
    readonly taskSpecificFeedbackVisible: false;
  };
}

export interface CandidateProposal {
  readonly hypothesisId: string;
  readonly hypothesisSummary: string;
  readonly interventionSummary: string;
  readonly candidateRevision: string;
  readonly changedFiles: readonly string[];
}

export type DecisionDisposition = "promote" | "reject" | "inconclusive";

export interface ReleaseSafeDecision {
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly policyVersion: typeof MVP_DECISION_POLICY;
  readonly disposition: DecisionDisposition;
  readonly reason:
    | "candidate-superior"
    | "candidate-inferior"
    | "fresh-evidence-required"
    | "insufficient-confidence"
    | "aggregate-effect-too-small"
    | "incomplete-or-invalid-evidence";
  readonly evidenceFresh: boolean;
  readonly matchedTaskCount: 5;
  readonly repetitionsPerTask: 3;
  readonly candidateObservationCount: 15;
  readonly championObservationCount: 15;
  readonly candidateMeanReward: number;
  readonly championMeanReward: number;
  readonly meanRewardDelta: number;
  readonly taskWins: number;
  readonly taskLosses: number;
  readonly taskTies: number;
  readonly confidenceMethod: "exact-one-sided-cluster-sign-v1";
  readonly confidenceCandidateBetter: number;
  readonly confidenceChampionBetter: number;
  readonly requiredConfidence: number;
  readonly minimumAggregateDelta: number;
  readonly containsTaskIdentifiers: false;
  readonly containsPerTaskOutcomes: false;
}

export interface MvpExperimentManifest {
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly experimentNumber: number;
  readonly slug: string;
  readonly status: "completed";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly championBefore: string;
  readonly candidateRevision: string;
  readonly championAfter: string;
}

export interface MvpExperimentState {
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly experimentNumber: number;
  readonly championBefore: string;
  readonly candidateRevision: string;
  readonly championAfter: string;
  readonly finalDisposition: DecisionDisposition;
  readonly nextExperimentNumber: number;
  readonly diagnosticFeedbackAvailable: boolean;
  readonly taskCatalogExposedToOptimizer: false;
  readonly graderExposedToOptimizer: false;
}

export interface MvpExperimentArtifacts {
  readonly manifest: MvpExperimentManifest;
  readonly optimizerInput: OptimizerInput;
  readonly hypothesis: CandidateProposal & {
    readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
    readonly experimentNumber: number;
  };
  readonly diagnostics: SanitizedDiagnosticBrief;
  readonly decision: ReleaseSafeDecision;
  readonly state: MvpExperimentState;
  readonly privateSelection: {
    readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
    readonly policyVersion: typeof MVP_SELECTION_POLICY;
    readonly tasks: readonly SelectedHiddenTask[];
    readonly cells: readonly HiddenEvaluationCell[];
  };
  readonly privateEvaluations: {
    readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
    readonly screening: readonly PrivateEvaluationObservation[];
    readonly final: readonly PrivateEvaluationObservation[];
  };
  readonly privateCache: {
    readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
    readonly policyVersion: typeof MVP_CACHE_POLICY;
    readonly hitCellIds: readonly string[];
    readonly missCellIds: readonly string[];
    readonly refreshedCellIds: readonly string[];
    readonly seededFromPromotedCandidateCellIds: readonly string[];
  };
}

export interface HiddenTaskOutcomeUpdate {
  readonly taskHandle: HiddenTaskHandle;
  readonly experimentId: string;
  readonly candidatePasses: number;
  readonly championPasses: number;
  readonly candidateMeanReward: number;
  readonly championMeanReward: number;
  readonly selected: true;
}

export interface HiddenTaskCatalogPort {
  readonly list: () => Promise<readonly HiddenTaskProfile[]>;
  readonly recordOutcomes: (
    experimentId: string,
    updates: readonly HiddenTaskOutcomeUpdate[],
  ) => Promise<void>;
}

export interface OptimizerPort {
  readonly propose: (input: OptimizerInput) => Promise<CandidateProposal>;
}

export interface TrustedEvaluatorPort {
  /**
   * Runs one bounded Harbor job for the exact requested fresh cells. The
   * normal screen contains fifteen candidate requests plus only the champion
   * cache misses; a possible promotion refresh contains only cached champion
   * cells. The trusted adapter must reject any missing, duplicate, or extra
   * observation.
   */
  readonly evaluateBatch: (
    requests: readonly PrivateEvaluationRequest[],
  ) => Promise<readonly PrivateEvaluationObservation[]>;
}

export interface TrustedSanitizerPort {
  readonly sanitize: (input: {
    readonly candidate: readonly PrivateEvaluationObservation[];
    readonly champion: readonly PrivateEvaluationObservation[];
  }) => Promise<SanitizedDiagnosticBrief>;
}

export interface ChampionCachePort {
  readonly get: (key: ChampionCacheKey) => Promise<CachedChampionObservation | null>;
  readonly put: (
    key: ChampionCacheKey,
    observation: CachedChampionObservation,
  ) => Promise<void>;
}

export interface ExperimentArtifactStorePort {
  readonly persist: (artifacts: MvpExperimentArtifacts) => Promise<string>;
}

export interface MvpLoopPorts {
  readonly taskCatalog: HiddenTaskCatalogPort;
  readonly optimizer: OptimizerPort;
  readonly evaluator: TrustedEvaluatorPort;
  readonly sanitizer: TrustedSanitizerPort;
  readonly championCache: ChampionCachePort;
  readonly artifacts: ExperimentArtifactStorePort;
  readonly now?: () => Date;
}

export interface MvpIterationInput {
  readonly experimentNumber: number;
  readonly slug: string;
  readonly championRevision: string;
  readonly environment: EvaluationEnvironment;
  readonly previousOutcome: DecisionDisposition | null;
  readonly previousDiagnosticBrief: SanitizedDiagnosticBrief | null;
  /**
   * Trusted-controller-only panel continuity. A rejected or inconclusive
   * iteration must provide the exact five opaque handles from the preceding
   * private selection. A first iteration or a post-promotion iteration must
   * leave this null so the weighted selector can choose a new panel.
   */
  readonly retainedTaskHandles?: readonly HiddenTaskHandle[] | null;
  readonly requiredConfidence?: number;
  readonly minimumAggregateDelta?: number;
}

export interface MvpIterationResult {
  readonly experimentId: string;
  readonly candidateRevision: string;
  readonly championRevision: string;
  readonly decision: ReleaseSafeDecision;
  readonly diagnosticBrief: SanitizedDiagnosticBrief;
  readonly artifactDirectory: string;
  readonly cache: {
    readonly hits: number;
    readonly misses: number;
    readonly refreshedForPromotion: number;
    readonly seededFromPromotion: number;
  };
}

export function evaluationEnvironmentDigest(environment: EvaluationEnvironment): string {
  return sha256(canonicalJson(environment));
}

export function championCacheKey(input: {
  readonly task: SelectedHiddenTask;
  readonly championRevision: string;
  readonly repetition: 1 | 2 | 3;
  readonly environment: EvaluationEnvironment;
}): ChampionCacheKey {
  const environmentDigest = evaluationEnvironmentDigest(input.environment);
  const material = {
    policyVersion: MVP_CACHE_POLICY,
    taskHandle: input.task.handle,
    taskRevisionDigest: input.task.revisionDigest,
    championRevision: input.championRevision,
    repetition: input.repetition,
    environment: input.environment,
    environmentDigest,
  };
  return {
    schemaVersion: MVP_SCHEMA_VERSION,
    ...material,
    keyDigest: sha256(canonicalJson(material)),
  };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}
