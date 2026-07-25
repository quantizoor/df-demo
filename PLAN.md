# Dark Factory MVP Plan

## 1. Purpose and success criteria

Dark Factory is a local TypeScript control plane that continuously proposes,
tests, evaluates, and records changes to an open-source terminal-agent harness.
Its first target is Terminal-Bench 2.1, with Claude Code acting as the optimizer
and a fork of Pi acting as the harness under optimization.

The MVP is successful when it can run this loop unattended:

1. Ask a trusted cloud task broker for a small, informative, blinded task batch
   selected by deterministic failure-weighted priority.
2. Give Claude Code a task-agnostic, bounded evidence brief.
3. Require a falsifiable hypothesis before any edit.
4. Create an isolated Pi candidate worktree and let Claude edit it.
5. Run correctness and integrity gates in a cloud sandbox.
6. Compare the candidate and current champion on matched sandbox trials.
7. Sanitize and persist the evidence under strict schemas.
8. Promote, reject, or mark the candidate inconclusive.
9. Append a human-facing comparison to `FEEDBACK.md`.
10. Repeat until an operator interrupts the campaign.

The MVP does **not** need to claim state-of-the-art performance. It must produce
credible, reproducible improvement evidence while preventing task-specific
overfitting and grader leakage. The official 89-task, five-trial-per-task run
must never happen without a separate, explicit human authorization.

### 1.1 Benchmark contract

Every baseline lineage pins:

- Terminal-Bench 2.1 dataset revision and content digest.
- Harbor version.
- Pi upstream and fork commits.
- Claude Code version.
- Optimizer model and evaluated model, using exact identifiers rather than
  aliases.
- Sandbox provider, image digests, architecture, and resource configuration.
- Task timeouts and resources from the official benchmark.
- Dark Factory protocol, blind-broker policy, schema, sanitizer, and
  decision-policy versions.

The system must never:

- Modify Terminal-Bench graders, tests, resources, or timeouts.
- Expose graders, tests, solutions, verifier output, or solution artifacts to
  Claude Code.
- Expose the actual development, shadow, or final-evaluation task list,
  identities, instructions, or mappings to Dark Factory or Claude Code. The
  evaluated Pi process necessarily receives one task instruction transiently
  inside its isolated cloud sandbox; that instruction never returns.
- Supply task-specific hints or conditional task routing to the evaluated
  harness.
- Fetch published solutions or encode them into the harness.
- Count an infrastructure failure as a task failure.
- Compare results produced under different protocol hashes as if they were
  matched.
- Continue an existing baseline lineage after changing the evaluated model,
  benchmark, resources, or measurement semantics.

