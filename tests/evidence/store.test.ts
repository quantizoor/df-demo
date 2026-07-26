import { generateKeyPairSync, type KeyLike } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createEd25519Signature,
  EvidenceStoreError,
  ExperimentStore,
  type LeakScanReceipt,
  SealedExperimentError,
  type TrustedLeakScanner,
} from "../../src/evidence/index.js";
import { canonicalHash, canonicalJson, withContentHash } from "../../src/schemas/canonical.js";
import { isArtifactFileName } from "../../src/schemas/registry.js";
import { artifactFixtureByFile, pinnedVersions, schemaFixture } from "../schemas/fixtures.js";

const temporaryDirectories: string[] = [];
const EXPERIMENT = "001-test-change";
const STORE_NOW = "2026-07-26T12:00:00.000Z";
const LEAK_SCANNER_KEY_ID = "trusted-leak-scanner-1";
const leakScannerKeys = generateKeyPairSync("ed25519");
const trustedLeakScanner: TrustedLeakScanner = {
  keyId: LEAK_SCANNER_KEY_ID,
  publicKey: leakScannerKeys.publicKey,
};

async function createStore(
  scanner: TrustedLeakScanner | null = trustedLeakScanner,
): Promise<ExperimentStore> {
  const root = await mkdtemp(join(tmpdir(), "df-evidence-test-"));
  temporaryDirectories.push(root);
  const store = new ExperimentStore(root, {
    now: () => new Date(STORE_NOW),
    ...(scanner === null ? {} : { trustedLeakScanner: scanner }),
  });
  await store.initialize();
  await store.createExperiment(EXPERIMENT);
  return store;
}

async function createLeakScanReceipt(
  store: ExperimentStore,
  experimentName = EXPERIMENT,
  options: {
    readonly privateKey?: KeyLike;
    readonly keyId?: string;
    readonly mutate?: (receipt: Record<string, unknown>) => void;
  } = {},
): Promise<LeakScanReceipt> {
  const subject = await store.captureLeakScanSubject(experimentName);
  const unsigned: Record<string, unknown> = {
    ...structuredClone(subject),
    scannerPolicyVersion: "grader-leak-policy-v1",
    scannerVersion: "scanner-v1",
    checkedAt: STORE_NOW,
    status: "passed",
    passed: true,
    matchCountBand: "0",
    signature: null,
  };
  options.mutate?.(unsigned);
  const checkedAt = unsigned.checkedAt;
  if (typeof checkedAt !== "string") {
    throw new Error("Test receipt checkedAt must be a string");
  }
  const signature = createEd25519Signature(
    unsigned,
    options.privateKey ?? leakScannerKeys.privateKey,
    options.keyId ?? LEAK_SCANNER_KEY_ID,
    checkedAt,
  );
  return withContentHash({
    ...unsigned,
    signature,
  }) as unknown as LeakScanReceipt;
}

function mutateReceipt(
  receipt: LeakScanReceipt,
  mutate: (draft: Record<string, unknown>) => void,
): LeakScanReceipt {
  const draft = structuredClone(receipt) as unknown as Record<string, unknown>;
  mutate(draft);
  return withContentHash(draft) as unknown as LeakScanReceipt;
}

async function writeAllArtifacts(store: ExperimentStore): Promise<void> {
  for (const [fileName, fixture] of Object.entries(artifactFixtureByFile)) {
    if (!isArtifactFileName(fileName)) {
      throw new Error(`Test fixture has unknown artifact name "${fileName}"`);
    }
    await store.writeArtifact(EXPERIMENT, fileName, fixture());
  }
}

