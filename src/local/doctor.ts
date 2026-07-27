import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { assertLocalStateRoot, prepareLocalRunStorage } from "./state.js";

export const LOCAL_MINIMUM_NODE_MAJOR = 24;

const DOCKER_PROBE_TIMEOUT_MS = 2_000;
const DOCKER_PROBE_MAXIMUM_BYTES = 64 * 1024;

export interface DockerProbeReport {
  readonly required: false;
  readonly cli: {
    readonly available: boolean;
    readonly version: string | null;
  };
  readonly daemon: {
    readonly available: boolean;
    readonly version: string | null;
  };
}

export interface LocalDoctorReport {
  readonly command: "doctor";
  readonly ok: boolean;
  readonly runtime: {
    readonly node: {
      readonly version: string;
      readonly minimumMajor: typeof LOCAL_MINIMUM_NODE_MAJOR;
      readonly compatible: boolean;
    };
    readonly platform: NodeJS.Platform;
    readonly architecture: string;
  };
  readonly state: {
    readonly root: string;
    readonly writable: boolean;
  };
  readonly docker: DockerProbeReport;
  readonly synthetic: {
    readonly ready: boolean;
    readonly requiresDocker: false;
    readonly requiresModel: false;
    readonly requiresPiCheckout: false;
    readonly requiresTaskCatalog: false;
  };
  readonly realOptimization: {
    readonly ready: boolean;
    readonly implemented: true;
    readonly missing: readonly (
      | "Pi checkout"
      | "task catalog"
      | "model adapter"
      | "Foundry credentials"
      | "Claude Code"
      | "Docker daemon"
      | "uvx"
      | "Git"
      | "npm"
      | "Bun"
    )[];
    readonly expectedInputs: {
      readonly piCheckout: string;
      readonly taskCatalog: string;
      readonly modelAdapter: string;
      readonly credentialsFile: string;
      readonly claudeExecutable: string;
    };
  };
  readonly containsSecrets: false;
}

export interface LocalDoctorInput {
  readonly cwd: string;
  readonly stateRoot: string;
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly probeDocker?: () => Promise<DockerProbeReport>;
}

export async function inspectLocalDoctor(input: LocalDoctorInput): Promise<LocalDoctorReport> {
  assertLocalStateRoot(input.stateRoot);
  const nodeVersion = input.nodeVersion ?? process.versions.node;
  const nodeCompatible = isCompatibleNodeVersion(nodeVersion);
  const [writable, docker, prerequisites] = await Promise.all([
    probeStateRootWriteability(input.stateRoot),
    (input.probeDocker ?? probeDockerAvailability)(),
    inspectRealOptimizationPrerequisites(input.cwd, input.stateRoot),
  ]);
  const [uvx, git, npm, bun] = await Promise.all([
    boundedInvocation("uvx", ["--version"]),
    boundedInvocation("git", ["--version"]),
    boundedInvocation("npm", ["--version"]),
    boundedInvocation("bun", ["--version"]),
  ]);
  const missing: (
    | "Pi checkout"
    | "task catalog"
    | "model adapter"
    | "Foundry credentials"
    | "Claude Code"
    | "Docker daemon"
    | "uvx"
    | "Git"
    | "npm"
    | "Bun"
  )[] = [];
  if (!prerequisites.piCheckout) missing.push("Pi checkout");
  if (!prerequisites.taskCatalog) missing.push("task catalog");
  if (!prerequisites.modelAdapter) missing.push("model adapter");
  if (!prerequisites.credentialsFile) missing.push("Foundry credentials");
  if (!prerequisites.claudeExecutable) missing.push("Claude Code");
  if (!docker.daemon.available) missing.push("Docker daemon");
  if (!uvx.ok) missing.push("uvx");
  if (!git.ok) missing.push("Git");
  if (!npm.ok) missing.push("npm");
  if (!bun.ok) missing.push("Bun");

  const syntheticReady = nodeCompatible && writable;
  return {
    command: "doctor",
    ok: syntheticReady,
    runtime: {
      node: {
        version: nodeVersion,
        minimumMajor: LOCAL_MINIMUM_NODE_MAJOR,
        compatible: nodeCompatible,
      },
      platform: input.platform ?? process.platform,
      architecture: input.architecture ?? process.arch,
    },
    state: {
      root: input.stateRoot,
      writable,
    },
    docker,
    synthetic: {
      ready: syntheticReady,
      requiresDocker: false,
      requiresModel: false,
      requiresPiCheckout: false,
      requiresTaskCatalog: false,
    },
    realOptimization: {
      ready: nodeCompatible && writable && missing.length === 0,
      implemented: true,
      missing,
      expectedInputs: {
        piCheckout: prerequisites.paths.piCheckout,
        taskCatalog: prerequisites.paths.taskCatalog,
        modelAdapter: prerequisites.paths.modelAdapter,
        credentialsFile: prerequisites.paths.credentialsFile,
        claudeExecutable: prerequisites.paths.claudeExecutable,
      },
    },
    containsSecrets: false,
  };
}

