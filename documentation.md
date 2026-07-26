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
- Superseded by: ADR-0082 (optimizer-visibility scope only)
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
become a benchmark failure or promotion signal. The control schema advances
to `1.2.0`; a registration must attest adapter
`harbor-pi-print-json`/`print-json`, so an older RPC-labelled registration
cannot be reused in this lineage.

### Evidence

- `src/terminal-bench/assets/dark_factory_pi.py`
- `src/terminal-bench/pi-agent.ts`
- `src/schemas/control.ts`
- `src/harness/pi-rpc.ts`
- `tests/terminal-bench/pi-agent.test.ts`
- `tests/harness/candidate-pi-rpc.test.ts`

## ADR-0047 — Reuse the exact hidden repair cells for one revision

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §7–7.2

### Context

After a failed repair screen, selecting another weighted five-task sample for
the revised candidate would confound candidate quality with panel difficulty.
It would also let repeated revisions search for a favorable repair draw. The
task identities must remain hidden, but hiddenness alone does not make two
different samples comparable.

### Decision

Repair attempt one must cite exactly one earlier committed validation
allocation whose disposition was consumed as feedback. The broker selects the
five repair cells only from that source allocation, records the source request
commitment, actual frozen-hypothesis hash, candidate and incumbent archive
digests, bucket assignments, and order, and commits the allocation before any
outcome is observed.

At most one immediate revision is allowed. Attempt two requires a distinct
candidate archive but reuses the exact same five cells, bucket assignments,
order, source request, incumbent archive, and frozen hypothesis. A retry is
not a newly selected panel, so it does not advance the alternating
easy-integrity/underexposed-coverage epoch. A third attempt or any mismatched
lineage fails closed. If either attempt passes, later positive promotion still
requires a separate twelve-pair validation panel fresh to the entire
hypothesis ancestry.

### Alternatives

- Draw a new weighted five-task panel for every candidate revision.
- Let the controller identify and request the failed tasks.
- Promote directly when the revised candidate improves on the reused cells.
- Permit unlimited revisions against the same five cells.

### Consequences

The two repair candidates face the same hidden difficulty mix, so the retry
answers a narrow causal question without disclosing task identity. This
reduces sampling confounding but does not make the repair panel a holdout:
repair and cache evidence retain zero positive promotion weight. The
two-candidate ceiling limits adaptive overfitting to those five cells.

### Evidence

- `src/broker/catalog.ts`
- `src/evaluation/selection.ts`
- `src/evaluator/contracts.ts`
- `src/orchestrator/blind-broker.ts`
- `src/cloud/mounted-volume-state.ts`
- `tests/broker/catalog.test.ts`
- `tests/evaluation/selection.test.ts`

## ADR-0048 — Prove evaluator Docker-in-Docker by execution

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §2.3, §8.1, §13–14

### Context

Terminal-Bench evaluation requires Docker inside the evaluator sandbox. A
provider capability flag does not prove that the pinned evaluator image
contains a compatible Docker client, that its daemon starts, or that the
specific target and resource profile permit nested containers.

### Decision

Before paid optimization, probe the immutable build image for baseline cloud
capabilities and the immutable evaluator image with
`requireDockerInDocker: true`. Create real deny-all leases for both roles and
execute `docker info` with no secrets inside the evaluator lease. Any nonzero,
timed-out, cancelled, malformed, or teardown-failing execution rejects
readiness.

Persist only a release-safe receipt containing hashes of capabilities,
sandbox identities, the Docker execution receipt, resources, network policy,
the two image digests, and the already-attested mounted-volume semantics. Do
not include Docker output, log locations, or raw sandbox identifiers in the
receipt or release-safe mirror. Any provider-captured command log remains
inside the protected trusted-artifact boundary under its retention policy.

### Alternatives

- Trust the provider's static capability response.
- Test Docker only after a paid benchmark panel has been allocated.
- Run a local Docker preflight on the operator's Mac.

### Consequences

The campaign fails before spending benchmark/model budget when its evaluator
cannot start nested Docker. The source implementation and adversarial unit
fixtures are complete, but acceptance still requires the reviewed evaluator
image to pass this check on the chosen live Daytona target.

### Evidence

- `src/cloud/production-readiness.ts`
- `src/cloud/control-plane.ts`
- `tests/cloud/production-readiness.test.ts`

## ADR-0049 — Parse verified Git-worker bytes before registration signing

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §2.1, §4

### Context

A cloud file-transfer receipt proves an object's digest and location, but it
does not by itself prove that the object contains the authorized private-fork
identity. Signing fields copied from an unparsed or partially parsed result
would turn the signing service into an oracle for attacker-selected metadata.

### Decision

The production Git registration attestor reads the result through the
verifying JSON artifact bridge, enforces the byte limit, parses canonical JSON,
and matches every repository, commit, tree, lockfile, package, adapter,
upstream, privacy, writability, and lineage field to the signed authorization
and cloud execution. It constructs the release-safe receipt itself and sends
only that canonical unsigned receipt to an injected trusted-cloud key
authority. The runner then verifies the returned Ed25519 signature and every
lease/execution/artifact binding independently.

### Alternatives

- Let the registration worker sign its own output.
- Sign only the provider's artifact digest.
- Copy fields from parsed JSON without matching the authorization.
- Place an exportable private key in the controller environment.

### Consequences

The Git worker, provider transfer layer, attestor, and receipt verifier form
separate checks. Production still needs the operator's KMS or restricted
cloud-key decision, but no permissive local signing fallback is introduced.

### Evidence

- `src/harness/git-registration.ts`
- `src/harness/git-registration-attestor.ts`
- `src/cloud/trusted-json-reader.ts`
- `tests/harness/trusted-git-registration.test.ts`

## ADR-0050 — Parse every Git operation result before cloud signing

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §2.1, §4

### Context

Registration now parses its verified worker result before signing, but the
source-snapshot and candidate-publication runners still exposed only attestor
interfaces. A production composition could otherwise be tempted to sign fields
derived from a provider artifact reference without proving that the referenced
bytes describe the authorized archive or the exact non-force Git refs.

### Decision

Use artifact-reading production attestors for source snapshots and
publications. Each attestor reads canonical JSON through the verifying trusted
artifact boundary, applies the operation-specific strict parser against the
frozen spec and authorization, constructs the release-safe receipt itself, and
passes a canonical clone to an injected cloud key authority. The runner then
independently verifies the receipt signature and all sandbox, execution,
artifact, lineage, archive, branch, and tag bindings.

The source attestor never reads or interprets repository files from the Mac.
The publication attestor cannot force-push or choose refs; it can attest only
the deterministic refs already authorized for the experiment.

### Alternatives

- Trust a provider download reference without parsing its bytes.
- Let either Git worker hold the signing key.
- Reuse test-only in-memory attestors in production.
- Sign a subset of the archive or ref identity.

### Consequences

The full cloud Git lifecycle now has the same parse-before-sign boundary as
private-fork registration. Production still requires the operator-selected
cloud/KMS key authority and a cloud acceptance run with the private fork.

### Evidence

- `src/harness/git-operation-attestors.ts`
- `src/harness/git-source.ts`
- `src/harness/git-publication.ts`
- `tests/harness/trusted-cloud-git.test.ts`

## ADR-0051 — Reconcile burned budgets before interruption archival

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §5.1, §7.1, §10

### Context

The evaluator must reserve online alpha before any outcome-bearing validation
work starts. If the evaluator or controller fails after that reservation but
before an `ExperimentRunResult` is returned, the durable evaluator ledger has
spent alpha while `CampaignState` still has the earlier counter. The next
validation would either reset the repeated-testing budget or fail permanently
because its cumulative-before value no longer agrees.

The same crash class affects ordinary budget dimensions. The runner checkpoints
correctness-gate cost, repair cost, a promotion look, validation attempts, and
diagnostic releases in its durable journal before final campaign completion.
Archiving an interrupted experiment without reconciling those records would
make failed work appear free.

### Decision

Before archiving any still-in-flight interrupted experiment, the coordinator
requires a trusted completion-material service to read the evaluator-owned
online-error authority, the experiment journal, and trusted operation ledgers.
The service returns a verifier-authorized next usage vector plus the exact
task-free online-error reconciliation receipt. The coordinator validates the
campaign hash, calibrated maximum, state commitments, nondecreasing bounded
counters, and exact alpha equality, writes the budget checkpoint, and only
then archives the experiment and applies pause/stop control.

If a crash occurs after the budget checkpoint but before archival, recovery
observes the same or newer trusted counters, skips a duplicate write, and
continues the archive. An evaluator reservation is never refunded, while the
controller has no interface for inventing or lowering a counter.

### Alternatives

- Charge alpha only when a successful result envelope is returned.
- Refund alpha or paid work after infrastructure failure.
- Archive first and reconstruct counters from process memory.
- Reconcile only online alpha and ignore the runner's other checkpoints.

### Consequences

Interruption recovery remains conservative: uncertainty consumes budget rather
than creating free adaptive looks. Production composition must provide the
trusted material service and campaign budget-attestation verifier; the
interface and crash-window tests are implemented, but cloud acceptance remains
required.

### Evidence

- `src/evaluator/online-error-authority.ts`
- `src/cloud/mounted-volume-online-error-budget.ts`
- `src/orchestrator/campaign-state-coordinator.ts`
- `tests/evaluator/online-error-authority.test.ts`
- `tests/orchestrator/campaign-state-coordinator.test.ts`

## ADR-0052 — Spend online validation alpha before outcome visibility

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §6.4, §8

### Context

A counter updated only after a signed validation result undercounts failed or
interrupted looks. It also lets concurrent evaluators read the same remaining
alpha and spend it twice. Both failures invalidate repeated-testing control:
an operator could recover alpha by inducing a provider failure, while two
workers could use a threshold intended for one look. The optimizer and Pi
must not gain task identity through the remedy.

### Decision

Keep the online error budget in a fenced trusted-cloud CAS store. After the
one-use hidden panel is bound and before the Terminal-Bench runner starts, an
authority reserves the deterministic `6/(pi² n²)` gate allocation by immutable
validation request hash. Exact replay returns the existing reservation;
request-ID mutation fails; CAS conflict retries against the new state; budget
exhaustion and persistent contention fail closed. A successful CAS is the
spend, so no later failure path can refund it.

The canonical policy binds that exact reservation. The signed validation
release contains only release-safe alpha accounting and cryptographic state
commitments—never panel, task, cell, attempt, grader, or trajectory identity.
The blind broker maps those fields into `ValidationAggregate`. The experiment
runner requires the reservation's cumulative-before value to equal its current
campaign usage, spends exactly `alphaSpent`, and requires cumulative-after and
remaining values to reconcile to the sealed maximum. Campaign recovery must
read the evaluator authority to account for a burned look that produced no
release. That read returns an exact-key, release-safe reconciliation receipt
binding the durable revision, calibrated maximum, spent and remaining alpha,
gate count, resulting statistical-state hash, durable-state commitment, and
observation time. The receipt is scoped to
`onlineErrorBudgetCampaignIdHash(campaignId)`, a safe-ID-validated,
domain-separated campaign hash; recovery rejects a receipt from any other
campaign. A trusted accounting attestation must authorize the corresponding
monotonic CampaignState update before an interrupted experiment is archived.

`BudgetSnapshot` now treats `maximumOnlineError` and `onlineErrorSpent` as
first-class finite `[0,1]` dimensions. Negative deltas are rejected, count
dimensions remain safe integers, and existing usage may not exceed any sealed
limit. The production bootstrap requires `DF_BUDGET_ONLINE_ERROR`; the
currently calibrated protocol accepts at most `0.05`.

### Alternatives

- Spend alpha only after a successful signed result.
- Keep the counter in controller memory.
- Let each evaluator derive its threshold from a caller-provided snapshot.
- Refund alpha after infrastructure failure.

### Consequences

Provider failures can consume campaign error budget, intentionally. This is
the conservative price of making retries unable to manufacture statistical
power. The release remains task-agnostic, while state commitments give the
coordinator enough evidence to reconcile successful runs. Cloud acceptance
still has to run the mounted-volume, concurrent CAS, exhaustion, failure-burn,
tamper/replay, schema, and runner propagation tests.

### Evidence

- `src/evaluator/online-error-authority.ts`
- `src/cloud/mounted-volume-online-error-budget.ts`
- `src/evaluator/policy-resolver.ts`
- `src/evaluator/deriver.ts`
- `src/schemas/trusted.ts`
- `src/orchestrator/experiment-runner.ts`
- `tests/evaluator/online-error-authority.test.ts`
- `tests/cloud/mounted-volume-online-error-budget.test.ts`

## ADR-0053 — Put the experiment transaction journal on the fenced campaign volume

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §5.1, §6, §10

### Context

The production experiment journal uses a two-phase pending-operation record so
it can resume exact writes after a controller crash. Leaving its
`AtomicExperimentJournalStateStore` as an interface while other campaign
ledgers use the provider-mounted transaction primitive would create a
production gap: experiment JSON might be durable, but the operation that was
allowed to write it would not be recoverable across controller replacement.

### Decision

Back the journal state with the same provider-attested, fenced,
linearizable mounted-volume transaction store used by the broker and
online-error ledgers. The adapter validates the complete journal state before
and after every transition, uses a domain-separated campaign namespace, and
requires a clean close to release the controller fence. `ExperimentStore`
continues to hold immutable experiment artifacts; this adapter holds only the
transaction/recovery journal.

### Alternatives

- Keep journal state in controller memory.
- Infer pending operations from partially written experiment directories.
- Add a separate mutable SQLite database.
- Reuse an unfenced filesystem lock with a timeout.

### Consequences

Pending operations and the seal-chain cursor survive clean controller handoff
without introducing a workstation execution path. The exact production volume
class still must pass the mounted-volume semantics and crash-recovery suite in
cloud CI.

### Evidence

- `src/orchestrator/experiment-journal.ts`
- `src/cloud/mounted-volume-experiment-journal.ts`
- `tests/cloud/mounted-volume-experiment-journal.test.ts`

## ADR-0054 — Share one fenced state across optimization coordination ports

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §5.1, §10.1, §12

### Context

The campaign coordinator must prepare task-free optimizer input, verify a
recovered checkpoint path, and resolve interruptions. Independent in-memory
ports could reissue changed input after restart, accept a rolled-back path, or
lose interruption intent between broker exposure and the final state update.

### Decision

Use one campaign-scoped, fenced, linearizable mounted-volume state for all
three production ports. Preparation is idempotent by allocation-state hash and
permits only the bounded continuation of the same task-free diagnostic. Resume
commits only an exact replay or strict append-only checkpoint-chain extension
after trusted attestation. Interruption intent is persisted before return, and
broker-exposure accounting, authorized control, and the final CampaignState
compare-and-swap result are linearized in the same state. A clean close hands
the controller fence to its replacement.

### Alternatives

- Keep the three records in controller memory.
- Give each port an unrelated mutable store.
- Regenerate input and trust the latest checkpoint after every restart.
- Record interruption only after all external effects complete.

### Consequences

Controller replacement cannot silently change issued input, truncate public
history, or forget a partially resolved interruption. The durable record
contains task-free references and commitments, never hidden task identity.
Implementation and adversarial test sources exist; cloud typecheck, tests,
real-volume concurrency, corruption, and handoff acceptance remain pending.

### Evidence

- `src/cloud/mounted-volume-optimization-coordination.ts`
- `src/orchestrator/campaign-state-coordinator.ts`
- `tests/cloud/mounted-volume-optimization-coordination.test.ts`
- `tests/orchestrator/campaign-state-coordinator.test.ts`

## ADR-0055 — Finalize experiments through independent trusted authorities

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §5.1, §6, §7.1, §8.1

### Context

CampaignState is not authoritative for spending incurred before a result
returns, and the journal must not fabricate release-safe artifacts, leak-scan
approval, or interruption diagnostics. A controller crash could otherwise
reset alpha or paid usage, arbitrary JSON could enter a sealed experiment, a
signing key could be reached without scanning the exact subject, or raw error
text could become a task-specific feedback channel.

### Decision

Use independent production authorities around the durable journal:

1. Completion material requires a matching sealed journal for success. On
   interruption it requires the unsealed journal, reconciles evaluator-owned
   online-error state, closes and reads the trusted operation ledger, and
   submits the monotonic maximum of all budget dimensions for immutable
   accounting attestation. Campaign-seal material comes only from a trusted
   seal authority bound to the journal and campaign ledgers.
2. Artifact assembly obtains the exact required policy and provenance
   partitions from task-free trusted providers, validates every strict schema
   and release-safe shape, binds them to the journal snapshot, requires a
   hidden-task-identity exclusion attestation, and durably memoizes the result.
3. Seal authorization scans the exact immutable manifest before cloud-key
   access, verifies the signed receipt, and persists replay/recovery state.
   Raw interruption text terminates at a separate authority; durable state
   contains only a fixed reason category, phase, experiment commitment,
   authority-owned timestamp, and attestation hash.

### Alternatives

- Restore budgets from the last CampaignState checkpoint.
- Reconcile alpha while ignoring other in-flight operation spending.
- Let the coordinator assemble artifacts and attest its own accounting.
- Scan a mutable directory after signing.
- Persist raw exception text for later diagnosis.

### Consequences

Failure cannot manufacture statistical or financial budget, sealing has
explicit least-authority stages, and interruption recovery cannot become a
covert diagnostic channel. Source implementations and adversarial test suites
exist. Concrete cloud/KMS provider bindings, cloud execution, and exact
production-volume recovery acceptance remain pending.

### Evidence

- `src/orchestrator/production-completion-material.ts`
- `src/cloud/mounted-volume-experiment-journal-authorities.ts`
- `src/orchestrator/experiment-journal.ts`
- `src/evaluator/online-error-authority.ts`
- `tests/orchestrator/production-completion-material.test.ts`
- `tests/cloud/mounted-volume-experiment-journal-authorities.test.ts`

## ADR-0058 — Reconstruct CampaignState only through signed exact-payload evidence

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §5.1, §6, §10.1, §12

### Context

`CampaignStateStore` deliberately fails closed unless trusted verifiers approve
genesis, control authorizations, ledger transitions, and experiment decisions.
The interfaces existed, but production had no common adapter that could load
immutable evidence, bind it to the exact verifier callback payload, and check a
cloud-held trust root. Supplying permissive in-process callbacks would let a
controller initialize an unauthorized campaign, accept substituted ledger
pointers, or reconstruct a champion decision without durable signed evidence.

The operator has not yet selected a cloud KMS or secret system. That choice
must remain outside the core, and no workstation key or local evidence lookup
may become a fallback.

### Decision

Use one `ArtifactBackedCampaignAttestationVerifier` for all three
`CampaignStateStore` verification interfaces. For every callback it snapshots
the expected JSON and derives a release-safe lookup tuple containing evidence
kind, campaign, protocol, lookup hash, and exact payload hash.

- Genesis and ledger-transition evidence use the canonical payload hash as the
  lookup because their store contracts contain no separate mutable evidence
  pointer.
- Other control evidence uses the authorization or attestation hash already
  committed by the transition.
- Decision evidence uses its committed decision-attestation hash.

The injected source, JSON reader, and public-key keyring must all declare the
trusted-cloud boundary. The verifier accepts only a bounded
`application/json` artifact and independently rechecks the reader's returned
UTF-8 byte length and SHA-256 against that sealed reference before parsing.
It then requires canonical JSON followed by one newline, an exact top-level
field set, a valid whole-document content hash, and payload bytes canonically
identical to the expected callback. Source lookup, reader, and key-resolution
methods are captured and bound during construction so later mutation of an
injected object cannot redirect verification. Finally, it requires an Ed25519
signature whose key is in a complete predeclared rotation set and whose signing
time equals the authority-issued time. The resolved key record must itself be
trusted-cloud key material with algorithm `Ed25519`, purpose
`campaign-attestation`, the requested key ID, and a bounded version; a
result-envelope or hidden-catalog key cannot be substituted.

Expose a helper that creates the exact unsigned evidence document for a future
cloud/KMS publisher. It snapshots the payload but never resolves private key
material. Provider-specific artifact discovery and campaign-purpose KMS
signing/key resolution remain injected bindings.

### Alternatives

- Treat successful CampaignState schema validation as sufficient authority.
- Accept any signed document that mentions the same campaign.
- Derive all evidence lookups from caller-controlled artifact URIs.
- Reuse an evaluator result-envelope key without a campaign-purpose policy.
- Put an Ed25519 private key or unsigned genesis JSON on the workstation.
- Skip historical keys and make old campaign reconstruction fail after every
  rotation.

### Consequences

Campaign initialization and reconstruction now have a concrete production
verification path without choosing a provider or weakening the cloud-only
boundary. A substituted payload, lookup, campaign, protocol, content hash,
signature, key identifier, media type, or non-canonical encoding fails with one
generic error. The query and document contain only release-safe campaign
control material; hidden task identities and grader evidence have no field in
the contract.

Deployment must retain every trusted historical public key needed by active
campaigns and publish genesis evidence before the initial state is committed.
ADR-0073 later supplies the concrete artifact registry; campaign-purpose KMS
binding, cloud execution, and recovery acceptance remain pending. Focused
source tests cover
genesis, explicit control authorization, ledger, decision, payload
substitution, detached artifact digest/length, an oversized reader response,
non-canonical encoding, post-sign mutation, cross-purpose key substitution,
post-construction dependency redirection, and non-cloud source rejection; they
have not been run on the Mac.

### Evidence

- `src/cloud/trusted-campaign-attestations.ts`
- `src/cloud/trusted-json-reader.ts`
- `tests/cloud/trusted-campaign-attestations.test.ts`

## ADR-0057 — Expose a fixed non-authorizing production-binding readiness receipt

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §10.1, §12

### Context

The trusted cloud entry point previously ended `optimize` with a generic
composition-lock error. That was safe, but it did not tell the operator which
externally supplied runtime contracts were still absent. Echoing environment
values, arbitrary registry keys, implementation objects, or internal
exceptions would make a more detailed error into a source, credential, model,
or hidden-task disclosure channel. Treating a complete declaration as
permission to execute would also bypass the independent signed composition
verifier.

### Decision

Define one provider-independent, ordered binding-set contract for the
production runtime composition surface: signed composition manifest and
verifier; campaign state, input, resume, completion, interruption, and journal
ports; Claude optimizer adapter; correctness gate; and blind broker. Each
supplied binding must be an actual in-process object or function wrapped by a
trusted-cloud boundary marker and a SHA-256 attestation commitment.

The inspector returns only fixed public binding identifiers, `missing` and
`invalid` classifications, boolean malformed/unexpected-registry flags, a
coarse Pi source-configuration status, and canonical binding-set,
attestation-commitment, and receipt hashes. It never serializes or hashes an
implementation value and never reflects an unknown registry key. The cloud
controller persists this receipt through the verifying artifact bridge and
prints its release-safe projection.

Binding readiness is deliberately not execution readiness. The receipt always
states `runtimeCompositionVerified: false` and `runnable: false`, including
when every binding is present. Only the separate trusted composition verifier
and runtime composer may later authorize the paid loop. The current cloud
entry point supplies no production objects, so it reports the complete missing
surface and exits nonzero without making a model, secret, KMS, or provider
choice.

### Alternatives

- Keep the generic lock error.
- Report raw missing environment-variable names and implementation errors.
- Accept a JSON environment manifest as proof that executable objects exist.
- Let a complete binding declaration start optimization directly.
- Reflect unknown binding keys to make configuration debugging easier.

### Consequences

The operator receives deterministic, actionable, content-addressed readiness
evidence without widening the release boundary. A declaration cannot
impersonate an implementation or bypass signed composition verification.
Adding or removing a required runtime contract changes the public binding-set
hash and therefore requires review. The control plane remains intentionally
unable to run real optimization until the actual bindings, their independent
attestations, cloud quality evidence, and operator-selected external choices
are supplied.

### Evidence

- `src/cloud/production-optimize-binding-readiness.ts`
- `src/cloud/control-plane.ts`
- `src/cloud/index.ts`
- `tests/cloud/production-optimize-binding-readiness.test.ts`

## ADR-0059 — Reconcile durable external stops through the experiment archive boundary

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §5.1, §10

