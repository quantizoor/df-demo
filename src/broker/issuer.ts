import type { KeyLike } from "node:crypto";
import { hashEvaluationRequest, type TrustedEvaluationRequest } from "../evaluator/contracts.js";
import { createEd25519Signature, verifyEd25519Signature } from "../evidence/signatures.js";
import { withContentHash } from "../schemas/canonical.js";
import { assertValidDocument } from "../schemas/registry.js";
import type { SignedResultEnvelope } from "../schemas/trusted.js";
import type { TrustedResultEnvelopeIssuer, TrustedResultEnvelopeVerifier } from "./service.js";

export interface Ed25519ResultEnvelopeIssuerOptions {
  readonly privateKey: KeyLike;
  readonly keyId: string;
  readonly now?: () => Date;
}

export interface TrustedResultEnvelopeKeyring {
  getVerificationKey(keyId: string): Promise<KeyLike | undefined>;
}

const SAFE_KEY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export class ResultEnvelopeIssuerError extends Error {
  override readonly name = "ResultEnvelopeIssuerError";
}

function parseExperimentNumber(experimentId: string): number {
  const prefix = experimentId.split("-", 1)[0] ?? "";
  const value = Number.parseInt(prefix, 10);
  if (!/^\d+$/u.test(prefix) || !Number.isSafeInteger(value) || value < 0) {
    throw new ResultEnvelopeIssuerError("Experiment identity is not release-safe.");
  }
  return value;
}

export class Ed25519ResultEnvelopeIssuer implements TrustedResultEnvelopeIssuer {
  readonly #privateKey: KeyLike;
  readonly #keyId: string;
  readonly #now: () => Date;

  constructor(options: Ed25519ResultEnvelopeIssuerOptions) {
    if (!SAFE_KEY_ID.test(options.keyId)) {
      throw new ResultEnvelopeIssuerError("Envelope signing key ID is malformed.");
    }
    this.#privateKey = options.privateKey;
    this.#keyId = options.keyId;
    this.#now = options.now ?? (() => new Date());
  }

  async issue(
    input: Parameters<TrustedResultEnvelopeIssuer["issue"]>[0],
  ): Promise<SignedResultEnvelope> {
    const {
      request,
      requestHash,
      dispositionAttestationHash,
      aggregate,
      destructionReceipt,
      retentionPolicyHash,
    } = input;
    assertIssuerInput(
      request,
      requestHash,
      dispositionAttestationHash,
      aggregate.requestHash,
      aggregate.protocolHash,
      aggregate.payload.kind,
      aggregate.rawManifestId,
      destructionReceipt.manifestId,
      destructionReceipt.verifierAttestationHash,
      retentionPolicyHash,
    );
    const signedAt = this.#now().toISOString();
    if (
      Date.parse(signedAt) < Date.parse(aggregate.derivedAt) ||
      Date.parse(signedAt) < Date.parse(destructionReceipt.destroyedAt)
    ) {
      throw new ResultEnvelopeIssuerError(
        "Envelope cannot be signed before derivation and raw destruction.",
      );
    }

    const unsigned = {
      schemaVersion: "1.0.0" as const,
      createdAt: signedAt,
      provenanceRefs: [
        {
          artifactName: "evaluation-request",
          contentHash: requestHash,
        },
        {
          artifactName: "raw-destruction",
          contentHash: destructionReceipt.verifierAttestationHash,
        },
      ],
      envelopeId: `release-${requestHash.slice(0, 24)}`,
      experimentNumber: parseExperimentNumber(request.experimentId),
      mode: request.runMode,
      protocolHash: request.protocolHash,
      oneUseRequest: {
        requestId: request.requestId,
        requestHash,
        dispositionAttestationHash,
        reuseProhibited: true as const,
      },
      payload: aggregate.payload,
      derivation: {
        normalizedOutcomeSetHash: aggregate.normalizedOutcomeSetHash,
        cacheAttestationHash: aggregate.cacheAttestationHash,
        behavioralAggregateHash: aggregate.behavioralAggregateHash,
        rawArtifacts: {
          exported: false as const,
          retentionDisposition: "destroyed" as const,
          retentionPolicyHash,
        },
        derivedAt: aggregate.derivedAt,
      },
      releaseChecks: {
        schemaPassed: true as const,
        ...aggregate.releaseChecks,
      },
    };
    const signature = createEd25519Signature(unsigned, this.#privateKey, this.#keyId, signedAt);
    const envelope = withContentHash({ ...unsigned, signature });
    assertValidDocument("signedResultEnvelope", envelope);
    return envelope;
  }
}

export class Ed25519ResultEnvelopeVerifier implements TrustedResultEnvelopeVerifier {
  readonly #keyring: TrustedResultEnvelopeKeyring;

  constructor(keyring: TrustedResultEnvelopeKeyring) {
    this.#keyring = keyring;
  }

  async verify(envelope: SignedResultEnvelope): Promise<boolean> {
    try {
      assertValidDocument("signedResultEnvelope", envelope);
      const key = await this.#keyring.getVerificationKey(envelope.signature.keyId);
      return (
        key !== undefined &&
        verifyEd25519Signature(envelope as unknown as Readonly<Record<string, unknown>>, key)
      );
    } catch {
      return false;
    }
  }
}

function assertIssuerInput(
  request: TrustedEvaluationRequest,
  requestHash: string,
  dispositionAttestationHash: string,
  aggregateRequestHash: string,
  aggregateProtocolHash: string,
  aggregatePayloadKind: SignedResultEnvelope["payload"]["kind"],
  aggregateRawManifestId: string,
  destructionManifestId: string,
  destructionAttestationHash: string,
  retentionPolicyHash: string,
): void {
  if (
    !SHA256.test(requestHash) ||
    !SHA256.test(dispositionAttestationHash) ||
    !SHA256.test(destructionAttestationHash) ||
    !SHA256.test(retentionPolicyHash) ||
    requestHash !== hashEvaluationRequest(request) ||
    aggregateRequestHash !== requestHash ||
    aggregateProtocolHash !== request.protocolHash ||
    aggregatePayloadKind !== request.stage ||
    aggregateRawManifestId !== destructionManifestId
  ) {
    throw new ResultEnvelopeIssuerError(
      "Envelope inputs do not correlate to one immutable evaluation.",
    );
  }
}
