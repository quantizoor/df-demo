import { generateKeyPairSync } from "node:crypto";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  MountedVolumeAtomicExperimentJournalStateStore,
} from "../../src/cloud/mounted-volume-experiment-journal.js";
import {
  MountedVolumeOptimizationCoordinationPorts,
} from "../../src/cloud/mounted-volume-optimization-coordination.js";
import {
  ProductionTrustedCloudRuntimeFactory,
  ProductionTrustedCloudRuntimeFactoryError,
  type ProductionRuntimeFactoryDependencyAttestation,
  type ProductionTrustedCloudRuntimeFactoryOptions,
} from "../../src/cloud/production-optimize-runtime-factory.js";
import type {
  ProductionOptimizeBootstrapOrReconstructReceipt,
  ProductionOptimizeLifecycleRegistrar,
  ProductionOptimizeRuntimeFactoryInput,
  TrustedProductionOptimizeCloseable,
} from "../../src/cloud/production-optimize-composition-owner.js";
import type {
  CloudSandboxProvider,
  TrustedCloudArtifactRef,
} from "../../src/cloud/types.js";
import type {
  RepositoryRegistration,
} from "../../src/harness/repository.js";
import {
  PRODUCTION_RUNTIME_PORT_IDS,
  productionRuntimePortBindingsHash,
  type ProductionCompositionVerification,
  type ProductionOptimizationCompositionManifest,
  type ProductionRuntimeComponentManifest,
  type ProductionRuntimeRole,
} from "../../src/orchestrator/production-runtime.js";
import {
  canonicalHash,
  canonicalJson,
} from "../../src/schemas/canonical.js";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const PLUGIN_HASH = "b".repeat(64);
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}` as const;
const keys = generateKeyPairSync("ed25519");
const releaseInspectionPolicyBody = {
  schemaVersion: 1 as const,
  domain:
    "dark-factory.optimizer-release-artifact-inspection-policy.v1" as const,
  evaluatorPolicyHash: "7".repeat(64),
  allowedReleasePaths: ["release.json"] as readonly string[],
  forbiddenContentFingerprints: [] as readonly string[],
  graderCanaryFingerprints: ["0".repeat(64)] as readonly string[],
};
const releaseInspectionPolicy = {
  ...releaseInspectionPolicyBody,
  policyHash: canonicalHash(releaseInspectionPolicyBody),
};

const unreachable = async (
  ..._arguments: unknown[]
): Promise<never> => {
  throw new Error("Fixture authority must not be invoked.");
};

afterEach(() => {
  vi.restoreAllMocks();
});

function artifact(
  name: string,
  sha256: string,
  mediaType: string,
  byteLength = 4_096,
): TrustedCloudArtifactRef {
  return {
    uri: `trusted://runtime-factory/${name}`,
    sha256,
    mediaType,
    byteLength,
  };
}

function component(
  role: ProductionRuntimeRole,
): ProductionRuntimeComponentManifest {
  return {
    role,
    boundary: "trusted-cloud",
    componentId: `df-${role}`,
    imageReference:
      `ghcr.io/parallaxai/df-${role}@${IMAGE_DIGEST}`,
    imageDigest: IMAGE_DIGEST,
    sourceArtifactHash: "d".repeat(64),
    configurationHash: "e".repeat(64),
  };
}

