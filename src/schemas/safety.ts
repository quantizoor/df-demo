const FORBIDDEN_FIELD_NAMES = new Set([
  "actualvalue",
  "arguments",
  "command",
  "environmentvariable",
  "expectedvalue",
  "filename",
  "filepath",
  "grader",
  "graderoutput",
  "gradertext",
  "package",
  "packagename",
  "rawatif",
  "rawoutput",
  "rawtrajectory",
  "service",
  "servicename",
  "stderr",
  "stdout",
  "task",
  "taskassignment",
  "taskid",
  "taskinstruction",
  "taskkey",
  "taskmapping",
  "taskname",
  "testname",
  "testnames",
  "trajectory",
  "trial",
  "trialhandle",
  "trialid",
  "url",
  "verifier",
  "verifieroutput",
]);

const ALLOWED_AGGREGATE_FIELD_NAMES = new Set([
  "distincttaskcount",
  "distincttaskcountband",
  "graderscanpassed",
  "gradercanaryscanpassed",
  "graderleakscan",
  "matchedtaskcount",
  "rawartifacts",
  "rawretentiondisposition",
  "taskcount",
  "taskidentityscanpassed",
  "trajectorycount",
  "trajectorycountband",
]);

const RELEASE_TEXT_PATTERNS: readonly {
  readonly label: string;
  readonly pattern: RegExp;
}[] = [
  {
    label: "URL",
    pattern:
      /\b(?:https?|ftp|file|data|git|ssh):(?:\/\/|[^\s]+)/iu,
  },
  {
    label: "credentialed repository locator",
    pattern:
      /\b[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s"'`]+/u,
  },
  {
    label: "absolute POSIX path",
    pattern:
      /(?:^|[\s"'(=:[{])\/(?:[A-Za-z0-9._@+-]+\/)*[A-Za-z0-9._@+-]+(?=$|[\s"'`),.;:\]}])/u,
  },
  {
    label: "protected POSIX root",
    pattern:
      /(?:^|[\s"'(=:[{])\/(?:Users|etc|home|opt|private|root|tmp|var|workspace)(?:\/|(?=$|[\s"'`),.;:\]}]))/u,
  },
  {
    label: "Windows path",
    pattern: /\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/u,
  },
  {
    label: "path traversal",
    pattern: /(?:^|[\\/])\.\.(?:[\\/]|$)/u,
  },
  {
    label: "encoded path",
    pattern:
      /(?:%(?:2e|2f|5c)|\\x(?:2e|2f|5c)|\\u00(?:2e|2f|5c))/iu,
  },
  { label: "code fence", pattern: /```/u },
  { label: "inline command or code", pattern: /`[^`]+`/u },
  {
    label: "shell environment expansion",
    pattern: /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/u,
  },
  {
    label: "task-number reference",
    pattern: /\btask[-_\s]*(?:id[-_\s]*)?\d+\b/iu,
  },
  {
    label: "benchmark identity",
    pattern:
      /\b(?:task|trial|panel|cell)[-_\s]*(?:id|key|name|handle|digest|revision)[-_\s]*[A-Za-z0-9][A-Za-z0-9._:-]*\b/iu,
  },
  {
    label: "grader or verifier identity",
    pattern:
      /\b(?:grader|verifier|reference[-_\s]*answer|solution)\b/iu,
  },
  {
    label: "control or bidirectional character",
    pattern:
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u,
  },
];

export class UnsafeEvidenceError extends Error {
  public readonly jsonPath: string;

  public constructor(jsonPath: string, reason: string) {
    super(`Unsafe evidence at ${jsonPath}: ${reason}`);
    this.name = "UnsafeEvidenceError";
    this.jsonPath = jsonPath;
  }
}

function normalizedFieldName(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function forbiddenFieldName(value: string): boolean {
  const normalized = normalizedFieldName(value);
  if (ALLOWED_AGGREGATE_FIELD_NAMES.has(normalized)) {
    return false;
  }
  return (
    FORBIDDEN_FIELD_NAMES.has(normalized) ||
    normalized.startsWith("task") ||
    normalized.startsWith("trial") ||
    normalized.startsWith("raw") ||
    normalized.startsWith("verifier") ||
    normalized.startsWith("grader") ||
    normalized.startsWith("trajectory")
  );
}

function printableRatio(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  let printable = 0;
  for (const byte of bytes) {
    if (
      byte === 9 ||
      byte === 10 ||
      byte === 13 ||
      (byte >= 32 && byte <= 126)
    ) {
      printable += 1;
    }
  }
  return printable / bytes.byteLength;
}

function decodedLooksLikePayload(bytes: Uint8Array): boolean {
  if (printableRatio(bytes) < 0.85) return false;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes,
    );
  } catch {
    return false;
  }
  return (
    /^\s*[/\\[{]/u.test(decoded) ||
    /\b(?:task|trial|panel|cell|grader|verifier|solution)\b/iu.test(
      decoded,
    ) ||
    /[A-Za-z]{3,}(?:[\s:/._-]+[A-Za-z]{3,}){1,}/u.test(
      decoded,
    )
  );
}

function looksLikeBase64EncodedText(value: string): boolean {
  if (
    value.length < 16 ||
    value.length > 16_384 ||
    !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(value)
  ) {
    return false;
  }
  try {
    const normalized = value.replace(/=+$/u, "");
    const encoding =
      /[+\/]/u.test(normalized) ? "base64" : "base64url";
    const decoded = Buffer.from(normalized, encoding);
    const canonical = decoded
      .toString(encoding)
      .replace(/=+$/u, "");
    return (
      decoded.byteLength >= 8 &&
      decodedLooksLikePayload(decoded) &&
      canonical === normalized
    );
  } catch {
    return false;
  }
}

function looksLikeHexEncodedText(value: string): boolean {
  if (
    value.length < 16 ||
    value.length > 16_384 ||
    value.length % 2 !== 0 ||
    !/^[a-f0-9]+$/iu.test(value)
  ) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, "hex");
    return (
      decoded.byteLength >= 8 &&
      decodedLooksLikePayload(decoded)
    );
  } catch {
    return false;
  }
}

function assertReleaseSafeString(value: string, path: string): void {
  const normalized = value.normalize("NFKC");
  for (const { label, pattern } of RELEASE_TEXT_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new UnsafeEvidenceError(
        path,
        `contains a forbidden ${label}`,
      );
    }
  }
  if (
    looksLikeBase64EncodedText(normalized) ||
    looksLikeHexEncodedText(normalized)
  ) {
    throw new UnsafeEvidenceError(
      path,
      "contains an encoded printable payload",
    );
  }
}

function scan(value: unknown, path: string, ancestors: ReadonlySet<object>): void {
  if (typeof value === "string") {
    assertReleaseSafeString(value, path);
    return;
  }

  if (value === null || typeof value !== "object") {
    return;
  }
  if (ancestors.has(value)) {
    throw new UnsafeEvidenceError(path, "contains a cyclic value");
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => scan(item, `${path}/${index}`, nextAncestors));
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (forbiddenFieldName(key)) {
      throw new UnsafeEvidenceError(`${path}/${key}`, `field "${key}" is forbidden`);
    }
    scan(item, `${path}/${key}`, nextAncestors);
  }
}

/**
 * Defense-in-depth scanner for artifacts that cross the trusted evaluator
 * boundary. JSON Schema remains authoritative for shape; this rejects common
 * task/grader/raw-data channels inside otherwise schema-valid text.
 */
export function assertReleaseSafe(value: unknown): void {
  scan(value, "$", new Set());
}

export function isReleaseSafe(value: unknown): boolean {
  try {
    assertReleaseSafe(value);
    return true;
  } catch {
    return false;
  }
}

export function assertReleaseSafeText(
  value: string,
  path = "$",
): void {
  assertReleaseSafeString(value, path);
}

export function isForbiddenEvidenceField(fieldName: string): boolean {
  return forbiddenFieldName(fieldName);
}
