import {
  createEd25519Signature,
  verifyEd25519Signature,
} from "../evidence/signatures.js";
import {
  assertReleaseContainsNoLiterals,
  releaseBehaviorCards,
  type HiddenPrivacyBudgetState,
  type ReleaseSafeBehaviorCard,
} from "../evaluation/privacy.js";
import type {
  BehavioralEvidence,
  DiagnosticBrief,
  FailureCards,
} from "../schemas/artifacts.js";
import {
  canonicalHash,
  canonicalJson,
  withContentHash,
} from "../schemas/canonical.js";
import type {
  PrivacySupport,
  Signature,
} from "../schemas/primitives.js";
import { assertValidDocument } from "../schemas/registry.js";
import type { SignedBehavioralRelease } from "../schemas/trusted.js";
import {
  type TrustedCloudEd25519PrivateKeyProvider,
  type TrustedCloudEd25519PublicKeyProvider,
} from "./hidden-update-signature.js";
import type { TrustedPrivateBehavioralPreparation } from "./deriver.js";
import type { TrustedRawDestructionReceipt } from "./retention.js";
import { assertSafeForLocalPersistence } from "./retention.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_KEY_ID =
  /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const SAFE_KEY_VERSION =
  /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;

export type BehavioralReleaseArtifact =
  | {
      readonly purpose: "behavioral-release";
      readonly document: SignedBehavioralRelease;
    }
  | {
      readonly purpose: "behavioral-evidence";
      readonly document: BehavioralEvidence;
    }
  | {
      readonly purpose: "failure-cards";
      readonly document: FailureCards;
    }
  | {
      readonly purpose: "diagnostic-brief";
      readonly document: DiagnosticBrief;
    };

export interface TrustedBehavioralPrivacySnapshot {
  readonly privacyState: HiddenPrivacyBudgetState;
  readonly privacyStateHash: string;
}

export interface TrustedBehavioralReleaseCommitReceipt {
  readonly status: "committed" | "already-committed";
  readonly authorizationHash: string;
  readonly bindingHash: string;
  readonly privacyStateHash: string;
  readonly artifactSetHash: string;
}

export interface BehavioralReleaseArtifactReference {
  readonly purpose: BehavioralReleaseArtifact["purpose"];
  readonly contentHash: string;
}

export interface TrustedBehavioralReleaseCommitInspectionQuery {
  readonly authorizationHash: string;
  readonly requestHash: string;
  readonly sourceResultEnvelopeHash: string;
  readonly releaseContentHash: string;
  readonly artifactSetHash: string;
}

export type TrustedBehavioralReleaseCommitInspection =
  | {
      readonly status: "committed";
      readonly receipt: TrustedBehavioralReleaseCommitReceipt;
      readonly artifactReferences: readonly [
        BehavioralReleaseArtifactReference,
        BehavioralReleaseArtifactReference,
        BehavioralReleaseArtifactReference,
        BehavioralReleaseArtifactReference,
      ];
      readonly orphanedAt: string | null;
    }
  | {
      readonly status: "absent" | "conflict" | "ambiguous";
    };

export interface TrustedBehavioralReleaseOrphanReceipt {
  readonly status: "orphaned" | "already-orphaned";
  readonly authorizationHash: string;
  readonly requestHash: string;
  readonly releaseContentHash: string;
  readonly orphanedAt: string;
}

/**
 * This port is one durable transaction boundary. Implementations compare the
 * supplied prior state hash and atomically persist both the nonrefundable next
 * privacy ledger and all four immutable artifacts. They must never expose a
 * prefix, refund a committed ledger entry, or offer artifact deletion. Their
 * release-facing reader is a separate content-hash-only capability: it must
 * not enumerate artifacts, and it must deny permanently orphaned commits.
 * Authorization, request, source-result, and release hashes are one-use, so a
 * complete bundle can never be rebound to another result.
 */
