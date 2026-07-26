import { createHash } from "node:crypto";

import { canonicalHash } from "../schemas/canonical.js";
import type { TrustedRawRun } from "../terminal-bench/runner.js";
import type { TrustedDecodedEvaluation, TrustedDecodedEvaluationReader } from "./deriver.js";
import {
  assertRawArtifactManifest,
  type TrustedEncryptedRawArtifact,
  type TrustedRawArtifactKind,
  type TrustedRawRetentionPolicy,
} from "./retention.js";

export type TrustedEvaluatorPortBoundary = "trusted-cloud" | "test-only-in-memory";

export interface TrustedEncryptedRawArtifactSource {
  readonly boundary: TrustedEvaluatorPortBoundary;
  read(artifact: TrustedEncryptedRawArtifact): Promise<Uint8Array>;
}

export interface TrustedRawDecryptionAttestation {
  readonly boundary: "trusted-cloud-decryption";
  readonly artifactUri: `trusted://${string}`;
  readonly ciphertextSha256: string;
  readonly plaintextSha256: string;
  readonly additionalAuthenticatedDataHash: string;
  readonly keyVersion: string;
  readonly decryptedAt: string;
}

export interface TrustedDecryptedRawArtifact {
  /**
   * Ownership transfers to the reader. The decryptor must not retain this
   * buffer; the reader zeroes it after decoding.
   */
  readonly plaintext: Uint8Array;
  readonly attestation: TrustedRawDecryptionAttestation;
}

export interface TrustedRawArtifactDecryptor {
  readonly boundary: TrustedEvaluatorPortBoundary;
  decrypt(input: {
    readonly artifact: TrustedEncryptedRawArtifact;
    readonly ciphertext: Uint8Array;
    readonly additionalAuthenticatedDataHash: string;
  }): Promise<TrustedDecryptedRawArtifact>;
}

export type TrustedDecodedPlaintextSet = Readonly<Record<TrustedRawArtifactKind, Uint8Array>>;

export interface TrustedHarborRawDecoderResult {
  readonly decoded: TrustedDecodedEvaluation;
  readonly inputBindingHash: string;
}

/**
 * The provider-specific Harbor/ATIF decoder belongs inside the trusted cloud
 * evaluator. It must consume all three authenticated plaintexts and return the
 * exact input binding supplied by `StrictTrustedDecodedEvaluationReader`.
 */
export interface TrustedHarborRawArtifactDecoder {
  readonly boundary: TrustedEvaluatorPortBoundary;
  decode(input: {
    readonly requestId: string;
    readonly jobSha256: string;
    readonly runtimeAttestationHash: string;
    readonly sourceEvidenceHash: string;
    readonly rawManifestHash: string;
    readonly rawArtifactSetHash: string;
    readonly plaintexts: TrustedDecodedPlaintextSet;
    readonly inputBindingHash: string;
  }): Promise<TrustedHarborRawDecoderResult>;
}

export interface StrictTrustedDecodedEvaluationReaderOptions {
  readonly deployment: "trusted-cloud" | "test-only";
  readonly retentionPolicy: TrustedRawRetentionPolicy;
  readonly source: TrustedEncryptedRawArtifactSource;
  readonly decryptor: TrustedRawArtifactDecryptor;
  readonly decoder: TrustedHarborRawArtifactDecoder;
  readonly maximumEncryptedArtifactBytes?: number;
  readonly maximumPlaintextArtifactBytes?: number;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const DEFAULT_MAXIMUM_ARTIFACT_BYTES = 256 * 1024 * 1024;

export class TrustedRawReaderBoundaryError extends Error {
  override readonly name = "TrustedRawReaderBoundaryError";
  readonly code:
    | "boundary-invalid"
    | "manifest-invalid"
    | "ciphertext-invalid"
    | "decryption-invalid"
    | "decode-invalid";

  constructor(code: TrustedRawReaderBoundaryError["code"]) {
    super("Trusted raw evidence could not be decoded.");
    this.code = code;
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("Timestamp is not canonical UTC.");
  }
}

function exactPlainObject(
  value: unknown,
  keys: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("Trusted raw boundary value is not a plain object.");
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error("Trusted raw boundary value has unexpected fields.");
  }
}

