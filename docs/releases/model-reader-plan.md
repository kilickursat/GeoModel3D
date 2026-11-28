# Plan: reading any borehole log with a fine-tuned model

Every company and engineer writes logs in a layout and language of their own. Rules written for one layout at a time cannot keep up. The example log of the TMR manual showed that in 0.31.0: it gives its boundaries as reduced levels, which no rule had foreseen.

This plan replaces that approach. The rules decide what each piece of a page means; instead, a model learns to read any log page and write it out in **our own format**. The app then checks every value against the page before anyone uses it. Everything runs on the device, as now. The fine-tuning runs on Modal.

Nothing in the app changes until the gates below are passed.

## Design

```
PDF page ─► text lines with IDs and boxes ─► Qwen (fine-tuned) ─► our format, values pointing to line IDs ─► checks ─► review ─► model
            (the PDF's own text, or          reads a reduced page                                          (app code)
             PP-OCRv6 for scans)             image + the list of lines
```

| Step | Done by | Why |
|---|---|---|
| Find the log pages | The app's page judging and `logEvidence` (as now) | The model reads log pages only, never a whole report |
| Read the characters and their positions | The PDF's text layer, or **PP-OCRv6** for scans (`src/docread/`, as now) | Exact text with exact boxes; 60 MB |
| Understand the page: which number is a boundary, a level or a test; which lines describe which layer; which column is SPT | **Qwen3.5 0.8B, fine-tuned** | What the per-format rules keep failing at |
| Arithmetic and checks (depth = ground level − R.L., depths increase…) | The app's code | Exact, and every step can be traced |
| Review | The existing review, each value beside its box on the page | Unchanged |

PP-OCRv6 stays: it and Qwen work together.

- **Qwen cannot invent a number.** Every value it gives is a reference to a line that exists on the page.
- **It fits in a browser.** Qwen does not read small text from pixels, so a reduced page image is enough; a full page at full resolution would be too heavy.
- **The rules reader becomes a cross-check.** Where both readers agree, confidence is high; where they disagree, the value is flagged. Without WebGPU, or if the model is not downloaded, the rules reader is used as now.

## The model

- **Base:** the Qwen3.5 0.8B already pinned for the core-photo evaluation (`src/coreBenchmark.ts`).
  - ONNX copy `onnx-community/Qwen3.5-0.8B-ONNX-OPT`, revision `9a4c21d8f724176b0a7edaaed36303044451886e`.
  - About 1.0 GB (1,049,662,346 bytes): embeddings and language model in 4-bit (`q4`), vision encoder in `fp32`.
  - Loaded on WebGPU by `@huggingface/transformers` 4.3.2 with `onnxruntime-web` 1.31.1 (`src/coreBenchmark.worker.ts`).
