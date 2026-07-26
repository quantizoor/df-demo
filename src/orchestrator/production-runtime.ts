import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import {
  AutonomousOptimizationLoop,
  type AutonomousOptimizationLoopReceipt,
  type OptimizationLoopSnapshot,
} from "./autonomous-loop.js";
import {
  CampaignStateOptimizationCoordinator,
  type OptimizationCampaignStateStore,
  type TrustedOptimizationCompletionMaterialPort,
  type TrustedOptimizationInputFactory,
  type TrustedOptimizationInterruptionPort,
  type TrustedOptimizationResumeVerifier,
} from "./campaign-state-coordinator.js";
import type {
  BlindBroker,
  CorrectnessGateRunner,
  ExperimentJournal,
  OptimizerAdapter,
} from "./contracts.js";
import { ExperimentRunner } from "./experiment-runner.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const IMMUTABLE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,446}@sha256:[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$/u;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86,128}$/u;

export type ProductionRuntimeRole = "control" | "optimizer" | "build" | "evaluator";

const PRODUCTION_RUNTIME_PORT_ID_VALUES = [
  "control.campaign-state-store",
  "control.optimization-input-factory",
  "control.optimization-resume-verifier",
  "control.optimization-completion-material",
  "control.optimization-interruption-port",
  "control.experiment-journal",
  "optimizer.adapter",
  "build.correctness-gate",
  "evaluator.blind-broker",
] as const;

export const PRODUCTION_RUNTIME_PORT_IDS = Object.freeze(PRODUCTION_RUNTIME_PORT_ID_VALUES);

export type ProductionRuntimePortId = (typeof PRODUCTION_RUNTIME_PORT_IDS)[number];

export interface ProductionRuntimePortAttestationCommitment {
  readonly portId: ProductionRuntimePortId;
  readonly attestationSha256: string;
}

export interface TrustedProductionRuntimePortBinding<
  PortId extends ProductionRuntimePortId,
  Implementation extends object,
> {
  readonly boundary: "trusted-cloud-runtime-port-binding";
  readonly portId: PortId;
  readonly attestationSha256: string;
  /**
   * This value is intentionally absent from every manifest and verifier
   * request. Composition requires it to be reference-equal to the actual port.
   */
  readonly implementation: Implementation;
}

export interface ProductionOptimizationRuntimePortBindings {
  readonly campaignStore: TrustedProductionRuntimePortBinding<
    "control.campaign-state-store",
    OptimizationCampaignStateStore
  >;
  readonly inputFactory: TrustedProductionRuntimePortBinding<
    "control.optimization-input-factory",
    TrustedOptimizationInputFactory
  >;
  readonly resumeVerifier: TrustedProductionRuntimePortBinding<
    "control.optimization-resume-verifier",
    TrustedOptimizationResumeVerifier
  >;
  readonly completionMaterial: TrustedProductionRuntimePortBinding<
    "control.optimization-completion-material",
    TrustedOptimizationCompletionMaterialPort
  >;
  readonly interruption: TrustedProductionRuntimePortBinding<
    "control.optimization-interruption-port",
    TrustedOptimizationInterruptionPort
  >;
  readonly journal: TrustedProductionRuntimePortBinding<
    "control.experiment-journal",
    ExperimentJournal
  >;
  readonly optimizer: TrustedProductionRuntimePortBinding<"optimizer.adapter", OptimizerAdapter>;
  readonly gates: TrustedProductionRuntimePortBinding<
    "build.correctness-gate",
    CorrectnessGateRunner
  >;
  readonly broker: TrustedProductionRuntimePortBinding<"evaluator.blind-broker", BlindBroker>;
}

export interface ProductionRuntimeComponentManifest {
  readonly role: ProductionRuntimeRole;
  readonly boundary: "trusted-cloud";
  readonly componentId: string;
  readonly imageReference: string;
  readonly imageDigest: `sha256:${string}`;
  readonly sourceArtifactHash: string;
  readonly configurationHash: string;
}

