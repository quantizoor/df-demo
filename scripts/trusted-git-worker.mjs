#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const CLOUD_MARKER_GROUPS = [
  ["DAYTONA_SANDBOX_ID", "DAYTONA_WORKSPACE_ID"],
  ["E2B_SANDBOX_ID"],
  ["MODAL_TASK_ID", "MODAL_SANDBOX_ID"],
];
const SAFE_MARKER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const EXPERIMENT_ID = /^[0-9]{3,8}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const SAFE_HEAD_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u;
const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const REGULAR_TREE_MODES = new Set(["100644", "100755"]);
const OFFICIAL_UPSTREAM = "https://github.com/earendil-works/pi.git";
const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const HARNESS_REGISTRATION_SCHEMA_VERSION = "1.2.0";
const PI_ADAPTER_ID = "harbor-pi-print-json";
const PI_ADAPTER_EXECUTION_MODE = "print-json";
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_GITHUB_API_BYTES = 1024 * 1024;
const MAX_SOURCE_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;
const SOURCE_BUNDLE_REF = "refs/heads/df/bundle/000-source-snapshot";
const GIT_TIMEOUT_MS = 15 * 60_000;

class WorkerPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkerPolicyError";
  }
}

function reject(message) {
  throw new WorkerPolicyError(message);
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject("Canonical JSON number is invalid.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
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
    contentHash: createHash("sha256").update(canonicalJson(document)).digest("hex"),
  };
}

function parseFlags(argv, expectedFlags) {
  const expected = new Set(expectedFlags);
  const values = new Map();
  if (argv.length !== expected.size * 2) {
    reject("Trusted Git worker arguments are incomplete.");
  }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      typeof flag !== "string" ||
      typeof value !== "string" ||
      !flag.startsWith("--") ||
      !expected.has(flag.slice(2)) ||
      values.has(flag.slice(2)) ||
      value.includes("\u0000") ||
      value.includes("\r") ||
      value.includes("\n")
    ) {
      reject("Trusted Git worker received an unsupported argument.");
    }
    values.set(flag.slice(2), value);
  }
  return Object.fromEntries(values);
}

function assertCloudRuntime() {
  if (process.env.DF_CLOUD_EXECUTION !== "1") {
    reject("Trusted Git worker is cloud-only.");
  }
  const activeGroups = CLOUD_MARKER_GROUPS.filter((group) =>
    group.some((name) => process.env[name] !== undefined),
  );
  if (activeGroups.length !== 1) {
    reject("Trusted Git worker requires one cloud provider marker.");
  }
  const values = activeGroups[0]
    .map((name) => process.env[name])
    .filter((value) => value !== undefined);
  if (values.length === 0 || values.some((value) => !SAFE_MARKER.test(value))) {
    reject("Trusted Git worker cloud marker is malformed.");
  }
}

function assertRef(ref, expected) {
  const components = ref.slice("refs/heads/".length).split("/");
  if (
    !SAFE_HEAD_REF.test(ref) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock") ||
    components.some(
      (component) =>
        component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock"),
    ) ||
    (expected !== undefined && ref !== expected)
  ) {
    reject("Trusted Git ref is outside the authorized namespace.");
  }
}

function parseRemoteIdentity(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    reject("Trusted Git remote URL is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    reject("Trusted Git remote URL violates transport policy.");
  }
  const match =
    /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})\.git$/u.exec(
      parsed.pathname,
    );
  if (match?.[1] === undefined || match[2] === undefined) {
    reject("Trusted Git remote repository identity is malformed.");
  }
  const repository = `${match[1]}/${match[2]}`;
  return {
    owner: match[1],
    name: match[2],
    repository,
    normalizedUrl: `https://github.com/${repository}.git`,
    repositorySha256: createHash("sha256").update(`github.com/${repository}`).digest("hex"),
  };
}

function assertIdentities(input) {
  const origin = parseRemoteIdentity(input.remote);
  const upstream = parseRemoteIdentity(input.upstream);
  if (
    !SHA256.test(input["origin-repository-sha256"]) ||
    origin.repositorySha256 !== input["origin-repository-sha256"] ||
    !SHA256.test(input["upstream-repository-sha256"]) ||
    upstream.repositorySha256 !== input["upstream-repository-sha256"] ||
    upstream.normalizedUrl !== OFFICIAL_UPSTREAM ||
    origin.repositorySha256 === upstream.repositorySha256
  ) {
    reject("Trusted Git remote identity does not match its registration.");
  }
  return { origin, upstream };
}

function text(buffer) {
  return buffer.toString("utf8").trim();
}

function gitEnvironment(home, askpass, token, extra = {}) {
  return {
    HOME: home,
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS_REQUIRE: "force",
    GIT_ASKPASS: askpass,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_ALLOW_PROTOCOL: "https:file",
    GIT_LFS_SKIP_SMUDGE: "1",
    DF_GITHUB_TOKEN: token,
    ...extra,
  };
}

