import type { KeyLike } from "node:crypto";

import type { TrustedCloudArtifactRef } from "../cloud/types.js";
import type { ExperimentIdentity } from "../domain/models.js";
import {
  assertEvaluationRequest,
  type HarnessArtifactReference,
  type TrustedEvaluationRequest,
} from "../evaluator/contracts.js";
import { verifyEd25519Signature } from "../evidence/signatures.js";
import {
  TRUSTED_GIT_SOURCE_BUNDLE_REF,
  type TrustedGitSourceSnapshotReceipt,
} from "../harness/git-source.js";
import {
  canonicalJson,
  computeContentHash,
  withContentHash,
} from "../schemas/canonical.js";
import type {
  AtomicBlindBrokerLeaseStore,
  BlindBrokerEvaluationConfiguration,
  BlindBrokerEvaluationConfigurationResolver,
  DurableBlindBrokerLeaseRecord,
  TrustedHarnessArtifactResolver,
  TrustedRepairDiscoveryBinding,
  TrustedRepairDiscoveryResolver,
} from "./blind-broker.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const TRUSTED_URI =
  /^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const SAFE_IMAGE_REFERENCE =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,446}@sha256:[a-f0-9]{64}$/u;
const MAXIMUM_CONFIGURATION_BYTES = 1024 * 1024;

export class TrustedBlindBrokerPortAdapterError extends Error {
  override readonly name = "TrustedBlindBrokerPortAdapterError";

  constructor() {
    super("Trusted blind-broker port resolution failed.");
  }
}

export interface TrustedControlJsonArtifactReader {
  /**
   * Production implementations read through the verifying trusted-artifact
   * bridge and enforce the supplied byte limit before returning UTF-8.
   */
  readUtf8(
    artifact: TrustedCloudArtifactRef,
    maximumBytes: number,
  ): Promise<string>;
}

export interface TrustedEvaluationConfigurationArtifactSource {
  readonly boundary: "trusted-cloud";
  locate(
    experiment: ExperimentIdentity,
  ): Promise<TrustedCloudArtifactRef | undefined>;
}

export interface TrustedBlindBrokerEvaluationConfigurationRecord {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.blind-broker-evaluation-configuration.v1";
  readonly experiment: ExperimentIdentity;
  readonly configuration: BlindBrokerEvaluationConfiguration;
  readonly createdAt: string;
  readonly contentHash: string;
}

export type TrustedBlindBrokerEvaluationConfigurationRecordDraft = Omit<
  TrustedBlindBrokerEvaluationConfigurationRecord,
  "contentHash"
>;

export interface CasBlindBrokerEvaluationConfigurationResolverOptions {
  readonly source: TrustedEvaluationConfigurationArtifactSource;
  readonly reader: TrustedControlJsonArtifactReader;
  readonly maximumBytes?: number;
}

export interface TrustedGitSourceSnapshotReceiptSource {
  readonly boundary: "trusted-cloud";
  findByCommit(
    commit: string,
  ): Promise<TrustedGitSourceSnapshotReceipt | undefined>;
}

export interface TrustedArtifactSignatureKeyring {
  getVerificationKey(keyId: string): Promise<KeyLike | undefined>;
}

