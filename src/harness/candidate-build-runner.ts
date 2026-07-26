import type { KeyLike } from "node:crypto";
import { requireCompatibleProvider } from "../cloud/probe.js";
import type {
  CloudSandboxProvider,
  RemoteExecutionReceipt,
  SandboxCreateRequest,
  SandboxLease,
  TrustedCloudArtifactRef,
} from "../cloud/types.js";
import { verifyEd25519Signature } from "../evidence/signatures.js";
import { canonicalHash } from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import type { CandidateBuildSpec } from "./candidate.js";

export interface TrustedBuildToolchainReceipt {
  readonly sensitivity: "trusted-candidate-build-toolchain";
  readonly sandboxId: string;
  readonly buildImageDigest: string;
  readonly architecture: "x86_64";
  readonly nodeVersion: string;
  readonly npmVersion: string;
  readonly bunVersion: string;
  readonly gnuTarVersion: string;
  readonly offlineCacheManifestSha256: string;
  readonly extractorSha256: string;
  readonly packagerSha256: string;
  readonly checkedAt: string;
  readonly passed: true;
}

export interface TrustedBuildToolchainVerifier {
  verify(
    provider: CloudSandboxProvider,
    lease: SandboxLease,
    spec: CandidateBuildSpec,
  ): Promise<TrustedBuildToolchainReceipt>;
}

export interface TrustedCandidateRuntimeBuildReceipt {
  readonly sensitivity: "trusted-candidate-runtime-build";
  readonly schemaVersion: 1;
  readonly buildId: string;
  readonly experimentId: string;
  readonly sandboxId: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly lockSha256: string;
  readonly buildPolicyHash: string;
  readonly architecture: "x86_64";
  readonly validationLevel: "focused" | "release";
  readonly sourceSha256: string;
  readonly extractorSha256: string;
  readonly packagerSha256: string;
  readonly toolchainAttestationHash: string;
  readonly commandReceiptHashes: readonly string[];
  readonly runtimeManifestSha256: string;
  readonly runtimeArtifact: TrustedCloudArtifactRef;
  readonly builtAt: string;
  readonly passed: true;
  readonly signature: Signature;
}

export interface TrustedCandidateRuntimeAttestor {
  attest(input: {
    readonly sensitivity: "trusted-candidate-build-attestation-request";
    readonly buildId: string;
    readonly lease: SandboxLease;
    readonly spec: CandidateBuildSpec;
    readonly toolchain: TrustedBuildToolchainReceipt;
    readonly commandReceipts: readonly RemoteExecutionReceipt[];
    readonly runtimeArtifact: TrustedCloudArtifactRef;
  }): Promise<TrustedCandidateRuntimeBuildReceipt>;
}

export interface TrustedCandidateBuildReceiptVerifier {
  readonly trustedKeyId: string;
  readonly publicKey: KeyLike;
}

export interface CandidateCloudBuildRunnerOptions {
  readonly provider: CloudSandboxProvider;
  readonly sandbox: SandboxCreateRequest;
  readonly spec: CandidateBuildSpec;
  readonly toolchainVerifier: TrustedBuildToolchainVerifier;
  readonly runtimeAttestor: TrustedCandidateRuntimeAttestor;
  readonly receiptVerifier: TrustedCandidateBuildReceiptVerifier;
  readonly requireReleaseValidation: boolean;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SEMVERISH = /^v?[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/u;
const MAX_BUILD_LIFETIME_MS = 4 * 60 * 60_000;

export class CandidateCloudBuildError extends Error {
  override readonly name = "CandidateCloudBuildError";
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new CandidateCloudBuildError(`${label} must be a plain object.`);
  }
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new CandidateCloudBuildError(`${label} contains non-canonical fields.`);
  }
}

function assertArtifact(artifact: TrustedCloudArtifactRef, expectedMediaType?: string): void {
  assertExactKeys(artifact, ["uri", "sha256", "mediaType", "byteLength"], "Cloud artifact");
  if (
    !/^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(artifact.uri) ||
    artifact.uri.includes("..") ||
    !SHA256.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength <= 0 ||
    artifact.byteLength > 4 * 1024 * 1024 * 1024 ||
    (expectedMediaType !== undefined && artifact.mediaType !== expectedMediaType)
  ) {
    throw new CandidateCloudBuildError(
      "Cloud build artifact violates the immutable artifact policy.",
    );
  }
}

