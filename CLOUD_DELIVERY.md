# Dark Factory cloud delivery

This repository deliberately has no local install, test, image-build, or
controller-launch path. The files in this guide are authored on the Mac, but
every executable step runs on a GitHub-hosted runner or inside a pinned Daytona
sandbox.

## Delivery order

1. Review and merge the delivery workflows and role Containerfiles.
2. If `pnpm-lock.yaml` does not exist, dispatch
   `bootstrap-pnpm-lockfile-review-artifact` on `main`. Enter the exact selected
   commit and the literal confirmation `GENERATE PNPM LOCKFILE`.
3. Download the immutable artifact, verify its adjacent SHA-256 file, review
   the full lockfile, and add only `pnpm-lock.yaml` in a normal pull request.
   The bootstrap workflow never commits, pushes, or opens a pull request.
4. Let `cloud-quality-gates` pass on the lockfile pull request and on `main`.
5. Configure the protected `dark-factory-image-publish` GitHub environment with
   required reviewers. It needs no benchmark or model secret.
6. Dispatch `publish-role-images` from `main`. Enter the exact source commit,
   `PUBLISH:<source_commit>`, four independently reviewed digest-qualified base
   images, the selected exact Claude Code version, and the exact Harbor version
   matching the frozen Terminal-Bench pin. Also provide an exact Buildx release
   and digest-qualified BuildKit driver image; the workflow has no mutable
   builder fallback.
7. Review the four digest-receipt artifacts. Copy only each
   `immutableReference` and `digest` to the protected paid environment. SBOM
   and max-mode provenance attestations are attached to each image in GHCR.
8. Configure `dark-factory-paid`, require human reviewers, and dispatch
   `protected-paid-optimize` only after the run budget and image identities are
   approved.

The image workflow publishes images; it never starts Claude Code, Pi, Harbor,
Terminal-Bench, Daytona, or any paid model. The paid workflow is the only
delivery workflow that receives the Daytona bootstrap credential.

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
  `DF_BUDGET_PRIVACY_RELEASES`, `DF_BUDGET_PROMOTION_LOOKS`

Required controller-profile variables:

- `DF_DAYTONA_VOLUME_ID`, `DF_DAYTONA_VOLUME_SUBPATH`
- `DF_CONTROL_TTL_MINUTES` (between 5 and 300 for this GitHub-hosted bootstrap)
- `DF_CONTROL_NETWORK_ALLOW_DOMAINS`
- `DF_CONTROL_CPU`, `DF_CONTROL_MEMORY_GIB`, `DF_CONTROL_DISK_GIB`

Do not choose placeholder model, provider, image, dataset, hash, budget, or
secret values. The workflow intentionally fails closed until the operator has
made and recorded each choice.

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
  existing lock.
- The paid workflow is intentionally bounded below GitHub's hosted-job limit so
  the bootstrap can observe and confirm Daytona teardown.

The workflows and Containerfiles remain unverified until the first cloud
quality run, four-image build, SBOM/provenance inspection, Daytona probe, and
synthetic campaign succeed. A workflow file existing in Git is not evidence
that any of those gates passed.
