import { describe, expect, it, vi } from "vitest";
import type { BudgetSnapshot, ChampionPointers } from "../../src/domain/models.js";
import {
  AutonomousOptimizationLoop,
  type ClaimedOptimizationExperiment,
  type OptimizationClaim,
  type OptimizationLoopSnapshot,
  type ProductionOptimizationCoordinator,
} from "../../src/orchestrator/autonomous-loop.js";
import type { ExperimentRunInput, ExperimentRunResult } from "../../src/orchestrator/contracts.js";
import { canonicalHash } from "../../src/schemas/canonical.js";

const BASELINE = "a".repeat(40);
const CANDIDATE = "b".repeat(40);
const PROTOCOL_HASH = "c".repeat(64);
const SOURCE_SEAL_HASH = "d".repeat(64);
const RESULT_SEAL_HASH = "e".repeat(64);
const DISCOVERY_HASH = "f".repeat(64);
const INITIAL_STATE_HASH = "1".repeat(64);
const COMMITTED_STATE_HASH = "2".repeat(64);
const INTERRUPTED_STATE_HASH = "3".repeat(64);
const ALLOCATION_STATE_HASH = "4".repeat(64);

function budget(
  usage: Partial<BudgetSnapshot["usage"]> = {},
  limits: Partial<BudgetSnapshot["limits"]> = {},
): BudgetSnapshot {
  return {
    limits: {
      maximumUsd: 100,
      maximumTokens: 1_000_000,
      maximumWallTimeMs: 1_000_000,
      maximumAttempts: 100,
      maximumPrivacyReleases: 10,
      maximumPromotionLooks: 10,
      maximumOnlineError: 0.05,
      ...limits,
    },
    usage: {
      spentUsd: 0,
      tokens: 0,
      wallTimeMs: 0,
      attempts: 0,
      privacyReleases: 0,
      promotionLooks: 0,
      onlineErrorSpent: 0,
      ...usage,
    },
  };
}

function champion(activeExperiment = 0, activeCommit = BASELINE): ChampionPointers {
  return {
    baselineCommit: BASELINE,
    activeExperiment,
    activeCommit,
    certifiedExperiment: null,
    certifiedCommit: null,
    updatedAt: "2026-07-26T08:00:00.000Z",
    sourceSealHash: SOURCE_SEAL_HASH,
  };
}

function snapshot(
  input: {
    readonly experimentNumber?: number;
    readonly activeChampion?: ChampionPointers;
    readonly campaignBudget?: BudgetSnapshot;
    readonly panels?: number;
    readonly stateHash?: string;
    readonly status?: OptimizationLoopSnapshot["status"];
    readonly inFlightExperimentNumber?: number | null;
    readonly hardBudgetExhausted?: boolean;
  } = {},
): OptimizationLoopSnapshot {
  return {
    schemaVersion: 1,
    campaignId: "campaign-001",
    lineageId: "lineage-001",
    protocolHash: PROTOCOL_HASH,
    stateHash: input.stateHash ?? INITIAL_STATE_HASH,
    status: input.status ?? "running",
    nextExperimentNumber: input.experimentNumber ?? 1,
    inFlightExperimentNumber: input.inFlightExperimentNumber ?? null,
    inFlightKind:
      input.inFlightExperimentNumber === undefined || input.inFlightExperimentNumber === null
        ? null
        : "optimization",
    activeChampion: input.activeChampion ?? champion(),
    budget: input.campaignBudget ?? budget(),
    hardBudgetExhausted: input.hardBudgetExhausted ?? false,
    freshValidationPanelsRemaining: input.panels ?? 3,
  };
}

