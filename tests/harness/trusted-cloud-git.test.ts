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
  assertTrustedGitPublicationWorkerResult,
  createTrustedGitPublicationAuthorizationPayload,
  createTrustedGitPublicationSpec,
  parseTrustedGitPublicationWorkerResult,
  TrustedGitPublicationRunner,
  type TrustedGitPublicationAttestor,
  type TrustedGitPublicationAuthorization,
  type TrustedGitPublicationReceipt,
} from "../../src/harness/git-publication.js";
import {
  assertTrustedGitSourceWorkerManifest,
  createTrustedGitSourceSnapshotSpec,
  parseTrustedGitSourceWorkerManifest,
  registeredBaselineGitSourceTarget,
  TrustedGitSourceRunner,
  type TrustedGitSourceSnapshotAttestor,
  type TrustedGitSourceSnapshotReceipt,
} from "../../src/harness/git-source.js";
import { fingerprintRemoteUrl } from "../../src/harness/git.js";
import {
  OFFICIAL_PI_UPSTREAM_URL,
  type RepositoryRegistration,
} from "../../src/harness/repository.js";
import {
  cloudExecutionReceiptHash,
  type PrivateGitHubOrigin,
} from "../../src/harness/trusted-git.js";
import { canonicalJson, withContentHash } from "../../src/schemas/canonical.js";

const sourceKeys = generateKeyPairSync("ed25519");
const authorizationKeys = generateKeyPairSync("ed25519");
const publicationKeys = generateKeyPairSync("ed25519");
const baselineCommit = "a".repeat(40);
const baselineTree = "b".repeat(40);
const candidateCommit = "c".repeat(40);
const candidateTree = "d".repeat(40);
const lockSha256 = "1".repeat(64);
const localCanonicalPath = "/Users/operator/Desktop/Repos/ParallaxAI/pi";
const imageDigest = `sha256:${"2".repeat(64)}`;
const imageReference = `ghcr.io/dark-factory/runtime@${imageDigest}`;

function artifact(
  name: string,
  hashCharacter: string,
  mediaType: string,
): TrustedCloudArtifactRef {
  return {
    uri: `trusted://git/${name}`,
    sha256: hashCharacter.repeat(64),
    mediaType,
    byteLength: 4_096,
  };
}

const workerArtifact = artifact("worker", "3", "text/javascript");
const sourceArtifact = artifact("source", "4", "application/x-tar");
const sourceManifestArtifact = artifact(
  "source-manifest",
  "5",
  "application/json",
);
const candidateBundle = artifact(
  "candidate-bundle",
  "6",
  "application/vnd.git.bundle",
);
const publicationResultArtifact = artifact(
  "publication-result",
  "7",
  "application/json",
);

const origin: PrivateGitHubOrigin = {
  host: "github.com",
  owner: "parallaxai",
  repository: "df-pi-tbench",
  credential: {
    sourceEnvironmentName: "GITHUB_TOKEN",
    targetEnvironmentName: "DF_GITHUB_TOKEN",
  },
};

const registration: RepositoryRegistration = {
  registrationId: "8".repeat(64),
  canonicalPath: localCanonicalPath,
  branch: "main",
  headCommit: baselineCommit,
  treeSha: baselineTree,
  lockSha256,
  upstreamBaseCommit: "9".repeat(40),
  originFingerprint: fingerprintRemoteUrl(
    "git@github.com:parallaxai/df-pi-tbench.git",
  ),
  upstreamFingerprint: fingerprintRemoteUrl(OFFICIAL_PI_UPSTREAM_URL),
  originVerification: {
    private: true,
    fetchable: true,
    writable: true,
    checkedAt: "2026-07-01T00:00:00.000Z",
    providerAttestationHash: "a".repeat(64),
  },
  upstreamVerification: {
    fetchable: true,
    upstreamHeadCommit: "b".repeat(40),
    mergeBaseCommit: "9".repeat(40),
    checkedAt: "2026-07-01T00:00:00.000Z",
    providerAttestationHash: "c".repeat(64),
  },
};

function sandbox(): SandboxCreateRequest {
  return {
    requestId: "git-operation-001",
    imageReference,
    imageDigest,
    regionClass: "trusted-eu",
    resources: {
      architecture: "x86_64",
      cpuCores: 2,
      memoryMiB: 4_096,
      diskMiB: 16_384,
    },
    network: {
      defaultAction: "deny",
      allowDomains: ["github.com"],
    },
    lifetimeMs: 30 * 60_000,
    secretReferences: [origin.credential],
  };
}

