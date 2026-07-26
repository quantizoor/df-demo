import type { CampaignState } from "../schemas/control.js";

export interface CampaignReconstructionInputs {
  readonly campaignId: string;
  readonly currentStateHash: string;
  readonly revision: number;
  readonly protocolHash: string;
  readonly baselineLineageId: string;
  readonly harnessRegistrationHash: string;
  readonly nextExperimentNumber: number;
  readonly inFlightExperimentNumber: number | null;
  readonly inFlightKind: CampaignState["numbering"]["inFlightKind"];
  readonly lastInterruptedExperimentNumber: number | null;
  readonly champions: CampaignState["champions"];
  readonly budget: CampaignState["budget"];
  readonly holdout: CampaignState["holdout"];
  readonly lastFullySealedExperimentNumber: number | null;
  readonly experimentSealChainHead: string | null;
  readonly lastSealedDecision: CampaignState["reconstruction"]["lastSealedDecision"];
  readonly brokerExposureStateAttestationHash: string | null;
  readonly repeatedTestingLedgerHash: string | null;
  readonly privacyLedgerHash: string | null;
  readonly cacheStateAttestationHash: string | null;
  readonly publicationQueueHash: string | null;
  readonly lastControllerRecoveryAuthorizationHash: string | null;
  readonly lastControllerRecoveryLockHash: string | null;
}

/**
 * Returns every durable input needed by the controller to restore work.
 *
 * The result deliberately contains only Git/seal pointers, aggregate budgets,
 * and signed ledger hashes. Selection and allocation identities remain in the
 * trusted broker.
 */
export function campaignReconstructionInputs(state: CampaignState): CampaignReconstructionInputs {
  return {
    campaignId: state.campaignId,
    currentStateHash: state.contentHash,
    revision: state.revision,
    protocolHash: state.protocolHash,
    baselineLineageId: state.baselineLineageId,
    harnessRegistrationHash: state.harnessRegistrationHash,
    nextExperimentNumber: state.numbering.nextExperimentNumber,
    inFlightExperimentNumber: state.numbering.inFlightExperimentNumber,
    inFlightKind: state.numbering.inFlightKind,
    lastInterruptedExperimentNumber: state.numbering.lastInterruptedExperimentNumber,
    champions: state.champions,
    budget: state.budget,
    holdout: state.holdout,
    lastFullySealedExperimentNumber: state.reconstruction.lastFullySealedExperimentNumber,
    experimentSealChainHead: state.reconstruction.experimentSealChainHead,
    lastSealedDecision: state.reconstruction.lastSealedDecision,
    brokerExposureStateAttestationHash: state.reconstruction.brokerExposureStateAttestationHash,
    repeatedTestingLedgerHash: state.reconstruction.repeatedTestingLedgerHash,
    privacyLedgerHash: state.reconstruction.privacyLedgerHash,
    cacheStateAttestationHash: state.reconstruction.cacheStateAttestationHash,
    publicationQueueHash: state.reconstruction.publicationQueueHash,
    lastControllerRecoveryAuthorizationHash:
      state.reconstruction.lastControllerRecoveryAuthorizationHash,
    lastControllerRecoveryLockHash: state.reconstruction.lastControllerRecoveryLockHash,
  };
}
