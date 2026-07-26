import type { KeyLike } from "node:crypto";
import { verifyEd25519Signature } from "../evidence/signatures.js";
import type { LeakScanSubject } from "../evidence/store.js";
import type {
  ReleaseSafeExperimentArtifactSet,
  ReleaseSafeFinalExperimentSnapshot,
  TrustedExperimentSealAuthority,
  TrustedExperimentSealAuthorization,
  TrustedJournalInterruptionAttestor,
  TrustedReleaseSafeExperimentArtifactAssembler,
} from "../orchestrator/experiment-journal.js";
import type { Attestation, LeakScanReceipt } from "../schemas/artifacts.js";
import {
  canonicalHash,
  canonicalJson,
  hasValidContentHash,
  withContentHash,
} from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import {
  artifactFileSchemas,
  assertValidDocument,
  REQUIRED_PRESEAL_ARTIFACT_FILES,
} from "../schemas/registry.js";
import { assertReleaseSafe } from "../schemas/safety.js";
import {
  type MountedVolumeDurableStateOptions,
  MountedVolumeTransactionalJsonStore,
} from "./mounted-volume-state.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/u;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,199}$/u;
const POLICY_ARTIFACT_FILES = [
  "analysis.json",
  "decision.json",
  "experiment.json",
  "feedback-entry.json",
  "hypothesis.json",
] as const;
const PROVENANCE_ARTIFACT_FILES = [
  "behavioral-evidence.json",
  "cache-attestation.json",
  "candidate.json",
  "diagnostic-brief.json",
  "evaluation-plan.json",
  "failure-cards.json",
  "results.json",
] as const;
const PINNED_VERSION_KEYS = [
  "node",
  "darkFactory",
  "terminalBench",
  "harbor",
  "piCommit",
  "claudeCode",
  "optimizerModel",
  "evaluatedModel",
  "sandboxImageDigest",
] as const;

type PolicyArtifactFile = (typeof POLICY_ARTIFACT_FILES)[number];
type ProvenanceArtifactFile = (typeof PROVENANCE_ARTIFACT_FILES)[number];
type PolicyArtifactSet = Pick<ReleaseSafeExperimentArtifactSet, PolicyArtifactFile>;
type ProvenanceArtifactSet = Pick<ReleaseSafeExperimentArtifactSet, ProvenanceArtifactFile>;

export class ExperimentJournalAuthorityError extends Error {
  override readonly name = "ExperimentJournalAuthorityError";
}

function fail(message: string): never {
  throw new ExperimentJournalAuthorityError(message);
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

function cloneJson<Value>(value: Value, label: string): Value {
  try {
    return JSON.parse(canonicalJson(value)) as Value;
  } catch {
    return fail(`${label} is not canonical JSON.`);
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertNullableHash(value: unknown, label: string): void {
  if (value !== null) assertHash(value, label);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail(`${label} must be a canonical timestamp.`);
  }
}

function assertSnapshot(value: unknown): asserts value is ReleaseSafeFinalExperimentSnapshot {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "assemblyRequestHash",
      "experimentName",
      "experiment",
      "startedAt",
      "finishedAt",
      "activeChampionBefore",
      "initialBudget",
      "finalBudget",
      "proposal",
      "gates",
      "repair",
      "validation",
      "analysisHash",
      "disposition",
      "evaluationStage",
      "promotedCandidate",
      "diagnosticBrief",
    ],
    "Experiment artifact assembly snapshot",
  );
  const snapshot = value as unknown as ReleaseSafeFinalExperimentSnapshot;
  assertHash(snapshot.assemblyRequestHash, "Assembly request hash");
  const { assemblyRequestHash: _assemblyRequestHash, ...withoutHash } = snapshot;
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.assemblyRequestHash !==
      canonicalHash({
        domain: "dark-factory.release-safe-experiment-assembly.v1",
        ...withoutHash,
      })
  ) {
    fail("Experiment assembly request commitment is invalid.");
  }
  assertReleaseSafe(snapshot);
}

function assertArtifactSubset(
  value: unknown,
  expected: readonly (PolicyArtifactFile | ProvenanceArtifactFile)[],
  experimentNumber: number,
  label: string,
): void {
  assertExactKeys(value, expected, label);
  for (const fileName of expected) {
    const document: unknown = value[fileName];
    assertValidDocument(artifactFileSchemas[fileName], document);
    if (!hasValidContentHash(document)) {
      fail(`${label} ${fileName} has an invalid content commitment.`);
    }
    assertReleaseSafe(document);
    if (!isPlainRecord(document) || document.experimentNumber !== experimentNumber) {
      fail(`${label} ${fileName} belongs to another experiment.`);
    }
  }
}

function provenanceContains(
  document: Readonly<{
    provenanceRefs: readonly {
      artifactName: string;
      contentHash: string;
    }[];
  }>,
  artifactName: string,
  contentHash: string,
): boolean {
  return document.provenanceRefs.some(
    (reference) => reference.artifactName === artifactName && reference.contentHash === contentHash,
  );
}

