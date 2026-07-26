import { randomBytes } from "node:crypto";

import type { MatchedExecutionProfile } from "../cloud/types.js";
import type { ExperimentIdentity } from "../domain/models.js";
import type {
  CanonicalEvaluatorKeyring,
  ReleasedEvaluationBundle,
} from "../evaluator/canonical-client.js";
import {
  assertEvaluationRequest,
  hashEvaluationRequest,
  type EvaluatedModelReference,
  type HarnessArtifactReference,
  type TrustedEvaluationRequest,
} from "../evaluator/contracts.js";
import { resultEnvelopeBehavioralSourceCommitmentHash } from "../evaluator/release-lineage.js";
import { assertSafeForLocalPersistence } from "../evaluator/retention.js";
import { VALIDATION_ATTEMPT_LEDGER_POLICY_VERSION } from "../evaluation/validation-attempt-ledger.js";
import { verifyEd25519Signature } from "../evidence/signatures.js";
import type {
  BehavioralEvidence,
  CacheAttestation,
  DiagnosticBrief,
  FailureCards,
} from "../schemas/artifacts.js";
import {
  canonicalHash,
  canonicalJson,
  hasValidContentHash,
} from "../schemas/canonical.js";
import { assertValidDocument } from "../schemas/registry.js";
import type {
  SignedBehavioralRelease,
  SignedResultEnvelope,
} from "../schemas/trusted.js";
import type {
  BlindBroker,
  DiagnosticBriefReference,
  EphemeralPanelLease,
  RepairAggregate,
  ValidationAggregate,
} from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const LEASE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/u;
const REPAIR_VALID_ARMS = 5 as const;
const REPAIR_MAXIMUM_ATTEMPTS = 9 as const;
const VALIDATION_VALID_ARMS = 24 as const;
const VALIDATION_MAXIMUM_ATTEMPTS = 28 as const;

type AdaptiveStage = "repair" | "validation";
type LeaseOutcome = "decided" | "started-abandoned" | "sealed-unstarted";
type LeaseStatus =
  | "prepared"
  | "running"
  | "evaluated"
  | "evaluation-failed"
  | "disposed";
type DiagnosticStatus =
  | "not-authorized"
  | "unavailable"
  | "eligible"
  | "releasing"
  | "released"
  | "burned";

const ADAPTIVE_STAGES = new Set<AdaptiveStage>([
  "repair",
  "validation",
]);
const LEASE_OUTCOMES = new Set<LeaseOutcome>([
  "decided",
  "started-abandoned",
  "sealed-unstarted",
]);
const LEASE_STATUSES = new Set<LeaseStatus>([
  "prepared",
  "running",
  "evaluated",
  "evaluation-failed",
  "disposed",
]);
const DIAGNOSTIC_STATUSES = new Set<DiagnosticStatus>([
  "not-authorized",
  "unavailable",
  "eligible",
  "releasing",
  "released",
  "burned",
]);

export interface BlindBrokerEvaluationConfiguration {
  readonly runMode: "research";
  readonly complianceManifestHash: string;
  readonly executionProfile: MatchedExecutionProfile;
  readonly evaluatedModel: EvaluatedModelReference;
  readonly weightingPolicyHash: string;
  readonly requestTtlMs: number;
}

export interface BlindBrokerEvaluationConfigurationResolver {
  resolve(
    experiment: ExperimentIdentity,
  ): Promise<BlindBrokerEvaluationConfiguration>;
}

export interface TrustedHarnessArtifactResolver {
  resolve(commit: string): Promise<HarnessArtifactReference>;
}

export interface TrustedRepairDiscoveryBinding {
  readonly sourceExperimentId: string;
  readonly discoveryAttestationHash: string;
}

export interface TrustedRepairDiscoveryResolver {
  resolve(input: {
    readonly experiment: ExperimentIdentity;
    readonly discoveryAttestationHash: string;
  }): Promise<TrustedRepairDiscoveryBinding>;
}

/**
 * CanonicalEvaluatorClient satisfies this port. Its transport remains inside
 * the trusted cloud control plane; the adapter never receives raw Harbor,
 * grader, trajectory, panel, task, cell, or attempt records.
 */
export interface TrustedAdaptiveEvaluationClient {
  evaluate(request: TrustedEvaluationRequest): Promise<ReleasedEvaluationBundle>;
}

export type SignedAdaptiveReleaseDocument =
  | SignedResultEnvelope
  | SignedBehavioralRelease
  | CacheAttestation;

export interface TrustedAdaptiveReleaseSignatureVerifier {
  verify(document: SignedAdaptiveReleaseDocument): Promise<boolean>;
}

export class Ed25519AdaptiveReleaseSignatureVerifier
  implements TrustedAdaptiveReleaseSignatureVerifier
{
  readonly #keyring: CanonicalEvaluatorKeyring;

  public constructor(keyring: CanonicalEvaluatorKeyring) {
    this.#keyring = keyring;
  }

  public async verify(
    document: SignedAdaptiveReleaseDocument,
  ): Promise<boolean> {
    const key = await this.#keyring.getVerificationKey(document.signature.keyId);
    return (
      key !== undefined &&
      verifyEd25519Signature(
        document as unknown as Readonly<Record<string, unknown>>,
        key,
      )
    );
  }
}

export interface TrustedDiagnosticBriefPublisher {
  /**
   * Implementations must be durable and idempotent by publicationId. They may
   * expose only the validated diagnostic brief, never the enclosing trusted
   * lease record or any hidden evaluator state.
   */
  publishOnce(input: {
    readonly publicationId: string;
    readonly sourceResultEnvelopeHash: string;
    readonly behavioralRelease: SignedBehavioralRelease;
    readonly behavioralEvidence: BehavioralEvidence;
    readonly failureCards: FailureCards;
    readonly diagnosticBrief: DiagnosticBrief;
  }): Promise<DiagnosticBriefReference>;
}

export interface StoredDiagnosticMaterial {
  readonly behavioralRelease: SignedBehavioralRelease;
  readonly behavioralEvidence: BehavioralEvidence;
  readonly failureCards: FailureCards;
  readonly diagnosticBrief: DiagnosticBrief;
}

export interface DurableBlindBrokerLeaseRecord {
  readonly schemaVersion: 1;
  readonly preparationHash: string;
  readonly leaseToken: string;
  readonly leaseSealHash: string;
  readonly requestId: string;
  readonly experiment: ExperimentIdentity;
  readonly stage: AdaptiveStage;
  readonly status: LeaseStatus;
  readonly diagnosticStatus: DiagnosticStatus;
  readonly hypothesisHash: string;
  readonly candidateCommit: string;
  readonly championCommit: string | null;
  readonly repairAttemptOrdinal: 1 | 2 | null;
  readonly repairSourceExperimentId: string | null;
  readonly previousDiscoveryAttestationHash: string | null;
  readonly excludedEvidenceHashes: readonly string[];
  readonly diagnosticReleaseAuthorized: boolean;
  readonly configuration: BlindBrokerEvaluationConfiguration;
  readonly submittedAt: string;
  readonly deadlineAt: string;
  readonly expectedValidArms: number;
  readonly maximumAttempts: number;
  readonly requestHash: string | null;
  readonly resultDispositionAttestationHash: string | null;
  readonly aggregate: RepairAggregate | ValidationAggregate | null;
  readonly diagnosticMaterial: StoredDiagnosticMaterial | null;
  readonly diagnosticReference: DiagnosticBriefReference | null;
  readonly disposedOutcome: LeaseOutcome | null;
  readonly disposedAt: string | null;
  readonly dispositionAttestationHash: string | null;
  readonly updatedAt: string;
}

export interface DurableBlindBrokerLeaseState {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly records: Readonly<
    Record<string, DurableBlindBrokerLeaseRecord>
  >;
}

export interface AtomicBlindBrokerLeaseStore {
  /**
   * The callback must execute exactly once in a linearizable cloud
   * transaction. `next` must be durable before this promise resolves.
   */
  transact<Result>(
    operation: (state: DurableBlindBrokerLeaseState) => {
      readonly next: DurableBlindBrokerLeaseState;
      readonly result: Result;
    },
  ): Promise<Result>;
}

export interface ProductionBlindBrokerOptions {
  readonly store: AtomicBlindBrokerLeaseStore;
  readonly configurations: BlindBrokerEvaluationConfigurationResolver;
  readonly artifacts: TrustedHarnessArtifactResolver;
  readonly repairDiscovery: TrustedRepairDiscoveryResolver;
  readonly evaluator: TrustedAdaptiveEvaluationClient;
  readonly signatureVerifier: TrustedAdaptiveReleaseSignatureVerifier;
  readonly diagnosticPublisher: TrustedDiagnosticBriefPublisher;
  readonly now?: () => Date;
  readonly leaseTokenFactory?: () => string;
}