export interface SignedGitSourceHarnessArtifactResolverOptions {
  readonly source: TrustedGitSourceSnapshotReceiptSource;
  readonly keyring: TrustedArtifactSignatureKeyring;
  readonly trustedKeyIds: readonly string[];
  readonly registrationId: string;
  readonly originRepositoryHash: string;
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
  if (!isPlainRecord(value)) {
    throw new TrustedBlindBrokerPortAdapterError();
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    throw new TrustedBlindBrokerPortAdapterError();
  }
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function experimentId(experiment: ExperimentIdentity): string {
  if (
    !Number.isSafeInteger(experiment.number) ||
    experiment.number < 1 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(experiment.slug) ||
    !SAFE_ID.test(experiment.lineageId) ||
    !SHA256.test(experiment.protocolHash)
  ) {
    throw new TrustedBlindBrokerPortAdapterError();
  }
  const value = `${String(experiment.number).padStart(3, "0")}-${experiment.slug}`;
  if (!SAFE_ID.test(value)) {
    throw new TrustedBlindBrokerPortAdapterError();
  }
  return value;
}

function assertExperiment(value: unknown): asserts value is ExperimentIdentity {
  assertExactKeys(value, [
    "number",
    "slug",
    "kind",
    "parentExperiment",
    "lineageId",
    "protocolHash",
  ]);
  const experiment = value as unknown as ExperimentIdentity;
  if (
    !["baseline", "optimization", "shadow"].includes(experiment.kind) ||
    (experiment.parentExperiment !== null &&
      (!Number.isSafeInteger(experiment.parentExperiment) ||
        experiment.parentExperiment < 0 ||
        experiment.parentExperiment >= experiment.number))
  ) {
    throw new TrustedBlindBrokerPortAdapterError();
  }
  experimentId(experiment);
}

function assertConfigurationShape(
  value: unknown,
): asserts value is BlindBrokerEvaluationConfiguration {
  assertExactKeys(value, [
    "runMode",
    "complianceManifestHash",
    "executionProfile",
    "evaluatedModel",
    "weightingPolicyHash",
    "requestTtlMs",
  ]);
  const configuration = value as unknown as BlindBrokerEvaluationConfiguration;
  assertExactKeys(configuration.executionProfile, [
    "provider",
    "imageDigest",
    "regionClass",
    "resources",
    "networkPolicyHash",
    "protocolHash",
  ]);
  assertExactKeys(configuration.executionProfile.resources, [
    "architecture",
    "cpuCores",
    "memoryMiB",
    "diskMiB",
  ]);
  assertExactKeys(configuration.evaluatedModel, [
    "provider",
    "modelId",
    "thinkingLevel",
  ]);
  if (
    configuration.runMode !== "research" ||
    !SHA256.test(configuration.complianceManifestHash) ||
    !SHA256.test(configuration.weightingPolicyHash) ||
    !Number.isSafeInteger(configuration.requestTtlMs) ||
    configuration.requestTtlMs < 60_000 ||
    configuration.requestTtlMs > 24 * 60 * 60_000 ||
    !["daytona", "e2b", "modal"].includes(
      configuration.executionProfile.provider,
    ) ||
    !/^sha256:[a-f0-9]{64}$/u.test(
      configuration.executionProfile.imageDigest,
    ) ||
    !SAFE_EXTERNAL_ID.test(configuration.executionProfile.regionClass) ||
    !SHA256.test(configuration.executionProfile.networkPolicyHash) ||
    !SHA256.test(configuration.executionProfile.protocolHash) ||
    configuration.executionProfile.resources.architecture !== "x86_64" ||
    !Number.isSafeInteger(
      configuration.executionProfile.resources.cpuCores,
    ) ||
    configuration.executionProfile.resources.cpuCores < 1 ||
    !Number.isSafeInteger(
      configuration.executionProfile.resources.memoryMiB,
    ) ||
    configuration.executionProfile.resources.memoryMiB < 1 ||
    !Number.isSafeInteger(
      configuration.executionProfile.resources.diskMiB,
    ) ||
    configuration.executionProfile.resources.diskMiB < 1 ||
    !SAFE_MODEL_ID.test(configuration.evaluatedModel.provider) ||
    !SAFE_MODEL_ID.test(configuration.evaluatedModel.modelId) ||
    ![
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ].includes(configuration.evaluatedModel.thinkingLevel)
  ) {
    throw new TrustedBlindBrokerPortAdapterError();
  }
}

function assertConfigurationForExperiment(
  configuration: BlindBrokerEvaluationConfiguration,
  experiment: ExperimentIdentity,
): void {
  assertConfigurationShape(configuration);
  if (
    configuration.executionProfile.protocolHash !==
    experiment.protocolHash
  ) {
    throw new TrustedBlindBrokerPortAdapterError();
  }
  const probe: TrustedEvaluationRequest = {
    schemaVersion: 1,
    requestId: "configuration-adapter-probe",
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
    throw new TrustedBlindBrokerPortAdapterError();
  }
}

function cloneJson<Value>(value: Value): Value {
  return JSON.parse(canonicalJson(value)) as Value;
}

export function createTrustedBlindBrokerEvaluationConfigurationRecord(
  draft: TrustedBlindBrokerEvaluationConfigurationRecordDraft,
): TrustedBlindBrokerEvaluationConfigurationRecord {
  assertExperiment(draft.experiment);
  assertConfigurationForExperiment(
    draft.configuration,
    draft.experiment,
  );
  if (
    draft.schemaVersion !== 1 ||
    draft.domain !==
      "dark-factory.blind-broker-evaluation-configuration.v1" ||
    !canonicalTimestamp(draft.createdAt)
  ) {
    throw new TrustedBlindBrokerPortAdapterError();
  }
  return withContentHash(
    cloneJson(draft) as unknown as Readonly<Record<string, unknown>>,
  ) as unknown as TrustedBlindBrokerEvaluationConfigurationRecord;
}

function parseConfigurationRecord(
  raw: string,
  artifact: TrustedCloudArtifactRef,
  experiment: ExperimentIdentity,
): TrustedBlindBrokerEvaluationConfigurationRecord {
  assertExactKeys(artifact, [
    "uri",
    "sha256",
    "mediaType",
    "byteLength",
  ]);
  if (
    !TRUSTED_URI.test(artifact.uri) ||
    artifact.uri.includes("..") ||
    !SHA256.test(artifact.sha256) ||
    artifact.mediaType !== "application/json" ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength <= 0 ||
    Buffer.byteLength(raw, "utf8") !== artifact.byteLength
  ) {
    throw new TrustedBlindBrokerPortAdapterError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TrustedBlindBrokerPortAdapterError();
  }
  assertExactKeys(parsed, [
    "schemaVersion",
    "domain",
    "experiment",
    "configuration",
    "createdAt",
    "contentHash",
  ]);
  assertExperiment(parsed.experiment);
  assertConfigurationForExperiment(
    parsed.configuration as BlindBrokerEvaluationConfiguration,
    parsed.experiment,
  );
  if (
    parsed.schemaVersion !== 1 ||
    parsed.domain !==
      "dark-factory.blind-broker-evaluation-configuration.v1" ||
    !canonicalTimestamp(parsed.createdAt) ||
    typeof parsed.contentHash !== "string" ||
    parsed.contentHash !== computeContentHash(parsed) ||
    raw !== `${canonicalJson(parsed)}\n` ||
    canonicalJson(parsed.experiment) !== canonicalJson(experiment)
  ) {
    throw new TrustedBlindBrokerPortAdapterError();
  }
  return cloneJson(
    parsed,
  ) as unknown as TrustedBlindBrokerEvaluationConfigurationRecord;
}

/**
 * Resolves an experiment's frozen evaluator configuration from an immutable
 * verified JSON artifact. The source supplies only a CAS reference; every
 * byte, canonical field, content hash, and experiment/protocol binding is
 * checked again before use.
 */
export class CasBlindBrokerEvaluationConfigurationResolver
  implements BlindBrokerEvaluationConfigurationResolver
{
  readonly #source: TrustedEvaluationConfigurationArtifactSource;
  readonly #reader: TrustedControlJsonArtifactReader;
  readonly #maximumBytes: number;

  constructor(options: CasBlindBrokerEvaluationConfigurationResolverOptions) {
    const maximumBytes = options.maximumBytes ?? MAXIMUM_CONFIGURATION_BYTES;
    if (
      options.source.boundary !== "trusted-cloud" ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1024 ||
      maximumBytes > MAXIMUM_CONFIGURATION_BYTES
    ) {
      throw new TrustedBlindBrokerPortAdapterError();
    }
    this.#source = options.source;
    this.#reader = options.reader;
    this.#maximumBytes = maximumBytes;
  }

  public async resolve(
    experiment: ExperimentIdentity,
  ): Promise<BlindBrokerEvaluationConfiguration> {
    try {
      assertExperiment(experiment);
      const artifact = await this.#source.locate(cloneJson(experiment));
      if (
        artifact === undefined ||
        artifact.mediaType !== "application/json" ||
        artifact.byteLength > this.#maximumBytes
      ) {
        throw new TrustedBlindBrokerPortAdapterError();
      }
      const raw = await this.#reader.readUtf8(
        artifact,
        this.#maximumBytes,
      );
      const record = parseConfigurationRecord(
        raw,
        artifact,
        experiment,
      );
      return cloneJson(record.configuration);
    } catch (error) {
      if (error instanceof TrustedBlindBrokerPortAdapterError) throw error;
      throw new TrustedBlindBrokerPortAdapterError();
    }
  }
}