function assertArtifactBindings(
  snapshot: ReleaseSafeFinalExperimentSnapshot,
  artifacts: ReleaseSafeExperimentArtifactSet,
): void {
  const experiment = artifacts["experiment.json"];
  const hypothesis = artifacts["hypothesis.json"];
  const candidate = artifacts["candidate.json"];
  const plan = artifacts["evaluation-plan.json"];
  const results = artifacts["results.json"];
  const behavior = artifacts["behavioral-evidence.json"];
  const cache = artifacts["cache-attestation.json"];
  const cards = artifacts["failure-cards.json"];
  const brief = artifacts["diagnostic-brief.json"];
  const analysis = artifacts["analysis.json"];
  const decision = artifacts["decision.json"];
  const feedback = artifacts["feedback-entry.json"];
  const expectedAfter =
    snapshot.promotedCandidate?.commit ?? snapshot.activeChampionBefore.activeCommit;
  const expectedRepair =
    snapshot.repair === null
      ? "not-run"
      : snapshot.repair.disposition === "rejected"
        ? "failed"
        : snapshot.repair.disposition;
  const expectedValidation =
    snapshot.validation === null
      ? "not-run"
      : snapshot.disposition === "promoted"
        ? "promote"
        : snapshot.disposition === "rejected"
          ? "reject"
          : "inconclusive";

  if (
    experiment.slug !== snapshot.experiment.slug ||
    experiment.protocolHash !== snapshot.experiment.protocolHash ||
    experiment.startedAt !== snapshot.startedAt ||
    experiment.finishedAt !== snapshot.finishedAt ||
    experiment.championBefore !== snapshot.activeChampionBefore.activeCommit ||
    experiment.championAfter !== expectedAfter ||
    experiment.finalDisposition !== snapshot.disposition ||
    hypothesis.sourceDiagnosticBriefHash !== snapshot.proposal.hypothesis.sourceBriefHash ||
    hypothesis.causalClaim !== snapshot.proposal.hypothesis.causalClaim ||
    hypothesis.proposedIntervention !== snapshot.proposal.hypothesis.intervention ||
    !provenanceContains(hypothesis, "optimizer-hypothesis", snapshot.proposal.hypothesis.hash) ||
    candidate.candidateCommit !== snapshot.proposal.candidate.commit ||
    candidate.patchHash !== snapshot.proposal.candidate.patchHash ||
    canonicalJson(candidate.changedFiles) !==
      canonicalJson(snapshot.proposal.candidate.changedFiles) ||
    candidate.mutation.category !== snapshot.proposal.candidate.mutationCategory ||
    candidate.allGatesPassed !== (snapshot.gates.passed && snapshot.gates.integrityPassed) ||
    !provenanceContains(candidate, "gate-checks", snapshot.gates.checksHash) ||
    plan.protocolHash !== snapshot.experiment.protocolHash ||
    behavior.protocolHash !== snapshot.experiment.protocolHash ||
    cache.protocolHash !== snapshot.experiment.protocolHash ||
    cards.behavioralEvidenceHash !== behavior.contentHash ||
    brief.aggregateEvidenceHash !== behavior.contentHash ||
    brief.failureCardsHash !== cards.contentHash ||
    results.protocolHash !== snapshot.experiment.protocolHash ||
    results.repair.disposition !== expectedRepair ||
    results.repair.attemptOrdinal !== (snapshot.repair?.attemptOrdinal ?? 0) ||
    (results.validation === null) !== (snapshot.validation === null) ||
    analysis.hypothesisHash !== snapshot.proposal.hypothesis.hash ||
    analysis.resultsHash !== results.contentHash ||
    !provenanceContains(analysis, "optimizer-analysis", snapshot.analysisHash) ||
    decision.repairDisposition !== expectedRepair ||
    decision.validationDisposition !== expectedValidation ||
    decision.activeChampionTransition.beforeCommit !== snapshot.activeChampionBefore.activeCommit ||
    decision.activeChampionTransition.afterCommit !== expectedAfter ||
    decision.activeChampionTransition.changed !== (snapshot.disposition === "promoted") ||
    feedback.lifecycleDisposition !== snapshot.disposition ||
    !provenanceContains(feedback, "budget-final", canonicalHash(snapshot.finalBudget))
  ) {
    fail("Release-safe artifacts are detached from the journal snapshot.");
  }
  if (
    snapshot.repair !== null &&
    results.repair.signedPolicyAttestationHash !== snapshot.repair.attestationHash
  ) {
    fail("Repair evidence is detached from its broker attestation.");
  }
  if (snapshot.validation !== null && results.validation !== null) {
    if (
      results.validation.signedResultEnvelopeHash !==
        snapshot.validation.aggregate.attestationHash ||
      decision.oneUseConsumptionAttestationHash !==
        snapshot.validation.panelDispositionAttestationHash ||
      results.validation.matchedTaskCount !== snapshot.validation.aggregate.validPairs ||
      results.validation.validFreshArmCount !== snapshot.validation.aggregate.validArms
    ) {
      fail("Validation evidence is detached from trusted evaluator evidence.");
    }
  }
  const expectedBehaviorSource =
    snapshot.validation?.aggregate.behavioralSourceCommitmentHash ??
    snapshot.repair?.attestationHash ??
    null;
  if (expectedBehaviorSource !== null && behavior.sourceEnvelopeHash !== expectedBehaviorSource) {
    fail("Behavioral evidence is detached from its trusted envelope.");
  }
  if (
    snapshot.diagnosticBrief !== null &&
    (brief.contentHash !== snapshot.diagnosticBrief.hash ||
      brief.releaseId !== snapshot.diagnosticBrief.releaseId ||
      (brief.status === "actionable-evidence") !== snapshot.diagnosticBrief.actionable)
  ) {
    fail("Diagnostic evidence is detached from its release.");
  }
}

export interface TrustedReleaseSafeArtifactPolicyProvider {
  /**
   * Must be idempotent by assemblyRequestHash. It has no hidden-task input and
   * returns only the five policy/narrative artifacts.
   */
  provide(snapshot: ReleaseSafeFinalExperimentSnapshot): Promise<{
    readonly schemaVersion: 1;
    readonly assemblyRequestHash: string;
    readonly policyAttestationHash: string;
    readonly artifacts: PolicyArtifactSet;
  }>;
}

export interface TrustedReleaseSafeArtifactProvenanceProvider {
  /**
   * Resolves only release-safe source, correctness, broker, evaluator and
   * cache evidence. Raw task identities and grader material never cross this
   * port.
   */
  provide(snapshot: ReleaseSafeFinalExperimentSnapshot): Promise<{
    readonly schemaVersion: 1;
    readonly assemblyRequestHash: string;
    readonly provenanceAttestationHash: string;
    readonly evidence: {
      readonly correctnessGateHash: string;
      readonly brokerEvidenceHash: string | null;
      readonly evaluatorEvidenceHash: string | null;
      readonly cacheEvidenceHash: string;
    };
    readonly artifacts: ProvenanceArtifactSet;
  }>;
}

export interface TrustedTaskIdentityExclusionAuthority {
  /**
   * Implementations hold the hidden identity/fingerprint set inside the
   * trusted cloud boundary and attest the exact artifactSetHash.
   */
  assertTaskFree(input: {
    readonly assemblyRequestHash: string;
    readonly artifactSetHash: string;
    readonly artifacts: ReleaseSafeExperimentArtifactSet;
  }): Promise<{
    readonly assemblyRequestHash: string;
    readonly artifactSetHash: string;
    readonly passed: true;
    readonly containsTaskIdentifiers: false;
    readonly attestationHash: string;
  }>;
}