export interface ProductionOptimizationCompositionManifest {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.production-optimization-composition.v1";
  readonly manifestId: string;
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly deployment: "trusted-cloud";
  readonly components: {
    readonly control: ProductionRuntimeComponentManifest;
    readonly optimizer: ProductionRuntimeComponentManifest;
    readonly build: ProductionRuntimeComponentManifest;
    readonly evaluator: ProductionRuntimeComponentManifest;
  };
  readonly runtimePortAttestations: readonly ProductionRuntimePortAttestationCommitment[];
  /**
   * Every binding is an opaque commitment. Task, panel, cell, grader-output,
   * and raw-evidence identities have no representable field in this manifest.
   */
  readonly bindings: {
    readonly harnessRegistrationHash: string;
    readonly campaignGenesisHash: string;
    readonly hiddenCatalogGenesisHash: string;
    readonly providerReadinessHash: string;
    readonly volumeSemanticsHash: string;
    readonly optimizerPluginBundleHash: string;
    readonly correctnessPolicyHash: string;
    readonly brokerPolicyHash: string;
    readonly evaluatorPolicyHash: string;
    readonly journalPolicyHash: string;
  };
  readonly informationBoundary: {
    readonly containsTaskIdentities: false;
    readonly containsPanelIdentities: false;
    readonly containsCellIdentities: false;
    readonly containsRawEvidence: false;
    readonly optimizerHasBenchmarkCredentials: false;
    readonly optimizerCanReachEvaluator: false;
  };
  readonly maximumExperimentsPerInvocation: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly manifestHash: string;
  readonly signature: Signature;
}

export interface ProductionCompositionVerification {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.production-composition-verification.v1";
  readonly manifestHash: string;
  readonly signingKeyId: string;
  readonly componentBindingsHash: string;
  readonly operationalBindingsHash: string;
  readonly runtimePortBindingsHash: string;
  readonly verifierAttestationHash: string;
  readonly verified: true;
}

/**
 * This authority verifies both the Ed25519 signature and the provider-side
 * image/configuration/source attestations committed by `components` and
 * `bindings`, plus the ordered runtime-port attestation commitments. The
 * second argument contains fixed task-free IDs and digests only; executable
 * wrappers never cross this boundary. A signature-only verifier does not
 * satisfy this contract.
 */
export interface TrustedProductionCompositionAttestationVerifier {
  readonly boundary: "trusted-cloud-attestation-verifier";
  verify(
    manifest: ProductionOptimizationCompositionManifest,
    runtimePortAttestations: readonly ProductionRuntimePortAttestationCommitment[],
  ): Promise<ProductionCompositionVerification>;
}

interface TrustedCloudRoleBinding {
  readonly boundary: "trusted-cloud";
  readonly role: ProductionRuntimeRole;
  readonly manifestBindingHash: string;
  readonly imageDigest: `sha256:${string}`;
}

export interface TrustedCloudControlRuntime extends TrustedCloudRoleBinding {
  readonly role: "control";
  readonly campaignStore: OptimizationCampaignStateStore;
  readonly inputFactory: TrustedOptimizationInputFactory;
  readonly resumeVerifier: TrustedOptimizationResumeVerifier;
  readonly completionMaterial: TrustedOptimizationCompletionMaterialPort;
  readonly interruption: TrustedOptimizationInterruptionPort;
  readonly journal: ExperimentJournal;
}

export interface TrustedCloudOptimizerRuntime extends TrustedCloudRoleBinding {
  readonly role: "optimizer";
  readonly adapter: OptimizerAdapter;
}

export interface TrustedCloudBuildRuntime extends TrustedCloudRoleBinding {
  readonly role: "build";
  readonly gates: CorrectnessGateRunner;
}

export interface TrustedCloudEvaluatorRuntime extends TrustedCloudRoleBinding {
  readonly role: "evaluator";
  readonly broker: BlindBroker;
}

export interface ProductionOptimizationRuntimeComponents {
  readonly control: TrustedCloudControlRuntime;
  readonly optimizer: TrustedCloudOptimizerRuntime;
  readonly build: TrustedCloudBuildRuntime;
  readonly evaluator: TrustedCloudEvaluatorRuntime;
}

export interface ProductionOptimizationRuntimeStatus {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.production-optimization-runtime-status.v1";
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly verifierAttestationHash: string;
  readonly snapshot: OptimizationLoopSnapshot;
}

