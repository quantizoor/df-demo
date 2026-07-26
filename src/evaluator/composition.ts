import {
  Ed25519ResultEnvelopeIssuer,
  Ed25519ResultEnvelopeVerifier,
} from "../broker/issuer.js";
import type { OneUseRequestLedger } from "../broker/ledger.js";
import {
  TrustedEvaluationBroker,
  type TrustedPanelAllocator,
  type TrustedRawArtifactCustodian,
} from "../broker/service.js";
import type { SignedResultEnvelope } from "../schemas/trusted.js";
import type { PiHarborAgentSpec } from "../terminal-bench/pi-agent.js";
import {
  TerminalBenchCloudRunner,
  type TerminalBenchRunnerOptions,
  type TrustedRawRunIngress,
} from "../terminal-bench/runner.js";
import type { TrustedEvaluationRequest } from "./contracts.js";
import type { TrustedOnlineErrorBudgetAuthority } from "./online-error-authority.js";
import {
  DeterministicPostDestructionBehavioralReleaseProducer,
  type TrustedBehavioralPrivacyArtifactStore,
} from "./behavioral-release-producer.js";
import type {
  TrustedBehavioralPreparationStore,
} from "./behavioral-preparation-store.js";
import {
  DeterministicCanonicalEvaluationDeriver,
  type TrustedHiddenCatalogOutcomeUpdateSink,
} from "./deriver.js";
import {
  CloudBackedHiddenCatalogOutcomeUpdateSigner,
  CloudBackedHiddenCatalogOutcomeUpdateVerifier,
  type TrustedCloudEd25519PrivateKeyProvider,
  type TrustedCloudEd25519PublicKey,
  type TrustedCloudEd25519PublicKeyProvider,
} from "./hidden-update-signature.js";
import {
  BoundCanonicalDerivationPolicyResolver,
  type TrustedCanonicalPolicyMaterialProvider,
} from "./policy-resolver.js";
import {
  StrictTrustedDecodedEvaluationReader,
  type TrustedEncryptedRawArtifactSource,
  type TrustedHarborRawArtifactDecoder,
  type TrustedRawArtifactDecryptor,
} from "./raw-reader.js";
import type {
  TrustedRawDestructionReceiptVerifier,
  TrustedRawRetentionPolicy,
} from "./retention.js";

export interface TrustedProductionEvaluationStores {
  readonly boundary: "trusted-cloud";
  readonly durabilityAttestationHash: string;
  readonly ledger: OneUseRequestLedger;
  readonly panels: TrustedPanelAllocator;
  readonly rawIngress: TrustedRawRunIngress;
  readonly custodian: TrustedRawArtifactCustodian;
  readonly hiddenOutcomeSink: TrustedHiddenCatalogOutcomeUpdateSink;
  readonly onlineErrorAuthority: TrustedOnlineErrorBudgetAuthority;
  readonly behavioralPreparations: TrustedBehavioralPreparationStore;
}

export interface TrustedEvaluationServiceCompositionOptions {
  readonly runner: Omit<
    TerminalBenchRunnerOptions,
    "rawIngress" | "retentionPolicy" | "destructionReceiptVerifier"
  >;
  readonly retentionPolicy: TrustedRawRetentionPolicy;
  readonly destructionReceiptVerifier: TrustedRawDestructionReceiptVerifier;
  readonly agent: PiHarborAgentSpec;
  readonly stores: TrustedProductionEvaluationStores;
  readonly raw: {
    readonly source: TrustedEncryptedRawArtifactSource;
    readonly decryptor: TrustedRawArtifactDecryptor;
    readonly decoder: TrustedHarborRawArtifactDecoder;
    readonly maximumEncryptedArtifactBytes?: number;
    readonly maximumPlaintextArtifactBytes?: number;
  };
  readonly policyProvider: TrustedCanonicalPolicyMaterialProvider;
  readonly hiddenOutcomeSigning: {
    readonly keyId: string;
    readonly trustedKeyIds: readonly string[];
    readonly privateKeys: TrustedCloudEd25519PrivateKeyProvider;
    readonly publicKeys: TrustedCloudEd25519PublicKeyProvider;
  };
  readonly resultEnvelopeSigning: {
    readonly keyId: string;
    readonly trustedKeyIds: readonly string[];
    readonly privateKeys: TrustedCloudEd25519PrivateKeyProvider;
    readonly publicKeys: TrustedCloudEd25519PublicKeyProvider;
  };
  readonly behavioralReleaseStore: TrustedBehavioralPrivacyArtifactStore;
  readonly behavioralReleaseSigning: {
    readonly keyId: string;
    readonly trustedKeyIds: readonly string[];
    readonly privateKeys: TrustedCloudEd25519PrivateKeyProvider;
    readonly publicKeys: TrustedCloudEd25519PublicKeyProvider;
  };
  readonly now?: () => Date;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_KEY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const SAFE_KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;

export class TrustedEvaluationCompositionError extends Error {
  override readonly name = "TrustedEvaluationCompositionError";

