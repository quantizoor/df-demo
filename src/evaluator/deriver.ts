import {
  evaluateFreshValidation,
  evaluateRepairGate,
  evaluateShadowCertification,
  type FreshValidationPair,
  type RepairTaskEvidence,
} from "../evaluation/gates.js";
import {
  extractBehaviorSummary,
  normalizeGraderOutcome,
  type BehaviorSummary,
  type RawTrajectory,
  type ScalarGraderOutcomeInput,
} from "../evaluation/behavior.js";
import type {
  BehaviorComparison,
  PrivateBehaviorObservation,
} from "../evaluation/privacy.js";
import type {
  HiddenTaskId,
  SelectionBucket,
} from "../evaluation/types.js";
import type { OnlineErrorBudgetState } from "../evaluation/statistics.js";
import type {
  TrustedCanonicalAggregate,
  TrustedCanonicalEvaluationDeriver,
} from "../broker/service.js";
import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import type {
  PolicyVersions,
  Signature,
} from "../schemas/primitives.js";
import type {
  NormalizedGraderOutcome,
  SignedResultEnvelope,
} from "../schemas/trusted.js";
import { assertSafeForLocalPersistence } from "./retention.js";
import {
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "./contracts.js";
import {
  assertTrustedOnlineErrorBudgetReservation,
  type TrustedOnlineErrorBudgetReservation,
} from "./online-error-authority.js";
import {
  hashTrustedBehavioralPreparation,
  type TrustedBehavioralPreparationStore,
} from "./behavioral-preparation-store.js";
import type { TrustedRawRun } from "../terminal-bench/runner.js";
import type {
  MatchedArmKind,
  MatchedArmOrder,
  TrustedMatchedArm,
  TrustedMatchedArmSchedule,
  TrustedMatchedPanel,
} from "../terminal-bench/trusted.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_DECODED_ATTEMPTS = 32;
const MAX_TRAJECTORY_EVENTS = 20_000;
const MAX_RELEASE_LITERAL_COUNT = 4_096;

type AggregateCost = SignedResultEnvelope["payload"]["aggregateCost"];

export interface TrustedDecodedAttemptCost {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelUsd: number;
  readonly sandboxUsd: number;
}

export interface TrustedDecodedEvaluationAttempt {
  readonly sensitivity: "trusted-decoded-evaluation-attempt";
  readonly attemptDigest: string;
  readonly scheduleArmId: string;
  readonly taskId: HiddenTaskId;
  readonly taskRevisionDigest: string;
  readonly capabilityStratum: string;
  readonly arm: MatchedArmKind;
  readonly order: MatchedArmOrder;
  readonly harnessArchiveSha256: string;
  readonly attemptOrdinal: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly grader: ScalarGraderOutcomeInput;
  readonly atif: RawTrajectory;
  readonly cost: TrustedDecodedAttemptCost;
}

/**
 * This object may exist only inside the trusted evaluator. It deliberately
 * contains opaque hidden task IDs so decoded Harbor, ATIF, and grader records
 * can be joined and checked before aggregation.
 */
export interface TrustedDecodedEvaluation {
  readonly sensitivity: "trusted-decoded-evaluation";
  readonly requestId: string;
  readonly jobSha256: string;
  readonly runtimeAttestationHash: string;
  readonly rawManifestHash: string;
  readonly rawArtifactSetHash: string;
  readonly attempts: readonly TrustedDecodedEvaluationAttempt[];
}

export interface TrustedDecodedEvaluationReader {
  decode(rawRun: TrustedRawRun): Promise<TrustedDecodedEvaluation>;
}

export interface TrustedRepairControl {
  readonly taskId: HiddenTaskId;
  readonly bucket: SelectionBucket;
  readonly championEvidence: {
    readonly source: "fresh" | "cache";
    readonly passes: number;
    readonly failures: number;
    readonly presealedFreshControl: boolean;
  };
  readonly targetBehaviorImproved: boolean;
}

export interface TrustedBehavioralExtractionPolicy {
  readonly diagnosticsEnabled: boolean;
  readonly comparison: BehaviorComparison;
  readonly maximumPrivacyReleases: number;
  readonly diagnosticTtlMs: number;
  readonly policyVersions: PolicyVersions;
}

/**
 * Task-private, outcome-derived preparation. It may exist only inside the
 * trusted evaluator boundary and its durable private preparation store. It is
 * never a release-safe artifact.
 */
export interface TrustedPrivateBehavioralPreparation {
  readonly sensitivity: "trusted-private-behavioral-preparation";
  readonly requestHash: string;
  readonly protocolHash: string;
  readonly experimentNumber: number;
  readonly behaviorSourceSetHash: string;
  readonly analysisWindow: {
    readonly openedAt: string;
    readonly closedAt: string;
  };
  readonly observations: readonly PrivateBehaviorObservation[];
  readonly policy: TrustedBehavioralExtractionPolicy;
  readonly forbiddenReleaseLiterals: readonly string[];
  readonly forbiddenContentFingerprints: readonly string[];
  readonly graderCanaryFingerprints: readonly string[];
}

export interface TrustedCanonicalDerivationPolicy {
  readonly sensitivity: "trusted-canonical-derivation-policy";
  readonly requestHash: string;
  readonly protocolHash: string;
  readonly dispositionAttestationHash: string;
  readonly expectedEnvironmentFingerprintHash: string;
  readonly cacheAttestationHash: string;
  readonly cacheEvidenceSetHash: string;
  readonly policyAttestationHash: string;
  readonly candidateFrozenAt: string;
  readonly presealedStratumWeights: Readonly<Record<string, number>>;
  readonly onlineErrorBudget: OnlineErrorBudgetState;
  readonly onlineErrorReservation: TrustedOnlineErrorBudgetReservation | null;
  readonly integrationPoints: number;
  readonly replacementAttemptCeiling: number;
  readonly repair: {
    readonly alternatingBucket: "easy" | "coverage";
    readonly attemptOrdinal: 1 | 2;
    readonly controls: readonly TrustedRepairControl[];
  } | null;
  readonly guardrails: {
    readonly externalIntegrityVeto: boolean;
    readonly correctnessVeto: boolean;
    readonly capabilityVeto: boolean;
    readonly costWithinGuardrail: boolean;
    readonly latencyWithinGuardrail: boolean;
    readonly accuracyTradeoffPredeclared: boolean;
    readonly complianceFlagsPassed: boolean;
  };
  readonly behavioralPolicy: TrustedBehavioralExtractionPolicy;
  readonly forbiddenReleaseLiterals: readonly string[];
  readonly forbiddenContentFingerprints: readonly string[];
  readonly graderCanaryFingerprints: readonly string[];
}

export interface TrustedCanonicalDerivationPolicyResolver {
  resolve(input: {
    readonly request: TrustedEvaluationRequest;
    readonly panel: TrustedMatchedPanel;
    readonly schedule: TrustedMatchedArmSchedule;
    readonly rawRun: TrustedRawRun;
    readonly onlineErrorReservation: TrustedOnlineErrorBudgetReservation | null;
  }): Promise<TrustedCanonicalDerivationPolicy>;
}

export interface DeterministicCanonicalEvaluationDeriverOptions {
  readonly reader: TrustedDecodedEvaluationReader;
  readonly policies: TrustedCanonicalDerivationPolicyResolver;
  readonly hiddenOutcomeSigner: TrustedHiddenCatalogOutcomeUpdateSigner;
  readonly hiddenOutcomeVerifier: TrustedHiddenCatalogOutcomeUpdateVerifier;
  readonly hiddenOutcomeSink: TrustedHiddenCatalogOutcomeUpdateSink;
  readonly behavioralPreparationStore: TrustedBehavioralPreparationStore;
  readonly now?: () => Date;
}

export interface TrustedHiddenCatalogArmOutcome {
  readonly pass: boolean;
  readonly boundedReward: number;
  readonly infrastructureValid: true;
  readonly infrastructureInvalidAttemptCount: number;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelUsd: number;
  readonly sandboxUsd: number;
  readonly finalAttemptDigest: string;
}

export interface TrustedHiddenCatalogTaskOutcome {
  readonly taskId: HiddenTaskId;
  readonly taskRevisionDigest: string;
  readonly capabilityStratum: string;
  readonly order: MatchedArmOrder;
  readonly candidate: TrustedHiddenCatalogArmOutcome;
  readonly champion: TrustedHiddenCatalogArmOutcome | null;
}

export interface UnsignedTrustedHiddenCatalogOutcomeUpdate {
  readonly sensitivity: "trusted-hidden-catalog-outcome-update";
  readonly schemaVersion: 1;
  readonly updateId: string;
  readonly requestHash: string;
  readonly protocolHash: string;
  readonly stage: "repair" | "validation" | "shadow";
  readonly dispositionAttestationHash: string;
  readonly rawManifestHash: string;
  readonly jobSha256: string;
  readonly runtimeAttestationHash: string;
  readonly normalizedOutcomeSetHash: string;
  readonly environmentFingerprintHash: string;
  readonly observedAt: string;
  readonly outcomes: readonly TrustedHiddenCatalogTaskOutcome[];
  readonly updateSetHash: string;
  readonly sourceBindingHash: string;
}

export interface TrustedSignedHiddenCatalogOutcomeUpdate
  extends UnsignedTrustedHiddenCatalogOutcomeUpdate {
  readonly signature: Signature;
}

export type TrustedHiddenCatalogOutcomeSourceBinding = Pick<
  UnsignedTrustedHiddenCatalogOutcomeUpdate,
  | "requestHash"
  | "protocolHash"
  | "stage"
  | "dispositionAttestationHash"
  | "rawManifestHash"
  | "jobSha256"
  | "runtimeAttestationHash"
  | "normalizedOutcomeSetHash"
  | "environmentFingerprintHash"
  | "updateSetHash"
>;

export interface TrustedHiddenCatalogOutcomeUpdateSigner {
  sign(
    update: UnsignedTrustedHiddenCatalogOutcomeUpdate,
  ): Promise<Signature>;
}

export interface TrustedHiddenCatalogOutcomeUpdateVerifier {
  verify(update: TrustedSignedHiddenCatalogOutcomeUpdate): Promise<boolean>;
}

export interface TrustedHiddenCatalogOutcomeCommitReceipt {
  readonly status: "committed" | "already-committed";
  readonly updateId: string;
  readonly sourceBindingHash: string;
}

/**
 * Production implementations perform a durable compare-and-swap keyed by
 * updateId. Repeating an identical source binding is idempotent; the same ID
 * with a different binding must reject rather than return already-committed.
 */
export interface TrustedHiddenCatalogOutcomeUpdateSink {
  commit(
    update: TrustedSignedHiddenCatalogOutcomeUpdate,
  ): Promise<TrustedHiddenCatalogOutcomeCommitReceipt>;
}

export class TrustedCanonicalDeriverError extends Error {
  override readonly name = "TrustedCanonicalDeriverError";
  readonly code:
    | "decode-failed"
    | "policy-failed"
    | "correlation-failed"
    | "normalization-failed"
    | "release-scan-failed";

  constructor(code: TrustedCanonicalDeriverError["code"]) {
    super("Canonical evaluation derivation failed closed.");
    this.code = code;
  }
}

interface NormalizedAttempt {
  readonly source: TrustedDecodedEvaluationAttempt;
  readonly outcome: NormalizedGraderOutcome;
  readonly behavior: BehaviorSummary;
  readonly behaviorHash: string;
}

interface ArmAttemptSet {
  readonly final: NormalizedAttempt;
  readonly invalid: readonly NormalizedAttempt[];
}

function plainObject(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("Canonical trusted input must be a plain object.");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => !expectedKeys.includes(key))
  ) {
    throw new Error("Canonical trusted input has an unexpected field set.");
  }
}

function canonicalTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("Trusted timestamp is not canonical UTC.");
  }
  return parsed;
}

function digest(value: string): void {
  if (!SHA256.test(value)) {
    throw new Error("Trusted digest is malformed.");
  }
}

function finiteNonNegative(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Trusted metric must be finite and non-negative.");
  }
}

function safeCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Trusted count must be a non-negative safe integer.");
  }
}

function assertCost(cost: TrustedDecodedAttemptCost): void {
  plainObject(cost, [
    "inputTokens",
    "outputTokens",
    "modelUsd",
    "sandboxUsd",
  ]);
  safeCount(cost.inputTokens);
  safeCount(cost.outputTokens);
  finiteNonNegative(cost.modelUsd);
  finiteNonNegative(cost.sandboxUsd);
}

function assertTrajectory(trajectory: RawTrajectory): void {
  plainObject(trajectory, [
    "events",
    "elapsedMs",
    "planningTokens",
    "actionTokens",
    "totalTokens",
  ]);
  if (
    !Array.isArray(trajectory.events) ||
    trajectory.events.length > MAX_TRAJECTORY_EVENTS
  ) {
    throw new Error("Decoded ATIF event stream is malformed.");
  }
  finiteNonNegative(trajectory.elapsedMs);
  safeCount(trajectory.planningTokens);
  safeCount(trajectory.actionTokens);
  safeCount(trajectory.totalTokens);
  if (
    trajectory.planningTokens > trajectory.totalTokens ||
    trajectory.actionTokens > trajectory.totalTokens
  ) {
    throw new Error("Decoded ATIF token accounting is inconsistent.");
  }
  for (const event of trajectory.events) {
    if (
      event === null ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      Object.getPrototypeOf(event) !== Object.prototype
    ) {
      throw new Error("Decoded ATIF event must be a plain object.");
    }
    const kind = (event as { readonly kind?: unknown }).kind;
    if (
      kind !== "tool-call" &&
      kind !== "tool-result" &&
      kind !== "output-inspection" &&
      kind !== "plan" &&
      kind !== "replan" &&
      kind !== "recovery" &&
      kind !== "verification" &&
      kind !== "compaction" &&
      kind !== "stop"
    ) {
      throw new Error("Decoded ATIF event kind is not allowlisted.");
    }
  }
}

function assertDecodedAttempt(
  attempt: TrustedDecodedEvaluationAttempt,
): void {
  plainObject(attempt, [
    "sensitivity",
    "attemptDigest",
    "scheduleArmId",
    "taskId",
    "taskRevisionDigest",
    "capabilityStratum",
    "arm",
    "order",
    "harnessArchiveSha256",
    "attemptOrdinal",
    "startedAt",
    "completedAt",
    "grader",
    "atif",
    "cost",
  ]);
  if (
    attempt.sensitivity !== "trusted-decoded-evaluation-attempt" ||
    !SAFE_ID.test(attempt.scheduleArmId) ||
    !SAFE_ID.test(attempt.capabilityStratum) ||
    (attempt.arm !== "candidate" && attempt.arm !== "champion") ||
    (attempt.order !== "AB" && attempt.order !== "BA") ||
    !Number.isSafeInteger(attempt.attemptOrdinal) ||
    attempt.attemptOrdinal < 1
  ) {
    throw new Error("Decoded attempt metadata is malformed.");
  }
  digest(attempt.attemptDigest);
  digest(attempt.taskId);
  digest(attempt.taskRevisionDigest);
  digest(attempt.harnessArchiveSha256);
  const startedAt = canonicalTimestamp(attempt.startedAt);
  const completedAt = canonicalTimestamp(attempt.completedAt);
  if (completedAt < startedAt) {
    throw new Error("Decoded attempt completion precedes its start.");
  }
  plainObject(attempt.grader, [
    "passed",
    "boundedReward",
    "infrastructureInvalidClass",
    "integrityStatus",
    "elapsedMs",
    "cpuUtilizationPercent",
    "maxRssMb",
    "protocolHash",
    "environmentFingerprintHash",
    "oneUseAttemptDigest",
  ]);
  if (
    attempt.grader.oneUseAttemptDigest !== attempt.attemptDigest ||
    attempt.grader.elapsedMs !== completedAt - startedAt
  ) {
    throw new Error("Decoded grader record is detached from its attempt.");
  }
  assertTrajectory(attempt.atif);
  if (attempt.atif.elapsedMs !== attempt.grader.elapsedMs) {
    throw new Error("Decoded ATIF and grader durations disagree.");
  }
  assertCost(attempt.cost);
}

function assertDecodedEvaluation(
  decoded: TrustedDecodedEvaluation,
  rawRun: TrustedRawRun,
): void {
  plainObject(decoded, [
    "sensitivity",
    "requestId",
    "jobSha256",
    "runtimeAttestationHash",
    "rawManifestHash",
    "rawArtifactSetHash",
    "attempts",
  ]);
  if (
    decoded.sensitivity !== "trusted-decoded-evaluation" ||
    decoded.requestId !== rawRun.requestId ||
    decoded.jobSha256 !== rawRun.jobSha256 ||
    decoded.runtimeAttestationHash !== rawRun.runtimeAttestationHash ||
    decoded.rawManifestHash !== rawRun.manifest.manifestHash ||
    decoded.rawArtifactSetHash !== rawRun.manifest.artifactSetHash ||
    !Array.isArray(decoded.attempts) ||
    decoded.attempts.length < 1 ||
    decoded.attempts.length > MAX_DECODED_ATTEMPTS
  ) {
    throw new Error("Decoded evaluation is detached from its raw run.");
  }
  const attemptDigests = new Set<string>();
  for (const attempt of decoded.attempts) {
    assertDecodedAttempt(attempt);
    if (attemptDigests.has(attempt.attemptDigest)) {
      throw new Error("Decoded evaluation reuses an attempt digest.");
    }
    attemptDigests.add(attempt.attemptDigest);
  }
}