interface DurableArtifactAssemblyRecord {
  readonly assemblyRequestHash: string;
  readonly snapshotHash: string;
  readonly policyResponseHash: string;
  readonly provenanceResponseHash: string;
  readonly taskIdentityExclusionAttestationHash: string;
  readonly artifactSetHash: string;
  readonly artifacts: ReleaseSafeExperimentArtifactSet;
}

interface DurableArtifactAssemblyState {
  readonly schemaVersion: 1;
  readonly sensitivity: "release-safe-experiment-artifact-assemblies";
  readonly scopeHash: string;
  readonly revision: number;
  readonly records: Readonly<Record<string, DurableArtifactAssemblyRecord>>;
}

export interface MountedVolumeReleaseSafeExperimentArtifactAssemblerOptions {
  readonly durableState: MountedVolumeDurableStateOptions;
  readonly policyProvider: TrustedReleaseSafeArtifactPolicyProvider;
  readonly provenanceProvider: TrustedReleaseSafeArtifactProvenanceProvider;
  readonly taskIdentityExclusionAuthority: TrustedTaskIdentityExclusionAuthority;
}

/**
 * Task-free production assembler. Every required artifact is supplied by one
 * of two task-free trusted ports, then independently schema checked, bound to
 * the journal snapshot, hidden-identity scanned, and durably memoized.
 */
export class MountedVolumeReleaseSafeExperimentArtifactAssembler
  implements TrustedReleaseSafeExperimentArtifactAssembler
{
  readonly #store: MountedVolumeTransactionalJsonStore<DurableArtifactAssemblyState>;
  readonly #policyProvider: TrustedReleaseSafeArtifactPolicyProvider;
  readonly #provenanceProvider: TrustedReleaseSafeArtifactProvenanceProvider;
  readonly #taskIdentityExclusionAuthority: TrustedTaskIdentityExclusionAuthority;

  public constructor(options: MountedVolumeReleaseSafeExperimentArtifactAssemblerOptions) {
    this.#policyProvider = options.policyProvider;
    this.#provenanceProvider = options.provenanceProvider;
    this.#taskIdentityExclusionAuthority = options.taskIdentityExclusionAuthority;
    const scopeHash = canonicalHash({
      domain: "dark-factory.release-safe-artifact-assembler-scope.v1",
      storeId: options.durableState.storeId,
    });
    this.#store = new MountedVolumeTransactionalJsonStore<DurableArtifactAssemblyState>(
      options.durableState,
      `experiment-artifact-assemblies-${options.durableState.storeId}`,
      {
        domain: "dark-factory.release-safe-artifact-assemblies.v1",
        initialState: () => ({
          schemaVersion: 1,
          sensitivity: "release-safe-experiment-artifact-assemblies",
          scopeHash,
          revision: 0,
          records: {},
        }),
        assertState: (value): asserts value is DurableArtifactAssemblyState => {
          assertExactKeys(
            value,
            ["schemaVersion", "sensitivity", "scopeHash", "revision", "records"],
            "Durable artifact assembly state",
          );
          const state = value as unknown as DurableArtifactAssemblyState;
          if (
            state.schemaVersion !== 1 ||
            state.sensitivity !== "release-safe-experiment-artifact-assemblies" ||
            state.scopeHash !== scopeHash ||
            !Number.isSafeInteger(state.revision) ||
            state.revision < 0 ||
            !isPlainRecord(state.records) ||
            state.revision !== Object.keys(state.records).length
          ) {
            fail("Durable artifact assembly state is malformed.");
          }
          for (const [requestHash, rawRecord] of Object.entries(state.records)) {
            assertExactKeys(
              rawRecord,
              [
                "assemblyRequestHash",
                "snapshotHash",
                "policyResponseHash",
                "provenanceResponseHash",
                "taskIdentityExclusionAttestationHash",
                "artifactSetHash",
                "artifacts",
              ],
              "Durable artifact assembly record",
            );
            const record = rawRecord as unknown as DurableArtifactAssemblyRecord;
            for (const [field, hash] of Object.entries({
              requestHash,
              snapshotHash: record.snapshotHash,
              policyResponseHash: record.policyResponseHash,
              provenanceResponseHash: record.provenanceResponseHash,
              taskIdentityExclusionAttestationHash: record.taskIdentityExclusionAttestationHash,
              artifactSetHash: record.artifactSetHash,
            })) {
              assertHash(hash, `Artifact assembly ${field}`);
            }
            if (
              record.assemblyRequestHash !== requestHash ||
              record.artifactSetHash !== canonicalHash(record.artifacts)
            ) {
              fail("Durable artifact assembly record is inconsistent.");
            }
            assertArtifactSubset(
              record.artifacts,
              REQUIRED_PRESEAL_ARTIFACT_FILES,
              record.artifacts["experiment.json"].experimentNumber,
              "Durable artifact assembly",
            );
          }
        },
        revision: (state) => state.revision,
      },
    );
  }

  public async assemble(
    input: ReleaseSafeFinalExperimentSnapshot,
  ): Promise<ReleaseSafeExperimentArtifactSet> {
    const snapshot = cloneJson(input, "Experiment assembly snapshot");
    assertSnapshot(snapshot);
    const replay = await this.#store.transact((state) => ({
      next: state,
      result: state.records[snapshot.assemblyRequestHash] ?? null,
    }));
    if (replay !== null) {
      if (replay.snapshotHash !== canonicalHash(snapshot)) {
        fail("Assembly request hash was replayed with a different snapshot.");
      }
      assertArtifactBindings(snapshot, replay.artifacts);
      return cloneJson(replay.artifacts, "Stored artifact assembly");
    }

    const [rawPolicy, rawProvenance] = await Promise.all([
      this.#policyProvider.provide(cloneJson(snapshot, "Policy snapshot")),
      this.#provenanceProvider.provide(cloneJson(snapshot, "Provenance snapshot")),
    ]);
    const policy = cloneJson(rawPolicy, "Artifact policy response");
    const provenance = cloneJson(rawProvenance, "Artifact provenance response");
    assertExactKeys(
      policy,
      ["schemaVersion", "assemblyRequestHash", "policyAttestationHash", "artifacts"],
      "Artifact policy response",
    );
    assertExactKeys(
      provenance,
      [
        "schemaVersion",
        "assemblyRequestHash",
        "provenanceAttestationHash",
        "evidence",
        "artifacts",
      ],
      "Artifact provenance response",
    );
    assertExactKeys(
      provenance.evidence,
      ["correctnessGateHash", "brokerEvidenceHash", "evaluatorEvidenceHash", "cacheEvidenceHash"],
      "Artifact provenance evidence",
    );
    if (
      policy.schemaVersion !== 1 ||
      provenance.schemaVersion !== 1 ||
      policy.assemblyRequestHash !== snapshot.assemblyRequestHash ||
      provenance.assemblyRequestHash !== snapshot.assemblyRequestHash
    ) {
      fail("Artifact provider response is detached from the assembly request.");
    }
    assertHash(policy.policyAttestationHash, "Policy attestation hash");
    assertHash(provenance.provenanceAttestationHash, "Provenance attestation hash");
    assertHash(provenance.evidence.correctnessGateHash, "Correctness evidence hash");
    assertNullableHash(provenance.evidence.brokerEvidenceHash, "Broker evidence hash");
    assertNullableHash(provenance.evidence.evaluatorEvidenceHash, "Evaluator evidence hash");
    assertHash(provenance.evidence.cacheEvidenceHash, "Cache evidence hash");
    assertArtifactSubset(
      policy.artifacts,
      POLICY_ARTIFACT_FILES,
      snapshot.experiment.number,
      "Policy artifact set",
    );
    assertArtifactSubset(
      provenance.artifacts,
      PROVENANCE_ARTIFACT_FILES,
      snapshot.experiment.number,
      "Provenance artifact set",
    );
    const expectedBroker =
      snapshot.validation?.panelDispositionAttestationHash ??
      snapshot.repair?.attestationHash ??
      null;
    const expectedEvaluator =
      snapshot.validation?.aggregate.attestationHash ?? snapshot.repair?.attestationHash ?? null;
    if (
      provenance.evidence.correctnessGateHash !== snapshot.gates.checksHash ||
      provenance.evidence.brokerEvidenceHash !== expectedBroker ||
      provenance.evidence.evaluatorEvidenceHash !== expectedEvaluator ||
      provenance.evidence.cacheEvidenceHash !==
        provenance.artifacts["cache-attestation.json"].contentHash
    ) {
      fail("A required trusted evidence commitment is missing or detached.");
    }
    const artifacts = cloneJson(
      {
        ...policy.artifacts,
        ...provenance.artifacts,
      } as ReleaseSafeExperimentArtifactSet,
      "Combined artifact set",
    );
    assertArtifactSubset(
      artifacts,
      REQUIRED_PRESEAL_ARTIFACT_FILES,
      snapshot.experiment.number,
      "Combined artifact set",
    );
    assertArtifactBindings(snapshot, artifacts);
    const artifactSetHash = canonicalHash(artifacts);
    const taskFree = cloneJson(
      await this.#taskIdentityExclusionAuthority.assertTaskFree({
        assemblyRequestHash: snapshot.assemblyRequestHash,
        artifactSetHash,
        artifacts: cloneJson(artifacts, "Task-exclusion artifact set"),
      }),
      "Task-identity exclusion attestation",
    );
    assertExactKeys(
      taskFree,
      [
        "assemblyRequestHash",
        "artifactSetHash",
        "passed",
        "containsTaskIdentifiers",
        "attestationHash",
      ],
      "Task-identity exclusion attestation",
    );
    assertHash(taskFree.attestationHash, "Task-identity exclusion attestation hash");
    if (
      taskFree.assemblyRequestHash !== snapshot.assemblyRequestHash ||
      taskFree.artifactSetHash !== artifactSetHash ||
      taskFree.passed !== true ||
      taskFree.containsTaskIdentifiers !== false
    ) {
      fail("Task-identity exclusion attestation is detached or failed.");
    }
    const record: DurableArtifactAssemblyRecord = {
      assemblyRequestHash: snapshot.assemblyRequestHash,
      snapshotHash: canonicalHash(snapshot),
      policyResponseHash: canonicalHash(policy),
      provenanceResponseHash: canonicalHash(provenance),
      taskIdentityExclusionAttestationHash: taskFree.attestationHash,
      artifactSetHash,
      artifacts,
    };
    const committed = await this.#store.transact((state) => {
      const existing = state.records[snapshot.assemblyRequestHash];
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(record)) {
          fail("Concurrent artifact assembly produced conflicting evidence.");
        }
        return { next: state, result: existing };
      }
      return {
        next: {
          ...state,
          revision: state.revision + 1,
          records: {
            ...state.records,
            [snapshot.assemblyRequestHash]: record,
          },
        },
        result: record,
      };
    });
    return cloneJson(committed.artifacts, "Committed artifact assembly");
  }

  public close(): Promise<void> {
    return this.#store.close();
  }
}

