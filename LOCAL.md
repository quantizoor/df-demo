# Running Dark Factory locally

Dark Factory now has two local modes:

- `pnpm local:run` is the fast deterministic, no-model smoke test.
- `pnpm local real ...` is the resumable Pi/Terminal-Bench optimization
  campaign using Docker, Claude Opus 5 through Microsoft Foundry, and Pi with
  Claude Opus 4.8 through Microsoft Foundry.

The real CLI runner remains in the foreground and has no iteration limit. The
local operations console launches the same runner as a detached worker. Either
form stops only on an operator request or a safety boundary such as the
configured cost ceiling, repeated infrastructure failure, catalog saturation,
or Git publication divergence.

## Prerequisites

- Node.js 24 or newer and pnpm 11.9.0;
- Docker Desktop or Docker Engine with a running daemon;
- `uvx` (from `uv`) and Python 3.13;
- Bun, npm, and Git;
- the clean Pi checkout at `../df-pi-tbench`;
- Claude Code 2.1.217 at
  `.df/local/tools/claude/node_modules/.bin/claude`; and
- the mode-0600 credential file `.df/local/config/foundry.env`.

The credential file must contain exactly:

```text
DF_FOUNDRY_BASE_URL=https://<resource>.services.ai.azure.com/anthropic
DF_OPTIMIZER_DEPLOYMENT=claude-opus-5
DF_EVALUATED_DEPLOYMENT=claude-opus-4-8
ANTHROPIC_FOUNDRY_API_KEY=<secret>
```

The API key is read at execution time. It is not copied into campaign
configuration, Harbor configuration, prompts, receipts, or Git.

Run the prerequisite report with:

```sh
pnpm local:doctor
```

## Launch the local operations console

Install dependencies, then start the Next.js console in development mode:

```sh
pnpm install
pnpm dashboard:dev
```

For an optimized production-mode build and launch:

```sh
pnpm dashboard:start
```

Open the **Dark Factory Console** URL printed in the terminal. The console
listens only on `127.0.0.1` and establishes an HttpOnly, SameSite session
automatically. Its internal session secret rotates each time the console
starts; an open page repairs its session automatically after a restart.

The console provides:

- campaign creation, configuration, start, stop, and status controls;
- live runner state and log following;
- experiment hypotheses, optimizer transcripts, code patches, validation
  output, decisions, and publication receipts;
- matched champion/candidate reward, cost, promotion, and panel-change charts;
  and
- task-level health, difficulty, selection, and saturation evidence.

Creating a campaign only writes its durable configuration; it does not start
the optimizer or incur model cost. **Start once** runs one complete experiment.
**Start continuous** keeps running until stopped or blocked. The worker is
detached, so it continues if the browser is closed or the dashboard server is
stopped.

Before the final creation step, the wizard runs a bounded, non-mutating
readiness check across local storage, Node.js, Docker, uvx, Git, npm, Bun, the
clean Pi checkout and origin, the protected Foundry credential file, Claude
Code, the Harbor adapter, and Terminal-Bench 2.0 catalog metadata. The report
contains only categorical results—never credential values or local paths.

The default dashboard runtime state is:

```text
.df/local/dashboard/
├── session-token
└── launches/
    └── <launch-id>/
        ├── launch.json
        ├── stdout.log
        └── stderr.log
```

The token and launch files are mode-restricted and Git-ignored. Campaign
evidence remains in `.df/local/real/campaigns/<campaign>/`; the dashboard reads
those source-of-truth artifacts rather than maintaining a second database.

## Initialize a real campaign

Initialization verifies the clean Pi baseline and its
`parallaxai/df-pi-tbench` origin, validates the pinned Foundry bindings, and
bootstraps the 89-task Terminal-Bench 2.0 catalog with declared difficulty.

Use a finite campaign cost ceiling:

```sh
pnpm local real init \
  --campaign pi-local \
  --max-campaign-cost-usd 250
```

An iteration-unbounded and cost-unbounded campaign requires an explicit flag:

```sh
pnpm local real init \
  --campaign pi-local \
  --allow-unbounded-cost
```

The iteration count is unbounded in both cases. The campaign limit is a
post-spend stop threshold: it stops the runner before the next paid phase once
recorded cost reaches the limit. A phase already in progress can cross that
threshold. Each Opus 5 optimizer invocation also has its own `$12` provider
cap; Harbor/Pi calls are recorded from their completed trial receipts.

Absolute paths can be overridden:

```sh
pnpm local real init \
  --campaign pi-local \
  --pi-repo /absolute/path/to/df-pi-tbench \
  --credentials-file /absolute/path/to/foundry.env \
  --claude-executable /absolute/path/to/claude \
  --max-campaign-cost-usd 250
```