export type ProductionBlindBrokerErrorCode =
  | "configuration-invalid"
  | "lease-invalid"
  | "lease-conflict"
  | "lease-state-invalid"
  | "evaluation-failed"
  | "release-invalid"
  | "diagnostic-unavailable";

export class ProductionBlindBrokerError extends Error {
  override readonly name = "ProductionBlindBrokerError";
  readonly code: ProductionBlindBrokerErrorCode;

  public constructor(
    code: ProductionBlindBrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

export function emptyBlindBrokerLeaseState(): DurableBlindBrokerLeaseState {
  return {
    schemaVersion: 1,
    revision: 0,
    records: {},
  };
}

function nextState(
  state: DurableBlindBrokerLeaseState,
  records: DurableBlindBrokerLeaseState["records"],
): DurableBlindBrokerLeaseState {
  return {
    schemaVersion: 1,
    revision: state.revision + 1,
    records,
  };
}

function assertHash(value: string, label: string): void {
  if (!SHA256.test(value)) {
    throw new ProductionBlindBrokerError(
      "configuration-invalid",
      `${label} must be a lowercase SHA-256 digest.`,
    );
  }
}

function assertCanonicalTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new ProductionBlindBrokerError(
      "lease-invalid",
      `${label} must be a canonical UTC timestamp.`,
    );
  }
  return parsed;
}

function experimentId(experiment: ExperimentIdentity): string {
  if (
    !Number.isSafeInteger(experiment.number) ||
    experiment.number < 1 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(experiment.slug) ||
    !SAFE_ID.test(experiment.lineageId)
  ) {
    throw new ProductionBlindBrokerError(
      "lease-invalid",
      "Experiment identity cannot form a trusted evaluation request.",
    );
  }
  assertHash(experiment.protocolHash, "Experiment protocol");
  const value = `${String(experiment.number).padStart(3, "0")}-${experiment.slug}`;
  if (!SAFE_ID.test(value)) {
    throw new ProductionBlindBrokerError(
      "lease-invalid",
      "Experiment identifier exceeds the release-safe identifier policy.",
    );
  }
  return value;
}

function assertConfiguration(
  configuration: BlindBrokerEvaluationConfiguration,
  experiment: ExperimentIdentity,
): void {
  if (
    configuration.runMode !== "research" ||
    !Number.isSafeInteger(configuration.requestTtlMs) ||
    configuration.requestTtlMs < 60_000 ||
    configuration.requestTtlMs > 24 * 60 * 60_000 ||
    configuration.executionProfile.protocolHash !==
      experiment.protocolHash
  ) {
    throw new ProductionBlindBrokerError(
      "configuration-invalid",
      "Adaptive evaluation configuration violates the frozen research protocol.",
    );
  }
  assertHash(configuration.complianceManifestHash, "Compliance manifest");
  assertHash(configuration.weightingPolicyHash, "Weighting policy");
  const probe: TrustedEvaluationRequest = {
    schemaVersion: 1,
    requestId: "configuration-probe",
    experimentId: experimentId(experiment),
    runMode: "research",
    stage: "validation",
    submittedAt: "2026-01-01T00:00:00.000Z",
    deadlineAt: "2026-01-01T01:00:00.000Z",
    protocolHash: experiment.protocolHash,
    complianceManifestHash: configuration.complianceManifestHash,
    candidate: {
      uri: "trusted://configuration/candidate",
      commitSha: "1".repeat(40),
      treeSha: "1".repeat(40),
      archiveSha256: "1".repeat(64),
    },
    champion: {
      uri: "trusted://configuration/champion",
      commitSha: "2".repeat(40),
      treeSha: "2".repeat(40),
      archiveSha256: "2".repeat(64),
    },
    selection: {
      kind: "fresh-matched-validation",
      taskCount: 12,
      attemptsPerArm: 1,
      pairOrder: "balanced-6-ab-6-ba",
      weightingPolicyHash: configuration.weightingPolicyHash,
      frozenHypothesisHash: "3".repeat(64),
      hypothesisExclusionAttestationHash: "3".repeat(64),
    },
    executionProfile: configuration.executionProfile,
    evaluatedModel: configuration.evaluatedModel,
  };
  try {
    assertEvaluationRequest(probe);
  } catch {
    throw new ProductionBlindBrokerError(
      "configuration-invalid",
      "Adaptive evaluation configuration cannot form a valid request.",
    );
  }
}

function assertExperimentMatches(
  expected: ExperimentIdentity,
  actual: ExperimentIdentity,
): void {
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    throw new ProductionBlindBrokerError(
      "lease-conflict",
      "Lease belongs to another experiment.",
    );
  }
}

function preparationHashFor(
  record: DurableBlindBrokerLeaseRecord,
): string {
  return canonicalHash({
    domain: "dark-factory.blind-broker.preparation.v1",
    experiment: record.experiment,
    stage: record.stage,
    hypothesisHash: record.hypothesisHash,
    candidateCommit: record.candidateCommit,
    repairAttemptOrdinal: record.repairAttemptOrdinal,
    repairSourceExperimentId: record.repairSourceExperimentId,
    previousDiscoveryAttestationHash:
      record.previousDiscoveryAttestationHash,
    excludedEvidenceHashes: record.excludedEvidenceHashes,
    diagnosticReleaseAuthorized: record.diagnosticReleaseAuthorized,
    configuration: record.configuration,
    expectedValidArms: record.expectedValidArms,
    maximumAttempts: record.maximumAttempts,
  });
}

function leaseSealHashFor(record: DurableBlindBrokerLeaseRecord): string {
  return canonicalHash({
    domain: "dark-factory.blind-broker.lease-seal.v1",
    preparationHash: record.preparationHash,
    leaseTokenCommitment: canonicalHash(record.leaseToken),
    requestId: record.requestId,
    submittedAt: record.submittedAt,
    deadlineAt: record.deadlineAt,
  });
}

function assertExactPlainObjectKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ProductionBlindBrokerError(
      "lease-state-invalid",
      `${label} must be a plain object.`,
    );
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    throw new ProductionBlindBrokerError(
      "lease-state-invalid",
      `${label} contains non-canonical fields.`,
    );
  }
}

