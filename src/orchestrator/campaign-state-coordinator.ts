import {
  CampaignConflictError,
  type CampaignHistory,
  type CampaignLedgerPointers,
  type CampaignStateStore,
  type ExperimentAllocation,
  type SealExperimentInput,
} from "../campaign/index.js";
import { remainingBudget, validateBudgetSnapshot } from "../core/budget.js";
import type { BudgetSnapshot, ChampionPointers } from "../domain/models.js";
import {
  assertTrustedOnlineErrorBudgetReconciliation,
  onlineErrorBudgetCampaignIdHash,
  type TrustedOnlineErrorBudgetReconciliation,
} from "../evaluator/online-error-authority.js";
import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import type { CampaignPauseReason, CampaignState, CampaignStopReason } from "../schemas/control.js";
import type {
  ClaimedOptimizationExperiment,
  OptimizationClaim,
  OptimizationLoopSnapshot,
  ProductionOptimizationCoordinator,
} from "./autonomous-loop.js";
import type { ExperimentRunInput, ExperimentRunResult } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const OPAQUE_DIAGNOSTIC_RELEASE_ID = /^diagnostic[-:](?:[0-9]{1,12}|[a-f0-9]{16,64})$/u;

export type OptimizationFailureClass = Parameters<
  ProductionOptimizationCoordinator["interrupt"]
>[0]["failureClass"];

/**
 * Structural surface used by the adapter. A CampaignStateStore satisfies this
 * interface; tests can supply a deterministic in-memory implementation.
 */
export type OptimizationCampaignStateStore = Pick<
  CampaignStateStore,
  | "reconstruct"
  | "allocateExperiment"
  | "recordBudgetUsage"
  | "sealExperiment"
  | "archiveInterruptedExperiment"
  | "pause"
  | "requestStop"
  | "acknowledgeStopped"
>;

export interface OptimizationInputPreparationContext {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.optimization-input-preparation.v1";
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly priorStateHash: string;
  readonly allocationStateHash: string;
  readonly allocationSnapshot: OptimizationLoopSnapshot;
  readonly experimentNumber: number;
  readonly sourceOnlyBootstrap: boolean;
}

export interface PersistedOptimizationClaimBinding {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.optimization-claim-binding.v1";
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly experimentNumber: number;
  readonly priorStateHash: string;
  readonly allocationStateHash: string;
  readonly claimHash: string;
  readonly inputHash: string;
  readonly previousDiscoveryAttestationHash: string | null;
  readonly repairAttemptOrdinal: 1 | 2;
}

/**
 * This port lives in the trusted controller boundary. Implementations must
 * durably key preparation by allocationStateHash and reproduce byte-identical
 * input after a crash. Its private discovery ledger must advance repair
 * ordinals 1 -> 2 for the same discovery, never reset an ordinal, and bind
 * both ordinals to the broker's same five-task repair reuse record. The
 * returned type has no task/panel identity field.
 */
export interface TrustedOptimizationInputFactory {
  readonly boundary: "trusted-cloud";
  prepareOrResume(context: OptimizationInputPreparationContext): Promise<ExperimentRunInput>;
  /**
   * Atomic create-or-exact-retry. A different binding for an existing
   * allocation must fail closed, which makes the v2 claim itself persistent.
   */
  bindClaim(binding: PersistedOptimizationClaimBinding): Promise<void>;
}

export interface ReleaseSafeResumeCheckpoint {
  readonly stateHash: string;
  readonly previousStateHash: string;
  readonly budgetAccountingAttestationHash: string;
  readonly brokerExposureStateAttestationHash: string | null;
  readonly repeatedTestingLedgerHash: string | null;
  readonly privacyLedgerHash: string | null;
  readonly cacheStateAttestationHash: string | null;
  readonly publicationQueueHash: string | null;
}

export interface OptimizationResumeVerification {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.optimization-resume-path.v1";
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly experimentNumber: number;
  readonly priorStateHash: string;
  readonly allocationStateHash: string;
  readonly currentStateHash: string;
  readonly checkpoints: readonly ReleaseSafeResumeCheckpoint[];
}

/**
 * Verifies signatures/authorizations for post-allocation checkpoints. The
 * adapter validates the structural hash chain, but intentionally owns no key.
 */
export interface TrustedOptimizationResumeVerifier {
  readonly boundary: "trusted-cloud";
  verify(path: OptimizationResumeVerification): Promise<void>;
}

export interface BudgetAccountingMaterialRequest {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.optimization-budget-accounting.v1";
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly claimHash: string;
  readonly experimentNumber: number;
  readonly currentStateHash: string;
  readonly previousUsage: CampaignState["budget"]["usage"];
  readonly reportedUsage: BudgetSnapshot["usage"];
  readonly resultSealHash: string;
}

export interface TrustedBudgetAccountingMaterial {
  readonly accountingAttestationHash: string;
  readonly nextUsage: CampaignState["budget"]["usage"];
}

export interface InterruptedBudgetAccountingMaterialRequest {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.interrupted-budget-accounting.v1";
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly claimHash: string;
  readonly experimentNumber: number;
  readonly currentStateHash: string;
  readonly previousUsage: CampaignState["budget"]["usage"];
}

export interface TrustedInterruptedBudgetAccountingMaterial
  extends TrustedBudgetAccountingMaterial {
  /**
   * Read directly from the evaluator-owned durable alpha ledger. The material
   * port also reconciles the journal and trusted operation ledgers into
   * nextUsage, so failed work cannot reset cost, tokens, time, attempts,
   * privacy releases, or promotion looks.
   */
  readonly onlineErrorReconciliation: TrustedOnlineErrorBudgetReconciliation;
}

export interface SealMaterialRequest {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.optimization-seal-material.v1";
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly claimHash: string;
  readonly experimentNumber: number;
  readonly currentStateHash: string;
  readonly stage: "pre-validation" | "validation";
  readonly disposition: ExperimentRunResult["disposition"];
  readonly candidateCommit: string | null;
  readonly resultSealHash: string;
  readonly promotionLookDelta: 0 | 1;
}

export interface TrustedOptimizationSealMaterial {
  readonly decisionAttestationHash: string;
  readonly holdoutAvailabilityAttestationHash: string | null;
  readonly sealedAt: string;
  readonly ledgers: CampaignLedgerPointers;
}

/**
 * Production implementations obtain signed material from the trusted
 * accounting/evaluator boundary. The coordinator never substitutes a hash.
 */
export interface TrustedOptimizationCompletionMaterialPort {
  readonly boundary: "trusted-cloud";
  createBudgetAccountingAttestation(
    request: BudgetAccountingMaterialRequest,
  ): Promise<TrustedBudgetAccountingMaterial>;
  /**
   * The implementation obtains reconciliation from the online-error
   * authority, journal, and trusted operation ledgers itself. Callers cannot
   * supply or lower any counter.
   */
  createInterruptedBudgetAccountingAttestation(
    request: InterruptedBudgetAccountingMaterialRequest,
  ): Promise<TrustedInterruptedBudgetAccountingMaterial>;
  createSealMaterial(request: SealMaterialRequest): Promise<TrustedOptimizationSealMaterial>;
}

