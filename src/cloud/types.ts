export type CloudProviderName = "daytona" | "e2b" | "modal";

export type CpuArchitecture = "arm64" | "x86_64";

export interface CloudResourceSpec {
  readonly architecture: CpuArchitecture;
  readonly cpuCores: number;
  readonly memoryMiB: number;
  readonly diskMiB: number;
  readonly gpuClass?: string;
}

export interface CloudNetworkPolicy {
  readonly defaultAction: "deny";
  readonly allowDomains: readonly string[];
}

export interface SecretReference {
  readonly sourceEnvironmentName: string;
  readonly targetEnvironmentName: string;
}

export interface SandboxCreateRequest {
  readonly requestId: string;
  /** Immutable OCI reference such as registry/repository@sha256:<digest>. */
  readonly imageReference: string;
  readonly imageDigest: string;
  readonly regionClass: string;
  readonly resources: CloudResourceSpec;
  readonly network: CloudNetworkPolicy;
  readonly lifetimeMs: number;
  readonly secretReferences: readonly SecretReference[];
}

export interface CloudExecutionMarker {
  readonly provider: CloudProviderName;
  readonly sandboxId: string;
  readonly markerEnvironmentName: string;
}

export interface SandboxLease {
  readonly provider: CloudProviderName;
  readonly sandboxId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly imageReference: string;
  readonly imageDigest: string;
  readonly regionClass: string;
  readonly resources: CloudResourceSpec;
  readonly networkPolicyHash: string;
  readonly marker: CloudExecutionMarker;
}

export interface RemoteCommandSpec {
  /**
   * Optional presealed identifier. Set this when the caller may need to cancel
   * the execution while execute() is still pending.
   */
  readonly executionId?: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly timeoutMs: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly secretReferences: readonly SecretReference[];
  readonly stdinArtifact?: TrustedCloudArtifactRef;
}

export interface TrustedCloudArtifactRef {
  readonly uri: `trusted://${string}`;
  readonly sha256: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

export interface CloudDownloadExpectation {
  /**
   * Caller-sealed semantic type. Cloud file APIs expose bytes, not trustworthy
   * content-type metadata, so the producer/consumer protocol must declare it.
   */
  readonly mediaType: string;
  /**
   * Hard streaming limit applied before the artifact is committed to trusted
   * storage. Post-download validation remains a second line of defence.
   */
  readonly maximumByteLength: number;
}

export interface RemoteExecutionReceipt {
  readonly provider: CloudProviderName;
  readonly sandboxId: string;
  readonly executionId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdout?: TrustedCloudArtifactRef;
  readonly stderr?: TrustedCloudArtifactRef;
  readonly resourceReport: {
    readonly peakMemoryMiB: number;
    readonly cpuTimeMs: number;
  };
}

export interface ProviderCapabilities {
  readonly lifecycle: boolean;
  readonly cancellation: boolean;
  readonly fileTransfer: boolean;
  readonly hardTimeout: boolean;
  readonly resourceReporting: boolean;
  readonly networkDenyAll: boolean;
  readonly kernelIsolation: boolean;
  readonly dockerInDocker: boolean;
  readonly gpu: boolean;
}

export interface ProviderProbeRequest {
  readonly requestId: string;
  readonly imageDigest: string;
  readonly regionClass: string;
  readonly resources: CloudResourceSpec;
  readonly requireDockerInDocker: boolean;
  readonly requireGpu: boolean;
}

export interface ProviderProbeReport {
  readonly provider: CloudProviderName;
  readonly requestId: string;
  readonly checkedAt: string;
  readonly configFingerprint: string;
  readonly capabilities: ProviderCapabilities;
  readonly compatible: boolean;
  readonly reasons: readonly string[];
}

export interface ProviderConfiguration {
  readonly provider: CloudProviderName;
  readonly endpoint: string;
  readonly credentialEnvironmentNames: readonly string[];
  readonly target?: string;
  readonly configFingerprint: string;
}

export interface CloudProviderTransport {
  probe(
    configuration: ProviderConfiguration,
    request: ProviderProbeRequest,
  ): Promise<ProviderProbeReport>;
  create(
    configuration: ProviderConfiguration,
    request: SandboxCreateRequest,
  ): Promise<SandboxLease>;
  execute(
    configuration: ProviderConfiguration,
    lease: SandboxLease,
    command: RemoteCommandSpec,
  ): Promise<RemoteExecutionReceipt>;
  upload(
    configuration: ProviderConfiguration,
    lease: SandboxLease,
    artifact: TrustedCloudArtifactRef,
    remotePath: string,
  ): Promise<void>;
  download(
    configuration: ProviderConfiguration,
    lease: SandboxLease,
    remotePath: string,
    expectation: CloudDownloadExpectation,
  ): Promise<TrustedCloudArtifactRef>;
  cancel(
    configuration: ProviderConfiguration,
    lease: SandboxLease,
    executionId: string,
  ): Promise<void>;
  destroy(configuration: ProviderConfiguration, lease: SandboxLease): Promise<void>;
}

export interface CloudSandboxProvider {
  readonly name: CloudProviderName;
  readonly configuration: ProviderConfiguration;
  probe(request: ProviderProbeRequest): Promise<ProviderProbeReport>;
  create(request: SandboxCreateRequest): Promise<SandboxLease>;
  execute(lease: SandboxLease, command: RemoteCommandSpec): Promise<RemoteExecutionReceipt>;
  upload(
    lease: SandboxLease,
    artifact: TrustedCloudArtifactRef,
    remotePath: string,
  ): Promise<void>;
  download(
    lease: SandboxLease,
    remotePath: string,
    expectation: CloudDownloadExpectation,
  ): Promise<TrustedCloudArtifactRef>;
  cancel(lease: SandboxLease, executionId: string): Promise<void>;
  destroy(lease: SandboxLease): Promise<void>;
}

export interface MatchedExecutionProfile {
  readonly provider: CloudProviderName;
  readonly imageDigest: string;
  readonly regionClass: string;
  readonly resources: CloudResourceSpec;
  readonly networkPolicyHash: string;
  readonly protocolHash: string;
}