export interface TrustedDeterministicExperimentLeakScanner {
  readonly boundary: "trusted-cloud-deterministic-leak-scanner";
  /**
   * The scanner resolves every immutable byte named by subject, recomputes the
   * manifest, and scans those bytes. It must be idempotent by requestHash.
   */
  scan(input: {
    readonly requestHash: string;
    readonly subject: LeakScanSubject;
    readonly subjectHash: string;
    readonly assemblyRequestHash: string;
  }): Promise<{
    readonly requestHash: string;
    readonly subjectHash: string;
    readonly scannerPolicyVersion: string;
    readonly scannerVersion: string;
    readonly checkedAt: string;
    readonly passed: boolean;
    readonly matchCount: number;
    readonly scanAttestationHash: string;
  }>;
}

export interface TrustedCloudLeakScanKeyAuthority {
  readonly boundary: "trusted-cloud-leak-scan-key";
  readonly keyId: string;
  /**
   * Narrow non-oracle operation. The authority must return the same signature
   * for the same requestHash and unsignedReceiptHash.
   */
  signLeakScanReceipt(input: {
    readonly requestHash: string;
    readonly unsignedReceiptHash: string;
    readonly receipt: Readonly<Record<string, unknown>>;
  }): Promise<Signature>;
}

export interface TrustedPinnedVersionProvider {
  resolve(input: {
    readonly requestHash: string;
    readonly assemblyRequestHash: string;
    readonly subjectHash: string;
  }): Promise<Attestation["pinnedVersions"]>;
}

interface PendingSealAuthorization {
  readonly status: "pending";
  readonly requestHash: string;
  readonly inputHash: string;
  readonly subjectHash: string;
  readonly assemblyRequestHash: string;
  readonly previousExperimentSealHash: string | null;
}

