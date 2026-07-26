import { createPublicKey, type KeyLike } from "node:crypto";

import type { CanonicalEvaluatorKeyring } from "./canonical-client.js";
import type { TrustedCloudEd25519PublicKeyProvider } from "./hidden-update-signature.js";

const SAFE_KEY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const SAFE_KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;

export interface CloudBackedCanonicalEvaluatorKeyringOptions {
  readonly keys: TrustedCloudEd25519PublicKeyProvider;
  /**
   * Complete predeclared rotation set. Unknown identifiers are rejected
   * without querying the key provider.
   */
  readonly trustedKeyIds: readonly string[];
}

export class TrustedCanonicalEvaluatorKeyringError extends Error {
  override readonly name = "TrustedCanonicalEvaluatorKeyringError";

  constructor() {
    super("Trusted evaluator verification-key resolution failed.");
  }
}

/**
 * Adapts the evaluator's versioned cloud public-key provider to both the
 * canonical evaluator client and the adaptive-release signature verifier.
 *
 * Only result-envelope keys may cross this port. Private material is never
 * requested, cached, or returned.
 */
export class CloudBackedCanonicalEvaluatorKeyring
  implements CanonicalEvaluatorKeyring
{
  readonly #keys: TrustedCloudEd25519PublicKeyProvider;
  readonly #trustedKeyIds: ReadonlySet<string>;

  constructor(options: CloudBackedCanonicalEvaluatorKeyringOptions) {
    const trustedKeyIds = new Set(options.trustedKeyIds);
    if (
      options.keys.boundary !== "trusted-cloud" ||
      trustedKeyIds.size < 1 ||
      trustedKeyIds.size !== options.trustedKeyIds.length ||
      [...trustedKeyIds].some((keyId) => !SAFE_KEY_ID.test(keyId))
    ) {
      throw new TrustedCanonicalEvaluatorKeyringError();
    }
    this.#keys = options.keys;
    this.#trustedKeyIds = trustedKeyIds;
  }

  public async getVerificationKey(
    keyId: string,
  ): Promise<KeyLike | undefined> {
    if (!SAFE_KEY_ID.test(keyId) || !this.#trustedKeyIds.has(keyId)) {
      return undefined;
    }
    try {
      const key = await this.#keys.resolve({
        purpose: "result-envelope",
        keyId,
      });
      if (key === undefined) return undefined;
      if (
        key.boundary !== "trusted-cloud-key-material" ||
        key.algorithm !== "Ed25519" ||
        key.purpose !== "result-envelope" ||
        key.keyId !== keyId ||
        !SAFE_KEY_VERSION.test(key.keyVersion) ||
        key.publicKey === undefined ||
        key.publicKey === null
      ) {
        throw new TrustedCanonicalEvaluatorKeyringError();
      }
      const publicKey = createPublicKey(key.publicKey);
      if (
        publicKey.type !== "public" ||
        publicKey.asymmetricKeyType !== "ed25519"
      ) {
        throw new TrustedCanonicalEvaluatorKeyringError();
      }
      return publicKey;
    } catch (error) {
      if (error instanceof TrustedCanonicalEvaluatorKeyringError) throw error;
      throw new TrustedCanonicalEvaluatorKeyringError();
    }
  }
}