function manifest(): ProductionOptimizationCompositionManifest {
  const runtimePortAttestations =
    PRODUCTION_RUNTIME_PORT_IDS.map((portId) => ({
      portId,
      attestationSha256: canonicalHash({
        domain: "test.production-runtime-port.v1",
        portId,
      }),
    }));
  const unsigned = {
    schemaVersion: 1 as const,
    domain:
      "dark-factory.production-optimization-composition.v1" as const,
    manifestId: "production-001",
    campaignId: "campaign-001",
    lineageId: "lineage-001",
    protocolHash: "f".repeat(64),
    deployment: "trusted-cloud" as const,
    components: {
      control: component("control"),
      optimizer: component("optimizer"),
      build: component("build"),
      evaluator: component("evaluator"),
    },
    runtimePortAttestations,
    bindings: {
      harnessRegistrationHash: "0".repeat(64),
      campaignGenesisHash: "1".repeat(64),
      hiddenCatalogGenesisHash: "2".repeat(64),
      providerReadinessHash: "3".repeat(64),
      volumeSemanticsHash: "4".repeat(64),
      optimizerPluginBundleHash: PLUGIN_HASH,
      correctnessPolicyHash: "5".repeat(64),
      brokerPolicyHash: "6".repeat(64),
      evaluatorPolicyHash: "7".repeat(64),
      journalPolicyHash: "8".repeat(64),
    },
    informationBoundary: {
      containsTaskIdentities: false as const,
      containsPanelIdentities: false as const,
      containsCellIdentities: false as const,
      containsRawEvidence: false as const,
      optimizerHasBenchmarkCredentials: false as const,
      optimizerCanReachEvaluator: false as const,
    },
    maximumExperimentsPerInvocation: 3,
    issuedAt: "2026-07-26T11:00:00.000Z",
    expiresAt: "2026-07-26T13:00:00.000Z",
  };
  return {
    ...unsigned,
    manifestHash: canonicalHash(unsigned),
    signature: {
      algorithm: "ed25519",
      keyId: "production-key",
      signedAt: "2026-07-26T11:00:01.000Z",
      signature: "A".repeat(86),
    },
  };
}

function replaceManifest(
  value: ProductionOptimizationCompositionManifest,
  replacements: {
    readonly components?: ProductionOptimizationCompositionManifest["components"];
    readonly runtimePortAttestations?:
      ProductionOptimizationCompositionManifest["runtimePortAttestations"];
  },
): ProductionOptimizationCompositionManifest {
  const unsigned = {
    schemaVersion: value.schemaVersion,
    domain: value.domain,
    manifestId: value.manifestId,
    campaignId: value.campaignId,
    lineageId: value.lineageId,
    protocolHash: value.protocolHash,
    deployment: value.deployment,
    components:
      replacements.components ?? value.components,
    runtimePortAttestations:
      replacements.runtimePortAttestations ??
      value.runtimePortAttestations,
    bindings: value.bindings,
    informationBoundary: value.informationBoundary,
    maximumExperimentsPerInvocation:
      value.maximumExperimentsPerInvocation,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  };
  return {
    ...unsigned,
    manifestHash: canonicalHash(unsigned),
    signature: value.signature,
  };
}

function dependencyAttestation(
  value: ProductionOptimizationCompositionManifest,
): ProductionRuntimeFactoryDependencyAttestation {
  const unsigned = {
    schemaVersion: 1 as const,
    domain:
      "dark-factory.production-runtime-factory-dependencies.v1" as const,
    boundary:
      "trusted-cloud-production-runtime-dependency-attestation" as const,
    manifestHash: value.manifestHash,
    componentManifestHashes: {
      control: canonicalHash(value.components.control),
      optimizer: canonicalHash(value.components.optimizer),
      build: canonicalHash(value.components.build),
      evaluator: canonicalHash(value.components.evaluator),
    },
    operationalBindingsHash: canonicalHash(value.bindings),
    runtimePortBindingsHash: productionRuntimePortBindingsHash(
      value.runtimePortAttestations,
    ),
    runtimePortAttestations: value.runtimePortAttestations,
    containsTaskIdentifiers: false as const,
  };
  return {
    ...unsigned,
    attestationHash: canonicalHash(unsigned),
  };
}

function registration(): RepositoryRegistration {
  return {
    registrationId: "9".repeat(64),
    canonicalPath: "/trusted/source/pi",
    branch: "main",
    headCommit: "a".repeat(40),
    treeSha: "b".repeat(40),
    lockSha256: "c".repeat(64),
    upstreamBaseCommit: "d".repeat(40),
    originFingerprint: {
      transport: "ssh",
      hostHash: "e".repeat(64),
      repositoryHash: "f".repeat(64),
    },
    upstreamFingerprint: {
      transport: "https",
      hostHash: "0".repeat(64),
      repositoryHash: "1".repeat(64),
    },
    originVerification: {
      private: true,
      fetchable: true,
      writable: true,
      checkedAt: "2026-07-26T10:00:00.000Z",
      providerAttestationHash: "2".repeat(64),
    },
    upstreamVerification: {
      fetchable: true,
      upstreamHeadCommit: "3".repeat(40),
      mergeBaseCommit: "d".repeat(40),
      checkedAt: "2026-07-26T10:00:00.000Z",
      providerAttestationHash: "4".repeat(64),
    },
  };
}