interface CompletedSealAuthorization {
  readonly status: "completed";
  readonly requestHash: string;
  readonly inputHash: string;
  readonly subjectHash: string;
  readonly assemblyRequestHash: string;
  readonly previousExperimentSealHash: string | null;
  readonly scanAttestationHash: string;
  readonly unsignedReceiptHash: string;
  readonly authorizationHash: string;
  readonly authorization: TrustedExperimentSealAuthorization;
}

type DurableSealAuthorizationRecord = PendingSealAuthorization | CompletedSealAuthorization;

interface DurableSealAuthorizationState {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-experiment-seal-authorizations";
  readonly scopeHash: string;
  readonly revision: number;
  readonly records: Readonly<Record<string, DurableSealAuthorizationRecord>>;
}

export interface MountedVolumeTrustedExperimentSealAuthorityOptions {
  readonly durableState: MountedVolumeDurableStateOptions;
  readonly scanner: TrustedDeterministicExperimentLeakScanner;
  readonly keyAuthority: TrustedCloudLeakScanKeyAuthority;
  readonly scannerPublicKey: KeyLike;
  readonly pinnedVersions: TrustedPinnedVersionProvider;
}

function assertLeakScanSubject(value: unknown): asserts value is LeakScanSubject {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "experimentId",
      "experimentNumber",
      "artifactManifest",
      "artifactManifestHash",
      "eventRecordCount",
      "eventChainHead",
      "protocolHash",
    ],
    "Leak-scan subject",
  );
  const subject = value as unknown as LeakScanSubject;
  if (
    subject.schemaVersion !== "1.0.0" ||
    typeof subject.experimentId !== "string" ||
    !/^\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(subject.experimentId) ||
    !Number.isSafeInteger(subject.experimentNumber) ||
    subject.experimentNumber < 1 ||
    !Array.isArray(subject.artifactManifest) ||
    subject.artifactManifest.length !== REQUIRED_PRESEAL_ARTIFACT_FILES.length ||
    !Number.isSafeInteger(subject.eventRecordCount) ||
    subject.eventRecordCount < 1
  ) {
    fail("Leak-scan subject is malformed.");
  }
  assertHash(subject.artifactManifestHash, "Artifact manifest hash");
  assertHash(subject.eventChainHead, "Event chain head");
  assertHash(subject.protocolHash, "Leak-scan protocol hash");
  if (
    subject.artifactManifestHash !== canonicalHash(subject.artifactManifest) ||
    canonicalJson(subject.artifactManifest.map((entry) => entry.path)) !==
      canonicalJson([...REQUIRED_PRESEAL_ARTIFACT_FILES].sort())
  ) {
    fail("Leak-scan subject does not name the exact pre-seal artifact set.");
  }
  for (const entry of subject.artifactManifest) {
    assertExactKeys(
      entry,
      ["path", "schemaKind", "contentHash", "byteHash", "bytes"],
      "Leak-scan manifest entry",
    );
    const bytes = entry.bytes;
    if (
      artifactFileSchemas[entry.path as keyof typeof artifactFileSchemas] !== entry.schemaKind ||
      typeof bytes !== "number" ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1
    ) {
      fail("Leak-scan manifest entry is malformed.");
    }
    assertHash(entry.contentHash, "Manifest content hash");
    assertHash(entry.byteHash, "Manifest byte hash");
  }
}

function assertPinnedVersions(value: unknown): asserts value is Attestation["pinnedVersions"] {
  assertExactKeys(value, PINNED_VERSION_KEYS, "Pinned versions");
  for (const [key, version] of Object.entries(value)) {
    if (typeof version !== "string" || !SAFE_VERSION.test(version)) {
      fail(`Pinned version ${key} is malformed.`);
    }
  }
  if (
    typeof value.piCommit !== "string" ||
    !/^[a-f0-9]{40,64}$/u.test(value.piCommit) ||
    typeof value.sandboxImageDigest !== "string" ||
    !SHA256.test(value.sandboxImageDigest)
  ) {
    fail("Pinned source or sandbox version is malformed.");
  }
}

function assertSignature(
  value: unknown,
  keyId: string,
  checkedAt: string,
): asserts value is Signature {
  assertExactKeys(value, ["algorithm", "keyId", "signedAt", "signature"], "Leak-scan signature");
  const signature = value as unknown as Signature;
  if (
    signature.algorithm !== "ed25519" ||
    signature.keyId !== keyId ||
    signature.signedAt !== checkedAt ||
    typeof signature.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86,128}$/u.test(signature.signature)
  ) {
    fail("Leak-scan signature is malformed.");
  }
}

function assertAuthorization(
  value: unknown,
  input: {
    readonly subject: LeakScanSubject;
    readonly keyId: string;
    readonly publicKey: KeyLike;
  },
): asserts value is TrustedExperimentSealAuthorization {
  assertExactKeys(
    value,
    ["authorityAttestationHash", "pinnedVersions", "leakScanReceipt", "signer"],
    "Experiment seal authorization",
  );
  const authorization = value as unknown as TrustedExperimentSealAuthorization;
  assertHash(authorization.authorityAttestationHash, "Seal authority attestation hash");
  assertPinnedVersions(authorization.pinnedVersions);
  if (authorization.signer !== null) {
    fail("Experiment attestation signing is not delegated by this authority.");
  }
  assertValidDocument("leakScanReceipt", authorization.leakScanReceipt);
  if (
    !hasValidContentHash(authorization.leakScanReceipt) ||
    authorization.authorityAttestationHash !== authorization.leakScanReceipt.contentHash
  ) {
    fail("Leak-scan receipt content commitment is invalid.");
  }
  const receiptSubject: LeakScanSubject = {
    schemaVersion: authorization.leakScanReceipt.schemaVersion,
    experimentId: authorization.leakScanReceipt.experimentId,
    experimentNumber: authorization.leakScanReceipt.experimentNumber,
    artifactManifest: authorization.leakScanReceipt.artifactManifest,
    artifactManifestHash: authorization.leakScanReceipt.artifactManifestHash,
    eventRecordCount: authorization.leakScanReceipt.eventRecordCount,
    eventChainHead: authorization.leakScanReceipt.eventChainHead,
    protocolHash: authorization.leakScanReceipt.protocolHash,
  };
  if (
    canonicalJson(receiptSubject) !== canonicalJson(input.subject) ||
    authorization.leakScanReceipt.signature.keyId !== input.keyId ||
    !verifyEd25519Signature(authorization.leakScanReceipt, input.publicKey)
  ) {
    fail("Leak-scan receipt is detached or has an invalid signature.");
  }
}

