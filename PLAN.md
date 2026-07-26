# Dark Factory MVP Plan

## 1. Purpose and success criteria

Dark Factory is a TypeScript control plane, authored and triggered from the
operator's Mac but executed entirely in trusted cloud sandboxes, that
continuously proposes, tests, evaluates, and records changes to an open-source
terminal-agent harness. Its first target is Terminal-Bench 2.1, with Claude
Code acting as the optimizer and the operator's private Pi fork acting as the
harness under optimization.

The MVP is successful when it can run this loop unattended:

1. Give Claude Code the latest signed, task-agnostic diagnostic brief. The
   first candidate starts from Pi source alone, with no benchmark-derived
   feedback.
2. Require Claude to freeze a falsifiable hypothesis and candidate before the
   trusted broker selects any evaluation task.
3. Run a cheap **repair gate** on the previous feedback-producing five-task
   panel. This panel may reject or advance a candidate, but can never promote
   it.
4. If the candidate becomes a challenger, compare it with the active champion
   on a newly selected, presealed, hidden twelve-task validation panel.
5. Promote only from fresh same-panel candidate/champion pairs; never compare
   unmatched raw scores from different task subsets.
6. Convert raw grader outcomes and trajectories into allowlisted behavioral
   measurements, aggregate them statistically, and release a privacy-thresholded
   diagnostic brief.
7. Consume the validation panel as future discovery evidence, rotate it out of
   positive promotion use, and repeat until an operator interrupts the
   campaign or a sealed budget pauses it.

The MVP does **not** need to claim state-of-the-art performance. It must produce
credible, reproducible improvement evidence while preventing task-specific
overfitting and grader leakage. The official 89-task, five-trial-per-task run
must never happen without a separate, explicit human authorization.

The research loop and an official leaderboard claim are separate products.
Because the published integrity rules do not explicitly approve an adaptive
meta-optimizer that receives privacy-thresholded benchmark-derived feedback, the
lineage records `leaderboardEligibility` as `unverified`, `cleared`, or
`strict-score-only`. It remains `unverified` until written benchmark-owner
clearance. `strict-score-only` disables diagnostic feedback and is the only
fallback lane intended for an official claim without such clearance.

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
- Dark Factory protocol, blind-broker policy, schema, normalizer, behavioral
  extractor, statistical/privacy, and decision-policy versions.

The system must never:

- Modify Terminal-Bench graders, tests, resources, or timeouts.
- Expose graders, tests, solutions, verifier output, or solution artifacts to
  Claude Code.
- Expose the actual discovery/repair, validation, shadow, or final-evaluation
  task list, identities, instructions, or mappings to Dark Factory or Claude
  Code. The
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

Use the operator's existing private Pi fork in the sibling repository
`../pi` and optimize its coding-agent package. Its configured origin is the
private `parallaxai/df-pi-tbench` repository. Do not create a second fork.
At planning time, `../pi` is a clean Git worktree on `main`, tracks `origin`,
and points at commit `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`. Treat that
SHA as an observation, not the baseline: `df baseline init` records whatever
reviewed commit is pinned when initialization actually occurs.

The same read-only observation currently reports tree
`73898c76210cc8b48f4ac07cc76397b6b5c00758`, package-lock SHA-256
`472f0726dc79f3b38df58d8a8bce96bf56fbf993a134b49aabc54947b8461e59`,
and `@earendil-works/pi-coding-agent` version `0.82.1`. These values form one
indivisible source authorization in the protected cloud bootstrap; they are
not accepted as evidence until the cloud Git worker independently resolves
the private `parallaxai/df-pi-tbench` origin, the exact objects and lock bytes,
the canonical upstream, and the merge base.

The worker result is not trusted merely because it was downloaded from a
sandbox. A verifying artifact reader must check its digest, length, EOF, and
UTF-8 bytes; the registration attestor then parses canonical JSON against the
signed authorization and cloud execution before asking the cloud key authority
to sign a release-safe receipt. The caller independently verifies that
signature before experiment `000` can reference the source.

The same parse-before-sign rule applies to every later source snapshot and
non-force candidate publication. Their attestors read only the exact
content-addressed manifest/result artifact through the verifying bridge,
reproduce its authorization, lineage, archive, bundle, and ref bindings, and
only then ask the cloud key authority to sign. Source snapshot schema v2
contains both the existing uncompressed tar used by the evaluator and a
standalone Git bundle used by the optimizer. The bundle advertises exactly
`refs/heads/df/bundle/000-source-snapshot`, resolves it to the attested commit,
and is independently length- and SHA-256-bound by the worker manifest and
signed receipt. Real candidate publication forbids experiment number zero, so
that fixed source ref cannot collide with
`refs/heads/df/bundle/<positive-experiment-id>`. Merely receiving a provider
artifact reference is never sufficient evidence that a candidate was
snapshotted or published.

The production optimizer resolver consumes only this signed, commit-keyed
source snapshot/index. It must match the pinned private-Pi registration and
the active champion's baseline, experiment number, commit, tree, lock, origin,
upstream, and ref lineage. It returns the credential-free bundle; it never
returns the private remote, credential, or `../pi` path and never reads the Mac
checkout. Experiment `001` receives one fixed reviewed source-only evidence
archive. Every later proposal resolves exactly one signed metadata artifact
for the complete `DiagnosticBriefReference` tuple. Analysis evidence is
separately bound to campaign, experiment, hypothesis hash and document hash,
candidate commit/patch/document hashes, repair and validation attestation
hashes, and released-evidence hash.

All optimizer evidence metadata uses strict exact-key canonical JSON, immutable
URI/SHA-256/media-type/length references, all-false task/panel/cell/raw/grader
flags, and purpose-separated Ed25519 verification through an independently
configured rotation-aware public-key authority. Artifact source and reader
boundary strings do not authorize content: exact digests, signatures,
purpose/version/window/revocation checks, and registration/champion
correlation do. Equal calls are idempotent, concurrent equal calls coalesce,
and one released archive cannot be rebound to a different evidence query.
Inputs are snapshotted before every await, dependency methods are captured,
mutation fails closed, and returned references are defensively frozen. See
ADR-0068.

Those metadata controls are necessary but not sufficient. Before any referenced
archive can be returned toward Claude, the production resolver must use a
separate verifying byte reader, independently recheck the complete byte length
and SHA-256, and inspect the bytes under the campaign-bound release-inspection
policy. Its evaluator-policy commitment must equal the signed production
composition manifest's evaluator-policy binding. Release-evidence tar files
use a strict bounded USTAR profile: unique
relative paths, regular files/directories only, no links, devices, traversal,
PAX ambiguity, nested archives, duplicate names, non-UTF-8 text, or
non-canonical JSON. Every release path must also appear in the policy's fixed,
campaign-bound allowlist; every JSON/text body then passes the release-safety
scanner and the exact forbidden-literal and grader-canary fingerprint sets.
Source tree tar files receive the same structural archive checks plus a
protected benchmark-material path denylist, obvious protected-literal scans,
and exact canary/fingerprint matching over bounded tokens from every
UTF-8-decodable file. Known text extensions fail closed on malformed UTF-8. The
candidate integrity gate separately rejects changed extensionless or
unapproved binary paths and Git binary-patch markers, preventing descendants
from introducing an opaque changed-file channel that this text scan cannot
decode. The
source-specific PAX record is mandatory and may only be Git's first, exact
global comment for the signed source commit. The corresponding Git bundle
receives bounded header/ref validation, must advertise that same commit at the
fixed bundle ref, and receives a raw-byte protected-literal/path scan before
its already-signed commit/tree/lock lineage may be used. Its trusted worker
manifest and source receipt bind both exact artifact references to the one
verified commit, and the independently unpacked source tar is always inspected
before the bundle can be returned. Source registration and publication must
also attest that this Pi lineage has never ingested evaluator artifacts,
because compressed historical Git objects are not a release-feedback channel.
Failed inspections remain failed in the
resolver cache so a retry cannot probe a different backend response; the cache
key binds the full canonical artifact reference, inspection kind, expected
source commit, and policy hash. Boolean `contains*` flags, signatures, registry
key scans, and artifact references can never substitute for this byte gate.
See ADR-0080.

