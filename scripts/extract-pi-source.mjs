#!/usr/bin/env node

import {
  closeSync,
  constants,
  createHash,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const CLOUD_MARKERS = [
  "DAYTONA_SANDBOX_ID",
  "DAYTONA_WORKSPACE_ID",
  "E2B_SANDBOX_ID",
  "MODAL_TASK_ID",
  "MODAL_SANDBOX_ID",
];
const BLOCK_SIZE = 512;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (typeof constants.O_NOFOLLOW !== "number") {
  fail("This cloud runtime cannot enforce no-follow source extraction.");
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !key.startsWith("--") ||
      values.has(key)
    ) {
      fail("Source extractor arguments are malformed.");
    }
    values.set(key, value);
  }
  const archive = values.get("--archive");
  const destination = values.get("--destination");
  const sha256 = values.get("--sha256");
  const commit = values.get("--commit");
  if (
    values.size !== 4 ||
    archive === undefined ||
    destination === undefined ||
    sha256 === undefined ||
    commit === undefined ||
    !isAbsolute(archive) ||
    !isAbsolute(destination) ||
    !SHA256.test(sha256) ||
    !GIT_OBJECT.test(commit)
  ) {
    fail("Source extractor requires exact absolute paths, digest, and commit.");
  }
  return { archive, destination, sha256, commit };
}

function readExactly(fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (count === 0) fail("Source archive ended unexpectedly.");
    offset += count;
  }
}

function parseString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  const boundedEnd = end === -1 || end > start + length ? start + length : end;
  return buffer.subarray(start, boundedEnd).toString("utf8");
}