### Context

The autonomous coordinator originally assumed that it alone would classify an
interruption and write the resulting pause or stop. A separate trusted control
process can instead write `stop-requested` while an optimization is in flight.
Rejecting that monotonic state made the campaign unrecoverable. Binding
interruption control to whichever state happened to be current also changed
the binding after archival or stop acknowledgement, so a crash before
`markApplied` could make an exact retry fail forever. Finally, classifying an
operator stop from arbitrary provider exception prose allowed an untrusted
error string to manufacture control authority.

### Decision

Treat the durable CampaignState control transition—not exception text—as the
authority that an external stop exists. A result that completed concurrently
may seal its already determined disposition and then acknowledge the stop. If
work did not complete, the coordinator resolves the exact persisted claim,
reconciles evaluator and journal budget consumption, records the new
broker-exposure attestation, archives the monotonic experiment number, and only
then acknowledges the stop.

Recover the unique interruption archive-transition hash from the verified
CampaignHistory and use that immutable hash for every `prepareControl` retry.
This binding survives later pause, stop-request, and stop-acknowledgement
states. A durable external stop may supersede a pending infrastructure,
integrity, or budget pause only after the original interruption has passed
claim, budget, and archive validation. An operator-stop authorization must
still reproduce the exact durable stop reason. Failure classification now maps
only budget and integrity categories from exceptions; every other runner error
is infrastructure. SIGINT, SIGTERM, and human stop requests must use the
separate authenticated control path.

### Alternatives

- Reject any non-running state observed during claim recovery.
- Discard the pending interruption when a stop races with it.
- Bind control preparation to the latest state hash on every retry.
- Infer operator intent from words such as `stop`, `signal`, or `interrupt` in
  provider error text.
- Acknowledge stopped before reconciling or archiving in-flight work.

### Consequences

An external controller can stop an active campaign without losing consumed
budget, reusing an experiment number, changing a completed outcome, or
stranding a pending pause. Crash recovery reuses one durable control binding,
and a conflicting stop reason fails closed. The source tests cover idle stop,
in-flight archive, completed-result sealing, pending-pause precedence,
post-acknowledgement crash recovery, reason conflict, and malicious provider
text. They have not run on the Mac; cloud-only quality and provider-volume
recovery acceptance remain pending. Active sandbox cancellation and actual
process-signal wiring are still deployment work.

### Evidence

- `src/orchestrator/campaign-state-coordinator.ts`
- `src/orchestrator/autonomous-loop.ts`
- `src/orchestrator/production-runtime.ts`
- `tests/orchestrator/campaign-state-coordinator.test.ts`
- `tests/orchestrator/autonomous-loop.test.ts`
- `tests/orchestrator/production-runtime.test.ts`

## ADR-0070 — Persist evaluator request burns before transport

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §3.3, §7.1, §8.1, §10.1

### Context

The canonical evaluator client consumes a one-use evaluation request before
submitting it to the trusted remote evaluator. Its existing ephemeral replay
ledger is deliberately test-only. In production, losing that process-local
state on a controller timeout or restart would allow the same request to be
submitted again. Hidden-panel reuse under a newly authorized request is a
separate broker/evaluator one-use-ledger concern; this task-free client ledger
cannot and must not inspect panel identity.

A transport failure cannot prove that the evaluator did not start, observe a
result, or spend online error and campaign budget. Replay protection must
therefore be durable before transport and cannot be inferred later from a
successful release envelope.

### Decision

Implement `MountedVolumeCanonicalEvaluatorReplayLedger` as the production
`CanonicalEvaluatorReplayLedger` adapter. Before any state access it validates
an exact request claim containing:

- a bounded safe request ID;
- a lowercase SHA-256 canonical request hash; and
- a canonical ISO timestamp.

The adapter stores only those three values plus a domain-separated claim hash.
Its strict state has a monotonic revision, a request-ID map, and an inverse
request-hash map. Every state load proves exact keys, cardinality equality,
one-to-one forward/reverse links, claim hashes, and a bounded 100,000-claim
ceiling. Duplicate IDs and duplicate hashes both return `false`; malformed or
divergent state fails closed.

The adapter uses `MountedVolumeTransactionalJsonStore`, so the write is
canonical, content-addressed, atomically replaced, durable, and reconciled
against a non-rollback fence under an attested linearizable volume. Concurrent
claims serialize, and exactly one can succeed. A clean controller closes its
writer lease while preserving state. An unclean successor still requires the
store's provider-attested predecessor-termination recovery authority.

The claim method remains an asynchronous contract even for malformed input,
so callers always receive a rejected promise rather than an unexpected
synchronous exception. No release, refund, delete, state-read, task identity,
panel content, or optimizer-visible projection is exposed.

### Alternatives

- Use the process-local ephemeral set in production.
- Persist only request IDs, allowing identical request bytes under a new ID.
- Burn the request after a successful evaluator response.
- Refund a request after timeout, invalid signature, or malformed release.
- Reconstruct consumption only from successful result envelopes.
- Store task or panel metadata alongside replay commitments.
- Permit an operator or optimizer to inspect or clear the ledger.

### Consequences

An evaluator timeout, invalid release, or controller restart permanently
consumes the submitted request and panel. The broker must allocate a new panel
within the predeclared replacement budget; this spends more capacity in
exchange for preventing adaptive replay and uncertainty laundering. A
100,000-claim campaign must stop or start a newly governed lineage rather than
grow unbounded state.

The MVP's direct in-process release-bundle service must not instantiate this
adapter: the durable blind-broker lease and the evaluator's one-use request
ledger already bracket that call without a transport ambiguity. If a later
deployment introduces a remote evaluator transport, its composition must
instantiate this adapter with the exact campaign volume, register `close()`
with that transport owner's lifecycle immediately after construction, and bind
unclean recovery to a real provider termination attestation. The focused
source tests cover clean handoff, concurrent claims, and pre-write
malformed-input rejection. They have not run on the Mac; cloud-only typecheck,
execution, crash recovery, rollback, and provider-volume acceptance remain
required.

### Evidence

- `src/cloud/mounted-volume-evaluator-replay-ledger.ts`
- `src/cloud/index.ts`
- `tests/cloud/mounted-volume-evaluator-replay-ledger.test.ts`

## ADR-0060 — Reserve controller environment names against secret-target collisions

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §2.3, §10.1

### Context

The GitHub-hosted bootstrap passes validated task-free configuration as normal
environment variables and maps separately named Daytona organization Secrets
into the control sandbox. The additional secret-binding list previously
rejected only `PATH`, `DAYTONA_API_KEY`, and duplicate targets. A mapping could
therefore collide with a trusted runtime marker, campaign volume, source pin,
model or protocol choice, provider identity, Node loader option, or shell
startup control. Depending on provider merge precedence, that would be either
ambiguous or attacker-controlled configuration.

### Decision

Define the controller-owned configuration and optimize-source environment
names once and use the same lists for forwarding and collision rejection.
Reserve the fixed cloud, campaign, volume, Daytona identity, process path,
shell-startup, and locale names. Also reject target prefixes controlled by the
provider, GitHub runner, Node/npm/pnpm/Corepack, and platform dynamic loaders.
Validate the complete mapping before a provider client is resolved or a
sandbox is created. Secret source names remain opaque identifiers; no value is
read or logged.

### Alternatives

- Let Daytona decide which duplicate environment source wins.
- Reject only the two originally known dangerous names.
- Allow arbitrary targets and compare the returned sandbox environment later.
- Resolve secret values in the GitHub runner and build one merged map.

### Consequences

An additional KMS or service credential can still be mapped to a distinct
credential variable such as the existing `DF_KMS_CREDENTIAL`, but it cannot
replace controller authority, source identity, process startup, or provider
attestation inputs. Focused source tests cover representative trusted marker,
Pi pin, Daytona identity, Node loader, dynamic loader, and locale collisions.
They have not run locally; cloud quality and a real Daytona merge-behavior
contract test remain pending.

### Evidence

- `src/cloud/control-bootstrap.ts`
- `tests/cloud/control-bootstrap.test.ts`

## ADR-0062 — Attest the exact nine executable runtime ports

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §5.1, §10.1, §12

### Context

The production runtime already checked role-image descriptors and trusted
boundary strings before joining the autonomous loop. Those checks did not
prove that the concrete campaign store, coordination ports, journal,
optimizer, correctness gate, and broker were the implementations approved by
the independent composition authority. A caller could construct a structurally
compatible object, copy a boundary literal, and pair it with a valid role
descriptor. Reading executable objects from environment or JSON would be an
even less trustworthy form of the same substitution.

The bootstrap readiness receipt has eleven slots: two prerequisites—the signed
composition manifest and its independent verifier—plus nine executable runtime
ports. Putting all eleven into the signed manifest's runtime-port commitment is
not possible without recursion: the manifest cannot commit to the attestation
of itself, and the verifier receipt cannot be an input to the verification
that creates it.

### Decision

Define one frozen, ordered nine-port contract:

1. campaign state store;
2. optimization input factory;
3. optimization resume verifier;
4. optimization completion material;
5. optimization interruption port;
6. experiment journal;
7. optimizer adapter;
8. correctness gate; and
9. blind broker.

The signed production manifest contains exactly those fixed task-free port IDs
and one SHA-256 attestation digest per port. Each actual component port must
also have a strict in-process trusted-cloud wrapper containing the same ID and
digest. Composition requires the wrapper's `implementation` to be
reference-equal to the raw component port before any verifier call. Missing,
plain, extended, reordered, detached, or digest-mutated wrappers fail closed.
Executable implementations never have a JSON manifest representation and are
never resolved from environment data.

The independent verifier receives a canonical copy of the signed manifest and
a separate canonical copy containing only the nine fixed IDs and digests. It
never receives a wrapper or implementation. Its strict receipt must reproduce
the same domain-separated runtime-port commitment hash in addition to the
component and operational binding hashes. Verifier and port methods are then
captured, so later caller-side object mutation cannot redirect the composed
runtime.

The cloud bootstrap readiness specifications derive their nine executable
entries from this frozen runtime-port list and prepend only the two recursive
prerequisites. A focused equality test prevents the eleven-slot diagnostic
surface from drifting away from the nine-port executable contract.

### Alternatives

- Trust structural TypeScript compatibility and boundary string literals.
- Put implementation objects or function source into the signed JSON manifest.
- Resolve executable ports from environment variables or a JSON registry.
- Include the manifest and verifier in their own runtime-port commitment.
- Let the verifier attest a list independently reconstructed from configuration.
- Verify wrapper digests without requiring implementation reference equality.

### Consequences

A production runtime cannot be composed from unattested look-alikes, detached
objects, or declaration-only configuration. The signed manifest, concrete
wrappers, and independent verifier receipt converge on one fixed commitment
without giving the verifier access to executable or task-bearing objects.
Provider-specific authorities still must produce and verify the nine
attestation receipts, and the source tests still require cloud-only typecheck,
execution, mutation, and recovery acceptance.

### Evidence

- `src/orchestrator/production-runtime.ts`
- `tests/orchestrator/production-runtime.test.ts`
- `src/cloud/production-optimize-binding-readiness.ts`
- `tests/cloud/production-optimize-binding-readiness.test.ts`

## ADR-0061 — Bootstrap production optimize from one signed task-free artifact descriptor

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §2.3, §5.1, §10.1, §12

### Context

The protected GitHub workflow can authenticate an operator-approved launch and
create a Daytona controller, but the controller still needs a durable,
campaign-specific way to discover the exact signed production-composition
manifest. Passing an arbitrary URI is insufficient: it does not bind artifact
bytes, campaign lineage, protocol, trust authority, key rotation, or verifier
policy. Passing a JSON registry of constructors is worse because configuration
would become dependency injection. Loading a local path would violate the
cloud-only boundary.

The manifest also cannot recursively define the authority that makes its own
signature trustworthy. A verifier receipt cannot be an input to the
verification that produces that receipt. The transport boundary therefore has
to carry independent, pre-governed commitments without selecting a concrete
provider, model, key authority implementation, or executable runtime port.
Nothing in this bootstrap path may contain benchmark task, panel, cell, raw
evidence, or grader identities.

### Decision

Require paid `optimize` dispatches to provide
`DF_PRODUCTION_OPTIMIZE_BOOTSTRAP_DESCRIPTOR_JSON` as exact canonical JSON
without a trailing newline. The strict signed descriptor has one version and
domain, bounded safe identifiers, campaign/lineage/protocol identities, one
exact `TrustedCloudArtifactRef`, the expected composition-manifest hash, issue
and expiry times, and three independent SHA-256 commitments:

- the allowed authority set;
- the verification key set; and
- the verifier policy.

A fourth domain-separated commitment hashes exactly those three values. It
cannot include the descriptor hash, signature, verifier receipt, or artifact
bytes, which avoids circular trust. The descriptor hash covers every unsigned
field, and the Ed25519 signature remains subject to a separately supplied
trusted descriptor verifier. The implementation provides no default key,
provider, model, endpoint, or authority document.

The GitHub-hosted control bootstrap parses at most 64 KiB, rejects a BOM, NUL,
noncanonical representation, extra or missing properties, malformed trusted
URI/media/hash/length/timestamp/signature values, inconsistent self-hashes, and
a campaign mismatch. It stores the parsed descriptor in the validated request,
re-canonicalizes it for the Daytona controller, forwards it only for
`optimize`, and reserves the environment name against organization-Secret
target collisions.

Inside the trusted controller, construct
`VerifiedProductionOptimizeBootstrapArtifactLoader` only with two executable
objects supplied outside JSON:

1. a purpose-bound trusted descriptor verifier that returns a strict receipt
   reproducing the descriptor hash, signing key ID, all three independent
   commitments, their domain-separated commitment, and a verifier-attestation
   hash; and
2. a trusted-cloud artifact reader that accepts the exact
   `TrustedCloudArtifactRef` and a hard maximum byte count.

The loader captures both methods at construction, checks descriptor freshness,
and reads no local path. It independently checks returned UTF-8 byte length and
SHA-256 against the immutable reference, requires exact canonical JSON with one
final newline, and checks that the document is the expected trusted-cloud
composition for the same campaign, lineage, protocol, and manifest hash. It
also requires all six information-boundary flags to be false and validates the
exact ordered nine `{portId, attestationSha256}` commitments using the runtime's
single exported task-free port-ID list.

The result is deliberately non-authorizing. Its content-addressed receipt says
only `descriptorAuthorityVerified: true` and
`artifactTransportVerified: true`; it fixes
`compositionAuthorityVerified: false` and
`executableBindingsCreated: false`. A separate production composition owner
must validate the complete manifest and signature, resolve independently
attested in-process runtime-port wrappers, and authorize construction. Neither
the environment parser nor the artifact loader instantiates an executable
port.

### Alternatives

- Pass only a mutable artifact URI in the protected workflow.
- Put constructors, module names, provider choices, models, credentials, or
  executable bindings in JSON or environment variables.
- Let the controller read a composition file from its image or the Mac.
- Treat content-addressing as signature or authority verification.
- Put a verifier receipt, descriptor signature, or descriptor hash inside the
  authority/key/policy commitment that the receipt is supposed to verify.
- Let the bootstrap loader claim full composition authorization.
- Maintain another hand-copied list of production runtime-port IDs.

### Consequences

Protected dispatch now has a strict, task-free, replay-bounded bridge from
operator-governed configuration to one exact cloud artifact. Descriptor
authority, artifact transport, composition authority, and executable
construction remain separate claims, so success at an earlier boundary cannot
silently authorize the next one. Campaign detachment, byte substitution,
noncanonical representations, trust-policy substitution, task-bearing
information flags, runtime-port drift, and secret-target override fail closed.

The protected environment must still publish a real signed descriptor and the
independently governed authority-set, key-set, and verifier-policy material.
Concrete trusted verifier and artifact-reader bindings, composition-owner
integration, key rotation/revocation operations, and the full mutation/expiry
suite remain to be exercised in approved cloud CI. The focused source tests
have been authored but have not run on the Mac.

### Evidence

- `src/cloud/production-optimize-bootstrap.ts`
- `src/cloud/control-bootstrap.ts`
- `src/cloud/index.ts`
- `tests/cloud/production-optimize-bootstrap.test.ts`
- `tests/cloud/control-bootstrap.test.ts`
- `.github/workflows/paid-optimize.yml`
- `.env.example`
- `CLOUD_DELIVERY.md`

## ADR-0063 — Give each production optimize invocation one lifecycle owner

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §2.3, §5.1, §10.1, §12

### Context

A verified composition artifact is data, not an executable dependency
container. The production runtime also intentionally has no resource-lifecycle
API. A control process therefore still needed a provider-neutral authority to
join the independently verified manifest to concrete in-process ports, create
or reconstruct campaign state idempotently, invoke the sealed runtime, and
release every mounted store and provider lease. Letting the control plane
resolve constructors, commands, or modules from environment or JSON would turn
untrusted configuration into execution authority.

Campaign creation has three independent prerequisites: the registered private
Pi source, the authorized campaign genesis, and the hidden-catalog genesis.
The broker-policy hash cannot stand in for the last prerequisite; it describes
behavior, not catalog state. Concurrent invocations and partial construction
also create lifecycle risks. A factory can acquire several resources and fail
before returning, and a successful runtime call is not successful if releasing
an owned writer lease fails.

### Decision

Use `ProductionOptimizeCompositionOwner` as a one-shot owner for exactly one
`status` or `run` call. It accepts the signed task-free data manifest plus
exactly three trusted in-process authorities: the independent
composition-attestation verifier, an idempotent bootstrap-or-reconstruct port,
and a runtime factory. Its options schema rejects extra fields. No URI,
environment value, JSON document, module name, command, or constructor can
supply an executable binding.

Before constructing runtime ports, the owner:

1. revalidates a private canonical copy of the manifest;
2. obtains and strictly checks the composition-verifier receipt over the exact
   ordered nine runtime-port commitments;
3. derives a canonical bootstrap request whose source, genesis, and catalog
   prerequisites equal `harnessRegistrationHash`, `campaignGenesisHash`, and
   `hiddenCatalogGenesisHash` respectively; and
4. requires a strict content-addressed receipt that reproduces those values,
   the manifest/campaign/lineage/protocol identity, durable request hash,
   disposition, resulting campaign/catalog state hashes, and idempotency
   claims.

The request hash is the concrete bootstrap port's durable idempotency key. The
port must verify every prerequisite before initializing or exactly
reconstructing genesis. Campaign and catalog stores are coordinated through
the recoverable strict-prefix journal defined by ADR-0069; they are not
described as one physical atomic transaction. Only then may the trusted
factory return role components and the nine reference-equal runtime-port
wrappers. The owner calls `composeProductionOptimizationRuntime`, then
delegates the selected operation to that production runtime. Every later
verification must reproduce the initial verifier receipt exactly.

Bootstrap and factory authorities receive an owner-created lifecycle
registrar. They must register each mounted store, writer lease, provider lease,
or other owner-scoped resource immediately after acquisition, including during
partial construction or lazy runtime use. The owner captures each close method,
rejects duplicate object or lifecycle identities, closes the entire stack in
reverse registration order on every success or failure path, continues after
individual close failures, and fails the invocation if any close fails.

An owner is permanently consumed by its first call. A process-local campaign
fence rejects concurrent owners for the same campaign. This is defense in
depth; the concrete campaign store must still enforce an attested durable
single-writer fence across processes and controller recovery.

### Alternatives

- Resolve runtime constructors or commands from the signed artifact,
  environment variables, or a JSON registry.
- Treat the artifact loader's transport receipt as composition authority.
- Substitute `brokerPolicyHash` for an actual hidden-catalog genesis
  commitment.
- Create new campaign/catalog state on every invocation.
- Let callers invoke `status` and then `run` on one long-lived owner.
- Close only the resources returned by a fully successful factory.
- Stop closing after the first release error or report success despite it.
- Rely only on a process-local concurrency set as the production writer lock.

### Consequences

The integration surface is intentionally narrow: the controller loads and
verifies the task-free descriptor/artifact, supplies concrete trusted ports,
constructs one owner, and calls `status` or `run`. Partial bootstrap, factory,
composition, verifier, status, and run failures all share the same reverse
cleanup path. Task, panel, cell, grader evidence, and benchmark identities have
no field in the owner request or receipt.

The following concrete production bindings remain deployment work:

- a provider/KMS-backed descriptor and composition verifier with rotation and
  revocation;
- an artifact reader for the protected cloud store;
- governed immutable prerequisite registries and public-key authorities plus
  concrete campaign/catalog genesis authorities for the implemented
  bootstrap-or-reconstruct port;
- the ADR-0072 concrete nine-port factory's independently authenticated
  dependency attestation and real provider/KMS/artifact authority inputs for
  its optimizer, correctness, evaluator, journal, campaign coordination,
  completion, and interruption implementations;
- registration of every mounted store and provider lease with the owner;
- durable cross-process campaign fencing, lease recovery, and same-runtime
  mounted-volume canary enforcement; and
- control-plane wiring from the loaded artifact to owner construction without
  adding an executable registry.

Focused source tests cover successful `status` and `run`, exact prerequisite
binding, reverse cleanup after partial factory failure, continued cleanup plus
fail-closed behavior on close error, concurrent-owner rejection, and one-shot
reuse rejection. They have not run on the Mac; cloud-only typecheck, execution,
mutation, crash-recovery, and provider-volume acceptance remain required.

### Evidence

- `src/cloud/production-optimize-composition-owner.ts`
- `src/cloud/index.ts`
- `src/orchestrator/production-runtime.ts`
- `tests/cloud/production-optimize-composition-owner.test.ts`

## ADR-0065 — Verify bootstrap descriptors with public-only rotation-aware Ed25519 authority

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §2.3, §5.1, §10.1, §12

### Context

ADR-0061 defined the signed task-free production-optimize descriptor and an
injected verifier port, but a boundary string and a caller-produced
`verified: true` receipt are not cryptographic verification. The production
controller needs a concrete implementation that can work with any cloud KMS
or governed public-key registry without accepting environment variables,
private keys, mutable aliases, or descriptor-selected trust policy.

The descriptor contains an Ed25519 key ID but intentionally does not contain a
key implementation or key-version schedule. Its authority-set, verification
key-set, and verifier-policy hashes are signed inputs, yet they are not trusted
merely because the descriptor repeats them. Rotation must preserve historical
verification while preventing an old, future, revoked, wrong-purpose, or
overlapping key version from becoming valid.

### Decision

Implement
`Ed25519ProductionOptimizeBootstrapDescriptorVerifier` as the concrete
provider-neutral
`TrustedProductionOptimizeBootstrapDescriptorVerifier`. Construction requires:

- one purpose-specific trusted public-key authority;
- a bounded, explicit, non-overlapping rotation schedule of key ID, key
  version, and half-open `[validFrom, validUntil)` windows;
- independently configured `authoritySetHash`, `verificationKeySetHash`,
  `verifierPolicyHash`, and their domain-separated
  `verificationCommitmentHash`; and
- an optional bounded clock-skew policy and injected clock.

The verifier recomputes the trust commitment at construction and captures the
authority method. For each call it first creates a private canonical snapshot,
strictly validates the exact descriptor schema and current validity, rebuilds
the complete unsigned payload, reproduces `descriptorHash`, and requires all
four descriptor commitments to equal the independent configuration. The
signature key ID and canonical `signedAt` must select exactly one configured
rotation, and the signature cannot be later than the captured clock plus the
explicit skew allowance.

The frozen authority request fixes one domain and purpose,
`production-optimize-bootstrap-descriptor`, plus the key ID/version, signed
time, and all four trust commitments. The authority response has an exact
schema and must reproduce the same purpose, ID, version, half-open window,
authority-set hash, and key-set hash with `revoked: false`.

Only SubjectPublicKeyInfo DER bytes are representable as key material. The
verifier passes them to Node as `type: "spki"`, then requires a public Ed25519
key. It does not accept a `KeyLike`, PEM, PKCS#8 document, private-key field, or
signing method. The descriptor is rechecked against a fresh captured time
after asynchronous resolution, and backward clock movement outside the
declared skew fails closed. The exact signature is then verified over the
canonical signing payload, which includes the descriptor hash and signature
metadata.

