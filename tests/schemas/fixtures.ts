import { canonicalHash, withContentHash } from "../../src/schemas/canonical.js";
import type { ArtifactFileName, SchemaName } from "../../src/schemas/registry.js";
import { harnessRegistrationFixture, initialCampaignStateFixture } from "../campaign/fixtures.js";

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const COMMIT_A = "a".repeat(40);
export const COMMIT_B = "b".repeat(40);
export const NOW = "2026-07-26T10:00:00.000Z";
export const LATER = "2026-07-26T11:00:00.000Z";

export const aggregateCost = {
  inputTokens: 10,
  outputTokens: 20,
  modelUsd: 0.1,
  sandboxUsd: 0.2,
  totalUsd: 0.3,
  wallTimeMs: 1_000,
};

export const policies = {
  protocol: "protocol-v1",
  broker: "broker-v1",
  extraction: "extraction-v1",
  statistics: "statistics-v1",
  privacy: "privacy-v1",
  weighting: "weighting-v1",
  cache: "cache-v1",
  repeatedTesting: "testing-v1",
  leakScanner: "scanner-v1",
};

export const privacySupport = {
  distinctTaskCountBand: "10-19",
  trajectoryCountBand: "20-39",
  minimumComparedGroupSizeBand: "10-19",
  complementaryCountSuppressionPassed: true,
  differencingBudgetPassed: true,
};

export const signature = {
  algorithm: "ed25519" as const,
  keyId: "broker-key-1",
  signedAt: NOW,
  signature: "A".repeat(86),
};

const leakScanManifest = [
  {
    path: "analysis.json",
    schemaKind: "analysis",
    contentHash: HASH_A,
    byteHash: HASH_B,
    bytes: 128,
  },
] as const;

function leakScanReceipt(): Readonly<Record<string, unknown>> {
  return withContentHash({
    schemaVersion: "1.0.0",
    experimentId: "001-test-change",
    experimentNumber: 1,
    artifactManifest: leakScanManifest,
    artifactManifestHash: canonicalHash(leakScanManifest),
    eventRecordCount: 1,
    eventChainHead: HASH_A,
    protocolHash: HASH_A,
    scannerPolicyVersion: "leak-policy-v1",
    scannerVersion: "scanner-v1",
    checkedAt: NOW,
    status: "passed",
    passed: true,
    matchCountBand: "0",
    signature,
  });
}

function document(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return withContentHash({
    schemaVersion: "1.0.0",
    createdAt: NOW,
    provenanceRefs: [],
    ...payload,
  });
}

export function failureCard(): Readonly<Record<string, unknown>> {
  return {
    cardId: "card-001",
    title: "Recovery after failed execution",
    failurePattern:
      "Failed executions were often followed by another execution without inspection.",
    causalInterpretation: "The recovery policy may retry too quickly.",
    affectedHarnessComponent: "recovery-policy",
    metricIds: ["metric-001"],
    support: privacySupport,
    effectSize: 0.3,
    uncertainty: { lower: 0.1, upper: 0.5 },
    recommendation: "Inspect generic recovery and replanning behavior.",
  };
}

