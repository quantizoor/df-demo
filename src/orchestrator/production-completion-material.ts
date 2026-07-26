import type { CampaignLedgerPointers } from "../campaign/store.js";
import { validateBudgetSnapshot } from "../core/budget.js";
import type {
  BudgetSnapshot,
  BudgetUsage,
} from "../domain/models.js";
import {
  assertTrustedOnlineErrorBudgetReconciliation,
  type TrustedOnlineErrorBudgetAuthority,
  type TrustedOnlineErrorBudgetReconciliation,
} from "../evaluator/online-error-authority.js";
import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import type {
  BudgetAccountingMaterialRequest,
  InterruptedBudgetAccountingMaterialRequest,
  SealMaterialRequest,
  TrustedBudgetAccountingMaterial,
  TrustedInterruptedBudgetAccountingMaterial,
  TrustedOptimizationCompletionMaterialPort,
  TrustedOptimizationSealMaterial,
} from "./campaign-state-coordinator.js";
import {
  assertDurableExperimentJournalState,
  latestJournalBudgetForExperiment,
  type AtomicExperimentJournalStateStore,
  type DurableExperimentJournalRecord,
} from "./experiment-journal.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface TrustedCompletionJournalBinding {
  readonly experimentName: string;
  readonly record: DurableExperimentJournalRecord;
  readonly latestBudget: BudgetSnapshot;
}

export interface TrustedCompletionAccountingAttestationRequest {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-optimization-completion-accounting-request";
  readonly requestHash: string;
  readonly request: BudgetAccountingMaterialRequest;
  readonly journal: TrustedCompletionJournalBinding;
}

export interface TrustedInterruptionOnlineErrorStateBinding {
  readonly campaignIdHash: string;
  readonly storeRevision: number;
  readonly policyVersion: "online-alpha-spending-v1";
  readonly maximumOnlineError: number;
  readonly onlineErrorSpent: number;
  readonly onlineErrorRemaining: number;
  readonly gatesSpent: number;
  readonly resultingStateHash: string;
  readonly durableStateCommitment: string;
}

export interface TrustedInFlightOperationLedgerUsageRequest {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-in-flight-operation-ledger-usage-request";
  readonly requestHash: string;
  readonly request: InterruptedBudgetAccountingMaterialRequest;
  readonly journal: TrustedCompletionJournalBinding;
  readonly onlineErrorState: TrustedInterruptionOnlineErrorStateBinding;
}

export interface TrustedInFlightOperationLedgerUsage {
  readonly schemaVersion: 1;
  readonly sensitivity: "release-safe-in-flight-operation-ledger-usage";
  readonly requestHash: string;
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly claimHash: string;
  readonly experimentNumber: number;
  readonly currentStateHash: string;
  readonly budget: BudgetSnapshot;
  readonly closed: true;
  readonly operationLedgerAttestationHash: string;
}

/**
 * The provider closes and snapshots every trusted in-flight operation ledger
 * for the requested experiment. Once closed, an exact requestHash must always
 * reproduce byte-identical material, including after controller restart.
 */
export interface TrustedInFlightOperationLedgerUsageProvider {
  readonly boundary: "trusted-cloud";
  closeAndRead(
    request: TrustedInFlightOperationLedgerUsageRequest,
  ): Promise<TrustedInFlightOperationLedgerUsage>;
}

export interface TrustedCompletionAccountingAttestation {
  readonly schemaVersion: 1;
  readonly sensitivity: "release-safe-optimization-completion-accounting-attestation";
  readonly requestHash: string;
  readonly accountingAttestationHash: string;
  readonly nextUsage: BudgetUsage;
}

export interface TrustedInterruptedAccountingAttestationRequest {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-optimization-interruption-accounting-request";
  readonly requestHash: string;
  readonly request: InterruptedBudgetAccountingMaterialRequest;
  readonly journal: TrustedCompletionJournalBinding;
  /**
   * The volatile observation is not itself the idempotency key. requestHash
   * commits the stable state binding below, including its durable commitment.
   */
  readonly observedOnlineErrorReconciliation: TrustedOnlineErrorBudgetReconciliation;
  readonly onlineErrorState: TrustedInterruptionOnlineErrorStateBinding;
  readonly operationLedger: TrustedInFlightOperationLedgerUsage;
  readonly mergedUsage: BudgetUsage;
}