The returned receipt has exactly the existing bootstrap-verification fields.
Its deterministic `verifierAttestationHash` binds the descriptor and signature
hashes, signing key ID/version, rotation window and non-revoked status, public
SPKI fingerprint, frozen key-resolution request, bounded clock-skew value, and
all four independently configured commitments. It contains neither public-key
bytes nor provider identity and makes no composition-authority or
executable-binding claim.

Artifact reading remains separate. The existing
`VerifyingTrustedJsonArtifactReader` is the source type for the bootstrap
loader's exact public `boundary`/`readUtf8(artifact, maximumBytes)` projection
and continues to verify the bridge, EOF, byte count, digest, UTF-8, BOM, and
NUL conditions. This ADR adds no reader, filesystem fallback, or
storage-provider choice.

### Alternatives

- Trust any object returning `verified: true`.
- Resolve a key ID from an environment variable or mutable provider alias.
- Let the signed descriptor provide the only copy of its trust commitments.
- Accept any syntactically valid key version returned by the authority.
- Select a key version without a predeclared non-overlapping rotation window.
- Accept a general `KeyLike` or private key and derive its public half.
- Verify only `descriptorHash` rather than the exact canonical signing payload.
- Add provider-specific KMS logic or another artifact reader to the verifier.

### Consequences

The bootstrap loader now has a concrete cryptographic verifier that remains
independent of cloud vendor and private-key handling. Wrong purpose, key,
version, rotation window, revocation state, trust commitment, descriptor
freshness, schema, hash, signature, and public-key algorithm fail closed.
Method capture and pre-await descriptor snapshots prevent caller mutation from
redirecting an in-flight verification.

Deployment still must implement the public-key authority against the selected
governed KMS/registry, publish and retain the independently reviewed rotation
and trust-policy configuration, define revocation operations, and bind that
authority with the existing verified artifact bridge inside the trusted
controller. The focused tests are authored but have not run locally; cloud-only
typecheck, execution, provider integration, rotation, revocation, clock, and
mutation acceptance remain required.

### Evidence

- `src/cloud/production-optimize-bootstrap-verifier.ts`
- `src/cloud/production-optimize-bootstrap.ts`
- `src/cloud/trusted-json-reader.ts`
- `src/cloud/index.ts`
- `tests/cloud/production-optimize-bootstrap-verifier.test.ts`
- `tests/cloud/production-optimize-bootstrap.test.ts`

## ADR-0067 — Grant control-plane secrets and network by command

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §2.3, §8, §10.1

### Context

The GitHub-hosted bootstrap creates a short-lived trusted Daytona controller.
Its request contains organization-secret names for the nested Daytona
credential and optional controller authorities. Supplying that entire set to
every command violated least privilege: the deterministic synthetic campaign
does not call a provider or signer, while the provider probe needs Daytona but
does not need Git, model, or signing authority. The synthetic command also
inherited an outbound domain allowlist despite requiring no network.

Organization-secret names are not their values, but granting an unused name
still causes the provider to resolve and expose its value inside that sandbox.
The release-safe request therefore cannot be treated as harmless metadata at
the final provider boundary.

### Decision

Keep parsing and validating the complete binding configuration before launch,
including reserved-target and duplicate-target checks, but derive the actual
Daytona secret map from the selected command:

- `synthetic` receives no organization secrets;
- `probe` receives only the nested `DAYTONA_API_KEY` organization-secret
  mapping needed to create and tear down readiness sandboxes;
- `optimize` receives that nested provider mapping plus the explicitly
  reviewed additional controller bindings; and
- currently locked `status`, `stop`, and `resume` receive no secret grant
  until their signed production semantics specify an exact need.

The bootstrap also forces `synthetic` and `status` to `networkBlockAll`
regardless of a broader configured control allowlist. Provider probe and
optimize retain only the normalized, bounded domain allowlist already validated
by the bootstrap. The outer GitHub runner's Daytona API value remains
bootstrap-only and is never serialized into the provider request.

### Alternatives

- Grant the union of all controller secrets to every command.
- Trust a command not to read unused injected credentials.
- Give synthetic the configured network allowlist for operational
  convenience.
- Stop validating unused secret mappings, allowing an unsafe configuration to
  become active when a later command uses it.
- Predict credentials for the still-locked status, stop, and resume commands.

### Consequences

A synthetic smoke run can no longer reach the network or obtain provider,
repository, model, or signing credentials. A probe can exercise Daytona
without inheriting unrelated authority. Paid optimize keeps the capabilities
needed by its production composition, but only after existing image-bound
authorization and descriptor validation.

When status, stop, or resume are implemented, their command contracts must
declare and test any provider or authority grant before the bootstrap supplies
it. Focused source tests assert the exact empty, probe-only, and optimize maps
and synthetic network blocking. They have not run on the Mac; cloud-only
execution remains required.

### Evidence

- `src/cloud/control-bootstrap.ts`
- `tests/cloud/control-bootstrap.test.ts`

## ADR-0064 — Verify production composition through a separately signed artifact set

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §2.3, §5.1, §10.1, §12

### Context

The production runtime requires an independent
`TrustedProductionCompositionAttestationVerifier`, but a boundary string and a
caller-produced `verified: true` receipt do not establish composition
authority. Verifying only the manifest signature would authenticate its
declarations without proving that the four role images, source archives,
configurations, operational prerequisites, and nine concrete runtime-port
bindings have corresponding provider evidence. Content addressing those
evidence documents proves byte identity, not who authorized the bytes.

The runtime-port digest also cannot be the SHA-256 of an artifact that contains
the final manifest hash: the manifest includes the digest, so that construction
would be recursive. Executable implementations, private keys, environment
registries, module names, commands, tasks, and grader data must remain outside
the verifier protocol.

### Decision

Implement
`ArtifactBackedProductionCompositionAttestationVerifier` as a provider-neutral
concrete implementation of the production verifier port. It accepts only
captured in-process methods for:

1. an immutable artifact-set source;
2. the bounded trusted JSON artifact reader;
3. a purpose- and rotation-aware public-key authority for
   `production-composition-manifest`; and
4. a separate purpose- and rotation-aware public-key authority for
   `production-composition-evidence-set`.

Both accepted key-ID sets are explicit, unique, and disjoint, and the two
resolved SPKI fingerprints must differ. Returned public keys have strict data
properties, an exact purpose, key version, validity window, non-revoked state,
and Ed25519 public material. No private-key field, private `KeyObject`, or
generic key purpose is accepted. The verifier snapshots caller inputs before
awaiting external code, verifies the canonical manifest hash and Ed25519
signature, and rejects caller mutation before returning.

The artifact source receives one frozen task-free query bound to the campaign,
manifest, component hash, operational hash, and ordered runtime-port hash. It
must return one strict, current, content-hashed Ed25519 evidence envelope
containing exactly fourteen unique `TrustedCloudArtifactRef` values:

- four component attestations in `control`, `optimizer`, `build`, and
  `evaluator` order;
- one operational attestation containing the exact ordered ten opaque
  bindings, including the dedicated hidden-catalog genesis hash; and
- nine runtime-port attestations in the single exported runtime-port order.

The evidence-envelope signature transitively authenticates every immutable
artifact URI, SHA-256, media type, and byte length. It is verified under the
separate evidence purpose before any artifact is read. Reused URIs or hashes,
missing or extra entries, reordering, an expired envelope, a substituted key,
or a manifest/evidence key-ID overlap fails closed.

Every referenced artifact is bounded independently and in aggregate. The
reader result must reproduce the sealed byte length and SHA-256, decode as
canonical UTF-8 JSON with exactly one final newline, have a valid content hash,
use one exact schema and domain, remain current, and reproduce the campaign and
manifest identity. Component documents reproduce image reference/digest,
source hash, configuration hash, component hash, and the provider-attestation
commitment. The operational document reproduces every binding one-to-one.
Each port document reproduces its role component, source/configuration hashes,
opaque implementation-binding hash, and the full ordered-port hash.

To avoid recursion, a runtime port's manifest commitment is the
domain-separated semantic hash of its fixed port ID, role, component binding,
source/configuration hashes, and opaque implementation-binding hash. The
post-manifest evidence artifact then binds that semantic hash to the final
campaign and manifest. The runtime wrapper must still carry the same digest
and be reference-equal to the actual in-process port.

The returned `ProductionCompositionVerification` is deterministic. Its
`verifierAttestationHash` commits the query, signed evidence envelope, and both
resolved public-key IDs, versions, and SPKI fingerprints. The public receipt
retains only the manifest, component, operational, runtime-port, and verifier
commitments required by the sealed runtime.

### Alternatives

- Trust a structural object whose boundary property says `trusted-cloud`.
- Verify only the manifest signature.
- Treat artifact SHA-256 or `contentHash` as evidence of authority.
- Put a separate signature in every evidence document without signing the
  exact one-to-one reference set.
- Use the manifest-signing key and purpose for provider evidence.
- Let the manifest or environment select a key provider, module, executable,
  artifact reader, or command.
- Make a runtime-port artifact SHA recursively define the manifest containing
  that SHA.
- Accept duplicate references, partial operational bindings, or reordered
  runtime ports.

### Consequences

Manifest authority, provider-evidence authority, immutable transport, semantic
evidence validation, and executable construction are separate fail-closed
steps. A content-addressed but unsigned evidence substitution, wrong-purpose
or revoked key, detached component, incomplete operational bundle, port
look-alike, stale artifact, caller mutation, or reader truncation cannot
produce a production verification receipt.

Deployment must still bind both public-key authorities and the artifact source
to governed cloud services, ensure the evidence signer authorizes an envelope
only after validating real provider/runtime attestations, retain historical
rotation material, define revocation operations, and run the source tests plus
provider substitution/recovery suites in approved cloud CI. No tests,
typecheck, build, or lint were run on the Mac.

### Evidence

- `src/cloud/production-composition-attestation-verifier.ts`
- `src/cloud/trusted-json-reader.ts`
- `src/cloud/index.ts`
- `src/orchestrator/production-runtime.ts`
- `tests/cloud/production-composition-attestation-verifier.test.ts`
- `tests/orchestrator/production-runtime.test.ts`

## ADR-0066 — Assemble evaluator releases from committed immutable artifacts

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §3.3, §6, §8.1, §10.1, §12

### Context

The production evaluator composition exposes a deliberately narrow
`TrustedEvaluationService`: one trusted request produces one signed result
envelope after raw destruction. `ProductionBlindBroker`, however, consumes a
complete `ReleasedEvaluationBundle` containing the signed result, its signed
cache attestation, and an optional atomic set of signed behavioral release,
behavioral evidence, failure cards, and diagnostic brief. Letting the
controller fetch those documents itself would expose artifact locations and
would move signature, lineage, task-safety, and release-atomicity decisions out
of the trusted evaluator boundary.

The existing behavioral lineage was also not constructible. The result content
hash included `derivation.behavioralAggregateHash`, which was the behavioral
release content hash, while the behavioral release content hash included
`sourceResultEnvelopeHash`, which was required to equal the result content
hash. No producer can generally solve that mutual SHA-256 fixed point. Fixtures
using arbitrary hashes hid the cycle rather than proving a valid lineage.

### Decision

Add `ArtifactBackedEvaluationReleaseBundleService` as a provider-neutral
trusted-cloud adapter around `TrustedEvaluationService`. It implements the
blind broker's structural evaluation port but does not implement HTTP, RPC,
filesystem access, or any network transport. Deployment injects three narrow
capabilities:

1. an immutable trusted-cloud artifact source;
2. a bounded verified UTF-8 JSON reader; and
3. a purpose- and rotation-aware signature verifier.

The class structurally satisfies `TrustedAdaptiveEvaluationClient`, so an
in-process trusted-cloud production composition injects it directly into
`ProductionBlindBroker`. `CanonicalEvaluatorClient` is an alternative
remote-facing implementation of that same port, not an additional wrapper
around this service. For a future split-process topology, an authenticated
endpoint will expose this service and the durable
`CanonicalEvaluatorReplayLedger` will sit immediately on the client side,
burning the request before the transport call. In direct composition, the
outer blind-broker durable lease and the wrapped evaluator's durable one-use
ledger already provide the authoritative burns; this service's bounded
in-memory replay record is only a deterministic-output guard and is not a
durable ledger.

This service is strictly a consumer and validator. It does not derive, sign,
publish, or persist the cache attestation, behavioral evidence, failure cards,
diagnostic brief, or signed behavioral release. Its behavioral path assumes a
separate trusted producer has already published all four immutable documents
and that the signed result commits their signed release.

ADR-0071 subsequently made that producer constructible. Pre-outcome policy now
contains only extraction/privacy/scanner configuration. The deriver retains a
task-private preparation inside the evaluator, raw destruction completes, an
atomic producer commits privacy spending plus all four immutable diagnostic
documents, and only then does the result issuer commit the signed release
hash. ADR-0066 remains the consumer/verification decision; ADR-0071 owns the
producer and sequencing decision.

The source accepts an exact domain-separated query containing only
`cache-attestation`, `behavioral-release`, `behavioral-evidence`,
`failure-cards`, or `diagnostic-brief`, the already committed content hash, and
the query hash. The service first verifies the returned signed result, then
resolves only `result.derivation.cacheAttestationHash`. If and only if a
validation result commits a behavioral aggregate, it resolves that release
hash and then only the three hashes committed in the signed release. No
caller-supplied URI, experiment hint, arbitrary key, task identity, panel
identity, or uncommitted discovery lookup participates.

Each reference must be one exact trusted URI, JSON media type, lowercase
SHA-256, and positive bounded byte length. URI and semantic-content-hash reuse
within one assembly fails closed. Declared bytes count against an aggregate
budget before reading. The reader output must reproduce the declared UTF-8
length and byte digest and must be canonical JSON with exactly one trailing
newline. Strict schema validation then rechecks release safety, semantic
invariants, and the top-level content hash.

Result, cache, and behavioral-release signatures are verified under three
distinct purposes. The verifier request binds purpose, content hash, key ID,
signature time, and the complete document. A receipt is accepted only when it
reproduces those fields, supplies a safe historical key version, asserts
verification, and carries the exact domain-separated verifier-attestation
hash. This lets a deployment apply purpose-specific rotation, validity, and
revocation policy without giving this assembly service key material or a key
provider selector.

Correlation is exact: request ID/hash, run mode, stage/payload kind,
experiment number, protocol, raw-destruction disposition, cache hash, release
hash, release/evidence source, artifact hashes, release ID, policy versions,
privacy support, suppression band, evidence/card references, and diagnostic
expiry must agree. Diagnostic documents are all present or all absent. Repair
and shadow cannot emit them. The assembled bundle passes the local-persistence
safety scanner, which rejects raw/task-identifying keys, trusted artifact URIs,
grader material, encoded printable payloads, and other forbidden release
content.

Break the mutual hash cycle with
`resultEnvelopeBehavioralSourceCommitmentHash(result)`. It is a named,
domain-separated canonical commitment over only immutable result identity and
derivation fields. It explicitly excludes result `contentHash`, signature, and
`derivation.behavioralAggregateHash`. The result still commits the complete
signed behavioral release by its content hash; the release and evidence commit
this stable source commitment. Canonical client, production blind broker, and
the new service all enforce the same construction.

This is a backward-incompatible lineage correction. A release or evidence
document that cites a historical/fabricated full result content hash is
rejected even if every document is individually schema-valid and
content-addressed. There is no automatic migration because rewriting any
sealed document would invalidate its content hash and signature. Pre-correction
fixtures are test data, not accepted production evidence.

The service captures dependency methods at construction, snapshots every
request passed across an await boundary, detects dependency mutation of
queries, artifact references, verifier requests, and result inputs, and returns
defensive copies. Concurrent equal requests coalesce in process. Completed
request IDs retain a bounded canonical replay record; an exact replay is
allowed only when the wrapped durable one-use service and immutable artifact
store reproduce byte-identical release content. A changed request hash or
nondeterministic bundle fails closed.

### Alternatives

- Expand `TrustedEvaluationService` to expose raw stores or arbitrary artifact
  lookup.
- Let `ProductionBlindBroker` read artifact URIs itself.
- Return cache and diagnostic objects beside the result without committed
  hashes.
- Accept a partial diagnostic set and let the controller infer missing
  content.
- Verify every signature through one unversioned key lookup.
- Trust JSON object equality without checking canonical transport bytes.
- Keep arbitrary fixture hashes for the impossible cyclic lineage.
- Retry a completed request and accept whichever release is returned last.
- Add provider-specific network transport to the assembly service.

### Consequences

The production blind broker now has a bounded source-level consumer capable of
constructing its exact evaluator bundle from already produced immutable
artifacts without gaining task, grader, raw trajectory, storage, or key
authority. This is not yet a complete diagnostic production path. Detached
cache data, uncommitted lookups, noncanonical/truncated bytes, forged content
hashes or verifier receipts, wrong purpose/version, partial diagnostics,
protocol/experiment drift, task-unsafe content, provider mutation, and
nondeterministic replay fail closed.

ADR-0073 later supplies the immutable artifact registry and connects the
existing verified JSON bridge; the historical purpose-specific signature
authority remains a separate trusted-cloud binding. ADR-0071 supplies the
post-normalization producer sequence. Deployment must now integrate those
pieces, retain rotation material for the accepted verification period, and
compose the service into the production blind-broker port. HTTP/RPC
authentication and transport remain separate future work. The focused tests
were authored but no test, typecheck, build, formatter, or lint command was run
on the Mac; all acceptance execution remains in approved cloud CI.

### Evidence

- `src/evaluator/release-lineage.ts`
- `src/evaluator/release-bundle-service.ts`
- `src/evaluator/canonical-client.ts`
- `src/evaluator/index.ts`
- `src/orchestrator/blind-broker.ts`
- `tests/evaluator/release-bundle-service.test.ts`
- `tests/evaluator/canonical-client.test.ts`
- `tests/orchestrator/blind-broker.test.ts`

## ADR-0068 — Resolve optimizer inputs from signed artifacts and a standalone source bundle

- Date: 2026-07-26
- Status: accepted
- Supersedes: the tar-only trusted Git source snapshot v1 contract
- Superseded by: none
- Related plan: `PLAN.md` §2.1, §4, §7.1, §9, §10.1, §12, §13

### Context

The cloud optimizer must start from the exact active Pi champion without
reading the operator's Mac checkout and without receiving the private GitHub
credential. The trusted Git source snapshot previously published only
`git archive --format=tar`. That tar proves source bytes for evaluator
execution but contains no Git object database or commit graph. The optimizer
cannot reconstruct the original commit, make a real child commit, or emit a
valid candidate Git bundle from it. Treating the tar as a Git source, adding a
second private clone, or giving Claude Code a GitHub credential would violate
the source and credential boundaries.

The production optimizer adapter also needs a concrete way to obtain its
released source-only, diagnostic, and analysis evidence. Trusting an object
because it claims `boundary: "trusted-cloud"`, accepting an arbitrary artifact
lookup, or relying only on a SHA-256 would not establish release authority,
purpose, rotation, revocation, task safety, or correlation with the active
experiment.

### Decision

Make the source snapshot contract backward-incompatible schema v2. The trusted
cloud worker continues to create the uncompressed tar and additionally creates
a standalone Git bundle version 2 from the same independently verified clone
and exact target commit. It temporarily advertises one and only one head:

`refs/heads/df/bundle/000-source-snapshot`

The worker verifies that the bundle exposes exactly that ref at the authorized
commit and passes `git bundle verify`. Archive, bundle, and manifest are
regular, bounded, non-overlapping files in one trusted output directory. They
are hashed before and after publication. The canonical worker manifest binds
both artifacts, source lineage, target ref/commit/tree/lock, bundle method and
fixed bundle ref. The artifact-reading attestor reproduces every field before
signing the source receipt. The receipt and commit-keyed source index also bind
the bundle digest. Tar output remains because evaluator execution consumes a
source archive.

Reserve experiment number zero for this source bundle namespace. Candidate
publication helpers and the cloud worker reject `000-*`; real candidate bundle
refs remain `refs/heads/df/bundle/<positive-experiment-id>`. The fixed ref is a
bundle-internal advertised ref, not a mutable private-origin branch.

Add `ArtifactBackedCloudOptimizerAdapterResolver` as the provider-neutral
implementation of `CloudOptimizerAdapterResolver`. Deployment injects:

1. the trusted commit-keyed source snapshot receipt index;
2. the independently pinned private-Pi `RepositoryRegistration`;
3. one fixed reviewed bootstrap metadata artifact;
4. an exact-query immutable evidence metadata source;
5. a bounded verifying artifact reader; and
6. an independently configured purpose- and rotation-aware public-key
   authority.

For proposals, the resolver accepts only a source receipt whose registration,
private-origin and upstream fingerprints, upstream head/base, baseline,
active-champion commit, ref namespace, tree, and lock agree with the pinned
registration and champion pointers. It verifies the signed schema-v2 receipt
under the source-receipt purpose and returns only `trusted-bundle` source
material. The private URL, credential, and `canonicalPath` never cross the
resolver output.

Experiment `001` must be the baseline champion, have no diagnostic brief, and
receive the one configured reviewed source-only bootstrap archive. Every later
proposal requires exactly one immutable metadata match for a query containing
the complete `DiagnosticBriefReference`: campaign, experiment, diagnostic
hash, release ID, and actionable state. No fuzzy, latest, path-based, or
caller-selected artifact lookup exists.

Analysis uses a distinct query and signature purpose. Its signed metadata must
reproduce campaign and experiment, hypothesis hash and canonical hypothesis
document hash, candidate commit, patch hash and canonical candidate document
hash, nullable repair and validation attestation hashes, and nullable released
evidence hash. A valid artifact detached from any one of those commitments is
rejected.

All three optimizer metadata forms are strict exact-key canonical JSON with
one trailing newline. They commit the released archive's trusted URI,
lowercase SHA-256, exact tar media type and positive bounded byte length,
release-safety attestation hash, issue time, key version, and all-false
task/panel/cell/raw/grader flags. Unknown fields are unrepresentable.
Bootstrap metadata additionally requires an explicit reviewed policy hash.

Signature verification does not rely on the metadata or an environment value
to choose key material. The resolver asks an injected historical public-key
authority for an Ed25519 SPKI key using purpose, key ID, optional exact key
version, signing instant, document hash, authority-set hash, and
verification-key-set hash. It rejects wrong purpose/version, revocation,
invalid half-open validity windows, authority commitment drift, substituted
key material, non-Ed25519 material, and an invalid signature. Source receipts,
bootstrap archives, proposal diagnostics, and analysis evidence use four
separate purposes. Artifact bytes are still independently rechecked against
their exact length and SHA-256; neither a boundary label nor a digest alone
authorizes release.

Dependency methods are captured at construction. Inputs and dependency
requests are canonical snapshots before every await and are compared after
return. Outputs are defensive, deeply frozen JSON copies. Equal in-flight
queries coalesce; exact completed retries return the same frozen mapping. A
released archive SHA-256 becomes owned by its first successful binding and
cannot be replayed under a different proposal or analysis query.

The baseline source receipt must be created and inserted into the governed
commit-keyed source index before experiment `001`. Correctness-gate candidate
snapshots already enter that index after publication and source verification.
This is a deployment prerequisite, not permission to synthesize a receipt or
read `../pi`.

### Alternatives

- Reconstruct Git history from the tar archive.
- Give Claude Code a private GitHub credential or clone URL.
- Read or bundle the Mac checkout.
- Add a new unverified `trusted-archive` optimizer source mode.
- Advertise the real mutable branch inside the portable source bundle.
- Reuse experiment `000` as an ordinary candidate publication.
- Accept schema-v1 tar-only receipts and infer the missing bundle.
- Return the latest diagnostic or analysis artifact by path or timestamp.
- Put a public key in signed metadata or select it from the environment.
- Trust structural boundary labels, content hashes, or task-safety booleans
  without signature and exact correlation.
- Allow a released evidence archive to satisfy multiple distinct queries.

### Consequences

The optimizer can create real descendant commits entirely in a cloud sandbox
from a credential-free, signed, active-champion-bound Git source. The
evaluator retains its existing tar input. Registration/source substitution,
wrong champion lineage, ref collision, tar-only downgrade, bundle
substitution, ambiguous evidence lookup, task-shaped metadata, wrong
diagnostic tuple, detached analysis, key substitution/revocation/purpose
confusion, asynchronous mutation, and cross-query archive replay fail closed.

