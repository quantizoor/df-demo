import {
  createPublicKey,
  KeyObject,
  type KeyLike,
} from "node:crypto";

import type { HiddenPrivacyBudgetState } from "../evaluation/privacy.js";
import {
  createTrustedEvaluationService,
  type TrustedEvaluationService,
  type TrustedEvaluationServiceCompositionOptions,
  type TrustedProductionEvaluationStores,
} from "../evaluator/composition.js";
import type {
  EvaluationReleaseArtifactQuery,
  TrustedEvaluationReleaseArtifactReader,
  TrustedEvaluationReleaseArtifactSource,
} from "../evaluator/release-bundle-service.js";
import type {
  BehavioralReleaseArtifact,
  TrustedBehavioralPrivacyArtifactStore,
} from "../evaluator/behavioral-release-producer.js";
import { canonicalHash, canonicalJson, sha256 } from "../schemas/canonical.js";
import type { TrustedCloudArtifactRef } from "./types.js";
import {
  MountedVolumeBehavioralPreparationStore,
} from "./mounted-volume-behavioral-preparation-store.js";
import {
  MountedVolumeBehavioralPrivacyArtifactStore,
} from "./mounted-volume-behavioral-privacy-store.js";
import type {
  ProductionOptimizeLifecycleRegistrar,
} from "./production-optimize-composition-owner.js";
import type { MountedVolumeDurableStateOptions } from "./mounted-volume-state.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const BEHAVIORAL_URI_PREFIX =
  "trusted://behavioral-release/" as const;
const BEHAVIORAL_URI =
  /^trusted:\/\/behavioral-release\/(behavioral-release|behavioral-evidence|failure-cards|diagnostic-brief)\/([a-f0-9]{64})$/u;
const BEHAVIORAL_PURPOSES = Object.freeze([
  "behavioral-release",
  "behavioral-evidence",
  "failure-cards",
  "diagnostic-brief",
] as const satisfies readonly BehavioralReleaseArtifact["purpose"][]);

const DEPENDENCY_KEYS = [
  "runner",
  "retentionPolicy",
  "destructionReceiptVerifier",
  "agent",
  "stores",
  "raw",
  "policyProvider",
  "hiddenOutcomeSigning",
  "resultEnvelopeSigning",
  "behavioralReleaseSigning",
  "initialPrivacyState",
] as const;
const STORE_KEYS = [
  "boundary",
  "durabilityAttestationHash",
  "ledger",
  "panels",
  "rawIngress",
  "custodian",
  "hiddenOutcomeSink",
  "onlineErrorAuthority",
] as const;
const SIGNING_KEYS = [
  "keyId",
  "trustedKeyIds",
  "privateKeys",
  "publicKeys",
] as const;
const RUNNER_KEYS = [
  "provider",
  "pin",
  "sandbox",
  "harborExecutable",
  "harborWorkingDirectory",
  "harborTimeoutMs",
  "outputPackagerNodeExecutable",
  "outputPackagerTimeoutMs",
  "remoteUploadRoot",
  "remoteOutputRoot",
  "harborSecretReferences",
  "modelSecretReferences",
  "jobBuilder",
  "runtimeVerifier",
] as const;

export type ProductionTrustedEvaluationDependencies = Omit<
  TrustedEvaluationServiceCompositionOptions,
  "stores" | "behavioralReleaseStore" | "now"
> & {
  readonly stores: Omit<
    TrustedProductionEvaluationStores,
    "behavioralPreparations"
  >;
  readonly initialPrivacyState: HiddenPrivacyBudgetState;
};

export interface ProductionMountedVolumeTrustedEvaluatorOptions {
  readonly durableState: MountedVolumeDurableStateOptions;
  readonly lifecycle: ProductionOptimizeLifecycleRegistrar;
  readonly releaseSource: TrustedEvaluationReleaseArtifactSource;
  readonly releaseReader: TrustedEvaluationReleaseArtifactReader;
  readonly now?: () => Date;
}

export interface ProductionMountedVolumeTrustedEvaluatorRuntime {
  readonly boundary:
    "trusted-cloud-mounted-volume-evaluator-runtime";
  readonly service: TrustedEvaluationService;
  readonly releaseSource: TrustedEvaluationReleaseArtifactSource;
  readonly releaseReader: TrustedEvaluationReleaseArtifactReader;
}