function provider(): CloudSandboxProvider {
  return {
    name: "daytona",
    configuration: {
      provider: "daytona",
      endpoint: "https://app.daytona.io/api",
      credentialEnvironmentNames: ["DAYTONA_API_KEY"],
      configFingerprint: "5".repeat(64),
    },
    probe: unreachable,
    create: unreachable,
    execute: unreachable,
    upload: unreachable,
    download: unreachable,
    cancel: unreachable,
    destroy: unreachable,
  };
}

function options(
  signedManifest: ProductionOptimizationCompositionManifest,
): ProductionTrustedCloudRuntimeFactoryOptions {
  const cloudRuntime = {
    assertTrustedCloudRuntime: vi.fn(),
  };
  return {
    attestation: dependencyAttestation(signedManifest),
    attestationAuthority: {
      boundary:
        "trusted-cloud-production-runtime-dependency-attestation-authority",
      verify: async (input) => ({
        schemaVersion: 1,
        domain:
          "dark-factory.production-runtime-factory-dependency-verification.v1",
        attestationHash: input.attestation.attestationHash,
        manifestHash: input.manifestHash,
        compositionVerifierAttestationHash:
          input.compositionVerifierAttestationHash,
        verified: true,
        authorityAttestationHash: "e".repeat(64),
      }),
    },
    durableState: {
      volumeRoot: "/trusted/dark-factory",
      storeId: signedManifest.campaignId,
      controllerInstanceIdHash: "6".repeat(64),
      runtimeGuard: cloudRuntime,
      semanticsGuard: {
        assertLinearizableStateVolume: vi.fn(),
      },
      now: () => NOW,
      nonceFactory: () => "0123456789abcdef0123456789abcdef",
    },
    campaignState: {
      ledgerTransitionVerifier: {
        verify: async () => {},
      },
      decisionAttestationVerifier: {
        verify: async () => {},
      },
      controlAttestationVerifier: {
        verify: async () => {},
      },
    },
    coordination: {
      diagnosticResolver: {
        boundary: "trusted-cloud",
        resolve: unreachable,
      },
      resumeAuthority: {
        boundary: "trusted-cloud-attestation-authority",
        verifyAndAttest: unreachable,
      },
      interruptionAuthority: {
        boundary: "trusted-cloud-attestation-authority",
        attestBrokerExposure: unreachable,
        authorizeControl: unreachable,
      },
    },
    completion: {
      onlineErrorAuthority: {
        boundary: "trusted-cloud-online-error-authority",
        reserve: unreachable,
        reconcile: unreachable,
      },
      operationLedgerUsage: {
        boundary: "trusted-cloud",
        closeAndRead: unreachable,
      },
      accountingAuthority: {
        boundary: "trusted-cloud",
        attestCompletion: unreachable,
        attestInterruption: unreachable,
      },
      sealAuthority: {
        boundary: "trusted-cloud",
        authorize: unreachable,
      },
    },
    journal: {
      experimentStore: {
        trustedLeakScanner: {
          keyId: "journal-leak-key",
          publicKey: keys.publicKey,
        },
        maximumLeakScanReceiptAgeMs: 300_000,
        maximumLeakScanClockSkewMs: 30_000,
      },
      artifactAssembler: {
        policyProvider: {
          provide: unreachable,
        },
        provenanceProvider: {
          provide: unreachable,
        },
        taskIdentityExclusionAuthority: {
          assertTaskFree: unreachable,
        },
      },
      sealAuthority: {
        scanner: {
          boundary: "trusted-cloud-deterministic-leak-scanner",
          scan: unreachable,
        },
        keyAuthority: {
          boundary: "trusted-cloud-leak-scan-key",
          keyId: "journal-leak-key",
          signLeakScanReceipt: unreachable,
        },
        scannerPublicKey: keys.publicKey,
        pinnedVersions: {
          resolve: unreachable,
        },
      },
    },
    optimizer: {
      session: {
        provider: provider(),
        sandbox: {
          imageReference:
            signedManifest.components.optimizer.imageReference,
          imageDigest:
            signedManifest.components.optimizer.imageDigest,
          regionClass: "eu-standard",
          resources: {
            architecture: "x86_64",
            cpuCores: 4,
            memoryMiB: 8_192,
            diskMiB: 32_000,
          },
          networkAllowDomains: [
            "github.com",
            "api.anthropic.com",
          ],
          lifetimeMs: 3_600_000,
        },
        workerArtifact: artifact(
          "optimizer-worker",
          "7".repeat(64),
          "text/javascript",
        ),
        pluginArtifact: artifact(
          "optimizer-plugin",
          PLUGIN_HASH,
          "application/x-tar",
        ),
        artifactReader: {
          readUtf8: unreachable,
        },
        claude: {
          claudeExecutable: "/usr/local/bin/claude",
          model: "claude-opus-4-8",
          effort: "high",
          maximumBudgetUsd: 25,
          maximumTurns: 40,
          timeoutMs: 600_000,
        },
        optimizerSecretReferences: [
          {
            sourceEnvironmentName: "DF_ANTHROPIC_API_KEY",
            targetEnvironmentName: "ANTHROPIC_API_KEY",
          },
        ],
      },
      resolver: {
        registration: registration(),
        sourceOnlyBootstrapMetadataArtifact: artifact(
          "bootstrap-metadata",
          "8".repeat(64),
          "application/json",
        ),
        evidenceSource: {
          boundary: "trusted-cloud",
          locate: async () => undefined,
        },
        artifactReader: {
          boundary: "trusted-cloud",
          readUtf8: unreachable,
        },
        releaseArtifactReader: {
          boundary:
            "trusted-cloud-optimizer-release-artifact-reader",
          readBytes: unreachable,
        },
        releaseArtifactInspectionPolicy:
          releaseInspectionPolicy,
        keyAuthority: {
          boundary:
            "trusted-cloud-optimizer-resolver-public-key-authority",
          resolve: async () => undefined,
        },
        authoritySetHash: "9".repeat(64),
        verificationKeySetHash: "a".repeat(64),
      },
    },
    correctness: {
      recordStore: {
        candidateBuildVerifier: {
          trustedKeyId: "build-key",
          publicKey: keys.publicKey,
        },
        gitPublicationVerifier: {
          trustedKeyId: "publication-key",
          publicKey: keys.publicKey,
        },
        gitSourceVerifier: {
          trustedKeyId: "source-key",
          publicKey: keys.publicKey,
        },
      },
      sourceIndex: {
        sourceReceiptVerifier: {
          trustedKeyId: "source-key",
          publicKey: keys.publicKey,
        },
        attestationAuthority: {
          boundary: "trusted-cloud",
          attest: unreachable,
        },
      },
      scanner: {
        boundary: "trusted-cloud",
        scan: unreachable,
      },
      builder: {
        boundary: "trusted-cloud",
        build: unreachable,
      },
      publisher: {
        boundary: "trusted-cloud",
        publish: unreachable,
      },
      snapshotter: {
        boundary: "trusted-cloud",
        snapshot: unreachable,
      },
      integrityPolicyHash: "b".repeat(64),
      buildPolicyHash: "c".repeat(64),
    },
    broker: {
      configuration: {
        source: {
          boundary: "trusted-cloud",
          locate: async () => undefined,
        },
        reader: {
          readUtf8: unreachable,
        },
      },
      harness: {
        keyring: {
          getVerificationKey: async () => keys.publicKey,
        },
        trustedKeyIds: ["source-key"],
        registrationId: "9".repeat(64),
        originRepositoryHash: "f".repeat(64),
      },
      release: {
        service: {
          boundary: "trusted-cloud-evaluator-service",
          evaluate: unreachable,
        },
        source: {
          boundary: "trusted-cloud",
          locate: async () => undefined,
        },
        reader: {
          boundary: "trusted-cloud",
          readUtf8: unreachable,
        },
        signatureVerifier: {
          boundary:
            "trusted-cloud-evaluation-release-signature-verifier",
          verify: unreachable,
        },
      },
      signatureVerifier: {
        verify: async () => true,
      },
    },
    operationalBindings: {
      providerReadinessHash:
        signedManifest.bindings.providerReadinessHash,
      volumeSemanticsHash:
        signedManifest.bindings.volumeSemanticsHash,
      correctnessPolicyHash:
        signedManifest.bindings.correctnessPolicyHash,
      brokerPolicyHash:
        signedManifest.bindings.brokerPolicyHash,
      evaluatorPolicyHash:
        signedManifest.bindings.evaluatorPolicyHash,
      journalPolicyHash:
        signedManifest.bindings.journalPolicyHash,
    },
    now: () => NOW,
  };
}

