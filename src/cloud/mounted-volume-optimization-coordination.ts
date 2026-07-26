import {
  validateBudgetSnapshot,
} from "../core/budget.js";
import type {
  BudgetSnapshot,
  ChampionPointers,
  ExperimentIdentity,
} from "../domain/models.js";
import type {
  OptimizationLoopSnapshot,
} from "../orchestrator/autonomous-loop.js";
import type {
  OptimizationInputPreparationContext,
  OptimizationInterruptionControl,
  OptimizationInterruptionRecord,
  OptimizationInterruptionRecordDraft,
  OptimizationResumeVerification,
  PersistedOptimizationClaimBinding,
  ReleaseSafeResumeCheckpoint,
  TrustedOptimizationInputFactory,
  TrustedOptimizationInterruptionPort,
  TrustedOptimizationResumeVerifier,
} from "../orchestrator/campaign-state-coordinator.js";
import type {
  DiagnosticBriefReference,
  ExperimentRunInput,
} from "../orchestrator/contracts.js";
import {
  canonicalHash,
  canonicalJson,
} from "../schemas/canonical.js";
import {
  MountedVolumeTransactionalJsonStore,
  type MountedVolumeDurableStateOptions,
} from "./mounted-volume-state.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_ID =
  /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const SAFE_KEY_ID =
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,255}$/u;
const OPAQUE_DIAGNOSTIC_RELEASE_ID =
  /^diagnostic[-:](?:[0-9]{1,12}|[a-f0-9]{16,64})$/u;

export class MountedVolumeOptimizationCoordinationError extends Error {
  override readonly name =
    "MountedVolumeOptimizationCoordinationError";

  public constructor() {
    super("Trusted optimization coordination failed.");
  }
}

function fail(): never {
  throw new MountedVolumeOptimizationCoordinationError();
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
  keys: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail();
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    fail();
  }
}

function assertHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) fail();
}

function assertNullableHash(
  value: unknown,
): asserts value is string | null {
  if (value !== null) assertHash(value);
}

function assertSafeId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail();
}

function cloneJson<Value>(value: Value): Value {
  return JSON.parse(canonicalJson(value)) as Value;
}

function assertDiagnosticBrief(
  value: unknown,
): asserts value is DiagnosticBriefReference | null {
  if (value === null) return;
  assertExactKeys(value, ["hash", "releaseId", "actionable"]);
  if (
    typeof value.hash !== "string" ||
    !SHA256.test(value.hash) ||
    typeof value.releaseId !== "string" ||
    !OPAQUE_DIAGNOSTIC_RELEASE_ID.test(value.releaseId) ||
    typeof value.actionable !== "boolean"
  ) {
    fail();
  }
}

function assertChampionPointers(
  value: unknown,
): asserts value is ChampionPointers {
  assertExactKeys(value, [
    "baselineCommit",
    "activeExperiment",
    "activeCommit",
    "certifiedExperiment",
    "certifiedCommit",
    "updatedAt",
    "sourceSealHash",
  ]);
  if (
    typeof value.baselineCommit !== "string" ||
    !GIT_OBJECT.test(value.baselineCommit) ||
    !Number.isSafeInteger(value.activeExperiment) ||
    (value.activeExperiment as number) < 0 ||
    typeof value.activeCommit !== "string" ||
    !GIT_OBJECT.test(value.activeCommit) ||
    (value.certifiedExperiment !== null &&
      (!Number.isSafeInteger(value.certifiedExperiment) ||
        (value.certifiedExperiment as number) < 0)) ||
    (value.certifiedCommit !== null &&
      (typeof value.certifiedCommit !== "string" ||
        !GIT_OBJECT.test(value.certifiedCommit))) ||
    (value.certifiedExperiment === null) !==
      (value.certifiedCommit === null) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    new Date(value.updatedAt).toISOString() !== value.updatedAt ||
    typeof value.sourceSealHash !== "string" ||
    !SHA256.test(value.sourceSealHash)
  ) {
    fail();
  }
}

function assertBudget(
  value: unknown,
): asserts value is BudgetSnapshot {
  assertExactKeys(value, ["limits", "usage"]);
  assertExactKeys(value.limits, [
    "maximumUsd",
    "maximumTokens",
    "maximumWallTimeMs",
    "maximumAttempts",
    "maximumPrivacyReleases",
    "maximumPromotionLooks",
    "maximumOnlineError",
  ]);
  assertExactKeys(value.usage, [
    "spentUsd",
    "tokens",
    "wallTimeMs",
    "attempts",
    "privacyReleases",
    "promotionLooks",
    "onlineErrorSpent",
  ]);
  try {
    validateBudgetSnapshot(value as unknown as BudgetSnapshot);
  } catch {
    fail();
  }
  const budget = value as unknown as BudgetSnapshot;
  const integers = [
    budget.limits.maximumTokens,
    budget.limits.maximumWallTimeMs,
    budget.limits.maximumAttempts,
    budget.limits.maximumPrivacyReleases,
    budget.limits.maximumPromotionLooks,
    budget.usage.tokens,
    budget.usage.wallTimeMs,
    budget.usage.attempts,
    budget.usage.privacyReleases,
    budget.usage.promotionLooks,
  ];
  if (
    integers.some((item) => !Number.isSafeInteger(item)) ||
    budget.usage.spentUsd > budget.limits.maximumUsd ||
    budget.usage.tokens > budget.limits.maximumTokens ||
    budget.usage.wallTimeMs >
      budget.limits.maximumWallTimeMs ||
    budget.usage.attempts > budget.limits.maximumAttempts ||
    budget.usage.privacyReleases >
      budget.limits.maximumPrivacyReleases ||
    budget.usage.promotionLooks >
      budget.limits.maximumPromotionLooks ||
    budget.usage.onlineErrorSpent >
      budget.limits.maximumOnlineError
  ) {
    fail();
  }
}

function assertExperimentIdentity(
  value: unknown,
): asserts value is ExperimentIdentity {
  assertExactKeys(value, [
    "number",
    "slug",
    "kind",
    "parentExperiment",
    "lineageId",
    "protocolHash",
  ]);
  if (
    !Number.isSafeInteger(value.number) ||
    (value.number as number) < 1 ||
    (value.slug !== "source-only-bootstrap" &&
      value.slug !== "diagnostic-repair") ||
    value.kind !== "optimization" ||
    (value.parentExperiment !== null &&
      (!Number.isSafeInteger(value.parentExperiment) ||
        (value.parentExperiment as number) < 0 ||
        (value.parentExperiment as number) >=
          (value.number as number))) ||
    typeof value.lineageId !== "string" ||
    !SAFE_ID.test(value.lineageId) ||
    typeof value.protocolHash !== "string" ||
    !SHA256.test(value.protocolHash)
  ) {
    fail();
  }
}

function assertLoopSnapshot(
  value: unknown,
): asserts value is OptimizationLoopSnapshot {
  assertExactKeys(value, [
    "schemaVersion",
    "campaignId",
    "lineageId",
    "protocolHash",
    "stateHash",
    "status",
    "nextExperimentNumber",
    "inFlightExperimentNumber",
    "inFlightKind",
    "activeChampion",
    "budget",
    "hardBudgetExhausted",
    "freshValidationPanelsRemaining",
  ]);
  if (
    value.schemaVersion !== 1 ||
    typeof value.campaignId !== "string" ||
    !SAFE_ID.test(value.campaignId) ||
    typeof value.lineageId !== "string" ||
    !SAFE_ID.test(value.lineageId) ||
    typeof value.protocolHash !== "string" ||
    !SHA256.test(value.protocolHash) ||
    typeof value.stateHash !== "string" ||
    !SHA256.test(value.stateHash) ||
    value.status !== "running" ||
    !Number.isSafeInteger(value.nextExperimentNumber) ||
    (value.nextExperimentNumber as number) < 2 ||
    !Number.isSafeInteger(value.inFlightExperimentNumber) ||
    (value.inFlightExperimentNumber as number) < 1 ||
    value.nextExperimentNumber !==
      (value.inFlightExperimentNumber as number) + 1 ||
    value.inFlightKind !== "optimization" ||
    typeof value.hardBudgetExhausted !== "boolean" ||
    !Number.isSafeInteger(
      value.freshValidationPanelsRemaining,
    ) ||
    (value.freshValidationPanelsRemaining as number) < 0
  ) {
    fail();
  }
  assertChampionPointers(value.activeChampion);
  assertBudget(value.budget);
}

