# Dark Factory Decision Journal

This file is the append-only journal for material architectural, research, and
operational decisions.

## Journal rules

- Assign decisions monotonically increasing IDs: `ADR-0001`, `ADR-0002`, etc.
- Never delete an accepted decision.
- Never silently rewrite a decision after implementation begins.
- Correct factual mistakes with an amendment that cites the original ADR.
- Replace a policy by marking it superseded and linking the new ADR.
- Record implementation-level experiment choices in the experiment's strict
  JSON records. Use this journal for choices that affect architecture,
  security, measurement, reproducibility, or future implementation work.
- Code or policy changes that materially alter a recorded decision must cite a
  new or existing ADR.

Every future ADR uses this structure:

```text
## ADR-NNNN — Title

- Date:
- Status: proposed | accepted | rejected | superseded
- Supersedes:
- Superseded by:
- Related plan:

### Context
### Decision
### Alternatives
### Consequences
### Evidence
```

## ADR-0001 — Use Pi as the harness under optimization

- Date: 2026-07-25
- Status: superseded
- Supersedes: none
- Superseded by: ADR-0029
- Related plan: `PLAN.md` §2.1

### Context

Dark Factory needs an existing open-source terminal-agent harness that Claude
Code can modify. The harness should be TypeScript, headless, testable, modular,
and small enough for controlled experiments.

### Decision

Fork `badlogic/pi-mono` to `quantizoor/pi-mono` and optimize the Pi coding-agent
package.

### Alternatives

- OpenCode: TypeScript and already supported by Harbor, but substantially larger
  and more complex.
- Cline: TypeScript and headless, but carries a broad IDE/SDK/product surface.
- Agentic Harness Engineering/NexAU: closest research precedent, but primarily
  Python, E2B-coupled, and partially dependent on a closed debugger.
- Claude Code itself: strong Terminal-Bench results, but its core executable is
  not the forkable open-source TypeScript harness required here.

### Consequences

Dark Factory must complete or maintain a Harbor adapter for Pi. It gains a
compact TypeScript mutation surface with extensions, skills, tools, prompt
hooks, compaction hooks, JSON/RPC modes, Biome, and Vitest.

### Evidence

- `https://github.com/badlogic/pi-mono`
- `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md`
- `PLAN.md` research and selection criteria

## ADR-0002 — Keep the Dark Factory control plane in TypeScript

- Date: 2026-07-25
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §2.2

### Context

The requested MVP stack is Node.js, TypeScript, Vitest, and Biome. Harbor is a
Python evaluator, but it does not require the orchestration layer to be Python.

### Decision

Implement the controller, CLI, schemas, store, selector, analysis, Claude MCP
server, and provider abstraction in strict TypeScript. Treat pinned Harbor as an
external evaluator dependency.

### Alternatives

- Fork AHE and retain its Python controller.
- Add orchestration directly to Harbor.
- Use a mixed Python/TypeScript controller.

### Consequences

The Harbor boundary needs an explicit, versioned request/result contract.
Python is allowed inside pinned external benchmark tooling, not as a Dark
Factory application language.

### Evidence

- User-selected stack
- Harbor's external/custom agent interface

## ADR-0003 — Use Harbor and ATIF as evaluator contracts

- Date: 2026-07-25
- Status: superseded
- Supersedes: none
- Superseded by: ADR-0025
- Related plan: `PLAN.md` §2.2, §3.3, §6.5

### Context

Terminal-Bench 2.1 is distributed and evaluated through Harbor. Leaderboard
integrity requires inspectable trajectories for passing trials.

### Decision

Pin Harbor for benchmark execution and store sanitized Agent Trajectory
Interchange Format records for trials.

### Alternatives

- Reimplement Terminal-Bench execution in TypeScript.
- Parse only scalar rewards.
- Invent a Dark Factory-specific trajectory format.

### Consequences

Dark Factory avoids duplicating benchmark semantics and retains interoperable
traces. The trusted evaluator must validate and sanitize ATIF before release.

### Evidence

- `https://www.harborframework.com/docs/agents`
- `https://www.harborframework.com/docs/agents/trajectory-format`

## ADR-0004 — Separate optimizer, controller, evaluator, and human trust zones

- Date: 2026-07-25
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §3

### Context

Claude must inspect failures and edit the harness but must never access graders,
tests, sandbox credentials, task-selection internals, or full-run authority.
Filesystem conventions alone are insufficient.

### Decision

Use separate processes, filesystem roots, credential scopes, and tool
interfaces for four trust zones. Prefer a remote trusted evaluator so benchmark
graders never land on the Mac.

### Alternatives

- Run all components in one process with path allowlists.
- Store graders locally with Unix permissions.
- Encrypt raw grader files but give one process both keys and Claude access.

### Consequences

The system requires a signed minimal result envelope and a trusted sanitizer.
Claude receives only its worktree and audited MCP evidence tools.

### Evidence

- Terminal-Bench integrity policy
- Requirement that Dark Factory never access graders

## ADR-0005 — Persist sanitized evaluator output only

- Date: 2026-07-25
- Status: superseded
- Supersedes: none
- Superseded by: ADR-0025
- Related plan: `PLAN.md` §3.3, §8.1

### Context

Local retention of raw verifier output could accidentally disclose grader
semantics during later evidence retrieval or filesystem exploration.

### Decision

Persist only reward, outcome status, timing, cost, resources, sanitized ATIF,
non-grader failure classes, and an integrity attestation. Destroy raw verifier
output after sanitization.

### Alternatives

- Store an encrypted human-only raw vault.
- Store raw output under restrictive filesystem permissions.
- Store all Harbor job directories.

### Consequences

Some post-hoc grader debugging is intentionally impossible. The evaluator must
produce strong attestations, and failures in sanitization fail closed.

### Evidence

- Explicit user choice: sanitized outputs only
- Terminal-Bench examples of exposed `tests/` invalidating submissions

## ADR-0006 — Use local strict JSON as the source of truth

- Date: 2026-07-25
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §6

### Context

Every experiment needs durable, transparent, machine-readable evidence. Claude
needs narrow queries, while humans need directly inspectable records.

### Decision

Store experiment evidence in versioned, strict JSON/JSONL validated with JSON
Schema Draft 2020-12. Use canonical JSON, SHA-256, atomic writes, amendments,
and a hash chain. Use SQLite only as a disposable local query index.

### Alternatives

- SQLite as the primary store.
- A hosted database.
- Unstructured Markdown and logs.
- A document store with implicit schemas.

### Consequences

The store is portable and replayable but requires explicit schema migrations
and careful artifact management. Large records remain local and are not pushed
with application source.

### Evidence

- Requirement for several strict-schema JSON files in every experiment
- Requirement to store evidence locally

## ADR-0007 — Dark Factory selects tasks, not Claude Code

- Date: 2026-07-25
- Status: superseded
- Supersedes: none
- Superseded by: ADR-0019
- Related plan: `PLAN.md` §7

### Context

Letting the optimizer choose tasks creates a direct path to cherry-picking,
overexposure, and reward hacking.

### Decision

Use a deterministic controller-owned selector based on hardness, uncertainty,
discrimination, relevance, underexposure, capability coverage, cost, and recent
repetition. Claude receives only pseudonymous briefs.

### Alternatives

- Let Claude request tasks.
- Use a permanently fixed hard subset.
- Uniformly sample every experiment.
- Run all tasks for every candidate.

### Consequences

The selector becomes security- and research-critical and needs property tests.
At least 20% of task slots remain forced exploration.

### Evidence

- Explicit user direction that Dark Factory decides tasks and tells Claude
- Cost and anti-overfitting requirements

## ADR-0008 — Use development, rotation, and shadow pools

- Date: 2026-07-25
- Status: superseded
- Supersedes: none
- Superseded by: ADR-0019
- Related plan: `PLAN.md` §7

### Context

Optimizing repeatedly against one hard subset would overfit even without
grader access.

### Decision

Maintain secret deterministic development, rotation, and shadow pools.
Experiment-scoped pseudonyms hide identities and membership. Use shadow
evidence sparingly and expose only aggregates to Claude.

### Alternatives

- One public development subset.
- A single permanent holdout revealed at the end.
- Repartition tasks every experiment.

### Consequences

The controller needs a protected pool mapping and exposure ledger. Promotion
requires cross-stratum confirmation.

### Evidence

- Anti-overfitting requirement
- Need to rotate subsets without running all tasks

## ADR-0009 — Use matched staged racing

- Date: 2026-07-25
- Status: superseded
- Supersedes: none
- Superseded by: ADR-0020 for arm ordering; ADR-0024 for cache-aware staging
  and attempt accounting
- Related plan: `PLAN.md` §7.1

### Context

Running every task five times per candidate is unaffordable. Single unpaired
results are too noisy for promotion.

### Decision

Compare candidate and champion on matched randomized pairs: four smoke pairs,
four challenge pairs, and up to four confirmation pairs. Smoke cannot promote.
Ambiguous maximum-stage results are inconclusive.

### Alternatives

- Full benchmark per change.
- One task or one trial per experiment.
- Reuse all historical champion results without drift checks.
- Promote the highest observed score.

### Consequences

One experiment normally consumes 8-24 individual trials. The system spends
more only on candidates that survive early gates and requires protocol-safe
reuse.

### Evidence

- User requirement to avoid all-task five-trial runs
- Need for matched causal evidence

## ADR-0010 — Run campaigns indefinitely but bound each hypothesis

- Date: 2026-07-25
- Status: superseded
- Supersedes: none
- Superseded by: ADR-0028
- Related plan: `PLAN.md` §5.1, §7.1

### Context

The operator wants Dark Factory to work until manually stopped rather than
ending at an experiment, time, or total-cost cap.

### Decision

Apply no campaign-level limit. Keep official task timeouts and the maximum
twelve matched pairs per experiment. Continuously report cumulative resource
and monetary use.

### Alternatives

- Fixed campaign limits.
- Require approval before every experiment.
- Allow unbounded work within a single experiment.

### Consequences

The stop/resume path is a core feature. A provider or individual trial still
needs safe timeouts and cancellation.

### Evidence

- Explicit user choice: run indefinitely until stopped

## ADR-0011 — Resume only from the last fully sealed experiment

- Date: 2026-07-25
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §5.1

### Context

The process may be interrupted at any moment. Resuming partial mutations or
partially aggregated results could corrupt causal history.

### Decision

On interruption, preserve the in-flight attempt for audit but never promote it.
Validate the hash chain, restore the last sealed champion, archive the partial
attempt, allocate a fresh number, and continue.

### Alternatives

- Resume the exact partial experiment.
- Discard all partial evidence.
- Reuse the interrupted experiment number.

### Consequences

Some completed task trials may be intentionally abandoned. Experiment numbers
remain unique, and sealed history is always a consistent checkpoint.

### Evidence

- Explicit user restart requirement

## ADR-0012 — Give Claude tiered, pseudonymous evidence

- Date: 2026-07-25
- Status: superseded
- Supersedes: none
- Superseded by: ADR-0021
- Related plan: `PLAN.md` §8.2, §9

### Context

Full sanitized trajectories accelerate diagnosis but increase task exposure.
Summary-only evidence may be too weak to improve the harness.

### Decision

Default to aggregates and bounded excerpts through audited MCP tools. Hide task
names, mappings, and pool membership. Count and justify every drill-down.

### Alternatives

- Direct access to all sanitized files.
- Full sanitized trajectories by default.
- Automated summaries only.

### Consequences

The MCP server must support relevant retrieval and token limits. The optimizer
cannot use arbitrary SQL or filesystem reads to bypass the policy.

### Evidence

- Explicit user choice: tiered and pseudonymous evidence

## ADR-0013 — Package optimizer behavior as Claude skills, tools, and hooks

- Date: 2026-07-25
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §9

### Context

The optimizer needs specialized research, evidence, Pi, statistics, integrity,
and documentation behavior. Prompt text alone cannot enforce access controls.

### Decision

Create a project-local Claude Code plugin with eight focused skills, bounded MCP
tools, protected-path permissions, pre/post-tool hooks, and completion gates.

### Alternatives

- One large `CLAUDE.md`.
- An unconstrained Claude Code session.
- A custom optimizer agent unrelated to Claude Code.

### Consequences

Plugin triggering and permissions become tested interfaces. Claude can edit Pi
but cannot commit, push, select tasks, call Harbor, access the web, or authorize
the full benchmark.

### Evidence

- Requirement for specially crafted Claude Code skills/tools/plugins
- Claude Code plugin and skill architecture

## ADR-0014 — Prefer Daytona, with E2B and Modal fallbacks

- Date: 2026-07-25
- Status: superseded
- Supersedes: none
- Superseded by: ADR-0018
- Related plan: `PLAN.md` §2.3

### Context

The Mac should orchestrate locally, while Terminal-Bench tasks may require
Linux, x86, nested containers, large memory, or GPUs.

### Decision

Default to Daytona after a capability probe. Use E2B for suitable CPU/network
isolated tasks, Modal for GPU or larger-resource tasks, and local Docker for
fixtures and verified-compatible development tasks.

### Alternatives

