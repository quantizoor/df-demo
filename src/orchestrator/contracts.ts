import type { BudgetSnapshot, ChampionPointers, ExperimentIdentity } from "../domain/models.js";
import type { ReleaseSafeOnlineErrorBudgetAccounting } from "../evaluation/statistics.js";
import type { ReleaseSafeTerminalValidationAttemptAccounting } from "../evaluation/validation-attempt-ledger.js";

export interface DiagnosticBriefReference {
  readonly hash: string;
  readonly releaseId: string;
  readonly actionable: boolean;
}

export interface FrozenHypothesis {
  readonly hash: string;
  readonly sourceBriefHash: string | null;
  readonly causalClaim: string;
  readonly intervention: string;
  readonly predictedRepairBehavior: string;
  readonly predictedFreshEffect: string;
  readonly falsificationCriteria: readonly string[];
  readonly rollbackCondition: string;
}

export interface FrozenCandidate {
  readonly commit: string;
  readonly patchHash: string;
  readonly changedFiles: readonly string[];
  readonly mutationCategory: string;
}

export interface OptimizerProposal {
  readonly hypothesis: FrozenHypothesis;
  readonly candidate: FrozenCandidate;
}

export interface GateResult {
  readonly passed: boolean;
  readonly integrityPassed: boolean;
  readonly protocolHash: string;
  readonly checksHash: string;
  readonly aggregateCostUsd: number;
  readonly tokens: number;
  readonly wallTimeMs: number;
  readonly failureCode: string | null;
}

export interface EphemeralPanelLease {
  readonly leaseToken: string;
  readonly attestationHash: string;
  readonly expectedValidArms: number;
  readonly maximumAttempts: number;
}

export interface RepairAggregate {
  readonly disposition: "passed" | "rejected" | "inconclusive";
  readonly attemptOrdinal: 1 | 2;
  readonly integrityPassed: boolean;
  readonly cacheStatus: "not-used" | "eligible" | "miss" | "drift-failed";
  readonly aggregateCostUsd: number;
  readonly tokens: number;
  readonly wallTimeMs: number;
  readonly attempts: number;
  readonly attestationHash: string;
}

export interface ValidationAggregate {
  readonly disposition: "promoted" | "rejected" | "inconclusive";
  readonly validPairs: number;
  readonly validArms: number;
  readonly replacementAttempts: number;
  readonly probabilityPositive: number;
  readonly medianAccuracyDelta: number;
  readonly requiredPosteriorProbability: number;
  readonly onlineGateAuthorized: boolean;
  readonly onlineErrorBudget: ReleaseSafeOnlineErrorBudgetAccounting;
  readonly stratumRegressionVeto: boolean;
  readonly integrityVeto: boolean;
  readonly correctnessVeto: boolean;
  readonly capabilityVeto: boolean;
  readonly costWithinGuardrail: boolean;
  readonly latencyWithinGuardrail: boolean;
  readonly accuracyTradeoffPredeclared: boolean;
  readonly aggregateCostUsd: number;
  readonly tokens: number;
  readonly wallTimeMs: number;
  readonly attestationHash: string;
  readonly releasedEvidenceHash: string | null;
  readonly behavioralSourceCommitmentHash: string | null;
  readonly attemptAccounting: ReleaseSafeTerminalValidationAttemptAccounting;
}

export interface OptimizerContext {
  readonly experiment: ExperimentIdentity;
  readonly activeChampion: ChampionPointers;
  readonly diagnosticBrief: DiagnosticBriefReference | null;
  readonly sourceOnlyBootstrap: boolean;
}

export interface OptimizerAdapter {
  propose(context: OptimizerContext): Promise<OptimizerProposal>;
  analyze(input: {
    readonly experiment: ExperimentIdentity;
    readonly hypothesis: FrozenHypothesis;
    readonly candidate: FrozenCandidate;
    readonly repair: RepairAggregate | null;
    readonly validation: ValidationAggregate | null;
  }): Promise<{ readonly hash: string; readonly rollbackRequired: boolean }>;
}

export interface CorrectnessGateRunner {
  run(input: {
    readonly experiment: ExperimentIdentity;
    readonly hypothesis: FrozenHypothesis;
    readonly candidate: FrozenCandidate;
  }): Promise<GateResult>;
}