function assertPreparationContext(
  value: unknown,
): asserts value is OptimizationInputPreparationContext {
  assertExactKeys(value, [
    "schemaVersion",
    "domain",
    "campaignId",
    "lineageId",
    "protocolHash",
    "priorStateHash",
    "allocationStateHash",
    "allocationSnapshot",
    "experimentNumber",
    "sourceOnlyBootstrap",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.domain !==
      "dark-factory.optimization-input-preparation.v1" ||
    typeof value.campaignId !== "string" ||
    !SAFE_ID.test(value.campaignId) ||
    typeof value.lineageId !== "string" ||
    !SAFE_ID.test(value.lineageId) ||
    typeof value.protocolHash !== "string" ||
    !SHA256.test(value.protocolHash) ||
    typeof value.priorStateHash !== "string" ||
    !SHA256.test(value.priorStateHash) ||
    typeof value.allocationStateHash !== "string" ||
    !SHA256.test(value.allocationStateHash) ||
    value.priorStateHash === value.allocationStateHash ||
    !Number.isSafeInteger(value.experimentNumber) ||
    (value.experimentNumber as number) < 1 ||
    typeof value.sourceOnlyBootstrap !== "boolean" ||
    value.sourceOnlyBootstrap !== (value.experimentNumber === 1)
  ) {
    fail();
  }
  assertLoopSnapshot(value.allocationSnapshot);
  const snapshot =
    value.allocationSnapshot as OptimizationLoopSnapshot;
  if (
    snapshot.campaignId !== value.campaignId ||
    snapshot.lineageId !== value.lineageId ||
    snapshot.protocolHash !== value.protocolHash ||
    snapshot.stateHash !== value.allocationStateHash ||
    snapshot.inFlightExperimentNumber !==
      value.experimentNumber
  ) {
    fail();
  }
}

function assertExperimentRunInput(
  value: unknown,
): asserts value is ExperimentRunInput {
  assertExactKeys(value, [
    "experiment",
    "activeChampion",
    "budget",
    "diagnosticBrief",
    "previousDiscoveryAttestationHash",
    "repairAttemptOrdinal",
    "stop",
  ]);
  assertExperimentIdentity(value.experiment);
  assertChampionPointers(value.activeChampion);
  assertBudget(value.budget);
  assertDiagnosticBrief(value.diagnosticBrief);
  assertNullableHash(value.previousDiscoveryAttestationHash);
  assertExactKeys(value.stop, ["requested"]);
  if (
    (value.repairAttemptOrdinal !== 1 &&
      value.repairAttemptOrdinal !== 2) ||
    value.stop.requested !== false ||
    (value.experiment.number === 1 &&
      (value.diagnosticBrief !== null ||
        value.previousDiscoveryAttestationHash !== null ||
        value.repairAttemptOrdinal !== 1)) ||
    (value.experiment.number > 1 &&
      value.previousDiscoveryAttestationHash === null)
  ) {
    fail();
  }
}

export interface TaskFreeOptimizationDiagnosticDiscovery {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.task-free-optimization-diagnostic-discovery.v1";
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly experimentNumber: number;
  readonly allocationStateHash: string;
  readonly diagnosticBrief: DiagnosticBriefReference | null;
  readonly previousDiscoveryAttestationHash: string;
  readonly repairAttemptOrdinal: 1 | 2;
  readonly priorAllocationStateHash: string | null;
  readonly priorClaimHash: string | null;
  readonly diagnosticBindingHash: string;
  readonly resolutionAttestationHash: string;
  readonly containsTaskIdentifiers: false;
}

export interface TrustedTaskFreeOptimizationDiagnosticResolver {
  readonly boundary: "trusted-cloud";
  resolve(
    context: OptimizationInputPreparationContext,
  ): Promise<TaskFreeOptimizationDiagnosticDiscovery>;
}

function diagnosticBindingHash(input: {
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly diagnosticBrief: DiagnosticBriefReference | null;
  readonly previousDiscoveryAttestationHash: string;
}): string {
  return canonicalHash({
    domain:
      "dark-factory.task-free-diagnostic-binding.v1",
    campaignId: input.campaignId,
    lineageId: input.lineageId,
    protocolHash: input.protocolHash,
    diagnosticBrief: input.diagnosticBrief,
    previousDiscoveryAttestationHash:
      input.previousDiscoveryAttestationHash,
  });
}

function assertDiagnosticDiscovery(
  value: unknown,
  context?: OptimizationInputPreparationContext,
): asserts value is TaskFreeOptimizationDiagnosticDiscovery {
  assertExactKeys(value, [
    "schemaVersion",
    "domain",
    "campaignId",
    "lineageId",
    "protocolHash",
    "experimentNumber",
    "allocationStateHash",
    "diagnosticBrief",
    "previousDiscoveryAttestationHash",
    "repairAttemptOrdinal",
    "priorAllocationStateHash",
    "priorClaimHash",
    "diagnosticBindingHash",
    "resolutionAttestationHash",
    "containsTaskIdentifiers",
  ]);
  assertDiagnosticBrief(value.diagnosticBrief);
  assertNullableHash(value.priorAllocationStateHash);
  assertNullableHash(value.priorClaimHash);
  if (
    value.schemaVersion !== 1 ||
    value.domain !==
      "dark-factory.task-free-optimization-diagnostic-discovery.v1" ||
    typeof value.campaignId !== "string" ||
    !SAFE_ID.test(value.campaignId) ||
    typeof value.lineageId !== "string" ||
    !SAFE_ID.test(value.lineageId) ||
    typeof value.protocolHash !== "string" ||
    !SHA256.test(value.protocolHash) ||
    !Number.isSafeInteger(value.experimentNumber) ||
    (value.experimentNumber as number) < 2 ||
    typeof value.allocationStateHash !== "string" ||
    !SHA256.test(value.allocationStateHash) ||
    typeof value.previousDiscoveryAttestationHash !== "string" ||
    !SHA256.test(value.previousDiscoveryAttestationHash) ||
    (value.repairAttemptOrdinal !== 1 &&
      value.repairAttemptOrdinal !== 2) ||
    ((value.repairAttemptOrdinal === 1) !==
      (value.priorAllocationStateHash === null)) ||
    ((value.repairAttemptOrdinal === 1) !==
      (value.priorClaimHash === null)) ||
    typeof value.diagnosticBindingHash !== "string" ||
    value.diagnosticBindingHash !==
      diagnosticBindingHash({
        campaignId: value.campaignId,
        lineageId: value.lineageId,
        protocolHash: value.protocolHash,
        diagnosticBrief:
          value.diagnosticBrief as DiagnosticBriefReference | null,
        previousDiscoveryAttestationHash:
          value.previousDiscoveryAttestationHash,
      }) ||
    typeof value.resolutionAttestationHash !== "string" ||
    !SHA256.test(value.resolutionAttestationHash) ||
    value.containsTaskIdentifiers !== false
  ) {
    fail();
  }
  if (
    context !== undefined &&
    (value.campaignId !== context.campaignId ||
      value.lineageId !== context.lineageId ||
      value.protocolHash !== context.protocolHash ||
      value.experimentNumber !== context.experimentNumber ||
      value.allocationStateHash !==
        context.allocationStateHash)
  ) {
    fail();
  }
}

interface DurableOptimizationPreparation {
  readonly contextHash: string;
  readonly context: OptimizationInputPreparationContext;
  readonly inputHash: string;
  readonly input: ExperimentRunInput;
  readonly discovery:
    | TaskFreeOptimizationDiagnosticDiscovery
    | null;
  readonly claimBinding: PersistedOptimizationClaimBinding | null;
}

export interface TrustedOptimizationResumePathAttestation {
  readonly schemaVersion: 1;
  readonly sensitivity:
    "release-safe-optimization-resume-path-attestation";
  readonly pathHash: string;
  readonly checkpointChainHash: string;
  readonly checkpointCount: number;
  readonly authorizationAttestationHash: string;
  readonly signerKeyId: string;
  readonly containsTaskIdentifiers: false;
}

export interface TrustedOptimizationResumeAttestationAuthority {
  readonly boundary: "trusted-cloud-attestation-authority";
  verifyAndAttest(
    path: OptimizationResumeVerification,
  ): Promise<TrustedOptimizationResumePathAttestation>;
}

interface DurableOptimizationResumePath {
  readonly path: OptimizationResumeVerification;
  readonly pathHash: string;
  readonly checkpointChainHash: string;
  readonly verificationHistory:
    readonly TrustedOptimizationResumePathAttestation[];
}

export interface TrustedOptimizationBrokerExposureAttestation {
  readonly schemaVersion: 1;
  readonly sensitivity:
    "release-safe-optimization-broker-exposure-attestation";
  readonly draftHash: string;
  readonly brokerExposureStateAttestationHash: string;
  readonly authorizationAttestationHash: string;
  readonly containsTaskIdentifiers: false;
}

export interface TrustedOptimizationControlAuthorization {
  readonly schemaVersion: 1;
  readonly sensitivity:
    "release-safe-optimization-interruption-control-authorization";
  readonly recordHash: string;
  readonly currentStateHash: string;
  readonly control: OptimizationInterruptionControl;
  readonly controlHash: string;
  readonly authorizationAttestationHash: string;
  readonly containsTaskIdentifiers: false;
}

export interface TrustedOptimizationInterruptionAuthority {
  readonly boundary: "trusted-cloud-attestation-authority";
  attestBrokerExposure(
    draft: Omit<
      OptimizationInterruptionRecordDraft,
      "brokerExposureStateAttestationHash"
    >,
  ): Promise<TrustedOptimizationBrokerExposureAttestation>;
  authorizeControl(input: {
    readonly record: OptimizationInterruptionRecord;
    readonly currentStateHash: string;
  }): Promise<TrustedOptimizationControlAuthorization>;
}

interface DurableOptimizationControlPreparation {
  readonly currentStateHash: string;
  readonly control: OptimizationInterruptionControl;
  readonly controlHash: string;
  readonly authorizationAttestationHash: string;
}

interface DurableOptimizationInterruption {
  readonly record: OptimizationInterruptionRecord;
  readonly brokerExposureAuthorizationAttestationHash: string;
  readonly controlPreparation:
    | DurableOptimizationControlPreparation
    | null;
  readonly finalStateHash: string | null;
}

export interface DurableOptimizationCoordinationState {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-optimization-coordination";
  readonly storeScopeHash: string;
  readonly revision: number;
  readonly preparations: Readonly<
    Record<string, DurableOptimizationPreparation>
  >;
  readonly resumePaths: Readonly<
    Record<string, DurableOptimizationResumePath>
  >;
  readonly interruptions: Readonly<
    Record<string, DurableOptimizationInterruption>
  >;
  readonly activeInterruptions: Readonly<
    Record<string, string>
  >;
}

export interface AtomicOptimizationCoordinationStateStore {
  transact<Result>(
    operation: (state: DurableOptimizationCoordinationState) => {
      readonly next: DurableOptimizationCoordinationState;
      readonly result: Result;
    },
  ): Promise<Result>;
}

function assertInputMatchesContext(
  input: ExperimentRunInput,
  context: OptimizationInputPreparationContext,
  discovery: TaskFreeOptimizationDiagnosticDiscovery | null,
): void {
  if (
    input.experiment.number !== context.experimentNumber ||
    input.experiment.slug !==
      (context.sourceOnlyBootstrap
        ? "source-only-bootstrap"
        : "diagnostic-repair") ||
    input.experiment.parentExperiment !==
      context.allocationSnapshot.activeChampion.activeExperiment ||
    input.experiment.lineageId !== context.lineageId ||
    input.experiment.protocolHash !== context.protocolHash ||
    canonicalJson(input.activeChampion) !==
      canonicalJson(context.allocationSnapshot.activeChampion) ||
    canonicalJson(input.budget) !==
      canonicalJson(context.allocationSnapshot.budget) ||
    input.stop.requested !== false
  ) {
    fail();
  }
  if (context.sourceOnlyBootstrap) {
    if (
      discovery !== null ||
      input.diagnosticBrief !== null ||
      input.previousDiscoveryAttestationHash !== null ||
      input.repairAttemptOrdinal !== 1
    ) {
      fail();
    }
    return;
  }
  if (
    discovery === null ||
    canonicalJson(input.diagnosticBrief) !==
      canonicalJson(discovery.diagnosticBrief) ||
    input.previousDiscoveryAttestationHash !==
      discovery.previousDiscoveryAttestationHash ||
    input.repairAttemptOrdinal !==
      discovery.repairAttemptOrdinal
  ) {
    fail();
  }
}

function assertClaimBinding(
  value: unknown,
): asserts value is PersistedOptimizationClaimBinding {
  assertExactKeys(value, [
    "schemaVersion",
    "domain",
    "campaignId",
    "lineageId",
    "protocolHash",
    "experimentNumber",
    "priorStateHash",
    "allocationStateHash",
    "claimHash",
    "inputHash",
    "previousDiscoveryAttestationHash",
    "repairAttemptOrdinal",
  ]);
  assertSafeId(value.campaignId);
  assertSafeId(value.lineageId);
  assertHash(value.protocolHash);
  assertHash(value.priorStateHash);
  assertHash(value.allocationStateHash);
  assertHash(value.claimHash);
  assertHash(value.inputHash);
  assertNullableHash(value.previousDiscoveryAttestationHash);
  if (
    value.schemaVersion !== 1 ||
    value.domain !==
      "dark-factory.optimization-claim-binding.v1" ||
    !Number.isSafeInteger(value.experimentNumber) ||
    (value.experimentNumber as number) < 1 ||
    (value.repairAttemptOrdinal !== 1 &&
      value.repairAttemptOrdinal !== 2)
  ) {
    fail();
  }
}

function assertPreparation(
  key: string,
  value: unknown,
): asserts value is DurableOptimizationPreparation {
  assertHash(key);
  assertExactKeys(value, [
    "contextHash",
    "context",
    "inputHash",
    "input",
    "discovery",
    "claimBinding",
  ]);
  assertPreparationContext(value.context);
  assertExperimentRunInput(value.input);
  if (value.discovery !== null) {
    assertDiagnosticDiscovery(value.discovery, value.context);
  }
  if (value.claimBinding !== null) {
    assertClaimBinding(value.claimBinding);
  }
  const context =
    value.context as OptimizationInputPreparationContext;
  const input = value.input as ExperimentRunInput;
  const discovery =
    value.discovery as TaskFreeOptimizationDiagnosticDiscovery | null;
  if (
    key !== context.allocationStateHash ||
    value.contextHash !== canonicalHash(context) ||
    value.inputHash !== canonicalHash(input)
  ) {
    fail();
  }
  assertInputMatchesContext(input, context, discovery);
  if (value.claimBinding !== null) {
    const binding =
      value.claimBinding as PersistedOptimizationClaimBinding;
    const expectedClaimHash = canonicalHash({
      domain: "dark-factory.optimization-claim.v2",
      priorStateHash: context.priorStateHash,
      allocationStateHash: context.allocationStateHash,
      input,
    });
    if (
      binding.campaignId !== context.campaignId ||
      binding.lineageId !== context.lineageId ||
      binding.protocolHash !== context.protocolHash ||
      binding.experimentNumber !== context.experimentNumber ||
      binding.priorStateHash !== context.priorStateHash ||
      binding.allocationStateHash !==
        context.allocationStateHash ||
      binding.claimHash !== expectedClaimHash ||
      binding.inputHash !== value.inputHash ||
      binding.previousDiscoveryAttestationHash !==
        input.previousDiscoveryAttestationHash ||
      binding.repairAttemptOrdinal !==
        input.repairAttemptOrdinal
    ) {
      fail();
    }
  }
}

function assertCheckpoint(
  value: unknown,
): asserts value is ReleaseSafeResumeCheckpoint {
  assertExactKeys(value, [
    "stateHash",
    "previousStateHash",
    "budgetAccountingAttestationHash",
    "brokerExposureStateAttestationHash",
    "repeatedTestingLedgerHash",
    "privacyLedgerHash",
    "cacheStateAttestationHash",
    "publicationQueueHash",
  ]);
  assertHash(value.stateHash);
  assertHash(value.previousStateHash);
  assertHash(value.budgetAccountingAttestationHash);
  assertNullableHash(value.brokerExposureStateAttestationHash);
  assertNullableHash(value.repeatedTestingLedgerHash);
  assertNullableHash(value.privacyLedgerHash);
  assertNullableHash(value.cacheStateAttestationHash);
  assertNullableHash(value.publicationQueueHash);
  if (value.stateHash === value.previousStateHash) fail();
}

export function optimizationResumeCheckpointChainHash(
  path: OptimizationResumeVerification,
): string {
  let head = canonicalHash({
    domain: "dark-factory.optimization-resume-chain-root.v1",
    campaignId: path.campaignId,
    lineageId: path.lineageId,
    protocolHash: path.protocolHash,
    experimentNumber: path.experimentNumber,
    priorStateHash: path.priorStateHash,
    allocationStateHash: path.allocationStateHash,
  });
  for (const checkpoint of path.checkpoints) {
    head = canonicalHash({
      domain:
        "dark-factory.optimization-resume-chain-link.v1",
      previousChainHash: head,
      checkpoint,
    });
  }
  return head;
}

function assertResumePath(
  value: unknown,
): asserts value is OptimizationResumeVerification {
  assertExactKeys(value, [
    "schemaVersion",
    "domain",
    "campaignId",
    "lineageId",
    "protocolHash",
    "experimentNumber",
    "priorStateHash",
    "allocationStateHash",
    "currentStateHash",
    "checkpoints",
  ]);
  assertSafeId(value.campaignId);
  assertSafeId(value.lineageId);
  assertHash(value.protocolHash);
  assertHash(value.priorStateHash);
  assertHash(value.allocationStateHash);
  assertHash(value.currentStateHash);
  if (
    value.schemaVersion !== 1 ||
    value.domain !==
      "dark-factory.optimization-resume-path.v1" ||
    !Number.isSafeInteger(value.experimentNumber) ||
    (value.experimentNumber as number) < 1 ||
    !Array.isArray(value.checkpoints) ||
    value.checkpoints.length > 1_000 ||
    value.priorStateHash === value.allocationStateHash
  ) {
    fail();
  }
  let previous = value.allocationStateHash;
  const seen = new Set<string>([
    value.priorStateHash,
    value.allocationStateHash,
  ]);
  for (const rawCheckpoint of value.checkpoints) {
    assertCheckpoint(rawCheckpoint);
    const checkpoint =
      rawCheckpoint as ReleaseSafeResumeCheckpoint;
    if (
      checkpoint.previousStateHash !== previous ||
      seen.has(checkpoint.stateHash)
    ) {
      fail();
    }
    seen.add(checkpoint.stateHash);
    previous = checkpoint.stateHash;
  }
  if (value.currentStateHash !== previous) fail();
}

function resumePathPrefix(
  path: OptimizationResumeVerification,
  checkpointCount: number,
): OptimizationResumeVerification {
  if (
    !Number.isSafeInteger(checkpointCount) ||
    checkpointCount < 0 ||
    checkpointCount > path.checkpoints.length
  ) {
    fail();
  }
  const checkpoints = path.checkpoints.slice(0, checkpointCount);
  return {
    ...path,
    currentStateHash:
      checkpoints.at(-1)?.stateHash ??
      path.allocationStateHash,
    checkpoints,
  };
}

function assertResumeAttestation(
  value: unknown,
  path: OptimizationResumeVerification,
): asserts value is TrustedOptimizationResumePathAttestation {
  assertExactKeys(value, [
    "schemaVersion",
    "sensitivity",
    "pathHash",
    "checkpointChainHash",
    "checkpointCount",
    "authorizationAttestationHash",
    "signerKeyId",
    "containsTaskIdentifiers",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.sensitivity !==
      "release-safe-optimization-resume-path-attestation" ||
    value.pathHash !== canonicalHash(path) ||
    value.checkpointChainHash !==
      optimizationResumeCheckpointChainHash(path) ||
    value.checkpointCount !== path.checkpoints.length ||
    typeof value.authorizationAttestationHash !== "string" ||
    !SHA256.test(value.authorizationAttestationHash) ||
    typeof value.signerKeyId !== "string" ||
    !SAFE_KEY_ID.test(value.signerKeyId) ||
    value.containsTaskIdentifiers !== false
  ) {
    fail();
  }
}

function assertResumeRecord(
  key: string,
  value: unknown,
): asserts value is DurableOptimizationResumePath {
  assertHash(key);
  assertExactKeys(value, [
    "path",
    "pathHash",
    "checkpointChainHash",
    "verificationHistory",
  ]);
  assertResumePath(value.path);
  if (
    key !== value.path.allocationStateHash ||
    value.pathHash !== canonicalHash(value.path) ||
    value.checkpointChainHash !==
      optimizationResumeCheckpointChainHash(value.path) ||
    !Array.isArray(value.verificationHistory) ||
    value.verificationHistory.length < 1 ||
    value.verificationHistory.length >
      value.path.checkpoints.length + 1
  ) {
    fail();
  }
  let priorCount = -1;
  for (const rawAttestation of value.verificationHistory) {
    if (!isPlainRecord(rawAttestation)) fail();
    const checkpointCount = rawAttestation.checkpointCount;
    if (
      !Number.isSafeInteger(checkpointCount) ||
      (checkpointCount as number) <= priorCount ||
      (checkpointCount as number) > value.path.checkpoints.length
    ) {
      fail();
    }
    const prefix = resumePathPrefix(
      value.path as OptimizationResumeVerification,
      checkpointCount as number,
    );
    assertResumeAttestation(rawAttestation, prefix);
    priorCount = checkpointCount as number;
  }
  const latest = value.verificationHistory.at(-1);
  if (
    latest === undefined ||
    latest.checkpointCount !== value.path.checkpoints.length
  ) {
    fail();
  }
}

function interruptionDraftHash(
  draft: Omit<
    OptimizationInterruptionRecordDraft,
    "brokerExposureStateAttestationHash"
  >,
): string {
  return canonicalHash({
    domain:
      "dark-factory.optimization-interruption-draft-binding.v1",
    draft,
  });
}

function assertInterruptionDraft(
  value: unknown,
): asserts value is Omit<
  OptimizationInterruptionRecordDraft,
  "brokerExposureStateAttestationHash"
> {
  assertExactKeys(value, [
    "schemaVersion",
    "domain",
    "campaignId",
    "lineageId",
    "protocolHash",
    "experimentNumber",
    "claimHash",
    "allocationStateHash",
    "failureClass",
  ]);
  assertSafeId(value.campaignId);
  assertSafeId(value.lineageId);
  assertHash(value.protocolHash);
  assertHash(value.claimHash);
  assertHash(value.allocationStateHash);
  if (
    value.schemaVersion !== 1 ||
    value.domain !==
      "dark-factory.optimization-interruption.v1" ||
    !Number.isSafeInteger(value.experimentNumber) ||
    (value.experimentNumber as number) < 1 ||
    ![
      "integrity",
      "infrastructure",
      "budget",
      "operator-stop",
    ].includes(value.failureClass as string)
  ) {
    fail();
  }
}

function recordDraft(
  record: OptimizationInterruptionRecord,
): OptimizationInterruptionRecordDraft {
  return {
    schemaVersion: record.schemaVersion,
    domain: record.domain,
    campaignId: record.campaignId,
    lineageId: record.lineageId,
    protocolHash: record.protocolHash,
    experimentNumber: record.experimentNumber,
    claimHash: record.claimHash,
    allocationStateHash: record.allocationStateHash,
    failureClass: record.failureClass,
    brokerExposureStateAttestationHash:
      record.brokerExposureStateAttestationHash,
  };
}

function draftWithoutExposure(
  record: OptimizationInterruptionRecord,
): Omit<
  OptimizationInterruptionRecordDraft,
  "brokerExposureStateAttestationHash"
> {
  const draft = recordDraft(record);
  return {
    schemaVersion: draft.schemaVersion,
    domain: draft.domain,
    campaignId: draft.campaignId,
    lineageId: draft.lineageId,
    protocolHash: draft.protocolHash,
    experimentNumber: draft.experimentNumber,
    claimHash: draft.claimHash,
    allocationStateHash: draft.allocationStateHash,
    failureClass: draft.failureClass,
  };
}

function assertInterruptionRecord(
  value: unknown,
): asserts value is OptimizationInterruptionRecord {
  assertExactKeys(value, [
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
  assertInterruptionDraft({
    schemaVersion: value.schemaVersion,
    domain: value.domain,
    campaignId: value.campaignId,
    lineageId: value.lineageId,
    protocolHash: value.protocolHash,
    experimentNumber: value.experimentNumber,
    claimHash: value.claimHash,
    allocationStateHash: value.allocationStateHash,
    failureClass: value.failureClass,
  });
  assertHash(value.brokerExposureStateAttestationHash);
  assertHash(value.recordHash);
  const record = value as unknown as OptimizationInterruptionRecord;
  if (record.recordHash !== canonicalHash(recordDraft(record))) {
    fail();
  }
}

function assertControl(
  value: unknown,
  failureClass: OptimizationInterruptionRecord["failureClass"],
): asserts value is OptimizationInterruptionControl {
  if (
    isPlainRecord(value) &&
    value.kind === "stop"
  ) {
    assertExactKeys(value, ["kind", "reason"]);
    if (
      failureClass !== "operator-stop" ||
      !["operator", "sigint", "sigterm", "system-shutdown"].includes(
        value.reason as string,
      )
    ) {
      fail();
    }
    return;
  }
  assertExactKeys(value, [
    "kind",
    "reason",
    "attestationHash",
  ]);
  assertHash(value.attestationHash);
  const allowed: Readonly<
    Record<
      Exclude<
        OptimizationInterruptionRecord["failureClass"],
        "operator-stop"
      >,
      readonly string[]
    >
  > = {
    integrity: ["integrity", "policy"],
    infrastructure: [
      "infrastructure",
      "publication",
      "policy",
    ],
    budget: ["budget-exhausted", "policy"],
  };
  if (
    value.kind !== "pause" ||
    failureClass === "operator-stop" ||
    !allowed[failureClass].includes(value.reason as string)
  ) {
    fail();
  }
}

function assertBrokerExposureAttestation(
  value: unknown,
  draft: Omit<
    OptimizationInterruptionRecordDraft,
    "brokerExposureStateAttestationHash"
  >,
): asserts value is TrustedOptimizationBrokerExposureAttestation {
  assertExactKeys(value, [
    "schemaVersion",
    "sensitivity",
    "draftHash",
    "brokerExposureStateAttestationHash",
    "authorizationAttestationHash",
    "containsTaskIdentifiers",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.sensitivity !==
      "release-safe-optimization-broker-exposure-attestation" ||
    value.draftHash !== interruptionDraftHash(draft) ||
    typeof value.brokerExposureStateAttestationHash !== "string" ||
    !SHA256.test(value.brokerExposureStateAttestationHash) ||
    typeof value.authorizationAttestationHash !== "string" ||
    !SHA256.test(value.authorizationAttestationHash) ||
    value.brokerExposureStateAttestationHash ===
      value.authorizationAttestationHash ||
    value.containsTaskIdentifiers !== false
  ) {
    fail();
  }
}

function assertControlAuthorization(
  value: unknown,
  record: OptimizationInterruptionRecord,
  currentStateHash: string,
): asserts value is TrustedOptimizationControlAuthorization {
  assertExactKeys(value, [
    "schemaVersion",
    "sensitivity",
    "recordHash",
    "currentStateHash",
    "control",
    "controlHash",
    "authorizationAttestationHash",
    "containsTaskIdentifiers",
  ]);
  assertControl(value.control, record.failureClass);
  if (
    value.schemaVersion !== 1 ||
    value.sensitivity !==
      "release-safe-optimization-interruption-control-authorization" ||
    value.recordHash !== record.recordHash ||
    value.currentStateHash !== currentStateHash ||
    value.controlHash !== canonicalHash(value.control) ||
    typeof value.authorizationAttestationHash !== "string" ||
    !SHA256.test(value.authorizationAttestationHash) ||
    value.containsTaskIdentifiers !== false
  ) {
    fail();
  }
}

function assertInterruptionEntry(
  key: string,
  value: unknown,
): asserts value is DurableOptimizationInterruption {
  assertHash(key);
  assertExactKeys(value, [
    "record",
    "brokerExposureAuthorizationAttestationHash",
    "controlPreparation",
    "finalStateHash",
  ]);
  assertInterruptionRecord(value.record);
  assertHash(
    value.brokerExposureAuthorizationAttestationHash,
  );
  assertNullableHash(value.finalStateHash);
  if (key !== value.record.recordHash) fail();
  if (value.controlPreparation !== null) {
    assertExactKeys(value.controlPreparation, [
      "currentStateHash",
      "control",
      "controlHash",
      "authorizationAttestationHash",
    ]);
    assertHash(value.controlPreparation.currentStateHash);
    assertControl(
      value.controlPreparation.control,
      value.record.failureClass,
    );
    assertHash(value.controlPreparation.controlHash);
    assertHash(
      value.controlPreparation.authorizationAttestationHash,
    );
    if (
      value.controlPreparation.controlHash !==
      canonicalHash(value.controlPreparation.control)
    ) {
      fail();
    }
  }
  if (
    (value.finalStateHash !== null) !==
      (value.controlPreparation !== null) &&
    value.finalStateHash !== null
  ) {
    fail();
  }
  if (
    value.finalStateHash !== null &&
    (value.controlPreparation === null ||
      value.finalStateHash ===
        value.controlPreparation.currentStateHash)
  ) {
    fail();
  }
}

function interruptionScope(
  input: {
    readonly campaignId: string;
    readonly lineageId: string;
    readonly protocolHash: string;
  },
): string {
  return canonicalHash({
    domain:
      "dark-factory.optimization-interruption-scope.v1",
    campaignId: input.campaignId,
    lineageId: input.lineageId,
    protocolHash: input.protocolHash,
  });
}

function assertPreparationContinuity(
  preparations: Readonly<
    Record<string, DurableOptimizationPreparation>
  >,
): void {
  const discoveryPairs = new Map<
    string,
    {
      first: DurableOptimizationPreparation | null;
      second: DurableOptimizationPreparation | null;
    }
  >();
  const claims = new Set<string>();
  const experimentKeys = new Set<string>();
  for (const preparation of Object.values(preparations)) {
    const experimentKey = canonicalHash({
      campaignId: preparation.context.campaignId,
      lineageId: preparation.context.lineageId,
      protocolHash: preparation.context.protocolHash,
      experimentNumber: preparation.context.experimentNumber,
    });
    if (experimentKeys.has(experimentKey)) fail();
    experimentKeys.add(experimentKey);
    if (preparation.claimBinding !== null) {
      if (claims.has(preparation.claimBinding.claimHash)) fail();
      claims.add(preparation.claimBinding.claimHash);
    }
    const discovery = preparation.discovery;
    if (discovery === null) continue;
    const key = canonicalHash({
      campaignId: discovery.campaignId,
      lineageId: discovery.lineageId,
      protocolHash: discovery.protocolHash,
      previousDiscoveryAttestationHash:
        discovery.previousDiscoveryAttestationHash,
    });
    const pair = discoveryPairs.get(key) ?? {
      first: null,
      second: null,
    };
    if (discovery.repairAttemptOrdinal === 1) {
      if (pair.first !== null) fail();
      pair.first = preparation;
    } else {
      if (pair.second !== null) fail();
      pair.second = preparation;
    }
    discoveryPairs.set(key, pair);
  }
  for (const pair of discoveryPairs.values()) {
    if (pair.second === null) continue;
    if (pair.first === null) fail();
    const first = pair.first;
    const second = pair.second;
    const firstDiscovery = first.discovery;
    const secondDiscovery = second.discovery;
    if (
      firstDiscovery === null ||
      secondDiscovery === null ||
      first.claimBinding === null ||
      secondDiscovery.priorAllocationStateHash !==
        first.context.allocationStateHash ||
      secondDiscovery.priorClaimHash !==
        first.claimBinding.claimHash ||
      second.context.experimentNumber !==
        first.context.experimentNumber + 1 ||
      second.context.priorStateHash ===
        first.context.allocationStateHash ||
      first.input.activeChampion.activeCommit !==
        second.input.activeChampion.activeCommit ||
      first.input.experiment.parentExperiment !==
        second.input.experiment.parentExperiment ||
      firstDiscovery.diagnosticBindingHash !==
        secondDiscovery.diagnosticBindingHash ||
      canonicalJson(firstDiscovery.diagnosticBrief) !==
        canonicalJson(secondDiscovery.diagnosticBrief)
    ) {
      fail();
    }
  }
}

export function assertDurableOptimizationCoordinationState(
  value: unknown,
  expectedStoreScopeHash?: string,
): asserts value is DurableOptimizationCoordinationState {
  assertExactKeys(value, [
    "schemaVersion",
    "sensitivity",
    "storeScopeHash",
    "revision",
    "preparations",
    "resumePaths",
    "interruptions",
    "activeInterruptions",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.sensitivity !==
      "trusted-optimization-coordination" ||
    typeof value.storeScopeHash !== "string" ||
    !SHA256.test(value.storeScopeHash) ||
    (expectedStoreScopeHash !== undefined &&
      value.storeScopeHash !== expectedStoreScopeHash) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !isPlainRecord(value.preparations) ||
    !isPlainRecord(value.resumePaths) ||
    !isPlainRecord(value.interruptions) ||
    !isPlainRecord(value.activeInterruptions)
  ) {
    fail();
  }
  const state =
    value as unknown as DurableOptimizationCoordinationState;
  for (const [key, preparation] of Object.entries(
    state.preparations,
  )) {
    assertPreparation(key, preparation);
  }
  assertPreparationContinuity(state.preparations);

  const authorityAttestations = new Set<string>();
  for (const preparation of Object.values(
    state.preparations,
  )) {
    if (preparation.discovery !== null) {
      const hash =
        preparation.discovery.resolutionAttestationHash;
      if (authorityAttestations.has(hash)) fail();
      authorityAttestations.add(hash);
    }
  }

  for (const [key, resume] of Object.entries(
    state.resumePaths,
  )) {
    assertResumeRecord(key, resume);
    for (const attestation of resume.verificationHistory) {
      const hash = attestation.authorizationAttestationHash;
      if (authorityAttestations.has(hash)) fail();
      authorityAttestations.add(hash);
    }
  }

  const expectedActive: Record<string, string> = {};
  for (const [key, interruption] of Object.entries(
    state.interruptions,
  )) {
    assertInterruptionEntry(key, interruption);
    const hashes = [
      interruption.brokerExposureAuthorizationAttestationHash,
      interruption.controlPreparation
        ?.authorizationAttestationHash,
    ].filter((item): item is string => item !== undefined);
    for (const hash of hashes) {
      if (authorityAttestations.has(hash)) fail();
      authorityAttestations.add(hash);
    }
    if (interruption.finalStateHash === null) {
      const scope = interruptionScope(interruption.record);
      if (expectedActive[scope] !== undefined) fail();
      expectedActive[scope] = interruption.record.recordHash;
    }
  }
  for (const [scope, recordHash] of Object.entries(
    state.activeInterruptions,
  )) {
    assertHash(scope);
    assertHash(recordHash);
  }
  if (
    canonicalJson(state.activeInterruptions) !==
    canonicalJson(expectedActive)
  ) {
    fail();
  }

  const expectedRevision =
    Object.values(state.preparations).reduce(
      (count, preparation) =>
        count + 1 + (preparation.claimBinding === null ? 0 : 1),
      0,
    ) +
    Object.values(state.resumePaths).reduce(
      (count, path) =>
        count + path.verificationHistory.length,
      0,
    ) +
    Object.values(state.interruptions).reduce(
      (count, interruption) =>
        count +
        1 +
        (interruption.controlPreparation === null ? 0 : 1) +
        (interruption.finalStateHash === null ? 0 : 1),
      0,
    );
  if (state.revision !== expectedRevision) fail();
}

export function emptyOptimizationCoordinationState(
  storeScopeHash: string,
): DurableOptimizationCoordinationState {
  assertHash(storeScopeHash);
  return {
    schemaVersion: 1,
    sensitivity: "trusted-optimization-coordination",
    storeScopeHash,
    revision: 0,
    preparations: {},
    resumePaths: {},
    interruptions: {},
    activeInterruptions: {},
  };
}

function storeScopeHash(storeId: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(storeId)
  ) {
    fail();
  }
  return canonicalHash({
    domain:
      "dark-factory.optimization-coordination-store-scope.v1",
    storeId,
  });
}

/**
 * Fenced mounted-volume state shared by the production input, resume, and
 * interruption ports. A single instance must be shared by all three ports so
 * one campaign has one writer fence and one linearized revision sequence.
 */
export class MountedVolumeAtomicOptimizationCoordinationStateStore
  implements AtomicOptimizationCoordinationStateStore
{
  readonly #store: MountedVolumeTransactionalJsonStore<DurableOptimizationCoordinationState>;

  public constructor(options: MountedVolumeDurableStateOptions) {
    const scope = storeScopeHash(options.storeId);
    this.#store =
      new MountedVolumeTransactionalJsonStore<DurableOptimizationCoordinationState>(
        options,
        `optimization-coordination-${options.storeId}`,
        {
          domain:
            "dark-factory.optimization-coordination-state.v1",
          initialState: () =>
            emptyOptimizationCoordinationState(scope),
          assertState(
            value,
          ): asserts value is DurableOptimizationCoordinationState {
            assertDurableOptimizationCoordinationState(
              value,
              scope,
            );
          },
          revision: (state) => state.revision,
        },
      );
  }

  public transact<Result>(
    operation: (state: DurableOptimizationCoordinationState) => {
      readonly next: DurableOptimizationCoordinationState;
      readonly result: Result;
    },
  ): Promise<Result> {
    return this.#store.transact(operation);
  }

  public close(): Promise<void> {
    return this.#store.close();
  }
}

function createExperimentInput(
  context: OptimizationInputPreparationContext,
  discovery: TaskFreeOptimizationDiagnosticDiscovery | null,
): ExperimentRunInput {
  const input: ExperimentRunInput = {
    experiment: {
      number: context.experimentNumber,
      slug: context.sourceOnlyBootstrap
        ? "source-only-bootstrap"
        : "diagnostic-repair",
      kind: "optimization",
      parentExperiment:
        context.allocationSnapshot.activeChampion.activeExperiment,
      lineageId: context.lineageId,
      protocolHash: context.protocolHash,
    },
    activeChampion:
      context.allocationSnapshot.activeChampion,
    budget: context.allocationSnapshot.budget,
    diagnosticBrief: discovery?.diagnosticBrief ?? null,
    previousDiscoveryAttestationHash:
      discovery?.previousDiscoveryAttestationHash ?? null,
    repairAttemptOrdinal:
      discovery?.repairAttemptOrdinal ?? 1,
    stop: { requested: false },
  };
  const cloned = cloneJson(input);
  assertExperimentRunInput(cloned);
  assertInputMatchesContext(cloned, context, discovery);
  return cloned;
}

function samePreparationRequest(
  existing: DurableOptimizationPreparation,
  context: OptimizationInputPreparationContext,
): boolean {
  return (
    existing.contextHash === canonicalHash(context) &&
    canonicalJson(existing.context) === canonicalJson(context)
  );
}

function assertNewDiscoveryContinuity(
  state: DurableOptimizationCoordinationState,
  context: OptimizationInputPreparationContext,
  discovery: TaskFreeOptimizationDiagnosticDiscovery | null,
): void {
  if (context.sourceOnlyBootstrap) {
    if (discovery !== null) fail();
    return;
  }
  if (discovery === null) fail();
  const sameDiscovery = Object.values(
    state.preparations,
  ).filter(
    (entry) =>
      entry.discovery !== null &&
      entry.context.campaignId === context.campaignId &&
      entry.context.lineageId === context.lineageId &&
      entry.context.protocolHash === context.protocolHash &&
      entry.discovery.previousDiscoveryAttestationHash ===
        discovery.previousDiscoveryAttestationHash,
  );
  if (discovery.repairAttemptOrdinal === 1) {
    if (sameDiscovery.length !== 0) fail();
    return;
  }
  if (sameDiscovery.length !== 1) fail();
  const first = sameDiscovery[0];
  if (
    first === undefined ||
    first.discovery === null ||
    first.discovery.repairAttemptOrdinal !== 1 ||
    first.claimBinding === null ||
    first.context.experimentNumber + 1 !==
      context.experimentNumber ||
    discovery.priorAllocationStateHash !==
      first.context.allocationStateHash ||
    discovery.priorClaimHash !==
      first.claimBinding.claimHash ||
    discovery.diagnosticBindingHash !==
      first.discovery.diagnosticBindingHash ||
    canonicalJson(discovery.diagnosticBrief) !==
      canonicalJson(first.discovery.diagnosticBrief) ||
    context.allocationSnapshot.activeChampion.activeCommit !==
      first.context.allocationSnapshot.activeChampion.activeCommit ||
    context.allocationSnapshot.activeChampion.activeExperiment !==
      first.context.allocationSnapshot.activeChampion.activeExperiment
  ) {
    fail();
  }
}

export interface DurableTrustedOptimizationInputFactoryOptions {
  readonly state: AtomicOptimizationCoordinationStateStore;
  readonly diagnosticResolver:
    TrustedTaskFreeOptimizationDiagnosticResolver;
}

/**
 * Produces the optimizer's task-free input exactly once per allocation. The
 * resolver is never called again after a committed preparation, so authority
 * nondeterminism cannot change an already-issued claim after a restart.
 */
export class DurableTrustedOptimizationInputFactory
  implements TrustedOptimizationInputFactory
{
  readonly boundary = "trusted-cloud" as const;
  readonly #state: AtomicOptimizationCoordinationStateStore;
  readonly #resolver: TrustedTaskFreeOptimizationDiagnosticResolver;

  public constructor(
    options: DurableTrustedOptimizationInputFactoryOptions,
  ) {
    if (
      options.diagnosticResolver.boundary !== "trusted-cloud"
    ) {
      fail();
    }
    this.#state = options.state;
    this.#resolver = Object.freeze({
      boundary: "trusted-cloud" as const,
      resolve:
        options.diagnosticResolver.resolve.bind(
          options.diagnosticResolver,
        ),
    });
  }

  async #readExisting(
    context: OptimizationInputPreparationContext,
  ): Promise<ExperimentRunInput | null> {
    return this.#state.transact((state) => {
      const existing =
        state.preparations[context.allocationStateHash];
      if (existing === undefined) {
        return { next: state, result: null };
      }
      if (!samePreparationRequest(existing, context)) fail();
      return {
        next: state,
        result: cloneJson(existing.input),
      };
    });
  }

  public async prepareOrResume(
    rawContext: OptimizationInputPreparationContext,
  ): Promise<ExperimentRunInput> {
    const context = cloneJson(rawContext);
    assertPreparationContext(context);
    const existing = await this.#readExisting(context);
    if (existing !== null) return existing;

    const discovery = context.sourceOnlyBootstrap
      ? null
      : cloneJson(await this.#resolver.resolve(context));
    if (discovery !== null) {
      assertDiagnosticDiscovery(discovery, context);
    }
    const input = createExperimentInput(context, discovery);
    const candidate: DurableOptimizationPreparation = {
      contextHash: canonicalHash(context),
      context,
      inputHash: canonicalHash(input),
      input,
      discovery,
      claimBinding: null,
    };
    return this.#state.transact((state) => {
      const concurrent =
        state.preparations[context.allocationStateHash];
      if (concurrent !== undefined) {
        if (
          !samePreparationRequest(concurrent, context) ||
          canonicalJson(concurrent) !==
            canonicalJson(candidate)
        ) {
          fail();
        }
        return {
          next: state,
          result: cloneJson(concurrent.input),
        };
      }
      assertNewDiscoveryContinuity(
        state,
        context,
        discovery,
      );
      const next: DurableOptimizationCoordinationState = {
        ...state,
        revision: state.revision + 1,
        preparations: {
          ...state.preparations,
          [context.allocationStateHash]: candidate,
        },
      };
      assertDurableOptimizationCoordinationState(
        next,
        state.storeScopeHash,
      );
      return { next, result: cloneJson(input) };
    });
  }

  public async bindClaim(
    rawBinding: PersistedOptimizationClaimBinding,
  ): Promise<void> {
    const binding = cloneJson(rawBinding);
    assertClaimBinding(binding);
    await this.#state.transact((state) => {
      const preparation =
        state.preparations[binding.allocationStateHash];
      if (preparation === undefined) fail();
      const candidate: DurableOptimizationPreparation = {
        ...preparation,
        claimBinding: binding,
      };
      assertPreparation(
        binding.allocationStateHash,
        candidate,
      );
      if (preparation.claimBinding !== null) {
        if (
          canonicalJson(preparation.claimBinding) !==
          canonicalJson(binding)
        ) {
          fail();
        }
        return { next: state, result: undefined };
      }
      if (
        Object.values(state.preparations).some(
          (entry) =>
            entry.claimBinding?.claimHash === binding.claimHash,
        )
      ) {
        fail();
      }
      const next: DurableOptimizationCoordinationState = {
        ...state,
        revision: state.revision + 1,
        preparations: {
          ...state.preparations,
          [binding.allocationStateHash]: candidate,
        },
      };
      assertDurableOptimizationCoordinationState(
        next,
        state.storeScopeHash,
      );
      return { next, result: undefined };
    });
  }
}

