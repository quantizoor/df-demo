import { createHash } from "node:crypto";

import type { TrustedArtifactBridge } from "../cloud/artifact-bridge.js";
import type {
  RemoteExecutionReceipt,
  TrustedCloudArtifactRef,
} from "../cloud/types.js";
import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import {
  assertTrustedHarborJobArtifact,
  type TrustedHarborInvocation,
  type TrustedHarborJobArtifact,
  type TrustedHarborUpload,
} from "../terminal-bench/harbor.js";
import {
  assertTrustedMatchedPanel,
  type TrustedMatchedArmSchedule,
  type TrustedMatchedPanel,
} from "../terminal-bench/trusted.js";
import type {
  TrustedRawRun,
  TrustedRawRunIngress,
  TrustedRuntimeVerificationReceipt,
} from "../terminal-bench/runner.js";
import {
  assertTrustedHarbor020DecodingPlan,
  type TrustedHarbor020DecodingPlan,
  type TrustedHarbor020DecodingPlanProvider,
} from "./harbor-v020-decoder.js";
import type {
  TrustedHarbor020BundleInput,
  TrustedHarbor020BundleNormalizer,
  TrustedHarbor020ConfigInput,
  TrustedHarbor020NormalizedEvidence,
} from "./harbor-v020-normalizer.js";
import {
  rawArtifactAdditionalAuthenticatedDataHashFromContext,
  trustedRawSourceEvidenceHash,
  type TrustedEncryptedRawArtifactSource,
  type TrustedEvaluatorPortBoundary,
} from "./raw-reader.js";
import {
  assertRawArtifactManifest,
  assertRawDestructionReceipt,
  assertRawDestructionReceiptVerifier,
  assertRawRetentionPolicy,
  createTrustedRawArtifactManifest,
  type TrustedEncryptedRawArtifact,
  type TrustedRawArtifactKind,
  type TrustedRawArtifactManifest,
  type TrustedRawDestructionReceipt,
  type TrustedRawDestructionReceiptVerifier,
  type TrustedRawRetentionPolicy,
} from "./retention.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const MAXIMUM_HARBOR_ARCHIVE_BYTES =
  2 * 1024 * 1024 * 1024 + 256 * 1024 * 1024;
const RAW_KINDS = [
  "atif",
  "grader-output",
  "harbor-output",
] as const;

type PlainRecord = Readonly<Record<string, unknown>>;

export interface TrustedHarbor020DecodingPlanCommitReceipt {
  readonly status: "committed" | "already-committed";
  readonly requestId: string;
  readonly jobSha256: string;
  readonly sourceEvidenceHash: string;
  readonly planHash: string;
  readonly committedAt: string;
}

/**
 * Production stores must provide an atomic, durable compare-and-swap. A
 * repeated identical plan is idempotent; the same request/job/source key with
 * different content must reject rather than return `already-committed`.
 */
export interface TrustedHarbor020DecodingPlanStore
  extends TrustedHarbor020DecodingPlanProvider
{
  commit(
    plan: TrustedHarbor020DecodingPlan,
  ): Promise<TrustedHarbor020DecodingPlanCommitReceipt>;
}

export interface TrustedRawArtifactClock {
  readonly boundary: TrustedEvaluatorPortBoundary;
  now(): Promise<string>;
}

export interface TrustedRawEncryptionAttestation {
  readonly boundary: "trusted-cloud-encryption";
  readonly artifactKind: TrustedRawArtifactKind;
  readonly artifactUri: `trusted://${string}`;
  readonly plaintextSha256: string;
  readonly ciphertextSha256: string;
  readonly additionalAuthenticatedDataHash: string;
  readonly keyVersion: string;
  readonly encryptedAt: string;
}

export interface TrustedRawEncryptedValue {
  /**
   * Ownership transfers to ingress. The encryptor must not retain the
   * ciphertext; ingress zeroes it immediately after verified persistence.
   */
  readonly ciphertext: Uint8Array;
  readonly attestation: TrustedRawEncryptionAttestation;
}

export interface TrustedRawArtifactEncryptor {
  readonly boundary: TrustedEvaluatorPortBoundary;
  encrypt(input: {
    readonly artifactKind: TrustedRawArtifactKind;
    readonly artifactUri: `trusted://${string}`;
    readonly plaintext: Uint8Array;
    readonly additionalAuthenticatedDataHash: string;
  }): Promise<TrustedRawEncryptedValue>;
}