function runGit(context, arguments_, options = {}) {
  if (
    !Array.isArray(arguments_) ||
    arguments_.length === 0 ||
    arguments_.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.includes("\u0000") ||
        argument.includes("\r") ||
        argument.includes("\n"),
    )
  ) {
    reject("Trusted Git attempted an unsafe invocation.");
  }
  const result = spawnSync("/usr/bin/git", arguments_, {
    cwd: context.repository,
    env: gitEnvironment(context.home, context.askpass, context.token, options.environment),
    encoding: null,
    input: options.input,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  const allowedStatuses = options.allowedStatuses ?? [0];
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status === null ||
    !allowedStatuses.includes(result.status) ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr)
  ) {
    reject("Trusted Git subprocess failed closed.");
  }
  return {
    status: result.status,
    stdout: result.stdout,
  };
}

async function sha256File(path, maximumBytes) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > maximumBytes
  ) {
    reject("Trusted Git artifact is not a bounded regular file.");
  }
  const digest = createHash("sha256");
  const handle = await open(path, "r");
  let byteLength = 0;
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    ) {
      reject("Trusted Git artifact changed before hashing.");
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length);
      if (bytesRead === 0) break;
      byteLength += bytesRead;
      if (byteLength > maximumBytes) {
        reject("Trusted Git artifact exceeded its byte ceiling.");
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (
      after.dev !== metadata.dev ||
      after.ino !== metadata.ino ||
      after.size !== metadata.size ||
      after.mtimeMs !== metadata.mtimeMs ||
      byteLength !== metadata.size
    ) {
      reject("Trusted Git artifact changed during hashing.");
    }
  } finally {
    await handle.close();
  }
  return {
    byteLength,
    sha256: digest.digest("hex"),
  };
}

async function assertInputFile(path, suffix, maximumBytes) {
  if (
    !isAbsolute(path) ||
    path.includes("\u0000") ||
    !SAFE_FILE_NAME.test(basename(path)) ||
    !path.endsWith(suffix)
  ) {
    reject("Trusted Git input path is unsafe.");
  }
  const resolved = resolve(path);
  const canonical = await realpath(path);
  if (canonical !== resolved) {
    reject("Trusted Git input cannot be a link.");
  }
  return sha256File(canonical, maximumBytes);
}

async function assertNewOutput(path, suffix) {
  if (
    !isAbsolute(path) ||
    path.includes("\u0000") ||
    !SAFE_FILE_NAME.test(basename(path)) ||
    !path.endsWith(suffix)
  ) {
    reject("Trusted Git output path is unsafe.");
  }
  const resolved = resolve(path);
  const parent = await realpath(dirname(resolved));
  const parentRelative = relative(parent, resolved);
  if (
    parentRelative === "" ||
    parentRelative === ".." ||
    parentRelative.startsWith(`..${sep}`) ||
    isAbsolute(parentRelative)
  ) {
    reject("Trusted Git output escapes its trusted directory.");
  }
  try {
    await lstat(resolved);
    reject("Trusted Git output must not already exist.");
  } catch (error) {
    if (error instanceof WorkerPolicyError) throw error;
    if (error?.code !== "ENOENT") reject("Trusted Git output could not be inspected.");
  }
  return { parent, resolved };
}

async function createContext() {
  const token = process.env.DF_GITHUB_TOKEN;
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 2_048 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Credential material must reject NUL and line breaks before reaching Git.
    /[\u0000\r\n]/u.test(token)
  ) {
    reject("Trusted Git credential grant is absent or malformed.");
  }
  delete process.env.DF_GITHUB_TOKEN;
  const root = await mkdtemp(join(tmpdir(), "df-trusted-git-"));
  await chmod(root, 0o700);
  const home = join(root, "home");
  const repository = join(root, "repository");
  const askpass = join(root, "askpass.mjs");
  await writeFile(
    askpass,
    [
      "#!/usr/bin/env node",
      'const prompt = process.argv[2] ?? "";',
      'if (prompt.includes("Username")) process.stdout.write("x-access-token\\n");',
      'else if (prompt.includes("Password"))',
      '  process.stdout.write(`${process.env.DF_GITHUB_TOKEN ?? ""}\\n`);',
      "else process.exit(1);",
      "",
    ].join("\n"),
    { encoding: "utf8", flag: "wx", mode: 0o700 },
  );
  await chmod(askpass, 0o700);
  await writeFile(join(root, ".allocation"), "trusted-git-v1\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(repository, { mode: 0o700 })]);
  const context = { root, home, repository, askpass, token };
  runGit(context, ["init", "--quiet"]);
  for (const [name, value] of [
    ["core.hooksPath", "/dev/null"],
    ["credential.helper", ""],
    ["fetch.fsckObjects", "true"],
    ["receive.fsckObjects", "true"],
    ["transfer.fsckObjects", "true"],
    ["user.name", "Dark Factory"],
    ["user.email", "dark-factory@invalid"],
  ]) {
    runGit(context, ["config", "--local", name, value]);
  }
  return context;
}

