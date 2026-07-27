import { createHash } from "node:crypto";

import {
  type MvpOuterStageFailurePhase,
  MvpPreflightDiagnosticError,
  outerStagePhaseDiagnosticCode,
  parseMvpPreflightWorkerFailure,
} from "./preflight-diagnostics.js";

export type MvpCloudRole = "optimizer" | "evaluator";

export const MVP_ROLE_MOUNT_PATH = "/workspace/df-state" as const;
export const MVP_PROCESS_ENTRYPOINT = "/usr/bin/env" as const;
export const MVP_OPTIMIZER_WORKER_PATH =
  "/tmp/df-mvp-controller/dist/mvp/cloud-optimizer-worker.js" as const;
export const MVP_EVALUATOR_WORKER_PATH =
  "/tmp/df-mvp-controller/dist/mvp/cloud-evaluator-worker.js" as const;
export const MVP_PREFLIGHT_WORKER_PATH =
  "/tmp/df-mvp-controller/dist/mvp/preflight-worker.js" as const;

const SDK_CREATE_TIMEOUT_SECONDS = 10 * 60;
const SDK_DELETE_TIMEOUT_SECONDS = 60;
const MAXIMUM_WORKER_OUTPUT_BYTES = 4 * 1024 * 1024;
const BUNDLE_REMOTE_PATH = "/tmp/df-mvp-controller.tar.gz";
const BUNDLE_INSTALL_ROOT = "/tmp/df-mvp-controller";
const BUNDLE_ADAPTER_PATH = "/tmp/df-mvp-controller/src/terminal-bench/assets/dark_factory_pi.py";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const SAFE_VOLUME_SUBPATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,9}$/u;
const SAFE_ABSOLUTE_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const SAFE_DOMAIN =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u;
const IMMUTABLE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,446}@sha256:[a-f0-9]{64}$/u;

export class MvpDaytonaRuntimeError extends Error {
  override readonly name = "MvpDaytonaRuntimeError";
}

export interface MvpGovernedSecretReference {
  readonly sourceEnvironmentName: string;
  readonly targetEnvironmentName: string;
}

export interface MvpRoleSandboxSpec {
  readonly role: MvpCloudRole;
  /**
   * The evaluator needs UID 0 only to create two isolated, unprivileged
   * candidate/champion build homes. The optimizer keeps the image default.
   */
  readonly user?: "root";
  readonly requestId: string;
  readonly campaignId: string;
  readonly configurationHash: string;
  readonly target: string;
  readonly image: string;
  readonly resources: {
    readonly cpu: number;
    readonly memoryGiB: number;
    readonly diskGiB: number;
  };
  readonly ttlMinutes: number;
  readonly networkBlockAll: boolean;
  readonly networkAllowDomains: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly secretReferences: readonly MvpGovernedSecretReference[];
  readonly volume: {
    readonly id: string;
    readonly subpath: string;
    readonly mountPath: typeof MVP_ROLE_MOUNT_PATH;
  };
}

/**
 * Provider-only configuration accepted by the Daytona transport. The complete
 * paid-run configuration remains structurally compatible, while protected
 * preflight stages do not need to manufacture unrelated Foundry or Pi fields.
 */
export interface MvpDaytonaRuntimeConfiguration {
  readonly campaignId: string;
  readonly configurationHash: string;
  readonly daytona: {
    readonly apiUrl: string;
    readonly target: string;
    /**
     * Paid launches bind both roles. Evaluator-only preflight intentionally
     * omits the optimizer entry so it cannot accidentally launch that role.
     */
    readonly images: {
      readonly optimizer?: string;
      readonly evaluator: string;
    };
    readonly volumeId: string;
    readonly apiKeyEnvironmentName: "DAYTONA_API_KEY";
    readonly outerSandboxResources: {
      readonly optimizer: MvpRoleSandboxSpec["resources"];
      readonly evaluator: MvpRoleSandboxSpec["resources"];
    };
  };
}

export interface MvpRoleWorkerCommand {
  readonly executable: typeof MVP_PROCESS_ENTRYPOINT;
  readonly arguments: readonly string[];
  readonly timeoutMs: number;
  readonly environment: Readonly<Record<string, string>>;
}

export interface MvpRoleSandboxLease {
  readonly role: MvpCloudRole;
  readonly sandboxId: string;
}

