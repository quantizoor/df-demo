import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TrustedArtifactRuntimeGuard } from "../../src/cloud/artifact-bridge.js";
import {
  AttestedMountedVolumeStateSemanticsGuard,
  computeMountedVolumeBindingHash,
  computeMountedVolumeRootHash,
  computeMountedVolumeRuntimeIdentityHash,
  InProcessMountedVolumeCanaryWorkers,
  type MountedVolumeCanaryFileSystemPort,
  type MountedVolumeCanaryWorkerPort,
  type MountedVolumeRuntimeIdentity,
  type MountedVolumeSemanticsCanaryReceipt,
  NodeMountedVolumeCanaryFileSystem,
  runMountedVolumeSemanticsCanary,
} from "../../src/cloud/mounted-volume-canary.js";
import { computeContentHash, sha256 } from "../../src/schemas/canonical.js";

const imageDigest = `sha256:${"1".repeat(64)}` as const;
const observedAt = new Date("2026-07-26T10:00:00.000Z");
const runtimeIdentity: MountedVolumeRuntimeIdentity = {
  marker: {
    provider: "daytona",
    sandboxId: "sandbox-volume-canary-001",
    markerEnvironmentName: "DAYTONA_SANDBOX_ID",
  },
  nodeVersion: "v24.0.0",
  platform: "linux",
  architecture: "x64",
};

function acceptingRuntimeGuard(): TrustedArtifactRuntimeGuard {
  return {
    assertTrustedCloudRuntime() {},
  };
}

async function runCanary(
  root: string,
  overrides: Partial<{
    readonly runtimeGuard: TrustedArtifactRuntimeGuard;
    readonly filesystem: MountedVolumeCanaryFileSystemPort;
    readonly workers: MountedVolumeCanaryWorkerPort;
  }> = {},
): Promise<MountedVolumeSemanticsCanaryReceipt> {
  return runMountedVolumeSemanticsCanary({
    provider: "daytona",
    volumeRoot: root,
    volumeId: "volume-001",
    volumeSubpath: "campaign/state",
    controlImageDigest: imageDigest,
    runtimeIdentity,
    runtimeGuard: overrides.runtimeGuard ?? acceptingRuntimeGuard(),
    ...(overrides.filesystem === undefined ? {} : { filesystem: overrides.filesystem }),
    ...(overrides.workers === undefined ? {} : { workers: overrides.workers }),
    now: () => observedAt,
    nonceFactory: () => "a".repeat(48),
  });
}

function guard(
  root: string,
  receipt: MountedVolumeSemanticsCanaryReceipt,
  now: Date = observedAt,
): AttestedMountedVolumeStateSemanticsGuard {
  return new AttestedMountedVolumeStateSemanticsGuard({
    receipt,
    provider: "daytona",
    volumeRoot: root,
    volumeId: "volume-001",
    volumeSubpath: "campaign/state",
    controlImageDigest: imageDigest,
    runtimeIdentity,
    runtimeGuard: acceptingRuntimeGuard(),
    now: () => now,
  });
}

