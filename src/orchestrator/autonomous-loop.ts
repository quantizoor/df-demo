import { remainingBudget, validateBudgetSnapshot } from "../core/budget.js";
import type { BudgetSnapshot, ChampionPointers } from "../domain/models.js";
import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import type { ExperimentRunInput, ExperimentRunResult } from "./contracts.js";
import type { ExperimentRunner } from "./experiment-runner.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const SAFE_RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type OptimizationLoopStatus = "running" | "stop-requested" | "stopped" | "paused";

export type OptimizationLoopTerminalReason =
  | "stop-requested"
  | "stopped"
  | "paused"
  | "budget-exhausted"
  | "holdout-exhausted"
  | "invocation-limit";

export interface OptimizationLoopSnapshot {
  readonly schemaVersion: 1;
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly stateHash: string;
  readonly status: OptimizationLoopStatus;
  readonly nextExperimentNumber: number;
  readonly inFlightExperimentNumber: number | null;
  readonly inFlightKind: "optimization" | null;
  readonly activeChampion: ChampionPointers;
  readonly budget: BudgetSnapshot;
  /**
   * Includes CampaignState-only hard dimensions such as online error. The
   * coordinator also treats an exhausted privacy-release limit as hard because
   * CampaignStateStore refuses a new allocation in that state.
   */
  readonly hardBudgetExhausted: boolean;
  readonly freshValidationPanelsRemaining: number;
}

export interface ClaimedOptimizationExperiment {
  readonly kind: "claimed";
  readonly claimHash: string;
  /**
   * State immediately before CampaignStateStore durably allocated the number.
   * This and allocationStateHash are immutable parts of the v2 claim.
   */
  readonly priorStateHash: string;
  readonly allocationStateHash: string;
  /**
   * Latest compare-and-swap state covered by the coordinator's verified
   * resume path. It can advance after an attested budget/ledger checkpoint.
   */
  readonly currentStateHash: string;
  readonly snapshot: OptimizationLoopSnapshot;
  readonly input: ExperimentRunInput;
}

export interface TerminalOptimizationClaim {
  readonly kind: "terminal";
  readonly reason: Exclude<OptimizationLoopTerminalReason, "invocation-limit">;
  readonly snapshot: OptimizationLoopSnapshot;
}

export type OptimizationClaim = ClaimedOptimizationExperiment | TerminalOptimizationClaim;

export interface ProductionOptimizationCoordinator {
  load(): Promise<OptimizationLoopSnapshot>;
  claimNext(expectedStateHash: string): Promise<OptimizationClaim>;
  complete(input: {
    readonly claimHash: string;
    readonly currentStateHash: string;
    readonly result: ExperimentRunResult;
  }): Promise<OptimizationLoopSnapshot>;
  interrupt(input: {
    readonly claimHash: string;
    readonly currentStateHash: string;
    readonly failureClass: "integrity" | "infrastructure" | "budget" | "operator-stop";
  }): Promise<OptimizationLoopSnapshot>;
}

export interface AutonomousOptimizationLoopOptions {
  readonly runner: Pick<ExperimentRunner, "run">;
  readonly coordinator: ProductionOptimizationCoordinator;
  readonly maximumExperimentsPerInvocation: number;
  readonly now?: () => Date;
}

export interface AutonomousOptimizationLoopReceipt {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.autonomous-optimization-loop.v1";
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly initialStateHash: string;
  readonly finalStateHash: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly experimentsCompleted: number;
  readonly promotions: number;
  readonly rejections: number;
  readonly inconclusive: number;
  readonly terminalReason: OptimizationLoopTerminalReason;
  readonly finalBudgetHash: string;
  readonly finalChampionHash: string;
  readonly receiptHash: string;
}

export class AutonomousOptimizationLoopError extends Error {
  override readonly name = "AutonomousOptimizationLoopError";
}

function assertTimestamp(date: Date, label: string): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new AutonomousOptimizationLoopError(`${label} is invalid.`);
  }
  return date.toISOString();
}

function assertChampion(pointer: ChampionPointers): void {
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(pointer.baselineCommit) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(pointer.activeCommit) ||
    (pointer.certifiedCommit !== null &&
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(pointer.certifiedCommit)) ||
    !Number.isSafeInteger(pointer.activeExperiment) ||
    pointer.activeExperiment < 0 ||
    (pointer.certifiedExperiment !== null &&
      (!Number.isSafeInteger(pointer.certifiedExperiment) || pointer.certifiedExperiment < 0)) ||
    (pointer.certifiedExperiment === null) !== (pointer.certifiedCommit === null) ||
    !Number.isFinite(Date.parse(pointer.updatedAt)) ||
    !SHA256.test(pointer.sourceSealHash)
  ) {
    throw new AutonomousOptimizationLoopError("Campaign champion pointers are malformed.");
  }
}

