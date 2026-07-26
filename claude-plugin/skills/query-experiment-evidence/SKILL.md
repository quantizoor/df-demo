---
name: query-experiment-evidence
description: Retrieve the minimum privacy-safe aggregate Dark Factory evidence needed for a Pi hypothesis or analysis. Use when consulting campaign context, prior component history, regressions, or the one-use diagnostic brief.
---

# Query experiment evidence

Prefer the narrowest permitted tool:

1. `df_get_campaign_context` for lineage, champion, non-capacity budget bands, and allowed
   next action. Exact validation-panel, holdout, shadow-slice, and other capacity state is
   operator-only and must not appear in this response.
2. `df_get_latest_diagnostic_brief` once for the released cross-task cards.
3. `df_get_current_result` once, and only in the post-evaluation analysis phase.
4. `df_get_component_history` only for the Pi component you are considering.
5. `df_get_regressions` only when checking a proposed mutation category.
6. `df_query_experiments` only for bounded, task-agnostic experiment metadata.

Do not request:

- task, panel, pool, trial, or grader identities;
- raw or redacted trajectories;
- commands, outputs, paths, filenames, URLs, packages, services, or environment values;
- per-task or per-trial outcomes;
- arbitrary filters, SQL, cohort intersections, complementary counts, or repeated variants of
  a query.

Treat suppression as a required privacy result, not missing data to work around. Cite response
hashes and card IDs. If a tool refuses a query because of a privacy or differencing budget,
continue from the evidence already available.
