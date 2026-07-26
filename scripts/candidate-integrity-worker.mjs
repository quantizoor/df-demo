#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

const CLOUD_MARKER_GROUPS = [
  ["DAYTONA_SANDBOX_ID", "DAYTONA_WORKSPACE_ID"],
  ["E2B_SANDBOX_ID"],
  ["MODAL_TASK_ID", "MODAL_SANDBOX_ID"],
];
const SAFE_MARKER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const EXPERIMENT_ID = /^[0-9]{3,8}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TREE_MODE = /^[0-7]{6}$/u;
const MAXIMUM_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;
const MAXIMUM_DIFF_BYTES = 64 * 1024 * 1024;
const MAXIMUM_GIT_METADATA_BYTES = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15 * 60_000;

class CandidateIntegrityWorkerError extends Error {
  constructor(message) {
    super(message);
    this.name = "CandidateIntegrityWorkerError";
  }
}

function reject(message) {
  throw new CandidateIntegrityWorkerError(message);
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function withContentHash(document) {
  return {
    ...document,
    contentHash: sha256(canonicalJson(document)),
  };
}

function parseFlags(argv) {
  const expected = new Set([
    "experiment",
    "bundle",
    "bundle-sha256",
    "bundle-byte-length",
    "bundle-ref",
    "source-commit",
    "source-tree",
    "candidate-commit",
    "candidate-tree",
    "diff",
    "manifest",
  ]);
  if (argv.length !== expected.size * 2) {
    reject("Candidate-integrity worker arguments are incomplete.");
  }
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      typeof flag !== "string" ||
      typeof value !== "string" ||
      !flag.startsWith("--") ||
      !expected.has(flag.slice(2)) ||
      Object.hasOwn(parsed, flag.slice(2)) ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Worker CLI values must reject NUL and line breaks to prevent argument-boundary injection.
      /[\u0000\r\n]/u.test(value)
    ) {
      reject("Candidate-integrity worker received an unsupported argument.");
    }
    parsed[flag.slice(2)] = value;
  }
  return parsed;
}

function assertCloudRuntime() {
  if (process.env.DF_CLOUD_EXECUTION !== "1") {
    reject("Candidate-integrity worker is cloud-only.");
  }
  const activeGroups = CLOUD_MARKER_GROUPS.filter((group) =>
    group.some((name) => process.env[name] !== undefined),
  );
  if (activeGroups.length !== 1) {
    reject("Candidate-integrity worker requires one cloud provider marker.");
  }
  const values = activeGroups[0]
    .map((name) => process.env[name])
    .filter((value) => value !== undefined);
  if (values.length === 0 || values.some((value) => !SAFE_MARKER.test(value))) {
    reject("Candidate-integrity cloud marker is malformed.");
  }
}

function assertAbsoluteFilePath(value, label) {
  if (
    !isAbsolute(value) ||
    resolve(value) === "/" ||
    value.includes("\u0000") ||
    value.split(sep).includes("..")
  ) {
    reject(`${label} is not an absolute traversal-free file path.`);
  }
}

function git(repository, arguments_, options = {}) {
  const result = spawnSync("git", arguments_, {
    cwd: repository,
    env: {
      HOME: repository,
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      LANG: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    encoding: null,
    input: options.input,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: options.maximumBytes ?? MAXIMUM_GIT_METADATA_BYTES,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr)
  ) {
    reject("Immutable Git evidence derivation failed.");
  }
  return result.stdout;
}

function text(buffer) {
  return buffer.toString("utf8").trim();
}

async function hashRegularFile(path, expectedSha256, expectedByteLength) {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== expectedByteLength ||
    metadata.size <= 0 ||
    metadata.size > MAXIMUM_BUNDLE_BYTES
  ) {
    reject("Candidate bundle is not the sealed bounded regular file.");
  }
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    byteLength += chunk.byteLength;
    if (byteLength > expectedByteLength) {
      reject("Candidate bundle exceeded its sealed length.");
    }
    hash.update(chunk);
  }
  if (byteLength !== expectedByteLength || hash.digest("hex") !== expectedSha256) {
    reject("Candidate bundle bytes do not match sealed metadata.");
  }
}

