import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  parseHarbor020Json,
  parseHarbor020OutputBundle,
} from "../../src/evaluator/harbor-v020-bundle.js";
import { canonicalHash, canonicalJson } from "../../src/schemas/canonical.js";
import type {
  TrustedHarborInvocation,
  TrustedHarborJobArtifact,
} from "../../src/terminal-bench/harbor.js";

const BLOCK = 512;
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

function writeOctal(header: Uint8Array, offset: number, length: number, value: number) {
  const text = value.toString(8).padStart(length - 1, "0");
  header.set(encode(text), offset);
  header[offset + length - 1] = 0;
}

function header(path: string, size: number, type: "0" | "x") {
  const value = new Uint8Array(BLOCK);
  value.set(encode(path), 0);
  writeOctal(value, 100, 8, type === "0" ? 0o600 : 0o644);
  writeOctal(value, 108, 8, 0);
  writeOctal(value, 116, 8, 0);
  writeOctal(value, 124, 12, size);
  writeOctal(value, 136, 12, 0);
  value.fill(0x20, 148, 156);
  value[156] = type.charCodeAt(0);
  value.set(encode("ustar"), 257);
  value[262] = 0;
  value.set(encode("00"), 263);
  value.set(encode("root"), 265);
  value.set(encode("root"), 297);
  writeOctal(value, 329, 8, 0);
  writeOctal(value, 337, 8, 0);
  let checksum = 0;
  for (const byte of value) checksum += byte;
  value.set(encode(checksum.toString(8).padStart(6, "0")), 148);
  value[154] = 0;
  value[155] = 0x20;
  return value;
}

function pax(path: string): Uint8Array {
  const payload = `path=${path}\n`;
  let length = Buffer.byteLength(payload) + 3;
  for (;;) {
    const value = encode(`${length} ${payload}`);
    if (value.byteLength === length) return value;
    length = value.byteLength;
  }
}

function entry(path: string, body: Uint8Array, type: "0" | "x" = "0") {
  const padding = new Uint8Array((BLOCK - (body.byteLength % BLOCK)) % BLOCK);
  return [header(path, body.byteLength, type), body, padding];
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

const invocation: TrustedHarborInvocation = {
  invocationId: "request-1-repair",
  order: "repair",
  configSha256: "1".repeat(64),
  remoteConfigPath: "/trusted/config.json",
  remoteHarborJobPath: "/trusted/request-1-repair",
  remoteOutputPath: "/trusted/request-1-repair.harbor-output.tar",
  cellCount: 1,
  armCount: 1,
  agentOrder: ["candidate"],
  nAttempts: 1,
  nConcurrentTrials: 1,
  harborRetries: 0,
};

const job: TrustedHarborJobArtifact = {
  sensitivity: "hidden-harbor-job",
  requestId: "request-1",
  stage: "repair",
  pinHash: "2".repeat(64),
  isolationPolicyHash: "3".repeat(64),
  jobSha256: "4".repeat(64),
  cellCount: 1,
  armCount: 1,
  uploads: [],
  invocations: [invocation],
};

function fixture(
  paths: Readonly<Record<string, string>> = {
    "config.json": "{}",
    "result.json": "{}",
    "trial-1/agent/trajectory.json": "{}",
    "trial-1/result.json": "{}",
  },
  manifestText?: (canonical: string) => string,
) {
  const files = Object.entries(paths)
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([path, text]) => {
      const bytes = encode(text);
      return {
        path,
        bytes,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      };
    });
  const manifest = {
    schemaVersion: 1,
    domain: "dark-factory.harbor-output-bundle.v1",
    requestId: job.requestId,
    jobSha256: job.jobSha256,
    pinHash: job.pinHash,
    invocationId: invocation.invocationId,
    order: invocation.order,
    configSha256: invocation.configSha256,
    executionId: "execution-1",
    expectedTrialCount: 1,
    fileCount: files.length,
    totalByteLength: files.reduce((sum, file) => sum + file.byteLength, 0),
    payloadSha256: canonicalHash({
      domain: "dark-factory.harbor-output-payload.v1",
      files: files.map(({ path, byteLength, sha256 }) => ({
        path,
        byteLength,
        sha256,
      })),
    }),
    files: files.map(({ path, byteLength, sha256 }) => ({
      path,
      byteLength,
      sha256,
    })),
  };
  const canonicalManifest = canonicalJson(manifest);
  const manifestBytes = encode(`${manifestText?.(canonicalManifest) ?? canonicalManifest}\n`);
  const chunks = [...entry("manifest.json", manifestBytes)];
  for (const [index, file] of files.entries()) {
    const ordinal = String(index).padStart(6, "0");
    chunks.push(
      ...entry(`.pax/${ordinal}`, pax(`payload/${file.path}`), "x"),
      ...entry(`.files/${ordinal}`, file.bytes),
    );
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  const bytes = concat(chunks);
  return {
    bytes,
    artifact: {
      uri: "trusted://tests/request-1-output",
      sha256: sha256(bytes),
      mediaType: "application/x-tar",
      byteLength: bytes.byteLength,
    } as const,
  };
}

function parse(value = fixture()) {
  return parseHarbor020OutputBundle({
    ...value,
    job,
    invocation,
    executionId: "execution-1",
    maximumArchiveBytes: 16 * 1024 * 1024,
  });
}

describe("parseHarbor020OutputBundle", () => {
  it("accepts the exact deterministic PAX/tar projection", () => {
    const result = parse();
    expect(result.manifest.fileCount).toBe(4);
    expect(result.trials).toHaveLength(1);
    expect(result.trials[0]?.directory).toBe("trial-1");
  });

  it("rejects a payload byte even when archive metadata is rehashed", () => {
    const value = fixture();
    const tampered = Uint8Array.from(value.bytes);
    const tamperedIndex = tampered.byteLength - BLOCK * 3;
    tampered[tamperedIndex] = (tampered[tamperedIndex] ?? 0) ^ 1;
    expect(() =>
      parse({
        bytes: tampered,
        artifact: {
          ...value.artifact,
          sha256: sha256(tampered),
        },
      }),
    ).toThrow();
  });

  it("rejects any trailing tar member or zero block", () => {
    const value = fixture();
    const extended = concat([value.bytes, new Uint8Array(BLOCK)]);
    expect(() =>
      parse({
        bytes: extended,
        artifact: {
          ...value.artifact,
          sha256: sha256(extended),
          byteLength: extended.byteLength,
        },
      }),
    ).toThrow();
  });

  it("rejects unexpected nested result paths", () => {
    expect(() =>
      parse(
        fixture({
          "config.json": "{}",
          "result.json": "{}",
          "trial-1/agent/trajectory.json": "{}",
          "trial-1/result.json": "{}",
          "trial-1/nested/result.json": "{}",
        }),
      ),
    ).toThrow();
  });

  it("rejects duplicate JSON keys before normalization", () => {
    expect(() => parseHarbor020Json(encode('{"task":"one","task":"two"}'))).toThrow();
  });

  it("rejects a duplicate-key manifest even with a matching tar header", () => {
    expect(() =>
      parse(
        fixture(undefined, (canonical) =>
          canonical.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
        ),
      ),
    ).toThrow();
  });
});
