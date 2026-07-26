import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { TrustedArtifactBridge } from "../../src/cloud/artifact-bridge.js";
import {
  TrustedJsonArtifactReaderError,
  VerifyingTrustedJsonArtifactReader,
} from "../../src/cloud/trusted-json-reader.js";
import type { TrustedCloudArtifactRef } from "../../src/cloud/types.js";

function artifact(
  value: Uint8Array,
  mediaType = "application/json",
): TrustedCloudArtifactRef {
  return {
    uri: "trusted://tests/document",
    sha256: createHash("sha256").update(value).digest("hex"),
    mediaType,
    byteLength: value.byteLength,
  };
}

class Bridge implements TrustedArtifactBridge {
  readonly chunks: readonly Uint8Array[];
  opened = false;

  constructor(chunks: readonly Uint8Array[]) {
    this.chunks = chunks;
  }

  assertTrustedRuntime(): void {}

  openVerified(): Promise<AsyncIterable<Uint8Array>> {
    this.opened = true;
    const chunks = this.chunks;
    return Promise.resolve(
      (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
    );
  }

  persistVerified(): Promise<TrustedCloudArtifactRef> {
    throw new Error("not used");
  }
}

describe("verifying trusted JSON reader", () => {
  it("decodes split UTF-8 only through the trusted bridge", async () => {
    const value = Buffer.from('{"message":"caffè"}\n', "utf8");
    const multibyteStart = value.indexOf(0xc3);
    const bridge = new Bridge([
      value.subarray(0, multibyteStart + 1),
      value.subarray(multibyteStart + 1),
    ]);
    const reader = new VerifyingTrustedJsonArtifactReader(bridge);

    await expect(
      reader.readUtf8(artifact(value), value.byteLength),
    ).resolves.toBe(value.toString("utf8"));
    expect(bridge.opened).toBe(true);
  });

  it("rejects type and size mismatches before opening storage", async () => {
    const value = Buffer.from("{}\n", "utf8");
    const bridge = new Bridge([value]);
    const reader = new VerifyingTrustedJsonArtifactReader(bridge);

    await expect(
      reader.readUtf8(artifact(value, "application/x-tar"), 1024),
    ).rejects.toBeInstanceOf(TrustedJsonArtifactReaderError);
    await expect(
      reader.readUtf8(artifact(value), value.byteLength - 1),
    ).rejects.toBeInstanceOf(TrustedJsonArtifactReaderError);
    expect(bridge.opened).toBe(false);
  });

  it("rejects invalid UTF-8, BOM, NUL, and truncated streams", async () => {
    const invalid = Uint8Array.from([0xc3, 0x28]);
    await expect(
      new VerifyingTrustedJsonArtifactReader(new Bridge([invalid])).readUtf8(
        artifact(invalid),
        1024,
      ),
    ).rejects.toBeInstanceOf(TrustedJsonArtifactReaderError);

    const bom = Buffer.from("\ufeff{}\n", "utf8");
    await expect(
      new VerifyingTrustedJsonArtifactReader(new Bridge([bom])).readUtf8(
        artifact(bom),
        1024,
      ),
    ).rejects.toBeInstanceOf(TrustedJsonArtifactReaderError);

    const nul = Buffer.from('{"x":"\u0000"}\n', "utf8");
    await expect(
      new VerifyingTrustedJsonArtifactReader(new Bridge([nul])).readUtf8(
        artifact(nul),
        1024,
      ),
    ).rejects.toBeInstanceOf(TrustedJsonArtifactReaderError);

    const full = Buffer.from("{}\n", "utf8");
    await expect(
      new VerifyingTrustedJsonArtifactReader(
        new Bridge([full.subarray(0, 1)]),
      ).readUtf8(artifact(full), 1024),
    ).rejects.toBeInstanceOf(TrustedJsonArtifactReaderError);
  });
});