function parseChangedFiles(buffer) {
  const values = buffer.toString("utf8").split("\0");
  if (values.at(-1) !== "") {
    reject("Git changed-path output is not NUL terminated.");
  }
  values.pop();
  if (
    values.length < 1 ||
    values.length > 4096 ||
    new Set(values).size !== values.length ||
    values.some(
      (value) =>
        value.length < 1 || value.length > 4096 || value.startsWith("/") || value.includes("\0"),
    )
  ) {
    reject("Git changed-path evidence is malformed.");
  }
  return values;
}

function parseNumstat(buffer, changedFiles) {
  const entries = buffer.toString("utf8").split("\0");
  if (entries.at(-1) !== "") {
    reject("Git numstat output is not NUL terminated.");
  }
  entries.pop();
  let addedLines = 0;
  let deletedLines = 0;
  const paths = [];
  for (const entry of entries) {
    const match = /^(?<added>\d+|-)\t(?<deleted>\d+|-)\t(?<path>[\s\S]+)$/u.exec(entry);
    if (match?.groups === undefined || match.groups.added === "-" || match.groups.deleted === "-") {
      reject("Binary numstat evidence is forbidden.");
    }
    const added = Number.parseInt(match.groups.added, 10);
    const deleted = Number.parseInt(match.groups.deleted, 10);
    addedLines += added;
    deletedLines += deleted;
    paths.push(match.groups.path);
  }
  if (
    !Number.isSafeInteger(addedLines) ||
    !Number.isSafeInteger(deletedLines) ||
    canonicalJson(paths) !== canonicalJson(changedFiles)
  ) {
    reject("Git numstat evidence is detached from changed paths.");
  }
  return { addedLines, deletedLines };
}

function parseModes(buffer, changedFiles) {
  const entries = buffer.toString("utf8").split("\0");
  if (entries.at(-1) !== "") {
    reject("Git raw-mode output is not NUL terminated.");
  }
  entries.pop();
  if (entries.length !== changedFiles.length * 2) {
    reject("Git raw-mode evidence has an unexpected shape.");
  }
  const modes = [];
  for (let index = 0; index < entries.length; index += 2) {
    const metadata = entries[index];
    const path = entries[index + 1];
    const match =
      /^:(?<beforeMode>[0-7]{6}) (?<afterMode>[0-7]{6}) (?<beforeObject>[a-f0-9]{40,64}) (?<afterObject>[a-f0-9]{40,64}) (?<status>[ACDMTUXB])$/u.exec(
        metadata,
      );
    if (
      match?.groups === undefined ||
      path !== changedFiles[index / 2] ||
      !TREE_MODE.test(match.groups.beforeMode) ||
      !TREE_MODE.test(match.groups.afterMode)
    ) {
      reject("Git raw-mode evidence is malformed or detached.");
    }
    modes.push({
      path,
      beforeMode: match.groups.beforeMode,
      afterMode: match.groups.afterMode,
    });
  }
  return modes;
}