function assertSnapshotReceipt(
  value: unknown,
  input: {
    readonly commit: string;
    readonly registrationId: string;
    readonly originRepositoryHash: string;
    readonly trustedKeyIds: ReadonlySet<string>;
  },
): asserts value is TrustedGitSourceSnapshotReceipt {
  assertExactKeys(value, [
    "sensitivity",
    "schemaVersion",
    "snapshotId",
    "registrationId",
    "originRepositoryHash",
    "upstreamRepositoryHash",
    "upstreamHeadCommit",
    "upstreamBaseCommit",
    "baselineCommit",
    "provider",
    "sandboxId",
    "imageReference",
    "imageDigest",
    "networkPolicyHash",
    "remoteRef",
    "commitSha",
    "treeSha",
    "lockSha256",
    "archiveMethod",
    "compression",
    "bundleMethod",
    "bundleRef",
    "workerSha256",
    "executionReceiptHash",
    "manifestArtifactSha256",
    "sourceArtifact",
    "sourceBundleArtifact",
    "createdAt",
    "passed",
    "signature",
  ]);
  assertExactKeys(value.sourceArtifact, [
    "uri",
    "sha256",
    "mediaType",
    "byteLength",
  ]);
  assertExactKeys(value.sourceBundleArtifact, [
    "uri",
    "sha256",
    "mediaType",
    "byteLength",
  ]);
  assertExactKeys(value.signature, [
    "algorithm",
    "keyId",
    "signedAt",
    "signature",
  ]);
  const receipt = value as unknown as TrustedGitSourceSnapshotReceipt;
  if (
    receipt.sensitivity !== "trusted-git-source-snapshot" ||
    receipt.schemaVersion !== 2 ||
    !SAFE_ID.test(receipt.snapshotId) ||
    receipt.registrationId !== input.registrationId ||
    receipt.originRepositoryHash !== input.originRepositoryHash ||
    !SHA256.test(receipt.registrationId) ||
    !SHA256.test(receipt.originRepositoryHash) ||
    !SHA256.test(receipt.upstreamRepositoryHash) ||
    !GIT_OBJECT.test(receipt.upstreamHeadCommit) ||
    !GIT_OBJECT.test(receipt.upstreamBaseCommit) ||
    !GIT_OBJECT.test(receipt.baselineCommit) ||
    !["daytona", "e2b", "modal"].includes(receipt.provider) ||
    !SAFE_EXTERNAL_ID.test(receipt.sandboxId) ||
    !SAFE_IMAGE_REFERENCE.test(receipt.imageReference) ||
    !/^sha256:[a-f0-9]{64}$/u.test(receipt.imageDigest) ||
    !receipt.imageReference.endsWith(`@${receipt.imageDigest}`) ||
    !SHA256.test(receipt.networkPolicyHash) ||
    !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u.test(
      receipt.remoteRef,
    ) ||
    receipt.remoteRef.includes("..") ||
    receipt.remoteRef.includes("@{") ||
    receipt.remoteRef.includes("//") ||
    receipt.remoteRef.endsWith("/") ||
    receipt.remoteRef.endsWith(".") ||
    receipt.remoteRef.endsWith(".lock") ||
    receipt.commitSha !== input.commit ||
    !GIT_OBJECT.test(receipt.commitSha) ||
    !GIT_OBJECT.test(receipt.treeSha) ||
    !SHA256.test(receipt.lockSha256) ||
    receipt.archiveMethod !== "git-archive-format-tar" ||
    receipt.compression !== "none" ||
    receipt.bundleMethod !== "git-bundle-v2" ||
    receipt.bundleRef !== TRUSTED_GIT_SOURCE_BUNDLE_REF ||
    !SHA256.test(receipt.workerSha256) ||
    !SHA256.test(receipt.executionReceiptHash) ||
    !SHA256.test(receipt.manifestArtifactSha256) ||
    !TRUSTED_URI.test(receipt.sourceArtifact.uri) ||
    receipt.sourceArtifact.uri.includes("..") ||
    !SHA256.test(receipt.sourceArtifact.sha256) ||
    receipt.sourceArtifact.mediaType !== "application/x-tar" ||
    !Number.isSafeInteger(receipt.sourceArtifact.byteLength) ||
    receipt.sourceArtifact.byteLength <= 0 ||
    receipt.sourceArtifact.byteLength > 512 * 1024 * 1024 ||
    !TRUSTED_URI.test(receipt.sourceBundleArtifact.uri) ||
    receipt.sourceBundleArtifact.uri.includes("..") ||
    !SHA256.test(receipt.sourceBundleArtifact.sha256) ||
    receipt.sourceBundleArtifact.mediaType !==
      "application/vnd.git.bundle" ||
    !Number.isSafeInteger(receipt.sourceBundleArtifact.byteLength) ||
    receipt.sourceBundleArtifact.byteLength <= 0 ||
    receipt.sourceBundleArtifact.byteLength >
      2 * 1024 * 1024 * 1024 ||
    !canonicalTimestamp(receipt.createdAt) ||
    receipt.passed !== true ||
    receipt.signature.algorithm !== "ed25519" ||
    !input.trustedKeyIds.has(receipt.signature.keyId) ||
    !canonicalTimestamp(receipt.signature.signedAt) ||
    Date.parse(receipt.signature.signedAt) <
      Date.parse(receipt.createdAt) ||
    !/^[A-Za-z0-9_-]{86,128}$/u.test(receipt.signature.signature)
  ) {
    throw new TrustedBlindBrokerPortAdapterError();
  }
}

