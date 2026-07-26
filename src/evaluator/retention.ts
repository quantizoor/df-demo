import type { KeyLike } from "node:crypto";

import {
  createEd25519Signature,
  verifyEd25519Signature,
} from "../evidence/signatures.js";
import { canonicalHash } from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import type { SignedAggregateEnvelope } from "./contracts.js";

export interface TrustedRawRetentionPolicy {
  readonly policyHash: string;
  readonly storageRoot: `trusted://${string}`;
  readonly maximumRetentionMinutes: number;
  readonly destruction: "delete" | "crypto-shred";
  readonly encryptionRequired: true;
  readonly localExportAllowed: false;
}

export type TrustedRawArtifactKind =
  | "atif"
  | "grader-output"
  | "harbor-output";

export interface TrustedEncryptedRawArtifact {
  readonly kind: TrustedRawArtifactKind;
  readonly uri: `trusted://${string}`;
  readonly sha256: string;
  readonly byteLength: number;
  readonly encrypted: true;
}

export type TrustedRawArtifactSet = readonly [
  TrustedEncryptedRawArtifact,
  TrustedEncryptedRawArtifact,
  TrustedEncryptedRawArtifact,
];

export interface TrustedRawArtifactManifest {
  readonly manifestId: string;
  readonly policyHash: string;
  readonly createdAt: string;
  readonly destroyBy: string;
  readonly localExportAllowed: false;
  readonly artifacts: TrustedRawArtifactSet;
  readonly artifactSetHash: string;
  readonly manifestHash: string;
}

export interface TrustedRawDestructionReceipt {
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly policyHash: string;
  readonly artifactSetHash: string;
  readonly destroyedAt: string;
  readonly destruction: "delete" | "crypto-shred";
  readonly artifactCount: 3;
  readonly verifierAttestationHash: string;
  readonly signature: Signature;
}

