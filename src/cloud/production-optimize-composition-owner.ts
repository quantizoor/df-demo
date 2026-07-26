import {
  assertProductionOptimizationCompositionManifest,
  composeProductionOptimizationRuntime,
  productionRuntimePortBindingsHash,
  type ProductionCompositionVerification,
  type ProductionOptimizationCompositionManifest,
  type ProductionOptimizationRuntime,
  type ProductionOptimizationRuntimeComponents,
  type ProductionOptimizationRuntimePortBindings,
  type ProductionOptimizationRuntimeRunReceipt,
  type ProductionOptimizationRuntimeStatus,
  type ProductionRuntimePortAttestationCommitment,
  type TrustedProductionCompositionAttestationVerifier,
} from "../orchestrator/production-runtime.js";
import { canonicalHash, canonicalJson } from "../schemas/canonical.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;

/*
 * This fence prevents two owners in one control process from operating the
 * same campaign. A concrete campaign store must additionally provide the
 * durable cross-process writer fence documented by its runtime-port
 * attestation.
 */
const activeCampaigns = new Set<string>();

export interface ProductionOptimizeBootstrapOrReconstructRequest {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.production-optimize-bootstrap-or-reconstruct-request.v1";
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  /**
   * Exact manifest bindings. The bootstrap port must verify each prerequisite
   * independently; the request hash is also its durable idempotency key.
   */
  readonly sourcePrerequisiteHash: string;
  readonly genesisPrerequisiteHash: string;
  readonly catalogPrerequisiteHash: string;
  readonly requestHash: string;
}

export interface ProductionOptimizeBootstrapOrReconstructReceipt {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.production-optimize-bootstrap-or-reconstruct-receipt.v1";
  readonly requestHash: string;
  readonly manifestHash: string;
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly disposition: "bootstrapped" | "reconstructed";
  readonly sourcePrerequisiteHash: string;
  readonly genesisPrerequisiteHash: string;
  readonly catalogPrerequisiteHash: string;
  readonly campaignStateHash: string;
  readonly catalogStateHash: string;
  readonly prerequisitesVerified: true;
  readonly idempotentlyBound: true;
  readonly verifiedAt: string;
  readonly receiptHash: string;
}

/**
 * Every mounted store, lease, or other owner-scoped resource must be
 * registered immediately after acquisition and before another asynchronous
 * operation. Registration captures the close method against later mutation.
 */
export interface TrustedProductionOptimizeCloseable {
  readonly boundary: "trusted-cloud-production-optimize-lifecycle";
  readonly lifecycleId: string;
  close(): Promise<void>;
}

export interface ProductionOptimizeLifecycleRegistrar {
  readonly boundary: "production-optimize-composition-owner";
  register(closeable: TrustedProductionOptimizeCloseable): void;
}

/**
 * The port must atomically verify the three prerequisites and then either
 * create the campaign/catalog genesis once or reconstruct their existing
 * state. `requestHash` is the mandatory durable idempotency key.
 */
export interface TrustedProductionOptimizeBootstrapOrReconstructPort {
  readonly boundary:
    "trusted-cloud-production-optimize-bootstrap-or-reconstruct";
  verifyBootstrapOrReconstruct(
    request: ProductionOptimizeBootstrapOrReconstructRequest,
    lifecycle: ProductionOptimizeLifecycleRegistrar,
  ): Promise<ProductionOptimizeBootstrapOrReconstructReceipt>;
}

export interface ProductionOptimizeRuntimeAssembly {
  readonly components: ProductionOptimizationRuntimeComponents;
  readonly runtimePortBindings: ProductionOptimizationRuntimePortBindings;
}

export interface ProductionOptimizeRuntimeFactoryInput {
  readonly manifest: ProductionOptimizationCompositionManifest;
  readonly compositionVerification: ProductionCompositionVerification;
  readonly bootstrapReceipt: ProductionOptimizeBootstrapOrReconstructReceipt;
  readonly lifecycle: ProductionOptimizeLifecycleRegistrar;
}

/**
 * This factory is an injected, trusted in-process authority. No manifest,
 * descriptor, environment variable, or JSON registry can name a module,
 * command, constructor, or executable binding accepted by this owner.
 */
