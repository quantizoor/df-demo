import { describe, expect, it, vi } from "vitest";

import {
  type ProductionOptimizeBootstrapOrReconstructReceipt,
  type ProductionOptimizeBootstrapOrReconstructRequest,
  ProductionOptimizeCompositionOwner,
  type ProductionOptimizeLifecycleRegistrar,
  type ProductionOptimizeRuntimeAssembly,
  type ProductionOptimizeRuntimeFactoryInput,
  type TrustedProductionOptimizeCloseable,
} from "../../src/cloud/production-optimize-composition-owner.js";
import type { OptimizationCampaignStateStore } from "../../src/orchestrator/campaign-state-coordinator.js";
import {
  PRODUCTION_RUNTIME_PORT_IDS,
  type ProductionOptimizationCompositionManifest,
  type ProductionRuntimeComponentManifest,
  type ProductionRuntimePortAttestationCommitment,
  type ProductionRuntimeRole,
  productionRuntimePortBindingsHash,
} from "../../src/orchestrator/production-runtime.js";
import { canonicalHash, withContentHash } from "../../src/schemas/canonical.js";
import type { CampaignState } from "../../src/schemas/control.js";
import { initialCampaignStateFixture } from "../campaign/fixtures.js";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const HASH = "a".repeat(64);
const OCI_DIGEST = `sha256:${"b".repeat(64)}` as const;
const VERIFIER_HASH = "c".repeat(64);

interface FixtureOverrides {
  readonly bootstrap?: (
    request: ProductionOptimizeBootstrapOrReconstructRequest,
    lifecycle: ProductionOptimizeLifecycleRegistrar,
  ) => Promise<ProductionOptimizeBootstrapOrReconstructReceipt>;
  readonly create?: (
    input: ProductionOptimizeRuntimeFactoryInput,
    assembly: ProductionOptimizeRuntimeAssembly,
  ) => Promise<ProductionOptimizeRuntimeAssembly>;
}

function runtimePortAttestations(): readonly ProductionRuntimePortAttestationCommitment[] {
  return PRODUCTION_RUNTIME_PORT_IDS.map((portId) => ({
    portId,
    attestationSha256: canonicalHash({
      domain: "test.production-runtime-port-attestation.v1",
      portId,
    }),
  }));
}

function component(role: ProductionRuntimeRole): ProductionRuntimeComponentManifest {
  return {
    role,
    boundary: "trusted-cloud",
    componentId: `df-${role}`,
    imageReference: `ghcr.io/parallaxai/df-${role}@${OCI_DIGEST}`,
    imageDigest: OCI_DIGEST,
    sourceArtifactHash: "d".repeat(64),
    configurationHash: "e".repeat(64),
  };
}

function manifest(): ProductionOptimizationCompositionManifest {
  const unsigned = {
    schemaVersion: 1 as const,
    domain: "dark-factory.production-optimization-composition.v1" as const,
    manifestId: "production-001",
    campaignId: "campaign-001",
    lineageId: "lineage-001",
    protocolHash: "b".repeat(64),
    deployment: "trusted-cloud" as const,
    components: {
      control: component("control"),
      optimizer: component("optimizer"),
      build: component("build"),
      evaluator: component("evaluator"),
    },
    runtimePortAttestations: runtimePortAttestations(),
    bindings: {
      harnessRegistrationHash: HASH,
      campaignGenesisHash: "1".repeat(64),
      hiddenCatalogGenesisHash: "2".repeat(64),
      providerReadinessHash: HASH,
      volumeSemanticsHash: HASH,
      optimizerPluginBundleHash: HASH,
      correctnessPolicyHash: HASH,
      brokerPolicyHash: HASH,
      evaluatorPolicyHash: HASH,
      journalPolicyHash: HASH,
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
      keyId: "campaign-signing-key",
      signedAt: "2026-07-26T11:00:01.000Z",
      signature: "A".repeat(86),
    },
  };
}

function holdoutExhaustedState(): CampaignState {
  const current = initialCampaignStateFixture();
  const { contentHash: _contentHash, ...body } = current;
  return withContentHash({
    ...body,
    holdout: {
      ...current.holdout,
      freshValidationSetsRemaining: 0,
    },
  }) as unknown as CampaignState;
}

