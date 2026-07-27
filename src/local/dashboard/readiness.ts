import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { isCompatibleNodeVersion } from "../doctor.js";
import { bootstrapTerminalBenchCatalog } from "../real/catalog.js";
import { readLocalFoundryCredentials } from "../real/config.js";
import type {
  DashboardReadinessCheck,
  DashboardReadinessInput,
  DashboardReadinessReport,
} from "./contracts.js";

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAXIMUM_OUTPUT_BYTES = 64 * 1024;
const NETWORK_TIMEOUT_MS = 30_000;
const NETWORK_REQUEST_TIMEOUT_MS = 8_000;
const MODEL_ADAPTER_MAXIMUM_BYTES = 256 * 1024;
const EXPECTED_PI_ORIGINS = new Set([
  "git@github.com:parallaxai/df-pi-tbench.git",
  "https://github.com/parallaxai/df-pi-tbench.git",
]);

interface InvocationResult {
  readonly ok: boolean;
  readonly stdout: string;
}

/** @internal Test seam. Production callers should omit this argument. */
export interface DashboardReadinessDependencies {
  readonly invoke?: (
    executable: string,
    arguments_: readonly string[],
    workingDirectory?: string,
  ) => Promise<InvocationResult>;
  readonly fetchImplementation?: typeof fetch;
  readonly nodeVersion?: string;
}

export async function inspectDashboardReadiness(
  input: DashboardReadinessInput,
  dependencies: DashboardReadinessDependencies = {},
): Promise<DashboardReadinessReport> {
  const stateRoot = resolve(input.stateRoot);
  const projectRoot = resolve(input.projectRoot ?? resolve(stateRoot, "..", ".."));
  const piRepository = resolve(input.piRepository ?? resolve(projectRoot, "..", "df-pi-tbench"));
  const credentialsFile = resolve(
    input.credentialsFile ?? join(stateRoot, "config", "foundry.env"),
  );
  const claudeExecutable = resolve(
    input.claudeExecutable ?? join(stateRoot, "tools", "claude", "node_modules", ".bin", "claude"),
  );
  const modelAdapters = [
    {
      path: join(projectRoot, "dist", "local", "assets", "dark_factory_pi_local.py"),
      markers: [
        "from dark_factory_pi import DarkFactoryPi as _ProductionDarkFactoryPi",
        "class DarkFactoryPi(_ProductionDarkFactoryPi):",
      ],
    },
    {
      path: join(projectRoot, "dist", "terminal-bench", "assets", "dark_factory_pi.py"),
      markers: [
        "from harbor.agents.installed.base import BaseInstalledAgent",
        "class DarkFactoryPi(BaseInstalledAgent):",
      ],
    },
  ] as const;
  const invoke = dependencies.invoke ?? boundedInvocation;

  const node = check(
    "node-runtime",
    "Node.js runtime",
    isCompatibleNodeVersion(dependencies.nodeVersion ?? process.versions.node),
    "Node.js satisfies the local runtime requirement.",
    "Node.js 24 or newer is required.",
  );
  const [state, docker, uvx, git, npm, bun, pi, credentials, claude, adapter, catalog] =
    await Promise.all([
      stateRootCheck(stateRoot),
      toolCheck("docker-daemon", "Docker daemon", invoke, "docker", [
        "info",
        "--format",
        "{{.ServerVersion}}",
      ]),
      toolCheck("tool-uvx", "uvx", invoke, "uvx", ["--version"]),
      toolCheck("tool-git", "Git", invoke, "git", ["--version"]),
      toolCheck("tool-npm", "npm", invoke, "npm", ["--version"]),
      toolCheck("tool-bun", "Bun", invoke, "bun", ["--version"]),
      piChecks(piRepository, invoke),
      credentialsCheck(credentialsFile),
      executableCheck(claudeExecutable, projectRoot, invoke),
      modelAdapterCheck(modelAdapters),
      terminalBenchCatalogCheck(dependencies.fetchImplementation ?? fetch),
    ]);
  const checks = [
    node,
    state,
    docker,
    uvx,
    git,
    npm,
    bun,
    ...pi,
    credentials,
    claude,
    adapter,
    catalog,
  ];
  return {
    ready: checks.every((item) => item.status === "pass"),
    checks,
    containsSecrets: false,
  };
}