Schema-v1 source receipts and source-index receipts are not accepted. There is
no automatic migration because adding a bundle changes the worker manifest,
artifact commitments, receipt hash, signature, and index identity. The trusted
cloud must recreate and attest the snapshot.

Production still must provision the baseline snapshot/index entry, immutable
metadata registry, verified artifact bridge, reviewed bootstrap artifact, and
historical purpose-specific public-key authority, then compose the resolver
into the optimizer adapter. It must execute the focused unit, source-worker,
attestor, resolver, mutation, replay, key-rotation/revocation, and live
provider suites in approved cloud CI. No test, typecheck, build, formatter,
lint, Node, or package-manager command was run on the Mac.

### Evidence

- `scripts/trusted-git-worker.mjs`
- `src/harness/git-source.ts`
- `src/harness/git-operation-attestors.ts`
- `src/harness/git-publication.ts`
- `src/orchestrator/correctness-gate.ts`
- `src/cloud/mounted-volume-correctness-gate-ports.ts`
- `src/orchestrator/trusted-port-adapters.ts`
- `src/optimizer/artifact-backed-resolver.ts`
- `src/optimizer/cloud-session.ts`
- `src/optimizer/index.ts`
- `tests/harness/trusted-cloud-git.test.ts`
- `tests/harness/trusted-git-worker.test.ts`
- `tests/orchestrator/correctness-gate.test.ts`
- `tests/cloud/mounted-volume-correctness-gate-ports.test.ts`
- `tests/orchestrator/trusted-port-adapters.test.ts`
- `tests/optimizer/artifact-backed-resolver.test.ts`

## ADR-0069 — Recover bootstrap through a signed strict-prefix journal

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §2.3, §5.1, §10.1, §12

### Context

ADR-0063 gave one production optimize invocation a lifecycle owner and defined
an injected bootstrap-or-reconstruct port. A boundary literal and an
idempotency hash were not enough to make that port trustworthy. Production
still had to prove that the source prerequisite was the exact signed private
Pi registration, that campaign and hidden-catalog genesis were separately
authorized, and that an interrupted initialization could converge without
pretending two independent domain stores support one physical transaction.

The existing signed `TrustedGitRegistrationReceipt` already contains every
required source identity: deterministic registration ID, private-origin
repository hash and provider attestation, branch, commit, tree, npm lock hash,
Pi coding-agent package name/version, upstream lineage, adapter policy,
sandbox/image/network identity, and Ed25519 signature. Reading or hashing the
sibling Mac checkout would both duplicate this authority and violate the
cloud-only execution boundary.

Campaign state and the hidden catalog have distinct confidentiality and
durability properties. The hidden catalog must commit to its dataset and
selection inputs while exposing no task names or hidden identifiers to the
control/optimizer path. A crash can occur after either domain store commits
but before the coordination journal advances. Calling that condition
"atomic" would be false and would hide the recovery work.

### Decision

Implement `DurableProductionOptimizeBootstrapOrReconstructPort` as the
provider-neutral concrete production port.

The port accepts only captured in-process methods for:

1. an immutable prerequisite source;
2. a public-only prerequisite key authority;
3. a campaign genesis authority; and
4. a hidden-catalog genesis authority.

It first makes a canonical private snapshot of the exact owner request and
recomputes its request hash. Source, campaign, and catalog queries are frozen,
task-free values; dependency mutation across every asynchronous boundary
fails closed.

The source prerequisite is the existing signed private-Pi registration
receipt. `sourcePrerequisiteHash` is its established unsigned identity hash,
`gitRegistrationReceiptHash`: key rotation can re-sign the same immutable
registration without changing its source identity, while the receipt's
Ed25519 signature is still mandatory. Strict validation binds the
registration ID to private-origin hash, commit and upstream base, and also
checks the exact tree, dependency lock, Pi package version, adapter lockdown,
private/fetch/write attestations, provider execution identity, and all
content hashes. No local repository path or remote credential is accepted.

Campaign genesis is a separately signed release-safe document bound to
campaign, lineage, protocol, source prerequisite, initial campaign-state hash,
and genesis-policy hash. Hidden-catalog genesis is a separately signed trusted
task-free commitment bound to campaign, lineage, protocol, campaign-genesis
prerequisite, Terminal-Bench dataset pin, registry revision, seed-set
commitment, weighting-policy hash, task-ID/disposition key IDs, and initial
catalog-state hash. Its schema has four explicit false information-boundary
flags and no task name, hidden task ID, task order, panel, cell, or grader
field; exact-key validation rejects additions even if an attacker re-signs
them.

The three documents use disjoint purposes:

- `production-optimize-private-pi-registration`;
- `production-optimize-campaign-genesis`; and
- `production-optimize-hidden-catalog-genesis`.

Construction requires an explicit bounded rotation schedule. Key IDs cannot
cross purposes and windows for one purpose/key cannot overlap. Resolution
includes purpose, key ID, key version, and signed time. The returned authority
record must reproduce those values and the exact validity window, be
non-revoked, and contain only public Ed25519 SPKI DER. The three canonical SPKI
fingerprints must also differ. Wrong-purpose, revoked, substituted, private,
future, expired, or detached material fails closed.

After prerequisite verification, the port registers its fenced
`MountedVolumeTransactionalJsonStore` with the owner's lifecycle registrar
before the first transaction. That store contains exactly one bounded request
identity and one strict-prefix record:

```text
claimed -> campaign-ensured -> catalog-ensured -> committed
```

The port then calls the campaign and catalog authorities in that order. Each
authority must create or exactly reconstruct its own domain state and return
the expected signed initial-state hash plus an acquired closeable resource.
The resource is registered synchronously with the owner before another
asynchronous operation. A malformed result is rejected only after its
available resource has been registered, so owner cleanup still drains it.

Replay re-verifies every prerequisite and reopens both authorities. Recorded
state hashes must reproduce exactly. A phase at or beyond campaign ensure may
not recreate campaign state; a phase at or beyond catalog ensure may not
recreate catalog state. A newly created campaign paired with an already
existing catalog is impossible and fails closed. These rules distinguish a
recoverable strict prefix from loss, rollback, or cross-store corruption.

Only a fresh claim that creates both states and observes no replay returns
`bootstrapped`. A persisted partial recovery, exact retry, or pre-existing
exact state returns `reconstructed`. The first committed receipt is durable;
subsequent retries derive one byte-stable reconstructed receipt from the same
state hashes and original verification time. A different request can never
reuse the journal. One process instance admits only one in-flight call; the
mounted-volume coordinator provides the durable cross-process writer fence.

This protocol does not claim cross-store physical atomicity. The journal is a
write-ahead recovery witness, while campaign and catalog authorities remain
responsible for their own linearizable create-or-exact-reconstruct operations.
An impossible combination requires operator investigation rather than
automatic repair.

### Alternatives

- Inspect or build the sibling `../pi` checkout during bootstrap.
- Trust an unsigned harness registration or only a commit SHA.
- Use one generic or environment-selected verification key for all
  prerequisites.
- Put task names, hidden IDs, or the imported task order in the catalog
  commitment.
- Initialize campaign and catalog state without checking their exact resulting
  hashes.
- Call two domain writes "atomic" because an idempotency key exists.
- Store several competing request identities and let the most recent win.
- Recreate missing state after a journal phase proves it previously existed.
- Acquire stores without immediately registering their close methods.

### Consequences

Production now has a concrete, task-blind path from the three opaque manifest
bindings to exact campaign and hidden-catalog genesis state. A substituted Pi
fork, changed commit/tree/lock/package version, forged private-origin claim,
wrong campaign lineage, detached dataset/weighting commitment, task-bearing
catalog extension, invalid key rotation, request replay with changed content,
state rollback, impossible cross-store prefix, dependency mutation, or
resource-registration failure cannot produce an accepted receipt.

Deployment must still provide immutable prerequisite registries, governed
public-key authorities and rotation/revocation operations, and concrete
campaign/catalog genesis authorities backed by the reviewed cloud volume.
The mounted-volume semantics canary, abrupt provider termination at every
phase, concurrent-controller handoff, key rotation, and cleanup suites must run
in approved cloud CI. The focused source tests were authored but no test,
typecheck, build, formatter, or lint command was run on the Mac.

### Evidence

- `src/cloud/production-optimize-bootstrap-or-reconstruct.ts`
- `src/cloud/production-optimize-composition-owner.ts`
- `src/cloud/mounted-volume-state.ts`
- `src/harness/git-registration.ts`
- `src/cloud/index.ts`
- `tests/cloud/production-optimize-bootstrap-or-reconstruct.test.ts`

## ADR-0071 — Finalize behavioral releases after normalization and raw destruction

- Date: 2026-07-26
- Status: accepted
- Supersedes: the producer-sequencing assumption in ADR-0066
- Superseded by: ADR-0079 for private preparation durability and recovery
- Related plan: `PLAN.md` §3.3, §6.5, §8.1, §9.3, §12

### Context

The evaluator's original behavioral binding asked pre-outcome policy material
to contain a release `contentHash`, behavior `sourceSetHash`, and observed
privacy result. The resolver also correctly required that policy to be sealed
before the earliest outcome-bearing execution. The deriver could compute the
behavior source set only after decoding Harbor outcomes and ATIF. The signed
behavioral release, evidence, failure cards, and diagnostic brief necessarily
depend on those normalized observations. Therefore no honest production
provider could create the policy input without predicting the run.

ADR-0066 removed the separate mutual content-hash cycle between result and
behavioral release with a domain-separated unsigned-result source commitment,
but it intentionally implemented only the consumer. A production producer
still needed to preserve four invariants simultaneously:

1. task IDs and observations exist only inside the trusted evaluator;
2. raw material is destroyed before any diagnostic document becomes visible;
3. privacy/differencing spending and all diagnostic artifacts commit
   atomically and cannot be refunded; and
4. the final result commits the release even though the release commits its
   source result.

An additional failure window exists after artifact commit but before result
signing or durable one-use completion. Reusing that complete bundle for a
different request would turn an ordinary issuer failure into a lineage and
privacy vulnerability.

### Decision

Replace outcome-derived behavioral policy fields with
`TrustedBehavioralExtractionPolicy`. Its signed binding contains exactly
predeclared configuration: diagnostic enablement, the
`candidate-vs-champion` comparison, maximum privacy releases, diagnostic TTL,
and the complete protocol/broker/extraction/statistics/privacy/weighting/cache/
repeated-testing/leak-scanner version set. Its hash domain is
`dark-factory.behavioral-policy-binding.v2`. Exact-key validation rejects a
release hash, source-set hash, support count, privacy result, or diagnostic
status even if an attacker recomputes the outer policy attestation.

`DeterministicCanonicalEvaluationDeriver` now always returns a persistence-safe
aggregate with a null behavioral hash and false privacy result. During the same
trusted decode it constructs, for eligible validation only, one
`TrustedPrivateBehavioralPreparation` containing task-clustered behavior
summaries, pass/fail group membership, analysis window, behavior source-set
hash, policy, and scanner commitments. This object lives only in a private
in-memory map. `take(requestHash)` is destructive and `discard(requestHash)`
clears failure paths. Repair and shadow never create a preparation.

`TrustedEvaluationBroker` enforces this order:

```text
one-use claim and hidden panel burn
  -> Harbor execution
  -> normalize + retain private preparation
  -> verify raw destruction receipt
  -> destructively take preparation
  -> privacy/artifact finalization
  -> attach release content hash
  -> sign and verify result
  -> complete one-use ledger
```

The broker computes `hashResultEnvelopeBehavioralSourceMaterial` from the exact
unsigned fields the eventual result will contain: deterministic envelope
identity, experiment, mode, protocol, one-use request and disposition,
normalized-outcome set, cache attestation, confirmed destroyed-retention
record, and derivation time. It deliberately excludes result content hash,
signature, and behavioral hash. After signing,
`resultEnvelopeBehavioralSourceCommitmentHash(result)` must reproduce the same
value. The behavioral release may be signed before the final result; consumers
require its creation time not to follow the result and verify its exact source
commitment.

`DeterministicPostDestructionBehavioralReleaseProducer` accepts only an exact
twelve-task, twenty-four-observation matched validation preparation and a
verified destruction receipt later than its analysis window. It runs the
existing minimum-support, task-clustering, duplicate-experiment,
release-budget, and task-disjoint differencing firewall. A suppressed decision
returns no artifact and spends no release. An eligible decision, including a
privacy-qualified no-actionable-card result, spends one release.

The producer deterministically creates schema-valid
`BehavioralEvidence`, `FailureCards`, and `DiagnosticBrief` documents using
only allowlisted features, coarse support bands, aggregate effects and
uncertainty, generic component names, generic recommendations, limitations,
and expiry. It applies literal, fingerprint, canary, schema, content-hash, and
local-persistence scans. It signs `SignedBehavioralRelease` with a distinct
`behavioral-release` Ed25519 key purpose and verifies the signature before
persistence.

`TrustedBehavioralPrivacyArtifactStore` is the single CAS transaction
authority. It receives the prior hidden privacy-state hash, next state, exact
request, unsigned-result source, release content hash, authorization, and all
four artifacts. One transaction either persists the nonrefundable ledger
transition plus the complete immutable set or exposes none of it. Request,
source-result, authorization, and release hashes are one-use. Its only
artifact read operation is purpose plus content hash; it has no enumeration,
path, experiment-hint, or latest-artifact API.

If result issuance or result verification fails before a durable one-use
completion, the broker calls `orphan`. Orphaning does not delete artifacts or
refund privacy. It permanently denies content-hash resolution and rebind of
that authorization/release. A failure returned by `complete` is different
because its transaction may have committed before its acknowledgement was
lost. The broker first performs a read-only ledger inspection. It returns an
exact valid completed envelope, or orphans only when the ledger proves the
record is still in-flight or consumed. If inspection itself fails or reports a
contradiction, the broker neither orphans nor records a failure; the one-use
bundle remains nonrefundable and non-rebindable for protected recovery. A
successful result exposes only the release content hash; the evaluator-only
authorization handle never crosses the boundary.

The production evaluator composition requires a trusted-cloud atomic
privacy/artifact store and separate behavioral-release private/public key
providers. Test-only boundaries are rejected. The concrete durable cloud store
and protected crash/concurrency acceptance run remain deployment tasks.

The release-safe `ValidationAggregate` now carries
`behavioralSourceCommitmentHash` beside the diagnostic brief hash. Both must be
present or absent together. The experiment journal compares
`behavioral-evidence.json.sourceEnvelopeHash` with this commitment, not the
legacy full result content hash.

### Alternatives

- Predict post-run release and source hashes in presealed policy.
- Seal the policy after observing outcomes and retain a misleading timestamp.
- Put task IDs or observations in the result aggregate for a later controller
  to sanitize.
- Publish artifacts before raw destruction.
- Spend privacy separately from artifact writes and compensate on failure.
- Sign the result first, then mutate it to add a behavioral hash.
- Cite the full result content hash and search for a SHA-256 fixed point.
- Allow repair or shadow diagnostics.
- Leave an issuer-failure bundle discoverable by latest path or reusable under
  another request.
- Share result-envelope and behavioral-release signing purposes.

### Consequences

Pre-outcome policy is now honestly constructible and cannot be conditioned on
observed support or outcomes. The only task-bearing object remains private to
the trusted evaluator and is destructively handed off after raw destruction.
Every released document is task-free, content-addressed, source-bound,
purpose-signed, privacy-qualified, and all-or-none. A transaction failure
releases no prefix. An issuer failure consumes privacy but creates only a
permanently unresolvable orphan, preserving nonrefundability without allowing
replay or rebind.

Production must still implement the store port on a fenced cloud volume or
equivalent transactional service, bridge its content-hash-only reader to the
ADR-0066 bundle service, provision historical purpose-specific verification
keys, and run crash-at-every-boundary, concurrent CAS, lost-response,
orphan-resolution, key-rotation/revocation, and provider durability tests in
approved cloud CI. No Node, package-manager, test, typecheck, build, lint, or
formatter command was run on the Mac.

### Evidence

- `src/evaluator/policy-resolver.ts`
- `src/evaluator/deriver.ts`
- `src/evaluator/behavioral-release-producer.ts`
- `src/evaluator/release-lineage.ts`
- `src/evaluator/release-bundle-service.ts`
- `src/evaluator/composition.ts`
- `src/broker/service.ts`
- `src/orchestrator/contracts.ts`
- `src/orchestrator/blind-broker.ts`
- `src/orchestrator/experiment-journal.ts`
- `tests/evaluator/policy-resolver.test.ts`
- `tests/evaluator/deriver.test.ts`
- `tests/evaluator/behavioral-release-producer.test.ts`
- `tests/broker/trusted-broker.test.ts`

## ADR-0072 — Statically assemble the exact nine production runtime ports

- Date: 2026-07-26
- Status: accepted
- Supersedes: the remaining runtime-factory placeholder in ADR-0063
- Superseded by: none
- Related plan: `PLAN.md` §2.3, §5.1, §10.1, §12

### Context

ADR-0063 made a trusted in-process runtime factory the only authority allowed
to turn an independently verified composition into executable ports. The
owner and production runtime correctly rejected JSON/environment-selected
implementations and required nine reference-equal wrappers, but there was no
production implementation of the factory. Tests could inject a fabricated
assembly. Consequently the paid control path had no concrete, reviewable join
between the durable stores, Claude optimizer, correctness gate, blind broker,
and evaluator release service.

The join has two independent trust problems. First, a valid manifest and
composition-verifier receipt do not by themselves prove that the factory was
built for the same four components and port attestations. Second, an injected
dependency object can be mutated after factory construction, and a constructor
can fail after acquiring only a prefix of mounted writer resources. A
production implementation must solve both without turning its attestation
document into an executable registry or exposing a task-bearing field.

### Decision

Implement `ProductionTrustedCloudRuntimeFactory` as the concrete one-shot
`TrustedProductionOptimizeRuntimeFactory`.

The executable graph is a fixed set of static imports. The factory constructs:

1. `CampaignStateStore`;
2. `MountedVolumeOptimizationCoordinationPorts`;
3. `ProductionOptimizationCompletionMaterial`;
4. `MountedVolumeAtomicExperimentJournalStateStore`, `ExperimentStore`,
   `MountedVolumeReleaseSafeExperimentArtifactAssembler`,
   `MountedVolumeTrustedExperimentSealAuthority`,
   `MountedVolumeTrustedJournalInterruptionAttestor`, and
   `ProductionExperimentJournal`;
5. `MountedVolumeCloudOptimizerSessionRecordStore`,
   `ArtifactBackedCloudOptimizerAdapterResolver`,
   `CloudOnlyClaudeOptimizerSession`, and the cloud-only adapter;
6. `MountedVolumeCorrectnessGateRecordStore`,
   `MountedVolumeTrustedCandidateSourceIndex`, and
   `ProductionCorrectnessGateRunner`; and
7. `MountedVolumeAtomicBlindBrokerLeaseStore`,
   `MountedVolumeTrustedDiagnosticBriefPublisher`, the strict configuration,
   source, and repair resolvers,
   `ArtifactBackedEvaluationReleaseBundleService`, and
   `ProductionBlindBroker`.

There is no dynamic import, module path, generic constructor callback,
executable registry, local adapter, or fallback implementation. The manifest,
bootstrap descriptor, environment, and artifact metadata cannot choose a
constructor, module, command, key, model, task, or port. Provider, model,
command, secret-reference, public-key, and authority choices arrive only as
explicit reviewed in-process constructor dependencies. They are not read from
JSON or the environment by this factory.

The factory additionally requires
`ProductionRuntimeFactoryDependencyAttestation`. This strict task-free
document commits the final manifest hash, the canonical manifest hash of each
role component, the complete operational-binding hash, the sole ordered list
of nine port IDs and attestation digests, and its domain-separated aggregate
hash. Its self-hash covers all fields. It has
`containsTaskIdentifiers: false` and no extension field. At creation the
factory checks it independently against the canonical manifest and the
composition-verifier receipt. A separately injected
`TrustedProductionRuntimeFactoryDependencyAttestationAuthority` must
authenticate the exact document and return a strict verification bound to the
composition verifier's attestation hash before any store is acquired. The
bootstrap receipt must reproduce the exact source, campaign-genesis, and
catalog-genesis bindings and canonical request hash. The plugin artifact,
optimizer image, provider readiness, volume semantics, and
correctness/broker/evaluator/journal policies must reproduce their manifest
bindings.

Constructor options are strict plain records. The factory canonical-snapshots
all data and binds every external method at its own construction boundary.
The runtime input is canonical-snapshotted before the first lifecycle callback.
Changing a caller's provider method, authority method, artifact reference,
model configuration, dependency attestation, manifest, verification, or
bootstrap receipt later cannot change the assembly.

The trusted runtime guard and mounted-volume semantics guard run before store
construction. Every acquired store is immediately registered through a unique
fixed lifecycle ID. Stores without a persistent close handle receive a
retirement wrapper; fenced stores capture their real `close` method. Each
wrapper is idempotent and returns one close promise. If registration or a later
constructor fails, the factory closes the acquired prefix in reverse order.
The owner can later drain the same wrappers without double-closing the backing
resource.

The actual nine runtime ports are new frozen objects whose methods are already
bound to the concrete implementations. The four role components are frozen.
Each frozen port binding carries the corresponding manifest attestation
digest, occurs in the sole exported order, and names the exact same object
reference stored in its role component. A detached wrapper, reordered digest,
wrong component hash, caller mutation, second factory use, duplicate lifecycle
ID, or extra task-bearing factory field fails closed with one non-sensitive
error.

External authorities remain mandatory instead of being replaced by
placeholders. Deployment must supply campaign transition/decision/control
verifiers; coordination, completion-accounting, and interruption authorities;
journal policy/provenance/task-exclusion/leak-scan authorities; a cloud sandbox
provider plus optimizer artifacts and resolver registries; correctness
scan/build/publication/snapshot and receipt authorities; evaluator service,
release artifact registry/reader, purpose-specific release verification, and
broker configuration/source keyrings; plus provider-attested runtime,
mounted-volume, and recovery authorities.

### Alternatives

- Keep the factory interface and assemble fake ports in the control command.
- Select constructors or modules from the signed composition JSON.
- Let environment variables select a model, command, key, or implementation.
- Trust the manifest port digest without an independent factory dependency
  attestation.
- Return the concrete classes while a detached wrapper carries the digest.
- Retain caller-owned methods and data until the runtime eventually invokes
  them.
- Register resources only after the entire graph constructs successfully.
- Close a failed prefix directly and let the owner close the raw resources a
  second time.
- Add task IDs to the factory attestation so the factory can check evaluator
  membership.

### Consequences

The production composition owner now has a real, provider-neutral assembly
authority for all nine runtime ports. The factory reuses the reviewed durable
implementations, preserves a task-blind public surface, shares the exact
commit-keyed source index between optimizer/correctness/broker paths, and
provides deterministic ownership and cleanup semantics.

This does not provision the external authorities or make `optimize` runnable
by itself. Production wiring still needs the independently generated factory
dependency attestation and its provider/KMS verification authority, real
public-key authorities, immutable artifact registries/readers, provider
execution ports, policy commitments, cloud runtime guard, mounted-volume
semantics and recovery authorities, and the exact operator-selected
model/image/secret references. The focused tests are authored but must run,
together with typecheck, lint, real mounted-volume handoff,
partial-construction crash injection, and end-to-end owner execution, only in
approved cloud CI. No Node, package-manager, test, typecheck, build, lint, or
formatter command was run on the Mac.

### Evidence

- `src/cloud/production-optimize-runtime-factory.ts`
- `src/cloud/production-optimize-composition-owner.ts`
- `src/orchestrator/production-runtime.ts`
- `src/cloud/mounted-volume-optimization-coordination.ts`
- `src/cloud/mounted-volume-experiment-journal.ts`
- `src/cloud/mounted-volume-experiment-journal-authorities.ts`
- `src/cloud/mounted-volume-correctness-gate-ports.ts`
- `src/cloud/mounted-volume-blind-broker-ports.ts`
- `src/optimizer/cloud-session.ts`
- `src/optimizer/artifact-backed-resolver.ts`
- `src/evaluator/release-bundle-service.ts`
- `tests/cloud/production-optimize-runtime-factory.test.ts`

