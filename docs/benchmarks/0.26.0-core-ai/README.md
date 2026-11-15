# Qwen device evaluation: forty new images

GeoModel3D 0.26.0 provides a [local browser evaluation page](https://kilickursat.github.io/GeoModel3D/core-ai-benchmark.html) for the pinned Qwen3.5 0.8B model. Forty new public image patches and a reference-review workflow are ready. **Human visual quality, verified borehole independence and physical iPhone performance remain unassessed.** There is no new accuracy score or default-model promotion.

The earlier [eight-image pilot](../0.25.0-core-ai/README.md) found promising but imperfect descriptions. Its 6/8 minimum-useful result must not be reused as a score for this new cohort, for WebGPU output, or for geological properties.

## Run on your own device

1. Open the [evaluation page](https://kilickursat.github.io/GeoModel3D/core-ai-benchmark.html) in the browser you want to measure. For an iPhone result, use the actual phone in Safari; a desktop phone-sized viewport is not a device test.
2. If preparing human reference observations, use **Review source images** and **Download blank review sheet** before reading model answers. Follow the [human-review guide](human-review-guide.md), record the reviewer's role/qualification basis, and freeze the image-only reference file before output disclosure. The template has no invented reviewer or scores.
3. For an initial execution check, select one case and **Compatibility check · 32 tokens**. Starting requires an explicit acknowledgement: weights are about 1,001 MiB, with tokenizer/runtime downloads and working memory additional. The chosen public images load from this site; inference stays in the browser.
4. For the quality study, use **Description evaluation · 128 tokens** and **All forty cases**. A one-case or first-five run is partial. Keep every attempt, failure and capped output; do not choose a better answer from repeat runs. The first five are only the first five IDs, not a representative miniature study.
5. Keep the page visible and the screen awake. Stop, leaving the page or switching apps interrupts the current case and unloads the model. Completed and unstarted records remain separate. Reports are saved in this browser when storage permits; reopening restores history without restarting inference. Export JSON for a durable copy, especially if storage is unavailable.
6. Record device model, OS/browser version and conditions in the optional device label. It is explicitly self-reported and separate from actual browser/adapter information. Export the report and keep it with the frozen human reference and later grading files.

The page does not upload images or reports, read a project, or write accepted logs/RQD/properties. Its model cache and saved reports have their own names; clearing them leaves project storage and the existing SmolVLM cache alone. The hosted evaluation page is separate from the standalone HTML and from the application's model selector.

## Fixed inputs and protocol

Ten images were selected from each published class: garbage/non-core, limestone, sandstone and shale. All forty differ from the original eight and from their inferred parent trays. A seeded selection limits repeated filename-prefix groups; **these are grouping heuristics, not verified borehole IDs**. Source identity was frozen before viewing or inference, followed by exact input hashes. Published classes originate from the dataset's geologist-derived lithology logs; they are not new human visual review of this study.

[Source provenance and sampling](source-provenance.md) · [Full source manifest](dataset-manifest.json) · [Neutral public input manifest](../../../public/core-benchmark-v026/manifest.json) · [Input preparation](../../../public/core-benchmark-v026/inputs.json) · [Attribution and CC BY-SA 4.0 notice](NOTICE.md)

The [frozen protocol](protocol.json) specifies the unchanged description prompt, pinned model/runtime, 512-square PNG input, greedy generation and repetition penalty 1.1. Quality mode permits 128 tokens; compatibility mode permits 32 and is excluded from quality scoring. Source filenames, classes, depth and geological labels are not sent to the model. Enlargement adds no observed detail.

- Protocol SHA256: `59048ae5c9210239225c04867675594b192d61d46e3d26ca1f4f92232b483ea1`.
- Rubric SHA256: `6422732b8ba1a6efe780e1e979c6b994a67737ca1501e0f126b4c3369fc77b09`.
- Public input manifest SHA256: `b61549c3de8714e2f015056276efc23dfb3c6f3e1206fbd6611b68af3712c391`.

The thirty-minute per-case ceiling covers image loading, validation and inference. It is a protective timeout, not a practical phone latency target. The report records full case elapsed time separately from model loading, preprocessing, generation and first-token timing. First-token time starts at `model.generate`; it excludes loading and preprocessing. Available JavaScript heap measurements are labelled as such. Total GPU memory remains unknown.

## Evidence required before advancement

| Evidence | Status |
|---|---|
| Forty fixed public inputs and reproducible preparation | Prepared and integrity-checked |
| Qualified human image-only references and subsequent output grading | Pending |
| Authoritative image-to-borehole mapping and independent held-out holes | Unverified |
| Complete forty-case quality run on a physical target phone | Pending |
| Useful-description and fully-supported-description counts | Unassessed; no automatic score |
| GPU/process memory budget | Unassessed; browser JS heap is not GPU memory |
| Application model selector/default | Unchanged |

The [rubric](rubric.md) separates minimum usefulness from fully supported descriptions. Missing evidence is unassessed, never a passing result or a zero score. Research thresholds in the protocol are proposed screening criteria, not accepted user performance requirements or validated accuracy standards. A qualified human must supply observations and grades; an assistant is not presented as a geologist.

Source data cover only three published lithology classes and heterogeneous controls, with uncertain independence and pretraining overlap. They do not establish representative lighting, wet/dry or geological diversity. They cannot validate RQD, soundness, fracture origin, strength, engineering parameters, whole-row versus piece-crop benefit, or ground-model accuracy.

## Supplemental CPU execution record

All forty original single-pass Qwen CPU generations completed. Cases **02, 05 and 13** reached the 128-token limit; all outputs and caps are retained. No human quality scores were calculated. These CPU runs cannot fill missing WebGPU cases or establish physical-device performance. Timings were collected under shared machine load.

[Execution summary](evidence/cpu/summary.json) · [All raw outputs and metadata](evidence/cpu/results.json) · [Exact execution-source hashes and snapshots](evidence/cpu/execution-source.json)

The raw output file SHA256 is `56d1beb4f1d031a355d59b3b3dd75d1e8e3dbf9626e459cd0e60265c2dbd1e34`. **Reference reviewers should not open generated outputs before freezing their image-only observations.** If a reviewer has already seen outputs, record that exposure and obtain a fresh blinded reference reviewer.

## Actual software-WebGPU attempt

The single preselected browser attempt used **case-11, quality mode, 128-token cap and a thirty-minute total case budget**. It **timed out after 72 streamed tokens**, without a completed answer. The page terminated the worker and preserved the incomplete export. Coverage is **0/40 completed browser-quality cases: one timed-out attempt and 39 unselected cases**. No retry, shorter-cap substitute or quality score was used.

This was actual Qwen inference in Chromium 156 on SwiftShader software WebGPU under shared machine load. First-token time was about 795 seconds from `model.generate`, excluding model loading and preprocessing. These measurements do not describe native GPU or physical iPhone performance. Hash-verified pinned Hugging Face files were served from a local cache through redirects; this does not validate a phone's live model-download path.

[Execution summary](evidence/webgpu/summary.json) · [Preserved browser evidence](evidence/webgpu/)

The final release worker is byte-identical to the tested worker. After the attempt began, only the page's export metadata was clarified: partial-cohort status, a separate in-progress flag and timing definitions. The original tested entry bundle and raw report are preserved unchanged, and the summary states the actual incomplete coverage explicitly. An initial snapshot-copy setup failure occurred before any browser inference and is retained separately.

## Reproduce the input preparation

```sh
npm ci
python3 scripts/fetch-core-benchmark-expanded.py
python3 scripts/fetch-core-benchmark-expanded.py --verify-only
node scripts/prepare-core-benchmark-expanded.mjs
npm run build
```

Original JPEG downloads stay in the ignored cache. The frozen PNGs and manifests are checked into `public/core-benchmark-v026/` with their own licence notice. Preparation verifies rather than overwrites the published baseline. A different browser image pipeline requires a separately versioned experiment.

Serve `dist/` over HTTPS or localhost and open `core-ai-benchmark.html`. No model weights are included in the build. The benchmark gets a separate Vite pass so the normal application retains its single-entry standalone build.
