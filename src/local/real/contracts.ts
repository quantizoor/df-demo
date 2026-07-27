export const LOCAL_REAL_SCHEMA_VERSION = "local-real-1.0.0" as const;
export const LOCAL_REAL_REPETITIONS = 3 as const;
export const LOCAL_REAL_TASKS_PER_PANEL = 5 as const;
export const LOCAL_REAL_OBSERVATIONS_PER_ARM = 15 as const;
export const LOCAL_REAL_EVALUATION_CONCURRENCY = 5 as const;

export type LocalRealDifficulty = "easy" | "medium" | "hard";

export interface LocalRealTask {
  readonly name: string;
  readonly difficulty: LocalRealDifficulty;
  readonly sourceRepository: string;
  readonly sourceRevision: string;
  readonly sourcePath: string;
  readonly empiricalFailureRate: number;
  readonly selections: number;
}

export interface LocalRealCatalog {
  readonly schemaVersion: typeof LOCAL_REAL_SCHEMA_VERSION;
  readonly dataset: {
    readonly name: "terminal-bench";
    readonly version: "2.0";
    readonly registryUrl: string;
    readonly registrySha256: string;
  };
  readonly generatedAt: string;
  readonly tasks: readonly LocalRealTask[];
  readonly containsTaskPrompts: false;
  readonly containsSolutions: false;
}

export interface LocalRealCampaignConfig {
  readonly schemaVersion: typeof LOCAL_REAL_SCHEMA_VERSION;
  readonly campaignId: string;
  readonly createdAt: string;
  readonly piRepository: string;
  readonly piOrigin: string;
  readonly baselineRevision: string;
  readonly credentialsFile: string;
  readonly claudeExecutable: string;
  readonly optimizer: {
    readonly provider: "microsoft-foundry";
    readonly baseUrl: string;
    readonly resourceName: string;
    readonly deployment: "claude-opus-5";
    readonly effort: "high";
    readonly maximumCostUsd: number;
    readonly maximumTurns: number;
    readonly timeoutMs: number;
  };
  readonly evaluatedAgent: {
    readonly provider: "microsoft-foundry";
    readonly deployment: "claude-opus-4-8";
    readonly thinking: "high";
  };
  readonly evaluation: {
    readonly harborVersion: "0.20.0";
    readonly datasetName: "terminal-bench";
    readonly datasetVersion: "2.0";
    readonly concurrency: number;
    readonly maximumPanelAttempts: number;
    readonly maximumInfrastructureRetries: number;
  };
  readonly budget: {
    readonly maximumCampaignCostUsd: number | null;
    readonly explicitlyUnbounded: boolean;
  };
  readonly publication: {
    readonly enabled: boolean;
    readonly remoteName: "origin";
  };
  readonly containsSecrets: false;
}

export type LocalRealCampaignStatus =
  | "initialized"
  | "running"
  | "stop-requested"
  | "stopped"
  | "blocked";

export type LocalRealExperimentPhase =
  | "panel-screening"
  | "optimizer"
  | "candidate-validation"
  | "candidate-evaluation"
  | "decision"
  | "publication"
  | "advance";

export interface LocalRealRetainedPanel {
  readonly taskNames: readonly string[];
  readonly championRevision: string;
}

export interface LocalRealActiveExperiment {
  readonly experimentNumber: number;
  readonly experimentId: string;
  readonly phase: LocalRealExperimentPhase;
  readonly startedAt: string;
}

export interface LocalRealCampaignState {
  readonly schemaVersion: typeof LOCAL_REAL_SCHEMA_VERSION;
  readonly campaignId: string;
  readonly revision: number;
  readonly status: LocalRealCampaignStatus;
  readonly championRevision: string;
  readonly nextExperimentNumber: number;
  readonly activeExperiment: LocalRealActiveExperiment | null;
  readonly retainedPanel: LocalRealRetainedPanel | null;
  readonly saturationHistory: readonly boolean[];
  readonly completedExperiments: number;
  readonly promotions: number;
  readonly totalCostUsd: number;
  readonly costLedger: readonly {
    readonly id: string;
    readonly amountUsd: number;
  }[];
  readonly consecutiveInfrastructureFailures: number;
  readonly stopReason: string | null;
  readonly blockedReason: string | null;
  readonly updatedAt: string;
  readonly containsSecrets: false;
}

export interface LocalRealObservation {
  readonly taskName: string;
  readonly repetition: 1 | 2 | 3;
  readonly reward: number;
  readonly infrastructureValid: boolean;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly cacheTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly trialName: string;
  readonly taskRevision: string;
  readonly resultPath: string;
}

export interface LocalRealArmReceipt {
  readonly schemaVersion: typeof LOCAL_REAL_SCHEMA_VERSION;
  readonly arm: "champion" | "candidate";
  readonly revision: string;
  readonly runtimeSha256: string;
  readonly jobName: string;
  readonly jobDirectory: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly observations: readonly LocalRealObservation[];
  readonly costUsd: number;
  readonly infrastructureValid: boolean;
  readonly containsSecrets: false;
}

