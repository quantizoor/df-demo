import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalProcessAbortedError, runLocalProcess } from "../../src/local/real/process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local process", () => {
  it("streams output and redacts a secret split across chunks", async () => {
    const directory = await temporaryDirectory();
    const stdoutPath = join(directory, "stdout.log");
    const stderrPath = join(directory, "stderr.log");
    const processPromise = runLocalProcess({
      executable: process.execPath,
      arguments: [
        "-e",
        "process.stdout.write('prefix-SE'); setTimeout(() => { process.stdout.write('CRET-suffix'); }, 100); setTimeout(() => process.exit(0), 250);",
      ],
      workingDirectory: directory,
      timeoutMs: 5_000,
      stdoutPath,
      stderrPath,
      sensitiveValues: ["SECRET"],
    });

    await delay(180);
    expect(await readFile(stdoutPath, "utf8")).toContain("prefix-");
    const result = await processPromise;
    expect(result.stdout).toBe("prefix-[REDACTED]-suffix");
    expect(await readFile(stdoutPath, "utf8")).toBe("prefix-[REDACTED]-suffix");
  });

  it("terminates an active process through an AbortSignal and retains partial logs", async () => {
    const directory = await temporaryDirectory();
    const stdoutPath = join(directory, "stdout.log");
    const controller = new AbortController();
    const processPromise = runLocalProcess({
      executable: process.execPath,
      arguments: ["-e", "process.stdout.write('started'); setInterval(() => {}, 1000);"],
      workingDirectory: directory,
      timeoutMs: 60_000,
      stdoutPath,
      stderrPath: join(directory, "stderr.log"),
      signal: controller.signal,
    });

    await delay(150);
    controller.abort();
    await expect(processPromise).rejects.toBeInstanceOf(LocalProcessAbortedError);
    expect(await readFile(stdoutPath, "utf8")).toBe("started");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "df-real-process-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