export interface TrustedBehavioralPrivacyArtifactStore {
  readonly boundary: "trusted-cloud" | "test-only-in-memory";
  load(): Promise<TrustedBehavioralPrivacySnapshot>;
  resolveByContentHash(input: {
    readonly purpose: BehavioralReleaseArtifact["purpose"];
    readonly contentHash: string;
  }): Promise<BehavioralReleaseArtifact | undefined>;
  /**
   * Exact, non-enumerating reconciliation after an ambiguous commit
   * acknowledgement. This read must not mutate the release ledger, spend
   * privacy, publish artifacts, clear an orphan, or establish a new binding.
   */
  inspectCommit(
    input: TrustedBehavioralReleaseCommitInspectionQuery,
  ): Promise<TrustedBehavioralReleaseCommitInspection>;
  commit(input: {
    readonly authorizationHash: string;
    readonly requestHash: string;
    readonly sourceResultEnvelopeHash: string;
    readonly releaseContentHash: string;
    readonly priorPrivacyStateHash: string;
    readonly nextPrivacyState: HiddenPrivacyBudgetState;
    readonly artifacts: readonly [
      BehavioralReleaseArtifact,
      BehavioralReleaseArtifact,
      BehavioralReleaseArtifact,
      BehavioralReleaseArtifact,
    ];
  }): Promise<TrustedBehavioralReleaseCommitReceipt>;
  orphan(input: {
    readonly authorizationHash: string;
    readonly requestHash: string;
    readonly releaseContentHash: string;
    readonly orphanedAt: string;
  }): Promise<TrustedBehavioralReleaseOrphanReceipt>;
}

export interface TrustedBehavioralReleaseFinalization {
  readonly contentHash: string;
  readonly sourceSetHash: string;
  readonly privacyThresholdPassed: true;
  /** Opaque evaluator-only handle; never placed in the result envelope. */
  readonly authorizationHash: string;
  readonly requestHash: string;
}

/**
 * Stable task-free proof that a committed behavioral release was permanently
 * orphaned. `status` is deliberately normalized: an exact replay after the
 * first durable orphan transaction returns the same receipt and attestation.
 */
export interface TrustedBehavioralReleaseOrphanFinalizationReceipt {
  readonly status: "orphaned";
  readonly authorizationHash: string;
  readonly requestHash: string;
  readonly releaseContentHash: string;
  readonly sourceSetHash: string;
  readonly orphanedAt: string;
  readonly orphanFinalizationHash: string;
}

export interface TrustedPostDestructionBehavioralReleaseProducer {
  finalize(input: {
    readonly preparation: TrustedPrivateBehavioralPreparation;
    readonly sourceResultEnvelopeHash: string;
    readonly destructionReceipt: Pick<
      TrustedRawDestructionReceipt,
      "destroyedAt" | "verifierAttestationHash"
    >;
  }): Promise<TrustedBehavioralReleaseFinalization | null>;
  orphan(
    finalization: TrustedBehavioralReleaseFinalization,
  ): Promise<TrustedBehavioralReleaseOrphanFinalizationReceipt>;
}

export interface DeterministicBehavioralReleaseProducerOptions {
  readonly deployment: "trusted-cloud" | "test-only";
  readonly store: TrustedBehavioralPrivacyArtifactStore;
  readonly keyId: string;
  readonly privateKeys: TrustedCloudEd25519PrivateKeyProvider;
  readonly publicKeys: TrustedCloudEd25519PublicKeyProvider;
  readonly now?: () => Date;
}

export class TrustedBehavioralReleaseProducerError extends Error {
  override readonly name = "TrustedBehavioralReleaseProducerError";

  constructor(
    readonly finalizationDisposition:
      | "known-not-committed"
      | "unsafe-to-consume" = "known-not-committed",
  ) {
    super("Behavioral release finalization failed closed.");
  }
}

export function hashHiddenPrivacyBudgetState(
  state: HiddenPrivacyBudgetState,
): string {
  return canonicalHash({
    domain: "dark-factory.hidden-privacy-budget-state.v1",
    state,
  });
}

export function hashTrustedBehavioralReleaseOrphanFinalization(
  input: Omit<
    TrustedBehavioralReleaseOrphanFinalizationReceipt,
    "status" | "orphanFinalizationHash"
  >,
): string {
  return canonicalHash({
    domain:
      "dark-factory.behavioral-release-orphan-finalization.v1",
    ...input,
  });
}

function canonicalClone<Value>(value: Value): Value {
  return JSON.parse(canonicalJson(value)) as Value;
}

function deepFreezeJson<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    value.forEach(deepFreezeJson);
    return Object.freeze(value) as Value;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    Object.values(value).forEach(deepFreezeJson);
    return Object.freeze(value) as Value;
  }
  return value;
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

