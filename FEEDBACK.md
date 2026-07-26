# Dark Factory Experiment Feedback

This file is the append-only, operator-only human-facing ledger of sealed
experiments. It is never optimizer input, never mounted in a Claude Code
sandbox, and never included in an optimizer evidence archive. Claude receives
only separately signed, privacy-thresholded, task-agnostic diagnostic
artifacts that pass the optimizer byte-inspection gate.

## Generation contract

- The authoritative source for each entry is the experiment's validated
  `feedback-entry.json`.
- The controller appends exactly one entry after an experiment is sealed.
- Interrupted experiments do not append an entry.
- Entries are ordered by experiment number and are never edited in place.
- Corrections appear as explicit amendments linked to the original experiment.
- `df feedback rebuild` must reproduce this file byte-for-byte from sealed JSON.
- Every candidate entry identifies the sealed diagnostic brief that motivated
  the repair. It distinguishes the old feedback-panel repair result from the
  fresh validation comparison; the two are never merged into one score.
- Ledger state is explicit: a `candidate` may become a `challenger` after
  repair qualification, an `active` version only after fresh validation, and a
  `certified` version only after a separate shadow decision.
- Human-visible evidence may contain safe aggregate difficulty, capability,
  exposure, and behavioral summaries returned by the blind broker. It never
  contains task names, instructions, mappings, stable pseudonyms, panel
  identifiers, cache keys, or the actual task list.
- Every behavioral finding states its privacy support. Release requires at
  least five distinct supporting tasks, at least 20 trajectories in the
  analysis window, at least five observations in every compared group, an
  approved typed taxonomy, and successful identity-, literal-, complementary-
  count, and differencing-leak scans. Unsupported findings are reported as
  withheld, not weakened into single-trial detail.
- The ledger is derived only from signed aggregate evidence. It never contains
  raw or sanitized ATIF, raw grader/verifier material, a per-task normalized
  row, or a single-trial behavioral excerpt.
- Cache reporting is derived from the experiment's validated
  `cache-attestation.json`. Cache evidence may support repair or early futility
  rejection inside repair only. It never contributes positive activation or
  certification evidence. The ledger reports only privacy-qualified aggregate
  bands and status; exact five-task repair cache counts remain withheld.
- Task provenance is represented only by a role such as `feedback-repair`,
  `fresh-validation`, `consumed-validation`, `historical-context`, or
  `shadow-certification`. Provenance never includes a task identity or a
  stable panel handle.
- Every decided validation panel is consumed because the disposition itself is
  feedback. Every started-abandoned panel is quarantined/consumed; only an
  unstarted panel may return after audit. Rotation never depends on whether a
  candidate happened to win or whether detailed diagnostics qualified for
  release.
- Shadow certification releases only
  `certified | not-certified | inconclusive | not-run` and a signed decision
  attestation. It releases no score, delta, task-level result, failure card,
  behavioral finding, or diagnostic brief.
- Operational attempt and cost accounting includes repair, validation, invalid
  replacements, and shadow work. Asynchronous baseline maintenance is reported
  separately and never counted as experiment promotion evidence or hidden
  inside the experiment ceiling.
- Every entry records normalizer, extractor, statistical, privacy, cache,
  repeated-testing, and decision-policy versions plus research/submission mode
  and `leaderboardEligibility`.
- `N/A` is used when no protocol-compatible matched comparison exists.

## Metric definitions

- **Source diagnostic brief:** sealed, task-agnostic input that motivated the
  hypothesis. It cites aggregate findings and their privacy support, but not
  task or panel identity.
- **Candidate:** a frozen harness commit undergoing correctness gates or repair
  evaluation. Candidate status grants no champion authority.
- **Challenger:** a candidate that satisfied the old feedback-panel repair gate
  and was frozen before fresh validation. Repair qualification is not
  activation.
- **Active champion:** a challenger that passed the complete fresh matched
  validation policy and atomically became the optimizer's current comparator.
- **Certified champion:** an active champion that later received a passing
  decision-only shadow certification. Active and certified are distinct.
- **Repair result:** comparison on the old, already exposed feedback panel. It
  may reject a candidate or qualify it as a challenger, but its positive
  statistical weight in an activation decision is always zero.
- **Fresh validation comparison:** same-window challenger-versus-active
  comparison on a newly assigned validation role that did not contribute
  evidence used to create the challenger. Only a complete policy-valid fresh
  validation result can activate a challenger.
- **Historical context:** optional protocol-compatible comparison with the
  previous experiment or experiment `000`. It is descriptive and never
  activates or certifies a version.
- **Accuracy delta:** candidate pass rate minus comparison pass rate.
- **Valid pairs:** matched task pairs after excluding infrastructure-invalid
  trials.
- **Comparison provenance:** one of `cached-repair`, `fresh-repair`,
  `fresh-validation`, `fresh-partial`, `historical-matched`, or `N/A`, paired
  with a task-provenance role. Only `fresh-validation` may be
  activation-positive. The ledger derives provenance from sealed evidence and
  never assumes that a rejected candidate reached validation.
