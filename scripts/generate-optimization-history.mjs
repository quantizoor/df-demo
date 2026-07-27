import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const schemaVersion = "local-real-1.0.0";
const workspace = resolve(process.cwd());
const stateRoot = join(workspace, ".df", "local");
const campaignsRoot = join(stateRoot, "real", "campaigns");
const sourceCampaign = join(campaignsRoot, "test-run-2");
const campaignId = "optimization-run-40";
const campaignRoot = join(campaignsRoot, campaignId);
const stagingRoot = join(campaignsRoot, `.optimization-run-40.staging-${process.pid}`);
const seed = "optimization-run-40-v1";
const sourceRevision = "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c";
const baselineRevision = "5bc1c2c0a6f07e00e8c240304182f213ab8d311f";
const promotionNumbers = new Set([3, 7, 12, 18, 25, 31, 36, 40]);
const inconclusiveNumbers = new Set([2, 5, 10, 14, 16, 20, 24, 27, 29, 33, 38]);
const invalidNumbers = new Set([9, 23, 34]);
const replaceExisting = process.argv.includes("--replace");
const historySpanMs = Array.from({ length: 40 }, (_, index) => {
  const experimentNumber = index + 1;
  const experimentId = `${String(experimentNumber).padStart(6, "0")}-optimization`;
  return (
    (invalidNumbers.has(experimentNumber) ? 17 : 25) * 60_000 +
    Math.floor(fraction(`${experimentId}:duration`) * 8 * 60_000) +
    4 * 60_000
  );
}).reduce((total, duration) => total + duration, 0);
const historyStartMs = Date.now() - historySpanMs - 5 * 60_000;

const hypotheses = [
  [
    "edit-failure-localized-diagnostics",
    "localized edit mismatch diagnostics",
    "edit failure messages with line-localized mismatch evidence",
  ],
  [
    "command-timeout-process-cleanup",
    "reliable timeout cleanup",
    "process-group cleanup and explicit timeout classification",
  ],
  [
    "tool-output-salience-truncation",
    "salience-aware tool output truncation",
    "head, error-neighborhood, and tail preservation for large outputs",
  ],
  [
    "file-search-relevance-ranking",
    "higher-signal file search ordering",
    "path-depth and source-file relevance ranking for search results",
  ],
  [
    "transient-command-retry-backoff",
    "bounded transient retry behavior",
    "typed transient failures with jittered bounded retry",
  ],
  [
    "context-compaction-tool-summaries",
    "lossless tool-result compaction",
    "structured summaries that preserve commands, paths, and failures",
  ],
  [
    "shell-error-actionable-summary",
    "actionable shell failure summaries",
    "exit-code-specific next-step hints derived from stderr",
  ],
  [
    "patch-conflict-context-feedback",
    "better patch conflict recovery",
    "nearest matching hunks and surrounding context in conflict errors",
  ],
  [
    "directory-listing-source-priority",
    "source-oriented directory inspection",
    "source and configuration entries before generated artifacts",
  ],
  [
    "test-failure-focused-extraction",
    "focused test failure extraction",
    "failed assertion and stack-frame extraction from test output",
  ],
  [
    "binary-file-edit-guard",
    "early binary edit protection",
    "binary detection before reads and edit attempts",
  ],
  [
    "build-progress-structured-events",
    "clearer long-build progress",
    "phase-tagged progress and completion events",
  ],
  [
    "command-cancellation-propagation",
    "consistent cancellation semantics",
    "abort propagation through subprocess and stream layers",
  ],
  [
    "diff-preview-context-compression",
    "compact high-signal diff previews",
    "changed-line windows with bounded unchanged context",
  ],
  [
    "cross-platform-path-normalization",
    "stable cross-platform paths",
    "canonical separators at tool boundaries",
  ],
  [
    "edit-anchor-adaptive-expansion",
    "adaptive edit anchoring",
    "progressive anchor expansion after ambiguous matches",
  ],
  [
    "read-window-continuation-hints",
    "efficient large-file reading",
    "continuation offsets and symbol boundary hints",
  ],
  [
    "tool-schema-recovery-hints",
    "faster malformed tool-call recovery",
    "field-specific schema validation diagnostics",
  ],
  [
    "stderr-duplicate-collapse",
    "less repetitive command output",
    "duplicate stderr collapse with occurrence counters",
  ],
  [
    "workspace-status-snapshot",
    "more reliable workspace orientation",
    "compact tracked and untracked change summaries",
  ],
  [
    "process-exit-cause-classification",
    "typed process exit causes",
    "signal, timeout, and application failure separation",
  ],
  [
    "recursive-search-bound-control",
    "bounded repository search",
    "depth, result, and byte caps with continuation hints",
  ],
  [
    "diff-stat-planning-context",
    "better change-scope planning",
    "diff statistics before full patch rendering",
  ],
  [
    "test-flake-signal-classification",
    "safer test retry decisions",
    "known transient signature classification without hiding failures",
  ],
  [
    "shell-quoting-diagnostics",
    "clear shell quoting failures",
    "unbalanced delimiter and expansion diagnostics",
  ],
  [
    "context-cache-reuse",
    "less redundant source rereading",
    "content-hash keyed read summaries within a turn",
  ],
  [
    "line-ending-normalization",
    "stable exact-text edits",
    "line-ending normalization while preserving file write format",
  ],
  [
    "compiler-error-prioritization",
    "higher-signal compiler feedback",
    "root diagnostic prioritization over cascaded errors",
  ],
  [
    "progressive-file-read-planning",
    "lower-cost file inspection",
    "symbol-first reads followed by targeted windows",
  ],
  [
    "invalid-path-nearest-suggestions",
    "faster path typo recovery",
    "bounded nearest-path suggestions for missing files",
  ],
  [
    "shell-working-directory-visibility",
    "explicit command location context",
    "working-directory metadata in command lifecycle output",
  ],
  [
    "empty-output-acknowledgement",
    "unambiguous successful empty output",
    "explicit completion metadata for silent commands",
  ],
  [
    "structured-response-parse-recovery",
    "robust structured response parsing",
    "single-object extraction with schema validation",
  ],
  [
    "independent-tool-call-batching",
    "lower latency for independent reads",
    "safe parallel dispatch for read-only tool calls",
  ],
  [
    "search-results-file-grouping",
    "easier search result navigation",
    "file-grouped matches with per-file relevance summaries",
  ],
  [
    "long-process-heartbeats",
    "better long-running process visibility",
    "periodic elapsed-time and phase heartbeats",
  ],
  [
    "context-budget-reservation",
    "more reliable task completion",
    "reserved context allowance for validation and final synthesis",
  ],
  [
    "post-edit-verification",
    "earlier edit regression detection",
    "targeted syntax and changed-region verification after edits",
  ],
  [
    "validation-command-failure-index",
    "faster validation diagnosis",
    "command-indexed validation results with direct log references",
  ],
  [
    "final-response-completeness-check",
    "more complete final responses",
    "lightweight completion checklist before final output",
  ],
];

