---
name: analyze-diagnostic-brief
description: Analyze a sealed Dark Factory diagnostic brief containing privacy-thresholded cross-task behavioral cards. Use when choosing a general Pi weakness to address without inferring benchmark tasks, graders, or panel membership.
---

# Analyze a diagnostic brief

Validate the source experiment, protocol hash, policy versions, one-use release ID, and
aggregate-evidence hash before using a brief.

For each card:

1. Separate the measured behavior from the card's interpretation.
2. Note support band, uncertainty, effect direction, and whether the contrast is
   success/failure or candidate/champion.
3. Map the generic behavior to plausible Pi mechanisms.
4. Prefer a mechanism supported by multiple cards or direct source evidence.
5. Identify confounders such as runtime, token budget, compaction, and tool-call volume.
6. State what fresh evidence would falsify the mechanism.

Do not reconstruct contributing tasks, calculate hidden counts from bands, compare overlapping
briefs to difference out a cohort, or translate a generic finding into an environment-specific
recipe. A card suggests a research hypothesis; it does not prescribe the correct action for a
particular task.

