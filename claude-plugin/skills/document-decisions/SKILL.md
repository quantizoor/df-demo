---
name: document-decisions
description: Submit schema-valid Dark Factory hypotheses and post-evaluation analyses with precise aggregate-evidence citations. Use when freezing a candidate rationale or closing any promoted, rejected, or inconclusive experiment.
---

# Document decisions

For a hypothesis, cite the diagnostic-brief hash and only the card IDs actually used. Record
the observed pattern, causal claim, intervention, affected Pi components, predicted repair and
fresh-panel effects, generality argument, falsification criteria, and rollback condition.

For an analysis, record:

- whether the signed aggregate evidence supports the frozen causal claim;
- validation and repair dispositions without inventing unreported details;
- cited card and attestation IDs;
- expected versus observed general effects;
- capability, cost, latency, and integrity regressions;
- unexpected effects and plausible task-agnostic confounders;
- a bounded next direction;
- whether rollback is required.

Never write task identities, raw traces, commands, outputs, paths, grader details, inferred
panel composition, or unmatched score comparisons. Use `df_submit_hypothesis` and
`df_submit_analysis`; do not create or modify sealed experiment JSON directly.

