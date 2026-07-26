import type { HiddenPrivacyBudgetState } from "../evaluation/privacy.js";
import {
  hashHiddenPrivacyBudgetState,
  type BehavioralReleaseArtifact,
  type TrustedBehavioralPrivacyArtifactStore,
  type TrustedBehavioralPrivacySnapshot,
  type TrustedBehavioralReleaseCommitInspection,
  type TrustedBehavioralReleaseCommitReceipt,
  type TrustedBehavioralReleaseOrphanReceipt,
} from "../evaluator/behavioral-release-producer.js";
import { assertSafeForLocalPersistence } from "../evaluator/retention.js";
import {
  canonicalHash,
  canonicalJson,
} from "../schemas/canonical.js";
import { assertValidDocument } from "../schemas/registry.js";
import type {
  ProductionOptimizeLifecycleRegistrar,
  TrustedProductionOptimizeCloseable,
} from "./production-optimize-composition-owner.js";
import {
  MountedVolumeTransactionalJsonStore,
  type MountedVolumeDurableStateOptions,
} from "./mounted-volume-state.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAXIMUM_RELEASES = 4_096;
const DANGEROUS_RECORD_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const PURPOSES = Object.freeze([
  "behavioral-evidence",
  "failure-cards",
  "diagnostic-brief",
  "behavioral-release",
] as const satisfies readonly BehavioralReleaseArtifact["purpose"][]);

const PRIVACY_STATE_KEYS = [
  "policyVersion",
  "maximumReleases",
  "releasesUsed",
  "priorReleases",
] as const;
const PRIVACY_RELEASE_KEYS = [
  "experimentDigest",
  "analysisWindowDigest",
  "taskIds",
] as const;
const STATE_KEYS = [
  "schemaVersion",
  "sensitivity",
  "scopeHash",
  "revision",
  "privacyState",
  "privacyStateHash",
  "commitOrder",
  "commits",
  "requestOwners",
  "sourceResultOwners",
  "releaseOwners",
  "artifactOwners",
] as const;
const COMMIT_KEYS = [
  "authorizationHash",
  "requestHash",
  "sourceResultEnvelopeHash",
  "releaseContentHash",
  "priorPrivacyStateHash",
  "privacyStateHash",
  "bindingHash",
  "artifactSetHash",
  "artifacts",
  "orphanedAt",
] as const;
const ARTIFACT_KEYS = ["purpose", "document"] as const;
const COMMIT_INSPECTION_KEYS = [
  "authorizationHash",
  "requestHash",
  "sourceResultEnvelopeHash",
  "releaseContentHash",
  "artifactSetHash",
] as const;
const ORPHAN_KEYS = [
  "authorizationHash",
  "requestHash",
  "releaseContentHash",
  "orphanedAt",
] as const;

interface DurableBehavioralReleaseCommit {
  readonly authorizationHash: string;
  readonly requestHash: string;
  readonly sourceResultEnvelopeHash: string;
  readonly releaseContentHash: string;
  readonly priorPrivacyStateHash: string;
  readonly privacyStateHash: string;
  readonly bindingHash: string;
  readonly artifactSetHash: string;
  readonly artifacts: readonly [
    BehavioralReleaseArtifact,
    BehavioralReleaseArtifact,
    BehavioralReleaseArtifact,
    BehavioralReleaseArtifact,
  ];
  /**
   * The first durable orphan time. A later equivalent orphan request can
   * acknowledge the permanent state but can never clear or replace it; its
   * receipt returns this first time rather than the replay caller's time.
   */
  readonly orphanedAt: string | null;
}

interface DurableBehavioralPrivacyState {
  readonly schemaVersion: 1;
  readonly sensitivity:
    "trusted-hidden-privacy-ledger-and-release-artifacts";
  readonly scopeHash: string;
  readonly revision: number;
  readonly privacyState: HiddenPrivacyBudgetState;
  readonly privacyStateHash: string;
  readonly commitOrder: readonly string[];
  readonly commits: Readonly<
    Record<string, DurableBehavioralReleaseCommit>
  >;
  readonly requestOwners: Readonly<Record<string, string>>;
  readonly sourceResultOwners: Readonly<Record<string, string>>;
  readonly releaseOwners: Readonly<Record<string, string>>;
  readonly artifactOwners: Readonly<Record<string, string>>;
}