function experimentInput(
  campaign: OptimizationLoopSnapshot,
  options: {
    readonly diagnosticBrief?: ExperimentRunInput["diagnosticBrief"];
    readonly previousDiscoveryAttestationHash?: string | null;
  } = {},
): ExperimentRunInput {
  const sourceOnly = campaign.nextExperimentNumber === 1;
  return {
    experiment: {
      number: campaign.nextExperimentNumber,
      slug: sourceOnly ? "source-only-bootstrap" : "diagnostic-repair",
      kind: "optimization",
      parentExperiment: campaign.activeChampion.activeExperiment,
      lineageId: campaign.lineageId,
      protocolHash: campaign.protocolHash,
    },
    activeChampion: campaign.activeChampion,
    budget: campaign.budget,
    diagnosticBrief:
      options.diagnosticBrief ??
      (sourceOnly
        ? null
        : {
            hash: DISCOVERY_HASH,
            releaseId: "diagnostic:001",
            actionable: true,
          }),
    previousDiscoveryAttestationHash:
      options.previousDiscoveryAttestationHash ?? (sourceOnly ? null : DISCOVERY_HASH),
    repairAttemptOrdinal: 1,
    stop: { requested: false },
  };
}

function claim(
  campaign: OptimizationLoopSnapshot,
  input = experimentInput(campaign),
): ClaimedOptimizationExperiment {
  const allocated = {
    ...campaign,
    stateHash: ALLOCATION_STATE_HASH,
    nextExperimentNumber: campaign.nextExperimentNumber + 1,
    inFlightExperimentNumber: campaign.nextExperimentNumber,
    inFlightKind: "optimization" as const,
  };
  return {
    kind: "claimed",
    priorStateHash: campaign.stateHash,
    allocationStateHash: allocated.stateHash,
    currentStateHash: allocated.stateHash,
    snapshot: allocated,
    input,
    claimHash: canonicalHash({
      domain: "dark-factory.optimization-claim.v2",
      priorStateHash: campaign.stateHash,
      allocationStateHash: allocated.stateHash,
      input,
    }),
  };
}

function result(input: {
  readonly campaign: OptimizationLoopSnapshot;
  readonly disposition: ExperimentRunResult["disposition"];
  readonly campaignBudget: BudgetSnapshot;
  readonly activeChampion?: ChampionPointers;
  readonly diagnosticBrief?: ExperimentRunResult["diagnosticBrief"];
}): ExperimentRunResult {
  return {
    disposition: input.disposition,
    activeChampion: input.activeChampion ?? input.campaign.activeChampion,
    budget: input.campaignBudget,
    diagnosticBrief:
      input.diagnosticBrief !== undefined
        ? input.diagnosticBrief
        : input.campaign.nextExperimentNumber === 1
          ? null
          : experimentInput(input.campaign).diagnosticBrief,
    sealHash: RESULT_SEAL_HASH,
  };
}

function committedSnapshot(
  claim: ClaimedOptimizationExperiment,
  runResult: ExperimentRunResult,
): OptimizationLoopSnapshot {
  const promotionLookDelta =
    runResult.budget.usage.promotionLooks - claim.input.budget.usage.promotionLooks;
  return {
    ...claim.snapshot,
    stateHash: COMMITTED_STATE_HASH,
    inFlightExperimentNumber: null,
    inFlightKind: null,
    activeChampion: runResult.activeChampion,
    budget: runResult.budget,
    freshValidationPanelsRemaining:
      claim.snapshot.freshValidationPanelsRemaining - promotionLookDelta,
  };
}

function coordinator(input: {
  readonly initial: OptimizationLoopSnapshot;
  readonly nextClaim: OptimizationClaim;
  readonly committed?: OptimizationLoopSnapshot;
}): ProductionOptimizationCoordinator {
  return {
    load: vi.fn(async () => input.initial),
    claimNext: vi.fn(async () => input.nextClaim),
    complete: vi.fn(async () => {
      if (input.committed === undefined) {
        throw new Error("No committed snapshot was configured.");
      }
      return input.committed;
    }),
    interrupt: vi.fn(async () => ({
      ...input.initial,
      status: "paused" as const,
      stateHash: INTERRUPTED_STATE_HASH,
    })),
  };
}

function clock(): () => Date {
  const instants = ["2026-07-26T09:00:00.000Z", "2026-07-26T09:01:00.000Z"] as const;
  let index = 0;
  return () => new Date(instants[index++] ?? "2026-07-26T09:01:00.000Z");
}

