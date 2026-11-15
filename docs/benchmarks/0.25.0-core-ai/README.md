# Real core-image description pilot

This exploratory pilot compares SmolVLM 500M with Qwen3.5 0.8B on eight real published image patches. It tests short descriptions of visible features. It does **not** test lithology classification, strength, RQD, fracture origin or ground-model accuracy.

## Results and decision

Qwen met the frozen **minimum usefulness rule on 6/8 images**, compared with **0/8 for SmolVLM 500M**. It scored higher on seven paired images and lower on one. This supports further investigation of Qwen, with substantial remaining limitations: two answers contained substantive visual contradictions, and the review identified 14 claims that could not be verified from the crops. Even a useful answer can contain noncritical unverified interpretations.

| Original single-pass runs | SmolVLM 500M | Qwen3.5 0.8B |
|---|---:|---:|
| Completed generation | 8/8 | 8/8 |
| Met minimum usefulness rule | 0/8 | 6/8 |
| Nonresponsive answers | 6/8 | 0/8 |
| Answers with substantive visual contradictions | 1/8 | 2/8 |
| Answers with critical unsupported inference | 1/8 | 0/8 |
| Answers reaching the token cap | 2/8 | 0/8 |

The usefulness rule requires at least one specific supported observation, no substantive visual contradiction and no critical unsupported geological inference. It does not require every noncritical claim to be verified. The smaller count of contradictory SmolVLM answers reflects six nonresponses, not greater reliability. Its one critical answer speculates about mineral composition/deposits; both descriptive SmolVLM answers reach the output cap. Qwen has five contradicted atomic claims across its two failing images, alongside the 14 unverified claims.

