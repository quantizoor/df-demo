import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { validateBudgetSnapshot } from "../core/budget.js";
import { updateChampionPointers } from "../core/lifecycle.js";
import { reproduceFreshValidationDisposition } from "../core/validation-decision.js";
import type { BudgetSnapshot, ChampionPointers, ExperimentIdentity } from "../domain/models.js";
import { readAndVerifyEventChain } from "../evidence/events.js";
import {
  type AppendEventInput,
  type ArtifactDocument,
  ExperimentStore,
  type LeakScanSubject,
  type SealExperimentOptions,
} from "../evidence/store.js";
import type { Attestation, EventRecord, LeakScanReceipt } from "../schemas/artifacts.js";
import { canonicalHash, canonicalJson, hasValidContentHash } from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import { assertValidDocument, REQUIRED_PRESEAL_ARTIFACT_FILES } from "../schemas/registry.js";
import { assertReleaseSafe } from "../schemas/safety.js";
import type {
  DiagnosticBriefReference,
  ExperimentJournal,
  FrozenCandidate,
  FrozenHypothesis,
  GateResult,
  OptimizerProposal,
  RepairAggregate,
  ValidationAggregate,
} from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const EXPERIMENT_NAME = /^\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const SAFE_RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export const EXPERIMENT_JOURNAL_STATE_VERSION = 1 as const;
export const EXPERIMENT_JOURNAL_STATE_SENSITIVITY = "release-safe-experiment-journal" as const;

export type ExperimentJournalPhase =
  | "created"
  | "proposal-frozen"
  | "gates-recorded"
  | "gates-budgeted"
  | "repair-recorded"
  | "repair-budgeted"
  | "pre-validation-budgeted"
  | "validation-budgeted"
  | "validation-recorded"
  | "analysis-recorded"
  | "diagnostic-budgeted"
  | "sealed";

export type ExperimentJournalOperation =
  | "create"
  | "proposal"
  | "gates"
  | "gates-budget"
  | "repair"
  | "repair-budget"
  | "pre-validation-budget"
  | "validation-budget"
  | "validation"
  | "analysis"
  | "diagnostic-budget"
  | "seal"
  | "interrupt";

interface JournalOperationHashes {
  readonly create: string;
  readonly proposal: string | null;
  readonly gates: string | null;
  readonly gatesBudget: string | null;
  readonly repair: string | null;
  readonly repairBudget: string | null;
  readonly preValidationBudget: string | null;
  readonly validationBudget: string | null;
  readonly validation: string | null;
  readonly analysis: string | null;
  readonly diagnosticBudget: string | null;
  readonly seal: string | null;
  readonly interrupt: string | null;
}

interface RecordedValidation {
  readonly aggregate: ValidationAggregate;
  readonly panelDispositionAttestationHash: string;
}

export interface ReleaseSafeJournalInterruption {
  readonly phase: string;
  readonly reasonCode: string;
  readonly attestationHash: string;
  readonly interruptedAt: string;
  readonly abandonedOperation: ExperimentJournalOperation | null;
  readonly abandonedOperationHash: string | null;
}

export interface ReleaseSafeExperimentSeal {
  readonly disposition: "promoted" | "rejected" | "inconclusive";
  readonly evaluationStage: "pre-validation" | "validation";
  readonly diagnosticBrief: DiagnosticBriefReference | null;
  readonly authorityAttestationHash: string;
  readonly attestationContentHash: string;
  readonly sealChainEntryHash: string;
  readonly previousExperimentSealHash: string | null;
  readonly activeChampionAfter: ChampionPointers;
  readonly sealedAt: string;
}

export interface DurableExperimentJournalRecord {
  readonly experimentName: string;
  readonly experiment: ExperimentIdentity;
  readonly status: "active" | "interrupted" | "sealed";
  readonly phase: ExperimentJournalPhase;
  readonly startedAt: string;
  readonly activeChampionBefore: ChampionPointers;
  readonly initialBudget: BudgetSnapshot;
  readonly proposal: OptimizerProposal | null;
  readonly gates: GateResult | null;
  readonly repair: RepairAggregate | null;
  readonly validation: RecordedValidation | null;
  readonly analysisHash: string | null;
  readonly gatesBudget: BudgetSnapshot | null;
  readonly repairBudget: BudgetSnapshot | null;
  readonly preValidationBudget: BudgetSnapshot | null;
  readonly validationBudget: BudgetSnapshot | null;
  readonly diagnosticBudget: BudgetSnapshot | null;
  readonly operationHashes: JournalOperationHashes;
  readonly interruption: ReleaseSafeJournalInterruption | null;
  readonly seal: ReleaseSafeExperimentSeal | null;
}

interface PendingJournalOperation {
  readonly experimentName: string;
  readonly operation: ExperimentJournalOperation;
  readonly inputHash: string;
  readonly startedAt: string;
}

interface BegunJournalOperation {
  readonly replay: boolean;
  readonly state: DurableExperimentJournalState;
  readonly record: DurableExperimentJournalRecord | undefined;
  readonly startedAt: string;
}

export interface DurableExperimentJournalState {
  readonly schemaVersion: typeof EXPERIMENT_JOURNAL_STATE_VERSION;
  readonly sensitivity: typeof EXPERIMENT_JOURNAL_STATE_SENSITIVITY;
  readonly revision: number;
  readonly lastSealedExperimentNumber: number | null;
  readonly sealChainHead: string | null;
  readonly pendingOperation: PendingJournalOperation | null;
  readonly records: Readonly<Record<string, DurableExperimentJournalRecord>>;
}

export interface AtomicExperimentJournalStateStore {
  /**
   * Implementations must provide a fenced, linearizable transaction and
   * persist the validated state as canonical JSON. The callback is synchronous
   * so external evidence writes never execute while a storage lock is held.
   */
  transact<Result>(
    operation: (state: DurableExperimentJournalState) => {
      readonly next: DurableExperimentJournalState;
      readonly result: Result;
    },
  ): Promise<Result>;
}

type RequiredPresealArtifactFile = (typeof REQUIRED_PRESEAL_ARTIFACT_FILES)[number];

export type ReleaseSafeExperimentArtifactSet = {
  readonly [FileName in RequiredPresealArtifactFile]: ArtifactDocument<FileName>;
};

export interface ReleaseSafeFinalExperimentSnapshot {
  readonly schemaVersion: 1;
  readonly assemblyRequestHash: string;
  readonly experimentName: string;
  readonly experiment: ExperimentIdentity;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly activeChampionBefore: ChampionPointers;
  readonly initialBudget: BudgetSnapshot;
  readonly finalBudget: BudgetSnapshot;
  readonly proposal: OptimizerProposal;
  readonly gates: GateResult;
  readonly repair: RepairAggregate | null;
  readonly validation: RecordedValidation | null;
  readonly analysisHash: string;
  readonly disposition: "promoted" | "rejected" | "inconclusive";
  readonly evaluationStage: "pre-validation" | "validation";
  readonly promotedCandidate: {
    readonly experimentNumber: number;
    readonly commit: string;
    readonly decidedAt: string;
  } | null;
  readonly diagnosticBrief: DiagnosticBriefReference | null;
}

/**
 * This trusted port may resolve broker-side release-safe plan details that are
 * intentionally absent from ExperimentJournal callbacks. It must be
 * idempotent by assemblyRequestHash and must never return task identities,
 * grader prose, raw trajectories, or panel handles.
 */
export interface TrustedReleaseSafeExperimentArtifactAssembler {
  assemble(snapshot: ReleaseSafeFinalExperimentSnapshot): Promise<ReleaseSafeExperimentArtifactSet>;
}

export interface TrustedExperimentSealAuthorization {
  readonly authorityAttestationHash: string;
  readonly pinnedVersions: Attestation["pinnedVersions"];
  readonly leakScanReceipt: LeakScanReceipt;
  readonly signer: Signature | null;
}

/**
 * The authority performs the real leak scan and signing operation. The
 * journal deliberately has no private key and never fabricates a receipt.
 * Implementations must return the same authorization for the same requestHash.
 */
export interface TrustedExperimentSealAuthority {
  authorize(input: {
    readonly requestHash: string;
    readonly subject: LeakScanSubject;
    readonly previousExperimentSealHash: string | null;
    readonly assemblyRequestHash: string;
  }): Promise<TrustedExperimentSealAuthorization>;
}

/**
 * Raw errors can contain hidden evaluator material. Only this trusted port may
 * inspect them; the durable journal receives a bounded reason code and an
 * opaque immutable attestation. Implementations must be idempotent for the
 * same canonical input.
 */
export interface TrustedJournalInterruptionAttestor {
  attest(input: {
    readonly experiment: ExperimentIdentity;
    readonly phase: string;
    readonly reason: string;
  }): Promise<{
    readonly reasonCode: string;
    readonly attestationHash: string;
  }>;
}

export interface ProductionExperimentJournalOptions {
  readonly evidenceStore: ExperimentStore;
  readonly stateStore: AtomicExperimentJournalStateStore;
  readonly artifactAssembler: TrustedReleaseSafeExperimentArtifactAssembler;
  readonly sealAuthority: TrustedExperimentSealAuthority;
  readonly interruptionAttestor: TrustedJournalInterruptionAttestor;
  readonly now?: () => Date;
}

export class ProductionExperimentJournalError extends Error {
  override readonly name = "ProductionExperimentJournalError";
}

function fail(message: string): never {
  throw new ProductionExperimentJournalError(message);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
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
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail(`${label} must be a plain object.`);
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    fail(`${label} contains non-canonical fields.`);
  }
}