export function rawArtifactAdditionalAuthenticatedDataHash(input: {
  readonly rawRun: TrustedRawRun;
  readonly artifact: TrustedEncryptedRawArtifact;
}): string {
  return rawArtifactAdditionalAuthenticatedDataHashFromContext({
    requestId: input.rawRun.requestId,
    pinHash: input.rawRun.pinHash,
    jobSha256: input.rawRun.jobSha256,
    runtimeAttestationHash: input.rawRun.runtimeAttestationHash,
    sourceEvidenceHash: trustedRawSourceEvidenceHash(input.rawRun),
    manifestId: input.rawRun.manifest.manifestId,
    policyHash: input.rawRun.manifest.policyHash,
    artifactKind: input.artifact.kind,
    artifactUri: input.artifact.uri,
  });
}

/**
 * Acyclic AEAD binding material. Ciphertext digests, the artifact-set hash,
 * and the manifest hash are deliberately excluded because an AEAD tag depends
 * on AAD; including any ciphertext-derived digest would make encryption
 * self-referential. The reader verifies those independent commitments before
 * decryption.
 */
export function rawArtifactAdditionalAuthenticatedDataHashFromContext(input: {
  readonly requestId: string;
  readonly pinHash: string;
  readonly jobSha256: string;
  readonly runtimeAttestationHash: string;
  readonly sourceEvidenceHash: string;
  readonly manifestId: string;
  readonly policyHash: string;
  readonly artifactKind: TrustedRawArtifactKind;
  readonly artifactUri: `trusted://${string}`;
}): string {
  return canonicalHash({
    domain: "dark-factory.raw-artifact-aad.v2",
    requestId: input.requestId,
    pinHash: input.pinHash,
    jobSha256: input.jobSha256,
    runtimeAttestationHash: input.runtimeAttestationHash,
    sourceEvidenceHash: input.sourceEvidenceHash,
    manifestId: input.manifestId,
    policyHash: input.policyHash,
    artifactKind: input.artifactKind,
    artifactUri: input.artifactUri,
  });
}

export function trustedRawSourceEvidenceHash(
  rawRun: Pick<TrustedRawRun, "executions" | "rawBundles">,
): string {
  return canonicalHash({
    domain: "dark-factory.raw-source-evidence.v1",
    executions: rawRun.executions,
    rawBundles: rawRun.rawBundles,
  });
}

export function decodedRawInputBindingHash(input: {
  readonly rawRun: TrustedRawRun;
  readonly plaintextHashes: Readonly<Record<TrustedRawArtifactKind, string>>;
}): string {
  return canonicalHash({
    domain: "dark-factory.decoded-raw-input.v1",
    requestId: input.rawRun.requestId,
    jobSha256: input.rawRun.jobSha256,
    runtimeAttestationHash: input.rawRun.runtimeAttestationHash,
    sourceEvidenceHash: trustedRawSourceEvidenceHash(input.rawRun),
    rawManifestHash: input.rawRun.manifest.manifestHash,
    rawArtifactSetHash: input.rawRun.manifest.artifactSetHash,
    plaintextHashes: input.plaintextHashes,
  });
}

function assertCloudBoundary(options: StrictTrustedDecodedEvaluationReaderOptions): void {
  const boundaries = [
    options.source.boundary,
    options.decryptor.boundary,
    options.decoder.boundary,
  ];
  if (
    options.deployment === "trusted-cloud" &&
    boundaries.some((boundary) => boundary !== "trusted-cloud")
  ) {
    throw new TrustedRawReaderBoundaryError("boundary-invalid");
  }
  if (
    options.deployment === "test-only" &&
    boundaries.some((boundary) => boundary !== "test-only-in-memory")
  ) {
    throw new TrustedRawReaderBoundaryError("boundary-invalid");
  }
}