function assertBudget(snapshot: BudgetSnapshot): void {
  validateBudgetSnapshot(snapshot);
  const integerFields = [
    snapshot.limits.maximumTokens,
    snapshot.limits.maximumWallTimeMs,
    snapshot.limits.maximumAttempts,
    snapshot.limits.maximumPrivacyReleases,
    snapshot.limits.maximumPromotionLooks,
    snapshot.usage.tokens,
    snapshot.usage.wallTimeMs,
    snapshot.usage.attempts,
    snapshot.usage.privacyReleases,
    snapshot.usage.promotionLooks,
  ];
  if (
    integerFields.some((value) => !Number.isSafeInteger(value)) ||
    snapshot.usage.spentUsd > snapshot.limits.maximumUsd ||
    snapshot.usage.tokens > snapshot.limits.maximumTokens ||
    snapshot.usage.wallTimeMs > snapshot.limits.maximumWallTimeMs ||
    snapshot.usage.attempts > snapshot.limits.maximumAttempts ||
    snapshot.usage.privacyReleases > snapshot.limits.maximumPrivacyReleases ||
    snapshot.usage.promotionLooks > snapshot.limits.maximumPromotionLooks ||
    snapshot.usage.onlineErrorSpent > snapshot.limits.maximumOnlineError
  ) {
    throw new AutonomousOptimizationLoopError(
      "Campaign budget is malformed or already exceeds its sealed limits.",
    );
  }
}

function assertSnapshot(
  snapshot: OptimizationLoopSnapshot,
  expected?: {
    readonly campaignId: string;
    readonly lineageId: string;
    readonly protocolHash: string;
  },
): void {
  if (
    snapshot.schemaVersion !== 1 ||
    !SAFE_ID.test(snapshot.campaignId) ||
    !SAFE_ID.test(snapshot.lineageId) ||
    !SHA256.test(snapshot.protocolHash) ||
    !SHA256.test(snapshot.stateHash) ||
    !["running", "stop-requested", "stopped", "paused"].includes(snapshot.status) ||
    !Number.isSafeInteger(snapshot.nextExperimentNumber) ||
    snapshot.nextExperimentNumber < 1 ||
    (snapshot.inFlightExperimentNumber !== null &&
      (!Number.isSafeInteger(snapshot.inFlightExperimentNumber) ||
        snapshot.inFlightExperimentNumber < 1 ||
        snapshot.inFlightExperimentNumber !== snapshot.nextExperimentNumber - 1)) ||
    (snapshot.inFlightExperimentNumber === null) !== (snapshot.inFlightKind === null) ||
    (snapshot.inFlightKind !== null && snapshot.inFlightKind !== "optimization") ||
    typeof snapshot.hardBudgetExhausted !== "boolean" ||
    !Number.isSafeInteger(snapshot.freshValidationPanelsRemaining) ||
    snapshot.freshValidationPanelsRemaining < 0 ||
    (expected !== undefined &&
      (snapshot.campaignId !== expected.campaignId ||
        snapshot.lineageId !== expected.lineageId ||
        snapshot.protocolHash !== expected.protocolHash))
  ) {
    throw new AutonomousOptimizationLoopError(
      "Campaign loop snapshot is malformed or changed lineage.",
    );
  }
  assertChampion(snapshot.activeChampion);
  assertBudget(snapshot.budget);
}

function assertDiagnosticBrief(brief: ExperimentRunInput["diagnosticBrief"]): void {
  if (
    brief !== null &&
    (!SHA256.test(brief.hash) ||
      !SAFE_RELEASE_ID.test(brief.releaseId) ||
      typeof brief.actionable !== "boolean")
  ) {
    throw new AutonomousOptimizationLoopError("Claimed diagnostic brief reference is malformed.");
  }
}