export interface MvpRoleExecutionReceipt {
  readonly role: MvpCloudRole;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: 0;
  readonly outputSha256: string;
  readonly outputByteLength: number;
  /**
   * Trusted-controller-only channel. It must be schema-validated before any
   * field is relayed or released.
   */
  readonly privateWorkerOutput: string;
}

export interface MvpControllerBundle {
  readonly localPath: string;
  readonly sha256: string;
}

export interface MvpStagedBundleReceipt {
  readonly role: MvpCloudRole;
  readonly sha256: string;
}

export interface MvpCloudRuntime {
  create(specification: MvpRoleSandboxSpec): Promise<MvpRoleSandboxLease>;
  stage(lease: MvpRoleSandboxLease, bundle: MvpControllerBundle): Promise<MvpStagedBundleReceipt>;
  execute(
    lease: MvpRoleSandboxLease,
    command: MvpRoleWorkerCommand,
  ): Promise<MvpRoleExecutionReceipt>;
  destroy(lease: MvpRoleSandboxLease): Promise<void>;
}

interface DaytonaVolumeLike {
  readonly volumeId: string;
  readonly mountPath: string;
  readonly subpath?: string;
}

interface DaytonaProcessResponseLike {
  readonly result?: string;
  readonly exitCode?: number;
  readonly artifacts?: {
    readonly stdout?: string;
  };
}

interface DaytonaProcessLike {
  executeCommand(
    command: string,
    cwd?: string,
    environment?: Readonly<Record<string, string>>,
    timeoutSeconds?: number,
  ): Promise<DaytonaProcessResponseLike>;
}

interface DaytonaFileSystemLike {
  uploadFile(localPath: string, remotePath: string): Promise<void>;
}

interface DaytonaSandboxLike {
  readonly id: string;
  readonly user?: string;
  readonly target: string;
  readonly cpu: number;
  readonly memory: number;
  readonly disk: number;
  readonly public: boolean;
  readonly autoDeleteInterval?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly labels?: Readonly<Record<string, string>>;
  readonly networkBlockAll?: boolean;
  readonly domainAllowList?: string;
  readonly volumes?: readonly DaytonaVolumeLike[];
  readonly process: DaytonaProcessLike;
  readonly fs: DaytonaFileSystemLike;
  updateEnv(
    environment: Readonly<Record<string, string>>,
    options?: { readonly unset?: readonly string[] },
  ): Promise<void>;
  refreshData(): Promise<void>;
  delete(timeoutSeconds?: number, wait?: boolean): Promise<void>;
}

interface DaytonaCreateParameters {
  readonly name: string;
  readonly image: string;
  readonly language: "typescript";
  readonly user?: "root";
  readonly resources: {
    readonly cpu: number;
    readonly memory: number;
    readonly disk: number;
  };
  readonly ephemeral: true;
  readonly autoDeleteInterval: 0;
  readonly autoStopInterval: 0;
  readonly ttlMinutes: number;
  readonly public: false;
  readonly envVars: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly networkBlockAll: boolean;
  readonly domainAllowList?: string;
  readonly volumes: readonly [
    {
      readonly volumeId: string;
      readonly mountPath: typeof MVP_ROLE_MOUNT_PATH;
      readonly subpath: string;
    },
  ];
}

export interface MvpDaytonaSdkClient {
  create(
    parameters: DaytonaCreateParameters,
    options?: {
      readonly timeout?: number;
      readonly onSnapshotCreateLogs?: (chunk: string) => void;
    },
  ): Promise<DaytonaSandboxLike>;
}

export interface MvpDaytonaSdkFactory {
  createClient(input: {
    readonly apiKey: string;
    readonly apiUrl: string;
    readonly target: string;
  }): Promise<MvpDaytonaSdkClient>;
}

export class OfficialMvpDaytonaSdkFactory implements MvpDaytonaSdkFactory {
  async createClient(input: {
    readonly apiKey: string;
    readonly apiUrl: string;
    readonly target: string;
  }): Promise<MvpDaytonaSdkClient> {
    const sdk = await import("@daytona/sdk");
    return new sdk.Daytona({
      apiKey: input.apiKey,
      apiUrl: input.apiUrl,
      target: input.target,
      otelEnabled: false,
    }) as unknown as MvpDaytonaSdkClient;
  }
}

export interface DaytonaMvpCloudRuntimeOptions {
  readonly environment?: () => NodeJS.ProcessEnv;
  readonly sdkFactory?: MvpDaytonaSdkFactory;
  readonly now?: () => Date;
}