export interface OptimizationInterruptionRecordDraft {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.optimization-interruption.v1";
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly experimentNumber: number;
  readonly claimHash: string;
  readonly allocationStateHash: string;
  readonly failureClass: OptimizationFailureClass;
  readonly brokerExposureStateAttestationHash: string;
}

export interface OptimizationInterruptionRecord extends OptimizationInterruptionRecordDraft {
  readonly recordHash: string;
}

export type OptimizationInterruptionControl =
  | {
      readonly kind: "pause";
      readonly reason: CampaignPauseReason;
      readonly attestationHash: string;
    }
  | {
      readonly kind: "stop";
      readonly reason: CampaignStopReason;
    };

/**
 * begin() must persist before returning. findPending() and prepareControl()
 * make the archive-then-pause/stop sequence recoverable across either crash
 * window without placing task identities in CampaignState.
 */
export interface TrustedOptimizationInterruptionPort {
  readonly boundary: "trusted-cloud";
  begin(
    draft: Omit<OptimizationInterruptionRecordDraft, "brokerExposureStateAttestationHash">,
  ): Promise<OptimizationInterruptionRecord>;
  findPending(input: {
    readonly campaignId: string;
    readonly lineageId: string;
    readonly protocolHash: string;
    readonly currentStateHash: string;
  }): Promise<OptimizationInterruptionRecord | null>;
  prepareControl(input: {
    readonly record: OptimizationInterruptionRecord;
    readonly currentStateHash: string;
  }): Promise<OptimizationInterruptionControl>;
  markApplied(input: {
    readonly recordHash: string;
    readonly finalStateHash: string;
  }): Promise<void>;
}

export interface CampaignStateOptimizationCoordinatorOptions {
  readonly store: OptimizationCampaignStateStore;
  readonly inputFactory: TrustedOptimizationInputFactory;
  readonly resumeVerifier: TrustedOptimizationResumeVerifier;
  readonly completionMaterial: TrustedOptimizationCompletionMaterialPort;
  readonly interruption: TrustedOptimizationInterruptionPort;
}

interface AllocationPath {
  readonly prior: CampaignState;
  readonly allocation: CampaignState;
  readonly currentInFlight: CampaignState;
  readonly states: readonly CampaignState[];
}

interface ResolvedClaim {
  readonly publicClaim: ClaimedOptimizationExperiment;
  readonly path: AllocationPath;
  readonly allowedCurrentStateHashes: ReadonlySet<string>;
}

export class CampaignStateOptimizationCoordinatorError extends Error {
  override readonly name = "CampaignStateOptimizationCoordinatorError";

  public constructor(message = "Campaign optimization coordination failed.") {
    super(message);
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(value: unknown, keys: readonly string[]): void {
  if (!isPlainRecord(value)) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
}

function assertHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
}

function assertCanonicalTimestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
}

function domainBudget(state: CampaignState): BudgetSnapshot {
  return {
    limits: {
      maximumUsd: state.budget.limits.maximumUsd,
      maximumTokens: state.budget.limits.maximumTokens,
      maximumWallTimeMs: state.budget.limits.maximumWallTimeMs,
      maximumAttempts: state.budget.limits.maximumAttempts,
      maximumPrivacyReleases: state.budget.limits.maximumPrivacyReleases,
      maximumPromotionLooks: state.budget.limits.maximumPromotionLooks,
      maximumOnlineError: state.budget.limits.maximumOnlineError,
    },
    usage: {
      spentUsd: state.budget.usage.spentUsd,
      tokens: state.budget.usage.tokens,
      wallTimeMs: state.budget.usage.wallTimeMs,
      attempts: state.budget.usage.attempts,
      privacyReleases: state.budget.usage.privacyReleases,
      promotionLooks: state.budget.usage.promotionLooks,
      onlineErrorSpent: state.budget.usage.onlineErrorSpent,
    },
  };
}

function championPointers(state: CampaignState): ChampionPointers {
  const certified = state.champions.certified;
  const certificationIsCurrent =
    certified !== null &&
    certified.experimentNumber === state.champions.active.experimentNumber &&
    certified.commit === state.champions.active.commit;
  return {
    baselineCommit: state.champions.baseline.commit,
    activeExperiment: state.champions.active.experimentNumber,
    activeCommit: state.champions.active.commit,
    certifiedExperiment: certified?.experimentNumber ?? null,
    certifiedCommit: certified?.commit ?? null,
    updatedAt: state.champions.updatedAt,
    sourceSealHash: certificationIsCurrent
      ? certified.sourceSealHash
      : state.champions.active.sourceSealHash,
  };
}

function hardBudgetExhausted(state: CampaignState): boolean {
  const { limits, usage } = state.budget;
  return (
    usage.spentUsd >= limits.maximumUsd ||
    usage.tokens >= limits.maximumTokens ||
    usage.wallTimeMs >= limits.maximumWallTimeMs ||
    usage.attempts >= limits.maximumAttempts ||
    usage.privacyReleases >= limits.maximumPrivacyReleases ||
    usage.promotionLooks >= limits.maximumPromotionLooks ||
    usage.onlineErrorSpent >= limits.maximumOnlineError
  );
}

function snapshotFromState(state: CampaignState): OptimizationLoopSnapshot {
  if (state.numbering.inFlightKind !== null && state.numbering.inFlightKind !== "optimization") {
    throw new CampaignStateOptimizationCoordinatorError(
      "The optimization loop cannot take ownership of shadow work.",
    );
  }
  return {
    schemaVersion: 1,
    campaignId: state.campaignId,
    lineageId: state.baselineLineageId,
    protocolHash: state.protocolHash,
    stateHash: state.contentHash,
    status: state.control.status,
    nextExperimentNumber: state.numbering.nextExperimentNumber,
    inFlightExperimentNumber: state.numbering.inFlightExperimentNumber,
    inFlightKind: state.numbering.inFlightKind,
    activeChampion: championPointers(state),
    budget: domainBudget(state),
    hardBudgetExhausted: hardBudgetExhausted(state),
    freshValidationPanelsRemaining: state.holdout.freshValidationSetsRemaining,
  };
}

function assertNondecreasingBudget(before: BudgetSnapshot, after: BudgetSnapshot): void {
  if (
    canonicalJson(before.limits) !== canonicalJson(after.limits) ||
    after.usage.spentUsd < before.usage.spentUsd ||
    after.usage.tokens < before.usage.tokens ||
    after.usage.wallTimeMs < before.usage.wallTimeMs ||
    after.usage.attempts < before.usage.attempts ||
    after.usage.privacyReleases < before.usage.privacyReleases ||
    after.usage.promotionLooks < before.usage.promotionLooks ||
    after.usage.onlineErrorSpent < before.usage.onlineErrorSpent
  ) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
}