## Run, inspect, stop, and resume

Run indefinitely in the foreground:

```sh
pnpm local real run --campaign pi-local
```

For one complete experiment only:

```sh
pnpm local real run --campaign pi-local --once
```

From another terminal, inspect, request a graceful stop after the active phase,
or cancel an interruptible active process:

```sh
pnpm local real status --campaign pi-local
pnpm local real stop --campaign pi-local
pnpm local real stop --campaign pi-local --cancel-active
```

The console exposes the same choices as **Stop after phase** and **Cancel now**.
Cancellation sends termination to the active optimizer/evaluation process and
preserves its logs; the runner never interrupts the atomic champion-publication
phase. `Ctrl-C` on a foreground CLI runner requests a stop, which is observed
at safe phase boundaries. Resume from the last durable checkpoint with:

```sh
pnpm local real resume --campaign pi-local
```

Completed optimizer transcripts, Harbor trials, candidate builds, decisions,
and publication intents are replayed from disk rather than repeated.
Interrupted Harbor jobs resume only their missing trials. An incomplete
optimizer attempt is retained, and a retry starts from a clean runner-owned
worktree.

## Panel saturation and dynamic task difficulty

Every experiment prepares its evaluation panel before Opus 5 is called:

1. deterministically sample five tasks using weighted, without-replacement
   sampling;
2. run the current champion three times on each task;
3. reject and rotate the panel if its mean reward is above `0.95`; and
4. also reject it if any task has at most `0.01` theoretical improvement
   headroom.

The fourth condition is deliberately stronger than only checking the overall
mean. The promotion rule needs wins on all five task clusters to exceed 95%
exact sign confidence. If one task is already unbeatable, even a perfect
candidate cannot pass that rule.

Every valid screen updates a rolling 20-screen saturation history. The
observed saturation rate multiplies medium- and hard-task selection weights;
at maximum pressure the difficulty multipliers are easy `1x`, medium `2x`,
and hard `4x`. Saturated panels are excluded from the current search, and their
tasks are not immediately selected again. Infrastructure failures do not
count as saturation.

If no qualifying panel can be found within the configured search boundary,
the campaign blocks before invoking the optimizer.

## What is persisted

Real campaign state lives below:

```text
.df/local/real/campaigns/<campaign>/
├── config.json
├── catalog.json
├── runner-state.json
├── stop-request.json
├── worktrees/
├── runtimes/
├── harbor/
└── experiments/
    └── 000001-optimization/
        ├── experiment.json
        ├── panel/
        │   ├── attempt-001.json
        │   └── accepted.json
        ├── optimizer/
        │   ├── receipt.json
        │   └── attempts/
        │       └── 001/
        │           ├── invocation.json
        │           ├── input.json
        │           ├── transcript.jsonl
        │           └── receipt.json
        ├── candidate/
        │   ├── candidate.patch
        │   ├── validation logs
        │   ├── runtime.json
        │   └── evaluation.json
        ├── decision.json
        ├── publication-intent.json
        ├── publication.json
        └── receipt.json
```

The campaign records prompts, model outputs, hypotheses, patches, changed
files, validation commands and logs, build/runtime hashes, every panel attempt,
the exact commit-pinned task registry used by Harbor, all trial paths and
scores, tokens, costs, decisions, and publication receipts. Provider-internal
hidden reasoning is not available to persist. Credential values are scrubbed
from retained process and Harbor artifacts.

All `.df` state is Git-ignored. Back it up while the runner is stopped if it
needs to survive machine loss.

## Champion Git publication

Rejected and inconclusive candidates remain local as patches and worktrees;
they are not committed or pushed.

A promoted candidate is:

1. verified against the exact evaluated Git tree and parent;
2. turned into a deterministic single-parent commit;
3. recorded in a durable publication intent;
4. atomically and non-forcibly pushed to:
   - `refs/heads/df/experiment/<campaign-id>/<experiment-id>`; and
   - `refs/heads/df/champion/<campaign-id>`;
5. re-read from the remote; and only then
6. installed as the local campaign champion.

The runner never updates or force-pushes `main`. Merging a champion into `main`
remains a separate operator action.

If the push result is lost, resume verifies the two remote refs and completes
idempotently. A conflicting experiment ref or a champion ref that is not the
expected parent blocks the campaign rather than overwriting remote history.

## Synthetic smoke and Docker packaging

The original fast smoke remains available:

```sh
pnpm local:run
pnpm local:status
```

It creates an independent deterministic record below `.df/local/runs` and
does not use a model or Docker.

The repository's Compose image packages this synthetic control-loop smoke. The
real runner is host-native because it must control the host Docker daemon,
work with the sibling Pi Git checkout, and use the locally installed Claude,
Bun, npm, and uv toolchains.
