import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TrustedArtifactRuntimeGuard } from "../../src/cloud/artifact-bridge.js";
import { MountedVolumeOnlineErrorBudgetCasStore } from "../../src/cloud/mounted-volume-online-error-budget.js";
import type {
  MountedVolumeDurableStateOptions,
  MountedVolumeStateSemanticsGuard,
} from "../../src/cloud/mounted-volume-state.js";
import { createOnlineErrorBudget } from "../../src/evaluation/statistics.js";
import {
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "../../src/evaluator/contracts.js";
import {
  DurableTrustedOnlineErrorBudgetAuthority,
  onlineErrorBudgetCampaignIdHash,
} from "../../src/evaluator/online-error-authority.js";

const CAMPAIGN_ID = "campaign-mounted-online-error-test";
const CAMPAIGN_HASH =
  onlineErrorBudgetCampaignIdHash(CAMPAIGN_ID);
const initialBudget = createOnlineErrorBudget(
  0.05,
  "null-calibration-v1",
);
const runtimeGuard: TrustedArtifactRuntimeGuard = {
  assertTrustedCloudRuntime() {},
};
const semanticsGuard: MountedVolumeStateSemanticsGuard = {
  assertLinearizableStateVolume() {},
};

function durableState(
  root: string,
  controller: string,
  nonce: string,
): MountedVolumeDurableStateOptions {
  return {
    volumeRoot: root,
    storeId: "campaign-online-error",
    controllerInstanceIdHash: controller,
    runtimeGuard,
    semanticsGuard,
    now: () => new Date("2026-07-26T10:00:00.000Z"),
    nonceFactory: () => nonce,
  };
}

function request(): TrustedEvaluationRequest {
  return {
    schemaVersion: 1,
    requestId: "online-error-mounted-001",
    experimentId: "001-online-error",
    runMode: "research",
    stage: "validation",
    submittedAt: "2026-07-26T10:00:00.000Z",
    deadlineAt: "2026-07-26T12:00:00.000Z",
    protocolHash: "b".repeat(64),
    complianceManifestHash: "c".repeat(64),
    candidate: {
      uri: "trusted://harness/candidate",
      commitSha: "1".repeat(40),
      treeSha: "2".repeat(40),
      archiveSha256: "3".repeat(64),
    },
    champion: {
      uri: "trusted://harness/champion",
      commitSha: "4".repeat(40),
      treeSha: "5".repeat(40),
      archiveSha256: "6".repeat(64),
    },
    selection: {
      kind: "fresh-matched-validation",
      taskCount: 12,
      attemptsPerArm: 1,
      pairOrder: "balanced-6-ab-6-ba",
      weightingPolicyHash: "7".repeat(64),
      frozenHypothesisHash: "8".repeat(64),
      hypothesisExclusionAttestationHash: "9".repeat(64),
    },
    executionProfile: {
      provider: "daytona",
      imageDigest: `sha256:${"d".repeat(64)}`,
      regionClass: "eu-standard",
      resources: {
        architecture: "x86_64",
        cpuCores: 8,
        memoryMiB: 16_384,
        diskMiB: 100_000,
      },
      networkPolicyHash: "e".repeat(64),
      protocolHash: "b".repeat(64),
    },
    evaluatedModel: {
      provider: "openai",
      modelId: "evaluated-model",
      thinkingLevel: "high",
    },
  };
}

describe("mounted-volume online error budget CAS store", () => {
  it("persists a burned reservation across a clean controller handoff", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "df-online-error-state-test-"),
    );
    const firstStore = new MountedVolumeOnlineErrorBudgetCasStore({
      durableState: durableState(
        root,
        "1".repeat(64),
        "a".repeat(48),
      ),
      campaignId: CAMPAIGN_ID,
      initialBudget,
    });
    const firstAuthority =
      new DurableTrustedOnlineErrorBudgetAuthority({
        store: firstStore,
        campaignIdHash: CAMPAIGN_HASH,
        initialBudget,
        now: () => new Date("2026-07-26T10:01:00.000Z"),
      });
    const evaluationRequest = request();
    const input = {
      request: evaluationRequest,
      requestHash: hashEvaluationRequest(evaluationRequest),
      dispositionAttestationHash: "f".repeat(64),
    } as const;
    const reserved = await firstAuthority.reserve(input);
    await firstStore.close();

    const successorStore =
      new MountedVolumeOnlineErrorBudgetCasStore({
        durableState: durableState(
          root,
          "2".repeat(64),
          "b".repeat(48),
        ),
        campaignId: CAMPAIGN_ID,
        initialBudget,
      });
    const successorAuthority =
      new DurableTrustedOnlineErrorBudgetAuthority({
        store: successorStore,
        campaignIdHash: CAMPAIGN_HASH,
        initialBudget,
        now: () => new Date("2026-07-26T10:02:00.000Z"),
      });
    await expect(successorAuthority.reserve(input)).resolves.toEqual(
      reserved,
    );
    const state = await successorStore.read();
    expect(state.revision).toBe(1);
    expect(state.current.spentAlpha).toBe(
      reserved.accounting.alphaSpent,
    );
    await expect(
      successorAuthority.reconcile(),
    ).resolves.toMatchObject({
      storeRevision: 1,
      onlineErrorSpent: reserved.accounting.alphaSpent,
      resultingStateHash:
        reserved.accounting.resultingStateHash,
    });
    await successorStore.close();
  });
});
