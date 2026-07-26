import type { KeyLike } from "node:crypto";
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type {
  Amendment,
  Attestation,
  EventRecord,
  LeakScanArtifactManifestEntry,
  LeakScanReceipt,
} from "../schemas/artifacts.js";
import { canonicalHash, canonicalJson, sha256, withContentHash } from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import {
  type ArtifactFileName,
  artifactFileSchemas,
  assertSchemaShape,
  assertValidDocument,
  isArtifactFileName,
  REQUIRED_PRESEAL_ARTIFACT_FILES,
  type SchemaValue,
  schemaNameForArtifact,
} from "../schemas/registry.js";
import { atomicWriteFile, durableAppendFile, withExclusiveFileLock } from "./atomic.js";
import { EvidenceIntegrityError, EvidenceStoreError, SealedExperimentError } from "./errors.js";
import { readAndVerifyEventChain } from "./events.js";
import { verifyEd25519Signature } from "./signatures.js";

const EXPERIMENT_DIRECTORY_PATTERN = /^(\d{3,})-([a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const AMENDMENT_FILE_PATTERN = /^(\d{4})\.json$/u;

type ArtifactSchemaName<FileName extends ArtifactFileName> = (typeof artifactFileSchemas)[FileName];
export type ArtifactDocument<FileName extends ArtifactFileName> = SchemaValue<
  ArtifactSchemaName<FileName>
>;

export interface AppendEventInput {
  readonly eventType: EventRecord["eventType"];
  readonly actor: EventRecord["actor"];
  readonly payload: EventRecord["payload"];
  readonly provenanceRefs?: EventRecord["provenanceRefs"];
  readonly createdAt?: string;
}

export interface SealExperimentOptions {
  readonly pinnedVersions: Attestation["pinnedVersions"];
  readonly leakScanReceipt: LeakScanReceipt;
  readonly previousExperimentSealHash?: string | null;
  readonly signer?: Signature | null;
}

export interface LeakScanSubject {
  readonly schemaVersion: "1.0.0";
  readonly experimentId: string;
  readonly experimentNumber: number;
  readonly artifactManifest: readonly LeakScanArtifactManifestEntry[];
  readonly artifactManifestHash: string;
  readonly eventRecordCount: number;
  readonly eventChainHead: string;
  readonly protocolHash: string;
}

export interface TrustedLeakScanner {
  readonly keyId: string;
  readonly publicKey: KeyLike;
}

export interface AppendAmendmentInput {
  readonly reasonCode: string;
  readonly summary: string;
  readonly operations: Amendment["operations"];
  readonly signer?: Signature | null;
  readonly createdAt?: string;
}

export interface VerificationReport {
  readonly valid: boolean;
  readonly sealed: boolean;
  readonly errors: readonly string[];
  readonly artifactHashes: Readonly<Record<string, string>>;
  readonly eventRecordCount: number;
  readonly eventChainHead: string | null;
  readonly amendmentCount: number;
}

export interface SealLineageReport {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly sealedExperimentCount: number;
  readonly head: string | null;
}

export interface VerifyOptions {
  readonly requireSeal?: boolean;
  readonly requireAllArtifacts?: boolean;
}

export interface ExperimentStoreOptions {
  readonly now?: () => Date;
  readonly trustedLeakScanner?: TrustedLeakScanner;
  readonly maximumLeakScanReceiptAgeMs?: number;
  readonly maximumLeakScanClockSkewMs?: number;
}

const DEFAULT_MAXIMUM_LEAK_SCAN_RECEIPT_AGE_MS = 5 * 60 * 1_000;
const DEFAULT_MAXIMUM_LEAK_SCAN_CLOCK_SKEW_MS = 30 * 1_000;

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function parseExperimentNumber(experimentName: string): number {
  const match = EXPERIMENT_DIRECTORY_PATTERN.exec(experimentName);
  if (match === null || match[1] === undefined) {
    throw new EvidenceStoreError(
      `Invalid experiment directory "${experimentName}"; expected NNN-short-description`,
    );
  }
  return Number.parseInt(match[1], 10);
}

function parseExperimentSlug(experimentName: string): string {
  const match = EXPERIMENT_DIRECTORY_PATTERN.exec(experimentName);
  if (match === null || match[2] === undefined) {
    throw new EvidenceStoreError(
      `Invalid experiment directory "${experimentName}"; expected NNN-short-description`,
    );
  }
  return match[2];
}

function assertCanonicalFile(contents: string, value: unknown, label: string): void {
  if (contents !== `${canonicalJson(value)}\n`) {
    throw new Error(`${label} is not encoded as canonical JSON followed by one newline`);
  }
}

async function readJsonFile(path: string): Promise<{
  readonly bytes: Uint8Array;
  readonly contents: string;
  readonly value: unknown;
}> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${basename(path)} must be a regular file`);
  }
  const bytes = await readFile(path);
  const contents = bytes.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${basename(path)} is not valid JSON`, { cause: error });
  }
  assertCanonicalFile(contents, value, basename(path));
  return { bytes, contents, value };
}

function attestationSealPayload(
  attestation: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attestation)) {
    if (key !== "contentHash" && key !== "sealChainEntryHash" && key !== "signer") {
      payload[key] = value;
    }
  }
  return payload;
}

