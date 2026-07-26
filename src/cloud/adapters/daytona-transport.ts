import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { TrustedArtifactBridge } from "../artifact-bridge.js";
import { providerCredentialValues } from "../config.js";
import { hashNetworkPolicy } from "../provider.js";
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
} from "../types.js";

const DAYTONA_SDK_VERSION = "0.200.1";
const SDK_CREATE_TIMEOUT_SECONDS = 10 * 60;
const SDK_CONTROL_TIMEOUT_SECONDS = 60;
const SDK_TERMINATION_TIMEOUT_SECONDS = 15;
const SDK_TRANSFER_TIMEOUT_SECONDS = 30 * 60;
const METRIC_POLL_INTERVAL_MS = 1_000;
const MAX_CAPTURED_LOG_BYTES = 32 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const SAFE_REMOTE_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const SAFE_MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u;
const MAXIMUM_DOWNLOAD_BYTES = 16 * 1024 * 1024 * 1024;

export class DaytonaTransportError extends Error {
  override readonly name = "DaytonaTransportError";
}

interface DaytonaMetricsLike {
  readonly timestamp: Date | string;
  readonly cpuCount: number;
  readonly cpuUsedPct: number;
  readonly memUsed: number;
  readonly memTotal: number;
  readonly diskUsed: number;
  readonly diskTotal: number;
}

interface DaytonaSessionCommandLike {
  readonly id?: string;
  readonly exitCode?: number | null;
}

interface DaytonaSessionExecuteResponseLike {
  readonly cmdId?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

interface DaytonaCommandLogsLike {
  readonly stdout?: string;
  readonly stderr?: string;
}

interface DaytonaExecuteResponseLike {
  readonly result?: string;
  readonly exitCode?: number;
  readonly artifacts?: {
    readonly stdout?: string;
  };
}

interface DaytonaFileSystemLike {
  createFolder(path: string, mode: string): Promise<void>;
  uploadFileStream(
    source: Readable,
    remotePath: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly timeout?: number;
    },
  ): Promise<void>;
  downloadFileStream(
    remotePath: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly timeout?: number;
    },
  ): Promise<AsyncIterable<Uint8Array>>;
  deleteFile(path: string): Promise<void>;
}

interface DaytonaProcessLike {
  executeCommand(
    command: string,
    cwd?: string,
    environment?: Readonly<Record<string, string>>,
    timeoutSeconds?: number,
  ): Promise<DaytonaExecuteResponseLike>;
  createSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  executeSessionCommand(
    sessionId: string,
    request: {
      readonly command: string;
      readonly runAsync: boolean;
      readonly suppressInputEcho: boolean;
    },
    timeoutSeconds?: number,
  ): Promise<DaytonaSessionExecuteResponseLike>;
  getSessionCommand(sessionId: string, commandId: string): Promise<DaytonaSessionCommandLike>;
  getSessionCommandLogs(sessionId: string, commandId: string): Promise<DaytonaCommandLogsLike>;
}

interface DaytonaSandboxLike {
  readonly id: string;
  readonly target: string;
  readonly cpu: number;
  readonly memory: number;
  readonly disk: number;
  readonly gpu: number;
  readonly public: boolean;
  readonly autoDeleteInterval?: number;
  readonly autoPauseInterval?: number;
  readonly autoStopInterval?: number;
  readonly createdAt?: string;
  readonly autoDestroyAt?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly networkBlockAll?: boolean;
  readonly domainAllowList?: string;
  readonly fs: DaytonaFileSystemLike;
  readonly process: DaytonaProcessLike;
  refreshData(): Promise<void>;
  updateEnv(
    environment: Readonly<Record<string, string>>,
    options?: { readonly unset?: readonly string[] },
  ): Promise<void>;
  updateSecrets(secrets: Readonly<Record<string, string>>): Promise<void>;
  getMetrics(start?: Date, end?: Date): Promise<readonly DaytonaMetricsLike[]>;
  getMetricsLatest(): Promise<DaytonaMetricsLike>;
  stop(timeoutSeconds?: number, force?: boolean): Promise<void>;
  delete(timeoutSeconds?: number, wait?: boolean): Promise<void>;
}

interface DaytonaCreateParameters {
  readonly image: string;
  readonly resources: {
    readonly cpu: number;
    readonly memory: number;
    readonly disk: number;
  };
  readonly ephemeral: true;
  readonly autoPauseInterval: 0;
  readonly autoStopInterval: 0;
  readonly ttlMinutes: number;
  readonly public: false;
  readonly envVars: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly networkBlockAll?: true;
  readonly domainAllowList?: string;
}

export interface DaytonaClient {
  create(
    parameters: DaytonaCreateParameters,
    options?: {
      readonly timeout?: number;
    },
  ): Promise<DaytonaSandboxLike>;
}

export interface DaytonaSdkFactory {
  createClient(configuration: ProviderConfiguration): Promise<DaytonaClient>;
}

