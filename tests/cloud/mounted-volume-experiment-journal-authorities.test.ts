import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TrustedArtifactRuntimeGuard } from "../../src/cloud/artifact-bridge.js";
import {
  MountedVolumeReleaseSafeExperimentArtifactAssembler,
  MountedVolumeTrustedExperimentSealAuthority,
  MountedVolumeTrustedJournalInterruptionAttestor,
} from "../../src/cloud/mounted-volume-experiment-journal-authorities.js";
import type {
  MountedVolumeDurableStateOptions,
  MountedVolumeStateSemanticsGuard,
} from "../../src/cloud/mounted-volume-state.js";
import { createEd25519Signature } from "../../src/evidence/signatures.js";
import type { LeakScanSubject } from "../../src/evidence/store.js";
import type { ReleaseSafeFinalExperimentSnapshot } from "../../src/orchestrator/experiment-journal.js";
import {
  canonicalHash,
  withContentHash,
} from "../../src/schemas/canonical.js";
import {
  REQUIRED_PRESEAL_ARTIFACT_FILES,
  artifactFileSchemas,
} from "../../src/schemas/registry.js";
import { schemaFixture } from "../schemas/fixtures.js";

const temporaryDirectories: string[] = [];
const NOW = "2026-07-26T10:00:00.000Z";
const LATER = "2026-07-26T11:00:00.000Z";
const PROTOCOL = "1".repeat(64);
const BASELINE = "2".repeat(40);
const CANDIDATE = "3".repeat(40);
const SCANNER_KEY_ID = "journal-leak-scanner";
const scannerKeys = generateKeyPairSync("ed25519");

const runtimeGuard: TrustedArtifactRuntimeGuard = {
  assertTrustedCloudRuntime() {},
};
const semanticsGuard: MountedVolumeStateSemanticsGuard = {
  assertLinearizableStateVolume() {},
};

function stateOptions(
  root: string,
  nonce = "a".repeat(48),
): MountedVolumeDurableStateOptions {
  return {
    volumeRoot: root,
    storeId: "journal-authority-tests",
    controllerInstanceIdHash: "b".repeat(64),
    runtimeGuard,
    semanticsGuard,
    now: () => new Date(NOW),
    nonceFactory: () => nonce,
  };
}

