import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type TrustedArtifactRuntimeGuard,
  VerifyingTrustedArtifactBridge,
} from "../../src/cloud/artifact-bridge.js";
import { MountedVolumeTrustedArtifactBackend } from "../../src/cloud/mounted-volume-backend.js";

const guard: TrustedArtifactRuntimeGuard = {
  assertTrustedCloudRuntime() {},
};

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value, "utf8");
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<string> {
  const output: Buffer[] = [];
  for await (const chunk of source) output.push(Buffer.from(chunk));
  return Buffer.concat(output).toString("utf8");
}

describe("mounted-volume trusted artifact backend", () => {
  it("persists immutable bytes and verifies them on every read", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-volume-test-"));
    const bridge = new VerifyingTrustedArtifactBridge(
      new MountedVolumeTrustedArtifactBackend({
        volumeRoot: root,
        runtimeGuard: guard,
      }),
      guard,
    );
    const artifact = await bridge.persistVerified({
      uri: "trusted://campaign/001/result",
      mediaType: "application/json",
      chunks: chunks('{"ok":', "true}"),
    });
    expect(await collect(await bridge.openVerified(artifact))).toBe(
      '{"ok":true}',
    );

    const digest = createHash("sha256")
      .update(artifact.uri)
      .digest("hex");
    const metadata = JSON.parse(
      await readFile(
        join(root, "objects", digest.slice(0, 2), digest, "metadata.json"),
        "utf8",
      ),
    ) as Readonly<Record<string, unknown>>;
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      uri: artifact.uri,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
      mediaType: "application/json",
    });
  });

  it("is idempotent only for identical content at one trusted URI", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-volume-test-"));
    const bridge = new VerifyingTrustedArtifactBridge(
      new MountedVolumeTrustedArtifactBackend({
        volumeRoot: root,
        runtimeGuard: guard,
      }),
      guard,
    );
    const first = await bridge.persistVerified({
      uri: "trusted://campaign/001/immutable",
      mediaType: "text/plain",
      chunks: chunks("same"),
    });
    await expect(
      bridge.persistVerified({
        uri: "trusted://campaign/001/immutable",
        mediaType: "text/plain",
        chunks: chunks("same"),
      }),
    ).resolves.toEqual(first);
    await expect(
      bridge.persistVerified({
        uri: "trusted://campaign/001/immutable",
        mediaType: "text/plain",
        chunks: chunks("different"),
      }),
    ).rejects.toThrow(/different bytes/u);
  });

  it("rejects a symlinked volume root before materializing artifacts", async () => {
    const parent = await mkdtemp(join(tmpdir(), "df-volume-test-"));
    const real = join(parent, "real");
    const linked = join(parent, "linked");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, linked);
    const bridge = new VerifyingTrustedArtifactBridge(
      new MountedVolumeTrustedArtifactBackend({
        volumeRoot: linked,
        runtimeGuard: guard,
      }),
      guard,
    );
    await expect(
      bridge.persistVerified({
        uri: "trusted://campaign/001/rejected",
        mediaType: "text/plain",
        chunks: chunks("no"),
      }),
    ).rejects.toThrow(/real directory/u);
  });

  it("rejects a symlink inserted at a content-address shard boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-volume-test-"));
    const bridge = new VerifyingTrustedArtifactBridge(
      new MountedVolumeTrustedArtifactBackend({
        volumeRoot: root,
        runtimeGuard: guard,
      }),
      guard,
    );
    const initialized = await bridge.persistVerified({
      uri: "trusted://campaign/001/initialize",
      mediaType: "text/plain",
      chunks: chunks("safe"),
    });
    const initializedPrefix = createHash("sha256")
      .update(initialized.uri)
      .digest("hex")
      .slice(0, 2);
    let maliciousUri: `trusted://${string}` =
      "trusted://campaign/001/shard-0";
    for (let index = 1; index < 1_000; index += 1) {
      const candidate = `trusted://campaign/001/shard-${index}` as const;
      const prefix = createHash("sha256")
        .update(candidate)
        .digest("hex")
        .slice(0, 2);
      if (prefix !== initializedPrefix) {
        maliciousUri = candidate;
        break;
      }
    }
    const maliciousPrefix = createHash("sha256")
      .update(maliciousUri)
      .digest("hex")
      .slice(0, 2);
    const outside = join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(root, "objects", maliciousPrefix));

    await expect(
      bridge.persistVerified({
        uri: maliciousUri,
        mediaType: "text/plain",
        chunks: chunks("must-not-escape"),
      }),
    ).rejects.toThrow(/shard is unsafe/u);
  });
});