function readGitHubRepositoryAuthorization(context, identity, expectedBranch) {
  return new Promise((resolveAuthorization, rejectAuthorization) => {
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: "api.github.com",
        port: 443,
        method: "GET",
        path: `/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.name)}`,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + context.token,
          "User-Agent": "dark-factory-trusted-git-registration",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        agent: false,
      },
      (response) => {
        const contentType = response.headers["content-type"];
        const contentLength = Number(response.headers["content-length"]);
        if (
          response.statusCode !== 200 ||
          typeof contentType !== "string" ||
          !/^application\/(?:json|vnd\.github\+json)(?:;|$)/u.test(contentType) ||
          (Number.isFinite(contentLength) &&
            (contentLength <= 0 || contentLength > MAX_GITHUB_API_BYTES))
        ) {
          response.resume();
          rejectAuthorization(
            new WorkerPolicyError("GitHub repository authorization could not be verified."),
          );
          return;
        }
        const chunks = [];
        let byteLength = 0;
        response.on("aborted", () => {
          rejectAuthorization(
            new WorkerPolicyError("GitHub repository authorization response was interrupted."),
          );
        });
        response.on("error", () => {
          rejectAuthorization(
            new WorkerPolicyError("GitHub repository authorization response failed."),
          );
        });
        response.on("data", (chunk) => {
          if (!Buffer.isBuffer(chunk)) {
            request.destroy(
              new WorkerPolicyError("GitHub repository authorization response is malformed."),
            );
            return;
          }
          byteLength += chunk.length;
          if (byteLength > MAX_GITHUB_API_BYTES) {
            request.destroy(
              new WorkerPolicyError("GitHub repository authorization response is too large."),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          let document;
          try {
            document = JSON.parse(Buffer.concat(chunks, byteLength).toString("utf8"));
          } catch {
            rejectAuthorization(
              new WorkerPolicyError("GitHub repository authorization response is invalid."),
            );
            return;
          }
          const permissions = document?.permissions;
          const owner = document?.owner;
          if (
            document === null ||
            typeof document !== "object" ||
            Array.isArray(document) ||
            !Number.isSafeInteger(document.id) ||
            document.id <= 0 ||
            typeof document.node_id !== "string" ||
            document.node_id.length === 0 ||
            document.node_id.length > 255 ||
            typeof document.name !== "string" ||
            document.name.toLowerCase() !== identity.name.toLowerCase() ||
            typeof document.full_name !== "string" ||
            document.full_name.toLowerCase() !== identity.repository.toLowerCase() ||
            typeof document.clone_url !== "string" ||
            document.clone_url.toLowerCase() !== identity.normalizedUrl.toLowerCase() ||
            document.private !== true ||
            document.visibility !== "private" ||
            document.archived !== false ||
            document.disabled !== false ||
            document.default_branch !== expectedBranch ||
            permissions === null ||
            typeof permissions !== "object" ||
            Array.isArray(permissions) ||
            permissions.pull !== true ||
            permissions.push !== true ||
            owner === null ||
            typeof owner !== "object" ||
            Array.isArray(owner) ||
            typeof owner.login !== "string" ||
            owner.login.toLowerCase() !== identity.owner.toLowerCase()
          ) {
            rejectAuthorization(
              new WorkerPolicyError(
                "GitHub repository is not the authorized private writable origin.",
              ),
            );
            return;
          }
          const attestation = {
            provider: "github",
            repositoryId: document.id,
            repositoryNodeId: document.node_id,
            ownerNodeId: typeof owner.node_id === "string" ? owner.node_id : null,
            private: true,
            visibility: "private",
            pull: true,
            push: true,
            archived: false,
            disabled: false,
            defaultBranch: expectedBranch,
          };
          resolveAuthorization({
            repositoryAttestationHash: createHash("sha256")
              .update(canonicalJson(attestation))
              .digest("hex"),
            verifiedAt: new Date().toISOString(),
          });
        });
      },
    );
    request.setTimeout(30_000, () => {
      request.destroy(new WorkerPolicyError("GitHub repository authorization request timed out."));
    });
    request.on("error", (error) => {
      rejectAuthorization(
        error instanceof WorkerPolicyError
          ? error
          : new WorkerPolicyError("GitHub repository authorization request failed."),
      );
    });
    request.end();
  });
}

function parseSingleRemoteRef(output, expectedRef) {
  const lines = text(output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) {
    reject("Trusted Git remote ref is absent or ambiguous.");
  }
  const parts = lines[0].split(/\s+/u);
  if (
    parts.length !== 2 ||
    parts[0] === undefined ||
    parts[1] !== expectedRef ||
    !OBJECT_ID.test(parts[0])
  ) {
    reject("Trusted Git remote ref response is malformed.");
  }
  return parts[0];
}

function readRemoteRef(context, remote, ref, allowMissing = false) {
  const result = runGit(context, ["ls-remote", "--refs", remote, ref], { allowedStatuses: [0] });
  if (text(result.stdout).length === 0 && allowMissing) return null;
  return parseSingleRemoteRef(result.stdout, ref);
}

function readRemoteHead(context, remote) {
  return parseSingleRemoteRef(runGit(context, ["ls-remote", remote, "HEAD"]).stdout, "HEAD");
}

