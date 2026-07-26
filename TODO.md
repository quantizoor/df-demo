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
- [ ] Freeze `research` versus `submission` modes and the data/actions allowed
  in each.
- [ ] Track `leaderboardEligibility` as `unverified`, `cleared`, or
  `strict-score-only`; fail closed on an ineligible official run.
- [ ] Define and sign a compliance manifest; reject mixed-mode evidence.
- [ ] Define threat model and grader-leak response.
- [ ] Add the corresponding ADRs to `documentation.md`.
- [ ] Acceptance: a reviewer can determine whether any proposed run is
  comparable, valid, and permitted without making a new policy decision.

## DF-010 — TypeScript workspace and quality tooling

Reference: [PLAN §2.2](./PLAN.md#22-dark-factory-stack) and
[§12](./PLAN.md#12-testing-strategy).

- [ ] Generate the first pnpm lock with the implemented commit-bound cloud
  review-artifact workflow, review it, and commit it through a normal PR.
- [x] Configure strict TypeScript ESM.
- [x] Configure Vitest and coverage.
- [x] Configure Biome.
- [x] Add Pino, Commander, TypeBox, and Ajv.
- [x] Define package/module boundaries.
- [x] Add typecheck, lint, format-check, test, coverage, and cloud CI scripts.
- [x] Pin external cloud-CI actions to immutable commits and make checkout
  credentials non-persistent.
- [ ] Test a minimal CLI and schema-validation path.
- [ ] Acceptance: clean install plus all quality commands pass in cloud CI;
  implementation does not require running builds or tests on the Mac.

## DF-020 — Existing private Pi fork and Git workflow

Reference: [PLAN §2.1](./PLAN.md#21-harness-under-optimization) and
[§4](./PLAN.md#4-repository-and-git-design).

- [x] Confirm the operator-provided Pi repository exists at `../pi`.
- [x] Confirm it is a clean Git worktree on `main`, tracking `origin`.
- [x] Record the planning-time commit
  `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`.
- [x] Bind the observed Pi tree, package-lock SHA-256, package name/version,
  branch, and private GitHub repository identity into a separate fail-closed
  cloud source configuration. Independent remote verification is still
  pending.
- [ ] Implement `df harness register ../pi` and `df harness doctor`.
- [ ] Verify through the remote provider that `origin` is private and supports
  authenticated fetch/push without logging its URL or credentials.
- [ ] Verify the official `earendil-works/pi` upstream and merge base in an
  isolated cloud clone without adding or fetching a local `upstream` remote.
- [ ] Record sanitized origin/upstream fingerprints.
- [ ] Pin the reviewed fork commit, upstream base commit, and
  repository-native lock hash during baseline initialization.
- [ ] Preserve Pi's native npm/package-lock workflow independently of the pnpm
  Dark Factory control plane.
- [ ] Implement candidate worktrees without editing, resetting, or cleaning
  the canonical `../pi/main` worktree.
- [ ] Implement experiment branches and champion tags.
- [ ] Ensure Claude receives no GitHub credentials.
- [ ] Implement pending publication and retry.
- [ ] Fail closed on dirty, detached, unexpected, or unpublished canonical
  repository state.
- [ ] Test restore, offline sealing, private-origin publication, upstream
  refresh, and non-force publication.
- [ ] Acceptance: any candidate and champion can be reconstructed from recorded
  Git identifiers without creating a second fork or mutating `../pi/main`,
  another experiment, or unpublished operator work.

## DF-030 — JSON schemas and evidence store

Reference: [PLAN §6](./PLAN.md#6-evidence-store-and-schemas).

- [ ] Define schemas for all experiment root files.
- [ ] Include canonical harness registration, sanitized remote fingerprints,
  commit provenance, and private-origin verification without storing remote
  credentials or credential-bearing URLs.
- [ ] Define strict `NormalizedGraderOutcome`, aggregate
  `behavioral-evidence.json`, `failure-cards.json`, and
  `diagnostic-brief.json` schemas.
- [ ] Define the task-agnostic `cache-attestation.json` schema.
- [ ] Define schemas for panel-role attestations, extractor/statistical/privacy
  policy versions, champion state, and local event records.
- [ ] Define trusted-zone-only schemas for raw trial, grader, ATIF, and
  normalized rows; prohibit them from the local experiment schema.
- [ ] Enforce `additionalProperties: false`.
- [ ] Implement canonical JSON and SHA-256.
- [ ] Implement schema versioning and migrations.
- [ ] Implement append-only amendments.
- [x] Implement cloud-only canonical atomic state envelopes and non-expiring,
  provider-destruction-attested controller locks for the one-use ledger,
  hidden catalog CAS, and optimizer session records.
- [ ] Run the mounted-volume semantics canary and crash/recovery suite against
  the exact production volume class; use a managed transactional store if
  atomic rename and durable synchronization cannot be attested.
- [ ] Implement artifact checksum verification.
- [ ] Implement disposable SQLite index and rebuild.
- [ ] Add positive, negative, property, and corruption fixtures.
- [ ] Acceptance: the complete local store rebuilds from JSON; every evidence
  aggregate derives from a signed normalized outcome; raw/sanitized ATIF,
  grader payloads, per-task rows, task IDs, stable handles, and pool membership
  cannot validate locally; mutation, truncation, malformed records, and broken
  references are detected.

## DF-040 — Lifecycle, sealing, stop, and resume

Reference: [PLAN §5](./PLAN.md#5-experiment-lifecycle).

- [ ] Implement the experiment state machine.
- [ ] Add candidate, challenger, active-champion, and certified-champion states
  and persist separate active/certified pointers.
- [ ] Reject invalid state transitions.
- [ ] Implement monotonic experiment numbers.
- [ ] Implement atomic champion updates.
- [ ] Enforce at most two candidate commits per discovery/repair panel.
- [ ] Atomically consume and rotate every decided validation panel,
  independent of its result.
- [ ] Return only a sealed-but-unstarted panel to eligibility; once any arm
  starts, an abandoned panel is quarantined/consumed and cannot be reused for
  positive validation.
- [ ] Implement sealing and the experiment hash chain.
- [ ] Handle SIGINT and SIGTERM in every state.
- [ ] Archive interrupted attempts without reusing numbers.
- [ ] Restore from the last fully sealed active and certified champions.
- [ ] Restore broker-attested exposure/cooldown state plus repeated-testing and
  privacy budgets without resetting them.
- [ ] Test idempotent resume and repeated stop signals.
- [ ] Acceptance: fault injection at every write and lifecycle boundary cannot
  corrupt the last seal, reuse a consumed panel, reset an attempt/privacy
  budget, or incorrectly move either champion pointer.

## DF-050 — Harbor and ATIF integration

Reference: [PLAN §2.2](./PLAN.md#22-dark-factory-stack),
[§3.3](./PLAN.md#33-evaluator-and-task-broker-zone), and
[§6.5](./PLAN.md#65-trusted-trial-records-and-normalized-local-evidence).

- [ ] Pin Harbor and record its version.
- [ ] Define the evaluator request/result protocol.
- [ ] Implement Harbor process/remote invocation behind an interface.
- [x] Seal every completed Harbor output directory in the evaluator sandbox
  as a deterministic, bounded regular-file tar before provider download. Bind
  its canonical manifest to request/job/pin/config/invocation/execution
  identity and reject links, special files, traversal, nested archives,
  malformed Harbor result/ATIF locations, and incomplete trial sets.
- [ ] Run the Harbor output packager determinism, malformed-layout, symlink,
  byte/file ceiling, and provider-download contract tests in approved cloud
  CI; these tests are implemented but intentionally not executed on the Mac.
- [ ] Implement ATIF parsing and validation only inside the trusted evaluator.
- [ ] Normalize every grader adapter into `NormalizedGraderOutcome` before
  behavioral extraction.
- [ ] Classify benchmark versus infrastructure outcomes.
- [ ] Destroy or quarantine raw ATIF/grader output after signed derivation
  according to the frozen trusted-zone retention policy.
- [ ] Preserve official resources and timeouts.
- [ ] Add fake-Harbor and pinned-fixture contract tests.
- [ ] Acceptance: a cloud synthetic task produces a signed normalized outcome
  and approved aggregate behavioral evidence; no raw or sanitized ATIF exists
  under `df-demo`; an infrastructure error cannot be mistaken for reward zero.

## DF-060 — Sandbox providers

Reference: [PLAN §2.3](./PLAN.md#23-sandbox-policy) and
[§10](./PLAN.md#10-cli-and-public-interfaces).

- [x] Define the common provider contract.
- [x] Implement provider capability probes.
- [x] Implement Daytona support, including the exact `@daytona/sdk` pin,
  immutable-image provisioning, trusted streaming artifact boundary, opaque
  organization-secret names, POSIX argv encoding, TTL/network/resource
  attestation, sampled resource receipts, and force-stop quarantine.
- [ ] Implement E2B support.
- [ ] Implement Modal support.
- [x] Prohibit and test the absence of a local execution backend.
- [ ] Run synthetic fixtures, candidate tests, and provider contracts in cloud
  sandboxes.
- [x] Enforce provider parity within candidate/champion pairs.
- [x] Record immutable images, region class, resources, and network policy in
  provider leases and execution receipts. Cost attribution remains part of
  campaign composition.
- [x] Implement cancellation, timeout, cleanup, and quarantine. Callers that
  need concurrent cancellation must preseal `command.executionId`.
- [ ] Run the shared provider contract suite.
- [ ] Generate and commit the dependency lockfile in approved cloud CI; local
  dependency installation remains forbidden.
- [x] Add protected, confirmation-bound workflows for cloud quality, first
  lockfile review, role-image publication, and paid control bootstrap.
- [x] Add role-specific default-deny OCI builds for the control, optimizer,
  candidate-build, and evaluator zones. Exact base digests, Claude Code
  version, and Harbor version remain operator inputs.
- [ ] Run the four role-image builds in protected cloud CI, inspect their SBOM
  and provenance attestations, and record their immutable digest receipts.
- [ ] Configure and approve the `dark-factory-paid` GitHub environment before
  its first commit/campaign/control-digest-bound dispatch.
- [ ] Bind a durable trusted-cloud artifact backend to the verifying bridge.
- [ ] Bind the trusted-runtime guard to provider/deployment attestation; the
  baseline environment-marker guard is fail-closed when markers are absent but
  is not cryptographic proof against a process allowed to forge its own
  environment.
- [ ] Configure Daytona organization Secrets and their host allowlists without
  exposing their values to the workstation or sandbox.
- [ ] Implement and cloud-verify a GitHub-hosted-only Daytona controller bootstrap that binds an
  immutable control image, one campaign volume subpath, organization-secret
  names, exact runtime markers, bounded network/resources/TTL, paid-run
  authorization, and confirmed teardown. Cloud execution is still pending.
- [ ] Cloud-verify the implemented trusted-controller `probe` and `synthetic` entrypoints with a
  mounted-volume integrity round trip and a disposable live provider probe.
  Production `optimize`, status, stop, and resume remain locked until their
  signed composition is complete.
- [ ] Confirm the pinned Terminal-Bench image includes a working DIND runtime
  and run the live Daytona profile/architecture/network/TTL attestation suite.
- [ ] Keep Daytona GPU jobs unschedulable until returned metadata or an
  independent attestor can verify the exact GPU type.
- [ ] Acceptance: the scheduler can select a compatible provider or explain why
  a task is unschedulable without changing benchmark requirements.

## DF-070 — Trusted evaluator and sanitizer

Reference: [PLAN §3.3](./PLAN.md#33-evaluator-and-task-broker-zone) and
[§8.1](./PLAN.md#81-grader-isolation).

- [ ] Separate evaluator credentials and filesystem from Claude.
- [ ] Keep raw benchmark jobs in the trusted zone.
- [ ] Implement minimal signed result envelopes.
- [ ] Implement strict deterministic `NormalizedGraderOutcome` extraction and
  reject all non-allowlisted grader fields. The schema-backed source and
  synthetic tests are present; cloud verification is pending.
- [ ] Implement deterministic, versioned behavioral extraction inside the
  trusted cloud zone. The deterministic reduction path and authenticated
  decrypt/decode composition are present; the provider-specific Harbor/ATIF
  decoder and cloud verification remain.
- [x] Add a strict raw-artifact reader boundary that verifies encrypted byte
  length and SHA-256, manifest-bound decryption AAD, cloud decryption
  attestations, all-three-input decoder acknowledgement, and buffer
  zeroization, with no filesystem fallback.
- [x] Add a hash-bound canonical policy resolver covering cache evidence,
  promotion guardrails, release-scanner registries, online error budget, and
  privacy-qualified behavioral release lineage.
- [x] Add cloud-key-provider-backed Ed25519 signing and verification for
  broker-private hidden-catalog outcome updates.
- [x] Add a production-only trusted evaluator composition factory connecting
  `TerminalBenchCloudRunner` through deterministic derivation, mandatory raw
  destruction, and signed broker release while rejecting test-only ports.
- [ ] Bind the raw reader, decryption, Harbor/ATIF decoder, policy material,
  durable stores, and Ed25519 key ports to concrete cloud services; in-memory
  fixtures remain test-only and are rejected by production composition.
- [ ] Strip commands/arguments, paths, filenames, contents, stdout/stderr,
  URLs, package/service names, environment variables, task IDs, stable
  pseudonyms, and grader text before aggregation.
- [ ] Implement the authoritative statistical evidence engine and approved
  failure taxonomy. Repair, fresh-validation, and shadow gate aggregation are
  wired into the canonical deriver; behavioral release composition remains.
- [ ] Require at least five distinct tasks, 20 total trajectories, and five
  observations in every compared group before releasing a card.
- [ ] Aggregate successful-versus-failed and candidate-versus-champion
  behavioral contrasts with effect sizes, uncertainty, task clustering, and
  runtime/budget controls.
- [ ] Implement `diagnostic-brief.json` generation, source binding, card
  ranking, and suppression metadata.
- [ ] Permit an optional LLM interpreter to see only released aggregate cards;
  require every claim to cite a card and prohibit model-generated statistics.
- [ ] Implement grader/test canary and fingerprint scans. The canonical
  no-literal/no-task firewall and adversarial source-fingerprint tests are
  present, and the scanner registry is now a required signed policy binding;
  the concrete cloud registry population and verification remain.
- [ ] Implement complementary-count suppression, overlap/query budgets,
  adaptive task re-identification, and cohort-differencing scans.
- [ ] Emit at most one sealed diagnostic brief per eligible experiment; do not
  expose interactive cohort narrowing or single-trial drill-down.
- [ ] Persist attestations without matched leak content.
- [ ] Delete raw grader/ATIF output after signed derivation.
- [x] Add malicious-output and leakage tests for detached ciphertext,
  decryption AAD, decoder input sets, policy components, hidden update
  signatures, and test-only production ports. Run them in approved cloud CI.
- [ ] Acceptance: extraction and statistics are byte-deterministic; protected
  canaries and task-identifying literals cannot cross the boundary; every
  below-threshold or differencing-risk cohort is suppressed; no raw/sanitized
  ATIF or grader artifact exists under `df-demo`; and disabling the optional
  LLM cannot change numeric evidence or a decision.

## DF-080 — Pi adapter and experiment 000

Reference: [PLAN §2.1](./PLAN.md#21-harness-under-optimization),
[§4](./PLAN.md#4-repository-and-git-design), and
[§13](./PLAN.md#13-implementation-phases).

- [ ] Cloud-verify Pi's bounded `--print --mode json` lifecycle and event
  compatibility at the exact authorized fork commit; keep RPC as a separately
  tested future protocol change.
- [ ] Complete or maintain the Harbor Pi adapter.
- [ ] Convert Pi sessions to valid ATIF.
- [ ] Pin Pi dependencies and default harness configuration.
- [ ] Run synthetic adapter tests in a cloud sandbox.
- [ ] Create and seal `000-pi-baseline`.
- [ ] Ensure experiment `001` receives no benchmark-derived feedback and
  freezes its hypothesis/candidate before the first hidden panel is selected.
- [ ] Do not run the official full benchmark.
- [ ] Acceptance: experiment 000 is reproducible and usable as the immutable
  beginning for progressive matched baseline observations.

## DF-090 — Blind task broker, pools, and weighting

Reference:
[PLAN §7](./PLAN.md#7-walk-forward-blind-evaluation-and-economy).

- [ ] Build the pinned task catalog only inside the trusted cloud broker.
- [ ] Import the selected comparable leaderboard baseline's per-task failure
  rates when available.
- [ ] Keep actual names, instructions, mappings, pools, weights, and exposure
  history out of Dark Factory and Claude.
- [ ] Create broker-private discovery/repair, validation,
  regression/cooldown, and shadow roles.
- [ ] Maintain a private append-only role/exposure/feedback/cooldown ledger.
- [ ] Ingest signed, source-bound hidden outcome updates idempotently so
  candidate/champion pass, infrastructure validity, latency, and cost update
  broker-private task estimates. The deriver, adaptive posterior policy, and
  durable catalog adapter are present; cloud integration and live verification
  remain.
- [ ] Implement deterministic failure-weighted priority.
- [ ] Allocate each five-task repair panel as exactly three hard, one
  uncertain/discriminating, and a fifth slot alternating easy-integrity and
  underexposed-coverage by epoch.
- [ ] Implement a deterministic carry ledger so twelve-task panels converge to
  the 60/20/10/10 long-run mix.
- [ ] Give every task a nonzero eligibility floor.
- [ ] Implement deterministic exposure-age tie-breaking.
- [ ] Implement one-use, non-correlatable trial handles.
- [ ] Prevent Dark Factory and Claude from requesting, listing, or naming tasks.
- [ ] Require validation to be fresh to the frozen hypothesis and disjoint from
  its repair/evidence inputs.
- [ ] Consume every validation panel at decision time because the disposition
  itself is feedback, regardless of pass/fail/inconclusive; keep exposed tasks
  eligible for repair/regression, never positive promotion of an influenced
  candidate.
- [ ] Allow immediate validation→repair reuse plus one revised candidate, then
  enforce a three-sealed-experiment repair cooldown after advancement or the
  second attempt.
- [ ] Keep shadow tasks feedback-dark and shadow-exclusive.
- [ ] Reserve two disjoint twelve-task shadow slices before allocating
  validation capacity; consume each slice at most once.
- [ ] Surface the resulting MVP ceiling of at most five complete fresh
  twelve-task validation panels from the 89-task benchmark.
- [ ] Make task-feedback exposure globally non-resettable across every
  descendant harness, protocol revision, and baseline label that inherits
  adaptive decisions.
- [ ] Add weighting, quota, determinism, blindness, and adversarial tests.
- [ ] Acceptance: identical broker history produces the same panel and
  rotation; multi-epoch five-slot selection alternates easy/coverage exactly;
  validation disjointness and cooldown always hold; easy canaries continue to
  appear; and no returned artifact reveals task identity, instructions,
  mappings, roles, exposure, or membership.

## DF-100 — Walk-forward evaluation, cache, and decision statistics

References: [PLAN §7.1](./PLAN.md#71-walk-forward-repair-and-fresh-validation),
[PLAN §7.2](./PLAN.md#72-champion-result-cache).

- [ ] Implement the bootstrap path: no-feedback candidate → frozen hypothesis
  and commit → fresh validation against Pi experiment `000`.
- [ ] Implement discovery brief → repair → challenger → fresh validation →
  outcome-independent panel rotation.
- [x] Implement the production-facing, identity-blind orchestrator adapter
  that converts one-use signed evaluator releases into strict repair and
  validation aggregates, burns or quarantines every lease, and publishes a
  privacy-qualified diagnostic at most once. Concrete cloud ports and full
  loop composition remain pending.
- [ ] Run repair on exactly five old-panel tasks with one fresh candidate arm
  per task.
- [ ] Compare repair with eligible exact-key active-champion cache evidence;
  run fresh champion repair arms on miss or required drift.
- [ ] Require repair non-inferiority
  `P(weightedAccuracyDelta >= -0.10) >= 0.80` plus either one confirmed
  fail-to-pass or preregistered target-behavior improvement on at least three
  of five, with hard integrity/capability/cost/latency vetoes.
- [ ] Count fail-to-pass only from a fresh candidate pass and fresh champion
  failure on a champion-control slot presealed before outcomes; never infer a
  binary transition from cache alone.
- [ ] Persist challenger state only after repair passes; repair can never
  create an active champion.
- [ ] Enforce at most two candidate commits per discovery panel, then close the
  hypothesis.
- [ ] Ensure a five-by-one repair result cannot generate a diagnostic brief.
- [ ] Freeze the candidate before the broker selects and preseals twelve fresh,
  hypothesis-disjoint validation tasks, strata, six AB/six BA order,
  environment cohort, time window, statistics, and budgets.
- [ ] Run exactly one fresh challenger and one fresh active-champion arm per
  validation task.
- [ ] Enforce a 24-hour maximum pair window and compatible environment
  fingerprints.
- [ ] Give repair, cache, baseline, and historical evidence zero positive
  promotion weight; allow only preregistered veto/diagnostic uses.
- [ ] Consume every validation panel at its promoted, rejected, or inconclusive
  decision; withholding diagnostics cannot preserve it as a holdout.
- [ ] Seal valid-arm, retry, total-attempt, monetary, token, and wall-time
  ceilings in every evaluation plan.
- [ ] Enforce the 38-attempt maximum: up to 34 valid repair/validation arms and
  four infrastructure replacements; report typical 30–31 work.
- [ ] Keep baseline maintenance asynchronous and outside promotion evidence
  and the experiment attempt ceiling.
- [ ] Implement the broker-private cache key across task, harness, model,
  dataset, Harbor, sandbox, network, and protocol versions.
- [ ] Store cached outcomes as distributions with attempts, rewards, variance,
  confidence, timestamps, costs, and environment fingerprints.
- [ ] Bind each fresh decoded outcome set to one signed hidden-catalog update
  and reject detached signatures, conflicting update IDs, or detached commit
  receipts. The producer, injected cloud-key Ed25519 signer/verifier,
  production composition, and adversarial synthetic tests are present;
  durable cloud ingestion remains.
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
- [ ] Permit cache reuse for repair only.
- [ ] Implement the frozen Jeffreys-posterior repair calculation and
  conservative rejection boundary.
- [ ] Run deterministic champion drift anchors for at least 25% of each
  cache-hit cohort, with a minimum of one.
- [ ] Define drift cohorts from non-task key fields, freshness, difficulty, and
  capability strata.
- [ ] Implement deterministic anchor count, ordering, exact predictive-surprise
  tail calculation, and `0.01` failure threshold.
- [ ] Invalidate affected cache cohorts when drift checks fail.
- [ ] Require fresh same-window candidate/champion pairs for every promotion.
- [ ] Exclude every cached comparison from validation and shadow.
- [ ] Prohibit outcome-driven validation-task selection and repeats.
- [ ] Seed the new champion cache from the promoted candidate's fresh results
  without changing or exposing task keys.
- [ ] On reject/inconclusive, refresh the incumbent cache from its fresh
  validation arms so the consumed panel's next repair normally avoids
  redundant controls.
- [ ] Implement task-agnostic cache attestations.
- [ ] Suppress exact five-task cache hit, anchor, invalidation, and arm counts
  from local/feedback evidence; retain only status, age bands, budget
  compliance, aggregate cost, and signed derivation.
- [ ] Bind each canonical cache-attestation hash into the signed result
  envelope.
- [ ] Implement paired effect and uncertainty estimates.
- [ ] Treat tasks as independent clusters and prevent repetitions from
  inflating effective sample size.
- [ ] Implement the stratified paired Dirichlet-Jeffreys promotion posterior,
  `0.95` positive-delta probability, `0.05` median-effect floor, and stratum
  regression boundary.
- [ ] Implement a campaign-level online error budget calibrated by null
  simulations for repeated promotion attempts.
- [ ] Implement regression and cost/latency guardrails.
- [ ] Implement challenger, active-promotion, reject, and inconclusive rules.
- [ ] Implement feedback-dark shadow certification every third active
  promotion and before release, with one attempt per active commit and no
  diagnostic output.
- [ ] Initialize experiment `000` as the shadow comparison anchor without
  labeling it a certified improvement.
- [ ] Bound each shadow race to 24 valid arms plus at most four infrastructure
  replacements (28 attempts).
- [ ] Atomically move active and certified champion pointers only at their
  respective gates.
- [ ] Freeze positive promotion when fewer than twelve tasks remain genuinely
  fresh to the lineage; never silently weaken freshness.
- [ ] Permit replenishment only with truly unseen external/synthetic tasks, or
  a pre-adaptation fork inheriting none of the exposed code/decisions; never
  reset freshness by renaming a lineage or repartitioning tasks.
- [ ] Add deterministic statistical fixtures and simulations.
- [ ] Acceptance: old-panel improvement or cache evidence alone cannot
  promote; no panel supports more than two repair attempts; incompatible,
  stale, exposed, or expired-window evidence cannot count positively; every
  promotion has twelve disjoint fresh presealed pairs balanced six AB/six BA;
  every decided validation rotates and every started-abandoned panel is
  quarantined; active differs from certified until shadow passes; attempts
  remain bounded; and ambiguous candidates do not become champions.

## DF-110 — Claude Code plugin, skills, and MCP

Reference: [PLAN §9](./PLAN.md#9-claude-code-plugin-and-mcp).

- [ ] Scaffold the project-local Claude Code plugin.
- [ ] Implement all eight planned skills, including diagnostic-brief analysis.
- [ ] Implement the read-only evidence MCP tools.
- [ ] Implement one-use, bounded `df_get_latest_diagnostic_brief`.
- [ ] Implement the hypothesis/analysis/request MCP tools.
- [ ] Enforce request and response schemas.
- [ ] Add task-agnostic redaction, result limits, token budgets, cumulative
  query/differencing budgets, and complementary-count suppression.
- [ ] Audit every evidence query and bind submitted hypotheses to cited brief
  hashes.
- [ ] Configure protected paths and allowed tools.
- [ ] Disable raw/per-task evidence, panel roles, exposure history, behavioral
  excerpts, web, browser, GitHub, task selection, validation/shadow scheduling,
  Harbor, and full-run access.
- [ ] Test skill triggering and every permission denial.
- [ ] Acceptance: Claude can form and test a general Pi hypothesis but cannot
  discover task identities or instructions, correlate tasks across
  experiments, narrow cohorts, query raw/per-task files, infer panel roles,
  choose tasks or stages, or reach graders.

## DF-120 — Candidate integrity and reward-hacking defense

Reference: [PLAN §8](./PLAN.md#8-anti-overfitting-and-benchmark-integrity).

- [ ] Scan diffs for task and instruction fragments.
- [ ] Scan for test, grader, verifier, solution, and reference paths.
- [ ] Detect encoded payloads and suspicious large constants.
- [ ] Detect task/environment fingerprint routing.
- [ ] Detect solution URLs and unapproved network tools.
- [ ] Test failure-card re-identification, unique literals, and differencing
  attacks.
- [ ] Test adaptive-query, overlapping/complementary-cohort, stable-feature
  fingerprint, panel-role inference, raw-ATIF persistence, and
  research/submission crossover attacks.
- [ ] Test that cache attestations reject task keys, per-record results, stable
  join fields, unsigned data, protocol-detached data, and membership
  differencing.
- [ ] Test cache poisoning, duplicate signed attempts, and unauthorized
  invalidation.
- [ ] Enforce changed-file and mutation-size limits.
- [ ] Freeze the hypothesis, cited brief hashes, predicted repair/unseen
  effects, and candidate commit before any panel is selected.
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
- [ ] Atomically update the active champion only after fresh validation.
- [ ] Atomically update the certified champion only after feedback-dark shadow
  and compliance gates.
- [ ] Preserve the last certified release default when an active candidate or
  shadow attempt fails.
- [ ] Preserve rejected and inconclusive candidates.
- [ ] Tag and publish sealed experiments.
- [ ] Support human overrides with reasons.
- [ ] Test offline, retry, duplicate, and conflict cases.
- [ ] Acceptance: decisions and both champion pointers replay identically from
  sealed evidence and Git publication cannot change them.

## DF-140 — Feedback and documentation

Reference: [PLAN §11](./PLAN.md#11-feedback-and-decision-documentation).

- [ ] Implement `feedback-entry.json`.
- [ ] Render old-panel repair only as disposition, attempt ordinal, integrity,
  aggregate cost, cache-use status, and attestation; keep every detailed
  five-task statistic/count broker-private.
- [ ] Render fresh parent validation separately; render previous/baseline only
  on compatible matched intersections.
- [ ] Include source diagnostic-brief hash, candidate/challenger/active/
  certified state, fresh-validation/historical accuracy and uncertainty,
  provenance, regressions, costs, latency, extractor/statistical/privacy
  versions, and panel rotation.
- [ ] State explicitly that repair/cache evidence had zero positive promotion
  weight.
- [ ] Suppress task/pool membership, stable handles, and joinable small counts.
- [ ] Render shadow as disposition/compliance/cost only, with no score or
  diagnostic content.
- [ ] Include integrity status and next recommendation.
- [ ] Append exactly once after sealing.
- [ ] Rebuild `FEEDBACK.md` deterministically.
- [ ] Enforce ADR references for material policy changes.
- [ ] Add golden and idempotency tests.
- [ ] Acceptance: deleting and rebuilding `FEEDBACK.md` produces byte-identical
  output from sealed JSON.

## DF-150 — Autonomous walk-forward loop

Reference: [PLAN §1](./PLAN.md#1-purpose-and-success-criteria),
[§5.1](./PLAN.md#51-atomicity-and-interruption), and
[§10](./PLAN.md#10-cli-and-public-interfaces).

- [ ] Join the blind broker, Claude, Git, cloud tests, evaluator, analysis, and
  feedback as discovery brief → at most two repairs → challenger → twelve-pair
  fresh validation → rotation → scheduled shadow certification.
- [ ] Implement `df optimize`.
- [ ] Implement `df status`, `df stop`, and `df resume`.
- [ ] Show cumulative trials, time, tokens, model cost, and sandbox cost.
- [ ] Show remaining rolling cost, repeated-testing, privacy, and genuinely
  fresh holdout budgets.
- [ ] Recover from provider, model, GitHub, and process failures.
- [ ] Retry pending publication independently.
- [ ] Run multi-experiment fake campaigns.
- [ ] Acceptance: the loop can run without a fixed experiment count, pauses at
  any rolling/holdout budget, never reuses a consumed panel positively, stops
  promptly, and resumes from the last fully sealed experiment.

## DF-160 — Human-only full evaluation

Reference: [PLAN §10.2](./PLAN.md#102-full-evaluation-authorization).

- [ ] Implement readiness and protocol validation.
- [ ] Require `submission` mode, a certified commit/protocol, a valid compliance
  manifest, and eligible `leaderboardEligibility`.
- [ ] Prove research diagnostic/MCP channels are disabled and reject a mixed
  research/submission lineage.
- [ ] Implement random one-time challenges.
- [ ] Require interactive TTY confirmation.
- [ ] Store short-lived authorization outside Claude scope.
- [ ] Bind authorization to the protocol hash and exact scope.
- [ ] Reject CI, MCP, Claude, replay, expired, and non-TTY requests.
- [ ] Keep full-run APIs absent from optimizer tools.
- [ ] Add 100% branch coverage and security tests.
- [ ] Acceptance: no autonomous process can start the 89x5 run; an explicitly
  authorized human can start only the displayed frozen, policy-eligible
  protocol.

## DF-170 — Complete test and security matrix

Reference: [PLAN §12](./PLAN.md#12-testing-strategy).

- [ ] Reach 90% line and branch coverage for core modules.
- [ ] Reach 100% branch coverage for critical security modules.
- [ ] Pass unit, contract, property, integration, and replay tests.
- [ ] Pass cache key, TTL, drift, invalidation, seed, fresh-window,
  no-false-promotion, and no-duplicate-arm tests.
- [ ] Pass deterministic normalized-outcome, extractor, aggregate-statistics,
  minimum-support, suppression, and no-local-ATIF tests.
- [ ] Pass exact five-task weighting, max-two-repair, challenger, twelve-by-one
  disjoint validation, consume-on-decision, cooldown, and finite-holdout tests.
- [ ] Prove cache can support repair non-inferiority but never the binary
  fail-to-pass criterion without a presealed fresh champion control.
- [ ] Pass active-versus-certified, shadow-no-feedback, repeated-testing, and
  research-versus-submission tests.
- [ ] Pass adaptive-query, overlap/complement differencing,
  re-identification, and stable-feature leakage tests.
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
- [ ] Cloud-verify the implemented three-experiment cloud smoke campaign covering fresh
  promotion, repair rejection, fresh inconclusive rotation, cumulative
  accounting, champion preservation, and release-canary absence. This does not
  replace the synthetic task/grader campaign and has not yet run in cloud CI.
- [ ] Run the no-feedback bootstrap.
- [ ] Run first-repair pass, second-repair pass, repair-exhaustion, and
  no-actionable-evidence campaigns.
- [ ] Run validation pass/fail/inconclusive campaigns and prove every decided
  panel rotates.
- [ ] Test unstarted abandonment separately from post-start quarantine.
- [ ] Run shadow pass/fail/inconclusive campaigns and prove none generates
  diagnostics.
- [ ] Run privacy-threshold suppression and cumulative-differencing attacks.
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
- [ ] Run one complete no-feedback bootstrap or minimal discovery cycle.
- [ ] Confirm grader isolation, deterministic normalized evidence, and zero raw
  or sanitized ATIF under `df-demo`.
- [ ] Calibrate one complete discovery/repair/validation rotation.
- [ ] Run a failed validation and prove it rotates into repair-only evidence.
- [ ] Produce one active promotion and one feedback-dark shadow certification.
- [ ] Calibrate the online repeated-testing policy with null simulations.
- [ ] Inspect task exposure, costs, regressions, and feedback.
- [ ] Stop and resume at least once.
- [ ] Acceptance: the real loop produces credible, reproducible evidence while
  the official full-run gate remains locked.

## DF-200 — Operational readiness

Reference: [PLAN §14](./PLAN.md#14-operational-assumptions).

- [ ] Document installation and local prerequisites.
- [ ] Document provider-managed Secrets, KMS-backed authorization, rotation,
  and host allowlists; no runtime secret is resolved by a Mac process.
- [ ] Document provider setup and compatibility.
- [ ] Document registration, privacy verification, upstream synchronization,
  and recovery for the existing `../pi` private fork.
- [ ] Document campaign operation, stop, resume, and recovery.
- [ ] Document evidence audit and amendments.
- [ ] Document diagnostic-brief interpretation, privacy budgets, panel
  lifecycle, active/certified status, and holdout exhaustion.
- [ ] Document research/submission compliance and the benchmark-owner clearance
  requirement.
- [ ] Document GitHub publication recovery.
- [ ] Document full-evaluation authorization and fail-closed eligibility checks.
- [ ] Complete a threat-model and reproducibility review.
- [ ] Acceptance: another engineer can operate and audit the MVP without making
  undocumented decisions.
