import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CloudMarkerTrustedArtifactRuntimeGuard,
  type TrustedArtifactBackend,
  TrustedArtifactBridgeError,
  type TrustedArtifactRuntimeGuard,
  type TrustedArtifactWriteSession,
  VerifyingTrustedArtifactBridge,
} from "../../src/cloud/artifact-bridge.js";
import type { TrustedCloudArtifactRef } from "../../src/cloud/types.js";

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const result: Uint8Array[] = [];
  for await (const chunk of chunks) result.push(chunk);
  return Buffer.concat(result);
}

class Guard implements TrustedArtifactRuntimeGuard {
  calls = 0;
  allowed = true;

  assertTrustedCloudRuntime(): void {
    this.calls += 1;
    if (!this.allowed) {
      throw new TrustedArtifactBridgeError("Trusted cloud runtime attestation is absent.");
    }
  }
}

class Backend implements TrustedArtifactBackend {
  readonly values = new Map<string, Uint8Array>();
  aborts = 0;
  tamperCommit = false;

  open(uri: `trusted://${string}`): Promise<AsyncIterable<Uint8Array>> {
    const value = this.values.get(uri);
    if (value === undefined) throw new Error("missing fixture");
    return Promise.resolve(
      (async function* () {
        const middle = Math.floor(value.byteLength / 2);
        yield value.subarray(0, middle);
        yield value.subarray(middle);
      })(),
    );
  }

  createWrite(input: {
    readonly uri: `trusted://${string}`;
    readonly mediaType: string;
  }): Promise<TrustedArtifactWriteSession> {
    const chunks: Uint8Array[] = [];
    let aborted = false;
    const session: TrustedArtifactWriteSession = {
      uri: input.uri,
      write: (chunk) => {
        chunks.push(Uint8Array.from(chunk));
        return Promise.resolve();
      },
      commit: (metadata) => {
        if (aborted) throw new Error("aborted");
        const value = Buffer.concat(chunks);
        this.values.set(input.uri, value);
        return Promise.resolve({
          uri: input.uri,
          sha256: this.tamperCommit ? "f".repeat(64) : metadata.sha256,
          mediaType: metadata.mediaType,
          byteLength: metadata.byteLength,
        });
      },
      abort: () => {
        aborted = true;
        this.aborts += 1;
        this.values.delete(input.uri);
        return Promise.resolve();
      },
    };
    return Promise.resolve(session);
  }
}

function reference(uri: `trusted://${string}`, value: Uint8Array): TrustedCloudArtifactRef {
  return {
    uri,
    sha256: digest(value),
    mediaType: "application/octet-stream",
    byteLength: value.byteLength,
  };
}

describe("verifying trusted artifact bridge", () => {
  it("requires both trusted-control-plane and real provider runtime markers", () => {
    const guard = new CloudMarkerTrustedArtifactRuntimeGuard({
      provider: "daytona",
      environment: () => ({
        DF_TRUSTED_CONTROL_PLANE: "1",
        DF_CLOUD_EXECUTION: "1",
        DAYTONA_SANDBOX_ID: "trusted-controller-1",
      }),
    });
    expect(() => guard.assertTrustedCloudRuntime()).not.toThrow();

    const localGuard = new CloudMarkerTrustedArtifactRuntimeGuard({
      provider: "daytona",
      environment: () => ({
        DF_TRUSTED_CONTROL_PLANE: "1",
        DF_CLOUD_EXECUTION: "1",
      }),
    });
    expect(() => localGuard.assertTrustedCloudRuntime()).toThrow(/runtime marker/u);
  });

  it("streams an artifact only when EOF, length, and digest agree", async () => {
    const guard = new Guard();
    const backend = new Backend();
    const value = Buffer.from("sealed artifact");
    const artifact = reference("trusted://fixtures/sealed", value);
    backend.values.set(artifact.uri, value);
    const bridge = new VerifyingTrustedArtifactBridge(backend, guard);

    const stream = await bridge.openVerified(artifact);

    await expect(collect(stream)).resolves.toEqual(value);
    expect(guard.calls).toBe(1);
  });

  it("rejects both content tampering and a consumer that stops before EOF", async () => {
    const guard = new Guard();
    const backend = new Backend();
    const expected = Buffer.from("expected bytes");
    const artifact = reference("trusted://fixtures/input", expected);
    backend.values.set(artifact.uri, Buffer.from("tampered bytes"));
    const bridge = new VerifyingTrustedArtifactBridge(backend, guard);

    await expect(bridge.openVerified(artifact).then(collect)).rejects.toThrow(/sealed metadata/u);

    backend.values.set(artifact.uri, expected);
    const stream = await bridge.openVerified(artifact);
    await expect(
      (async () => {
        for await (const _chunk of stream) break;
      })(),
    ).rejects.toThrow(/sealed metadata/u);
  });

  it("hashes streamed writes and rejects backend commit substitution", async () => {
    const guard = new Guard();
    const backend = new Backend();
    backend.tamperCommit = true;
    const bridge = new VerifyingTrustedArtifactBridge(backend, guard);

    await expect(
      bridge.persistVerified({
        uri: "trusted://fixtures/output",
        mediaType: "text/plain",
        chunks: (async function* () {
          yield Buffer.from("first");
          yield Buffer.from("second");
        })(),
      }),
    ).rejects.toThrow(/commit metadata/u);
    expect(backend.aborts).toBe(1);
    expect(backend.values.has("trusted://fixtures/output")).toBe(false);
  });

  it("fails closed before storage access outside a trusted cloud runtime", async () => {
    const guard = new Guard();
    guard.allowed = false;
    const backend = new Backend();
    const bridge = new VerifyingTrustedArtifactBridge(backend, guard);

    await expect(
      bridge.persistVerified({
        uri: "trusted://fixtures/forbidden",
        mediaType: "application/octet-stream",
        chunks: (async function* () {
          yield Buffer.from("must not be stored locally");
        })(),
      }),
    ).rejects.toThrow(/runtime attestation/u);
    expect(backend.values.size).toBe(0);
  });
});