export interface TrustedInterruptedAccountingAttestation {
  readonly schemaVersion: 1;
  readonly sensitivity: "release-safe-optimization-interruption-accounting-attestation";
  readonly requestHash: string;
  readonly accountingAttestationHash: string;
  readonly nextUsage: BudgetUsage;
  /**
   * This is an exact authority-issued reconciliation receipt, not a receipt
   * synthesized by the orchestration adapter. An idempotent replay returns the
   * originally attested receipt even if a later observation has a new time.
   */
  readonly onlineErrorReconciliation: TrustedOnlineErrorBudgetReconciliation;
}

/**
 * The authority persists a KMS-backed immutable attestation keyed by
 * requestHash. It must return byte-identical material for an exact retry and
 * reject a different payload reusing the same requestHash.
 */
export interface TrustedOptimizationAccountingAttestationAuthority {
  readonly boundary: "trusted-cloud";
  attestCompletion(
    request: TrustedCompletionAccountingAttestationRequest,
  ): Promise<TrustedCompletionAccountingAttestation>;
  attestInterruption(
    request: TrustedInterruptedAccountingAttestationRequest,
  ): Promise<TrustedInterruptedAccountingAttestation>;
}

export interface TrustedCampaignSealAuthorizationRequest {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-optimization-campaign-seal-request";
  readonly requestHash: string;
  readonly request: SealMaterialRequest;
  readonly journal: TrustedCompletionJournalBinding;
}

export interface TrustedCampaignSealAuthorization {
  readonly schemaVersion: 1;
  readonly sensitivity: "release-safe-optimization-campaign-seal-authorization";
  readonly requestHash: string;
  readonly decisionAttestationHash: string;
  readonly holdoutAvailabilityAttestationHash: string | null;
  readonly sealedAt: string;
  readonly ledgers: CampaignLedgerPointers;
}

/**
 * The authority verifies campaign/holdout/ledger state and writes a durable,
 * signed decision attestation. It owns all timestamps and ledger pointers.
 * Exact requestHash retries must return the originally authorized material.
 */
export interface TrustedCampaignSealAuthority {
  readonly boundary: "trusted-cloud";
  authorize(
    request: TrustedCampaignSealAuthorizationRequest,
  ): Promise<TrustedCampaignSealAuthorization>;
}

export interface ProductionOptimizationCompletionMaterialOptions {
  readonly journalStateStore: AtomicExperimentJournalStateStore;
  readonly onlineErrorAuthority: TrustedOnlineErrorBudgetAuthority;
  readonly operationLedgerUsage: TrustedInFlightOperationLedgerUsageProvider;
  readonly accountingAuthority: TrustedOptimizationAccountingAttestationAuthority;
  readonly sealAuthority: TrustedCampaignSealAuthority;
}

export class ProductionOptimizationCompletionMaterialError extends Error {
  override readonly name = "ProductionOptimizationCompletionMaterialError";

  public constructor() {
    super("Trusted optimization completion material failed closed.");
  }
}

function fail(): never {
  throw new ProductionOptimizationCompletionMaterialError();
}

function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail();
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  ) {
    fail();
  }
}

function cloneCanonical<Value>(value: Value): Value {
  try {
    return JSON.parse(canonicalJson(value)) as Value;
  } catch {
    return fail();
  }
}

function assertHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) fail();
}

function assertNullableHash(value: unknown): void {
  if (value !== null) assertHash(value);
}

function assertTimestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail();
  }
}

function assertSafeId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail();
}

const USAGE_KEYS = [
  "spentUsd",
  "tokens",
  "wallTimeMs",
  "attempts",
  "privacyReleases",
  "promotionLooks",
  "onlineErrorSpent",
] as const;

