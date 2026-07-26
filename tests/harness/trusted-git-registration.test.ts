import { createHash, generateKeyPairSync } from "node:crypto";
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
  assertTrustedGitRegistrationWorkerResult,
  CLOUD_REGISTERED_PI_CANONICAL_PATH,
  createTrustedGitRegistrationAuthorizationPayload,
  createTrustedGitRegistrationSpec,
  parseTrustedGitRegistrationWorkerResult,
  TRUSTED_HARNESS_REGISTRATION_SCHEMA_VERSION,
  TRUSTED_PI_ADAPTER_EXECUTION_MODE,
  TRUSTED_PI_ADAPTER_ID,
  TRUSTED_PI_CODING_AGENT_PACKAGE_NAME,
  type TrustedGitRegistrationAttestor,
  type TrustedGitRegistrationAuthorization,
  type TrustedGitRegistrationReceipt,
  TrustedGitRegistrationRunner,
  type TrustedGitRegistrationWorkerResult,
} from "../../src/harness/git-registration.js";
import { ArtifactReadingTrustedGitRegistrationAttestor } from "../../src/harness/git-registration-attestor.js";
import {
  cloudExecutionReceiptHash,
  type PrivateGitHubOrigin,
} from "../../src/harness/trusted-git.js";
import { canonicalHash, canonicalJson, withContentHash } from "../../src/schemas/canonical.js";

const authorizationKeys = generateKeyPairSync("ed25519");
const receiptKeys = generateKeyPairSync("ed25519");

// Exact read-only observation of the operator's private Pi fork.
const observedCommit = "5bc1c2c0a6f07e00e8c240304182f213ab8d311f";
const observedTree = "73898c76210cc8b48f4ac07cc76397b6b5c00758";
const observedLock = "472f0726dc79f3b38df58d8a8bce96bf56fbf993a134b49aabc54947b8461e59";
const upstreamHead = "a".repeat(40);
const upstreamBase = "b".repeat(40);
const imageDigest = `sha256:${"c".repeat(64)}`;
const imageReference = `ghcr.io/dark-factory/git@${imageDigest}`;

const origin: PrivateGitHubOrigin = {
  host: "github.com",
  owner: "parallaxai",
  repository: "df-pi-tbench",
  credential: {
    sourceEnvironmentName: "GITHUB_PI_TOKEN",
    targetEnvironmentName: "DF_GITHUB_TOKEN",
  },
};

const workerArtifact: TrustedCloudArtifactRef = {
  uri: "trusted://git/registration-worker",
  sha256: "d".repeat(64),
  mediaType: "text/javascript",
  byteLength: 16_384,
};

const resultArtifact: TrustedCloudArtifactRef = {
  uri: "trusted://git/registration-result",
  sha256: "e".repeat(64),
  mediaType: "application/json",
  byteLength: 4_096,
};

function sandbox(
  allowDomains: readonly string[] = ["github.com", "api.github.com"],
): SandboxCreateRequest {
  return {
    requestId: "register-pi-001",
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
      allowDomains,
    },
    lifetimeMs: 30 * 60_000,
    secretReferences: [origin.credential],
  };
}

function authorization(
  mutate: (value: TrustedGitRegistrationAuthorization) => TrustedGitRegistrationAuthorization = (
    value,
  ) => value,
): TrustedGitRegistrationAuthorization {
  const payload = createTrustedGitRegistrationAuthorizationPayload({
    origin,
    expectedBranch: "main",
    expectedCommit: observedCommit,
    expectedTree: observedTree,
    expectedLockSha256: observedLock,
    expectedPackageName: TRUSTED_PI_CODING_AGENT_PACKAGE_NAME,
    expectedPackageVersion: "0.82.1",
    workerArtifact,
    issuedAt: "2026-07-26T10:00:00.000Z",
    expiresAt: "2026-07-26T11:00:00.000Z",
  });
  return mutate({
    ...payload,
    signature: createEd25519Signature(
      { ...payload },
      authorizationKeys.privateKey,
      "git-registration-authorization-key-001",
      "2026-07-26T10:00:01.000Z",
    ),
  });
}

function spec(authorized = authorization()) {
  return createTrustedGitRegistrationSpec({
    requestId: "register-pi-001",
    origin,
    workerArtifact,
    authorization: authorized,
  });
}

function expectedRegistrationId(): string {
  return createHash("sha256")
    .update(`${observedCommit}:${spec().originRepositoryHash}:${upstreamBase}`)
    .digest("hex");
}

function expectedLineageHash(): string {
  const currentSpec = spec();
  return canonicalHash({
    originRepositoryHash: currentSpec.originRepositoryHash,
    upstreamRepositoryHash: currentSpec.upstreamRepositoryHash,
    upstreamHeadCommit: upstreamHead,
    upstreamBaseCommit: upstreamBase,
    baselineCommit: observedCommit,
  });
}