describe("autonomous optimization loop", () => {
  it("runs experiment 001 source-only and commits a fresh matched promotion", async () => {
    const initial = snapshot();
    const nextClaim = claim(initial);
    const promotedChampion: ChampionPointers = {
      ...initial.activeChampion,
      activeExperiment: 1,
      activeCommit: CANDIDATE,
      updatedAt: "2026-07-26T08:30:00.000Z",
      sourceSealHash: RESULT_SEAL_HASH,
    };
    const runResult = result({
      campaign: initial,
      disposition: "promoted",
      campaignBudget: budget({
        spentUsd: 10,
        tokens: 1_000,
        wallTimeMs: 10_000,
        attempts: 24,
        privacyReleases: 0,
        promotionLooks: 1,
      }),
      activeChampion: promotedChampion,
      diagnosticBrief: null,
    });
    const committed = committedSnapshot(nextClaim, runResult);
    const control = coordinator({ initial, nextClaim, committed });
    const runner = { run: vi.fn(async () => runResult) };

    const receipt = await new AutonomousOptimizationLoop({
      runner,
      coordinator: control,
      maximumExperimentsPerInvocation: 1,
      now: clock(),
    }).run();

    expect(runner.run).toHaveBeenCalledWith(nextClaim.input);
    expect(control.complete).toHaveBeenCalledWith({
      claimHash: nextClaim.claimHash,
      currentStateHash: nextClaim.currentStateHash,
      result: runResult,
    });
    expect(receipt).toMatchObject({
      experimentsCompleted: 1,
      promotions: 1,
      rejections: 0,
      terminalReason: "invocation-limit",
      initialStateHash: INITIAL_STATE_HASH,
      finalStateHash: COMMITTED_STATE_HASH,
    });
    expect(receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("does not consume a fresh panel when repair screening rejects a candidate", async () => {
    const activeChampion = champion(1, CANDIDATE);
    const initialBudget = budget({
      spentUsd: 10,
      tokens: 1_000,
      wallTimeMs: 10_000,
      attempts: 24,
      promotionLooks: 1,
    });
    const initial = snapshot({
      experimentNumber: 2,
      activeChampion,
      campaignBudget: initialBudget,
      panels: 2,
    });
    const nextClaim = claim(initial);
    const rejectedBudget = budget({
      spentUsd: 12,
      tokens: 1_100,
      wallTimeMs: 11_000,
      attempts: 29,
      promotionLooks: 1,
    });
    const runResult = result({
      campaign: initial,
      disposition: "rejected",
      campaignBudget: rejectedBudget,
    });
    const committed = committedSnapshot(nextClaim, runResult);
    const control = coordinator({ initial, nextClaim, committed });

    const receipt = await new AutonomousOptimizationLoop({
      runner: { run: vi.fn(async () => runResult) },
      coordinator: control,
      maximumExperimentsPerInvocation: 1,
      now: clock(),
    }).run();

    expect(committed.freshValidationPanelsRemaining).toBe(2);
    expect(receipt.rejections).toBe(1);
  });

  it("reports a stop acknowledged by completion even at the invocation limit", async () => {
    const initial = snapshot();
    const nextClaim = claim(initial);
    const runResult = result({
      campaign: initial,
      disposition: "rejected",
      campaignBudget: budget({
        spentUsd: 2,
        tokens: 200,
        wallTimeMs: 2_000,
        attempts: 5,
      }),
      diagnosticBrief: null,
    });
    const committed = {
      ...committedSnapshot(nextClaim, runResult),
      status: "stopped" as const,
    };

    const receipt = await new AutonomousOptimizationLoop({
      runner: { run: vi.fn(async () => runResult) },
      coordinator: coordinator({
        initial,
        nextClaim,
        committed,
      }),
      maximumExperimentsPerInvocation: 1,
      now: clock(),
    }).run();

    expect(receipt).toMatchObject({
      experimentsCompleted: 1,
      rejections: 1,
      terminalReason: "stopped",
      finalStateHash: COMMITTED_STATE_HASH,
    });
  });

  it("consumes exactly one fresh panel for a completed validation rejection", async () => {
    const activeChampion = champion(1, CANDIDATE);
    const initialBudget = budget({
      spentUsd: 10,
      tokens: 1_000,
      wallTimeMs: 10_000,
      attempts: 24,
      promotionLooks: 1,
    });
    const initial = snapshot({
      experimentNumber: 2,
      activeChampion,
      campaignBudget: initialBudget,
      panels: 2,
    });
    const nextClaim = claim(initial);
    const rejectedBudget = budget({
      spentUsd: 20,
      tokens: 2_000,
      wallTimeMs: 20_000,
      attempts: 53,
      privacyReleases: 1,
      promotionLooks: 2,
    });
    const runResult = result({
      campaign: initial,
      disposition: "rejected",
      campaignBudget: rejectedBudget,
    });
    const committed = committedSnapshot(nextClaim, runResult);

    const receipt = await new AutonomousOptimizationLoop({
      runner: { run: vi.fn(async () => runResult) },
      coordinator: coordinator({ initial, nextClaim, committed }),
      maximumExperimentsPerInvocation: 1,
      now: clock(),
    }).run();

    expect(committed.freshValidationPanelsRemaining).toBe(1);
    expect(receipt.rejections).toBe(1);
  });

  it("stops before claiming when the remaining budget cannot buy one panel", async () => {
    const initial = snapshot({
      campaignBudget: budget({}, { maximumAttempts: 27 }),
    });
    const control = coordinator({
      initial,
      nextClaim: claim(initial),
    });
    const runner = { run: vi.fn() };

    const receipt = await new AutonomousOptimizationLoop({
      runner,
      coordinator: control,
      maximumExperimentsPerInvocation: 10,
      now: clock(),
    }).run();

    expect(control.claimNext).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    expect(receipt.terminalReason).toBe("budget-exhausted");
  });

  it("interrupts durably when a claimed experiment commitment is invalid", async () => {
    const initial = snapshot();
    const validClaim = claim(initial);
    const invalidClaim: ClaimedOptimizationExperiment = {
      ...validClaim,
      claimHash: "0".repeat(64),
    };
    const control = coordinator({
      initial,
      nextClaim: invalidClaim,
    });
    const runner = { run: vi.fn() };

    await expect(
      new AutonomousOptimizationLoop({
        runner,
        coordinator: control,
        maximumExperimentsPerInvocation: 1,
        now: clock(),
      }).run(),
    ).rejects.toThrow(/commitment does not reproduce/u);
    expect(runner.run).not.toHaveBeenCalled();
    expect(control.interrupt).toHaveBeenCalledWith({
      claimHash: invalidClaim.claimHash,
      currentStateHash: invalidClaim.currentStateHash,
      failureClass: "integrity",
    });
  });

  it("interrupts durably and preserves a runner infrastructure failure", async () => {
    const initial = snapshot();
    const nextClaim = claim(initial);
    const control = coordinator({ initial, nextClaim });
    const failure = new Error("provider unavailable");

    await expect(
      new AutonomousOptimizationLoop({
        runner: { run: vi.fn(async () => Promise.reject(failure)) },
        coordinator: control,
        maximumExperimentsPerInvocation: 1,
        now: clock(),
      }).run(),
    ).rejects.toBe(failure);
    expect(control.interrupt).toHaveBeenCalledWith({
      claimHash: nextClaim.claimHash,
      currentStateHash: nextClaim.currentStateHash,
      failureClass: "infrastructure",
    });
  });

  it("does not infer an operator stop from untrusted provider error text", async () => {
    const initial = snapshot();
    const nextClaim = claim(initial);
    const control = coordinator({ initial, nextClaim });
    const failure = new Error("provider request was interrupted by an upstream signal");

    await expect(
      new AutonomousOptimizationLoop({
        runner: {
          run: vi.fn(async () => Promise.reject(failure)),
        },
        coordinator: control,
        maximumExperimentsPerInvocation: 1,
        now: clock(),
      }).run(),
    ).rejects.toBe(failure);
    expect(control.interrupt).toHaveBeenCalledWith({
      claimHash: nextClaim.claimHash,
      currentStateHash: nextClaim.currentStateHash,
      failureClass: "infrastructure",
    });
  });
});
