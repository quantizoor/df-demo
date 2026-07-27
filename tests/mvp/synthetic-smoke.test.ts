import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runMvpNoModelSyntheticSmoke,
  runMvpNoModelSyntheticSmokePersistent,
} from "../../src/mvp/synthetic-smoke.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MVP no-model synthetic smoke", () => {
  it("returns a deterministic strict task-free receipt and removes temporary private state", async () => {
    const root = await temporaryRoot();

    const first = await runMvpNoModelSyntheticSmoke(root);
    const second = await runMvpNoModelSyntheticSmoke(root);

    expect(first).toEqual(second);
    expect(first).toEqual({
      domain: "dark-factory.mvp-synthetic-smoke-receipt.v1",
      schemaVersion: "mvp-1.0.0",
      policyVersion: "deterministic-no-model-smoke-v1",
      status: "passed",
      checks: {
        deterministicSelection: true,
        matchedTaskCount: 5,
        repetitionsPerTask: 3,
        matchedCellCount: 15,
        retainedPanel: true,
        initialCacheMisses: 15,
        retainedPanelCacheHits: 15,
        promotionRefreshes: 15,
        promotionSeededEntries: 15,
        promotionEvidenceFresh: true,
        persistedExperimentCount: 3,
        persistedCampaignRevision: 2,
        infrastructureInvalidWeightingIgnored: true,
      },
      containsTaskIdentifiers: false,
      containsTaskNames: false,
      containsTaskLiterals: false,
      containsPerTaskOutcomes: false,
      containsGraderMaterial: false,
    });
    expect(JSON.stringify(first)).not.toMatch(/[a-f0-9]{64}/u);
    expect(JSON.stringify(first)).not.toContain("synthetic/private-case");
    expect(JSON.stringify(first)).not.toContain("synthetic-private-literal");
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a relative state root before running the smoke", async () => {
    await expect(runMvpNoModelSyntheticSmoke("relative/state")).rejects.toThrow(
      /explicit absolute path/u,
    );
  });

  it("refuses normalized aliases of the filesystem root before persistent writes", async () => {
    const filesystemRootAlias = `${parse(tmpdir()).root}tmp${sep}..`;

    await expect(runMvpNoModelSyntheticSmokePersistent(filesystemRootAlias)).rejects.toThrow(
      /explicit absolute path/u,
    );
  });

  it("refuses a symlinked persistent working root", async () => {
    const root = await temporaryRoot();
    const target = join(root, "target");
    const linkedRoot = join(root, "linked-root");
    await mkdir(target);
    await symlink(target, linkedRoot);

    await expect(runMvpNoModelSyntheticSmokePersistent(linkedRoot)).rejects.toThrow(
      /real directory/u,
    );
    expect(await readdir(target)).toEqual([]);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "df-mvp-synthetic-smoke-"));
  roots.push(root);
  return root;
}
