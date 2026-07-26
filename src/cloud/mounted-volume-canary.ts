import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { canonicalHash, canonicalJson, computeContentHash } from "../schemas/canonical.js";
import type { TrustedArtifactRuntimeGuard } from "./artifact-bridge.js";
import type { MountedVolumeStateSemanticsGuard } from "./mounted-volume-state.js";
import type { CloudExecutionMarker, CloudProviderName } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SAFE_VOLUME_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_VOLUME_SUBPATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,7}$/u;
const SAFE_NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const SAFE_RUNTIME_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const RECEIPT_POLICY_VERSION = "mounted-volume-semantics-v1";
const RECEIPT_VALIDITY_MS = 6 * 60 * 60_000;
const MAXIMUM_RECEIPT_VALIDITY_MS = 24 * 60 * 60_000;
const EXCLUSIVE_CONTENDER_COUNT = 16;
const RENAME_READER_COUNT = 8;
const RENAME_READS_PER_READER = 32;
const MAXIMUM_CANARY_FILE_BYTES = 64 * 1024;

const RECEIPT_KEYS = [
  "schemaVersion",
  "domain",
  "policyVersion",
  "provider",
  "volumeRootHash",
  "volumeBindingHash",
  "controllerInstanceIdHash",
  "controlImageDigest",
  "runtimeIdentityHash",
  "observedAt",
  "expiresAt",
  "observations",
  "crashDurabilityTested",
  "crashDurabilityClaimed",
  "contentHash",
] as const;

const OBSERVATION_KEYS = [
  "regularNonSymlinkPaths",
  "exclusiveCreationUnderContention",
  "exclusiveCreationContenderCount",
  "exclusiveCreationWinnerCount",
  "sameVolumeAtomicRenameVisibility",
  "renameVisibilitySampleCount",
  "fileFsyncCallSucceeded",
  "directoryFsyncCallSucceeded",
  "rollbackHeadDetection",
] as const;

interface CanaryPathObservation {
  readonly kind: "directory" | "regular-file" | "other";
  readonly symbolicLink: boolean;
  readonly linkCount: number;
}

