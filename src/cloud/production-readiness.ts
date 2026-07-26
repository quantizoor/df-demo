import { createHash } from "node:crypto";

import type { ImmutableCloudImage } from "../config/environment.js";
import { canonicalHash } from "../schemas/canonical.js";
import { requireCompatibleProvider } from "./probe.js";
import type {
  CloudResourceSpec,
  CloudSandboxProvider,
  RemoteExecutionReceipt,
  SandboxLease,
} from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface ProductionProviderReadinessInput {
  readonly provider: CloudSandboxProvider;
  readonly campaignId: string;
  readonly regionClass: string;
  readonly buildImage: ImmutableCloudImage;
  readonly evaluatorImage: ImmutableCloudImage;
  readonly volumeSemanticsReceiptHash: string;
  readonly volumeSemanticsArtifactSha256: string;
}

export interface ProductionProviderReadinessReceipt {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.production-provider-readiness.v1";
  readonly provider: CloudSandboxProvider["name"];
  readonly regionClass: string;
  readonly buildImageDigest: string;
  readonly evaluatorImageDigest: string;
  readonly buildCapabilityHash: string;
  readonly evaluatorCapabilityHash: string;
  readonly buildSandboxHash: string;
  readonly evaluatorSandboxHash: string;
  readonly evaluatorDockerCommandHash: string;
  readonly evaluatorDockerExecutionHash: string;
  readonly resourceHash: string;
  readonly buildNetworkPolicyHash: string;
  readonly evaluatorNetworkPolicyHash: string;
  readonly dockerInDockerVerified: true;
  readonly volumeSemanticsReceiptHash: string;
  readonly volumeSemanticsArtifactSha256: string;
  readonly receiptHash: string;
}

