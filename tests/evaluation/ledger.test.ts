import { describe, expect, it } from "vitest";
import {
  abandonPanel,
  applyConsumedPanelToTaskLedger,
  claimRepairRevision,
  claimShadowCertification,
  contributingRepairTasksClearCooldown,
  createHiddenPanelLedgerEntry,
  createHiddenShadowLedger,
  decidePanel,
  linkReleasedEvidenceToHypothesis,
  makeReleaseSafePanelLedgerAttestation,
  markPanelArmStarted,
  recordRepairAttempt,
  releaseSafeShadowCapacity,
  repairPanelCanBeClaimed,
} from "../../src/evaluation/index.js";
import { makeTask, panelId, taskId } from "./fixtures.js";

describe("hidden panel consumption and cooldown ledger", () => {
  it("returns a never-started panel but quarantines any started panel", () => {
    const sealed = panel("validation");
    expect(abandonPanel(sealed).status).toBe("returned-unstarted");

    const started = markPanelArmStarted(sealed);
    const abandoned = abandonPanel(started);
    expect(abandoned.status).toBe("quarantined");
    expect(abandoned.feedbackConsumed).toBe(true);
    expect(abandoned.disposition).toBe("inconclusive");
  });

  it("consumes validation panels on promote, reject, and inconclusive", () => {
    for (const disposition of ["promote", "reject", "inconclusive"] as const) {
      const decided = decidePanel(markPanelArmStarted(panel("validation")), disposition);
      expect(decided.status).toBe("decided");
      expect(decided.feedbackConsumed).toBe(true);
      expect(decided.disposition).toBe(disposition);
    }
  });

  it("allows one immediate revision and then applies exactly three sealed experiments", () => {
    const firstDecision = decidePanel(markPanelArmStarted(panel("repair")), "fail");
    const afterFirst = recordRepairAttempt(firstDecision, 10, false);
    expect(afterFirst.repairAttemptsUsed).toBe(1);
    expect(repairPanelCanBeClaimed(afterFirst, 11)).toBe(true);

    const revision = claimRepairRevision(afterFirst, {
      currentExperimentOrdinal: 11,
      frozenHypothesisDigest: "hypothesis-revised",
      frozenCandidateDigest: "candidate-revised",
      sealedAt: "2026-07-27T09:00:00.000Z",
    });
    expect(revision.panelId).toBe(afterFirst.panelId);
    expect(revision.taskIds).toEqual(afterFirst.taskIds);
    expect(revision.status).toBe("sealed");
    const secondDecision = decidePanel(markPanelArmStarted(revision), "fail");
    const afterSecond = recordRepairAttempt(secondDecision, 11, false);
    expect(afterSecond.repairAttemptsUsed).toBe(2);
    expect(afterSecond.repairCooldownThroughExperiment).toBe(14);
    expect(repairPanelCanBeClaimed(afterSecond, 12)).toBe(false);
    expect(repairPanelCanBeClaimed(afterSecond, 14)).toBe(false);
    expect(repairPanelCanBeClaimed(afterSecond, 15)).toBe(false);
    expect(contributingRepairTasksClearCooldown(afterSecond, 14)).toBe(false);
    expect(contributingRepairTasksClearCooldown(afterSecond, 15)).toBe(true);
  });

  it("cannot revise a repair cohort with the same candidate or after it closes", () => {
    const decision = decidePanel(markPanelArmStarted(panel("repair")), "fail");
    const first = recordRepairAttempt(decision, 10, false);
    expect(() =>
      claimRepairRevision(first, {
        currentExperimentOrdinal: 11,
        frozenHypothesisDigest: "hypothesis-revised",
        frozenCandidateDigest: first.frozenCandidateDigest,
        sealedAt: "2026-07-27T09:00:00.000Z",
      }),
    ).toThrow(/new frozen candidate/u);

    const passing = recordRepairAttempt(
      decidePanel(markPanelArmStarted(panel("repair")), "pass"),
      10,
      true,
    );
    expect(() =>
      claimRepairRevision(passing, {
        currentExperimentOrdinal: 11,
        frozenHypothesisDigest: "hypothesis-revised",
        frozenCandidateDigest: "candidate-revised",
        sealedAt: "2026-07-27T09:00:00.000Z",
      }),
    ).toThrow(/not eligible/u);
  });

  it("closes the panel after the first candidate advances", () => {
    const decision = decidePanel(markPanelArmStarted(panel("repair")), "pass");
    const advanced = recordRepairAttempt(decision, 20, true);
    expect(advanced.repairCooldownThroughExperiment).toBe(23);
    expect(repairPanelCanBeClaimed(advanced, 21)).toBe(false);
    expect(repairPanelCanBeClaimed(advanced, 24)).toBe(false);
    expect(contributingRepairTasksClearCooldown(advanced, 24)).toBe(true);
  });

  it("never puts hidden panel or task handles in the release-safe attestation", () => {
    const attestation = makeReleaseSafePanelLedgerAttestation(
      decidePanel(markPanelArmStarted(panel("validation")), "reject"),
    );
    const serialized = JSON.stringify(attestation);
    expect(serialized).not.toContain(panelId(1));
    expect(serialized).not.toContain(taskId(1));
    expect(attestation.containsPanelHandle).toBe(false);
    expect(attestation.containsTaskIdentifiers).toBe(false);
  });

  it("updates only broker-private task exposure and links evidence to the next hypothesis", () => {
    const tasks = Array.from({ length: 14 }, (_, index) => makeTask(index + 1, ["hard"]));
    const decided = decidePanel(markPanelArmStarted(panel("validation")), "reject");
    const consumed = applyConsumedPanelToTaskLedger(tasks, decided, 7);
    expect(consumed.filter((task) => task.exposure.feedbackReleased)).toHaveLength(12);
    expect(consumed.filter((task) => task.exposure.positiveValidationConsumed)).toHaveLength(12);
    const linked = linkReleasedEvidenceToHypothesis(
      consumed,
      decided.taskIds,
      "next-frozen-hypothesis",
    );
    expect(
      linked.filter((task) =>
        task.exposure.informedHypothesisDigests.includes("next-frozen-hypothesis"),
      ),
    ).toHaveLength(12);
  });

  it("consumes two one-shot shadow slices and never retries the same active commit", () => {
    const initial = createHiddenShadowLedger();
    const first = claimShadowCertification(initial, "a".repeat(40));
    expect(() => claimShadowCertification(first, "a".repeat(40))).toThrow(/at most one/u);
    const second = claimShadowCertification(first, "b".repeat(40));
    const capacity = releaseSafeShadowCapacity(second);
    expect(capacity.remainingSliceCount).toBe(0);
    expect(capacity.certificationPaused).toBe(true);
    expect(JSON.stringify(capacity)).not.toContain("a".repeat(40));
    expect(() => claimShadowCertification(second, "c".repeat(40))).toThrow(/consumed/u);
  });
});

function panel(stage: "repair" | "validation") {
  return createHiddenPanelLedgerEntry({
    panelId: panelId(1),
    stage,
    taskIds: Array.from({ length: stage === "repair" ? 5 : 12 }, (_, index) => taskId(index + 1)),
    frozenHypothesisDigest: "hypothesis-frozen",
    frozenCandidateDigest: "candidate-frozen",
    sealedAt: "2026-07-26T09:00:00.000Z",
  });
}
