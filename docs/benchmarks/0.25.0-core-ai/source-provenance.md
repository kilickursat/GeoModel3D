# Source provenance for the eight-image pilot

The pilot uses eight real drill-core image patches from Fatimah Alzubaidi's published *Lithology dataset*, downloaded on **15 November 2026** from a credited public Kaggle mirror. These are small, already cropped images with published lithology classes. They are suitable for a limited diagnostic of image descriptions and unsupported claims; they do not establish engineering-property accuracy.

## Sources and annotation history

The [original Mendeley dataset](https://data.mendeley.com/datasets/b6rj29mrss/1), DOI `10.17632/b6rj29mrss.1`, explicitly licences its core images under **CC BY 4.0**. It describes 2 × 2 cm patches created from Geological Survey of South Australia core-tray images, organized into sandstone, limestone, shale and a non-core class named `garbage`.

The associated paper's [section 2.2, Image datasets and data preparation](https://www.sciencedirect.com/science/article/pii/S0920410520309888#sec2) reports 858 trays from 28 South Australian boreholes. It says the lithology labels were based on trained geologists' logs and that final cropped images were manually examined. This is the published provenance of the reference labels. No new geologist has reviewed these eight images or the model outputs on behalf of this project.

Paper citation: Alzubaidi, F., Mostaghimi, P., Swietojanski, P., Clark, S.R., and Armstrong, R.T. (2021), “Automated lithology classification from drill core images using convolutional neural networks”, *Journal of Petroleum Science and Engineering* 197, 107933, https://doi.org/10.1016/j.petrol.2020.107933.

The [Kaggle mirror](https://www.kaggle.com/datasets/breejeshdhar/automated-lithology-classification), published by Breejesh Dhar, cites the original dataset DOI and declares **CC BY-SA 4.0**. We preserve both credits and use the mirror's share-alike notice for the downloaded images and derived benchmark data; see [NOTICE.md](NOTICE.md). The mirror version is pinned to `1`, dataset ID `3709250`, version bundle `6428854`.

Mendeley's offered archive could not be downloaded from this execution environment (HTTP 403). No login, bot challenge, or access restriction was bypassed. The independently offered Kaggle public download succeeded without authentication. The mirror's declared provenance links the images to the original research; we did **not** compare its files byte-for-byte against the original Mendeley archive. The original landing page reports archive SHA-256 `6db325de3c829dd2c0ada6a1528d94479e845f8c82e2703a6f65479a44e2f912`, retained in the manifest as an unverified original-archive reference.

## Selection before viewing

The seed **`20261115`** and rule were fixed before viewing images or model outputs. For each of the four classes, sort its 3,000 `test/` archive paths by the hexadecimal SHA-256 of UTF-8 `(seed + NUL + original path)`, then select the first two. All eight selected patches were retained. This gives six core-class patches and two non-core controls, without selecting visually easy examples.

The non-core folder is the source's `garbage` class, which includes tray regions, labels, and other objects. It does not mean every pixel must be non-rock. In particular, `sample-02` includes tray grooves and part of a rock edge. Published lithology labels are kept outside model prompts; visible-observation review is separate from class comparison.

Each entry in [dataset-manifest.json](dataset-manifest.json) records the original path, published class, deterministic rank, SHA-256, ZIP CRC, byte count, dimensions, cache path, and licence. Seven images are 300 × 300 pixels and one is 280 × 280 pixels; the eight JPEGs total **82,682 bytes**.

Filenames contain seven distinct borehole-like prefixes. They are recorded as `holeLikeToken` with `holeLikeTokenVerified: false`; they are **not verified borehole identifiers**. The archive does not establish how those tokens map to holes, sites, depths, or logs. Two samples share `07PD01`. Consequently, neither eight independent sites nor a site-held-out evaluation is claimed.

## Reproduction

From the repository root, run:

```sh
python scripts/fetch-core-benchmark.py
python scripts/fetch-core-benchmark.py --verify-only
```

The downloader needs only Python's standard library. It writes unchanged source JPEGs to the git-ignored `.cache/v025-core-benchmark/images/` directory. `--cache-dir PATH` selects another cache. `--verify-only` requires all eight files and checks their frozen hashes without network access. Existing mismatched files cause failure rather than being silently replaced.

The pinned public archive contains 101,995 files and is 1,201,499,645 bytes. The downloader reads the ZIP central directory and selected entries using exact HTTP byte ranges, checking archive size, file count, class counts, deterministic selection, per-entry CRC, expected filenames and image hashes. A fresh retrieval consumes approximately 12.8 MB of range payload instead of the entire archive. If the source changes or a server ignores ranges, it fails rather than choosing replacement images or downloading the whole archive.

## Limits on conclusions

- Eight patches form a diagnostic pilot, not a representative accuracy estimate.
- The published `test` folder does not establish a site/borehole holdout or absence from general-purpose VLM pretraining.
- The source contains pre-cropped 2 × 2 cm patches, without matched parent tray photographs. It cannot establish a whole-row versus close-crop improvement.
- Published lithology classes do not provide ground truth for visible fracture origin, RQD, recovery, strength, RMR, Q, weathering grade, engineering properties, or a 3D ground model.
- Any separate visible-observation rubric created for this pilot is not a new geologist's assessment.

The associated paper's reported model accuracy concerns its own CNNs, dataset and evaluation. It must not be attributed to GeoModel3D's general-purpose vision-language models.
