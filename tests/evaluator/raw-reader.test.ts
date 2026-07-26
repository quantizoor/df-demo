import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  StrictTrustedDecodedEvaluationReader,
  type TrustedEncryptedRawArtifactSource,
  type TrustedHarborRawArtifactDecoder,
  type TrustedRawArtifactDecryptor,
  TrustedRawReaderBoundaryError,
} from "../../src/evaluator/raw-reader.js";
import {
  createTrustedRawArtifactManifest,
  type TrustedEncryptedRawArtifact,
  type TrustedRawRetentionPolicy,
} from "../../src/evaluator/retention.js";
import type { TrustedRawRun } from "../../src/terminal-bench/runner.js";

const policy: TrustedRawRetentionPolicy = {
  policyHash: "1".repeat(64),
  storageRoot: "trusted://raw/evaluator/",
  maximumRetentionMinutes: 60,
  destruction: "crypto-shred",
  encryptionRequired: true,
  localExportAllowed: false,
};

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const values = {
    atif: new TextEncoder().encode('{"atif":"encrypted"}'),
    "grader-output": new TextEncoder().encode('{"grader":"encrypted"}'),
    "harbor-output": new TextEncoder().encode('{"harbor":"encrypted"}'),
  } as const;
  const artifacts: readonly TrustedEncryptedRawArtifact[] = [
    {
      kind: "atif",
      uri: "trusted://raw/evaluator/atif.enc",
      sha256: hash(values.atif),
      byteLength: values.atif.byteLength,
      encrypted: true,
    },
    {
      kind: "grader-output",
      uri: "trusted://raw/evaluator/grader.enc",
      sha256: hash(values["grader-output"]),
      byteLength: values["grader-output"].byteLength,
      encrypted: true,
    },
    {
      kind: "harbor-output",
      uri: "trusted://raw/evaluator/harbor.enc",
      sha256: hash(values["harbor-output"]),
      byteLength: values["harbor-output"].byteLength,
      encrypted: true,
    },
  ];
  const manifest = createTrustedRawArtifactManifest(policy, {
    manifestId: "manifest-reader-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    destroyBy: "2026-07-01T01:00:00.000Z",
    artifacts,
  });
  const rawRun: TrustedRawRun = {
    sensitivity: "raw-terminal-bench-run",
    requestId: "reader-request-1",
    pinHash: "2".repeat(64),
    jobSha256: "3".repeat(64),
    runtimeAttestationHash: "4".repeat(64),
    executions: [],
    rawBundles: [],
    manifest,
  };
  return { values, artifacts, rawRun };
}

class TestOnlyInMemoryRawSource implements TrustedEncryptedRawArtifactSource {
  readonly boundary = "test-only-in-memory" as const;
  readonly #values: ReadonlyMap<string, Uint8Array>;

  constructor(values: ReadonlyMap<string, Uint8Array>) {
    this.#values = values;
  }

  read(artifact: TrustedEncryptedRawArtifact): Promise<Uint8Array> {
    const value = this.#values.get(artifact.uri);
    if (value === undefined) throw new Error("missing test fixture");
    return Promise.resolve(value);
  }
}

function source(
  boundary: "trusted-cloud" | "test-only-in-memory",
  values: ReadonlyMap<string, Uint8Array>,
): TrustedEncryptedRawArtifactSource {
  return {
    boundary,
    read: (artifact) => {
      const value = values.get(artifact.uri);
      if (value === undefined) throw new Error("missing fixture");
      return Promise.resolve(value);
    },
  };
}

function decryptor(boundary: "trusted-cloud" | "test-only-in-memory"): TrustedRawArtifactDecryptor {
  return {
    boundary,
    decrypt: (input) => {
      const plaintext = new TextEncoder().encode(`decoded-${input.artifact.kind}`);
      return Promise.resolve({
        plaintext,
        attestation: {
          boundary: "trusted-cloud-decryption",
          artifactUri: input.artifact.uri,
          ciphertextSha256: input.artifact.sha256,
          plaintextSha256: hash(plaintext),
          additionalAuthenticatedDataHash: input.additionalAuthenticatedDataHash,
          keyVersion: "cloud-kms-key-v1",
          decryptedAt: "2026-07-01T00:01:00.000Z",
        },
      });
    },
  };
}

function decoder(
  boundary: "trusted-cloud" | "test-only-in-memory",
): TrustedHarborRawArtifactDecoder {
  return {
    boundary,
    decode: (input) =>
      Promise.resolve({
        inputBindingHash: input.inputBindingHash,
        decoded: {
          sensitivity: "trusted-decoded-evaluation",
          requestId: input.requestId,
          jobSha256: input.jobSha256,
          runtimeAttestationHash: input.runtimeAttestationHash,
          rawManifestHash: input.rawManifestHash,
          rawArtifactSetHash: input.rawArtifactSetHash,
          attempts: [],
        },
      }),
  };
}

