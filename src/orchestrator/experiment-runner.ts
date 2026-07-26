import { checkBudget, spendBudget } from "../core/budget.js";
import { DarkFactoryError, asErrorMessage } from "../core/errors.js";
import { reproduceFreshValidationDisposition } from "../core/validation-decision.js";
import type { BudgetSnapshot } from "../domain/models.js";
import { VALIDATION_ATTEMPT_LEDGER_POLICY_VERSION } from "../evaluation/validation-attempt-ledger.js";
import type {
  BlindBroker,
  CorrectnessGateRunner,
  DiagnosticBriefReference,
  ExperimentJournal,
  ExperimentRunInput,
  ExperimentRunResult,
  OptimizerAdapter,
  RepairAggregate,
  ValidationAggregate,
} from "./contracts.js";

export interface ExperimentRunnerDependencies {
  readonly optimizer: OptimizerAdapter;
  readonly gates: CorrectnessGateRunner;
  readonly broker: BlindBroker;
  readonly journal: ExperimentJournal;
  readonly now: () => Date;
}

function assertExactPlainObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new DarkFactoryError("EVIDENCE_INVALID", `${label} must be a plain object`);
  }
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => !expectedKeys.includes(key))
  ) {
    throw new DarkFactoryError(
      "EVIDENCE_INVALID",
      `${label} contains non-canonical fields`,
    );
  }
}

function assertDiagnosticBriefReference(
  brief: DiagnosticBriefReference,
): void {
  assertExactPlainObjectKeys(
    brief,
    ["hash", "releaseId", "actionable"],
    "Diagnostic brief reference",
  );
  if (
    !/^[a-f0-9]{64}$/u.test(brief.hash) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(brief.releaseId) ||
    typeof brief.actionable !== "boolean"
  ) {
    throw new DarkFactoryError(
      "EVIDENCE_INVALID",
      "Diagnostic brief reference has invalid release-safe fields",
    );
  }
}

function spendAggregate(
  budget: BudgetSnapshot,
  aggregate: {
    readonly aggregateCostUsd: number;
    readonly tokens: number;
    readonly wallTimeMs: number;
    readonly attempts?: number;
  },
): BudgetSnapshot {
  return spendBudget(budget, {
    spentUsd: aggregate.aggregateCostUsd,
    tokens: aggregate.tokens,
    wallTimeMs: aggregate.wallTimeMs,
    attempts: aggregate.attempts ?? 0,
  });
}

function assertGateProtocol(expected: string, observed: string): void {
  if (expected !== observed) {
    throw new DarkFactoryError(
      "PROTOCOL_MISMATCH",
      "Candidate gates used a different protocol hash",
    );
  }
}

function assertRepairAggregate(repair: RepairAggregate, leaseMaximum: number): void {
  assertExactPlainObjectKeys(
    repair,
    [
      "disposition",
      "attemptOrdinal",
      "integrityPassed",
      "cacheStatus",
      "aggregateCostUsd",
      "tokens",
      "wallTimeMs",
      "attempts",
      "attestationHash",
    ],
    "Repair aggregate",
  );
  if (
    !Number.isSafeInteger(repair.attempts) ||
    repair.attempts < 1 ||
    repair.attempts > leaseMaximum
  ) {
    throw new DarkFactoryError("EVIDENCE_INVALID", "Repair attempt accounting is invalid");
  }
  if (repair.disposition === "passed" && !repair.integrityPassed) {
    throw new DarkFactoryError(
      "EVIDENCE_INVALID",
      "An integrity-failing repair cannot create a challenger",
    );
  }
  if (
    !["passed", "rejected", "inconclusive"].includes(repair.disposition) ||
    (repair.attemptOrdinal !== 1 && repair.attemptOrdinal !== 2) ||
    typeof repair.integrityPassed !== "boolean" ||
    !["not-used", "eligible", "miss", "drift-failed"].includes(
      repair.cacheStatus,
    ) ||
    !Number.isFinite(repair.aggregateCostUsd) ||
    repair.aggregateCostUsd < 0 ||
    !Number.isSafeInteger(repair.tokens) ||
    repair.tokens < 0 ||
    !Number.isSafeInteger(repair.wallTimeMs) ||
    repair.wallTimeMs < 0 ||
    !/^[a-f0-9]{64}$/u.test(repair.attestationHash)
  ) {
    throw new DarkFactoryError(
      "EVIDENCE_INVALID",
      "Repair aggregate contains invalid release-safe accounting",
    );
  }
}