export interface MountedVolumeBehavioralPrivacyArtifactStoreOptions {
  readonly durableState: MountedVolumeDurableStateOptions;
  /**
   * Campaign-genesis state. It must be pristine; committed privacy spend is
   * reconstructed only from this store's durable transaction history.
   */
  readonly initialPrivacyState: HiddenPrivacyBudgetState;
  readonly lifecycle?: ProductionOptimizeLifecycleRegistrar;
}

export class MountedVolumeBehavioralPrivacyArtifactStoreError extends Error {
  override readonly name =
    "MountedVolumeBehavioralPrivacyArtifactStoreError";

  constructor() {
    super(
      "Trusted behavioral privacy and artifact transaction failed closed.",
    );
  }
}

function fail(): never {
  throw new MountedVolumeBehavioralPrivacyArtifactStoreError();
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

function exactKeys(
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

function canonicalClone<Value>(value: Value): Value {
  try {
    return JSON.parse(canonicalJson(value)) as Value;
  } catch {
    return fail();
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString() === value
  );
}

function assertHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) fail();
}

function assertSafeHashRecord(
  value: unknown,
): asserts value is Readonly<Record<string, string>> {
  if (!isPlainRecord(value)) fail();
  for (const [key, owner] of Object.entries(value)) {
    if (
      DANGEROUS_RECORD_KEYS.has(key) ||
      !SHA256.test(key) ||
      !SHA256.test(String(owner))
    ) {
      fail();
    }
  }
}

function assertPrivacyState(
  value: unknown,
): asserts value is HiddenPrivacyBudgetState {
  exactKeys(value, PRIVACY_STATE_KEYS);
  if (
    value.policyVersion !== "aggregate-firewall-v1" ||
    !Number.isSafeInteger(value.maximumReleases) ||
    (value.maximumReleases as number) < 1 ||
    (value.maximumReleases as number) > MAXIMUM_RELEASES ||
    !Number.isSafeInteger(value.releasesUsed) ||
    (value.releasesUsed as number) < 0 ||
    (value.releasesUsed as number) >
      (value.maximumReleases as number) ||
    !Array.isArray(value.priorReleases) ||
    value.priorReleases.length !== value.releasesUsed
  ) {
    fail();
  }
  const experiments = new Set<string>();
  const windows = new Set<string>();
  const tasks = new Set<string>();
  for (const release of value.priorReleases) {
    exactKeys(release, PRIVACY_RELEASE_KEYS);
    assertHash(release.experimentDigest);
    assertHash(release.analysisWindowDigest);
    if (
      experiments.has(release.experimentDigest) ||
      windows.has(release.analysisWindowDigest) ||
      !Array.isArray(release.taskIds) ||
      release.taskIds.length < 5 ||
      new Set(release.taskIds).size !== release.taskIds.length
    ) {
      fail();
    }
    experiments.add(release.experimentDigest);
    windows.add(release.analysisWindowDigest);
    for (const taskId of release.taskIds) {
      assertHash(taskId);
      if (tasks.has(taskId)) fail();
      tasks.add(taskId);
    }
  }
}

function privacyPrefix(
  initial: HiddenPrivacyBudgetState,
  finalState: HiddenPrivacyBudgetState,
  releasesUsed: number,
): HiddenPrivacyBudgetState {
  return {
    policyVersion: initial.policyVersion,
    maximumReleases: initial.maximumReleases,
    releasesUsed,
    priorReleases: finalState.priorReleases.slice(0, releasesUsed),
  };
}

function artifactSetHash(
  artifacts: readonly BehavioralReleaseArtifact[],
): string {
  return canonicalHash({
    domain: "dark-factory.behavioral-release-artifact-set.v1",
    artifacts: artifacts
      .map(({ purpose, document }) => ({
        purpose,
        contentHash: document.contentHash,
      }))
      .sort((left, right) =>
        left.purpose.localeCompare(right.purpose),
      ),
  });
}

function bindingHash(input: {
  readonly authorizationHash: string;
  readonly requestHash: string;
  readonly sourceResultEnvelopeHash: string;
  readonly releaseContentHash: string;
}): string {
  return canonicalHash({
    domain: "dark-factory.behavioral-release-one-use-binding.v1",
    ...input,
  });
}

