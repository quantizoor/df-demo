---
name: form-falsifiable-hypothesis
description: Convert Pi source observations or a released task-agnostic diagnostic brief into one bounded causal hypothesis. Use before any candidate edit or when revising the one allowed immediate repair attempt.
---

# Form a falsifiable hypothesis

Use only Pi source, static documentation, and the one released diagnostic brief. Do not guess
which benchmark tasks contributed.

Produce these fields:

- `observedPattern`: a task-agnostic source or behavioral observation.
- `causalClaim`: why a specific harness mechanism likely causes the pattern.
- `intervention`: one bounded general change.
- `affectedComponents`: exact Pi components expected to change.
- `predictedRepairBehavior`: observable generic behavior expected on the prior feedback panel.
- `predictedFreshEffect`: expected accuracy, capability, cost, and latency effects on unseen
  tasks.
- `generalityJustification`: why the mechanism applies across unrelated terminal work.
- `falsificationCriteria`: evidence that would disprove the claim.
- `rollbackCondition`: a concrete regression or integrity condition.
- `citedCardIds`: only cards actually used; empty for source-only bootstrap.

Reject your own hypothesis if it depends on an inferred task, tool specific to an inferred
environment, benchmark identifier, solution pattern, or conditional task detection. Submit
the completed object once with `df_submit_hypothesis`; submission freezes it.

