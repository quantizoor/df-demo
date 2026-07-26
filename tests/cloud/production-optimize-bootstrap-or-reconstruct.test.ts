import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TrustedArtifactRuntimeGuard } from "../../src/cloud/artifact-bridge.js";
import type {
  MountedVolumeDurableStateOptions,
  MountedVolumeStateSemanticsGuard,
} from "../../src/cloud/mounted-volume-state.js";
import {
  DurableProductionOptimizeBootstrapOrReconstructPort,
  type ProductionOptimizeGenesisEnsureResult,
  type ProductionOptimizePrerequisiteKeyPurpose,
  type SignedProductionOptimizeCampaignGenesis,
  type SignedProductionOptimizeHiddenCatalogGenesis,
  type TrustedProductionOptimizeCampaignGenesisAuthority,
  type TrustedProductionOptimizeHiddenCatalogGenesisAuthority,
  type TrustedProductionOptimizePrerequisitePublicKey,
  type TrustedProductionOptimizePrerequisitePublicKeyAuthority,
  type TrustedProductionOptimizePrerequisiteSource,
} from "../../src/cloud/production-optimize-bootstrap-or-reconstruct.js";
import type {
  ProductionOptimizeBootstrapOrReconstructRequest,
  ProductionOptimizeLifecycleRegistrar,
  TrustedProductionOptimizeCloseable,
} from "../../src/cloud/production-optimize-composition-owner.js";
import { createEd25519Signature } from "../../src/evidence/signatures.js";
import {
  gitRegistrationReceiptHash,
  type TrustedGitRegistrationReceipt,
} from "../../src/harness/git-registration.js";
import { canonicalHash, withContentHash } from "../../src/schemas/canonical.js";

const NOW = "2026-07-26T12:00:00.000Z";
const VALID_FROM = "2026-07-26T00:00:00.000Z";
const VALID_UNTIL = "2026-07-27T00:00:00.000Z";
const CAMPAIGN_ID = "campaign-bootstrap-test";
const LINEAGE_ID = "lineage-bootstrap-test";
const PROTOCOL_HASH = "a".repeat(64);
const CAMPAIGN_STATE_HASH = "b".repeat(64);
const CATALOG_STATE_HASH = "c".repeat(64);

const keyPairs = {
  "production-optimize-private-pi-registration": generateKeyPairSync("ed25519"),
  "production-optimize-campaign-genesis": generateKeyPairSync("ed25519"),
  "production-optimize-hidden-catalog-genesis": generateKeyPairSync("ed25519"),
} as const;

const keyIds = {
  "production-optimize-private-pi-registration": "private-pi-registration-key-001",
  "production-optimize-campaign-genesis": "campaign-genesis-key-001",
  "production-optimize-hidden-catalog-genesis": "hidden-catalog-genesis-key-001",
} as const;

const runtimeGuard: TrustedArtifactRuntimeGuard = {
  assertTrustedCloudRuntime() {},
};

const semanticsGuard: MountedVolumeStateSemanticsGuard = {
  assertLinearizableStateVolume() {},
};

function registrationReceipt(): TrustedGitRegistrationReceipt {
  const commitSha = "1".repeat(40);
  const originRepositoryHash = "2".repeat(64);
  const upstreamBaseCommit = "3".repeat(40);
  const registrationId = createHash("sha256")
    .update(`${commitSha}:${originRepositoryHash}:${upstreamBaseCommit}`, "utf8")
    .digest("hex");
  const payload: Omit<TrustedGitRegistrationReceipt, "signature"> = {
    sensitivity: "trusted-git-registration",
    schemaVersion: 1,
    registrationRequestId: "registration-request-001",
    authorizationHash: "4".repeat(64),
    registrationId,
    originRepositoryHash,
    upstreamRepositoryHash: "5".repeat(64),
    remoteRef: "refs/heads/main",
    commitSha,
    treeSha: "6".repeat(40),
    lockSha256: "7".repeat(64),
    packageName: "@earendil-works/pi-coding-agent",
    packageVersion: "0.82.1",
    harnessRegistrationSchemaVersion: "1.2.0",
    adapterId: "harbor-pi-print-json",
    adapterExecutionMode: "print-json",
    sessionsDisabled: true,
    uncontrolledExtensionsDisabled: true,
    uncontrolledContextFilesDisabled: true,
    packageJsonSha256: "8".repeat(64),
    upstreamHeadCommit: "9".repeat(40),
    upstreamBaseCommit,
    originPrivate: true,
    originFetchable: true,
    originWritable: true,
    privacyEvidence: "github-rest-private-and-visibility",
    fetchEvidence: "authenticated-ls-remote-and-fetch",
    writeEvidence: "github-rest-permissions-push",
    lineageEvidence: "canonical-upstream-fetched-merge-base",
    providerRepositoryAttestationHash: "a".repeat(64),
    lineageAttestationHash: "b".repeat(64),
    providerVerifiedAt: "2026-07-26T11:55:00.000Z",
    provider: "daytona",
    sandboxId: "sandbox-registration-001",
    imageReference: "ghcr.io/example/control@sha256:cccc",
    imageDigest: `sha256:${"c".repeat(64)}`,
    networkPolicyHash: "d".repeat(64),
    workerSha256: "e".repeat(64),
    executionReceiptHash: "f".repeat(64),
    resultArtifactSha256: "0".repeat(64),
    attestedAt: "2026-07-26T11:57:00.000Z",
    passed: true,
  };
  return {
    ...payload,
    signature: createEd25519Signature(
      payload,
      keyPairs["production-optimize-private-pi-registration"].privateKey,
      keyIds["production-optimize-private-pi-registration"],
      "2026-07-26T11:58:00.000Z",
    ),
  };
}

