import { createPublicKey, type KeyLike } from "node:crypto";

import type {
  CampaignControlAttestation,
  CampaignControlAttestationVerifier,
  CampaignDecisionAttestation,
  CampaignDecisionAttestationVerifier,
  CampaignLedgerTransition,
  CampaignLedgerTransitionVerifier,
} from "../campaign/store.js";
import { verifyEd25519Signature } from "../evidence/signatures.js";
import {
  canonicalHash,
  canonicalJson,
  computeContentHash,
  sha256,
} from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import type { TrustedCloudArtifactRef } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const SAFE_KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86,128}$/u;
const DEFAULT_MAXIMUM_BYTES = 4 * 1024 * 1024;
const MAXIMUM_BYTES_CEILING = 16 * 1024 * 1024;

export type TrustedCampaignAttestationEvidenceKind =
  | "ledger-transition"
  | "decision"
  | "control";

export type TrustedCampaignAttestationPayload =
  | CampaignLedgerTransition
  | CampaignDecisionAttestation
  | CampaignControlAttestation;

export type TrustedCampaignAttestationEvidenceInput =
  | {
      readonly evidenceKind: "ledger-transition";
      readonly payload: CampaignLedgerTransition;
    }
  | {
      readonly evidenceKind: "decision";
      readonly payload: CampaignDecisionAttestation;
    }
  | {
      readonly evidenceKind: "control";
      readonly payload: CampaignControlAttestation;
    };

export interface UnsignedTrustedCampaignAttestationEvidence {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.campaign-attestation-evidence.v1";
  readonly sensitivity: "release-safe-control";
  readonly evidenceKind: TrustedCampaignAttestationEvidenceKind;
  readonly campaignId: string;
  readonly protocolHash: string;
  /**
   * The authority lookup key. For externally authorized transitions this is
   * the authorization/attestation hash already committed by CampaignState.
   * Genesis and ledger transitions use the canonical payload hash because
   * their store interfaces intentionally contain no extra mutable pointer.
   */
  readonly lookupHash: string;
  readonly payloadHash: string;
  readonly payload: TrustedCampaignAttestationPayload;
  readonly issuedAt: string;
}

export interface SignedTrustedCampaignAttestationEvidence
  extends UnsignedTrustedCampaignAttestationEvidence {
  readonly signature: Signature;
  readonly contentHash: string;
}

export interface TrustedCampaignAttestationArtifactQuery {
  readonly evidenceKind: TrustedCampaignAttestationEvidenceKind;
  readonly campaignId: string;
  readonly protocolHash: string;
  readonly lookupHash: string;
  readonly payloadHash: string;
}

/**
 * A provider-specific registry maps the release-safe lookup tuple to an
 * immutable JSON artifact. Task identities and grader evidence are not part
 * of this contract.
 */
export interface TrustedCampaignAttestationArtifactSource {
  readonly boundary: "trusted-cloud";
  locate(
    query: TrustedCampaignAttestationArtifactQuery,
  ): Promise<TrustedCloudArtifactRef | undefined>;
}

export interface TrustedCampaignAttestationArtifactReader {
  readonly boundary: "trusted-cloud";
  readUtf8(
    artifact: TrustedCloudArtifactRef,
    maximumBytes: number,
  ): Promise<string>;
}

export interface TrustedCampaignAttestationKeyring {
  readonly boundary: "trusted-cloud";
  resolve(input: {
    readonly purpose: "campaign-attestation";
    readonly keyId: string;
  }): Promise<TrustedCampaignAttestationPublicKey | undefined>;
}

export interface TrustedCampaignAttestationPublicKey {
  readonly boundary: "trusted-cloud-key-material";
  readonly algorithm: "Ed25519";
  readonly purpose: "campaign-attestation";
  readonly keyId: string;
  readonly keyVersion: string;
  readonly publicKey: KeyLike;
}

export interface ArtifactBackedCampaignAttestationVerifierOptions {
  readonly source: TrustedCampaignAttestationArtifactSource;
  readonly reader: TrustedCampaignAttestationArtifactReader;
  readonly keyring: TrustedCampaignAttestationKeyring;
  /**
   * Complete predeclared rotation set. A historical campaign remains
   * reconstructable only while its signing key remains in this set.
   */
  readonly trustedKeyIds: readonly string[];
  readonly maximumBytes?: number;
}

export class TrustedCampaignAttestationVerificationError extends Error {
  override readonly name = "TrustedCampaignAttestationVerificationError";

  constructor() {
    super("Trusted campaign attestation verification failed.");
  }
}

function fail(): never {
  throw new TrustedCampaignAttestationVerificationError();
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
  keys: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail();
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    fail();
  }
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function campaignIdentity(
  input: TrustedCampaignAttestationEvidenceInput,
): {
  readonly campaignId: string;
  readonly protocolHash: string;
} {
  const { campaignId, protocolHash } = input.payload;
  if (!SAFE_ID.test(campaignId) || !SHA256.test(protocolHash)) fail();
  return { campaignId, protocolHash };
}