function workerResult(authorized = authorization()): TrustedGitRegistrationWorkerResult {
  const currentSpec = spec(authorized);
  return withContentHash({
    schemaVersion: 1 as const,
    domain: "dark-factory.trusted-git-registration.v1" as const,
    authorizationHash: currentSpec.authorizationHash,
    registrationId: createHash("sha256")
      .update(`${observedCommit}:${currentSpec.originRepositoryHash}:${upstreamBase}`)
      .digest("hex"),
    originRepositoryHash: currentSpec.originRepositoryHash,
    upstreamRepositoryHash: currentSpec.upstreamRepositoryHash,
    remoteRef: "refs/heads/main",
    commitSha: observedCommit,
    treeSha: observedTree,
    lockSha256: observedLock,
    packageName: TRUSTED_PI_CODING_AGENT_PACKAGE_NAME,
    packageVersion: "0.82.1",
    harnessRegistrationSchemaVersion: TRUSTED_HARNESS_REGISTRATION_SCHEMA_VERSION,
    adapterId: TRUSTED_PI_ADAPTER_ID,
    adapterExecutionMode: TRUSTED_PI_ADAPTER_EXECUTION_MODE,
    sessionsDisabled: true as const,
    uncontrolledExtensionsDisabled: true as const,
    uncontrolledContextFilesDisabled: true as const,
    packageJsonSha256: "f".repeat(64),
    upstreamHeadCommit: upstreamHead,
    upstreamBaseCommit: upstreamBase,
    originPrivate: true as const,
    originFetchable: true as const,
    originWritable: true as const,
    privacyEvidence: "github-rest-private-and-visibility" as const,
    fetchEvidence: "authenticated-ls-remote-and-fetch" as const,
    writeEvidence: "github-rest-permissions-push" as const,
    lineageEvidence: "canonical-upstream-fetched-merge-base" as const,
    providerRepositoryAttestationHash: "1".repeat(64),
    lineageAttestationHash: canonicalHash({
      originRepositoryHash: currentSpec.originRepositoryHash,
      upstreamRepositoryHash: currentSpec.upstreamRepositoryHash,
      upstreamHeadCommit: upstreamHead,
      upstreamBaseCommit: upstreamBase,
      baselineCommit: observedCommit,
    }),
    providerVerifiedAt: "2026-07-26T10:06:30.000Z",
  });
}

class FakeProvider implements CloudSandboxProvider {
  readonly name = "daytona" as const;
  readonly configuration: ProviderConfiguration = {
    provider: "daytona",
    endpoint: "https://cloud.example.test",
    credentialEnvironmentNames: ["DAYTONA_API_KEY"],
    configFingerprint: "2".repeat(64),
  };
  readonly calls: string[] = [];
  readonly commands: RemoteCommandSpec[] = [];
  teardownFails = false;

  probe(request: ProviderProbeRequest): Promise<ProviderProbeReport> {
    this.calls.push("probe");
    return Promise.resolve({
      provider: this.name,
      requestId: request.requestId,
      checkedAt: "2026-07-26T10:05:00.000Z",
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
      sandboxId: "sandbox-registration-001",
      createdAt: "2026-07-26T10:05:00.000Z",
      expiresAt: "2026-07-26T10:35:00.000Z",
      imageReference: request.imageReference,
      imageDigest: request.imageDigest,
      regionClass: request.regionClass,
      resources: request.resources,
      networkPolicyHash: hashNetworkPolicy(request.network),
      marker: {
        provider: this.name,
        sandboxId: "sandbox-registration-001",
        markerEnvironmentName: "DAYTONA_SANDBOX_ID",
      },
    });
  }

  execute(lease: SandboxLease, command: RemoteCommandSpec): Promise<RemoteExecutionReceipt> {
    this.calls.push("execute");
    this.commands.push(structuredClone(command));
    return Promise.resolve({
      provider: this.name,
      sandboxId: lease.sandboxId,
      executionId: "registration-execution-001",
      startedAt: "2026-07-26T10:06:00.000Z",
      finishedAt: "2026-07-26T10:07:00.000Z",
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      resourceReport: {
        peakMemoryMiB: 128,
        cpuTimeMs: 1_000,
      },
    });
  }

  upload(): Promise<void> {
    this.calls.push("upload");
    return Promise.resolve();
  }

  download(): Promise<TrustedCloudArtifactRef> {
    this.calls.push("download");
    return Promise.resolve(resultArtifact);
  }

  cancel(): Promise<void> {
    this.calls.push("cancel");
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    this.calls.push("destroy");
    if (this.teardownFails) {
      return Promise.reject(new Error("provider secret detail"));
    }
    return Promise.resolve();
  }
}

