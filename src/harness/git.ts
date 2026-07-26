import { createHash } from "node:crypto";
import type { ProcessResult, ProcessRunner } from "./process.js";
import { gitInvocation } from "./process.js";

export type RemoteTransport = "https" | "ssh" | "file" | "other";

export interface RemoteFingerprint {
  readonly transport: RemoteTransport;
  readonly hostHash: string;
  readonly repositoryHash: string;
}

export interface SensitiveRemoteReference {
  readonly remoteName: string;
  readonly url: string;
}

const HEX_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SENSITIVE_TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:api[_-]?key|token|password|secret)=)[^\s&]+/giu;

export class GitCommandError extends Error {
  override readonly name = "GitCommandError";
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(SENSITIVE_TOKEN, "[REDACTED]")
    .replace(/\b(?:https?|ssh|git):\/\/[^\s]+/giu, "[REDACTED_REMOTE]")
    .replace(/\b(?:[^/\s@:]+@)?[A-Za-z0-9.-]+:[^\s]+/gu, "[REDACTED_REMOTE]");
}

function parseRemote(url: string): {
  transport: RemoteTransport;
  host: string;
  repository: string;
} {
  try {
    const parsed = new URL(url);
    const transport: RemoteTransport =
      parsed.protocol === "https:"
        ? "https"
        : parsed.protocol === "ssh:"
          ? "ssh"
          : parsed.protocol === "file:"
            ? "file"
            : "other";
    return {
      transport,
      host: parsed.hostname.toLowerCase(),
      repository: parsed.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, ""),
    };
  } catch {
    const scp = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/u.exec(url);
    if (scp?.[1] !== undefined && scp[2] !== undefined) {
      return {
        transport: "ssh",
        host: scp[1].toLowerCase(),
        repository: scp[2].replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, ""),
      };
    }
  }
  throw new GitCommandError("Remote URL has an unsupported format.", 64);
}

export function fingerprintRemoteUrl(url: string): RemoteFingerprint {
  const parsed = parseRemote(url);
  if (parsed.transport === "file" || parsed.repository.length === 0 || parsed.host.length === 0) {
    throw new GitCommandError("Local or incomplete Git remotes are forbidden.", 64);
  }
  return {
    transport: parsed.transport,
    hostHash: createHash("sha256").update(parsed.host).digest("hex"),
    repositoryHash: createHash("sha256")
      .update(`${parsed.host}/${parsed.repository}`)
      .digest("hex"),
  };
}

export function assertObjectId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!HEX_OBJECT_ID.test(normalized)) {
    throw new GitCommandError("Git returned an invalid object identifier.", 65);
  }
  return normalized;
}

export class SafeGit {
  readonly #runner: ProcessRunner;

  constructor(runner: ProcessRunner) {
    this.#runner = runner;
  }

  async run(
    workingDirectory: string,
    arguments_: readonly string[],
    options: { readonly allowFailure?: boolean; readonly timeoutMs?: number } = {},
  ): Promise<ProcessResult> {
    const result = await this.#runner.run(
      gitInvocation(workingDirectory, arguments_, options.timeoutMs),
    );
    if (result.exitCode !== 0 && options.allowFailure !== true) {
      const detail = redactSensitiveText(result.stderr || result.stdout)
        .trim()
        .slice(0, 500);
      throw new GitCommandError(
        detail.length === 0 ? "Git command failed." : `Git command failed: ${detail}`,
        result.exitCode,
      );
    }
    return result;
  }

  async text(workingDirectory: string, arguments_: readonly string[]): Promise<string> {
    return (await this.run(workingDirectory, arguments_)).stdout.trim();
  }
}