- **Cache hits:** exact-key, individually fresh active-version observations
  available to the broker before a scheduled arm.
- **Cached repair comparisons:** exact-protocol active-champion outcome
  distributions reused only for the repair gate. They never
  count as fresh validation pairs and never support activation or
  certification.
- **Fresh validation pairs:** same-window matched pairs for which challenger
  and active comparator were newly run under compatible protocol and
  environment fingerprints. Exactly twelve are required for promotion.
- **Drift anchors:** deterministic fresh active-version reruns covering at
  least 25% of every cache-hit cohort, with a minimum of one, used to decide
  whether its cached distribution remains valid.
- **Behavioral finding:** approved, task-agnostic behavior category with a
  support band of at least five distinct tasks, 20 total trajectories, and five
  observations per compared group, plus direction, effect/uncertainty, and
  privacy-attestation result. It contains no raw task literal or membership.
- **Panel consumption:** `unstarted-returned`, `consumed`, `quarantined-aborted`,
  `cooldown`, or `withheld-shadow`. Only a panel abandoned before its first arm
  may return to eligibility after audit. A consumed validation panel may
  immediately supply one five-task repair panel and one revised candidate;
  after advancement or the second attempt, those tasks enter the frozen
  cooldown. They are never positive validation for a candidate influenced by
  their released evidence.
- **Rotation status:** `retained-for-second-repair`,
  `rotated-after-decision`, `cooldown-after-repair`,
  `quarantined-after-start`, `returned-unstarted`, or `N/A`; it is recorded
  independently of the experiment outcome.
- **Experiment attempt compliance:** exact small-panel and replacement counts
  remain broker-private. The ledger reports the applicable ceiling, signed
  within-budget status, fixed public protocol totals such as twelve validation
  pairs, and aggregate cost. Cache hits and asynchronous baseline maintenance
  are not experiment attempts.
- **Baseline-maintenance work:** separately budgeted broker work, reported by
  compliance status and aggregate cost but never included in a candidate's
  38-attempt or a shadow race's 28-attempt ceiling.
- **Experiment cost:** optimizer-model, evaluated-model, evaluator, and sandbox
  spend attributable to the sealed experiment.
- **Cumulative spend:** all recorded optimizer-model, evaluated-model, and
  sandbox cost since the baseline lineage began.

## Entry template

The generator uses this exact conceptual structure:

```markdown
## Experiment NNN — short-description

- Sealed: <RFC 3339 timestamp>
- Entry kind: baseline | candidate-evaluation | shadow-certification
- Final disposition: baseline-established | repair-rejected | challenger-qualified | validation-rejected | inconclusive | activated | certified | not-certified
- Subject commit: <commit>
- State before: candidate | challenger | active-champion | certified-champion | N/A
- State reached: candidate | challenger | active-champion | certified-champion | N/A
- Active version before: <experiment and commit>
- Active version after: <experiment and commit; unchanged when not activated>
- Hypothesis: <one-sentence falsifiable claim>
- Changed surface: <prompt | tool | extension | memory | compaction | control>
- Source diagnostic brief: <artifact reference and sha256, or N/A>
- Run mode: research | submission
- Leaderboard eligibility: unverified | cleared | strict-score-only
- Policy versions: <normalizer, extractor, statistics, privacy, cache, repeated-testing, decision>

### Source diagnostic brief

- Source task-provenance role: consumed-validation | multi-window-discovery | N/A
- Evidence window: <task-agnostic exposure and recency bands>
- Privacy attestation: passed | withheld | N/A

| Finding reference | Typed behavioral finding | Privacy support | Confidence |
| --- | --- | --- | ---: |
| ... | ... | <>=5 tasks, >=20 trajectories, >=5/group; no membership> | ... |

### Repair result — old feedback panel

- Execution: not-run | partial | complete
- Result: repair-rejected | challenger-qualified | inconclusive | N/A
- Task-provenance role: feedback-repair | N/A
- Comparison provenance: cached-repair | fresh-repair | fresh-partial | N/A
- Activation contribution: veto-or-qualification-only; positive weight is zero
- Repair attempt on this panel: 1 | 2 | N/A
- Small-panel accuracy, behavioral subcriteria, per-group counts, and cache
  counts: withheld by the repair privacy policy
- Repair policy attestation: <signed hash>
- Integrity state: passed | failed

### Repair-panel lifecycle

- Repair-panel status before: newly-consumed-validation | retained-for-second-repair | N/A
- Repair-panel status after: retained-for-second-repair | cooldown-after-repair | N/A
- Rotation status: retained-for-second-repair | rotated-after-decision | cooldown-after-repair | quarantined-after-start | returned-unstarted | N/A
- Rotation trigger: validation-decision | repair-advanced | second-repair-complete | started-abandonment | unstarted-abandonment | N/A
- Next feedback source: consumed-validation | broker-selected-rotation | N/A

### Fresh validation comparison

- Execution: not-run | partial | complete
- Result: validation-rejected | activation-qualified | inconclusive | N/A
- Task-provenance role: fresh-validation | N/A
- Comparison provenance: fresh-validation | fresh-partial | N/A
- Cache contribution: none | N/A
- Activation eligibility: eligible | ineligible | N/A

| Comparator | Accuracy delta | Fresh valid pairs | Uncertainty | Cost delta | Latency delta |
| --- | ---: | ---: | --- | ---: | ---: |
| Active version | ... | ... | ... | ... | ... |

- Validation panel consumption: unstarted-returned | consumed | quarantined-aborted | cooldown
- Validation rotation: rotated-after-decision | quarantined-after-start | returned-unstarted | N/A
- Fresh validation pairs: ...
- Fresh-to-frozen-hypothesis attestation: passed | failed | N/A
- Integrity checks: passed | failed | not-run

### Safe aggregate behavioral findings

| Source role | Typed finding | Support band | Direction | Confidence | Privacy result |
| --- | --- | --- | --- | ---: | --- |
| <consumed-validation> | ... | >=5 tasks; >=20 trajectories; >=5/group | ... | ... | passed |

- Findings below the privacy threshold: withheld | none
- Literal, identity, complementary-count, and differencing scans: passed | failed | N/A
- Aggregate evidence engine result: deterministic | failed | N/A
- Diagnostic brief produced for a future repair: <reference and hash, or N/A>

### Historical context

| Comparator | Accuracy delta | Valid pairs | Task-provenance role | Comparison provenance | Uncertainty |
| --- | ---: | ---: | --- | --- | --- |
| Previous experiment | ... | ... | historical-context | <historical-matched or N/A> | ... |
| Experiment 000 | ... | ... | historical-context | <historical-matched or N/A> | ... |

Historical context is descriptive; it never activates or certifies a version.

### Shadow certification

- Decision: certified | not-certified | inconclusive | not-run
- Task-provenance role: shadow-certification | N/A
- Panel disposition: withheld-shadow | N/A
- Subject requirement: active-version-only | N/A
- Diagnostic release: none
- Decision attestation: <signed artifact hash, or N/A>
- Unused sealed shadow slices remaining: <aggregate count>

No shadow score, delta, pair result, failure card, behavioral finding, excerpt,
or diagnostic brief is rendered.

### Evaluator attempts and cost

For a `candidate-evaluation` entry:

| Work class | Budget status | Evaluated-model cost | Evaluator/sandbox cost |
| --- | --- | ---: | ---: |
| Repair | within-ceiling | ... | ... |
| Fresh validation | 12 valid pairs | ... | ... |
| Invalid replacements | within-ceiling | ... | ... |
| Total | within-38 | ... | ... |

- Candidate-evaluation ceiling: 38
- Candidate-evaluation budget attestation: <signed hash>

For a separate `shadow-certification` entry:

| Work class | Budget status | Evaluated-model cost | Evaluator/sandbox cost |
| --- | --- | ---: | ---: |
| Shadow matched arms | 12 valid pairs | ... | ... |
| Invalid replacements | within-ceiling | ... | ... |
| Total | within-28 | ... | ... |

- Shadow-evaluation ceiling: 28
- Shadow-evaluation budget attestation: <signed hash>
- Only the table matching the entry kind is rendered.
- Asynchronous baseline maintenance (outside experiment ceiling/evidence): ...
- Experiment cost: ...
- Cumulative spend: ...
- Hypothesis result: supported | refuted | inconclusive

### Decision and next direction

<policy-grounded explanation and next recommendation>

- Candidate transition: <candidate -> challenger -> active-champion, stopping at the state actually reached> | N/A
- Shadow transition: <active-champion -> certified-champion | unchanged> | N/A
- Activation basis: <fresh-validation artifact and hash, or N/A>
- Certification basis: <decision-only shadow attestation and hash, or N/A>
- Repair/validation panel disposition: <lifecycle/rotation status>
- Evidence: `experiments/NNN-.../feedback-entry.json`
- Source diagnostic brief: `<source experiment>/diagnostic-brief.json` | N/A
- Cache attestation: `experiments/NNN-.../cache-attestation.json` | N/A
- Evidence hash: `sha256:...`
```

`shadow-certification` entries omit the source-brief, repair, validation,
behavioral-finding, and historical-score sections entirely. They render only
identity/state metadata, the decision-only shadow section, compliance flags,
the 28-attempt cost table, and evidence hashes. Candidate and shadow work are
never combined in one sealed experiment or one attempt ceiling.

## Baseline

No experiment has been run yet. The first generated entry will describe
`000-pi-baseline`; creating these planning documents does not create or evaluate
the harness baseline. Discovering the existing clean private Pi working copy at
`../pi` and its planning-time commit is repository setup evidence only; the
baseline is created only after origin privacy/authentication, the canonical
official upstream lineage, and the reviewed commit/lock provenance are
independently verified and sealed in a trusted cloud clone. No upstream remote
is added to or fetched in the Mac checkout.