/**
 * Derives the only acceptable registry lookup for a store verifier call.
 * The provider/KMS authority should use the same helper when publishing
 * evidence, preventing producer and verifier lookup rules from drifting.
 */
export function trustedCampaignAttestationLookupHash(
  input: TrustedCampaignAttestationEvidenceInput,
): string {
  const payloadHash = canonicalHash(input.payload);
  switch (input.evidenceKind) {
    case "ledger-transition":
      return payloadHash;
    case "decision":
      if (!SHA256.test(input.payload.decisionAttestationHash)) fail();
      return input.payload.decisionAttestationHash;
    case "control":
      if (input.payload.kind === "genesis") return payloadHash;
      if (!SHA256.test(input.payload.authorizationOrAttestationHash)) fail();
      return input.payload.authorizationOrAttestationHash;
  }
}

/**
 * Creates the exact unsigned document a cloud/KMS authority must sign.
 * This helper never resolves or handles private key material.
 */
export function createUnsignedTrustedCampaignAttestationEvidence(input: {
  readonly evidence: TrustedCampaignAttestationEvidenceInput;
  readonly issuedAt: string;
}): UnsignedTrustedCampaignAttestationEvidence {
  if (!canonicalTimestamp(input.issuedAt)) fail();
  const identity = campaignIdentity(input.evidence);
  const payload = JSON.parse(
    canonicalJson(input.evidence.payload),
  ) as TrustedCampaignAttestationPayload;
  const payloadHash = canonicalHash(payload);
  return {
    schemaVersion: 1,
    domain: "dark-factory.campaign-attestation-evidence.v1",
    sensitivity: "release-safe-control",
    evidenceKind: input.evidence.evidenceKind,
    campaignId: identity.campaignId,
    protocolHash: identity.protocolHash,
    lookupHash: trustedCampaignAttestationLookupHash(input.evidence),
    payloadHash,
    payload,
    issuedAt: input.issuedAt,
  };
}

function assertSignature(
  value: unknown,
  trustedKeyIds: ReadonlySet<string>,
  issuedAt: string,
): asserts value is Signature {
  exactKeys(value, ["algorithm", "keyId", "signedAt", "signature"]);
  if (
    value.algorithm !== "ed25519" ||
    typeof value.keyId !== "string" ||
    !trustedKeyIds.has(value.keyId) ||
    value.signedAt !== issuedAt ||
    !canonicalTimestamp(value.signedAt) ||
    typeof value.signature !== "string" ||
    !BASE64URL_SIGNATURE.test(value.signature)
  ) {
    fail();
  }
}