export class ProductionProviderReadinessError extends Error {
  override readonly name = "ProductionProviderReadinessError";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readinessResources(): CloudResourceSpec {
  return {
    architecture: "x86_64",
    cpuCores: 2,
    memoryMiB: 4 * 1024,
    diskMiB: 20 * 1024,
  };
}

function assertDigest(value: string, label: string): void {
  if (!SHA256.test(value)) {
    throw new ProductionProviderReadinessError(`${label} is not a SHA-256 digest.`);
  }
}

function sandboxHash(lease: SandboxLease): string {
  return canonicalHash({
    provider: lease.provider,
    sandboxIdHash: sha256(lease.sandboxId),
    imageDigest: lease.imageDigest,
    regionClass: lease.regionClass,
    resources: lease.resources,
    networkPolicyHash: lease.networkPolicyHash,
  });
}

function executionHash(execution: RemoteExecutionReceipt): string {
  return canonicalHash({
    provider: execution.provider,
    sandboxIdHash: sha256(execution.sandboxId),
    executionIdHash: sha256(execution.executionId),
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    cancelled: execution.cancelled,
    stdoutArtifactHash: execution.stdout === undefined ? null : canonicalHash(execution.stdout),
    stderrArtifactHash: execution.stderr === undefined ? null : canonicalHash(execution.stderr),
    resourceReport: execution.resourceReport,
  });
}

async function destroyLeases(
  provider: CloudSandboxProvider,
  leases: readonly (SandboxLease | undefined)[],
): Promise<void> {
  let firstError: unknown;
  for (const lease of [...leases].reverse()) {
    if (lease === undefined) continue;
    try {
      await provider.destroy(lease);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

/**
 * Proves the two cloud roles needed before a paid campaign starts. Capability
 * metadata is necessary but not sufficient for Terminal-Bench: the evaluator
 * image must also start Docker successfully inside a real evaluator lease.
 */
export async function runProductionProviderReadiness(
  input: ProductionProviderReadinessInput,
): Promise<ProductionProviderReadinessReceipt> {
  assertDigest(input.volumeSemanticsReceiptHash, "Volume-semantics receipt hash");
  assertDigest(input.volumeSemanticsArtifactSha256, "Volume-semantics artifact hash");
  const resources = readinessResources();
  const campaignHash = sha256(input.campaignId).slice(0, 24);
  const buildRequestId = `control-build-${campaignHash}`;
  const evaluatorRequestId = `control-evaluator-${campaignHash}`;
  const buildReport = await requireCompatibleProvider(input.provider, {
    requestId: `probe-${buildRequestId}`,
    imageDigest: input.buildImage.digest,
    regionClass: input.regionClass,
    resources,
    requireDockerInDocker: false,
    requireGpu: false,
  });
  const evaluatorReport = await requireCompatibleProvider(input.provider, {
    requestId: `probe-${evaluatorRequestId}`,
    imageDigest: input.evaluatorImage.digest,
    regionClass: input.regionClass,
    resources,
    requireDockerInDocker: true,
    requireGpu: false,
  });

  let buildLease: SandboxLease | undefined;
  let evaluatorLease: SandboxLease | undefined;
  let receipt: ProductionProviderReadinessReceipt | undefined;
  let primaryError: { readonly error: unknown } | undefined;
  let destroyError: { readonly error: unknown } | undefined;
  try {
    buildLease = await input.provider.create({
      requestId: buildRequestId,
      imageReference: input.buildImage.reference,
      imageDigest: input.buildImage.digest,
      regionClass: input.regionClass,
      resources,
      network: { defaultAction: "deny", allowDomains: [] },
      lifetimeMs: 10 * 60_000,
      secretReferences: [],
    });
    evaluatorLease = await input.provider.create({
      requestId: evaluatorRequestId,
      imageReference: input.evaluatorImage.reference,
      imageDigest: input.evaluatorImage.digest,
      regionClass: input.regionClass,
      resources,
      network: { defaultAction: "deny", allowDomains: [] },
      lifetimeMs: 10 * 60_000,
      secretReferences: [],
    });
    const dockerCommand = {
      executionId: `dind-${campaignHash}`,
      executable: "docker",
      arguments: ["info", "--format", "{{json .ServerVersion}}"],
      workingDirectory: "/workspace",
      timeoutMs: 60_000,
      environment: {},
      secretReferences: [],
    } as const;
    const dockerExecution = await input.provider.execute(evaluatorLease, dockerCommand);
    if (dockerExecution.exitCode !== 0 || dockerExecution.timedOut || dockerExecution.cancelled) {
      throw new ProductionProviderReadinessError(
        "Evaluator image did not prove a working nested Docker daemon.",
      );
    }
    const unsigned = {
      schemaVersion: 1 as const,
      domain: "dark-factory.production-provider-readiness.v1" as const,
      provider: input.provider.name,
      regionClass: input.regionClass,
      buildImageDigest: buildLease.imageDigest,
      evaluatorImageDigest: evaluatorLease.imageDigest,
      buildCapabilityHash: canonicalHash(buildReport.capabilities),
      evaluatorCapabilityHash: canonicalHash(evaluatorReport.capabilities),
      buildSandboxHash: sandboxHash(buildLease),
      evaluatorSandboxHash: sandboxHash(evaluatorLease),
      evaluatorDockerCommandHash: canonicalHash(dockerCommand),
      evaluatorDockerExecutionHash: executionHash(dockerExecution),
      resourceHash: canonicalHash(resources),
      buildNetworkPolicyHash: buildLease.networkPolicyHash,
      evaluatorNetworkPolicyHash: evaluatorLease.networkPolicyHash,
      dockerInDockerVerified: true as const,
      volumeSemanticsReceiptHash: input.volumeSemanticsReceiptHash,
      volumeSemanticsArtifactSha256: input.volumeSemanticsArtifactSha256,
    };
    receipt = {
      ...unsigned,
      receiptHash: canonicalHash(unsigned),
    };
  } catch (error) {
    primaryError = { error };
  } finally {
    try {
      await destroyLeases(input.provider, [buildLease, evaluatorLease]);
    } catch (error) {
      destroyError = { error };
    }
  }
  if (destroyError !== undefined) {
    if (primaryError === undefined) throw destroyError.error;
    throw new AggregateError(
      [primaryError.error, destroyError.error],
      "Provider readiness failed and its sandbox teardown also failed.",
    );
  }
  if (primaryError !== undefined) throw primaryError.error;
  if (receipt === undefined) {
    throw new ProductionProviderReadinessError(
      "Provider readiness completed without an attested receipt.",
    );
  }
  return receipt;
}
