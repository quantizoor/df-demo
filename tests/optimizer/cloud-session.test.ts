import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  CloudSandboxProvider,
  ProviderProbeReport,
  RemoteCommandSpec,
  RemoteExecutionReceipt,
  SandboxCreateRequest,
  SandboxLease,
  TrustedCloudArtifactRef,
} from "../../src/cloud/types.js";
import { fingerprintRemoteUrl } from "../../src/harness/git.js";
import type { RepositoryRegistration } from "../../src/harness/repository.js";
import {
  CloudOnlyClaudeOptimizerSession,
  CloudOptimizerSessionError,
  type TrustedOptimizerArtifactReader,
} from "../../src/optimizer/cloud-session.js";
import type { OptimizerContext } from "../../src/orchestrator/contracts.js";
import { canonicalJson, withContentHash } from "../../src/schemas/canonical.js";

const COMMIT = "1".repeat(40);
const TREE = "2".repeat(40);
const CANDIDATE_COMMIT = "3".repeat(40);
const CANDIDATE_TREE = "4".repeat(40);
const LOCK = "5".repeat(64);
const ORIGIN = "https://github.com/parallaxai/df-pi-tbench.git";
const MODEL = "df-opus5-prod";
const FOUNDRY_RESOURCE = "df-eu-prod";
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE_REFERENCE = `ghcr.io/parallaxai/optimizer@${IMAGE_DIGEST}`;
const workerPath = fileURLToPath(
  new URL("../../scripts/optimizer-session-worker.mjs", import.meta.url),
);

function invokeWorker(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [workerPath, ...arguments_],
      {
        env: { ...environment },
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          code:
            error !== null && "code" in error && typeof error.code === "number"
              ? error.code
              : error === null
                ? 0
                : null,
          stdout,
          stderr,
        });
      },
    );
  });
}

function artifact(
  uri: `trusted://${string}`,
  sha256: string,
  mediaType: string,
  byteLength = 100,
): TrustedCloudArtifactRef {
  return { uri, sha256, mediaType, byteLength };
}

function jsonArtifact(
  uri: `trusted://${string}`,
  value: Readonly<Record<string, unknown>>,
): { readonly artifact: TrustedCloudArtifactRef; readonly raw: string } {
  const raw = `${canonicalJson(withContentHash(value))}\n`;
  return {
    artifact: artifact(
      uri,
      createHash("sha256").update(raw).digest("hex"),
      "application/json",
      Buffer.byteLength(raw),
    ),
    raw,
  };
}

class FakeReader implements TrustedOptimizerArtifactReader {
  readonly values: Map<string, string>;

  constructor(values: Map<string, string>) {
    this.values = values;
  }

  readUtf8(artifactRef: TrustedCloudArtifactRef, _maximumBytes: number): Promise<string> {
    const value = this.values.get(artifactRef.uri);
    if (value === undefined) throw new Error("missing fake artifact");
    return Promise.resolve(value);
  }
}

class FakeProvider implements CloudSandboxProvider {
  readonly name = "daytona" as const;
  readonly configuration = {
    provider: "daytona" as const,
    endpoint: "https://app.daytona.io/api",
    credentialEnvironmentNames: ["DAYTONA_API_KEY"],
    configFingerprint: "f".repeat(64),
  };
  readonly commands: RemoteCommandSpec[] = [];
  readonly uploads: {
    readonly artifact: TrustedCloudArtifactRef;
    readonly path: string;
  }[] = [];
  readonly downloads = new Map<string, TrustedCloudArtifactRef>();
  createRequest: SandboxCreateRequest | null = null;
  destroyed = false;
  failDestroy = false;