function assertValidationAggregate(
  validation: ValidationAggregate,
  expectedValidArms: number,
  maximumAttempts: number,
): void {
  assertExactPlainObjectKeys(
    validation,
    [
      "disposition",
      "validPairs",
      "validArms",
      "replacementAttempts",
      "probabilityPositive",
      "medianAccuracyDelta",
      "requiredPosteriorProbability",
      "onlineGateAuthorized",
      "stratumRegressionVeto",
      "integrityVeto",
      "correctnessVeto",
      "capabilityVeto",
      "costWithinGuardrail",
      "latencyWithinGuardrail",
      "accuracyTradeoffPredeclared",
      "aggregateCostUsd",
      "tokens",
      "wallTimeMs",
      "attestationHash",
      "releasedEvidenceHash",
      "attemptAccounting",
    ],
    "Validation aggregate",
  );
  const accounting = validation.attemptAccounting;
  assertExactPlainObjectKeys(
    accounting,
    [
      "policyVersion",
      "terminalStatus",
      "presealedPairCount",
      "presealedArmCount",
      "validArmCount",
      "attemptedArmCount",
      "unresolvedArmCount",
      "totalAttemptCount",
      "replacementAttemptCount",
      "infrastructureFailureCount",
      "nonInfrastructureFailureCount",
      "containsPanelHandle",
      "containsTaskIdentifiers",
      "containsCellIdentifiers",
      "containsAttemptIdentifiers",
      "containsEvidenceIdentifiers",
    ],
    "Validation attempt accounting",
  );
  if (
    !Number.isSafeInteger(validation.validPairs) ||
    !Number.isSafeInteger(validation.validArms) ||
    !Number.isSafeInteger(validation.replacementAttempts) ||
    validation.validPairs !== 12 ||
    validation.validArms !== expectedValidArms ||
    expectedValidArms !== 24 ||
    validation.replacementAttempts < 0 ||
    validation.validArms + validation.replacementAttempts > maximumAttempts ||
    validation.replacementAttempts > 4
  ) {
    throw new DarkFactoryError(
      "EVIDENCE_INVALID",
      "Validation did not provide exactly twelve bounded fresh matched pairs",
    );
  }
  if (
    accounting.policyVersion !== VALIDATION_ATTEMPT_LEDGER_POLICY_VERSION ||
    accounting.terminalStatus !== "complete" ||
    accounting.presealedPairCount !== 12 ||
    accounting.presealedArmCount !== 24 ||
    accounting.validArmCount !== 24 ||
    accounting.attemptedArmCount !== 24 ||
    accounting.unresolvedArmCount !== 0 ||
    accounting.totalAttemptCount !==
      validation.validArms + validation.replacementAttempts ||
    accounting.replacementAttemptCount !== validation.replacementAttempts ||
    accounting.infrastructureFailureCount !== validation.replacementAttempts ||
    accounting.nonInfrastructureFailureCount !== 0 ||
    accounting.containsPanelHandle !== false ||
    accounting.containsTaskIdentifiers !== false ||
    accounting.containsCellIdentifiers !== false ||
    accounting.containsAttemptIdentifiers !== false ||
    accounting.containsEvidenceIdentifiers !== false
  ) {
    throw new DarkFactoryError(
      "EVIDENCE_INVALID",
      "Validation aggregate does not bind a complete release-safe attempt ledger",
    );
  }
  if (
    !Number.isFinite(validation.aggregateCostUsd) ||
    validation.aggregateCostUsd < 0 ||
    !Number.isSafeInteger(validation.tokens) ||
    validation.tokens < 0 ||
    !Number.isSafeInteger(validation.wallTimeMs) ||
    validation.wallTimeMs < 0 ||
    !/^[a-f0-9]{64}$/u.test(validation.attestationHash) ||
    (validation.releasedEvidenceHash !== null &&
      !/^[a-f0-9]{64}$/u.test(validation.releasedEvidenceHash))
  ) {
    throw new DarkFactoryError(
      "EVIDENCE_INVALID",
      "Validation aggregate accounting or hash bindings are invalid",
    );
  }
  const booleanInputs = [
    validation.onlineGateAuthorized,
    validation.stratumRegressionVeto,
    validation.integrityVeto,
    validation.correctnessVeto,
    validation.capabilityVeto,
    validation.costWithinGuardrail,
    validation.latencyWithinGuardrail,
    validation.accuracyTradeoffPredeclared,
  ];
  if (booleanInputs.some((value) => typeof value !== "boolean")) {
    throw new DarkFactoryError(
      "EVIDENCE_INVALID",
      "Validation decision inputs must use canonical booleans",
    );
  }
  const reproduced = reproduceFreshValidationDisposition({
    probabilityPositive: validation.probabilityPositive,
    medianAccuracyDelta: validation.medianAccuracyDelta,
    requiredPosteriorProbability: validation.requiredPosteriorProbability,
    onlineGateAuthorized: validation.onlineGateAuthorized,
    stratumRegressionVeto: validation.stratumRegressionVeto,
    integrityVeto: validation.integrityVeto,
    correctnessVeto: validation.correctnessVeto,
    capabilityVeto: validation.capabilityVeto,
    costWithinGuardrail: validation.costWithinGuardrail,
    latencyWithinGuardrail: validation.latencyWithinGuardrail,
    accuracyTradeoffPredeclared: validation.accuracyTradeoffPredeclared,
  });
  const expectedDisposition =
    reproduced === "promote"
      ? "promoted"
      : reproduced === "reject"
        ? "rejected"
        : "inconclusive";
  if (validation.disposition !== expectedDisposition) {
    throw new DarkFactoryError(
      "EVIDENCE_INVALID",
      "Validation disposition does not reproduce from the frozen promotion policy",
    );
  }
}

