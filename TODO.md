# Dark Factory MVP TODO

This is the execution checklist for [PLAN.md](./PLAN.md). An item is complete
only when its implementation, tests, documentation, and acceptance criteria
are all satisfied.

## DF-000 — Governance and benchmark contract

Reference: [PLAN §1](./PLAN.md#1-purpose-and-success-criteria),
[§3](./PLAN.md#3-trust-boundaries-and-architecture), and
[§8](./PLAN.md#8-anti-overfitting-and-benchmark-integrity).

- [ ] Record the Terminal-Bench 2.1 rules and prohibited behaviors.
- [ ] Define optimizer, controller, evaluator, and human trust zones.
- [ ] Define every input to the protocol hash.
- [ ] Define baseline-lineage invalidation rules.
- [ ] Define threat model and grader-leak response.
- [ ] Add the corresponding ADRs to `documentation.md`.
- [ ] Acceptance: a reviewer can determine whether any proposed run is
  comparable, valid, and permitted without making a new policy decision.

## DF-010 — TypeScript workspace and quality tooling

Reference: [PLAN §2.2](./PLAN.md#22-dark-factory-stack) and
[§12](./PLAN.md#12-testing-strategy).

- [ ] Initialize pnpm and commit the lockfile.
- [ ] Configure strict TypeScript ESM.
- [ ] Configure Vitest and coverage.
- [ ] Configure Biome.
- [ ] Add Pino, Commander, TypeBox, and Ajv.
- [ ] Define package/module boundaries.
- [ ] Add typecheck, lint, format-check, test, coverage, and CI scripts.
- [ ] Test a minimal CLI and schema-validation path.
- [ ] Acceptance: clean install plus all quality commands pass in cloud CI;
  implementation does not require running builds or tests on the Mac.

## DF-020 — Pi fork and Git workflow

Reference: [PLAN §2.1](./PLAN.md#21-harness-under-optimization) and
[§4](./PLAN.md#4-repository-and-git-design).

- [ ] Reauthenticate `gh` for `quantizoor`.
- [ ] Fork `badlogic/pi-mono` to `quantizoor/pi-mono`.
- [ ] Register fork and upstream remotes.
- [ ] Pin the initial upstream commit and lock hash.
- [ ] Implement clean clone and candidate worktree management.
- [ ] Implement experiment branches and champion tags.
- [ ] Ensure Claude receives no GitHub credentials.
- [ ] Implement pending publication and retry.
- [ ] Test restore, offline sealing, and non-force publication.
- [ ] Acceptance: any candidate and champion can be reconstructed from recorded
  Git identifiers without mutating another experiment.

## DF-030 — JSON schemas and evidence store

Reference: [PLAN §6](./PLAN.md#6-evidence-store-and-schemas).

- [ ] Define schemas for all experiment root files.
- [ ] Define the cross-task `failure-cards.json` schema.
- [ ] Define the task-agnostic `cache-attestation.json` schema.
- [ ] Define schemas for trial, ATIF, metrics, and event records.
- [ ] Enforce `additionalProperties: false`.
- [ ] Implement canonical JSON and SHA-256.
- [ ] Implement schema versioning and migrations.
- [ ] Implement append-only amendments.
- [ ] Implement atomic write helpers and file locks.
- [ ] Implement artifact checksum verification.
- [ ] Implement disposable SQLite index and rebuild.
- [ ] Add positive, negative, property, and corruption fixtures.
- [ ] Acceptance: the complete store rebuilds from JSON; mutation, truncation,
  malformed records, and broken references are detected.

## DF-040 — Lifecycle, sealing, stop, and resume

Reference: [PLAN §5](./PLAN.md#5-experiment-lifecycle).

- [ ] Implement the experiment state machine.
- [ ] Reject invalid state transitions.
- [ ] Implement monotonic experiment numbers.
- [ ] Implement atomic champion updates.
- [ ] Implement sealing and the experiment hash chain.
- [ ] Handle SIGINT and SIGTERM in every state.
- [ ] Archive interrupted attempts without reusing numbers.
- [ ] Restore from the last fully sealed champion.
- [ ] Test idempotent resume and repeated stop signals.
- [ ] Acceptance: fault injection at every write and lifecycle boundary cannot
  corrupt the last seal or incorrectly promote a candidate.

## DF-050 — Harbor and ATIF integration

Reference: [PLAN §2.2](./PLAN.md#22-dark-factory-stack),
[§3.3](./PLAN.md#33-evaluator-and-task-broker-zone), and
[§6.5](./PLAN.md#65-trial-files).

- [ ] Pin Harbor and record its version.
- [ ] Define the evaluator request/result protocol.
- [ ] Implement Harbor process/remote invocation behind an interface.
- [ ] Implement ATIF parsing and validation.
- [ ] Classify benchmark versus infrastructure outcomes.
- [ ] Preserve official resources and timeouts.
- [ ] Add fake-Harbor and pinned-fixture contract tests.
- [ ] Acceptance: a cloud synthetic task produces validated task-agnostic ATIF
  and an infrastructure error cannot be mistaken for reward zero.

## DF-060 — Sandbox providers

Reference: [PLAN §2.3](./PLAN.md#23-sandbox-policy) and
[§10](./PLAN.md#10-cli-and-public-interfaces).

- [ ] Define the common provider contract.
- [ ] Implement provider capability probes.
- [ ] Implement Daytona support.
- [ ] Implement E2B support.
- [ ] Implement Modal support.
- [ ] Prohibit and test the absence of a local execution backend.
- [ ] Run synthetic fixtures, candidate tests, and provider contracts in cloud
  sandboxes.
- [ ] Enforce provider parity within candidate/champion pairs.
- [ ] Record images, region class, resources, network, and costs.
- [ ] Implement cancellation, timeout, cleanup, and quarantine.
- [ ] Run the shared provider contract suite.
- [ ] Acceptance: the scheduler can select a compatible provider or explain why
  a task is unschedulable without changing benchmark requirements.

## DF-070 — Trusted evaluator and sanitizer

Reference: [PLAN §3.3](./PLAN.md#33-evaluator-and-task-broker-zone) and
[§8.1](./PLAN.md#81-grader-isolation).

- [ ] Separate evaluator credentials and filesystem from Claude.
- [ ] Keep raw benchmark jobs in the trusted zone.
- [ ] Implement minimal signed result envelopes.
- [ ] Strip verifier and grader output.
- [ ] Sanitize ATIF paths, secrets, and forbidden content.
- [ ] Implement deterministic task-aware telemetry extraction inside the
  trusted cloud zone.
- [ ] Implement the diagnostic compiler and approved failure taxonomy.
- [ ] Require at least three distinct tasks before releasing a failure card.
- [ ] Aggregate successful-versus-failed and candidate-versus-champion
  behavioral contrasts.
- [ ] Replace raw commands, outputs, paths, filenames, and literals with typed
  behavioral concepts.
- [ ] Implement grader/test canary and fingerprint scans.
- [ ] Implement task re-identification and cohort-differencing scans.
- [ ] Persist attestations without matched leak content.
- [ ] Delete raw grader output after sanitization.
- [ ] Add malicious-output and leakage tests.
- [ ] Acceptance: protected canaries and task-identifying literals cannot cross
  the evaluator boundary; no cohort below three tasks is released; and no
  grader artifact exists under `df-demo`.

## DF-080 — Pi adapter and experiment 000

Reference: [PLAN §2.1](./PLAN.md#21-harness-under-optimization),
[§4](./PLAN.md#4-repository-and-git-design), and
[§13](./PLAN.md#13-implementation-phases).

- [ ] Verify Pi headless JSON/RPC behavior.
- [ ] Complete or maintain the Harbor Pi adapter.
- [ ] Convert Pi sessions to valid ATIF.
- [ ] Pin Pi dependencies and default harness configuration.
- [ ] Run synthetic adapter tests in a cloud sandbox.
- [ ] Create and seal `000-pi-baseline`.
- [ ] Do not run the official full benchmark.
- [ ] Acceptance: experiment 000 is reproducible and usable as the immutable
  beginning for progressive matched baseline observations.

## DF-090 — Blind task broker, pools, and weighting

Reference:
[PLAN §7](./PLAN.md#7-blind-task-selection-and-evaluation-economy).

- [ ] Build the pinned task catalog only inside the trusted cloud broker.
- [ ] Import the selected comparable leaderboard baseline's per-task failure
  rates when available.
- [ ] Keep actual names, instructions, mappings, pools, weights, and exposure
  history out of Dark Factory and Claude.
- [ ] Create secret development, rotation, and shadow pools.
- [ ] Implement deterministic failure-weighted priority.
- [ ] Allocate 60% hard-failure, 20% uncertain/discriminating, 10% easy
  integrity-canary, and 10% underexposed-coverage slots.
- [ ] Give every task a nonzero eligibility floor.
- [ ] Implement deterministic exposure-age tie-breaking.
- [ ] Implement one-use, non-correlatable trial handles.
- [ ] Prevent Dark Factory and Claude from requesting, listing, or naming tasks.
- [ ] Add weighting, quota, determinism, blindness, and adversarial tests.
- [ ] Acceptance: identical broker history produces the same weighted batch,
  easy canaries continue to appear, and no returned artifact reveals the task
  list, identity, instruction, mapping, or pool membership.

## DF-100 — Staged racing and decision statistics

References: [PLAN §7.1](./PLAN.md#71-matched-staged-racing) and
[PLAN §7.2](./PLAN.md#72-champion-result-cache).

- [ ] Implement deterministic counterbalanced matched arm ordering.
- [ ] Preseal all twelve hidden task slots, strata, stage assignments, and AB/BA
  order before the first arm runs.
- [ ] Implement smoke, challenge, and confirmation stages.
- [ ] Bound experiments to twelve matched pairs by default.
- [ ] Seal valid-arm, retry, baseline-maintenance, total-attempt, and monetary
  ceilings in every evaluation plan.
- [ ] Implement the broker-private cache key across task, harness, model,
  dataset, Harbor, sandbox, network, and protocol versions.
- [ ] Store cached outcomes as distributions with attempts, rewards, variance,
  confidence, timestamps, costs, and environment fingerprints.
- [ ] Accept only signed, schema-valid observations; make cache observations
  immutable, append-only, and attempt-digest deduplicated.
- [ ] Expose no external record write/invalidation API; encrypt records at rest
  and grant record access only to the broker service identity.
- [ ] Keep rejected-candidate records inaccessible through the
  current-champion cache role.
- [ ] Implement exact-key invalidation, freshness windows, and variance policy.
- [ ] Require one valid observation, reject a 95% Jeffreys interval wider than
  `0.90`, and classify mixed-age distributions by their oldest observation.
- [ ] Expire observations individually so a new result cannot refresh stale
  history.
- [ ] Enforce the seven-day MVP ceiling and `0-24h`, `1-3d`, and `3-7d`
  freshness bands.
- [ ] Permit cache reuse for screening only.
- [ ] Implement the frozen Jeffreys-posterior screening calculation and
  conservative rejection boundary.
- [ ] Run deterministic champion drift anchors for at least 25% of each
  cache-hit cohort, with a minimum of one.
- [ ] Define drift cohorts from non-task key fields, freshness, difficulty, and
  capability strata.
- [ ] Implement deterministic anchor count, ordering, exact predictive-surprise
  tail calculation, and `0.01` failure threshold.
- [ ] Invalidate affected cache cohorts when drift checks fail.
- [ ] Require fresh same-window candidate/champion pairs for every promotion.
- [ ] Retain an eligible same-window candidate screening arm and run only its
  missing fresh champion arm during confirmation.
- [ ] Enforce a 24-hour maximum pair window and compatible environment
  fingerprints.
- [ ] Exclude cached comparisons from the minimum promotion sample.
- [ ] Prohibit outcome-driven confirmation-task selection and repeats.
- [ ] Seed the new champion cache from the promoted candidate's fresh results
  without changing or exposing task keys.
- [ ] Implement task-agnostic cache attestations.
- [ ] Bind each canonical cache-attestation hash into the signed result
  envelope.
- [ ] Implement baseline anchor refresh.
- [ ] Cap baseline maintenance at two attempts and total evaluator work at 30
  task attempts per experiment.
- [ ] Implement paired effect and uncertainty estimates.
- [ ] Implement the stratified paired Dirichlet-Jeffreys promotion posterior,
  `0.95` positive-delta probability, `0.05` median-effect floor, and stratum
  regression boundary.
- [ ] Implement regression and cost/latency guardrails.
- [ ] Implement advance, promote, reject, and inconclusive rules.
- [ ] Add deterministic statistical fixtures and simulations.
- [ ] Acceptance: smoke or cache evidence cannot promote, incompatible, stale,
  or expired-window observations cannot compare, no redundant candidate rerun
  is scheduled when its arm remains eligible, every promotion has twelve fresh
  presealed and evenly counterbalanced matched pairs, total attempts remain
  bounded, and ambiguous candidates do not become champions.

## DF-110 — Claude Code plugin, skills, and MCP

Reference: [PLAN §9](./PLAN.md#9-claude-code-plugin-and-mcp).

- [ ] Scaffold the project-local Claude Code plugin.
- [ ] Implement all eight planned skills, including failure-card analysis.
- [ ] Implement the read-only evidence MCP tools.
- [ ] Implement `df_get_failure_cards` and bounded
  `df_get_behavioral_excerpt` without single-trial drill-down.
- [ ] Implement the hypothesis/analysis/request MCP tools.
- [ ] Enforce request and response schemas.
- [ ] Add task-agnostic redaction, result limits, and token budgets.
- [ ] Audit every evidence query.
- [ ] Configure protected paths and allowed tools.
- [ ] Disable web, browser, GitHub, task selection, Harbor, and full-run access.
- [ ] Test skill triggering and every permission denial.
- [ ] Acceptance: Claude can form and test a general Pi hypothesis but cannot
  discover task identities or instructions, correlate tasks across
  experiments, query raw files, choose tasks, or reach graders.

## DF-120 — Candidate integrity and reward-hacking defense

Reference: [PLAN §8](./PLAN.md#8-anti-overfitting-and-benchmark-integrity).

- [ ] Scan diffs for task and instruction fragments.
- [ ] Scan for test, grader, verifier, solution, and reference paths.
- [ ] Detect encoded payloads and suspicious large constants.
- [ ] Detect task/environment fingerprint routing.
- [ ] Detect solution URLs and unapproved network tools.
- [ ] Test failure-card re-identification, unique literals, and differencing
  attacks.
- [ ] Test that cache attestations reject task keys, per-record results, stable
  join fields, unsigned data, protocol-detached data, and membership
  differencing.
- [ ] Test cache poisoning, duplicate signed attempts, and unauthorized
  invalidation.
- [ ] Enforce changed-file and mutation-size limits.
- [ ] Freeze hypothesis predictions before evaluation.
- [ ] Run integrity judging over passing trajectories.
- [ ] Log and inspect evaluated-agent egress.
- [ ] Add adversarial bypass fixtures.
- [ ] Acceptance: every known prohibited pattern fails closed and records a
  machine-readable reason.

## DF-130 — Analysis, champion, and publication

Reference: [PLAN §5](./PLAN.md#5-experiment-lifecycle),
[§6.6](./PLAN.md#66-results-analysis-and-decision), and
[§4](./PLAN.md#4-repository-and-git-design).

- [ ] Generate results and analysis records.
- [ ] Require evidence references for conclusions.
- [ ] Apply the versioned decision policy.
- [ ] Atomically update the champion on promotion.
- [ ] Preserve rejected and inconclusive candidates.
- [ ] Tag and publish sealed experiments.
- [ ] Support human overrides with reasons.
- [ ] Test offline, retry, duplicate, and conflict cases.
- [ ] Acceptance: decisions replay identically from sealed evidence and Git
  publication cannot change them.

## DF-140 — Feedback and documentation

Reference: [PLAN §11](./PLAN.md#11-feedback-and-decision-documentation).

- [ ] Implement `feedback-entry.json`.
- [ ] Render parent, previous, and baseline comparisons.
- [ ] Include accuracy, uncertainty, valid-pair provenance, regressions, costs,
  latency, and exposure.
- [ ] Include integrity status and next recommendation.
- [ ] Append exactly once after sealing.
- [ ] Rebuild `FEEDBACK.md` deterministically.
- [ ] Enforce ADR references for material policy changes.
- [ ] Add golden and idempotency tests.
- [ ] Acceptance: deleting and rebuilding `FEEDBACK.md` produces byte-identical
  output from sealed JSON.

## DF-150 — Autonomous indefinite loop

Reference: [PLAN §1](./PLAN.md#1-purpose-and-success-criteria),
[§5.1](./PLAN.md#51-atomicity-and-interruption), and
[§10](./PLAN.md#10-cli-and-public-interfaces).

- [ ] Join the blind broker, Claude, Git, cloud tests, evaluator, analysis, and
  feedback.
- [ ] Implement `df optimize`.
- [ ] Implement `df status`, `df stop`, and `df resume`.
- [ ] Show cumulative trials, time, tokens, model cost, and sandbox cost.
- [ ] Recover from provider, model, GitHub, and process failures.
- [ ] Retry pending publication independently.
- [ ] Run multi-experiment fake campaigns.
- [ ] Acceptance: the loop runs without a campaign limit, stops promptly, and
  resumes from the last fully sealed experiment.

## DF-160 — Human-only full evaluation

Reference: [PLAN §10.1](./PLAN.md#101-full-evaluation-authorization).

- [ ] Implement readiness and protocol validation.
- [ ] Implement random one-time challenges.
- [ ] Require interactive TTY confirmation.
- [ ] Store short-lived authorization outside Claude scope.
- [ ] Bind authorization to the protocol hash and exact scope.
- [ ] Reject CI, MCP, Claude, replay, expired, and non-TTY requests.
- [ ] Keep full-run APIs absent from optimizer tools.
- [ ] Add 100% branch coverage and security tests.
- [ ] Acceptance: no autonomous process can start the 89x5 run; an explicitly
  authorized human can start only the displayed frozen protocol.

## DF-170 — Complete test and security matrix

Reference: [PLAN §12](./PLAN.md#12-testing-strategy).

- [ ] Reach 90% line and branch coverage for core modules.
- [ ] Reach 100% branch coverage for critical security modules.
- [ ] Pass unit, contract, property, integration, and replay tests.
- [ ] Pass cache key, TTL, drift, invalidation, seed, fresh-window,
  no-false-promotion, and no-duplicate-arm tests.
- [ ] Pass provider contract tests.
- [ ] Pass malicious store, ATIF, path, environment, and network tests.
- [ ] Test every lifecycle interruption point.
- [ ] Keep paid live tests explicitly opt-in.
- [ ] Acceptance: the complete cloud CI/sandbox quality gate is green without
  executing tests or workloads on the Mac.

## DF-180 — Synthetic end-to-end validation

Reference: [PLAN §13](./PLAN.md#13-implementation-phases).

- [ ] Build synthetic tasks and graders with planted canaries in a cloud-only
  test environment.
- [ ] Run promote, reject, and inconclusive campaigns.
- [ ] Interrupt each campaign at multiple phases.
- [ ] Rebuild the store, index, and feedback.
- [ ] Verify zero canary leakage.
- [ ] Audit Git reconstruction and decision replay.
- [ ] Acceptance: the factory is reliable without spending model or benchmark
  budget.

## DF-190 — Real calibration campaign

Reference: [PLAN §13](./PLAN.md#13-implementation-phases).

- [ ] Pin the real baseline lineage.
- [ ] Probe sandbox compatibility.
- [ ] Run a minimal real smoke experiment.
- [ ] Confirm grader isolation and sanitized ATIF.
- [ ] Run several rotating subset experiments.
- [ ] Inspect task exposure, costs, regressions, and feedback.
- [ ] Stop and resume at least once.
- [ ] Acceptance: the real loop produces credible, reproducible evidence while
  the official full-run gate remains locked.

## DF-200 — Operational readiness

Reference: [PLAN §14](./PLAN.md#14-operational-assumptions).

- [ ] Document installation and local prerequisites.
- [ ] Document secrets and macOS Keychain usage.
- [ ] Document provider setup and compatibility.
- [ ] Document campaign operation, stop, resume, and recovery.
- [ ] Document evidence audit and amendments.
- [ ] Document GitHub publication recovery.
- [ ] Document full-evaluation authorization.
- [ ] Complete a threat-model and reproducibility review.
- [ ] Acceptance: another engineer can operate and audit the MVP without making
  undocumented decisions.