function assertAttestation(input: {
  readonly attestation: TrustedRawDecryptionAttestation;
  readonly artifact: TrustedEncryptedRawArtifact;
  readonly plaintext: Uint8Array;
  readonly aadHash: string;
  readonly manifestCreatedAt: string;
  readonly manifestDestroyBy: string;
}): void {
  exactPlainObject(input.attestation, [
    "boundary",
    "artifactUri",
    "ciphertextSha256",
    "plaintextSha256",
    "additionalAuthenticatedDataHash",
    "keyVersion",
    "decryptedAt",
  ]);
  canonicalTimestamp(input.attestation.decryptedAt);
  if (
    input.attestation.boundary !== "trusted-cloud-decryption" ||
    input.attestation.artifactUri !== input.artifact.uri ||
    input.attestation.ciphertextSha256 !== input.artifact.sha256 ||
    input.attestation.plaintextSha256 !== sha256(input.plaintext) ||
    input.attestation.additionalAuthenticatedDataHash !== input.aadHash ||
    !SAFE_KEY_VERSION.test(input.attestation.keyVersion) ||
    Date.parse(input.attestation.decryptedAt) < Date.parse(input.manifestCreatedAt) ||
    Date.parse(input.attestation.decryptedAt) > Date.parse(input.manifestDestroyBy)
  ) {
    throw new Error("Decryption attestation is detached.");
  }
}

function assertDecodedTopLevel(value: TrustedDecodedEvaluation, rawRun: TrustedRawRun): void {
  exactPlainObject(value, [
    "sensitivity",
    "requestId",
    "jobSha256",
    "runtimeAttestationHash",
    "rawManifestHash",
    "rawArtifactSetHash",
    "attempts",
  ]);
  if (
    value.sensitivity !== "trusted-decoded-evaluation" ||
    value.requestId !== rawRun.requestId ||
    value.jobSha256 !== rawRun.jobSha256 ||
    value.runtimeAttestationHash !== rawRun.runtimeAttestationHash ||
    value.rawManifestHash !== rawRun.manifest.manifestHash ||
    value.rawArtifactSetHash !== rawRun.manifest.artifactSetHash ||
    !Array.isArray(value.attempts)
  ) {
    throw new Error("Decoded Harbor result is detached.");
  }
}

/**
 * Authenticated raw-reader boundary. No local filesystem fallback exists.
 * Buffers are copied and zeroed after the provider-specific decoder returns.
 */
export class StrictTrustedDecodedEvaluationReader implements TrustedDecodedEvaluationReader {
  readonly boundary: TrustedEvaluatorPortBoundary;
  readonly #options: StrictTrustedDecodedEvaluationReaderOptions;
  readonly #maximumEncryptedArtifactBytes: number;
  readonly #maximumPlaintextArtifactBytes: number;

  constructor(options: StrictTrustedDecodedEvaluationReaderOptions) {
    assertCloudBoundary(options);
    const encryptedLimit = options.maximumEncryptedArtifactBytes ?? DEFAULT_MAXIMUM_ARTIFACT_BYTES;
    const plaintextLimit = options.maximumPlaintextArtifactBytes ?? DEFAULT_MAXIMUM_ARTIFACT_BYTES;
    if (
      !Number.isSafeInteger(encryptedLimit) ||
      encryptedLimit < 1 ||
      !Number.isSafeInteger(plaintextLimit) ||
      plaintextLimit < 1
    ) {
      throw new TrustedRawReaderBoundaryError("boundary-invalid");
    }
    this.boundary =
      options.deployment === "trusted-cloud" ? "trusted-cloud" : "test-only-in-memory";
    this.#options = options;
    this.#maximumEncryptedArtifactBytes = encryptedLimit;
    this.#maximumPlaintextArtifactBytes = plaintextLimit;
  }

