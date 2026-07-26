import { createHash } from "node:crypto";
import { canonicalHash } from "../schemas/canonical.js";
import { CLOUD_PROVIDER_MARKER_NAMES } from "./runtime-marker.js";
import type {
  CloudProviderName,
  CloudProviderTransport,
  CloudDownloadExpectation,
  CloudSandboxProvider,
  ProviderConfiguration,
  ProviderProbeRequest,
  ProviderProbeReport,
  RemoteCommandSpec,
  RemoteExecutionReceipt,
  SandboxCreateRequest,
  SandboxLease,
  TrustedCloudArtifactRef,
} from "./types.js";

const SAFE_REMOTE_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const SAFE_DOMAIN =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u;
const SAFE_ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const SECRET_LIKE_NAME = /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/u;
const SAFE_EXECUTABLE = /^(?:\/[A-Za-z0-9._/-]+|[A-Za-z0-9._-]+)$/u;
const SAFE_IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,446}@sha256:[a-f0-9]{64}$/u;
const SAFE_MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u;
const MAXIMUM_SANDBOX_LIFETIME_MS = 24 * 60 * 60_000;
const MAXIMUM_DOWNLOAD_BYTES = 16 * 1024 * 1024 * 1024;

export class CloudProviderContractError extends Error {
  override readonly name = "CloudProviderContractError";
}

export interface ConfiguredCloudSandboxProviderOptions {
  readonly now?: () => Date;
  readonly maximumClockSkewMs?: number;
}

interface ActiveLeaseRecord {
  readonly leaseHash: string;
  readonly request: SandboxCreateRequest;
}

function assertLease(provider: CloudProviderName, lease: SandboxLease): void {
  if (
    lease.provider !== provider ||
    lease.marker.provider !== provider ||
    lease.marker.sandboxId !== lease.sandboxId ||
    !SAFE_IMAGE_REFERENCE.test(lease.imageReference) ||
    !lease.imageReference.endsWith(`@${lease.imageDigest}`) ||
    !CLOUD_PROVIDER_MARKER_NAMES[provider].includes(
      lease.marker.markerEnvironmentName,
    ) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(lease.sandboxId) ||
    !Number.isFinite(Date.parse(lease.createdAt)) ||
    !Number.isFinite(Date.parse(lease.expiresAt)) ||
    Date.parse(lease.expiresAt) <= Date.parse(lease.createdAt)
  ) {
    throw new CloudProviderContractError("Sandbox lease does not belong to this provider.");
  }
}

function assertRemotePath(remotePath: string): void {
  if (!SAFE_REMOTE_PATH.test(remotePath) || remotePath.includes("/../")) {
    throw new CloudProviderContractError("Remote path must be absolute and traversal-free.");
  }
}

function assertDownloadExpectation(
  expectation: CloudDownloadExpectation,
): void {
  if (
    !SAFE_MEDIA_TYPE.test(expectation.mediaType) ||
    !Number.isSafeInteger(expectation.maximumByteLength) ||
    expectation.maximumByteLength <= 0 ||
    expectation.maximumByteLength > MAXIMUM_DOWNLOAD_BYTES
  ) {
    throw new CloudProviderContractError(
      "Cloud download expectation must declare a safe media type and bounded size.",
    );
  }
}

function assertSecretReferences(
  references: readonly {
    readonly sourceEnvironmentName: string;
    readonly targetEnvironmentName: string;
  }[],
): void {
  const targetNames = new Set<string>();
  const sourceTargetPairs = new Set<string>();
  for (const binding of references) {
    const pair = `${binding.sourceEnvironmentName}\u0000${binding.targetEnvironmentName}`;
    if (
      !SAFE_ENVIRONMENT_NAME.test(binding.sourceEnvironmentName) ||
      !SAFE_ENVIRONMENT_NAME.test(binding.targetEnvironmentName) ||
      binding.targetEnvironmentName === "PATH" ||
      targetNames.has(binding.targetEnvironmentName) ||
      sourceTargetPairs.has(pair)
    ) {
      throw new CloudProviderContractError(
        "Secret references must use unique safe environment names and cannot replace PATH.",
      );
    }
    targetNames.add(binding.targetEnvironmentName);
    sourceTargetPairs.add(pair);
  }
}

function sameResources(
  left: SandboxCreateRequest["resources"],
  right: SandboxLease["resources"],
): boolean {
  return (
    left.architecture === right.architecture &&
    left.cpuCores === right.cpuCores &&
    left.memoryMiB === right.memoryMiB &&
    left.diskMiB === right.diskMiB &&
    left.gpuClass === right.gpuClass
  );
}

