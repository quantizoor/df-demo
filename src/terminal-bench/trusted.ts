import type { HarnessArtifactReference } from "../evaluator/contracts.js";
import type { HiddenTaskId } from "../evaluation/types.js";

export type TrustedEvaluationStage = "repair" | "validation" | "shadow";
export type MatchedArmKind = "candidate" | "champion";
export type MatchedArmOrder = "AB" | "BA";

export interface TrustedHiddenTaskCell {
  readonly sensitivity: "hidden-benchmark-cell";
  readonly taskId: HiddenTaskId;
  readonly taskRevisionDigest: string;
  readonly capabilityStratum: string;
  readonly replicateOrdinal: number;
  readonly order: MatchedArmOrder;
}

export interface TrustedMatchedPanel {
  readonly sensitivity: "hidden-benchmark-panel";
  readonly leaseId: string;
  readonly requestId: string;
  readonly stage: TrustedEvaluationStage;
  readonly sealedAt: string;
  readonly expiresAt: string;
  readonly dispositionAttestationHash: string;
  readonly cells: readonly TrustedHiddenTaskCell[];
}

export interface TrustedMatchedArm {
  readonly sensitivity: "hidden-benchmark-arm";
  readonly armId: string;
  readonly cellOrdinal: number;
  readonly arm: MatchedArmKind;
  readonly order: MatchedArmOrder;
  readonly taskId: HiddenTaskId;
  readonly taskRevisionDigest: string;
  readonly capabilityStratum: string;
  readonly replicateOrdinal: number;
  readonly harness: HarnessArtifactReference;
}

export interface TrustedMatchedArmSchedule {
  readonly sensitivity: "hidden-benchmark-schedule";
  readonly requestId: string;
  readonly stage: TrustedEvaluationStage;
  readonly executionPolicy: "candidate-only-repair" | "fresh-matched-pairs";
  readonly cellCount: number;
  readonly armCount: number;
  readonly candidateArmCount: number;
  readonly championArmCount: number;
  readonly candidateFirstCount: number;
  readonly championFirstCount: number;
  readonly arms: readonly TrustedMatchedArm[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export class TrustedPanelError extends Error {
  override readonly name = "TrustedPanelError";
}

function expectedCellCount(stage: TrustedEvaluationStage): number {
  return stage === "repair" ? 5 : 12;
}

export function assertTrustedMatchedPanel(
  panel: TrustedMatchedPanel,
): asserts panel is TrustedMatchedPanel {
  const sealedAt = Date.parse(panel.sealedAt);
  const expiresAt = Date.parse(panel.expiresAt);
  if (
    panel.sensitivity !== "hidden-benchmark-panel" ||
    !SAFE_ID.test(panel.leaseId) ||
    !SAFE_ID.test(panel.requestId) ||
    !SHA256.test(panel.dispositionAttestationHash) ||
    !Number.isFinite(sealedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= sealedAt ||
    panel.cells.length !== expectedCellCount(panel.stage)
  ) {
    throw new TrustedPanelError("Hidden panel lease is malformed or has the wrong size.");
  }

  const cellKeys = new Set<string>();
  const taskIds = new Set<HiddenTaskId>();
  let candidateFirst = 0;
  let championFirst = 0;
  for (const cell of panel.cells) {
    if (
      cell.sensitivity !== "hidden-benchmark-cell" ||
      !SHA256.test(cell.taskId) ||
      !SHA256.test(cell.taskRevisionDigest) ||
      !SAFE_ID.test(cell.capabilityStratum) ||
      !Number.isSafeInteger(cell.replicateOrdinal) ||
      cell.replicateOrdinal <= 0 ||
      (cell.order !== "AB" && cell.order !== "BA")
    ) {
      throw new TrustedPanelError("A hidden task cell is malformed.");
    }
    const key = `${cell.taskId}:${cell.taskRevisionDigest}:${cell.replicateOrdinal}`;
    if (cellKeys.has(key) || taskIds.has(cell.taskId)) {
      throw new TrustedPanelError(
        "A hidden task or task/replicate cell cannot be duplicated within a panel.",
      );
    }
    cellKeys.add(key);
    taskIds.add(cell.taskId);
    if (cell.order === "AB") candidateFirst += 1;
    else championFirst += 1;
  }
  if (
    panel.stage !== "repair" &&
    (candidateFirst !== 6 || championFirst !== 6)
  ) {
    throw new TrustedPanelError(
      "Fresh matched panels require exactly six candidate-first and six champion-first cells.",
    );
  }
}

export function createTrustedMatchedArmSchedule(
  panel: TrustedMatchedPanel,
  candidate: HarnessArtifactReference,
  champion: HarnessArtifactReference,
): TrustedMatchedArmSchedule {
  assertTrustedMatchedPanel(panel);
  if (candidate.commitSha === champion.commitSha || candidate.treeSha === champion.treeSha) {
    throw new TrustedPanelError("Candidate and champion must be distinct immutable harnesses.");
  }
  const arms: TrustedMatchedArm[] = [];
  let candidateFirstCount = 0;
  let championFirstCount = 0;
  for (const [cellOrdinal, cell] of panel.cells.entries()) {
    if (panel.stage === "repair") {
      arms.push({
        sensitivity: "hidden-benchmark-arm",
        armId: `${panel.requestId}-cell-${String(cellOrdinal + 1).padStart(2, "0")}-candidate`,
        cellOrdinal,
        arm: "candidate",
        order: cell.order,
        taskId: cell.taskId,
        taskRevisionDigest: cell.taskRevisionDigest,
        capabilityStratum: cell.capabilityStratum,
        replicateOrdinal: cell.replicateOrdinal,
        harness: candidate,
      });
      continue;
    }
    const ordered =
      cell.order === "AB"
        ? ([
            ["candidate", candidate],
            ["champion", champion],
          ] as const)
        : ([
            ["champion", champion],
            ["candidate", candidate],
          ] as const);
    if (cell.order === "AB") candidateFirstCount += 1;
    else championFirstCount += 1;
    for (const [arm, harness] of ordered) {
      arms.push({
        sensitivity: "hidden-benchmark-arm",
        armId: `${panel.requestId}-cell-${String(cellOrdinal + 1).padStart(2, "0")}-${arm}`,
        cellOrdinal,
        arm,
        order: cell.order,
        taskId: cell.taskId,
        taskRevisionDigest: cell.taskRevisionDigest,
        capabilityStratum: cell.capabilityStratum,
        replicateOrdinal: cell.replicateOrdinal,
        harness,
      });
    }
  }
  return {
    sensitivity: "hidden-benchmark-schedule",
    requestId: panel.requestId,
    stage: panel.stage,
    executionPolicy:
      panel.stage === "repair" ? "candidate-only-repair" : "fresh-matched-pairs",
    cellCount: panel.cells.length,
    armCount: arms.length,
    candidateArmCount: panel.cells.length,
    championArmCount: panel.stage === "repair" ? 0 : panel.cells.length,
    candidateFirstCount,
    championFirstCount,
    arms,
  };
}