/**
 * Durable seal authority. The only path to the signing key is after a strict
 * deterministic scan of the exact immutable leak-scan subject.
 */
export class MountedVolumeTrustedExperimentSealAuthority implements TrustedExperimentSealAuthority {
  readonly #store: MountedVolumeTransactionalJsonStore<DurableSealAuthorizationState>;
  readonly #scanner: TrustedDeterministicExperimentLeakScanner;
  readonly #keyAuthority: TrustedCloudLeakScanKeyAuthority;
  readonly #scannerPublicKey: KeyLike;
  readonly #pinnedVersions: TrustedPinnedVersionProvider;

  public constructor(options: MountedVolumeTrustedExperimentSealAuthorityOptions) {
    if (
      options.scanner.boundary !== "trusted-cloud-deterministic-leak-scanner" ||
      options.keyAuthority.boundary !== "trusted-cloud-leak-scan-key" ||
      !SAFE_ID.test(options.keyAuthority.keyId)
    ) {
      fail("Seal authority dependency boundary is malformed.");
    }
    this.#scanner = options.scanner;
    this.#keyAuthority = options.keyAuthority;
    this.#scannerPublicKey = options.scannerPublicKey;
    this.#pinnedVersions = options.pinnedVersions;
    const scopeHash = canonicalHash({
      domain: "dark-factory.experiment-seal-authority-scope.v1",
      storeId: options.durableState.storeId,
      scannerKeyId: options.keyAuthority.keyId,
    });
    const assertRecord = (requestHash: string, rawRecord: unknown): void => {
      if (!isPlainRecord(rawRecord)) {
        fail("Seal authorization record is not an object.");
      }
      const completed = rawRecord.status === "completed";
      assertExactKeys(
        rawRecord,
        completed
          ? [
              "status",
              "requestHash",
              "inputHash",
              "subjectHash",
              "assemblyRequestHash",
              "previousExperimentSealHash",
              "scanAttestationHash",
              "unsignedReceiptHash",
              "authorizationHash",
              "authorization",
            ]
          : [
              "status",
              "requestHash",
              "inputHash",
              "subjectHash",
              "assemblyRequestHash",
              "previousExperimentSealHash",
            ],
        "Seal authorization record",
      );
      const record = rawRecord as unknown as DurableSealAuthorizationRecord;
      if (
        (record.status !== "pending" && record.status !== "completed") ||
        record.requestHash !== requestHash
      ) {
        fail("Seal authorization record status is malformed.");
      }
      for (const hash of [
        requestHash,
        record.inputHash,
        record.subjectHash,
        record.assemblyRequestHash,
      ]) {
        assertHash(hash, "Seal authorization record hash");
      }
      assertNullableHash(record.previousExperimentSealHash, "Previous experiment seal hash");
      if (record.status === "completed") {
        assertHash(record.scanAttestationHash, "Stored leak-scan attestation hash");
        assertHash(record.unsignedReceiptHash, "Stored unsigned receipt hash");
        assertHash(record.authorizationHash, "Authorization hash");
        if (record.authorizationHash !== canonicalHash(record.authorization)) {
          fail("Stored seal authorization hash is invalid.");
        }
        const receipt = record.authorization.leakScanReceipt;
        const receiptSubject: LeakScanSubject = {
          schemaVersion: receipt.schemaVersion,
          experimentId: receipt.experimentId,
          experimentNumber: receipt.experimentNumber,
          artifactManifest: receipt.artifactManifest,
          artifactManifestHash: receipt.artifactManifestHash,
          eventRecordCount: receipt.eventRecordCount,
          eventChainHead: receipt.eventChainHead,
          protocolHash: receipt.protocolHash,
        };
        assertLeakScanSubject(receiptSubject);
        assertAuthorization(record.authorization, {
          subject: receiptSubject,
          keyId: options.keyAuthority.keyId,
          publicKey: options.scannerPublicKey,
        });
        const { contentHash: _contentHash, signature, ...receiptBody } = receipt;
        if (
          record.subjectHash !== canonicalHash(receiptSubject) ||
          record.unsignedReceiptHash !== canonicalHash({ ...receiptBody, signature: null }) ||
          signature.keyId !== options.keyAuthority.keyId ||
          record.requestHash !==
            canonicalHash({
              domain: "dark-factory.experiment-seal-authorization.v1",
              subject: receiptSubject,
              previousExperimentSealHash: record.previousExperimentSealHash,
              assemblyRequestHash: record.assemblyRequestHash,
            })
        ) {
          fail("Stored seal authorization is detached from its request.");
        }
      }
    };
    this.#store = new MountedVolumeTransactionalJsonStore<DurableSealAuthorizationState>(
      options.durableState,
      `experiment-seal-authorizations-${options.durableState.storeId}`,
      {
        domain: "dark-factory.experiment-seal-authorizations.v1",
        initialState: () => ({
          schemaVersion: 1,
          sensitivity: "trusted-experiment-seal-authorizations",
          scopeHash,
          revision: 0,
          records: {},
        }),
        assertState: (value): asserts value is DurableSealAuthorizationState => {
          assertExactKeys(
            value,
            ["schemaVersion", "sensitivity", "scopeHash", "revision", "records"],
            "Durable seal authorization state",
          );
          const state = value as unknown as DurableSealAuthorizationState;
          if (
            state.schemaVersion !== 1 ||
            state.sensitivity !== "trusted-experiment-seal-authorizations" ||
            state.scopeHash !== scopeHash ||
            !Number.isSafeInteger(state.revision) ||
            state.revision < 0 ||
            !isPlainRecord(state.records)
          ) {
            fail("Durable seal authorization state is malformed.");
          }
          for (const [requestHash, record] of Object.entries(state.records)) {
            assertRecord(requestHash, record);
          }
        },
        revision: (state) => state.revision,
      },
    );
  }

  public async authorize(input: {
    readonly requestHash: string;
    readonly subject: LeakScanSubject;
    readonly previousExperimentSealHash: string | null;
    readonly assemblyRequestHash: string;
  }): Promise<TrustedExperimentSealAuthorization> {
    const detached = cloneJson(input, "Experiment seal request");
    assertExactKeys(
      detached,
      ["requestHash", "subject", "previousExperimentSealHash", "assemblyRequestHash"],
      "Experiment seal request",
    );
    assertHash(detached.requestHash, "Seal request hash");
    assertHash(detached.assemblyRequestHash, "Assembly request hash");
    assertNullableHash(detached.previousExperimentSealHash, "Previous experiment seal hash");
    assertLeakScanSubject(detached.subject);
    const expectedRequestHash = canonicalHash({
      domain: "dark-factory.experiment-seal-authorization.v1",
      subject: detached.subject,
      previousExperimentSealHash: detached.previousExperimentSealHash,
      assemblyRequestHash: detached.assemblyRequestHash,
    });
    if (detached.requestHash !== expectedRequestHash) {
      fail("Experiment seal request hash is invalid.");
    }
    const subjectHash = canonicalHash(detached.subject);
    const inputHash = canonicalHash(detached);
    const observed = await this.#store.transact((state) => {
      const existing = state.records[detached.requestHash];
      if (existing !== undefined && existing.inputHash !== inputHash) {
        fail("Seal request hash was replayed with different input.");
      }
      if (existing !== undefined) {
        return { next: state, result: existing };
      }
      const pending: PendingSealAuthorization = {
        status: "pending",
        requestHash: detached.requestHash,
        inputHash,
        subjectHash,
        assemblyRequestHash: detached.assemblyRequestHash,
        previousExperimentSealHash: detached.previousExperimentSealHash,
      };
      return {
        next: {
          ...state,
          revision: state.revision + 1,
          records: {
            ...state.records,
            [detached.requestHash]: pending,
          },
        },
        result: pending,
      };
    });
    if (observed.status === "completed") {
      assertAuthorization(observed.authorization, {
        subject: detached.subject,
        keyId: this.#keyAuthority.keyId,
        publicKey: this.#scannerPublicKey,
      });
      return cloneJson(observed.authorization, "Stored experiment seal authorization");
    }

    const scan = cloneJson(
      await this.#scanner.scan({
        requestHash: detached.requestHash,
        subject: cloneJson(detached.subject, "Leak-scan subject"),
        subjectHash,
        assemblyRequestHash: detached.assemblyRequestHash,
      }),
      "Deterministic leak-scan result",
    );
    assertExactKeys(
      scan,
      [
        "requestHash",
        "subjectHash",
        "scannerPolicyVersion",
        "scannerVersion",
        "checkedAt",
        "passed",
        "matchCount",
        "scanAttestationHash",
      ],
      "Deterministic leak-scan result",
    );
    assertHash(scan.scanAttestationHash, "Leak-scan attestation hash");
    assertTimestamp(scan.checkedAt, "Leak-scan completion time");
    if (
      scan.requestHash !== detached.requestHash ||
      scan.subjectHash !== subjectHash ||
      typeof scan.scannerPolicyVersion !== "string" ||
      !SAFE_VERSION.test(scan.scannerPolicyVersion) ||
      typeof scan.scannerVersion !== "string" ||
      !SAFE_VERSION.test(scan.scannerVersion) ||
      scan.passed !== true ||
      scan.matchCount !== 0
    ) {
      fail("Deterministic leak scan failed or is detached.");
    }
    const pinnedVersions = cloneJson(
      await this.#pinnedVersions.resolve({
        requestHash: detached.requestHash,
        assemblyRequestHash: detached.assemblyRequestHash,
        subjectHash,
      }),
      "Pinned versions",
    );
    assertPinnedVersions(pinnedVersions);
    const unsignedReceipt = {
      ...detached.subject,
      scannerPolicyVersion: scan.scannerPolicyVersion,
      scannerVersion: scan.scannerVersion,
      checkedAt: scan.checkedAt,
      status: "passed" as const,
      passed: true as const,
      matchCountBand: "0" as const,
      signature: null,
    };
    const unsignedReceiptHash = canonicalHash(unsignedReceipt);
    const signature = cloneJson(
      await this.#keyAuthority.signLeakScanReceipt({
        requestHash: detached.requestHash,
        unsignedReceiptHash,
        receipt: cloneJson(unsignedReceipt, "Unsigned leak-scan receipt"),
      }),
      "Leak-scan signature",
    );
    assertSignature(signature, this.#keyAuthority.keyId, scan.checkedAt);
    const leakScanReceipt = withContentHash({
      ...unsignedReceipt,
      signature,
    }) as LeakScanReceipt;
    assertValidDocument("leakScanReceipt", leakScanReceipt);
    if (!verifyEd25519Signature(leakScanReceipt, this.#scannerPublicKey)) {
      fail("Cloud key authority returned an invalid leak-scan signature.");
    }
    const authorization: TrustedExperimentSealAuthorization = {
      authorityAttestationHash: leakScanReceipt.contentHash,
      pinnedVersions,
      leakScanReceipt,
      signer: null,
    };
    assertAuthorization(authorization, {
      subject: detached.subject,
      keyId: this.#keyAuthority.keyId,
      publicKey: this.#scannerPublicKey,
    });
    const completed: CompletedSealAuthorization = {
      ...observed,
      status: "completed",
      scanAttestationHash: scan.scanAttestationHash,
      unsignedReceiptHash,
      authorizationHash: canonicalHash(authorization),
      authorization,
    };
    const committed = await this.#store.transact((state) => {
      const current = state.records[detached.requestHash];
      if (current === undefined || current.inputHash !== inputHash) {
        fail("Pending seal authorization was lost or replaced.");
      }
      if (current.status === "completed") {
        if (canonicalJson(current) !== canonicalJson(completed)) {
          fail("Concurrent seal authorization conflicts with this result.");
        }
        return { next: state, result: current };
      }
      return {
        next: {
          ...state,
          revision: state.revision + 1,
          records: {
            ...state.records,
            [detached.requestHash]: completed,
          },
        },
        result: completed,
      };
    });
    return cloneJson(committed.authorization, "Committed seal authorization");
  }

  public close(): Promise<void> {
    return this.#store.close();
  }
}