function verifyCommit(context, input, localRef) {
  const commit = text(runGit(context, ["rev-parse", "--verify", `${localRef}^{commit}`]).stdout);
  const tree = text(runGit(context, ["rev-parse", "--verify", `${commit}^{tree}`]).stdout);
  if (
    commit !== input.commit ||
    tree !== input.tree ||
    !OBJECT_ID.test(commit) ||
    !OBJECT_ID.test(tree)
  ) {
    reject("Trusted Git commit or tree does not match authorization.");
  }
  const lock = runGit(context, ["show", `${commit}:package-lock.json`]).stdout;
  if (createHash("sha256").update(lock).digest("hex") !== input["lock-sha256"]) {
    reject("Trusted Git package lock does not match authorization.");
  }
  let packageMetadata;
  try {
    packageMetadata = JSON.parse(
      runGit(context, ["show", `${commit}:packages/coding-agent/package.json`]).stdout.toString(
        "utf8",
      ),
    );
  } catch {
    reject("Trusted Git Pi package metadata is invalid.");
  }
  if (packageMetadata?.name !== "@earendil-works/pi-coding-agent") {
    reject("Trusted Git commit is not the registered Pi harness.");
  }
  const treeEntries = text(runGit(context, ["ls-tree", "-r", input.commit]).stdout)
    .split("\n")
    .filter((line) => line.length > 0);
  if (treeEntries.length === 0 || treeEntries.length > 200_000) {
    reject("Trusted Git tree entry count is outside policy.");
  }
  for (const entry of treeEntries) {
    const match = /^([0-7]{6}) (?:blob|tree|commit) [a-f0-9]{40}(?:[a-f0-9]{24})?\t(.+)$/u.exec(
      entry,
    );
    if (
      match?.[1] === undefined ||
      match[2] === undefined ||
      match[2].includes("\u0000") ||
      match[2].includes("\\") ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Git tree paths are untrusted and must reject every ASCII control byte.
      /[\u0000-\u001f\u007f]/u.test(match[2]) ||
      match[2].split("/").some((part) => part === "" || part === "." || part === "..") ||
      !REGULAR_TREE_MODES.has(match[1])
    ) {
      reject("Trusted Git tree contains an unsafe path, link, or gitlink.");
    }
    if (basename(match[2]) === ".gitattributes") {
      const attributes = runGit(context, ["show", `${input.commit}:${match[2]}`]).stdout.toString(
        "utf8",
      );
      if (/\bexport-(?:ignore|subst)\b/u.test(attributes)) {
        reject("Trusted Git archive attributes can alter exported source.");
      }
    }
  }
  return { commit, tree };
}

function verifyRegistrationPackageMetadata(context, input) {
  const packageBytes = runGit(context, [
    "show",
    `${input.commit}:packages/coding-agent/package.json`,
  ]).stdout;
  const lockBytes = runGit(context, ["show", `${input.commit}:package-lock.json`]).stdout;
  let packageMetadata;
  let lockMetadata;
  try {
    packageMetadata = JSON.parse(packageBytes.toString("utf8"));
    lockMetadata = JSON.parse(lockBytes.toString("utf8"));
  } catch {
    reject("Trusted Git Pi package metadata is invalid.");
  }
  const lockedPackage = lockMetadata?.packages?.["packages/coding-agent"];
  if (
    input["package-name"] !== PI_CODING_AGENT_PACKAGE ||
    packageMetadata?.name !== input["package-name"] ||
    packageMetadata?.version !== input["package-version"] ||
    lockedPackage?.name !== input["package-name"] ||
    lockedPackage?.version !== input["package-version"]
  ) {
    reject("Trusted Git Pi package metadata does not match its authorization.");
  }
  return createHash("sha256").update(packageBytes).digest("hex");
}

function verifyLineage(context, input, candidateRef) {
  for (const objectId of [input.baseline, input["upstream-head"], input["upstream-base"]]) {
    if (!OBJECT_ID.test(objectId)) {
      reject("Trusted Git lineage object identifier is malformed.");
    }
  }
  runGit(context, ["merge-base", "--is-ancestor", input.baseline, candidateRef]);
  const mergeBase = text(runGit(context, ["merge-base", candidateRef, "refs/df/upstream"]).stdout);
  if (mergeBase !== input["upstream-base"]) {
    reject("Trusted Git upstream lineage changed.");
  }
}

function addVerifiedRemotes(context, input, identities) {
  runGit(context, ["remote", "add", "origin", identities.origin.normalizedUrl]);
  runGit(context, ["remote", "add", "upstream", identities.upstream.normalizedUrl]);
  const upstreamHead = readRemoteHead(context, "upstream");
  if (upstreamHead !== input["upstream-head"]) {
    reject("Trusted Git upstream HEAD changed after registration.");
  }
  runGit(context, [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    "--filter=blob:none",
    "upstream",
    "HEAD:refs/df/upstream",
  ]);
  const fetchedUpstream = text(
    runGit(context, ["rev-parse", "--verify", "refs/df/upstream^{commit}"]).stdout,
  );
  if (fetchedUpstream !== input["upstream-head"]) {
    reject("Trusted Git fetched an unexpected upstream object.");
  }
}

function assertUpstreamStable(context, expectedHead) {
  if (readRemoteHead(context, "upstream") !== expectedHead) {
    reject("Trusted Git upstream moved during the operation.");
  }
}