## ADR-0073 — Use a fenced exact-query registry for trusted JSON artifacts

- Date: 2026-07-26
- Status: accepted
- Supersedes: the unresolved generic artifact-registry deployment gap
- Superseded by: none
- Related plan: `PLAN.md` §2.1, §6, §7.1, §10.1, §12, §13

### Context

The evaluator release assembler, optimizer resolver, production-composition
verifier, campaign verifier, and production bootstrap port already consumed
typed immutable artifacts, but their provider registry sources were abstract.
The mounted-volume object backend verified bytes and the transactional JSON
store fenced mutable state, yet using either alone was insufficient. A blob
without an authoritative exact-query index is discoverable only by arbitrary
URI or filesystem inspection; an index entry written before its blob is
durable can expose a partial publication. A permissive shared registry could
also let one purpose rebind another purpose's document or turn storage into a
task-discovery interface.

Behavioral releases add a stricter requirement: evidence, cards, brief, and
the signed release must not become visible as a prefix. Optimizer metadata
must resolve to zero or one exact artifact, never an order-dependent list.
Campaign and bootstrap reconstruction must use the same exact content
commitments that their verifiers expect. None of these storage concerns
authorizes the registry to select verification keys or inspect hidden tasks.

### Decision

Implement `MountedVolumeTrustedArtifactRegistry` as a cloud-only composition of
`VerifyingTrustedArtifactBridge`,
`VerifyingTrustedJsonArtifactReader`, and
`MountedVolumeTransactionalJsonStore`.

Each supported publication has a closed namespace/purpose pair and a
domain-separated exact-query hash. The canonical JSON document, including one
trailing newline, is written first to a deterministic URI containing the
namespace, purpose, and byte SHA-256. The returned URI, digest, media type, and
length must exactly reproduce the planned reference. Only after every object
in a batch is durable does one fenced index transaction publish all bindings.
An interruption before that transaction may leave an unreachable object, but
no typed source can observe it.

The index stores strict content-hashed entries plus a reverse object-owner map.
It validates every key and inverse mapping on every load. Exact replay returns
the original immutable reference. A changed semantic document under an
existing locator, a reused object under another locator, a mixed partially
existing batch, a purpose swap, or any URI/hash/length mismatch fails closed.
Behavioral artifacts may be published only as the complete four-document set,
optionally in the same batch as the cache attestation; the signed release must
bind the other three content hashes.

Expose only typed adapters:

- evaluator release artifacts by canonical release query;
- optimizer proposal/analysis metadata by canonical query, plus one exact
  source-only-bootstrap metadata lookup;
- the signed production-composition attestation artifact set;
- signed campaign transition, decision, or control evidence; and
- the private-Pi registration, campaign genesis, and task-free hidden-catalog
  genesis prerequisites.

The shared reader remains a bounded verified JSON capability. There is no list,
enumeration, prefix, arbitrary-URI, local-file, or filesystem-fallback method.
Inputs are canonical-snapshotted before asynchronous storage access and checked
again before visibility, so caller mutation can at most create an unreachable
object. Registry state uses the existing non-expiring controller lock,
provider-destruction recovery proof, fencing, and clean handoff. The registry
exposes a closeable lifecycle resource and optionally registers it at
construction.

Publication performs schema validation for evaluator release documents,
requires explicit task/panel/cell/raw/grader safety flags for optimizer
metadata and catalog commitments, rejects sensitive identity/raw keys across
all supported documents, and binds each typed document back to its exact
query. Raw Harbor, ATIF, grader, per-task, panel, cell, and trajectory material
is not a supported namespace or purpose.

Key resolution remains deliberately outside this registry. Deployment must
inject the existing purpose-specific, rotation-aware KMS/public-key
authorities. Storage cannot nominate a key, collapse authority separation, or
gain private signing material.

### Alternatives

- Let each consumer derive a trusted URI and open it directly.
- Rebuild visibility by scanning object directories after a crash.
- Store a mutable purpose-to-latest pointer.
- Publish each behavioral artifact independently.
- Return all matching optimizer metadata and choose the first item.
- Use the local experiment directory or Mac filesystem as a fallback.
- Put public-key selection or KMS signing behind the artifact registry.
- Treat a matching semantic content hash as sufficient without checking exact
  bytes, length, media type, and URI.

### Consequences

All five previously abstract artifact-source families now have one durable,
provider-neutral implementation with atomic visibility and clean lifecycle
ownership. A consumer can prove that its exact typed query reached the exact
canonical bytes, while neither the optimizer nor local control plane gains a
task-discovery surface. Crash recovery cannot make orphaned blobs visible, and
concurrent/replayed publication cannot silently replace an existing binding.

The registry does not make the full deployment runnable by itself. Production
still needs provider-volume canary acceptance, recovery authority, KMS/public
key authorities, signed publication producers, and runtime-factory wiring.
The adversarial test source covers collision/rebind rejection, partial batch
failure, exact replay, purpose swaps, mutation across await, URI/hash/length
and stored-byte mutation, the absence of enumeration, exact typed resolution,
lookup ambiguity prevention, clean handoff, and provider-attested unclean
recovery. These tests and the full typecheck/lint/build suite must run only in
approved cloud CI; no Node or package-manager command was run on the Mac.

### Evidence

- `src/cloud/mounted-volume-artifact-registry.ts`
- `src/cloud/artifact-bridge.ts`
- `src/cloud/trusted-json-reader.ts`
- `src/cloud/mounted-volume-state.ts`
- `tests/cloud/mounted-volume-artifact-registry.test.ts`

## ADR-0074 — Load hidden catalog genesis once from exact pinned material

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §7, §13

### Context

The broker already had strict 89-task seed validation and deterministic
failure-weighted selection, but deployment still needed a production-shaped
way to obtain the initial inventory and optional historical observations. A
generic JSON argument, mutable registry alias, or retryable source would let an
operator substitute a different task universe or probe alternative priors.
Returning the loaded structure to the controller would also reveal task names
before the optimizer's first hypothesis.

### Decision

Use `TrustedTerminalBenchCatalogGenesisLoader` only inside the trusted
evaluator/broker process. It accepts exactly one source capability with the
`trusted-cloud-terminal-bench-catalog-material-source` boundary and captures
its two methods during construction. Its inventory request commits to the
exact Terminal-Bench pin hash, dataset-content digest, dataset-manifest digest,
registry revision 6, and cardinality 89. Optional initial-Pi and comparable
public-leaderboard observation requests additionally commit to source kind,
immutable source commitment, inventory hash, pin hash, maximum row count, and
their own canonical query hash.

The loader is one-use. It marks itself consumed before its first asynchronous
source operation, so success, source failure, malformed material, or detached
observations cannot be followed by a second attempt against alternate bytes.
Every source result is canonical-snapshotted before validation. Existing
catalog-import validation then enforces exact shapes, hashes, task revisions,
uniqueness, finite values, and source kind. The hidden result remains typed as
trusted catalog genesis material and contains the 89 private seeds.

The paired release-safe receipt contains only the benchmark label, pin and
inventory commitments, optional observation-set commitments, seed-set
commitment, fixed cardinality, and explicit false flags for task names,
identifiers, and observation rows. It has no task list, stable task handle,
capability membership, difficulty label, weight, or grader evidence.

Back the source with
`MountedVolumeTrustedCatalogMaterialRegistry`, a dedicated private sidecar to
the task-free artifact registry. The sidecar accepts one bounded canonical JSON
line containing the exact pin, inventory, and optional observation sets. It
revalidates the content and manifest digests, revision 6, cardinality 89,
unique package-name and revision-digest pairs, all document hashes, and every
observation-to-inventory join before any index commit. Each document is stored
under a content-addressed trusted URI; the mounted-volume index becomes visible
only after every requested object is complete. A failed or racing publication
can leave unreachable objects but cannot create a partial index. Exact
republishing is idempotent, while any replacement is rejected permanently.

Do not weaken `MountedVolumeTrustedArtifactRegistry` to hold these bytes. That
registry is intentionally task-free and safe to mirror; the catalog sidecar is
trusted-hidden and stays in the evaluator/broker zone. Its injected source
capability has exactly `boundary`, `loadInventory`, and `loadObservations`.
There is no list, prefix, mutable alias, generic locator, raw reader, artifact
reference, or release method. Its publication receipt contains hashes and
explicit negative disclosure flags but no storage locations or rows.

`TrustedCatalogMaterialNormalizerSpec` gives a Harbor-side cloud worker a
sealed generic contract: exact pin/content/manifest hashes, revision 6,
expected count 89, bounded canonical JSON-line output, no mutable alias, and
no task-row egress. The TypeScript registry does not resolve a remote
`latest`; live deployment must supply a normalized artifact produced from the
already verified immutable revision inside the trusted evaluator. The
`normalizeAndPublishOnce` capability burns its in-process worker attempt before
awaiting the provider-specific normalizer, passes a frozen spec, and rejects
same-process replay after worker failure; task-bearing output returns directly
into the registry process rather than through a controller or optimizer
artifact. A provider-attested crash-recovery policy must decide whether a
pre-publication controller failure is terminal or may recreate the producer;
the source code does not silently infer that authority.

### Alternatives

- Pass task names and priors to the control plane in environment JSON.
- Let the optimizer query Harbor or the dataset registry.
- Resolve a mutable `latest` dataset or leaderboard alias.
- Retry failed genesis with another source response.
- Release the imported seed array because the benchmark is public.
- Initialize all estimates from one permanently fixed hard subset.

### Consequences

The broker can use neutral priors, progressively learned Pi-baseline outcomes,
or an explicitly committed comparable public baseline without changing its
hidden task universe or revealing the chosen rows. The immutable private
artifact publication and exact typed source are implemented; a live cloud run
must still resolve the pinned Harbor revision, generate the first normalized
bundle, and record the resulting acceptance commitments. The loader and source
never fetch a mutable remote and grant no enumeration surface. Static tests
cover exact query commitments, task-free release, source mutation after
construction, one-use replay, detached observations, registry-revision drift,
pin substitution, noncanonical input, duplicate names/revisions, immutable
republishing, absent observations, and capability-surface minimization. They
must execute only in approved cloud CI.

### Evidence

- `src/broker/catalog-genesis-loader.ts`
- `src/broker/catalog-import.ts`
- `src/cloud/mounted-volume-catalog-material-source.ts`
- `tests/broker/catalog-genesis-loader.test.ts`
- `tests/broker/catalog-import.test.ts`
- `tests/cloud/mounted-volume-catalog-material-source.test.ts`

## ADR-0075 — Commit behavioral privacy spend and artifacts at one boundary

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §3.3, §8.1

### Context

The post-destruction producer needs to debit its hidden adaptive-release
privacy budget and make exactly four task-free documents available: behavioral
evidence, failure cards, a one-use diagnostic brief, and the signed behavioral
release that binds the other three. Treating the ledger and documents as
separate stores would create an unsafe interval in either order. Publishing
documents first can expose a bundle whose privacy debit never commits;
spending first can leave a retry to create a visible prefix or double-spend.
Publishing four independent registry entries also makes partial visibility
possible.

The result issuer can fail after this transaction succeeds. Refunding or
deleting the bundle would reopen adaptive differencing budget, while leaving a
failed result's release readable would permit an unreferenced diagnostic to be
reused. A controller crash can also make the caller uncertain whether the
transaction crossed its commit point.

### Decision

Implement `MountedVolumeBehavioralPrivacyArtifactStore` over one
`MountedVolumeTransactionalJsonStore`. The single content-hashed state envelope
contains the full append-only hidden privacy ledger, all four immutable
documents for every successful release, the authorization order, permanent
orphan markers, and complete reverse owner indexes. The provider-attested,
same-volume state-envelope rename is the only publication point. This store
therefore does not call `MountedVolumeTrustedArtifactRegistry`; composing both
would create two commit points and weaken the required atomic visibility
boundary.

Construction accepts only a pristine campaign-genesis privacy state. Its policy
and maximum release count are included in a domain-separated store scope
commitment. Every state load validates:

- the exact state, privacy record, commit, and artifact wrapper shapes;
- release-count bounds, unique experiment/window commitments, globally
  task-disjoint hidden privacy windows, and the full historical privacy hash
  chain;
- the request-derived experiment digest for every debit;
- exactly one document of each allowed purpose, each strict schema and semantic
  content hash, and a four-distinct-hash set;
- result-source, experiment, policy-version, release ID, evidence, cards, and
  brief cross-links;
- the authorization binding and artifact-set commitments; and
- exact forward/reverse ownership for request, unsigned-result source,
  release, authorization, and every artifact hash.

`commit` snapshots and validates its complete input before asynchronous work,
then performs one compare-and-swap transition. A bit-identical authorization
replay returns the original historical receipt even after later releases. Any
changed input, stale privacy hash, reused request/source/release/artifact hash,
non-append transition, partial set, or rebind attempt fails closed. No delete,
refund, update, arbitrary URI, prefix, list, scan, or enumeration method
exists. `resolveByContentHash` accepts only a closed purpose plus an exact
SHA-256 and returns a defensive copy.

`orphan` atomically records the first orphan time in the same state. From then
on every artifact in that authorization resolves as absent. The immutable bytes
and privacy debit remain forever, exact commit replay cannot clear the marker,
and no hash can be rebound. An equivalent retry may carry a later observation
time and receives `already-orphaned`; the first durable time remains
authoritative. This makes retry safe when the caller lost the orphan
acknowledgement without inventing a refund path.

The store exposes a closeable lifecycle resource and can register it
immediately with the production composition owner. Clean controller handoff
and unclean recovery inherit the mounted-volume writer fence. Unclean recovery
requires provider-attested predecessor termination, and the former owner is
fenced after recovery.

### Alternatives

- Debit privacy and publish the four documents in separate stores.
- Prepublish a four-document batch in the general artifact registry, then
  update the privacy ledger.
- Put only document references in the privacy transaction.
- Refund privacy or delete bytes when final result issuance fails.
- Allow a later result to adopt an orphaned bundle.
- Recover documents by scanning directories or rebuilding an index.
- Return a mutable internal object or a purpose-wide result list.
- Retry a conflicting authorization under a new request hash.

### Consequences

The behavioral release has one nonrefundable commit point and no observable
prefix. Bounded exact replay handles the first ambiguous store
acknowledgement; ADR-0078 adds exact read-only commit reconciliation when the
replay acknowledgement is also lost. Result completion ambiguity remains a
separate broker concern: the broker must inspect its durable one-use result
ledger before deciding whether to return the completed result, orphan a
provably unreferenced bundle, or leave the bundle untouched for protected
recovery. This store does not guess result completion and does not expose an
orphan-status query to the optimizer.

Keeping complete historical documents in the transactional state favors
strong atomicity and auditability over an independently scalable blob layout.
The release budget is bounded to 4,096 entries and production must size the
mounted state limit for the configured, normally much smaller campaign
privacy budget. A future external database implementation may normalize the
records only if it supplies an equivalent serializable multi-record
transaction and exact non-enumerable reader.

The authored tests cover clean handoff, complete exact resolution, historical
commit replay, no-prefix rejection, permanent nonrefundable orphaning,
non-rebinding, provider-attested crash recovery and predecessor fencing, and
cross-artifact corruption with recomputed outer hashes. They must run only in
approved cloud CI; no Node, package-manager, formatter, build, or test command
was executed on the Mac.

### Evidence

- `src/cloud/mounted-volume-behavioral-privacy-store.ts`
- `src/evaluator/behavioral-release-producer.ts`
- `src/cloud/mounted-volume-state.ts`
- `tests/cloud/mounted-volume-behavioral-privacy-store.test.ts`

## ADR-0076 — Reconcile ambiguous result completion before orphaning diagnostics

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §3.3, §8.1

### Context

The behavioral privacy transaction can commit before the broker durably
completes its one-use signed-result record. A known pre-completion failure may
safely orphan that task-free diagnostic bundle without refunding its privacy
spend. The same action is unsafe when the result-ledger transaction committed
but its acknowledgement was lost: the signed result already names the
behavioral release, so orphaning it would make a valid completed result point
at deliberately unresolvable evidence. Converting the claim to failure would
also contradict the durable completion.

The broker previously had only mutating claim, complete, and consume
operations. Retrying `claim` is useful to a later caller, but it is not an
explicit read-only reconciliation contract and could not distinguish absence
from a newly created claim. Recovery needs a bounded exact lookup that creates
no record, exposes no enumeration surface, and cannot reveal hidden panel or
task material.

### Decision

Add `inspect(requestId, requestHash)` to `OneUseRequestLedger`. It returns only
`missing`, `conflict`, `in-flight`, `consumed`, or the exact completed signed
envelope. `DurableOneUseRequestLedger` performs the inspection inside its
linearizable store with `next` equal to the current state, so an absent request
remains absent and the revision does not advance. The same request-identity,
shape, and hash validation used by claims applies to inspection results.

The broker records whether it crossed into the `complete` call. If that call
throws, it inspects the same request ID and canonical request hash:

- a completed record must be byte-exact to the envelope submitted to
  `complete` and reproduce the request, disposition attestation,
  behavioral-release content hash, and valid release signature; the broker
  returns that durable result;
- an `in-flight` or `consumed` record proves that this exact completion did not
  commit, so the broker may orphan its diagnostic bundle and consume the
  failure; and
- absence, conflict, inspection failure, invalid signature, or any contradictory
  linkage is treated as ambiguous. The broker neither orphans the bundle nor
  consumes the claim and leaves both for protected recovery.

Raw Harbor, ATIF, and grader artifacts are still destroyed on every error path.
Inspection does not return task identities, panel membership, raw results, or
grader material, and it is not exposed to Claude Code or the controller's
task-free evidence tools.

### Alternatives

- Orphan every diagnostic bundle whenever `complete` throws.
- Assume every thrown completion committed and return the in-memory envelope.
- Retry `complete` without first resolving its durable disposition.
- Call `claim` as an implicit inspection and accept claim creation on absence.
- Refund the privacy debit while completion is uncertain.
- Expose an administrative ledger scan to recover ambiguous requests.

### Consequences

A lost acknowledgement can no longer invalidate evidence already bound by a
durable result, while a provably uncommitted result still closes its one-use
diagnostic path. Uncertain or contradictory state remains deliberately
unavailable until the trusted operator reconciles it; this may reduce
availability, but it preserves the stronger safety invariant and never refunds
adaptive privacy budget.

The authored tests cover read-only missing inspection and a ledger that commits
the exact envelope before throwing its acknowledgement. They also verify that
the broker returns only the recovered, linked, signature-valid envelope.
Typecheck, lint, and the full recovery suite must run in approved cloud CI; no
Node, package-manager, formatter, build, or test command was executed on the
Mac.

### Evidence

- `src/broker/ledger.ts`
- `src/broker/service.ts`
- `tests/broker/one-use-ledger.test.ts`
- `tests/broker/trusted-broker.test.ts`

## ADR-0077 — Stage free control readiness before paid composition

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §2.3, §12.0

### Context

The GitHub-to-Daytona launcher previously called the complete paid
`inspectBootstrapEnvironment` parser for every command. As a result,
`synthetic`, `status`, and `probe` could not start until the operator had
already chosen both models, private-Git and optimizer credentials, complete
Terminal-Bench hashes, budgets, signing identifiers, all four role images, and
the production bootstrap descriptor. The trusted control process repeated the
same all-or-nothing parse before branching by command. Secret and network
forwarding was command-specific, but configuration readiness was not. This
created a least-privilege violation and a practical bootstrap cycle: the free
checks intended to validate the deployment required the paid deployment to be
fully configured first.

Two additional cycles existed. Normal CI correctly requires a committed pnpm
lock, while the one-time lock generator required its requested source to
already be `main`; an implementation pull request could therefore not obtain
its lock before merge. Role-image publication needs the exact Harbor and
Terminal-Bench pin, while the existing process had no cloud-only command that
could resolve and content-address the public registry material without
releasing its task inventory.

### Decision

Introduce `inspectStagedControlEnvironment` with two deliberately small
profiles:

- `offline` accepts only provider, region class, and one immutable control
  image;
- `probe` adds only immutable build and evaluator images.

The GitHub bootstrap continues to require the exact Daytona target, campaign
volume subpath, bounded TTL/resources, and the Daytona API credential needed to
create and destroy the disposable control sandbox. Those are infrastructure
inputs, not paid harness inputs. `synthetic`, pre-composition `status`, `stop`,
and `resume` parse no network allowlist, nested provider secret, controller
secret mapping, optimizer/evaluated-model data, Git source, benchmark pin,
budget, signing identifier, or production descriptor. Their sandbox secret
map is empty and networking is blocked. `probe` alone adds the named nested
Daytona secret and explicit network allowlist. `optimize` alone retains the
complete original parser, Pi-source verification, exact paid authorization,
canonical signed descriptor, and reviewed additional controller secrets.
Forwarded environment names follow the same stage split rather than copying
the paid environment into a free sandbox.

Add a release-safe pre-composition `status` result. It stores and returns only
`awaiting-production-composition`, the immutable control-image digest, and the
public fail-closed binding-readiness commitment. It is explicitly not mutable
campaign reconstruction and grants no execution. The real status path must be
replaced by `ProductionOptimizeCompositionOwner.status` when that owner is
wired. `optimize` remains hard-locked and still returns `runnable: false`;
`stop` and `resume` remain locked.

Add a separate `cloud-control-preflight` workflow for `probe`, `synthetic`, and
pre-composition `status`. It does not use the protected paid environment and
has no paid authorization or bootstrap descriptor. The GitHub runner receives
only its Daytona bootstrap credential. The offline Daytona sandbox receives
no secret and no network. Bind this job to a distinct
`dark-factory-preflight` GitHub environment so its bootstrap credential can be
reviewer-protected independently of paid optimization. Runtime image
references must be deliberately public or supported by provider-side
private-registry configuration; a registry credential is never forwarded
through the evaluated sandbox merely to make a private image pull work.

Make the one-time lockfile review workflow run automatically on the exact
`codex/dark-factory-mvp` bootstrap branch, with a second manual mode available
from `main` once the workflow has itself been reviewed. Manual mode checks out
an exact `refs/heads/...` tip whose SHA must match the typed input; push mode
binds directly to `github.ref` and `github.sha`. Both modes have read-only
repository permission, persist no checkout credential, reject `.npmrc`, pnpm
hook files, and workspace manifests, disable lifecycle scripts, refuse an
existing lock, and upload only the new lock and checksum. This permits the
lock to join the same implementation pull request without executing project
code or granting write authority.

After the reviewed lock is committed to the exact bootstrap branch, a second
read-only push workflow performs the source mutation that is forbidden on the
Mac: it installs only from the frozen lock, applies Biome, runs lint,
typecheck, coverage tests, and the distributable build, then uploads the
binary-safe formatter patch plus a source-commit-bound checksum receipt. It
has no write credential and rejects formatter changes to the package manifest,
lock, or non-source formats. A human or controlling agent must verify and
apply the patch in a later commit before opening the normal quality-gated pull
request.

Add `discover-terminal-bench-pin.mjs` and a main-only no-secret workflow. The
workflow installs one exact Harbor semantic version in ephemeral GitHub-hosted
storage, downloads exactly
`terminal-bench/terminal-bench-2-1@<positive revision>`, suppresses the
download log, and asks the script to:

- reject workstation execution, source-commit drift, aliases, malformed
  versions/revisions, symlinks, non-regular entries, traversal, excess
  files/bytes, and any count other than exactly 89 `task.toml` manifests;
- hash a deterministic internal manifest of every relative path, byte length,
  mode, and file digest without putting that manifest in the receipt;
- hash the single `dataset.toml`, downloaded Harbor distribution, installed
  Harbor executable, and reviewed Pi adapter;
- emit a canonical receipt containing only benchmark/dataset identity,
  revision, count, aggregate byte/file counts, version, hashes, source commit,
  policy commitment, and receipt hash; and
- create the receipt with exclusive-write semantics.

