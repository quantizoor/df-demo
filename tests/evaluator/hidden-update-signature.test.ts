import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { hiddenTaskId } from "../../src/evaluation/types.js";
import {
  hashTrustedHiddenCatalogOutcomeSet,
  hashTrustedHiddenCatalogSourceBinding,
  type TrustedSignedHiddenCatalogOutcomeUpdate,
  type UnsignedTrustedHiddenCatalogOutcomeUpdate,
} from "../../src/evaluator/deriver.js";
import {
  CloudBackedHiddenCatalogOutcomeUpdateSigner,
  CloudBackedHiddenCatalogOutcomeUpdateVerifier,
  type TrustedCloudEd25519PrivateKeyProvider,
  type TrustedCloudEd25519PublicKeyProvider,
  TrustedHiddenUpdateSignatureError,
} from "../../src/evaluator/hidden-update-signature.js";

const keys = generateKeyPairSync("ed25519");
const KEY_ID = "hidden-update-key-1";

function unsigned(): UnsignedTrustedHiddenCatalogOutcomeUpdate {
  const outcomes = Array.from({ length: 5 }, (_, index) => ({
    taskId: hiddenTaskId((index + 1).toString(16).padStart(64, "0")),
    taskRevisionDigest: (index + 20).toString(16).padStart(64, "0"),
    capabilityStratum: index % 2 === 0 ? "shell" : "filesystem",
    order: "AB" as const,
    candidate: {
      pass: index % 2 === 0,
      boundedReward: index % 2 === 0 ? 1 : 0,
      infrastructureValid: true as const,
      infrastructureInvalidAttemptCount: 0,
      latencyMs: 10_000,
      inputTokens: 100,
      outputTokens: 20,
      modelUsd: 0.01,
      sandboxUsd: 0.005,
      finalAttemptDigest: (index + 40).toString(16).padStart(64, "0"),
    },
    champion: null,
  }));
  const updateSetHash = hashTrustedHiddenCatalogOutcomeSet(outcomes);
  const source = {
    requestHash: "1".repeat(64),
    protocolHash: "2".repeat(64),
    stage: "repair" as const,
    dispositionAttestationHash: "3".repeat(64),
    rawManifestHash: "4".repeat(64),
    jobSha256: "5".repeat(64),
    runtimeAttestationHash: "6".repeat(64),
    normalizedOutcomeSetHash: "7".repeat(64),
    environmentFingerprintHash: "8".repeat(64),
    updateSetHash,
  };
  const sourceBindingHash = hashTrustedHiddenCatalogSourceBinding(source);
  return {
    sensitivity: "trusted-hidden-catalog-outcome-update",
    schemaVersion: 1,
    updateId: `catalog-${sourceBindingHash.slice(0, 48)}`,
    ...source,
    observedAt: "2026-07-01T00:10:00.000Z",
    outcomes,
    sourceBindingHash,
  };
}

function privateProvider(
  boundary: "trusted-cloud" | "test-only-in-memory" = "test-only-in-memory",
): TrustedCloudEd25519PrivateKeyProvider {
  return {
    boundary,
    resolve: (input) =>
      Promise.resolve({
        boundary: "trusted-cloud-key-material",
        algorithm: "Ed25519",
        purpose: input.purpose,
        keyId: input.keyId,
        keyVersion: "kms-version-1",
        privateKey: keys.privateKey,
      }),
  };
}

function publicProvider(
  boundary: "trusted-cloud" | "test-only-in-memory" = "test-only-in-memory",
): TrustedCloudEd25519PublicKeyProvider {
  return {
    boundary,
    resolve: (input) =>
      Promise.resolve({
        boundary: "trusted-cloud-key-material",
        algorithm: "Ed25519",
        purpose: input.purpose,
        keyId: input.keyId,
        keyVersion: "kms-version-1",
        publicKey: keys.publicKey,
      }),
  };
}

describe("cloud-backed hidden catalog outcome signatures", () => {
  it("signs and verifies the complete hidden update without releasing its key", async () => {
    const signer = new CloudBackedHiddenCatalogOutcomeUpdateSigner({
      deployment: "test-only",
      keyId: KEY_ID,
      keys: privateProvider(),
      now: () => new Date("2026-07-01T00:11:00.000Z"),
    });
    const verifier = new CloudBackedHiddenCatalogOutcomeUpdateVerifier({
      deployment: "test-only",
      keys: publicProvider(),
      trustedKeyIds: [KEY_ID],
      now: () => new Date("2026-07-01T00:12:00.000Z"),
    });
    const body = unsigned();
    const signature = await signer.sign(body);
    const signed: TrustedSignedHiddenCatalogOutcomeUpdate = {
      ...body,
      signature,
    };
    await expect(verifier.verify(signed)).resolves.toBe(true);
  });

  it("rejects a task outcome changed after signature", async () => {
    const signer = new CloudBackedHiddenCatalogOutcomeUpdateSigner({
      deployment: "test-only",
      keyId: KEY_ID,
      keys: privateProvider(),
      now: () => new Date("2026-07-01T00:11:00.000Z"),
    });
    const verifier = new CloudBackedHiddenCatalogOutcomeUpdateVerifier({
      deployment: "test-only",
      keys: publicProvider(),
      trustedKeyIds: [KEY_ID],
      now: () => new Date("2026-07-01T00:12:00.000Z"),
    });
    const body = unsigned();
    const signed: TrustedSignedHiddenCatalogOutcomeUpdate = {
      ...body,
      signature: await signer.sign(body),
    };
    const first = signed.outcomes[0]!;
    const tampered = {
      ...signed,
      outcomes: [
        {
          ...first,
          candidate: {
            ...first.candidate,
            modelUsd: first.candidate.modelUsd + 1,
          },
        },
        ...signed.outcomes.slice(1),
      ],
    } as TrustedSignedHiddenCatalogOutcomeUpdate;
    await expect(verifier.verify(tampered)).resolves.toBe(false);
  });

  it("rejects test-only key providers in production composition", () => {
    expect(
      () =>
        new CloudBackedHiddenCatalogOutcomeUpdateSigner({
          deployment: "trusted-cloud",
          keyId: KEY_ID,
          keys: privateProvider(),
        }),
    ).toThrow(TrustedHiddenUpdateSignatureError);
    expect(
      () =>
        new CloudBackedHiddenCatalogOutcomeUpdateVerifier({
          deployment: "trusted-cloud",
          keys: publicProvider(),
          trustedKeyIds: [KEY_ID],
        }),
    ).toThrow(TrustedHiddenUpdateSignatureError);
  });
});
