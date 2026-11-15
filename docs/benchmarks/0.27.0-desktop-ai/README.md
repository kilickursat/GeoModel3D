# Qwen desktop hardware-GPU evaluation

The next Qwen milestone targets a documented desktop or laptop with a hardware GPU. **Chrome is the preferred browser; Edge is another candidate to validate per configuration. iPhone and other mobile AI testing are optional and do not block this desktop milestone.** Existing mobile modelling and manual core-photo workflows continue independently.

No desktop hardware-GPU inference or new quality result is claimed here. The current managed test environment exposes no usable hardware adapter. Qualified human grading, authoritative source independence and GPU/process memory suitability also remain unassessed. Qwen stays an evaluation candidate outside the application's normal model selector.

## What is frozen

The [desktop evaluation plan](evaluation-plan.json), `qwen-desktop-1`, was frozen at `2026-11-15T12:22:04Z`. Its SHA256 is `8c5ec24878ff5efd8ac16c2f45fc10e75852614dc485bfe3b1ae4af43a9449a3`.

This plan changes the required device target for newly started runs. It references the unchanged [0.26 inference protocol](../0.26.0-core-ai/protocol.json), [visual rubric](../0.26.0-core-ai/rubric.md), forty prepared images and their hashes. Model revision/dtypes, runtime versions, prompt, generation settings and 32/128-token modes are unchanged. The original [study and source credits](../0.26.0-core-ai/README.md) remain the source for data provenance and limitations.

Only new runs receive the desktop plan ID/hash and selected evaluation target. Historical CPU, software-WebGPU and saved legacy runs retain their original identity; they are not relabelled as desktop hardware evidence. Selecting a desktop target or seeing a hardware-looking adapter string does not verify a physical desktop or establish support across other GPUs and browsers.

## Run the desktop check

1. On the actual desktop or laptop, open Chrome. Enable its graphics/hardware acceleration setting, restart Chrome if that setting changed, and inspect `chrome://gpu` for the reported GPU and WebGPU status. Record the machine, OS, GPU, browser versions, date and power/load conditions. Avoid treating software rendering as a hardware result.
2. Open the [Qwen evaluation page](https://kilickursat.github.io/GeoModel3D/core-ai-benchmark.html). Choose **Desktop/laptop Chrome or Edge (primary)** under **Evaluation target**, and fill the **Machine / OS / GPU / browser** label. That information remains self-reported, separate from browser and worker observations. An unknown adapter is unassessed.
3. Before viewing generated answers, have a qualified reviewer use **Review source images** and **Download blank review sheet**. Freeze the image-only reference file and record its hash, reviewer role/qualification basis and disclosure order. Follow the unchanged [human-review guide](../0.26.0-core-ai/human-review-guide.md), [CSV template](../0.26.0-core-ai/human-review-template.csv) and rubric. Previously published model outputs must not be shown to the reference reviewer first; disclose exposure and obtain a fresh reviewer if necessary.
4. Select **One case**, **case-01** and **Compatibility check · 32 tokens**. Acknowledge the approximately 1,001 MiB weight download, then run once. Keep the page visible and screen awake. Export the complete report, including any failure or interruption. Resolve execution failures before starting a quality cohort; a successful compatibility check is not a description-quality score.
5. Start a separate run with **All forty cases** and **Description evaluation · 128 tokens**. Cases execute sequentially in the fixed order. Retain all answers, capped outputs, failures, cancellations and unstarted cases. Do not select a preferred answer from retries. Keep the original attempt if a diagnostic retry is necessary.
6. Use **Export results JSON** to retain the run and its technical summary. Keep this file with the frozen image-only references, later masked human grading and machine records. Evaluate Chrome and Edge configurations separately; a result on one configuration does not establish support on another.

The page reads only the fixed public study images and does not change accepted logs, RQD, laboratory values or ground-model geometry. Downloading files and allocating the model are separate from generation time. Available cached files may be reused, but a newly loaded model session is still cold.

## Read the technical summary

Summaries describe each recorded run separately: selected/completed/failed/unstarted cases, capped outputs, adapter observations, and available loading, first-token and full-case timing. They do not award overall approval or infer human quality, physical-device verification, source independence or memory suitability.

- A **warm** case completed with `modelReused=true` in the same retained worker/model session. Cached downloads alone do not make the session warm.
- Warm p95 requires at least **30 valid samples for each metric**, using nearest rank `ceil(0.95 × n)`. Missing timing fields remain missing. Slow successful samples stay included; failures are retained outside successful-latency samples.
- `firstTokenMs` starts at `model.generate` and excludes loading/preprocessing. Full-case `elapsedMs` includes image fetch/verification, client/worker work and receipt of the result. Worker `totalMs` must not substitute for missing full-case time.
- Never pool across runs, machines, protocols, quality/compatibility modes, CPU/WebGPU or hardware/software adapters. Compatibility output is excluded from quality evaluation.
- GPU/process peak memory is unknown unless measured with a named external method and declared budget. JS heap, weight bytes and a per-buffer limit are not total model memory measurements.

The plan retains proposed research screening thresholds, including a complete forty-case quality run and qualified human grading. These are not validated accuracy standards or service guarantees. Authoritative case-level borehole mapping remains missing; filename groups and the source lithology classes cannot establish independent held-out holes or new human visual ground truth. No automatic ground-model or engineering-property claim follows from a useful description.

## Current environment evidence

The [availability probe](evidence/environment-availability.json) found no DRI/NVIDIA device nodes or hardware Vulkan ICDs in this managed container. Chromium 156 on secure localhost exposed the WebGPU API, but both default and high-performance adapter requests returned `null`; Chromium reported only SwiftShader software rendering. No weights were downloaded and no inference was run. This inventories the managed environment, not its physical host or another user's computer.

Probe SHA256: `2f406865fc11a8761690c3a935f795c3888c7a0803c19a2f6fb9ccb49b862918`.

A documented hardware-GPU machine is therefore still needed for the desktop run. The previous forty CPU completions and software-WebGPU timeout remain separate evidence and cannot fill this gap. A broader support or quality showcase requires the missing hardware, human-review, source and memory evidence.