function assertLeaseRecord(record: DurableBlindBrokerLeaseRecord): void {
  assertExactPlainObjectKeys(
    record,
    [
      "schemaVersion",
      "preparationHash",
      "leaseToken",
      "leaseSealHash",
      "requestId",
      "experiment",
      "stage",
      "status",
      "diagnosticStatus",
      "hypothesisHash",
      "candidateCommit",
      "championCommit",
      "repairAttemptOrdinal",
      "repairSourceExperimentId",
      "previousDiscoveryAttestationHash",
      "excludedEvidenceHashes",
      "diagnosticReleaseAuthorized",
      "configuration",
      "submittedAt",
      "deadlineAt",
      "expectedValidArms",
      "maximumAttempts",
      "requestHash",
      "resultDispositionAttestationHash",
      "aggregate",
      "diagnosticMaterial",
      "diagnosticReference",
      "disposedOutcome",
      "disposedAt",
      "dispositionAttestationHash",
      "updatedAt",
    ],
    "Durable blind-broker lease record",
  );
  if (
    record.schemaVersion !== 1 ||
    !ADAPTIVE_STAGES.has(record.stage) ||
    !LEASE_STATUSES.has(record.status) ||
    !DIAGNOSTIC_STATUSES.has(record.diagnosticStatus) ||
    !SHA256.test(record.preparationHash) ||
    !LEASE_TOKEN.test(record.leaseToken) ||
    !SHA256.test(record.leaseSealHash) ||
    !SAFE_ID.test(record.requestId) ||
    !SHA256.test(record.hypothesisHash) ||
    !GIT_OBJECT.test(record.candidateCommit) ||
    (record.championCommit !== null &&
      !GIT_OBJECT.test(record.championCommit)) ||
    !Number.isSafeInteger(record.expectedValidArms) ||
    !Number.isSafeInteger(record.maximumAttempts) ||
    record.maximumAttempts < record.expectedValidArms ||
    !Array.isArray(record.excludedEvidenceHashes) ||
    record.excludedEvidenceHashes.some((hash) => !SHA256.test(hash)) ||
    new Set(record.excludedEvidenceHashes).size !==
      record.excludedEvidenceHashes.length ||
    canonicalJson(record.excludedEvidenceHashes) !==
      canonicalJson([...record.excludedEvidenceHashes].sort()) ||
    typeof record.diagnosticReleaseAuthorized !== "boolean" ||
    (record.requestHash !== null && !SHA256.test(record.requestHash)) ||
    (record.resultDispositionAttestationHash !== null &&
      !SHA256.test(record.resultDispositionAttestationHash)) ||
    (record.disposedOutcome !== null &&
      !LEASE_OUTCOMES.has(record.disposedOutcome)) ||
    (record.disposedAt !== null &&
      typeof record.disposedAt !== "string") ||
    (record.dispositionAttestationHash !== null &&
      !SHA256.test(record.dispositionAttestationHash))
  ) {
    throw new ProductionBlindBrokerError(
      "lease-state-invalid",
      "Durable blind-broker lease state is malformed.",
    );
  }
  experimentId(record.experiment);
  const submittedAt = assertCanonicalTimestamp(
    record.submittedAt,
    "Lease submission time",
  );
  const deadlineAt = assertCanonicalTimestamp(
    record.deadlineAt,
    "Lease deadline",
  );
  const updatedAt = assertCanonicalTimestamp(
    record.updatedAt,
    "Lease update time",
  );
  const disposedAt =
    record.disposedAt === null
      ? null
      : assertCanonicalTimestamp(record.disposedAt, "Lease disposition time");
  assertConfiguration(record.configuration, record.experiment);
  if (
    deadlineAt - submittedAt !== record.configuration.requestTtlMs ||
    updatedAt < submittedAt ||
    preparationHashFor(record) !== record.preparationHash ||
    leaseSealHashFor(record) !== record.leaseSealHash
  ) {
    throw new ProductionBlindBrokerError(
      "lease-state-invalid",
      "Durable blind-broker lease commitments do not reproduce.",
    );
  }
  if (
    record.stage === "repair" &&
    (record.expectedValidArms !== REPAIR_VALID_ARMS ||
      record.maximumAttempts !== REPAIR_MAXIMUM_ATTEMPTS ||
      (record.repairAttemptOrdinal !== 1 &&
        record.repairAttemptOrdinal !== 2) ||
      record.repairSourceExperimentId === null ||
      !SAFE_ID.test(record.repairSourceExperimentId) ||
      record.previousDiscoveryAttestationHash === null ||
      !SHA256.test(record.previousDiscoveryAttestationHash) ||
      record.excludedEvidenceHashes.length !== 0 ||
      record.diagnosticReleaseAuthorized)
  ) {
    throw new ProductionBlindBrokerError(
      "lease-state-invalid",
      "Repair lease violates its sealed five-arm policy.",
    );
  }
  if (
    record.stage === "validation" &&
    (record.expectedValidArms !== VALIDATION_VALID_ARMS ||
      record.maximumAttempts < VALIDATION_VALID_ARMS ||
      record.maximumAttempts > VALIDATION_MAXIMUM_ATTEMPTS ||
      record.repairAttemptOrdinal !== null ||
      record.repairSourceExperimentId !== null ||
      record.previousDiscoveryAttestationHash !== null)
  ) {
    throw new ProductionBlindBrokerError(
      "lease-state-invalid",
      "Validation lease violates its sealed matched-pair policy.",
    );
  }
  const resultBearing =
    record.status === "evaluated" ||
    (record.status === "disposed" &&
      record.disposedOutcome === "decided");
  const resultFieldsComplete =
    record.aggregate !== null &&
    record.requestHash !== null &&
    record.resultDispositionAttestationHash !== null;
  const sealedUnstarted =
    record.status === "disposed" &&
    record.disposedOutcome === "sealed-unstarted";
  const championRequired =
    record.status === "running" ||
    record.status === "evaluated" ||
    record.status === "evaluation-failed" ||
    (record.status === "disposed" &&
      record.disposedOutcome === "decided");
  if (
    (championRequired && record.championCommit === null) ||
    ((record.status === "prepared" || sealedUnstarted) &&
      record.championCommit !== null)
  ) {
    throw new ProductionBlindBrokerError(
      "lease-state-invalid",
      "Lease champion binding contradicts its execution state.",
    );
  }
  if (
    (resultBearing && !resultFieldsComplete) ||
    (!resultBearing &&
      (record.aggregate !== null ||
        record.resultDispositionAttestationHash !== null)) ||
    (record.status !== "disposed") !==
      (record.disposedOutcome === null &&
        record.disposedAt === null &&
        record.dispositionAttestationHash === null)
  ) {
    throw new ProductionBlindBrokerError(
      "lease-state-invalid",
      "Lease result or disposition fields contradict its execution state.",
    );
  }
  if (
    record.status === "disposed" &&
    (disposedAt === null ||
      record.disposedOutcome === null ||
      record.dispositionAttestationHash === null ||
      disposedAt < submittedAt ||
      updatedAt < disposedAt ||
      dispositionHash(record, record.disposedOutcome, disposedAt) !==
        record.dispositionAttestationHash)
  ) {
    throw new ProductionBlindBrokerError(
      "lease-state-invalid",
      "Lease disposition attestation does not reproduce.",
    );
  }
  if (
    record.aggregate !== null &&
    (typeof record.aggregate !== "object" ||
      Array.isArray(record.aggregate) ||
      Object.getPrototypeOf(record.aggregate) !== Object.prototype ||
      (record.stage === "repair" &&
        !Object.hasOwn(record.aggregate, "attemptOrdinal")) ||
      (record.stage === "validation" &&
        !Object.hasOwn(record.aggregate, "validPairs")))
  ) {
    throw new ProductionBlindBrokerError(
      "lease-state-invalid",
      "Lease aggregate kind contradicts its evaluation stage.",
    );
  }
  const hasDiagnosticMaterial = record.diagnosticMaterial !== null;
  const hasDiagnosticReference = record.diagnosticReference !== null;
  if (
    (record.stage === "repair" &&
      (record.diagnosticStatus !== "not-authorized" ||
        hasDiagnosticMaterial ||
        hasDiagnosticReference)) ||
    (!record.diagnosticReleaseAuthorized &&
      (record.diagnosticStatus !== "not-authorized" ||
        hasDiagnosticMaterial ||
        hasDiagnosticReference)) ||
    (hasDiagnosticReference !==
      (record.diagnosticStatus === "released")) ||
    (hasDiagnosticMaterial &&
      !new Set<DiagnosticStatus>([
        "eligible",
        "releasing",
        "released",
        "burned",
      ]).has(record.diagnosticStatus)) ||
    ((record.diagnosticStatus === "eligible" ||
      record.diagnosticStatus === "releasing" ||
      record.diagnosticStatus === "released" ||
      record.diagnosticStatus === "burned") &&
      !hasDiagnosticMaterial) ||
    ((record.diagnosticStatus === "releasing" ||
      record.diagnosticStatus === "released" ||
      record.diagnosticStatus === "burned") &&
      !(
        record.status === "disposed" &&
        record.disposedOutcome === "decided"
      ))
  ) {
    throw new ProductionBlindBrokerError(
      "lease-state-invalid",
      "Lease diagnostic fields contradict their one-use release state.",
    );
  }
}

function assertLeaseState(state: DurableBlindBrokerLeaseState): void {
  assertExactPlainObjectKeys(
    state,
    ["schemaVersion", "revision", "records"],
    "Durable blind-broker lease state",
  );
  if (
    state.schemaVersion !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0
  ) {
    throw new ProductionBlindBrokerError(
      "lease-state-invalid",
      "Durable blind-broker lease state header is malformed.",
    );
  }
  if (
    state.records === null ||
    typeof state.records !== "object" ||
    Array.isArray(state.records) ||
    Object.getPrototypeOf(state.records) !== Object.prototype
  ) {
    throw new ProductionBlindBrokerError(
      "lease-state-invalid",
      "Durable blind-broker lease records must be a plain object.",
    );
  }
  const leaseTokens = new Set<string>();
  const requestIds = new Set<string>();
  for (const [key, record] of Object.entries(state.records)) {
    assertLeaseRecord(record);
    if (
      key !== record.preparationHash ||
      leaseTokens.has(record.leaseToken) ||
      requestIds.has(record.requestId)
    ) {
      throw new ProductionBlindBrokerError(
        "lease-state-invalid",
        "Durable blind-broker lease keys are detached or duplicated.",
      );
    }
    leaseTokens.add(record.leaseToken);
    requestIds.add(record.requestId);
  }
}

/**
 * Complete durable-state validator for trusted storage adapters. This export
 * intentionally exposes validation only; lease identities and hidden
 * evaluation material remain inaccessible to untrusted callers.
 */
export function assertDurableBlindBrokerLeaseState(
  value: unknown,
): asserts value is DurableBlindBrokerLeaseState {
  assertLeaseState(value as DurableBlindBrokerLeaseState);
}