class FakeGitProvider implements CloudSandboxProvider {
  readonly name = "daytona" as const;
  readonly configuration: ProviderConfiguration = {
    provider: "daytona",
    endpoint: "https://cloud.example.test",
    credentialEnvironmentNames: ["DAYTONA_API_KEY"],
    configFingerprint: "d".repeat(64),
  };
  readonly calls: string[] = [];
  readonly commands: RemoteCommandSpec[] = [];
  readonly uploads: {
    readonly artifact: TrustedCloudArtifactRef;
    readonly path: string;
  }[] = [];
  readonly downloads: string[] = [];
  executionFails = false;
  teardownFails = false;

  probe(request: ProviderProbeRequest): Promise<ProviderProbeReport> {
    this.calls.push("probe");
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
      sandboxId: "sandbox-git-001",
      createdAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-07-01T00:30:00.000Z",
      imageReference: request.imageReference,
      imageDigest: request.imageDigest,
      regionClass: request.regionClass,
      resources: request.resources,
      networkPolicyHash: hashNetworkPolicy(request.network),
      marker: {
        provider: this.name,
        sandboxId: "sandbox-git-001",
        markerEnvironmentName: "DAYTONA_SANDBOX_ID",
      },
    });
  }

  execute(
    lease: SandboxLease,
    command: RemoteCommandSpec,
  ): Promise<RemoteExecutionReceipt> {
    this.calls.push("execute");
    this.commands.push(structuredClone(command));
    return Promise.resolve({
      provider: this.name,
      sandboxId: lease.sandboxId,
      executionId: `git-execution-${this.commands.length}`,
      startedAt: "2026-07-01T00:01:00.000Z",
      finishedAt: "2026-07-01T00:02:00.000Z",
      exitCode: this.executionFails ? 1 : 0,
      timedOut: false,
      cancelled: false,
      resourceReport: {
        peakMemoryMiB: 128,
        cpuTimeMs: 10,
      },
    });
  }

  upload(
    _lease: SandboxLease,
    uploadedArtifact: TrustedCloudArtifactRef,
    remotePath: string,
  ): Promise<void> {
    this.calls.push("upload");
    this.uploads.push({
      artifact: structuredClone(uploadedArtifact),
      path: remotePath,
    });
    return Promise.resolve();
  }

  download(
    _lease: SandboxLease,
    remotePath: string,
  ): Promise<TrustedCloudArtifactRef> {
    this.calls.push("download");
    this.downloads.push(remotePath);
    if (remotePath.endsWith("candidate-source.tar")) {
      return Promise.resolve(sourceArtifact);
    }
    if (remotePath.endsWith("source-manifest.json")) {
      return Promise.resolve(sourceManifestArtifact);
    }
    return Promise.resolve(publicationResultArtifact);
  }

  cancel(): Promise<void> {
    this.calls.push("cancel");
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    this.calls.push("destroy");
    if (this.teardownFails) {
      return Promise.reject(new Error("sensitive provider detail"));
    }
    return Promise.resolve();
  }
}

function sourceAttestor(
  mutate: (
    receipt: TrustedGitSourceSnapshotReceipt,
  ) => TrustedGitSourceSnapshotReceipt = (receipt) => receipt,
): TrustedGitSourceSnapshotAttestor {
  return {
    async attest(input) {
      const body = {
        sensitivity: "trusted-git-source-snapshot" as const,
        schemaVersion: 1 as const,
        snapshotId: input.spec.snapshotId,
        registrationId: input.spec.registrationId,
        originRepositoryHash: input.spec.originRepositoryHash,
        upstreamRepositoryHash: input.spec.upstreamRepositoryHash,
        upstreamHeadCommit: input.spec.upstreamHeadCommit,
        upstreamBaseCommit: input.spec.upstreamBaseCommit,
        baselineCommit: input.spec.baselineCommit,
        provider: input.lease.provider,
        sandboxId: input.lease.sandboxId,
        imageReference: input.lease.imageReference,
        imageDigest: input.lease.imageDigest,
        networkPolicyHash: input.lease.networkPolicyHash,
        remoteRef: input.spec.target.remoteRef,
        commitSha: input.spec.target.commitSha,
        treeSha: input.spec.target.treeSha,
        lockSha256: input.spec.target.lockSha256,
        archiveMethod: "git-archive-format-tar" as const,
        compression: "none" as const,
        workerSha256: input.spec.workerArtifact.sha256,
        executionReceiptHash: cloudExecutionReceiptHash(input.execution),
        manifestArtifactSha256: input.manifestArtifact.sha256,
        sourceArtifact: input.sourceArtifact,
        createdAt: "2026-07-01T00:03:00.000Z",
        passed: true as const,
      };
      return mutate({
        ...body,
        signature: createEd25519Signature(
          body,
          sourceKeys.privateKey,
          "trusted-git-source-key-001",
          "2026-07-01T00:04:00.000Z",
        ),
      });
    },
  };
}