function assertClaim(claim: ClaimedOptimizationExperiment, before: OptimizationLoopSnapshot): void {
  const input = claim.input;
  assertSnapshot(claim.snapshot, before);
  const resumed = before.inFlightExperimentNumber !== null;
  const allocationTransitionIsValid = resumed
    ? canonicalJson(claim.snapshot) === canonicalJson(before)
    : claim.priorStateHash === before.stateHash &&
      claim.allocationStateHash === claim.currentStateHash &&
      claim.snapshot.stateHash === claim.allocationStateHash &&
      claim.snapshot.status === before.status &&
      claim.snapshot.nextExperimentNumber === before.nextExperimentNumber + 1 &&
      claim.snapshot.inFlightExperimentNumber === before.nextExperimentNumber &&
      claim.snapshot.inFlightKind === "optimization" &&
      canonicalJson(claim.snapshot.activeChampion) === canonicalJson(before.activeChampion) &&
      canonicalJson(claim.snapshot.budget) === canonicalJson(before.budget) &&
      claim.snapshot.hardBudgetExhausted === before.hardBudgetExhausted &&
      claim.snapshot.freshValidationPanelsRemaining === before.freshValidationPanelsRemaining;
  if (
    !SHA256.test(claim.claimHash) ||
    !SHA256.test(claim.priorStateHash) ||
    !SHA256.test(claim.allocationStateHash) ||
    claim.currentStateHash !== claim.snapshot.stateHash ||
    !allocationTransitionIsValid ||
    claim.snapshot.status !== "running" ||
    claim.snapshot.inFlightExperimentNumber === null ||
    input.experiment.number !== claim.snapshot.inFlightExperimentNumber ||
    input.experiment.kind !== "optimization" ||
    input.experiment.parentExperiment !== claim.snapshot.activeChampion.activeExperiment ||
    input.experiment.lineageId !== claim.snapshot.lineageId ||
    input.experiment.protocolHash !== claim.snapshot.protocolHash ||
    canonicalJson(input.activeChampion) !== canonicalJson(claim.snapshot.activeChampion) ||
    canonicalJson(input.budget.limits) !== canonicalJson(claim.snapshot.budget.limits) ||
    typeof input.stop.requested !== "boolean" ||
    (input.experiment.number === 1 &&
      (input.diagnosticBrief !== null || input.previousDiscoveryAttestationHash !== null)) ||
    (input.experiment.number > 1 &&
      (input.previousDiscoveryAttestationHash === null ||
        !SHA256.test(input.previousDiscoveryAttestationHash)))
  ) {
    throw new AutonomousOptimizationLoopError(
      "Claimed experiment is detached from the current campaign snapshot.",
    );
  }
  assertMonotonicBudget(input.budget, claim.snapshot.budget);
  assertDiagnosticBrief(input.diagnosticBrief);
  const expectedClaimHash = canonicalHash({
    domain: "dark-factory.optimization-claim.v2",
    priorStateHash: claim.priorStateHash,
    allocationStateHash: claim.allocationStateHash,
    input,
  });
  if (claim.claimHash !== expectedClaimHash) {
    throw new AutonomousOptimizationLoopError("Optimization claim commitment does not reproduce.");
  }
}

function assertMonotonicBudget(before: BudgetSnapshot, after: BudgetSnapshot): void {
  assertBudget(after);
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
    throw new AutonomousOptimizationLoopError(
      "Experiment result reset or changed a sealed campaign budget.",
    );
  }
}

function assertExperimentResult(
  claim: ClaimedOptimizationExperiment,
  result: ExperimentRunResult,
): void {
  assertMonotonicBudget(claim.input.budget, result.budget);
  assertChampion(result.activeChampion);
  assertDiagnosticBrief(result.diagnosticBrief);
  const promotionLookDelta =
    result.budget.usage.promotionLooks - claim.input.budget.usage.promotionLooks;
  if (
    !SHA256.test(result.sealHash) ||
    (promotionLookDelta !== 0 && promotionLookDelta !== 1) ||
    (result.diagnosticBrief !== null &&
      (!SHA256.test(result.diagnosticBrief.hash) ||
        !SAFE_RELEASE_ID.test(result.diagnosticBrief.releaseId))) ||
    (result.disposition === "promoted" &&
      (result.activeChampion.activeExperiment !== claim.input.experiment.number ||
        result.activeChampion.activeCommit === claim.input.activeChampion.activeCommit ||
        result.activeChampion.baselineCommit !== claim.input.activeChampion.baselineCommit ||
        result.activeChampion.certifiedExperiment !==
          claim.input.activeChampion.certifiedExperiment ||
        result.activeChampion.certifiedCommit !== claim.input.activeChampion.certifiedCommit ||
        promotionLookDelta !== 1)) ||
    (result.disposition !== "promoted" &&
      canonicalJson(result.activeChampion) !== canonicalJson(claim.input.activeChampion))
  ) {
    throw new AutonomousOptimizationLoopError("Experiment result contradicts its sealed claim.");
  }
}