- Strictly local Docker.
- One mandatory cloud provider.
- Build a custom sandbox service.

### Consequences

Every provider implements the same contract, and candidate/champion pairs never
cross providers. Provider-specific failures are invalid and quarantined.

### Evidence

- User choice: local orchestration with sandboxed task execution
- Harbor-supported provider ecosystem

## ADR-0015 — Require a human-only full-evaluation gate

- Date: 2026-07-25
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §10.1

### Context

The official 89-task, five-trial run is expensive and must happen only when the
operator decides the harness is ready.

### Decision

Separate prepare, authorize, and run commands. Require a one-time random
challenge, interactive TTY, exact protocol confirmation, short TTL, and
authorization stored outside Claude's scope. Expose no full-run MCP tool.

### Alternatives

- Let the campaign trigger a full run at a score threshold.
- Use a config boolean.
- Require a normal CLI `--yes` flag.

### Consequences

Automation cannot claim or initiate a leaderboard run. Critical authorization
code requires 100% branch coverage and replay-resistance tests.

### Evidence

- Explicit user instruction that the full run happens only on user decision

## ADR-0016 — Make `FEEDBACK.md` generated and append-only

- Date: 2026-07-25
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §11

### Context

The operator needs a readable comparison after every experiment without making
Markdown the authoritative evidence store.

### Decision

Generate exactly one feedback entry after every sealed experiment from
`feedback-entry.json`. Compare against parent, chronological predecessor, and
experiment `000`. Permit deterministic rebuild.

### Alternatives

- Update one mutable dashboard row.
- Let Claude write free-form feedback.
- Store comparisons only in JSON.

### Consequences

Feedback rendering needs golden and idempotency tests. Interrupted experiments
produce no entry until a replacement experiment seals.

### Evidence

- Explicit user requirement for per-experiment feedback

## ADR-0017 — Apply thorough staged testing

- Date: 2026-07-25
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §12

### Context

Dark Factory controls expensive evaluations, autonomous code edits, benchmark
integrity, secrets, and durable research evidence. Failures can silently
invalidate results.

### Decision

Require unit, contract, property, integration, provider, security, replay, and
end-to-end tests. Target 90% line/branch coverage for core modules and 100%
branch coverage for grader isolation, sealing, protected paths, and full-run
authorization.

### Alternatives

- Unit tests only.
- End-to-end tests only.
- No coverage requirements.

### Consequences

Implementation proceeds in gated phases. Paid live tests remain opt-in;
synthetic fixtures cover normal CI.

### Evidence

- Requirement for thorough testing at each stage

## ADR-0018 — Run every executable workload in cloud sandboxes

- Date: 2026-07-25
- Status: superseded
- Supersedes: ADR-0014
- Superseded by: ADR-0039
- Related plan: `PLAN.md` §2.3, §12

### Context

The Mac should remain an orchestration and evidence workstation. Running
candidate builds, tests, synthetic fixtures, Pi, Harbor, or benchmark tasks
locally creates resource, isolation, architecture, and grader-boundary risks.

### Decision

Use no local execution backend. Run all candidate builds and tests, synthetic
tasks and graders, Pi processes, Harbor processes, integrity checks that execute
candidate code, and Terminal-Bench trials in Daytona, E2B, Modal, or cloud CI.
The Mac may run only the TypeScript orchestrator, Claude Code source-editing
session, local evidence persistence, and operator UI.

Daytona remains the preferred general provider, E2B the CPU/network-policy
fallback, and Modal the large-resource/GPU provider.

### Alternatives

- Use local Docker for fixtures and compatible benchmark tasks.
- Run candidate unit tests locally but evaluations remotely.
- Move the complete control plane and evidence store to the cloud.

### Consequences

There is no Docker/local provider adapter. Cloud availability is required even
for synthetic end-to-end validation. Provider and cloud-CI contracts must make
development feedback efficient, while sanitized evidence remains local.

### Evidence

- User requirement: nothing in the sandbox policy should run on the Mac
- Earlier decision to keep orchestration local while task execution uses cloud
  sandboxes

## ADR-0019 — Put task identity and selection in a blind cloud broker

- Date: 2026-07-25
- Status: accepted
- Supersedes: ADR-0007, ADR-0008
- Superseded by: none
- Related plan: `PLAN.md` §3.3, §7

### Context

Keeping task mappings in the local controller still gives Dark Factory
knowledge of the tasks it may later be tested against. Hiding names only from
Claude is not a sufficiently strong blindness guarantee.

### Decision

Move the task catalog, names, instructions, identities, pool membership,
exposure history, baseline outcomes, and selection weights into a trusted cloud
task broker colocated with the evaluator. Dark Factory submits a versioned
policy, changed-component taxonomy, evaluation stage, and resource ceiling. It
receives only an opaque batch attestation and task-agnostic aggregate results.

The evaluated Pi process necessarily receives one task instruction transiently
inside its isolated cloud sandbox. That instruction and its identifying trace
content never return to Dark Factory or Claude. The final 89-task list remains
equally hidden.

### Alternatives

- Let the local Dark Factory controller own task identities while hiding them
  from Claude.
- Use stable pseudonyms locally.
- Reveal development tasks but hide only a final holdout.

### Consequences

Local experiment JSON cannot contain task mappings or stable task identifiers.
One-use trial handles may join artifacts within one experiment but cannot be
correlated across experiments. Baseline and exposure comparisons are computed
by the broker and returned only as aggregates.

### Evidence

- User requirement that Dark Factory never know the actual tested tasks
- Need to prevent task-conditioned optimization and final-set leakage

## ADR-0020 — Use deterministic failure-weighted task scheduling

- Date: 2026-07-25
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §7, §7.1

### Context

Uniform or pseudorandom task subsets waste budget on tasks that already pass
reliably. A fixed hard subset overfits. Easy tasks still provide important
reward-hacking and broad-regression signals.

### Decision

The blind broker builds every task batch deterministically:

- 60% failure-weighted hard tasks.
- 20% uncertain or configuration-discriminating tasks.
- 10% easy integrity canaries.
- 10% underexposed capability coverage.

Failure weighting combines the broker's previous champion/baseline failures and
per-task failure rates for a chosen comparable public leaderboard baseline when
available. Within each quota, use stable descending priority and deterministic
exposure-age round-robin tie-breaking. Give every task a nonzero eligibility
floor and penalize repeated consecutive exposure.

Use deterministic AB/BA counterbalancing for candidate/champion order rather
than pseudorandom arm order.

### Alternatives

- Uniform random or pseudorandom sampling.
- Always run only the hardest tasks.
- Let Claude choose tasks related to its hypothesis.
- Use one fixed development subset.

### Consequences

Earlier failures receive more evaluation budget, while easy tasks continue to
appear as integrity canaries. The broker policy, leaderboard baseline choice,
weights, quotas, and tie-breaking version become part of the protocol hash.

### Evidence

- User requirement for weighted failure-focused task lists
- User requirement that easy tasks remain present to fight reward hacking

## ADR-0021 — Release only task-agnostic behavioral evidence

- Date: 2026-07-25
- Status: superseded
- Supersedes: ADR-0012
- Superseded by: ADR-0025
- Related plan: `PLAN.md` §3.3, §8.2, §9

### Context

Even a sanitized full trajectory can disclose a task through its instruction,
paths, commands, filenames, outputs, URLs, or persistent pseudonym. Tiered
access alone does not ensure task blindness.

### Decision

Before releasing evidence, remove task instructions, names, task-identifying
paths, commands, filenames, outputs, URLs, and stable identifiers. Give Dark
Factory and Claude task-agnostic aggregates, behavioral failure classes, and
bounded redacted excerpts only. Keep all cross-experiment correlation and
exposure accounting inside the cloud broker.

### Alternatives

- Full sanitized trajectories with task names removed.
- Stable pseudonymous tasks and bounded excerpts.
- Summary-only scalar rewards without behavioral evidence.

### Consequences

Diagnosis becomes less task-specific and therefore may be slower, but proposed
harness changes must generalize. The sanitizer requires adversarial
re-identification tests in addition to grader-canary tests.

### Evidence

- User requirement that Dark Factory have no idea of the tested tasks
- Task details leak through more channels than explicit task IDs

## ADR-0022 — Compile task-aware traces into cross-task failure cards

- Date: 2026-07-25
- Status: superseded
- Supersedes: none
- Superseded by: ADR-0025
- Related plan: `PLAN.md` §3.3, §6.6, §8.2, §9

### Context

Scalar scores and aggressively stripped trajectories do not provide enough
information for Claude Code to decide how to improve the harness. Conversely,
releasing full sanitized trajectories can reveal actual tasks. Effective
optimization necessarily receives some information about harness behavior,
even when task identity remains hidden.

### Decision

Create a trusted cloud diagnostic compiler. It sees full tasks, ATIF, outcomes,
and environment data only inside the evaluator zone. It extracts behavioral
telemetry, clusters equivalent failures across tasks, and releases a strict
failure card only after at least three distinct tasks support the cluster.

Failure cards may contain:

- Approved generic failure modes.
- Cohort size, difficulty band, confidence, and prevalence.
- Tool-category, exit-class, retry, timing, token, stop, and verification
  distributions.
- Aggregate successful/failed and candidate/champion contrasts.
- Likely harness surfaces.
- Typed behavioral excerpts without raw literals.

They may not contain task identities, instructions, repositories, stable
pseudonyms, literal commands or arguments, paths, filenames, URLs, unique
constants, raw or expected outputs, grader messages, or single-trial
drill-downs.

Clusters below the three-task threshold remain private. Every released card
must pass schema validation, grader canaries, identity-leak scanning, and
adversarial re-identification checks.

### Alternatives

- Give Claude scalar rewards only.
- Give Claude full sanitized task trajectories.
- Reveal task-specific development traces but hide only the final set.
- Let Claude query one anonymous task at a time.

### Consequences

Claude receives actionable evidence about planning, recovery, tool use,
compaction, verification, termination, and time allocation while remaining
blind to concrete tasks. Some rare but important single-task failures will not
be diagnosable until they form a sufficiently large cluster. The diagnostic
taxonomy and compiler version become part of the protocol hash.

### Evidence

- User observation that a fully task-blind scalar signal is insufficient to
  improve the harness
- Need to distinguish task-identity secrecy from harness-behavior observability

## ADR-0023 — Cache champion outcomes for screening, never promotion

- Date: 2026-07-25
- Status: superseded
- Supersedes: none
- Superseded by: ADR-0026
- Related plan: `PLAN.md` §6.6, §7.1, §7.2

### Context

Freshly rerunning the current champion for every candidate roughly doubles
evaluation cost. Reusing an incumbent result can make early screening cheaper,
but benchmark outcomes are stochastic and can drift when the model, evaluator,
sandbox, resources, network policy, or evaluation protocol changes. A cached
champion result must therefore be treated as historical evidence rather than
as interchangeable with a concurrent control.

The task identifiers required to address cache entries are themselves secret.
Keeping the cache on the local Mac or exposing its keys to Claude Code would
also create a task-recognition channel.

### Decision

The blind cloud broker owns a champion-result cache. Dark Factory and Claude
Code cannot read its task keys or individual records.

Each cache key includes the hidden task revision or content digest, champion
commit and configuration, exact evaluated model and provider version,
reasoning, sampling, and context settings, dataset and Harbor versions,
sandbox provider, image, architecture, resources, and region, network policy,
and the complete evaluation protocol hash. Any mismatch is a cache miss.

A cache entry stores a distribution, not a single score: valid attempts,
passes, failures, partial rewards, invalid attempts, uncertainty, timestamps,
freshness, cost, latency, token and tool-use distributions, and environment
fingerprints. Freshness, variance, or detected environmental drift may
invalidate an otherwise matching entry.

The MVP cache ceiling is seven days, divided into `0-24h`, `1-3d`, and `3-7d`
attestation bands. Weak environment or provider fingerprints may shorten that
ceiling. Any change to these limits creates a new cache-policy version and
protocol hash.

Cached results may only be used during inexpensive screening. They may reject,
deprioritize, or advance a candidate to confirmation, but they never count
toward promotion evidence. For each reused cohort, the broker schedules
deterministic fresh champion drift anchors covering at least 25% of reused
tasks, with a minimum of one. A failed drift check invalidates the affected
cohort and forces fresh execution.

Promotion requires at least 12 valid, fresh, same-window matched pairs in which
both the candidate and champion are newly evaluated under the same sealed
protocol. Cached comparisons are excluded from this minimum and from the final
promotion test.

The sealed pair window is at most 24 hours and requires matching protocol and
compatible environment fingerprints. A fresh candidate arm from
smoke/challenge may be retained while the broker runs its missing fresh
champion arm; the candidate need not be rerun merely because screening used a
cached champion result. Infrastructure-invalid arms receive one replacement
attempt before the experiment becomes inconclusive.

After promotion, the candidate's fresh results remain keyed by its exact commit
and protocol and therefore seed the cache for the new champion without
relabeling records or exposing task mappings.

