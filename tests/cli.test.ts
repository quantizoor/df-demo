import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RepositoryDoctorExpectation,
  RepositoryDoctorReport,
} from "../src/harness/repository.js";
import {
  type CampaignControlStore,
  type CliOutput,
  campaign,
  createDarkFactoryCli,
  runDarkFactoryCli,
} from "../src/index.js";
import { withContentHash } from "../src/schemas/canonical.js";
import type { CampaignState } from "../src/schemas/control.js";
import { assertValidDocument } from "../src/schemas/registry.js";
import { initialCampaignStateFixture } from "./campaign/fixtures.js";

const temporaryDirectories: string[] = [];
const HASH = "a".repeat(64);
const DISABLED_WORKLOAD_COMMANDS: readonly (readonly string[])[] = [
  ["init"],
  ["sandbox", "probe"],
  ["baseline", "init"],
  ["optimize"],
  ["full-eval", "prepare"],
  ["full-eval", "authorize", "challenge"],
  ["full-eval", "run"],
];

async function temporaryWorkspace(): Promise<{
  readonly darkFactory: string;
  readonly pi: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "df-cli-test-"));
  temporaryDirectories.push(root);
  const darkFactory = join(root, "df-demo");
  const pi = join(root, "pi");
  await Promise.all([
    mkdir(join(darkFactory, "claude-plugin/.claude-plugin"), {
      recursive: true,
    }),
    mkdir(join(pi, ".git"), { recursive: true }),
    mkdir(join(pi, "packages/coding-agent"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(darkFactory, "package.json"), "{}\n"),
    writeFile(join(darkFactory, "claude-plugin/.claude-plugin/plugin.json"), "{}\n"),
    writeFile(join(pi, "package-lock.json"), "{}\n"),
    writeFile(join(pi, "packages/coding-agent/package.json"), "{}\n"),
  ]);
  return { darkFactory, pi };
}

function captureOutput(): {
  readonly output: CliOutput;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    output: {
      writeOut: (value) => stdout.push(value),
      writeErr: (value) => stderr.push(value),
    },
    stdout,
    stderr,
  };
}

function completeEnvironment(secret: string): NodeJS.ProcessEnv {
  const imageDigest = `sha256:${"a".repeat(64)}`;
  return {
    DF_CLOUD_PROVIDER: "daytona",
    DAYTONA_API_KEY: secret,
    DF_CLOUD_REGION_CLASS: "trusted-eu",
    DF_TRUSTED_CONTROL_PLANE: "1",
    DF_TRUSTED_VOLUME_ROOT: "/mnt/dark-factory",
    DF_CONTROL_IMAGE_REFERENCE: `ghcr.io/parallaxai/df-control@${imageDigest}`,
    DF_CONTROL_IMAGE_DIGEST: imageDigest,
    DF_OPTIMIZER_IMAGE_REFERENCE: `ghcr.io/parallaxai/df-optimizer@${imageDigest}`,
    DF_OPTIMIZER_IMAGE_DIGEST: imageDigest,
    DF_BUILD_IMAGE_REFERENCE: `ghcr.io/parallaxai/df-build@${imageDigest}`,
    DF_BUILD_IMAGE_DIGEST: imageDigest,
    DF_EVALUATOR_IMAGE_REFERENCE: `ghcr.io/parallaxai/df-evaluator@${imageDigest}`,
    DF_EVALUATOR_IMAGE_DIGEST: imageDigest,
    DF_FOUNDRY_RESOURCE_NAME: "df-eu-prod",
    DF_OPTIMIZER_MODEL: "claude-opus-5",
    DF_OPTIMIZER_DEPLOYMENT_NAME: "df-opus5-prod",
    DF_OPTIMIZER_EFFORT: "high",
    DF_CLAUDE_CODE_VERSION: "2.1.217",
    DF_OPTIMIZER_SECRET_SOURCE: "DF_FOUNDRY_OPTIMIZER_SECRET",
    DF_OPTIMIZER_SECRET_TARGET: "ANTHROPIC_FOUNDRY_API_KEY",
    DF_EVALUATED_PROVIDER: "microsoft-foundry",
    DF_EVALUATED_MODEL: "claude-opus-4-8",
    DF_EVALUATED_DEPLOYMENT_NAME: "df-opus48-eval",
    DF_EVALUATED_REASONING: "high",
    DF_EVALUATED_SECRET_BINDINGS_JSON: JSON.stringify([
      {
        sourceEnvironmentName: "DF_FOUNDRY_EVALUATED_SECRET",
        targetEnvironmentName: "ANTHROPIC_FOUNDRY_API_KEY",
      },
    ]),
    DF_GITHUB_SECRET_SOURCE: "DF_GITHUB_PRIVATE_REPO_SECRET",
    DF_HARBOR_SECRET_BINDINGS_JSON: JSON.stringify([
      {
        sourceEnvironmentName: "DF_DAYTONA_NESTED_SECRET",
        targetEnvironmentName: "DAYTONA_API_KEY",
      },
    ]),
    DF_MODE: "research",
    DF_LEADERBOARD_ELIGIBILITY: "unverified",
    DF_TRUSTED_ZONE: "trusted-zone",
    DF_SIGNING_KEY_ID: "signer",
    DF_HARBOR_VERSION: "0.20.0",
    DF_TBENCH_REGISTRY_REVISION: "6",
    DF_TBENCH_DATASET_CONTENT_SHA256: "b".repeat(64),
    DF_TBENCH_DATASET_MANIFEST_SHA256: "c".repeat(64),
    DF_HARBOR_PACKAGE_SHA256: "d".repeat(64),
    DF_HARBOR_EXECUTABLE_SHA256: "e".repeat(64),
    DF_PI_HARBOR_ADAPTER_SHA256: "f".repeat(64),
    DF_BUDGET_USD: "100",
    DF_BUDGET_TOKENS: "1000000",
    DF_BUDGET_WALL_TIME_MINUTES: "240",
    DF_BUDGET_ATTEMPTS: "380",
    DF_BUDGET_PRIVACY_RELEASES: "5",
    DF_BUDGET_PROMOTION_LOOKS: "5",
    DF_BUDGET_ONLINE_ERROR: "0.05",
  };
}