function assertCommittedSnapshot(
  claim: ClaimedOptimizationExperiment,
  result: ExperimentRunResult,
  after: OptimizationLoopSnapshot,
): void {
  const before = claim.snapshot;
  assertSnapshot(after, before);
  const promotionLookDelta =
    result.budget.usage.promotionLooks - claim.input.budget.usage.promotionLooks;
  const expectedPanelsRemaining = before.freshValidationPanelsRemaining - promotionLookDelta;
  if (
    after.stateHash === before.stateHash ||
    after.nextExperimentNumber !== before.nextExperimentNumber ||
    after.inFlightExperimentNumber !== null ||
    after.inFlightKind !== null ||
    canonicalJson(after.budget) !== canonicalJson(result.budget) ||
    canonicalJson(after.activeChampion) !== canonicalJson(result.activeChampion) ||
    after.freshValidationPanelsRemaining !== expectedPanelsRemaining ||
    (result.disposition === "promoted" &&
      after.activeChampion.activeExperiment !== claim.input.experiment.number)
  ) {
    throw new AutonomousOptimizationLoopError(
      "Durable campaign commit does not match the completed experiment.",
    );
  }
}

function assertTerminalClaim(
  claim: TerminalOptimizationClaim,
  identity: {
    readonly campaignId: string;
    readonly lineageId: string;
    readonly protocolHash: string;
  },
): void {
  assertSnapshot(claim.snapshot, identity);
  const remaining = remainingBudget(claim.snapshot.budget);
  const statusReasonMatches =
    (claim.reason === "stop-requested" && claim.snapshot.status === "stop-requested") ||
    (claim.reason === "stopped" && claim.snapshot.status === "stopped") ||
    (claim.reason === "paused" && claim.snapshot.status === "paused");
  const holdoutReasonMatches =
    claim.reason === "holdout-exhausted" &&
    claim.snapshot.inFlightExperimentNumber === null &&
    claim.snapshot.freshValidationPanelsRemaining === 0;
  const minimumAttempts = claim.snapshot.nextExperimentNumber === 1 ? 28 : 37;
  const budgetReasonMatches =
    claim.reason === "budget-exhausted" &&
    claim.snapshot.inFlightExperimentNumber === null &&
    (claim.snapshot.hardBudgetExhausted ||
      remaining.attempts < minimumAttempts ||
      remaining.promotionLooks < 1 ||
      remaining.onlineErrorSpent <= 0 ||
      remaining.spentUsd <= 0 ||
      remaining.tokens <= 0 ||
      remaining.wallTimeMs <= 0);
  if (!statusReasonMatches && !holdoutReasonMatches && !budgetReasonMatches) {
    throw new AutonomousOptimizationLoopError(
      "Terminal claim contradicts its durable campaign snapshot.",
    );
  }
}

function failureClass(
  error: unknown,
): Parameters<ProductionOptimizationCoordinator["interrupt"]>[0]["failureClass"] {
  if (error instanceof Error && /budget/iu.test(`${error.name} ${error.message}`)) {
    return "budget";
  }
  if (
    error instanceof AutonomousOptimizationLoopError ||
    (error instanceof Error &&
      /integrity|schema|signature|protocol|leak/iu.test(`${error.name} ${error.message}`))
  ) {
    return "integrity";
  }
  return "infrastructure";
}

function receipt(
  input: Omit<AutonomousOptimizationLoopReceipt, "receiptHash">,
): AutonomousOptimizationLoopReceipt {
  return {
    ...input,
    receiptHash: canonicalHash(input),
  };
}

export class AutonomousOptimizationLoop {
  readonly #options: AutonomousOptimizationLoopOptions;
  readonly #now: () => Date;