const INTERRUPTION_REASON_RULES: readonly {
  readonly code: string;
  readonly pattern: RegExp;
}[] = [
  { code: "operator-stop", pattern: /\b(?:abort|cancel|stop)\b/iu },
  { code: "budget-exhausted", pattern: /\b(?:budget|quota|cost)\b/iu },
  { code: "cloud-timeout", pattern: /\b(?:deadline|timed?\s*out|timeout)\b/iu },
  {
    code: "integrity-failure",
    pattern: /\b(?:hash|integrity|schema|signature|tamper)\b/iu,
  },
  {
    code: "publication-failure",
    pattern: /\b(?:git|publish|publication|push)\b/iu,
  },
  {
    code: "optimizer-failure",
    pattern: /\b(?:claude|optimizer|hypothesis|proposal)\b/iu,
  },
  {
    code: "evaluation-failure",
    pattern: /\b(?:broker|evaluation|evaluator|grade|validation)\b/iu,
  },
  {
    code: "cloud-infrastructure",
    pattern: /\b(?:cloud|network|provider|sandbox|lease|volume)\b/iu,
  },
] as const;

interface DurableInterruptionAttestation {
  readonly operationKey: string;
  readonly experimentHash: string;
  readonly phase: string;
  readonly reasonCode: string;
  readonly attestedAt: string;
  readonly attestationHash: string;
}

