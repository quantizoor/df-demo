import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashNetworkPolicy } from "../../src/cloud/provider.js";
import type {
  CloudSandboxProvider,
  ProviderConfiguration,
  ProviderProbeReport,
  ProviderProbeRequest,
  RemoteCommandSpec,
  RemoteExecutionReceipt,
  SandboxCreateRequest,
  SandboxLease,
  TrustedCloudArtifactRef,
} from "../../src/cloud/types.js";
import { createEd25519Signature } from "../../src/evidence/signatures.js";
import {
  CandidateCloudBuildRunner,
  type TrustedBuildToolchainReceipt,
  type TrustedCandidateRuntimeAttestor,
  type TrustedCandidateRuntimeBuildReceipt,
} from "../../src/harness/candidate-build-runner.js";
import {
  createCandidateBuildSpec,
  type CandidateBuildSpec,
} from "../../src/harness/candidate.js";
import { canonicalHash } from "../../src/schemas/canonical.js";

const keys = generateKeyPairSync("ed25519");
const now = "2026-07-01T00:00:00.000Z";

function artifact(
  name: string,
  sha: string,
  mediaType: string,
): TrustedCloudArtifactRef {
  return {
    uri: `trusted://build/${name}`,
    sha256: sha.repeat(64),
    mediaType,
    byteLength: 4_096,
  };
}

function buildSpec(release = true): CandidateBuildSpec {
  return createCandidateBuildSpec({
    experimentId: "001-improve-recovery",
    sourceArtifact: artifact("source", "1", "application/x-tar"),
    extractorArtifact: artifact("extractor", "2", "text/javascript"),
    packagerArtifact: artifact("packager", "3", "text/javascript"),
    cloudWorkingDirectory: "/workspace/pi",
    remoteInputRoot: "/trusted/inputs/",
    remoteOutputRoot: "/trusted/outputs/",
    candidateCommit: "4".repeat(40),
    candidateTree: "5".repeat(40),
    lockSha256: "6".repeat(64),
    buildPolicyHash: "7".repeat(64),
    architecture: "x86_64",
    focusedTestFiles: ["packages/coding-agent/test/recovery.test.ts"],
    runFullTestSuite: release,
  });
}

function sandbox(): SandboxCreateRequest {
  return {
    requestId: "candidate-build-001",
    imageReference: `ghcr.io/parallaxai/dark-factory-build@sha256:${"8".repeat(64)}`,
    imageDigest: `sha256:${"8".repeat(64)}`,
    regionClass: "trusted-eu",
    resources: {
      architecture: "x86_64",
      cpuCores: 8,
      memoryMiB: 16_384,
      diskMiB: 32_768,
    },
    network: { defaultAction: "deny", allowDomains: [] },
    lifetimeMs: 2 * 60 * 60_000,
    secretReferences: [],
  };
}

class FakeBuildProvider implements CloudSandboxProvider {
  readonly name = "daytona" as const;
  readonly configuration: ProviderConfiguration = {
    provider: "daytona",
    endpoint: "https://cloud.example.test",
    credentialEnvironmentNames: ["DAYTONA_API_KEY"],
    configFingerprint: "9".repeat(64),
  };
  readonly calls: string[] = [];
  readonly uploads: string[] = [];
  readonly executions: RemoteExecutionReceipt[] = [];
  failExecution = 0;

  probe(request: ProviderProbeRequest): Promise<ProviderProbeReport> {
    this.calls.push("probe");
    return Promise.resolve({
      provider: this.name,
      requestId: request.requestId,
      checkedAt: now,
      configFingerprint: this.configuration.configFingerprint,
      capabilities: {
        lifecycle: true,
        cancellation: true,
        fileTransfer: true,
        hardTimeout: true,
        resourceReporting: true,
        networkDenyAll: true,
        kernelIsolation: true,
        dockerInDocker: false,
        gpu: false,
      },
      compatible: true,
      reasons: [],
    });
  }

  create(request: SandboxCreateRequest): Promise<SandboxLease> {
    this.calls.push("create");
    return Promise.resolve({
      provider: this.name,
      sandboxId: "sandbox-build-001",
      createdAt: now,
      expiresAt: "2026-07-01T02:00:00.000Z",
      imageReference: request.imageReference,
      imageDigest: request.imageDigest,
      regionClass: request.regionClass,
      resources: request.resources,
      networkPolicyHash: hashNetworkPolicy(request.network),
      marker: {
        provider: this.name,
        sandboxId: "sandbox-build-001",
        markerEnvironmentName: "DAYTONA_SANDBOX_ID",
      },
    });
  }

  execute(
    lease: SandboxLease,
    _command: RemoteCommandSpec,
  ): Promise<RemoteExecutionReceipt> {
    this.calls.push("execute");
    const ordinal = this.executions.length + 1;
    const receipt: RemoteExecutionReceipt = {
      provider: this.name,
      sandboxId: lease.sandboxId,
      executionId: `build-command-${ordinal}`,
      startedAt: `2026-07-01T00:${String(ordinal).padStart(2, "0")}:00.000Z`,
      finishedAt: `2026-07-01T00:${String(ordinal).padStart(2, "0")}:01.000Z`,
      exitCode: ordinal === this.failExecution ? 1 : 0,
      timedOut: false,
      cancelled: false,
      resourceReport: { peakMemoryMiB: 512, cpuTimeMs: 100 },
    };
    this.executions.push(receipt);
    return Promise.resolve(receipt);
  }

  upload(
    _lease: SandboxLease,
    _artifact: TrustedCloudArtifactRef,
    remotePath: string,
  ): Promise<void> {
    this.calls.push("upload");
    this.uploads.push(remotePath);
    return Promise.resolve();
  }

