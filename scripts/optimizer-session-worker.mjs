#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

process.umask(0o077);

const CLOUD_MARKER_GROUPS = [
  ["DAYTONA_SANDBOX_ID", "DAYTONA_WORKSPACE_ID"],
  ["E2B_SANDBOX_ID"],
  ["MODAL_TASK_ID", "MODAL_SANDBOX_ID"],
];
const SHA256 = /^[a-f0-9]{64}$/u;
const OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EXPERIMENT_ID = /^[0-9]{3,8}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_REF =
  /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u;
const SAFE_RECEIPT = /^[A-Za-z0-9_-]{16,128}$/u;
const SAFE_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const SAFE_ENV = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const ALLOWED_OPTIMIZER_SECRETS = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);
const REGULAR_TREE_MODES = new Set(["100644", "100755"]);
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024 * 1024;
const MAX_JSON_LINE_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DIFF_BYTES = 32 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MINIMUM_CLAUDE_VERSION = [2, 1, 217];
const INTEGRITY_POLICY = {
  version: "pi-candidate-integrity-v1",
  allowedRoots: [
    "packages/agent/src/",
    "packages/coding-agent/src/",
    "packages/ai/src/",
  ],
  maximumChangedFiles: 12,
  maximumChangedLines: 600,
  maximumLiteralLength: 400,
};
const PROTECTED_PATHS = [
  /(^|\/)(test|tests|grader|graders|verifier|verifiers|solution|solutions|reference)(\/|$)/iu,
  /(^|\/)(terminal-bench|terminalbench|tbench|harbor)(\/|$)/iu,
  /(^|\/)\.github\//u,
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/u,
  /(^|\/)(tsconfig(?:\.[A-Za-z0-9._-]+)?\.json|biome\.json|vitest\.config\.[cm]?[jt]s)$/iu,
  /(^|\/)(scripts|evals?|benchmarks?|fixtures?|examples?)\//iu,
  /(^|\/)(Dockerfile|docker-compose(?:\.[A-Za-z0-9._-]+)?\.ya?ml)$/iu,
];
const BASE64_PAYLOAD =
  /(?:["'`])[A-Za-z0-9+/]{160,}={0,2}(?:["'`])/u;
const HEX_PAYLOAD = /(?:["'`])(?:[a-f0-9]{2}){100,}(?:["'`])/iu;
const NETWORK_ADDITION =
  /\b(?:curl|wget|fetch\s*\(|axios|undici|node:https|node:http|WebSocket)\b/u;
const SOLUTION_REFERENCE =
  /(?:github\.com|gitlab\.com|gist\.github\.com|pastebin\.com).{0,100}(?:solution|answer|terminal.?bench)/iu;
const BENCHMARK_REFERENCE =
  /\b(?:terminal[-_ ]?bench|tbench|harbor).{0,80}(?:task|grader|test|solution|answer|verifier)\b/iu;
const FINGERPRINT_ROUTING =
  /(?:process\.env|os\.hostname|hostname\s*\(|uname|machine-id|\/etc\/hostname).{0,160}(?:if|switch|case|includes|match|test)/iu;
const QUOTED_LITERAL = /(["'`])(?<literal>(?:\\.|(?!\1).)*)\1/gu;

class OptimizerWorkerError extends Error {
  constructor(message) {
    super(message);
    this.name = "OptimizerWorkerError";
  }
}

function reject(message) {
  throw new OptimizerWorkerError(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject("Canonical JSON number is invalid.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    reject("Canonical JSON accepts only plain JSON values.");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function withContentHash(document) {
  return {
    ...document,
    contentHash: sha256(canonicalJson(document)),
  };
}

function assertCloudRuntime() {
  if (process.env.DF_CLOUD_EXECUTION !== "1") {
    reject("Optimizer session worker is cloud-only.");
  }
  const active = CLOUD_MARKER_GROUPS.filter((group) =>
    group.some((name) => process.env[name] !== undefined),
  );
  if (
    active.length !== 1 ||
    active[0].every(
      (name) =>
        process.env[name] === undefined ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(process.env[name]),
    )
  ) {
    reject("Optimizer worker requires exactly one valid cloud marker.");
  }
}

function parseFlags(argv, specification) {
  const values = new Map();
  if (argv.length % 2 !== 0) {
    reject("Optimizer worker arguments are incomplete.");
  }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const name = typeof flag === "string" ? flag.slice(2) : "";
    if (
      typeof flag !== "string" ||
      !flag.startsWith("--") ||
      typeof value !== "string" ||
      specification[name] === undefined ||
      values.has(name) ||
      /[\u0000\r\n]/u.test(value)
    ) {
      reject("Optimizer worker received an unsupported argument.");
    }
    values.set(name, value);
  }
  for (const [name, required] of Object.entries(specification)) {
    if (required && !values.has(name)) {
      reject("Optimizer worker arguments are incomplete.");
    }
  }
  return Object.fromEntries(values);
}

function assertAbsolutePath(value, label) {
  if (
    !SAFE_PATH.test(value) ||
    !isAbsolute(value) ||
    value.includes("/../") ||
    value === "/"
  ) {
    reject(`${label} is not a safe cloud path.`);
  }
}

function assertRef(value, label) {
  if (
    !SAFE_REF.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value
      .slice("refs/heads/".length)
      .split("/")
      .some(
        (part) =>
          part.startsWith(".") ||
          part.endsWith(".") ||
          part.endsWith(".lock"),
      )
  ) {
    reject(`${label} is not a safe Git ref.`);
  }
}

function assertIdentity(input) {
  if (
    !SAFE_ID.test(input.campaign) ||
    !EXPERIMENT_ID.test(input.experiment) ||
    !SHA256.test(input.registration) ||
    !SHA256.test(input["origin-repository-sha256"])
  ) {
    reject("Optimizer campaign or repository identity is invalid.");
  }
}

async function hashFile(path, maximumBytes = MAX_ARCHIVE_BYTES) {
  const initial = await lstat(path);
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.size <= 0 ||
    initial.size > maximumBytes
  ) {
    reject("Optimizer artifact must be a bounded regular file.");
  }
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  let byteLength = 0;
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      opened.size !== initial.size
    ) {
      reject("Optimizer artifact changed before hashing.");
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length);
      if (bytesRead === 0) break;
      byteLength += bytesRead;
      if (byteLength > maximumBytes) {
        reject("Optimizer artifact exceeded its size ceiling.");
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (
      after.dev !== initial.dev ||
      after.ino !== initial.ino ||
      after.size !== initial.size ||
      after.mtimeMs !== initial.mtimeMs ||
      byteLength !== initial.size
    ) {
      reject("Optimizer artifact changed while hashing.");
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), byteLength };
}

async function assertArtifact(path, expectedSha256, maximumBytes) {
  assertAbsolutePath(path, "Optimizer artifact path");
  if (!SHA256.test(expectedSha256)) {
    reject("Optimizer artifact digest is invalid.");
  }
  const actual = await hashFile(path, maximumBytes);
  if (actual.sha256 !== expectedSha256) {
    reject("Optimizer artifact digest does not match.");
  }
  return actual;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: null,
    input: options.input,
    maxBuffer: options.maxBuffer ?? MAX_GIT_OUTPUT_BYTES,
    timeout: options.timeoutMs ?? 15 * 60_000,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status === null ||
    !(options.allowedStatuses ?? [0]).includes(result.status) ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr)
  ) {
    reject("Optimizer worker subprocess failed closed.");
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function gitEnvironment(home, extra = {}) {
  return {
    HOME: home,
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_ALLOW_PROTOCOL: "https:file",
    GIT_LFS_SKIP_SMUDGE: "1",
    ...extra,
  };
}

function git(context, args, options = {}) {
  return run(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "diff.external=",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    {
      cwd: context.repository,
      env: gitEnvironment(context.home, options.env),
      input: options.input,
      allowedStatuses: options.allowedStatuses,
      timeoutMs: options.timeoutMs,
    },
  );
}

function text(buffer) {
  return buffer.toString("utf8").trim();
}

async function walkNoLinks(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      reject("Optimizer archive extracted a symbolic link.");
    }
    if (metadata.isDirectory()) {
      const children = await readdir(current);
      for (const child of children) {
        pending.push(join(current, child));
      }
    } else if (!metadata.isFile()) {
      reject("Optimizer archive extracted a special file.");
    }
  }
}

function safeArchiveEntry(entry) {
  const normalized = entry.replaceAll("\\", "/").replace(/^\.\//u, "");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !normalized.includes("/../") &&
    !normalized.includes("\u0000")
  );
}

async function extractTar(archive, destination) {
  const listing = run("/usr/bin/tar", ["-tf", archive], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
  }).stdout.toString("utf8");
  const entries = listing.split("\n").filter((line) => line.length > 0);
  const verbose = run("/usr/bin/tar", ["-tvf", archive], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
  }).stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  if (
    entries.length === 0 ||
    entries.length > 200_000 ||
    entries.some((entry) => !safeArchiveEntry(entry)) ||
    new Set(entries).size !== entries.length ||
    verbose.length !== entries.length ||
    verbose.some((entry) => !new Set(["-", "d"]).has(entry[0]))
  ) {
    reject("Optimizer tar archive contains an unsafe or linked entry.");
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  run(
    "/usr/bin/tar",
    [
      "--extract",
      "--file",
      archive,
      "--directory",
      destination,
      "--no-same-owner",
      "--no-same-permissions",
      "--delay-directory-restore",
    ],
    { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" } },
  );
  await walkNoLinks(destination);
}

async function makeReadOnly(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const metadata = await lstat(current);
    if (metadata.isDirectory()) {
      const children = await readdir(current);
      for (const child of children) pending.push(join(current, child));
      await chmod(current, 0o500);
    } else if (metadata.isFile()) {
      await chmod(current, metadata.mode & 0o111 ? 0o500 : 0o400);
    } else {
      reject("Optimizer input contains a non-regular node.");
    }
  }
}

async function replaceDirectory(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: false,
  });
  await walkNoLinks(destination);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function assertRegularFile(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    reject(`${label} is not a regular file.`);
  }
}

async function assertReleasedEvidenceLayout(input) {
  const allowedRoots =
    input.phase === "analysis"
      ? new Set([
          "campaign-context.json",
          "current-result.json",
          "experiments",
        ])
      : new Set([
          "campaign-context.json",
          "latest-brief.json",
          "briefs",
          "experiments",
        ]);
  const roots = await readdir(input["evidence-root"]);
  if (
    roots.length < 1 ||
    roots.some((entry) => !allowedRoots.has(entry))
  ) {
    reject("Released evidence archive contains an unapproved root.");
  }
  for (const directory of ["briefs", "experiments"]) {
    const path = join(input["evidence-root"], directory);
    if (!(await pathExists(path))) continue;
    const metadata = await lstat(path);
    const files = metadata.isDirectory() ? await readdir(path) : [];
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      files.some(
        (file) => !/^\d{3,}-[a-z0-9-]+\.json$/u.test(file),
      )
    ) {
      reject("Released evidence archive contains an invalid collection.");
    }
    for (const file of files) {
      await assertRegularFile(
        join(path, file),
        "Released evidence document",
      );
    }
  }
}

async function materializeState(input) {
  if (input["input-state"] === undefined) return null;
  await assertArtifact(
    input["input-state"],
    input["input-state-sha256"],
    512 * 1024 * 1024,
  );
  const temporary = await mkdtemp(join(tmpdir(), "df-state-input-"));
  try {
    await extractTar(input["input-state"], temporary);
    const roots = (await readdir(temporary)).sort();
    if (
      roots.length !== 3 ||
      roots[0] !== "optimizer-audit" ||
      roots[1] !== "optimizer-submissions" ||
      roots[2] !== "plugin-sessions"
    ) {
      reject("Optimizer state archive has an unexpected root.");
    }
    await replaceDirectory(
      join(temporary, "optimizer-audit"),
      input["audit-root"],
    );
    await replaceDirectory(
      join(temporary, "optimizer-submissions"),
      input["submission-root"],
    );
    await mkdir(input["plugin-data-root"], { recursive: true, mode: 0o700 });
    await replaceDirectory(
      join(temporary, "plugin-sessions"),
      join(input["plugin-data-root"], "sessions"),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return input["input-state-sha256"];
}

async function setupSource(input) {
  if (
    !OBJECT_ID.test(input["source-commit"]) ||
    !OBJECT_ID.test(input["source-tree"]) ||
    !SHA256.test(input["lock-sha256"])
  ) {
    reject("Optimizer source identity is malformed.");
  }
  assertRef(input["source-ref"], "Optimizer source");
  assertAbsolutePath(input["project-root"], "Optimizer project root");
  const projectParent = dirname(input["project-root"]);
  await mkdir(projectParent, { recursive: true, mode: 0o700 });
  try {
    await lstat(input["project-root"]);
    reject("Optimizer project root already exists.");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  await mkdir(input["project-root"], { mode: 0o700 });
  const home = await mkdtemp(join(tmpdir(), "df-git-home-"));
  const context = { repository: input["project-root"], home };
  let askpass = null;
  try {
    git(context, ["init", "--quiet"]);
    if (input["source-mode"] === "private-github") {
      const token = process.env.DF_GITHUB_TOKEN;
      let remote;
      try {
        remote = new URL(input.remote);
      } catch {
        reject("Private Git remote is invalid.");
      }
      const remoteMatch =
        /^\/(?<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/(?<repository>[A-Za-z0-9._-]{1,100})\.git$/u.exec(
          remote.pathname,
        );
      if (
        typeof token !== "string" ||
        token.length < 8 ||
        token.includes("\u0000") ||
        input.remote === undefined ||
        remote.protocol !== "https:" ||
        remote.hostname !== "github.com" ||
        remote.port !== "" ||
        remote.username !== "" ||
        remote.password !== "" ||
        remote.search !== "" ||
        remote.hash !== "" ||
        remoteMatch?.groups?.owner === undefined ||
        remoteMatch.groups.repository === undefined ||
        sha256(
          `github.com/${remoteMatch.groups.owner}/${remoteMatch.groups.repository}`,
        ) !== input["origin-repository-sha256"]
      ) {
        reject("Private Git setup lacks its one-command credential.");
      }
      askpass = join(home, "askpass.sh");
      await writeFile(
        askpass,
        "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' 'x-access-token' ;; *Password*) printf '%s\\n' \"$DF_GITHUB_TOKEN\" ;; *) exit 1 ;; esac\n",
        { encoding: "utf8", mode: 0o700, flag: "wx" },
      );
      git(context, ["remote", "add", "source", input.remote]);
      git(context, ["fetch", "--no-tags", "--no-recurse-submodules", "source", input["source-ref"]], {
        env: {
          GIT_ASKPASS: askpass,
          GIT_ASKPASS_REQUIRE: "force",
          DF_GITHUB_TOKEN: token,
        },
      });
    } else if (input["source-mode"] === "trusted-bundle") {
      if (
        input["source-bundle"] === undefined ||
        input["source-bundle-sha256"] === undefined
      ) {
        reject("Trusted bundle setup is incomplete.");
      }
      await assertArtifact(
        input["source-bundle"],
        input["source-bundle-sha256"],
        MAX_ARCHIVE_BYTES,
      );
      git(context, ["bundle", "verify", input["source-bundle"]]);
      git(context, [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        input["source-bundle"],
        input["source-ref"],
      ]);
    } else {
      reject("Optimizer source mode is unsupported.");
    }
    const fetched = text(git(context, ["rev-parse", "FETCH_HEAD^{commit}"]).stdout);
    if (fetched !== input["source-commit"]) {
      reject("Optimizer source ref did not resolve to the frozen commit.");
    }
    git(context, ["checkout", "--quiet", "--detach", input["source-commit"]]);
    const tree = text(
      git(context, ["rev-parse", `${input["source-commit"]}^{tree}`]).stdout,
    );
    const lock = git(context, [
      "show",
      `${input["source-commit"]}:package-lock.json`,
    ]).stdout;
    if (
      tree !== input["source-tree"] ||
      sha256(lock) !== input["lock-sha256"] ||
      text(git(context, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout) !==
        ""
    ) {
      reject("Optimizer source checkout does not match its frozen identity.");
    }
    const remotes = text(git(context, ["remote"]).stdout)
      .split("\n")
      .filter(Boolean);
    for (const remote of remotes) git(context, ["remote", "remove", remote]);
    if (text(git(context, ["remote"]).stdout) !== "") {
      reject("Optimizer source retained a network remote.");
    }
  } finally {
    if (askpass !== null) {
      await rm(askpass, { force: true });
    }
    await rm(home, { recursive: true, force: true });
  }
}

async function setup(input) {
  assertIdentity(input);
  if (
    !new Set(["proposal", "analysis"]).has(input.phase) ||
    !new Set(["private-github", "trusted-bundle"]).has(
      input["source-mode"],
    )
  ) {
    reject("Optimizer setup phase or source mode is invalid.");
  }
  for (const field of [
    "project-root",
    "plugin-archive",
    "plugin-root",
    "evidence-archive",
    "evidence-root",
    "submission-root",
    "audit-root",
    "plugin-data-root",
    "result",
  ]) {
    assertAbsolutePath(input[field], field);
  }
  if (
    new Set([
      input["project-root"],
      input["plugin-root"],
      input["evidence-root"],
      input["submission-root"],
      input["audit-root"],
      input["plugin-data-root"],
      input.result,
    ]).size !== 7
  ) {
    reject("Optimizer setup paths overlap.");
  }
  const freshRoots = [
    input["project-root"],
    input["plugin-root"],
    input["evidence-root"],
    input["submission-root"],
    input["audit-root"],
    input["plugin-data-root"],
    input.result,
  ];
  if ((await Promise.all(freshRoots.map(pathExists))).some(Boolean)) {
    reject("Optimizer sandbox contains a pre-existing session root.");
  }
  await Promise.all([
    assertArtifact(
      input["plugin-archive"],
      input["plugin-archive-sha256"],
      512 * 1024 * 1024,
    ),
    assertArtifact(
      input["evidence-archive"],
      input["evidence-archive-sha256"],
      512 * 1024 * 1024,
    ),
  ]);
  await setupSource(input);
  await extractTar(input["plugin-archive"], input["plugin-root"]);
  await extractTar(input["evidence-archive"], input["evidence-root"]);
  await walkNoLinks(input["plugin-root"]);
  await walkNoLinks(input["evidence-root"]);
  await Promise.all([
    assertRegularFile(
      join(input["plugin-root"], ".claude-plugin", "plugin.json"),
      "Claude plugin manifest",
    ),
    assertRegularFile(
      join(input["plugin-root"], ".mcp.json"),
      "Claude MCP manifest",
    ),
    assertRegularFile(
      join(input["plugin-root"], "server", "server.js"),
      "Claude MCP server",
    ),
    assertRegularFile(
      join(input["plugin-root"], "server", "hook-guard.js"),
      "Claude hook guard",
    ),
    assertRegularFile(
      join(input["evidence-root"], "campaign-context.json"),
      "Released campaign context",
    ),
  ]);
  await assertReleasedEvidenceLayout(input);
  const forbiddenEvidence =
    input.phase === "analysis"
      ? [
          join(input["evidence-root"], "latest-brief.json"),
          join(input["evidence-root"], "briefs"),
        ]
      : [
          join(input["evidence-root"], "current-result.json"),
          ...(input.experiment.startsWith("001-")
            ? [
                join(input["evidence-root"], "latest-brief.json"),
                join(input["evidence-root"], "briefs"),
              ]
            : []),
        ];
  if (
    (await Promise.all(forbiddenEvidence.map(pathExists))).some(Boolean) ||
    (input.phase === "analysis" &&
      !(await pathExists(
        join(input["evidence-root"], "current-result.json"),
      )))
  ) {
    reject("Released evidence archive exposes the wrong optimizer phase.");
  }
  await makeReadOnly(input["plugin-root"]);
  await makeReadOnly(input["evidence-root"]);
  await Promise.all([
    mkdir(input["submission-root"], { recursive: true, mode: 0o700 }),
    mkdir(input["audit-root"], { recursive: true, mode: 0o700 }),
    mkdir(input["plugin-data-root"], { recursive: true, mode: 0o700 }),
  ]);
  const inputStateSha256 = await materializeState(input);
  const document = withContentHash({
    schemaVersion: 1,
    domain: "dark-factory.optimizer-setup.v1",
    phase: input.phase,
    campaignId: input.campaign,
    experimentId: input.experiment,
    sourceMode: input["source-mode"],
    registrationId: input.registration,
    originRepositoryHash: input["origin-repository-sha256"],
    sourceCommit: input["source-commit"],
    sourceTree: input["source-tree"],
    lockSha256: input["lock-sha256"],
    pluginArchiveSha256: input["plugin-archive-sha256"],
    evidenceArchiveSha256: input["evidence-archive-sha256"],
    inputStateSha256,
  });
  await writeFile(input.result, `${canonicalJson(document)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

function exactKeys(value, expected, label) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    reject(`${label} must be a plain object.`);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  ) {
    reject(`${label} contains non-canonical fields.`);
  }
}

function decodeCommand(value) {
  if (
    !/^[A-Za-z0-9_-]{1,100000}$/u.test(value) ||
    value.length % 4 === 1
  ) {
    reject("Claude command envelope is malformed.");
  }
  const raw = Buffer.from(value, "base64url").toString("utf8");
  let command;
  try {
    command = JSON.parse(raw);
  } catch {
    reject("Claude command envelope is not JSON.");
  }
  exactKeys(
    command,
    [
      "executable",
      "arguments",
      "workingDirectory",
      "timeoutMs",
      "environment",
      "secretReferences",
    ],
    "Claude command",
  );
  if (raw !== canonicalJson(command)) {
    reject("Claude command envelope is not canonical.");
  }
  return command;
}

function assertClaudeCommand(command, input) {
  if (
    !isAbsolute(command.executable) ||
    basename(command.executable) !== "claude" ||
    command.workingDirectory !== "/workspace/pi" ||
    !Number.isSafeInteger(command.timeoutMs) ||
    command.timeoutMs < 1 ||
    command.timeoutMs > 24 * 60 * 60_000 ||
    !Array.isArray(command.arguments) ||
    command.arguments.some(
      (argument) =>
        typeof argument !== "string" || /[\u0000\r\n]/u.test(argument),
    ) ||
    typeof command.environment !== "object" ||
    command.environment === null ||
    Array.isArray(command.environment) ||
    !Array.isArray(command.secretReferences)
  ) {
    reject("Claude command violates optimizer execution policy.");
  }
  const argument = (name) => {
    const index = command.arguments.indexOf(name);
    return index < 0 ? null : command.arguments[index + 1] ?? null;
  };
  const requiredSingletonFlags = [
    "--output-format",
    "--permission-mode",
    "--tools",
    "--disallowedTools",
    "--model",
    "--effort",
    "--max-budget-usd",
    "--max-turns",
    "--plugin-dir",
  ];
  if (
    requiredSingletonFlags.some(
      (flag) =>
        command.arguments.filter((argument_) => argument_ === flag).length !==
        1,
    )
  ) {
    reject("Claude command contains missing or duplicate policy flags.");
  }
  const maximumBudgetUsd = Number(argument("--max-budget-usd"));
  const maximumTurns = Number(argument("--max-turns"));
  const tools = String(argument("--tools"));
  const model = argument("--model");
  const effort = argument("--effort");
  if (
    argument("--output-format") !== "stream-json" ||
    argument("--permission-mode") !== "dontAsk" ||
    argument("--plugin-dir") !== "/workspace/claude-plugin" ||
    !command.arguments.includes("--no-session-persistence") ||
    !command.arguments.includes("--no-chrome") ||
    !String(argument("--disallowedTools")).includes("Bash") ||
    !String(argument("--disallowedTools")).includes("WebFetch") ||
    command.environment.DF_CLOUD_EXECUTION !== "1" ||
    command.environment.DF_CAMPAIGN_ID !== input.campaign ||
    command.environment.DF_OPTIMIZER_PHASE !== input.phase ||
    command.environment.DF_RELEASED_EVIDENCE_ROOT !==
      "/workspace/released-evidence" ||
    command.environment.DF_OPTIMIZER_SUBMISSION_ROOT !==
      "/workspace/optimizer-submissions" ||
    command.environment.DF_OPTIMIZER_AUDIT_ROOT !==
      "/workspace/optimizer-audit" ||
    command.environment.DF_PLUGIN_DATA_ROOT !== "/workspace/plugin-data" ||
    command.environment.CLAUDE_CONFIG_DIR !==
      "/workspace/plugin-data/claude-config" ||
    typeof model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u.test(model) ||
    !new Set(["low", "medium", "high", "xhigh", "max"]).has(effort) ||
    (input.phase === "proposal" &&
      (!tools.split(",").includes("Edit") ||
        !tools.split(",").includes("Write") ||
        !tools.includes("df_submit_hypothesis") ||
        !tools.includes("df_stage_candidate") ||
        tools.includes("df_get_current_result") ||
        tools.includes("df_submit_analysis"))) ||
    (input.phase === "analysis" &&
      (tools.split(",").includes("Edit") ||
        tools.split(",").includes("Write") ||
        !tools.includes("df_get_current_result") ||
        !tools.includes("df_submit_analysis") ||
        tools.includes("df_stage_candidate"))) ||
    !Number.isFinite(maximumBudgetUsd) ||
    maximumBudgetUsd <= 0 ||
    !Number.isSafeInteger(maximumTurns) ||
    maximumTurns < 1 ||
    maximumTurns > 200
  ) {
    reject("Claude command changed the frozen optimizer boundary.");
  }
  const targets = new Set();
  for (const binding of command.secretReferences) {
    exactKeys(
      binding,
      ["sourceEnvironmentName", "targetEnvironmentName"],
      "Claude secret binding",
    );
    if (
      !SAFE_ENV.test(binding.sourceEnvironmentName) ||
      !ALLOWED_OPTIMIZER_SECRETS.has(binding.targetEnvironmentName) ||
      targets.has(binding.targetEnvironmentName) ||
      typeof process.env[binding.targetEnvironmentName] !== "string" ||
      process.env[binding.targetEnvironmentName].length < 8
    ) {
      reject("Claude received an unsupported optimizer secret binding.");
    }
    targets.add(binding.targetEnvironmentName);
  }
  if (targets.size !== 1 || process.env.DF_GITHUB_TOKEN !== undefined) {
    reject("Claude credential plane is missing or contaminated by Git credentials.");
  }
  for (const [name, value] of Object.entries(command.environment)) {
    if (
      !SAFE_ENV.test(name) ||
      typeof value !== "string" ||
      /[\u0000\r\n]/u.test(value) ||
      targets.has(name)
    ) {
      reject("Claude plain environment is malformed.");
    }
  }
  return { maximumBudgetUsd, maximumTurns };
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

async function executeClaude(command) {
  const baseEnvironment = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/workspace/plugin-data",
    LC_ALL: "C",
    LANG: "C",
  };
  const version = run(command.executable, ["--version"], {
    cwd: command.workingDirectory,
    env: baseEnvironment,
    maxBuffer: 1024 * 1024,
    timeoutMs: 30_000,
  });
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(version.stdout.toString("utf8"));
  const actualVersion =
    match === null
      ? null
      : [Number(match[1]), Number(match[2]), Number(match[3])];
  if (
    actualVersion === null ||
    actualVersion.some((part) => !Number.isSafeInteger(part)) ||
    !versionAtLeast(actualVersion, MINIMUM_CLAUDE_VERSION)
  ) {
    reject("Claude Code version is below the frozen minimum.");
  }
  const childEnvironment = {
    ...baseEnvironment,
    ...command.environment,
  };
  for (const binding of command.secretReferences) {
    childEnvironment[binding.targetEnvironmentName] =
      process.env[binding.targetEnvironmentName];
  }
  const stderrHash = createHash("sha256");
  let stderrBytes = 0;
  let stdoutBytes = 0;
  let lineBuffer = Buffer.alloc(0);
  let parseFailure = null;
  const summary = {
    initialized: false,
    pluginLoaded: false,
    pluginErrors: [],
    sessionId: null,
    model: null,
    result: "incomplete",
    totalCostUsd: 0,
    turns: 0,
  };
  const parseLine = (line) => {
    if (line.byteLength === 0) return;
    if (line.byteLength > MAX_JSON_LINE_BYTES) {
      reject("Claude stream record exceeds its bound.");
    }
    let event;
    try {
      event = JSON.parse(line.toString("utf8"));
    } catch {
      reject("Claude emitted malformed stream JSON.");
    }
    const record = asRecord(event);
    if (record === null) reject("Claude stream event must be an object.");
    if (record.type === "system" && record.subtype === "init") {
      summary.initialized = true;
      if (typeof record.session_id === "string") {
        summary.sessionId = record.session_id;
      }
      if (typeof record.model === "string") summary.model = record.model;
      const plugins = Array.isArray(record.plugins) ? record.plugins : [];
      summary.pluginLoaded = plugins.some((plugin) => {
        const item = asRecord(plugin);
        return item?.name === "dark-factory";
      });
      const errors = Array.isArray(record.plugin_errors)
        ? record.plugin_errors
        : [];
      summary.pluginErrors.push(
        ...errors.map((error) => {
          const item = asRecord(error);
          return `dark-factory-plugin-${
            typeof item?.type === "string" ? item.type : "unknown"
          }`;
        }),
      );
    }
    if (record.type === "assistant") summary.turns += 1;
    if (record.type === "result") {
      if (typeof record.session_id === "string") {
        summary.sessionId = record.session_id;
      }
      if (
        typeof record.total_cost_usd === "number" &&
        Number.isFinite(record.total_cost_usd) &&
        record.total_cost_usd >= 0
      ) {
        summary.totalCostUsd = record.total_cost_usd;
      }
      summary.result = record.is_error === true ? "failed" : "completed";
      if (Array.isArray(record.plugin_errors)) {
        summary.pluginErrors.push(
          ...record.plugin_errors
            .filter((item) => typeof item === "string")
            .map(String),
        );
      }
    }
  };
  const child = spawn(command.executable, command.arguments, {
    cwd: command.workingDirectory,
    env: childEnvironment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    if (parseFailure !== null) return;
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) {
        reject("Claude stream exceeds its total bound.");
      }
      lineBuffer = Buffer.concat([lineBuffer, bytes]);
      while (true) {
        const newline = lineBuffer.indexOf(0x0a);
        if (newline < 0) break;
        const line = lineBuffer.subarray(0, newline);
        lineBuffer = lineBuffer.subarray(newline + 1);
        parseLine(line);
      }
      if (lineBuffer.byteLength > MAX_JSON_LINE_BYTES) {
        reject("Claude stream record exceeds its bound.");
      }
    } catch (error) {
      parseFailure = error;
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderrBytes += bytes.byteLength;
    if (stderrBytes > MAX_STDERR_BYTES) {
      parseFailure = new OptimizerWorkerError(
        "Claude stderr exceeds its bound.",
      );
      child.kill("SIGKILL");
      return;
    }
    stderrHash.update(bytes);
  });
  const timeout = setTimeout(() => {
    parseFailure = new OptimizerWorkerError("Claude execution timed out.");
    child.kill("SIGKILL");
  }, command.timeoutMs);
  const exit = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  if (parseFailure !== null) throw parseFailure;
  if (lineBuffer.byteLength > 0) parseLine(lineBuffer);
  summary.pluginErrors = [...new Set(summary.pluginErrors)];
  if (
    exit.signal !== null ||
    exit.code !== 0 ||
    !summary.initialized ||
    !summary.pluginLoaded ||
    summary.pluginErrors.length > 0 ||
    summary.result !== "completed" ||
    summary.turns < 1
  ) {
    reject("Claude session did not complete the plugin-backed workflow.");
  }
  return {
    exitCode: exit.code,
    stderrSha256: stderrHash.digest("hex"),
    summary,
  };
}

async function runClaude(input) {
  assertIdentity({
    campaign: input.campaign,
    experiment: input.experiment,
    registration: "a".repeat(64),
    "origin-repository-sha256": "b".repeat(64),
  });
  if (!new Set(["proposal", "analysis"]).has(input.phase)) {
    reject("Claude phase is invalid.");
  }
  assertAbsolutePath(input.result, "Claude result path");
  const command = decodeCommand(input["command-base64url"]);
  const limits = assertClaudeCommand(command, input);
  const execution = await executeClaude(command);
  if (
    execution.summary.totalCostUsd > limits.maximumBudgetUsd ||
    execution.summary.turns > limits.maximumTurns
  ) {
    reject("Claude exceeded its frozen optimizer limits.");
  }
  const document = withContentHash({
    schemaVersion: 1,
    domain: "dark-factory.optimizer-claude.v1",
    phase: input.phase,
    campaignId: input.campaign,
    experimentId: input.experiment,
    summary: execution.summary,
    exitCode: execution.exitCode,
    stderrSha256: execution.stderrSha256,
  });
  await writeFile(input.result, `${canonicalJson(document)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

async function readJson(path, maximumBytes = 1024 * 1024) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > maximumBytes
  ) {
    reject("Optimizer JSON input is not a bounded regular file.");
  }
  const raw = await readFile(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    reject("Optimizer JSON input is malformed.");
  }
  return { parsed, raw };
}

async function singleEnvelope(root, campaign, kind) {
  const directory = join(root, campaign, kind);
  const canonicalRoot = resolve(root);
  const canonicalDirectory = resolve(directory);
  if (
    !canonicalDirectory.startsWith(`${canonicalRoot}${sep}`) ||
    !new Set(["hypothesis", "candidate", "analysis"]).has(kind)
  ) {
    reject("Optimizer submission directory escaped its root.");
  }
  const files = await readdir(directory);
  if (
    files.length !== 1 ||
    !/^[A-Za-z0-9._:-]+\.json$/u.test(files[0])
  ) {
    reject(`Optimizer requires exactly one ${kind} submission.`);
  }
  const { parsed } = await readJson(join(directory, files[0]));
  exactKeys(
    parsed,
    ["schemaVersion", "receipt", "payload", "projectDigest"],
    `${kind} submission envelope`,
  );
  exactKeys(
    parsed.receipt,
    [
      "receiptId",
      "kind",
      "campaignId",
      "payloadHash",
      "createdAt",
    ],
    `${kind} submission receipt`,
  );
  if (
    parsed.schemaVersion !== "1.0.0" ||
    parsed.receipt.kind !== kind ||
    parsed.receipt.campaignId !== campaign ||
    !SAFE_RECEIPT.test(parsed.receipt.receiptId) ||
    !SHA256.test(parsed.receipt.payloadHash) ||
    parsed.receipt.payloadHash !==
      sha256(JSON.stringify(parsed.payload)) ||
    !SHA256.test(parsed.projectDigest) ||
    !Number.isFinite(Date.parse(parsed.receipt.createdAt))
  ) {
    reject(`${kind} submission receipt is invalid.`);
  }
  return parsed;
}

function strings(value, minimum, maximum, label) {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    value.some((item) => typeof item !== "string")
  ) {
    reject(`${label} must be a bounded string list.`);
  }
}

function parseHypothesis(envelope) {
  const payload = envelope.payload;
  exactKeys(
    payload,
    [
      "sourceBriefHash",
      "citedCardIds",
      "observedPattern",
      "causalClaim",
      "intervention",
      "affectedComponents",
      "predictedRepairBehavior",
      "predictedFreshEffect",
      "generalityJustification",
      "falsificationCriteria",
      "rollbackCondition",
    ],
    "Hypothesis payload",
  );
  exactKeys(
    payload.predictedFreshEffect,
    ["accuracy", "capability", "cost", "latency"],
    "Hypothesis fresh prediction",
  );
  strings(payload.citedCardIds, 0, 8, "Hypothesis card citations");
  strings(
    payload.affectedComponents,
    1,
    4,
    "Hypothesis affected components",
  );
  strings(
    payload.falsificationCriteria,
    1,
    8,
    "Hypothesis falsification criteria",
  );
  if (
    (payload.sourceBriefHash !== null &&
      !SHA256.test(payload.sourceBriefHash)) ||
    [
      payload.observedPattern,
      payload.causalClaim,
      payload.intervention,
      payload.predictedRepairBehavior,
      payload.generalityJustification,
      payload.rollbackCondition,
      payload.predictedFreshEffect.accuracy,
      payload.predictedFreshEffect.capability,
      payload.predictedFreshEffect.cost,
      payload.predictedFreshEffect.latency,
    ].some((item) => typeof item !== "string" || item.length < 5)
  ) {
    reject("Hypothesis payload is incomplete.");
  }
  return {
    hash: envelope.receipt.payloadHash,
    sourceBriefHash: payload.sourceBriefHash,
    causalClaim: payload.causalClaim,
    intervention: payload.intervention,
    predictedRepairBehavior: payload.predictedRepairBehavior,
    predictedFreshEffect: canonicalJson(payload.predictedFreshEffect),
    falsificationCriteria: payload.falsificationCriteria,
    rollbackCondition: payload.rollbackCondition,
  };
}

function parseCandidate(envelope, hypothesisReceiptId) {
  const payload = envelope.payload;
  exactKeys(
    payload,
    [
      "hypothesisReceiptId",
      "mutationCategory",
      "changedComponents",
      "summary",
    ],
    "Candidate payload",
  );
  strings(
    payload.changedComponents,
    1,
    4,
    "Candidate changed components",
  );
  if (
    payload.hypothesisReceiptId !== hypothesisReceiptId ||
    typeof payload.mutationCategory !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(payload.mutationCategory) ||
    typeof payload.summary !== "string" ||
    payload.summary.length < 20 ||
    payload.summary.length > 600
  ) {
    reject("Candidate submission does not bind the frozen hypothesis.");
  }
  return payload;
}

async function readSessionState(pluginDataRoot, projectRoot, campaign) {
  const path = join(
    pluginDataRoot,
    "sessions",
    `${sha256(projectRoot)}.json`,
  );
  const { parsed } = await readJson(path);
  exactKeys(
    parsed,
    [
      "schemaVersion",
      "campaignId",
      "projectDigest",
      "queryCount",
      "briefReleased",
      "briefHash",
      "currentResultReleased",
      "currentResultHash",
      "hypothesisSubmitted",
      "hypothesisReceiptId",
      "candidateStaged",
      "candidateReceiptId",
      "analysisSubmitted",
      "analysisReceiptId",
      "contaminationReported",
      "updatedAt",
    ],
    "Optimizer session state",
  );
  if (
    parsed.schemaVersion !== "1.0.0" ||
    parsed.campaignId !== campaign ||
    parsed.projectDigest !== sha256(projectRoot) ||
    parsed.contaminationReported !== false
  ) {
    reject("Optimizer session state is invalid or contaminated.");
  }
  return parsed;
}

function addedDiffLines(diff) {
  const output = [];
  let file = null;
  let targetLine = 0;
  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("+++ b/")) {
      file = rawLine.slice(6);
      continue;
    }
    const hunk =
      /^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,\d+)? @@/u.exec(rawLine);
    if (hunk?.groups?.start) {
      targetLine = Number.parseInt(hunk.groups.start, 10);
      continue;
    }
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      output.push({ content: rawLine.slice(1), file, line: targetLine });
      targetLine += 1;
    } else if (!rawLine.startsWith("-")) {
      targetLine += 1;
    }
  }
  return output;
}

function scanDiff(changedFiles, diff, addedLines, deletedLines) {
  const violations = [];
  for (const file of changedFiles) {
    if (
      file.startsWith("/") ||
      file === ".." ||
      file.startsWith("../") ||
      file.includes("/../") ||
      /[\u0000-\u001f\u007f]/u.test(file) ||
      !INTEGRITY_POLICY.allowedRoots.some((root) => file.startsWith(root)) ||
      PROTECTED_PATHS.some((pattern) => pattern.test(file))
    ) {
      violations.push("PROTECTED_PATH");
    }
  }
  if (
    changedFiles.length > INTEGRITY_POLICY.maximumChangedFiles ||
    addedLines + deletedLines > INTEGRITY_POLICY.maximumChangedLines
  ) {
    violations.push("MUTATION_TOO_LARGE");
  }
  for (const { content } of addedDiffLines(diff)) {
    if (BASE64_PAYLOAD.test(content) || HEX_PAYLOAD.test(content)) {
      violations.push("ENCODED_PAYLOAD");
    }
    if (NETWORK_ADDITION.test(content)) {
      violations.push("NETWORK_TOOL_ADDITION");
    }
    if (SOLUTION_REFERENCE.test(content)) {
      violations.push("SOLUTION_REFERENCE");
    }
    if (BENCHMARK_REFERENCE.test(content)) {
      violations.push("BENCHMARK_ARTIFACT_REFERENCE");
    }
    if (FINGERPRINT_ROUTING.test(content)) {
      violations.push("ENVIRONMENT_FINGERPRINT_ROUTING");
    }
    for (const match of content.matchAll(QUOTED_LITERAL)) {
      if (
        (match.groups?.literal ?? "").length >
        INTEGRITY_POLICY.maximumLiteralLength
      ) {
        violations.push("LARGE_CONSTANT");
      }
    }
  }
  if (violations.length > 0) {
    reject(
      `Candidate failed generic integrity scan (${[
        ...new Set(violations),
      ].sort().join(",")}).`,
    );
  }
}

function parseNumstat(buffer) {
  const entries = buffer.toString("utf8").split("\0").filter(Boolean);
  let addedLines = 0;
  let deletedLines = 0;
  for (const entry of entries) {
    const match = /^(?<added>\d+|-)\t(?<deleted>\d+|-)\t(?<path>.+)$/u.exec(
      entry,
    );
    if (
      match?.groups === undefined ||
      match.groups.added === "-" ||
      match.groups.deleted === "-"
    ) {
      reject("Binary candidate changes are not allowed.");
    }
    addedLines += Number.parseInt(match.groups.added, 10);
    deletedLines += Number.parseInt(match.groups.deleted, 10);
  }
  if (
    !Number.isSafeInteger(addedLines) ||
    !Number.isSafeInteger(deletedLines)
  ) {
    reject("Candidate line accounting overflowed.");
  }
  return { addedLines, deletedLines };
}

function assertIndexModes(context) {
  const entries = git(context, ["ls-files", "--stage", "-z"]).stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const entry of entries) {
    const match =
      /^(?<mode>\d{6}) (?<object>[a-f0-9]{40,64}) (?<stage>[0-3])\t/u.exec(
        entry,
      );
    if (
      match?.groups === undefined ||
      !REGULAR_TREE_MODES.has(match.groups.mode) ||
      match.groups.stage !== "0"
    ) {
      reject("Candidate tree contains a link, submodule, or unresolved entry.");
    }
  }
}

async function archiveState(input) {
  const temporary = await mkdtemp(join(tmpdir(), "df-state-output-"));
  try {
    const sessionRoot = join(input["plugin-data-root"], "sessions");
    for (const [source, name] of [
      [sessionRoot, "plugin-sessions"],
      [input["submission-root"], "optimizer-submissions"],
      [input["audit-root"], "optimizer-audit"],
    ]) {
      await walkNoLinks(source);
      await cp(source, join(temporary, name), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        preserveTimestamps: false,
      });
    }
    run(
      "/usr/bin/tar",
      [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--format=posix",
        "-cf",
        input.state,
        "-C",
        temporary,
        "optimizer-audit",
        "optimizer-submissions",
        "plugin-sessions",
      ],
      { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" } },
    );
    return hashFile(input.state, 512 * 1024 * 1024);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function sealProposal(input) {
  assertIdentity({
    campaign: input.campaign,
    experiment: input.experiment,
    registration: "a".repeat(64),
    "origin-repository-sha256": "b".repeat(64),
  });
  for (const field of [
    "project-root",
    "submission-root",
    "audit-root",
    "plugin-data-root",
    "bundle",
    "diff",
    "state",
    "result",
  ]) {
    assertAbsolutePath(input[field], field);
  }
  if (
    !OBJECT_ID.test(input["source-commit"]) ||
    !SHA256.test(input["source-lock-sha256"]) ||
    !Number.isSafeInteger(Number(input["experiment-number"])) ||
    Number(input["experiment-number"]) < 1
  ) {
    reject("Proposal source or experiment number is invalid.");
  }
  const hypothesisEnvelope = await singleEnvelope(
    input["submission-root"],
    input.campaign,
    "hypothesis",
  );
  const candidateEnvelope = await singleEnvelope(
    input["submission-root"],
    input.campaign,
    "candidate",
  );
  const state = await readSessionState(
    input["plugin-data-root"],
    input["project-root"],
    input.campaign,
  );
  if (
    state.hypothesisSubmitted !== true ||
    state.candidateStaged !== true ||
    state.analysisSubmitted !== false ||
    state.hypothesisReceiptId !==
      hypothesisEnvelope.receipt.receiptId ||
    state.candidateReceiptId !== candidateEnvelope.receipt.receiptId
  ) {
    reject("Proposal session did not produce exactly one staged candidate.");
  }
  const hypothesis = parseHypothesis(hypothesisEnvelope);
  const candidatePayload = parseCandidate(
    candidateEnvelope,
    hypothesisEnvelope.receipt.receiptId,
  );
  const home = await mkdtemp(join(tmpdir(), "df-seal-home-"));
  const context = { repository: input["project-root"], home };
  try {
    const head = text(git(context, ["rev-parse", "HEAD^{commit}"]).stdout);
    if (
      head !== input["source-commit"] ||
      text(git(context, ["remote"]).stdout) !== ""
    ) {
      reject("Candidate workspace source changed or retained a remote.");
    }
    git(context, ["add", "--all", "--"]);
    assertIndexModes(context);
    git(context, ["diff", "--cached", "--check", "--"]);
    const changedFiles = git(context, [
      "diff",
      "--cached",
      "--no-renames",
      "--name-only",
      "-z",
      "--diff-filter=ACDMRTUXB",
      "--",
    ]).stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    if (
      changedFiles.length < 1 ||
      new Set(changedFiles).size !== changedFiles.length
    ) {
      reject("Candidate must contain one unique non-empty change set.");
    }
    const diffBuffer = git(context, [
      "diff",
      "--cached",
      "--no-renames",
      "--no-ext-diff",
      "--full-index",
      "--binary",
      "--",
    ]).stdout;
    if (diffBuffer.byteLength <= 0 || diffBuffer.byteLength > MAX_DIFF_BYTES) {
      reject("Candidate diff size is outside policy.");
    }
    const diff = diffBuffer.toString("utf8");
    const { addedLines, deletedLines } = parseNumstat(
      git(context, [
        "diff",
        "--cached",
        "--no-renames",
        "--numstat",
        "-z",
        "--",
      ]).stdout,
    );
    scanDiff(changedFiles, diff, addedLines, deletedLines);
    const tree = text(git(context, ["write-tree"]).stdout);
    if (!OBJECT_ID.test(tree)) reject("Candidate tree ID is invalid.");
    const lock = git(context, ["show", `${tree}:package-lock.json`]).stdout;
    const lockSha256 = sha256(lock);
    if (lockSha256 !== input["source-lock-sha256"]) {
      reject("Candidate changed the frozen package lock.");
    }
    const timestamp = new Date(
      Date.UTC(2000, 0, 1) +
        Number(input["experiment-number"]) * 1000,
    ).toISOString();
    const message = `Dark Factory candidate ${input.experiment}\n`;
    const commit = text(
      git(
        context,
        ["commit-tree", tree, "-p", input["source-commit"]],
        {
          input: Buffer.from(message, "utf8"),
          env: {
            GIT_AUTHOR_NAME: "Dark Factory",
            GIT_AUTHOR_EMAIL: "dark-factory@invalid",
            GIT_AUTHOR_DATE: timestamp,
            GIT_COMMITTER_NAME: "Dark Factory",
            GIT_COMMITTER_EMAIL: "dark-factory@invalid",
            GIT_COMMITTER_DATE: timestamp,
          },
        },
      ).stdout,
    );
    if (!OBJECT_ID.test(commit) || commit === input["source-commit"]) {
      reject("Candidate commit is invalid.");
    }
    const bundleRef = `refs/heads/df/bundle/${input.experiment}`;
    assertRef(bundleRef, "Candidate bundle");
    const exists = git(context, ["show-ref", "--verify", "--quiet", bundleRef], {
      allowedStatuses: [0, 1],
    }).status;
    if (exists === 0) reject("Candidate bundle ref already exists.");
    git(context, ["update-ref", bundleRef, commit]);
    await writeFile(input.diff, diffBuffer, { flag: "wx", mode: 0o600 });
    git(context, ["bundle", "create", input.bundle, bundleRef]);
    git(context, ["bundle", "verify", input.bundle]);
    const [bundle, diffMetadata, stateMetadata] = await Promise.all([
      hashFile(input.bundle, MAX_ARCHIVE_BYTES),
      hashFile(input.diff, MAX_DIFF_BYTES),
      archiveState(input),
    ]);
    const candidate = {
      commit,
      patchHash: diffMetadata.sha256,
      changedFiles,
      mutationCategory: candidatePayload.mutationCategory,
    };
    const document = withContentHash({
      schemaVersion: 1,
      domain: "dark-factory.optimizer-proposal.v1",
      campaignId: input.campaign,
      experimentId: input.experiment,
      sourceCommit: input["source-commit"],
      candidateCommit: commit,
      candidateTree: tree,
      lockSha256,
      bundleRef,
      hypothesis,
      candidate,
      hypothesisReceiptId: hypothesisEnvelope.receipt.receiptId,
      candidateReceiptId: candidateEnvelope.receipt.receiptId,
      integrityPolicyHash: sha256(canonicalJson(INTEGRITY_POLICY)),
      bundle,
      diff: diffMetadata,
      state: stateMetadata,
    });
    await writeFile(input.result, `${canonicalJson(document)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function parseAnalysis(envelope, state) {
  const payload = envelope.payload;
  exactKeys(
    payload,
    [
      "hypothesisReceiptId",
      "candidateReceiptId",
      "resultHash",
      "evidenceHashes",
      "citedCardIds",
      "support",
      "expectedVersusObserved",
      "regressions",
      "confounders",
      "nextDirection",
      "rollbackRequired",
    ],
    "Analysis payload",
  );
  strings(payload.evidenceHashes, 1, 12, "Analysis evidence hashes");
  strings(payload.citedCardIds, 0, 8, "Analysis card citations");
  strings(payload.regressions, 0, 8, "Analysis regressions");
  strings(payload.confounders, 0, 8, "Analysis confounders");
  if (
    payload.hypothesisReceiptId !== state.hypothesisReceiptId ||
    payload.candidateReceiptId !== state.candidateReceiptId ||
    payload.resultHash !== state.currentResultHash ||
    !new Set(["supported", "not-supported", "inconclusive"]).has(
      payload.support,
    ) ||
    typeof payload.expectedVersusObserved !== "string" ||
    payload.expectedVersusObserved.length < 20 ||
    typeof payload.nextDirection !== "string" ||
    payload.nextDirection.length < 10 ||
    typeof payload.rollbackRequired !== "boolean" ||
    payload.evidenceHashes.some((hash) => !SHA256.test(hash))
  ) {
    reject("Analysis payload does not bind the sealed proposal and result.");
  }
  return payload;
}

async function sealAnalysis(input) {
  assertIdentity({
    campaign: input.campaign,
    experiment: input.experiment,
    registration: "a".repeat(64),
    "origin-repository-sha256": "b".repeat(64),
  });
  for (const field of [
    "project-root",
    "submission-root",
    "audit-root",
    "plugin-data-root",
    "state",
    "result",
  ]) {
    assertAbsolutePath(input[field], field);
  }
  if (!OBJECT_ID.test(input["candidate-commit"])) {
    reject("Analysis candidate commit is malformed.");
  }
  const state = await readSessionState(
    input["plugin-data-root"],
    input["project-root"],
    input.campaign,
  );
  const analysisEnvelope = await singleEnvelope(
    input["submission-root"],
    input.campaign,
    "analysis",
  );
  if (
    state.hypothesisSubmitted !== true ||
    state.candidateStaged !== true ||
    state.currentResultReleased !== true ||
    state.analysisSubmitted !== true ||
    state.analysisReceiptId !== analysisEnvelope.receipt.receiptId
  ) {
    reject("Analysis session did not complete exactly one bound analysis.");
  }
  const payload = parseAnalysis(analysisEnvelope, state);
  const home = await mkdtemp(join(tmpdir(), "df-analysis-home-"));
  const context = { repository: input["project-root"], home };
  try {
    if (
      text(git(context, ["rev-parse", "HEAD^{commit}"]).stdout) !==
        input["candidate-commit"] ||
      text(git(context, ["remote"]).stdout) !== "" ||
      text(
        git(context, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]).stdout,
      ) !== ""
    ) {
      reject("Analysis workspace changed the sealed candidate.");
    }
    const stateMetadata = await archiveState(input);
    const document = withContentHash({
      schemaVersion: 1,
      domain: "dark-factory.optimizer-analysis.v1",
      campaignId: input.campaign,
      experimentId: input.experiment,
      candidateCommit: input["candidate-commit"],
      analysisHash: analysisEnvelope.receipt.payloadHash,
      rollbackRequired: payload.rollbackRequired,
      analysisReceiptId: analysisEnvelope.receipt.receiptId,
      state: stateMetadata,
    });
    await writeFile(input.result, `${canonicalJson(document)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function main() {
  assertCloudRuntime();
  const [operation, ...rest] = process.argv.slice(2);
  if (operation === "setup") {
    const input = parseFlags(rest, {
      phase: true,
      campaign: true,
      experiment: true,
      "source-mode": true,
      registration: true,
      "origin-repository-sha256": true,
      "source-commit": true,
      "source-tree": true,
      "lock-sha256": true,
      "source-ref": true,
      "project-root": true,
      "plugin-archive": true,
      "plugin-archive-sha256": true,
      "plugin-root": true,
      "evidence-archive": true,
      "evidence-archive-sha256": true,
      "evidence-root": true,
      "submission-root": true,
      "audit-root": true,
      "plugin-data-root": true,
      result: true,
      remote: false,
      "source-bundle": false,
      "source-bundle-sha256": false,
      "input-state": false,
      "input-state-sha256": false,
    });
    await setup(input);
    return;
  }
  if (operation === "run-claude") {
    await runClaude(
      parseFlags(rest, {
        phase: true,
        campaign: true,
        experiment: true,
        "command-base64url": true,
        result: true,
      }),
    );
    return;
  }
  if (operation === "seal-proposal") {
    await sealProposal(
      parseFlags(rest, {
        campaign: true,
        experiment: true,
        "experiment-number": true,
        "source-commit": true,
        "source-lock-sha256": true,
        "project-root": true,
        "submission-root": true,
        "audit-root": true,
        "plugin-data-root": true,
        bundle: true,
        diff: true,
        state: true,
        result: true,
      }),
    );
    return;
  }
  if (operation === "seal-analysis") {
    await sealAnalysis(
      parseFlags(rest, {
        campaign: true,
        experiment: true,
        "candidate-commit": true,
        "project-root": true,
        "submission-root": true,
        "audit-root": true,
        "plugin-data-root": true,
        state: true,
        result: true,
      }),
    );
    return;
  }
  reject("Optimizer worker operation is unsupported.");
}

void main().catch(() => {
  process.stderr.write("Optimizer worker failed closed.\n");
  process.exitCode = 78;
});
