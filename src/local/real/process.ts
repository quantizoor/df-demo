import { type ChildProcess, spawn } from "node:child_process";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface LocalProcessInput {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly inheritEnvironment?: boolean;
  readonly timeoutMs: number;
  readonly maximumOutputBytes?: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly signal?: AbortSignal;
  /**
   * Exact values that must never be persisted in process logs. Values are
   * redacted before a chunk reaches disk, including when split across chunks.
   */
  readonly sensitiveValues?: readonly string[];
}

export interface LocalProcessResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export class LocalProcessAbortedError extends Error {
  public constructor() {
    super("Local process was cancelled by the operator");
    this.name = "LocalProcessAbortedError";
  }
}

interface OutputSink {
  readonly decoder: StringDecoder;
  readonly redactor: StreamingRedactor;
  readonly chunks: string[];
  writes: Promise<void>;
}

class StreamingRedactor {
  readonly #values: readonly string[];
  readonly #carryLength: number;
  #carry = "";

  public constructor(values: readonly string[]) {
    this.#values = [...new Set(values.filter((value) => value.length > 0))].sort(
      (left, right) => right.length - left.length,
    );
    this.#carryLength = Math.max(0, ...this.#values.map((value) => value.length - 1));
  }

  public write(value: string): string {
    const combined = this.#carry + value;
    if (this.#carryLength === 0) return this.redact(combined);
    let emitLength = Math.max(0, combined.length - this.#carryLength);
    for (const secret of this.#values) {
      let searchFrom = 0;
      while (searchFrom < emitLength) {
        const found = combined.indexOf(secret, searchFrom);
        if (found < 0 || found >= emitLength) break;
        if (found + secret.length > emitLength) {
          emitLength = found;
          break;
        }
        searchFrom = found + secret.length;
      }
    }
    const emitted = combined.slice(0, emitLength);
    this.#carry = combined.slice(emitLength);
    return this.redact(emitted);
  }

  public end(value = ""): string {
    const finalValue = this.#carry + value;
    this.#carry = "";
    return this.redact(finalValue);
  }

  private redact(value: string): string {
    let sanitized = value;
    for (const secret of this.#values) {
      sanitized = sanitized.split(secret).join("[REDACTED]");
    }
    return sanitized;
  }
}

export async function runLocalProcess(input: LocalProcessInput): Promise<LocalProcessResult> {
  if (
    input.executable.length === 0 ||
    input.arguments.some((argument) => argument.includes("\0")) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.signal?.aborted === true
  ) {
    if (input.signal?.aborted === true) throw new LocalProcessAbortedError();
    throw new Error("Local process specification is invalid");
  }
  const maximumOutputBytes = input.maximumOutputBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 1) {
    throw new Error("Local process output limit is invalid");
  }
  await Promise.all([
    mkdir(dirname(input.stdoutPath), { recursive: true, mode: 0o700 }),
    mkdir(dirname(input.stderrPath), { recursive: true, mode: 0o700 }),
  ]);
  const [stdoutHandle, stderrHandle] = await Promise.all([
    open(input.stdoutPath, "w", 0o600),
    open(input.stderrPath, "w", 0o600),
  ]);

  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const sensitiveValues = input.sensitiveValues ?? [];
    const stdout = outputSink(sensitiveValues);
    const stderr = outputSink(sensitiveValues);
    let outputBytes = 0;
    let timedOut = false;
    let oversized = false;
    let aborted = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | null = null;
    const child = spawn(input.executable, [...input.arguments], {
      cwd: input.workingDirectory,
      env:
        input.inheritEnvironment === false
          ? { ...(input.environment ?? {}) }
          : { ...process.env, ...(input.environment ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const timer = setTimeout(() => {
      timedOut = true;
      forceTimer ??= terminateProcess(child);
    }, input.timeoutMs);
    timer.unref();

    const abort = (): void => {
      aborted = true;
      forceTimer ??= terminateProcess(child);
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted === true) abort();

    const capture = (sink: OutputSink, handle: FileHandle, chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumOutputBytes) {
        oversized = true;
        forceTimer ??= terminateProcess(child);
        return;
      }
      persistOutput(sink, handle, sink.redactor.write(sink.decoder.write(chunk)));
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, stdoutHandle, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, stderrHandle, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer !== null) clearTimeout(forceTimer);
      input.signal?.removeEventListener("abort", abort);
      void closeOutputs(stdoutHandle, stderrHandle, stdout, stderr).then(
        () => reject(error),
        reject,
      );
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer !== null) clearTimeout(forceTimer);
      input.signal?.removeEventListener("abort", abort);
      persistOutput(stdout, stdoutHandle, stdout.redactor.end(stdout.decoder.end()));
      persistOutput(stderr, stderrHandle, stderr.redactor.end(stderr.decoder.end()));
      void closeOutputs(stdoutHandle, stderrHandle, stdout, stderr)
        .then(() => {
          if (aborted) {
            reject(new LocalProcessAbortedError());
            return;
          }
          if (timedOut) {
            reject(new Error("Local process exceeded its timeout"));
            return;
          }
          if (oversized) {
            reject(new Error("Local process exceeded its output limit"));
            return;
          }
          resolve({
            exitCode: exitCode ?? 128,
            signal,
            stdout: stdout.chunks.join(""),
            stderr: stderr.chunks.join(""),
            durationMs: Date.now() - startedAt,
          });
        })
        .catch(reject);
    });
  });
}

export async function runLocalProcessChecked(
  input: LocalProcessInput,
): Promise<LocalProcessResult> {
  const result = await runLocalProcess(input);
  if (result.exitCode !== 0) {
    throw new Error(`Local process failed with exit code ${result.exitCode}`);
  }
  return result;
}

function outputSink(sensitiveValues: readonly string[]): OutputSink {
  return {
    decoder: new StringDecoder("utf8"),
    redactor: new StreamingRedactor(sensitiveValues),
    chunks: [],
    writes: Promise.resolve(),
  };
}

function persistOutput(sink: OutputSink, handle: FileHandle, value: string): void {
  if (value.length === 0) return;
  sink.chunks.push(value);
  sink.writes = sink.writes.then(async () => {
    await handle.writeFile(value, "utf8");
  });
}

async function closeOutputs(
  stdoutHandle: FileHandle,
  stderrHandle: FileHandle,
  stdout: OutputSink,
  stderr: OutputSink,
): Promise<void> {
  await Promise.all([stdout.writes, stderr.writes]);
  await Promise.all([stdoutHandle.sync(), stderrHandle.sync()]);
  await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
}

function terminateProcess(child: ChildProcess): NodeJS.Timeout {
  const pid = child.pid;
  if (process.platform !== "win32" && pid !== undefined) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  const force = setTimeout(() => {
    if (process.platform !== "win32" && pid !== undefined) {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        // Fall through to the direct child.
      }
    }
    child.kill("SIGKILL");
  }, 5_000);
  force.unref();
  return force;
}
