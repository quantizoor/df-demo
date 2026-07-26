import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
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
import {
  createSignedRawDestructionReceipt,
  createTrustedRawArtifactManifest,
  type TrustedRawArtifactManifest,
  type TrustedRawDestructionReceipt,
  type TrustedRawDestructionReceiptVerifier,
  type TrustedRawRetentionPolicy,
} from "../../src/evaluator/retention.js";
import { hiddenTaskId } from "../../src/evaluation/types.js";
import { canonicalHash } from "../../src/schemas/canonical.js";
import {
  computeTrustedHarborJobHash,
  hashHarborAgentIsolationPolicy,
  type TrustedHarborJobArtifact,
} from "../../src/terminal-bench/harbor.js";
import {
  hashTerminalBench21Pin,
  type TerminalBench21Pin,
} from "../../src/terminal-bench/pin.js";
import {
  DARK_FACTORY_PI_HARBOR_IMPORT_PATH,
  createPiHarborAgentSpec,
} from "../../src/terminal-bench/pi-agent.js";
import {
  TerminalBenchCloudRunner,
  type TrustedRawRun,
  type TrustedRuntimeVerificationReceipt,
} from "../../src/terminal-bench/runner.js";
import {
  createTrustedMatchedArmSchedule,
  type TrustedMatchedPanel,
} from "../../src/terminal-bench/trusted.js";

const pin: TerminalBench21Pin = {
  benchmark: "terminal-bench-2.1",
  dataset: "terminal-bench/terminal-bench-2-1",
  registryRevision: 6,
  taskCount: 89,
  datasetContentSha256: "a".repeat(64),
  datasetManifestSha256: "b".repeat(64),
  harborVersion: "0.20.0",
  harborPackageSha256: "c".repeat(64),
  harborExecutableSha256: "d".repeat(64),
  piHarborAdapterSha256: "e".repeat(64),
};

const retentionPolicy: TrustedRawRetentionPolicy = {
  policyHash: "9".repeat(64),
  storageRoot: "trusted://raw/evaluator/",
  maximumRetentionMinutes: 60,
  destruction: "crypto-shred",
  encryptionRequired: true,
  localExportAllowed: false,
};

const destructionKeys = generateKeyPairSync("ed25519");
const destructionReceiptVerifier: TrustedRawDestructionReceiptVerifier = {
  trustedKeyId: "raw-destruction-key-001",
  publicKey: destructionKeys.publicKey,
};

function panel(): TrustedMatchedPanel {
  return {
    sensitivity: "hidden-benchmark-panel",
    leaseId: "lease-001",
    requestId: "request-001",
    stage: "validation",
    sealedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-07-01T06:00:00.000Z",
    dispositionAttestationHash: "8".repeat(64),
    cells: Array.from({ length: 12 }, (_, index) => ({
      sensitivity: "hidden-benchmark-cell" as const,
      taskId: hiddenTaskId((index + 1).toString(16).padStart(64, "0")),
      taskRevisionDigest: (index + 30).toString(16).padStart(64, "0"),
      capabilityStratum: `stratum-${(index % 3) + 1}`,
      replicateOrdinal: 1,
      order: index % 2 === 0 ? ("AB" as const) : ("BA" as const),
    })),
  };
}

const candidate = {
  uri: "trusted://harness/candidate" as const,
  commitSha: "1".repeat(40),
  treeSha: "1".repeat(40),
  archiveSha256: "1".repeat(64),
};
const champion = {
  uri: "trusted://harness/champion" as const,
  commitSha: "2".repeat(40),
  treeSha: "2".repeat(40),
  archiveSha256: "2".repeat(64),
};

