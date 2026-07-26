import type { KeyLike } from "node:crypto";

import {
  createEd25519Signature,
  verifyEd25519Signature,
} from "../evidence/signatures.js";
import type { Signature } from "../schemas/primitives.js";
import {
  assertTrustedHiddenCatalogOutcomeUpdateIntegrity,
  type TrustedHiddenCatalogOutcomeUpdateSigner,
  type TrustedHiddenCatalogOutcomeUpdateVerifier,
  type TrustedSignedHiddenCatalogOutcomeUpdate,
  type UnsignedTrustedHiddenCatalogOutcomeUpdate,
} from "./deriver.js";
import type { TrustedEvaluatorPortBoundary } from "./raw-reader.js";

export type TrustedEd25519KeyPurpose =
  | "hidden-catalog-outcome-update"
  | "result-envelope"
  | "behavioral-release";

export interface TrustedCloudEd25519PrivateKey {
  readonly boundary: "trusted-cloud-key-material";
  readonly algorithm: "Ed25519";
  readonly purpose: TrustedEd25519KeyPurpose;
  readonly keyId: string;
  readonly keyVersion: string;
  readonly privateKey: KeyLike;
}

export interface TrustedCloudEd25519PublicKey {
  readonly boundary: "trusted-cloud-key-material";
  readonly algorithm: "Ed25519";
  readonly purpose: TrustedEd25519KeyPurpose;
  readonly keyId: string;
  readonly keyVersion: string;
  readonly publicKey: KeyLike;
}

/**
 * Production adapters resolve a versioned secret/KMS reference inside the
 * trusted evaluator. Implementations must not export key material to the local
 * controller or persist it in experiment artifacts.
 */
export interface TrustedCloudEd25519PrivateKeyProvider {
  readonly boundary: TrustedEvaluatorPortBoundary;
  resolve(input: {
    readonly purpose: TrustedEd25519KeyPurpose;
    readonly keyId: string;
  }): Promise<TrustedCloudEd25519PrivateKey>;
}

export interface TrustedCloudEd25519PublicKeyProvider {
  readonly boundary: TrustedEvaluatorPortBoundary;
  resolve(input: {
    readonly purpose: TrustedEd25519KeyPurpose;
    readonly keyId: string;
  }): Promise<TrustedCloudEd25519PublicKey | undefined>;
}

export interface CloudBackedHiddenOutcomeSignerOptions {
  readonly deployment: "trusted-cloud" | "test-only";
  readonly keyId: string;
  readonly keys: TrustedCloudEd25519PrivateKeyProvider;
  readonly now?: () => Date;
}

export interface CloudBackedHiddenOutcomeVerifierOptions {
  readonly deployment: "trusted-cloud" | "test-only";
  readonly keys: TrustedCloudEd25519PublicKeyProvider;
  readonly trustedKeyIds: readonly string[];
  readonly now?: () => Date;
  readonly maximumClockSkewMs?: number;
}

const SAFE_KEY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const SAFE_KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;

export class TrustedHiddenUpdateSignatureError extends Error {
  override readonly name = "TrustedHiddenUpdateSignatureError";

  constructor() {
    super("Trusted hidden-catalog update signature operation failed.");
  }
}

function canonicalTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("Signature timestamp is not canonical UTC.");
  }
  return parsed;
}

function requiredBoundary(
  deployment: "trusted-cloud" | "test-only",
): TrustedEvaluatorPortBoundary {
  return deployment === "trusted-cloud"
    ? "trusted-cloud"
    : "test-only-in-memory";
}

function assertPrivateKey(
  value: TrustedCloudEd25519PrivateKey,
  purpose: TrustedEd25519KeyPurpose,
  keyId: string,
): void {
  if (
    value.boundary !== "trusted-cloud-key-material" ||
    value.algorithm !== "Ed25519" ||
    value.purpose !== purpose ||
    value.keyId !== keyId ||
    !SAFE_KEY_VERSION.test(value.keyVersion) ||
    value.privateKey === undefined ||
    value.privateKey === null
  ) {
    throw new Error("Private signing key is detached.");
  }
}

function assertPublicKey(
  value: TrustedCloudEd25519PublicKey,
  purpose: TrustedEd25519KeyPurpose,
  keyId: string,
): void {
  if (
    value.boundary !== "trusted-cloud-key-material" ||
    value.algorithm !== "Ed25519" ||
    value.purpose !== purpose ||
    value.keyId !== keyId ||
    !SAFE_KEY_VERSION.test(value.keyVersion) ||
    value.publicKey === undefined ||
    value.publicKey === null
  ) {
    throw new Error("Public verification key is detached.");
  }
}

