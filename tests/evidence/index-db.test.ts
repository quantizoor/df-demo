import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  EvidenceIntegrityError,
  ExperimentStore,
  queryIndexedExperiments,
  queryIndexedFailureCards,
  rebuildEvidenceIndex,
} from "../../src/evidence/index.js";
import { canonicalJson } from "../../src/schemas/canonical.js";
import { schemaFixture } from "../schemas/fixtures.js";

const temporaryDirectories: string[] = [];
const EXPERIMENT = "001-test-change";

async function preparedStore(): Promise<{
  readonly store: ExperimentStore;
  readonly indexPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "df-index-test-"));
  temporaryDirectories.push(root);
  const store = new ExperimentStore(join(root, "experiments"), {
    now: () => new Date("2026-07-26T12:00:00.000Z"),
  });
  await store.initialize();
  await store.createExperiment(EXPERIMENT);
  await store.writeArtifact(EXPERIMENT, "experiment.json", schemaFixture("experiment"));
  await store.writeArtifact(EXPERIMENT, "results.json", schemaFixture("results"));
  await store.writeArtifact(EXPERIMENT, "decision.json", schemaFixture("decision"));
  await store.writeArtifact(EXPERIMENT, "failure-cards.json", schemaFixture("failureCards"));
  await store.appendEvent(EXPERIMENT, {
    eventType: "evaluator-milestone",
    actor: "trusted-broker",
    payload: {
      messageCode: "validation-complete",
      artifactName: "results.json",
      stateFrom: "validation-evaluating",
      stateTo: "analyzed",
      aggregateCountBand: "20+",
      validArmCount: 24,
      invalidArmCount: 0,
      attestationHash: "a".repeat(64),
    },
  });
  return { store, indexPath: join(root, "evidence-index.sqlite") };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("disposable SQLite evidence index", () => {
  it("rebuilds exclusively from validated JSON and exposes bounded aggregate queries", async () => {
    const { store, indexPath } = await preparedStore();
    const summary = await rebuildEvidenceIndex(
      store,
      indexPath,
      () => new Date("2026-07-26T13:00:00.000Z"),
    );

    expect(summary).toMatchObject({
      experimentCount: 1,
      artifactCount: 4,
      eventCount: 1,
      failureCardCount: 1,
      rebuiltAt: "2026-07-26T13:00:00.000Z",
      sealLineageHead: null,
    });

    expect(queryIndexedExperiments(indexPath)).toEqual([
      expect.objectContaining({
        experimentNumber: 1,
        directoryName: EXPERIMENT,
        lifecycleState: "analyzed",
        sealed: false,
        totalCostUsd: 0.3,
      }),
    ]);
    expect(queryIndexedFailureCards(indexPath, "recovery-policy")).toEqual([
      expect.objectContaining({
        experimentNumber: 1,
        cardId: "card-001",
        affectedHarnessComponent: "recovery-policy",
        distinctTaskCountBand: "10-19",
        trajectoryCountBand: "20-39",
      }),
    ]);
    expect(queryIndexedFailureCards(indexPath, "planning-policy")).toEqual([]);
  });

  it("contains no row-level task, trajectory, command, or grader columns", async () => {
    const { store, indexPath } = await preparedStore();
    await rebuildEvidenceIndex(store, indexPath);
    const database = new DatabaseSync(indexPath, { readOnly: true });
    try {
      const rows = database
        .prepare("SELECT sql FROM sqlite_master WHERE type IN ('table', 'index')")
        .all() as Readonly<Record<string, unknown>>[];
      const schemaSql = rows
        .map((row) => String(row.sql ?? ""))
        .join("\n")
        .toLowerCase();
      expect(schemaSql).not.toMatch(
        /\b(task_id|task_name|trial_id|trial_handle|trajectory|command|stdout|stderr|grader)\b/u,
      );
    } finally {
      database.close();
    }
  });

  it("fails closed on mutated source JSON and preserves the previous disposable index", async () => {
    const { store, indexPath } = await preparedStore();
    await rebuildEvidenceIndex(store, indexPath);
    const analysisPath = join(store.root, EXPERIMENT, "results.json");
    const result = JSON.parse(await readFile(analysisPath, "utf8")) as Record<string, unknown>;
    result.totalCost = {
      inputTokens: 0,
      outputTokens: 0,
      modelUsd: 0,
      sandboxUsd: 0,
      totalUsd: 0,
      wallTimeMs: 0,
    };
    await writeFile(analysisPath, `${canonicalJson(result)}\n`);

    await expect(rebuildEvidenceIndex(store, indexPath)).rejects.toBeInstanceOf(
      EvidenceIntegrityError,
    );
    expect(queryIndexedExperiments(indexPath)).toHaveLength(1);
  });

  it("can be deleted and rebuilt without losing authoritative evidence", async () => {
    const { store, indexPath } = await preparedStore();
    await rebuildEvidenceIndex(store, indexPath);
    await unlink(indexPath);

    const rebuilt = await rebuildEvidenceIndex(store, indexPath);
    expect(rebuilt.experimentCount).toBe(1);
    expect(queryIndexedExperiments(indexPath)[0]?.experimentHash).toBe(
      (schemaFixture("experiment") as Readonly<Record<string, unknown>>).contentHash,
    );
  });

  it("bounds query sizes", async () => {
    const { store, indexPath } = await preparedStore();
    await rebuildEvidenceIndex(store, indexPath);
    expect(() => queryIndexedExperiments(indexPath, 0)).toThrow(RangeError);
    expect(() => queryIndexedFailureCards(indexPath, null, 1_001)).toThrow(RangeError);
  });
});