function artifactReferences(
  artifacts: readonly BehavioralReleaseArtifact[],
): readonly [
  BehavioralReleaseArtifactReference,
  BehavioralReleaseArtifactReference,
  BehavioralReleaseArtifactReference,
  BehavioralReleaseArtifactReference,
] {
  if (artifacts.length !== 4) {
    throw new Error("Behavioral release artifact set is incomplete.");
  }
  const references = artifacts.map(({ purpose, document }) => ({
    purpose,
    contentHash: document.contentHash,
  }));
  const [first, second, third, fourth] = references;
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined
  ) {
    throw new Error("Behavioral release artifact set is incomplete.");
  }
  return [first, second, third, fourth];
}

function assertRecoveredCommit(
  inspection: TrustedBehavioralReleaseCommitInspection,
  input: {
    readonly authorizationHash: string;
    readonly bindingHash: string;
    readonly privacyStateHash: string;
    readonly artifactSetHash: string;
    readonly artifacts: readonly BehavioralReleaseArtifact[];
  },
): void {
  if (
    inspection.status !== "committed" ||
    inspection.orphanedAt !== null ||
    (inspection.receipt.status !== "committed" &&
      inspection.receipt.status !== "already-committed") ||
    inspection.receipt.authorizationHash !==
      input.authorizationHash ||
    inspection.receipt.bindingHash !== input.bindingHash ||
    inspection.receipt.privacyStateHash !==
      input.privacyStateHash ||
    inspection.receipt.artifactSetHash !==
      input.artifactSetHash ||
    canonicalJson(
      [...inspection.artifactReferences].sort((left, right) =>
        left.purpose.localeCompare(right.purpose),
      ),
    ) !==
      canonicalJson(
        [...artifactReferences(input.artifacts)].sort((left, right) =>
          left.purpose.localeCompare(right.purpose),
        ),
      )
  ) {
    throw new Error("Behavioral release reconciliation is detached.");
  }
}

function canonicalTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    throw new Error("Timestamp is not canonical UTC.");
  }
  return parsed;
}

function supportBandForTasks(count: number): "5-9" | "10-19" | "20+" {
  return count < 10 ? "5-9" : count < 20 ? "10-19" : "20+";
}

function supportBandForTrajectories(
  count: number,
): "20-39" | "40-79" | "80+" {
  return count < 40 ? "20-39" : count < 80 ? "40-79" : "80+";
}

function privacySupport(
  preparation: TrustedPrivateBehavioralPreparation,
): PrivacySupport {
  const tasks = new Set(
    preparation.observations.map((observation) => observation.taskId),
  );
  const candidates = preparation.observations.filter(
    (observation) => observation.arm === "candidate",
  );
  const champions = preparation.observations.filter(
    (observation) => observation.arm === "champion",
  );
  return {
    distinctTaskCountBand: supportBandForTasks(tasks.size),
    trajectoryCountBand: supportBandForTrajectories(
      preparation.observations.length,
    ),
    minimumComparedGroupSizeBand: supportBandForTasks(
      Math.min(candidates.length, champions.length),
    ),
    complementaryCountSuppressionPassed: true,
    differencingBudgetPassed: true,
  };
}

function metricFeature(
  feature: ReleaseSafeBehaviorCard["feature"],
): BehavioralEvidence["metrics"][number]["feature"] {
  const mapping = {
    "invalid-tool-invocation": "invalid-tool-invocation",
    "nonzero-without-inspection": "nonzero-exit",
    "repeated-action": "repeated-action",
    "recovery-after-failure": "recovery-transition",
    "replan-after-failure": "replan-transition",
    verification: "verification-action",
    "premature-termination": "premature-termination",
    compaction: "compaction-event",
    "plan-before-execution": "plan-before-execution",
  } as const;
  return mapping[feature];
}

function affectedComponent(
  feature: ReleaseSafeBehaviorCard["feature"],
): string {
  const mapping = {
    "invalid-tool-invocation": "tool-policy",
    "nonzero-without-inspection": "recovery-policy",
    "repeated-action": "replanning-policy",
    "recovery-after-failure": "recovery-policy",
    "replan-after-failure": "replanning-policy",
    verification: "verification-policy",
    "premature-termination": "termination-policy",
    compaction: "context-policy",
    "plan-before-execution": "planning-policy",
  } as const;
  return mapping[feature];
}

