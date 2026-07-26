import { createHash } from "node:crypto";

import { assertSafeForLocalPersistence } from "../evaluator/retention.js";
import {
  assertDurableBlindBrokerLeaseState,
  emptyBlindBrokerLeaseState,
  type AtomicBlindBrokerLeaseStore,
  type DurableBlindBrokerLeaseState,
  type TrustedAdaptiveReleaseSignatureVerifier,
  type TrustedDiagnosticBriefPublisher,
} from "../orchestrator/blind-broker.js";
import type { DiagnosticBriefReference } from "../orchestrator/contracts.js";
import type {
  BehavioralEvidence,
  DiagnosticBrief,
  FailureCards,
} from "../schemas/artifacts.js";
import {
  canonicalJson,
  hasValidContentHash,
  withContentHash,
} from "../schemas/canonical.js";
import { assertValidDocument } from "../schemas/registry.js";
import type { SignedBehavioralRelease } from "../schemas/trusted.js";
import {
  VerifyingTrustedArtifactBridge,
  type TrustedArtifactRuntimeGuard,
} from "./artifact-bridge.js";
import { MountedVolumeTrustedArtifactBackend } from "./mounted-volume-backend.js";
import {
  MountedVolumeTransactionalJsonStore,
  type MountedVolumeDurableStateOptions,
} from "./mounted-volume-state.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_STORE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_PUBLICATION_ID =
  /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const DIAGNOSTIC_MEDIA_TYPE =
  "application/vnd.dark-factory.diagnostic-brief+json";
const DIAGNOSTIC_BINDING_MEDIA_TYPE =
  "application/vnd.dark-factory.diagnostic-publication-binding+json";
const MAXIMUM_DIAGNOSTIC_BYTES = 512 * 1024;

export class MountedVolumeBlindBrokerPortError extends Error {
  override readonly name = "MountedVolumeBlindBrokerPortError";
}

function fail(message: string): never {
  throw new MountedVolumeBlindBrokerPortError(message);
}

/**
 * Durable, fenced implementation of the blind broker's lease-state port.
 *
 * The underlying mounted-volume primitive provides a provider-attested
 * single-writer lock, fencing epochs, atomic same-volume replacement, durable
 * directory sync, rollback detection, and exact-once transaction callbacks.
 * This adapter supplies the complete blind-broker state validator so corrupt
 * or cross-domain bytes fail before they can enter a broker transition.
 */
export class MountedVolumeAtomicBlindBrokerLeaseStore
  implements AtomicBlindBrokerLeaseStore
{
  readonly #store: MountedVolumeTransactionalJsonStore<
    DurableBlindBrokerLeaseState
  >;

  public constructor(options: MountedVolumeDurableStateOptions) {
    if (!SAFE_STORE_ID.test(options.storeId)) {
      fail("Blind-broker mounted-volume store ID is malformed.");
    }
    this.#store =
      new MountedVolumeTransactionalJsonStore<DurableBlindBrokerLeaseState>(
        options,
        `blind-broker-leases-${options.storeId}`,
        {
          domain: "dark-factory.blind-broker-lease-state.v1",
          initialState: emptyBlindBrokerLeaseState,
          assertState: assertDurableBlindBrokerLeaseState,
          revision: (state) => state.revision,
        },
      );
  }

  public transact<Result>(
    operation: (state: DurableBlindBrokerLeaseState) => {
      readonly next: DurableBlindBrokerLeaseState;
      readonly result: Result;
    },
  ): Promise<Result> {
    return this.#store.transact(operation);
  }

  /**
   * Clean controller handoff must close the store so the active lock is moved
   * into the immutable released-lock history before a successor starts.
   */
  public close(): Promise<void> {
    return this.#store.close();
  }
}

export interface MountedVolumeTrustedDiagnosticBriefPublisherOptions {
  /**
   * Uses the same attested mount, controller fence, recovery authority, and
   * campaign scope as the other trusted mutable-state adapters.
   */
  readonly durableState: MountedVolumeDurableStateOptions;
  /**
   * Pinned evaluator keyring verifier. The signed release commits every
   * persisted brief byte through its aggregate artifact hash.
   */
  readonly signatureVerifier: TrustedAdaptiveReleaseSignatureVerifier;
}

