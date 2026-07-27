export type OperationalStatus =
  | "ready"
  | "initialized"
  | "starting"
  | "running"
  | "stopping"
  | "stop-requested"
  | "stopped"
  | "blocked"
  | "interrupted";

export interface CampaignSummary {
  campaignId: string;
  operationalStatus: OperationalStatus;
  durableStatus?: string;
  runnerLive?: boolean;
  stopRequested?: boolean;
  championRevision?: string;
  baselineRevision?: string;
  activeExperiment?: {
    experimentId: string;
    experimentNumber?: number;
    phase?: string;
    startedAt?: string;
  } | null;
  completedExperiments?: number;
  promotions?: number;
  totalCostUsd?: number;
  maximumCampaignCostUsd?: number | null;
  saturationRate?: number;
  stopReason?: string | null;
  blockedReason?: string | null;
  updatedAt?: string;
  createdAt?: string;
}

export interface CampaignDetail extends CampaignSummary {
  config?: {
    piRepository?: string;
    piOrigin?: string;
    credentialsFile?: string;
    claudeExecutable?: string;
    optimizer?: {
      provider?: string;
      deployment?: string;
      effort?: string;
      maximumCostUsd?: number;
      maximumTurns?: number;
      timeoutMs?: number;
    };
    evaluatedAgent?: {
      provider?: string;
      deployment?: string;
      thinking?: string;
    };
    evaluation?: {
      harborVersion?: string;
      datasetName?: string;
      datasetVersion?: string;
      concurrency?: number;
      maximumPanelAttempts?: number;
      maximumInfrastructureRetries?: number;
    };
    publication?: {
      enabled?: boolean;
      remoteName?: string;
    };
  };
  recentExperiments?: ExperimentSummary[];
  tasks?: TaskHealth[];
  taskHealth?: TaskHealth[];
  samplingWeights?: Record<string, number>;
  configuration?: {
    piRepository?: string;
    piOrigin?: string;
    optimizerDeployment?: string;
    evaluatedDeployment?: string;
    optimizerMaximumCostUsd?: number;
    optimizerMaximumTurns?: number;
    maximumPanelAttempts?: number;
    evaluationConcurrency?: number;
    publicationEnabled?: boolean;
    publicationRemote?: string;
    explicitlyUnbounded?: boolean;
  };
  harborProgress?: HarborProgress | null;
}

export interface ExperimentSummary {
  experimentId: string;
  experimentNumber?: number;
  status?: string;
  phase?: string;
  startedAt?: string;
  completedAt?: string | null;
  hypothesisSummary?: string | null;
  disposition?: "promote" | "reject" | "inconclusive" | string | null;
  candidateMeanReward?: number | null;
  championMeanReward?: number | null;
  meanRewardDelta?: number | null;
  confidenceCandidateBetter?: number | null;
  costUsd?: number;
  durationMs?: number;
  changedFiles?: number | string[];
}

export interface Observation {
  taskName: string;
  repetition: number;
  reward: number;
  infrastructureValid: boolean;
  durationMs?: number;
  inputTokens?: number;
  cacheTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  arm?: "champion" | "candidate";
}

export interface PanelAttempt {
  ordinal: number;
  saturationPressure?: number;
  selectedTasks?: Array<{
    name: string;
    difficulty?: string;
    empiricalFailureRate?: number;
  }>;
  championMeanReward?: number;
  aggregateHeadroomSatisfied?: boolean;
  everyTaskHasHeadroom?: boolean;
  surpassable?: boolean;
  disposition?: string;
  recordedAt?: string;
}

export type HarborTrialStatus = "pending" | "running" | "completed" | "error" | "cancelled";