The broker releases only a task-agnostic cache attestation containing the cache
policy version, protocol hash, reused counts, freshness bands, drift-anchor
counts and status, invalidations, retained candidate-arm and newly completed
champion-arm counts, sealed-window bounds, retries, and fresh promotion-pair
count. It contains no hidden task keys, stable pseudonyms, or record-level
results. The broker binds its canonical hash into the signed result envelope.

### Alternatives

- Never cache champion outcomes.
- Treat a cached scalar score as the current champion result.
- Permit promotion directly against cached champion outcomes.
- Store the cache locally with anonymized task identifiers.
- Refresh every cached task before any screening decision.

### Consequences

Most weak candidates can be screened without rerunning every champion trial,
while every champion change still rests on a fair concurrent comparison.
Stale but not-yet-detected cache evidence can cause a promising candidate to be
screened out, but cannot make a candidate champion. Drift anchors add some
cost. Reusing eligible candidate arms avoids redundant confirmation work, and
cache policy and schema versions become part of the protocol hash.

### Evidence

- User request to reuse prior champion results when hidden tasks recur
- Prior decision that candidate and champion must be compared on the same
  hidden subset
- Need to control stochastic variance and environmental drift without exposing
  task identity

## ADR-0024 — Use a presealed, cache-aware matched race

- Date: 2026-07-25
- Status: superseded
- Supersedes: ADR-0009
- Superseded by: ADR-0026
- Refines: ADR-0020, ADR-0023
- Related plan: `PLAN.md` §6.6, §7.1, §7.2, §12

### Context

Naively retaining candidate arms from cache-assisted screening would make those
pairs candidate-first, defeating the deterministic AB/BA counterbalance.
Choosing confirmation tasks or repeats after observing early results would
also introduce selection bias. The prior trial count did not distinguish valid
promotion arms, infrastructure replacements, drift work, and baseline
maintenance.

Cache freshness and “drift” also need reproducible meanings. An entry-level
timestamp could let one new result keep stale observations alive, and an
undefined cohort or drift threshold would make reruns and invalidations
operator-dependent.

### Decision

Before any execution, the blind broker seals twelve hidden task slots, their
strata, stage assignment, and alternating AB/BA order. Staging controls cost;
early outcomes never select the remaining tasks.

For an AB slot, the candidate runs first and may be screened against an
eligible cached champion distribution. For a BA slot, the champion runs fresh
first, doubles as a deterministic drift anchor when applicable, and is followed
by the candidate. A surviving candidate later receives the missing fresh
champion arms for AB slots. The twelve promotion pairs are therefore fresh,
disjoint, and evenly counterbalanced without rerunning an eligible candidate
arm. Outcome-driven repeats are prohibited.

The valid candidate/champion-arm budget is six to eight for smoke, twelve to
sixteen through challenge, and exactly 24 for a promotion decision. Permit at
most one retry per infrastructure-invalid arm, four such retries globally, and
two separate experiment-`000` baseline-maintenance attempts. The evaluator
hard ceiling is 30 task attempts. Drift anchors overlap scheduled champion
arms. Baseline work never affects promotion.

Cache observations are immutable, individually aged, signed, schema-valid,
infrastructure-valid, and attempt-digest deduplicated. The MVP ceiling is seven
days; newer observations do not extend older ones. Rejected candidates cannot
be addressed through the current-champion cache role. A mixed-age distribution
uses its oldest included observation's freshness band, requires at least one
valid observation, and is ineligible when its 95% Jeffreys credible interval is
wider than `0.90`.

Screening uses equal-task-weighted Jeffreys beta posteriors and deterministic
quadrature over candidate-minus-champion binary accuracy. It can reject for
futility only when `P(accuracyDelta <= -0.10) >= 0.95`; it cannot promote.

Promotion uses a stratum-weighted paired Dirichlet-Jeffreys posterior over the
four binary pair outcomes. It requires twelve fresh presealed pairs,
`P(weightedAccuracyDelta > 0) >= 0.95`, a posterior median delta of at least
`0.05`, and no stratum whose probability of a worse-than-`0.10` regression
exceeds `0.80`, in addition to integrity, cost, and latency guardrails.

A drift cohort shares every non-task cache-key field, freshness band,
difficulty stratum, and capability stratum. For each nonempty cache-hit cohort,
the broker chooses
`max(1, ceil(0.25 * cacheHitCount))` anchors deterministically, preferring
presealed BA slots. It computes the exact Bernoulli predictive-surprise tail
defined in the plan and invalidates the cohort at `p <= 0.01` or on an
environment/provider fingerprint mismatch.

Only a task-agnostic aggregate attestation leaves the broker. Its canonical
hash is bound into the signed result envelope, and its schema prohibits task
keys, record outcomes, cohort join keys, and stable cross-experiment
identifiers.

### Alternatives

- Discard all screening candidate arms and rerun both arms in confirmation.
- Retain all candidate-first screening arms without counterbalancing.
- Choose confirmation tasks and repeats in response to observed failures.
- Use operator judgment for cache freshness and drift.
- Leave invalid and baseline attempts outside a hard experiment ceiling.

### Consequences

Weak candidates usually stop after six cache-assisted valid arms rather than
eight fully paired arms. Candidates reaching promotion still pay for twelve
fresh pairs, because cache controls screening cost rather than evidentiary
quality. Presealing prevents outcome-driven task selection, and exact
statistics make replay deterministic. The 30-attempt ceiling and conservative
futility rule may produce more inconclusive experiments, but cost and false
promotion risk remain bounded.

### Evidence

- Independent consistency audit of cache reuse, counterbalancing, drift, and
  trial accounting
- User requirement to reduce repeated champion cost without comparing
  candidates on unequal evidence
- Task-blindness and reward-hacking constraints

## ADR-0025 — Normalize behavioral evidence before interpretation

- Date: 2026-07-26
- Status: accepted
- Supersedes: ADR-0003 storage/release semantics, ADR-0005, ADR-0021, ADR-0022
- Superseded by: none
- Related plan: `PLAN.md` §3.3, §6.5–6.6, §8.1–8.2, §9, §12

### Context

Claude needs information about generic harness failures to improve Pi, but a
"sanitized" per-trial trajectory can still reveal a task through commands,
paths, file contents, outputs, package names, error strings, or the shape of a
grader response. An LLM asked to strip sensitive information is probabilistic
and cannot be the security boundary or the source of authoritative statistics.
Repeated filtered queries can also reconstruct a hidden cohort by differencing.

### Decision

Keep raw graders, verifier output, task-aware ATIF, and row-level normalized
records in the trusted cloud evaluator only. They are ephemeral and are
destroyed or quarantined under a short, frozen retention policy after signed
derivation. Neither raw nor sanitized per-trial ATIF is valid local evidence.
Harbor remains the pinned evaluator contract and ATIF remains the trusted-cloud
trajectory interchange contract; this supersedes only ADR-0003's local
sanitized-ATIF storage/release decision.

Run a deterministic `NormalizedGraderOutcome` adapter first. Its allowlist is
limited to `pass | fail | invalid`, reward clamped to `[0,1]`, a broad
infrastructure-invalid class or `null`, integrity status, coarse elapsed-time
and resource buckets, protocol/environment hashes, and signed
attempt/derivation hashes. It rejects test names and counts, assertions,
expected/actual values, subtest structure, messages, paths, identifiers, and
all grader prose.

Run a deterministic behavioral extractor over raw ATIF inside the same trusted
zone. It may emit only generic tool categories, invocation validity,
exit-status classes, retries/repeated actions, output-inspection behavior,
recovery/replan transitions, verification, planning/action/token/time buckets,
context/compaction events, stop reason, timeout/premature completion, and
generic read/write/execute ordering. It drops commands and arguments, paths,
filenames, file contents, stdout/stderr, URLs, package/service names,
environment variables, unique literals, task IDs, and stable pseudonyms before
any local persistence.

A deterministic Behavioral Evidence Engine owns all statistics and release
decisions. A card requires:

- At least five distinct contributing tasks.
- At least 20 total trajectories in its analysis window.
- At least five observations in every compared group.

Subthreshold findings remain private or are suppressed; small counts are
binned. Complementary-count suppression, cumulative overlap/query budgets,
grader canaries, stable-feature scans, and re-identification/differencing tests
run before one sealed release per eligible experiment.

`diagnostic-brief.json` is the only benchmark-derived feedback package readable
by Claude. It binds its source experiment, aggregate-evidence hash, engine and
taxonomy versions, ranked generic cards, effect estimates, uncertainty,
suppression status, and evidence hashes. It has no rows, task handles,
membership, cohort joins, or literals.

An optional LLM may read only already released aggregate cards. It may
summarize or rank them, but cannot add statistics or unsupported claims; every
statement cites a card ID. Disabling it cannot change evaluation or promotion.
A five-task, one-run repair gate is below the release threshold and therefore
returns only a signed gate disposition, integrity state, and aggregate cost,
not a new diagnostic brief.

### Alternatives

- Give the intermediate LLM raw grader data and trust it to redact correctly.
- Store per-trial "sanitized" ATIF locally.
- Return only pass/fail scores with no behavioral evidence.
- Permit interactive filtered queries into normalized rows.

### Consequences

Claude learns correlations such as repeated nonzero exits without inspection or
replanning, while remaining unable to see which task, command, file, package,
or expected result was involved. Rare failure modes take longer to become
visible and some useful findings will be suppressed. The deterministic
normalizer, extractor, taxonomy, statistical engine, privacy policy, and
retention policy all become protocol-hash inputs and require adversarial tests.

### Evidence

- User request for useful non-sensitive feedback from grader and trace data
- User requirement that neither Pi nor Dark Factory know the actual tasks
- Review finding that an LLM sanitizer is not a reliable security boundary
- Need to resist single-task inference and repeated-query differencing

## ADR-0026 — Use walk-forward repair and fresh validation

- Date: 2026-07-26
- Status: accepted
- Supersedes: ADR-0023 evaluation-flow semantics, ADR-0024
- Superseded by: none
- Refines: ADR-0019, ADR-0020, ADR-0025
- Related plan: `PLAN.md` §5, §7–7.3, §8, §11–13

### Context

Comparing scores from two different hidden subsets confounds harness quality
with subset difficulty. Conversely, repeatedly promoting on a panel after
Claude has seen feedback derived from it converts the holdout into training
data. The system needs to reuse hard tasks cheaply for learning while reserving
independent matched evidence for champion decisions.

### Decision

Use four explicit states:

- **Candidate:** edited descendant of the active champion.
- **Challenger:** candidate that passed the old-panel repair gate.
- **Active champion:** challenger that passed fresh matched validation and
  becomes the next research parent.
- **Certified champion:** active champion that separately passed feedback-dark
  shadow and compliance gates.

Experiment `001` is the bootstrap. Claude sees Pi source but no
benchmark-derived evidence, freezes its hypothesis and candidate before task
selection, and may proceed directly to fresh validation against experiment
`000`.

Thereafter use this walk-forward loop:

1. Give Claude one signed diagnostic brief from the latest feedback-consumed
   discovery window.
2. Freeze the cited brief hash, causal hypothesis, predicted old-panel repair,
   predicted fresh-panel effect, falsification rules, and candidate commit
   before the broker selects a panel.
3. The broker chooses exactly five old-panel repair tasks: three hard, one
   uncertain/discriminating, and a fifth slot alternating easy-integrity and
   underexposed-coverage by epoch.
4. Run the candidate once per repair task. Compare with eligible exact-key
   active-champion cache distributions, using at least 25% deterministic fresh
   drift anchors and fresh champion arms on cache misses.
5. Repair passes only when
   `P(weightedAccuracyDelta >= -0.10) >= 0.80` plus either one confirmed
   fail-to-pass or preregistered target-behavior improvement on at least three
   of five, subject to hard integrity, capability, cost, and latency vetoes. A
   confirmed fail-to-pass requires a fresh candidate pass and fresh champion
   failure on a control slot presealed before outcomes; cache alone cannot
   label a binary transition. It creates a challenger, never a champion.
6. A discovery panel may support at most two distinct candidate commits. A
   failed five-by-one gate releases no new narrow diagnostic evidence; after
   two failures the hypothesis closes.
7. The broker then seals twelve validation tasks fresh to the frozen
   hypothesis and disjoint from its repair/evidence inputs, plus strata, six
   AB/six BA ordering, environment window, statistics, and budgets.
8. Run challenger and current active champion once per task. All 24 validation
   arms are fresh, same-window, protocol-compatible, and cache-free.
9. Only the twelve fresh paired deltas have positive promotion weight. Repair,
   cache, baseline, and historical evidence may veto or diagnose but cannot
   promote.
10. After any validation disposition, mark the panel consumed because the
    decision itself is feedback, then release only threshold-qualified
    aggregate diagnostics and rotate it. It may become repair/regression
    evidence, but never positive evidence for a candidate influenced by its
    feedback.

A sealed validation panel abandoned before any arm starts may return to
eligibility after an integrity audit. Once one arm starts, an abandoned panel
is quarantined/consumed and cannot return as positive validation.