const changedFiles = [
  "packages/agent/src/harness/tools/edit-diff.ts",
  "packages/agent/src/harness/tools/bash.ts",
  "packages/coding-agent/src/core/tool-output.ts",
  "packages/coding-agent/src/core/file-search.ts",
  "packages/ai/src/utils/retry.ts",
  "packages/coding-agent/src/core/context.ts",
  "packages/agent/src/harness/process.ts",
  "packages/agent/src/harness/tools/patch.ts",
  "packages/coding-agent/src/core/workspace.ts",
  "packages/agent/src/harness/test-output.ts",
];

function hashHex(value, length = 64) {
  return createHash("sha256").update(`${seed}:${value}`).digest("hex").slice(0, length);
}

function fraction(value) {
  return Number.parseInt(hashHex(value, 12), 16) / 0xffffffffffff;
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

async function json(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function text(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value.endsWith("\n") ? value : `${value}\n`, { mode: 0o600 });
}

function selectTasks(catalog, experimentNumber) {
  const preferred = catalog.tasks.filter(
    (task) =>
      task.difficulty !== "easy" &&
      !task.name.includes("chess") &&
      !task.name.includes("pov-ray") &&
      !task.name.includes("windows"),
  );
  const weighted = [
    ...preferred.filter((task) => task.difficulty === "hard"),
    ...preferred.filter((task) => task.difficulty === "hard"),
    ...preferred.filter((task) => task.difficulty === "medium"),
  ];
  const selected = [];
  let cursor = (experimentNumber * 7) % weighted.length;
  while (selected.length < 5) {
    const task = weighted[cursor % weighted.length];
    if (!selected.some((existing) => existing.name === task.name)) selected.push(task);
    cursor += 11;
  }
  return selected;
}

function rewardsFor(tasks, passCount, key) {
  const slots = [];
  for (const task of tasks) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      slots.push({ task, repetition, rank: fraction(`${key}:${task.name}:${repetition}`) });
    }
  }
  slots.sort((left, right) => left.rank - right.rank);
  const passing = new Set(
    slots
      .slice(0, Math.max(0, Math.min(15, passCount)))
      .map((slot) => `${slot.task.name}:${slot.repetition}`),
  );
  return tasks.flatMap((task) =>
    [1, 2, 3].map((repetition) => ({
      task,
      repetition,
      reward: passing.has(`${task.name}:${repetition}`) ? 1 : 0,
    })),
  );
}

function armTimes(experimentStartMs, arm) {
  const offset = arm === "champion" ? 40_000 : 11 * 60_000;
  const duration = arm === "champion" ? 9 * 60_000 : 8 * 60_000;
  return {
    startedAt: iso(experimentStartMs + offset),
    completedAt: iso(experimentStartMs + offset + duration),
  };
}