function assertResumePathStructure(path: AllocationPath): void {
  const allocationSnapshot = snapshotFromState(path.allocation);
  let stopObserved = false;
  if (
    path.allocation.previousStateHash !== path.prior.contentHash ||
    path.allocation.numbering.inFlightExperimentNumber === null ||
    path.allocation.numbering.nextExperimentNumber !==
      path.prior.numbering.nextExperimentNumber + 1 ||
    path.allocation.numbering.inFlightExperimentNumber !==
      path.prior.numbering.nextExperimentNumber ||
    path.prior.numbering.inFlightExperimentNumber !== null ||
    path.allocation.numbering.inFlightKind !== "optimization"
  ) {
    throw new CampaignStateOptimizationCoordinatorError();
  }

  for (const state of path.states) {
    const current = snapshotFromState(state);
    const stateIsRunning = state.control.status === "running";
    const stateIsStopping = state.control.status === "stop-requested";
    if (
      state.numbering.inFlightExperimentNumber !==
        path.allocation.numbering.inFlightExperimentNumber ||
      state.numbering.inFlightKind !== "optimization" ||
      state.numbering.nextExperimentNumber !== path.allocation.numbering.nextExperimentNumber ||
      (!stateIsRunning && !stateIsStopping) ||
      (stopObserved && stateIsRunning) ||
      state.campaignId !== path.allocation.campaignId ||
      state.baselineLineageId !== path.allocation.baselineLineageId ||
      state.protocolHash !== path.allocation.protocolHash ||
      canonicalJson(current.activeChampion) !== canonicalJson(allocationSnapshot.activeChampion) ||
      canonicalJson(state.holdout) !== canonicalJson(path.allocation.holdout) ||
      canonicalJson(state.budget.limits) !== canonicalJson(path.allocation.budget.limits) ||
      state.budget.policyHash !== path.allocation.budget.policyHash ||
      state.budget.authorizationHash !== path.allocation.budget.authorizationHash ||
      state.budget.usage.onlineErrorSpent < path.allocation.budget.usage.onlineErrorSpent
    ) {
      throw new CampaignStateOptimizationCoordinatorError();
    }
    stopObserved ||= stateIsStopping;
    assertNondecreasingBudget(allocationSnapshot.budget, current.budget);
  }
}

function allocationPath(history: CampaignHistory, experimentNumber: number): AllocationPath {
  const states = history.states;
  let allocationIndex = -1;
  for (let index = 1; index < states.length; index += 1) {
    const prior = states[index - 1];
    const state = states[index];
    if (
      prior !== undefined &&
      state !== undefined &&
      prior.numbering.inFlightExperimentNumber === null &&
      state.numbering.inFlightExperimentNumber === experimentNumber &&
      state.numbering.inFlightKind === "optimization" &&
      state.numbering.nextExperimentNumber === prior.numbering.nextExperimentNumber + 1
    ) {
      allocationIndex = index;
      break;
    }
  }
  if (allocationIndex < 1) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
  let lastInFlightIndex = allocationIndex;
  for (let index = allocationIndex + 1; index < states.length; index += 1) {
    const state = states[index];
    if (
      state?.numbering.inFlightExperimentNumber !== experimentNumber ||
      state.numbering.inFlightKind !== "optimization"
    ) {
      break;
    }
    lastInFlightIndex = index;
  }
  const prior = states[allocationIndex - 1];
  const allocation = states[allocationIndex];
  const currentInFlight = states[lastInFlightIndex];
  if (prior === undefined || allocation === undefined || currentInFlight === undefined) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
  const path = {
    prior,
    allocation,
    currentInFlight,
    states: states.slice(allocationIndex, lastInFlightIndex + 1),
  };
  assertResumePathStructure(path);
  return path;
}

function releaseSafeCheckpoints(path: AllocationPath): readonly ReleaseSafeResumeCheckpoint[] {
  return path.states.slice(1).map((state) => ({
    stateHash: state.contentHash,
    previousStateHash: state.previousStateHash as string,
    budgetAccountingAttestationHash: state.budget.accountingAttestationHash,
    brokerExposureStateAttestationHash: state.reconstruction.brokerExposureStateAttestationHash,
    repeatedTestingLedgerHash: state.reconstruction.repeatedTestingLedgerHash,
    privacyLedgerHash: state.reconstruction.privacyLedgerHash,
    cacheStateAttestationHash: state.reconstruction.cacheStateAttestationHash,
    publicationQueueHash: state.reconstruction.publicationQueueHash,
  }));
}

function assertDiagnosticReference(value: ExperimentRunInput["diagnosticBrief"]): void {
  if (value === null) return;
  assertExactKeys(value, ["hash", "releaseId", "actionable"]);
  if (
    !SHA256.test(value.hash) ||
    !OPAQUE_DIAGNOSTIC_RELEASE_ID.test(value.releaseId) ||
    typeof value.actionable !== "boolean"
  ) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
}

function assertPreparedInput(value: ExperimentRunInput, path: AllocationPath): void {
  assertExactKeys(value, [
    "experiment",
    "activeChampion",
    "budget",
    "diagnosticBrief",
    "previousDiscoveryAttestationHash",
    "repairAttemptOrdinal",
    "stop",
  ]);
  assertExactKeys(value.experiment, [
    "number",
    "slug",
    "kind",
    "parentExperiment",
    "lineageId",
    "protocolHash",
  ]);
  assertExactKeys(value.activeChampion, [
    "baselineCommit",
    "activeExperiment",
    "activeCommit",
    "certifiedExperiment",
    "certifiedCommit",
    "updatedAt",
    "sourceSealHash",
  ]);
  assertExactKeys(value.budget, ["limits", "usage"]);
  assertExactKeys(value.budget.limits, [
    "maximumUsd",
    "maximumTokens",
    "maximumWallTimeMs",
    "maximumAttempts",
    "maximumPrivacyReleases",
    "maximumPromotionLooks",
    "maximumOnlineError",
  ]);
  assertExactKeys(value.budget.usage, [
    "spentUsd",
    "tokens",
    "wallTimeMs",
    "attempts",
    "privacyReleases",
    "promotionLooks",
    "onlineErrorSpent",
  ]);
  assertExactKeys(value.stop, ["requested"]);
  assertDiagnosticReference(value.diagnosticBrief);

  const allocation = snapshotFromState(path.allocation);
  const experimentNumber = path.allocation.numbering.inFlightExperimentNumber;
  const sourceOnlyBootstrap = experimentNumber === 1;
  if (
    experimentNumber === null ||
    value.experiment.number !== experimentNumber ||
    value.experiment.slug !==
      (sourceOnlyBootstrap ? "source-only-bootstrap" : "diagnostic-repair") ||
    value.experiment.kind !== "optimization" ||
    value.experiment.parentExperiment !== allocation.activeChampion.activeExperiment ||
    value.experiment.lineageId !== allocation.lineageId ||
    value.experiment.protocolHash !== allocation.protocolHash ||
    canonicalJson(value.activeChampion) !== canonicalJson(allocation.activeChampion) ||
    canonicalJson(value.budget) !== canonicalJson(allocation.budget) ||
    ![1, 2].includes(value.repairAttemptOrdinal) ||
    value.stop.requested !== false ||
    (sourceOnlyBootstrap &&
      (value.diagnosticBrief !== null || value.previousDiscoveryAttestationHash !== null)) ||
    (!sourceOnlyBootstrap &&
      (value.previousDiscoveryAttestationHash === null ||
        !SHA256.test(value.previousDiscoveryAttestationHash))) ||
    (sourceOnlyBootstrap && value.repairAttemptOrdinal !== 1)
  ) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
}