  probe(request: { readonly requestId: string }): Promise<ProviderProbeReport> {
    return Promise.resolve({
      provider: "daytona",
      requestId: request.requestId,
      checkedAt: "2026-07-01T00:00:00.000Z",
      configFingerprint: this.configuration.configFingerprint,
      capabilities: {
        lifecycle: true,
        cancellation: true,
        fileTransfer: true,
        hardTimeout: true,
        resourceReporting: true,
        networkDenyAll: true,
        kernelIsolation: true,
        dockerInDocker: false,
        gpu: false,
      },
      compatible: true,
      reasons: [],
    });
  }

  create(request: SandboxCreateRequest): Promise<SandboxLease> {
    this.createRequest = request;
    return Promise.resolve({
      provider: "daytona",
      sandboxId: "optimizer-sandbox",
      createdAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-07-01T01:00:00.000Z",
      imageReference: request.imageReference,
      imageDigest: request.imageDigest,
      regionClass: request.regionClass,
      resources: request.resources,
      networkPolicyHash: "9".repeat(64),
      marker: {
        provider: "daytona",
        sandboxId: "optimizer-sandbox",
        markerEnvironmentName: "DAYTONA_SANDBOX_ID",
      },
    });
  }

  execute(lease: SandboxLease, command: RemoteCommandSpec): Promise<RemoteExecutionReceipt> {
    this.commands.push(command);
    return Promise.resolve({
      provider: "daytona",
      sandboxId: lease.sandboxId,
      executionId: command.executionId ?? `execution-${this.commands.length}`,
      startedAt: "2026-07-01T00:00:00.000Z",
      finishedAt: "2026-07-01T00:00:01.000Z",
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      resourceReport: { peakMemoryMiB: 256, cpuTimeMs: 100 },
    });
  }

  upload(
    _lease: SandboxLease,
    artifactRef: TrustedCloudArtifactRef,
    remotePath: string,
  ): Promise<void> {
    this.uploads.push({ artifact: artifactRef, path: remotePath });
    return Promise.resolve();
  }

  download(_lease: SandboxLease, remotePath: string): Promise<TrustedCloudArtifactRef> {
    const value = this.downloads.get(remotePath);
    if (value === undefined) throw new Error(`missing ${remotePath}`);
    return Promise.resolve(value);
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    this.destroyed = true;
    return this.failDestroy ? Promise.reject(new Error("destroy failed")) : Promise.resolve();
  }
}

function registration(): RepositoryRegistration {
  const origin = fingerprintRemoteUrl(ORIGIN);
  return {
    registrationId: "6".repeat(64),
    canonicalPath: "/Users/example/pi",
    branch: "main",
    headCommit: COMMIT,
    treeSha: TREE,
    lockSha256: LOCK,
    upstreamBaseCommit: "7".repeat(40),
    originFingerprint: origin,
    upstreamFingerprint: fingerprintRemoteUrl("https://github.com/earendil-works/pi.git"),
    originVerification: {
      private: true,
      fetchable: true,
      writable: true,
      checkedAt: "2026-07-01T00:00:00.000Z",
      providerAttestationHash: "8".repeat(64),
    },
    upstreamVerification: {
      fetchable: true,
      upstreamHeadCommit: "9".repeat(40),
      mergeBaseCommit: "7".repeat(40),
      checkedAt: "2026-07-01T00:00:00.000Z",
      providerAttestationHash: "a".repeat(64),
    },
  };
}

function context(): OptimizerContext {
  return {
    experiment: {
      number: 1,
      slug: "generic-recovery",
      kind: "optimization",
      parentExperiment: 0,
      lineageId: "campaign",
      protocolHash: "b".repeat(64),
    },
    activeChampion: {
      baselineCommit: COMMIT,
      activeExperiment: 0,
      activeCommit: COMMIT,
      certifiedExperiment: null,
      certifiedCommit: null,
      updatedAt: "2026-07-01T00:00:00.000Z",
      sourceSealHash: "c".repeat(64),
    },
    diagnosticBrief: null,
    sourceOnlyBootstrap: true,
  };
}