interface DurableDiagnosticPublicationRecord {
  readonly publicationIdHash: string;
  readonly diagnosticBriefHash: string;
  readonly releaseId: string;
  readonly actionable: boolean;
  readonly diagnosticBrief: DiagnosticBrief;
}

interface DurableDiagnosticPublicationState {
  readonly schemaVersion: 1;
  readonly sensitivity: "release-safe-diagnostic-publications";
  readonly storeScopeHash: string;
  readonly revision: number;
  readonly records: Readonly<
    Record<string, DurableDiagnosticPublicationRecord>
  >;
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

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    actual.every((key) => expected.includes(key))
  );
}

function assertReleaseSafeDiagnosticBrief(
  value: unknown,
): asserts value is DiagnosticBrief {
  try {
    assertValidDocument("diagnosticBrief", value);
    assertSafeForLocalPersistence(value);
  } catch {
    fail("Diagnostic publication contains unsafe brief bytes.");
  }
  if (!hasValidContentHash(value)) {
    fail("Diagnostic publication brief commitment is invalid.");
  }
}

function assertDurableDiagnosticPublicationState(
  value: unknown,
  expectedStoreScopeHash: string,
): asserts value is DurableDiagnosticPublicationState {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(
      value,
      [
        "schemaVersion",
        "sensitivity",
        "storeScopeHash",
        "revision",
        "records",
      ],
    ) ||
    value.schemaVersion !== 1 ||
    value.sensitivity !== "release-safe-diagnostic-publications" ||
    value.storeScopeHash !== expectedStoreScopeHash ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !isPlainRecord(value.records)
  ) {
    fail("Durable diagnostic publication state is malformed.");
  }

  const briefHashes = new Set<string>();
  for (const [key, candidate] of Object.entries(value.records)) {
    if (
      !isPlainRecord(candidate) ||
      !hasExactKeys(
        candidate,
        [
          "publicationIdHash",
          "diagnosticBriefHash",
          "releaseId",
          "actionable",
          "diagnosticBrief",
        ],
      ) ||
      !SHA256.test(key) ||
      candidate.publicationIdHash !== key ||
      typeof candidate.diagnosticBriefHash !== "string" ||
      !SHA256.test(candidate.diagnosticBriefHash) ||
      typeof candidate.releaseId !== "string" ||
      !SAFE_PUBLICATION_ID.test(candidate.releaseId) ||
      typeof candidate.actionable !== "boolean" ||
      briefHashes.has(candidate.diagnosticBriefHash)
    ) {
      fail("Durable diagnostic publication record is malformed.");
    }
    assertReleaseSafeDiagnosticBrief(candidate.diagnosticBrief);
    const brief = candidate.diagnosticBrief;
    if (
      !hasValidContentHash(brief) ||
      brief.contentHash !== candidate.diagnosticBriefHash ||
      brief.releaseId !== candidate.releaseId ||
      (brief.status === "actionable-evidence") !== candidate.actionable
    ) {
      fail("Durable diagnostic publication reference is detached.");
    }
    briefHashes.add(candidate.diagnosticBriefHash);
  }
}