function verification(
  value: ProductionOptimizationCompositionManifest,
): ProductionCompositionVerification {
  return {
    schemaVersion: 1,
    domain:
      "dark-factory.production-composition-verification.v1",
    manifestHash: value.manifestHash,
    signingKeyId: value.signature.keyId,
    componentBindingsHash: canonicalHash(value.components),
    operationalBindingsHash: canonicalHash(value.bindings),
    runtimePortBindingsHash: productionRuntimePortBindingsHash(
      value.runtimePortAttestations,
    ),
    verifierAttestationHash: "d".repeat(64),
    verified: true,
  };
}

function bootstrapReceipt(
  value: ProductionOptimizationCompositionManifest,
): ProductionOptimizeBootstrapOrReconstructReceipt {
  const requestHash = canonicalHash({
    schemaVersion: 1,
    domain:
      "dark-factory.production-optimize-bootstrap-or-reconstruct-request.v1",
    manifestId: value.manifestId,
    manifestHash: value.manifestHash,
    campaignId: value.campaignId,
    lineageId: value.lineageId,
    protocolHash: value.protocolHash,
    sourcePrerequisiteHash:
      value.bindings.harnessRegistrationHash,
    genesisPrerequisiteHash:
      value.bindings.campaignGenesisHash,
    catalogPrerequisiteHash:
      value.bindings.hiddenCatalogGenesisHash,
  });
  const unsigned = {
    schemaVersion: 1 as const,
    domain:
      "dark-factory.production-optimize-bootstrap-or-reconstruct-receipt.v1" as const,
    requestHash,
    manifestHash: value.manifestHash,
    campaignId: value.campaignId,
    lineageId: value.lineageId,
    protocolHash: value.protocolHash,
    disposition: "reconstructed" as const,
    sourcePrerequisiteHash:
      value.bindings.harnessRegistrationHash,
    genesisPrerequisiteHash:
      value.bindings.campaignGenesisHash,
    catalogPrerequisiteHash:
      value.bindings.hiddenCatalogGenesisHash,
    campaignStateHash: "f".repeat(64),
    catalogStateHash: "0".repeat(64),
    prerequisitesVerified: true as const,
    idempotentlyBound: true as const,
    verifiedAt: NOW.toISOString(),
  };
  return {
    ...unsigned,
    receiptHash: canonicalHash(unsigned),
  };
}