describe("authenticated trusted raw reader", () => {
  it("hash-binds ciphertext, decryption AAD, all plaintexts, and decoder output", async () => {
    const value = fixture();
    const values = new Map(
      value.artifacts.map((artifact) => [artifact.uri, value.values[artifact.kind]] as const),
    );
    const reader = new StrictTrustedDecodedEvaluationReader({
      deployment: "trusted-cloud",
      retentionPolicy: policy,
      source: source("trusted-cloud", values),
      decryptor: decryptor("trusted-cloud"),
      decoder: decoder("trusted-cloud"),
    });
    await expect(reader.decode(value.rawRun)).resolves.toMatchObject({
      sensitivity: "trusted-decoded-evaluation",
      requestId: value.rawRun.requestId,
      rawManifestHash: value.rawRun.manifest.manifestHash,
      attempts: [],
    });
  });

  it("zeroes every transferred plaintext buffer after decoding", async () => {
    const value = fixture();
    const values = new Map(
      value.artifacts.map((artifact) => [artifact.uri, value.values[artifact.kind]] as const),
    );
    const baseDecryptor = decryptor("trusted-cloud");
    const transferred: Uint8Array[] = [];
    const reader = new StrictTrustedDecodedEvaluationReader({
      deployment: "trusted-cloud",
      retentionPolicy: policy,
      source: source("trusted-cloud", values),
      decryptor: {
        boundary: "trusted-cloud",
        decrypt: async (input) => {
          const decrypted = await baseDecryptor.decrypt(input);
          transferred.push(decrypted.plaintext);
          return decrypted;
        },
      },
      decoder: decoder("trusted-cloud"),
    });
    await reader.decode(value.rawRun);
    expect(transferred).toHaveLength(3);
    expect(transferred.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
  });

  it("rejects the explicitly test-only in-memory fixture in production", () => {
    const value = fixture();
    const values = new Map(
      value.artifacts.map((artifact) => [artifact.uri, value.values[artifact.kind]] as const),
    );
    expect(
      () =>
        new StrictTrustedDecodedEvaluationReader({
          deployment: "trusted-cloud",
          retentionPolicy: policy,
          source: new TestOnlyInMemoryRawSource(values),
          decryptor: decryptor("test-only-in-memory"),
          decoder: decoder("test-only-in-memory"),
        }),
    ).toThrow(TrustedRawReaderBoundaryError);
  });

  it("fails before decryption when encrypted bytes do not match the manifest", async () => {
    const value = fixture();
    const tampered = new Map(
      value.artifacts.map((artifact) => [artifact.uri, value.values[artifact.kind]] as const),
    );
    tampered.set(value.artifacts[0]!.uri, new TextEncoder().encode("same-length-is-not-trusted"));
    const decrypt = vi.fn(decryptor("trusted-cloud").decrypt);
    const reader = new StrictTrustedDecodedEvaluationReader({
      deployment: "trusted-cloud",
      retentionPolicy: policy,
      source: source("trusted-cloud", tampered),
      decryptor: {
        boundary: "trusted-cloud",
        decrypt,
      },
      decoder: decoder("trusted-cloud"),
    });
    await expect(reader.decode(value.rawRun)).rejects.toMatchObject({
      code: "ciphertext-invalid",
      message: "Trusted raw evidence could not be decoded.",
    });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("rejects a decoder result that does not acknowledge its complete input binding", async () => {
    const value = fixture();
    const values = new Map(
      value.artifacts.map((artifact) => [artifact.uri, value.values[artifact.kind]] as const),
    );
    const detached: TrustedHarborRawArtifactDecoder = {
      boundary: "trusted-cloud",
      decode: (input) =>
        Promise.resolve({
          inputBindingHash: "f".repeat(64),
          decoded: {
            sensitivity: "trusted-decoded-evaluation",
            requestId: input.requestId,
            jobSha256: input.jobSha256,
            runtimeAttestationHash: input.runtimeAttestationHash,
            rawManifestHash: input.rawManifestHash,
            rawArtifactSetHash: input.rawArtifactSetHash,
            attempts: [],
          },
        }),
    };
    const reader = new StrictTrustedDecodedEvaluationReader({
      deployment: "trusted-cloud",
      retentionPolicy: policy,
      source: source("trusted-cloud", values),
      decryptor: decryptor("trusted-cloud"),
      decoder: detached,
    });
    await expect(reader.decode(value.rawRun)).rejects.toMatchObject({
      code: "decode-invalid",
    });
  });

  it("rejects decryption attested after the raw retention deadline", async () => {
    const value = fixture();
    const values = new Map(
      value.artifacts.map((artifact) => [artifact.uri, value.values[artifact.kind]] as const),
    );
    const baseDecryptor = decryptor("trusted-cloud");
    const reader = new StrictTrustedDecodedEvaluationReader({
      deployment: "trusted-cloud",
      retentionPolicy: policy,
      source: source("trusted-cloud", values),
      decryptor: {
        boundary: "trusted-cloud",
        decrypt: async (input) => {
          const decrypted = await baseDecryptor.decrypt(input);
          return {
            ...decrypted,
            attestation: {
              ...decrypted.attestation,
              decryptedAt: "2026-07-01T01:00:00.001Z",
            },
          };
        },
      },
      decoder: decoder("trusted-cloud"),
    });
    await expect(reader.decode(value.rawRun)).rejects.toMatchObject({
      code: "decryption-invalid",
    });
  });
});