export class CloudBackedHiddenCatalogOutcomeUpdateSigner
  implements TrustedHiddenCatalogOutcomeUpdateSigner
{
  readonly boundary: TrustedEvaluatorPortBoundary;
  readonly #keyId: string;
  readonly #keys: TrustedCloudEd25519PrivateKeyProvider;
  readonly #now: () => Date;

  constructor(options: CloudBackedHiddenOutcomeSignerOptions) {
    const boundary = requiredBoundary(options.deployment);
    if (
      options.keys.boundary !== boundary ||
      !SAFE_KEY_ID.test(options.keyId)
    ) {
      throw new TrustedHiddenUpdateSignatureError();
    }
    this.boundary = boundary;
    this.#keyId = options.keyId;
    this.#keys = options.keys;
    this.#now = options.now ?? (() => new Date());
  }

  async sign(
    update: UnsignedTrustedHiddenCatalogOutcomeUpdate,
  ): Promise<Signature> {
    try {
      const signedAt = this.#now().toISOString();
      if (
        canonicalTimestamp(signedAt) <
        canonicalTimestamp(update.observedAt)
      ) {
        throw new Error("Hidden outcome update cannot be backdated.");
      }
      const key = await this.#keys.resolve({
        purpose: "hidden-catalog-outcome-update",
        keyId: this.#keyId,
      });
      assertPrivateKey(
        key,
        "hidden-catalog-outcome-update",
        this.#keyId,
      );
      return createEd25519Signature(
        update as unknown as Readonly<Record<string, unknown>>,
        key.privateKey,
        this.#keyId,
        signedAt,
      );
    } catch {
      throw new TrustedHiddenUpdateSignatureError();
    }
  }
}

export class CloudBackedHiddenCatalogOutcomeUpdateVerifier
  implements TrustedHiddenCatalogOutcomeUpdateVerifier
{
  readonly boundary: TrustedEvaluatorPortBoundary;
  readonly #keys: TrustedCloudEd25519PublicKeyProvider;
  readonly #trustedKeyIds: ReadonlySet<string>;
  readonly #now: () => Date;
  readonly #maximumClockSkewMs: number;

  constructor(options: CloudBackedHiddenOutcomeVerifierOptions) {
    const boundary = requiredBoundary(options.deployment);
    const trustedKeyIds = new Set(options.trustedKeyIds);
    const maximumClockSkewMs =
      options.maximumClockSkewMs ?? 5 * 60_000;
    if (
      options.keys.boundary !== boundary ||
      trustedKeyIds.size < 1 ||
      trustedKeyIds.size !== options.trustedKeyIds.length ||
      [...trustedKeyIds].some((keyId) => !SAFE_KEY_ID.test(keyId)) ||
      !Number.isSafeInteger(maximumClockSkewMs) ||
      maximumClockSkewMs < 0 ||
      maximumClockSkewMs > 60 * 60_000
    ) {
      throw new TrustedHiddenUpdateSignatureError();
    }
    this.boundary = boundary;
    this.#keys = options.keys;
    this.#trustedKeyIds = trustedKeyIds;
    this.#now = options.now ?? (() => new Date());
    this.#maximumClockSkewMs = maximumClockSkewMs;
  }

  async verify(
    update: TrustedSignedHiddenCatalogOutcomeUpdate,
  ): Promise<boolean> {
    try {
      assertTrustedHiddenCatalogOutcomeUpdateIntegrity(update);
      if (!this.#trustedKeyIds.has(update.signature.keyId)) {
        return false;
      }
      const signedAt = canonicalTimestamp(update.signature.signedAt);
      const now = this.#now().getTime();
      if (
        !Number.isFinite(now) ||
        signedAt > now + this.#maximumClockSkewMs
      ) {
        return false;
      }
      const key = await this.#keys.resolve({
        purpose: "hidden-catalog-outcome-update",
        keyId: update.signature.keyId,
      });
      if (key === undefined) return false;
      assertPublicKey(
        key,
        "hidden-catalog-outcome-update",
        update.signature.keyId,
      );
      return verifyEd25519Signature(
        update as unknown as Readonly<Record<string, unknown>>,
        key.publicKey,
      );
    } catch {
      return false;
    }
  }
}