The workflow deletes the downloaded dataset and its log before uploading only
the receipt and checksum. It does not upload task names, relative task paths,
instructions, tests, graders, selectors, or the internal content manifest.
The receipt is content-addressed but not a fabricated KMS authorization.
Production must retain the reviewed workflow/run provenance and bind the exact
pin through its independently signed composition authorities.

### Alternatives

- Keep the complete paid parser and merely omit secrets when launching free
  commands.
- Fill missing paid variables with placeholders for probe and synthetic.
- Run preflight on the Mac.
- Treat pre-composition status as real campaign reconstruction.
- Let status, stop, or resume implicitly instantiate the production owner.
- Merge unverified source to `main`, then generate its dependency lock.
- Generate the lock locally or permit package lifecycle scripts.
- Resolve a mutable `latest` benchmark or Harbor alias during image build.
- Upload the downloaded dataset inventory or task-relative content manifest
  for operator review.
- Claim the unsigned discovery receipt is a KMS attestation.

### Consequences

Free readiness can now be exercised without choosing or exposing paid
credentials and without weakening the optimize gate. A pre-composition status
receipt distinguishes “the control path works but production is unbound” from
a failed command. Provider creation still requires the GitHub-side Daytona
credential, and a live probe still needs its nested provider credential;
neither fact is hidden. The preflight environment and image visibility/pull
configuration must be created by the operator before dispatch; naming them in
source does not prove their protections or provider availability.

The lock and pin workflows remove configuration cycles but do not constitute
execution evidence until dispatched. Pin discovery validates the downloaded
shape and content hashes, not benchmark fairness, grader isolation, Harbor
runtime correctness, or leaderboard eligibility. The Harbor version and
registry revision remain explicit operator choices; the workflow proves what
those exact choices resolve to and rejects count/content drift. The receipt
contains no task inventory, so the optimizer cannot use it to infer evaluation
tasks.

Real optimize is still blocked on the reviewed pnpm lock and cloud quality
run; immutable role-image publication and live provider/DIND/volume probes;
the real pin receipt and hidden catalog genesis; independent descriptor,
composition, source, campaign, catalog, evaluator-release, and optimizer
evidence key authorities; concrete artifact/runtime/provider/KMS dependency
objects and signed attestations; and control-plane instantiation of the
verified `ProductionOptimizeCompositionOwner`. No environment value or pin
receipt supplies those authorities.

Static tests cover minimal free-stage parsing, absence of paid environment
forwarding, exact task count, receipt non-disclosure, symlink rejection, and
workstation rejection. They must execute only in approved cloud CI. No Node,
package-manager, formatter, build, test, Harbor, or dataset command was run on
the Mac while authoring this decision.

### Evidence

- `src/cloud/control-stage-configuration.ts`
- `src/cloud/control-bootstrap.ts`
- `src/cloud/control-plane.ts`
- `scripts/discover-terminal-bench-pin.mjs`
- `.github/workflows/bootstrap-lockfile.yml`
- `.github/workflows/cloud-format-review.yml`
- `.github/workflows/discover-terminal-bench-pin.yml`
- `.github/workflows/cloud-preflight.yml`
- `tests/cloud/control-bootstrap.test.ts`
- `tests/scripts/discover-terminal-bench-pin.test.ts`
- `CLOUD_DELIVERY.md`

## ADR-0078 — Reconcile behavioral release commits by exact binding

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §3.3, §8.1

### Context

ADR-0075 made privacy spending and publication of the four release-safe
documents one durable transaction. Its bounded exact commit replay handles one
lost acknowledgement, but the underlying transaction can commit before both
the initial acknowledgement and replay acknowledgement are lost. The producer
then cannot distinguish a durable privacy-spending release from a transaction
that never committed. Treating both cases as an ordinary finalization failure
allows the broker to consume the request even though an exact release is
already committed. Blindly retrying under a new authorization would instead
invite double spending or rebinding.

Resolution by artifact listing or store scanning would expose an enumeration
surface over adaptive feedback. Resolution by the release hash alone would
also be too weak: a caller must prove the complete one-use relationship among
the request, unsigned result source, authorization, release, and four-document
artifact set. Inspection must not spend privacy, publish documents, clear an
orphan, establish ownership, or refund an existing debit.

### Decision

Add `inspectCommit` to `TrustedBehavioralPrivacyArtifactStore`. Its query
contains exactly five SHA-256 values:

- authorization hash;
- canonical evaluation-request hash;
- unsigned result-envelope source commitment;
- signed behavioral-release content hash; and
- canonical four-document artifact-set hash.

The operation is non-enumerating. It returns one of four closed dispositions:

- `committed`, containing the exact historical commit receipt, exactly four
  purpose/content-hash references, and the immutable orphan time;
- `absent`, only when a validated durable read proves that none of the five
  supplied bindings exists;
- `conflict`, when any supplied value is owned but the complete five-part
  binding is not exact; or
- `ambiguous`, when validation, ownership, storage, or the read itself cannot
  establish a trustworthy disposition.

`MountedVolumeBehavioralPrivacyArtifactStore` implements the lookup in the
same fenced linearizable state authority with `next` equal to the current
state. It validates the complete historical state before answering and exposes
no iterator, partial match, conflict detail, task identifier, artifact body,
or owner hash. Exact inspection cannot advance the privacy state or durable
revision. An orphaned exact commit remains reported as committed with its
orphan time so a trusted caller can reject it; inspection never clears the
marker or makes its artifacts readable.

The deterministic producer captures all five expected hashes and the four
expected artifact references before entering `commit`. If commit or receipt
validation throws, it performs one exact inspection. It resumes finalization
only when the response is a non-orphaned committed record whose receipt,
privacy-state hash, binding hash, artifact-set hash, and all four references
match the captured values. Proven absence becomes a known non-commit failure.
Conflict, an orphan marker, malformed references, or ambiguity becomes an
`unsafe-to-consume` producer failure.

The broker distinguishes that tagged failure from an ordinary pre-commit
failure. It still destroys raw run material, but it neither discards the exact
trusted-private behavioral preparation, orphans a release, nor consumes the
one-use evaluation claim while commit state is unsafe. This leaves the exact
durable inputs and outputs available to protected operator reconciliation. No
path refunds privacy or permits the same request, source, release,
authorization, or artifact hashes to be rebound.

### Alternatives

- Treat a second lost acknowledgement as a normal failed evaluation.
- Retry with a new authorization, request, release, or artifact set.
- Assume the commit succeeded without checking its exact historical record.
- Inspect by release hash alone.
- Expose a list or prefix scan of behavioral releases.
- Return artifact bodies or conflict-owner details from reconciliation.
- Orphan, delete, or refund every commit whose acknowledgement is uncertain.

### Consequences

A release committed before two lost acknowledgements can now be recovered into
the same finalization handle and continue through signed result issuance. The
privacy budget remains debited exactly once, all four artifacts retain their
original ownership, and no orphan or replacement binding is created.

Availability remains deliberately secondary to integrity. A conflict,
corrupted store, lost inspection acknowledgement, or already-orphaned commit
does not guess; the broker preserves the claim for trusted recovery. The exact
five-hash query must therefore be retained in protected evaluator state or
reconstructed deterministically from the same private preparation and
task-free artifacts, never released to Claude Code.

Authored tests cover exact/absent/conflict dispositions, unchanged privacy
state across inspection, a permanent orphan marker, two consecutive lost
commit acknowledgements, exact recovery, and rejection of refund, orphan, and
rebind behavior. They also verify that the broker does not consume a request
when commit reconciliation remains unsafe. These tests must run only in
approved cloud CI; no Node, package-manager, formatter, build, or test command
was executed on the Mac.

### Evidence

- `src/evaluator/behavioral-release-producer.ts`
- `src/cloud/mounted-volume-behavioral-privacy-store.ts`
- `src/broker/service.ts`
- `tests/evaluator/behavioral-release-producer.test.ts`
- `tests/cloud/mounted-volume-behavioral-privacy-store.test.ts`
- `tests/broker/trusted-broker.test.ts`

## ADR-0079 — Persist private behavioral preparation as a one-use evaluator transaction

- Date: 2026-07-26
- Status: accepted
- Supersedes: ADR-0071's process-local preparation map and destructive-take
  lifecycle
- Superseded by: ADR-0081 for post-finalization orphan handling
- Related plan: `PLAN.md` §3.3, §8.1, §12

### Context

ADR-0071 correctly delayed diagnostic publication until raw evidence had been
destroyed, but it retained the task-private behavioral preparation in a
process-local map and removed it with `take(requestHash)` before release
finalization. A controller or evaluator loss after normalization could
therefore erase the only deterministic input to the privacy transaction. A
loss after destructive take but before finalization had the same effect. The
one-use result ledger and hidden panel were already burned, so restarting the
process could neither reproduce the release nor prove that no release had
committed.

The later exact privacy-commit reconciliation in ADR-0078 deliberately needs
the same private preparation to reconstruct its five-part query. Leaving that
object only in memory made ADR-0078 insufficient across process failure.
Simply writing the preparation into an ordinary artifact registry would be
worse: it contains hidden task IDs, per-arm outcomes, behavior summaries,
forbidden literals, and scanner fingerprints and must never become listable or
available to the controller, Claude Code, release assembly, or local evidence
tools.

### Decision

Add `TrustedBehavioralPreparationStore`, a private evaluator-only capability
with exactly four operations:

- `prepare(preparation)` commits the canonical task-private object under its
  exact request and protocol hashes and returns its domain-separated
  preparation hash;
- `resolve({requestHash, protocolHash})` performs the only read, requiring
  both exact hashes and returning `missing`, `prepared`, `finalized`, or
  `consumed`;
- `finalize(...)` binds the exact preparation hash, unsigned-result source
  commitment, authorization, release content, and source-set hash, then erases
  the private payload; and
- `consume(...)` erases an unfinalized payload and leaves an immutable
  tombstone.

There is no enumeration, prefix, iterator, arbitrary content-hash lookup,
artifact reader, deletion, or release-safe adapter. `finalized` retains only
the task-free finalization handle and its binding hash. `consumed` retains only
request/protocol/source/preparation commitments. Finalized records cannot
become consumed, consumed records cannot become finalized, and neither can be
prepared again. Exact prepare/finalize/consume replays return the historical
disposition; any changed field fails closed.

`MountedVolumeBehavioralPreparationStore` implements the contract in the same
provider-mounted, single-writer, content-hashed JSON transaction primitive as
the other production authorities. Every load validates the full private
preparation shape, exact 12-task/24-observation matched structure, behavior
enums, policy versions, scanner inputs, record hashes, disposition invariants,
revision history, and cross-record uniqueness of release source,
authorization, and content hashes. State transitions retry one identical
operation after an ambiguous acknowledgement. The store can register
immediately with an injected production lifecycle owner and requires
provider-attested predecessor termination before an unclean successor may
recover the writer fence. At the time of this decision no concrete evaluator
bootstrap instantiated it. ADR-0085 now makes the lifecycle argument mandatory
at the production runtime call site; the optional constructor form remains
only for isolated source tests.

The canonical deriver now commits an eligible validation preparation before
returning its release-safe aggregate and verifies the exact durability
receipt. Repair and shadow produce no record. Production evaluator composition
requires the store's `trusted-cloud` boundary and all four methods; a
`test-only-in-memory` boundary is structurally available to unit fixtures but
is rejected by production composition.

The broker integration uses the following order:

```text
normalize -> durable prepare -> verify raw destruction
  -> exact non-destructive resolve
  -> privacy/artifact finalize or suppress
  -> durable finalized binding or consumed tombstone
  -> sign and durably complete result
```

A release-finalization error whose commit disposition is ambiguous must leave
the record `prepared`; protected recovery can reconstruct the exact ADR-0078
inspection from it. A known suppression or known pre-commit failure may
consume it. Once a release is known committed, the broker must record
`finalized` before issuing the result. Result-completion ambiguity continues to
follow ADR-0076 and never rewrites a finalized preparation.

### Alternatives

- Keep the map and rely on process uptime between normalization and release.
- Serialize the private object into the release-safe artifact registry.
- Destructively read and delete the preparation before finalization.
- Persist only a preparation hash and assume observations can be reconstructed
  after raw destruction.
- Permit administrative scans to find stranded preparations.
- Change a finalized record to consumed when result issuance fails.
- Delete records entirely and allow the request hash to be reused later.

### Consequences

Normalization can no longer succeed without a durable, byte-exact preparation,
and raw destruction no longer makes diagnostic finalization dependent on
process memory. Private observations survive only while recovery may still
need them and are irreversibly removed once finalized or consumed. Recovery
may require an operator who already knows the exact request and protocol
hashes; this intentional availability cost prevents the store from becoming a
hidden-task oracle.

The current mounted-volume transition performs logical erasure from the live
JSON state. Atomic replacement does not prove cryptographic destruction of old
filesystem blocks, provider snapshots, or abandoned staging files. If those
media are inside the deployment threat model, production must
envelope-encrypt each preparation and destroy its per-record data key on a
terminal transition.

The authored adversarial tests cover exact idempotent preparation, clean
handoff, no enumeration surface, wrong-protocol denial, conflicting replay,
private-byte erasure, finalized/consumed irreversibility, cross-binding
rejection, provider-attested crash recovery, and predecessor fencing. They
must run only in approved cloud CI. No Node, package-manager, formatter, build,
lint, or test command was executed on the Mac while authoring this decision.

### Evidence

- `src/evaluator/behavioral-preparation-store.ts`
- `src/evaluator/deriver.ts`
- `src/evaluator/composition.ts`
- `src/broker/service.ts`
- `src/cloud/mounted-volume-behavioral-preparation-store.ts`
- `src/cloud/index.ts`
- `tests/evaluator/deriver.test.ts`
- `tests/evaluator/composition.test.ts`
- `tests/broker/trusted-broker.test.ts`
- `tests/cloud/mounted-volume-behavioral-preparation-store.test.ts`

## ADR-0080 — Inspect optimizer-bound artifact bytes, not release claims

- Date: 2026-07-26
- Status: accepted
- Supersedes: ADR-0068's metadata-only archive acceptance
- Superseded by: none
- Related plan: `PLAN.md` §2, §8, §9, §12

### Context

The production optimizer resolver authenticated strict, signed metadata before
returning a release-evidence tar reference. The metadata bound URI, SHA-256,
media type, byte length, purpose, query lineage, and five all-false sensitivity
flags. The task-free artifact registry also rejected sensitive field names.
Neither control opened the referenced tar. A compromised publisher could
therefore sign metadata whose flags said “safe” while the actual archive
contained a task name, raw grader excerpt, protected path, encoded payload,
canary, symlink, traversal entry, or nested archive. Claude would receive the
artifact after only a metadata/key-name decision.

The source snapshot has a related but different risk. Pi source is intentionally
available to Claude, so its ordinary code cannot be subjected to the same prose
rules as released evaluator feedback. Nevertheless, a signed source receipt
must not become a convenient carrier for a bundled Terminal-Bench task tree,
grader, solution, or local path. The hidden catalog genesis object also placed
the complete hidden import beside its task-free receipt as an ordinary
enumerable property, making an accidental whole-object JSON log sufficient to
leak all task rows.

### Decision

Require `ArtifactBackedCloudOptimizerAdapterResolver` to receive two distinct
artifact capabilities:

- the existing JSON-only reader for signed metadata; and
- a `TrustedOptimizerReleaseArtifactReader` that returns the actual immutable
  bytes through a verifying artifact bridge.

The resolver captures both methods at construction. Before returning any
evidence or source reference, it snapshots the artifact reference, reads under
a fixed byte ceiling, rejects caller mutation, independently recomputes byte
length and SHA-256, and then applies a concrete content parser. Inspection
success is cached by a canonical key over the inspection kind, full artifact
reference, expected source commit, and inspection-policy hash. A failed promise
is retained, so a retry cannot ask a malicious backend for alternate bytes. A
new URI, media type, length, source commitment, or policy therefore requires a
fresh verified read even if a declared digest is reused.
Signatures, `contains*` flags, registry scans, or an inspector-supplied Boolean
cannot bypass this operation.

Release evidence is restricted to a canonical, bounded USTAR subset:

- at most 64 MiB, 2,048 entries, and 8 MiB per released file;
- two complete zero terminator blocks and valid header checksums;
- unique normalized relative ASCII paths;
- regular files and directories only;
- no symlink, hardlink, device, FIFO, traversal, encoded separator, PAX/GNU
  extension ambiguity, duplicate path, or nested archive;
- every file path must be present in the fixed campaign policy allowlist;
- the policy must contain at least one grader-canary fingerprint;
- only `.json`, `.md`, and `.txt` payloads;
- fatal UTF-8 decoding with no BOM, NUL, control, or bidi payload;
- canonical newline-terminated JSON for JSON entries; and
- a full recursive release-safety and campaign fingerprint scan of content,
  including `/var`, `/private`, `/root`, other absolute paths, Windows paths,
  URLs, grader/verifier/solution terms, task/trial/panel/cell identities,
  encoded separators, printable base64/base64url/hex payloads, and exact
  forbidden-content or grader-canary fingerprints.

The signed source-tree tar uses the same checksum, path, type, duplication,
traversal, link, nesting, and size controls, with a 256 MiB ceiling and an
explicit denylist for Terminal-Bench/tbench task, grader, solution, reference
answer, and benchmark-task paths. Its ordinary source contents are not passed
through the release-prose scanner because real Pi code legitimately discusses
paths and tools. Every source file still receives a raw obvious
protected-literal check, while every UTF-8-decodable file receives exact
campaign canary/fingerprint matching over whole values, lines, quoted values,
lexical tokens, and JSON string values. Known text extensions fail closed on
malformed UTF-8. Candidate descendants are additionally admitted only after
the integrity gate rejects changed extensionless or unapproved binary paths
and Git binary-patch markers, closing the otherwise opaque changed-file
channel. To remain compatible with `git archive`, the first source record must
be the one exact global PAX
`comment=<signed-commit-id>` header; no missing/detached commit, path, link, or
arbitrary PAX extension is accepted. The corresponding Git
bundle is capped at 256 MiB, requires a v2/v3 bundle header, exactly one
syntactically valid object/ref advertisement for that same signed commit at
the fixed bundle ref, a PACK boundary, safe refs, and a raw-byte scan for
obvious protected literals and `/var`, `/private`, or `/root` paths. The
trusted Git worker first verifies the remote ref, commit, tree, lineage, and
repository fsck, generates both artifacts from that commit, verifies the
bundle, and binds both exact references in one signed manifest and source
receipt. The resolver independently inspects the unpacked source tar before it
can return the paired bundle. Commit, tree, lock, origin, and ref lineage
checks from ADR-0068 remain mandatory.

`BridgeBackedTrustedOptimizerReleaseArtifactReader` is the concrete bounded
adapter over `TrustedArtifactBridge.openVerified`; the resolver still performs
its own digest and content verification. The production runtime factory now
captures the reader and the exact campaign inspection policy alongside the
other optimizer dependencies and requires the policy's evaluator-policy
commitment to equal the signed composition manifest binding.

`TrustedLoadedCatalogGenesis.hiddenImport` remains explicitly readable to
trusted broker code but is installed as a non-enumerable, non-writable,
non-configurable property on a frozen result. Ordinary `JSON.stringify`,
canonical logging, and object spread therefore serialize only the task-free
control fields and receipt.

### Alternatives

- Trust the publisher's signed all-false sensitivity flags.
- Scan only metadata and registry field names.
- Ask an external inspector for a pass/fail Boolean without opening bytes in
  the resolver path.
- Let the optimizer sandbox inspect the archive after upload.
- Permit general tar implementations with links, PAX extensions, and nested
  archives.
- Serialize the hidden catalog result as one plain object and rely on callers
  to select the receipt.
- Apply the evaluator-feedback prose scanner to the complete Pi source tree.

### Consequences

An evidence archive cannot reach Claude solely because its metadata is valid.
Malicious false-flag JSON, protected roots, base64/hex payloads, traversal,
links, nested archives, unlisted release paths, protected source paths/content,
detached source commits, and exact canaries now fail before reference release.
The strict format also makes archive construction deterministic and keeps
parsing cost bounded.

The production evidence packager must emit this exact USTAR subset; a PAX or
GNU tar produced by a default tool may now fail safely and must be replaced by
the reviewed deterministic packager. Full Git pack object decompression is
intentionally not implemented in this layer. The Git-bundle scan covers its
header, advertised refs, total immutable bytes, and raw detectable literals;
the independently inspected signed source-tree tar plus exact
commit/tree/lock lineage is the content-level companion. Compressed literals
inside a Git pack are therefore not found by the raw bundle scan alone. This
pairing is acceptable only while the registered Pi lineage remains
task-free and never ingests evaluator artifacts; source registration,
publication, and candidate-integrity gates must preserve that invariant.
Before live execution, cloud CI must exercise a real bundle and prove the
signed source tar represents the same commit tree. Content fingerprints are
exact string fingerprints; detecting a protected literal embedded inside a
larger otherwise-safe string still depends on the lexical scanner or a future
keyed substring-matching authority. The stricter path and encoded-payload
scanners also require a representative release-safe corpus in cloud CI to
detect unacceptable false positives before activation.

The authored tests cover valid archives, signed false-flag metadata, `/root`
and `/private` paths, printable base64 payloads, traversal, symlinks, nested
archives, unlisted release paths, protected canary fingerprints in release and
source content, protected source-tree paths, detached source tar/bundle commit
bindings, full-reference cache substitution, reader mutation, and
non-enumerable catalog serialization. They have not been run on the Mac and
must execute in approved cloud CI with real deterministic packager and
Git-bundle fixtures.

### Evidence

- `src/optimizer/release-artifact-safety.ts`
- `src/optimizer/artifact-backed-resolver.ts`
- `src/cloud/optimizer-release-artifact-reader.ts`
- `src/cloud/production-optimize-runtime-factory.ts`
- `src/schemas/safety.ts`
- `src/mcp/security.ts`
- `src/evaluator/retention.ts`
- `src/broker/catalog-genesis-loader.ts`
- `tests/cloud/optimizer-release-artifact-reader.test.ts`
- `tests/cloud/production-optimize-runtime-factory.test.ts`
- `tests/optimizer/artifact-backed-resolver.test.ts`
- `tests/schemas/registry.test.ts`
- `tests/mcp/security.test.ts`
- `tests/broker/catalog-genesis-loader.test.ts`

## ADR-0081 — Terminate orphaned behavioral finalizations durably

- Date: 2026-07-26
- Status: accepted
- Supersedes: ADR-0079's two-terminal-state preparation lifecycle
- Superseded by: none
- Related plan: `PLAN.md` §3.3, §8.1, §12

### Context

ADR-0079 made private behavioral preparations durable and irreversible, but
gave them only `prepared`, `finalized`, and `consumed` terminal behavior. A
result-issuance failure could permanently orphan the already committed
behavioral bundle in the privacy/artifact store while the preparation store
remained `finalized`. Because that record still exposed its valid finalization
handle, protected recovery could attempt to issue a result naming a release
that had already become permanently invisible. Changing the record to
`consumed` was forbidden and would also erase the distinction between a
pre-commit suppression and a post-commit orphan.

The producer's `orphan` operation returned `void`, so the broker had no
task-free durable evidence to bind to a second state transition. The lower
store's idempotent replay also returned the caller's later timestamp rather
than the first durable orphan timestamp. That made a retry semantically
successful but prevented one byte-stable terminal attestation.

### Decision

Add a normalized
`TrustedBehavioralReleaseOrphanFinalizationReceipt`. It contains only opaque
authorization, request, release, and source-set hashes, the first canonical UTC
orphan timestamp, and a domain-separated `orphanFinalizationHash`. It contains
no task, grader, command, output, path, model, provider, or trajectory data.
The producer validates the exact lower-store authorization/request/release
binding and timestamp before returning it. Both the first orphan and every
exact later replay return the same normalized `status: "orphaned"` receipt;
the lower durable store now returns its first persisted orphan time on an
`already-orphaned` acknowledgement.