function assertToolchainReceipt(
  receipt: TrustedBuildToolchainReceipt,
  lease: SandboxLease,
  sandbox: SandboxCreateRequest,
  spec: CandidateBuildSpec,
): void {
  assertExactKeys(
    receipt,
    [
      "sensitivity",
      "sandboxId",
      "buildImageDigest",
      "architecture",
      "nodeVersion",
      "npmVersion",
      "bunVersion",
      "gnuTarVersion",
      "offlineCacheManifestSha256",
      "extractorSha256",
      "packagerSha256",
      "checkedAt",
      "passed",
    ],
    "Build toolchain receipt",
  );
  if (
    receipt.sensitivity !== "trusted-candidate-build-toolchain" ||
    receipt.sandboxId !== lease.sandboxId ||
    receipt.buildImageDigest !== sandbox.imageDigest ||
    receipt.architecture !== spec.architecture ||
    !SEMVERISH.test(receipt.nodeVersion) ||
    !SEMVERISH.test(receipt.npmVersion) ||
    !SEMVERISH.test(receipt.bunVersion) ||
    !/^tar \(GNU tar\) [0-9]+(?:\.[0-9]+){1,3}$/u.test(receipt.gnuTarVersion) ||
    !SHA256.test(receipt.offlineCacheManifestSha256) ||
    receipt.extractorSha256 !== spec.extractorArtifact.sha256 ||
    receipt.packagerSha256 !== spec.packagerArtifact.sha256 ||
    !Number.isFinite(Date.parse(receipt.checkedAt)) ||
    receipt.passed !== true
  ) {
    throw new CandidateCloudBuildError(
      "Cloud build toolchain does not attest the frozen offline build profile.",
    );
  }
}

function executionHash(receipt: RemoteExecutionReceipt): string {
  return canonicalHash({
    provider: receipt.provider,
    sandboxId: receipt.sandboxId,
    executionId: receipt.executionId,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    exitCode: receipt.exitCode,
    timedOut: receipt.timedOut,
    cancelled: receipt.cancelled,
    stdout: receipt.stdout ?? null,
    stderr: receipt.stderr ?? null,
    resourceReport: receipt.resourceReport,
  });
}

function unsignedBuildReceipt(
  receipt: TrustedCandidateRuntimeBuildReceipt,
): Readonly<Record<string, unknown>> {
  return {
    sensitivity: receipt.sensitivity,
    schemaVersion: receipt.schemaVersion,
    buildId: receipt.buildId,
    experimentId: receipt.experimentId,
    sandboxId: receipt.sandboxId,
    candidateCommit: receipt.candidateCommit,
    candidateTree: receipt.candidateTree,
    lockSha256: receipt.lockSha256,
    buildPolicyHash: receipt.buildPolicyHash,
    architecture: receipt.architecture,
    validationLevel: receipt.validationLevel,
    sourceSha256: receipt.sourceSha256,
    extractorSha256: receipt.extractorSha256,
    packagerSha256: receipt.packagerSha256,
    toolchainAttestationHash: receipt.toolchainAttestationHash,
    commandReceiptHashes: receipt.commandReceiptHashes,
    runtimeManifestSha256: receipt.runtimeManifestSha256,
    runtimeArtifact: receipt.runtimeArtifact,
    builtAt: receipt.builtAt,
    passed: receipt.passed,
  };
}

export function candidateRuntimeBuildReceiptHash(
  receipt: TrustedCandidateRuntimeBuildReceipt,
): string {
  return canonicalHash(unsignedBuildReceipt(receipt));
}