function assertArtifact(
  value: TrustedCloudArtifactRef | undefined,
  maximumBytes: number,
): asserts value is TrustedCloudArtifactRef {
  if (
    value === undefined ||
    !isPlainRecord(value) ||
    Object.keys(value).length !== 4 ||
    !["uri", "sha256", "mediaType", "byteLength"].every((key) =>
      Object.hasOwn(value, key),
    ) ||
    value.mediaType !== "application/json" ||
    !SHA256.test(value.sha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > maximumBytes ||
    !/^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(
      value.uri,
    ) ||
    value.uri.includes("..")
  ) {
    fail();
  }
}

/**
 * One production verifier for all CampaignState trust hooks. It resolves only
 * immutable release-safe control evidence, enforces canonical JSON and exact
 * payload equality, then verifies an Ed25519 signature using a predeclared
 * public-key rotation set.
 */
export class ArtifactBackedCampaignAttestationVerifier
  implements
    CampaignLedgerTransitionVerifier,
    CampaignDecisionAttestationVerifier,
    CampaignControlAttestationVerifier
{
  readonly #locate: TrustedCampaignAttestationArtifactSource["locate"];
  readonly #readUtf8: TrustedCampaignAttestationArtifactReader["readUtf8"];
  readonly #resolveKey: TrustedCampaignAttestationKeyring["resolve"];
  readonly #trustedKeyIds: ReadonlySet<string>;
  readonly #maximumBytes: number;

  constructor(options: ArtifactBackedCampaignAttestationVerifierOptions) {
    const trustedKeyIds = new Set(options.trustedKeyIds);
    const maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
    if (
      options.source.boundary !== "trusted-cloud" ||
      options.reader.boundary !== "trusted-cloud" ||
      options.keyring.boundary !== "trusted-cloud" ||
      typeof options.source.locate !== "function" ||
      typeof options.reader.readUtf8 !== "function" ||
      typeof options.keyring.resolve !== "function" ||
      trustedKeyIds.size < 1 ||
      trustedKeyIds.size !== options.trustedKeyIds.length ||
      [...trustedKeyIds].some((keyId) => !SAFE_ID.test(keyId)) ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 4_096 ||
      maximumBytes > MAXIMUM_BYTES_CEILING
    ) {
      fail();
    }
    this.#locate = options.source.locate.bind(options.source);
    this.#readUtf8 = options.reader.readUtf8.bind(options.reader);
    this.#resolveKey = options.keyring.resolve.bind(options.keyring);
    this.#trustedKeyIds = trustedKeyIds;
    this.#maximumBytes = maximumBytes;
  }

  verify(
    value:
      | CampaignLedgerTransition
      | CampaignDecisionAttestation
      | CampaignControlAttestation,
  ): Promise<void> {
    if (!isPlainRecord(value)) {
      return Promise.reject(new TrustedCampaignAttestationVerificationError());
    }
    if ("reason" in value && "operation" in value) {
      return this.#verify({
        evidenceKind: "ledger-transition",
        payload: value,
      });
    }
    if ("decisionAttestationHash" in value) {
      return this.#verify({
        evidenceKind: "decision",
        payload: value,
      });
    }
    return this.#verify({
      evidenceKind: "control",
      payload: value,
    });
  }

  async #verify(
    input: TrustedCampaignAttestationEvidenceInput,
  ): Promise<void> {
    try {
      const snapshot = JSON.parse(
        canonicalJson(input),
      ) as TrustedCampaignAttestationEvidenceInput;
      const identity = campaignIdentity(snapshot);
      const payloadHash = canonicalHash(snapshot.payload);
      const lookupHash = trustedCampaignAttestationLookupHash(snapshot);
      const query: TrustedCampaignAttestationArtifactQuery = Object.freeze({
        evidenceKind: snapshot.evidenceKind,
        campaignId: identity.campaignId,
        protocolHash: identity.protocolHash,
        lookupHash,
        payloadHash,
      });
      const locatedArtifact = await this.#locate(query);
      assertArtifact(locatedArtifact, this.#maximumBytes);
      const artifact: TrustedCloudArtifactRef = Object.freeze({
        uri: locatedArtifact.uri,
        sha256: locatedArtifact.sha256,
        mediaType: locatedArtifact.mediaType,
        byteLength: locatedArtifact.byteLength,
      });
      const raw = await this.#readUtf8(
        artifact,
        this.#maximumBytes,
      );
      const rawByteLength = Buffer.byteLength(raw, "utf8");
      if (
        !Number.isSafeInteger(rawByteLength) ||
        rawByteLength <= 0 ||
        rawByteLength > this.#maximumBytes ||
        rawByteLength !== artifact.byteLength ||
        sha256(raw) !== artifact.sha256
      ) {
        fail();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        fail();
      }
      if (raw !== `${canonicalJson(parsed)}\n`) fail();
      exactKeys(parsed, [
        "schemaVersion",
        "domain",
        "sensitivity",
        "evidenceKind",
        "campaignId",
        "protocolHash",
        "lookupHash",
        "payloadHash",
        "payload",
        "issuedAt",
        "signature",
        "contentHash",
      ]);
      if (
        parsed.schemaVersion !== 1 ||
        parsed.domain !==
          "dark-factory.campaign-attestation-evidence.v1" ||
        parsed.sensitivity !== "release-safe-control" ||
        parsed.evidenceKind !== snapshot.evidenceKind ||
        parsed.campaignId !== identity.campaignId ||
        parsed.protocolHash !== identity.protocolHash ||
        parsed.lookupHash !== lookupHash ||
        parsed.payloadHash !== payloadHash ||
        !canonicalTimestamp(parsed.issuedAt) ||
        typeof parsed.contentHash !== "string" ||
        !SHA256.test(parsed.contentHash) ||
        parsed.contentHash !== computeContentHash(parsed) ||
        canonicalJson(parsed.payload) !== canonicalJson(snapshot.payload)
      ) {
        fail();
      }
      assertSignature(parsed.signature, this.#trustedKeyIds, parsed.issuedAt);
      const key = await this.#resolveKey({
        purpose: "campaign-attestation",
        keyId: parsed.signature.keyId,
      });
      if (
        key === undefined ||
        key.boundary !== "trusted-cloud-key-material" ||
        key.algorithm !== "Ed25519" ||
        key.purpose !== "campaign-attestation" ||
        key.keyId !== parsed.signature.keyId ||
        !SAFE_KEY_VERSION.test(key.keyVersion)
      ) {
        fail();
      }
      const publicKey = createPublicKey(key.publicKey);
      if (
        publicKey.type !== "public" ||
        publicKey.asymmetricKeyType !== "ed25519" ||
        !verifyEd25519Signature(parsed, publicKey)
      ) {
        fail();
      }
    } catch (error) {
      if (error instanceof TrustedCampaignAttestationVerificationError) {
        throw error;
      }
      fail();
    }
  }
}