function genericTitle(
  feature: ReleaseSafeBehaviorCard["feature"],
): string {
  return `Aggregate ${feature.replaceAll("-", " ")} association`;
}

function genericRecommendation(
  feature: ReleaseSafeBehaviorCard["feature"],
): string {
  const component = affectedComponent(feature).replaceAll("-", " ");
  return `Review generic ${component} behavior without conditioning on benchmark identity.`;
}

function prevalencePair(effect: number): readonly [number, number] {
  const left = Math.max(0, Math.min(1, 0.5 + effect / 2));
  const right = Math.max(0, Math.min(1, 0.5 - effect / 2));
  return [Number(left.toFixed(2)), Number(right.toFixed(2))];
}

function suppressedFindingCountBand(
  releasedCardCount: number,
): BehavioralEvidence["suppressedFindingCountBand"] {
  const count = Math.max(0, 9 - releasedCardCount);
  return count === 0
    ? "0"
    : count < 5
      ? "1-4"
      : count < 10
        ? "5-9"
        : count < 20
          ? "10-19"
          : "20+";
}

function makeArtifacts(input: {
  readonly preparation: TrustedPrivateBehavioralPreparation;
  readonly sourceResultEnvelopeHash: string;
  readonly cards: readonly ReleaseSafeBehaviorCard[];
  readonly support: PrivacySupport;
  readonly createdAt: string;
  readonly signature: (
    unsigned: Readonly<Record<string, unknown>>,
  ) => Promise<Signature>;
}): Promise<{
  readonly evidence: BehavioralEvidence;
  readonly cards: FailureCards;
  readonly brief: DiagnosticBrief;
  readonly release: SignedBehavioralRelease;
}> {
  return (async () => {
    const suppressedBand = suppressedFindingCountBand(
      input.cards.length,
    );
    const metrics: BehavioralEvidence["metrics"] = input.cards.map(
      (card) => {
        const [prevalence, comparisonPrevalence] = prevalencePair(
          card.effectEstimate,
        );
        return {
          metricId: `metric-${card.cardId.slice(5)}`,
          feature: metricFeature(card.feature),
          cohort: "candidate",
          support: input.support,
          prevalence,
          comparisonPrevalence,
          effectSize: card.effectEstimate,
          uncertainty: {
            lower: card.interval95[0],
            upper: card.interval95[1],
          },
          direction:
            card.effectEstimate > 0
              ? "higher"
              : card.effectEstimate < 0
                ? "lower"
                : "no-clear-difference",
        };
      },
    );
    const evidence = withContentHash({
      schemaVersion: "1.0.0" as const,
      createdAt: input.createdAt,
      provenanceRefs: [],
      experimentNumber: input.preparation.experimentNumber,
      sourceEnvelopeHash: input.sourceResultEnvelopeHash,
      protocolHash: input.preparation.protocolHash,
      policyVersions: input.preparation.policy.policyVersions,
      analysisWindow: {
        ...input.preparation.analysisWindow,
        support: input.support,
      },
      metrics,
      suppressedFindingCountBand: suppressedBand,
      releaseChecksPassed: true,
      derivationHash: canonicalHash({
        domain: "dark-factory.behavioral-evidence-derivation.v1",
        sourceSetHash: input.preparation.behaviorSourceSetHash,
        sourceResultEnvelopeHash: input.sourceResultEnvelopeHash,
        cards: input.cards,
      }),
    }) as BehavioralEvidence;
    const failureCardValues: FailureCards["cards"] = input.cards.map(
      (card, index) => ({
        cardId: card.cardId,
        title: genericTitle(card.feature),
        failurePattern: card.statement,
        causalInterpretation:
          "This privacy-thresholded association is generic and does not establish causality.",
        affectedHarnessComponent: affectedComponent(card.feature),
        metricIds: [metrics[index]?.metricId ?? `metric-${index + 1}`],
        support: input.support,
        effectSize: card.effectEstimate,
        uncertainty: {
          lower: card.interval95[0],
          upper: card.interval95[1],
        },
        recommendation: genericRecommendation(card.feature),
      }),
    );
    const cards = withContentHash({
      schemaVersion: "1.0.0" as const,
      createdAt: input.createdAt,
      provenanceRefs: [],
      experimentNumber: input.preparation.experimentNumber,
      behavioralEvidenceHash: evidence.contentHash,
      cards: failureCardValues,
      suppressionApplied: true,
      policyVersions: input.preparation.policy.policyVersions,
    }) as FailureCards;
    const releaseId =
      `diagnostic-${input.preparation.requestHash.slice(0, 24)}`;
    const brief = withContentHash({
      schemaVersion: "1.0.0" as const,
      createdAt: input.createdAt,
      provenanceRefs: [],
      experimentNumber: input.preparation.experimentNumber,
      releaseId,
      sourceExperimentNumber: input.preparation.experimentNumber,
      aggregateEvidenceHash: evidence.contentHash,
      failureCardsHash: cards.contentHash,
      policyVersions: input.preparation.policy.policyVersions,
      status:
        failureCardValues.length === 0
          ? ("no-actionable-evidence" as const)
          : ("actionable-evidence" as const),
      cards: failureCardValues.slice(0, 16),
      limitations: [
        "Only coarse, privacy-thresholded behavioral associations are available.",
        "No benchmark identity, task content, scoring prose, or raw event stream is released.",
      ],
      oneUse: true as const,
      expiresAt: new Date(
        canonicalTimestamp(input.createdAt) +
          input.preparation.policy.diagnosticTtlMs,
      ).toISOString(),
    }) as DiagnosticBrief;
    const unsigned = {
      schemaVersion: "1.0.0" as const,
      createdAt: input.createdAt,
      provenanceRefs: [],
      releaseId,
      experimentNumber: input.preparation.experimentNumber,
      sourceResultEnvelopeHash: input.sourceResultEnvelopeHash,
      protocolHash: input.preparation.protocolHash,
      policyVersions: input.preparation.policy.policyVersions,
      support: input.support,
      aggregateArtifactHashes: {
        behavioralEvidence: evidence.contentHash,
        failureCards: cards.contentHash,
        diagnosticBrief: brief.contentHash,
      },
      suppressedFindingCountBand: suppressedBand,
      releaseOnce: true as const,
    };
    const signature = await input.signature(unsigned);
    const release = withContentHash({
      ...unsigned,
      signature,
    }) as SignedBehavioralRelease;
    return { evidence, cards, brief, release };
  })();
}