class ValidatingAtomicBlindBrokerLeaseStore
  implements AtomicBlindBrokerLeaseStore
{
  readonly #delegate: AtomicBlindBrokerLeaseStore;

  public constructor(delegate: AtomicBlindBrokerLeaseStore) {
    this.#delegate = delegate;
  }

  public transact<Result>(
    operation: (state: DurableBlindBrokerLeaseState) => {
      readonly next: DurableBlindBrokerLeaseState;
      readonly result: Result;
    },
  ): Promise<Result> {
    return this.#delegate.transact((state) => {
      assertLeaseState(state);
      const transaction = operation(state);
      assertLeaseState(transaction.next);
      if (
        transaction.next !== state &&
        transaction.next.revision !== state.revision + 1
      ) {
        throw new ProductionBlindBrokerError(
          "lease-state-invalid",
          "Durable blind-broker state revision did not advance exactly once.",
        );
      }
      if (
        transaction.next === state &&
        transaction.next.revision !== state.revision
      ) {
        throw new ProductionBlindBrokerError(
          "lease-state-invalid",
          "A no-op blind-broker transaction changed its revision.",
        );
      }
      return transaction;
    });
  }
}

function leaseByToken(
  state: DurableBlindBrokerLeaseState,
  leaseToken: string,
): readonly [string, DurableBlindBrokerLeaseRecord] {
  if (!LEASE_TOKEN.test(leaseToken)) {
    throw new ProductionBlindBrokerError(
      "lease-invalid",
      "Opaque lease token is malformed.",
    );
  }
  const found = Object.entries(state.records).find(
    ([, record]) => record.leaseToken === leaseToken,
  );
  if (found === undefined) {
    throw new ProductionBlindBrokerError(
      "lease-invalid",
      "Opaque lease token is unknown.",
    );
  }
  assertLeaseRecord(found[1]);
  return found;
}

function assertArtifactForCommit(
  artifact: HarnessArtifactReference,
  commit: string,
  label: string,
): void {
  if (artifact.commitSha !== commit) {
    throw new ProductionBlindBrokerError(
      "evaluation-failed",
      `${label} resolver returned a detached immutable artifact.`,
    );
  }
}

function tokenCount(cost: {
  readonly inputTokens: number;
  readonly outputTokens: number;
}): number {
  const total = cost.inputTokens + cost.outputTokens;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ProductionBlindBrokerError(
      "release-invalid",
      "Signed evaluator token accounting is invalid.",
    );
  }
  return total;
}

function assertAggregateCost(cost: {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelUsd: number;
  readonly sandboxUsd: number;
  readonly totalUsd: number;
  readonly wallTimeMs: number;
}): void {
  if (
    !Number.isSafeInteger(cost.inputTokens) ||
    cost.inputTokens < 0 ||
    !Number.isSafeInteger(cost.outputTokens) ||
    cost.outputTokens < 0 ||
    !Number.isFinite(cost.modelUsd) ||
    cost.modelUsd < 0 ||
    !Number.isFinite(cost.sandboxUsd) ||
    cost.sandboxUsd < 0 ||
    !Number.isFinite(cost.totalUsd) ||
    cost.totalUsd < 0 ||
    !Number.isSafeInteger(cost.wallTimeMs) ||
    cost.wallTimeMs < 0 ||
    Math.abs(cost.totalUsd - (cost.modelUsd + cost.sandboxUsd)) > 1e-9
  ) {
    throw new ProductionBlindBrokerError(
      "release-invalid",
      "Signed evaluator cost accounting is invalid.",
    );
  }
}

function repairCacheStatus(
  cache: CacheAttestation,
): RepairAggregate["cacheStatus"] {
  if (cache.driftStatus === "failed") return "drift-failed";
  if (
    cache.aggregateUseStatus === "used" ||
    cache.aggregateUseStatus === "partially-used"
  ) {
    if (cache.driftStatus !== "passed") {
      throw new ProductionBlindBrokerError(
        "release-invalid",
        "Repair cache use lacks a passed drift anchor.",
      );
    }
    return "eligible";
  }
  if (cache.aggregateUseStatus === "ineligible") return "miss";
  return "not-used";
}

function diagnosticsAreAtomic(bundle: ReleasedEvaluationBundle): boolean {
  const parts = [
    bundle.behavioralRelease,
    bundle.behavioralEvidence,
    bundle.failureCards,
    bundle.diagnosticBrief,
  ];
  return parts.every((part) => part === null) || parts.every((part) => part !== null);
}

function diagnosticMaterial(
  bundle: ReleasedEvaluationBundle,
  authorized: boolean,
): StoredDiagnosticMaterial | null {
  if (!diagnosticsAreAtomic(bundle)) {
    throw new ProductionBlindBrokerError(
      "release-invalid",
      "Behavioral diagnostic artifacts are not an atomic release.",
    );
  }
  if (bundle.behavioralRelease === null) {
    if (
      bundle.result.derivation.behavioralAggregateHash !== null ||
      bundle.result.releaseChecks.privacyThresholdPassed
    ) {
      throw new ProductionBlindBrokerError(
        "release-invalid",
        "Signed result claims an absent behavioral release.",
      );
    }
    return null;
  }
  if (!authorized) {
    throw new ProductionBlindBrokerError(
      "release-invalid",
      "Evaluator emitted an unbudgeted behavioral release.",
    );
  }
  const release = bundle.behavioralRelease;
  const evidence = bundle.behavioralEvidence;
  const cards = bundle.failureCards;
  const brief = bundle.diagnosticBrief;
  const sourceResultCommitmentHash =
    resultEnvelopeBehavioralSourceCommitmentHash(bundle.result);
  if (
    evidence === null ||
    cards === null ||
    brief === null ||
    bundle.result.releaseChecks.privacyThresholdPassed !== true ||
    release.sourceResultEnvelopeHash !== sourceResultCommitmentHash ||
    bundle.result.derivation.behavioralAggregateHash !== release.contentHash ||
    release.protocolHash !== bundle.result.protocolHash ||
    release.experimentNumber !== bundle.result.experimentNumber ||
    release.releaseOnce !== true ||
    release.aggregateArtifactHashes.behavioralEvidence !== evidence.contentHash ||
    release.aggregateArtifactHashes.failureCards !== cards.contentHash ||
    release.aggregateArtifactHashes.diagnosticBrief !== brief.contentHash ||
    evidence.sourceEnvelopeHash !== sourceResultCommitmentHash ||
    evidence.protocolHash !== bundle.result.protocolHash ||
    evidence.experimentNumber !== bundle.result.experimentNumber ||
    evidence.releaseChecksPassed !== true ||
    cards.behavioralEvidenceHash !== evidence.contentHash ||
    cards.experimentNumber !== bundle.result.experimentNumber ||
    cards.suppressionApplied !== true ||
    brief.aggregateEvidenceHash !== evidence.contentHash ||
    brief.failureCardsHash !== cards.contentHash ||
    brief.experimentNumber !== bundle.result.experimentNumber ||
    brief.sourceExperimentNumber !== bundle.result.experimentNumber ||
    brief.releaseId !== release.releaseId ||
    release.suppressedFindingCountBand !==
      evidence.suppressedFindingCountBand ||
    canonicalJson(release.policyVersions) !==
      canonicalJson(evidence.policyVersions) ||
    canonicalJson(release.policyVersions) !==
      canonicalJson(cards.policyVersions) ||
    canonicalJson(release.policyVersions) !==
      canonicalJson(brief.policyVersions) ||
    canonicalJson(release.support) !==
      canonicalJson(evidence.analysisWindow.support) ||
    !release.support.complementaryCountSuppressionPassed ||
    !release.support.differencingBudgetPassed ||
    !hasValidContentHash(evidence) ||
    !hasValidContentHash(cards) ||
    !hasValidContentHash(brief)
  ) {
    throw new ProductionBlindBrokerError(
      "release-invalid",
      "Behavioral diagnostic hash lineage is detached.",
    );
  }
  return {
    behavioralRelease: release,
    behavioralEvidence: evidence,
    failureCards: cards,
    diagnosticBrief: brief,
  };
}

function assertDiagnosticReference(
  reference: DiagnosticBriefReference,
  material: StoredDiagnosticMaterial,
): void {
  if (
    reference === null ||
    typeof reference !== "object" ||
    Array.isArray(reference) ||
    Object.getPrototypeOf(reference) !== Object.prototype ||
    Object.keys(reference).length !== 3 ||
    !Object.hasOwn(reference, "hash") ||
    !Object.hasOwn(reference, "releaseId") ||
    !Object.hasOwn(reference, "actionable") ||
    reference.hash !== material.diagnosticBrief.contentHash ||
    reference.releaseId !== material.diagnosticBrief.releaseId ||
    reference.actionable !==
      (material.diagnosticBrief.status === "actionable-evidence")
  ) {
    throw new ProductionBlindBrokerError(
      "release-invalid",
      "Diagnostic publisher returned a detached reference.",
    );
  }
}