export interface MountedVolumeCanaryFileSystemPort {
  createDirectory(
    path: string,
    options: {
      readonly recursive: boolean;
      readonly exclusive: boolean;
    },
  ): Promise<"created" | "exists">;
  inspect(path: string): Promise<CanaryPathObservation>;
  resolveRealPath(path: string): Promise<string>;
  createExclusiveSyncedFile(path: string, bytes: Uint8Array): Promise<"created" | "exists">;
  readRegularFile(path: string): Promise<Uint8Array>;
  rename(source: string, target: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  removeTree(path: string): Promise<void>;
}

export interface ExclusiveCreationRaceObservation {
  readonly contenderCount: number;
  readonly winnerCount: number;
  readonly alreadyExistsCount: number;
}

export interface AtomicRenameVisibilityObservation {
  readonly sampleCount: number;
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly missingCount: number;
  readonly invalidCount: number;
}

export interface MountedVolumeCanaryWorkerPort {
  raceExclusiveCreation(input: {
    readonly filesystem: MountedVolumeCanaryFileSystemPort;
    readonly path: string;
    readonly payload: Uint8Array;
    readonly contenderCount: number;
  }): Promise<ExclusiveCreationRaceObservation>;
  observeAtomicRename(input: {
    readonly filesystem: MountedVolumeCanaryFileSystemPort;
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly before: Uint8Array;
    readonly after: Uint8Array;
    readonly readerCount: number;
    readonly readsPerReader: number;
  }): Promise<AtomicRenameVisibilityObservation>;
}

export interface MountedVolumeRuntimeIdentity {
  readonly marker: CloudExecutionMarker;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly architecture: string;
}

export interface MountedVolumeSemanticsCanaryReceipt {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.mounted-volume-semantics-canary.v1";
  readonly policyVersion: typeof RECEIPT_POLICY_VERSION;
  readonly provider: CloudProviderName;
  readonly volumeRootHash: string;
  readonly volumeBindingHash: string;
  readonly controllerInstanceIdHash: string;
  readonly controlImageDigest: `sha256:${string}`;
  readonly runtimeIdentityHash: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly observations: {
    readonly regularNonSymlinkPaths: true;
    readonly exclusiveCreationUnderContention: true;
    readonly exclusiveCreationContenderCount: number;
    readonly exclusiveCreationWinnerCount: 1;
    readonly sameVolumeAtomicRenameVisibility: true;
    readonly renameVisibilitySampleCount: number;
    readonly fileFsyncCallSucceeded: true;
    readonly directoryFsyncCallSucceeded: true;
    readonly rollbackHeadDetection: true;
  };
  /**
   * The canary observes live filesystem calls and visibility. It does not
   * simulate a provider or host crash, so it must never certify crash
   * durability.
   */
  readonly crashDurabilityTested: false;
  readonly crashDurabilityClaimed: false;
  readonly contentHash: string;
}

export interface RunMountedVolumeSemanticsCanaryOptions {
  readonly provider: CloudProviderName;
  readonly volumeRoot: string;
  readonly volumeId: string;
  readonly volumeSubpath: string;
  readonly controlImageDigest: `sha256:${string}`;
  readonly runtimeIdentity: MountedVolumeRuntimeIdentity;
  readonly runtimeGuard: TrustedArtifactRuntimeGuard;
  readonly filesystem?: MountedVolumeCanaryFileSystemPort;
  readonly workers?: MountedVolumeCanaryWorkerPort;
  readonly now?: () => Date;
  readonly nonceFactory?: () => string;
  readonly receiptValidityMs?: number;
}

export interface AttestedMountedVolumeStateSemanticsGuardOptions {
  readonly receipt: MountedVolumeSemanticsCanaryReceipt;
  readonly provider: CloudProviderName;
  readonly volumeRoot: string;
  readonly volumeId: string;
  readonly volumeSubpath: string;
  readonly controlImageDigest: `sha256:${string}`;
  readonly runtimeIdentity: MountedVolumeRuntimeIdentity;
  readonly runtimeGuard: TrustedArtifactRuntimeGuard;
  readonly now?: () => Date;
}

interface CanaryHead {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.mounted-volume-canary-head.v1";
  readonly generation: number;
  readonly previousHeadHash: string | null;
  readonly payloadHash: string;
  readonly contentHash: string;
}

export class MountedVolumeSemanticsCanaryError extends Error {
  override readonly name = "MountedVolumeSemanticsCanaryError";
}

function fail(message: string): never {
  throw new MountedVolumeSemanticsCanaryError(message);
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    String((error as NodeJS.ErrnoException).code) === code
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    fail(`${label} contains unsupported fields.`);
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function boundedVolumeRoot(volumeRoot: string): string {
  const root = resolve(volumeRoot);
  if (
    !isAbsolute(volumeRoot) ||
    root === sep ||
    volumeRoot.includes("\u0000") ||
    volumeRoot.split(sep).includes("..")
  ) {
    fail("Canary volume root must be a bounded absolute path.");
  }
  return root;
}

function assertRuntimeIdentity(
  provider: CloudProviderName,
  identity: MountedVolumeRuntimeIdentity,
): void {
  if (
    identity.marker.provider !== provider ||
    !SAFE_RUNTIME_VALUE.test(identity.marker.sandboxId) ||
    !SAFE_RUNTIME_VALUE.test(identity.marker.markerEnvironmentName) ||
    !SAFE_RUNTIME_VALUE.test(identity.nodeVersion) ||
    !SAFE_RUNTIME_VALUE.test(identity.platform) ||
    !SAFE_RUNTIME_VALUE.test(identity.architecture)
  ) {
    fail("Mounted-volume runtime identity is malformed or mismatched.");
  }
}

export function computeMountedVolumeRootHash(volumeRoot: string): string {
  return canonicalHash({
    domain: "dark-factory.mounted-volume-root.v1",
    volumeRoot: boundedVolumeRoot(volumeRoot),
  });
}

export function computeMountedVolumeBindingHash(input: {
  readonly provider: CloudProviderName;
  readonly volumeId: string;
  readonly volumeSubpath: string;
  readonly volumeRoot: string;
}): string {
  if (
    !SAFE_VOLUME_COMPONENT.test(input.volumeId) ||
    !SAFE_VOLUME_SUBPATH.test(input.volumeSubpath)
  ) {
    fail("Mounted-volume provider binding is malformed.");
  }
  return canonicalHash({
    domain: "dark-factory.mounted-volume-binding.v1",
    provider: input.provider,
    volumeId: input.volumeId,
    volumeSubpath: input.volumeSubpath,
    volumeRoot: boundedVolumeRoot(input.volumeRoot),
  });
}

export function computeMountedVolumeRuntimeIdentityHash(input: {
  readonly provider: CloudProviderName;
  readonly controlImageDigest: `sha256:${string}`;
  readonly runtimeIdentity: MountedVolumeRuntimeIdentity;
}): string {
  assertRuntimeIdentity(input.provider, input.runtimeIdentity);
  if (!IMAGE_DIGEST.test(input.controlImageDigest)) {
    fail("Mounted-volume control image digest is not immutable.");
  }
  return canonicalHash({
    domain: "dark-factory.mounted-volume-runtime.v1",
    provider: input.provider,
    sandboxId: input.runtimeIdentity.marker.sandboxId,
    markerEnvironmentName: input.runtimeIdentity.marker.markerEnvironmentName,
    controlImageDigest: input.controlImageDigest,
    nodeVersion: input.runtimeIdentity.nodeVersion,
    platform: input.runtimeIdentity.platform,
    architecture: input.runtimeIdentity.architecture,
  });
}

function canonicalTimestamp(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(`${label} is invalid.`);
  }
  return value.toISOString();
}

function assertSafeDirectory(
  filesystem: MountedVolumeCanaryFileSystemPort,
  path: string,
  label: string,
): Promise<void> {
  return Promise.all([filesystem.inspect(path), filesystem.resolveRealPath(path)]).then(
    ([observation, actualPath]) => {
      if (
        observation.kind !== "directory" ||
        observation.symbolicLink ||
        actualPath !== resolve(path)
      ) {
        fail(`${label} is not a real, non-symlink directory.`);
      }
    },
  );
}

async function ensureSafeVolumeRoot(
  filesystem: MountedVolumeCanaryFileSystemPort,
  root: string,
): Promise<void> {
  try {
    await assertSafeDirectory(filesystem, root, "Mounted-volume root");
    return;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  const parent = dirname(root);
  await assertSafeDirectory(filesystem, parent, "Mounted-volume parent");
  const created = await filesystem.createDirectory(root, {
    recursive: false,
    exclusive: true,
  });
  if (created !== "created") {
    fail("Mounted-volume root creation lost its exclusive race.");
  }
  await filesystem.syncDirectory(parent);
  await assertSafeDirectory(filesystem, root, "Mounted-volume root");
}

async function assertRegularFile(
  filesystem: MountedVolumeCanaryFileSystemPort,
  path: string,
  label: string,
): Promise<void> {
  const observation = await filesystem.inspect(path);
  if (
    observation.kind !== "regular-file" ||
    observation.symbolicLink ||
    observation.linkCount !== 1
  ) {
    fail(`${label} is not a single-link regular file.`);
  }
}

function canaryHead(
  generation: number,
  previousHeadHash: string | null,
  payload: string,
): CanaryHead {
  const draft = {
    schemaVersion: 1 as const,
    domain: "dark-factory.mounted-volume-canary-head.v1" as const,
    generation,
    previousHeadHash,
    payloadHash: hash(payload),
    contentHash: "",
  };
  return {
    ...draft,
    contentHash: computeContentHash(draft),
  };
}

function headBytes(head: CanaryHead): Uint8Array {
  return Buffer.from(`${canonicalJson(head)}\n`, "utf8");
}

function parseHead(bytes: Uint8Array): CanaryHead {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    fail("Canary head is not JSON.");
  }
  if (!isPlainRecord(value)) {
    fail("Canary head is not an object.");
  }
  assertExactKeys(
    value,
    ["schemaVersion", "domain", "generation", "previousHeadHash", "payloadHash", "contentHash"],
    "Canary head",
  );
  if (
    value.schemaVersion !== 1 ||
    value.domain !== "dark-factory.mounted-volume-canary-head.v1" ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) <= 0 ||
    (value.previousHeadHash !== null &&
      (typeof value.previousHeadHash !== "string" || !SHA256.test(value.previousHeadHash))) ||
    typeof value.payloadHash !== "string" ||
    !SHA256.test(value.payloadHash) ||
    typeof value.contentHash !== "string" ||
    !SHA256.test(value.contentHash) ||
    value.contentHash !== computeContentHash(value) ||
    Buffer.from(bytes).toString("utf8") !== `${canonicalJson(value)}\n`
  ) {
    fail("Canary head is malformed or non-canonical.");
  }
  return value as unknown as CanaryHead;
}

