import type {
  ComplianceChannels,
  ComplianceManifest,
  LeaderboardEligibility,
  RunMode,
} from "../domain/models.js";
import { DarkFactoryError } from "./errors.js";

export function expectedChannels(mode: RunMode): ComplianceChannels {
  return mode === "research"
    ? {
        diagnosticBriefs: true,
        repairFeedback: true,
        optimizerMcp: true,
        adaptiveTaskSelection: true,
        officialEvaluation: false,
      }
    : {
        diagnosticBriefs: false,
        repairFeedback: false,
        optimizerMcp: false,
        adaptiveTaskSelection: false,
        officialEvaluation: true,
      };
}

function sameChannels(left: ComplianceChannels, right: ComplianceChannels): boolean {
  return (
    left.diagnosticBriefs === right.diagnosticBriefs &&
    left.repairFeedback === right.repairFeedback &&
    left.optimizerMcp === right.optimizerMcp &&
    left.adaptiveTaskSelection === right.adaptiveTaskSelection &&
    left.officialEvaluation === right.officialEvaluation
  );
}

export function assertComplianceManifest(manifest: ComplianceManifest): void {
  if (!sameChannels(manifest.channels, expectedChannels(manifest.mode))) {
    throw new DarkFactoryError(
      "CONFIG_INVALID",
      "Compliance channels do not match the immutable run mode",
      { mode: manifest.mode },
    );
  }
  if (manifest.optimizerHasBenchmarkCredentials !== false) {
    throw new DarkFactoryError(
      "CONFIG_INVALID",
      "The optimizer may never possess benchmark credentials",
    );
  }
  if (manifest.localRawEvidenceAllowed !== false) {
    throw new DarkFactoryError("CONFIG_INVALID", "Raw evidence may never be persisted locally");
  }
  if (
    manifest.mode === "submission" &&
    !isSubmissionEligibilityAllowed(manifest.leaderboardEligibility)
  ) {
    throw new DarkFactoryError(
      "FULL_EVAL_FORBIDDEN",
      "Submission mode requires cleared or strict-score-only eligibility",
      { leaderboardEligibility: manifest.leaderboardEligibility },
    );
  }
}

export function isSubmissionEligibilityAllowed(
  eligibility: LeaderboardEligibility,
): boolean {
  return eligibility === "cleared" || eligibility === "strict-score-only";
}

export function assertComparableProtocol(
  expectedProtocolHash: string,
  observedProtocolHash: string,
): void {
  if (expectedProtocolHash !== observedProtocolHash) {
    throw new DarkFactoryError(
      "PROTOCOL_MISMATCH",
      "Evidence from different protocol hashes cannot be compared",
      {
        expectedProtocolHash,
        observedProtocolHash,
      },
    );
  }
}

