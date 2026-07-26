import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  atomicWriteFile,
  withExclusiveFileLock,
} from "../evidence/atomic.js";
import { assertValidDocument } from "../schemas/registry.js";
import {
  assertTaskAgnosticSubmission,
  boundedJson,
  isWithin,
  opaqueDigest,
} from "./security.js";

export interface McpSessionState {
  readonly schemaVersion: "1.0.0";
  readonly campaignId: string;
  readonly projectDigest: string;
  readonly queryCount: number;
  readonly briefReleased: boolean;
  readonly briefHash: string | null;
  readonly currentResultReleased: boolean;
  readonly currentResultHash: string | null;
  readonly hypothesisSubmitted: boolean;
  readonly hypothesisReceiptId: string | null;
  readonly candidateStaged: boolean;
  readonly candidateReceiptId: string | null;
  readonly analysisSubmitted: boolean;
  readonly analysisReceiptId: string | null;
  readonly contaminationReported: boolean;
  readonly updatedAt: string;
}

export interface ExperimentSummary {
  readonly experimentNumber: number;
  readonly slug: string;
  readonly lifecycleState: string;
  readonly disposition: string | null;
  readonly mutationCategory: string | null;
  readonly changedComponents: readonly string[];
  readonly activeChampionChanged: boolean;
  readonly certifiedChampionChanged: boolean;
  readonly integrityStatus: string;
  readonly aggregateCostBand: string;
  readonly protocolHash: string;
}

export interface SubmissionReceipt {
  readonly receiptId: string;
  readonly kind:
    | "hypothesis"
    | "candidate"
    | "analysis"
    | "contamination";
  readonly campaignId: string;
  readonly payloadHash: string;
  readonly createdAt: string;
}

interface ReleasedCampaignContext {
  readonly schemaVersion: string;
  readonly campaignId: string;
  readonly mode: string;
  readonly protocolHash: string;
  readonly lineageId: string;
  readonly activeExperiment: number;
  readonly activeCommit: string;
  readonly certifiedExperiment: number | null;
  readonly certifiedCommit: string | null;
  readonly nextExperiment: number;
  readonly allowedNextActions: readonly string[];
  readonly budgetBands: Readonly<Record<string, string>>;
  readonly freshValidationPanelsRemaining: number;
  readonly shadowSlicesRemaining: number;
}

const SAFE_IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const ALLOWED_ACTIONS = new Set([
  "get-diagnostic-brief",
  "submit-hypothesis",
  "stage-candidate",
  "get-current-result",
  "submit-analysis",
  "request-next-stage",
  "record-decision",
  "report-contamination",
]);
const ALLOWED_COMPONENTS = new Set([
  "system-prompt",
  "tool-policy",
  "tool-recovery",
  "agent-session",
  "compaction",
  "agent-loop",
  "provider-transport",
  "runtime-extension",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return (
    keys.length === allowed.length &&
    keys.every((key, index) => key === allowed[index])
  );
}

const SESSION_STATE_KEYS = [
  "schemaVersion",
  "campaignId",
  "projectDigest",
  "queryCount",
  "briefReleased",
  "briefHash",
  "currentResultReleased",
  "currentResultHash",
  "hypothesisSubmitted",
  "hypothesisReceiptId",
  "candidateStaged",
  "candidateReceiptId",
  "analysisSubmitted",
  "analysisReceiptId",
  "contaminationReported",
  "updatedAt",
] as const;

function assertSessionState(
  value: unknown,
  campaignId: string,
  projectDigest: string,
): asserts value is McpSessionState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, SESSION_STATE_KEYS) ||
    value.schemaVersion !== "1.0.0" ||
    value.campaignId !== campaignId ||
    value.projectDigest !== projectDigest ||
    !Number.isSafeInteger(value.queryCount) ||
    (value.queryCount as number) < 0 ||
    !Number.isFinite(Date.parse(String(value.updatedAt)))
  ) {
    throw new Error("Optimizer session state is invalid or belongs to another campaign");
  }
  for (const field of [
    "briefReleased",
    "currentResultReleased",
    "hypothesisSubmitted",
    "candidateStaged",
    "analysisSubmitted",
    "contaminationReported",
  ] as const) {
    if (typeof value[field] !== "boolean") {
      throw new Error("Optimizer session state contains an invalid phase flag");
    }
  }
  for (const field of [
    "briefHash",
    "currentResultHash",
  ] as const) {
    const item = value[field];
    if (item !== null && (typeof item !== "string" || !/^[a-f0-9]{64}$/u.test(item))) {
      throw new Error("Optimizer session state contains an invalid evidence hash");
    }
  }
  for (const field of [
    "hypothesisReceiptId",
    "candidateReceiptId",
    "analysisReceiptId",
  ] as const) {
    const item = value[field];
    if (
      item !== null &&
      (typeof item !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(item))
    ) {
      throw new Error("Optimizer session state contains an invalid receipt");
    }
  }
  if (
    value.briefReleased !== (value.briefHash !== null) ||
    value.currentResultReleased !== (value.currentResultHash !== null) ||
    value.hypothesisSubmitted !== (value.hypothesisReceiptId !== null) ||
    value.candidateStaged !== (value.candidateReceiptId !== null) ||
    value.analysisSubmitted !== (value.analysisReceiptId !== null) ||
    (value.candidateStaged && !value.hypothesisSubmitted) ||
    (value.analysisSubmitted &&
      (!value.candidateStaged || !value.currentResultReleased))
  ) {
    throw new Error("Optimizer session phase and receipt lineage is inconsistent");
  }
}