function canonicalClone<Value>(value: Value, label: string): Value {
  try {
    return JSON.parse(canonicalJson(value)) as Value;
  } catch {
    return fail(`${label} is not canonical JSON.`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail(`${label} is not a canonical timestamp.`);
  }
}

function nowTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("Experiment journal clock returned an invalid date.");
  }
  return value.toISOString();
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label} is not a lowercase SHA-256 digest.`);
  }
}

function assertNullableHash(value: unknown, label: string): void {
  if (value !== null) assertHash(value, label);
}

function assertExperimentIdentity(value: unknown): asserts value is ExperimentIdentity {
  assertExactKeys(
    value,
    ["number", "slug", "kind", "parentExperiment", "lineageId", "protocolHash"],
    "Experiment identity",
  );
  const identity = value as unknown as ExperimentIdentity;
  if (
    !Number.isSafeInteger(identity.number) ||
    identity.number < 1 ||
    typeof identity.slug !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(identity.slug) ||
    identity.slug.length > 64 ||
    !["baseline", "optimization", "shadow"].includes(identity.kind) ||
    (identity.parentExperiment !== null &&
      (!Number.isSafeInteger(identity.parentExperiment) || identity.parentExperiment < 0)) ||
    typeof identity.lineageId !== "string" ||
    !SAFE_ID.test(identity.lineageId)
  ) {
    fail("Experiment identity is malformed.");
  }
  assertHash(identity.protocolHash, "Experiment protocol hash");
}

function assertChampionPointers(value: unknown): asserts value is ChampionPointers {
  assertExactKeys(
    value,
    [
      "baselineCommit",
      "activeExperiment",
      "activeCommit",
      "certifiedExperiment",
      "certifiedCommit",
      "updatedAt",
      "sourceSealHash",
    ],
    "Champion pointers",
  );
  const pointers = value as unknown as ChampionPointers;
  if (
    typeof pointers.baselineCommit !== "string" ||
    !COMMIT.test(pointers.baselineCommit) ||
    !Number.isSafeInteger(pointers.activeExperiment) ||
    pointers.activeExperiment < 0 ||
    typeof pointers.activeCommit !== "string" ||
    !COMMIT.test(pointers.activeCommit) ||
    (pointers.certifiedExperiment !== null &&
      (!Number.isSafeInteger(pointers.certifiedExperiment) || pointers.certifiedExperiment < 0)) ||
    (pointers.certifiedCommit !== null &&
      (typeof pointers.certifiedCommit !== "string" || !COMMIT.test(pointers.certifiedCommit))) ||
    (pointers.certifiedExperiment === null) !== (pointers.certifiedCommit === null)
  ) {
    fail("Champion pointers are malformed.");
  }
  assertTimestamp(pointers.updatedAt, "Champion update timestamp");
  assertHash(pointers.sourceSealHash, "Champion source seal hash");
}

function assertBudget(value: unknown): asserts value is BudgetSnapshot {
  assertExactKeys(value, ["limits", "usage"], "Budget snapshot");
  assertExactKeys(
    value.limits,
    [
      "maximumUsd",
      "maximumTokens",
      "maximumWallTimeMs",
      "maximumAttempts",
      "maximumPrivacyReleases",
      "maximumPromotionLooks",
      "maximumOnlineError",
    ],
    "Budget limits",
  );
  assertExactKeys(
    value.usage,
    [
      "spentUsd",
      "tokens",
      "wallTimeMs",
      "attempts",
      "privacyReleases",
      "promotionLooks",
      "onlineErrorSpent",
    ],
    "Budget usage",
  );
  try {
    validateBudgetSnapshot(value as unknown as BudgetSnapshot);
  } catch {
    fail("Budget snapshot is invalid.");
  }
  const snapshot = value as unknown as BudgetSnapshot;
  const integerValues = [
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
    integerValues.some((entry) => !Number.isSafeInteger(entry)) ||
    snapshot.usage.spentUsd > snapshot.limits.maximumUsd ||
    snapshot.usage.tokens > snapshot.limits.maximumTokens ||
    snapshot.usage.wallTimeMs > snapshot.limits.maximumWallTimeMs ||
    snapshot.usage.attempts > snapshot.limits.maximumAttempts ||
    snapshot.usage.privacyReleases > snapshot.limits.maximumPrivacyReleases ||
    snapshot.usage.promotionLooks > snapshot.limits.maximumPromotionLooks ||
    snapshot.usage.onlineErrorSpent > snapshot.limits.maximumOnlineError
  ) {
    fail("Budget snapshot exceeds its sealed limits.");
  }
}

function assertSameBudgetLimits(before: BudgetSnapshot, after: BudgetSnapshot): void {
  if (canonicalJson(before.limits) !== canonicalJson(after.limits)) {
    fail("An experiment journal update changed the sealed budget limits.");
  }
}

function approximatelyEqual(left: number, right: number, tolerance = 1e-9): boolean {
  return Math.abs(left - right) <= tolerance;
}

function usageDelta(before: BudgetSnapshot, after: BudgetSnapshot): BudgetSnapshot["usage"] {
  assertBudget(after);
  assertSameBudgetLimits(before, after);
  const delta = {
    spentUsd: after.usage.spentUsd - before.usage.spentUsd,
    tokens: after.usage.tokens - before.usage.tokens,
    wallTimeMs: after.usage.wallTimeMs - before.usage.wallTimeMs,
    attempts: after.usage.attempts - before.usage.attempts,
    privacyReleases: after.usage.privacyReleases - before.usage.privacyReleases,
    promotionLooks: after.usage.promotionLooks - before.usage.promotionLooks,
    onlineErrorSpent: after.usage.onlineErrorSpent - before.usage.onlineErrorSpent,
  };
  if (Object.values(delta).some((value) => value < 0)) {
    fail("An experiment journal update reset campaign budget usage.");
  }
  return delta;
}

function assertAggregateBudgetDelta(
  before: BudgetSnapshot,
  after: BudgetSnapshot,
  aggregate: {
    readonly aggregateCostUsd: number;
    readonly tokens: number;
    readonly wallTimeMs: number;
    readonly attempts?: number;
    readonly onlineErrorSpent?: number;
  },
  label: string,
): void {
  const delta = usageDelta(before, after);
  if (
    !approximatelyEqual(delta.spentUsd, aggregate.aggregateCostUsd) ||
    delta.tokens !== aggregate.tokens ||
    delta.wallTimeMs !== aggregate.wallTimeMs ||
    delta.attempts !== (aggregate.attempts ?? 0) ||
    delta.privacyReleases !== 0 ||
    delta.promotionLooks !== 0 ||
    !approximatelyEqual(delta.onlineErrorSpent, aggregate.onlineErrorSpent ?? 0, 1e-12)
  ) {
    fail(`${label} budget checkpoint does not bind its recorded aggregate.`);
  }
}

function assertFrozenHypothesis(value: unknown): asserts value is FrozenHypothesis {
  assertExactKeys(
    value,
    [
      "hash",
      "sourceBriefHash",
      "causalClaim",
      "intervention",
      "predictedRepairBehavior",
      "predictedFreshEffect",
      "falsificationCriteria",
      "rollbackCondition",
    ],
    "Frozen hypothesis",
  );
  assertHash(value.hash, "Frozen hypothesis hash");
  assertNullableHash(value.sourceBriefHash, "Frozen hypothesis source brief hash");
  const textFields = [
    value.causalClaim,
    value.intervention,
    value.predictedRepairBehavior,
    value.predictedFreshEffect,
    value.rollbackCondition,
  ];
  if (
    textFields.some(
      (entry) => typeof entry !== "string" || entry.length < 1 || entry.length > 1_000,
    ) ||
    !Array.isArray(value.falsificationCriteria) ||
    value.falsificationCriteria.length < 1 ||
    value.falsificationCriteria.length > 12 ||
    value.falsificationCriteria.some(
      (entry) => typeof entry !== "string" || entry.length < 1 || entry.length > 1_000,
    )
  ) {
    fail("Frozen hypothesis is malformed.");
  }
  assertReleaseSafe(value);
}

function assertFrozenCandidate(value: unknown): asserts value is FrozenCandidate {
  assertExactKeys(
    value,
    ["commit", "patchHash", "changedFiles", "mutationCategory"],
    "Frozen candidate",
  );
  if (
    typeof value.commit !== "string" ||
    !COMMIT.test(value.commit) ||
    !Array.isArray(value.changedFiles) ||
    value.changedFiles.length > 128 ||
    value.changedFiles.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length < 1 ||
        entry.length > 512 ||
        entry.startsWith("/") ||
        /(?:^|\/)\.\.(?:\/|$)/u.test(entry),
    ) ||
    new Set(value.changedFiles).size !== value.changedFiles.length ||
    typeof value.mutationCategory !== "string" ||
    ![
      "system-prompt",
      "tool-policy",
      "context-management",
      "recovery",
      "planning",
      "verification",
      "other",
    ].includes(value.mutationCategory)
  ) {
    fail("Frozen candidate is malformed.");
  }
  assertHash(value.patchHash, "Frozen candidate patch hash");
  assertReleaseSafe(value);
}

function assertProposal(value: unknown): asserts value is OptimizerProposal {
  assertExactKeys(value, ["hypothesis", "candidate"], "Optimizer proposal");
  assertFrozenHypothesis(value.hypothesis);
  assertFrozenCandidate(value.candidate);
}

function assertGate(value: unknown): asserts value is GateResult {
  assertExactKeys(
    value,
    [
      "passed",
      "integrityPassed",
      "protocolHash",
      "checksHash",
      "aggregateCostUsd",
      "tokens",
      "wallTimeMs",
      "failureCode",
    ],
    "Correctness gate result",
  );
  const gate = value as unknown as GateResult;
  if (
    typeof gate.passed !== "boolean" ||
    typeof gate.integrityPassed !== "boolean" ||
    !Number.isFinite(gate.aggregateCostUsd) ||
    gate.aggregateCostUsd < 0 ||
    !Number.isSafeInteger(gate.tokens) ||
    gate.tokens < 0 ||
    !Number.isSafeInteger(gate.wallTimeMs) ||
    gate.wallTimeMs < 0 ||
    (gate.failureCode !== null &&
      (typeof gate.failureCode !== "string" || !SAFE_RELEASE_ID.test(gate.failureCode)))
  ) {
    fail("Correctness gate result is malformed.");
  }
  assertHash(gate.protocolHash, "Correctness gate protocol hash");
  assertHash(gate.checksHash, "Correctness gate checks hash");
}

function assertRepair(value: unknown): asserts value is RepairAggregate {
  assertExactKeys(
    value,
    [
      "disposition",
      "attemptOrdinal",
      "integrityPassed",
      "cacheStatus",
      "aggregateCostUsd",
      "tokens",
      "wallTimeMs",
      "attempts",
      "attestationHash",
    ],
    "Repair aggregate",
  );
  const repair = value as unknown as RepairAggregate;
  if (
    !["passed", "rejected", "inconclusive"].includes(repair.disposition) ||
    (repair.attemptOrdinal !== 1 && repair.attemptOrdinal !== 2) ||
    typeof repair.integrityPassed !== "boolean" ||
    !["not-used", "eligible", "miss", "drift-failed"].includes(repair.cacheStatus) ||
    !Number.isFinite(repair.aggregateCostUsd) ||
    repair.aggregateCostUsd < 0 ||
    !Number.isSafeInteger(repair.tokens) ||
    repair.tokens < 0 ||
    !Number.isSafeInteger(repair.wallTimeMs) ||
    repair.wallTimeMs < 0 ||
    !Number.isSafeInteger(repair.attempts) ||
    repair.attempts < 1 ||
    repair.attempts > 14 ||
    (repair.disposition === "passed" && repair.integrityPassed !== true)
  ) {
    fail("Repair aggregate is malformed.");
  }
  assertHash(repair.attestationHash, "Repair attestation hash");
}

function assertValidation(value: unknown): asserts value is ValidationAggregate {
  assertExactKeys(
    value,
    [
      "disposition",
      "validPairs",
      "validArms",
      "replacementAttempts",
      "probabilityPositive",
      "medianAccuracyDelta",
      "requiredPosteriorProbability",
      "onlineGateAuthorized",
      "onlineErrorBudget",
      "stratumRegressionVeto",
      "integrityVeto",
      "correctnessVeto",
      "capabilityVeto",
      "costWithinGuardrail",
      "latencyWithinGuardrail",
      "accuracyTradeoffPredeclared",
      "aggregateCostUsd",
      "tokens",
      "wallTimeMs",
      "attestationHash",
      "releasedEvidenceHash",
      "behavioralSourceCommitmentHash",
      "attemptAccounting",
    ],
    "Validation aggregate",
  );
  const aggregate = value as unknown as ValidationAggregate;
  if (
    !["promoted", "rejected", "inconclusive"].includes(aggregate.disposition) ||
    aggregate.validPairs !== 12 ||
    aggregate.validArms !== 24 ||
    !Number.isSafeInteger(aggregate.replacementAttempts) ||
    aggregate.replacementAttempts < 0 ||
    aggregate.replacementAttempts > 4 ||
    !Number.isFinite(aggregate.probabilityPositive) ||
    aggregate.probabilityPositive < 0 ||
    aggregate.probabilityPositive > 1 ||
    !Number.isFinite(aggregate.medianAccuracyDelta) ||
    aggregate.medianAccuracyDelta < -1 ||
    aggregate.medianAccuracyDelta > 1 ||
    !Number.isFinite(aggregate.requiredPosteriorProbability) ||
    aggregate.requiredPosteriorProbability < 0 ||
    aggregate.requiredPosteriorProbability > 1 ||
    !Number.isFinite(aggregate.aggregateCostUsd) ||
    aggregate.aggregateCostUsd < 0 ||
    !Number.isSafeInteger(aggregate.tokens) ||
    aggregate.tokens < 0 ||
    !Number.isSafeInteger(aggregate.wallTimeMs) ||
    aggregate.wallTimeMs < 0
  ) {
    fail("Validation aggregate is malformed.");
  }
  const booleans = [
    aggregate.onlineGateAuthorized,
    aggregate.stratumRegressionVeto,
    aggregate.integrityVeto,
    aggregate.correctnessVeto,
    aggregate.capabilityVeto,
    aggregate.costWithinGuardrail,
    aggregate.latencyWithinGuardrail,
    aggregate.accuracyTradeoffPredeclared,
  ];
  if (booleans.some((entry) => typeof entry !== "boolean")) {
    fail("Validation decision inputs are malformed.");
  }
  const reproduced = reproduceFreshValidationDisposition({
    probabilityPositive: aggregate.probabilityPositive,
    medianAccuracyDelta: aggregate.medianAccuracyDelta,
    requiredPosteriorProbability: aggregate.requiredPosteriorProbability,
    onlineGateAuthorized: aggregate.onlineGateAuthorized,
    stratumRegressionVeto: aggregate.stratumRegressionVeto,
    integrityVeto: aggregate.integrityVeto,
    correctnessVeto: aggregate.correctnessVeto,
    capabilityVeto: aggregate.capabilityVeto,
    costWithinGuardrail: aggregate.costWithinGuardrail,
    latencyWithinGuardrail: aggregate.latencyWithinGuardrail,
    accuracyTradeoffPredeclared: aggregate.accuracyTradeoffPredeclared,
  });
  const expectedDisposition =
    reproduced === "promote" ? "promoted" : reproduced === "reject" ? "rejected" : "inconclusive";
  if (aggregate.disposition !== expectedDisposition) {
    fail("Validation disposition does not reproduce from frozen policy inputs.");
  }
  assertExactKeys(
    aggregate.onlineErrorBudget,
    [
      "policyVersion",
      "maximumOnlineError",
      "gateOrdinal",
      "alphaSpent",
      "cumulativeSpentBefore",
      "cumulativeSpentAfter",
      "remainingAfter",
      "reservationHash",
      "priorStateHash",
      "resultingStateHash",
    ],
    "Validation online-error accounting",
  );
  const onlineErrorBudget = aggregate.onlineErrorBudget;
  if (
    onlineErrorBudget.policyVersion !== "online-alpha-spending-v1" ||
    !Number.isFinite(onlineErrorBudget.maximumOnlineError) ||
    onlineErrorBudget.maximumOnlineError <= 0 ||
    onlineErrorBudget.maximumOnlineError > 1 ||
    !Number.isSafeInteger(onlineErrorBudget.gateOrdinal) ||
    onlineErrorBudget.gateOrdinal < 1 ||
    !Number.isFinite(onlineErrorBudget.alphaSpent) ||
    onlineErrorBudget.alphaSpent <= 0 ||
    onlineErrorBudget.alphaSpent > 1 ||
    !Number.isFinite(onlineErrorBudget.cumulativeSpentBefore) ||
    onlineErrorBudget.cumulativeSpentBefore < 0 ||
    !Number.isFinite(onlineErrorBudget.cumulativeSpentAfter) ||
    onlineErrorBudget.cumulativeSpentAfter < 0 ||
    !Number.isFinite(onlineErrorBudget.remainingAfter) ||
    onlineErrorBudget.remainingAfter < 0 ||
    onlineErrorBudget.cumulativeSpentAfter > onlineErrorBudget.maximumOnlineError ||
    onlineErrorBudget.cumulativeSpentAfter !==
      onlineErrorBudget.cumulativeSpentBefore + onlineErrorBudget.alphaSpent ||
    Math.abs(
      onlineErrorBudget.cumulativeSpentAfter +
        onlineErrorBudget.remainingAfter -
        onlineErrorBudget.maximumOnlineError,
    ) > 1e-12 ||
    onlineErrorBudget.priorStateHash === onlineErrorBudget.resultingStateHash ||
    aggregate.onlineGateAuthorized !== true ||
    aggregate.requiredPosteriorProbability !== Math.max(0.95, 1 - onlineErrorBudget.alphaSpent)
  ) {
    fail("Validation online-error accounting is malformed.");
  }
  assertHash(onlineErrorBudget.reservationHash, "Online-error reservation hash");
  assertHash(onlineErrorBudget.priorStateHash, "Online-error prior state hash");
  assertHash(onlineErrorBudget.resultingStateHash, "Online-error resulting state hash");
  assertHash(aggregate.attestationHash, "Validation attestation hash");
  assertNullableHash(aggregate.releasedEvidenceHash, "Validation released evidence hash");
  assertNullableHash(
    aggregate.behavioralSourceCommitmentHash,
    "Validation behavioral source commitment hash",
  );
  if (
    (aggregate.releasedEvidenceHash !== null) !==
    (aggregate.behavioralSourceCommitmentHash !== null)
  ) {
    fail("Validation diagnostic and source commitments disagree.");
  }
  assertExactKeys(
    aggregate.attemptAccounting,
    [
      "policyVersion",
      "terminalStatus",
      "presealedPairCount",
      "presealedArmCount",
      "validArmCount",
      "attemptedArmCount",
      "unresolvedArmCount",
      "totalAttemptCount",
      "replacementAttemptCount",
      "infrastructureFailureCount",
      "nonInfrastructureFailureCount",
      "containsPanelHandle",
      "containsTaskIdentifiers",
      "containsCellIdentifiers",
      "containsAttemptIdentifiers",
      "containsEvidenceIdentifiers",
    ],
    "Validation attempt accounting",
  );
  const attempts = aggregate.attemptAccounting;
  if (
    typeof attempts.policyVersion !== "string" ||
    !SAFE_ID.test(attempts.policyVersion) ||
    attempts.terminalStatus !== "complete" ||
    attempts.presealedPairCount !== 12 ||
    attempts.presealedArmCount !== 24 ||
    attempts.validArmCount !== 24 ||
    attempts.attemptedArmCount !== 24 ||
    attempts.unresolvedArmCount !== 0 ||
    attempts.totalAttemptCount !== 24 + aggregate.replacementAttempts ||
    attempts.replacementAttemptCount !== aggregate.replacementAttempts ||
    attempts.infrastructureFailureCount !== aggregate.replacementAttempts ||
    attempts.nonInfrastructureFailureCount !== 0 ||
    attempts.containsPanelHandle !== false ||
    attempts.containsTaskIdentifiers !== false ||
    attempts.containsCellIdentifiers !== false ||
    attempts.containsAttemptIdentifiers !== false ||
    attempts.containsEvidenceIdentifiers !== false
  ) {
    fail("Validation attempt accounting is not release-safe and terminal.");
  }
}

function assertDiagnosticBriefReference(value: unknown): asserts value is DiagnosticBriefReference {
  assertExactKeys(value, ["hash", "releaseId", "actionable"], "Diagnostic brief reference");
  assertHash(value.hash, "Diagnostic brief hash");
  if (
    typeof value.releaseId !== "string" ||
    !SAFE_RELEASE_ID.test(value.releaseId) ||
    typeof value.actionable !== "boolean"
  ) {
    fail("Diagnostic brief reference is malformed.");
  }
}

function assertOperationHashes(value: unknown): asserts value is JournalOperationHashes {
  assertExactKeys(
    value,
    [
      "create",
      "proposal",
      "gates",
      "gatesBudget",
      "repair",
      "repairBudget",
      "preValidationBudget",
      "validationBudget",
      "validation",
      "analysis",
      "diagnosticBudget",
      "seal",
      "interrupt",
    ],
    "Journal operation hashes",
  );
  assertHash(value.create, "Create operation hash");
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "create") assertNullableHash(entry, `${key} operation hash`);
  }
}

function assertInterruption(value: unknown): asserts value is ReleaseSafeJournalInterruption {
  assertExactKeys(
    value,
    [
      "phase",
      "reasonCode",
      "attestationHash",
      "interruptedAt",
      "abandonedOperation",
      "abandonedOperationHash",
    ],
    "Journal interruption",
  );
  if (
    typeof value.phase !== "string" ||
    !SAFE_ID.test(value.phase) ||
    typeof value.reasonCode !== "string" ||
    !SAFE_RELEASE_ID.test(value.reasonCode) ||
    (value.abandonedOperation !== null &&
      !JOURNAL_OPERATIONS.includes(value.abandonedOperation as ExperimentJournalOperation)) ||
    (value.abandonedOperation === null) !== (value.abandonedOperationHash === null)
  ) {
    fail("Journal interruption is malformed.");
  }
  assertHash(value.attestationHash, "Interruption attestation hash");
  assertNullableHash(value.abandonedOperationHash, "Abandoned operation hash");
  assertTimestamp(value.interruptedAt, "Interruption timestamp");
}

const JOURNAL_PHASES: readonly ExperimentJournalPhase[] = [
  "created",
  "proposal-frozen",
  "gates-recorded",
  "gates-budgeted",
  "repair-recorded",
  "repair-budgeted",
  "pre-validation-budgeted",
  "validation-budgeted",
  "validation-recorded",
  "analysis-recorded",
  "diagnostic-budgeted",
  "sealed",
];

const JOURNAL_OPERATIONS: readonly ExperimentJournalOperation[] = [
  "create",
  "proposal",
  "gates",
  "gates-budget",
  "repair",
  "repair-budget",
  "pre-validation-budget",
  "validation-budget",
  "validation",
  "analysis",
  "diagnostic-budget",
  "seal",
  "interrupt",
];

function assertSeal(value: unknown): asserts value is ReleaseSafeExperimentSeal {
  assertExactKeys(
    value,
    [
      "disposition",
      "evaluationStage",
      "diagnosticBrief",
      "authorityAttestationHash",
      "attestationContentHash",
      "sealChainEntryHash",
      "previousExperimentSealHash",
      "activeChampionAfter",
      "sealedAt",
    ],
    "Experiment seal",
  );
  if (
    !["promoted", "rejected", "inconclusive"].includes(String(value.disposition)) ||
    !["pre-validation", "validation"].includes(String(value.evaluationStage))
  ) {
    fail("Experiment seal disposition is malformed.");
  }
  if (value.diagnosticBrief !== null) {
    assertDiagnosticBriefReference(value.diagnosticBrief);
  }
  assertHash(value.authorityAttestationHash, "Seal authority attestation hash");
  assertHash(value.attestationContentHash, "Attestation content hash");
  assertHash(value.sealChainEntryHash, "Seal-chain entry hash");
  assertNullableHash(value.previousExperimentSealHash, "Previous experiment seal hash");
  assertChampionPointers(value.activeChampionAfter);
  assertTimestamp(value.sealedAt, "Seal timestamp");
}

function assertRecord(
  experimentName: string,
  value: unknown,
): asserts value is DurableExperimentJournalRecord {
  assertExactKeys(
    value,
    [
      "experimentName",
      "experiment",
      "status",
      "phase",
      "startedAt",
      "activeChampionBefore",
      "initialBudget",
      "proposal",
      "gates",
      "repair",
      "validation",
      "analysisHash",
      "gatesBudget",
      "repairBudget",
      "preValidationBudget",
      "validationBudget",
      "diagnosticBudget",
      "operationHashes",
      "interruption",
      "seal",
    ],
    "Experiment journal record",
  );
  if (
    value.experimentName !== experimentName ||
    !EXPERIMENT_NAME.test(experimentName) ||
    !["active", "interrupted", "sealed"].includes(String(value.status)) ||
    !JOURNAL_PHASES.includes(value.phase as ExperimentJournalPhase)
  ) {
    fail("Experiment journal record identity or status is malformed.");
  }
  assertExperimentIdentity(value.experiment);
  const expectedName =
    `${String(value.experiment.number).padStart(3, "0")}-` + value.experiment.slug;
  if (experimentName !== expectedName) {
    fail("Experiment directory name is detached from its identity.");
  }
  assertTimestamp(value.startedAt, "Experiment start timestamp");
  assertChampionPointers(value.activeChampionBefore);
  assertBudget(value.initialBudget);
  if (value.proposal !== null) assertProposal(value.proposal);
  if (value.gates !== null) assertGate(value.gates);
  if (value.repair !== null) assertRepair(value.repair);
  if (value.validation !== null) {
    assertExactKeys(
      value.validation,
      ["aggregate", "panelDispositionAttestationHash"],
      "Recorded validation",
    );
    assertValidation(value.validation.aggregate);
    assertHash(
      value.validation.panelDispositionAttestationHash,
      "Panel disposition attestation hash",
    );
  }
  assertNullableHash(value.analysisHash, "Optimizer analysis hash");
  for (const [label, budget] of [
    ["gates", value.gatesBudget],
    ["repair", value.repairBudget],
    ["pre-validation", value.preValidationBudget],
    ["validation", value.validationBudget],
    ["diagnostic", value.diagnosticBudget],
  ] as const) {
    if (budget !== null) {
      assertBudget(budget);
      assertSameBudgetLimits(value.initialBudget, budget);
    }
  }
  assertOperationHashes(value.operationHashes);
  if (value.interruption !== null) assertInterruption(value.interruption);
  if (value.seal !== null) assertSeal(value.seal);
  if (
    (value.interruption !== null &&
      Date.parse(value.interruption.interruptedAt) < Date.parse(value.startedAt)) ||
    (value.seal !== null && Date.parse(value.seal.sealedAt) < Date.parse(value.startedAt))
  ) {
    fail("Experiment terminal timestamp precedes its creation.");
  }
  if (
    (value.status === "active" && (value.interruption !== null || value.seal !== null)) ||
    (value.status === "interrupted" && (value.interruption === null || value.seal !== null)) ||
    (value.status === "sealed" &&
      (value.interruption !== null || value.seal === null || value.phase !== "sealed")) ||
    (value.operationHashes.interrupt === null) !== (value.interruption === null) ||
    (value.operationHashes.seal === null) !== (value.seal === null) ||
    (value.proposal === null) !== (value.operationHashes.proposal === null) ||
    (value.gates === null) !== (value.operationHashes.gates === null) ||
    (value.repair === null) !== (value.operationHashes.repair === null) ||
    (value.validation === null) !== (value.operationHashes.validation === null) ||
    (value.analysisHash === null) !== (value.operationHashes.analysis === null) ||
    (value.gatesBudget === null) !== (value.operationHashes.gatesBudget === null) ||
    (value.repairBudget === null) !== (value.operationHashes.repairBudget === null) ||
    (value.preValidationBudget === null) !== (value.operationHashes.preValidationBudget === null) ||
    (value.validationBudget === null) !== (value.operationHashes.validationBudget === null) ||
    (value.diagnosticBudget === null) !== (value.operationHashes.diagnosticBudget === null)
  ) {
    fail("Experiment journal record fields contradict their operation receipts.");
  }

  if (
    (value.gates !== null && value.gates.protocolHash !== value.experiment.protocolHash) ||
    (value.experiment.number === 1 && value.repair !== null) ||
    (value.repairBudget !== null && value.repair === null) ||
    (value.validationBudget !== null && value.preValidationBudget === null) ||
    (value.validation !== null && value.validationBudget === null) ||
    (value.diagnosticBudget !== null && value.analysisHash === null) ||
    (value.seal !== null &&
      (value.seal.evaluationStage === "validation") !== (value.validation !== null))
  ) {
    fail("Experiment journal stage bindings are inconsistent.");
  }
  const record = value as unknown as DurableExperimentJournalRecord;
  if (record.gatesBudget !== null && record.gates !== null) {
    assertAggregateBudgetDelta(
      record.initialBudget,
      record.gatesBudget,
      record.gates,
      "Persisted gates",
    );
  }
  if (record.repair !== null) {
    if (
      record.gates?.passed !== true ||
      record.gates.integrityPassed !== true ||
      record.gatesBudget === null
    ) {
      fail("Persisted repair was not authorized by passing gates.");
    }
    if (record.repairBudget !== null) {
      assertAggregateBudgetDelta(
        record.gatesBudget,
        record.repairBudget,
        record.repair,
        "Persisted repair",
      );
    }
  }
  if (record.preValidationBudget !== null) {
    const before = record.repairBudget ?? record.gatesBudget;
    if (
      before === null ||
      record.gates?.passed !== true ||
      record.gates.integrityPassed !== true ||
      (record.experiment.number > 1 &&
        (record.repair?.disposition !== "passed" || record.repairBudget === null))
    ) {
      fail("Persisted validation look was not authorized.");
    }
    const delta = usageDelta(before, record.preValidationBudget);
    if (
      delta.promotionLooks !== 1 ||
      delta.spentUsd !== 0 ||
      delta.tokens !== 0 ||
      delta.wallTimeMs !== 0 ||
      delta.attempts !== 0 ||
      delta.privacyReleases !== 0 ||
      delta.onlineErrorSpent !== 0
    ) {
      fail("Persisted pre-validation checkpoint is malformed.");
    }
  }
  if (record.validationBudget !== null && record.preValidationBudget !== null) {
    const delta = usageDelta(record.preValidationBudget, record.validationBudget);
    if (
      delta.promotionLooks !== 0 ||
      delta.privacyReleases !== 0 ||
      delta.onlineErrorSpent <= 0 ||
      delta.attempts < 24 ||
      delta.attempts > 28
    ) {
      fail("Persisted validation budget violates bounded accounting.");
    }
  }
  if (
    record.validation !== null &&
    record.preValidationBudget !== null &&
    record.validationBudget !== null
  ) {
    const onlineError = record.validation.aggregate.onlineErrorBudget;
    if (
      record.preValidationBudget.limits.maximumOnlineError !== onlineError.maximumOnlineError ||
      record.validationBudget.limits.maximumOnlineError !== onlineError.maximumOnlineError ||
      record.preValidationBudget.usage.onlineErrorSpent !== onlineError.cumulativeSpentBefore ||
      record.validationBudget.usage.onlineErrorSpent !== onlineError.cumulativeSpentAfter ||
      record.preValidationBudget.usage.promotionLooks !== onlineError.gateOrdinal
    ) {
      fail("Persisted validation is detached from online-error accounting.");
    }
    assertAggregateBudgetDelta(
      record.preValidationBudget,
      record.validationBudget,
      {
        ...record.validation.aggregate,
        attempts:
          record.validation.aggregate.validArms + record.validation.aggregate.replacementAttempts,
        onlineErrorSpent: record.validation.aggregate.onlineErrorBudget.alphaSpent,
      },
      "Persisted validation",
    );
  }
  if (record.diagnosticBudget !== null) {
    const before =
      record.validationBudget ??
      record.preValidationBudget ??
      record.repairBudget ??
      record.gatesBudget;
    if (
      before === null ||
      record.validation?.aggregate.releasedEvidenceHash === null ||
      record.validation?.aggregate.releasedEvidenceHash === undefined
    ) {
      fail("Persisted diagnostic spend has no released evidence.");
    }
    const delta = usageDelta(before, record.diagnosticBudget);
    if (
      delta.privacyReleases !== 1 ||
      delta.spentUsd !== 0 ||
      delta.tokens !== 0 ||
      delta.wallTimeMs !== 0 ||
      delta.attempts !== 0 ||
      delta.promotionLooks !== 0 ||
      delta.onlineErrorSpent !== 0
    ) {
      fail("Persisted diagnostic checkpoint is malformed.");
    }
  }
  if (record.seal !== null) {
    if (record.seal.disposition !== expectedDisposition(record)) {
      fail("Persisted seal contradicts the recorded terminal result.");
    }
    const releasedHash = record.validation?.aggregate.releasedEvidenceHash ?? null;
    if (
      (record.validation !== null &&
        (releasedHash !== (record.seal.diagnosticBrief?.hash ?? null) ||
          (releasedHash !== null) !== (record.diagnosticBudget !== null))) ||
      (record.validation === null &&
        (record.diagnosticBudget !== null ||
          (record.seal.diagnosticBrief !== null &&
            record.seal.diagnosticBrief.hash !== record.proposal?.hypothesis.sourceBriefHash)))
    ) {
      fail("Persisted seal has a detached diagnostic release.");
    }
    if (record.seal.disposition === "promoted") {
      if (
        record.proposal === null ||
        record.seal.activeChampionAfter.activeExperiment !== record.experiment.number ||
        record.seal.activeChampionAfter.activeCommit !== record.proposal.candidate.commit ||
        record.seal.activeChampionAfter.baselineCommit !==
          record.activeChampionBefore.baselineCommit ||
        record.seal.activeChampionAfter.certifiedExperiment !==
          record.activeChampionBefore.certifiedExperiment ||
        record.seal.activeChampionAfter.certifiedCommit !==
          record.activeChampionBefore.certifiedCommit ||
        record.seal.activeChampionAfter.sourceSealHash !== record.seal.sealChainEntryHash ||
        Date.parse(record.seal.activeChampionAfter.updatedAt) < Date.parse(record.startedAt) ||
        Date.parse(record.seal.activeChampionAfter.updatedAt) > Date.parse(record.seal.sealedAt)
      ) {
        fail("Promoted seal is detached from its champion transition.");
      }
    } else if (!sameCanonical(record.seal.activeChampionAfter, record.activeChampionBefore)) {
      fail("Non-promoted seal moved an active champion pointer.");
    }
  }

  const phaseRequirements: Readonly<
    Record<ExperimentJournalPhase, readonly (keyof DurableExperimentJournalRecord)[]>
  > = {
    created: [],
    "proposal-frozen": ["proposal"],
    "gates-recorded": ["proposal", "gates"],
    "gates-budgeted": ["proposal", "gates", "gatesBudget"],
    "repair-recorded": ["proposal", "gates", "gatesBudget", "repair"],
    "repair-budgeted": ["proposal", "gates", "gatesBudget", "repair", "repairBudget"],
    "pre-validation-budgeted": ["proposal", "gates", "gatesBudget", "preValidationBudget"],
    "validation-budgeted": [
      "proposal",
      "gates",
      "gatesBudget",
      "preValidationBudget",
      "validationBudget",
    ],
    "validation-recorded": [
      "proposal",
      "gates",
      "gatesBudget",
      "preValidationBudget",
      "validationBudget",
      "validation",
    ],
    "analysis-recorded": ["proposal", "gates", "gatesBudget", "analysisHash"],
    "diagnostic-budgeted": ["proposal", "gates", "gatesBudget", "analysisHash", "diagnosticBudget"],
    sealed: ["proposal", "gates", "gatesBudget", "analysisHash", "seal"],
  };
  const phase = value.phase as ExperimentJournalPhase;
  if (phaseRequirements[phase].some((key) => value[key] === null)) {
    fail("Experiment journal phase is missing a required checkpoint.");
  }
  const forbiddenByPhase: Readonly<
    Record<ExperimentJournalPhase, readonly (keyof DurableExperimentJournalRecord)[]>
  > = {
    created: [
      "proposal",
      "gates",
      "repair",
      "validation",
      "analysisHash",
      "gatesBudget",
      "repairBudget",
      "preValidationBudget",
      "validationBudget",
      "diagnosticBudget",
      "seal",
    ],
    "proposal-frozen": [
      "gates",
      "repair",
      "validation",
      "analysisHash",
      "gatesBudget",
      "repairBudget",
      "preValidationBudget",
      "validationBudget",
      "diagnosticBudget",
      "seal",
    ],
    "gates-recorded": [
      "repair",
      "validation",
      "analysisHash",
      "gatesBudget",
      "repairBudget",
      "preValidationBudget",
      "validationBudget",
      "diagnosticBudget",
      "seal",
    ],
    "gates-budgeted": [
      "repair",
      "validation",
      "analysisHash",
      "repairBudget",
      "preValidationBudget",
      "validationBudget",
      "diagnosticBudget",
      "seal",
    ],
    "repair-recorded": [
      "validation",
      "analysisHash",
      "repairBudget",
      "preValidationBudget",
      "validationBudget",
      "diagnosticBudget",
      "seal",
    ],
    "repair-budgeted": [
      "validation",
      "analysisHash",
      "preValidationBudget",
      "validationBudget",
      "diagnosticBudget",
      "seal",
    ],
    "pre-validation-budgeted": [
      "validation",
      "analysisHash",
      "validationBudget",
      "diagnosticBudget",
      "seal",
    ],
    "validation-budgeted": ["validation", "analysisHash", "diagnosticBudget", "seal"],
    "validation-recorded": ["analysisHash", "diagnosticBudget", "seal"],
    "analysis-recorded": ["diagnosticBudget", "seal"],
    "diagnostic-budgeted": ["seal"],
    sealed: [],
  };
  if (forbiddenByPhase[phase].some((key) => value[key] !== null)) {
    fail("Experiment journal phase contains a future checkpoint.");
  }
  assertReleaseSafe(value);
}

export function emptyExperimentJournalState(): DurableExperimentJournalState {
  return {
    schemaVersion: EXPERIMENT_JOURNAL_STATE_VERSION,
    sensitivity: EXPERIMENT_JOURNAL_STATE_SENSITIVITY,
    revision: 0,
    lastSealedExperimentNumber: null,
    sealChainHead: null,
    pendingOperation: null,
    records: {},
  };
}

export function assertDurableExperimentJournalState(
  value: unknown,
): asserts value is DurableExperimentJournalState {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "sensitivity",
      "revision",
      "lastSealedExperimentNumber",
      "sealChainHead",
      "pendingOperation",
      "records",
    ],
    "Durable experiment journal state",
  );
  if (
    value.schemaVersion !== EXPERIMENT_JOURNAL_STATE_VERSION ||
    value.sensitivity !== EXPERIMENT_JOURNAL_STATE_SENSITIVITY ||
    !Number.isSafeInteger(value.revision as number) ||
    (value.revision as number) < 0 ||
    (value.lastSealedExperimentNumber !== null &&
      (!Number.isSafeInteger(value.lastSealedExperimentNumber as number) ||
        (value.lastSealedExperimentNumber as number) < 1)) ||
    !isPlainRecord(value.records)
  ) {
    fail("Durable experiment journal state metadata is malformed.");
  }
  assertNullableHash(value.sealChainHead, "Experiment seal-chain head");
  if ((value.lastSealedExperimentNumber === null) !== (value.sealChainHead === null)) {
    fail("Experiment seal-chain number and head must be present together.");
  }
  if (value.pendingOperation !== null) {
    assertExactKeys(
      value.pendingOperation,
      ["experimentName", "operation", "inputHash", "startedAt"],
      "Pending journal operation",
    );
    if (
      typeof value.pendingOperation.experimentName !== "string" ||
      !EXPERIMENT_NAME.test(value.pendingOperation.experimentName) ||
      !JOURNAL_OPERATIONS.includes(value.pendingOperation.operation as ExperimentJournalOperation)
    ) {
      fail("Pending journal operation is malformed.");
    }
    assertHash(value.pendingOperation.inputHash, "Pending operation hash");
    assertTimestamp(value.pendingOperation.startedAt, "Pending operation timestamp");
  }

  const state = value as unknown as DurableExperimentJournalState;
  const numbers = new Set<number>();
  const allocatedRecords: DurableExperimentJournalRecord[] = [];
  const sealedRecords: DurableExperimentJournalRecord[] = [];
  let highestSealed: number | null = null;
  let highestSealedRecord: DurableExperimentJournalRecord | null = null;
  let activeCount = 0;
  for (const [name, record] of Object.entries(state.records)) {
    assertRecord(name, record);
    allocatedRecords.push(record);
    if (numbers.has(record.experiment.number)) {
      fail("Durable journal allocates an experiment number more than once.");
    }
    numbers.add(record.experiment.number);
    if (record.status === "active") activeCount += 1;
    if (record.status === "sealed") {
      sealedRecords.push(record);
      if (highestSealed === null || record.experiment.number > highestSealed) {
        highestSealed = record.experiment.number;
        highestSealedRecord = record;
      }
    }
  }
  const maximumAllocatedNumber = Math.max(0, ...numbers);
  for (let number = 1; number <= maximumAllocatedNumber; number += 1) {
    if (!numbers.has(number)) {
      fail("Durable journal experiment allocation is not contiguous.");
    }
  }
  allocatedRecords.sort((left, right) => left.experiment.number - right.experiment.number);
  let priorAllocatedRecord: DurableExperimentJournalRecord | null = null;
  for (const record of allocatedRecords) {
    if (
      record.experiment.kind !== "optimization" ||
      record.experiment.parentExperiment !== record.activeChampionBefore.activeExperiment ||
      (priorAllocatedRecord !== null &&
        (record.experiment.lineageId !== priorAllocatedRecord.experiment.lineageId ||
          record.experiment.protocolHash !== priorAllocatedRecord.experiment.protocolHash ||
          !sameCanonical(
            record.activeChampionBefore,
            priorAllocatedRecord.seal?.activeChampionAfter ??
              priorAllocatedRecord.activeChampionBefore,
          )))
    ) {
      fail("Durable journal campaign lineage is inconsistent.");
    }
    priorAllocatedRecord = record;
  }
  if (
    activeCount > 1 ||
    highestSealed !== state.lastSealedExperimentNumber ||
    (state.pendingOperation !== null &&
      state.pendingOperation.operation !== "create" &&
      state.records[state.pendingOperation.experimentName] === undefined)
  ) {
    fail("Durable experiment journal allocation state is inconsistent.");
  }
  if (state.pendingOperation?.operation === "create") {
    const pendingNumber = Number.parseInt(state.pendingOperation.experimentName, 10);
    if (
      state.records[state.pendingOperation.experimentName] !== undefined ||
      pendingNumber !== maximumAllocatedNumber + 1
    ) {
      fail("Pending experiment creation is not the next allocation.");
    }
  }
  const pendingRecord =
    state.pendingOperation === null
      ? undefined
      : state.records[state.pendingOperation.experimentName];
  if (
    state.pendingOperation !== null &&
    pendingRecord !== undefined &&
    Date.parse(state.pendingOperation.startedAt) < Date.parse(pendingRecord.startedAt)
  ) {
    fail("Pending journal operation predates its experiment.");
  }
  if (state.lastSealedExperimentNumber !== null) {
    if (highestSealedRecord?.seal?.sealChainEntryHash !== state.sealChainHead) {
      fail("Durable experiment journal seal head is detached.");
    }
  }
  sealedRecords.sort((left, right) => left.experiment.number - right.experiment.number);
  for (const [index, record] of sealedRecords.entries()) {
    const prior = index === 0 ? null : sealedRecords[index - 1];
    if (record.seal?.previousExperimentSealHash !== (prior?.seal?.sealChainEntryHash ?? null)) {
      fail("Durable experiment journal seal lineage is discontinuous.");
    }
  }
  assertReleaseSafe(state);
}

/**
 * Returns the last durably committed cumulative campaign budget for one
 * experiment. This is intended for trusted interruption reconciliation; it
 * never exposes evaluator handles or task-level material.
 */
export function latestJournalBudgetForExperiment(
  state: unknown,
  experiment: ExperimentIdentity,
): BudgetSnapshot {
  assertDurableExperimentJournalState(state);
  assertExperimentIdentity(experiment);
  const record = state.records[experimentName(experiment)];
  if (record === undefined || !sameCanonical(record.experiment, experiment)) {
    fail("Budget reconciliation experiment is absent or detached.");
  }
  return canonicalClone(finalBudget(record), "Latest journal budget checkpoint");
}

function nextState(
  state: DurableExperimentJournalState,
  changes: Omit<DurableExperimentJournalState, "schemaVersion" | "sensitivity" | "revision">,
): DurableExperimentJournalState {
  const next: DurableExperimentJournalState = {
    schemaVersion: EXPERIMENT_JOURNAL_STATE_VERSION,
    sensitivity: EXPERIMENT_JOURNAL_STATE_SENSITIVITY,
    revision: state.revision + 1,
    ...changes,
  };
  assertDurableExperimentJournalState(next);
  return next;
}

function operationHash(operation: ExperimentJournalOperation, input: unknown): string {
  return canonicalHash({
    domain: "dark-factory.experiment-journal-operation.v1",
    operation,
    input,
  });
}

function experimentName(identity: ExperimentIdentity): string {
  return `${identity.number.toString().padStart(3, "0")}-${identity.slug}`;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    String((error as NodeJS.ErrnoException).code) === "ENOENT"
  );
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function previousBudget(record: DurableExperimentJournalRecord): BudgetSnapshot {
  return (
    record.diagnosticBudget ??
    record.validationBudget ??
    record.preValidationBudget ??
    record.repairBudget ??
    record.gatesBudget ??
    record.initialBudget
  );
}

function finalBudget(record: DurableExperimentJournalRecord): BudgetSnapshot {
  return previousBudget(record);
}

function expectedDisposition(
  record: DurableExperimentJournalRecord,
): "promoted" | "rejected" | "inconclusive" {
  if (record.validation !== null) return record.validation.aggregate.disposition;
  if (record.repair !== null && record.repair.disposition !== "passed") {
    return record.repair.disposition === "rejected" ? "rejected" : "inconclusive";
  }
  if (record.gates !== null && (!record.gates.passed || !record.gates.integrityPassed)) {
    return "rejected";
  }
  return fail("A pre-validation experiment has no terminal disposition.");
}

function operationReceipt(
  record: DurableExperimentJournalRecord,
  operation: ExperimentJournalOperation,
): string | null {
  switch (operation) {
    case "create":
      return record.operationHashes.create;
    case "proposal":
      return record.operationHashes.proposal;
    case "gates":
      return record.operationHashes.gates;
    case "gates-budget":
      return record.operationHashes.gatesBudget;
    case "repair":
      return record.operationHashes.repair;
    case "repair-budget":
      return record.operationHashes.repairBudget;
    case "pre-validation-budget":
      return record.operationHashes.preValidationBudget;
    case "validation-budget":
      return record.operationHashes.validationBudget;
    case "validation":
      return record.operationHashes.validation;
    case "analysis":
      return record.operationHashes.analysis;
    case "diagnostic-budget":
      return record.operationHashes.diagnosticBudget;
    case "seal":
      return record.operationHashes.seal;
    case "interrupt":
      return record.operationHashes.interrupt;
  }
}

function replaceRecord(
  state: DurableExperimentJournalState,
  name: string,
  record: DurableExperimentJournalRecord,
  overrides: Partial<
    Pick<DurableExperimentJournalState, "lastSealedExperimentNumber" | "sealChainHead">
  > = {},
): DurableExperimentJournalState {
  return nextState(state, {
    lastSealedExperimentNumber:
      overrides.lastSealedExperimentNumber ?? state.lastSealedExperimentNumber,
    sealChainHead: overrides.sealChainHead ?? state.sealChainHead,
    pendingOperation: null,
    records: {
      ...state.records,
      [name]: record,
    },
  });
}

function provenanceContains(
  document: Readonly<{ provenanceRefs: readonly { artifactName: string; contentHash: string }[] }>,
  artifactName: string,
  hash: string,
): boolean {
  return document.provenanceRefs.some(
    (reference) => reference.artifactName === artifactName && reference.contentHash === hash,
  );
}

function assertAggregateCost(
  value: Readonly<{
    inputTokens: number;
    outputTokens: number;
    modelUsd: number;
    sandboxUsd: number;
    totalUsd: number;
    wallTimeMs: number;
  }>,
  expected: {
    readonly aggregateCostUsd: number;
    readonly tokens: number;
    readonly wallTimeMs: number;
  },
  label: string,
): void {
  if (
    value.inputTokens + value.outputTokens !== expected.tokens ||
    !approximatelyEqual(value.modelUsd + value.sandboxUsd, value.totalUsd) ||
    !approximatelyEqual(value.totalUsd, expected.aggregateCostUsd) ||
    value.wallTimeMs !== expected.wallTimeMs
  ) {
    fail(`${label} cost does not bind the recorded aggregate.`);
  }
}

function assertFinalArtifactBindings(
  snapshot: ReleaseSafeFinalExperimentSnapshot,
  artifacts: ReleaseSafeExperimentArtifactSet,
): void {
  assertExactKeys(artifacts, REQUIRED_PRESEAL_ARTIFACT_FILES, "Release-safe artifact set");
  for (const fileName of REQUIRED_PRESEAL_ARTIFACT_FILES) {
    const document = artifacts[fileName];
    const schemaName = {
      "analysis.json": "analysis",
      "behavioral-evidence.json": "behavioralEvidence",
      "cache-attestation.json": "cacheAttestation",
      "candidate.json": "candidate",
      "decision.json": "decision",
      "diagnostic-brief.json": "diagnosticBrief",
      "evaluation-plan.json": "evaluationPlan",
      "experiment.json": "experiment",
      "failure-cards.json": "failureCards",
      "feedback-entry.json": "feedbackEntry",
      "hypothesis.json": "hypothesis",
      "results.json": "results",
    } as const;
    assertValidDocument(schemaName[fileName], document);
    if (!hasValidContentHash(document)) {
      fail(`${fileName} has an invalid content commitment.`);
    }
    assertReleaseSafe(document);
    if (document.experimentNumber !== snapshot.experiment.number) {
      fail(`${fileName} is bound to a different experiment.`);
    }
  }

  const experiment = artifacts["experiment.json"];
  const hypothesis = artifacts["hypothesis.json"];
  const candidate = artifacts["candidate.json"];
  const results = artifacts["results.json"];
  const analysis = artifacts["analysis.json"];
  const behavioralEvidence = artifacts["behavioral-evidence.json"];
  const cacheAttestation = artifacts["cache-attestation.json"];
  const decision = artifacts["decision.json"];
  const feedback = artifacts["feedback-entry.json"];
  const diagnostic = artifacts["diagnostic-brief.json"];
  const evaluationPlan = artifacts["evaluation-plan.json"];
  const failureCards = artifacts["failure-cards.json"];

  if (
    experiment.slug !== snapshot.experiment.slug ||
    experiment.parentExperimentNumber !== snapshot.experiment.parentExperiment ||
    experiment.baselineLineageId !== snapshot.experiment.lineageId ||
    experiment.protocolHash !== snapshot.experiment.protocolHash ||
    experiment.championBefore !== snapshot.activeChampionBefore.activeCommit ||
    experiment.championAfter !==
      (snapshot.promotedCandidate?.commit ?? snapshot.activeChampionBefore.activeCommit) ||
    experiment.lifecycleState !== snapshot.disposition ||
    experiment.finalDisposition !== snapshot.disposition ||
    experiment.startedAt !== snapshot.startedAt ||
    experiment.finishedAt !== snapshot.finishedAt
  ) {
    fail("experiment.json is detached from the terminal journal snapshot.");
  }
  if (
    !provenanceContains(hypothesis, "optimizer-hypothesis", snapshot.proposal.hypothesis.hash) ||
    hypothesis.sourceDiagnosticBriefHash !== snapshot.proposal.hypothesis.sourceBriefHash ||
    hypothesis.causalClaim !== snapshot.proposal.hypothesis.causalClaim ||
    hypothesis.proposedIntervention !== snapshot.proposal.hypothesis.intervention ||
    hypothesis.predictions.discoveryRepair !==
      snapshot.proposal.hypothesis.predictedRepairBehavior ||
    hypothesis.predictions.freshAccuracy !== snapshot.proposal.hypothesis.predictedFreshEffect ||
    !sameCanonical(
      hypothesis.falsificationCriteria,
      snapshot.proposal.hypothesis.falsificationCriteria,
    ) ||
    hypothesis.rollbackCondition !== snapshot.proposal.hypothesis.rollbackCondition
  ) {
    fail("hypothesis.json is detached from the frozen optimizer proposal.");
  }
  if (
    candidate.candidateCommit !== snapshot.proposal.candidate.commit ||
    candidate.patchHash !== snapshot.proposal.candidate.patchHash ||
    !sameCanonical(candidate.changedFiles, snapshot.proposal.candidate.changedFiles) ||
    candidate.mutation.category !== snapshot.proposal.candidate.mutationCategory ||
    candidate.allGatesPassed !== (snapshot.gates.passed && snapshot.gates.integrityPassed) ||
    !provenanceContains(candidate, "gate-checks", snapshot.gates.checksHash)
  ) {
    fail("candidate.json is detached from the frozen candidate or gate result.");
  }
  if (
    evaluationPlan.protocolHash !== snapshot.experiment.protocolHash ||
    behavioralEvidence.protocolHash !== snapshot.experiment.protocolHash ||
    cacheAttestation.protocolHash !== snapshot.experiment.protocolHash ||
    failureCards.behavioralEvidenceHash !== behavioralEvidence.contentHash ||
    diagnostic.aggregateEvidenceHash !== behavioralEvidence.contentHash ||
    diagnostic.failureCardsHash !== failureCards.contentHash ||
    evaluationPlan.stoppingRules.onlineErrorBudgetRemaining !==
      Math.max(
        0,
        snapshot.initialBudget.limits.maximumOnlineError -
          snapshot.initialBudget.usage.onlineErrorSpent,
      )
  ) {
    fail("evaluation-plan.json is detached from the sealed protocol budget.");
  }
  const expectedBehavioralSource =
    snapshot.validation?.aggregate.behavioralSourceCommitmentHash ??
    snapshot.repair?.attestationHash ??
    null;
  if (
    expectedBehavioralSource !== null &&
    behavioralEvidence.sourceEnvelopeHash !== expectedBehavioralSource
  ) {
    fail("behavioral-evidence.json is detached from its signed result.");
  }

  const expectedRepairDisposition =
    snapshot.repair === null
      ? "not-run"
      : snapshot.repair.disposition === "rejected"
        ? "failed"
        : snapshot.repair.disposition;
  if (
    results.protocolHash !== snapshot.experiment.protocolHash ||
    results.repair.disposition !== expectedRepairDisposition ||
    results.repair.attemptOrdinal !== (snapshot.repair?.attemptOrdinal ?? 0) ||
    results.repair.integrityStatus !==
      (snapshot.repair === null
        ? "not-run"
        : snapshot.repair.integrityPassed
          ? "passed"
          : "failed") ||
    (snapshot.repair !== null &&
      results.repair.signedPolicyAttestationHash !== snapshot.repair.attestationHash)
  ) {
    fail("results.json repair result is detached from the journal.");
  }
  if (snapshot.repair !== null) {
    assertAggregateCost(results.repair.aggregateCost, snapshot.repair, "Repair result");
  } else {
    assertAggregateCost(
      results.repair.aggregateCost,
      {
        aggregateCostUsd: 0,
        tokens: 0,
        wallTimeMs: 0,
      },
      "Not-run repair result",
    );
  }
  if (cacheAttestation.repairBudgetCompliant !== true) {
    fail("cache-attestation.json reports non-compliant repair spend.");
  }
  const cacheStatusMatches =
    snapshot.repair === null
      ? cacheAttestation.aggregateUseStatus === "not-used"
      : snapshot.repair.cacheStatus === "not-used"
        ? cacheAttestation.aggregateUseStatus === "not-used"
        : snapshot.repair.cacheStatus === "miss"
          ? cacheAttestation.aggregateUseStatus === "ineligible"
          : snapshot.repair.cacheStatus === "drift-failed"
            ? cacheAttestation.driftStatus === "failed"
            : (cacheAttestation.aggregateUseStatus === "used" ||
                cacheAttestation.aggregateUseStatus === "partially-used") &&
              cacheAttestation.driftStatus === "passed";
  if (!cacheStatusMatches) {
    fail("cache-attestation.json contradicts the repair cache result.");
  }

  if ((results.validation === null) !== (snapshot.validation === null)) {
    fail("results.json validation presence contradicts the journal.");
  }
  if (snapshot.validation !== null && results.validation !== null) {
    const validation = snapshot.validation.aggregate;
    const expectedValidationDisposition =
      validation.disposition === "promoted"
        ? "promote"
        : validation.disposition === "rejected"
          ? "reject"
          : "inconclusive";
    if (
      results.validation.disposition !== expectedValidationDisposition ||
      results.validation.matchedTaskCount !== validation.validPairs ||
      results.validation.validFreshArmCount !== validation.validArms ||
      results.validation.invalidArmTotal !== validation.replacementAttempts ||
      results.validation.weightedAccuracy.medianDelta !== validation.medianAccuracyDelta ||
      results.validation.weightedAccuracy.probabilityPositive !== validation.probabilityPositive ||
      results.validation.stratumRegressionVeto !== validation.stratumRegressionVeto ||
      results.validation.integrityVeto !== validation.integrityVeto ||
      results.validation.capabilityVeto !== validation.capabilityVeto ||
      results.validation.costVeto !== !validation.costWithinGuardrail ||
      results.validation.latencyVeto !== !validation.latencyWithinGuardrail ||
      results.validation.signedResultEnvelopeHash !== validation.attestationHash
    ) {
      fail("results.json validation result is detached from the journal.");
    }
    assertAggregateCost(results.validation.aggregateCost, validation, "Validation result");
  }

  const totalDelta = usageDelta(snapshot.initialBudget, snapshot.finalBudget);
  assertAggregateCost(
    results.totalCost,
    {
      aggregateCostUsd: totalDelta.spentUsd,
      tokens: totalDelta.tokens,
      wallTimeMs: totalDelta.wallTimeMs,
    },
    "Experiment total",
  );
  assertAggregateCost(
    feedback.aggregateCost,
    {
      aggregateCostUsd: totalDelta.spentUsd,
      tokens: totalDelta.tokens,
      wallTimeMs: totalDelta.wallTimeMs,
    },
    "Feedback total",
  );
  const finalBudgetHash = canonicalHash(snapshot.finalBudget);
  if (!provenanceContains(feedback, "budget-final", finalBudgetHash)) {
    fail("feedback-entry.json does not bind the final campaign budget.");
  }
  if (
    feedback.lifecycleDisposition !== snapshot.disposition ||
    !provenanceContains(analysis, "optimizer-analysis", snapshot.analysisHash) ||
    analysis.hypothesisHash !== snapshot.proposal.hypothesis.hash ||
    analysis.resultsHash !== results.contentHash
  ) {
    fail("Feedback or analysis artifacts are detached from terminal state.");
  }

  const expectedValidationDecision =
    snapshot.validation === null
      ? "not-run"
      : snapshot.disposition === "promoted"
        ? "promote"
        : snapshot.disposition === "rejected"
          ? "reject"
          : "inconclusive";
  if (
    decision.repairDisposition !== expectedRepairDisposition ||
    decision.challenger !==
      (snapshot.validation !== null || snapshot.repair?.disposition === "passed") ||
    decision.validationDisposition !== expectedValidationDecision ||
    decision.activeChampionTransition.beforeCommit !== snapshot.activeChampionBefore.activeCommit ||
    decision.activeChampionTransition.afterCommit !==
      (snapshot.promotedCandidate?.commit ?? snapshot.activeChampionBefore.activeCommit) ||
    decision.activeChampionTransition.changed !== (snapshot.disposition === "promoted") ||
    (snapshot.validation !== null &&
      decision.onlineErrorBudgetPassed !== snapshot.validation.aggregate.onlineGateAuthorized) ||
    (snapshot.validation !== null &&
      decision.oneUseConsumptionAttestationHash !==
        snapshot.validation.panelDispositionAttestationHash)
  ) {
    fail("decision.json is detached from the recorded terminal decision.");
  }

  const newlyReleasedHash = snapshot.validation?.aggregate.releasedEvidenceHash ?? null;
  if (newlyReleasedHash !== null) {
    if (
      snapshot.diagnosticBrief === null ||
      snapshot.diagnosticBrief.hash !== newlyReleasedHash ||
      diagnostic.contentHash !== snapshot.diagnosticBrief.hash ||
      diagnostic.releaseId !== snapshot.diagnosticBrief.releaseId ||
      (diagnostic.status === "actionable-evidence") !== snapshot.diagnosticBrief.actionable
    ) {
      fail("diagnostic-brief.json is detached from the signed release.");
    }
  } else if (snapshot.validation !== null && snapshot.diagnosticBrief !== null) {
    fail("A validation without released evidence cannot publish a brief.");
  }
}

function finalSnapshot(
  record: DurableExperimentJournalRecord,
  input: {
    readonly disposition: "promoted" | "rejected" | "inconclusive";
    readonly promotedCandidate: {
      readonly experimentNumber: number;
      readonly commit: string;
      readonly decidedAt: string;
    } | null;
    readonly diagnosticBrief: DiagnosticBriefReference | null;
    readonly finishedAt: string;
  },
): ReleaseSafeFinalExperimentSnapshot {
  if (
    record.proposal === null ||
    record.gates === null ||
    record.gatesBudget === null ||
    record.analysisHash === null
  ) {
    return fail("Cannot assemble an incomplete experiment.");
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    experimentName: record.experimentName,
    experiment: record.experiment,
    startedAt: record.startedAt,
    finishedAt: input.finishedAt,
    activeChampionBefore: record.activeChampionBefore,
    initialBudget: record.initialBudget,
    finalBudget: finalBudget(record),
    proposal: record.proposal,
    gates: record.gates,
    repair: record.repair,
    validation: record.validation,
    analysisHash: record.analysisHash,
    disposition: input.disposition,
    evaluationStage:
      record.validation === null ? ("pre-validation" as const) : ("validation" as const),
    promotedCandidate: input.promotedCandidate,
    diagnosticBrief: input.diagnosticBrief,
  };
  return {
    ...withoutHash,
    assemblyRequestHash: canonicalHash({
      domain: "dark-factory.release-safe-experiment-assembly.v1",
      ...withoutHash,
    }),
  };
}

function eventFor(
  operation: ExperimentJournalOperation,
  inputHash: string,
  createdAt: string,
  details: {
    readonly stateTo?: EventRecord["payload"]["stateTo"];
    readonly validArmCount?: number | null;
    readonly invalidArmCount?: number | null;
  } = {},
): AppendEventInput {
  const eventType: EventRecord["eventType"] =
    operation === "create"
      ? "experiment-created"
      : operation === "proposal"
        ? "artifact-written"
        : operation === "interrupt"
          ? "interrupted"
          : operation === "seal"
            ? "lifecycle-transition"
            : "evaluator-milestone";
  const actor: EventRecord["actor"] =
    operation === "proposal" || operation === "analysis"
      ? "optimizer"
      : operation === "repair" || operation === "validation"
        ? "trusted-broker"
        : "controller";
  return {
    eventType,
    actor,
    createdAt,
    payload: {
      messageCode: `journal-${operation}`,
      artifactName: operation === "proposal" ? "hypothesis.json" : null,
      stateFrom: operation === "seal" ? "analyzed" : null,
      stateTo: details.stateTo ?? (operation === "create" ? "planned" : null),
      aggregateCountBand: null,
      validArmCount: details.validArmCount ?? null,
      invalidArmCount: details.invalidArmCount ?? null,
      attestationHash: inputHash,
    },
  };
}

/**
 * Durable production implementation of ExperimentJournal.
 *
 * The mutable state is release-safe and contains no panel handles, task
 * identities, grader prose, raw outputs, or interruption text. Full artifacts
 * are schema checked, leak scanned, signed by injected trusted authorities,
 * and sealed through ExperimentStore's immutable hash chain.
 */
export class ProductionExperimentJournal implements ExperimentJournal {
  readonly #evidenceStore: ExperimentStore;
  readonly #stateStore: AtomicExperimentJournalStateStore;
  readonly #artifactAssembler: TrustedReleaseSafeExperimentArtifactAssembler;
  readonly #sealAuthority: TrustedExperimentSealAuthority;
  readonly #interruptionAttestor: TrustedJournalInterruptionAttestor;
  readonly #now: () => Date;

  public constructor(options: ProductionExperimentJournalOptions) {
    this.#evidenceStore = options.evidenceStore;
    this.#stateStore = options.stateStore;
    this.#artifactAssembler = options.artifactAssembler;
    this.#sealAuthority = options.sealAuthority;
    this.#interruptionAttestor = options.interruptionAttestor;
    this.#now = options.now ?? (() => new Date());
  }

  async #transact<Result>(
    operation: (state: DurableExperimentJournalState) => {
      readonly next: DurableExperimentJournalState;
      readonly result: Result;
    },
  ): Promise<Result> {
    return this.#stateStore.transact((stored) => {
      assertDurableExperimentJournalState(stored);
      const detached = canonicalClone(stored, "Stored experiment journal state");
      const transition = operation(detached);
      assertDurableExperimentJournalState(transition.next);
      if (
        sameCanonical(transition.next, detached) &&
        transition.next.revision !== detached.revision
      ) {
        fail("A no-op journal transaction changed its revision.");
      }
      if (
        !sameCanonical(transition.next, detached) &&
        transition.next.revision !== detached.revision + 1
      ) {
        fail("A journal transaction did not advance exactly one revision.");
      }
      return {
        next: canonicalClone(transition.next, "Next experiment journal state"),
        result: transition.result,
      };
    });
  }

  async #begin(
    name: string,
    operation: ExperimentJournalOperation,
    inputHash: string,
    validate: (
      state: DurableExperimentJournalState,
      record: DurableExperimentJournalRecord | undefined,
    ) => void,
  ): Promise<BegunJournalOperation> {
    return this.#transact<BegunJournalOperation>((state) => {
      const record = state.records[name];
      if (record !== undefined && operationReceipt(record, operation) === inputHash) {
        return {
          next: state,
          result: {
            replay: true,
            state,
            record,
            startedAt: record.startedAt,
          },
        };
      }
      if (state.pendingOperation !== null) {
        if (
          state.pendingOperation.experimentName !== name ||
          state.pendingOperation.operation !== operation ||
          state.pendingOperation.inputHash !== inputHash
        ) {
          fail("A different experiment journal operation is already pending.");
        }
        validate(state, record);
        return {
          next: state,
          result: {
            replay: false,
            state,
            record,
            startedAt: state.pendingOperation.startedAt,
          },
        };
      }
      validate(state, record);
      const startedAt = nowTimestamp(this.#now);
      if (record !== undefined && Date.parse(startedAt) < Date.parse(record.startedAt)) {
        fail("Experiment journal clock moved before experiment creation.");
      }
      const next = nextState(state, {
        lastSealedExperimentNumber: state.lastSealedExperimentNumber,
        sealChainHead: state.sealChainHead,
        pendingOperation: {
          experimentName: name,
          operation,
          inputHash,
          startedAt,
        },
        records: state.records,
      });
      return {
        next,
        result: {
          replay: false,
          state: next,
          record,
          startedAt,
        },
      };
    });
  }

  async #complete<Result>(
    name: string,
    operation: ExperimentJournalOperation,
    inputHash: string,
    complete: (
      state: DurableExperimentJournalState,
      record: DurableExperimentJournalRecord | undefined,
    ) => {
      readonly next: DurableExperimentJournalState;
      readonly result: Result;
    },
  ): Promise<Result> {
    return this.#transact((state) => {
      const record = state.records[name];
      if (record !== undefined && operationReceipt(record, operation) === inputHash) {
        return complete(state, record);
      }
      if (
        state.pendingOperation === null ||
        state.pendingOperation.experimentName !== name ||
        state.pendingOperation.operation !== operation ||
        state.pendingOperation.inputHash !== inputHash
      ) {
        fail("Journal operation completion is detached from its durable claim.");
      }
      return complete(state, record);
    });
  }

  async #ensureEvent(
    name: string,
    operation: ExperimentJournalOperation,
    inputHash: string,
    createdAt: string,
    details?: Parameters<typeof eventFor>[3],
  ): Promise<void> {
    let chain: Awaited<ReturnType<typeof readAndVerifyEventChain>>;
    try {
      chain = await readAndVerifyEventChain(join(this.#evidenceStore.root, name, "events.jsonl"));
    } catch (error) {
      if (!isMissing(error)) throw error;
      chain = { records: [], head: null };
    }
    const existingIndex = chain.records.findIndex(
      (record) => record.payload.attestationHash === inputHash,
    );
    if (existingIndex >= 0) {
      if (existingIndex !== chain.records.length - 1) {
        fail("A pending journal event is not the event-chain head.");
      }
      const existing = chain.records[existingIndex];
      const expected = eventFor(operation, inputHash, createdAt, details);
      if (
        existing === undefined ||
        existing.eventType !== expected.eventType ||
        existing.actor !== expected.actor ||
        existing.createdAt !== expected.createdAt ||
        !sameCanonical(existing.payload, expected.payload)
      ) {
        fail("A journal event commitment was replayed with different content.");
      }
      return;
    }
    await this.#evidenceStore.appendEvent(name, eventFor(operation, inputHash, createdAt, details));
  }

  public async create(input: {
    readonly experiment: ExperimentIdentity;
    readonly activeChampionBefore: ChampionPointers;
    readonly initialBudget: BudgetSnapshot;
  }): Promise<void> {
    assertExactKeys(
      input,
      ["experiment", "activeChampionBefore", "initialBudget"],
      "Journal create input",
    );
    assertExperimentIdentity(input.experiment);
    assertChampionPointers(input.activeChampionBefore);
    assertBudget(input.initialBudget);
    const detached = canonicalClone(input, "Journal create input");
    const name = experimentName(detached.experiment);
    const hash = operationHash("create", detached);
    const begun = await this.#begin(name, "create", hash, (state, record) => {
      if (record !== undefined) {
        if (
          !sameCanonical(record.experiment, detached.experiment) ||
          !sameCanonical(record.activeChampionBefore, detached.activeChampionBefore) ||
          !sameCanonical(record.initialBudget, detached.initialBudget)
        ) {
          fail("Experiment creation replay changed immutable inputs.");
        }
        return;
      }
      const expectedNumber =
        Math.max(0, ...Object.values(state.records).map((entry) => entry.experiment.number)) + 1;
      if (detached.experiment.number !== expectedNumber) {
        fail("Experiment numbers must be allocated contiguously.");
      }
      if (
        detached.experiment.kind !== "optimization" ||
        detached.experiment.parentExperiment !== detached.activeChampionBefore.activeExperiment
      ) {
        fail("Experiment identity is detached from its active champion.");
      }
      const prior =
        Object.values(state.records).sort(
          (left, right) => right.experiment.number - left.experiment.number,
        )[0] ?? null;
      if (prior !== null) {
        const expectedChampion = prior.seal?.activeChampionAfter ?? prior.activeChampionBefore;
        if (
          !sameCanonical(detached.activeChampionBefore, expectedChampion) ||
          detached.experiment.lineageId !== prior.experiment.lineageId ||
          detached.experiment.protocolHash !== prior.experiment.protocolHash
        ) {
          fail("Experiment allocation breaks campaign lineage.");
        }
      }
      if (Object.values(state.records).some((entry) => entry.status === "active")) {
        fail("Only one experiment may be active in a journal.");
      }
    });
    if (begun.replay) return;

    const names = await this.#evidenceStore.listExperimentNames();
    const sameNumber = names.filter((entry) =>
      entry.startsWith(`${detached.experiment.number.toString().padStart(3, "0")}-`),
    );
    if (sameNumber.length === 0) {
      await this.#evidenceStore.createExperiment(name);
    } else if (sameNumber.length !== 1 || sameNumber[0] !== name) {
      fail("Evidence store experiment allocation conflicts with the journal.");
    }
    await this.#ensureEvent(name, "create", hash, begun.startedAt);
    await this.#complete(name, "create", hash, (state, record) => {
      if (record !== undefined) {
        return { next: state, result: undefined };
      }
      const created: DurableExperimentJournalRecord = {
        experimentName: name,
        experiment: detached.experiment,
        status: "active",
        phase: "created",
        startedAt: begun.startedAt,
        activeChampionBefore: detached.activeChampionBefore,
        initialBudget: detached.initialBudget,
        proposal: null,
        gates: null,
        repair: null,
        validation: null,
        analysisHash: null,
        gatesBudget: null,
        repairBudget: null,
        preValidationBudget: null,
        validationBudget: null,
        diagnosticBudget: null,
        operationHashes: {
          create: hash,
          proposal: null,
          gates: null,
          gatesBudget: null,
          repair: null,
          repairBudget: null,
          preValidationBudget: null,
          validationBudget: null,
          validation: null,
          analysis: null,
          diagnosticBudget: null,
          seal: null,
          interrupt: null,
        },
        interruption: null,
        seal: null,
      };
      return {
        next: replaceRecord(state, name, created),
        result: undefined,
      };
    });
  }

  public async freezeProposal(input: {
    readonly experiment: ExperimentIdentity;
    readonly proposal: OptimizerProposal;
  }): Promise<void> {
    assertExactKeys(input, ["experiment", "proposal"], "Journal proposal input");
    assertExperimentIdentity(input.experiment);
    assertProposal(input.proposal);
    if (input.experiment.number === 1 && input.proposal.hypothesis.sourceBriefHash !== null) {
      fail("Experiment 001 must freeze a source-only hypothesis.");
    }
    const detached = canonicalClone(input, "Journal proposal input");
    await this.#recordOperation({
      name: experimentName(detached.experiment),
      operation: "proposal",
      input: detached,
      expectedPhases: ["created"],
      event: {},
      apply: (record, hash) => ({
        ...record,
        phase: "proposal-frozen",
        proposal: detached.proposal,
        operationHashes: { ...record.operationHashes, proposal: hash },
      }),
    });
  }

  public async recordGates(input: {
    readonly experiment: ExperimentIdentity;
    readonly gates: GateResult;
  }): Promise<void> {
    assertExactKeys(input, ["experiment", "gates"], "Journal gates input");
    assertExperimentIdentity(input.experiment);
    assertGate(input.gates);
    if (input.gates.protocolHash !== input.experiment.protocolHash) {
      fail("Gate result protocol does not match the experiment.");
    }
    const detached = canonicalClone(input, "Journal gates input");
    await this.#recordOperation({
      name: experimentName(detached.experiment),
      operation: "gates",
      input: detached,
      expectedPhases: ["proposal-frozen"],
      event: {},
      apply: (record, hash) => ({
        ...record,
        phase: "gates-recorded",
        gates: detached.gates,
        operationHashes: { ...record.operationHashes, gates: hash },
      }),
    });
  }

  public async recordRepair(input: {
    readonly experiment: ExperimentIdentity;
    readonly repair: RepairAggregate;
  }): Promise<void> {
    assertExactKeys(input, ["experiment", "repair"], "Journal repair input");
    assertExperimentIdentity(input.experiment);
    assertRepair(input.repair);
    const detached = canonicalClone(input, "Journal repair input");
    await this.#recordOperation({
      name: experimentName(detached.experiment),
      operation: "repair",
      input: detached,
      expectedPhases: ["gates-budgeted"],
      validate: (record) => {
        if (
          record.experiment.number === 1 ||
          record.gates?.passed !== true ||
          record.gates.integrityPassed !== true
        ) {
          fail("Repair is not allowed for this experiment.");
        }
      },
      event: {},
      apply: (record, hash) => ({
        ...record,
        phase: "repair-recorded",
        repair: detached.repair,
        operationHashes: { ...record.operationHashes, repair: hash },
      }),
    });
  }

  public async recordValidation(input: {
    readonly experiment: ExperimentIdentity;
    readonly validation: ValidationAggregate;
    readonly panelDispositionAttestationHash: string;
  }): Promise<void> {
    assertExactKeys(
      input,
      ["experiment", "validation", "panelDispositionAttestationHash"],
      "Journal validation input",
    );
    assertExperimentIdentity(input.experiment);
    assertValidation(input.validation);
    assertHash(input.panelDispositionAttestationHash, "Panel disposition attestation hash");
    const detached = canonicalClone(input, "Journal validation input");
    await this.#recordOperation({
      name: experimentName(detached.experiment),
      operation: "validation",
      input: detached,
      expectedPhases: ["validation-budgeted"],
      validate: (record) => {
        if (record.preValidationBudget === null || record.validationBudget === null) {
          fail("Validation result has no pre-validation budget checkpoint.");
        }
        const onlineError = detached.validation.onlineErrorBudget;
        if (
          record.preValidationBudget.limits.maximumOnlineError !== onlineError.maximumOnlineError ||
          record.validationBudget.limits.maximumOnlineError !== onlineError.maximumOnlineError ||
          record.preValidationBudget.usage.onlineErrorSpent !== onlineError.cumulativeSpentBefore ||
          record.validationBudget.usage.onlineErrorSpent !== onlineError.cumulativeSpentAfter ||
          record.preValidationBudget.usage.promotionLooks !== onlineError.gateOrdinal
        ) {
          fail("Validation checkpoint is detached from its online-error reservation.");
        }
        assertAggregateBudgetDelta(
          record.preValidationBudget,
          record.validationBudget,
          {
            ...detached.validation,
            attempts: detached.validation.validArms + detached.validation.replacementAttempts,
            onlineErrorSpent: onlineError.alphaSpent,
          },
          "Validation",
        );
      },
      event: {
        validArmCount: detached.validation.validArms,
        invalidArmCount: detached.validation.replacementAttempts,
      },
      apply: (record, hash) => ({
        ...record,
        phase: "validation-recorded",
        validation: {
          aggregate: detached.validation,
          panelDispositionAttestationHash: detached.panelDispositionAttestationHash,
        },
        operationHashes: { ...record.operationHashes, validation: hash },
      }),
    });
  }

  public async recordAnalysis(input: {
    readonly experiment: ExperimentIdentity;
    readonly analysisHash: string;
  }): Promise<void> {
    assertExactKeys(input, ["experiment", "analysisHash"], "Journal analysis input");
    assertExperimentIdentity(input.experiment);
    assertHash(input.analysisHash, "Optimizer analysis hash");
    const detached = canonicalClone(input, "Journal analysis input");
    await this.#recordOperation({
      name: experimentName(detached.experiment),
      operation: "analysis",
      input: detached,
      expectedPhases: ["gates-budgeted", "repair-budgeted", "validation-recorded"],
      validate: (record) => {
        if (record.phase === "gates-budgeted") {
          if (record.gates?.passed && record.gates.integrityPassed) {
            fail("A gate-passing experiment cannot close before evaluation.");
          }
        } else if (record.phase === "repair-budgeted") {
          if (record.repair?.disposition === "passed") {
            fail("A repair-passing challenger requires fresh validation.");
          }
        }
      },
      event: {},
      apply: (record, hash) => ({
        ...record,
        phase: "analysis-recorded",
        analysisHash: detached.analysisHash,
        operationHashes: { ...record.operationHashes, analysis: hash },
      }),
    });
  }

  public async updateBudget(snapshot: BudgetSnapshot): Promise<void> {
    assertBudget(snapshot);
    const detached = canonicalClone(snapshot, "Journal budget checkpoint");
    const current = await this.#transact((state) => ({
      next: state,
      result: state,
    }));
    const active = Object.values(current.records).filter((record) => record.status === "active");
    if (active.length === 0) {
      const completedReplay = Object.values(current.records).some((record) =>
        [
          record.gatesBudget,
          record.repairBudget,
          record.preValidationBudget,
          record.validationBudget,
          record.diagnosticBudget,
        ].some((checkpoint) => checkpoint !== null && sameCanonical(checkpoint, detached)),
      );
      if (completedReplay) return;
    }
    if (active.length !== 1 || active[0] === undefined) {
      fail("A budget checkpoint requires exactly one active experiment.");
    }
    const record = active[0];
    if (
      [
        record.gatesBudget,
        record.repairBudget,
        record.preValidationBudget,
        record.validationBudget,
        record.diagnosticBudget,
      ].some((checkpoint) => checkpoint !== null && sameCanonical(checkpoint, detached))
    ) {
      return;
    }
    let operation: Extract<
      ExperimentJournalOperation,
      | "gates-budget"
      | "repair-budget"
      | "pre-validation-budget"
      | "validation-budget"
      | "diagnostic-budget"
    >;
    let expectedPhases: readonly ExperimentJournalPhase[];
    if (record.phase === "gates-recorded") {
      operation = "gates-budget";
      expectedPhases = ["gates-recorded"];
    } else if (record.phase === "repair-recorded") {
      operation = "repair-budget";
      expectedPhases = ["repair-recorded"];
    } else if (record.phase === "gates-budgeted" || record.phase === "repair-budgeted") {
      operation = "pre-validation-budget";
      expectedPhases = [record.phase];
    } else if (record.phase === "pre-validation-budgeted") {
      operation = "validation-budget";
      expectedPhases = ["pre-validation-budgeted"];
    } else if (record.phase === "analysis-recorded") {
      operation = "diagnostic-budget";
      expectedPhases = ["analysis-recorded"];
    } else {
      const prior = [
        ["gates-budget", record.gatesBudget],
        ["repair-budget", record.repairBudget],
        ["pre-validation-budget", record.preValidationBudget],
        ["validation-budget", record.validationBudget],
        ["diagnostic-budget", record.diagnosticBudget],
      ] as const;
      const replay = prior.find(
        ([, priorSnapshot]) => priorSnapshot !== null && sameCanonical(priorSnapshot, detached),
      );
      if (replay === undefined) {
        fail("Budget checkpoint is out of stage order.");
      }
      operation = replay[0];
      expectedPhases = [record.phase];
    }
    await this.#recordOperation({
      name: record.experimentName,
      operation,
      input: {
        experiment: record.experiment,
        snapshot: detached,
      },
      expectedPhases,
      validate: (currentRecord) => {
        switch (operation) {
          case "gates-budget":
            if (currentRecord.gates === null) fail("Gate budget has no gate result.");
            assertAggregateBudgetDelta(
              currentRecord.initialBudget,
              detached,
              currentRecord.gates,
              "Gates",
            );
            break;
          case "repair-budget":
            if (currentRecord.gatesBudget === null || currentRecord.repair === null) {
              fail("Repair budget has no repair result.");
            }
            assertAggregateBudgetDelta(
              currentRecord.gatesBudget,
              detached,
              currentRecord.repair,
              "Repair",
            );
            break;
          case "pre-validation-budget": {
            const before = currentRecord.repairBudget ?? currentRecord.gatesBudget;
            if (
              before === null ||
              currentRecord.gates?.passed !== true ||
              currentRecord.gates.integrityPassed !== true ||
              (currentRecord.experiment.number > 1 &&
                currentRecord.repair?.disposition !== "passed")
            ) {
              fail("Fresh validation is not authorized for this experiment.");
            }
            const delta = usageDelta(before, detached);
            if (
              delta.promotionLooks !== 1 ||
              delta.spentUsd !== 0 ||
              delta.tokens !== 0 ||
              delta.wallTimeMs !== 0 ||
              delta.attempts !== 0 ||
              delta.privacyReleases !== 0 ||
              delta.onlineErrorSpent !== 0
            ) {
              fail("Pre-validation checkpoint must spend exactly one promotion look.");
            }
            break;
          }
          case "validation-budget": {
            if (currentRecord.preValidationBudget === null) {
              fail("Validation spend has no pre-validation checkpoint.");
            }
            const delta = usageDelta(currentRecord.preValidationBudget, detached);
            if (
              delta.promotionLooks !== 0 ||
              delta.privacyReleases !== 0 ||
              delta.onlineErrorSpent < 0 ||
              delta.attempts < 24 ||
              delta.attempts > 28
            ) {
              fail("Validation spend violates bounded fresh-panel accounting.");
            }
            break;
          }
          case "diagnostic-budget": {
            const releasedEvidenceHash = currentRecord.validation?.aggregate.releasedEvidenceHash;
            if (releasedEvidenceHash === null || releasedEvidenceHash === undefined) {
              fail("A privacy release requires validation-bound released evidence.");
            }
            const delta = usageDelta(previousBudget(currentRecord), detached);
            if (
              delta.privacyReleases !== 1 ||
              delta.spentUsd !== 0 ||
              delta.tokens !== 0 ||
              delta.wallTimeMs !== 0 ||
              delta.attempts !== 0 ||
              delta.promotionLooks !== 0 ||
              delta.onlineErrorSpent !== 0
            ) {
              fail("Diagnostic checkpoint must spend exactly one privacy release.");
            }
            break;
          }
        }
      },
      event: {},
      apply: (currentRecord, hash) => {
        switch (operation) {
          case "gates-budget":
            return {
              ...currentRecord,
              phase: "gates-budgeted",
              gatesBudget: detached,
              operationHashes: {
                ...currentRecord.operationHashes,
                gatesBudget: hash,
              },
            };
          case "repair-budget":
            return {
              ...currentRecord,
              phase: "repair-budgeted",
              repairBudget: detached,
              operationHashes: {
                ...currentRecord.operationHashes,
                repairBudget: hash,
              },
            };
          case "pre-validation-budget":
            return {
              ...currentRecord,
              phase: "pre-validation-budgeted",
              preValidationBudget: detached,
              operationHashes: {
                ...currentRecord.operationHashes,
                preValidationBudget: hash,
              },
            };
          case "validation-budget":
            return {
              ...currentRecord,
              phase: "validation-budgeted",
              validationBudget: detached,
              operationHashes: {
                ...currentRecord.operationHashes,
                validationBudget: hash,
              },
            };
          case "diagnostic-budget":
            return {
              ...currentRecord,
              phase: "diagnostic-budgeted",
              diagnosticBudget: detached,
              operationHashes: {
                ...currentRecord.operationHashes,
                diagnosticBudget: hash,
              },
            };
        }
      },
    });
  }

  async #recordOperation<
    Operation extends Exclude<ExperimentJournalOperation, "create" | "seal" | "interrupt">,
  >(input: {
    readonly name: string;
    readonly operation: Operation;
    readonly input: unknown;
    readonly expectedPhases: readonly ExperimentJournalPhase[];
    readonly validate?: (record: DurableExperimentJournalRecord) => void;
    readonly event: Parameters<typeof eventFor>[3];
    readonly apply: (
      record: DurableExperimentJournalRecord,
      hash: string,
    ) => DurableExperimentJournalRecord;
  }): Promise<void> {
    const hash = operationHash(input.operation, input.input);
    const begun = await this.#begin(input.name, input.operation, hash, (_state, record) => {
      if (record === undefined) fail("Experiment journal record does not exist.");
      if (record.status !== "active") {
        fail("Only an active experiment can advance.");
      }
      if (
        operationReceipt(record, input.operation) === null &&
        !input.expectedPhases.includes(record.phase)
      ) {
        fail(`Journal operation ${input.operation} is invalid during ${record.phase}.`);
      }
      input.validate?.(record);
    });
    if (begun.replay) return;
    await this.#ensureEvent(input.name, input.operation, hash, begun.startedAt, input.event);
    await this.#complete(input.name, input.operation, hash, (state, record) => {
      if (record === undefined) fail("Experiment journal record disappeared.");
      if (operationReceipt(record, input.operation) === hash) {
        return { next: state, result: undefined };
      }
      const nextRecord = input.apply(record, hash);
      assertRecord(input.name, nextRecord);
      return {
        next: replaceRecord(state, input.name, nextRecord),
        result: undefined,
      };
    });
  }

  async #writeOrVerifyArtifact<FileName extends RequiredPresealArtifactFile>(
    name: string,
    fileName: FileName,
    document: ArtifactDocument<FileName>,
  ): Promise<void> {
    try {
      const existing = await this.#evidenceStore.readArtifact(name, fileName);
      if (!sameCanonical(existing, document)) {
        fail(`${fileName} already exists with different canonical content.`);
      }
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    try {
      await this.#evidenceStore.writeArtifact(name, fileName, document);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        String((error as NodeJS.ErrnoException).code) !== "EEXIST"
      ) {
        throw error;
      }
      const existing = await this.#evidenceStore.readArtifact(name, fileName);
      if (!sameCanonical(existing, document)) {
        fail(`${fileName} raced with different canonical content.`);
      }
    }
  }

  async #existingAttestation(name: string): Promise<Attestation | null> {
    try {
      await lstat(join(this.#evidenceStore.root, name, "attestation.json"));
      return await this.#evidenceStore.readArtifact(name, "attestation.json");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  public async seal(input: {
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
  }> {
    assertExactKeys(
      input,
      ["experiment", "disposition", "activeChampionBefore", "promotedCandidate", "diagnosticBrief"],
      "Journal seal input",
    );
    assertExperimentIdentity(input.experiment);
    assertChampionPointers(input.activeChampionBefore);
    if (!["promoted", "rejected", "inconclusive"].includes(input.disposition)) {
      fail("Journal seal disposition is invalid.");
    }
    if (input.promotedCandidate !== null) {
      assertExactKeys(
        input.promotedCandidate,
        ["experimentNumber", "commit", "decidedAt"],
        "Promoted candidate",
      );
      if (
        !Number.isSafeInteger(input.promotedCandidate.experimentNumber) ||
        typeof input.promotedCandidate.commit !== "string" ||
        !COMMIT.test(input.promotedCandidate.commit)
      ) {
        fail("Promoted candidate is malformed.");
      }
      assertTimestamp(input.promotedCandidate.decidedAt, "Promotion decision timestamp");
    }
    if (input.diagnosticBrief !== null) {
      assertDiagnosticBriefReference(input.diagnosticBrief);
    }
    const detached = canonicalClone(input, "Journal seal input");
    const name = experimentName(detached.experiment);
    /*
     * ExperimentRunner obtains decidedAt from a live clock immediately before
     * this call. Excluding that non-semantic clock sample from the operation
     * commitment lets a process restart resume the same already-sealed
     * decision. The journal's durable pending-operation timestamp becomes the
     * canonical finishedAt and champion-update timestamp.
     */
    const hash = operationHash("seal", {
      ...detached,
      promotedCandidate:
        detached.promotedCandidate === null
          ? null
          : {
              experimentNumber: detached.promotedCandidate.experimentNumber,
              commit: detached.promotedCandidate.commit,
            },
    });
    const begun = await this.#begin(name, "seal", hash, (_state, record) => {
      if (record === undefined) fail("Experiment journal record does not exist.");
      if (
        record.status !== "active" ||
        (record.phase !== "analysis-recorded" && record.phase !== "diagnostic-budgeted") ||
        !sameCanonical(record.activeChampionBefore, detached.activeChampionBefore) ||
        expectedDisposition(record) !== detached.disposition
      ) {
        fail("Experiment seal contradicts the durable terminal state.");
      }
      if (
        (detached.disposition === "promoted") !== (detached.promotedCandidate !== null) ||
        (detached.promotedCandidate !== null &&
          (detached.promotedCandidate.experimentNumber !== detached.experiment.number ||
            detached.promotedCandidate.commit !== record.proposal?.candidate.commit ||
            detached.promotedCandidate.commit === detached.activeChampionBefore.activeCommit ||
            Date.parse(detached.promotedCandidate.decidedAt) < Date.parse(record.startedAt)))
      ) {
        fail("Promoted candidate does not bind the frozen proposal.");
      }
      const releasedHash = record.validation?.aggregate.releasedEvidenceHash ?? null;
      if (record.validation !== null) {
        if (
          releasedHash !== (detached.diagnosticBrief?.hash ?? null) ||
          (releasedHash !== null) !== (record.diagnosticBudget !== null)
        ) {
          fail("Diagnostic release does not bind validation and privacy spend.");
        }
      } else if (
        record.diagnosticBudget !== null ||
        (detached.diagnosticBrief !== null &&
          detached.diagnosticBrief.hash !== record.proposal?.hypothesis.sourceBriefHash)
      ) {
        fail("Pre-validation closure may only carry its source brief.");
      }
    });
    if (begun.replay) {
      const sealed = begun.record?.seal;
      if (sealed === undefined || sealed === null) {
        return fail("Sealed operation receipt has no durable seal.");
      }
      return {
        sealHash: sealed.sealChainEntryHash,
        activeChampionAfter: sealed.activeChampionAfter,
      };
    }
    if (begun.record === undefined) {
      return fail("Experiment journal record disappeared before sealing.");
    }
    const stablePromotedCandidate =
      detached.promotedCandidate === null
        ? null
        : {
            ...detached.promotedCandidate,
            decidedAt: begun.startedAt,
          };
    const snapshot = finalSnapshot(begun.record, {
      ...detached,
      promotedCandidate: stablePromotedCandidate,
      finishedAt: begun.startedAt,
    });
    const artifacts = await this.#artifactAssembler.assemble(snapshot);
    assertFinalArtifactBindings(snapshot, artifacts);

    await this.#ensureEvent(name, "seal", hash, begun.startedAt, { stateTo: detached.disposition });
    for (const fileName of REQUIRED_PRESEAL_ARTIFACT_FILES) {
      await this.#writeOrVerifyArtifact(name, fileName, artifacts[fileName]);
    }

    let authorityAttestationHash: string;
    let attestation = await this.#existingAttestation(name);
    if (attestation === null) {
      const subject = await this.#evidenceStore.captureLeakScanSubject(name);
      const requestHash = canonicalHash({
        domain: "dark-factory.experiment-seal-authorization.v1",
        subject,
        previousExperimentSealHash: begun.state.sealChainHead,
        assemblyRequestHash: snapshot.assemblyRequestHash,
      });
      const authorization = await this.#sealAuthority.authorize({
        requestHash,
        subject,
        previousExperimentSealHash: begun.state.sealChainHead,
        assemblyRequestHash: snapshot.assemblyRequestHash,
      });
      assertExactKeys(
        authorization,
        ["authorityAttestationHash", "pinnedVersions", "leakScanReceipt", "signer"],
        "Trusted seal authorization",
      );
      assertHash(authorization.authorityAttestationHash, "Seal authority attestation hash");
      assertValidDocument("leakScanReceipt", authorization.leakScanReceipt);
      if (
        authorization.authorityAttestationHash !== authorization.leakScanReceipt.contentHash ||
        authorization.leakScanReceipt.experimentId !== name ||
        authorization.leakScanReceipt.experimentNumber !== detached.experiment.number ||
        authorization.leakScanReceipt.protocolHash !== detached.experiment.protocolHash ||
        authorization.leakScanReceipt.artifactManifestHash !== subject.artifactManifestHash ||
        authorization.leakScanReceipt.eventChainHead !== subject.eventChainHead ||
        authorization.leakScanReceipt.eventRecordCount !== subject.eventRecordCount
      ) {
        fail("Trusted seal authorization is detached from the leak-scan subject.");
      }
      const sealOptions: SealExperimentOptions = {
        pinnedVersions: authorization.pinnedVersions,
        leakScanReceipt: authorization.leakScanReceipt,
        previousExperimentSealHash: begun.state.sealChainHead,
        signer: authorization.signer,
      };
      authorityAttestationHash = authorization.authorityAttestationHash;
      attestation = await this.#evidenceStore.sealExperiment(name, sealOptions);
    } else {
      const report = await this.#evidenceStore.verifyExperiment(name, {
        requireSeal: true,
        requireAllArtifacts: true,
      });
      if (!report.valid) {
        fail("Crash-recovered experiment attestation is invalid.");
      }
      if (attestation.previousExperimentSealHash !== begun.state.sealChainHead) {
        fail("Crash-recovered experiment seal has the wrong predecessor.");
      }
      /*
       * The authority attestation was committed into the signed leak-scan
       * receipt. Its content hash is the recoverable immutable authority
       * commitment when the mutable state commit was interrupted.
       */
      authorityAttestationHash = attestation.graderLeakScan.contentHash;
    }
    if (
      attestation.previousExperimentSealHash !== begun.state.sealChainHead ||
      attestation.experimentNumber !== detached.experiment.number ||
      Date.parse(attestation.sealedAt) < Date.parse(snapshot.finishedAt)
    ) {
      fail("Experiment attestation does not extend the durable seal lineage.");
    }

    const activeChampionAfter =
      stablePromotedCandidate === null
        ? detached.activeChampionBefore
        : updateChampionPointers(detached.activeChampionBefore, {
            experimentNumber: stablePromotedCandidate.experimentNumber,
            commit: stablePromotedCandidate.commit,
            state: "promoted",
            sealedAt: stablePromotedCandidate.decidedAt,
            sealHash: attestation.sealChainEntryHash,
          });
    return this.#complete(name, "seal", hash, (state, record) => {
      if (record?.seal !== null && record?.seal !== undefined) {
        return {
          next: state,
          result: {
            sealHash: record.seal.sealChainEntryHash,
            activeChampionAfter: record.seal.activeChampionAfter,
          },
        };
      }
      if (record === undefined) fail("Experiment journal record disappeared.");
      const sealedRecord: DurableExperimentJournalRecord = {
        ...record,
        status: "sealed",
        phase: "sealed",
        operationHashes: { ...record.operationHashes, seal: hash },
        seal: {
          disposition: detached.disposition,
          evaluationStage: snapshot.evaluationStage,
          diagnosticBrief: detached.diagnosticBrief,
          authorityAttestationHash,
          attestationContentHash: attestation.contentHash,
          sealChainEntryHash: attestation.sealChainEntryHash,
          previousExperimentSealHash: attestation.previousExperimentSealHash,
          activeChampionAfter,
          sealedAt: attestation.sealedAt,
        },
      };
      return {
        next: replaceRecord(state, name, sealedRecord, {
          lastSealedExperimentNumber: detached.experiment.number,
          sealChainHead: attestation.sealChainEntryHash,
        }),
        result: {
          sealHash: attestation.sealChainEntryHash,
          activeChampionAfter,
        },
      };
    });
  }

  public async interrupt(input: {
    readonly experiment: ExperimentIdentity;
    readonly phase: string;
    readonly reason: string;
  }): Promise<void> {
    assertExactKeys(input, ["experiment", "phase", "reason"], "Journal interruption input");
    assertExperimentIdentity(input.experiment);
    if (
      typeof input.phase !== "string" ||
      !SAFE_ID.test(input.phase) ||
      typeof input.reason !== "string" ||
      input.reason.length < 1 ||
      input.reason.length > 16_384
    ) {
      fail("Journal interruption input is malformed.");
    }
    const name = experimentName(input.experiment);
    const observed = await this.#transact((state) => ({
      next: state,
      result: state,
    }));
    const observedRecord = observed.records[name];
    if (observedRecord === undefined) {
      fail("Cannot interrupt an unknown experiment.");
    }
    if (observedRecord.interruption !== null) {
      if (
        observedRecord.interruption.phase !== input.phase ||
        observedRecord.operationHashes.interrupt === null
      ) {
        fail("Interrupted experiment replay changed its release-safe phase.");
      }
      await this.#ensureEvent(
        name,
        "interrupt",
        observedRecord.operationHashes.interrupt,
        observedRecord.interruption.interruptedAt,
      );
      return;
    }
    if (observedRecord.status !== "active") {
      fail("Only an active experiment may be interrupted.");
    }
    if (observed.pendingOperation !== null && observed.pendingOperation.experimentName !== name) {
      fail("Cannot interrupt while another experiment operation is pending.");
    }
    if (
      observed.pendingOperation?.operation === "seal" &&
      (await this.#existingAttestation(name)) !== null
    ) {
      // Preserve the recoverable seal claim. A retry will verify the immutable
      // attestation and finish the mutable journal commit.
      return;
    }
    const attested = await this.#interruptionAttestor.attest(input);
    assertExactKeys(
      attested,
      ["reasonCode", "attestationHash"],
      "Trusted interruption attestation",
    );
    if (typeof attested.reasonCode !== "string" || !SAFE_RELEASE_ID.test(attested.reasonCode)) {
      fail("Trusted interruption reason code is malformed.");
    }
    assertHash(attested.attestationHash, "Trusted interruption attestation hash");
    const safeInput = {
      experiment: input.experiment,
      phase: input.phase,
      reasonCode: attested.reasonCode,
      attestationHash: attested.attestationHash,
    };
    const hash = operationHash("interrupt", safeInput);
    const committed = await this.#transact((state) => {
      const record = state.records[name];
      if (record === undefined) fail("Cannot interrupt an unknown experiment.");
      if (record.operationHashes.interrupt === hash) {
        return {
          next: state,
          result: {
            interruptedAt: record.interruption?.interruptedAt ?? record.startedAt,
          },
        };
      }
      if (record.status !== "active") {
        fail("Only an active experiment may be interrupted.");
      }
      const abandoned = state.pendingOperation;
      if (abandoned !== null && abandoned.experimentName !== name) {
        fail("Cannot interrupt while another experiment operation is pending.");
      }
      const interruptedAt = nowTimestamp(this.#now);
      const interrupted: DurableExperimentJournalRecord = {
        ...record,
        status: "interrupted",
        operationHashes: { ...record.operationHashes, interrupt: hash },
        interruption: {
          phase: input.phase,
          reasonCode: attested.reasonCode,
          attestationHash: attested.attestationHash,
          interruptedAt,
          abandonedOperation: abandoned?.operation ?? null,
          abandonedOperationHash: abandoned?.inputHash ?? null,
        },
      };
      return {
        next: replaceRecord(state, name, interrupted),
        result: { interruptedAt },
      };
    });
    await this.#ensureEvent(name, "interrupt", hash, committed.interruptedAt);
  }
}
