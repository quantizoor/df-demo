#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const CLOUD_MARKERS = [
  "DAYTONA_SANDBOX_ID",
  "DAYTONA_WORKSPACE_ID",
  "E2B_SANDBOX_ID",
  "MODAL_TASK_ID",
  "MODAL_SANDBOX_ID",
];
const BLOCK_BYTES = 512;
const MAX_FILES = 50_000;
const MAX_TRIALS = 32;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = MAX_PAYLOAD_BYTES + 256 * 1024 * 1024;
const MAX_PATH_BYTES = 4_096;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_PATH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Harbor archive paths are untrusted and must reject every ASCII control byte.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const NESTED_ARCHIVE = /(?:^|\/)[^/]+\.(?:7z|bz2|gz|rar|tar|tbz2|tgz|txz|xz|zip)$/iu;

class PolicyError extends Error {}

function reject() {
  throw new PolicyError("Harbor output violates the sealed bundle policy.");
}

function fail() {
  process.stderr.write("Harbor output packaging failed closed.\n");
  process.exitCode = 78;
}

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject();
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    reject();
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

function canonicalHash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function parseArguments(argv) {
  const required = new Set([
    "source-directory",
    "output",
    "request-id",
    "job-sha256",
    "pin-sha256",
    "invocation-id",
    "order",
    "config-sha256",
    "execution-id",
    "expected-trials",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof flag !== "string" || !flag.startsWith("--") || typeof value !== "string") {
      reject();
    }
    const name = flag.slice(2);
    if (!required.has(name) || values.has(name)) reject();
    values.set(name, value);
  }
  if (values.size !== required.size) reject();
  return Object.fromEntries(values);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function safeRelativePath(root, absolute) {
  const path = relative(root, absolute).split(sep).join("/");
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path !== path.normalize("NFC") ||
    Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES ||
    CONTROL_CHARACTER.test(path) ||
    path.includes("\\") ||
    isAbsolute(path) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    reject();
  }
  return path;
}

function assertInside(root, candidate) {
  const path = relative(root, candidate);
  if (path.length === 0 || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    reject();
  }
}

function openRegularFile(path, expected) {
  if (typeof constants.O_NOFOLLOW !== "number") reject();
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 0 ||
      (expected !== undefined &&
        (metadata.dev !== expected.dev ||
          metadata.ino !== expected.ino ||
          metadata.size !== expected.byteLength ||
          metadata.mtimeMs !== expected.mtimeMs))
    ) {
      reject();
    }
    return {
      descriptor,
      byteLength: metadata.size,
      dev: metadata.dev,
      ino: metadata.ino,
      mtimeMs: metadata.mtimeMs,
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function readFileHash(path, expected) {
  const opened = openRegularFile(path, expected);
  try {
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < opened.byteLength) {
      const length = Math.min(buffer.byteLength, opened.byteLength - position);
      const count = readSync(opened.descriptor, buffer, 0, length, position);
      if (count <= 0) reject();
      digest.update(buffer.subarray(0, count));
      position += count;
    }
    const after = fstatSync(opened.descriptor);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.byteLength ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      reject();
    }
    return {
      ...opened,
      sha256: digest.digest("hex"),
    };
  } catch (error) {
    closeSync(opened.descriptor);
    throw error;
  }
}

function enumerateFiles(root) {
  const files = [];
  const seenPaths = new Set();
  let totalByteLength = 0;

  function visit(directory) {
    const directoryRealPath = realpathSync(directory);
    if (directoryRealPath !== root) assertInside(root, directoryRealPath);
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareUtf8(left.name, right.name),
    );
    for (const entry of entries) {
      if (
        entry.name.length === 0 ||
        entry.name !== entry.name.normalize("NFC") ||
        CONTROL_CHARACTER.test(entry.name) ||
        entry.name.includes("\\") ||
        entry.name === "." ||
        entry.name === ".."
      ) {
        reject();
      }
      const absolute = join(directory, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        reject();
      }
      if (metadata.isDirectory()) {
        visit(absolute);
        continue;
      }
      const path = safeRelativePath(root, absolute);
      if (seenPaths.has(path) || files.length >= MAX_FILES || NESTED_ARCHIVE.test(path)) {
        reject();
      }
      for (let prefix = path.indexOf("/"); prefix >= 0; prefix = path.indexOf("/", prefix + 1)) {
        if (seenPaths.has(path.slice(0, prefix))) reject();
      }
      const opened = readFileHash(absolute);
      closeSync(opened.descriptor);
      totalByteLength += opened.byteLength;
      if (!Number.isSafeInteger(totalByteLength) || totalByteLength > MAX_PAYLOAD_BYTES) {
        reject();
      }
      seenPaths.add(path);
      files.push({
        absolute,
        path,
        byteLength: opened.byteLength,
        dev: opened.dev,
        ino: opened.ino,
        mtimeMs: opened.mtimeMs,
        sha256: opened.sha256,
      });
    }
  }

  visit(root);
  files.sort((left, right) => compareUtf8(left.path, right.path));
  for (let index = 0; index < files.length - 1; index += 1) {
    const path = files[index].path;
    const next = files[index + 1].path;
    if (next.startsWith(`${path}/`)) reject();
  }
  if (files.length === 0) reject();
  return { files, totalByteLength };
}