function assertExpectedHead(observed: CanaryHead, expected: CanaryHead): void {
  if (
    observed.generation !== expected.generation ||
    observed.contentHash !== expected.contentHash ||
    observed.previousHeadHash !== expected.previousHeadHash
  ) {
    fail("Canary detected a rollback behind its established head.");
  }
}

async function atomicReplace(input: {
  readonly filesystem: MountedVolumeCanaryFileSystemPort;
  readonly directory: string;
  readonly target: string;
  readonly stagingName: string;
  readonly bytes: Uint8Array;
}): Promise<void> {
  const stagingPath = join(input.directory, input.stagingName);
  const created = await input.filesystem.createExclusiveSyncedFile(stagingPath, input.bytes);
  if (created !== "created") {
    fail("Canary staging file unexpectedly already exists.");
  }
  await assertRegularFile(input.filesystem, stagingPath, "Canary staging file");
  await input.filesystem.rename(stagingPath, input.target);
  await input.filesystem.syncDirectory(input.directory);
}

function strictReceipt(value: unknown): asserts value is MountedVolumeSemanticsCanaryReceipt {
  if (!isPlainRecord(value)) {
    fail("Mounted-volume semantics receipt is not an object.");
  }
  assertExactKeys(value, RECEIPT_KEYS, "Mounted-volume semantics receipt");
  if (!isPlainRecord(value.observations)) {
    fail("Mounted-volume semantics observations are not an object.");
  }
  assertExactKeys(value.observations, OBSERVATION_KEYS, "Mounted-volume semantics observations");
  const observations = value.observations;
  if (
    value.schemaVersion !== 1 ||
    value.domain !== "dark-factory.mounted-volume-semantics-canary.v1" ||
    value.policyVersion !== RECEIPT_POLICY_VERSION ||
    !["daytona", "e2b", "modal"].includes(String(value.provider)) ||
    typeof value.volumeRootHash !== "string" ||
    !SHA256.test(value.volumeRootHash) ||
    typeof value.volumeBindingHash !== "string" ||
    !SHA256.test(value.volumeBindingHash) ||
    typeof value.controllerInstanceIdHash !== "string" ||
    !SHA256.test(value.controllerInstanceIdHash) ||
    typeof value.controlImageDigest !== "string" ||
    !IMAGE_DIGEST.test(value.controlImageDigest) ||
    typeof value.runtimeIdentityHash !== "string" ||
    !SHA256.test(value.runtimeIdentityHash) ||
    typeof value.observedAt !== "string" ||
    !ISO_TIMESTAMP.test(value.observedAt) ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    typeof value.expiresAt !== "string" ||
    !ISO_TIMESTAMP.test(value.expiresAt) ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= Date.parse(value.observedAt) ||
    Date.parse(value.expiresAt) - Date.parse(value.observedAt) > MAXIMUM_RECEIPT_VALIDITY_MS ||
    observations.regularNonSymlinkPaths !== true ||
    observations.exclusiveCreationUnderContention !== true ||
    !Number.isSafeInteger(observations.exclusiveCreationContenderCount) ||
    observations.exclusiveCreationContenderCount !== EXCLUSIVE_CONTENDER_COUNT ||
    observations.exclusiveCreationWinnerCount !== 1 ||
    observations.sameVolumeAtomicRenameVisibility !== true ||
    !Number.isSafeInteger(observations.renameVisibilitySampleCount) ||
    observations.renameVisibilitySampleCount !==
      RENAME_READER_COUNT * RENAME_READS_PER_READER + 2 ||
    observations.fileFsyncCallSucceeded !== true ||
    observations.directoryFsyncCallSucceeded !== true ||
    observations.rollbackHeadDetection !== true ||
    value.crashDurabilityTested !== false ||
    value.crashDurabilityClaimed !== false ||
    typeof value.contentHash !== "string" ||
    !SHA256.test(value.contentHash) ||
    value.contentHash !== computeContentHash(value)
  ) {
    fail("Mounted-volume semantics receipt is invalid or incomplete.");
  }
}