  download(
    _lease: SandboxLease,
    _remotePath: string,
  ): Promise<TrustedCloudArtifactRef> {
    this.calls.push("download");
    return Promise.resolve(
      artifact("runtime", "a", "application/x-tar"),
    );
  }

  cancel(): Promise<void> {
    this.calls.push("cancel");
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    this.calls.push("destroy");
    return Promise.resolve();
  }
}

function toolchain(
  lease: SandboxLease,
  spec: CandidateBuildSpec,
): TrustedBuildToolchainReceipt {
  return {
    sensitivity: "trusted-candidate-build-toolchain",
    sandboxId: lease.sandboxId,
    buildImageDigest: sandbox().imageDigest,
    architecture: "x86_64",
    nodeVersion: "24.10.0",
    npmVersion: "11.6.2",
    bunVersion: "1.3.0",
    gnuTarVersion: "tar (GNU tar) 1.35",
    offlineCacheManifestSha256: "b".repeat(64),
    extractorSha256: spec.extractorArtifact.sha256,
    packagerSha256: spec.packagerArtifact.sha256,
    checkedAt: now,
    passed: true,
  };
}

function commandReceiptHash(receipt: RemoteExecutionReceipt): string {
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

function signedAttestor(
  alter: (
    receipt: TrustedCandidateRuntimeBuildReceipt,
  ) => TrustedCandidateRuntimeBuildReceipt = (receipt) => receipt,
): TrustedCandidateRuntimeAttestor {
  return {
    async attest(input) {
      const body = {
        sensitivity: "trusted-candidate-runtime-build" as const,
        schemaVersion: 1 as const,
        buildId: input.buildId,
        experimentId: input.spec.experimentId,
        sandboxId: input.lease.sandboxId,
        candidateCommit: input.spec.candidateCommit,
        candidateTree: input.spec.candidateTree,
        lockSha256: input.spec.lockSha256,
        buildPolicyHash: input.spec.buildPolicyHash,
        architecture: input.spec.architecture,
        validationLevel: input.spec.validationLevel,
        sourceSha256: input.spec.sourceArtifact.sha256,
        extractorSha256: input.spec.extractorArtifact.sha256,
        packagerSha256: input.spec.packagerArtifact.sha256,
        toolchainAttestationHash: canonicalHash(input.toolchain),
        commandReceiptHashes: input.commandReceipts.map(commandReceiptHash),
        runtimeManifestSha256: "c".repeat(64),
        runtimeArtifact: input.runtimeArtifact,
        builtAt: "2026-07-01T01:00:00.000Z",
        passed: true as const,
      };
      const receipt: TrustedCandidateRuntimeBuildReceipt = {
        ...body,
        signature: createEd25519Signature(
          body,
          keys.privateKey,
          "candidate-build-key-001",
          "2026-07-01T01:00:01.000Z",
        ),
      };
      return alter(receipt);
    },
  };
}

function runner(
  provider: FakeBuildProvider,
  spec = buildSpec(),
  attestor = signedAttestor(),
): CandidateCloudBuildRunner {
  return new CandidateCloudBuildRunner({
    provider,
    sandbox: sandbox(),
    spec,
    toolchainVerifier: {
      verify: (_provider, lease, candidateSpec) =>
        Promise.resolve(toolchain(lease, candidateSpec)),
    },
    runtimeAttestor: attestor,
    receiptVerifier: {
      trustedKeyId: "candidate-build-key-001",
      publicKey: keys.publicKey,
    },
    requireReleaseValidation: true,
  });
}

describe("candidate cloud build runner", () => {
  it("uploads sealed inputs, runs every gate, signs the release runtime, and tears down", async () => {
    const provider = new FakeBuildProvider();
    const spec = buildSpec();
    await expect(runner(provider, spec).run()).resolves.toMatchObject({
      sensitivity: "trusted-candidate-runtime-build",
      candidateCommit: spec.candidateCommit,
      validationLevel: "release",
      runtimeArtifact: { mediaType: "application/x-tar" },
    });
    expect(provider.uploads).toEqual([
      spec.sourceRemotePath,
      spec.extractorRemotePath,
      spec.packagerRemotePath,
    ]);
    expect(provider.executions).toHaveLength(spec.commands.length);
    expect(provider.calls.at(-1)).toBe("destroy");
  });

  it("fails closed before download when a cloud gate fails", async () => {
    const provider = new FakeBuildProvider();
    provider.failExecution = 2;
    await expect(runner(provider).run()).rejects.toThrow(/failed closed/u);
    expect(provider.calls).not.toContain("download");
    expect(provider.calls.at(-1)).toBe("destroy");
  });

  it("rejects a mutated signed receipt and focused-only promotion runtime", async () => {
    const provider = new FakeBuildProvider();
    await expect(
      runner(
        provider,
        buildSpec(),
        signedAttestor((receipt) => ({
          ...receipt,
          runtimeManifestSha256: "d".repeat(64),
        })),
      ).run(),
    ).rejects.toThrow(/failed closed/u);
    expect(
      () =>
        new CandidateCloudBuildRunner({
          provider: new FakeBuildProvider(),
          sandbox: sandbox(),
          spec: buildSpec(false),
          toolchainVerifier: {
            verify: (_provider, lease, spec) =>
              Promise.resolve(toolchain(lease, spec)),
          },
          runtimeAttestor: signedAttestor(),
          receiptVerifier: {
            trustedKeyId: "candidate-build-key-001",
            publicKey: keys.publicKey,
          },
          requireReleaseValidation: true,
        }),
    ).toThrow(/deny-all/u);
  });
});
