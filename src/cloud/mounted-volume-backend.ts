import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

import type {
  TrustedArtifactBackend,
  TrustedArtifactRuntimeGuard,
  TrustedArtifactWriteSession,
} from "./artifact-bridge.js";
import { TrustedArtifactBridgeError } from "./artifact-bridge.js";
import type { TrustedCloudArtifactRef } from "./types.js";

const TRUSTED_URI =
  /^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u;
const MAX_METADATA_BYTES = 4_096;

interface StoredArtifactMetadata {
  readonly schemaVersion: 1;
  readonly uri: `trusted://${string}`;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

export interface MountedVolumeTrustedArtifactBackendOptions {
  /**
   * Absolute mount point of a provider-managed persistent volume. It must not
   * be the filesystem root. This backend has no workstation mode.
   */
  readonly volumeRoot: string;
  readonly runtimeGuard: TrustedArtifactRuntimeGuard;
}

function assertTrustedUri(uri: `trusted://${string}`): void {
  if (
    !TRUSTED_URI.test(uri) ||
    uri.includes("..") ||
    uri.split("/").some((component) => component === "." || component === "..")
  ) {
    throw new TrustedArtifactBridgeError(
      "Mounted-volume artifact URI is malformed.",
    );
  }
}

function artifactDigest(uri: `trusted://${string}`): string {
  return createHash("sha256").update(uri, "utf8").digest("hex");
}

function metadataJson(metadata: StoredArtifactMetadata): string {
  return `${JSON.stringify(metadata)}\n`;
}

function parseMetadata(
  raw: string,
  expectedUri: `trusted://${string}`,
): StoredArtifactMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TrustedArtifactBridgeError(
      "Mounted-volume artifact metadata is invalid.",
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw new TrustedArtifactBridgeError(
      "Mounted-volume artifact metadata must be a plain object.",
    );
  }
  const record = parsed as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (
    keys.length !== 5 ||
    !keys.every((key) =>
      [
        "schemaVersion",
        "uri",
        "sha256",
        "byteLength",
        "mediaType",
      ].includes(key),
    ) ||
    record.schemaVersion !== 1 ||
    record.uri !== expectedUri ||
    typeof record.sha256 !== "string" ||
    !SHA256.test(record.sha256) ||
    !Number.isSafeInteger(record.byteLength) ||
    (record.byteLength as number) < 0 ||
    typeof record.mediaType !== "string" ||
    !MEDIA_TYPE.test(record.mediaType)
  ) {
    throw new TrustedArtifactBridgeError(
      "Mounted-volume artifact metadata does not match its URI.",
    );
  }
  return record as unknown as StoredArtifactMetadata;
}

async function requireRegularFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TrustedArtifactBridgeError(
      `Mounted-volume ${label} is not a regular file.`,
    );
  }
}

async function sha256File(path: string): Promise<{
  readonly sha256: string;
  readonly byteLength: number;
}> {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    if (!(chunk instanceof Buffer)) {
      throw new TrustedArtifactBridgeError(
        "Mounted-volume artifact stream is malformed.",
      );
    }
    byteLength += chunk.byteLength;
    if (!Number.isSafeInteger(byteLength)) {
      throw new TrustedArtifactBridgeError(
        "Mounted-volume artifact is too large.",
      );
    }
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), byteLength };
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  try {
    await handle.close();
  } catch {
    // The authoritative operation will still fail.
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) {
      throw new TrustedArtifactBridgeError(
        "Mounted-volume artifact write made no forward progress.",
      );
    }
    offset += bytesWritten;
  }
}

/**
 * Durable content-addressed storage for a provider-managed volume mounted into
 * the trusted control-plane sandbox. URI-to-path mapping is a one-way digest,
 * so URI prefix tricks cannot alias files or directories.
 */
