---
name: modify-pi-harness
description: Implement one controlled, general improvement in the Pi coding-agent harness. Use after a hypothesis is accepted and before staging a candidate for cloud checks.
---

# Modify the Pi harness

Keep Pi's npm/package-lock workflow. Do not edit the canonical `main` worktree; Dark Factory
assigns an isolated candidate worktree.

Prefer mutation surfaces in this order:

1. Generic system-prompt behavior in `packages/coding-agent/src/core/system-prompt.ts`.
2. Tool descriptions, validation, errors, truncation, and recovery in
   `packages/coding-agent/src/core/tools/`.
3. Agent-session policy in `packages/coding-agent/src/core/agent-session.ts`.
4. Low-level sequencing or termination in `packages/agent/src/agent-loop.ts`.
5. Provider transport only with strong provider-independent justification.

Prototype cross-cutting behavior as an explicitly loaded extension when that keeps the causal
change smaller. Do not edit tests, graders, benchmark resources, timeouts, lockfiles, CI,
network permissions, or evaluation configuration unless the frozen hypothesis explicitly and
legitimately requires an allowed harness change.

Use strict, erasable TypeScript. Avoid `any`, dynamic imports, large literals, lookup tables,
environment fingerprinting, and uncontrolled network access. Never run Pi or its tests on the
Mac.

In the essentials-only MVP, do not call commands, tests, package managers, cloud-check tools,
or unavailable `df_*` tools. Use only the permitted read/edit tools, make one small diff
matching the frozen hypothesis, and return exactly the three-field JSON required by the
optimizer prompt. The trusted wrapper validates, commits, publishes, builds, and evaluates
the change after Claude exits. In the full protocol, submit focused check requests through
Dark Factory and stage only a small matching diff.
