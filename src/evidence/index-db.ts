import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type {
  Decision,
  Experiment,
  FailureCards,
  Results,
} from "../schemas/artifacts.js";
import { SCHEMA_VERSION } from "../schemas/primitives.js";
import { EvidenceIntegrityError } from "./errors.js";
import { readAndVerifyEventChain } from "./events.js";
import { ExperimentStore } from "./store.js";

export interface EvidenceIndexBuildSummary {
  readonly experimentCount: number;
  readonly artifactCount: number;
  readonly eventCount: number;
  readonly failureCardCount: number;
  readonly rebuiltAt: string;
  readonly sealLineageHead: string | null;
}

export interface IndexedExperiment {
  readonly experimentNumber: number;
  readonly directoryName: string;
  readonly slug: string;
  readonly lifecycleState: string;
  readonly finalDisposition: string | null;
  readonly runMode: string;
  readonly parentExperimentNumber: number | null;
  readonly championBefore: string | null;
  readonly championAfter: string | null;
  readonly protocolHash: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly sealed: boolean;
  readonly totalCostUsd: number | null;
  readonly experimentHash: string;
  readonly resultsHash: string | null;
  readonly decisionHash: string | null;
}

export interface IndexedFailureCard {
  readonly experimentNumber: number;
  readonly cardId: string;
  readonly affectedHarnessComponent: string;
  readonly effectSize: number;
  readonly uncertaintyLower: number;
  readonly uncertaintyUpper: number;
  readonly distinctTaskCountBand: string;
  readonly trajectoryCountBand: string;
  readonly minimumComparedGroupSizeBand: string;
}

const SCHEMA_SQL = `
  PRAGMA journal_mode = DELETE;
  PRAGMA synchronous = FULL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE metadata (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT
  ) STRICT;

  CREATE TABLE experiments (
    experiment_number INTEGER PRIMARY KEY NOT NULL,
    directory_name TEXT UNIQUE NOT NULL,
    slug TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL,
    final_disposition TEXT,
    run_mode TEXT NOT NULL,
    parent_experiment_number INTEGER,
    champion_before TEXT,
    champion_after TEXT,
    protocol_hash TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    sealed INTEGER NOT NULL CHECK (sealed IN (0, 1)),
    total_cost_usd REAL,
    experiment_hash TEXT NOT NULL,
    results_hash TEXT,
    decision_hash TEXT
  ) STRICT;

  CREATE TABLE artifacts (
    experiment_number INTEGER NOT NULL,
    artifact_name TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (experiment_number, artifact_name),
    FOREIGN KEY (experiment_number) REFERENCES experiments(experiment_number)
  ) STRICT;

  CREATE TABLE events (
    experiment_number INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL,
    message_code TEXT NOT NULL,
    valid_arm_count INTEGER,
    invalid_arm_count INTEGER,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (experiment_number, sequence),
    FOREIGN KEY (experiment_number) REFERENCES experiments(experiment_number)
  ) STRICT;

  CREATE TABLE failure_cards (
    experiment_number INTEGER NOT NULL,
    card_id TEXT NOT NULL,
    affected_harness_component TEXT NOT NULL,
    effect_size REAL NOT NULL,
    uncertainty_lower REAL NOT NULL,
    uncertainty_upper REAL NOT NULL,
    distinct_task_count_band TEXT NOT NULL,
    trajectory_count_band TEXT NOT NULL,
    minimum_compared_group_size_band TEXT NOT NULL,
    PRIMARY KEY (experiment_number, card_id),
    FOREIGN KEY (experiment_number) REFERENCES experiments(experiment_number)
  ) STRICT;

  CREATE INDEX experiments_lifecycle_idx
    ON experiments(lifecycle_state, experiment_number);
  CREATE INDEX failure_cards_component_idx
    ON failure_cards(affected_harness_component, experiment_number);
`;

function insertExperiment(
  statement: StatementSync,
  directoryName: string,
  experiment: Experiment,
  results: Results | null,
  decision: Decision | null,
  sealed: boolean,
): void {
  statement.run(
    experiment.experimentNumber,
    directoryName,
    experiment.slug,
    experiment.lifecycleState,
    experiment.finalDisposition,
    experiment.runMode,
    experiment.parentExperimentNumber,
    experiment.championBefore,
    experiment.championAfter,
    experiment.protocolHash,
    experiment.startedAt,
    experiment.finishedAt,
    sealed ? 1 : 0,
    results?.totalCost.totalUsd ?? null,
    experiment.contentHash,
    results?.contentHash ?? null,
    decision?.contentHash ?? null,
  );
}