interface ActiveSandbox {
  readonly sandbox: DaytonaSandboxLike;
  readonly specification: MvpRoleSandboxSpec;
  stagedBundleSha256: string | null;
}

/**
 * Small, one-provider MVP edge. It creates only ephemeral sandboxes and never
 * calls the Daytona volume service, so destroying a lease cannot delete the
 * existing persistent volume.
 */
export class DaytonaMvpCloudRuntime implements MvpCloudRuntime {
  readonly #configuration: MvpDaytonaRuntimeConfiguration;
  readonly #environment: () => NodeJS.ProcessEnv;
  readonly #sdkFactory: MvpDaytonaSdkFactory;
  readonly #now: () => Date;
  readonly #active = new Map<string, ActiveSandbox>();
  #clientPromise: Promise<MvpDaytonaSdkClient> | null = null;

  constructor(
    configuration: MvpDaytonaRuntimeConfiguration,
    options: DaytonaMvpCloudRuntimeOptions = {},
  ) {
    this.#configuration = configuration;
    this.#environment = options.environment ?? (() => process.env);
    this.#sdkFactory = options.sdkFactory ?? new OfficialMvpDaytonaSdkFactory();
    this.#now = options.now ?? (() => new Date());
  }

  async create(specification: MvpRoleSandboxSpec): Promise<MvpRoleSandboxLease> {
    assertSandboxSpecification(this.#configuration, specification);
    const client = await this.#client();
    const parameters = createParameters(specification);
    let sandbox: DaytonaSandboxLike | undefined;
    try {
      sandbox = await client.create(parameters, {
        timeout: SDK_CREATE_TIMEOUT_SECONDS,
        // Snapshot build output may contain registry or host details. It is
        // deliberately not forwarded to workflow logs.
        onSnapshotCreateLogs: () => undefined,
      });
      await sandbox.updateEnv({
        DAYTONA_SANDBOX_ID: sandbox.id,
        DF_CLOUD_EXECUTION: "1",
        DF_MVP_ROLE: specification.role,
      });
      await sandbox.refreshData();
      assertCreatedSandbox(specification, sandbox);
      if (this.#active.has(sandbox.id)) {
        throw new MvpDaytonaRuntimeError("Daytona returned a reused sandbox identity.");
      }
      this.#active.set(sandbox.id, {
        sandbox,
        specification: structuredClone(specification),
        stagedBundleSha256: null,
      });
      return {
        role: specification.role,
        sandboxId: sandbox.id,
      };
    } catch {
      let cleanupFailed = false;
      if (sandbox !== undefined) {
        try {
          await sandbox.delete(SDK_DELETE_TIMEOUT_SECONDS, true);
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) {
        throw new MvpPreflightDiagnosticError("outer-cleanup");
      }
      throw new MvpDaytonaRuntimeError("Daytona sandbox creation failed closed.");
    }
  }

