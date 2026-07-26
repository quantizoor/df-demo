import { canonicalHash, withContentHash } from "../schemas/canonical.js";
import { assertValidDocument } from "../schemas/registry.js";
import type { NormalizedGraderOutcome } from "../schemas/trusted.js";

export type GenericToolCategory =
  | "read"
  | "write"
  | "execute"
  | "search"
  | "plan"
  | "inspect"
  | "network"
  | "other";
export type CountBucket = "none" | "one" | "two-three" | "four-plus";
export type RatioBucket = "none" | "low" | "medium" | "high" | "all";
export type ExitStatusClass = "zero" | "nonzero" | "signal" | "unknown";
export type StopReason = "completed" | "agent-stop" | "timeout" | "budget" | "error" | "unknown";
export type DurationBucket = "under-1m" | "1-5m" | "5-15m" | "15m-plus";

export type RawTrajectoryEvent =
  | {
      readonly kind: "tool-call";
      readonly category: GenericToolCategory | string;
      readonly invocationValid: boolean;
      readonly actionFingerprint?: string;
      readonly command?: unknown;
      readonly arguments?: unknown;
      readonly path?: unknown;
      readonly url?: unknown;
    }
  | {
      readonly kind: "tool-result";
      readonly exitCode?: number | null;
      readonly terminatedBySignal?: boolean;
      readonly stdout?: unknown;
      readonly stderr?: unknown;
    }
  | { readonly kind: "output-inspection"; readonly content?: unknown }
  | { readonly kind: "plan" }
  | { readonly kind: "replan" }
  | { readonly kind: "recovery" }
  | { readonly kind: "verification" }
  | { readonly kind: "compaction" }
  | { readonly kind: "stop"; readonly reason: StopReason | string };

export interface RawTrajectory {
  readonly events: readonly RawTrajectoryEvent[];
  readonly elapsedMs: number;
  readonly planningTokens: number;
  readonly actionTokens: number;
  readonly totalTokens: number;
}

export interface BehaviorSummary {
  readonly schemaVersion: "behavior-summary-v1";
  readonly invocationInvalidity: RatioBucket;
  readonly nonzeroExitFrequency: RatioBucket;
  readonly retryFrequency: CountBucket;
  readonly repeatedActionFrequency: CountBucket;
  readonly inspectedAfterNonzeroExit: RatioBucket;
  readonly recoveryAfterFailure: boolean;
  readonly replanAfterFailure: boolean;
  readonly verificationPerformed: boolean;
  readonly planBeforeFirstExecution: boolean;
  readonly compactionFrequency: CountBucket;
  readonly stopReason: StopReason;
  readonly prematureTermination: boolean;
  readonly durationBucket: DurationBucket;
  readonly planningShareBucket: RatioBucket;
  readonly actionShareBucket: RatioBucket;
  readonly ordering:
    | "read-before-write"
    | "write-before-read"
    | "execute-first"
    | "no-stateful-action"
    | "mixed";
  readonly toolUse: Readonly<Record<GenericToolCategory, CountBucket>>;
}

export type { NormalizedGraderOutcome } from "../schemas/trusted.js";

export type InfrastructureInvalidClass = NonNullable<
  NormalizedGraderOutcome["infrastructureInvalidClass"]
>;

export interface ScalarGraderOutcomeInput {
  readonly passed: boolean;
  readonly boundedReward: number;
  readonly infrastructureInvalidClass: InfrastructureInvalidClass | null;
  readonly integrityStatus: NormalizedGraderOutcome["integrityStatus"];
  readonly elapsedMs: number;
  readonly cpuUtilizationPercent: number | null;
  readonly maxRssMb: number | null;
  readonly protocolHash: string;
  readonly environmentFingerprintHash: string;
  readonly oneUseAttemptDigest: string;
}

export interface NormalizedGraderOutcomeContext {
  readonly createdAt: string;
  readonly rawManifestHash: string;
}

