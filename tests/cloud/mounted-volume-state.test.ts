import { mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TrustedHiddenCatalogState } from "../../src/broker/catalog.js";
import type { OneUseLedgerRecord, OneUseLedgerState } from "../../src/broker/ledger.js";
import type { TrustedArtifactRuntimeGuard } from "../../src/cloud/artifact-bridge.js";
import {
  MountedVolumeAtomicOneUseLedgerStore,
  MountedVolumeCloudOptimizerSessionRecordStore,
  type MountedVolumeDurableStateOptions,
  MountedVolumeLinearizableHiddenCatalogCasStore,
  type MountedVolumeStateSemanticsGuard,
} from "../../src/cloud/mounted-volume-state.js";
import type { TrustedCloudArtifactRef } from "../../src/cloud/types.js";
import type { ExperimentIdentity } from "../../src/domain/models.js";
import type { CloudOptimizerProposalResult } from "../../src/optimizer/cloud-session.js";
import { canonicalJson, withContentHash } from "../../src/schemas/canonical.js";

const runtimeGuard: TrustedArtifactRuntimeGuard = {
  assertTrustedCloudRuntime() {},
};

const semanticsGuard: MountedVolumeStateSemanticsGuard = {
  assertLinearizableStateVolume() {},
};

function options(
  root: string,
  controller = "1".repeat(64),
  nonce = "a".repeat(48),
): MountedVolumeDurableStateOptions {
  return {
    volumeRoot: root,
    storeId: "campaign-a",
    controllerInstanceIdHash: controller,
    runtimeGuard,
    semanticsGuard,
    now: () => new Date("2026-07-26T10:00:00.000Z"),
    nonceFactory: () => nonce,
  };
}

function inFlightRecord(index: number): OneUseLedgerRecord {
  return {
    requestHash: index.toString(16).padStart(64, "0"),
    claimToken: `claim-${index}`,
    status: "in-flight",
    dispositionAttestationHash: null,
    ownerInstanceIdHash: "f".repeat(64),
    claimEpoch: 1,
    recoveryRecordHash: null,
    recoveryAuthorizationHash: null,
    envelope: null,
    failureCode: null,
  };
}

function appendRecord(state: OneUseLedgerState, index: number): OneUseLedgerState {
  return {
    revision: state.revision + 1,
    records: {
      ...state.records,
      [`request-${index}`]: inFlightRecord(index),
    },
    usedDispositionAttestations: state.usedDispositionAttestations,
    usedRecoveryAuthorizations: state.usedRecoveryAuthorizations,
  };
}

function artifact(
  uri: `trusted://${string}`,
  sha256: string,
  mediaType: string,
  byteLength: number,
): TrustedCloudArtifactRef {
  return { uri, sha256, mediaType, byteLength };
}

const optimizerExperiment: ExperimentIdentity = {
  number: 1,
  slug: "change-system-prompt",
  kind: "optimization",
  parentExperiment: 0,
  lineageId: "campaign-a",
  protocolHash: "f".repeat(64),
};