The repository currently has only `origin`. Initialization must verify
[`earendil-works/pi`](https://github.com/earendil-works/pi) as the canonical
read-only upstream in an isolated cloud clone, verify that the
operator-designated origin remains private and writable, and record sanitized
remote fingerprints without persisting a credential-bearing URL. It must not
add or fetch a remote in the canonical local checkout.

Pi is the starting point because it provides:

- An MIT-licensed TypeScript agent implementation.
- Headless print, JSON, and RPC modes.
- First-class extensions, skills, custom tools, system-prompt interception,
  compaction hooks, session events, and structured output.
- A relatively small, inspectable mutation surface compared with OpenCode and
  Cline.
- Existing Biome and Vitest usage.
- A pending/upstream Harbor integration path.

The Dark Factory control plane uses pnpm, but the Pi fork keeps its own
repository-native npm/package-lock workflow. Do not rewrite Pi's package
manager or lockfile merely to match the controller stack; any such change must
be an explicit harness hypothesis.

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
The complete executable control plane also runs in a pinned trusted cloud
sandbox. This includes the TypeScript orchestrator, Claude Code optimizer,
broker, evaluator, evidence writers, Git workers, quality checks, and operator
commands. A provider-managed persistent volume holds campaign state and
release-safe experiment JSON; raw task/grader material stays in the separately
restricted trusted evaluator prefix and is destroyed by policy. The Mac is
limited to source authoring, read-only inspection of the canonical Pi checkout,
triggering an authenticated cloud entry point, and optionally receiving a
read-only mirror of release-safe JSON/Markdown. It never runs `df optimize`,
Claude Code, candidate code, Pi, Harbor, graders, tests, benchmark tasks,
synthetic fixtures, or a provider SDK bootstrap process.

The Daytona implementation uses the exact `@daytona/sdk` `0.200.1` package and
must run at a trusted cloud transport edge. It has the following fail-closed
rules:

- provision only an OCI `repository@sha256:<digest>` reference, with
  `ephemeral: true`, a whole-minute wall-clock TTL, automatic stop/pause
  disabled, private previews, and either `networkBlockAll` or an exact domain
  allowlist;
- require `DAYTONA_TARGET` to equal the requested region class, require memory
  and disk to be exactly representable in Daytona's whole-GiB API, and verify
  returned CPU, memory, disk, region, TTL, network fields, private/ephemeral
  lifecycle settings, cloud runtime marker, zero-GPU state, and `uname -m`
  before issuing a lease;
- map only opaque Daytona organization Secret names to their approved target
  environment names. Never resolve evaluated-model secret values into a
  sandbox request, command, label, receipt, or local log;
- derive the control sandbox's final grants from the command: synthetic and
  status receive no secrets or network, probe receives only the nested Daytona
  credential, and only an authorized optimize command receives the reviewed
  additional controller-secret bindings;
- stage configuration parsing and forwarding by the same boundary: synthetic
  and pre-composition status require only provider/region/control-image plus
  sandbox/volume profile; probe adds only build/evaluator images, provider
  endpoint/secret, and network allowlist; optimize alone parses or forwards
  optimizer/evaluated-model, private-Git, benchmark, budget, descriptor, and
  KMS/controller-secret configuration;
- attach only the command's secret subset, serialize command execution per
  sandbox, and detach the subset after completion;
- translate argv to Daytona's command-string API only with a tested POSIX
  single-quote encoder. A caller-controlled byte is never emitted unquoted;
- stream `trusted://` uploads and downloads through a required trusted artifact
  bridge. The bridge verifies SHA-256, byte length, EOF, and commit metadata;
  stdout and stderr return only as trusted references;
- require both trusted-control-plane and provider runtime markers at the
  artifact edge, while treating those environment markers as a baseline
  fail-closed check rather than cryptographic proof. Production deployment
  must protect them or inject an independently attested runtime guard;
- require a presealed execution ID when concurrent cancellation may be needed.
  Timeout or cancellation uses a confirmed force-stop (with confirmed delete
  fallback), quarantines the now-unusable ephemeral sandbox, and never reports
  success if termination cannot be confirmed;
- derive peak memory from Daytona samples and integrate sampled CPU
  utilization into an explicitly approximate CPU-time receipt. Missing or
  malformed metrics fail the execution instead of producing zeros.

The Daytona probe is an honest capability/profile preflight, not a quota or
account-health attestation. Live create performs the resource and policy
checks. Exact GPU-type requests remain incompatible because the current
returned sandbox metadata exposes GPU count but not an independently
attestable GPU type. Docker-in-Docker is a provider capability only when the
pinned image itself contains and starts the required DIND runtime. Before a
paid campaign, probe both the build and evaluator image digests, create real
deny-all leases for both roles, and require `docker info` to succeed inside
the evaluator lease. The resulting receipt contains only image, capability,
sandbox, execution, resource, network, and mounted-volume commitments; it
never exports Docker output or a sandbox identifier. A trusted artifact
backend, Daytona organization secrets with host restrictions, a cloud-generated
pnpm lockfile, and a live provider contract run remain deployment
prerequisites.

Mutable campaign services use campaign-scoped provider-volume adapters for the
one-use request ledger, hidden catalog CAS, and immutable optimizer-session
records. Each store holds a non-expiring lifetime controller lock and verifies
its durable fence around every canonical atomic state replacement. A clock or
heartbeat can never authorize takeover. Recovery requires a trusted authority
to bind a provider-destruction attestation to the exact old lock hash and fence
epoch before quarantine and a higher-epoch acquisition. Production also
requires a cloud canary to attest exclusive directory creation, same-volume
atomic rename, file/directory synchronization, and the single-controller
deployment policy for the exact persistent-volume class. If those semantics
cannot be attested, use a managed transactional store rather than weakening
the guard.

Primary references:

- [Harbor agent interface](https://www.harborframework.com/docs/agents)
- [Harbor ATIF support](https://www.harborframework.com/docs/agents/trajectory-format)
- [Pi extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Daytona snapshots](https://www.daytona.io/docs/snapshots/)
- [Daytona TypeScript SDK](https://www.daytona.io/docs/en/typescript-sdk/daytona/)
- [Daytona streamed file API](https://www.daytona.io/docs/en/typescript-sdk/file-system/)
- [Daytona organization secrets](https://www.daytona.io/docs/en/secrets/)
- [E2B sandbox creation and network controls](https://e2b.dev/docs/api-reference/sandboxes/create-sandbox)
- [Modal sandboxes](https://modal.com/docs/guide/sandboxes)

## 3. Trust boundaries and architecture

```text
Task-free signed diagnostic brief or reviewed source-only bootstrap
    |
    | byte-inspected, privacy-thresholded optimizer input
    v
Claude Code optimizer
    |
    | frozen hypothesis + isolated Pi worktree edit
    v
Cloud correctness and integrity gates
    |
    | candidate commit
    v
Trusted cloud task broker selects hidden weighted repair panel
    |
    v
Matched repair gate
    |
    | challenger only; never promotion
    v
Fresh matched validation: challenger vs active champion
    |
    | deterministic normalization + aggregate evidence firewall
    v
Strict experiment JSON + signed diagnostic brief
    |                                      \
    | task-free byte-inspected input         \ operator-only audit mirror
    v                                         v
next optimizer hypothesis                   FEEDBACK.md

Trusted Harbor evaluator -> remote sandbox -> sealed grader feeds both
evaluation stages, but raw tasks, graders, and trajectories never cross the
trusted-cloud boundary.
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
- A deterministic Harbor-output packaging boundary. Harbor writes each
  `jobs_dir/job_name` directory only inside the evaluator sandbox; a
  content-addressed, credential-free cloud packager then creates one regular
  POSIX/PAX tar file. Its manifest binds the request, sealed job, benchmark
  pin, config, invocation order, exact Harbor execution receipt, expected
  trial count, every file digest, and an aggregate payload digest. The
  packager rejects links, special files, path traversal/normalization
  collisions, nested archives, unexpected result/trajectory locations,
  incomplete trial sets, and fixed file/byte ceilings before the provider
  artifact bridge may download anything.
- Grader execution.
- Deterministic grader-outcome normalization, behavioral telemetry extraction,
  aggregation, privacy checks, and grader-leak scanning.
- An optional LLM diagnostic interpreter that sees only normalized aggregate
  statistics, never tasks, graders, commands, outputs, or raw trajectories.
- Creation of the minimal signed result envelope returned to the controller.

The narrow trusted evaluator returns only that signed result envelope. A
separate trusted-cloud release-bundle service adapts it to the atomic
`ReleasedEvaluationBundle` consumed by the production blind broker. It may
resolve only the cache-attestation hash committed by the result and, for an
eligible validation release, the behavioral-release hash committed by the
result followed by the evidence/cards/brief hashes committed by that signed
release. Resolution queries contain only a purpose, a content hash, and their
domain-separated query hash. No experiment hint, task identity, path, provider
key, or arbitrary lookup value is accepted.

Every resolved artifact is immutable canonical JSON with one final newline,
bounded independently and in aggregate, and rechecked against its declared
byte length, byte SHA-256, strict schema, semantic content hash, protocol,
experiment, and lineage. Result, cache, and behavioral-release signatures use
an injected purpose- and rotation-aware verifier; diagnostics are returned
only as an all-present or all-absent set. The final bundle must pass the
task-safe local-persistence scan before it can reach the controller. Captured
methods, pre-await snapshots, replay comparison, and defensive output copies
make dependency/caller mutation and nondeterministic completed replays fail
closed. Network transport remains a later deployment adapter rather than a
capability of this service.

This adapter remains consumer-only. The production evaluator now supplies its
missing producer through a strict two-phase sequence:

1. pre-outcome policy commits only whether diagnostics are enabled, the
   comparison, maximum release count, brief TTL, and extraction/statistical/
   privacy/scanner policy versions;
2. while raw evidence still exists, deterministic derivation creates the
   release-safe result aggregate and durably commits one task-private
   behavioral preparation to a fenced evaluator-only store keyed by the exact
   request and protocol hashes;
3. the custodian destroys raw Harbor, ATIF, and grader artifacts and the broker
   verifies the destruction receipt;
4. only then does the broker resolve the preparation without consuming it and
   the producer atomically authorize the privacy/differencing release, create
   task-free evidence/cards/brief, sign a purpose-specific behavioral release,
   and persist the nonrefundable privacy transition plus all four immutable
   documents;
5. the preparation transaction irreversibly replaces the private payload with
   either the exact task-free finalization binding or a consumed tombstone;
   the broker then places a finalized release's content hash in the aggregate
   and signs the final result envelope. If result issuance is then proven not
   to have completed, the producer returns one normalized task-free orphan
   receipt and the preparation store atomically replaces the reusable
   finalization handle with an `abandoned` terminal attestation.

The private preparation store has no list, prefix, iterator, artifact-reader,
or controller-facing method. `prepare` is byte-exact and idempotent;
`resolve` requires both exact hashes; `finalize` binds the preparation,
unsigned-result source, authorization, and release before erasing observations;
`abandon` accepts only the exact normalized orphan receipt for that finalized
binding and erases its reusable handle; and `consume` erases only an
unfinalized payload without permitting resurrection. Lost acknowledgements
replay the identical state transition. A finalized record can become only
`abandoned`, never consumed; an abandoned record cannot be finalized,
consumed, or prepared again; and a consumed record can never be finalized.
Provider-attested predecessor termination and writer fencing are required for
crash recovery.

The atomic store exposes no enumeration operation: its release reader accepts
only purpose plus an already committed content hash. Request, unsigned-result
source, authorization, and release hashes are one-use. A known failure before
durable result completion permanently orphans the complete bundle without
refunding privacy. The exact orphan-store acknowledgement is normalized into a
task-free content-bound receipt, then atomically attached to the corresponding
finalized preparation as an `abandoned` terminal record so recovery cannot
reissue an invisible release. A lost completion acknowledgement is first
reconciled through a read-only ledger inspection: return only the byte-exact
valid envelope submitted to the ambiguous completion call, or orphan and
abandon only when non-completion is proven. If inspection is unavailable or
contradictory, leave the one-use bundle and finalized preparation untouched
for protected recovery rather than risk orphaning a release already named by a
committed result. Repair and shadow never create a preparation and can never
invoke diagnostic finalization. An ambiguous behavioral-release commit retains
the durable prepared state for protected exact reconciliation; it is not
destructively taken or discarded.

The concrete mounted-volume implementation deliberately embeds the hidden
privacy ledger and all four release-safe documents in one strictly validated,
content-hashed transactional state envelope. It does not prepublish the
documents through a second registry, because two durability points would make
prefix visibility and ambiguous split commits possible. Reverse indexes bind
every request, unsigned-result source, release, authorization, and artifact
hash to one historical commit. Recovery revalidates the complete append-only
privacy sequence and all schema/content/cross-document links before answering
an exact content-hash query. Orphaning changes only visibility: the first
orphan marker is permanent, the privacy debit and immutable bytes remain, and
an exact commit replay can never clear or rebind it.

The privacy/artifact commit has its own ambiguity protocol before result
issuance. If both the initial commit acknowledgement and its bounded exact
replay acknowledgement are lost, the producer submits a non-mutating,
non-enumerating inspection containing the exact request, unsigned-result
source, authorization, signed-release, and artifact-set hashes. The store
returns only the exact historical receipt plus four content-hash references,
`absent`, `conflict`, or `ambiguous`. Only an exact, non-orphaned commit with
byte-identical bindings is recovered into a finalization handle. Proven
absence may close the evaluation as failed; conflict, unreadable state, an
orphan marker, or contradictory references preserve both the one-use broker
claim and its exact trusted-private preparation for protected recovery. None
of these paths refunds privacy, republishes artifacts, creates a binding, scans
releases, or orphans a release whose commit status is uncertain.

The service structurally satisfies the blind broker's
`TrustedAdaptiveEvaluationClient` port and is injected directly when evaluator
and controller composition share one trusted-cloud process. In that topology,
`CanonicalEvaluatorClient` is not layered over it: the blind-broker lease and
the wrapped evaluator's durable one-use ledger are the authoritative burns,
while the service's bounded replay record only detects nondeterministic
outputs. If a later deployment separates the processes, an authenticated
transport exposes this service and `CanonicalEvaluatorClient` becomes the
remote implementation of the same port; its durable replay ledger must remain
immediately client-side and burn before transport submission.

The result/release lineage is intentionally asymmetric. The result commits
`behavioralAggregateHash = behavioralRelease.contentHash`; the release and
behavioral evidence commit
`resultEnvelopeBehavioralSourceCommitmentHash(result)`, a domain-separated
canonical commitment over immutable result identity and derivation fields that
excludes the result `contentHash`, signature, and `behavioralAggregateHash`.
The broker computes the same commitment from the exact unsigned eventual
result fields after raw destruction, so the producer never predicts a future
hash. The behavioral release is signed before or at final result issuance;
consumers verify that order and the exact source commitment.
The old full-result-hash reference was cryptographically cyclic and is
backward-incompatible: legacy or fabricated references must be rejected, not
migrated implicitly. See `documentation.md` ADR-0066.

The evaluator is always remote, so task and grader files never land on the Mac.
Raw verifier output and raw ATIF are temporary trusted-zone artifacts and are
destroyed or retained only under the broker's audited retention policy. The
provider-volume release store, and any optional read-only workstation mirror,
contain no raw or redacted per-trial trajectory. They contain only signed
aggregate results, normalized behavioral evidence that passes the release
thresholds, diagnostic cards, and attestations.

The feedback firewall has four ordered layers:

1. A deterministic `NormalizedGraderOutcome` extractor reduces grader output
   to `pass | fail | invalid`, bounded overall reward, infrastructure validity,
   integrity status, and coarse timing/resource buckets. It never copies grader
   prose, assertions, test names, expected/actual values, or subtest details.
2. A deterministic behavioral extractor maps raw trajectories to allowlisted
   typed events and immediately drops literal content and identifiers.
3. A statistical evidence engine aggregates those events across tasks and
   arms, computes uncertainty and candidate/champion contrasts, and enforces
   privacy support thresholds.
4. An optional LLM interpreter receives only the released aggregates and
   writes task-agnostic hypotheses. An LLM is never the sanitizer or the
   authority that decides whether content is safe.

Dark Factory and Claude never receive contributing task identities, raw
traces, per-task feedback, or stable handles that permit joins across
experiments.

### 3.4 Human zone

Only the operator may:

- Authenticate GitHub or sandbox providers.
- Add or rotate secrets.
- Change the frozen benchmark contract.
- Approve an architectural policy change.
- Authorize the official full evaluation.
- Override a promotion decision, with a recorded reason.

## 4. Repository and Git design

`df-demo` contains the Dark Factory source, protocol, schemas, workflows, and
an optional read-only mirror of release-safe evidence. It is not a locally
executed controller or a store for task-bearing evidence. The existing sibling
Git repository `../pi` is a read-only planning-time observation of the
operator's canonical private fork; no production workload reads it. It is not
vendored, recloned, mutated, fetched, built, tested, or converted into a
submodule. Candidate branches and worktrees exist only in isolated cloud
sandboxes created from an independently verified private-origin snapshot.

Implementation sequence:

1. Record the exact read-only `../pi` commit, tree, lock, package version, and
   sanitized origin identity as operator authorization input only.
2. In a trusted cloud Git worker, clone the configured private origin using a
   scoped credential and independently verify privacy, fetch/push authority,
   exact fork objects, and repository-native lock bytes.
3. Resolve the official `earendil-works/pi` upstream and merge base inside that
   disposable cloud clone; never add or fetch a local `upstream` remote.
4. Sign and persist the exact fork commit, upstream base, tree, lock, package
   version, and sanitized remote fingerprints as one registration receipt.
5. Snapshot experiment `000` as an immutable source tar plus credential-free
   Git bundle and publish its protected baseline ref without force.
6. Create one controller-owned cloud branch and cloud worktree per candidate.
7. Start every candidate from the active champion commit.
8. Let Claude edit only that candidate's isolated cloud worktree.
9. Let the controller create commits only after required cloud checks pass.
10. Push sealed experiment branches and accepted champion tags to the private
    origin without force.

If `../pi` is dirty, detached, points to an unexpected repository, or contains
unpublished operator work, fail closed. Never clean, reset, overwrite, or move
those changes automatically.

If GitHub is unavailable, do not create a workstation fallback or call a
candidate sealed. Persist a task-free cloud interruption record, retain the
cloud worktree only within its approved TTL, and resume publication from the
same exact tree after connectivity returns. No promotion decision may depend
on an unpublished candidate identity.

Every experiment records:

- Upstream, fork, baseline, parent, and candidate commit SHAs.
- Canonical repository registration ID, sanitized origin/upstream fingerprints,
  and private-origin verification status; never a credential-bearing URL.
- Git tree SHA and dependency lock hash.
- Canonical patch SHA-256 and changed file list.
- Mutation category and size.
- Cloud worktree and sanitized remote branch/tag references.
- Publication attempts and final status.

Canonical experiment folders, aggregate diagnostic evidence, and derived
query caches remain on the governed cloud volume. An optional read-only export
of task-agnostic signed attestations and privacy-thresholded aggregates may be
placed in this directory for operator review; no runtime reads that mirror.
Raw or sanitized per-trial trajectories, task-keyed champion/baseline cache,
and evaluator audit artifacts remain exclusively in the trusted cloud broker.

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
  -> gates-passed
  -> repair-evaluating                     (skipped only by bootstrap 001)
  -> challenger | rejected | inconclusive
  -> validation-evaluating
  -> analyzed
  -> promoted | rejected | inconclusive
  -> sealed

planned -> shadow-evaluating
  -> certified | not-certified | inconclusive
  -> sealed
```

Rules:

- An experiment becomes a possible parent only after sealing.
- Rejected and inconclusive experiments are sealed and preserved.
- A promoted experiment atomically moves the active-champion pointer.
- A successful shadow experiment atomically moves the certified-champion
  pointer; every other result leaves it unchanged.
- Rejected and inconclusive experiments leave both pointers unchanged.
- The hypothesis, predicted repair behavior, predicted fresh-panel effect, and
  falsification rules are immutable before the broker selects any task.
- Passing the repair gate creates a **challenger**, not a champion.
- Promotion creates an **active champion**. A later feedback-dark shadow audit
  may label it a **certified champion**; these states are never conflated.
- Corrections to sealed evidence use a hash-linked amendment; sealed files are
  never rewritten.
- Each sealed experiment creates exactly one `FEEDBACK.md` entry.

### 5.1 Atomicity and interruption

All writes use temporary files, schema validation, fsync, and atomic rename.
Sealing verifies every referenced artifact and writes a final hash-chain entry.

On SIGINT or SIGTERM:

1. Stop scheduling new trials.
2. Cancel or drain active sandbox work.
3. Persist signed aggregate arm accounting for already completed work; keep
   row-level trial records in the trusted broker.
4. Mark the in-flight attempt interrupted.
5. Do not update the champion.
6. Exit after the controller journal is durable.

On resume:

1. Validate the complete experiment hash chain.
2. Locate the last fully sealed experiment and both champion pointers.
3. Archive the interrupted attempt for audit.
4. Restore a clean worktree from the sealed champion.
5. Allocate a new experiment number; numbers are never reused.
6. Restore the broker-attested panel exposure/cooldown state and cumulative
   repeated-testing and privacy budgets.
7. Continue the optimization campaign.

The production source design gives coordinator input preparation, resume
verification, and interruption handling one fenced, linearizable
mounted-volume state. Input is idempotent per allocation and task-free; resume
accepts only an exact replay or strict extension of the attested checkpoint
chain; interruption intent, broker-exposure accounting, authorized control,
and the final CampaignState compare-and-swap survive controller replacement.

Completion and journal finalization use independent trusted authorities.
Successful completion must match a sealed journal. Interrupted completion
instead reconciles the unsealed journal, evaluator-owned online-error state,
and a closed in-flight operation ledger before an authority attests the
monotonic budget maximum. Release-safe artifact assembly validates the exact
required schema set from task-free providers and requires a hidden-identity
exclusion attestation. The seal authority scans the immutable manifest before
key access, while raw interruption text terminates at an attestor that stores
only a fixed category and commitments. These production adapters and their
adversarial test sources are implemented; cloud-only typecheck, test,
provider-volume recovery, and end-to-end acceptance remain pending.

A stop request may be written by a separate trusted controller while an
optimization claim is in flight. Recovery accepts that monotonic
`running -> stop-requested` path, then takes exactly one of two safe outcomes:
an already completed result seals without changing its disposition and the
campaign acknowledges `stopped`, or unfinished work first reconciles every
burned budget, archives the experiment number and broker-exposure attestation,
and only then acknowledges `stopped`. A durable external stop takes precedence
over a pending pause, but it cannot bypass exact claim or accounting checks.
Interruption control remains bound to the immutable archive-transition hash
across crash retries, including a crash after stop acknowledgement but before
interruption finalization. Provider-controlled exception text never creates an
operator stop; SIGINT, SIGTERM, and operator requests must enter through the
authenticated durable control path.

There is no fixed lifetime experiment count, but every campaign must have an
operator-set rolling monetary/token/wall-time budget and pause when it is
exhausted. Each official task timeout still applies, and the walk-forward
policy bounds the work spent on one hypothesis. The status and feedback
surfaces show cumulative trials, tokens, model cost, sandbox cost, wall time,
holdout availability, and statistical/privacy budget remaining.

## 6. Evidence store and schemas

Use JSON Schema Draft 2020-12. Every persisted JSON object has:

- `schemaVersion`
- RFC 3339 UTC timestamps
- `additionalProperties: false`
- Explicit enums and nullable fields
- Provenance references
- Canonical JSON serialization
- SHA-256 content hash

CampaignState reconstruction uses one artifact-backed production verifier for
genesis/control authorizations, ledger transitions, and experiment decisions.
The verifier derives a single lookup tuple from the exact expected payload,
reads only canonical release-safe JSON through the trusted artifact boundary,
requires byte-for-byte payload equality and a valid content hash, and verifies
an Ed25519 signature against a predeclared historical key set. Genesis and
ledger evidence use their payload hash as the immutable lookup; control and
decision evidence use the authority hash already committed by CampaignState.
The unsigned-document helper is shared with the future cloud/KMS publisher so
the two sides cannot drift. A concrete mounted-volume artifact registry now
provides the injected storage binding for evaluator releases, optimizer
released-evidence metadata, production-composition evidence sets, campaign
attestations, and the three production-bootstrap prerequisites. It writes
canonical JSON to purpose-and-namespace-bound content-addressed URIs through
the verifying artifact bridge, then publishes an exact-query index in one
fenced state transaction. A crash before that index commit can leave only an
unreachable object; it cannot expose a partial behavioral bundle. Exact replay
is idempotent, while locator, purpose, semantic hash, URI, byte hash, length,
or owner collisions fail closed. Readers can resolve one typed exact lookup
only: there is no enumeration, prefix search, arbitrary URI, or filesystem
fallback. The campaign-purpose KMS keyring and all other rotation-aware
public-key authorities remain separate injected operator bindings so storage
cannot appoint its own verification keys.

The requirement to keep logs, traces, hypotheses, and experiments locally is
implemented as **complete local retention of every release-safe artifact**:
control-plane event traces, hypotheses, patches, aggregate behavioral evidence,
decisions, costs, and attestations. Raw evaluator/agent trajectories cannot
also be local without violating the task-blindness boundary, so they remain
ephemeral trusted-cloud audit material. The signed derivation hashes make the
local aggregate evidence auditable without copying the sensitive source.

Each experiment contains:

```text
experiment.json
hypothesis.json
candidate.json
evaluation-plan.json
results.json
cache-attestation.json
behavioral-evidence.json
failure-cards.json
diagnostic-brief.json
analysis.json
decision.json
attestation.json
feedback-entry.json
events.jsonl
```

Per-trial tasks, handles, outcomes, metrics, and trajectories remain in the
trusted broker's audit store. The local experiment directory deliberately
contains no `trials/` directory: individual rows make task reconstruction,
cross-experiment joins, and differencing attacks easier even after literal
redaction.

### 6.1 `experiment.json`

Stores identity, experiment number, slug, lifecycle state, parent experiment,
baseline lineage, champion before/after, timestamps, protocol hash, publication
state, and final disposition.

### 6.2 `hypothesis.json`

Stores:

- The exact source `diagnostic-brief.json` content hash and cited card IDs.
- Observed failure pattern.
- Causal claim.
- Proposed intervention.
- Expected affected harness components.
- Predicted behavioral repair on the discovery panel.
- Predicted accuracy, capability, cost, and latency effect on a fresh unseen
  validation panel.
- Generality justification.
- Falsification criteria.
- Rollback condition.

### 6.3 `candidate.json`

Stores commits, patch hash, changed files, mutation size, test results, integrity
scan findings, and whether all candidate gates passed.

### 6.4 `evaluation-plan.json`

Stores blind-broker, extraction, statistical, privacy, weighting, cache, and
repeated-testing policy versions; opaque panel attestations; aggregate
task-count and difficulty-band summaries; presealed pair ordering; expected
cost; repair and validation stages; valid-arm, retry, and total-attempt
ceilings; reuse decisions; and stopping rules. Actual assignments, task
identities, instructions, selection weights, exposure counts, cooldowns, panel
roles, and pool membership remain exclusively in the cloud broker vault and
are never returned to Dark Factory.

### 6.5 Trusted trial records and normalized local evidence

Inside the trusted evaluator only, an audit record stores a one-use opaque
trial handle, arm, repetition, task assignment, timestamps, environment
identity, raw ATIF, raw grader output, completion status, and artifact hashes.
The handle cannot be correlated across experiments and is never returned to
Dark Factory.

Harbor directory outputs do not cross the provider file-transfer boundary
directly. After every successful Harbor invocation, the evaluator runs the
sealed `package-harbor-output.mjs` module with no secrets. The module requires
the job-level `config.json` and `result.json`, one direct trial `result.json`
and `agent/trajectory.json` per expected arm, and preserves all other regular
logs under `payload/`. It emits a deterministic tar with a canonical root
manifest. The raw ingress verifies and normalizes that archive in memory; only
the tar file is downloaded, never a mutable directory, and neither the tar nor
an extracted tree is written to the workstation.

The evaluator derives a strict `NormalizedGraderOutcome` and allowlisted
behavioral feature rows, signs their source hashes, aggregates them, then
destroys or quarantines the raw artifacts according to the frozen retention
policy. Neither raw nor "sanitized" ATIF is valid local experiment evidence.

`behavioral-evidence.json` stores only release-safe aggregate counts,
distributions, effect sizes, uncertainty, suppression metadata, and policy
versions. It contains no per-task or per-trial row, stable pseudonym, command,
argument, path, filename, content, output, URL, package/service/environment
name, task ID, or grader text.

### 6.6 Results, analysis, and decision

`results.json` stores only the repair disposition, attempt ordinal, integrity
state, aggregate cost, and signed repair-policy attestation; detailed five-task
repair scores, subcriteria, features, and counts remain broker-private. For
fresh validation and compatible historical intersections, it stores paired
candidate/champion comparisons, uncertainty, gains, regressions, invalid-arm
totals, cost, and latency. It records fixed panel-level totals only, never
per-task outcomes or stable join keys.

`cache-attestation.json` stores the broker's task-agnostic proof of cache
eligibility and use: cache-policy version, exact protocol hash, aggregate cache
use status, freshness age-band set, drift status, small-count-suppression flag,
sealed-window bounds, repair budget-compliance status/cost, and derivation
hash. Exact five-task hit, anchor, invalidation, candidate-arm, and
champion-arm counts remain broker-private. It contains no task keys,
identities, mappings, cohort join keys, or per-task cache entries. Its
canonical hash is bound into the broker's signed result envelope.

`failure-cards.json` stores the validated cross-task behavioral clusters
released by the evidence firewall. It contains no task identity, instruction,
stable trial handle, raw command, raw output, path, filename, URL, package or
service name, environment variable, or grader content.

`diagnostic-brief.json` is the sole benchmark-derived evidence package readable
by Claude. It prioritizes release-safe cards, states statistical support and
uncertainty, binds the source experiment, aggregate-evidence hash, and policy
versions, and includes a one-use release identifier. It contains no
task-specific prescription and cannot be queried interactively to narrow a
cohort.

`analysis.json` records whether evidence supports the hypothesis, the observed
failure-card references, unexpected effects, and follow-up recommendations.

`decision.json` records repair disposition, challenger state, validation
promotion state, active and certified champion transitions, policy thresholds,
machine rationale, panel-consumption attestation, and any human override.

`attestation.json` records schema checks, artifact checksums, pinned versions,
grader-leak scan status, and the sealed hash-chain entry.

`feedback-entry.json` is the structured source from which `FEEDBACK.md` is
appended and rebuilt.

### 6.7 Events and index

`events.jsonl` is append-only and validates each record independently. It
captures lifecycle transitions, evidence queries, tool requests, task-agnostic
aggregate evaluator milestones and arm counts, publication attempts, and
operator actions. It contains no per-trial handle, metric, task, or feature row.

A local SQLite index supports fast evidence queries. It is derived entirely
from validated JSON, contains no exclusive information, and is rebuilt by a
CLI command.

## 7. Walk-forward blind evaluation and economy

Neither Dark Factory nor Claude selects or learns the actual tasks. A trusted
cloud task broker owns task identity, instructions, history, selection, panel
roles, exposure, and cooldown state. Dark Factory submits only the frozen
policy version, changed-component taxonomy, requested evaluation stage, and
resource ceiling. The broker returns opaque signed attestations and later
task-agnostic aggregate results.

The broker assigns tasks to four private roles:

- **Discovery/repair:** feedback-consumed tasks used to test whether a candidate
  repairs a previously observed generic failure. They may reject or advance,
  but never positively promote.
- **Validation:** tasks fresh to the frozen hypothesis, presealed after the
  candidate is immutable, and used for the only positive promotion decision.
- **Regression/cooldown:** previously exposed tasks retained for vetoes,
  canaries, historical monitoring, and later repair; they are not discarded.
- **Shadow:** feedback-dark tasks reserved for independent certification.
  Neither Claude nor the normal diagnostic pipeline receives shadow findings.

The broker keeps an append-only private ledger of every task's role, feedback
release, last exposure, reuse count, hypothesis relationship, and cooldown.
Task identities and ledger rows never leave the broker.

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

Selection is deterministic, not pseudorandom. Across panels, target:

- 60% failure-weighted hard tasks, prioritizing tasks failed by earlier
  champion/baseline runs and by the selected comparable leaderboard baseline.
- 20% uncertain or configuration-discriminating tasks.
- 10% easy integrity canaries that detect reward hacking and broad regressions.
- 10% underexposed capability coverage.

For the five-task repair panel, deterministic rounding is exactly three hard
tasks, one uncertain/discriminating task, and one alternating slot: easy
integrity canary on one epoch, underexposed capability coverage on the next.
This preserves both categories despite the small batch. For twelve-task
validation panels, a versioned carry ledger applies largest-remainder allocation
so the long-run mix converges to 60/20/10/10 without pseudorandomness.

Within each quota, use a stable descending priority score and deterministic
round-robin tie-breaking based on exposure age. Every task has a nonzero
eligibility floor for repair/regression selection, but easy tasks receive lower
normal weight. Do not select a task in more than two consecutive experiments
unless it is a declared regression canary. Infrastructure-invalid and
non-discriminating tasks lose priority. Hard but potentially solvable tasks
receive priority over impossible or broken tasks.

Dark Factory receives no task list, name, persistent pseudonym, instruction,
mapping, or selection score. One-use trial handles exist only to join the
trusted evaluator audit within one experiment and are not returned locally.

### 7.1 Walk-forward repair and fresh validation

The loop distinguishes learning evidence from decision evidence:

```text
released discovery brief
        |
        v
frozen hypothesis and candidate
        |
        v
5-task old-panel repair gate --fail--> revise once or close hypothesis
        |
       pass
        v
challenger
        |
        v
12-task fresh matched validation
        |
        +-- promote --> active champion
        +-- reject/inconclusive --> incumbent stays active
        |
        v
release aggregate diagnostics, consume panel, rotate
```

#### Bootstrap

Experiment `001` starts with Pi experiment `000` as the active champion.
Claude receives source code and static documentation but no benchmark outcome,
trace, failure card, diagnostic brief, or task history. It freezes the first
hypothesis and candidate before task selection. Because no released evidence
informed that candidate, it may proceed directly to the normal fresh
twelve-task validation gate. At the decision, the panel is consumed; any
privacy-qualified aggregates become discovery evidence for later experiments.

#### Normal iteration

1. The controller gives Claude exactly one sealed `diagnostic-brief.json`
   derived from the latest eligible discovery window. If no card meets the
   privacy/support rules, the brief contains only `no-actionable-evidence`;
   Claude may form a source-code-only hypothesis, but the normal repair and
   validation gates still apply and it cannot request narrower data. The
   controller does not buy extra benchmark runs solely to force a card over the
   release threshold.
2. Claude records the brief hash, causal hypothesis, predicted repair behavior,
   predicted unseen-panel effect, regressions, and falsification rules. The
   candidate commit is frozen before the broker selects or attests a panel.
3. The broker binds repair to exactly one earlier, completed,
   feedback-consumed validation allocation. On repair attempt one it privately
   selects five tasks only from that twelve-task source panel using the exact
   `3 hard + 1 uncertain + 1 alternating easy/underexposed` rule. It records
   the source request commitment, candidate archive, champion archive, frozen
   hypothesis, and selected cells before execution.
4. Run the candidate once on each repair task. Compare against eligible
   exact-key champion cache distributions, with deterministic fresh champion
   drift anchors; on cache miss or drift failure, run the champion fresh.
5. The repair gate passes only when the Jeffreys repair posterior gives
   `P(weightedAccuracyDelta >= -0.10) >= 0.80` and either: at least one
   **confirmed fail-to-pass**, or the preregistered target behavior improves on
   at least three of five tasks. A confirmed fail-to-pass requires a fresh
   candidate pass and a fresh champion failure on a champion-control slot
   presealed before outcomes; a cached distribution alone cannot label a
   binary transition. Missing or uncertain champion evidence triggers a
   prebudgeted fresh control or makes that route unavailable. A hard integrity,
   capability, cost, or latency regression vetoes advancement. Passing creates
   a **challenger**, never a champion.
6. One discovery panel may support at most two distinct candidate commits. A
   first repair failure returns only the signed gate disposition and original
   brief; it cannot expose a five-task diagnostic slice. A second attempt must
   use a distinct candidate commit but the exact same five hidden cells,
   buckets, order, source validation request, incumbent archive, and frozen
   hypothesis. It does not advance the easy/coverage alternation epoch. After
   the second failure, close the hypothesis and rotate or accumulate a new
   qualifying discovery brief. A third attempt, a different source panel, or
   an easier re-sample fails closed.
7. For a challenger, the broker selects and seals exactly twelve validation
   tasks that were not used in the candidate's repair panel and whose released
   evidence did not inform its hypothesis. It also seals strata, six AB/six BA
   arm order, environment cohort, time window, statistics, and cost limits
   before the first arm runs.
8. Run the challenger and current active champion once per validation task:
   exactly 24 valid fresh arms. Both arms use the same protocol, provider,
   image, region class, resources, and compatible environment fingerprint, no
   more than 24 hours apart. Cache results never replace a validation arm.
9. Decide only from the twelve fresh paired deltas. Repair, cached, baseline,
   and historical results may veto for integrity/regression or aid diagnosis,
   but have zero positive promotion weight.
10. Whether validation promotes, rejects, or is inconclusive, the disposition
    itself is feedback, so the panel is always marked feedback-consumed at
    decision time. It can become the next repair/discovery source and later a
    regression canary, but cannot be reused as positive validation for a
    candidate influenced by that feedback.

A sealed panel abandoned before any arm starts can return to eligibility after
an integrity audit because neither execution nor feedback occurred. Once any
arm starts, an abandoned panel is conservatively quarantined/consumed and can
never return as positive validation; this prevents retry and operational logs
from becoming an accidental selection channel.

This means a failed validation panel can be used again immediately, but only
as the old-panel repair gate the user intended—not as repeated promotion
evidence. Re-running it for promotion after Claude saw its diagnostics would
turn the holdout into training data.

The exact-five reuse rule makes the first repair failure interpretable: the
revised candidate is compared on the same hidden difficulty mix instead of
receiving a new draw. Even then, improvement on the reused cells is only a
screening result. A passing revision must freeze before the broker allocates a
different twelve-task panel that is fresh to the entire hypothesis ancestry.

The repair gate uses five tasks once each, rather than five tasks three times.
Three repeats improve the noise estimate but still provide only five
independent task clusters while spending 15 candidate arms. For this MVP, that
budget is more informative when spent on twelve distinct fresh validation
tasks. Historical/cache distributions, drift anchors, and later regression
runs accumulate stochastic evidence without pretending repetitions are new
tasks. A future protocol may change the replication allocation only after
simulation and a new baseline lineage.

Allow one replacement for an infrastructure-invalid arm and no more than four
replacement attempts per experiment. The primary work is five candidate
repair arms plus 24 fresh validation arms. Repair cache drift or misses require
one to five fresh champion arms. Therefore the typical valid work is 30–31
attempts and the fail-closed maximum is 38 attempts: 34 valid arms plus four
infrastructure replacements. Correctness gates and asynchronous baseline
maintenance have separately predeclared budgets and cannot affect promotion.
Stop as `inconclusive` rather than crossing any sealed arm, cost, token, or
wall-time ceiling. Raising a ceiling changes the protocol version and starts a
new baseline lineage.

Promotion requires:

- Exactly twelve valid fresh matched comparisons across at least two strata.
- A paired Dirichlet-Jeffreys analysis over `(both-pass,
  challenger-only-pass, champion-only-pass, both-fail)`, computed by stratum
  and combined with the presealed stratum weights.
- `P(weightedAccuracyDelta > 0) >= 0.95` and posterior median weighted accuracy
  delta of at least `0.05`, using deterministic quadrature.
- No stratum with `P(stratumAccuracyDelta < -0.10) > 0.80`.
- No hard integrity or correctness failure and no material capability
  regression.
- Cost and latency inside frozen lineage guardrails unless a predeclared
  accuracy trade-off policy applies.

Tasks, rather than repeated trials on one task, are the independent clusters in
analysis. Trial repetitions never masquerade as additional sample size.
Because repeatedly trying hypotheses creates selection pressure even with
fresh panels, the campaign also uses a predeclared online error budget
calibrated by null simulations. The posterior thresholds above are necessary
but not sufficient once the campaign-level budget is exhausted. Ambiguous
evidence yields `inconclusive`; the observed winner is not promoted by default.

The online budget is evaluator-owned durable state, not a counter inferred
from successful experiment results. For every fresh validation request, after
the one-use panel disposition is bound but before Harbor starts, a
trusted-cloud authority atomically reserves and permanently spends the next
`6/(pi² n²)` alpha allocation. The reservation is keyed by the immutable
request hash, idempotent for an exact replay, conflicting for a mutated replay,
and never refunded after provider, normalization, destruction, or release
failure. Exhaustion fails before any outcome-bearing workload starts.

The signed release carries only task-agnostic reconciliation material:
maximum alpha, gate ordinal, exact alpha spent, cumulative spend before and
after, remaining alpha, and commitments to the reservation and prior/resulting
states. The runner accepts it only when the before value equals campaign
usage, the maximum equals the sealed campaign limit, the threshold equals
`max(0.95, 1-alphaSpent)`, and the after value is the exact monotonic result.
The campaign coordinator must additionally reconcile those commitments with
the evaluator authority after interrupted runs, because a failed run still
burns alpha even when no release envelope exists. Before it archives any
interrupted experiment, a trusted completion-material service also reconciles
the experiment journal and operation ledgers into every monotonic campaign
budget dimension. This preserves paid cost, tokens, wall time, attempts,
privacy releases, and promotion looks consumed before the failure. The
controller accepts only a verifier-authorized accounting attestation, records
it before archival, and treats the record-then-archive crash window
idempotently; no failed or abandoned run can reset either alpha or another
budget counter.

If a deployment inserts a separate remote evaluator transport, its
release-facing client has a separate durable one-use replay ledger. It
atomically burns both the canonical request ID and request hash before the
transport is invoked, and never refunds either value after timeout, invalid
release, controller failure, or restart. The ledger is stored on the trusted
linearizable campaign volume under the same provider-attested runtime and
single-writer fencing rules as the other durable authorities. A clean handoff
preserves the burn; an unclean handoff requires provider-attested predecessor
termination. Reusing an ID with different bytes, or replaying the exact
canonical request, fails before any outcome-bearing work can be submitted.
Hidden-panel replacement and reuse remain governed by the broker/evaluator
one-use ledger rather than inferred from this task-free client ledger. The
client ledger contains request commitments and canonical claim times
only—never task identities, panel contents, grader output, or
optimizer-visible evidence.

The MVP's direct in-process release-bundle service does not add that client
ledger. Its outer blind-broker lease and inner evaluator one-use request ledger
already durably consume the operation; adding an uncorrelated third burn would
complicate recovery without creating a new transport boundary.

Newly selected tasks lacking a compatible experiment-`000` observation enter a
broker-private asynchronous baseline-maintenance queue. Baseline comparisons
are reported only over the valid matched intersection, never imputed, and
never enter promotion statistics.

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

The primary repair outcome is binary pass/fail; partial reward remains
diagnostic and cannot turn a failure into a pass. For task `i`, construct
Jeffreys posteriors from the fresh candidate observation,
`Beta(candidatePassesᵢ + 0.5, candidateFailuresᵢ + 0.5)`, and the task's
eligible cached champion observations,
`Beta(championPassesᵢ + 0.5, championFailuresᵢ + 0.5)`. Combine tasks with
equal weight inside each required stratum, combine strata with the presealed
weights, and compute the posterior of candidate-minus-champion accuracy by
deterministic quadrature. The repair gate may reject when
`P(accuracyDelta <= -0.10) >= 0.95`; it may advance only when the §7.1
non-inferiority, behavioral-repair, and non-regression rules pass. Evidence in
the gap is inconclusive. Cache posteriors contribute to aggregate
non-inferiority, but only a presealed fresh champion failure paired with a
fresh candidate pass can be called a fail-to-pass. Thresholds and numerical
tolerances are frozen in the protocol and calibrated on synthetic data before
baseline initialization.

Use the cache in two tiers:

1. **Repair:** the candidate runs once on each old-panel task and may be
   compared with eligible cached champion distributions. Cached evidence may
   reject or advance a candidate to challenger, but it can never promote one.
2. **Validation:** every challenger completes a fresh candidate/current-
   champion pair on twelve newly sealed hidden tasks. No cached observation
   counts as a validation arm or contributes positive promotion evidence.

Define a drift cohort by every non-task cache-key field plus freshness band,
difficulty stratum, and capability stratum. Within each nonempty cache-hit
cohort, select
`max(1, ceil(0.25 * cacheHitCount))` fresh champion anchors, prioritizing repair
slots by descending staleness, exposure age, and the broker-private task
digest. Cache misses and required anchors run a fresh champion repair arm under
the same sealed environment policy.

For each anchor, obtain the cached posterior-predictive pass probability `pᵢ`
and fresh outcome `yᵢ`. Compute
`S = -sum(log(yᵢ * pᵢ + (1 - yᵢ) * (1 - pᵢ)))` and its exact tail probability
by enumerating the cohort's independent Bernoulli outcomes. Fail drift when
that probability is at most `0.01`, or immediately on a provider/environment
fingerprint mismatch. A failure invalidates all otherwise eligible
observations in that exact cohort and forces fresh comparisons. Drift
thresholds, cohort fields, tie-breaking, and rounding are protocol-versioned.

The broker returns only `cache-attestation.json`: cache-use and drift status,
freshness age-band set, small-count-suppression status, aggregate repair
budget-compliance/cost accounting, and sealed-window bounds. Exact five-task
attempt, hit, anchor,
invalidation, and arm counts remain broker-private. It never returns task keys,
cohort join keys, or per-task cache records.

When a candidate is promoted, its fresh validation outcomes are already
stored under its commit and exact protocol key and become the initial cache for
the new champion. This changes no record key and exposes no task mapping.
When validation rejects or is inconclusive, the incumbent's fresh validation
arms refresh its exact-key cache. Consequently, when up to five consumed
validation tasks become the next repair panel, the relevant active-champion
controls are normally already cached. Fresh drift anchors still apply. This is
the intended cost-saving bridge between panel rotation and the next repair.

This policy may create a false negative during cheap repair screening if an old
stochastic outcome is misleading, but it cannot create a false champion:
promotion always requires fresh matched evidence.

### 7.3 Panel reuse, certification, and finite holdout budget

Tasks are not deleted after use. The broker may repeatedly use exposed tasks
for repair, regression vetoes, easy canaries, cache calibration, and capability
monitoring. However, a task whose released evidence informed a hypothesis
cannot positively validate that hypothesis. A just-consumed validation panel
is immediately eligible to supply the next five-task repair panel. That repair
panel may be used by one candidate and one immediate revised candidate only.
After the second attempt—or after the first candidate advances—the contributing
tasks enter a three-sealed-experiment repair cooldown before ordinary
repair/regression reselection. These rules allow useful reuse without
pretending that training data is still a holdout.

At lineage initialization, the broker permanently reserves two disjoint,
twelve-task shadow slices (24 tasks total) before allocating validation
capacity. Shadow tasks never appear in discovery, repair, validation, baseline
feedback, or cards. The reservation count may be reported; identities and
composition remain hidden. With an 89-task benchmark, this leaves at most five
complete twelve-task fresh validation panels (and five spare tasks) before any
other eligibility loss. The status UI must display this finite panel budget
before a campaign begins.

Every third active-champion promotion, and before any external release, consume
one unused shadow slice in a separately sealed feedback-dark race: twelve fresh
matched pairs between the active champion and the last certified champion, or
the experiment-`000` certification anchor when none exists, six AB/six BA,
with no cache substitution. Experiment `000` initializes the anchor pointer but
is not called a certified improvement. An active commit receives at most one
certification attempt. The shadow race has 24 valid arms and at most four
infrastructure-invalid replacements, for a hard ceiling of 28 attempts. Claude
receives no shadow score, behavioral card, trace statistic, or failure
reason—only a signed `certified | not-certified | inconclusive` disposition,
compliance flags, and aggregate cost. A failed shadow gate leaves the certified
pointer unchanged. When both slices are consumed, certification pauses rather
than reusing feedback-bearing dispositions as fresh evidence.

The terms mean:

- **Candidate:** an edited descendant of the active champion.
- **Challenger:** a candidate that passed repair.
- **Active champion:** a challenger that won fresh validation and becomes the
  parent for research iterations.
- **Certified champion:** an active champion that later passed the
  feedback-dark shadow and compliance gates. This is an internal research
  status, not a leaderboard or state-of-the-art claim.

Terminal-Bench 2.1 has a finite task set. Freshness exposure is globally
non-resettable across every descendant harness, optimizer session, protocol
revision, and baseline label that inherits decisions from the adaptive lineage.
Starting a new ledger or repartitioning the same tasks cannot make them fresh.
Once fewer than twelve eligible validation tasks remain, the system must not
weaken the word "fresh." It may continue diagnostics and repair research on
exposed tasks, but positive active-champion promotion pauses until there are
truly unseen external/synthetic validation tasks, a pre-adaptation fork that
inherits none of the exposed lineage's code or decisions, or written
benchmark-owner approval for explicitly different semantics. The human-only
89×5 evaluation remains separate and unopened.

## 8. Anti-overfitting and benchmark integrity

Implement defense in depth.

### 8.1 Grader isolation

- Keep benchmark tests, graders, and raw Harbor job output only in the trusted
  evaluator.
- Copy no grader artifact into `df-demo`.
- Return a minimal signed result envelope.
- Destroy or quarantine raw verifier output and ATIF after signed derivation,
  according to a short, frozen trusted-zone retention policy.
- Scan trajectories and envelopes against grader/test canaries and content
  fingerprints before release.
- Record only match counts and pass/fail attestations, never matched content.

### 8.2 Evidence blindness

Perfect task secrecy and useful optimization feedback are in tension: any score
change reveals some information about the evaluated distribution. The boundary
is therefore **blindness to task identity and grader logic, not blindness to
harness behavior**.

The trusted evidence firewall runs these stages in order:

1. **Normalize the grader deterministically.** Produce
   `NormalizedGraderOutcome` with only `pass | fail | invalid`, reward clamped
   to `[0,1]`, a broad infrastructure-invalid class or `null`, integrity
   status, elapsed-time/resource buckets, protocol hash, environment fingerprint
   hash, and signed attempt/derivation hashes. Reject grader prose, assertion
   or test names/counts, expected/actual values, subtest structure, messages,
   paths, and raw text.
2. **Extract behavior deterministically.** Map raw ATIF to an allowlist:
   generic tool category, invocation validity, exit-status class, retries and
   repeated actions, whether output was inspected, recovery/replan
   transitions, verification behavior, planning/action/token/time buckets,
   context/compaction events, stop reason, premature termination/timeout, and
   generic read/write/execute ordering.
3. **Drop literals before persistence.** Commands and arguments, paths,
   filenames, file contents, stdout/stderr, URLs, package and service names,
   environment variables, unique constants, task IDs, stable pseudonyms, and
   grader messages are neither returned nor placed in the local store.
4. **Compute evidence statistically.** The deterministic engine aggregates by
   approved broad cohort, compares success/failure and candidate/champion,
   reports effect size and uncertainty, controls for runtime/budget, and treats
   tasks as clusters. It, not an LLM, owns all numbers and release decisions.
5. **Enforce privacy support.** A behavioral card needs at least five distinct
   tasks, at least 20 total trajectories in its analysis window, and at least
   five observations in every compared group. Smaller findings accumulate
   privately or are suppressed. Exact small counts become bands.
6. **Release once.** Run grader/test canaries, schema validation,
   complementary-count suppression, overlap and cohort-differencing budgets,
   stable-feature fingerprint checks, and re-identification simulation. Issue
   one sealed `diagnostic-brief.json` per eligible experiment rather than an
   interactive narrowing interface.
7. **Interpret optionally.** An optional LLM sees only the already released
   aggregate cards. It may rank and summarize them, but cannot add statistics,
   infer tasks, or make unsupported task-specific claims. Every statement cites
   a card ID; disabling it cannot change any evaluation decision.

A safe card says, for example: “nonzero shell exits were repeatedly followed
by another execution without output inspection or replanning; this pattern was
more prevalent in failed trajectories.” It may recommend inspecting generic
recovery policy. An unsafe card says which file, command, package, port, or
task-specific tool choice would have succeeded; it must be rejected.

The five-by-one repair gate is intentionally below the 20-trajectory release
threshold. It returns only a signed pass/fail/inconclusive gate result,
integrity status, and aggregate cost. It does not mint a new diagnostic brief
or reveal which repair tasks changed. The 24-trajectory matched validation may
produce a brief only when every support and privacy rule passes.

This is how Claude learns without seeing tasks: it sees statistically supported
generic behavior-to-outcome correlations and candidate/champion contrasts,
not task content or a grader's prescription. Cards are hypotheses about likely
harness weaknesses, not claims about the correct action for a specific task.

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
- Use fresh validation and feedback-dark shadow gates to reduce winner's curse.
- Version every policy change and rebaseline when it changes measurement.

### 8.4 Research and submission modes

Every run declares exactly one immutable mode:

- `research` permits privacy-thresholded diagnostic briefs and adaptive repair,
  but cannot produce a leaderboard claim or start the official evaluation.
- `submission` disables diagnostic generation and retrieval, repair-panel
  feedback, optimizer MCP, and all adaptive research channels. It accepts only
  a frozen certified commit/protocol and requires the human gate in §10.2.

A signed compliance manifest lists enabled data channels, plugin permissions,
panel policy, lineage, and `leaderboardEligibility`. Mixed-mode evidence or an
unverified eligibility state fails closed. Moving from research to submission
does not cleanse an adaptively benchmark-trained harness; benchmark-owner
clearance or a separately acceptable lineage is still required.

## 9. Claude Code plugin and MCP

Create a project-local Claude Code plugin.

### 9.1 Skills

- `dark-factory-workflow`: lifecycle, boundaries, and allowed actions.
- `form-falsifiable-hypothesis`: causal claim, predicted effects, and rollback.
- `query-experiment-evidence`: minimum-relevant, privacy-budgeted retrieval.
- `analyze-diagnostic-brief`: cross-task behavioral analysis without task,
  grader, or panel inference.
- `modify-pi-harness`: Pi architecture, extension points, and test commands.
- `statistical-decision-making`: paired results and uncertainty.
- `benchmark-integrity`: contamination, overfitting, and reward-hacking rules.
- `document-decisions`: experiment records and ADR references.

### 9.2 Read-only MCP tools

- `df_get_campaign_context`
- `df_query_experiments`
- `df_get_latest_diagnostic_brief`
- `df_get_component_history`
- `df_get_regressions`

### 9.3 Submission/request MCP tools

- `df_submit_hypothesis`
- `df_stage_candidate`
- `df_submit_analysis`
- `df_report_contamination`

There is deliberately no optimizer tool for selecting the next evaluation
stage or recording a promotion decision. Those are controller-owned policy
actions.

The MCP server enforces strict schemas, query limits, task-agnostic redaction,
access logs, cumulative differencing/privacy budgets, one-use brief release,
and response token budgets. It exposes no raw or normalized per-task record,
behavioral excerpt, panel role, exposure ledger, arbitrary SQL, file path,
shell, sandbox credential, task selection, task identity, Harbor invocation,
grader access, validation/shadow start action, or full-evaluation action.

### 9.4 Hooks and permissions

Claude hooks:

- Deny protected paths and suspicious commands before tool use.
- Deny WebSearch, WebFetch, uncontrolled curl/wget, and browser tools.
- Validate changed-file allowlists and mutation size.
- Submit focused Pi tests and Biome checks to a cloud sandbox after edits.
- Require a valid hypothesis before edits are accepted.
- Freeze the hypothesis, cited diagnostic-brief hash, and candidate before the
  broker is asked for repair or validation.
- Require a complete analysis before the optimizer session ends.
- Block commit, push, task selection, validation/shadow scheduling, Harbor
  execution, benchmark changes, and full evaluation.

## 10. CLI and public interfaces

Implement these commands:

```text
df init
df doctor
df harness register
df harness doctor
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

`df optimize` continues until interrupted or a rolling statistical, privacy,
holdout, cost, token, or wall-time budget pauses it. `df stop` requests a
graceful durable stop. `df resume` always reconstructs state and budgets from
sealed JSON, not process memory or the disposable index.

### 10.1 Cloud controller entry

No command above is executed on the Mac. An authenticated GitHub-hosted
workflow launches the exact digest-pinned controller image in Daytona, mounts
only the selected campaign subpath of the persistent volume, and supplies only
provider organization-Secret names. Bootstrap validates the hosted-runner
identity, control image, target, resources, network allowlist, TTL, volume
binding, Daytona runtime marker, and confirmed teardown. A paid `optimize`
dispatch additionally requires the literal authorization
`RUN:<campaign-id>:<control-image-digest>` in a protected GitHub environment.

The paid dispatch also requires
`DF_PRODUCTION_OPTIMIZE_BOOTSTRAP_DESCRIPTOR_JSON`: one strict, canonical,
signed, task-free bootstrap descriptor. It binds the campaign, lineage, and
protocol to an exact `TrustedCloudArtifactRef` for the production-composition
manifest and to four non-recursive trust commitments: authority set,
verification key set, verifier policy, and the domain-separated hash of those
three independent values. None of those commitments may be derived from the
descriptor, its signature, or a verifier receipt. The GitHub-hosted bootstrap
parses and campaign-checks the descriptor, re-canonicalizes it, reserves its
environment target against organization-Secret collisions, and forwards it
only for `optimize`; no JSON or environment field chooses a provider, model,
key, verifier implementation, or executable port.

Inside the trusted control zone, a separately injected descriptor authority
verifies the signature and exact trust commitments. A separately injected
trusted-cloud artifact reader is the only path allowed to fetch the referenced
manifest. The loader independently checks the URI, JSON media type, declared
and maximum byte lengths, SHA-256, UTF-8 canonical JSON plus one final newline,
campaign/lineage/protocol/manifest bindings, all-false information-boundary
flags, and the exact ordered nine task-free runtime-port attestation IDs and
digests shared with the production runtime. Its receipt says only that
descriptor authority and artifact transport were verified; it explicitly says
that composition authority is unverified and no executable binding was
created. The production composition owner must separately validate the full
signed manifest, resolve independently supplied trusted runtime-port wrappers,
and authorize construction.

The descriptor verifier is a provider-neutral Ed25519 implementation, not a
boundary-only placeholder. At construction it captures a purpose-specific
public-key authority, an explicit non-overlapping rotation schedule, and the
four independently configured trust commitments. The authority request fixes
the descriptor-signing purpose, key ID and version, signature time, and all
trust commitments. Returned material must be exact public SPKI DER with the
same purpose/version/half-open validity window, matching authority/key-set
hashes, and `revoked: false`; private-key fields and PKCS#8 input have no
accepted representation. The verifier checks the canonical unsigned
descriptor hash, the exact Ed25519 signing payload, freshness both before and
after key resolution, clock-skew policy, and rotation window. Its deterministic
attestation hash binds the signature, resolved key fingerprint and version,
rotation window, resolution request, and all trust commitments. It captures
the authority method and snapshots the descriptor before awaiting external
code, so caller mutation cannot redirect verification. No environment value
is a key authority.

Artifact transport stays on the existing
`VerifyingTrustedJsonArtifactReader` over `TrustedArtifactBridge`; it already
defines the bootstrap loader's reader type through an exact public
`boundary`/`readUtf8` type projection. There is no second reader, local-file
fallback, or provider-selected parsing path.

Before any paid model or benchmark call, the controller supports:

1. `probe`, which round-trips a content-addressed receipt through the mounted
   volume and creates/destroys a no-secret child sandbox using the pinned build
   image; and
2. `synthetic`, which runs a deterministic three-experiment smoke campaign
   covering fresh promotion, repair rejection, fresh inconclusive rotation,
   cumulative accounting, champion preservation, and canary non-release; and
3. pre-composition `status`, which persists only an
   `awaiting-production-composition` receipt, the immutable control-image
   digest, and the public non-authorizing binding-readiness commitment.

These smoke operations do not certify the real evaluator. `optimize`, mutable
campaign status/stop/resume, and baseline initialization stay locked until
their signed durable production composition and cloud quality suite are
complete. Pre-composition status is explicitly not campaign reconstruction.
While that lock remains, `optimize` emits a content-addressed, release-safe
readiness receipt instead of a generic error. The receipt lists the fixed
task-free composition contracts that are missing or malformed, commits to the
complete binding set and supplied attestation hashes, and reduces Pi source
configuration problems to `missing` or `invalid`. It never reflects arbitrary
binding keys, source environment names, implementations, credentials, model
identifiers, task identities, or grader data. Even a complete binding list
reports `runnable: false`; only the separately attested production composition
may authorize execution.

The signed production composition then binds the nine executable runtime
ports—campaign store, input factory, resume verifier, completion material,
interruption port, experiment journal, optimizer adapter, correctness gate,
and blind broker—as one fixed ordered list of task-free port IDs and
attestation digests. The manifest and its verifier remain the two prerequisite
slots in the eleven-slot bootstrap readiness surface; they are intentionally
excluded from the nine-port commitment because either committing to itself
would create a recursive authorization. Each digest is also carried by an
in-process trusted-cloud wrapper whose implementation must be reference-equal
to the actual component port. Only the safe ID/digest list reaches the
independent verifier, and its receipt must reproduce the same
domain-separated canonical commitment. JSON or environment data can therefore
describe commitments but cannot inject executable ports.

The concrete composition verifier is provider-neutral and artifact-backed.
It verifies the manifest with a predeclared, purpose- and rotation-aware
Ed25519 public-key authority, then resolves one separately signed evidence
envelope containing exactly fourteen unique immutable JSON references: four
role-component attestations, one complete operational-binding attestation,
and the nine ordered runtime-port attestations. The evidence-envelope key
purpose, accepted rotation set, and resolved SPKI are distinct from and
disjoint with the manifest-signing keys. Only after both signatures verify
does the bounded
trusted reader accept canonical UTF-8 JSON whose byte length, SHA-256,
content hash, domain, expiry, campaign, manifest, component, operational, and
port bindings reproduce the signed inputs exactly. The deterministic verifier
receipt commits both public-key versions and fingerprints plus the signed
artifact set. Provider-specific artifact registries and public-key authorities
remain deployment bindings; neither environment data nor an evidence document
can name or construct an executable.

One provider-neutral, one-shot composition owner is the only bridge from those
verified commitments to `status` or `run`. Before constructing ports, it
preverifies the manifest and creates a content-addressed, durable-idempotency
request whose source, campaign-genesis, and hidden-catalog-genesis hashes
exactly reproduce the three opaque manifest bindings. A trusted in-process
port verifies the exact signed private-Pi registration and separately signed
campaign/catalog genesis prerequisites. The source identity hash commits the
registration ID, private-origin attestation, commit, tree, dependency lock,
and Pi package version; three disjoint purpose/rotation-aware Ed25519
authorities verify source, campaign, and catalog evidence. The catalog
commitment exposes only the dataset pin, registry revision, seed-set and
weighting commitments, task/disposition key IDs, and all-false
information-boundary flags—never task names, hidden IDs, panels, or grader
evidence.

Bootstrap is a recoverable multi-store protocol, not a cross-store atomic
transaction. A fenced mounted-volume journal binds one request hash and
advances only through `claimed`, `campaign-ensured`, `catalog-ensured`, and
`committed`. Each replay re-verifies every signature and asks the injected
campaign and hidden-catalog authorities to create or exactly reconstruct their
own state hashes. A replayed or partially recovered invocation returns
`reconstructed`; only a new request that created both stores returns
`bootstrapped`. Journal/store disagreement, a catalog whose campaign is
missing, recreation after a later durable phase, a changed request, or a state
hash mismatch fails closed. Every coordination/campaign/catalog resource is
registered with the owner immediately after acquisition. See
`documentation.md` ADR-0069.

The owner then receives components plus all nine
reference-equal wrappers from a trusted in-process factory, composes the
production runtime, and calls the selected runtime method. Every store and
lease acquired during bootstrap, partial factory construction, composition,
or lazy runtime use is registered immediately and closed in reverse order in
`finally`; any close failure fails the invocation. Each owner is permanently
consumed after one call, a process-local campaign fence blocks overlapping
owners, and the concrete campaign store must add the durable cross-process
single-writer fence. See `documentation.md` ADR-0063.

The production implementation of that authority is
`ProductionTrustedCloudRuntimeFactory`. Its constructor accepts only explicit
trusted in-process dependencies and one independently produced, task-free
dependency attestation. The attestation pins the exact manifest hash, all four
component-manifest hashes, the operational-binding hash, and the canonical
ordered nine-port digest list. It cannot name a constructor, module, command,
key, model, task, panel, or grader input. A separate captured provider/KMS
authority must authenticate that attestation against the exact composition
verifier receipt before construction. The factory snapshots every data input
and binds every callable before any lifecycle callback can mutate it.

The factory statically constructs the append-only campaign store; shared
fenced optimization-coordination ports; production completion material;
mounted journal state, artifact assembler, seal authority, interruption
attestor, and evidence store; cloud-only Claude session, artifact-backed
optimizer resolver, and durable session records; correctness runner, durable
records, and commit-keyed source index; and the blind broker, durable lease
store, content-hash-only evaluator release service, and durable diagnostic
publisher. Each backing store is registered immediately. A registration or
later constructor failure closes the partial stack through idempotent
close-once wrappers, while the owner may safely perform its normal final
drain. The nine returned method-captured implementations and their port
bindings are frozen, canonical-order, and reference-equal. The trusted runtime
guard and reviewed mounted-volume semantics are checked before construction.
See `documentation.md` ADR-0072.

Deployment still supplies real provider/KMS/artifact authorities rather than
test fallbacks: campaign transition/decision/control verifiers, optimization
diagnostic/resume/interruption authorities, completion accounting/ledger/seal
authorities, journal policy/provenance/task-exclusion/leak-scan authorities,
the cloud provider and optimizer artifact/key registries, correctness
scan/build/publication/snapshot and receipt authorities, evaluator service and
release artifact/key authorities, broker configuration and source keyrings,
the independent factory dependency attestation, and the exact policy,
provider-readiness, and volume-semantics commitments.

Additional Daytona organization Secrets are mapped only to non-reserved
credential targets. The bootstrap rejects collisions with controller-owned
configuration, cloud/runtime identity, volume and campaign markers, provider
identity, Node/package-loader controls, dynamic-loader controls, shell startup,
locale, and GitHub runner variables before creating a sandbox. Thus a secret
binding cannot replace a validated source pin, protocol choice, runtime marker,
execution path, or provider attestation field.

### 10.2 Full-evaluation authorization

The full run is a separate execution path:

1. `df full-eval prepare` validates readiness and prints the aggregate 89x5
   scope, expected cost, pinned protocol, and a random challenge without
   revealing the task list.
2. The user runs `df full-eval authorize <challenge>` from an interactive TTY.
3. The short-lived authorization is stored outside Claude's filesystem scope
   in a provider-managed secret/KMS-backed authorization store.
4. `df full-eval run` consumes the authorization once and runs the official
   protocol.

Refuse authorization or execution:

- From a non-interactive process.
- From Claude Code, MCP, CI, or a background campaign.
- If the challenge, protocol hash, user confirmation, or TTL is invalid.
- If resources or timeouts differ from the benchmark.
- Unless submission mode is active, the commit/protocol is certified, all
  research feedback channels are disabled, the compliance manifest is valid,
  and `leaderboardEligibility` is `cleared` or an independently acceptable
  `strict-score-only` lineage.

The optimizer plugin contains no reference to the authorization mechanism.

## 11. Feedback and decision documentation

Every sealed experiment appends one generated entry to operator-only
`FEEDBACK.md`. This file is an audit mirror and is never mounted, archived,
queried, or otherwise supplied to Claude Code. The optimizer receives only the
separately signed, privacy-thresholded, byte-inspected diagnostic artifacts
defined in §9. Entries in the operator mirror contain:

- Experiment number, hypothesis, mutation, and candidate commit.
- Source diagnostic-brief hash and candidate/challenger/active/certified state.
- Repair-gate disposition, candidate-attempt ordinal, cache-use status, and an
  explicit statement that repair evidence had zero positive promotion weight.
- Fresh validation comparison with the parent active champion.
- Comparison with the immediately previous experiment only on a
  protocol-compatible matched intersection.
- Comparison with experiment `000` on the valid matched intersection.
- Accuracy delta, uncertainty, valid-pair count, and provenance for fresh
  validation and compatible historical evidence only. Five-task repair
  details remain broker-private; the ledger shows only disposition, ordinal,
  integrity, aggregate cost, cache-use status, and attestation hash.
- Gains, regressions, invalid trials, cost, latency, and cumulative spend.
- Normalizer, extractor, statistical, privacy, cache, and decision-policy
  versions.
- Privacy-supported behavioral cards and suppression status.
- Panel consumption/rotation and task-role attestations without identities or
  stable panel handles.
- Integrity result.
- Promote, reject, or inconclusive decision.
- Active and certified champion transitions. Shadow entries contain only the
  signed certification disposition, compliance flags, and cost—no diagnostics
  or score.
- Recommended next direction.
- Hash reference to `feedback-entry.json`.

`FEEDBACK.md` must be deterministically rebuildable.
Never place two unmatched subset scores beside each other as if their
difference measured improvement.

`documentation.md` is an append-only ADR journal for material architectural and
policy decisions. Every ADR records ID, date, status, context, decision,
alternatives, consequences, evidence, and superseding decision. Experiment
choices belong in experiment JSON; material platform or policy choices require
an ADR. Sealed decisions are superseded, never edited away.

## 12. Testing strategy

All executable commands—including orchestration and provider bootstrap—run in
cloud CI or a cloud sandbox. The Mac may author files, inspect the canonical Pi
checkout read-only, trigger the authenticated cloud entry point, and display
released artifacts; it is not an application, test, control-plane, or workload
execution target.

### 12.0 Cloud delivery gates

Use six separate, explicit cloud delivery paths:

1. a one-time, read-only workflow that runs automatically on the exact
   `codex/dark-factory-mvp` source-only bootstrap branch, or manually from
   `main` once merged, and checks out the exact branch tip to generate an
   uncommitted `pnpm-lock.yaml` review artifact without lifecycle scripts or
   pnpm hooks. The lock can therefore join the same pull request instead of
   requiring unverified source on `main`;
2. a main-commit-bound, no-secret pin-discovery workflow that downloads one
   exact Terminal-Bench registry revision using one exact Harbor version,
   verifies and hashes its 89-task inventory inside ephemeral cloud storage,
   deletes all task-bearing material, and emits only a canonical task-free
   content-addressed review receipt;
3. read-only automated and manually confirmed cloud quality gates that require
   the reviewed lockfile;
4. a manually confirmed free preflight workflow for synthetic,
   pre-composition status, and provider probe. The first two pass no sandbox
   secrets and block all sandbox network; probe receives only its provider
   inputs. None requires paid model, private-Git, benchmark, budget,
   descriptor, or signing configuration;
5. a manually confirmed and protected GHCR publication workflow that first
   passes quality, accepts only digest-qualified role bases, installs exact
   operator-selected Claude Code and Harbor versions, and emits immutable
   control/optimizer/build/evaluator digest receipts with attached SBOM and
   provenance; and
6. a main-commit-bound, protected-environment paid workflow whose typed
   authorization binds campaign and control-image digest before it exposes the
   Daytona bootstrap credential to the single controller-launch step.

No delivery workflow selects a model, provider credential, benchmark pin,
budget, or mutable image tag on the operator's behalf. Image publication never
starts a paid run. See `CLOUD_DELIVERY.md` and ADR-0044.

### 12.1 Unit tests

Cover schemas, state transitions, broker-policy requests, diagnostic
normalization, deterministic behavioral extraction, statistical aggregation,
minimum support and differencing budgets, cache keys, cache invalidation,
freshness and drift, five-task repair, twelve-task validation, online error
budget, panel rotation, active/certified pointers, cost aggregation,
sanitization, diff scanning, protocol hashes, feedback rendering, run-mode
separation, and authorization policy.

### 12.2 Contract and schema tests

- Validate positive and negative fixtures for every schema.
- Validate every MCP request and response.
- Validate positive and adversarial failure-card fixtures.
- Validate Harbor/ATIF adapters against pinned examples.
- Prove raw ATIF, raw grader output, per-task normalized rows, task keys, and
  stable panel handles cannot validate as local experiment evidence.
- Prove every released aggregate traces to a signed
  `NormalizedGraderOutcome` derivation without exposing its row.
- Prove `additionalProperties: false` is enforced.
- Prove migrations preserve sealed evidence and hashes.

### 12.3 Property tests

Use generated cases to verify:

- Broker selection respects failure weighting, quota, easy-canary, exposure,
  and deterministic tie-breaking invariants.
- Five-task repair selection is always `3 hard + 1 uncertain + 1 alternating
  easy/underexposed`, and converges to the long-run target across epochs.
- A discovery panel supports no more than two candidate attempts.
- A just-consumed validation panel may supply the next repair and one revision,
  then enters the exact three-experiment cooldown.
- A cached distribution can support repair non-inferiority but can never create
  a binary fail-to-pass label; that requires a presealed fresh control.
- Validation is disjoint from every task whose released evidence informed the
  frozen hypothesis.
- Every decided validation panel is consumed and rotated regardless of outcome;
  every started-abandoned panel is quarantined/consumed.
- Cached evidence can affect repair but can never satisfy a promotion or
  certification gate.
- Any cache-key difference invalidates reuse, and failed drift anchors force
  fresh comparisons.
- Per-observation expiry prevents a fresh sample from extending stale evidence.
- The repair posterior and drift-tail calculation reproduce exactly from
  the same validated observations.
- Promotion schedules contain exactly twelve valid fresh pairs and no more than
  24 valid validation arms, balanced six AB/six BA; invalid replacements obey
  their separate retry bound.
- Repair/cache/history have zero positive weight in the promotion posterior.
- Tasks are statistical clusters; repeated trials do not inflate sample size.
- Repeated-gate error spending reproduces from the sealed campaign state.
- Candidate/champion pairing never crosses protocol hashes.
- Active and certified champion pointers move only at their respective gates.
- Shadow observations cannot generate a diagnostic brief.
- Two disjoint shadow slices remain separate from validation and are consumed
  at most once; inherited exposure cannot reset under a renamed lineage.
- Hash chains detect mutation and truncation.
- Sealing and feedback append are idempotent.
- Interruptions cannot move the champion.
- Rebuilds produce the same SQLite index and feedback.

### 12.4 Integration tests

Use fake Claude, fake Harbor, synthetic tasks, and synthetic graders inside
cloud CI/sandboxes for:

- Promote, reject, and inconclusive paths.
- First no-feedback candidate; first- and second-attempt repair passes; repair
  exhaustion; and no-actionable-evidence paths.
- Cache-hit repair followed by a completely fresh validation panel.
- Cache miss, expiry, noisy-entry rejection, drift failure, cohort
  invalidation, and promoted-candidate cache seeding.
- Validation pass, fail, and inconclusive paths all consume their decided
  panel; started-abandoned panels quarantine it.
- Shadow pass, fail, and inconclusive paths with no diagnostic output.
- Restart at every repair, challenger, validation, rotation, active-promotion,
  and certification transition.
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
re-identification, overlapping/complementary cohort differencing, adaptive
query attacks, stable-feature fingerprints, panel-role inference, raw-ATIF
persistence, research/submission crossover, and unique-literal leakage. Cache
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

### Phase 1: Workspace and existing private fork

- Create the TypeScript workspace and quality tooling.
- Record the read-only identity of the existing private Pi fork at `../pi`.
- In a trusted cloud clone, verify private-origin fetch/push authority,
  canonical upstream lineage, exact objects, package version, and lock bytes;
  never add or fetch a local `upstream` remote.
- Sign the registration, snapshot the baseline, and implement cloud-only
  worktree isolation.

### Phase 2: Schemas and durable store

- Implement all JSON schemas, including normalized outcomes, aggregate
  behavioral evidence, diagnostic briefs, panel attestations, and active versus
  certified state; add canonical hashing, atomic writes, amendments, events,
  sealing, verification, and index rebuild.

### Phase 3: Lifecycle and Git controller

- Implement the candidate/challenger/active/certified state machine, candidate
  worktrees, commits, both champion pointers, panel rotation, publication,
  interruption, and resume.

### Phase 4: Harbor and sandbox providers

- Pin Harbor.
- Implement the evaluator request/result contract.
- Add Daytona, E2B, and Modal provider adapters and probes.

### Phase 5: Trusted evaluation boundary

- Implement isolated grader execution, deterministic outcome normalization,
  allowlisted behavioral extraction, statistical aggregation, privacy support
  and differencing budgets, optional aggregate-only interpretation,
  diagnostic-brief/failure-card schemas, canary/fingerprint scanning,
  attestation, raw artifact deletion, and adversarial re-identification tests.

### Phase 6: Pi integration and baseline

- Complete or maintain the Harbor Pi adapter.
- Verify headless operation and ATIF.
- Seal `000-pi-baseline` without running the official full benchmark.

### Phase 7: Blind broker and walk-forward evaluation

- Create the cloud-only task catalog, failure-weighted deterministic broker,
  secret panel roles, one-use handles, exposure/cooldown ledger, exact
  five-task weighting, capability strata, cost model, champion result cache,
  drift anchors, bounded repair attempts, twelve-pair fresh validation,
  feedback-dark shadow certification, and repeated-testing rules.
- Admit the catalog through a one-use trusted-cloud loader bound to the exact
  Terminal-Bench 2.1 content, manifest, registry-revision, and 89-task pin.
  Optional initial-Pi and comparable-public-leaderboard observations must be
  named only by immutable commitments and must remain private rows inside the
  broker. The only releasable genesis result is a task-free commitment receipt;
  a failed load burns the loader and cannot be retried against alternate
  material. The returned hidden import is an immutable non-enumerable
  capability property: trusted broker code must access it explicitly, while
  JSON serialization, canonical logging, and object spreading expose only the
  task-free receipt/control fields.
- Seal the loader's inputs in a dedicated hidden-material, content-addressed
  mounted-volume registry. Its bounded producer accepts exactly one canonical
  normalized bundle, verifies the full pin plus 89 unique task-name/revision
  pairs and optional exact observation artifacts, atomically commits only exact
  query bindings, and exposes a three-method capability (`boundary`,
  `loadInventory`, `loadObservations`) with no list, alias, locator, artifact
  reference, or local-mirroring surface. Keep this registry separate from the
  task-free artifact registry so the latter's local-safe invariant is never
  weakened.

### Phase 8: Claude optimizer package

- Build the Claude Code plugin, skills, MCP tools, permissions, hooks, and
  evidence audit trail.
- Compose the provider-neutral artifact-backed optimizer resolver with the
  trusted commit-keyed source snapshot index, immutable released-evidence
  registry, bounded canonical-JSON reader, independent full-byte verifying
  reader, campaign-bound release-inspection policy, and
  purpose/rotation-aware public-key authority.
- Seed the baseline commit's signed source snapshot v2 before experiment
  `001`; later promoted candidate snapshots already enter the same
  commit-keyed index through the correctness gate.
- Pin and review the single source-only bootstrap metadata artifact before the
  campaign. Later proposal and analysis archives are resolved only by their
  exact signed task-free commitments; no arbitrary evidence lookup is exposed
  to Claude Code.

### Phase 9: Analysis, decisions, and feedback

- Implement paired analysis, regression checks, promote/reject/inconclusive
  policy, zero positive repair weight, active/certified transitions, panel
  consumption, baseline comparisons, `FEEDBACK.md`, and deterministic replay.

### Phase 10: Autonomous operation

- Join the components into the walk-forward discovery → repair → challenger →
  fresh validation → rotation loop.
- Add status, graceful stop, restart, provider recovery, and publication retry.

### Phase 11: Integrity and full-run gate

- Complete reward-hacking defenses, trajectory integrity judging, research/
  submission separation, compliance manifests, protected paths, human
  authorization, TTY/TTL checks, and official-protocol validation.

### Phase 12: Validation

- Run synthetic end-to-end campaigns entirely in cloud sandboxes.
- Run a small real Terminal-Bench calibration campaign.
- Audit evidence, costs, interruption recovery, and generality.
- Calibrate the repeated-gate error budget with null simulations.
- Obtain written benchmark-owner clarification before treating adaptive
  research as leaderboard-eligible.
- Leave the 89x5 run locked until both policy and human gates pass.

## 14. Operational assumptions

- The operator-designated private Pi fork already exists at `../pi`, with
  private origin `parallaxai/df-pi-tbench`. At planning time it is clean on
  `main`, tracks `origin`, has no `upstream` remote, and is at
  `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`.
- Remote privacy and fetch/push authorization must still be verified without
  exposing or persisting credential-bearing remote URLs.
- Exact Pi, Claude Code, model, Harbor, dataset, and sandbox versions are chosen
  and pinned during initialization.
- Changing the evaluated model or measurement semantics creates a new baseline
  lineage.
- All builds, tests, synthetic fixtures, controller services, Claude optimizer
  sessions, Pi executions, Harbor processes, graders, benchmark tasks, and
  operator commands run in cloud sandboxes or cloud CI. The Mac is limited to
  source editing, read-only Pi inspection, cloud triggering, and display of an
  optional read-only release-safe evidence mirror.
- Only privacy-thresholded aggregate results and attestations are retained
  locally; no raw or sanitized ATIF or grader payload is local evidence.
- Research experiments may continue indefinitely, but positive promotion and
  certification pause when their genuinely fresh holdout budget is exhausted.
  The official full run is always policy- and human-gated.
- The canonical planning files are `PLAN.md`, `TODO.md`, `documentation.md`,
  and `FEEDBACK.md`; there is no `TASK.md`.
