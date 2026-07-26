import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  TrustedCloudEd25519PublicKey,
  TrustedCloudEd25519PublicKeyProvider,
} from "../../src/evaluator/hidden-update-signature.js";
import {
  CloudBackedCanonicalEvaluatorKeyring,
  TrustedCanonicalEvaluatorKeyringError,
} from "../../src/evaluator/trusted-keyring.js";

const KEY_ID = "result-key-001";

class PublicKeys implements TrustedCloudEd25519PublicKeyProvider {
  readonly boundary = "trusted-cloud" as const;
  readonly resolve = vi.fn(
    async (): Promise<TrustedCloudEd25519PublicKey | undefined> => ({
      boundary: "trusted-cloud-key-material",
      algorithm: "Ed25519",
      purpose: "result-envelope",
      keyId: KEY_ID,
      keyVersion: "kms/key/versions/1",
      publicKey: generateKeyPairSync("ed25519").publicKey,
    }),
  );
}

describe("cloud-backed canonical evaluator keyring", () => {
  it("returns only a purpose- and rotation-bound public key", async () => {
    const keys = new PublicKeys();
    const keyring = new CloudBackedCanonicalEvaluatorKeyring({
      keys,
      trustedKeyIds: [KEY_ID],
    });

    await expect(keyring.getVerificationKey(KEY_ID)).resolves.toBeDefined();
    expect(keys.resolve).toHaveBeenCalledWith({
      purpose: "result-envelope",
      keyId: KEY_ID,
    });

    await expect(
      keyring.getVerificationKey("unknown-key"),
    ).resolves.toBeUndefined();
    expect(keys.resolve).toHaveBeenCalledOnce();
  });

  it("rejects non-cloud providers, duplicate rotation IDs, and detached keys", async () => {
    expect(
      () =>
        new CloudBackedCanonicalEvaluatorKeyring({
          keys: {
            boundary: "test-only-in-memory",
            resolve: async () => undefined,
          },
          trustedKeyIds: [KEY_ID],
        }),
    ).toThrow(TrustedCanonicalEvaluatorKeyringError);
    expect(
      () =>
        new CloudBackedCanonicalEvaluatorKeyring({
          keys: new PublicKeys(),
          trustedKeyIds: [KEY_ID, KEY_ID],
        }),
    ).toThrow(TrustedCanonicalEvaluatorKeyringError);

    const keyring = new CloudBackedCanonicalEvaluatorKeyring({
      keys: {
        boundary: "trusted-cloud",
        resolve: async () => ({
          boundary: "trusted-cloud-key-material",
          algorithm: "Ed25519",
          purpose: "hidden-catalog-outcome-update",
          keyId: KEY_ID,
          keyVersion: "1",
          publicKey: generateKeyPairSync("ed25519").publicKey,
        }),
      },
      trustedKeyIds: [KEY_ID],
    });
    await expect(keyring.getVerificationKey(KEY_ID)).rejects.toBeInstanceOf(
      TrustedCanonicalEvaluatorKeyringError,
    );
  });
});