function harborJob(): TrustedHarborJobArtifact {
  const value: TrustedHarborJobArtifact = {
    sensitivity: "hidden-harbor-job",
    requestId: "request-001",
    stage: "validation",
    pinHash: hashTerminalBench21Pin(pin),
    isolationPolicyHash: hashHarborAgentIsolationPolicy(),
    jobSha256: "0".repeat(64),
    cellCount: 12,
    armCount: 24,
    uploads: [
      {
        role: "config-ab",
        artifact: {
          uri: "trusted://jobs/request-001/config-ab",
          sha256: "1".repeat(64),
          mediaType: "application/json",
          byteLength: 1024,
        },
        remotePath: "/trusted/uploads/config-ab.json",
      },
      {
        role: "config-ba",
        artifact: {
          uri: "trusted://jobs/request-001/config-ba",
          sha256: "2".repeat(64),
          mediaType: "application/json",
          byteLength: 1024,
        },
        remotePath: "/trusted/uploads/config-ba.json",
      },
      {
        role: "output-packager",
        artifact: {
          uri: "trusted://jobs/request-001/output-packager",
          sha256: "5".repeat(64),
          mediaType: "text/javascript",
          byteLength: 16_384,
        },
        remotePath: "/trusted/uploads/package-harbor-output.mjs",
      },
      {
        role: "pi-adapter",
        artifact: {
          uri: "trusted://jobs/request-001/adapter",
          sha256: pin.piHarborAdapterSha256,
          mediaType: "text/x-python",
          byteLength: 4096,
        },
        remotePath: "/trusted/uploads/dark_factory_pi.py",
      },
      {
        role: "candidate-runtime",
        artifact: {
          uri: "trusted://jobs/request-001/candidate",
          sha256: "3".repeat(64),
          mediaType: "application/gzip",
          byteLength: 65_536,
        },
        remotePath: "/trusted/uploads/candidate.tar.gz",
      },
      {
        role: "champion-runtime",
        artifact: {
          uri: "trusted://jobs/request-001/champion",
          sha256: "4".repeat(64),
          mediaType: "application/gzip",
          byteLength: 65_536,
        },
        remotePath: "/trusted/uploads/champion.tar.gz",
      },
    ],
    invocations: [
      {
        invocationId: "request-001-ab",
        order: "AB",
        configSha256: "1".repeat(64),
        remoteConfigPath: "/trusted/uploads/config-ab.json",
        remoteHarborJobPath: "/trusted/results/request-001-ab",
        remoteOutputPath:
          "/trusted/results/request-001-ab.harbor-output.tar",
        cellCount: 6,
        armCount: 12,
        agentOrder: ["candidate", "champion"],
        nAttempts: 1,
        nConcurrentTrials: 1,
        harborRetries: 0,
      },
      {
        invocationId: "request-001-ba",
        order: "BA",
        configSha256: "2".repeat(64),
        remoteConfigPath: "/trusted/uploads/config-ba.json",
        remoteHarborJobPath: "/trusted/results/request-001-ba",
        remoteOutputPath:
          "/trusted/results/request-001-ba.harbor-output.tar",
        cellCount: 6,
        armCount: 12,
        agentOrder: ["champion", "candidate"],
        nAttempts: 1,
        nConcurrentTrials: 1,
        harborRetries: 0,
      },
    ],
  };
  return {
    ...value,
    jobSha256: computeTrustedHarborJobHash(value),
  };
}

class FakeProvider implements CloudSandboxProvider {
  readonly name = "daytona" as const;
  readonly configuration: ProviderConfiguration = {
    provider: "daytona",
    endpoint: "https://cloud.example.test",
    credentialEnvironmentNames: ["DAYTONA_API_KEY"],
    configFingerprint: "7".repeat(64),
  };
  readonly calls: string[] = [];
  readonly commands: RemoteCommandSpec[] = [];
  readonly probeRequests: ProviderProbeRequest[] = [];
  readonly uploadedPaths: string[] = [];
  readonly downloadedPaths: string[] = [];
  failExecutionOrdinal: number | undefined;
  failDestroy = false;
  downloadMediaType = "application/x-tar";