/**
 * Converts a signed, repository-bound Git source snapshot receipt into the
 * evaluator's narrow immutable harness reference. No branch name, credential,
 * repository URL, or source bytes cross this port.
 */
export class SignedGitSourceHarnessArtifactResolver
  implements TrustedHarnessArtifactResolver
{
  readonly #source: TrustedGitSourceSnapshotReceiptSource;
  readonly #keyring: TrustedArtifactSignatureKeyring;
  readonly #trustedKeyIds: ReadonlySet<string>;
  readonly #registrationId: string;
  readonly #originRepositoryHash: string;

  constructor(options: SignedGitSourceHarnessArtifactResolverOptions) {
    const trustedKeyIds = new Set(options.trustedKeyIds);
    if (
      options.source.boundary !== "trusted-cloud" ||
      trustedKeyIds.size < 1 ||
      trustedKeyIds.size !== options.trustedKeyIds.length ||
      [...trustedKeyIds].some((keyId) => !SAFE_ID.test(keyId)) ||
      !SHA256.test(options.registrationId) ||
      !SHA256.test(options.originRepositoryHash)
    ) {
      throw new TrustedBlindBrokerPortAdapterError();
    }
    this.#source = options.source;
    this.#keyring = options.keyring;
    this.#trustedKeyIds = trustedKeyIds;
    this.#registrationId = options.registrationId;
    this.#originRepositoryHash = options.originRepositoryHash;
  }

  public async resolve(commit: string): Promise<HarnessArtifactReference> {
    try {
      if (!GIT_OBJECT.test(commit)) {
        throw new TrustedBlindBrokerPortAdapterError();
      }
      const receipt = await this.#source.findByCommit(commit);
      if (receipt === undefined) {
        throw new TrustedBlindBrokerPortAdapterError();
      }
      assertSnapshotReceipt(receipt, {
        commit,
        registrationId: this.#registrationId,
        originRepositoryHash: this.#originRepositoryHash,
        trustedKeyIds: this.#trustedKeyIds,
      });
      const key = await this.#keyring.getVerificationKey(
        receipt.signature.keyId,
      );
      if (
        key === undefined ||
        !verifyEd25519Signature(
          receipt as unknown as Readonly<Record<string, unknown>>,
          key,
        )
      ) {
        throw new TrustedBlindBrokerPortAdapterError();
      }
      return {
        uri: receipt.sourceArtifact.uri,
        commitSha: receipt.commitSha,
        treeSha: receipt.treeSha,
        archiveSha256: receipt.sourceArtifact.sha256,
      };
    } catch (error) {
      if (error instanceof TrustedBlindBrokerPortAdapterError) throw error;
      throw new TrustedBlindBrokerPortAdapterError();
    }
  }
}

