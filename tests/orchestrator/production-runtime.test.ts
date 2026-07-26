import { describe, expect, it, vi } from "vitest";

import type { OptimizationCampaignStateStore } from "../../src/orchestrator/campaign-state-coordinator.js";
import {
  type ComposeProductionOptimizationRuntimeOptions,
  composeProductionOptimizationRuntime,
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
      campaignGenesisHash: HASH,
      hiddenCatalogGenesisHash: HASH,
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

function options(
  overrides: {
    readonly manifest?: ProductionOptimizationCompositionManifest;
    readonly verifierBoundary?: string;
    readonly optimizerBoundary?: string;
    readonly optimizerManifestBindingHash?: string;
    readonly verifierRuntimePortBindingsHash?: string;
  } = {},
): {
  readonly value: ComposeProductionOptimizationRuntimeOptions;
  readonly verify: ReturnType<typeof vi.fn>;
  readonly propose: ReturnType<typeof vi.fn>;
} {
  const signedManifest = overrides.manifest ?? manifest();
  const current = holdoutExhaustedState();
  const verify = vi.fn(
    async (
      _manifest: ProductionOptimizationCompositionManifest,
      runtimePorts: readonly ProductionRuntimePortAttestationCommitment[],
    ) => ({
      schemaVersion: 1 as const,
      domain: "dark-factory.production-composition-verification.v1" as const,
      manifestHash: signedManifest.manifestHash,
      signingKeyId: signedManifest.signature.keyId,
      componentBindingsHash: canonicalHash(signedManifest.components),
      operationalBindingsHash: canonicalHash(signedManifest.bindings),
      runtimePortBindingsHash:
        overrides.verifierRuntimePortBindingsHash ??
        productionRuntimePortBindingsHash(runtimePorts),
      verifierAttestationHash: VERIFIER_HASH,
      verified: true as const,
    }),
  );
  const propose = vi.fn(async () => {
    throw new Error("A holdout-exhausted campaign must not invoke the optimizer.");
  });
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
  const binding = (role: ProductionRuntimeRole) => canonicalHash(signedManifest.components[role]);
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
    propose,
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
      boundary: overrides.optimizerBoundary ?? "trusted-cloud",
      role: "optimizer",
      manifestBindingHash: overrides.optimizerManifestBindingHash ?? binding("optimizer"),
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
    if (commitment === undefined) {
      throw new Error("Invalid test runtime-port commitment.");
    }
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
  const value = {
    manifest: signedManifest,
    verifier: {
      boundary: overrides.verifierBoundary ?? "trusted-cloud-attestation-verifier",
      verify,
    },
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
    now: () => new Date(NOW),
  } as unknown as ComposeProductionOptimizationRuntimeOptions;
  return { value, verify, propose };
}

describe("production optimization runtime composition", () => {
  it("verifies the sealed task-free composition and exposes only status/run", async () => {
    const fixture = options();
    const runtime = await composeProductionOptimizationRuntime(fixture.value);
    const referenceEqualRuntimePorts = [
      [
        fixture.value.runtimePortBindings.campaignStore.implementation,
        fixture.value.components.control.campaignStore,
      ],
      [
        fixture.value.runtimePortBindings.inputFactory.implementation,
        fixture.value.components.control.inputFactory,
      ],
      [
        fixture.value.runtimePortBindings.resumeVerifier.implementation,
        fixture.value.components.control.resumeVerifier,
      ],
      [
        fixture.value.runtimePortBindings.completionMaterial.implementation,
        fixture.value.components.control.completionMaterial,
      ],
      [
        fixture.value.runtimePortBindings.interruption.implementation,
        fixture.value.components.control.interruption,
      ],
      [
        fixture.value.runtimePortBindings.journal.implementation,
        fixture.value.components.control.journal,
      ],
      [
        fixture.value.runtimePortBindings.optimizer.implementation,
        fixture.value.components.optimizer.adapter,
      ],
      [
        fixture.value.runtimePortBindings.gates.implementation,
        fixture.value.components.build.gates,
      ],
      [
        fixture.value.runtimePortBindings.broker.implementation,
        fixture.value.components.evaluator.broker,
      ],
    ] as const;
    for (const [attested, wired] of referenceEqualRuntimePorts) {
      expect(attested).toBe(wired);
    }
    const initialVerificationCall = fixture.verify.mock.calls[0];
    if (initialVerificationCall === undefined) {
      throw new Error("Expected composition to verify the runtime manifest.");
    }
    expect(initialVerificationCall).toHaveLength(2);
    expect(initialVerificationCall[1]).toEqual(fixture.value.manifest.runtimePortAttestations);
    expect(
      (initialVerificationCall[1] as readonly object[]).map((commitment) =>
        Object.keys(commitment).sort(),
      ),
    ).toEqual(PRODUCTION_RUNTIME_PORT_IDS.map(() => ["attestationSha256", "portId"]));
    expect(JSON.stringify(initialVerificationCall)).not.toContain("implementation");
    Object.assign(fixture.value.verifier, {
      verify: vi.fn(async () => {
        throw new Error("mutated verifier");
      }),
    });
    Object.assign(fixture.value.components.control.campaignStore, {
      reconstruct: vi.fn(async () => {
        throw new Error("mutated store");
      }),
    });

    expect(Object.keys(runtime).sort()).toEqual([]);
    await expect(runtime.status()).resolves.toMatchObject({
      manifestId: "production-001",
      manifestHash: fixture.value.manifest.manifestHash,
      verifierAttestationHash: VERIFIER_HASH,
      snapshot: {
        campaignId: "campaign-001",
        lineageId: "lineage-001",
        protocolHash: "b".repeat(64),
        freshValidationPanelsRemaining: 0,
      },
    });
    await expect(runtime.run()).resolves.toMatchObject({
      manifestId: "production-001",
      manifestHash: fixture.value.manifest.manifestHash,
      loop: {
        terminalReason: "holdout-exhausted",
        experimentsCompleted: 0,
      },
    });
    expect(fixture.verify).toHaveBeenCalledTimes(3);
    expect(fixture.propose).not.toHaveBeenCalled();
  });

  it("rejects undeclared task-bearing fields before attestation", async () => {
    const signedManifest = manifest();
    const taskBearing = {
      ...signedManifest,
      taskIds: ["hidden-task"],
    } as unknown as ProductionOptimizationCompositionManifest;
    const fixture = options({
      manifest: taskBearing,
    });
    await expect(composeProductionOptimizationRuntime(fixture.value)).rejects.toThrow(
      /failed closed/u,
    );
    expect(fixture.verify).not.toHaveBeenCalled();
  });

  it("requires the exact fixed runtime-port order inside the signed manifest", async () => {
    const signedManifest = manifest();
    const { manifestHash: _manifestHash, signature, ...unsigned } = signedManifest;
    const reorderedUnsigned = {
      ...unsigned,
      runtimePortAttestations: [...signedManifest.runtimePortAttestations].reverse(),
    };
    const reordered = {
      ...reorderedUnsigned,
      manifestHash: canonicalHash(reorderedUnsigned),
      signature,
    } as ProductionOptimizationCompositionManifest;
    const fixture = options({ manifest: reordered });

    await expect(composeProductionOptimizationRuntime(fixture.value)).rejects.toThrow(
      /failed closed/u,
    );
    expect(fixture.verify).not.toHaveBeenCalled();
  });

  it("rejects absent or plain runtime ports before independent verification", async () => {
    const absent = options();
    const withoutBindings = {
      ...absent.value,
      runtimePortBindings: undefined,
    } as unknown as ComposeProductionOptimizationRuntimeOptions;
    await expect(composeProductionOptimizationRuntime(withoutBindings)).rejects.toThrow(
      /failed closed/u,
    );
    expect(absent.verify).not.toHaveBeenCalled();

    const plain = options();
    const components = plain.value.components;
    const withPlainPorts = {
      ...plain.value,
      runtimePortBindings: {
        campaignStore: components.control.campaignStore,
        inputFactory: components.control.inputFactory,
        resumeVerifier: components.control.resumeVerifier,
        completionMaterial: components.control.completionMaterial,
        interruption: components.control.interruption,
        journal: components.control.journal,
        optimizer: components.optimizer.adapter,
        gates: components.build.gates,
        broker: components.evaluator.broker,
      },
    } as unknown as ComposeProductionOptimizationRuntimeOptions;
    await expect(composeProductionOptimizationRuntime(withPlainPorts)).rejects.toThrow(
      /failed closed/u,
    );
    expect(plain.verify).not.toHaveBeenCalled();
  });

  it("rejects detached implementations and mutated port attestations", async () => {
    const detached = options();
    Object.assign(detached.value.runtimePortBindings.optimizer, {
      implementation: {
        propose: vi.fn(),
        analyze: vi.fn(),
      },
    });
    await expect(composeProductionOptimizationRuntime(detached.value)).rejects.toThrow(
      /failed closed/u,
    );
    expect(detached.verify).not.toHaveBeenCalled();

    const mutated = options();
    Object.assign(mutated.value.runtimePortBindings.optimizer, {
      attestationSha256: "f".repeat(64),
    });
    await expect(composeProductionOptimizationRuntime(mutated.value)).rejects.toThrow(
      /failed closed/u,
    );
    expect(mutated.verify).not.toHaveBeenCalled();
  });

  it("requires the independent receipt to reproduce the runtime-port commitment", async () => {
    const fixture = options({
      verifierRuntimePortBindingsHash: "f".repeat(64),
    });

    await expect(composeProductionOptimizationRuntime(fixture.value)).rejects.toThrow(
      /failed closed/u,
    );
    expect(fixture.verify).toHaveBeenCalledOnce();
  });

  it("rejects stale hashes, untrusted roles, and detached role bindings", async () => {
    const stale = manifest();
    const staleFixture = options({
      manifest: { ...stale, maximumExperimentsPerInvocation: 4 },
    });
    await expect(composeProductionOptimizationRuntime(staleFixture.value)).rejects.toThrow(
      /failed closed/u,
    );

    const untrusted = options({ optimizerBoundary: "local" });
    await expect(composeProductionOptimizationRuntime(untrusted.value)).rejects.toThrow(
      /failed closed/u,
    );

    const detached = options({
      optimizerManifestBindingHash: "f".repeat(64),
    });
    await expect(composeProductionOptimizationRuntime(detached.value)).rejects.toThrow(
      /failed closed/u,
    );
  });
});
