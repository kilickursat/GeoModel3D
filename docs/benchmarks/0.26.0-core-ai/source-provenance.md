# Forty-image source provenance

This follow-up uses **40 new, already cropped real images** from the same pinned public lithology dataset as the 0.25 pilot: ten each from its `garbage`, limestone, sandstone and shale test classes. It is an expanded class-balanced screening set, not a verified borehole/site-held-out validation set. No new human geologist has reviewed these images for GeoModel3D.

## Original source, mirror and licences

The original source is **Alzubaidi, Fatimah (2021), Lithology dataset, Mendeley Data V1**, DOI [10.17632/b6rj29mrss.1](https://doi.org/10.17632/b6rj29mrss.1). The source images are credited to the Geological Survey of South Australia. The original dataset declares CC BY 4.0.

The associated paper, [Automated lithology classification from drill core images using convolutional neural networks](https://doi.org/10.1016/j.petrol.2020.107933), *Journal of Petroleum Science and Engineering* 197, 107933, describes 858 trays from 28 South Australian boreholes in section 2.2. Its lithology labels were derived from trained geologists' logs; cropped images were manually examined. This establishes the provenance of published class labels. It does not provide newly reviewed colour, texture, boundary, uncertainty or engineering-property references for this evaluation.

Images were downloaded on 15 November 2026 from Breejesh Dhar's credited [Automated Lithology Classification Kaggle mirror, version 1](https://www.kaggle.com/datasets/breejeshdhar/automated-lithology-classification). The mirror cites the original DOI and declares **CC BY-SA 4.0**. Dataset ID is `3709250`, version bundle `6428854`, archive size `1,201,499,645` bytes. The copied and derived data preserve that share-alike notice and both source credits; see [NOTICE.md](NOTICE.md). Application/downloader code remains Apache-2.0.

The original Mendeley archive was inaccessible from this environment during the earlier pilot (HTTP 403); no access workaround was used. The independently offered public Kaggle download works without authentication. Byte identity between the mirror and original Mendeley archive has not been verified. Source SHA256 hashes identify the exact mirrored JPEGs used here.

## Selection frozen before viewing or inference

The source identities were frozen at **2026-11-15 07:38:45 UTC**, before opening the images or running inference. Seed: `geomodel3d-core-v026-20261115`.

1. Use the pinned archive's 3,000 `test/` paths in each of the four classes. Sort each class by hexadecimal SHA256 of UTF-8 `(seed + NUL + original archive path)`.
2. Exclude the eight exact prior-pilot paths and their inferred parent-tray strings. The string before `_row_` is a grouping proxy, not a verified tray identity.
3. Select round-robin in the order garbage, limestone, sandstone, shale for ten rounds. For each class, accept its first ranked candidate with a not-yet-used inferred parent and fewer than three already selected cases sharing its inferred hole prefix (the filename string before its first underscore).
4. Retain every selected case. Assign public IDs after selection by class: `case-01`–`case-10` garbage, `case-11`–`case-20` limestone, `case-21`–`case-30` sandstone and `case-31`–`case-40` shale. This reordering changes no source identity. Original round-robin order is recorded as `selectionOrder`.

The frozen [selection-order record](selection-order.json) has SHA256 `c6cf4749d6e54d278408984b16b43f82f004dd1a964c892bda3bb36e446b3a9c`. It describes 19 distinct inferred filename prefixes, at most three cases per prefix, and 40 distinct inferred parent strings. The live pinned ZIP inventory was subsequently checked against the cached original inventory before downloading any image.

The [full source manifest](dataset-manifest.json), SHA256 `301b53789551d3423730f56572762ab99cee8f59b1d1e7b3dfa30c6cf80141d2`, records exact archive paths, source classes, sampling ranks/order, inferred groups, byte counts, ZIP CRCs, dimensions, SHA256s and licence. The 40 unchanged JPEGs total **455,925 bytes**: 33 are 300 × 300, five are 280 × 280 and two are 301 × 301 pixels. Originals remain in the ignored `.cache/v026-core-benchmark/images/` directory.

## Borehole identity remains unverified

The publication confirms that its source collection spans 28 boreholes. The retrieved dataset material and targeted public search did not establish an authoritative **case-level filename → official borehole ID** mapping. The inventory contains 28 prefix strings, but that numerical agreement is not proof of identity. No official hole identity is marked verified in the manifest, and all `holeLikeTokenVerified` and `parentLikeTokenVerified` fields are false.

The expanded set therefore does **not** meet a gate requiring five independently identified held-out boreholes. Source lithology labels also do not substitute for an independent geologist's visual observations. Both tasks remain explicit review/data-collection requirements. Finding an official borehole with a matching name alone would not establish the selected image's identity or independence.

## Frozen browser inputs

The public assets are in [`public/core-benchmark-v026/`](../../../public/core-benchmark-v026/), with a neutral `manifest.json` containing only case ID, image path, source/input SHA256 and 512 × 512 dimensions. Published class labels and original filenames are not in that manifest and must not be passed to the model.

`inputs.json` preserves source linkage, original dimensions, exact crop plan, Chromium version and helper hash. Chromium **156.0.8078.79** Canvas2D uses `src/coreAiCrop.ts` to fit each whole square patch to 512 × 512 with low-quality image smoothing, matching the app. Enlargement interpolates existing pixels and adds no observed detail. The PNGs contain no embedded source labels or filenames. Together they occupy **13,171,315 bytes**.

Public manifest SHA256: `b61549c3de8714e2f015056276efc23dfb3c6f3e1206fbd6611b68af3712c391`.

Preprocessing manifest SHA256: `999992ee2d41ecd062133095c0f69562a263f597a722780ac029d6b446283ccd`.

## Reproduce and verify

From the repository root:

```sh
python3 scripts/fetch-core-benchmark-expanded.py
python3 scripts/fetch-core-benchmark-expanded.py --verify-only
node scripts/prepare-core-benchmark-expanded.mjs
```

The downloader requires Python's standard library and reuses the original pilot's strict range reader. It verifies the frozen source manifest, archive version/size/file count, 3,000 candidates per class, deterministic selection, entry CRC, image length and SHA256. An ignored range or changed input fails; there is no full-archive fallback or automatic replacement. Initial retrieval used **13,168,284 bytes across 124 exact range requests**, including ZIP metadata, rather than downloading 1.2 GB. `--cache-dir PATH` selects a separate source cache.

The Node verifier uses existing project dependencies and a local Chromium. It reconstructs every PNG in memory and compares bytes, dimensions, crop geometry and manifest/helper/browser versions. It has no write or refresh mode. Use `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to select the recorded browser; otherwise it uses system Chromium when present or Playwright's installed browser. A changed image pipeline needs a separately versioned study, not an overwrite of these inputs.

## Limits

- Forty patches expand coverage, but are not independent observations merely because their filenames differ. Hole/site independence and model pretraining overlap remain unknown.
- The collection covers three published lithology classes and heterogeneous non-core controls; it does not establish representative camera, lighting, wet/dry, weathering or geological diversity.
- `garbage` labels can include mixed tray and partial rock content. They do not mean every pixel is non-rock.
- The approximately 2 × 2 cm source patches have no matched complete rows/trays here. They cannot measure improvement from whole-row to close-piece crops.
- Published lithology classes do not establish strength, soundness, natural/mechanical fracture origin, RQD, recovery, physical scale of new observations or a 3D ground model.
- The paper's own CNN accuracy is not a GeoModel3D or Qwen result. Model quality, software-WebGPU execution and native-device performance are separate evaluations.