export interface TrustedProductionOptimizeRuntimeFactory {
  readonly boundary: "trusted-cloud-production-optimize-runtime-factory";
  create(
    input: ProductionOptimizeRuntimeFactoryInput,
  ): Promise<ProductionOptimizeRuntimeAssembly>;
}

export interface ProductionOptimizeCompositionOwnerOptions {
  /**
   * Data only. This may be the bootstrap artifact loader's validated document;
   * the owner canonicalizes and fully validates it before using any authority.
   */
  readonly manifest: unknown;
  readonly verifier: TrustedProductionCompositionAttestationVerifier;
  readonly bootstrap: TrustedProductionOptimizeBootstrapOrReconstructPort;
  readonly runtimeFactory: TrustedProductionOptimizeRuntimeFactory;
  readonly now?: () => Date;
}

interface CapturedOwnerOptions {
  readonly manifestJson: string;
  readonly campaignId: string;
  readonly verify: TrustedProductionCompositionAttestationVerifier["verify"];
  readonly verifyBootstrapOrReconstruct:
    TrustedProductionOptimizeBootstrapOrReconstructPort["verifyBootstrapOrReconstruct"];
  readonly createRuntime: TrustedProductionOptimizeRuntimeFactory["create"];
  readonly now: () => Date;
}

interface RegisteredClose {
  readonly close: () => Promise<void>;
}

export class ProductionOptimizeCompositionOwnerError extends Error {
  override readonly name = "ProductionOptimizeCompositionOwnerError";

  public constructor() {
    super("Production optimize composition owner failed closed.");
  }
}

function fail(): never {
  throw new ProductionOptimizeCompositionOwnerError();
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail();
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    fail();
  }
}

function assertOwnerOptionKeys(value: unknown): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail();
  const keys = Object.keys(value);
  const allowed = ["manifest", "verifier", "bootstrap", "runtimeFactory", "now"] as const;
  if (
    !keys.includes("manifest") ||
    !keys.includes("verifier") ||
    !keys.includes("bootstrap") ||
    !keys.includes("runtimeFactory") ||
    keys.some((key) => !allowed.includes(key as (typeof allowed)[number]))
  ) {
    fail();
  }
}

function readNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail();
  return new Date(value.getTime());
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") fail();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail();
  return parsed;
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function captureOptions(options: ProductionOptimizeCompositionOwnerOptions): CapturedOwnerOptions {
  try {
    assertOwnerOptionKeys(options);
    if (
      options.verifier.boundary !== "trusted-cloud-attestation-verifier" ||
      options.bootstrap.boundary !==
        "trusted-cloud-production-optimize-bootstrap-or-reconstruct" ||
      options.runtimeFactory.boundary !==
        "trusted-cloud-production-optimize-runtime-factory" ||
      typeof options.verifier.verify !== "function" ||
      typeof options.bootstrap.verifyBootstrapOrReconstruct !== "function" ||
      typeof options.runtimeFactory.create !== "function" ||
      (options.now !== undefined && typeof options.now !== "function")
    ) {
      fail();
    }
    const sourceNow = options.now ?? (() => new Date());
    const now = (): Date => readNow(sourceNow);
    const manifest = cloneCanonical(options.manifest);
    assertProductionOptimizationCompositionManifest(manifest, now());
    return {
      manifestJson: canonicalJson(manifest),
      campaignId: manifest.campaignId,
      verify: options.verifier.verify.bind(options.verifier),
      verifyBootstrapOrReconstruct:
        options.bootstrap.verifyBootstrapOrReconstruct.bind(options.bootstrap),
      createRuntime: options.runtimeFactory.create.bind(options.runtimeFactory),
      now,
    };
  } catch {
    fail();
  }
}

function bootstrapRequest(
  manifest: ProductionOptimizationCompositionManifest,
): ProductionOptimizeBootstrapOrReconstructRequest {
  const unsigned = {
    schemaVersion: 1 as const,
    domain:
      "dark-factory.production-optimize-bootstrap-or-reconstruct-request.v1" as const,
    manifestId: manifest.manifestId,
    manifestHash: manifest.manifestHash,
    campaignId: manifest.campaignId,
    lineageId: manifest.lineageId,
    protocolHash: manifest.protocolHash,
    sourcePrerequisiteHash: manifest.bindings.harnessRegistrationHash,
    genesisPrerequisiteHash: manifest.bindings.campaignGenesisHash,
    catalogPrerequisiteHash: manifest.bindings.hiddenCatalogGenesisHash,
  };
  return {
    ...unsigned,
    requestHash: canonicalHash(unsigned),
  };
}