async function stateRootCheck(stateRoot: string): Promise<DashboardReadinessCheck> {
  let probePath: string | null = null;
  try {
    const information = await lstat(stateRoot);
    if (information.isSymbolicLink() || !information.isDirectory()) {
      return check(
        "state-root",
        "Local state storage",
        false,
        "",
        "The local state directory is unavailable or unsafe.",
      );
    }
    probePath = join(stateRoot, `.dashboard-readiness-${randomUUID()}`);
    const handle = await open(probePath, "wx", 0o600);
    try {
      await handle.writeFile("dashboard-readiness\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return check(
      "state-root",
      "Local state storage",
      true,
      "The local state directory is writable.",
      "",
    );
  } catch {
    return check(
      "state-root",
      "Local state storage",
      false,
      "",
      "The local state directory is not writable.",
    );
  } finally {
    if (probePath !== null) await rm(probePath, { force: true }).catch(() => undefined);
  }
}

async function toolCheck(
  id: string,
  label: string,
  invoke: NonNullable<DashboardReadinessDependencies["invoke"]>,
  executable: string,
  arguments_: readonly string[],
): Promise<DashboardReadinessCheck> {
  const available = (await invoke(executable, arguments_).catch(() => ({ ok: false }))).ok;
  return check(
    id,
    label,
    available,
    `${label} is available.`,
    `${label} is unavailable or not responding.`,
  );
}

async function piChecks(
  repository: string,
  invoke: NonNullable<DashboardReadinessDependencies["invoke"]>,
): Promise<readonly DashboardReadinessCheck[]> {
  if (!(await isRealDirectory(repository))) {
    return [
      check(
        "pi-checkout",
        "Pi repository",
        false,
        "",
        "The Pi repository is unavailable or unsafe.",
      ),
      check(
        "pi-immutable",
        "Pi immutable revision",
        false,
        "",
        "The Pi revision could not be verified.",
      ),
      check("pi-origin", "Pi repository origin", false, "", "The Pi origin could not be verified."),
      check(
        "pi-clean",
        "Pi repository cleanliness",
        false,
        "",
        "The Pi working tree could not be verified.",
      ),
    ];
  }
  const [commit, tree, origin, status] = await Promise.all([
    invoke("git", ["rev-parse", "--verify", "HEAD^{commit}"], repository).catch(failedInvocation),
    invoke("git", ["rev-parse", "--verify", "HEAD^{tree}"], repository).catch(failedInvocation),
    invoke("git", ["remote", "get-url", "origin"], repository).catch(failedInvocation),
    invoke("git", ["status", "--porcelain=v1", "--untracked-files=all"], repository).catch(
      failedInvocation,
    ),
  ]);
  const immutable =
    commit.ok &&
    tree.ok &&
    /^[a-f0-9]{40,64}$/u.test(commit.stdout.trim()) &&
    /^[a-f0-9]{40,64}$/u.test(tree.stdout.trim());
  const expectedOrigin = origin.ok && EXPECTED_PI_ORIGINS.has(origin.stdout.trim());
  const clean = status.ok && status.stdout.trim().length === 0;
  return [
    check("pi-checkout", "Pi repository", true, "The Pi repository is available.", ""),
    check(
      "pi-immutable",
      "Pi immutable revision",
      immutable,
      "HEAD resolves to immutable Git objects.",
      "The Pi revision is not an immutable Git object.",
    ),
    check(
      "pi-origin",
      "Pi repository origin",
      expectedOrigin,
      "The origin is the expected parallaxai repository.",
      "The origin is not the expected parallaxai repository.",
    ),
    check(
      "pi-clean",
      "Pi repository cleanliness",
      clean,
      "The canonical Pi checkout is clean.",
      "The canonical Pi checkout contains local changes.",
    ),
  ];
}

async function credentialsCheck(path: string): Promise<DashboardReadinessCheck> {
  try {
    const information = await lstat(path);
    if (
      information.isSymbolicLink() ||
      !information.isFile() ||
      (information.mode & 0o777) !== 0o600
    ) {
      throw new Error("Credential file permissions are invalid");
    }
    await readLocalFoundryCredentials(path);
    return check(
      "foundry-credentials",
      "Microsoft Foundry credentials",
      true,
      "The protected credential file has the pinned model bindings.",
      "",
    );
  } catch {
    return check(
      "foundry-credentials",
      "Microsoft Foundry credentials",
      false,
      "",
      "The credential file is missing, unsafe, or does not contain the pinned deployments.",
    );
  }
}

async function executableCheck(
  executable: string,
  workingDirectory: string,
  invoke: NonNullable<DashboardReadinessDependencies["invoke"]>,
): Promise<DashboardReadinessCheck> {
  const valid = await isExecutableFile(executable);
  const responsive =
    valid &&
    (
      await invoke(executable, ["--version"], workingDirectory).catch(() => ({
        ok: false,
        stdout: "",
      }))
    ).ok;
  return check(
    "claude-code",
    "Claude Code executable",
    responsive,
    "Claude Code is installed and executable.",
    "Claude Code is missing, unsafe, or not executable.",
  );
}

async function modelAdapterCheck(
  adapters: readonly {
    readonly path: string;
    readonly markers: readonly string[];
  }[],
): Promise<DashboardReadinessCheck> {
  const valid = (
    await Promise.all(
      adapters.map(async ({ path, markers }) => {
        try {
          const information = await lstat(path);
          if (
            information.isSymbolicLink() ||
            !information.isFile() ||
            information.size <= 0 ||
            information.size > MODEL_ADAPTER_MAXIMUM_BYTES
          ) {
            return false;
          }
          const source = await readFile(path, "utf8");
          return markers.every((marker) => source.includes(marker));
        } catch {
          return false;
        }
      }),
    )
  ).every(Boolean);
  return check(
    "model-adapter",
    "Harbor model adapters",
    valid,
    "The compiled Pi Harbor adapters are available.",
    "A compiled Pi Harbor adapter is missing, unsafe, or invalid.",
  );
}

async function terminalBenchCatalogCheck(
  fetchImplementation: typeof fetch,
): Promise<DashboardReadinessCheck> {
  const overallSignal = AbortSignal.timeout(NETWORK_TIMEOUT_MS);
  const boundedFetch: typeof fetch = async (input, init) => {
    const signals = [overallSignal, AbortSignal.timeout(NETWORK_REQUEST_TIMEOUT_MS)];
    if (init?.signal != null) signals.push(init.signal);
    return fetchImplementation(input, {
      ...init,
      signal: AbortSignal.any(signals),
    });
  };
  try {
    await bootstrapTerminalBenchCatalog({
      generatedAt: new Date().toISOString(),
      fetchImplementation: boundedFetch,
    });
    return check(
      "terminal-bench-catalog",
      "Terminal-Bench 2.0 catalog",
      true,
      "The pinned registry and task metadata are reachable.",
      "",
    );
  } catch {
    return check(
      "terminal-bench-catalog",
      "Terminal-Bench 2.0 catalog",
      false,
      "",
      "The Terminal-Bench 2.0 registry or task metadata is unavailable.",
    );
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const information = await lstat(path);
    return !information.isSymbolicLink() && information.isDirectory();
  } catch {
    return false;
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    const target = await realpath(path);
    return (await lstat(target)).isFile();
  } catch {
    return false;
  }
}

async function boundedInvocation(
  executable: string,
  arguments_: readonly string[],
  workingDirectory?: string,
): Promise<InvocationResult> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let outputBytes = 0;
    let settled = false;
    const child = spawn(executable, [...arguments_], {
      ...(workingDirectory === undefined ? {} : { cwd: workingDirectory }),
      env: {
        PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        LANG: "C",
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
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
    }, PROBE_TIMEOUT_MS);
    timer.unref();
    const capture = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > PROBE_MAXIMUM_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(false);
        return;
      }
      stdout += chunk.toString("utf8");
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

function failedInvocation(): InvocationResult {
  return { ok: false, stdout: "" };
}

function check(
  id: string,
  label: string,
  passed: boolean,
  passedDetail: string,
  failedDetail: string,
): DashboardReadinessCheck {
  return {
    id,
    label,
    status: passed ? "pass" : "fail",
    detail: passed ? passedDetail : failedDetail,
  };
}