Tasks are retained in the broker catalog. A just-consumed validation panel is
immediately eligible to supply the next five-task repair panel; that panel may
serve one candidate and one immediate revised candidate. After the second
attempt—or after the first candidate advances—its tasks enter a
three-sealed-experiment repair cooldown before ordinary repair/regression
reselection. They may later recur for repair, regression, canaries, cache
calibration, and monitoring, but not as positive validation for an influenced
candidate. This satisfies the desire to reuse failed tasks without treating
them as an independent holdout.

Retain ADR-0023's exact cache key, immutable distribution records,
per-observation seven-day freshness, uncertainty limit, signed deduplication,
and deterministic 25% drift-anchor mechanics. Supersede its smoke/challenge
reuse flow: cache is now repair-only, and no cached or retained repair arm may
enter fresh validation or shadow evidence.

Promotion uses the frozen stratified paired Dirichlet-Jeffreys thresholds: 12
fresh pairs, `P(weightedAccuracyDelta > 0) >= 0.95`, median delta at least
`0.05`, and the existing stratum regression boundary. Tasks are the independent
clusters; repetitions do not inflate sample size. A campaign-level online
error budget, calibrated under null simulations, also controls repeated
hypothesis testing.

The experiment's typical primary work is 30–31 attempts: five candidate repair
arms, normally one to two fresh champion drift anchors, and 24 validation
arms. On repair cache miss, up to five champion repair arms are allowed.
Together with at most four infrastructure replacements, the fail-closed maximum
is 38 attempts. Baseline maintenance is asynchronous and never affects
promotion.

Fresh validation results also prepare the next repair cheaply. On promotion,
the candidate's twelve arms seed the new active-champion cache. On rejection or
inconclusive evidence, the incumbent's twelve fresh arms refresh its cache.
Thus a five-task slice of the consumed panel normally has exact-key controls
available, subject to normal freshness and drift rules.

The repair panel runs once per task rather than three times per task. Three
repetitions would consume 15 candidate arms while still yielding only five
independent task clusters. The MVP spends that budget on broader fresh
validation; cached distributions, drift anchors, and later regression runs
accumulate stochastic evidence without inflating task-level sample size.

Before validation allocation, permanently reserve two disjoint twelve-task
shadow slices. Every third active promotion and before external release,
consume one unused slice in a feedback-dark 12-pair race between the active and
last certified champion, or experiment `000` as the initial comparison anchor.
For an 89-task benchmark, the reservation leaves at most five full twelve-task
fresh validation panels and five spare tasks; surface that limit before
campaign start.
The baseline anchor is not called a certified improvement. Shadow permits 24
valid arms plus at most four infrastructure replacements, for a ceiling of 28.
Claude receives only `certified | not-certified | inconclusive`, compliance
flags, and aggregate cost—no score or diagnostics. A shadow failure leaves the
certified pointer unchanged. After both slices are consumed, certification
pauses.

A validation task whose evidence informed the adaptive ancestry is not "fresh"
merely because time passed, the protocol changed, or a ledger/lineage was
renamed. Exposure is globally non-resettable across every descendant that
inherits code or decisions from that ancestry. When fewer than twelve genuinely
fresh validation tasks remain, pause positive promotion until truly unseen
external/synthetic validation exists, a pre-adaptation fork inheriting none of
the exposed code or decisions is used, or the benchmark owner approves
explicitly different semantics. Research on exposed tasks may continue, and
the human-only official evaluation remains separate.

### Alternatives

- Promote on whichever weighted subset score is highest.
- Re-run the same five tasks for both repair and promotion.
- Replace the incumbent score with a cached scalar.
- Rotate only after a candidate wins and retain failed validation panels as
  promotion tests.
- Never reuse any task for any purpose.

### Consequences

Matched validation removes subset-difficulty confounding. Old failures remain
cheap, useful repair data, but improvement on them alone cannot create a
champion. Consuming every decided panel—and quarantining every
started-abandoned panel—reduces adaptive holdout overfitting and winner's
curse. The extra validation arm cost is intentional; cache savings are confined
to repair. A finite benchmark supports only a finite amount of genuinely fresh
adaptive promotion, which the UI and attestations must show honestly.

### Evidence

- User question about fairly comparing iterations evaluated on different
  subsets
- User proposal to run candidate and incumbent on the same subset
- User request to cache incumbent results when tasks recur
- User proposal to feed sanitized failures into the next improvement
- Overfitting analysis distinguishing repair evidence from promotion evidence

## ADR-0027 — Separate research optimization from submission eligibility

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Refines: ADR-0015, ADR-0019, ADR-0025, ADR-0026
- Related plan: `PLAN.md` §1.1, §8.4, §10.1, §13–14

### Context

The published Terminal-Bench integrity rules clearly prohibit task-specific
information reaching an evaluated agent, but they do not explicitly approve
an adaptive meta-optimizer trained on sanitized benchmark-derived diagnostics.
Technical secrecy controls do not themselves establish leaderboard
eligibility.

### Decision

Every run is immutably `research` or `submission`. Research mode permits
privacy-thresholded diagnostic briefs and adaptive repair, but cannot start the
official evaluation or produce a leaderboard/state-of-the-art claim.
Submission mode disables diagnostic generation/retrieval, repair feedback,
optimizer MCP, and other adaptive channels; it accepts one frozen certified
commit and protocol behind the human authorization gate.

Record `leaderboardEligibility` as `unverified`, `cleared`, or
`strict-score-only`. The adaptive research lineage remains `unverified` until
written benchmark-owner clearance. `strict-score-only` is a separately
acceptable lane with no diagnostic feedback; merely switching a research
lineage to submission mode does not erase its training history.

Every official-run preparation requires a signed compliance manifest listing
the lineage, mode, enabled data channels, plugin permissions, task-role policy,
protocol hash, certified commit, and eligibility. Mixed-mode evidence,
research-enabled channels, uncertified state, or unverified eligibility fails
closed.

### Alternatives

- Assume aggregate diagnostics are automatically leaderboard-compliant.
- Ban all research use of Terminal-Bench.
- Hide the adaptive history when submitting.
- Treat human authorization alone as sufficient policy clearance.

### Consequences

The MVP can explore harness engineering honestly without claiming permission it
does not have. A leaderboard submission may require written clarification or a
separate score-only lineage. Compliance becomes testable and reviewable rather
than an informal operator judgment.

### Evidence

- Terminal-Bench leaderboard integrity policy
- User requirement that Dark Factory and Pi never learn actual tasks
- Ambiguity around sanitized meta-optimizer feedback under the published rules

## ADR-0028 — Require rolling campaign and evidence budgets

- Date: 2026-07-26
- Status: accepted
- Supersedes: ADR-0010
- Superseded by: none
- Related plan: `PLAN.md` §5.1, §7.1–7.3, §10, §14

### Context

An autonomous campaign with no monetary, token, time, statistical, privacy, or
fresh-holdout limit can spend indefinitely, accumulate false-positive pressure,
and exhaust the benchmark even though each individual hypothesis is bounded.

### Decision

Keep no fixed lifetime experiment count, but require operator-set rolling
monetary, token, and wall-time budgets. Also maintain non-resettable
campaign-level repeated-testing, privacy-query, and genuinely fresh holdout
budgets. The controller pauses safely rather than crossing any limit and
resumes only after a recorded, authorized budget decision or a new valid
lineage. Status surfaces all remaining and cumulative budgets.

### Alternatives

- Run until a manual interrupt with no cumulative controls.
- Impose a permanent fixed number of experiments.
- Track costs only after they are incurred.
- Reset statistical or privacy budgets on restart.

### Consequences

The loop remains operationally long-running while cost and evidence integrity
stay bounded. Operators must choose and document rolling limits. Stop/resume
must restore all budgets from sealed state, and changing statistical,
privacy, or holdout policy may require a new baseline lineage.

### Evidence

- User requirement that the demo be efficient and avoid expensive full runs
- Cloud-only execution creates direct external cost
- Repeated-testing, privacy-differencing, and finite-holdout risks

## ADR-0029 — Use the existing sibling private Pi fork

- Date: 2026-07-26
- Status: superseded
- Supersedes: ADR-0001
- Superseded by: ADR-0034
- Related plan: `PLAN.md` §2.1, §4, §10, §13–14

### Context

The operator has already forked Pi into a private Git repository and placed its
working copy in the `pi` folder beside `df-demo` under the ParallaxAI
directory. Creating a new fork, nested clone, or submodule would duplicate the
source of truth and could cause candidate branches or restore operations to
target the wrong repository.

Read-only inspection on 2026-07-26 confirmed that `../pi` is the Pi monorepo, is
clean on `main`, tracks a configured `origin`, and is at
`5bc1c2c0a6f07e00e8c240304182f213ab8d311f`. Only `origin` is configured; the
official upstream remote is absent. Repository privacy and push authorization
were supplied by the operator but have not yet been independently verified
through the remote provider.

### Decision

Continue using Pi as the harness under optimization, but make the existing
`../pi` repository the canonical private fork. Do not create a second fork,
reclone it into `df-demo`, or convert it into a submodule.

Initialization must:

1. Register and validate `../pi` without changing it.
2. Verify that the operator-designated origin is private and supports
   authenticated fetch/push, without logging or persisting a
   credential-bearing URL.
3. Add `badlogic/pi-mono` as a read-only `upstream` remote because it is
   currently missing.
4. Pin the reviewed fork commit, upstream base, Git tree, and
   repository-native lock hash when experiment `000` is created. The observed
   planning-time SHA is not automatically the baseline.
5. Create controller-owned candidate branches and external worktrees while
   never editing, cleaning, resetting, or force-pushing the canonical
   `../pi/main` worktree.

The Dark Factory controller continues to use pnpm. The Pi repository retains
its native npm/package-lock commands unless changing that workflow is itself a
frozen, tested harness hypothesis. Claude receives neither GitHub credentials
nor direct commit/push authority.

### Alternatives

- Create another private fork under a fixed GitHub owner.
- Reclone the existing origin under `df-demo`.
- Convert `../pi` into a submodule.
- Let candidates modify the canonical `main` worktree directly.
- Rewrite the Pi repository to pnpm during setup.

### Consequences

The existing private repository becomes the sole Git source of truth for Pi.
Setup work is smaller, but the controller needs registration and repository
identity checks instead of fork creation. The missing upstream remote and
remote privacy/push authorization remain explicit prerequisites. Dirty,
detached, unexpected, or unpublished canonical state fails closed so Dark
Factory cannot overwrite operator work.

### Evidence

- Operator statement that Pi was already forked privately into `ParallaxAI/pi`
- Local Git inspection: clean `main`, tracking `origin`, no `upstream`
- Local package metadata identifying the repository as `pi-monorepo`
- Planning-time commit
  `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`

## ADR-0030 — Make executable project checks cloud-only by construction

- Date: 2026-07-26
- Status: superseded
- Supersedes: none
- Superseded by: ADR-0039
- Related plan: `PLAN.md` §2.3, §12, §13

### Context

The operator requires builds, tests, synthetic fixtures, candidate processes,
Harbor, graders, and benchmark tasks to run on cloud infrastructure rather
than the Mac. A written convention alone is too easy to violate accidentally,
especially when standard package scripts normally execute wherever invoked.

### Decision

Every executable quality script first runs a fail-closed cloud guard. The
guard accepts an explicit sandbox marker or a recognized cloud-CI marker and
otherwise exits before invoking TypeScript, Biome, Vitest, or build tooling.
The repository includes a cloud CI workflow, and there is deliberately no
local provider adapter. Source editing, read-only inspection, orchestration,
and persistence of release-safe aggregates remain local control-plane
activities.

Dependency versions are exact in `package.json`; the lockfile must be
generated and verified by the first approved cloud install rather than by
executing an install on the Mac.

### Alternatives

- Rely only on operator discipline.
- Permit fast unit tests locally while reserving benchmark work for the cloud.
- Run candidate code through local Docker.

### Consequences

Accidental local execution fails early and visibly. Initial validation cannot
finish until cloud credentials or authenticated cloud CI are available. The
guard itself and provider-marker recognition require adversarial tests in the
cloud.

### Evidence

- `scripts/assert-cloud-execution.mjs`
- Cloud-prefixed package quality scripts
- `.github/workflows/ci.yml`

## ADR-0031 — Keep the Terminal-Bench adapter external to Pi and use RPC

- Date: 2026-07-26
- Status: superseded
- Supersedes: none
- Superseded by: ADR-0046
- Related plan: `PLAN.md` §2.1, §3, §8, §13

### Context

Read-only inspection of the private Pi fork found that its existing eval
package disables tools and is not a Terminal-Bench harness. Pi's coding-agent
runtime exposes JSON and RPC modes; RPC provides explicit abort, settlement,
events, and session statistics. Its raw RPC stream contains task instructions,
commands, tool arguments, paths, results, and model messages.

### Decision

Build each immutable Pi candidate once in a cloud builder, then launch a fresh
Pi process per task from an external trusted evaluator adapter. Use RPC mode
with no session persistence, no context files, no auto-discovered extensions,
skills, or prompt templates, and only an explicitly pinned Dark Factory
extension when the frozen experiment requires it. Enforce timeout and teardown
outside Pi.