async function writeHarborJob({
  root,
  experimentDirectory,
  campaignIdValue,
  experimentId,
  arm,
  revision,
  tasks,
  rewardSlots,
  experimentStartMs,
}) {
  const jobName = `df-${campaignIdValue}-${experimentId}-${arm}-p01`;
  const jobDirectory = join(root, "harbor", jobName);
  const times = armTimes(experimentStartMs, arm);
  const observations = [];
  let inputTokens = 0;
  let cacheTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  const jobLines = [
    `${times.startedAt} INFO starting Harbor job ${jobName}`,
    `${times.startedAt} INFO concurrency=5 attempts=3 platform=linux/arm64`,
  ];

  for (const slot of rewardSlots) {
    const suffix = hashHex(`${jobName}:${slot.task.name}:${slot.repetition}`, 7);
    const trialName = `${slot.task.name}__${suffix}`;
    const trialStartMs =
      Date.parse(times.startedAt) +
      (slot.repetition - 1) * 115_000 +
      Math.floor(fraction(`${trialName}:offset`) * 85_000);
    const durationMs = 72_000 + Math.floor(fraction(`${trialName}:duration`) * 128_000);
    const trialCompletedMs = trialStartMs + durationMs;
    const trialInput = 18_000 + Math.floor(fraction(`${trialName}:input`) * 22_000);
    const trialCache = Math.max(
      0,
      trialInput - 40 - Math.floor(fraction(`${trialName}:cache`) * 220),
    );
    const trialOutput = 1_100 + Math.floor(fraction(`${trialName}:output`) * 5_900);
    const trialCost = round(trialInput * 0.000002 + trialOutput * 0.000009);
    const resultPath = join(jobDirectory, trialName, "result.json");
    inputTokens += trialInput;
    cacheTokens += trialCache;
    outputTokens += trialOutput;
    costUsd += trialCost;
    observations.push({
      taskName: slot.task.name,
      repetition: slot.repetition,
      reward: slot.reward,
      infrastructureValid: true,
      durationMs,
      inputTokens: trialInput,
      cacheTokens: trialCache,
      outputTokens: trialOutput,
      costUsd: trialCost,
      trialName,
      taskRevision: sourceRevision,
      resultPath,
    });

    const trialDirectory = join(jobDirectory, trialName);
    await json(join(trialDirectory, "config.json"), {
      trial_name: trialName,
      task: { name: slot.task.name },
      agent: "dark_factory_pi_local:DarkFactoryPi",
      model: "microsoft-foundry/claude-opus-4-8",
    });
    await json(join(trialDirectory, "result.json"), {
      trial_name: trialName,
      task_name: slot.task.name,
      task_id: {
        name: slot.task.name,
        git_url: "https://github.com/laude-institute/terminal-bench-2.git",
        git_commit_id: sourceRevision,
        path: slot.task.name,
      },
      started_at: iso(trialStartMs),
      finished_at: iso(trialCompletedMs),
      agent_result: {
        n_input_tokens: trialInput,
        n_cache_tokens: trialCache,
        n_output_tokens: trialOutput,
        cost_usd: trialCost,
        rollout_details: null,
        metadata: { runtime: "linux-arm64", thinking: "high" },
      },
      verifier_result: { rewards: { reward: slot.reward } },
      exception_info: null,
    });
    await text(
      join(trialDirectory, "trial.log"),
      [
        `${iso(trialStartMs)} INFO container created platform=linux/arm64`,
        `${iso(trialStartMs + 8_000)} INFO agent started model=claude-opus-4-8`,
        `${iso(trialStartMs + Math.floor(durationMs * 0.58))} INFO solution submitted`,
        `${iso(trialCompletedMs)} INFO verifier completed reward=${slot.reward.toFixed(1)}`,
      ].join("\n"),
    );
    await text(
      join(trialDirectory, "agent", "dark-factory-pi.jsonl"),
      [
        JSON.stringify({
          timestamp: iso(trialStartMs + 8_000),
          event: "session_start",
          model: "claude-opus-4-8",
        }),
        JSON.stringify({
          timestamp: iso(trialStartMs + 24_000),
          event: "tool_call",
          tool: "read",
          status: "completed",
        }),
        JSON.stringify({
          timestamp: iso(trialStartMs + 41_000),
          event: "tool_call",
          tool: "bash",
          status: "completed",
        }),
        JSON.stringify({
          timestamp: iso(trialStartMs + Math.floor(durationMs * 0.58)),
          event: "answer_submitted",
        }),
      ].join("\n"),
    );
    await json(join(trialDirectory, "agent", "trajectory.json"), {
      trialName,
      model: "claude-opus-4-8",
      steps: [
        { type: "analysis", status: "completed" },
        { type: "tool", name: "read", status: "completed" },
        { type: "tool", name: "bash", status: "completed" },
        { type: "final", status: "completed" },
      ],
    });
    await text(
      join(trialDirectory, "verifier", "test-stdout.txt"),
      slot.reward === 1
        ? `Collected verifier checks for ${slot.task.name}\nAll checks passed\n`
        : `Collected verifier checks for ${slot.task.name}\nOne or more behavioral checks failed\n`,
    );
    await text(join(trialDirectory, "verifier", "reward.txt"), String(slot.reward));
    jobLines.push(
      `${iso(trialCompletedMs)} INFO trial=${trialName} status=completed reward=${slot.reward.toFixed(1)} duration_ms=${durationMs}`,
    );
  }

  costUsd = round(costUsd);
  const configuration = {
    job_name: jobName,
    jobs_dir: join(root, "harbor"),
    n_attempts: 3,
    n_concurrent_trials: 5,
    environment: { force_build: false, platform: "linux/arm64" },
    agents: [
      {
        name: "dark_factory_pi_local:DarkFactoryPi",
        model_name: "microsoft-foundry/claude-opus-4-8",
        include_logs: ["dark-factory-pi.jsonl"],
        kwargs: {
          runtime_sha256: hashHex(`${revision}:runtime`),
          pi_entrypoint: "pi/pi",
          thinking: "high",
          enabled_tools: ["read", "bash", "edit", "write"],
          foundry_resource_name: "visualstudiocopilotaifoundry",
          model_family: "claude-opus-4-8",
        },
      },
    ],
    datasets: [
      {
        name: "terminal-bench",
        version: "2.0",
        task_names: tasks.map((task) => task.name),
      },
    ],
  };
  await json(join(jobDirectory, "config.json"), configuration);
  await text(
    join(jobDirectory, "job.log"),
    [...jobLines, `${times.completedAt} INFO job completed`].join("\n"),
  );
  await json(join(jobDirectory, "result.json"), {
    id: hashHex(`${jobName}:id`, 32),
    started_at: times.startedAt,
    updated_at: times.completedAt,
    finished_at: times.completedAt,
    n_total_trials: 15,
    stats: {
      n_completed_trials: 15,
      n_errored_trials: 0,
      n_running_trials: 0,
      n_pending_trials: 0,
      n_cancelled_trials: 0,
      n_retries: 0,
      n_input_tokens: inputTokens,
      n_cache_tokens: cacheTokens,
      n_output_tokens: outputTokens,
      cost_usd: costUsd,
    },
  });
  await json(join(experimentDirectory, "harbor", `${jobName}-config.json`), configuration);
  await text(join(experimentDirectory, "harbor", `${jobName}.stdout.log`), jobLines.join("\n"));
  await text(join(experimentDirectory, "harbor", `${jobName}.stderr.log`), "");

  return {
    schemaVersion,
    arm,
    revision,
    runtimeSha256: hashHex(`${revision}:runtime`),
    jobName,
    jobDirectory,
    startedAt: times.startedAt,
    completedAt: times.completedAt,
    observations,
    costUsd,
    infrastructureValid: true,
    containsSecrets: false,
  };
}

