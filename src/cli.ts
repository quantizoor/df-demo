#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Command, CommanderError } from "commander";

import { CampaignControlError } from "./campaign/errors.js";
import { CampaignStateStore, type CampaignStateStoreOptions } from "./campaign/store.js";
import {
  inspectBootstrapEnvironment,
  redactEnvironmentForDiagnostics,
} from "./config/environment.js";
import { GitCommandError, redactSensitiveText, SafeGit } from "./harness/git.js";
import type { ProcessInvocation, ProcessResult, ProcessRunner } from "./harness/process.js";
import {
  doctorRepository,
  type RepositoryDoctorExpectation,
  type RepositoryDoctorReport,
  RepositoryPolicyError,
  type RepositoryRegistration,
} from "./harness/repository.js";
import type { CampaignState } from "./schemas/control.js";
import { assertValidDocument } from "./schemas/registry.js";

const SAFE_IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAXIMUM_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

const READ_ONLY_GIT_INVOCATIONS = new Set([
  "config --get remote.origin.url",
  "config --get remote.upstream.url",
  "remote",
  "rev-parse --abbrev-ref --symbolic-full-name @{upstream}",
  "rev-parse --is-inside-work-tree",
  "rev-parse --show-toplevel",
  "rev-parse HEAD",
  "rev-parse HEAD^{tree}",
  "show HEAD:package-lock.json",
  "show HEAD:packages/coding-agent/package.json",
  "status --porcelain=v1 --untracked-files=normal",
  "symbolic-ref --quiet --short HEAD",
]);

export type CliErrorCode =
  | "DF_COMMAND_FAILED"
  | "DF_INVALID_INPUT"
  | "DF_MISSING_COMPOSITION"
  | "DF_MISSING_USER_INPUT"
  | "DF_USAGE";

export class DarkFactoryCliError extends Error {
  public readonly code: CliErrorCode;
  public readonly exitCode: number;