function campaignGenesis(sourcePrerequisiteHash: string): SignedProductionOptimizeCampaignGenesis {
  const payload: Omit<SignedProductionOptimizeCampaignGenesis, "signature" | "contentHash"> = {
    schemaVersion: 1,
    domain: "dark-factory.production-optimize-campaign-genesis.v1",
    sensitivity: "release-safe-control",
    deployment: "trusted-cloud",
    campaignId: CAMPAIGN_ID,
    lineageId: LINEAGE_ID,
    protocolHash: PROTOCOL_HASH,
    sourcePrerequisiteHash,
    initialCampaignStateHash: CAMPAIGN_STATE_HASH,
    genesisPolicyHash: "1".repeat(64),
    issuedAt: "2026-07-26T11:00:00.000Z",
    expiresAt: "2026-07-26T13:00:00.000Z",
  };
  return withContentHash({
    ...payload,
    signature: createEd25519Signature(
      payload,
      keyPairs["production-optimize-campaign-genesis"].privateKey,
      keyIds["production-optimize-campaign-genesis"],
      "2026-07-26T11:30:00.000Z",
    ),
  });
}

function catalogGenesis(
  genesisPrerequisiteHash: string,
): SignedProductionOptimizeHiddenCatalogGenesis {
  const payload: Omit<SignedProductionOptimizeHiddenCatalogGenesis, "signature" | "contentHash"> = {
    schemaVersion: 1,
    domain: "dark-factory.production-optimize-hidden-catalog-genesis.v1",
    sensitivity: "trusted-control-task-free-commitment",
    deployment: "trusted-cloud",
    campaignId: CAMPAIGN_ID,
    lineageId: LINEAGE_ID,
    protocolHash: PROTOCOL_HASH,
    campaignGenesisPrerequisiteHash: genesisPrerequisiteHash,
    datasetPinHash: "2".repeat(64),
    registryRevision: 6,
    seedSetCommitment: "3".repeat(64),
    weightingPolicyHash: "4".repeat(64),
    taskIdKeyId: "hidden-task-id-key-001",
    dispositionKeyId: "hidden-disposition-key-001",
    initialCatalogStateHash: CATALOG_STATE_HASH,
    informationBoundary: {
      containsTaskNames: false,
      containsTaskIds: false,
      containsPanelIds: false,
      containsGraderEvidence: false,
    },
    issuedAt: "2026-07-26T11:00:00.000Z",
    expiresAt: "2026-07-26T13:00:00.000Z",
  };
  return withContentHash({
    ...payload,
    signature: createEd25519Signature(
      payload,
      keyPairs["production-optimize-hidden-catalog-genesis"].privateKey,
      keyIds["production-optimize-hidden-catalog-genesis"],
      "2026-07-26T11:30:00.000Z",
    ),
  });
}

interface FixtureDocuments {
  readonly registration: TrustedGitRegistrationReceipt;
  readonly campaign: SignedProductionOptimizeCampaignGenesis;
  readonly catalog: SignedProductionOptimizeHiddenCatalogGenesis;
  readonly request: ProductionOptimizeBootstrapOrReconstructRequest;
}

