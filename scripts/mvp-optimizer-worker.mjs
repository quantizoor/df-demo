#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

process.umask(0o077);

const GIT_EXECUTABLE = "/usr/bin/git";
const NODE_EXECUTABLE = "/usr/bin/node";
const CLAUDE_EXECUTABLE = "/usr/local/bin/claude";
const CLAUDE_CODE_VERSION = "2.1.217";
const BUNDLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_SOURCE_ROOT = join(BUNDLE_ROOT, "claude-plugin");
const EXPECTED_STATE_ROOT = "/workspace/df-state";
const MAXIMUM_INPUT_BYTES = 256 * 1024;
const MAXIMUM_PROCESS_STDOUT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_PROCESS_STDERR_BYTES = 8 * 1024 * 1024;
const MAXIMUM_DIFF_BYTES = 32 * 1024 * 1024;
const MAXIMUM_CHANGED_LINES = 600;
const MAXIMUM_CHANGED_FILES = 12;
const MAXIMUM_LITERAL_LENGTH = 400;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_CAMPAIGN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
// Mirrors src/mvp/model-deployment.ts for this standalone bundled worker.
const SAFE_DEPLOYMENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const MAXIMUM_DEPLOYMENT_ALIAS_LENGTH = 128;
const SAFE_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;
const SAFE_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const SAFE_BRANCH = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,238}[A-Za-z0-9])?$/u;
const DAYTONA_SECRET_PLACEHOLDER = /^dtn_secret_[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const ALLOWED_TOOLS = ["Read", "Edit", "Write", "Grep", "Glob", "Skill"];
const DENIED_TOOLS = ["Bash", "Shell", "WebSearch", "WebFetch", "Agent", "Task", "NotebookEdit"];
const ALLOWED_ROOTS = ["packages/agent/src/", "packages/ai/src/", "packages/coding-agent/src/"];
const ALLOWED_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const SAFE_SKILLS = [
  "benchmark-integrity",
  "form-falsifiable-hypothesis",
  "modify-pi-harness",
  "analyze-diagnostic-brief",
];
const PROTECTED_PATH =
  /(^|\/)(?:test|tests|grader|graders|verifier|verifiers|solution|solutions|reference|terminal-bench|terminalbench|tbench|harbor|benchmarks?|evals?|fixtures?|examples?)(\/|$)/iu;
const BENCHMARK_CONTENT =
  /\b(?:terminal[-_ ]?bench|tbench|harbor|benchmark answer|reference solution|grader|verifier|task id|task name)\b/iu;
const SOLUTION_REFERENCE =
  /(?:github\.com|gitlab\.com|gist\.github\.com|pastebin\.com).{0,120}(?:solution|answer|terminal.?bench)/iu;
const NETWORK_ADDITION =
  /\b(?:curl|wget|axios|undici|node:https|node:http|WebSocket)\b|https?:\/\/|\bfetch\s*\(/u;
const FINGERPRINT_ROUTING =
  /(?:process\.env|os\.hostname|hostname\s*\(|uname|machine-id|\/etc\/hostname).{0,180}(?:if|switch|case|includes|match|test)/iu;
const BASE64_PAYLOAD = /(?:["'`])[A-Za-z0-9+/]{160,}={0,2}(?:["'`])/u;
const HEX_PAYLOAD = /(?:["'`])(?:[a-f0-9]{2}){100,}(?:["'`])/iu;
const QUOTED_LITERAL = /(["'`])(?<literal>(?:\\.|(?!\1).)*)\1/gu;
const SENSITIVE_ENVIRONMENT_NAMES = [
  "DF_GITHUB_BASIC_AUTH",
  "DF_GITHUB_TOKEN",
  "DF_GITHUB_SSH_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GIT_ASKPASS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "SSH_AUTH_SOCK",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_API_KEY",
];
const DIAGNOSTIC_CATEGORIES = new Set([
  "tool-invocation",
  "tool-selection",
  "command-construction",
  "error-recovery",
  "verification",
  "planning",
  "context-management",
  "dependency",
  "timeout",
  "infrastructure",
]);
const TOOL_CLASSES = new Set([
  "shell",
  "filesystem-read",
  "filesystem-write",
  "search",
  "patch",
  "version-control",
  "package-manager",
  "browser",
  "none",
  "unknown",
]);
const CAUSE_CODES = new Set([
  "invalid-arguments",
  "unsupported-operation",
  "wrong-tool-class",
  "missing-prerequisite",
  "nonzero-exit-not-inspected",
  "repeated-failed-action",
  "insufficient-verification",
  "premature-termination",
  "context-loss",
  "deadline-exceeded",
  "dependency-unavailable",
  "sandbox-failure",
  "unknown",
]);
const INTERVENTION_CODES = new Set([
  "validate-tool-arguments",
  "inspect-before-retry",
  "choose-capability-first",
  "verify-prerequisites",
  "replan-after-failure",
  "add-result-verification",
  "preserve-critical-context",
  "bound-retries",
  "handle-time-budget",
  "no-harness-action",
]);

class MvpOptimizerWorkerError extends Error {
  constructor(readinessCode, exitCode) {
    super(readinessCode);
    this.name = "MvpOptimizerWorkerError";
    this.readinessCode = readinessCode;
    this.exitCode = exitCode;
  }
}

function reject(readinessCode, exitCode = 78) {
  throw new MvpOptimizerWorkerError(readinessCode, exitCode);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value, expected, code = "input-unavailable") {
  if (!isPlainObject(value)) reject(code, 64);
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    reject(code, 64);
  }
}

function parseFlags(arguments_, specification) {
  if (arguments_.length % 2 !== 0) {
    reject("invalid-configuration", 64);
  }
  const parsed = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      typeof flag !== "string" ||
      !flag.startsWith("--") ||
      typeof value !== "string" ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Worker CLI values must reject NUL and line breaks to prevent argument-boundary injection.
      /[\u0000\r\n]/u.test(value)
    ) {
      reject("invalid-configuration", 64);
    }
    const name = flag.slice(2);
    if (!(name in specification) || name in parsed) {
      reject("invalid-configuration", 64);
    }
    parsed[name] = value;
  }
  for (const [name, required] of Object.entries(specification)) {
    if (required && !(name in parsed)) {
      reject("invalid-configuration", 64);
    }
  }
  return parsed;
}

function assertAbsoluteContainedPath(path, root, code) {
  const canonicalRoot = resolve(root);
  const canonicalPath = resolve(path);
  if (
    !isAbsolute(path) ||
    path.includes("\u0000") ||
    canonicalPath === canonicalRoot ||
    !canonicalPath.startsWith(`${canonicalRoot}${sep}`)
  ) {
    reject(code, 64);
  }
}

async function readBoundedJson(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    reject("input-unavailable", 66);
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 2 ||
    metadata.size > MAXIMUM_INPUT_BYTES
  ) {
    reject("input-unavailable", 66);
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    reject("input-unavailable", 66);
  }
  return parsed;
}

function assertDiagnosticBrief(value) {
  exactKeys(value, [
    "schemaVersion",
    "policyVersion",
    "cards",
    "containsTaskIdentifiers",
    "containsTaskLiterals",
    "containsGraderSecrets",
    "containsPerTaskOutcomes",
  ]);
  if (
    value.schemaVersion !== "mvp-1.0.0" ||
    value.policyVersion !== "closed-vocabulary-task-free-v1" ||
    value.containsTaskIdentifiers !== false ||
    value.containsTaskLiterals !== false ||
    value.containsGraderSecrets !== false ||
    value.containsPerTaskOutcomes !== false ||
    !Array.isArray(value.cards) ||
    value.cards.length > 12
  ) {
    reject("input-unavailable", 64);
  }
  const uniqueCards = new Set();
  for (const card of value.cards) {
    exactKeys(card, [
      "category",
      "toolClass",
      "cause",
      "intervention",
      "affectedArm",
      "direction",
      "supportBand",
      "confidenceBand",
    ]);
    const canonicalCard = JSON.stringify(card);
    if (
      !DIAGNOSTIC_CATEGORIES.has(card.category) ||
      !TOOL_CLASSES.has(card.toolClass) ||
      !CAUSE_CODES.has(card.cause) ||
      !INTERVENTION_CODES.has(card.intervention) ||
      !new Set(["candidate", "champion", "comparison"]).has(card.affectedArm) ||
      !new Set(["candidate-better", "candidate-worse", "mixed", "unknown"]).has(card.direction) ||
      !new Set(["low", "medium", "high"]).has(card.supportBand) ||
      !new Set(["low", "medium", "high"]).has(card.confidenceBand) ||
      uniqueCards.has(canonicalCard)
    ) {
      reject("input-unavailable", 64);
    }
    uniqueCards.add(canonicalCard);
  }
}

function assertOptimizerInput(value) {
  exactKeys(value, [
    "schemaVersion",
    "experimentNumber",
    "championRevision",
    "previousOutcome",
    "diagnosticBrief",
    "boundary",
  ]);
  exactKeys(value.boundary, [
    "taskCatalogVisible",
    "taskIdentifiersVisible",
    "taskPromptsVisible",
    "graderVisible",
    "rawTracesVisible",
    "taskSpecificFeedbackVisible",
  ]);
  if (
    value.schemaVersion !== "mvp-1.0.0" ||
    !Number.isSafeInteger(value.experimentNumber) ||
    value.experimentNumber < 1 ||
    !GIT_OBJECT_ID.test(value.championRevision) ||
    !new Set([null, "promote", "reject", "inconclusive"]).has(value.previousOutcome) ||
    Object.values(value.boundary).some((visible) => visible !== false)
  ) {
    reject("input-unavailable", 64);
  }
  if (value.diagnosticBrief !== null) {
    assertDiagnosticBrief(value.diagnosticBrief);
  }
  return value;
}

function captureConfiguration(input) {
  let capabilitiesClear = false;
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    capabilitiesClear = ["CapInh", "CapPrm", "CapEff", "CapAmb"].every((name) =>
      new RegExp(`^${name}:\\s+0+$`, "mu").test(status),
    );
  } catch {
    capabilitiesClear = false;
  }
  const alternateCredentialPresent = [
    "DF_GITHUB_TOKEN",
    "DF_GITHUB_SSH_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "SSH_AUTH_SOCK",
  ].some((name) => process.env[name] !== undefined);
  const configuration = {
    githubBasicAuth: process.env.DF_GITHUB_BASIC_AUTH,
    foundryApiKey: process.env.ANTHROPIC_FOUNDRY_API_KEY,
    campaignId: process.env.DF_MVP_CAMPAIGN_ID,
    configurationHash: process.env.DF_MVP_CONFIGURATION_HASH,
    optimizerDeployment: process.env.DF_OPTIMIZER_DEPLOYMENT,
    optimizerModelFamily: process.env.DF_OPTIMIZER_MODEL_FAMILY,
    foundryBaseUrl: process.env.DF_FOUNDRY_BASE_URL,
    repositoryOwner: process.env.DF_PI_GITHUB_OWNER,
    repositoryName: process.env.DF_PI_GITHUB_REPOSITORY,
    repositoryBranch: process.env.DF_PI_BRANCH,
    packageLockSha256: process.env.DF_PI_PACKAGE_LOCK_SHA256,
  };
  for (const name of SENSITIVE_ENVIRONMENT_NAMES) {
    delete process.env[name];
  }
  if (alternateCredentialPresent) {
    reject("invalid-cloud-role", 77);
  }
  if (
    process.env.DF_CLOUD_EXECUTION !== "1" ||
    process.env.DF_MVP_ROLE !== "optimizer" ||
    process.env.CI !== "true" ||
    !["linux"].includes(process.platform) ||
    process.getuid?.() !== 10001 ||
    process.getgid?.() !== 10001 ||
    process.geteuid?.() !== 10001 ||
    process.getegid?.() !== 10001 ||
    (process.getgroups?.() ?? []).includes(0) ||
    !capabilitiesClear ||
    ![process.env.DAYTONA_SANDBOX_ID, process.env.DAYTONA_WORKSPACE_ID].some(
      (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value),
    )
  ) {
    reject("invalid-cloud-role", 77);
  }
  let baseUrl;
  try {
    baseUrl = new URL(configuration.foundryBaseUrl);
  } catch {
    reject("invalid-configuration", 64);
  }
  const resourceName = baseUrl.hostname.slice(0, -".services.ai.azure.com".length);
  if (
    configuration.campaignId !== input.campaign ||
    configuration.configurationHash !== input["configuration-hash"] ||
    !SAFE_CAMPAIGN.test(input.campaign) ||
    !SHA256.test(input["configuration-hash"]) ||
    configuration.optimizerModelFamily !== "claude-opus-5" ||
    !SAFE_DEPLOYMENT.test(configuration.optimizerDeployment ?? "") ||
    (configuration.optimizerDeployment?.length ?? 0) > MAXIMUM_DEPLOYMENT_ALIAS_LENGTH ||
    baseUrl.protocol !== "https:" ||
    !baseUrl.hostname.endsWith(".services.ai.azure.com") ||
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(resourceName) ||
    baseUrl.pathname.replace(/\/+$/u, "") !== "/anthropic" ||
    baseUrl.username !== "" ||
    baseUrl.password !== "" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== "" ||
    !SAFE_OWNER.test(configuration.repositoryOwner ?? "") ||
    !SAFE_REPOSITORY.test(configuration.repositoryName ?? "") ||
    !SAFE_BRANCH.test(configuration.repositoryBranch ?? "") ||
    !SHA256.test(configuration.packageLockSha256 ?? "")
  ) {
    reject("invalid-configuration", 64);
  }
  if (
    typeof configuration.githubBasicAuth !== "string" ||
    !DAYTONA_SECRET_PLACEHOLDER.test(configuration.githubBasicAuth) ||
    typeof configuration.foundryApiKey !== "string" ||
    !DAYTONA_SECRET_PLACEHOLDER.test(configuration.foundryApiKey)
  ) {
    reject("credential-unavailable", 69);
  }
  return {
    ...configuration,
    foundryResourceName: resourceName,
    remoteUrl: `https://github.com/${configuration.repositoryOwner}/${configuration.repositoryName}.git`,
  };
}

async function runProcess(command, arguments_, options) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure = null;
    const stop = (code) => {
      if (failure === null) {
        failure = new MvpOptimizerWorkerError(code, code === "runtime-unavailable" ? 69 : 78);
      }
      child.kill("SIGKILL");
    };
    child.stdout.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > (options.maximumStdoutBytes ?? MAXIMUM_PROCESS_STDOUT_BYTES)) {
        stop(options.failureCode);
        return;
      }
      stdout.push(bytes);
    });
    child.stderr.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += bytes.byteLength;
      if (stderrBytes > (options.maximumStderrBytes ?? MAXIMUM_PROCESS_STDERR_BYTES)) {
        stop(options.failureCode);
        return;
      }
      stderr.push(bytes);
    });
    const timeout = setTimeout(() => stop(options.failureCode), options.timeoutMs);
    child.once("error", () => {
      clearTimeout(timeout);
      rejectProcess(new MvpOptimizerWorkerError(options.failureCode, 69));
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      if (failure !== null) {
        rejectProcess(failure);
        return;
      }
      if (
        signal !== null ||
        status === null ||
        !(options.allowedStatuses ?? [0]).includes(status)
      ) {
        rejectProcess(new MvpOptimizerWorkerError(options.failureCode, 78));
        return;
      }
      resolveProcess({
        status,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

function baseGitEnvironment(home) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: home,
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_ALLOW_PROTOCOL: "https:file",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
}

function authenticatedGitEnvironment(home, githubBasicAuth) {
  return {
    ...baseGitEnvironment(home),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${githubBasicAuth}`,
  };
}

async function git(repository, home, arguments_, options = {}) {
  return runProcess(
    GIT_EXECUTABLE,
    ["-c", "core.hooksPath=/dev/null", "-c", "diff.external=", ...arguments_],
    {
      cwd: repository,
      environment:
        options.githubBasicAuth === undefined
          ? {
              ...baseGitEnvironment(home),
              ...(options.environment ?? {}),
            }
          : authenticatedGitEnvironment(home, options.githubBasicAuth),
      timeoutMs: options.timeoutMs ?? 15 * 60_000,
      maximumStdoutBytes: options.maximumStdoutBytes ?? MAXIMUM_PROCESS_STDOUT_BYTES,
      maximumStderrBytes: options.maximumStderrBytes ?? MAXIMUM_PROCESS_STDERR_BYTES,
      allowedStatuses: options.allowedStatuses,
      failureCode: options.failureCode ?? "candidate-rejected",
    },
  );
}

async function assertRuntimeReady() {
  if (
    BUNDLE_ROOT !== "/tmp/df-mvp-controller" ||
    Number(process.versions.node.split(".")[0]) !== 24 ||
    !isAbsolute(process.execPath)
  ) {
    reject("runtime-unavailable", 69);
  }
  for (const path of [GIT_EXECUTABLE, NODE_EXECUTABLE, CLAUDE_EXECUTABLE]) {
    let metadata;
    try {
      metadata = await stat(path);
    } catch {
      reject("runtime-unavailable", 69);
    }
    if (!metadata.isFile()) {
      reject("runtime-unavailable", 69);
    }
  }
  await runProcess(GIT_EXECUTABLE, ["--version"], {
    cwd: "/workspace",
    environment: {
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      LANG: "C",
    },
    timeoutMs: 30_000,
    maximumStdoutBytes: 1_024 * 1_024,
    maximumStderrBytes: 1_024 * 1_024,
    failureCode: "runtime-unavailable",
  });
  const nodeVersion = await runProcess(NODE_EXECUTABLE, ["--version"], {
    cwd: "/workspace",
    environment: {
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      LANG: "C",
    },
    timeoutMs: 30_000,
    maximumStdoutBytes: 1_024 * 1_024,
    maximumStderrBytes: 1_024 * 1_024,
    failureCode: "runtime-unavailable",
  });
  if (nodeVersion.stdout.toString("utf8").trim() !== `v${process.versions.node}`) {
    reject("runtime-unavailable", 69);
  }
  const claudeVersion = await runProcess(CLAUDE_EXECUTABLE, ["--version"], {
    cwd: "/workspace",
    environment: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/workspace",
      LC_ALL: "C",
      LANG: "C",
    },
    timeoutMs: 30_000,
    maximumStdoutBytes: 1_024 * 1_024,
    maximumStderrBytes: 1_024 * 1_024,
    failureCode: "runtime-unavailable",
  });
  const version =
    /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(claudeVersion.stdout.toString("utf8"))?.[1] ?? null;
  if (version !== CLAUDE_CODE_VERSION) {
    reject("claude-version-mismatch", 69);
  }
}

async function materializeSkillPlugin(destination) {
  const manifestRoot = join(destination, ".claude-plugin");
  const hooksRoot = join(destination, "hooks");
  const serverRoot = join(destination, "server");
  const skillsRoot = join(destination, "skills");
  await Promise.all([
    mkdir(manifestRoot, { recursive: true, mode: 0o700 }),
    mkdir(hooksRoot, { recursive: true, mode: 0o700 }),
    mkdir(serverRoot, { recursive: true, mode: 0o700 }),
    mkdir(skillsRoot, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(
    join(manifestRoot, "plugin.json"),
    `${JSON.stringify({
      name: "dark-factory",
      version: "0.1.0",
      description: "Task-blind Pi harness optimization skills for the Dark Factory MVP.",
      license: "UNLICENSED",
    })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  await writeFile(
    join(hooksRoot, "hooks.json"),
    `${JSON.stringify({
      description: "Fail-closed MVP optimizer filesystem boundary.",
      hooks: {
        PreToolUse: [
          {
            matcher: ".*",
            hooks: [
              {
                type: "command",
                command: "node",
                args: [
                  "${CLAUDE_PLUGIN_ROOT}/server/hook-guard.js",
                  "pre-tool-use",
                  "--project-root",
                  "${CLAUDE_PROJECT_DIR}",
                  "--plugin-data",
                  "${DF_PLUGIN_DATA_ROOT}",
                ],
                timeout: 5,
              },
            ],
          },
        ],
      },
    })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  const hookGuardSource = join(PLUGIN_SOURCE_ROOT, "server", "hook-guard.js");
  const hookGuardMetadata = await lstat(hookGuardSource);
  if (
    !hookGuardMetadata.isFile() ||
    hookGuardMetadata.isSymbolicLink() ||
    hookGuardMetadata.size < 100 ||
    hookGuardMetadata.size > 2 * 1024 * 1024
  ) {
    reject("runtime-unavailable", 69);
  }
  await cp(hookGuardSource, join(serverRoot, "hook-guard.js"), {
    dereference: false,
    errorOnExist: true,
    force: false,
  });
  for (const skill of SAFE_SKILLS) {
    const source = join(PLUGIN_SOURCE_ROOT, "skills", skill, "SKILL.md");
    const metadata = await lstat(source);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 10 ||
      metadata.size > 128 * 1024
    ) {
      reject("runtime-unavailable", 69);
    }
    const targetRoot = join(skillsRoot, skill);
    await mkdir(targetRoot, { mode: 0o700 });
    await cp(source, join(targetRoot, "SKILL.md"), {
      dereference: false,
      errorOnExist: true,
      force: false,
    });
  }
}

async function materializeChampion(input) {
  const repository = join(input.temporaryRoot, "pi");
  const gitHome = join(input.temporaryRoot, "git-home");
  await Promise.all([mkdir(repository, { mode: 0o700 }), mkdir(gitHome, { mode: 0o700 })]);
  await git(repository, gitHome, ["init", "--quiet"], {
    failureCode: "runtime-unavailable",
  });
  await git(
    repository,
    gitHome,
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-recurse-submodules",
      "--depth=1",
      input.configuration.remoteUrl,
      input.optimizerInput.championRevision,
    ],
    {
      githubBasicAuth: input.configuration.githubBasicAuth,
      timeoutMs: 20 * 60_000,
      failureCode: "publication-failed",
    },
  );
  const fetched = (
    await git(repository, gitHome, ["rev-parse", "FETCH_HEAD^{commit}"], {
      failureCode: "candidate-rejected",
    })
  ).stdout
    .toString("utf8")
    .trim();
  if (fetched !== input.optimizerInput.championRevision) {
    reject("candidate-rejected", 78);
  }
  await git(repository, gitHome, ["checkout", "--quiet", "--detach", fetched], {
    failureCode: "candidate-rejected",
  });
  await git(
    repository,
    gitHome,
    [
      "sparse-checkout",
      "set",
      "--no-cone",
      "/AGENTS.md",
      "/packages/agent/src/",
      "/packages/ai/src/",
      "/packages/coding-agent/src/",
    ],
    { failureCode: "candidate-rejected" },
  );
  await rm(join(repository, ".git", "FETCH_HEAD"), { force: true });
  const remotes = (
    await git(repository, gitHome, ["remote"], {
      failureCode: "candidate-rejected",
    })
  ).stdout
    .toString("utf8")
    .trim();
  const lock = await git(repository, gitHome, ["show", `${fetched}:package-lock.json`], {
    failureCode: "candidate-rejected",
  });
  if (remotes !== "" || sha256(lock.stdout) !== input.configuration.packageLockSha256) {
    reject("candidate-rejected", 78);
  }
  return { repository, gitHome };
}

function optimizerPrompt(optimizerInput) {
  const diagnosticInstruction =
    optimizerInput.diagnosticBrief === null
      ? "This is a source-only bootstrap. Do not invent prior failures."
      : "Use the analyze-diagnostic-brief skill on the closed-vocabulary cards below.";
  return [
    "You are the task-blind Dark Factory optimizer for the Pi terminal-agent harness.",
    "Read AGENTS.md first and obey it.",
    "Use the benchmark-integrity, form-falsifiable-hypothesis, and modify-pi-harness skills.",
    diagnosticInstruction,
    "Inspect only the sparse general harness source visible in this workspace.",
    "Do not seek, infer, name, or encode benchmark tasks, task prompts, graders, verifiers, solutions, expected outputs, or hidden panel membership.",
    "Do not access .git, absolute paths outside this workspace, the network, environment variables, package registries, tests, fixtures, examples, benchmark files, or evaluation configuration.",
    "Form exactly one falsifiable, task-independent hypothesis and make one small general harness improvement.",
    "Edit only packages/agent/src, packages/ai/src, or packages/coding-agent/src.",
    "Do not add network access, environment fingerprinting, benchmark routing, large constants, encoded payloads, timeouts, dependencies, or lockfile changes.",
    "Do not run commands or tests; the trusted wrapper will validate, commit, publish, build, and evaluate.",
    "Your final response must be exactly one JSON object with exactly these string fields and no markdown: hypothesisId, hypothesisSummary, interventionSummary.",
    "hypothesisId must be lowercase kebab-case. Summaries must explain the general causal mechanism and the single intervention without task-specific claims.",
    `Optimizer input: ${JSON.stringify(optimizerInput)}`,
  ].join("\n");
}

function claudeEnvironment(input) {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: input.claudeHome,
    CLAUDE_CONFIG_DIR: join(input.claudeHome, "config"),
    LC_ALL: "C",
    LANG: "C",
    CI: "true",
    DF_CLOUD_EXECUTION: "1",
    DF_MVP_ROLE: "optimizer",
    DF_OPTIMIZER_PHASE: "proposal",
    DF_OPTIMIZER_MODEL_ID: "claude-opus-5",
    DF_PLUGIN_DATA_ROOT: input.claudeHome,
    CLAUDE_CODE_USE_FOUNDRY: "1",
    ANTHROPIC_FOUNDRY_RESOURCE: input.configuration.foundryResourceName,
    ANTHROPIC_DEFAULT_OPUS_MODEL: input.configuration.optimizerDeployment,
    ANTHROPIC_FOUNDRY_API_KEY: input.configuration.foundryApiKey,
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
    DISABLE_TELEMETRY: "1",
  };
}

function parseClaudeProposal(stdout, expectedModel) {
  let initialized = false;
  let pluginLoaded = false;
  let completed = false;
  let resultPayload = null;
  let resultCount = 0;
  let turns = 0;
  for (const line of stdout.toString("utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > 1024 * 1024) {
      reject("candidate-rejected", 78);
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      reject("candidate-rejected", 78);
    }
    if (!isPlainObject(event)) reject("candidate-rejected", 78);
    if (event.type === "system" && event.subtype === "init") {
      initialized = true;
      pluginLoaded =
        Array.isArray(event.plugins) &&
        event.plugins.some((plugin) => isPlainObject(plugin) && plugin.name === "dark-factory");
      if (
        event.model !== expectedModel ||
        (Array.isArray(event.plugin_errors) && event.plugin_errors.length > 0)
      ) {
        reject("candidate-rejected", 78);
      }
    }
    if (event.type === "assistant") turns += 1;
    if (event.type === "result") {
      resultCount += 1;
      completed = event.is_error !== true;
      resultPayload = typeof event.result === "string" ? event.result : null;
    }
  }
  if (
    !initialized ||
    !pluginLoaded ||
    !completed ||
    resultCount !== 1 ||
    turns < 1 ||
    resultPayload === null
  ) {
    reject("candidate-rejected", 78);
  }
  let metadata;
  try {
    metadata = JSON.parse(resultPayload);
  } catch {
    reject("candidate-rejected", 78);
  }
  exactKeys(
    metadata,
    ["hypothesisId", "hypothesisSummary", "interventionSummary"],
    "candidate-rejected",
  );
  if (
    typeof metadata.hypothesisId !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(metadata.hypothesisId) ||
    metadata.hypothesisId.length > 128 ||
    typeof metadata.hypothesisSummary !== "string" ||
    metadata.hypothesisSummary.length < 20 ||
    metadata.hypothesisSummary.length > 2_000 ||
    typeof metadata.interventionSummary !== "string" ||
    metadata.interventionSummary.length < 20 ||
    metadata.interventionSummary.length > 4_000 ||
    BENCHMARK_CONTENT.test(metadata.hypothesisSummary) ||
    BENCHMARK_CONTENT.test(metadata.interventionSummary) ||
    SOLUTION_REFERENCE.test(metadata.hypothesisSummary) ||
    SOLUTION_REFERENCE.test(metadata.interventionSummary) ||
    NETWORK_ADDITION.test(metadata.hypothesisSummary) ||
    NETWORK_ADDITION.test(metadata.interventionSummary)
  ) {
    reject("candidate-rejected", 78);
  }
  return metadata;
}

async function invokeClaude(input) {
  const result = await runProcess(
    CLAUDE_EXECUTABLE,
    [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--no-chrome",
      "--permission-mode",
      "dontAsk",
      "--tools",
      ALLOWED_TOOLS.join(","),
      "--disallowedTools",
      DENIED_TOOLS.join(","),
      "--model",
      input.configuration.optimizerDeployment,
      "--effort",
      "high",
      "--max-budget-usd",
      "12.00",
      "--max-turns",
      "40",
      "--plugin-dir",
      input.pluginRoot,
      optimizerPrompt(input.optimizerInput),
    ],
    {
      cwd: input.repository,
      environment: claudeEnvironment(input),
      timeoutMs: 90 * 60_000,
      maximumStdoutBytes: MAXIMUM_PROCESS_STDOUT_BYTES,
      maximumStderrBytes: MAXIMUM_PROCESS_STDERR_BYTES,
      failureCode: "candidate-rejected",
    },
  );
  return parseClaudeProposal(result.stdout, input.configuration.optimizerDeployment);
}

function fileExtension(path) {
  const finalDot = path.lastIndexOf(".");
  return finalDot < 0 ? "" : path.slice(finalDot);
}

function assertChangedFiles(changedFiles) {
  if (
    changedFiles.length < 1 ||
    changedFiles.length > MAXIMUM_CHANGED_FILES ||
    new Set(changedFiles).size !== changedFiles.length ||
    changedFiles.some(
      (path) =>
        path.startsWith("/") ||
        path === ".." ||
        path.startsWith("../") ||
        path.includes("/../") ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Candidate paths are untrusted and must reject every ASCII control byte.
        /[\u0000-\u001f\u007f]/u.test(path) ||
        !ALLOWED_ROOTS.some((root) => path.startsWith(root)) ||
        !ALLOWED_EXTENSIONS.has(fileExtension(path)) ||
        PROTECTED_PATH.test(path),
    )
  ) {
    reject("candidate-rejected", 78);
  }
}

function addedDiffLines(diff) {
  const lines = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      lines.push(line.slice(1));
    }
  }
  return lines;
}

function assertGenericDiff(diff, addedLines, deletedLines) {
  if (
    Buffer.byteLength(diff, "utf8") < 1 ||
    Buffer.byteLength(diff, "utf8") > MAXIMUM_DIFF_BYTES ||
    !Number.isSafeInteger(addedLines) ||
    !Number.isSafeInteger(deletedLines) ||
    addedLines + deletedLines > MAXIMUM_CHANGED_LINES
  ) {
    reject("candidate-rejected", 78);
  }
  for (const line of addedDiffLines(diff)) {
    if (
      BASE64_PAYLOAD.test(line) ||
      HEX_PAYLOAD.test(line) ||
      NETWORK_ADDITION.test(line) ||
      SOLUTION_REFERENCE.test(line) ||
      BENCHMARK_CONTENT.test(line) ||
      FINGERPRINT_ROUTING.test(line)
    ) {
      reject("candidate-rejected", 78);
    }
    for (const match of line.matchAll(QUOTED_LITERAL)) {
      if ((match.groups?.literal ?? "").length > MAXIMUM_LITERAL_LENGTH) {
        reject("candidate-rejected", 78);
      }
    }
  }
}

function parseNumstat(output) {
  let addedLines = 0;
  let deletedLines = 0;
  for (const record of output.toString("utf8").split("\0")) {
    if (record.length === 0) continue;
    const match = /^(?<added>\d+|-)\t(?<deleted>\d+|-)\t(?<path>.+)$/u.exec(record);
    if (match?.groups === undefined || match.groups.added === "-" || match.groups.deleted === "-") {
      reject("candidate-rejected", 78);
    }
    addedLines += Number.parseInt(match.groups.added, 10);
    deletedLines += Number.parseInt(match.groups.deleted, 10);
  }
  return { addedLines, deletedLines };
}

async function assertChangedModes(repository, gitHome, changedFiles) {
  for (const path of changedFiles) {
    const result = await git(repository, gitHome, ["ls-files", "--stage", "-z", "--", path], {
      failureCode: "candidate-rejected",
    });
    const records = result.stdout.toString("utf8").split("\0").filter(Boolean);
    if (records.length === 0) continue;
    if (records.length !== 1 || !/^(?:100644|100755) [a-f0-9]{40,64} 0\t/u.test(records[0])) {
      reject("candidate-rejected", 78);
    }
  }
}

async function sealCandidate(input) {
  await git(input.repository, input.gitHome, ["add", "--all", "--"], {
    failureCode: "candidate-rejected",
  });
  await git(input.repository, input.gitHome, ["diff", "--cached", "--check", "--"], {
    failureCode: "candidate-rejected",
  });
  const changedFiles = (
    await git(
      input.repository,
      input.gitHome,
      ["diff", "--cached", "--no-renames", "--name-only", "-z", "--diff-filter=ACDMRTUXB", "--"],
      { failureCode: "candidate-rejected" },
    )
  ).stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  assertChangedFiles(changedFiles);
  await assertChangedModes(input.repository, input.gitHome, changedFiles);
  const diff = await git(
    input.repository,
    input.gitHome,
    ["diff", "--cached", "--no-renames", "--no-ext-diff", "--full-index", "--binary", "--"],
    {
      maximumStdoutBytes: MAXIMUM_DIFF_BYTES,
      failureCode: "candidate-rejected",
    },
  );
  const numstat = parseNumstat(
    (
      await git(
        input.repository,
        input.gitHome,
        ["diff", "--cached", "--no-renames", "--numstat", "-z", "--"],
        { failureCode: "candidate-rejected" },
      )
    ).stdout,
  );
  assertGenericDiff(diff.stdout.toString("utf8"), numstat.addedLines, numstat.deletedLines);
  const tree = (
    await git(input.repository, input.gitHome, ["write-tree"], {
      failureCode: "candidate-rejected",
    })
  ).stdout
    .toString("utf8")
    .trim();
  if (!GIT_OBJECT_ID.test(tree)) {
    reject("candidate-rejected", 78);
  }
  const lock = await git(input.repository, input.gitHome, ["show", `${tree}:package-lock.json`], {
    failureCode: "candidate-rejected",
  });
  if (sha256(lock.stdout) !== input.configuration.packageLockSha256) {
    reject("candidate-rejected", 78);
  }
  const timestamp = new Date(
    Date.UTC(2026, 0, 1) + input.optimizerInput.experimentNumber * 1_000,
  ).toISOString();
  const commit = (
    await git(
      input.repository,
      input.gitHome,
      [
        "commit-tree",
        tree,
        "-p",
        input.optimizerInput.championRevision,
        "-m",
        `feat(coding-agent): dark factory candidate ${input.optimizerInput.experimentNumber
          .toString()
          .padStart(3, "0")}`,
      ],
      {
        environment: {
          GIT_AUTHOR_NAME: "Dark Factory",
          GIT_AUTHOR_EMAIL: "dark-factory@invalid",
          GIT_AUTHOR_DATE: timestamp,
          GIT_COMMITTER_NAME: "Dark Factory",
          GIT_COMMITTER_EMAIL: "dark-factory@invalid",
          GIT_COMMITTER_DATE: timestamp,
        },
        failureCode: "candidate-rejected",
      },
    )
  ).stdout
    .toString("utf8")
    .trim();
  if (!GIT_OBJECT_ID.test(commit) || commit === input.optimizerInput.championRevision) {
    reject("candidate-rejected", 78);
  }
  return { changedFiles, commit };
}

async function publishCandidate(input) {
  const padded = input.optimizerInput.experimentNumber.toString().padStart(3, "0");
  const branch = `refs/heads/df/candidates/${input.configuration.campaignId}/${padded}-${input.commit.slice(0, 12)}`;
  if (
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock")
  ) {
    reject("publication-failed", 78);
  }
  await git(
    input.repository,
    input.gitHome,
    ["push", "--porcelain", input.configuration.remoteUrl, `${input.commit}:${branch}`],
    {
      githubBasicAuth: input.configuration.githubBasicAuth,
      timeoutMs: 20 * 60_000,
      failureCode: "publication-failed",
    },
  );
  const verification = await git(
    input.repository,
    input.gitHome,
    ["ls-remote", "--exit-code", "--heads", input.configuration.remoteUrl, branch],
    {
      githubBasicAuth: input.configuration.githubBasicAuth,
      timeoutMs: 5 * 60_000,
      failureCode: "publication-failed",
    },
  );
  const remoteCommit =
    /^(?<commit>[a-f0-9]{40,64})\trefs\/heads\//u.exec(verification.stdout.toString("utf8").trim())
      ?.groups?.commit ?? null;
  if (remoteCommit !== input.commit) {
    reject("publication-failed", 78);
  }
}

function candidateProposal(metadata, sealed) {
  const proposal = {
    hypothesisId: metadata.hypothesisId,
    hypothesisSummary: metadata.hypothesisSummary,
    interventionSummary: metadata.interventionSummary,
    candidateRevision: sealed.commit,
    changedFiles: sealed.changedFiles,
  };
  exactKeys(
    proposal,
    [
      "hypothesisId",
      "hypothesisSummary",
      "interventionSummary",
      "candidateRevision",
      "changedFiles",
    ],
    "candidate-rejected",
  );
  if (!GIT_OBJECT_ID.test(proposal.candidateRevision) || !Array.isArray(proposal.changedFiles)) {
    reject("candidate-rejected", 78);
  }
  assertChangedFiles(proposal.changedFiles);
  return proposal;
}

async function writeOutputAtomic(path, proposal) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  const payload = `${JSON.stringify(proposal)}\n`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return payload;
}

async function run(input) {
  if (
    input["state-root"] !== EXPECTED_STATE_ROOT ||
    !Number.isSafeInteger(Number(input["maximum-iterations"])) ||
    Number(input["maximum-iterations"]) < 1 ||
    Number(input["maximum-iterations"]) > 10
  ) {
    reject("invalid-configuration", 64);
  }
  const defaultInput = join(input["state-root"], "inbox", "optimizer-input.json");
  const defaultOutput = join(input["state-root"], "outbox", "candidate-proposal.json");
  const inputPath = input.input ?? defaultInput;
  const outputPath = input.output ?? defaultOutput;
  assertAbsoluteContainedPath(inputPath, input["state-root"], "input-unavailable");
  assertAbsoluteContainedPath(outputPath, input["state-root"], "invalid-configuration");
  if (resolve(inputPath) === resolve(outputPath)) {
    reject("invalid-configuration", 64);
  }
  const configuration = captureConfiguration(input);
  await assertRuntimeReady();
  const optimizerInput = assertOptimizerInput(await readBoundedJson(inputPath));
  const temporaryRoot = await mkdtemp("/workspace/df-mvp-optimizer-");
  let releasePayload = null;
  try {
    const pluginRoot = join(temporaryRoot, "claude-plugin");
    const claudeHome = join(temporaryRoot, "claude-home");
    await Promise.all([materializeSkillPlugin(pluginRoot), mkdir(claudeHome, { mode: 0o700 })]);
    const champion = await materializeChampion({
      temporaryRoot,
      configuration,
      optimizerInput,
    });
    const metadata = await invokeClaude({
      ...champion,
      optimizerInput,
      configuration,
      pluginRoot,
      claudeHome,
    });
    const sealed = await sealCandidate({
      ...champion,
      optimizerInput,
      configuration,
    });
    await publishCandidate({
      ...champion,
      optimizerInput,
      configuration,
      commit: sealed.commit,
    });
    releasePayload = await writeOutputAtomic(outputPath, candidateProposal(metadata, sealed));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  if (releasePayload === null) {
    reject("runtime-unavailable", 70);
  }
  process.stdout.write(releasePayload);
}

async function main() {
  const [operation, ...rest] = process.argv.slice(2);
  if (operation !== "run") {
    reject("invalid-configuration", 64);
  }
  await run(
    parseFlags(rest, {
      campaign: true,
      "maximum-iterations": true,
      "state-root": true,
      "configuration-hash": true,
      input: false,
      output: false,
    }),
  );
}

void main().catch((error) => {
  const failure =
    error instanceof MvpOptimizerWorkerError
      ? error
      : new MvpOptimizerWorkerError("runtime-unavailable", 70);
  process.stderr.write(`DF_MVP_OPTIMIZER_READINESS=${failure.readinessCode}\n`);
  process.exitCode = failure.exitCode;
});
