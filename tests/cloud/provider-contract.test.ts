import { describe, expect, it } from "vitest";
import { createDaytonaProvider } from "../../src/cloud/adapters/daytona.js";
import {
  assertMatchedExecutionProfiles,
  requireCompatibleProvider,
} from "../../src/cloud/probe.js";
import { hashNetworkPolicy } from "../../src/cloud/provider.js";
import type {
  CloudDownloadExpectation,
  CloudProviderTransport,
  ProviderCapabilities,
  ProviderConfiguration,
  ProviderProbeReport,
  ProviderProbeRequest,
  RemoteCommandSpec,
  RemoteExecutionReceipt,
  SandboxCreateRequest,
  SandboxLease,
  TrustedCloudArtifactRef,
} from "../../src/cloud/types.js";

const capabilities: ProviderCapabilities = {
  lifecycle: true,
  cancellation: true,
  fileTransfer: true,
  hardTimeout: true,
  resourceReporting: true,
  networkDenyAll: true,
  kernelIsolation: true,
  dockerInDocker: true,
  gpu: false,
};
const now = () => new Date("2026-07-01T00:00:30.000Z");

class FakeTransport implements CloudProviderTransport {
  readonly calls: string[] = [];
  capabilities: ProviderCapabilities = capabilities;
  mismatchedLease = false;

  probe(
    configuration: ProviderConfiguration,
    request: ProviderProbeRequest,
  ): Promise<ProviderProbeReport> {
    this.calls.push("probe");
    return Promise.resolve({
      provider: configuration.provider,
      requestId: request.requestId,
      checkedAt: "2026-07-01T00:00:00.000Z",
      configFingerprint: configuration.configFingerprint,
      capabilities: this.capabilities,
      compatible: true,
      reasons: [],
    });
  }

  create(
    configuration: ProviderConfiguration,
    request: SandboxCreateRequest,
  ): Promise<SandboxLease> {
    this.calls.push("create");
    return Promise.resolve({
      provider: this.mismatchedLease ? "e2b" : configuration.provider,
      sandboxId: "sandbox-1",
      createdAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-07-01T01:00:00.000Z",
      imageReference: request.imageReference,
      imageDigest: request.imageDigest,
      regionClass: request.regionClass,
      resources: request.resources,
      networkPolicyHash: hashNetworkPolicy(request.network),
      marker: {
        provider: this.mismatchedLease ? "e2b" : configuration.provider,
        sandboxId: "sandbox-1",
        markerEnvironmentName: "DAYTONA_WORKSPACE_ID",
      },
    });
  }

  execute(
    configuration: ProviderConfiguration,
    lease: SandboxLease,
    _command: RemoteCommandSpec,
  ): Promise<RemoteExecutionReceipt> {
    this.calls.push("execute");
    return Promise.resolve({
      provider: configuration.provider,
      sandboxId: lease.sandboxId,
      executionId: "execution-1",
      startedAt: "2026-07-01T00:00:00.000Z",
      finishedAt: "2026-07-01T00:00:01.000Z",
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      resourceReport: { peakMemoryMiB: 100, cpuTimeMs: 500 },
    });
  }

  upload(
    _configuration: ProviderConfiguration,
    _lease: SandboxLease,
    _artifact: TrustedCloudArtifactRef,
    _remotePath: string,
  ): Promise<void> {
    this.calls.push("upload");
    return Promise.resolve();
  }

  download(
    _configuration: ProviderConfiguration,
    _lease: SandboxLease,
    _remotePath: string,
    expectation: CloudDownloadExpectation,
  ): Promise<TrustedCloudArtifactRef> {
    this.calls.push("download");
    return Promise.resolve({
      uri: "trusted://artifacts/output",
      sha256: "c".repeat(64),
      mediaType: expectation.mediaType,
      byteLength: 12,
    });
  }

  cancel(
    _configuration: ProviderConfiguration,
    _lease: SandboxLease,
    _executionId: string,
  ): Promise<void> {
    this.calls.push("cancel");
    return Promise.resolve();
  }

  destroy(_configuration: ProviderConfiguration, _lease: SandboxLease): Promise<void> {
    this.calls.push("destroy");
    return Promise.resolve();
  }
}

function probeRequest(): ProviderProbeRequest {
  return {
    requestId: "probe-1",
    imageDigest: `sha256:${"a".repeat(64)}`,
    regionClass: "eu-standard",
    resources: {
      architecture: "x86_64",
      cpuCores: 4,
      memoryMiB: 8192,
      diskMiB: 20_000,
    },
    requireDockerInDocker: true,
    requireGpu: false,
  };
}

function createRequest(): SandboxCreateRequest {
  return {
    requestId: "create-1",
    imageReference: `ghcr.io/parallaxai/dark-factory@sha256:${"a".repeat(64)}`,
    imageDigest: `sha256:${"a".repeat(64)}`,
    regionClass: "eu-standard",
    resources: {
      architecture: "x86_64",
      cpuCores: 4,
      memoryMiB: 8192,
      diskMiB: 20_000,
    },
    network: {
      defaultAction: "deny",
      allowDomains: ["models.example.test"],
    },
    lifetimeMs: 3_600_000,
    secretReferences: [],
  };
}

function command(): RemoteCommandSpec {
  return {
    executable: "node",
    arguments: ["worker.js"],
    workingDirectory: "/workspace",
    timeoutMs: 10_000,
    environment: {},
    secretReferences: [],
  };
}

