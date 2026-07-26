import type { TrustedCloudArtifactRef } from "../cloud/types.js";
import { canonicalHash, canonicalJson, sha256 } from "../schemas/canonical.js";
import { assertReleaseSafe, assertReleaseSafeText } from "../schemas/safety.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const TAR_BLOCK_BYTES = 512;
const MAXIMUM_RELEASE_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_SOURCE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_SOURCE_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_ARCHIVE_ENTRIES = 2_048;
const MAXIMUM_RELEASE_ENTRY_BYTES = 8 * 1024 * 1024;
const MAXIMUM_SOURCE_ENTRY_BYTES = 32 * 1024 * 1024;
const MAXIMUM_FINGERPRINT_CANDIDATES = 100_000;
const MAXIMUM_ARCHIVE_FINGERPRINT_CANDIDATES = 250_000;
const SOURCE_TEXT_FILE =
  /\.(?:c|cc|cjs|conf|cpp|css|d\.ts|go|h|hpp|html|java|js|json|jsonl|jsx|mjs|md|mdx|py|rb|rs|sh|sql|toml|ts|tsx|txt|xml|yaml|yml)$/iu;
const RELEASE_FILE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\.(?:json|md|txt)$/u;
const PROTECTED_RELEASE_PATH =
  /(?:^|[._/-])(?:grader|raw|reference|solution|task|trajectory|trial|verifier)(?:[._/-]|$)/iu;
const SOURCE_FILE = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*\/?$/u;
const PROTECTED_SOURCE_PATH =
  /(?:^|\/)(?:terminal[-_]?bench|tbench|benchmark[-_]?tasks?|graders?|solutions?|reference[-_]?answers?)(?:\/|$)/iu;
const NESTED_ARCHIVE = /\.(?:7z|bz2|gz|pack|rar|tar|tar\.gz|tgz|xz|zip|bundle)$/iu;
const OBVIOUS_PROTECTED_LITERAL =
  /(?:terminal[-_ ]bench[-_ ]grader[-_ ]canary|grader[-_ ]canary|hidden[-_ ]task[-_ ](?:id|key|name)|package[-_ ]task[-_ ]name|raw[-_ ]grader[-_ ]output)/iu;

export type OptimizerArtifactInspectionKind =
  | "release-evidence-tar"
  | "source-tree-tar"
  | "source-git-bundle";

export interface OptimizerReleaseArtifactInspectionPolicy {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.optimizer-release-artifact-inspection-policy.v1";
  readonly evaluatorPolicyHash: string;
  readonly policyHash: string;
  readonly allowedReleasePaths: readonly string[];
  readonly forbiddenContentFingerprints: readonly string[];
  readonly graderCanaryFingerprints: readonly string[];
}

export interface TrustedOptimizerReleaseArtifactReader {
  readonly boundary: "trusted-cloud-optimizer-release-artifact-reader";
  /**
   * Reads the exact immutable bytes through a verifying artifact bridge.
   * Implementations must reject a partial stream and the caller independently
   * rechecks length and SHA-256 before inspecting content.
   */
  readBytes(artifact: TrustedCloudArtifactRef, maximumBytes: number): Promise<Uint8Array>;
}

export class OptimizerReleaseArtifactSafetyError extends Error {
  override readonly name = "OptimizerReleaseArtifactSafetyError";

  constructor() {
    super("Optimizer-bound artifact content inspection failed closed.");
  }
}

function fail(): never {
  throw new OptimizerReleaseArtifactSafetyError();
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail();
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"),
    )
  ) {
    fail();
  }
}

function uniqueSortedHashes(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100_000 ||
    value.some(
      (item, index) =>
        typeof item !== "string" ||
        !SHA256.test(item) ||
        (index > 0 && typeof value[index - 1] === "string" && (value[index - 1] as string) >= item),
    )
  ) {
    fail();
  }
  return Object.freeze([...value]);
}

function uniqueSortedReleasePaths(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 32 ||
    value.some(
      (item, index) =>
        typeof item !== "string" ||
        !RELEASE_FILE.test(item) ||
        PROTECTED_RELEASE_PATH.test(item) ||
        NESTED_ARCHIVE.test(item) ||
        (index > 0 && typeof value[index - 1] === "string" && (value[index - 1] as string) >= item),
    )
  ) {
    fail();
  }
  return Object.freeze([...value]);
}