function allStringValues(value: unknown): readonly string[] {
  const values: string[] = [];
  const visit = (current: unknown): void => {
    if (typeof current === "string") {
      values.push(current);
    } else if (Array.isArray(current)) {
      current.forEach(visit);
    } else if (current !== null && typeof current === "object") {
      Object.values(current).forEach(visit);
    }
  };
  visit(value);
  return values;
}

function fingerprint(value: string): string {
  return canonicalHash({
    domain: "dark-factory.release-literal-fingerprint.v1",
    literal: value.trim().toLocaleLowerCase("en-US"),
  });
}

function assertNoForbiddenFingerprint(
  value: unknown,
  preparation: TrustedPrivateBehavioralPreparation,
): void {
  const output = new Set(allStringValues(value).map(fingerprint));
  if (
    preparation.forbiddenContentFingerprints.some((item) =>
      output.has(item),
    ) ||
    preparation.graderCanaryFingerprints.some((item) =>
      output.has(item),
    )
  ) {
    throw new Error("Behavioral release matched a forbidden fingerprint.");
  }
}

function assertNoForbiddenLiteral(
  value: unknown,
  preparation: TrustedPrivateBehavioralPreparation,
): void {
  const serialized = JSON.stringify(value).toLocaleLowerCase("en-US");
  if (
    preparation.observations.some((observation) =>
      serialized.includes(
        observation.taskId.toLocaleLowerCase("en-US"),
      ),
    ) ||
    preparation.forbiddenReleaseLiterals.some((literal) =>
      serialized.includes(
        literal.trim().toLocaleLowerCase("en-US"),
      ),
    )
  ) {
    throw new Error("Behavioral release matched a forbidden literal.");
  }
}

/**
 * Finalizes diagnostics only after the broker supplies a verified raw
 * destruction receipt. Outcome-derived artifacts are built and signed before
 * a single compare-and-swap transaction makes both artifacts and privacy
 * spending durable.
 */