  public constructor(options: AutonomousOptimizationLoopOptions) {
    if (
      !Number.isSafeInteger(options.maximumExperimentsPerInvocation) ||
      options.maximumExperimentsPerInvocation < 1 ||
      options.maximumExperimentsPerInvocation > 1_000
    ) {
      throw new AutonomousOptimizationLoopError(
        "Per-invocation experiment limit is outside policy.",
      );
    }
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  public async run(): Promise<AutonomousOptimizationLoopReceipt> {
    const startedAt = assertTimestamp(this.#now(), "Loop start time");
    let snapshot = await this.#options.coordinator.load();
    assertSnapshot(snapshot);
    const identity = {
      campaignId: snapshot.campaignId,
      lineageId: snapshot.lineageId,
      protocolHash: snapshot.protocolHash,
    };
    const initialStateHash = snapshot.stateHash;
    let experimentsCompleted = 0;
    let promotions = 0;
    let rejections = 0;
    let inconclusive = 0;
    let terminalReason: OptimizationLoopTerminalReason | null = null;

    while (experimentsCompleted < this.#options.maximumExperimentsPerInvocation) {
      assertSnapshot(snapshot, identity);
      if (snapshot.status !== "running") {
        terminalReason = snapshot.status === "stop-requested" ? "stop-requested" : snapshot.status;
        break;
      }
      if (
        snapshot.inFlightExperimentNumber === null &&
        snapshot.freshValidationPanelsRemaining === 0
      ) {
        terminalReason = "holdout-exhausted";
        break;
      }
      const remaining = remainingBudget(snapshot.budget);
      const minimumAttempts =
        (snapshot.inFlightExperimentNumber ?? snapshot.nextExperimentNumber) === 1 ? 28 : 37;
      if (
        snapshot.inFlightExperimentNumber === null &&
        (snapshot.hardBudgetExhausted ||
          remaining.attempts < minimumAttempts ||
          remaining.promotionLooks < 1 ||
          remaining.onlineErrorSpent <= 0 ||
          remaining.spentUsd <= 0 ||
          remaining.tokens <= 0 ||
          remaining.wallTimeMs <= 0)
      ) {
        terminalReason = "budget-exhausted";
        break;
      }

      const claim = await this.#options.coordinator.claimNext(snapshot.stateHash);
      if (claim.kind === "terminal") {
        assertTerminalClaim(claim, identity);
        snapshot = claim.snapshot;
        terminalReason = claim.reason;
        break;
      }
      try {
        assertClaim(claim, snapshot);
        const result = await this.#options.runner.run(claim.input);
        assertExperimentResult(claim, result);
        const committed = await this.#options.coordinator.complete({
          claimHash: claim.claimHash,
          currentStateHash: claim.currentStateHash,
          result,
        });
        assertCommittedSnapshot(claim, result, committed);
        snapshot = committed;
        experimentsCompleted += 1;
        if (result.disposition === "promoted") promotions += 1;
        else if (result.disposition === "rejected") rejections += 1;
        else inconclusive += 1;
      } catch (error) {
        try {
          const interrupted = await this.#options.coordinator.interrupt({
            claimHash: claim.claimHash,
            currentStateHash: claim.currentStateHash,
            failureClass: failureClass(error),
          });
          assertSnapshot(interrupted, identity);
          if (
            interrupted.status === "running" ||
            interrupted.stateHash === claim.currentStateHash
          ) {
            throw new AutonomousOptimizationLoopError(
              "Experiment interruption was not durably reflected in campaign state.",
            );
          }
        } catch (interruptError) {
          throw new AggregateError(
            [error, interruptError],
            "Experiment failed and its durable interruption could not be recorded.",
          );
        }
        throw error;
      }
    }

    if (terminalReason === null) {
      terminalReason =
        snapshot.status === "running"
          ? "invocation-limit"
          : snapshot.status === "stop-requested"
            ? "stop-requested"
            : snapshot.status;
    }
    const finishedAt = assertTimestamp(this.#now(), "Loop finish time");
    if (Date.parse(finishedAt) < Date.parse(startedAt)) {
      throw new AutonomousOptimizationLoopError("Loop finish time precedes its start time.");
    }
    return receipt({
      schemaVersion: 1,
      domain: "dark-factory.autonomous-optimization-loop.v1",
      campaignId: snapshot.campaignId,
      lineageId: snapshot.lineageId,
      protocolHash: snapshot.protocolHash,
      initialStateHash,
      finalStateHash: snapshot.stateHash,
      startedAt,
      finishedAt,
      experimentsCompleted,
      promotions,
      rejections,
      inconclusive,
      terminalReason,
      finalBudgetHash: canonicalHash(snapshot.budget),
      finalChampionHash: canonicalHash(snapshot.activeChampion),
    });
  }
}
