import {
  createPublicKey,
  KeyObject,
  type KeyLike,
} from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";

import {
  CampaignStateStore,
  type CampaignControlAttestationVerifier,
  type CampaignDecisionAttestationVerifier,
  type CampaignLedgerTransitionVerifier,
} from "../campaign/store.js";
import {
  ExperimentStore,
  type ExperimentStoreOptions,
} from "../evidence/store.js";
import type {
  TrustedCandidateBuildReceiptVerifier,
} from "../harness/candidate-build-runner.js";
import type {
  TrustedGitPublicationReceiptVerifier,
} from "../harness/git-publication.js";
import type {
  TrustedGitSourceReceiptVerifier,
} from "../harness/git-source.js";
import {
  ArtifactBackedCloudOptimizerAdapterResolver,
  type ArtifactBackedCloudOptimizerAdapterResolverOptions,
} from "../optimizer/artifact-backed-resolver.js";
import {
  CloudOnlyClaudeOptimizerSession,
  createCloudOnlyClaudeOptimizerAdapter,
  type CloudOptimizerSessionOptions,
} from "../optimizer/cloud-session.js";
import {
  ProductionBlindBroker,
  type TrustedAdaptiveReleaseSignatureVerifier,
} from "../orchestrator/blind-broker.js";
import {
  type OptimizationCampaignStateStore,
  type TrustedOptimizationCompletionMaterialPort,
  type TrustedOptimizationInputFactory,
  type TrustedOptimizationInterruptionPort,
  type TrustedOptimizationResumeVerifier,
} from "../orchestrator/campaign-state-coordinator.js";
import type {
  BlindBroker,
  CorrectnessGateRunner,
  ExperimentJournal,
  OptimizerAdapter,
} from "../orchestrator/contracts.js";
import {
  ProductionCorrectnessGateRunner,
  type ProductionCorrectnessGateOptions,
} from "../orchestrator/correctness-gate.js";
import {
  ProductionExperimentJournal,
} from "../orchestrator/experiment-journal.js";
import {
  ProductionOptimizationCompletionMaterial,
  type ProductionOptimizationCompletionMaterialOptions,
} from "../orchestrator/production-completion-material.js";
import type {
  ProductionOptimizeRuntimeAssembly,
  ProductionOptimizeRuntimeFactoryInput,
  TrustedProductionOptimizeCloseable,
  TrustedProductionOptimizeRuntimeFactory,
} from "./production-optimize-composition-owner.js";
import {
  PRODUCTION_RUNTIME_PORT_IDS,
  assertProductionOptimizationCompositionManifest,
  productionRuntimePortBindingsHash,
  type ProductionOptimizationCompositionManifest,
  type ProductionOptimizationRuntimeComponents,
  type ProductionOptimizationRuntimePortBindings,
  type ProductionRuntimePortAttestationCommitment,
  type ProductionRuntimeRole,
  type TrustedProductionRuntimePortBinding,
} from "../orchestrator/production-runtime.js";
import {
  CasBlindBrokerEvaluationConfigurationResolver,
  LeaseStoreTrustedRepairDiscoveryResolver,
  SignedGitSourceHarnessArtifactResolver,
  type CasBlindBrokerEvaluationConfigurationResolverOptions,
  type SignedGitSourceHarnessArtifactResolverOptions,
} from "../orchestrator/trusted-port-adapters.js";
import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import {
  ArtifactBackedEvaluationReleaseBundleService,
  type ArtifactBackedEvaluationReleaseBundleServiceOptions,
} from "../evaluator/release-bundle-service.js";
import {
  MountedVolumeAtomicBlindBrokerLeaseStore,
  MountedVolumeTrustedDiagnosticBriefPublisher,
} from "./mounted-volume-blind-broker-ports.js";
import {
  MountedVolumeCorrectnessGateRecordStore,
  MountedVolumeTrustedCandidateSourceIndex,
  type MountedVolumeCorrectnessGateRecordStoreOptions,
  type MountedVolumeTrustedCandidateSourceIndexOptions,
} from "./mounted-volume-correctness-gate-ports.js";
import {
  MountedVolumeReleaseSafeExperimentArtifactAssembler,
  MountedVolumeTrustedExperimentSealAuthority,
  MountedVolumeTrustedJournalInterruptionAttestor,
  type MountedVolumeReleaseSafeExperimentArtifactAssemblerOptions,
  type MountedVolumeTrustedExperimentSealAuthorityOptions,
} from "./mounted-volume-experiment-journal-authorities.js";
import {
  MountedVolumeAtomicExperimentJournalStateStore,
} from "./mounted-volume-experiment-journal.js";
import {
  MountedVolumeOptimizationCoordinationPorts,
  type MountedVolumeOptimizationCoordinationPortsOptions,
} from "./mounted-volume-optimization-coordination.js";
import {
  MountedVolumeCloudOptimizerSessionRecordStore,
  type MountedVolumeDurableStateOptions,
} from "./mounted-volume-state.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_STORE_ID =
  /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;

const FACTORY_OPTION_KEYS = [
  "attestation",
  "attestationAuthority",
  "durableState",
  "campaignState",
  "coordination",
  "completion",
  "journal",
  "optimizer",
  "correctness",
  "broker",
  "operationalBindings",
  "now",
] as const;

const GROUP_KEYS = {
  campaignState: [
    "ledgerTransitionVerifier",
    "decisionAttestationVerifier",
    "controlAttestationVerifier",
  ],
  coordination: [
    "diagnosticResolver",
    "resumeAuthority",
    "interruptionAuthority",
  ],
  completion: [
    "onlineErrorAuthority",
    "operationLedgerUsage",
    "accountingAuthority",
    "sealAuthority",
  ],
  journal: [
    "experimentStore",
    "artifactAssembler",
    "sealAuthority",
  ],
  optimizer: ["session", "resolver"],
  correctness: [
    "recordStore",
    "sourceIndex",
    "scanner",
    "builder",
    "publisher",
    "snapshotter",
    "integrityPolicyHash",
    "buildPolicyHash",
  ],
  broker: [
    "configuration",
    "harness",
    "release",
    "signatureVerifier",
  ],
  operationalBindings: [
    "providerReadinessHash",
    "volumeSemanticsHash",
    "correctnessPolicyHash",
    "brokerPolicyHash",
    "evaluatorPolicyHash",
    "journalPolicyHash",
  ],
} as const;

type ComponentCommitmentMap = Readonly<
  Record<ProductionRuntimeRole, string>
>;

export interface ProductionRuntimeFactoryDependencyAttestation {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.production-runtime-factory-dependencies.v1";
  readonly boundary:
    "trusted-cloud-production-runtime-dependency-attestation";
  readonly manifestHash: string;
  readonly componentManifestHashes: ComponentCommitmentMap;
  readonly operationalBindingsHash: string;
  readonly runtimePortBindingsHash: string;
  readonly runtimePortAttestations:
    readonly ProductionRuntimePortAttestationCommitment[];
  readonly containsTaskIdentifiers: false;
  readonly attestationHash: string;
}

export interface ProductionRuntimeFactoryDependencyVerification {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.production-runtime-factory-dependency-verification.v1";
  readonly attestationHash: string;
  readonly manifestHash: string;
  readonly compositionVerifierAttestationHash: string;
  readonly verified: true;
  readonly authorityAttestationHash: string;
}

/**
 * Provider/KMS-backed authority for the independently produced dependency
 * attestation. It authenticates commitments only and cannot return or select
 * an executable implementation.
 */
export interface TrustedProductionRuntimeFactoryDependencyAttestationAuthority {
  readonly boundary:
    "trusted-cloud-production-runtime-dependency-attestation-authority";
  verify(input: {
    readonly attestation:
      ProductionRuntimeFactoryDependencyAttestation;
    readonly manifestHash: string;
    readonly compositionVerifierAttestationHash: string;
  }): Promise<ProductionRuntimeFactoryDependencyVerification>;
}