export interface ProductionOptimizationRuntimeRunReceipt {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.production-optimization-runtime-run.v1";
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly verifierAttestationHash: string;
  readonly loop: AutonomousOptimizationLoopReceipt;
}

export interface ProductionOptimizationRuntime {
  status(): Promise<ProductionOptimizationRuntimeStatus>;
  run(): Promise<ProductionOptimizationRuntimeRunReceipt>;
}

export interface ComposeProductionOptimizationRuntimeOptions {
  readonly manifest: ProductionOptimizationCompositionManifest;
  readonly verifier: TrustedProductionCompositionAttestationVerifier;
  readonly components: ProductionOptimizationRuntimeComponents;
  readonly runtimePortBindings: ProductionOptimizationRuntimePortBindings;
  readonly now?: () => Date;
}

export class ProductionOptimizationRuntimeError extends Error {
  override readonly name = "ProductionOptimizationRuntimeError";

  public constructor() {
    super("Production optimization runtime composition failed closed.");
  }
}

function fail(): never {
  throw new ProductionOptimizationRuntimeError();
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

function timestamp(value: unknown): number {
  if (typeof value !== "string") fail();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail();
  }
  return parsed;
}

function assertRuntimePortAttestationCommitments(
  value: unknown,
): asserts value is readonly ProductionRuntimePortAttestationCommitment[] {
  if (!Array.isArray(value) || value.length !== PRODUCTION_RUNTIME_PORT_IDS.length) {
    fail();
  }
  for (const [index, expectedPortId] of PRODUCTION_RUNTIME_PORT_IDS.entries()) {
    const commitment = value[index];
    assertExactKeys(commitment, ["portId", "attestationSha256"]);
    if (
      commitment["portId"] !== expectedPortId ||
      typeof commitment["attestationSha256"] !== "string" ||
      !SHA256.test(commitment["attestationSha256"])
    ) {
      fail();
    }
  }
}

export function productionRuntimePortBindingsHash(
  commitments: readonly ProductionRuntimePortAttestationCommitment[],
): string {
  assertRuntimePortAttestationCommitments(commitments);
  return canonicalHash({
    schemaVersion: 1,
    domain: "dark-factory.production-runtime-port-bindings.v1",
    commitments,
  });
}

function unsignedManifest(
  manifest: ProductionOptimizationCompositionManifest,
): Omit<ProductionOptimizationCompositionManifest, "manifestHash" | "signature"> {
  return {
    schemaVersion: manifest.schemaVersion,
    domain: manifest.domain,
    manifestId: manifest.manifestId,
    campaignId: manifest.campaignId,
    lineageId: manifest.lineageId,
    protocolHash: manifest.protocolHash,
    deployment: manifest.deployment,
    components: manifest.components,
    runtimePortAttestations: manifest.runtimePortAttestations,
    bindings: manifest.bindings,
    informationBoundary: manifest.informationBoundary,
    maximumExperimentsPerInvocation: manifest.maximumExperimentsPerInvocation,
    issuedAt: manifest.issuedAt,
    expiresAt: manifest.expiresAt,
  };
}

function assertComponentManifest(
  value: unknown,
  expectedRole: ProductionRuntimeRole,
): asserts value is ProductionRuntimeComponentManifest {
  assertExactKeys(value, [
    "role",
    "boundary",
    "componentId",
    "imageReference",
    "imageDigest",
    "sourceArtifactHash",
    "configurationHash",
  ]);
  const component = value as unknown as ProductionRuntimeComponentManifest;
  if (
    component.role !== expectedRole ||
    component.boundary !== "trusted-cloud" ||
    typeof component.componentId !== "string" ||
    !SAFE_ID.test(component.componentId) ||
    typeof component.imageReference !== "string" ||
    !IMMUTABLE_IMAGE.test(component.imageReference) ||
    typeof component.imageDigest !== "string" ||
    !OCI_DIGEST.test(component.imageDigest) ||
    !component.imageReference.endsWith(`@${component.imageDigest}`) ||
    typeof component.sourceArtifactHash !== "string" ||
    !SHA256.test(component.sourceArtifactHash) ||
    typeof component.configurationHash !== "string" ||
    !SHA256.test(component.configurationHash)
  ) {
    fail();
  }
}