  public constructor(
    code: CliErrorCode,
    message: string,
    exitCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DarkFactoryCliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface CliOutput {
  readonly writeOut: (value: string) => void;
  readonly writeErr: (value: string) => void;
}

export type CampaignControlStore = Pick<CampaignStateStore, "read" | "requestStop" | "resume">;

export type CampaignStoreFactory = (stateRoot: string, campaignId: string) => CampaignControlStore;

export type VerifiedCampaignStoreOptions = CampaignStateStoreOptions &
  Required<
    Pick<
      CampaignStateStoreOptions,
      "controlAttestationVerifier" | "decisionAttestationVerifier" | "ledgerTransitionVerifier"
    >
  >;

export function createVerifiedCampaignStoreFactory(
  options: VerifiedCampaignStoreOptions,
): CampaignStoreFactory {
  return (stateRoot, campaignId) => new CampaignStateStore(stateRoot, campaignId, options);
}

export interface HarnessRegistrationResult {
  readonly repository: RepositoryRegistration;
  readonly registrationContentHash: string;
  readonly persisted: true;
  readonly canonicalRepositoryMutationPerformed: false;
}

export interface DarkFactoryCliDependencies {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly output?: CliOutput;
  readonly inspectRepository?: (
    expectation: RepositoryDoctorExpectation,
  ) => Promise<RepositoryDoctorReport>;
  /**
   * Registration is deliberately an injected trusted composition. It must
   * verify the private origin and public upstream in the cloud, create the
   * signed HarnessRegistration document, and persist it before returning.
   */
  readonly registerHarness?: (
    expectation: RepositoryDoctorExpectation,
  ) => Promise<HarnessRegistrationResult>;
  /**
   * The factory must install the trusted signature/attestation verifiers
   * needed by CampaignStateStore reconstruction and control transitions.
   */
  readonly createCampaignStore?: CampaignStoreFactory;
}

interface CampaignCommandOptions {
  readonly authorizationHash?: string;
  readonly campaign?: string;
  readonly stateRoot?: string;
}

interface HarnessCommandOptions {
  readonly repository?: string;
}

interface SourcePrerequisitePresence {
  readonly darkFactoryPackage: boolean;
  readonly optimizerPluginManifest: boolean;
  readonly piCodingAgentPackage: boolean;
  readonly piGitMetadata: boolean;
  readonly piPackageLock: boolean;
}

export interface DoctorReport {
  readonly command: "doctor";
  readonly ok: boolean;
  readonly executionPolicy: {
    readonly localWorkloadsAllowed: false;
    readonly cloudSandboxRequired: true;
  };
  readonly environment: {
    readonly ready: boolean;
    readonly missing: readonly string[];
    readonly invalid: readonly string[];
    readonly presence: Readonly<Record<string, boolean>>;
  };
  readonly sourcePrerequisites: SourcePrerequisitePresence;
}

interface SafeRepositorySummary {
  readonly repository: string;
  readonly branch: string;
  readonly trackingRef: string;
  readonly headCommit: string;
  readonly treeSha: string;
  readonly lockSha256: string;
  readonly origin: {
    readonly transport: string;
    readonly hostFingerprint: string;
    readonly repositoryFingerprint: string;
  };
  readonly remotes: {
    readonly originConfigured: true;
    readonly upstreamConfigured: boolean;
    readonly count: number;
  };
  readonly clean: true;
  readonly piMonorepo: true;
}

interface SafeCampaignSummary {
  readonly campaignId: string;
  readonly revision: number;
  readonly stateHash: string;
  readonly protocolHash: string;
  readonly status: CampaignState["control"]["status"];
  readonly runEpoch: number;
  readonly numbering: CampaignState["numbering"];
  readonly champions: {
    readonly baseline: CampaignState["champions"]["baseline"];
    readonly active: CampaignState["champions"]["active"];
    readonly certified: CampaignState["champions"]["certified"];
  };
  readonly budget: {
    readonly limits: CampaignState["budget"]["limits"];
    readonly usage: CampaignState["budget"]["usage"];
  };
  readonly holdout: {
    readonly freshValidationSetsRemaining: number;
    readonly shadowSlicesRemaining: number;
    readonly generation: number;
  };
}

function defaultOutput(): CliOutput {
  return {
    writeOut: (value) => {
      process.stdout.write(value);
    },
    writeErr: (value) => {
      process.stderr.write(value);
    },
  };
}

function writeJson(writer: (value: string) => void, value: unknown): void {
  writer(`${JSON.stringify(value, null, 2)}\n`);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function isRegularPath(path: string, kind: "directory" | "file"): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return false;
    return kind === "directory" ? info.isDirectory() : info.isFile();
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function inspectSourcePrerequisites(
  cwd: string,
  repositoryPath: string,
): Promise<SourcePrerequisitePresence> {
  const [
    darkFactoryPackage,
    optimizerPluginManifest,
    piCodingAgentPackage,
    piGitMetadata,
    piPackageLock,
  ] = await Promise.all([
    isRegularPath(resolve(cwd, "package.json"), "file"),
    isRegularPath(resolve(cwd, "claude-plugin/.claude-plugin/plugin.json"), "file"),
    isRegularPath(resolve(repositoryPath, "packages/coding-agent/package.json"), "file"),
    isRegularPath(resolve(repositoryPath, ".git"), "directory"),
    isRegularPath(resolve(repositoryPath, "package-lock.json"), "file"),
  ]);
  return {
    darkFactoryPackage,
    optimizerPluginManifest,
    piCodingAgentPackage,
    piGitMetadata,
    piPackageLock,
  };
}

function allPresent(presence: SourcePrerequisitePresence): boolean {
  return Object.values(presence).every((value) => value);
}

async function createDoctorReport(
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<DoctorReport> {
  const repositoryPath = resolve(cwd, "../pi");
  const environmentReadiness = inspectBootstrapEnvironment(environment);
  const sourcePrerequisites = await inspectSourcePrerequisites(cwd, repositoryPath);
  return {
    command: "doctor",
    ok: environmentReadiness.ready && allPresent(sourcePrerequisites),
    executionPolicy: {
      localWorkloadsAllowed: false,
      cloudSandboxRequired: true,
    },
    environment: {
      ready: environmentReadiness.ready,
      missing: environmentReadiness.missing,
      invalid: environmentReadiness.invalid,
      presence: redactEnvironmentForDiagnostics(environment),
    },
    sourcePrerequisites,
  };
}

function invocationKey(invocation: ProcessInvocation): string {
  return invocation.arguments.join(" ");
}

/**
 * Narrow local reader used only by `df harness doctor`.
 *
 * It cannot fetch, tag, check out, create a worktree, write configuration, or
 * prompt for credentials. Benchmark and candidate workloads never use it.
 */
class LocalReadOnlyRepositoryRunner implements ProcessRunner {
  public run(invocation: ProcessInvocation): Promise<ProcessResult> {
    if (
      invocation.executable !== "git" ||
      invocation.stdin !== "closed" ||
      !READ_ONLY_GIT_INVOCATIONS.has(invocationKey(invocation))
    ) {
      return Promise.reject(
        new DarkFactoryCliError(
          "DF_INVALID_INPUT",
          "Harness doctor attempted a Git operation outside its read-only allowlist.",
          64,
        ),
      );
    }

    return new Promise((complete) => {
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let outputExceeded = false;
      let timedOut = false;
      let settled = false;
      const child = spawn("/usr/bin/git", invocation.arguments, {
        cwd: invocation.workingDirectory,
        env: {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_KEY_0: "core.fsmonitor",
          GIT_CONFIG_KEY_1: "core.hooksPath",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_VALUE_0: "false",
          GIT_CONFIG_VALUE_1: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const finish = (result: ProcessResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        complete(result);
      };
      const append = (destination: "stdout" | "stderr", chunk: unknown): void => {
        const text = String(chunk);
        outputBytes += Buffer.byteLength(text);
        if (outputBytes > MAXIMUM_GIT_OUTPUT_BYTES) {
          outputExceeded = true;
          child.kill("SIGKILL");
          return;
        }
        if (destination === "stdout") stdout += text;
        else stderr += text;
      };

      child.stdout.on("data", (chunk: unknown) => append("stdout", chunk));
      child.stderr.on("data", (chunk: unknown) => append("stderr", chunk));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, invocation.timeoutMs);

      child.once("error", () => {
        finish({
          exitCode: 71,
          stdout: "",
          stderr: "Unable to start the read-only Git inspector.",
        });
      });
      child.once("close", (code) => {
        if (outputExceeded) {
          finish({
            exitCode: 75,
            stdout: "",
            stderr: "Read-only Git output exceeded its configured limit.",
          });
          return;
        }
        if (timedOut) {
          finish({
            exitCode: 124,
            stdout: "",
            stderr: "Read-only Git inspection exceeded its timeout.",
          });
          return;
        }
        finish({
          exitCode: code ?? 70,
          stdout,
          stderr,
        });
      });
    });
  }
}

function defaultRepositoryInspector(
  expectation: RepositoryDoctorExpectation,
): Promise<RepositoryDoctorReport> {
  return doctorRepository(new SafeGit(new LocalReadOnlyRepositoryRunner()), expectation);
}

function safeRepositorySummary(report: RepositoryDoctorReport): SafeRepositorySummary {
  return {
    repository: "pi",
    branch: report.branch,
    trackingRef: report.trackingRef,
    headCommit: report.headCommit,
    treeSha: report.treeSha,
    lockSha256: report.lockSha256,
    origin: {
      transport: report.originFingerprint.transport,
      hostFingerprint: report.originFingerprint.hostHash,
      repositoryFingerprint: report.originFingerprint.repositoryHash,
    },
    remotes: {
      originConfigured: true,
      upstreamConfigured: report.remotes.includes("upstream"),
      count: report.remotes.length,
    },
    clean: report.clean,
    piMonorepo: report.piMonorepo,
  };
}

function assertSafeRepositoryReport(
  report: RepositoryDoctorReport,
  expectation: RepositoryDoctorExpectation,
): void {
  if (
    resolve(report.canonicalPath) !== expectation.canonicalPath ||
    report.branch !== "main" ||
    report.trackingRef !== "origin/main" ||
    !GIT_OBJECT_ID.test(report.headCommit) ||
    !GIT_OBJECT_ID.test(report.treeSha) ||
    !SHA256.test(report.lockSha256) ||
    !SHA256.test(report.originFingerprint.hostHash) ||
    !SHA256.test(report.originFingerprint.repositoryHash) ||
    (report.originFingerprint.transport !== "https" &&
      report.originFingerprint.transport !== "ssh") ||
    report.clean !== true ||
    report.piMonorepo !== true ||
    !report.remotes.includes("origin") ||
    report.remotes.length > 16 ||
    new Set(report.remotes).size !== report.remotes.length
  ) {
    throw new DarkFactoryCliError(
      "DF_COMMAND_FAILED",
      "Harness doctor returned an invalid or mismatched release-safe report.",
      70,
    );
  }
}

function assertSafeRegistrationResult(
  result: HarnessRegistrationResult,
  expectation: RepositoryDoctorExpectation,
): void {
  const registration = result.repository;
  const hashes = [
    result.registrationContentHash,
    registration.lockSha256,
    registration.originFingerprint.hostHash,
    registration.originFingerprint.repositoryHash,
    registration.originVerification.providerAttestationHash,
    registration.upstreamFingerprint.hostHash,
    registration.upstreamFingerprint.repositoryHash,
    registration.upstreamVerification.providerAttestationHash,
  ];
  const objectIds = [
    registration.headCommit,
    registration.treeSha,
    registration.upstreamBaseCommit,
    registration.upstreamVerification.upstreamHeadCommit,
    registration.upstreamVerification.mergeBaseCommit,
  ];
  if (
    result.persisted !== true ||
    result.canonicalRepositoryMutationPerformed !== false ||
    resolve(registration.canonicalPath) !== expectation.canonicalPath ||
    registration.branch !== "main" ||
    !SAFE_IDENTIFIER.test(registration.registrationId) ||
    registration.registrationId.length > 96 ||
    !hashes.every((value) => SHA256.test(value)) ||
    !objectIds.every((value) => GIT_OBJECT_ID.test(value)) ||
    registration.upstreamBaseCommit !== registration.upstreamVerification.mergeBaseCommit ||
    !Number.isFinite(Date.parse(registration.originVerification.checkedAt)) ||
    !Number.isFinite(Date.parse(registration.upstreamVerification.checkedAt)) ||
    registration.originVerification.private !== true ||
    registration.originVerification.fetchable !== true ||
    registration.originVerification.writable !== true ||
    registration.upstreamVerification.fetchable !== true ||
    (registration.originFingerprint.transport !== "https" &&
      registration.originFingerprint.transport !== "ssh") ||
    (registration.upstreamFingerprint.transport !== "https" &&
      registration.upstreamFingerprint.transport !== "ssh") ||
    registration.originFingerprint.repositoryHash ===
      registration.upstreamFingerprint.repositoryHash
  ) {
    throw new DarkFactoryCliError(
      "DF_COMMAND_FAILED",
      "Trusted harness registration returned an invalid persistence receipt.",
      70,
    );
  }
}

function safeRegistrationSummary(
  result: HarnessRegistrationResult,
): Readonly<Record<string, unknown>> {
  const registration = result.repository;
  return {
    command: "harness register",
    ok: true,
    persisted: result.persisted,
    canonicalRepositoryMutationPerformed: result.canonicalRepositoryMutationPerformed,
    registrationId: registration.registrationId,
    registrationContentHash: result.registrationContentHash,
    repository: "pi",
    branch: registration.branch,
    headCommit: registration.headCommit,
    treeSha: registration.treeSha,
    lockSha256: registration.lockSha256,
    upstreamBaseCommit: registration.upstreamBaseCommit,
    origin: {
      transport: registration.originFingerprint.transport,
      hostFingerprint: registration.originFingerprint.hostHash,
      repositoryFingerprint: registration.originFingerprint.repositoryHash,
      private: registration.originVerification.private,
      fetchable: registration.originVerification.fetchable,
      writable: registration.originVerification.writable,
      verificationAttestationHash: registration.originVerification.providerAttestationHash,
    },
    upstream: {
      transport: registration.upstreamFingerprint.transport,
      hostFingerprint: registration.upstreamFingerprint.hostHash,
      repositoryFingerprint: registration.upstreamFingerprint.repositoryHash,
      headCommit: registration.upstreamVerification.upstreamHeadCommit,
      fetchable: registration.upstreamVerification.fetchable,
      verificationAttestationHash: registration.upstreamVerification.providerAttestationHash,
    },
  };
}

function safeCampaignSummary(state: CampaignState): SafeCampaignSummary {
  const pointer = (
    value: CampaignState["champions"]["active"],
  ): CampaignState["champions"]["active"] => ({
    experimentNumber: value.experimentNumber,
    commit: value.commit,
    sourceSealHash: value.sourceSealHash,
  });
  return {
    campaignId: state.campaignId,
    revision: state.revision,
    stateHash: state.contentHash,
    protocolHash: state.protocolHash,
    status: state.control.status,
    runEpoch: state.control.runEpoch,
    numbering: {
      nextExperimentNumber: state.numbering.nextExperimentNumber,
      inFlightExperimentNumber: state.numbering.inFlightExperimentNumber,
      inFlightKind: state.numbering.inFlightKind,
      lastInterruptedExperimentNumber: state.numbering.lastInterruptedExperimentNumber,
    },
    champions: {
      baseline: pointer(state.champions.baseline),
      active: pointer(state.champions.active),
      certified: state.champions.certified === null ? null : pointer(state.champions.certified),
    },
    budget: {
      limits: {
        maximumUsd: state.budget.limits.maximumUsd,
        maximumTokens: state.budget.limits.maximumTokens,
        maximumWallTimeMs: state.budget.limits.maximumWallTimeMs,
        maximumAttempts: state.budget.limits.maximumAttempts,
        maximumPrivacyReleases: state.budget.limits.maximumPrivacyReleases,
        maximumPromotionLooks: state.budget.limits.maximumPromotionLooks,
        maximumOnlineError: state.budget.limits.maximumOnlineError,
      },
      usage: {
        spentUsd: state.budget.usage.spentUsd,
        tokens: state.budget.usage.tokens,
        wallTimeMs: state.budget.usage.wallTimeMs,
        attempts: state.budget.usage.attempts,
        privacyReleases: state.budget.usage.privacyReleases,
        promotionLooks: state.budget.usage.promotionLooks,
        onlineErrorSpent: state.budget.usage.onlineErrorSpent,
      },
    },
    holdout: {
      freshValidationSetsRemaining: state.holdout.freshValidationSetsRemaining,
      shadowSlicesRemaining: state.holdout.shadowSlicesRemaining,
      generation: state.holdout.generation,
    },
  };
}

function verifiedCampaignState(value: CampaignState): CampaignState {
  assertValidDocument("campaignState", value);
  return value;
}

function missingComposition(command: string, requirements: string): never {
  throw new DarkFactoryCliError(
    "DF_MISSING_COMPOSITION",
    `\`${command}\` is disabled until ${requirements} are configured. No workload was started.`,
    78,
  );
}

function repositoryExpectation(
  cwd: string,
  options: HarnessCommandOptions,
): RepositoryDoctorExpectation {
  const path = options.repository?.trim() || "../pi";
  const canonicalPath = resolve(cwd, path);
  if (canonicalPath !== resolve(cwd, "../pi")) {
    throw new DarkFactoryCliError(
      "DF_INVALID_INPUT",
      "Harness commands are restricted to the sibling Pi checkout at ../pi.",
      64,
    );
  }
  return {
    canonicalPath,
    expectedBranch: "main",
    expectedTrackingRemote: "origin",
  };
}

function campaignLocation(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  options: CampaignCommandOptions,
): { readonly campaignId: string; readonly stateRoot: string } {
  const campaignId = options.campaign?.trim() || environment["DF_CAMPAIGN_ID"]?.trim();
  const rawStateRoot = options.stateRoot?.trim() || environment["DF_CAMPAIGN_STATE_ROOT"]?.trim();
  if (campaignId === undefined || campaignId.length === 0) {
    throw new DarkFactoryCliError(
      "DF_MISSING_USER_INPUT",
      "Campaign id is required via --campaign or DF_CAMPAIGN_ID.",
      64,
    );
  }
  if (!SAFE_IDENTIFIER.test(campaignId) || campaignId.length > 96) {
    throw new DarkFactoryCliError(
      "DF_INVALID_INPUT",
      "Campaign id must be a lowercase safe identifier.",
      64,
    );
  }
  if (rawStateRoot === undefined || rawStateRoot.length === 0) {
    throw new DarkFactoryCliError(
      "DF_MISSING_USER_INPUT",
      "Campaign state root is required via --state-root or DF_CAMPAIGN_STATE_ROOT.",
      64,
    );
  }
  return {
    campaignId,
    stateRoot: resolve(cwd, rawStateRoot),
  };
}

function campaignStore(
  dependencies: DarkFactoryCliDependencies,
  location: { readonly campaignId: string; readonly stateRoot: string },
): CampaignControlStore {
  if (dependencies.createCampaignStore === undefined) {
    return missingComposition(
      "df campaign",
      "the signed campaign-state verifier and control-attestation verifier",
    );
  }
  return dependencies.createCampaignStore(location.stateRoot, location.campaignId);
}

function configureCampaignOptions(command: Command): Command {
  return command
    .option("--campaign <id>", "durable campaign identifier")
    .option("--state-root <path>", "trusted cloud-volume campaign-state root");
}

function overrideProcessExit(command: Command): void {
  command.exitOverride();
  for (const child of command.commands) {
    overrideProcessExit(child);
  }
}

function addStatusAction(
  command: Command,
  dependencies: DarkFactoryCliDependencies,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  output: CliOutput,
): void {
  configureCampaignOptions(command).action(async (options: CampaignCommandOptions) => {
    const location = campaignLocation(cwd, environment, options);
    const state = verifiedCampaignState(await campaignStore(dependencies, location).read());
    writeJson(output.writeOut, {
      command: "campaign status",
      ok: true,
      campaign: safeCampaignSummary(state),
    });
  });
}

function addStopAction(
  command: Command,
  dependencies: DarkFactoryCliDependencies,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  output: CliOutput,
): void {
  configureCampaignOptions(command).action(async (options: CampaignCommandOptions) => {
    const location = campaignLocation(cwd, environment, options);
    const store = campaignStore(dependencies, location);
    const current = verifiedCampaignState(await store.read());
    if (current.control.status === "stop-requested" || current.control.status === "stopped") {
      writeJson(output.writeOut, {
        command: "campaign stop",
        ok: true,
        changed: false,
        campaign: safeCampaignSummary(current),
      });
      return;
    }
    const next = verifiedCampaignState(await store.requestStop(current.contentHash, "operator"));
    writeJson(output.writeOut, {
      command: "campaign stop",
      ok: true,
      changed: true,
      campaign: safeCampaignSummary(next),
    });
  });
}

function addResumeAction(
  command: Command,
  dependencies: DarkFactoryCliDependencies,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  output: CliOutput,
): void {
  configureCampaignOptions(command)
    .option("--authorization-hash <sha256>", "one-use signed resume authorization digest")
    .action(async (options: CampaignCommandOptions) => {
      const authorizationHash = options.authorizationHash?.trim();
      if (authorizationHash === undefined || !SHA256.test(authorizationHash)) {
        throw new DarkFactoryCliError(
          "DF_MISSING_USER_INPUT",
          "A lowercase SHA-256 --authorization-hash is required to resume.",
          64,
        );
      }
      const location = campaignLocation(cwd, environment, options);
      const store = campaignStore(dependencies, location);
      const current = verifiedCampaignState(await store.read());
      if (current.control.status === "running") {
        writeJson(output.writeOut, {
          command: "campaign resume",
          ok: true,
          changed: false,
          authorizationConsumed: false,
          campaign: safeCampaignSummary(current),
        });
        return;
      }
      const next = verifiedCampaignState(
        await store.resume(current.contentHash, authorizationHash),
      );
      writeJson(output.writeOut, {
        command: "campaign resume",
        ok: true,
        changed: true,
        authorizationConsumed: true,
        campaign: safeCampaignSummary(next),
      });
    });
}

export function createDarkFactoryCli(dependencies: DarkFactoryCliDependencies = {}): Command {
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const environment = dependencies.environment ?? process.env;
  const output = dependencies.output ?? defaultOutput();
  const inspectRepository = dependencies.inspectRepository ?? defaultRepositoryInspector;
  const program = new Command();

  program
    .name("df")
    .description("Blind, cloud-only optimization control plane for terminal-agent harnesses.")
    .version("0.1.0")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: output.writeOut,
      writeErr: output.writeErr,
      outputError: (value, write) => {
        write(redactSensitiveText(value).slice(0, 1_000));
      },
    });

  program
    .command("doctor")
    .description("Report release-safe prerequisite presence without running a workload.")
    .action(async () => {
      writeJson(output.writeOut, await createDoctorReport(cwd, environment));
    });

  const harness = program
    .command("harness")
    .description("Inspect or register the private Pi harness.");
  harness
    .command("doctor")
    .description("Read-only inspection of the canonical private Pi worktree.")
    .argument("[repository]", "Pi repository path", "../pi")
    .action(async (repository: string) => {
      const expectation = repositoryExpectation(cwd, { repository });
      const report = await inspectRepository(expectation);
      assertSafeRepositoryReport(report, expectation);
      writeJson(output.writeOut, {
        command: "harness doctor",
        ok: true,
        report: safeRepositorySummary(report),
        mutationPerformed: false,
      });
    });
  harness
    .command("register")
    .description("Verify and persist a signed private-fork registration without mutating Pi.")
    .argument("[repository]", "Pi repository path", "../pi")
    .action(async (repository: string) => {
      if (dependencies.registerHarness === undefined) {
        return missingComposition(
          "df harness register",
          "a trusted cloud private-origin/upstream verifier and signed registration writer",
        );
      }
      const expectation = repositoryExpectation(cwd, { repository });
      const result = await dependencies.registerHarness(expectation);
      assertSafeRegistrationResult(result, expectation);
      writeJson(output.writeOut, safeRegistrationSummary(result));
    });

  const campaign = program
    .command("campaign")
    .description("Inspect or control an already initialized durable campaign.");
  addStatusAction(
    campaign.command("status").description("Reconstruct and summarize campaign state."),
    dependencies,
    cwd,
    environment,
    output,
  );
  addStopAction(
    campaign.command("stop").description("Request a graceful durable campaign stop."),
    dependencies,
    cwd,
    environment,
    output,
  );
  addResumeAction(
    campaign.command("resume").description("Resume from sealed durable state."),
    dependencies,
    cwd,
    environment,
    output,
  );

  addStatusAction(
    program.command("status").description("Alias for campaign status."),
    dependencies,
    cwd,
    environment,
    output,
  );
  addStopAction(
    program.command("stop").description("Alias for campaign stop."),
    dependencies,
    cwd,
    environment,
    output,
  );
  addResumeAction(
    program.command("resume").description("Alias for campaign resume."),
    dependencies,
    cwd,
    environment,
    output,
  );

  program
    .command("init")
    .description("Initialize a signed campaign control plane.")
    .action(() =>
      missingComposition(
        "df init",
        "operator authorizations, signed policy pins, and trusted campaign genesis",
      ),
    );

  const sandbox = program.command("sandbox").description("Trusted cloud sandbox controls.");
  sandbox
    .command("probe")
    .description("Probe a configured cloud sandbox provider.")
    .action(() =>
      missingComposition(
        "df sandbox probe",
        "a selected provider, exact credentials, and its verified transport adapter",
      ),
    );

  const baseline = program.command("baseline").description("Immutable baseline controls.");
  baseline
    .command("init")
    .description("Build and seal experiment 000 in the trusted cloud.")
    .action(() =>
      missingComposition(
        "df baseline init",
        "the registered harness, exact model and budget choices, trusted builder, broker, and evaluator",
      ),
    );

  program
    .command("optimize")
    .description("Run the adaptive Dark Factory optimization loop.")
    .action(() =>
      missingComposition(
        "df optimize",
        "Claude Code, Git publication, broker/evaluator, cloud execution, and signed campaign services",
      ),
    );

  const fullEvaluation = program
    .command("full-eval")
    .description("Human-gated official full-evaluation controls.");
  fullEvaluation
    .command("prepare")
    .description("Prepare a human-only one-use full-evaluation challenge.")
    .action(() =>
      missingComposition(
        "df full-eval prepare",
        "a frozen eligible candidate, complete compliance review, cost estimate, and human authorization store",
      ),
    );
  fullEvaluation
    .command("authorize")
    .argument("[challenge]", "one-use interactive challenge")
    .description("Authorize a prepared official evaluation.")
    .action((challenge: string | undefined) => {
      if (challenge === undefined || challenge.trim().length === 0) {
        throw new DarkFactoryCliError(
          "DF_MISSING_USER_INPUT",
          "A prepared one-use full-evaluation challenge is required.",
          64,
        );
      }
      return missingComposition(
        "df full-eval authorize",
        "an interactive TTY, matching prepared challenge, eligible protocol, and human-only authorization store",
      );
    });
  fullEvaluation
    .command("run")
    .description("Consume a one-use authorization and run the official protocol.")
    .action(() =>
      missingComposition(
        "df full-eval run",
        "a valid unconsumed human authorization and isolated official-evaluation runner",
      ),
    );

  overrideProcessExit(program);
  return program;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof DarkFactoryCliError) return error.message;
  if (error instanceof CommanderError) {
    return error.message.replace(/^error:\s*/u, "");
  }
  if (error instanceof RepositoryPolicyError) {
    return redactSensitiveText(error.message).slice(0, 1_000);
  }
  if (error instanceof CampaignControlError) {
    return "Campaign state verification or transition failed.";
  }
  if (error instanceof GitCommandError) {
    return "Read-only Git inspection failed.";
  }
  return "Dark Factory command failed.";
}

export async function runDarkFactoryCli(
  arguments_: readonly string[] = process.argv.slice(2),
  dependencies: DarkFactoryCliDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? defaultOutput();
  const program = createDarkFactoryCli({
    ...dependencies,
    output,
  });
  try {
    await program.parseAsync([...arguments_], { from: "user" });
    return 0;
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" || error.code === "commander.version")
    ) {
      return 0;
    }
    const cliError = error instanceof DarkFactoryCliError ? error : undefined;
    writeJson(output.writeErr, {
      ok: false,
      error: {
        code:
          cliError?.code ?? (error instanceof CommanderError ? "DF_USAGE" : "DF_COMMAND_FAILED"),
        message: safeErrorMessage(error),
      },
    });
    return cliError?.exitCode ?? (error instanceof CommanderError ? 64 : 70);
  }
}

function isExecutedEntrypoint(): boolean {
  const executable = process.argv[1];
  return executable !== undefined && import.meta.url === pathToFileURL(resolve(executable)).href;
}

if (isExecutedEntrypoint()) {
  void runDarkFactoryCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