function assertStateTransition(
  previous: McpSessionState,
  next: McpSessionState,
): void {
  assertSessionState(next, previous.campaignId, previous.projectDigest);
  if (
    next.queryCount < previous.queryCount ||
    next.queryCount > previous.queryCount + 1 ||
    Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)
  ) {
    throw new Error("Optimizer session counters or time cannot regress");
  }
  for (const field of [
    "briefReleased",
    "currentResultReleased",
    "hypothesisSubmitted",
    "candidateStaged",
    "analysisSubmitted",
    "contaminationReported",
  ] as const) {
    if (previous[field] && !next[field]) {
      throw new Error("Optimizer session phase flags are monotonic");
    }
  }
  for (const field of [
    "briefHash",
    "currentResultHash",
    "hypothesisReceiptId",
    "candidateReceiptId",
    "analysisReceiptId",
  ] as const) {
    if (previous[field] !== null && previous[field] !== next[field]) {
      throw new Error("Optimizer evidence and receipt bindings are immutable");
    }
  }
}

function stringField(value: Readonly<Record<string, unknown>>, name: string): string | null {
  const field = value[name];
  return typeof field === "string" ? field : null;
}

function numberField(value: Readonly<Record<string, unknown>>, name: string): number | null {
  const field = value[name];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function booleanField(
  value: Readonly<Record<string, unknown>>,
  name: string,
): boolean | null {
  const field = value[name];
  return typeof field === "boolean" ? field : null;
}

function parseCampaignContext(
  value: unknown,
  campaignId: string,
): ReleasedCampaignContext {
  const keys = [
    "schemaVersion",
    "campaignId",
    "mode",
    "protocolHash",
    "lineageId",
    "activeExperiment",
    "activeCommit",
    "certifiedExperiment",
    "certifiedCommit",
    "nextExperiment",
    "allowedNextActions",
    "budgetBands",
    "freshValidationPanelsRemaining",
    "shadowSlicesRemaining",
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    value.schemaVersion !== "1.0.0" ||
    value.campaignId !== campaignId ||
    value.mode !== "research" ||
    typeof value.protocolHash !== "string" ||
    !SHA256.test(value.protocolHash) ||
    typeof value.lineageId !== "string" ||
    !SAFE_IDENTIFIER.test(value.lineageId) ||
    typeof value.activeCommit !== "string" ||
    !GIT_OBJECT.test(value.activeCommit) ||
    !Number.isSafeInteger(value.activeExperiment) ||
    (value.activeExperiment as number) < 0 ||
    !Number.isSafeInteger(value.nextExperiment) ||
    (value.nextExperiment as number) < 1 ||
    !Number.isSafeInteger(value.freshValidationPanelsRemaining) ||
    (value.freshValidationPanelsRemaining as number) < 0 ||
    !Number.isSafeInteger(value.shadowSlicesRemaining) ||
    (value.shadowSlicesRemaining as number) < 0 ||
    !Array.isArray(value.allowedNextActions) ||
    value.allowedNextActions.some(
      (action) => typeof action !== "string" || !ALLOWED_ACTIONS.has(action),
    ) ||
    new Set(value.allowedNextActions).size !== value.allowedNextActions.length ||
    !isRecord(value.budgetBands)
  ) {
    throw new Error("Campaign context is malformed or contains an unapproved field");
  }
  const certifiedPairValid =
    (value.certifiedExperiment === null && value.certifiedCommit === null) ||
    (Number.isSafeInteger(value.certifiedExperiment) &&
      (value.certifiedExperiment as number) >= 0 &&
      typeof value.certifiedCommit === "string" &&
      GIT_OBJECT.test(value.certifiedCommit));
  const budgetBands = Object.entries(value.budgetBands);
  if (
    !certifiedPairValid ||
    budgetBands.length > 16 ||
    budgetBands.some(
      ([key, band]) =>
        !SAFE_IDENTIFIER.test(key) ||
        typeof band !== "string" ||
        !/^(?:none|low|medium|high|critical|exhausted|unknown)$/u.test(band),
    )
  ) {
    throw new Error("Campaign context contains invalid certification or budget bands");
  }
  return value as unknown as ReleasedCampaignContext;
}

function parseExperimentSummary(value: unknown): ExperimentSummary {
  const keys = [
    "experimentNumber",
    "slug",
    "lifecycleState",
    "disposition",
    "mutationCategory",
    "changedComponents",
    "activeChampionChanged",
    "certifiedChampionChanged",
    "integrityStatus",
    "aggregateCostBand",
    "protocolHash",
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    !Number.isSafeInteger(value.experimentNumber) ||
    (value.experimentNumber as number) < 0 ||
    typeof value.slug !== "string" ||
    !SAFE_IDENTIFIER.test(value.slug) ||
    typeof value.lifecycleState !== "string" ||
    !SAFE_IDENTIFIER.test(value.lifecycleState) ||
    (value.disposition !== null &&
      !new Set(["promoted", "rejected", "inconclusive"]).has(
        String(value.disposition),
      )) ||
    (value.mutationCategory !== null &&
      (typeof value.mutationCategory !== "string" ||
        !SAFE_IDENTIFIER.test(value.mutationCategory))) ||
    !Array.isArray(value.changedComponents) ||
    value.changedComponents.some(
      (component) =>
        typeof component !== "string" || !ALLOWED_COMPONENTS.has(component),
    ) ||
    new Set(value.changedComponents).size !== value.changedComponents.length ||
    typeof value.activeChampionChanged !== "boolean" ||
    typeof value.certifiedChampionChanged !== "boolean" ||
    !new Set(["passed", "failed", "not-run"]).has(String(value.integrityStatus)) ||
    typeof value.aggregateCostBand !== "string" ||
    !/^(?:0|[0-9]+-[0-9]+|[0-9]+\+|unknown)$/u.test(value.aggregateCostBand) ||
    typeof value.protocolHash !== "string" ||
    !SHA256.test(value.protocolHash)
  ) {
    throw new Error("Released experiment summary is malformed");
  }
  return value as unknown as ExperimentSummary;
}

async function readJson(path: string): Promise<unknown> {
  const content = await readFile(path, "utf8");
  return JSON.parse(content) as unknown;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    overwrite: true,
  });
}

