import { createHash } from "node:crypto";
import { posix as path } from "node:path";

export const INTEGRITY_VIOLATION_CODES = [
  "BENCHMARK_ARTIFACT_REFERENCE",
  "ENCODED_PAYLOAD",
  "ENVIRONMENT_FINGERPRINT_ROUTING",
  "LARGE_CONSTANT",
  "MUTATION_TOO_LARGE",
  "NETWORK_TOOL_ADDITION",
  "OPAQUE_BINARY_CHANGE",
  "PROTECTED_PATH",
  "SOLUTION_REFERENCE",
  "SUSPICIOUS_LITERAL",
  "TASK_FRAGMENT_MATCH",
] as const;

export type IntegrityViolationCode = (typeof INTEGRITY_VIOLATION_CODES)[number];

export interface IntegrityViolation {
  readonly code: IntegrityViolationCode;
  readonly path: string | null;
  readonly line: number | null;
  readonly evidenceHash: string;
  readonly message: string;
}

export interface CandidateScanInput {
  readonly changedFiles: readonly string[];
  readonly unifiedDiff: string;
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly taskFragmentHashes: ReadonlySet<string>;
}

export interface CandidateScanPolicy {
  readonly allowedRoots: readonly string[];
  readonly allowedFileExtensions: readonly string[];
  readonly protectedGlobs: readonly RegExp[];
  readonly maximumChangedFiles: number;
  readonly maximumChangedLines: number;
  readonly maximumLiteralLength: number;
}

export interface CandidateScanResult {
  readonly passed: boolean;
  readonly mutation: {
    readonly changedFiles: number;
    readonly addedLines: number;
    readonly deletedLines: number;
  };
  readonly violations: readonly IntegrityViolation[];
}

export const DEFAULT_PI_SCAN_POLICY: CandidateScanPolicy = {
  allowedRoots: ["packages/agent/", "packages/coding-agent/", "packages/ai/"],
  allowedFileExtensions: [
    ".cjs",
    ".css",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mjs",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
  ],
  protectedGlobs: [
    /(^|\/)(test|tests|grader|graders|verifier|verifiers|solution|solutions|reference)(\/|$)/iu,
    /(^|\/)(terminal-bench|terminalbench|tbench|harbor)(\/|$)/iu,
    /(^|\/)\.github\//u,
    /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/u,
    /(^|\/)(tsconfig(?:\.[A-Za-z0-9._-]+)?\.json|biome\.json|vitest\.config\.[cm]?[jt]s)$/u,
    /(^|\/)(scripts|evals?|benchmarks?|fixtures?|examples?)\//iu,
    /(^|\/)(Dockerfile|docker-compose(?:\.[A-Za-z0-9._-]+)?\.ya?ml)$/iu,
  ],
  maximumChangedFiles: 12,
  maximumChangedLines: 600,
  maximumLiteralLength: 400,
};