function assertOnlineErrorBudget(state: OnlineErrorBudgetState): void {
  plainObject(state, [
    "policyVersion",
    "nullCalibrationId",
    "initialAlpha",
    "remainingAlpha",
    "spentAlpha",
    "gatesSpent",
  ]);
  if (
    state.policyVersion !== "online-alpha-spending-v1" ||
    !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(state.nullCalibrationId) ||
    !(state.initialAlpha > 0 && state.initialAlpha <= 0.05) ||
    !Number.isFinite(state.remainingAlpha) ||
    state.remainingAlpha < 0 ||
    state.remainingAlpha > state.initialAlpha ||
    !Number.isFinite(state.spentAlpha) ||
    state.spentAlpha < 0 ||
    state.spentAlpha > state.initialAlpha ||
    Math.abs(
      state.remainingAlpha + state.spentAlpha - state.initialAlpha,
    ) > 1e-12 ||
    !Number.isSafeInteger(state.gatesSpent) ||
    state.gatesSpent < 0
  ) {
    throw new Error("Online error budget is malformed.");
  }
}

function assertStratumWeights(
  weights: Readonly<Record<string, number>>,
  panel: TrustedMatchedPanel,
): void {
  if (
    weights === null ||
    typeof weights !== "object" ||
    Array.isArray(weights) ||
    Object.getPrototypeOf(weights) !== Object.prototype
  ) {
    throw new Error("Presealed stratum weights must be a plain object.");
  }
  const strata = [...new Set(panel.cells.map((cell) => cell.capabilityStratum))].sort();
  const names = Object.keys(weights).sort();
  if (
    canonicalJson(strata) !== canonicalJson(names) ||
    names.some((name) => {
      const weight = weights[name];
      return weight === undefined || !Number.isFinite(weight) || weight <= 0;
    }) ||
    Math.abs(
      names.reduce((sum, name) => sum + (weights[name] ?? 0), 0) - 1,
    ) > 1e-9
  ) {
    throw new Error("Presealed stratum weights do not exactly cover the panel.");
  }
}

function assertRepairControl(control: TrustedRepairControl): void {
  plainObject(control, [
    "taskId",
    "bucket",
    "championEvidence",
    "targetBehaviorImproved",
  ]);
  digest(control.taskId);
  if (
    control.bucket !== "hard" &&
    control.bucket !== "uncertain" &&
    control.bucket !== "easy" &&
    control.bucket !== "coverage"
  ) {
    throw new Error("Repair control bucket is malformed.");
  }
  plainObject(control.championEvidence, [
    "source",
    "passes",
    "failures",
    "presealedFreshControl",
  ]);
  safeCount(control.championEvidence.passes);
  safeCount(control.championEvidence.failures);
  if (
    (control.championEvidence.source !== "fresh" &&
      control.championEvidence.source !== "cache") ||
    control.championEvidence.passes + control.championEvidence.failures < 1 ||
    (control.championEvidence.source === "fresh" &&
      (control.championEvidence.passes + control.championEvidence.failures !== 1 ||
        !control.championEvidence.presealedFreshControl)) ||
    (control.championEvidence.source === "cache" &&
      control.championEvidence.presealedFreshControl) ||
    typeof control.targetBehaviorImproved !== "boolean"
  ) {
    throw new Error("Repair control evidence is malformed.");
  }
}

export function hashTrustedCacheEvidence(input: {
  readonly requestHash: string;
  readonly dispositionAttestationHash: string;
  readonly repairControls: readonly TrustedRepairControl[];
}): string {
  digest(input.requestHash);
  digest(input.dispositionAttestationHash);
  for (const control of input.repairControls) {
    assertRepairControl(control);
  }
  return canonicalHash({
    domain: "dark-factory.cache-evidence-set.v1",
    requestHash: input.requestHash,
    dispositionAttestationHash: input.dispositionAttestationHash,
    controls: [...input.repairControls]
      .sort((left, right) => left.taskId.localeCompare(right.taskId))
      .map((control) => ({
        taskId: control.taskId,
        bucket: control.bucket,
        championEvidence: control.championEvidence,
        targetBehaviorImproved: control.targetBehaviorImproved,
      })),
  });
}

export function fingerprintForbiddenReleaseLiteral(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (normalized.length < 4) {
    throw new Error("Forbidden release literals must contain at least four characters.");
  }
  return canonicalHash({
    domain: "dark-factory.release-literal-fingerprint.v1",
    literal: normalized,
  });
}

function assertPolicy(
  policy: TrustedCanonicalDerivationPolicy,
  request: TrustedEvaluationRequest,
  panel: TrustedMatchedPanel,
): void {
  plainObject(policy, [
    "sensitivity",
    "requestHash",
    "protocolHash",
    "dispositionAttestationHash",
    "expectedEnvironmentFingerprintHash",
    "cacheAttestationHash",
    "cacheEvidenceSetHash",
    "policyAttestationHash",
    "candidateFrozenAt",
    "presealedStratumWeights",
    "onlineErrorBudget",
    "onlineErrorReservation",
    "integrationPoints",
    "replacementAttemptCeiling",
    "repair",
    "guardrails",
    "behavioralPolicy",
    "forbiddenReleaseLiterals",
    "forbiddenContentFingerprints",
    "graderCanaryFingerprints",
  ]);
  if (
    policy.sensitivity !== "trusted-canonical-derivation-policy" ||
    policy.requestHash !== hashEvaluationRequest(request) ||
    policy.protocolHash !== request.protocolHash ||
    policy.dispositionAttestationHash !== panel.dispositionAttestationHash ||
    !Number.isSafeInteger(policy.integrationPoints) ||
    policy.integrationPoints < 256 ||
    policy.integrationPoints > 65_536 ||
    !Number.isSafeInteger(policy.replacementAttemptCeiling) ||
    policy.replacementAttemptCeiling < 0 ||
    policy.replacementAttemptCeiling > 4
  ) {
    throw new Error("Canonical derivation policy is detached or malformed.");
  }
  for (const value of [
    policy.requestHash,
    policy.protocolHash,
    policy.dispositionAttestationHash,
    policy.expectedEnvironmentFingerprintHash,
    policy.cacheAttestationHash,
    policy.cacheEvidenceSetHash,
    policy.policyAttestationHash,
  ]) {
    digest(value);
  }
  canonicalTimestamp(policy.candidateFrozenAt);
  assertStratumWeights(policy.presealedStratumWeights, panel);
  assertOnlineErrorBudget(policy.onlineErrorBudget);
  if (request.stage === "validation") {
    if (policy.onlineErrorReservation === null) {
      throw new Error("Fresh validation lacks its pre-outcome online gate.");
    }
    assertTrustedOnlineErrorBudgetReservation(
      policy.onlineErrorReservation,
    );
    if (
      policy.onlineErrorReservation.requestId !== request.requestId ||
      policy.onlineErrorReservation.requestHash !==
        hashEvaluationRequest(request) ||
      policy.onlineErrorReservation.protocolHash !== request.protocolHash ||
      policy.onlineErrorReservation.dispositionAttestationHash !==
        panel.dispositionAttestationHash ||
      canonicalJson(policy.onlineErrorReservation.stateBefore) !==
        canonicalJson(policy.onlineErrorBudget)
    ) {
      throw new Error("Fresh-validation online gate is detached.");
    }
  } else if (policy.onlineErrorReservation !== null) {
    throw new Error("Only fresh validation may carry an online gate.");
  }
  plainObject(policy.guardrails, [
    "externalIntegrityVeto",
    "correctnessVeto",
    "capabilityVeto",
    "costWithinGuardrail",
    "latencyWithinGuardrail",
    "accuracyTradeoffPredeclared",
    "complianceFlagsPassed",
  ]);
  if (
    Object.values(policy.guardrails).some((value) => typeof value !== "boolean")
  ) {
    throw new Error("Canonical guardrails must be boolean.");
  }

  const repairControls = policy.repair?.controls ?? [];
  if (request.stage === "repair") {
    if (
      policy.repair === null ||
      (policy.repair.alternatingBucket !== "easy" &&
        policy.repair.alternatingBucket !== "coverage") ||
      (policy.repair.attemptOrdinal !== 1 && policy.repair.attemptOrdinal !== 2) ||
      !Array.isArray(policy.repair.controls) ||
      policy.repair.controls.length !== 5
    ) {
      throw new Error("Repair derivation policy is missing its five controls.");
    }
    plainObject(policy.repair, [
      "alternatingBucket",
      "attemptOrdinal",
      "controls",
    ]);
  } else if (policy.repair !== null) {
    throw new Error("Fresh matched stages cannot carry repair controls.");
  }
  for (const control of repairControls) {
    assertRepairControl(control);
  }
  if (
    new Set(repairControls.map((control) => control.taskId)).size !==
      repairControls.length ||
    policy.cacheEvidenceSetHash !==
      hashTrustedCacheEvidence({
        requestHash: policy.requestHash,
        dispositionAttestationHash: policy.dispositionAttestationHash,
        repairControls,
      })
  ) {
    throw new Error("Cache evidence commitment does not match repair controls.");
  }

  plainObject(policy.behavioralPolicy, [
    "diagnosticsEnabled",
    "comparison",
    "maximumPrivacyReleases",
    "diagnosticTtlMs",
    "policyVersions",
  ]);
  plainObject(policy.behavioralPolicy.policyVersions, [
    "protocol",
    "broker",
    "extraction",
    "statistics",
    "privacy",
    "weighting",
    "cache",
    "repeatedTesting",
    "leakScanner",
  ]);
  if (
    typeof policy.behavioralPolicy.diagnosticsEnabled !== "boolean" ||
    policy.behavioralPolicy.comparison !== "candidate-vs-champion" ||
    !Number.isSafeInteger(
      policy.behavioralPolicy.maximumPrivacyReleases,
    ) ||
    policy.behavioralPolicy.maximumPrivacyReleases < 1 ||
    policy.behavioralPolicy.maximumPrivacyReleases > 1_000 ||
    !Number.isSafeInteger(policy.behavioralPolicy.diagnosticTtlMs) ||
    policy.behavioralPolicy.diagnosticTtlMs < 60_000 ||
    policy.behavioralPolicy.diagnosticTtlMs > 24 * 60 * 60_000 ||
    Object.values(policy.behavioralPolicy.policyVersions).some(
      (version) =>
        typeof version !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,199}$/u.test(version),
    ) ||
    !Array.isArray(policy.forbiddenReleaseLiterals) ||
    !Array.isArray(policy.forbiddenContentFingerprints) ||
    !Array.isArray(policy.graderCanaryFingerprints) ||
    policy.forbiddenReleaseLiterals.length > MAX_RELEASE_LITERAL_COUNT
  ) {
    throw new Error("Canonical release scanner policy is malformed.");
  }
  for (const literal of policy.forbiddenReleaseLiterals) {
    if (typeof literal !== "string" || literal.trim().length < 4) {
      throw new Error("Canonical forbidden literal is malformed.");
    }
  }
  for (const fingerprint of [
    ...policy.forbiddenContentFingerprints,
    ...policy.graderCanaryFingerprints,
  ]) {
    digest(fingerprint);
  }
}

