import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  assertRawArtifactManifest,
  assertRawDestructionReceipt,
  assertRawRetentionPolicy,
  assertSafeForLocalPersistence,
  createSignedRawDestructionReceipt,
  createTrustedRawArtifactManifest,
  type TrustedRawArtifactManifest,
  type TrustedRawArtifactSet,
  type TrustedRawDestructionReceiptVerifier,
  type TrustedRawRetentionPolicy,
} from "../../src/evaluator/retention.js";

const policy: TrustedRawRetentionPolicy = {
  policyHash: "a".repeat(64),
  storageRoot: "trusted://raw/evaluator/",
  maximumRetentionMinutes: 60,
  destruction: "crypto-shred",
  encryptionRequired: true,
  localExportAllowed: false,
};

const destructionKey = generateKeyPairSync("ed25519");
const destructionVerifier: TrustedRawDestructionReceiptVerifier = {
  trustedKeyId: "raw-destruction-key-1",
  publicKey: destructionKey.publicKey,
};

function artifacts(): TrustedRawArtifactSet {
  return [
    {
      kind: "atif",
      uri: "trusted://raw/evaluator/atif.json.enc",
      sha256: "1".repeat(64),
      byteLength: 1_024,
      encrypted: true,
    },
    {
      kind: "grader-output",
      uri: "trusted://raw/evaluator/grader.json.enc",
      sha256: "2".repeat(64),
      byteLength: 2_048,
      encrypted: true,
    },
    {
      kind: "harbor-output",
      uri: "trusted://raw/evaluator/harbor.tar.enc",
      sha256: "3".repeat(64),
      byteLength: 4_096,
      encrypted: true,
    },
  ];
}

function manifest(): TrustedRawArtifactManifest {
  return createTrustedRawArtifactManifest(policy, {
    manifestId: "manifest-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    destroyBy: "2026-07-01T00:30:00.000Z",
    artifacts: artifacts(),
  });
}

function signedReceipt(
  rawManifest: TrustedRawArtifactManifest,
  destroyedAt = "2026-07-01T00:20:00.000Z",
  signedAt = destroyedAt,
) {
  return createSignedRawDestructionReceipt({
    policy,
    manifest: rawManifest,
    destroyedAt,
    privateKey: destructionKey.privateKey,
    keyId: destructionVerifier.trustedKeyId,
    signedAt,
  });
}

