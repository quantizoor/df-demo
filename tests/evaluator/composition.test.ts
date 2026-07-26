import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { CloudSandboxProvider } from "../../src/cloud/types.js";
import {
  TrustedEvaluationCompositionError,
  createTrustedEvaluationService,
  type TrustedEvaluationServiceCompositionOptions,
} from "../../src/evaluator/composition.js";
import type {
  TrustedCloudEd25519PrivateKeyProvider,
  TrustedCloudEd25519PublicKeyProvider,
} from "../../src/evaluator/hidden-update-signature.js";
import type { TrustedCanonicalPolicyMaterialProvider } from "../../src/evaluator/policy-resolver.js";
import type {
  TrustedEncryptedRawArtifactSource,
  TrustedHarborRawArtifactDecoder,
  TrustedRawArtifactDecryptor,
} from "../../src/evaluator/raw-reader.js";
import type {
  TrustedRawDestructionReceiptVerifier,
  TrustedRawRetentionPolicy,
} from "../../src/evaluator/retention.js";
import {
  DARK_FACTORY_PI_HARBOR_IMPORT_PATH,
  createPiHarborAgentSpec,
} from "../../src/terminal-bench/pi-agent.js";
import type { TerminalBench21Pin } from "../../src/terminal-bench/pin.js";

const resultKeys = generateKeyPairSync("ed25519");
const hiddenKeys = generateKeyPairSync("ed25519");

const pin: TerminalBench21Pin = {
  benchmark: "terminal-bench-2.1",
  dataset: "terminal-bench/terminal-bench-2-1",
  registryRevision: 6,
  taskCount: 89,
  datasetContentSha256: "1".repeat(64),
  datasetManifestSha256: "2".repeat(64),
  harborVersion: "0.20.0",
  harborPackageSha256: "3".repeat(64),
  harborExecutableSha256: "4".repeat(64),
  piHarborAdapterSha256: "5".repeat(64),
};

const retentionPolicy: TrustedRawRetentionPolicy = {
  policyHash: "6".repeat(64),
  storageRoot: "trusted://raw/evaluator/",
  maximumRetentionMinutes: 60,
  destruction: "crypto-shred",
  encryptionRequired: true,
  localExportAllowed: false,
};

const destructionVerifierKeys = generateKeyPairSync("ed25519");
const destructionReceiptVerifier: TrustedRawDestructionReceiptVerifier = {
  trustedKeyId: "raw-destruction-key-1",
  publicKey: destructionVerifierKeys.publicKey,
};

function unavailable(): Promise<never> {
  return Promise.reject(new Error("not executed by composition test"));
}

function provider(): CloudSandboxProvider {
  return {
    name: "daytona",
    configuration: {
      provider: "daytona",
      endpoint: "https://cloud.example.test",
      credentialEnvironmentNames: ["DAYTONA_API_KEY"],
      configFingerprint: "7".repeat(64),
    },
    probe: unavailable,
    create: unavailable,
    execute: unavailable,
    upload: unavailable,
    download: unavailable,
    cancel: unavailable,
    destroy: unavailable,
  };
}

function privateKeys(): TrustedCloudEd25519PrivateKeyProvider {
  return {
    boundary: "trusted-cloud",
    resolve: (input) =>
      Promise.resolve({
        boundary: "trusted-cloud-key-material",
        algorithm: "Ed25519",
        purpose: input.purpose,
        keyId: input.keyId,
        keyVersion: "cloud-secret-v1",
        privateKey:
          input.purpose === "result-envelope"
            ? resultKeys.privateKey
            : hiddenKeys.privateKey,
      }),
  };
}

function publicKeys(): TrustedCloudEd25519PublicKeyProvider {
  return {
    boundary: "trusted-cloud",
    resolve: (input) =>
      Promise.resolve({
        boundary: "trusted-cloud-key-material",
        algorithm: "Ed25519",
        purpose: input.purpose,
        keyId: input.keyId,
        keyVersion: "cloud-secret-v1",
        publicKey:
          input.purpose === "result-envelope"
            ? resultKeys.publicKey
            : hiddenKeys.publicKey,
      }),
  };
}

function rawPorts(): {
  readonly source: TrustedEncryptedRawArtifactSource;
  readonly decryptor: TrustedRawArtifactDecryptor;
  readonly decoder: TrustedHarborRawArtifactDecoder;
} {
  return {
    source: {
      boundary: "trusted-cloud",
      read: unavailable,
    },
    decryptor: {
      boundary: "trusted-cloud",
      decrypt: unavailable,
    },
    decoder: {
      boundary: "trusted-cloud",
      decode: unavailable,
    },
  };
}