function factoryInput(
  signedManifest: ProductionOptimizationCompositionManifest,
  register: (
    closeable: TrustedProductionOptimizeCloseable,
  ) => void = () => {},
): ProductionOptimizeRuntimeFactoryInput {
  const lifecycle: ProductionOptimizeLifecycleRegistrar = {
    boundary: "production-optimize-composition-owner",
    register,
  };
  return {
    manifest: signedManifest,
    compositionVerification: verification(signedManifest),
    bootstrapReceipt: bootstrapReceipt(signedManifest),
    lifecycle,
  };
}

describe("ProductionTrustedCloudRuntimeFactory", () => {
  it("assembles frozen, reference-equal ports in the canonical order", async () => {
    const signedManifest = manifest();
    const registered: TrustedProductionOptimizeCloseable[] = [];
    const factory = new ProductionTrustedCloudRuntimeFactory(
      options(signedManifest),
    );
    const result = await factory.create(
      factoryInput(signedManifest, (closeable) => {
        registered.push(closeable);
      }),
    );

    expect(Object.keys(result.runtimePortBindings)).toEqual([
      "campaignStore",
      "inputFactory",
      "resumeVerifier",
      "completionMaterial",
      "interruption",
      "journal",
      "optimizer",
      "gates",
      "broker",
    ]);
    expect(
      result.runtimePortBindings.campaignStore.implementation,
    ).toBe(result.components.control.campaignStore);
    expect(
      result.runtimePortBindings.inputFactory.implementation,
    ).toBe(result.components.control.inputFactory);
    expect(
      result.runtimePortBindings.resumeVerifier.implementation,
    ).toBe(result.components.control.resumeVerifier);
    expect(
      result.runtimePortBindings.completionMaterial
        .implementation,
    ).toBe(result.components.control.completionMaterial);
    expect(
      result.runtimePortBindings.interruption.implementation,
    ).toBe(result.components.control.interruption);
    expect(
      result.runtimePortBindings.journal.implementation,
    ).toBe(result.components.control.journal);
    expect(
      result.runtimePortBindings.optimizer.implementation,
    ).toBe(result.components.optimizer.adapter);
    expect(
      result.runtimePortBindings.gates.implementation,
    ).toBe(result.components.build.gates);
    expect(
      result.runtimePortBindings.broker.implementation,
    ).toBe(result.components.evaluator.broker);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.components)).toBe(true);
    expect(Object.isFrozen(result.runtimePortBindings)).toBe(true);
    expect(
      Reflect.set(
        result.runtimePortBindings.optimizer,
        "implementation",
        {},
      ),
    ).toBe(false);
    expect(
      result.runtimePortBindings.optimizer.implementation,
    ).toBe(result.components.optimizer.adapter);
    expect(new Set(registered.map((item) => item.lifecycleId)).size).toBe(
      registered.length,
    );
  });

  it("rejects independently detached component and port digests", async () => {
    const signedManifest = manifest();
    const detachedDigest =
      `sha256:${"f".repeat(64)}` as const;
    const componentDetached = replaceManifest(
      signedManifest,
      {
        components: {
          ...signedManifest.components,
          control: {
            ...signedManifest.components.control,
            imageReference:
              `ghcr.io/parallaxai/df-control@${detachedDigest}`,
            imageDigest: detachedDigest,
          },
        },
      },
    );
    await expect(
      new ProductionTrustedCloudRuntimeFactory(
        options(signedManifest),
      ).create(factoryInput(componentDetached)),
    ).rejects.toBeInstanceOf(
      ProductionTrustedCloudRuntimeFactoryError,
    );

    const portDetached = replaceManifest(signedManifest, {
      runtimePortAttestations:
        signedManifest.runtimePortAttestations.map(
          (entry, index) =>
            index === 0
              ? {
                  portId:
                    "control.campaign-state-store" as const,
                  attestationSha256: "f".repeat(64),
                }
              : entry,
        ),
    });
    await expect(
      new ProductionTrustedCloudRuntimeFactory(
        options(signedManifest),
      ).create(factoryInput(portDetached)),
    ).rejects.toBeInstanceOf(
      ProductionTrustedCloudRuntimeFactoryError,
    );

    const configured = options(signedManifest);
    const detachedPolicyBody = {
      ...configured.optimizer.resolver
        .releaseArtifactInspectionPolicy,
      evaluatorPolicyHash: "f".repeat(64),
    };
    const detachedPolicy = {
      ...detachedPolicyBody,
      policyHash: canonicalHash({
        schemaVersion: detachedPolicyBody.schemaVersion,
        domain: detachedPolicyBody.domain,
        evaluatorPolicyHash:
          detachedPolicyBody.evaluatorPolicyHash,
        allowedReleasePaths:
          detachedPolicyBody.allowedReleasePaths,
        forbiddenContentFingerprints:
          detachedPolicyBody.forbiddenContentFingerprints,
        graderCanaryFingerprints:
          detachedPolicyBody.graderCanaryFingerprints,
      }),
    };
    await expect(
      new ProductionTrustedCloudRuntimeFactory({
        ...configured,
        optimizer: {
          ...configured.optimizer,
          resolver: {
            ...configured.optimizer.resolver,
            releaseArtifactInspectionPolicy: detachedPolicy,
          },
        },
      }).create(factoryInput(signedManifest)),
    ).rejects.toBeInstanceOf(
      ProductionTrustedCloudRuntimeFactoryError,
    );
  });

  it("captures dependencies and data before caller mutation", async () => {
    const signedManifest = manifest();
    const mutable = options(signedManifest);
    const originalGuard =
      mutable.durableState.runtimeGuard
        .assertTrustedCloudRuntime;
    const factory = new ProductionTrustedCloudRuntimeFactory(
      mutable,
    );
    (
      mutable.durableState.runtimeGuard as {
        assertTrustedCloudRuntime(): void;
      }
    ).assertTrustedCloudRuntime = () => {
      throw new Error("mutated guard");
    };
    (
      mutable.optimizer.session.pluginArtifact as unknown as {
        sha256: string;
      }
    ).sha256 = "f".repeat(64);

    await expect(
      factory.create(factoryInput(signedManifest)),
    ).resolves.toBeDefined();
    expect(originalGuard).toHaveBeenCalledTimes(1);
  });

  it("fails the cloud guard before invoking an external authority", async () => {
    const signedManifest = manifest();
    const configured = options(signedManifest);
    const verify = vi.fn(
      configured.attestationAuthority.verify,
    );
    const guarded:
      ProductionTrustedCloudRuntimeFactoryOptions = {
        ...configured,
        attestationAuthority: {
          ...configured.attestationAuthority,
          verify,
        },
        durableState: {
          ...configured.durableState,
          runtimeGuard: {
            assertTrustedCloudRuntime: () => {
              throw new Error("not a trusted cloud runtime");
            },
          },
        },
      };

    await expect(
      new ProductionTrustedCloudRuntimeFactory(
        guarded,
      ).create(factoryInput(signedManifest)),
    ).rejects.toBeInstanceOf(
      ProductionTrustedCloudRuntimeFactoryError,
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it("closes partial acquisitions and refuses duplicate lifecycle use", async () => {
    const signedManifest = manifest();
    const coordinationClose = vi
      .spyOn(
        MountedVolumeOptimizationCoordinationPorts.prototype,
        "close",
      )
      .mockResolvedValue(undefined);
    const journalStateClose = vi
      .spyOn(
        MountedVolumeAtomicExperimentJournalStateStore.prototype,
        "close",
      )
      .mockResolvedValue(undefined);
    const factory = new ProductionTrustedCloudRuntimeFactory(
      options(signedManifest),
    );
    let registrations = 0;
    await expect(
      factory.create(
        factoryInput(signedManifest, () => {
          registrations += 1;
          if (registrations === 3) {
            throw new Error("registration failure");
          }
        }),
      ),
    ).rejects.toBeInstanceOf(
      ProductionTrustedCloudRuntimeFactoryError,
    );
    expect(coordinationClose).toHaveBeenCalledTimes(1);
    expect(journalStateClose).toHaveBeenCalledTimes(1);
    await expect(
      factory.create(factoryInput(signedManifest)),
    ).rejects.toBeInstanceOf(
      ProductionTrustedCloudRuntimeFactoryError,
    );
    expect(registrations).toBe(3);
  });

  it("has no task-bearing descriptor or extensible JSON selection surface", () => {
    const signedManifest = manifest();
    const configured = options(signedManifest);
    const serialized = canonicalJson(configured.attestation);
    expect(serialized).not.toContain("hidden-task-sentinel");
    expect(Object.hasOwn(configured.attestation, "taskId")).toBe(
      false,
    );
    expect(Object.hasOwn(configured.attestation, "tasks")).toBe(
      false,
    );
    expect(
      () =>
        new ProductionTrustedCloudRuntimeFactory({
          ...configured,
          taskId: "hidden-task-sentinel",
        } as unknown as ProductionTrustedCloudRuntimeFactoryOptions),
    ).toThrow(ProductionTrustedCloudRuntimeFactoryError);
  });
});