  async stage(
    lease: MvpRoleSandboxLease,
    bundle: MvpControllerBundle,
  ): Promise<MvpStagedBundleReceipt> {
    const active = this.#active.get(lease.sandboxId);
    if (
      active === undefined ||
      active.specification.role !== lease.role ||
      !isAbsoluteCloudRunnerPath(bundle.localPath) ||
      !/^[a-f0-9]{64}$/u.test(bundle.sha256)
    ) {
      throw new MvpDaytonaRuntimeError("The controller bundle request is invalid.");
    }
    let phase: MvpOuterStageFailurePhase = "upload";
    try {
      await active.sandbox.fs.uploadFile(bundle.localPath, BUNDLE_REMOTE_PATH);
      phase = "digest";
      const hashResponse = await active.sandbox.process.executeCommand(
        `${quotePosix("/usr/bin/sha256sum")} ${quotePosix(BUNDLE_REMOTE_PATH)}`,
        "/",
        { LC_ALL: "C" },
        120,
      );
      const reportedHash = (hashResponse.artifacts?.stdout ?? hashResponse.result ?? "")
        .trim()
        .split(/\s+/u)[0];
      if (hashResponse.exitCode !== 0 || reportedHash !== bundle.sha256) {
        throw new Error("bundle digest mismatch");
      }
      phase = active.specification.role === "optimizer" ? "optimizer-authority" : "root-authority";
      const roleAuthorityResponse = await active.sandbox.process.executeCommand(
        [
          quotePosix("/usr/bin/node"),
          quotePosix("-e"),
          quotePosix(roleAuthorityProbe(active.specification.role)),
        ].join(" "),
        "/",
        { LC_ALL: "C" },
        120,
      );
      if (roleAuthorityResponse.exitCode !== 0) {
        throw new Error("sandbox role authority unavailable");
      }
      phase = "install-root";
      const mkdirResponse = await active.sandbox.process.executeCommand(
        `${quotePosix("/usr/bin/mkdir")} ${quotePosix("-p")} ${quotePosix(BUNDLE_INSTALL_ROOT)}`,
        "/",
        { LC_ALL: "C" },
        120,
      );
      if (mkdirResponse.exitCode !== 0) {
        throw new Error("bundle install root creation failed");
      }
      phase = "extraction";
      const extractResponse = await active.sandbox.process.executeCommand(
        [
          quotePosix("/usr/bin/tar"),
          quotePosix("-xzf"),
          quotePosix(BUNDLE_REMOTE_PATH),
          quotePosix("-C"),
          quotePosix(BUNDLE_INSTALL_ROOT),
        ].join(" "),
        "/",
        { LC_ALL: "C" },
        10 * 60,
      );
      if (extractResponse.exitCode !== 0) {
        throw new Error("bundle extraction failed");
      }
      let ownershipResponse: DaytonaProcessResponseLike | undefined;
      if (active.specification.user === "root") {
        phase = "adapter-ownership";
        ownershipResponse = await active.sandbox.process.executeCommand(
          [
            quotePosix("/usr/bin/node"),
            quotePosix("-e"),
            quotePosix(
              [
                'const { lstatSync } = require("node:fs");',
                `const value = lstatSync(${JSON.stringify(BUNDLE_ADAPTER_PATH)});`,
                "process.exit(value.isFile() && !value.isSymbolicLink() && value.uid === 0 && value.gid === 0 && (value.mode & 0o022) === 0 ? 0 : 1);",
              ].join(""),
            ),
          ].join(" "),
          "/",
          { LC_ALL: "C" },
          120,
        );
      }
      if (ownershipResponse !== undefined && ownershipResponse.exitCode !== 0) {
        throw new Error("bundle artifact ownership attestation failed");
      }
      active.stagedBundleSha256 = bundle.sha256;
      return { role: lease.role, sha256: bundle.sha256 };
    } catch (error) {
      if (error instanceof MvpPreflightDiagnosticError) throw error;
      throw new MvpPreflightDiagnosticError(outerStagePhaseDiagnosticCode(phase));
    }
  }

  async execute(
    lease: MvpRoleSandboxLease,
    command: MvpRoleWorkerCommand,
  ): Promise<MvpRoleExecutionReceipt> {
    const active = this.#active.get(lease.sandboxId);
    if (
      active === undefined ||
      active.specification.role !== lease.role ||
      active.stagedBundleSha256 === null
    ) {
      throw new MvpDaytonaRuntimeError("The worker lease is inactive or belongs to another role.");
    }
    assertWorkerCommand(active.specification, command);
    const startedAt = this.#now();
    let response: DaytonaProcessResponseLike;
    try {
      response = await active.sandbox.process.executeCommand(
        encodePosixCommand(command.executable, command.arguments),
        "/",
        command.environment,
        Math.ceil(command.timeoutMs / 1_000),
      );
    } catch {
      throw new MvpDaytonaRuntimeError("The Daytona role worker failed closed.");
    }
    const finishedAt = this.#now();
    const output = response.artifacts?.stdout ?? response.result ?? "";
    const outputByteLength = Buffer.byteLength(output, "utf8");
    if (response.exitCode !== 0) {
      const diagnostic =
        outputByteLength <= MAXIMUM_WORKER_OUTPUT_BYTES
          ? parseMvpPreflightWorkerFailure(output)
          : null;
      if (diagnostic !== null) {
        throw new MvpPreflightDiagnosticError(diagnostic);
      }
      throw new MvpDaytonaRuntimeError("The Daytona role worker failed closed.");
    }
    if (outputByteLength > MAXIMUM_WORKER_OUTPUT_BYTES) {
      throw new MvpDaytonaRuntimeError("The Daytona role worker failed closed.");
    }
    return {
      role: lease.role,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      exitCode: 0,
      outputSha256: sha256(output),
      outputByteLength,
      privateWorkerOutput: output,
    };
  }

