import { canonicalJson } from "../schemas/canonical.js";
import type { CampaignState } from "../schemas/control.js";
import { CampaignTransitionError } from "./errors.js";

const USAGE_LIMIT_PAIRS = [
  ["spentUsd", "maximumUsd"],
  ["tokens", "maximumTokens"],
  ["wallTimeMs", "maximumWallTimeMs"],
  ["attempts", "maximumAttempts"],
  ["privacyReleases", "maximumPrivacyReleases"],
  ["promotionLooks", "maximumPromotionLooks"],
  ["onlineErrorSpent", "maximumOnlineError"],
] as const;

const EXTENSIBLE_LIMITS = [
  "maximumUsd",
  "maximumTokens",
  "maximumWallTimeMs",
  "maximumAttempts",
] as const;

const LINEAGE_FROZEN_LIMITS = [
  "maximumPrivacyReleases",
  "maximumPromotionLooks",
  "maximumOnlineError",
] as const;

type ChampionPointer = CampaignState["champions"]["active"];

function fail(message: string): never {
  throw new CampaignTransitionError(message);
}

function equal(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function timestamp(value: string): number {
  return Date.parse(value);
}

function assertImmutable(label: string, previous: unknown, next: unknown): void {
  if (!equal(previous, next)) {
    fail(`${label} is immutable within a campaign lineage`);
  }
}

function assertPointerDidNotRegress(
  label: string,
  previous: ChampionPointer,
  next: ChampionPointer,
): void {
  if (next.experimentNumber < previous.experimentNumber) {
    fail(`${label} experiment number cannot decrease`);
  }
  if (next.experimentNumber === previous.experimentNumber && !equal(previous, next)) {
    fail(`${label} cannot change without advancing its experiment number`);
  }
}

function sameChampionIdentity(left: ChampionPointer, right: ChampionPointer): boolean {
  return left.experimentNumber === right.experimentNumber && left.commit === right.commit;
}

function assertControlTransition(previous: CampaignState, next: CampaignState): void {
  const prior = previous.control;
  const current = next.control;
  const allowed: Readonly<Record<typeof prior.status, readonly (typeof current.status)[]>> = {
    running: ["running", "stop-requested", "paused"],
    "stop-requested": ["stop-requested", "stopped"],
    stopped: ["stopped", "running"],
    paused: ["paused", "stop-requested", "running"],
  };

  if (!allowed[prior.status].includes(current.status)) {
    fail(`Campaign control cannot transition from ${prior.status} to ${current.status}`);
  }

  const resumed =
    current.status === "running" && (prior.status === "stopped" || prior.status === "paused");
  const expectedEpoch = resumed ? prior.runEpoch + 1 : prior.runEpoch;
  if (current.runEpoch !== expectedEpoch) {
    fail("runEpoch must increase exactly once on resume and remain stable otherwise");
  }
  if (
    resumed &&
    (current.lastResumedAt === null ||
      current.lastResumeAuthorizationHash === null ||
      current.lastResumeAuthorizationHash === prior.lastResumeAuthorizationHash)
  ) {
    fail("Resume requires a new timestamp and authorization hash");
  }
  if (
    !resumed &&
    (current.lastResumedAt !== prior.lastResumedAt ||
      current.lastResumeAuthorizationHash !== prior.lastResumeAuthorizationHash)
  ) {
    fail("Resume metadata can change only during a resume transition");
  }
  if (
    (prior.status === "stop-requested" || prior.status === "stopped") &&
    (current.status === "stop-requested" || current.status === "stopped") &&
    (current.stopRequestedAt !== prior.stopRequestedAt || current.stopReason !== prior.stopReason)
  ) {
    fail("Stop transitions must preserve the original stop request");
  }
  if (
    prior.status === "stopped" &&
    current.status === "stopped" &&
    current.stoppedAt !== prior.stoppedAt
  ) {
    fail("A durable stop acknowledgement is immutable");
  }
  if (
    prior.status === "paused" &&
    current.status === "paused" &&
    (current.pausedAt !== prior.pausedAt ||
      current.pauseReason !== prior.pauseReason ||
      current.pauseAttestationHash !== prior.pauseAttestationHash)
  ) {
    fail("A durable pause record is immutable");
  }
  if (
    current.status === "stopped" &&
    current.stopRequestedAt !== null &&
    current.stoppedAt !== null &&
    timestamp(current.stoppedAt) < timestamp(current.stopRequestedAt)
  ) {
    fail("stoppedAt cannot precede stopRequestedAt");
  }
  if (
    prior.lastResumedAt !== null &&
    current.lastResumedAt !== null &&
    timestamp(current.lastResumedAt) < timestamp(prior.lastResumedAt)
  ) {
    fail("lastResumedAt cannot move backward");
  }
}

function assertNumberingTransition(previous: CampaignState, next: CampaignState): void {
  const prior = previous.numbering;
  const current = next.numbering;
  if (
    current.nextExperimentNumber < prior.nextExperimentNumber ||
    current.nextExperimentNumber > prior.nextExperimentNumber + 1
  ) {
    fail("nextExperimentNumber may advance by at most one and cannot decrease");
  }

  const allocated = current.nextExperimentNumber === prior.nextExperimentNumber + 1;
  if (
    allocated &&
    (prior.inFlightExperimentNumber !== null ||
      current.inFlightExperimentNumber !== prior.nextExperimentNumber ||
      current.inFlightKind === null)
  ) {
    fail(
      "Advancing nextExperimentNumber must allocate that number as the sole in-flight experiment",
    );
  }
  if (
    !allocated &&
    current.inFlightExperimentNumber !== prior.inFlightExperimentNumber &&
    current.inFlightExperimentNumber !== null
  ) {
    fail("A new in-flight experiment requires monotonic number allocation");
  }
  if ((current.inFlightExperimentNumber === null) !== (current.inFlightKind === null)) {
    fail("In-flight experiment number and kind must be present together");
  }
  if (
    !allocated &&
    current.inFlightExperimentNumber === prior.inFlightExperimentNumber &&
    current.inFlightKind !== prior.inFlightKind
  ) {
    fail("In-flight experiment kind is immutable after allocation");
  }

  const priorInterrupted = prior.lastInterruptedExperimentNumber ?? 0;
  const currentInterrupted = current.lastInterruptedExperimentNumber ?? 0;
  if (currentInterrupted < priorInterrupted) {
    fail("lastInterruptedExperimentNumber cannot decrease");
  }
  if (
    currentInterrupted > priorInterrupted &&
    currentInterrupted !== prior.inFlightExperimentNumber
  ) {
    fail("Only the previously in-flight experiment can become the interrupted pointer");
  }
  if (currentInterrupted > priorInterrupted && current.inFlightExperimentNumber !== null) {
    fail("An interrupted experiment cannot remain in flight");
  }
  if (
    prior.inFlightExperimentNumber !== null &&
    current.inFlightExperimentNumber === null &&
    current.lastInterruptedExperimentNumber !== prior.inFlightExperimentNumber &&
    next.reconstruction.lastFullySealedExperimentNumber !== prior.inFlightExperimentNumber
  ) {
    fail("Clearing an in-flight experiment requires a sealed or interrupted durable pointer");
  }
  if (next.control.status === "stopped" && current.inFlightExperimentNumber !== null) {
    fail("A stopped campaign cannot retain an in-flight experiment");
  }
}

function assertChampionTransition(previous: CampaignState, next: CampaignState): void {
  assertImmutable("Baseline champion", previous.champions.baseline, next.champions.baseline);
  assertPointerDidNotRegress("Active champion", previous.champions.active, next.champions.active);

  const priorCertified = previous.champions.certified;
  const currentCertified = next.champions.certified;
  if (priorCertified !== null && currentCertified === null) {
    fail("Certified champion cannot be cleared");
  }
  if (priorCertified !== null && currentCertified !== null) {
    assertPointerDidNotRegress("Certified champion", priorCertified, currentCertified);
  }
  if (
    currentCertified !== null &&
    (priorCertified === null ||
      currentCertified.experimentNumber > priorCertified.experimentNumber) &&
    !sameChampionIdentity(currentCertified, next.champions.active)
  ) {
    fail("A newly certified champion must be the current active champion");
  }
  if (currentCertified !== null && currentCertified.experimentNumber === 0) {
    fail("Experiment 000 is a baseline anchor, not a certified improvement");
  }
  const certifiedAdvanced =
    currentCertified !== null &&
    (priorCertified === null ||
      currentCertified.experimentNumber > priorCertified.experimentNumber);
  if (
    certifiedAdvanced &&
    currentCertified.sourceSealHash !== next.reconstruction.experimentSealChainHead
  ) {
    fail("Certification must bind the newly sealed feedback-dark audit");
  }

  const activeAdvanced =
    next.champions.active.experimentNumber > previous.champions.active.experimentNumber;
  if (
    activeAdvanced &&
    (next.reconstruction.lastFullySealedExperimentNumber !==
      next.champions.active.experimentNumber ||
      next.reconstruction.experimentSealChainHead !== next.champions.active.sourceSealHash)
  ) {
    fail("An active champion can advance only to the newly sealed experiment");
  }
  if (
    activeAdvanced &&
    next.holdout.freshValidationSetsRemaining !== previous.holdout.freshValidationSetsRemaining - 1
  ) {
    fail("Active promotion must atomically consume one fresh-validation set");
  }
  if (certifiedAdvanced && activeAdvanced) {
    fail("Active promotion and feedback-dark certification require separate experiments");
  }
  if (
    certifiedAdvanced &&
    (next.reconstruction.lastFullySealedExperimentNumber === null ||
      next.reconstruction.lastFullySealedExperimentNumber <= next.champions.active.experimentNumber)
  ) {
    fail("Certification must come from a later feedback-dark audit experiment");
  }
  if (
    certifiedAdvanced &&
    next.holdout.shadowSlicesRemaining !== previous.holdout.shadowSlicesRemaining - 1
  ) {
    fail("Certification must atomically consume one shadow slice");
  }

  const pointersChanged =
    !equal(previous.champions.active, next.champions.active) ||
    !equal(previous.champions.certified, next.champions.certified);
  const sealAdvanced =
    (next.reconstruction.lastFullySealedExperimentNumber ?? -1) >
    (previous.reconstruction.lastFullySealedExperimentNumber ?? -1);
  if (pointersChanged && !sealAdvanced) {
    fail("Champion pointers can change only with a newly sealed decision");
  }
  if (
    pointersChanged &&
    timestamp(next.champions.updatedAt) < timestamp(previous.champions.updatedAt)
  ) {
    fail("Champion pointer timestamp cannot move backward");
  }
  if (!pointersChanged && next.champions.updatedAt !== previous.champions.updatedAt) {
    fail("Champion timestamp cannot change when neither pointer changed");
  }
}

function assertBudgetTransition(previous: CampaignState, next: CampaignState): void {
  assertImmutable("Budget policy", previous.budget.policyHash, next.budget.policyHash);
  let usageChanged = false;

  for (const [usageField, limitField] of USAGE_LIMIT_PAIRS) {
    if (next.budget.usage[usageField] < previous.budget.usage[usageField]) {
      fail(`Budget usage ${usageField} cannot decrease`);
    }
    if (next.budget.usage[usageField] > next.budget.limits[limitField]) {
      fail(`Budget usage ${usageField} cannot exceed limit ${limitField}`);
    }
    usageChanged ||= next.budget.usage[usageField] !== previous.budget.usage[usageField];
  }

  let extensibleLimitsChanged = false;
  for (const field of EXTENSIBLE_LIMITS) {
    if (next.budget.limits[field] < previous.budget.limits[field]) {
      fail(`Budget limit ${field} cannot decrease`);
    }
    extensibleLimitsChanged ||= next.budget.limits[field] !== previous.budget.limits[field];
  }
  for (const field of LINEAGE_FROZEN_LIMITS) {
    if (next.budget.limits[field] !== previous.budget.limits[field]) {
      fail(`Statistical/privacy budget limit ${field} is frozen for the lineage`);
    }
  }

  if (
    extensibleLimitsChanged &&
    next.budget.authorizationHash === previous.budget.authorizationHash
  ) {
    fail("Increasing a budget limit requires a new authorization hash");
  }
  if (
    !extensibleLimitsChanged &&
    next.budget.authorizationHash !== previous.budget.authorizationHash
  ) {
    fail("Budget authorization hash cannot change when limits are unchanged");
  }
  if (
    usageChanged &&
    next.budget.accountingAttestationHash === previous.budget.accountingAttestationHash
  ) {
    fail("Budget usage changes require a new accounting attestation");
  }
  if (
    !usageChanged &&
    next.budget.accountingAttestationHash !== previous.budget.accountingAttestationHash
  ) {
    fail("Budget accounting attestation cannot change without a usage change");
  }
}

function assertHoldoutTransition(previous: CampaignState, next: CampaignState): void {
  assertImmutable("Holdout policy", previous.holdout.policyHash, next.holdout.policyHash);
  if (
    next.holdout.generation < previous.holdout.generation ||
    next.holdout.generation > previous.holdout.generation + 1
  ) {
    fail("Holdout generation may advance by at most one and cannot decrease");
  }

  const replenished = next.holdout.generation === previous.holdout.generation + 1;
  const capacityIncreased =
    next.holdout.freshValidationSetsRemaining > previous.holdout.freshValidationSetsRemaining ||
    next.holdout.shadowSlicesRemaining > previous.holdout.shadowSlicesRemaining;
  if (replenished && !capacityIncreased) {
    fail("A new holdout generation must increase at least one capacity");
  }
  if (capacityIncreased && !replenished) {
    fail("Holdout capacity can increase only in a new authorized generation");
  }
  if (
    replenished &&
    (next.holdout.replenishmentAuthorizationHash === null ||
      next.holdout.replenishmentAuthorizationHash ===
        previous.holdout.replenishmentAuthorizationHash)
  ) {
    fail("A new holdout generation requires a new replenishment authorization");
  }
  if (
    !replenished &&
    next.holdout.replenishmentAuthorizationHash !== previous.holdout.replenishmentAuthorizationHash
  ) {
    fail("Holdout replenishment authorization can change only with its generation");
  }
  const holdoutPayloadChanged =
    next.holdout.freshValidationSetsRemaining !== previous.holdout.freshValidationSetsRemaining ||
    next.holdout.shadowSlicesRemaining !== previous.holdout.shadowSlicesRemaining ||
    next.holdout.generation !== previous.holdout.generation ||
    next.holdout.replenishmentAuthorizationHash !== previous.holdout.replenishmentAuthorizationHash;
  if (
    holdoutPayloadChanged &&
    next.holdout.availabilityAttestationHash === previous.holdout.availabilityAttestationHash
  ) {
    fail("Holdout state changes require a new availability attestation");
  }
  if (
    !holdoutPayloadChanged &&
    next.holdout.availabilityAttestationHash !== previous.holdout.availabilityAttestationHash
  ) {
    fail("Holdout attestation cannot change without a holdout-state change");
  }
}

function assertReconstructionTransition(previous: CampaignState, next: CampaignState): void {
  const priorNumber = previous.reconstruction.lastFullySealedExperimentNumber ?? -1;
  const currentNumber = next.reconstruction.lastFullySealedExperimentNumber ?? -1;
  if (currentNumber < priorNumber) {
    fail("Last fully sealed experiment cannot move backward");
  }
  if (
    currentNumber === priorNumber &&
    next.reconstruction.experimentSealChainHead !== previous.reconstruction.experimentSealChainHead
  ) {
    fail("Seal-chain head cannot change without a newly sealed experiment");
  }
  if (
    currentNumber > priorNumber &&
    previous.numbering.inFlightExperimentNumber !== currentNumber
  ) {
    fail("Only the previously in-flight experiment can advance the seal-chain pointer");
  }
  if (
    currentNumber > priorNumber &&
    (next.reconstruction.experimentSealChainHead === null ||
      next.reconstruction.experimentSealChainHead ===
        previous.reconstruction.experimentSealChainHead)
  ) {
    fail("A newly sealed experiment requires a distinct next seal-chain head");
  }
  if (currentNumber > priorNumber && next.numbering.inFlightExperimentNumber !== null) {
    fail("A fully sealed experiment cannot remain in flight");
  }
  const priorDecision = previous.reconstruction.lastSealedDecision;
  const currentDecision = next.reconstruction.lastSealedDecision;
  if (currentNumber === priorNumber && !equal(priorDecision, currentDecision)) {
    fail("Last sealed decision cannot change without a new sealed experiment");
  }
  if (
    currentNumber > priorNumber &&
    (currentDecision === null || currentDecision.experimentNumber !== currentNumber)
  ) {
    fail("Every newly sealed experiment requires its signed terminal decision");
  }
  if (currentNumber > priorNumber && currentDecision !== null) {
    if (
      timestamp(currentDecision.sealedAt) < timestamp(previous.createdAt) ||
      timestamp(currentDecision.sealedAt) > timestamp(next.createdAt)
    ) {
      fail("A sealed decision timestamp must fall within its campaign transition");
    }
    const priorFresh = previous.holdout.freshValidationSetsRemaining;
    const currentFresh = next.holdout.freshValidationSetsRemaining;
    const priorShadow = previous.holdout.shadowSlicesRemaining;
    const currentShadow = next.holdout.shadowSlicesRemaining;
    if (
      currentDecision.stage === "validation" &&
      (currentFresh !== priorFresh - 1 || currentShadow !== priorShadow)
    ) {
      fail("Every decided validation must consume exactly one fresh-validation set");
    }
    if (
      currentDecision.stage === "shadow" &&
      (currentShadow !== priorShadow - 1 || currentFresh !== priorFresh)
    ) {
      fail("Every decided shadow audit must consume exactly one shadow slice");
    }
    if (
      currentDecision.stage === "pre-validation" &&
      (currentFresh !== priorFresh || currentShadow !== priorShadow)
    ) {
      fail("A pre-validation disposition cannot consume holdout capacity");
    }
    const expectedKind = currentDecision.stage === "shadow" ? "shadow" : "optimization";
    if (previous.numbering.inFlightKind !== expectedKind) {
      fail("Sealed decision stage must match the allocated experiment kind");
    }
    const activeAdvanced =
      next.champions.active.experimentNumber > previous.champions.active.experimentNumber;
    const priorCertifiedExperiment = previous.champions.certified?.experimentNumber ?? -1;
    const currentCertifiedExperiment = next.champions.certified?.experimentNumber ?? -1;
    const certifiedAdvanced = currentCertifiedExperiment > priorCertifiedExperiment;
    if (
      (currentDecision.stage === "validation" && currentDecision.disposition === "promoted") !==
      activeAdvanced
    ) {
      fail("Active champion movement must match the signed validation disposition");
    }
    if (
      (currentDecision.stage === "shadow" && currentDecision.disposition === "certified") !==
      certifiedAdvanced
    ) {
      fail("Certified champion movement must match the signed shadow disposition");
    }
  }

  const recoveryAuthorizationChanged =
    next.reconstruction.lastControllerRecoveryAuthorizationHash !==
    previous.reconstruction.lastControllerRecoveryAuthorizationHash;
  const recoveryLockChanged =
    next.reconstruction.lastControllerRecoveryLockHash !==
    previous.reconstruction.lastControllerRecoveryLockHash;
  if (recoveryAuthorizationChanged !== recoveryLockChanged) {
    fail("Controller recovery authorization and observed-lock hash must advance together");
  }
  const interruptionAdvanced =
    (next.numbering.lastInterruptedExperimentNumber ?? -1) >
    (previous.numbering.lastInterruptedExperimentNumber ?? -1);
  if (currentNumber > priorNumber && interruptionAdvanced) {
    fail("One experiment cannot be both fully sealed and interrupted");
  }
  if (
    interruptionAdvanced &&
    next.reconstruction.brokerExposureStateAttestationHash ===
      previous.reconstruction.brokerExposureStateAttestationHash
  ) {
    fail("Interrupted work must advance the broker-exposure attestation");
  }

  for (const field of [
    "brokerExposureStateAttestationHash",
    "repeatedTestingLedgerHash",
    "privacyLedgerHash",
    "cacheStateAttestationHash",
    "publicationQueueHash",
    "lastControllerRecoveryAuthorizationHash",
    "lastControllerRecoveryLockHash",
  ] as const) {
    if (previous.reconstruction[field] !== null && next.reconstruction[field] === null) {
      fail(`Reconstruction pointer ${field} cannot be cleared`);
    }
  }
}

export function assertInitialCampaignState(state: CampaignState): void {
  if (state.revision !== 0 || state.previousStateHash !== null) {
    fail("Initial campaign state must be revision zero without a predecessor");
  }
  if (
    state.control.status !== "running" ||
    state.control.runEpoch !== 0 ||
    state.control.lastResumedAt !== null ||
    state.control.lastResumeAuthorizationHash !== null ||
    state.numbering.nextExperimentNumber !== 1 ||
    state.numbering.inFlightExperimentNumber !== null ||
    state.numbering.inFlightKind !== null ||
    state.numbering.lastInterruptedExperimentNumber !== null
  ) {
    fail("A new campaign must begin running at experiment number 1 with no in-flight work");
  }
  if (
    state.champions.baseline.experimentNumber !== 0 ||
    !equal(state.champions.baseline, state.champions.active)
  ) {
    fail("A new campaign must begin with experiment 000 as its active baseline");
  }
  if (state.champions.certified !== null) {
    fail("A baseline cannot be labeled a certified improvement");
  }
  if (
    state.reconstruction.lastFullySealedExperimentNumber !== 0 ||
    state.reconstruction.experimentSealChainHead !== state.champions.baseline.sourceSealHash
  ) {
    fail("Initial reconstruction state must point to the sealed baseline");
  }
  if (
    state.reconstruction.lastSealedDecision !== null ||
    state.reconstruction.brokerExposureStateAttestationHash === null ||
    state.reconstruction.repeatedTestingLedgerHash === null ||
    state.reconstruction.privacyLedgerHash === null ||
    state.reconstruction.lastControllerRecoveryAuthorizationHash !== null ||
    state.reconstruction.lastControllerRecoveryLockHash !== null
  ) {
    fail("Initial campaign must bind mandatory ledgers without prior control decisions");
  }
  const expectedProvenance = [
    {
      artifactName: "harness-registration",
      contentHash: state.harnessRegistrationHash,
    },
  ];
  if (!equal(state.provenanceRefs, expectedProvenance)) {
    fail("Initial campaign provenance must bind the harness registration");
  }
}

export function assertCampaignStateTransition(previous: CampaignState, next: CampaignState): void {
  assertImmutable("Campaign id", previous.campaignId, next.campaignId);
  assertImmutable("Run mode", previous.mode, next.mode);
  assertImmutable("Baseline lineage", previous.baselineLineageId, next.baselineLineageId);
  assertImmutable("Protocol", previous.protocolHash, next.protocolHash);
  assertImmutable(
    "Harness registration",
    previous.harnessRegistrationHash,
    next.harnessRegistrationHash,
  );
  if (next.revision !== previous.revision + 1 || next.previousStateHash !== previous.contentHash) {
    fail("Campaign revisions must form a contiguous content-hash chain");
  }
  const expectedProvenance = [
    {
      artifactName: "harness-registration",
      contentHash: next.harnessRegistrationHash,
    },
    {
      artifactName: "campaign-state",
      contentHash: previous.contentHash,
    },
  ];
  if (!equal(next.provenanceRefs, expectedProvenance)) {
    fail("Campaign revision provenance must bind its harness and predecessor");
  }
  if (timestamp(next.createdAt) < timestamp(previous.createdAt)) {
    fail("Campaign revision timestamps cannot move backward");
  }

  assertControlTransition(previous, next);
  assertNumberingTransition(previous, next);
  assertChampionTransition(previous, next);
  assertBudgetTransition(previous, next);
  assertHoldoutTransition(previous, next);
  assertReconstructionTransition(previous, next);
}