const TOOL_CATEGORIES = [
  "read",
  "write",
  "execute",
  "search",
  "plan",
  "inspect",
  "network",
  "other",
] as const;
const STOP_REASONS = ["completed", "agent-stop", "timeout", "budget", "error", "unknown"] as const;
const INFRASTRUCTURE_CLASSES = [
  "provider-capacity",
  "provider-timeout",
  "sandbox-startup",
  "image",
  "network",
  "evaluator",
  "unknown",
] as const;
const NORMALIZER_KEYS = new Set([
  "passed",
  "boundedReward",
  "infrastructureInvalidClass",
  "integrityStatus",
  "elapsedMs",
  "cpuUtilizationPercent",
  "maxRssMb",
  "protocolHash",
  "environmentFingerprintHash",
  "oneUseAttemptDigest",
]);

/**
 * Only enum membership, order, counts, and within-trajectory equality survive.
 * Commands, arguments, paths, output, URLs, names, and fingerprints are never
 * copied into the returned object.
 */
export function extractBehaviorSummary(trajectory: RawTrajectory): BehaviorSummary {
  validateTrajectoryCounters(trajectory);
  const toolCounts = Object.fromEntries(TOOL_CATEGORIES.map((category) => [category, 0])) as Record<
    GenericToolCategory,
    number
  >;
  let invalidCalls = 0;
  let totalCalls = 0;
  let nonzeroResults = 0;
  let inspectedNonzeroResults = 0;
  let pendingNonzero = false;
  let retries = 0;
  let repeatedActions = 0;
  let lastActionFingerprint: string | null = null;
  let sawRecoveryAfterFailure = false;
  let sawReplanAfterFailure = false;
  let sawVerification = false;
  let sawPlan = false;
  let planBeforeFirstExecution = false;
  let sawExecution = false;
  let compactions = 0;
  let stopReason: StopReason = "unknown";
  const statefulOrder: GenericToolCategory[] = [];

  for (const event of trajectory.events) {
    switch (event.kind) {
      case "tool-call": {
        if (pendingNonzero) {
          pendingNonzero = false;
        }
        const category = normalizeToolCategory(event.category);
        toolCounts[category] += 1;
        totalCalls += 1;
        if (!event.invocationValid) {
          invalidCalls += 1;
        }
        if (category === "execute") {
          if (!sawExecution) {
            planBeforeFirstExecution = sawPlan;
          }
          sawExecution = true;
        }
        if (category === "read" || category === "write" || category === "execute") {
          statefulOrder.push(category);
        }
        if (event.actionFingerprint !== undefined) {
          if (event.actionFingerprint === lastActionFingerprint) {
            repeatedActions += 1;
            retries += 1;
          }
          lastActionFingerprint = event.actionFingerprint;
        } else {
          lastActionFingerprint = null;
        }
        break;
      }
      case "tool-result": {
        const exitClass = classifyExitStatus(event.exitCode, event.terminatedBySignal === true);
        if (exitClass === "nonzero" || exitClass === "signal") {
          nonzeroResults += 1;
          pendingNonzero = true;
        }
        break;
      }
      case "output-inspection":
        if (pendingNonzero) {
          inspectedNonzeroResults += 1;
          pendingNonzero = false;
        }
        break;
      case "plan":
        sawPlan = true;
        break;
      case "replan":
        if (nonzeroResults > 0) {
          sawReplanAfterFailure = true;
        }
        break;
      case "recovery":
        if (nonzeroResults > 0) {
          sawRecoveryAfterFailure = true;
        }
        break;
      case "verification":
        sawVerification = true;
        break;
      case "compaction":
        compactions += 1;
        break;
      case "stop":
        stopReason = normalizeStopReason(event.reason);
        break;
    }
  }

  const tokenDenominator = Math.max(trajectory.totalTokens, 1);
  return {
    schemaVersion: "behavior-summary-v1",
    invocationInvalidity: ratioBucket(invalidCalls, totalCalls),
    nonzeroExitFrequency: ratioBucket(nonzeroResults, totalCalls),
    retryFrequency: countBucket(retries),
    repeatedActionFrequency: countBucket(repeatedActions),
    inspectedAfterNonzeroExit: ratioBucket(inspectedNonzeroResults, nonzeroResults),
    recoveryAfterFailure: sawRecoveryAfterFailure,
    replanAfterFailure: sawReplanAfterFailure,
    verificationPerformed: sawVerification,
    planBeforeFirstExecution,
    compactionFrequency: countBucket(compactions),
    stopReason,
    prematureTermination:
      stopReason === "timeout" || stopReason === "budget" || stopReason === "error",
    durationBucket: durationBucket(trajectory.elapsedMs),
    planningShareBucket: ratioBucket(trajectory.planningTokens, tokenDenominator),
    actionShareBucket: ratioBucket(trajectory.actionTokens, tokenDenominator),
    ordering: summarizeOrdering(statefulOrder),
    toolUse: Object.fromEntries(
      TOOL_CATEGORIES.map((category) => [category, countBucket(toolCounts[category])]),
    ) as Readonly<Record<GenericToolCategory, CountBucket>>,
  };
}