function initialState(campaignId: string, projectDigest: string, now: string): McpSessionState {
  return {
    schemaVersion: "1.0.0",
    campaignId,
    projectDigest,
    queryCount: 0,
    briefReleased: false,
    briefHash: null,
    currentResultReleased: false,
    currentResultHash: null,
    hypothesisSubmitted: false,
    hypothesisReceiptId: null,
    candidateStaged: false,
    candidateReceiptId: null,
    analysisSubmitted: false,
    analysisReceiptId: null,
    contaminationReported: false,
    updatedAt: now,
  };
}

export class ReleasedEvidenceRepository {
  readonly #releasedEvidenceRoot: string;
  readonly #submissionRoot: string;
  readonly #auditRoot: string;
  readonly #campaignId: string;
  readonly #projectRoot: string;
  readonly #pluginData: string;
  readonly #maximumQueries: number;
  readonly #now: () => Date;

  public constructor(options: {
    releasedEvidenceRoot: string;
    submissionRoot: string;
    auditRoot: string;
    campaignId: string;
    projectRoot: string;
    pluginData: string;
    maximumQueries?: number;
    now?: () => Date;
  }) {
    this.#releasedEvidenceRoot = options.releasedEvidenceRoot;
    this.#submissionRoot = options.submissionRoot;
    this.#auditRoot = options.auditRoot;
    this.#campaignId = options.campaignId;
    this.#projectRoot = options.projectRoot;
    this.#pluginData = options.pluginData;
    this.#maximumQueries = options.maximumQueries ?? 10;
    this.#now = options.now ?? (() => new Date());
  }