async function main() {
  assertCloudRuntime();
  const input = parseFlags(process.argv.slice(2));
  for (const [value, label] of [
    [input.bundle, "Candidate bundle path"],
    [input.diff, "Candidate diff path"],
    [input.manifest, "Candidate evidence manifest path"],
  ]) {
    assertAbsoluteFilePath(value, label);
  }
  const expectedBundleBytes = Number.parseInt(input["bundle-byte-length"], 10);
  const expectedBundleRef = `refs/heads/df/bundle/${input.experiment}`;
  if (
    !EXPERIMENT_ID.test(input.experiment) ||
    !SHA256.test(input["bundle-sha256"]) ||
    !Number.isSafeInteger(expectedBundleBytes) ||
    expectedBundleBytes <= 0 ||
    expectedBundleBytes > MAXIMUM_BUNDLE_BYTES ||
    input["bundle-ref"] !== expectedBundleRef ||
    !OBJECT_ID.test(input["source-commit"]) ||
    !OBJECT_ID.test(input["source-tree"]) ||
    !OBJECT_ID.test(input["candidate-commit"]) ||
    !OBJECT_ID.test(input["candidate-tree"]) ||
    input["source-commit"] === input["candidate-commit"] ||
    input["source-tree"] === input["candidate-tree"]
  ) {
    reject("Candidate-integrity lineage is malformed.");
  }
  await hashRegularFile(input.bundle, input["bundle-sha256"], expectedBundleBytes);

  const repository = mkdtempSync(join(tmpdir(), "df-integrity-git-"));
  try {
    git(repository, ["init", "--bare", "--quiet"]);
    git(repository, ["bundle", "verify", input.bundle]);
    git(repository, [
      "fetch",
      "--quiet",
      "--no-tags",
      input.bundle,
      `${input["bundle-ref"]}:${input["bundle-ref"]}`,
    ]);
    const sourceCommit = text(git(repository, ["rev-parse", `${input["source-commit"]}^{commit}`]));
    const candidateCommit = text(
      git(repository, ["rev-parse", `${input["candidate-commit"]}^{commit}`]),
    );
    const sourceTree = text(git(repository, ["rev-parse", `${sourceCommit}^{tree}`]));
    const candidateTree = text(git(repository, ["rev-parse", `${candidateCommit}^{tree}`]));
    const ancestry = text(
      git(repository, ["rev-list", "--parents", "--max-count=1", candidateCommit]),
    ).split(" ");
    if (
      sourceCommit !== input["source-commit"] ||
      candidateCommit !== input["candidate-commit"] ||
      sourceTree !== input["source-tree"] ||
      candidateTree !== input["candidate-tree"] ||
      ancestry.length !== 2 ||
      ancestry[0] !== candidateCommit ||
      ancestry[1] !== sourceCommit
    ) {
      reject("Candidate bundle does not prove the exact single-parent lineage.");
    }

    const changedFiles = parseChangedFiles(
      git(repository, [
        "diff",
        "--no-renames",
        "--name-only",
        "-z",
        "--diff-filter=ACDMRTUXB",
        sourceCommit,
        candidateCommit,
        "--",
      ]),
    );
    const lineCounts = parseNumstat(
      git(repository, [
        "diff",
        "--no-renames",
        "--numstat",
        "-z",
        sourceCommit,
        candidateCommit,
        "--",
      ]),
      changedFiles,
    );
    const modes = parseModes(
      git(repository, [
        "diff-tree",
        "--no-commit-id",
        "--raw",
        "-r",
        "-z",
        "--no-renames",
        sourceCommit,
        candidateCommit,
        "--",
      ]),
      changedFiles,
    );
    const diff = git(
      repository,
      [
        "diff",
        "--no-renames",
        "--no-ext-diff",
        "--full-index",
        "--binary",
        sourceCommit,
        candidateCommit,
        "--",
      ],
      { maximumBytes: MAXIMUM_DIFF_BYTES },
    );
    if (diff.byteLength <= 0 || diff.byteLength > MAXIMUM_DIFF_BYTES) {
      reject("Derived candidate diff is outside its byte bound.");
    }
    writeFileSync(input.diff, diff, { encoding: null, flag: "wx", mode: 0o600 });
    const document = withContentHash({
      schemaVersion: 1,
      domain: "dark-factory.candidate-git-evidence.v1",
      experimentId: input.experiment,
      bundleRef: input["bundle-ref"],
      candidateBundleSha256: input["bundle-sha256"],
      candidateBundleByteLength: expectedBundleBytes,
      sourceCommit,
      sourceTree,
      candidateCommit,
      candidateTree,
      diffSha256: sha256(diff),
      diffByteLength: diff.byteLength,
      changedFiles,
      changedFilesHash: sha256(canonicalJson(changedFiles)),
      addedLines: lineCounts.addedLines,
      deletedLines: lineCounts.deletedLines,
      lineCountsHash: sha256(canonicalJson(lineCounts)),
      modes,
      fileModesHash: sha256(canonicalJson(modes)),
    });
    writeFileSync(input.manifest, `${canonicalJson(document)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

void main().catch(() => {
  process.stderr.write("Candidate-integrity worker failed closed.\n");
  process.exitCode = 78;
});