function insertFailureCards(statement: StatementSync, cards: FailureCards): number {
  for (const card of cards.cards) {
    statement.run(
      cards.experimentNumber,
      card.cardId,
      card.affectedHarnessComponent,
      card.effectSize,
      card.uncertainty.lower,
      card.uncertainty.upper,
      card.support.distinctTaskCountBand,
      card.support.trajectoryCountBand,
      card.support.minimumComparedGroupSizeBand,
    );
  }
  return cards.cards.length;
}

function requiredNumber(row: Readonly<Record<string, unknown>>, name: string): number {
  const value = row[name];
  if (typeof value !== "number") {
    throw new Error(`SQLite index column "${name}" is not a number`);
  }
  return value;
}

function nullableNumber(row: Readonly<Record<string, unknown>>, name: string): number | null {
  const value = row[name];
  if (value === null) {
    return null;
  }
  return requiredNumber(row, name);
}

function requiredString(row: Readonly<Record<string, unknown>>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") {
    throw new Error(`SQLite index column "${name}" is not a string`);
  }
  return value;
}

function nullableString(row: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = row[name];
  if (value === null) {
    return null;
  }
  return requiredString(row, name);
}

export async function rebuildEvidenceIndex(
  store: ExperimentStore,
  indexPath: string,
  now: () => Date = () => new Date(),
): Promise<EvidenceIndexBuildSummary> {
  const rebuiltAt = now().toISOString();
  await mkdir(dirname(indexPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${indexPath}.${randomUUID().replaceAll("-", "")}.tmp`;
  const database = new DatabaseSync(temporaryPath);
  let experimentCount = 0;
  let artifactCount = 0;
  let eventCount = 0;
  let failureCardCount = 0;
  let sealLineageHead: string | null = null;

  try {
    database.exec(SCHEMA_SQL);
    const insertMetadata = database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)");
    const insertExperimentStatement = database.prepare(`
      INSERT INTO experiments(
        experiment_number, directory_name, slug, lifecycle_state, final_disposition,
        run_mode, parent_experiment_number, champion_before, champion_after,
        protocol_hash, started_at, finished_at, sealed, total_cost_usd,
        experiment_hash, results_hash, decision_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertArtifact = database.prepare(`
      INSERT INTO artifacts(experiment_number, artifact_name, content_hash)
      VALUES (?, ?, ?)
    `);
    const insertEvent = database.prepare(`
      INSERT INTO events(
        experiment_number, sequence, event_type, actor, created_at, message_code,
        valid_arm_count, invalid_arm_count, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFailureCard = database.prepare(`
      INSERT INTO failure_cards(
        experiment_number, card_id, affected_harness_component, effect_size,
        uncertainty_lower, uncertainty_upper, distinct_task_count_band,
        trajectory_count_band, minimum_compared_group_size_band
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    database.exec("BEGIN IMMEDIATE");
    try {
      const experimentNames = await store.listExperimentNames();
      for (const experimentName of experimentNames) {
        const report = await store.verifyExperiment(experimentName);
        if (!report.valid) {
          throw new EvidenceIntegrityError(
            `Cannot index invalid experiment "${experimentName}"`,
            report.errors,
          );
        }
        if (report.artifactHashes["experiment.json"] === undefined) {
          continue;
        }

        const experiment = await store.readArtifact(experimentName, "experiment.json");
        const results =
          report.artifactHashes["results.json"] === undefined
            ? null
            : await store.readArtifact(experimentName, "results.json");
        const decision =
          report.artifactHashes["decision.json"] === undefined
            ? null
            : await store.readArtifact(experimentName, "decision.json");
        insertExperiment(
          insertExperimentStatement,
          experimentName,
          experiment,
          results,
          decision,
          report.sealed,
        );
        experimentCount += 1;

        for (const [artifactName, contentHash] of Object.entries(report.artifactHashes)) {
          insertArtifact.run(experiment.experimentNumber, artifactName, contentHash);
          artifactCount += 1;
        }

        const eventsPath = join(store.root, experimentName, "events.jsonl");
        if (report.eventRecordCount > 0) {
          const chain = await readAndVerifyEventChain(eventsPath);
          for (const event of chain.records) {
            insertEvent.run(
              event.experimentNumber,
              event.sequence,
              event.eventType,
              event.actor,
              event.createdAt,
              event.payload.messageCode,
              event.payload.validArmCount,
              event.payload.invalidArmCount,
              event.contentHash,
            );
            eventCount += 1;
          }
        }

        if (report.artifactHashes["failure-cards.json"] !== undefined) {
          const cards = await store.readArtifact(experimentName, "failure-cards.json");
          failureCardCount += insertFailureCards(insertFailureCard, cards);
        }
      }

      const lineage = await store.verifySealLineage();
      if (!lineage.valid) {
        throw new EvidenceIntegrityError("Cannot index an invalid seal lineage", lineage.errors);
      }
      insertMetadata.run("schemaVersion", SCHEMA_VERSION);
      insertMetadata.run("rebuiltAt", rebuiltAt);
      insertMetadata.run("sealLineageHead", lineage.head);
      sealLineageHead = lineage.head;
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    database.close();
    await rename(temporaryPath, indexPath);

    return {
      experimentCount,
      artifactCount,
      eventCount,
      failureCardCount,
      rebuiltAt,
      sealLineageHead,
    };
  } catch (error) {
    try {
      database.close();
    } catch {
      // The database may already be closed after a successful commit.
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function queryIndexedExperiments(
  indexPath: string,
  limit = 100,
): readonly IndexedExperiment[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("Index query limit must be an integer from 1 through 1000");
  }
  const database = new DatabaseSync(indexPath, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT
          experiment_number, directory_name, slug, lifecycle_state, final_disposition,
          run_mode, parent_experiment_number, champion_before, champion_after,
          protocol_hash, started_at, finished_at, sealed, total_cost_usd,
          experiment_hash, results_hash, decision_hash
        FROM experiments
        ORDER BY experiment_number DESC
        LIMIT ?`,
      )
      .all(limit) as Readonly<Record<string, unknown>>[];
    return rows.map((row) => ({
      experimentNumber: requiredNumber(row, "experiment_number"),
      directoryName: requiredString(row, "directory_name"),
      slug: requiredString(row, "slug"),
      lifecycleState: requiredString(row, "lifecycle_state"),
      finalDisposition: nullableString(row, "final_disposition"),
      runMode: requiredString(row, "run_mode"),
      parentExperimentNumber: nullableNumber(row, "parent_experiment_number"),
      championBefore: nullableString(row, "champion_before"),
      championAfter: nullableString(row, "champion_after"),
      protocolHash: requiredString(row, "protocol_hash"),
      startedAt: requiredString(row, "started_at"),
      finishedAt: nullableString(row, "finished_at"),
      sealed: requiredNumber(row, "sealed") === 1,
      totalCostUsd: nullableNumber(row, "total_cost_usd"),
      experimentHash: requiredString(row, "experiment_hash"),
      resultsHash: nullableString(row, "results_hash"),
      decisionHash: nullableString(row, "decision_hash"),
    }));
  } finally {
    database.close();
  }
}

export function queryIndexedFailureCards(
  indexPath: string,
  affectedHarnessComponent: string | null = null,
  limit = 100,
): readonly IndexedFailureCard[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("Index query limit must be an integer from 1 through 1000");
  }
  const database = new DatabaseSync(indexPath, { readOnly: true });
  try {
    const statement =
      affectedHarnessComponent === null
        ? database.prepare(`
            SELECT * FROM failure_cards
            ORDER BY experiment_number DESC, card_id
            LIMIT ?
          `)
        : database.prepare(`
            SELECT * FROM failure_cards
            WHERE affected_harness_component = ?
            ORDER BY experiment_number DESC, card_id
            LIMIT ?
          `);
    const rows = (
      affectedHarnessComponent === null
        ? statement.all(limit)
        : statement.all(affectedHarnessComponent, limit)
    ) as Readonly<Record<string, unknown>>[];
    return rows.map((row) => ({
      experimentNumber: requiredNumber(row, "experiment_number"),
      cardId: requiredString(row, "card_id"),
      affectedHarnessComponent: requiredString(row, "affected_harness_component"),
      effectSize: requiredNumber(row, "effect_size"),
      uncertaintyLower: requiredNumber(row, "uncertainty_lower"),
      uncertaintyUpper: requiredNumber(row, "uncertainty_upper"),
      distinctTaskCountBand: requiredString(row, "distinct_task_count_band"),
      trajectoryCountBand: requiredString(row, "trajectory_count_band"),
      minimumComparedGroupSizeBand: requiredString(
        row,
        "minimum_compared_group_size_band",
      ),
    }));
  } finally {
    database.close();
  }
}
