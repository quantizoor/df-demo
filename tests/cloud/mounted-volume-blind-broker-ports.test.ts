import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TrustedArtifactRuntimeGuard } from "../../src/cloud/artifact-bridge.js";
import { MountedVolumeTrustedArtifactBackend } from "../../src/cloud/mounted-volume-backend.js";
import {
  MountedVolumeAtomicBlindBrokerLeaseStore,
  MountedVolumeTrustedDiagnosticBriefPublisher,
  mountedVolumeDiagnosticBriefArtifactUri,
} from "../../src/cloud/mounted-volume-blind-broker-ports.js";
import type {
  MountedVolumeDurableStateOptions,
  MountedVolumeStateSemanticsGuard,
} from "../../src/cloud/mounted-volume-state.js";
import type {
  BehavioralEvidence,
  DiagnosticBrief,
  FailureCards,
} from "../../src/schemas/artifacts.js";
import {
  canonicalJson,
  withContentHash,
} from "../../src/schemas/canonical.js";
import type { SignedBehavioralRelease } from "../../src/schemas/trusted.js";

const SOURCE_ENVELOPE_HASH = "a".repeat(64);
const PROTOCOL_HASH = "b".repeat(64);
const SIGNATURE = {
  algorithm: "ed25519" as const,
  keyId: "evaluator-key-1",
  signedAt: "2026-07-26T10:10:00.000Z",
  signature: "A".repeat(86),
};
const POLICY_VERSIONS = {
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
const SUPPORT = {
  distinctTaskCountBand: "10-19" as const,
  trajectoryCountBand: "20-39" as const,
  minimumComparedGroupSizeBand: "10-19" as const,
  complementaryCountSuppressionPassed: true,
  differencingBudgetPassed: true,
};

const runtimeGuard: TrustedArtifactRuntimeGuard = {
  assertTrustedCloudRuntime() {},
};

const semanticsGuard: MountedVolumeStateSemanticsGuard = {
  assertLinearizableStateVolume() {},
};

const signatureVerifier = {
  verify: () => Promise.resolve(true),
};

function stateOptions(
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

function diagnosticMaterial(
  limitation = "No supported generic behavior finding was available.",
): {
  readonly sourceResultEnvelopeHash: string;
  readonly behavioralRelease: SignedBehavioralRelease;
  readonly behavioralEvidence: BehavioralEvidence;
  readonly failureCards: FailureCards;
  readonly diagnosticBrief: DiagnosticBrief;
} {
  const evidence = withContentHash({
    schemaVersion: "1.0.0",
    createdAt: "2026-07-26T10:10:00.000Z",
    provenanceRefs: [],
    experimentNumber: 2,
    sourceEnvelopeHash: SOURCE_ENVELOPE_HASH,
    protocolHash: PROTOCOL_HASH,
    policyVersions: POLICY_VERSIONS,
    analysisWindow: {
      openedAt: "2026-07-26T10:00:00.000Z",
      closedAt: "2026-07-26T10:10:00.000Z",
      support: SUPPORT,
    },
    metrics: [],
    suppressedFindingCountBand: "0",
    releaseChecksPassed: true,
    derivationHash: "c".repeat(64),
  }) as BehavioralEvidence;
  const cards = withContentHash({
    schemaVersion: "1.0.0",
    createdAt: "2026-07-26T10:10:00.000Z",
    provenanceRefs: [],
    experimentNumber: 2,
    behavioralEvidenceHash: evidence.contentHash,
    cards: [],
    suppressionApplied: true,
    policyVersions: POLICY_VERSIONS,
  }) as FailureCards;
  const brief = withContentHash({
    schemaVersion: "1.0.0",
    createdAt: "2026-07-26T10:10:00.000Z",
    provenanceRefs: [],
    experimentNumber: 2,
    releaseId: "diagnostic-2",
    sourceExperimentNumber: 2,
    aggregateEvidenceHash: evidence.contentHash,
    failureCardsHash: cards.contentHash,
    policyVersions: POLICY_VERSIONS,
    status: "no-actionable-evidence",
    cards: [],
    limitations: [limitation],
    oneUse: true,
    expiresAt: "2026-07-26T12:00:00.000Z",
  }) as DiagnosticBrief;
  const release = withContentHash({
    schemaVersion: "1.0.0",
    createdAt: "2026-07-26T10:10:00.000Z",
    provenanceRefs: [],
    releaseId: brief.releaseId,
    experimentNumber: 2,
    sourceResultEnvelopeHash: SOURCE_ENVELOPE_HASH,
    protocolHash: PROTOCOL_HASH,
    policyVersions: POLICY_VERSIONS,
    support: SUPPORT,
    aggregateArtifactHashes: {
      behavioralEvidence: evidence.contentHash,
      failureCards: cards.contentHash,
      diagnosticBrief: brief.contentHash,
    },
    suppressedFindingCountBand: "0",
    releaseOnce: true,
    signature: SIGNATURE,
  }) as SignedBehavioralRelease;
  return {
    sourceResultEnvelopeHash: SOURCE_ENVELOPE_HASH,
    behavioralRelease: release,
    behavioralEvidence: evidence,
    failureCards: cards,
    diagnosticBrief: brief,
  };
}

function publicationBindingUri(
  storeId: string,
  publicationId: string,
): `trusted://${string}` {
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        domain: "dark-factory.diagnostic-publication-address.v1",
        storeId,
        publicationId,
      }),
      "utf8",
    )
    .digest("hex");
  return `trusted://diagnostic-publications/${digest}`;
}