| Image | Published source class | SmolVLM points /8 | Qwen points /8 | Qwen minimum usefulness |
|---|---|---:|---:|---|
| [01](outputs.md#sample-01) | Non-core/garbage | 4 | 7 | Met |
| [02](outputs.md#sample-02) | Non-core/garbage; mixed tray/rock edge | 4 | 6 | Met |
| [03](outputs.md#sample-03) | Limestone | 4 | 5 | Met |
| [04](outputs.md#sample-04) | Limestone | 4 | 2 | Not met |
| [05](outputs.md#sample-05) | Sandstone | 2 | 3 | Not met |
| [06](outputs.md#sample-06) | Sandstone | 2 | 5 | Met |
| [07](outputs.md#sample-07) | Shale | 4 | 5 | Met |
| [08](outputs.md#sample-08) | Shale | 4 | 7 | Met |

Rubric points are **not accuracy percentages**. The frozen rubric gives one point for an omitted category, so a nonresponsive answer can score 4/8 while failing usefulness. Do not reinterpret it as half-correct. Published classes do not score lithology predictions: inferring rock type was outside the task.

For example, Qwen describes the pale grey surface and absence of distinct gaps in image 03, but its “scratches” and stone/concrete resemblance remain unverified. On image 04, it incorrectly calls the surface featureless and suggests an abstract representation. The [complete illustrated output report](outputs.md) includes both successes and failures, with all text preserved.

The text-side pilot criteria are met by Qwen: six useful answers, zero critical failures, seven paired wins and no score regression on seven images. **The full advancement gate is not established**, because independent borehole identities are unverified; native-device suitability also remains unknown. The app's model selector and default are unchanged. Qwen remains a benchmark candidate, not an accepted geological classifier. A larger evaluation needs confirmed held-out boreholes/sites, independent geologist review, matched row/piece photographs and actual target-device measurements.

## Data and attribution

Two patches per published test class were selected before viewing images or model outputs: limestone, sandstone, shale and the dataset's non-core/“garbage” class. Selection uses seed `20261115` and ascending SHA256 of `seed + NUL + archive path`. All eight selected cases are retained. The second non-core control includes both tray material and a partial rock edge; its source label does not mean that no rock is visible anywhere.

The original is **Alzubaidi, Fatimah (2021), Lithology dataset, Mendeley Data V1, DOI [10.17632/b6rj29mrss.1](https://doi.org/10.17632/b6rj29mrss.1)**, with Geological Survey of South Australia photographs. The associated paper describes labels derived from trained-geologist logs. We retrieved the credited [Breejesh Dhar Kaggle mirror, version 1](https://www.kaggle.com/datasets/breejeshdhar/automated-lithology-classification). Original data declare CC BY 4.0; the mirror declares CC BY-SA 4.0. The copied/derived benchmark images and dataset manifest retain **CC BY-SA 4.0**, separate from the application's Apache-2.0 licence. See [NOTICE](NOTICE.md), [source provenance](source-provenance.md) and [exact sample manifest](dataset-manifest.json).

These are approximately 2 × 2 cm published patches, not complete drilling runs. Seven distinct filename prefixes resemble borehole identifiers, but their independence is unverified. This is not a site-held-out study; model pretraining overlap is unknown. Source lithology labels are contextual references, not fresh geologist validation of our crops or outputs.

## Frozen method

- The [prompt and generation protocol](protocol.json), [visual references](reference-review.json), [rubric](rubric.md), model revisions and image selection were frozen before inference. The assistant who prepared visual references saw source labels but no outputs.
- The [eight exact PNG inputs](inputs.json) use the app's crop geometry and Chromium Canvas2D: aspect-preserving 512 × 512 images. These small square patches are enlarged; interpolation adds no observed detail. Already cropped source images cannot establish a gain from whole-row to piece-level inspection.
- Both models receive identical image bytes and the same prompt, without source filenames, depth, lithology labels or other metadata. The app's version-2 description prompt exactly matches this pilot. The separate “observations” task is not evaluated here.
- One greedy generation per image/model, repetition penalty 1.1, at most 128 new tokens. SmolVLM runs first, then Qwen; cases run in ID order. There are no output-driven retries, exclusions or prompt tuning.
- Outputs are reviewed with A/B identity randomized independently per case. The scorer is an **AI assistant, not an independent human geologist**. Atomic claims, visual contradictions, critical unsupported claims and useful observations are assessed against the frozen rubric before unblinding.
- Quality inference runs locally on **ONNX Runtime Node CPU 1.30.0 / Transformers.js 4.3.2**, up to four threads. A concurrent software-WebGPU probe and application checks share the machine, so timings are diagnostic records, **not a controlled speed comparison or phone-performance measurement**.

| Configuration | Immutable Hugging Face revision | Dtypes | Weight bytes |
|---|---|---|---:|
| [SmolVLM 500M](https://huggingface.co/HuggingFaceTB/SmolVLM-500M-Instruct) | `753c1752602b5e739af7a7fa6947a635051897a3` | embeddings/vision fp32, decoder q4 | 811,545,504 |
| [Qwen3.5 0.8B OPT](https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX-OPT) | `9a4c21d8f724176b0a7edaaed36303044451886e` | embeddings/decoder q4, vision fp32 | 1,049,662,346 |

Both model repositories declare Apache-2.0. Tokenizers, runtime downloads and working memory are additional. Qwen uses the explicit `Qwen3_5ForConditionalGeneration` class and a verified non-thinking template (`enable_thinking=false`). Native model normalization/token grids differ, as recorded in the results. No image is sent to an inference service.

## Evidence

[All images and paired answers](outputs.md) · [Complete raw run metadata](results.json) · [Anonymous scoring](blinded-review.json) · [Identity mapping](model-mapping.json) · [Aggregated results](summary.json) · [Original-run integrity record](run-integrity.json) · [Frozen scoring rubric](rubric.md)

Anonymous scoring was frozen at `2026-11-15T07:13:21Z`, before unblinding: SHA256 `b5a5cf84d75dc828fd22c7b31cfc15661c12dff88dce2cc064fe1d5175e4e5f5`. The [original anonymous packet](blinded-outputs.json) is preserved, including its original local image paths; the actual image files are linked above. Mapping and aggregate results were published only after this freeze.

The integrity record was captured during the original run, before later script guardrails. The runtime, model configuration, prompt and inputs did not change. Exact original [runner](execution-source/benchmark-core-ai.mjs.txt) and [preparer](execution-source/prepare-core-benchmark.mjs.txt) source snapshots match that record's hashes; they are archived text, not entry points. The published reproduction scripts add checks to prevent replacing frozen inputs or overwriting earlier runs.

## Separate WebGPU compatibility check

The same pinned Qwen configuration completed an actual **32-token browser generation** on image 03 using Transformers.js 4.3.2 and ONNX Runtime Web 1.31.1. This was an isolated worker probe, outside the application model selector. It used Chromium 156's **SwiftShader software WebGPU adapter**, with no `shader-f16`, and the frozen prompt/non-thinking setting. All six ONNX graph/data files and five configuration/tokenizer files matched the immutable revision's hashes. A local read-only mirror served those verified cached files; all 26 browser requests stayed on localhost and no image was uploaded.

| Software-WebGPU diagnostic | Observed |
|---|---:|
| Local model initialization/load | 10.62 s |
| First token after generation started | 732.88 s |
| Generation, including image/prompt computation | 1,124.23 s |
| Total probe | 1,135.86 s |
| Output | 32/32 tokens; deliberately capped |

This establishes execution for that bounded probe, not acceptable latency on a real GPU or iPhone. Concurrent jobs shared the machine. The output is truncated and **excluded from all quality scores**. Its text differs from the CPU run's prefix; CPU scores must not be relabelled as WebGPU scores. Native iPhone Safari, memory use and complete 128-token browser quality evaluation remain untested.

An initial attempt stopped before inference because Transformers.js checked tokenizer existence at an unversioned `main` URL, which the strict local mirror rejected. Pinning `env.remotePathTemplate` to the same immutable revision fixed that metadata request; the image, prompt and model bytes were unchanged. Both attempts are retained. See the [compact result](webgpu/summary.json), [source and execution provenance](webgpu/execution-provenance.json), [compressed original trace](webgpu/raw-result.json.gz) and [artifact hashes](webgpu/artifact-manifest.json). Archived probe sources are evidence snapshots, not a new application runtime.

## Reproduce

From the repository root:

```sh
npm ci
python3 scripts/fetch-core-benchmark.py
node scripts/prepare-core-benchmark.mjs
node scripts/benchmark-core-ai.mjs --out .cache/my-core-pilot
```

The Python downloader uses bounded public HTTP range requests to retrieve the eight frozen JPEGs, verifies source hashes and leaves them in `.cache/`. The preparer regenerates pixels locally and compares against the published baseline; a different Chromium image pipeline may fail exact PNG identity. Use the browser version recorded in `inputs.json`, or create a separately versioned baseline rather than replacing this one. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select a local Chromium binary; otherwise the script uses system Chromium when available or Playwright's installed browser.

The runner verifies the ordered source/input manifests, downloads only the pinned public model files into `.cache/`, runs locally, and writes every result plus an anonymous scoring packet to a **new** output directory. It refuses to overwrite an existing run. Model downloads total approximately 1.86 GB before tokenizer/runtime files. A network that requires an HTTP proxy may need Node 24's `--use-env-proxy` option; normal direct-network environments can use the command above.

Preserve failed and capped runs. Score the anonymous paired packet before opening its model mapping; use qualified independent reviewers for a larger evaluation. Repeated local executions can differ by platform/runtime and do not turn eight public patches into an accuracy validation.