function correlateAttempt(
  attempt: TrustedDecodedEvaluationAttempt,
  arm: TrustedMatchedArm,
  request: TrustedEvaluationRequest,
): void {
  if (
    attempt.scheduleArmId !== arm.armId ||
    attempt.taskId !== arm.taskId ||
    attempt.taskRevisionDigest !== arm.taskRevisionDigest ||
    attempt.capabilityStratum !== arm.capabilityStratum ||
    attempt.arm !== arm.arm ||
    attempt.order !== arm.order ||
    attempt.harnessArchiveSha256 !== arm.harness.archiveSha256 ||
    attempt.grader.protocolHash !== request.protocolHash
  ) {
    throw new Error("Decoded attempt does not match its presealed arm.");
  }
}

function normalizeAttempts(input: {
  readonly request: TrustedEvaluationRequest;
  readonly schedule: TrustedMatchedArmSchedule;
  readonly decoded: TrustedDecodedEvaluation;
  readonly dispositionAttestationHash: string;
}): {
  readonly attempts: readonly NormalizedAttempt[];
  readonly byArm: ReadonlyMap<string, ArmAttemptSet>;
  readonly invalidCount: number;
  readonly behaviorSourceSetHash: string;
  readonly normalizedOutcomeSetHash: string;
} {
  const scheduleByArm = new Map(
    input.schedule.arms.map((arm) => [arm.armId, arm] as const),
  );
  const grouped = new Map<string, NormalizedAttempt[]>();
  const normalized: NormalizedAttempt[] = [];
  for (const attempt of input.decoded.attempts) {
    const arm = scheduleByArm.get(attempt.scheduleArmId);
    if (arm === undefined) {
      throw new Error("Decoded attempt references an unsealed arm.");
    }
    correlateAttempt(attempt, arm, input.request);
    const outcome = normalizeGraderOutcome(attempt.grader, {
      createdAt: attempt.completedAt,
      rawManifestHash: input.decoded.rawManifestHash,
    });
    const behavior = extractBehaviorSummary(attempt.atif);
    const item: NormalizedAttempt = {
      source: attempt,
      outcome,
      behavior,
      behaviorHash: canonicalHash(behavior),
    };
    normalized.push(item);
    const group = grouped.get(arm.armId) ?? [];
    group.push(item);
    grouped.set(arm.armId, group);
  }

  if (
    grouped.size !== input.schedule.arms.length ||
    input.schedule.arms.some((arm) => !grouped.has(arm.armId))
  ) {
    throw new Error("Decoded attempt set does not cover every sealed arm.");
  }

  const byArm = new Map<string, ArmAttemptSet>();
  let invalidCount = 0;
  for (const arm of input.schedule.arms) {
    const attempts = [...(grouped.get(arm.armId) ?? [])].sort(
      (left, right) =>
        left.source.attemptOrdinal - right.source.attemptOrdinal,
    );
    attempts.forEach((attempt, index) => {
      if (attempt.source.attemptOrdinal !== index + 1) {
        throw new Error("Replacement attempt ordinals must be contiguous.");
      }
      const previous = attempts[index - 1];
      if (
        previous !== undefined &&
        canonicalTimestamp(attempt.source.startedAt) <
          canonicalTimestamp(previous.source.completedAt)
      ) {
        throw new Error("Replacement attempts must execute sequentially.");
      }
    });
    const final = attempts.at(-1);
    if (
      final === undefined ||
      final.outcome.outcome === "invalid" ||
      final.outcome.integrityStatus !== "passed" ||
      attempts
        .slice(0, -1)
        .some((attempt) => attempt.outcome.outcome !== "invalid")
    ) {
      throw new Error("Each sealed arm requires one final valid grader outcome.");
    }
    const invalid = attempts.slice(0, -1);
    invalidCount += invalid.length;
    byArm.set(arm.armId, { final, invalid });
  }

  const sorted = [...normalized].sort((left, right) =>
    left.source.attemptDigest.localeCompare(right.source.attemptDigest),
  );
  const behaviorSourceSetHash = canonicalHash({
    domain: "dark-factory.behavior-source-set.v1",
    requestHash: hashEvaluationRequest(input.request),
    dispositionAttestationHash: input.dispositionAttestationHash,
    rawManifestHash: input.decoded.rawManifestHash,
    outcomes: sorted.map((attempt) => ({
      outcomeContentHash: attempt.outcome.contentHash,
      behaviorHash: attempt.behaviorHash,
    })),
  });
  const normalizedOutcomeSetHash = canonicalHash({
    domain: "dark-factory.normalized-outcome-set.v1",
    requestHash: hashEvaluationRequest(input.request),
    dispositionAttestationHash: input.dispositionAttestationHash,
    rawManifestHash: input.decoded.rawManifestHash,
    outcomes: sorted.map((attempt) => attempt.outcome.contentHash),
    behaviorSourceSetHash,
  });
  return {
    attempts: normalized,
    byArm,
    invalidCount,
    behaviorSourceSetHash,
    normalizedOutcomeSetHash,
  };
}

function parsedExperimentNumber(experimentId: string): number {
  const prefix = experimentId.split("-", 1)[0] ?? "";
  const value = Number.parseInt(prefix, 10);
  if (
    !/^\d+$/u.test(prefix) ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new Error("Behavioral preparation experiment is malformed.");
  }
  return value;
}

function createPrivateBehavioralPreparation(input: {
  readonly request: TrustedEvaluationRequest;
  readonly normalized: ReturnType<typeof normalizeAttempts>;
  readonly policy: TrustedCanonicalDerivationPolicy;
}): TrustedPrivateBehavioralPreparation | null {
  if (
    input.request.stage !== "validation" ||
    !input.policy.behavioralPolicy.diagnosticsEnabled
  ) {
    return null;
  }
  const finalAttempts = [...input.normalized.byArm.values()].map(
    (attempts) => attempts.final,
  );
  const observations: PrivateBehaviorObservation[] = finalAttempts.map(
    (attempt) => ({
      taskId: attempt.source.taskId,
      arm: attempt.source.arm,
      outcome:
        attempt.outcome.outcome === "pass" ? "pass" : "fail",
      behavior: attempt.behavior,
    }),
  );
  const openedAt = new Date(
    Math.min(
      ...finalAttempts.map((attempt) =>
        canonicalTimestamp(attempt.source.startedAt),
      ),
    ),
  ).toISOString();
  const closedAt = new Date(
    Math.max(
      ...finalAttempts.map((attempt) =>
        canonicalTimestamp(attempt.source.completedAt),
      ),
    ),
  ).toISOString();
  return {
    sensitivity: "trusted-private-behavioral-preparation",
    requestHash: hashEvaluationRequest(input.request),
    protocolHash: input.request.protocolHash,
    experimentNumber: parsedExperimentNumber(
      input.request.experimentId,
    ),
    behaviorSourceSetHash:
      input.normalized.behaviorSourceSetHash,
    analysisWindow: { openedAt, closedAt },
    observations,
    policy: input.policy.behavioralPolicy,
    forbiddenReleaseLiterals:
      input.policy.forbiddenReleaseLiterals,
    forbiddenContentFingerprints:
      input.policy.forbiddenContentFingerprints,
    graderCanaryFingerprints:
      input.policy.graderCanaryFingerprints,
  };
}