These constraints follow the official
[Terminal-Bench 2.1 protocol](https://www.tbench.ai/leaderboard/terminal-bench/2.1)
and
[leaderboard integrity policy](https://www.tbench.ai/news/leaderboard-integrity-update).

## 2. Locked technology and source decisions

### 2.1 Harness under optimization

Fork [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono) to
`quantizoor/pi-mono` and optimize its coding-agent package.

Pi is the starting point because it provides:

- An MIT-licensed TypeScript agent implementation.
- Headless print, JSON, and RPC modes.
- First-class extensions, skills, custom tools, system-prompt interception,
  compaction hooks, session events, and structured output.
- A relatively small, inspectable mutation surface compared with OpenCode and
  Cline.
- Existing Biome and Vitest usage.
- A pending/upstream Harbor integration path.

Agentic Harness Engineering remains methodological prior art for
evaluate/analyze/improve loops, falsifiable edits, and trace observability. Its
Python/E2B implementation and partially closed debugger will not become the
MVP foundation.

### 2.2 Dark Factory stack

- Node.js 24 or the current pinned Node 24 LTS release.
- TypeScript with `strict`, `noUncheckedIndexedAccess`, and ESM.
- pnpm with a committed lockfile.
- Vitest for tests and coverage.
- Biome for formatting, linting, and import organization.
- TypeBox plus Ajv for JSON Schema Draft 2020-12.
- Pino for structured JSON logs.
- Commander for the CLI.
- Node's built-in SQLite module for a disposable query index.
- Harbor as a pinned external evaluator dependency.

JSON files are the only source of truth. SQLite is a rebuildable acceleration
cache and may be deleted without losing evidence.

### 2.3 Sandbox policy

Implement a provider abstraction and begin with:

1. Daytona as the preferred backend for snapshots, Docker-in-Docker, VM
   isolation, and GPU classes.
2. E2B as a fast CPU and network-policy fallback.
3. Modal for large-memory and GPU/resource-heavy tasks.
4. No local execution backend. Synthetic fixtures, candidate builds/tests,
   Harbor, evaluated Pi processes, and benchmark tasks all run in cloud
   sandboxes.

Run a cloud compatibility probe before assigning work. A candidate/champion
pair must use the same provider, image, region class, resources, and protocol.
The Mac runs only the TypeScript orchestrator, Claude Code source-editing
session, local evidence persistence, and operator UI. It never executes
candidate code, Pi, Harbor, graders, benchmark tasks, or synthetic task
fixtures.

Primary references:

- [Harbor agent interface](https://www.harborframework.com/docs/agents)
- [Harbor ATIF support](https://www.harborframework.com/docs/agents/trajectory-format)
- [Pi extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Daytona snapshots](https://www.daytona.io/docs/snapshots/)
- [E2B sandbox creation and network controls](https://e2b.dev/docs/api-reference/sandboxes/create-sandbox)
- [Modal sandboxes](https://modal.com/docs/guide/sandboxes)

## 3. Trust boundaries and architecture

```text
Trusted cloud task broker
    |
    | task-agnostic weighted-batch attestation
    v
Claude Code optimizer
    |
    | hypothesis + isolated Pi worktree edit
    v
Cloud correctness and integrity gates
    |
    | candidate commit
    v
Trusted Harbor evaluator -> remote sandbox -> sealed grader
    |
    | trusted sanitization; raw grader artifacts discarded
    v
Strict experiment JSON + sanitized ATIF
    |
    v
Analysis -> promotion decision -> FEEDBACK.md -> next selection
```

### 3.1 Optimizer zone

Claude Code receives:

- One assigned Pi worktree.
- The Dark Factory plugin and its skills.
- Read-only, task-agnostic bounded evidence through MCP.
- The current hypothesis template and mutation policy.
- Tools that request focused Pi tests and static checks in a cloud sandbox.

Claude Code does not receive:

- Sandbox or Harbor credentials.
- The benchmark repository or job directory.
- Task names, task instructions, task mappings, graders, tests, verifier
  output, or reference solutions.
- GitHub credentials.
- Arbitrary access to the experiment store.
- WebSearch, WebFetch, or general internet access.
- A command or MCP tool capable of selecting tasks or starting a full run.

### 3.2 Controller zone

The TypeScript controller owns:

- Experiment numbering and lifecycle.
- Requests to the blind task broker using a frozen weighting policy.
- Git worktree, branch, commit, tag, restore, and publication operations.
- Claude Code process launch and permission configuration.
- Correctness and integrity gates.
- Evaluation requests and sandbox scheduling.
- Schema validation, sealing, indexing, analysis, and feedback rendering.
- Campaign stop and resume behavior.

### 3.3 Evaluator and task-broker zone

The trusted cloud evaluator and task broker own:

- Harbor and the pinned Terminal-Bench dataset.
- All task names, instructions, identities, pool membership, exposure history,
  and selection weights.
- Import of prior failure statistics from Dark Factory runs and a chosen
  comparable public leaderboard baseline.
- Deterministic weighted task ranking and opaque batch construction.
- The broker-private champion/baseline result cache, freshness policy, and
  drift-anchor scheduling.
- Sandbox credentials and lifecycle.
- Raw benchmark job output.
- Grader execution.
- Sanitization and grader-leak scanning.
- A task-aware diagnostic compiler that converts full trajectories into
  cross-task, task-agnostic failure cards.
- Creation of the minimal signed result envelope returned to the controller.

The evaluator is always remote, so task and grader files never land on the Mac.
Raw verifier output is temporary and is destroyed after sanitization. Before
release, the sanitizer removes task instructions, task-identifying paths,
commands, filenames, outputs, URLs, and identifiers from trajectories. The
controller stores only reward, status, timing, costs, resource data,
task-agnostic behavioral features and bounded redacted excerpts, failure
classification derived without grader details, and an attestation.

The diagnostic compiler is the feedback firewall between task-aware evaluation
and task-blind optimization. It may inspect the full task and trajectory inside
the trusted cloud zone, but it releases a failure card only after the same
behavioral pattern appears across at least three distinct tasks. Dark Factory
and Claude never receive the contributing task identities or individual raw
traces.

### 3.4 Human zone

Only the operator may:

- Authenticate GitHub or sandbox providers.
- Add or rotate secrets.
- Change the frozen benchmark contract.
- Approve an architectural policy change.
- Authorize the official full evaluation.
- Override a promotion decision, with a recorded reason.

## 4. Repository and Git design

`df-demo` is the Dark Factory control plane and local evidence store. The Pi
fork is a separate nested clone or registered submodule under a vendor area;
candidate worktrees live outside the clean clone.

Implementation sequence:

1. Repair the currently invalid `gh` authentication for `quantizoor`.
2. Fork `badlogic/pi-mono` to `quantizoor/pi-mono`.
3. Clone the fork and register the original repository as `upstream`.
4. Pin the initial upstream commit and dependency lock hash.
5. Create an immutable baseline tag for experiment `000`.
6. Create one local branch and worktree per candidate.
7. Start every candidate from the current champion commit.
8. Let Claude edit only the candidate worktree.
9. Let the controller create commits only after required checks pass.
10. Push sealed experiment branches and accepted champion tags without force.

If GitHub is unavailable, the experiment may seal locally with
`publishStatus: "pending"`. Publication retries later and never changes the
experiment decision.

Every experiment records:

- Upstream, fork, baseline, parent, and candidate commit SHAs.
- Git tree SHA and dependency lock hash.
- Canonical patch SHA-256 and changed file list.
- Mutation category and size.
- Local and remote branch/tag references.
- Publication attempts and final status.

Large sanitized traces, derived query caches, and experiment folders remain
local and are ignored by the control-plane Git repository. The task-keyed
champion/baseline result cache remains exclusively in the trusted cloud broker;
only its task-agnostic attestation is stored locally.

## 5. Experiment lifecycle

Experiment directories use a monotonic number and short kebab-case description:

```text
experiments/
  000-pi-baseline/
  001-change-system-prompt/
  002-improve-command-recovery/
```

The lifecycle is:

```text
planned
  -> candidate-ready
  -> tested
  -> evaluating
  -> analyzed
  -> promoted | rejected | inconclusive
  -> sealed
```

Rules:

- An experiment becomes a possible parent only after sealing.
- Rejected and inconclusive experiments are sealed and preserved.
- A promoted experiment atomically moves the champion pointer.
- A rejected experiment leaves the champion pointer unchanged.
- The hypothesis and predicted effects are immutable before evaluation starts.
- Corrections to sealed evidence use a hash-linked amendment; sealed files are
  never rewritten.
- Each sealed experiment creates exactly one `FEEDBACK.md` entry.

### 5.1 Atomicity and interruption

All writes use temporary files, schema validation, fsync, and atomic rename.
Sealing verifies every referenced artifact and writes a final hash-chain entry.

On SIGINT or SIGTERM:

1. Stop scheduling new trials.
2. Cancel or drain active sandbox work.
3. Persist already completed, valid trial envelopes.
4. Mark the in-flight attempt interrupted.
5. Do not update the champion.
6. Exit after the controller journal is durable.

On resume:

1. Validate the complete experiment hash chain.
2. Locate the last fully sealed experiment and champion.
3. Archive the interrupted attempt for audit.
4. Restore a clean worktree from the sealed champion.
5. Allocate a new experiment number; numbers are never reused.
6. Continue the indefinite optimization campaign.

There is no campaign-level experiment, wall-clock, or cumulative cost limit.
Each official task timeout still applies, and the staged evaluation policy
bounds the work spent on one hypothesis. The status and feedback surfaces show
cumulative trials, tokens, model cost, sandbox cost, and wall time.

## 6. Evidence store and schemas

Use JSON Schema Draft 2020-12. Every persisted JSON object has:

- `schemaVersion`
- RFC 3339 UTC timestamps
- `additionalProperties: false`
- Explicit enums and nullable fields
- Provenance references
- Canonical JSON serialization
- SHA-256 content hash

Each experiment contains:

```text
experiment.json
hypothesis.json
candidate.json
evaluation-plan.json
results.json
cache-attestation.json
failure-cards.json
analysis.json
decision.json
attestation.json
feedback-entry.json
events.jsonl
trials/
  <trial-id>/
    trial.json
    trajectory.atif.json
    metrics.json
```

### 6.1 `experiment.json`

Stores identity, experiment number, slug, lifecycle state, parent experiment,
baseline lineage, champion before/after, timestamps, protocol hash, publication
state, and final disposition.

### 6.2 `hypothesis.json`

Stores:

- Evidence query references.
- Observed failure pattern.
- Causal claim.
- Proposed intervention.
- Expected affected harness components.
- Predicted gains and regressions.
- Generality justification.
- Falsification criteria.
- Rollback condition.

### 6.3 `candidate.json`

Stores commits, patch hash, changed files, mutation size, test results, integrity
scan findings, and whether all candidate gates passed.

### 6.4 `evaluation-plan.json`

Stores blind-broker and weighting-policy versions, an opaque batch attestation,
task-count and difficulty-band summaries, pair ordering, expected cost,
evaluation stages, valid-arm, retry, baseline-maintenance, total-attempt, and
cost ceilings, reuse decisions, and stopping rules. Actual assignments, task
identities, instructions, selection weights, exposure counts, and pool
membership remain exclusively in the cloud broker vault and are never returned
to Dark Factory.

### 6.5 Trial files

`trial.json` stores a one-use opaque trial handle, arm, repetition, timestamps,
environment identity, completion status, difficulty band, and artifact hashes.
The handle cannot be correlated across experiments by Dark Factory.

`trajectory.atif.json` stores the sanitized Agent Trajectory Interchange Format
record.

`metrics.json` stores reward, latency, tokens, cost, tool counts, failure class,
resource usage, and infrastructure validity.

### 6.6 Results, analysis, and decision

`results.json` stores paired candidate/champion comparisons, available matched
baseline comparisons, uncertainty, gains, regressions, invalid trials, cost,
latency, and separate cached-screening versus fresh-confirmation counts.

`cache-attestation.json` stores the broker's task-agnostic proof of cache
eligibility and use: cache-policy version, exact protocol hash, aggregate cache
hit and screening-reuse counts, freshness age bands, fresh drift-anchor count,
drift status, invalidated count, retained fresh candidate-arm count, newly
completed champion-arm count, sealed-window bounds, retry count, and the number
of fresh promotion pairs. It contains no task keys, identities, mappings,
cohort join keys, or per-task cache entries. Its canonical hash is bound into
the broker's signed result envelope.

`failure-cards.json` stores the validated cross-task behavioral clusters
released by the diagnostic compiler. It contains no task identity, instruction,
stable trial handle, raw command, raw output, path, filename, URL, or grader
content.

`analysis.json` records whether evidence supports the hypothesis, the observed
failure-card references, unexpected effects, and follow-up recommendations.

`decision.json` records promotion state, policy thresholds, machine rationale,
champion transition, and any human override.

`attestation.json` records schema checks, artifact checksums, pinned versions,
grader-leak scan status, and the sealed hash-chain entry.

`feedback-entry.json` is the structured source from which `FEEDBACK.md` is
appended and rebuilt.

### 6.7 Events and index

`events.jsonl` is append-only and validates each record independently. It
captures lifecycle transitions, evidence queries, tool requests, trial events,
publication attempts, and operator actions.

A local SQLite index supports fast evidence queries. It is derived entirely
from validated JSON, contains no exclusive information, and is rebuilt by a
CLI command.

## 7. Blind task selection and evaluation economy

Neither Dark Factory nor Claude selects or learns the actual tasks. A trusted
cloud task broker owns task identity, instructions, history, and selection.
Dark Factory submits only the frozen policy version, changed-component
taxonomy, requested evaluation stage, and resource ceiling. The broker returns
an opaque batch attestation and later task-agnostic results.

The broker maintains three deterministic, secret pools:

- **Development:** hard and diagnostically useful tasks.
- **Rotation:** underexposed tasks and capability-diversity coverage.
- **Shadow:** rarely used independent promotion pressure; Dark Factory and
  Claude receive only aggregates from this pool.

Initial task estimates come from public non-solution metadata, per-task failure
rates for the chosen comparable baseline agent on the public leaderboard when
available, and the broker's own baseline runs. As evidence accumulates, the
broker scores each eligible task using:

- Smoothed failure probability from previous champion and baseline runs.
- Failure rate of the chosen comparable leaderboard baseline.
- Outcome uncertainty.
- Ability to discriminate configurations.
- Relevance to the changed harness component.
- Underexposure.
- Missing capability coverage.
- Predicted model and sandbox cost.
- A recent-repetition penalty.

Selection is deterministic, not pseudorandom. Build each batch with fixed
quotas:

- 60% failure-weighted hard tasks, prioritizing tasks failed by earlier
  champion/baseline runs and by the selected comparable leaderboard baseline.
- 20% uncertain or configuration-discriminating tasks.
- 10% easy integrity canaries that detect reward hacking and broad regressions.
- 10% underexposed capability coverage.

Within each quota, use a stable descending priority score and deterministic
round-robin tie-breaking based on exposure age. Every task has a nonzero
eligibility floor, but easy tasks receive lower normal weight. Do not select a
task in more than two consecutive experiments unless it is a declared
regression canary. Infrastructure-invalid and non-discriminating tasks lose
priority. Hard but potentially solvable tasks receive priority over impossible
or broken tasks.

Dark Factory receives no task list, name, persistent pseudonym, instruction,
mapping, or selection score. One-use trial handles exist only to join the
sanitized envelope within one experiment.

### 7.1 Matched staged racing

Every evaluated task compares candidate and current champion under the same
protocol. Use deterministic counterbalancing (AB/BA alternation by pair index
and experiment parity) so execution order is balanced without pseudorandom
task or arm selection. Before any arm runs, the broker seals all twelve hidden
task slots, their strata, stage assignment, and pair order. Stages reveal no new
task choice and are only a cost-saving execution schedule, so favorable early
outcomes cannot choose the confirmation set.

1. **Smoke:** four tasks. In an AB slot, run the candidate first and permit an
   eligible cached champion distribution for screening. In a BA slot, run the
   champion fresh first, use it as a cache drift anchor when applicable, then
   run the candidate.
2. **Challenge:** four additional tasks spanning hard, underexposed, and
   regression strata under the same sealed AB/BA rule.
3. **Confirmation:** complete a fresh candidate/champion pair for every
   qualifying smoke/challenge task and use the remaining budget for up to four
   presealed, disjoint confirmation tasks. A candidate arm already run inside
   the same sealed evaluation window may be retained; a cached champion arm may
   not, so the broker runs the missing champion arm. Outcome-driven repeats are
   not permitted. The final twelve fresh pairs remain evenly AB/BA
   counterbalanced.

With four cache hits, smoke may reject after six valid arms: four candidate
arms and the two fresh BA champion arms. With no eligible cache, smoke requires
eight valid arms. Challenge raises those cumulative figures to twelve and
sixteen. A promotion attempt uses exactly 24 valid candidate/champion arms to
assemble twelve fresh pairs. Fresh drift anchors overlap these champion arms;
they do not create an unpaired add-on.

Allow at most one infrastructure-invalid replacement for an affected arm and
no more than four replacement attempts across the experiment. Separately allow
at most two experiment-`000` baseline-maintenance attempts, including invalid
attempts. The resulting evaluator ceiling is 30 task attempts: 24 valid
candidate/champion arms, four infrastructure replacements, and two baseline
maintenance attempts. Record the expected and maximum evaluator/model/sandbox
cost before execution and stop as `inconclusive` rather than cross the sealed
ceiling. Correctness-gate sandboxes have their own predeclared budget.

Any higher attempt, pair, retry, baseline-maintenance, or cost budget requires a
versioned policy change and new baseline lineage.

A fresh pair means both arms were executed during the same broker-issued,
sealed experiment window, no more than 24 hours apart, with identical protocol
hash and compatible environment fingerprints. If the window expires or the
environment cohort changes, rerun the affected pair.

Smoke can reject or advance but cannot promote. Promotion requires:

- Exactly twelve valid **fresh** matched comparisons across at least two
  strata.
- Confirmation-stage evidence.
- A paired Dirichlet-Jeffreys analysis over the four binary outcomes
  `(both-pass, candidate-only-pass, champion-only-pass, both-fail)`, computed
  separately by stratum and combined with the presealed stratum weights.
- `P(weightedAccuracyDelta > 0) >= 0.95` and posterior median weighted accuracy
  delta of at least `0.05`, using deterministic quadrature.
- No stratum with `P(stratumAccuracyDelta < -0.10) > 0.80`.
- No hard integrity or correctness failure.
- No material capability regression.
- Cost and latency inside the frozen lineage guardrails, unless a predeclared
  accuracy trade-off policy applies.

If the evidence remains ambiguous after the maximum stage, mark the candidate
`inconclusive`; do not promote the observed winner by default.

Newly selected tasks lacking a compatible experiment-`000` observation enter a
broker-private baseline-maintenance queue. The broker backfills or refreshes at
most two such observations per experiment and returns the aggregate comparison
only on the valid matched intersection; missing coverage is reported, not
silently imputed. Baseline maintenance never affects candidate promotion. No
task identity or cross-experiment mapping accompanies these aggregates.

### 7.2 Champion result cache

The cloud broker stores champion and baseline outcome distributions so repeated
tasks do not always require another incumbent run. The cache remains entirely
inside the trusted broker because its keys include hidden task identity.

The complete cache key is:

```text
hidden task revision/content digest
+ harness commit and configuration hash
+ exact resolved model and model-provider version
+ reasoning, sampling, and context settings
+ dataset and Harbor versions
+ sandbox provider, image, architecture, resources, and region class
+ network policy
+ Dark Factory protocol hash
```

Each cache entry stores a distribution rather than a single truth:

- Valid attempts, passes, failures, partial rewards, and invalid attempts.
- Pass rate, reward mean, variance, and confidence.
- First/last observation timestamps and freshness.
- Latency, token, tool-use, and cost distributions.
- Environment fingerprints and observed drift.

Cache observations are immutable and append-only. Accept only evaluator-signed,
schema-valid, infrastructure-valid observations, deduplicate them by signed
attempt digest, and expose no external cache write or invalidation API.
Rejected-candidate observations remain keyed to that candidate and cannot be
read through the current-champion role. Promotion atomically authorizes the new
champion commit. Encrypt the broker cache at rest and restrict record-level
access to the broker service identity; operators and controller credentials
receive only aggregate administrative health data.

Any cache-key difference is a hard miss. Apply freshness to each observation,
not merely the entry's latest timestamp; recompute distributions only from
eligible observations. A new observation never refreshes an older one. Entries
with incompatible environment fingerprints cannot substitute for a current
champion result. Require at least one valid observation, and classify a
distribution as too uncertain for reuse when its 95% Jeffreys credible interval
is wider than `0.90`.

For the MVP, the maximum cache age is seven days. Report entries in `0-24h`,
`1-3d`, and `3-7d` bands; entries older than seven days are ineligible. The
policy may shorten eligibility when provider or environment fingerprints are
weak. Changing the ceiling or bands changes the cache-policy version and
protocol hash. When eligible observations span bands, label the distribution
with its oldest included observation's band; never make a mixed-age
distribution appear fresher than its evidence.

The primary screening outcome is binary pass/fail; partial reward remains
diagnostic and cannot turn a failure into a pass. For task `i`, construct
Jeffreys posteriors from the fresh candidate observation,
`Beta(candidatePassesᵢ + 0.5, candidateFailuresᵢ + 0.5)`, and the task's
eligible cached champion observations,
`Beta(championPassesᵢ + 0.5, championFailuresᵢ + 0.5)`. Combine tasks with
equal weight inside each required stratum, combine strata with the presealed
weights, and compute the posterior of candidate-minus-champion accuracy by
deterministic quadrature. Smoke or challenge may reject only when
`P(accuracyDelta <= -0.10) >= 0.95`; otherwise it advances or remains
inconclusive only for invalid evidence or exhausted budget. Thresholds and
numerical tolerances are frozen in the protocol and calibrated on synthetic
data before baseline initialization.

Use the cache in two tiers:

1. **Screening:** smoke/challenge may run the candidate alone and compare it
   with eligible cached champion distributions. Cached evidence may reject,
   deprioritize, or advance a candidate, but it can never promote one.
2. **Confirmation:** every promotion candidate completes a fresh candidate and
   current-champion pair on the same hidden tasks in the same evaluation
   window. A candidate arm from smoke/challenge may count if it satisfies the
   fresh-pair definition; a cached champion arm never counts. Only completed
   fresh pairs count toward the minimum promotion evidence.

Define a drift cohort by every non-task cache-key field plus freshness band,
difficulty stratum, and capability stratum. Within each nonempty cache-hit
cohort, select
`max(1, ceil(0.25 * cacheHitCount))` fresh champion anchors, prioritizing sealed
BA slots, then descending staleness, exposure age, and the broker-private task
digest. If BA slots are insufficient, run the missing champion arm in the next
eligible AB slot; that arm also completes a fresh pair.

For each anchor, obtain the cached posterior-predictive pass probability `pᵢ`
and fresh outcome `yᵢ`. Compute
`S = -sum(log(yᵢ * pᵢ + (1 - yᵢ) * (1 - pᵢ)))` and its exact tail probability
by enumerating the cohort's independent Bernoulli outcomes. Fail drift when
that probability is at most `0.01`, or immediately on a provider/environment
fingerprint mismatch. A failure invalidates all otherwise eligible
observations in that exact cohort and forces fresh comparisons. Drift
thresholds, cohort fields, tie-breaking, and rounding are protocol-versioned.

The broker returns only `cache-attestation.json`: aggregate hit and
screening-reuse counts, freshness age bands, drift-anchor counts, invalidations,
arm and retry accounting, sealed-window bounds, and fresh-confirmation counts.
It never returns task keys, cohort join keys, or per-task cache records.

When a candidate is promoted, its fresh confirmation outcomes are already
stored under its commit and exact protocol key and become the initial cache for
the new champion. This changes no record key and exposes no task mapping.

This policy may create a false negative during cheap screening if an old
stochastic outcome is misleading, but it cannot create a false champion:
promotion always requires fresh matched evidence.

## 8. Anti-overfitting and benchmark integrity

Implement defense in depth.

### 8.1 Grader isolation

- Keep benchmark tests, graders, and raw Harbor job output only in the trusted
  evaluator.
- Copy no grader artifact into `df-demo`.
- Return a minimal signed result envelope.
- Destroy raw verifier output after sanitization.
- Scan trajectories and envelopes against grader/test canaries and content
  fingerprints before release.
- Record only match counts and pass/fail attestations, never matched content.

### 8.2 Evidence blindness

Perfect task secrecy and useful optimization feedback are in tension: any score
change reveals some information about the evaluated distribution. The boundary
is therefore **blindness to task identity and grader logic, not blindness to
harness behavior**.

The trusted diagnostic compiler:

1. Reads full task-aware ATIF, outcome, and environment data inside the cloud
   evaluator.
2. Extracts deterministic behavioral telemetry before any model-generated
   interpretation.
3. Optionally uses a task-aware diagnostic model inside the same trusted zone
   to map behavior onto an approved taxonomy.
4. Clusters equivalent patterns across tasks.
5. Releases a failure card only when at least three distinct tasks support the
   cluster.
6. Validates the card against its strict schema, task-identity leak scanner,
   grader canaries, and re-identification tests.

A failure card contains:

- A non-task-specific failure mode such as repeated-command loop, ignored
  nonzero exit, premature completion, missing verification, context loss,
  ineffective recovery, poor time allocation, or tool misuse.
- Cohort size, difficulty band, confidence, and prevalence.
- Counts and distributions for retries, tool categories, exit-status classes,
  token allocation, latency, stop reasons, and verification behavior.
- Aggregate successful-versus-failed and candidate-versus-champion contrasts.
- Likely affected harness surfaces, such as planning, tool-result
  interpretation, recovery policy, compaction, memory, or termination logic.
- A bounded excerpt expressed in typed concepts such as `build-command`,
  `dependency-error`, and `verification-step`, never raw task text.

A failure card never contains:

- Task names, instructions, repositories, mappings, or stable pseudonyms.
- Literal commands, arguments, paths, filenames, URLs, unique constants, raw
  outputs, expected outputs, or grader messages.
- A single-task or single-trial drill-down.
- Enough fields to join a cohort back to a public task.

Clusters supported by fewer than three distinct tasks remain broker-private
until the threshold is reached; Claude sees only the aggregate score contribution.
Show Claude aggregate failure cards before bounded excerpts. Require a
justification for every drill-down, and log the caller, filters, card
references, token volume, and result count. Keep all correlation, cohort
membership, exposure accounting, and shadow-task details inside the cloud
broker.

This gives Claude actionable evidence about generic harness weaknesses while
forcing its proposed changes to generalize across tasks.

### 8.3 Candidate integrity

Reject candidates containing:

- Task names or instruction fragments.
- Test, grader, verifier, solution, or reference paths.
- Published solution URLs.
- Encoded or encrypted lookup payloads.
- Task/environment fingerprints used for conditional behavior.
- Benchmark-specific answer tables or suspicious large constants.
- Unapproved network/search tools.
- Changes to task resources, timeouts, or evaluator configuration.

Also:

- Keep mutations small and prefer one causal harness change per experiment.
- Require cross-task justification.
- Freeze predictions before evaluation.
- Run an integrity judge over every passing trajectory.
- Log evaluated-agent network egress.
- Run regression and generality checks before promotion.
- Use shadow and confirmation pools to reduce winner's curse.
- Version every policy change and rebaseline when it changes measurement.

## 9. Claude Code plugin and MCP

Create a project-local Claude Code plugin.

### 9.1 Skills

- `dark-factory-workflow`: lifecycle, boundaries, and allowed actions.
- `form-falsifiable-hypothesis`: causal claim, predicted effects, and rollback.
- `query-experiment-evidence`: minimum-relevant-evidence retrieval.
- `analyze-failure-cards`: cross-task behavioral analysis without task or
  grader inference.
- `modify-pi-harness`: Pi architecture, extension points, and test commands.
- `statistical-decision-making`: paired results and uncertainty.
- `benchmark-integrity`: contamination, overfitting, and reward-hacking rules.
- `document-decisions`: experiment records and ADR references.

### 9.2 Read-only MCP tools

- `df_get_campaign_context`
- `df_query_experiments`
- `df_get_aggregate_failures`
- `df_get_failure_cards`
- `df_get_behavioral_excerpt`
- `df_get_component_history`
- `df_get_regressions`

### 9.3 Submission/request MCP tools

- `df_submit_hypothesis`
- `df_stage_candidate`
- `df_submit_analysis`
- `df_request_next_stage`
- `df_record_decision`

The MCP server enforces strict schemas, query limits, task-agnostic redaction,
access logs, and response token budgets. It exposes no arbitrary SQL, file
paths, shell, sandbox credentials, task selection, task identity, Harbor
invocation, grader access, or full-evaluation action.

### 9.4 Hooks and permissions

Claude hooks:

- Deny protected paths and suspicious commands before tool use.
- Deny WebSearch, WebFetch, uncontrolled curl/wget, and browser tools.
- Validate changed-file allowlists and mutation size.
- Submit focused Pi tests and Biome checks to a cloud sandbox after edits.
- Require a valid hypothesis before edits are accepted.
- Require a complete analysis before the optimizer session ends.
- Block commit, push, task selection, Harbor execution, benchmark changes, and
  full evaluation.

## 10. CLI and public interfaces

Implement these commands:

```text
df init
df doctor
df fork-harness
df sandbox probe
df baseline init
df optimize
df stop
df resume
df status
df experiment show <number>
df evidence validate
df store rebuild-index
df feedback rebuild
df full-eval prepare
df full-eval authorize <challenge>
df full-eval run
```

`df optimize` runs indefinitely until interrupted. `df stop` requests a
graceful durable stop. `df resume` always reconstructs state from sealed JSON,
not process memory or the disposable index.

### 10.1 Full-evaluation authorization

The full run is a separate execution path:

1. `df full-eval prepare` validates readiness and prints the aggregate 89x5
   scope, expected cost, pinned protocol, and a random challenge without
   revealing the task list.
2. The user runs `df full-eval authorize <challenge>` from an interactive TTY.
3. The short-lived authorization is stored outside Claude's filesystem scope,
   preferably in macOS Keychain.
4. `df full-eval run` consumes the authorization once and runs the official
   protocol.

Refuse authorization or execution:

- From a non-interactive process.
- From Claude Code, MCP, CI, or a background campaign.
- If the challenge, protocol hash, user confirmation, or TTL is invalid.
- If resources or timeouts differ from the benchmark.

The optimizer plugin contains no reference to the authorization mechanism.

## 11. Feedback and decision documentation

Every sealed experiment appends one generated entry to `FEEDBACK.md` containing:

- Experiment number, hypothesis, mutation, and candidate commit.
- Comparison with the parent champion.
- Comparison with the immediately previous experiment.
- Comparison with experiment `000` on the valid matched intersection.
- Accuracy delta, uncertainty, valid-pair count, and provenance distinguishing
  fresh promotion, fresh partial, cached screening, and historical evidence.
- Gains, regressions, invalid trials, cost, latency, and cumulative spend.
- Capability coverage and task exposure without leaking identities to Claude.
- Integrity result.
- Promote, reject, or inconclusive decision.
- Recommended next direction.
- Hash reference to `feedback-entry.json`.

`FEEDBACK.md` must be deterministically rebuildable.

`documentation.md` is an append-only ADR journal for material architectural and
policy decisions. Every ADR records ID, date, status, context, decision,
alternatives, consequences, evidence, and superseding decision. Experiment
choices belong in experiment JSON; material platform or policy choices require
an ADR. Sealed decisions are superseded, never edited away.

## 12. Testing strategy

All test commands, builds, fixtures, candidate execution, and evaluator
processes run in cloud CI or a cloud sandbox. The Mac may author files and
orchestrate requests, but it is not a test or workload execution target.

### 12.1 Unit tests

Cover schemas, state transitions, broker-policy requests, diagnostic
compilation, minimum cohort enforcement, cache keys, cache invalidation,
freshness and drift, staged racing, statistics, cost aggregation, sanitization,
diff scanning, protocol hashes, feedback rendering, and authorization policy.

### 12.2 Contract and schema tests

- Validate positive and negative fixtures for every schema.
- Validate every MCP request and response.
- Validate positive and adversarial failure-card fixtures.
- Validate Harbor/ATIF adapters against pinned examples.
- Prove `additionalProperties: false` is enforced.
- Prove migrations preserve sealed evidence and hashes.

### 12.3 Property tests

Use generated cases to verify:

- Broker selection respects failure weighting, quota, easy-canary, exposure,
  and deterministic tie-breaking invariants.
- Cached evidence can affect screening but can never satisfy a promotion gate.
- Any cache-key difference invalidates reuse, and failed drift anchors force
  fresh comparisons.
- An eligible same-window candidate arm is retained exactly once, while an
  expired arm or cached champion arm can never satisfy a fresh pair.
- AB/BA ordering stays balanced when cached AB arms are completed later, and BA
  champion arms serve as drift anchors without changing their sealed order.
- Per-observation expiry prevents a fresh sample from extending stale evidence.
- The screening posterior and drift-tail calculation reproduce exactly from
  the same validated observations.
- Promotion schedules contain exactly twelve valid fresh pairs and no more than
  24 valid candidate/champion arms; invalid replacements obey their separate
  retry bound.
- Candidate/champion pairing never crosses protocol hashes.
- Hash chains detect mutation and truncation.
- Sealing and feedback append are idempotent.
- Interruptions cannot move the champion.
- Rebuilds produce the same SQLite index and feedback.

### 12.4 Integration tests

Use fake Claude, fake Harbor, synthetic tasks, and synthetic graders inside
cloud CI/sandboxes for:

- Promote, reject, and inconclusive paths.
- Cache-hit screening followed by fresh confirmation without a redundant
  candidate rerun.
- Cache miss, expiry, noisy-entry rejection, drift failure, cohort
  invalidation, and promoted-candidate cache seeding.
- Invalid infrastructure and rescheduling.
- Git publication pending/retry.
- Evidence queries and audit logs.
- Stop during each lifecycle state.
- Resume from the last seal.

### 12.5 Security tests

Test path traversal, symlinks, shell injection, inherited environment secrets,
grader canaries, encoded task names, malicious ATIF, oversized results,
solution URLs, forbidden network calls, authorization replay, non-TTY full-run
attempts, attempts to invoke Harbor from Claude, failure-card
re-identification, cohort differencing, and unique-literal leakage. Cache
attestation fixtures must reject task keys, per-record outcomes, stable join
fields, unsigned or protocol-detached data, and cross-experiment membership
reconstruction attempts. Cache poisoning, duplicate signed attempts, and
unauthorized invalidation must fail closed.

### 12.6 Provider tests

Each cloud sandbox adapter must pass the same lifecycle, cancellation, file
transfer, timeout, resource-reporting, network, and cleanup contract. Live paid
tests are disabled unless an explicit operator flag is set. There is no local
Docker or local execution adapter.

### 12.7 Quality gates

- At least 90% line and branch coverage for core controller modules.
- 100% branch coverage for grader isolation, sealing, protected paths, and
  full-evaluation authorization.
- Focused tests run at each implementation phase.
- Final CI runs typecheck, Biome, unit, contract, property, integration,
  security, and deterministic replay suites.

## 13. Implementation phases

### Phase 0: Governance and reproducibility

- Freeze terminology, benchmark contract, protocol hash inputs, threat model,
  and decision ownership.
- Create schema and ADR conventions.
- Define acceptance criteria and forbidden behaviors.

### Phase 1: Workspace and fork

- Create the TypeScript workspace and quality tooling.
- Repair GitHub authentication and fork Pi.
- Pin the baseline and implement worktree isolation.

### Phase 2: Schemas and durable store

- Implement all JSON schemas, canonical hashing, atomic writes, amendments,
  events, sealing, verification, and index rebuild.

### Phase 3: Lifecycle and Git controller

- Implement the state machine, candidate worktrees, commits, champion pointer,
  publication, interruption, and resume.

### Phase 4: Harbor and sandbox providers

- Pin Harbor.
- Implement the evaluator request/result contract.
- Add Daytona, E2B, and Modal provider adapters and probes.

### Phase 5: Trusted evaluation boundary

- Implement isolated grader execution, result sanitization, canary/fingerprint
  scanning, the cross-task diagnostic compiler, minimum cohort enforcement,
  failure-card schemas, attestation, raw artifact deletion, and adversarial
  re-identification tests.

### Phase 6: Pi integration and baseline

- Complete or maintain the Harbor Pi adapter.
- Verify headless operation and ATIF.
- Seal `000-pi-baseline` without running the official full benchmark.

### Phase 7: Blind broker and racing

- Create the cloud-only task catalog, failure-weighted deterministic broker,
  secret pools, one-use handles, exposure ledger, easy integrity canaries,
  capability strata, cost model, champion result cache, drift anchors, matched
  fresh confirmation, and staged stopping rules.

### Phase 8: Claude optimizer package

- Build the Claude Code plugin, skills, MCP tools, permissions, hooks, and
  evidence audit trail.

### Phase 9: Analysis, decisions, and feedback

- Implement paired analysis, regression checks, promote/reject/inconclusive
  policy, baseline comparisons, `FEEDBACK.md`, and deterministic replay.

### Phase 10: Autonomous operation

- Join the components into the indefinite optimization loop.
- Add status, graceful stop, restart, provider recovery, and publication retry.

### Phase 11: Integrity and full-run gate

- Complete reward-hacking defenses, trajectory integrity judging, protected
  paths, human authorization, TTY/TTL checks, and official-protocol validation.

### Phase 12: Validation

- Run synthetic end-to-end campaigns entirely in cloud sandboxes.
- Run a small real Terminal-Bench calibration campaign.
- Audit evidence, costs, interruption recovery, and generality.
- Leave the 89x5 run locked until the user explicitly authorizes it.

## 14. Operational assumptions

- The GitHub owner remains `quantizoor`; `gh` authentication is currently
  invalid and must be repaired before the fork step.
- Exact Pi, Claude Code, model, Harbor, dataset, and sandbox versions are chosen
  and pinned during initialization.
- Changing the evaluated model or measurement semantics creates a new baseline
  lineage.
- All builds, tests, synthetic fixtures, Pi executions, Harbor processes,
  graders, and benchmark tasks run in cloud sandboxes. Only orchestration,
  source editing, sanitized evidence, and operator controls run on the Mac.
- Only sanitized results are retained locally.
- Experiments may continue indefinitely, but the official full run is always
  human-gated.
- The canonical planning files are `PLAN.md`, `TODO.md`, `documentation.md`,
  and `FEEDBACK.md`; there is no `TASK.md`.