export interface BlindBroker {
  prepareRepair(input: {
    readonly experiment: ExperimentIdentity;
    readonly hypothesisHash: string;
    readonly candidateCommit: string;
    readonly previousDiscoveryAttestationHash: string;
    readonly attemptOrdinal: 1 | 2;
  }): Promise<EphemeralPanelLease>;
  runRepair(input: {
    readonly experiment: ExperimentIdentity;
    readonly leaseToken: string;
    readonly candidateCommit: string;
    readonly activeChampionCommit: string;
  }): Promise<RepairAggregate>;
  prepareValidation(input: {
    readonly experiment: ExperimentIdentity;
    readonly hypothesisHash: string;
    readonly candidateCommit: string;
    readonly excludedEvidenceHashes: readonly string[];
    readonly remainingExperimentAttempts: number;
    readonly diagnosticReleaseAuthorized: boolean;
  }): Promise<EphemeralPanelLease>;
  runValidation(input: {
    readonly experiment: ExperimentIdentity;
    readonly leaseToken: string;
    readonly candidateCommit: string;
    readonly activeChampionCommit: string;
  }): Promise<ValidationAggregate>;
  consumeOrQuarantine(input: {
    readonly leaseToken: string;
    readonly attestationHash: string;
    readonly outcome: "decided" | "started-abandoned" | "sealed-unstarted";
  }): Promise<{ readonly dispositionAttestationHash: string }>;
  releaseDiagnosticBrief(input: {
    readonly experiment: ExperimentIdentity;
    readonly validationAttestationHash: string;
    readonly releaseAuthorized: true;
  }): Promise<DiagnosticBriefReference | null>;
}

export interface ExperimentJournal {
  create(input: {
    readonly experiment: ExperimentIdentity;
    readonly activeChampionBefore: ChampionPointers;
    readonly initialBudget: BudgetSnapshot;
  }): Promise<void>;
  freezeProposal(input: {
    readonly experiment: ExperimentIdentity;
    readonly proposal: OptimizerProposal;
  }): Promise<void>;
  recordGates(input: {
    readonly experiment: ExperimentIdentity;
    readonly gates: GateResult;
  }): Promise<void>;
  recordRepair(input: {
    readonly experiment: ExperimentIdentity;
    readonly repair: RepairAggregate;
  }): Promise<void>;
  recordValidation(input: {
    readonly experiment: ExperimentIdentity;
    readonly validation: ValidationAggregate;
    readonly panelDispositionAttestationHash: string;
  }): Promise<void>;
  recordAnalysis(input: {
    readonly experiment: ExperimentIdentity;
    readonly analysisHash: string;
  }): Promise<void>;
  updateBudget(snapshot: BudgetSnapshot): Promise<void>;
  seal(input: {
    readonly experiment: ExperimentIdentity;
    readonly disposition: "promoted" | "rejected" | "inconclusive";
    readonly activeChampionBefore: ChampionPointers;
    readonly promotedCandidate: {
      readonly experimentNumber: number;
      readonly commit: string;
      readonly decidedAt: string;
    } | null;
    readonly diagnosticBrief: DiagnosticBriefReference | null;
  }): Promise<{
    readonly sealHash: string;
    readonly activeChampionAfter: ChampionPointers;
  }>;
  interrupt(input: {
    readonly experiment: ExperimentIdentity;
    readonly phase: string;
    readonly reason: string;
  }): Promise<void>;
}

export interface StopController {
  readonly requested: boolean;
}

export interface ExperimentRunInput {
  readonly experiment: ExperimentIdentity;
  readonly activeChampion: ChampionPointers;
  readonly budget: BudgetSnapshot;
  readonly diagnosticBrief: DiagnosticBriefReference | null;
  readonly previousDiscoveryAttestationHash: string | null;
  readonly repairAttemptOrdinal: 1 | 2;
  readonly stop: StopController;
}

export interface ExperimentRunResult {
  readonly disposition: "promoted" | "rejected" | "inconclusive";
  readonly activeChampion: ChampionPointers;
  readonly budget: BudgetSnapshot;
  readonly diagnosticBrief: DiagnosticBriefReference | null;
  readonly sealHash: string;
}
