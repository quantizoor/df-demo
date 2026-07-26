import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReleasedEvidenceRepository } from "../../src/mcp/repository.js";
import { schemaFixture } from "../schemas/fixtures.js";

let root = "";
let evidence = "";
let project = "";
let pluginData = "";
let submissions = "";
let audit = "";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "df-mcp-test-"));
  evidence = join(root, "evidence");
  project = join(root, "project");
  pluginData = join(root, "plugin-data");
  submissions = join(root, "submissions");
  audit = join(root, "audit");
  await Promise.all([
    mkdir(join(evidence, "briefs"), { recursive: true }),
    mkdir(join(evidence, "experiments"), { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(pluginData, { recursive: true }),
    mkdir(submissions, { recursive: true }),
    mkdir(audit, { recursive: true }),
  ]);
  await writeJson(join(evidence, "campaign-context.json"), {
    schemaVersion: "1.0.0",
    campaignId: "campaign",
    mode: "research",
    protocolHash: "a".repeat(64),
    lineageId: "lineage",
    activeExperiment: 0,
    activeCommit: "b".repeat(40),
    certifiedExperiment: null,
    certifiedCommit: null,
    nextExperiment: 1,
    allowedNextActions: ["submit-hypothesis"],
    budgetBands: { spend: "low" },
    freshValidationPanelsRemaining: 5,
    shadowSlicesRemaining: 2,
  });
  const brief = schemaFixture("diagnosticBrief") as Readonly<
    Record<string, unknown>
  >;
  await writeJson(join(evidence, "latest-brief.json"), {
    file: "001-brief.json",
    contentHash: brief.contentHash,
  });
  await writeJson(join(evidence, "briefs", "001-brief.json"), brief);
  await writeJson(join(evidence, "experiments", "001-summary.json"), {
    experimentNumber: 1,
    slug: "generic-recovery",
    lifecycleState: "sealed",
    disposition: "rejected",
    mutationCategory: "prompt",
    changedComponents: ["system-prompt"],
    activeChampionChanged: false,
    certifiedChampionChanged: false,
    integrityStatus: "passed",
    aggregateCostBand: "10-20",
    protocolHash: "a".repeat(64),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function repository(maximumQueries = 10): ReleasedEvidenceRepository {
  return new ReleasedEvidenceRepository({
    releasedEvidenceRoot: evidence,
    submissionRoot: submissions,
    auditRoot: audit,
    campaignId: "campaign",
    projectRoot: project,
    pluginData,
    maximumQueries,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

describe("released evidence repository", () => {
  it("returns whitelisted context and bounded experiment summaries", async () => {
    const repo = repository();
    await repo.initialize();
    await expect(repo.campaignContext()).resolves.toMatchObject({
      campaignId: "campaign",
      activeExperiment: 0,
    });
    await expect(repo.queryExperiments([1])).resolves.toEqual([
      expect.objectContaining({ experimentNumber: 1, disposition: "rejected" }),
    ]);
  });

  it("releases a diagnostic brief exactly once", async () => {
    const repo = repository();
    await repo.initialize();
    await expect(repo.latestDiagnosticBrief()).resolves.toMatchObject({
      releaseId: "release-001",
    });
    await expect(repo.latestDiagnosticBrief()).rejects.toThrow(/one-use/u);
  });

  it("enforces a cumulative query budget", async () => {
    const repo = repository(1);
    await repo.initialize();
    await repo.campaignContext();
    await expect(repo.queryExperiments([1])).rejects.toThrow(/budget/u);
  });

  it("writes immutable submission envelopes and stop-hook state", async () => {
    const repo = repository();
    await repo.initialize();
    const receipt = await repo.submit("hypothesis", {
      sourceBriefHash: null,
      causalClaim: "Generic recovery policy may retry without enough inspection.",
    });
    expect(receipt.kind).toBe("hypothesis");
    expect((await repo.readState()).hypothesisSubmitted).toBe(true);

    const inbox = join(submissions, "campaign", "hypothesis");
    const files = await readdir(inbox);
    expect(files).toHaveLength(1);
    expect(await readFile(join(inbox, files[0] ?? ""), "utf8")).toContain(
      receipt.receiptId,
    );
  });

  it("binds a hypothesis to the one released brief and rejects protected prose", async () => {
    const repo = repository();
    await repo.initialize();
    const brief = await repo.latestDiagnosticBrief();
    if (
      typeof brief !== "object" ||
      brief === null ||
      !("contentHash" in brief) ||
      typeof brief.contentHash !== "string"
    ) {
      throw new Error("Test diagnostic brief is malformed");
    }
    await expect(
      repo.submit("hypothesis", {
        sourceBriefHash: brief.contentHash,
        causalClaim: "Generic recovery policy may retry without enough inspection.",
      }),
    ).resolves.toMatchObject({ kind: "hypothesis" });

    const other = new ReleasedEvidenceRepository({
      releasedEvidenceRoot: evidence,
      submissionRoot: join(root, "other-submissions"),
      auditRoot: join(root, "other-audit"),
      campaignId: "campaign",
      projectRoot: join(root, "other-project"),
      pluginData: join(root, "other-plugin-data"),
    });
    await mkdir(join(root, "other-project"), { recursive: true });
    await other.initialize();
    await expect(
      other.submit("hypothesis", {
        sourceBriefHash: null,
        causalClaim: "Read /workspace/protected/grader.txt before deciding.",
      }),
    ).rejects.toThrow(/protected literal/u);
  });
});