async function register(input) {
  if (
    !SHA256.test(input["authorization-sha256"]) ||
    !OBJECT_ID.test(input.commit) ||
    !OBJECT_ID.test(input.tree) ||
    !SHA256.test(input["lock-sha256"]) ||
    input["package-name"] !== PI_CODING_AGENT_PACKAGE ||
    !EXACT_SEMVER.test(input["package-version"]) ||
    input["harness-registration-schema-version"] !== HARNESS_REGISTRATION_SCHEMA_VERSION ||
    input["adapter-id"] !== PI_ADAPTER_ID ||
    input["adapter-execution-mode"] !== PI_ADAPTER_EXECUTION_MODE ||
    input["sessions-disabled"] !== "true" ||
    input["uncontrolled-extensions-disabled"] !== "true" ||
    input["uncontrolled-context-files-disabled"] !== "true" ||
    !Number.isFinite(Date.parse(input["authorization-expires-at"])) ||
    new Date(input["authorization-expires-at"]).toISOString() !==
      input["authorization-expires-at"] ||
    Date.now() >= Date.parse(input["authorization-expires-at"])
  ) {
    reject("Trusted Git registration authorization is malformed or expired.");
  }
  assertRef(input.ref);
  const identities = assertIdentities(input);
  const expectedBranch = input.ref.slice("refs/heads/".length);
  const resultOutput = await assertNewOutput(input.result, ".json");
  const context = await createContext();
  try {
    const initialProviderAuthorization = await readGitHubRepositoryAuthorization(
      context,
      identities.origin,
      expectedBranch,
    );
    runGit(context, ["remote", "add", "origin", identities.origin.normalizedUrl]);
    runGit(context, ["remote", "add", "upstream", identities.upstream.normalizedUrl]);
    const upstreamHead = readRemoteHead(context, "upstream");
    if (!OBJECT_ID.test(upstreamHead)) {
      reject("Trusted Git canonical upstream HEAD is malformed.");
    }
    if (readRemoteRef(context, "origin", input.ref) !== input.commit) {
      reject("Trusted Git registered branch does not resolve to its authorized commit.");
    }
    runGit(context, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "origin",
      `${input.ref}:refs/df/baseline`,
    ]);
    runGit(context, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--filter=blob:none",
      "upstream",
      "HEAD:refs/df/upstream",
    ]);
    const fetchedUpstream = text(
      runGit(context, ["rev-parse", "--verify", "refs/df/upstream^{commit}"]).stdout,
    );
    if (fetchedUpstream !== upstreamHead) {
      reject("Trusted Git fetched an unexpected canonical upstream object.");
    }
    verifyCommit(context, input, "refs/df/baseline");
    const packageJsonSha256 = verifyRegistrationPackageMetadata(context, input);
    const upstreamBase = text(
      runGit(context, ["merge-base", "refs/df/baseline", "refs/df/upstream"]).stdout,
    );
    if (!OBJECT_ID.test(upstreamBase)) {
      reject("Trusted Git private origin has no canonical upstream merge base.");
    }
    runGit(context, ["merge-base", "--is-ancestor", upstreamBase, "refs/df/baseline"]);
    runGit(context, ["fsck", "--full", "--strict", "--no-reflogs"]);
    if (readRemoteRef(context, "origin", input.ref) !== input.commit) {
      reject("Trusted Git registered branch moved during verification.");
    }
    assertUpstreamStable(context, upstreamHead);
    const finalProviderAuthorization = await readGitHubRepositoryAuthorization(
      context,
      identities.origin,
      expectedBranch,
    );
    if (
      finalProviderAuthorization.repositoryAttestationHash !==
      initialProviderAuthorization.repositoryAttestationHash
    ) {
      reject("GitHub repository authorization changed during registration.");
    }
    if (Date.now() >= Date.parse(input["authorization-expires-at"])) {
      reject("Trusted Git registration authorization expired during use.");
    }
    const originRepositoryHash = input["origin-repository-sha256"];
    const upstreamRepositoryHash = input["upstream-repository-sha256"];
    const registrationId = createHash("sha256")
      .update(`${input.commit}:${originRepositoryHash}:${upstreamBase}`)
      .digest("hex");
    const lineageAttestationHash = createHash("sha256")
      .update(
        canonicalJson({
          originRepositoryHash,
          upstreamRepositoryHash,
          upstreamHeadCommit: upstreamHead,
          upstreamBaseCommit: upstreamBase,
          baselineCommit: input.commit,
        }),
      )
      .digest("hex");
    const result = withContentHash({
      schemaVersion: 1,
      domain: "dark-factory.trusted-git-registration.v1",
      authorizationHash: input["authorization-sha256"],
      registrationId,
      originRepositoryHash,
      upstreamRepositoryHash,
      remoteRef: input.ref,
      commitSha: input.commit,
      treeSha: input.tree,
      lockSha256: input["lock-sha256"],
      packageName: input["package-name"],
      packageVersion: input["package-version"],
      harnessRegistrationSchemaVersion: input["harness-registration-schema-version"],
      adapterId: input["adapter-id"],
      adapterExecutionMode: input["adapter-execution-mode"],
      sessionsDisabled: true,
      uncontrolledExtensionsDisabled: true,
      uncontrolledContextFilesDisabled: true,
      packageJsonSha256,
      upstreamHeadCommit: upstreamHead,
      upstreamBaseCommit: upstreamBase,
      originPrivate: true,
      originFetchable: true,
      originWritable: true,
      privacyEvidence: "github-rest-private-and-visibility",
      fetchEvidence: "authenticated-ls-remote-and-fetch",
      writeEvidence: "github-rest-permissions-push",
      lineageEvidence: "canonical-upstream-fetched-merge-base",
      providerRepositoryAttestationHash: finalProviderAuthorization.repositoryAttestationHash,
      lineageAttestationHash,
      providerVerifiedAt: finalProviderAuthorization.verifiedAt,
    });
    await writeFile(resultOutput.resolved, `${canonicalJson(result)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    await unlink(resultOutput.resolved).catch(() => undefined);
    throw error;
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
}

async function snapshot(input) {
  if (
    input["archive-format"] !== "git-archive-tar" ||
    input.compression !== "none" ||
    input["bundle-ref"] !== SOURCE_BUNDLE_REF ||
    !OBJECT_ID.test(input.commit) ||
    !OBJECT_ID.test(input.tree) ||
    !SHA256.test(input["lock-sha256"])
  ) {
    reject("Trusted Git source target is malformed.");
  }
  assertRef(input.ref);
  const identities = assertIdentities(input);
  const archiveOutput = await assertNewOutput(input.archive, ".tar");
  const bundleOutput = await assertNewOutput(input.bundle, ".bundle");
  const manifestOutput = await assertNewOutput(input.manifest, ".json");
  if (
    new Set([archiveOutput.resolved, bundleOutput.resolved, manifestOutput.resolved]).size !== 3
  ) {
    reject("Trusted Git source outputs overlap.");
  }
  if (
    archiveOutput.parent !== bundleOutput.parent ||
    archiveOutput.parent !== manifestOutput.parent
  ) {
    reject("Trusted Git source outputs must share one trusted directory.");
  }
  const context = await createContext();
  let archivePublished = false;
  let bundlePublished = false;
  try {
    addVerifiedRemotes(context, input, identities);
    const remoteCommit = readRemoteRef(context, "origin", input.ref);
    if (remoteCommit !== input.commit) {
      reject("Trusted Git source ref does not resolve to the requested commit.");
    }
    runGit(context, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "origin",
      `${input.ref}:refs/df/target`,
    ]);
    verifyCommit(context, input, "refs/df/target");
    verifyLineage(context, input, "refs/df/target");
    runGit(context, ["fsck", "--full", "--strict", "--no-reflogs"]);

    const outputStaging = await mkdtemp(join(archiveOutput.parent, ".df-source-"));
    await chmod(outputStaging, 0o700);
    const stagedArchive = join(outputStaging, "source.tar");
    const stagedBundle = join(outputStaging, "source.bundle");
    try {
      runGit(context, ["archive", "--format=tar", `--output=${stagedArchive}`, input.commit], {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      const archive = await sha256File(stagedArchive, MAX_SOURCE_ARCHIVE_BYTES);
      if (archive.byteLength % 512 !== 0) {
        reject("Trusted Git source archive is not an uncompressed tar stream.");
      }
      runGit(context, ["update-ref", SOURCE_BUNDLE_REF, input.commit]);
      runGit(context, ["bundle", "create", "--version=2", stagedBundle, SOURCE_BUNDLE_REF], {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      parseBundleHeads(
        runGit(context, ["bundle", "list-heads", stagedBundle]).stdout,
        SOURCE_BUNDLE_REF,
        input.commit,
      );
      runGit(context, ["bundle", "verify", stagedBundle], {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      const bundle = await sha256File(stagedBundle, MAX_BUNDLE_BYTES);
      if (readRemoteRef(context, "origin", input.ref) !== input.commit) {
        reject("Trusted Git source ref moved during archiving.");
      }
      assertUpstreamStable(context, input["upstream-head"]);
      await link(stagedArchive, archiveOutput.resolved);
      archivePublished = true;
      await link(stagedBundle, bundleOutput.resolved);
      bundlePublished = true;
      const publishedArchive = await sha256File(archiveOutput.resolved, MAX_SOURCE_ARCHIVE_BYTES);
      if (
        publishedArchive.sha256 !== archive.sha256 ||
        publishedArchive.byteLength !== archive.byteLength
      ) {
        reject("Trusted Git source archive changed while it was published.");
      }
      const publishedBundle = await sha256File(bundleOutput.resolved, MAX_BUNDLE_BYTES);
      if (
        publishedBundle.sha256 !== bundle.sha256 ||
        publishedBundle.byteLength !== bundle.byteLength
      ) {
        reject("Trusted Git source bundle changed while it was published.");
      }
      const manifest = withContentHash({
        schemaVersion: 2,
        domain: "dark-factory.trusted-git-source.v2",
        originRepositoryHash: input["origin-repository-sha256"],
        upstreamRepositoryHash: input["upstream-repository-sha256"],
        upstreamHeadCommit: input["upstream-head"],
        upstreamBaseCommit: input["upstream-base"],
        baselineCommit: input.baseline,
        remoteRef: input.ref,
        commitSha: input.commit,
        treeSha: input.tree,
        lockSha256: input["lock-sha256"],
        archiveMethod: "git-archive-format-tar",
        compression: "none",
        archiveSha256: archive.sha256,
        archiveByteLength: archive.byteLength,
        bundleMethod: "git-bundle-v2",
        bundleRef: SOURCE_BUNDLE_REF,
        bundleSha256: bundle.sha256,
        bundleByteLength: bundle.byteLength,
      });
      await writeFile(manifestOutput.resolved, `${canonicalJson(manifest)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } finally {
      await rm(outputStaging, { recursive: true, force: true });
    }
  } catch (error) {
    if (archivePublished) {
      await unlink(archiveOutput.resolved).catch(() => undefined);
    }
    if (bundlePublished) {
      await unlink(bundleOutput.resolved).catch(() => undefined);
    }
    await unlink(manifestOutput.resolved).catch(() => undefined);
    throw error;
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
}