describe("trusted raw retention", () => {
  it("binds exactly three encrypted artifacts into canonical set and manifest hashes", () => {
    const rawManifest = manifest();
    expect(() => assertRawRetentionPolicy(policy)).not.toThrow();
    expect(() => assertRawArtifactManifest(policy, rawManifest)).not.toThrow();
    expect(rawManifest.artifactSetHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(rawManifest.manifestHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("requires an on-time Ed25519 receipt from the injected trusted key", () => {
    const rawManifest = manifest();
    expect(() =>
      assertRawDestructionReceipt(
        policy,
        rawManifest,
        signedReceipt(rawManifest),
        destructionVerifier,
      ),
    ).not.toThrow();

    const late = signedReceipt(
      rawManifest,
      "2026-07-01T00:31:00.000Z",
      "2026-07-01T00:31:00.000Z",
    );
    expect(() =>
      assertRawDestructionReceipt(
        policy,
        rawManifest,
        late,
        destructionVerifier,
      ),
    ).toThrow(/late/u);

    const stale = signedReceipt(
      rawManifest,
      "2026-07-01T00:10:00.000Z",
      "2026-07-01T00:16:00.000Z",
    );
    expect(() =>
      assertRawDestructionReceipt(
        policy,
        rawManifest,
        stale,
        destructionVerifier,
      ),
    ).toThrow(/stale/u);
  });

  it("rejects bad signatures and receipts bound to another artifact set", () => {
    const rawManifest = manifest();
    const valid = signedReceipt(rawManifest);
    const badSignature = {
      ...valid,
      signature: {
        ...valid.signature,
        signature: `${valid.signature.signature.slice(0, -1)}${
          valid.signature.signature.endsWith("A") ? "B" : "A"
        }`,
      },
    };
    expect(() =>
      assertRawDestructionReceipt(
        policy,
        rawManifest,
        badSignature,
        destructionVerifier,
      ),
    ).toThrow(/unsigned|inconsistent/u);
    expect(() =>
      assertRawDestructionReceipt(
        policy,
        rawManifest,
        { ...valid, artifactSetHash: "f".repeat(64) },
        destructionVerifier,
      ),
    ).toThrow(/inconsistent/u);
    expect(() =>
      assertRawDestructionReceipt(
        policy,
        rawManifest,
        { ...valid, manifestHash: "e".repeat(64) },
        destructionVerifier,
      ),
    ).toThrow(/inconsistent/u);

    const otherKey = generateKeyPairSync("ed25519");
    expect(() =>
      assertRawDestructionReceipt(policy, rawManifest, valid, {
        trustedKeyId: destructionVerifier.trustedKeyId,
        publicKey: otherKey.publicKey,
      }),
    ).toThrow(/unsigned/u);
    expect(() =>
      assertRawDestructionReceipt(policy, rawManifest, valid, {
        trustedKeyId: "different-raw-destruction-key",
        publicKey: destructionKey.publicKey,
      }),
    ).toThrow(/unsigned/u);
  });

  it("rejects missing, extra, reordered, or hash-mutated manifest artifacts", () => {
    const valid = manifest();
    for (const mutatedArtifacts of [
      valid.artifacts.slice(0, 2),
      [...valid.artifacts, valid.artifacts[0]],
      [...valid.artifacts].reverse(),
    ]) {
      expect(() =>
        assertRawArtifactManifest(policy, {
          ...valid,
          artifacts: mutatedArtifacts,
        } as unknown as TrustedRawArtifactManifest),
      ).toThrow();
    }
    expect(() =>
      assertRawArtifactManifest(policy, {
        ...valid,
        artifacts: [
          { ...valid.artifacts[0], sha256: "f".repeat(64) },
          valid.artifacts[1],
          valid.artifacts[2],
        ],
      }),
    ).toThrow();
    expect(() =>
      assertRawArtifactManifest(policy, {
        ...valid,
        manifestHash: "e".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      assertRawArtifactManifest(policy, {
        ...valid,
        extraArtifact: "forbidden",
      } as unknown as TrustedRawArtifactManifest),
    ).toThrow(/canonical fields/u);
  });

  it("rejects local roots, long retention, export, and root escapes", () => {
    expect(() =>
      assertRawRetentionPolicy({
        ...policy,
        storageRoot: "trusted://raw/evaluator/",
        maximumRetentionMinutes: 1441,
      }),
    ).toThrow();
    expect(() =>
      createTrustedRawArtifactManifest(policy, {
        manifestId: "manifest-1",
        createdAt: "2026-07-01T00:00:00.000Z",
        destroyBy: "2026-07-01T02:00:00.000Z",
        artifacts: [
          {
            ...artifacts()[0],
            uri: "trusted://other/atif.json.enc",
          },
          artifacts()[1],
          artifacts()[2],
        ],
      }),
    ).toThrow();
  });
});

describe("local evidence guard", () => {
  it("accepts task-agnostic aggregate evidence", () => {
    expect(() =>
      assertSafeForLocalPersistence({
        experimentId: "001-improve-recovery",
        scoreDelta: 0.2,
        diagnostic: {
          pattern: "nonzero-exit-without-inspection",
          toolCategory: "execute",
          supportBand: "20-39",
        },
      }),
    ).not.toThrow();
  });

  it.each([
    { taskId: "hidden-task" },
    { rawAtif: { events: [] } },
    { graderOutput: "failure detail" },
    { panelMembership: ["opaque-but-stable"] },
    { stdout: "sensitive command output" },
    { note: "https://example.test/solution" },
    { note: "/workspace/task/secret.txt" },
    { note: "grader expected a different value" },
    { artifact: "trusted://raw/evaluator/atif.json" },
    { note: Buffer.from("hidden-task-name").toString("base64url") },
  ])("rejects local leakage candidate %o", (value) => {
    expect(() => assertSafeForLocalPersistence(value)).toThrow();
  });

  it("rejects cyclic structures", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => assertSafeForLocalPersistence(cyclic)).toThrow(/cyclic/u);
  });
});