function receipt(
  request: ProductionOptimizeBootstrapOrReconstructRequest,
  overrides: Partial<Omit<ProductionOptimizeBootstrapOrReconstructReceipt, "receiptHash">> = {},
): ProductionOptimizeBootstrapOrReconstructReceipt {
  const unsigned = {
    schemaVersion: 1 as const,
    domain: "dark-factory.production-optimize-bootstrap-or-reconstruct-receipt.v1" as const,
    requestHash: request.requestHash,
    manifestHash: request.manifestHash,
    campaignId: request.campaignId,
    lineageId: request.lineageId,
    protocolHash: request.protocolHash,
    disposition: "reconstructed" as const,
    sourcePrerequisiteHash: request.sourcePrerequisiteHash,
    genesisPrerequisiteHash: request.genesisPrerequisiteHash,
    catalogPrerequisiteHash: request.catalogPrerequisiteHash,
    campaignStateHash: "3".repeat(64),
    catalogStateHash: "4".repeat(64),
    prerequisitesVerified: true as const,
    idempotentlyBound: true as const,
    verifiedAt: NOW.toISOString(),
    ...overrides,
  };
  return {
    ...unsigned,
    receiptHash: canonicalHash(unsigned),
  } as ProductionOptimizeBootstrapOrReconstructReceipt;
}

function closeable(
  lifecycleId: string,
  close: () => Promise<void>,
): TrustedProductionOptimizeCloseable {
  return {
    boundary: "trusted-cloud-production-optimize-lifecycle",
    lifecycleId,
    close,
  };
}

function runtimeAssembly(
  signedManifest: ProductionOptimizationCompositionManifest,
): ProductionOptimizeRuntimeAssembly {
  const current = holdoutExhaustedState();
  const campaignStore = {
    reconstruct: vi.fn(async () => ({
      states: [current],
      current,
    })),
    allocateExperiment: vi.fn(),
    recordBudgetUsage: vi.fn(),
    sealExperiment: vi.fn(),
    archiveInterruptedExperiment: vi.fn(),
    pause: vi.fn(),
    requestStop: vi.fn(),
    acknowledgeStopped: vi.fn(),
  } as unknown as OptimizationCampaignStateStore;
  const inputFactory = {
    boundary: "trusted-cloud",
    prepareOrResume: vi.fn(),
    bindClaim: vi.fn(),
  };
  const resumeVerifier = {
    boundary: "trusted-cloud",
    verify: vi.fn(),
  };
  const completionMaterial = {
    boundary: "trusted-cloud",
    createBudgetAccountingAttestation: vi.fn(),
    createInterruptedBudgetAccountingAttestation: vi.fn(),
    createSealMaterial: vi.fn(),
  };
  const interruption = {
    boundary: "trusted-cloud",
    begin: vi.fn(),
    findPending: vi.fn(async () => null),
    prepareControl: vi.fn(),
    markApplied: vi.fn(),
  };
  const journal = {
    create: vi.fn(),
    freezeProposal: vi.fn(),
    recordGates: vi.fn(),
    recordRepair: vi.fn(),
    recordValidation: vi.fn(),
    recordAnalysis: vi.fn(),
    updateBudget: vi.fn(),
    seal: vi.fn(),
    interrupt: vi.fn(),
  };
  const optimizer = {
    propose: vi.fn(),
    analyze: vi.fn(),
  };
  const gates = { run: vi.fn() };
  const broker = {
    prepareRepair: vi.fn(),
    runRepair: vi.fn(),
    prepareValidation: vi.fn(),
    runValidation: vi.fn(),
    consumeOrQuarantine: vi.fn(),
    releaseDiagnosticBrief: vi.fn(),
  };
  const binding = (role: ProductionRuntimeRole): string =>
    canonicalHash(signedManifest.components[role]);
  const components = {
    control: {
      boundary: "trusted-cloud",
      role: "control",
      manifestBindingHash: binding("control"),
      imageDigest: signedManifest.components.control.imageDigest,
      campaignStore,
      inputFactory,
      resumeVerifier,
      completionMaterial,
      interruption,
      journal,
    },
    optimizer: {
      boundary: "trusted-cloud",
      role: "optimizer",
      manifestBindingHash: binding("optimizer"),
      imageDigest: signedManifest.components.optimizer.imageDigest,
      adapter: optimizer,
    },
    build: {
      boundary: "trusted-cloud",
      role: "build",
      manifestBindingHash: binding("build"),
      imageDigest: signedManifest.components.build.imageDigest,
      gates,
    },
    evaluator: {
      boundary: "trusted-cloud",
      role: "evaluator",
      manifestBindingHash: binding("evaluator"),
      imageDigest: signedManifest.components.evaluator.imageDigest,
      broker,
    },
  };
  const attestation = (portId: (typeof PRODUCTION_RUNTIME_PORT_IDS)[number]): string => {
    const commitment = signedManifest.runtimePortAttestations.find(
      (item) => item.portId === portId,
    );
    if (commitment === undefined) throw new Error("Invalid fixture commitment.");
    return commitment.attestationSha256;
  };
  const runtimePortBinding = (
    portId: (typeof PRODUCTION_RUNTIME_PORT_IDS)[number],
    implementation: object,
  ) => ({
    boundary: "trusted-cloud-runtime-port-binding",
    portId,
    attestationSha256: attestation(portId),
    implementation,
  });
  return {
    components,
    runtimePortBindings: {
      campaignStore: runtimePortBinding("control.campaign-state-store", campaignStore),
      inputFactory: runtimePortBinding("control.optimization-input-factory", inputFactory),
      resumeVerifier: runtimePortBinding("control.optimization-resume-verifier", resumeVerifier),
      completionMaterial: runtimePortBinding(
        "control.optimization-completion-material",
        completionMaterial,
      ),
      interruption: runtimePortBinding("control.optimization-interruption-port", interruption),
      journal: runtimePortBinding("control.experiment-journal", journal),
      optimizer: runtimePortBinding("optimizer.adapter", optimizer),
      gates: runtimePortBinding("build.correctness-gate", gates),
      broker: runtimePortBinding("evaluator.blind-broker", broker),
    },
  } as unknown as ProductionOptimizeRuntimeAssembly;
}

