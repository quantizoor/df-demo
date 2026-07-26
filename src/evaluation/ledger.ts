import type {
  EvaluationStage,
  GateDisposition,
  HiddenPanelId,
  HiddenTaskId,
  HiddenTaskLedgerEntry,
} from "./types.js";

export type HiddenPanelStatus =
  | "sealed"
  | "started"
  | "decided"
  | "returned-unstarted"
  | "quarantined";

export interface HiddenPanelLedgerEntry {
  readonly panelId: HiddenPanelId;
  readonly stage: EvaluationStage;
  readonly taskIds: readonly HiddenTaskId[];
  readonly frozenHypothesisDigest: string;
  readonly frozenCandidateDigest: string;
  readonly status: HiddenPanelStatus;
  readonly anyArmStarted: boolean;
  readonly feedbackConsumed: boolean;
  readonly disposition: GateDisposition | null;
  readonly repairAttemptsUsed: number;
  readonly repairClosed: boolean;
  readonly repairCooldownThroughExperiment: number | null;
  readonly sealedAt: string;
}

export interface ReleaseSafePanelLedgerAttestation {
  readonly stage: EvaluationStage;
  readonly status: HiddenPanelStatus;
  readonly taskCount: number;
  readonly feedbackConsumed: boolean;
  readonly disposition: GateDisposition | null;
  readonly cooldownApplied: boolean;
  readonly containsPanelHandle: false;
  readonly containsTaskIdentifiers: false;
}

export interface HiddenShadowLedger {
  readonly reservedSlices: 2;
  readonly consumedSlices: number;
  readonly attemptedActiveCommitDigests: readonly string[];
}

export interface ReleaseSafeShadowCapacity {
  readonly reservedSliceCount: 2;
  readonly remainingSliceCount: 0 | 1 | 2;
  readonly certificationPaused: boolean;
  readonly containsCommitIdentifiers: false;
  readonly containsTaskIdentifiers: false;
}

export function createHiddenPanelLedgerEntry(input: {
  readonly panelId: HiddenPanelId;
  readonly stage: EvaluationStage;
  readonly taskIds: readonly HiddenTaskId[];
  readonly frozenHypothesisDigest: string;
  readonly frozenCandidateDigest: string;
  readonly sealedAt: string;
}): HiddenPanelLedgerEntry {
  if (input.taskIds.length === 0 || new Set(input.taskIds).size !== input.taskIds.length) {
    throw new Error("A hidden panel must contain unique tasks");
  }
  if (!Number.isFinite(Date.parse(input.sealedAt))) {
    throw new Error("Panel seal timestamp must be valid");
  }
  if (input.frozenHypothesisDigest.length === 0 || input.frozenCandidateDigest.length === 0) {
    throw new Error("A panel requires frozen hypothesis and candidate digests");
  }
  return {
    ...input,
    status: "sealed",
    anyArmStarted: false,
    feedbackConsumed: false,
    disposition: null,
    repairAttemptsUsed: 0,
    repairClosed: false,
    repairCooldownThroughExperiment: null,
  };
}

export function createHiddenShadowLedger(): HiddenShadowLedger {
  return {
    reservedSlices: 2,
    consumedSlices: 0,
    attemptedActiveCommitDigests: [],
  };
}

/**
 * Claims a shadow slice before any arm starts. Claims are never rolled back,
 * so abandonment cannot become a selection/retry channel.
 */
export function claimShadowCertification(
  ledger: HiddenShadowLedger,
  activeCommitDigest: string,
): HiddenShadowLedger {
  validateShadowLedger(ledger);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(activeCommitDigest)) {
    throw new Error("Shadow certification requires a commit digest");
  }
  if (ledger.consumedSlices >= ledger.reservedSlices) {
    throw new Error("All feedback-dark shadow slices are consumed");
  }
  if (ledger.attemptedActiveCommitDigests.includes(activeCommitDigest)) {
    throw new Error("An active commit receives at most one certification attempt");
  }
  return {
    ...ledger,
    consumedSlices: ledger.consumedSlices + 1,
    attemptedActiveCommitDigests: [...ledger.attemptedActiveCommitDigests, activeCommitDigest],
  };
}

export function releaseSafeShadowCapacity(ledger: HiddenShadowLedger): ReleaseSafeShadowCapacity {
  validateShadowLedger(ledger);
  const remaining = ledger.reservedSlices - ledger.consumedSlices;
  if (remaining !== 0 && remaining !== 1 && remaining !== 2) {
    throw new Error("Invalid shadow capacity");
  }
  return {
    reservedSliceCount: 2,
    remainingSliceCount: remaining,
    certificationPaused: remaining === 0,
    containsCommitIdentifiers: false,
    containsTaskIdentifiers: false,
  };
}

