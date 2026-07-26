import { canonicalJson } from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import {
  parseTrustedGitPublicationWorkerResult,
  type TrustedGitPublicationAttestor,
  type TrustedGitPublicationReceipt,
} from "./git-publication.js";
import {
  parseTrustedGitSourceWorkerManifest,
  type TrustedGitSourceSnapshotAttestor,
  type TrustedGitSourceSnapshotReceipt,
} from "./git-source.js";
import {
  assertSuccessfulCloudExecution,
  assertTrustedGitArtifact,
  cloudExecutionReceiptHash,
} from "./trusted-git.js";

const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86,128}$/u;
const MAXIMUM_RESULT_BYTES = 4 * 1024 * 1024;

type SourceAttestationInput = Parameters<TrustedGitSourceSnapshotAttestor["attest"]>[0];
type PublicationAttestationInput = Parameters<TrustedGitPublicationAttestor["attest"]>[0];

export interface TrustedGitOperationResultReader {
  /**
   * Production uses a verifying trusted-artifact reader. It must authenticate
   * the exact artifact digest and byte length, enforce the limit while
   * streaming, reject trailing bytes, and return canonical UTF-8 unchanged.
   */
  readUtf8(
    artifact:
      | SourceAttestationInput["manifestArtifact"]
      | PublicationAttestationInput["resultArtifact"],
    maximumBytes: number,
  ): Promise<string>;
}

export interface TrustedGitOperationReceiptSigningAuthority {
  readonly boundary: "trusted-cloud-key-material";
  readonly keyId: string;
  sign(
    unsignedReceipt:
      | Omit<TrustedGitSourceSnapshotReceipt, "signature">
      | Omit<TrustedGitPublicationReceipt, "signature">,
  ): Promise<Signature>;
}

export interface ArtifactReadingTrustedGitOperationAttestorsOptions {
  readonly reader: TrustedGitOperationResultReader;
  readonly signer: TrustedGitOperationReceiptSigningAuthority;
  readonly now?: () => Date;
}

export class TrustedGitOperationAttestationError extends Error {
  override readonly name = "TrustedGitOperationAttestationError";

  constructor() {
    super("Trusted Git operation attestation failed closed.");
  }
}

function canonicalTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TrustedGitOperationAttestationError();
  }
  return parsed;
}

function assertSigner(signer: TrustedGitOperationReceiptSigningAuthority): void {
  if (
    signer.boundary !== "trusted-cloud-key-material" ||
    !SAFE_KEY_ID.test(signer.keyId) ||
    typeof signer.sign !== "function"
  ) {
    throw new TrustedGitOperationAttestationError();
  }
}

function assertSignature(
  signature: Signature,
  signer: TrustedGitOperationReceiptSigningAuthority,
  operationAt: string,
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
    canonicalTimestamp(signature.signedAt) < canonicalTimestamp(operationAt) ||
    canonicalTimestamp(signature.signedAt) > canonicalTimestamp(leaseExpiresAt) ||
    !BASE64URL_SIGNATURE.test(signature.signature)
  ) {
    throw new TrustedGitOperationAttestationError();
  }
}

function exactCanonicalClone<T extends object>(
  value: T,
): { readonly serialized: string; readonly clone: T } {
  const serialized = canonicalJson(value);
  return {
    serialized,
    clone: JSON.parse(serialized) as T,
  };
}

/**
 * Reads and validates the source worker's canonical manifest before asking a
 * cloud key boundary to sign the release-safe snapshot receipt.
 */