  async destroy(lease: MvpRoleSandboxLease): Promise<void> {
    const active = this.#active.get(lease.sandboxId);
    if (active === undefined || active.specification.role !== lease.role) {
      throw new MvpDaytonaRuntimeError("The worker lease is inactive or belongs to another role.");
    }
    try {
      await active.sandbox.delete(SDK_DELETE_TIMEOUT_SECONDS, true);
      this.#active.delete(lease.sandboxId);
    } catch {
      throw new MvpDaytonaRuntimeError("The ephemeral Daytona sandbox could not be destroyed.");
    }
  }

  async #client(): Promise<MvpDaytonaSdkClient> {
    if (this.#clientPromise !== null) return this.#clientPromise;
    const apiKey = this.#environment()[this.#configuration.daytona.apiKeyEnvironmentName]?.trim();
    if (apiKey === undefined || apiKey.length === 0) {
      throw new MvpDaytonaRuntimeError("The Daytona API credential is unavailable.");
    }
    this.#clientPromise = this.#sdkFactory.createClient({
      apiKey,
      apiUrl: this.#configuration.daytona.apiUrl,
      target: this.#configuration.daytona.target,
    });
    return this.#clientPromise;
  }
}

function createParameters(specification: MvpRoleSandboxSpec): DaytonaCreateParameters {
  return {
    name: `df-mvp-${specification.role}-${specification.configurationHash.slice(0, 12)}`,
    image: specification.image,
    language: "typescript",
    ...(specification.user === undefined ? {} : { user: specification.user }),
    resources: {
      cpu: specification.resources.cpu,
      memory: specification.resources.memoryGiB,
      disk: specification.resources.diskGiB,
    },
    ephemeral: true,
    autoDeleteInterval: 0,
    autoStopInterval: 0,
    ttlMinutes: specification.ttlMinutes,
    public: false,
    envVars: specification.environment,
    secrets: Object.fromEntries(
      specification.secretReferences.map((reference) => [
        reference.targetEnvironmentName,
        reference.sourceEnvironmentName,
      ]),
    ),
    labels: {
      "dark-factory": "mvp",
      "df-role": specification.role,
      "df-config-sha256": specification.configurationHash,
      "df-request-sha256": sha256(specification.requestId),
    },
    networkBlockAll: specification.networkBlockAll,
    ...(specification.networkAllowDomains.length === 0
      ? {}
      : { domainAllowList: [...specification.networkAllowDomains].sort().join(",") }),
    volumes: [
      {
        volumeId: specification.volume.id,
        mountPath: specification.volume.mountPath,
        subpath: specification.volume.subpath,
      },
    ],
  };
}

function roleAuthorityProbe(role: MvpCloudRole): string {
  if (role === "optimizer") {
    return [
      'const { readFileSync } = require("node:fs");',
      'const status = readFileSync("/proc/self/status", "utf8");',
      'const capabilitiesClear = ["CapInh", "CapPrm", "CapEff", "CapAmb"].every(',
      '(name) => new RegExp(`^${name}:\\\\s+0+$`, "mu").test(status));',
      "process.exit(",
      "process.getuid?.() === 10001 && ",
      "process.getgid?.() === 10001 && ",
      "process.geteuid?.() === 10001 && ",
      "process.getegid?.() === 10001 && ",
      "!(process.getgroups?.() ?? []).includes(0) && ",
      "capabilitiesClear ? 0 : 1);",
    ].join("");
  }
  const childProbe = [
    "const id = Number(process.argv[1]);",
    "process.exit(",
    "process.getuid?.() === id && ",
    "process.getgid?.() === id && ",
    "process.geteuid?.() === id && ",
    "process.getegid?.() === id ? 0 : 1);",
  ].join("");
  return [
    'const fs = require("node:fs");',
    'const { spawnSync } = require("node:child_process");',
    "let authority = ",
    "process.getuid?.() === 0 && ",
    "process.getgid?.() === 0 && ",
    "process.geteuid?.() === 0 && ",
    "process.getegid?.() === 0;",
    "try {",
    "for (const id of [65532, 65533]) {",
    'const directory = fs.mkdtempSync("/tmp/df-mvp-root-authority-");',
    "try {",
    "fs.chownSync(directory, id, id);",
    "const metadata = fs.statSync(directory);",
    "const child = spawnSync(",
    '"/usr/bin/node", ',
    `["-e", ${JSON.stringify(childProbe)}, String(id)], `,
    "{ env: {",
    'HOME: directory, LANG: "C", LC_ALL: "C", ',
    'PATH: "/usr/local/bin:/usr/bin:/bin" }, ',
    'gid: id, uid: id, stdio: "ignore" });',
    "authority = authority && ",
    "metadata.uid === id && metadata.gid === id && ",
    "child.error === undefined && child.signal === null && child.status === 0;",
    "} finally {",
    "fs.rmSync(directory, { force: true, recursive: true });",
    "}",
    "}",
    "} catch {",
    "authority = false;",
    "}",
    "process.exit(authority ? 0 : 1);",
  ].join("");
}