  public get sessionStatePath(): string {
    return join(
      this.#pluginData,
      "sessions",
      `${opaqueDigest(this.#projectRoot)}.json`,
    );
  }

  public async initialize(): Promise<void> {
    await mkdir(join(this.#pluginData, "sessions"), { recursive: true, mode: 0o700 });
    await Promise.all([
      mkdir(this.#submissionRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.#auditRoot, { recursive: true, mode: 0o700 }),
    ]);
    await withExclusiveFileLock(this.#stateLockPath(), async () => {
      try {
        await readFile(this.sessionStatePath, "utf8");
        await this.#readStateUnlocked();
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          throw error;
        }
        await writeJsonAtomic(
          this.sessionStatePath,
          initialState(
            this.#campaignId,
            opaqueDigest(this.#projectRoot),
            this.#now().toISOString(),
          ),
        );
      }
    });
  }

  public async readState(): Promise<McpSessionState> {
    return this.#readStateUnlocked();
  }

  public async updateState(
    update: (state: McpSessionState) => McpSessionState,
  ): Promise<McpSessionState> {
    return withExclusiveFileLock(this.#stateLockPath(), async () => {
      const previous = await this.#readStateUnlocked();
      const next = {
        ...update(previous),
        updatedAt: this.#now().toISOString(),
      };
      assertStateTransition(previous, next);
      await writeJsonAtomic(this.sessionStatePath, next);
      return next;
    });
  }

  async #chargeQuery(): Promise<void> {
    await this.updateState((state) => {
      if (state.queryCount >= this.#maximumQueries) {
        throw new Error("The session evidence-query budget is exhausted");
      }
      return { ...state, queryCount: state.queryCount + 1 };
    });
  }