function optimizerProposalResult(
  causalClaim = "The generic system prompt is underspecified.",
): CloudOptimizerProposalResult {
  const sourceCommit = "1".repeat(40);
  const candidateCommit = "2".repeat(40);
  const candidateTree = "3".repeat(40);
  const lockSha256 = "4".repeat(64);
  const diffSha256 = "5".repeat(64);
  const bundleSha256 = "6".repeat(64);
  const stateSha256 = "7".repeat(64);
  const hypothesis = {
    hash: causalClaim === "different" ? "9".repeat(64) : "8".repeat(64),
    sourceBriefHash: null,
    causalClaim,
    intervention: "Clarify generic tool selection without task details.",
    predictedRepairBehavior: "Fewer avoidable tool-selection failures.",
    predictedFreshEffect: "A small positive matched-pair effect.",
    falsificationCriteria: ["No repair improvement."],
    rollbackCondition: "Rollback on a fresh regression.",
  };
  const candidate = {
    commit: candidateCommit,
    patchHash: diffSha256,
    changedFiles: ["packages/coding-agent/src/system-prompt.ts"],
    mutationCategory: "system-prompt",
  };
  const setup = withContentHash({
    schemaVersion: 1 as const,
    domain: "dark-factory.optimizer-setup.v1" as const,
    phase: "proposal" as const,
    campaignId: optimizerExperiment.lineageId,
    experimentId: "001-change-system-prompt",
    sourceMode: "private-github" as const,
    registrationId: "a".repeat(64),
    originRepositoryHash: "b".repeat(64),
    sourceCommit,
    sourceTree: "c".repeat(40),
    lockSha256,
    pluginArchiveSha256: "d".repeat(64),
    evidenceArchiveSha256: "e".repeat(64),
    inputStateSha256: null,
  });
  const claude = withContentHash({
    schemaVersion: 1 as const,
    domain: "dark-factory.optimizer-claude.v1" as const,
    phase: "proposal" as const,
    campaignId: optimizerExperiment.lineageId,
    experimentId: "001-change-system-prompt",
    summary: {
      initialized: true as const,
      pluginLoaded: true as const,
      pluginErrors: [],
      sessionId: "claude-session-001",
      model: "claude-test",
      result: "completed" as const,
      totalCostUsd: 0.25,
      turns: 3,
    },
    exitCode: 0,
    stderrSha256: "0".repeat(64),
  });
  const seal = withContentHash({
    schemaVersion: 1 as const,
    domain: "dark-factory.optimizer-proposal.v1" as const,
    campaignId: optimizerExperiment.lineageId,
    experimentId: "001-change-system-prompt",
    sourceCommit,
    candidateCommit,
    candidateTree,
    lockSha256,
    bundleRef: "refs/heads/df/bundle/001-change-system-prompt",
    hypothesis,
    candidate,
    hypothesisReceiptId: "hypothesis-receipt-0001",
    candidateReceiptId: "candidate-receipt-0001",
    integrityPolicyHash: "1".repeat(64),
    bundle: { sha256: bundleSha256, byteLength: 100 },
    diff: { sha256: diffSha256, byteLength: 101 },
    state: { sha256: stateSha256, byteLength: 102 },
  });
  const receipt = (executionId: string) => ({
    provider: "daytona" as const,
    sandboxId: "optimizer-sandbox-001",
    executionId,
    startedAt: "2026-07-26T10:00:00.000Z",
    finishedAt: "2026-07-26T10:00:01.000Z",
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    resourceReport: { peakMemoryMiB: 256, cpuTimeMs: 100 },
  });
  return {
    proposal: { hypothesis, candidate },
    setup,
    claude,
    seal,
    candidateBundle: artifact(
      "trusted://optimizer/candidate-bundle",
      bundleSha256,
      "application/vnd.git.bundle",
      100,
    ),
    candidateDiff: artifact("trusted://optimizer/candidate-diff", diffSha256, "text/x-diff", 101),
    sessionState: artifact(
      "trusted://optimizer/session-state",
      stateSha256,
      "application/x-tar",
      102,
    ),
    setupManifestArtifact: artifact(
      "trusted://optimizer/setup-manifest",
      "2".repeat(64),
      "application/json",
      103,
    ),
    claudeManifestArtifact: artifact(
      "trusted://optimizer/claude-manifest",
      "3".repeat(64),
      "application/json",
      104,
    ),
    sealManifestArtifact: artifact(
      "trusted://optimizer/seal-manifest",
      "4".repeat(64),
      "application/json",
      105,
    ),
    executionReceipts: {
      setup: receipt("execution-setup-0001"),
      claude: receipt("execution-claude-0001"),
      seal: receipt("execution-seal-0001"),
    },
  };
}