function aggregateCost(
  attempts: readonly NormalizedAttempt[],
): AggregateCost {
  let inputTokens = 0;
  let outputTokens = 0;
  let modelUsd = 0;
  let sandboxUsd = 0;
  let wallTimeMs = 0;
  for (const attempt of attempts) {
    inputTokens += attempt.source.cost.inputTokens;
    outputTokens += attempt.source.cost.outputTokens;
    modelUsd += attempt.source.cost.modelUsd;
    sandboxUsd += attempt.source.cost.sandboxUsd;
    wallTimeMs +=
      canonicalTimestamp(attempt.source.completedAt) -
      canonicalTimestamp(attempt.source.startedAt);
  }
  safeCount(inputTokens);
  safeCount(outputTokens);
  safeCount(wallTimeMs);
  modelUsd = rounded(modelUsd);
  sandboxUsd = rounded(sandboxUsd);
  return {
    inputTokens,
    outputTokens,
    modelUsd,
    sandboxUsd,
    totalUsd: rounded(modelUsd + sandboxUsd),
    wallTimeMs,
  };
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function assertHiddenArmOutcome(
  outcome: TrustedHiddenCatalogArmOutcome,
): void {
  plainObject(outcome, [
    "pass",
    "boundedReward",
    "infrastructureValid",
    "infrastructureInvalidAttemptCount",
    "latencyMs",
    "inputTokens",
    "outputTokens",
    "modelUsd",
    "sandboxUsd",
    "finalAttemptDigest",
  ]);
  if (
    typeof outcome.pass !== "boolean" ||
    outcome.infrastructureValid !== true ||
    !Number.isFinite(outcome.boundedReward) ||
    outcome.boundedReward < 0 ||
    outcome.boundedReward > 1 ||
    (outcome.pass && outcome.boundedReward !== 1) ||
    (!outcome.pass && outcome.boundedReward === 1)
  ) {
    throw new Error("Hidden catalog arm outcome is inconsistent.");
  }
  safeCount(outcome.infrastructureInvalidAttemptCount);
  safeCount(outcome.latencyMs);
  safeCount(outcome.inputTokens);
  safeCount(outcome.outputTokens);
  finiteNonNegative(outcome.modelUsd);
  finiteNonNegative(outcome.sandboxUsd);
  digest(outcome.finalAttemptDigest);
}

function assertHiddenTaskOutcome(
  outcome: TrustedHiddenCatalogTaskOutcome,
): void {
  plainObject(outcome, [
    "taskId",
    "taskRevisionDigest",
    "capabilityStratum",
    "order",
    "candidate",
    "champion",
  ]);
  digest(outcome.taskId);
  digest(outcome.taskRevisionDigest);
  if (
    !SAFE_ID.test(outcome.capabilityStratum) ||
    (outcome.order !== "AB" && outcome.order !== "BA")
  ) {
    throw new Error("Hidden catalog task outcome metadata is malformed.");
  }
  assertHiddenArmOutcome(outcome.candidate);
  if (outcome.champion !== null) {
    assertHiddenArmOutcome(outcome.champion);
  }
}

export function hashTrustedHiddenCatalogOutcomeSet(
  outcomes: readonly TrustedHiddenCatalogTaskOutcome[],
): string {
  if (
    !Array.isArray(outcomes) ||
    outcomes.length < 1 ||
    outcomes.length > 12
  ) {
    throw new Error("Hidden catalog outcome set has invalid cardinality.");
  }
  for (const outcome of outcomes) {
    assertHiddenTaskOutcome(outcome);
  }
  if (
    new Set(outcomes.map((outcome) => outcome.taskId)).size !==
      outcomes.length
  ) {
    throw new Error("Hidden catalog outcome set repeats a task.");
  }
  return canonicalHash({
    domain: "dark-factory.hidden-catalog-outcome-set.v1",
    outcomes,
  });
}

export function hashTrustedHiddenCatalogSourceBinding(
  source: TrustedHiddenCatalogOutcomeSourceBinding,
): string {
  plainObject(source, [
    "requestHash",
    "protocolHash",
    "stage",
    "dispositionAttestationHash",
    "rawManifestHash",
    "jobSha256",
    "runtimeAttestationHash",
    "normalizedOutcomeSetHash",
    "environmentFingerprintHash",
    "updateSetHash",
  ]);
  if (
    source.stage !== "repair" &&
    source.stage !== "validation" &&
    source.stage !== "shadow"
  ) {
    throw new Error("Hidden catalog outcome source stage is malformed.");
  }
  for (const value of [
    source.requestHash,
    source.protocolHash,
    source.dispositionAttestationHash,
    source.rawManifestHash,
    source.jobSha256,
    source.runtimeAttestationHash,
    source.normalizedOutcomeSetHash,
    source.environmentFingerprintHash,
    source.updateSetHash,
  ]) {
    digest(value);
  }
  return canonicalHash({
    domain: "dark-factory.hidden-catalog-outcome-source.v1",
    ...source,
  });
}

function hiddenArmOutcome(
  attempts: ArmAttemptSet,
): TrustedHiddenCatalogArmOutcome {
  const all = [...attempts.invalid, attempts.final];
  const cost = aggregateCost(all);
  return {
    pass: attempts.final.outcome.outcome === "pass",
    boundedReward: attempts.final.outcome.boundedReward,
    infrastructureValid: true,
    infrastructureInvalidAttemptCount: attempts.invalid.length,
    latencyMs: cost.wallTimeMs,
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    modelUsd: cost.modelUsd,
    sandboxUsd: cost.sandboxUsd,
    finalAttemptDigest: attempts.final.outcome.oneUseAttemptDigest,
  };
}

function createHiddenCatalogOutcomeUpdate(input: {
  readonly request: TrustedEvaluationRequest;
  readonly panel: TrustedMatchedPanel;
  readonly schedule: TrustedMatchedArmSchedule;
  readonly rawRun: TrustedRawRun;
  readonly policy: TrustedCanonicalDerivationPolicy;
  readonly byArm: ReadonlyMap<string, ArmAttemptSet>;
  readonly normalizedOutcomeSetHash: string;
}): UnsignedTrustedHiddenCatalogOutcomeUpdate {
  const stage = input.request.stage;
  if (
    stage !== "repair" &&
    stage !== "validation" &&
    stage !== "shadow"
  ) {
    throw new Error("Hidden outcome updates support adaptive stages only.");
  }
  const outcomes: TrustedHiddenCatalogTaskOutcome[] = input.panel.cells.map(
    (cell, cellOrdinal) => {
      const arms = input.schedule.arms.filter(
        (arm) => arm.cellOrdinal === cellOrdinal,
      );
      const candidateArm = arms.find((arm) => arm.arm === "candidate");
      const championArm = arms.find((arm) => arm.arm === "champion");
      if (
        candidateArm === undefined ||
        (stage === "repair"
          ? arms.length !== 1 || championArm !== undefined
          : arms.length !== 2 || championArm === undefined)
      ) {
        throw new Error("Hidden catalog update is detached from its schedule.");
      }
      const candidateAttempts = input.byArm.get(candidateArm.armId);
      const championAttempts =
        championArm === undefined ? undefined : input.byArm.get(championArm.armId);
      if (
        candidateAttempts === undefined ||
        (championArm !== undefined && championAttempts === undefined)
      ) {
        throw new Error("Hidden catalog update is missing a final arm.");
      }
      return {
        taskId: cell.taskId,
        taskRevisionDigest: cell.taskRevisionDigest,
        capabilityStratum: cell.capabilityStratum,
        order: cell.order,
        candidate: hiddenArmOutcome(candidateAttempts),
        champion:
          championAttempts === undefined
            ? null
            : hiddenArmOutcome(championAttempts),
      };
    },
  );
  const updateSetHash = hashTrustedHiddenCatalogOutcomeSet(outcomes);
  const observedAt = new Date(
    Math.max(
      ...[...input.byArm.values()].map((attempts) =>
        canonicalTimestamp(attempts.final.source.completedAt),
      ),
    ),
  ).toISOString();
  const sourceBindingHash = hashTrustedHiddenCatalogSourceBinding({
    requestHash: hashEvaluationRequest(input.request),
    protocolHash: input.request.protocolHash,
    stage,
    dispositionAttestationHash: input.panel.dispositionAttestationHash,
    rawManifestHash: input.rawRun.manifest.manifestHash,
    jobSha256: input.rawRun.jobSha256,
    runtimeAttestationHash: input.rawRun.runtimeAttestationHash,
    normalizedOutcomeSetHash: input.normalizedOutcomeSetHash,
    environmentFingerprintHash:
      input.policy.expectedEnvironmentFingerprintHash,
    updateSetHash,
  });
  return {
    sensitivity: "trusted-hidden-catalog-outcome-update",
    schemaVersion: 1,
    updateId: `catalog-${sourceBindingHash.slice(0, 48)}`,
    requestHash: hashEvaluationRequest(input.request),
    protocolHash: input.request.protocolHash,
    stage,
    dispositionAttestationHash: input.panel.dispositionAttestationHash,
    rawManifestHash: input.rawRun.manifest.manifestHash,
    jobSha256: input.rawRun.jobSha256,
    runtimeAttestationHash: input.rawRun.runtimeAttestationHash,
    normalizedOutcomeSetHash: input.normalizedOutcomeSetHash,
    environmentFingerprintHash:
      input.policy.expectedEnvironmentFingerprintHash,
    observedAt,
    outcomes,
    updateSetHash,
    sourceBindingHash,
  };
}

export function assertTrustedHiddenCatalogOutcomeUpdateIntegrity(
  update: TrustedSignedHiddenCatalogOutcomeUpdate,
): void {
  plainObject(update, [
    "sensitivity",
    "schemaVersion",
    "updateId",
    "requestHash",
    "protocolHash",
    "stage",
    "dispositionAttestationHash",
    "rawManifestHash",
    "jobSha256",
    "runtimeAttestationHash",
    "normalizedOutcomeSetHash",
    "environmentFingerprintHash",
    "observedAt",
    "outcomes",
    "updateSetHash",
    "sourceBindingHash",
    "signature",
  ]);
  if (
    update.sensitivity !== "trusted-hidden-catalog-outcome-update" ||
    update.schemaVersion !== 1 ||
    !Array.isArray(update.outcomes) ||
    update.outcomes.length !== (update.stage === "repair" ? 5 : 12) ||
    (update.stage === "repair"
      ? update.outcomes.some((outcome) => outcome.champion !== null)
      : update.outcomes.some((outcome) => outcome.champion === null))
  ) {
    throw new Error("Hidden catalog update stage and outcomes disagree.");
  }
  const updateSetHash = hashTrustedHiddenCatalogOutcomeSet(update.outcomes);
  const sourceBindingHash = hashTrustedHiddenCatalogSourceBinding({
    requestHash: update.requestHash,
    protocolHash: update.protocolHash,
    stage: update.stage,
    dispositionAttestationHash: update.dispositionAttestationHash,
    rawManifestHash: update.rawManifestHash,
    jobSha256: update.jobSha256,
    runtimeAttestationHash: update.runtimeAttestationHash,
    normalizedOutcomeSetHash: update.normalizedOutcomeSetHash,
    environmentFingerprintHash: update.environmentFingerprintHash,
    updateSetHash: update.updateSetHash,
  });
  if (
    update.updateSetHash !== updateSetHash ||
    update.sourceBindingHash !== sourceBindingHash ||
    update.updateId !== `catalog-${sourceBindingHash.slice(0, 48)}` ||
    canonicalTimestamp(update.observedAt) < 0
  ) {
    throw new Error("Hidden catalog update hashes are detached.");
  }
  plainObject(update.signature, [
    "algorithm",
    "keyId",
    "signedAt",
    "signature",
  ]);
  if (
    update.signature.algorithm !== "ed25519" ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u.test(
      update.signature.keyId,
    ) ||
    !/^[A-Za-z0-9_-]{86,128}={0,2}$/u.test(
      update.signature.signature,
    ) ||
    canonicalTimestamp(update.signature.signedAt) <
      canonicalTimestamp(update.observedAt)
  ) {
    throw new Error("Hidden catalog update signature metadata is malformed.");
  }
}

function assertHiddenCatalogOutcomeUpdate(
  update: TrustedSignedHiddenCatalogOutcomeUpdate,
  unsigned: UnsignedTrustedHiddenCatalogOutcomeUpdate,
): void {
  const actualUnsigned = Object.fromEntries(
    Object.entries(update).filter(([key]) => key !== "signature"),
  );
  if (canonicalJson(actualUnsigned) !== canonicalJson(unsigned)) {
    throw new Error("Signed hidden catalog update changed its source evidence.");
  }
  assertTrustedHiddenCatalogOutcomeUpdateIntegrity(update);
}

async function commitHiddenCatalogOutcomeUpdate(input: {
  readonly signer: TrustedHiddenCatalogOutcomeUpdateSigner;
  readonly verifier: TrustedHiddenCatalogOutcomeUpdateVerifier;
  readonly sink: TrustedHiddenCatalogOutcomeUpdateSink;
  readonly unsigned: UnsignedTrustedHiddenCatalogOutcomeUpdate;
}): Promise<void> {
  const signature = await input.signer.sign(input.unsigned);
  const signed: TrustedSignedHiddenCatalogOutcomeUpdate = {
    ...input.unsigned,
    signature,
  };
  assertHiddenCatalogOutcomeUpdate(signed, input.unsigned);
  if (!(await input.verifier.verify(signed))) {
    throw new Error("Hidden catalog outcome signature verification failed.");
  }
  const receipt = await input.sink.commit(signed);
  plainObject(receipt, ["status", "updateId", "sourceBindingHash"]);
  if (
    (receipt.status !== "committed" &&
      receipt.status !== "already-committed") ||
    receipt.updateId !== signed.updateId ||
    receipt.sourceBindingHash !== signed.sourceBindingHash
  ) {
    throw new Error("Hidden catalog outcome sink returned a detached receipt.");
  }
}

function finalFor(
  byArm: ReadonlyMap<string, ArmAttemptSet>,
  arm: TrustedMatchedArm,
): NormalizedAttempt {
  const attempt = byArm.get(arm.armId)?.final;
  if (attempt === undefined) {
    throw new Error("Final attempt is missing for a sealed arm.");
  }
  return attempt;
}

function deriveRepairPayload(input: {
  readonly request: TrustedEvaluationRequest;
  readonly panel: TrustedMatchedPanel;
  readonly schedule: TrustedMatchedArmSchedule;
  readonly policy: TrustedCanonicalDerivationPolicy;
  readonly byArm: ReadonlyMap<string, ArmAttemptSet>;
  readonly cost: AggregateCost;
}): TrustedCanonicalAggregate["payload"] {
  if (
    input.request.stage !== "repair" ||
    input.request.selection.kind !== "repair-reuse" ||
    input.policy.repair === null ||
    input.schedule.executionPolicy !== "candidate-only-repair" ||
    input.policy.repair.attemptOrdinal !==
      input.request.selection.candidateAttempt
  ) {
    throw new Error("Repair request, policy, and schedule do not correlate.");
  }
  const controls = new Map(
    input.policy.repair.controls.map((control) => [
      control.taskId,
      control,
    ] as const),
  );
  const tasks: RepairTaskEvidence[] = input.panel.cells.map((cell) => {
    const control = controls.get(cell.taskId);
    const arm = input.schedule.arms.find(
      (candidate) =>
        candidate.taskId === cell.taskId && candidate.arm === "candidate",
    );
    if (control === undefined || arm === undefined) {
      throw new Error("Repair control is detached from the hidden panel.");
    }
    return {
      taskId: cell.taskId,
      bucket: control.bucket,
      stratum: cell.capabilityStratum,
      candidatePass: finalFor(input.byArm, arm).outcome.outcome === "pass",
      candidateObservationFresh: true,
      candidateAttempts: 1,
      championEvidence: control.championEvidence,
      targetBehaviorImproved: control.targetBehaviorImproved,
    };
  });
  if (controls.size !== tasks.length) {
    throw new Error("Repair controls do not exactly cover the hidden panel.");
  }
  const hidden = evaluateRepairGate({
    tasks,
    alternatingBucket: input.policy.repair.alternatingBucket,
    presealedStratumWeights: input.policy.presealedStratumWeights,
    integrityVeto: input.policy.guardrails.externalIntegrityVeto,
    capabilityRegressionVeto: input.policy.guardrails.capabilityVeto,
    costRegressionVeto: !input.policy.guardrails.costWithinGuardrail,
    latencyRegressionVeto: !input.policy.guardrails.latencyWithinGuardrail,
    aggregateCostUsd: input.cost.totalUsd,
    integrationPoints: input.policy.integrationPoints,
  });
  return {
    kind: "repair",
    disposition:
      hidden.disposition === "pass"
        ? "passed"
        : hidden.disposition === "fail"
          ? "failed"
          : "inconclusive",
    attemptOrdinal: input.policy.repair.attemptOrdinal,
    integrityStatus: input.policy.guardrails.externalIntegrityVeto
      ? "failed"
      : "passed",
    aggregateCost: input.cost,
    policyAttestationHash: input.policy.policyAttestationHash,
  };
}

function matchedPairs(input: {
  readonly request: TrustedEvaluationRequest;
  readonly panel: TrustedMatchedPanel;
  readonly schedule: TrustedMatchedArmSchedule;
  readonly policy: TrustedCanonicalDerivationPolicy;
  readonly byArm: ReadonlyMap<string, ArmAttemptSet>;
}): readonly FreshValidationPair[] {
  if (input.schedule.executionPolicy !== "fresh-matched-pairs") {
    throw new Error("Matched stage requires a fresh paired schedule.");
  }
  return input.panel.cells.map((cell, cellOrdinal) => {
    const arms = input.schedule.arms.filter(
      (arm) => arm.cellOrdinal === cellOrdinal,
    );
    const candidateArm = arms.find((arm) => arm.arm === "candidate");
    const championArm = arms.find((arm) => arm.arm === "champion");
    if (
      arms.length !== 2 ||
      candidateArm === undefined ||
      championArm === undefined
    ) {
      throw new Error("A fresh matched cell does not contain two sealed arms.");
    }
    const candidate = finalFor(input.byArm, candidateArm);
    const champion = finalFor(input.byArm, championArm);
    for (const attempt of [candidate, champion]) {
      if (
        attempt.outcome.environmentFingerprintHash !==
        input.policy.expectedEnvironmentFingerprintHash
      ) {
        throw new Error("Final matched arm has an unexpected environment.");
      }
    }
    return {
      taskId: cell.taskId,
      stratum: cell.capabilityStratum,
      order: cell.order,
      candidate: {
        pass: candidate.outcome.outcome === "pass",
        fresh: true,
        cacheUsed: false,
        protocolHash: candidate.outcome.protocolHash,
        environmentFingerprintHash:
          candidate.outcome.environmentFingerprintHash,
        startedAt: candidate.source.startedAt,
        completedAt: candidate.source.completedAt,
      },
      champion: {
        pass: champion.outcome.outcome === "pass",
        fresh: true,
        cacheUsed: false,
        protocolHash: champion.outcome.protocolHash,
        environmentFingerprintHash:
          champion.outcome.environmentFingerprintHash,
        startedAt: champion.source.startedAt,
        completedAt: champion.source.completedAt,
      },
    };
  });
}

function pairOutcomeTotals(
  pairs: readonly FreshValidationPair[],
): {
  readonly bothPass: number;
  readonly challengerOnlyPass: number;
  readonly championOnlyPass: number;
  readonly bothFail: number;
} {
  const totals = {
    bothPass: 0,
    challengerOnlyPass: 0,
    championOnlyPass: 0,
    bothFail: 0,
  };
  for (const pair of pairs) {
    if (pair.candidate.pass && pair.champion.pass) {
      totals.bothPass += 1;
    } else if (pair.candidate.pass) {
      totals.challengerOnlyPass += 1;
    } else if (pair.champion.pass) {
      totals.championOnlyPass += 1;
    } else {
      totals.bothFail += 1;
    }
  }
  return totals;
}

function freshValidationInput(input: {
  readonly request: TrustedEvaluationRequest;
  readonly panel: TrustedMatchedPanel;
  readonly policy: TrustedCanonicalDerivationPolicy;
  readonly pairs: readonly FreshValidationPair[];
}) {
  return {
    pairs: input.pairs,
    presealedStratumWeights: input.policy.presealedStratumWeights,
    expectedProtocolHash: input.request.protocolHash,
    candidateFrozenAt: input.policy.candidateFrozenAt,
    panelSealedAt: input.panel.sealedAt,
    integrityVeto: input.policy.guardrails.externalIntegrityVeto,
    correctnessVeto: input.policy.guardrails.correctnessVeto,
    capabilityRegressionVeto: input.policy.guardrails.capabilityVeto,
    costWithinGuardrail: input.policy.guardrails.costWithinGuardrail,
    latencyWithinGuardrail: input.policy.guardrails.latencyWithinGuardrail,
    accuracyTradeoffPredeclared:
      input.policy.guardrails.accuracyTradeoffPredeclared,
    onlineErrorBudget: input.policy.onlineErrorBudget,
    ...(input.policy.onlineErrorReservation === null
      ? {}
      : {
          reservedOnlineGate:
            input.policy.onlineErrorReservation.allocation,
        }),
    integrationPoints: input.policy.integrationPoints,
  } as const;
}

function deriveValidationPayload(input: {
  readonly request: TrustedEvaluationRequest;
  readonly panel: TrustedMatchedPanel;
  readonly schedule: TrustedMatchedArmSchedule;
  readonly policy: TrustedCanonicalDerivationPolicy;
  readonly byArm: ReadonlyMap<string, ArmAttemptSet>;
  readonly invalidCount: number;
  readonly cost: AggregateCost;
}): TrustedCanonicalAggregate["payload"] {
  if (
    input.request.stage !== "validation" ||
    input.request.selection.kind !== "fresh-matched-validation"
  ) {
    throw new Error("Validation request does not select a fresh matched panel.");
  }
  const pairs = matchedPairs(input);
  const result = evaluateFreshValidation(
    freshValidationInput({ ...input, pairs }),
  );
  const reservation = input.policy.onlineErrorReservation;
  if (
    reservation === null ||
    result.onlineGateAlphaSpent !== reservation.accounting.alphaSpent
  ) {
    throw new Error("Validation did not use its reserved online gate.");
  }
  return {
    kind: "validation",
    disposition: result.disposition,
    matchedTaskCount: 12,
    validFreshArmCount: 24,
    invalidArmTotal: input.invalidCount,
    stratumCount: new Set(
      input.panel.cells.map((cell) => cell.capabilityStratum),
    ).size,
    pairOutcomeTotals: pairOutcomeTotals(pairs),
    weightedAccuracy: {
      medianDelta: result.posteriorMedianAccuracyDelta,
      credibleInterval: {
        lower: result.interval95[0],
        upper: result.interval95[1],
      },
      probabilityPositive: result.probabilityAccuracyDeltaPositive,
    },
    requiredPosteriorProbability: result.requiredPosteriorProbability,
    onlineGateAuthorized: result.onlineGateAuthorized,
    onlineErrorBudget: reservation.accounting,
    stratumRegressionVeto: result.stratumRegressionVeto,
    integrityVeto: input.policy.guardrails.externalIntegrityVeto,
    correctnessVeto: input.policy.guardrails.correctnessVeto,
    capabilityVeto: input.policy.guardrails.capabilityVeto,
    costWithinGuardrail: input.policy.guardrails.costWithinGuardrail,
    latencyWithinGuardrail: input.policy.guardrails.latencyWithinGuardrail,
    accuracyTradeoffPredeclared:
      input.policy.guardrails.accuracyTradeoffPredeclared,
    aggregateCost: input.cost,
  };
}

function deriveShadowPayload(input: {
  readonly request: TrustedEvaluationRequest;
  readonly panel: TrustedMatchedPanel;
  readonly schedule: TrustedMatchedArmSchedule;
  readonly policy: TrustedCanonicalDerivationPolicy;
  readonly byArm: ReadonlyMap<string, ArmAttemptSet>;
  readonly cost: AggregateCost;
}): TrustedCanonicalAggregate["payload"] {
  if (
    input.request.stage !== "shadow" ||
    input.request.selection.kind !== "fresh-shadow"
  ) {
    throw new Error("Shadow request does not select a fresh dark panel.");
  }
  const pairs = matchedPairs(input);
  const result = evaluateShadowCertification({
    ...freshValidationInput({ ...input, pairs }),
    aggregateCostUsd: input.cost.totalUsd,
    complianceFlagsPassed: input.policy.guardrails.complianceFlagsPassed,
  });
  return {
    kind: "shadow",
    disposition: result.disposition,
    compliancePassed: result.complianceFlagsPassed,
    aggregateCost: input.cost,
  };
}

function allStringValues(value: unknown): readonly string[] {
  const values: string[] = [];
  const visit = (current: unknown): void => {
    if (typeof current === "string") {
      values.push(current);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (current !== null && typeof current === "object") {
      Object.values(current).forEach(visit);
    }
  };
  visit(value);
  return values;
}

function assertNoSensitiveReleaseMaterial(input: {
  readonly aggregate: TrustedCanonicalAggregate;
  readonly panel: TrustedMatchedPanel;
  readonly schedule: TrustedMatchedArmSchedule;
  readonly policy: TrustedCanonicalDerivationPolicy;
}): void {
  assertSafeForLocalPersistence(input.aggregate);
  const serialized = canonicalJson(input.aggregate).toLocaleLowerCase("en-US");
  const forbiddenIdentities = [
    ...input.panel.cells.flatMap((cell) => [
      cell.taskId,
      cell.taskRevisionDigest,
    ]),
    ...input.schedule.arms.map((arm) => arm.armId),
  ];
  if (
    forbiddenIdentities.some((identity) =>
      serialized.includes(identity.toLocaleLowerCase("en-US")),
    )
  ) {
    throw new Error("Release contains a hidden benchmark identity.");
  }
  for (const literal of input.policy.forbiddenReleaseLiterals) {
    if (
      serialized.includes(literal.trim().toLocaleLowerCase("en-US"))
    ) {
      throw new Error("Release contains a forbidden source literal.");
    }
  }
  const outputFingerprints = new Set(
    allStringValues(input.aggregate).map(fingerprintForbiddenReleaseLiteralSafe),
  );
  if (
    input.policy.forbiddenContentFingerprints.some((fingerprint) =>
      outputFingerprints.has(fingerprint),
    ) ||
    input.policy.graderCanaryFingerprints.some((fingerprint) =>
      outputFingerprints.has(fingerprint),
    )
  ) {
    throw new Error("Release contains a forbidden content fingerprint.");
  }
}

function fingerprintForbiddenReleaseLiteralSafe(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return canonicalHash({
    domain: "dark-factory.release-literal-fingerprint.v1",
    literal: normalized,
  });
}

function assertTiming(input: {
  readonly request: TrustedEvaluationRequest;
  readonly panel: TrustedMatchedPanel;
  readonly attempts: readonly NormalizedAttempt[];
  readonly derivedAt: string;
}): void {
  const submittedAt = canonicalTimestamp(input.request.submittedAt);
  const deadlineAt = canonicalTimestamp(input.request.deadlineAt);
  const sealedAt = canonicalTimestamp(input.panel.sealedAt);
  const expiresAt = canonicalTimestamp(input.panel.expiresAt);
  const derivedAt = canonicalTimestamp(input.derivedAt);
  const latestCompletion = Math.max(
    ...input.attempts.map((attempt) =>
      canonicalTimestamp(attempt.source.completedAt),
    ),
  );
  if (
    sealedAt < submittedAt ||
    expiresAt > deadlineAt ||
    derivedAt < latestCompletion ||
    derivedAt > deadlineAt ||
    input.attempts.some(
      (attempt) =>
        canonicalTimestamp(attempt.source.startedAt) < sealedAt ||
        canonicalTimestamp(attempt.source.completedAt) > expiresAt,
    )
  ) {
    throw new Error("Canonical derivation violates the sealed evaluation window.");
  }
}

/**
 * Deterministic trusted reduction from decoded raw evidence to the only object
 * the broker may sign and release. All errors are collapsed to generic codes so
 * reader, grader, and hidden-task details can never escape through exceptions.
 */
export class DeterministicCanonicalEvaluationDeriver
  implements TrustedCanonicalEvaluationDeriver
{
  readonly #reader: TrustedDecodedEvaluationReader;
  readonly #policies: TrustedCanonicalDerivationPolicyResolver;
  readonly #hiddenOutcomeSigner: TrustedHiddenCatalogOutcomeUpdateSigner;
  readonly #hiddenOutcomeVerifier: TrustedHiddenCatalogOutcomeUpdateVerifier;
  readonly #hiddenOutcomeSink: TrustedHiddenCatalogOutcomeUpdateSink;
  readonly #prepareBehavioral:
    TrustedBehavioralPreparationStore["prepare"];
  readonly #now: () => Date;

  constructor(options: DeterministicCanonicalEvaluationDeriverOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      typeof options.reader?.decode !== "function" ||
      typeof options.policies?.resolve !== "function" ||
      typeof options.hiddenOutcomeSigner?.sign !== "function" ||
      typeof options.hiddenOutcomeVerifier?.verify !== "function" ||
      typeof options.hiddenOutcomeSink?.commit !== "function" ||
      (options.behavioralPreparationStore?.boundary !==
        "trusted-cloud" &&
        options.behavioralPreparationStore?.boundary !==
          "test-only-in-memory") ||
      typeof options.behavioralPreparationStore?.prepare !==
        "function" ||
      typeof options.behavioralPreparationStore?.resolve !==
        "function" ||
      typeof options.behavioralPreparationStore?.finalize !==
        "function" ||
      typeof options.behavioralPreparationStore?.abandon !==
        "function" ||
      typeof options.behavioralPreparationStore?.consume !==
        "function"
    ) {
      throw new TrustedCanonicalDeriverError("policy-failed");
    }
    this.#reader = options.reader;
    this.#policies = options.policies;
    this.#hiddenOutcomeSigner = options.hiddenOutcomeSigner;
    this.#hiddenOutcomeVerifier = options.hiddenOutcomeVerifier;
    this.#hiddenOutcomeSink = options.hiddenOutcomeSink;
    this.#prepareBehavioral =
      options.behavioralPreparationStore.prepare.bind(
        options.behavioralPreparationStore,
      );
    this.#now = options.now ?? (() => new Date());
  }

  async derive(
    input: Parameters<TrustedCanonicalEvaluationDeriver["derive"]>[0],
  ): Promise<TrustedCanonicalAggregate> {
    let decoded: TrustedDecodedEvaluation;
    try {
      decoded = await this.#reader.decode(input.rawRun);
      assertDecodedEvaluation(decoded, input.rawRun);
    } catch {
      throw new TrustedCanonicalDeriverError("decode-failed");
    }

    let policy: TrustedCanonicalDerivationPolicy;
    try {
      policy = await this.#policies.resolve(input);
      assertPolicy(policy, input.request, input.panel);
    } catch {
      throw new TrustedCanonicalDeriverError("policy-failed");
    }

    try {
      if (
        input.request.requestId !== input.panel.requestId ||
        input.request.requestId !== input.schedule.requestId ||
        input.request.requestId !== input.rawRun.requestId ||
        input.request.stage !== input.panel.stage ||
        input.request.stage !== input.schedule.stage ||
        input.schedule.cellCount !== input.panel.cells.length ||
        input.schedule.armCount !== input.schedule.arms.length
      ) {
        throw new Error("Trusted derivation inputs are detached.");
      }
      const normalized = normalizeAttempts({
        request: input.request,
        schedule: input.schedule,
        decoded,
        dispositionAttestationHash: input.panel.dispositionAttestationHash,
      });
      if (
        normalized.invalidCount > policy.replacementAttemptCeiling ||
        [...normalized.byArm.values()].some(
          (attempts) =>
            attempts.final.outcome.environmentFingerprintHash !==
            policy.expectedEnvironmentFingerprintHash,
        )
      ) {
        throw new Error("Infrastructure replacement ceiling was exceeded.");
      }
      const derivedAt = this.#now().toISOString();
      assertTiming({
        request: input.request,
        panel: input.panel,
        attempts: normalized.attempts,
        derivedAt,
      });
      const cost = aggregateCost(normalized.attempts);
      const common = {
        request: input.request,
        panel: input.panel,
        schedule: input.schedule,
        policy,
        byArm: normalized.byArm,
        cost,
      };
      const payload =
        input.request.stage === "repair"
          ? deriveRepairPayload(common)
          : input.request.stage === "validation"
            ? deriveValidationPayload({
                ...common,
                invalidCount: normalized.invalidCount,
              })
            : input.request.stage === "shadow"
              ? deriveShadowPayload(common)
              : (() => {
                  throw new Error("Unsupported adaptive evaluation stage.");
                })();
      const aggregate: TrustedCanonicalAggregate = {
        sensitivity: "trusted-canonical-aggregate",
        requestHash: hashEvaluationRequest(input.request),
        protocolHash: input.request.protocolHash,
        rawManifestId: input.rawRun.manifest.manifestId,
        payload,
        normalizedOutcomeSetHash: normalized.normalizedOutcomeSetHash,
        cacheAttestationHash: policy.cacheAttestationHash,
        behavioralAggregateHash: null,
        derivedAt,
        releaseChecks: {
          graderCanaryScanPassed: true,
          contentFingerprintScanPassed: true,
          taskIdentityScanPassed: true,
          privacyThresholdPassed: false,
        },
      };
      assertNoSensitiveReleaseMaterial({
        aggregate,
        panel: input.panel,
        schedule: input.schedule,
        policy,
      });
      const hiddenCatalogUpdate = createHiddenCatalogOutcomeUpdate({
        request: input.request,
        panel: input.panel,
        schedule: input.schedule,
        rawRun: input.rawRun,
        policy,
        byArm: normalized.byArm,
        normalizedOutcomeSetHash: normalized.normalizedOutcomeSetHash,
      });
      await commitHiddenCatalogOutcomeUpdate({
        signer: this.#hiddenOutcomeSigner,
        verifier: this.#hiddenOutcomeVerifier,
        sink: this.#hiddenOutcomeSink,
        unsigned: hiddenCatalogUpdate,
      });
      const preparation = createPrivateBehavioralPreparation({
        request: input.request,
        normalized,
        policy,
      });
      if (preparation !== null) {
        const receipt = await this.#prepareBehavioral(preparation);
        const preparationHash =
          hashTrustedBehavioralPreparation(preparation);
        if (
          (receipt.status !== "prepared" &&
            receipt.status !== "already-prepared") ||
          receipt.requestHash !== aggregate.requestHash ||
          receipt.protocolHash !== aggregate.protocolHash ||
          receipt.preparationHash !== preparationHash
        ) {
          throw new Error(
            "Behavioral preparation durability receipt is detached.",
          );
        }
      }
      return aggregate;
    } catch (error) {
      if (error instanceof TrustedCanonicalDeriverError) {
        throw error;
      }
      const code =
        error instanceof Error &&
        /Release contains|Released evidence/u.test(error.message)
          ? "release-scan-failed"
          : "normalization-failed";
      throw new TrustedCanonicalDeriverError(code);
    }
  }
}