function parseBundleHeads(output, expectedRef, expectedCommit) {
  const lines = text(output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) {
    reject("Git bundle must expose exactly one authorized head.");
  }
  const parts = lines[0].split(/\s+/u);
  if (parts.length !== 2 || parts[0] !== expectedCommit || parts[1] !== expectedRef) {
    reject("Git bundle head does not match authorization.");
  }
}

function existingTagState(context, tagRef) {
  const tagObject = readRemoteRef(context, "origin", tagRef, true);
  if (tagObject === null) return null;
  const peeledRef = `${tagRef}^{}`;
  const peeled = parseSingleRemoteRef(
    runGit(context, ["ls-remote", "origin", peeledRef]).stdout,
    peeledRef,
  );
  return { tagObject, peeled };
}

function assertPublishedRefs(context, input, tagObject) {
  const branch = readRemoteRef(context, "origin", input["branch-ref"]);
  const tag = existingTagState(context, input["tag-ref"]);
  if (
    branch !== input.commit ||
    tag === null ||
    tag.tagObject !== tagObject ||
    tag.peeled !== input.commit
  ) {
    reject("Trusted Git publication could not verify the exact remote refs.");
  }
}

async function publish(input) {
  const expectedBranch = `refs/heads/df/experiment/${input.experiment}`;
  const expectedTag = `refs/tags/df/experiment/${input.experiment}/candidate`;
  if (
    !EXPERIMENT_ID.test(input.experiment) ||
    Number.parseInt(input.experiment.split("-", 1)[0] ?? "", 10) < 1 ||
    input.mode !== "atomic-non-force" ||
    input["branch-ref"] !== expectedBranch ||
    input["tag-ref"] !== expectedTag ||
    input["base-ref"] === expectedBranch ||
    !OBJECT_ID.test(input.baseline) ||
    !OBJECT_ID.test(input.base) ||
    !OBJECT_ID.test(input.commit) ||
    !OBJECT_ID.test(input.tree) ||
    input.base === input.commit ||
    !SHA256.test(input["lock-sha256"]) ||
    !SHA256.test(input["bundle-sha256"]) ||
    !Number.isFinite(Date.parse(input["tag-timestamp"])) ||
    new Date(input["tag-timestamp"]).toISOString() !== input["tag-timestamp"] ||
    Date.parse(input["tag-timestamp"]) > Date.now() ||
    !Number.isFinite(Date.parse(input["authorization-expires-at"])) ||
    new Date(input["authorization-expires-at"]).toISOString() !==
      input["authorization-expires-at"] ||
    Date.now() >= Date.parse(input["authorization-expires-at"])
  ) {
    reject("Trusted Git publication authorization is malformed.");
  }
  assertRef(input["branch-ref"], expectedBranch);
  assertRef(input["base-ref"]);
  const tagAsHead = input["tag-ref"].replace(/^refs\/tags\//u, "refs/heads/");
  assertRef(tagAsHead, tagAsHead);
  const identities = assertIdentities(input);
  const bundle = await assertInputFile(input.bundle, ".bundle", MAX_BUNDLE_BYTES);
  if (bundle.sha256 !== input["bundle-sha256"]) {
    reject("Candidate bundle digest changed before publication.");
  }
  const resultOutput = await assertNewOutput(input.result, ".json");
  const context = await createContext();
  try {
    addVerifiedRemotes(context, input, identities);
    runGit(context, ["bundle", "verify", input.bundle]);
    const bundleRef = `refs/heads/df/bundle/${input.experiment}`;
    parseBundleHeads(
      runGit(context, ["bundle", "list-heads", input.bundle]).stdout,
      bundleRef,
      input.commit,
    );
    runGit(context, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      input.bundle,
      `${bundleRef}:refs/df/candidate`,
    ]);
    verifyCommit(context, input, "refs/df/candidate");
    runGit(context, ["merge-base", "--is-ancestor", input.base, "refs/df/candidate"]);
    verifyLineage(context, input, "refs/df/candidate");
    runGit(context, ["fsck", "--full", "--strict", "--no-reflogs"]);

    if (readRemoteRef(context, "origin", input["base-ref"]) !== input.base) {
      reject("Candidate base ref moved before publication.");
    }

    const shortTag = input["tag-ref"].slice("refs/tags/".length);
    runGit(
      context,
      [
        "tag",
        "--annotate",
        shortTag,
        "--message",
        `Dark Factory candidate ${input.experiment}`,
        input.commit,
      ],
      {
        environment: {
          GIT_COMMITTER_DATE: input["tag-timestamp"],
        },
      },
    );
    const tagObject = text(
      runGit(context, ["rev-parse", "--verify", `${input["tag-ref"]}^{tag}`]).stdout,
    );
    if (!OBJECT_ID.test(tagObject)) {
      reject("Trusted Git deterministic tag object is invalid.");
    }

    const existingBranch = readRemoteRef(context, "origin", input["branch-ref"], true);
    const existingTag = existingTagState(context, input["tag-ref"]);
    if (
      (existingBranch !== null && existingBranch !== input.commit) ||
      (existingTag !== null &&
        (existingTag.tagObject !== tagObject || existingTag.peeled !== input.commit))
    ) {
      reject("Trusted Git publication ref already has conflicting content.");
    }
    if (Date.now() >= Date.parse(input["authorization-expires-at"])) {
      reject("Trusted Git publication authorization expired before push.");
    }
    const bundleBeforePush = await sha256File(input.bundle, MAX_BUNDLE_BYTES);
    if (
      bundleBeforePush.sha256 !== bundle.sha256 ||
      bundleBeforePush.byteLength !== bundle.byteLength
    ) {
      reject("Candidate bundle changed during publication.");
    }
    if (readRemoteRef(context, "origin", input["base-ref"]) !== input.base) {
      reject("Candidate base ref moved during publication.");
    }
    assertUpstreamStable(context, input["upstream-head"]);

    let disposition = "already-published";
    if (existingBranch === null || existingTag === null) {
      runGit(context, [
        "push",
        "--atomic",
        "origin",
        `refs/df/candidate:${input["branch-ref"]}`,
        `${input["tag-ref"]}:${input["tag-ref"]}`,
      ]);
      disposition = "published";
    }
    assertPublishedRefs(context, input, tagObject);

    const result = withContentHash({
      schemaVersion: 1,
      domain: "dark-factory.trusted-git-publication.v1",
      originRepositoryHash: input["origin-repository-sha256"],
      upstreamRepositoryHash: input["upstream-repository-sha256"],
      upstreamHeadCommit: input["upstream-head"],
      upstreamBaseCommit: input["upstream-base"],
      experimentId: input.experiment,
      baselineCommit: input.baseline,
      baseRef: input["base-ref"],
      baseCommit: input.base,
      candidateCommit: input.commit,
      candidateTree: input.tree,
      lockSha256: input["lock-sha256"],
      candidateBundleSha256: bundle.sha256,
      bundleRef,
      branchRef: input["branch-ref"],
      tagRef: input["tag-ref"],
      branchCommit: input.commit,
      tagObjectId: tagObject,
      tagPeeledCommit: input.commit,
      publicationMode: "atomic-non-force",
      disposition,
    });
    await writeFile(resultOutput.resolved, `${canonicalJson(result)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    await unlink(resultOutput.resolved).catch(() => undefined);
    throw error;
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
}

const SNAPSHOT_FLAGS = [
  "remote",
  "origin-repository-sha256",
  "ref",
  "commit",
  "tree",
  "lock-sha256",
  "baseline",
  "upstream",
  "upstream-repository-sha256",
  "upstream-head",
  "upstream-base",
  "archive",
  "bundle",
  "bundle-ref",
  "manifest",
  "archive-format",
  "compression",
];
const REGISTRATION_FLAGS = [
  "authorization-sha256",
  "authorization-expires-at",
  "remote",
  "origin-repository-sha256",
  "ref",
  "commit",
  "tree",
  "lock-sha256",
  "package-name",
  "package-version",
  "harness-registration-schema-version",
  "adapter-id",
  "adapter-execution-mode",
  "sessions-disabled",
  "uncontrolled-extensions-disabled",
  "uncontrolled-context-files-disabled",
  "upstream",
  "upstream-repository-sha256",
  "result",
];
const PUBLICATION_FLAGS = [
  "remote",
  "origin-repository-sha256",
  "upstream",
  "upstream-repository-sha256",
  "upstream-head",
  "upstream-base",
  "bundle",
  "bundle-sha256",
  "baseline",
  "base-ref",
  "base",
  "commit",
  "tree",
  "lock-sha256",
  "branch-ref",
  "tag-ref",
  "tag-timestamp",
  "experiment",
  "authorization-expires-at",
  "result",
  "mode",
];

async function main() {
  assertCloudRuntime();
  const [operation, ...flags] = process.argv.slice(2);
  if (operation === "register") {
    await register(parseFlags(flags, REGISTRATION_FLAGS));
    return;
  }
  if (operation === "snapshot") {
    await snapshot(parseFlags(flags, SNAPSHOT_FLAGS));
    return;
  }
  if (operation === "publish") {
    await publish(parseFlags(flags, PUBLICATION_FLAGS));
    return;
  }
  reject("Trusted Git worker operation is unsupported.");
}

main().catch(() => {
  process.stderr.write("Trusted Git worker failed closed.\n");
  process.exitCode = 78;
});