function artifactShard(root: string, uri: `trusted://${string}`): string {
  const digest = createHash("sha256").update(uri, "utf8").digest("hex");
  return join(root, "objects", digest.slice(0, 2));
}

async function collect(
  source: AsyncIterable<Uint8Array>,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe("mounted-volume blind-broker production ports", () => {
  it(
    "linearizes lease callbacks once and survives a clean controller handoff",
    async () => {
      const root = await mkdtemp(
        join(tmpdir(), "df-blind-broker-state-test-"),
      );
      const store = new MountedVolumeAtomicBlindBrokerLeaseStore(
        stateOptions(root),
      );
      const calls = Array.from({ length: 8 }, () => 0);

      await Promise.all(
        calls.map((_, index) =>
          store.transact((state) => {
            calls[index] = (calls[index] ?? 0) + 1;
            return {
              next: {
                ...state,
                revision: state.revision + 1,
              },
              result: index,
            };
          }),
        ),
      );
      expect(calls).toEqual(Array.from({ length: 8 }, () => 1));
      await store.close();

      const successor = new MountedVolumeAtomicBlindBrokerLeaseStore(
        stateOptions(
          root,
          "2".repeat(64),
          "b".repeat(48),
        ),
      );
      await expect(
        successor.transact((state) => ({
          next: state,
          result: state.revision,
        })),
      ).resolves.toBe(8);
      await successor.close();
    },
  );

  it("rejects a lease transition that skips a revision", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "df-blind-broker-state-test-"),
    );
    const store = new MountedVolumeAtomicBlindBrokerLeaseStore(
      stateOptions(root),
    );
    await expect(
      store.transact((state) => ({
        next: {
          ...state,
          revision: state.revision + 2,
        },
        result: undefined,
      })),
    ).rejects.toThrow(/revision/u);
    await store.close();
  });

  it("fails before lease access when volume semantics are not attested", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "df-blind-broker-state-test-"),
    );
    const store = new MountedVolumeAtomicBlindBrokerLeaseStore({
      ...stateOptions(root),
      semanticsGuard: {
        assertLinearizableStateVolume() {
          throw new Error("volume semantics not attested");
        },
      },
    });
    await expect(
      store.transact((state) => ({
        next: state,
        result: undefined,
      })),
    ).rejects.toThrow(/semantics not attested/u);
  });

  it(
    "publishes only canonical sanitized brief bytes and is idempotent",
    async () => {
      const root = await mkdtemp(
        join(tmpdir(), "df-diagnostic-publisher-test-"),
      );
      const publisher =
        new MountedVolumeTrustedDiagnosticBriefPublisher({
          durableState: stateOptions(root),
          signatureVerifier,
        });
      const material = diagnosticMaterial();
      const publicationId = "brief-validation-0002";

      const first = await publisher.publishOnce({
        publicationId,
        ...material,
      });
      const second = await publisher.publishOnce({
        publicationId,
        ...material,
      });
      expect(second).toEqual(first);
      expect(first).toEqual({
        hash: material.diagnosticBrief.contentHash,
        releaseId: material.diagnosticBrief.releaseId,
        actionable: false,
      });

      const backend = new MountedVolumeTrustedArtifactBackend({
        volumeRoot: root,
        runtimeGuard,
      });
      const persisted = await collect(
        await backend.open(
          mountedVolumeDiagnosticBriefArtifactUri({
            storeId: "campaign-a",
            diagnosticBriefHash: material.diagnosticBrief.contentHash,
          }),
        ),
      );
      const expected = `${canonicalJson(material.diagnosticBrief)}\n`;
      expect(persisted.toString("utf8")).toBe(expected);
      expect(expected).not.toContain(SOURCE_ENVELOPE_HASH);
      const releasedDocument = JSON.parse(expected) as Readonly<
        Record<string, unknown>
      >;
      expect(Object.hasOwn(releasedDocument, "behavioralRelease")).toBe(
        false,
      );
      expect(Object.hasOwn(releasedDocument, "failureCards")).toBe(false);
      expect(Object.hasOwn(releasedDocument, "panel")).toBe(false);

      await publisher.close();
      const successor =
        new MountedVolumeTrustedDiagnosticBriefPublisher({
          durableState: stateOptions(
            root,
            "2".repeat(64),
            "b".repeat(48),
          ),
          signatureVerifier,
        });
      await expect(successor.readReleaseSafe(first)).resolves.toEqual(
        material.diagnosticBrief,
      );
      await successor.close();
    },
  );

  it("rejects changed bytes under an existing publication ID", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "df-diagnostic-publisher-test-"),
    );
    const publisher =
      new MountedVolumeTrustedDiagnosticBriefPublisher({
        durableState: stateOptions(root),
        signatureVerifier,
      });
    const publicationId = "brief-validation-0002";
    await publisher.publishOnce({
      publicationId,
      ...diagnosticMaterial(),
    });
    await expect(
      publisher.publishOnce({
        publicationId,
        ...diagnosticMaterial(
          "No supported generic transition finding was available.",
        ),
      }),
    ).rejects.toThrow(/binds different content/u);
    await publisher.close();
  });

  it(
    "recovers after a safe shard rejection between binding and brief writes",
    async () => {
      const root = await mkdtemp(
        join(tmpdir(), "df-diagnostic-publisher-test-"),
      );
      const publisher =
        new MountedVolumeTrustedDiagnosticBriefPublisher({
          durableState: stateOptions(root),
          signatureVerifier,
        });
      const material = diagnosticMaterial();
      const briefUri = mountedVolumeDiagnosticBriefArtifactUri({
        storeId: "campaign-a",
        diagnosticBriefHash: material.diagnosticBrief.contentHash,
      });
      const briefShard = artifactShard(root, briefUri);
      let publicationId: string | null = null;
      let bindingUri: `trusted://${string}` | null = null;
      for (let ordinal = 1; ordinal <= 32; ordinal += 1) {
        const candidate =
          `brief-crash-${String(ordinal).padStart(4, "0")}`;
        const candidateUri = publicationBindingUri(
          "campaign-a",
          candidate,
        );
        if (
          artifactShard(root, candidateUri) !== briefShard
        ) {
          publicationId = candidate;
          bindingUri = candidateUri;
          break;
        }
      }
      if (publicationId === null || bindingUri === null) {
        throw new Error("Could not construct disjoint test shards.");
      }

      const objectsRoot = join(root, "objects");
      const outside = join(root, "outside-artifact-shard");
      await mkdir(objectsRoot, { mode: 0o700 });
      await mkdir(outside, { mode: 0o700 });
      await symlink(outside, briefShard, "dir");

      await expect(
        publisher.publishOnce({
          publicationId,
          ...material,
        }),
      ).rejects.toThrow(/shard is unsafe/u);

      const backend = new MountedVolumeTrustedArtifactBackend({
        volumeRoot: root,
        runtimeGuard,
      });
      const durableBinding = JSON.parse(
        (
          await collect(await backend.open(bindingUri))
        ).toString("utf8"),
      ) as Readonly<Record<string, unknown>>;
      expect(durableBinding["diagnosticBriefHash"]).toBe(
        material.diagnosticBrief.contentHash,
      );

      await unlink(briefShard);
      await expect(
        publisher.publishOnce({
          publicationId,
          ...material,
        }),
      ).resolves.toEqual({
        hash: material.diagnosticBrief.contentHash,
        releaseId: material.diagnosticBrief.releaseId,
        actionable: false,
      });
      await publisher.close();
    },
  );

  it("rejects identity-bearing diagnostic literals before persistence", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "df-diagnostic-publisher-test-"),
    );
    const publisher =
      new MountedVolumeTrustedDiagnosticBriefPublisher({
        durableState: stateOptions(root),
        signatureVerifier,
      });
    await expect(
      publisher.publishOnce({
        publicationId: "brief-validation-0002",
        ...diagnosticMaterial(
          "See https://hidden.invalid/private-case for details.",
        ),
      }),
    ).rejects.toThrow(/release-safe persistence scan/u);
    await publisher.close();
  });

  it("rejects detached release lineage before artifact access", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "df-diagnostic-publisher-test-"),
    );
    let runtimeChecks = 0;
    const publisher =
      new MountedVolumeTrustedDiagnosticBriefPublisher({
        durableState: {
          ...stateOptions(root),
          runtimeGuard: {
            assertTrustedCloudRuntime() {
              runtimeChecks += 1;
            },
          },
        },
        signatureVerifier,
      });
    await expect(
      publisher.publishOnce({
        publicationId: "brief-validation-0002",
        ...diagnosticMaterial(),
        sourceResultEnvelopeHash: "f".repeat(64),
      }),
    ).rejects.toThrow(/lineage/u);
    expect(runtimeChecks).toBe(0);
    await publisher.close();
  });

  it("rejects an untrusted diagnostic signature before artifact access", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "df-diagnostic-publisher-test-"),
    );
    let runtimeChecks = 0;
    const publisher =
      new MountedVolumeTrustedDiagnosticBriefPublisher({
        durableState: {
          ...stateOptions(root),
          runtimeGuard: {
            assertTrustedCloudRuntime() {
              runtimeChecks += 1;
            },
          },
        },
        signatureVerifier: {
          verify: () => Promise.resolve(false),
        },
      });
    await expect(
      publisher.publishOnce({
        publicationId: "brief-validation-0002",
        ...diagnosticMaterial(),
      }),
    ).rejects.toThrow(/signature is not trusted/u);
    expect(runtimeChecks).toBe(0);
    await publisher.close();
  });
});
