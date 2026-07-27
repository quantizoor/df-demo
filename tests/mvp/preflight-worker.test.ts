import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe("MVP preflight worker diagnostic boundary", () => {
  it("emits one safe stdout marker and no stderr when the cloud boundary is absent", async () => {
    const failure = await execute(
      process.execPath,
      ["--import", "tsx", resolve("src/mvp/preflight-worker.ts"), "bootstrap"],
      {
        cwd: resolve("."),
        env: {
          PATH: process.env["PATH"] ?? "",
        },
      },
    ).catch((error: { readonly stdout: string; readonly stderr: string }) => error);

    expect(failure.stdout).toBe("MVP_PREFLIGHT_FAILURE:worker-boundary\n");
    expect(failure.stderr).toBe("");
  });

  it("classifies CLI setup failures without exposing configuration details", async () => {
    const failure = await execute(
      process.execPath,
      ["--import", "tsx", resolve("src/mvp/preflight-cli.ts"), "bootstrap"],
      {
        cwd: resolve("."),
        env: {
          PATH: process.env["PATH"] ?? "",
        },
      },
    ).catch((error: { readonly stdout: string; readonly stderr: string }) => error);

    expect(failure.stdout).toBe("");
    expect(failure.stderr).toBe("MVP_PREFLIGHT_FAILED_CLOSED:outer-configuration\n");
  });
});
