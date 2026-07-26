import { createHash } from "node:crypto";

import { updateChampionPointers } from "../core/lifecycle.js";
import type { BudgetSnapshot, ChampionPointers, ExperimentIdentity } from "../domain/models.js";
import { allocateOnlineGate, createOnlineErrorBudget } from "../evaluation/statistics.js";
import type {
  BlindBroker,
  DiagnosticBriefReference,
  ExperimentJournal,
  OptimizerAdapter,
  ValidationAggregate,
} from "../orchestrator/contracts.js";
import { ExperimentRunner } from "../orchestrator/experiment-runner.js";
import { canonicalHash } from "../schemas/canonical.js";

const PROTOCOL_HASH = createHash("sha256")
  .update("dark-factory-synthetic-protocol-v1")
  .digest("hex");
const BASELINE_COMMIT = createHash("sha1").update("dark-factory-synthetic-baseline").digest("hex");
const SYNTHETIC_PRIVATE_TASK_CANARY = "DF_SYNTHETIC_PRIVATE_TASK_CANARY";

type SyntheticDisposition = "promoted" | "rejected" | "inconclusive";

export interface SyntheticExperimentReceipt {
  readonly experimentNumber: number;
  readonly expectedDisposition: SyntheticDisposition;
  readonly observedDisposition: SyntheticDisposition;
  readonly activeCommitHash: string;
  readonly sealHash: string;
}