function assertSameResumeBase(
  existing: OptimizationResumeVerification,
  candidate: OptimizationResumeVerification,
): void {
  const base = (path: OptimizationResumeVerification) => ({
    schemaVersion: path.schemaVersion,
    domain: path.domain,
    campaignId: path.campaignId,
    lineageId: path.lineageId,
    protocolHash: path.protocolHash,
    experimentNumber: path.experimentNumber,
    priorStateHash: path.priorStateHash,
    allocationStateHash: path.allocationStateHash,
  });
  if (canonicalJson(base(existing)) !== canonicalJson(base(candidate))) {
    fail();
  }
}

function assertStrictResumeExtension(
  existing: DurableOptimizationResumePath,
  candidate: OptimizationResumeVerification,
): void {
  assertSameResumeBase(existing.path, candidate);
  if (
    candidate.checkpoints.length <=
      existing.path.checkpoints.length ||
    canonicalJson(
      candidate.checkpoints.slice(
        0,
        existing.path.checkpoints.length,
      ),
    ) !== canonicalJson(existing.path.checkpoints)
  ) {
    fail();
  }
}

export interface AttestedTrustedOptimizationResumeVerifierOptions {
  readonly state: AtomicOptimizationCoordinationStateStore;
  readonly authority:
    TrustedOptimizationResumeAttestationAuthority;
}