function schemaForPurpose(
  purpose: BehavioralReleaseArtifact["purpose"],
):
  | "behavioralEvidence"
  | "failureCards"
  | "diagnosticBrief"
  | "signedBehavioralRelease" {
  switch (purpose) {
    case "behavioral-evidence":
      return "behavioralEvidence";
    case "failure-cards":
      return "failureCards";
    case "diagnostic-brief":
      return "diagnosticBrief";
    case "behavioral-release":
      return "signedBehavioralRelease";
  }
}

function artifactsByPurpose(
  artifacts: readonly BehavioralReleaseArtifact[],
): ReadonlyMap<
  BehavioralReleaseArtifact["purpose"],
  BehavioralReleaseArtifact
> {
  if (artifacts.length !== PURPOSES.length) fail();
  const result = new Map<
    BehavioralReleaseArtifact["purpose"],
    BehavioralReleaseArtifact
  >();
  for (const artifact of artifacts) {
    exactKeys(artifact, ARTIFACT_KEYS);
    if (
      !PURPOSES.includes(artifact.purpose) ||
      result.has(artifact.purpose)
    ) {
      fail();
    }
    assertValidDocument(
      schemaForPurpose(artifact.purpose),
      artifact.document,
    );
    assertHash(artifact.document.contentHash);
    result.set(artifact.purpose, artifact);
  }
  if (PURPOSES.some((purpose) => !result.has(purpose))) fail();
  try {
    assertSafeForLocalPersistence(artifacts);
  } catch {
    fail();
  }
  return result;
}

function artifactFor<
  Purpose extends BehavioralReleaseArtifact["purpose"],
>(
  artifacts: ReadonlyMap<
    BehavioralReleaseArtifact["purpose"],
    BehavioralReleaseArtifact
  >,
  purpose: Purpose,
): Extract<BehavioralReleaseArtifact, { readonly purpose: Purpose }> {
  const artifact = artifacts.get(purpose);
  if (artifact === undefined || artifact.purpose !== purpose) fail();
  return artifact as Extract<
    BehavioralReleaseArtifact,
    { readonly purpose: Purpose }
  >;
}

function assertArtifactBindings(
  artifacts: readonly BehavioralReleaseArtifact[],
  sourceResultEnvelopeHash: string,
  releaseContentHash: string,
): void {
  const byPurpose = artifactsByPurpose(artifacts);
  const evidence = artifactFor(
    byPurpose,
    "behavioral-evidence",
  ).document;
  const cards = artifactFor(byPurpose, "failure-cards").document;
  const brief = artifactFor(
    byPurpose,
    "diagnostic-brief",
  ).document;
  const release = artifactFor(
    byPurpose,
    "behavioral-release",
  ).document;
  if (
    release.contentHash !== releaseContentHash ||
    release.sourceResultEnvelopeHash !==
      sourceResultEnvelopeHash ||
    evidence.sourceEnvelopeHash !== sourceResultEnvelopeHash ||
    release.aggregateArtifactHashes.behavioralEvidence !==
      evidence.contentHash ||
    release.aggregateArtifactHashes.failureCards !==
      cards.contentHash ||
    release.aggregateArtifactHashes.diagnosticBrief !==
      brief.contentHash ||
    cards.behavioralEvidenceHash !== evidence.contentHash ||
    brief.aggregateEvidenceHash !== evidence.contentHash ||
    brief.failureCardsHash !== cards.contentHash ||
    release.releaseId !== brief.releaseId ||
    evidence.experimentNumber !== release.experimentNumber ||
    cards.experimentNumber !== release.experimentNumber ||
    brief.experimentNumber !== release.experimentNumber ||
    brief.sourceExperimentNumber !== release.experimentNumber ||
    canonicalJson(evidence.policyVersions) !==
      canonicalJson(release.policyVersions) ||
    canonicalJson(cards.policyVersions) !==
      canonicalJson(release.policyVersions) ||
    canonicalJson(brief.policyVersions) !==
      canonicalJson(release.policyVersions)
  ) {
    fail();
  }
  const hashes = artifacts.map(
    (artifact) => artifact.document.contentHash,
  );
  if (new Set(hashes).size !== hashes.length) fail();
}

function assertArtifactsContainNoHiddenTaskIds(
  artifacts: readonly BehavioralReleaseArtifact[],
  privacyState: HiddenPrivacyBudgetState,
): void {
  const serialized = canonicalJson(artifacts).toLocaleLowerCase(
    "en-US",
  );
  if (
    privacyState.priorReleases.some((release) =>
      release.taskIds.some((taskId) =>
        serialized.includes(taskId.toLocaleLowerCase("en-US")),
      ),
    )
  ) {
    fail();
  }
}