export interface SyntheticCampaignReceipt {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.synthetic-campaign.v1";
  readonly protocolHash: string;
  readonly scenarios: readonly [
    SyntheticExperimentReceipt,
    SyntheticExperimentReceipt,
    SyntheticExperimentReceipt,
  ];
  readonly finalBudgetUsage: BudgetSnapshot["usage"];
  readonly privacyCanaryAbsent: true;
  readonly receiptHash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function candidateCommit(experimentNumber: number): string {
  return createHash("sha1")
    .update(`dark-factory-synthetic-candidate:${String(experimentNumber)}`)
    .digest("hex");
}

function experiment(number: number): ExperimentIdentity {
  return {
    number,
    slug:
      number === 1
        ? "source-only-bootstrap"
        : number === 2
          ? "repair-rejection"
          : "fresh-inconclusive",
    kind: "optimization",
    parentExperiment: number === 1 ? 0 : number - 1,
    lineageId: "synthetic-lineage-v1",
    protocolHash: PROTOCOL_HASH,
  };
}

function optimizer(expectedSourceBriefHash: string | null): OptimizerAdapter {
  return {
    propose: async (context) => {
      if (
        context.diagnosticBrief?.hash !== expectedSourceBriefHash &&
        !(context.diagnosticBrief === null && expectedSourceBriefHash === null)
      ) {
        throw new Error("Synthetic optimizer received detached evidence.");
      }
      const commit = candidateCommit(context.experiment.number);
      return {
        hypothesis: {
          hash: sha256(`synthetic-hypothesis:${String(context.experiment.number)}`),
          sourceBriefHash: expectedSourceBriefHash,
          causalClaim: "A generic recovery policy is incomplete.",
          intervention: "Exercise a generic bounded recovery change.",
          predictedRepairBehavior: "More recoverable failures are handled.",
          predictedFreshEffect: "A small task-agnostic improvement.",
          falsificationCriteria: ["No fresh matched improvement."],
          rollbackCondition: "Any broad matched regression.",
        },
        candidate: {
          commit,
          patchHash: sha256(`synthetic-patch:${commit}`),
          changedFiles: ["packages/coding-agent/src/core/synthetic-fixture.ts"],
          mutationCategory: "synthetic-control-flow",
        },
      };
    },
    analyze: async (input) => ({
      hash: sha256(
        `synthetic-analysis:${String(input.experiment.number)}:${input.candidate.commit}`,
      ),
      rollbackRequired: false,
    }),
  };
}

function validationAggregate(
  disposition: "promoted" | "inconclusive",
  evidenceHash: string,
  gateOrdinal: 1 | 2,
): ValidationAggregate {
  let state = createOnlineErrorBudget(0.05, "synthetic-null-calibration-v1");
  if (gateOrdinal === 2) {
    state = allocateOnlineGate(state).nextState;
  }
  const gate = allocateOnlineGate(state);
  return {
    disposition,
    validPairs: 12,
    validArms: 24,
    replacementAttempts: 0,
    probabilityPositive: disposition === "promoted" ? 0.99 : 0.7,
    medianAccuracyDelta: disposition === "promoted" ? 0.08 : 0.01,
    requiredPosteriorProbability: gate.requiredPosteriorProbability,
    onlineGateAuthorized: true,
    onlineErrorBudget: {
      policyVersion: "online-alpha-spending-v1",
      maximumOnlineError: state.initialAlpha,
      gateOrdinal,
      alphaSpent: gate.alphaSpent,
      cumulativeSpentBefore: state.spentAlpha,
      cumulativeSpentAfter: gate.nextState.spentAlpha,
      remainingAfter: gate.nextState.remainingAlpha,
      reservationHash: sha256(`synthetic-online-reservation:${String(gateOrdinal)}`),
      priorStateHash: sha256(`synthetic-online-state:${String(gateOrdinal - 1)}`),
      resultingStateHash: sha256(`synthetic-online-state:${String(gateOrdinal)}`),
    },
    stratumRegressionVeto: false,
    integrityVeto: false,
    correctnessVeto: false,
    capabilityVeto: false,
    costWithinGuardrail: true,
    latencyWithinGuardrail: true,
    accuracyTradeoffPredeclared: false,
    aggregateCostUsd: 0,
    tokens: 0,
    wallTimeMs: 1,
    attestationHash: sha256(`synthetic-validation:${disposition}`),
    releasedEvidenceHash: evidenceHash,
    behavioralSourceCommitmentHash: sha256(`synthetic-behavioral-source:${disposition}`),
    attemptAccounting: {
      policyVersion: "validation-attempt-ledger-v1",
      terminalStatus: "complete",
      presealedPairCount: 12,
      presealedArmCount: 24,
      validArmCount: 24,
      attemptedArmCount: 24,
      unresolvedArmCount: 0,
      totalAttemptCount: 24,
      replacementAttemptCount: 0,
      infrastructureFailureCount: 0,
      nonInfrastructureFailureCount: 0,
      containsPanelHandle: false,
      containsTaskIdentifiers: false,
      containsCellIdentifiers: false,
      containsAttemptIdentifiers: false,
      containsEvidenceIdentifiers: false,
    },
  };
}

class SyntheticBroker implements BlindBroker {
  readonly #scenario: "bootstrap-promote" | "repair-reject" | "validation-inconclusive";
  readonly #brief: DiagnosticBriefReference;
  readonly #onlineGateOrdinal: 1 | 2;
  readonly #privateTaskCanary = SYNTHETIC_PRIVATE_TASK_CANARY;
  validationConsumed = false;

  constructor(
    scenario: "bootstrap-promote" | "repair-reject" | "validation-inconclusive",
    experimentNumber: number,
  ) {
    this.#scenario = scenario;
    this.#onlineGateOrdinal = experimentNumber === 1 ? 1 : 2;
    this.#brief = {
      hash: sha256(`synthetic-brief:${String(experimentNumber)}`),
      releaseId: `synthetic-release-${String(experimentNumber)}`,
      actionable: true,
    };
  }

  prepareRepair(): Promise<{
    readonly leaseToken: string;
    readonly attestationHash: string;
    readonly expectedValidArms: number;
    readonly maximumAttempts: number;
  }> {
    return Promise.resolve({
      leaseToken: "synthetic-repair-lease",
      attestationHash: sha256("synthetic-repair-lease"),
      expectedValidArms: 5,
      maximumAttempts: 9,
    });
  }

