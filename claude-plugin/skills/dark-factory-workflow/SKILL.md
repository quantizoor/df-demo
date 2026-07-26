---
name: dark-factory-workflow
description: Follow Dark Factory's blind hypothesis, candidate, repair, validation, and analysis lifecycle. Use whenever optimizing Pi, beginning or resuming an experiment, requesting an evaluation stage, or deciding what action is permitted next.
---

# Dark Factory workflow

Work on exactly one frozen, general harness hypothesis at a time.

1. Call `df_get_campaign_context`.
2. For experiment 001, inspect Pi source and documentation without requesting benchmark
   evidence. For later experiments, call `df_get_latest_diagnostic_brief` once.
3. Form a causal, falsifiable hypothesis. State predicted repair behavior, effect on fresh
   unseen tasks, likely regressions, falsification criteria, and rollback condition.
4. Submit it with `df_submit_hypothesis` before editing.
   Preserve the returned hypothesis receipt ID; it is an opaque lineage token, not evidence.
5. Make one small, general Pi harness intervention inside allowed files.
6. Use `df_stage_candidate` to declare edits complete. Do not calculate Git identifiers;
   pass the hypothesis receipt ID back unchanged. Dark Factory freezes the diff, commit, and
   hashes and runs all checks in a cloud sandbox. Preserve the returned candidate receipt ID.
7. End the proposal phase after staging succeeds. The controller advances the sealed
   lifecycle; never select tasks, request particular cohorts, invoke Harbor, or start
   validation directly.
8. In the separate analysis phase, call `df_get_current_result` exactly once and interpret
   only that signed aggregate disposition. Preserve its top-level content hash.
9. Submit an evidence-cited analysis with `df_submit_analysis`, even when the experiment
   rejects the candidate or is inconclusive. Bind it to the hypothesis receipt, candidate
   receipt, and released result hash.

Never infer hidden tasks or graders from aggregate evidence. Do not retry queries to narrow a
cohort. A repair pass creates a challenger only; only fresh matched validation can create an
active champion. Stop and report contamination if any task identity, instruction, grader
detail, raw trace, or per-task outcome becomes visible. Use
`df_report_contamination` with fixed categories only; never copy the exposed content.