function parseOctal(buffer, start, length, label) {
  const raw = parseString(buffer, start, length).trim().replace(/\0/gu, "");
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/u.test(raw)) fail(`${label} is not canonical octal.`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is out of range.`);
  return value;
}

function assertHeaderChecksum(header) {
  const expected = parseOctal(header, 148, 8, "Tar checksum");
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (sum !== expected) fail("Source archive header checksum is invalid.");
}

function safeRelativePath(rawPath) {
  const normalized = rawPath.replace(/\\/gu, "/").replace(/\/+$/u, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("Source archive contains an unsafe path.");
  }
  return normalized;
}

function parsePax(body) {
  const fields = new Map();
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) fail("PAX record has no length separator.");
    const lengthText = body.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(lengthText)) fail("PAX record length is invalid.");
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2) {
      fail("PAX record length is out of range.");
    }
    const recordEnd = offset + length;
    if (recordEnd > body.length || body[recordEnd - 1] !== 0x0a) {
      fail("PAX record is truncated.");
    }
    const record = body.subarray(space + 1, recordEnd - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) fail("PAX record is malformed.");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (fields.has(key)) fail("PAX record contains duplicate keys.");
    fields.set(key, value);
    offset = recordEnd;
  }
  return fields;
}

function ensureInside(root, candidate) {
  const relativePath = relative(root, candidate);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    fail("Source extraction escaped its destination.");
  }
}

function ensureParents(root, target) {
  const parent = dirname(target);
  ensureInside(root, parent === root ? target : parent);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  const realParent = realpathSync(parent);
  if (realParent !== root) ensureInside(root, realParent);
}

function writeRegularFile(fd, archiveOffset, size, target, executable) {
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW;
  const output = openSync(target, flags, executable ? 0o755 : 0o644);
  try {
    const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(size, 1)));
    let remaining = size;
    let position = archiveOffset;
    while (remaining > 0) {
      const length = Math.min(chunk.length, remaining);
      const slice = chunk.subarray(0, length);
      readExactly(fd, slice, position);
      let written = 0;
      while (written < length) {
        written += writeSync(output, slice, written, length - written);
      }
      remaining -= length;
      position += length;
    }
    fchmodSync(output, executable ? 0o755 : 0o644);
  } finally {
    closeSync(output);
  }
}

if (
  process.env.DF_CLOUD_EXECUTION !== "1" ||
  !CLOUD_MARKERS.some((name) => (process.env[name] ?? "").length > 0)
) {
  fail("Pi source extraction is cloud-only.");
}

const args = parseArguments(process.argv.slice(2));
if (!existsSync(args.archive) || existsSync(args.destination)) {
  fail("Source archive must exist and extraction destination must be new.");
}
const statFd = openSync(args.archive, constants.O_RDONLY);
const stat = fstatSync(statFd);
closeSync(statFd);
if (
  !stat.isFile() ||
  stat.size <= 0 ||
  stat.size > MAX_ARCHIVE_BYTES ||
  stat.size % BLOCK_SIZE !== 0
) {
  fail("Source archive size is outside policy.");
}

const archiveHash = createHash("sha256");
const hashFd = openSync(args.archive, constants.O_RDONLY);
try {
  const chunk = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (position < stat.size) {
    const length = Math.min(chunk.length, stat.size - position);
    const slice = chunk.subarray(0, length);
    readExactly(hashFd, slice, position);
    archiveHash.update(slice);
    position += length;
  }
} finally {
  closeSync(hashFd);
}
if (archiveHash.digest("hex") !== args.sha256) {
  fail("Source archive digest does not match its trusted reference.");
}

mkdirSync(args.destination, { recursive: false, mode: 0o755 });
const destinationRoot = realpathSync(args.destination);
const archiveFd = openSync(args.archive, constants.O_RDONLY);
let archivePosition = 0;
let entryCount = 0;
let expandedBytes = 0;
let zeroBlocks = 0;
let pendingPax = new Map();
let globalCommit;
const seenPaths = new Set();

try {
  while (archivePosition < stat.size) {
    const header = Buffer.alloc(BLOCK_SIZE);
    readExactly(archiveFd, header, archivePosition);
    archivePosition += BLOCK_SIZE;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) break;
      continue;
    }
    zeroBlocks = 0;
    assertHeaderChecksum(header);
    const magic = parseString(header, 257, 6);
    if (magic !== "ustar") fail("Source archive is not a supported USTAR/PAX archive.");
    const size = parseOctal(header, 124, 12, "Tar entry size");
    const mode = parseOctal(header, 100, 8, "Tar entry mode");
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = parseString(header, 345, 155);
    const name = parseString(header, 0, 100);
    const headerPath = prefix.length > 0 ? `${prefix}/${name}` : name;
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (archivePosition + paddedSize > stat.size) {
      fail("Source archive entry exceeds the archive boundary.");
    }

    if (type === "x" || type === "g") {
      if (size > 1024 * 1024) fail("PAX metadata exceeds policy.");
      const body = Buffer.alloc(size);
      if (size > 0) readExactly(archiveFd, body, archivePosition);
      const pax = parsePax(body);
      if (type === "g") {
        const allowed = new Set(["comment"]);
        if ([...pax.keys()].some((key) => !allowed.has(key))) {
          fail("Global PAX metadata contains an unsupported field.");
        }
        const comment = pax.get("comment");
        if (comment !== undefined) globalCommit = comment;
      } else {
        const allowed = new Set(["path"]);
        if ([...pax.keys()].some((key) => !allowed.has(key))) {
          fail("Entry PAX metadata contains an unsupported field.");
        }
        pendingPax = pax;
      }
      archivePosition += paddedSize;
      continue;
    }

    entryCount += 1;
    if (entryCount > MAX_ENTRIES) fail("Source archive has too many entries.");
    expandedBytes += size;
    if (expandedBytes > MAX_EXPANDED_BYTES) fail("Source archive expands beyond policy.");
    const entryPath = safeRelativePath(pendingPax.get("path") ?? headerPath);
    pendingPax = new Map();
    if (seenPaths.has(entryPath)) fail("Source archive contains duplicate paths.");
    seenPaths.add(entryPath);
    const target = resolve(destinationRoot, entryPath);
    ensureInside(destinationRoot, target);

    if (type === "5") {
      if (size !== 0) fail("Directory entry contains unexpected data.");
      ensureParents(destinationRoot, target);
      mkdirSync(target, { recursive: false, mode: 0o755 });
    } else if (type === "0" || type === "\0") {
      ensureParents(destinationRoot, target);
      writeRegularFile(archiveFd, archivePosition, size, target, (mode & 0o111) !== 0);
    } else {
      fail("Source archive contains a link or special file.");
    }
    archivePosition += paddedSize;
  }
} finally {
  closeSync(archiveFd);
}

if (zeroBlocks < 2 || pendingPax.size > 0 || entryCount === 0) {
  fail("Source archive termination is invalid.");
}
if (globalCommit !== undefined && globalCommit !== args.commit) {
  fail("Source archive commit marker does not match the requested commit.");
}

process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    archiveSha256: args.sha256,
    commit: args.commit,
    entryCount,
    expandedBytes,
  })}\n`,
);