export function markPanelArmStarted(panel: HiddenPanelLedgerEntry): HiddenPanelLedgerEntry {
  if (panel.status !== "sealed" && panel.status !== "started") {
    throw new Error(`Cannot start an arm for a panel in ${panel.status}`);
  }
  return { ...panel, status: "started", anyArmStarted: true };
}

/**
 * Every decided validation or shadow panel is consumed regardless of outcome.
 * A repair result is also feedback-consumed, but never positive promotion
 * evidence.
 */
export function decidePanel(
  panel: HiddenPanelLedgerEntry,
  disposition: GateDisposition,
): HiddenPanelLedgerEntry {
  if (panel.status !== "started") {
    throw new Error("Only a started panel can be decided");
  }
  validateDispositionForStage(panel.stage, disposition);
  return {
    ...panel,
    status: "decided",
    feedbackConsumed: true,
    disposition,
  };
}

/**
 * A never-started sealed panel can return to eligibility. Once any arm has
 * started, abandonment quarantines and consumes it.
 */
export function abandonPanel(panel: HiddenPanelLedgerEntry): HiddenPanelLedgerEntry {
  if (panel.status === "sealed" && !panel.anyArmStarted) {
    return { ...panel, status: "returned-unstarted" };
  }
  if (panel.status === "started" || panel.anyArmStarted) {
    return {
      ...panel,
      status: "quarantined",
      feedbackConsumed: true,
      disposition: "inconclusive",
    };
  }
  throw new Error(`Cannot abandon a panel in ${panel.status}`);
}

/**
 * Claims one of the two candidate commits that may use a discovery panel.
 * Advancement or the second claim starts an exact three-sealed-experiment
 * cooldown. If experiment E closes the panel, E+1..E+3 are unavailable.
 */
export function recordRepairAttempt(
  panel: HiddenPanelLedgerEntry,
  sealedExperimentOrdinal: number,
  advancedToChallenger: boolean,
): HiddenPanelLedgerEntry {
  if (
    panel.stage !== "repair" ||
    panel.status !== "decided" ||
    !panel.feedbackConsumed ||
    !Number.isSafeInteger(sealedExperimentOrdinal) ||
    sealedExperimentOrdinal < 0
  ) {
    throw new Error("Repair attempt accounting requires a decided repair panel");
  }
  if (panel.repairAttemptsUsed >= 2) {
    throw new Error("A discovery panel cannot support more than two candidate commits");
  }
  const repairAttemptsUsed = panel.repairAttemptsUsed + 1;
  const closesPanel = advancedToChallenger || repairAttemptsUsed === 2;
  return {
    ...panel,
    repairAttemptsUsed,
    repairClosed: closesPanel,
    repairCooldownThroughExperiment: closesPanel ? sealedExperimentOrdinal + 3 : null,
  };
}

/**
 * Re-seals the exact same hidden discovery cohort for the one permitted
 * follow-up candidate. No task selection occurs here: panelId and taskIds are
 * preserved byte-for-byte while the new frozen hypothesis/candidate bindings
 * replace the prior bindings.
 */
export function claimRepairRevision(
  panel: HiddenPanelLedgerEntry,
  input: {
    readonly currentExperimentOrdinal: number;
    readonly frozenHypothesisDigest: string;
    readonly frozenCandidateDigest: string;
    readonly sealedAt: string;
  },
): HiddenPanelLedgerEntry {
  if (
    !Number.isSafeInteger(input.currentExperimentOrdinal) ||
    input.currentExperimentOrdinal < 0 ||
    !repairPanelCanBeClaimed(panel, input.currentExperimentOrdinal)
  ) {
    throw new Error("Repair discovery cohort is not eligible for a revision");
  }
  if (
    input.frozenHypothesisDigest.length === 0 ||
    input.frozenCandidateDigest.length === 0 ||
    input.frozenCandidateDigest === panel.frozenCandidateDigest ||
    !Number.isFinite(Date.parse(input.sealedAt)) ||
    Date.parse(input.sealedAt) < Date.parse(panel.sealedAt)
  ) {
    throw new Error("Repair revision requires a new frozen candidate and valid seal");
  }
  return {
    ...panel,
    frozenHypothesisDigest: input.frozenHypothesisDigest,
    frozenCandidateDigest: input.frozenCandidateDigest,
    status: "sealed",
    anyArmStarted: false,
    feedbackConsumed: false,
    disposition: null,
    sealedAt: input.sealedAt,
  };
}