export class ProductionMountedVolumeTrustedEvaluatorError extends Error {
  override readonly name =
    "ProductionMountedVolumeTrustedEvaluatorError";

  constructor() {
    super("Production mounted-volume trusted evaluator failed closed.");
  }
}

function fail(): never {
  throw new ProductionMountedVolumeTrustedEvaluatorError();
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

function exactKeys(
  value: unknown,
  expected: readonly string[],
  optional: readonly string[] = [],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail();
  const actual = Reflect.ownKeys(value);
  const allowed = new Set([...expected, ...optional]);
  if (
    actual.some(
      (key) =>
        typeof key !== "string" ||
        !allowed.has(key) ||
        !Object.hasOwn(
          Object.getOwnPropertyDescriptor(value, key) ?? {},
          "value",
        ),
    ) ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    fail();
  }
}

function cloneCanonical<Value>(value: Value): Value {
  try {
    return JSON.parse(canonicalJson(value)) as Value;
  } catch {
    return fail();
  }
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

function captureMethod<
  Owner extends object,
  Arguments extends unknown[],
  Result,
>(
  owner: Owner,
  method: (...arguments_: Arguments) => Result,
): (...arguments_: Arguments) => Result {
  if (
    owner === null ||
    (typeof owner !== "object" && typeof owner !== "function") ||
    typeof method !== "function"
  ) {
    fail();
  }
  return method.bind(owner);
}

function captureProvider(
  provider: ProductionTrustedEvaluationDependencies["runner"]["provider"],
): ProductionTrustedEvaluationDependencies["runner"]["provider"] {
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

function captureSigning(
  value: ProductionTrustedEvaluationDependencies["hiddenOutcomeSigning"],
): ProductionTrustedEvaluationDependencies["hiddenOutcomeSigning"] {
  exactKeys(value, SIGNING_KEYS);
  return Object.freeze({
    keyId: value.keyId,
    trustedKeyIds: Object.freeze([...value.trustedKeyIds]),
    privateKeys: Object.freeze({
      boundary: value.privateKeys.boundary,
      resolve: captureMethod(
        value.privateKeys,
        value.privateKeys.resolve,
      ),
    }),
    publicKeys: Object.freeze({
      boundary: value.publicKeys.boundary,
      resolve: captureMethod(
        value.publicKeys,
        value.publicKeys.resolve,
      ),
    }),
  });
}

function captureDependencies(
  value: ProductionTrustedEvaluationDependencies,
): ProductionTrustedEvaluationDependencies {
  exactKeys(value, DEPENDENCY_KEYS);
  exactKeys(value.stores, STORE_KEYS);
  exactKeys(
    value.raw,
    ["source", "decryptor", "decoder"],
    [
      "maximumEncryptedArtifactBytes",
      "maximumPlaintextArtifactBytes",
    ],
  );
  exactKeys(value.runner, RUNNER_KEYS);

  const runner = value.runner;
  return Object.freeze({
    runner: Object.freeze({
      provider: captureProvider(runner.provider),
      pin: cloneCanonical(runner.pin),
      sandbox: cloneCanonical(runner.sandbox),
      harborExecutable: runner.harborExecutable,
      harborWorkingDirectory: runner.harborWorkingDirectory,
      harborTimeoutMs: runner.harborTimeoutMs,
      outputPackagerNodeExecutable:
        runner.outputPackagerNodeExecutable,
      outputPackagerTimeoutMs:
        runner.outputPackagerTimeoutMs,
      remoteUploadRoot: runner.remoteUploadRoot,
      remoteOutputRoot: runner.remoteOutputRoot,
      harborSecretReferences: cloneCanonical(
        runner.harborSecretReferences,
      ),
      modelSecretReferences: cloneCanonical(
        runner.modelSecretReferences,
      ),
      jobBuilder: Object.freeze({
        build: captureMethod(
          runner.jobBuilder,
          runner.jobBuilder.build,
        ),
      }),
      runtimeVerifier: Object.freeze({
        verify: captureMethod(
          runner.runtimeVerifier,
          runner.runtimeVerifier.verify,
        ),
      }),
    }),
    retentionPolicy: cloneCanonical(value.retentionPolicy),
    destructionReceiptVerifier: Object.freeze({
      trustedKeyId:
        value.destructionReceiptVerifier.trustedKeyId,
      publicKey: capturePublicKey(
        value.destructionReceiptVerifier.publicKey,
      ),
    }),
    agent: cloneCanonical(value.agent),
    stores: Object.freeze({
      boundary: value.stores.boundary,
      durabilityAttestationHash:
        value.stores.durabilityAttestationHash,
      ledger: Object.freeze({
        claim: captureMethod(
          value.stores.ledger,
          value.stores.ledger.claim,
        ),
        inspect: captureMethod(
          value.stores.ledger,
          value.stores.ledger.inspect,
        ),
        recoverInFlight: captureMethod(
          value.stores.ledger,
          value.stores.ledger.recoverInFlight,
        ),
        bindDispositionAttestation: captureMethod(
          value.stores.ledger,
          value.stores.ledger.bindDispositionAttestation,
        ),
        complete: captureMethod(
          value.stores.ledger,
          value.stores.ledger.complete,
        ),
        consumeFailure: captureMethod(
          value.stores.ledger,
          value.stores.ledger.consumeFailure,
        ),
      }),
      panels: Object.freeze({
        allocateAndConsume: captureMethod(
          value.stores.panels,
          value.stores.panels.allocateAndConsume,
        ),
      }),
      rawIngress: Object.freeze({
        persist: captureMethod(
          value.stores.rawIngress,
          value.stores.rawIngress.persist,
        ),
        discard: captureMethod(
          value.stores.rawIngress,
          value.stores.rawIngress.discard,
        ),
      }),
      custodian: Object.freeze({
        destroy: captureMethod(
          value.stores.custodian,
          value.stores.custodian.destroy,
        ),
      }),
      hiddenOutcomeSink: Object.freeze({
        commit: captureMethod(
          value.stores.hiddenOutcomeSink,
          value.stores.hiddenOutcomeSink.commit,
        ),
      }),
      onlineErrorAuthority: Object.freeze({
        boundary:
          value.stores.onlineErrorAuthority.boundary,
        reserve: captureMethod(
          value.stores.onlineErrorAuthority,
          value.stores.onlineErrorAuthority.reserve,
        ),
        reconcile: captureMethod(
          value.stores.onlineErrorAuthority,
          value.stores.onlineErrorAuthority.reconcile,
        ),
      }),
    }),
    raw: Object.freeze({
      source: Object.freeze({
        boundary: value.raw.source.boundary,
        read: captureMethod(
          value.raw.source,
          value.raw.source.read,
        ),
      }),
      decryptor: Object.freeze({
        boundary: value.raw.decryptor.boundary,
        decrypt: captureMethod(
          value.raw.decryptor,
          value.raw.decryptor.decrypt,
        ),
      }),
      decoder: Object.freeze({
        boundary: value.raw.decoder.boundary,
        decode: captureMethod(
          value.raw.decoder,
          value.raw.decoder.decode,
        ),
      }),
      ...(value.raw.maximumEncryptedArtifactBytes === undefined
        ? {}
        : {
            maximumEncryptedArtifactBytes:
              value.raw.maximumEncryptedArtifactBytes,
          }),
      ...(value.raw.maximumPlaintextArtifactBytes === undefined
        ? {}
        : {
            maximumPlaintextArtifactBytes:
              value.raw.maximumPlaintextArtifactBytes,
          }),
    }),
    policyProvider: Object.freeze({
      boundary: value.policyProvider.boundary,
      load: captureMethod(
        value.policyProvider,
        value.policyProvider.load,
      ),
    }),
    hiddenOutcomeSigning: captureSigning(
      value.hiddenOutcomeSigning,
    ),
    resultEnvelopeSigning: captureSigning(
      value.resultEnvelopeSigning,
    ),
    behavioralReleaseSigning: captureSigning(
      value.behavioralReleaseSigning,
    ),
    initialPrivacyState: cloneCanonical(
      value.initialPrivacyState,
    ),
  });
}

function assertQuery(
  value: EvaluationReleaseArtifactQuery,
): void {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "purpose",
    "contentHash",
    "queryHash",
  ]);
  const unsigned = {
    schemaVersion: value.schemaVersion,
    domain: value.domain,
    purpose: value.purpose,
    contentHash: value.contentHash,
  };
  if (
    value.schemaVersion !== 1 ||
    value.domain !==
      "dark-factory.evaluation-release-artifact-query.v1" ||
    !SHA256.test(value.contentHash) ||
    value.queryHash !== canonicalHash(unsigned)
  ) {
    fail();
  }
}

function behavioralPurpose(
  value: EvaluationReleaseArtifactQuery["purpose"],
): value is BehavioralReleaseArtifact["purpose"] {
  return BEHAVIORAL_PURPOSES.includes(
    value as BehavioralReleaseArtifact["purpose"],
  );
}

function behavioralUri(
  purpose: BehavioralReleaseArtifact["purpose"],
  contentHash: string,
): `trusted://${string}` {
  return `trusted://behavioral-release/${purpose}/${contentHash}`;
}

export class TrustedBehavioralReleaseArtifactOverlay {
  readonly source: TrustedEvaluationReleaseArtifactSource;
  readonly reader: TrustedEvaluationReleaseArtifactReader;
  readonly #resolveBehavioral:
    TrustedBehavioralPrivacyArtifactStore["resolveByContentHash"];
  readonly #locateFallback:
    TrustedEvaluationReleaseArtifactSource["locate"];
  readonly #readFallback:
    TrustedEvaluationReleaseArtifactReader["readUtf8"];

  constructor(
    store: Pick<
      TrustedBehavioralPrivacyArtifactStore,
      "resolveByContentHash"
    >,
    fallbackSource: TrustedEvaluationReleaseArtifactSource,
    fallbackReader: TrustedEvaluationReleaseArtifactReader,
  ) {
    if (
      fallbackSource.boundary !== "trusted-cloud" ||
      fallbackReader.boundary !== "trusted-cloud"
    ) {
      fail();
    }
    this.#resolveBehavioral = captureMethod(
      store,
      store.resolveByContentHash,
    );
    this.#locateFallback = captureMethod(
      fallbackSource,
      fallbackSource.locate,
    );
    this.#readFallback = captureMethod(
      fallbackReader,
      fallbackReader.readUtf8,
    );
    this.source = Object.freeze({
      boundary: "trusted-cloud" as const,
      locate: this.#locate.bind(this),
    });
    this.reader = Object.freeze({
      boundary: "trusted-cloud" as const,
      readUtf8: this.#readUtf8.bind(this),
    });
  }

  async #locate(
    query: EvaluationReleaseArtifactQuery,
  ): Promise<TrustedCloudArtifactRef | undefined> {
    const canonicalQuery = cloneCanonical(query);
    assertQuery(canonicalQuery);
    if (!behavioralPurpose(canonicalQuery.purpose)) {
      if (canonicalQuery.purpose !== "cache-attestation") {
        fail();
      }
      const queryJson = canonicalJson(canonicalQuery);
      const located = await this.#locateFallback(canonicalQuery);
      if (canonicalJson(canonicalQuery) !== queryJson) fail();
      if (
        located !== undefined &&
        located.uri.startsWith(BEHAVIORAL_URI_PREFIX)
      ) {
        fail();
      }
      return located;
    }
    const artifact = await this.#resolveBehavioral({
      purpose: canonicalQuery.purpose,
      contentHash: canonicalQuery.contentHash,
    });
    if (artifact === undefined) return undefined;
    if (
      artifact.purpose !== canonicalQuery.purpose ||
      artifact.document.contentHash !==
        canonicalQuery.contentHash
    ) {
      fail();
    }
    const raw = `${canonicalJson(artifact.document)}\n`;
    return Object.freeze({
      uri: behavioralUri(
        canonicalQuery.purpose,
        canonicalQuery.contentHash,
      ),
      sha256: sha256(raw),
      mediaType: "application/json",
      byteLength: Buffer.byteLength(raw, "utf8"),
    });
  }

  async #readUtf8(
    artifact: TrustedCloudArtifactRef,
    maximumBytes: number,
  ): Promise<string> {
    const reference = cloneCanonical(artifact);
    const match = BEHAVIORAL_URI.exec(reference.uri);
    if (match === null) {
      if (reference.uri.startsWith(BEHAVIORAL_URI_PREFIX)) {
        fail();
      }
      const referenceJson = canonicalJson(reference);
      const raw = await this.#readFallback(
        reference,
        maximumBytes,
      );
      if (canonicalJson(reference) !== referenceJson) fail();
      return raw;
    }
    const purpose = match[1] as
      | BehavioralReleaseArtifact["purpose"]
      | undefined;
    const contentHash = match[2];
    if (
      purpose === undefined ||
      contentHash === undefined ||
      !behavioralPurpose(purpose) ||
      reference.mediaType !== "application/json" ||
      !SHA256.test(reference.sha256) ||
      !Number.isSafeInteger(reference.byteLength) ||
      reference.byteLength < 1 ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < reference.byteLength
    ) {
      fail();
    }
    const stored = await this.#resolveBehavioral({
      purpose,
      contentHash,
    });
    if (stored === undefined) fail();
    const raw = `${canonicalJson(stored.document)}\n`;
    if (
      stored.purpose !== purpose ||
      stored.document.contentHash !== contentHash ||
      behavioralUri(purpose, contentHash) !== reference.uri ||
      sha256(raw) !== reference.sha256 ||
      Buffer.byteLength(raw, "utf8") !== reference.byteLength
    ) {
      fail();
    }
    return raw;
  }
}