export async function probeDockerAvailability(): Promise<DockerProbeReport> {
  const cli = await boundedDockerInvocation(["--version"]);
  if (!cli.ok) {
    return {
      required: false,
      cli: { available: false, version: null },
      daemon: { available: false, version: null },
    };
  }
  const daemon = await boundedDockerInvocation(["info", "--format", "{{.ServerVersion}}"]);
  return {
    required: false,
    cli: {
      available: true,
      version: normalizeProbeVersion(cli.stdout),
    },
    daemon: {
      available: daemon.ok,
      version: daemon.ok ? normalizeProbeVersion(daemon.stdout) : null,
    },
  };
}

export function isCompatibleNodeVersion(version: string): boolean {
  const match = /^(?:v)?(\d+)(?:\.\d+){0,2}(?:[-+].*)?$/u.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) && major >= LOCAL_MINIMUM_NODE_MAJOR;
}

async function inspectRealOptimizationPrerequisites(
  cwd: string,
  stateRoot: string,
): Promise<{
  readonly piCheckout: boolean;
  readonly taskCatalog: boolean;
  readonly modelAdapter: boolean;
  readonly credentialsFile: boolean;
  readonly claudeExecutable: boolean;
  readonly paths: {
    readonly piCheckout: string;
    readonly taskCatalog: string;
    readonly modelAdapter: string;
    readonly credentialsFile: string;
    readonly claudeExecutable: string;
  };
}> {
  const paths = {
    piCheckout: resolve(cwd, "../df-pi-tbench"),
    taskCatalog: join(stateRoot, "real/campaigns/<campaign>/catalog.json"),
    modelAdapter: resolve(cwd, "src/local/assets/dark_factory_pi_local.py"),
    credentialsFile: join(stateRoot, "config/foundry.env"),
    claudeExecutable: join(stateRoot, "tools/claude/node_modules/.bin/claude"),
  };
  const [piCheckout, taskCatalog, modelAdapter, credentialsFile, claudeExecutable] =
    await Promise.all([
      isRegularPath(paths.piCheckout, "directory"),
      hasCampaignCatalog(stateRoot),
      isRegularPath(paths.modelAdapter, "file"),
      isRegularPath(paths.credentialsFile, "file"),
      isExecutablePath(paths.claudeExecutable),
    ]);
  return {
    piCheckout,
    taskCatalog,
    modelAdapter,
    credentialsFile,
    claudeExecutable,
    paths,
  };
}

async function isExecutablePath(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    const target = await realpath(path);
    const information = await lstat(target);
    return information.isFile();
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return false;
    throw error;
  }
}

async function hasCampaignCatalog(stateRoot: string): Promise<boolean> {
  const campaigns = join(stateRoot, "real", "campaigns");
  try {
    const entries = await readdir(campaigns, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        (await isRegularPath(join(campaigns, entry.name, "catalog.json"), "file"))
      ) {
        return true;
      }
    }
    return false;
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return false;
    throw error;
  }
}

async function probeStateRootWriteability(stateRoot: string): Promise<boolean> {
  let probePath: string | null = null;
  try {
    const runsRoot = await prepareLocalRunStorage(stateRoot);
    probePath = join(runsRoot, `.doctor-write-${randomUUID()}`);
    const handle = await open(probePath, "wx", 0o600);
    try {
      await handle.writeFile("local-doctor-write-probe\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch {
    return false;
  } finally {
    if (probePath !== null) {
      await rm(probePath, { force: true }).catch(() => undefined);
    }
  }
}

async function isRegularPath(path: string, kind: "directory" | "file"): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return false;
    return kind === "directory" ? info.isDirectory() : info.isFile();
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return false;
    throw error;
  }
}

async function boundedDockerInvocation(
  arguments_: readonly string[],
): Promise<{ readonly ok: boolean; readonly stdout: string }> {
  return boundedInvocation("docker", arguments_);
}

async function boundedInvocation(
  executable: string,
  arguments_: readonly string[],
): Promise<{ readonly ok: boolean; readonly stdout: string }> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let outputBytes = 0;
    let settled = false;
    const child = spawn(executable, [...arguments_], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok, stdout });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, DOCKER_PROBE_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > DOCKER_PROBE_MAXIMUM_BYTES) {
        child.kill("SIGKILL");
        finish(false);
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

function normalizeProbeVersion(value: string): string | null {
  const normalized = value.trim().slice(0, 256);
  return normalized.length > 0 ? normalized : null;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