function snapshot(): ReleaseSafeFinalExperimentSnapshot {
  const withoutHash = {
    schemaVersion: 1 as const,
    experimentName: "001-authority-test",
    experiment: {
      number: 1,
      slug: "authority-test",
      kind: "optimization" as const,
      parentExperiment: 0,
      lineageId: "campaign-a",
      protocolHash: PROTOCOL,
    },
    startedAt: NOW,
    finishedAt: LATER,
    activeChampionBefore: {
      baselineCommit: BASELINE,
      activeExperiment: 0,
      activeCommit: BASELINE,
      certifiedExperiment: null,
      certifiedCommit: null,
      updatedAt: NOW,
      sourceSealHash: "4".repeat(64),
    },
    initialBudget: {
      limits: {
        maximumUsd: 100,
        maximumTokens: 100_000,
        maximumWallTimeMs: 3_600_000,
        maximumAttempts: 100,
        maximumPrivacyReleases: 5,
        maximumPromotionLooks: 5,
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
    },
    finalBudget: {
      limits: {
        maximumUsd: 100,
        maximumTokens: 100_000,
        maximumWallTimeMs: 3_600_000,
        maximumAttempts: 100,
        maximumPrivacyReleases: 5,
        maximumPromotionLooks: 5,
        maximumOnlineError: 0.05,
      },
      usage: {
        spentUsd: 1,
        tokens: 10,
        wallTimeMs: 100,
        attempts: 0,
        privacyReleases: 0,
        promotionLooks: 0,
        onlineErrorSpent: 0,
      },
    },
    proposal: {
      hypothesis: {
        hash: "5".repeat(64),
        sourceBriefHash: null,
        causalClaim: "Generic recovery policy is incomplete.",
        intervention: "Strengthen generic recovery policy.",
        predictedRepairBehavior: "More failures are inspected.",
        predictedFreshEffect: "A small general improvement.",
        falsificationCriteria: ["No broad recovery improvement."],
        rollbackCondition: "Roll back after a capability regression.",
      },
      candidate: {
        commit: CANDIDATE,
        patchHash: "6".repeat(64),
        changedFiles: ["packages/coding-agent/src/system-prompt.ts"],
        mutationCategory: "recovery",
      },
    },
    gates: {
      passed: false,
      integrityPassed: true,
      protocolHash: PROTOCOL,
      checksHash: "7".repeat(64),
      aggregateCostUsd: 1,
      tokens: 10,
      wallTimeMs: 100,
      failureCode: "cloud-check-failed",
    },
    repair: null,
    validation: null,
    analysisHash: "8".repeat(64),
    disposition: "rejected" as const,
    evaluationStage: "pre-validation" as const,
    promotedCandidate: null,
    diagnosticBrief: null,
  };
  return {
    ...withoutHash,
    assemblyRequestHash: canonicalHash({
      domain: "dark-factory.release-safe-experiment-assembly.v1",
      ...withoutHash,
    }),
  };
}

function policyArtifactsWithUnsafeExtra(): Readonly<Record<string, unknown>> {
  const analysis = schemaFixture("analysis") as Readonly<
    Record<string, unknown>
  >;
  return {
    "analysis.json": withContentHash({
      ...analysis,
      rawTaskId: "hidden-task-001",
    }),
    "decision.json": schemaFixture("decision"),
    "experiment.json": schemaFixture("experiment"),
    "feedback-entry.json": schemaFixture("feedbackEntry"),
    "hypothesis.json": schemaFixture("hypothesis"),
  };
}

function subject(): LeakScanSubject {
  const artifactManifest = [...REQUIRED_PRESEAL_ARTIFACT_FILES]
    .sort()
    .map((path, index) => ({
      path,
      schemaKind: artifactFileSchemas[path],
      contentHash: (index % 10).toString().repeat(64),
      byteHash: ((index + 1) % 10).toString().repeat(64),
      bytes: 128 + index,
    }));
  return {
    schemaVersion: "1.0.0",
    experimentId: "001-authority-test",
    experimentNumber: 1,
    artifactManifest,
    artifactManifestHash: canonicalHash(artifactManifest),
    eventRecordCount: 4,
    eventChainHead: "a".repeat(64),
    protocolHash: PROTOCOL,
  };
}

function sealInput(scanSubject = subject()) {
  const assemblyRequestHash = "c".repeat(64);
  const previousExperimentSealHash = null;
  return {
    requestHash: canonicalHash({
      domain: "dark-factory.experiment-seal-authorization.v1",
      subject: scanSubject,
      previousExperimentSealHash,
      assemblyRequestHash,
    }),
    subject: scanSubject,
    previousExperimentSealHash,
    assemblyRequestHash,
  };
}

function pinnedVersions() {
  return {
    node: "24.1.0",
    darkFactory: "0.1.0",
    terminalBench: "2.1",
    harbor: "0.1.0",
    piCommit: "d".repeat(40),
    claudeCode: "2.1.217",
    optimizerModel: "claude-opus-4-1",
    evaluatedModel: "pi-evaluated-model",
    sandboxImageDigest: "e".repeat(64),
  };
}

function scannerResult(input: ReturnType<typeof sealInput>) {
  return {
    requestHash: input.requestHash,
    subjectHash: canonicalHash(input.subject),
    scannerPolicyVersion: "leak-policy-v1",
    scannerVersion: "scanner-v1",
    checkedAt: NOW,
    passed: true,
    matchCount: 0,
    scanAttestationHash: "f".repeat(64),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("mounted-volume experiment artifact assembler", () => {
  it("rejects extra provider fields before accepting any artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-journal-authority-"));
    temporaryDirectories.push(root);
    const input = snapshot();
    const assembler =
      new MountedVolumeReleaseSafeExperimentArtifactAssembler({
        durableState: stateOptions(root),
        policyProvider: {
          provide: vi.fn(async () => ({
            schemaVersion: 1 as const,
            assemblyRequestHash: input.assemblyRequestHash,
            policyAttestationHash: "1".repeat(64),
            artifacts: {},
            extra: "not-allowed",
          })) as never,
        },
        provenanceProvider: {
          provide: vi.fn(async () => ({})) as never,
        },
        taskIdentityExclusionAuthority: {
          assertTaskFree: vi.fn(async () => ({})) as never,
        },
      });

    await expect(assembler.assemble(input)).rejects.toThrow(
      /non-canonical fields/u,
    );
    await assembler.close();
  });

  it("fails closed for missing evidence and raw task-shaped artifact fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-journal-authority-"));
    temporaryDirectories.push(root);
    const input = snapshot();
    const assembler =
      new MountedVolumeReleaseSafeExperimentArtifactAssembler({
        durableState: stateOptions(root),
        policyProvider: {
          provide: vi.fn(async () => ({
            schemaVersion: 1 as const,
            assemblyRequestHash: input.assemblyRequestHash,
            policyAttestationHash: "1".repeat(64),
            artifacts: policyArtifactsWithUnsafeExtra(),
          })) as never,
        },
        provenanceProvider: {
          provide: vi.fn(async () => ({
            schemaVersion: 1 as const,
            assemblyRequestHash: input.assemblyRequestHash,
            provenanceAttestationHash: "2".repeat(64),
            evidence: {
              correctnessGateHash: input.gates.checksHash,
              brokerEvidenceHash: null,
              cacheEvidenceHash: "3".repeat(64),
            },
            artifacts: {},
          })) as never,
        },
        taskIdentityExclusionAuthority: {
          assertTaskFree: vi.fn(async () => ({})) as never,
        },
      });

    await expect(assembler.assemble(input)).rejects.toThrow(
      /non-canonical fields|schema validation/u,
    );
    await assembler.close();
  });
});

