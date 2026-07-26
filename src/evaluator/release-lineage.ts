import { canonicalHash } from "../schemas/canonical.js";
import { assertValidDocument } from "../schemas/registry.js";
import type { SignedResultEnvelope } from "../schemas/trusted.js";

export type ResultEnvelopeBehavioralSourceMaterial = Readonly<{
  envelopeId: string;
  experimentNumber: number;
  mode: SignedResultEnvelope["mode"];
  protocolHash: string;
  oneUseRequest: SignedResultEnvelope["oneUseRequest"];
  normalizedOutcomeSetHash: string;
  cacheAttestationHash: string;
  rawArtifacts: SignedResultEnvelope["derivation"]["rawArtifacts"];
  derivedAt: string;
}>;

/**
 * Hashes the exact unsigned result fields available after confirmed raw
 * destruction. This lets the evaluator create a behavioral release before it
 * signs the final result, without predicting either document's content hash.
 */
export function hashResultEnvelopeBehavioralSourceMaterial(
  material: ResultEnvelopeBehavioralSourceMaterial,
): string {
  return canonicalHash({
    schemaVersion: 1,
    domain: "dark-factory.result-envelope-behavioral-source.v1",
    resultIdentity: {
      envelopeId: material.envelopeId,
      experimentNumber: material.experimentNumber,
      mode: material.mode,
      protocolHash: material.protocolHash,
      oneUseRequest: material.oneUseRequest,
    },
    resultDerivation: {
      normalizedOutcomeSetHash: material.normalizedOutcomeSetHash,
      cacheAttestationHash: material.cacheAttestationHash,
      rawArtifacts: material.rawArtifacts,
      derivedAt: material.derivedAt,
    },
  });
}

/**
 * Breaks the otherwise impossible content-hash cycle between a result and its
 * optional behavioral release.
 *
 * The result commits `behavioralAggregateHash = release.contentHash`. The
 * release and behavioral evidence commit this source hash, which deliberately
 * includes only immutable result identity and derivation fields. In
 * particular, it excludes the result's `contentHash`, `signature`, and
 * `derivation.behavioralAggregateHash`.
 */
export function resultEnvelopeBehavioralSourceCommitmentHash(result: SignedResultEnvelope): string {
  assertValidDocument("signedResultEnvelope", result);
  return hashResultEnvelopeBehavioralSourceMaterial({
    envelopeId: result.envelopeId,
    experimentNumber: result.experimentNumber,
    mode: result.mode,
    protocolHash: result.protocolHash,
    oneUseRequest: result.oneUseRequest,
    normalizedOutcomeSetHash: result.derivation.normalizedOutcomeSetHash,
    cacheAttestationHash: result.derivation.cacheAttestationHash,
    rawArtifacts: result.derivation.rawArtifacts,
    derivedAt: result.derivation.derivedAt,
  });
}
