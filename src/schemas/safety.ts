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

const RELEASE_TEXT_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "URL", pattern: /\b(?:https?|ftp):\/\/\S+/iu },
  { label: "absolute POSIX path", pattern: /(?:^|\s)\/(?:[\w.@+-]+\/)+[\w.@+-]+/u },
  { label: "Windows path", pattern: /\b[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]+/u },
  { label: "code fence", pattern: /```/u },
  { label: "inline command or code", pattern: /`[^`]+`/u },
  { label: "shell environment expansion", pattern: /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/u },
  { label: "task-number reference", pattern: /\btask[-_\s]*(?:id[-_\s]*)?\d+\b/iu },
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

function scan(value: unknown, path: string, ancestors: ReadonlySet<object>): void {
  if (typeof value === "string") {
    for (const { label, pattern } of RELEASE_TEXT_PATTERNS) {
      if (pattern.test(value)) {
        throw new UnsafeEvidenceError(path, `contains a forbidden ${label}`);
      }
    }
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

export function isForbiddenEvidenceField(fieldName: string): boolean {
  return forbiddenFieldName(fieldName);
}