export interface OfficialDaytonaSdkFactoryOptions {
  readonly environment?: () => NodeJS.ProcessEnv;
}

/**
 * Loads the exact pinned official SDK only at the trusted transport edge.
 * Credential values are resolved just-in-time and are never copied into a
 * sandbox create request, receipt, label, or artifact.
 */
export class OfficialDaytonaSdkFactory implements DaytonaSdkFactory {
  readonly #environment: () => NodeJS.ProcessEnv;

  constructor(options: OfficialDaytonaSdkFactoryOptions = {}) {
    this.#environment = options.environment ?? (() => process.env);
  }

  async createClient(configuration: ProviderConfiguration): Promise<DaytonaClient> {
    const credentials = providerCredentialValues(configuration, this.#environment());
    const apiKey = credentials["DAYTONA_API_KEY"];
    if (apiKey === undefined) {
      throw new DaytonaTransportError("The Daytona SDK credential binding is unavailable.");
    }
    const sdk = await import("@daytona/sdk");
    const clientConfiguration = {
      apiKey,
      apiUrl: configuration.endpoint,
      otelEnabled: false as const,
      ...(configuration.target === undefined ? {} : { target: configuration.target }),
    };
    return new sdk.Daytona(clientConfiguration) as unknown as DaytonaClient;
  }
}

export interface DaytonaCloudProviderTransportOptions {
  readonly artifactBridge: TrustedArtifactBridge;
  readonly sdkFactory?: DaytonaSdkFactory;
  readonly now?: () => Date;
}

interface ActiveSandbox {
  readonly sandbox: DaytonaSandboxLike;
  readonly request: SandboxCreateRequest;
  readonly lease: SandboxLease;
  readonly completedExecutionIds: Set<string>;
  readonly executions: Map<string, ActiveExecution>;
  destroyed: boolean;
  sequence: number;
  transferSequence: number;
}

type TerminationKind = "cancelled" | "failure" | "timed-out";

interface CapturedLogs {
  readonly stdout: string;
  readonly stderr: string;
}

interface TerminationOutcome {
  readonly kind: TerminationKind;
  readonly logs: CapturedLogs;
}

interface ActiveExecution {
  readonly executionId: string;
  readonly sessionId: string;
  readonly startedAt: Date;
  readonly samples: DaytonaMetricsLike[];
  readonly terminationSignal: Promise<TerminationOutcome>;
  readonly resolveTermination: (outcome: TerminationOutcome) => void;
  readonly rejectTermination: (error: unknown) => void;
  commandId?: string;
  terminationOperation?: Promise<TerminationOutcome>;
}

interface CompletedCommand {
  readonly kind: "completed";
  readonly exitCode: number;
  readonly logs: CapturedLogs;
}

const CAPABILITIES: ProviderCapabilities = {
  lifecycle: true,
  cancellation: true,
  fileTransfer: true,
  hardTimeout: true,
  resourceReporting: true,
  networkDenyAll: true,
  kernelIsolation: true,
  dockerInDocker: true,
  // The provider supports GPUs, but this transport cannot yet attest an exact
  // requested GPU type from the returned sandbox metadata.
  gpu: false,
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toSafeUriSegment(value: string): string {
  return sha256(value).slice(0, 40);
}

function assertDaytonaConfiguration(configuration: ProviderConfiguration): void {
  if (configuration.provider !== "daytona") {
    throw new DaytonaTransportError("Daytona transport received another provider configuration.");
  }
}

function exactResourceReasons(
  configuration: ProviderConfiguration,
  request: Pick<ProviderProbeRequest, "regionClass" | "resources">,
): string[] {
  const reasons: string[] = [];
  if (configuration.target === undefined || configuration.target !== request.regionClass) {
    reasons.push("daytona-target-does-not-exactly-match-region-class");
  }
  if (request.resources.memoryMiB % 1_024 !== 0 || request.resources.diskMiB % 1_024 !== 0) {
    reasons.push("daytona-resources-require-whole-gibibytes");
  }
  if (request.resources.gpuClass !== undefined) {
    reasons.push("daytona-exact-gpu-type-attestation-unavailable");
  }
  return reasons;
}

function assertCreateProfile(
  configuration: ProviderConfiguration,
  request: SandboxCreateRequest,
): void {
  const reasons = exactResourceReasons(configuration, request);
  if (request.lifetimeMs % 60_000 !== 0) {
    reasons.push("daytona-ttl-requires-whole-minutes");
  }
  if (reasons.length > 0) {
    throw new DaytonaTransportError(
      `Daytona cannot represent the exact sandbox profile: ${reasons.join(", ")}.`,
    );
  }
}

function secretMap(
  references: readonly {
    readonly sourceEnvironmentName: string;
    readonly targetEnvironmentName: string;
  }[],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const reference of references) {
    if (
      !SAFE_ENVIRONMENT_NAME.test(reference.sourceEnvironmentName) ||
      !SAFE_ENVIRONMENT_NAME.test(reference.targetEnvironmentName)
    ) {
      throw new DaytonaTransportError("Daytona organization-secret bindings are malformed.");
    }
    result[reference.targetEnvironmentName] = reference.sourceEnvironmentName;
  }
  return result;
}

function normalizeDomains(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [];
  return [...new Set(value.split(",").map((domain) => domain.trim().toLowerCase()))]
    .filter((domain) => domain.length > 0)
    .sort();
}

function extractCommandOutput(response: DaytonaExecuteResponseLike): string {
  const value = response.artifacts?.stdout ?? response.result;
  if (typeof value !== "string") {
    throw new DaytonaTransportError("Daytona returned a malformed command attestation.");
  }
  return value.trim();
}

function assertRemotePath(remotePath: string): void {
  if (!SAFE_REMOTE_PATH.test(remotePath) || remotePath.includes("/../")) {
    throw new DaytonaTransportError("Daytona remote path is not absolute and traversal-free.");
  }
}

/**
 * Encodes one argv element for a POSIX shell. Every value is enclosed in
 * single quotes; an embedded quote becomes the standard '\'' sequence. No
 * caller-controlled byte is ever emitted unquoted.
 */
export function quotePosixArgument(value: string): string {
  if (value.includes("\u0000")) {
    throw new DaytonaTransportError("POSIX argv cannot contain NUL bytes.");
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function encodePosixCommand(command: RemoteCommandSpec): string {
  if (
    !command.workingDirectory.startsWith("/") ||
    command.workingDirectory.includes("/../") ||
    command.executable.length === 0 ||
    command.executable.includes("\u0000") ||
    command.arguments.some((argument) => argument.includes("\u0000"))
  ) {
    throw new DaytonaTransportError("Daytona command cannot be encoded safely.");
  }
  const environment = Object.entries(command.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (
        !SAFE_ENVIRONMENT_NAME.test(name) ||
        value.includes("\u0000") ||
        value.includes("\r") ||
        value.includes("\n")
      ) {
        throw new DaytonaTransportError("Daytona command environment cannot be encoded safely.");
      }
      return quotePosixArgument(`${name}=${value}`);
    });
  const invocation = [
    quotePosixArgument("/usr/bin/env"),
    ...environment,
    quotePosixArgument(command.executable),
    ...command.arguments.map(quotePosixArgument),
  ].join(" ");
  return `cd ${quotePosixArgument(command.workingDirectory)} && exec ${invocation}`;
}

function validateMetrics(sample: DaytonaMetricsLike): void {
  const timestamp = metricTimestamp(sample);
  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(sample.cpuCount) ||
    sample.cpuCount <= 0 ||
    !Number.isFinite(sample.cpuUsedPct) ||
    sample.cpuUsedPct < 0 ||
    sample.cpuUsedPct > 100 ||
    !Number.isFinite(sample.memUsed) ||
    sample.memUsed < 0 ||
    !Number.isFinite(sample.memTotal) ||
    sample.memTotal <= 0 ||
    sample.memUsed > sample.memTotal ||
    !Number.isFinite(sample.diskUsed) ||
    sample.diskUsed < 0 ||
    !Number.isFinite(sample.diskTotal) ||
    sample.diskTotal <= 0 ||
    sample.diskUsed > sample.diskTotal
  ) {
    throw new DaytonaTransportError("Daytona returned malformed resource metrics.");
  }
}

function metricTimestamp(sample: DaytonaMetricsLike): number {
  return sample.timestamp instanceof Date
    ? sample.timestamp.getTime()
    : Date.parse(sample.timestamp);
}

function resourceReport(
  rawSamples: readonly DaytonaMetricsLike[],
  startedAt: Date,
  finishedAt: Date,
  cpuCores: number,
): RemoteExecutionReceipt["resourceReport"] {
  if (rawSamples.length === 0) {
    throw new DaytonaTransportError("Daytona returned no resource metrics for the execution.");
  }
  const byTimestamp = new Map<number, DaytonaMetricsLike>();
  for (const sample of rawSamples) {
    validateMetrics(sample);
    if (sample.cpuCount !== cpuCores) {
      throw new DaytonaTransportError(
        "Daytona resource metrics do not match the leased CPU allocation.",
      );
    }
    byTimestamp.set(metricTimestamp(sample), sample);
  }
  const samples = [...byTimestamp.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, sample]) => sample);
  const peakMemoryBytes = Math.max(...samples.map((sample) => sample.memUsed));
  const wallTimeMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
  let cpuTimeMs = 0;
  if (samples.length === 1) {
    const only = samples[0];
    if (only === undefined) {
      throw new DaytonaTransportError("Daytona resource metric aggregation failed.");
    }
    cpuTimeMs = wallTimeMs * cpuCores * (only.cpuUsedPct / 100);
  } else {
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1];
      const current = samples[index];
      if (previous === undefined || current === undefined) {
        throw new DaytonaTransportError("Daytona resource metric aggregation failed.");
      }
      const intervalMs = Math.max(0, metricTimestamp(current) - metricTimestamp(previous));
      cpuTimeMs += intervalMs * cpuCores * ((previous.cpuUsedPct + current.cpuUsedPct) / 200);
    }
  }
  return {
    peakMemoryMiB: Math.ceil(peakMemoryBytes / (1_024 * 1_024)),
    cpuTimeMs: Math.max(0, Math.round(cpuTimeMs)),
  };
}