function attestor(
  mutate: (receipt: TrustedGitRegistrationReceipt) => TrustedGitRegistrationReceipt = (receipt) =>
    receipt,
): TrustedGitRegistrationAttestor {
  return {
    attest(input): Promise<TrustedGitRegistrationReceipt> {
      const verified = workerResult(input.authorization);
      const body: Omit<TrustedGitRegistrationReceipt, "signature"> = {
        sensitivity: "trusted-git-registration",
        schemaVersion: 1,
        registrationRequestId: input.spec.registrationRequestId,
        authorizationHash: input.spec.authorizationHash,
        registrationId: verified.registrationId,
        originRepositoryHash: input.spec.originRepositoryHash,
        upstreamRepositoryHash: input.spec.upstreamRepositoryHash,
        remoteRef: input.spec.remoteRef,
        commitSha: input.spec.commitSha,
        treeSha: input.spec.treeSha,
        lockSha256: input.spec.lockSha256,
        packageName: input.spec.packageName,
        packageVersion: input.spec.packageVersion,
        harnessRegistrationSchemaVersion: input.spec.harnessRegistrationSchemaVersion,
        adapterId: input.spec.adapterId,
        adapterExecutionMode: input.spec.adapterExecutionMode,
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
        attestedAt: "2026-07-26T10:08:00.000Z",
        passed: true,
      };
      const receipt: TrustedGitRegistrationReceipt = {
        ...body,
        signature: createEd25519Signature(
          body,
          receiptKeys.privateKey,
          "git-registration-receipt-key-001",
          "2026-07-26T10:09:00.000Z",
        ),
      };
      return Promise.resolve(mutate(receipt));
    },
  };
}

function productionAttestor(
  authorized: TrustedGitRegistrationAuthorization,
  mutateRaw: (raw: string) => string = (raw) => raw,
): ArtifactReadingTrustedGitRegistrationAttestor {
  const raw = mutateRaw(`${canonicalJson(workerResult(authorized))}\n`);
  return new ArtifactReadingTrustedGitRegistrationAttestor({
    reader: {
      readUtf8(artifact: TrustedCloudArtifactRef, maximumBytes: number): Promise<string> {
        expect(artifact).toEqual(resultArtifact);
        expect(maximumBytes).toBe(4 * 1024 * 1024);
        return Promise.resolve(raw);
      },
    },
    signer: {
      boundary: "trusted-cloud-key-material",
      keyId: "git-registration-receipt-key-001",
      sign(body: Omit<TrustedGitRegistrationReceipt, "signature">) {
        return Promise.resolve(
          createEd25519Signature(
            body,
            receiptKeys.privateKey,
            "git-registration-receipt-key-001",
            "2026-07-26T10:09:00.000Z",
          ),
        );
      },
    },
    now: () => new Date("2026-07-26T10:08:00.000Z"),
  });
}

function runner(
  provider = new FakeProvider(),
  authorized = authorization(),
  trustedAttestor = attestor(),
): TrustedGitRegistrationRunner {
  return new TrustedGitRegistrationRunner({
    provider,
    sandbox: sandbox(),
    origin,
    workerArtifact,
    authorization: authorized,
    authorizationVerifier: {
      trustedKeyId: "git-registration-authorization-key-001",
      publicKey: authorizationKeys.publicKey,
    },
    attestor: trustedAttestor,
    receiptVerifier: {
      trustedKeyId: "git-registration-receipt-key-001",
      publicKey: receiptKeys.publicKey,
    },
    now: () => new Date("2026-07-26T10:05:00.000Z"),
  });
}