export function assertProductionOptimizationCompositionManifest(
  value: unknown,
  now = new Date(),
): asserts value is ProductionOptimizationCompositionManifest {
  assertExactKeys(value, [
    "schemaVersion",
    "domain",
    "manifestId",
    "campaignId",
    "lineageId",
    "protocolHash",
    "deployment",
    "components",
    "runtimePortAttestations",
    "bindings",
    "informationBoundary",
    "maximumExperimentsPerInvocation",
    "issuedAt",
    "expiresAt",
    "manifestHash",
    "signature",
  ]);
  const document = value as unknown as ProductionOptimizationCompositionManifest;
  assertExactKeys(document.components, ["control", "optimizer", "build", "evaluator"]);
  assertComponentManifest(document.components.control, "control");
  assertComponentManifest(document.components.optimizer, "optimizer");
  assertComponentManifest(document.components.build, "build");
  assertComponentManifest(document.components.evaluator, "evaluator");
  assertRuntimePortAttestationCommitments(document.runtimePortAttestations);
  assertExactKeys(document.bindings, [
    "harnessRegistrationHash",
    "campaignGenesisHash",
    "hiddenCatalogGenesisHash",
    "providerReadinessHash",
    "volumeSemanticsHash",
    "optimizerPluginBundleHash",
    "correctnessPolicyHash",
    "brokerPolicyHash",
    "evaluatorPolicyHash",
    "journalPolicyHash",
  ]);
  assertExactKeys(document.informationBoundary, [
    "containsTaskIdentities",
    "containsPanelIdentities",
    "containsCellIdentities",
    "containsRawEvidence",
    "optimizerHasBenchmarkCredentials",
    "optimizerCanReachEvaluator",
  ]);
  assertExactKeys(document.signature, ["algorithm", "keyId", "signedAt", "signature"]);
  const issuedAt = timestamp(document.issuedAt);
  const expiresAt = timestamp(document.expiresAt);
  const signedAt = timestamp(document.signature.signedAt);
  const current = now.getTime();
  if (
    document.schemaVersion !== 1 ||
    document.domain !== "dark-factory.production-optimization-composition.v1" ||
    typeof document.manifestId !== "string" ||
    !SAFE_ID.test(document.manifestId) ||
    typeof document.campaignId !== "string" ||
    !SAFE_ID.test(document.campaignId) ||
    typeof document.lineageId !== "string" ||
    !SAFE_ID.test(document.lineageId) ||
    typeof document.protocolHash !== "string" ||
    !SHA256.test(document.protocolHash) ||
    document.deployment !== "trusted-cloud" ||
    !Number.isSafeInteger(document.maximumExperimentsPerInvocation) ||
    document.maximumExperimentsPerInvocation < 1 ||
    document.maximumExperimentsPerInvocation > 25 ||
    !Number.isFinite(current) ||
    issuedAt > current ||
    current > expiresAt ||
    issuedAt >= expiresAt ||
    signedAt < issuedAt ||
    signedAt > expiresAt ||
    typeof document.manifestHash !== "string" ||
    !SHA256.test(document.manifestHash) ||
    document.signature.algorithm !== "ed25519" ||
    typeof document.signature.keyId !== "string" ||
    !SAFE_KEY_ID.test(document.signature.keyId) ||
    typeof document.signature.signature !== "string" ||
    !BASE64URL_SIGNATURE.test(document.signature.signature)
  ) {
    fail();
  }
  if (
    Object.values(document.bindings).some(
      (item) => typeof item !== "string" || !SHA256.test(item),
    ) ||
    Object.values(document.informationBoundary).some((item) => item !== false) ||
    document.manifestHash !== canonicalHash(unsignedManifest(document))
  ) {
    fail();
  }
}

