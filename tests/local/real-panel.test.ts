import { describe, expect, it } from "vitest";

import {
  advanceLocalPanelPolicyState,
  assessLocalChampionPanel,
  initialLocalPanelPolicyState,
  LOCAL_PANEL_POLICY_VERSION,
  type LocalPanelPolicyState,
  type LocalPanelSelection,
  type LocalTaskCatalogEntry,
  localPanelSaturationPressure,
  parseLocalPanelPolicyState,
  selectDeterministicWeightedPanel,
} from "../../src/local/real/panel.js";

describe("real local panel selection", () => {
  it("samples five tasks deterministically without replacement or catalog-order dependence", () => {
    const catalog = taskCatalog();
    const options = {
      seed: "campaign-001:experiment-001",
      screenOrdinal: 1,
      state: initialLocalPanelPolicyState(),
    };

    const selected = selectDeterministicWeightedPanel(catalog, options);
    const replay = selectDeterministicWeightedPanel([...catalog].reverse(), options);

    expect(selected).toEqual(replay);
    expect(selected.tasks).toHaveLength(5);
    expect(new Set(selected.tasks.map((task) => task.taskId))).toHaveLength(5);
    expect(selected.panelDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(selected.seedDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(selected.policyVersion).toBe(LOCAL_PANEL_POLICY_VERSION);
  });

  it("uses rolling saturation pressure to favor hard tasks dynamically", () => {
    const catalog = balancedCatalog();
    let saturated = initialLocalPanelPolicyState();
    for (let index = 0; index < 20; index += 1) {
      saturated = advanceLocalPanelPolicyState(saturated, true);
    }
    let relaxed = saturated;
    for (let index = 0; index < 20; index += 1) {
      relaxed = advanceLocalPanelPolicyState(relaxed, false);
    }

    expect(localPanelSaturationPressure(saturated)).toBe(1);
    expect(localPanelSaturationPressure(relaxed)).toBe(0);
    let hardAtHighPressure = 0;
    let hardAtLowPressure = 0;
    for (let screenOrdinal = 1; screenOrdinal <= 200; screenOrdinal += 1) {
      hardAtHighPressure += selectDeterministicWeightedPanel(catalog, {
        seed: "difficulty-adaptation",
        screenOrdinal,
        state: saturated,
      }).tasks.filter((task) => task.difficulty === "hard").length;
      hardAtLowPressure += selectDeterministicWeightedPanel(catalog, {
        seed: "difficulty-adaptation",
        screenOrdinal,
        state: relaxed,
      }).tasks.filter((task) => task.difficulty === "hard").length;
    }
    expect(hardAtHighPressure).toBeGreaterThan(hardAtLowPressure);
  });

  it("honors task and exact-panel exclusions with deterministic redraws", () => {
    const catalog = taskCatalog();
    const state = initialLocalPanelPolicyState();
    const first = selectDeterministicWeightedPanel(catalog, {
      seed: "panel-exclusions",
      screenOrdinal: 1,
      state,
    });
    const excludedTask = first.tasks[0];
    if (excludedTask === undefined) throw new Error("Expected a selected task");
    const replacement = selectDeterministicWeightedPanel(catalog, {
      seed: "panel-exclusions",
      screenOrdinal: 1,
      state,
      excludedTaskIds: [excludedTask.taskId],
      excludedPanelDigests: [first.panelDigest],
    });

    expect(replacement.panelDigest).not.toBe(first.panelDigest);
    expect(replacement.tasks.map((task) => task.taskId)).not.toContain(excludedTask.taskId);
    expect(replacement.redrawOrdinal).toBeGreaterThanOrEqual(0);
    expect(() =>
      selectDeterministicWeightedPanel(catalog.slice(0, 5), {
        seed: "only-one-panel",
        screenOrdinal: 1,
        state,
        excludedPanelDigests: [
          selectDeterministicWeightedPanel(catalog.slice(0, 5), {
            seed: "only-one-panel",
            screenOrdinal: 1,
            state,
          }).panelDigest,
        ],
      }),
    ).toThrow(/outside the persisted panel exclusions/u);
  });

  it("keeps persisted saturation state strict, bounded, and JSON-compatible", () => {
    let state = initialLocalPanelPolicyState();
    for (let index = 0; index < 25; index += 1) {
      state = advanceLocalPanelPolicyState(state, index % 3 !== 0);
    }
    const roundTripped = parseLocalPanelPolicyState(JSON.parse(JSON.stringify(state)) as unknown);

    expect(roundTripped).toEqual(state);
    expect(roundTripped.recentSaturation).toHaveLength(20);
    expect(roundTripped.totalScreens).toBe(25);
    expect(roundTripped.saturatedScreens).toBe(16);
    expect(() => parseLocalPanelPolicyState({ ...roundTripped, unexpected: true })).toThrow(
      /unexpected fields/u,
    );
  });
});

describe("real local champion panel headroom", () => {
  it("accepts a <=0.95 panel based on aggregate headroom", () => {
    const selection = selectedFixture();
    const assessment = assessLocalChampionPanel(
      selection,
      observations(selection, () => 0.94),
    );

    expect(assessment).toMatchObject({
      status: "accepted",
      reason: "surpassable",
      championMeanReward: 0.94,
      theoreticalAggregateHeadroom: 0.06,
      aggregateThresholdSatisfied: true,
      everyTaskCanProduceWin: true,
      fullyPerfect: false,
    });
    expect(assessment.taskAssessments).toHaveLength(5);
  });

  it("rejects aggregate reward above 0.95 even when every task has some headroom", () => {
    const selection = selectedFixture();
    const assessment = assessLocalChampionPanel(
      selection,
      observations(selection, () => 0.96),
    );

    expect(assessment).toMatchObject({
      status: "saturated",
      reason: "aggregate-headroom-insufficient",
      aggregateThresholdSatisfied: false,
      everyTaskCanProduceWin: true,
    });
  });

  it("accepts concentrated headroom when aggregate reward is <=0.95", () => {
    const selection = selectedFixture();
    const weakSelection = selection.tasks[0];
    if (weakSelection === undefined) throw new Error("Expected a selected task");
    const weakTask = weakSelection.taskId;
    const assessment = assessLocalChampionPanel(
      selection,
      observations(selection, (taskId) => (taskId === weakTask ? 0.5 : 1)),
    );

    expect(assessment.championMeanReward).toBe(0.9);
    expect(assessment).toMatchObject({
      status: "accepted",
      reason: "surpassable",
      aggregateThresholdSatisfied: true,
      everyTaskCanProduceWin: false,
    });
  });

  it("requires strictly more than 0.01 task headroom and fails closed on infrastructure", () => {
    const selection = selectedFixture();
    const exactTieTolerance = assessLocalChampionPanel(
      selection,
      observations(selection, () => 0.99),
    );
    expect(exactTieTolerance).toMatchObject({
      status: "saturated",
      everyTaskCanProduceWin: false,
    });

    const invalid = observations(selection, () => 0.5).map((observation, index) => ({
      ...observation,
      infrastructureValid: index !== 0,
    }));
    expect(assessLocalChampionPanel(selection, invalid)).toMatchObject({
      status: "infrastructure-invalid",
      reason: "infrastructure-invalid",
    });
  });
});

function taskCatalog(): readonly LocalTaskCatalogEntry[] {
  return Array.from({ length: 16 }, (_, index) => ({
    taskId: `terminal-bench/task-${String(index + 1).padStart(2, "0")}`,
    revision: `sha256:${String(index + 101).padStart(64, "0")}`,
    difficulty:
      index % 3 === 0
        ? ("hard" as const)
        : index % 3 === 1
          ? ("medium" as const)
          : ("easy" as const),
    baseWeight: 1 + (index % 4) * 0.1,
  }));
}

function balancedCatalog(): readonly LocalTaskCatalogEntry[] {
  return Array.from({ length: 40 }, (_, index) => ({
    taskId: `balanced/task-${String(index + 1).padStart(2, "0")}`,
    revision: `sha256:${String(index + 201).padStart(64, "0")}`,
    difficulty: index < 20 ? ("easy" as const) : ("hard" as const),
    baseWeight: 1,
  }));
}

function selectedFixture(): LocalPanelSelection {
  return selectDeterministicWeightedPanel(taskCatalog(), {
    seed: "assessment-fixture",
    screenOrdinal: 1,
    state: initialLocalPanelPolicyState(),
  });
}

function observations(
  selection: LocalPanelSelection,
  reward: (taskId: string, repetition: 1 | 2 | 3) => number,
) {
  return selection.tasks.flatMap((task) =>
    ([1, 2, 3] as const).map((repetition) => ({
      taskId: task.taskId,
      repetition,
      reward: reward(task.taskId, repetition),
      infrastructureValid: true,
    })),
  );
}

const _jsonCompatibleState: LocalPanelPolicyState = JSON.parse(
  JSON.stringify(initialLocalPanelPolicyState()),
) as LocalPanelPolicyState;
void _jsonCompatibleState;