export interface HarborTrialProgress {
  taskName: string;
  trialName: string | null;
  status: HarborTrialStatus;
  reward: number | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  cacheTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface HarborProgress {
  arm: "champion" | "candidate";
  panelAttempt: number;
  status: HarborTrialStatus;
  taskNames: string[];
  totalTrials: number;
  completedTrials: number;
  runningTrials: number;
  pendingTrials: number;
  erroredTrials: number;
  cancelledTrials: number;
  inputTokens: number | null;
  cacheTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  trials: HarborTrialProgress[];
}

export type TaskLogSource =
  | "job"
  | "trial"
  | "agent"
  | "trajectory"
  | "verifier"
  | "reward"
  | "exception";

export interface TaskLogDescriptor {
  id: string;
  taskName: string | null;
  trialName: string | null;
  status: HarborTrialStatus;
  reward: number | null;
  source: TaskLogSource;
  label: string;
  contentType: "text/plain" | "application/json" | "application/jsonl";
  sizeBytes: number;
  updatedAt: string;
}

export interface TaskLogIndex {
  experimentId: string;
  arm: "champion" | "candidate";
  panelAttempt: number;
  status: HarborTrialStatus;
  updatedAt: string;
  credentialValuesRedacted: true;
  logs: TaskLogDescriptor[];
}

export interface TaskLogChunk {
  id: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
  encoding: "utf8";
  content: string;
}

export interface ArtifactDescriptor {
  id: string;
  category?: string;
  label: string;
  contentType?: string;
  sizeBytes?: number;
  updatedAt?: string;
  streamable?: boolean;
}

export interface OptimizerPreviousDecision {
  schemaVersion?: string;
  experimentId?: string;
  disposition?: "promote" | "reject" | "inconclusive" | string;
  reason?: string;
  candidateMeanReward?: number | null;
  championMeanReward?: number | null;
  meanRewardDelta?: number | null;
  taskWins?: number;
  taskLosses?: number;
  taskTies?: number;
  confidenceCandidateBetter?: number;
  minimumAggregateDelta?: number;
  requiredConfidence?: number;
  decidedAt?: string;
  containsSecrets?: false;
}

export interface OptimizerExecutionContract {
  model?: string;
  effort?: string;
  maximumCostUsd?: number;
  maximumTurns?: number;
  timeoutMs?: number;
  outputFormat?: string;
  permissionMode?: string;
  sessionPersistence?: boolean;
  browserEnabled?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  shellEnabled?: boolean;
  networkToolsEnabled?: boolean;
  providerApiNetworkRequired?: boolean;
}

export interface OptimizerSourceContext {
  kind?: string;
  repositoryOrigin?: string;
  championRevision?: string;
  candidateTree?: string | null;
  readableScope?: string;
  editableRoots?: string[];
  instructionFiles?: string[];
  instructionFileSha256?: Record<string, string>;
  restrictionsEnforcedBy?: string;
  postRunChangeValidation?: string;
}

export interface OptimizerEnvironmentEntry {
  name: string;
  value?: string | null;
  secret?: boolean;
  description?: string | null;
}

export interface OptimizerAuditAttempt {
  ordinal: number;
  status?: "running" | "completed" | "interrupted" | string;
  startedAt?: string | null;
  completedAt?: string | null;
  championRevision?: string;
  prompt?: string;
  promptSha256?: string;
  previousDecision?: OptimizerPreviousDecision | null;
  boundary?: {
    taskCatalogVisible?: boolean | null;
    panelVisible?: boolean | null;
    graderVisible?: boolean | null;
    rawEvaluationVisible?: boolean | null;
  };
  executionContract?: OptimizerExecutionContract | null;
  sourceContext?: OptimizerSourceContext | null;
  environment?: OptimizerEnvironmentEntry[];
  inputArtifactId?: string | null;
  invocationArtifactId?: string | null;
  transcriptArtifactId?: string | null;
  stderrArtifactId?: string | null;
}

export interface OptimizerAudit {
  latestAttemptOrdinal?: number | null;
  credentialValuesRedacted?: boolean;
  disclosureNotes?: string[];
  attempts?: OptimizerAuditAttempt[];
}

export interface ExperimentDetail extends ExperimentSummary {
  championRevision?: string;
  candidateRevision?: string | null;
  optimizer?: {
    hypothesisId?: string;
    hypothesisSummary?: string;
    interventionSummary?: string;
    model?: string;
    turns?: number;
    costUsd?: number;
    startedAt?: string;
    completedAt?: string;
  } | null;
  optimizerAudit?: OptimizerAudit | null;
  candidate?: {
    valid?: boolean;
    invalidReason?: string | null;
    changedFiles?: string[];
    patchArtifactId?: string | null;
    patchPath?: string;
    validationCommands?: Array<{
      command: string;
      exitCode: number;
      durationMs?: number;
      logArtifactId?: string;
    }>;
  } | null;
  decision?: {
    disposition?: string;
    reason?: string;
    candidateMeanReward?: number | null;
    championMeanReward?: number | null;
    meanRewardDelta?: number | null;
    taskWins?: number;
    taskLosses?: number;
    taskTies?: number;
    confidenceCandidateBetter?: number;
    minimumAggregateDelta?: number;
    requiredConfidence?: number;
    decidedAt?: string;
  } | null;
  panelAttempts?: PanelAttempt[];
  championEvaluation?: {
    arm: "champion";
    revision: string;
    startedAt: string;
    completedAt: string;
    costUsd: number;
    infrastructureValid: boolean;
    observations: Observation[];
  } | null;
  candidateEvaluation?: {
    arm: "candidate";
    revision: string;
    startedAt: string;
    completedAt: string;
    costUsd: number;
    infrastructureValid: boolean;
    observations: Observation[];
  } | null;
  harborProgress?: HarborProgress | null;
  validationCommands?: Array<{
    command: string;
    exitCode: number;
    durationMs?: number;
    logArtifactId?: string | null;
  }>;
  publication?: {
    commit: string;
    status?: string | null;
    experimentRef?: string | null;
    championRef?: string | null;
  } | null;
  artifacts?: ArtifactDescriptor[];
}

export interface PerformancePoint {
  experimentId: string;
  experimentNumber?: number;
  completedAt?: string;
  championMeanReward?: number | null;
  candidateMeanReward?: number | null;
  meanRewardDelta?: number | null;
  promoted?: boolean;
  panelDigest?: string | null;
  costUsd?: number;
  cumulativeCostUsd?: number;
  durationMs?: number;
  saturationPressure?: number;
  panelAttempts?: number;
}

export interface TaskHealth {
  name: string;
  difficulty?: string;
  selections?: number;
  empiricalFailureRate?: number;
}

export interface ArtifactChunk {
  id?: string;
  content: string;
  offset?: number;
  nextOffset?: number;
  eof?: boolean;
}

export interface ReadinessCheck {
  id: string;
  label: string;
  status: "pass" | "fail";
  detail: string;
}

export interface ReadinessReport {
  ready: boolean;
  checks: ReadinessCheck[];
  containsSecrets: false;
}