/**
 * Fixed production adapter for the evaluator trust zone. The only dynamic
 * inputs are already-typed provider/KMS/storage capabilities; no descriptor,
 * task identity, optimizer value, module name, or executable selects a
 * constructor. Both private mounted stores register before the first await.
 */
export class ProductionMountedVolumeTrustedEvaluator {
  readonly #dependencies: ProductionTrustedEvaluationDependencies;

  constructor(dependencies: ProductionTrustedEvaluationDependencies) {
    this.#dependencies = captureDependencies(dependencies);
  }

  async create(
    options: ProductionMountedVolumeTrustedEvaluatorOptions,
  ): Promise<ProductionMountedVolumeTrustedEvaluatorRuntime> {
    try {
      exactKeys(
        options,
        [
          "durableState",
          "lifecycle",
          "releaseSource",
          "releaseReader",
        ],
        ["now"],
      );
      if (
        options.lifecycle.boundary !==
          "production-optimize-composition-owner" ||
        typeof options.lifecycle.register !== "function"
      ) {
        fail();
      }
      const preparations =
        new MountedVolumeBehavioralPreparationStore({
          durableState: options.durableState,
          lifecycle: options.lifecycle,
        });
      const releases =
        new MountedVolumeBehavioralPrivacyArtifactStore({
          durableState: options.durableState,
          initialPrivacyState:
            this.#dependencies.initialPrivacyState,
          lifecycle: options.lifecycle,
        });
      const service = await createTrustedEvaluationService({
        runner: this.#dependencies.runner,
        retentionPolicy: this.#dependencies.retentionPolicy,
        destructionReceiptVerifier:
          this.#dependencies.destructionReceiptVerifier,
        agent: this.#dependencies.agent,
        stores: {
          ...this.#dependencies.stores,
          behavioralPreparations: preparations,
        },
        raw: this.#dependencies.raw,
        policyProvider: this.#dependencies.policyProvider,
        hiddenOutcomeSigning:
          this.#dependencies.hiddenOutcomeSigning,
        resultEnvelopeSigning:
          this.#dependencies.resultEnvelopeSigning,
        behavioralReleaseStore: releases,
        behavioralReleaseSigning:
          this.#dependencies.behavioralReleaseSigning,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      const artifacts =
        new TrustedBehavioralReleaseArtifactOverlay(
          releases,
          options.releaseSource,
          options.releaseReader,
        );
      return Object.freeze({
        boundary:
          "trusted-cloud-mounted-volume-evaluator-runtime" as const,
        service,
        releaseSource: artifacts.source,
        releaseReader: artifacts.reader,
      });
    } catch (error) {
      if (
        error instanceof
        ProductionMountedVolumeTrustedEvaluatorError
      ) {
        throw error;
      }
      return fail();
    }
  }
}