export class NodeMountedVolumeCanaryFileSystem implements MountedVolumeCanaryFileSystemPort {
  async createDirectory(
    path: string,
    options: {
      readonly recursive: boolean;
      readonly exclusive: boolean;
    },
  ): Promise<"created" | "exists"> {
    try {
      await mkdir(path, {
        recursive: options.recursive,
        mode: 0o700,
      });
      return "created";
    } catch (error) {
      if (options.exclusive && isErrno(error, "EEXIST")) return "exists";
      throw error;
    }
  }

  async inspect(path: string): Promise<CanaryPathObservation> {
    const info = await lstat(path);
    return {
      kind: info.isDirectory() ? "directory" : info.isFile() ? "regular-file" : "other",
      symbolicLink: info.isSymbolicLink(),
      linkCount: info.nlink,
    };
  }

  resolveRealPath(path: string): Promise<string> {
    return realpath(path);
  }

  async createExclusiveSyncedFile(path: string, bytes: Uint8Array): Promise<"created" | "exists"> {
    if (bytes.byteLength <= 0 || bytes.byteLength > MAXIMUM_CANARY_FILE_BYTES) {
      fail("Canary file size is outside policy.");
    }
    let handle: FileHandle | undefined;
    try {
      try {
        handle = await open(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if (isErrno(error, "EEXIST")) return "exists";
        throw error;
      }
      await handle.writeFile(bytes);
      await handle.sync();
      return "created";
    } finally {
      await handle?.close();
    }
  }

  async readRegularFile(path: string): Promise<Uint8Array> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        // An atomic replacement may unlink the opened target before this
        // descriptor is inspected; link count zero is still a safe snapshot.
        opened.nlink > 1 ||
        opened.size <= 0 ||
        opened.size > MAXIMUM_CANARY_FILE_BYTES
      ) {
        fail("Canary attempted to read an unsafe file.");
      }
      const value = await handle.readFile();
      const after = await handle.stat();
      if (
        value.byteLength !== opened.size ||
        after.size !== opened.size ||
        after.ino !== opened.ino ||
        after.dev !== opened.dev
      ) {
        fail("Canary file changed while it was read.");
      }
      return value;
    } finally {
      await handle?.close();
    }
  }

  rename(source: string, target: string): Promise<void> {
    return rename(source, target);
  }

  async syncDirectory(path: string): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.sync();
    } finally {
      await handle?.close();
    }
  }

  removeTree(path: string): Promise<void> {
    return rm(path, { recursive: true, force: true });
  }
}

