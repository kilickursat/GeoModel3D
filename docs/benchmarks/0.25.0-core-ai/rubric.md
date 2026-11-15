# Core-image description pilot: frozen evaluation rubric

Protocol date: 2026-11-15. Freeze this document, the selected-image manifest and the visual reference JSON before generating evaluation outputs. Record their SHA-256 digests in the results. Any later change creates a new protocol version; retain the original evaluation.

## What this pilot can establish

This is an eight-image comparison of two fixed local vision-language model configurations. It tests whether descriptions contain useful, supported visual observations and whether they avoid unsupported geological claims. It does not validate lithology classification, fracture origin, RQD, soundness or engineering properties.

The original source is the [Alzubaidi lithology dataset, version 1](https://doi.org/10.17632/b6rj29mrss.1), distributed under CC BY 4.0. The selected files were obtained from [Kaggle mirror version 1](https://www.kaggle.com/datasets/breejeshdhar/automated-lithology-classification), whose declared licence is CC BY-SA 4.0. Preserve both provenance records and the mirror licence for these copied image assets; this does not relicense the application code. Byte identity between the mirror and original Mendeley archive has not been verified. Its [associated paper](https://www.sciencedirect.com/science/article/pii/S0920410520309888), section 2.2, describes source core imagery and lithology logs created by geologists. Dataset patches are approximately 2 × 2 cm image regions, not complete recovered pieces or drilling runs. Their labels do not establish visible fractures or core quality.

The frozen image-specific observations are in [reference-review.json](reference-review.json). The reference author saw the published class labels but did not see model outputs; do not describe this as a class-blind geological annotation. The later A/B scoring is blind to model identity.

Keep three kinds of reference separate:

- **Published reference label:** the dataset class, its exact file/folder mapping and the publication describing how labels were produced. Attribute this to the dataset and its authors. Do not claim a geologist independently reviewed our selected crops or the model outputs.
- **Visual reference:** an assistant-authored description of directly visible colour, texture, markings, edges and ambiguity, prepared before inference. This is explicitly not a geologist's validation. Each observation has an identifier so a score can cite it.
- **Unknown:** properties or causes that the crop cannot establish. Published lithology context must not be substituted for visual evidence when grading an image-only description.

## Selection and input controls

1. Select eight images reproducibly before seeing outputs: two from each of the three published lithology classes and two from the non-core class. Record the seed, selection algorithm, candidate file list and exclusions. Do not replace an image because a model performs poorly on it.
2. Record the original file path, original-file hash, image dimensions, any crop bounds, analysed PNG hash, source DOI, licence and attribution. Retain the unmodified original separately from the model input.
3. Select distinct parent photographs or runs where identifiers permit. Record known site, borehole and parent-image identifiers. If the release omits them, use `unknown`; do not infer independence from different filenames. These eight patches are then a selected evaluation set, not a site-held-out validation set.
4. Exclude unreadable/corrupt files with a recorded reason before inference. Do not exclude a valid difficult, ambiguous or non-core image. Preserve real acquisition limitations in the visual reference.
5. Give both configurations the identical analysed PNG and prompt. Preserve image proportions in the displayed square input and record resizing, padding and any enlargement. Enlargement creates no new observed detail. Hide filenames, class names, borehole labels and published geological labels from the model prompt.
6. Freeze model revisions, runtime versions, device/backend, processor settings, generation settings and resource limits before execution. The model's native image processing may differ; record it rather than silently changing settings after inspecting an answer.

Public images may have appeared in a general model's pretraining. Neither random selection nor omission of a filename establishes absence of training contamination. No model is trained on this pilot, and the evaluation images must not be used to tune its prompt.

## Fixed task and generation settings

Benchmark prompt version 2:

> Describe only visible features of this image crop. Give up to three short bullet points about colour, texture and visible edges or gaps. If it does not clearly show rock or is unclear, say so. Do not infer rock type, minerals, strength, soundness, fracture cause, RQD, or numerical properties.

Use greedy generation (`do_sample=false`), a 128-new-token cap and repetition penalty 1.1 for both configurations. Record the exact prompt string and settings, not only their version number. The prompt deliberately does not assert that every input shows drill core: non-core images are negative controls.

Record completed, failed, cancelled and token-capped runs. A reached token cap remains visible even if the last sentence appears complete. Keep an initial failed attempt and its reason when retrying a transient download; do not choose the best answer from repeated successful generations. A fixed environment/resource budget applies equally to both configurations.

A Node CPU quality screen evaluates the text produced by those pinned weights and settings on CPU. It does not establish browser/WebGPU compatibility, mobile memory use or browser latency. Report a separate real browser compatibility check and keep its timings separate. Cross-device or retried runs are not a controlled speed benchmark.

## Visual reference prepared before inference

For each image, the reference JSON records:

- A neutral image ID, source mapping and hashes.
- The published class with its provenance, explicitly separated from scoring observations.
- Whether the visible material is clearly rock-like, clearly non-rock, or ambiguous. A non-core dataset label alone is insufficient to decide visual recognisability.
- Clear visual observations with IDs, category (`colour`, `texture`, `boundary`) and optional normalized image regions.
- Ambiguous features, resolution/lighting limitations and claims that cannot be established.
- Whether each rubric category is applicable. Mark a category inapplicable only when there is no defensible reference assessment, before seeing either answer.
- Reviewer identity recorded as **assistant visual review; not a geologist**, review time and protocol version.

Reference language describes appearances: for example, a pale narrow line, a granular surface or a dark gap. It does not silently turn a line into a natural fracture, a pale grain into quartz or an intact-looking surface into sound rock.

## Blinded scoring

An organiser assigns the two outputs anonymous IDs A and B, with assignment randomized per image using a recorded seed. Keep the identity mapping outside the scoring packet. The scorer receives the image, frozen visual reference, prompt and anonymous text, with model names, runtimes and timing removed. Score before unblinding. Record the actual scorer as an assistant unless a qualified human geologist genuinely performs the review.

Score each applicable category from 0 to 2. Give a short reason and reference-observation IDs. Do not reward verbosity, repeated synonyms or boilerplate uncertainty. Hedging does not rescue a visibly contradicted claim.

| Category | 2 points | 1 point | 0 points |
| --- | --- | --- | --- |
| Visible colour | Specific visible colour observations match the reference without unsupported precision. | Broadly plausible but generic, incomplete or omitted. | A substantive colour claim contradicts the image. |
| Visible texture or markings | Specific visible texture/marking observations are supported at this resolution. | Generic, incomplete or omitted; no substantive contradiction. | Invented or contradicted texture/markings, or unjustified detail below the image resolution. |
| Visible boundaries or gaps | Correctly describes the reference-visible boundaries, or explicitly recognizes that no reliable boundary is discernible. | Omits an applicable clear feature or is nonspecific without inventing one. | Invents a boundary, gap, count or arrangement, or confuses a label/photographic artefact with material. |
| Appropriate uncertainty | Matches the image's ambiguity; identifies a material limitation where needed and avoids pretending uncertain details are established. Clear observations do not need a disclaimer. | Generic uncertainty or incomplete treatment of an important limitation, without an unsupported confident conclusion. | Confidently resolves an ambiguous feature or falsely treats an unclear/non-core image as an established geological observation. |

Report points and the applicable maximum for each image. With all categories applicable the maximum is eight. Where applicability differs, use paired differences on the same image; do not present a pooled percentage as geological accuracy. Silence is not a specific useful observation merely because it avoids an error.

Also split the answer into atomic factual claims and label each:

- **Supported visually:** cite the reference observation or a directly inspectable feature. Any newly noticed feature is recorded as a post-hoc observation, not silently added to the frozen reference.
- **Supported only by published context:** the dataset may establish the fact, but the image-only task does not. This does not count as visual support.
- **Contradicted visually:** explain the conflict.
- **Not verifiable from this crop:** explain the missing evidence.
- **Appropriate abstention:** a justified statement that a feature or property cannot be established.

Use manual contextual judgement. A keyword detector must not flag “strength cannot be determined” as a strength prediction. Visible object counts may be assessed against the image; they are distinct from numerical engineering properties.

## Critical failures and usefulness

Separately flag any affirmative unsupported claim about lithology, mineral identity, soundness, rock quality, natural versus mechanical fracture origin, RQD or an engineering property. An assertion can be outside the permitted task even if the published lithology label happens to match it. A clearly non-rock control confidently interpreted as a rock specimen is also a critical failure. Qualifying an invented property with “possibly” does not make it a supported visual observation.

A critical failure cannot be offset by a high colour/texture score. Report the exact text and reason; do not replace these flags with a single average score.

An output is **useful and grounded** only if it provides at least one specific supported visual observation, contains no substantive visual contradiction and has no critical failure. For a negative or genuinely ambiguous control, correctly recognizing the limitation with a specific visible reason can qualify. “This is drill core” alone does not qualify.

## Reporting and decisions

Publish the complete per-image table, anonymized scores, claim classifications, critical failures, completion status and the identity mapping after scoring. Report model-level exact counts, paired wins/ties/losses, per-image score differences and resource observations. Do not claim expert agreement from agreement between language models or between assistant scorers.

Predeclared advancement gate for a larger pilot:

- At least six of eight useful-and-grounded outputs.
- Zero critical failures.
- Higher paired rubric scores on at least five of eight images, with no lower score on at least seven of eight.
- Successful runs within the predeclared device/resource budget; report every failure and capped answer.
- Gains across more than one independently identified borehole, with no source/licence ambiguity.

These are pilot decision rules, not a statistically validated accuracy threshold. Unknown borehole/parent-image identity makes the last criterion unassessable and prevents claiming that the advancement gate passed. The experiment can still inform an optional prototype and a better evaluation dataset.

Eight public patches are insufficient to make a stronger model the default or claim reliable geotechnical interpretation. Even zero failures in eight independent observations has a roughly 31% one-sided 95% binomial upper bound on the failure probability; correlated patches and unknown training exposure further limit that calculation. Keep the current default unchanged pending a broader, independently reviewed evaluation with identified held-out boreholes/sites and suitable real-device performance checks.