function claimHash(input: {
  readonly priorStateHash: string;
  readonly allocationStateHash: string;
  readonly experimentInput: ExperimentRunInput;
}): string {
  return canonicalHash({
    domain: "dark-factory.optimization-claim.v2",
    priorStateHash: input.priorStateHash,
    allocationStateHash: input.allocationStateHash,
    input: input.experimentInput,
  });
}

function assertResult(claim: ClaimedOptimizationExperiment, result: ExperimentRunResult): 0 | 1 {
  assertExactKeys(result, [
    "disposition",
    "activeChampion",
    "budget",
    "diagnosticBrief",
    "sealHash",
  ]);
  assertExactKeys(result.activeChampion, [
    "baselineCommit",
    "activeExperiment",
    "activeCommit",
    "certifiedExperiment",
    "certifiedCommit",
    "updatedAt",
    "sourceSealHash",
  ]);
  assertExactKeys(result.budget, ["limits", "usage"]);
  assertExactKeys(result.budget.limits, [
    "maximumUsd",
    "maximumTokens",
    "maximumWallTimeMs",
    "maximumAttempts",
    "maximumPrivacyReleases",
    "maximumPromotionLooks",
    "maximumOnlineError",
  ]);
  assertExactKeys(result.budget.usage, [
    "spentUsd",
    "tokens",
    "wallTimeMs",
    "attempts",
    "privacyReleases",
    "promotionLooks",
    "onlineErrorSpent",
  ]);
  assertDiagnosticReference(result.diagnosticBrief);
  if (
    !["promoted", "rejected", "inconclusive"].includes(result.disposition) ||
    !SHA256.test(result.sealHash)
  ) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
  const numericFields = [
    result.budget.limits.maximumUsd,
    result.budget.limits.maximumTokens,
    result.budget.limits.maximumWallTimeMs,
    result.budget.limits.maximumAttempts,
    result.budget.limits.maximumPrivacyReleases,
    result.budget.limits.maximumPromotionLooks,
    result.budget.limits.maximumOnlineError,
    result.budget.usage.spentUsd,
    result.budget.usage.tokens,
    result.budget.usage.wallTimeMs,
    result.budget.usage.attempts,
    result.budget.usage.privacyReleases,
    result.budget.usage.promotionLooks,
    result.budget.usage.onlineErrorSpent,
  ];
  if (
    numericFields.some((value) => !Number.isFinite(value) || value < 0) ||
    !Number.isSafeInteger(result.budget.limits.maximumTokens) ||
    !Number.isSafeInteger(result.budget.limits.maximumWallTimeMs) ||
    !Number.isSafeInteger(result.budget.limits.maximumAttempts) ||
    !Number.isSafeInteger(result.budget.limits.maximumPrivacyReleases) ||
    !Number.isSafeInteger(result.budget.limits.maximumPromotionLooks) ||
    !Number.isSafeInteger(result.budget.usage.tokens) ||
    !Number.isSafeInteger(result.budget.usage.wallTimeMs) ||
    !Number.isSafeInteger(result.budget.usage.attempts) ||
    !Number.isSafeInteger(result.budget.usage.privacyReleases) ||
    !Number.isSafeInteger(result.budget.usage.promotionLooks) ||
    result.budget.usage.spentUsd > result.budget.limits.maximumUsd ||
    result.budget.usage.tokens > result.budget.limits.maximumTokens ||
    result.budget.usage.wallTimeMs > result.budget.limits.maximumWallTimeMs ||
    result.budget.usage.attempts > result.budget.limits.maximumAttempts ||
    result.budget.usage.privacyReleases > result.budget.limits.maximumPrivacyReleases ||
    result.budget.usage.promotionLooks > result.budget.limits.maximumPromotionLooks ||
    result.budget.usage.onlineErrorSpent > result.budget.limits.maximumOnlineError ||
    result.budget.limits.maximumOnlineError > 1 ||
    result.budget.usage.onlineErrorSpent > 1
  ) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
  assertNondecreasingBudget(claim.input.budget, result.budget);
  const delta = result.budget.usage.promotionLooks - claim.input.budget.usage.promotionLooks;
  if (delta !== 0 && delta !== 1) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
  if (
    (result.disposition === "promoted" && delta !== 1) ||
    (result.disposition === "promoted" &&
      (result.activeChampion.activeExperiment !== claim.input.experiment.number ||
        result.activeChampion.activeCommit === claim.input.activeChampion.activeCommit ||
        !GIT_OBJECT.test(result.activeChampion.activeCommit) ||
        result.activeChampion.baselineCommit !== claim.input.activeChampion.baselineCommit ||
        result.activeChampion.certifiedExperiment !==
          claim.input.activeChampion.certifiedExperiment ||
        result.activeChampion.certifiedCommit !== claim.input.activeChampion.certifiedCommit ||
        result.activeChampion.sourceSealHash !== result.sealHash ||
        !Number.isFinite(Date.parse(result.activeChampion.updatedAt)))) ||
    (result.disposition !== "promoted" &&
      canonicalJson(result.activeChampion) !== canonicalJson(claim.input.activeChampion))
  ) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
  return delta;
}

function assertLedgerPointers(value: CampaignLedgerPointers): void {
  assertExactKeys(value, [
    "brokerExposureStateAttestationHash",
    "repeatedTestingLedgerHash",
    "privacyLedgerHash",
    "cacheStateAttestationHash",
    "publicationQueueHash",
  ]);
  assertHash(value.brokerExposureStateAttestationHash);
  assertHash(value.repeatedTestingLedgerHash);
  assertHash(value.privacyLedgerHash);
  if (value.cacheStateAttestationHash !== null) {
    assertHash(value.cacheStateAttestationHash);
  }
  if (value.publicationQueueHash !== null) {
    assertHash(value.publicationQueueHash);
  }
}