const BASE64_PAYLOAD = /(?:["'`])[A-Za-z0-9+/]{160,}={0,2}(?:["'`])/u;
const HEX_PAYLOAD = /(?:["'`])(?:[a-f0-9]{2}){100,}(?:["'`])/iu;
const NETWORK_ADDITION =
  /\b(?:curl|wget|fetch\s*\(|axios|undici|node:https|node:http|WebSocket)\b/u;
const SOLUTION_REFERENCE =
  /(?:github\.com|gitlab\.com|gist\.github\.com|pastebin\.com).{0,100}(?:solution|answer|terminal.?bench)/iu;
const BENCHMARK_REFERENCE =
  /\b(?:terminal[-_ ]?bench|tbench|harbor).{0,80}(?:task|grader|test|solution|answer|verifier)\b/iu;
const FINGERPRINT_ROUTING =
  /(?:process\.env|os\.hostname|hostname\s*\(|uname|machine-id|\/etc\/hostname).{0,160}(?:if|switch|case|includes|match|test)/iu;
const QUOTED_LITERAL = /(["'`])(?<literal>(?:\\.|(?!\1).)*)\1/gu;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(value: string): string | null {
  const normalized = path.normalize(value.replaceAll("\\", "/")).replace(/^\.\/+/u, "");
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized.includes("\0")
  ) {
    return null;
  }
  return normalized;
}

function violation(
  code: IntegrityViolationCode,
  message: string,
  evidence: string,
  filePath: string | null = null,
  line: number | null = null,
): IntegrityViolation {
  return { code, path: filePath, line, evidenceHash: sha256(evidence), message };
}

function addedDiffLines(diff: string): readonly { content: string; line: number; file: string | null }[] {
  const output: { content: string; line: number; file: string | null }[] = [];
  let file: string | null = null;
  let targetLine = 0;
  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("+++ b/")) {
      file = normalizePath(rawLine.slice(6));
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,\d+)? @@/u.exec(rawLine);
    if (hunk?.groups?.start) {
      targetLine = Number.parseInt(hunk.groups.start, 10);
      continue;
    }
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      output.push({ content: rawLine.slice(1), line: targetLine, file });
      targetLine += 1;
      continue;
    }
    if (!rawLine.startsWith("-")) {
      targetLine += 1;
    }
  }
  return output;
}

function scanAddedLine(
  entry: { content: string; line: number; file: string | null },
  policy: CandidateScanPolicy,
  taskFragmentHashes: ReadonlySet<string>,
): readonly IntegrityViolation[] {
  const found: IntegrityViolation[] = [];
  const { content, file, line } = entry;
  if (BASE64_PAYLOAD.test(content) || HEX_PAYLOAD.test(content)) {
    found.push(violation("ENCODED_PAYLOAD", "Encoded lookup payload is not allowed", content, file, line));
  }
  if (NETWORK_ADDITION.test(content)) {
    found.push(
      violation(
        "NETWORK_TOOL_ADDITION",
        "Candidate adds or references an uncontrolled network mechanism",
        content,
        file,
        line,
      ),
    );
  }
  if (SOLUTION_REFERENCE.test(content)) {
    found.push(
      violation("SOLUTION_REFERENCE", "Candidate references a likely solution source", content, file, line),
    );
  }
  if (BENCHMARK_REFERENCE.test(content)) {
    found.push(
      violation(
        "BENCHMARK_ARTIFACT_REFERENCE",
        "Candidate references benchmark-specific test or grader material",
        content,
        file,
        line,
      ),
    );
  }
  if (FINGERPRINT_ROUTING.test(content)) {
    found.push(
      violation(
        "ENVIRONMENT_FINGERPRINT_ROUTING",
        "Candidate appears to route behavior using an environment fingerprint",
        content,
        file,
        line,
      ),
    );
  }

  for (const match of content.matchAll(QUOTED_LITERAL)) {
    const literal = match.groups?.literal ?? "";
    if (literal.length > policy.maximumLiteralLength) {
      found.push(
        violation(
          "LARGE_CONSTANT",
          "Candidate contains an unusually large literal",
          literal,
          file,
          line,
        ),
      );
    }
    if (taskFragmentHashes.has(sha256(literal.trim().toLowerCase()))) {
      found.push(
        violation(
          "TASK_FRAGMENT_MATCH",
          "Candidate contains a protected benchmark fragment",
          literal,
          file,
          line,
        ),
      );
    }
  }
  return found;
}

export function scanCandidate(
  input: CandidateScanInput,
  policy: CandidateScanPolicy = DEFAULT_PI_SCAN_POLICY,
): CandidateScanResult {
  const violations: IntegrityViolation[] = [];
  const normalizedFiles = input.changedFiles.map((file) => ({
    original: file,
    normalized: normalizePath(file),
  }));

  for (const file of normalizedFiles) {
    if (file.normalized === null) {
      violations.push(
        violation("PROTECTED_PATH", "Changed path is absolute or escapes the repository", file.original),
      );
      continue;
    }
    if (!policy.allowedRoots.some((root) => file.normalized?.startsWith(root))) {
      violations.push(
        violation(
          "PROTECTED_PATH",
          "Changed path is outside the approved Pi mutation roots",
          file.normalized,
          file.normalized,
        ),
      );
    }
    if (
      !policy.allowedFileExtensions.some((extension) =>
        file.normalized?.endsWith(extension),
      )
    ) {
      violations.push(
        violation(
          "OPAQUE_BINARY_CHANGE",
          "Candidate changes an extensionless, binary, or unapproved source format",
          file.normalized,
          file.normalized,
        ),
      );
    }
    if (policy.protectedGlobs.some((pattern) => pattern.test(file.normalized))) {
      violations.push(
        violation(
          "PROTECTED_PATH",
          "Changed path matches a protected benchmark, test, or policy path",
          file.normalized,
          file.normalized,
        ),
      );
    }
  }

  if (
    /(?:^|\n)(?:GIT binary patch|Binary files [^\n]+ differ)(?:\n|$)/u.test(
      input.unifiedDiff,
    )
  ) {
    violations.push(
      violation(
        "OPAQUE_BINARY_CHANGE",
        "Candidate diff contains an opaque binary change",
        input.unifiedDiff,
      ),
    );
  }

  if (
    input.changedFiles.length > policy.maximumChangedFiles ||
    input.addedLines + input.deletedLines > policy.maximumChangedLines
  ) {
    violations.push(
      violation(
        "MUTATION_TOO_LARGE",
        "Candidate exceeds the frozen changed-file or changed-line limit",
        `${input.changedFiles.length}:${input.addedLines}:${input.deletedLines}`,
      ),
    );
  }

  for (const addedLine of addedDiffLines(input.unifiedDiff)) {
    violations.push(...scanAddedLine(addedLine, policy, input.taskFragmentHashes));
  }

  const unique = new Map<string, IntegrityViolation>();
  for (const item of violations) {
    unique.set(`${item.code}:${item.path}:${item.line}:${item.evidenceHash}`, item);
  }
  const ordered = [...unique.values()].sort((left, right) =>
    `${left.code}:${left.path}:${left.line}`.localeCompare(
      `${right.code}:${right.path}:${right.line}`,
    ),
  );

  return {
    passed: ordered.length === 0,
    mutation: {
      changedFiles: input.changedFiles.length,
      addedLines: input.addedLines,
      deletedLines: input.deletedLines,
    },
    violations: ordered,
  };
}
