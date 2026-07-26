#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  createReadStream,
  constants as fileConstants,
} from "node:fs";
import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  relative,
  resolve,
  sep,
} from "node:path";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const DATASET = "terminal-bench/terminal-bench-2-1";
const TASK_COUNT = 89;
const MAXIMUM_FILE_COUNT = 100_000;
const MAXIMUM_TOTAL_BYTES = 100 * 1024 * 1024 * 1024;
const MAXIMUM_VERSION_OUTPUT_BYTES = 4_096;
const ARGUMENT_NAMES = new Set([
  "--dataset-root",
  "--harbor-package",
  "--harbor-executable",
  "--harbor-version-output",
  "--pi-adapter",
  "--source-commit",
  "--registry-revision",
  "--harbor-version",
  "--output",
]);

class DiscoveryError extends Error {
  name = "DiscoveryError";
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    )
    .join(",")}}`;
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function hashFile(path) {
  const digest = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
  });
  return digest.digest("hex");
}

function parseArguments(arguments_) {
  if (arguments_.length === 0 || arguments_.length % 2 !== 0) {
    throw new DiscoveryError();
  }
  const parsed = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !ARGUMENT_NAMES.has(name) ||
      typeof value !== "string" ||
      value.length === 0 ||
      parsed.has(name)
    ) {
      throw new DiscoveryError();
    }
    parsed.set(name, value);
  }
  if (parsed.size !== ARGUMENT_NAMES.size) {
    throw new DiscoveryError();
  }
  return Object.fromEntries(parsed);
}

async function assertRegularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new DiscoveryError();
  }
  return stat;
}

function isWithin(root, path) {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..")
  );
}

async function inventoryDataset(rootInput) {
  const root = await realpath(rootInput);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new DiscoveryError();
  }
  const entries = [];
  const taskManifests = [];
  const datasetManifests = [];
  let totalBytes = 0;

  async function visit(directory) {
    const children = await readdir(directory, {
      withFileTypes: true,
    });
    children.sort((left, right) =>
      Buffer.from(left.name).compare(Buffer.from(right.name)),
    );
    for (const child of children) {
      if (
        child.isSymbolicLink() ||
        (!child.isDirectory() && !child.isFile())
      ) {
        throw new DiscoveryError();
      }
      const path = resolve(directory, child.name);
      const resolvedPath = await realpath(path);
      if (!isWithin(root, resolvedPath)) {
        throw new DiscoveryError();
      }
      if (child.isDirectory()) {
        await visit(resolvedPath);
        continue;
      }
      const stat = await assertRegularFile(resolvedPath);
      totalBytes += stat.size;
      if (
        entries.length >= MAXIMUM_FILE_COUNT ||
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > MAXIMUM_TOTAL_BYTES
      ) {
        throw new DiscoveryError();
      }
      const relativePath = relative(root, resolvedPath).split(sep).join("/");
      if (relativePath.length === 0 || relativePath.includes("\u0000")) {
        throw new DiscoveryError();
      }
      const entry = {
        path: relativePath,
        byteLength: stat.size,
        mode: stat.mode & 0o777,
        sha256: await hashFile(resolvedPath),
      };
      entries.push(entry);
      if (basename(resolvedPath) === "task.toml") {
        taskManifests.push(resolvedPath);
      } else if (basename(resolvedPath) === "dataset.toml") {
        datasetManifests.push(resolvedPath);
      }
    }
  }

  await visit(root);
  entries.sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
  if (
    taskManifests.length !== TASK_COUNT ||
    datasetManifests.length !== 1
  ) {
    throw new DiscoveryError();
  }
  return {
    root,
    entries,
    taskCount: taskManifests.length,
    datasetManifest: datasetManifests[0],
    totalBytes,
  };
}

async function main() {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted"
  ) {
    throw new DiscoveryError();
  }
  const arguments_ = parseArguments(process.argv.slice(2));
  const sourceCommit = arguments_["--source-commit"];
  const registryRevision = Number(
    arguments_["--registry-revision"],
  );
  const harborVersion = arguments_["--harbor-version"];
  if (
    !COMMIT.test(sourceCommit) ||
    sourceCommit !== process.env.GITHUB_SHA ||
    !Number.isSafeInteger(registryRevision) ||
    registryRevision <= 0 ||
    !EXACT_SEMVER.test(harborVersion)
  ) {
    throw new DiscoveryError();
  }

  const datasetRoot = resolve(arguments_["--dataset-root"]);
  const outputPath = resolve(arguments_["--output"]);
  const inventory = await inventoryDataset(datasetRoot);
  if (isWithin(inventory.root, outputPath)) {
    throw new DiscoveryError();
  }

  const harborPackage = resolve(arguments_["--harbor-package"]);
  const harborExecutable = resolve(
    arguments_["--harbor-executable"],
  );
  const harborVersionOutput = resolve(
    arguments_["--harbor-version-output"],
  );
  const piAdapter = resolve(arguments_["--pi-adapter"]);
  await Promise.all([
    assertRegularFile(harborPackage),
    assertRegularFile(harborExecutable),
    assertRegularFile(harborVersionOutput),
    assertRegularFile(piAdapter),
  ]);
  const versionBytes = await readFile(harborVersionOutput);
  if (
    versionBytes.byteLength > MAXIMUM_VERSION_OUTPUT_BYTES ||
    !new RegExp(
      `(?:^|[^0-9A-Za-z.-])${escapeRegularExpression(harborVersion)}(?:$|[^0-9A-Za-z.-])`,
      "u",
    ).test(versionBytes.toString("utf8"))
  ) {
    throw new DiscoveryError();
  }

  const pin = {
    benchmark: "terminal-bench-2.1",
    dataset: DATASET,
    registryRevision,
    taskCount: inventory.taskCount,
    datasetContentSha256: hashBytes(
      canonicalJson({
        schemaVersion: 1,
        domain:
          "dark-factory.terminal-bench-dataset-content-manifest.v1",
        entries: inventory.entries,
      }),
    ),
    datasetManifestSha256: await hashFile(
      inventory.datasetManifest,
    ),
    harborVersion,
    harborPackageSha256: await hashFile(harborPackage),
    harborExecutableSha256: await hashFile(harborExecutable),
    piHarborAdapterSha256: await hashFile(piAdapter),
  };
  for (const digest of [
    pin.datasetContentSha256,
    pin.datasetManifestSha256,
    pin.harborPackageSha256,
    pin.harborExecutableSha256,
    pin.piHarborAdapterSha256,
  ]) {
    if (!SHA256.test(digest)) throw new DiscoveryError();
  }
  const discoveryPolicyHash = hashBytes(
    canonicalJson({
      schemaVersion: 1,
      domain:
        "dark-factory.terminal-bench-pin-discovery-policy.v1",
      cloudOnly: true,
      taskNamesReleased: false,
      taskInstructionsReleased: false,
      taskGradersReleased: false,
      expectedTaskCount: TASK_COUNT,
      symlinksAllowed: false,
      contentManifestVersion: 1,
    }),
  );
  const unsigned = {
    schemaVersion: 1,
    domain:
      "dark-factory.terminal-bench-pin-discovery-receipt.v1",
    sourceCommit,
    runnerClass: "github-hosted",
    pin,
    datasetFileCount: inventory.entries.length,
    datasetTotalByteLength: inventory.totalBytes,
    discoveryPolicyHash,
  };
  const receipt = {
    ...unsigned,
    receiptHash: hashBytes(canonicalJson(unsigned)),
  };
  await access(dirname(outputPath), fileConstants.W_OK);
  await writeFile(outputPath, `${canonicalJson(receipt)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      receiptHash: receipt.receiptHash,
      taskCount: receipt.pin.taskCount,
      harborVersion: receipt.pin.harborVersion,
    })}\n`,
  );
}

try {
  await main();
} catch {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      code: "DF_TBENCH_PIN_DISCOVERY_FAILED",
      message:
        "Cloud-only Terminal-Bench pin discovery failed closed.",
    })}\n`,
  );
  process.exitCode = 1;
}
