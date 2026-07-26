import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TrustedArtifactBridge } from "../../src/cloud/artifact-bridge.js";
import {
  DaytonaCloudProviderTransport,
  encodePosixCommand,
  quotePosixArgument,
  type DaytonaClient,
  type DaytonaSdkFactory,
} from "../../src/cloud/adapters/daytona-transport.js";
import type {
  ProviderConfiguration,
  RemoteCommandSpec,
  SandboxCreateRequest,
  TrustedCloudArtifactRef,
} from "../../src/cloud/types.js";

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function collect(
  chunks: AsyncIterable<Uint8Array>,
): Promise<Buffer> {
  const result: Uint8Array[] = [];
  for await (const chunk of chunks) result.push(chunk);
  return Buffer.concat(result);
}

class ArtifactBridge implements TrustedArtifactBridge {
  readonly values = new Map<string, Buffer>();
  guardCalls = 0;

  assertTrustedRuntime(): void {
    this.guardCalls += 1;
  }

  openVerified(
    artifact: TrustedCloudArtifactRef,
  ): Promise<AsyncIterable<Uint8Array>> {
    const value = this.values.get(artifact.uri);
    if (
      value === undefined ||
      artifact.sha256 !== digest(value) ||
      artifact.byteLength !== value.byteLength
    ) {
      throw new Error("invalid fixture");
    }
    return Promise.resolve(
      (async function* () {
        yield value;
      })(),
    );
  }

  async persistVerified(input: {
    readonly uri: `trusted://${string}`;
    readonly mediaType: string;
    readonly chunks: AsyncIterable<Uint8Array>;
  }): Promise<TrustedCloudArtifactRef> {
    const value = await collect(input.chunks);
    this.values.set(input.uri, value);
    return {
      uri: input.uri,
      sha256: digest(value),
      mediaType: input.mediaType,
      byteLength: value.byteLength,
    };
  }
}

const metric = {
  timestamp: new Date("2026-07-01T00:00:01.000Z"),
  cpuCount: 2,
  cpuUsedPct: 25,
  memUsed: 128 * 1_024 * 1_024,
  memTotal: 4 * 1_024 * 1_024 * 1_024,
  diskUsed: 512 * 1_024 * 1_024,
  diskTotal: 10 * 1_024 * 1_024 * 1_024,
};

class Sandbox {
  readonly id = "sandbox-daytona-1";
  readonly target = "eu";
  readonly cpu: number;
  readonly memory: number;
  readonly disk: number;
  readonly gpu = 0;
  readonly public = false;
  readonly autoDeleteInterval = 0;
  readonly autoPauseInterval = 0;
  readonly autoStopInterval = 0;
  readonly autoDestroyAt = "2026-07-01T01:00:00.000Z";
  readonly networkBlockAll?: boolean;
  readonly domainAllowList?: string;
  readonly env: Record<string, string> = {};
  readonly uploaded = new Map<string, Buffer>();
  readonly secretUpdates: Readonly<Record<string, string>>[] = [];
  readonly environmentUpdates: Readonly<Record<string, string>>[] = [];
  encodedCommand = "";
  commandId = "daytona-command-1";
  commandPending = false;
  launched = false;
  stopped = false;
  stopForce = false;
  deleted = false;

  constructor(parameters: {
    readonly resources: {
      readonly cpu: number;
      readonly memory: number;
      readonly disk: number;
    };
    readonly networkBlockAll?: true;
    readonly domainAllowList?: string;
  }) {
    this.cpu = parameters.resources.cpu;
    this.memory = parameters.resources.memory;
    this.disk = parameters.resources.disk;
    if (parameters.networkBlockAll !== undefined) {
      this.networkBlockAll = parameters.networkBlockAll;
    }
    if (parameters.domainAllowList !== undefined) {
      this.domainAllowList = parameters.domainAllowList;
    }
  }