function leaseFingerprint(lease: SandboxLease): string {
  return canonicalHash({
    provider: lease.provider,
    sandboxId: lease.sandboxId,
    createdAt: lease.createdAt,
    expiresAt: lease.expiresAt,
    imageDigest: lease.imageDigest,
    imageReference: lease.imageReference,
    regionClass: lease.regionClass,
    resources: {
      architecture: lease.resources.architecture,
      cpuCores: lease.resources.cpuCores,
      memoryMiB: lease.resources.memoryMiB,
      diskMiB: lease.resources.diskMiB,
      gpuClass: lease.resources.gpuClass ?? null,
    },
    networkPolicyHash: lease.networkPolicyHash,
    marker: lease.marker,
  });
}

function assertRequest(provider: CloudProviderName, request: SandboxCreateRequest): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(request.imageDigest)) {
    throw new CloudProviderContractError("Sandbox images must be pinned by sha256 digest.");
  }
  if (
    !SAFE_IMAGE_REFERENCE.test(request.imageReference) ||
    !request.imageReference.endsWith(`@${request.imageDigest}`)
  ) {
    throw new CloudProviderContractError(
      "Sandbox image reference must be an immutable OCI digest reference.",
    );
  }
  if (request.network.defaultAction !== "deny") {
    throw new CloudProviderContractError("Sandbox network policy must fail closed.");
  }
  if (
    request.network.allowDomains.some(
      (domain) =>
        !SAFE_DOMAIN.test(domain) ||
        domain.toLowerCase() === "localhost" ||
        /^\d+(?:\.\d+){3}$/u.test(domain),
    )
  ) {
    throw new CloudProviderContractError(
      "Sandbox network allowlist must contain explicit public DNS names.",
    );
  }
  if (
    request.lifetimeMs <= 0 ||
    request.lifetimeMs > MAXIMUM_SANDBOX_LIFETIME_MS ||
    !Number.isSafeInteger(request.lifetimeMs)
  ) {
    throw new CloudProviderContractError(
      "Sandbox lifetime must be a bounded positive integer.",
    );
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.requestId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.regionClass) ||
    !new Set(["arm64", "x86_64"]).has(request.resources.architecture) ||
    !Number.isSafeInteger(request.resources.cpuCores) ||
    request.resources.cpuCores <= 0 ||
    !Number.isSafeInteger(request.resources.memoryMiB) ||
    request.resources.memoryMiB <= 0 ||
    !Number.isSafeInteger(request.resources.diskMiB) ||
    request.resources.diskMiB <= 0 ||
    (request.resources.gpuClass !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.resources.gpuClass))
  ) {
    throw new CloudProviderContractError("Sandbox identity or resources are invalid.");
  }
  assertSecretReferences(request.secretReferences);
  if (provider.length === 0) {
    throw new CloudProviderContractError("Cloud provider is required.");
  }
}

export class ConfiguredCloudSandboxProvider implements CloudSandboxProvider {
  readonly name: CloudProviderName;
  readonly configuration: ProviderConfiguration;
  readonly #transport: CloudProviderTransport;
  readonly #now: () => Date;
  readonly #maximumClockSkewMs: number;
  readonly #activeLeases = new Map<string, ActiveLeaseRecord>();
  readonly #destroyedLeaseHashes = new Set<string>();
  readonly #consumedRequestIds = new Set<string>();