export class ArtifactReadingTrustedGitSourceSnapshotAttestor
  implements TrustedGitSourceSnapshotAttestor
{
  readonly #reader: TrustedGitOperationResultReader;
  readonly #signer: TrustedGitOperationReceiptSigningAuthority;
  readonly #now: () => Date;

  constructor(options: ArtifactReadingTrustedGitOperationAttestorsOptions) {
    assertSigner(options.signer);
    this.#reader = options.reader;
    this.#signer = options.signer;
    this.#now = options.now ?? (() => new Date());
  }

  public async attest(input: SourceAttestationInput): Promise<TrustedGitSourceSnapshotReceipt> {
    try {
      if (input.sensitivity !== "trusted-git-source-attestation-request") {
        throw new TrustedGitOperationAttestationError();
      }
      assertSuccessfulCloudExecution(input.execution, "Git source snapshot");
      assertTrustedGitArtifact(
        input.sourceArtifact,
        "application/x-tar",
        "Git source archive",
        512 * 1024 * 1024,
      );
      assertTrustedGitArtifact(
        input.sourceBundleArtifact,
        "application/vnd.git.bundle",
        "Git source bundle",
        2 * 1024 * 1024 * 1024,
      );
      assertTrustedGitArtifact(
        input.manifestArtifact,
        "application/json",
        "Git source manifest",
        MAXIMUM_RESULT_BYTES,
      );
      if (
        input.execution.provider !== input.lease.provider ||
        input.execution.sandboxId !== input.lease.sandboxId
      ) {
        throw new TrustedGitOperationAttestationError();
      }
      const raw = await this.#reader.readUtf8(input.manifestArtifact, MAXIMUM_RESULT_BYTES);
      const manifest = parseTrustedGitSourceWorkerManifest(raw, {
        spec: input.spec,
        sourceArtifact: input.sourceArtifact,
        sourceBundleArtifact: input.sourceBundleArtifact,
      });
      const createdAt = this.#now().toISOString();
      if (
        canonicalTimestamp(createdAt) < canonicalTimestamp(input.execution.finishedAt) ||
        canonicalTimestamp(createdAt) > canonicalTimestamp(input.lease.expiresAt)
      ) {
        throw new TrustedGitOperationAttestationError();
      }
      const body: Omit<TrustedGitSourceSnapshotReceipt, "signature"> = {
        sensitivity: "trusted-git-source-snapshot",
        schemaVersion: 2,
        snapshotId: input.spec.snapshotId,
        registrationId: input.spec.registrationId,
        originRepositoryHash: manifest.originRepositoryHash,
        upstreamRepositoryHash: manifest.upstreamRepositoryHash,
        upstreamHeadCommit: manifest.upstreamHeadCommit,
        upstreamBaseCommit: manifest.upstreamBaseCommit,
        baselineCommit: manifest.baselineCommit,
        provider: input.lease.provider,
        sandboxId: input.lease.sandboxId,
        imageReference: input.lease.imageReference,
        imageDigest: input.lease.imageDigest,
        networkPolicyHash: input.lease.networkPolicyHash,
        remoteRef: manifest.remoteRef,
        commitSha: manifest.commitSha,
        treeSha: manifest.treeSha,
        lockSha256: manifest.lockSha256,
        archiveMethod: "git-archive-format-tar",
        compression: "none",
        bundleMethod: "git-bundle-v2",
        bundleRef: input.spec.bundleRef,
        workerSha256: input.spec.workerArtifact.sha256,
        executionReceiptHash: cloudExecutionReceiptHash(input.execution),
        manifestArtifactSha256: input.manifestArtifact.sha256,
        sourceArtifact: structuredClone(input.sourceArtifact),
        sourceBundleArtifact: structuredClone(input.sourceBundleArtifact),
        createdAt,
        passed: true,
      };
      const canonical = exactCanonicalClone(body);
      const signature = await this.#signer.sign(canonical.clone);
      if (canonicalJson(body) !== canonical.serialized) {
        throw new TrustedGitOperationAttestationError();
      }
      assertSignature(signature, this.#signer, createdAt, input.lease.expiresAt);
      return {
        ...body,
        signature: structuredClone(signature),
      };
    } catch (error) {
      if (error instanceof TrustedGitOperationAttestationError) {
        throw error;
      }
      throw new TrustedGitOperationAttestationError();
    }
  }
}

/**
 * Reads and validates the publication worker's canonical result before asking
 * a cloud key boundary to sign the release-safe non-force publication receipt.
 */
export class ArtifactReadingTrustedGitPublicationAttestor implements TrustedGitPublicationAttestor {
  readonly #reader: TrustedGitOperationResultReader;
  readonly #signer: TrustedGitOperationReceiptSigningAuthority;
  readonly #now: () => Date;

  constructor(options: ArtifactReadingTrustedGitOperationAttestorsOptions) {
    assertSigner(options.signer);
    this.#reader = options.reader;
    this.#signer = options.signer;
    this.#now = options.now ?? (() => new Date());
  }

  public async attest(input: PublicationAttestationInput): Promise<TrustedGitPublicationReceipt> {
    try {
      if (input.sensitivity !== "trusted-git-publication-attestation-request") {
        throw new TrustedGitOperationAttestationError();
      }
      assertSuccessfulCloudExecution(input.execution, "Git publication");
      assertTrustedGitArtifact(
        input.resultArtifact,
        "application/json",
        "Git publication result",
        MAXIMUM_RESULT_BYTES,
      );
      if (
        input.execution.provider !== input.lease.provider ||
        input.execution.sandboxId !== input.lease.sandboxId
      ) {
        throw new TrustedGitOperationAttestationError();
      }
      const raw = await this.#reader.readUtf8(input.resultArtifact, MAXIMUM_RESULT_BYTES);
      const result = parseTrustedGitPublicationWorkerResult(raw, {
        authorization: input.authorization,
        spec: input.spec,
      });
      const publishedAt = this.#now().toISOString();
      if (
        canonicalTimestamp(publishedAt) < canonicalTimestamp(input.execution.finishedAt) ||
        canonicalTimestamp(publishedAt) >= canonicalTimestamp(input.authorization.expiresAt) ||
        canonicalTimestamp(publishedAt) > canonicalTimestamp(input.lease.expiresAt)
      ) {
        throw new TrustedGitOperationAttestationError();
      }
      const body: Omit<TrustedGitPublicationReceipt, "signature"> = {
        sensitivity: "trusted-git-publication",
        schemaVersion: 1,
        publicationId: input.spec.publicationId,
        authorizationHash: input.spec.authorizationHash,
        registrationId: input.authorization.registrationId,
        originRepositoryHash: result.originRepositoryHash,
        upstreamRepositoryHash: result.upstreamRepositoryHash,
        upstreamHeadCommit: result.upstreamHeadCommit,
        upstreamBaseCommit: result.upstreamBaseCommit,
        provider: input.lease.provider,
        sandboxId: input.lease.sandboxId,
        imageReference: input.lease.imageReference,
        imageDigest: input.lease.imageDigest,
        networkPolicyHash: input.lease.networkPolicyHash,
        experimentId: result.experimentId,
        baselineCommit: result.baselineCommit,
        baseRef: result.baseRef,
        baseCommit: result.baseCommit,
        candidateCommit: result.candidateCommit,
        candidateTree: result.candidateTree,
        lockSha256: result.lockSha256,
        bundleRef: result.bundleRef,
        branchRef: result.branchRef,
        tagRef: result.tagRef,
        branchCommit: result.branchCommit,
        tagObjectId: result.tagObjectId,
        tagPeeledCommit: result.tagPeeledCommit,
        publicationMode: "atomic-non-force",
        disposition: result.disposition,
        candidateBundleSha256: input.authorization.candidateBundle.sha256,
        workerSha256: input.authorization.workerSha256,
        executionReceiptHash: cloudExecutionReceiptHash(input.execution),
        resultArtifactSha256: input.resultArtifact.sha256,
        publishedAt,
        passed: true,
      };
      const canonical = exactCanonicalClone(body);
      const signature = await this.#signer.sign(canonical.clone);
      if (canonicalJson(body) !== canonical.serialized) {
        throw new TrustedGitOperationAttestationError();
      }
      assertSignature(signature, this.#signer, publishedAt, input.lease.expiresAt);
      return {
        ...body,
        signature: structuredClone(signature),
      };
    } catch (error) {
      if (error instanceof TrustedGitOperationAttestationError) {
        throw error;
      }
      throw new TrustedGitOperationAttestationError();
    }
  }
}