/**
 * The adapter must first reduce raw grader output to this exact scalar record.
 * Any grader prose or extra field makes normalization fail closed.
 */
export function normalizeGraderOutcome(
  input: unknown,
  context: NormalizedGraderOutcomeContext,
): NormalizedGraderOutcome {
  if (!isRecord(input)) {
    throw new Error("Grader normalization input must be an object");
  }
  const unknownKeys = Object.keys(input).filter((key) => !NORMALIZER_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error("Grader normalization rejects non-allowlisted fields");
  }
  if (
    !isRecord(context) ||
    Object.keys(context).length !== 2 ||
    !Object.hasOwn(context, "createdAt") ||
    !Object.hasOwn(context, "rawManifestHash")
  ) {
    throw new Error("Grader normalization context must contain exactly its canonical fields");
  }
  const passed = requireBoolean(input["passed"], "passed");
  const boundedReward = requireNumber(input["boundedReward"], "boundedReward");
  if (boundedReward < 0 || boundedReward > 1) {
    throw new Error("Grader reward must be inside the closed unit interval");
  }
  const invalidClass = input["infrastructureInvalidClass"];
  if (
    invalidClass !== null &&
    (typeof invalidClass !== "string" ||
      !INFRASTRUCTURE_CLASSES.includes(invalidClass as (typeof INFRASTRUCTURE_CLASSES)[number]))
  ) {
    throw new Error("Invalid broad infrastructure class");
  }
  const infrastructureInvalidClass =
    invalidClass as NormalizedGraderOutcome["infrastructureInvalidClass"];
  const integrityStatus = input["integrityStatus"];
  if (
    integrityStatus !== "passed" &&
    integrityStatus !== "failed" &&
    integrityStatus !== "not-run"
  ) {
    throw new Error("Invalid integrity status");
  }
  if (
    (infrastructureInvalidClass !== null && (passed || boundedReward !== 0)) ||
    (passed && boundedReward !== 1) ||
    (!passed && boundedReward === 1) ||
    (integrityStatus === "failed" && passed)
  ) {
    throw new Error("Grader pass, reward, integrity, and infrastructure fields conflict");
  }
  const elapsedMs = requireNumber(input["elapsedMs"], "elapsedMs");
  const cpuUtilizationPercent = requireNullableNumber(
    input["cpuUtilizationPercent"],
    "cpuUtilizationPercent",
  );
  const maxRssMb = requireNullableNumber(input["maxRssMb"], "maxRssMb");
  if (
    elapsedMs < 0 ||
    (cpuUtilizationPercent !== null &&
      (cpuUtilizationPercent < 0 || cpuUtilizationPercent > 100)) ||
    (maxRssMb !== null && maxRssMb < 0)
  ) {
    throw new Error("Grader timing and resource scalars must be finite and non-negative");
  }
  const protocolHash = requireDigest(input["protocolHash"], "protocolHash");
  const environmentFingerprintHash = requireDigest(
    input["environmentFingerprintHash"],
    "environmentFingerprintHash",
  );
  const oneUseAttemptDigest = requireDigest(input["oneUseAttemptDigest"], "oneUseAttemptDigest");
  const createdAt = requireCanonicalTimestamp(context.createdAt, "createdAt");
  const rawManifestHash = requireDigest(context.rawManifestHash, "rawManifestHash");
  const safeCore = {
    outcome: infrastructureInvalidClass === null ? (passed ? "pass" : "fail") : "invalid",
    boundedReward,
    infrastructureInvalidClass,
    integrityStatus,
    elapsedTimeBucket: graderDurationBucket(elapsedMs),
    cpuBucket: cpuResourceBucket(cpuUtilizationPercent),
    memoryBucket: memoryResourceBucket(maxRssMb),
    protocolHash,
    environmentFingerprintHash,
    oneUseAttemptDigest,
  } as const;
  const derivationHash = canonicalHash({
    domain: "dark-factory.normalized-grader-outcome.v1",
    outcome: safeCore,
  });
  const normalized = withContentHash({
    schemaVersion: "1.0.0" as const,
    createdAt,
    provenanceRefs: [
      {
        artifactName: "raw-manifest",
        contentHash: rawManifestHash,
      },
    ],
    ...safeCore,
    derivationHash,
  });
  assertValidDocument("normalizedGraderOutcome", normalized);
  return normalized;
}

