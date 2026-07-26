# Dark Factory MVP

Dark Factory is a blind, cloud-only optimization loop for the private Pi
coding-agent fork and Terminal-Bench 2.1.

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

The real optimization command remains fail-closed until its reviewed
dependency lock, immutable images, provider volume, private-Git
authorization, model credentials, benchmark pin, signing authorities, budget,
and signed production composition are supplied through protected cloud
configuration.