  runRepair(): Promise<{
    readonly disposition: "passed" | "rejected";
    readonly attemptOrdinal: 1;
    readonly integrityPassed: true;
    readonly cacheStatus: "not-used";
    readonly aggregateCostUsd: 0;
    readonly tokens: 0;
    readonly wallTimeMs: 1;
    readonly attempts: 5;
    readonly attestationHash: string;
  }> {
    return Promise.resolve({
      disposition: this.#scenario === "repair-reject" ? "rejected" : "passed",
      attemptOrdinal: 1,
      integrityPassed: true,
      cacheStatus: "not-used",
      aggregateCostUsd: 0,
      tokens: 0,
      wallTimeMs: 1,
      attempts: 5,
      attestationHash: sha256(`synthetic-repair:${this.#scenario}`),
    });
  }

  prepareValidation(input: { readonly remainingExperimentAttempts: number }): Promise<{
    readonly leaseToken: string;
    readonly attestationHash: string;
    readonly expectedValidArms: number;
    readonly maximumAttempts: number;
  }> {
    return Promise.resolve({
      leaseToken: "synthetic-validation-lease",
      attestationHash: sha256("synthetic-validation-lease"),
      expectedValidArms: 24,
      maximumAttempts: Math.min(28, input.remainingExperimentAttempts),
    });
  }

  runValidation(): Promise<ValidationAggregate> {
    if (this.#privateTaskCanary.length === 0) {
      throw new Error("Synthetic trusted task catalog is unavailable.");
    }
    return Promise.resolve(
      validationAggregate(
        this.#scenario === "validation-inconclusive" ? "inconclusive" : "promoted",
        this.#brief.hash,
        this.#onlineGateOrdinal,
      ),
    );
  }

  consumeOrQuarantine(): Promise<{
    readonly dispositionAttestationHash: string;
  }> {
    this.validationConsumed = true;
    return Promise.resolve({
      dispositionAttestationHash: sha256(`synthetic-panel-disposition:${this.#scenario}`),
    });
  }

  releaseDiagnosticBrief(): Promise<DiagnosticBriefReference> {
    return Promise.resolve(this.#brief);
  }
}

class SyntheticJournal implements ExperimentJournal {
  readonly #number: number;
  readonly events: string[] = [];

  constructor(number: number) {
    this.#number = number;
  }

  create(): Promise<void> {
    this.events.push("create");
    return Promise.resolve();
  }

  freezeProposal(): Promise<void> {
    this.events.push("freeze");
    return Promise.resolve();
  }

  recordGates(): Promise<void> {
    this.events.push("gates");
    return Promise.resolve();
  }

  recordRepair(): Promise<void> {
    this.events.push("repair");
    return Promise.resolve();
  }

  recordValidation(): Promise<void> {
    this.events.push("validation");
    return Promise.resolve();
  }

  recordAnalysis(): Promise<void> {
    this.events.push("analysis");
    return Promise.resolve();
  }

  updateBudget(): Promise<void> {
    this.events.push("budget");
    return Promise.resolve();
  }

  seal(input: Parameters<ExperimentJournal["seal"]>[0]): Promise<{
    readonly sealHash: string;
    readonly activeChampionAfter: ChampionPointers;
  }> {
    this.events.push("seal");
    const sealHash = sha256(`synthetic-seal:${String(this.#number)}`);
    return Promise.resolve({
      sealHash,
      activeChampionAfter:
        input.promotedCandidate === null
          ? input.activeChampionBefore
          : updateChampionPointers(input.activeChampionBefore, {
              experimentNumber: input.promotedCandidate.experimentNumber,
              commit: input.promotedCandidate.commit,
              state: "promoted",
              sealedAt: input.promotedCandidate.decidedAt,
              sealHash,
            }),
    });
  }