  readonly fs = {
    createFolder: (): Promise<void> => Promise.resolve(),
    uploadFileStream: async (
      source: AsyncIterable<Uint8Array>,
      remotePath: string,
    ): Promise<void> => {
      this.uploaded.set(remotePath, await collect(source));
    },
    downloadFileStream: (remotePath: string): Promise<AsyncIterable<Uint8Array>> => {
      const value = this.uploaded.get(remotePath) ?? Buffer.from("download");
      return Promise.resolve(
        (async function* () {
          yield value;
        })(),
      );
    },
    deleteFile: (path: string): Promise<void> => {
      this.uploaded.delete(path);
      return Promise.resolve();
    },
  };

  readonly process = {
    executeCommand: (): Promise<{
      readonly result: string;
      readonly exitCode: number;
    }> => Promise.resolve({ result: "x86_64\n", exitCode: 0 }),
    createSession: (): Promise<void> => Promise.resolve(),
    deleteSession: (): Promise<void> => Promise.resolve(),
    executeSessionCommand: (
      _sessionId: string,
      request: {
        readonly command: string;
      },
    ): Promise<{ readonly cmdId: string }> => {
      this.encodedCommand = request.command;
      this.launched = true;
      return Promise.resolve({ cmdId: this.commandId });
    },
    getSessionCommand: (): Promise<{
      readonly id: string;
      readonly exitCode: number;
    }> => {
      if (this.commandPending) {
        return new Promise(() => {
          // Cancellation/timeout must win without waiting for this SDK call.
        });
      }
      return Promise.resolve({ id: this.commandId, exitCode: 0 });
    },
    getSessionCommandLogs: (): Promise<{
      readonly stdout: string;
      readonly stderr: string;
    }> => Promise.resolve({
      stdout: "private raw stdout",
      stderr: "private raw stderr",
    }),
  };

  refreshData(): Promise<void> {
    return Promise.resolve();
  }

  updateEnv(environment: Readonly<Record<string, string>>): Promise<void> {
    this.environmentUpdates.push(environment);
    Object.assign(this.env, environment);
    return Promise.resolve();
  }

  updateSecrets(secrets: Readonly<Record<string, string>>): Promise<void> {
    this.secretUpdates.push(secrets);
    return Promise.resolve();
  }

  getMetrics(): Promise<readonly (typeof metric)[]> {
    return Promise.resolve([metric]);
  }

  getMetricsLatest(): Promise<typeof metric> {
    return Promise.resolve(metric);
  }

  stop(_timeoutSeconds?: number, force?: boolean): Promise<void> {
    this.stopped = true;
    this.stopForce = force === true;
    return Promise.resolve();
  }

  delete(): Promise<void> {
    this.deleted = true;
    return Promise.resolve();
  }
}

class Client implements DaytonaClient {
  parameters?: Parameters<DaytonaClient["create"]>[0];
  sandbox?: Sandbox;

  create(
    parameters: Parameters<DaytonaClient["create"]>[0],
  ): Promise<Sandbox> {
    this.parameters = parameters;
    this.sandbox = new Sandbox(parameters);
    return Promise.resolve(this.sandbox);
  }
}

class Factory implements DaytonaSdkFactory {
  readonly client = new Client();
  configuration?: ProviderConfiguration;

  createClient(configuration: ProviderConfiguration): Promise<DaytonaClient> {
    this.configuration = configuration;
    return Promise.resolve(this.client);
  }
}

const configuration: ProviderConfiguration = {
  provider: "daytona",
  endpoint: "https://app.daytona.io/api",
  credentialEnvironmentNames: ["DAYTONA_API_KEY"],
  target: "eu",
  configFingerprint: "c".repeat(64),
};

function createRequest(): SandboxCreateRequest {
  return {
    requestId: "create-daytona-1",
    imageReference: `ghcr.io/parallaxai/df@sha256:${"a".repeat(64)}`,
    imageDigest: `sha256:${"a".repeat(64)}`,
    regionClass: "eu",
    resources: {
      architecture: "x86_64",
      cpuCores: 2,
      memoryMiB: 4_096,
      diskMiB: 10_240,
    },
    network: {
      defaultAction: "deny",
      allowDomains: ["api.anthropic.com"],
    },
    lifetimeMs: 3_600_000,
    secretReferences: [
      {
        sourceEnvironmentName: "DAYTONA_ANTHROPIC_SECRET",
        targetEnvironmentName: "ANTHROPIC_API_KEY",
      },
    ],
  };
}