export interface ProductionRuntimeCampaignStateDependencies {
  readonly ledgerTransitionVerifier: CampaignLedgerTransitionVerifier;
  readonly decisionAttestationVerifier:
    CampaignDecisionAttestationVerifier;
  readonly controlAttestationVerifier:
    CampaignControlAttestationVerifier;
}

export type ProductionRuntimeCoordinationDependencies = Omit<
  MountedVolumeOptimizationCoordinationPortsOptions,
  "durableState"
>;

export type ProductionRuntimeCompletionDependencies = Omit<
  ProductionOptimizationCompletionMaterialOptions,
  "journalStateStore"
>;

export interface ProductionRuntimeJournalDependencies {
  readonly experimentStore: Omit<ExperimentStoreOptions, "now">;
  readonly artifactAssembler: Omit<
    MountedVolumeReleaseSafeExperimentArtifactAssemblerOptions,
    "durableState"
  >;
  readonly sealAuthority: Omit<
    MountedVolumeTrustedExperimentSealAuthorityOptions,
    "durableState"
  >;
}

export interface ProductionRuntimeOptimizerDependencies {
  readonly session: CloudOptimizerSessionOptions;
  readonly resolver: Omit<
    ArtifactBackedCloudOptimizerAdapterResolverOptions,
    "sourceIndex"
  >;
}

export interface ProductionRuntimeCorrectnessDependencies {
  readonly recordStore: Omit<
    MountedVolumeCorrectnessGateRecordStoreOptions,
    "durableState"
  >;
  readonly sourceIndex: Omit<
    MountedVolumeTrustedCandidateSourceIndexOptions,
    "durableState"
  >;
  readonly scanner: ProductionCorrectnessGateOptions["scanner"];
  readonly builder: ProductionCorrectnessGateOptions["builder"];
  readonly publisher: ProductionCorrectnessGateOptions["publisher"];
  readonly snapshotter: ProductionCorrectnessGateOptions["snapshotter"];
  readonly integrityPolicyHash: string;
  readonly buildPolicyHash: string;
}

export interface ProductionRuntimeBrokerDependencies {
  readonly configuration:
    CasBlindBrokerEvaluationConfigurationResolverOptions;
  readonly harness: Omit<
    SignedGitSourceHarnessArtifactResolverOptions,
    "source"
  >;
  readonly release: Omit<
    ArtifactBackedEvaluationReleaseBundleServiceOptions,
    "now"
  >;
  readonly signatureVerifier:
    TrustedAdaptiveReleaseSignatureVerifier;
}

export interface ProductionRuntimeOperationalBindings {
  readonly providerReadinessHash: string;
  readonly volumeSemanticsHash: string;
  readonly correctnessPolicyHash: string;
  readonly brokerPolicyHash: string;
  readonly evaluatorPolicyHash: string;
  readonly journalPolicyHash: string;
}

export interface ProductionTrustedCloudRuntimeFactoryOptions {
  readonly attestation:
    ProductionRuntimeFactoryDependencyAttestation;
  readonly attestationAuthority:
    TrustedProductionRuntimeFactoryDependencyAttestationAuthority;
  readonly durableState: MountedVolumeDurableStateOptions;
  readonly campaignState:
    ProductionRuntimeCampaignStateDependencies;
  readonly coordination:
    ProductionRuntimeCoordinationDependencies;
  readonly completion:
    ProductionRuntimeCompletionDependencies;
  readonly journal: ProductionRuntimeJournalDependencies;
  readonly optimizer: ProductionRuntimeOptimizerDependencies;
  readonly correctness:
    ProductionRuntimeCorrectnessDependencies;
  readonly broker: ProductionRuntimeBrokerDependencies;
  readonly operationalBindings:
    ProductionRuntimeOperationalBindings;
  readonly now?: () => Date;
}

export class ProductionTrustedCloudRuntimeFactoryError extends Error {
  override readonly name =
    "ProductionTrustedCloudRuntimeFactoryError";

  public constructor() {
    super("Production trusted-cloud runtime factory failed closed.");
  }
}

function fail(): never {
  throw new ProductionTrustedCloudRuntimeFactoryError();
}

function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
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
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !expected.includes(key) ||
        !Object.hasOwn(
          Object.getOwnPropertyDescriptor(value, key) ?? {},
          "value",
        ),
    )
  ) {
    fail();
  }
}

function assertHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) fail();
}

function cloneCanonical<Value>(value: Value): Value {
  try {
    return JSON.parse(canonicalJson(value)) as Value;
  } catch {
    return fail();
  }
}

function readNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail();
  }
  return new Date(value.getTime());
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") fail();
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    fail();
  }
  return parsed;
}

function captureMethod<
  Owner extends object,
  Arguments extends unknown[],
  Result,
>(
  owner: Owner,
  method: (...arguments_: Arguments) => Result,
): (...arguments_: Arguments) => Result {
  if (
    (typeof owner !== "object" && typeof owner !== "function") ||
    owner === null ||
    typeof method !== "function"
  ) {
    fail();
  }
  return method.bind(owner);
}

function capturePublicKey(value: KeyLike): KeyObject {
  try {
    if (!(value instanceof KeyObject) || value.type !== "public") {
      fail();
    }
    const key = createPublicKey({
      key: value.export({
        format: "der",
        type: "spki",
      }),
      format: "der",
      type: "spki",
    });
    if (
      key.type !== "public" ||
      key.asymmetricKeyType !== "ed25519"
    ) {
      fail();
    }
    return key;
  } catch {
    return fail();
  }
}

function assertAttestation(
  value: unknown,
): asserts value is ProductionRuntimeFactoryDependencyAttestation {
  assertExactKeys(value, [
    "schemaVersion",
    "domain",
    "boundary",
    "manifestHash",
    "componentManifestHashes",
    "operationalBindingsHash",
    "runtimePortBindingsHash",
    "runtimePortAttestations",
    "containsTaskIdentifiers",
    "attestationHash",
  ]);
  assertExactKeys(value.componentManifestHashes, [
    "control",
    "optimizer",
    "build",
    "evaluator",
  ]);
  for (const hash of Object.values(value.componentManifestHashes)) {
    assertHash(hash);
  }
  assertHash(value.manifestHash);
  assertHash(value.operationalBindingsHash);
  assertHash(value.runtimePortBindingsHash);
  assertHash(value.attestationHash);
  if (
    value.schemaVersion !== 1 ||
    value.domain !==
      "dark-factory.production-runtime-factory-dependencies.v1" ||
    value.boundary !==
      "trusted-cloud-production-runtime-dependency-attestation" ||
    value.containsTaskIdentifiers !== false ||
    !Array.isArray(value.runtimePortAttestations) ||
    value.runtimePortAttestations.length !==
      PRODUCTION_RUNTIME_PORT_IDS.length
  ) {
    fail();
  }
  for (const [index, portId] of PRODUCTION_RUNTIME_PORT_IDS.entries()) {
    const entry = value.runtimePortAttestations[index];
    assertExactKeys(entry, ["portId", "attestationSha256"]);
    if (entry.portId !== portId) fail();
    assertHash(entry.attestationSha256);
  }
  if (
    value.runtimePortBindingsHash !==
      productionRuntimePortBindingsHash(
        value.runtimePortAttestations,
      )
  ) {
    fail();
  }
  const {
    attestationHash: _attestationHash,
    ...unsigned
  } = value;
  if (value.attestationHash !== canonicalHash(unsigned)) fail();
}

