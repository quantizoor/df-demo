import { canonicalJson } from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import type {
  TrustedGitRegistrationAttestor,
  TrustedGitRegistrationReceipt,
} from "./git-registration.js";
import { parseTrustedGitRegistrationWorkerResult } from "./git-registration.js";
import {
  assertSuccessfulCloudExecution,
  assertTrustedGitArtifact,
  cloudExecutionReceiptHash,
} from "./trusted-git.js";

const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86,128}$/u;

export interface TrustedGitRegistrationResultReader {
  /**
   * Production uses VerifyingTrustedJsonArtifactReader, which verifies the
   * artifact bridge's digest, length, EOF, and canonical UTF-8 boundary.
   */
  readUtf8(
    artifact: Parameters<TrustedGitRegistrationAttestor["attest"]>[0]["resultArtifact"],
    maximumBytes: number,
  ): Promise<string>;
}

export interface TrustedGitRegistrationReceiptSigningAuthority {
  readonly boundary: "trusted-cloud-key-material";
  readonly keyId: string;
  sign(unsignedReceipt: Omit<TrustedGitRegistrationReceipt, "signature">): Promise<Signature>;
}

export interface ArtifactReadingTrustedGitRegistrationAttestorOptions {
  readonly reader: TrustedGitRegistrationResultReader;
  readonly signer: TrustedGitRegistrationReceiptSigningAuthority;
  readonly now?: () => Date;
}

export class TrustedGitRegistrationAttestationError extends Error {
  override readonly name = "TrustedGitRegistrationAttestationError";

  constructor() {
    super("Trusted Git registration attestation failed closed.");
  }
}

function canonicalTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TrustedGitRegistrationAttestationError();
  }
  return parsed;
}

function assertSignature(
  signature: Signature,
  signer: TrustedGitRegistrationReceiptSigningAuthority,
  attestedAt: string,
  leaseExpiresAt: string,
): void {
  if (
    signature === null ||
    typeof signature !== "object" ||
    Array.isArray(signature) ||
    Object.getPrototypeOf(signature) !== Object.prototype ||
    Object.keys(signature).length !== 4 ||
    signature.algorithm !== "ed25519" ||
    signature.keyId !== signer.keyId ||
    canonicalTimestamp(signature.signedAt) < canonicalTimestamp(attestedAt) ||
    canonicalTimestamp(signature.signedAt) > canonicalTimestamp(leaseExpiresAt) ||
    !BASE64URL_SIGNATURE.test(signature.signature)
  ) {
    throw new TrustedGitRegistrationAttestationError();
  }
}

/**
 * Production attestation boundary for source registration.
 *
 * It never trusts a provider file reference by itself: the exact JSON bytes
 * are read through a verifying artifact reader and parsed against the signed
 * authorization before any release-safe receipt is sent to the cloud key
 * authority.
 */
export class ArtifactReadingTrustedGitRegistrationAttestor
  implements TrustedGitRegistrationAttestor
{
  readonly #reader: TrustedGitRegistrationResultReader;
  readonly #signer: TrustedGitRegistrationReceiptSigningAuthority;
  readonly #now: () => Date;

  constructor(options: ArtifactReadingTrustedGitRegistrationAttestorOptions) {
    if (
      options.signer.boundary !== "trusted-cloud-key-material" ||
      !SAFE_KEY_ID.test(options.signer.keyId)
    ) {
      throw new TrustedGitRegistrationAttestationError();
    }
    this.#reader = options.reader;
    this.#signer = options.signer;
    this.#now = options.now ?? (() => new Date());
  }

  async attest(
    input: Parameters<TrustedGitRegistrationAttestor["attest"]>[0],
  ): Promise<TrustedGitRegistrationReceipt> {
    try {
      if (input.sensitivity !== "trusted-git-registration-attestation-request") {
        throw new TrustedGitRegistrationAttestationError();
      }
      assertSuccessfulCloudExecution(input.execution, "Git registration worker");
      assertTrustedGitArtifact(
        input.resultArtifact,
        "application/json",
        "Git registration worker result",
        4 * 1024 * 1024,
      );
      if (
        input.execution.provider !== input.lease.provider ||
        input.execution.sandboxId !== input.lease.sandboxId
      ) {
        throw new TrustedGitRegistrationAttestationError();
      }
      const raw = await this.#reader.readUtf8(input.resultArtifact, 4 * 1024 * 1024);
      const verified = parseTrustedGitRegistrationWorkerResult(raw, {
        authorization: input.authorization,
        spec: input.spec,
      });
      const attestedAt = this.#now().toISOString();
      if (
        canonicalTimestamp(attestedAt) < canonicalTimestamp(input.execution.finishedAt) ||
        canonicalTimestamp(attestedAt) > canonicalTimestamp(input.lease.expiresAt)
      ) {
        throw new TrustedGitRegistrationAttestationError();
      }
      const body: Omit<TrustedGitRegistrationReceipt, "signature"> = {
        sensitivity: "trusted-git-registration",
        schemaVersion: 1,
        registrationRequestId: input.spec.registrationRequestId,
        authorizationHash: input.spec.authorizationHash,
        registrationId: verified.registrationId,
        originRepositoryHash: verified.originRepositoryHash,
        upstreamRepositoryHash: verified.upstreamRepositoryHash,
        remoteRef: verified.remoteRef,
        commitSha: verified.commitSha,
        treeSha: verified.treeSha,
        lockSha256: verified.lockSha256,
        packageName: verified.packageName,
        packageVersion: verified.packageVersion,
        harnessRegistrationSchemaVersion: verified.harnessRegistrationSchemaVersion,
        adapterId: verified.adapterId,
        adapterExecutionMode: verified.adapterExecutionMode,
        sessionsDisabled: true,
        uncontrolledExtensionsDisabled: true,
        uncontrolledContextFilesDisabled: true,
        packageJsonSha256: verified.packageJsonSha256,
        upstreamHeadCommit: verified.upstreamHeadCommit,
        upstreamBaseCommit: verified.upstreamBaseCommit,
        originPrivate: true,
        originFetchable: true,
        originWritable: true,
        privacyEvidence: verified.privacyEvidence,
        fetchEvidence: verified.fetchEvidence,
        writeEvidence: verified.writeEvidence,
        lineageEvidence: verified.lineageEvidence,
        providerRepositoryAttestationHash: verified.providerRepositoryAttestationHash,
        lineageAttestationHash: verified.lineageAttestationHash,
        providerVerifiedAt: verified.providerVerifiedAt,
        provider: input.lease.provider,
        sandboxId: input.lease.sandboxId,
        imageReference: input.lease.imageReference,
        imageDigest: input.lease.imageDigest,
        networkPolicyHash: input.lease.networkPolicyHash,
        workerSha256: input.spec.workerArtifact.sha256,
        executionReceiptHash: cloudExecutionReceiptHash(input.execution),
        resultArtifactSha256: input.resultArtifact.sha256,
        attestedAt,
        passed: true,
      };
      const bodyBeforeSigning = canonicalJson(body);
      const signature = await this.#signer.sign(
        JSON.parse(bodyBeforeSigning) as Omit<TrustedGitRegistrationReceipt, "signature">,
      );
      if (canonicalJson(body) !== bodyBeforeSigning) {
        throw new TrustedGitRegistrationAttestationError();
      }
      assertSignature(signature, this.#signer, attestedAt, input.lease.expiresAt);
      return { ...body, signature };
    } catch {
      throw new TrustedGitRegistrationAttestationError();
    }
  }
}