  async #audit(
    action: string,
    outcome: "allowed" | "denied",
    payloadHash: string | null,
  ): Promise<void> {
    const directory = this.#auditPath(this.#campaignId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const createdAt = this.#now().toISOString();
    const receiptId = randomBytes(18).toString("base64url");
    await writeFile(
      join(directory, `${createdAt.replaceAll(":", "-")}-${receiptId}.json`),
      `${JSON.stringify({
        schemaVersion: "1.0.0",
        campaignId: this.#campaignId,
        action,
        outcome,
        payloadHash,
        projectDigest: opaqueDigest(this.#projectRoot),
        createdAt,
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  }

  #releasedPath(...segments: readonly string[]): string {
    const path = join(this.#releasedEvidenceRoot, ...segments);
    if (!isWithin(this.#releasedEvidenceRoot, path)) {
      throw new Error("Evidence path escaped the released evidence root");
    }
    return path;
  }

  #submissionPath(...segments: readonly string[]): string {
    const path = join(this.#submissionRoot, ...segments);
    if (!isWithin(this.#submissionRoot, path)) {
      throw new Error("Submission path escaped the optimizer inbox root");
    }
    return path;
  }

  #auditPath(...segments: readonly string[]): string {
    const path = join(this.#auditRoot, ...segments);
    if (!isWithin(this.#auditRoot, path)) {
      throw new Error("Audit path escaped the optimizer audit root");
    }
    return path;
  }

  #stateLockPath(): string {
    return `${this.sessionStatePath}.lock`;
  }

  async #readStateUnlocked(): Promise<McpSessionState> {
    const value = await readJson(this.sessionStatePath);
    assertSessionState(
      value,
      this.#campaignId,
      opaqueDigest(this.#projectRoot),
    );
    return value;
  }

  public async campaignContext(): Promise<ReleasedCampaignContext> {
    await this.#chargeQuery();
    const value = await readJson(this.#releasedPath("campaign-context.json"));
    const context = parseCampaignContext(value, this.#campaignId);
    boundedJson(context);
    await this.#audit("campaign-context", "allowed", opaqueDigest(JSON.stringify(context)));
    return context;
  }

  public async latestDiagnosticBrief(): Promise<unknown> {
    return withExclusiveFileLock(`${this.sessionStatePath}.brief.lock`, async () => {
      const state = await this.readState();
      if (state.briefReleased) {
        throw new Error("The diagnostic brief is one-use and was already released");
      }
      await this.#chargeQuery();
      const pointer = await readJson(this.#releasedPath("latest-brief.json"));
      if (
        !isRecord(pointer) ||
        !hasExactKeys(pointer, ["file", "contentHash"]) ||
        typeof pointer.file !== "string" ||
        typeof pointer.contentHash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(pointer.contentHash)
      ) {
        throw new Error("No eligible diagnostic brief is available");
      }
      const file = basename(pointer.file);
      if (!/^\d{3,}-[a-z0-9-]+\.json$/u.test(file)) {
        throw new Error("Diagnostic brief pointer is invalid");
      }
      const brief = await readJson(this.#releasedPath("briefs", file));
      boundedJson(brief);
      assertValidDocument("diagnosticBrief", brief);
      const hash = stringField(brief, "contentHash");
      if (
        hash === null ||
        hash !== pointer.contentHash ||
        Date.parse(brief.expiresAt) <= this.#now().getTime()
      ) {
        throw new Error("Diagnostic brief is mismatched or expired");
      }
      await this.updateState((current) => ({
        ...current,
        briefReleased: true,
        briefHash: hash,
      }));
      await this.#audit("latest-diagnostic-brief", "allowed", hash);
      return brief;
    });
  }

  public async currentResult(): Promise<unknown> {
    return withExclusiveFileLock(`${this.sessionStatePath}.result.lock`, async () => {
      const state = await this.readState();
      if (state.currentResultReleased) {
        throw new Error("The current aggregate result is one-use and was already released");
      }
      await this.#chargeQuery();
      const result = await readJson(this.#releasedPath("current-result.json"));
      boundedJson(result);
      assertValidDocument("results", result);
      const hash = result.contentHash;
      await this.updateState((current) => ({
        ...current,
        currentResultReleased: true,
        currentResultHash: hash,
      }));
      await this.#audit("current-result", "allowed", hash);
      return result;
    });
  }

  async #experimentSummaries(): Promise<readonly ExperimentSummary[]> {
    const directory = this.#releasedPath("experiments");
    let files: readonly string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
    const summaries: ExperimentSummary[] = [];
    for (const file of files.filter((item) => /^\d{3,}-[a-z0-9-]+\.json$/u.test(item)).sort()) {
      const value = await readJson(this.#releasedPath("experiments", file));
      const summary = parseExperimentSummary(value);
      const fileNumber = Number.parseInt(file.split("-", 1)[0] ?? "", 10);
      if (fileNumber !== summary.experimentNumber) {
        throw new Error("Released experiment filename and number do not match");
      }
      summaries.push(summary);
    }
    return summaries;
  }

  public async queryExperiments(numbers: readonly number[]): Promise<readonly ExperimentSummary[]> {
    await this.#chargeQuery();
    if (numbers.length < 1 || numbers.length > 5 || new Set(numbers).size !== numbers.length) {
      throw new Error("Request between one and five unique experiment numbers");
    }
    const requested = new Set(numbers);
    const results = (await this.#experimentSummaries()).filter((entry) =>
      requested.has(entry.experimentNumber),
    );
    boundedJson(results);
    await this.#audit("query-experiments", "allowed", opaqueDigest(JSON.stringify(results)));
    return results;
  }

  public async componentHistory(component: string): Promise<readonly ExperimentSummary[]> {
    await this.#chargeQuery();
    const results = (await this.#experimentSummaries())
      .filter((entry) => entry.changedComponents.includes(component))
      .slice(-5);
    boundedJson(results);
    await this.#audit("component-history", "allowed", opaqueDigest(JSON.stringify(results)));
    return results;
  }

  public async regressions(category: string | null): Promise<readonly ExperimentSummary[]> {
    await this.#chargeQuery();
    const results = (await this.#experimentSummaries())
      .filter(
        (entry) =>
          entry.integrityStatus !== "passed" ||
          entry.disposition === "rejected" ||
          entry.disposition === "inconclusive",
      )
      .filter((entry) => category === null || entry.mutationCategory === category)
      .slice(-5);
    boundedJson(results);
    await this.#audit("regressions", "allowed", opaqueDigest(JSON.stringify(results)));
    return results;
  }

  public async submit(
    kind: SubmissionReceipt["kind"],
    payload: unknown,
  ): Promise<SubmissionReceipt> {
    return withExclusiveFileLock(`${this.sessionStatePath}.submit.lock`, async () => {
      assertTaskAgnosticSubmission(payload);
      const state = await this.readState();
    const record = isRecord(payload) ? payload : {};
    if (kind === "hypothesis") {
      if (state.hypothesisSubmitted) {
        throw new Error("A hypothesis is already frozen for this optimizer session");
      }
      const suppliedBriefHash = stringField(record, "sourceBriefHash");
      if (
        (state.briefReleased && suppliedBriefHash !== state.briefHash) ||
        (!state.briefReleased && record.sourceBriefHash !== null)
      ) {
        throw new Error("Hypothesis does not bind the one released diagnostic brief");
      }
    }
    if (kind === "candidate" && (!state.hypothesisSubmitted || state.candidateStaged)) {
      throw new Error("Candidate handoff requires exactly one previously frozen hypothesis");
    }
    if (
      kind === "candidate" &&
      stringField(record, "hypothesisReceiptId") !== state.hypothesisReceiptId
    ) {
      throw new Error("Candidate handoff does not bind the frozen hypothesis receipt");
    }
    if (kind === "analysis") {
      if (
        !state.candidateStaged ||
        !state.currentResultReleased ||
        state.analysisSubmitted
      ) {
        throw new Error(
          "Analysis requires a staged candidate and one released aggregate result",
        );
      }
      if (
        stringField(record, "hypothesisReceiptId") !==
          state.hypothesisReceiptId ||
        stringField(record, "candidateReceiptId") !== state.candidateReceiptId ||
        stringField(record, "resultHash") !== state.currentResultHash
      ) {
        throw new Error(
          "Analysis does not bind the hypothesis, candidate, and released result receipts",
        );
      }
    }
    if (kind === "contamination" && state.contaminationReported) {
      throw new Error("Contamination has already been reported for this session");
    }
    const serialized = JSON.stringify(payload);
    const payloadHash = opaqueDigest(serialized);
    const receipt: SubmissionReceipt = {
      receiptId: randomBytes(18).toString("base64url"),
      kind,
      campaignId: this.#campaignId,
      payloadHash,
      createdAt: this.#now().toISOString(),
    };
    const inbox = this.#submissionPath(this.#campaignId, kind);
    const envelope = {
      schemaVersion: "1.0.0",
      receipt,
      payload,
      projectDigest: opaqueDigest(this.#projectRoot),
    };
    await mkdir(inbox, { recursive: true, mode: 0o700 });
    const file = join(inbox, `${receipt.createdAt.replaceAll(":", "-")}-${receipt.receiptId}.json`);
    await writeFile(file, `${JSON.stringify(envelope, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    if (kind === "hypothesis") {
      await this.updateState((state) => ({
        ...state,
        hypothesisSubmitted: true,
        hypothesisReceiptId: receipt.receiptId,
      }));
    } else if (kind === "candidate") {
      await this.updateState((state) => ({
        ...state,
        candidateStaged: true,
        candidateReceiptId: receipt.receiptId,
      }));
    } else if (kind === "analysis") {
      await this.updateState((state) => ({
        ...state,
        analysisSubmitted: true,
        analysisReceiptId: receipt.receiptId,
      }));
    } else if (kind === "contamination") {
      await this.updateState((state) => ({
        ...state,
        contaminationReported: true,
      }));
    }
      await this.#audit(`submit-${kind}`, "allowed", payloadHash);
      return receipt;
    });
  }
}