async function* utf8Chunks(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value, "utf8");
}

async function* boundedChunks(
  source: AsyncIterable<Uint8Array>,
  maximumByteLength: number,
): AsyncIterable<Uint8Array> {
  let byteLength = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) {
      throw new DaytonaTransportError("Daytona download returned a non-byte chunk.");
    }
    byteLength += chunk.byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength > maximumByteLength) {
      throw new DaytonaTransportError("Daytona download exceeded its caller-sealed byte limit.");
    }
    yield chunk;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function capturedLogs(value: DaytonaCommandLogsLike): CapturedLogs {
  const stdout = value.stdout ?? "";
  const stderr = value.stderr ?? "";
  if (typeof stdout !== "string" || typeof stderr !== "string") {
    throw new DaytonaTransportError("Daytona returned malformed command logs.");
  }
  if (
    Buffer.byteLength(stdout, "utf8") > MAX_CAPTURED_LOG_BYTES ||
    Buffer.byteLength(stderr, "utf8") > MAX_CAPTURED_LOG_BYTES
  ) {
    throw new DaytonaTransportError("Daytona command logs exceed the trusted streaming limit.");
  }
  return { stdout, stderr };
}

function makeExecutionState(executionId: string, startedAt: Date): ActiveExecution {
  let resolveTermination!: (outcome: TerminationOutcome) => void;
  let rejectTermination!: (error: unknown) => void;
  const terminationSignal = new Promise<TerminationOutcome>((resolve, reject) => {
    resolveTermination = resolve;
    rejectTermination = reject;
  });
  return {
    executionId,
    sessionId: executionId,
    startedAt,
    samples: [],
    terminationSignal,
    resolveTermination,
    rejectTermination,
  };
}