export type TrustedRawLifecycleScope =
  | "source-harbor-bundles"
  | "partial-encrypted-retention-set"
  | "encrypted-retention-set";

export interface TrustedRawLifecycleArtifact {
  readonly uri: `trusted://${string}`;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface TrustedRawLifecycleAttestation {
  readonly sensitivity: "trusted-raw-lifecycle-attestation";
  readonly scope: TrustedRawLifecycleScope;
  readonly requestId: string;
  readonly manifestId: string;
  readonly policyHash: string;
  readonly destruction: "delete" | "crypto-shred";
  readonly artifactUris: readonly `trusted://${string}`[];
  readonly destroyedAt: string;
  readonly backendAttestationHash: string;
  readonly complete: true;
}

/**
 * Provider/storage-specific delete or key-destruction boundary. It must be
 * durable and idempotent and must attest completion only after the backend no
 * longer serves any listed object.
 */
export interface TrustedRawArtifactLifecycle {
  readonly boundary: TrustedEvaluatorPortBoundary;
  destroy(input: {
    readonly scope: TrustedRawLifecycleScope;
    readonly requestId: string;
    readonly manifestId: string;
    readonly policyHash: string;
    readonly destruction: "delete" | "crypto-shred";
    readonly artifacts: readonly TrustedRawLifecycleArtifact[];
    readonly destroyBy: string;
  }): Promise<TrustedRawLifecycleAttestation>;
}

/**
 * The signer verifies the backend attestation under provider policy before it
 * issues the externally verifiable destruction receipt.
 */
export interface TrustedRawDestructionReceiptSigner {
  readonly boundary: TrustedEvaluatorPortBoundary;
  sign(input: {
    readonly policy: TrustedRawRetentionPolicy;
    readonly manifest: TrustedRawArtifactManifest;
    readonly lifecycle: TrustedRawLifecycleAttestation;
  }): Promise<TrustedRawDestructionReceipt>;
}

export interface CloudOnlyTrustedRawIngressOptions {
  readonly deployment: "trusted-cloud" | "test-only";
  readonly artifactBridge: TrustedArtifactBridge;
  readonly retentionPolicy: TrustedRawRetentionPolicy;
  readonly normalizer: TrustedHarbor020BundleNormalizer;
  readonly plans: TrustedHarbor020DecodingPlanStore;
  readonly clock: TrustedRawArtifactClock;
  readonly encryptor: TrustedRawArtifactEncryptor;
  readonly lifecycle: TrustedRawArtifactLifecycle;
  readonly destructionSigner: TrustedRawDestructionReceiptSigner;
  readonly destructionReceiptVerifier: TrustedRawDestructionReceiptVerifier;
  readonly maximumArchiveBytes?: number;
  readonly maximumConfigBytes?: number;
  readonly maximumEncryptedArtifactBytes?: number;
}

export class TrustedRawIngressError extends Error {
  override readonly name = "TrustedRawIngressError";

  constructor() {
    super("Trusted raw Harbor ingress failed closed.");
  }
}

function fail(): never {
  throw new TrustedRawIngressError();
}

function record(value: unknown): PlainRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail();
  }
  return value as PlainRecord;
}

function exactKeys(value: unknown, keys: readonly string[]): PlainRecord {
  const result = record(value);
  const actual = Object.keys(result);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    fail();
  }
  return result;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail();
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string") fail();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail();
  }
  return value;
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function oneChunk(value: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield value;
    },
  };
}

async function collectVerified(
  bridge: TrustedArtifactBridge,
  artifact: TrustedCloudArtifactRef,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    artifact.byteLength < 1 ||
    artifact.byteLength > maximumBytes
  ) {
    fail();
  }
  const source = await bridge.openVerified(artifact);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for await (const rawChunk of source) {
      if (!(rawChunk instanceof Uint8Array)) fail();
      byteLength += rawChunk.byteLength;
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength > artifact.byteLength ||
        byteLength > maximumBytes
      ) {
        fail();
      }
      chunks.push(Uint8Array.from(rawChunk));
    }
    if (byteLength !== artifact.byteLength) fail();
    const result = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (hashBytes(result) !== artifact.sha256) {
      result.fill(0);
      fail();
    }
    return result;
  } finally {
    chunks.forEach((chunk) => chunk.fill(0));
  }
}