function assertCommit(
  value: unknown,
): asserts value is DurableBehavioralReleaseCommit {
  exactKeys(value, COMMIT_KEYS);
  assertHash(value.authorizationHash);
  assertHash(value.requestHash);
  assertHash(value.sourceResultEnvelopeHash);
  assertHash(value.releaseContentHash);
  assertHash(value.priorPrivacyStateHash);
  assertHash(value.privacyStateHash);
  assertHash(value.bindingHash);
  assertHash(value.artifactSetHash);
  if (
    (value.orphanedAt !== null &&
      !isCanonicalTimestamp(value.orphanedAt)) ||
    !Array.isArray(value.artifacts)
  ) {
    fail();
  }
  const artifacts =
    value.artifacts as unknown as readonly BehavioralReleaseArtifact[];
  assertArtifactBindings(
    artifacts,
    value.sourceResultEnvelopeHash,
    value.releaseContentHash,
  );
  if (
    value.bindingHash !==
      bindingHash({
        authorizationHash: value.authorizationHash,
        requestHash: value.requestHash,
        sourceResultEnvelopeHash:
          value.sourceResultEnvelopeHash,
        releaseContentHash: value.releaseContentHash,
      }) ||
    value.artifactSetHash !== artifactSetHash(artifacts)
  ) {
    fail();
  }
  if (value.orphanedAt !== null) {
    const release = artifactFor(
      artifactsByPurpose(artifacts),
      "behavioral-release",
    ).document;
    if (
      Date.parse(value.orphanedAt) <
      Date.parse(release.createdAt)
    ) {
      fail();
    }
  }
}

function assertOwnerIndex(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail();
}

function assertState(
  value: unknown,
  input: {
    readonly scopeHash: string;
    readonly initialPrivacyState: HiddenPrivacyBudgetState;
  },
): asserts value is DurableBehavioralPrivacyState {
  exactKeys(value, STATE_KEYS);
  if (
    value.schemaVersion !== 1 ||
    value.sensitivity !==
      "trusted-hidden-privacy-ledger-and-release-artifacts" ||
    value.scopeHash !== input.scopeHash ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.commitOrder) ||
    value.commitOrder.length > MAXIMUM_RELEASES ||
    !isPlainRecord(value.commits)
  ) {
    fail();
  }
  assertPrivacyState(value.privacyState);
  assertHash(value.privacyStateHash);
  assertSafeHashRecord(value.requestOwners);
  assertSafeHashRecord(value.sourceResultOwners);
  assertSafeHashRecord(value.releaseOwners);
  assertSafeHashRecord(value.artifactOwners);
  if (
    value.privacyStateHash !==
      hashHiddenPrivacyBudgetState(value.privacyState) ||
    value.privacyState.policyVersion !==
      input.initialPrivacyState.policyVersion ||
    value.privacyState.maximumReleases !==
      input.initialPrivacyState.maximumReleases ||
    value.privacyState.releasesUsed !==
      value.commitOrder.length ||
    value.revision !==
      value.commitOrder.length +
        Object.values(value.commits).filter(
          (commit) =>
            isPlainRecord(commit) &&
            commit["orphanedAt"] !== null,
        ).length ||
    Object.keys(value.commits).length !== value.commitOrder.length ||
    new Set(value.commitOrder).size !== value.commitOrder.length
  ) {
    fail();
  }

  const expectedRequests: Record<string, string> = {};
  const expectedSources: Record<string, string> = {};
  const expectedReleases: Record<string, string> = {};
  const expectedArtifacts: Record<string, string> = {};
  let priorState = input.initialPrivacyState;
  for (const [index, authorizationHash] of
    value.commitOrder.entries()) {
    assertHash(authorizationHash);
    const commit = value.commits[authorizationHash];
    if (commit === undefined) fail();
    assertCommit(commit);
    const nextState = privacyPrefix(
      input.initialPrivacyState,
      value.privacyState,
      index + 1,
    );
    const releaseLedger =
      value.privacyState.priorReleases[index];
    if (
      commit.authorizationHash !== authorizationHash ||
      commit.priorPrivacyStateHash !==
        hashHiddenPrivacyBudgetState(priorState) ||
      commit.privacyStateHash !==
        hashHiddenPrivacyBudgetState(nextState) ||
      releaseLedger === undefined ||
      releaseLedger.experimentDigest !==
        canonicalHash({
          domain:
            "dark-factory.behavioral-release-experiment.v1",
          requestHash: commit.requestHash,
        })
    ) {
      fail();
    }
    if (
      expectedRequests[commit.requestHash] !== undefined ||
      expectedSources[commit.sourceResultEnvelopeHash] !==
        undefined ||
      expectedReleases[commit.releaseContentHash] !== undefined
    ) {
      fail();
    }
    assertArtifactsContainNoHiddenTaskIds(
      commit.artifacts,
      value.privacyState,
    );
    expectedRequests[commit.requestHash] = authorizationHash;
    expectedSources[commit.sourceResultEnvelopeHash] =
      authorizationHash;
    expectedReleases[commit.releaseContentHash] =
      authorizationHash;
    for (const artifact of commit.artifacts) {
      const hash = artifact.document.contentHash;
      if (expectedArtifacts[hash] !== undefined) fail();
      expectedArtifacts[hash] = authorizationHash;
    }
    priorState = nextState;
  }
  assertOwnerIndex(value.requestOwners, expectedRequests);
  assertOwnerIndex(value.sourceResultOwners, expectedSources);
  assertOwnerIndex(value.releaseOwners, expectedReleases);
  assertOwnerIndex(value.artifactOwners, expectedArtifacts);
}