export class DaytonaCloudProviderTransport implements CloudProviderTransport {
  readonly #artifactBridge: TrustedArtifactBridge;
  readonly #sdkFactory: DaytonaSdkFactory;
  readonly #now: () => Date;
  readonly #sandboxes = new Map<string, ActiveSandbox>();

  constructor(options: DaytonaCloudProviderTransportOptions) {
    this.#artifactBridge = options.artifactBridge;
    this.#sdkFactory = options.sdkFactory ?? new OfficialDaytonaSdkFactory();
    this.#now = options.now ?? (() => new Date());
  }

  probe(
    configuration: ProviderConfiguration,
    request: ProviderProbeRequest,
  ): Promise<ProviderProbeReport> {
    this.#artifactBridge.assertTrustedRuntime();
    assertDaytonaConfiguration(configuration);
    const reasons = exactResourceReasons(configuration, request);
    if (request.requireGpu) {
      reasons.push("daytona-exact-gpu-type-attestation-unavailable");
    }
    return Promise.resolve({
      provider: "daytona",
      requestId: request.requestId,
      checkedAt: this.#now().toISOString(),
      configFingerprint: configuration.configFingerprint,
      capabilities: CAPABILITIES,
      compatible: reasons.length === 0,
      reasons: [...new Set(reasons)].sort(),
    });
  }