export class MountedVolumeTrustedArtifactBackend
  implements TrustedArtifactBackend
{
  readonly #root: string;
  readonly #objectsRoot: string;
  readonly #stagingRoot: string;
  readonly #runtimeGuard: TrustedArtifactRuntimeGuard;
  #initialized = false;

  constructor(options: MountedVolumeTrustedArtifactBackendOptions) {
    const root = resolve(options.volumeRoot);
    if (
      !isAbsolute(options.volumeRoot) ||
      root === sep ||
      options.volumeRoot.includes("\u0000") ||
      options.volumeRoot.includes(`${sep}..${sep}`)
    ) {
      throw new TrustedArtifactBridgeError(
        "Trusted artifact volume root must be a bounded absolute path.",
      );
    }
    this.#root = root;
    this.#objectsRoot = join(root, "objects");
    this.#stagingRoot = join(root, ".staging");
    this.#runtimeGuard = options.runtimeGuard;
  }

  async #initialize(): Promise<void> {
    this.#runtimeGuard.assertTrustedCloudRuntime();
    if (this.#initialized) return;
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.#root);
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      (await realpath(this.#root)) !== this.#root
    ) {
      throw new TrustedArtifactBridgeError(
        "Trusted artifact volume root is not a real directory.",
      );
    }
    await mkdir(this.#objectsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.#stagingRoot, { recursive: true, mode: 0o700 });
    for (const path of [this.#objectsRoot, this.#stagingRoot]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new TrustedArtifactBridgeError(
          "Trusted artifact volume contains an unsafe control directory.",
        );
      }
    }
    this.#initialized = true;
  }

  #objectDirectory(uri: `trusted://${string}`): string {
    const digest = artifactDigest(uri);
    return join(this.#objectShardDirectory(uri), digest);
  }

  #objectShardDirectory(uri: `trusted://${string}`): string {
    return join(this.#objectsRoot, artifactDigest(uri).slice(0, 2));
  }

  async #requireObjectShard(
    uri: `trusted://${string}`,
    create: boolean,
  ): Promise<string> {
    const shard = this.#objectShardDirectory(uri);
    if (create) {
      try {
        await mkdir(shard, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          String((error as NodeJS.ErrnoException).code) !== "EEXIST"
        ) {
          throw error;
        }
      }
    }
    const info = await lstat(shard);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(shard)) !== shard
    ) {
      throw new TrustedArtifactBridgeError(
        "Mounted-volume artifact shard is unsafe.",
      );
    }
    return shard;
  }

  async #readMetadata(
    uri: `trusted://${string}`,
  ): Promise<StoredArtifactMetadata> {
    await this.#requireObjectShard(uri, false);
    const directory = this.#objectDirectory(uri);
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new TrustedArtifactBridgeError(
        "Mounted-volume artifact directory is unsafe.",
      );
    }
    const metadataPath = join(directory, "metadata.json");
    const dataPath = join(directory, "data");
    await requireRegularFile(metadataPath, "metadata");
    await requireRegularFile(dataPath, "data");
    const metadataInfo = await stat(metadataPath);
    if (metadataInfo.size <= 0 || metadataInfo.size > MAX_METADATA_BYTES) {
      throw new TrustedArtifactBridgeError(
        "Mounted-volume artifact metadata size is outside policy.",
      );
    }
    return parseMetadata(await readFile(metadataPath, "utf8"), uri);
  }

  async open(
    uri: `trusted://${string}`,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>> {
    await this.#initialize();
    assertTrustedUri(uri);
    if (signal?.aborted === true) {
      throw new TrustedArtifactBridgeError(
        "Mounted-volume artifact read was cancelled.",
      );
    }
    const metadata = await this.#readMetadata(uri);
    const dataPath = join(this.#objectDirectory(uri), "data");
    const source = createReadStream(dataPath);
    return {
      [Symbol.asyncIterator]: async function* () {
        let byteLength = 0;
        const hash = createHash("sha256");
        try {
          for await (const chunk of source) {
            if (signal?.aborted === true) {
              source.destroy();
              throw new TrustedArtifactBridgeError(
                "Mounted-volume artifact read was cancelled.",
              );
            }
            if (!(chunk instanceof Buffer)) {
              throw new TrustedArtifactBridgeError(
                "Mounted-volume artifact stream is malformed.",
              );
            }
            byteLength += chunk.byteLength;
            if (
              !Number.isSafeInteger(byteLength) ||
              byteLength > metadata.byteLength
            ) {
              throw new TrustedArtifactBridgeError(
                "Mounted-volume artifact length exceeds metadata.",
              );
            }
            hash.update(chunk);
            yield chunk;
          }
        } finally {
          if (
            byteLength !== metadata.byteLength ||
            hash.digest("hex") !== metadata.sha256
          ) {
            throw new TrustedArtifactBridgeError(
              "Mounted-volume artifact failed its backend integrity check.",
            );
          }
        }
      },
    };
  }

  async createWrite(input: {
    readonly uri: `trusted://${string}`;
    readonly mediaType: string;
    readonly signal?: AbortSignal;
  }): Promise<TrustedArtifactWriteSession> {
    await this.#initialize();
    assertTrustedUri(input.uri);
    if (
      !MEDIA_TYPE.test(input.mediaType) ||
      input.signal?.aborted === true
    ) {
      throw new TrustedArtifactBridgeError(
        "Mounted-volume artifact write request is malformed or cancelled.",
      );
    }
    const stagingName = `${artifactDigest(input.uri)}-${randomBytes(18).toString("hex")}`;
    const stagingDirectory = join(this.#stagingRoot, stagingName);
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    const stagingData = join(stagingDirectory, "data");
    let handle: FileHandle | undefined = await open(
      stagingData,
      "wx",
      0o600,
    );
    let closed = false;
    let byteLength = 0;
    const hash = createHash("sha256");

    const abort = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await closeQuietly(handle);
      handle = undefined;
      await rm(stagingDirectory, { recursive: true, force: true });
    };

    return {
      uri: input.uri,
      write: async (chunk): Promise<void> => {
        if (
          closed ||
          handle === undefined ||
          input.signal?.aborted === true ||
          !(chunk instanceof Uint8Array)
        ) {
          throw new TrustedArtifactBridgeError(
            "Mounted-volume artifact write is closed, cancelled, or malformed.",
          );
        }
        byteLength += chunk.byteLength;
        if (!Number.isSafeInteger(byteLength)) {
          throw new TrustedArtifactBridgeError(
            "Mounted-volume artifact is too large.",
          );
        }
        hash.update(chunk);
        await writeAll(handle, chunk);
      },
      commit: async (expected): Promise<TrustedCloudArtifactRef> => {
        if (
          closed ||
          handle === undefined ||
          input.signal?.aborted === true ||
          expected.mediaType !== input.mediaType ||
          expected.byteLength !== byteLength ||
          !SHA256.test(expected.sha256)
        ) {
          throw new TrustedArtifactBridgeError(
            "Mounted-volume artifact commit is detached from its stream.",
          );
        }
        const actualSha256 = hash.digest("hex");
        if (actualSha256 !== expected.sha256) {
          throw new TrustedArtifactBridgeError(
            "Mounted-volume artifact commit digest is inconsistent.",
          );
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        const metadata: StoredArtifactMetadata = {
          schemaVersion: 1,
          uri: input.uri,
          sha256: actualSha256,
          byteLength,
          mediaType: input.mediaType,
        };
        const stagingMetadata = join(stagingDirectory, "metadata.json");
        await writeFile(stagingMetadata, metadataJson(metadata), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        const targetDirectory = this.#objectDirectory(input.uri);
        await this.#requireObjectShard(input.uri, true);
        try {
          await rename(stagingDirectory, targetDirectory);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            !new Set(["EEXIST", "ENOTEMPTY"]).has(
              String((error as NodeJS.ErrnoException).code),
            )
          ) {
            throw error;
          }
          const existing = await this.#readMetadata(input.uri);
          const existingData = await sha256File(
            join(targetDirectory, "data"),
          );
          if (
            existing.sha256 !== metadata.sha256 ||
            existing.byteLength !== metadata.byteLength ||
            existing.mediaType !== metadata.mediaType ||
            existingData.sha256 !== metadata.sha256 ||
            existingData.byteLength !== metadata.byteLength
          ) {
            throw new TrustedArtifactBridgeError(
              "Mounted-volume artifact URI already contains different bytes.",
            );
          }
          await rm(stagingDirectory, { recursive: true, force: true });
        }
        closed = true;
        return {
          uri: input.uri,
          sha256: actualSha256,
          mediaType: input.mediaType,
          byteLength,
        };
      },
      abort,
    };
  }
}