async function assertReleasedBundle(
  bundle: ReleasedEvaluationBundle,
  request: TrustedEvaluationRequest,
  signatureVerifier: TrustedAdaptiveReleaseSignatureVerifier,
  diagnosticReleaseAuthorized: boolean,
): Promise<StoredDiagnosticMaterial | null> {
  assertValidDocument("signedResultEnvelope", bundle.result);
  assertValidDocument("cacheAttestation", bundle.cacheAttestation);
  if (bundle.behavioralRelease !== null) {
    assertValidDocument("signedBehavioralRelease", bundle.behavioralRelease);
  }
  if (bundle.behavioralEvidence !== null) {
    assertValidDocument("behavioralEvidence", bundle.behavioralEvidence);
  }
  if (bundle.failureCards !== null) {
    assertValidDocument("failureCards", bundle.failureCards);
  }
  if (bundle.diagnosticBrief !== null) {
    assertValidDocument("diagnosticBrief", bundle.diagnosticBrief);
  }
  if (
    !hasValidContentHash(bundle.result) ||
    !hasValidContentHash(bundle.cacheAttestation) ||
    !(await signatureVerifier.verify(bundle.result)) ||
    !(await signatureVerifier.verify(bundle.cacheAttestation)) ||
    (bundle.behavioralRelease !== null &&
      !(await signatureVerifier.verify(bundle.behavioralRelease)))
  ) {
    throw new ProductionBlindBrokerError(
      "release-invalid",
      "Evaluator release signature or content commitment is invalid.",
    );
  }
  const result = bundle.result;
  const requestHash = hashEvaluationRequest(request);
  const expectedExperimentNumber = Number.parseInt(
    request.experimentId.split("-", 1)[0] ?? "",
    10,
  );
  if (
    result.oneUseRequest.requestId !== request.requestId ||
    result.oneUseRequest.requestHash !== requestHash ||
    result.oneUseRequest.reuseProhibited !== true ||
    !Number.isSafeInteger(expectedExperimentNumber) ||
    result.experimentNumber !== expectedExperimentNumber ||
    result.mode !== request.runMode ||
    result.protocolHash !== request.protocolHash ||
    result.payload.kind !== request.stage ||
    result.derivation.rawArtifacts.exported !== false ||
    result.derivation.rawArtifacts.retentionDisposition !== "destroyed" ||
    result.releaseChecks.schemaPassed !== true ||
    result.releaseChecks.graderCanaryScanPassed !== true ||
    result.releaseChecks.contentFingerprintScanPassed !== true ||
    result.releaseChecks.taskIdentityScanPassed !== true ||
    result.derivation.cacheAttestationHash !==
      bundle.cacheAttestation.contentHash ||
    bundle.cacheAttestation.experimentNumber !== result.experimentNumber ||
    bundle.cacheAttestation.protocolHash !== request.protocolHash ||
    !bundle.cacheAttestation.repairBudgetCompliant
  ) {
    throw new ProductionBlindBrokerError(
      "release-invalid",
      "Signed evaluator release is detached from its one-use request.",
    );
  }
  if (
    request.stage !== "validation" &&
    bundle.behavioralRelease !== null
  ) {
    throw new ProductionBlindBrokerError(
      "release-invalid",
      "Only validation may release behavioral diagnostics.",
    );
  }
  assertSafeForLocalPersistence(bundle);
  return diagnosticMaterial(bundle, diagnosticReleaseAuthorized);
}

function mapRepairAggregate(
  record: DurableBlindBrokerLeaseRecord,
  bundle: ReleasedEvaluationBundle,
): RepairAggregate {
  const payload = bundle.result.payload;
  if (
    payload.kind !== "repair" ||
    record.repairAttemptOrdinal === null ||
    payload.attemptOrdinal !== record.repairAttemptOrdinal ||
    (payload.disposition === "passed" && payload.integrityStatus !== "passed")
  ) {
    throw new ProductionBlindBrokerError(
      "release-invalid",
      "Repair release contradicts its frozen lease.",
    );
  }
  assertAggregateCost(payload.aggregateCost);
  return {
    disposition:
      payload.disposition === "passed"
        ? "passed"
        : payload.disposition === "failed"
          ? "rejected"
          : "inconclusive",
    attemptOrdinal: record.repairAttemptOrdinal,
    integrityPassed: payload.integrityStatus === "passed",
    cacheStatus: repairCacheStatus(bundle.cacheAttestation),
    aggregateCostUsd: payload.aggregateCost.totalUsd,
    tokens: tokenCount(payload.aggregateCost),
    wallTimeMs: payload.aggregateCost.wallTimeMs,
    // The current signed repair release deliberately exposes no per-attempt
    // row or replacement count. Charge the entire presealed 5+4 allowance so
    // crashes or hidden invalid attempts can never make the public budget low.
    attempts: record.maximumAttempts,
    attestationHash: bundle.result.contentHash,
  };
}

function mapValidationAggregate(
  record: DurableBlindBrokerLeaseRecord,
  bundle: ReleasedEvaluationBundle,
  diagnostics: StoredDiagnosticMaterial | null,
): ValidationAggregate {
  const payload = bundle.result.payload;
  if (
    payload.kind !== "validation" ||
    payload.matchedTaskCount !== 12 ||
    payload.validFreshArmCount !== VALIDATION_VALID_ARMS ||
    payload.invalidArmTotal < 0 ||
    payload.validFreshArmCount + payload.invalidArmTotal >
      record.maximumAttempts ||
    Object.values(payload.pairOutcomeTotals).reduce(
      (total, count) => total + count,
      0,
    ) !== 12 ||
    bundle.cacheAttestation.aggregateUseStatus === "used" ||
    bundle.cacheAttestation.aggregateUseStatus === "partially-used"
  ) {
    throw new ProductionBlindBrokerError(
      "release-invalid",
      "Validation release is not exactly twelve fresh matched pairs.",
    );
  }
  assertAggregateCost(payload.aggregateCost);
  const replacements = payload.invalidArmTotal;
  return {
    disposition:
      payload.disposition === "promote"
        ? "promoted"
        : payload.disposition === "reject"
          ? "rejected"
          : "inconclusive",
    validPairs: payload.matchedTaskCount,
    validArms: payload.validFreshArmCount,
    replacementAttempts: replacements,
    probabilityPositive: payload.weightedAccuracy.probabilityPositive,
    medianAccuracyDelta: payload.weightedAccuracy.medianDelta,
    requiredPosteriorProbability: payload.requiredPosteriorProbability,
    onlineGateAuthorized: payload.onlineGateAuthorized,
    onlineErrorBudget: payload.onlineErrorBudget,
    stratumRegressionVeto: payload.stratumRegressionVeto,
    integrityVeto: payload.integrityVeto,
    correctnessVeto: payload.correctnessVeto,
    capabilityVeto: payload.capabilityVeto,
    costWithinGuardrail: payload.costWithinGuardrail,
    latencyWithinGuardrail: payload.latencyWithinGuardrail,
    accuracyTradeoffPredeclared: payload.accuracyTradeoffPredeclared,
    aggregateCostUsd: payload.aggregateCost.totalUsd,
    tokens: tokenCount(payload.aggregateCost),
    wallTimeMs: payload.aggregateCost.wallTimeMs,
    attestationHash: bundle.result.contentHash,
    releasedEvidenceHash: diagnostics?.diagnosticBrief.contentHash ?? null,
    behavioralSourceCommitmentHash:
      diagnostics === null
        ? null
        : resultEnvelopeBehavioralSourceCommitmentHash(bundle.result),
    attemptAccounting: {
      policyVersion: VALIDATION_ATTEMPT_LEDGER_POLICY_VERSION,
      terminalStatus: "complete",
      presealedPairCount: 12,
      presealedArmCount: 24,
      validArmCount: 24,
      attemptedArmCount: 24,
      unresolvedArmCount: 0,
      totalAttemptCount: 24 + replacements,
      replacementAttemptCount: replacements,
      infrastructureFailureCount: replacements,
      nonInfrastructureFailureCount: 0,
      containsPanelHandle: false,
      containsTaskIdentifiers: false,
      containsCellIdentifiers: false,
      containsAttemptIdentifiers: false,
      containsEvidenceIdentifiers: false,
    },
  };
}

export class ProductionBlindBroker implements BlindBroker {
  readonly #options: ProductionBlindBrokerOptions;
  readonly #store: AtomicBlindBrokerLeaseStore;
  readonly #now: () => Date;
  readonly #leaseTokenFactory: () => string;

  public constructor(options: ProductionBlindBrokerOptions) {
    this.#options = options;
    this.#store = new ValidatingAtomicBlindBrokerLeaseStore(options.store);
    this.#now = options.now ?? (() => new Date());
    this.#leaseTokenFactory =
      options.leaseTokenFactory ??
      (() => `lease-${randomBytes(32).toString("base64url")}`);
  }