  async create(
    configuration: ProviderConfiguration,
    request: SandboxCreateRequest,
  ): Promise<SandboxLease> {
    this.#artifactBridge.assertTrustedRuntime();
    assertDaytonaConfiguration(configuration);
    assertCreateProfile(configuration, request);
    const client = await this.#sdkFactory.createClient(configuration);
    const ttlMinutes = request.lifetimeMs / 60_000;
    const domains = [
      ...new Set(request.network.allowDomains.map((domain) => domain.toLowerCase())),
    ].sort();
    const parameters: DaytonaCreateParameters = {
      image: request.imageReference,
      resources: {
        cpu: request.resources.cpuCores,
        memory: request.resources.memoryMiB / 1_024,
        disk: request.resources.diskMiB / 1_024,
      },
      ephemeral: true,
      autoPauseInterval: 0,
      autoStopInterval: 0,
      ttlMinutes,
      public: false,
      envVars: {
        DF_CLOUD_EXECUTION: "1",
      },
      secrets: secretMap(request.secretReferences),
      labels: {
        "dark-factory": "1",
        "df-request-sha256": sha256(request.requestId),
        "df-image-sha256": request.imageDigest.slice("sha256:".length),
      },
      ...(domains.length === 0
        ? { networkBlockAll: true as const }
        : { domainAllowList: domains.join(",") }),
    };

    let sandbox: DaytonaSandboxLike | undefined;
    try {
      sandbox = await client.create(parameters, {
        timeout: SDK_CREATE_TIMEOUT_SECONDS,
      });
      if (!SAFE_ID.test(sandbox.id) || this.#sandboxes.has(sandbox.id)) {
        throw new DaytonaTransportError(
          "Daytona returned a malformed or reused sandbox identifier.",
        );
      }
      await sandbox.updateEnv({
        DAYTONA_SANDBOX_ID: sandbox.id,
        DF_CLOUD_EXECUTION: "1",
      });
      await sandbox.fs.createFolder("/tmp/.df-transport", "700");
      await sandbox.fs.createFolder("/tmp/.df-transport/stdin", "700");
      await sandbox.refreshData();
      const architectureResponse = await sandbox.process.executeCommand(
        `${quotePosixArgument("/usr/bin/uname")} ${quotePosixArgument("-m")}`,
        "/",
        { LC_ALL: "C" },
        30,
      );
      const architecture = extractCommandOutput(architectureResponse);
      const expectedArchitecture =
        request.resources.architecture === "x86_64" ? "x86_64" : "aarch64";
      const actualDestroyAt = Date.parse(sandbox.autoDestroyAt ?? "");
      const createdAt = this.#now();
      const maximumDestroyAt = createdAt.getTime() + request.lifetimeMs + 60_000;
      const actualDomains = normalizeDomains(sandbox.domainAllowList);
      if (
        sandbox.target !== request.regionClass ||
        sandbox.cpu !== request.resources.cpuCores ||
        sandbox.memory !== request.resources.memoryMiB / 1_024 ||
        sandbox.disk !== request.resources.diskMiB / 1_024 ||
        sandbox.gpu !== 0 ||
        sandbox.public !== false ||
        sandbox.autoDeleteInterval !== 0 ||
        sandbox.autoPauseInterval !== 0 ||
        sandbox.autoStopInterval !== 0 ||
        sandbox.env?.["DF_CLOUD_EXECUTION"] !== "1" ||
        sandbox.env?.["DAYTONA_SANDBOX_ID"] !== sandbox.id ||
        architectureResponse.exitCode !== 0 ||
        architecture !== expectedArchitecture ||
        !Number.isFinite(actualDestroyAt) ||
        actualDestroyAt <= createdAt.getTime() ||
        actualDestroyAt > maximumDestroyAt ||
        (domains.length === 0
          ? sandbox.networkBlockAll !== true || actualDomains.length !== 0
          : sandbox.networkBlockAll === true ||
            JSON.stringify(actualDomains) !== JSON.stringify(domains))
      ) {
        throw new DaytonaTransportError(
          "Daytona did not attest the exact immutable sandbox profile.",
        );
      }
      const lease: SandboxLease = {
        provider: "daytona",
        sandboxId: sandbox.id,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(
          Math.min(actualDestroyAt, createdAt.getTime() + request.lifetimeMs),
        ).toISOString(),
        imageReference: request.imageReference,
        imageDigest: request.imageDigest,
        regionClass: request.regionClass,
        resources: structuredClone(request.resources),
        networkPolicyHash: hashNetworkPolicy(request.network),
        marker: {
          provider: "daytona",
          sandboxId: sandbox.id,
          markerEnvironmentName: "DAYTONA_SANDBOX_ID",
        },
      };
      this.#sandboxes.set(sandbox.id, {
        sandbox,
        request: structuredClone(request),
        lease,
        completedExecutionIds: new Set(),
        executions: new Map(),
        destroyed: false,
        sequence: 0,
        transferSequence: 0,
      });
      return lease;
    } catch {
      if (sandbox !== undefined) {
        try {
          await sandbox.delete(SDK_CONTROL_TIMEOUT_SECONDS, true);
        } catch {
          // The caller receives an attestation failure and must quarantine the
          // one-use request id in provider audit/reconciliation.
        }
      }
      throw new DaytonaTransportError(
        "Daytona sandbox creation or immutable-profile attestation failed.",
      );
    }
  }

  async execute(
    configuration: ProviderConfiguration,
    lease: SandboxLease,
    command: RemoteCommandSpec,
  ): Promise<RemoteExecutionReceipt> {
    this.#artifactBridge.assertTrustedRuntime();
    assertDaytonaConfiguration(configuration);
    const active = this.#requireSandbox(lease);
    if (active.executions.size > 0) {
      throw new DaytonaTransportError(
        "Daytona sandbox permits only one secret-scoped execution at a time.",
      );
    }
    const terminationReserveMs = 2 * (SDK_TERMINATION_TIMEOUT_SECONDS + 1) * 1_000;
    if (
      command.timeoutMs + terminationReserveMs >
      Date.parse(lease.expiresAt) - this.#now().getTime()
    ) {
      throw new DaytonaTransportError(
        "Daytona execution timeout leaves no lease budget for confirmed hard termination.",
      );
    }
    active.sequence += 1;
    const executionId =
      command.executionId ??
      `dfexec-${sha256(
        `${lease.sandboxId}:${String(active.sequence)}:${this.#now().toISOString()}`,
      ).slice(0, 48)}`;
    if (!SAFE_EXECUTION_ID.test(executionId) || active.completedExecutionIds.has(executionId)) {
      throw new DaytonaTransportError("Daytona execution identifier is malformed or reused.");
    }

    const startedAt = this.#now();
    const state = makeExecutionState(executionId, startedAt);
    active.executions.set(executionId, state);
    let timeout: NodeJS.Timeout | undefined;
    let stdinPath: string | undefined;
    try {
      timeout = setTimeout(() => {
        void this.#terminate(active, state, "timed-out").catch(() => {
          // The termination signal carries the authoritative failure into the
          // execution race; this branch only prevents an ignored timer promise.
        });
      }, command.timeoutMs);
      const executionPromise = (async (): Promise<CompletedCommand | TerminationOutcome> => {
        const beforeSecrets = await this.#requestedTermination(state);
        if (beforeSecrets !== undefined) return beforeSecrets;
        await active.sandbox.updateSecrets(secretMap(command.secretReferences));
        const afterSecrets = await this.#requestedTermination(state);
        if (afterSecrets !== undefined) return afterSecrets;
        if (command.stdinArtifact !== undefined) {
          stdinPath = `/tmp/.df-transport/stdin/${toSafeUriSegment(executionId)}`;
          const chunks = await this.#artifactBridge.openVerified(command.stdinArtifact);
          await active.sandbox.fs.uploadFileStream(Readable.from(chunks), stdinPath, {
            timeout: SDK_TRANSFER_TIMEOUT_SECONDS,
          });
          const afterStdin = await this.#requestedTermination(state);
          if (afterStdin !== undefined) return afterStdin;
        }
        state.samples.push(await active.sandbox.getMetricsLatest());
        validateMetrics(state.samples[0] as DaytonaMetricsLike);
        const afterMetric = await this.#requestedTermination(state);
        if (afterMetric !== undefined) return afterMetric;
        await active.sandbox.process.createSession(state.sessionId);
        const afterSession = await this.#requestedTermination(state);
        if (afterSession !== undefined) return afterSession;
        const encodedCommand = `${encodePosixCommand(command)}${
          stdinPath === undefined ? "" : ` < ${quotePosixArgument(stdinPath)}`
        }`;
        const launch = await active.sandbox.process.executeSessionCommand(
          state.sessionId,
          {
            command: encodedCommand,
            runAsync: true,
            suppressInputEcho: true,
          },
          Math.min(SDK_CONTROL_TIMEOUT_SECONDS, Math.max(1, Math.ceil(command.timeoutMs / 1_000))),
        );
        if (launch.cmdId === undefined || !SAFE_EXECUTION_ID.test(launch.cmdId)) {
          throw new DaytonaTransportError("Daytona returned a malformed command identifier.");
        }
        state.commandId = launch.cmdId;
        const afterLaunch = await this.#requestedTermination(state);
        if (afterLaunch !== undefined) return afterLaunch;
        return this.#waitForCompletion(active, state);
      })();
      let outcome: CompletedCommand | TerminationOutcome = await Promise.race([
        executionPromise,
        state.terminationSignal,
      ]);
      if (outcome.kind === "completed" && state.terminationOperation !== undefined) {
        outcome = await state.terminationOperation;
      }
      if (timeout !== undefined) clearTimeout(timeout);
      if (outcome.kind === "failure") {
        throw new DaytonaTransportError("Daytona execution entered provider quarantine.");
      }
      const finishedAt = this.#now();
      if (!active.destroyed) {
        await this.#collectHistoricalMetrics(active, state, startedAt, finishedAt);
      }
      const stdout = await this.#persistLog(
        lease.sandboxId,
        executionId,
        "stdout",
        outcome.logs.stdout,
      );
      const stderr = await this.#persistLog(
        lease.sandboxId,
        executionId,
        "stderr",
        outcome.logs.stderr,
      );
      const report = resourceReport(
        state.samples,
        startedAt,
        finishedAt,
        requestCpuCores(active.request),
      );
      if (!active.destroyed) {
        await this.#cleanupCompletedExecution(active, state, stdinPath);
      }
      active.executions.delete(executionId);
      active.completedExecutionIds.add(executionId);
      return {
        provider: "daytona",
        sandboxId: lease.sandboxId,
        executionId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        exitCode: outcome.kind === "completed" ? outcome.exitCode : null,
        timedOut: outcome.kind === "timed-out",
        cancelled: outcome.kind === "cancelled",
        stdout,
        stderr,
        resourceReport: report,
      };
    } catch {
      if (timeout !== undefined) clearTimeout(timeout);
      try {
        await this.#terminate(active, state, "failure");
      } catch {
        // The generic quarantine error below remains authoritative.
      }
      active.executions.delete(executionId);
      active.completedExecutionIds.add(executionId);
      throw new DaytonaTransportError("Daytona execution failed and its sandbox was quarantined.");
    }
  }

  async upload(
    configuration: ProviderConfiguration,
    lease: SandboxLease,
    artifact: TrustedCloudArtifactRef,
    remotePath: string,
  ): Promise<void> {
    this.#artifactBridge.assertTrustedRuntime();
    assertDaytonaConfiguration(configuration);
    assertRemotePath(remotePath);
    const active = this.#requireSandbox(lease);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#remainingTransferTime(lease));
    try {
      const chunks = await this.#artifactBridge.openVerified(artifact, controller.signal);
      await active.sandbox.fs.uploadFileStream(Readable.from(chunks), remotePath, {
        signal: controller.signal,
        timeout: Math.min(
          SDK_TRANSFER_TIMEOUT_SECONDS,
          Math.ceil(this.#remainingTransferTime(lease) / 1_000),
        ),
      });
    } catch {
      throw new DaytonaTransportError(
        "Daytona trusted artifact upload failed integrity validation.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async download(
    configuration: ProviderConfiguration,
    lease: SandboxLease,
    remotePath: string,
    expectation: CloudDownloadExpectation,
  ): Promise<TrustedCloudArtifactRef> {
    this.#artifactBridge.assertTrustedRuntime();
    assertDaytonaConfiguration(configuration);
    assertRemotePath(remotePath);
    if (
      !SAFE_MEDIA_TYPE.test(expectation.mediaType) ||
      !Number.isSafeInteger(expectation.maximumByteLength) ||
      expectation.maximumByteLength <= 0 ||
      expectation.maximumByteLength > MAXIMUM_DOWNLOAD_BYTES
    ) {
      throw new DaytonaTransportError("Daytona download expectation is malformed or unbounded.");
    }
    const active = this.#requireSandbox(lease);
    active.transferSequence += 1;
    const transferId = `${String(active.transferSequence)}:${remotePath}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#remainingTransferTime(lease));
    try {
      const chunks = await active.sandbox.fs.downloadFileStream(remotePath, {
        signal: controller.signal,
        timeout: Math.min(
          SDK_TRANSFER_TIMEOUT_SECONDS,
          Math.ceil(this.#remainingTransferTime(lease) / 1_000),
        ),
      });
      return await this.#artifactBridge.persistVerified({
        uri: `trusted://daytona/${toSafeUriSegment(
          lease.sandboxId,
        )}/downloads/${toSafeUriSegment(transferId)}`,
        mediaType: expectation.mediaType,
        chunks: boundedChunks(chunks, expectation.maximumByteLength),
        signal: controller.signal,
      });
    } catch {
      throw new DaytonaTransportError(
        "Daytona trusted artifact download failed integrity validation.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async cancel(
    configuration: ProviderConfiguration,
    lease: SandboxLease,
    executionId: string,
  ): Promise<void> {
    this.#artifactBridge.assertTrustedRuntime();
    assertDaytonaConfiguration(configuration);
    const active = this.#requireSandbox(lease, true);
    if (active.completedExecutionIds.has(executionId)) return;
    const execution = active.executions.get(executionId);
    if (execution === undefined) {
      throw new DaytonaTransportError(
        "Daytona execution is unknown; callers must preseal command.executionId for concurrent cancellation.",
      );
    }
    await this.#terminate(active, execution, "cancelled");
  }

  async destroy(configuration: ProviderConfiguration, lease: SandboxLease): Promise<void> {
    this.#artifactBridge.assertTrustedRuntime();
    assertDaytonaConfiguration(configuration);
    const active = this.#sandboxes.get(lease.sandboxId);
    if (active === undefined) return;
    if (active.destroyed) {
      this.#sandboxes.delete(lease.sandboxId);
      return;
    }
    try {
      await active.sandbox.delete(SDK_CONTROL_TIMEOUT_SECONDS, true);
      active.destroyed = true;
      this.#sandboxes.delete(lease.sandboxId);
    } catch {
      throw new DaytonaTransportError("Daytona sandbox destruction was not confirmed.");
    }
  }

  #requireSandbox(lease: SandboxLease, allowDestroyed = false): ActiveSandbox {
    const active = this.#sandboxes.get(lease.sandboxId);
    if (
      active === undefined ||
      active.lease.imageReference !== lease.imageReference ||
      active.lease.imageDigest !== lease.imageDigest ||
      active.lease.networkPolicyHash !== lease.networkPolicyHash ||
      active.lease.regionClass !== lease.regionClass ||
      (!allowDestroyed && active.destroyed)
    ) {
      throw new DaytonaTransportError("Daytona sandbox lease is unknown, mutated, or destroyed.");
    }
    return active;
  }

  async #waitForCompletion(
    active: ActiveSandbox,
    state: ActiveExecution,
  ): Promise<CompletedCommand> {
    const commandId = state.commandId;
    if (commandId === undefined) {
      throw new DaytonaTransportError("Daytona command has not been launched.");
    }
    while (true) {
      const status = await active.sandbox.process.getSessionCommand(state.sessionId, commandId);
      if (status.exitCode !== undefined && status.exitCode !== null) {
        if (!Number.isSafeInteger(status.exitCode)) {
          throw new DaytonaTransportError("Daytona returned a malformed exit status.");
        }
        const logs = capturedLogs(
          await active.sandbox.process.getSessionCommandLogs(state.sessionId, commandId),
        );
        state.samples.push(await active.sandbox.getMetricsLatest());
        return {
          kind: "completed",
          exitCode: status.exitCode,
          logs,
        };
      }
      state.samples.push(await active.sandbox.getMetricsLatest());
      await delay(METRIC_POLL_INTERVAL_MS);
    }
  }

  async #requestedTermination(state: ActiveExecution): Promise<TerminationOutcome | undefined> {
    const operation = state.terminationOperation;
    return operation === undefined ? undefined : operation;
  }

  async #terminate(
    active: ActiveSandbox,
    state: ActiveExecution,
    kind: TerminationKind,
  ): Promise<TerminationOutcome> {
    if (state.terminationOperation !== undefined) {
      return state.terminationOperation;
    }
    const operation = (async (): Promise<TerminationOutcome> => {
      let logs: CapturedLogs = { stdout: "", stderr: "" };
      if (state.commandId !== undefined) {
        try {
          logs = await Promise.race([
            active.sandbox.process
              .getSessionCommandLogs(state.sessionId, state.commandId)
              .then(capturedLogs),
            delay(3_000).then(() => ({ stdout: "", stderr: "" })),
          ]);
        } catch {
          logs = { stdout: "", stderr: "" };
        }
      }
      try {
        const metric = await Promise.race([
          active.sandbox.getMetricsLatest(),
          delay(3_000).then(() => undefined),
        ]);
        if (metric !== undefined) state.samples.push(metric);
      } catch {
        // At least the pre-execution metric remains required for a receipt.
      }
      let terminated = false;
      try {
        await Promise.race([
          active.sandbox.stop(SDK_TERMINATION_TIMEOUT_SECONDS, true),
          delay((SDK_TERMINATION_TIMEOUT_SECONDS + 1) * 1_000).then(() => {
            throw new DaytonaTransportError("Daytona force-stop confirmation timed out.");
          }),
        ]);
        terminated = true;
      } catch {
        try {
          await Promise.race([
            active.sandbox.delete(SDK_TERMINATION_TIMEOUT_SECONDS, true),
            delay((SDK_TERMINATION_TIMEOUT_SECONDS + 1) * 1_000).then(() => {
              throw new DaytonaTransportError("Daytona delete confirmation timed out.");
            }),
          ]);
          terminated = true;
        } catch {
          terminated = false;
        }
      }
      if (!terminated) {
        throw new DaytonaTransportError("Daytona could not confirm hard sandbox termination.");
      }
      active.destroyed = true;
      const outcome = { kind, logs } as const;
      return outcome;
    })();
    state.terminationOperation = operation;
    operation.then(state.resolveTermination, state.rejectTermination);
    return operation;
  }

  async #collectHistoricalMetrics(
    active: ActiveSandbox,
    state: ActiveExecution,
    startedAt: Date,
    finishedAt: Date,
  ): Promise<void> {
    const historical = await active.sandbox.getMetrics(startedAt, finishedAt);
    state.samples.push(...historical);
  }

  async #persistLog(
    sandboxId: string,
    executionId: string,
    stream: "stderr" | "stdout",
    value: string,
  ): Promise<TrustedCloudArtifactRef> {
    return this.#artifactBridge.persistVerified({
      uri: `trusted://daytona/${toSafeUriSegment(
        sandboxId,
      )}/executions/${toSafeUriSegment(executionId)}/${stream}`,
      mediaType: "text/plain",
      chunks: utf8Chunks(value),
    });
  }

  async #cleanupCompletedExecution(
    active: ActiveSandbox,
    state: ActiveExecution,
    stdinPath: string | undefined,
  ): Promise<void> {
    await active.sandbox.process.deleteSession(state.sessionId);
    await active.sandbox.updateSecrets({});
    if (stdinPath !== undefined) {
      await active.sandbox.fs.deleteFile(stdinPath);
    }
  }

  #remainingTransferTime(lease: SandboxLease): number {
    const remaining = Date.parse(lease.expiresAt) - this.#now().getTime();
    if (remaining <= 0) {
      throw new DaytonaTransportError("Daytona sandbox lease has expired.");
    }
    return Math.min(remaining, SDK_TRANSFER_TIMEOUT_SECONDS * 1_000);
  }
}

function requestCpuCores(request: SandboxCreateRequest): number {
  return request.resources.cpuCores;
}

export const DAYTONA_TRANSPORT_SDK_VERSION = DAYTONA_SDK_VERSION;
