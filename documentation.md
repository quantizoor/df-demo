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
- Status: accepted
- Supersedes: none
- Superseded by: none
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
- Status: accepted
- Supersedes: none
- Superseded by: none
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
- Status: accepted
- Supersedes: none
- Superseded by: none
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
- Status: accepted
- Supersedes: none
- Superseded by: none
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
- Status: accepted
- Supersedes: ADR-0014
- Superseded by: none
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
- Status: accepted
- Supersedes: ADR-0012
- Superseded by: none
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
- Status: accepted
- Supersedes: none
- Superseded by: none
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
- Status: accepted
- Supersedes: none
- Superseded by: none
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
- Status: accepted
- Supersedes: ADR-0009
- Superseded by: none
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
