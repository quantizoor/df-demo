#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";

import { type DockerProbeReport, inspectLocalDoctor, type LocalDoctorReport } from "./doctor.js";
import {
  type InitializeLocalRealCampaignInput,
  type InitializeLocalRealCampaignResult,
  initializeLocalRealOptimization,
} from "./real/config.js";
import { createNativeLocalRealAdapter } from "./real/native-adapter.js";
import {
  type LocalRealRunOptions,
  type LocalRealRunResult,
  runLocalRealCampaign,
} from "./real/runner.js";
import { loadLocalRealCampaign, requestLocalRealStop } from "./real/state.js";
import {
  type LocalCampaignWatchdogOptions,
  type LocalCampaignWatchdogResult,
  runLocalCampaignWatchdog,
} from "./real/watchdog.js";
import {
  type LocalRunDependencies,
  type LocalRunResult,
  runLocalSyntheticCampaign,
} from "./runtime.js";
import { type LocalStatus, readLocalStatus, resolveLocalStateRoot } from "./state.js";

export interface LocalCliOutput {
  readonly writeOut: (value: string) => void;
  readonly writeErr: (value: string) => void;
}

export interface LocalCliDependencies extends LocalRunDependencies {
  readonly cwd?: string;
  readonly output?: LocalCliOutput;
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly probeDocker?: () => Promise<DockerProbeReport>;
  readonly initializeReal?: (
    input: InitializeLocalRealCampaignInput,
  ) => Promise<InitializeLocalRealCampaignResult>;
  readonly runReal?: (input: LocalRealRunOptions) => Promise<LocalRealRunResult>;
  readonly runRealWatchdog?: (
    input: LocalCampaignWatchdogOptions,
  ) => Promise<LocalCampaignWatchdogResult>;
}

interface LocalCliOptions {
  readonly stateRoot?: string;
}

interface LocalRealInitOptions {
  readonly campaign: string;
  readonly piRepo?: string;
  readonly credentialsFile?: string;
  readonly claudeExecutable?: string;
  readonly maxCampaignCostUsd?: string;
  readonly allowUnboundedCost?: boolean;
}

interface LocalRealCampaignOptions {
  readonly campaign: string;
  readonly once?: boolean;
  readonly cancelActive?: boolean;
}

interface LocalRealWatchdogOptions {
  readonly campaign: string;
  readonly projectRoot?: string;
}

class LocalCliError extends Error {
  public readonly exitCode: number;

  public constructor(message: string, exitCode: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalCliError";
    this.exitCode = exitCode;
  }
}