export function classifyExitStatus(
  exitCode: number | null | undefined,
  terminatedBySignal: boolean,
): ExitStatusClass {
  if (terminatedBySignal) {
    return "signal";
  }
  if (exitCode === undefined || exitCode === null || !Number.isSafeInteger(exitCode)) {
    return "unknown";
  }
  return exitCode === 0 ? "zero" : "nonzero";
}

function normalizeToolCategory(category: string): GenericToolCategory {
  return TOOL_CATEGORIES.includes(category as GenericToolCategory)
    ? (category as GenericToolCategory)
    : "other";
}

function normalizeStopReason(reason: string): StopReason {
  return STOP_REASONS.includes(reason as StopReason) ? (reason as StopReason) : "unknown";
}

function countBucket(count: number): CountBucket {
  return count === 0 ? "none" : count === 1 ? "one" : count <= 3 ? "two-three" : "four-plus";
}

function ratioBucket(numerator: number, denominator: number): RatioBucket {
  if (numerator <= 0 || denominator <= 0) {
    return "none";
  }
  const ratio = Math.min(1, numerator / denominator);
  return ratio === 1 ? "all" : ratio < 0.34 ? "low" : ratio < 0.67 ? "medium" : "high";
}

function durationBucket(elapsedMs: number): DurationBucket {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error("Elapsed time must be finite and non-negative");
  }
  return elapsedMs < 60_000
    ? "under-1m"
    : elapsedMs < 300_000
      ? "1-5m"
      : elapsedMs < 900_000
        ? "5-15m"
        : "15m-plus";
}

function graderDurationBucket(elapsedMs: number): NormalizedGraderOutcome["elapsedTimeBucket"] {
  return elapsedMs < 60_000
    ? "under-1m"
    : elapsedMs < 300_000
      ? "1-5m"
      : elapsedMs < 900_000
        ? "5-15m"
        : elapsedMs < 1_800_000
          ? "15-30m"
          : "30m-plus";
}

function cpuResourceBucket(
  utilizationPercent: number | null,
): NormalizedGraderOutcome["cpuBucket"] {
  if (utilizationPercent === null) {
    return "unknown";
  }
  return utilizationPercent < 35 ? "low" : utilizationPercent < 70 ? "medium" : "high";
}

function memoryResourceBucket(maxRssMb: number | null): NormalizedGraderOutcome["memoryBucket"] {
  if (maxRssMb === null) {
    return "unknown";
  }
  return maxRssMb < 512 ? "low" : maxRssMb < 2_048 ? "medium" : "high";
}

function summarizeOrdering(ordering: readonly GenericToolCategory[]): BehaviorSummary["ordering"] {
  const firstRead = ordering.indexOf("read");
  const firstWrite = ordering.indexOf("write");
  const firstExecute = ordering.indexOf("execute");
  if (firstRead === -1 && firstWrite === -1 && firstExecute === -1) {
    return "no-stateful-action";
  }
  if (firstExecute === 0) {
    return "execute-first";
  }
  if (firstRead >= 0 && firstWrite >= 0) {
    return firstRead < firstWrite ? "read-before-write" : "write-before-read";
  }
  return "mixed";
}

function validateTrajectoryCounters(trajectory: RawTrajectory): void {
  for (const value of [
    trajectory.elapsedMs,
    trajectory.planningTokens,
    trajectory.actionTokens,
    trajectory.totalTokens,
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Trajectory counters must be finite and non-negative");
    }
  }
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be boolean`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function requireNullableNumber(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }
  return requireNumber(value, label);
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireCanonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
