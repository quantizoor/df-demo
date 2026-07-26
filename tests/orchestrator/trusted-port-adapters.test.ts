import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { TrustedCloudArtifactRef } from "../../src/cloud/types.js";
import type { ExperimentIdentity } from "../../src/domain/models.js";
import { createEd25519Signature } from "../../src/evidence/signatures.js";
import {
  TRUSTED_GIT_SOURCE_BUNDLE_REF,
  type TrustedGitSourceSnapshotReceipt,
} from "../../src/harness/git-source.js";
import {
  emptyBlindBrokerLeaseState,
  type AtomicBlindBrokerLeaseStore,
  type BlindBrokerEvaluationConfiguration,
  type DurableBlindBrokerLeaseState,
} from "../../src/orchestrator/blind-broker.js";
import {
  CasBlindBrokerEvaluationConfigurationResolver,
  createTrustedBlindBrokerEvaluationConfigurationRecord,
  LeaseStoreTrustedRepairDiscoveryResolver,
  SignedGitSourceHarnessArtifactResolver,
  TrustedBlindBrokerPortAdapterError,
  type TrustedControlJsonArtifactReader,
  type TrustedEvaluationConfigurationArtifactSource,
  type TrustedGitSourceSnapshotReceiptSource,
} from "../../src/orchestrator/trusted-port-adapters.js";
import { canonicalJson } from "../../src/schemas/canonical.js";

const PROTOCOL = "a".repeat(64);
const REGISTRATION = "b".repeat(64);
const ORIGIN = "c".repeat(64);
const COMMIT = "d".repeat(40);
const TREE = "e".repeat(40);
const DISCOVERY = "f".repeat(64);
const SOURCE_KEY_ID = "source-key-001";

function experiment(number = 2): ExperimentIdentity {
  return {
    number,
    slug: "generic-recovery",
    kind: "optimization",
    parentExperiment: number - 1,
    lineageId: "lineage-v1",
    protocolHash: PROTOCOL,
  };
}

function configuration(): BlindBrokerEvaluationConfiguration {
  return {
    runMode: "research",
    complianceManifestHash: "1".repeat(64),
    executionProfile: {
      provider: "daytona",
      imageDigest: `sha256:${"2".repeat(64)}`,
      regionClass: "eu-standard",
      resources: {
        architecture: "x86_64",
        cpuCores: 4,
        memoryMiB: 8192,
        diskMiB: 32_768,
      },
      networkPolicyHash: "3".repeat(64),
      protocolHash: PROTOCOL,
    },
    evaluatedModel: {
      provider: "openai",
      modelId: "gpt-5.6",
      thinkingLevel: "high",
    },
    weightingPolicyHash: "4".repeat(64),
    requestTtlMs: 60 * 60_000,
  };
}

function configurationFixture(input: {
  readonly recordExperiment?: ExperimentIdentity;
  readonly rawMutation?: (raw: string) => string;
  readonly boundary?: "trusted-cloud";
} = {}): {
  readonly resolver: CasBlindBrokerEvaluationConfigurationResolver;
  readonly artifact: TrustedCloudArtifactRef;
} {
  const record = createTrustedBlindBrokerEvaluationConfigurationRecord({
    schemaVersion: 1,
    domain: "dark-factory.blind-broker-evaluation-configuration.v1",
    experiment: input.recordExperiment ?? experiment(),
    configuration: configuration(),
    createdAt: "2026-07-26T10:00:00.000Z",
  });
  const canonicalRaw = `${canonicalJson(record)}\n`;
  const raw = input.rawMutation?.(canonicalRaw) ?? canonicalRaw;
  const artifact: TrustedCloudArtifactRef = {
    uri: "trusted://campaign/configuration/002",
    sha256: createHash("sha256").update(raw).digest("hex"),
    mediaType: "application/json",
    byteLength: Buffer.byteLength(raw),
  };
  const source: TrustedEvaluationConfigurationArtifactSource = {
    boundary: input.boundary ?? "trusted-cloud",
    locate: async () => artifact,
  };
  const reader: TrustedControlJsonArtifactReader = {
    readUtf8: async () => raw,
  };
  return {
    resolver: new CasBlindBrokerEvaluationConfigurationResolver({
      source,
      reader,
    }),
    artifact,
  };
}

function sourceReceipt(
  mutate: (
    receipt: TrustedGitSourceSnapshotReceipt,
  ) => TrustedGitSourceSnapshotReceipt = (receipt) => receipt,
): {
  readonly receipt: TrustedGitSourceSnapshotReceipt;
  readonly publicKey: KeyObject;
} {
  const keys = generateKeyPairSync("ed25519");
  const body = {
    sensitivity: "trusted-git-source-snapshot" as const,
    schemaVersion: 2 as const,
    snapshotId: "snapshot-source-001",
    registrationId: REGISTRATION,
    originRepositoryHash: ORIGIN,
    upstreamRepositoryHash: "5".repeat(64),
    upstreamHeadCommit: "6".repeat(40),
    upstreamBaseCommit: "7".repeat(40),
    baselineCommit: "8".repeat(40),
    provider: "daytona" as const,
    sandboxId: "source-sandbox-001",
    imageReference: `ghcr.io/parallaxai/git-source@sha256:${"9".repeat(64)}`,
    imageDigest: `sha256:${"9".repeat(64)}`,
    networkPolicyHash: "a".repeat(64),
    remoteRef: "refs/heads/df/002-generic-recovery",
    commitSha: COMMIT,
    treeSha: TREE,
    lockSha256: "b".repeat(64),
    archiveMethod: "git-archive-format-tar" as const,
    compression: "none" as const,
    bundleMethod: "git-bundle-v2" as const,
    bundleRef: TRUSTED_GIT_SOURCE_BUNDLE_REF,
    workerSha256: "c".repeat(64),
    executionReceiptHash: "d".repeat(64),
    manifestArtifactSha256: "e".repeat(64),
    sourceArtifact: {
      uri: "trusted://git/source/002",
      sha256: "f".repeat(64),
      mediaType: "application/x-tar",
      byteLength: 4096,
    } satisfies TrustedCloudArtifactRef,
    sourceBundleArtifact: {
      uri: "trusted://git/source/002-bundle",
      sha256: "0".repeat(64),
      mediaType: "application/vnd.git.bundle",
      byteLength: 8192,
    } satisfies TrustedCloudArtifactRef,
    createdAt: "2026-07-26T10:00:00.000Z",
    passed: true as const,
  };
  return {
    receipt: mutate({
      ...body,
      signature: createEd25519Signature(
        body,
        keys.privateKey,
        SOURCE_KEY_ID,
        "2026-07-26T10:01:00.000Z",
      ),
    }),
    publicKey: keys.publicKey,
  };
}