export function schemaFixture(name: SchemaName): unknown {
  switch (name) {
    case "campaignState":
      return initialCampaignStateFixture();
    case "harnessRegistration":
      return harnessRegistrationFixture();
    case "experiment":
      return document({
        experimentNumber: 1,
        slug: "test-change",
        lifecycleState: "analyzed",
        runMode: "research",
        parentExperimentNumber: 0,
        baselineLineageId: "lineage-001",
        championBefore: COMMIT_A,
        championAfter: COMMIT_B,
        protocolHash: HASH_A,
        startedAt: NOW,
        finishedAt: LATER,
        publication: { status: "pending", attempts: 0, remoteReference: null },
        leaderboardEligibility: "unverified",
        finalDisposition: "promoted",
      });
    case "hypothesis":
      return document({
        experimentNumber: 1,
        sourceDiagnosticBriefHash: HASH_A,
        citedCardIds: ["card-001"],
        observedFailurePattern: "Recovery transitions are underused after failed execution.",
        causalClaim: "The harness retries before interpreting failure state.",
        proposedIntervention: "Strengthen generic recovery guidance.",
        affectedHarnessComponents: ["recovery-policy"],
        predictions: {
          discoveryRepair: "More replanning transitions.",
          freshAccuracy: "A small positive change.",
          freshCapability: "No capability reduction.",
          freshCost: "A small token increase.",
          freshLatency: "No material latency change.",
        },
        generalityJustification: "The behavior applies to generic terminal execution.",
        falsificationCriteria: ["No recovery improvement is observed."],
        rollbackCondition: "Roll back on a material capability regression.",
        frozenAt: NOW,
      });
    case "candidate":
      return document({
        experimentNumber: 1,
        repositoryRegistrationId: "pi-private-fork",
        upstreamCommit: COMMIT_A,
        forkBaseCommit: COMMIT_A,
        parentCommit: COMMIT_A,
        candidateCommit: COMMIT_B,
        treeHash: HASH_A,
        dependencyLockHash: HASH_A,
        patchHash: HASH_B,
        changedFiles: ["packages/coding-agent/src/system-prompt.ts"],
        mutation: {
          category: "recovery",
          filesChanged: 1,
          linesAdded: 4,
          linesDeleted: 1,
        },
        gates: [
          {
            name: "pi-check",
            status: "passed",
            durationMs: 1_000,
            cloudExecutionAttestationHash: HASH_A,
          },
        ],
        integrityScan: {
          status: "passed",
          matchCountBand: "0",
          scannedTreeHash: HASH_A,
          policyVersion: "integrity-v1",
        },
        allGatesPassed: true,
        frozenAt: NOW,
      });
    case "evaluationPlan":
      return document({
        experimentNumber: 1,
        mode: "research",
        protocolHash: HASH_A,
        policyVersions: policies,
        panelAttestations: [
          {
            stage: "validation",
            oneUseAttestationHash: HASH_A,
            nonLinkabilityPolicyVersion: "nonlink-v1",
            reuseProhibited: true,
            sealedAt: NOW,
          },
        ],
        aggregatePanelSummary: [
          {
            stage: "validation",
            taskCount: 12,
            hardCount: 7,
            uncertainCount: 3,
            easyCanaryCount: 1,
            underexposedCount: 1,
            stratumCount: 2,
          },
        ],
        stages: [
          {
            stage: "validation",
            taskCount: 12,
            validArmCeiling: 24,
            replacementAttemptCeiling: 4,
            totalAttemptCeiling: 28,
            candidateFirstCount: 6,
            championFirstCount: 6,
            cacheMaySubstitute: false,
            positivePromotionWeight: true,
          },
        ],
        expectedCost: aggregateCost,
        stoppingRules: {
          monetaryCeilingUsd: 10,
          tokenCeiling: 100_000,
          wallTimeCeilingMs: 3_600_000,
          onlineErrorBudgetRemaining: 0.05,
        },
        hypothesisFrozenAt: NOW,
        candidateFrozenAt: NOW,
        brokerSelectionRequestedAt: LATER,
      });
    case "results":
      return document({
        experimentNumber: 1,
        protocolHash: HASH_A,
        repair: {
          disposition: "not-run",
          attemptOrdinal: 0,
          integrityStatus: "not-run",
          aggregateCost,
          signedPolicyAttestationHash: HASH_A,
        },
        validation: {
          disposition: "promote",
          matchedTaskCount: 12,
          stratumCount: 2,
          validFreshArmCount: 24,
          invalidArmTotal: 0,
          outcomes: {
            bothPass: 4,
            challengerOnlyPass: 4,
            championOnlyPass: 1,
            bothFail: 3,
          },
          weightedAccuracy: {
            medianDelta: 0.2,
            credibleInterval: { lower: 0.01, upper: 0.4 },
            probabilityPositive: 0.96,
            probabilityBelowRegressionFloor: 0.01,
            method: "paired-dirichlet-jeffreys",
          },
          stratumRegressionVeto: false,
          integrityVeto: false,
          capabilityVeto: false,
          costVeto: false,
          latencyVeto: false,
          aggregateCost,
          signedResultEnvelopeHash: HASH_A,
        },
        shadow: null,
        compatibleHistoricalIntersections: [],
        totalCost: aggregateCost,
      });
    case "cacheAttestation":
      return document({
        experimentNumber: 1,
        cachePolicyVersion: "cache-v1",
        protocolHash: HASH_A,
        aggregateUseStatus: "partially-used",
        freshnessAgeBands: ["0-24h"],
        driftStatus: "passed",
        smallCountSuppressionApplied: true,
        sealedWindow: { openedAt: NOW, closedAt: LATER },
        repairBudgetCompliant: true,
        aggregateRepairCost: aggregateCost,
        derivationHash: HASH_B,
        signature,
      });
    case "behavioralEvidence":
      return document({
        experimentNumber: 1,
        sourceEnvelopeHash: HASH_A,
        protocolHash: HASH_A,
        policyVersions: policies,
        analysisWindow: { openedAt: NOW, closedAt: LATER, support: privacySupport },
        metrics: [
          {
            metricId: "metric-001",
            feature: "recovery-transition",
            cohort: "candidate",
            support: privacySupport,
            prevalence: 0.5,
            comparisonPrevalence: 0.2,
            effectSize: 0.3,
            uncertainty: { lower: 0.1, upper: 0.5 },
            direction: "higher",
          },
        ],
        suppressedFindingCountBand: "1-4",
        releaseChecksPassed: true,
        derivationHash: HASH_B,
      });
    case "failureCards":
      return document({
        experimentNumber: 1,
        behavioralEvidenceHash: HASH_A,
        cards: [failureCard()],
        suppressionApplied: true,
        policyVersions: policies,
      });
    case "diagnosticBrief":
      return document({
        experimentNumber: 1,
        releaseId: "release-001",
        sourceExperimentNumber: 1,
        aggregateEvidenceHash: HASH_A,
        failureCardsHash: HASH_B,
        policyVersions: policies,
        status: "actionable-evidence",
        cards: [failureCard()],
        limitations: ["Aggregate evidence is uncertain."],
        oneUse: true,
        expiresAt: LATER,
      });
    case "analysis":
      return document({
        experimentNumber: 1,
        hypothesisHash: HASH_A,
        resultsHash: HASH_B,
        hypothesisSupported: true,
        citedFailureCardIds: ["card-001"],
        unexpectedEffects: [],
        recommendations: ["Continue monitoring generic recovery behavior."],
        uncertaintySummary: "Evidence is positive but based on a bounded panel.",
      });
    case "decision":
      return document({
        experimentNumber: 1,
        repairDisposition: "passed",
        challenger: true,
        validationDisposition: "promote",
        shadowDisposition: "not-run",
        activeChampionTransition: {
          beforeCommit: COMMIT_A,
          afterCommit: COMMIT_B,
          changed: true,
        },
        certifiedChampionTransition: null,
        policyThresholdsHash: HASH_A,
        machineRationaleCode: "promotion-thresholds-passed",
        oneUseConsumptionAttestationHash: HASH_B,
        onlineErrorBudgetPassed: true,
        humanOverride: null,
      });
    case "attestation":
      return document({
        experimentNumber: 1,
        schemaChecksPassed: true,
        artifactChecksums: [
          {
            artifactName: "analysis.json",
            contentHash: HASH_A,
            byteHash: HASH_B,
          },
        ],
        pinnedVersions: pinnedVersions(),
        graderLeakScan: leakScanReceipt(),
        eventRecordCount: 1,
        eventChainHead: HASH_A,
        sealedAt: LATER,
        previousExperimentSealHash: null,
        sealChainEntryHash: HASH_B,
        signer: null,
      });
    case "leakScanReceipt":
      return leakScanReceipt();
    case "feedbackEntry":
      return document({
        experimentNumber: 1,
        heading: "Experiment 001",
        lifecycleDisposition: "promoted",
        hypothesisSummary: "Improve generic recovery behavior.",
        decisionSummary: "The candidate met the frozen promotion policy.",
        evidenceRefs: [{ artifactName: "results.json", contentHash: HASH_A }],
        aggregateCost,
        generatedAt: LATER,
      });
    case "eventRecord":
      return document({
        experimentNumber: 1,
        sequence: 0,
        previousEventHash: null,
        eventType: "experiment-created",
        actor: "controller",
        payload: {
          messageCode: "experiment-created",
          artifactName: null,
          stateFrom: null,
          stateTo: "planned",
          aggregateCountBand: null,
          validArmCount: null,
          invalidArmCount: null,
          attestationHash: null,
        },
      });
    case "amendment":
      return document({
        experimentNumber: 1,
        amendmentNumber: 1,
        sealedAttestationHash: HASH_A,
        previousAmendmentHash: null,
        reasonCode: "metadata-correction",
        summary: "Correct a release-safe aggregate metadata field.",
        operations: [
          {
            artifactName: "analysis.json",
            jsonPointer: "/hypothesisSupported",
            priorValueHash: null,
            replacementValue: false,
          },
        ],
        signer: null,
      });
    case "normalizedGraderOutcome":
      return document({
        outcome: "pass",
        boundedReward: 1,
        infrastructureInvalidClass: null,
        integrityStatus: "passed",
        elapsedTimeBucket: "5-15m",
        cpuBucket: "medium",
        memoryBucket: "medium",
        protocolHash: HASH_A,
        environmentFingerprintHash: HASH_B,
        oneUseAttemptDigest: HASH_A,
        derivationHash: HASH_B,
      });
    case "signedResultEnvelope":
      return document({
        envelopeId: "envelope-001",
        experimentNumber: 1,
        mode: "research",
        protocolHash: HASH_A,
        oneUseRequest: {
          requestId: "request-001",
          requestHash: HASH_A,
          dispositionAttestationHash: HASH_B,
          reuseProhibited: true,
        },
        payload: {
          kind: "repair",
          disposition: "passed",
          attemptOrdinal: 1,
          integrityStatus: "passed",
          aggregateCost,
          policyAttestationHash: HASH_A,
        },
        derivation: {
          normalizedOutcomeSetHash: HASH_A,
          cacheAttestationHash: HASH_B,
          behavioralAggregateHash: null,
          rawArtifacts: {
            exported: false,
            retentionDisposition: "destroyed",
            retentionPolicyHash: HASH_B,
          },
          derivedAt: LATER,
        },
        releaseChecks: {
          schemaPassed: true,
          graderCanaryScanPassed: true,
          contentFingerprintScanPassed: true,
          taskIdentityScanPassed: true,
          privacyThresholdPassed: false,
        },
        signature,
      });
    case "signedBehavioralRelease":
      return document({
        releaseId: "release-001",
        experimentNumber: 1,
        sourceResultEnvelopeHash: HASH_A,
        protocolHash: HASH_A,
        policyVersions: policies,
        support: privacySupport,
        aggregateArtifactHashes: {
          behavioralEvidence: HASH_A,
          failureCards: HASH_B,
          diagnosticBrief: HASH_A,
        },
        suppressedFindingCountBand: "1-4",
        releaseOnce: true,
        signature,
      });
    case "complianceManifest":
      return document({
        manifestId: "manifest-001",
        experimentNumber: 1,
        mode: "research",
        baselineLineageId: "lineage-001",
        protocolHash: HASH_A,
        enabledChannels: {
          diagnosticGeneration: true,
          diagnosticRetrieval: true,
          repairFeedback: true,
          optimizerMcp: true,
          officialEvaluation: false,
        },
        pluginPermissionPolicyHash: HASH_A,
        panelPolicyHash: HASH_B,
        leaderboardEligibility: "unverified",
        failClosed: true,
        issuedAt: NOW,
        signature,
      });
  }
}