function repositoryReport(canonicalPath: string): RepositoryDoctorReport {
  return {
    canonicalPath,
    branch: "main",
    trackingRef: "origin/main",
    headCommit: "a".repeat(40),
    treeSha: "b".repeat(40),
    lockSha256: "c".repeat(64),
    originFingerprint: {
      transport: "ssh",
      hostHash: "d".repeat(64),
      repositoryHash: "e".repeat(64),
    },
    remotes: ["origin"],
    clean: true,
    piMonorepo: true,
  };
}

function campaignStore(
  current: CampaignState,
  next: CampaignState = current,
): {
  readonly store: CampaignControlStore;
  readonly requestStop: ReturnType<typeof vi.fn>;
  readonly resume: ReturnType<typeof vi.fn>;
} {
  const requestStop = vi.fn(async () => next);
  const resume = vi.fn(async () => next);
  return {
    store: {
      read: async () => current,
      requestStop,
      resume,
    },
    requestStop,
    resume,
  };
}

function rehashCampaignState(state: CampaignState): CampaignState {
  const { contentHash: previousContentHash, ...draft } = state;
  void previousContentHash;
  const value: unknown = withContentHash(draft);
  assertValidDocument("campaignState", value);
  return value;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Dark Factory CLI", () => {
  it("exports the public namespaces without executing the CLI", () => {
    expect(campaign.CampaignStateStore).toBeTypeOf("function");
    expect(createDarkFactoryCli).toBeTypeOf("function");
  });

  it("reports only prerequisite presence and never echoes credential values", async () => {
    const workspace = await temporaryWorkspace();
    const capture = captureOutput();
    const secret = "daytona-super-secret-value";

    const exitCode = await runDarkFactoryCli(["doctor"], {
      cwd: workspace.darkFactory,
      environment: completeEnvironment(secret),
      output: capture.output,
    });

    expect(exitCode).toBe(0);
    expect(capture.stderr).toEqual([]);
    const report = JSON.parse(capture.stdout.join("")) as {
      readonly ok: boolean;
      readonly environment: {
        readonly presence: Readonly<Record<string, boolean>>;
      };
    };
    expect(report.ok).toBe(true);
    expect(report.environment.presence["DAYTONA_API_KEY"]).toBe(true);
    expect(capture.stdout.join("")).not.toContain(secret);
    expect(capture.stdout.join("")).not.toContain("claude-opus-5");
  });

  it("doctors the sibling Pi checkout without releasing its absolute path", async () => {
    const workspace = await temporaryWorkspace();
    const capture = captureOutput();
    const inspectRepository = vi.fn(async (expectation: RepositoryDoctorExpectation) =>
      repositoryReport(expectation.canonicalPath),
    );

    const exitCode = await runDarkFactoryCli(["harness", "doctor"], {
      cwd: workspace.darkFactory,
      environment: {},
      output: capture.output,
      inspectRepository,
    });

    expect(exitCode).toBe(0);
    expect(inspectRepository).toHaveBeenCalledWith({
      canonicalPath: resolve(workspace.pi),
      expectedBranch: "main",
      expectedTrackingRemote: "origin",
    });
    expect(capture.stdout.join("")).toContain('"mutationPerformed": false');
    expect(capture.stdout.join("")).not.toContain(workspace.pi);
  });

  it("fails harness registration closed until trusted verification and persistence exist", async () => {
    const workspace = await temporaryWorkspace();
    const capture = captureOutput();

    const exitCode = await runDarkFactoryCli(["harness", "register"], {
      cwd: workspace.darkFactory,
      environment: {},
      output: capture.output,
    });

    expect(exitCode).toBe(78);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("")).toContain("DF_MISSING_COMPOSITION");
    expect(capture.stderr.join("")).toContain("No workload was started");
  });

  it("reports missing human authorization input without exiting the process", async () => {
    const capture = captureOutput();

    const exitCode = await runDarkFactoryCli(["full-eval", "authorize"], {
      cwd: "/workspace/df-demo",
      environment: {},
      output: capture.output,
    });

    expect(exitCode).toBe(64);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("")).toContain("DF_MISSING_USER_INPUT");
  });

  for (const arguments_ of DISABLED_WORKLOAD_COMMANDS) {
    it(`fails executable command ${arguments_.join(" ")} closed`, async () => {
      const capture = captureOutput();

      const exitCode = await runDarkFactoryCli(arguments_, {
        cwd: "/workspace/df-demo",
        environment: {},
        output: capture.output,
      });

      expect(exitCode).toBe(78);
      expect(capture.stdout).toEqual([]);
      expect(capture.stderr.join("")).toContain("DF_MISSING_COMPOSITION");
      expect(capture.stderr.join("")).toContain("No workload was started");
    });
  }

  it("summarizes durable campaign state through an injected verified store", async () => {
    const capture = captureOutput();
    const state = initialCampaignStateFixture();
    const fake = campaignStore(state);
    const createCampaignStore = vi.fn(() => fake.store);

    const exitCode = await runDarkFactoryCli(
      ["status", "--campaign", "campaign-001", "--state-root", ".control"],
      {
        cwd: "/workspace/df-demo",
        environment: {},
        output: capture.output,
        createCampaignStore,
      },
    );

    expect(exitCode).toBe(0);
    expect(createCampaignStore).toHaveBeenCalledWith("/workspace/df-demo/.control", "campaign-001");
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({
      command: "campaign status",
      ok: true,
      campaign: {
        campaignId: "campaign-001",
        revision: 0,
        status: "running",
      },
    });
  });

  it("requests a compare-and-swap stop and does not forge an attestation", async () => {
    const capture = captureOutput();
    const current = initialCampaignStateFixture();
    const next = rehashCampaignState({
      ...current,
      control: {
        ...current.control,
        status: "stop-requested",
        stopRequestedAt: "2026-07-26T11:00:00.000Z",
        stopReason: "operator",
      },
    });
    const fake = campaignStore(current, next);

    const exitCode = await runDarkFactoryCli(
      ["campaign", "stop", "--campaign", "campaign-001", "--state-root", ".control"],
      {
        cwd: "/workspace/df-demo",
        environment: {},
        output: capture.output,
        createCampaignStore: () => fake.store,
      },
    );

    expect(exitCode).toBe(0);
    expect(fake.requestStop).toHaveBeenCalledWith(current.contentHash, "operator");
    expect(capture.stdout.join("")).toContain('"changed": true');
  });

  it("requires a real one-use authorization hash before resume", async () => {
    const capture = captureOutput();
    const createCampaignStore = vi.fn();

    const exitCode = await runDarkFactoryCli(
      ["resume", "--campaign", "campaign-001", "--state-root", ".control"],
      {
        cwd: "/workspace/df-demo",
        environment: {},
        output: capture.output,
        createCampaignStore,
      },
    );

    expect(exitCode).toBe(64);
    expect(createCampaignStore).not.toHaveBeenCalled();
    expect(capture.stderr.join("")).toContain("DF_MISSING_USER_INPUT");
  });

  it("consumes the supplied authorization only through CampaignStateStore.resume", async () => {
    const capture = captureOutput();
    const initial = initialCampaignStateFixture();
    const paused = rehashCampaignState({
      ...initial,
      control: {
        ...initial.control,
        status: "paused",
        pausedAt: "2026-07-26T11:00:00.000Z",
        pauseReason: "infrastructure",
        pauseAttestationHash: "b".repeat(64),
      },
    });
    const resumed = rehashCampaignState({
      ...paused,
      control: {
        ...paused.control,
        status: "running",
        runEpoch: 1,
        pausedAt: null,
        pauseReason: null,
        pauseAttestationHash: null,
        lastResumedAt: "2026-07-26T11:01:00.000Z",
        lastResumeAuthorizationHash: HASH,
      },
    });
    const fake = campaignStore(paused, resumed);

    const exitCode = await runDarkFactoryCli(
      [
        "resume",
        "--campaign",
        "campaign-001",
        "--state-root",
        ".control",
        "--authorization-hash",
        HASH,
      ],
      {
        cwd: "/workspace/df-demo",
        environment: {},
        output: capture.output,
        createCampaignStore: () => fake.store,
      },
    );

    expect(exitCode).toBe(0);
    expect(fake.resume).toHaveBeenCalledWith(paused.contentHash, HASH);
    expect(capture.stdout.join("")).toContain('"authorizationConsumed": true');
  });
});