export class InProcessMountedVolumeCanaryWorkers implements MountedVolumeCanaryWorkerPort {
  async raceExclusiveCreation(input: {
    readonly filesystem: MountedVolumeCanaryFileSystemPort;
    readonly path: string;
    readonly payload: Uint8Array;
    readonly contenderCount: number;
  }): Promise<ExclusiveCreationRaceObservation> {
    const outcomes = await Promise.all(
      Array.from({ length: input.contenderCount }, async () =>
        input.filesystem.createExclusiveSyncedFile(input.path, input.payload),
      ),
    );
    return {
      contenderCount: outcomes.length,
      winnerCount: outcomes.filter((value) => value === "created").length,
      alreadyExistsCount: outcomes.filter((value) => value === "exists").length,
    };
  }

  async observeAtomicRename(input: {
    readonly filesystem: MountedVolumeCanaryFileSystemPort;
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly before: Uint8Array;
    readonly after: Uint8Array;
    readonly readerCount: number;
    readonly readsPerReader: number;
  }): Promise<AtomicRenameVisibilityObservation> {
    let beforeCount = 0;
    let afterCount = 0;
    let missingCount = 0;
    let invalidCount = 0;

    const observe = async (): Promise<void> => {
      try {
        const value = await input.filesystem.readRegularFile(input.targetPath);
        if (equalBytes(value, input.before)) beforeCount += 1;
        else if (equalBytes(value, input.after)) afterCount += 1;
        else invalidCount += 1;
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          missingCount += 1;
          return;
        }
        throw error;
      }
    };

    await observe();
    const readers = Array.from({ length: input.readerCount }, async () => {
      for (let index = 0; index < input.readsPerReader; index += 1) {
        await observe();
        await yieldToEventLoop();
      }
    });
    await yieldToEventLoop();
    await input.filesystem.rename(input.sourcePath, input.targetPath);
    await Promise.all(readers);
    await observe();

    return {
      sampleCount: beforeCount + afterCount + missingCount + invalidCount,
      beforeCount,
      afterCount,
      missingCount,
      invalidCount,
    };
  }
}