function command(overrides: Partial<RemoteCommandSpec> = {}): RemoteCommandSpec {
  return {
    executionId: "execution-presealed-1",
    executable: "/usr/bin/node",
    arguments: ["worker.js", "a'; touch /tmp/pwn; #"],
    workingDirectory: "/workspace",
    timeoutMs: 60_000,
    environment: {
      SAFE_VALUE: "literal $(touch /tmp/also-not-run); `id`",
    },
    secretReferences: [
      {
        sourceEnvironmentName: "DAYTONA_ANTHROPIC_SECRET",
        targetEnvironmentName: "ANTHROPIC_API_KEY",
      },
    ],
    ...overrides,
  };
}

function transportFixture(): {
  readonly bridge: ArtifactBridge;
  readonly factory: Factory;
  readonly transport: DaytonaCloudProviderTransport;
} {
  const bridge = new ArtifactBridge();
  const factory = new Factory();
  return {
    bridge,
    factory,
    transport: new DaytonaCloudProviderTransport({
      artifactBridge: bridge,
      sdkFactory: factory,
      now: () => new Date("2026-07-01T00:00:00.000Z"),
    }),
  };
}

describe("Daytona POSIX argv encoding", () => {
  it("single-quotes empty values, metacharacters, substitutions, and embedded quotes", () => {
    expect(quotePosixArgument("")).toBe("''");
    expect(quotePosixArgument("a'b")).toBe("'a'\"'\"'b'");
    expect(
      encodePosixCommand(command()),
    ).toBe(
      "cd '/workspace' && exec '/usr/bin/env' 'SAFE_VALUE=literal $(touch /tmp/also-not-run); `id`' '/usr/bin/node' 'worker.js' 'a'\"'\"'; touch /tmp/pwn; #'",
    );
  });

  it("rejects NUL instead of truncating an argument", () => {
    expect(() => quotePosixArgument("before\u0000after")).toThrow(/NUL/u);
  });
});