describe("trusted cloud Git registration", () => {
  it("seals the observed Pi fork and print-JSON adapter without release-sensitive fields", () => {
    const authorized = authorization();
    expect(authorized).toMatchObject({
      remoteRef: "refs/heads/main",
      commitSha: observedCommit,
      treeSha: observedTree,
      lockSha256: observedLock,
      packageName: "@earendil-works/pi-coding-agent",
      packageVersion: "0.82.1",
      harnessRegistrationSchemaVersion: "1.2.0",
      adapterId: "harbor-pi-print-json",
      adapterExecutionMode: "print-json",
      sessionsDisabled: true,
      uncontrolledExtensionsDisabled: true,
      uncontrolledContextFilesDisabled: true,
    });
    const released = JSON.stringify(authorized);
    expect(released).not.toContain(origin.owner);
    expect(released).not.toContain(origin.repository);
    expect(released).not.toContain("https://");
    expect(released).not.toContain(origin.credential.sourceEnvironmentName);
    expect(released).not.toContain(origin.credential.targetEnvironmentName);
  });

  it("accepts only canonical worker evidence for the exact signed authorization", () => {
    const authorized = authorization();
    const currentSpec = spec(authorized);
    const result = workerResult(authorized);
    expect(() =>
      assertTrustedGitRegistrationWorkerResult(result, {
        authorization: authorized,
        spec: currentSpec,
      }),
    ).not.toThrow();
    expect(
      parseTrustedGitRegistrationWorkerResult(`${canonicalJson(result)}\n`, {
        authorization: authorized,
        spec: currentSpec,
      }),
    ).toEqual(result);
    expect(() =>
      parseTrustedGitRegistrationWorkerResult(JSON.stringify(result, null, 2), {
        authorization: authorized,
        spec: currentSpec,
      }),
    ).toThrow(/canonical/u);
    expect(() =>
      assertTrustedGitRegistrationWorkerResult(
        { ...result, originPrivate: false },
        { authorization: authorized, spec: currentSpec },
      ),
    ).toThrow(/private fork/u);
    expect(() =>
      assertTrustedGitRegistrationWorkerResult(
        { ...result, adapterId: "other-adapter" },
        { authorization: authorized, spec: currentSpec },
      ),
    ).toThrow(/private fork/u);
    expect(() =>
      assertTrustedGitRegistrationWorkerResult(
        { ...result, unexpected: true },
        { authorization: authorized, spec: currentSpec },
      ),
    ).toThrow(/non-canonical/u);
  });

  it("returns a signed receipt and a downstream-compatible cloud registration", async () => {
    const provider = new FakeProvider();
    const result = await runner(provider).run();
    expect(provider.calls).toEqual(["probe", "create", "upload", "execute", "download", "destroy"]);
    expect(provider.commands).toHaveLength(1);
    expect(provider.commands[0]?.arguments).toContain(observedCommit);
    expect(provider.commands[0]?.arguments).toContain("0.82.1");
    expect(provider.commands[0]?.arguments).toContain("1.2.0");
    expect(provider.commands[0]?.arguments).toContain("harbor-pi-print-json");
    expect(result.receipt.registrationId).toBe(expectedRegistrationId());
    expect(result.receipt.lineageAttestationHash).toBe(expectedLineageHash());
    expect(result.registration).toMatchObject({
      registrationId: expectedRegistrationId(),
      canonicalPath: CLOUD_REGISTERED_PI_CANONICAL_PATH,
      branch: "main",
      headCommit: observedCommit,
      treeSha: observedTree,
      lockSha256: observedLock,
      upstreamBaseCommit: upstreamBase,
      originVerification: {
        private: true,
        fetchable: true,
        writable: true,
      },
      upstreamVerification: {
        fetchable: true,
        upstreamHeadCommit: upstreamHead,
        mergeBaseCommit: upstreamBase,
      },
    });
    const released = JSON.stringify(result);
    expect(released).not.toContain(origin.owner);
    expect(released).not.toContain(origin.repository);
    expect(released).not.toContain("https://");
    expect(released).not.toContain("GITHUB_PI_TOKEN");
    expect(released).not.toContain("DF_GITHUB_TOKEN");
  });

  it("reads and validates the exact worker artifact before cloud signing", async () => {
    const authorized = authorization();
    const result = await runner(
      new FakeProvider(),
      authorized,
      productionAttestor(authorized),
    ).run();

    expect(result.receipt).toMatchObject({
      registrationId: expectedRegistrationId(),
      commitSha: observedCommit,
      treeSha: observedTree,
      packageVersion: "0.82.1",
      resultArtifactSha256: resultArtifact.sha256,
      passed: true,
    });

    await expect(
      runner(
        new FakeProvider(),
        authorized,
        productionAttestor(authorized, (raw) => raw.replace(observedTree, "9".repeat(40))),
      ).run(),
    ).rejects.toThrow(/failed closed/u);
  });

  it("rejects a sandbox that cannot reach the provider privacy API", () => {
    expect(
      () =>
        new TrustedGitRegistrationRunner({
          provider: new FakeProvider(),
          sandbox: sandbox(["github.com"]),
          origin,
          workerArtifact,
          authorization: authorization(),
          authorizationVerifier: {
            trustedKeyId: "git-registration-authorization-key-001",
            publicKey: authorizationKeys.publicKey,
          },
          attestor: attestor(),
          receiptVerifier: {
            trustedKeyId: "git-registration-receipt-key-001",
            publicKey: receiptKeys.publicKey,
          },
          now: () => new Date("2026-07-26T10:05:00.000Z"),
        }),
    ).toThrow(/GitHub grants/u);
  });

  it("fails closed on receipt mutation and teardown failure", async () => {
    await expect(
      runner(
        new FakeProvider(),
        authorization(),
        attestor((receipt) => ({
          ...receipt,
          packageVersion: "0.82.2",
        })),
      ).run(),
    ).rejects.toThrow(/failed closed/u);

    const provider = new FakeProvider();
    provider.teardownFails = true;
    await expect(runner(provider).run()).rejects.toThrow(/teardown/u);
  });
});
