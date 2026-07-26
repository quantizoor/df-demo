import type { ProtocolInputs } from "../domain/models.js";
import { canonicalHash } from "../schemas/canonical.js";
import { DarkFactoryError } from "./errors.js";

export interface ProtocolDifference {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

function assertNonEmptyString(value: string, path: string): void {
  if (!value.trim()) {
    throw new DarkFactoryError("CONFIG_INVALID", `Protocol input ${path} is empty`, {
      path,
    });
  }
}

function walkStrings(value: unknown, path: string): void {
  if (typeof value === "string") {
    assertNonEmptyString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      walkStrings(item, path ? `${path}.${key}` : key);
    }
  }
}

export function assertProtocolInputs(inputs: ProtocolInputs): void {
  walkStrings(inputs, "");
  if (
    !Number.isSafeInteger(inputs.evaluatedModel.contextWindow) ||
    inputs.evaluatedModel.contextWindow <= 0
  ) {
    throw new DarkFactoryError(
      "CONFIG_INVALID",
      "Evaluated model context window must be a positive integer",
    );
  }
  if (inputs.benchmark.name !== "terminal-bench" || inputs.benchmark.version !== "2.1") {
    throw new DarkFactoryError(
      "CONFIG_INVALID",
      "The MVP baseline contract must pin Terminal-Bench 2.1",
    );
  }
  if (inputs.mode === "submission" && inputs.leaderboardEligibility === "unverified") {
    throw new DarkFactoryError(
      "FULL_EVAL_FORBIDDEN",
      "An unverified lineage cannot initialize a submission protocol",
    );
  }
}

export function computeProtocolHash(inputs: ProtocolInputs): string {
  assertProtocolInputs(inputs);
  return canonicalHash(inputs);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diffValues(
  before: unknown,
  after: unknown,
  path: string,
  output: ProtocolDifference[],
): void {
  if (Object.is(before, after)) {
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      output.push({ path, before, after });
      return;
    }
    before.forEach((item, index) =>
      diffValues(item, after[index], `${path}[${index}]`, output),
    );
    return;
  }
  if (isPlainRecord(before) && isPlainRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      diffValues(before[key], after[key], path ? `${path}.${key}` : key, output);
    }
    return;
  }
  output.push({ path, before, after });
}

export function diffProtocolInputs(
  before: ProtocolInputs,
  after: ProtocolInputs,
): readonly ProtocolDifference[] {
  const output: ProtocolDifference[] = [];
  diffValues(before, after, "", output);
  return output;
}

export function requiresNewBaselineLineage(
  before: ProtocolInputs,
  after: ProtocolInputs,
): boolean {
  return computeProtocolHash(before) !== computeProtocolHash(after);
}