describe("cloud provider contract", () => {
  it("delegates lifecycle operations through an injected remote transport", async () => {
    const transport = new FakeTransport();
    const provider = createDaytonaProvider({ DAYTONA_API_KEY: "secret" }, transport, { now });
    await expect(requireCompatibleProvider(provider, probeRequest())).resolves.toMatchObject({
      compatible: true,
    });
    const lease = await provider.create(createRequest());
    await provider.execute(lease, command());
    await provider.upload(
      lease,
      {
        uri: "trusted://artifacts/source",
        sha256: "b".repeat(64),
        mediaType: "application/gzip",
        byteLength: 10,
      },
      "/workspace/source.tar.gz",
    );
    await provider.download(lease, "/workspace/result.json", {
      mediaType: "application/json",
      maximumByteLength: 1024,
    });
    await provider.cancel(lease, "execution-1");
    await provider.destroy(lease);
    expect(transport.calls).toEqual([
      "probe",
      "create",
      "execute",
      "upload",
      "download",
      "cancel",
      "destroy",
    ]);
  });

  it("rejects a provider that cannot enforce network denial", async () => {
    const transport = new FakeTransport();
    transport.capabilities = { ...capabilities, networkDenyAll: false };
    const provider = createDaytonaProvider({ DAYTONA_API_KEY: "secret" }, transport, { now });
    await expect(requireCompatibleProvider(provider, probeRequest())).rejects.toThrow(
      /networkDenyAll/u,
    );
  });

  it("rejects a lease attested by a different provider", async () => {
    const transport = new FakeTransport();
    transport.mismatchedLease = true;
    const provider = createDaytonaProvider({ DAYTONA_API_KEY: "secret" }, transport, { now });
    await expect(provider.create(createRequest())).rejects.toThrow(/does not belong/u);
  });

  it("rejects mutable image tags and remote path traversal", async () => {
    const transport = new FakeTransport();
    const provider = createDaytonaProvider({ DAYTONA_API_KEY: "secret" }, transport, { now });
    await expect(provider.create({ ...createRequest(), imageDigest: "node:24" })).rejects.toThrow(
      /sha256/u,
    );
    await expect(
      provider.create({
        ...createRequest(),
        requestId: "create-mutable",
        imageReference: "ghcr.io/parallaxai/dark-factory:latest",
      }),
    ).rejects.toThrow(/immutable OCI/u);
    const lease = await provider.create(createRequest());
    await expect(
      provider.download(lease, "/workspace/../secret", {
        mediaType: "application/json",
        maximumByteLength: 1024,
      }),
    ).rejects.toThrow(/traversal/u);
  });

  it("rejects expired, mutated, and already destroyed leases", async () => {
    let currentTime = new Date("2026-07-01T00:00:30.000Z");
    const transport = new FakeTransport();
    const provider = createDaytonaProvider({ DAYTONA_API_KEY: "secret" }, transport, {
      now: () => currentTime,
    });
    const lease = await provider.create(createRequest());

    await expect(provider.execute({ ...lease, regionClass: "changed" }, command())).rejects.toThrow(
      /mutated/u,
    );
    currentTime = new Date("2026-07-01T01:00:00.001Z");
    await expect(provider.execute(lease, command())).rejects.toThrow(/expired/u);
    await provider.destroy(lease);
    await provider.destroy(lease);
    await expect(
      provider.download(lease, "/workspace/result.json", {
        mediaType: "application/json",
        maximumByteLength: 1024,
      }),
    ).rejects.toThrow(/destroyed/u);
    expect(transport.calls.filter((call) => call === "destroy")).toHaveLength(1);
  });

  it("allows only secrets pregranted by the sandbox request", async () => {
    const transport = new FakeTransport();
    const provider = createDaytonaProvider({ DAYTONA_API_KEY: "secret" }, transport, { now });
    const lease = await provider.create({
      ...createRequest(),
      secretReferences: [
        {
          sourceEnvironmentName: "MODEL_CREDENTIAL",
          targetEnvironmentName: "MODEL_AUTH",
        },
      ],
    });

    await expect(
      provider.execute(lease, {
        ...command(),
        secretReferences: [
          {
            sourceEnvironmentName: "UNGRANTED_CREDENTIAL",
            targetEnvironmentName: "OTHER_AUTH",
          },
        ],
      }),
    ).rejects.toThrow(/outside its sandbox grant/u);
    await expect(
      provider.execute(lease, {
        ...command(),
        environment: { MODEL_AUTH: "shadowed" },
      }),
    ).rejects.toThrow(/secret-like field/u);
  });

  it("burns a sandbox request ID before remote creation", async () => {
    const transport = new FakeTransport();
    const provider = createDaytonaProvider({ DAYTONA_API_KEY: "secret" }, transport, { now });
    await provider.create(createRequest());
    await expect(provider.create(createRequest())).rejects.toThrow(/one-use/u);
    expect(transport.calls.filter((call) => call === "create")).toHaveLength(1);
  });
});

describe("matched execution profile", () => {
  const profile = {
    provider: "daytona" as const,
    imageDigest: `sha256:${"a".repeat(64)}`,
    regionClass: "eu-standard",
    resources: {
      architecture: "x86_64" as const,
      cpuCores: 4,
      memoryMiB: 8192,
      diskMiB: 20_000,
    },
    networkPolicyHash: "b".repeat(64),
    protocolHash: "c".repeat(64),
  };

  it("accepts an identical candidate/champion profile", () => {
    expect(() => assertMatchedExecutionProfiles(profile, { ...profile })).not.toThrow();
  });

  it.each([
    { provider: "e2b" as const },
    { imageDigest: `sha256:${"d".repeat(64)}` },
    { regionClass: "us-standard" },
    { networkPolicyHash: "d".repeat(64) },
    { protocolHash: "d".repeat(64) },
    { resources: { ...profile.resources, memoryMiB: 16_384 } },
  ])("rejects profile drift: %o", (change) => {
    expect(() => assertMatchedExecutionProfiles({ ...profile, ...change }, profile)).toThrow(
      /identical/u,
    );
  });
});
