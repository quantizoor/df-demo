# Dark Factory cloud delivery

This repository deliberately has no local install, test, image-build, or
controller-launch path. The files in this guide are authored on the Mac, but
every executable step runs on a GitHub-hosted runner or inside a pinned Daytona
sandbox.

## Essentials-only MVP fast path

This section is the delivery authority for the first runnable prototype and
implements [PLAN §0](./PLAN.md#0-essentials-only-mvp-authority). The larger
production delivery design below is retained for future reference. KMS/HSM
signing, crash-perfect recovery, twelve-task/shadow programs, extra providers,
the full production role-image publication pipeline, dashboards/PR automation,
long-campaign statistics, the full 89-task run, and exhaustive supply-chain
hardening are deferred and must not block this path. The minimal combined image
preparation below is an MVP-only exception because both current outer roles
consume the single `DF_MVP_DAYTONA_IMAGE` reference.

Nothing is executed on the Mac. Source is pushed to the MVP branch, free
quality checks run on a GitHub-hosted runner, and all Claude Code, Pi, Harbor,
grader, and benchmark execution happens in isolated Daytona sandboxes on an EU
target.

### MVP cloud roles

The GitHub-hosted job is the trusted launcher and receipt collector. It must
not receive the Foundry API key or private-Pi credential. Its sole plaintext
bootstrap secret is `DAYTONA_API_KEY`.

The launcher creates disjoint Daytona roles:

- the optimizer sandbox receives the Pi source bundle, task-free optimizer
  input, the existing Opus 5 deployment alias, and a role-scoped reference to
  the Foundry key;
- the evaluator/controller sandbox receives the hidden catalog, Harbor,
  Terminal-Bench task material, champion/candidate source, the existing Opus
  4.8 deployment alias, and its role-scoped Foundry-key reference;
- only the trusted controller/evaluator mounts hidden selection, raw
  diagnostics, cache, and experiment-private state; and
- no task catalog, task prompt, grader, raw trace, private volume path, or Git
  credential is mounted or copied into the optimizer.

The optimizer uses the image's default unprivileged user. The evaluator is
explicitly created and provider-attested as `root` only so its trusted
controller can create a root-owned mode-`0700` private tree, switch
candidate/champion builds to two isolated unprivileged identities, terminate
all remaining processes for those identities, and securely import the build
artifacts. Pi and source-controlled build commands do not run as root.

The evaluated Pi task sandbox receives one selected task prompt transiently
and never the grader. The sanitizer runs inside the trusted boundary and
exports only strict generic diagnostic cards. A release receipt contains no
task identity or per-task outcome.

### Existing Foundry bindings only

Dark Factory does not deploy or configure Azure. The operator already owns the
deployments and API key. The MVP accepts only:

- `DF_FOUNDRY_BASE_URL`: the existing Anthropic-compatible Foundry base URL,
  ending in `.services.ai.azure.com/anthropic`;
- `DF_OPTIMIZER_DEPLOYMENT`: the exact existing alias for public family
  `claude-opus-5`;
- `DF_EVALUATED_DEPLOYMENT`: the exact existing alias for public family
  `claude-opus-4-8`, evaluated at `high`;
- `DF_OPTIMIZER_SECRET_SOURCE`: the name of the protected Daytona secret
  containing the existing key for the optimizer role; and
- `DF_EVALUATED_SECRET_SOURCE`: the name of the protected Daytona secret
  containing the existing key for the evaluator role.

Both deployment aliases use one fail-closed grammar at every boundary:
1–128 lowercase ASCII characters, written as alphanumeric segments separated
by a single `.`, `_`, or `-`. Uppercase, whitespace, `/`, `@`, `:`, leading or
trailing separators, and adjacent separators are rejected. A representative
valid alias is `team.opus_4-blue`.

The two source names may refer to separately governed copies of the same
existing key. They are names, never plaintext values. Do not put an API key in
GitHub variables, repository files, workflow logs, artifacts, or chat.

### Minimal runtime references

The cloud-only MVP parser currently expects the following non-secret
configuration:

- `DF_MVP_CAMPAIGN_ID` and `DF_MVP_MAX_ITERATIONS` (use `1` for the first live
  run);
- `DAYTONA_API_URL` and an exact EU `DAYTONA_TARGET`;
- `DF_MVP_DAYTONA_IMAGE` as an immutable
  `registry/name@sha256:<digest>` reference. Its evaluator runtime must expose
  the reviewed Harbor 0.20.0 and Bun executables at absolute paths; the private
  runtime pin records both file SHA-256 values;
- both outer roles use the operator's current Daytona Tier 2 non-GPU
  per-sandbox profile of `4` vCPU, `8 GiB` memory, and `10 GiB` disk. Harbor
  child sandboxes retain their separately pinned official task resources. The
  mandatory cloud smoke must prove the immutable image, controller bundle, and
  one isolated Pi build tree at a time fit the outer profile; exhaustion blocks
  before paid evaluation;
- `DF_DAYTONA_VOLUME_ID` and `DF_DAYTONA_VOLUME_SUBPATH`;
- the five Foundry values listed above;
- `DF_PI_GITHUB_OWNER`, `DF_PI_GITHUB_REPOSITORY`, `DF_PI_BRANCH`,
  `DF_PI_BASELINE_COMMIT`, `DF_PI_BASELINE_TREE`, and
  `DF_PI_PACKAGE_LOCK_SHA256`; and
- `DF_GITHUB_SECRET_SOURCE`, the protected Daytona secret name used by the
  trusted Git wrapper for private clone and candidate-ref publication.

Cloud execution also sets `GITHUB_ACTIONS=true`,
`RUNNER_ENVIRONMENT=github-hosted`, and `DF_CLOUD_EXECUTION=1`. The parser
requires these markers and refuses a non-EU target, mutable image, public
Anthropic host, malformed source pin, or missing reference. It does not return
the Daytona key or any Foundry/Git secret value.

The protected secret values themselves are:

1. `DAYTONA_API_KEY` in the protected GitHub environment, used only by the
   launcher; and
2. optimizer and evaluator Foundry API-key copies in protected Daytona
   organization secrets, each restricted to the exact
   `<resource>.services.ai.azure.com` host;
3. a separate evaluator-only Daytona API key in the organization Secret named
   by `DF_HARBOR_DAYTONA_SECRET_SOURCE`, restricted to
   `app.daytona.io`, so Harbor can create and delete its child task sandboxes;
   and
4. a fine-grained private-Pi GitHub token stored in the organization Secret
   named by `DF_GITHUB_SECRET_SOURCE` as the Base64 encoding of
   `x-access-token:<token>`. It needs read access to the pinned Pi repository
   and permission to publish the bounded candidate refs, and is restricted to
   `github.com` and `api.github.com`.

The MVP Git wrapper uses the final value only as an HTTPS
`Authorization: Basic` header. Do not store a raw token, an `ssh://` URL, an
SSH deploy key, or the literal `Basic ` prefix in that secret. Claude Code and
Pi never receive the Git authorization placeholder.

The evaluator Foundry secret has two uses without copying its value: the outer
evaluator receives its own placeholder for the diagnostic classifier, while
Harbor passes the same organization Secret *name* in
`environment.kwargs.secrets`. Daytona then issues a distinct
`ANTHROPIC_FOUNDRY_API_KEY` placeholder directly inside each child task
sandbox. The Pi adapter must inherit that child variable and must never replace
it with the outer evaluator's placeholder.

Harbor 0.20.0 cannot attach Daytona Secrets to compose/Docker-in-Docker tasks.
The first MVP therefore fails closed unless every selected exact task revision
appears in the evaluator-private eligibility inventory as a direct Daytona
task with Linux x64 glibc runtime compatibility and Harbor's separate-verifier
mode. The same private eligibility check must attest that each task's official
child-sandbox CPU, memory, and disk request fits the operator's current Daytona
limits; benchmark resources are never reduced to admit a task. The separate
verifier, not a guessed `/tests` path, is the primary proof that Pi cannot
observe grader material. This limits initial coverage and may bias the
prototype pool; it is not a claim about Pi or about the official evaluation
set.

The immutable Linux x64 glibc image contract is exact. It must contain:

- Node 24 at `/usr/bin/node`, plus `/usr/bin/env`, `/usr/bin/git`, `/usr/bin/npm`,
  `/usr/bin/tar`, `/usr/bin/sha256sum`, `/usr/bin/mkdir`, `/usr/bin/chown`,
  `/usr/bin/pkill`, and `/usr/bin/pgrep`;
- a POSIX shell at `/bin/sh`, `/bin/false`, `/dev/null`, `/usr/bin/gzip`,
  `/usr/bin/python3`, `/etc/ssl/certs/ca-certificates.crt`, and a
  GNU-compatible `/usr/bin/tar`;
- Claude Code 2.1.217 at `/usr/local/bin/claude`;
- Harbor 0.20.0 at `/usr/local/bin/harbor` and Bun at
  `/usr/local/bin/bun`; the private runtime pin records both exact paths and
  matching SHA-256 values;
- default unprivileged UID/GID `10001`, with writable `/workspace` and no
  pre-existing `/tmp/df-mvp-controller`; and
- unused, dedicated UID/GID pairs `65532` and `65533`. They must own no
  pre-existing service and have no unrelated process, because the trusted
  evaluator kills and verifies every process for the relevant build identity
  before importing an artifact.

The combined image is only for the essentials-only MVP. Its default
`10001:10001` identity runs the optimizer; Daytona overrides the evaluator to
`root`, which then switches only candidate/champion builds to reserved
`65532:65532` and `65533:65533`. Binaries and their dependency trees must be
root-owned and non-writable by all three unprivileged identities. The image
must contain no credential or project state and must idle until Daytona invokes
an explicit bounded command.

### Cloud-only preparation of the shared MVP image

If an independently reviewed image already satisfies the contract above, use
its anonymously verified digest. Otherwise prepare the image only after the
reviewed source and dependency lock have been pushed, cloud quality checks have
passed, and the exact image-preparation commit is on `main`:

1. Create the protected GitHub environment `dark-factory-image-publish` and
   add a required reviewer. Add **no secret and no environment variable** to
   it; image preparation receives no Daytona, Foundry, Git, model, benchmark,
   or paid credential.
2. From `main`, manually dispatch `publish-mvp-runtime-image` in
   `.github/workflows/publish-mvp-runtime-image.yml` for the exact reviewed
   `source_commit` and confirmation `PUBLISH-MVP:<source_commit>`. All base,
   builder, tool, and package values come from reviewed
   `containers/mvp-runtime-pins.json`; there are no mutable operator-supplied
   version inputs.
3. Download artifact `dark-factory-mvp-runtime-<source_commit>` and verify the
   adjacent checksum for `image-output/mvp-runtime.json`. Review its
   Linux/amd64 platform, source/workflow identity, Containerfile and pin
   digests, exact tool versions/paths/hashes, default `10001:10001` identity,
   free reserved identities, SBOM/provenance markers, offline smoke result, and
   `ghcr.io/...@sha256:<digest>` immutable reference.
4. In the GHCR package settings, change that exact package's visibility to
   **public**. Do not add registry credentials to Daytona as a workaround for
   a private package.
5. From a clean unauthenticated cloud context, resolve or pull the immutable
   reference and verify that its reported manifest digest exactly matches the
   reviewed receipt. A successful authenticated pull is not this proof.
6. Store the full anonymously verified
   `ghcr.io/...@sha256:<digest>` reference as the normal GitHub repository
   variable `DF_MVP_DAYTONA_IMAGE`. It is not a secret; never store a mutable
   tag or only the bare digest.

This workflow builds and publishes an image; it does not launch Daytona, run a
model, fetch private Pi, execute Harbor, inspect Terminal-Bench, or authorize a
paid iteration. Do not run Docker, install packages, or execute the image on
the Mac.

### MVP verification order

1. Push the complete source-only MVP branch.
2. In GitHub-hosted CI, generate/review the dependency lock if absent, apply
   formatting there, then run lint, strict typecheck, Vitest/coverage, build,
   schema/privacy tests, and secret scanning. A workflow file is not proof; a
   passing commit-bound receipt is.
3. Prepare or verify the shared public MVP image through the cloud-only
   procedure above, then configure only the runtime references and protected
   secrets listed above.
4. In the evaluator-private cloud boundary, create the runtime pin and hidden
   inventory: resolve and pin the exact Harbor and Terminal-Bench 2.1 inputs,
   the Harbor and Bun executable paths/digests, the Pi adapter digest, the
   Linux x64 glibc runtime ABI, and initialize the hidden weighted catalog.
   No task name, prompt, grader, or raw discovery output may be downloaded or
   uploaded as a release artifact.
5. Run a no-model synthetic iteration to prove five-by-three panel creation,
   cache behavior, fresh-promotion enforcement, same-panel continuation after
   non-promotion, strict JSON storage, and sandbox teardown.
6. Run a bounded connectivity smoke for private Pi, Claude Code, the two
   existing Foundry deployments, Harbor, and evaluator sandbox nesting. Delete
   task-bearing smoke output inside the evaluator boundary.
7. With an operator-approved one-iteration cost cap, run the real five-task,
   three-repetition matched race. A cold-cache race produces 30 trials; Harbor
   may schedule up to five trials concurrently, while each Pi agent remains a
   single run.
8. Review the release-safe decision and private cloud evidence. Continue only
   after the operator explicitly authorizes another iteration.

### Mandatory stop before testing

After source completion, the implementer must stop. It must not configure
credentials, start paid models, fetch private Pi into an execution sandbox, run
Harbor, or touch hidden benchmark material until the operator has completed
all items below and explicitly says `resume`:

- make the pushed branch and its GitHub Actions results available for review;
- place `DAYTONA_API_KEY` in the protected GitHub environment;
- create reviewer-protected, secret-free `dark-factory-image-publish`, publish
  the combined MVP image from `main` if no compliant image exists, make the
  reviewed GHCR package public, anonymously verify its digest, and store its
  full immutable reference in repository variable `DF_MVP_DAYTONA_IMAGE`;
- supply the Daytona API URL, exact EU target, persistent volume/subpath, and
  immutable public image reference, including the absolute Harbor 0.20.0 and
  Bun executable paths that will be digest-pinned in the evaluator-private
  runtime pin and every exact system executable/reserved identity in the image
  contract above;
- create or identify Daytona organization Secret names for the existing
  Foundry key in both outer roles, the evaluator-only nested Daytona key, and
  the pre-encoded private-Pi HTTPS Basic credential; apply the exact host
  restrictions described above;
- supply the existing Foundry base URL and exact Opus 5/Opus 4.8 deployment
  aliases;
- confirm private Pi source pins and the cloud credential's fetch/candidate-ref
  permissions;
- authorize cloud-only Harbor/Terminal-Bench pin discovery and creation of the
  evaluator-private direct-sandbox eligibility inventory;
- choose the first-run cost cap and maximum of one iteration; and
- explicitly say `resume`.

Do not paste API keys, SSH private keys, tokens, graders, task prompts, or task
identities into chat. The deferred production items are not prerequisites for
resuming this MVP.

> **Legacy delivery note:** all sections below describe the earlier
> production-grade route. Use them only after an explicit post-MVP scope
> expansion. Where they conflict with this fast path, this section wins.

## Delivery order

1. Review and merge the delivery workflows and role Containerfiles.
2. If `pnpm-lock.yaml` does not exist, push the source-only implementation to
   the exact bootstrap branch `codex/dark-factory-mvp`. That first push
   automatically runs `bootstrap-pnpm-lockfile-review-artifact` from the
   branch itself. Once the workflow is available on `main`, an operator may
   instead dispatch it manually with the source branch's exact
   `refs/heads/...` ref, exact tip commit, and literal confirmation
   `GENERATE PNPM LOCKFILE`. Both paths check out the exact branch tip with no
   persisted credential, reject pnpm hook/workspace configuration, and
   resolve only a lockfile with lifecycle scripts disabled. This avoids the
   impossible requirement that untested source first merge to `main` just to
   generate its own lock.
3. Download the immutable artifact, verify its adjacent SHA-256 file, review
   the full lockfile, and add only `pnpm-lock.yaml` to that same branch in a
   new commit. The bootstrap workflow never commits, pushes, opens a
   pull request, receives a repository write token, or runs a package script.
   Pushing that reviewed lock commit automatically runs
   `cloud-format-and-quality-review-artifact`: GitHub installs from the frozen
   lock, applies Biome in its runner, then runs lint, typecheck, coverage tests,
   and the build. It uploads a source-commit-bound patch and receipt but has no
   repository write permission.
4. Verify the patch checksum and receipt, review and apply only the formatter
   patch to the same branch, and open the pull request. Let
   `cloud-quality-gates` pass on the pull request and again on `main`.
5. From `main`, dispatch
   `discover-terminal-bench-pin-review-artifact` with the exact main commit,
   exact registry revision, exact Harbor semantic version, and its
   `DISCOVER:...` confirmation. Review and retain only the emitted canonical
   receipt and adjacent checksum. It contains the benchmark/dataset identity,
   revision, count, Harbor version, content hashes, source commit, policy hash,
   and receipt hash—never a task name, task instruction, grader, selector, or
   task-relative path. Record its `pin` fields in the protected production
   configuration. The task-bearing download and download log are deleted
   before artifact upload.
6. Configure the protected `dark-factory-image-publish` GitHub environment with
   required reviewers. It needs no benchmark or model secret.
7. Dispatch `publish-role-images` from `main`. Enter the exact source commit,
   `PUBLISH:<source_commit>`, four independently reviewed digest-qualified base
   images, the selected exact Claude Code version, and the exact Harbor version
   from the reviewed pin receipt. Also provide an exact Buildx release and
   digest-qualified BuildKit driver image; the workflow has no mutable builder
   fallback.
8. Review the four digest-receipt artifacts. Copy only each
   `immutableReference` and `digest` to the protected paid environment. SBOM
   and max-mode provenance attestations are attached to each image in GHCR.
9. Dispatch `cloud-control-preflight` for `synthetic`, `status`, and then
   `probe`. These paths need no optimizer model, evaluated model, Pi Git
   source, benchmark pin, budget, paid authorization, bootstrap descriptor, or
   KMS/controller secret bindings. Only the GitHub-hosted bootstrap needs the
   Daytona credential to create and destroy its disposable control sandbox;
   `synthetic` and `status` pass no secret and have networking blocked inside
   that sandbox. `probe` passes only the named nested Daytona provider secret
   and the reviewed network allowlist.
10. Configure `dark-factory-paid`, require human reviewers, and dispatch
   `protected-paid-optimize` only after the run budget and image identities are
   approved.

The image workflow publishes images; it never starts Claude Code, Pi, Harbor,
Terminal-Bench, Daytona, or any paid model. Only the free preflight and paid
control workflows receive the Daytona bootstrap credential. The offline
preflight commands do not forward it into the control sandbox. Pin discovery
uses only the public registry and receives no provider, model, Git, or signing
secret.

The protected controller must mount the governed linearizable campaign volume
before composing production ports. The MVP injects the trusted evaluator
release-bundle service directly into the durable blind broker and does not add
a network endpoint. If a later deployment inserts a remote evaluator
transport, its canonical client must use the dedicated mounted-volume replay
ledger and burn each request ID and canonical request hash before submission.
A timeout or invalid remote release is not retryable with the same request or
panel; the trusted broker must allocate a replacement within the sealed
budget. Controller recovery may open that ledger only after a clean lease
release or a provider-attested predecessor-termination authorization.

Before experiment `001`, the protected controller must also run the trusted
Git source snapshot v2 path for the registered baseline commit and seed the
signed receipt into the governed commit-keyed source index. That operation
produces two immutable artifacts from the same verified cloud clone:

- the uncompressed tar retained for evaluator harness execution; and
- a standalone Git bundle advertising exactly
  `refs/heads/df/bundle/000-source-snapshot` for credential-free optimizer
  setup.

The same trusted bootstrap must populate the hidden catalog-material sidecar.
Resolve exactly Terminal-Bench 2.1 registry revision 6 using the frozen
content and manifest hashes—never a mutable `latest` alias—then normalize the
89 unique package-name/revision-digest pairs and any approved exact baseline
or comparable-public observation artifacts into one bounded canonical JSON
line. Publish it once through
`MountedVolumeTrustedCatalogMaterialRegistry`. Only its task-free publication
receipt may leave the evaluator/broker trust zone; neither the normalized
bundle, its object references, nor the private registry volume may be copied
to the Mac or optimizer.

Live catalog bootstrap therefore still requires operator-reviewed values or
cloud capabilities for:

- the exact non-placeholder `DF_TBENCH_DATASET_CONTENT_SHA256` and
  `DF_TBENCH_DATASET_MANIFEST_SHA256` for registry revision 6;
- a provider implementation of
  `TrustedTerminalBenchCatalogNormalizationWorker` that resolves only that
  immutable revision inside the evaluator network boundary;
- the governed mounted-volume object root, state root, runtime guard, volume
  semantics attestation, and recovery authority; and
- optional exact initial-Pi and comparable-public observation artifacts plus
  their source commitments, or an explicit decision to start either prior as
  `null`.

The worker manifest, source attestor, stored snapshot, and source-index receipt
must all use schema v2 and reproduce both artifacts' exact URI, SHA-256, media
type, and byte length. Do not migrate a schema-v1 tar-only receipt by editing
it; recreate and attest the source snapshot in the trusted cloud. Candidate
publication IDs start at `001`, so the fixed bundle ref remains reserved.

Production composition must inject the optimizer resolver with six governed
inputs: the baseline/candidate source index, an immutable exact-query
evidence-metadata registry, a bounded canonical-JSON reader, an independent
full-byte reader over the verified artifact bridge, the campaign-bound
release-inspection policy, and a historical purpose-specific public-key
authority. The inspection policy must bind the composition's evaluator-policy
hash, exact release-path allowlist, forbidden-content fingerprints, and grader
canaries. Pin one reviewed canonical bootstrap metadata artifact for
experiment `001`. Provision disjoint Ed25519 purposes and rotation/revocation
policy for source receipts, bootstrap evidence, proposal diagnostic evidence,
and analysis evidence. A `boundary` string, environment value, artifact digest,
metadata assertion, or all-false sensitivity flag alone is not authority.

The concrete exact-query registry is
`MountedVolumeTrustedArtifactRegistry`. Mount its object backend and fenced
index on the same provider-governed volume class whose atomic rename, durable
sync, and recovery semantics passed the live canary. Register its lifecycle
resource immediately. Publish canonical JSON through
`VerifyingTrustedArtifactBridge`; typed consumers must use
`MountedVolumeTrustedArtifactJsonReader` and one of the purpose-specific
sources. A publication becomes visible only after every object in its batch is
durable and the single index transaction commits. Do not add an object-listing
API, URI lookup, prefix query, local-file reader, or filesystem recovery scan.
Unindexed objects left by an interrupted publish are unreachable and must not
be made visible heuristically.

The registry is storage, not key authority. Continue to inject the independent
purpose- and rotation-aware KMS/public-key authorities required by the
evaluator release, optimizer evidence, composition, campaign, and bootstrap
verifiers. Never publish raw Harbor/ATIF/grader material, task or panel
identities, or per-trial trajectories into this registry.

## Base-image contract

Every base-image input is required and must be
`registry/name@sha256:<64 lowercase hex characters>`. There are no fallback
tags. The BuildKit driver image follows the same rule, and the Buildx input is
an exact `vMAJOR.MINOR.PATCH` release.

- `control` requires Linux/amd64, Node 24 at `/usr/local/bin/node`, npm,
  Corepack, Git, a POSIX shell, CA certificates, and writable support for UID
  and GID `65532`.
- `optimizer` additionally needs the system tools used by the Pi source-editing
  workflow. Its Containerfile installs only the exact operator-supplied
  `@anthropic-ai/claude-code` version.
- `build` needs the compilers and system tools required by the native
  `earendil-works/pi` npm build. It does not receive model credentials.
- `evaluator` requires Python 3 and pip in addition to Node. Its Containerfile
  installs only the exact operator-supplied `harbor` version. Any DIND or
  provider-specific Terminal-Bench prerequisites must already be present in
  the reviewed base.

All final images use numeric UID/GID `65532`, a dedicated writable
`/home/dark-factory`, contain no build secret, and idle until the provider
invokes an explicit bounded command. BuildKit receives a default-deny context
from `.dockerignore`.

Exact package versions do not by themselves prove runtime contents. Before a
campaign, the trusted probe must still record the installed Claude Code
identity, Harbor distribution hash, Harbor executable hash, Pi adapter hash,
architecture, resources, and provider attestation required by the protocol.

## Free staged control configuration

`synthetic` and pre-composition `status` parse only the cloud provider, region
class, and immutable control image, plus the Daytona sandbox profile and
mounted-volume binding needed by the GitHub-hosted bootstrap. They do not parse
or forward optimizer/evaluated-model configuration, Pi source identity,
Terminal-Bench material, budget, production composition, paid authorization,
or controller/KMS secret mappings. Their control sandboxes have an empty
secret map and `networkBlockAll: true`.

`probe` adds only immutable build/evaluator images, the named nested Daytona
secret, and an explicit network allowlist. It does not require the optimizer
image, either model, GitHub private-repository reference, benchmark pin, budget,
signing key, bootstrap descriptor, or general controller secrets.

`status` is intentionally useful before the production composition exists. It
persists a release-safe `awaiting-production-composition` receipt containing
only the public binding-readiness commitment and control-image digest. It does
not pretend to reconstruct campaign state. Once the signed production owner is
wired, this branch must be replaced by the owner's real status result; until
then `optimize`, `stop`, and `resume` remain fail-closed.

The GitHub-hosted launcher still needs `DAYTONA_API_KEY` to create and destroy
the disposable control sandbox. That bootstrap credential is not an evaluated
model, optimizer, Git, or KMS credential, and it is never forwarded into the
offline sandbox.

The preflight workflow is bound to a separate GitHub environment named
`dark-factory-preflight`. Protect it with reviewers and store
`DAYTONA_API_KEY` there; a repository- or organization-scoped credential is
not the intended production configuration.

Every immutable control/build/evaluator image reference must be pullable by
Daytona. Either give the corresponding GHCR packages deliberately reviewed
public visibility or configure provider-side private-registry access before
dispatch. The workflow does not pass a registry token through the evaluated
sandbox.

## Protected paid environment

Create a GitHub environment named `dark-factory-paid`, protect it with required
reviewers, prevent unreviewed branches from deploying, and allow only `main`.
Configure one GitHub secret:

- `DAYTONA_API_KEY`: bootstrap-only credential allowed to create and delete the
  trusted control sandbox.

All other entries are environment variables. Values whose names end in
`_SECRET_SOURCE` or appear in a `*_SECRET_BINDINGS_JSON` value are names of
Daytona organization Secrets, never plaintext credentials.

Required identity and image variables:

- `DAYTONA_API_URL`, `DAYTONA_TARGET`, `DF_CLOUD_REGION_CLASS`
- `DF_CONTROL_IMAGE_REFERENCE`, `DF_CONTROL_IMAGE_DIGEST`
- `DF_OPTIMIZER_IMAGE_REFERENCE`, `DF_OPTIMIZER_IMAGE_DIGEST`
- `DF_BUILD_IMAGE_REFERENCE`, `DF_BUILD_IMAGE_DIGEST`
- `DF_EVALUATOR_IMAGE_REFERENCE`, `DF_EVALUATOR_IMAGE_DIGEST`
- `DF_FOUNDRY_RESOURCE_NAME`, `DF_OPTIMIZER_MODEL`,
  `DF_OPTIMIZER_DEPLOYMENT_NAME`, `DF_OPTIMIZER_EFFORT`,
  `DF_CLAUDE_CODE_VERSION`
- `DF_EVALUATED_PROVIDER`, `DF_EVALUATED_MODEL`,
  `DF_EVALUATED_DEPLOYMENT_NAME`, `DF_EVALUATED_REASONING`
- `DF_PI_GITHUB_OWNER`, `DF_PI_GITHUB_REPOSITORY`, `DF_PI_BRANCH`
- `DF_PI_BASELINE_COMMIT`, `DF_PI_BASELINE_TREE`,
  `DF_PI_PACKAGE_LOCK_SHA256`, `DF_PI_CODING_AGENT_VERSION`
- the governed baseline source-snapshot v2/index identity and exact reviewed
  optimizer bootstrap metadata reference must be supplied by production
  composition, not as a Mac path, mutable branch, or credential-bearing
  environment value
- `DF_PRODUCTION_OPTIMIZE_BOOTSTRAP_DESCRIPTOR_JSON` (one-line canonical JSON
  signed by the independently governed bootstrap authority; it binds the
  campaign, lineage, protocol, exact `trusted://` composition artifact, and
  authority/key-set/verifier-policy commitments, and contains no task or
  executable-port implementation)
- `DF_MODE`, `DF_LEADERBOARD_ELIGIBILITY`, `DF_TRUSTED_ZONE`,
  `DF_SIGNING_KEY_ID`

Required secret-reference variables:

- `DF_OPTIMIZER_SECRET_SOURCE`, `DF_OPTIMIZER_SECRET_TARGET`
- `DF_EVALUATED_SECRET_BINDINGS_JSON`
- `DF_GITHUB_SECRET_SOURCE`
- `DF_HARBOR_SECRET_BINDINGS_JSON`
- `DF_CONTROL_DAYTONA_SECRET_SOURCE`
- `DF_CONTROL_SECRET_BINDINGS_JSON` (use the literal `[]` when none are needed)

Required benchmark and budget variables:

- `DF_HARBOR_VERSION`, `DF_TBENCH_REGISTRY_REVISION`
- `DF_TBENCH_DATASET_CONTENT_SHA256`,
  `DF_TBENCH_DATASET_MANIFEST_SHA256`
- `DF_HARBOR_PACKAGE_SHA256`, `DF_HARBOR_EXECUTABLE_SHA256`,
  `DF_PI_HARBOR_ADAPTER_SHA256`
- `DF_BUDGET_USD`, `DF_BUDGET_TOKENS`,
  `DF_BUDGET_WALL_TIME_MINUTES`, `DF_BUDGET_ATTEMPTS`,
  `DF_BUDGET_PRIVACY_RELEASES`, `DF_BUDGET_PROMOTION_LOOKS`,
  `DF_BUDGET_ONLINE_ERROR` (predeclared, calibrated, and no greater than
  `0.05`)

Required controller-profile variables:

- `DF_DAYTONA_VOLUME_ID`, `DF_DAYTONA_VOLUME_SUBPATH`
- `DF_CONTROL_TTL_MINUTES` (between 5 and 300 for this GitHub-hosted bootstrap)
- `DF_CONTROL_NETWORK_ALLOW_DOMAINS`
- `DF_CONTROL_CPU`, `DF_CONTROL_MEMORY_GIB`, `DF_CONTROL_DISK_GIB`

Do not choose placeholder model, provider, image, dataset, hash, budget, or
secret values. The workflow intentionally fails closed until the operator has
made and recorded each choice.

The bootstrap descriptor variable is transport, not a trust store. The
controller deployment must inject the reviewed authority-set, verification
key-set, verifier-policy, and derived commitment independently, together with
the non-overlapping key ID/version rotation schedule and a purpose-specific
public-key authority. That authority may return only non-revoked Ed25519 SPKI
DER for the requested historical window; it has no private-key or environment
lookup interface. Bind composition artifacts through
`VerifyingTrustedJsonArtifactReader` and its verified cloud bridge rather than
adding a provider-specific or local-file reader.

The production composition owner also requires three independently governed
bootstrap prerequisite bindings; none is discovered from the Mac checkout or
selected by the descriptor:

- an immutable source registry returning the exact signed private-Pi
  registration whose identity hash binds registration ID, private-origin
  attestation, commit, tree, npm lock, and coding-agent package version;
- a signed campaign-genesis commitment bound to campaign, lineage, protocol,
  source prerequisite, initial state hash, and genesis policy; and
- a signed task-free hidden-catalog genesis commitment bound to campaign,
  lineage, protocol, campaign genesis, Terminal-Bench dataset pin, registry
  revision, seed-set/weighting commitments, task/disposition key IDs, and
  initial catalog state hash.

Use three disjoint Ed25519 purposes, key IDs, rotation schedules, and public
SPKI values for those documents. The public-key authority must reproduce the
requested purpose/version/window and return `revoked: false`; it never exposes
signing material. The catalog commitment has no task-name, task-ID, panel,
cell, task-order, or grader field.

The trusted controller must place the bootstrap coordination journal on the
same reviewed linearizable mounted-volume class used by the other production
stores and register its writer resource immediately with the composition
owner. Campaign and catalog genesis authorities retain their own physical
stores. Recovery follows the durable strict-prefix journal
`claimed -> campaign-ensured -> catalog-ensured -> committed`; it does not
claim a distributed transaction. A later journal phase whose domain state is
missing, a catalog without its campaign, or any exact-state-hash mismatch
requires operator investigation and fails closed.

## Trusted runtime factory bindings

`ProductionTrustedCloudRuntimeFactory` is the concrete production assembly
authority behind the composition owner. It does not load a registry or resolve
an implementation from the bootstrap descriptor, composition JSON,
environment, artifact metadata, or a module/command name. Its executable
classes are fixed imports. Before construction it requires an independently
supplied task-free dependency attestation that reproduces:

- the exact composition-manifest hash;
- the four role component-manifest hashes;
- the complete operational-binding hash; and
- the exact ordered nine runtime-port IDs, attestation digests, and their
  domain-separated aggregate hash.

A separate captured provider/KMS authority must authenticate this exact
dependency attestation and bind its receipt to the composition verifier's
attestation hash before the factory acquires any store. The optimizer plugin
artifact hash and immutable optimizer image must also reproduce their manifest
bindings. Provider-readiness, mounted-volume, correctness, broker, evaluator,
and journal policy hashes are separate constructor-bound values and must
exactly match the manifest. These values authenticate the fixed construction;
none selects a constructor, module, command, key, model, task, or runtime port.

The controller deployment must inject concrete trusted in-process objects for:

- campaign ledger-transition, decision, and control-attestation verification;
- task-free diagnostic resolution, resume attestation, interruption
  authorization, completion accounting, in-flight operation accounting, and
  campaign sealing;
- journal policy/provenance production, task-identity exclusion, deterministic
  leak scanning, leak-scan signing, pinned-version resolution, and public key;
- the cloud sandbox provider, verifying optimizer artifact readers, released
  evidence registry, source-only bootstrap metadata, and purpose-specific
  optimizer resolver public-key authority;
- candidate integrity scanning, cloud build, non-force Git publication,
  immutable source snapshotting, receipt verification, and durable source
  indexing;
- broker evaluation-configuration artifacts, source-receipt keyring, signed
  evaluator service, content-hash-only release artifact registry/reader,
  purpose-specific release verification, and adaptive-release verification;
  and
- the provider-attested runtime guard, mounted-volume semantics guard, and
  lock-recovery authority.

Every mounted store is registered with the composition owner immediately after
its constructor returns. Registration and later construction failures close
the partial stack in reverse order through idempotent close-once wrappers, so
the owner's final cleanup can safely retry the same wrappers. The returned
nine ports are frozen method-captured objects, their bindings are in the sole
exported canonical order, and every binding implementation is reference-equal
to the corresponding role component.

The candidate-integrity binding specifically requires the immutable
`scripts/candidate-integrity-worker.mjs` artifact, a deny-all x86_64 evidence
sandbox, the verifying artifact bridge, a sealed non-enumerable
task-fragment-hash catalog, a purpose-specific Ed25519 signing authority and
public verifier, and a trusted accounting authority. Its configured worker,
catalog, and v2 scanner-policy hashes must exactly match the values frozen into
the correctness runtime. No optimizer-visible artifact backend or provider
secret may be reused for the hidden catalog.

The factory and adversarial source tests are authored. They are not execution
evidence. Typecheck, tests, real volume acquisition/close behavior, provider
attestation, and end-to-end owner wiring must run in approved cloud CI before
`optimize` may be considered runnable.

## Paid dispatch authorization

Dispatch only from `main` at the exact reviewed source commit. The operator
must type two independent bindings:

- `OPTIMIZE:<campaign_id>`
- `RUN:<campaign_id>:<control image sha256 digest>`

The protected environment approval is a third human gate. The workflow checks
all three bindings before the Daytona credential is exposed to any bootstrap
step. It first runs the live provider/mounted-volume probe and the deterministic
synthetic walk-forward campaign. Only if both succeed does it run the paid
optimize bootstrap:

`dist/cloud/control-bootstrap-cli.js optimize <campaign_id>`

The Daytona credential is injected only into the three explicit
controller-bootstrap steps—probe, synthetic, and optimize—and is absent from
checkout, dependency installation, quality checks, build, and receipt upload.
Probe and synthetic use it only to create and destroy their disposable
controller sandboxes; the staged command configuration prevents the offline
synthetic command from forwarding it into that sandbox. Only optimize receives
the separately reviewed paid model, private-Git, benchmark, budget,
composition, and signing configuration. Uploaded receipts contain hashes and
lifecycle metadata, not controller stdout or task-bearing evidence.

## Fail-closed properties and residual gates

- Automated pull-request quality jobs have read-only repository permission and
  no benchmark, provider, model, package-write, or environment secret.
- Every external action is pinned to an immutable commit SHA.
- Checkout never persists credentials.
- Image publication is manual, main-only, commit-bound, protected, and occurs
  only after the complete quality suite succeeds for that commit.
- GHCR references used at runtime must include the returned manifest digest;
  tags are informational only.
- A missing lockfile stops normal CI and every image or controller workflow.
- The first lockfile job emits review material only and refuses to replace an
  existing lock. It may inspect an exact repository branch tip so the lock can
  join the same pull request without first merging unverified source.
- Pin discovery runs from reviewed `main` source without the pnpm lock or role
  images, emits only a task-free content-addressed receipt, and never uploads
  its downloaded dataset or Harbor log.
- The paid workflow is intentionally bounded below GitHub's hosted-job limit so
  the bootstrap can observe and confirm Daytona teardown.

The workflows and Containerfiles remain unverified until the first cloud
lock generation, pin discovery, quality run, four-image build,
SBOM/provenance inspection, Daytona probe, status, and synthetic campaign
succeed. A workflow file existing in Git is not evidence that any of those
gates passed.
