import { createHash } from "node:crypto";

import type { TrustedCloudArtifactRef } from "../cloud/types.js";
import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import type {
  TrustedHarborInvocation,
  TrustedHarborJobArtifact,
} from "../terminal-bench/harbor.js";

const BLOCK_BYTES = 512;
const MAXIMUM_FILES = 50_000;
const MAXIMUM_TRIALS = 32;
const MAXIMUM_PAYLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAXIMUM_JSON_BYTES = 256 * 1024 * 1024;
const MAXIMUM_PATH_BYTES = 4_096;
const MAXIMUM_JSON_DEPTH = 128;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PATH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const NESTED_ARCHIVE =
  /(?:^|\/)[^/]+\.(?:7z|bz2|gz|rar|tar|tbz2|tgz|txz|xz|zip)$/iu;

type PlainRecord = Readonly<Record<string, unknown>>;

export interface Harbor020OutputBundleFile {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface Harbor020OutputBundleManifest {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.harbor-output-bundle.v1";
  readonly requestId: string;
  readonly jobSha256: string;
  readonly pinHash: string;
  readonly invocationId: string;
  readonly order: TrustedHarborInvocation["order"];
  readonly configSha256: string;
  readonly executionId: string;
  readonly expectedTrialCount: number;
  readonly fileCount: number;
  readonly totalByteLength: number;
  readonly payloadSha256: string;
  readonly files: readonly Harbor020OutputBundleFile[];
}

export interface Harbor020ParsedTrialFiles {
  readonly directory: string;
  readonly result: PlainRecord;
  readonly trajectory: PlainRecord;
}

export interface Harbor020ParsedOutputBundle {
  readonly manifest: Harbor020OutputBundleManifest;
  readonly outputConfig: PlainRecord;
  readonly jobResult: PlainRecord;
  readonly trials: readonly Harbor020ParsedTrialFiles[];
}

export class Harbor020OutputBundleError extends Error {
  override readonly name = "Harbor020OutputBundleError";

  constructor() {
    super("Harbor v0.20.0 output bundle failed strict trusted parsing.");
  }
}

function fail(): never {
  throw new Harbor020OutputBundleError();
}

function record(value: unknown): PlainRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail();
  }
  return value as PlainRecord;
}

function exactKeys(value: unknown, keys: readonly string[]): PlainRecord {
  const result = record(value);
  const actual = Object.keys(result);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    fail();
  }
  return result;
}

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    fail();
  }
  return value;
}

function stringValue(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    value.includes("\u0000")
  ) {
    fail();
  }
  return value;
}