function assertBudgetAccountingMaterial(
  value: TrustedBudgetAccountingMaterial,
  state: CampaignState,
  result: ExperimentRunResult,
): void {
  assertExactKeys(value, ["accountingAttestationHash", "nextUsage"]);
  assertHash(value.accountingAttestationHash);
  assertExactKeys(value.nextUsage, [
    "spentUsd",
    "tokens",
    "wallTimeMs",
    "attempts",
    "privacyReleases",
    "promotionLooks",
    "onlineErrorSpent",
  ]);
  const nextDomainUsage: BudgetSnapshot["usage"] = {
    spentUsd: value.nextUsage.spentUsd,
    tokens: value.nextUsage.tokens,
    wallTimeMs: value.nextUsage.wallTimeMs,
    attempts: value.nextUsage.attempts,
    privacyReleases: value.nextUsage.privacyReleases,
    promotionLooks: value.nextUsage.promotionLooks,
    onlineErrorSpent: value.nextUsage.onlineErrorSpent,
  };
  if (
    canonicalJson(nextDomainUsage) !== canonicalJson(result.budget.usage) ||
    !Number.isFinite(value.nextUsage.onlineErrorSpent) ||
    value.nextUsage.onlineErrorSpent < state.budget.usage.onlineErrorSpent ||
    value.nextUsage.onlineErrorSpent > state.budget.limits.maximumOnlineError
  ) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
}

function assertInterruptedBudgetAccountingMaterial(
  value: TrustedInterruptedBudgetAccountingMaterial,
  state: CampaignState,
): void {
  assertExactKeys(value, ["accountingAttestationHash", "nextUsage", "onlineErrorReconciliation"]);
  assertHash(value.accountingAttestationHash);
  assertExactKeys(value.nextUsage, [
    "spentUsd",
    "tokens",
    "wallTimeMs",
    "attempts",
    "privacyReleases",
    "promotionLooks",
    "onlineErrorSpent",
  ]);
  assertTrustedOnlineErrorBudgetReconciliation(value.onlineErrorReconciliation, state.campaignId);
  const receipt = value.onlineErrorReconciliation;
  const nextBudget: BudgetSnapshot = {
    limits: domainBudget(state).limits,
    usage: value.nextUsage,
  };
  validateBudgetSnapshot(nextBudget);
  assertNondecreasingBudget(domainBudget(state), nextBudget);
  if (
    receipt.campaignIdHash !== onlineErrorBudgetCampaignIdHash(state.campaignId) ||
    receipt.maximumOnlineError !== state.budget.limits.maximumOnlineError ||
    receipt.onlineErrorSpent < state.budget.usage.onlineErrorSpent ||
    receipt.onlineErrorSpent > state.budget.limits.maximumOnlineError ||
    receipt.storeRevision !== receipt.gatesSpent ||
    value.nextUsage.onlineErrorSpent !== receipt.onlineErrorSpent
  ) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
}

function assertSealMaterial(
  value: TrustedOptimizationSealMaterial,
  stage: "pre-validation" | "validation",
  state: CampaignState,
): void {
  assertExactKeys(value, [
    "decisionAttestationHash",
    "holdoutAvailabilityAttestationHash",
    "sealedAt",
    "ledgers",
  ]);
  assertHash(value.decisionAttestationHash);
  assertCanonicalTimestamp(value.sealedAt);
  assertLedgerPointers(value.ledgers);
  if (stage === "pre-validation") {
    if (value.holdoutAvailabilityAttestationHash !== null) {
      throw new CampaignStateOptimizationCoordinatorError();
    }
  } else {
    assertHash(value.holdoutAvailabilityAttestationHash);
    if (value.holdoutAvailabilityAttestationHash === state.holdout.availabilityAttestationHash) {
      throw new CampaignStateOptimizationCoordinatorError();
    }
  }
}

function interruptionRecordHash(draft: OptimizationInterruptionRecordDraft): string {
  return canonicalHash(draft);
}

function assertInterruptionRecord(
  record: OptimizationInterruptionRecord,
  expected: {
    readonly campaignId: string;
    readonly lineageId: string;
    readonly protocolHash: string;
  },
): void {
  assertExactKeys(record, [
    "schemaVersion",
    "domain",
    "campaignId",
    "lineageId",
    "protocolHash",
    "experimentNumber",
    "claimHash",
    "allocationStateHash",
    "failureClass",
    "brokerExposureStateAttestationHash",
    "recordHash",
  ]);
  const draft: OptimizationInterruptionRecordDraft = {
    schemaVersion: record.schemaVersion,
    domain: record.domain,
    campaignId: record.campaignId,
    lineageId: record.lineageId,
    protocolHash: record.protocolHash,
    experimentNumber: record.experimentNumber,
    claimHash: record.claimHash,
    allocationStateHash: record.allocationStateHash,
    failureClass: record.failureClass,
    brokerExposureStateAttestationHash: record.brokerExposureStateAttestationHash,
  };
  if (
    record.schemaVersion !== 1 ||
    record.domain !== "dark-factory.optimization-interruption.v1" ||
    record.campaignId !== expected.campaignId ||
    record.lineageId !== expected.lineageId ||
    record.protocolHash !== expected.protocolHash ||
    !Number.isSafeInteger(record.experimentNumber) ||
    record.experimentNumber < 1 ||
    !["integrity", "infrastructure", "budget", "operator-stop"].includes(record.failureClass) ||
    !SHA256.test(record.claimHash) ||
    !SHA256.test(record.allocationStateHash) ||
    !SHA256.test(record.brokerExposureStateAttestationHash) ||
    record.recordHash !== interruptionRecordHash(draft)
  ) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
}

function assertInterruptionControl(
  control: OptimizationInterruptionControl,
  failure: OptimizationFailureClass,
): void {
  if (control.kind === "stop") {
    assertExactKeys(control, ["kind", "reason"]);
    if (
      failure !== "operator-stop" ||
      !["operator", "sigint", "sigterm", "system-shutdown"].includes(control.reason)
    ) {
      throw new CampaignStateOptimizationCoordinatorError();
    }
    return;
  }
  assertExactKeys(control, ["kind", "reason", "attestationHash"]);
  assertHash(control.attestationHash);
  const allowed: Readonly<
    Record<Exclude<OptimizationFailureClass, "operator-stop">, readonly CampaignPauseReason[]>
  > = {
    integrity: ["integrity", "policy"],
    infrastructure: ["infrastructure", "publication", "policy"],
    budget: ["budget-exhausted", "policy"],
  };
  if (failure === "operator-stop") {
    throw new CampaignStateOptimizationCoordinatorError();
  }
  if (!allowed[failure].includes(control.reason)) {
    throw new CampaignStateOptimizationCoordinatorError();
  }
}