function isConsumedValidationDiscovery(
  record: DurableBlindBrokerLeaseRecord,
  input: {
    readonly experiment: ExperimentIdentity;
    readonly discoveryAttestationHash: string;
  },
): boolean {
  return (
    record.stage === "validation" &&
    record.status === "disposed" &&
    record.disposedOutcome === "decided" &&
    record.aggregate !== null &&
    "validPairs" in record.aggregate &&
    record.aggregate.attestationHash === input.discoveryAttestationHash &&
    record.experiment.number < input.experiment.number &&
    record.experiment.lineageId === input.experiment.lineageId &&
    record.experiment.protocolHash === input.experiment.protocolHash
  );
}

/**
 * Resolves repair reuse exclusively from the broker's durable, already
 * signature-validated validation record. A no-op linearizable transaction
 * prevents a concurrent state transition from creating an ambiguous source.
 */
export class LeaseStoreTrustedRepairDiscoveryResolver
  implements TrustedRepairDiscoveryResolver
{
  readonly #store: AtomicBlindBrokerLeaseStore;

  constructor(store: AtomicBlindBrokerLeaseStore) {
    this.#store = store;
  }

  public async resolve(input: {
    readonly experiment: ExperimentIdentity;
    readonly discoveryAttestationHash: string;
  }): Promise<TrustedRepairDiscoveryBinding> {
    try {
      assertExperiment(input.experiment);
      if (!SHA256.test(input.discoveryAttestationHash)) {
        throw new TrustedBlindBrokerPortAdapterError();
      }
      return await this.#store.transact((state) => {
        const matches = Object.values(state.records).filter((record) =>
          isConsumedValidationDiscovery(record, input),
        );
        if (matches.length !== 1) {
          throw new TrustedBlindBrokerPortAdapterError();
        }
        const source = matches[0];
        if (source === undefined) {
          throw new TrustedBlindBrokerPortAdapterError();
        }
        const sourceExperimentId = experimentId(source.experiment);
        if (sourceExperimentId === experimentId(input.experiment)) {
          throw new TrustedBlindBrokerPortAdapterError();
        }
        return {
          next: state,
          result: {
            sourceExperimentId,
            discoveryAttestationHash: input.discoveryAttestationHash,
          },
        };
      });
    } catch (error) {
      if (error instanceof TrustedBlindBrokerPortAdapterError) throw error;
      throw new TrustedBlindBrokerPortAdapterError();
    }
  }
}
