import type {
  LocalRealCampaignState,
  LocalRealDecision,
  LocalRealExperimentPhase,
} from "../real/contracts.js";
import type { LocalRealStopMode } from "../real/state.js";

export type DashboardOperationalStatus =
  | "ready"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "blocked"
  | "interrupted";

export interface DashboardCampaignSummary {
  readonly campaignId: string;
  readonly createdAt: string;
  readonly operationalStatus: DashboardOperationalStatus;
  readonly durableStatus: LocalRealCampaignState["status"];
  readonly runnerLive: boolean;
  readonly stopRequested: boolean;
  readonly stopMode: LocalRealStopMode | null;
  readonly activeExperiment: {
    readonly experimentId: string;
    readonly experimentNumber: number;
    readonly phase: LocalRealExperimentPhase;
    readonly startedAt: string;
  } | null;
  readonly championRevision: string;
  readonly baselineRevision: string;
  readonly completedExperiments: number;
  readonly promotions: number;
  readonly totalCostUsd: number;
  readonly maximumCampaignCostUsd: number | null;
  readonly saturationRate: number;
  readonly taskCount: number;
  readonly stopReason: string | null;
  readonly blockedReason: string | null;
  readonly updatedAt: string;
}

export interface DashboardCampaignDetail extends DashboardCampaignSummary {
  readonly configuration: {
    readonly piOrigin: string;
    readonly optimizerDeployment: string;
    readonly evaluatedDeployment: string;
    readonly optimizerMaximumCostUsd: number;
    readonly optimizerMaximumTurns: number;
    readonly maximumPanelAttempts: number;
    readonly evaluationConcurrency: number;
    readonly publicationEnabled: boolean;
    readonly publicationRemote: string;
    readonly explicitlyUnbounded: boolean;
  };
  readonly taskHealth: readonly {
    readonly name: string;
    readonly difficulty: "easy" | "medium" | "hard";
    readonly empiricalFailureRate: number;
    readonly selections: number;
  }[];
  readonly harborProgress: DashboardHarborProgress | null;
}

export interface DashboardCreateCampaignInput {
  readonly stateRoot: string;
  readonly campaignId: string;
  readonly budget:
    | { readonly type: "capped"; readonly maximumUsd: number }
    | { readonly type: "unbounded"; readonly explicitlyConfirmed: true };
  readonly piRepository?: string;
  readonly credentialsFile?: string;
  readonly claudeExecutable?: string;
}

export interface DashboardCampaignControlResult {
  readonly accepted: boolean;
  readonly campaign: DashboardCampaignSummary;
  readonly message: string;
}

export interface DashboardExperimentSummary {
  readonly experimentId: string;
  readonly experimentNumber: number;
  readonly championRevision: string | null;
  readonly candidateRevision: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly phase: LocalRealExperimentPhase | "completed" | "unknown";
  readonly hypothesisSummary: string | null;
  readonly disposition: LocalRealDecision["disposition"] | null;
  readonly championMeanReward: number | null;
  readonly candidateMeanReward: number | null;
  readonly meanRewardDelta: number | null;
  readonly confidenceCandidateBetter: number | null;
  readonly costUsd: number | null;
  readonly changedFiles: readonly string[];
  readonly panelDigest: string | null;
  readonly publicationCommit: string | null;
}

export interface DashboardExperimentPage {
  readonly items: readonly DashboardExperimentSummary[];
  readonly nextCursor: string | null;
}

export interface DashboardOptimizerDetail {
  readonly model: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly turns: number;
  readonly costUsd: number;
  readonly hypothesisId: string;
  readonly hypothesisSummary: string;
  readonly interventionSummary: string;
}

export interface DashboardOptimizerExecutionContract {
  readonly model: string;
  readonly effort: string;
  readonly maximumCostUsd: number;
  readonly maximumTurns: number;
  readonly timeoutMs: number;
  readonly outputFormat: string;
  readonly permissionMode: string;
  readonly sessionPersistence: boolean;
  readonly browserEnabled: boolean;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly shellEnabled: boolean;
  readonly networkToolsEnabled: boolean;
  readonly providerApiNetworkRequired: boolean;
}

