# Baseline: GeoModel3D 0.30.0 (PP-OCRv6 small + rules), frozen

Reader at `main` 8625e49 (release 0.30.0), unchanged. OCR by the app's own worker in headless Chromium on the
processor (WASM). Scores in [`results/baseline-v0.30.0/scores.json`](results/baseline-v0.30.0/scores.json).

> **Draft.** All annotations are drafts made with an AI assistant and not yet verified by a person, and four reports
> are not annotated yet. These numbers show where the reader stands. They are not a final measurement.

## Results by split (17 annotated reports)

| | dev (10) | validation (3) | test (4) |
|---|---|---|---|
| **1. Document understanding** | | | |
| log pages found (recall / precision) | 0.75 / 0.96 | 1.00 / 0.58 | 0.74 / 0.99 |
| log pages found *and* read into a borehole | 0.17 | 1.00 | 0.74 |
| **2. Borehole assembly** | | | |
| boreholes found (recall / precision) | 0.67 / 0.94 | 1.00 / 1.00 | 0.95 / 1.00 |
| IDs right, of those found | 19 / 30 | 7 / 14 | 13 / 19 |
| split or merged boreholes | 0 | 0 | 0 |
| **3. Field extraction** (recall, on boreholes found) | | | |
| position | 0.00 | 0.00 | 0.00 |
| ground level | 0.13 | 0.21 | 0.00 |
| final depth | 0.13 | 0.43 | 0.00 |
| groundwater | 0.00 | 0.00 | 0.00 |
| layer boundaries (recall / precision) | 0.31 / 0.11 | 0.40 / 0.11 | 0.23 / 0.08 |
| principal material, depth-weighted | 0.04 | 0.01 | 0.14 |
| SPT N values | 0.00 (not output) | 0.00 (not output) | 0.00 (not output) |
| RQD | 0.00 | n/a | n/a |
| **4. Ground-model readiness** | | | |
| right decision | 5 / 10 | 0 / 3 | 1 / 4 |
| correct abstentions / abstention cases | 5 / 5 | n/a | 1 / 1 |
| unsafe builds | 0 | 0 | 0 |
| **Correction effort** | | | |
| edits needed / values in the truth | 2,002 / 1,512 | 671 / 414 | 1,212 / 784 |
| **Time (this server, WASM)** | | | |
| text layer + reconstruction | 10 s, 254 pages | 4 s, 73 pages | 67 s, 1,312 pages |
| OCR | 31 min, 57 pages | 15 min, 29 pages | 5.4 min, 22 pages |

Edits are field-level: a value added, deleted or changed. Correcting the draft takes more edits than typing the
values from scratch, because spurious layer boundaries must also be deleted. "Automation" is 0 on every report for
that reason.

## Main failures, by count

1. **Spurious layer boundaries (1,362).** On Japanese JACIC logs the reader cuts a layer at every line of the
   remarks column and at SPT depths, so it reports 3–4 times too many layers.
2. **SPT not output (872).** The reader has no SPT field. The benchmark counts these as missed so that the gap stays
   visible.
3. **Header values not read on Japanese forms.** Position (latitude and longitude in degrees, minutes and seconds),
   孔口標高 and 総掘進長 are missed on every JACIC log. As a result the reader abstains on reports that can be
   modelled (0 of 6 `spatial_model` cases). It is safe, but wrong.
4. **Unit names not mapped (409 relabels).** Japanese descriptions read from the remarks column go into the unit
   unmatched, so the principal material is "other".
5. **Log pages not read.**
   - Feet-scale USGS logs: 0 of 9 sampled boreholes.
   - The DOV From/To report: 0 of 1.
   - Rotated A3 scans (2 of 4 apple-centre logs).
   - A well log drawn sideways.

What works:
- Log pages are rarely confused with other pages.
- Born-digital Japanese logs are grouped into boreholes with no splits or merges.
- The reader never built a model from positions it did not have (no unsafe builds), and it abstained correctly
  on all six reports without logs or positions.

## What this says about the next step

The largest losses come from reading the layout of standard forms (header cells, column roles), not from
character recognition. Most failing pages are born-digital, and OCR was not involved. That points to page-layout and
field rules for the JACIC form and feet-scale logs before any new model. PP-DocLayout-S (about 5 MB, PaddleOCR
layout detection) could help find header blocks and tables. It should be measured on this benchmark against this
baseline, on `dev` and `validation` first, and only then on `test`.