function setupFixture(): {
  readonly provider: FakeProvider;
  readonly session: CloudOnlyClaudeOptimizerSession;
  readonly reader: FakeReader;
} {
  const provider = new FakeProvider();
  const bundle = artifact(
    "trusted://optimizer/candidate-bundle",
    "d".repeat(64),
    "application/vnd.git.bundle",
    500,
  );
  const diff = artifact("trusted://optimizer/candidate-diff", "e".repeat(64), "text/x-diff", 200);
  const state = artifact(
    "trusted://optimizer/session-state",
    "f".repeat(64),
    "application/x-tar",
    300,
  );
  const setup = jsonArtifact("trusted://optimizer/setup-result", {
    schemaVersion: 1,
    domain: "dark-factory.optimizer-setup.v1",
    phase: "proposal",
    campaignId: "campaign",
    experimentId: "001-generic-recovery",
    sourceMode: "private-github",
    registrationId: "6".repeat(64),
    originRepositoryHash: registration().originFingerprint.repositoryHash,
    sourceCommit: COMMIT,
    sourceTree: TREE,
    lockSha256: LOCK,
    pluginArchiveSha256: "1".repeat(64),
    evidenceArchiveSha256: "2".repeat(64),
    inputStateSha256: null,
  });
  const claude = jsonArtifact("trusted://optimizer/claude-result", {
    schemaVersion: 1,
    domain: "dark-factory.optimizer-claude.v1",
    phase: "proposal",
    campaignId: "campaign",
    experimentId: "001-generic-recovery",
    summary: {
      initialized: true,
      pluginLoaded: true,
      pluginErrors: [],
      sessionId: "session",
      model: MODEL,
      result: "completed",
      totalCostUsd: 1,
      turns: 2,
    },
    exitCode: 0,
    stderrSha256: "0".repeat(64),
  });
  const seal = jsonArtifact("trusted://optimizer/seal-result", {
    schemaVersion: 1,
    domain: "dark-factory.optimizer-proposal.v1",
    campaignId: "campaign",
    experimentId: "001-generic-recovery",
    sourceCommit: COMMIT,
    candidateCommit: CANDIDATE_COMMIT,
    candidateTree: CANDIDATE_TREE,
    lockSha256: LOCK,
    bundleRef: "refs/heads/df/bundle/001-generic-recovery",
    hypothesis: {
      hash: "a".repeat(64),
      sourceBriefHash: null,
      causalClaim: "Generic recovery needs a bounded inspection step.",
      intervention: "Add a generic inspection-first recovery instruction.",
      predictedRepairBehavior: "Failed calls are inspected before retrying.",
      predictedFreshEffect: canonicalJson({
        accuracy: "improve",
        capability: "unchanged",
        cost: "small increase",
        latency: "small increase",
      }),
      falsificationCriteria: ["No generic recovery behavior changes."],
      rollbackCondition: "Rollback on a broad matched regression.",
    },
    candidate: {
      commit: CANDIDATE_COMMIT,
      patchHash: diff.sha256,
      changedFiles: ["packages/coding-agent/src/core/system-prompt.ts"],
      mutationCategory: "prompt",
    },
    hypothesisReceiptId: "hypothesis_receipt_123",
    candidateReceiptId: "candidate_receipt_123",
    integrityPolicyHash: "b".repeat(64),
    bundle: { sha256: bundle.sha256, byteLength: bundle.byteLength },
    diff: { sha256: diff.sha256, byteLength: diff.byteLength },
    state: { sha256: state.sha256, byteLength: state.byteLength },
  });
  provider.downloads.set("/trusted/optimizer/setup-result.json", setup.artifact);
  provider.downloads.set("/trusted/optimizer/claude-result.json", claude.artifact);
  provider.downloads.set("/trusted/optimizer/sealed-result.json", seal.artifact);
  provider.downloads.set("/trusted/optimizer/candidate.bundle", bundle);
  provider.downloads.set("/trusted/optimizer/candidate.diff", diff);
  provider.downloads.set("/trusted/optimizer/output-state.tar", state);
  const reader = new FakeReader(
    new Map([
      [setup.artifact.uri, setup.raw],
      [claude.artifact.uri, claude.raw],
      [seal.artifact.uri, seal.raw],
    ]),
  );
  const session = new CloudOnlyClaudeOptimizerSession({
    provider,
    sandbox: {
      imageReference: IMAGE_REFERENCE,
      imageDigest: IMAGE_DIGEST,
      regionClass: "eu-standard",
      resources: {
        architecture: "x86_64",
        cpuCores: 4,
        memoryMiB: 8192,
        diskMiB: 32_000,
      },
      networkAllowDomains: ["github.com", `${FOUNDRY_RESOURCE}.services.ai.azure.com`],
      lifetimeMs: 3_600_000,
    },
    workerArtifact: artifact("trusted://optimizer/worker", "0".repeat(64), "text/javascript", 100),
    pluginArtifact: artifact(
      "trusted://optimizer/plugin",
      "1".repeat(64),
      "application/x-tar",
      100,
    ),
    artifactReader: reader,
    claude: {
      claudeExecutable: "/usr/local/bin/claude",
      model: MODEL,
      modelFamily: "claude-opus-5",
      foundryResourceName: FOUNDRY_RESOURCE,
      effort: "high",
      maximumBudgetUsd: 5,
      maximumTurns: 20,
      timeoutMs: 600_000,
    },
    optimizerSecretReferences: [
      {
        sourceEnvironmentName: "DF_FOUNDRY_OPTIMIZER_SECRET",
        targetEnvironmentName: "ANTHROPIC_FOUNDRY_API_KEY",
      },
    ],
  });
  return { provider, session, reader };
}