function sourceRunner(
  provider: FakeGitProvider,
  attestor = sourceAttestor(),
): TrustedGitSourceRunner {
  return new TrustedGitSourceRunner({
    provider,
    sandbox: sandbox(),
    registration,
    origin,
    target: registeredBaselineGitSourceTarget(registration),
    workerArtifact,
    attestor,
    receiptVerifier: {
      trustedKeyId: "trusted-git-source-key-001",
      publicKey: sourceKeys.publicKey,
    },
  });
}

function authorization(
  mutate: (
    value: TrustedGitPublicationAuthorization,
  ) => TrustedGitPublicationAuthorization = (value) => value,
): TrustedGitPublicationAuthorization {
  const body = createTrustedGitPublicationAuthorizationPayload({
    registration,
    experimentId: "001-improve-recovery",
    baseRef: "refs/heads/main",
    baseCommit: baselineCommit,
    candidateCommit,
    candidateTree,
    lockSha256,
    candidateBundle,
    workerArtifact,
    tagTimestamp: "2026-07-01T00:05:00.000Z",
    issuedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-07-01T00:30:00.000Z",
  });
  return mutate({
    ...body,
    signature: createEd25519Signature(
      body,
      authorizationKeys.privateKey,
      "trusted-git-authorization-key-001",
      "2026-07-01T00:00:01.000Z",
    ),
  });
}

function publicationAttestor(
  mutate: (
    receipt: TrustedGitPublicationReceipt,
  ) => TrustedGitPublicationReceipt = (receipt) => receipt,
): TrustedGitPublicationAttestor {
  return {
    async attest(input) {
      const body = {
        sensitivity: "trusted-git-publication" as const,
        schemaVersion: 1 as const,
        publicationId: input.spec.publicationId,
        authorizationHash: input.spec.authorizationHash,
        registrationId: input.authorization.registrationId,
        originRepositoryHash: input.authorization.originRepositoryHash,
        upstreamRepositoryHash: input.spec.upstreamRepositoryHash,
        upstreamHeadCommit: input.spec.upstreamHeadCommit,
        upstreamBaseCommit: input.spec.upstreamBaseCommit,
        provider: input.lease.provider,
        sandboxId: input.lease.sandboxId,
        imageReference: input.lease.imageReference,
        imageDigest: input.lease.imageDigest,
        networkPolicyHash: input.lease.networkPolicyHash,
        experimentId: input.authorization.experimentId,
        baselineCommit: input.authorization.baselineCommit,
        baseRef: input.authorization.baseRef,
        baseCommit: input.authorization.baseCommit,
        candidateCommit: input.authorization.candidateCommit,
        candidateTree: input.authorization.candidateTree,
        lockSha256: input.authorization.lockSha256,
        bundleRef: input.spec.bundleRef,
        branchRef: input.authorization.branchRef,
        tagRef: input.authorization.tagRef,
        branchCommit: input.authorization.candidateCommit,
        tagObjectId: "e".repeat(40),
        tagPeeledCommit: input.authorization.candidateCommit,
        publicationMode: "atomic-non-force" as const,
        disposition: "published" as const,
        candidateBundleSha256: input.authorization.candidateBundle.sha256,
        workerSha256: input.authorization.workerSha256,
        executionReceiptHash: cloudExecutionReceiptHash(input.execution),
        resultArtifactSha256: input.resultArtifact.sha256,
        publishedAt: "2026-07-01T00:03:00.000Z",
        passed: true as const,
      };
      return mutate({
        ...body,
        signature: createEd25519Signature(
          body,
          publicationKeys.privateKey,
          "trusted-git-publication-key-001",
          "2026-07-01T00:04:00.000Z",
        ),
      });
    },
  };
}