function captureDurableState(
  options: MountedVolumeDurableStateOptions,
  now: () => Date,
): MountedVolumeDurableStateOptions {
  if (
    !isAbsolute(options.volumeRoot) ||
    normalize(options.volumeRoot) !== options.volumeRoot ||
    options.volumeRoot === "/" ||
    options.volumeRoot.includes("\u0000") ||
    !SAFE_STORE_ID.test(options.storeId)
  ) {
    fail();
  }
  assertHash(options.controllerInstanceIdHash);
  const assertTrustedCloudRuntime = captureMethod(
    options.runtimeGuard,
    options.runtimeGuard.assertTrustedCloudRuntime,
  );
  const assertLinearizableStateVolume = captureMethod(
    options.semanticsGuard,
    options.semanticsGuard.assertLinearizableStateVolume,
  );
  const recoveryAuthority =
    options.recoveryAuthority === undefined
      ? undefined
      : {
          authorize: captureMethod(
            options.recoveryAuthority,
            options.recoveryAuthority.authorize,
          ),
        };
  const nonceFactory =
    options.nonceFactory === undefined
      ? undefined
      : captureMethod(
          { invoke: options.nonceFactory },
          options.nonceFactory,
        );
  return Object.freeze({
    volumeRoot: options.volumeRoot,
    storeId: options.storeId,
    controllerInstanceIdHash:
      options.controllerInstanceIdHash,
    runtimeGuard: Object.freeze({
      assertTrustedCloudRuntime,
    }),
    semanticsGuard: Object.freeze({
      assertLinearizableStateVolume,
    }),
    ...(recoveryAuthority === undefined
      ? {}
      : {
          recoveryAuthority: Object.freeze(
            recoveryAuthority,
          ),
        }),
    now,
    ...(nonceFactory === undefined ? {} : { nonceFactory }),
    ...(options.maximumStateBytes === undefined
      ? {}
      : { maximumStateBytes: options.maximumStateBytes }),
  });
}

function captureCampaignState(
  value: ProductionRuntimeCampaignStateDependencies,
): ProductionRuntimeCampaignStateDependencies {
  return Object.freeze({
    ledgerTransitionVerifier: Object.freeze({
      verify: captureMethod(
        value.ledgerTransitionVerifier,
        value.ledgerTransitionVerifier.verify,
      ),
    }),
    decisionAttestationVerifier: Object.freeze({
      verify: captureMethod(
        value.decisionAttestationVerifier,
        value.decisionAttestationVerifier.verify,
      ),
    }),
    controlAttestationVerifier: Object.freeze({
      verify: captureMethod(
        value.controlAttestationVerifier,
        value.controlAttestationVerifier.verify,
      ),
    }),
  });
}

function captureCoordination(
  value: ProductionRuntimeCoordinationDependencies,
): ProductionRuntimeCoordinationDependencies {
  return Object.freeze({
    diagnosticResolver: Object.freeze({
      boundary: value.diagnosticResolver.boundary,
      resolve: captureMethod(
        value.diagnosticResolver,
        value.diagnosticResolver.resolve,
      ),
    }),
    resumeAuthority: Object.freeze({
      boundary: value.resumeAuthority.boundary,
      verifyAndAttest: captureMethod(
        value.resumeAuthority,
        value.resumeAuthority.verifyAndAttest,
      ),
    }),
    interruptionAuthority: Object.freeze({
      boundary: value.interruptionAuthority.boundary,
      attestBrokerExposure: captureMethod(
        value.interruptionAuthority,
        value.interruptionAuthority.attestBrokerExposure,
      ),
      authorizeControl: captureMethod(
        value.interruptionAuthority,
        value.interruptionAuthority.authorizeControl,
      ),
    }),
  });
}

function captureCompletion(
  value: ProductionRuntimeCompletionDependencies,
): ProductionRuntimeCompletionDependencies {
  return Object.freeze({
    onlineErrorAuthority: Object.freeze({
      boundary: value.onlineErrorAuthority.boundary,
      reserve: captureMethod(
        value.onlineErrorAuthority,
        value.onlineErrorAuthority.reserve,
      ),
      reconcile: captureMethod(
        value.onlineErrorAuthority,
        value.onlineErrorAuthority.reconcile,
      ),
    }),
    operationLedgerUsage: Object.freeze({
      boundary: value.operationLedgerUsage.boundary,
      closeAndRead: captureMethod(
        value.operationLedgerUsage,
        value.operationLedgerUsage.closeAndRead,
      ),
    }),
    accountingAuthority: Object.freeze({
      boundary: value.accountingAuthority.boundary,
      attestCompletion: captureMethod(
        value.accountingAuthority,
        value.accountingAuthority.attestCompletion,
      ),
      attestInterruption: captureMethod(
        value.accountingAuthority,
        value.accountingAuthority.attestInterruption,
      ),
    }),
    sealAuthority: Object.freeze({
      boundary: value.sealAuthority.boundary,
      authorize: captureMethod(
        value.sealAuthority,
        value.sealAuthority.authorize,
      ),
    }),
  });
}

function captureJournal(
  value: ProductionRuntimeJournalDependencies,
): ProductionRuntimeJournalDependencies {
  const trustedLeakScanner =
    value.experimentStore.trustedLeakScanner;
  const experimentStore: Omit<ExperimentStoreOptions, "now"> = {
    ...(trustedLeakScanner === undefined
      ? {}
      : {
          trustedLeakScanner: Object.freeze({
            keyId: trustedLeakScanner.keyId,
            publicKey: capturePublicKey(
              trustedLeakScanner.publicKey,
            ),
          }),
        }),
    ...(value.experimentStore.maximumLeakScanReceiptAgeMs ===
    undefined
      ? {}
      : {
          maximumLeakScanReceiptAgeMs:
            value.experimentStore
              .maximumLeakScanReceiptAgeMs,
        }),
    ...(value.experimentStore.maximumLeakScanClockSkewMs ===
    undefined
      ? {}
      : {
          maximumLeakScanClockSkewMs:
            value.experimentStore
              .maximumLeakScanClockSkewMs,
        }),
  };
  return Object.freeze({
    experimentStore: Object.freeze(experimentStore),
    artifactAssembler: Object.freeze({
      policyProvider: Object.freeze({
        provide: captureMethod(
          value.artifactAssembler.policyProvider,
          value.artifactAssembler.policyProvider.provide,
        ),
      }),
      provenanceProvider: Object.freeze({
        provide: captureMethod(
          value.artifactAssembler.provenanceProvider,
          value.artifactAssembler.provenanceProvider.provide,
        ),
      }),
      taskIdentityExclusionAuthority: Object.freeze({
        assertTaskFree: captureMethod(
          value.artifactAssembler
            .taskIdentityExclusionAuthority,
          value.artifactAssembler
            .taskIdentityExclusionAuthority.assertTaskFree,
        ),
      }),
    }),
    sealAuthority: Object.freeze({
      scanner: Object.freeze({
        boundary: value.sealAuthority.scanner.boundary,
        scan: captureMethod(
          value.sealAuthority.scanner,
          value.sealAuthority.scanner.scan,
        ),
      }),
      keyAuthority: Object.freeze({
        boundary: value.sealAuthority.keyAuthority.boundary,
        keyId: value.sealAuthority.keyAuthority.keyId,
        signLeakScanReceipt: captureMethod(
          value.sealAuthority.keyAuthority,
          value.sealAuthority.keyAuthority.signLeakScanReceipt,
        ),
      }),
      scannerPublicKey:
        capturePublicKey(
          value.sealAuthority.scannerPublicKey,
        ),
      pinnedVersions: Object.freeze({
        resolve: captureMethod(
          value.sealAuthority.pinnedVersions,
          value.sealAuthority.pinnedVersions.resolve,
        ),
      }),
    }),
  });
}

