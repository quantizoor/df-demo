import { createHash } from "node:crypto";
import { assertCloudExecutionEnvironment } from "./runtime-marker.js";
import type {
  CloudProviderName,
  TrustedCloudArtifactRef,
} from "./types.js";

const SAFE_TRUSTED_URI =
  /^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const SAFE_MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export class TrustedArtifactBridgeError extends Error {
  override readonly name = "TrustedArtifactBridgeError";
}

export interface TrustedArtifactRuntimeGuard {
  /**
   * Must throw unless the caller is an approved trusted cloud control-plane
   * process. There is deliberately no permissive/default local guard.
   */
  assertTrustedCloudRuntime(): void;
}

export interface CloudMarkerTrustedArtifactRuntimeGuardOptions {
  readonly provider: CloudProviderName;
  readonly environment?: () => NodeJS.ProcessEnv;
}

/**
 * Baseline marker guard for a trusted controller running in an approved
 * provider sandbox. Environment variables are not cryptographic attestation:
 * production deployment policy must prevent callers from self-assigning these
 * markers or replace this guard with a provider-backed attestor.
 */
export class CloudMarkerTrustedArtifactRuntimeGuard
  implements TrustedArtifactRuntimeGuard
{
  readonly #provider: CloudProviderName;
  readonly #environment: () => NodeJS.ProcessEnv;

  constructor(options: CloudMarkerTrustedArtifactRuntimeGuardOptions) {
    this.#provider = options.provider;
    this.#environment = options.environment ?? (() => process.env);
  }

  assertTrustedCloudRuntime(): void {
    const environment = this.#environment();
    if (environment["DF_TRUSTED_CONTROL_PLANE"] !== "1") {
      throw new TrustedArtifactBridgeError(
        "Trusted artifact access requires a trusted cloud control-plane marker.",
      );
    }
    assertCloudExecutionEnvironment(this.#provider, environment);
  }
}

export interface TrustedArtifactWriteSession {
  readonly uri: `trusted://${string}`;
  write(chunk: Uint8Array): Promise<void>;
  commit(input: {
    readonly sha256: string;
    readonly byteLength: number;
    readonly mediaType: string;
  }): Promise<TrustedCloudArtifactRef>;
  abort(): Promise<void>;
}

/**
 * Storage-specific operations. Implementations live in the trusted cloud
 * control plane and must never materialize artifacts in an optimizer-visible
 * or workstation-local filesystem.
 */
export interface TrustedArtifactBackend {
  open(
    uri: `trusted://${string}`,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>>;
  createWrite(input: {
    readonly uri: `trusted://${string}`;
    readonly mediaType: string;
    readonly signal?: AbortSignal;
  }): Promise<TrustedArtifactWriteSession>;
}

export interface TrustedArtifactBridge {
  assertTrustedRuntime(): void;
  openVerified(
    artifact: TrustedCloudArtifactRef,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>>;
  persistVerified(input: {
    readonly uri: `trusted://${string}`;
    readonly mediaType: string;
    readonly chunks: AsyncIterable<Uint8Array>;
    readonly signal?: AbortSignal;
  }): Promise<TrustedCloudArtifactRef>;
}

function assertArtifactReference(artifact: TrustedCloudArtifactRef): void {
  if (
    !SAFE_TRUSTED_URI.test(artifact.uri) ||
    artifact.uri.includes("..") ||
    !SHA256.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength < 0 ||
    !SAFE_MEDIA_TYPE.test(artifact.mediaType)
  ) {
    throw new TrustedArtifactBridgeError(
      "Trusted artifact metadata is malformed.",
    );
  }
}

function assertDestination(
  uri: `trusted://${string}`,
  mediaType: string,
): void {
  if (
    !SAFE_TRUSTED_URI.test(uri) ||
    uri.includes("..") ||
    !SAFE_MEDIA_TYPE.test(mediaType)
  ) {
    throw new TrustedArtifactBridgeError(
      "Trusted artifact destination is malformed.",
    );
  }
}

function asBytes(chunk: Uint8Array): Uint8Array {
  if (!(chunk instanceof Uint8Array)) {
    throw new TrustedArtifactBridgeError(
      "Trusted artifact streams may contain only byte chunks.",
    );
  }
  return chunk;
}

/**
 * Hashes and counts every byte on both sides of the storage boundary. A
 * backend cannot make a partial upload/download look valid: EOF, digest,
 * length, and committed metadata must all agree before success is returned.
 */
export class VerifyingTrustedArtifactBridge implements TrustedArtifactBridge {
  readonly #backend: TrustedArtifactBackend;
  readonly #runtimeGuard: TrustedArtifactRuntimeGuard;

  constructor(
    backend: TrustedArtifactBackend,
    runtimeGuard: TrustedArtifactRuntimeGuard,
  ) {
    this.#backend = backend;
    this.#runtimeGuard = runtimeGuard;
  }

  assertTrustedRuntime(): void {
    this.#runtimeGuard.assertTrustedCloudRuntime();
  }

  async openVerified(
    artifact: TrustedCloudArtifactRef,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>> {
    this.assertTrustedRuntime();
    assertArtifactReference(artifact);
    const source = await this.#backend.open(artifact.uri, signal);
    return {
      [Symbol.asyncIterator]: async function* () {
        const hash = createHash("sha256");
        let byteLength = 0;
        let reachedEof = false;
        try {
          for await (const rawChunk of source) {
            if (signal?.aborted === true) {
              throw new TrustedArtifactBridgeError(
                "Trusted artifact read was cancelled.",
              );
            }
            const chunk = asBytes(rawChunk);
            byteLength += chunk.byteLength;
            if (
              !Number.isSafeInteger(byteLength) ||
              byteLength > artifact.byteLength
            ) {
              throw new TrustedArtifactBridgeError(
                "Trusted artifact length exceeds its sealed metadata.",
              );
            }
            hash.update(chunk);
            yield chunk;
          }
          reachedEof = true;
        } finally {
          if (
            !reachedEof ||
            byteLength !== artifact.byteLength ||
            hash.digest("hex") !== artifact.sha256
          ) {
            throw new TrustedArtifactBridgeError(
              "Trusted artifact content does not match its sealed metadata.",
            );
          }
        }
      },
    };
  }

  async persistVerified(input: {
    readonly uri: `trusted://${string}`;
    readonly mediaType: string;
    readonly chunks: AsyncIterable<Uint8Array>;
    readonly signal?: AbortSignal;
  }): Promise<TrustedCloudArtifactRef> {
    this.assertTrustedRuntime();
    assertDestination(input.uri, input.mediaType);
    const session = await this.#backend.createWrite({
      uri: input.uri,
      mediaType: input.mediaType,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (session.uri !== input.uri) {
      await session.abort();
      throw new TrustedArtifactBridgeError(
        "Trusted artifact backend changed the sealed destination.",
      );
    }

    const hash = createHash("sha256");
    let byteLength = 0;
    try {
      for await (const rawChunk of input.chunks) {
        if (input.signal?.aborted === true) {
          throw new TrustedArtifactBridgeError(
            "Trusted artifact write was cancelled.",
          );
        }
        const chunk = asBytes(rawChunk);
        byteLength += chunk.byteLength;
        if (!Number.isSafeInteger(byteLength)) {
          throw new TrustedArtifactBridgeError(
            "Trusted artifact is too large to represent safely.",
          );
        }
        hash.update(chunk);
        await session.write(chunk);
      }
      const sha256 = hash.digest("hex");
      const artifact = await session.commit({
        sha256,
        byteLength,
        mediaType: input.mediaType,
      });
      assertArtifactReference(artifact);
      if (
        artifact.uri !== input.uri ||
        artifact.sha256 !== sha256 ||
        artifact.byteLength !== byteLength ||
        artifact.mediaType !== input.mediaType
      ) {
        throw new TrustedArtifactBridgeError(
          "Trusted artifact commit metadata does not match streamed bytes.",
        );
      }
      return artifact;
    } catch (error) {
      try {
        await session.abort();
      } catch {
        // The content/digest failure remains authoritative. The storage
        // service reconciles abandoned write sessions by their sealed URI.
      }
      throw error;
    }
  }
}