function fixture(overrides: FixtureOverrides = {}) {
  const signedManifest = manifest();
  const assembly = runtimeAssembly(signedManifest);
  const verify = vi.fn(
    async (
      candidate: ProductionOptimizationCompositionManifest,
      runtimePorts: readonly ProductionRuntimePortAttestationCommitment[],
    ) => ({
      schemaVersion: 1 as const,
      domain: "dark-factory.production-composition-verification.v1" as const,
      manifestHash: candidate.manifestHash,
      signingKeyId: candidate.signature.keyId,
      componentBindingsHash: canonicalHash(candidate.components),
      operationalBindingsHash: canonicalHash(candidate.bindings),
      runtimePortBindingsHash: productionRuntimePortBindingsHash(runtimePorts),
      verifierAttestationHash: VERIFIER_HASH,
      verified: true as const,
    }),
  );
  const bootstrap = vi.fn(
    async (
      request: ProductionOptimizeBootstrapOrReconstructRequest,
      lifecycle: ProductionOptimizeLifecycleRegistrar,
    ): Promise<ProductionOptimizeBootstrapOrReconstructReceipt> => {
      if (overrides.bootstrap !== undefined) {
        return overrides.bootstrap(request, lifecycle);
      }
      return receipt(request);
    },
  );
  const create = vi.fn(
    async (
      input: ProductionOptimizeRuntimeFactoryInput,
    ): Promise<ProductionOptimizeRuntimeAssembly> => {
      if (overrides.create !== undefined) {
        return overrides.create(input, assembly);
      }
      return assembly;
    },
  );
  const owner = new ProductionOptimizeCompositionOwner({
    manifest: signedManifest,
    verifier: {
      boundary: "trusted-cloud-attestation-verifier",
      verify,
    },
    bootstrap: {
      boundary: "trusted-cloud-production-optimize-bootstrap-or-reconstruct",
      verifyBootstrapOrReconstruct: bootstrap,
    },
    runtimeFactory: {
      boundary: "trusted-cloud-production-optimize-runtime-factory",
      create,
    },
    now: () => new Date(NOW),
  });
  return {
    owner,
    signedManifest,
    verify,
    bootstrap,
    create,
  };
}