  public async prepareRepair(
    input: Parameters<BlindBroker["prepareRepair"]>[0],
  ): Promise<EphemeralPanelLease> {
    assertHash(input.hypothesisHash, "Hypothesis");
    assertHash(
      input.previousDiscoveryAttestationHash,
      "Previous discovery attestation",
    );
    if (!GIT_OBJECT.test(input.candidateCommit)) {
      throw new ProductionBlindBrokerError(
        "lease-invalid",
        "Candidate commit is malformed.",
      );
    }
    const configuration = await this.#options.configurations.resolve(
      input.experiment,
    );
    assertConfiguration(configuration, input.experiment);
    const source = await this.#options.repairDiscovery.resolve({
      experiment: input.experiment,
      discoveryAttestationHash:
        input.previousDiscoveryAttestationHash,
    });
    if (
      source.discoveryAttestationHash !==
        input.previousDiscoveryAttestationHash ||
      !SAFE_ID.test(source.sourceExperimentId) ||
      source.sourceExperimentId === experimentId(input.experiment)
    ) {
      throw new ProductionBlindBrokerError(
        "lease-invalid",
        "Repair discovery binding is detached.",
      );
    }
    return this.#prepare({
      experiment: input.experiment,
      stage: "repair",
      hypothesisHash: input.hypothesisHash,
      candidateCommit: input.candidateCommit,
      repairAttemptOrdinal: input.attemptOrdinal,
      repairSourceExperimentId: source.sourceExperimentId,
      previousDiscoveryAttestationHash:
        input.previousDiscoveryAttestationHash,
      excludedEvidenceHashes: [],
      diagnosticReleaseAuthorized: false,
      configuration,
      expectedValidArms: REPAIR_VALID_ARMS,
      maximumAttempts: REPAIR_MAXIMUM_ATTEMPTS,
    });
  }

  public async prepareValidation(
    input: Parameters<BlindBroker["prepareValidation"]>[0],
  ): Promise<EphemeralPanelLease> {
    assertHash(input.hypothesisHash, "Hypothesis");
    if (
      !GIT_OBJECT.test(input.candidateCommit) ||
      !Number.isSafeInteger(input.remainingExperimentAttempts) ||
      input.remainingExperimentAttempts < VALIDATION_VALID_ARMS
    ) {
      throw new ProductionBlindBrokerError(
        "lease-invalid",
        "Fresh validation request cannot satisfy its sealed attempt budget.",
      );
    }
    const excluded = [...input.excludedEvidenceHashes].sort();
    if (
      excluded.some((hash) => !SHA256.test(hash)) ||
      new Set(excluded).size !== excluded.length
    ) {
      throw new ProductionBlindBrokerError(
        "lease-invalid",
        "Fresh validation exclusions are malformed or duplicated.",
      );
    }
    const configuration = await this.#options.configurations.resolve(
      input.experiment,
    );
    assertConfiguration(configuration, input.experiment);
    return this.#prepare({
      experiment: input.experiment,
      stage: "validation",
      hypothesisHash: input.hypothesisHash,
      candidateCommit: input.candidateCommit,
      repairAttemptOrdinal: null,
      repairSourceExperimentId: null,
      previousDiscoveryAttestationHash: null,
      excludedEvidenceHashes: excluded,
      diagnosticReleaseAuthorized: input.diagnosticReleaseAuthorized,
      configuration,
      expectedValidArms: VALIDATION_VALID_ARMS,
      maximumAttempts: Math.min(
        VALIDATION_MAXIMUM_ATTEMPTS,
        input.remainingExperimentAttempts,
      ),
    });
  }

  async #prepare(input: {
    readonly experiment: ExperimentIdentity;
    readonly stage: AdaptiveStage;
    readonly hypothesisHash: string;
    readonly candidateCommit: string;
    readonly repairAttemptOrdinal: 1 | 2 | null;
    readonly repairSourceExperimentId: string | null;
    readonly previousDiscoveryAttestationHash: string | null;
    readonly excludedEvidenceHashes: readonly string[];
    readonly diagnosticReleaseAuthorized: boolean;
    readonly configuration: BlindBrokerEvaluationConfiguration;
    readonly expectedValidArms: number;
    readonly maximumAttempts: number;
  }): Promise<EphemeralPanelLease> {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new ProductionBlindBrokerError(
        "configuration-invalid",
        "Trusted clock is invalid.",
      );
    }
    const submittedAt = now.toISOString();
    const deadlineAt = new Date(
      now.getTime() + input.configuration.requestTtlMs,
    ).toISOString();
    const preparationHash = canonicalHash({
      domain: "dark-factory.blind-broker.preparation.v1",
      experiment: input.experiment,
      stage: input.stage,
      hypothesisHash: input.hypothesisHash,
      candidateCommit: input.candidateCommit,
      repairAttemptOrdinal: input.repairAttemptOrdinal,
      repairSourceExperimentId: input.repairSourceExperimentId,
      previousDiscoveryAttestationHash:
        input.previousDiscoveryAttestationHash,
      excludedEvidenceHashes: input.excludedEvidenceHashes,
      diagnosticReleaseAuthorized: input.diagnosticReleaseAuthorized,
      configuration: input.configuration,
      expectedValidArms: input.expectedValidArms,
      maximumAttempts: input.maximumAttempts,
    });
    return this.#store.transact((state) => {
      const existing = state.records[preparationHash];
      if (existing !== undefined) {
        assertLeaseRecord(existing);
        if (existing.status !== "prepared") {
          throw new ProductionBlindBrokerError(
            "lease-conflict",
            "This immutable evaluation preparation has already started.",
          );
        }
        return {
          next: state,
          result: {
            leaseToken: existing.leaseToken,
            attestationHash: existing.leaseSealHash,
            expectedValidArms: existing.expectedValidArms,
            maximumAttempts: existing.maximumAttempts,
          },
        };
      }
      const leaseToken = this.#leaseTokenFactory();
      if (
        !LEASE_TOKEN.test(leaseToken) ||
        Object.values(state.records).some(
          (record) => record.leaseToken === leaseToken,
        )
      ) {
        throw new ProductionBlindBrokerError(
          "configuration-invalid",
          "Lease token source returned a malformed or repeated token.",
        );
      }
      const requestId = [
        "eval",
        String(input.experiment.number),
        input.stage,
        canonicalHash(leaseToken).slice(0, 24),
      ].join("-");
      const leaseSealHash = canonicalHash({
        domain: "dark-factory.blind-broker.lease-seal.v1",
        preparationHash,
        leaseTokenCommitment: canonicalHash(leaseToken),
        requestId,
        submittedAt,
        deadlineAt,
      });
      const record: DurableBlindBrokerLeaseRecord = {
        schemaVersion: 1,
        preparationHash,
        leaseToken,
        leaseSealHash,
        requestId,
        experiment: input.experiment,
        stage: input.stage,
        status: "prepared",
        diagnosticStatus: input.diagnosticReleaseAuthorized
          ? "unavailable"
          : "not-authorized",
        hypothesisHash: input.hypothesisHash,
        candidateCommit: input.candidateCommit,
        championCommit: null,
        repairAttemptOrdinal: input.repairAttemptOrdinal,
        repairSourceExperimentId: input.repairSourceExperimentId,
        previousDiscoveryAttestationHash:
          input.previousDiscoveryAttestationHash,
        excludedEvidenceHashes: input.excludedEvidenceHashes,
        diagnosticReleaseAuthorized:
          input.diagnosticReleaseAuthorized,
        configuration: input.configuration,
        submittedAt,
        deadlineAt,
        expectedValidArms: input.expectedValidArms,
        maximumAttempts: input.maximumAttempts,
        requestHash: null,
        resultDispositionAttestationHash: null,
        aggregate: null,
        diagnosticMaterial: null,
        diagnosticReference: null,
        disposedOutcome: null,
        disposedAt: null,
        dispositionAttestationHash: null,
        updatedAt: submittedAt,
      };
      assertLeaseRecord(record);
      return {
        next: nextState(state, {
          ...state.records,
          [preparationHash]: record,
        }),
        result: {
          leaseToken,
          attestationHash: leaseSealHash,
          expectedValidArms: input.expectedValidArms,
          maximumAttempts: input.maximumAttempts,
        },
      };
    });
  }

  public async runRepair(
    input: Parameters<BlindBroker["runRepair"]>[0],
  ): Promise<RepairAggregate> {
    const result = await this.#run(
      "repair",
      input.experiment,
      input.leaseToken,
      input.candidateCommit,
      input.activeChampionCommit,
    );
    if (result.stage !== "repair") {
      throw new ProductionBlindBrokerError(
        "lease-state-invalid",
        "Repair evaluation returned another aggregate kind.",
      );
    }
    return result.aggregate;
  }

  public async runValidation(
    input: Parameters<BlindBroker["runValidation"]>[0],
  ): Promise<ValidationAggregate> {
    const result = await this.#run(
      "validation",
      input.experiment,
      input.leaseToken,
      input.candidateCommit,
      input.activeChampionCommit,
    );
    if (result.stage !== "validation") {
      throw new ProductionBlindBrokerError(
        "lease-state-invalid",
        "Validation evaluation returned another aggregate kind.",
      );
    }
    return result.aggregate;
  }

  async #run(
    stage: AdaptiveStage,
    experiment: ExperimentIdentity,
    leaseToken: string,
    candidateCommit: string,
    championCommit: string,
  ): Promise<
    | { readonly stage: "repair"; readonly aggregate: RepairAggregate }
    | { readonly stage: "validation"; readonly aggregate: ValidationAggregate }
  > {
    if (
      !GIT_OBJECT.test(candidateCommit) ||
      !GIT_OBJECT.test(championCommit) ||
      candidateCommit === championCommit
    ) {
      throw new ProductionBlindBrokerError(
        "lease-invalid",
        "Matched evaluation commits are malformed or identical.",
      );
    }
    const claimed = await this.#store.transact((state) => {
      const [key, record] = leaseByToken(state, leaseToken);
      assertExperimentMatches(record.experiment, experiment);
      if (
        record.stage !== stage ||
        record.candidateCommit !== candidateCommit
      ) {
        throw new ProductionBlindBrokerError(
          "lease-conflict",
          "Evaluation invocation does not match its immutable lease.",
        );
      }
      if (
        record.championCommit !== null &&
        record.championCommit !== championCommit
      ) {
        throw new ProductionBlindBrokerError(
          "lease-conflict",
          "Evaluation replay does not match its frozen champion.",
        );
      }
      if (
        (record.status === "evaluated" ||
          (record.status === "disposed" &&
            record.disposedOutcome === "decided")) &&
        record.aggregate !== null
      ) {
        return { next: state, result: { key, record, replayed: true } };
      }
      if (record.status !== "prepared") {
        throw new ProductionBlindBrokerError(
          "lease-state-invalid",
          "Opaque lease cannot start in its current one-use state.",
        );
      }
      const running: DurableBlindBrokerLeaseRecord = {
        ...record,
        status: "running",
        championCommit,
        updatedAt: this.#now().toISOString(),
      };
      return {
        next: nextState(state, {
          ...state.records,
          [key]: running,
        }),
        result: { key, record: running, replayed: false },
      };
    });
    if (claimed.replayed) {
      const aggregate = claimed.record.aggregate;
      if (stage === "repair" && aggregate !== null && "attemptOrdinal" in aggregate) {
        await this.#disposeByKey(claimed.key, "decided");
        return { stage, aggregate };
      }
      if (stage === "validation" && aggregate !== null && "validPairs" in aggregate) {
        return { stage, aggregate };
      }
      throw new ProductionBlindBrokerError(
        "lease-state-invalid",
        "Durable replay aggregate kind is invalid.",
      );
    }

    try {
      if (Date.parse(claimed.record.deadlineAt) <= this.#now().getTime()) {
        throw new ProductionBlindBrokerError(
          "evaluation-failed",
          "Opaque evaluation lease expired before execution.",
        );
      }
      const [candidate, champion] = await Promise.all([
        this.#options.artifacts.resolve(candidateCommit),
        this.#options.artifacts.resolve(championCommit),
      ]);
      assertArtifactForCommit(candidate, candidateCommit, "Candidate");
      assertArtifactForCommit(champion, championCommit, "Champion");
      const request = this.#request(claimed.record, candidate, champion);
      const requestHash = hashEvaluationRequest(request);
      await this.#store.transact((state) => {
        const record = state.records[claimed.key];
        if (
          record === undefined ||
          record.status !== "running" ||
          record.requestHash !== null
        ) {
          throw new ProductionBlindBrokerError(
            "lease-state-invalid",
            "Evaluation request lost its exclusive lease claim.",
          );
        }
        return {
          next: nextState(state, {
            ...state.records,
            [claimed.key]: {
              ...record,
              requestHash,
              updatedAt: this.#now().toISOString(),
            },
          }),
          result: undefined,
        };
      });
      const bundle = await this.#options.evaluator.evaluate(request);
      const diagnostics = await assertReleasedBundle(
        bundle,
        request,
        this.#options.signatureVerifier,
        claimed.record.diagnosticReleaseAuthorized,
      );
      const aggregate =
        stage === "repair"
          ? mapRepairAggregate(claimed.record, bundle)
          : mapValidationAggregate(claimed.record, bundle, diagnostics);
      await this.#store.transact((state) => {
        const record = state.records[claimed.key];
        if (
          record === undefined ||
          record.status !== "running" ||
          record.requestHash !== requestHash
        ) {
          throw new ProductionBlindBrokerError(
            "lease-state-invalid",
            "Evaluator result lost its exclusive lease claim.",
          );
        }
        const evaluated: DurableBlindBrokerLeaseRecord = {
          ...record,
          status: "evaluated",
          resultDispositionAttestationHash:
            bundle.result.oneUseRequest.dispositionAttestationHash,
          aggregate,
          diagnosticMaterial: diagnostics,
          diagnosticStatus:
            diagnostics === null
              ? record.diagnosticReleaseAuthorized
                ? "unavailable"
                : "not-authorized"
              : "eligible",
          updatedAt: this.#now().toISOString(),
        };
        return {
          next: nextState(state, {
            ...state.records,
            [claimed.key]: evaluated,
          }),
          result: undefined,
        };
      });
      if (stage === "repair") {
        await this.#disposeByKey(claimed.key, "decided");
        return { stage, aggregate: aggregate as RepairAggregate };
      }
      return { stage, aggregate: aggregate as ValidationAggregate };
    } catch (error) {
      await this.#failEvaluation(claimed.key, stage);
      if (error instanceof ProductionBlindBrokerError) {
        throw error;
      }
      throw new ProductionBlindBrokerError(
        "evaluation-failed",
        "Trusted matched evaluation failed and its one-use lease was burned.",
      );
    }
  }

  #request(
    record: DurableBlindBrokerLeaseRecord,
    candidate: HarnessArtifactReference,
    champion: HarnessArtifactReference,
  ): TrustedEvaluationRequest {
    const selection =
      record.stage === "repair"
        ? {
            kind: "repair-reuse" as const,
            sourceExperimentId:
              record.repairSourceExperimentId ??
              (() => {
                throw new ProductionBlindBrokerError(
                  "lease-state-invalid",
                  "Repair source binding is absent.",
                );
              })(),
            taskCount: 5 as const,
            attemptsPerTask: 1 as const,
            candidateAttempt:
              record.repairAttemptOrdinal ??
              (() => {
                throw new ProductionBlindBrokerError(
                  "lease-state-invalid",
                  "Repair attempt ordinal is absent.",
                );
              })(),
            frozenHypothesisHash: record.hypothesisHash,
          }
        : {
            kind: "fresh-matched-validation" as const,
            taskCount: 12 as const,
            attemptsPerArm: 1 as const,
            pairOrder: "balanced-6-ab-6-ba" as const,
            weightingPolicyHash:
              record.configuration.weightingPolicyHash,
            frozenHypothesisHash: record.hypothesisHash,
            hypothesisExclusionAttestationHash: canonicalHash({
              domain:
                "dark-factory.validation-hypothesis-exclusion.v1",
              hypothesisHash: record.hypothesisHash,
              candidateArchiveSha256: candidate.archiveSha256,
              excludedEvidenceHashes: record.excludedEvidenceHashes,
            }),
          };
    const request: TrustedEvaluationRequest = {
      schemaVersion: 1,
      requestId: record.requestId,
      experimentId: experimentId(record.experiment),
      runMode: "research",
      stage: record.stage,
      submittedAt: record.submittedAt,
      deadlineAt: record.deadlineAt,
      protocolHash: record.experiment.protocolHash,
      complianceManifestHash:
        record.configuration.complianceManifestHash,
      candidate,
      champion,
      selection,
      executionProfile: record.configuration.executionProfile,
      evaluatedModel: record.configuration.evaluatedModel,
    };
    assertEvaluationRequest(request);
    return request;
  }

  async #failEvaluation(
    key: string,
    stage: AdaptiveStage,
  ): Promise<void> {
    await this.#store.transact((state) => {
      const record = state.records[key];
      if (
        record === undefined ||
        record.status === "disposed" ||
        record.status === "evaluated"
      ) {
        return { next: state, result: undefined };
      }
      const failed: DurableBlindBrokerLeaseRecord = {
        ...record,
        status: "evaluation-failed",
        updatedAt: this.#now().toISOString(),
      };
      return {
        next: nextState(state, {
          ...state.records,
          [key]: failed,
        }),
        result: undefined,
      };
    });
    if (stage === "repair") {
      await this.#disposeByKey(key, "started-abandoned");
    }
  }

  public consumeOrQuarantine(
    input: Parameters<BlindBroker["consumeOrQuarantine"]>[0],
  ): Promise<{ readonly dispositionAttestationHash: string }> {
    return this.#store.transact((state) => {
      const [key, record] = leaseByToken(state, input.leaseToken);
      if (record.leaseSealHash !== input.attestationHash) {
        throw new ProductionBlindBrokerError(
          "lease-conflict",
          "Lease seal does not match the opaque token.",
        );
      }
      if (record.status === "disposed") {
        if (
          record.disposedOutcome !== input.outcome ||
          record.dispositionAttestationHash === null
        ) {
          throw new ProductionBlindBrokerError(
            "lease-state-invalid",
            "Disposed lease cannot change its terminal outcome.",
          );
        }
        return {
          next: state,
          result: {
            dispositionAttestationHash:
              record.dispositionAttestationHash,
          },
        };
      }
      assertDispositionTransition(record, input.outcome);
      const disposedAt = this.#now().toISOString();
      const dispositionAttestationHash = dispositionHash(
        record,
        input.outcome,
        disposedAt,
      );
      const disposed: DurableBlindBrokerLeaseRecord = {
        ...record,
        status: "disposed",
        disposedOutcome: input.outcome,
        disposedAt,
        dispositionAttestationHash,
        updatedAt: disposedAt,
      };
      return {
        next: nextState(state, {
          ...state.records,
          [key]: disposed,
        }),
        result: { dispositionAttestationHash },
      };
    });
  }

  async #disposeByKey(
    key: string,
    outcome: LeaseOutcome,
  ): Promise<string> {
    return this.#store.transact((state) => {
      const record = state.records[key];
      if (record === undefined) {
        throw new ProductionBlindBrokerError(
          "lease-state-invalid",
          "Lease disappeared before terminal disposition.",
        );
      }
      if (record.status === "disposed") {
        if (
          record.disposedOutcome !== outcome ||
          record.dispositionAttestationHash === null
        ) {
          throw new ProductionBlindBrokerError(
            "lease-state-invalid",
            "Disposed lease cannot change its terminal outcome.",
          );
        }
        return {
          next: state,
          result: record.dispositionAttestationHash,
        };
      }
      assertDispositionTransition(record, outcome);
      const disposedAt = this.#now().toISOString();
      const attestation = dispositionHash(record, outcome, disposedAt);
      return {
        next: nextState(state, {
          ...state.records,
          [key]: {
            ...record,
            status: "disposed",
            disposedOutcome: outcome,
            disposedAt,
            dispositionAttestationHash: attestation,
            updatedAt: disposedAt,
          },
        }),
        result: attestation,
      };
    });
  }

  public async releaseDiagnosticBrief(
    input: Parameters<BlindBroker["releaseDiagnosticBrief"]>[0],
  ): Promise<DiagnosticBriefReference | null> {
    if (input.releaseAuthorized !== true) {
      throw new ProductionBlindBrokerError(
        "diagnostic-unavailable",
        "Diagnostic release requires an explicit one-use authorization.",
      );
    }
    const claimed = await this.#store.transact((state) => {
      const found = Object.entries(state.records).find(
        ([, record]) =>
          record.stage === "validation" &&
          record.aggregate !== null &&
          "validPairs" in record.aggregate &&
          record.aggregate.attestationHash ===
            input.validationAttestationHash,
      );
      if (found === undefined) {
        throw new ProductionBlindBrokerError(
          "diagnostic-unavailable",
          "Validation attestation has no releasable diagnostic.",
        );
      }
      const [key, record] = found;
      assertExperimentMatches(record.experiment, input.experiment);
      if (
        record.status !== "disposed" ||
        record.disposedOutcome !== "decided" ||
        !record.diagnosticReleaseAuthorized
      ) {
        throw new ProductionBlindBrokerError(
          "diagnostic-unavailable",
          "Diagnostic release is not authorized for this disposed validation.",
        );
      }
      if (
        record.diagnosticStatus === "unavailable" &&
        record.diagnosticMaterial === null
      ) {
        return { next: state, result: null };
      }
      if (
        record.diagnosticStatus === "released" &&
        record.diagnosticMaterial !== null &&
        record.diagnosticReference !== null
      ) {
        assertDiagnosticReference(
          record.diagnosticReference,
          record.diagnosticMaterial,
        );
        return {
          next: state,
          result: {
            reference: record.diagnosticReference,
          },
        };
      }
      if (
        record.diagnosticStatus === "releasing" &&
        record.diagnosticMaterial !== null
      ) {
        return {
          next: state,
          result: { key, record },
        };
      }
      if (
        record.diagnosticStatus !== "eligible" ||
        record.diagnosticMaterial === null ||
        Date.parse(record.diagnosticMaterial.diagnosticBrief.expiresAt) <=
          this.#now().getTime()
      ) {
        throw new ProductionBlindBrokerError(
          "diagnostic-unavailable",
          "Diagnostic brief is one-use and no longer eligible.",
        );
      }
      const releasing: DurableBlindBrokerLeaseRecord = {
        ...record,
        diagnosticStatus: "releasing",
        updatedAt: this.#now().toISOString(),
      };
      return {
        next: nextState(state, {
          ...state.records,
          [key]: releasing,
        }),
        result: { key, record: releasing },
      };
    });
    if (claimed === null) return null;
    if ("reference" in claimed) return claimed.reference;

    const material = claimed.record.diagnosticMaterial;
    if (material === null) {
      throw new ProductionBlindBrokerError(
        "lease-state-invalid",
        "Claimed diagnostic material disappeared.",
      );
    }
    try {
      const reference =
        await this.#options.diagnosticPublisher.publishOnce({
          publicationId: `brief-${input.validationAttestationHash.slice(0, 48)}`,
          sourceResultEnvelopeHash:
            material.behavioralRelease.sourceResultEnvelopeHash,
          ...material,
        });
      assertDiagnosticReference(reference, material);
      return await this.#store.transact((state) => {
        const record = state.records[claimed.key];
        if (
          record?.diagnosticStatus === "released" &&
          record.diagnosticMaterial !== null &&
          record.diagnosticReference !== null
        ) {
          assertDiagnosticReference(
            record.diagnosticReference,
            record.diagnosticMaterial,
          );
          assertDiagnosticReference(reference, record.diagnosticMaterial);
          if (canonicalJson(record.diagnosticReference) !== canonicalJson(reference)) {
            throw new ProductionBlindBrokerError(
              "lease-state-invalid",
              "Concurrent diagnostic publication returned conflicting references.",
            );
          }
          return {
            next: state,
            result: record.diagnosticReference,
          };
        }
        if (
          record === undefined ||
          record.diagnosticStatus !== "releasing"
        ) {
          throw new ProductionBlindBrokerError(
            "lease-state-invalid",
            "Diagnostic one-use claim was lost before publication.",
          );
        }
        return {
          next: nextState(state, {
            ...state.records,
            [claimed.key]: {
              ...record,
              diagnosticStatus: "released",
              diagnosticReference: reference,
              updatedAt: this.#now().toISOString(),
            },
          }),
          result: reference,
        };
      });
    } catch (error) {
      if (
        error instanceof ProductionBlindBrokerError &&
        error.code === "release-invalid"
      ) {
        await this.#store.transact((state) => {
          const record = state.records[claimed.key];
          if (
            record === undefined ||
            record.diagnosticStatus !== "releasing"
          ) {
            return { next: state, result: undefined };
          }
          return {
            next: nextState(state, {
              ...state.records,
              [claimed.key]: {
                ...record,
                diagnosticStatus: "burned",
                updatedAt: this.#now().toISOString(),
              },
            }),
            result: undefined,
          };
        });
      }
      if (error instanceof ProductionBlindBrokerError) throw error;
      throw new ProductionBlindBrokerError(
        "diagnostic-unavailable",
        "Diagnostic publication failed; its idempotent one-use claim remains recoverable.",
      );
    }
  }
}

function assertDispositionTransition(
  record: DurableBlindBrokerLeaseRecord,
  outcome: LeaseOutcome,
): void {
  const allowed =
    (outcome === "decided" && record.status === "evaluated") ||
    (outcome === "started-abandoned" &&
      (record.status === "prepared" ||
        record.status === "running" ||
        record.status === "evaluation-failed")) ||
    (outcome === "sealed-unstarted" && record.status === "prepared");
  if (!allowed) {
    throw new ProductionBlindBrokerError(
      "lease-state-invalid",
      "Lease outcome does not match its durable execution state.",
    );
  }
}

function dispositionHash(
  record: DurableBlindBrokerLeaseRecord,
  outcome: LeaseOutcome,
  disposedAt: string,
): string {
  return canonicalHash({
    domain: "dark-factory.blind-broker.disposition.v1",
    leaseSealHash: record.leaseSealHash,
    requestHash: record.requestHash,
    resultDispositionAttestationHash:
      record.resultDispositionAttestationHash,
    outcome,
    disposedAt,
  });
}
