# Expanded core-image pilot: human review rubric

Protocol: `core-webgpu-pilot-2`. This rubric is prepared before new inference. Forty frozen cases and fixed model settings are an evaluation design, not a completed evaluation. Qualified human visual references and grading are still required. [Protocol](protocol.json) · [Review guide](human-review-guide.md) · [Blank sheet](human-review-template.csv).

## Reference first

A qualified human inspects each exact PNG without model text, records visible colour, texture/markings, boundaries/gaps and uncertainties, then signs and freezes that reference file with its SHA256. Record reviewer identity, role, qualification basis, date, any source-label exposure and any prior exposure to outputs. Do not fill these fields on someone's behalf or turn assistant-authored notes into human review.

Technical model runs can precede human reference preparation if their text remains hidden from the reference reviewer. Record the actual order. This permits a reference frozen before **output disclosure**, but does not justify saying it preceded inference. A reviewer who already saw outputs cannot retrospectively supply an independent reference; keep that work labelled as output-informed and obtain a fresh blinded reference if independence is required.

Published lithology classes came from source geologist-derived logs. They are not new human observations of these crops. A folder named `garbage` can contain tray material plus a rock edge; assess the visible content rather than forcing every control to be entirely non-rock. Do not use source classes, inferred borehole prefixes or later model suggestions to fill missing visual evidence. Preserve source attribution under the dataset's separate licence.

## Eligible output and missing evidence

Only an actual **browser WebGPU quality-mode** run with the fixed 128-token cap, pinned model/prompt and verified input hash can enter this study's browser-quality gate. Compatibility mode (32 tokens), CPU diagnostics, mock outputs and other protocols remain separate. A capped quality answer is reviewed as produced and marked incomplete; it is not replaced with a preferred retry.

Preserve every planned case and status. A not-run, cancelled, failed or timed-out case has no invented score. A completed case without a human review remains **unassessed**. Missing values are not zero scores and never count as passing. The full-cohort denominator is 40; separately show attempted, completed, human-reviewed and useful counts. One successful case is one observed completion, not 40-case validation.

The organizer supplies image, frozen reference, prompt and anonymous output ID, removing model name, backend and timing from the grading packet. Preserve the ID-to-run mapping separately until scores are frozen. In this single-model study identity may still be inferred; report this limited masking honestly, never as a fully blind independent panel.

## Four descriptive categories

Score each category 0–2 with a reason tied to a reference observation. This retains the earlier pilot's point definitions; **points are not accuracy percentages**. The rubric gives one point for omission, so a nonresponsive answer may score 4/8 while failing usefulness. Always report usefulness and claim classifications alongside points. Record any newly noticed visual feature separately as a post-hoc observation; do not silently revise the frozen reference.

| Category | 2 points | 1 point | 0 points |
|---|---|---|---|
| Colour | Specific visible colour observations match the reference. | Generic, incomplete or omitted, without substantive contradiction. | A substantive colour claim contradicts the image. |
| Texture or markings | Specific visible texture/markings match what this resolution supports. | Generic, incomplete or omitted, without substantive contradiction. | Invented/contradicted texture or detail beyond the visible resolution. |
| Boundaries or gaps | Correctly describes visible edges/gaps, or explicitly recognizes no reliable boundary is discernible. | Omits an applicable clear feature or remains nonspecific without inventing one. | Invents boundaries, gaps, counts or arrangements, or confuses padding/labels with material. |
| Uncertainty | Matches actual ambiguity and acknowledges relevant image limits. Clear facts need no boilerplate disclaimer. | Generic uncertainty or incomplete treatment of a relevant limit, without a confident unsupported resolution. | Confidently resolves an ambiguous feature or treats unclear/non-core content as an established geological observation. |

All four categories apply unless the image-only reviewer records an exclusion and reason before seeing model text. Keep the applicable maximum explicit. Do not normalize differently applicable scores into an accuracy claim. Neither verbosity nor repeated caveats earns additional credit. Hedging does not rescue a contradicted feature.

## Classify every factual claim

Split output into atomic claims without changing its wording. Record each quoted claim, classification, evidence or uncertainty, and whether it is critical:

- **Supported visually:** directly inspectable in the exact crop or frozen reference.
- **Supported only by published context:** source records establish it, but the image-only task does not. Do not count this as visual support.
- **Contradicted visually:** conflicts with the image; explain why.
- **Not verifiable from the crop:** the required scale, context, resolution, measurement or causal evidence is absent.
- **Appropriate abstention:** correctly states a relevant limitation without asserting the absent property.

Count unverified claims separately, including in otherwise useful answers. Classify contextual wording manually; a keyword such as “strength” in “strength cannot be determined” is not a strength estimate. Image counts are distinct from numerical engineering properties, but counts still require visual support.

An affirmative unsupported inference about lithology, mineral identity, soundness, rock quality, natural-versus-mechanical fracture cause, RQD or engineering properties is a **critical failure**. A clearly non-rock control confidently called a rock specimen is also critical. A source class that happens to match an asserted lithology does not excuse the forbidden inference. “Possibly” does not turn an unobservable property into evidence. Record exact text and reasoning; high colour/texture points cannot offset a critical failure.

## Two different usefulness measures

**Minimum useful:** at least one specific supported visual observation, no substantive visual contradiction, and no critical failure. Correctly recognizing an ambiguous/non-core crop with a specific visual reason can qualify. A generic “yes” or “this is drill core” does not. This rule can admit noncritical unverified interpretations; it does **not** mean every claim is reliable.

**Fully supported description:** satisfies minimum usefulness, contains no affirmative factual claim that is only source-context-supported or not verifiable from the crop, and handles relevant ambiguity appropriately. Pure uncertainty statements are assessed as abstentions rather than invented facts. Keep this stricter result separate; never relabel the earlier pilot's minimum-useful count as fully supported.

Use `true`, `false` or `unassessed` for both fields. They are human judgments, not automatic classifier confidence. Report nonresponse, critical flags, contradiction counts, unverified claims and cap status separately.

## Research screening criteria and decision

The protocol predeclares research thresholds: 40 human-reviewed browser quality cases, at least 32 minimum-useful and 30 fully supported descriptions, zero critical failures, at most two answers with substantive visual contradictions, at least eight appropriate answers among ten non-core/mixed controls, and at most four capped answers. These are proposed screening rules, not user-accepted performance requirements or statistical evidence of general accuracy.

The full gate also requires at least five authoritatively mapped boreholes with case-level linkage, documented development-data overlap, a complete actual target-device run and the protocol's timing/stability evidence. Filename prefixes alone do not establish independence, and public images cannot establish absence from pretraining. Physical iPhone Safari must be physically operated; Chromium phone emulation and software WebGPU cannot satisfy that gate.

Use **passed**, **failed**, or **unassessed** per criterion. Missing references, unverified hole mapping, missing full browser coverage or unavailable device measurements prevent claiming the full gate passed. If a numeric GPU-memory limit is proposed, valid measurement and an explicit budget are required; JS heap and weight-file bytes cannot substitute for GPU memory. Preserve unknown memory as unknown.

Even passing this exploratory gate would support further optional prototype evaluation only. It would not validate automatic geological logging, engineering estimates, a new default model, or the benefit of piece crops over matched full-row photographs. Those claims require their own evidence and decisions.
