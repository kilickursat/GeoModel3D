# GeoModel3D public reading benchmark (v0.1, work in progress)

A benchmark of real, openly licensed geotechnical reports with borehole logs. It measures how well GeoModel3D's
on-device reader turns a report into boreholes, and whether a 3-D ground model can be built from them, one change
at a time. **It is not complete.** `scripts/validate.py` lists what is still open (see "Status").

## What is here

| Path | What it is |
|---|---|
| `manifest/sources.json` | The reports: publisher, source URL, licence and the evidence for it, country, language, layout family, scan quality, split, SHA-256 of every file. Also the sources that were considered and **excluded**, with the reason. |
| `schema/annotation.schema.json` | The ground-truth format (version 1.0.0): page types, borehole IDs, positions, ground levels, final depths, layers, SPT, RQD, groundwater, readiness, and a source page for every value. |
| `guidelines/ANNOTATION.md` | How a report is annotated, including the privacy rules and when the right answer is to abstain. |
| `annotations/*.json` | Ground truth, one file per report. All are **drafts** (`status: draft`) until a person verifies them. |
| `scripts/fetch.py` | Downloads the reports from their publishers into `.cache/` (git-ignored) and checks their SHA-256. The PDFs are never committed. |
| `scripts/validate.py` | Checks the manifest, the splits and every annotation, and reports what is missing before the benchmark can be called complete. |
| `runner/read.ts`, `runner/ocr.mjs` | Run the app's own reader (as in `src/docread/index.ts`) and its own OCR worker (PP-OCRv6 small, headless Chromium, no server, no network). |
| `scripts/score.py` | Scores predictions at four independent levels, with failure categories, timing and correction effort. |
| `tools/` | Annotation aids that copy a text layer into a draft. The annotator checks every value against the page. They never read the reader's output. |
| `results/baseline-v0.30.0/` | Scores of the frozen v0.30.0 reader. See [BASELINE.md](BASELINE.md). |

## Running it

```sh
python3 -I bench/scripts/fetch.py                     # the reports, from their publishers
python3 -I bench/scripts/validate.py                  # manifest, splits, annotations, completeness
npm run build                                         # the OCR worker and model used by runner/ocr.mjs
node_modules/.bin/esbuild bench/runner/read.ts --bundle --platform=node --format=esm --packages=external --outfile=.cache/bench-read.mjs
RUN=bench/.cache/runs/my-run
node .cache/bench-read.mjs plan $RUN                  # pages the app would read by OCR
node bench/runner/ocr.mjs $RUN                        # resumable; Chromium via PLAYWRIGHT_CHROMIUM_EXECUTABLE
node .cache/bench-read.mjs read $RUN                  # predictions/<report>.json
python3 -I bench/scripts/score.py $RUN                # scores.json
```

The runner calls the reader's own functions, so it goes with the app's code. From the second commit of this
benchmark, it also reads the lines drawn on each page (`src/docread/ruling.ts`, from #50) and the penetration tests,
and needs that code. The 0.30.0 baseline was run with the runner of the first commit.

## Rules

- **Real reports only.** No synthetic documents or values. The answer keys are transcriptions of the pages.
- **Explicit open licence only.** A publisher that refuses plain requests (HTTP 403, a login page) is dropped, never
  worked around. A report written by a third party with no licence of its own is dropped.
- **No personal data.** Names, signatures, registration and telephone numbers on the logs are not transcribed.
- **Private reports stay out.** Company reports are never part of the benchmark or this repository.
- **Splits by report**, with related documents (same programme, same survey) kept in one split. Anything used while
  developing the reader goes in `dev`. `test` is scored only for baselines and release candidates. Its failures are
  not inspected page by page to tune the reader.
- **Abstaining can be the right answer.** A report without logs, or with logs that have no position, should produce
  "no spatial model". Readiness is scored for that, and a model built from invented or misread positions counts as an
  *unsafe build*.

## Status (2026-11-24)

- **Reports:** 21 reports from 7 publishers in 4 countries (Japan 16, USA 4, Belgium 1, Australia 1). 17 are annotated
  as drafts: 104 boreholes, about 700 layers and about 1,300 SPT tests.
- **Not yet annotated:** `jp-neyagawa-clean-center` (vector drawing sheets, no text) and three USGS reports
  (`ofr94-706`, `ofr2011-1281`, `ds660`).
- **Verification:** no annotation has been verified by a person. Annotation was done by an AI assistant and needs
  human review.
- **Licences:** three Japanese publishers mark their data CC BY without a version. To be confirmed with the
  publisher.
- **Coverage:** the validation split has no abstention case yet. Text-layer reports are mostly Japanese.

The aim is up to 30 reports. Norwegian NADAG reports (NLOD) and more US federal reports are the next candidates.