- **Fine-tuned copy:**
  - Fine-tune the original PyTorch weights (the source named in the ONNX repository's card) with LoRA on the language part only, the vision encoder frozen.
  - Merge, then convert to the same three ONNX files and quantization as the base.
  - Pin it and host it ourselves with a SHA-256 manifest, as the PP-OCRv6 files are.
  - Same size, about 1.0 GB. With the vision encoder frozen, its file may be shared with the core-photo copy (to check).

## Our format: what the model writes

The fields are the benchmark's annotation schema (`bench/schema/annotation.schema.json`). Every value is a **reference to a line**, never a number typed by the model:

- `{"line": 21}`: the number on line 21;
- `{"line": 7, "index": 1}`: the second number on line 7 (as in "412345.0 E; 6801234.5 N");
- `{"line": 21, "kind": "level"}`: a reduced level; the app computes the depth as ground level − level;
- `{"depth": 4.6, "kind": "scale"}`: a boundary drawn only as a line, at its depth on the scale (always flagged).

Descriptions are lists of line IDs, in reading order. A value the page does not give is `null`, so the model learns to leave it out rather than guess. A page without a log gives `{"log": false}`.

The input (invented values):

```
<page image, long side about 1024 px>
Lines (id|x0,y0,x1,y1 on 0–1000|text):
3|612,41,690,52|BH-X7
7|420,70,700,80|COORDINATES 412345.0 E; 6801234.5 N
9|40,70,180,80|SURFACE RL 5.40m
14|300,212,460,222|Silty CLAY (Topsoil)
15|300,224,450,234|Dark brown, moist.
21|90,204,120,214|5.25
…
Write the borehole log in the GeoModel3D format.
```

The output:

```json
{"log": true, "boreholes": [{
  "id": {"line": 3},
  "position": {"x": {"line": 7, "index": 0}, "y": {"line": 7, "index": 1}},
  "ground_elevation": {"line": 9},
  "final_depth": {"line": 88},
  "layers": [
    {"base": {"line": 21, "kind": "level"}, "description": [14, 15]},
    {"base": {"line": 33, "kind": "level"}, "description": [16, 17, 18]}
  ],
  "spt": [{"depth": {"line": 40}, "n": {"line": 41}}],
  "groundwater": null
}]}
```

## Checks on every answer

Before a value reaches the review:

- the referenced line exists and holds a number (or the words) at the place the answer says;
- depths increase down the log, and layers join without gaps or overlaps;
- a level-based depth equals ground level − level, and fits its place on the depth scale (as `levelBounds` checks now);
- the final depth is not above the base of the last layer; tests and water lie within the log;
- the position is plausible for the coordinate system given (as now).

A value that fails is flagged or dropped, never used silently. The benchmark's **unsafe builds** (a model built from wrong positions or values) must stay at 0.

## Data

| Source | Role | Notes |
|---|---|---|
| **Synthetic logs** | Most of the training | Unlimited, free, no licence or privacy question |
| **Real public pairs** (a PDF log and the same borehole's data in a file) | Close the gap between synthetic and real pages | **Check each licence first**, and drop any source with doubt |
| Benchmark reports | **Measuring only, never training** | Dev to iterate, validation to choose, a new held-out test for the final number |
| Private reports | **Never uploaded to Modal or used in training** | Read only on this machine, after export, as a local check |

### Synthetic logs: the generator

The generator draws random but realistic boreholes and renders each as a log page, with the exact answer. It varies:

- **columns:** their set and order (depth, R.L., thickness, legend, description, samples, SPT, water, core);
- **how boundaries are given:** depths written, reduced levels only, thicknesses only, or lines drawn only;
- **the header:** labels and their place, coordinates (X/Y, E/N, "… E; … N", latitude and longitude in degrees or DMS), datums (T.P., AHD, NAP, TAW);
- **languages:** English, Japanese, Dutch, German, French. Japanese fonts must be in the container (Noto CJK);
- **units:** metres or feet;
- **SPT styles:** N; 3 × 150 mm with N; 10 cm counts on JACIC forms; refusals ("50/12"); "N<1";
- **layout:** sheets of one log, several logs on a page, From/To tables, sample-depth logs, thin layers whose text runs below their base;
- **pages without a log:** text, sections, site plans. The answer is "no log".

Each log is produced twice:

1. **As a PDF with a text layer** (HTML/CSS templates printed by Chromium), for the born-digital route.
2. **As a degraded scan**: rasterised at 150–400 dpi, then blur, noise, skew, rotation, JPEG artefacts and stamps. The scan is read by **the app's own OCR code** (`src/docread/ocr.ts`, run in Node with `onnxruntime-node` and the same PP-OCRv6 files), so the model trains on the same imperfect text the app will see.

The answer refers to line IDs. Each value the generator drew is matched to the line that holds it, by place and text. A value that no line holds (lost by the OCR) becomes `null`, which teaches the model to leave it out.

Content should be realistic:

- soil and rock names from the logging standards (BS 5930, AS 1726, ASTM D2488, JGS 0051);
- plausible sequences, from fill through soils to rock;
- SPT values that rise with depth and depend on the material;
- water levels above the base of the hole.

Sizes: 10,000 pages for the first run, then 50,000 or more.

### Real pairs: candidates, each licence to check

- **Japan:** KuniJiban (国土地盤情報) electronic deliveries, as JACIC borehole XML with the 柱状図 PDF. The app already reads that XML (`src/boringXml.ts`).
- **Netherlands:** BRO geotechnical borehole descriptions (BHR-GT) and their rendered logs.
- **Flanders:** DOV borehole descriptions with their PDF logs. The benchmark already has one, `be-dov-1969-010172`.
- **United Kingdom:** AGS4 data submitted with their reports. The app reads AGS4 (`src/io.ts`).

Each pair goes through the same steps:

1. The file gives the answer, in our schema.
2. The PDF gives the lines.
3. Values are matched to lines.
4. Pairs that do not match well are dropped.

## Fine-tuning on Modal

Keep compute **and downloads** on Modal: the Qwen weights, the benchmark PDFs from their publishers, and the public pairs. Only public and synthetic data go there. Run at most 6 GPU containers at once (the workspace limit is 10), and one GPU plan at a time.

| Modal function | Machine | Does |
|---|---|---|
| `generate` | CPU, many containers | Render synthetic logs as PDFs and scans, with answers |
| `ocr` | CPU, many containers | Read the scans with the app's OCR code (Node and `onnxruntime-node`) |
| `pairs` | CPU | Download licensed public pairs and match their values to lines |
| `train` | GPU (A10G 24 GB, or L40S 48 GB) | LoRA fine-tuning; checkpoints saved to the Volume, resumable |
| `evaluate` | GPU | Run the PyTorch model on benchmark pages and score with `bench/scripts/score.py` |
| `export` | CPU or GPU | Merge, convert to ONNX in the base's file layout, quantize, compare with PyTorch |

Use one Volume, `geomodel3d-logreader`, with `data/`, `runs/` and `exports/`.

Starting settings, to tune (they have not been measured):

- **LoRA:** rank 16, alpha 32, dropout 0.05, on the language model's attention and MLP projections; the vision encoder frozen.
- **Training:** learning rate 1e-4 to 2e-4 with a cosine schedule, 1–2 epochs, bf16, gradient checkpointing, an effective batch of 16 by accumulation.
- **Loss:** on the answer's tokens only.
- **Input size:** a page image with a long side of about 1024 px, and sequences up to about 8,000 tokens (image, lines and answer).

## Into the app

1. **Export check before any training.** Convert the **unchanged** base model with our own export pipeline and run it in transformers.js 4.3.2 in the app. Its answers must match the pinned `onnx-community` copy on a few pages. If this path fails, the plan changes, so it goes first.
2. Run the fine-tuned model in a worker of its own, built like `src/coreBenchmark.worker.ts`:
   - an opt-in download, its size shown;
   - log pages only;
   - the answer's references resolved to values, then the checks above;
   - disagreements with the rules reader flagged.
3. Without WebGPU, or without the download, the rules reader reads the page, as now.
4. The review is unchanged, each value beside its box on the page.

## Gates

| Gate | Passed when |
|---|---|
| G0: export path | The unchanged base model, exported by us, runs in the app and matches the pinned copy |
| G1: synthetic | On held-out synthetic pages: valid JSON in at least 99 % of pages; boundaries, levels and tests almost all right |
| G2: benchmark | On dev and validation: fewer corrections needed than the rules reader (364 of 1,512 values on dev and 107 of 414 on validation in 0.31.1); **0 unsafe builds and no wrong value passing the checks**; the TMR example log read right without being trained on |
| G3: speed | Seconds per page on the owner's laptop GPU (Chrome, WebGPU) within a budget set beforehand |
| G4: real pairs | Adding the licensed real pairs makes no field worse; then the new held-out test, once |

## Steps

| Step | Work | Computer time |
|---|---|---|
| 1. Export check (G0) | 1–2 days | Minutes |
| 2. Generator, first version (10,000 pages, PDF and scan) | 3–5 days | Hours of CPU on Modal |
| 3. First training run and evaluation (G1, G2) | 1–2 days | Hours on one GPU |
| 4. Speed on the laptop (G3) | 1 day | Minutes |
| 5. Real pairs (licences, matching) and a second run (G4) | 1–2 weeks | Hours |
| 6. App integration, tests, changelog, guide | 3–5 days | Minutes |

## Risks

- Exporting a fine-tuned Qwen3.5 to the browser format may take work; step 1 finds out early.
- Long line lists (a dense log page can have 400–600 lines) make long prompts. Browser speed and memory must be measured (G3). If they are too much, read the header and the log body as separate parts of the page.
- Synthetic pages are cleaner than real ones; the real pairs and the scan degradation are meant to close that gap.
- A 1.0 GB optional download, plus GPU memory on the user's machine.

## Decisions for the owner

- The version this lands in, and whether the rule fixes of #52 are still worth doing first. For pages the model reads they are superseded. The benchmark runner fixes in #52 apply either way.
- Which real-pair sources to use, after their licences are checked.
- The speed budget for G3.
- A new held-out test split for the benchmark: the four keyed test reports were inspected while making 0.31.0.