function assertPristineInitialPrivacyState(
  value: HiddenPrivacyBudgetState,
): void {
  assertPrivacyState(value);
  if (value.releasesUsed !== 0 || value.priorReleases.length !== 0) {
    fail();
  }
}

function assertNextPrivacyTransition(
  current: HiddenPrivacyBudgetState,
  next: HiddenPrivacyBudgetState,
  requestHash: string,
): void {
  assertPrivacyState(next);
  if (
    next.policyVersion !== current.policyVersion ||
    next.maximumReleases !== current.maximumReleases ||
    next.releasesUsed !== current.releasesUsed + 1 ||
    next.priorReleases.length !==
      current.priorReleases.length + 1 ||
    canonicalJson(
      next.priorReleases.slice(0, current.priorReleases.length),
    ) !== canonicalJson(current.priorReleases)
  ) {
    fail();
  }
  const appended =
    next.priorReleases[next.priorReleases.length - 1];
  if (
    appended === undefined ||
    appended.experimentDigest !==
      canonicalHash({
        domain: "dark-factory.behavioral-release-experiment.v1",
        requestHash,
      })
  ) {
    fail();
  }
}

/**
 * One mounted-volume transaction contains the nonrefundable hidden privacy
 * ledger and the complete four-document task-free release bundle. There is no
 * intermediate artifact registry commit: the state-envelope rename is the
 * sole visibility point.
 */