Extend `TrustedBehavioralPreparationStore` with `abandon(...)` and add an
`abandoned` exact-resolution disposition. The operation accepts the request,
protocol, preparation, unsigned-result source, and finalization hashes plus
the normalized orphan receipt. It may transition only the exact matching
`finalized` record. The mounted-volume implementation verifies the receipt's
domain-separated hash and every link to the stored finalization, computes a
second domain-separated preparation `abandonmentHash`, advances the durable
revision, erases the reusable finalization handle, and retains only task-free
terminal evidence.

The full state machine is:

```text
prepared -> finalized -> abandoned
         \-> consumed
```

`finalized -> consumed`, `abandoned -> consumed`, `abandoned -> finalized`,
`abandoned -> prepared`, and every cross-binding transition are impossible.
An exact abandonment replay returns `already-abandoned` with the historical
hashes; a changed receipt, timestamp, source, protocol, request, preparation,
release, authorization, source set, or finalization fails closed. `consume`
against an abandoned record returns the non-mutating `already-abandoned`
receipt. Cross-record uniqueness continues to reserve the source-result,
authorization, and release hashes after abandonment.

Production evaluator composition and the canonical deriver now reject a
behavioral-preparation capability without `abandon`. The durable preparation
state schema advances to version 2 and intentionally fails closed on an old
state rather than guessing a migration for a security-critical terminal
disposition. Broker sequencing must first follow ADR-0076 to prove result
non-completion, then obtain the normalized orphan receipt, then commit
`abandoned`; ambiguity at either boundary preserves the finalized state for
protected exact recovery.

### Alternatives

- Leave the preparation finalized after hiding its release.
- Convert the finalized record to the pre-commit consumed tombstone.
- Delete the finalized record or its one-use hashes.
- Trust a Boolean from the producer instead of retaining a bound receipt.
- Persist the caller's newest orphan timestamp on every replay.
- Permit recovery to reissue a result and let downstream release resolution
  discover that the behavioral bundle is gone.
- Expose the privacy/artifact store to the preparation store for enumeration.

### Consequences

An issuance failure can no longer leave a reusable finalization handle pointing
at a permanently orphaned release. The privacy spend and immutable bundle
remain nonrefundable, the request and release remain one-use, and exact retries
converge on one durable task-free terminal attestation. The additional state
distinguishes post-commit abandonment from pre-commit suppression without
retaining hidden observations.

Availability remains subordinate to integrity. If the orphan acknowledgement
or preparation abandonment acknowledgement is lost and cannot be exactly
replayed, the broker must not consume, re-finalize, or issue; protected
reconciliation is required. Schema-version-1 preparation volumes require an
explicit reviewed migration or a new campaign volume before production use.

Authored tests cover normalized task-free receipts, stable orphan replay, exact
request binding, durable finalized-to-abandoned transition, restart recovery,
private-byte and reusable-handle erasure, changed-receipt rejection,
abandoned-to-consumed denial, finalization replay denial, preparation
resurrection denial, and production composition rejection when `abandon` is
missing. They have not been run on the Mac and must execute in approved cloud
CI.

### Evidence

- `src/evaluator/behavioral-release-producer.ts`
- `src/evaluator/behavioral-preparation-store.ts`
- `src/evaluator/deriver.ts`
- `src/evaluator/composition.ts`
- `src/broker/service.ts`
- `src/cloud/mounted-volume-behavioral-privacy-store.ts`
- `src/cloud/mounted-volume-behavioral-preparation-store.ts`
- `tests/evaluator/behavioral-release-producer.test.ts`
- `tests/evaluator/deriver.test.ts`
- `tests/evaluator/composition.test.ts`
- `tests/broker/trusted-broker.test.ts`
- `tests/cloud/mounted-volume-behavioral-privacy-store.test.ts`
- `tests/cloud/mounted-volume-behavioral-preparation-store.test.ts`

## ADR-0082 — Keep the generated feedback ledger operator-only

- Date: 2026-07-26
- Status: accepted
- Supersedes: ADR-0016 only with respect to optimizer visibility
- Superseded by: none
- Related plan: `PLAN.md` §3, §9, §11

### Context

The generated `FEEDBACK.md` ledger intentionally records release-safe
operational provenance useful to the operator: repair disposition, cache-use
status, panel rotation, shadow capacity, state transitions, experiment paths,
and audit hashes. None names a task, but their combination reveals panel role
and exposure history. The optimizer contract separately forbids Claude Code
from receiving or inferring those fields. An earlier architecture diagram
nevertheless routed `FEEDBACK.md` directly to the next hypothesis, making an
operator audit report appear to be optimizer input.

The file also contains Markdown paths, code fences, and presentation text that
are outside the fixed optimizer release-archive schema. Passing it through as
an informal side channel would bypass the signed metadata, privacy support,
one-use diagnostic release, exact path allowlist, and byte inspection required
by ADR-0080.

### Decision

`FEEDBACK.md` is an operator-only, release-safe audit mirror. It may be
deterministically rebuilt and displayed to the operator, but it is never
mounted in the optimizer sandbox, returned by MCP, packaged in optimizer
evidence, or used as machine input for a hypothesis.

Claude Code receives only the separately signed source-only bootstrap or
privacy-thresholded diagnostic artifacts resolved by exact query and admitted
by the optimizer byte gate. Those artifacts omit panel roles, exposure
history, stable panel handles, task identities, task lists, grader content,
and operator-only capacity fields. Stage selection and champion decisions
remain controller-owned; the optimizer has no tool for either action.
The optimizer campaign-context parser therefore omits the former exact
fresh-validation-panel and shadow-slice counters and rejects
capacity/holdout/panel/shadow/slice/validation budget-band keys rather than
turning them into a second, coarsened capacity channel.

### Alternatives

- Redact selected sections of `FEEDBACK.md` dynamically for each optimizer
  turn.
- Treat every release-safe operator field as safe for Claude.
- Add panel lifecycle and decision tools to the optimizer MCP server.
- Let Claude read the experiment directory and rely on prompting not to infer
  roles.

### Consequences

The operator retains one comprehensible audit ledger without expanding the
optimizer trust zone. The optimizer loop continues through a narrower,
schema-validated diagnostic channel. Any future machine-readable use of
feedback requires a new signed artifact purpose and must pass the same privacy,
lineage, query, and byte-inspection controls; renaming or copying
`FEEDBACK.md` is not sufficient.

### Evidence

- `PLAN.md`
- `FEEDBACK.md`
- `README.md`
- `src/mcp/server.ts`
- `src/mcp/repository.ts`
- `src/optimizer/artifact-backed-resolver.ts`
- `src/optimizer/release-artifact-safety.ts`
- `tests/mcp/repository.test.ts`

## ADR-0083 — Reject opaque candidate mutations before source release

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §8, §9, §12

### Context

ADR-0080 inspects every recognized text file in the unpacked source tar before
the paired Git bundle can reach the optimizer. A newly added binary,
extensionless, or otherwise opaque file under an approved Pi source root could
avoid content fingerprint scanning. The Git bundle cannot close this gap by a
raw byte search because its pack objects are compressed. Metadata flags and a
safe-looking path cannot prove the opaque payload is task-independent.

The optimized harness does not need to mutate binary assets to change prompts,
tool policy, context management, retry logic, or other intended Pi behavior.
Unchanged baseline binaries remain bound by the signed commit/tree/lock source
snapshot, so rejecting only candidate changes does not make the baseline
unrepresentable.

### Decision

The candidate integrity scanner now admits changed files only under the
approved Pi mutation roots and only with an explicit text/source extension
allowlist. Every changed extensionless, binary, or unapproved format receives
`OPAQUE_BINARY_CHANGE`. A Git diff containing `GIT binary patch` or a
`Binary files ... differ` marker independently receives the same violation.
Git link and submodule modes (`120000` and `160000`) are rejected whether
introduced by a mode-change line or retained on an `index` line. The scanner
also derives changed paths and line counts from the supplied unified diff and
requires exact agreement with unique, normalized caller metadata; ambiguous
headers, negative counts, duplicate paths, or concealed paths fail with
`DIFF_METADATA_MISMATCH`.

Literal inspection is aggregate rather than line-local only. Adjacent encoded
chunks are reassembled, short printable hexadecimal and Base64 values are
decoded for protected-fragment and benchmark-reference checks, and protected
phrases reconstructed across adjacent literals are rejected. Hexadecimal is
classified before Base64 because its alphabet is a subset of Base64. These
controls do not reveal protected fragments: comparison remains against the
trusted set of one-way fragment hashes.
The existing mutation-size, protected-path, encoded-payload, benchmark
fragment, environment-routing, network, and solution-reference controls still
apply.

The optimizer source-release gate relies on this signed candidate-integrity
receipt together with its own same-commit source-tar inspection. Neither gate
alone is treated as sufficient, and unchanged baseline-pinned opaque files
remain acceptable only because their hashes are part of the reviewed source
identity.

### Alternatives

- Attempt to classify arbitrary binaries inside the optimizer resolver.
- Decompress and independently reconstruct every Git pack object there.
- Allow opaque files when their filenames appear harmless.
- Permit new binaries after an LLM review.
- Reject all baseline repositories containing any opaque file.

### Consequences

Candidate code cannot use an innocuous opaque carrier to persist protected
content across experiments. Legitimate future mutations to a new source
format require an explicit policy review and allowlist change, which creates a
new integrity-policy hash. Real diff fixtures and safe-corpus calibration must
still run in protected cloud CI before production.

### Evidence

- `src/integrity/candidate-scanner.ts`
- `tests/integrity/candidate-scanner.test.ts`
- `src/optimizer/release-artifact-safety.ts`
- `src/optimizer/artifact-backed-resolver.ts`
- `PLAN.md`
- `TODO.md`

## ADR-0087 — Resume one-use evaluations only from an exact post-destruction checkpoint

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §3.3 and §7.1

### Context

The one-use ledger preserved an interrupted request as `in-flight`, and the
broker could reconcile a lost `complete` acknowledgement within the same call.
After a controller crash, however, a successor had neither an authorized way
to rotate the prior claim token nor a durable copy of the post-destruction
aggregate, release lifecycle, and exact issued envelope. Treating the request
as new would rerun hidden tasks; treating every in-flight record as failed
could orphan a release already referenced by a committed result.

### Decision

Add a provider-termination-authorized claim-recovery protocol to the durable
one-use ledger. Every claim records its controller-instance commitment and
monotonic epoch. Recovery binds the request, disposition attestation, prior
claim-token hash, prior/successor controller commitments, claim epoch, and the
exact recovery-record hash. A trusted cloud authority must return a
content-bound authorization containing a provider termination-attestation
commitment. The ledger validates that binding, prevents authorization replay,
atomically rotates the claim token, and fences the predecessor. A missing,
changed, self-referential, or unavailable authorization fails closed.

Add an exact-query, evaluator-private post-destruction recovery store. After a
signed destruction receipt verifies, the broker stores the raw manifest and
receipt, canonical task-free aggregate, disposition, retention lineage,
behavioral lifecycle, and later the exact result envelope. Record hashes and
append-only revisions permit behavioral `none`, `prepared -> consumed`, or
`prepared -> finalized -> abandoned`; and result `open -> result-issued ->
completed` or a nonterminal state to `failed` after cleanup is durable.

The broker resolves this record before claim takeover. A resumed call never
allocates a panel, invokes the runner, derives from raw artifacts, or destroys
raw material again. It revalidates the destruction signature, reconciles
preparation finalization or abandonment, issues or verifies the exact
envelope, and inspects ambiguous ledger completion before orphaning anything.
A permanently orphaned release can never transition to a completed result.
Unknown release commitment, cleanup, record transition, or completion state
preserves the in-flight claim.

### Consequences

The recovery algorithm does not grant the optimizer access to the private
checkpoint or provider evidence. The mounted implementation inherits the
existing single-writer fence and provider-attested lock-recovery boundary and
exposes no enumeration method.

This source change does not implement or claim a concrete Daytona termination
attestor. The selected provider adapter must verify its own termination
evidence and supply the trusted authorization; the mounted recovery store must
also be lifecycle-registered by the concrete evaluator bootstrap. Protected
cloud tests must still demonstrate real provider termination, volume handoff,
lost acknowledgements, and predecessor fencing. No project code or tests were
executed on the Mac.

### Evidence

- `src/broker/ledger.ts`
- `src/broker/service.ts`
- `src/evaluator/release-recovery-store.ts`
- `src/cloud/mounted-volume-release-recovery-store.ts`
- `tests/broker/one-use-ledger.test.ts`
- `tests/broker/trusted-broker.test.ts`
- `tests/cloud/mounted-volume-state.test.ts`
- `PLAN.md`
- `TODO.md`

## ADR-0088 — Derive and sign candidate integrity from immutable Git evidence

- Date: 2026-07-26
- Status: accepted
- Supersedes: the hash-shaped candidate scan attestation in ADR-0083
- Superseded by: none
- Related plan: `PLAN.md` §4, §8.1, §8.3, §12

### Context

The correctness gate previously passed optimizer-declared changed paths and a
downloaded optimizer diff to an abstract integrity port. Its release-safe
receipt carried `scanAttestationHash`, but the gate only checked that this was
64 hexadecimal characters. There was no production port, no signature
verification, and no proof that paths, counts, modes, and diff bytes came from
the candidate commit rather than the optimizer's description of it.

The protected-fragment set creates a second boundary problem. It must take part
in the authoritative scan, but exposing its hashes through an optimizer-visible
artifact, query API, or signer request would enlarge the benchmark leakage
surface.

### Decision

Candidate integrity now has three distinct trusted roles:

1. A deny-all x86_64 cloud evidence runner uploads the exact candidate Git
   bundle and a content-addressed worker. The worker reconstructs the bundle in
   a temporary bare repository, proves the exact source commit/tree, exact
   candidate commit/tree, and a single direct parent, then derives the
   no-renames unified diff, changed paths, added/deleted counts, and before/after
   modes. It emits only the derived diff and a canonical content-hashed
   manifest.
2. A verifying artifact reader and a non-enumerable evaluator fragment source
   feed those bytes and a sorted, sealed hash catalog directly to
   `scanCandidate`. The catalog is never passed to the evidence runner,
   accounting authority, signing authority, correctness caller, or optimizer.
3. A purpose-specific Ed25519 authority signs a schema-v2 release-safe receipt.
   The receipt binds both declared and observed diff/path hashes, the bundle,
   manifest, line counts, modes, fragment catalog, v2 scanner policy, worker,
   execution receipt, hypothesis/candidate documents, and Git lineage. Only
   sorted violation codes leave the trusted port. The production correctness
   gate and mounted-volume record store independently recompute the content
   attestation and verify the pinned key.

A passing receipt requires the optimizer diff digest and declared path hash to
match the independently derived evidence. A mismatch becomes a normal
`DIFF_METADATA_MISMATCH` rejection. Malformed Git lineage, evidence, catalog,
signature, or accounting fails closed without producing a usable receipt.

The optimizer's proposal worker and the authoritative scanner now share the
same canonical `pi-candidate-integrity-v2` policy commitment. The trusted
scanner remains authoritative; the optimizer-side scan is only an early
rejection.

### Alternatives

- Trust optimizer-produced diff metadata after comparing only a digest.
- Let the scan port return an unsigned or hash-shaped receipt.
- Run Git derivation on the Mac or in the optimizer sandbox.
- Put fragment hashes in the optimizer plugin or general artifact registry.
- Release paths, lines, mode records, or per-fragment matches for debugging.

### Consequences

Candidate metadata substitution can no longer create a passing integrity
receipt, and a durable gate record cannot be reopened under an untrusted scan
key. Raw source evidence and benchmark-derived hashes stay out of feedback and
optimizer channels.

The worker artifact, private catalog material, signing/accounting authorities,
provider image, and public-key binding still have to be provisioned by the
protected cloud composition. Authored tests are not execution evidence: the
new worker, port, gate, and durable-store suites must run in protected cloud CI.
No project executable, package-manager, formatter, compiler, or test command
was run on the Mac.

### Evidence

- `scripts/candidate-integrity-worker.mjs`
- `src/cloud/trusted-git-candidate-integrity.ts`
- `src/integrity/candidate-scanner.ts`
- `src/orchestrator/correctness-gate.ts`
- `src/cloud/mounted-volume-correctness-gate-ports.ts`
- `src/cloud/production-optimize-runtime-factory.ts`
- `tests/cloud/trusted-git-candidate-integrity.test.ts`
- `tests/scripts/candidate-integrity-worker.test.ts`
- `tests/orchestrator/correctness-gate.test.ts`
- `tests/cloud/mounted-volume-correctness-gate-ports.test.ts`
- `PLAN.md`
- `TODO.md`

## ADR-0084 — Preserve one-use state on ambiguous behavioral finalization errors

- Date: 2026-07-26
- Status: accepted
- Supersedes: none
- Superseded by: none
- Related plan: `PLAN.md` §3.3, §8.1, §12

### Context

The behavioral release producer distinguishes a finalization failure proven
not to have committed from one whose commit disposition is unknown. The broker
previously treated an arbitrary error class as safe to consume unless it was
the producer's explicit `unsafe-to-consume` error. A transport failure, adapter
bug, or unnormalized provider exception thrown during `finalize` could
therefore burn the durable preparation and one-use evaluation even if the
private release had committed.

### Decision

The broker records whether behavioral finalization was attempted and whether
it returned normally. If the attempt throws, only
`TrustedBehavioralReleaseProducerError("known-not-committed")` is a proof that
cleanup and one-use consumption may proceed. Every other thrown value,
including an ordinary `Error`, is commit-ambiguous and preserves the
preparation and request for protected reconciliation. Errors occurring before
the finalization call, or after a normally resolved call, retain their
stage-specific handling.

### Alternatives

- Assume every unknown exception happened before commit.
- Require all implementations to normalize exceptions but leave the broker
  permissive.
- Consume the request while preserving only the preparation.
- Retry finalization immediately without a durable recovery protocol.

### Consequences

Integrity wins over availability at the transactional boundary. An adapter
that violates the normalized producer contract can stall a request but cannot
silently double-spend or erase a possibly committed release. ADR-0087 adds the
source-level durable recovery state machine; paid production still requires
the concrete provider-termination authority and protected provider-volume
tests. Cloud CI must run the authored recovery, explicit-non-commit, and
unknown-error fixtures before release.

### Evidence

- `src/broker/service.ts`
- `src/evaluator/behavioral-release-producer.ts`
- `tests/broker/trusted-broker.test.ts`
- `TODO.md`

## ADR-0085 — Construct the mounted evaluator transaction inside the fixed production runtime

- Date: 2026-07-26
- Status: accepted
- Supersedes: the preconstructed evaluator-service dependency in ADR-0072
- Superseded by: none
- Related plan: `PLAN.md` §3.3, §8.1, §10.1, §12

### Context

`createTrustedEvaluationService` already composed the narrow runner, raw
reader, policy resolver, canonical deriver, destruction boundary, behavioral
producer, result signer, and one-use broker. The protected production runtime,
however, accepted an already-constructed `TrustedEvaluationService` inside its
release-bundle options. Consequently it did not instantiate either
`MountedVolumeBehavioralPreparationStore` or
`MountedVolumeBehavioralPrivacyArtifactStore`, could not bind their writer
fences to the production composition owner, and had no in-process route from
the producer's atomic behavioral commit to the release-bundle reader.

Accepting the service as an executable dependency also weakened the fixed
composition claim: a caller could supply an implementation with the correct
surface while bypassing the reviewed production evaluator constructor. The
service did not appear as an optimizer port, but its construction and storage
lifecycle were still outside the authoritative runtime path.

### Decision

Add `ProductionMountedVolumeTrustedEvaluator`, a statically imported
production adapter whose constructor captures and freezes the typed evaluator
capabilities. Its exact top-level contract contains runner, retention,
destruction, Pi adapter, durable evaluator authorities, raw reader,
policy-provider, three purpose-specific key groups, and pristine hidden
privacy genesis. There is no module name, executable selector, task field,
panel field, grader field, or optimizer-provided extension point.

During protected runtime construction, after the cloud marker, volume
semantics, manifest, and independent dependency attestation have passed, the
adapter:

1. constructs the mounted private behavioral-preparation store and registers
   its close-once resource before any await;
2. constructs and immediately registers the mounted privacy/artifact store
   with the same owner;
3. calls `createTrustedEvaluationService` with those exact store instances;
4. overlays a non-enumerating behavioral artifact source on the governed
   cache-artifact source; and
5. returns only the narrow evaluator service and content-hash-only
   source/reader to the runtime factory.

The runtime factory no longer accepts `release.service`. It injects the
adapter-produced service into `ArtifactBackedEvaluationReleaseBundleService`
and exposes only the existing `evaluator.blind-broker` runtime port.
`optimizer.adapter` has no reference to the service, private stores, release
overlay, task catalog, or raw evaluator authorities.

The overlay delegates only `cache-attestation` queries to the governed
external artifact source. Behavioral release, evidence, failure-card, and
diagnostic-brief queries resolve only by the exact committed content hash in
the atomic privacy store. Returned references use a reserved trusted URI and
bind canonical bytes, byte length, and byte SHA-256; reads reconstruct and
recheck the same tuple. A missing or permanently orphaned behavioral commit
does not fall back to another registry.

The construction lifecycle wraps store registration in the factory's local
reverse-order cleanup stack as well as the outer composition owner. A later
release-service constructor failure therefore closes both private stores, and
the close-once wrappers make the owner's final drain safe.

### Alternatives

- Continue accepting an already-built evaluator service.
- Construct the two stores in the controller and pass them as runtime ports.
- Publish behavioral artifacts into a second registry after the atomic
  privacy transaction.
- Let a missing behavioral hash fall through to the general artifact source.
- Expose the store-backed reader to Claude Code or the optimizer MCP server.

### Consequences

The reviewed runtime now owns evaluator construction and reconstruction, and
the private transaction shares its lifecycle and mounted-volume fence with
the rest of the paid composition. There is one authoritative behavioral
artifact commit and no post-commit copy step. The optimizer still sees only
release-safe broker output.

This source change does not assert deployment readiness. Real trusted runner,
raw ingress/decryption/decoder, catalog/ledger, KMS key providers,
cache-artifact source, signature verifier, provider credentials, and signed
composition material remain external protected bindings. The paid control
entrypoint also remains intentionally locked until those authorities are
bound. Cloud CI and provider-volume crash-handoff evidence are still required;
no Node, package-manager, formatter, build, or test command was executed on
the Mac.

### Evidence

- `src/cloud/production-trusted-evaluator.ts`
- `src/cloud/production-optimize-runtime-factory.ts`
- `src/cloud/mounted-volume-behavioral-preparation-store.ts`
- `src/cloud/mounted-volume-behavioral-privacy-store.ts`
- `tests/cloud/production-trusted-evaluator.test.ts`
- `tests/cloud/production-optimize-runtime-factory.test.ts`
- `PLAN.md`
- `TODO.md`

## ADR-0089 — Cut the first runnable prototype to essential matched-loop work

**Date:** 2026-07-26

**Status:** accepted for MVP; supersedes conflicting MVP scope in earlier ADRs

**Owners:** operator and Dark Factory implementation

### Context

The earlier design grew toward a production research platform: multiple
promotion stages, twelve-task validation and shadow pools, extensive signing
authorities, crash-perfect recovery, several sandbox providers, custom image
publication, sequential statistical budgets, dashboards, and an official
full-benchmark path. Those controls may be useful later, but they delayed the
question the prototype actually needs to answer: can a blind cloud loop make
and credibly measure one general Pi harness improvement?

The operator explicitly directed the implementation to skip everything marked
safe to defer, finish only the essentials, stop, and present the protected
inputs required before any cloud or paid test. The operator also confirmed that
the Azure models are already deployed and the API key already exists; no Azure
deployment or configuration work is wanted.

### Decision