/**
 * Checks the public CampaignState checkpoint chain before delegating
 * signature/key authorization. Only strict path extensions are committed;
 * rollback, fork, truncation, and cross-allocation replay fail closed.
 */
export class AttestedTrustedOptimizationResumeVerifier
  implements TrustedOptimizationResumeVerifier
{
  readonly boundary = "trusted-cloud" as const;
  readonly #state: AtomicOptimizationCoordinationStateStore;
  readonly #authority: TrustedOptimizationResumeAttestationAuthority;

  public constructor(
    options: AttestedTrustedOptimizationResumeVerifierOptions,
  ) {
    if (
      options.authority.boundary !==
      "trusted-cloud-attestation-authority"
    ) {
      fail();
    }
    this.#state = options.state;
    this.#authority = Object.freeze({
      boundary:
        "trusted-cloud-attestation-authority" as const,
      verifyAndAttest:
        options.authority.verifyAndAttest.bind(
          options.authority,
        ),
    });
  }

  async #alreadyVerified(
    path: OptimizationResumeVerification,
  ): Promise<boolean> {
    return this.#state.transact((state) => {
      const existing =
        state.resumePaths[path.allocationStateHash];
      if (existing === undefined) {
        return { next: state, result: false };
      }
      assertSameResumeBase(existing.path, path);
      if (
        existing.pathHash === canonicalHash(path) &&
        canonicalJson(existing.path) === canonicalJson(path)
      ) {
        return { next: state, result: true };
      }
      assertStrictResumeExtension(existing, path);
      return { next: state, result: false };
    });
  }

  public async verify(
    rawPath: OptimizationResumeVerification,
  ): Promise<void> {
    const path = cloneJson(rawPath);
    assertResumePath(path);
    if (await this.#alreadyVerified(path)) return;

    const attestation = cloneJson(
      await this.#authority.verifyAndAttest(path),
    );
    assertResumeAttestation(attestation, path);
    await this.#state.transact((state) => {
      const existing =
        state.resumePaths[path.allocationStateHash];
      if (
        existing !== undefined &&
        existing.pathHash === canonicalHash(path) &&
        canonicalJson(existing.path) === canonicalJson(path)
      ) {
        return { next: state, result: undefined };
      }
      if (existing !== undefined) {
        assertStrictResumeExtension(existing, path);
      }
      const record: DurableOptimizationResumePath = {
        path,
        pathHash: canonicalHash(path),
        checkpointChainHash:
          optimizationResumeCheckpointChainHash(path),
        verificationHistory: [
          ...(existing?.verificationHistory ?? []),
          attestation,
        ],
      };
      assertResumeRecord(path.allocationStateHash, record);
      const next: DurableOptimizationCoordinationState = {
        ...state,
        revision: state.revision + 1,
        resumePaths: {
          ...state.resumePaths,
          [path.allocationStateHash]: record,
        },
      };
      assertDurableOptimizationCoordinationState(
        next,
        state.storeScopeHash,
      );
      return { next, result: undefined };
    });
  }
}