function sameControlDisposition(
  state: CampaignState,
  control: OptimizationInterruptionControl,
): boolean {
  return control.kind === "pause"
    ? state.control.status === "paused" &&
        state.control.pauseReason === control.reason &&
        state.control.pauseAttestationHash === control.attestationHash
    : (state.control.status === "stop-requested" || state.control.status === "stopped") &&
        state.control.stopReason === control.reason;
}

function interruptedArchiveStateHash(
  history: CampaignHistory,
  record: OptimizationInterruptionRecord,
): string | null {
  let archiveStateHash: string | null = null;
  for (let index = 1; index < history.states.length; index += 1) {
    const previous = history.states[index - 1];
    const state = history.states[index];
    if (
      previous === undefined ||
      state === undefined ||
      state.previousStateHash !== previous.contentHash ||
      previous.numbering.inFlightExperimentNumber !== record.experimentNumber ||
      previous.numbering.inFlightKind !== "optimization" ||
      state.numbering.inFlightExperimentNumber !== null ||
      state.numbering.inFlightKind !== null ||
      state.numbering.lastInterruptedExperimentNumber !== record.experimentNumber ||
      state.reconstruction.brokerExposureStateAttestationHash !==
        record.brokerExposureStateAttestationHash
    ) {
      continue;
    }
    if (archiveStateHash !== null && archiveStateHash !== state.contentHash) {
      throw new CampaignStateOptimizationCoordinatorError();
    }
    archiveStateHash = state.contentHash;
  }
  return archiveStateHash;
}

function terminalClaim(state: CampaignState): OptimizationClaim | null {
  const snapshot = snapshotFromState(state);
  if (snapshot.status !== "running") {
    return {
      kind: "terminal",
      reason: snapshot.status === "stop-requested" ? "stop-requested" : snapshot.status,
      snapshot,
    };
  }
  if (snapshot.inFlightExperimentNumber !== null) return null;
  if (snapshot.freshValidationPanelsRemaining === 0) {
    return {
      kind: "terminal",
      reason: "holdout-exhausted",
      snapshot,
    };
  }
  const remaining = remainingBudget(snapshot.budget);
  const minimumAttempts = snapshot.nextExperimentNumber === 1 ? 28 : 37;
  if (
    snapshot.hardBudgetExhausted ||
    remaining.attempts < minimumAttempts ||
    remaining.promotionLooks < 1 ||
    remaining.onlineErrorSpent <= 0 ||
    remaining.spentUsd <= 0 ||
    remaining.tokens <= 0 ||
    remaining.wallTimeMs <= 0
  ) {
    return {
      kind: "terminal",
      reason: "budget-exhausted",
      snapshot,
    };
  }
  return null;
}

export class CampaignStateOptimizationCoordinator implements ProductionOptimizationCoordinator {
  readonly #options: CampaignStateOptimizationCoordinatorOptions;

  public constructor(options: CampaignStateOptimizationCoordinatorOptions) {
    if (
      options.inputFactory.boundary !== "trusted-cloud" ||
      options.resumeVerifier.boundary !== "trusted-cloud" ||
      options.completionMaterial.boundary !== "trusted-cloud" ||
      options.interruption.boundary !== "trusted-cloud"
    ) {
      throw new CampaignStateOptimizationCoordinatorError(
        "All production coordinator ports must be trusted-cloud ports.",
      );
    }
    this.#options = options;
  }