describe("cloud-only Claude optimizer session", () => {
  it("isolates Git, Claude, and sealing credential planes", async () => {
    const { provider, session } = setupFixture();
    const result = await session.propose({
      context: context(),
      source: {
        mode: "private-github",
        registration: registration(),
        origin: {
          host: "github.com",
          owner: "parallaxai",
          repository: "df-pi-tbench",
          credential: {
            sourceEnvironmentName: "DF_GITHUB_PAT",
            targetEnvironmentName: "DF_GITHUB_TOKEN",
          },
        },
        target: {
          remoteRef: "refs/heads/main",
          commitSha: COMMIT,
          treeSha: TREE,
          lockSha256: LOCK,
        },
      },
      releasedEvidence: artifact(
        "trusted://optimizer/evidence",
        "2".repeat(64),
        "application/x-tar",
      ),
    });

    expect(result.proposal.candidate.commit).toBe(CANDIDATE_COMMIT);
    expect(provider.commands).toHaveLength(3);
    expect(provider.commands[0]?.secretReferences).toEqual([
      {
        sourceEnvironmentName: "DF_GITHUB_PAT",
        targetEnvironmentName: "DF_GITHUB_TOKEN",
      },
    ]);
    expect(provider.commands[1]?.secretReferences).toEqual([
      {
        sourceEnvironmentName: "DF_FOUNDRY_OPTIMIZER_SECRET",
        targetEnvironmentName: "ANTHROPIC_FOUNDRY_API_KEY",
      },
    ]);
    expect(provider.commands[2]?.secretReferences).toEqual([]);
    expect(provider.commands[1]?.arguments[1]).toBe("run-claude");
    const encodedIndex = provider.commands[1]?.arguments.indexOf("--command-base64url") ?? -1;
    const encoded = provider.commands[1]?.arguments[encodedIndex + 1] ?? "";
    const nested = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as RemoteCommandSpec;
    expect(nested.secretReferences).toEqual([
      {
        sourceEnvironmentName: "DF_FOUNDRY_OPTIMIZER_SECRET",
        targetEnvironmentName: "ANTHROPIC_FOUNDRY_API_KEY",
      },
    ]);
    expect(nested.arguments.join(" ")).toContain("Bash,Shell,WebSearch,WebFetch");
    expect(JSON.stringify(nested)).not.toContain("DF_GITHUB");
    expect(provider.createRequest?.resources.architecture).toBe("x86_64");
    expect(provider.destroyed).toBe(true);
  });

  it("invalidates an otherwise complete result when teardown fails", async () => {
    const { provider, session } = setupFixture();
    provider.failDestroy = true;
    await expect(
      session.propose({
        context: context(),
        source: {
          mode: "private-github",
          registration: registration(),
          origin: {
            host: "github.com",
            owner: "parallaxai",
            repository: "df-pi-tbench",
            credential: {
              sourceEnvironmentName: "DF_GITHUB_PAT",
              targetEnvironmentName: "DF_GITHUB_TOKEN",
            },
          },
          target: {
            remoteRef: "refs/heads/main",
            commitSha: COMMIT,
            treeSha: TREE,
            lockSha256: LOCK,
          },
        },
        releasedEvidence: artifact(
          "trusted://optimizer/evidence",
          "2".repeat(64),
          "application/x-tar",
        ),
      }),
    ).rejects.toThrow(/teardown failed/u);
  });

  it("rehydrates sealed proposal state for a later read-only analysis", async () => {
    const { provider, session, reader } = setupFixture();
    const proposal = await session.propose({
      context: context(),
      source: {
        mode: "private-github",
        registration: registration(),
        origin: {
          host: "github.com",
          owner: "parallaxai",
          repository: "df-pi-tbench",
          credential: {
            sourceEnvironmentName: "DF_GITHUB_PAT",
            targetEnvironmentName: "DF_GITHUB_TOKEN",
          },
        },
        target: {
          remoteRef: "refs/heads/main",
          commitSha: COMMIT,
          treeSha: TREE,
          lockSha256: LOCK,
        },
      },
      releasedEvidence: artifact(
        "trusted://optimizer/evidence",
        "2".repeat(64),
        "application/x-tar",
      ),
    });
    const analysisEvidence = artifact(
      "trusted://optimizer/analysis-evidence",
      "7".repeat(64),
      "application/x-tar",
    );
    const setup = jsonArtifact("trusted://optimizer/analysis-setup", {
      schemaVersion: 1,
      domain: "dark-factory.optimizer-setup.v1",
      phase: "analysis",
      campaignId: "campaign",
      experimentId: "001-generic-recovery",
      sourceMode: "trusted-bundle",
      registrationId: proposal.setup.registrationId,
      originRepositoryHash: proposal.setup.originRepositoryHash,
      sourceCommit: CANDIDATE_COMMIT,
      sourceTree: CANDIDATE_TREE,
      lockSha256: LOCK,
      pluginArchiveSha256: "1".repeat(64),
      evidenceArchiveSha256: analysisEvidence.sha256,
      inputStateSha256: proposal.sessionState.sha256,
    });
    const claude = jsonArtifact("trusted://optimizer/analysis-claude", {
      schemaVersion: 1,
      domain: "dark-factory.optimizer-claude.v1",
      phase: "analysis",
      campaignId: "campaign",
      experimentId: "001-generic-recovery",
      summary: {
        initialized: true,
        pluginLoaded: true,
        pluginErrors: [],
        sessionId: "analysis-session",
        model: MODEL,
        result: "completed",
        totalCostUsd: 0.5,
        turns: 1,
      },
      exitCode: 0,
      stderrSha256: "8".repeat(64),
    });
    const outputState = artifact(
      "trusted://optimizer/analysis-state",
      "9".repeat(64),
      "application/x-tar",
      350,
    );
    const seal = jsonArtifact("trusted://optimizer/analysis-seal", {
      schemaVersion: 1,
      domain: "dark-factory.optimizer-analysis.v1",
      campaignId: "campaign",
      experimentId: "001-generic-recovery",
      candidateCommit: CANDIDATE_COMMIT,
      analysisHash: "a".repeat(64),
      rollbackRequired: false,
      analysisReceiptId: "analysis_receipt_123",
      state: {
        sha256: outputState.sha256,
        byteLength: outputState.byteLength,
      },
    });
    for (const value of [setup, claude, seal]) {
      reader.values.set(value.artifact.uri, value.raw);
    }
    provider.downloads.set("/trusted/optimizer/setup-result.json", setup.artifact);
    provider.downloads.set("/trusted/optimizer/claude-result.json", claude.artifact);
    provider.downloads.set("/trusted/optimizer/sealed-result.json", seal.artifact);
    provider.downloads.set("/trusted/optimizer/output-state.tar", outputState);

    const result = await session.analyze({
      experiment: context().experiment,
      proposal,
      releasedEvidence: analysisEvidence,
    });

    expect(result.analysisHash).toBe("a".repeat(64));
    expect(
      provider.commands
        .slice(-3)
        .map((command) =>
          command.secretReferences.map((reference) => reference.targetEnvironmentName),
        ),
    ).toEqual([[], ["ANTHROPIC_FOUNDRY_API_KEY"], []]);
    expect(
      provider.uploads.some(
        (upload) =>
          upload.path === "/trusted/optimizer/input-state.tar" &&
          upload.artifact.sha256 === proposal.sessionState.sha256,
      ),
    ).toBe(true);
  });

  it("rejects a source detached from the active champion before provisioning", async () => {
    const { provider, session } = setupFixture();
    await expect(
      session.propose({
        context: context(),
        source: {
          mode: "private-github",
          registration: registration(),
          origin: {
            host: "github.com",
            owner: "parallaxai",
            repository: "df-pi-tbench",
            credential: {
              sourceEnvironmentName: "DF_GITHUB_PAT",
              targetEnvironmentName: "DF_GITHUB_TOKEN",
            },
          },
          target: {
            remoteRef: "refs/heads/main",
            commitSha: "f".repeat(40),
            treeSha: TREE,
            lockSha256: LOCK,
          },
        },
        releasedEvidence: artifact(
          "trusted://optimizer/evidence",
          "2".repeat(64),
          "application/x-tar",
        ),
      }),
    ).rejects.toBeInstanceOf(CloudOptimizerSessionError);
    expect(provider.createRequest).toBeNull();
  });

  it("keeps the worker cloud-only and avoids shell execution", async () => {
    const source = await readFile(workerPath, "utf8");
    expect(source).toContain('process.env.DF_CLOUD_EXECUTION !== "1"');
    expect(source).toContain("shell: false");
    expect(source).not.toContain("shell: true");
    expect(source).not.toContain("execSync(");
    expect(source).not.toContain("execFileSync(");
    expect(source).not.toContain("${token}");
  });

  it("refuses missing cloud attestation and never echoes a Git secret", async () => {
    const sentinel = "github_pat_DO_NOT_ECHO_123456789";
    const missingMarker = await invokeWorker(["setup"], {
      DF_CLOUD_EXECUTION: "1",
      DF_GITHUB_TOKEN: sentinel,
    });
    expect(missingMarker).toEqual({
      code: 78,
      stdout: "",
      stderr: "Optimizer worker failed closed.\n",
    });
    const incompleteSetup = await invokeWorker(["setup"], {
      DF_CLOUD_EXECUTION: "1",
      DAYTONA_SANDBOX_ID: "sandbox-test",
      DF_GITHUB_TOKEN: sentinel,
    });
    expect(incompleteSetup.code).toBe(78);
    expect(incompleteSetup.stdout).toBe("");
    expect(incompleteSetup.stderr).toBe("Optimizer worker failed closed.\n");
    expect(incompleteSetup.stderr).not.toContain(sentinel);
  });
});