  probe(request: ProviderProbeRequest): Promise<ProviderProbeReport> {
    this.calls.push("probe");
    this.probeRequests.push(request);
    return Promise.resolve({
      provider: this.name,
      requestId: request.requestId,
      checkedAt: "2026-07-01T00:00:00.000Z",
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
    this.calls.push("create");
    return Promise.resolve({
      provider: this.name,
      sandboxId: "sandbox-001",
      createdAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-07-01T06:00:00.000Z",
      imageReference: request.imageReference,
      imageDigest: request.imageDigest,
      regionClass: request.regionClass,
      resources: request.resources,
      networkPolicyHash: hashNetworkPolicy(request.network),
      marker: {
        provider: this.name,
        sandboxId: "sandbox-001",
        markerEnvironmentName: "DAYTONA_SANDBOX_ID",
      },
    });
  }

  execute(
    lease: SandboxLease,
    command: RemoteCommandSpec,
  ): Promise<RemoteExecutionReceipt> {
    this.calls.push("execute");
    this.commands.push(command);
    const ordinal = this.commands.length;
    return Promise.resolve({
      provider: this.name,
      sandboxId: lease.sandboxId,
      executionId: `execution-${String(ordinal).padStart(3, "0")}`,
      startedAt: `2026-07-01T00:0${ordinal}:00.000Z`,
      finishedAt: `2026-07-01T00:0${ordinal + 1}:00.000Z`,
      exitCode: this.failExecutionOrdinal === ordinal ? 1 : 0,
      timedOut: false,
      cancelled: false,
      resourceReport: {
        peakMemoryMiB: 1024 + ordinal,
        cpuTimeMs: 30_000 + ordinal,
      },
    });
  }

  upload(
    _lease: SandboxLease,
    _artifact: TrustedCloudArtifactRef,
    remotePath: string,
  ): Promise<void> {
    this.calls.push("upload");
    this.uploadedPaths.push(remotePath);
    return Promise.resolve();
  }

  download(
    _lease: SandboxLease,
    remotePath: string,
    expectation: CloudDownloadExpectation,
  ): Promise<TrustedCloudArtifactRef> {
    this.calls.push("download");
    this.downloadedPaths.push(remotePath);
    expect(expectation).toEqual({
      mediaType: this.downloadMediaType,
      maximumByteLength: 2_304 * 1024 * 1024,
    });
    const ordinal = this.downloadedPaths.length;
    return Promise.resolve({
      uri: `trusted://results/raw-bundle-${ordinal}` as const,
      sha256: (ordinal === 1 ? "6" : "7").repeat(64),
      mediaType: "application/x-tar",
      byteLength: 4096 + ordinal,
    });
  }

  cancel(_lease: SandboxLease, _executionId: string): Promise<void> {
    this.calls.push("cancel");
    return Promise.resolve();
  }

  destroy(_lease: SandboxLease): Promise<void> {
    this.calls.push("destroy");
    return this.failDestroy
      ? Promise.reject(new Error("provider-specific teardown detail"))
      : Promise.resolve();
  }
}

function sandbox(): SandboxCreateRequest {
  return {
    requestId: "template",
    imageReference: `ghcr.io/parallaxai/dark-factory-eval@sha256:${"5".repeat(64)}`,
    imageDigest: `sha256:${"5".repeat(64)}`,
    regionClass: "eu-standard",
    resources: {
      architecture: "x86_64",
      cpuCores: 8,
      memoryMiB: 16_384,
      diskMiB: 100_000,
    },
    network: {
      defaultAction: "deny",
      allowDomains: ["api.model.example.test"],
    },
    lifetimeMs: 6 * 60 * 60_000,
    secretReferences: [
      {
        sourceEnvironmentName: "EVALUATED_OPENAI_API_KEY",
        targetEnvironmentName: "OPENAI_API_KEY",
      },
      {
        sourceEnvironmentName: "DAYTONA_API_KEY",
        targetEnvironmentName: "DAYTONA_API_KEY",
      },
    ],
  };
}

function runtimeReceipt(): TrustedRuntimeVerificationReceipt {
  return {
    sensitivity: "trusted-runtime-verification",
    sandboxId: "sandbox-001",
    pinHash: hashTerminalBench21Pin(pin),
    checkedAt: "2026-07-01T00:00:30.000Z",
    harborPackageSha256: pin.harborPackageSha256,
    harborExecutableSha256: pin.harborExecutableSha256,
    datasetContentSha256: pin.datasetContentSha256,
    datasetManifestSha256: pin.datasetManifestSha256,
    piHarborAdapterSha256: pin.piHarborAdapterSha256,
    passed: true,
  };
}

function rawManifest(): TrustedRawArtifactManifest {
  return createTrustedRawArtifactManifest(retentionPolicy, {
    manifestId: "manifest-001",
    createdAt: "2026-07-01T00:03:00.000Z",
    destroyBy: "2026-07-01T00:30:00.000Z",
    artifacts: [
      {
        kind: "atif",
        uri: "trusted://raw/evaluator/atif",
        sha256: "a".repeat(64),
        byteLength: 1024,
        encrypted: true,
      },
      {
        kind: "grader-output",
        uri: "trusted://raw/evaluator/grader-output",
        sha256: "b".repeat(64),
        byteLength: 2048,
        encrypted: true,
      },
      {
        kind: "harbor-output",
        uri: "trusted://raw/evaluator/harbor-output",
        sha256: "c".repeat(64),
        byteLength: 4096,
        encrypted: true,
      },
    ],
  });
}

function destructionReceipt(
  manifest: TrustedRawArtifactManifest,
): TrustedRawDestructionReceipt {
  return createSignedRawDestructionReceipt({
    policy: retentionPolicy,
    manifest,
    destroyedAt: "2026-07-01T00:10:00.000Z",
    privateKey: destructionKeys.privateKey,
    keyId: destructionReceiptVerifier.trustedKeyId,
    signedAt: "2026-07-01T00:10:30.000Z",
  });
}

function createRunner(
  provider: FakeProvider,
  discard?: (rawRun: TrustedRawRun) => Promise<TrustedRawDestructionReceipt>,
): TerminalBenchCloudRunner {
  return new TerminalBenchCloudRunner({
    provider,
    pin,
    sandbox: sandbox(),
    harborExecutable: "/opt/harbor/bin/harbor",
    harborWorkingDirectory: "/workspace/evaluator",
    harborTimeoutMs: 3_600_000,
    outputPackagerNodeExecutable: "/usr/bin/node",
    outputPackagerTimeoutMs: 900_000,
    remoteUploadRoot: "/trusted/uploads/",
    remoteOutputRoot: "/trusted/results/",
    harborSecretReferences: sandbox().secretReferences.slice(1),
    modelSecretReferences: sandbox().secretReferences.slice(0, 1),
    retentionPolicy,
    destructionReceiptVerifier,
    runtimeVerifier: {
      verify: () => Promise.resolve(runtimeReceipt()),
    },
    jobBuilder: {
      build: () => Promise.resolve(harborJob()),
    },
    rawIngress: {
      persist: ({
        requestId,
        job,
        executions,
        downloadedBundles,
        runtimeVerification,
      }) =>
        Promise.resolve({
          sensitivity: "raw-terminal-bench-run",
          requestId,
          pinHash: job.pinHash,
          jobSha256: job.jobSha256,
          runtimeAttestationHash: canonicalHash(runtimeVerification),
          executions,
          rawBundles: downloadedBundles,
          manifest: rawManifest(),
        }),
      discard:
        discard ??
        ((rawRun) => Promise.resolve(destructionReceipt(rawRun.manifest))),
    },
  });
}

function runRequest() {
  const hiddenPanel = panel();
  return {
    sensitivity: "hidden-terminal-bench-run-request" as const,
    requestId: "request-001",
    panel: hiddenPanel,
    schedule: createTrustedMatchedArmSchedule(
      hiddenPanel,
      candidate,
      champion,
    ),
    agent: createPiHarborAgentSpec({
      adapterImportPath: DARK_FACTORY_PI_HARBOR_IMPORT_PATH,
      adapterSha256: pin.piHarborAdapterSha256,
      provider: "openai",
      modelId: "gpt-5.6",
      thinkingLevel: "high",
      enabledTools: ["read", "write", "bash"],
      credentialEnvironmentNames: ["OPENAI_API_KEY"],
      timeoutMs: 3_600_000,
    }),
  };
}

describe("cloud-only Terminal-Bench runner", () => {
  it(
    "uploads the sealed bundle, runs AB then BA once, ingests both outputs, and destroys the sandbox",
    async () => {
      const provider = new FakeProvider();
      const rawRun = await createRunner(provider).run(runRequest());

      expect(rawRun).toMatchObject({
        sensitivity: "raw-terminal-bench-run",
        requestId: "request-001",
      });
      expect(rawRun.executions.map((execution) => execution.executionId)).toEqual([
        "execution-001",
        "execution-002",
      ]);
      expect(rawRun.rawBundles.map((bundle) => bundle.uri)).toEqual([
        "trusted://results/raw-bundle-1",
        "trusted://results/raw-bundle-2",
      ]);
      expect(provider.probeRequests).toHaveLength(1);
      expect(provider.probeRequests[0]).toMatchObject({
        requireDockerInDocker: true,
        requireGpu: false,
      });
      expect(provider.calls).toEqual([
        "probe",
        "create",
        "upload",
        "upload",
        "upload",
        "upload",
        "upload",
        "upload",
        "execute",
        "execute",
        "execute",
        "execute",
        "download",
        "download",
        "destroy",
      ]);
      expect(provider.uploadedPaths).toEqual([
        "/trusted/uploads/config-ab.json",
        "/trusted/uploads/config-ba.json",
        "/trusted/uploads/package-harbor-output.mjs",
        "/trusted/uploads/dark_factory_pi.py",
        "/trusted/uploads/candidate.tar.gz",
        "/trusted/uploads/champion.tar.gz",
      ]);
      expect(provider.commands.map((command) => command.arguments)).toEqual([
        ["run", "-c", "/trusted/uploads/config-ab.json"],
        ["run", "-c", "/trusted/uploads/config-ba.json"],
        [
          "/trusted/uploads/package-harbor-output.mjs",
          "--source-directory",
          "/trusted/results/request-001-ab",
          "--output",
          "/trusted/results/request-001-ab.harbor-output.tar",
          "--request-id",
          "request-001",
          "--job-sha256",
          harborJob().jobSha256,
          "--pin-sha256",
          hashTerminalBench21Pin(pin),
          "--invocation-id",
          "request-001-ab",
          "--order",
          "AB",
          "--config-sha256",
          "1".repeat(64),
          "--execution-id",
          "execution-001",
          "--expected-trials",
          "12",
        ],
        [
          "/trusted/uploads/package-harbor-output.mjs",
          "--source-directory",
          "/trusted/results/request-001-ba",
          "--output",
          "/trusted/results/request-001-ba.harbor-output.tar",
          "--request-id",
          "request-001",
          "--job-sha256",
          harborJob().jobSha256,
          "--pin-sha256",
          hashTerminalBench21Pin(pin),
          "--invocation-id",
          "request-001-ba",
          "--order",
          "BA",
          "--config-sha256",
          "2".repeat(64),
          "--execution-id",
          "execution-002",
          "--expected-trials",
          "12",
        ],
      ]);
      expect(
        provider.commands.map((command) => command.secretReferences),
      ).toEqual([
        [
          {
            sourceEnvironmentName: "DAYTONA_API_KEY",
            targetEnvironmentName: "DAYTONA_API_KEY",
          },
          {
            sourceEnvironmentName: "EVALUATED_OPENAI_API_KEY",
            targetEnvironmentName: "OPENAI_API_KEY",
          },
        ],
        [
          {
            sourceEnvironmentName: "DAYTONA_API_KEY",
            targetEnvironmentName: "DAYTONA_API_KEY",
          },
          {
            sourceEnvironmentName: "EVALUATED_OPENAI_API_KEY",
            targetEnvironmentName: "OPENAI_API_KEY",
          },
        ],
        [],
        [],
      ]);
      expect(provider.downloadedPaths).toEqual([
        "/trusted/results/request-001-ab.harbor-output.tar",
        "/trusted/results/request-001-ba.harbor-output.tar",
      ]);
      for (const cell of panel().cells) {
        expect(JSON.stringify(provider.commands)).not.toContain(cell.taskId);
      }
    },
  );

  it("fails closed after the first invocation when the BA invocation fails", async () => {
    const provider = new FakeProvider();
    provider.failExecutionOrdinal = 2;

    await expect(createRunner(provider).run(runRequest())).rejects.toThrow(
      /failed closed/u,
    );

    expect(provider.calls).toEqual([
      "probe",
      "create",
      "upload",
      "upload",
      "upload",
      "upload",
      "upload",
      "upload",
      "execute",
      "execute",
      "destroy",
    ]);
    expect(provider.commands.map((command) => command.arguments)).toEqual([
      ["run", "-c", "/trusted/uploads/config-ab.json"],
      ["run", "-c", "/trusted/uploads/config-ba.json"],
    ]);
    expect(provider.downloadedPaths).toEqual([]);
  });

  it("discards both persisted outputs if sandbox teardown fails", async () => {
    const provider = new FakeProvider();
    provider.failDestroy = true;
    const discard = vi.fn((rawRun: TrustedRawRun) =>
      Promise.resolve(destructionReceipt(rawRun.manifest)),
    );

    await expect(createRunner(provider, discard).run(runRequest())).rejects.toThrow(
      /discarded/u,
    );

    expect(provider.calls).toEqual([
      "probe",
      "create",
      "upload",
      "upload",
      "upload",
      "upload",
      "upload",
      "upload",
      "execute",
      "execute",
      "execute",
      "execute",
      "download",
      "download",
      "destroy",
    ]);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard.mock.calls[0]?.[0].executions).toHaveLength(2);
    expect(discard.mock.calls[0]?.[0].rawBundles).toHaveLength(2);
  });

  it("fails closed before download if deterministic packaging fails", async () => {
    const provider = new FakeProvider();
    provider.failExecutionOrdinal = 3;

    await expect(createRunner(provider).run(runRequest())).rejects.toThrow(
      /failed closed/u,
    );

    expect(provider.commands).toHaveLength(3);
    expect(provider.commands[2]?.secretReferences).toEqual([]);
    expect(provider.downloadedPaths).toEqual([]);
    expect(provider.calls.at(-1)).toBe("destroy");
  });

  it("rejects a downloaded file whose media type violates the sealed expectation", async () => {
    const provider = new FakeProvider();
    provider.downloadMediaType = "application/gzip";

    await expect(createRunner(provider).run(runRequest())).rejects.toThrow(
      /failed closed/u,
    );

    expect(provider.downloadedPaths).toEqual([
      "/trusted/results/request-001-ab.harbor-output.tar",
    ]);
    expect(provider.calls.at(-1)).toBe("destroy");
  });
});