export const artifactFixtureByFile: Readonly<
  Record<Exclude<ArtifactFileName, "attestation.json">, () => unknown>
> = {
  "analysis.json": () => schemaFixture("analysis"),
  "behavioral-evidence.json": () => schemaFixture("behavioralEvidence"),
  "cache-attestation.json": () => schemaFixture("cacheAttestation"),
  "candidate.json": () => schemaFixture("candidate"),
  "decision.json": () => schemaFixture("decision"),
  "diagnostic-brief.json": () => schemaFixture("diagnosticBrief"),
  "evaluation-plan.json": () => schemaFixture("evaluationPlan"),
  "experiment.json": () => schemaFixture("experiment"),
  "failure-cards.json": () => schemaFixture("failureCards"),
  "feedback-entry.json": () => schemaFixture("feedbackEntry"),
  "hypothesis.json": () => schemaFixture("hypothesis"),
  "results.json": () => schemaFixture("results"),
};

export function pinnedVersions() {
  return {
    node: "v24.0.0",
    darkFactory: "0.1.0",
    terminalBench: "2.1.0",
    harbor: "0.3.0",
    piCommit: COMMIT_B,
    claudeCode: "2.1.220",
    optimizerModel: "claude-model-1",
    evaluatedModel: "evaluated-model-1",
    sandboxImageDigest: HASH_A,
  };
}