export function repairPanelCanBeClaimed(
  panel: HiddenPanelLedgerEntry,
  currentExperimentOrdinal: number,
): boolean {
  const cooldown = panel.repairCooldownThroughExperiment;
  return (
    panel.stage === "repair" &&
    panel.status === "decided" &&
    panel.feedbackConsumed &&
    !panel.repairClosed &&
    panel.repairAttemptsUsed < 2 &&
    (cooldown === null || currentExperimentOrdinal > cooldown)
  );
}

export function contributingRepairTasksClearCooldown(
  panel: HiddenPanelLedgerEntry,
  currentExperimentOrdinal: number,
): boolean {
  const cooldown = panel.repairCooldownThroughExperiment;
  return (
    panel.stage === "repair" &&
    panel.repairClosed &&
    cooldown !== null &&
    currentExperimentOrdinal > cooldown
  );
}

export function makeReleaseSafePanelLedgerAttestation(
  panel: HiddenPanelLedgerEntry,
): ReleaseSafePanelLedgerAttestation {
  return {
    stage: panel.stage,
    status: panel.status,
    taskCount: panel.taskIds.length,
    feedbackConsumed: panel.feedbackConsumed,
    disposition: panel.disposition,
    cooldownApplied: panel.repairCooldownThroughExperiment !== null,
    containsPanelHandle: false,
    containsTaskIdentifiers: false,
  };
}

export function applyConsumedPanelToTaskLedger(
  tasks: readonly HiddenTaskLedgerEntry[],
  panel: HiddenPanelLedgerEntry,
  sealedExperimentOrdinal: number,
): readonly HiddenTaskLedgerEntry[] {
  if (
    !panel.feedbackConsumed ||
    (panel.status !== "decided" && panel.status !== "quarantined") ||
    !Number.isSafeInteger(sealedExperimentOrdinal) ||
    sealedExperimentOrdinal < 0
  ) {
    throw new Error("Only consumed panels can update hidden task exposure");
  }
  const selected = new Set<string>(panel.taskIds);
  return tasks.map((task) => {
    if (!selected.has(task.taskId)) {
      return task;
    }
    const wasConsecutive =
      task.exposure.lastExperiment !== null &&
      task.exposure.lastExperiment === sealedExperimentOrdinal - 1;
    return {
      ...task,
      exposure: {
        ...task.exposure,
        total: task.exposure.total + 1,
        consecutiveExperiments: wasConsecutive ? task.exposure.consecutiveExperiments + 1 : 1,
        lastExperiment: sealedExperimentOrdinal,
        feedbackReleased: true,
        positiveValidationConsumed:
          task.exposure.positiveValidationConsumed ||
          panel.stage === "validation" ||
          panel.stage === "shadow",
        repairCooldownThroughExperiment:
          panel.repairCooldownThroughExperiment ?? task.exposure.repairCooldownThroughExperiment,
      },
    };
  });
}

export function linkReleasedEvidenceToHypothesis(
  tasks: readonly HiddenTaskLedgerEntry[],
  contributingTaskIds: readonly HiddenTaskId[],
  frozenHypothesisDigest: string,
): readonly HiddenTaskLedgerEntry[] {
  if (frozenHypothesisDigest.length === 0) {
    throw new Error("A frozen hypothesis digest is required");
  }
  const contributing = new Set<string>(contributingTaskIds);
  return tasks.map((task) =>
    contributing.has(task.taskId)
      ? {
          ...task,
          exposure: {
            ...task.exposure,
            informedHypothesisDigests: [
              ...new Set([...task.exposure.informedHypothesisDigests, frozenHypothesisDigest]),
            ],
          },
        }
      : task,
  );
}

function validateDispositionForStage(stage: EvaluationStage, disposition: GateDisposition): void {
  const allowed: Readonly<Record<EvaluationStage, readonly GateDisposition[]>> = {
    repair: ["pass", "fail", "inconclusive"],
    validation: ["promote", "reject", "inconclusive"],
    shadow: ["pass", "fail", "inconclusive"],
  };
  if (!allowed[stage].includes(disposition)) {
    throw new Error(`Disposition ${disposition} is invalid for ${stage}`);
  }
}

function validateShadowLedger(ledger: HiddenShadowLedger): void {
  if (
    ledger.reservedSlices !== 2 ||
    !Number.isSafeInteger(ledger.consumedSlices) ||
    ledger.consumedSlices < 0 ||
    ledger.consumedSlices > 2 ||
    new Set(ledger.attemptedActiveCommitDigests).size !==
      ledger.attemptedActiveCommitDigests.length ||
    ledger.attemptedActiveCommitDigests.length !== ledger.consumedSlices
  ) {
    throw new Error("Invalid hidden shadow ledger");
  }
}