Adopt [PLAN §0](./PLAN.md#0-essentials-only-mvp-authority) as the authoritative
MVP scope. Older ADRs and plan sections remain historical design research but
do not create first-loop blockers where they conflict with this cut.

The essential experiment is:

1. Claude Code, using public family `claude-opus-5` through an existing
   Microsoft Foundry deployment alias, sees the Pi source and at most a prior
   task-free closed-vocabulary brief. Candidate creation occurs before task
   selection.
2. A trusted broker deterministically selects a hidden failure-weighted panel
   of five tasks, including one easy canary. Used tasks remain eligible; a
   consecutive-selection penalty and underexposure term oppose a permanently
   fixed panel.
3. Candidate and champion run the same five tasks for three repetitions in the
   same environment using Pi with public family `claude-opus-4-8` at `high`.
   A fully fresh cold-cache comparison is 30 trials.
4. Full-environment champion cache entries may screen. They cannot promote. A
   positive cache-assisted screen must refresh every cached champion cell so
   promotion rests on 15 fresh candidate and 15 fresh champion observations.
5. Repetitions are clustered by task for the decision. Promotion requires
   complete infrastructure-valid fresh evidence, a minimum aggregate effect,
   and the predeclared confidence rule.
6. A trusted sanitizer may use private task-aware diagnostics, but Claude
   receives only generic allowlisted category/tool-class/cause/intervention
   cards with coarse bands. Task names, prompts, paths, commands, arbitrary
   tool names, grader text, raw traces, and per-task outcomes remain private.
7. Promotion changes champion and causes a newly weighted panel on the next
   iteration. Reject or inconclusive retains the exact champion and sealed
   panel for the next attempt. No task is permanently removed from the pool.
8. Strict JSON is stored in a numbered experiment directory, with hidden
   selection/evaluation/cache material under a trusted-only `private/`
   subdirectory.

All executable work remains off the Mac. GitHub-hosted orchestration launches
isolated Daytona sandboxes on an explicit EU target. Foundry input is limited
to the existing Anthropic-compatible base URL, two existing deployment aliases,
and role-scoped protected references to the existing key. Secret values never
enter source, release artifacts, or chat.

The following are deferred and are not first-loop blockers:

- KMS/HSM and comprehensive signing fabric;
- crash-perfect recovery and exhaustive replay/handoff transactions;
- twelve-task and shadow/certification gates;
- providers other than Daytona EU;
- the full production role-image publication lifecycle; the secret-free
  combined MVP image preparation in ADR-0093 is the narrow exception;
- dashboards, PR automation, and automated publication;
- long-campaign alpha/privacy spending and other sequential statistics;
- the full 89-task/five-trial and official leaderboard path; and
- exhaustive supply-chain/production-composition hardening beyond minimum
  immutable pins and role isolation.

After essential source work is complete, implementation stops before any
credential or paid/test use. Work resumes only after the operator prepares or
anonymously verifies the public combined image; configures the protected GitHub
Daytona secret; Daytona EU target and volume references; role-scoped Foundry
and private-Git secret names; existing
Foundry URL and deployment aliases; private Pi source permissions; cloud-only
benchmark/Harbor pin discovery authorization; and a one-iteration cost cap,
then explicitly says `resume`. No secret value is requested in chat.

### Alternatives

- Finish the production-grade architecture before attempting one real
  iteration.
- Remove all privacy feedback and optimize only from aggregate score.
- Re-select a different panel after every rejected candidate.
- Compare raw candidate scores across different task subsets.
- Trust cached champion outcomes for promotion.
- Provision new Azure resources as part of the prototype.
- Run development and tests locally on the Mac.

### Consequences

The fastest credible experiment now has a visible boundary and a finite
operator-input list. Same-cell comparisons avoid declaring a winner merely
because it received easier tasks. Failure-weighted selection spends budget on
useful hard cases while the easy canary, panel rotation after promotion, task
re-eligibility, and task-free feedback reduce reward-hacking pressure. Cache
screening lowers cost without weakening the fresh-promotion rule.

The cut deliberately accepts fewer production assurances. A normal process or
provider interruption may need manual recovery; there is one provider; no
shadow certification exists; and the result is research evidence, not an
official leaderboard claim. These limitations are explicit and may be
revisited after the first real cloud iteration.

At acceptance time, the MVP cores, Foundry sanitizer, strict Harbor matched
planner/decoder, Daytona role-runtime edge, external Pi/Foundry binding, and
their Vitest specifications are source-ready but cloud-unverified. The cloud
entrypoint/role workers, real execution wiring, same-panel continuation state,
persistent cloud ports, cloud quality run, synthetic campaign, and live
matched iteration remain essential. No performance improvement is claimed
until a real candidate passes the fresh matched rule.

### Evidence

- `PLAN.md` §0
- `TODO.md` `MVP-ESSENTIAL`
- `CLOUD_DELIVERY.md` `Essentials-only MVP fast path`
- `README.md`
- `src/mvp/contracts.ts`
- `src/mvp/selection.ts`
- `src/mvp/decision.ts`
- `src/mvp/loop.ts`
- `src/mvp/privacy.ts`
- `src/mvp/sanitizer.ts`
- `src/mvp/schemas.ts`
- `src/mvp/store.ts`
- `src/mvp/cloud-config.ts`
- `src/mvp/daytona-runtime.ts`
- `src/mvp/harbor.ts`
- `tests/mvp/core.test.ts`
- `tests/mvp/loop.test.ts`
- `tests/mvp/cloud-config.test.ts`
- `tests/mvp/harbor.test.ts`
- `tests/mvp/sanitizer.test.ts`

## ADR-0090 — Use one direct, cloud-only execution path for the first loop

**Date:** 2026-07-26

**Status:** accepted for the essentials-only MVP; source remains
cloud-unverified

**Owners:** operator and Dark Factory implementation

### Context

The first loop needs a concrete route from one Claude-generated candidate to a
matched Harbor result. A dynamically supplied optimizer or evaluator runtime
would leave the most important behavior outside the reviewed source. It would
also make credential placement, hidden-task isolation, and readiness failures
ambiguous.

Daytona Secret placeholders are scoped to the sandbox in which Daytona issues
them. The outer evaluator needs its Foundry key to sanitize diagnostics and a
Daytona key to ask Harbor to create child task sandboxes. Each child task
sandbox needs a separately attached reference to the evaluated-model secret.
Copying the outer evaluator's Foundry placeholder into a child would not copy
the secret; it would replace the child's valid placeholder with an
unresolvable one.

Harbor 0.20.0 supports attaching Daytona Secrets to direct task sandboxes but
rejects that secret mechanism for compose/Docker-in-Docker tasks. The first
MVP must therefore know, privately and immutably, which exact task revisions
are compatible with its credential-isolated execution path.

### Decision

Use one statically imported implementation path:

1. The protected GitHub workflow builds the exact reviewed TypeScript source
   and stages one digest-checked controller bundle. No external optimizer or
   evaluator JavaScript module is accepted.
2. The launcher creates physically separate optimizer and evaluator Daytona
   sandboxes on the selected EU target, with disjoint persistent-volume
   subpaths. It relays only strict task-free optimizer input, candidate
   proposal, and release receipt objects.
3. The optimizer checks out the exact champion from the private Pi fork,
   invokes the pinned Claude Code version with Opus 5 at `high`, restricts its
   tools and changed paths, validates the task-free proposal, and publishes
   only the bounded candidate ref. Its Git authorization is an already
   Base64-encoded `x-access-token:<fine-grained-token>` value stored as a
   Daytona organization Secret and used only as an HTTPS
   `Authorization: Basic` header by the Git wrapper. Claude never receives it.
4. The evaluator reads an evaluator-private immutable runtime pin containing
   the exact Harbor, Terminal-Bench 2.1 dataset, adapter, environment, hidden
   task definitions, and direct-sandbox eligibility commitments. Absence,
   mismatch, or selection of an ineligible task returns a release-safe
   readiness block before Harbor starts.
5. A 256-bit catalog namespace is generated once inside the evaluator's
   mounted private state and reused there. It is not another operator-managed
   secret and never reaches the optimizer.
6. The evaluator Daytona sandbox is explicitly created and provider-attested
   as OS user `root` only so the trusted controller can protect its mounted
   `private/` tree as root-owned mode `0700`. Candidate and champion checkout,
   test, offline-build, and packaging work runs under two distinct
   unprivileged numeric UID/GID pairs in disjoint random temporary trees.
   Neither untrusted identity can traverse evaluator-private state or mutate
   the other arm.
7. The evaluator materializes exact single-parent candidate and champion Pi
   revisions, independently verifies the proposal paths and pinned source
   identities, and compiles the reviewed Pi runtime to a self-contained Bun
   executable. The trusted packager accepts only regular files, rejects links
   and special files, emits a deterministic manifest/archive with no `./`
   root member, and binds the build policy, source, tree, dependency lock, and
   Linux x64 glibc ABI. Child tasks therefore do not depend on a preinstalled
   Node runtime or a network installer.
8. The evaluator builds the strict Harbor five-task/three-attempt plan, runs
   Harbor, and converts only complete requested output into private
   observations. Raw Harbor output and task locators remain under
   evaluator-private mounted paths. Cache environment identity includes the
   canonical runtime-pin digest and full cloud configuration hash, so
   executable, dataset, adapter, image, endpoint, or role-configuration drift
   invalidates prior cells.
9. Harbor receives the *name* of the existing evaluated Foundry Daytona
   organization Secret in `environment.kwargs.secrets`. Daytona attaches a
   fresh `ANTHROPIC_FOUNDRY_API_KEY` placeholder to every direct child task
   sandbox. The Pi adapter deliberately omits that credential from its exec
   overrides and merely checks inside the child that the attached variable is
   present.
10. Harbor may run up to five trials concurrently while each individual Pi
   agent remains single-run. This preserves the exact 30-cell cold-cache
   comparison and its cost while reducing expected wall time.
11. The manual paid workflow permits exactly one iteration, always tears down
   both outer sandboxes, emits only a task-free receipt, and fails closed if
   the runtime pin, hidden catalog, task eligibility, source bundle, or other
   essential binding is absent.

The exact Terminal-Bench 2.1 revision and compatible hidden inventory are not
invented in source. They must be discovered and reviewed inside the trusted
cloud after the operator says `resume`. Initial task eligibility is therefore
limited to direct Daytona tasks that also pass the sealed Bun executable's
Linux x64 glibc compatibility smoke and attest Harbor's separate-verifier
mode. The separate verifier is mandatory; checking conventional paths such as
`/tests` and `/solution` inside the Pi adapter is only defense in depth. That
is an explicit prototype limitation and possible coverage bias, not evidence
about Pi quality. The official evaluation set remains external and unknown to
the optimization loop.

### Alternatives

- Load optimizer/evaluator runtime modules supplied beside the controller.
- Put optimizer and evaluator in one sandbox or one mounted subpath.
- Copy the outer evaluator's credential placeholder into child task commands.
- Allow compose tasks even though Harbor cannot attach the governed secret.
- Use an SSH key in the first MVP Git path.
- Run all 30 trials sequentially.
- Treat an absent runtime pin or unsupported task as a benchmark failure.

### Consequences

The first-loop implementation is smaller, auditable, and explicit about every
credential transition. The optimizer cannot mount hidden state, and the
evaluated Pi receives a usable model credential without the outer controller
learning or logging its value. Five-way concurrency improves prototype
turnaround without changing the statistical unit or promotion rule.

The MVP does not yet prove that the chosen public image contains every pinned
runtime dependency, that the exact Terminal-Bench 2.1 inventory has sufficient
direct-sandbox coverage, or that the TypeScript and Python adapters work
together in Daytona. Those are cloud-verification steps after the mandatory
stop. No executable command, package install, formatter, test, Harbor process,
Pi process, Claude session, or benchmark task is run on the Mac.

### Evidence

- `.github/workflows/mvp-cloud-verify.yml`
- `.github/workflows/mvp-paid-loop.yml`
- `scripts/mvp-optimizer-worker.mjs`
- `src/mvp/cloud-orchestrator.ts`
- `src/mvp/cloud-optimizer-worker.ts`
- `src/mvp/cloud-evaluator-worker.ts`
- `src/mvp/daytona-runtime.ts`
- `src/mvp/optimizer-worker.ts`
- `src/mvp/evaluator-runtime.ts`
- `src/mvp/evaluator-runtime-node.ts`
- `src/mvp/harbor.ts`
- `src/terminal-bench/assets/dark_factory_pi.py`
- `tests/mvp`
- `tests/terminal-bench/foundry-pi-adapter.test.ts`

## ADR-0091 — Close the MVP static-audit gaps without weakening the runtime boundary

**Date:** 2026-07-26

**Status:** accepted for the essentials-only MVP; source-complete and
cloud-unverified

**Owners:** operator and Dark Factory implementation

### Context

The final static audit found five issues that would either distort future
selection, waste the optimizer's bounded turns, allow configuration to fail
late, reuse an artifact across build-toolchain drift, or make the first cloud
quality gate predictably misleading.

First, private observations already recorded infrastructure validity, but the
catalog update still counted an infrastructure-invalid batch as behavioral
task evidence. Second, four inherited Claude skills described the larger
MCP-backed protocol and told the MVP optimizer to call tools that are
deliberately absent from its one-shot session. Third, the cloud configuration
parser and evaluation schema accepted different Foundry deployment-alias
grammars. Fourth, a compiled Pi runtime cache path named only the arm and Git
revision even though Bun, the image, build policy, runtime ABI, or packager
could change. Finally, executable Daytona/Harbor/OS adapter files cannot be
meaningfully exercised by isolated unit instrumentation, while counting them
as zero-covered lines would obscure the coverage of deterministic policy
cores.

### Decision

1. Update behavioral task history only when every candidate and final champion
   observation in the matched batch is infrastructure-valid. Persist invalid
   evidence for diagnosis, but do not let it change failure weights.
2. Make the four optimizer skills explicitly protocol-aware. In the
   essentials-only MVP they use the already-validated optimizer input, call no
   command/check/MCP tool, make one source edit, and end with exactly
   `hypothesisId`, `hypothesisSummary`, and `interventionSummary`. The trusted
   wrapper remains responsible for validation, Git publication, builds, and
   evaluation.
3. Use one conservative Foundry deployment-alias grammar at every MVP
   boundary: 1–128 lowercase alphanumeric characters grouped into segments
   separated by one `.`, `_`, or `-`. Reject uppercase, whitespace, `/`, `@`,
   `:`, edge separators, and adjacent separators during readiness rather than
   later during evaluation.
4. Name and validate every compiled Pi runtime artifact with a canonical build
   runtime digest. The digest binds the Bun executable hash, fixed Bun Linux
   baseline target, build-policy hash, Linux x64 glibc ABI, evaluator image
   and architecture, plus the actual packager hash and byte length. The strict
   runtime manifest is version 2 and stores the same digest.
5. Keep the 90% unit threshold unchanged for deterministic source, but
   explicitly exclude only the executable MVP cloud/controller/worker and
   evaluator runtime boundary files listed in `vitest.config.ts`. This is not
   a test waiver: a no-model synthetic iteration and bounded connectivity
   smoke are mandatory before any paid iteration, and their receipts are the
   acceptance evidence for Daytona creation, OS identity switching, process
   termination, secret placeholders, Harbor nesting, and artifact handoff.

### Alternatives

- Count infrastructure failures as ordinary task failures.
- Let Claude discover that the inherited tools are absent during its paid turn.
- Accept every Azure deployment-name character and weaken the strict JSON
  schemas.
- Clear runtime artifacts manually whenever the image or compiler changes.
- Lower the global coverage percentage silently or pretend mocked unit calls
  prove provider and OS behavior.

### Consequences

Task selection remains behavioral rather than infrastructure-driven. Claude's
limited Opus turn budget is spent on source reasoning and one intervention.
Deployment aliases fail consistently and early. A cached Pi binary cannot
survive a relevant compiler, image, ABI, policy, or packager change. The
coverage exception is narrow, visible, and paired with a stronger environment
test; until those cloud tests pass, the corresponding adapters remain
explicitly cloud-unverified.

No project command, formatter, build, test, model, Harbor process, Pi process,
or benchmark task was run on the Mac while making this decision.

### Evidence

- `src/mvp/loop.ts`
- `tests/mvp/loop.test.ts`
- `claude-plugin/skills/analyze-diagnostic-brief/SKILL.md`
- `claude-plugin/skills/benchmark-integrity/SKILL.md`
- `claude-plugin/skills/form-falsifiable-hypothesis/SKILL.md`
- `claude-plugin/skills/modify-pi-harness/SKILL.md`
- `src/mvp/model-deployment.ts`
- `tests/mvp/model-deployment.test.ts`
- `src/mvp/evaluator-runtime-node.ts`
- `tests/mvp/evaluator-runtime-node.test.ts`
- `vitest.config.ts`
- `PLAN.md` §0.5
- `TODO.md` `MVP-ESSENTIAL`

## ADR-0092 — Fit the outer MVP roles within Daytona Tier 2

**Date:** 2026-07-26

**Status:** accepted for the essentials-only MVP; source-ready and
cloud-unverified

**Owners:** operator and Dark Factory implementation

### Context

The first source cut requested `4` vCPU, `8 GiB` memory, and `30 GiB` disk for
the optimizer, plus `8` vCPU, `16 GiB` memory, and `100 GiB` disk for the
evaluator. The operator's Daytona Tier 2 organization reports aggregate limits
of `100` vCPU, `200 GiB` memory, and `300 GiB` storage, but limits each non-GPU
container sandbox to `4` vCPU, `8 GiB` memory, and `10 GiB` disk. Daytona would
therefore reject both outer sandbox requests before any staged verification
could run. Aggregate sufficiency remains unproven until the hidden inventory
attests the resource needs of up to five concurrent child task sandboxes.

The evaluator uses the persistent volume for private durable state but creates
one temporary isolated Pi build tree at a time on the sandbox filesystem. The
smaller disk may be sufficient for the immutable image, controller bundle,
checkout, dependencies, tests, and compiled runtime, but source review alone
cannot prove that fit.

### Decision

1. Request `4` vCPU, `8 GiB` memory, and `10 GiB` disk for both the optimizer
   and evaluator outer sandboxes.
2. Include both exact outer profiles in the canonical cloud configuration,
   configuration hash, provider-attested specification, and task-free launch
   receipt so a resource change invalidates environment identity. Version the
   extended launch receipt as `dark-factory.mvp-cloud-launch.v2`.
3. Do not change Harbor child-task resources, timeouts, verifier isolation, or
   the evaluation environment pinned for candidate/champion comparison.
4. Require the private eligibility inventory to attest that every selected
   task's official child-sandbox resource request fits the current Daytona
   limits without reduction.
5. Add exact configuration, specification, SDK-boundary, and receipt tests for
   both roles.
6. Require the no-model cloud smoke to measure the immutable image, controller
   staging, and one-at-a-time Pi build working set under the 10 GiB ceiling.
7. Treat disk or memory exhaustion as a readiness block before paid evaluation.
   Do not compensate by weakening tests, build isolation, or benchmark task
   resources.

### Consequences

The two trusted outer sandboxes can be admitted by the operator's reported
current Daytona Tier 2 non-GPU limits without using a GPU class or requesting
a quota increase. This is an operator-specific limit observation, not a
universal Daytona tier contract. The evaluator has substantially less
temporary workspace and half the previous CPU and memory request, so build
time may increase and the first cloud smoke may prove the profile too small.
If that happens, the prototype must stop for an explicit resource or
architecture decision.

No project install, formatter, build, test, model, Harbor, Pi, or benchmark
command ran locally while making this change.

### Evidence

- `src/mvp/cloud-orchestrator.ts`
- `src/mvp/cloud-config.ts`
- `src/mvp/daytona-runtime.ts`
- `tests/mvp/cloud-config.test.ts`
- `tests/mvp/cloud-orchestrator.test.ts`
- `tests/mvp/daytona-runtime.test.ts`
- `PLAN.md` §0.3
- `TODO.md` `MVP-ESSENTIAL`
- `CLOUD_DELIVERY.md` `Essentials-only MVP fast path`

## ADR-0093 — Prepare one combined MVP runtime image in cloud

**Date:** 2026-07-26

**Status:** accepted for the essentials-only MVP; source-ready and
cloud-unverified

**Owners:** operator and Dark Factory implementation

### Context

The MVP launcher has one `DF_MVP_DAYTONA_IMAGE` input and uses it for both the
optimizer and evaluator outer sandboxes. The retained production Containerfiles
instead publish separate role images, use UID/GID `65532` as their default
identity, and do not put Claude Code, Harbor, and Bun in one image. They cannot
be reused for the MVP: `65532` and `65533` are the evaluator's isolated
candidate/champion build identities and must have no pre-existing owner,
service, or process.

No independently reviewed public image has yet been identified that satisfies
the exact hard-coded paths, Linux x64 glibc ABI, root override, unprivileged
optimizer, and reserved-identity requirements. Building such an image on the
Mac would violate the cloud-only boundary. A minimal GitHub-hosted preparation
path is therefore required before Daytona verification can resume.

### Decision

1. Add the workflow `.github/workflows/publish-mvp-runtime-image.yml`, named
   `publish-mvp-runtime-image`. It may be dispatched from `main` only with an
   exact source commit and confirmation `PUBLISH-MVP:<commit>`.
2. Read base-image, Buildx, BuildKit, Node, Claude Code, Harbor, Bun, Python,
   and system-package pins only from reviewed
   `containers/mvp-runtime-pins.json`. The dispatch accepts no operator-supplied
   mutable image or tool version.
3. Use protected environment `dark-factory-image-publish` with a required
   reviewer and no secrets or environment variables. The workflow receives no
   Daytona, Foundry, Git, model, benchmark, or paid credential.
4. Build one Linux/amd64 glibc image with default UID/GID `10001`. Daytona uses
   that default for the optimizer and explicitly overrides the evaluator to
   root. Reserve `65532:65532` and `65533:65533` exclusively for the two
   untrusted build arms.
5. Require Node 24 at `/usr/bin/node`, the fixed system paths in
   `CLOUD_DELIVERY.md`, Claude Code 2.1.217 at `/usr/local/bin/claude`, Harbor
   0.20.0 at `/usr/local/bin/harbor`, and Bun at `/usr/local/bin/bun`. Keep
   binaries and dependency trees root-owned and non-writable by unprivileged
   identities; bake no secret or project state.
6. Publish
   `ghcr.io/<repository>-dark-factory-mvp-runtime:<commit>-<run>-<attempt>` and
   emit artifact `dark-factory-mvp-runtime-<commit>` containing
   `image-output/mvp-runtime.json` and its adjacent SHA-256. The receipt binds
   source/workflow identity, Containerfile and pin digests, tagged and immutable
   references, manifest digest, base/builder pins, platform/ABI/size, exact
   executable versions, paths and hashes, identity checks, SBOM/provenance, and
   the offline smoke result.
7. Treat the receipt as review material, not pullability proof. After review,
   an operator makes that exact GHCR package public. A clean unauthenticated
   cloud client must then resolve or pull the immutable reference and observe
   the same digest.
8. Store only the full verified
   `ghcr.io/...@sha256:<digest>` reference as the ordinary GitHub repository
   variable `DF_MVP_DAYTONA_IMAGE`. Do not store it as a secret, use a tag, or
   add registry credentials to Daytona.

This is a narrow MVP exception to the deferred production role-image pipeline.
It does not launch Daytona, start a model, fetch private Pi, run Harbor or
Terminal-Bench, or authorize paid evaluation.

### Consequences

Both outer roles can consume one auditable image without reusing a reserved
build identity or relying on a mutable/private registry reference. Image
publication remains free of runtime secrets and paid workloads, and anonymous
digest verification proves Daytona can fetch the exact public object.

The image receipt does not prove the remaining runtime boundary. After
publication, work is still blocked on evaluator-private runtime-pin and hidden
catalog bootstrap, the no-model synthetic smoke, the bounded private-Git,
Foundry/Claude, Harbor, nested-Daytona, and Pi connectivity smoke, and explicit
authorization for the one paid iteration. The 10 GiB outer-disk fit also
remains cloud-unverified.

No project install, formatter, build, test, image build, model, Harbor, Pi, or
benchmark command ran locally while making this decision.

### Evidence

- `.github/workflows/publish-mvp-runtime-image.yml`
- `containers/mvp-runtime.Containerfile`
- `containers/mvp-runtime-pins.json`
- `.env.example`
- `CLOUD_DELIVERY.md` `Essentials-only MVP fast path`
- `PLAN.md` §0.3–0.8
- `TODO.md` `MVP-ESSENTIAL`
