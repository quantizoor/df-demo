import { createHash } from "node:crypto";
import { posix as path } from "node:path";
import { canonicalHash } from "../schemas/canonical.js";

export const INTEGRITY_VIOLATION_CODES = [
  "BENCHMARK_ARTIFACT_REFERENCE",
  "DIFF_METADATA_MISMATCH",
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

export const DEFAULT_PI_SCAN_POLICY_DESCRIPTOR = {
  version: "pi-candidate-integrity-v2",
  allowedRoots: [
    "packages/agent/src/",
    "packages/coding-agent/src/",
    "packages/ai/src/",
  ],
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
    {
      source:
        "(^|\\/)(test|tests|grader|graders|verifier|verifiers|solution|solutions|reference)(\\/|$)",
      flags: "iu",
    },
    {
      source: "(^|\\/)(terminal-bench|terminalbench|tbench|harbor)(\\/|$)",
      flags: "iu",
    },
    { source: "(^|\\/)\\.github\\/", flags: "u" },
    {
      source:
        "(^|\\/)(package\\.json|package-lock\\.json|npm-shrinkwrap\\.json|pnpm-lock\\.yaml|yarn\\.lock)$",
      flags: "u",
    },
    {
      source:
        "(^|\\/)(tsconfig(?:\\.[A-Za-z0-9._-]+)?\\.json|biome\\.json|vitest\\.config\\.[cm]?[jt]s)$",
      flags: "u",
    },
    {
      source: "(^|\\/)(scripts|evals?|benchmarks?|fixtures?|examples?)\\/",
      flags: "iu",
    },
    {
      source:
        "(^|\\/)(Dockerfile|docker-compose(?:\\.[A-Za-z0-9._-]+)?\\.ya?ml)$",
      flags: "iu",
    },
  ],
  maximumChangedFiles: 12,
  maximumChangedLines: 600,
  maximumLiteralLength: 400,
} as const;

export const DEFAULT_PI_SCAN_POLICY_HASH = canonicalHash(
  DEFAULT_PI_SCAN_POLICY_DESCRIPTOR,
);

export const DEFAULT_PI_SCAN_POLICY: CandidateScanPolicy = {
  allowedRoots: DEFAULT_PI_SCAN_POLICY_DESCRIPTOR.allowedRoots,
  allowedFileExtensions:
    DEFAULT_PI_SCAN_POLICY_DESCRIPTOR.allowedFileExtensions,
  protectedGlobs:
    DEFAULT_PI_SCAN_POLICY_DESCRIPTOR.protectedGlobs.map(
      ({ source, flags }) => new RegExp(source, flags),
    ),
  maximumChangedFiles:
    DEFAULT_PI_SCAN_POLICY_DESCRIPTOR.maximumChangedFiles,
  maximumChangedLines:
    DEFAULT_PI_SCAN_POLICY_DESCRIPTOR.maximumChangedLines,
  maximumLiteralLength:
    DEFAULT_PI_SCAN_POLICY_DESCRIPTOR.maximumLiteralLength,
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
const BASE64_LITERAL_CONTENT = /^[A-Za-z0-9+/]{24,}={0,2}$/u;
const HEX_LITERAL_CONTENT = /^(?:[a-f0-9]{2}){12,}$/iu;
const SPECIAL_GIT_OBJECT_MODE =
  /(?:^|\n)(?:(?:(?:old|new) mode|new file mode|deleted file mode) (?:120000|160000)|index [^\n]+ (?:120000|160000))(?:\n|$)/u;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(value: string): string | null {
  const normalized = path.normalize(value.replaceAll("\\", "/")).replace(/^\.\/+/u, "");
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
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

interface ParsedDiffMetadata {
  readonly paths: ReadonlySet<string>;
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly unambiguous: boolean;
}

function parseDiffMetadata(diff: string): ParsedDiffMetadata {
  const paths = new Set<string>();
  let addedLines = 0;
  let deletedLines = 0;
  let unambiguous = true;

  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      const header =
        /^diff --git a\/(?<before>\S+) b\/(?<after>\S+)$/u.exec(
          rawLine,
        );
      if (
        header?.groups?.before === undefined ||
        header.groups.after === undefined
      ) {
        unambiguous = false;
        continue;
      }
      for (const rawPath of [
        header.groups.before,
        header.groups.after,
      ]) {
        const normalized = normalizePath(rawPath);
        if (normalized === null) {
          unambiguous = false;
        } else {
          paths.add(normalized);
        }
      }
      continue;
    }
    if (
      rawLine.startsWith("--- a/") ||
      rawLine.startsWith("+++ b/")
    ) {
      const normalized = normalizePath(rawLine.slice(6));
      if (normalized === null) {
        unambiguous = false;
      } else {
        paths.add(normalized);
      }
      continue;
    }
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      addedLines += 1;
    } else if (
      rawLine.startsWith("-") &&
      !rawLine.startsWith("---")
    ) {
      deletedLines += 1;
    }
  }

  return {
    paths,
    addedLines,
    deletedLines,
    unambiguous,
  };
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

interface AddedLiteral {
  readonly value: string;
  readonly file: string | null;
  readonly line: number;
}

function addedLiterals(
  entries: readonly {
    readonly content: string;
    readonly line: number;
    readonly file: string | null;
  }[],
): readonly AddedLiteral[] {
  const output: AddedLiteral[] = [];
  for (const entry of entries) {
    for (const match of entry.content.matchAll(QUOTED_LITERAL)) {
      output.push({
        value: match.groups?.literal ?? "",
        file: entry.file,
        line: entry.line,
      });
    }
  }
  return output;
}