export class DeterministicPostDestructionBehavioralReleaseProducer
  implements TrustedPostDestructionBehavioralReleaseProducer
{
  readonly #store: TrustedBehavioralPrivacyArtifactStore;
  readonly #keyId: string;
  readonly #privateKeys: TrustedCloudEd25519PrivateKeyProvider;
  readonly #publicKeys: TrustedCloudEd25519PublicKeyProvider;
  readonly #now: () => Date;

  constructor(options: DeterministicBehavioralReleaseProducerOptions) {
    const boundary =
      options.deployment === "trusted-cloud"
        ? "trusted-cloud"
        : "test-only-in-memory";
    if (
      options.store.boundary !== boundary ||
      options.privateKeys.boundary !== boundary ||
      options.publicKeys.boundary !== boundary ||
      !SAFE_KEY_ID.test(options.keyId)
    ) {
      throw new TrustedBehavioralReleaseProducerError();
    }
    this.#store = options.store;
    this.#keyId = options.keyId;
    this.#privateKeys = options.privateKeys;
    this.#publicKeys = options.publicKeys;
    this.#now = options.now ?? (() => new Date());
  }

  async finalize(
    originalInput: Parameters<
      TrustedPostDestructionBehavioralReleaseProducer["finalize"]
    >[0],
  ): Promise<TrustedBehavioralReleaseFinalization | null> {
    try {
      const input = canonicalClone(originalInput);
      if (
        input.preparation.sensitivity !==
          "trusted-private-behavioral-preparation" ||
        !SHA256.test(input.preparation.requestHash) ||
        !SHA256.test(input.preparation.protocolHash) ||
        !SHA256.test(input.preparation.behaviorSourceSetHash) ||
        !SHA256.test(input.sourceResultEnvelopeHash) ||
        !SHA256.test(
          input.destructionReceipt.verifierAttestationHash,
        ) ||
        input.preparation.policy.comparison !==
          "candidate-vs-champion" ||
        !input.preparation.policy.diagnosticsEnabled
      ) {
        throw new Error("Behavioral preparation is malformed.");
      }
      const taskIds = new Set(
        input.preparation.observations.map(
          (observation) => observation.taskId,
        ),
      );
      if (
        input.preparation.experimentNumber < 1 ||
        input.preparation.observations.length !== 24 ||
        taskIds.size !== 12 ||
        [...taskIds].some(
          (taskId) =>
            !SHA256.test(taskId) ||
            input.preparation.observations.filter(
              (observation) =>
                observation.taskId === taskId &&
                observation.arm === "candidate",
            ).length !== 1 ||
            input.preparation.observations.filter(
              (observation) =>
                observation.taskId === taskId &&
                observation.arm === "champion",
            ).length !== 1,
        )
      ) {
        throw new Error("Behavioral preparation is not a matched panel.");
      }
      const destroyedAt = canonicalTimestamp(
        input.destructionReceipt.destroyedAt,
      );
      if (
        destroyedAt <
        canonicalTimestamp(input.preparation.analysisWindow.closedAt)
      ) {
        throw new Error("Behavioral release preceded raw destruction.");
      }
      const now = this.#now();
      if (
        !(now instanceof Date) ||
        !Number.isFinite(now.getTime()) ||
        now.getTime() < destroyedAt
      ) {
        throw new Error("Behavioral release clock is invalid.");
      }
      const snapshot = canonicalClone(await this.#store.load());
      if (
        snapshot.privacyStateHash !==
          hashHiddenPrivacyBudgetState(snapshot.privacyState) ||
        snapshot.privacyState.maximumReleases !==
          input.preparation.policy.maximumPrivacyReleases
      ) {
        throw new Error("Privacy budget snapshot is detached.");
      }
      const experimentDigest = canonicalHash({
        domain: "dark-factory.behavioral-release-experiment.v1",
        requestHash: input.preparation.requestHash,
      });
      const analysisWindowDigest = canonicalHash({
        domain: "dark-factory.behavioral-release-window.v1",
        behaviorSourceSetHash:
          input.preparation.behaviorSourceSetHash,
        analysisWindow: input.preparation.analysisWindow,
      });
      const decision = releaseBehaviorCards({
        observations: input.preparation.observations,
        comparison: input.preparation.policy.comparison,
        experimentDigest,
        analysisWindowDigest,
        privacyState: snapshot.privacyState,
        forbiddenLiterals:
          input.preparation.forbiddenReleaseLiterals,
      });
      if (
        decision.nextPrivacyState === snapshot.privacyState
      ) {
        return null;
      }
      assertReleaseContainsNoLiterals(
        decision.release,
        input.preparation.forbiddenReleaseLiterals,
      );
      const createdAt = now.toISOString();
      const support = privacySupport(input.preparation);
      const privateKey = await this.#privateKeys.resolve({
        purpose: "behavioral-release",
        keyId: this.#keyId,
      });
      if (
        privateKey.boundary !== "trusted-cloud-key-material" ||
        privateKey.algorithm !== "Ed25519" ||
        privateKey.purpose !== "behavioral-release" ||
        privateKey.keyId !== this.#keyId ||
        !SAFE_KEY_VERSION.test(privateKey.keyVersion) ||
        privateKey.privateKey === undefined ||
        privateKey.privateKey === null
      ) {
        throw new Error("Behavioral release private key is detached.");
      }
      const bundle = await makeArtifacts({
        preparation: input.preparation,
        sourceResultEnvelopeHash:
          input.sourceResultEnvelopeHash,
        cards: decision.release.cards,
        support,
        createdAt,
        signature: (unsigned) =>
          Promise.resolve(
            createEd25519Signature(
              unsigned,
              privateKey.privateKey,
              this.#keyId,
              createdAt,
            ),
          ),
      });
      for (const [kind, document] of [
        ["behavioralEvidence", bundle.evidence],
        ["failureCards", bundle.cards],
        ["diagnosticBrief", bundle.brief],
        ["signedBehavioralRelease", bundle.release],
      ] as const) {
        assertValidDocument(kind, document);
      }
      const publicKey = await this.#publicKeys.resolve({
        purpose: "behavioral-release",
        keyId: this.#keyId,
      });
      if (
        publicKey === undefined ||
        publicKey.boundary !== "trusted-cloud-key-material" ||
        publicKey.algorithm !== "Ed25519" ||
        publicKey.purpose !== "behavioral-release" ||
        publicKey.keyId !== this.#keyId ||
        !SAFE_KEY_VERSION.test(publicKey.keyVersion) ||
        publicKey.publicKey === undefined ||
        publicKey.publicKey === null ||
        !verifyEd25519Signature(
          bundle.release as unknown as Readonly<
            Record<string, unknown>
          >,
          publicKey.publicKey,
        )
      ) {
        throw new Error("Behavioral release signature failed verification.");
      }
      assertSafeForLocalPersistence(bundle);
      assertNoForbiddenLiteral(bundle, input.preparation);
      assertNoForbiddenFingerprint(bundle, input.preparation);
      const artifacts = deepFreezeJson([
        {
          purpose: "behavioral-evidence" as const,
          document: bundle.evidence,
        },
        {
          purpose: "failure-cards" as const,
          document: bundle.cards,
        },
        {
          purpose: "diagnostic-brief" as const,
          document: bundle.brief,
        },
        {
          purpose: "behavioral-release" as const,
          document: bundle.release,
        },
      ] as const);
      const expectedArtifactSetHash = artifactSetHash(artifacts);
      const nextPrivacyStateHash = hashHiddenPrivacyBudgetState(
        decision.nextPrivacyState,
      );
      const authorizationHash = canonicalHash({
        domain: "dark-factory.behavioral-release-authorization.v1",
        requestHash: input.preparation.requestHash,
        sourceSetHash: input.preparation.behaviorSourceSetHash,
        sourceResultEnvelopeHash:
          input.sourceResultEnvelopeHash,
        destructionAttestationHash:
          input.destructionReceipt.verifierAttestationHash,
        priorPrivacyStateHash: snapshot.privacyStateHash,
        nextPrivacyStateHash,
        artifactSetHash: expectedArtifactSetHash,
      });
      const bindingHash = canonicalHash({
        domain: "dark-factory.behavioral-release-one-use-binding.v1",
        authorizationHash,
        requestHash: input.preparation.requestHash,
        sourceResultEnvelopeHash:
          input.sourceResultEnvelopeHash,
        releaseContentHash: bundle.release.contentHash,
      });
      const commitInput = {
        authorizationHash,
        requestHash: input.preparation.requestHash,
        sourceResultEnvelopeHash:
          input.sourceResultEnvelopeHash,
        releaseContentHash: bundle.release.contentHash,
        priorPrivacyStateHash: snapshot.privacyStateHash,
        nextPrivacyState: deepFreezeJson(
          canonicalClone(decision.nextPrivacyState),
        ),
        artifacts,
      } as const;
      try {
        const receipt = await this.#store.commit(commitInput);
        if (
          (receipt.status !== "committed" &&
            receipt.status !== "already-committed") ||
          receipt.authorizationHash !== authorizationHash ||
          receipt.bindingHash !== bindingHash ||
          receipt.privacyStateHash !== nextPrivacyStateHash ||
          receipt.artifactSetHash !== expectedArtifactSetHash
        ) {
          throw new Error(
            "Behavioral release commit receipt is detached.",
          );
        }
      } catch {
        let inspection: TrustedBehavioralReleaseCommitInspection;
        try {
          inspection = await this.#store.inspectCommit({
            authorizationHash,
            requestHash: input.preparation.requestHash,
            sourceResultEnvelopeHash:
              input.sourceResultEnvelopeHash,
            releaseContentHash: bundle.release.contentHash,
            artifactSetHash: expectedArtifactSetHash,
          });
        } catch {
          throw new TrustedBehavioralReleaseProducerError(
            "unsafe-to-consume",
          );
        }
        if (inspection.status === "absent") {
          throw new TrustedBehavioralReleaseProducerError(
            "known-not-committed",
          );
        }
        if (inspection.status !== "committed") {
          throw new TrustedBehavioralReleaseProducerError(
            "unsafe-to-consume",
          );
        }
        try {
          assertRecoveredCommit(inspection, {
            authorizationHash,
            bindingHash,
            privacyStateHash: nextPrivacyStateHash,
            artifactSetHash: expectedArtifactSetHash,
            artifacts,
          });
        } catch {
          throw new TrustedBehavioralReleaseProducerError(
            "unsafe-to-consume",
          );
        }
      }
      return {
        contentHash: bundle.release.contentHash,
        sourceSetHash: input.preparation.behaviorSourceSetHash,
        privacyThresholdPassed: true,
        authorizationHash,
        requestHash: input.preparation.requestHash,
      };
    } catch (error) {
      if (error instanceof TrustedBehavioralReleaseProducerError) {
        throw error;
      }
      throw new TrustedBehavioralReleaseProducerError();
    }
  }

  async orphan(
    originalFinalization: TrustedBehavioralReleaseFinalization,
  ): Promise<TrustedBehavioralReleaseOrphanFinalizationReceipt> {
    try {
      const finalization = canonicalClone(originalFinalization);
      if (
        !SHA256.test(finalization.authorizationHash) ||
        !SHA256.test(finalization.requestHash) ||
        !SHA256.test(finalization.contentHash) ||
        !SHA256.test(finalization.sourceSetHash) ||
        finalization.privacyThresholdPassed !== true
      ) {
        throw new Error("Behavioral finalization handle is malformed.");
      }
      const now = this.#now();
      if (
        !(now instanceof Date) ||
        !Number.isFinite(now.getTime())
      ) {
        throw new Error("Behavioral orphan clock is invalid.");
      }
      const requestedOrphanedAt = now.toISOString();
      canonicalTimestamp(requestedOrphanedAt);
      const receipt = await this.#store.orphan({
        authorizationHash: finalization.authorizationHash,
        requestHash: finalization.requestHash,
        releaseContentHash: finalization.contentHash,
        orphanedAt: requestedOrphanedAt,
      });
      if (
        (receipt.status !== "orphaned" &&
          receipt.status !== "already-orphaned") ||
        receipt.authorizationHash !==
          finalization.authorizationHash ||
        receipt.requestHash !== finalization.requestHash ||
        receipt.releaseContentHash !== finalization.contentHash ||
        canonicalTimestamp(receipt.orphanedAt) >
          canonicalTimestamp(requestedOrphanedAt)
      ) {
        throw new Error("Behavioral orphan receipt is detached.");
      }
      const stable = {
        authorizationHash: finalization.authorizationHash,
        requestHash: finalization.requestHash,
        releaseContentHash: finalization.contentHash,
        sourceSetHash: finalization.sourceSetHash,
        orphanedAt: receipt.orphanedAt,
      } as const;
      return deepFreezeJson({
        status: "orphaned" as const,
        ...stable,
        orphanFinalizationHash:
          hashTrustedBehavioralReleaseOrphanFinalization(stable),
      });
    } catch {
      throw new TrustedBehavioralReleaseProducerError(
        "unsafe-to-consume",
      );
    }
  }
}