function publicationRunner(
  provider: FakeGitProvider,
  authorized = authorization(),
  attestor = publicationAttestor(),
): TrustedGitPublicationRunner {
  return new TrustedGitPublicationRunner({
    provider,
    sandbox: sandbox(),
    registration,
    origin,
    workerArtifact,
    authorization: authorized,
    authorizationVerifier: {
      trustedKeyId: "trusted-git-authorization-key-001",
      publicKey: authorizationKeys.publicKey,
    },
    attestor,
    receiptVerifier: {
      trustedKeyId: "trusted-git-publication-key-001",
      publicKey: publicationKeys.publicKey,
    },
    now: () => new Date("2026-07-01T00:10:00.000Z"),
  });
}

describe("trusted Git worker JSON schemas", () => {
  it("accepts only content-addressed source manifests with exact lineage", () => {
    const target = registeredBaselineGitSourceTarget(registration);
    const spec = createTrustedGitSourceSnapshotSpec({
      requestId: "source-schema-001",
      registration,
      origin,
      target,
      workerArtifact,
    });
    const manifest = withContentHash({
      schemaVersion: 1,
      domain: "dark-factory.trusted-git-source.v1",
      originRepositoryHash: spec.originRepositoryHash,
      upstreamRepositoryHash: spec.upstreamRepositoryHash,
      upstreamHeadCommit: spec.upstreamHeadCommit,
      upstreamBaseCommit: spec.upstreamBaseCommit,
      baselineCommit: spec.baselineCommit,
      remoteRef: target.remoteRef,
      commitSha: target.commitSha,
      treeSha: target.treeSha,
      lockSha256: target.lockSha256,
      archiveMethod: "git-archive-format-tar",
      compression: "none",
      archiveSha256: sourceArtifact.sha256,
      archiveByteLength: sourceArtifact.byteLength,
    });
    expect(() =>
      assertTrustedGitSourceWorkerManifest(manifest, {
        spec,
        sourceArtifact,
      }),
    ).not.toThrow();
    expect(
      parseTrustedGitSourceWorkerManifest(
        `${canonicalJson(manifest)}\n`,
        { spec, sourceArtifact },
      ),
    ).toEqual(manifest);
    expect(() =>
      parseTrustedGitSourceWorkerManifest(
        JSON.stringify(manifest, null, 2),
        { spec, sourceArtifact },
      ),
    ).toThrow(/canonical/u);
    expect(() =>
      assertTrustedGitSourceWorkerManifest(
        { ...manifest, treeSha: "f".repeat(40) },
        { spec, sourceArtifact },
      ),
    ).toThrow(/manifest/u);
    expect(() =>
      assertTrustedGitSourceWorkerManifest(
        { ...manifest, unexpected: true },
        { spec, sourceArtifact },
      ),
    ).toThrow(/non-canonical/u);
  });

  it("accepts only content-addressed publication results for both exact refs", () => {
    const authorized = authorization();
    const spec = createTrustedGitPublicationSpec({
      requestId: "publication-schema-001",
      registration,
      origin,
      workerArtifact,
      authorization: authorized,
    });
    const result = withContentHash({
      schemaVersion: 1,
      domain: "dark-factory.trusted-git-publication.v1",
      originRepositoryHash: spec.originRepositoryHash,
      upstreamRepositoryHash: spec.upstreamRepositoryHash,
      upstreamHeadCommit: spec.upstreamHeadCommit,
      upstreamBaseCommit: spec.upstreamBaseCommit,
      experimentId: authorized.experimentId,
      baselineCommit: authorized.baselineCommit,
      baseRef: authorized.baseRef,
      baseCommit: authorized.baseCommit,
      candidateCommit: authorized.candidateCommit,
      candidateTree: authorized.candidateTree,
      lockSha256: authorized.lockSha256,
      candidateBundleSha256: authorized.candidateBundle.sha256,
      bundleRef: spec.bundleRef,
      branchRef: authorized.branchRef,
      tagRef: authorized.tagRef,
      branchCommit: authorized.candidateCommit,
      tagObjectId: "e".repeat(40),
      tagPeeledCommit: authorized.candidateCommit,
      publicationMode: "atomic-non-force",
      disposition: "published",
    });
    expect(() =>
      assertTrustedGitPublicationWorkerResult(result, {
        authorization: authorized,
        spec,
      }),
    ).not.toThrow();
    expect(
      parseTrustedGitPublicationWorkerResult(
        `${canonicalJson(result)}\n`,
        { authorization: authorized, spec },
      ),
    ).toEqual(result);
    expect(() =>
      assertTrustedGitPublicationWorkerResult(
        { ...result, baseRef: "refs/heads/other" },
        { authorization: authorized, spec },
      ),
    ).toThrow(/result/u);
  });
});