describe("production optimize composition owner", () => {
  it.each(["status", "run"] as const)(
    "validates bootstrap, invokes runtime %s, and closes in reverse order",
    async (operation) => {
      const closed: string[] = [];
      const current = fixture({
        bootstrap: async (request, lifecycle) => {
          lifecycle.register(
            closeable("bootstrap-store", async () => {
              closed.push("bootstrap-store");
            }),
          );
          return receipt(request);
        },
        create: async (input, assembly) => {
          input.lifecycle.register(
            closeable("component-store", async () => {
              closed.push("component-store");
            }),
          );
          input.lifecycle.register(
            closeable("provider-lease", async () => {
              closed.push("provider-lease");
            }),
          );
          return assembly;
        },
      });

      const result =
        operation === "status" ? await current.owner.status() : await current.owner.run();

      expect(result.domain).toBe(
        operation === "status"
          ? "dark-factory.production-optimization-runtime-status.v1"
          : "dark-factory.production-optimization-runtime-run.v1",
      );
      expect(closed).toEqual(["provider-lease", "component-store", "bootstrap-store"]);
      expect(current.verify).toHaveBeenCalledTimes(3);
      expect(current.bootstrap).toHaveBeenCalledTimes(1);
      expect(current.create).toHaveBeenCalledTimes(1);
      const request = current.bootstrap.mock.calls[0]?.[0];
      expect(request).toMatchObject({
        manifestHash: current.signedManifest.manifestHash,
        sourcePrerequisiteHash: current.signedManifest.bindings.harnessRegistrationHash,
        genesisPrerequisiteHash: current.signedManifest.bindings.campaignGenesisHash,
        catalogPrerequisiteHash: current.signedManifest.bindings.hiddenCatalogGenesisHash,
      });
      await expect(current.owner.status()).rejects.toThrow(/failed closed/u);
    },
  );

  it("rejects a detached prerequisite receipt before creating runtime ports", async () => {
    const closed: string[] = [];
    const current = fixture({
      bootstrap: async (request, lifecycle) => {
        lifecycle.register(
          closeable("bootstrap-store", async () => {
            closed.push("bootstrap-store");
          }),
        );
        return receipt(request, {
          sourcePrerequisiteHash: "f".repeat(64),
        });
      },
    });

    await expect(current.owner.run()).rejects.toThrow(/failed closed/u);
    expect(current.create).not.toHaveBeenCalled();
    expect(closed).toEqual(["bootstrap-store"]);
  });

  it("rejects bootstrap mutation of its canonical request", async () => {
    const current = fixture({
      bootstrap: async (request) => {
        Object.assign(request, {
          sourcePrerequisiteHash: "f".repeat(64),
        });
        return receipt(request);
      },
    });

    await expect(current.owner.run()).rejects.toThrow(/failed closed/u);
    expect(current.create).not.toHaveBeenCalled();
  });

  it.each(["manifest", "verification", "bootstrap-receipt"] as const)(
    "rejects runtime-factory mutation of canonical %s input",
    async (target) => {
      const current = fixture({
        create: async (input, assembly) => {
          if (target === "manifest") {
            Object.assign(input.manifest, {
              maximumExperimentsPerInvocation: 4,
            });
          } else if (target === "verification") {
            Object.assign(input.compositionVerification, {
              verifierAttestationHash: "f".repeat(64),
            });
          } else {
            Object.assign(input.bootstrapReceipt, {
              campaignStateHash: "f".repeat(64),
            });
          }
          return assembly;
        },
      });

      await expect(current.owner.run()).rejects.toThrow(/failed closed/u);
    },
  );

  it("closes every partial factory resource in reverse order on failure", async () => {
    const closed: string[] = [];
    const current = fixture({
      bootstrap: async (request, lifecycle) => {
        lifecycle.register(
          closeable("bootstrap-store", async () => {
            closed.push("bootstrap-store");
          }),
        );
        return receipt(request);
      },
      create: async (input) => {
        input.lifecycle.register(
          closeable("factory-first", async () => {
            closed.push("factory-first");
          }),
        );
        input.lifecycle.register(
          closeable("factory-second", async () => {
            closed.push("factory-second");
          }),
        );
        throw new Error("partial construction");
      },
    });

    await expect(current.owner.run()).rejects.toThrow(/failed closed/u);
    expect(closed).toEqual(["factory-second", "factory-first", "bootstrap-store"]);
  });

  it("attempts every close and fails closed when one close rejects", async () => {
    const closed: string[] = [];
    const current = fixture({
      create: async (input, assembly) => {
        input.lifecycle.register(
          closeable("close-fails", async () => {
            closed.push("close-fails");
            throw new Error("lease release failed");
          }),
        );
        input.lifecycle.register(
          closeable("close-succeeds", async () => {
            closed.push("close-succeeds");
          }),
        );
        return assembly;
      },
    });

    await expect(current.owner.status()).rejects.toThrow(/failed closed/u);
    expect(closed).toEqual(["close-succeeds", "close-fails"]);
  });

  it("prevents concurrent campaign owners and reuse of an owner", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = fixture({
      bootstrap: async (request) => {
        entered.resolve();
        await release.promise;
        return receipt(request);
      },
    });
    const running = first.owner.run();
    await entered.promise;

    const second = fixture();
    const concurrent = second.owner.status();
    release.resolve();

    await expect(concurrent).rejects.toThrow(/failed closed/u);
    expect(second.verify).not.toHaveBeenCalled();
    await expect(running).resolves.toMatchObject({
      domain: "dark-factory.production-optimization-runtime-run.v1",
    });
    await expect(first.owner.run()).rejects.toThrow(/failed closed/u);
  });
});