function documents(): FixtureDocuments {
  const registration = registrationReceipt();
  const sourcePrerequisiteHash = gitRegistrationReceiptHash(registration);
  const campaign = campaignGenesis(sourcePrerequisiteHash);
  const catalog = catalogGenesis(campaign.contentHash);
  const unsigned = {
    schemaVersion: 1 as const,
    domain: "dark-factory.production-optimize-bootstrap-or-reconstruct-request.v1" as const,
    manifestId: "production-manifest-001",
    manifestHash: "5".repeat(64),
    campaignId: CAMPAIGN_ID,
    lineageId: LINEAGE_ID,
    protocolHash: PROTOCOL_HASH,
    sourcePrerequisiteHash,
    genesisPrerequisiteHash: campaign.contentHash,
    catalogPrerequisiteHash: catalog.contentHash,
  };
  return {
    registration,
    campaign,
    catalog,
    request: {
      ...unsigned,
      requestHash: canonicalHash(unsigned),
    },
  };
}

interface KeyMode {
  readonly revokedPurpose?: ProductionOptimizePrerequisiteKeyPurpose;
  readonly wrongPurpose?: ProductionOptimizePrerequisiteKeyPurpose;
  readonly substitutedPurpose?: ProductionOptimizePrerequisiteKeyPurpose;
}

function publicKey(
  purpose: ProductionOptimizePrerequisiteKeyPurpose,
  mode: KeyMode = {},
): TrustedProductionOptimizePrerequisitePublicKey {
  const substituted =
    mode.substitutedPurpose === purpose
      ? keyPairs[
          purpose === "production-optimize-campaign-genesis"
            ? "production-optimize-hidden-catalog-genesis"
            : "production-optimize-campaign-genesis"
        ].publicKey
      : keyPairs[purpose].publicKey;
  return {
    boundary: "trusted-cloud-key-material",
    algorithm: "Ed25519",
    purpose: mode.wrongPurpose === purpose ? "production-optimize-campaign-genesis" : purpose,
    keyId: keyIds[purpose],
    keyVersion: "v1",
    validFrom: VALID_FROM,
    validUntil: VALID_UNTIL,
    revoked: mode.revokedPurpose === purpose,
    publicKeySpkiDer: Uint8Array.from(
      substituted.export({
        format: "der",
        type: "spki",
      }),
    ),
  };
}

function keyAuthority(mode: KeyMode = {}): TrustedProductionOptimizePrerequisitePublicKeyAuthority {
  return {
    boundary: "trusted-cloud-production-optimize-prerequisite-public-key-authority",
    resolve(input) {
      return Promise.resolve(publicKey(input.purpose, mode));
    },
  };
}

function rotations() {
  return (Object.keys(keyPairs) as ProductionOptimizePrerequisiteKeyPurpose[]).map((purpose) => ({
    purpose,
    keyId: keyIds[purpose],
    keyVersion: "v1",
    validFrom: VALID_FROM,
    validUntil: VALID_UNTIL,
  }));
}

function prerequisiteSource(
  docs: FixtureDocuments,
  replacements: Partial<{
    registration: unknown;
    campaign: unknown;
    catalog: unknown;
  }> = {},
): TrustedProductionOptimizePrerequisiteSource {
  return {
    boundary: "trusted-cloud-production-optimize-prerequisite-source",
    locatePrivatePiRegistration() {
      return Promise.resolve(
        (replacements.registration ?? docs.registration) as TrustedGitRegistrationReceipt,
      );
    },
    locateCampaignGenesis() {
      return Promise.resolve(
        (replacements.campaign ?? docs.campaign) as SignedProductionOptimizeCampaignGenesis,
      );
    },
    locateHiddenCatalogGenesis() {
      return Promise.resolve(
        (replacements.catalog ?? docs.catalog) as SignedProductionOptimizeHiddenCatalogGenesis,
      );
    },
  };
}

interface World {
  campaignStateHash: string | null;
  catalogStateHash: string | null;
  throwCampaign: boolean;
  throwCatalog: boolean;
  campaignBarrier: Promise<void> | null;
  closeEvents: string[];
  wrongCampaignHash: boolean;
  wrongCatalogHash: boolean;
}

function world(): World {
  return {
    campaignStateHash: null,
    catalogStateHash: null,
    throwCampaign: false,
    throwCatalog: false,
    campaignBarrier: null,
    closeEvents: [],
    wrongCampaignHash: false,
    wrongCatalogHash: false,
  };
}

function resource(lifecycleId: string, current: World): TrustedProductionOptimizeCloseable {
  return {
    boundary: "trusted-cloud-production-optimize-lifecycle",
    lifecycleId,
    close() {
      current.closeEvents.push(lifecycleId);
      return Promise.resolve();
    },
  };
}

