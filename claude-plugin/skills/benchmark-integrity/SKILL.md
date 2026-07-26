---
name: benchmark-integrity
description: Review Pi hypotheses and candidate diffs for benchmark contamination, task inference, reward hacking, and overfitting. Use before submitting a hypothesis, before staging a candidate, and whenever unexpected benchmark-specific information appears.
---

# Benchmark integrity

Reject any proposal or diff that contains or depends on:

- task names, instructions, fragments, IDs, stable handles, panel roles, or pool membership;
- graders, tests, verifiers, solutions, reference artifacts, expected values, or grader prose;
- solution URLs, encoded payloads, suspicious constants, or answer lookup tables;
- task or environment fingerprints used for conditional behavior;
- benchmark-specific tools, routing, timeouts, resources, or evaluator changes;
- uncontrolled network, web, browser, package lookup, or search access;
- per-task result mining, cohort differencing, or repeated queries intended to reconstruct
  hidden membership.

Require one general causal mechanism, a small mutation, predictions frozen before task
selection, cloud checks, a clean integrity scan, fresh matched validation, and explicit
rollback conditions.

If protected information appears, stop editing and do not quote, summarize, encode, or use it.
In the essentials-only MVP there is no evidence or contamination-reporting tool: make no
task-derived change and let the trusted wrapper reject an empty or invalid candidate. In the
full protocol, call no further evidence tool except `df_report_contamination`, report only
its fixed source/detection categories, and choose `stopped-without-using-content`. Never
attempt to repair or delete trusted evaluator data yourself.
