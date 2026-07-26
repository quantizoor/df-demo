import type { TrustedOptimizerArtifactReader } from "../optimizer/cloud-session.js";
import type { TrustedArtifactBridge } from "./artifact-bridge.js";
import type { TrustedCloudArtifactRef } from "./types.js";

const MAXIMUM_JSON_BYTES = 64 * 1024 * 1024;

export class TrustedJsonArtifactReaderError extends Error {
  override readonly name = "TrustedJsonArtifactReaderError";
}

/**
 * Bounded UTF-8 adapter over the verifying trusted-artifact bridge. It is
 * deliberately JSON-specific: callers cannot reinterpret a tar, bundle, diff,
 * or encrypted raw artifact as trusted control data.
 */
export class VerifyingTrustedJsonArtifactReader
  implements TrustedOptimizerArtifactReader
{
  readonly #bridge: TrustedArtifactBridge;

  constructor(bridge: TrustedArtifactBridge) {
    this.#bridge = bridge;
  }

  async readUtf8(
    artifact: TrustedCloudArtifactRef,
    maximumBytes: number,
  ): Promise<string> {
    if (
      artifact.mediaType !== "application/json" ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes <= 0 ||
      maximumBytes > MAXIMUM_JSON_BYTES ||
      artifact.byteLength <= 0 ||
      artifact.byteLength > maximumBytes
    ) {
      throw new TrustedJsonArtifactReaderError(
        "Trusted JSON artifact exceeds its sealed read contract.",
      );
    }
    const decoder = new TextDecoder("utf-8", {
      fatal: true,
      // Preserve U+FEFF so the canonical-text check below can reject it.
      ignoreBOM: true,
    });
    let result = "";
    let byteLength = 0;
    try {
      const source = await this.#bridge.openVerified(artifact);
      for await (const chunk of source) {
        if (!(chunk instanceof Uint8Array)) {
          throw new TrustedJsonArtifactReaderError(
            "Trusted JSON stream contains a non-byte chunk.",
          );
        }
        byteLength += chunk.byteLength;
        if (
          !Number.isSafeInteger(byteLength) ||
          byteLength > maximumBytes ||
          byteLength > artifact.byteLength
        ) {
          throw new TrustedJsonArtifactReaderError(
            "Trusted JSON stream exceeded its sealed byte limit.",
          );
        }
        result += decoder.decode(chunk, { stream: true });
      }
      result += decoder.decode();
    } catch (error) {
      if (error instanceof TrustedJsonArtifactReaderError) throw error;
      throw new TrustedJsonArtifactReaderError(
        "Trusted JSON artifact failed verified UTF-8 decoding.",
      );
    }
    if (
      byteLength !== artifact.byteLength ||
      result.length === 0 ||
      result.charCodeAt(0) === 0xfeff ||
      result.includes("\u0000")
    ) {
      throw new TrustedJsonArtifactReaderError(
        "Trusted JSON text is empty, truncated, BOM-prefixed, or contains NUL.",
      );
    }
    return result;
  }
}