describe("mounted-volume experiment seal authority", () => {
  it("scans, signs, verifies, persists, and replays one exact authorization", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-journal-authority-"));
    temporaryDirectories.push(root);
    const input = sealInput();
    const scan = vi.fn(async () => scannerResult(input));
    const sign = vi.fn(async (request: {
      readonly receipt: Readonly<Record<string, unknown>>;
    }) =>
      createEd25519Signature(
        request.receipt,
        scannerKeys.privateKey,
        SCANNER_KEY_ID,
        NOW,
      ));
    const authority = new MountedVolumeTrustedExperimentSealAuthority({
      durableState: stateOptions(root),
      scanner: {
        boundary: "trusted-cloud-deterministic-leak-scanner",
        scan,
      },
      keyAuthority: {
        boundary: "trusted-cloud-leak-scan-key",
        keyId: SCANNER_KEY_ID,
        signLeakScanReceipt: sign,
      },
      scannerPublicKey: scannerKeys.publicKey,
      pinnedVersions: {
        resolve: vi.fn(async () => pinnedVersions()),
      },
    });

    const first = await authority.authorize(input);
    const second = await authority.authorize(structuredClone(input));

    expect(second).toEqual(first);
    expect(scan).toHaveBeenCalledOnce();
    expect(sign).toHaveBeenCalledOnce();
    expect(first.authorityAttestationHash).toBe(
      first.leakScanReceipt.contentHash,
    );
    await authority.close();
  });

  it("never exposes the signing operation when scanning fails or adds fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-journal-authority-"));
    temporaryDirectories.push(root);
    const input = sealInput();
    const sign = vi.fn(async () => {
      throw new Error("must not sign");
    });
    const authority = new MountedVolumeTrustedExperimentSealAuthority({
      durableState: stateOptions(root),
      scanner: {
        boundary: "trusted-cloud-deterministic-leak-scanner",
        scan: vi.fn(async () => ({
          ...scannerResult(input),
          passed: false,
          extra: "signing-oracle-probe",
        })) as never,
      },
      keyAuthority: {
        boundary: "trusted-cloud-leak-scan-key",
        keyId: SCANNER_KEY_ID,
        signLeakScanReceipt: sign,
      },
      scannerPublicKey: scannerKeys.publicKey,
      pinnedVersions: {
        resolve: vi.fn(async () => pinnedVersions()),
      },
    });

    await expect(authority.authorize(input)).rejects.toThrow(
      /non-canonical fields/u,
    );
    expect(sign).not.toHaveBeenCalled();
    await authority.close();
  });

  it("resumes a pending authorization after a clean controller crash handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-journal-authority-"));
    temporaryDirectories.push(root);
    const input = sealInput();
    const first = new MountedVolumeTrustedExperimentSealAuthority({
      durableState: stateOptions(root, "1".repeat(48)),
      scanner: {
        boundary: "trusted-cloud-deterministic-leak-scanner",
        scan: vi.fn(async () => {
          throw new Error("provider handoff");
        }),
      },
      keyAuthority: {
        boundary: "trusted-cloud-leak-scan-key",
        keyId: SCANNER_KEY_ID,
        signLeakScanReceipt: vi.fn() as never,
      },
      scannerPublicKey: scannerKeys.publicKey,
      pinnedVersions: {
        resolve: vi.fn(async () => pinnedVersions()),
      },
    });
    await expect(first.authorize(input)).rejects.toThrow(/provider handoff/u);
    await first.close();

    const successor =
      new MountedVolumeTrustedExperimentSealAuthority({
        durableState: stateOptions(root, "2".repeat(48)),
        scanner: {
          boundary: "trusted-cloud-deterministic-leak-scanner",
          scan: vi.fn(async () => scannerResult(input)),
        },
        keyAuthority: {
          boundary: "trusted-cloud-leak-scan-key",
          keyId: SCANNER_KEY_ID,
          signLeakScanReceipt: vi.fn(async (request) =>
            createEd25519Signature(
              request.receipt,
              scannerKeys.privateKey,
              SCANNER_KEY_ID,
              NOW,
            ),
          ),
        },
        scannerPublicKey: scannerKeys.publicKey,
        pinnedVersions: {
          resolve: vi.fn(async () => pinnedVersions()),
        },
      });
    const result = await successor.authorize(input);
    expect(result.leakScanReceipt.passed).toBe(true);
    await successor.close();
  });
});

describe("mounted-volume journal interruption attestor", () => {
  it("persists only a fixed reason code and rejects a conflicting replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-journal-authority-"));
    temporaryDirectories.push(root);
    const attestor =
      new MountedVolumeTrustedJournalInterruptionAttestor({
        durableState: stateOptions(root),
        now: () => new Date(NOW),
      });
    const raw =
      "grader task-987 secret output at /private/hidden timed out";
    const input = {
      experiment: snapshot().experiment,
      phase: "validation",
      reason: raw,
    };
    const first = await attestor.attest(input);
    const replay = await attestor.attest(structuredClone(input));
    expect(replay).toEqual(first);
    expect(first.reasonCode).toBe("cloud-timeout");

    await expect(
      attestor.attest({
        ...input,
        reason: "integrity signature mismatch",
      }),
    ).rejects.toThrow(/changed its fixed reason category/u);
    await attestor.close();

    const statePath = join(
      root,
      "mutable-state",
      "stores",
      "journal-interruptions-journal-authority-tests",
      "state.json",
    );
    const persisted = await readFile(statePath, "utf8");
    expect(persisted).not.toContain(raw);
    expect(persisted).not.toContain("task-987");
    expect(persisted).not.toContain("/private/hidden");
  });
});