function configRole(
  order: TrustedHarborInvocation["order"],
): TrustedHarborUpload["role"] {
  if (order === "repair") return "config-repair";
  return order === "AB" ? "config-ab" : "config-ba";
}

function assertNormalized(
  normalized: TrustedHarbor020NormalizedEvidence,
  input: {
    readonly requestId: string;
    readonly jobSha256: string;
    readonly sourceEvidenceHash: string;
  },
  maximumPlaintextBytes: number,
): void {
  exactKeys(normalized, [
    "sensitivity",
    "schemaVersion",
    "requestId",
    "jobSha256",
    "sourceEvidenceHash",
    "plan",
    "plaintexts",
    "plaintextHashes",
    "normalizationAttestationHash",
  ]);
  exactKeys(normalized.plaintexts, RAW_KINDS);
  exactKeys(normalized.plaintextHashes, RAW_KINDS);
  if (
    normalized.sensitivity !==
      "trusted-harbor-0.20.0-normalized-evidence" ||
    normalized.schemaVersion !== 1 ||
    normalized.requestId !== input.requestId ||
    normalized.jobSha256 !== input.jobSha256 ||
    normalized.sourceEvidenceHash !== input.sourceEvidenceHash
  ) {
    fail();
  }
  digest(normalized.normalizationAttestationHash);
  assertTrustedHarbor020DecodingPlan(normalized.plan, input);
  for (const kind of RAW_KINDS) {
    const plaintext = normalized.plaintexts[kind];
    if (
      !(plaintext instanceof Uint8Array) ||
      plaintext.byteLength < 2 ||
      plaintext.byteLength > maximumPlaintextBytes ||
      hashBytes(plaintext) !== normalized.plaintextHashes[kind]
    ) {
      fail();
    }
    let text: string;
    let parsed: unknown;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      parsed = JSON.parse(text);
    } catch {
      fail();
    }
    if (canonicalJson(parsed) !== text) fail();
  }
}

function assertEncryption(
  value: TrustedRawEncryptedValue,
  input: {
    readonly kind: TrustedRawArtifactKind;
    readonly uri: `trusted://${string}`;
    readonly plaintext: Uint8Array;
    readonly aadHash: string;
    readonly createdAt: string;
    readonly destroyBy: string;
  },
  maximumBytes: number,
): void {
  exactKeys(value, ["ciphertext", "attestation"]);
  exactKeys(value.attestation, [
    "boundary",
    "artifactKind",
    "artifactUri",
    "plaintextSha256",
    "ciphertextSha256",
    "additionalAuthenticatedDataHash",
    "keyVersion",
    "encryptedAt",
  ]);
  if (
    !(value.ciphertext instanceof Uint8Array) ||
    value.ciphertext.byteLength < 1 ||
    value.ciphertext.byteLength > maximumBytes ||
    value.attestation.boundary !== "trusted-cloud-encryption" ||
    value.attestation.artifactKind !== input.kind ||
    value.attestation.artifactUri !== input.uri ||
    value.attestation.plaintextSha256 !== hashBytes(input.plaintext) ||
    value.attestation.ciphertextSha256 !== hashBytes(value.ciphertext) ||
    value.attestation.ciphertextSha256 ===
      value.attestation.plaintextSha256 ||
    value.attestation.additionalAuthenticatedDataHash !== input.aadHash ||
    !SAFE_KEY_VERSION.test(value.attestation.keyVersion)
  ) {
    fail();
  }
  const encryptedAt = Date.parse(
    canonicalTimestamp(value.attestation.encryptedAt),
  );
  if (
    encryptedAt < Date.parse(input.createdAt) ||
    encryptedAt > Date.parse(input.destroyBy)
  ) {
    fail();
  }
}