function assertHarborLayout(files, expectedTrials) {
  const paths = new Set(files.map((file) => file.path));
  if (!paths.has("config.json") || !paths.has("result.json")) reject();
  const trialsWithResult = new Set();
  const trialsWithTrajectory = new Set();
  for (const file of files) {
    const segments = file.path.split("/");
    if (segments.at(-1) === "result.json") {
      if (segments.length !== 2 && file.path !== "result.json") reject();
      if (segments.length === 2) trialsWithResult.add(segments[0]);
    }
    if (segments.at(-1) === "trajectory.json") {
      if (segments.length !== 3 || segments[1] !== "agent" || file.path === "trajectory.json") {
        reject();
      }
      trialsWithTrajectory.add(segments[0]);
    }
  }
  if (
    trialsWithResult.size !== expectedTrials ||
    trialsWithResult.size > MAX_TRIALS ||
    trialsWithTrajectory.size !== trialsWithResult.size ||
    [...trialsWithResult].some(
      (trial) => !trialsWithTrajectory.has(trial) || !paths.has(`${trial}/agent/trajectory.json`),
    ) ||
    [...trialsWithTrajectory].some((trial) => !trialsWithResult.has(trial))
  ) {
    reject();
  }
}

function writeOctal(header, offset, length, value) {
  const encoded = value.toString(8);
  if (encoded.length > length - 1) reject();
  header.write(encoded.padStart(length - 1, "0"), offset, "ascii");
  header[offset + length - 1] = 0;
}

function tarHeader(path, size, type) {
  const encodedPath = Buffer.from(path, "utf8");
  if (encodedPath.byteLength > 100) reject();
  const header = Buffer.alloc(BLOCK_BYTES);
  encodedPath.copy(header, 0);
  writeOctal(header, 100, 8, type === "0" ? 0o600 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar", 257, 5, "ascii");
  header[262] = 0;
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 4, "ascii");
  header.write("root", 297, 4, "ascii");
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function paxPathRecord(path) {
  const payload = `path=${path}\n`;
  let length = Buffer.byteLength(payload, "utf8") + 3;
  while (true) {
    const record = `${length} ${payload}`;
    const actual = Buffer.byteLength(record, "utf8");
    if (actual === length) return Buffer.from(record, "utf8");
    length = actual;
  }
}

function writeChunk(descriptor, state, chunk) {
  state.byteLength += chunk.byteLength;
  if (!Number.isSafeInteger(state.byteLength) || state.byteLength > MAX_ARCHIVE_BYTES) {
    reject();
  }
  let offset = 0;
  while (offset < chunk.byteLength) {
    const count = writeSync(descriptor, chunk, offset, chunk.byteLength - offset);
    if (count <= 0) reject();
    offset += count;
  }
}

function writePadding(descriptor, state, byteLength) {
  const padding = (BLOCK_BYTES - (byteLength % BLOCK_BYTES)) % BLOCK_BYTES;
  if (padding > 0) writeChunk(descriptor, state, Buffer.alloc(padding));
}

function writeBufferEntry(descriptor, state, path, body, type = "0") {
  writeChunk(descriptor, state, tarHeader(path, body.byteLength, type));
  writeChunk(descriptor, state, body);
  writePadding(descriptor, state, body.byteLength);
}

function writeFileEntry(descriptor, state, file, ordinal) {
  const archivePath = `payload/${file.path}`;
  const pax = paxPathRecord(archivePath);
  writeBufferEntry(descriptor, state, `.pax/${String(ordinal).padStart(6, "0")}`, pax, "x");
  writeChunk(
    descriptor,
    state,
    tarHeader(`.files/${String(ordinal).padStart(6, "0")}`, file.byteLength, "0"),
  );

  const opened = openRegularFile(file.absolute, file);
  const digest = createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < file.byteLength) {
      const length = Math.min(buffer.byteLength, file.byteLength - position);
      const count = readSync(opened.descriptor, buffer, 0, length, position);
      if (count <= 0) reject();
      const chunk = buffer.subarray(0, count);
      digest.update(chunk);
      writeChunk(descriptor, state, chunk);
      position += count;
    }
    const after = fstatSync(opened.descriptor);
    if (
      after.dev !== file.dev ||
      after.ino !== file.ino ||
      after.size !== file.byteLength ||
      after.mtimeMs !== file.mtimeMs ||
      digest.digest("hex") !== file.sha256
    ) {
      reject();
    }
  } finally {
    closeSync(opened.descriptor);
  }
  writePadding(descriptor, state, file.byteLength);
}

