#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { type CandidateProposal, canonicalJson, type OptimizerInput } from "./contracts.js";
import {
  assertMvpCandidateProposal,
  assertTaskFreeMvpOptimizerInput,
  createMvpOptimizerWorkerInvocation,
} from "./optimizer-worker.js";

const STATE_ROOT = "/workspace/df-state";
const MAXIMUM_STDOUT_BYTES = 2 * 1024 * 1024;
const MAXIMUM_STDERR_BYTES = 256 * 1024;
const OPTIMIZER_TIMEOUT_MS = 125 * 60_000;

async function main(): Promise<void> {
  assertCloudRole();
  if (process.argv[2] !== "optimize") {
    throw new Error("Unsupported optimizer worker operation.");
  }
  const optimizerInput = decodeOptimizerInput(requiredEnvironment("DF_MVP_OPTIMIZER_INPUT_BASE64"));
  const invocation = createMvpOptimizerWorkerInvocation({
    campaignId: requiredEnvironment("DF_MVP_CAMPAIGN_ID"),
    maximumIterations: 1,
    stateRoot: STATE_ROOT,
    configurationHash: requiredDigest("DF_MVP_CONFIGURATION_HASH"),
  });
  await writeJsonAtomically(invocation.inputPath, optimizerInput);

  const result = await runBounded(invocation.executable, invocation.arguments, childEnvironment());
  const proposal = parseProposal(result.stdout);
  const persistedProposal = parseProposal(await readFile(invocation.outputPath, "utf8"));
  if (canonicalJson(proposal) !== canonicalJson(persistedProposal)) {
    throw new Error("The optimizer stdout and persisted proposal disagree.");
  }
  process.stdout.write(`${JSON.stringify(proposal)}\n`);
}

function assertCloudRole(): void {
  if (
    process.platform !== "linux" ||
    process.env["CI"] !== "true" ||
    process.env["DF_CLOUD_EXECUTION"] !== "1" ||
    process.env["DF_MVP_ROLE"] !== "optimizer" ||
    !hasDaytonaIdentity()
  ) {
    throw new Error("The optimizer worker is restricted to its Daytona role.");
  }
}

function hasDaytonaIdentity(): boolean {
  return [process.env["DAYTONA_SANDBOX_ID"], process.env["DAYTONA_WORKSPACE_ID"]].some(
    (value) => value !== undefined && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value),
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing optimizer worker setting ${name}.`);
  }
  return value;
}

function requiredDigest(name: string): string {
  const value = requiredEnvironment(name);
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Optimizer worker setting ${name} is invalid.`);
  }
  return value;
}

function decodeOptimizerInput(value: string): OptimizerInput {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("The optimizer input channel is malformed.");
  }
  assertTaskFreeMvpOptimizerInput(decoded);
  return decoded;
}

function parseProposal(value: string): CandidateProposal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("The optimizer returned malformed JSON.");
  }
  assertMvpCandidateProposal(parsed);
  return parsed;
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment["DF_MVP_OPTIMIZER_INPUT_BASE64"];
  return environment;
}

async function runBounded(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      cwd: "/workspace",
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("The optimizer subprocess failed closed."));
    };
    const timer = setTimeout(fail, OPTIMIZER_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAXIMUM_STDOUT_BYTES) {
        fail();
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAXIMUM_STDERR_BYTES) fail();
    });
    child.once("error", fail);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (signal !== null || status !== 0) {
        reject(new Error("The optimizer subprocess failed closed."));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
      });
    });
  });
}

await main().catch(() => {
  process.stderr.write("Dark Factory optimizer worker failed closed.\n");
  process.exitCode = 1;
});