export interface DashboardOptimizerSourceContext {
  readonly kind: string;
  readonly repositoryOrigin: string;
  readonly championRevision: string;
  readonly candidateTree: string | null;
  readonly readableScope: string;
  readonly editableRoots: readonly string[];
  readonly instructionFiles: readonly string[];
  readonly instructionFileSha256: Readonly<Record<string, string>>;
  readonly restrictionsEnforcedBy: string;
  readonly postRunChangeValidation: string;
}

export interface DashboardOptimizerEnvironmentEntry {
  readonly name: string;
  readonly value: string | null;
  readonly secret: boolean;
  readonly description: string | null;
}

export interface DashboardOptimizerAuditAttempt {
  readonly ordinal: number;
  readonly status: "running" | "completed" | "interrupted";
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly championRevision: string;
  readonly prompt: string;
  readonly promptSha256: string;
  readonly previousDecision: LocalRealDecision | null;
  readonly boundary: {
    readonly taskCatalogVisible: boolean | null;
    readonly panelVisible: boolean | null;
    readonly graderVisible: boolean | null;
    readonly rawEvaluationVisible: boolean | null;
  };
  readonly executionContract: DashboardOptimizerExecutionContract | null;
  readonly sourceContext: DashboardOptimizerSourceContext | null;
  readonly environment: readonly DashboardOptimizerEnvironmentEntry[];
  readonly inputArtifactId: string | null;
  readonly invocationArtifactId: string | null;
  readonly transcriptArtifactId: string | null;
  readonly stderrArtifactId: string | null;
}

export interface DashboardOptimizerAudit {
  readonly latestAttemptOrdinal: number | null;
  readonly credentialValuesRedacted: true;
  readonly disclosureNotes: readonly string[];
  readonly attempts: readonly DashboardOptimizerAuditAttempt[];
}

