import { describe, expect, it } from "vitest";

import { runProductionProviderReadiness } from "../../src/cloud/production-readiness.js";
import { hashNetworkPolicy } from "../../src/cloud/provider.js";
import type {
  CloudDownloadExpectation,
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

const BUILD_DIGEST = `sha256:${"a".repeat(64)}` as const;
const EVALUATOR_DIGEST = `sha256:${"b".repeat(64)}` as const;

class FakeProvider implements CloudSandboxProvider {
  readonly name = "daytona" as const;
  readonly configuration: ProviderConfiguration = {
    provider: "daytona",
    endpoint: "https://example.test",
    credentialEnvironmentNames: ["DAYTONA_API_KEY"],
    configFingerprint: "c".repeat(64),
  };
  readonly probes: ProviderProbeRequest[] = [];
  readonly creates: SandboxCreateRequest[] = [];
  readonly commands: RemoteCommandSpec[] = [];
  readonly destroyed: string[] = [];
  dockerExitCode = 0;

  probe(request: ProviderProbeRequest): Promise<ProviderProbeReport> {
    this.probes.push(request);
    return Promise.resolve({
      provider: this.name,
      requestId: request.requestId,
      checkedAt: "2026-07-26T00:00:00.000Z",
      configFingerprint: this.configuration.configFingerprint,
      capabilities: {
        lifecycle: true,
        cancellation: true,
        fileTransfer: true,
        hardTimeout: true,
        resourceReporting: true,
        networkDenyAll: true,
        kernelIsolation: true,
        dockerInDocker: true,
        gpu: false,
      },
      compatible: true,
      reasons: [],
    });
  }

  create(request: SandboxCreateRequest): Promise<SandboxLease> {
    this.creates.push(request);
    const ordinal = this.creates.length;
    return Promise.resolve({
      provider: this.name,
      sandboxId: `sandbox-${ordinal}`,
      createdAt: "2026-07-26T00:00:00.000Z",
      expiresAt: "2026-07-26T00:10:00.000Z",
      imageReference: request.imageReference,
      imageDigest: request.imageDigest,
      regionClass: request.regionClass,
      resources: request.resources,
      networkPolicyHash: hashNetworkPolicy(request.network),
      marker: {
        provider: this.name,
        sandboxId: `sandbox-${ordinal}`,
        markerEnvironmentName: "DAYTONA_SANDBOX_ID",
      },
    });
  }

  execute(
    lease: SandboxLease,
    command: RemoteCommandSpec,
  ): Promise<RemoteExecutionReceipt> {
    this.commands.push(command);
    return Promise.resolve({
      provider: this.name,
      sandboxId: lease.sandboxId,
      executionId: command.executionId ?? "execution-1",
      startedAt: "2026-07-26T00:00:01.000Z",
      finishedAt: "2026-07-26T00:00:02.000Z",
      exitCode: this.dockerExitCode,
      timedOut: false,
      cancelled: false,
      resourceReport: { peakMemoryMiB: 128, cpuTimeMs: 100 },
    });
  }

  upload(
    _lease: SandboxLease,
    _artifact: TrustedCloudArtifactRef,
    _remotePath: string,
  ): Promise<void> {
    return Promise.resolve();
  }

  download(
    _lease: SandboxLease,
    _remotePath: string,
    _expectation: CloudDownloadExpectation,
  ): Promise<TrustedCloudArtifactRef> {
    throw new Error("not used");
  }

  cancel(
    _lease: SandboxLease,
    _executionId: string,
  ): Promise<void> {
    return Promise.resolve();
  }

  destroy(lease: SandboxLease): Promise<void> {
    this.destroyed.push(lease.sandboxId);
    return Promise.resolve();
  }
}

function input(provider: CloudSandboxProvider) {
  return {
    provider,
    campaignId: "campaign-001",
    regionClass: "eu-standard",
    buildImage: {
      reference: `ghcr.io/parallaxai/build@${BUILD_DIGEST}`,
      digest: BUILD_DIGEST,
    },
    evaluatorImage: {
      reference: `ghcr.io/parallaxai/evaluator@${EVALUATOR_DIGEST}`,
      digest: EVALUATOR_DIGEST,
    },
    volumeSemanticsReceiptHash: "d".repeat(64),
    volumeSemanticsArtifactSha256: "e".repeat(64),
  } as const;
}

describe("production provider readiness", () => {
  it("proves the build role and real evaluator Docker-in-Docker execution", async () => {
    const provider = new FakeProvider();
    const receipt = await runProductionProviderReadiness(input(provider));

    expect(provider.probes).toHaveLength(2);
    expect(provider.probes[0]?.requireDockerInDocker).toBe(false);
    expect(provider.probes[1]?.requireDockerInDocker).toBe(true);
    expect(provider.creates.map((request) => request.imageDigest)).toEqual([
      BUILD_DIGEST,
      EVALUATOR_DIGEST,
    ]);
    expect(provider.commands).toEqual([
      expect.objectContaining({
        executable: "docker",
        arguments: ["info", "--format", "{{json .ServerVersion}}"],
        secretReferences: [],
      }),
    ]);
    expect(provider.destroyed).toEqual(["sandbox-2", "sandbox-1"]);
    expect(receipt).toMatchObject({
      domain: "dark-factory.production-provider-readiness.v1",
      buildImageDigest: BUILD_DIGEST,
      evaluatorImageDigest: EVALUATOR_DIGEST,
      dockerInDockerVerified: true,
    });
    expect(receipt.evaluatorDockerCommandHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed and destroys both leases when nested Docker is unavailable", async () => {
    const provider = new FakeProvider();
    provider.dockerExitCode = 1;

    await expect(
      runProductionProviderReadiness(input(provider)),
    ).rejects.toThrow("nested Docker daemon");
    expect(provider.destroyed).toEqual(["sandbox-2", "sandbox-1"]);
  });
});
