import { spawn } from "node:child_process";
import { assertCloudExecutionEnvironment } from "../cloud/runtime-marker.js";
import type { CloudProviderName } from "../cloud/types.js";

export interface ProcessInvocation {
  readonly executable: "git";
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly stdin: "closed";
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunner {
  run(invocation: ProcessInvocation): Promise<ProcessResult>;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: Process arguments reject NUL and line breaks to prevent command-boundary injection.
const FORBIDDEN_ARGUMENT_CHARACTER = /[\u0000\r\n]/u;
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  "config",
  "diff",
  "fetch",
  "hash-object",
  "ls-files",
  "ls-remote",
  "merge-base",
  "remote",
  "rev-parse",
  "show",
  "status",
  "symbolic-ref",
  "tag",
  "worktree",
]);

export class SafeProcessError extends Error {
  override readonly name = "SafeProcessError";
}

export function assertSafeGitArguments(arguments_: readonly string[]): void {
  if (arguments_.length === 0) {
    throw new SafeProcessError("A Git subcommand is required.");
  }
  for (const argument of arguments_) {
    if (FORBIDDEN_ARGUMENT_CHARACTER.test(argument)) {
      throw new SafeProcessError("Git arguments cannot contain control-line characters.");
    }
  }
  if (!ALLOWED_GIT_SUBCOMMANDS.has(arguments_[0] ?? "")) {
    throw new SafeProcessError("Git subcommand is outside the controller allowlist.");
  }
}

export function gitInvocation(
  workingDirectory: string,
  arguments_: readonly string[],
  timeoutMs = 30_000,
): ProcessInvocation {
  assertSafeGitArguments(arguments_);
  if (!workingDirectory.startsWith("/")) {
    throw new SafeProcessError("Git working directory must be absolute.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new SafeProcessError("Git timeout is outside the allowed range.");
  }
  return {
    executable: "git",
    arguments: [...arguments_],
    workingDirectory,
    environment: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
    timeoutMs,
    stdin: "closed",
  };
}

export class CloudGitProcessRunner implements ProcessRunner {
  readonly #maximumOutputBytes: number;
  readonly #provider: CloudProviderName;
  readonly #runtimeEnvironment: NodeJS.ProcessEnv;

  constructor(
    provider: CloudProviderName,
    runtimeEnvironment: NodeJS.ProcessEnv,
    maximumOutputBytes = 4 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes <= 0) {
      throw new SafeProcessError("Git output limit must be a positive integer.");
    }
    assertCloudExecutionEnvironment(provider, runtimeEnvironment);
    this.#provider = provider;
    this.#runtimeEnvironment = { ...runtimeEnvironment };
    this.#maximumOutputBytes = maximumOutputBytes;
  }

  run(invocation: ProcessInvocation): Promise<ProcessResult> {
    assertCloudExecutionEnvironment(this.#provider, this.#runtimeEnvironment);
    if (invocation.executable !== "git" || invocation.stdin !== "closed") {
      return Promise.reject(new SafeProcessError("Runner accepts only closed-stdin Git calls."));
    }
    assertSafeGitArguments(invocation.arguments);
    gitInvocation(invocation.workingDirectory, invocation.arguments, invocation.timeoutMs);
    if (
      invocation.environment.GIT_TERMINAL_PROMPT !== "0" ||
      invocation.environment.GIT_OPTIONAL_LOCKS !== "0" ||
      Object.keys(invocation.environment).some(
        (name) => name !== "GIT_TERMINAL_PROMPT" && name !== "GIT_OPTIONAL_LOCKS",
      )
    ) {
      return Promise.reject(
        new SafeProcessError("Runner received an unapproved Git environment override."),
      );
    }

    const inheritedEnvironmentNames = [
      "HOME",
      "LOGNAME",
      "PATH",
      "SSH_AUTH_SOCK",
      "TMPDIR",
      "USER",
      "XDG_CONFIG_HOME",
    ] as const;
    const environment: Record<string, string> = {
      LC_ALL: "C",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    };
    for (const name of inheritedEnvironmentNames) {
      const value = this.#runtimeEnvironment[name];
      if (value !== undefined) environment[name] = value;
    }

    return new Promise((resolve) => {
      const child = spawn("/usr/bin/git", invocation.arguments, {
        cwd: invocation.workingDirectory,
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let timedOut = false;
      let outputExceeded = false;
      let settled = false;

      const append = (target: "stdout" | "stderr", chunk: unknown): void => {
        const text = String(chunk);
        outputBytes += Buffer.byteLength(text);
        if (outputBytes > this.#maximumOutputBytes) {
          outputExceeded = true;
          child.kill("SIGKILL");
          return;
        }
        if (target === "stdout") stdout += text;
        else stderr += text;
      };
      child.stdout.on("data", (chunk: unknown) => append("stdout", chunk));
      child.stderr.on("data", (chunk: unknown) => append("stderr", chunk));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, invocation.timeoutMs);

      const finish = (result: ProcessResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      child.once("error", (error) => {
        finish({
          exitCode: 71,
          stdout: "",
          stderr: `Unable to start Git: ${error.message}`,
        });
      });
      child.once("close", (code) => {
        if (outputExceeded) {
          finish({
            exitCode: 75,
            stdout: "",
            stderr: "Git output exceeded the configured limit.",
          });
          return;
        }
        if (timedOut) {
          finish({
            exitCode: 124,
            stdout: "",
            stderr: "Git command exceeded its timeout.",
          });
          return;
        }
        finish({
          exitCode: code ?? 70,
          stdout,
          stderr,
        });
      });
    });
  }
}