Raw RPC traffic and ATIF remain in the trusted evaluator zone and never reach
the local experiment store or Claude Code. The task sandbox receives a built
artifact and short-lived inference access, not GitHub credentials.

### Alternatives

- Modify Pi's current eval package into the benchmark adapter.
- Embed Dark Factory control code in the Pi process.
- Use print-mode JSON as the only execution contract.
- Persist Pi sessions for later local analysis.

### Consequences

The adapter is independently testable and candidate mutations remain focused
on harness behavior. RPC lifecycle handling is more work than print mode, but
it allows reliable cancellation and structured trusted-zone extraction.

### Evidence

- Read-only Pi architecture and CLI/RPC audit on 2026-07-26
- Pi paths under `packages/coding-agent/src/modes/rpc/`
- No Harbor or Terminal-Bench adapter in the inspected fork

## ADR-0032 — Implement security and decision rules as deterministic pure cores

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §5–9, §12

### Context

Task selection, cache eligibility, privacy release, lifecycle transitions,
promotion, integrity checks, and full-evaluation authorization are security
and scientific-validity boundaries. If hidden inside provider code or an LLM
prompt, they are difficult to replay and may change with infrastructure.

### Decision

Implement these boundaries as deterministic, typed, side-effect-free cores
where possible. Provider, storage, signing, clock, process, and authorization
systems sit behind explicit interfaces. Persisted decisions bind policy
versions and inputs. Tests use fakes but execute only in approved cloud
environments.

An LLM may interpret already released aggregate cards but cannot sanitize raw
data, compute authoritative statistics, select tasks, or decide promotion.

### Alternatives

- Put policy directly into the orchestration loop.
- Ask the diagnostic LLM to sanitize and score traces.
- Make provider implementations own selection and promotion behavior.

### Consequences

The system is easier to replay, property-test, and audit across providers.
More explicit contracts and fixtures are required, but infrastructure changes
cannot silently change scientific decisions.

### Evidence

- Initial `src/core`, `src/integrity`, `src/evaluation`, and schema module
  boundaries
- Frozen policy requirements in `PLAN.md`

## ADR-0033 — Fail closed until cloud, model, budget, and trust-zone bindings are explicit

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §1, §2.3, §3, §5.1, §14

### Context

No Daytona, E2B, or Modal credential is currently configured; GitHub CLI
authentication is invalid; the exact Claude optimizer model and evaluated Pi
model are unset; and no rolling campaign spend limit has been supplied.
Guessing any of these would change cost, reproducibility, or a security
boundary.

### Decision

Continue only provider-neutral source implementation and synthetic fixtures.
Do not initialize the baseline, create remote resources, publish Git state,
run paid models, or launch benchmark work until the operator supplies and
confirms:

1. Cloud sandbox provider and credentials.
2. Exact optimizer and evaluated model identifiers/settings.
3. Rolling monetary, token, and wall-time limits.
4. Trusted broker/evaluator/storage/signing placement.
5. GitHub authentication and research-only eligibility posture.

All unresolved fields are required configuration values, never silent
defaults.

### Alternatives

- Choose inexpensive model and provider defaults automatically.
- Develop and test with a local execution backend.
- Start benchmark work with unbounded cost and record the values afterward.

### Consequences

Provider-neutral implementation can progress safely, but end-to-end validation
and real improvement evidence remain blocked on explicit operator input.

### Evidence

- Environment and CLI prerequisite audit on 2026-07-26
- Invalid GitHub CLI authentication status
- Missing sandbox-provider credential names
- Unset exact model and rolling-budget values

## ADR-0034 — Anchor candidate lineage to the private Pi fork without mutating it

- Date: 2026-07-26
- Status: accepted
- Supersedes: ADR-0029
- Superseded by: none
- Related plan: `PLAN.md` §2.1, §4, §10, §14

### Context

Later package metadata and remote inspection corrected two details recorded in
ADR-0001 and ADR-0029. The operator's canonical private origin is
`parallaxai/df-pi-tbench`, and the maintained public upstream is
`earendil-works/pi`. Adding or fetching an `upstream` remote in the local
canonical checkout would also violate the cloud-only and non-mutation
boundaries.

### Decision

Treat `/ParallaxAI/pi` as a read-only canonical reference and persist only the
workspace-relative registration path `pi`. Verify the private origin,
canonical public upstream, upstream head, and merge base through an isolated
cloud clone. Never add a remote, fetch, create a branch, build, test, or execute
candidate code in the local canonical checkout.

Claude Code edits a disposable candidate worktree whose changes are published
to the private origin under controller-owned non-force branches. Trusted cloud
snapshot and build services consume exact private-origin commits, produce
content-addressed source and runtime archives, and bind commit, tree, lockfile,
build policy, validation level, and toolchain attestations. Only a
release-validated runtime may enter matched Terminal-Bench evaluation.

### Alternatives

- Add the public upstream remote and fetch it in the local checkout.
- Continue referring to the historical `badlogic/pi-mono` location.
- Copy or vendor the private fork into `df-demo`.
- Build an archive from the local working tree.

### Consequences

The local Pi folder remains recoverable and free of automation side effects.
GitHub authentication and the cloud snapshot service become explicit runtime
prerequisites. Historical ADR text remains intact, while this amendment is the
authoritative source-lineage decision.

### Evidence

- Local origin: `git@github.com:parallaxai/df-pi-tbench.git`
- Local clean commit:
  `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`
- Package repository metadata: `https://github.com/earendil-works/pi`
- Implemented repository registration and cloud-build contracts

## ADR-0035 — Derive release-safe evidence and hidden weighting updates fail-closed

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §3.3, §6.5, §7.2, §8.1

### Context

The trusted evaluator must solve two requirements that cannot share a storage
boundary. Dark Factory needs a task-agnostic aggregate for promotion and
feedback, while the blind broker needs task-correlated outcomes so prior
failures receive more selection weight. Releasing task-correlated rows,
stable task handles, or raw grader/ATIF material to the controller would break
benchmark blindness. Omitting the private update would leave the documented
failure-weighted selector disconnected from real outcomes.

The codebase also had two incompatible meanings of
`NormalizedGraderOutcome`: the runtime normalizer used different field names
and enum values from the strict stored schema.

### Decision

Use one schema-backed `NormalizedGraderOutcome` representation. The trusted
normalizer accepts only scalar allowlisted grader fields plus separately
supplied raw-manifest provenance. It rejects grader prose and unknown fields,
buckets timing/resources, computes a derivation hash and content hash, and
validates the result against the strict schema before further use.

Reduce decoded Harbor, ATIF, and grader records through one deterministic
trusted deriver:

1. Correlate each attempt to an opaque presealed schedule arm and immutable
   harness archive.
2. Require contiguous, sequential infrastructure replacements followed by
   exactly one valid final outcome per arm.
3. Verify protocol, environment, panel window, balanced matched order, attempt
   ceiling, stratum weights, cache commitment, and behavioral-release source
   binding.
4. Compute repair, fresh validation, or feedback-dark shadow results using the
   frozen deterministic statistical gates.
5. Emit only a nonce-bound aggregate hash, signed-envelope payload fields, and
   boolean release checks. No task row, task ID, arm ID, command, output,
   grader prose, path, URL, or raw/sanitized ATIF may enter this aggregate.

Before returning that aggregate, publish a separate trusted-cloud-only catalog
update as a required fail-closed step. Its deterministic update ID and signed
source binding commit the request, protocol, panel disposition nonce, raw
manifest, Harbor job, runtime attestation, normalized outcome set,
environment, and task-correlated update-set hash. Each hidden task row contains
candidate and, when freshly run, champion pass/reward, infrastructure
replacement count, latency, token cost, sandbox/model cost, task revision, and
final attempt digest. Repair has no new champion row because its champion
control is historical/cache evidence.

The catalog sink performs durable compare-and-swap by update ID. An identical
source binding is idempotent; the same ID with a different binding fails
closed. The deriver verifies the signature and the sink receipt before any
release-safe aggregate can be signed. The hidden update is never attached to
the aggregate and is not locally persistable.

### Alternatives

- Add hidden task rows to the signed result envelope.
- Update task weights from release-safe aggregate scores.
- Let the catalog query raw Harbor artifacts independently.
- Maintain separate runtime and schema normalized-outcome models.
- Publish an unsigned best-effort catalog update after releasing the result.

### Consequences

Failure-weighted selection can learn from prior task outcomes without teaching
Dark Factory or Claude which tasks failed. Catalog ingestion becomes a required
trusted dependency: signature failure, source detachment, or a conflicting
idempotency receipt fails the evaluation rather than silently losing learning
history. The cloud composition must provide the hidden-update signing key,
verification key, and durable catalog adapter.

Source and adversarial synthetic tests cover deterministic hashes, repair,
validation, shadow, infrastructure replacements, raw literal suppression,
hidden-identity suppression, detached source signatures, detached commit
receipts, and idempotent replay. These tests remain unverified until the
cloud-only quality suite is run.

### Evidence

- `src/evaluation/behavior.ts`
- `src/evaluator/deriver.ts`
- `tests/evaluation/behavior.test.ts`
- `tests/evaluator/deriver.test.ts`

## ADR-0036 — Implement Daytona through a verifying trusted-cloud transport edge

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §2.3, §10, §12

### Context

The common provider contract previously stopped at an injected transport. A
real Daytona adapter must preserve the no-local-execution rule, immutable
images, exact matched resources, network denial, hard lifecycle bounds,
secret isolation, artifact integrity, cancellation, and resource reporting.
The current Daytona TypeScript API accepts a shell command string rather than
an argv array, represents memory and disk in whole GiB, represents TTL in
whole minutes, and exposes sampled CPU utilization rather than cumulative CPU
time. It maps sandbox environment variables to names of existing organization
Secrets; those names are not secret values.

The public SDK also has meaningful attestation limits. Region is selected by
the client target. Architecture is not a create parameter. Returned metadata
contains GPU count but is not sufficient to independently attest the exact GPU
type. A capability probe cannot prove account quota or image contents, and a
dynamic image build does not provide a signed provider receipt for the
original source digest.

### Decision

Pin `@daytona/sdk` exactly to `0.200.1` and load it only at the trusted
transport edge. Continue to resolve `DAYTONA_API_KEY` just in time for the SDK
client; never copy it into a sandbox. Pass the already validated immutable OCI
digest reference directly as the Daytona image.

Require the Daytona transport itself to call a mandatory trusted-runtime guard
before probe, create, execute, transfer, cancel, or destroy. There is no
permissive local artifact implementation. Put storage behind
`TrustedArtifactBackend` and wrap it with
`VerifyingTrustedArtifactBridge`. On reads, verify every byte, EOF, SHA-256,
and byte length. On writes, hash and count while streaming, then require the
backend's committed URI, media type, digest, and length to match. Partial
consumption is an integrity error.

Create only private ephemeral sandboxes with automatic stop and pause disabled
and a bounded whole-minute TTL. Use `networkBlockAll` when no egress is needed;
otherwise use the exact normalized domain allowlist. Require the configured
Daytona target to equal the requested region and refuse resource rounding.
After create, refresh provider data and verify target, CPU, memory, disk,
zero-GPU state, TTL deadline, network fields, private visibility, zero
auto-stop/pause/delete intervals, and the cloud runtime marker. Set that marker
to the returned sandbox ID and verify architecture with a fixed `uname -m`
command before issuing a lease.

Treat `SecretReference.sourceEnvironmentName` as the preconfigured Daytona
organization Secret name at this transport boundary. Daytona receives only a
target-environment-name to organization-Secret-name map. Execute one command
at a time per sandbox, attach only that command's approved subset, and detach
it after completion. Provider credentials and evaluated-model secret values
never enter command strings, labels, receipts, artifacts, or local logs.

Encode command argv with a dedicated POSIX single-quote function. Quote the
working directory, executable, every argument, and every plain environment
assignment. Reject NUL and malformed fields. The shell sees only the fixed
`cd`, `exec`, and `/usr/bin/env` structure; caller-controlled content remains
inside quoted argv elements.

Use Daytona background sessions for execution. Add an optional presealed
`RemoteCommandSpec.executionId`; when present, a caller can cancel while
`execute()` is pending. On cancellation or hard timeout, capture only bounded
trusted logs, request force-stop, fall back to confirmed deletion, and
quarantine the ephemeral sandbox. Do not emit a timeout/cancellation receipt
unless termination is confirmed. Persist stdout and stderr through the
trusted bridge and expose only their references.

Collect a metric before execution and while polling, then merge historical
samples on normal completion. Peak sampled memory is exact to Daytona's
sample. CPU time is an estimate obtained by trapezoidal integration of
`cpuUsedPct × allocated cores`; missing or malformed samples fail closed.

### Alternatives

- Execute Daytona command strings by joining unquoted argv.
- Resolve model credentials locally and pass their plaintext as `envVars`.
- Buffer or write `trusted://` artifacts in the workstation filesystem.
- Round MiB to Daytona GiB units or claim a requested architecture without
  checking the running sandbox.
- Treat session deletion alone as hard cancellation.
- Report zero resource usage when the metrics service fails.
- Claim GPU compatibility from GPU count without exact type attestation.

### Consequences