export function assertTrustedCandidateRuntimeBuildReceipt(
  receipt: TrustedCandidateRuntimeBuildReceipt,
  input: {
    readonly buildId: string;
    readonly lease: SandboxLease;
    readonly spec: CandidateBuildSpec;
    readonly toolchain: TrustedBuildToolchainReceipt;
    readonly commandReceipts: readonly RemoteExecutionReceipt[];
    readonly runtimeArtifact: TrustedCloudArtifactRef;
    readonly verifier: TrustedCandidateBuildReceiptVerifier;
    readonly requireReleaseValidation: boolean;
  },
): void {
  assertExactKeys(
    receipt,
    [
      "sensitivity",
      "schemaVersion",
      "buildId",
      "experimentId",
      "sandboxId",
      "candidateCommit",
      "candidateTree",
      "lockSha256",
      "buildPolicyHash",
      "architecture",
      "validationLevel",
      "sourceSha256",
      "extractorSha256",
      "packagerSha256",
      "toolchainAttestationHash",
      "commandReceiptHashes",
      "runtimeManifestSha256",
      "runtimeArtifact",
      "builtAt",
      "passed",
      "signature",
    ],
    "Candidate runtime build receipt",
  );
  assertArtifact(receipt.runtimeArtifact, "application/x-tar");
  const expectedCommandHashes = input.commandReceipts.map(executionHash);
  const signatureRecord = {
    ...unsignedBuildReceipt(receipt),
    signature: receipt.signature,
  };
  assertExactKeys(
    receipt.signature,
    ["algorithm", "keyId", "signedAt", "signature"],
    "Candidate runtime build signature",
  );
  if (
    receipt.sensitivity !== "trusted-candidate-runtime-build" ||
    receipt.schemaVersion !== 1 ||
    receipt.buildId !== input.buildId ||
    receipt.experimentId !== input.spec.experimentId ||
    receipt.sandboxId !== input.lease.sandboxId ||
    receipt.candidateCommit !== input.spec.candidateCommit ||
    receipt.candidateTree !== input.spec.candidateTree ||
    receipt.lockSha256 !== input.spec.lockSha256 ||
    receipt.buildPolicyHash !== input.spec.buildPolicyHash ||
    receipt.architecture !== input.spec.architecture ||
    receipt.validationLevel !== input.spec.validationLevel ||
    (input.requireReleaseValidation && receipt.validationLevel !== "release") ||
    receipt.sourceSha256 !== input.spec.sourceArtifact.sha256 ||
    receipt.extractorSha256 !== input.spec.extractorArtifact.sha256 ||
    receipt.packagerSha256 !== input.spec.packagerArtifact.sha256 ||
    receipt.toolchainAttestationHash !== canonicalHash(input.toolchain) ||
    !Array.isArray(receipt.commandReceiptHashes) ||
    receipt.commandReceiptHashes.length !== expectedCommandHashes.length ||
    receipt.commandReceiptHashes.some((hash, index) => hash !== expectedCommandHashes[index]) ||
    !SHA256.test(receipt.runtimeManifestSha256) ||
    canonicalHash(receipt.runtimeArtifact) !== canonicalHash(input.runtimeArtifact) ||
    !Number.isFinite(Date.parse(receipt.builtAt)) ||
    receipt.passed !== true ||
    receipt.signature.algorithm !== "ed25519" ||
    receipt.signature.keyId !== input.verifier.trustedKeyId ||
    !Number.isFinite(Date.parse(receipt.signature.signedAt)) ||
    Date.parse(receipt.signature.signedAt) < Date.parse(receipt.builtAt) ||
    !verifyEd25519Signature(signatureRecord, input.verifier.publicKey)
  ) {
    throw new CandidateCloudBuildError(
      "Candidate runtime receipt does not prove this exact cloud build.",
    );
  }
}

/**
 * Executes only through the injected cloud provider. This class never invokes
 * a local subprocess and never has a local-build fallback.
 */
export class CandidateCloudBuildRunner {
  readonly #options: CandidateCloudBuildRunnerOptions;

  constructor(options: CandidateCloudBuildRunnerOptions) {
    if (
      !SAFE_ID.test(options.sandbox.requestId) ||
      options.sandbox.resources.architecture !== "x86_64" ||
      options.sandbox.network.defaultAction !== "deny" ||
      options.sandbox.network.allowDomains.length !== 0 ||
      options.sandbox.lifetimeMs <= 0 ||
      options.sandbox.lifetimeMs > MAX_BUILD_LIFETIME_MS ||
      (options.requireReleaseValidation && options.spec.validationLevel !== "release")
    ) {
      throw new CandidateCloudBuildError(
        "Candidate builds require a bounded x86_64 deny-all cloud sandbox.",
      );
    }
    if (
      new Set([
        options.spec.sourceRemotePath,
        options.spec.extractorRemotePath,
        options.spec.packagerRemotePath,
        options.spec.outputRemotePath,
      ]).size !== 4
    ) {
      throw new CandidateCloudBuildError(
        "Candidate build input and output paths must be distinct.",
      );
    }
    this.#options = options;
  }

