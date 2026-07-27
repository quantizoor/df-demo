import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, parse, resolve } from "node:path";

import { redactSensitiveText } from "../../harness/git.js";

const OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CAMPAIGN_ID = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/u;
const EXPERIMENT_ID = /^[0-9]{3,8}-[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/u;
const COMMIT_MESSAGE = /^(?:feat|fix|docs)(?:\((?:ai|tui|agent|coding-agent)\))?: .+$/u;
const MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 2 * 60_000;

export type LocalGitPublicationDecision = "promoted" | "rejected" | "inconclusive";

export interface LocalGitPublicationInput {
  readonly decision: LocalGitPublicationDecision;
  readonly campaignId: string;
  readonly experimentId: string;
  readonly candidateWorktree: string;
  readonly remoteName: string;
  readonly parentCommit: string;
  readonly evaluatedTree: string;
  readonly commitMessage: string;
  readonly commitTimestamp: string;
  readonly decisionHash: string;
}

export interface LocalGitCommand {
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin: string | null;
  readonly timeoutMs: number;
}

export interface LocalGitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type LocalGitExecutor = (command: LocalGitCommand) => Promise<LocalGitCommandResult>;

export interface LocalGitPublicationIntent {
  readonly domain: "dark-factory.local-git-publication-intent.v1";
  readonly schemaVersion: 1;
  readonly intentId: string;
  readonly campaignId: string;
  readonly experimentId: string;
  readonly decisionHash: string;
  readonly parentCommit: string;
  readonly evaluatedTree: string;
  readonly candidateCommit: string;
  readonly commitMessage: string;
  readonly commitTimestamp: string;
  readonly remoteName: string;
  readonly experimentRef: string;
  readonly championRef: string;
  readonly publicationMode: "atomic-non-force";
  readonly containsSecrets: false;
}

export type PersistLocalGitPublicationIntent = (intent: LocalGitPublicationIntent) => Promise<void>;

export interface LocalGitPublicationDependencies {
  readonly executeGit?: LocalGitExecutor;
  readonly persistIntent: PersistLocalGitPublicationIntent;
}

export type LocalGitPublicationResult =
  | {
      readonly status: "not-promoted";
      readonly decision: Exclude<LocalGitPublicationDecision, "promoted">;
      readonly campaignId: string;
      readonly experimentId: string;
    }
  | {
      readonly status: "published";
      readonly disposition: "published" | "already-published";
      readonly recoveredAfterPushError: boolean;
      readonly intent: LocalGitPublicationIntent;
    };

export class LocalGitPublicationError extends Error {
  override readonly name = "LocalGitPublicationError";
  readonly code:
    | "INVALID_INPUT"
    | "GIT_COMMAND_FAILED"
    | "RUNNER_WORKTREE_INVALID"
    | "REMOTE_CONFLICT"
    | "REMOTE_VERIFICATION_FAILED";

  constructor(code: LocalGitPublicationError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

interface RemotePublicationState {
  readonly experimentCommit: string | null;
  readonly championCommit: string | null;
}

function canonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function assertInput(input: LocalGitPublicationInput): void {
  const worktree = resolve(input.candidateWorktree);
  if (
    !CAMPAIGN_ID.test(input.campaignId) ||
    !EXPERIMENT_ID.test(input.experimentId) ||
    !isAbsolute(input.candidateWorktree) ||
    worktree === parse(worktree).root ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.remoteName) ||
    !OBJECT_ID.test(input.parentCommit) ||
    !OBJECT_ID.test(input.evaluatedTree) ||
    !COMMIT_MESSAGE.test(input.commitMessage) ||
    input.commitMessage.includes("\0") ||
    input.commitMessage.includes("\r") ||
    input.commitMessage.includes("\n") ||
    Buffer.byteLength(input.commitMessage, "utf8") > 512 ||
    !canonicalTimestamp(input.commitTimestamp) ||
    !SHA256.test(input.decisionHash)
  ) {
    throw new LocalGitPublicationError("INVALID_INPUT", "Local Git publication input is invalid.");
  }
}

function safeEnvironment(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  for (const name of [
    "HOME",
    "LOGNAME",
    "PATH",
    "SSH_AUTH_SOCK",
    "TMPDIR",
    "USER",
    "XDG_CONFIG_HOME",
  ] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...overrides };
}

export function executeLocalGitCommand(command: LocalGitCommand): Promise<LocalGitCommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn("git", command.arguments, {
      cwd: command.workingDirectory,
      env: safeEnvironment(command.environment),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let settled = false;

    const finish = (result: LocalGitCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const append = (target: "stdout" | "stderr", chunk: unknown): void => {
      const value = String(chunk);
      outputBytes += Buffer.byteLength(value);
      if (outputBytes > MAXIMUM_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      if (target === "stdout") stdout += value;
      else stderr += value;
    };
    child.stdout.on("data", (chunk: unknown) => append("stdout", chunk));
    child.stderr.on("data", (chunk: unknown) => append("stderr", chunk));
    child.once("error", (error) => {
      finish({
        exitCode: 71,
        stdout: "",
        stderr: `Unable to start Git: ${error.message}`,
      });
    });
    child.once("close", (code) => {
      if (outputExceeded) {
        finish({
          exitCode: 75,
          stdout: "",
          stderr: "Git output exceeded the configured limit.",
        });
        return;
      }
      if (timedOut) {
        finish({
          exitCode: 124,
          stdout: "",
          stderr: "Git command exceeded its timeout.",
        });
        return;
      }
      finish({
        exitCode: code ?? 70,
        stdout,
        stderr,
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, command.timeoutMs);
    if (command.stdin === null) child.stdin.end();
    else child.stdin.end(command.stdin, "utf8");
  });
}

async function git(
  execute: LocalGitExecutor,
  workingDirectory: string,
  arguments_: readonly string[],
  input: {
    readonly environment?: Readonly<Record<string, string>>;
    readonly stdin?: string;
  } = {},
): Promise<string> {
  const result = await execute({
    arguments: [...arguments_],
    workingDirectory,
    environment: input.environment ?? {},
    stdin: input.stdin ?? null,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    const detail = redactSensitiveText(result.stderr || result.stdout)
      .trim()
      .slice(0, 512);
    throw new LocalGitPublicationError(
      "GIT_COMMAND_FAILED",
      detail.length === 0 ? "Git command failed." : `Git command failed: ${detail}`,
    );
  }
  return result.stdout.trim();
}

async function assertRunnerWorktree(
  input: LocalGitPublicationInput,
  execute: LocalGitExecutor,
): Promise<void> {
  const worktree = resolve(input.candidateWorktree);
  const topLevel = resolve(await git(execute, worktree, ["rev-parse", "--show-toplevel"]));
  const head = await git(execute, worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const branch = await git(execute, worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const indexTree = await git(execute, worktree, ["write-tree"]);
  if (
    topLevel !== worktree ||
    head !== input.parentCommit ||
    branch !== "HEAD" ||
    indexTree !== input.evaluatedTree
  ) {
    throw new LocalGitPublicationError(
      "RUNNER_WORKTREE_INVALID",
      "Candidate worktree does not match the evaluated parent and tree.",
    );
  }
}

async function createDeterministicCommit(
  input: LocalGitPublicationInput,
  execute: LocalGitExecutor,
): Promise<string> {
  const environment = {
    GIT_AUTHOR_NAME: "Dark Factory",
    GIT_AUTHOR_EMAIL: "dark-factory@invalid",
    GIT_AUTHOR_DATE: input.commitTimestamp,
    GIT_COMMITTER_NAME: "Dark Factory",
    GIT_COMMITTER_EMAIL: "dark-factory@invalid",
    GIT_COMMITTER_DATE: input.commitTimestamp,
  };
  const commit = await git(
    execute,
    resolve(input.candidateWorktree),
    ["commit-tree", input.evaluatedTree, "-p", input.parentCommit],
    {
      environment,
      stdin: `${input.commitMessage}\n`,
    },
  );
  if (!OBJECT_ID.test(commit)) {
    throw new LocalGitPublicationError(
      "GIT_COMMAND_FAILED",
      "Git returned an invalid candidate commit.",
    );
  }
  const tree = await git(execute, resolve(input.candidateWorktree), [
    "rev-parse",
    "--verify",
    `${commit}^{tree}`,
  ]);
  const lineage = (
    await git(execute, resolve(input.candidateWorktree), [
      "rev-list",
      "--parents",
      "--max-count=1",
      commit,
    ])
  ).split(/\s+/u);
  if (
    tree !== input.evaluatedTree ||
    lineage.length !== 2 ||
    lineage[0] !== commit ||
    lineage[1] !== input.parentCommit
  ) {
    throw new LocalGitPublicationError(
      "GIT_COMMAND_FAILED",
      "Candidate commit does not bind the evaluated tree and parent.",
    );
  }
  return commit;
}

function publicationIntent(
  input: LocalGitPublicationInput,
  candidateCommit: string,
): LocalGitPublicationIntent {
  const document = {
    campaignId: input.campaignId,
    experimentId: input.experimentId,
    decisionHash: input.decisionHash,
    parentCommit: input.parentCommit,
    evaluatedTree: input.evaluatedTree,
    candidateCommit,
    commitMessage: input.commitMessage,
    commitTimestamp: input.commitTimestamp,
    remoteName: input.remoteName,
    experimentRef: `refs/heads/df/experiment/${input.campaignId}/${input.experimentId}`,
    championRef: `refs/heads/df/champion/${input.campaignId}`,
    publicationMode: "atomic-non-force" as const,
    containsSecrets: false as const,
  };
  return {
    domain: "dark-factory.local-git-publication-intent.v1",
    schemaVersion: 1,
    intentId: `local-git-publication-${createHash("sha256")
      .update(JSON.stringify(document))
      .digest("hex")
      .slice(0, 48)}`,
    ...document,
  };
}

function parseRemoteState(raw: string, intent: LocalGitPublicationIntent): RemotePublicationState {
  let experimentCommit: string | null = null;
  let championCommit: string | null = null;
  for (const line of raw.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const [commit, ref, ...extra] = line.split(/\s+/u);
    if (commit === undefined || ref === undefined || extra.length > 0 || !OBJECT_ID.test(commit)) {
      throw new LocalGitPublicationError(
        "REMOTE_VERIFICATION_FAILED",
        "Remote Git reference output is invalid.",
      );
    }
    if (ref === intent.experimentRef && experimentCommit === null) {
      experimentCommit = commit;
      continue;
    }
    if (ref === intent.championRef && championCommit === null) {
      championCommit = commit;
      continue;
    }
    throw new LocalGitPublicationError(
      "REMOTE_VERIFICATION_FAILED",
      "Remote Git reference output is ambiguous.",
    );
  }
  return { experimentCommit, championCommit };
}

async function remoteState(
  input: LocalGitPublicationInput,
  intent: LocalGitPublicationIntent,
  execute: LocalGitExecutor,
): Promise<RemotePublicationState> {
  return parseRemoteState(
    await git(execute, resolve(input.candidateWorktree), [
      "ls-remote",
      "--refs",
      input.remoteName,
      intent.experimentRef,
      intent.championRef,
    ]),
    intent,
  );
}

function publicationComplete(state: RemotePublicationState, candidateCommit: string): boolean {
  return state.experimentCommit === candidateCommit && state.championCommit === candidateCommit;
}

function assertRemoteReady(state: RemotePublicationState, intent: LocalGitPublicationIntent): void {
  if (
    state.experimentCommit !== null ||
    (state.championCommit !== null && state.championCommit !== intent.parentCommit)
  ) {
    throw new LocalGitPublicationError(
      "REMOTE_CONFLICT",
      "Remote experiment or champion reference has conflicting content.",
    );
  }
}

export async function publishLocalGitChampion(
  input: LocalGitPublicationInput,
  dependencies: LocalGitPublicationDependencies,
): Promise<LocalGitPublicationResult> {
  if (input.decision !== "promoted") {
    if (input.decision !== "rejected" && input.decision !== "inconclusive") {
      throw new LocalGitPublicationError(
        "INVALID_INPUT",
        "Local Git publication decision is invalid.",
      );
    }
    return {
      status: "not-promoted",
      decision: input.decision,
      campaignId: input.campaignId,
      experimentId: input.experimentId,
    };
  }

  assertInput(input);
  const execute = dependencies.executeGit ?? executeLocalGitCommand;
  await assertRunnerWorktree(input, execute);
  const candidateCommit = await createDeterministicCommit(input, execute);
  const intent = publicationIntent(input, candidateCommit);
  await dependencies.persistIntent(intent);

  const before = await remoteState(input, intent, execute);
  if (publicationComplete(before, candidateCommit)) {
    return {
      status: "published",
      disposition: "already-published",
      recoveredAfterPushError: false,
      intent,
    };
  }
  assertRemoteReady(before, intent);

  let pushFailure: unknown;
  try {
    await git(execute, resolve(input.candidateWorktree), [
      "push",
      "--atomic",
      "--porcelain",
      input.remoteName,
      `${candidateCommit}:${intent.experimentRef}`,
      `${candidateCommit}:${intent.championRef}`,
    ]);
  } catch (error) {
    pushFailure = error;
  }

  let after: RemotePublicationState;
  try {
    after = await remoteState(input, intent, execute);
  } catch (error) {
    if (pushFailure !== undefined) throw pushFailure;
    throw error;
  }
  if (publicationComplete(after, candidateCommit)) {
    return {
      status: "published",
      disposition: "published",
      recoveredAfterPushError: pushFailure !== undefined,
      intent,
    };
  }
  if (pushFailure !== undefined) throw pushFailure;
  throw new LocalGitPublicationError(
    "REMOTE_VERIFICATION_FAILED",
    "Atomic Git push did not publish the exact experiment and champion refs.",
  );
}