function assertPlanCommit(
  receipt: TrustedHarbor020DecodingPlanCommitReceipt,
  plan: TrustedHarbor020DecodingPlan,
  createdAt: string,
  destroyBy: string,
): void {
  exactKeys(receipt, [
    "status",
    "requestId",
    "jobSha256",
    "sourceEvidenceHash",
    "planHash",
    "committedAt",
  ]);
  const committedAt = Date.parse(canonicalTimestamp(receipt.committedAt));
  if (
    !new Set(["committed", "already-committed"]).has(receipt.status) ||
    receipt.requestId !== plan.requestId ||
    receipt.jobSha256 !== plan.jobSha256 ||
    receipt.sourceEvidenceHash !== plan.sourceEvidenceHash ||
    receipt.planHash !== plan.planHash ||
    committedAt < Date.parse(createdAt) ||
    committedAt > Date.parse(destroyBy)
  ) {
    fail();
  }
}

function assertLifecycle(
  attestation: TrustedRawLifecycleAttestation,
  input: {
    readonly scope: TrustedRawLifecycleScope;
    readonly requestId: string;
    readonly manifestId: string;
    readonly policyHash: string;
    readonly destruction: "delete" | "crypto-shred";
    readonly artifacts: readonly TrustedRawLifecycleArtifact[];
    readonly createdAt: string;
    readonly destroyBy: string;
  },
): void {
  exactKeys(attestation, [
    "sensitivity",
    "scope",
    "requestId",
    "manifestId",
    "policyHash",
    "destruction",
    "artifactUris",
    "destroyedAt",
    "backendAttestationHash",
    "complete",
  ]);
  const destroyedAt = Date.parse(canonicalTimestamp(attestation.destroyedAt));
  if (
    attestation.sensitivity !== "trusted-raw-lifecycle-attestation" ||
    attestation.scope !== input.scope ||
    attestation.requestId !== input.requestId ||
    attestation.manifestId !== input.manifestId ||
    attestation.policyHash !== input.policyHash ||
    attestation.destruction !== input.destruction ||
    canonicalJson(attestation.artifactUris) !==
      canonicalJson(input.artifacts.map((artifact) => artifact.uri)) ||
    attestation.complete !== true ||
    destroyedAt < Date.parse(input.createdAt) ||
    destroyedAt > Date.parse(input.destroyBy)
  ) {
    fail();
  }
  digest(attestation.backendAttestationHash);
}

function toLifecycleArtifact(
  value: TrustedCloudArtifactRef | TrustedEncryptedRawArtifact,
): TrustedRawLifecycleArtifact {
  return {
    uri: value.uri,
    sha256: value.sha256,
    byteLength: value.byteLength,
  };
}

/**
 * Cloud-only, provider-neutral ingress. The artifact bridge provides verified
 * streaming storage I/O; the injected encryptor/lifecycle/signer bind it to
 * the deployment's KMS, object store, and deletion attestation.
 */
export class CloudOnlyTrustedRawIngress implements TrustedRawRunIngress {
  readonly boundary: TrustedEvaluatorPortBoundary;
  readonly #options: CloudOnlyTrustedRawIngressOptions;
  readonly #maximumArchiveBytes: number;
  readonly #maximumConfigBytes: number;
  readonly #maximumEncryptedArtifactBytes: number;

  constructor(options: CloudOnlyTrustedRawIngressOptions) {
    const boundary =
      options.deployment === "trusted-cloud"
        ? "trusted-cloud"
        : "test-only-in-memory";
    if (
      options.normalizer.boundary !== boundary ||
      options.plans.boundary !== boundary ||
      options.clock.boundary !== boundary ||
      options.encryptor.boundary !== boundary ||
      options.lifecycle.boundary !== boundary ||
      options.destructionSigner.boundary !== boundary
    ) {
      fail();
    }
    assertRawDestructionReceiptVerifier(
      options.destructionReceiptVerifier,
    );
    assertRawRetentionPolicy(options.retentionPolicy);
    this.#maximumArchiveBytes =
      options.maximumArchiveBytes ?? MAXIMUM_HARBOR_ARCHIVE_BYTES;
    this.#maximumConfigBytes =
      options.maximumConfigBytes ?? 16 * 1024 * 1024;
    this.#maximumEncryptedArtifactBytes =
      options.maximumEncryptedArtifactBytes ?? 256 * 1024 * 1024;
    for (const value of [
      this.#maximumArchiveBytes,
      this.#maximumConfigBytes,
      this.#maximumEncryptedArtifactBytes,
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) fail();
    }
    this.boundary = boundary;
    this.#options = options;
  }

