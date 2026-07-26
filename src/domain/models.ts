export const RUN_MODES = ["research", "submission"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const LEADERBOARD_ELIGIBILITY = [
  "unverified",
  "cleared",
  "strict-score-only",
] as const;
export type LeaderboardEligibility = (typeof LEADERBOARD_ELIGIBILITY)[number];

export const EXPERIMENT_STATES = [
  "planned",
  "candidate-ready",
  "gates-passed",
  "repair-evaluating",
  "challenger",
  "validation-evaluating",
  "analyzed",
  "promoted",
  "rejected",
  "inconclusive",
  "shadow-evaluating",
  "certified",
  "not-certified",
  "sealed",
] as const;
export type ExperimentState = (typeof EXPERIMENT_STATES)[number];

export const EXPERIMENT_KINDS = ["baseline", "optimization", "shadow"] as const;
export type ExperimentKind = (typeof EXPERIMENT_KINDS)[number];

export const DISPOSITIONS = [
  "baseline",
  "promoted",
  "rejected",
  "inconclusive",
  "certified",
  "not-certified",
  "interrupted",
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export interface VersionedPolicySet {
  readonly protocol: string;
  readonly broker: string;
  readonly weighting: string;
  readonly normalizer: string;
  readonly extractor: string;
  readonly statistics: string;
  readonly privacy: string;
  readonly cache: string;
  readonly decision: string;
  readonly integrity: string;
  readonly retention: string;
}

export interface ModelIdentity {
  readonly provider: string;
  readonly model: string;
  readonly providerVersion: string;
  readonly reasoning: string;
  readonly samplingHash: string;
  readonly contextWindow: number;
}

export interface SandboxIdentity {
  readonly provider: "daytona" | "e2b" | "modal";
  readonly imageDigest: string;
  readonly architecture: string;
  readonly regionClass: string;
  readonly resourceProfile: string;
  readonly networkPolicyHash: string;
}

export interface BenchmarkIdentity {
  readonly name: "terminal-bench";
  readonly version: "2.1";
  readonly datasetRevision: string;
  readonly datasetDigest: string;
  readonly harborVersion: string;
  readonly timeoutPolicyHash: string;
  readonly resourcePolicyHash: string;
}

export interface HarnessIdentity {
  readonly repositoryRegistrationId: string;
  readonly forkCommit: string;
  readonly upstreamCommit: string;
  readonly lockHash: string;
  readonly configurationHash: string;
}

export interface OptimizerIdentity {
  readonly claudeCodeVersion: string;
  readonly model: string;
  readonly permissionPolicyHash: string;
  readonly pluginHash: string;
}

export interface ProtocolInputs {
  readonly schemaVersion: "1.0.0";
  readonly mode: RunMode;
  readonly leaderboardEligibility: LeaderboardEligibility;
  readonly benchmark: BenchmarkIdentity;
  readonly harness: HarnessIdentity;
  readonly optimizer: OptimizerIdentity;
  readonly evaluatedModel: ModelIdentity;
  readonly sandbox: SandboxIdentity;
  readonly policies: VersionedPolicySet;
}

export interface BudgetLimits {
  readonly maximumUsd: number;
  readonly maximumTokens: number;
  readonly maximumWallTimeMs: number;
  readonly maximumAttempts: number;
  readonly maximumPrivacyReleases: number;
  readonly maximumPromotionLooks: number;
  /**
   * Predeclared family-wise online error budget. The trusted evaluator spends
   * it before a fresh promotion outcome can be observed.
   */
  readonly maximumOnlineError: number;
}

export interface BudgetUsage {
  readonly spentUsd: number;
  readonly tokens: number;
  readonly wallTimeMs: number;
  readonly attempts: number;
  readonly privacyReleases: number;
  readonly promotionLooks: number;
  readonly onlineErrorSpent: number;
}

export interface BudgetSnapshot {
  readonly limits: BudgetLimits;
  readonly usage: BudgetUsage;
}

export interface ChampionPointers {
  readonly baselineCommit: string;
  readonly activeExperiment: number;
  readonly activeCommit: string;
  readonly certifiedExperiment: number | null;
  readonly certifiedCommit: string | null;
  readonly updatedAt: string;
  readonly sourceSealHash: string;
}

export interface ComplianceChannels {
  readonly diagnosticBriefs: boolean;
  readonly repairFeedback: boolean;
  readonly optimizerMcp: boolean;
  readonly adaptiveTaskSelection: boolean;
  readonly officialEvaluation: boolean;
}

export interface ComplianceManifest {
  readonly schemaVersion: "1.0.0";
  readonly mode: RunMode;
  readonly leaderboardEligibility: LeaderboardEligibility;
  readonly protocolHash: string;
  readonly lineageId: string;
  readonly channels: ComplianceChannels;
  readonly optimizerHasBenchmarkCredentials: false;
  readonly localRawEvidenceAllowed: false;
  readonly createdAt: string;
  readonly signature: string;
  readonly signerKeyId: string;
}

export interface ExperimentIdentity {
  readonly number: number;
  readonly slug: string;
  readonly kind: ExperimentKind;
  readonly parentExperiment: number | null;
  readonly lineageId: string;
  readonly protocolHash: string;
}

export interface CampaignStatus {
  readonly mode: RunMode;
  readonly protocolHash: string;
  readonly lineageId: string;
  readonly nextExperiment: number;
  readonly activeChampion: ChampionPointers;
  readonly budget: BudgetSnapshot;
  readonly freshValidationPanelsRemaining: number;
  readonly shadowSlicesRemaining: number;
  readonly stopRequested: boolean;
}