function captureCloudProvider(
  provider: CloudOptimizerSessionOptions["provider"],
): CloudOptimizerSessionOptions["provider"] {
  return Object.freeze({
    name: provider.name,
    configuration: cloneCanonical(provider.configuration),
    probe: captureMethod(provider, provider.probe),
    create: captureMethod(provider, provider.create),
    execute: captureMethod(provider, provider.execute),
    upload: captureMethod(provider, provider.upload),
    download: captureMethod(provider, provider.download),
    cancel: captureMethod(provider, provider.cancel),
    destroy: captureMethod(provider, provider.destroy),
  });
}

function captureOptimizer(
  value: ProductionRuntimeOptimizerDependencies,
): ProductionRuntimeOptimizerDependencies {
  const session: CloudOptimizerSessionOptions = Object.freeze({
    provider: captureCloudProvider(value.session.provider),
    sandbox: cloneCanonical(value.session.sandbox),
    workerArtifact: cloneCanonical(
      value.session.workerArtifact,
    ),
    pluginArtifact: cloneCanonical(
      value.session.pluginArtifact,
    ),
    artifactReader: Object.freeze({
      readUtf8: captureMethod(
        value.session.artifactReader,
        value.session.artifactReader.readUtf8,
      ),
    }),
    claude: cloneCanonical(value.session.claude),
    optimizerSecretReferences: cloneCanonical(
      value.session.optimizerSecretReferences,
    ),
  });
  const resolver = value.resolver;
  return Object.freeze({
    session,
    resolver: Object.freeze({
      registration: cloneCanonical(resolver.registration),
      sourceOnlyBootstrapMetadataArtifact: cloneCanonical(
        resolver.sourceOnlyBootstrapMetadataArtifact,
      ),
      evidenceSource: Object.freeze({
        boundary: resolver.evidenceSource.boundary,
        locate: captureMethod(
          resolver.evidenceSource,
          resolver.evidenceSource.locate,
        ),
      }),
      artifactReader: Object.freeze({
        boundary: resolver.artifactReader.boundary,
        readUtf8: captureMethod(
          resolver.artifactReader,
          resolver.artifactReader.readUtf8,
        ),
      }),
      releaseArtifactReader: Object.freeze({
        boundary: resolver.releaseArtifactReader.boundary,
        readBytes: captureMethod(
          resolver.releaseArtifactReader,
          resolver.releaseArtifactReader.readBytes,
        ),
      }),
      releaseArtifactInspectionPolicy: cloneCanonical(
        resolver.releaseArtifactInspectionPolicy,
      ),
      keyAuthority: Object.freeze({
        boundary: resolver.keyAuthority.boundary,
        resolve: captureMethod(
          resolver.keyAuthority,
          resolver.keyAuthority.resolve,
        ),
      }),
      authoritySetHash: resolver.authoritySetHash,
      verificationKeySetHash:
        resolver.verificationKeySetHash,
      ...(resolver.maximumMetadataBytes === undefined
        ? {}
        : {
            maximumMetadataBytes:
              resolver.maximumMetadataBytes,
          }),
      ...(resolver.maximumEvidenceBytes === undefined
        ? {}
        : {
            maximumEvidenceBytes:
              resolver.maximumEvidenceBytes,
          }),
    }),
  });
}

function captureBuildVerifier(
  value: TrustedCandidateBuildReceiptVerifier,
): TrustedCandidateBuildReceiptVerifier {
  return Object.freeze({
    trustedKeyId: value.trustedKeyId,
    publicKey: capturePublicKey(value.publicKey),
  });
}

function capturePublicationVerifier(
  value: TrustedGitPublicationReceiptVerifier,
): TrustedGitPublicationReceiptVerifier {
  return Object.freeze({
    trustedKeyId: value.trustedKeyId,
    publicKey: capturePublicKey(value.publicKey),
  });
}

function captureSourceVerifier(
  value: TrustedGitSourceReceiptVerifier,
): TrustedGitSourceReceiptVerifier {
  return Object.freeze({
    trustedKeyId: value.trustedKeyId,
    publicKey: capturePublicKey(value.publicKey),
  });
}

function captureCorrectness(
  value: ProductionRuntimeCorrectnessDependencies,
): ProductionRuntimeCorrectnessDependencies {
  return Object.freeze({
    recordStore: Object.freeze({
      candidateBuildVerifier: captureBuildVerifier(
        value.recordStore.candidateBuildVerifier,
      ),
      gitPublicationVerifier: capturePublicationVerifier(
        value.recordStore.gitPublicationVerifier,
      ),
      gitSourceVerifier: captureSourceVerifier(
        value.recordStore.gitSourceVerifier,
      ),
    }),
    sourceIndex: Object.freeze({
      sourceReceiptVerifier: captureSourceVerifier(
        value.sourceIndex.sourceReceiptVerifier,
      ),
      attestationAuthority: Object.freeze({
        boundary:
          value.sourceIndex.attestationAuthority.boundary,
        attest: captureMethod(
          value.sourceIndex.attestationAuthority,
          value.sourceIndex.attestationAuthority.attest,
        ),
      }),
    }),
    scanner: Object.freeze({
      boundary: value.scanner.boundary,
      scan: captureMethod(value.scanner, value.scanner.scan),
    }),
    builder: Object.freeze({
      boundary: value.builder.boundary,
      build: captureMethod(value.builder, value.builder.build),
    }),
    publisher: Object.freeze({
      boundary: value.publisher.boundary,
      publish: captureMethod(
        value.publisher,
        value.publisher.publish,
      ),
    }),
    snapshotter: Object.freeze({
      boundary: value.snapshotter.boundary,
      snapshot: captureMethod(
        value.snapshotter,
        value.snapshotter.snapshot,
      ),
    }),
    integrityPolicyHash: value.integrityPolicyHash,
    buildPolicyHash: value.buildPolicyHash,
  });
}

function captureBroker(
  value: ProductionRuntimeBrokerDependencies,
): ProductionRuntimeBrokerDependencies {
  const release = value.release;
  return Object.freeze({
    configuration: Object.freeze({
      source: Object.freeze({
        boundary: value.configuration.source.boundary,
        locate: captureMethod(
          value.configuration.source,
          value.configuration.source.locate,
        ),
      }),
      reader: Object.freeze({
        readUtf8: captureMethod(
          value.configuration.reader,
          value.configuration.reader.readUtf8,
        ),
      }),
      ...(value.configuration.maximumBytes === undefined
        ? {}
        : { maximumBytes: value.configuration.maximumBytes }),
    }),
    harness: Object.freeze({
      keyring: Object.freeze({
        getVerificationKey: captureMethod(
          value.harness.keyring,
          value.harness.keyring.getVerificationKey,
        ),
      }),
      trustedKeyIds: Object.freeze([
        ...value.harness.trustedKeyIds,
      ]),
      registrationId: value.harness.registrationId,
      originRepositoryHash:
        value.harness.originRepositoryHash,
    }),
    release: Object.freeze({
      service: Object.freeze({
        boundary: release.service.boundary,
        evaluate: captureMethod(
          release.service,
          release.service.evaluate,
        ),
      }),
      source: Object.freeze({
        boundary: release.source.boundary,
        locate: captureMethod(
          release.source,
          release.source.locate,
        ),
      }),
      reader: Object.freeze({
        boundary: release.reader.boundary,
        readUtf8: captureMethod(
          release.reader,
          release.reader.readUtf8,
        ),
      }),
      signatureVerifier: Object.freeze({
        boundary: release.signatureVerifier.boundary,
        verify: captureMethod(
          release.signatureVerifier,
          release.signatureVerifier.verify,
        ),
      }),
      ...(release.maximumArtifactBytes === undefined
        ? {}
        : {
            maximumArtifactBytes:
              release.maximumArtifactBytes,
          }),
      ...(release.maximumTotalBytes === undefined
        ? {}
        : { maximumTotalBytes: release.maximumTotalBytes }),
      ...(release.maximumReplayRecords === undefined
        ? {}
        : {
            maximumReplayRecords:
              release.maximumReplayRecords,
          }),
      ...(release.maximumClockSkewMs === undefined
        ? {}
        : {
            maximumClockSkewMs:
              release.maximumClockSkewMs,
          }),
    }),
    signatureVerifier: Object.freeze({
      verify: captureMethod(
        value.signatureVerifier,
        value.signatureVerifier.verify,
      ),
    }),
  });
}