function leakScanReceiptProvenance(receiptHash: string): EventRecord["provenanceRefs"] {
  return [
    {
      artifactName: "leak-scan-receipt",
      contentHash: receiptHash,
    },
  ];
}

function experimentSealedEventPayload(receiptHash: string): EventRecord["payload"] {
  return {
    messageCode: "experiment-sealed",
    artifactName: null,
    stateFrom: null,
    stateTo: "sealed",
    aggregateCountBand: null,
    validArmCount: null,
    invalidArmCount: null,
    attestationHash: receiptHash,
  };
}

export class ExperimentStore {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #trustedLeakScanner: TrustedLeakScanner | undefined;
  readonly #maximumLeakScanReceiptAgeMs: number;
  readonly #maximumLeakScanClockSkewMs: number;

  public constructor(root: string, options: ExperimentStoreOptions = {}) {
    const maximumReceiptAgeMs =
      options.maximumLeakScanReceiptAgeMs ?? DEFAULT_MAXIMUM_LEAK_SCAN_RECEIPT_AGE_MS;
    const maximumClockSkewMs =
      options.maximumLeakScanClockSkewMs ?? DEFAULT_MAXIMUM_LEAK_SCAN_CLOCK_SKEW_MS;
    if (
      !Number.isSafeInteger(maximumReceiptAgeMs) ||
      maximumReceiptAgeMs < 0 ||
      !Number.isSafeInteger(maximumClockSkewMs) ||
      maximumClockSkewMs < 0
    ) {
      throw new EvidenceStoreError(
        "Leak-scan receipt age and clock-skew limits must be non-negative safe integers",
      );
    }
    if (
      options.trustedLeakScanner !== undefined &&
      (options.trustedLeakScanner.keyId.length > 96 ||
        !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(options.trustedLeakScanner.keyId))
    ) {
      throw new EvidenceStoreError("Trusted leak-scanner key id is malformed");
    }
    this.#root = resolve(root);
    this.#now = options.now ?? (() => new Date());
    this.#trustedLeakScanner = options.trustedLeakScanner;
    this.#maximumLeakScanReceiptAgeMs = maximumReceiptAgeMs;
    this.#maximumLeakScanClockSkewMs = maximumClockSkewMs;
  }

  public get root(): string {
    return this.#root;
  }

