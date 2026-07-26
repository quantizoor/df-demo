import type { TrustedOptimizerReleaseArtifactReader } from "../optimizer/release-artifact-safety.js";
import type { TrustedArtifactBridge } from "./artifact-bridge.js";
import type { TrustedCloudArtifactRef } from "./types.js";

const MAXIMUM_BYTES = 512 * 1024 * 1024;
const MAXIMUM_CHUNKS = 131_072;

export class TrustedOptimizerReleaseArtifactReaderError extends Error {
  override readonly name = "TrustedOptimizerReleaseArtifactReaderError";

  constructor() {
    super("Trusted optimizer artifact byte read failed closed.");
  }
}

function fail(): never {
  throw new TrustedOptimizerReleaseArtifactReaderError();
}

/**
 * Concrete, bounded byte reader over the verifying artifact bridge. The
 * resolver separately re-hashes and inspects the returned bytes, so neither
 * the backend nor this adapter can substitute an unchecked Boolean receipt.
 */
export class BridgeBackedTrustedOptimizerReleaseArtifactReader
  implements TrustedOptimizerReleaseArtifactReader
{
  readonly boundary = "trusted-cloud-optimizer-release-artifact-reader" as const;
  readonly #openVerified: TrustedArtifactBridge["openVerified"];

  constructor(bridge: TrustedArtifactBridge) {
    if (
      typeof bridge?.assertTrustedRuntime !== "function" ||
      typeof bridge?.openVerified !== "function"
    ) {
      fail();
    }
    this.#openVerified = bridge.openVerified.bind(bridge);
  }

  async readBytes(artifact: TrustedCloudArtifactRef, maximumBytes: number): Promise<Uint8Array> {
    let capturedArtifact: TrustedCloudArtifactRef;
    try {
      capturedArtifact = structuredClone(artifact);
    } catch {
      fail();
    }
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes <= 0 ||
      maximumBytes > MAXIMUM_BYTES ||
      !Number.isSafeInteger(capturedArtifact.byteLength) ||
      capturedArtifact.byteLength <= 0 ||
      capturedArtifact.byteLength > maximumBytes
    ) {
      fail();
    }
    Object.freeze(capturedArtifact);
    const expectedByteLength = capturedArtifact.byteLength;
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let chunkCount = 0;
    try {
      const source = await this.#openVerified(capturedArtifact);
      for await (const chunk of source) {
        chunkCount += 1;
        if (
          !(chunk instanceof Uint8Array) ||
          chunk.byteLength === 0 ||
          chunkCount > MAXIMUM_CHUNKS
        ) {
          fail();
        }
        byteLength += chunk.byteLength;
        if (
          !Number.isSafeInteger(byteLength) ||
          byteLength > expectedByteLength ||
          byteLength > maximumBytes
        ) {
          fail();
        }
        chunks.push(Uint8Array.from(chunk));
      }
    } catch {
      fail();
    }
    if (byteLength !== expectedByteLength) fail();
    return Uint8Array.from(Buffer.concat(chunks, byteLength));
  }
}