  async persist(input: {
    readonly requestId: string;
    readonly job: TrustedHarborJobArtifact;
    readonly panel: TrustedMatchedPanel;
    readonly schedule: TrustedMatchedArmSchedule;
    readonly executions: readonly RemoteExecutionReceipt[];
    readonly downloadedBundles: readonly TrustedCloudArtifactRef[];
    readonly retentionPolicy: TrustedRawRetentionPolicy;
    readonly runtimeVerification: TrustedRuntimeVerificationReceipt;
  }): Promise<TrustedRawRun> {
    const sourceBuffers: Uint8Array[] = [];
    const normalizedBuffers: Uint8Array[] = [];
    const ciphertextBuffers: Uint8Array[] = [];
    const persistedArtifacts: TrustedEncryptedRawArtifact[] = [];
    let manifestId = "raw-uninitialized";
    let createdAt = "";
    let destroyBy = "";
    try {
      this.#options.artifactBridge.assertTrustedRuntime();
      assertRawRetentionPolicy(input.retentionPolicy);
      if (
        canonicalHash(input.retentionPolicy) !==
        canonicalHash(this.#options.retentionPolicy)
      ) {
        fail();
      }
      assertTrustedHarborJobArtifact(input.job, input.job.pinHash);
      assertTrustedMatchedPanel(input.panel);
      if (
        input.requestId !== input.job.requestId ||
        input.requestId !== input.panel.requestId ||
        input.requestId !== input.schedule.requestId ||
        input.job.stage !== input.panel.stage ||
        input.job.stage !== input.schedule.stage ||
        input.executions.length !== input.job.invocations.length ||
        input.downloadedBundles.length !== input.job.invocations.length ||
        input.runtimeVerification.sensitivity !==
          "trusted-runtime-verification" ||
        input.runtimeVerification.pinHash !== input.job.pinHash ||
        input.runtimeVerification.passed !== true ||
        new Set(input.downloadedBundles.map((bundle) => bundle.uri)).size !==
          input.downloadedBundles.length
      ) {
        fail();
      }
      const sourceEvidenceHash = trustedRawSourceEvidenceHash({
        executions: input.executions,
        rawBundles: input.downloadedBundles,
      });
      const runtimeAttestationHash = canonicalHash(
        input.runtimeVerification,
      );
      digest(sourceEvidenceHash);
      digest(runtimeAttestationHash);
      createdAt = canonicalTimestamp(await this.#options.clock.now());
      destroyBy = new Date(
        Date.parse(createdAt) +
          input.retentionPolicy.maximumRetentionMinutes * 60_000,
      ).toISOString();
      manifestId = `raw-${canonicalHash({
        domain: "dark-factory.raw-manifest-id.v1",
        requestId: input.requestId,
        jobSha256: input.job.jobSha256,
        sourceEvidenceHash,
        createdAt,
      }).slice(0, 48)}`;
      if (!SAFE_ID.test(manifestId)) fail();

      const bundles: TrustedHarbor020BundleInput[] = [];
      const configs: TrustedHarbor020ConfigInput[] = [];
      for (const [index, invocation] of input.job.invocations.entries()) {
        const artifact = input.downloadedBundles[index];
        const execution = input.executions[index];
        if (
          artifact === undefined ||
          execution === undefined ||
          artifact.mediaType !== "application/x-tar" ||
          artifact.byteLength < 1 ||
          artifact.byteLength > this.#maximumArchiveBytes ||
          execution.sandboxId !== input.runtimeVerification.sandboxId ||
          execution.exitCode !== 0 ||
          execution.timedOut ||
          execution.cancelled
        ) {
          fail();
        }
        const bytes = await collectVerified(
          this.#options.artifactBridge,
          artifact,
          this.#maximumArchiveBytes,
        );
        sourceBuffers.push(bytes);
        bundles.push({ artifact, bytes, invocation, execution });

        const upload = input.job.uploads.find(
          (candidate) => candidate.role === configRole(invocation.order),
        );
        if (
          upload === undefined ||
          upload.artifact.mediaType !== "application/json"
        ) {
          fail();
        }
        const configBytes = await collectVerified(
          this.#options.artifactBridge,
          upload.artifact,
          this.#maximumConfigBytes,
        );
        sourceBuffers.push(configBytes);
        configs.push({ upload, bytes: configBytes, invocation });
      }
      const normalized = await this.#options.normalizer.normalize({
        requestId: input.requestId,
        job: input.job,
        panel: input.panel,
        schedule: input.schedule,
        executions: input.executions,
        runtimeVerification: input.runtimeVerification,
        sourceEvidenceHash,
        bundles,
        configs,
        maximumArchiveBytes: this.#maximumArchiveBytes,
      });
      for (const kind of RAW_KINDS) {
        const plaintext = normalized.plaintexts?.[kind];
        if (plaintext instanceof Uint8Array) {
          normalizedBuffers.push(plaintext);
        }
      }
      assertNormalized(
        normalized,
        {
          requestId: input.requestId,
          jobSha256: input.job.jobSha256,
          sourceEvidenceHash,
        },
        this.#maximumEncryptedArtifactBytes,
      );

      for (const kind of RAW_KINDS) {
        const uri =
          `${input.retentionPolicy.storageRoot}${manifestId}/${kind}.enc` as const;
        const aadHash =
          rawArtifactAdditionalAuthenticatedDataHashFromContext({
            requestId: input.requestId,
            pinHash: input.job.pinHash,
            jobSha256: input.job.jobSha256,
            runtimeAttestationHash,
            sourceEvidenceHash,
            manifestId,
            policyHash: input.retentionPolicy.policyHash,
            artifactKind: kind,
            artifactUri: uri,
          });
        const encrypted = await this.#options.encryptor.encrypt({
          artifactKind: kind,
          artifactUri: uri,
          plaintext: normalized.plaintexts[kind],
          additionalAuthenticatedDataHash: aadHash,
        });
        if (encrypted.ciphertext instanceof Uint8Array) {
          ciphertextBuffers.push(encrypted.ciphertext);
        }
        assertEncryption(
          encrypted,
          {
            kind,
            uri,
            plaintext: normalized.plaintexts[kind],
            aadHash,
            createdAt,
            destroyBy,
          },
          this.#maximumEncryptedArtifactBytes,
        );
        const persisted =
          await this.#options.artifactBridge.persistVerified({
            uri,
            mediaType: "application/octet-stream",
            chunks: oneChunk(encrypted.ciphertext),
          });
        if (
          persisted.uri !== uri ||
          persisted.sha256 !== encrypted.attestation.ciphertextSha256 ||
          persisted.byteLength !== encrypted.ciphertext.byteLength ||
          persisted.mediaType !== "application/octet-stream"
        ) {
          fail();
        }
        persistedArtifacts.push({
          kind,
          uri,
          sha256: persisted.sha256,
          byteLength: persisted.byteLength,
          encrypted: true,
        });
        encrypted.ciphertext.fill(0);
      }
      const manifest = createTrustedRawArtifactManifest(
        input.retentionPolicy,
        {
          manifestId,
          createdAt,
          destroyBy,
          artifacts: persistedArtifacts,
        },
      );

      const sourceArtifacts = input.downloadedBundles.map(
        toLifecycleArtifact,
      );
      const sourceLifecycle = await this.#options.lifecycle.destroy({
        scope: "source-harbor-bundles",
        requestId: input.requestId,
        manifestId,
        policyHash: input.retentionPolicy.policyHash,
        destruction: "delete",
        artifacts: sourceArtifacts,
        destroyBy,
      });
      assertLifecycle(sourceLifecycle, {
        scope: "source-harbor-bundles",
        requestId: input.requestId,
        manifestId,
        policyHash: input.retentionPolicy.policyHash,
        destruction: "delete",
        artifacts: sourceArtifacts,
        createdAt,
        destroyBy,
      });

      assertPlanCommit(
        await this.#options.plans.commit(normalized.plan),
        normalized.plan,
        createdAt,
        destroyBy,
      );
      const rawRun: TrustedRawRun = {
        sensitivity: "raw-terminal-bench-run",
        requestId: input.requestId,
        pinHash: input.job.pinHash,
        jobSha256: input.job.jobSha256,
        runtimeAttestationHash,
        executions: input.executions,
        rawBundles: input.downloadedBundles,
        manifest,
      };
      assertRawArtifactManifest(input.retentionPolicy, rawRun.manifest);
      return rawRun;
    } catch {
      const partial = persistedArtifacts.map(toLifecycleArtifact);
      if (partial.length > 0 && createdAt.length > 0 && destroyBy.length > 0) {
        try {
          await this.#options.lifecycle.destroy({
            scope: "partial-encrypted-retention-set",
            requestId: input.requestId,
            manifestId,
            policyHash: input.retentionPolicy.policyHash,
            destruction: input.retentionPolicy.destruction,
            artifacts: partial,
            destroyBy,
          });
        } catch {
          // The retention deadline and deployment reconciler remain the
          // fail-closed backstop; no evaluation result is returned.
        }
      }
      if (createdAt.length > 0 && destroyBy.length > 0) {
        try {
          await this.#options.lifecycle.destroy({
            scope: "source-harbor-bundles",
            requestId: input.requestId,
            manifestId,
            policyHash: input.retentionPolicy.policyHash,
            destruction: "delete",
            artifacts: input.downloadedBundles.map(toLifecycleArtifact),
            destroyBy,
          });
        } catch {
          // Same bounded-retention backstop as the partial encrypted set.
        }
      }
      fail();
    } finally {
      sourceBuffers.forEach((value) => value.fill(0));
      normalizedBuffers.forEach((value) => value.fill(0));
      ciphertextBuffers.forEach((value) => value.fill(0));
    }
  }

  async discard(rawRun: TrustedRawRun): Promise<TrustedRawDestructionReceipt> {
    return this.destroy(rawRun);
  }

  async destroy(rawRun: TrustedRawRun): Promise<TrustedRawDestructionReceipt> {
    try {
      this.#options.artifactBridge.assertTrustedRuntime();
      const policy = this.#options.retentionPolicy;
      assertRawArtifactManifest(policy, rawRun.manifest);
      const artifacts = rawRun.manifest.artifacts.map(
        toLifecycleArtifact,
      );
      const lifecycle = await this.#options.lifecycle.destroy({
        scope: "encrypted-retention-set",
        requestId: rawRun.requestId,
        manifestId: rawRun.manifest.manifestId,
        policyHash: policy.policyHash,
        destruction: policy.destruction,
        artifacts,
        destroyBy: rawRun.manifest.destroyBy,
      });
      assertLifecycle(lifecycle, {
        scope: "encrypted-retention-set",
        requestId: rawRun.requestId,
        manifestId: rawRun.manifest.manifestId,
        policyHash: policy.policyHash,
        destruction: policy.destruction,
        artifacts,
        createdAt: rawRun.manifest.createdAt,
        destroyBy: rawRun.manifest.destroyBy,
      });
      const receipt = await this.#options.destructionSigner.sign({
        policy,
        manifest: rawRun.manifest,
        lifecycle,
      });
      if (receipt.destroyedAt !== lifecycle.destroyedAt) fail();
      assertRawDestructionReceipt(
        policy,
        rawRun.manifest,
        receipt,
        this.#options.destructionReceiptVerifier,
      );
      return receipt;
    } catch {
      fail();
    }
  }
}

/**
 * Reader source backed by the same verified trusted artifact bridge. It
 * materializes only a bounded in-memory ciphertext buffer and never touches a
 * local path.
 */
export class BridgeTrustedEncryptedRawArtifactSource
  implements TrustedEncryptedRawArtifactSource
{
  readonly boundary: TrustedEvaluatorPortBoundary;
  readonly #bridge: TrustedArtifactBridge;
  readonly #maximumBytes: number;

  constructor(options: {
    readonly deployment: "trusted-cloud" | "test-only";
    readonly bridge: TrustedArtifactBridge;
    readonly maximumBytes?: number;
  }) {
    this.boundary =
      options.deployment === "trusted-cloud"
        ? "trusted-cloud"
        : "test-only-in-memory";
    this.#bridge = options.bridge;
    this.#maximumBytes = options.maximumBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maximumBytes) || this.#maximumBytes < 1) {
      fail();
    }
  }

  async read(artifact: TrustedEncryptedRawArtifact): Promise<Uint8Array> {
    return collectVerified(
      this.#bridge,
      {
        uri: artifact.uri,
        sha256: artifact.sha256,
        mediaType: "application/octet-stream",
        byteLength: artifact.byteLength,
      },
      this.#maximumBytes,
    );
  }
}