function assertReleaseLineage(input: {
  readonly sourceResultEnvelopeHash: string;
  readonly behavioralRelease: SignedBehavioralRelease;
  readonly behavioralEvidence: BehavioralEvidence;
  readonly failureCards: FailureCards;
  readonly diagnosticBrief: DiagnosticBrief;
}): void {
  if (!SHA256.test(input.sourceResultEnvelopeHash)) {
    fail("Diagnostic publication source commitment is malformed.");
  }

  try {
    assertValidDocument("signedBehavioralRelease", input.behavioralRelease);
    assertValidDocument("behavioralEvidence", input.behavioralEvidence);
    assertValidDocument("failureCards", input.failureCards);
    assertValidDocument("diagnosticBrief", input.diagnosticBrief);
  } catch {
    fail("Diagnostic publication contains an invalid released document.");
  }

  if (
    !hasValidContentHash(input.behavioralRelease) ||
    !hasValidContentHash(input.behavioralEvidence) ||
    !hasValidContentHash(input.failureCards) ||
    !hasValidContentHash(input.diagnosticBrief)
  ) {
    fail("Diagnostic publication content commitment is invalid.");
  }

  const release = input.behavioralRelease;
  const evidence = input.behavioralEvidence;
  const cards = input.failureCards;
  const brief = input.diagnosticBrief;
  if (
    release.sourceResultEnvelopeHash !== input.sourceResultEnvelopeHash ||
    evidence.sourceEnvelopeHash !== input.sourceResultEnvelopeHash ||
    release.experimentNumber !== evidence.experimentNumber ||
    release.experimentNumber !== cards.experimentNumber ||
    release.experimentNumber !== brief.experimentNumber ||
    release.experimentNumber !== brief.sourceExperimentNumber ||
    release.protocolHash !== evidence.protocolHash ||
    release.releaseId !== brief.releaseId ||
    release.aggregateArtifactHashes.behavioralEvidence !==
      evidence.contentHash ||
    release.aggregateArtifactHashes.failureCards !== cards.contentHash ||
    release.aggregateArtifactHashes.diagnosticBrief !==
      brief.contentHash ||
    cards.behavioralEvidenceHash !== evidence.contentHash ||
    brief.aggregateEvidenceHash !== evidence.contentHash ||
    brief.failureCardsHash !== cards.contentHash ||
    evidence.releaseChecksPassed !== true ||
    canonicalJson(release.policyVersions) !==
      canonicalJson(evidence.policyVersions) ||
    canonicalJson(release.policyVersions) !==
      canonicalJson(cards.policyVersions) ||
    canonicalJson(release.policyVersions) !==
      canonicalJson(brief.policyVersions) ||
    canonicalJson(release.support) !==
      canonicalJson(evidence.analysisWindow.support)
  ) {
    fail("Diagnostic publication hash lineage is inconsistent.");
  }

  const releasedCards = new Map(
    cards.cards.map((card) => [card.cardId, canonicalJson(card)]),
  );
  if (
    brief.cards.some(
      (card) =>
        releasedCards.get(card.cardId) !== canonicalJson(card),
    )
  ) {
    fail("Diagnostic brief contains a card outside its signed release.");
  }

  try {
    // This scanner rejects identity-bearing fields, raw commands, paths,
    // URLs, grader/verifier prose, encoded printable payloads, and trusted
    // storage references. Only the already-sanitized brief is persisted.
    assertSafeForLocalPersistence(brief);
  } catch {
    fail("Diagnostic brief failed the release-safe persistence scan.");
  }
}

function publicationAddress(input: {
  readonly storeId: string;
  readonly publicationId: string;
}): `trusted://${string}` {
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        domain: "dark-factory.diagnostic-publication-address.v1",
        storeId: input.storeId,
        publicationId: input.publicationId,
      }),
      "utf8",
    )
    .digest("hex");
  return `trusted://diagnostic-publications/${digest}`;
}