  interrupt(): Promise<void> {
    this.events.push("interrupt");
    return Promise.resolve();
  }
}

function initialBudget(): BudgetSnapshot {
  return {
    limits: {
      maximumUsd: 1,
      maximumTokens: 1,
      maximumWallTimeMs: 1_000,
      maximumAttempts: 100,
      maximumPrivacyReleases: 3,
      maximumPromotionLooks: 3,
      maximumOnlineError: 0.05,
    },
    usage: {
      spentUsd: 0,
      tokens: 0,
      wallTimeMs: 0,
      attempts: 0,
      privacyReleases: 0,
      promotionLooks: 0,
      onlineErrorSpent: 0,
    },
  };
}

function initialChampion(): ChampionPointers {
  return {
    baselineCommit: BASELINE_COMMIT,
    activeExperiment: 0,
    activeCommit: BASELINE_COMMIT,
    certifiedExperiment: null,
    certifiedCommit: null,
    updatedAt: "2026-07-26T00:00:00.000Z",
    sourceSealHash: sha256("synthetic-baseline-seal"),
  };
}

export async function runSyntheticWalkForwardCampaign(): Promise<SyntheticCampaignReceipt> {
  const scenarios = [
    {
      number: 1,
      kind: "bootstrap-promote" as const,
      expected: "promoted" as const,
    },
    {
      number: 2,
      kind: "repair-reject" as const,
      expected: "rejected" as const,
    },
    {
      number: 3,
      kind: "validation-inconclusive" as const,
      expected: "inconclusive" as const,
    },
  ];
  let budget = initialBudget();
  let champion = initialChampion();
  let diagnosticBrief: DiagnosticBriefReference | null = null;
  const receipts: SyntheticExperimentReceipt[] = [];

  for (const scenario of scenarios) {
    const broker = new SyntheticBroker(scenario.kind, scenario.number);
    const journal = new SyntheticJournal(scenario.number);
    const runner = new ExperimentRunner({
      optimizer: optimizer(diagnosticBrief?.hash ?? null),
      gates: {
        run: () =>
          Promise.resolve({
            passed: true,
            integrityPassed: true,
            protocolHash: PROTOCOL_HASH,
            checksHash: sha256(`synthetic-gates:${String(scenario.number)}`),
            aggregateCostUsd: 0,
            tokens: 0,
            wallTimeMs: 1,
            failureCode: null,
          }),
      },
      broker,
      journal,
      now: () => new Date(`2026-07-${String(20 + scenario.number).padStart(2, "0")}T00:00:00.000Z`),
    });
    const result = await runner.run({
      experiment: experiment(scenario.number),
      activeChampion: champion,
      budget,
      diagnosticBrief,
      previousDiscoveryAttestationHash:
        scenario.number === 1 ? null : sha256(`synthetic-discovery:${String(scenario.number - 1)}`),
      repairAttemptOrdinal: 1,
      stop: { requested: false },
    });
    if (
      result.disposition !== scenario.expected ||
      journal.events.at(-1) !== "seal" ||
      journal.events.includes("interrupt") ||
      (scenario.expected !== "rejected" && broker.validationConsumed !== true)
    ) {
      throw new Error("Synthetic campaign violated a lifecycle invariant.");
    }
    champion = result.activeChampion;
    budget = result.budget;
    diagnosticBrief = result.diagnosticBrief;
    receipts.push({
      experimentNumber: scenario.number,
      expectedDisposition: scenario.expected,
      observedDisposition: result.disposition,
      activeCommitHash: sha256(result.activeChampion.activeCommit),
      sealHash: result.sealHash,
    });
  }

  if (receipts.length !== 3) {
    throw new Error("Synthetic campaign did not seal all scenarios.");
  }
  const body = {
    schemaVersion: 1 as const,
    domain: "dark-factory.synthetic-campaign.v1" as const,
    protocolHash: PROTOCOL_HASH,
    scenarios: receipts as unknown as SyntheticCampaignReceipt["scenarios"],
    finalBudgetUsage: budget.usage,
    privacyCanaryAbsent: true as const,
  };
  const receipt: SyntheticCampaignReceipt = {
    ...body,
    receiptHash: canonicalHash(body),
  };
  if (JSON.stringify(receipt).includes(SYNTHETIC_PRIVATE_TASK_CANARY)) {
    throw new Error("Synthetic hidden canary crossed the release boundary.");
  }
  return receipt;
}