  public async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new EvidenceStoreError("Evidence root must be a regular directory");
    }
  }

  public async createExperiment(experimentName: string): Promise<string> {
    const experimentNumber = parseExperimentNumber(experimentName);
    await this.initialize();
    return withExclusiveFileLock(join(this.#root, ".allocation.lock"), async () => {
      const entries = await readdir(this.#root, { withFileTypes: true });
      if (
        entries.some(
          (entry) =>
            entry.isDirectory() &&
            EXPERIMENT_DIRECTORY_PATTERN.test(entry.name) &&
            parseExperimentNumber(entry.name) === experimentNumber,
        )
      ) {
        throw new EvidenceStoreError(`Experiment number ${experimentNumber} is already allocated`);
      }
      const path = this.#experimentPath(experimentName);
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        throw new EvidenceStoreError(`Could not create experiment "${experimentName}"`, {
          cause: error,
        });
      }
      return path;
    });
  }

  public async listExperimentNames(): Promise<readonly string[]> {
    await this.initialize();
    const entries = await readdir(this.#root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && EXPERIMENT_DIRECTORY_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort(
        (left, right) =>
          parseExperimentNumber(left) - parseExperimentNumber(right) || left.localeCompare(right),
      );
  }

  public async writeArtifact<FileName extends ArtifactFileName>(
    experimentName: string,
    fileName: FileName,
    value: unknown,
  ): Promise<void> {
    if (fileName === "attestation.json") {
      throw new EvidenceStoreError("attestation.json can only be created by sealExperiment()");
    }

    const path = await this.#assertExperimentDirectory(experimentName);
    const schemaName = artifactFileSchemas[fileName];
    assertValidDocument(schemaName, value);
    this.#assertMatchingExperimentNumber(experimentName, value);
    const document = value as Readonly<Record<string, unknown>>;
    if (fileName === "experiment.json" && document.slug !== parseExperimentSlug(experimentName)) {
      throw new EvidenceStoreError(
        `Artifact slug "${String(document.slug)}" does not match directory "${parseExperimentSlug(experimentName)}"`,
      );
    }
    await withExclusiveFileLock(this.#mutationLockPath(experimentName), async () => {
      await this.#assertUnsealed(experimentName, path);
      await atomicWriteFile(join(path, fileName), `${canonicalJson(value)}\n`, {
        overwrite: fileName === "experiment.json",
      });
    });
  }

  public async readArtifact<FileName extends ArtifactFileName>(
    experimentName: string,
    fileName: FileName,
  ): Promise<ArtifactDocument<FileName>> {
    const path = await this.#assertExperimentDirectory(experimentName);
    const { value } = await readJsonFile(join(path, fileName));
    const schemaName = artifactFileSchemas[fileName];
    assertValidDocument(schemaName, value);
    this.#assertMatchingExperimentNumber(experimentName, value);
    const document = value as Readonly<Record<string, unknown>>;
    if (fileName === "experiment.json" && document.slug !== parseExperimentSlug(experimentName)) {
      throw new EvidenceStoreError(
        `Artifact slug "${String(document.slug)}" does not match directory "${parseExperimentSlug(experimentName)}"`,
      );
    }
    return value as ArtifactDocument<FileName>;
  }

  public async appendEvent(experimentName: string, input: AppendEventInput): Promise<EventRecord> {
    const path = await this.#assertExperimentDirectory(experimentName);
    return withExclusiveFileLock(this.#mutationLockPath(experimentName), async () => {
      await this.#assertUnsealed(experimentName, path);
      return this.#appendEventUnlocked(experimentName, path, input);
    });
  }

  /**
   * Captures the exact pre-seal bytes and event head a trusted leak scanner
   * must scan and sign. The snapshot is intentionally not a seal: every field
   * is recomputed and compared again while holding the mutation lock.
   */
  public async captureLeakScanSubject(experimentName: string): Promise<LeakScanSubject> {
    const path = await this.#assertExperimentDirectory(experimentName);
    return withExclusiveFileLock(this.#mutationLockPath(experimentName), async () => {
      await this.#assertUnsealed(experimentName, path);
      await this.#assertCompleteAndValidPreseal(experimentName, path);
      return this.#captureLeakScanSubjectUnlocked(experimentName, path);
    });
  }

  public async sealExperiment(
    experimentName: string,
    options: SealExperimentOptions,
  ): Promise<Attestation> {
    const path = await this.#assertExperimentDirectory(experimentName);
    return withExclusiveFileLock(this.#mutationLockPath(experimentName), async () => {
      await this.#assertUnsealed(experimentName, path);
      await this.#assertCompleteAndValidPreseal(experimentName, path);

      // Detach from caller-owned memory before any await that mutates evidence.
      const leakScanReceipt = JSON.parse(canonicalJson(options.leakScanReceipt)) as LeakScanReceipt;
      const scannedSubject = await this.#captureLeakScanSubjectUnlocked(experimentName, path);
      this.#assertLeakScanReceipt(leakScanReceipt, scannedSubject, this.#now().getTime(), true);
      const discoveredPreviousSealHash = await this.#latestPriorSealHash(
        parseExperimentNumber(experimentName),
      );
      if (
        options.previousExperimentSealHash !== undefined &&
        options.previousExperimentSealHash !== discoveredPreviousSealHash
      ) {
        throw new EvidenceIntegrityError("Previous experiment seal hash does not match store", [
          `expected ${discoveredPreviousSealHash ?? "null"}`,
          `received ${options.previousExperimentSealHash ?? "null"}`,
        ]);
      }
      const previousExperimentSealHash = discoveredPreviousSealHash;
      const sealingTime = this.#now();
      const sealedAt = sealingTime.toISOString();
      this.#assertLeakScanReceipt(leakScanReceipt, scannedSubject, sealingTime.getTime(), true);
      const scannedChecksums = scannedSubject.artifactManifest.map((artifact) => ({
        artifactName: artifact.path,
        contentHash: artifact.contentHash,
        byteHash: artifact.byteHash,
      }));
      try {
        assertSchemaShape("attestation", {
          schemaVersion: "1.0.0",
          createdAt: sealedAt,
          provenanceRefs: scannedChecksums.map((artifact) => ({
            artifactName: artifact.artifactName,
            contentHash: artifact.contentHash,
          })),
          contentHash: "0".repeat(64),
          experimentNumber: parseExperimentNumber(experimentName),
          schemaChecksPassed: true,
          artifactChecksums: scannedChecksums,
          pinnedVersions: options.pinnedVersions,
          graderLeakScan: leakScanReceipt,
          eventRecordCount: scannedSubject.eventRecordCount,
          eventChainHead: scannedSubject.eventChainHead,
          sealedAt,
          previousExperimentSealHash,
          sealChainEntryHash: "0".repeat(64),
          signer: options.signer ?? null,
        });
      } catch (error) {
        throw new EvidenceIntegrityError("Seal options are invalid", [
          error instanceof Error ? error.message : String(error),
        ]);
      }

      const eventChainBeforeSeal = await readAndVerifyEventChain(join(path, "events.jsonl"));
      if (
        eventChainBeforeSeal.records.length !== scannedSubject.eventRecordCount ||
        eventChainBeforeSeal.head !== scannedSubject.eventChainHead
      ) {
        throw new EvidenceIntegrityError("Event chain changed after the accepted leak scan", []);
      }
      await this.#appendEventUnlocked(experimentName, path, {
        eventType: "experiment-sealed",
        actor: "controller",
        createdAt: sealedAt,
        provenanceRefs: leakScanReceiptProvenance(leakScanReceipt.contentHash),
        payload: experimentSealedEventPayload(leakScanReceipt.contentHash),
      });
      const eventChain = await readAndVerifyEventChain(join(path, "events.jsonl"));
      if (eventChain.head === null) {
        throw new EvidenceStoreError("A sealed experiment must have a non-empty event chain");
      }
      const finalEvent = eventChain.records.at(-1);
      if (
        eventChain.records.length !== scannedSubject.eventRecordCount + 1 ||
        finalEvent === undefined ||
        finalEvent.eventType !== "experiment-sealed" ||
        finalEvent.actor !== "controller" ||
        finalEvent.previousEventHash !== scannedSubject.eventChainHead ||
        canonicalJson(finalEvent.payload) !==
          canonicalJson(experimentSealedEventPayload(leakScanReceipt.contentHash)) ||
        canonicalJson(finalEvent.provenanceRefs) !==
          canonicalJson(leakScanReceiptProvenance(leakScanReceipt.contentHash))
      ) {
        throw new EvidenceIntegrityError(
          "Seal event does not extend the signed leak-scan event head exactly once",
          [],
        );
      }

      // A cooperative mutation cannot enter while this lock is held. This
      // second byte-for-byte snapshot also detects a direct filesystem write
      // that completed after the scan was accepted but before attestation.
      const finalSubject = await this.#captureLeakScanSubjectUnlocked(experimentName, path);
      if (
        finalSubject.artifactManifestHash !== scannedSubject.artifactManifestHash ||
        finalSubject.protocolHash !== scannedSubject.protocolHash
      ) {
        throw new EvidenceIntegrityError(
          "Experiment artifacts changed after the accepted leak scan",
          [
            `scanned manifest ${scannedSubject.artifactManifestHash}`,
            `current manifest ${finalSubject.artifactManifestHash}`,
          ],
        );
      }
      const artifactChecksums: Attestation["artifactChecksums"] = finalSubject.artifactManifest.map(
        (artifact) => ({
          artifactName: artifact.path,
          contentHash: artifact.contentHash,
          byteHash: artifact.byteHash,
        }),
      );

      const sealPayload: Omit<Attestation, "contentHash" | "sealChainEntryHash" | "signer"> = {
        schemaVersion: "1.0.0",
        createdAt: sealedAt,
        provenanceRefs: artifactChecksums.map((artifact) => ({
          artifactName: artifact.artifactName,
          contentHash: artifact.contentHash,
        })),
        experimentNumber: parseExperimentNumber(experimentName),
        schemaChecksPassed: true,
        artifactChecksums,
        pinnedVersions: options.pinnedVersions,
        graderLeakScan: leakScanReceipt,
        eventRecordCount: eventChain.records.length,
        eventChainHead: eventChain.head,
        sealedAt,
        previousExperimentSealHash,
      };
      const sealChainEntryHash = canonicalHash(attestationSealPayload(sealPayload));
      const withoutHash: Omit<Attestation, "contentHash"> = {
        ...sealPayload,
        sealChainEntryHash,
        signer: options.signer ?? null,
      };
      const attestation = withContentHash(withoutHash);
      assertValidDocument("attestation", attestation);
      await atomicWriteFile(join(path, "attestation.json"), `${canonicalJson(attestation)}\n`);

      const sealedReport = await this.verifyExperiment(experimentName, { requireSeal: true });
      if (!sealedReport.valid) {
        throw new EvidenceIntegrityError(
          "Experiment failed verification immediately after sealing",
          sealedReport.errors,
        );
      }
      return attestation;
    });
  }

  public async appendAmendment(
    experimentName: string,
    input: AppendAmendmentInput,
  ): Promise<Amendment> {
    const path = await this.#assertExperimentDirectory(experimentName);
    return withExclusiveFileLock(this.#mutationLockPath(experimentName), async () => {
      const report = await this.verifyExperiment(experimentName, { requireSeal: true });
      if (!report.valid) {
        throw new EvidenceIntegrityError("Cannot amend an invalid experiment", report.errors);
      }
      const attestation = await this.readArtifact(experimentName, "attestation.json");
      const amendmentsPath = join(path, "amendments");
      await mkdir(amendmentsPath, { recursive: true, mode: 0o700 });
      const amendmentsInfo = await lstat(amendmentsPath);
      if (!amendmentsInfo.isDirectory() || amendmentsInfo.isSymbolicLink()) {
        throw new EvidenceStoreError("Amendments path must be a regular directory");
      }
      const amendments = await this.#readAmendments(amendmentsPath);
      const previousAmendment = amendments.at(-1);
      const amendmentNumber = amendments.length + 1;
      const createdAt = input.createdAt ?? this.#now().toISOString();
      const withoutHash: Omit<Amendment, "contentHash"> = {
        schemaVersion: "1.0.0",
        createdAt,
        provenanceRefs: [
          {
            artifactName: "attestation.json",
            contentHash: attestation.contentHash,
          },
        ],
        experimentNumber: parseExperimentNumber(experimentName),
        amendmentNumber,
        sealedAttestationHash: attestation.contentHash,
        previousAmendmentHash: previousAmendment?.contentHash ?? null,
        reasonCode: input.reasonCode,
        summary: input.summary,
        operations: input.operations,
        signer: input.signer ?? null,
      };
      const amendment = withContentHash(withoutHash);
      assertValidDocument("amendment", amendment);
      const filename = `${amendmentNumber.toString().padStart(4, "0")}.json`;
      await atomicWriteFile(join(amendmentsPath, filename), `${canonicalJson(amendment)}\n`);
      return amendment;
    });
  }

  public async verifyExperiment(
    experimentName: string,
    options: VerifyOptions = {},
  ): Promise<VerificationReport> {
    const path = await this.#assertExperimentDirectory(experimentName);
    const errors: string[] = [];
    const artifactHashes: Record<string, string> = {};
    let eventRecordCount = 0;
    let eventChainHead: string | null = null;
    let eventRecords: readonly EventRecord[] = [];
    let amendmentCount = 0;

    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "events.jsonl" || entry.name === "amendments") {
        continue;
      }
      if (!entry.isFile()) {
        errors.push(`Unexpected non-file entry "${entry.name}"`);
        continue;
      }
      if (!isArtifactFileName(entry.name)) {
        errors.push(`Unexpected experiment artifact "${entry.name}"`);
        continue;
      }

      try {
        const { value } = await readJsonFile(join(path, entry.name));
        const schemaName = schemaNameForArtifact(entry.name);
        if (schemaName === undefined) {
          errors.push(`No schema registered for "${entry.name}"`);
          continue;
        }
        assertValidDocument(schemaName, value);
        this.#assertMatchingExperimentNumber(experimentName, value);
        const document = value as Readonly<Record<string, unknown>>;
        if (
          entry.name === "experiment.json" &&
          document.slug !== parseExperimentSlug(experimentName)
        ) {
          throw new EvidenceStoreError(
            `Artifact slug "${String(document.slug)}" does not match directory "${parseExperimentSlug(experimentName)}"`,
          );
        }
        artifactHashes[entry.name] = value.contentHash;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    try {
      const chain = await readAndVerifyEventChain(join(path, "events.jsonl"));
      for (const record of chain.records) {
        if (record.experimentNumber !== parseExperimentNumber(experimentName)) {
          throw new Error(`events.jsonl sequence ${record.sequence} has wrong experiment number`);
        }
      }
      eventRecordCount = chain.records.length;
      eventChainHead = chain.head;
      eventRecords = chain.records;
    } catch (error) {
      if (!isMissingFile(error)) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    const sealed = Object.hasOwn(artifactHashes, "attestation.json");
    if (options.requireSeal === true && !sealed) {
      errors.push("attestation.json is required but missing");
    }
    if (options.requireAllArtifacts === true) {
      for (const fileName of REQUIRED_PRESEAL_ARTIFACT_FILES) {
        if (!Object.hasOwn(artifactHashes, fileName)) {
          errors.push(`Required artifact "${fileName}" is missing`);
        }
      }
    }

    if (sealed) {
      try {
        const attestation = await this.readArtifact(experimentName, "attestation.json");
        await this.#verifyAttestation(
          experimentName,
          attestation,
          artifactHashes,
          eventRecords,
          path,
        );
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    const amendmentsEntry = entries.find((entry) => entry.name === "amendments");
    if (amendmentsEntry !== undefined) {
      if (!amendmentsEntry.isDirectory()) {
        errors.push('"amendments" must be a directory');
      } else if (!sealed) {
        errors.push("An unsealed experiment cannot contain amendments");
      } else {
        try {
          const amendments = await this.#readAmendments(join(path, "amendments"));
          amendmentCount = amendments.length;
          const attestationHash = artifactHashes["attestation.json"];
          let priorHash: string | null = null;
          for (const [index, amendment] of amendments.entries()) {
            if (amendment.amendmentNumber !== index + 1) {
              throw new Error(`Amendment numbering mismatch at index ${index}`);
            }
            if (amendment.previousAmendmentHash !== priorHash) {
              throw new Error(`Amendment hash-chain mismatch at amendment ${index + 1}`);
            }
            if (amendment.sealedAttestationHash !== attestationHash) {
              throw new Error(`Amendment ${index + 1} does not bind the sealed attestation`);
            }
            for (const operation of amendment.operations) {
              if (!isArtifactFileName(operation.artifactName)) {
                throw new Error(
                  `Amendment ${index + 1} references unknown artifact "${operation.artifactName}"`,
                );
              }
            }
            priorHash = amendment.contentHash;
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    return {
      valid: errors.length === 0,
      sealed,
      errors,
      artifactHashes,
      eventRecordCount,
      eventChainHead,
      amendmentCount,
    };
  }

  public async verifySealLineage(): Promise<SealLineageReport> {
    await this.initialize();
    const entries = await readdir(this.#root, { withFileTypes: true });
    const experiments = entries
      .filter((entry) => entry.isDirectory() && EXPERIMENT_DIRECTORY_PATTERN.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        number: parseExperimentNumber(entry.name),
      }))
      .sort((left, right) => left.number - right.number || left.name.localeCompare(right.name));
    const errors: string[] = [];
    const seenNumbers = new Set<number>();
    const seenOneUseAttestations = new Set<string>();
    const seenConsumptionAttestations = new Set<string>();
    let previousSealHash: string | null = null;
    let sealedExperimentCount = 0;

    for (const experiment of experiments) {
      if (seenNumbers.has(experiment.number)) {
        errors.push(`Duplicate experiment number ${experiment.number}`);
      }
      seenNumbers.add(experiment.number);
      try {
        const attestation = await this.readArtifact(experiment.name, "attestation.json");
        if (attestation.previousExperimentSealHash !== previousSealHash) {
          errors.push(
            `${experiment.name} previous seal hash does not match the sealed lineage head`,
          );
        }
        const report = await this.verifyExperiment(experiment.name, { requireSeal: true });
        if (!report.valid) {
          errors.push(...report.errors.map((error) => `${experiment.name}: ${error}`));
        }
        if (report.artifactHashes["evaluation-plan.json"] !== undefined) {
          const evaluationPlan = await this.readArtifact(experiment.name, "evaluation-plan.json");
          for (const panelAttestation of evaluationPlan.panelAttestations) {
            if (seenOneUseAttestations.has(panelAttestation.oneUseAttestationHash)) {
              errors.push(
                `${experiment.name} reuses a one-use broker attestation from an earlier experiment`,
              );
            }
            seenOneUseAttestations.add(panelAttestation.oneUseAttestationHash);
          }
        }
        if (report.artifactHashes["decision.json"] !== undefined) {
          const decision = await this.readArtifact(experiment.name, "decision.json");
          if (seenConsumptionAttestations.has(decision.oneUseConsumptionAttestationHash)) {
            errors.push(
              `${experiment.name} reuses a one-use consumption attestation from an earlier experiment`,
            );
          }
          seenConsumptionAttestations.add(decision.oneUseConsumptionAttestationHash);
        }
        previousSealHash = attestation.sealChainEntryHash;
        sealedExperimentCount += 1;
      } catch (error) {
        if (isMissingFile(error)) {
          continue;
        }
        errors.push(
          `${experiment.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      sealedExperimentCount,
      head: previousSealHash,
    };
  }

  async #assertCompleteAndValidPreseal(experimentName: string, path: string): Promise<void> {
    const missing: string[] = [];
    for (const fileName of REQUIRED_PRESEAL_ARTIFACT_FILES) {
      try {
        const info = await lstat(join(path, fileName));
        if (!info.isFile() || info.isSymbolicLink()) {
          missing.push(`${fileName} (not a regular file)`);
        }
      } catch (error) {
        if (isMissingFile(error)) {
          missing.push(fileName);
        } else {
          throw error;
        }
      }
    }
    if (missing.length > 0) {
      throw new EvidenceIntegrityError("Cannot seal an incomplete experiment", missing);
    }

    const preseal = await this.verifyExperiment(experimentName);
    if (!preseal.valid) {
      throw new EvidenceIntegrityError("Cannot seal an invalid experiment", preseal.errors);
    }
  }

  async #captureLeakScanSubjectUnlocked(
    experimentName: string,
    path: string,
  ): Promise<LeakScanSubject> {
    const eventChain = await readAndVerifyEventChain(join(path, "events.jsonl"));
    if (eventChain.head === null || eventChain.records.length === 0) {
      throw new EvidenceIntegrityError("Cannot leak-scan an experiment with an empty event chain", [
        "events.jsonl must contain at least one validated event",
      ]);
    }

    const manifest: LeakScanArtifactManifestEntry[] = [];
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "events.jsonl") {
        continue;
      }
      if (entry.name === "attestation.json" || !isArtifactFileName(entry.name)) {
        throw new EvidenceIntegrityError("Leak-scan snapshot contains an unexpected entry", [
          entry.name,
        ]);
      }
      if (!entry.isFile()) {
        throw new EvidenceIntegrityError("Cannot leak-scan a non-regular artifact", [entry.name]);
      }
      const { bytes, value } = await readJsonFile(join(path, entry.name));
      const schemaKind = artifactFileSchemas[entry.name];
      assertValidDocument(schemaKind, value);
      this.#assertMatchingExperimentNumber(experimentName, value);
      manifest.push({
        path: entry.name,
        schemaKind,
        contentHash: value.contentHash,
        byteHash: sha256(bytes),
        bytes: bytes.byteLength,
      });
    }
    manifest.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

    const experiment = await this.readArtifact(experimentName, "experiment.json");
    return {
      schemaVersion: "1.0.0",
      experimentId: experimentName,
      experimentNumber: parseExperimentNumber(experimentName),
      artifactManifest: manifest,
      artifactManifestHash: canonicalHash(manifest),
      eventRecordCount: eventChain.records.length,
      eventChainHead: eventChain.head,
      protocolHash: experiment.protocolHash,
    };
  }

  #assertLeakScanReceipt(
    receipt: LeakScanReceipt,
    subject: LeakScanSubject,
    validationTimeMs: number,
    enforceFreshness: boolean,
  ): void {
    try {
      assertValidDocument("leakScanReceipt", receipt);
    } catch (error) {
      throw new EvidenceIntegrityError("Leak-scan receipt schema is invalid", [
        error instanceof Error ? error.message : String(error),
      ]);
    }

    const receiptSubject: LeakScanSubject = {
      schemaVersion: receipt.schemaVersion,
      experimentId: receipt.experimentId,
      experimentNumber: receipt.experimentNumber,
      artifactManifest: receipt.artifactManifest,
      artifactManifestHash: receipt.artifactManifestHash,
      eventRecordCount: receipt.eventRecordCount,
      eventChainHead: receipt.eventChainHead,
      protocolHash: receipt.protocolHash,
    };
    if (canonicalJson(receiptSubject) !== canonicalJson(subject)) {
      throw new EvidenceIntegrityError(
        "Leak-scan receipt does not bind the current experiment snapshot",
        [
          `expected subject ${canonicalHash(subject)}`,
          `received subject ${canonicalHash(receiptSubject)}`,
        ],
      );
    }

    const trustedScanner = this.#trustedLeakScanner;
    if (trustedScanner === undefined) {
      throw new EvidenceIntegrityError(
        "No trusted leak-scanner verification key is configured",
        [],
      );
    }
    if (receipt.signature.keyId !== trustedScanner.keyId) {
      throw new EvidenceIntegrityError("Leak-scan receipt uses an untrusted key id", [
        receipt.signature.keyId,
      ]);
    }
    if (receipt.signature.signedAt !== receipt.checkedAt) {
      throw new EvidenceIntegrityError(
        "Leak-scan signature time must equal the scan completion time",
        [],
      );
    }
    if (!verifyEd25519Signature(receipt, trustedScanner.publicKey)) {
      throw new EvidenceIntegrityError("Leak-scan receipt signature is invalid", []);
    }

    const checkedAtMs = Date.parse(receipt.checkedAt);
    if (!Number.isFinite(checkedAtMs)) {
      throw new EvidenceIntegrityError("Leak-scan completion time is invalid", []);
    }
    if (checkedAtMs - validationTimeMs > this.#maximumLeakScanClockSkewMs) {
      throw new EvidenceIntegrityError("Leak-scan receipt is dated too far in the future", []);
    }
    if (enforceFreshness && validationTimeMs - checkedAtMs > this.#maximumLeakScanReceiptAgeMs) {
      throw new EvidenceIntegrityError("Leak-scan receipt is stale", []);
    }
  }

  async #assertExperimentDirectory(experimentName: string): Promise<string> {
    parseExperimentNumber(experimentName);
    const path = this.#experimentPath(experimentName);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      throw new EvidenceStoreError(`Experiment "${experimentName}" does not exist`, {
        cause: error,
      });
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new EvidenceStoreError(`Experiment "${experimentName}" is not a regular directory`);
    }
    return path;
  }

  async #assertUnsealed(experimentName: string, path: string): Promise<void> {
    try {
      await lstat(join(path, "attestation.json"));
      throw new SealedExperimentError(experimentName);
    } catch (error) {
      if (isMissingFile(error)) {
        return;
      }
      throw error;
    }
  }

  #assertMatchingExperimentNumber(experimentName: string, value: unknown): void {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("experimentNumber" in value) ||
      typeof value.experimentNumber !== "number"
    ) {
      throw new EvidenceStoreError("Artifact does not contain a numeric experiment number");
    }
    const expected = parseExperimentNumber(experimentName);
    if (value.experimentNumber !== expected) {
      throw new EvidenceStoreError(
        `Artifact experiment number ${value.experimentNumber} does not match directory ${expected}`,
      );
    }
  }

  #experimentPath(experimentName: string): string {
    const path = resolve(this.#root, experimentName);
    if (resolve(path, "..") !== this.#root) {
      throw new EvidenceStoreError(`Experiment path escapes evidence root: "${experimentName}"`);
    }
    return path;
  }

  #mutationLockPath(experimentName: string): string {
    return join(this.#root, `.${experimentName}.mutation.lock`);
  }

  async #appendEventUnlocked(
    experimentName: string,
    path: string,
    input: AppendEventInput,
  ): Promise<EventRecord> {
    const eventsPath = join(path, "events.jsonl");
    const chain = await readAndVerifyEventChain(eventsPath);
    const withoutHash: Omit<EventRecord, "contentHash"> = {
      schemaVersion: "1.0.0",
      createdAt: input.createdAt ?? this.#now().toISOString(),
      provenanceRefs: input.provenanceRefs ?? [],
      experimentNumber: parseExperimentNumber(experimentName),
      sequence: chain.records.length,
      previousEventHash: chain.head,
      eventType: input.eventType,
      actor: input.actor,
      payload: input.payload,
    };
    const record = withContentHash(withoutHash);
    assertValidDocument("eventRecord", record);
    await durableAppendFile(eventsPath, `${canonicalJson(record)}\n`);
    return record;
  }

  async #readAmendments(amendmentsPath: string): Promise<Amendment[]> {
    const entries = await readdir(amendmentsPath, { withFileTypes: true });
    const filenames = entries.map((entry) => entry.name).sort();
    const amendments: Amendment[] = [];
    for (const [index, filename] of filenames.entries()) {
      const match = AMENDMENT_FILE_PATTERN.exec(filename);
      if (
        match === null ||
        match[1] === undefined ||
        !entries.find((entry) => entry.name === filename)?.isFile()
      ) {
        throw new Error(`Unexpected amendment entry "${filename}"`);
      }
      const expected = (index + 1).toString().padStart(4, "0");
      if (match[1] !== expected) {
        throw new Error(`Amendment filename sequence expected ${expected}.json, got ${filename}`);
      }
      const { value } = await readJsonFile(join(amendmentsPath, filename));
      assertValidDocument("amendment", value);
      amendments.push(value);
    }
    return amendments;
  }

  async #latestPriorSealHash(experimentNumber: number): Promise<string | null> {
    const entries = await readdir(this.#root, { withFileTypes: true });
    const priorExperiments = entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          EXPERIMENT_DIRECTORY_PATTERN.test(entry.name) &&
          parseExperimentNumber(entry.name) < experimentNumber,
      )
      .map((entry) => ({
        name: entry.name,
        number: parseExperimentNumber(entry.name),
      }))
      .sort((left, right) => right.number - left.number || right.name.localeCompare(left.name));

    for (const experiment of priorExperiments) {
      try {
        const attestation = await this.readArtifact(experiment.name, "attestation.json");
        return attestation.sealChainEntryHash;
      } catch (error) {
        if (isMissingFile(error)) {
          continue;
        }
        throw error;
      }
    }
    return null;
  }

  async #verifyAttestation(
    experimentName: string,
    attestation: Attestation,
    artifactHashes: Readonly<Record<string, string>>,
    eventRecords: readonly EventRecord[],
    experimentPath: string,
  ): Promise<void> {
    const eventRecordCount = eventRecords.length;
    const eventChainHead = eventRecords.at(-1)?.contentHash ?? null;
    if (eventChainHead === null) {
      throw new Error("Sealed event chain is empty");
    }
    if (attestation.eventRecordCount !== eventRecordCount) {
      throw new Error(
        `Event-chain truncation or extension detected: sealed ${attestation.eventRecordCount}, found ${eventRecordCount}`,
      );
    }
    if (attestation.eventChainHead !== eventChainHead) {
      throw new Error("Sealed event-chain head does not match events.jsonl");
    }

    const attestedNames = new Set(attestation.artifactChecksums.map((item) => item.artifactName));
    const currentNames = Object.keys(artifactHashes).filter((name) => name !== "attestation.json");
    for (const name of currentNames) {
      if (!attestedNames.has(name)) {
        throw new Error(`Post-seal artifact addition detected: "${name}"`);
      }
    }

    const currentManifest: LeakScanArtifactManifestEntry[] = [];
    for (const checksum of attestation.artifactChecksums) {
      if (!isArtifactFileName(checksum.artifactName)) {
        throw new Error(`Sealed artifact "${checksum.artifactName}" has no registered schema`);
      }
      const currentContentHash = artifactHashes[checksum.artifactName];
      if (currentContentHash === undefined) {
        throw new Error(`Sealed artifact "${checksum.artifactName}" is missing`);
      }
      if (currentContentHash !== checksum.contentHash) {
        throw new Error(`Content hash mismatch for sealed artifact "${checksum.artifactName}"`);
      }
      const bytes = await readFile(join(experimentPath, checksum.artifactName));
      if (sha256(bytes) !== checksum.byteHash) {
        throw new Error(`Byte hash mismatch for sealed artifact "${checksum.artifactName}"`);
      }
      currentManifest.push({
        path: checksum.artifactName,
        schemaKind: artifactFileSchemas[checksum.artifactName],
        contentHash: checksum.contentHash,
        byteHash: checksum.byteHash,
        bytes: bytes.byteLength,
      });
    }
    currentManifest.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );

    const experiment = await this.readArtifact(experimentName, "experiment.json");
    const receiptSubject: LeakScanSubject = {
      schemaVersion: attestation.graderLeakScan.schemaVersion,
      experimentId: experimentName,
      experimentNumber: parseExperimentNumber(experimentName),
      artifactManifest: currentManifest,
      artifactManifestHash: canonicalHash(currentManifest),
      eventRecordCount: attestation.graderLeakScan.eventRecordCount,
      eventChainHead: attestation.graderLeakScan.eventChainHead,
      protocolHash: experiment.protocolHash,
    };
    this.#assertLeakScanReceipt(
      attestation.graderLeakScan,
      receiptSubject,
      Date.parse(attestation.sealedAt),
      true,
    );

    const scanEventCount = attestation.graderLeakScan.eventRecordCount;
    const scanEventHead = attestation.graderLeakScan.eventChainHead;
    const finalEvent = eventRecords.at(-1);
    if (
      eventRecordCount !== scanEventCount + 1 ||
      finalEvent === undefined ||
      finalEvent.eventType !== "experiment-sealed" ||
      finalEvent.actor !== "controller" ||
      finalEvent.previousEventHash !== scanEventHead ||
      canonicalJson(finalEvent.payload) !==
        canonicalJson(experimentSealedEventPayload(attestation.graderLeakScan.contentHash)) ||
      canonicalJson(finalEvent.provenanceRefs) !==
        canonicalJson(leakScanReceiptProvenance(attestation.graderLeakScan.contentHash))
    ) {
      throw new Error(
        "Final event chain is not the single receipt-bound seal transition after the leak scan",
      );
    }

    const expectedSealHash = canonicalHash(attestationSealPayload(attestation));
    if (attestation.sealChainEntryHash !== expectedSealHash) {
      throw new Error("Seal-chain entry hash is invalid");
    }
  }
}