export interface DurableTrustedOptimizationInterruptionPortOptions {
  readonly state: AtomicOptimizationCoordinationStateStore;
  readonly authority: TrustedOptimizationInterruptionAuthority;
}

/**
 * Linearizes interruption intent, broker-exposure accounting, authorized
 * control preparation, and the final CampaignState CAS result. Public records
 * remain task-free and survive controller handoff on the mounted volume.
 */
export class DurableTrustedOptimizationInterruptionPort
  implements TrustedOptimizationInterruptionPort
{
  readonly boundary = "trusted-cloud" as const;
  readonly #state: AtomicOptimizationCoordinationStateStore;
  readonly #authority: TrustedOptimizationInterruptionAuthority;

  public constructor(
    options: DurableTrustedOptimizationInterruptionPortOptions,
  ) {
    if (
      options.authority.boundary !==
      "trusted-cloud-attestation-authority"
    ) {
      fail();
    }
    this.#state = options.state;
    this.#authority = Object.freeze({
      boundary:
        "trusted-cloud-attestation-authority" as const,
      attestBrokerExposure:
        options.authority.attestBrokerExposure.bind(
          options.authority,
        ),
      authorizeControl:
        options.authority.authorizeControl.bind(
          options.authority,
        ),
    });
  }

  async #findExistingForDraft(
    draft: Omit<
      OptimizationInterruptionRecordDraft,
      "brokerExposureStateAttestationHash"
    >,
  ): Promise<OptimizationInterruptionRecord | null> {
    return this.#state.transact((state) => {
      const scope = interruptionScope(draft);
      const activeHash = state.activeInterruptions[scope];
      if (activeHash === undefined) {
        const applied = Object.values(
          state.interruptions,
        ).find(
          (entry) =>
            canonicalJson(draftWithoutExposure(entry.record)) ===
            canonicalJson(draft),
        );
        if (applied !== undefined) fail();
        return { next: state, result: null };
      }
      const entry = state.interruptions[activeHash];
      if (
        entry === undefined ||
        canonicalJson(draftWithoutExposure(entry.record)) !==
          canonicalJson(draft)
      ) {
        fail();
      }
      return {
        next: state,
        result: cloneJson(entry.record),
      };
    });
  }

  public async begin(
    rawDraft: Omit<
      OptimizationInterruptionRecordDraft,
      "brokerExposureStateAttestationHash"
    >,
  ): Promise<OptimizationInterruptionRecord> {
    const draft = cloneJson(rawDraft);
    assertInterruptionDraft(draft);
    const existing = await this.#findExistingForDraft(draft);
    if (existing !== null) return existing;

    const exposure = cloneJson(
      await this.#authority.attestBrokerExposure(draft),
    );
    assertBrokerExposureAttestation(exposure, draft);
    const recordDraftValue: OptimizationInterruptionRecordDraft = {
      ...draft,
      brokerExposureStateAttestationHash:
        exposure.brokerExposureStateAttestationHash,
    };
    const record: OptimizationInterruptionRecord = {
      ...recordDraftValue,
      recordHash: canonicalHash(recordDraftValue),
    };
    assertInterruptionRecord(record);

    return this.#state.transact((state) => {
      const scope = interruptionScope(draft);
      const concurrentHash =
        state.activeInterruptions[scope];
      if (concurrentHash !== undefined) {
        const concurrent =
          state.interruptions[concurrentHash];
        if (
          concurrent === undefined ||
          canonicalJson(concurrent.record) !==
            canonicalJson(record)
        ) {
          fail();
        }
        return {
          next: state,
          result: cloneJson(concurrent.record),
        };
      }
      if (
        state.interruptions[record.recordHash] !== undefined ||
        Object.values(state.interruptions).some(
          (entry) =>
            entry.brokerExposureAuthorizationAttestationHash ===
            exposure.authorizationAttestationHash,
        )
      ) {
        fail();
      }
      const entry: DurableOptimizationInterruption = {
        record,
        brokerExposureAuthorizationAttestationHash:
          exposure.authorizationAttestationHash,
        controlPreparation: null,
        finalStateHash: null,
      };
      const next: DurableOptimizationCoordinationState = {
        ...state,
        revision: state.revision + 1,
        interruptions: {
          ...state.interruptions,
          [record.recordHash]: entry,
        },
        activeInterruptions: {
          ...state.activeInterruptions,
          [scope]: record.recordHash,
        },
      };
      assertDurableOptimizationCoordinationState(
        next,
        state.storeScopeHash,
      );
      return { next, result: cloneJson(record) };
    });
  }

  public async findPending(input: {
    readonly campaignId: string;
    readonly lineageId: string;
    readonly protocolHash: string;
    readonly currentStateHash: string;
  }): Promise<OptimizationInterruptionRecord | null> {
    const query = cloneJson(input);
    assertExactKeys(query, [
      "campaignId",
      "lineageId",
      "protocolHash",
      "currentStateHash",
    ]);
    assertSafeId(query.campaignId);
    assertSafeId(query.lineageId);
    assertHash(query.protocolHash);
    assertHash(query.currentStateHash);
    return this.#state.transact((state) => {
      const recordHash =
        state.activeInterruptions[
          interruptionScope(query)
        ];
      if (recordHash === undefined) {
        return { next: state, result: null };
      }
      const entry = state.interruptions[recordHash];
      if (
        entry === undefined ||
        entry.finalStateHash !== null
      ) {
        fail();
      }
      return {
        next: state,
        result: cloneJson(entry.record),
      };
    });
  }

  public async prepareControl(input: {
    readonly record: OptimizationInterruptionRecord;
    readonly currentStateHash: string;
  }): Promise<OptimizationInterruptionControl> {
    const request = cloneJson(input);
    assertExactKeys(request, ["record", "currentStateHash"]);
    assertInterruptionRecord(request.record);
    assertHash(request.currentStateHash);
    const existing = await this.#state.transact((state) => {
      const entry =
        state.interruptions[request.record.recordHash];
      if (
        entry === undefined ||
        entry.finalStateHash !== null ||
        canonicalJson(entry.record) !==
          canonicalJson(request.record)
      ) {
        fail();
      }
      if (entry.controlPreparation === null) {
        return { next: state, result: null };
      }
      if (
        entry.controlPreparation.currentStateHash !==
        request.currentStateHash
      ) {
        fail();
      }
      return {
        next: state,
        result: cloneJson(entry.controlPreparation.control),
      };
    });
    if (existing !== null) return existing;

    const authorization = cloneJson(
      await this.#authority.authorizeControl(request),
    );
    assertControlAuthorization(
      authorization,
      request.record,
      request.currentStateHash,
    );
    return this.#state.transact((state) => {
      const entry =
        state.interruptions[request.record.recordHash];
      if (
        entry === undefined ||
        entry.finalStateHash !== null ||
        canonicalJson(entry.record) !==
          canonicalJson(request.record)
      ) {
        fail();
      }
      if (entry.controlPreparation !== null) {
        if (
          entry.controlPreparation.currentStateHash !==
            request.currentStateHash ||
          canonicalJson(entry.controlPreparation.control) !==
            canonicalJson(authorization.control)
        ) {
          fail();
        }
        return {
          next: state,
          result: cloneJson(entry.controlPreparation.control),
        };
      }
      const preparation: DurableOptimizationControlPreparation = {
        currentStateHash: request.currentStateHash,
        control: authorization.control,
        controlHash: authorization.controlHash,
        authorizationAttestationHash:
          authorization.authorizationAttestationHash,
      };
      const nextEntry: DurableOptimizationInterruption = {
        ...entry,
        controlPreparation: preparation,
      };
      const next: DurableOptimizationCoordinationState = {
        ...state,
        revision: state.revision + 1,
        interruptions: {
          ...state.interruptions,
          [request.record.recordHash]: nextEntry,
        },
      };
      assertDurableOptimizationCoordinationState(
        next,
        state.storeScopeHash,
      );
      return {
        next,
        result: cloneJson(authorization.control),
      };
    });
  }

  public async markApplied(input: {
    readonly recordHash: string;
    readonly finalStateHash: string;
  }): Promise<void> {
    const request = cloneJson(input);
    assertExactKeys(request, [
      "recordHash",
      "finalStateHash",
    ]);
    assertHash(request.recordHash);
    assertHash(request.finalStateHash);
    await this.#state.transact((state) => {
      const entry = state.interruptions[request.recordHash];
      if (
        entry === undefined ||
        entry.controlPreparation === null
      ) {
        fail();
      }
      if (entry.finalStateHash !== null) {
        if (
          entry.finalStateHash !== request.finalStateHash
        ) {
          fail();
        }
        return { next: state, result: undefined };
      }
      if (
        request.finalStateHash ===
        entry.controlPreparation.currentStateHash
      ) {
        fail();
      }
      const scope = interruptionScope(entry.record);
      if (
        state.activeInterruptions[scope] !==
        request.recordHash
      ) {
        fail();
      }
      const active = { ...state.activeInterruptions };
      delete active[scope];
      const nextEntry: DurableOptimizationInterruption = {
        ...entry,
        finalStateHash: request.finalStateHash,
      };
      const next: DurableOptimizationCoordinationState = {
        ...state,
        revision: state.revision + 1,
        interruptions: {
          ...state.interruptions,
          [request.recordHash]: nextEntry,
        },
        activeInterruptions: active,
      };
      assertDurableOptimizationCoordinationState(
        next,
        state.storeScopeHash,
      );
      return { next, result: undefined };
    });
  }
}

