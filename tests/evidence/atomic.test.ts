import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { atomicWriteFile } from "../../src/evidence/atomic.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "df-atomic-test-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("atomicWriteFile", () => {
  it("installs complete contents and leaves no temporary file", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "artifact.json");

    await atomicWriteFile(target, '{"complete":true}\n');

    expect(await readFile(target, "utf8")).toBe('{"complete":true}\n');
    expect(await readdir(directory)).toEqual(["artifact.json"]);
  });

  it("does not clobber an existing file unless overwrite is explicit", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "artifact.json");
    await atomicWriteFile(target, "first");

    await expect(atomicWriteFile(target, "second")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(target, "utf8")).toBe("first");

    await atomicWriteFile(target, "second", { overwrite: true });
    expect(await readFile(target, "utf8")).toBe("second");
  });
});
