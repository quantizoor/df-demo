import { describe, expect, it } from "vitest";

import type {
  TrustedArtifactBridge,
} from "../../src/cloud/artifact-bridge.js";
import {
  BridgeBackedTrustedOptimizerReleaseArtifactReader,
  TrustedOptimizerReleaseArtifactReaderError,
} from "../../src/cloud/optimizer-release-artifact-reader.js";
import type { TrustedCloudArtifactRef } from "../../src/cloud/types.js";
import { sha256 } from "../../src/schemas/canonical.js";

function artifact(bytes: Uint8Array): TrustedCloudArtifactRef {
  return {
    uri: "trusted://optimizer-reader/release",
    sha256: sha256(bytes),
    mediaType: "application/x-tar",
    byteLength: bytes.byteLength,
  };
}

function bridge(
  chunks: readonly Uint8Array[],
): TrustedArtifactBridge {
  return {
    assertTrustedRuntime() {},
    async openVerified() {
      return {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk;
        },
      };
    },
    async persistVerified(): Promise<TrustedCloudArtifactRef> {
      throw new Error("not used");
    },
  };
}

describe("optimizer release artifact byte reader", () => {
  it("materializes every verified chunk under the exact bound", async () => {
    const first = Uint8Array.from([1, 2]);
    const second = Uint8Array.from([3, 4, 5]);
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    const reader =
      new BridgeBackedTrustedOptimizerReleaseArtifactReader(
        bridge([first, second]),
      );

    await expect(
      reader.readBytes(artifact(bytes), bytes.byteLength),
    ).resolves.toEqual(bytes);
  });

  it("rejects truncation, overflow, and non-byte chunks", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const truncated =
      new BridgeBackedTrustedOptimizerReleaseArtifactReader(
        bridge([bytes.subarray(0, 2)]),
      );
    await expect(
      truncated.readBytes(artifact(bytes), bytes.byteLength),
    ).rejects.toBeInstanceOf(
      TrustedOptimizerReleaseArtifactReaderError,
    );

    const overflowing =
      new BridgeBackedTrustedOptimizerReleaseArtifactReader(
        bridge([bytes, Uint8Array.from([4])]),
      );
    await expect(
      overflowing.readBytes(artifact(bytes), bytes.byteLength),
    ).rejects.toBeInstanceOf(
      TrustedOptimizerReleaseArtifactReaderError,
    );

    const emptyChunk =
      new BridgeBackedTrustedOptimizerReleaseArtifactReader(
        bridge([new Uint8Array(), bytes]),
      );
    await expect(
      emptyChunk.readBytes(artifact(bytes), bytes.byteLength),
    ).rejects.toBeInstanceOf(
      TrustedOptimizerReleaseArtifactReaderError,
    );

    const malformedBridge = bridge([]) as TrustedArtifactBridge & {
      openVerified(): Promise<AsyncIterable<Uint8Array>>;
    };
    malformedBridge.openVerified = async () =>
      ({
        async *[Symbol.asyncIterator]() {
          yield "not-bytes" as unknown as Uint8Array;
        },
      }) as AsyncIterable<Uint8Array>;
    const malformed =
      new BridgeBackedTrustedOptimizerReleaseArtifactReader(
        malformedBridge,
      );
    await expect(
      malformed.readBytes(artifact(bytes), bytes.byteLength),
    ).rejects.toBeInstanceOf(
      TrustedOptimizerReleaseArtifactReaderError,
    );
  });
});