function decodedPrintablePayload(value: string): string | null {
  let decoded: Buffer;
  if (HEX_LITERAL_CONTENT.test(value)) {
    decoded = Buffer.from(value, "hex");
  } else if (BASE64_LITERAL_CONTENT.test(value) && value.length % 4 === 0) {
    decoded = Buffer.from(value, "base64");
  } else {
    return null;
  }
  if (decoded.length === 0) {
    return null;
  }
  const printable = [...decoded].filter(
    (byte) =>
      byte === 9 ||
      byte === 10 ||
      byte === 13 ||
      (byte >= 32 && byte <= 126),
  ).length;
  if (printable / decoded.length < 0.9) {
    return null;
  }
  return decoded.toString("utf8");
}

function scanAggregateAddedContent(
  entries: readonly {
    readonly content: string;
    readonly line: number;
    readonly file: string | null;
  }[],
  taskFragmentHashes: ReadonlySet<string>,
): readonly IntegrityViolation[] {
  const found: IntegrityViolation[] = [];
  const literals = addedLiterals(entries);

  for (const literal of literals) {
    const decoded = decodedPrintablePayload(literal.value);
    if (decoded === null) {
      continue;
    }
    const normalized = decoded.trim().toLowerCase();
    if (taskFragmentHashes.has(sha256(normalized))) {
      found.push(
        violation(
          "TASK_FRAGMENT_MATCH",
          "Candidate contains an encoded protected benchmark fragment",
          literal.value,
          literal.file,
          literal.line,
        ),
      );
    }
    if (BENCHMARK_REFERENCE.test(decoded)) {
      found.push(
        violation(
          "BENCHMARK_ARTIFACT_REFERENCE",
          "Candidate contains an encoded benchmark-specific reference",
          literal.value,
          literal.file,
          literal.line,
        ),
      );
    }
  }

  for (let start = 0; start < literals.length; start += 1) {
    const first = literals[start];
    if (first === undefined) {
      continue;
    }
    let compact = "";
    let spaced = "";
    let encodedChunks = 0;
    for (
      let end = start;
      end < literals.length && end < start + 12;
      end += 1
    ) {
      const current = literals[end];
      if (
        current === undefined ||
        current.file !== first.file
      ) {
        break;
      }
      compact += current.value;
      spaced =
        spaced.length === 0
          ? current.value
          : `${spaced} ${current.value}`;
      if (
        BASE64_LITERAL_CONTENT.test(current.value) ||
        HEX_LITERAL_CONTENT.test(current.value)
      ) {
        encodedChunks += 1;
      } else {
        encodedChunks = 0;
      }

      if (
        end > start &&
        (taskFragmentHashes.has(
          sha256(compact.trim().toLowerCase()),
        ) ||
          taskFragmentHashes.has(
            sha256(spaced.trim().toLowerCase()),
          ))
      ) {
        found.push(
          violation(
            "TASK_FRAGMENT_MATCH",
            "Candidate reconstructs a protected benchmark fragment across literals",
            compact,
            first.file,
            first.line,
          ),
        );
      }
      if (
        end > start &&
        encodedChunks === end - start + 1 &&
        encodedChunks >= 2 &&
        compact.length >= 160
      ) {
        found.push(
          violation(
            "ENCODED_PAYLOAD",
            "Candidate reconstructs an encoded lookup payload across literals",
            compact,
            first.file,
            first.line,
          ),
        );
      }
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
  const parsedDiff = parseDiffMetadata(input.unifiedDiff);
  const normalizedInputPaths = new Set(
    normalizedFiles.flatMap((file) =>
      file.normalized === null ? [] : [file.normalized],
    ),
  );
  const diffMetadataMatches =
    parsedDiff.unambiguous &&
    Number.isSafeInteger(input.addedLines) &&
    input.addedLines >= 0 &&
    Number.isSafeInteger(input.deletedLines) &&
    input.deletedLines >= 0 &&
    input.addedLines === parsedDiff.addedLines &&
    input.deletedLines === parsedDiff.deletedLines &&
    normalizedInputPaths.size === input.changedFiles.length &&
    normalizedInputPaths.size === parsedDiff.paths.size &&
    [...normalizedInputPaths].every((file) =>
      parsedDiff.paths.has(file),
    );
  if (!diffMetadataMatches) {
    violations.push(
      violation(
        "DIFF_METADATA_MISMATCH",
        "Candidate mutation metadata does not match the supplied Git diff",
        `${input.changedFiles.join("\n")}\n${input.addedLines}:${input.deletedLines}\n${input.unifiedDiff}`,
      ),
    );
  }

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

  if (SPECIAL_GIT_OBJECT_MODE.test(input.unifiedDiff)) {
    violations.push(
      violation(
        "OPAQUE_BINARY_CHANGE",
        "Candidate diff adds or changes a symbolic link or Git submodule",
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

  const addedLines = addedDiffLines(input.unifiedDiff);
  for (const addedLine of addedLines) {
    violations.push(...scanAddedLine(addedLine, policy, input.taskFragmentHashes));
  }
  violations.push(
    ...scanAggregateAddedContent(
      addedLines,
      input.taskFragmentHashes,
    ),
  );

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
