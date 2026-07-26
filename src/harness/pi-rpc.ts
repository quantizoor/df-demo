import type { RemoteCommandSpec, SecretReference } from "../cloud/types.js";

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiRpcLaunchOptions {
  readonly piRoot: string;
  readonly taskWorkingDirectory: string;
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly enabledTools: readonly string[];
  readonly timeoutMs: number;
  readonly secretReferences: readonly SecretReference[];
}

export interface PiRpcLaunchSpec {
  readonly protocol: "pi-rpc-jsonl-v1";
  readonly framing: "lf-only";
  readonly command: RemoteCommandSpec;
}

export type PiRpcRecordKind =
  | "response"
  | "agent-lifecycle"
  | "turn"
  | "message"
  | "tool"
  | "queue"
  | "compaction"
  | "retry"
  | "extension-ui"
  | "extension-error"
  | "unknown";

export interface TrustedPiRpcRecord {
  readonly sensitivity: "raw-trusted-evaluator-only";
  readonly kind: PiRpcRecordKind;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface TrustedBenchmarkTaskPrompt {
  readonly sensitivity: "benchmark-task-trusted-evaluator-only";
  readonly requestId: string;
  readonly message: string;
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SAFE_TOOL = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const PI_THINKING_LEVELS = new Set<PiThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export class PiRpcSpecificationError extends Error {
  override readonly name = "PiRpcSpecificationError";
}

function assertAbsolutePath(path: string, label: string): void {
  if (!path.startsWith("/") || path.includes("/../") || path.includes("\u0000")) {
    throw new PiRpcSpecificationError(`${label} must be an absolute traversal-free path.`);
  }
}

export function createPiRpcLaunchSpec(options: PiRpcLaunchOptions): PiRpcLaunchSpec {
  assertAbsolutePath(options.piRoot, "Pi root");
  assertAbsolutePath(options.taskWorkingDirectory, "Task working directory");
  if (
    !SAFE_IDENTIFIER.test(options.provider) ||
    !SAFE_IDENTIFIER.test(options.modelId) ||
    !PI_THINKING_LEVELS.has(options.thinkingLevel)
  ) {
    throw new PiRpcSpecificationError(
      "Pi provider, model, and thinking level must be exact supported identifiers.",
    );
  }
  if (options.enabledTools.length === 0 || options.enabledTools.some((tool) => !SAFE_TOOL.test(tool))) {
    throw new PiRpcSpecificationError("Pi tool allowlist is empty or malformed.");
  }
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 24 * 60 * 60_000
  ) {
    throw new PiRpcSpecificationError("Pi RPC timeout is outside the allowed range.");
  }

  const arguments_: string[] = [
    `${options.piRoot}/packages/coding-agent/dist/cli.js`,
    "--mode",
    "rpc",
    "--provider",
    options.provider,
    "--model",
    options.modelId,
    "--thinking",
    options.thinkingLevel,
    "--no-session",
    "--no-approve",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--tools",
    [...new Set(options.enabledTools)].sort().join(","),
  ];
  return {
    protocol: "pi-rpc-jsonl-v1",
    framing: "lf-only",
    command: {
      executable: "/usr/bin/node",
      arguments: arguments_,
      workingDirectory: options.taskWorkingDirectory,
      timeoutMs: options.timeoutMs,
      environment: {
        CI: "true",
        DF_CLOUD_EXECUTION: "1",
        PI_OFFLINE: "1",
      },
      secretReferences: options.secretReferences,
    },
  };
}

export function serializeTrustedPiPrompt(prompt: TrustedBenchmarkTaskPrompt): string {
  if (
    prompt.sensitivity !== "benchmark-task-trusted-evaluator-only" ||
    !SAFE_IDENTIFIER.test(prompt.requestId) ||
    prompt.message.length === 0 ||
    Buffer.byteLength(prompt.message, "utf8") > 1024 * 1024 ||
    prompt.message.includes("\u0000")
  ) {
    throw new PiRpcSpecificationError("Trusted Pi prompt is empty, oversized, or malformed.");
  }
  return `${JSON.stringify({
    id: prompt.requestId,
    type: "prompt",
    message: prompt.message,
  })}\n`;
}

function classifyRecord(type: string): PiRpcRecordKind {
  if (type === "response") return "response";
  if (type === "agent_start" || type === "agent_end" || type === "agent_settled") {
    return "agent-lifecycle";
  }
  if (type === "turn_start" || type === "turn_end") return "turn";
  if (type === "message_start" || type === "message_update" || type === "message_end") {
    return "message";
  }
  if (type.startsWith("tool_execution_") || type === "bash_execution_update") return "tool";
  if (type === "queue_update") return "queue";
  if (type === "compaction_start" || type === "compaction_end") return "compaction";
  if (type.includes("retry")) return "retry";
  if (type === "extension_ui_request") return "extension-ui";
  if (type === "extension_error") return "extension-error";
  return "unknown";
}

function parseRecord(line: string): TrustedPiRpcRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new PiRpcSpecificationError("Pi RPC emitted malformed JSON.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("type" in parsed) ||
    typeof parsed.type !== "string"
  ) {
    throw new PiRpcSpecificationError("Pi RPC record must be an object with a string type.");
  }
  return {
    sensitivity: "raw-trusted-evaluator-only",
    kind: classifyRecord(parsed.type),
    value: parsed as Readonly<Record<string, unknown>>,
  };
}

export class PiRpcJsonlDecoder {
  readonly #maximumLineBytes: number;
  #buffer = "";

  constructor(maximumLineBytes = 4 * 1024 * 1024) {
    if (!Number.isSafeInteger(maximumLineBytes) || maximumLineBytes <= 0) {
      throw new PiRpcSpecificationError("Maximum Pi RPC record size must be positive.");
    }
    this.#maximumLineBytes = maximumLineBytes;
  }

  push(chunk: string): readonly TrustedPiRpcRecord[] {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maximumLineBytes && !this.#buffer.includes("\n")) {
      throw new PiRpcSpecificationError("Pi RPC record exceeds the configured size limit.");
    }
    const records: TrustedPiRpcRecord[] = [];
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      let line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (Buffer.byteLength(line, "utf8") > this.#maximumLineBytes) {
        throw new PiRpcSpecificationError("Pi RPC record exceeds the configured size limit.");
      }
      if (line.length === 0) {
        throw new PiRpcSpecificationError("Pi RPC stream contains an empty JSONL record.");
      }
      records.push(parseRecord(line));
      newlineIndex = this.#buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maximumLineBytes) {
      throw new PiRpcSpecificationError("Pi RPC record exceeds the configured size limit.");
    }
    return records;
  }

  finish(): void {
    if (this.#buffer.length > 0) {
      throw new PiRpcSpecificationError(
        "Pi RPC stream ended with a non-terminated JSONL record.",
      );
    }
  }
}