function campaignAuthority(current: World): TrustedProductionOptimizeCampaignGenesisAuthority {
  return {
    boundary: "trusted-cloud-production-optimize-campaign-genesis-authority",
    async ensureExact(): Promise<ProductionOptimizeGenesisEnsureResult> {
      if (current.throwCampaign) throw new Error("simulated crash");
      if (current.campaignBarrier !== null) {
        await current.campaignBarrier;
      }
      const disposition = current.campaignStateHash === null ? "created" : "existing";
      current.campaignStateHash ??= CAMPAIGN_STATE_HASH;
      return {
        disposition,
        stateHash: current.wrongCampaignHash ? "d".repeat(64) : current.campaignStateHash,
        resource: resource("campaign-genesis-resource", current),
      };
    },
  };
}

function catalogAuthority(current: World): TrustedProductionOptimizeHiddenCatalogGenesisAuthority {
  return {
    boundary: "trusted-cloud-production-optimize-hidden-catalog-genesis-authority",
    ensureExact(): Promise<ProductionOptimizeGenesisEnsureResult> {
      if (current.throwCatalog) {
        return Promise.reject(new Error("simulated crash"));
      }
      const disposition = current.catalogStateHash === null ? "created" : "existing";
      current.catalogStateHash ??= CATALOG_STATE_HASH;
      return Promise.resolve({
        disposition,
        stateHash: current.wrongCatalogHash ? "e".repeat(64) : current.catalogStateHash,
        resource: resource("catalog-genesis-resource", current),
      });
    },
  };
}

function durableState(volumeRoot: string, controller: string): MountedVolumeDurableStateOptions {
  return {
    volumeRoot,
    storeId: "bootstrap-test",
    controllerInstanceIdHash: controller.repeat(64),
    runtimeGuard,
    semanticsGuard,
    now: () => new Date(NOW),
    nonceFactory: () => controller.repeat(48),
  };
}

interface MutableClock {
  calls: number;
  throwAt: number | null;
}

function port(input: {
  readonly root: string;
  readonly controller: string;
  readonly docs: FixtureDocuments;
  readonly world: World;
  readonly source?: TrustedProductionOptimizePrerequisiteSource;
  readonly keys?: TrustedProductionOptimizePrerequisitePublicKeyAuthority;
  readonly clock?: MutableClock;
}) {
  return new DurableProductionOptimizeBootstrapOrReconstructPort({
    durableState: durableState(input.root, input.controller),
    prerequisiteSource: input.source ?? prerequisiteSource(input.docs),
    publicKeyAuthority: input.keys ?? keyAuthority(),
    keyRotations: rotations(),
    campaignGenesisAuthority: campaignAuthority(input.world),
    hiddenCatalogGenesisAuthority: catalogAuthority(input.world),
    now: () => {
      if (input.clock !== undefined) {
        input.clock.calls += 1;
        if (input.clock.calls === input.clock.throwAt) {
          throw new Error("simulated clock crash");
        }
      }
      return new Date(NOW);
    },
  });
}

function lifecycle() {
  const registered: TrustedProductionOptimizeCloseable[] = [];
  const registrar: ProductionOptimizeLifecycleRegistrar = {
    boundary: "production-optimize-composition-owner",
    register(closeable) {
      registered.push(closeable);
    },
  };
  return {
    registrar,
    registered,
    async close(): Promise<void> {
      for (const closeable of [...registered].reverse()) {
        await closeable.close();
      }
    },
  };
}

async function invoke(
  authority: DurableProductionOptimizeBootstrapOrReconstructPort,
  request: ProductionOptimizeBootstrapOrReconstructRequest,
) {
  const owner = lifecycle();
  try {
    return await authority.verifyBootstrapOrReconstruct(request, owner.registrar);
  } finally {
    await owner.close();
  }
}