export class MountedVolumeBehavioralPrivacyArtifactStore
  implements TrustedBehavioralPrivacyArtifactStore
{
  readonly boundary = "trusted-cloud" as const;
  readonly lifecycleId: string;
  readonly lifecycleResource: TrustedProductionOptimizeCloseable;
  readonly #store: MountedVolumeTransactionalJsonStore<DurableBehavioralPrivacyState>;

  constructor(
    options: MountedVolumeBehavioralPrivacyArtifactStoreOptions,
  ) {
    exactKeys(options, [
      "durableState",
      "initialPrivacyState",
      ...(options.lifecycle === undefined ? [] : ["lifecycle"]),
    ]);
    if (
      options.lifecycle !== undefined &&
      (options.lifecycle.boundary !==
        "production-optimize-composition-owner" ||
        typeof options.lifecycle.register !== "function")
    ) {
      fail();
    }
    const initialPrivacyState = canonicalClone(
      options.initialPrivacyState,
    );
    assertPristineInitialPrivacyState(initialPrivacyState);
    const scopeHash = canonicalHash({
      domain:
        "dark-factory.behavioral-privacy-artifact-store-scope.v1",
      storeId: options.durableState.storeId,
      initialPrivacyState,
    });
    this.lifecycleId = `behavioral-privacy-${scopeHash.slice(0, 24)}`;
    this.#store =
      new MountedVolumeTransactionalJsonStore<DurableBehavioralPrivacyState>(
        options.durableState,
        `behavioral-privacy-${options.durableState.storeId}`,
        {
          domain:
            "dark-factory.behavioral-privacy-artifact-state.v1",
          initialState: () => ({
            schemaVersion: 1,
            sensitivity:
              "trusted-hidden-privacy-ledger-and-release-artifacts",
            scopeHash,
            revision: 0,
            privacyState: initialPrivacyState,
            privacyStateHash:
              hashHiddenPrivacyBudgetState(initialPrivacyState),
            commitOrder: [],
            commits: {},
            requestOwners: {},
            sourceResultOwners: {},
            releaseOwners: {},
            artifactOwners: {},
          }),
          assertState(
            value,
          ): asserts value is DurableBehavioralPrivacyState {
            assertState(value, {
              scopeHash,
              initialPrivacyState,
            });
          },
          revision: (state) => state.revision,
        },
      );
    this.lifecycleResource = Object.freeze({
      boundary:
        "trusted-cloud-production-optimize-lifecycle" as const,
      lifecycleId: this.lifecycleId,
      close: (): Promise<void> => this.close(),
    });
    options.lifecycle?.register(this.lifecycleResource);
  }

  async load(): Promise<TrustedBehavioralPrivacySnapshot> {
    const snapshot = await this.#store.transact((state) => ({
      next: state,
      result: {
        privacyState: state.privacyState,
        privacyStateHash: state.privacyStateHash,
      },
    }));
    return canonicalClone(snapshot);
  }

  async resolveByContentHash(input: {
    readonly purpose: BehavioralReleaseArtifact["purpose"];
    readonly contentHash: string;
  }): Promise<BehavioralReleaseArtifact | undefined> {
    const query = canonicalClone(input);
    if (
      !PURPOSES.includes(query.purpose) ||
      !SHA256.test(query.contentHash)
    ) {
      fail();
    }
    const artifact = await this.#store.transact((state) => {
      const authorizationHash =
        state.artifactOwners[query.contentHash];
      if (authorizationHash === undefined) {
        return { next: state, result: undefined };
      }
      const commit = state.commits[authorizationHash];
      if (commit === undefined) fail();
      if (commit.orphanedAt !== null) {
        return { next: state, result: undefined };
      }
      const exact = commit.artifacts.find(
        (candidate) =>
          candidate.purpose === query.purpose &&
          candidate.document.contentHash === query.contentHash,
      );
      return { next: state, result: exact };
    });
    return artifact === undefined
      ? undefined
      : canonicalClone(artifact);
  }

  async inspectCommit(
    originalInput: Parameters<
      TrustedBehavioralPrivacyArtifactStore["inspectCommit"]
    >[0],
  ): Promise<TrustedBehavioralReleaseCommitInspection> {
    try {
      const input = canonicalClone(originalInput);
      exactKeys(input, COMMIT_INSPECTION_KEYS);
      assertHash(input.authorizationHash);
      assertHash(input.requestHash);
      assertHash(input.sourceResultEnvelopeHash);
      assertHash(input.releaseContentHash);
      assertHash(input.artifactSetHash);
      const result =
        await this.#store.transact<TrustedBehavioralReleaseCommitInspection>(
          (state) => {
            const authorizationCommit =
              state.commits[input.authorizationHash];
            const requestOwner =
              state.requestOwners[input.requestHash];
            const sourceOwner =
              state.sourceResultOwners[
                input.sourceResultEnvelopeHash
              ];
            const releaseOwner =
              state.releaseOwners[input.releaseContentHash];
            const artifactSetOwner = Object.values(
              state.commits,
            ).find(
              (commit) =>
                commit.artifactSetHash === input.artifactSetHash,
            )?.authorizationHash;
            if (
              authorizationCommit === undefined &&
              requestOwner === undefined &&
              sourceOwner === undefined &&
              releaseOwner === undefined &&
              artifactSetOwner === undefined
            ) {
              return {
                next: state,
                result: { status: "absent" as const },
              };
            }
            if (
              authorizationCommit === undefined ||
              requestOwner !== input.authorizationHash ||
              sourceOwner !== input.authorizationHash ||
              releaseOwner !== input.authorizationHash ||
              artifactSetOwner !== input.authorizationHash ||
              authorizationCommit.requestHash !==
                input.requestHash ||
              authorizationCommit.sourceResultEnvelopeHash !==
                input.sourceResultEnvelopeHash ||
              authorizationCommit.releaseContentHash !==
                input.releaseContentHash ||
              authorizationCommit.artifactSetHash !==
                input.artifactSetHash
            ) {
              return {
                next: state,
                result: { status: "conflict" as const },
              };
            }
            const artifactReferences =
              authorizationCommit.artifacts.map(
                ({ purpose, document }) => ({
                  purpose,
                  contentHash: document.contentHash,
                }),
              );
            const [first, second, third, fourth] =
              artifactReferences;
            if (
              artifactReferences.length !== PURPOSES.length ||
              first === undefined ||
              second === undefined ||
              third === undefined ||
              fourth === undefined
            ) {
              fail();
            }
            return {
              next: state,
              result: {
                status: "committed" as const,
                receipt: {
                  status: "already-committed" as const,
                  authorizationHash: input.authorizationHash,
                  bindingHash: authorizationCommit.bindingHash,
                  privacyStateHash:
                    authorizationCommit.privacyStateHash,
                  artifactSetHash:
                    authorizationCommit.artifactSetHash,
                },
                artifactReferences: [
                  first,
                  second,
                  third,
                  fourth,
                ],
                orphanedAt: authorizationCommit.orphanedAt,
              },
            };
          },
        );
      return canonicalClone(result);
    } catch {
      return { status: "ambiguous" };
    }
  }

  async commit(
    originalInput: Parameters<
      TrustedBehavioralPrivacyArtifactStore["commit"]
    >[0],
  ): Promise<TrustedBehavioralReleaseCommitReceipt> {
    const input = canonicalClone(originalInput);
    assertHash(input.authorizationHash);
    assertHash(input.requestHash);
    assertHash(input.sourceResultEnvelopeHash);
    assertHash(input.releaseContentHash);
    assertHash(input.priorPrivacyStateHash);
    assertPrivacyState(input.nextPrivacyState);
    assertArtifactBindings(
      input.artifacts,
      input.sourceResultEnvelopeHash,
      input.releaseContentHash,
    );
    assertArtifactsContainNoHiddenTaskIds(
      input.artifacts,
      input.nextPrivacyState,
    );
    const nextPrivacyStateHash = hashHiddenPrivacyBudgetState(
      input.nextPrivacyState,
    );
    const expectedBindingHash = bindingHash(input);
    const expectedArtifactSetHash = artifactSetHash(
      input.artifacts,
    );

    const transact = (): Promise<TrustedBehavioralReleaseCommitReceipt> =>
      this.#store.transact((state) => {
        const existing = state.commits[input.authorizationHash];
        if (existing !== undefined) {
          if (
            existing.requestHash !== input.requestHash ||
            existing.sourceResultEnvelopeHash !==
              input.sourceResultEnvelopeHash ||
            existing.releaseContentHash !==
              input.releaseContentHash ||
            existing.priorPrivacyStateHash !==
              input.priorPrivacyStateHash ||
            existing.privacyStateHash !== nextPrivacyStateHash ||
            existing.bindingHash !== expectedBindingHash ||
            existing.artifactSetHash !==
              expectedArtifactSetHash ||
            canonicalJson(existing.artifacts) !==
              canonicalJson(input.artifacts)
          ) {
            fail();
          }
          return {
            next: state,
            result: {
              status: "already-committed" as const,
              authorizationHash: input.authorizationHash,
              bindingHash: existing.bindingHash,
              privacyStateHash: existing.privacyStateHash,
              artifactSetHash: existing.artifactSetHash,
            },
          };
        }
        if (
          input.priorPrivacyStateHash !==
            state.privacyStateHash ||
          state.commitOrder.length >=
            state.privacyState.maximumReleases ||
          state.requestOwners[input.requestHash] !== undefined ||
          state.sourceResultOwners[
            input.sourceResultEnvelopeHash
          ] !== undefined ||
          state.releaseOwners[input.releaseContentHash] !==
            undefined ||
          input.artifacts.some(
            (artifact) =>
              state.artifactOwners[
                artifact.document.contentHash
              ] !== undefined,
          )
        ) {
          fail();
        }
        assertNextPrivacyTransition(
          state.privacyState,
          input.nextPrivacyState,
          input.requestHash,
        );
        const commit: DurableBehavioralReleaseCommit = {
          authorizationHash: input.authorizationHash,
          requestHash: input.requestHash,
          sourceResultEnvelopeHash:
            input.sourceResultEnvelopeHash,
          releaseContentHash: input.releaseContentHash,
          priorPrivacyStateHash: input.priorPrivacyStateHash,
          privacyStateHash: nextPrivacyStateHash,
          bindingHash: expectedBindingHash,
          artifactSetHash: expectedArtifactSetHash,
          artifacts: input.artifacts,
          orphanedAt: null,
        };
        const artifactOwners = {
          ...state.artifactOwners,
        };
        for (const artifact of input.artifacts) {
          artifactOwners[artifact.document.contentHash] =
            input.authorizationHash;
        }
        const next: DurableBehavioralPrivacyState = {
          ...state,
          revision: state.revision + 1,
          privacyState: input.nextPrivacyState,
          privacyStateHash: nextPrivacyStateHash,
          commitOrder: [
            ...state.commitOrder,
            input.authorizationHash,
          ],
          commits: {
            ...state.commits,
            [input.authorizationHash]: commit,
          },
          requestOwners: {
            ...state.requestOwners,
            [input.requestHash]: input.authorizationHash,
          },
          sourceResultOwners: {
            ...state.sourceResultOwners,
            [input.sourceResultEnvelopeHash]:
              input.authorizationHash,
          },
          releaseOwners: {
            ...state.releaseOwners,
            [input.releaseContentHash]: input.authorizationHash,
          },
          artifactOwners,
        };
        return {
          next,
          result: {
            status: "committed" as const,
            authorizationHash: input.authorizationHash,
            bindingHash: expectedBindingHash,
            privacyStateHash: nextPrivacyStateHash,
            artifactSetHash: expectedArtifactSetHash,
          },
        };
      });
    try {
      return await transact();
    } catch {
      /*
       * A provider error after the state-envelope rename can make the first
       * acknowledgement ambiguous. One bounded replay of the exact captured
       * command either returns the historical receipt or fails closed.
       */
      return transact();
    }
  }

  async orphan(
    originalInput: Parameters<
      TrustedBehavioralPrivacyArtifactStore["orphan"]
    >[0],
  ): Promise<TrustedBehavioralReleaseOrphanReceipt> {
    const input = canonicalClone(originalInput);
    exactKeys(input, ORPHAN_KEYS);
    assertHash(input.authorizationHash);
    assertHash(input.requestHash);
    assertHash(input.releaseContentHash);
    if (!isCanonicalTimestamp(input.orphanedAt)) fail();
    const transact = (): Promise<TrustedBehavioralReleaseOrphanReceipt> =>
      this.#store.transact((state) => {
        const commit = state.commits[input.authorizationHash];
        if (
          commit === undefined ||
          commit.requestHash !== input.requestHash ||
          commit.releaseContentHash !==
            input.releaseContentHash ||
          state.requestOwners[input.requestHash] !==
            input.authorizationHash ||
          state.releaseOwners[input.releaseContentHash] !==
            input.authorizationHash
        ) {
          fail();
        }
        const release = artifactFor(
          artifactsByPurpose(commit.artifacts),
          "behavioral-release",
        ).document;
        if (
          Date.parse(input.orphanedAt) <
            Date.parse(release.createdAt) ||
          (commit.orphanedAt !== null &&
            Date.parse(input.orphanedAt) <
              Date.parse(commit.orphanedAt))
        ) {
          fail();
        }
        if (commit.orphanedAt !== null) {
          return {
            next: state,
            result: {
              status: "already-orphaned" as const,
              authorizationHash: input.authorizationHash,
              requestHash: input.requestHash,
              releaseContentHash: input.releaseContentHash,
              orphanedAt: commit.orphanedAt,
            },
          };
        }
        const next: DurableBehavioralPrivacyState = {
          ...state,
          revision: state.revision + 1,
          commits: {
            ...state.commits,
            [input.authorizationHash]: {
              ...commit,
              orphanedAt: input.orphanedAt,
            },
          },
        };
        return {
          next,
          result: {
            status: "orphaned" as const,
            authorizationHash: input.authorizationHash,
            requestHash: input.requestHash,
            releaseContentHash: input.releaseContentHash,
            orphanedAt: input.orphanedAt,
          },
        };
      });
    try {
      return await transact();
    } catch {
      return transact();
    }
  }

  close(): Promise<void> {
    return this.#store.close();
  }
}