describe("Daytona cloud provider transport", () => {
  it("provisions an immutable, exact, ephemeral, TTL-bound, network-limited sandbox", async () => {
    const { factory, transport } = transportFixture();

    const lease = await transport.create(configuration, createRequest());

    expect(factory.client.parameters).toMatchObject({
      image: createRequest().imageReference,
      resources: { cpu: 2, memory: 4, disk: 10 },
      ephemeral: true,
      autoPauseInterval: 0,
      autoStopInterval: 0,
      ttlMinutes: 60,
      public: false,
      domainAllowList: "api.anthropic.com",
      secrets: {
        ANTHROPIC_API_KEY: "DAYTONA_ANTHROPIC_SECRET",
      },
    });
    expect(JSON.stringify(factory.client.parameters)).not.toContain(
      "actual-secret-value",
    );
    expect(factory.client.sandbox?.environmentUpdates).toContainEqual({
      DAYTONA_SANDBOX_ID: "sandbox-daytona-1",
      DF_CLOUD_EXECUTION: "1",
    });
    expect(lease).toMatchObject({
      imageReference: createRequest().imageReference,
      imageDigest: createRequest().imageDigest,
      regionClass: "eu",
      networkPolicyHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      marker: {
        markerEnvironmentName: "DAYTONA_SANDBOX_ID",
        sandboxId: "sandbox-daytona-1",
      },
    });
  });

  it("fails its probe for rounded resources, target drift, and exact GPU requests", async () => {
    const { transport } = transportFixture();
    const report = await transport.probe(
      { ...configuration, target: "us" },
      {
        requestId: "probe-daytona-1",
        imageDigest: `sha256:${"a".repeat(64)}`,
        regionClass: "eu",
        resources: {
          architecture: "x86_64",
          cpuCores: 2,
          memoryMiB: 4_000,
          diskMiB: 10_000,
          gpuClass: "A100",
        },
        requireDockerInDocker: true,
        requireGpu: true,
      },
    );

    expect(report.compatible).toBe(false);
    expect(report.capabilities.gpu).toBe(false);
    expect(report.reasons).toEqual(
      expect.arrayContaining([
        "daytona-target-does-not-exactly-match-region-class",
        "daytona-resources-require-whole-gibibytes",
        "daytona-exact-gpu-type-attestation-unavailable",
      ]),
    );
  });

  it("keeps command output behind trusted refs and scopes organization secrets per command", async () => {
    const { bridge, factory, transport } = transportFixture();
    const lease = await transport.create(configuration, createRequest());

    const receipt = await transport.execute(
      configuration,
      lease,
      command(),
    );

    expect(factory.client.sandbox?.encodedCommand).toContain(
      "'a'\"'\"'; touch /tmp/pwn; #'",
    );
    expect(factory.client.sandbox?.secretUpdates).toEqual([
      {
        ANTHROPIC_API_KEY: "DAYTONA_ANTHROPIC_SECRET",
      },
      {},
    ]);
    expect(receipt).toMatchObject({
      executionId: "execution-presealed-1",
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      stdout: {
        uri: expect.stringMatching(/^trusted:\/\/daytona\//u),
      },
      stderr: {
        uri: expect.stringMatching(/^trusted:\/\/daytona\//u),
      },
      resourceReport: {
        peakMemoryMiB: 128,
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("private raw stdout");
    expect(
      [...bridge.values.values()].some(
        (value) => value.toString("utf8") === "private raw stdout",
      ),
    ).toBe(true);
  });

  it("seals the declared download media type and rejects bytes beyond the streaming limit", async () => {
    const { transport } = transportFixture();
    const lease = await transport.create(configuration, createRequest());

    await expect(
      transport.download(
        configuration,
        lease,
        "/workspace/result.json",
        {
          mediaType: "application/json",
          maximumByteLength: 8,
        },
      ),
    ).resolves.toMatchObject({
      mediaType: "application/json",
      byteLength: 8,
    });

    await expect(
      transport.download(
        configuration,
        lease,
        "/workspace/oversized.json",
        {
          mediaType: "application/json",
          maximumByteLength: 7,
        },
      ),
    ).rejects.toThrow(/integrity validation/u);
  });

  it("uses a presealed execution id to cancel concurrently and confirms force-stop", async () => {
    const { factory, transport } = transportFixture();
    const lease = await transport.create(configuration, createRequest());
    const sandbox = factory.client.sandbox;
    if (sandbox === undefined) throw new Error("missing fake sandbox");
    sandbox.commandPending = true;

    const pendingReceipt = transport.execute(
      configuration,
      lease,
      command({ executionId: "execution-cancel-1" }),
    );
    while (!sandbox.launched) await Promise.resolve();
    await transport.cancel(
      configuration,
      lease,
      "execution-cancel-1",
    );

    await expect(pendingReceipt).resolves.toMatchObject({
      executionId: "execution-cancel-1",
      exitCode: null,
      timedOut: false,
      cancelled: true,
    });
    expect(sandbox.stopped).toBe(true);
    expect(sandbox.stopForce).toBe(true);
  });

  it("enforces a hard wall-clock timeout by force-stopping the ephemeral sandbox", async () => {
    vi.useFakeTimers();
    try {
      const { factory, transport } = transportFixture();
      const lease = await transport.create(configuration, createRequest());
      const sandbox = factory.client.sandbox;
      if (sandbox === undefined) throw new Error("missing fake sandbox");
      sandbox.commandPending = true;

      const pendingReceipt = transport.execute(
        configuration,
        lease,
        command({
          executionId: "execution-timeout-1",
          timeoutMs: 1_000,
        }),
      );
      await vi.advanceTimersByTimeAsync(1_001);

      await expect(pendingReceipt).resolves.toMatchObject({
        executionId: "execution-timeout-1",
        exitCode: null,
        timedOut: true,
        cancelled: false,
      });
      expect(sandbox.stopped).toBe(true);
      expect(sandbox.stopForce).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
