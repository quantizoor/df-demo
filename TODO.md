# Dark Factory MVP TODO

This is the execution checklist for [PLAN.md](./PLAN.md). An item is complete
only when its implementation, tests, documentation, and acceptance criteria
are all satisfied.

## MVP-ESSENTIAL — Authoritative first-loop checklist

Reference: [PLAN §0](./PLAN.md#0-essentials-only-mvp-authority), especially
[§0.1](./PLAN.md#01-the-exact-loop),
[§0.5](./PLAN.md#05-source-status-at-the-mvp-cut),
[§0.7](./PLAN.md#07-first-runnable-acceptance-boundary), and
[§0.8](./PLAN.md#08-stopresume-prerequisites).

This is the only blocking checklist for the first runnable prototype. Status
labels have precise meanings:

- **SOURCE-READY / CLOUD-UNVERIFIED:** implementation and tests exist in the
  repository, but no local command was run and no passing cloud receipt exists.
- **NOT YET WIRED:** the interface or core may exist, but the real cloud
  integration needed for an iteration does not.
- **OPERATOR INPUT:** a protected runtime reference, permission, or cost choice
  is required; secret values must never be pasted into chat.
- **DEFERRED / NOT A BLOCKER:** intentionally outside the MVP cut even if an
  older checklist below describes it.

### A. Loop and evidence cores

- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** define strict MVP contracts and JSON
  schemas for optimizer input, proposals, private observations,
  closed-vocabulary diagnostics, matched decisions, experiment state, hidden
  selection, evaluations, and cache accounting.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** select exactly five tasks
  deterministically from failure, baseline, comparable-public, uncertainty,
  underexposure, repeat-selection, and cost signals, with exactly one easy
  canary.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** construct three repetitions for each
  selected task and require matched candidate/champion cell identity.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** key champion cache entries by the
  hidden task/revision, champion/repetition, and the complete evaluation
  environment.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** prohibit promotion from cached
  champion evidence and refresh cached cells when a positive screen would
  otherwise promote.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** aggregate repetitions within each of
  five task clusters and apply the predeclared effect/confidence decision.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** validate sanitizer output against a
  strict task-free closed vocabulary and forbidden hidden literals.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** atomically write numbered experiment
  directories with release-safe JSON at the root and trusted-only JSON under
  `private/`.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** persist the selected panel as
  iteration state; retain
  the exact panel after `reject` or `inconclusive`; select a new weighted panel
  only after `promote`; keep every used task eligible for future panels.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** implement mounted-volume
  hidden-catalog and full-environment champion-cache ports with restart-safe
  state across normal iteration boundaries. Cloud proof is pending;
  crash-perfect recovery is separately deferred.

### B. Real cloud adapters

- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** parse references to an existing
  Foundry endpoint and deployment aliases, fix optimizer family
  `claude-opus-5`, fix evaluated family `claude-opus-4-8` at `high`, require an
  EU Daytona target and immutable image, and exclude plaintext secret values
  from the parsed configuration.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** define a Daytona runtime edge for
  separate optimizer/evaluator roles, disjoint mounted-volume subpaths,
  role-scoped secret references, immutable EU sandbox specifications, bounded
  worker commands, output receipts, and verified teardown.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** build and strictly decode a Harbor
  0.20.0 matched plan with five tasks, three attempts, 15 cells per arm, 30
  total trials, and deterministic three-AB/two-BA arm-order balancing.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** implement the task-aware Foundry
  diagnostic classifier wrapper and fail-closed release of only the validated
  closed-vocabulary brief.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** bind the external Pi/Harbor adapter
  to the existing Opus 4.8 Foundry deployment at `high` with no grader access
  in its declared interface.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** add the bounded cloud entrypoint
  that creates
  physically separate optimizer and evaluator sandboxes and mounts only their
  permitted protected-volume subpaths.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** connect pinned Claude Code to the
  existing Opus 5 deployment, clone the exact private Pi champion without
  exposing Git credentials, permit only bounded source changes, and return a
  candidate commit plus hypothesis.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** connect the trusted evaluator to
  Harbor and
  Terminal-Bench 2.1, build the candidate/champion from immutable source, run
  five tasks × three repetitions × two arms, and map all 30 cold-cache trials
  into strict private observations.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** inject the authored sanitizer into
  the trusted evaluator path with its role-scoped Foundry credential and
  release only strict task-free output or a generic failure. Cloud privacy
  proof is pending.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** execute the authored Pi/Foundry
  binding in direct Daytona child sandboxes and require an all-step
  separate-verifier attestation before a task is eligible. Cloud isolation
  proof is pending.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** persist raw traces and grader
  outputs only inside the trusted evaluator subpath and relay only strict
  optimizer input, candidate proposal, and task-free release receipts.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** add one-iteration bounds, optimizer
  turn/cost/time limits, five-trial evaluator concurrency, worker timeouts, and
  verified outer-sandbox teardown.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** cap both outer Daytona roles at the
  operator's current Tier 2 non-GPU per-sandbox profile of 4 vCPU, 8 GiB
  memory, and 10 GiB disk without changing the separately pinned official task
  resources.
- [x] **SOURCE-READY / CLOUD-UNVERIFIED:** add a secret-free GitHub-hosted
  `publish-mvp-runtime-image` path for the one combined Linux/amd64 image
  consumed by both MVP outer roles. Pin its build inputs in source, use default
  UID/GID `10001`, reserve `65532` and `65533`, verify the exact executable
  paths, and emit a checksum-adjacent immutable image receipt.

### C. Cloud verification

- [ ] **CLOUD-UNVERIFIED:** generate and review the dependency lock in a
  GitHub-hosted job; do not generate it on the Mac.
- [ ] **CLOUD-UNVERIFIED:** run formatting, lint, strict typecheck, Vitest,
  coverage, build, schema/contract tests, privacy tests, and secret scanning in
  cloud CI and retain the commit-bound receipt.
- [ ] **CLOUD-UNVERIFIED:** after the exact preparation source reaches `main`,
  dispatch `publish-mvp-runtime-image` with the exact commit and
  `PUBLISH-MVP:<commit>` confirmation. Review
  `dark-factory-mvp-runtime-<commit>/image-output/mvp-runtime.json` and its
  adjacent SHA-256 before accepting the immutable reference.
- [ ] **CLOUD-UNVERIFIED:** make the reviewed GHCR MVP runtime package public,
  then resolve or pull its exact `ghcr.io/...@sha256:<digest>` reference from a
  clean unauthenticated cloud context. Require the manifest digest to equal the
  receipt and store the full reference as normal repository variable
  `DF_MVP_DAYTONA_IMAGE`.
- [ ] **CLOUD-UNVERIFIED:** run a no-model synthetic end-to-end iteration and
  verify panel continuity, cache refresh, promotion guard, strict artifacts,
  sandbox teardown, exact candidate/runtime binding, unprivileged build
  identities, and trusted artifact handoff. This is mandatory because the
  executable cloud/process adapters are explicitly outside the unit-coverage
  percentage.
- [ ] **CLOUD-UNVERIFIED:** prove the immutable image, controller bundle, and
  one-at-a-time isolated Pi build trees fit the 10 GiB outer-sandbox disk
  ceiling. Fail readiness without starting paid evaluation if either role
  exhausts disk or memory.
- [ ] **CLOUD-UNVERIFIED:** include each hidden task's official child-sandbox
  CPU, memory, and disk request in private eligibility attestation and reject
  tasks that exceed the current Daytona limits; never reduce official benchmark
  resources to make a task fit.
- [ ] **CLOUD-UNVERIFIED:** verify private Pi fetch/build and Claude/Foundry
  connectivity inside the correct isolated EU sandboxes without logging a
  credential.
- [ ] **CLOUD-UNVERIFIED:** discover and pin the exact Harbor and
  Terminal-Bench 2.1 inputs inside the trusted cloud while releasing no task
  identity.
- [ ] **FIRST LIVE RUN:** with an operator-approved one-iteration budget, run
  one real five-by-three matched comparison and retain its private evidence and
  release-safe receipt.
- [ ] **FIRST LIVE RUN:** if the decision is `promote`, confirm all 30 matched
  cells used fresh evidence and the next iteration would choose a newly
  weighted panel; otherwise confirm the next iteration would retain the same
  panel.
- [ ] **FIRST LIVE RUN:** do not claim that Dark Factory improves Pi until a
  real candidate is promoted by the fresh matched rule.

### D. Operator prerequisites before work resumes

- [ ] **OPERATOR INPUT:** make the pushed MVP branch and GitHub Actions result
  artifacts available for review.
- [ ] **OPERATOR INPUT:** store `DAYTONA_API_KEY` as a protected GitHub
  environment secret in `dark-factory-mvp-paid`, with a required reviewer; do
  not paste it into chat.
- [ ] **OPERATOR INPUT:** if no compliant shared image already exists, create
  the protected GitHub environment `dark-factory-image-publish`, add a required
  reviewer, and add no secrets or variables. Approve only the cloud-hosted
  combined-image publication described above.
- [ ] **OPERATOR INPUT:** provide non-secret references for the Daytona API,
  exact EU target, persistent volume/subpath, and immutable public Linux x64
  glibc image.
- [ ] **OPERATOR INPUT:** create/identify protected Daytona secret names for
  the existing Foundry API key in each role, an evaluator-only nested Daytona
  key, and pre-encoded private Pi HTTPS Basic access, with the host
  restrictions in `CLOUD_DELIVERY.md`.
- [ ] **OPERATOR INPUT:** ensure the immutable image contains the exact
  hard-coded system executables, Claude Code 2.1.217 at
  `/usr/local/bin/claude`, Harbor 0.20.0 at `/usr/local/bin/harbor`, Bun at
  `/usr/local/bin/bun`, default UID/GID `10001`, and reserved UID/GID `65532`
  and `65533` with no pre-existing processes or owned services.
- [ ] **OPERATOR INPUT:** provide the existing Foundry Anthropic-compatible
  base URL and exact optimizer/evaluated deployment aliases. No Azure
  provisioning or deployment work is requested.
- [ ] **OPERATOR INPUT:** confirm the pinned private Pi source values and grant
  the cloud worker fetch plus candidate-ref publication access.
- [ ] **OPERATOR INPUT:** authorize cloud-only Harbor/Terminal-Bench pin
  discovery and hidden inventory creation; the private runtime pin must prove
  at least five exact direct-Daytona, Linux x64 glibc task revisions with
  separate verifier mode at every step.
- [ ] **OPERATOR INPUT:** after image publication, separately authorize the
  evaluator-private runtime-pin/catalog bootstrap, no-model synthetic smoke,
  and bounded connectivity smoke. The image receipt is not evidence for these
  remaining gates.
- [ ] **OPERATOR INPUT:** approve the first-run maximum iteration count and cost
  cap; start with one iteration.
- [ ] **OPERATOR INPUT:** explicitly say `resume` after all protected values are
  configured.

### E. Deferred, explicitly non-blocking

- [ ] **DEFERRED / NOT A BLOCKER:** KMS/HSM and comprehensive Ed25519 signing
  authorities.
- [ ] **DEFERRED / NOT A BLOCKER:** crash-perfect recovery, distributed
  transaction journals, and exhaustive replay/handoff machinery.
- [ ] **DEFERRED / NOT A BLOCKER:** twelve-task validation, shadow pools,
  shadow certification, and active-versus-certified champions.
- [ ] **DEFERRED / NOT A BLOCKER:** E2B, Modal, or any provider beyond Daytona
  EU.
- [ ] **DEFERRED / NOT A BLOCKER:** the full production role-image publication
  and lifecycle pipeline. The secret-free combined-image workflow required by
  the MVP's single `DF_MVP_DAYTONA_IMAGE` input is the narrow exception.
- [ ] **DEFERRED / NOT A BLOCKER:** dashboards, pull-request automation, and
  automated result publication.
- [ ] **DEFERRED / NOT A BLOCKER:** long-campaign alpha spending,
  privacy-budget accounting, and other sequential statistical machinery.
- [ ] **DEFERRED / NOT A BLOCKER:** the full 89-task/five-trial run and official
  leaderboard workflow.
- [ ] **DEFERRED / NOT A BLOCKER:** exhaustive supply-chain and
  production-composition hardening beyond minimum MVP isolation and immutable
  pins.

> The legacy DF-000–DF-200 checklist below is retained as long-term engineering
> research. Only items explicitly repeated in MVP-ESSENTIAL block the first
> loop. Do not work on a legacy production item merely because it remains
> unchecked.

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
- [x] Implement the read-only `df harness doctor` inspection surface.
- [ ] Compose path-free `df harness register` with the protected cloud Git
  worker, exact private-Pi source authorization, registration attestor, and
  governed source index. The sibling `../pi` checkout remains read-only
  planning evidence and is never an executable production input.
- [x] Implement the bounded trusted cloud registration worker and an attestor
  that reads the exact verified result artifact, validates it against the
  signed source authorization and execution receipt, and only then delegates
  release-safe signing to a cloud key authority.
- [x] Implement equivalent parse-before-sign production attestors for the
  exact source archive/bundle manifest and atomic non-force publication
  result. Source snapshot receipt v2 now binds the evaluator tar plus a
  standalone one-head optimizer Git bundle at the reserved experiment-zero
  ref; their cloud key authority and full cloud acceptance run remain pending.
- [x] Reject experiment-zero candidate publication so
  `refs/heads/df/bundle/000-source-snapshot` cannot collide with a real
  candidate bundle.
- [ ] Create the baseline source snapshot v2 in the trusted cloud and seed its
  signed receipt into the same commit-keyed durable source index used for
  promoted candidates before experiment `001`.
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
  policy versions, champion state, and release-safe event records.
- [ ] Define trusted-zone-only schemas for raw trial, grader, ATIF, and
  normalized rows; prohibit them from the governed release-safe experiment
  schema and optional workstation mirror.
- [ ] Enforce `additionalProperties: false`.
- [ ] Implement canonical JSON and SHA-256.
- [ ] Implement schema versioning and migrations.
- [ ] Implement append-only amendments.
- [x] Implement cloud-only canonical atomic state envelopes and non-expiring,
  provider-destruction-attested controller locks for the one-use ledger,
  hidden catalog CAS, optimizer session records, blind-broker leases,
  correctness-gate records/source index, online-error authority, and
  experiment journal.
- [x] Implement source-level fenced mounted-volume coordination ports for
  task-free input preparation, strict checkpoint-chain resume, and durable
  interruption intent/control/CAS, with adversarial and handoff test sources.
- [x] Implement source-level mounted-volume journal artifact assembly,
  leak-scan-before-sign seal authorization, and fixed-category interruption
  attestation authorities, with adversarial and recovery test sources.
- [x] Implement one artifact-backed production verifier for CampaignState
  genesis/control authorizations, ledger transitions, and decisions. It
  enforces canonical exact-payload evidence, content hashes, a trusted-cloud
  source/reader/keyring boundary, and Ed25519 historical-key verification.
- [x] Implement the durable mounted-volume trusted artifact registry and exact
  typed sources/readers for evaluator releases, optimizer released-evidence
  metadata, production-composition evidence sets, campaign attestations, and
  production-bootstrap prerequisites. Enforce atomic index visibility,
  canonical immutable bytes, purpose/namespace binding, exact replay, collision
  rejection, verified reads, and lifecycle handoff without enumeration or
  filesystem fallback.
- [ ] Bind the campaign attestation artifact registry and campaign-purpose
  cloud/KMS keyring, publish the exact genesis evidence before initialization,
  and execute the authored adversarial verifier suite in approved cloud CI.
- [ ] Run the mounted-volume semantics canary and crash/recovery suite against
  the exact production volume class; use a managed transactional store if
  atomic rename and durable synchronization cannot be attested.
- [x] Implement streaming artifact checksum, length, media-type, URI, and
  canonical-byte verification at the trusted registry boundary.
- [ ] Implement disposable cloud-side SQLite index and cloud-controller rebuild.
- [ ] Add positive, negative, property, and corruption fixtures.
- [ ] Acceptance: the complete governed cloud store rebuilds from JSON and an
  optional workstation export remains a read-only mirror; every evidence
  aggregate derives from a signed normalized outcome; raw/sanitized ATIF,
  grader payloads, per-task rows, task IDs, stable handles, and pool membership
  cannot validate as release-safe evidence; mutation, truncation, malformed
  records, and broken references are detected.

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
- [x] Implement the production completion-material adapter that reconciles the
  sealed/unsealed journal, evaluator-owned online-error state, and closed
  in-flight operation ledger through trusted accounting and campaign-seal
  authorities. Its source-level tests are authored but have not run.
- [x] Implement durable external-stop recovery for idle and in-flight
  optimization: reconcile and archive unfinished work, permit a completed
  result to seal, acknowledge the stop without number reuse, preserve a stable
  archive-state control binding across crash retries, let an external stop
  supersede a pending pause only after exact checks, and reject stop reasons
  inferred from untrusted provider text. Cloud signal and recovery execution
  remain pending.
- [ ] Test idempotent resume and repeated stop signals.
- [ ] Acceptance: fault injection at every write and lifecycle boundary cannot
  corrupt the last seal, reuse a consumed panel, reset an attempt/privacy
  budget, or incorrectly move either champion pointer.

## DF-050 — Harbor and ATIF integration

Reference: [PLAN §2.2](./PLAN.md#22-dark-factory-stack),
[§3.3](./PLAN.md#33-evaluator-and-task-broker-zone), and
[§6.5](./PLAN.md#65-trusted-trial-records-and-normalized-release-safe-evidence).

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
  dependency installation remains forbidden. The bootstrap workflow can now
  resolve an exact repository branch tip with read-only checkout, no pnpm
  hooks/workspace configuration, ignored lifecycle scripts, and artifact-only
  output, so the lock can join the implementation pull request without first
  merging unverified source.
- [x] Add a read-only push-triggered cloud formatter/quality workflow for the
  reviewed lock commit. It returns a commit-bound patch and receipt after
  Biome, lint, typecheck, coverage tests, and build; it cannot write the
  branch.
- [x] Add protected, confirmation-bound workflows for cloud quality, first
  lockfile review, task-free Terminal-Bench pin discovery, free staged control
  preflight, role-image publication, and paid control bootstrap.
- [x] Bind free Daytona preflight to its own GitHub environment and document
  the required reviewer protection plus explicit public/provider-authenticated
  image-pull policy.
- [x] Reject Daytona organization-secret target collisions with controller
  configuration, trusted runtime/provider markers, source pins, process
  loader/startup controls, volume identity, and hosted-runner identity before
  creating the control sandbox.
- [x] Make control-bootstrap grants command-specific: synthetic/status have no
  secrets and no network, probe receives only the nested provider credential,
  and optimize alone receives the reviewed additional controller secrets.
  Their parsers and forwarded environment are staged too: offline commands no
  longer require optimizer/evaluated-model, Git, benchmark, budget, descriptor,
  or KMS/controller-secret configuration; probe adds only build/evaluator
  images plus provider probe inputs.
- [x] Implement a release-safe pre-composition `status` command. It persists
  only `awaiting-production-composition`, the control-image digest, and the
  public non-authorizing binding-readiness commitment; it does not claim to be
  real campaign reconstruction.
- [x] Add a strict task-free production-optimize bootstrap descriptor and
  protected GitHub-to-Daytona forwarding path. It campaign-binds one exact
  `TrustedCloudArtifactRef` and independent authority-set, verification-key-set,
  and verifier-policy commitments; canonical JSON/environment data cannot
  select a provider, model, key, verifier implementation, or executable port.
- [x] Add the non-authorizing trusted-cloud bootstrap artifact loader. It
  verifies descriptor authority through an injected verifier, independently
  verifies exact URI/media/length/SHA/canonical bytes through an injected
  trusted-cloud reader, and checks the shared ordered nine-port task-free
  commitment surface while returning
  `compositionAuthorityVerified: false` and
  `executableBindingsCreated: false`.
- [x] Implement the provider-neutral Ed25519 bootstrap-descriptor verifier. It
  accepts only an injected purpose/rotation-aware public-SPKI authority,
  independently configured authority/key-set/policy commitments, and an
  explicit non-overlapping key-version schedule; it rejects private material,
  revocation, detached commitments, invalid/expired/future signatures, and
  mutation while returning one strict deterministic attestation receipt.
- [x] Add the provider-neutral one-shot production composition owner. It
  preattests the manifest, binds source, campaign genesis, and hidden-catalog
  genesis to a strict idempotent bootstrap-or-reconstruct receipt, accepts
  executable ports only from an injected trusted in-process factory, delegates
  `status`/`run` to the sealed production runtime, rejects concurrent/reused
  owners, and drains all registered stores and leases in reverse order on
  every exit.
- [x] Implement the durable provider-neutral bootstrap-or-reconstruct port.
  It verifies the exact signed private-Pi registration plus separate
  purpose/rotation-aware campaign and task-free hidden-catalog genesis
  commitments, binds one request to a fenced mounted-volume phase journal,
  delegates exact domain-state creation/reconstruction, rejects impossible
  cross-store prefixes, registers every acquired resource immediately, and
  returns deterministic bootstrapped/reconstructed receipts without claiming
  cross-store physical atomicity.
- [x] Implement the concrete trusted-cloud nine-port runtime factory. It
  statically constructs the existing durable campaign, coordination,
  completion, journal, cloud-only Claude optimizer, correctness, source-index,
  blind-broker, and evaluator-release components; independently pins the
  manifest/component/operational/ordered-port commitments; requires a separate
  provider/KMS authority to authenticate that dependency attestation against
  the composition verifier receipt; captures dependency methods and data
  against mutation; immediately lifecycle-registers every acquired store;
  cleans partial construction through close-once wrappers; and returns frozen
  canonical-order bindings whose implementations are reference-equal to the
  role components. No JSON or environment field can select a constructor,
  module, command, key, model, task, or port.
- [ ] Bind real descriptor/composition verifiers, artifact storage,
  governed prerequisite registries/key authorities, concrete campaign/catalog
  genesis authorities, the factory's required provider/KMS/artifact/runtime
  dependency objects and independent dependency attestation, durable
  cross-process recovery authority, and same-runtime volume semantics to the
  owner; execute the authored bootstrap phase/crash, source substitution, key
  rotation, mutation, cleanup, and real provider-volume suites only in
  approved cloud CI.
- [ ] Provision the concrete bootstrap descriptor authority, versioned
  authority/key-set/verifier-policy documents, immutable composition artifact,
  and protected environment value; run the descriptor, artifact-reader,
  forwarding, mutation, and expiry suites in approved cloud CI.
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
  mounted-volume integrity round trip and a disposable live provider probe;
  also cloud-verify the free pre-composition `status`. Production `optimize`,
  real campaign status, stop, and resume remain locked until their signed
  composition is complete.
- [x] Replace the production `optimize` generic lock with a provider-neutral,
  fail-closed binding-readiness receipt. It reports the exact fixed
  composition contracts and their hashes without reflecting implementations,
  arbitrary keys, secrets, models, source identities, tasks, or grader data;
  it remains explicitly non-runnable even when every binding is present.
- [x] Bind the source-level production composer to exact in-process wrappers
  for its nine executable runtime ports. The signed manifest and independent
  verifier receipt commit the same fixed task-free ID/digest list; detached
  objects, plain ports, wrapper mutation, recursive manifest/verifier
  inclusion, and JSON/environment executable injection fail closed.
- [x] Implement the concrete provider-neutral artifact-backed composition
  verifier. It cryptographically verifies the manifest and a separately
  purposed, rotation-aware signed envelope for exactly four component, one
  operational, and nine runtime-port evidence artifacts; every artifact is
  bounded, immutable, canonical, expiring, and exactly campaign/manifest
  bound, and its deterministic receipt contains no executable.
- [ ] Provision the real composition/evidence public-key authorities and
  immutable artifact-set source, authorize evidence-envelope signing only
  after provider attestation, and execute rotation, revocation, substitution,
  mutation, and recovery acceptance in protected cloud CI.
- [x] Implement a paid-run readiness check that probes both immutable role
  images and executes `docker info` in a real deny-all evaluator lease; it
  emits commitments only and destroys both leases.
- [ ] Cloud-confirm that the pinned Terminal-Bench image passes that DIND
  execution check and run the live Daytona
  profile/architecture/network/TTL attestation suite.
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
  pre-outcome behavioral extraction/privacy/scanner configuration without
  outcome-derived release hashes.
- [x] Add cloud-key-provider-backed Ed25519 signing and verification for
  broker-private hidden-catalog outcome updates.
- [x] Add a production-only trusted evaluator composition factory connecting
  `TerminalBenchCloudRunner` through deterministic derivation, mandatory raw
  destruction, and signed broker release while rejecting test-only ports.
- [x] Add a durable mounted-volume evaluator replay ledger that atomically
  burns both one-use request ID and request hash before transport, survives
  clean controller handoff, and rejects duplicate or malformed claims without
  exposing hidden panel data.
- [x] Add the provider-neutral artifact-backed evaluator release-bundle
  service that wraps the narrow signed-result service, resolves only committed
  cache/behavioral hashes, verifies bounded canonical bytes, strict schemas,
  content hashes, purpose/rotation-aware signature receipts, exact lineage,
  all-or-none diagnostics, task-safe persistence, mutation resistance, and
  deterministic replay.
- [x] Replace the impossible result/release full-content-hash cycle with the
  domain-separated immutable result identity/derivation source commitment;
  update client/broker validation and add negative legacy-reference tests.
- [ ] Bind the release-bundle artifact source/reader and historical
  purpose-specific signature verifier to governed cloud services, then run the
  authored canonical-byte, signature, partial-release, mutation, replay, and
  legacy-lineage suites in approved cloud CI. Network transport is not part of
  the source-level service.
- [x] Remove post-outcome behavioral `contentHash`/`sourceSetHash` values from
  pre-outcome policy material. Implement a separate post-normalization
  evidence/cards/brief producer, privacy/scanner decision, atomic artifact
  publisher, purpose-specific behavioral-release signer, exact unsigned-result
  source commitment, result-envelope handoff, and issuer-failure orphaning.
  The durable mounted-volume privacy/artifact transaction, exact hash-only
  reader, permanent orphaning, clean lifecycle handoff, and provider-attested
  store-level crash-handoff suite are implemented. Broker one-use
  post-destruction recovery remains separately open below. Protected cloud
  acceptance remains deployment work.
- [x] Keep the hidden privacy ledger and the complete four-artifact behavioral
  bundle behind one mounted-volume state-envelope commit. Validate every
  historical privacy transition, reverse one-use binding, schema/content hash,
  and cross-artifact link on every load; prohibit enumeration, refunds,
  partial visibility, deletion, and rebinding.
- [x] Add a read-only one-use-ledger inspection and reconcile an ambiguous
  result-completion acknowledgement before orphaning diagnostics. A durably
  completed result is returned only when it is byte-exact to the attempted
  envelope; a provably in-flight/consumed result may be orphaned; an unavailable
  or contradictory reconciliation leaves the nonrefundable bundle untouched
  for protected recovery and never rewrites the request as failed.
- [x] Add exact privacy/artifact commit reconciliation for the case where both
  bounded commit acknowledgements are lost. Bind the non-enumerating lookup to
  request, unsigned-result source, authorization, signed-release, and
  artifact-set hashes; return the historical receipt plus four hash references
  only for an exact non-orphaned commit. Prove that inspection spends nothing,
  never refunds, orphans, publishes, or rebinds, and make the broker preserve
  its claim and trusted-private preparation on conflict or ambiguity.
- [x] Replace the process-local, destructively taken behavioral preparation
  map with a fenced exact-query store and integrate its
  `prepared -> finalized -> abandoned` or `prepared -> consumed` transitions
  through the deriver, production composition contract, and broker. Prohibit
  enumeration,
  resurrection, cross-request release rebinding, finalized-to-consumed, and
  abandoned-to-reusable transitions; retain prepared state across ambiguous
  release finalization.
- [x] Normalize every durable behavioral-release orphan acknowledgement into
  one task-free, content-bound receipt and require the preparation store to
  erase the reusable finalization handle when it atomically records that
  receipt. Exact replay returns the historical abandonment attestation and
  every changed binding fails closed.
- [x] Treat only an explicit `known-not-committed` producer error as permission
  to consume preparation and request state; preserve both for every unknown
  finalization exception until protected reconciliation proves the outcome.
- [x] Instantiate and immediately lifecycle-register both the private
  behavioral-preparation store and the atomic privacy/artifact store inside
  the fixed production runtime evaluator adapter. Construct
  `TrustedEvaluationService` there, route only committed behavioral hashes
  through its non-enumerating store-backed release reader, and inject the
  resulting narrow service into the protected blind-broker runtime without an
  optimizer-visible port or preconstructed evaluator-service binding.
- [ ] Execute the evaluator composition, behavioral store, release-overlay,
  lifecycle-failure, and adversarial suites against the provider volume in
  approved cloud CI, then prove provider-attested crash handoff. The source
  tests are authored but were not run on the Mac.
- [x] Implement provider-termination-authorized one-use claim rotation, an
  exact append-only post-destruction recovery record, broker resume without a
  task rerun, exact completion reconciliation, and terminal
  finalization/orphan handling. Source tests cover changed authorization
  bindings and a restart that performs no panel allocation, Harbor execution,
  derivation, or raw destruction.
- [ ] Bind claim recovery to the selected provider's verified sandbox
  termination API, lifecycle-register the mounted recovery store in the
  concrete evaluator bootstrap, and execute restart, acknowledgement-loss,
  and predecessor-fencing tests on the protected provider volume. The
  source-only authority contract does not itself attest a provider API.
- [ ] Replace logical JSON tombstoning with per-record envelope encryption and
  destroy the record data key on finalized/consumed/abandoned transitions if
  provider snapshots or old filesystem blocks fall inside the required
  destruction threat model.
- [ ] If a remote evaluator transport is introduced, register that replay
  ledger with its production lifecycle owner and verify unclean controller
  recovery with provider-attested predecessor termination in protected cloud
  tests. Do not insert it into the MVP's direct in-process release-service path.
- [ ] Bind the raw reader, decryption, Harbor/ATIF decoder, policy material,
  durable stores, and Ed25519 key ports to concrete cloud services; in-memory
  fixtures remain test-only and are rejected by production composition.
- [ ] Strip commands/arguments, paths, filenames, contents, stdout/stderr,
  URLs, package/service names, environment variables, task IDs, stable
  pseudonyms, and grader text before aggregation.
- [ ] Implement the authoritative statistical evidence engine and approved
  failure taxonomy. Repair, fresh-validation, and shadow gate aggregation are
  wired into the canonical deriver; the deterministic release producer is
  wired, while final taxonomy review and cloud calibration remain.
- [x] Require at least five distinct tasks, 20 total trajectories, and five
  observations in every compared group before releasing a card, with an exact
  twelve-pair production preparation check.
- [ ] Aggregate successful-versus-failed and candidate-versus-champion
  behavioral contrasts with effect sizes, uncertainty, task clustering, and
  runtime/budget controls.
- [x] Implement task-free `behavioral-evidence.json`, `failure-cards.json`, and
  `diagnostic-brief.json` generation, exact source binding, allowlisted generic
  recommendations, no-actionable suppression, expiry, and atomic publication.
- [ ] Permit an optional LLM interpreter to see only released aggregate cards;
  require every claim to cite a card and prohibit model-generated statistics.
- [ ] Implement grader/test canary and fingerprint scans. The canonical
  no-literal/no-task firewall and adversarial source-fingerprint tests are
  present, and the scanner registry is now a required signed policy binding;
  the concrete cloud registry population and verification remain.
- [ ] Complete complementary-count and adaptive re-identification hardening.
  Minimum support, task-clustered comparisons, nonrefundable release count,
  duplicate-experiment rejection, and task-disjoint overlap/differencing
  suppression are implemented; cloud concurrency and attack calibration
  remain.
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
- [x] Implement the source-level one-use catalog-genesis loader: bind the
  exact dataset content/manifest/revision pin, capture its trusted source
  before asynchronous work, admit optional baseline/leaderboard rows only by
  immutable commitment, burn failed/replayed loads, and expose only a
  task-free receipt.
- [x] Implement the dedicated cloud-only hidden catalog-material registry and
  bounded canonical bundle producer: content-address inventory and optional
  observation artifacts on the trusted mounted volume, commit their exact
  query bindings once, burn the in-process generic cloud normalizer capability
  before its first asynchronous use, preserve the task-free registry
  invariant, and expose no list/enumeration/artifact-location surface.
- [x] Add a main-commit-bound cloud-only pin-discovery workflow that resolves
  one exact public registry revision with one exact Harbor version, hashes the
  downloaded dataset, manifest, Harbor distribution/executable, and Pi
  adapter, verifies exactly 89 task manifests without printing them, deletes
  all task-bearing material, and uploads only a canonical content-addressed
  receipt with no task names, paths, instructions, graders, or selectors.
- [ ] Run pin discovery in GitHub-hosted cloud, review the receipt and adjacent
  checksum, retain its workflow/run provenance, and populate the protected
  benchmark pin variables from its exact `pin` object.
- [ ] In a trusted cloud evaluator, resolve revision 6 without a mutable alias,
  produce the canonical 89-row normalized inventory bundle, publish it through
  the hidden catalog-material registry, and record cloud acceptance of the
  exact content/manifest hashes. No generated row may cross into optimizer or
  workstation storage.
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
- [x] Implement deterministic failure-weighted priority in source.
- [x] Allocate each five-task repair panel as exactly three hard, one
  uncertain/discriminating, and a fifth slot alternating easy-integrity and
  underexposed-coverage by epoch.
- [x] Implement a deterministic carry ledger so twelve-task panels converge to
  the 60/20/10/10 long-run mix.
- [x] Give every task a nonzero eligibility floor.
- [x] Implement deterministic exposure-age tie-breaking.
- [ ] Execute and calibrate the deterministic selection/property suites in
  protected cloud CI against the reviewed 89-row hidden catalog; source
  implementation and authored tests are complete.
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
- [x] Bind repair attempt one to one completed source-validation allocation
  and select its five cells only from that source panel; bind the real frozen
  hypothesis and candidate/champion archives into the allocation.
- [x] Require repair attempt two to use a distinct candidate on the exact same
  five hidden cells, buckets, order, source request, incumbent archive, and
  hypothesis; reject attempt three and do not advance the easy/coverage epoch
  on retry.
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
- [x] Fail closed if a repair retry resamples the panel or if fresh validation
  does not use the candidate and hypothesis that passed the committed repair
  screen.
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
  from operator-visible release-safe evidence; retain only status, age bands,
  budget compliance, aggregate cost, and signed derivation.
- [ ] Bind each canonical cache-attestation hash into the signed result
  envelope.
- [ ] Implement paired effect and uncertainty estimates.
- [ ] Treat tasks as independent clusters and prevent repetitions from
  inflating effective sample size.
- [ ] Implement the stratified paired Dirichlet-Jeffreys promotion posterior,
  `0.95` positive-delta probability, `0.05` median-effect floor, and stratum
  regression boundary.
- [ ] Complete the campaign-level online error budget calibrated by null
  simulations for repeated promotion attempts:
  - [x] Add finite `[0,1]`, non-refundable accounting to every domain budget
    snapshot.
  - [x] Add an idempotent, request-hash-bound trusted-cloud CAS authority that
    spends before outcome visibility and fails closed on exhaustion.
  - [x] Bind the reservation through canonical policy derivation, signed
    release-safe validation accounting, broker mapping, runner accounting,
    durable mounted-volume state, and adversarial fixtures.
  - [x] Expose an exact-key, task-agnostic reconciliation receipt scoped by a
    canonical domain-separated campaign-ID hash.
  - [x] Reconcile evaluator-burned alpha and every trusted journal/operation
    budget checkpoint before interruption archival, including the
    record-before-archive crash window. The concrete production material
    service and source-level adversarial tests are implemented; cloud
    execution and acceptance remain pending.
  - [ ] Run the cloud-only typecheck, lint, coverage, mounted-volume handoff,
    concurrent-CAS, failure-burn, tamper/replay, and exhaustion tests.
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

- [x] Scaffold the project-local Claude Code plugin manifest, MCP
  configuration, hook configuration, and eight source skill definitions.
- [x] Implement the provider-neutral artifact-backed production optimizer
  resolver. It accepts only a signed source snapshot v2 matching the pinned
  private-Pi registration and active champion, returns its credential-free Git
  bundle, uses one fixed reviewed source-only bootstrap for experiment `001`,
  resolves later proposals by the exact `DiagnosticBriefReference`, and binds
  analysis evidence to the exact hypothesis, candidate, repair, validation,
  and released-evidence commitments.
- [x] Add strict canonical signed optimizer-evidence metadata, purpose- and
  rotation-aware public-key resolution, exact artifact
  URI/SHA-256/media/length checks, task/panel/cell/raw/grader field exclusion,
  captured asynchronous boundaries, immutable outputs, idempotent exact
  retries, and cross-query archive replay rejection.
- [x] Require an independent verifying byte reader before the resolver can
  return any signed evidence reference to Claude. Re-hash and length-check the
  full archive, parse a bounded link-free/traversal-free USTAR profile, scan
  every released JSON/text body for protected paths, identities, encoded
  payloads, and campaign canary fingerprints, enforce a fixed policy-bound
  release-path allowlist, and inspect the signed source tar/Git bundle pair
  against their shared advertised commit as far as their formats permit.
- [x] Make hidden catalog genesis material non-enumerable and immutable so
  routine JSON/canonical serialization and object spreading cannot serialize
  task rows; retain only explicit trusted-broker access.
- [ ] Wire the resolver to governed cloud implementations of the baseline and
  candidate source index, immutable evidence metadata registry, verifying
  artifact bridge, independent release-byte reader, campaign-bound inspection
  policy, fixed reviewed bootstrap reference, and historical purpose-specific
  public-key authority.
- [ ] Execute the resolver/source-bundle focused and adversarial suites in
  approved cloud CI, including malicious false-flag archives, protected and
  encoded literals, traversal, links, nested archives, canary fingerprints,
  unlisted release paths, protected source paths/content, detached source
  commit headers/refs, full-reference cache substitution, mutation,
  truncation, real Git-bundle fixtures, and a representative safe corpus for
  scanner false-positive calibration;
  no Node, package-manager, test, typecheck, build, lint, or formatter command
  is authorized on the Mac.
- [x] Author all eight planned skills, including diagnostic-brief analysis.
- [x] Implement the source read-only evidence MCP tools and one-use, bounded
  `df_get_latest_diagnostic_brief`.
- [x] Implement task-agnostic hypothesis, candidate-staging, analysis, and
  contamination-report tools. Do not expose stage selection or champion
  decisions to the optimizer.
- [x] Enforce request/response schemas, task-agnostic redaction, result limits,
  token budgets, cumulative query/differencing budgets, complementary-count
  suppression, query auditing, and cited-brief binding in source.
- [x] Configure protected paths and allowed tools in source.
- [ ] Build the generated MCP server and hook-guard bundles into the optimizer
  image, verify the exact plugin artifact hash, and cloud-test plugin loading,
  skill triggering, permissions, query budgets, and every denial.
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

- [x] Implement source diff scanning for protected task/instruction fragments.
- [x] Reject test, grader, verifier, solution, reference, benchmark, build, and
  policy paths outside the approved Pi mutation roots.
- [x] Detect encoded payloads and suspicious large constants, including
  printable hex/Base64 task material and payloads split across adjacent
  literals.
- [x] Detect task/environment fingerprint routing.
- [x] Detect solution URLs and unapproved network tools.
- [x] Reject every changed extensionless, opaque, binary, or unapproved source
  format, explicit Git binary patch, symbolic link, and submodule; unchanged
  baseline-pinned binary artifacts remain outside candidate mutations.
- [x] Derive paths and added/deleted counts independently from the unified
  diff, and reject ambiguous headers, negative counts, duplicate paths, or any
  mismatch with caller metadata.
- [x] Wire `scanCandidate` into the production trusted cloud integrity port
  using diff bytes and metadata derived from the same immutable Git objects;
  the cloud Git-bundle worker proves the exact single-parent commits/trees,
  emits a canonical evidence manifest, and the port signs a content-bound
  schema-v2 release-safe receipt.
- [x] Make the correctness gate and durable record store verify the pinned
  integrity receipt key, worker/catalog/policy commitments, authoritative diff
  and changed-path hashes, line-count and mode hashes, and evidence execution
  lineage.
- [x] Keep protected-fragment hashes behind a non-enumerable trusted source and
  exclude raw paths, diff lines, modes, fragments, tasks, and grader material
  from the release-safe receipt and optimizer calls.
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
- [x] Enforce changed-file and mutation-size limits in source.
- [ ] Freeze the hypothesis, cited brief hashes, predicted repair/unseen
  effects, and candidate commit before any panel is selected.
- [ ] Run integrity judging over passing trajectories.
- [ ] Log and inspect evaluated-agent egress.
- [ ] Add the complete adversarial bypass corpus; immutable-tree substitution,
  declared-path substitution, hidden-catalog isolation, and signer
  substitution fixtures are authored.
- [ ] Execute the candidate-integrity scanner and adversarial suites in
  protected cloud CI; source implementation and focused tests are authored but
  have not run on the Mac.
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
- [ ] Cloud-run the independent optimizer archive-byte inspection suite and
  verify the production evidence packager emits the exact strict USTAR profile
  accepted by the gate.
- [ ] Test every lifecycle interruption point.
- [ ] Execute the authored optimization-coordination, production
  completion-material, journal artifact-assembly, seal-authority, and
  interruption-attestor suites in approved cloud CI, including real
  volume-class crash handoff.
- [ ] Execute the concrete runtime-factory suite in approved cloud CI,
  including exact nine-port composition, detached component/port
  attestations, caller mutation, duplicate lifecycle use, partial-acquisition
  cleanup, task-free surfaces, and real mounted-volume close handoff.
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

- [ ] Document cloud deployment and non-executable operator-workstation
  prerequisites.
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