const LIMIT_KEYS = [
  "maximumUsd",
  "maximumTokens",
  "maximumWallTimeMs",
  "maximumAttempts",
  "maximumPrivacyReleases",
  "maximumPromotionLooks",
  "maximumOnlineError",
] as const;

function assertUsage(value: unknown): asserts value is BudgetUsage {
  assertExactKeys(value, USAGE_KEYS);
  const usage = value as unknown as BudgetUsage;
  const all = [
    usage.spentUsd,
    usage.tokens,
    usage.wallTimeMs,
    usage.attempts,
    usage.privacyReleases,
    usage.promotionLooks,
    usage.onlineErrorSpent,
  ];
  const integers = [
    usage.tokens,
    usage.wallTimeMs,
    usage.attempts,
    usage.privacyReleases,
    usage.promotionLooks,
  ];
  if (
    all.some((entry) => !Number.isFinite(entry) || entry < 0) ||
    integers.some((entry) => !Number.isSafeInteger(entry)) ||
    usage.onlineErrorSpent > 1
  ) {
    fail();
  }
}

function assertBudget(value: unknown): asserts value is BudgetSnapshot {
  assertExactKeys(value, ["limits", "usage"]);
  assertExactKeys(value.limits, LIMIT_KEYS);
  assertUsage(value.usage);
  try {
    validateBudgetSnapshot(value as unknown as BudgetSnapshot);
  } catch {
    fail();
  }
}