describe("durable production optimize bootstrap or reconstruct port", () => {
  it("bootstraps once and returns a deterministic reconstructed retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-production-bootstrap-test-"));
    const docs = documents();
    const current = world();
    const first = await invoke(
      port({
        root,
        controller: "1",
        docs,
        world: current,
      }),
      docs.request,
    );
    expect(first).toMatchObject({
      disposition: "bootstrapped",
      sourcePrerequisiteHash: gitRegistrationReceiptHash(docs.registration),
      campaignStateHash: CAMPAIGN_STATE_HASH,
      catalogStateHash: CATALOG_STATE_HASH,
      prerequisitesVerified: true,
      idempotentlyBound: true,
    });
    expect(current.closeEvents).toEqual(["catalog-genesis-resource", "campaign-genesis-resource"]);

    const second = await invoke(
      port({
        root,
        controller: "2",
        docs,
        world: current,
      }),
      docs.request,
    );
    const third = await invoke(
      port({
        root,
        controller: "3",
        docs,
        world: current,
      }),
      docs.request,
    );
    expect(second.disposition).toBe("reconstructed");
    expect(third).toEqual(second);
  });

  it("recovers strict prefixes after interruption at each durable phase", async () => {
    for (const crashPoint of ["claimed", "campaign-ensured", "catalog-ensured"] as const) {
      const root = await mkdtemp(join(tmpdir(), `df-bootstrap-${crashPoint}-`));
      const docs = documents();
      const current = world();
      const clock: MutableClock = { calls: 0, throwAt: null };
      if (crashPoint === "claimed") current.throwCampaign = true;
      if (crashPoint === "campaign-ensured") {
        current.throwCatalog = true;
      }
      if (crashPoint === "catalog-ensured") clock.throwAt = 5;
      await expect(
        invoke(
          port({
            root,
            controller: "4",
            docs,
            world: current,
            clock,
          }),
          docs.request,
        ),
      ).rejects.toThrow(/failed closed/u);
      current.throwCampaign = false;
      current.throwCatalog = false;
      clock.throwAt = null;
      clock.calls = 0;
      await expect(
        invoke(
          port({
            root,
            controller: "5",
            docs,
            world: current,
            clock,
          }),
          docs.request,
        ),
      ).resolves.toMatchObject({
        disposition: "reconstructed",
        campaignStateHash: CAMPAIGN_STATE_HASH,
        catalogStateHash: CATALOG_STATE_HASH,
      });
    }
  });

  it("bounds concurrent work to one in-flight request identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-bootstrap-concurrent-"));
    const docs = documents();
    const current = world();
    let release = (): void => {};
    current.campaignBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authority = port({
      root,
      controller: "6",
      docs,
      world: current,
    });
    const firstOwner = lifecycle();
    const first = authority.verifyBootstrapOrReconstruct(docs.request, firstOwner.registrar);
    await Promise.resolve();
    await Promise.resolve();
    const secondOwner = lifecycle();
    await expect(
      authority.verifyBootstrapOrReconstruct(docs.request, secondOwner.registrar),
    ).rejects.toThrow(/failed closed/u);
    release();
    await expect(first).resolves.toMatchObject({
      disposition: "bootstrapped",
    });
    await secondOwner.close();
    await firstOwner.close();
  });

  it("rejects a different request after the durable identity is claimed", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-bootstrap-different-"));
    const docs = documents();
    const current = world();
    await invoke(
      port({
        root,
        controller: "7",
        docs,
        world: current,
      }),
      docs.request,
    );
    const changedUnsigned = {
      ...docs.request,
      manifestId: "production-manifest-002",
      requestHash: undefined,
    };
    const { requestHash: _requestHash, ...unsigned } = changedUnsigned;
    const changed = {
      ...unsigned,
      requestHash: canonicalHash(unsigned),
    } as ProductionOptimizeBootstrapOrReconstructRequest;
    await expect(
      invoke(
        port({
          root,
          controller: "8",
          docs,
          world: current,
        }),
        changed,
      ),
    ).rejects.toThrow(/failed closed/u);
  });

  it("rejects detached source, campaign, and catalog prerequisite hashes", async () => {
    const docs = documents();
    for (const field of [
      "sourcePrerequisiteHash",
      "genesisPrerequisiteHash",
      "catalogPrerequisiteHash",
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `df-bootstrap-wrong-${field}-`));
      const unsigned = {
        ...docs.request,
        [field]: "f".repeat(64),
        requestHash: undefined,
      };
      const { requestHash: _requestHash, ...body } = unsigned;
      const request = {
        ...body,
        requestHash: canonicalHash(body),
      } as ProductionOptimizeBootstrapOrReconstructRequest;
      await expect(
        invoke(
          port({
            root,
            controller: "9",
            docs,
            world: world(),
          }),
          request,
        ),
      ).rejects.toThrow(/failed closed/u);
    }
  });

  it("rejects wrong-purpose, revoked, and substituted verification keys", async () => {
    const docs = documents();
    const cases: readonly KeyMode[] = [
      {
        wrongPurpose: "production-optimize-hidden-catalog-genesis",
      },
      {
        revokedPurpose: "production-optimize-campaign-genesis",
      },
      {
        substitutedPurpose: "production-optimize-private-pi-registration",
      },
    ];
    for (const [index, mode] of cases.entries()) {
      const root = await mkdtemp(join(tmpdir(), `df-bootstrap-key-${index}-`));
      await expect(
        invoke(
          port({
            root,
            controller: String(index + 1),
            docs,
            world: world(),
            keys: keyAuthority(mode),
          }),
          docs.request,
        ),
      ).rejects.toThrow(/failed closed/u);
    }
  });

  it("rejects task-bearing catalog fields even when re-signed", async () => {
    const docs = documents();
    const { signature: _signature, contentHash: _contentHash, ...body } = docs.catalog;
    const taskBearing = withContentHash({
      ...body,
      taskIds: ["hidden-task-001"],
      signature: createEd25519Signature(
        { ...body, taskIds: ["hidden-task-001"] },
        keyPairs["production-optimize-hidden-catalog-genesis"].privateKey,
        keyIds["production-optimize-hidden-catalog-genesis"],
        "2026-07-26T11:30:00.000Z",
      ),
    });
    const root = await mkdtemp(join(tmpdir(), "df-bootstrap-task-bearing-"));
    await expect(
      invoke(
        port({
          root,
          controller: "a",
          docs,
          world: world(),
          source: prerequisiteSource(docs, {
            catalog: taskBearing,
          }),
        }),
        docs.request,
      ),
    ).rejects.toThrow(/failed closed/u);
  });

  it("captures dependency methods and freezes authority inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-bootstrap-capture-"));
    const docs = documents();
    const current = world();
    const source = prerequisiteSource(docs);
    const keys = keyAuthority();
    const campaign = campaignAuthority(current);
    const catalog = catalogAuthority(current);
    const authority = new DurableProductionOptimizeBootstrapOrReconstructPort({
      durableState: durableState(root, "b"),
      prerequisiteSource: source,
      publicKeyAuthority: keys,
      keyRotations: rotations(),
      campaignGenesisAuthority: campaign,
      hiddenCatalogGenesisAuthority: catalog,
      now: () => new Date(NOW),
    });
    (
      source as unknown as {
        locatePrivatePiRegistration(): Promise<never>;
      }
    ).locatePrivatePiRegistration = () => Promise.reject(new Error("mutated"));
    (
      keys as unknown as {
        resolve(): Promise<never>;
      }
    ).resolve = () => Promise.reject(new Error("mutated"));
    (
      campaign as unknown as {
        ensureExact(): Promise<never>;
      }
    ).ensureExact = () => Promise.reject(new Error("mutated"));
    (
      catalog as unknown as {
        ensureExact(): Promise<never>;
      }
    ).ensureExact = () => Promise.reject(new Error("mutated"));
    await expect(invoke(authority, docs.request)).resolves.toMatchObject({
      disposition: "bootstrapped",
    });
  });

  it("fails closed when a dependency attempts to mutate a frozen query", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-bootstrap-input-mutation-"));
    const docs = documents();
    const source = prerequisiteSource(docs);
    source.locateCampaignGenesis = (input) => {
      (
        input as unknown as {
          campaignId: string;
        }
      ).campaignId = "mutated-campaign";
      return Promise.resolve(docs.campaign);
    };
    await expect(
      invoke(
        port({
          root,
          controller: "e",
          docs,
          world: world(),
          source,
        }),
        docs.request,
      ),
    ).rejects.toThrow(/failed closed/u);
  });

  it("registers acquired resources before rejecting bad state and cleans in reverse", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-bootstrap-cleanup-"));
    const docs = documents();
    const current = world();
    current.wrongCatalogHash = true;
    await expect(
      invoke(
        port({
          root,
          controller: "c",
          docs,
          world: current,
        }),
        docs.request,
      ),
    ).rejects.toThrow(/failed closed/u);
    expect(current.closeEvents).toEqual(["catalog-genesis-resource", "campaign-genesis-resource"]);
  });

  it("rejects a catalog that exists while its campaign must be created", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-bootstrap-impossible-prefix-"));
    const docs = documents();
    const current = world();
    current.catalogStateHash = CATALOG_STATE_HASH;
    await expect(
      invoke(
        port({
          root,
          controller: "d",
          docs,
          world: current,
        }),
        docs.request,
      ),
    ).rejects.toThrow(/failed closed/u);
  });
});