export interface DashboardObservation {
  readonly taskName: string;
  readonly repetition: number;
  readonly reward: number;
  readonly infrastructureValid: boolean;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly cacheTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface DashboardArmDetail {
  readonly arm: "champion" | "candidate";
  readonly revision: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly costUsd: number;
  readonly infrastructureValid: boolean;
  readonly observations: readonly DashboardObservation[];
}

export interface DashboardValidationCommand {
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly logArtifactId: string | null;
}

export interface DashboardCandidateDetail {
  readonly parentRevision: string;
  readonly tree: string;
  readonly changedFiles: readonly string[];
  readonly valid: boolean;
  readonly invalidReason: string | null;
  readonly patchArtifactId: string | null;
  readonly validationCommands: readonly DashboardValidationCommand[];
}

export interface DashboardPanelAttemptDetail {
  readonly ordinal: number;
  readonly saturationPressure: number;
  readonly selectedTasks: readonly {
    readonly name: string;
    readonly difficulty: "easy" | "medium" | "hard";
    readonly empiricalFailureRate: number;
    readonly selections: number;
  }[];
  readonly champion: DashboardArmDetail;
  readonly championMeanReward: number;
  readonly taskMeanRewards: Readonly<Record<string, number>>;
  readonly aggregateHeadroomSatisfied: boolean;
  readonly everyTaskHasHeadroom: boolean;
  readonly surpassable: boolean;
  readonly disposition: "accepted" | "saturated" | "infrastructure-invalid";
  readonly recordedAt: string;
}

export type DashboardHarborTrialStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "cancelled";

export interface DashboardHarborTrialProgress {
  readonly taskName: string;
  readonly trialName: string | null;
  readonly status: DashboardHarborTrialStatus;
  readonly reward: number | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly inputTokens: number | null;
  readonly cacheTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
}

export interface DashboardHarborProgress {
  readonly arm: "champion" | "candidate";
  readonly panelAttempt: number;
  readonly status: DashboardHarborTrialStatus;
  readonly taskNames: readonly string[];
  readonly totalTrials: number;
  readonly completedTrials: number;
  readonly runningTrials: number;
  readonly pendingTrials: number;
  readonly erroredTrials: number;
  readonly cancelledTrials: number;
  readonly inputTokens: number | null;
  readonly cacheTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly trials: readonly DashboardHarborTrialProgress[];
}

export type DashboardTaskLogSource =
  | "job"
  | "trial"
  | "agent"
  | "trajectory"
  | "verifier"
  | "reward"
  | "exception";

export interface DashboardTaskLogDescriptor {
  readonly id: string;
  readonly taskName: string | null;
  readonly trialName: string | null;
  readonly status: DashboardHarborTrialStatus;
  readonly reward: number | null;
  readonly source: DashboardTaskLogSource;
  readonly label: string;
  readonly contentType: "text/plain" | "application/json" | "application/jsonl";
  readonly sizeBytes: number;
  readonly updatedAt: string;
}

export interface DashboardTaskLogIndex {
  readonly experimentId: string;
  readonly arm: "champion" | "candidate";
  readonly panelAttempt: number;
  readonly status: DashboardHarborTrialStatus;
  readonly updatedAt: string;
  readonly credentialValuesRedacted: true;
  readonly logs: readonly DashboardTaskLogDescriptor[];
}

export interface DashboardTaskLogChunk {
  readonly id: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly eof: boolean;
  readonly encoding: "utf8";
  readonly content: string;
}

export interface DashboardPublicationDetail {
  readonly commit: string;
  readonly status: string | null;
  readonly experimentRef: string | null;
  readonly championRef: string | null;
}

export interface DashboardExperimentDetail extends DashboardExperimentSummary {
  readonly panelAttempts: readonly DashboardPanelAttemptDetail[];
  readonly optimizer: DashboardOptimizerDetail | null;
  readonly optimizerAudit: DashboardOptimizerAudit;
  readonly candidate: DashboardCandidateDetail | null;
  readonly championEvaluation: DashboardArmDetail | null;
  readonly candidateEvaluation: DashboardArmDetail | null;
  readonly harborProgress: DashboardHarborProgress | null;
  readonly decision: LocalRealDecision | null;
  readonly publication: DashboardPublicationDetail | null;
  readonly validationCommands: readonly DashboardValidationCommand[];
  readonly artifacts: readonly DashboardArtifactDescriptor[];
}

export interface DashboardPerformancePoint {
  readonly experimentId: string;
  readonly experimentNumber: number;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly panelDigest: string | null;
  readonly championMeanReward: number | null;
  readonly candidateMeanReward: number | null;
  readonly meanRewardDelta: number | null;
  readonly promoted: boolean;
  readonly costUsd: number | null;
  readonly cumulativeCostUsd: number;
  readonly confidenceCandidateBetter: number | null;
}

export type DashboardArtifactCategory =
  | "optimizer"
  | "validation"
  | "evaluation"
  | "code"
  | "publication"
  | "experiment";

export interface DashboardArtifactDescriptor {
  readonly id: string;
  readonly category: DashboardArtifactCategory;
  readonly label: string;
  readonly contentType: "text/plain" | "application/json" | "application/jsonl" | "text/x-diff";
  readonly sizeBytes: number;
  readonly updatedAt: string;
  readonly streamable: boolean;
}

export interface DashboardArtifactChunk {
  readonly id: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly eof: boolean;
  readonly encoding: "utf8";
  readonly content: string;
}

export interface DashboardCampaignEventSnapshot {
  readonly revision: string;
  readonly campaign: DashboardCampaignSummary;
}

export type DashboardReadinessCheckStatus = "pass" | "fail";

export interface DashboardReadinessCheck {
  readonly id: string;
  readonly label: string;
  readonly status: DashboardReadinessCheckStatus;
  readonly detail: string;
}

export interface DashboardReadinessReport {
  readonly ready: boolean;
  readonly checks: readonly DashboardReadinessCheck[];
  readonly containsSecrets: false;
}

export interface DashboardReadinessInput {
  readonly stateRoot: string;
  readonly projectRoot?: string;
  readonly piRepository?: string;
  readonly credentialsFile?: string;
  readonly claudeExecutable?: string;
}
