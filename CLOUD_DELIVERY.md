# Dark Factory cloud delivery

This repository deliberately has no local install, test, image-build, or
controller-launch path. The files in this guide are authored on the Mac, but
every executable step runs on a GitHub-hosted runner or inside a pinned Daytona
sandbox.

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
   normal pull request. The bootstrap workflow never commits, pushes, opens a
   pull request, receives a repository write token, or runs a package script.
4. Let `cloud-quality-gates` pass on the lockfile pull request and on `main`.
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
- `DF_OPTIMIZER_MODEL`, `DF_OPTIMIZER_EFFORT`,
  `DF_CLAUDE_CODE_VERSION`
- `DF_EVALUATED_PROVIDER`, `DF_EVALUATED_MODEL`,
  `DF_EVALUATED_REASONING`
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
synthetic walk-forward campaign. Only if both succeed does it call:

`dist/cloud/control-bootstrap-cli.js optimize <campaign_id>`

The credential exists only in that step. Checkout, dependency installation,
quality checks, build, and receipt upload cannot read it. The uploaded receipt
contains hashes and lifecycle metadata, not controller stdout or task-bearing
evidence.

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