describe("trusted cloud Git source snapshot", () => {
  it("uses a secret reference and attests the exact uncompressed archive", async () => {
    const provider = new FakeGitProvider();
    const receipt = await sourceRunner(provider).run();
    expect(receipt).toMatchObject({
      commitSha: baselineCommit,
      treeSha: baselineTree,
      lockSha256,
      archiveMethod: "git-archive-format-tar",
      compression: "none",
      sourceArtifact,
    });
    expect(provider.uploads).toEqual([
      {
        artifact: workerArtifact,
        path: "/trusted/git/source-worker.mjs",
      },
    ]);
    expect(provider.downloads).toEqual([
      "/trusted/git/candidate-source.tar",
      "/trusted/git/source-manifest.json",
    ]);
    expect(provider.commands).toHaveLength(1);
    const command = provider.commands[0]!;
    expect(command.executable).toBe("/usr/bin/node");
    expect(command.secretReferences).toEqual([origin.credential]);
    expect(command.environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(command.arguments).toContain(baselineCommit);
    expect(command.arguments).toContain(baselineTree);
    expect(command.arguments).toContain(lockSha256);
    expect(provider.calls.at(-1)).toBe("destroy");
    expect(JSON.stringify(command)).not.toContain(localCanonicalPath);
    expect(JSON.stringify(receipt)).not.toContain("parallaxai");
    expect(JSON.stringify(receipt)).not.toContain("df-pi-tbench");
  });

  it("discards outputs after command, signature, or teardown failures", async () => {
    const failedCommand = new FakeGitProvider();
    failedCommand.executionFails = true;
    await expect(sourceRunner(failedCommand).run()).rejects.toThrow(
      "Trusted cloud Git source snapshot failed closed.",
    );
    expect(failedCommand.downloads).toEqual([]);
    expect(failedCommand.calls.at(-1)).toBe("destroy");

    const mutatedReceipt = new FakeGitProvider();
    await expect(
      sourceRunner(
        mutatedReceipt,
        sourceAttestor((receipt) => ({
          ...receipt,
          treeSha: "f".repeat(40),
        })),
      ).run(),
    ).rejects.toThrow("failed closed");
    expect(mutatedReceipt.calls.at(-1)).toBe("destroy");

    const failedTeardown = new FakeGitProvider();
    failedTeardown.teardownFails = true;
    await expect(sourceRunner(failedTeardown).run()).rejects.toThrow(
      "sandbox teardown failed",
    );
  });

  it("captures source lineage before asynchronous cloud work begins", async () => {
    const provider = new FakeGitProvider();
    const target = registeredBaselineGitSourceTarget(registration);
    const runner = new TrustedGitSourceRunner({
      provider,
      sandbox: sandbox(),
      registration,
      origin,
      target,
      workerArtifact,
      attestor: sourceAttestor(),
      receiptVerifier: {
        trustedKeyId: "trusted-git-source-key-001",
        publicKey: sourceKeys.publicKey,
      },
    });
    (target as { commitSha: string }).commitSha = "f".repeat(40);
    await expect(runner.run()).resolves.toMatchObject({
      commitSha: baselineCommit,
    });
    expect(provider.commands[0]?.arguments).toContain(baselineCommit);
    expect(provider.commands[0]?.arguments).not.toContain("f".repeat(40));
  });

  it("rejects extra network or secret grants before cloud allocation", () => {
    const provider = new FakeGitProvider();
    const widened = sandbox();
    expect(
      () =>
        new TrustedGitSourceRunner({
          provider,
          sandbox: {
            ...widened,
            network: {
              defaultAction: "deny",
              allowDomains: ["github.com", "api.github.com"],
            },
          },
          registration,
          origin,
          target: registeredBaselineGitSourceTarget(registration),
          workerArtifact,
          attestor: sourceAttestor(),
          receiptVerifier: {
            trustedKeyId: "trusted-git-source-key-001",
            publicKey: sourceKeys.publicKey,
          },
        }),
    ).toThrow(/private-origin grant/u);
    expect(provider.calls).toEqual([]);
  });
});

describe("trusted cloud Git publication", () => {
  it("publishes the sealed bundle to fixed experiment refs without force", async () => {
    const provider = new FakeGitProvider();
    const receipt = await publicationRunner(provider).run();
    expect(receipt).toMatchObject({
      experimentId: "001-improve-recovery",
      candidateCommit,
      candidateTree,
      publicationMode: "atomic-non-force",
      branchRef: "refs/heads/df/experiment/001-improve-recovery",
      tagRef: "refs/tags/df/experiment/001-improve-recovery/candidate",
    });
    expect(provider.uploads).toEqual([
      {
        artifact: workerArtifact,
        path: "/trusted/git/publication-worker.mjs",
      },
      {
        artifact: candidateBundle,
        path: "/trusted/git/candidate.bundle",
      },
    ]);
    const command = provider.commands[0]!;
    expect(command.secretReferences).toEqual([origin.credential]);
    expect(command.environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(command.arguments).toContain("atomic-non-force");
    expect(command.arguments).not.toContain("--force");
    expect(command.arguments.every((argument) => !argument.startsWith("+refs/"))).toBe(
      true,
    );
    expect(provider.calls.at(-1)).toBe("destroy");
    expect(JSON.stringify(receipt)).not.toContain("github.com");
    expect(JSON.stringify(receipt)).not.toContain("parallaxai");
    expect(JSON.stringify(receipt)).not.toContain(localCanonicalPath);
  });

  it("rejects expired or mutated authorization before creating a sandbox", () => {
    const provider = new FakeGitProvider();
    expect(() =>
      publicationRunner(
        provider,
        authorization((value) => ({
          ...value,
          candidateCommit: "f".repeat(40),
        })),
      ),
    ).toThrow(/authorization/u);
    expect(provider.calls).toEqual([]);

    expect(
      () =>
        new TrustedGitPublicationRunner({
          provider,
          sandbox: sandbox(),
          registration,
          origin,
          workerArtifact,
          authorization: authorization(),
          authorizationVerifier: {
            trustedKeyId: "trusted-git-authorization-key-001",
            publicKey: authorizationKeys.publicKey,
          },
          attestor: publicationAttestor(),
          receiptVerifier: {
            trustedKeyId: "trusted-git-publication-key-001",
            publicKey: publicationKeys.publicKey,
          },
          now: () => new Date("2026-07-01T00:31:00.000Z"),
        }),
    ).toThrow(/authorization/u);
    expect(provider.calls).toEqual([]);
  });

  it("fails closed on ref conflict, forged receipt, and teardown uncertainty", async () => {
    const conflict = new FakeGitProvider();
    conflict.executionFails = true;
    await expect(publicationRunner(conflict).run()).rejects.toThrow(
      "publication failed closed",
    );
    expect(conflict.downloads).toEqual([]);
    expect(conflict.calls.at(-1)).toBe("destroy");

    const forged = new FakeGitProvider();
    await expect(
      publicationRunner(
        forged,
        authorization(),
        publicationAttestor((receipt) => ({
          ...receipt,
          branchCommit: baselineCommit,
        })),
      ).run(),
    ).rejects.toThrow("failed closed");
    expect(forged.calls.at(-1)).toBe("destroy");

    const failedTeardown = new FakeGitProvider();
    failedTeardown.teardownFails = true;
    await expect(publicationRunner(failedTeardown).run()).rejects.toThrow(
      "sandbox teardown failed",
    );
  });

  it("captures signed publication authority against caller mutation", async () => {
    const provider = new FakeGitProvider();
    const authorized = authorization();
    const runner = publicationRunner(provider, authorized);
    (authorized as { candidateCommit: string }).candidateCommit =
      "f".repeat(40);
    await expect(runner.run()).resolves.toMatchObject({
      candidateCommit,
    });
    expect(provider.commands[0]?.arguments).toContain(candidateCommit);
    expect(provider.commands[0]?.arguments).not.toContain("f".repeat(40));
  });
});