describe("mounted-volume durable state stores", () => {
  it("serializes callbacks exactly once and survives a clean controller handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-state-test-"));
    const store = new MountedVolumeAtomicOneUseLedgerStore(options(root));
    const calls = new Map<number, number>();

    await Promise.all(
      Array.from({ length: 12 }, (_, offset) => {
        const index = offset + 1;
        return store.transact((state) => {
          calls.set(index, (calls.get(index) ?? 0) + 1);
          return {
            next: appendRecord(state, index),
            result: index,
          };
        });
      }),
    );
    expect([...calls.values()]).toEqual(Array.from({ length: 12 }, () => 1));
    await store.close();

    const statePath = join(
      root,
      "mutable-state",
      "stores",
      "one-use-ledger-campaign-a",
      "state.json",
    );
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Readonly<Record<string, unknown>>;
    expect(raw).toBe(`${canonicalJson(parsed)}\n`);

    const successor = new MountedVolumeAtomicOneUseLedgerStore(
      options(root, "2".repeat(64), "b".repeat(48)),
    );
    await expect(
      successor.transact((state) => ({
        next: state,
        result: {
          revision: state.revision,
          recordCount: Object.keys(state.records).length,
        },
      })),
    ).resolves.toEqual({ revision: 12, recordCount: 12 });
    await successor.close();
  });

  it("requires provider destruction proof and fences the former lock owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-state-test-"));
    const prior = new MountedVolumeAtomicOneUseLedgerStore(options(root));
    await prior.transact((state) => ({
      next: appendRecord(state, 1),
      result: undefined,
    }));

    const unauthorized = new MountedVolumeAtomicOneUseLedgerStore(
      options(root, "2".repeat(64), "b".repeat(48)),
    );
    await expect(
      unauthorized.transact((state) => ({
        next: state,
        result: undefined,
      })),
    ).rejects.toThrow(/provider-attested recovery is required/u);

    let recoveredEpoch = 0;
    const recoveredStore = new MountedVolumeAtomicOneUseLedgerStore({
      ...options(root, "3".repeat(64), "c".repeat(48)),
      recoveryAuthority: {
        authorize: ({ observedLock, observedLockHash }) => {
          recoveredEpoch = observedLock.fenceEpoch;
          return Promise.resolve({
            schemaVersion: 1,
            domain: "dark-factory.mounted-volume-lock-recovery.v1",
            namespace: observedLock.namespace,
            authorizationId: "provider-destruction-1",
            priorLockHash: observedLockHash,
            priorFenceEpoch: observedLock.fenceEpoch,
            providerTerminationAttestationHash: "d".repeat(64),
            authorizedAt: "2026-07-26T10:00:00.000Z",
            signerKeyId: "provider-termination-key",
            signatureHash: "e".repeat(64),
          });
        },
      },
    });
    await expect(
      recoveredStore.transact((state) => ({
        next: appendRecord(state, 2),
        result: state.revision,
      })),
    ).resolves.toBe(1);
    expect(recoveredEpoch).toBe(1);
    await expect(prior.transact((state) => ({ next: state, result: undefined }))).rejects.toThrow(
      /ownership|continuity/u,
    );
    await recoveredStore.close();
  });

  it("rejects a symlink substituted for an existing state file", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-state-test-"));
    const store = new MountedVolumeAtomicOneUseLedgerStore(options(root));
    await store.transact((state) => ({
      next: appendRecord(state, 1),
      result: undefined,
    }));
    await store.close();
    const statePath = join(
      root,
      "mutable-state",
      "stores",
      "one-use-ledger-campaign-a",
      "state.json",
    );
    const outside = join(root, "outside-state.json");
    await writeFile(outside, "{}\n", { encoding: "utf8", mode: 0o600 });
    await unlink(statePath);
    await symlink(outside, statePath);

    const successor = new MountedVolumeAtomicOneUseLedgerStore(
      options(root, "2".repeat(64), "b".repeat(48)),
    );
    await expect(
      successor.transact((state) => ({ next: state, result: undefined })),
    ).rejects.toThrow(/single-link regular file/u);
    await successor.close();
  });

  it("rejects rollback to an older valid content-hashed state envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-state-test-"));
    const statePath = join(
      root,
      "mutable-state",
      "stores",
      "one-use-ledger-campaign-a",
      "state.json",
    );
    const store = new MountedVolumeAtomicOneUseLedgerStore(options(root));
    await store.transact((state) => ({
      next: appendRecord(state, 1),
      result: undefined,
    }));
    const oldEnvelope = await readFile(statePath, "utf8");
    await store.transact((state) => ({
      next: appendRecord(state, 2),
      result: undefined,
    }));
    await store.close();
    await writeFile(statePath, oldEnvelope, {
      encoding: "utf8",
      mode: 0o600,
    });

    const successor = new MountedVolumeAtomicOneUseLedgerStore(
      options(root, "2".repeat(64), "b".repeat(48)),
    );
    await expect(
      successor.transact((state) => ({ next: state, result: undefined })),
    ).rejects.toThrow(/rolled back|diverges/u);
    await successor.close();
  });

  it("rejects catalog bytes that do not satisfy the trusted hidden schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-state-test-"));
    const store = new MountedVolumeLinearizableHiddenCatalogCasStore(options(root));
    await expect(
      store.transact(() => ({
        next: {
          schemaVersion: 1,
          sensitivity: "trusted-hidden-task-catalog",
          revision: 1,
        } as unknown as TrustedHiddenCatalogState,
        result: undefined,
      })),
    ).rejects.toThrow(/unsupported fields|metadata is malformed/u);
    await store.close();
  });

  it("stores optimizer proposals idempotently and rejects changed identity reuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-state-test-"));
    const store = new MountedVolumeCloudOptimizerSessionRecordStore(options(root));
    const result = optimizerProposalResult();
    await store.put(optimizerExperiment, result);
    await store.put(optimizerExperiment, result);
    await expect(store.get(optimizerExperiment)).resolves.toEqual(result);
    await expect(
      store.put(optimizerExperiment, optimizerProposalResult("different")),
    ).rejects.toThrow(/different content/u);
    await store.close();
  });

  it("fails before lock acquisition when mounted-volume atomicity is not attested", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-state-test-"));
    const store = new MountedVolumeAtomicOneUseLedgerStore({
      ...options(root),
      semanticsGuard: {
        assertLinearizableStateVolume() {
          throw new Error("volume semantics not attested");
        },
      },
    });
    await expect(store.transact((state) => ({ next: state, result: undefined }))).rejects.toThrow(
      /semantics not attested/u,
    );
  });
});
