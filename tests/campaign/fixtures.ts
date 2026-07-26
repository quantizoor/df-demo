import {
  createHarnessRegistration,
  type CampaignStateData,
} from "../../src/campaign/index.js";
import { withContentHash } from "../../src/schemas/canonical.js";
import {
  CONTROL_SCHEMA_VERSION,
  type CampaignState,
  type HarnessRegistration,
} from "../../src/schemas/control.js";
import { assertValidDocument } from "../../src/schemas/registry.js";

export const NOW = "2026-07-26T10:00:00.000Z";
export const LATER = "2026-07-26T10:01:00.000Z";
export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const HASH_C = "c".repeat(64);
export const HASH_D = "d".repeat(64);
export const HASH_E = "e".repeat(64);
export const COMMIT_A = "a".repeat(40);
export const COMMIT_B = "b".repeat(40);

export function harnessRegistrationFixture(
  policyVersion = "repository-policy-v1",
): HarnessRegistration {
  return createHarnessRegistration({
    schemaVersion: CONTROL_SCHEMA_VERSION,
    createdAt: NOW,
    provenanceRefs: [
      {
        artifactName: "operator-authorization",
        contentHash: HASH_A,
      },
      {
        artifactName: "repository-verification",
        contentHash: HASH_B,
      },
    ],
    registrationId: "pi-private-fork",
    registrationAuthorizationHash: HASH_A,
    harnessKind: "pi-coding-agent",
    repositoryType: "private-fork",
    workspaceRelativePath: "pi",
    defaultBranch: "main",
    origin: {
      hostFingerprint: HASH_A,
      repositoryFingerprint: HASH_B,
      fingerprintAlgorithm: "hmac-sha256",
      fingerprintKeyId: "repository-fingerprint-key",
      transport: "ssh",
      verificationAttestationHash: HASH_C,
      verifiedAt: NOW,
      credentialMaterialPersisted: false,
      privateVisibilityVerified: true,
      writableVerified: true,
    },
    upstream: {
      hostFingerprint: HASH_A,
      repositoryFingerprint: HASH_C,
      fingerprintAlgorithm: "hmac-sha256",
      fingerprintKeyId: "repository-fingerprint-key",
      transport: "https",
      verificationAttestationHash: HASH_D,
      verifiedAt: NOW,
      credentialMaterialPersisted: false,
      canonicalPublicSourceVerified: true,
      writeAccessRequired: false,
    },
    provenance: {
      registeredForkCommit: COMMIT_A,
      upstreamCommit: COMMIT_A,
      mergeBaseCommit: COMMIT_A,
      registeredTree: COMMIT_B,
    },
    dependencyLock: {
      path: "pi/package-lock.json",
      contentHash: HASH_E,
      packageManager: "npm",
      installMode: "npm-ci",
    },
    verification: {
      canonicalWorktreeClean: true,
      canonicalWorktreeAttached: true,
      originHeadPublished: true,
      upstreamFetchVerified: true,
      policyVersion,
      attestationHash: HASH_B,
    },
    adapter: {
      adapterId: "pi-rpc",
      executionMode: "rpc",
      sessionsDisabled: true,
      uncontrolledExtensionsDisabled: true,
      uncontrolledContextFilesDisabled: true,
    },
  });
}

export function campaignSeed(
  harnessRegistrationHash = harnessRegistrationFixture().contentHash,
): CampaignStateData {
  const baseline = {
    experimentNumber: 0,
    commit: COMMIT_A,
    sourceSealHash: HASH_A,
  };
  return {
    campaignId: "campaign-001",
    mode: "research",
    baselineLineageId: "lineage-001",
    protocolHash: HASH_B,
    harnessRegistrationHash,
    control: {
      status: "running",
      runEpoch: 0,
      stopRequestedAt: null,
      stopReason: null,
      stoppedAt: null,
      pausedAt: null,
      pauseReason: null,
      pauseAttestationHash: null,
      lastResumedAt: null,
      lastResumeAuthorizationHash: null,
    },
    numbering: {
      nextExperimentNumber: 1,
      inFlightExperimentNumber: null,
      inFlightKind: null,
      lastInterruptedExperimentNumber: null,
    },
    champions: {
      baseline,
      active: baseline,
      certified: null,
      updatedAt: NOW,
    },
    budget: {
      limits: {
        maximumUsd: 100,
        maximumTokens: 1_000_000,
        maximumWallTimeMs: 86_400_000,
        maximumAttempts: 1_000,
        maximumPrivacyReleases: 100,
        maximumPromotionLooks: 50,
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
      policyHash: HASH_C,
      authorizationHash: HASH_D,
      accountingAttestationHash: HASH_E,
    },
    holdout: {
      freshValidationSetsRemaining: 6,
      shadowSlicesRemaining: 2,
      generation: 0,
      policyHash: HASH_D,
      availabilityAttestationHash: HASH_E,
      replenishmentAuthorizationHash: null,
    },
    reconstruction: {
      lastFullySealedExperimentNumber: 0,
      experimentSealChainHead: HASH_A,
      lastSealedDecision: null,
      brokerExposureStateAttestationHash: HASH_B,
      repeatedTestingLedgerHash: HASH_C,
      privacyLedgerHash: HASH_D,
      cacheStateAttestationHash: null,
      publicationQueueHash: null,
      lastControllerRecoveryAuthorizationHash: null,
      lastControllerRecoveryLockHash: null,
    },
  };
}

export function initialCampaignStateFixture(): CampaignState {
  const data = campaignSeed();
  const value: unknown = withContentHash({
    schemaVersion: CONTROL_SCHEMA_VERSION,
    createdAt: NOW,
    provenanceRefs: [
      {
        artifactName: "harness-registration",
        contentHash: data.harnessRegistrationHash,
      },
    ],
    revision: 0,
    previousStateHash: null,
    ...data,
  });
  assertValidDocument("campaignState", value);
  return value;
}