  async #resolveClaim(history: CampaignHistory, experimentNumber: number): Promise<ResolvedClaim> {
    const path = allocationPath(history, experimentNumber);
    await this.#options.resumeVerifier.verify({
      schemaVersion: 1,
      domain: "dark-factory.optimization-resume-path.v1",
      campaignId: path.allocation.campaignId,
      lineageId: path.allocation.baselineLineageId,
      protocolHash: path.allocation.protocolHash,
      experimentNumber,
      priorStateHash: path.prior.contentHash,
      allocationStateHash: path.allocation.contentHash,
      currentStateHash: path.currentInFlight.contentHash,
      checkpoints: releaseSafeCheckpoints(path),
    });
    const input = await this.#options.inputFactory.prepareOrResume({
      schemaVersion: 1,
      domain: "dark-factory.optimization-input-preparation.v1",
      campaignId: path.allocation.campaignId,
      lineageId: path.allocation.baselineLineageId,
      protocolHash: path.allocation.protocolHash,
      priorStateHash: path.prior.contentHash,
      allocationStateHash: path.allocation.contentHash,
      allocationSnapshot: snapshotFromState(path.allocation),
      experimentNumber,
      sourceOnlyBootstrap: experimentNumber === 1,
    });
    assertPreparedInput(input, path);
    const hash = claimHash({
      priorStateHash: path.prior.contentHash,
      allocationStateHash: path.allocation.contentHash,
      experimentInput: input,
    });
    await this.#options.inputFactory.bindClaim({
      schemaVersion: 1,
      domain: "dark-factory.optimization-claim-binding.v1",
      campaignId: path.allocation.campaignId,
      lineageId: path.allocation.baselineLineageId,
      protocolHash: path.allocation.protocolHash,
      experimentNumber,
      priorStateHash: path.prior.contentHash,
      allocationStateHash: path.allocation.contentHash,
      claimHash: hash,
      inputHash: canonicalHash(input),
      previousDiscoveryAttestationHash: input.previousDiscoveryAttestationHash,
      repairAttemptOrdinal: input.repairAttemptOrdinal,
    });
    return {
      publicClaim: {
        kind: "claimed",
        claimHash: hash,
        priorStateHash: path.prior.contentHash,
        allocationStateHash: path.allocation.contentHash,
        currentStateHash: path.currentInFlight.contentHash,
        snapshot: snapshotFromState(path.currentInFlight),
        input,
      },
      path,
      allowedCurrentStateHashes: new Set(path.states.map((state) => state.contentHash)),
    };
  }

  async #applyInterruption(
    history: CampaignHistory,
    record: OptimizationInterruptionRecord,
  ): Promise<CampaignState> {
    const identity = {
      campaignId: history.current.campaignId,
      lineageId: history.current.baselineLineageId,
      protocolHash: history.current.protocolHash,
    };
    assertInterruptionRecord(record, identity);
    const resolved = await this.#resolveClaim(history, record.experimentNumber);
    if (
      resolved.publicClaim.claimHash !== record.claimHash ||
      resolved.publicClaim.allocationStateHash !== record.allocationStateHash
    ) {
      throw new CampaignStateOptimizationCoordinatorError();
    }

    let current = history.current;
    let archiveStateHash = interruptedArchiveStateHash(history, record);
    const externallyStopping =
      current.control.status === "stop-requested" || current.control.status === "stopped";
    if (current.control.status === "running" || externallyStopping) {
      if (current.numbering.inFlightExperimentNumber === record.experimentNumber) {
        const interruptedAccounting =
          await this.#options.completionMaterial.createInterruptedBudgetAccountingAttestation({
            schemaVersion: 1,
            domain: "dark-factory.interrupted-budget-accounting.v1",
            campaignId: current.campaignId,
            lineageId: current.baselineLineageId,
            protocolHash: current.protocolHash,
            claimHash: record.claimHash,
            experimentNumber: record.experimentNumber,
            currentStateHash: current.contentHash,
            previousUsage: current.budget.usage,
          });
        assertInterruptedBudgetAccountingMaterial(interruptedAccounting, current);
        if (
          canonicalJson(interruptedAccounting.nextUsage) !== canonicalJson(current.budget.usage)
        ) {
          current = await this.#options.store.recordBudgetUsage(
            current.contentHash,
            interruptedAccounting.nextUsage,
            interruptedAccounting.accountingAttestationHash,
          );
        }
        current = await this.#options.store.archiveInterruptedExperiment(
          current.contentHash,
          record.experimentNumber,
          record.brokerExposureStateAttestationHash,
        );
        archiveStateHash = current.contentHash;
      } else if (
        current.numbering.inFlightExperimentNumber !== null ||
        current.numbering.lastInterruptedExperimentNumber !== record.experimentNumber
      ) {
        throw new CampaignStateOptimizationCoordinatorError();
      }
    } else if (current.numbering.inFlightExperimentNumber !== null) {
      throw new CampaignStateOptimizationCoordinatorError();
    }

    if (archiveStateHash === null) {
      throw new CampaignStateOptimizationCoordinatorError();
    }
    const control = await this.#options.interruption.prepareControl({
      record,
      currentStateHash: archiveStateHash,
    });
    assertInterruptionControl(control, record.failureClass);
    if (current.control.status === "running") {
      current =
        control.kind === "pause"
          ? await this.#options.store.pause(
              current.contentHash,
              control.reason,
              control.attestationHash,
            )
          : await this.#options.store.requestStop(current.contentHash, control.reason);
    } else if (
      current.control.status === "stop-requested" ||
      current.control.status === "stopped"
    ) {
      if (control.kind === "stop" && !sameControlDisposition(current, control)) {
        throw new CampaignStateOptimizationCoordinatorError();
      }
      // A durable external stop has higher precedence than a previously
      // authorized pause. The interruption is still reconciled and archived
      // before the stop is acknowledged.
    } else if (!sameControlDisposition(current, control)) {
      throw new CampaignStateOptimizationCoordinatorError();
    }
    if (current.control.status === "stop-requested") {
      current = await this.#options.store.acknowledgeStopped(current.contentHash);
    }
    await this.#options.interruption.markApplied({
      recordHash: record.recordHash,
      finalStateHash: current.contentHash,
    });
    return current;
  }

  async #recoverPending(history: CampaignHistory): Promise<CampaignState> {
    const current = history.current;
    const pending = await this.#options.interruption.findPending({
      campaignId: current.campaignId,
      lineageId: current.baselineLineageId,
      protocolHash: current.protocolHash,
      currentStateHash: current.contentHash,
    });
    if (pending !== null) {
      return this.#applyInterruption(history, pending);
    }
    if (
      current.control.status === "stop-requested" &&
      current.numbering.inFlightExperimentNumber === null
    ) {
      return this.#options.store.acknowledgeStopped(current.contentHash);
    }
    if (
      current.control.status !== "stop-requested" ||
      current.numbering.inFlightExperimentNumber === null ||
      current.numbering.inFlightKind !== "optimization"
    ) {
      return current;
    }
    const resolved = await this.#resolveClaim(history, current.numbering.inFlightExperimentNumber);
    const draft = {
      schemaVersion: 1 as const,
      domain: "dark-factory.optimization-interruption.v1" as const,
      campaignId: current.campaignId,
      lineageId: current.baselineLineageId,
      protocolHash: current.protocolHash,
      experimentNumber: current.numbering.inFlightExperimentNumber,
      claimHash: resolved.publicClaim.claimHash,
      allocationStateHash: resolved.publicClaim.allocationStateHash,
      failureClass: "operator-stop" as const,
    };
    const record = await this.#options.interruption.begin(draft);
    assertInterruptionRecord(record, {
      campaignId: draft.campaignId,
      lineageId: draft.lineageId,
      protocolHash: draft.protocolHash,
    });
    if (
      record.experimentNumber !== draft.experimentNumber ||
      record.claimHash !== draft.claimHash ||
      record.allocationStateHash !== draft.allocationStateHash ||
      record.failureClass !== draft.failureClass
    ) {
      throw new CampaignStateOptimizationCoordinatorError();
    }
    return this.#applyInterruption(history, record);
  }

  public async load(): Promise<OptimizationLoopSnapshot> {
    const history = await this.#options.store.reconstruct();
    return snapshotFromState(await this.#recoverPending(history));
  }

  public async claimNext(expectedStateHash: string): Promise<OptimizationClaim> {
    assertHash(expectedStateHash);
    let history = await this.#options.store.reconstruct();
    if (history.current.contentHash !== expectedStateHash) {
      throw new CampaignConflictError(expectedStateHash, history.current.contentHash);
    }
    const recovered = await this.#recoverPending(history);
    if (recovered.contentHash !== history.current.contentHash) {
      const terminal = terminalClaim(recovered);
      if (terminal === null) {
        throw new CampaignStateOptimizationCoordinatorError();
      }
      return terminal;
    }
    const existingTerminal = terminalClaim(history.current);
    if (existingTerminal !== null) return existingTerminal;

    if (history.current.numbering.inFlightExperimentNumber === null) {
      const allocation: ExperimentAllocation = await this.#options.store.allocateExperiment(
        history.current.contentHash,
        "optimization",
      );
      if (
        allocation.experimentNumber !== history.current.numbering.nextExperimentNumber ||
        allocation.state.numbering.inFlightExperimentNumber !== allocation.experimentNumber
      ) {
        throw new CampaignStateOptimizationCoordinatorError();
      }
      history = await this.#options.store.reconstruct();
      if (history.current.contentHash !== allocation.state.contentHash) {
        throw new CampaignConflictError(allocation.state.contentHash, history.current.contentHash);
      }
    }
    const experimentNumber = history.current.numbering.inFlightExperimentNumber;
    if (experimentNumber === null || history.current.numbering.inFlightKind !== "optimization") {
      throw new CampaignStateOptimizationCoordinatorError();
    }
    return (await this.#resolveClaim(history, experimentNumber)).publicClaim;
  }

  public async complete(input: {
    readonly claimHash: string;
    readonly currentStateHash: string;
    readonly result: ExperimentRunResult;
  }): Promise<OptimizationLoopSnapshot> {
    assertHash(input.claimHash);
    assertHash(input.currentStateHash);
    const history = await this.#options.store.reconstruct();
    const current = history.current;
    const experimentNumber =
      current.numbering.inFlightExperimentNumber ??
      current.reconstruction.lastSealedDecision?.experimentNumber;
    if (experimentNumber === null || experimentNumber === undefined || experimentNumber < 1) {
      throw new CampaignStateOptimizationCoordinatorError();
    }
    const resolved = await this.#resolveClaim(history, experimentNumber);
    if (
      resolved.publicClaim.claimHash !== input.claimHash ||
      !resolved.allowedCurrentStateHashes.has(input.currentStateHash)
    ) {
      throw new CampaignStateOptimizationCoordinatorError(
        "The completion claim is stale or detached.",
      );
    }
    const promotionLookDelta = assertResult(resolved.publicClaim, input.result);
    const stage = promotionLookDelta === 1 ? "validation" : "pre-validation";

    if (current.numbering.inFlightExperimentNumber === null) {
      const last = current.reconstruction.lastSealedDecision;
      if (
        last?.experimentNumber !== experimentNumber ||
        last.stage !== stage ||
        last.disposition !== input.result.disposition ||
        current.reconstruction.experimentSealChainHead !== input.result.sealHash ||
        canonicalJson(domainBudget(current)) !== canonicalJson(input.result.budget) ||
        canonicalJson(championPointers(current)) !== canonicalJson(input.result.activeChampion)
      ) {
        throw new CampaignStateOptimizationCoordinatorError(
          "A sealed completion retry does not reproduce.",
        );
      }
      return snapshotFromState(current);
    }
    if (current.contentHash !== resolved.path.currentInFlight.contentHash) {
      throw new CampaignStateOptimizationCoordinatorError();
    }
    assertNondecreasingBudget(domainBudget(current), input.result.budget);

    let state = current;
    if (canonicalJson(domainBudget(state)) !== canonicalJson(input.result.budget)) {
      const accountingMaterial =
        await this.#options.completionMaterial.createBudgetAccountingAttestation({
          schemaVersion: 1,
          domain: "dark-factory.optimization-budget-accounting.v1",
          campaignId: state.campaignId,
          lineageId: state.baselineLineageId,
          protocolHash: state.protocolHash,
          claimHash: input.claimHash,
          experimentNumber,
          currentStateHash: state.contentHash,
          previousUsage: state.budget.usage,
          reportedUsage: input.result.budget.usage,
          resultSealHash: input.result.sealHash,
        });
      assertBudgetAccountingMaterial(accountingMaterial, state, input.result);
      state = await this.#options.store.recordBudgetUsage(
        state.contentHash,
        accountingMaterial.nextUsage,
        accountingMaterial.accountingAttestationHash,
      );
    }

    const candidateCommit =
      input.result.disposition === "promoted" ? input.result.activeChampion.activeCommit : null;
    const sealRequest: SealMaterialRequest = {
      schemaVersion: 1,
      domain: "dark-factory.optimization-seal-material.v1",
      campaignId: state.campaignId,
      lineageId: state.baselineLineageId,
      protocolHash: state.protocolHash,
      claimHash: input.claimHash,
      experimentNumber,
      currentStateHash: state.contentHash,
      stage,
      disposition: input.result.disposition,
      candidateCommit,
      resultSealHash: input.result.sealHash,
      promotionLookDelta,
    };
    const material = await this.#options.completionMaterial.createSealMaterial(sealRequest);
    assertSealMaterial(material, stage, state);
    if (
      input.result.disposition === "promoted" &&
      material.sealedAt !== input.result.activeChampion.updatedAt
    ) {
      throw new CampaignStateOptimizationCoordinatorError();
    }
    const seal: SealExperimentInput = {
      experimentNumber,
      stage,
      disposition: input.result.disposition,
      candidateCommit,
      sealHash: input.result.sealHash,
      decisionAttestationHash: material.decisionAttestationHash,
      holdoutAvailabilityAttestationHash: material.holdoutAvailabilityAttestationHash,
      sealedAt: material.sealedAt,
      ledgers: material.ledgers,
    };
    state = await this.#options.store.sealExperiment(state.contentHash, seal);
    if (state.control.status === "stop-requested") {
      state = await this.#options.store.acknowledgeStopped(state.contentHash);
    }
    const completed = snapshotFromState(state);
    if (
      canonicalJson(completed.budget) !== canonicalJson(input.result.budget) ||
      canonicalJson(completed.activeChampion) !== canonicalJson(input.result.activeChampion)
    ) {
      throw new CampaignStateOptimizationCoordinatorError();
    }
    return completed;
  }

  public async interrupt(input: {
    readonly claimHash: string;
    readonly currentStateHash: string;
    readonly failureClass: OptimizationFailureClass;
  }): Promise<OptimizationLoopSnapshot> {
    assertHash(input.claimHash);
    assertHash(input.currentStateHash);
    const history = await this.#options.store.reconstruct();
    const pending = await this.#options.interruption.findPending({
      campaignId: history.current.campaignId,
      lineageId: history.current.baselineLineageId,
      protocolHash: history.current.protocolHash,
      currentStateHash: history.current.contentHash,
    });
    if (pending !== null) {
      if (
        pending.claimHash !== input.claimHash ||
        (pending.failureClass !== input.failureClass &&
          history.current.control.status !== "stop-requested" &&
          history.current.control.status !== "stopped")
      ) {
        throw new CampaignStateOptimizationCoordinatorError();
      }
      return snapshotFromState(await this.#applyInterruption(history, pending));
    }
    const experimentNumber = history.current.numbering.inFlightExperimentNumber;
    if (experimentNumber === null) {
      throw new CampaignStateOptimizationCoordinatorError();
    }
    const resolved = await this.#resolveClaim(history, experimentNumber);
    if (
      resolved.publicClaim.claimHash !== input.claimHash ||
      !resolved.allowedCurrentStateHashes.has(input.currentStateHash)
    ) {
      throw new CampaignStateOptimizationCoordinatorError(
        "The interruption claim is stale or detached.",
      );
    }
    const draft = {
      schemaVersion: 1 as const,
      domain: "dark-factory.optimization-interruption.v1" as const,
      campaignId: history.current.campaignId,
      lineageId: history.current.baselineLineageId,
      protocolHash: history.current.protocolHash,
      experimentNumber,
      claimHash: input.claimHash,
      allocationStateHash: resolved.publicClaim.allocationStateHash,
      failureClass: input.failureClass,
    };
    const record = await this.#options.interruption.begin(draft);
    assertInterruptionRecord(record, {
      campaignId: draft.campaignId,
      lineageId: draft.lineageId,
      protocolHash: draft.protocolHash,
    });
    if (
      record.experimentNumber !== draft.experimentNumber ||
      record.claimHash !== draft.claimHash ||
      record.allocationStateHash !== draft.allocationStateHash ||
      record.failureClass !== draft.failureClass
    ) {
      throw new CampaignStateOptimizationCoordinatorError();
    }
    return snapshotFromState(await this.#applyInterruption(history, record));
  }
}