export interface MountedVolumeOptimizationCoordinationPortsOptions {
  readonly durableState: MountedVolumeDurableStateOptions;
  readonly diagnosticResolver:
    TrustedTaskFreeOptimizationDiagnosticResolver;
  readonly resumeAuthority:
    TrustedOptimizationResumeAttestationAuthority;
  readonly interruptionAuthority:
    TrustedOptimizationInterruptionAuthority;
}

/**
 * Convenience owner that guarantees all three coordinator ports share one
 * fenced state instance. close() performs the clean controller handoff.
 */
export class MountedVolumeOptimizationCoordinationPorts {
  readonly inputFactory: TrustedOptimizationInputFactory;
  readonly resumeVerifier: TrustedOptimizationResumeVerifier;
  readonly interruption: TrustedOptimizationInterruptionPort;
  readonly #state: MountedVolumeAtomicOptimizationCoordinationStateStore;

  public constructor(
    options: MountedVolumeOptimizationCoordinationPortsOptions,
  ) {
    this.#state =
      new MountedVolumeAtomicOptimizationCoordinationStateStore(
        options.durableState,
      );
    this.inputFactory =
      new DurableTrustedOptimizationInputFactory({
        state: this.#state,
        diagnosticResolver: options.diagnosticResolver,
      });
    this.resumeVerifier =
      new AttestedTrustedOptimizationResumeVerifier({
        state: this.#state,
        authority: options.resumeAuthority,
      });
    this.interruption =
      new DurableTrustedOptimizationInterruptionPort({
        state: this.#state,
        authority: options.interruptionAuthority,
      });
  }

  public close(): Promise<void> {
    return this.#state.close();
  }
}