interface CapturedFactoryOptions {
  readonly attestation:
    ProductionRuntimeFactoryDependencyAttestation;
  readonly verifyDependencyAttestation:
    TrustedProductionRuntimeFactoryDependencyAttestationAuthority["verify"];
  readonly durableState: MountedVolumeDurableStateOptions;
  readonly campaignState:
    ProductionRuntimeCampaignStateDependencies;
  readonly coordination:
    ProductionRuntimeCoordinationDependencies;
  readonly completion:
    ProductionRuntimeCompletionDependencies;
  readonly journal: ProductionRuntimeJournalDependencies;
  readonly optimizer: ProductionRuntimeOptimizerDependencies;
  readonly correctness:
    ProductionRuntimeCorrectnessDependencies;
  readonly broker: ProductionRuntimeBrokerDependencies;
  readonly operationalBindings:
    ProductionRuntimeOperationalBindings;
  readonly now: () => Date;
}

function captureOptions(
  options: ProductionTrustedCloudRuntimeFactoryOptions,
): CapturedFactoryOptions {
  try {
    assertExactKeys(
      options,
      options.now === undefined
        ? FACTORY_OPTION_KEYS.filter((key) => key !== "now")
        : FACTORY_OPTION_KEYS,
    );
    for (const [group, keys] of Object.entries(GROUP_KEYS)) {
      assertExactKeys(
        options[group as keyof typeof GROUP_KEYS],
        keys,
      );
    }
    assertAttestation(options.attestation);
    if (
      options.attestationAuthority.boundary !==
        "trusted-cloud-production-runtime-dependency-attestation-authority" ||
      typeof options.attestationAuthority.verify !== "function"
    ) {
      fail();
    }
    const sourceNow =
      options.now ?? options.durableState.now ?? (() => new Date());
    const now = (): Date => readNow(sourceNow);
    const operationalBindings = cloneCanonical(
      options.operationalBindings,
    );
    for (const hash of Object.values(operationalBindings)) {
      assertHash(hash);
    }
    return Object.freeze({
      attestation: Object.freeze(
        cloneCanonical(options.attestation),
      ),
      verifyDependencyAttestation: captureMethod(
        options.attestationAuthority,
        options.attestationAuthority.verify,
      ),
      durableState: captureDurableState(
        options.durableState,
        now,
      ),
      campaignState: captureCampaignState(
        options.campaignState,
      ),
      coordination: captureCoordination(options.coordination),
      completion: captureCompletion(options.completion),
      journal: captureJournal(options.journal),
      optimizer: captureOptimizer(options.optimizer),
      correctness: captureCorrectness(options.correctness),
      broker: captureBroker(options.broker),
      operationalBindings: Object.freeze(
        operationalBindings,
      ),
      now,
    });
  } catch {
    return fail();
  }
}