function options(): TrustedEvaluationServiceCompositionOptions {
  const policyProvider: TrustedCanonicalPolicyMaterialProvider = {
    boundary: "trusted-cloud",
    load: unavailable,
  };
  return {
    runner: {
      provider: provider(),
      pin,
      sandbox: {
        requestId: "evaluation-template",
        imageReference: `ghcr.io/example/evaluator@sha256:${"8".repeat(64)}`,
        imageDigest: `sha256:${"8".repeat(64)}`,
        regionClass: "eu-standard",
        resources: {
          architecture: "x86_64",
          cpuCores: 8,
          memoryMiB: 16_384,
          diskMiB: 100_000,
        },
        network: {
          defaultAction: "deny",
          allowDomains: ["api.model.example.test"],
        },
        lifetimeMs: 60 * 60_000,
        secretReferences: [],
      },
      harborExecutable: "/opt/harbor/bin/harbor",
      harborWorkingDirectory: "/workspace/evaluator",
      harborTimeoutMs: 60 * 60_000,
      outputPackagerNodeExecutable: "/usr/bin/node",
      outputPackagerTimeoutMs: 15 * 60_000,
      remoteUploadRoot: "/trusted/uploads/",
      remoteOutputRoot: "/trusted/results/",
      jobBuilder: { build: unavailable },
      runtimeVerifier: { verify: unavailable },
    },
    retentionPolicy,
    destructionReceiptVerifier,
    agent: createPiHarborAgentSpec({
      adapterImportPath: DARK_FACTORY_PI_HARBOR_IMPORT_PATH,
      adapterSha256: pin.piHarborAdapterSha256,
      provider: "openai",
      modelId: "evaluated-model",
      thinkingLevel: "high",
      enabledTools: ["read", "write", "bash"],
      timeoutMs: 60 * 60_000,
    }),
    stores: {
      boundary: "trusted-cloud",
      durabilityAttestationHash: "9".repeat(64),
      ledger: {
        claim: unavailable,
        inspect: unavailable,
        bindDispositionAttestation: unavailable,
        complete: unavailable,
        consumeFailure: unavailable,
      },
      panels: { allocateAndConsume: unavailable },
      rawIngress: {
        persist: unavailable,
        discard: unavailable,
      },
      custodian: { destroy: unavailable },
      hiddenOutcomeSink: { commit: unavailable },
      onlineErrorAuthority: {
        boundary: "trusted-cloud-online-error-authority",
        reserve: unavailable,
        reconcile: unavailable,
      },
      behavioralPreparations: {
        boundary: "trusted-cloud",
        prepare: unavailable,
        resolve: unavailable,
        finalize: unavailable,
        abandon: unavailable,
        consume: unavailable,
      },
    },
    raw: rawPorts(),
    policyProvider,
    hiddenOutcomeSigning: {
      keyId: "hidden-update-key-1",
      trustedKeyIds: ["hidden-update-key-1"],
      privateKeys: privateKeys(),
      publicKeys: publicKeys(),
    },
    resultEnvelopeSigning: {
      keyId: "result-envelope-key-1",
      trustedKeyIds: ["result-envelope-key-1"],
      privateKeys: privateKeys(),
      publicKeys: publicKeys(),
    },
    behavioralReleaseStore: {
      boundary: "trusted-cloud",
      load: unavailable,
      resolveByContentHash: unavailable,
      inspectCommit: unavailable,
      commit: unavailable,
      orphan: unavailable,
    },
    behavioralReleaseSigning: {
      keyId: "behavioral-release-key-1",
      trustedKeyIds: ["behavioral-release-key-1"],
      privateKeys: privateKeys(),
      publicKeys: publicKeys(),
    },
    now: () => new Date("2026-07-01T00:00:00.000Z"),
  };
}

describe("production trusted evaluation service composition", () => {
  it("constructs one release-only service around runner, deriver, destruction, and broker signing", async () => {
    const service = await createTrustedEvaluationService(options());
    expect(service.boundary).toBe("trusted-cloud-evaluator-service");
    expect(Object.keys(service)).toEqual(["boundary"]);
  });

  it("rejects a test-only in-memory raw port before resolving signing keys", async () => {
    const value = options();
    const testOnlySource: TrustedEncryptedRawArtifactSource = {
      boundary: "test-only-in-memory",
      read: unavailable,
    };
    await expect(
      createTrustedEvaluationService({
        ...value,
        raw: {
          ...value.raw,
          source: testOnlySource,
        },
      }),
    ).rejects.toBeInstanceOf(TrustedEvaluationCompositionError);
  });

  it("rejects a process-local behavioral preparation store", async () => {
    const value = options();
    await expect(
      createTrustedEvaluationService({
        ...value,
        stores: {
          ...value.stores,
          behavioralPreparations: {
            ...value.stores.behavioralPreparations,
            boundary: "test-only-in-memory",
          },
        },
      }),
    ).rejects.toBeInstanceOf(TrustedEvaluationCompositionError);
  });

  it("rejects a preparation store without durable abandonment", async () => {
    const value = options();
    const behavioralPreparations = {
      ...value.stores.behavioralPreparations,
      abandon: undefined,
    } as unknown as typeof value.stores.behavioralPreparations;
    await expect(
      createTrustedEvaluationService({
        ...value,
        stores: {
          ...value.stores,
          behavioralPreparations,
        },
      }),
    ).rejects.toBeInstanceOf(TrustedEvaluationCompositionError);
  });

  it("rejects a composition whose signing key is not in its verification keyring", async () => {
    const value = options();
    await expect(
      createTrustedEvaluationService({
        ...value,
        resultEnvelopeSigning: {
          ...value.resultEnvelopeSigning,
          trustedKeyIds: ["another-result-key"],
        },
      }),
    ).rejects.toBeInstanceOf(TrustedEvaluationCompositionError);
  });

  it("rejects a one-use ledger without exact completion inspection", async () => {
    const value = options();
    const ledger = {
      ...value.stores.ledger,
      inspect: undefined,
    } as unknown as typeof value.stores.ledger;
    await expect(
      createTrustedEvaluationService({
        ...value,
        stores: {
          ...value.stores,
          ledger,
        },
      }),
    ).rejects.toBeInstanceOf(TrustedEvaluationCompositionError);
  });
});
