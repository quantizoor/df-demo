# Dark Factory Experiment Feedback

This file is the append-only human-facing ledger of sealed experiments.

## Generation contract

- The authoritative source for each entry is the experiment's validated
  `feedback-entry.json`.
- The controller appends exactly one entry after an experiment is sealed.
- Interrupted experiments do not append an entry.
- Entries are ordered by experiment number and are never edited in place.
- Corrections appear as explicit amendments linked to the original experiment.
- `df feedback rebuild` must reproduce this file byte-for-byte from sealed JSON.
- Human-visible comparisons may contain aggregate difficulty, capability, and
  exposure summaries and cross-task failure cards returned by the blind
  broker, but neither the file nor Claude-visible evidence contains task names,
  instructions, mappings, stable pseudonyms, or the actual task list.
- Failure cards must aggregate at least three distinct tasks and contain only
  typed behavioral evidence, never raw task literals or single-trial
  drill-downs.
- Cache reporting is derived from the experiment's validated
  `cache-attestation.json`. It may report aggregate reuse, freshness, drift,
  and invalidation data but never cache keys or record-level outcomes.
- `N/A` is used when no protocol-compatible matched comparison exists.

## Metric definitions

- **Candidate vs parent:** matched result against the champion commit from which
  the candidate was created. Promotion uses only its fresh same-window pairs.
- **Candidate vs previous:** comparison with the immediately preceding sealed
  experiment, whether or not that experiment was promoted.
- **Candidate vs baseline:** comparison with experiment `000` on the
  protocol-compatible task intersection.
- **Accuracy delta:** candidate pass rate minus comparison pass rate.
- **Valid pairs:** matched task pairs after excluding infrastructure-invalid
  trials. Their provenance states whether they are fresh promotion evidence or
  a protocol-compatible historical comparison.
- **Pair provenance:** `fresh-promotion` for twelve valid same-window pairs,
  `fresh-partial` for an early-stage subset, `cached-screening` when historical
  champion distributions contributed, `historical-matched` for broker-computed
  previous/baseline intersections, or `N/A`. Only `fresh-promotion` can support
  promotion.
- **Cache hits:** exact-key, individually fresh champion observations available
  to the broker before a scheduled arm.
- **Cached screening comparisons:** exact-protocol champion outcome
  distributions reused only to decide whether a candidate merits fresh
  confirmation. They never count as valid promotion pairs.
- **Fresh promotion pairs:** same-window matched pairs for which both candidate
  and champion were newly run no more than 24 hours apart under a compatible
  environment fingerprint. An eligible candidate screening arm may be retained
  when its missing champion arm is run fresh. Exactly 12 valid fresh pairs are
  required for an MVP promotion decision.
- **Drift anchors:** deterministic fresh champion reruns covering at least 25%
  of every cache-hit cohort, with a minimum of one, used to decide whether
  its cached distribution remains valid.
- **Regressions:** aggregate task-count/capability bands that moved from pass to
  fail under the candidate; actual task identities remain broker-only.
- **Gains:** aggregate task-count/capability bands that moved from fail to pass;
  actual task identities remain broker-only.
- **Cumulative spend:** all recorded optimizer-model, evaluated-model, and
  sandbox cost since the baseline lineage began.

## Entry template

The generator uses this exact conceptual structure:

```markdown
## Experiment NNN — short-description

- Sealed: <RFC 3339 timestamp>
- Decision: promoted | rejected | inconclusive
- Candidate: <commit>
- Parent champion: <experiment and commit>
- Hypothesis: <one-sentence falsifiable claim>
- Changed surface: <prompt | tool | extension | memory | compaction | control>

### Comparison

| Comparison | Accuracy delta | Valid pairs | Pair provenance | Uncertainty | Cost delta | Latency delta |
| --- | ---: | ---: | --- | --- | ---: | ---: |
| Parent champion | ... | ... | ... | ... | ... | ... |
| Previous experiment | ... | ... | ... | ... | ... | ... |
| Experiment 000 | ... | ... | ... | ... | ... | ... |

### Evidence

- Gains: ...
- Regressions: ...
- Invalid trials: ...
- Cache hits: ...
- Cached champion outcomes used for screening: ...
- Cache freshness bands: ...
- Fresh drift anchors: ...
- Cache drift status: passed | failed | not-used
- Cache invalidations: ...
- Retained fresh candidate arms: ...
- Newly completed champion arms: ...
- Fresh promotion pairs: ...
- Baseline-maintenance attempts: ...
- Total evaluator attempts / 30: ...
- Capability coverage: ...
- Exposure summary: ...
- Cross-task failure cards: ...
- Integrity checks: passed | failed
- Hypothesis result: supported | refuted | inconclusive

### Decision and next direction

<policy-grounded explanation and next recommendation>

- Experiment cost: ...
- Cumulative spend: ...
- Evidence: `experiments/NNN-.../feedback-entry.json`
- Cache attestation: `experiments/NNN-.../cache-attestation.json`
- Evidence hash: `sha256:...`
```

## Baseline

No experiment has been run yet. The first generated entry will describe
`000-pi-baseline`; creating these planning documents does not create or evaluate
the harness baseline.
