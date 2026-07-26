import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { assertReleaseSafeText } from "../schemas/safety.js";

export const MAX_MCP_RESPONSE_CHARACTERS = 12_000;
export const MAX_MCP_INPUT_CHARACTERS = 20_000;

const FORBIDDEN_KEY =
  /(?:^|_)(?:tasks?|task(?:id|key|name|instruction|identity|mapping|membership|digest|revision|handle|assignment|outcome)|trial|grader|verifier|solution|instruction|command|argument|stdout|stderr|path|filename|url|package|service|environment|panel(?:_?id)|pool|handle|raw|atif)(?:$|_)/iu;

function forbiddenKey(key: string): boolean {
  const normalized = key.replaceAll(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase();
  if (
    normalized === "distinct_tasks_band" ||
    normalized === "distinct_task_count_band" ||
    normalized === "minimum_distinct_tasks" ||
    normalized === "task_cluster_count_band" ||
    normalized === "trajectory_count_band" ||
    normalized === "minimum_compared_group_size_band" ||
    normalized === "matched_task_count" ||
    normalized === "task_count" ||
    normalized === "task_identity_scan_passed" ||
    normalized === "raw_artifacts" ||
    normalized === "retention_disposition"
  ) {
    return false;
  }
  return FORBIDDEN_KEY.test(normalized);
}

export function opaqueDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const result = relative(normalizedRoot, normalizedCandidate);
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

export async function assertExistingDirectory(value: string): Promise<string> {
  const resolved = await realpath(value);
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) {
    throw new Error("Configured path is not a directory");
  }
  return resolved;
}

export function assertSafeReleasedObject(value: unknown, location = "$", depth = 0): void {
  if (depth > 20) {
    throw new Error("Released object nesting exceeds the safety limit");
  }
  if (typeof value === "string") {
    try {
      assertReleaseSafeText(value, location);
    } catch {
      throw new Error(`Released object contains a protected literal category at ${location}`);
    }
    return;
  }
  if (value === null || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Released object contains a non-finite number at ${location}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertSafeReleasedObject(item, `${location}[${index}]`, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`Released object contains an unsupported value at ${location}`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKey(key)) {
      throw new Error(`Released object contains forbidden field category at ${location}`);
    }
    assertSafeReleasedObject(item, `${location}.${key}`, depth + 1);
  }
}

export function boundedJson(value: unknown): string {
  assertSafeReleasedObject(value);
  const output = JSON.stringify(value);
  if (output.length > MAX_MCP_RESPONSE_CHARACTERS) {
    throw new Error("Safe MCP response exceeds the fixed response budget");
  }
  return output;
}

export function assertBoundedInput(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_MCP_INPUT_CHARACTERS) {
    throw new Error("MCP input exceeds the fixed request budget");
  }
}

const FORBIDDEN_NARRATIVE_PATTERN = [
  /\b(?:https?|ftp):\/\/\S+/iu,
  /(?:^|\s)\/(?:[\w.@+-]+\/)+[\w.@+-]+/u,
  /\b[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]+/u,
  /```/u,
  /`[^`]+`/u,
  /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/u,
  /\b(?:task|trial|grader|verifier|solution)[-_\s]*(?:id[-_\s]*)?[A-Za-z0-9_-]+\b/iu,
  /\b(?:terminal[-_\s]?bench|harbor)\b/iu,
  /\b[A-Za-z0-9+/]{80,}={0,2}\b/u,
] as const;

const NARRATIVE_FIELDS = new Set([
  "observedPattern",
  "causalClaim",
  "intervention",
  "accuracy",
  "capability",
  "cost",
  "latency",
  "generalityJustification",
  "falsificationCriteria",
  "rollbackCondition",
  "expectedVersusObserved",
  "regressions",
  "confounders",
  "nextDirection",
  "rationale",
  "summary",
]);

function scanNarrative(value: unknown, path: string): void {
  if (typeof value === "string") {
    try {
      assertReleaseSafeText(value, path);
    } catch {
      throw new Error(`Submission narrative contains a protected literal category at ${path}`);
    }
    if (FORBIDDEN_NARRATIVE_PATTERN.some((pattern) => pattern.test(value))) {
      throw new Error(`Submission narrative contains a protected literal category at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      scanNarrative(item, `${path}[${index}]`);
    });
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (NARRATIVE_FIELDS.has(key)) {
      scanNarrative(item, `${path}.${key}`);
    }
  }
}

/**
 * Defense in depth for model-authored prose. Structured hashes, receipts, and
 * component enums remain permitted; narrative channels reject task/grader
 * tokens, code, paths, URLs, environment expansions, and encoded payloads.
 */
export function assertTaskAgnosticSubmission(value: unknown): void {
  assertBoundedInput(value);
  scanNarrative(value, "$");
}