export function assertOptimizerReleaseArtifactInspectionPolicy(
  value: unknown,
): asserts value is OptimizerReleaseArtifactInspectionPolicy {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "evaluatorPolicyHash",
    "policyHash",
    "allowedReleasePaths",
    "forbiddenContentFingerprints",
    "graderCanaryFingerprints",
  ]);
  const policy = value as unknown as OptimizerReleaseArtifactInspectionPolicy;
  const forbidden = uniqueSortedHashes(policy.forbiddenContentFingerprints);
  const canaries = uniqueSortedHashes(policy.graderCanaryFingerprints);
  const allowedReleasePaths = uniqueSortedReleasePaths(policy.allowedReleasePaths);
  if (
    policy.schemaVersion !== 1 ||
    policy.domain !== "dark-factory.optimizer-release-artifact-inspection-policy.v1" ||
    !SHA256.test(policy.evaluatorPolicyHash) ||
    !SHA256.test(policy.policyHash) ||
    canaries.length < 1 ||
    new Set([...forbidden, ...canaries]).size !== forbidden.length + canaries.length ||
    policy.policyHash !==
      canonicalHash({
        schemaVersion: policy.schemaVersion,
        domain: policy.domain,
        evaluatorPolicyHash: policy.evaluatorPolicyHash,
        allowedReleasePaths,
        forbiddenContentFingerprints: forbidden,
        graderCanaryFingerprints: canaries,
      })
  ) {
    fail();
  }
}

function isZeroBlock(bytes: Uint8Array, offset: number): boolean {
  for (let index = offset; index < offset + TAR_BLOCK_BYTES; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

function asciiField(bytes: Uint8Array, offset: number, length: number): string {
  const end = offset + length;
  let terminator = end;
  for (let index = offset; index < end; index += 1) {
    const byte = bytes[index]!;
    if (byte === 0) {
      terminator = index;
      break;
    }
    if (byte > 0x7f) fail();
  }
  for (let index = terminator; index < end; index += 1) {
    if (bytes[index] !== 0 && bytes[index] !== 0x20) fail();
  }
  return Buffer.from(bytes.subarray(offset, terminator)).toString("ascii").trimEnd();
}

function tarNumber(bytes: Uint8Array, offset: number, length: number): number {
  const raw = asciiField(bytes, offset, length).trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/u.test(raw)) fail();
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail();
  return parsed;
}

function assertTarChecksum(bytes: Uint8Array, offset: number): void {
  const expected = tarNumber(bytes, offset + 148, 8);
  let actual = 0;
  for (let index = offset; index < offset + TAR_BLOCK_BYTES; index += 1) {
    actual += index >= offset + 148 && index < offset + 156 ? 0x20 : bytes[index]!;
  }
  if (expected !== actual) fail();
}

function tarPath(bytes: Uint8Array, offset: number): string {
  const name = asciiField(bytes, offset, 100);
  const prefix = asciiField(bytes, offset + 345, 155);
  const rawPath = prefix.length === 0 ? name : `${prefix}/${name}`;
  const path = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  if (
    path.length === 0 ||
    path.length > 255 ||
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.endsWith("/.") ||
    path.includes("\\") ||
    rawPath.includes("//") ||
    path.includes("\u0000") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
    /%(?:2e|2f|5c)/iu.test(path)
  ) {
    fail();
  }
  return path;
}

function stringValues(value: unknown): readonly string[] {
  const result: string[] = [];
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > 1_000_000) fail();
    if (typeof current === "string") {
      result.push(current);
    } else if (Array.isArray(current)) {
      pending.push(...current);
    } else if (isPlainRecord(current)) {
      pending.push(...Object.values(current));
    }
  }
  return result;
}

function literalFingerprint(value: string): string {
  return canonicalHash({
    domain: "dark-factory.release-literal-fingerprint.v1",
    literal: value.trim().toLocaleLowerCase("en-US"),
  });
}

function assertNoProtectedFingerprints(
  values: readonly string[],
  protectedFingerprints: ReadonlySet<string>,
  budget: { remaining: number },
): void {
  for (const value of values) {
    budget.remaining -= 1;
    if (budget.remaining < 0) fail();
    if (
      protectedFingerprints.has(literalFingerprint(value)) ||
      OBVIOUS_PROTECTED_LITERAL.test(value)
    ) {
      fail();
    }
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    const value = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (value.length === 0 || value.charCodeAt(0) === 0xfeff || value.includes("\u0000")) {
      fail();
    }
    return value;
  } catch {
    fail();
  }
}