function assertFactoryInput(
  input: ProductionOptimizeRuntimeFactoryInput,
  options: CapturedFactoryOptions,
): void {
  assertExactKeys(input, [
    "manifest",
    "compositionVerification",
    "bootstrapReceipt",
    "lifecycle",
  ]);
  const now = options.now();
  assertProductionOptimizationCompositionManifest(
    input.manifest,
    now,
  );
  const manifest = input.manifest;
  const verification = input.compositionVerification;
  const receipt = input.bootstrapReceipt;
  const attestation = options.attestation;
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
  for (const hash of [
    verification.manifestHash,
    verification.componentBindingsHash,
    verification.operationalBindingsHash,
    verification.runtimePortBindingsHash,
    verification.verifierAttestationHash,
  ]) {
    assertHash(hash);
  }
  assertExactKeys(receipt, [
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
  for (const hash of [
    receipt.requestHash,
    receipt.manifestHash,
    receipt.protocolHash,
    receipt.sourcePrerequisiteHash,
    receipt.genesisPrerequisiteHash,
    receipt.catalogPrerequisiteHash,
    receipt.campaignStateHash,
    receipt.catalogStateHash,
    receipt.receiptHash,
  ]) {
    assertHash(hash);
  }
  const expectedBootstrapRequestHash = canonicalHash({
    schemaVersion: 1,
    domain:
      "dark-factory.production-optimize-bootstrap-or-reconstruct-request.v1",
    manifestId: manifest.manifestId,
    manifestHash: manifest.manifestHash,
    campaignId: manifest.campaignId,
    lineageId: manifest.lineageId,
    protocolHash: manifest.protocolHash,
    sourcePrerequisiteHash:
      manifest.bindings.harnessRegistrationHash,
    genesisPrerequisiteHash:
      manifest.bindings.campaignGenesisHash,
    catalogPrerequisiteHash:
      manifest.bindings.hiddenCatalogGenesisHash,
  });
  const {
    receiptHash: _receiptHash,
    ...unsignedReceipt
  } = receipt;
  const verifiedAt = timestamp(receipt.verifiedAt);
  if (
    input.lifecycle.boundary !==
      "production-optimize-composition-owner" ||
    typeof input.lifecycle.register !== "function" ||
    options.durableState.storeId !== manifest.campaignId ||
    attestation.manifestHash !== manifest.manifestHash ||
    attestation.operationalBindingsHash !==
      canonicalHash(manifest.bindings) ||
    attestation.runtimePortBindingsHash !==
      productionRuntimePortBindingsHash(
        manifest.runtimePortAttestations,
      ) ||
    canonicalJson(attestation.runtimePortAttestations) !==
      canonicalJson(manifest.runtimePortAttestations) ||
    verification.manifestHash !== manifest.manifestHash ||
    verification.schemaVersion !== 1 ||
    verification.domain !==
      "dark-factory.production-composition-verification.v1" ||
    verification.signingKeyId !== manifest.signature.keyId ||
    verification.componentBindingsHash !==
      canonicalHash(manifest.components) ||
    verification.operationalBindingsHash !==
      canonicalHash(manifest.bindings) ||
    verification.runtimePortBindingsHash !==
      attestation.runtimePortBindingsHash ||
    verification.verified !== true ||
    receipt.schemaVersion !== 1 ||
    receipt.domain !==
      "dark-factory.production-optimize-bootstrap-or-reconstruct-receipt.v1" ||
    receipt.requestHash !== expectedBootstrapRequestHash ||
    receipt.manifestHash !== manifest.manifestHash ||
    receipt.campaignId !== manifest.campaignId ||
    receipt.lineageId !== manifest.lineageId ||
    receipt.protocolHash !== manifest.protocolHash ||
    receipt.sourcePrerequisiteHash !==
      manifest.bindings.harnessRegistrationHash ||
    receipt.genesisPrerequisiteHash !==
      manifest.bindings.campaignGenesisHash ||
    receipt.catalogPrerequisiteHash !==
      manifest.bindings.hiddenCatalogGenesisHash ||
    (receipt.disposition !== "bootstrapped" &&
      receipt.disposition !== "reconstructed") ||
    receipt.prerequisitesVerified !== true ||
    receipt.idempotentlyBound !== true ||
    verifiedAt < timestamp(manifest.issuedAt) ||
    verifiedAt > now.getTime() ||
    receipt.receiptHash !== canonicalHash(unsignedReceipt)
  ) {
    fail();
  }
  for (const role of [
    "control",
    "optimizer",
    "build",
    "evaluator",
  ] as const) {
    if (
      attestation.componentManifestHashes[role] !==
      canonicalHash(manifest.components[role])
    ) {
      fail();
    }
  }
  const bindings = options.operationalBindings;
  if (
    bindings.providerReadinessHash !==
      manifest.bindings.providerReadinessHash ||
    bindings.volumeSemanticsHash !==
      manifest.bindings.volumeSemanticsHash ||
    bindings.correctnessPolicyHash !==
      manifest.bindings.correctnessPolicyHash ||
    bindings.brokerPolicyHash !==
      manifest.bindings.brokerPolicyHash ||
    bindings.evaluatorPolicyHash !==
      manifest.bindings.evaluatorPolicyHash ||
    bindings.journalPolicyHash !==
      manifest.bindings.journalPolicyHash ||
    options.optimizer.resolver.releaseArtifactInspectionPolicy
      .evaluatorPolicyHash !==
      manifest.bindings.evaluatorPolicyHash ||
    options.optimizer.session.pluginArtifact.sha256 !==
      manifest.bindings.optimizerPluginBundleHash ||
    options.optimizer.session.sandbox.imageDigest !==
      manifest.components.optimizer.imageDigest ||
    options.optimizer.session.sandbox.imageReference !==
      manifest.components.optimizer.imageReference
  ) {
    fail();
  }
}

function captureFactoryInput(
  input: ProductionOptimizeRuntimeFactoryInput,
): ProductionOptimizeRuntimeFactoryInput {
  assertExactKeys(input, [
    "manifest",
    "compositionVerification",
    "bootstrapReceipt",
    "lifecycle",
  ]);
  assertExactKeys(input.lifecycle, ["boundary", "register"]);
  if (
    input.lifecycle.boundary !==
      "production-optimize-composition-owner" ||
    typeof input.lifecycle.register !== "function"
  ) {
    fail();
  }
  const lifecycle = Object.freeze({
    boundary: input.lifecycle.boundary,
    register: captureMethod(
      input.lifecycle,
      input.lifecycle.register,
    ),
  });
  return Object.freeze({
    manifest: cloneCanonical(input.manifest),
    compositionVerification: cloneCanonical(
      input.compositionVerification,
    ),
    bootstrapReceipt: cloneCanonical(
      input.bootstrapReceipt,
    ),
    lifecycle,
  });
}

async function verifyDependencyAttestation(
  input: ProductionOptimizeRuntimeFactoryInput,
  options: CapturedFactoryOptions,
): Promise<void> {
  const request = {
    attestation: cloneCanonical(options.attestation),
    manifestHash: input.manifest.manifestHash,
    compositionVerifierAttestationHash:
      input.compositionVerification.verifierAttestationHash,
  };
  const requestJson = canonicalJson(request);
  const verification =
    await options.verifyDependencyAttestation(request);
  if (canonicalJson(request) !== requestJson) fail();
  assertExactKeys(verification, [
    "schemaVersion",
    "domain",
    "attestationHash",
    "manifestHash",
    "compositionVerifierAttestationHash",
    "verified",
    "authorityAttestationHash",
  ]);
  for (const hash of [
    verification.attestationHash,
    verification.manifestHash,
    verification.compositionVerifierAttestationHash,
    verification.authorityAttestationHash,
  ]) {
    assertHash(hash);
  }
  if (
    verification.schemaVersion !== 1 ||
    verification.domain !==
      "dark-factory.production-runtime-factory-dependency-verification.v1" ||
    verification.attestationHash !==
      options.attestation.attestationHash ||
    verification.manifestHash !== input.manifest.manifestHash ||
    verification.compositionVerifierAttestationHash !==
      input.compositionVerification.verifierAttestationHash ||
    verification.verified !== true
  ) {
    fail();
  }
}

class ConstructionLifecycle {
  readonly #register: (
    closeable: TrustedProductionOptimizeCloseable,
  ) => void;
  readonly #registered:
    TrustedProductionOptimizeCloseable[] = [];
  readonly #ids = new Set<string>();

  public constructor(
    input: ProductionOptimizeRuntimeFactoryInput["lifecycle"],
  ) {
    this.#register = captureMethod(input, input.register);
  }

  public add(
    lifecycleId: string,
    close: () => Promise<void>,
  ): void {
    if (
      !SAFE_STORE_ID.test(lifecycleId) ||
      this.#ids.has(lifecycleId)
    ) {
      fail();
    }
    this.#ids.add(lifecycleId);
    const capturedClose = captureMethod(
      { close },
      close,
    );
    let closePromise: Promise<void> | null = null;
    const closeOnce = (): Promise<void> => {
      if (closePromise === null) {
        closePromise = Promise.resolve().then(capturedClose);
      }
      return closePromise;
    };
    const closeable = Object.freeze({
      boundary:
        "trusted-cloud-production-optimize-lifecycle" as const,
      lifecycleId,
      close: closeOnce,
    });
    this.#registered.push(closeable);
    this.#register(closeable);
  }

  public addStore(
    lifecycleId: string,
    store: object,
  ): void {
    const close =
      "close" in store &&
      typeof (store as { close?: unknown }).close === "function"
        ? captureMethod(
            store,
            (
              store as {
                close(): Promise<void>;
              }
            ).close,
          )
        : async (): Promise<void> => {};
    this.add(lifecycleId, close);
  }

  public async cleanup(): Promise<void> {
    let failed = false;
    for (
      let index = this.#registered.length - 1;
      index >= 0;
      index -= 1
    ) {
      const entry = this.#registered[index];
      if (entry === undefined) {
        failed = true;
        continue;
      }
      try {
        await entry.close();
      } catch {
        failed = true;
      }
    }
    if (failed) fail();
  }
}

function frozenCampaignStore(
  source: OptimizationCampaignStateStore,
): OptimizationCampaignStateStore {
  return Object.freeze({
    reconstruct: captureMethod(source, source.reconstruct),
    allocateExperiment: captureMethod(
      source,
      source.allocateExperiment,
    ),
    recordBudgetUsage: captureMethod(
      source,
      source.recordBudgetUsage,
    ),
    sealExperiment: captureMethod(
      source,
      source.sealExperiment,
    ),
    archiveInterruptedExperiment: captureMethod(
      source,
      source.archiveInterruptedExperiment,
    ),
    pause: captureMethod(source, source.pause),
    requestStop: captureMethod(source, source.requestStop),
    acknowledgeStopped: captureMethod(
      source,
      source.acknowledgeStopped,
    ),
  });
}

function frozenInputFactory(
  source: TrustedOptimizationInputFactory,
): TrustedOptimizationInputFactory {
  return Object.freeze({
    boundary: "trusted-cloud" as const,
    prepareOrResume: captureMethod(
      source,
      source.prepareOrResume,
    ),
    bindClaim: captureMethod(source, source.bindClaim),
  });
}

function frozenResumeVerifier(
  source: TrustedOptimizationResumeVerifier,
): TrustedOptimizationResumeVerifier {
  return Object.freeze({
    boundary: "trusted-cloud" as const,
    verify: captureMethod(source, source.verify),
  });
}

function frozenCompletionMaterial(
  source: TrustedOptimizationCompletionMaterialPort,
): TrustedOptimizationCompletionMaterialPort {
  return Object.freeze({
    boundary: "trusted-cloud" as const,
    createBudgetAccountingAttestation: captureMethod(
      source,
      source.createBudgetAccountingAttestation,
    ),
    createInterruptedBudgetAccountingAttestation:
      captureMethod(
        source,
        source.createInterruptedBudgetAccountingAttestation,
      ),
    createSealMaterial: captureMethod(
      source,
      source.createSealMaterial,
    ),
  });
}

function frozenInterruption(
  source: TrustedOptimizationInterruptionPort,
): TrustedOptimizationInterruptionPort {
  return Object.freeze({
    boundary: "trusted-cloud" as const,
    begin: captureMethod(source, source.begin),
    findPending: captureMethod(source, source.findPending),
    prepareControl: captureMethod(
      source,
      source.prepareControl,
    ),
    markApplied: captureMethod(source, source.markApplied),
  });
}

function frozenJournal(
  source: ExperimentJournal,
): ExperimentJournal {
  return Object.freeze({
    create: captureMethod(source, source.create),
    freezeProposal: captureMethod(
      source,
      source.freezeProposal,
    ),
    recordGates: captureMethod(source, source.recordGates),
    recordRepair: captureMethod(source, source.recordRepair),
    recordValidation: captureMethod(
      source,
      source.recordValidation,
    ),
    recordAnalysis: captureMethod(
      source,
      source.recordAnalysis,
    ),
    updateBudget: captureMethod(source, source.updateBudget),
    seal: captureMethod(source, source.seal),
    interrupt: captureMethod(source, source.interrupt),
  });
}

function frozenOptimizer(
  source: OptimizerAdapter,
): OptimizerAdapter {
  return Object.freeze({
    propose: captureMethod(source, source.propose),
    analyze: captureMethod(source, source.analyze),
  });
}

function frozenGates(
  source: CorrectnessGateRunner,
): CorrectnessGateRunner {
  return Object.freeze({
    run: captureMethod(source, source.run),
  });
}

function frozenBroker(source: BlindBroker): BlindBroker {
  return Object.freeze({
    prepareRepair: captureMethod(
      source,
      source.prepareRepair,
    ),
    runRepair: captureMethod(source, source.runRepair),
    prepareValidation: captureMethod(
      source,
      source.prepareValidation,
    ),
    runValidation: captureMethod(
      source,
      source.runValidation,
    ),
    consumeOrQuarantine: captureMethod(
      source,
      source.consumeOrQuarantine,
    ),
    releaseDiagnosticBrief: captureMethod(
      source,
      source.releaseDiagnosticBrief,
    ),
  });
}

function runtimePortBinding<
  PortId extends ProductionRuntimePortAttestationCommitment["portId"],
  Implementation extends object,
>(
  commitment: ProductionRuntimePortAttestationCommitment,
  portId: PortId,
  implementation: Implementation,
): TrustedProductionRuntimePortBinding<
  PortId,
  Implementation
> {
  if (commitment.portId !== portId) fail();
  return Object.freeze({
    boundary:
      "trusted-cloud-runtime-port-binding" as const,
    portId,
    attestationSha256: commitment.attestationSha256,
    implementation,
  });
}

function createComponents(
  manifest: ProductionOptimizationCompositionManifest,
  ports: {
    readonly campaignStore: OptimizationCampaignStateStore;
    readonly inputFactory: TrustedOptimizationInputFactory;
    readonly resumeVerifier: TrustedOptimizationResumeVerifier;
    readonly completionMaterial:
      TrustedOptimizationCompletionMaterialPort;
    readonly interruption: TrustedOptimizationInterruptionPort;
    readonly journal: ExperimentJournal;
    readonly optimizer: OptimizerAdapter;
    readonly gates: CorrectnessGateRunner;
    readonly broker: BlindBroker;
  },
): ProductionOptimizationRuntimeComponents {
  return Object.freeze({
    control: Object.freeze({
      boundary: "trusted-cloud" as const,
      role: "control" as const,
      manifestBindingHash: canonicalHash(
        manifest.components.control,
      ),
      imageDigest: manifest.components.control.imageDigest,
      campaignStore: ports.campaignStore,
      inputFactory: ports.inputFactory,
      resumeVerifier: ports.resumeVerifier,
      completionMaterial: ports.completionMaterial,
      interruption: ports.interruption,
      journal: ports.journal,
    }),
    optimizer: Object.freeze({
      boundary: "trusted-cloud" as const,
      role: "optimizer" as const,
      manifestBindingHash: canonicalHash(
        manifest.components.optimizer,
      ),
      imageDigest: manifest.components.optimizer.imageDigest,
      adapter: ports.optimizer,
    }),
    build: Object.freeze({
      boundary: "trusted-cloud" as const,
      role: "build" as const,
      manifestBindingHash: canonicalHash(
        manifest.components.build,
      ),
      imageDigest: manifest.components.build.imageDigest,
      gates: ports.gates,
    }),
    evaluator: Object.freeze({
      boundary: "trusted-cloud" as const,
      role: "evaluator" as const,
      manifestBindingHash: canonicalHash(
        manifest.components.evaluator,
      ),
      imageDigest: manifest.components.evaluator.imageDigest,
      broker: ports.broker,
    }),
  });
}

function createBindings(
  manifest: ProductionOptimizationCompositionManifest,
  ports: {
    readonly campaignStore: OptimizationCampaignStateStore;
    readonly inputFactory: TrustedOptimizationInputFactory;
    readonly resumeVerifier: TrustedOptimizationResumeVerifier;
    readonly completionMaterial:
      TrustedOptimizationCompletionMaterialPort;
    readonly interruption: TrustedOptimizationInterruptionPort;
    readonly journal: ExperimentJournal;
    readonly optimizer: OptimizerAdapter;
    readonly gates: CorrectnessGateRunner;
    readonly broker: BlindBroker;
  },
): ProductionOptimizationRuntimePortBindings {
  const commitments = manifest.runtimePortAttestations;
  const bindings = {
    campaignStore: runtimePortBinding(
      commitments[0] ??
        fail(),
      "control.campaign-state-store",
      ports.campaignStore,
    ),
    inputFactory: runtimePortBinding(
      commitments[1] ??
        fail(),
      "control.optimization-input-factory",
      ports.inputFactory,
    ),
    resumeVerifier: runtimePortBinding(
      commitments[2] ??
        fail(),
      "control.optimization-resume-verifier",
      ports.resumeVerifier,
    ),
    completionMaterial: runtimePortBinding(
      commitments[3] ??
        fail(),
      "control.optimization-completion-material",
      ports.completionMaterial,
    ),
    interruption: runtimePortBinding(
      commitments[4] ??
        fail(),
      "control.optimization-interruption-port",
      ports.interruption,
    ),
    journal: runtimePortBinding(
      commitments[5] ??
        fail(),
      "control.experiment-journal",
      ports.journal,
    ),
    optimizer: runtimePortBinding(
      commitments[6] ??
        fail(),
      "optimizer.adapter",
      ports.optimizer,
    ),
    gates: runtimePortBinding(
      commitments[7] ??
        fail(),
      "build.correctness-gate",
      ports.gates,
    ),
    broker: runtimePortBinding(
      commitments[8] ??
        fail(),
      "evaluator.blind-broker",
      ports.broker,
    ),
  };
  if (
    canonicalJson(Object.keys(bindings)) !==
    canonicalJson([
      "campaignStore",
      "inputFactory",
      "resumeVerifier",
      "completionMaterial",
      "interruption",
      "journal",
      "optimizer",
      "gates",
      "broker",
    ])
  ) {
    fail();
  }
  return Object.freeze(bindings);
}

/**
 * Statically composes the production optimization runtime. Every executable
 * class is imported above; manifests and environment values can authenticate
 * the fixed composition but cannot select a constructor, module, command,
 * key, model, task, or runtime-port implementation.
 */
export class ProductionTrustedCloudRuntimeFactory
  implements TrustedProductionOptimizeRuntimeFactory
{
  readonly boundary =
    "trusted-cloud-production-optimize-runtime-factory" as const;
  readonly #options: CapturedFactoryOptions;
  #used = false;

  public constructor(
    options: ProductionTrustedCloudRuntimeFactoryOptions,
  ) {
    this.#options = captureOptions(options);
  }

  public async create(
    input: ProductionOptimizeRuntimeFactoryInput,
  ): Promise<ProductionOptimizeRuntimeAssembly> {
    if (this.#used) fail();
    this.#used = true;
    const capturedInput = captureFactoryInput(input);
    const lifecycle = new ConstructionLifecycle(
      capturedInput.lifecycle,
    );
    try {
      assertFactoryInput(capturedInput, this.#options);
      const options = this.#options;
      options.durableState.runtimeGuard.assertTrustedCloudRuntime();
      options.durableState.semanticsGuard
        .assertLinearizableStateVolume({
          volumeRoot: options.durableState.volumeRoot,
          namespace:
            `production-runtime-${capturedInput.manifest.campaignId}`,
        });
      await verifyDependencyAttestation(
        capturedInput,
        options,
      );

      const campaignStore = new CampaignStateStore(
        join(options.durableState.volumeRoot, "campaigns"),
        capturedInput.manifest.campaignId,
        {
          now: options.now,
          ledgerTransitionVerifier:
            options.campaignState.ledgerTransitionVerifier,
          decisionAttestationVerifier:
            options.campaignState.decisionAttestationVerifier,
          controlAttestationVerifier:
            options.campaignState.controlAttestationVerifier,
        },
      );
      lifecycle.addStore("runtime-campaign-state", campaignStore);

      const coordination =
        new MountedVolumeOptimizationCoordinationPorts({
          ...options.coordination,
          durableState: options.durableState,
        });
      lifecycle.addStore(
        "runtime-optimization-coordination",
        coordination,
      );

      const journalState =
        new MountedVolumeAtomicExperimentJournalStateStore(
          options.durableState,
        );
      lifecycle.addStore(
        "runtime-experiment-journal-state",
        journalState,
      );

      const evidenceStore = new ExperimentStore(
        join(
          options.durableState.volumeRoot,
          "experiments",
          capturedInput.manifest.campaignId,
        ),
        {
          ...options.journal.experimentStore,
          now: options.now,
        },
      );
      lifecycle.addStore(
        "runtime-experiment-evidence",
        evidenceStore,
      );

      const artifactAssembler =
        new MountedVolumeReleaseSafeExperimentArtifactAssembler({
          ...options.journal.artifactAssembler,
          durableState: options.durableState,
        });
      lifecycle.addStore(
        "runtime-journal-artifact-assembler",
        artifactAssembler,
      );

      const journalSealAuthority =
        new MountedVolumeTrustedExperimentSealAuthority({
          ...options.journal.sealAuthority,
          durableState: options.durableState,
        });
      lifecycle.addStore(
        "runtime-journal-seal-authority",
        journalSealAuthority,
      );

      const journalInterruptionAttestor =
        new MountedVolumeTrustedJournalInterruptionAttestor({
          durableState: options.durableState,
          now: options.now,
        });
      lifecycle.addStore(
        "runtime-journal-interruption-attestor",
        journalInterruptionAttestor,
      );

      const completionMaterial =
        new ProductionOptimizationCompletionMaterial({
          ...options.completion,
          journalStateStore: journalState,
        });
      const journal = new ProductionExperimentJournal({
        evidenceStore,
        stateStore: journalState,
        artifactAssembler,
        sealAuthority: journalSealAuthority,
        interruptionAttestor: journalInterruptionAttestor,
        now: options.now,
      });

      const optimizerRecords =
        new MountedVolumeCloudOptimizerSessionRecordStore(
          options.durableState,
        );
      lifecycle.addStore(
        "runtime-optimizer-records",
        optimizerRecords,
      );

      const correctnessRecords =
        new MountedVolumeCorrectnessGateRecordStore({
          ...options.correctness.recordStore,
          durableState: options.durableState,
        });
      lifecycle.addStore(
        "runtime-correctness-records",
        correctnessRecords,
      );

      const sourceIndex =
        new MountedVolumeTrustedCandidateSourceIndex({
          ...options.correctness.sourceIndex,
          durableState: options.durableState,
        });
      lifecycle.addStore(
        "runtime-candidate-source-index",
        sourceIndex,
      );

      const optimizerResolver =
        new ArtifactBackedCloudOptimizerAdapterResolver({
          ...options.optimizer.resolver,
          sourceIndex,
        });
      const optimizerSession =
        new CloudOnlyClaudeOptimizerSession(
          options.optimizer.session,
        );
      const optimizer = createCloudOnlyClaudeOptimizerAdapter({
        session: optimizerSession,
        resolver: optimizerResolver,
        records: optimizerRecords,
      });

      const gates = new ProductionCorrectnessGateRunner({
        optimizerRecords,
        records: correctnessRecords,
        scanner: options.correctness.scanner,
        builder: options.correctness.builder,
        publisher: options.correctness.publisher,
        snapshotter: options.correctness.snapshotter,
        sourceIndex,
        integrityPolicyHash:
          options.correctness.integrityPolicyHash,
        buildPolicyHash: options.correctness.buildPolicyHash,
      });

      const brokerLeases =
        new MountedVolumeAtomicBlindBrokerLeaseStore(
          options.durableState,
        );
      lifecycle.addStore(
        "runtime-blind-broker-leases",
        brokerLeases,
      );

      const diagnosticPublisher =
        new MountedVolumeTrustedDiagnosticBriefPublisher({
          durableState: options.durableState,
          signatureVerifier:
            options.broker.signatureVerifier,
        });
      lifecycle.addStore(
        "runtime-diagnostic-publications",
        diagnosticPublisher,
      );

      const configurations =
        new CasBlindBrokerEvaluationConfigurationResolver(
          options.broker.configuration,
        );
      const harness =
        new SignedGitSourceHarnessArtifactResolver({
          ...options.broker.harness,
          source: sourceIndex,
        });
      const repairDiscovery =
        new LeaseStoreTrustedRepairDiscoveryResolver(
          brokerLeases,
        );
      const evaluator =
        new ArtifactBackedEvaluationReleaseBundleService({
          ...options.broker.release,
          now: options.now,
        });
      const broker = new ProductionBlindBroker({
        store: brokerLeases,
        configurations,
        artifacts: harness,
        repairDiscovery,
        evaluator,
        signatureVerifier:
          options.broker.signatureVerifier,
        diagnosticPublisher,
        now: options.now,
      });

      const ports = Object.freeze({
        campaignStore: frozenCampaignStore(campaignStore),
        inputFactory: frozenInputFactory(
          coordination.inputFactory,
        ),
        resumeVerifier: frozenResumeVerifier(
          coordination.resumeVerifier,
        ),
        completionMaterial: frozenCompletionMaterial(
          completionMaterial,
        ),
        interruption: frozenInterruption(
          coordination.interruption,
        ),
        journal: frozenJournal(journal),
        optimizer: frozenOptimizer(optimizer),
        gates: frozenGates(gates),
        broker: frozenBroker(broker),
      });
      const components = createComponents(
        capturedInput.manifest,
        ports,
      );
      const runtimePortBindings = createBindings(
        capturedInput.manifest,
        ports,
      );
      if (
        runtimePortBindings.campaignStore.implementation !==
          components.control.campaignStore ||
        runtimePortBindings.inputFactory.implementation !==
          components.control.inputFactory ||
        runtimePortBindings.resumeVerifier.implementation !==
          components.control.resumeVerifier ||
        runtimePortBindings.completionMaterial.implementation !==
          components.control.completionMaterial ||
        runtimePortBindings.interruption.implementation !==
          components.control.interruption ||
        runtimePortBindings.journal.implementation !==
          components.control.journal ||
        runtimePortBindings.optimizer.implementation !==
          components.optimizer.adapter ||
        runtimePortBindings.gates.implementation !==
          components.build.gates ||
        runtimePortBindings.broker.implementation !==
          components.evaluator.broker
      ) {
        fail();
      }
      return Object.freeze({
        components,
        runtimePortBindings,
      });
    } catch {
      try {
        await lifecycle.cleanup();
      } catch {
        // The public error deliberately reveals neither construction phase
        // nor authority/store identity.
      }
      return fail();
    }
  }
}