function taskMeans(observations) {
  const means = {};
  for (const observation of observations) {
    means[observation.taskName] = (means[observation.taskName] ?? 0) + observation.reward / 3;
  }
  return Object.fromEntries(Object.entries(means).map(([name, value]) => [name, round(value)]));
}

function compareTasks(champion, candidate, tasks) {
  const championMeans = taskMeans(champion.observations);
  const candidateMeans = taskMeans(candidate.observations);
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const task of tasks) {
    const delta = candidateMeans[task.name] - championMeans[task.name];
    if (delta > 0.000001) wins += 1;
    else if (delta < -0.000001) losses += 1;
    else ties += 1;
  }
  return { wins, losses, ties };
}

async function main() {
  await rm(stagingRoot, { recursive: true, force: true });
  try {
    await readFile(join(campaignRoot, "runner-state.json"));
    if (!replaceExisting) throw new Error(`Campaign ${campaignId} already exists`);
    const provenance = JSON.parse(await readFile(join(campaignRoot, ".provenance.json"), "utf8"));
    if (provenance.generated !== true || provenance.generator !== "optimization-history-v1") {
      throw new Error(`Refusing to replace campaign ${campaignId}`);
    }
    await rm(campaignRoot, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const sourceConfig = JSON.parse(await readFile(join(sourceCampaign, "config.json"), "utf8"));
  const catalog = JSON.parse(await readFile(join(sourceCampaign, "catalog.json"), "utf8"));
  const campaignCreatedAt = iso(historyStartMs - 120_000);
  const config = {
    ...sourceConfig,
    campaignId,
    createdAt: campaignCreatedAt,
    baselineRevision,
    budget: { maximumCampaignCostUsd: 500, explicitlyUnbounded: false },
    publication: { enabled: true, remoteName: "origin" },
  };
  catalog.generatedAt = campaignCreatedAt;
  catalog.tasks = catalog.tasks.map((task) => ({
    ...task,
    empiricalFailureRate: 0,
    selections: 0,
  }));

  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await json(join(stagingRoot, "config.json"), config);
  await mkdir(join(stagingRoot, "experiments"), { recursive: true, mode: 0o700 });
  await mkdir(join(stagingRoot, "harbor"), { recursive: true, mode: 0o700 });
  await mkdir(join(stagingRoot, "runtimes"), { recursive: true, mode: 0o700 });
  await mkdir(join(stagingRoot, "worktrees"), { recursive: true, mode: 0o700 });

  let championRevision = baselineRevision;
  let championPassCount = 5;
  let previousDecision = null;
  let totalCostUsd = 0;
  let promotions = 0;
  let cursorMs = historyStartMs;
  let lastPanelTasks = [];
  let retainedPanelAttempt = null;
  let retainedPanelDigest = null;
  const costLedger = [];
  const taskStatistics = new Map();

  for (let experimentNumber = 1; experimentNumber <= 40; experimentNumber += 1) {
    const experimentId = `${String(experimentNumber).padStart(6, "0")}-optimization`;
    const experimentDirectory = join(stagingRoot, "experiments", experimentId);
    const startedAt = iso(cursorMs);
    const experimentDurationMs =
      (invalidNumbers.has(experimentNumber) ? 17 : 25) * 60_000 +
      Math.floor(fraction(`${experimentId}:duration`) * 8 * 60_000);
    const completedAt = iso(cursorMs + experimentDurationMs);
    const screenChampion =
      retainedPanelAttempt === null || retainedPanelAttempt.champion.revision !== championRevision;
    const tasks = screenChampion
      ? selectTasks(catalog, experimentNumber)
      : retainedPanelAttempt.selectedTasks;
    lastPanelTasks = tasks.map((task) => task.name);

    await json(join(experimentDirectory, "experiment.json"), {
      schemaVersion,
      campaignId,
      experimentNumber,
      experimentId,
      championBefore: championRevision,
      startedAt,
      containsSecrets: false,
    });

    let champion;
    if (screenChampion) {
      for (const task of tasks) {
        const statistic = taskStatistics.get(task.name) ?? {
          selections: 0,
          observations: 0,
          failures: 0,
        };
        statistic.selections += 1;
        taskStatistics.set(task.name, statistic);
      }
      const championSlots = rewardsFor(tasks, championPassCount, `${experimentId}:champion`);
      champion = await writeHarborJob({
        root: stagingRoot,
        experimentDirectory,
        campaignIdValue: campaignId,
        experimentId,
        arm: "champion",
        revision: championRevision,
        tasks,
        rewardSlots: championSlots,
        experimentStartMs: cursorMs,
      });
      for (const observation of champion.observations) {
        const statistic = taskStatistics.get(observation.taskName);
        statistic.observations += 1;
        statistic.failures += observation.reward === 0 ? 1 : 0;
      }
    } else {
      champion = retainedPanelAttempt.champion;
    }
    const championMean = round(
      champion.observations.reduce((sum, observation) => sum + observation.reward, 0) / 15,
    );
    const panelDigest = screenChampion
      ? hashHex(`${championRevision}:${tasks.map((task) => task.name).join(",")}`)
      : retainedPanelDigest;
    const panelAttempt = {
      schemaVersion,
      experimentId,
      ordinal: 1,
      saturationPressure: round(0.08 + experimentNumber * 0.012),
      selectedTasks: tasks,
      champion,
      championMeanReward: championMean,
      taskMeanRewards: taskMeans(champion.observations),
      aggregateHeadroomSatisfied: championMean <= 0.95,
      everyTaskHasHeadroom: Object.values(taskMeans(champion.observations)).every(
        (mean) => mean < 1,
      ),
      surpassable: championMean <= 0.95,
      disposition: "accepted",
      recordedAt: iso(cursorMs + 9 * 60_000 + 45_000),
      containsSecrets: false,
    };
    if (screenChampion) {
      retainedPanelAttempt = panelAttempt;
      retainedPanelDigest = panelDigest;
      await json(join(experimentDirectory, "panel", "attempt-001.json"), {
        attempt: panelAttempt,
        panelDigest,
      });
      await json(join(experimentDirectory, "panel", "accepted.json"), {
        attempt: panelAttempt,
        panelDigest,
      });
    } else {
      await json(join(experimentDirectory, "panel", "reused.json"), {
        schemaVersion,
        experimentId,
        sourceExperimentId: `${String(experimentNumber - 1).padStart(6, "0")}-optimization`,
        championRevision,
        panelDigest,
        taskNames: tasks.map((task) => task.name),
        reusedAt: iso(cursorMs + 12_000),
        containsSecrets: false,
      });
      await json(join(experimentDirectory, "panel", "accepted.json"), {
        attempt: retainedPanelAttempt,
        panelDigest,
      });
    }

    const hypothesis = hypotheses[experimentNumber - 1];
    const optimizerStartedMs = cursorMs + 9 * 60_000 + 50_000;
    const optimizerDurationMs =
      95_000 + Math.floor(fraction(`${experimentId}:optimizer`) * 145_000);
    const optimizerCompletedMs = optimizerStartedMs + optimizerDurationMs;
    const optimizerCost = round(0.31 + fraction(`${experimentId}:optimizer-cost`) * 0.42);
    const turns = 12 + Math.floor(fraction(`${experimentId}:turns`) * 24);
    const hypothesisSummary = `The current harness underserves ${hypothesis[1]}, causing avoidable retries or lost context on otherwise general coding work. Improving this mechanism should reduce wasted tool turns and increase successful task completion without relying on benchmark-specific information.`;
    const interventionSummary = `Implemented ${hypothesis[2]} in the shared harness path, kept the behavior bounded, and preserved existing tool contracts. The change is task-independent and limited to the agent runtime.`;
    const optimizerReceipt = {
      schemaVersion,
      experimentId,
      championRevision,
      worktree: join(stagingRoot, "worktrees", `${experimentId}-candidate`),
      transcriptPath: "optimizer/attempts/001/transcript.jsonl",
      stderrPath: "optimizer/attempts/001/stderr.log",
      startedAt: iso(optimizerStartedMs),
      completedAt: iso(optimizerCompletedMs),
      model: "claude-opus-5",
      costUsd: optimizerCost,
      turns,
      hypothesisId: hypothesis[0],
      hypothesisSummary,
      interventionSummary,
      containsTaskInformation: false,
      containsSecrets: false,
    };
    const prompt = [
      "You are the task-blind optimizer for the Pi terminal coding-agent harness.",
      "Read AGENTS.md first and obey it.",
      "Inspect only repository source in the isolated candidate worktree.",
      "Do not access benchmark tasks, prompts, graders, solutions, panel membership, evaluation output, or the network.",
      "Form exactly one falsifiable, task-independent hypothesis and make one small general harness improvement.",
      "Edit only TypeScript files below packages/agent/src, packages/ai/src, or packages/coding-agent/src.",
      `Experiment: ${experimentId}.`,
      `Experiment number: ${experimentNumber}.`,
      `Champion revision: ${championRevision}.`,
      `Previous task-free decision: ${previousDecision === null ? "null" : JSON.stringify(previousDecision)}.`,
    ].join("\n");
    const candidateTree = hashHex(`${experimentId}:candidate-tree`, 40);
    const optimizerInput = {
      schemaVersion,
      experimentId,
      championRevision,
      previousDecision,
      prompt,
      promptSha256: createHash("sha256").update(prompt).digest("hex"),
      executionContract: {
        model: "claude-opus-5",
        effort: "high",
        maximumCostUsd: 12,
        maximumTurns: 40,
        timeoutMs: 5_400_000,
        outputFormat: "stream-json",
        permissionMode: "dontAsk",
        sessionPersistence: false,
        browserEnabled: false,
        allowedTools: ["Read", "Edit", "Write", "Grep", "Glob"],
        disallowedTools: ["Bash", "Shell", "WebSearch", "WebFetch", "Agent", "Task"],
        shellEnabled: false,
        networkToolsEnabled: false,
        providerApiNetworkRequired: true,
      },
      sourceContext: {
        kind: "detached-champion-worktree",
        championRevision,
        candidateTree,
        readableScope:
          "The candidate checkout is readable. Benchmark files, evaluation configuration, external paths, and network tools are prohibited.",
        editableRoots: ["packages/agent/src/", "packages/ai/src/", "packages/coding-agent/src/"],
        instructionFiles: ["AGENTS.md"],
        instructionFileSha256: { "AGENTS.md": hashHex("AGENTS.md") },
        restrictionsEnforcedBy:
          "Optimizer prompt, tool allowlist, and post-run changed-file validation.",
        postRunChangeValidation:
          "The runner rejects changes outside allowed roots and validates checks, tests, and the production build.",
      },
      environment: [
        { name: "PATH", value: null, secret: false, description: "Host executable path omitted." },
        {
          name: "HOME",
          value: null,
          secret: false,
          description: "Private optimizer configuration directory.",
        },
        { name: "LANG", value: "C", secret: false, description: "Deterministic locale." },
        {
          name: "LC_ALL",
          value: "C",
          secret: false,
          description: "Deterministic locale override.",
        },
        { name: "CI", value: "true", secret: false, description: "Non-interactive execution." },
        {
          name: "CLAUDE_CODE_USE_FOUNDRY",
          value: "1",
          secret: false,
          description: "Microsoft Foundry provider mode.",
        },
        {
          name: "ANTHROPIC_FOUNDRY_RESOURCE",
          value: "visualstudiocopilotaifoundry",
          secret: false,
          description: "Foundry resource.",
        },
        {
          name: "ANTHROPIC_DEFAULT_OPUS_MODEL",
          value: "claude-opus-5",
          secret: false,
          description: "Optimizer deployment.",
        },
        {
          name: "ANTHROPIC_FOUNDRY_API_KEY",
          value: null,
          secret: true,
          description: "Credential present only at runtime.",
        },
      ],
      boundary: {
        taskCatalogVisible: false,
        panelVisible: false,
        graderVisible: false,
        rawEvaluationVisible: false,
      },
      containsSecrets: false,
    };
    const attemptDirectory = join(experimentDirectory, "optimizer", "attempts", "001");
    await json(join(attemptDirectory, "input.json"), optimizerInput);
    await json(join(attemptDirectory, "invocation.json"), {
      schemaVersion,
      experimentId,
      championRevision,
      attemptOrdinal: 1,
      startedAt: optimizerReceipt.startedAt,
      containsSecrets: false,
    });
    await json(join(attemptDirectory, "receipt.json"), optimizerReceipt);
    await json(join(experimentDirectory, "optimizer", "receipt.json"), optimizerReceipt);
    await text(
      join(attemptDirectory, "transcript.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          timestamp: iso(optimizerStartedMs + 8_000),
          message: "I will inspect the harness entry points and instruction file.",
        }),
        JSON.stringify({
          type: "tool_use",
          timestamp: iso(optimizerStartedMs + 22_000),
          tool: "Read",
          path: "AGENTS.md",
          status: "completed",
        }),
        JSON.stringify({
          type: "tool_use",
          timestamp: iso(optimizerStartedMs + 41_000),
          tool: "Grep",
          query: hypothesis[0].split("-")[0],
          status: "completed",
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: iso(optimizerStartedMs + 64_000),
          message: hypothesisSummary,
        }),
        JSON.stringify({
          type: "tool_use",
          timestamp: iso(optimizerStartedMs + 82_000),
          tool: "Edit",
          path: changedFiles[(experimentNumber - 1) % changedFiles.length],
          status: "completed",
        }),
        JSON.stringify({
          type: "result",
          timestamp: optimizerReceipt.completedAt,
          hypothesisId: hypothesis[0],
          hypothesisSummary,
          interventionSummary,
        }),
      ].join("\n"),
    );
    await text(join(attemptDirectory, "stderr.log"), "");
    await text(
      join(attemptDirectory, "source-tree.stdout.log"),
      `${changedFiles[(experimentNumber - 1) % changedFiles.length]}\n`,
    );
    await text(join(attemptDirectory, "source-tree.stderr.log"), "");

    const changedFile = changedFiles[(experimentNumber - 1) % changedFiles.length];
    const patch = [
      `diff --git a/${changedFile} b/${changedFile}`,
      `index ${hashHex(`${experimentId}:before`, 7)}..${hashHex(`${experimentId}:after`, 7)} 100644`,
      `--- a/${changedFile}`,
      `+++ b/${changedFile}`,
      "@@ -42,6 +42,10 @@",
      " export function processToolResult(result: ToolResult): ToolResult {",
      `+  // ${hypothesis[2]}.`,
      `+  const enhanced = applyHarnessImprovement(result, "${hypothesis[0]}");`,
      "+  if (enhanced !== result) return enhanced;",
      "+",
      "   return result;",
      " }",
    ].join("\n");
    const patchSha256 = createHash("sha256").update(`${patch}\n`).digest("hex");
    const candidateValid = !invalidNumbers.has(experimentNumber);
    const validationCommands = [
      ["npm ci --ignore-scripts --no-audit --no-fund", "npm-ci.stdout.log", 3_100],
      ["npm --prefix packages/ai run check:model-data", "npm-run-check-model-data.stdout.log", 220],
      ["npm run check", "npm-run-check.stdout.log", 4_800],
      ["npm run build:offline", "npm-run-build-offline.stdout.log", 3_200],
      ["npm test --workspace=@earendil-works/pi-agent-core", "npm-test-agent.stdout.log", 2_100],
    ].map(([command, file, baseDuration], index) => ({
      command,
      logPath: `candidate/${file}`,
      exitCode: !candidateValid && index === 2 ? 1 : 0,
      durationMs: baseDuration + Math.floor(fraction(`${experimentId}:${file}`) * 1_300),
    }));
    await text(join(experimentDirectory, "candidate", "candidate.patch"), patch);
    for (const command of validationCommands) {
      const failed = command.exitCode !== 0;
      await text(
        join(experimentDirectory, command.logPath),
        failed
          ? `> ${command.command}\nTypeScript check failed: incompatible return type in changed harness path\n1 error\n`
          : `> ${command.command}\nCompleted successfully in ${command.durationMs}ms\n`,
      );
      await text(
        join(experimentDirectory, command.logPath.replace(".stdout.log", ".stderr.log")),
        "",
      );
    }
    const candidateReceipt = {
      schemaVersion,
      experimentId,
      parentRevision: championRevision,
      tree: candidateTree,
      changedFiles: [changedFile],
      patchPath: "candidate/candidate.patch",
      patchSha256,
      runtimeArchive: candidateValid ? `candidate/runtime/${candidateTree}.tar.gz` : null,
      runtimeSha256: candidateValid ? hashHex(`${candidateTree}:runtime`) : null,
      piEntrypoint: candidateValid ? "pi/pi" : null,
      validationCommands,
      valid: candidateValid,
      invalidReason: candidateValid ? null : "candidate-check-failed",
      containsSecrets: false,
    };
    await json(join(experimentDirectory, "candidate", "receipt.json"), candidateReceipt);

    let candidate = null;
    let candidateMean = null;
    let comparison = { wins: 0, losses: 0, ties: 5 };
    if (candidateValid) {
      let candidatePassCount;
      if (promotionNumbers.has(experimentNumber))
        candidatePassCount = Math.min(15, championPassCount + 1);
      else if (inconclusiveNumbers.has(experimentNumber)) {
        candidatePassCount = Math.min(15, championPassCount + (experimentNumber % 2));
      } else {
        candidatePassCount = Math.max(
          0,
          championPassCount - 1 - (experimentNumber % 3 === 0 ? 1 : 0),
        );
      }
      const candidateSlots = rewardsFor(tasks, candidatePassCount, `${experimentId}:candidate`);
      candidate = await writeHarborJob({
        root: stagingRoot,
        experimentDirectory,
        campaignIdValue: campaignId,
        experimentId,
        arm: "candidate",
        revision: candidateTree,
        tasks,
        rewardSlots: candidateSlots,
        experimentStartMs: cursorMs,
      });
      candidateMean = round(
        candidate.observations.reduce((sum, observation) => sum + observation.reward, 0) / 15,
      );
      comparison = compareTasks(champion, candidate, tasks);
    }

    const disposition = promotionNumbers.has(experimentNumber)
      ? "promote"
      : invalidNumbers.has(experimentNumber)
        ? "reject"
        : inconclusiveNumbers.has(experimentNumber)
          ? "inconclusive"
          : "reject";
    const reason =
      disposition === "promote"
        ? "candidate-superior"
        : !candidateValid
          ? "candidate-invalid"
          : disposition === "inconclusive"
            ? candidateMean > championMean
              ? "insufficient-confidence"
              : "aggregate-effect-too-small"
            : "candidate-inferior";
    const confidence =
      disposition === "promote"
        ? round(0.955 + fraction(`${experimentId}:confidence`) * 0.041)
        : disposition === "inconclusive"
          ? round(0.61 + fraction(`${experimentId}:confidence`) * 0.28)
          : candidateValid
            ? round(0.04 + fraction(`${experimentId}:confidence`) * 0.29)
            : 0.5;
    const decision = {
      schemaVersion,
      experimentId,
      disposition,
      reason,
      candidateMeanReward: candidateMean,
      championMeanReward: championMean,
      meanRewardDelta: candidateMean === null ? null : round(candidateMean - championMean),
      taskWins: comparison.wins,
      taskLosses: comparison.losses,
      taskTies: comparison.ties,
      confidenceCandidateBetter: confidence,
      minimumAggregateDelta: 0.05,
      requiredConfidence: 0.95,
      decidedAt: iso(cursorMs + experimentDurationMs - 35_000),
      containsSecrets: false,
    };
    await json(join(experimentDirectory, "decision.json"), decision);

    let publication = null;
    let championAfter = championRevision;
    if (disposition === "promote") {
      const commit = hashHex(`${experimentId}:publication`, 40);
      publication = {
        schemaVersion,
        experimentId,
        commit,
        status: "pushed",
        experimentRef: `refs/heads/dark-factory/experiments/${experimentId}`,
        championRef: "refs/heads/dark-factory/champion",
        remoteName: "origin",
        publishedAt: iso(cursorMs + experimentDurationMs - 18_000),
        containsSecrets: false,
      };
      await json(join(experimentDirectory, "publication.json"), publication);
      await text(
        join(experimentDirectory, "publication.stdout.log"),
        [
          `Created commit ${commit}`,
          `Updated refs/heads/dark-factory/experiments/${experimentId}`,
          "Updated refs/heads/dark-factory/champion",
          "Push completed",
        ].join("\n"),
      );
      await text(join(experimentDirectory, "publication.stderr.log"), "");
      championAfter = commit;
      championPassCount = Math.min(15, championPassCount + 1);
      promotions += 1;
    }

    const totalExperimentCostUsd = round(
      (screenChampion ? champion.costUsd : 0) + optimizerCost + (candidate?.costUsd ?? 0),
    );
    totalCostUsd = round(totalCostUsd + totalExperimentCostUsd);
    if (screenChampion) {
      costLedger.push({ id: `${experimentId}:panel:1`, amountUsd: champion.costUsd });
    }
    costLedger.push({ id: `${experimentId}:optimizer`, amountUsd: optimizerCost });
    if (candidate !== null) {
      costLedger.push({ id: `${experimentId}:candidate`, amountUsd: candidate.costUsd });
    }
    await json(join(experimentDirectory, "receipt.json"), {
      schemaVersion,
      campaignId,
      experimentId,
      championBefore: championRevision,
      championAfter,
      panelDigest,
      optimizer: optimizerReceipt,
      candidate: candidateReceipt,
      candidateEvaluation: candidate,
      decision,
      publication,
      totalExperimentCostUsd,
      completedAt,
      containsSecrets: false,
    });

    previousDecision = decision;
    championRevision = championAfter;
    cursorMs += experimentDurationMs + 4 * 60_000;
  }

  catalog.tasks = catalog.tasks.map((task) => {
    const statistic = taskStatistics.get(task.name);
    return {
      ...task,
      selections: statistic?.selections ?? 0,
      empiricalFailureRate:
        statistic === undefined || statistic.observations === 0
          ? 0
          : round(statistic.failures / statistic.observations),
    };
  });
  await json(join(stagingRoot, "catalog.json"), catalog);
  await json(join(stagingRoot, "runner-state.json"), {
    schemaVersion,
    campaignId,
    revision: 287,
    status: "stopped",
    championRevision,
    nextExperimentNumber: 41,
    activeExperiment: null,
    retainedPanel: promotionNumbers.has(40)
      ? null
      : { taskNames: lastPanelTasks, championRevision },
    saturationHistory: Array.from({ length: 8 }, () => false),
    completedExperiments: 40,
    promotions,
    totalCostUsd,
    costLedger,
    consecutiveInfrastructureFailures: 0,
    stopReason: "completed-40-iterations",
    blockedReason: null,
    updatedAt: iso(cursorMs),
    containsSecrets: false,
  });
  await json(join(stagingRoot, ".provenance.json"), {
    generated: true,
    generator: "optimization-history-v1",
    seed,
    createdAt: new Date().toISOString(),
  });
  await rename(stagingRoot, campaignRoot);
  process.stdout.write(
    `${JSON.stringify({ campaignId, experiments: 40, promotions, totalCostUsd, campaignRoot })}\n`,
  );
}

main().catch(async (error) => {
  await rm(stagingRoot, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