function main() {
  if (
    process.env.DF_CLOUD_EXECUTION !== "1" ||
    !CLOUD_MARKERS.some((name) => (process.env[name] ?? "").length > 0) ||
    typeof constants.O_NOFOLLOW !== "number"
  ) {
    reject();
  }

  const input = parseArguments(process.argv.slice(2));
  const expectedTrials = Number(input["expected-trials"]);
  if (
    !isAbsolute(input["source-directory"]) ||
    !isAbsolute(input.output) ||
    !SAFE_ID.test(input["request-id"]) ||
    !SHA256.test(input["job-sha256"]) ||
    !SHA256.test(input["pin-sha256"]) ||
    !SAFE_PATH_ID.test(input["invocation-id"]) ||
    !new Set(["repair", "AB", "BA"]).has(input.order) ||
    !SHA256.test(input["config-sha256"]) ||
    !SAFE_ID.test(input["execution-id"]) ||
    !Number.isSafeInteger(expectedTrials) ||
    expectedTrials < 1 ||
    expectedTrials > MAX_TRIALS ||
    (input.order === "repair" && expectedTrials !== 5) ||
    (input.order !== "repair" && expectedTrials !== 12) ||
    process.env.DF_HARBOR_JOB_SHA256 !== input["job-sha256"] ||
    process.env.DF_TERMINAL_BENCH_PIN_SHA256 !== input["pin-sha256"]
  ) {
    reject();
  }

  const sourceMetadata = lstatSync(input["source-directory"]);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) reject();
  const sourceRoot = realpathSync(input["source-directory"]);
  if (
    input["source-directory"] !== resolve(input["source-directory"]) ||
    sourceRoot !== resolve(input["source-directory"]) ||
    basename(sourceRoot) !== input["invocation-id"]
  ) {
    reject();
  }

  const outputPath = resolve(input.output);
  const outputParent = realpathSync(dirname(outputPath));
  if (
    outputPath !== input.output ||
    basename(outputPath) !== `${input["invocation-id"]}.harbor-output.tar` ||
    outputPath.startsWith(`${sourceRoot}${sep}`) ||
    outputPath === sourceRoot ||
    !outputPath.startsWith(`${outputParent}${sep}`)
  ) {
    reject();
  }
  try {
    statSync(outputPath);
    reject();
  } catch (error) {
    if (error instanceof PolicyError || error?.code !== "ENOENT") throw error;
  }

  const { files, totalByteLength } = enumerateFiles(sourceRoot);
  assertHarborLayout(files, expectedTrials);
  const fileEntries = files.map(({ path, byteLength, sha256 }) => ({
    path,
    byteLength,
    sha256,
  }));
  const manifest = {
    schemaVersion: 1,
    domain: "dark-factory.harbor-output-bundle.v1",
    requestId: input["request-id"],
    jobSha256: input["job-sha256"],
    pinHash: input["pin-sha256"],
    invocationId: input["invocation-id"],
    order: input.order,
    configSha256: input["config-sha256"],
    executionId: input["execution-id"],
    expectedTrialCount: expectedTrials,
    fileCount: fileEntries.length,
    totalByteLength,
    payloadSha256: canonicalHash({
      domain: "dark-factory.harbor-output-payload.v1",
      files: fileEntries,
    }),
    files: fileEntries,
  };
  const manifestBytes = Buffer.from(`${canonical(manifest)}\n`, "utf8");
  const outputFlags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const descriptor = openSync(outputPath, outputFlags, 0o600);
  const state = { byteLength: 0 };
  let completed = false;
  try {
    writeBufferEntry(descriptor, state, "manifest.json", manifestBytes);
    for (const [index, file] of files.entries()) {
      writeFileEntry(descriptor, state, file, index);
    }
    writeChunk(descriptor, state, Buffer.alloc(BLOCK_BYTES * 2));
    fsyncSync(descriptor);
    closeSync(descriptor);
    completed = true;
  } finally {
    if (!completed) {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor may already have been closed by a failing syscall.
      }
    }
    if (!completed) {
      try {
        unlinkSync(outputPath);
      } catch {
        // A failed package is never downloaded; sandbox teardown removes it.
      }
    }
  }

  const archive = lstatSync(outputPath);
  if (
    !archive.isFile() ||
    archive.isSymbolicLink() ||
    archive.size !== state.byteLength ||
    archive.size <= 0 ||
    archive.size > MAX_ARCHIVE_BYTES ||
    archive.size % BLOCK_BYTES !== 0
  ) {
    reject();
  }
  const archiveHash = readFileHash(outputPath);
  closeSync(archiveHash.descriptor);
  process.stdout.write(
    `${canonical({
      kind: "harbor-output-package-receipt",
      requestId: input["request-id"],
      invocationId: input["invocation-id"],
      executionId: input["execution-id"],
      jobSha256: input["job-sha256"],
      archiveSha256: archiveHash.sha256,
      archiveByteLength: archive.size,
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      payloadSha256: manifest.payloadSha256,
      fileCount: manifest.fileCount,
      totalByteLength: manifest.totalByteLength,
    })}\n`,
  );
}

try {
  main();
} catch {
  fail();
}