function inspectReleaseEntry(
  path: string,
  bytes: Uint8Array,
  policy: OptimizerReleaseArtifactInspectionPolicy,
  protectedFingerprints: ReadonlySet<string>,
  fingerprintBudget: { remaining: number },
): void {
  if (
    !RELEASE_FILE.test(path) ||
    !policy.allowedReleasePaths.includes(path) ||
    NESTED_ARCHIVE.test(path) ||
    bytes.byteLength <= 0 ||
    bytes.byteLength > MAXIMUM_RELEASE_ENTRY_BYTES
  ) {
    fail();
  }
  const text = decodeUtf8(bytes);
  let values: readonly string[];
  if (path.endsWith(".json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail();
    }
    if (!isPlainRecord(parsed) || text !== `${canonicalJson(parsed)}\n`) {
      fail();
    }
    assertReleaseSafe(parsed);
    values = stringValues(parsed);
  } else {
    assertReleaseSafeText(text, `archive:${path}`);
    values = [text];
  }
  assertNoProtectedFingerprints(values, protectedFingerprints, fingerprintBudget);
}

function inspectSourceEntryPath(path: string, byteLength: number): void {
  if (
    !SOURCE_FILE.test(path) ||
    PROTECTED_SOURCE_PATH.test(path) ||
    NESTED_ARCHIVE.test(path) ||
    byteLength > MAXIMUM_SOURCE_ENTRY_BYTES
  ) {
    fail();
  }
}