export interface TrustedRawDestructionReceiptVerifier {
  readonly trustedKeyId: string;
  readonly publicKey: KeyLike;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_KEY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const RAW_ARTIFACT_KINDS = [
  "atif",
  "grader-output",
  "harbor-output",
] as const;
const MAXIMUM_DESTRUCTION_ATTESTATION_LAG_MS = 5 * 60_000;
const FORBIDDEN_LOCAL_KEYS = new Set([
  "task",
  "taskid",
  "taskids",
  "taskname",
  "tasknames",
  "taskinstruction",
  "taskinstructions",
  "taskkey",
  "taskkeys",
  "panelhandle",
  "panelmembership",
  "rawatif",
  "rawgraderoutput",
  "rawharboroutput",
  "graderoutput",
  "graderprose",
  "trajectory",
  "trajectories",
  "verifieroutput",
  "testname",
  "testnames",
  "expectedvalue",
  "actualvalue",
  "command",
  "arguments",
  "stdout",
  "stderr",
  "filepath",
  "filename",
  "url",
  "packagename",
  "servicename",
  "environmentvariable",
]);
const FORBIDDEN_RELEASED_STRING = [
  /https?:\/\//iu,
  /(?:^|\s)\/(?:Users|home|workspace|tmp|opt)\//u,
  /[A-Za-z]:\\/u,
  /```/u,
  /\b(?:expected|actual|assertion|grader|verifier|solution)\b/iu,
  /(?:^|\s)(?:npm|pnpm|yarn|pip|apt|brew|docker|kubectl)\s+/iu,
];

export class RetentionPolicyError extends Error {
  override readonly name = "RetentionPolicyError";
}

function assertExactPlainObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new RetentionPolicyError(`${label} must be a plain object.`);
  }
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => !expectedKeys.includes(key))
  ) {
    throw new RetentionPolicyError(`${label} must contain exactly its canonical fields.`);
  }
}

function canonicalTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new RetentionPolicyError(
      `${label} must be a canonical UTC RFC 3339 timestamp.`,
    );
  }
  return timestamp;
}

function assertArtifactSet(
  artifacts: readonly TrustedEncryptedRawArtifact[],
): asserts artifacts is TrustedRawArtifactSet {
  if (!Array.isArray(artifacts) || artifacts.length !== 3) {
    throw new RetentionPolicyError(
      "A raw manifest must contain exactly three encrypted artifacts.",
    );
  }
  const uris = new Set<string>();
  for (const [index, artifact] of artifacts.entries()) {
    assertExactPlainObjectKeys(
      artifact,
      ["kind", "uri", "sha256", "byteLength", "encrypted"],
      "Raw artifact reference",
    );
    if (
      artifact.kind !== RAW_ARTIFACT_KINDS[index] ||
      !SHA256.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.byteLength) ||
      artifact.byteLength <= 0 ||
      artifact.encrypted !== true ||
      uris.has(artifact.uri)
    ) {
      throw new RetentionPolicyError(
        "Raw artifacts must be unique, encrypted, hash-bound, and canonically ordered.",
      );
    }
    uris.add(artifact.uri);
  }
}

function artifactSetMaterial(
  artifacts: TrustedRawArtifactSet,
): Readonly<Record<string, unknown>> {
  return {
    domain: "dark-factory.raw-artifact-set.v1",
    artifacts: artifacts.map((artifact) => ({
      kind: artifact.kind,
      uri: artifact.uri,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
      encrypted: artifact.encrypted,
    })),
  };
}

export function hashTrustedRawArtifactSet(
  artifacts: readonly TrustedEncryptedRawArtifact[],
): string {
  assertArtifactSet(artifacts);
  return canonicalHash(artifactSetMaterial(artifacts));
}

function manifestMaterial(
  manifest: Omit<TrustedRawArtifactManifest, "manifestHash">,
): Readonly<Record<string, unknown>> {
  return {
    domain: "dark-factory.raw-artifact-manifest.v1",
    manifestId: manifest.manifestId,
    policyHash: manifest.policyHash,
    createdAt: manifest.createdAt,
    destroyBy: manifest.destroyBy,
    localExportAllowed: manifest.localExportAllowed,
    artifacts: manifest.artifacts,
    artifactSetHash: manifest.artifactSetHash,
  };
}

export function hashTrustedRawArtifactManifest(
  manifest: Omit<TrustedRawArtifactManifest, "manifestHash">,
): string {
  return canonicalHash(manifestMaterial(manifest));
}

export function createTrustedRawArtifactManifest(
  policy: TrustedRawRetentionPolicy,
  input: {
    readonly manifestId: string;
    readonly createdAt: string;
    readonly destroyBy: string;
    readonly artifacts: readonly TrustedEncryptedRawArtifact[];
  },
): TrustedRawArtifactManifest {
  assertRawRetentionPolicy(policy);
  assertArtifactSet(input.artifacts);
  const artifactSetHash = hashTrustedRawArtifactSet(input.artifacts);
  const unsigned: Omit<TrustedRawArtifactManifest, "manifestHash"> = {
    manifestId: input.manifestId,
    policyHash: policy.policyHash,
    createdAt: input.createdAt,
    destroyBy: input.destroyBy,
    localExportAllowed: false,
    artifacts: input.artifacts,
    artifactSetHash,
  };
  const manifest: TrustedRawArtifactManifest = {
    ...unsigned,
    manifestHash: hashTrustedRawArtifactManifest(unsigned),
  };
  assertRawArtifactManifest(policy, manifest);
  return manifest;
}

function destructionReceiptBody(input: {
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly policyHash: string;
  readonly artifactSetHash: string;
  readonly destroyedAt: string;
  readonly destruction: "delete" | "crypto-shred";
  readonly artifactCount: 3;
}): Readonly<Record<string, unknown>> {
  return {
    domain: "dark-factory.raw-destruction-receipt.v1",
    manifestId: input.manifestId,
    manifestHash: input.manifestHash,
    policyHash: input.policyHash,
    artifactSetHash: input.artifactSetHash,
    destroyedAt: input.destroyedAt,
    destruction: input.destruction,
    artifactCount: input.artifactCount,
  };
}

function signedDestructionDocument(
  receipt: Omit<TrustedRawDestructionReceipt, "verifierAttestationHash">,
): Readonly<Record<string, unknown>> {
  return {
    ...destructionReceiptBody(receipt),
    signature: receipt.signature,
  };
}

export function createSignedRawDestructionReceipt(input: {
  readonly policy: TrustedRawRetentionPolicy;
  readonly manifest: TrustedRawArtifactManifest;
  readonly destroyedAt: string;
  readonly privateKey: KeyLike;
  readonly keyId: string;
  readonly signedAt: string;
}): TrustedRawDestructionReceipt {
  assertRawArtifactManifest(input.policy, input.manifest);
  canonicalTimestamp(input.destroyedAt, "Raw destruction time");
  canonicalTimestamp(input.signedAt, "Raw destruction signature time");
  if (!SAFE_KEY_ID.test(input.keyId)) {
    throw new RetentionPolicyError("Raw destruction signing key ID is malformed.");
  }
  const body = destructionReceiptBody({
    manifestId: input.manifest.manifestId,
    manifestHash: input.manifest.manifestHash,
    policyHash: input.policy.policyHash,
    artifactSetHash: input.manifest.artifactSetHash,
    destroyedAt: input.destroyedAt,
    destruction: input.policy.destruction,
    artifactCount: 3,
  });
  const signature = createEd25519Signature(
    body,
    input.privateKey,
    input.keyId,
    input.signedAt,
  );
  const signed = { ...body, signature };
  return {
    manifestId: input.manifest.manifestId,
    manifestHash: input.manifest.manifestHash,
    policyHash: input.policy.policyHash,
    artifactSetHash: input.manifest.artifactSetHash,
    destroyedAt: input.destroyedAt,
    destruction: input.policy.destruction,
    artifactCount: 3,
    verifierAttestationHash: canonicalHash(signed),
    signature,
  };
}

function looksLikeEncodedPrintableText(value: string): boolean {
  if (
    value.length < 12 ||
    value.length > 4096 ||
    !/^[A-Za-z0-9_-]+={0,2}$/u.test(value)
  ) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length < 8) return false;
    const printableBytes = [...decoded].filter(
      (byte) => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126),
    ).length;
    const normalizedInput = value.replace(/=+$/u, "");
    return (
      printableBytes / decoded.length >= 0.9 &&
      decoded.toString("base64url") === normalizedInput
    );
  } catch {
    return false;
  }
}

export function assertRawRetentionPolicy(policy: TrustedRawRetentionPolicy): void {
  assertExactPlainObjectKeys(
    policy,
    [
      "policyHash",
      "storageRoot",
      "maximumRetentionMinutes",
      "destruction",
      "encryptionRequired",
      "localExportAllowed",
    ],
    "Raw retention policy",
  );
  if (
    !SHA256.test(policy.policyHash) ||
    !/^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/$/u.test(
      policy.storageRoot,
    ) ||
    policy.storageRoot.includes("..") ||
    !Number.isSafeInteger(policy.maximumRetentionMinutes) ||
    policy.maximumRetentionMinutes <= 0 ||
    policy.maximumRetentionMinutes > 24 * 60 ||
    !new Set(["delete", "crypto-shred"]).has(policy.destruction) ||
    policy.encryptionRequired !== true ||
    policy.localExportAllowed !== false
  ) {
    throw new RetentionPolicyError("Raw retention policy is not fail-closed.");
  }
}

export function assertRawDestructionReceiptVerifier(
  verifier: TrustedRawDestructionReceiptVerifier,
): void {
  assertExactPlainObjectKeys(
    verifier,
    ["trustedKeyId", "publicKey"],
    "Raw destruction receipt verifier",
  );
  if (
    !SAFE_KEY_ID.test(verifier.trustedKeyId) ||
    verifier.publicKey === null ||
    verifier.publicKey === undefined
  ) {
    throw new RetentionPolicyError(
      "Raw destruction receipt verifier is not pinned to a trusted key.",
    );
  }
}

export function assertRawDestructionReceipt(
  policy: TrustedRawRetentionPolicy,
  manifest: TrustedRawArtifactManifest,
  receipt: TrustedRawDestructionReceipt,
  verifier: TrustedRawDestructionReceiptVerifier,
): void {
  assertRawArtifactManifest(policy, manifest);
  assertRawDestructionReceiptVerifier(verifier);
  assertExactPlainObjectKeys(
    receipt,
    [
      "manifestId",
      "manifestHash",
      "policyHash",
      "artifactSetHash",
      "destroyedAt",
      "destruction",
      "artifactCount",
      "verifierAttestationHash",
      "signature",
    ],
    "Raw destruction receipt",
  );
  assertExactPlainObjectKeys(
    receipt.signature,
    ["algorithm", "keyId", "signedAt", "signature"],
    "Raw destruction receipt signature",
  );
  const destroyedAt = canonicalTimestamp(
    receipt.destroyedAt,
    "Raw destruction time",
  );
  const signedAt = canonicalTimestamp(
    receipt.signature.signedAt,
    "Raw destruction signature time",
  );
  const createdAt = canonicalTimestamp(
    manifest.createdAt,
    "Raw manifest creation time",
  );
  const destroyBy = canonicalTimestamp(
    manifest.destroyBy,
    "Raw manifest destruction deadline",
  );
  const signedDocument = signedDestructionDocument({
    manifestId: receipt.manifestId,
    manifestHash: receipt.manifestHash,
    policyHash: receipt.policyHash,
    artifactSetHash: receipt.artifactSetHash,
    destroyedAt: receipt.destroyedAt,
    destruction: receipt.destruction,
    artifactCount: receipt.artifactCount,
    signature: receipt.signature,
  });
  if (
    receipt.manifestId !== manifest.manifestId ||
    receipt.manifestHash !== manifest.manifestHash ||
    receipt.policyHash !== policy.policyHash ||
    receipt.artifactSetHash !== manifest.artifactSetHash ||
    receipt.destruction !== policy.destruction ||
    receipt.artifactCount !== 3 ||
    !SHA256.test(receipt.verifierAttestationHash) ||
    receipt.verifierAttestationHash !== canonicalHash(signedDocument) ||
    receipt.signature.algorithm !== "ed25519" ||
    receipt.signature.keyId !== verifier.trustedKeyId ||
    destroyedAt < createdAt ||
    destroyedAt > destroyBy ||
    signedAt < destroyedAt ||
    signedAt > destroyBy ||
    signedAt - destroyedAt > MAXIMUM_DESTRUCTION_ATTESTATION_LAG_MS ||
    !verifyEd25519Signature(signedDocument, verifier.publicKey)
  ) {
    throw new RetentionPolicyError(
      "Raw destruction receipt is missing, stale, late, unsigned, or inconsistent.",
    );
  }
}

export function assertRawArtifactManifest(
  policy: TrustedRawRetentionPolicy,
  manifest: TrustedRawArtifactManifest,
): void {
  assertRawRetentionPolicy(policy);
  assertExactPlainObjectKeys(
    manifest,
    [
      "manifestId",
      "policyHash",
      "createdAt",
      "destroyBy",
      "localExportAllowed",
      "artifacts",
      "artifactSetHash",
      "manifestHash",
    ],
    "Raw artifact manifest",
  );
  assertArtifactSet(manifest.artifacts);
  const artifactUris = manifest.artifacts.map((artifact) => artifact.uri);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(manifest.manifestId) ||
    manifest.policyHash !== policy.policyHash ||
    manifest.localExportAllowed !== false ||
    manifest.artifacts.some((artifact) => !artifact.uri.startsWith(policy.storageRoot)) ||
    artifactUris.some(
      (artifact) =>
        artifact.includes("..") ||
        !/^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(artifact),
    ) ||
    new Set(artifactUris).size !== artifactUris.length ||
    manifest.artifactSetHash !== hashTrustedRawArtifactSet(manifest.artifacts) ||
    manifest.manifestHash !==
      hashTrustedRawArtifactManifest({
        manifestId: manifest.manifestId,
        policyHash: manifest.policyHash,
        createdAt: manifest.createdAt,
        destroyBy: manifest.destroyBy,
        localExportAllowed: manifest.localExportAllowed,
        artifacts: manifest.artifacts,
        artifactSetHash: manifest.artifactSetHash,
      })
  ) {
    throw new RetentionPolicyError("Raw artifact manifest escapes its trusted retention policy.");
  }
  const createdAt = canonicalTimestamp(
    manifest.createdAt,
    "Raw manifest creation time",
  );
  const destroyBy = canonicalTimestamp(
    manifest.destroyBy,
    "Raw manifest destruction deadline",
  );
  if (
    destroyBy <= createdAt ||
    destroyBy - createdAt > policy.maximumRetentionMinutes * 60_000
  ) {
    throw new RetentionPolicyError("Raw artifact destruction deadline exceeds policy.");
  }
}

function scanReleasedValue(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
): void {
  if (typeof value === "string") {
    if (
      value.startsWith("trusted://") ||
      FORBIDDEN_RELEASED_STRING.some((pattern) => pattern.test(value)) ||
      looksLikeEncodedPrintableText(value)
    ) {
      throw new RetentionPolicyError(`Released evidence contains a sensitive literal at ${path}.`);
    }
    return;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      scanReleasedValue(entry, `${path}[${index}]`, seen);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new RetentionPolicyError(`Released evidence contains an unsupported value at ${path}.`);
  }
  if (seen.has(value)) {
    throw new RetentionPolicyError("Released evidence cannot contain cyclic data.");
  }
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replace(/[-_]/gu, "").toLowerCase();
    if (FORBIDDEN_LOCAL_KEYS.has(normalizedKey)) {
      throw new RetentionPolicyError(`Released evidence contains forbidden field ${key}.`);
    }
    scanReleasedValue(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

export function assertSafeForLocalPersistence(value: unknown): void {
  scanReleasedValue(value, "$", new WeakSet());
}

export function assertEnvelopeSafeForLocalPersistence(
  envelope: SignedAggregateEnvelope,
): void {
  assertSafeForLocalPersistence(envelope);
  if (envelope.body.rawArtifacts.exported !== false) {
    throw new RetentionPolicyError("Envelope permits raw evaluator artifact export.");
  }
}