export async function runMountedVolumeSemanticsCanary(
  options: RunMountedVolumeSemanticsCanaryOptions,
): Promise<MountedVolumeSemanticsCanaryReceipt> {
  options.runtimeGuard.assertTrustedCloudRuntime();
  const root = boundedVolumeRoot(options.volumeRoot);
  const filesystem = options.filesystem ?? new NodeMountedVolumeCanaryFileSystem();
  const workers = options.workers ?? new InProcessMountedVolumeCanaryWorkers();
  const now = options.now ?? (() => new Date());
  const validityMs = options.receiptValidityMs ?? RECEIPT_VALIDITY_MS;
  if (
    !Number.isSafeInteger(validityMs) ||
    validityMs <= 0 ||
    validityMs > MAXIMUM_RECEIPT_VALIDITY_MS ||
    !IMAGE_DIGEST.test(options.controlImageDigest)
  ) {
    fail("Mounted-volume canary policy inputs are invalid.");
  }
  assertRuntimeIdentity(options.provider, options.runtimeIdentity);
  const observedDate = now();
  const observedAt = canonicalTimestamp(observedDate, "Canary observation time");
  const expiresAt = canonicalTimestamp(
    new Date(observedDate.getTime() + validityMs),
    "Canary expiry time",
  );
  const nonce = (options.nonceFactory ?? (() => randomBytes(24).toString("hex")))();
  if (!/^[a-f0-9]{48}$/u.test(nonce)) {
    fail("Mounted-volume canary nonce is malformed.");
  }
  const canaryRoot = join(root, `.df-volume-canary-${nonce}`);
  let canaryRootCreated = false;
  let receipt: MountedVolumeSemanticsCanaryReceipt | undefined;
  let primaryFailure: { readonly error: unknown } | undefined;
  let cleanupFailure: { readonly error: unknown } | undefined;

  try {
    await ensureSafeVolumeRoot(filesystem, root);
    const directoryResult = await filesystem.createDirectory(canaryRoot, {
      recursive: false,
      exclusive: true,
    });
    if (directoryResult !== "created") {
      fail("Mounted-volume canary directory already exists.");
    }
    canaryRootCreated = true;
    await assertSafeDirectory(filesystem, canaryRoot, "Mounted-volume canary directory");
    await filesystem.syncDirectory(root);
    await filesystem.syncDirectory(canaryRoot);

    const exclusivePath = join(canaryRoot, "exclusive-create");
    const exclusivePayload = Buffer.from("dark-factory-exclusive-create-v1\n", "utf8");
    const exclusive = await workers.raceExclusiveCreation({
      filesystem,
      path: exclusivePath,
      payload: exclusivePayload,
      contenderCount: EXCLUSIVE_CONTENDER_COUNT,
    });
    if (
      exclusive.contenderCount !== EXCLUSIVE_CONTENDER_COUNT ||
      exclusive.winnerCount !== 1 ||
      exclusive.alreadyExistsCount !== EXCLUSIVE_CONTENDER_COUNT - 1 ||
      exclusive.winnerCount + exclusive.alreadyExistsCount !== exclusive.contenderCount
    ) {
      fail("Mounted volume did not demonstrate exclusive creation under contention.");
    }
    await assertRegularFile(filesystem, exclusivePath, "Exclusive-creation winner");
    if (!equalBytes(await filesystem.readRegularFile(exclusivePath), exclusivePayload)) {
      fail("Exclusive-creation winner contains unexpected bytes.");
    }
    await filesystem.syncDirectory(canaryRoot);

    const before = Buffer.from("dark-factory-rename-state-before-v1\n", "utf8");
    const after = Buffer.from("dark-factory-rename-state-after-v1-\n", "utf8");
    if (before.byteLength !== after.byteLength) {
      fail("Atomic-rename canary payloads are not size-matched.");
    }
    const renameTarget = join(canaryRoot, "rename-target");
    const renameSource = join(canaryRoot, "rename-source");
    if (
      (await filesystem.createExclusiveSyncedFile(renameTarget, before)) !== "created" ||
      (await filesystem.createExclusiveSyncedFile(renameSource, after)) !== "created"
    ) {
      fail("Atomic-rename canary files were not created exclusively.");
    }
    await filesystem.syncDirectory(canaryRoot);
    const visibility = await workers.observeAtomicRename({
      filesystem,
      sourcePath: renameSource,
      targetPath: renameTarget,
      before,
      after,
      readerCount: RENAME_READER_COUNT,
      readsPerReader: RENAME_READS_PER_READER,
    });
    if (
      visibility.sampleCount !== RENAME_READER_COUNT * RENAME_READS_PER_READER + 2 ||
      visibility.beforeCount < 1 ||
      visibility.afterCount < 1 ||
      visibility.missingCount !== 0 ||
      visibility.invalidCount !== 0 ||
      visibility.beforeCount +
        visibility.afterCount +
        visibility.missingCount +
        visibility.invalidCount !==
        visibility.sampleCount
    ) {
      fail("Mounted volume did not demonstrate same-volume atomic rename visibility.");
    }
    await assertRegularFile(filesystem, renameTarget, "Atomic-rename target");
    await filesystem.syncDirectory(canaryRoot);

    const headPath = join(canaryRoot, "head.json");
    const firstHead = canaryHead(1, null, "first");
    const secondHead = canaryHead(2, firstHead.contentHash, "second");
    await atomicReplace({
      filesystem,
      directory: canaryRoot,
      target: headPath,
      stagingName: "head-1.staging",
      bytes: headBytes(firstHead),
    });
    assertExpectedHead(parseHead(await filesystem.readRegularFile(headPath)), firstHead);
    await atomicReplace({
      filesystem,
      directory: canaryRoot,
      target: headPath,
      stagingName: "head-2.staging",
      bytes: headBytes(secondHead),
    });
    assertExpectedHead(parseHead(await filesystem.readRegularFile(headPath)), secondHead);
    await atomicReplace({
      filesystem,
      directory: canaryRoot,
      target: headPath,
      stagingName: "head-rollback.staging",
      bytes: headBytes(firstHead),
    });
    let rollbackDetected = false;
    try {
      assertExpectedHead(parseHead(await filesystem.readRegularFile(headPath)), secondHead);
    } catch (error) {
      if (error instanceof MountedVolumeSemanticsCanaryError && /rollback/u.test(error.message)) {
        rollbackDetected = true;
      } else {
        throw error;
      }
    }
    if (!rollbackDetected) {
      fail("Mounted-volume canary failed to detect a head rollback.");
    }
    await atomicReplace({
      filesystem,
      directory: canaryRoot,
      target: headPath,
      stagingName: "head-restore.staging",
      bytes: headBytes(secondHead),
    });
    assertExpectedHead(parseHead(await filesystem.readRegularFile(headPath)), secondHead);

    options.runtimeGuard.assertTrustedCloudRuntime();
    const draft = {
      schemaVersion: 1 as const,
      domain: "dark-factory.mounted-volume-semantics-canary.v1" as const,
      policyVersion: RECEIPT_POLICY_VERSION,
      provider: options.provider,
      volumeRootHash: computeMountedVolumeRootHash(root),
      volumeBindingHash: computeMountedVolumeBindingHash({
        provider: options.provider,
        volumeId: options.volumeId,
        volumeSubpath: options.volumeSubpath,
        volumeRoot: root,
      }),
      controllerInstanceIdHash: hash(options.runtimeIdentity.marker.sandboxId),
      controlImageDigest: options.controlImageDigest,
      runtimeIdentityHash: computeMountedVolumeRuntimeIdentityHash({
        provider: options.provider,
        controlImageDigest: options.controlImageDigest,
        runtimeIdentity: options.runtimeIdentity,
      }),
      observedAt,
      expiresAt,
      observations: {
        regularNonSymlinkPaths: true as const,
        exclusiveCreationUnderContention: true as const,
        exclusiveCreationContenderCount: exclusive.contenderCount,
        exclusiveCreationWinnerCount: 1 as const,
        sameVolumeAtomicRenameVisibility: true as const,
        renameVisibilitySampleCount: visibility.sampleCount,
        fileFsyncCallSucceeded: true as const,
        directoryFsyncCallSucceeded: true as const,
        rollbackHeadDetection: true as const,
      },
      crashDurabilityTested: false as const,
      crashDurabilityClaimed: false as const,
      contentHash: "",
    } satisfies MountedVolumeSemanticsCanaryReceipt;
    receipt = {
      ...draft,
      contentHash: computeContentHash(draft),
    };
    strictReceipt(receipt);
  } catch (error) {
    primaryFailure = { error };
  } finally {
    if (canaryRootCreated) {
      try {
        await filesystem.removeTree(canaryRoot);
        await filesystem.syncDirectory(root);
      } catch (error) {
        cleanupFailure = { error };
      }
    }
  }
  if (cleanupFailure !== undefined) {
    if (primaryFailure === undefined) throw cleanupFailure.error;
    throw new AggregateError(
      [primaryFailure.error, cleanupFailure.error],
      "Mounted-volume canary failed and its cleanup also failed.",
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure.error;
  if (receipt === undefined) {
    fail("Mounted-volume canary completed without an attested receipt.");
  }
  return receipt;
}

/**
 * Runtime-bound guard for the mutable-state stores. This verifies a fresh,
 * canonical observation receipt from this exact mounted-volume binding. It is
 * deliberately not a provider-crash durability certificate.
 */
export class AttestedMountedVolumeStateSemanticsGuard implements MountedVolumeStateSemanticsGuard {
  readonly #receipt: MountedVolumeSemanticsCanaryReceipt;
  readonly #provider: CloudProviderName;
  readonly #volumeRoot: string;
  readonly #volumeRootHash: string;
  readonly #volumeBindingHash: string;
  readonly #controllerInstanceIdHash: string;
  readonly #controlImageDigest: `sha256:${string}`;
  readonly #runtimeIdentityHash: string;
  readonly #runtimeGuard: TrustedArtifactRuntimeGuard;
  readonly #now: () => Date;

  constructor(options: AttestedMountedVolumeStateSemanticsGuardOptions) {
    options.runtimeGuard.assertTrustedCloudRuntime();
    strictReceipt(options.receipt);
    this.#receipt = JSON.parse(
      canonicalJson(options.receipt),
    ) as MountedVolumeSemanticsCanaryReceipt;
    this.#provider = options.provider;
    this.#volumeRoot = boundedVolumeRoot(options.volumeRoot);
    this.#volumeRootHash = computeMountedVolumeRootHash(this.#volumeRoot);
    this.#volumeBindingHash = computeMountedVolumeBindingHash({
      provider: options.provider,
      volumeId: options.volumeId,
      volumeSubpath: options.volumeSubpath,
      volumeRoot: this.#volumeRoot,
    });
    this.#controllerInstanceIdHash = hash(options.runtimeIdentity.marker.sandboxId);
    this.#controlImageDigest = options.controlImageDigest;
    this.#runtimeIdentityHash = computeMountedVolumeRuntimeIdentityHash({
      provider: options.provider,
      controlImageDigest: options.controlImageDigest,
      runtimeIdentity: options.runtimeIdentity,
    });
    this.#runtimeGuard = options.runtimeGuard;
    this.#now = options.now ?? (() => new Date());
    this.#assertReceipt();
  }

  #assertReceipt(): void {
    this.#runtimeGuard.assertTrustedCloudRuntime();
    strictReceipt(this.#receipt);
    const currentTime = this.#now();
    if (
      !(currentTime instanceof Date) ||
      !Number.isFinite(currentTime.getTime()) ||
      currentTime.getTime() < Date.parse(this.#receipt.observedAt) ||
      currentTime.getTime() >= Date.parse(this.#receipt.expiresAt) ||
      this.#receipt.provider !== this.#provider ||
      this.#receipt.volumeRootHash !== this.#volumeRootHash ||
      this.#receipt.volumeBindingHash !== this.#volumeBindingHash ||
      this.#receipt.controllerInstanceIdHash !== this.#controllerInstanceIdHash ||
      this.#receipt.controlImageDigest !== this.#controlImageDigest ||
      this.#receipt.runtimeIdentityHash !== this.#runtimeIdentityHash
    ) {
      fail(
        "Mounted-volume semantics receipt is stale or does not match the exact runtime binding.",
      );
    }
  }

  assertLinearizableStateVolume(input: {
    readonly volumeRoot: string;
    readonly namespace: string;
  }): void {
    this.#assertReceipt();
    if (
      boundedVolumeRoot(input.volumeRoot) !== this.#volumeRoot ||
      !SAFE_NAMESPACE.test(input.namespace)
    ) {
      fail("Mutable state request does not match the attested volume or has an unsafe namespace.");
    }
  }
}