function assertMonotonicUsage(before: BudgetUsage, after: BudgetUsage): void {
  if (USAGE_KEYS.some((key) => after[key] < before[key])) fail();
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertCommonIdentity(input: {
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly claimHash: string;
  readonly experimentNumber: number;
  readonly currentStateHash: string;
}): void {
  assertSafeId(input.campaignId);
  assertSafeId(input.lineageId);
  assertHash(input.protocolHash);
  assertHash(input.claimHash);
  assertHash(input.currentStateHash);
  if (
    !Number.isSafeInteger(input.experimentNumber) ||
    input.experimentNumber < 1
  ) {
    fail();
  }
}

function assertCompletionRequest(
  value: unknown,
): asserts value is BudgetAccountingMaterialRequest {
  assertExactKeys(value, [
    "schemaVersion",
    "domain",
    "campaignId",
    "lineageId",
    "protocolHash",
    "claimHash",
    "experimentNumber",
    "currentStateHash",
    "previousUsage",
    "reportedUsage",
    "resultSealHash",
  ]);
  const request = value as unknown as BudgetAccountingMaterialRequest;
  if (
    request.schemaVersion !== 1 ||
    request.domain !== "dark-factory.optimization-budget-accounting.v1"
  ) {
    fail();
  }
  assertCommonIdentity(request);
  assertUsage(request.previousUsage);
  assertUsage(request.reportedUsage);
  assertHash(request.resultSealHash);
}

function assertInterruptionRequest(
  value: unknown,
): asserts value is InterruptedBudgetAccountingMaterialRequest {
  assertExactKeys(value, [
    "schemaVersion",
    "domain",
    "campaignId",
    "lineageId",
    "protocolHash",
    "claimHash",
    "experimentNumber",
    "currentStateHash",
    "previousUsage",
  ]);
  const request =
    value as unknown as InterruptedBudgetAccountingMaterialRequest;
  if (
    request.schemaVersion !== 1 ||
    request.domain !== "dark-factory.interrupted-budget-accounting.v1"
  ) {
    fail();
  }
  assertCommonIdentity(request);
  assertUsage(request.previousUsage);
}

function assertSealRequest(value: unknown): asserts value is SealMaterialRequest {
  assertExactKeys(value, [
    "schemaVersion",
    "domain",
    "campaignId",
    "lineageId",
    "protocolHash",
    "claimHash",
    "experimentNumber",
    "currentStateHash",
    "stage",
    "disposition",
    "candidateCommit",
    "resultSealHash",
    "promotionLookDelta",
  ]);
  const request = value as unknown as SealMaterialRequest;
  if (
    request.schemaVersion !== 1 ||
    request.domain !== "dark-factory.optimization-seal-material.v1" ||
    !["pre-validation", "validation"].includes(request.stage) ||
    !["promoted", "rejected", "inconclusive"].includes(
      request.disposition,
    ) ||
    (request.promotionLookDelta !== 0 &&
      request.promotionLookDelta !== 1)
  ) {
    fail();
  }
  assertCommonIdentity(request);
  assertHash(request.resultSealHash);
  if (
    request.candidateCommit !== null &&
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(request.candidateCommit)
  ) {
    fail();
  }
}

function stableOnlineErrorBinding(
  receipt: TrustedOnlineErrorBudgetReconciliation,
): TrustedInterruptionOnlineErrorStateBinding {
  return {
    campaignIdHash: receipt.campaignIdHash,
    storeRevision: receipt.storeRevision,
    policyVersion: receipt.policyVersion,
    maximumOnlineError: receipt.maximumOnlineError,
    onlineErrorSpent: receipt.onlineErrorSpent,
    onlineErrorRemaining: receipt.onlineErrorRemaining,
    gatesSpent: receipt.gatesSpent,
    resultingStateHash: receipt.resultingStateHash,
    durableStateCommitment: receipt.durableStateCommitment,
  };
}

function assertSameOnlineErrorState(
  receipt: TrustedOnlineErrorBudgetReconciliation,
  expected: TrustedInterruptionOnlineErrorStateBinding,
): void {
  if (!sameCanonical(stableOnlineErrorBinding(receipt), expected)) fail();
}

function mergedUsage(
  ...sources: readonly BudgetUsage[]
): BudgetUsage {
  return {
    spentUsd: Math.max(...sources.map((source) => source.spentUsd)),
    tokens: Math.max(...sources.map((source) => source.tokens)),
    wallTimeMs: Math.max(
      ...sources.map((source) => source.wallTimeMs),
    ),
    attempts: Math.max(...sources.map((source) => source.attempts)),
    privacyReleases: Math.max(
      ...sources.map((source) => source.privacyReleases),
    ),
    promotionLooks: Math.max(
      ...sources.map((source) => source.promotionLooks),
    ),
    onlineErrorSpent: Math.max(
      ...sources.map((source) => source.onlineErrorSpent),
    ),
  };
}

function assertLedgerPointers(value: unknown): asserts value is CampaignLedgerPointers {
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
  assertNullableHash(value.cacheStateAttestationHash);
  assertNullableHash(value.publicationQueueHash);
}

/**
 * Production completion material adapter. It treats the durable journal,
 * evaluator alpha ledger, and closed operation ledger as independent
 * authorities. No caller-supplied cumulative counter is trusted in isolation.
 */
export class ProductionOptimizationCompletionMaterial
  implements TrustedOptimizationCompletionMaterialPort
{
  readonly boundary = "trusted-cloud" as const;
  readonly #journalStateStore: AtomicExperimentJournalStateStore;
  readonly #reconcileOnlineError: TrustedOnlineErrorBudgetAuthority["reconcile"];
  readonly #closeAndReadOperations: TrustedInFlightOperationLedgerUsageProvider["closeAndRead"];
  readonly #attestCompletion: TrustedOptimizationAccountingAttestationAuthority["attestCompletion"];
  readonly #attestInterruption: TrustedOptimizationAccountingAttestationAuthority[
    "attestInterruption"
  ];
  readonly #authorizeSeal: TrustedCampaignSealAuthority["authorize"];
  readonly #observedReplays = new Map<string, string>();

  public constructor(
    options: ProductionOptimizationCompletionMaterialOptions,
  ) {
    if (
      options.onlineErrorAuthority.boundary !==
        "trusted-cloud-online-error-authority" ||
      options.operationLedgerUsage.boundary !== "trusted-cloud" ||
      options.accountingAuthority.boundary !== "trusted-cloud" ||
      options.sealAuthority.boundary !== "trusted-cloud"
    ) {
      fail();
    }
    this.#journalStateStore = options.journalStateStore;
    this.#reconcileOnlineError =
      options.onlineErrorAuthority.reconcile.bind(
        options.onlineErrorAuthority,
      );
    this.#closeAndReadOperations =
      options.operationLedgerUsage.closeAndRead.bind(
        options.operationLedgerUsage,
      );
    this.#attestCompletion =
      options.accountingAuthority.attestCompletion.bind(
        options.accountingAuthority,
      );
    this.#attestInterruption =
      options.accountingAuthority.attestInterruption.bind(
        options.accountingAuthority,
      );
    this.#authorizeSeal = options.sealAuthority.authorize.bind(
      options.sealAuthority,
    );
  }

  #assertExactReplay(
    domain: string,
    requestHash: string,
    value: unknown,
  ): void {
    const replayKey = `${domain}:${requestHash}`;
    const canonical = canonicalJson(value);
    const existing = this.#observedReplays.get(replayKey);
    if (existing !== undefined && existing !== canonical) fail();
    this.#observedReplays.set(replayKey, canonical);
  }

  async #readJournal(
    request: {
      readonly experimentNumber: number;
      readonly lineageId: string;
      readonly protocolHash: string;
    },
    terminal: "sealed" | "unsealed",
  ): Promise<TrustedCompletionJournalBinding> {
    return this.#journalStateStore.transact((state) => {
      try {
        assertDurableExperimentJournalState(state);
      } catch {
        fail();
      }
      const numbered = Object.values(state.records).filter(
        (record) =>
          record.experiment.number === request.experimentNumber,
      );
      if (numbered.length !== 1) fail();
      const record = numbered[0];
      if (
        record === undefined ||
        record.experiment.kind !== "optimization" ||
        record.experiment.lineageId !== request.lineageId ||
        record.experiment.protocolHash !== request.protocolHash
      ) {
        fail();
      }
      if (
        (terminal === "sealed" &&
          (record.status !== "sealed" ||
            record.phase !== "sealed" ||
            record.seal === null)) ||
        (terminal === "unsealed" &&
          (record.status === "sealed" || record.seal !== null))
      ) {
        fail();
      }
      let latestBudget: BudgetSnapshot;
      try {
        latestBudget = latestJournalBudgetForExperiment(
          state,
          record.experiment,
        );
      } catch {
        return fail();
      }
      const binding: TrustedCompletionJournalBinding = {
        experimentName: record.experimentName,
        record,
        latestBudget,
      };
      return {
        next: state,
        result: cloneCanonical(binding),
      };
    });
  }

  public async createBudgetAccountingAttestation(
    input: BudgetAccountingMaterialRequest,
  ): Promise<TrustedBudgetAccountingMaterial> {
    const request = cloneCanonical(input);
    assertCompletionRequest(request);
    const journal = await this.#readJournal(request, "sealed");
    const seal = journal.record.seal;
    if (
      seal === null ||
      seal.sealChainEntryHash !== request.resultSealHash ||
      !sameCanonical(
        journal.latestBudget.usage,
        request.reportedUsage,
      )
    ) {
      fail();
    }
    assertMonotonicUsage(
      request.previousUsage,
      request.reportedUsage,
    );
    assertBudget({
      limits: journal.latestBudget.limits,
      usage: request.previousUsage,
    });

    const unsigned = {
      schemaVersion: 1 as const,
      sensitivity:
        "trusted-optimization-completion-accounting-request" as const,
      request,
      journal,
    };
    const requestHash = canonicalHash({
      domain:
        "dark-factory.optimization-completion-accounting-attestation.v1",
      ...unsigned,
    });
    const authorityRequest: TrustedCompletionAccountingAttestationRequest = {
      ...unsigned,
      requestHash,
    };
    const attestation = cloneCanonical(
      await this.#attestCompletion(authorityRequest),
    );
    assertExactKeys(attestation, [
      "schemaVersion",
      "sensitivity",
      "requestHash",
      "accountingAttestationHash",
      "nextUsage",
    ]);
    if (
      attestation.schemaVersion !== 1 ||
      attestation.sensitivity !==
        "release-safe-optimization-completion-accounting-attestation" ||
      attestation.requestHash !== requestHash
    ) {
      fail();
    }
    assertHash(attestation.accountingAttestationHash);
    assertUsage(attestation.nextUsage);
    if (
      attestation.accountingAttestationHash === requestHash ||
      attestation.accountingAttestationHash === request.resultSealHash ||
      !sameCanonical(attestation.nextUsage, request.reportedUsage)
    ) {
      fail();
    }
    this.#assertExactReplay(
      "completion-accounting",
      requestHash,
      attestation,
    );
    return cloneCanonical({
      accountingAttestationHash:
        attestation.accountingAttestationHash,
      nextUsage: attestation.nextUsage,
    });
  }

  public async createInterruptedBudgetAccountingAttestation(
    input: InterruptedBudgetAccountingMaterialRequest,
  ): Promise<TrustedInterruptedBudgetAccountingMaterial> {
    const request = cloneCanonical(input);
    assertInterruptionRequest(request);
    const journal = await this.#readJournal(request, "unsealed");
    assertBudget({
      limits: journal.latestBudget.limits,
      usage: request.previousUsage,
    });

    const observedReconciliation = cloneCanonical(
      await this.#reconcileOnlineError(),
    );
    try {
      assertTrustedOnlineErrorBudgetReconciliation(
        observedReconciliation,
        request.campaignId,
      );
    } catch {
      fail();
    }
    const onlineErrorState = stableOnlineErrorBinding(
      observedReconciliation,
    );
    if (
      onlineErrorState.maximumOnlineError !==
        journal.latestBudget.limits.maximumOnlineError ||
      onlineErrorState.onlineErrorSpent <
        request.previousUsage.onlineErrorSpent ||
      onlineErrorState.onlineErrorSpent <
        journal.latestBudget.usage.onlineErrorSpent
    ) {
      fail();
    }

    const operationUnsigned = {
      schemaVersion: 1 as const,
      sensitivity:
        "trusted-in-flight-operation-ledger-usage-request" as const,
      request,
      journal,
      onlineErrorState,
    };
    const operationRequestHash = canonicalHash({
      domain:
        "dark-factory.in-flight-operation-ledger-usage.v1",
      ...operationUnsigned,
    });
    const operationRequest: TrustedInFlightOperationLedgerUsageRequest = {
      ...operationUnsigned,
      requestHash: operationRequestHash,
    };
    const operationLedger = cloneCanonical(
      await this.#closeAndReadOperations(operationRequest),
    );
    this.#assertOperationLedger(
      operationLedger,
      operationRequest,
      journal.latestBudget.limits,
    );
    this.#assertExactReplay(
      "operation-ledger",
      operationRequestHash,
      operationLedger,
    );
    assertMonotonicUsage(
      request.previousUsage,
      operationLedger.budget.usage,
    );
    if (
      operationLedger.budget.usage.onlineErrorSpent >
      onlineErrorState.onlineErrorSpent
    ) {
      fail();
    }

    const nextUsage = mergedUsage(
      request.previousUsage,
      journal.latestBudget.usage,
      operationLedger.budget.usage,
      {
        ...request.previousUsage,
        onlineErrorSpent: onlineErrorState.onlineErrorSpent,
      },
    );
    if (nextUsage.onlineErrorSpent !== onlineErrorState.onlineErrorSpent) {
      fail();
    }
    assertBudget({
      limits: journal.latestBudget.limits,
      usage: nextUsage,
    });

    const interruptionUnsigned = {
      schemaVersion: 1 as const,
      sensitivity:
        "trusted-optimization-interruption-accounting-request" as const,
      request,
      journal,
      onlineErrorState,
      operationLedger,
      mergedUsage: nextUsage,
    };
    /*
     * observedAt and reconciliationHash deliberately do not enter this stable
     * idempotency key. durableStateCommitment and resultingStateHash bind the
     * same evaluator state without turning a clock-only replay into new work.
     */
    const requestHash = canonicalHash({
      domain:
        "dark-factory.optimization-interruption-accounting-attestation.v1",
      ...interruptionUnsigned,
    });
    const authorityRequest: TrustedInterruptedAccountingAttestationRequest = {
      ...interruptionUnsigned,
      requestHash,
      observedOnlineErrorReconciliation:
        observedReconciliation,
    };
    const attestation = cloneCanonical(
      await this.#attestInterruption(authorityRequest),
    );
    this.#assertInterruptedAttestation(
      attestation,
      requestHash,
      request,
      journal.latestBudget,
      onlineErrorState,
      nextUsage,
      operationLedger.operationLedgerAttestationHash,
    );
    this.#assertExactReplay(
      "interruption-accounting",
      requestHash,
      attestation,
    );
    return cloneCanonical({
      accountingAttestationHash:
        attestation.accountingAttestationHash,
      nextUsage: attestation.nextUsage,
      onlineErrorReconciliation:
        attestation.onlineErrorReconciliation,
    });
  }

  #assertOperationLedger(
    value: unknown,
    request: TrustedInFlightOperationLedgerUsageRequest,
    expectedLimits: BudgetSnapshot["limits"],
  ): asserts value is TrustedInFlightOperationLedgerUsage {
    assertExactKeys(value, [
      "schemaVersion",
      "sensitivity",
      "requestHash",
      "campaignId",
      "lineageId",
      "protocolHash",
      "claimHash",
      "experimentNumber",
      "currentStateHash",
      "budget",
      "closed",
      "operationLedgerAttestationHash",
    ]);
    const ledger =
      value as unknown as TrustedInFlightOperationLedgerUsage;
    assertBudget(ledger.budget);
    assertHash(ledger.operationLedgerAttestationHash);
    if (
      ledger.schemaVersion !== 1 ||
      ledger.sensitivity !==
        "release-safe-in-flight-operation-ledger-usage" ||
      ledger.requestHash !== request.requestHash ||
      ledger.campaignId !== request.request.campaignId ||
      ledger.lineageId !== request.request.lineageId ||
      ledger.protocolHash !== request.request.protocolHash ||
      ledger.claimHash !== request.request.claimHash ||
      ledger.experimentNumber !==
        request.request.experimentNumber ||
      ledger.currentStateHash !==
        request.request.currentStateHash ||
      ledger.closed !== true ||
      ledger.operationLedgerAttestationHash === request.requestHash ||
      !sameCanonical(ledger.budget.limits, expectedLimits)
    ) {
      fail();
    }
  }

  #assertInterruptedAttestation(
    value: unknown,
    requestHash: string,
    request: InterruptedBudgetAccountingMaterialRequest,
    journalBudget: BudgetSnapshot,
    onlineErrorState: TrustedInterruptionOnlineErrorStateBinding,
    expectedUsage: BudgetUsage,
    operationLedgerAttestationHash: string,
  ): asserts value is TrustedInterruptedAccountingAttestation {
    assertExactKeys(value, [
      "schemaVersion",
      "sensitivity",
      "requestHash",
      "accountingAttestationHash",
      "nextUsage",
      "onlineErrorReconciliation",
    ]);
    const attestation =
      value as unknown as TrustedInterruptedAccountingAttestation;
    assertHash(attestation.accountingAttestationHash);
    assertUsage(attestation.nextUsage);
    try {
      assertTrustedOnlineErrorBudgetReconciliation(
        attestation.onlineErrorReconciliation,
        request.campaignId,
      );
    } catch {
      fail();
    }
    assertSameOnlineErrorState(
      attestation.onlineErrorReconciliation,
      onlineErrorState,
    );
    assertBudget({
      limits: journalBudget.limits,
      usage: attestation.nextUsage,
    });
    if (
      attestation.schemaVersion !== 1 ||
      attestation.sensitivity !==
        "release-safe-optimization-interruption-accounting-attestation" ||
      attestation.requestHash !== requestHash ||
      attestation.accountingAttestationHash === requestHash ||
      attestation.accountingAttestationHash ===
        operationLedgerAttestationHash ||
      attestation.accountingAttestationHash ===
        attestation.onlineErrorReconciliation.reconciliationHash ||
      !sameCanonical(attestation.nextUsage, expectedUsage) ||
      attestation.nextUsage.onlineErrorSpent !==
        onlineErrorState.onlineErrorSpent
    ) {
      fail();
    }
  }

  public async createSealMaterial(
    input: SealMaterialRequest,
  ): Promise<TrustedOptimizationSealMaterial> {
    const request = cloneCanonical(input);
    assertSealRequest(request);
    const journal = await this.#readJournal(request, "sealed");
    const seal = journal.record.seal;
    if (
      seal === null ||
      seal.sealChainEntryHash !== request.resultSealHash ||
      seal.evaluationStage !== request.stage ||
      seal.disposition !== request.disposition ||
      request.promotionLookDelta !==
        (request.stage === "validation" ? 1 : 0) ||
      (request.disposition === "promoted") !==
        (request.candidateCommit !== null) ||
      (request.candidateCommit !== null &&
        (request.candidateCommit !==
          journal.record.proposal?.candidate.commit ||
          request.candidateCommit !==
            seal.activeChampionAfter.activeCommit))
    ) {
      fail();
    }
    const unsigned = {
      schemaVersion: 1 as const,
      sensitivity:
        "trusted-optimization-campaign-seal-request" as const,
      request,
      journal,
    };
    const requestHash = canonicalHash({
      domain: "dark-factory.optimization-campaign-seal-authorization.v1",
      ...unsigned,
    });
    const authorityRequest: TrustedCampaignSealAuthorizationRequest = {
      ...unsigned,
      requestHash,
    };
    const authorization = cloneCanonical(
      await this.#authorizeSeal(authorityRequest),
    );
    this.#assertSealAuthorization(
      authorization,
      requestHash,
      request,
      journal.record,
    );
    this.#assertExactReplay(
      "campaign-seal",
      requestHash,
      authorization,
    );
    return cloneCanonical({
      decisionAttestationHash:
        authorization.decisionAttestationHash,
      holdoutAvailabilityAttestationHash:
        authorization.holdoutAvailabilityAttestationHash,
      sealedAt: authorization.sealedAt,
      ledgers: authorization.ledgers,
    });
  }

  #assertSealAuthorization(
    value: unknown,
    requestHash: string,
    request: SealMaterialRequest,
    record: DurableExperimentJournalRecord,
  ): asserts value is TrustedCampaignSealAuthorization {
    assertExactKeys(value, [
      "schemaVersion",
      "sensitivity",
      "requestHash",
      "decisionAttestationHash",
      "holdoutAvailabilityAttestationHash",
      "sealedAt",
      "ledgers",
    ]);
    const authorization =
      value as unknown as TrustedCampaignSealAuthorization;
    assertHash(authorization.decisionAttestationHash);
    assertNullableHash(
      authorization.holdoutAvailabilityAttestationHash,
    );
    assertTimestamp(authorization.sealedAt);
    assertLedgerPointers(authorization.ledgers);
    const seal = record.seal;
    if (seal === null) fail();
    const journalDecisionTime =
      request.disposition === "promoted"
        ? seal.activeChampionAfter.updatedAt
        : seal.sealedAt;
    if (
      authorization.schemaVersion !== 1 ||
      authorization.sensitivity !==
        "release-safe-optimization-campaign-seal-authorization" ||
      authorization.requestHash !== requestHash ||
      authorization.decisionAttestationHash === requestHash ||
      authorization.decisionAttestationHash ===
        seal.authorityAttestationHash ||
      authorization.sealedAt !== journalDecisionTime ||
      (request.stage === "pre-validation" &&
        authorization.holdoutAvailabilityAttestationHash !== null) ||
      (request.stage === "validation" &&
        authorization.holdoutAvailabilityAttestationHash === null)
    ) {
      fail();
    }
  }
}