function defaultOutput(): LocalCliOutput {
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

export function createLocalCli(
  dependencies: LocalCliDependencies = {},
  reportExitCode: (exitCode: number) => void = () => undefined,
): Command {
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const output = dependencies.output ?? defaultOutput();
  const program = new Command();
  program
    .name("df-local")
    .description("Run the deterministic Dark Factory MVP entirely on this machine.")
    .option("--state-root <absolute-path>", "absolute local state root (default: <cwd>/.df/local)")
    .exitOverride()
    .configureOutput({
      writeOut: output.writeOut,
      // Commander writes its diagnostic before exitOverride throws. Suppress
      // that copy so runLocalCli can emit one machine-readable error document.
      writeErr: () => undefined,
    })
    .action(async (options: LocalCliOptions) => {
      const result = await executeRun(options, cwd, dependencies);
      writeJson(output.writeOut, result);
    });

  program
    .command("run")
    .description("Run one fully local deterministic no-model MVP campaign.")
    .action(async (_options, command) => {
      const options = command.optsWithGlobals() as LocalCliOptions;
      const result = await executeRun(options, cwd, dependencies);
      writeJson(output.writeOut, result);
    });

  program
    .command("doctor")
    .description("Check local synthetic readiness and optional Docker availability.")
    .action(async (_options, command) => {
      const options = command.optsWithGlobals() as LocalCliOptions;
      const stateRoot = localStateRoot(cwd, options.stateRoot);
      const report = await inspectLocalDoctor({
        cwd,
        stateRoot,
        ...(dependencies.nodeVersion === undefined
          ? {}
          : { nodeVersion: dependencies.nodeVersion }),
        ...(dependencies.platform === undefined ? {} : { platform: dependencies.platform }),
        ...(dependencies.architecture === undefined
          ? {}
          : { architecture: dependencies.architecture }),
        ...(dependencies.probeDocker === undefined
          ? {}
          : { probeDocker: dependencies.probeDocker }),
      });
      writeJson(output.writeOut, report);
      if (!report.ok) reportExitCode(1);
    });

  program
    .command("status")
    .description("Show the latest retained local run, or report that none exists.")
    .action(async (_options, command) => {
      const options = command.optsWithGlobals() as LocalCliOptions;
      const stateRoot = localStateRoot(cwd, options.stateRoot);
      const status = await readLocalStatus(stateRoot);
      writeJson(output.writeOut, status);
    });

  const real = program
    .command("real")
    .description("Run the resumable Pi/Terminal-Bench optimization loop on this machine.");

  real
    .command("init")
    .description("Initialize a durable real campaign and bootstrap its task catalog.")
    .requiredOption("--campaign <id>", "lowercase campaign identifier")
    .option("--pi-repo <absolute-path>", "Pi checkout (default: ../df-pi-tbench)")
    .option(
      "--credentials-file <absolute-path>",
      "mode-0600 Foundry env file (default: <state-root>/config/foundry.env)",
    )
    .option(
      "--claude-executable <absolute-path>",
      "Claude Code executable (default: <state-root>/tools/claude/node_modules/.bin/claude)",
    )
    .option("--max-campaign-cost-usd <amount>", "positive campaign-wide cost ceiling")
    .option("--allow-unbounded-cost", "explicitly authorize no campaign-wide cost ceiling", false)
    .action(async (options: LocalRealInitOptions, command) => {
      const globals = command.optsWithGlobals() as LocalCliOptions;
      const stateRoot = localStateRoot(cwd, globals.stateRoot);
      const maximumCampaignCostUsd =
        options.maxCampaignCostUsd === undefined
          ? undefined
          : positiveNumber(options.maxCampaignCostUsd, "campaign cost limit");
      const result = await (dependencies.initializeReal ?? initializeLocalRealOptimization)({
        stateRoot,
        campaignId: options.campaign,
        piRepository: absoluteOverride(
          options.piRepo,
          resolve(cwd, "../df-pi-tbench"),
          "Pi repository",
        ),
        credentialsFile: absoluteOverride(
          options.credentialsFile,
          resolve(stateRoot, "config/foundry.env"),
          "credentials file",
        ),
        claudeExecutable: absoluteOverride(
          options.claudeExecutable,
          resolve(stateRoot, "tools/claude/node_modules/.bin/claude"),
          "Claude executable",
        ),
        ...(maximumCampaignCostUsd === undefined ? {} : { maximumCampaignCostUsd }),
        ...(options.allowUnboundedCost === true ? { allowUnboundedCost: true } : {}),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      });
      writeJson(output.writeOut, result);
    });

  for (const commandName of ["run", "resume"] as const) {
    real
      .command(commandName)
      .description(
        commandName === "run"
          ? "Run indefinitely in the foreground until stopped or blocked."
          : "Clear a prior stop request and resume the durable foreground loop.",
      )
      .requiredOption("--campaign <id>", "campaign identifier")
      .option("--once", "complete at most one experiment, then stop", false)
      .action(async (options: LocalRealCampaignOptions, command) => {
        const globals = command.optsWithGlobals() as LocalCliOptions;
        const stateRoot = localStateRoot(cwd, globals.stateRoot);
        let interrupted = false;
        const requestStop = (): void => {
          interrupted = true;
        };
        process.once("SIGINT", requestStop);
        process.once("SIGTERM", requestStop);
        try {
          const result = await (dependencies.runReal ?? runLocalRealCampaign)({
            stateRoot,
            campaignId: options.campaign,
            adapter: createNativeLocalRealAdapter(),
            shouldStop: () => interrupted,
            ...(options.once === true ? { maximumCompletedExperiments: 1 } : {}),
            ...(commandName === "resume" ? { resume: true } : {}),
            ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
          });
          writeJson(output.writeOut, result);
          if (result.status === "blocked") reportExitCode(1);
        } finally {
          process.removeListener("SIGINT", requestStop);
          process.removeListener("SIGTERM", requestStop);
        }
      });
  }

  real
    .command("watchdog")
    .description("Supervise a running campaign without auto-resuming stopped or blocked work.")
    .requiredOption("--campaign <id>", "campaign identifier")
    .option("--project-root <absolute-path>", "project root containing dist/local/cli.js")
    .action(async (options: LocalRealWatchdogOptions, command) => {
      const globals = command.optsWithGlobals() as LocalCliOptions;
      const stateRoot = localStateRoot(cwd, globals.stateRoot);
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        const result = await (dependencies.runRealWatchdog ?? runLocalCampaignWatchdog)({
          projectRoot: absoluteOverride(options.projectRoot, cwd, "project root"),
          stateRoot,
          campaignId: options.campaign,
          signal: controller.signal,
        });
        writeJson(output.writeOut, result);
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
    });

  real
    .command("status")
    .description("Read the durable state of a real campaign.")
    .requiredOption("--campaign <id>", "campaign identifier")
    .action(async (options: LocalRealCampaignOptions, command) => {
      const globals = command.optsWithGlobals() as LocalCliOptions;
      const stateRoot = localStateRoot(cwd, globals.stateRoot);
      const campaign = await loadLocalRealCampaign(stateRoot, options.campaign);
      writeJson(output.writeOut, {
        command: "real-status",
        campaignId: options.campaign,
        campaignDirectory: campaign.paths.root,
        state: campaign.state,
        taskCount: campaign.catalog.tasks.length,
        modelBindings: {
          optimizer: campaign.config.optimizer.deployment,
          evaluatedAgent: campaign.config.evaluatedAgent.deployment,
        },
        publication: campaign.config.publication,
        containsSecrets: false,
      });
    });

  real
    .command("stop")
    .description("Request a stop at a safe boundary, or cancel the active external process.")
    .requiredOption("--campaign <id>", "campaign identifier")
    .option(
      "--cancel-active",
      "cancel the active optimizer, validation, or evaluator process",
      false,
    )
    .action(async (options: LocalRealCampaignOptions, command) => {
      const globals = command.optsWithGlobals() as LocalCliOptions;
      const stateRoot = localStateRoot(cwd, globals.stateRoot);
      const campaign = await loadLocalRealCampaign(stateRoot, options.campaign);
      const requestedAt = (dependencies.now ?? (() => new Date()))().toISOString();
      await requestLocalRealStop(
        campaign.paths,
        requestedAt,
        "operator-requested",
        options.cancelActive === true ? "cancel-active" : "after-phase",
      );
      writeJson(output.writeOut, {
        command: "real-stop",
        status: "requested",
        campaignId: options.campaign,
        requestedAt,
        mode: options.cancelActive === true ? "cancel-active" : "after-phase",
        containsSecrets: false,
      });
    });

  return program;
}

export async function runLocalCli(
  arguments_: readonly string[],
  dependencies: LocalCliDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? defaultOutput();
  let exitCode = 0;
  const program = createLocalCli(dependencies, (reported) => {
    exitCode = Math.max(exitCode, reported);
  });
  try {
    await program.parseAsync([...arguments_], { from: "user" });
    return exitCode;
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" || error.code === "commander.version")
    ) {
      return 0;
    }
    const cliError = normalizeCliError(error);
    writeJson(output.writeErr, {
      command: "error",
      code: cliError.exitCode === 64 ? "DF_LOCAL_USAGE" : "DF_LOCAL_COMMAND_FAILED",
      message: cliError.message,
    });
    return cliError.exitCode;
  }
}