Daytona CPU sandboxes now have an executable production composition with
defense-in-depth checks and adversarial pure/contract tests. Cancellation is
scientifically explicit: callers must preseal an execution ID if they need to
address a pending command, and a cancelled/timed-out ephemeral sandbox cannot
be reused.

Several deployment gates remain open and are intentionally visible in
`TODO.md`: bind a durable trusted artifact backend; create host-restricted
Daytona organization Secrets; generate the pnpm lockfile and run typecheck,
lint, unit, adversarial, and live provider tests in approved cloud
infrastructure; verify the pinned benchmark image's DIND behavior; and keep
GPU jobs unschedulable until exact type attestation exists. The capability
probe is profile preflight. Successful create is the live resource/policy
check, while independent provider-signed image provenance is not exposed by
the current SDK and remains a residual provider limitation.

`CloudMarkerTrustedArtifactRuntimeGuard` is a fail-closed baseline, not
cryptographic runtime attestation. It requires both
`DF_TRUSTED_CONTROL_PLANE=1` and the provider runtime marker, but a process
whose deployment policy lets it forge its own environment could imitate both.
Production must protect those variables at the platform boundary or inject a
`TrustedArtifactRuntimeGuard` backed by independent provider/deployment
attestation. Until then, the source-level local-execution denial is present but
the claim that an actively malicious local process cannot impersonate the
trusted controller remains an explicit deployment gate.

### Evidence

- `src/cloud/artifact-bridge.ts`
- `src/cloud/adapters/daytona-transport.ts`
- `src/cloud/adapters/daytona.ts`
- `src/cloud/provider.ts`
- `tests/cloud/artifact-bridge.test.ts`
- `tests/cloud/daytona-transport.test.ts`

- Daytona TypeScript SDK v0.200 documentation for sandbox create, streaming
  files, sessions, metrics, network policy, TTL, and organization Secrets

## ADR-0037 — Compose the trusted evaluator from authenticated, sealed ports

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §3.3, §6.5, §7.2, §8.1, §13

### Context

The broker lifecycle and canonical deriver existed, but four production edges
were still represented only by broad injected interfaces:

1. A decoded evaluation could be returned without proving which encrypted
   Harbor, ATIF, and grader artifacts were read or how they were decrypted.
2. A canonical derivation policy could be supplied without a single seal
   binding its cache controls, guardrails, leak-scanner registry, repeated-test
   budget, and behavioral-release lineage.
3. Hidden task-correlated catalog updates had signer/verifier interfaces but no
   cloud-key-backed Ed25519 implementation.
4. The runner, reader, resolver, deriver, destruction custodian, envelope
   issuer, and one-use broker could be instantiated independently, leaving
   room for an incomplete application composition.

These gaps did not release data by themselves, but they made a future cloud
deployment vulnerable to accidental misbinding. In particular, an in-memory
fixture or a decoder that ignored one input could appear structurally similar
to a real trusted service.

### Decision

Add an authenticated raw-reader boundary. The reader accepts only the three
canonically ordered encrypted manifest artifacts. For each artifact it:

1. Fetches bytes through an injected `trusted://` cloud-storage port.
2. Enforces the manifest byte length and SHA-256 before decryption.
3. Computes AAD over request, immutable benchmark pin, Harbor job, runtime
   attestation, manifest, artifact set, and exact artifact reference.
4. Requires the decryptor to return a cloud-decryption attestation binding the
   ciphertext, plaintext digest, AAD, versioned key, and canonical time.
5. Commits the hashes of all three plaintexts into one decoder-input binding.
6. Requires the Harbor/ATIF decoder to acknowledge exactly that binding and to
   return a top-level evaluation correlated to the raw run.
7. Zeros owned ciphertext and plaintext buffers on success or failure.

There is no local file reader, plaintext persistence, permissive decoder, or
provider-specific crypto implementation in the core. Storage, decryption, and
Harbor format parsing remain fail-closed cloud ports. Test-only in-memory
fixtures carry the literal boundary marker `test-only-in-memory`; production
constructors reject that marker.

Add a bound canonical-policy resolver. A cloud material provider returns one
record tied to request hash, protocol, one-use disposition nonce, raw manifest,
raw artifact set, Harbor job, and runtime attestation. Five independently
hashed components cover:

- exact repair cache evidence and cache attestation;
- correctness, integrity, capability, accuracy-tradeoff, cost, latency, and
  compliance guardrails;
- forbidden literals, content fingerprints, grader canaries, and scanner
  version;
- the pre-existing online alpha-spending state;
- the optional privacy-qualified behavioral aggregate and its normalized ATIF
  source-set hash.

The final policy attestation commits those five component hashes plus frozen
environment, candidate time, stratum weights, deterministic integration
resolution, infrastructure replacement ceiling, and policy seal time. Raw
run identifiers correlate the provider lookup but are intentionally excluded
from this pre-outcome attestation because they do not yet exist when policy is
sealed. The resolver requires the candidate to be frozen before panel sealing
and the policy to be sealed after panel selection but before the first Harbor
execution (or, for a run without receipts, before raw-manifest creation). It
recomputes every hash and rejects any changed component. It does not infer a
guardrail or threshold from observed candidate outcomes.

Implement hidden-catalog update signing and verification with injected,
versioned cloud Ed25519 key providers. The private-key provider is restricted
to the `hidden-catalog-outcome-update` purpose. The verifier accepts only a
predeclared rotation keyring, validates the complete update and signature
timestamp, resolves the matching public key, and verifies the canonical
document. Provider/key failures return only a generic trusted-boundary error.
No key, task row, or signing detail enters a release envelope.

Add an asynchronous production composition factory. It requires cloud-marked
raw, policy, key, and durable-store ports, a durability attestation hash, the
immutable Terminal-Bench runner configuration, and separate result-envelope
and hidden-update key purposes. It constructs and retains privately:

`TerminalBenchCloudRunner → StrictTrustedDecodedEvaluationReader →
BoundCanonicalDerivationPolicyResolver →
DeterministicCanonicalEvaluationDeriver → TrustedEvaluationBroker`.

The broker then requires raw destruction before the Ed25519 result issuer may
produce the only release-facing object. The returned service exposes only
`evaluate(request)` and no intermediate raw, hidden, policy, or signing API.

### Alternatives

- Trust the provider-specific decoder to read all inputs without an input-set
  commitment.
- Put plaintext JSON in a local temporary directory before normalization.
- Let each guardrail/cache/scanner dependency return an unsealed value at
  derivation time.
- Store an Ed25519 private key directly in application configuration.
- Export runner, deriver, and issuer separately and rely on call-site order.
- Ship an in-memory encrypted-artifact backend as a production fallback.

### Consequences

The core now has an executable production composition contract without
pretending that a particular cloud object store, KMS, or Harbor archive format
has been selected. Provider adapters must implement explicit ports and exact
attestations. This is deliberate: substituting a local backend is a
configuration error, not degraded operation.

The remaining composition work is externally concrete and visible:

- choose and bind a durable encrypted `trusted://` object store;
- implement provider KMS/secret adapters and key rotation policy;
- implement and validate the exact Harbor v0.20.0 raw bundle/ATIF decoder;
- populate the sealed canary/fingerprint registry and behavioral aggregate
  provider;
- bind the durable one-use ledger, raw ingress/custodian, policy material
  store, and hidden catalog sink;
- run all new type, lint, unit, adversarial, and live lifecycle tests in the
  approved cloud environment.

Until those adapters are configured, production startup fails closed. Source
tests cover ciphertext mutation, missing decoder binding, post-seal changes to
each policy component, hidden-update signature mutation, unknown/test-only key
providers, result keyring mismatch, and rejection of in-memory raw ports.
They remain unverified until the cloud-only suite runs.

### Evidence

- `src/evaluator/raw-reader.ts`
- `src/evaluator/policy-resolver.ts`
- `src/evaluator/hidden-update-signature.ts`
- `src/evaluator/composition.ts`
- `tests/evaluator/raw-reader.test.ts`
- `tests/evaluator/policy-resolver.test.ts`
- `tests/evaluator/hidden-update-signature.test.ts`
- `tests/evaluator/composition.test.ts`

## ADR-0038 — Seal Claude optimizer sessions in disposable cloud sandboxes

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §5, §6, §8, §13

### Context

The Claude launch specification constrained tools, evidence, cost, turns, and
credentials, but it did not execute the optimizer or freeze its edits. A
production composition also needs to clone the private Pi source without
touching the canonical Mac checkout, prevent the GitHub credential from
reaching Claude, require exactly one MCP hypothesis/candidate handoff, and
produce deterministic Git objects that the separate trusted publication
boundary can publish without force.

A proposal sandbox cannot be assumed to survive evaluation. Analysis may run
hours later, after the proposal lease has expired. Retaining a live sandbox
would make correctness depend on provider longevity and would enlarge the
credential and data-retention boundary.

### Decision

Add a cloud-only optimizer session with no subprocess or local fallback. Each
proposal provisions one bounded immutable x86_64 sandbox through
`CloudSandboxProvider`. The sandbox receives content-addressed worker, plugin,
released-evidence, and optional Git-bundle/state artifacts. A trusted setup
command either fetches an exact registered private GitHub ref or imports an
exact trusted candidate bundle, verifies commit/tree/lock identities, then
removes every remote and credential helper.

The sandbox is granted the union of required secret references because the
provider needs an up-front grant, but each command receives a disjoint subset:

1. Setup receives only the private-origin credential.
2. The Claude wrapper receives only an Anthropic API or Claude OAuth binding.
3. Candidate and analysis sealing receive no secret.

The Daytona transport replaces organization-secret bindings before each
command and clears them afterward. The worker additionally refuses to launch
Claude if `DF_GITHUB_TOKEN` is visible. It constructs the actual Claude child
from `createClaudeCodeLaunchSpec`, supplies a minimal environment, parses
stream JSON in bounded memory, retains only operational summary fields, and
never writes the full model stream.

Proposal sealing requires one hypothesis envelope, one candidate envelope,
their exact receipt lineage, an uncontaminated MCP session state, a non-empty
small diff in approved Pi source roots, regular Git tree entries, and a
generic leakage/reward-hacking scan. It creates a deterministic commit whose
parent is the frozen source, writes
`refs/heads/df/bundle/<experiment>`, and emits a Git bundle compatible with
the existing signed non-force publication protocol. Bundle, diff, session
state, and canonical worker result are downloaded only as content-addressed
trusted artifacts.

The session archive includes only MCP session state, immutable submission
envelopes, and the optimizer audit directory. A later analysis uses a new
disposable sandbox, rehydrates those records at the same absolute project
path, checks out the exact candidate bundle, overlays the newly released
task-agnostic result, runs the read-only Claude analysis phase, and seals one
bound analysis. Both phases invalidate all outputs if confirmed sandbox
teardown fails.

### Consequences

The canonical Pi checkout is never fetched, built, or mutated. A long-running
evaluation does not require a long-lived optimizer sandbox, and neither Git
nor benchmark credentials are available to Claude. Candidate identity is
deterministic and publication remains a distinct authorized operation.

The generic scan in the optimizer sandbox deliberately has no protected task
fragment set: putting benchmark-derived fragment hashes beside Claude would
unnecessarily enlarge the optimizer trust zone. The later trusted integrity
gate must therefore repeat the scan with its hidden fragment registry before
evaluation. Production still requires a concrete verifying artifact reader,
immutable optimizer image digest, built plugin tar, provider organization
Secrets, durable optimizer-session record store, and cloud execution of the
unit/adversarial/live tests.

### Evidence

- `src/optimizer/cloud-session.ts`
- `scripts/optimizer-session-worker.mjs`
- `tests/optimizer/cloud-session.test.ts`

## ADR-0039 — Run the complete control plane in the cloud

- Date: 2026-07-26
- Status: accepted
- Supersedes: ADR-0018, ADR-0030
- Superseded by: none
- Related plan: `PLAN.md` §2.3, §3, §6, §10, §12–14

### Context

The operator clarified that nothing executable should run on the Mac. Earlier
decisions moved candidate code, tests, Harbor, graders, and benchmark tasks to
cloud sandboxes but still allowed the TypeScript orchestrator, Claude Code,
evidence writers, and operator commands to run locally. That leaves local
processes handling provider credentials and mutable campaign state, and it
does not satisfy the stronger boundary.

Campaign continuity also needs storage that outlives any disposable controller
or evaluator sandbox. Raw Harbor output cannot share the optimizer-visible
store, and the canonical `../pi` checkout must remain a read-only source
reference rather than becoming a runtime dependency.

### Decision

Run the complete executable Dark Factory deployment in a pinned trusted cloud
control-plane sandbox. The TypeScript orchestrator, Claude Code optimizer,
broker, evaluator, Git workers, evidence writers, campaign controls, and all
quality commands execute there or in its child cloud sandboxes. A Mac process
may only:

1. author source files;
2. inspect the canonical Pi checkout with the fixed read-only Git allowlist;
3. trigger an authenticated cloud entry point without resolving workload
   secrets; and
4. display an optional read-only mirror of release-safe JSON and generated
   Markdown.