export interface LocalRealPanelAttempt {
  readonly schemaVersion: typeof LOCAL_REAL_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly ordinal: number;
  readonly saturationPressure: number;
  readonly selectedTasks: readonly LocalRealTask[];
  readonly champion: LocalRealArmReceipt;
  readonly championMeanReward: number;
  readonly taskMeanRewards: Readonly<Record<string, number>>;
  readonly aggregateHeadroomSatisfied: boolean;
  readonly everyTaskHasHeadroom: boolean;
  readonly surpassable: boolean;
  readonly disposition: "accepted" | "saturated" | "infrastructure-invalid";
  readonly recordedAt: string;
  readonly containsSecrets: false;
}

export interface LocalRealOptimizerReceipt {
  readonly schemaVersion: typeof LOCAL_REAL_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly championRevision: string;
  readonly worktree: string;
  readonly transcriptPath: string;
  readonly stderrPath: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly model: "claude-opus-5";
  readonly costUsd: number;
  readonly turns: number;
  readonly hypothesisId: string;
  readonly hypothesisSummary: string;
  readonly interventionSummary: string;
  readonly containsTaskInformation: false;
  readonly containsSecrets: false;
}

export interface LocalRealCandidateReceipt {
  readonly schemaVersion: typeof LOCAL_REAL_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly parentRevision: string;
  readonly tree: string;
  readonly changedFiles: readonly string[];
  readonly patchPath: string;
  readonly patchSha256: string;
  readonly runtimeArchive: string | null;
  readonly runtimeSha256: string | null;
  readonly piEntrypoint: "pi/pi" | null;
  readonly validationCommands: readonly {
    readonly command: string;
    readonly logPath: string;
    readonly exitCode: number;
    readonly durationMs: number;
  }[];
  readonly valid: boolean;
  readonly invalidReason: string | null;
  readonly containsSecrets: false;
}

export interface LocalRealDecision {
  readonly schemaVersion: typeof LOCAL_REAL_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly disposition: "promote" | "reject" | "inconclusive";
  readonly reason:
    | "candidate-superior"
    | "candidate-inferior"
    | "aggregate-effect-too-small"
    | "insufficient-confidence"
    | "infrastructure-invalid"
    | "candidate-invalid";
  readonly candidateMeanReward: number | null;
  readonly championMeanReward: number;
  readonly meanRewardDelta: number | null;
  readonly taskWins: number;
  readonly taskLosses: number;
  readonly taskTies: number;
  readonly confidenceCandidateBetter: number;
  readonly minimumAggregateDelta: 0.05;
  readonly requiredConfidence: 0.95;
  readonly decidedAt: string;
  readonly containsSecrets: false;
}

export interface LocalRealRuntime {
  readonly revision: string;
  readonly tree: string;
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly piEntrypoint: "pi/pi";
}

export interface LocalRealRunnerAdapter {
  readonly ensureChampionRuntime: (
    config: LocalRealCampaignConfig,
    state: LocalRealCampaignState,
    experimentDirectory: string,
    signal?: AbortSignal,
  ) => Promise<LocalRealRuntime>;
  readonly evaluateArm: (input: {
    readonly config: LocalRealCampaignConfig;
    readonly experimentId: string;
    readonly experimentDirectory: string;
    readonly arm: "champion" | "candidate";
    readonly revision: string;
    readonly runtime: LocalRealRuntime;
    readonly tasks: readonly LocalRealTask[];
    readonly attemptOrdinal: number;
    readonly signal?: AbortSignal;
  }) => Promise<LocalRealArmReceipt>;
  readonly optimize: (input: {
    readonly config: LocalRealCampaignConfig;
    readonly state: LocalRealCampaignState;
    readonly experimentId: string;
    readonly experimentDirectory: string;
    readonly previousDecision: LocalRealDecision | null;
    readonly signal?: AbortSignal;
  }) => Promise<LocalRealOptimizerReceipt>;
  readonly validateAndBuild: (input: {
    readonly config: LocalRealCampaignConfig;
    readonly experimentId: string;
    readonly experimentDirectory: string;
    readonly optimizer: LocalRealOptimizerReceipt;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly candidate: LocalRealCandidateReceipt;
    readonly runtime: LocalRealRuntime | null;
  }>;
  readonly publish: (input: {
    readonly config: LocalRealCampaignConfig;
    readonly experimentId: string;
    readonly experimentDirectory: string;
    readonly worktree: string;
    readonly parentRevision: string;
    readonly candidateTree: string;
    readonly changedFiles: readonly string[];
    readonly timestamp: string;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly commit: string;
    readonly status: "published" | "already-published";
    readonly experimentRef: string;
    readonly championRef: string;
  }>;
}