function assertVerification(
  verification: ProductionCompositionVerification,
  manifest: ProductionOptimizationCompositionManifest,
  runtimePortAttestations: readonly ProductionRuntimePortAttestationCommitment[],
): void {
  assertExactKeys(verification, [
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
    verification.schemaVersion !== 1 ||
    verification.domain !== "dark-factory.production-composition-verification.v1" ||
    verification.manifestHash !== manifest.manifestHash ||
    verification.signingKeyId !== manifest.signature.keyId ||
    verification.componentBindingsHash !== canonicalHash(manifest.components) ||
    verification.operationalBindingsHash !== canonicalHash(manifest.bindings) ||
    canonicalJson(runtimePortAttestations) !== canonicalJson(manifest.runtimePortAttestations) ||
    verification.runtimePortBindingsHash !==
      productionRuntimePortBindingsHash(runtimePortAttestations) ||
    !SHA256.test(verification.verifierAttestationHash) ||
    verification.verified !== true
  ) {
    fail();
  }
}

function bindTrustedMethod<Arguments extends unknown[], Result>(
  owner: object,
  method: (...arguments_: Arguments) => Result,
): (...arguments_: Arguments) => Result {
  if (typeof method !== "function") fail();
  return (...arguments_: Arguments): Result => method.apply(owner, arguments_);
}

function assertRoleBinding(
  binding: TrustedCloudRoleBinding,
  descriptor: ProductionRuntimeComponentManifest,
): void {
  if (
    binding.boundary !== "trusted-cloud" ||
    binding.role !== descriptor.role ||
    binding.imageDigest !== descriptor.imageDigest ||
    binding.manifestBindingHash !== canonicalHash(descriptor)
  ) {
    fail();
  }
}

function assertRuntimePortBinding(
  value: unknown,
  expectedPortId: ProductionRuntimePortId,
  expectedAttestationSha256: string,
  expectedImplementation: object,
): asserts value is TrustedProductionRuntimePortBinding<ProductionRuntimePortId, object> {
  assertExactKeys(value, ["boundary", "portId", "attestationSha256", "implementation"]);
  if (
    value["boundary"] !== "trusted-cloud-runtime-port-binding" ||
    value["portId"] !== expectedPortId ||
    value["attestationSha256"] !== expectedAttestationSha256 ||
    value["implementation"] !== expectedImplementation
  ) {
    fail();
  }
}

function assertRuntimePortBindings(
  bindings: ProductionOptimizationRuntimePortBindings,
  components: ProductionOptimizationRuntimeComponents,
  manifest: ProductionOptimizationCompositionManifest,
): readonly ProductionRuntimePortAttestationCommitment[] {
  assertExactKeys(bindings, [
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
  const ordered = [
    {
      portId: "control.campaign-state-store",
      binding: bindings.campaignStore,
      implementation: components.control.campaignStore,
    },
    {
      portId: "control.optimization-input-factory",
      binding: bindings.inputFactory,
      implementation: components.control.inputFactory,
    },
    {
      portId: "control.optimization-resume-verifier",
      binding: bindings.resumeVerifier,
      implementation: components.control.resumeVerifier,
    },
    {
      portId: "control.optimization-completion-material",
      binding: bindings.completionMaterial,
      implementation: components.control.completionMaterial,
    },
    {
      portId: "control.optimization-interruption-port",
      binding: bindings.interruption,
      implementation: components.control.interruption,
    },
    {
      portId: "control.experiment-journal",
      binding: bindings.journal,
      implementation: components.control.journal,
    },
    {
      portId: "optimizer.adapter",
      binding: bindings.optimizer,
      implementation: components.optimizer.adapter,
    },
    {
      portId: "build.correctness-gate",
      binding: bindings.gates,
      implementation: components.build.gates,
    },
    {
      portId: "evaluator.blind-broker",
      binding: bindings.broker,
      implementation: components.evaluator.broker,
    },
  ] as const;
  for (const [index, entry] of ordered.entries()) {
    const commitment = manifest.runtimePortAttestations[index];
    if (commitment === undefined || commitment.portId !== entry.portId) {
      fail();
    }
    assertRuntimePortBinding(
      entry.binding,
      entry.portId,
      commitment.attestationSha256,
      entry.implementation,
    );
  }
  const commitments = ordered.map(
    (entry): ProductionRuntimePortAttestationCommitment => ({
      portId: entry.portId,
      attestationSha256: entry.binding.attestationSha256,
    }),
  );
  assertRuntimePortAttestationCommitments(commitments);
  if (canonicalJson(commitments) !== canonicalJson(manifest.runtimePortAttestations)) {
    fail();
  }
  return JSON.parse(
    canonicalJson(commitments),
  ) as readonly ProductionRuntimePortAttestationCommitment[];
}

function assertComponents(
  components: ProductionOptimizationRuntimeComponents,
  manifest: ProductionOptimizationCompositionManifest,
): void {
  assertRoleBinding(components.control, manifest.components.control);
  assertRoleBinding(components.optimizer, manifest.components.optimizer);
  assertRoleBinding(components.build, manifest.components.build);
  assertRoleBinding(components.evaluator, manifest.components.evaluator);
  if (
    components.control.inputFactory.boundary !== "trusted-cloud" ||
    components.control.resumeVerifier.boundary !== "trusted-cloud" ||
    components.control.completionMaterial.boundary !== "trusted-cloud" ||
    components.control.interruption.boundary !== "trusted-cloud"
  ) {
    fail();
  }
}

function assertSnapshotIdentity(
  snapshot: OptimizationLoopSnapshot,
  manifest: ProductionOptimizationCompositionManifest,
): void {
  if (
    snapshot.campaignId !== manifest.campaignId ||
    snapshot.lineageId !== manifest.lineageId ||
    snapshot.protocolHash !== manifest.protocolHash
  ) {
    fail();
  }
}

class VerifiedProductionOptimizationRuntime implements ProductionOptimizationRuntime {
  readonly #manifest: ProductionOptimizationCompositionManifest;
  readonly #verifier: TrustedProductionCompositionAttestationVerifier;
  readonly #runtimePortAttestations: readonly ProductionRuntimePortAttestationCommitment[];
  readonly #coordinator: CampaignStateOptimizationCoordinator;
  readonly #loop: AutonomousOptimizationLoop;
  readonly #now: () => Date;

  public constructor(
    options: ComposeProductionOptimizationRuntimeOptions,
    runtimePortAttestations: readonly ProductionRuntimePortAttestationCommitment[],
    coordinator: CampaignStateOptimizationCoordinator,
    loop: AutonomousOptimizationLoop,
  ) {
    this.#manifest = options.manifest;
    this.#verifier = options.verifier;
    this.#runtimePortAttestations = runtimePortAttestations;
    this.#coordinator = coordinator;
    this.#loop = loop;
    this.#now = options.now ?? (() => new Date());
  }

  async #verify(): Promise<ProductionCompositionVerification> {
    assertProductionOptimizationCompositionManifest(this.#manifest, this.#now());
    const serialized = canonicalJson(this.#manifest);
    const verificationInput = JSON.parse(serialized) as ProductionOptimizationCompositionManifest;
    const serializedRuntimePortAttestations = canonicalJson(this.#runtimePortAttestations);
    const runtimePortAttestationInput = JSON.parse(
      serializedRuntimePortAttestations,
    ) as readonly ProductionRuntimePortAttestationCommitment[];
    const verification = await this.#verifier.verify(
      verificationInput,
      runtimePortAttestationInput,
    );
    if (
      canonicalJson(verificationInput) !== serialized ||
      canonicalJson(runtimePortAttestationInput) !== serializedRuntimePortAttestations
    ) {
      fail();
    }
    assertVerification(verification, this.#manifest, this.#runtimePortAttestations);
    return verification;
  }

  public async status(): Promise<ProductionOptimizationRuntimeStatus> {
    const verification = await this.#verify();
    const snapshot = await this.#coordinator.load();
    assertSnapshotIdentity(snapshot, this.#manifest);
    return {
      schemaVersion: 1,
      domain: "dark-factory.production-optimization-runtime-status.v1",
      manifestId: this.#manifest.manifestId,
      manifestHash: this.#manifest.manifestHash,
      verifierAttestationHash: verification.verifierAttestationHash,
      snapshot,
    };
  }

  public async run(): Promise<ProductionOptimizationRuntimeRunReceipt> {
    const verification = await this.#verify();
    const loop = await this.#loop.run();
    if (
      loop.campaignId !== this.#manifest.campaignId ||
      loop.lineageId !== this.#manifest.lineageId ||
      loop.protocolHash !== this.#manifest.protocolHash
    ) {
      fail();
    }
    return {
      schemaVersion: 1,
      domain: "dark-factory.production-optimization-runtime-run.v1",
      manifestId: this.#manifest.manifestId,
      manifestHash: this.#manifest.manifestHash,
      verifierAttestationHash: verification.verifierAttestationHash,
      loop,
    };
  }
}

/**
 * The only production construction path. The returned object exposes no
 * optimizer, evaluator, broker, journal, state-store, or task-bearing port.
 */
export async function composeProductionOptimizationRuntime(
  options: ComposeProductionOptimizationRuntimeOptions,
): Promise<ProductionOptimizationRuntime> {
  const now = options.now ?? (() => new Date());
  assertProductionOptimizationCompositionManifest(options.manifest, now());
  if (options.verifier.boundary !== "trusted-cloud-attestation-verifier") {
    fail();
  }
  assertComponents(options.components, options.manifest);
  const runtimePortAttestations = assertRuntimePortBindings(
    options.runtimePortBindings,
    options.components,
    options.manifest,
  );
  const canonicalManifest = JSON.parse(
    canonicalJson(options.manifest),
  ) as ProductionOptimizationCompositionManifest;
  const serializedManifest = canonicalJson(canonicalManifest);
  const verificationInput = JSON.parse(
    serializedManifest,
  ) as ProductionOptimizationCompositionManifest;
  const serializedRuntimePortAttestations = canonicalJson(runtimePortAttestations);
  const runtimePortAttestationInput = JSON.parse(
    serializedRuntimePortAttestations,
  ) as readonly ProductionRuntimePortAttestationCommitment[];

  /*
   * Capture every authorized callable now. The composed runtime never retains
   * a caller-owned port object, so replacing a method after attestation cannot
   * change what a later run invokes.
   */
  const sourceStore = options.components.control.campaignStore;
  const campaignStore: OptimizationCampaignStateStore = {
    reconstruct: bindTrustedMethod(sourceStore, sourceStore.reconstruct),
    allocateExperiment: bindTrustedMethod(sourceStore, sourceStore.allocateExperiment),
    recordBudgetUsage: bindTrustedMethod(sourceStore, sourceStore.recordBudgetUsage),
    sealExperiment: bindTrustedMethod(sourceStore, sourceStore.sealExperiment),
    archiveInterruptedExperiment: bindTrustedMethod(
      sourceStore,
      sourceStore.archiveInterruptedExperiment,
    ),
    pause: bindTrustedMethod(sourceStore, sourceStore.pause),
    requestStop: bindTrustedMethod(sourceStore, sourceStore.requestStop),
    acknowledgeStopped: bindTrustedMethod(sourceStore, sourceStore.acknowledgeStopped),
  };
  const sourceInputFactory = options.components.control.inputFactory;
  const inputFactory: TrustedOptimizationInputFactory = {
    boundary: "trusted-cloud",
    prepareOrResume: bindTrustedMethod(sourceInputFactory, sourceInputFactory.prepareOrResume),
    bindClaim: bindTrustedMethod(sourceInputFactory, sourceInputFactory.bindClaim),
  };
  const sourceResumeVerifier = options.components.control.resumeVerifier;
  const resumeVerifier: TrustedOptimizationResumeVerifier = {
    boundary: "trusted-cloud",
    verify: bindTrustedMethod(sourceResumeVerifier, sourceResumeVerifier.verify),
  };
  const sourceCompletion = options.components.control.completionMaterial;
  const completionMaterial: TrustedOptimizationCompletionMaterialPort = {
    boundary: "trusted-cloud",
    createBudgetAccountingAttestation: bindTrustedMethod(
      sourceCompletion,
      sourceCompletion.createBudgetAccountingAttestation,
    ),
    createInterruptedBudgetAccountingAttestation: bindTrustedMethod(
      sourceCompletion,
      sourceCompletion.createInterruptedBudgetAccountingAttestation,
    ),
    createSealMaterial: bindTrustedMethod(sourceCompletion, sourceCompletion.createSealMaterial),
  };
  const sourceInterruption = options.components.control.interruption;
  const interruption: TrustedOptimizationInterruptionPort = {
    boundary: "trusted-cloud",
    begin: bindTrustedMethod(sourceInterruption, sourceInterruption.begin),
    findPending: bindTrustedMethod(sourceInterruption, sourceInterruption.findPending),
    prepareControl: bindTrustedMethod(sourceInterruption, sourceInterruption.prepareControl),
    markApplied: bindTrustedMethod(sourceInterruption, sourceInterruption.markApplied),
  };
  const sourceJournal = options.components.control.journal;
  const journal: ExperimentJournal = {
    create: bindTrustedMethod(sourceJournal, sourceJournal.create),
    freezeProposal: bindTrustedMethod(sourceJournal, sourceJournal.freezeProposal),
    recordGates: bindTrustedMethod(sourceJournal, sourceJournal.recordGates),
    recordRepair: bindTrustedMethod(sourceJournal, sourceJournal.recordRepair),
    recordValidation: bindTrustedMethod(sourceJournal, sourceJournal.recordValidation),
    recordAnalysis: bindTrustedMethod(sourceJournal, sourceJournal.recordAnalysis),
    updateBudget: bindTrustedMethod(sourceJournal, sourceJournal.updateBudget),
    seal: bindTrustedMethod(sourceJournal, sourceJournal.seal),
    interrupt: bindTrustedMethod(sourceJournal, sourceJournal.interrupt),
  };
  const sourceOptimizer = options.components.optimizer.adapter;
  const optimizer: OptimizerAdapter = {
    propose: bindTrustedMethod(sourceOptimizer, sourceOptimizer.propose),
    analyze: bindTrustedMethod(sourceOptimizer, sourceOptimizer.analyze),
  };
  const sourceGates = options.components.build.gates;
  const gates: CorrectnessGateRunner = {
    run: bindTrustedMethod(sourceGates, sourceGates.run),
  };
  const sourceBroker = options.components.evaluator.broker;
  const broker: BlindBroker = {
    prepareRepair: bindTrustedMethod(sourceBroker, sourceBroker.prepareRepair),
    runRepair: bindTrustedMethod(sourceBroker, sourceBroker.runRepair),
    prepareValidation: bindTrustedMethod(sourceBroker, sourceBroker.prepareValidation),
    runValidation: bindTrustedMethod(sourceBroker, sourceBroker.runValidation),
    consumeOrQuarantine: bindTrustedMethod(sourceBroker, sourceBroker.consumeOrQuarantine),
    releaseDiagnosticBrief: bindTrustedMethod(sourceBroker, sourceBroker.releaseDiagnosticBrief),
  };
  const sourceManifestVerifier = options.verifier;
  const verifier: TrustedProductionCompositionAttestationVerifier = {
    boundary: "trusted-cloud-attestation-verifier",
    verify: bindTrustedMethod(sourceManifestVerifier, sourceManifestVerifier.verify),
  };
  const verification = await verifier.verify(verificationInput, runtimePortAttestationInput);
  if (
    canonicalJson(verificationInput) !== serializedManifest ||
    canonicalJson(runtimePortAttestationInput) !== serializedRuntimePortAttestations
  ) {
    fail();
  }
  assertVerification(verification, canonicalManifest, runtimePortAttestations);
  const runner = new ExperimentRunner({
    optimizer,
    gates,
    broker,
    journal,
    now,
  });
  const coordinator = new CampaignStateOptimizationCoordinator({
    store: campaignStore,
    inputFactory,
    resumeVerifier,
    completionMaterial,
    interruption,
  });
  const loop = new AutonomousOptimizationLoop({
    runner,
    coordinator,
    maximumExperimentsPerInvocation: canonicalManifest.maximumExperimentsPerInvocation,
    now,
  });
  return new VerifiedProductionOptimizationRuntime(
    {
      ...options,
      manifest: canonicalManifest,
      verifier,
      now,
    },
    runtimePortAttestations,
    coordinator,
    loop,
  );
}