  async decode(rawRun: TrustedRawRun): Promise<TrustedDecodedEvaluation> {
    try {
      assertRawArtifactManifest(this.#options.retentionPolicy, rawRun.manifest);
      if (
        rawRun.sensitivity !== "raw-terminal-bench-run" ||
        !SHA256.test(rawRun.pinHash) ||
        !SHA256.test(rawRun.jobSha256) ||
        !SHA256.test(rawRun.runtimeAttestationHash)
      ) {
        throw new TrustedRawReaderBoundaryError("manifest-invalid");
      }
    } catch (error) {
      if (error instanceof TrustedRawReaderBoundaryError) throw error;
      throw new TrustedRawReaderBoundaryError("manifest-invalid");
    }

    const ciphertexts: Uint8Array[] = [];
    const plaintexts: Uint8Array[] = [];
    try {
      const byKind = new Map<TrustedRawArtifactKind, Uint8Array>();
      const plaintextHashes = {} as Record<TrustedRawArtifactKind, string>;
      for (const artifact of rawRun.manifest.artifacts) {
        if (artifact.byteLength > this.#maximumEncryptedArtifactBytes) {
          throw new TrustedRawReaderBoundaryError("ciphertext-invalid");
        }
        let sourceValue: Uint8Array;
        try {
          sourceValue = await this.#options.source.read(artifact);
        } catch {
          throw new TrustedRawReaderBoundaryError("ciphertext-invalid");
        }
        if (!(sourceValue instanceof Uint8Array)) {
          throw new TrustedRawReaderBoundaryError("ciphertext-invalid");
        }
        const ciphertext = Uint8Array.from(sourceValue);
        ciphertexts.push(ciphertext);
        if (
          ciphertext.byteLength !== artifact.byteLength ||
          sha256(ciphertext) !== artifact.sha256
        ) {
          throw new TrustedRawReaderBoundaryError("ciphertext-invalid");
        }
        const aadHash = rawArtifactAdditionalAuthenticatedDataHash({
          rawRun,
          artifact,
        });
        let plaintext: Uint8Array;
        try {
          const decrypted = await this.#options.decryptor.decrypt({
            artifact,
            ciphertext,
            additionalAuthenticatedDataHash: aadHash,
          });
          exactPlainObject(decrypted, ["plaintext", "attestation"]);
          if (!(decrypted.plaintext instanceof Uint8Array)) {
            throw new Error("Decrypted artifact is not a byte array.");
          }
          plaintext = decrypted.plaintext;
          plaintexts.push(plaintext);
          if (
            plaintext.byteLength < 1 ||
            plaintext.byteLength > this.#maximumPlaintextArtifactBytes
          ) {
            throw new Error("Decrypted artifact exceeds its bound.");
          }
          assertAttestation({
            attestation: decrypted.attestation,
            artifact,
            plaintext,
            aadHash,
            manifestCreatedAt: rawRun.manifest.createdAt,
            manifestDestroyBy: rawRun.manifest.destroyBy,
          });
        } catch {
          throw new TrustedRawReaderBoundaryError("decryption-invalid");
        }
        byKind.set(artifact.kind, plaintext);
        plaintextHashes[artifact.kind] = sha256(plaintext);
      }

      const atif = byKind.get("atif");
      const grader = byKind.get("grader-output");
      const harbor = byKind.get("harbor-output");
      if (atif === undefined || grader === undefined || harbor === undefined) {
        throw new TrustedRawReaderBoundaryError("decode-invalid");
      }
      const inputBindingHash = decodedRawInputBindingHash({
        rawRun,
        plaintextHashes,
      });
      let result: TrustedHarborRawDecoderResult;
      try {
        result = await this.#options.decoder.decode({
          requestId: rawRun.requestId,
          jobSha256: rawRun.jobSha256,
          runtimeAttestationHash: rawRun.runtimeAttestationHash,
          sourceEvidenceHash: trustedRawSourceEvidenceHash(rawRun),
          rawManifestHash: rawRun.manifest.manifestHash,
          rawArtifactSetHash: rawRun.manifest.artifactSetHash,
          plaintexts: {
            atif,
            "grader-output": grader,
            "harbor-output": harbor,
          },
          inputBindingHash,
        });
      } catch {
        throw new TrustedRawReaderBoundaryError("decode-invalid");
      }
      exactPlainObject(result, ["decoded", "inputBindingHash"]);
      if (result.inputBindingHash !== inputBindingHash) {
        throw new TrustedRawReaderBoundaryError("decode-invalid");
      }
      assertDecodedTopLevel(result.decoded, rawRun);
      return result.decoded;
    } catch (error) {
      if (error instanceof TrustedRawReaderBoundaryError) throw error;
      throw new TrustedRawReaderBoundaryError("decode-invalid");
    } finally {
      ciphertexts.forEach((value) => {
        value.fill(0);
      });
      plaintexts.forEach((value) => {
        value.fill(0);
      });
    }
  }
}