describe("mounted-volume semantics canary", () => {
  it("observes the required live semantics and creates an exact runtime-bound guard", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-volume-canary-test-"));
    const receipt = await runCanary(root, {
      filesystem: new NodeMountedVolumeCanaryFileSystem(),
      workers: new InProcessMountedVolumeCanaryWorkers(),
    });

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      domain: "dark-factory.mounted-volume-semantics-canary.v1",
      policyVersion: "mounted-volume-semantics-v1",
      provider: "daytona",
      volumeRootHash: computeMountedVolumeRootHash(root),
      volumeBindingHash: computeMountedVolumeBindingHash({
        provider: "daytona",
        volumeId: "volume-001",
        volumeSubpath: "campaign/state",
        volumeRoot: root,
      }),
      controllerInstanceIdHash: sha256(runtimeIdentity.marker.sandboxId),
      controlImageDigest: imageDigest,
      runtimeIdentityHash: computeMountedVolumeRuntimeIdentityHash({
        provider: "daytona",
        controlImageDigest: imageDigest,
        runtimeIdentity,
      }),
      crashDurabilityTested: false,
      crashDurabilityClaimed: false,
      observations: {
        regularNonSymlinkPaths: true,
        exclusiveCreationUnderContention: true,
        exclusiveCreationContenderCount: 16,
        exclusiveCreationWinnerCount: 1,
        sameVolumeAtomicRenameVisibility: true,
        fileFsyncCallSucceeded: true,
        directoryFsyncCallSucceeded: true,
        rollbackHeadDetection: true,
      },
    });
    expect(receipt.contentHash).toBe(computeContentHash(receipt));

    const semanticsGuard = guard(root, receipt);
    expect(() =>
      semanticsGuard.assertLinearizableStateVolume({
        volumeRoot: root,
        namespace: "one-use-ledger-campaign-a",
      }),
    ).not.toThrow();
  });

  it("runs the trusted cloud guard before touching an injected filesystem", async () => {
    const rejectingFilesystem = new Proxy(
      {},
      {
        get() {
          throw new Error("filesystem must not be touched");
        },
      },
    ) as MountedVolumeCanaryFileSystemPort;
    await expect(
      runCanary("/trusted/not-mounted", {
        runtimeGuard: {
          assertTrustedCloudRuntime() {
            throw new Error("not a trusted cloud runtime");
          },
        },
        filesystem: rejectingFilesystem,
      }),
    ).rejects.toThrow(/not a trusted cloud runtime/u);
  });

  it("rejects a symlink volume root before making an observation receipt", async () => {
    const parent = await mkdtemp(join(tmpdir(), "df-volume-canary-link-test-"));
    const realRoot = join(parent, "real-volume");
    const linkedRoot = join(parent, "linked-volume");
    await mkdir(realRoot, { mode: 0o700 });
    await symlink(realRoot, linkedRoot);

    await expect(runCanary(linkedRoot)).rejects.toThrow(/non-symlink directory/u);
  });

  it("creates and attests an exact campaign-state root beneath the mounted volume", async () => {
    const mountRoot = await mkdtemp(join(tmpdir(), "df-volume-canary-mount-test-"));
    const stateRoot = join(mountRoot, "campaign-state");
    const receipt = await runCanary(stateRoot);

    expect(receipt.volumeRootHash).toBe(computeMountedVolumeRootHash(stateRoot));
    expect(() =>
      guard(stateRoot, receipt).assertLinearizableStateVolume({
        volumeRoot: stateRoot,
        namespace: "hidden-catalog-campaign-a",
      }),
    ).not.toThrow();
  });

  it("fails closed when an injected contention worker reports multiple winners", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-volume-canary-race-test-"));
    const workers: MountedVolumeCanaryWorkerPort = {
      async raceExclusiveCreation(input) {
        return {
          contenderCount: input.contenderCount,
          winnerCount: 2,
          alreadyExistsCount: input.contenderCount - 2,
        };
      },
      async observeAtomicRename() {
        throw new Error("rename observation must not run");
      },
    };

    await expect(runCanary(root, { workers })).rejects.toThrow(
      /exclusive creation under contention/u,
    );
  });

  it("fails closed when an injected observer detects a rename visibility gap", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-volume-canary-rename-test-"));
    const realWorkers = new InProcessMountedVolumeCanaryWorkers();
    const workers: MountedVolumeCanaryWorkerPort = {
      raceExclusiveCreation: (input) => realWorkers.raceExclusiveCreation(input),
      async observeAtomicRename(input) {
        const observed = await realWorkers.observeAtomicRename(input);
        return {
          ...observed,
          missingCount: 1,
          sampleCount: observed.sampleCount + 1,
        };
      },
    };

    await expect(runCanary(root, { workers })).rejects.toThrow(/atomic rename visibility/u);
  });

  it("rejects stale, tampered, or differently bound receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-volume-canary-guard-test-"));
    const receipt = await runCanary(root);

    expect(() => guard(root, receipt, new Date("2026-07-26T17:00:00.000Z"))).toThrow(
      /stale|binding/u,
    );

    expect(
      () =>
        new AttestedMountedVolumeStateSemanticsGuard({
          receipt,
          provider: "daytona",
          volumeRoot: root,
          volumeId: "different-volume",
          volumeSubpath: "campaign/state",
          controlImageDigest: imageDigest,
          runtimeIdentity,
          runtimeGuard: acceptingRuntimeGuard(),
          now: () => observedAt,
        }),
    ).toThrow(/stale|binding/u);

    const unsafeDraft = {
      ...receipt,
      observations: {
        ...receipt.observations,
        directoryFsyncCallSucceeded: false,
      },
      contentHash: "",
    };
    const unsafeReceipt = {
      ...unsafeDraft,
      contentHash: computeContentHash(unsafeDraft),
    } as unknown as MountedVolumeSemanticsCanaryReceipt;
    expect(() => guard(root, unsafeReceipt)).toThrow(/invalid or incomplete/u);
  });
});
