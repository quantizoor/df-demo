import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const commit = "1".repeat(40);

function octal(value: number, length: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(length - 1, "0")}\0`, "ascii");
}

function tarEntry(path: string, body: Buffer, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  octal(0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(body.byteLength, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(
    header,
    148,
  );
  const padding = Buffer.alloc(
    Math.ceil(body.byteLength / 512) * 512 - body.byteLength,
  );
  return Buffer.concat([header, body, padding]);
}

function archive(entries: readonly Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1_024)]);
}

function runExtractor(tar: Buffer, includeCloudMarker = true) {
  const root = mkdtempSync(join(tmpdir(), "df-extractor-test-"));
  roots.push(root);
  const archivePath = join(root, "source.tar");
  const destination = join(root, "source");
  writeFileSync(archivePath, tar);
  const result = spawnSync(
    process.execPath,
    [
      join(process.cwd(), "scripts", "extract-pi-source.mjs"),
      "--archive",
      archivePath,
      "--destination",
      destination,
      "--sha256",
      createHash("sha256").update(tar).digest("hex"),
      "--commit",
      commit,
    ],
    {
      encoding: "utf8",
      env: includeCloudMarker
        ? {
            ...process.env,
            DF_CLOUD_EXECUTION: "1",
            DAYTONA_SANDBOX_ID: "synthetic-cloud-test",
          }
        : {
            ...process.env,
            DF_CLOUD_EXECUTION: "0",
            DAYTONA_SANDBOX_ID: "",
          },
    },
  );
  return { result, root, destination };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("cloud-only Pi source extractor", () => {
  it("extracts a digest-bound regular-file-only USTAR archive", () => {
    const packageJson = Buffer.from('{"name":"pi-monorepo"}\n', "utf8");
    const { result, destination } = runExtractor(
      archive([tarEntry("package.json", packageJson)]),
    );
    expect(result.status).toBe(0);
    expect(readFileSync(join(destination, "package.json"), "utf8")).toBe(
      packageJson.toString("utf8"),
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      commit,
      entryCount: 1,
    });
  });

  it.each([
    ["path traversal", tarEntry("../escape", Buffer.from("no"))],
    ["absolute path", tarEntry("/private/escape", Buffer.from("no"))],
    ["symbolic link", tarEntry("link", Buffer.alloc(0), "2")],
  ])("rejects %s without writing outside the destination", (_label, entry) => {
    const { result, root } = runExtractor(archive([entry]));
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(join(root, "escape"))).toThrow();
  });

  it("refuses to execute without an attested cloud marker", () => {
    const { result } = runExtractor(
      archive([tarEntry("package.json", Buffer.from("{}"))]),
      false,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cloud-only/u);
  });
});