describe("trusted blind-broker production port adapters", () => {
  it("resolves an exact experiment-bound configuration from canonical CAS JSON", async () => {
    const fixture = configurationFixture();
    await expect(fixture.resolver.resolve(experiment())).resolves.toEqual(
      configuration(),
    );
  });

  it("rejects detached and non-canonical configuration records", async () => {
    await expect(
      configurationFixture({
        recordExperiment: experiment(1),
      }).resolver.resolve(experiment()),
    ).rejects.toBeInstanceOf(TrustedBlindBrokerPortAdapterError);

    await expect(
      configurationFixture({
        rawMutation: (raw) => ` ${raw}`,
      }).resolver.resolve(experiment()),
    ).rejects.toBeInstanceOf(TrustedBlindBrokerPortAdapterError);
  });

  it("converts only a signed, repository-bound Git snapshot receipt", async () => {
    const fixture = sourceReceipt();
    const source: TrustedGitSourceSnapshotReceiptSource = {
      boundary: "trusted-cloud",
      findByCommit: async () => fixture.receipt,
    };
    const resolver = new SignedGitSourceHarnessArtifactResolver({
      source,
      keyring: {
        getVerificationKey: async (keyId) =>
          keyId === SOURCE_KEY_ID ? fixture.publicKey : undefined,
      },
      trustedKeyIds: [SOURCE_KEY_ID],
      registrationId: REGISTRATION,
      originRepositoryHash: ORIGIN,
    });

    await expect(resolver.resolve(COMMIT)).resolves.toEqual({
      uri: fixture.receipt.sourceArtifact.uri,
      commitSha: COMMIT,
      treeSha: TREE,
      archiveSha256: fixture.receipt.sourceArtifact.sha256,
    });
  });

  it("rejects a mutated Git receipt even when its CAS fields look valid", async () => {
    const fixture = sourceReceipt((receipt) => ({
      ...receipt,
      treeSha: "0".repeat(40),
    }));
    const resolver = new SignedGitSourceHarnessArtifactResolver({
      source: {
        boundary: "trusted-cloud",
        findByCommit: async () => fixture.receipt,
      },
      keyring: {
        getVerificationKey: async () => fixture.publicKey,
      },
      trustedKeyIds: [SOURCE_KEY_ID],
      registrationId: REGISTRATION,
      originRepositoryHash: ORIGIN,
    });

    await expect(resolver.resolve(COMMIT)).rejects.toBeInstanceOf(
      TrustedBlindBrokerPortAdapterError,
    );
  });

  it("finds repair discovery only in one consumed same-lineage validation record", async () => {
    const state = emptyBlindBrokerLeaseState();
    const sourceExperiment = experiment(1);
    const records = {
      source: {
        experiment: sourceExperiment,
        stage: "validation",
        status: "disposed",
        disposedOutcome: "decided",
        aggregate: {
          validPairs: 12,
          attestationHash: DISCOVERY,
        },
      },
    } as unknown as DurableBlindBrokerLeaseState["records"];
    const store: AtomicBlindBrokerLeaseStore = {
      transact: async (operation) =>
        operation({
          ...state,
          records,
        }).result,
    };
    const resolver = new LeaseStoreTrustedRepairDiscoveryResolver(store);

    await expect(
      resolver.resolve({
        experiment: experiment(2),
        discoveryAttestationHash: DISCOVERY,
      }),
    ).resolves.toEqual({
      sourceExperimentId: "001-generic-recovery",
      discoveryAttestationHash: DISCOVERY,
    });

    await expect(
      resolver.resolve({
        experiment: {
          ...experiment(2),
          lineageId: "another-lineage",
        },
        discoveryAttestationHash: DISCOVERY,
      }),
    ).rejects.toBeInstanceOf(TrustedBlindBrokerPortAdapterError);
  });

  it("rejects ambiguous or not-yet-consumed repair discovery evidence", async () => {
    const unconsumed = {
      experiment: experiment(1),
      stage: "validation",
      status: "evaluated",
      disposedOutcome: null,
      aggregate: {
        validPairs: 12,
        attestationHash: DISCOVERY,
      },
    };
    const state = {
      ...emptyBlindBrokerLeaseState(),
      records: {
        one: unconsumed,
      } as unknown as DurableBlindBrokerLeaseState["records"],
    };
    const resolver = new LeaseStoreTrustedRepairDiscoveryResolver({
      transact: async (operation) => operation(state).result,
    });

    await expect(
      resolver.resolve({
        experiment: experiment(2),
        discoveryAttestationHash: DISCOVERY,
      }),
    ).rejects.toBeInstanceOf(TrustedBlindBrokerPortAdapterError);
  });
});