function digest(value: unknown): string {
  const result = stringValue(value, 64);
  if (!SHA256.test(result)) fail();
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function zeroPadding(bytes: Uint8Array): void {
  if (bytes.some((byte) => byte !== 0)) fail();
}

function writeOctal(
  header: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const encoded = value.toString(8);
  if (encoded.length > length - 1) fail();
  const padded = encoded.padStart(length - 1, "0");
  for (let index = 0; index < padded.length; index += 1) {
    header[offset + index] = padded.charCodeAt(index);
  }
  header[offset + length - 1] = 0;
}

/**
 * Reconstructing and comparing the complete header is deliberately stricter
 * than accepting general tar. Alternate encodings, links, devices, sparse
 * files, global PAX state, ownership changes, and nonzero metadata all fail.
 */
function deterministicHeader(
  path: string,
  size: number,
  type: "0" | "x",
): Uint8Array {
  const pathBytes = new TextEncoder().encode(path);
  if (pathBytes.byteLength > 100) fail();
  const header = new Uint8Array(BLOCK_BYTES);
  header.set(pathBytes, 0);
  writeOctal(header, 100, 8, type === "0" ? 0o600 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.set(new TextEncoder().encode("ustar"), 257);
  header[262] = 0;
  header.set(new TextEncoder().encode("00"), 263);
  header.set(new TextEncoder().encode("root"), 265);
  header.set(new TextEncoder().encode("root"), 297);
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.set(new TextEncoder().encode(checksumText), 148);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function paddingLength(byteLength: number): number {
  return (BLOCK_BYTES - (byteLength % BLOCK_BYTES)) % BLOCK_BYTES;
}

function paxPathRecord(path: string): Uint8Array {
  const payload = `path=${path}\n`;
  let length = Buffer.byteLength(payload, "utf8") + 3;
  while (true) {
    const record = `${length} ${payload}`;
    const actual = Buffer.byteLength(record, "utf8");
    if (actual === length) return new TextEncoder().encode(record);
    length = actual;
  }
}

class Cursor {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get offset(): number {
    return this.#offset;
  }

  take(length: number): Uint8Array {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.#offset + length > this.#bytes.byteLength
    ) {
      fail();
    }
    const result = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return result;
  }

  takeEntry(path: string, size: number, type: "0" | "x"): Uint8Array {
    const header = this.take(BLOCK_BYTES);
    if (!equalBytes(header, deterministicHeader(path, size, type))) fail();
    const body = this.take(size);
    zeroPadding(this.take(paddingLength(size)));
    return body;
  }

  assertFinished(): void {
    if (this.#offset !== this.#bytes.byteLength) fail();
  }
}

/**
 * Small recursive-descent JSON reader used only at the trusted raw boundary.
 * Native `JSON.parse` silently accepts duplicate object keys; this reader
 * rejects them before a value can be normalized or reserialized.
 */
class DuplicateRejectingJsonParser {
  readonly #text: string;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    if (bytes.byteLength < 1 || bytes.byteLength > MAXIMUM_JSON_BYTES) fail();
    try {
      this.#text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail();
    }
  }

  parse(): unknown {
    this.#whitespace();
    const result = this.#value(0);
    this.#whitespace();
    if (this.#offset !== this.#text.length) fail();
    return result;
  }

  #whitespace(): void {
    while (
      this.#offset < this.#text.length &&
      /[\u0009\u000a\u000d\u0020]/u.test(this.#text[this.#offset] ?? "")
    ) {
      this.#offset += 1;
    }
  }

  #value(depth: number): unknown {
    if (depth > MAXIMUM_JSON_DEPTH) fail();
    this.#whitespace();
    const current = this.#text[this.#offset];
    if (current === '"') return this.#string();
    if (current === "{") return this.#object(depth + 1);
    if (current === "[") return this.#array(depth + 1);
    if (this.#text.startsWith("true", this.#offset)) {
      this.#offset += 4;
      return true;
    }
    if (this.#text.startsWith("false", this.#offset)) {
      this.#offset += 5;
      return false;
    }
    if (this.#text.startsWith("null", this.#offset)) {
      this.#offset += 4;
      return null;
    }
    return this.#number();
  }

  #string(): string {
    const start = this.#offset;
    this.#offset += 1;
    let escaped = false;
    while (this.#offset < this.#text.length) {
      const code = this.#text.charCodeAt(this.#offset);
      if (!escaped && code === 0x22) {
        this.#offset += 1;
        try {
          const result = JSON.parse(this.#text.slice(start, this.#offset));
          if (typeof result !== "string") fail();
          return result;
        } catch {
          fail();
        }
      }
      if (!escaped && code < 0x20) fail();
      if (!escaped && code === 0x5c) {
        escaped = true;
      } else {
        escaped = false;
      }
      this.#offset += 1;
    }
    fail();
  }

  #number(): number {
    const match =
      /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;
    match.lastIndex = this.#offset;
    const found = match.exec(this.#text);
    if (found === null) fail();
    this.#offset = match.lastIndex;
    const value = Number(found[0]);
    if (!Number.isFinite(value)) fail();
    return value;
  }

  #object(depth: number): PlainRecord {
    this.#offset += 1;
    this.#whitespace();
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    if (this.#text[this.#offset] === "}") {
      this.#offset += 1;
      return result;
    }
    while (true) {
      if (this.#text[this.#offset] !== '"') fail();
      const key = this.#string();
      if (keys.has(key)) fail();
      keys.add(key);
      this.#whitespace();
      if (this.#text[this.#offset] !== ":") fail();
      this.#offset += 1;
      const value = this.#value(depth);
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.#whitespace();
      const separator = this.#text[this.#offset];
      if (separator === "}") {
        this.#offset += 1;
        return result;
      }
      if (separator !== ",") fail();
      this.#offset += 1;
      this.#whitespace();
    }
  }

  #array(depth: number): readonly unknown[] {
    this.#offset += 1;
    this.#whitespace();
    const result: unknown[] = [];
    if (this.#text[this.#offset] === "]") {
      this.#offset += 1;
      return result;
    }
    while (true) {
      result.push(this.#value(depth));
      this.#whitespace();
      const separator = this.#text[this.#offset];
      if (separator === "]") {
        this.#offset += 1;
        return result;
      }
      if (separator !== ",") fail();
      this.#offset += 1;
      this.#whitespace();
    }
  }
}

export function parseHarbor020Json(
  bytes: Uint8Array,
): PlainRecord {
  return record(new DuplicateRejectingJsonParser(bytes).parse());
}

function assertSafePayloadPath(value: unknown): string {
  const path = stringValue(value, MAXIMUM_PATH_BYTES);
  const segments = path.split("/");
  if (
    path !== path.normalize("NFC") ||
    CONTROL_CHARACTER.test(path) ||
    path.includes("\\") ||
    path.startsWith("/") ||
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    ) ||
    NESTED_ARCHIVE.test(path)
  ) {
    fail();
  }
  return path;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function parseManifest(
  bytes: Uint8Array,
  input: {
    readonly job: TrustedHarborJobArtifact;
    readonly invocation: TrustedHarborInvocation;
    readonly executionId: string;
  },
): Harbor020OutputBundleManifest {
  if (bytes.at(-1) !== 0x0a) fail();
  const body = bytes.subarray(0, bytes.byteLength - 1);
  const manifest = exactKeys(parseHarbor020Json(body), [
    "schemaVersion",
    "domain",
    "requestId",
    "jobSha256",
    "pinHash",
    "invocationId",
    "order",
    "configSha256",
    "executionId",
    "expectedTrialCount",
    "fileCount",
    "totalByteLength",
    "payloadSha256",
    "files",
  ]);
  if (
    canonicalJson(manifest) !==
      new TextDecoder("utf-8", { fatal: true }).decode(body) ||
    manifest["schemaVersion"] !== 1 ||
    manifest["domain"] !== "dark-factory.harbor-output-bundle.v1" ||
    manifest["requestId"] !== input.job.requestId ||
    manifest["jobSha256"] !== input.job.jobSha256 ||
    manifest["pinHash"] !== input.job.pinHash ||
    manifest["invocationId"] !== input.invocation.invocationId ||
    manifest["order"] !== input.invocation.order ||
    manifest["configSha256"] !== input.invocation.configSha256 ||
    manifest["executionId"] !== input.executionId ||
    safeInteger(manifest["expectedTrialCount"], MAXIMUM_TRIALS) !==
      input.invocation.armCount ||
    !Array.isArray(manifest["files"])
  ) {
    fail();
  }
  const fileCount = safeInteger(manifest["fileCount"], MAXIMUM_FILES);
  const totalByteLength = safeInteger(
    manifest["totalByteLength"],
    MAXIMUM_PAYLOAD_BYTES,
  );
  if (fileCount < 1 || manifest["files"].length !== fileCount) fail();
  const files: Harbor020OutputBundleFile[] = [];
  const paths = new Set<string>();
  let sum = 0;
  for (const rawFile of manifest["files"]) {
    const file = exactKeys(rawFile, ["path", "byteLength", "sha256"]);
    const path = assertSafePayloadPath(file["path"]);
    const byteLength = safeInteger(
      file["byteLength"],
      MAXIMUM_PAYLOAD_BYTES,
    );
    const sha256 = digest(file["sha256"]);
    if (
      paths.has(path) ||
      (files.length > 0 &&
        compareUtf8(files.at(-1)?.path ?? "", path) >= 0)
    ) {
      fail();
    }
    for (
      let separator = path.indexOf("/");
      separator >= 0;
      separator = path.indexOf("/", separator + 1)
    ) {
      if (paths.has(path.slice(0, separator))) fail();
    }
    paths.add(path);
    sum += byteLength;
    if (!Number.isSafeInteger(sum) || sum > MAXIMUM_PAYLOAD_BYTES) fail();
    files.push({ path, byteLength, sha256 });
  }
  const payloadSha256 = digest(manifest["payloadSha256"]);
  if (
    sum !== totalByteLength ||
    payloadSha256 !==
      canonicalHash({
        domain: "dark-factory.harbor-output-payload.v1",
        files,
      })
  ) {
    fail();
  }
  return {
    schemaVersion: 1,
    domain: "dark-factory.harbor-output-bundle.v1",
    requestId: input.job.requestId,
    jobSha256: input.job.jobSha256,
    pinHash: input.job.pinHash,
    invocationId: input.invocation.invocationId,
    order: input.invocation.order,
    configSha256: input.invocation.configSha256,
    executionId: input.executionId,
    expectedTrialCount: input.invocation.armCount,
    fileCount,
    totalByteLength,
    payloadSha256,
    files,
  };
}

function assertHarborLayout(
  files: readonly Harbor020OutputBundleFile[],
  expectedTrials: number,
): readonly string[] {
  const paths = new Set(files.map((file) => file.path));
  if (!paths.has("config.json") || !paths.has("result.json")) fail();
  const resultDirectories = new Set<string>();
  const trajectoryDirectories = new Set<string>();
  for (const file of files) {
    const segments = file.path.split("/");
    if (segments.at(-1) === "result.json") {
      if (file.path !== "result.json" && segments.length !== 2) fail();
      if (segments.length === 2) resultDirectories.add(segments[0] ?? "");
    }
    if (segments.at(-1) === "trajectory.json") {
      if (segments.length !== 3 || segments[1] !== "agent") fail();
      trajectoryDirectories.add(segments[0] ?? "");
    }
  }
  if (
    resultDirectories.size !== expectedTrials ||
    trajectoryDirectories.size !== expectedTrials ||
    [...resultDirectories].some(
      (directory) =>
        !SAFE_PATH_ID.test(directory) ||
        !trajectoryDirectories.has(directory) ||
        !paths.has(`${directory}/agent/trajectory.json`),
    ) ||
    [...trajectoryDirectories].some(
      (directory) => !resultDirectories.has(directory),
    )
  ) {
    fail();
  }
  return [...resultDirectories].sort(compareUtf8);
}

/**
 * Parses only the deterministic archive emitted by
 * `scripts/package-harbor-output.mjs`. It is not a general-purpose tar reader.
 */
export function parseHarbor020OutputBundle(input: {
  readonly artifact: TrustedCloudArtifactRef;
  readonly bytes: Uint8Array;
  readonly job: TrustedHarborJobArtifact;
  readonly invocation: TrustedHarborInvocation;
  readonly executionId: string;
  readonly maximumArchiveBytes: number;
}): Harbor020ParsedOutputBundle {
  try {
    if (
      !(input.bytes instanceof Uint8Array) ||
      input.bytes.byteLength !== input.artifact.byteLength ||
      input.bytes.byteLength < BLOCK_BYTES * 3 ||
      input.bytes.byteLength > input.maximumArchiveBytes ||
      input.bytes.byteLength % BLOCK_BYTES !== 0 ||
      createHash("sha256").update(input.bytes).digest("hex") !==
        input.artifact.sha256 ||
      !Number.isSafeInteger(input.maximumArchiveBytes) ||
      input.maximumArchiveBytes < BLOCK_BYTES * 3
    ) {
      fail();
    }
    const cursor = new Cursor(input.bytes);
    const manifestHeader = input.bytes.subarray(0, BLOCK_BYTES);
    const sizeField = new TextDecoder("ascii", { fatal: true }).decode(
      manifestHeader.subarray(124, 136),
    );
    if (!/^[0-7]{11}\u0000$/u.test(sizeField)) fail();
    const manifestSize = Number.parseInt(sizeField.slice(0, -1), 8);
    if (
      !Number.isSafeInteger(manifestSize) ||
      manifestSize < 2 ||
      manifestSize > MAXIMUM_JSON_BYTES
    ) {
      fail();
    }
    const manifest = parseManifest(
      cursor.takeEntry("manifest.json", manifestSize, "0"),
      input,
    );
    const trialDirectories = assertHarborLayout(
      manifest.files,
      input.invocation.armCount,
    );
    const retained = new Map<string, Uint8Array>();
    const retainedPaths = new Set([
      "config.json",
      "result.json",
      ...trialDirectories.flatMap((directory) => [
        `${directory}/result.json`,
        `${directory}/agent/trajectory.json`,
      ]),
    ]);
    for (const [index, file] of manifest.files.entries()) {
      const archivePath = `payload/${file.path}`;
      const pax = paxPathRecord(archivePath);
      const ordinal = String(index).padStart(6, "0");
      const actualPax = cursor.takeEntry(
        `.pax/${ordinal}`,
        pax.byteLength,
        "x",
      );
      if (!equalBytes(actualPax, pax)) fail();
      const body = cursor.takeEntry(
        `.files/${ordinal}`,
        file.byteLength,
        "0",
      );
      if (createHash("sha256").update(body).digest("hex") !== file.sha256) {
        fail();
      }
      if (retainedPaths.has(file.path)) {
        if (body.byteLength < 2 || body.byteLength > MAXIMUM_JSON_BYTES) fail();
        retained.set(file.path, Uint8Array.from(body));
      }
    }
    zeroPadding(cursor.take(BLOCK_BYTES * 2));
    cursor.assertFinished();
    if (retained.size !== retainedPaths.size) fail();
    const trials = trialDirectories.map((directory) => {
      const resultBytes = retained.get(`${directory}/result.json`);
      const trajectoryBytes = retained.get(
        `${directory}/agent/trajectory.json`,
      );
      if (resultBytes === undefined || trajectoryBytes === undefined) fail();
      return {
        directory,
        result: parseHarbor020Json(resultBytes),
        trajectory: parseHarbor020Json(trajectoryBytes),
      };
    });
    const outputConfigBytes = retained.get("config.json");
    const jobResultBytes = retained.get("result.json");
    if (outputConfigBytes === undefined || jobResultBytes === undefined) fail();
    return {
      manifest,
      outputConfig: parseHarbor020Json(outputConfigBytes),
      jobResult: parseHarbor020Json(jobResultBytes),
      trials,
    };
  } catch {
    fail();
  }
}
