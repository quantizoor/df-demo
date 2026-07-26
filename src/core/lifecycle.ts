import type {
  ChampionPointers,
  ExperimentKind,
  ExperimentState,
} from "../domain/models.js";
import { DarkFactoryError } from "./errors.js";

const OPTIMIZATION_TRANSITIONS: Readonly<Record<ExperimentState, readonly ExperimentState[]>> = {
  planned: ["candidate-ready"],
  "candidate-ready": ["gates-passed", "rejected"],
  "gates-passed": ["repair-evaluating", "validation-evaluating"],
  "repair-evaluating": ["challenger", "rejected", "inconclusive"],
  challenger: ["validation-evaluating"],
  "validation-evaluating": ["analyzed", "inconclusive"],
  analyzed: ["promoted", "rejected", "inconclusive"],
  promoted: ["sealed"],
  rejected: ["sealed"],
  inconclusive: ["sealed"],
  "shadow-evaluating": [],
  certified: [],
  "not-certified": [],
  sealed: [],
};

const SHADOW_TRANSITIONS: Readonly<Record<ExperimentState, readonly ExperimentState[]>> = {
  ...OPTIMIZATION_TRANSITIONS,
  planned: ["shadow-evaluating"],
  "shadow-evaluating": ["certified", "not-certified", "inconclusive"],
  certified: ["sealed"],
  "not-certified": ["sealed"],
};

const BASELINE_TRANSITIONS: Readonly<Record<ExperimentState, readonly ExperimentState[]>> = {
  ...OPTIMIZATION_TRANSITIONS,
  planned: ["gates-passed"],
  "gates-passed": ["analyzed"],
  analyzed: ["sealed"],
};

export function allowedTransitions(
  kind: ExperimentKind,
  state: ExperimentState,
): readonly ExperimentState[] {
  if (kind === "shadow") {
    return SHADOW_TRANSITIONS[state];
  }
  if (kind === "baseline") {
    return BASELINE_TRANSITIONS[state];
  }
  return OPTIMIZATION_TRANSITIONS[state];
}

export function transitionExperiment(
  kind: ExperimentKind,
  current: ExperimentState,
  next: ExperimentState,
): ExperimentState {
  if (!allowedTransitions(kind, current).includes(next)) {
    throw new DarkFactoryError(
      "INVALID_TRANSITION",
      `Cannot transition ${kind} experiment from ${current} to ${next}`,
      { kind, current, next },
    );
  }
  return next;
}

export interface PointerTransition {
  readonly experimentNumber: number;
  readonly commit: string;
  readonly state: ExperimentState;
  readonly sealedAt: string;
  readonly sealHash: string;
}

function assertSha(value: string): void {
  if (!/^[a-f0-9]{40,64}$/u.test(value)) {
    throw new DarkFactoryError("EVIDENCE_INVALID", "Champion commit is not a Git object id", {
      valueLength: value.length,
    });
  }
}

export function updateChampionPointers(
  current: ChampionPointers,
  transition: PointerTransition,
): ChampionPointers {
  assertSha(transition.commit);
  if (transition.state === "promoted") {
    if (transition.experimentNumber <= current.activeExperiment) {
      throw new DarkFactoryError(
        "INVALID_TRANSITION",
        "Active champion experiments must increase monotonically",
      );
    }
    return {
      ...current,
      activeExperiment: transition.experimentNumber,
      activeCommit: transition.commit,
      updatedAt: transition.sealedAt,
      sourceSealHash: transition.sealHash,
    };
  }

  if (transition.state === "certified") {
    if (
      transition.commit !== current.activeCommit ||
      transition.experimentNumber !== current.activeExperiment
    ) {
      throw new DarkFactoryError(
        "INVALID_TRANSITION",
        "Only the current active champion can become certified",
      );
    }
    return {
      ...current,
      certifiedExperiment: transition.experimentNumber,
      certifiedCommit: transition.commit,
      updatedAt: transition.sealedAt,
      sourceSealHash: transition.sealHash,
    };
  }

  throw new DarkFactoryError(
    "INVALID_TRANSITION",
    "Rejected, inconclusive, and non-certified states cannot move champion pointers",
    { state: transition.state },
  );
}

export function parseExperimentDirectory(name: string): { number: number; slug: string } | null {
  const match = /^(?<number>\d{3,})-(?<slug>[a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(name);
  if (!match?.groups) {
    return null;
  }
  const number = Number.parseInt(match.groups.number ?? "", 10);
  const slug = match.groups.slug ?? "";
  return Number.isSafeInteger(number) ? { number, slug } : null;
}

export function nextExperimentNumber(directoryNames: readonly string[]): number {
  const numbers = directoryNames
    .map(parseExperimentDirectory)
    .filter((entry): entry is { number: number; slug: string } => entry !== null)
    .map((entry) => entry.number);
  return numbers.length === 0 ? 0 : Math.max(...numbers) + 1;
}

export class RepairAttemptLedger {
  readonly #attempts = new Map<string, Set<string>>();

  public record(panelAttestationHash: string, candidateCommit: string): number {
    assertSha(candidateCommit);
    const commits = this.#attempts.get(panelAttestationHash) ?? new Set<string>();
    if (!commits.has(candidateCommit) && commits.size >= 2) {
      throw new DarkFactoryError(
        "INVALID_TRANSITION",
        "A discovery panel cannot support more than two candidate commits",
        { panelAttestationHash },
      );
    }
    commits.add(candidateCommit);
    this.#attempts.set(panelAttestationHash, commits);
    return commits.size;
  }

  public count(panelAttestationHash: string): number {
    return this.#attempts.get(panelAttestationHash)?.size ?? 0;
  }

  public snapshot(): Readonly<Record<string, readonly string[]>> {
    return Object.fromEntries(
      [...this.#attempts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([panel, commits]) => [panel, [...commits].sort()]),
    );
  }
}