The Mac does not run the Daytona SDK, `df optimize`, Claude Code, dependency
installation, builds, lint, tests, Pi, Harbor, graders, or synthetic/benchmark
workloads.

Use a provider-managed persistent volume mounted only into the trusted control
plane for mutable campaign state and content-addressed artifacts. Map every
`trusted://` URI to a one-way SHA-256 directory, stream and verify all bytes,
write through a same-volume staging directory, reject symbolic links and
special files, and make a URI idempotent only for identical bytes. Daytona's
S3-backed volume and per-campaign `subpath` are the initial implementation
target. Optimizer sandboxes do not receive this mount. Evaluator raw material
uses a separate restricted prefix and encryption/retention policy; only signed
release-safe evidence may be copied to the campaign prefix or an optional
workstation mirror.

Bootstrap originates from authenticated cloud CI or a provider-owned UI/job,
which starts the trusted controller with an immutable image, exact volume
mount/subpath, organization Secret references, TTL, network policy, and one
active-writer campaign lease. A local API bootstrap is not a fallback. Human
full-evaluation authorization is performed through an interactive
provider-owned session and persisted in a provider-managed KMS/secret-backed
one-use store, not macOS Keychain.

Environment markers remain only a fail-closed baseline. Production startup
must additionally verify the immutable image, provider sandbox identity,
volume mount/subpath, controller lease, and key/storage attestations before it
accepts mutable state. Failure to prove any binding prevents initialization.

### Alternatives

- Keep the orchestrator and release-safe state on the Mac.
- Run only workload processes remotely while resolving Daytona and GitHub
  credentials locally.
- Store all raw and released evidence in one mounted volume.
- Mount campaign state into Claude or evaluated-agent sandboxes.
- Treat a user-set environment marker as sufficient production attestation.

### Consequences

There is no immediate local CLI execution path for campaign mutation. Cloud
availability is required even for synthetic validation and operator stop/resume
commands. The deployment needs a cloud bootstrap workflow, a persistent volume
identifier/subpath, single-writer fencing, immutable control image, and
provider-managed Secrets before any live campaign can start.

Release-safe evidence can still appear under `df-demo/experiments` as a
read-only synchronized mirror, satisfying the auditability goal without
turning the Mac into a trusted runtime. Raw task names, grader output, ATIF, and
per-task rows never enter that mirror.

### Evidence

