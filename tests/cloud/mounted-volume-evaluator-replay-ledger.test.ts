import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import type { TrustedArtifactRuntimeGuard } from "../../src/cloud/artifact-bridge.js";
import {
  MountedVolumeCanonicalEvaluatorReplayLedger,
} from "../../src/cloud/mounted-volume-evaluator-replay-ledger.js";
import type {
  MountedVolumeDurableStateOptions,
  MountedVolumeStateSemanticsGuard,
} from "../../src/cloud/mounted-volume-state.js";

const temporaryDirectories: string[] = [];

const runtimeGuard: TrustedArtifactRuntimeGuard = {
  assertTrustedCloudRuntime() {},
};

const semanticsGuard: MountedVolumeStateSemanticsGuard = {
  assertLinearizableStateVolume() {},
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

function options(
  root: string,
  controller: string,
  nonce: string,
): MountedVolumeDurableStateOptions {
  return {
    volumeRoot: root,
    storeId: "campaign-evaluator",
    controllerInstanceIdHash: controller,
    runtimeGuard,
    semanticsGuard,
    now: () => new Date("2026-07-26T10:00:00.000Z"),
    nonceFactory: () => nonce,
  };
}

function claim(
  requestId = "request-001",
  requestHash = "a".repeat(64),
) {
  return {
    requestId,
    requestHash,
    claimedAt: "2026-07-26T10:00:00.000Z",
  };
}

describe("mounted-volume evaluator replay ledger", () => {
  it("keeps a failed transport claim burned across controller handoff", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "df-evaluator-replay-test-"),
    );
    temporaryDirectories.push(root);
    const first =
      new MountedVolumeCanonicalEvaluatorReplayLedger(
        options(
          root,
          "1".repeat(64),
          "a".repeat(48),
        ),
      );

    await expect(first.claim(claim())).resolves.toBe(true);
    await first.close();

    const successor =
      new MountedVolumeCanonicalEvaluatorReplayLedger(
        options(
          root,
          "2".repeat(64),
          "b".repeat(48),
        ),
      );
    await expect(successor.claim(claim())).resolves.toBe(false);
    await expect(
      successor.claim(claim("request-002")),
    ).resolves.toBe(false);
    await expect(
      successor.claim(
        claim("request-003", "b".repeat(64)),
      ),
    ).resolves.toBe(true);
    await successor.close();
  });

  it("linearizes concurrent claims so exactly one caller burns the panel", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "df-evaluator-replay-race-test-"),
    );
    temporaryDirectories.push(root);
    const ledger =
      new MountedVolumeCanonicalEvaluatorReplayLedger(
        options(
          root,
          "3".repeat(64),
          "c".repeat(48),
        ),
      );

    const outcomes = await Promise.all([
      ledger.claim(claim()),
      ledger.claim(claim()),
      ledger.claim(claim()),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await ledger.close();
  });

  it("rejects malformed claims before durable state changes", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "df-evaluator-replay-invalid-test-"),
    );
    temporaryDirectories.push(root);
    const ledger =
      new MountedVolumeCanonicalEvaluatorReplayLedger(
        options(
          root,
          "4".repeat(64),
          "d".repeat(48),
        ),
      );

    await expect(
      ledger.claim({
        ...claim(),
        requestHash: "not-a-hash",
      }),
    ).rejects.toThrow();
    await expect(
      ledger.claim(claim("constructor")),
    ).rejects.toThrow();
    await expect(ledger.claim(claim())).resolves.toBe(true);
    await ledger.close();
  });
});
