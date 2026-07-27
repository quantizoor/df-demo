# Dark Factory

Dark Factory has two supported local paths: a fast deterministic no-model smoke
and a real, resumable Pi optimization campaign. The real runner uses local Git
worktrees, Docker/Harbor with Terminal-Bench 2.0, Claude Opus 5 through
Microsoft Foundry as the optimizer, and Pi with Claude Opus 4.8 through
Microsoft Foundry as the evaluated agent. All campaign state and evidence is
persisted locally.

## Run locally

Install Node.js 24 and enable the package manager declared by this repository:

```sh
corepack enable
corepack install --global pnpm@11.9.0
pnpm install --frozen-lockfile
```

Some Node distributions do not include Corepack. In that case, install the
pinned package manager with `npm install --global pnpm@11.9.0`, then run the
same `pnpm install --frozen-lockfile` command.

Then verify and run the local loop:

```sh
pnpm local:doctor
pnpm local:run
pnpm local:status
```

Each `pnpm local:run` invocation runs the same deterministic synthetic
smoke—two campaign iterations plus one infrastructure-invalid scenario—and
creates a new, independent run record. Host-mode state and receipts live under
`.df/local/`, which is ignored by Git. Pass another root directly when needed:

```sh
pnpm local run --state-root /absolute/path/to/df-state
```

Builds and repository checks also run locally:

```sh
pnpm build
pnpm check
node dist/local/cli.js run
```

The built package exposes the same entrypoint as `df-local`.

## Local operations console

The Next.js console starts, stops, and monitors real campaigns; shows live
logs, experiments, hypotheses, patches, task health, and publication evidence;
and charts matched champion/candidate performance over time.

For development:

```sh
pnpm dashboard:dev
```

For a production-mode local build and launch:

```sh
pnpm dashboard:start
```

Open the **Dark Factory Console** URL printed in the terminal. The server binds
only to `127.0.0.1` and establishes its HttpOnly local session automatically.
If the console restarts while a page is open, the page repairs its session on
the next request.
The setup wizard verifies the complete local runtime before initialization.
Creating a campaign does not start it or spend model budget. A started campaign
runs in a detached worker and continues if the browser or dashboard server is
closed.

See [LOCAL.md](./LOCAL.md) for dashboard storage, stop semantics, and the full
operator workflow.

## Run the real optimization loop

With Docker, uv, Bun, Claude Code, the sibling `../df-pi-tbench` checkout, and
the mode-0600 Foundry credential file already installed:

```sh
pnpm local:doctor
pnpm local real init --campaign pi-local --max-campaign-cost-usd 250
pnpm local real run --campaign pi-local
```

The run command continues until stopped or blocked. In another terminal:

```sh
pnpm local real status --campaign pi-local
pnpm local real stop --campaign pi-local
pnpm local real resume --campaign pi-local
```

Before every Opus 5 proposal, the runner evaluates the current champion on a
five-task, three-repetition panel. It rotates any panel that lacks at least 5%
aggregate headroom or improvement headroom on every task. A rolling saturation
rate dynamically favors harder tasks when perfect or unbeatable panels occur
often.

Only promoted candidates become commits. They are atomically pushed without
force to dedicated `df/experiment/...` and `df/champion/...` refs;
`main` is never changed automatically. See [LOCAL.md](./LOCAL.md) for the full
runbook, persistence layout, exact panel policy, cost controls, and publication
recovery behavior.

## Optional Docker run

Docker is optional. Docker Compose can build the local image without Node or
pnpm on the host and persist its state in the `dark-factory-data` named volume:

```sh
docker compose run --build --rm dark-factory-local doctor --state-root /data
docker compose run --build --rm dark-factory-local
docker compose run --build --rm dark-factory-local status --state-root /data
```

If pnpm is already available, the equivalent convenience scripts are:

```sh
pnpm docker-local:doctor
pnpm docker-local
pnpm docker-local:status
```

These are convenience wrappers around `docker compose`; the host-native and
container state roots are separate. See [LOCAL.md](./LOCAL.md) for direct
Compose commands, artifact details, reset guidance, troubleshooting, and the
current integration boundary.

## Legacy cloud system

The original blind cloud control plane remains in the repository as a legacy
mode. Its intended architecture has Claude Code propose changes before task
selection, a trusted broker choose a hidden failure-weighted panel, Pi run
candidate and champion through matched Terminal-Bench repetitions, and only
fresh evidence permit promotion. That implementation is source-complete but
cloud-unverified and still depends on private runtime material and the existing
Foundry/Daytona setup.

The old `df` development command and protected workflows retain the explicit
cloud-execution guard. Use `pnpm local:*` for ordinary execution on this
machine.

The extensive cloud design and operational documentation is preserved here:

- [PLAN.md](./PLAN.md) — architecture, optimization loop, integrity policy,
  evaluation design, and implementation phases.
- [TODO.md](./TODO.md) — implementation and deployment checklist.
- [documentation.md](./documentation.md) — append-only architectural decision
  journal.
- [CLOUD_DELIVERY.md](./CLOUD_DELIVERY.md) — protected cloud setup and runbook.
- [FEEDBACK.md](./FEEDBACK.md) — operator-only release-safe audit mirror.

KMS/HSM signing, custom image publication, and production multi-host hardening
remain outside the local runner.