function checkStop(input: ExperimentRunInput, phase: string): void {
  if (input.stop.requested) {
    throw new DarkFactoryError("USER_INPUT_REQUIRED", `Stop requested during ${phase}`, {
      phase,
    });
  }
}

export class ExperimentRunner {
  readonly #dependencies: ExperimentRunnerDependencies;

  public constructor(dependencies: ExperimentRunnerDependencies) {
    this.#dependencies = dependencies;
  }

  public async run(input: ExperimentRunInput): Promise<ExperimentRunResult> {
    let phase = "create";
    let budget = input.budget;
    let validationLease:
      | { readonly leaseToken: string; readonly attestationHash: string; readonly started: boolean }
      | null = null;
    try {
      await this.#dependencies.journal.create({
        experiment: input.experiment,
        activeChampionBefore: input.activeChampion,
      });
      checkStop(input, phase);

      phase = "optimizer-proposal";
      const sourceOnlyBootstrap = input.experiment.number === 1;
      if (sourceOnlyBootstrap && input.diagnosticBrief !== null) {
        throw new DarkFactoryError(
          "EVIDENCE_INVALID",
          "Experiment 001 must not receive benchmark-derived evidence",
        );
      }
      if (input.diagnosticBrief !== null) {
        assertDiagnosticBriefReference(input.diagnosticBrief);
      }
      const proposal = await this.#dependencies.optimizer.propose({
        experiment: input.experiment,
        activeChampion: input.activeChampion,
        diagnosticBrief: input.diagnosticBrief,
        sourceOnlyBootstrap,
      });
      if (
        proposal.hypothesis.sourceBriefHash !== (input.diagnosticBrief?.hash ?? null) &&
        !sourceOnlyBootstrap
      ) {
        throw new DarkFactoryError(
          "EVIDENCE_INVALID",
          "Frozen hypothesis does not bind the released diagnostic brief",
        );
      }
      await this.#dependencies.journal.freezeProposal({
        experiment: input.experiment,
        proposal,
      });
      checkStop(input, phase);

      phase = "cloud-correctness-gates";
      const gates = await this.#dependencies.gates.run({
        experiment: input.experiment,
        hypothesis: proposal.hypothesis,
        candidate: proposal.candidate,
      });
      assertGateProtocol(input.experiment.protocolHash, gates.protocolHash);
      budget = spendAggregate(budget, gates);
      await this.#dependencies.journal.recordGates({ experiment: input.experiment, gates });
      await this.#dependencies.journal.updateBudget(budget);
      if (!gates.passed || !gates.integrityPassed) {
        return await this.#closeWithoutValidation({
          input,
          budget,
          disposition: "rejected",
          proposal,
          repair: null,
        });
      }
      checkStop(input, phase);

      let repair: RepairAggregate | null = null;
      if (!sourceOnlyBootstrap) {
        phase = "repair";
        if (input.previousDiscoveryAttestationHash === null) {
          throw new DarkFactoryError(
            "EVIDENCE_INVALID",
            "A normal iteration requires a prior discovery attestation",
          );
        }
        const lease = await this.#dependencies.broker.prepareRepair({
          experiment: input.experiment,
          hypothesisHash: proposal.hypothesis.hash,
          candidateCommit: proposal.candidate.commit,
          previousDiscoveryAttestationHash: input.previousDiscoveryAttestationHash,
          attemptOrdinal: input.repairAttemptOrdinal,
        });
        if (
          !Number.isSafeInteger(lease.expectedValidArms) ||
          !Number.isSafeInteger(lease.maximumAttempts) ||
          lease.expectedValidArms < 5 ||
          lease.maximumAttempts < lease.expectedValidArms ||
          lease.maximumAttempts > 14
        ) {
          throw new DarkFactoryError("EVIDENCE_INVALID", "Repair lease exceeds its sealed bounds");
        }
        repair = await this.#dependencies.broker.runRepair({
          experiment: input.experiment,
          leaseToken: lease.leaseToken,
          candidateCommit: proposal.candidate.commit,
          activeChampionCommit: input.activeChampion.activeCommit,
        });
        assertRepairAggregate(repair, lease.maximumAttempts);
        budget = spendAggregate(budget, repair);
        await this.#dependencies.journal.recordRepair({ experiment: input.experiment, repair });
        await this.#dependencies.journal.updateBudget(budget);
        if (repair.disposition !== "passed") {
          return await this.#closeWithoutValidation({
            input,
            budget,
            disposition:
              repair.disposition === "rejected" ? "rejected" : "inconclusive",
            proposal,
            repair,
          });
        }
      }
      checkStop(input, phase);

      phase = "fresh-validation";
      budget = spendBudget(budget, { promotionLooks: 1 });
      await this.#dependencies.journal.updateBudget(budget);
      const diagnosticReleaseAuthorized = checkBudget(budget, {
        privacyReleases: 1,
      }).allowed;
      const lease = await this.#dependencies.broker.prepareValidation({
        experiment: input.experiment,
        hypothesisHash: proposal.hypothesis.hash,
        candidateCommit: proposal.candidate.commit,
        excludedEvidenceHashes: [
          ...(input.diagnosticBrief === null ? [] : [input.diagnosticBrief.hash]),
          ...(repair === null ? [] : [repair.attestationHash]),
        ],
        remainingExperimentAttempts: 38 - (repair?.attempts ?? 0),
        diagnosticReleaseAuthorized,
      });
      validationLease = {
        leaseToken: lease.leaseToken,
        attestationHash: lease.attestationHash,
        started: false,
      };
      const expectedValidationMaximum = Math.min(28, 38 - (repair?.attempts ?? 0));
      if (
        !Number.isSafeInteger(lease.expectedValidArms) ||
        !Number.isSafeInteger(lease.maximumAttempts) ||
        lease.expectedValidArms !== 24 ||
        lease.maximumAttempts !== expectedValidationMaximum ||
        lease.maximumAttempts < 24 ||
        !/^[a-f0-9]{64}$/u.test(lease.attestationHash)
      ) {
        throw new DarkFactoryError(
          "EVIDENCE_INVALID",
          "Fresh validation must preseal 24 valid arms and up to four replacements",
        );
      }
      validationLease = {
        leaseToken: lease.leaseToken,
        attestationHash: lease.attestationHash,
        started: true,
      };
      const validation = await this.#dependencies.broker.runValidation({
        experiment: input.experiment,
        leaseToken: lease.leaseToken,
        candidateCommit: proposal.candidate.commit,
        activeChampionCommit: input.activeChampion.activeCommit,
      });
      assertValidationAggregate(validation, lease.expectedValidArms, lease.maximumAttempts);
      if (
        (repair?.attempts ?? 0) +
          validation.validArms +
          validation.replacementAttempts >
        38
      ) {
        throw new DarkFactoryError(
          "EVIDENCE_INVALID",
          "Evaluation exceeded the sealed 38-attempt experiment ceiling",
        );
      }
      budget = spendAggregate(budget, {
        ...validation,
        attempts: validation.validArms + validation.replacementAttempts,
      });
      await this.#dependencies.journal.updateBudget(budget);

      phase = "consume-validation";
      const panelDisposition = await this.#dependencies.broker.consumeOrQuarantine({
        leaseToken: lease.leaseToken,
        attestationHash: lease.attestationHash,
        outcome: "decided",
      });
      validationLease = null;
      if (!/^[a-f0-9]{64}$/u.test(panelDisposition.dispositionAttestationHash)) {
        throw new DarkFactoryError(
          "EVIDENCE_INVALID",
          "Validation consumption attestation hash is invalid",
        );
      }
      await this.#dependencies.journal.recordValidation({
        experiment: input.experiment,
        validation,
        panelDispositionAttestationHash: panelDisposition.dispositionAttestationHash,
      });

      phase = "optimizer-analysis";
      const analysis = await this.#dependencies.optimizer.analyze({
        experiment: input.experiment,
        hypothesis: proposal.hypothesis,
        candidate: proposal.candidate,
        repair,
        validation,
      });
      await this.#dependencies.journal.recordAnalysis({
        experiment: input.experiment,
        analysisHash: analysis.hash,
      });

      const disposition = validation.disposition;

      phase = "diagnostic-release";
      const diagnosticBrief = diagnosticReleaseAuthorized
        ? await this.#dependencies.broker.releaseDiagnosticBrief({
            experiment: input.experiment,
            validationAttestationHash: validation.attestationHash,
            releaseAuthorized: true,
          })
        : null;
      // A non-null response crossed the privacy boundary even if its bindings
      // later prove invalid, so charge and persist the release first.
      if (diagnosticBrief !== null) {
        budget = spendBudget(budget, { privacyReleases: 1 });
        await this.#dependencies.journal.updateBudget(budget);
      }
      if (diagnosticBrief !== null) {
        assertDiagnosticBriefReference(diagnosticBrief);
      }
      if (
        validation.releasedEvidenceHash !==
        (diagnosticBrief?.hash ?? null)
      ) {
        throw new DarkFactoryError(
          "EVIDENCE_INVALID",
          "Diagnostic release does not match the signed validation evidence hash",
        );
      }
      const sealed = await this.#dependencies.journal.seal({
        experiment: input.experiment,
        disposition,
        activeChampionBefore: input.activeChampion,
        promotedCandidate:
          disposition === "promoted"
            ? {
                experimentNumber: input.experiment.number,
                commit: proposal.candidate.commit,
                decidedAt: this.#dependencies.now().toISOString(),
              }
            : null,
        diagnosticBrief,
      });
      return {
        disposition,
        activeChampion: sealed.activeChampionAfter,
        budget,
        diagnosticBrief,
        sealHash: sealed.sealHash,
      };
    } catch (error) {
      if (validationLease !== null) {
        await this.#dependencies.broker.consumeOrQuarantine({
          leaseToken: validationLease.leaseToken,
          attestationHash: validationLease.attestationHash,
          outcome: validationLease.started ? "started-abandoned" : "sealed-unstarted",
        });
      }
      await this.#dependencies.journal.interrupt({
        experiment: input.experiment,
        phase,
        reason: asErrorMessage(error),
      });
      throw error;
    }
  }

  async #closeWithoutValidation(input: {
    readonly input: ExperimentRunInput;
    readonly budget: BudgetSnapshot;
    readonly disposition: "rejected" | "inconclusive";
    readonly proposal: Awaited<ReturnType<OptimizerAdapter["propose"]>>;
    readonly repair: RepairAggregate | null;
  }): Promise<ExperimentRunResult> {
    const analysis = await this.#dependencies.optimizer.analyze({
      experiment: input.input.experiment,
      hypothesis: input.proposal.hypothesis,
      candidate: input.proposal.candidate,
      repair: input.repair,
      validation: null,
    });
    await this.#dependencies.journal.recordAnalysis({
      experiment: input.input.experiment,
      analysisHash: analysis.hash,
    });
    const sealed = await this.#dependencies.journal.seal({
      experiment: input.input.experiment,
      disposition: input.disposition,
      activeChampionBefore: input.input.activeChampion,
      promotedCandidate: null,
      diagnosticBrief: input.input.diagnosticBrief,
    });
    return {
      disposition: input.disposition,
      activeChampion: sealed.activeChampionAfter,
      budget: input.budget,
      diagnosticBrief: input.input.diagnosticBrief,
      sealHash: sealed.sealHash,
    };
  }
}