async function writeAllArtifactsFor(
  store: ExperimentStore,
  experimentName: string,
  experimentNumber: number,
): Promise<void> {
  for (const [fileName, fixture] of Object.entries(artifactFixtureByFile)) {
    if (!isArtifactFileName(fileName)) {
      throw new Error(`Test fixture has unknown artifact name "${fileName}"`);
    }
    const value = structuredClone(fixture()) as Record<string, unknown>;
    value.experimentNumber = experimentNumber;
    if (fileName === "experiment.json") {
      value.slug = experimentName.replace(/^\d+-/u, "");
    }
    if (fileName === "evaluation-plan.json") {
      const attestations = value.panelAttestations as Record<string, unknown>[];
      if (attestations[0] !== undefined) {
        attestations[0].oneUseAttestationHash = "c".repeat(64);
      }
    }
    if (fileName === "decision.json") {
      value.oneUseConsumptionAttestationHash = "d".repeat(64);
    }
    await store.writeArtifact(experimentName, fileName, withContentHash(value));
  }
}

async function addInitialEvent(store: ExperimentStore): Promise<void> {
  await store.appendEvent(EXPERIMENT, {
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
}

async function sealCompleteStore(): Promise<ExperimentStore> {
  const store = await createStore();
  await writeAllArtifacts(store);
  await addInitialEvent(store);
  await store.sealExperiment(EXPERIMENT, {
    pinnedVersions: pinnedVersions(),
    leakScanReceipt: await createLeakScanReceipt(store),
  });
  return store;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ExperimentStore", () => {
  it("validates and atomically round-trips an artifact", async () => {
    const store = await createStore();
    const fixture = schemaFixture("analysis");
    await store.writeArtifact(EXPERIMENT, "analysis.json", fixture);

    expect(await store.readArtifact(EXPERIMENT, "analysis.json")).toEqual(fixture);
    const entries = await readdir(join(store.root, EXPERIMENT));
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("keeps evidence artifacts write-once before sealing", async () => {
    const store = await createStore();
    await store.writeArtifact(EXPERIMENT, "analysis.json", schemaFixture("analysis"));
    await expect(
      store.writeArtifact(EXPERIMENT, "analysis.json", schemaFixture("analysis")),
    ).rejects.toMatchObject({ code: "EEXIST" });

    await store.writeArtifact(EXPERIMENT, "experiment.json", schemaFixture("experiment"));
    const updatedExperiment = withContentHash({
      ...(schemaFixture("experiment") as Readonly<Record<string, unknown>>),
      lifecycleState: "promoted",
    });
    await expect(
      store.writeArtifact(EXPERIMENT, "experiment.json", updatedExperiment),
    ).resolves.toBeUndefined();
  });

  it("rejects invalid names, path traversal, number mismatch, and symlink-like scope escape", async () => {
    const store = await createStore();
    await expect(store.createExperiment("../escape")).rejects.toBeInstanceOf(EvidenceStoreError);
    await expect(
      store.writeArtifact("002-other", "analysis.json", schemaFixture("analysis")),
    ).rejects.toBeInstanceOf(EvidenceStoreError);

    const wrongNumber = withContentHash({
      ...(schemaFixture("analysis") as Readonly<Record<string, unknown>>),
      experimentNumber: 2,
    });
    await expect(store.writeArtifact(EXPERIMENT, "analysis.json", wrongNumber)).rejects.toThrow(
      /does not match directory/u,
    );
  });

  it("allocates an experiment number at most once under concurrency", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-evidence-allocation-test-"));
    temporaryDirectories.push(root);
    const first = new ExperimentStore(root);
    const second = new ExperimentStore(root);
    const results = await Promise.allSettled([
      first.createExperiment("007-first"),
      second.createExperiment("007-second"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const allocated = (await first.listExperimentNames()).filter((name) => name.startsWith("007-"));
    expect(allocated).toHaveLength(1);
  });

  it("builds and verifies an append-only event hash chain", async () => {
    const store = await createStore();
    const first = await store.appendEvent(EXPERIMENT, {
      eventType: "experiment-created",
      actor: "controller",
      payload: {
        messageCode: "created",
        artifactName: null,
        stateFrom: null,
        stateTo: "planned",
        aggregateCountBand: null,
        validArmCount: null,
        invalidArmCount: null,
        attestationHash: null,
      },
    });
    const second = await store.appendEvent(EXPERIMENT, {
      eventType: "lifecycle-transition",
      actor: "controller",
      payload: {
        messageCode: "candidate-ready",
        artifactName: null,
        stateFrom: "planned",
        stateTo: "candidate-ready",
        aggregateCountBand: null,
        validArmCount: null,
        invalidArmCount: null,
        attestationHash: null,
      },
    });

    expect(second.sequence).toBe(1);
    expect(second.previousEventHash).toBe(first.contentHash);
    const report = await store.verifyExperiment(EXPERIMENT);
    expect(report.valid).toBe(true);
    expect(report.eventRecordCount).toBe(2);
    expect(report.eventChainHead).toBe(second.contentHash);
  });

  it("seals every required artifact and refuses later rewrites or events", async () => {
    const store = await sealCompleteStore();
    const report = await store.verifyExperiment(EXPERIMENT, {
      requireSeal: true,
      requireAllArtifacts: true,
    });

    expect(report.valid).toBe(true);
    expect(report.sealed).toBe(true);
    expect(report.eventRecordCount).toBe(2);
    await expect(
      store.writeArtifact(EXPERIMENT, "analysis.json", schemaFixture("analysis")),
    ).rejects.toBeInstanceOf(SealedExperimentError);
    await expect(
      store.appendEvent(EXPERIMENT, {
        eventType: "operator-action",
        actor: "operator",
        payload: {
          messageCode: "late-write",
          artifactName: null,
          stateFrom: null,
          stateTo: null,
          aggregateCountBand: null,
          validArmCount: null,
          invalidArmCount: null,
          attestationHash: null,
        },
      }),
    ).rejects.toBeInstanceOf(SealedExperimentError);
  });

  it("persists and re-verifies the exact trusted leak-scan receipt", async () => {
    const store = await createStore();
    await writeAllArtifacts(store);
    await addInitialEvent(store);
    const receipt = await createLeakScanReceipt(store);

    const attestation = await store.sealExperiment(EXPERIMENT, {
      pinnedVersions: pinnedVersions(),
      leakScanReceipt: receipt,
    });

    expect(attestation.graderLeakScan).toEqual(receipt);
    expect(attestation.artifactChecksums).toEqual(
      receipt.artifactManifest.map((entry) => ({
        artifactName: entry.path,
        contentHash: entry.contentHash,
        byteHash: entry.byteHash,
      })),
    );
    await expect(store.verifyExperiment(EXPERIMENT, { requireSeal: true })).resolves.toMatchObject({
      valid: true,
    });
  });

  it("fails closed without the configured scanner key or with an untrusted key id", async () => {
    const noKeyStore = await createStore(null);
    await writeAllArtifacts(noKeyStore);
    await addInitialEvent(noKeyStore);
    await expect(
      noKeyStore.sealExperiment(EXPERIMENT, {
        pinnedVersions: pinnedVersions(),
        leakScanReceipt: await createLeakScanReceipt(noKeyStore),
      }),
    ).rejects.toThrow(/verification key/u);

    const untrustedStore = await createStore();
    await writeAllArtifacts(untrustedStore);
    await addInitialEvent(untrustedStore);
    const otherKeys = generateKeyPairSync("ed25519");
    const untrustedReceipt = await createLeakScanReceipt(untrustedStore, EXPERIMENT, {
      privateKey: otherKeys.privateKey,
      keyId: "untrusted-leak-scanner",
    });
    await expect(
      untrustedStore.sealExperiment(EXPERIMENT, {
        pinnedVersions: pinnedVersions(),
        leakScanReceipt: untrustedReceipt,
      }),
    ).rejects.toThrow(/untrusted key id/u);
  });

  it("rejects a bad signature and a scanner-declared failed result", async () => {
    const signatureStore = await createStore();
    await writeAllArtifacts(signatureStore);
    await addInitialEvent(signatureStore);
    const valid = await createLeakScanReceipt(signatureStore);
    const badSignature = mutateReceipt(valid, (draft) => {
      const signature = draft.signature as Record<string, unknown>;
      signature.signature = "A".repeat(86);
    });
    await expect(
      signatureStore.sealExperiment(EXPERIMENT, {
        pinnedVersions: pinnedVersions(),
        leakScanReceipt: badSignature,
      }),
    ).rejects.toThrow(/signature is invalid/u);

    const failedStore = await createStore();
    await writeAllArtifacts(failedStore);
    await addInitialEvent(failedStore);
    const failedReceipt = await createLeakScanReceipt(failedStore, EXPERIMENT, {
      mutate: (draft) => {
        draft.status = "failed";
        draft.passed = false;
        draft.matchCountBand = "1-4";
      },
    });
    await expect(
      failedStore.sealExperiment(EXPERIMENT, {
        pinnedVersions: pinnedVersions(),
        leakScanReceipt: failedReceipt,
      }),
    ).rejects.toThrow(/receipt schema is invalid/u);
  });

  it("rejects stale receipts and receipts from the future", async () => {
    const staleStore = await createStore();
    await writeAllArtifacts(staleStore);
    await addInitialEvent(staleStore);
    const stale = await createLeakScanReceipt(staleStore, EXPERIMENT, {
      mutate: (draft) => {
        draft.checkedAt = "2026-07-26T11:54:59.999Z";
      },
    });
    await expect(
      staleStore.sealExperiment(EXPERIMENT, {
        pinnedVersions: pinnedVersions(),
        leakScanReceipt: stale,
      }),
    ).rejects.toThrow(/stale/u);

    const futureStore = await createStore();
    await writeAllArtifacts(futureStore);
    await addInitialEvent(futureStore);
    const future = await createLeakScanReceipt(futureStore, EXPERIMENT, {
      mutate: (draft) => {
        draft.checkedAt = "2026-07-26T12:00:30.001Z";
      },
    });
    await expect(
      futureStore.sealExperiment(EXPERIMENT, {
        pinnedVersions: pinnedVersions(),
        leakScanReceipt: future,
      }),
    ).rejects.toThrow(/future/u);
  });

  it("rejects missing, extra, or mutated signed artifact manifests", async () => {
    for (const mutation of ["missing", "extra", "mutated"] as const) {
      const store = await createStore();
      await writeAllArtifacts(store);
      await addInitialEvent(store);
      const receipt = await createLeakScanReceipt(store, EXPERIMENT, {
        mutate: (draft) => {
          const manifest = structuredClone(draft.artifactManifest) as Record<string, unknown>[];
          if (mutation === "missing") {
            manifest.pop();
          } else if (mutation === "extra") {
            manifest.push({
              path: "synthetic.json",
              schemaKind: "analysis",
              contentHash: "e".repeat(64),
              byteHash: "f".repeat(64),
              bytes: 12,
            });
            manifest.sort((left, right) =>
              String(left.path) < String(right.path)
                ? -1
                : String(left.path) > String(right.path)
                  ? 1
                  : 0,
            );
          } else {
            const first = manifest[0];
            if (first !== undefined) {
              first.bytes = Number(first.bytes) + 1;
            }
          }
          draft.artifactManifest = manifest;
          draft.artifactManifestHash = canonicalHash(manifest);
        },
      });

      await expect(
        store.sealExperiment(EXPERIMENT, {
          pinnedVersions: pinnedVersions(),
          leakScanReceipt: receipt,
        }),
      ).rejects.toThrow(/current experiment snapshot/u);
    }
  });

  it("rejects a receipt after an artifact, event head, or protocol changes", async () => {
    const artifactStore = await createStore();
    await writeAllArtifacts(artifactStore);
    await addInitialEvent(artifactStore);
    const artifactReceipt = await createLeakScanReceipt(artifactStore);
    const updatedExperiment = withContentHash({
      ...(schemaFixture("experiment") as Readonly<Record<string, unknown>>),
      lifecycleState: "promoted",
    });
    await artifactStore.writeArtifact(EXPERIMENT, "experiment.json", updatedExperiment);
    await expect(
      artifactStore.sealExperiment(EXPERIMENT, {
        pinnedVersions: pinnedVersions(),
        leakScanReceipt: artifactReceipt,
      }),
    ).rejects.toThrow(/current experiment snapshot/u);

    const eventStore = await createStore();
    await writeAllArtifacts(eventStore);
    await addInitialEvent(eventStore);
    const eventReceipt = await createLeakScanReceipt(eventStore);
    await eventStore.appendEvent(EXPERIMENT, {
      eventType: "operator-action",
      actor: "operator",
      payload: {
        messageCode: "post-scan-event",
        artifactName: null,
        stateFrom: null,
        stateTo: null,
        aggregateCountBand: null,
        validArmCount: null,
        invalidArmCount: null,
        attestationHash: null,
      },
    });
    await expect(
      eventStore.sealExperiment(EXPERIMENT, {
        pinnedVersions: pinnedVersions(),
        leakScanReceipt: eventReceipt,
      }),
    ).rejects.toThrow(/current experiment snapshot/u);

    const protocolStore = await createStore();
    await writeAllArtifacts(protocolStore);
    await addInitialEvent(protocolStore);
    const protocolReceipt = await createLeakScanReceipt(protocolStore);
    await protocolStore.writeArtifact(
      EXPERIMENT,
      "experiment.json",
      withContentHash({
        ...(schemaFixture("experiment") as Readonly<Record<string, unknown>>),
        protocolHash: "9".repeat(64),
      }),
    );
    await expect(
      protocolStore.sealExperiment(EXPERIMENT, {
        pinnedVersions: pinnedVersions(),
        leakScanReceipt: protocolReceipt,
      }),
    ).rejects.toThrow(/current experiment snapshot/u);
  });

  it("rejects artifacts deleted or added after the signed scan", async () => {
    const deletedStore = await createStore();
    await writeAllArtifacts(deletedStore);
    await addInitialEvent(deletedStore);
    const deletedReceipt = await createLeakScanReceipt(deletedStore);
    await unlink(join(deletedStore.root, EXPERIMENT, "analysis.json"));
    await expect(
      deletedStore.sealExperiment(EXPERIMENT, {
        pinnedVersions: pinnedVersions(),
        leakScanReceipt: deletedReceipt,
      }),
    ).rejects.toThrow(/incomplete/u);

    const addedStore = await createStore();
    await writeAllArtifacts(addedStore);
    await addInitialEvent(addedStore);
    const addedReceipt = await createLeakScanReceipt(addedStore);
    await writeFile(
      join(addedStore.root, EXPERIMENT, "unscanned.json"),
      `${canonicalJson({ content: "not-scanned" })}\n`,
    );
    await expect(
      addedStore.sealExperiment(EXPERIMENT, {
        pinnedVersions: pinnedVersions(),
        leakScanReceipt: addedReceipt,
      }),
    ).rejects.toThrow(/invalid experiment/u);
  });

  it("serializes artifact mutation against sealing", async () => {
    const store = await createStore();
    await writeAllArtifacts(store);
    await addInitialEvent(store);
    const updatedExperiment = withContentHash({
      ...(schemaFixture("experiment") as Readonly<Record<string, unknown>>),
      lifecycleState: "promoted",
    });
    const receipt = await createLeakScanReceipt(store);
    const results = await Promise.allSettled([
      store.sealExperiment(EXPERIMENT, {
        pinnedVersions: pinnedVersions(),
        leakScanReceipt: receipt,
      }),
      store.writeArtifact(EXPERIMENT, "experiment.json", updatedExperiment),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    if (results[0]?.status === "rejected") {
      await store.sealExperiment(EXPERIMENT, {
        pinnedVersions: pinnedVersions(),
        leakScanReceipt: await createLeakScanReceipt(store),
      });
    }
    const report = await store.verifyExperiment(EXPERIMENT, {
      requireSeal: true,
      requireAllArtifacts: true,
    });
    expect(report.valid).toBe(true);
  });

  it("links sealed experiments into a verifiable lineage", async () => {
    const store = await sealCompleteStore();
    const firstAttestation = await store.readArtifact(EXPERIMENT, "attestation.json");
    const secondName = "002-second-change";
    await store.createExperiment(secondName);
    await writeAllArtifactsFor(store, secondName, 2);
    await store.appendEvent(secondName, {
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
    const secondAttestation = await store.sealExperiment(secondName, {
      pinnedVersions: pinnedVersions(),
      leakScanReceipt: await createLeakScanReceipt(store, secondName),
    });

    expect(secondAttestation.previousExperimentSealHash).toBe(firstAttestation.sealChainEntryHash);
    const lineage = await store.verifySealLineage();
    expect(lineage.valid).toBe(true);
    expect(lineage.sealedExperimentCount).toBe(2);
    expect(lineage.head).toBe(secondAttestation.sealChainEntryHash);
  });

  it("rejects replaying a valid receipt across experiments", async () => {
    const store = await createStore();
    await writeAllArtifacts(store);
    await addInitialEvent(store);
    const firstReceipt = await createLeakScanReceipt(store);

    const secondName = "002-replay-target";
    await store.createExperiment(secondName);
    await writeAllArtifactsFor(store, secondName, 2);
    await store.appendEvent(secondName, {
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

    await expect(
      store.sealExperiment(secondName, {
        pinnedVersions: pinnedVersions(),
        leakScanReceipt: firstReceipt,
      }),
    ).rejects.toThrow(/current experiment snapshot/u);
  });

  it("detects a schema-valid post-seal artifact mutation through the attestation", async () => {
    const store = await sealCompleteStore();
    const analysisPath = join(store.root, EXPERIMENT, "analysis.json");
    const analysis = JSON.parse(await readFile(analysisPath, "utf8")) as Record<string, unknown>;
    analysis.uncertaintySummary = "Mutated after sealing.";
    const rehashed = withContentHash(analysis);
    await writeFile(analysisPath, `${canonicalJson(rehashed)}\n`);

    const report = await store.verifyExperiment(EXPERIMENT, { requireSeal: true });
    expect(report.valid).toBe(false);
    expect(report.errors.join(" ")).toMatch(/mismatch/u);
  });

  it("detects event-chain mutation and truncation after sealing", async () => {
    const mutationStore = await sealCompleteStore();
    const mutationEvents = join(mutationStore.root, EXPERIMENT, "events.jsonl");
    const lines = (await readFile(mutationEvents, "utf8")).trimEnd().split("\n");
    const first = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    const payload = first.payload as Record<string, unknown>;
    payload.messageCode = "tampered";
    lines[0] = canonicalJson(first);
    await writeFile(mutationEvents, `${lines.join("\n")}\n`);

    const mutationReport = await mutationStore.verifyExperiment(EXPERIMENT, {
      requireSeal: true,
    });
    expect(mutationReport.valid).toBe(false);
    expect(mutationReport.errors.join(" ")).toMatch(/contentHash|chain/u);

    const truncationStore = await sealCompleteStore();
    const truncationEvents = join(truncationStore.root, EXPERIMENT, "events.jsonl");
    const truncationLines = (await readFile(truncationEvents, "utf8")).trimEnd().split("\n");
    truncationLines.pop();
    await writeFile(truncationEvents, `${truncationLines.join("\n")}\n`);

    const truncationReport = await truncationStore.verifyExperiment(EXPERIMENT, {
      requireSeal: true,
    });
    expect(truncationReport.valid).toBe(false);
    expect(truncationReport.errors.join(" ")).toMatch(/truncation|head|sealed/u);
  });

  it("detects deleted and post-seal-added artifacts", async () => {
    const deletedStore = await sealCompleteStore();
    await unlink(join(deletedStore.root, EXPERIMENT, "analysis.json"));
    const deletedReport = await deletedStore.verifyExperiment(EXPERIMENT, {
      requireSeal: true,
    });
    expect(deletedReport.valid).toBe(false);
    expect(deletedReport.errors.join(" ")).toMatch(/missing/u);

    const addedStore = await sealCompleteStore();
    await writeFile(
      join(addedStore.root, EXPERIMENT, "unexpected.json"),
      `${canonicalJson({ release: "unsafe" })}\n`,
    );
    const addedReport = await addedStore.verifyExperiment(EXPERIMENT, {
      requireSeal: true,
    });
    expect(addedReport.valid).toBe(false);
    expect(addedReport.errors.join(" ")).toMatch(/Unexpected experiment artifact/u);
  });

  it("requires complete artifacts before sealing", async () => {
    const store = await createStore();
    await store.writeArtifact(EXPERIMENT, "experiment.json", schemaFixture("experiment"));
    await expect(
      store.sealExperiment(EXPERIMENT, {
        pinnedVersions: pinnedVersions(),
        leakScanReceipt: schemaFixture("leakScanReceipt") as LeakScanReceipt,
      }),
    ).rejects.toThrow(/incomplete/u);
  });

  it("appends hash-linked amendments without rewriting sealed evidence", async () => {
    const store = await sealCompleteStore();
    const amendment = await store.appendAmendment(EXPERIMENT, {
      reasonCode: "metadata-correction",
      summary: "Correct the aggregate hypothesis support flag.",
      operations: [
        {
          artifactName: "analysis.json",
          jsonPointer: "/hypothesisSupported",
          priorValueHash: null,
          replacementValue: false,
        },
      ],
    });
    const second = await store.appendAmendment(EXPERIMENT, {
      reasonCode: "metadata-correction-followup",
      summary: "Correct the corresponding aggregate uncertainty summary.",
      operations: [
        {
          artifactName: "analysis.json",
          jsonPointer: "/uncertaintySummary",
          priorValueHash: null,
          replacementValue: "Corrected aggregate uncertainty.",
        },
      ],
    });

    expect(second.previousAmendmentHash).toBe(amendment.contentHash);
    const report = await store.verifyExperiment(EXPERIMENT, { requireSeal: true });
    expect(report.valid).toBe(true);
    expect(report.amendmentCount).toBe(2);
  });

  it("detects amendment mutation and numbering gaps", async () => {
    const store = await sealCompleteStore();
    await store.appendAmendment(EXPERIMENT, {
      reasonCode: "metadata-correction",
      summary: "Correct aggregate metadata.",
      operations: [
        {
          artifactName: "analysis.json",
          jsonPointer: "/hypothesisSupported",
          priorValueHash: null,
          replacementValue: false,
        },
      ],
    });
    const amendmentPath = join(store.root, EXPERIMENT, "amendments", "0001.json");
    const amendment = JSON.parse(await readFile(amendmentPath, "utf8")) as Record<string, unknown>;
    amendment.summary = "Tampered amendment.";
    await writeFile(amendmentPath, `${canonicalJson(amendment)}\n`);

    const report = await store.verifyExperiment(EXPERIMENT, { requireSeal: true });
    expect(report.valid).toBe(false);
    expect(report.errors.join(" ")).toMatch(/contentHash/u);
  });

  it("rejects a local trials directory as unexpected row-level evidence", async () => {
    const store = await createStore();
    await mkdir(join(store.root, EXPERIMENT, "trials"));
    const report = await store.verifyExperiment(EXPERIMENT);
    expect(report.valid).toBe(false);
    expect(report.errors.join(" ")).toMatch(/Unexpected non-file entry "trials"/u);
  });
});