  constructor() {
    super("Trusted evaluation service composition is not production-safe.");
  }
}

function assertTrustedKeyIds(
  signingKeyId: string,
  trustedKeyIds: readonly string[],
): void {
  if (
    !SAFE_KEY_ID.test(signingKeyId) ||
    trustedKeyIds.length < 1 ||
    new Set(trustedKeyIds).size !== trustedKeyIds.length ||
    trustedKeyIds.some((keyId) => !SAFE_KEY_ID.test(keyId)) ||
    !trustedKeyIds.includes(signingKeyId)
  ) {
    throw new TrustedEvaluationCompositionError();
  }
}

function validPublicResultKey(
  key: TrustedCloudEd25519PublicKey,
  keyId: string,
): boolean {
  return (
    key.boundary === "trusted-cloud-key-material" &&
    key.algorithm === "Ed25519" &&
    key.purpose === "result-envelope" &&
    key.keyId === keyId &&
    SAFE_KEY_VERSION.test(key.keyVersion) &&
    key.publicKey !== undefined &&
    key.publicKey !== null
  );
}

/**
 * The narrow release-facing service. Concrete runner, decoder, policy
 * resolver, deriver, raw destruction, signer, verifier, and one-use broker are
 * retained privately so no caller can bypass the release boundary.
 */
export interface TrustedEvaluationService {
  readonly boundary: "trusted-cloud-evaluator-service";
  evaluate(request: TrustedEvaluationRequest): Promise<SignedResultEnvelope>;
}

class ComposedTrustedEvaluationService
  implements TrustedEvaluationService
{
  readonly boundary = "trusted-cloud-evaluator-service" as const;
  readonly #broker: TrustedEvaluationBroker;

  constructor(broker: TrustedEvaluationBroker) {
    this.#broker = broker;
  }

  evaluate(request: TrustedEvaluationRequest): Promise<SignedResultEnvelope> {
    return this.#broker.evaluate(request);
  }
}

/**
 * Creates the production trusted pipeline:
 *
 * TerminalBenchCloudRunner -> authenticated raw reader -> deterministic
 * canonical deriver -> raw destruction -> Ed25519 signed broker release.
 *
 * Every raw/storage/policy/key port must attest `trusted-cloud`; test-only
 * in-memory fixtures are deliberately rejected.
 */
export async function createTrustedEvaluationService(
  options: TrustedEvaluationServiceCompositionOptions,
): Promise<TrustedEvaluationService> {
  try {
    if (
      options.stores.boundary !== "trusted-cloud" ||
      !SHA256.test(options.stores.durabilityAttestationHash) ||
      options.raw.source.boundary !== "trusted-cloud" ||
      options.raw.decryptor.boundary !== "trusted-cloud" ||
      options.raw.decoder.boundary !== "trusted-cloud" ||
      options.policyProvider.boundary !== "trusted-cloud" ||
      options.hiddenOutcomeSigning.privateKeys.boundary !==
        "trusted-cloud" ||
      options.hiddenOutcomeSigning.publicKeys.boundary !== "trusted-cloud" ||
      options.resultEnvelopeSigning.privateKeys.boundary !==
        "trusted-cloud" ||
      options.resultEnvelopeSigning.publicKeys.boundary !== "trusted-cloud" ||
      options.behavioralReleaseStore.boundary !== "trusted-cloud" ||
      options.behavioralReleaseSigning.privateKeys.boundary !==
        "trusted-cloud" ||
      options.behavioralReleaseSigning.publicKeys.boundary !==
        "trusted-cloud" ||
      typeof options.stores.ledger.claim !== "function" ||
      typeof options.stores.ledger.inspect !== "function" ||
      typeof options.stores.ledger.recoverInFlight !==
        "function" ||
      typeof options.stores.ledger.bindDispositionAttestation !==
        "function" ||
      typeof options.stores.ledger.complete !== "function" ||
      typeof options.stores.ledger.consumeFailure !== "function" ||
      typeof options.stores.panels.allocateAndConsume !== "function" ||
      typeof options.stores.rawIngress.persist !== "function" ||
      typeof options.stores.rawIngress.discard !== "function" ||
      typeof options.stores.custodian.destroy !== "function" ||
      typeof options.stores.hiddenOutcomeSink.commit !== "function" ||
      options.stores.onlineErrorAuthority.boundary !==
        "trusted-cloud-online-error-authority" ||
      options.stores.behavioralPreparations.boundary !==
        "trusted-cloud" ||
      typeof options.stores.onlineErrorAuthority.reserve !== "function" ||
      typeof options.stores.onlineErrorAuthority.reconcile !==
        "function" ||
      typeof options.stores.behavioralPreparations.prepare !==
        "function" ||
      typeof options.stores.behavioralPreparations.resolve !==
        "function" ||
      typeof options.stores.behavioralPreparations.finalize !==
        "function" ||
      typeof options.stores.behavioralPreparations.abandon !==
        "function" ||
      typeof options.stores.behavioralPreparations.consume !==
        "function" ||
      typeof options.raw.source.read !== "function" ||
      typeof options.raw.decryptor.decrypt !== "function" ||
      typeof options.raw.decoder.decode !== "function" ||
      typeof options.policyProvider.load !== "function" ||
      typeof options.hiddenOutcomeSigning.privateKeys.resolve !==
        "function" ||
      typeof options.hiddenOutcomeSigning.publicKeys.resolve !==
        "function" ||
      typeof options.resultEnvelopeSigning.privateKeys.resolve !==
        "function" ||
      typeof options.resultEnvelopeSigning.publicKeys.resolve !==
        "function" ||
      typeof options.behavioralReleaseStore.load !== "function" ||
      typeof options.behavioralReleaseStore.resolveByContentHash !==
        "function" ||
      typeof options.behavioralReleaseStore.inspectCommit !==
        "function" ||
      typeof options.behavioralReleaseStore.commit !== "function" ||
      typeof options.behavioralReleaseStore.orphan !== "function" ||
      typeof options.behavioralReleaseSigning.privateKeys.resolve !==
        "function" ||
      typeof options.behavioralReleaseSigning.publicKeys.resolve !==
        "function" ||
      typeof options.runner.provider.probe !== "function" ||
      typeof options.runner.provider.create !== "function" ||
      typeof options.runner.provider.execute !== "function" ||
      typeof options.runner.provider.upload !== "function" ||
      typeof options.runner.provider.download !== "function" ||
      typeof options.runner.provider.cancel !== "function" ||
      typeof options.runner.provider.destroy !== "function" ||
      typeof options.runner.jobBuilder.build !== "function" ||
      typeof options.runner.runtimeVerifier.verify !== "function"
    ) {
      throw new TrustedEvaluationCompositionError();
    }
    assertTrustedKeyIds(
      options.hiddenOutcomeSigning.keyId,
      options.hiddenOutcomeSigning.trustedKeyIds,
    );
    assertTrustedKeyIds(
      options.resultEnvelopeSigning.keyId,
      options.resultEnvelopeSigning.trustedKeyIds,
    );
    assertTrustedKeyIds(
      options.behavioralReleaseSigning.keyId,
      options.behavioralReleaseSigning.trustedKeyIds,
    );

    const reader = new StrictTrustedDecodedEvaluationReader({
      deployment: "trusted-cloud",
      retentionPolicy: options.retentionPolicy,
      source: options.raw.source,
      decryptor: options.raw.decryptor,
      decoder: options.raw.decoder,
      ...(options.raw.maximumEncryptedArtifactBytes === undefined
        ? {}
        : {
            maximumEncryptedArtifactBytes:
              options.raw.maximumEncryptedArtifactBytes,
          }),
      ...(options.raw.maximumPlaintextArtifactBytes === undefined
        ? {}
        : {
            maximumPlaintextArtifactBytes:
              options.raw.maximumPlaintextArtifactBytes,
          }),
    });
    const policies = new BoundCanonicalDerivationPolicyResolver({
      deployment: "trusted-cloud",
      provider: options.policyProvider,
    });
    const hiddenOutcomeSigner =
      new CloudBackedHiddenCatalogOutcomeUpdateSigner({
        deployment: "trusted-cloud",
        keyId: options.hiddenOutcomeSigning.keyId,
        keys: options.hiddenOutcomeSigning.privateKeys,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    const hiddenOutcomeVerifier =
      new CloudBackedHiddenCatalogOutcomeUpdateVerifier({
        deployment: "trusted-cloud",
        keys: options.hiddenOutcomeSigning.publicKeys,
        trustedKeyIds:
          options.hiddenOutcomeSigning.trustedKeyIds,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    const deriver = new DeterministicCanonicalEvaluationDeriver({
      reader,
      policies,
      hiddenOutcomeSigner,
      hiddenOutcomeVerifier,
      hiddenOutcomeSink: options.stores.hiddenOutcomeSink,
      behavioralPreparationStore:
        options.stores.behavioralPreparations,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const behavioralReleaseProducer =
      new DeterministicPostDestructionBehavioralReleaseProducer({
        deployment: "trusted-cloud",
        store: options.behavioralReleaseStore,
        keyId: options.behavioralReleaseSigning.keyId,
        privateKeys:
          options.behavioralReleaseSigning.privateKeys,
        publicKeys:
          options.behavioralReleaseSigning.publicKeys,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    const runner = new TerminalBenchCloudRunner({
      ...options.runner,
      rawIngress: options.stores.rawIngress,
      retentionPolicy: options.retentionPolicy,
      destructionReceiptVerifier: options.destructionReceiptVerifier,
    });

    const resultPrivateKey =
      await options.resultEnvelopeSigning.privateKeys.resolve({
        purpose: "result-envelope",
        keyId: options.resultEnvelopeSigning.keyId,
      });
    if (
      resultPrivateKey.boundary !== "trusted-cloud-key-material" ||
      resultPrivateKey.algorithm !== "Ed25519" ||
      resultPrivateKey.purpose !== "result-envelope" ||
      resultPrivateKey.keyId !==
        options.resultEnvelopeSigning.keyId ||
      !SAFE_KEY_VERSION.test(resultPrivateKey.keyVersion) ||
      resultPrivateKey.privateKey === undefined ||
      resultPrivateKey.privateKey === null
    ) {
      throw new TrustedEvaluationCompositionError();
    }
    const issuer = new Ed25519ResultEnvelopeIssuer({
      privateKey: resultPrivateKey.privateKey,
      keyId: options.resultEnvelopeSigning.keyId,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const trustedResultKeyIds = new Set(
      options.resultEnvelopeSigning.trustedKeyIds,
    );
    const verifier = new Ed25519ResultEnvelopeVerifier({
      getVerificationKey: async (keyId) => {
        if (!trustedResultKeyIds.has(keyId)) return undefined;
        const key =
          await options.resultEnvelopeSigning.publicKeys.resolve({
            purpose: "result-envelope",
            keyId,
          });
        return key !== undefined && validPublicResultKey(key, keyId)
          ? key.publicKey
          : undefined;
      },
    });
    return new ComposedTrustedEvaluationService(
      new TrustedEvaluationBroker({
        ledger: options.stores.ledger,
        panels: options.stores.panels,
        runner,
        deriver,
        behavioralPreparationStore:
          options.stores.behavioralPreparations,
        behavioralReleaseProducer,
        custodian: options.stores.custodian,
        onlineErrorAuthority:
          options.stores.onlineErrorAuthority,
        issuer,
        verifier,
        agent: options.agent,
        retentionPolicy: options.retentionPolicy,
        destructionReceiptVerifier:
          options.destructionReceiptVerifier,
      }),
    );
  } catch (error) {
    if (error instanceof TrustedEvaluationCompositionError) throw error;
    throw new TrustedEvaluationCompositionError();
  }
}