function inspectSourceEntryContent(
  path: string,
  bytes: Uint8Array,
  protectedFingerprints: ReadonlySet<string>,
  fingerprintBudget: { remaining: number },
): void {
  if (bytes.byteLength === 0) return;
  const raw = Buffer.from(bytes).toString("latin1");
  if (OBVIOUS_PROTECTED_LITERAL.test(raw)) fail();
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    if (SOURCE_TEXT_FILE.test(path)) fail();
    return;
  }
  if (text.charCodeAt(0) === 0xfeff || text.includes("\u0000")) {
    if (SOURCE_TEXT_FILE.test(path)) fail();
    return;
  }
  const candidates: string[] = [];
  const addCandidate = (value: string): void => {
    if (candidates.length >= MAXIMUM_FINGERPRINT_CANDIDATES) {
      fail();
    }
    candidates.push(value);
  };
  const trimmed = text.trim();
  if (trimmed.length >= 4 && trimmed.length <= 16_384) {
    addCandidate(trimmed);
  }
  for (const line of text.split(/\r?\n/u)) {
    const value = line.trim();
    if (value.length >= 4 && value.length <= 4_096) {
      addCandidate(value);
    }
    for (const match of value.matchAll(/[A-Za-z0-9][A-Za-z0-9._:@+/-]{3,255}/gu)) {
      addCandidate(match[0]);
    }
    for (const match of value.matchAll(/(["'`])([^"'`\r\n]{4,4096})\1/gu)) {
      addCandidate(match[2]!);
    }
  }
  if (path.endsWith(".json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      for (const value of stringValues(parsed)) {
        addCandidate(value);
      }
    }
    // Source JSON may be JSONC or a fixture; lexical candidates still
    // receive exact fingerprint matching when parsing fails.
  }
  assertNoProtectedFingerprints(candidates, protectedFingerprints, fingerprintBudget);
}

function inspectTar(input: {
  readonly bytes: Uint8Array;
  readonly kind: "release-evidence-tar" | "source-tree-tar";
  readonly policy: OptimizerReleaseArtifactInspectionPolicy;
  readonly expectedSourceCommit: string | null;
}): void {
  const maximumBytes =
    input.kind === "release-evidence-tar"
      ? MAXIMUM_RELEASE_ARCHIVE_BYTES
      : MAXIMUM_SOURCE_ARCHIVE_BYTES;
  if (
    input.bytes.byteLength < TAR_BLOCK_BYTES * 3 ||
    input.bytes.byteLength > maximumBytes ||
    input.bytes.byteLength % TAR_BLOCK_BYTES !== 0
  ) {
    fail();
  }
  const paths = new Set<string>();
  const protectedFingerprints = new Set([
    ...input.policy.forbiddenContentFingerprints,
    ...input.policy.graderCanaryFingerprints,
  ]);
  const fingerprintBudget = {
    remaining: MAXIMUM_ARCHIVE_FINGERPRINT_CANDIDATES,
  };
  let offset = 0;
  let entries = 0;
  let files = 0;
  let sourceCommitHeaderSeen = false;
  let reachedEnd = false;
  while (offset < input.bytes.byteLength) {
    if (isZeroBlock(input.bytes, offset)) {
      if (
        offset + TAR_BLOCK_BYTES * 2 > input.bytes.byteLength ||
        !isZeroBlock(input.bytes, offset + TAR_BLOCK_BYTES)
      ) {
        fail();
      }
      for (let index = offset; index < input.bytes.byteLength; index += 1) {
        if (input.bytes[index] !== 0) fail();
      }
      reachedEnd = true;
      break;
    }
    entries += 1;
    if (entries > MAXIMUM_ARCHIVE_ENTRIES) fail();
    assertTarChecksum(input.bytes, offset);
    const magic = asciiField(input.bytes, offset + 257, 6);
    const version = asciiField(input.bytes, offset + 263, 2);
    const modifiedAt = tarNumber(input.bytes, offset + 136, 12);
    const ownerName = asciiField(input.bytes, offset + 265, 32);
    const groupName = asciiField(input.bytes, offset + 297, 32);
    if (
      magic !== "ustar" ||
      version !== "00" ||
      tarNumber(input.bytes, offset + 108, 8) !== 0 ||
      tarNumber(input.bytes, offset + 116, 8) !== 0 ||
      asciiField(input.bytes, offset + 157, 100) !== "" ||
      tarNumber(input.bytes, offset + 329, 8) !== 0 ||
      tarNumber(input.bytes, offset + 337, 8) !== 0 ||
      (input.kind === "release-evidence-tar" &&
        (modifiedAt !== 0 || ownerName !== "" || groupName !== "")) ||
      (input.kind === "source-tree-tar" &&
        (modifiedAt > 4_102_444_800 ||
          !["", "root"].includes(ownerName) ||
          !["", "root"].includes(groupName)))
    ) {
      fail();
    }
    const typeByte = input.bytes[offset + 156]!;
    const regular = typeByte === 0 || typeByte === 0x30;
    const directory = typeByte === 0x35;
    const globalPax = input.kind === "source-tree-tar" && typeByte === 0x67;
    if (!regular && !directory && !globalPax) fail();
    const mode = tarNumber(input.bytes, offset + 100, 8);
    if (
      (input.kind === "release-evidence-tar" &&
        ((regular && mode !== 0o644) || (directory && mode !== 0o755))) ||
      (input.kind === "source-tree-tar" &&
        ((regular && ![0o644, 0o755].includes(mode)) ||
          (directory && mode !== 0o755) ||
          (globalPax && ![0, 0o644, 0o666].includes(mode))))
    ) {
      fail();
    }
    const path = tarPath(input.bytes, offset);
    if (paths.has(path)) fail();
    paths.add(path);
    const byteLength = tarNumber(input.bytes, offset + 124, 12);
    if (
      (directory && byteLength !== 0) ||
      (input.kind === "release-evidence-tar" && regular && byteLength <= 0) ||
      (globalPax && (entries !== 1 || path !== "pax_global_header"))
    ) {
      fail();
    }
    const contentOffset = offset + TAR_BLOCK_BYTES;
    const paddedLength = Math.ceil(byteLength / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    const nextOffset = contentOffset + paddedLength;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > input.bytes.byteLength) {
      fail();
    }
    for (let index = contentOffset + byteLength; index < nextOffset; index += 1) {
      if (input.bytes[index] !== 0) fail();
    }
    if (globalPax) {
      const pax = decodeUtf8(input.bytes.subarray(contentOffset, contentOffset + byteLength));
      const expectedCommit = input.expectedSourceCommit;
      if (
        expectedCommit === null ||
        !GIT_OBJECT.test(expectedCommit) ||
        pax !== `${expectedCommit.length + 12} comment=${expectedCommit}\n`
      ) {
        fail();
      }
      sourceCommitHeaderSeen = true;
    } else if (regular) {
      files += 1;
      const content = input.bytes.subarray(contentOffset, contentOffset + byteLength);
      if (input.kind === "release-evidence-tar") {
        inspectReleaseEntry(path, content, input.policy, protectedFingerprints, fingerprintBudget);
      } else {
        inspectSourceEntryPath(path, byteLength);
        inspectSourceEntryContent(path, content, protectedFingerprints, fingerprintBudget);
      }
    } else if (
      (input.kind === "release-evidence-tar" &&
        !input.policy.allowedReleasePaths.some((allowedPath) =>
          allowedPath.startsWith(`${path}/`),
        )) ||
      (input.kind === "source-tree-tar" &&
        (!SOURCE_FILE.test(path) || PROTECTED_SOURCE_PATH.test(path)))
    ) {
      fail();
    }
    offset = nextOffset;
  }
  if (!reachedEnd || files === 0 || (input.kind === "source-tree-tar" && !sourceCommitHeaderSeen)) {
    fail();
  }
}

function inspectGitBundle(bytes: Uint8Array, expectedSourceCommit: string): void {
  if (
    bytes.byteLength < 32 ||
    bytes.byteLength > MAXIMUM_SOURCE_BUNDLE_BYTES ||
    !GIT_OBJECT.test(expectedSourceCommit)
  ) {
    fail();
  }
  const headerLimit = Math.min(bytes.byteLength, 1024 * 1024);
  const headerBytes = bytes.subarray(0, headerLimit);
  const packMarker = Buffer.from("\nPACK", "ascii");
  const marker = Buffer.from(headerBytes).indexOf(packMarker);
  if (marker < 0) fail();
  const header = decodeUtf8(headerBytes.subarray(0, marker + 1));
  if (!header.startsWith("# v2 git bundle\n") && !header.startsWith("# v3 git bundle\n")) {
    fail();
  }
  const lines = header.split("\n");
  const advertised = lines.slice(1, -1).filter((line) => line.length > 0);
  const refLine = /^[a-f0-9]{40}(?:[a-f0-9]{24})? refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Git bundle prerequisite subjects must exclude NUL and line breaks.
  const prerequisiteLine = /^-[a-f0-9]{40}(?:[a-f0-9]{24})? [^\u0000\r\n]+$/u;
  const capabilityLine = /^@object-format=sha(?:1|256)$/u;
  const advertisedRef = advertised.find((line) => refLine.test(line));
  if (
    lines.length < 3 ||
    lines.at(-1) !== "" ||
    advertised.filter((line) => refLine.test(line)).length !== 1 ||
    advertisedRef === undefined ||
    !advertisedRef.startsWith(`${expectedSourceCommit} `) ||
    !advertisedRef.endsWith(" refs/heads/df/bundle/000-source-snapshot") ||
    advertised.some(
      (line) => !refLine.test(line) && !prerequisiteLine.test(line) && !capabilityLine.test(line),
    ) ||
    advertised.some(
      (line) => line.includes("..") || /(?:task|grader|solution|terminal[-_]?bench)/iu.test(line),
    )
  ) {
    fail();
  }
  const raw = Buffer.from(bytes).toString("latin1");
  if (
    OBVIOUS_PROTECTED_LITERAL.test(raw) ||
    /(?:^|[\s"'(=:[{])\/(?:private|root|var)(?:\/|(?=$|[\s"'`),.;:\]}]))/iu.test(raw)
  ) {
    fail();
  }
}

export function maximumOptimizerArtifactInspectionBytes(
  kind: OptimizerArtifactInspectionKind,
): number {
  switch (kind) {
    case "release-evidence-tar":
      return MAXIMUM_RELEASE_ARCHIVE_BYTES;
    case "source-tree-tar":
      return MAXIMUM_SOURCE_ARCHIVE_BYTES;
    case "source-git-bundle":
      return MAXIMUM_SOURCE_BUNDLE_BYTES;
  }
}

/**
 * Inspects the bytes themselves. Signed metadata, `contains*` booleans, file
 * names, and registry key scans are deliberately not accepted as substitutes.
 */
export function assertOptimizerBoundArtifactBytesSafe(input: {
  readonly artifact: TrustedCloudArtifactRef;
  readonly bytes: Uint8Array;
  readonly kind: OptimizerArtifactInspectionKind;
  readonly policy: OptimizerReleaseArtifactInspectionPolicy;
  readonly expectedSourceCommit: string | null;
}): void {
  try {
    assertOptimizerReleaseArtifactInspectionPolicy(input.policy);
    if (
      !(input.bytes instanceof Uint8Array) ||
      input.bytes.byteLength !== input.artifact.byteLength ||
      input.bytes.byteLength > maximumOptimizerArtifactInspectionBytes(input.kind) ||
      sha256(input.bytes) !== input.artifact.sha256
    ) {
      fail();
    }
    if (input.kind === "source-git-bundle") {
      if (
        input.artifact.mediaType !== "application/vnd.git.bundle" ||
        input.expectedSourceCommit === null
      ) {
        fail();
      }
      inspectGitBundle(input.bytes, input.expectedSourceCommit);
    } else {
      if (
        input.artifact.mediaType !== "application/x-tar" ||
        (input.kind === "release-evidence-tar" && input.expectedSourceCommit !== null) ||
        (input.kind === "source-tree-tar" && input.expectedSourceCommit === null)
      ) {
        fail();
      }
      inspectTar({
        bytes: input.bytes,
        kind: input.kind,
        policy: input.policy,
        expectedSourceCommit: input.expectedSourceCommit,
      });
    }
  } catch {
    fail();
  }
}