- Operator clarification that nothing should execute on the Mac
- `src/cloud/artifact-bridge.ts`
- `src/cloud/mounted-volume-backend.ts`
- `src/cloud/runtime-marker.ts`
- `tests/cloud/mounted-volume-backend.test.ts`
- [Daytona volumes](https://www.daytona.io/docs/en/volumes/)

## ADR-0041 — Package Harbor directories before trusted artifact transfer

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §3.3, §6.5, §8.1

### Context

Harbor 0.20 writes a job as a directory under `jobs_dir/job_name`. The cloud
provider transfer contract downloads regular files, not directories. Treating
that directory as a downloadable artifact would also leave traversal,
symbolic-link, archive-bomb, partial-output, and time-of-check/time-of-use
semantics undefined. Raw Harbor material is task-sensitive and cannot be
staged on the workstation to solve the mismatch.

The trusted raw normalizer needs the job-level config/result, every direct
trial result, and Pi's ATIF trajectory. It must also prove that those bytes came
from the exact sealed invocation and successful Harbor execution being
evaluated.

### Decision

Upload a content-addressed `package-harbor-output.mjs` module with every sealed
Harbor job. The job artifact hashes the module reference and distinguishes two
paths per invocation:

1. `remoteHarborJobPath` is Harbor's mutable sandbox-local output directory.
2. `remoteOutputPath` is a new
   `<invocation>.harbor-output.tar` regular file.

After all Harbor invocations succeed, the runner invokes the packager once per
directory with no secret references. It passes only sealed paths and
identifiers: request ID, job hash, Terminal-Bench pin hash, invocation ID and
order, config hash, expected trial count, and the corresponding successful
Harbor execution ID. A packaging failure, timeout, cancellation, malformed
artifact type, or oversized artifact invalidates the whole run before raw
ingress.

The packager runs only with the cloud marker and provider sandbox identity. It
uses no shell and no external archiver. It recursively admits directories and
regular files only, uses no-follow file descriptors, checks stable
device/inode/size/mtime metadata, hashes bytes before manifest construction,
and rehashes while streaming them. It rejects:

- symbolic links and all special files;
- absolute, traversal, control-character, backslash, non-NFC, duplicate, or
  prefix-conflicting paths;
- nested archives and fixed file/path/expanded-byte ceiling violations;
- missing root `config.json` or `result.json`;
- any `result.json` outside the root or a direct trial directory;
- any `trajectory.json` outside `<trial>/agent/trajectory.json`; and
- a missing, extra, or unpaired direct trial result/trajectory set.

It writes a deterministic POSIX/PAX tar ordered by UTF-8 path bytes. The first
entry is canonical `manifest.json`; each source file follows under
`payload/<relative-path>`, with normalized ownership, modes, timestamps, and
two terminal zero blocks. The manifest records schema/domain, all invocation
bindings, file/byte/trial counts, every file SHA-256, and a canonical aggregate
payload SHA-256. The provider download call requires
`application/x-tar` and a 2.25 GiB maximum before streaming begins. The trusted
raw ingress must validate the tar and manifest in memory before deriving the
three encrypted raw evidence documents; no extracted directory or tar reaches
the optimizer, campaign volume, or Mac.

### Alternatives

- Download the Harbor output directory through provider-specific recursion.
- Invoke system `tar` after a best-effort directory scan.
- Encode every file as base64 in one JSON document.
- Retain a live evaluator sandbox and let the later decoder read its
  filesystem.
- Copy raw output to the workstation for packaging.

### Consequences

The artifact edge now transfers one bounded immutable file and has an exact
source/invocation commitment. Custom tar production and parsing are
security-critical and need cloud fixture, adversarial, truncation, PAX, and
live Harbor validation. The packager intentionally performs two payload read
passes—one for the manifest and one while writing—to detect mutation while
keeping file content streaming and metadata memory bounded by the fixed
file/path ceilings. A missing ATIF trajectory fails the invocation closed
instead of silently manufacturing behavioral evidence.

The packager source digest still has to be resolved into a trusted artifact by
production composition, and the exact Harbor 0.20 directory layout must be
confirmed in the pinned evaluator image. Until the cloud suite and live
fixture pass, this boundary is implemented but not operationally verified.

### Evidence

- `scripts/package-harbor-output.mjs`
- `src/terminal-bench/harbor.ts`
- `src/terminal-bench/job-builder.ts`
- `src/terminal-bench/runner.ts`
- `tests/terminal-bench/harbor-output-packager.test.ts`
- `tests/terminal-bench/pin-harbor.test.ts`
- `tests/terminal-bench/job-builder.test.ts`
- `tests/terminal-bench/cloud-runner.test.ts`

## ADR-0042 — Fence mutable state with a non-expiring cloud-controller lock

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §2.3, §5, §6, §7, §12–14

### Context

The one-use request ledger, hidden task catalog, and optimizer session record
store must survive disposable controller sandboxes while remaining
linearizable. Process memory is not durable, and a permissive local filesystem
implementation would violate the cloud-only boundary. A conventional
time-to-live lock is also unsafe: a paused controller can resume after another
writer has decided that its lease expired.

Daytona volumes are provider-managed and persistent, but their S3-backed FUSE
implementation must not be assumed to provide every POSIX durability and
rename guarantee without a live canary for the exact deployed volume class.
Automatic stale-lock deletion based on workstation or sandbox clocks is
therefore not an acceptable recovery mechanism.

### Decision

Use campaign-scoped mounted-volume adapters in the trusted cloud controller
for `AtomicOneUseLedgerStore`, `LinearizableHiddenCatalogCasStore`, and
`CloudOptimizerSessionRecordStore`. Each adapter requires both:

1. the trusted cloud runtime guard; and
2. a storage-semantics guard issued only after the deployment has attested
   exclusive directory creation, same-volume atomic rename, durable file
   synchronization, and single-controller policy for that volume.

The adapter acquires one lifetime lock per store namespace. Lock metadata
contains a random 192-bit nonce, controller-instance commitment, monotonically
increasing fence epoch, acquisition time, and canonical content hash. Every
transaction is serialized inside that owner, verifies the active lock and
durable fence before reading, before committing, and after committing, and
invokes the domain callback exactly once.

There is no lock expiry. Recovery requires an injected trusted authority to
return an authorization bound to the exact prior lock hash and fence epoch
after it has verified provider evidence that the old controller sandbox was
irreversibly destroyed. The authorization is durably recorded before the old
lock is quarantined. A successor then acquires a higher epoch; any resumed or
stale owner fails its next ownership check. Clean shutdown moves the lock into
an immutable released-lock record instead of silently deleting its history.

State is stored as bounded canonical JSON in a content-hashed envelope that
binds its domain, generation, preceding-envelope hash, writer fence, commit
time, state hash, and payload. Writes use a no-follow exclusive staging file,
file synchronization, atomic replacement, parent-directory synchronization,
ownership rechecks, and exact read-back. The independent fence record also
retains the last committed generation and envelope hash, so replacing the
state file with an older internally valid envelope fails closed. A crash after
state replacement but before fence advancement can adopt exactly one
hash-linked successor only from the current writer or an earlier fence with
provider-destruction authorization. Roots, control directories, state files,
and lock files reject symbolic links and unexpected file types.

The ledger adapter validates record/status consistency, unique claims and
one-use attestation indexes, and complete signed result envelopes. The hidden
catalog adapter validates the full storage shape, all 89 opaque task records,
shadow slices, allocations, outcome commitments, and revision accounting;
`DurableTrustedHiddenCatalog` still verifies its secret-keyed commitments
inside the transaction. The optimizer store retains only strict manifests,
receipts, and trusted artifact references, and accepts repeated writes only
when their canonical content is identical.

### Alternatives

- Keep mutable stores in controller memory and reconstruct after crashes.
- Use an expiring lock or heartbeat and steal it after a wall-clock timeout.
- Recover a stale lock automatically when its owner marker is absent.
- Rely on untested S3/FUSE rename behavior.
- Put task-sensitive catalog state or optimizer session state on the Mac.
- Operate multiple writers and approximate compare-and-set with retries.

### Consequences

Normal operation has one durable writer and straightforward linearization.
Crash recovery intentionally stops until provider destruction is attested; an
availability delay is preferable to split-brain campaign state. The
authorization callback is a trust boundary and must verify the provider
signature or KMS-backed recovery decision rather than accepting operator text.

The mounted-volume semantics canary, provider recovery authority, and cloud
failure-injection suite are deployment prerequisites. If Daytona cannot attest
atomic rename and durable sync for its volume implementation, production must
replace this adapter with a managed transactional database or object-store
conditional-write service; configuration must not weaken the guard.

### Evidence

- `src/cloud/mounted-volume-state.ts`
- `tests/cloud/mounted-volume-state.test.ts`

## ADR-0043 — Preseal cloud download type and size

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §3.3, §6.5, §8.1, §12.5–12.6

### Context

Daytona's filesystem download API returns a byte stream without authoritative
content-type metadata. The original transport persisted every download as
`application/octet-stream`. Consumers correctly required more specific types,
such as `application/x-tar` for candidate runtimes and Harbor bundles,
`application/vnd.git.bundle` for Git bundles, and `application/json` for
worker manifests. Consequently, a real artifact would be rejected even when
its bytes and digest were correct.

Relabeling after download would fix compatibility but would leave the storage
boundary open to unbounded remote output. A compromised worker could fill the
trusted volume before a later consumer applied its byte limit.

### Decision

Every cloud-provider download now requires a caller-sealed expectation with:

1. an exact safe media type; and
2. a positive hard maximum byte length, capped globally at 16 GiB.

The configured provider validates the expectation before transfer and rejects
a returned reference whose media type differs or whose committed length
exceeds the limit. The Daytona transport independently validates the same
contract, counts every streamed byte, aborts before trusted-artifact commit
when the maximum is crossed, and persists the artifact using the declared
type. Existing post-download schema, digest, exact-length, and semantic checks
remain mandatory.

Production callers declare narrow types and role-appropriate ceilings:
manifests and results use canonical JSON limits, Git source and runtime
archives use tar limits, candidate publication uses the Git bundle type, and
optimizer state/diff artifacts use their exact types. Harbor bundles use the
packager's 2.25 GiB ceiling.

### Alternatives

- Continue persisting all remote files as generic binary.
- Infer type from a filename extension.
- Trust provider-supplied or worker-supplied MIME metadata.
- Download first and reject oversized artifacts only after commit.
- Allow consumers to relabel an already persisted artifact.

### Consequences

Artifact type is now a protocol assertion made before untrusted bytes cross the
storage boundary, not mutable metadata inferred later. Every new download
callsite must choose an explicit type and size budget, which is intentional:
an omitted budget is a compile-time error. A media-type declaration does not
prove file semantics, so the appropriate parser and signed-manifest checks
must still reject malformed content.

### Evidence

- `src/cloud/types.ts`
- `src/cloud/provider.ts`
- `src/cloud/adapters/daytona-transport.ts`
- `tests/cloud/provider-contract.test.ts`
- `tests/cloud/daytona-transport.test.ts`

## ADR-0044 — Deliver lock, quality, role images, and paid control from protected cloud workflows

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §2.3, §3, §12–14

### Context

ADR-0039 forbids dependency installation, quality commands, image builds,
provider SDK bootstrap, controllers, and workloads on the Mac. The repository
did not yet have a safe way to create its first pnpm lock, build distinct trust
zone images, publish immutable identities, or launch the paid controller. A
single privileged workflow would expose the Daytona credential to build and
third-party action steps, and an automatically opened lockfile PR would grant a
bootstrap job unnecessary write authority.

Claude Code and Harbor versions are material protocol inputs, but the operator
has not yet selected the production optimizer model, evaluated Pi model,
credentials, budgets, or base images. Delivery must not manufacture those
choices. Image publication must also be incapable of accidentally starting a
paid benchmark run.

### Decision

Create four independent GitHub-hosted delivery paths:

1. A manual, exact-main-commit-bound lock bootstrap resolves
   `pnpm-lock.yaml` with lifecycle scripts disabled. It has read-only repository
   permission, refuses to run when a lock already exists, admits no other
   working-tree change, and uploads the lock plus SHA-256 as a review artifact.
   A human adds the reviewed file through a normal PR.
2. Pull request, main, and explicitly confirmed manual quality jobs use a fixed
   Ubuntu image, exact Node and pnpm versions, a frozen committed lock, and
   immutable-SHA external actions. They receive no operational secret.
3. A protected, manually confirmed, source-commit-bound workflow reruns the
   complete quality suite, then builds four Linux/amd64 roles from
   operator-supplied digest-qualified bases using an exact Buildx release and
   digest-qualified BuildKit driver. The optimizer installs the exact supplied
   Claude Code version; the evaluator installs the exact supplied Harbor
   version. BuildKit publishes each private GHCR image with attached SPDX SBOM
   and max-mode provenance and emits a review artifact containing its immutable
   reference and digest. This workflow never invokes Daytona,
   Claude Code, Pi, Harbor, Terminal-Bench, or a paid model.
4. A separate `dark-factory-paid` protected environment launches only from an
   exact main commit after typed campaign confirmation and an independent
   `RUN:<campaign>:<control-digest>` authorization. It builds the reviewed
   controller and calls `dist/cloud/control-bootstrap-cli.js optimize`. The
   plaintext Daytona bootstrap key is scoped only to that final step; all other
   credentials are opaque Daytona organization-Secret names. Its controller
   TTL is capped so the GitHub-hosted job can observe confirmed teardown.

All checkouts disable credential persistence. OCI build context is
default-deny. Final roles use numeric non-root UID/GID 65532. There is no base
tag fallback and no model, budget, credential, benchmark hash, or runtime image
default. Runtime configuration consumes only the digest references returned by
the publication receipts.

### Alternatives

- Generate or install the first dependency lock on the Mac.
- Let the lock bootstrap push directly to `main` or open a privileged PR.
- Use one all-purpose image for controller, optimizer, build, and evaluator.
- Publish images from every push with mutable tags.
- Put the Daytona key in job-wide environment state.
- Combine image publication and paid optimization in one workflow.
- Choose provisional Claude, Pi, base-image, or budget values in CI.

### Consequences

Initial delivery requires deliberate human steps: review the generated lock,
configure two protected GitHub environments, approve four digest-qualified
base images, select exact Claude Code and Harbor versions, inspect four
attestation sets, and configure the paid variables and one bootstrap secret.
This friction is intentional at the authority and spend boundaries.

Exact top-level package versions plus SBOM/provenance do not make Python or npm
transitive resolution independently reproducible. The trusted live probe must
still verify Harbor package/executable hashes, Claude Code identity, Pi adapter
hash, image/runtime architecture, provider profile, and benchmark pins. Numeric
non-root execution also requires compatible ownership semantics from each
reviewed base and the Daytona volume. The first cloud build and synthetic probe
remain deployment gates; authored workflow files are not execution evidence.

### Evidence

- `.github/workflows/bootstrap-lockfile.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/publish-role-images.yml`
- `.github/workflows/paid-optimize.yml`
- `.dockerignore`
- `containers/control.Containerfile`
- `containers/optimizer.Containerfile`
- `containers/build.Containerfile`
- `containers/evaluator.Containerfile`
- `CLOUD_DELIVERY.md`

## ADR-0040 — Normalize Harbor evidence once inside the trusted evaluator

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §3.3, §6.5, §8, §12.5–12.6

### Context

Harbor 0.20 output is a task-sensitive directory projection containing job
and trial results, verifier rewards, agent messages, tool arguments/results,
and ATIF trajectories. Passing those files directly to the optimizer would
reveal benchmark identity and grader material. Accepting general tar or native
`JSON.parse` would also admit alternate archive semantics and duplicate-key
parser differentials. The evaluator still needs exact task/arm correlation,
per-trial costs, generic behavioral evidence, and auditable raw destruction.

### Decision

Use a one-way trusted-cloud normalization boundary pinned to the exact
`harbor-0.20.0-py3-none-any.whl` digest. It accepts only the byte-for-byte
deterministic POSIX/PAX layout from ADR-0041, reconstructs every header,
validates the canonical manifest and all file/aggregate hashes, rejects
duplicate JSON keys, and retains only the sealed input config, job result,
direct trial results, and paired ATIF files in memory.

The normalizer joins original content-addressed task-name order to the hidden
panel and matched schedule, then independently joins each trial through task
name, configured candidate/champion agent, trial UUID, invocation, execution,
and archive manifest. Provider-specific metering must allocate a positive
sandbox cost to every trial; CPU and RSS may be null when honest per-trial
telemetry does not exist. The resulting decoding plan remains trusted-only.

Exactly three canonical JSON documents are emitted: Harbor results, scalar
grader/resource records, and ATIF. They are encrypted immediately with
acyclic AEAD binding material, streamed through the verifying trusted artifact
bridge, and zeroed. The original unencrypted Harbor bundles are then deleted
through an idempotent backend lifecycle boundary before the decoding plan is
committed. Final deletion or crypto-shredding requires a backend attestation
and an Ed25519-verifiable destruction receipt. No raw file is extracted to a
directory or persisted on the workstation.

The strict decoder authenticates and consumes all three documents together.
It accepts only the official successful Harbor 0.20/ATIF-v1.7 projection,
requires one exact record per presealed schedule arm, and discards task names,
instructions, messages, reasoning, tool arguments/results, paths, and grader
prose. Its only output is opaque task digests, scalar correctness/integrity and
cost values, timestamps, and generic hashed behavioral events.

### Consequences

The optimizer can learn generic failure and behavior patterns without seeing
which benchmark task produced them. Unknown fields, missing/duplicated/swapped
arms, archive variants, task metadata in release fields, noncanonical JSON,
or unavailable billing fail the evaluation closed. Production composition
must supply trusted normalization context, billing, KMS encryption, durable
plan storage, object lifecycle, and receipt-signing adapters; no permissive
local fallback exists.

### Evidence

- `src/evaluator/harbor-v020-bundle.ts`
- `src/evaluator/harbor-v020-normalizer.ts`
- `src/evaluator/harbor-v020-decoder.ts`
- `src/evaluator/raw-ingress.ts`
- `src/evaluator/raw-reader.ts`
- `src/terminal-bench/assets/dark_factory_pi.py`
- `tests/evaluator/harbor-v020-bundle.test.ts`
- `tests/evaluator/harbor-v020-decoder.test.ts`

## ADR-0045 — Bind cloud execution to the exact private Pi fork snapshot

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §2.1, §2.3, §4, §13–14

### Context

The operator already owns the private Pi fork at
`parallaxai/df-pi-tbench`; its canonical Mac checkout is the sibling `../pi`
directory. Read-only inspection observed branch `main`, commit
`5bc1c2c0a6f07e00e8c240304182f213ab8d311f`, tree
`73898c76210cc8b48f4ac07cc76397b6b5c00758`, package-lock SHA-256
`472f0726dc79f3b38df58d8a8bce96bf56fbf993a134b49aabc54947b8461e59`,
and coding-agent package version `0.82.1`. A path or commit alone would not
prove that the cloud run used the authorized repository contents, and
fetching or building the canonical Mac checkout would violate the cloud-only
execution policy.

The protected delivery workflows also need a trustworthy way to distinguish a
GitHub-hosted runner from a self-hosted runner. GitHub's `runner.environment`
context is authoritative workflow input; it is not automatically available as
an environment variable.

### Decision

Treat the repository owner, repository name, branch, commit, tree,
package-lock digest, package name/version, canonical upstream URL, and opaque
cloud credential-secret name as one indivisible source authorization. Parse
and validate it before a production optimize command can start. A trusted
cloud Git worker must independently clone the private origin, resolve the
authorized objects and lock bytes, verify the canonical upstream and merge
base, and create content-addressed source/runtime artifacts. It must not add a
remote to, fetch, build, test, or modify `../pi`.

The observed values are authorization inputs, not proof. Production remains
locked until the cloud worker returns a signed verification receipt and the
private origin's privacy and non-force fetch/push capabilities are attested.
Claude receives only a disposable candidate checkout and never receives the
private-repository credential.

Protected workflows explicitly export
`RUNNER_ENVIRONMENT: ${{ runner.environment }}` and require the value
`github-hosted`. The paid path runs a mounted-volume/provider probe and a
deterministic synthetic campaign before attempting the real optimizer. All
three steps emit separate release-safe receipts.

### Alternatives

- Trust the local path or the configured remote URL.
- Pin only the commit SHA.
- Fetch and package the canonical Mac checkout.
- Let Claude clone or publish with the GitHub credential.
- Infer the runner class from an ambient variable that GitHub does not define.

### Consequences

Changing any authorized source field requires a new reviewed authorization.
The first live run additionally needs an authenticated private cloud clone,
source-verification signer, reviewed role-image digests, and production
optimizer composition. Until those exist, the paid workflow is expected to
fail closed at `optimize` after its safe preflights rather than run an
unverified harness.

### Evidence

- `src/config/harness-source.ts`
- `src/cloud/control-bootstrap.ts`
- `src/cloud/control-plane.ts`
- `scripts/trusted-git-worker.mjs`
- `.github/workflows/paid-optimize.yml`
- `.env.example`
- `tests/config/harness-source.test.ts`
- `tests/harness/trusted-git-worker.test.ts`

## ADR-0046 — Use bounded Pi print-mode JSON for the initial Harbor adapter

- Date: 2026-07-26
- Status: accepted
- Supersedes: ADR-0031
- Superseded by: none
- Related plan: `PLAN.md` §2.1, §3.3, §8, §12–13

### Context

ADR-0031 selected Pi RPC because it offers explicit control and structured
events. Further read-only inspection found that Pi's RPC process exits when
its standard input reaches EOF. A correct RPC driver therefore needs a
long-lived bidirectional controller, protocol-state validation, backpressure,
abort acknowledgement, and adversarial lifecycle tests. A simple one-shot
pipe would race or terminate an active agent and would be less reliable than
Pi's existing one-shot interface.

The implemented Harbor adapter already launches a fresh Pi process with
`--print --mode json`, disables sessions and ambient extensions/skills/prompt
templates, validates every JSON event, requires a unique terminal
`agent_settled`, derives ATIF inside the trusted evaluator, and relies on
Harbor plus sandbox teardown for the hard timeout.

### Decision

For the MVP, keep the adapter external to Pi but use its bounded one-shot
print-mode JSON contract. Launch exactly one fresh process per trial, provide
the task instruction only inside that task sandbox, capture structured output
only in the trusted evaluator, require a complete validated lifecycle, and
enforce timeout, cancellation, and destruction outside Pi.

Do not describe the current implementation as RPC. Retain the TypeScript RPC
serialization and validation helpers only as a future implementation path. A
switch to RPC is a protocol change and requires a dedicated trusted driver
that keeps stdin open, correlates commands and events, proves abort and
settlement behavior, and passes cloud fault-injection tests before it can
replace print mode.

### Alternatives

- Keep ADR-0031 while silently running print mode.
- Implement an untested shell pipe around RPC.
- Patch Pi with benchmark-specific lifecycle code.
- Persist Pi sessions or raw event streams outside the trusted evaluator.

### Consequences

The MVP has a smaller and more auditable wrapper, while hard cancellation
depends on Harbor and provider teardown instead of an in-protocol abort.
Print-mode event compatibility must be checked against the exact authorized Pi
commit during the live cloud probe. Any incomplete, unknown, duplicated, or
oversized event stream fails the trial as infrastructure-invalid; it cannot
become a benchmark failure or promotion signal.

### Evidence

- `src/terminal-bench/assets/dark_factory_pi.py`
- `src/terminal-bench/pi-agent.ts`
- `src/harness/pi-rpc.ts`
- `tests/terminal-bench/pi-agent.test.ts`
- `tests/harness/candidate-pi-rpc.test.ts`
