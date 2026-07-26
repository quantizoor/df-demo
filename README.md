# Dark Factory MVP

Dark Factory is a blind, cloud-only optimization loop for the private Pi
coding-agent fork and Terminal-Bench 2.1.

The authoritative prototype is the
[essentials-only MVP](./PLAN.md#0-essentials-only-mvp-authority): Claude Code
using the existing Opus 5 Foundry deployment proposes a code change before any
task is selected; a trusted broker chooses a deterministic
failure-weighted hidden panel of five tasks including one easy canary; Pi using
the existing Opus 4.8 deployment at `high` runs candidate and champion on the
same three repetitions; and only fresh matched evidence can promote. A
full cold-cache race is 30 trials. Cache hits may screen but never promote, and
only generic closed-vocabulary failure cards return to Claude.

Nothing in this project is installed, built, tested, or run on the Mac. The
Mac workspace is for source editing, read-only review, cloud triggering, and
optional display of release-safe artifacts. GitHub-hosted workflows and
isolated cloud sandboxes perform every executable step.

The sibling `../pi` checkout is observation-only. Production independently
clones and verifies the exact private fork in a trusted cloud Git worker;
Claude Code receives an isolated credential-free candidate worktree and never
receives task identities, graders, benchmark solutions, or GitHub credentials.

Start with:

- [PLAN.md](./PLAN.md) — architecture, optimization loop, integrity policy,
  evaluation design, and implementation phases.
- [TODO.md](./TODO.md) — checklist tied to the plan.
- [documentation.md](./documentation.md) — append-only architectural decision
  journal.
- [CLOUD_DELIVERY.md](./CLOUD_DELIVERY.md) — protected cloud setup and runbook.
- [FEEDBACK.md](./FEEDBACK.md) — operator-only release-safe audit mirror; it is
  never optimizer input.

The essentials-only implementation is **source-complete but
cloud-unverified**. It includes the persistent panel/catalog/cache state, the
bounded Claude Code optimizer, the exact-Git Pi build and self-contained Bun
runtime, the Harbor/Daytona evaluator with separately isolated graders, the
task-free sanitizer, and the one-iteration cloud launcher. Authored tests are
not passing evidence until cloud CI runs them. A compatible private runtime
pin and hidden inventory, cloud quality run, synthetic campaign, connectivity
smoke, and first real iteration are still required. No runtime or improvement
claim has been made.

KMS/HSM signing, crash-perfect recovery, twelve-task/shadow gates,
multi-provider support, custom image publication, dashboards/PR automation,
long-campaign statistics, the full 89-task run, and exhaustive production
hardening are explicitly deferred and do not block the MVP.

Before testing, complete the protected runtime checklist in
[CLOUD_DELIVERY.md](./CLOUD_DELIVERY.md#mandatory-stop-before-testing) and then
explicitly say `resume`. Never paste an API key, token, SSH private key, task,
or grader into chat.