interface DurableInterruptionAttestationState {
  readonly schemaVersion: 1;
  readonly sensitivity: "release-safe-journal-interruptions";
  readonly scopeHash: string;
  readonly revision: number;
  readonly records: Readonly<Record<string, DurableInterruptionAttestation>>;
}

export interface MountedVolumeTrustedJournalInterruptionAttestorOptions {
  readonly durableState: MountedVolumeDurableStateOptions;
  readonly now?: () => Date;
}

/**
 * Raw error text terminates inside this boundary. Durable state contains only
 * a fixed category, phase, identity commitment and timestamp.
 */
export class MountedVolumeTrustedJournalInterruptionAttestor
  implements TrustedJournalInterruptionAttestor
{
  readonly #store: MountedVolumeTransactionalJsonStore<DurableInterruptionAttestationState>;
  readonly #now: () => Date;

  public constructor(options: MountedVolumeTrustedJournalInterruptionAttestorOptions) {
    this.#now = options.now ?? (() => new Date());
    const scopeHash = canonicalHash({
      domain: "dark-factory.journal-interruption-attestor-scope.v1",
      storeId: options.durableState.storeId,
    });
    this.#store = new MountedVolumeTransactionalJsonStore<DurableInterruptionAttestationState>(
      options.durableState,
      `journal-interruptions-${options.durableState.storeId}`,
      {
        domain: "dark-factory.journal-interruption-attestations.v1",
        initialState: () => ({
          schemaVersion: 1,
          sensitivity: "release-safe-journal-interruptions",
          scopeHash,
          revision: 0,
          records: {},
        }),
        assertState: (value): asserts value is DurableInterruptionAttestationState => {
          assertExactKeys(
            value,
            ["schemaVersion", "sensitivity", "scopeHash", "revision", "records"],
            "Durable interruption state",
          );
          const state = value as unknown as DurableInterruptionAttestationState;
          if (
            state.schemaVersion !== 1 ||
            state.sensitivity !== "release-safe-journal-interruptions" ||
            state.scopeHash !== scopeHash ||
            !Number.isSafeInteger(state.revision) ||
            state.revision < 0 ||
            !isPlainRecord(state.records) ||
            state.revision !== Object.keys(state.records).length
          ) {
            fail("Durable interruption state is malformed.");
          }
          for (const [operationKey, rawRecord] of Object.entries(state.records)) {
            assertExactKeys(
              rawRecord,
              [
                "operationKey",
                "experimentHash",
                "phase",
                "reasonCode",
                "attestedAt",
                "attestationHash",
              ],
              "Durable interruption attestation",
            );
            const record = rawRecord as unknown as DurableInterruptionAttestation;
            assertHash(operationKey, "Interruption operation key");
            assertHash(record.experimentHash, "Interrupted experiment hash");
            assertHash(record.attestationHash, "Interruption attestation hash");
            assertTimestamp(record.attestedAt, "Interruption timestamp");
            if (
              record.operationKey !== operationKey ||
              !SAFE_ID.test(record.phase) ||
              (!INTERRUPTION_REASON_RULES.some((rule) => rule.code === record.reasonCode) &&
                record.reasonCode !== "unexpected-failure") ||
              record.attestationHash !==
                canonicalHash({
                  domain: "dark-factory.release-safe-journal-interruption.v1",
                  operationKey,
                  experimentHash: record.experimentHash,
                  phase: record.phase,
                  reasonCode: record.reasonCode,
                  attestedAt: record.attestedAt,
                })
            ) {
              fail("Durable interruption attestation is malformed.");
            }
          }
        },
        revision: (state) => state.revision,
      },
    );
  }

  public async attest(input: {
    readonly experiment: ReleaseSafeFinalExperimentSnapshot["experiment"];
    readonly phase: string;
    readonly reason: string;
  }): Promise<{
    readonly reasonCode: string;
    readonly attestationHash: string;
  }> {
    const detached = cloneJson(input, "Journal interruption request");
    assertExactKeys(detached, ["experiment", "phase", "reason"], "Journal interruption request");
    if (
      !SAFE_ID.test(detached.phase) ||
      typeof detached.reason !== "string" ||
      detached.reason.length < 1 ||
      detached.reason.length > 16_384
    ) {
      fail("Journal interruption request is malformed.");
    }
    const experimentHash = canonicalHash(detached.experiment);
    const operationKey = canonicalHash({
      domain: "dark-factory.journal-interruption-operation.v1",
      experimentHash,
      phase: detached.phase,
    });
    const reasonCode =
      INTERRUPTION_REASON_RULES.find((rule) => rule.pattern.test(detached.reason))?.code ??
      "unexpected-failure";
    const committed = await this.#store.transact((state) => {
      const existing = state.records[operationKey];
      if (existing !== undefined) {
        if (existing.reasonCode !== reasonCode) {
          fail("Interruption replay changed its fixed reason category.");
        }
        return { next: state, result: existing };
      }
      const now = this.#now();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        fail("Interruption attestor clock is invalid.");
      }
      const attestedAt = now.toISOString();
      const recordWithoutHash = {
        operationKey,
        experimentHash,
        phase: detached.phase,
        reasonCode,
        attestedAt,
      };
      const record: DurableInterruptionAttestation = {
        ...recordWithoutHash,
        attestationHash: canonicalHash({
          domain: "dark-factory.release-safe-journal-interruption.v1",
          ...recordWithoutHash,
        }),
      };
      return {
        next: {
          ...state,
          revision: state.revision + 1,
          records: {
            ...state.records,
            [operationKey]: record,
          },
        },
        result: record,
      };
    });
    return {
      reasonCode: committed.reasonCode,
      attestationHash: committed.attestationHash,
    };
  }

  public close(): Promise<void> {
    return this.#store.close();
  }
}