  constructor(
    name: CloudProviderName,
    configuration: ProviderConfiguration,
    transport: CloudProviderTransport,
    options: ConfiguredCloudSandboxProviderOptions = {},
  ) {
    if (configuration.provider !== name) {
      throw new CloudProviderContractError("Provider configuration kind does not match adapter.");
    }
    this.name = name;
    this.configuration = configuration;
    this.#transport = transport;
    this.#now = options.now ?? (() => new Date());
    this.#maximumClockSkewMs = options.maximumClockSkewMs ?? 5 * 60_000;
    if (
      !Number.isSafeInteger(this.#maximumClockSkewMs) ||
      this.#maximumClockSkewMs < 0 ||
      this.#maximumClockSkewMs > 30 * 60_000
    ) {
      throw new CloudProviderContractError("Cloud lease clock skew is outside policy.");
    }
  }

  probe(request: ProviderProbeRequest): Promise<ProviderProbeReport> {
    return this.#transport.probe(this.configuration, request);
  }

  async create(request: SandboxCreateRequest): Promise<SandboxLease> {
    assertRequest(this.name, request);
    if (this.#consumedRequestIds.has(request.requestId)) {
      throw new CloudProviderContractError(
        "A cloud sandbox request identifier is one-use.",
      );
    }
    this.#consumedRequestIds.add(request.requestId);
    const lease = await this.#transport.create(this.configuration, request);
    try {
      assertLease(this.name, lease);
      const now = this.#now().getTime();
      const createdAt = Date.parse(lease.createdAt);
      const expiresAt = Date.parse(lease.expiresAt);
      if (
        lease.imageDigest !== request.imageDigest ||
        lease.imageReference !== request.imageReference ||
        lease.regionClass !== request.regionClass ||
        lease.networkPolicyHash !== hashNetworkPolicy(request.network) ||
        !sameResources(request.resources, lease.resources) ||
        createdAt > now + this.#maximumClockSkewMs ||
        expiresAt <= now ||
        expiresAt >
          createdAt + request.lifetimeMs + this.#maximumClockSkewMs ||
        this.#activeLeases.has(lease.sandboxId)
      ) {
        throw new CloudProviderContractError(
          "Provisioned sandbox does not attest the requested immutable profile.",
        );
      }
    } catch (error) {
      await this.#bestEffortDestroyRejectedLease(lease);
      throw error;
    }
    this.#activeLeases.set(lease.sandboxId, {
      leaseHash: leaseFingerprint(lease),
      request: structuredClone(request),
    });
    return lease;
  }

  async execute(
    lease: SandboxLease,
    command: RemoteCommandSpec,
  ): Promise<RemoteExecutionReceipt> {
    const active = this.#requireActiveLease(lease);
    const now = this.#now().getTime();
    if (
      command.timeoutMs <= 0 ||
      !Number.isSafeInteger(command.timeoutMs) ||
      !command.workingDirectory.startsWith("/") ||
      command.workingDirectory.includes("/../") ||
      !SAFE_EXECUTABLE.test(command.executable) ||
      command.executable.includes("/../") ||
      (command.executionId !== undefined &&
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(
          command.executionId,
        )) ||
      command.arguments.some((argument) => /[\u0000\r\n]/u.test(argument))
    ) {
      throw new CloudProviderContractError("Remote command specification is invalid.");
    }
    if (
      command.timeoutMs >
      Date.parse(lease.expiresAt) - now + this.#maximumClockSkewMs
    ) {
      throw new CloudProviderContractError(
        "Remote command timeout exceeds the remaining sandbox lease.",
      );
    }
    for (const [name, value] of Object.entries(command.environment)) {
      if (
        !SAFE_ENVIRONMENT_NAME.test(name) ||
        SECRET_LIKE_NAME.test(name) ||
        /[\u0000\r\n]/u.test(value) ||
        active.request.secretReferences.some(
          (binding) => binding.targetEnvironmentName === name,
        )
      ) {
        throw new CloudProviderContractError(
          "Plain remote environment is malformed or contains a secret-like field.",
        );
      }
    }
    assertSecretReferences(command.secretReferences);
    const allowedSecretBindings = new Set(
      active.request.secretReferences.map(
        (binding) =>
          `${binding.sourceEnvironmentName}\u0000${binding.targetEnvironmentName}`,
      ),
    );
    if (
      command.secretReferences.some(
        (binding) =>
          !allowedSecretBindings.has(
            `${binding.sourceEnvironmentName}\u0000${binding.targetEnvironmentName}`,
          ),
      )
    ) {
      throw new CloudProviderContractError(
        "Remote command requested a secret outside its sandbox grant.",
      );
    }
    if (
      command.stdinArtifact !== undefined
    ) {
      assertArtifact(command.stdinArtifact);
    }
    const receipt = await this.#transport.execute(this.configuration, lease, command);
    const startedAt = Date.parse(receipt.startedAt);
    const finishedAt = Date.parse(receipt.finishedAt);
    if (
      receipt.provider !== this.name ||
      receipt.sandboxId !== lease.sandboxId ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(
        receipt.executionId,
      ) ||
      (command.executionId !== undefined &&
        receipt.executionId !== command.executionId) ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(finishedAt) ||
      finishedAt < startedAt ||
      startedAt < Date.parse(lease.createdAt) - this.#maximumClockSkewMs ||
      finishedAt > Date.parse(lease.expiresAt) + this.#maximumClockSkewMs ||
      (receipt.exitCode !== null && !Number.isSafeInteger(receipt.exitCode)) ||
      ((receipt.timedOut || receipt.cancelled) && receipt.exitCode !== null) ||
      (!receipt.timedOut && !receipt.cancelled && receipt.exitCode === null) ||
      !Number.isSafeInteger(receipt.resourceReport.peakMemoryMiB) ||
      receipt.resourceReport.peakMemoryMiB < 0 ||
      !Number.isSafeInteger(receipt.resourceReport.cpuTimeMs) ||
      receipt.resourceReport.cpuTimeMs < 0
    ) {
      throw new CloudProviderContractError("Execution receipt does not match its sandbox lease.");
    }
    if (receipt.stdout !== undefined) assertArtifact(receipt.stdout);
    if (receipt.stderr !== undefined) assertArtifact(receipt.stderr);
    return receipt;
  }

  async upload(
    lease: SandboxLease,
    artifact: TrustedCloudArtifactRef,
    remotePath: string,
  ): Promise<void> {
    this.#requireActiveLease(lease);
    assertRemotePath(remotePath);
    assertArtifact(artifact);
    await this.#transport.upload(this.configuration, lease, artifact, remotePath);
  }

  async download(
    lease: SandboxLease,
    remotePath: string,
    expectation: CloudDownloadExpectation,
  ): Promise<TrustedCloudArtifactRef> {
    this.#requireActiveLease(lease);
    assertRemotePath(remotePath);
    assertDownloadExpectation(expectation);
    const artifact = await this.#transport.download(
      this.configuration,
      lease,
      remotePath,
      expectation,
    );
    assertArtifact(artifact);
    if (
      artifact.mediaType !== expectation.mediaType ||
      artifact.byteLength > expectation.maximumByteLength
    ) {
      throw new CloudProviderContractError(
        "Downloaded artifact does not match its caller-sealed metadata.",
      );
    }
    return artifact;
  }

  async cancel(lease: SandboxLease, executionId: string): Promise<void> {
    this.#requireActiveLease(lease);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(executionId)) {
      throw new CloudProviderContractError("Execution identifier is invalid.");
    }
    await this.#transport.cancel(this.configuration, lease, executionId);
  }

  async destroy(lease: SandboxLease): Promise<void> {
    assertLease(this.name, lease);
    const leaseHash = leaseFingerprint(lease);
    if (this.#destroyedLeaseHashes.has(leaseHash)) {
      return;
    }
    this.#requireActiveLease(lease, true);
    await this.#transport.destroy(this.configuration, lease);
    this.#activeLeases.delete(lease.sandboxId);
    this.#destroyedLeaseHashes.add(leaseHash);
  }

  #requireActiveLease(
    lease: SandboxLease,
    allowExpired = false,
  ): ActiveLeaseRecord {
    assertLease(this.name, lease);
    const active = this.#activeLeases.get(lease.sandboxId);
    if (
      active === undefined ||
      active.leaseHash !== leaseFingerprint(lease)
    ) {
      throw new CloudProviderContractError(
        "Sandbox lease is unknown, mutated, or already destroyed.",
      );
    }
    if (!allowExpired && Date.parse(lease.expiresAt) <= this.#now().getTime()) {
      throw new CloudProviderContractError("Sandbox lease has expired.");
    }
    return active;
  }

  async #bestEffortDestroyRejectedLease(lease: SandboxLease): Promise<void> {
    if (
      lease !== null &&
      typeof lease === "object" &&
      lease.provider === this.name &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(lease.sandboxId) &&
      !this.#activeLeases.has(lease.sandboxId)
    ) {
      try {
        await this.#transport.destroy(this.configuration, lease);
      } catch {
        // The original attestation failure remains authoritative. Provider
        // operators can reconcile the one-use request id from their audit log.
      }
    }
  }
}

function assertArtifact(artifact: TrustedCloudArtifactRef): void {
  if (
    !/^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(artifact.uri) ||
    artifact.uri.includes("..") ||
    !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength < 0 ||
    !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(artifact.mediaType)
  ) {
    throw new CloudProviderContractError("Trusted cloud artifact reference is malformed.");
  }
}

export function hashNetworkPolicy(policy: {
  readonly defaultAction: "deny";
  readonly allowDomains: readonly string[];
}): string {
  const domains = [...new Set(policy.allowDomains.map((domain) => domain.toLowerCase()))].sort();
  return createHash("sha256")
    .update(JSON.stringify({ defaultAction: policy.defaultAction, allowDomains: domains }))
    .digest("hex");
}