function assertSandboxSpecification(
  configuration: MvpDaytonaRuntimeConfiguration,
  specification: MvpRoleSandboxSpec,
): void {
  const targets = new Set<string>();
  const environmentEntries = Object.entries(specification.environment);
  const expectedResources = configuration.daytona.outerSandboxResources[specification.role];
  const expectedImage = configuration.daytona.images[specification.role];
  const optimizerImage = configuration.daytona.images.optimizer;
  const evaluatorImage = configuration.daytona.images.evaluator;
  if (
    !SAFE_ID.test(specification.requestId) ||
    (specification.role === "evaluator"
      ? specification.user !== "root"
      : specification.user !== undefined) ||
    specification.campaignId !== configuration.campaignId ||
    specification.configurationHash !== configuration.configurationHash ||
    specification.target !== configuration.daytona.target ||
    !/(?:^|[-_.])eu(?:$|[-_.])/iu.test(specification.target) ||
    expectedImage === undefined ||
    specification.image !== expectedImage ||
    !IMMUTABLE_IMAGE.test(specification.image) ||
    !IMMUTABLE_IMAGE.test(evaluatorImage) ||
    (optimizerImage !== undefined &&
      (!IMMUTABLE_IMAGE.test(optimizerImage) ||
        optimizerImage.slice(optimizerImage.lastIndexOf("@") + 1) ===
          evaluatorImage.slice(evaluatorImage.lastIndexOf("@") + 1))) ||
    specification.volume.id !== configuration.daytona.volumeId ||
    specification.volume.mountPath !== MVP_ROLE_MOUNT_PATH ||
    !SAFE_VOLUME_SUBPATH.test(specification.volume.subpath) ||
    !specification.volume.subpath.endsWith(`/${specification.role}`) ||
    !Number.isSafeInteger(specification.resources.cpu) ||
    specification.resources.cpu < 1 ||
    !Number.isSafeInteger(specification.resources.memoryGiB) ||
    specification.resources.memoryGiB < 1 ||
    !Number.isSafeInteger(specification.resources.diskGiB) ||
    specification.resources.diskGiB < 10 ||
    specification.resources.cpu !== expectedResources.cpu ||
    specification.resources.memoryGiB !== expectedResources.memoryGiB ||
    specification.resources.diskGiB !== expectedResources.diskGiB ||
    !Number.isSafeInteger(specification.ttlMinutes) ||
    specification.ttlMinutes < 5 ||
    specification.ttlMinutes > 300 ||
    typeof specification.networkBlockAll !== "boolean" ||
    (specification.networkBlockAll
      ? specification.networkAllowDomains.length !== 0
      : specification.networkAllowDomains.length < 1) ||
    specification.networkAllowDomains.some((domain) => !SAFE_DOMAIN.test(domain)) ||
    new Set(specification.networkAllowDomains).size !== specification.networkAllowDomains.length ||
    environmentEntries.some(
      ([name, value]) =>
        !SAFE_ENVIRONMENT_NAME.test(name) ||
        /(?:TASK|GRADER|PROMPT|SOLUTION|TRACE)/u.test(name) ||
        value.length > 2_048 ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Sandbox environment values reject NUL and newlines to prevent injection.
        /[\u0000\r\n]/u.test(value),
    ) ||
    specification.secretReferences.some((reference) => {
      const duplicate = targets.has(reference.targetEnvironmentName);
      targets.add(reference.targetEnvironmentName);
      return (
        duplicate ||
        !SAFE_ENVIRONMENT_NAME.test(reference.sourceEnvironmentName) ||
        !SAFE_ENVIRONMENT_NAME.test(reference.targetEnvironmentName)
      );
    })
  ) {
    throw new MvpDaytonaRuntimeError("The Daytona role specification is invalid.");
  }
}

