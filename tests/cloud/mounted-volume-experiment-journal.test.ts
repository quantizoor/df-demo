import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TrustedArtifactRuntimeGuard } from "../../src/cloud/artifact-bridge.js";
import { MountedVolumeAtomicExperimentJournalStateStore } from "../../src/cloud/mounted-volume-experiment-journal.js";
import type {
  MountedVolumeDurableStateOptions,
  MountedVolumeStateSemanticsGuard,
} from "../../src/cloud/mounted-volume-state.js";

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
    storeId: "campaign-journal",
    controllerInstanceIdHash: controller,
    runtimeGuard,
    semanticsGuard,
    now: () => new Date("2026-07-26T10:00:00.000Z"),
    nonceFactory: () => nonce,
  };
}

describe("mounted-volume experiment journal state", () => {
  it("preserves a pending operation across a clean controller handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-experiment-journal-state-test-"));
    const first = new MountedVolumeAtomicExperimentJournalStateStore(
      durableState(root, "1".repeat(64), "a".repeat(48)),
    );
    const pending = await first.transact((state) => {
      const next = {
        ...state,
        revision: state.revision + 1,
        pendingOperation: {
          experimentName: "001-source-only-bootstrap",
          operation: "create" as const,
          inputHash: "3".repeat(64),
          startedAt: "2026-07-26T10:00:00.000Z",
        },
      };
      return { next, result: next.pendingOperation };
    });
    await first.close();

    const successor = new MountedVolumeAtomicExperimentJournalStateStore(
      durableState(root, "2".repeat(64), "b".repeat(48)),
    );
    const restored = await successor.transact((state) => ({
      next: state,
      result: state,
    }));
    await successor.close();

    expect(restored.revision).toBe(1);
    expect(restored.pendingOperation).toEqual(pending);
    expect(restored.records).toEqual({});
  });

  it("rejects a corrupt successor state before it can replace the journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-experiment-journal-corrupt-test-"));
    const store = new MountedVolumeAtomicExperimentJournalStateStore(
      durableState(root, "4".repeat(64), "c".repeat(48)),
    );

    await expect(
      store.transact((state) => ({
        next: {
          ...state,
          revision: state.revision + 1,
          sensitivity: "release-safe" as never,
        },
        result: undefined,
      })),
    ).rejects.toThrow();
    const restored = await store.transact((state) => ({
      next: state,
      result: state,
    }));
    await store.close();

    expect(restored.revision).toBe(0);
    expect(restored.pendingOperation).toBeNull();
  });
});