function storeScopeHash(storeId: string): string {
  if (!SAFE_STORE_ID.test(storeId)) {
    fail("Diagnostic artifact store ID is malformed.");
  }
  return createHash("sha256")
    .update(
      canonicalJson({
        domain: "dark-factory.diagnostic-artifact-store-scope.v1",
        storeId,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Trusted release composers can deterministically resolve a broker reference
 * without exposing its storage URI to the optimizer. They must still verify
 * the retrieved document's schema, content hash, expiry, and one-use policy.
 */
export function mountedVolumeDiagnosticBriefArtifactUri(input: {
  readonly storeId: string;
  readonly diagnosticBriefHash: string;
}): `trusted://${string}` {
  if (!SHA256.test(input.diagnosticBriefHash)) {
    fail("Diagnostic brief artifact hash is malformed.");
  }
  return `trusted://diagnostic-briefs/${storeScopeHash(input.storeId)}/${input.diagnosticBriefHash}`;
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

/**
 * One-use diagnostic publisher backed by immutable mounted-volume artifacts.
 *
 * Artifact addressing is a one-way campaign/publication commitment. Reusing a
 * publication ID with identical bytes is idempotent; reusing it with different
 * bytes is rejected by the mounted-volume backend's atomic create operation.
 * The persisted file is exactly the validated DiagnosticBrief JSON document:
 * evaluator leases, task identities, panel membership, traces, evidence
 * internals, and source-envelope metadata are never serialized alongside it.
 */
export class MountedVolumeTrustedDiagnosticBriefPublisher
  implements TrustedDiagnosticBriefPublisher
{
  readonly #storeId: string;
  readonly #bridge: VerifyingTrustedArtifactBridge;
  readonly #publications: MountedVolumeTransactionalJsonStore<
    DurableDiagnosticPublicationState
  >;
  readonly #signatureVerifier: TrustedAdaptiveReleaseSignatureVerifier;
  readonly #now: () => Date;

  public constructor(options: MountedVolumeTrustedDiagnosticBriefPublisherOptions) {
    const stateOptions = options.durableState;
    if (!SAFE_STORE_ID.test(stateOptions.storeId)) {
      fail("Diagnostic publisher store ID is malformed.");
    }
    this.#storeId = stateOptions.storeId;
    this.#signatureVerifier = options.signatureVerifier;
    this.#now = stateOptions.now ?? (() => new Date());
    const scopeHash = storeScopeHash(this.#storeId);
    this.#publications =
      new MountedVolumeTransactionalJsonStore<DurableDiagnosticPublicationState>(
        stateOptions,
        `diagnostic-publications-${this.#storeId}`,
        {
          domain: "dark-factory.diagnostic-publication-state.v1",
          initialState: () => ({
            schemaVersion: 1,
            sensitivity: "release-safe-diagnostic-publications",
            storeScopeHash: scopeHash,
            revision: 0,
            records: {},
          }),
          assertState(value): asserts value is DurableDiagnosticPublicationState {
            assertDurableDiagnosticPublicationState(value, scopeHash);
          },
          revision: (state) => state.revision,
        },
      );
    const backend = new MountedVolumeTrustedArtifactBackend({
      volumeRoot: stateOptions.volumeRoot,
      runtimeGuard: stateOptions.runtimeGuard,
    });
    this.#bridge = new VerifyingTrustedArtifactBridge(
      backend,
      stateOptions.runtimeGuard,
    );
  }

  async #persistBriefArtifact(
    diagnosticBrief: DiagnosticBrief,
  ): Promise<void> {
    const bytes = Buffer.from(`${canonicalJson(diagnosticBrief)}\n`, "utf8");
    if (
      bytes.byteLength <= 0 ||
      bytes.byteLength > MAXIMUM_DIAGNOSTIC_BYTES
    ) {
      fail("Diagnostic brief byte length is outside policy.");
    }
    await this.#bridge.persistVerified({
      uri: mountedVolumeDiagnosticBriefArtifactUri({
        storeId: this.#storeId,
        diagnosticBriefHash: diagnosticBrief.contentHash,
      }),
      mediaType: DIAGNOSTIC_MEDIA_TYPE,
      chunks: oneChunk(bytes),
    });
  }

  public async publishOnce(input: {
    readonly publicationId: string;
    readonly sourceResultEnvelopeHash: string;
    readonly behavioralRelease: SignedBehavioralRelease;
    readonly behavioralEvidence: BehavioralEvidence;
    readonly failureCards: FailureCards;
    readonly diagnosticBrief: DiagnosticBrief;
  }): Promise<{
    readonly hash: string;
    readonly releaseId: string;
    readonly actionable: boolean;
  }> {
    if (!SAFE_PUBLICATION_ID.test(input.publicationId)) {
      fail("Diagnostic publication ID is malformed.");
    }
    let frozen: typeof input;
    try {
      frozen = JSON.parse(canonicalJson(input)) as typeof input;
    } catch {
      fail("Diagnostic publication input is not canonical JSON.");
    }
    assertReleaseLineage(frozen);
    const signedReleaseBefore = canonicalJson(frozen.behavioralRelease);
    let signatureValid = false;
    try {
      signatureValid = await this.#signatureVerifier.verify(
        frozen.behavioralRelease,
      );
    } catch {
      fail("Diagnostic release signature verification failed closed.");
    }
    let releaseUnchanged = false;
    try {
      releaseUnchanged =
        canonicalJson(frozen.behavioralRelease) === signedReleaseBefore;
    } catch {
      releaseUnchanged = false;
    }
    if (
      !signatureValid ||
      !releaseUnchanged
    ) {
      fail("Diagnostic release signature is not trusted.");
    }

    const publicationIdHash = createHash("sha256")
      .update(frozen.publicationId, "utf8")
      .digest("hex");
    const record: DurableDiagnosticPublicationRecord = {
      publicationIdHash,
      diagnosticBriefHash: frozen.diagnosticBrief.contentHash,
      releaseId: frozen.diagnosticBrief.releaseId,
      actionable:
        frozen.diagnosticBrief.status === "actionable-evidence",
      diagnosticBrief: frozen.diagnosticBrief,
    };
    await this.#publications.transact((state) => {
      const existing = state.records[publicationIdHash];
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(record)) {
          fail("Diagnostic publication ID already binds different content.");
        }
        return { next: state, result: undefined };
      }
      const sameBrief = Object.values(state.records).find(
        (candidate) =>
          candidate.diagnosticBriefHash === record.diagnosticBriefHash,
      );
      if (sameBrief !== undefined) {
        fail("Diagnostic brief hash already belongs to another publication.");
      }
      return {
        next: {
          ...state,
          revision: state.revision + 1,
          records: {
            ...state.records,
            [publicationIdHash]: record,
          },
        },
        result: undefined,
      };
    });
    const binding = withContentHash({
      schemaVersion: 1 as const,
      domain: "dark-factory.diagnostic-publication-binding.v1" as const,
      storeScopeHash: storeScopeHash(this.#storeId),
      publicationIdHash,
      diagnosticBriefHash: record.diagnosticBriefHash,
      releaseId: record.releaseId,
      actionable: record.actionable,
    });
    assertSafeForLocalPersistence(binding);
    const bindingBytes = Buffer.from(`${canonicalJson(binding)}\n`, "utf8");

    // The durable transaction above reserves publicationId before either
    // artifact. A crash after this binding write is recoverable: the broker
    // retains its "releasing" lease state and an identical retry completes the
    // content-addressed brief write. Conflicting reuse already failed closed.
    await this.#bridge.persistVerified({
      uri: publicationAddress({
        storeId: this.#storeId,
        publicationId: frozen.publicationId,
      }),
      mediaType: DIAGNOSTIC_BINDING_MEDIA_TYPE,
      chunks: oneChunk(bindingBytes),
    });
    await this.#persistBriefArtifact(record.diagnosticBrief);

    return {
      hash: record.diagnosticBriefHash,
      releaseId: record.releaseId,
      actionable: record.actionable,
    };
  }

  /**
   * Trusted evidence-archive composition path. A brief can enter an optimizer
   * release only through its broker reference; the method revalidates durable
   * release-safe state, rejects expiry, and repairs a missing immutable
   * artifact before returning only the brief document.
   */
  public async readReleaseSafe(
    reference: DiagnosticBriefReference,
  ): Promise<DiagnosticBrief> {
    if (
      !SHA256.test(reference.hash) ||
      !SAFE_PUBLICATION_ID.test(reference.releaseId) ||
      typeof reference.actionable !== "boolean"
    ) {
      fail("Diagnostic brief reference is malformed.");
    }
    const brief = await this.#publications.transact((state) => {
      const record = Object.values(state.records).find(
        (candidate) =>
          candidate.diagnosticBriefHash === reference.hash,
      );
      if (
        record === undefined ||
        record.releaseId !== reference.releaseId ||
        record.actionable !== reference.actionable
      ) {
        fail("Diagnostic brief reference has no durable publication.");
      }
      return {
        next: state,
        result: JSON.parse(
          canonicalJson(record.diagnosticBrief),
        ) as DiagnosticBrief,
      };
    });
    const now = this.#now();
    if (
      !(now instanceof Date) ||
      !Number.isFinite(now.getTime()) ||
      Date.parse(brief.expiresAt) <= now.getTime()
    ) {
      fail("Diagnostic brief publication has expired.");
    }
    assertReleaseSafeDiagnosticBrief(brief);
    await this.#persistBriefArtifact(brief);
    return brief;
  }

  public close(): Promise<void> {
    return this.#publications.close();
  }
}
