import { describe, expect, it } from "vitest";
import {
  RepairAttemptLedger,
  nextExperimentNumber,
  transitionExperiment,
  updateChampionPointers,
} from "../../src/core/lifecycle.js";
import type { ChampionPointers } from "../../src/domain/models.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

const pointers: ChampionPointers = {
  baselineCommit: SHA_A,
  activeExperiment: 0,
  activeCommit: SHA_A,
  certifiedExperiment: null,
  certifiedCommit: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  sourceSealHash: "f".repeat(64),
};

describe("experiment lifecycle", () => {
  it("accepts the walk-forward path and rejects a repair promotion shortcut", () => {
    expect(transitionExperiment("optimization", "planned", "candidate-ready")).toBe(
      "candidate-ready",
    );
    expect(transitionExperiment("optimization", "repair-evaluating", "challenger")).toBe(
      "challenger",
    );
    expect(() =>
      transitionExperiment("optimization", "repair-evaluating", "promoted"),
    ).toThrow(/Cannot transition/u);
  });

  it("moves active and certified pointers only at their respective gates", () => {
    const promoted = updateChampionPointers(pointers, {
      experimentNumber: 1,
      commit: SHA_B,
      state: "promoted",
      sealedAt: "2026-01-02T00:00:00.000Z",
      sealHash: "1".repeat(64),
    });
    expect(promoted.activeCommit).toBe(SHA_B);
    expect(promoted.certifiedCommit).toBeNull();

    const certified = updateChampionPointers(promoted, {
      experimentNumber: 1,
      commit: SHA_B,
      state: "certified",
      sealedAt: "2026-01-03T00:00:00.000Z",
      sealHash: "2".repeat(64),
    });
    expect(certified.certifiedCommit).toBe(SHA_B);

    expect(() =>
      updateChampionPointers(certified, {
        experimentNumber: 2,
        commit: SHA_C,
        state: "certified",
        sealedAt: "2026-01-04T00:00:00.000Z",
        sealHash: "3".repeat(64),
      }),
    ).toThrow(/current active/u);
  });

  it("allocates monotonically and ignores malformed directory names", () => {
    expect(
      nextExperimentNumber([
        "000-pi-baseline",
        "002-command-recovery",
        "notes",
        "003_unsafe",
      ]),
    ).toBe(3);
  });

  it("permits one repair and one immediate revision only", () => {
    const ledger = new RepairAttemptLedger();
    expect(ledger.record("panel-hash", SHA_A)).toBe(1);
    expect(ledger.record("panel-hash", SHA_A)).toBe(1);
    expect(ledger.record("panel-hash", SHA_B)).toBe(2);
    expect(() => ledger.record("panel-hash", SHA_C)).toThrow(/more than two/u);
  });
});