function assertCreatedSandbox(
  specification: MvpRoleSandboxSpec,
  sandbox: DaytonaSandboxLike,
): void {
  const domains = normalizeDomains(sandbox.domainAllowList);
  const expectedDomains = [...specification.networkAllowDomains].sort();
  const volume = sandbox.volumes?.[0];
  if (
    !SAFE_ID.test(sandbox.id) ||
    (specification.user !== undefined && sandbox.user !== specification.user) ||
    sandbox.target !== specification.target ||
    sandbox.cpu !== specification.resources.cpu ||
    sandbox.memory !== specification.resources.memoryGiB ||
    sandbox.disk !== specification.resources.diskGiB ||
    sandbox.public !== false ||
    sandbox.autoDeleteInterval !== 0 ||
    sandbox.networkBlockAll !== specification.networkBlockAll ||
    sandbox.labels?.["df-role"] !== specification.role ||
    sandbox.labels?.["df-config-sha256"] !== specification.configurationHash ||
    sandbox.env?.["DF_CLOUD_EXECUTION"] !== "1" ||
    sandbox.env?.["DF_MVP_ROLE"] !== specification.role ||
    sandbox.volumes?.length !== 1 ||
    volume?.volumeId !== specification.volume.id ||
    volume.mountPath !== specification.volume.mountPath ||
    volume.subpath !== specification.volume.subpath ||
    JSON.stringify(domains) !== JSON.stringify(expectedDomains)
  ) {
    throw new MvpDaytonaRuntimeError("Daytona did not attest the requested isolated role profile.");
  }
}

function assertWorkerCommand(
  specification: MvpRoleSandboxSpec,
  command: MvpRoleWorkerCommand,
): void {
  const expectedExecutable = MVP_PROCESS_ENTRYPOINT;
  if (
    command.executable !== expectedExecutable ||
    !isAllowedWorkerArguments(specification.role, command.arguments) ||
    !Number.isSafeInteger(command.timeoutMs) ||
    command.timeoutMs < 1 ||
    command.timeoutMs > specification.ttlMinutes * 60_000 ||
    command.arguments.some(
      (argument) =>
        argument.length > 2_048 ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Sandbox process arguments reject NUL and line breaks at the execution boundary.
        /[\u0000\r\n]/u.test(argument),
    ) ||
    Object.entries(command.environment).some(
      ([name, value]) =>
        !SAFE_ENVIRONMENT_NAME.test(name) ||
        /(?:TASK|GRADER|PROMPT|SOLUTION|TRACE)/u.test(name) ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Sandbox environment values reject NUL and newlines to prevent injection.
        /[\u0000\r\n]/u.test(value),
    )
  ) {
    throw new MvpDaytonaRuntimeError("The Daytona role worker command is invalid.");
  }
}

function isAllowedWorkerArguments(role: MvpCloudRole, arguments_: readonly string[]): boolean {
  if (arguments_.length !== 3 || arguments_[0] !== "node") return false;
  if (role === "optimizer") {
    return arguments_[1] === MVP_OPTIMIZER_WORKER_PATH && arguments_[2] === "optimize";
  }
  if (arguments_[1] === MVP_EVALUATOR_WORKER_PATH) {
    return arguments_[2] === "prepare" || arguments_[2] === "evaluate";
  }
  return (
    arguments_[1] === MVP_PREFLIGHT_WORKER_PATH &&
    (arguments_[2] === "bootstrap" ||
      arguments_[2] === "synthetic" ||
      arguments_[2] === "connectivity")
  );
}

function normalizeDomains(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((domain) => domain.trim().toLowerCase())
        .filter((domain) => domain.length > 0),
    ),
  ].sort();
}

function quotePosix(value: string): string {
  if (value.includes("\u0000")) {
    throw new MvpDaytonaRuntimeError("A worker argument contains an unsupported byte.");
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function encodePosixCommand(executable: string, arguments_: readonly string[]): string {
  if (!SAFE_ABSOLUTE_PATH.test(executable)) {
    throw new MvpDaytonaRuntimeError("The role worker executable path is invalid.");
  }
  return [executable, ...arguments_].map(quotePosix).join(" ");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isAbsoluteCloudRunnerPath(value: string): boolean {
  return (
    value.startsWith("/") && value !== "/" && !value.includes("/../") && !value.includes("\u0000")
  );
}
