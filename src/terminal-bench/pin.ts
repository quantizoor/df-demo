import { canonicalHash } from "../schemas/canonical.js";

export const TERMINAL_BENCH_21_DATASET = "terminal-bench/terminal-bench-2-1" as const;
export const TERMINAL_BENCH_21_TASK_COUNT = 89 as const;

export interface TerminalBench21Pin {
  readonly benchmark: "terminal-bench-2.1";
  readonly dataset: typeof TERMINAL_BENCH_21_DATASET;
  readonly registryRevision: number;
  readonly taskCount: typeof TERMINAL_BENCH_21_TASK_COUNT;
  readonly datasetContentSha256: string;
  readonly datasetManifestSha256: string;
  readonly harborVersion: string;
  readonly harborPackageSha256: string;
  readonly harborExecutableSha256: string;
  readonly piHarborAdapterSha256: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export class TerminalBenchPinError extends Error {
  override readonly name = "TerminalBenchPinError";
}

export function assertTerminalBench21Pin(
  pin: TerminalBench21Pin,
): asserts pin is TerminalBench21Pin {
  const exactKeys = [
    "benchmark",
    "dataset",
    "registryRevision",
    "taskCount",
    "datasetContentSha256",
    "datasetManifestSha256",
    "harborVersion",
    "harborPackageSha256",
    "harborExecutableSha256",
    "piHarborAdapterSha256",
  ];
  const unexpected = Object.keys(pin).filter((key) => !exactKeys.includes(key));
  if (unexpected.length > 0) {
    throw new TerminalBenchPinError(
      `Terminal-Bench pin contains unsupported fields: ${unexpected.join(", ")}.`,
    );
  }
  if (
    pin.benchmark !== "terminal-bench-2.1" ||
    pin.dataset !== TERMINAL_BENCH_21_DATASET ||
    pin.taskCount !== TERMINAL_BENCH_21_TASK_COUNT
  ) {
    throw new TerminalBenchPinError(
      "The evaluator accepts exactly Terminal-Bench 2.1 and its 89-task registry.",
    );
  }
  if (!Number.isSafeInteger(pin.registryRevision) || pin.registryRevision <= 0) {
    throw new TerminalBenchPinError(
      "Terminal-Bench registry revision must be an explicit positive integer.",
    );
  }
  if (!EXACT_SEMVER.test(pin.harborVersion)) {
    throw new TerminalBenchPinError(
      "Harbor must use one exact semantic version; aliases and ranges are forbidden.",
    );
  }
  for (const [label, digest] of [
    ["dataset content", pin.datasetContentSha256],
    ["dataset manifest", pin.datasetManifestSha256],
    ["Harbor package", pin.harborPackageSha256],
    ["Harbor executable", pin.harborExecutableSha256],
    ["Pi Harbor adapter", pin.piHarborAdapterSha256],
  ] as const) {
    if (!SHA256.test(digest)) {
      throw new TerminalBenchPinError(`${label} must be pinned by lowercase SHA-256.`);
    }
  }
}

export function hashTerminalBench21Pin(pin: TerminalBench21Pin): string {
  assertTerminalBench21Pin(pin);
  return canonicalHash(pin);
}