async function executeRun(
  options: LocalCliOptions,
  cwd: string,
  dependencies: LocalCliDependencies,
): Promise<LocalRunResult> {
  const stateRoot = localStateRoot(cwd, options.stateRoot);
  return runLocalSyntheticCampaign(stateRoot, {
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.runSynthetic === undefined ? {} : { runSynthetic: dependencies.runSynthetic }),
  });
}

function localStateRoot(cwd: string, override: string | undefined): string {
  try {
    return resolveLocalStateRoot(cwd, override);
  } catch (error) {
    throw new LocalCliError(
      error instanceof Error ? error.message : "Local state root is invalid",
      64,
      { cause: error },
    );
  }
}

function absoluteOverride(value: string | undefined, fallback: string, label: string): string {
  const selected = value ?? fallback;
  if (!selected.startsWith("/")) {
    throw new LocalCliError(`${label} must be an absolute path`, 64);
  }
  return resolve(selected);
}

function positiveNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new LocalCliError(`${label} must be a positive number`, 64);
  }
  return parsed;
}

function normalizeCliError(error: unknown): LocalCliError {
  if (error instanceof LocalCliError) return error;
  if (error instanceof CommanderError) {
    return new LocalCliError(safeCommanderMessage(error), 64, { cause: error });
  }
  return new LocalCliError(
    error instanceof Error ? safeFailureMessage(error.message) : "Local command failed",
    70,
    { cause: error },
  );
}

function safeCommanderMessage(error: CommanderError): string {
  return safeFailureMessage(error.message.replace(/^error:\s*/u, ""));
}

function safeFailureMessage(message: string): string {
  const firstLine = message.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return "Local command failed";
  return firstLine.slice(0, 512);
}

export function isDirectExecution(
  entrypoint: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  if (entrypoint === undefined) return false;
  try {
    return realpathSync(resolve(entrypoint)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  process.exitCode = await runLocalCli(process.argv.slice(2));
}

export type { LocalDoctorReport, LocalRunResult, LocalStatus };