function assertVerification(
  value: ProductionCompositionVerification,
  manifest: ProductionOptimizationCompositionManifest,
  runtimePortAttestations: readonly ProductionRuntimePortAttestationCommitment[],
): void {
  assertExactKeys(value, [
    "schemaVersion",
    "domain",
    "manifestHash",
    "signingKeyId",
    "componentBindingsHash",
    "operationalBindingsHash",
    "runtimePortBindingsHash",
    "verifierAttestationHash",
    "verified",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.domain !== "dark-factory.production-composition-verification.v1" ||
    value.manifestHash !== manifest.manifestHash ||
    value.signingKeyId !== manifest.signature.keyId ||
    value.componentBindingsHash !== canonicalHash(manifest.components) ||
    value.operationalBindingsHash !== canonicalHash(manifest.bindings) ||
    value.runtimePortBindingsHash !==
      productionRuntimePortBindingsHash(runtimePortAttestations) ||
    !SHA256.test(value.verifierAttestationHash) ||
    value.verified !== true
  ) {
    fail();
  }
}

function assertBootstrapReceipt(
  value: ProductionOptimizeBootstrapOrReconstructReceipt,
  request: ProductionOptimizeBootstrapOrReconstructRequest,
  manifest: ProductionOptimizationCompositionManifest,
  now: Date,
): void {
  assertExactKeys(value, [
    "schemaVersion",
    "domain",
    "requestHash",
    "manifestHash",
    "campaignId",
    "lineageId",
    "protocolHash",
    "disposition",
    "sourcePrerequisiteHash",
    "genesisPrerequisiteHash",
    "catalogPrerequisiteHash",
    "campaignStateHash",
    "catalogStateHash",
    "prerequisitesVerified",
    "idempotentlyBound",
    "verifiedAt",
    "receiptHash",
  ]);
  const verifiedAt = timestamp(value.verifiedAt);
  const unsigned = {
    schemaVersion: value.schemaVersion,
    domain: value.domain,
    requestHash: value.requestHash,
    manifestHash: value.manifestHash,
    campaignId: value.campaignId,
    lineageId: value.lineageId,
    protocolHash: value.protocolHash,
    disposition: value.disposition,
    sourcePrerequisiteHash: value.sourcePrerequisiteHash,
    genesisPrerequisiteHash: value.genesisPrerequisiteHash,
    catalogPrerequisiteHash: value.catalogPrerequisiteHash,
    campaignStateHash: value.campaignStateHash,
    catalogStateHash: value.catalogStateHash,
    prerequisitesVerified: value.prerequisitesVerified,
    idempotentlyBound: value.idempotentlyBound,
    verifiedAt: value.verifiedAt,
  };
  if (
    value.schemaVersion !== 1 ||
    value.domain !==
      "dark-factory.production-optimize-bootstrap-or-reconstruct-receipt.v1" ||
    value.requestHash !== request.requestHash ||
    value.manifestHash !== request.manifestHash ||
    value.campaignId !== request.campaignId ||
    value.lineageId !== request.lineageId ||
    value.protocolHash !== request.protocolHash ||
    (value.disposition !== "bootstrapped" && value.disposition !== "reconstructed") ||
    value.sourcePrerequisiteHash !== request.sourcePrerequisiteHash ||
    value.genesisPrerequisiteHash !== request.genesisPrerequisiteHash ||
    value.catalogPrerequisiteHash !== request.catalogPrerequisiteHash ||
    !SHA256.test(value.campaignStateHash) ||
    !SHA256.test(value.catalogStateHash) ||
    value.prerequisitesVerified !== true ||
    value.idempotentlyBound !== true ||
    verifiedAt < timestamp(manifest.issuedAt) ||
    verifiedAt > now.getTime() ||
    !SHA256.test(value.receiptHash) ||
    value.receiptHash !== canonicalHash(unsigned)
  ) {
    fail();
  }
}

function assertAssembly(value: unknown): asserts value is ProductionOptimizeRuntimeAssembly {
  assertExactKeys(value, ["components", "runtimePortBindings"]);
}

/**
 * Owns exactly one status or run invocation. Every path, including bootstrap,
 * factory, composition, runtime, and verification failure, drains the
 * registered lifecycle stack in reverse acquisition order.
 */
export class ProductionOptimizeCompositionOwner {
  readonly #manifestJson: string;
  readonly #campaignId: string;
  readonly #verify: TrustedProductionCompositionAttestationVerifier["verify"];
  readonly #verifyBootstrapOrReconstruct:
    TrustedProductionOptimizeBootstrapOrReconstructPort["verifyBootstrapOrReconstruct"];
  readonly #createRuntime: TrustedProductionOptimizeRuntimeFactory["create"];
  readonly #now: () => Date;
  readonly #registered: RegisteredClose[] = [];
  readonly #lifecycleIds = new Set<string>();
  readonly #lifecycleObjects = new Set<object>();
  #state: "ready" | "running" | "closed" = "ready";
  #registrationOpen = true;

  public constructor(options: ProductionOptimizeCompositionOwnerOptions) {
    const captured = captureOptions(options);
    this.#manifestJson = captured.manifestJson;
    this.#campaignId = captured.campaignId;
    this.#verify = captured.verify;
    this.#verifyBootstrapOrReconstruct = captured.verifyBootstrapOrReconstruct;
    this.#createRuntime = captured.createRuntime;
    this.#now = captured.now;
  }

  public status(): Promise<ProductionOptimizationRuntimeStatus> {
    return this.#execute((runtime) => runtime.status());
  }

  public run(): Promise<ProductionOptimizationRuntimeRunReceipt> {
    return this.#execute((runtime) => runtime.run());
  }

  #register(closeable: TrustedProductionOptimizeCloseable): void {
    if (
      !this.#registrationOpen ||
      closeable === null ||
      typeof closeable !== "object" ||
      closeable.boundary !== "trusted-cloud-production-optimize-lifecycle" ||
      typeof closeable.lifecycleId !== "string" ||
      !SAFE_ID.test(closeable.lifecycleId) ||
      typeof closeable.close !== "function" ||
      this.#lifecycleIds.has(closeable.lifecycleId) ||
      this.#lifecycleObjects.has(closeable)
    ) {
      fail();
    }
    this.#lifecycleIds.add(closeable.lifecycleId);
    this.#lifecycleObjects.add(closeable);
    this.#registered.push({
      close: closeable.close.bind(closeable),
    });
  }

  async #preverify(
    manifest: ProductionOptimizationCompositionManifest,
  ): Promise<ProductionCompositionVerification> {
    const manifestJson = canonicalJson(manifest);
    const attestationsJson = canonicalJson(manifest.runtimePortAttestations);
    const manifestInput = JSON.parse(manifestJson) as ProductionOptimizationCompositionManifest;
    const attestationInput = JSON.parse(
      attestationsJson,
    ) as readonly ProductionRuntimePortAttestationCommitment[];
    const verification = await this.#verify(manifestInput, attestationInput);
    if (
      canonicalJson(manifestInput) !== manifestJson ||
      canonicalJson(attestationInput) !== attestationsJson
    ) {
      fail();
    }
    assertVerification(verification, manifest, manifest.runtimePortAttestations);
    return cloneCanonical(verification);
  }

  #stableVerifier(
    initial: ProductionCompositionVerification,
  ): TrustedProductionCompositionAttestationVerifier {
    const expectedManifestJson = this.#manifestJson;
    const expectedAttestationsJson = canonicalJson(
      (JSON.parse(this.#manifestJson) as ProductionOptimizationCompositionManifest)
        .runtimePortAttestations,
    );
    const expectedVerificationJson = canonicalJson(initial);
    return {
      boundary: "trusted-cloud-attestation-verifier",
      verify: async (
        manifest: ProductionOptimizationCompositionManifest,
        runtimePortAttestations: readonly ProductionRuntimePortAttestationCommitment[],
      ): Promise<ProductionCompositionVerification> => {
        if (
          canonicalJson(manifest) !== expectedManifestJson ||
          canonicalJson(runtimePortAttestations) !== expectedAttestationsJson
        ) {
          fail();
        }
        const verification = await this.#preverify(
          JSON.parse(expectedManifestJson) as ProductionOptimizationCompositionManifest,
        );
        if (canonicalJson(verification) !== expectedVerificationJson) fail();
        return cloneCanonical(verification);
      },
    };
  }

  async #closeAll(): Promise<boolean> {
    this.#registrationOpen = false;
    let failed = false;
    for (let index = this.#registered.length - 1; index >= 0; index -= 1) {
      const registered = this.#registered[index];
      if (registered === undefined) {
        failed = true;
        continue;
      }
      try {
        await registered.close();
      } catch {
        failed = true;
      }
    }
    return failed;
  }

  async #execute<Result>(
    invoke: (runtime: ProductionOptimizationRuntime) => Promise<Result>,
  ): Promise<Result> {
    if (this.#state !== "ready") fail();
    this.#state = "running";
    if (activeCampaigns.has(this.#campaignId)) {
      this.#state = "closed";
      this.#registrationOpen = false;
      fail();
    }
    activeCampaigns.add(this.#campaignId);
    let outcome: { readonly ok: true; readonly value: Result } | { readonly ok: false } = {
      ok: false,
    };
    let closeFailed = false;
    try {
      const now = this.#now();
      const manifest = JSON.parse(
        this.#manifestJson,
      ) as ProductionOptimizationCompositionManifest;
      assertProductionOptimizationCompositionManifest(manifest, now);
      const verification = await this.#preverify(manifest);
      const request = bootstrapRequest(manifest);
      const lifecycle: ProductionOptimizeLifecycleRegistrar = Object.freeze({
        boundary: "production-optimize-composition-owner" as const,
        register: (closeable: TrustedProductionOptimizeCloseable): void => {
          this.#register(closeable);
        },
      });
      const requestJson = canonicalJson(request);
      const requestInput = JSON.parse(
        requestJson,
      ) as ProductionOptimizeBootstrapOrReconstructRequest;
      const bootstrapReceipt = await this.#verifyBootstrapOrReconstruct(
        requestInput,
        lifecycle,
      );
      if (canonicalJson(requestInput) !== requestJson) fail();
      assertBootstrapReceipt(bootstrapReceipt, request, manifest, this.#now());
      const canonicalBootstrapReceipt = cloneCanonical(bootstrapReceipt);
      const factoryManifest = JSON.parse(
        this.#manifestJson,
      ) as ProductionOptimizationCompositionManifest;
      const factoryVerification = cloneCanonical(verification);
      const factoryBootstrapReceipt = cloneCanonical(
        canonicalBootstrapReceipt,
      );
      const verificationJson = canonicalJson(factoryVerification);
      const bootstrapReceiptJson = canonicalJson(
        factoryBootstrapReceipt,
      );
      const assembly = await this.#createRuntime({
        manifest: factoryManifest,
        compositionVerification: factoryVerification,
        bootstrapReceipt: factoryBootstrapReceipt,
        lifecycle,
      });
      if (
        canonicalJson(factoryManifest) !== this.#manifestJson ||
        canonicalJson(factoryVerification) !== verificationJson ||
        canonicalJson(factoryBootstrapReceipt) !== bootstrapReceiptJson
      ) {
        fail();
      }
      assertAssembly(assembly);
      const runtime = await composeProductionOptimizationRuntime({
        manifest: JSON.parse(
          this.#manifestJson,
        ) as ProductionOptimizationCompositionManifest,
        verifier: this.#stableVerifier(verification),
        components: assembly.components,
        runtimePortBindings: assembly.runtimePortBindings,
        now: this.#now,
      });
      outcome = { ok: true, value: await invoke(runtime) };
    } catch {
      outcome = { ok: false };
    } finally {
      try {
        closeFailed = await this.#closeAll();
      } catch {
        closeFailed = true;
      } finally {
        activeCampaigns.delete(this.#campaignId);
        this.#state = "closed";
      }
    }
    if (!outcome.ok || closeFailed) fail();
    return outcome.value;
  }
}