  async run(): Promise<TrustedCandidateRuntimeBuildReceipt> {
    const buildId = `build-${canonicalHash({
      requestId: this.#options.sandbox.requestId,
      experimentId: this.#options.spec.experimentId,
      commit: this.#options.spec.candidateCommit,
      tree: this.#options.spec.candidateTree,
      policy: this.#options.spec.buildPolicyHash,
    }).slice(0, 48)}`;
    await requireCompatibleProvider(this.#options.provider, {
      requestId: `probe-${canonicalHash(buildId).slice(0, 32)}`,
      imageDigest: this.#options.sandbox.imageDigest,
      regionClass: this.#options.sandbox.regionClass,
      resources: this.#options.sandbox.resources,
      requireDockerInDocker: false,
      requireGpu: false,
    });

    let lease: SandboxLease | undefined;
    let result: TrustedCandidateRuntimeBuildReceipt | undefined;
    let failure: { readonly error: unknown } | undefined;
    let teardownFailure: { readonly error: unknown } | undefined;
    try {
      lease = await this.#options.provider.create({
        ...this.#options.sandbox,
        requestId: buildId,
      });
      const toolchain = await this.#options.toolchainVerifier.verify(
        this.#options.provider,
        lease,
        this.#options.spec,
      );
      assertToolchainReceipt(toolchain, lease, this.#options.sandbox, this.#options.spec);

      await this.#options.provider.upload(
        lease,
        this.#options.spec.sourceArtifact,
        this.#options.spec.sourceRemotePath,
      );
      await this.#options.provider.upload(
        lease,
        this.#options.spec.extractorArtifact,
        this.#options.spec.extractorRemotePath,
      );
      await this.#options.provider.upload(
        lease,
        this.#options.spec.packagerArtifact,
        this.#options.spec.packagerRemotePath,
      );

      const commandReceipts: RemoteExecutionReceipt[] = [];
      for (const command of this.#options.spec.commands) {
        const receipt = await this.#options.provider.execute(lease, command);
        if (receipt.exitCode !== 0 || receipt.timedOut || receipt.cancelled) {
          throw new CandidateCloudBuildError("A candidate build gate failed in the cloud.");
        }
        commandReceipts.push(receipt);
      }

      const runtimeArtifact = await this.#options.provider.download(
        lease,
        this.#options.spec.outputRemotePath,
        {
          mediaType: "application/x-tar",
          maximumByteLength: 4 * 1024 * 1024 * 1024,
        },
      );
      assertArtifact(runtimeArtifact, "application/x-tar");
      const receipt = await this.#options.runtimeAttestor.attest({
        sensitivity: "trusted-candidate-build-attestation-request",
        buildId,
        lease,
        spec: this.#options.spec,
        toolchain,
        commandReceipts,
        runtimeArtifact,
      });
      assertTrustedCandidateRuntimeBuildReceipt(receipt, {
        buildId,
        lease,
        spec: this.#options.spec,
        toolchain,
        commandReceipts,
        runtimeArtifact,
        verifier: this.#options.receiptVerifier,
        requireReleaseValidation: this.#options.requireReleaseValidation,
      });
      result = receipt;
    } catch (error) {
      failure = { error };
    } finally {
      if (lease !== undefined) {
        try {
          await this.#options.provider.destroy(lease);
        } catch (error) {
          teardownFailure = { error };
        }
      }
    }
    if (teardownFailure !== undefined) {
      throw new CandidateCloudBuildError(
        "Candidate sandbox teardown failed; the runtime is invalid.",
        {
          cause:
            failure === undefined
              ? teardownFailure.error
              : new AggregateError(
                  [failure.error, teardownFailure.error],
                  "Candidate build and sandbox teardown both failed.",
                ),
        },
      );
    }
    if (failure !== undefined || result === undefined) {
      throw new CandidateCloudBuildError(
        "Candidate cloud build failed closed without a usable runtime.",
        { cause: failure?.error },
      );
    }
    return result;
  }
}
