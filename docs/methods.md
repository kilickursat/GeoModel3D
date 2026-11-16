# Methods

How a model is built from the logs, how it is placed on the map, how it is drawn, and how the code is organised.

## How a model is built

Boreholes → contacts → TIN horizons → closed unit volumes → sections

1. **Units from descriptions.** Where logs give soil or rock descriptions (borehole XML, BRO, descriptions only), the project's unit rules assign each interval a unit. A unit is given by the first rule whose pattern matches the description, and whose N-value and elevation ranges contain the interval's median SPT N-value and top elevation. Descriptions that no rule matches become units of their own and are reported.
2. **Stratigraphic column.** Units are ordered youngest (top) to oldest (bottom). A project can declare the order. Otherwise it is inferred from the logs: if unit A lies directly above unit B in any hole, A comes first. Logs that disagree are reported.
3. **Reading a log.** Each borehole gives the elevation of every contact it shows:
   - **Missing units:** a unit missing between two logged units has zero thickness at that hole, so it thins to zero towards it from the holes that logged it: it pinches out at the borehole that lacks it. (Pinching out between boreholes instead was tried and not adopted: it moved the base of the units further from the logs on the test sites.)
   - **Out of order:** a unit logged below a younger one is modelled as the younger unit and reported.
   - **Gaps:** a contact inside an unlogged gap is placed at the middle of the gap and reported.
   - **Logs starting below the collar:** for a log that begins some metres down, the contacts above its first unit are interpolated from the holes that logged them, never below where the log begins.
4. **Erosion.** If the unit directly above a contact is marked erosive, the units missing below it were eroded, not thinned. Their original surfaces at that hole are estimated from the holes that logged them, never below the erosion surface, and then cut by it.
5. **End of hole.** The base of the last unit a hole enters is not observed. Below it, horizons are inferred by stacking unit thicknesses, interpolated by inverse-distance weighting from holes that logged those units completely. The base of that last unit is kept below the end of the hole.
6. **Model base.** The lowest unit closes at a flat base at the deepest end of hole, or at the project's `base` elevation if one is given.
7. **Horizons.** All horizons share one Delaunay triangulation of the borehole collars, and the model covers the convex hull of the boreholes. Between holes, horizons are linear.
   - **Extent:** with a model extent (`margin`), a frame of nodes is added around the boreholes at that distance, and every horizon there is interpolated from the boreholes with the same inverse-distance weights, so the units keep their order and nothing on the frame counts as logged. One or two boreholes, or boreholes in a line, which enclose no area, get an extent of their own: the deepest log, a quarter of their spread, and at least 10 m.
   - **Refinement:** with terrain or erosive units, the triangulation is refined by longest-edge bisection until no edge is longer than the terrain cell, or a fraction of the site, within about 80,000 triangles. The ground then follows the terrain, and erosion surfaces cut sharply everywhere, also between distant boreholes.
   - **Pinch-outs and outcrops:** where a horizon meets the one above it or the model base, that line is added to the triangulation, so pinch-outs and outcrops run straight across triangles instead of stepping along their edges.
8. **Terrain.** The ground follows the terrain grid.
   - **Collars:** the grid is corrected by the difference between each surveyed collar and the grid, interpolated between boreholes, so collars keep their surveyed elevations. A consistent offset (another height datum) is reported once; other collars more than 1 m off are listed. When more than ten are, as with a coarse terrain grid or collar heights read off a map, one line gives their typical scatter (a robust standard deviation), and only the collars more than three times that far off are listed.
   - **Ground above the collars:** where the ground lies above the surface through the collars, the extra height is made of what the top 5 m of the surrounding boreholes is made of.
   - **Ground below the collars:** where it lies below, every horizon is kept at or below the ground.
9. **Volumes.** Each unit is a closed, outward-facing shell between its top and base horizons. Its volume is exact for this piecewise-linear model: triangle area × mean vertex thickness.
10. **Sections.** A vertical plane cuts every horizon and the water table along the same triangulation edges, so the unit polygons line up. Boreholes within a buffer are projected onto the section. A horizon segment is dashed unless it was logged at the boreholes around it.

## Coordinate systems, terrain and maps

- **Coordinate system.** Type an EPSG code, a system or a country into the **Coordinates** field, or paste a PROJ definition. The registry (`src/data/crs.json`, built by `scripts/make-crs-registry.mjs`) holds 477 projected systems in metres from the EPSG dataset:
  - the national systems of about forty countries, among them all nineteen Japanese plane rectangular zones (JGD2011, JGD2000 and the Tokyo datum);
  - the British, Irish, Dutch, Belgian, French, Swiss, Austrian, Italian, Polish and Nordic grids;
  - ETRS89 and NAD83 UTM zones, US State Plane zones in metres, MGA, NZTM, SVY21, HK1980, and the Korean, Taiwanese and Chinese CGCS2000 zones;
  - every WGS 84 UTM zone.
- **Suggested systems.** Positions given as latitude and longitude are placed in the system in current use where the site lies: the national system, else the UTM zone. Boreholes keep their latitude and longitude, so choosing another system places them again. For data given only in projected coordinates, choosing a system declares what they are.
- **Accuracy.** Conversions use PROJ definitions (proj4js). They are tested against published positions:
  - the GSI survey calculator, to the millimetre in the Japanese zones;
  - the BRO's RDNAPTRANS2018 positions in the Netherlands, within a decimetre;
  - DOV's Lambert 2008 coordinates in Belgium, within a decimetre.

  Older datums whose official transformations use grid files (OSTN15, BETA2007, TKY2JGD, RDNAPTRANS and others) are shifted with the EPSG Helmert parameters instead, to the accuracy (1–9 m) noted with each system. This affects placing latitude and longitude, and the map, not coordinates already in the system. Systems in feet are not offered.
- **Heights.** Elevations are taken as given, in the datum of the data (T.P., NAP, TAW, ODN…). A terrain grid in another datum is shifted to the collars, and the offset is reported.
- **Terrain.** **Fetch terrain** builds a terrain grid over the model and a margin around it, resampled into the project's system: the GSI 5 m (laser survey) and 10 m DEMs in Japan, and Terrain Tiles worldwide (about 30 m, finer where national surveys are included). Where a finer source has gaps, the next one fills them.
- **Map.** **Map** drapes OpenStreetMap, or in Japan GSI's pale map or aerial photographs, over the terrain around the model. It is translucent and drawn before the model, so it never hides it. Without a terrain grid, the map lies on a plane at the collars' median elevation.
- **Privacy.** Fetching terrain and showing the map send tile requests for the site's area to those servers. Imported or typed-in data may be confidential, so nothing is requested for them until you click **Fetch terrain** or tick **Map**. The bundled public sites fetch their terrain and map when opened.
- **Credits.** Every source on screen is credited at the bottom of the view; see [the sites and data sources](sites.md#data-sources).

## Rendering

The viewer uses three.js's `WebGPURenderer` with TSL node materials, so one shader description serves both the WebGPU and the WebGL 2 backends.

- **WebGPU is the default backend** wherever the browser offers it; elsewhere the viewer runs on WebGL 2. Add `?backend=webgl` to the address, or use the link in the help menu (**?**), to force WebGL 2; the help menu shows which backend is running.
- **The cut-away is a shader mask**, so it behaves identically on both backends.
- **Frames are drawn only when something changes**, so an idle model costs nothing. This matters on machines without a graphics card.
- **Flat colours**, in the **View** menu, shows units unlit in their legend colours, for reading colours rather than shapes.
- **The model opens whole and solid.** **Cut**, on the section bar, removes the part in front of the section, so the section face looks at you when you cut. Turning the model does not change the half that is kept; **Flip** keeps the other one. **See-through**, in the **View** menu, makes the units translucent, to see the boreholes and CPTs inside.
- **Terrain around the model** is clipped exactly at the model's footprint, limited to a margin of a quarter of the model's size, drawn translucent and before the model, so it never veils it.

## Calibrated contact envelopes

Split conformal prediction is separate from the full-data selected-interpretation range. A seeded shuffle assigns physical reference-observation groups to training, calibration and audit sets. Matching IDs and rounded 1 mm positions link borehole/CPT records across all selected cases, including moved collars. Every calibration and audit group is removed from every training case. The fitted models and fixed assumptions are unchanged when their calibration or audit observations are evaluated.

At a calibration location, let `L` and `U` be the minimum and maximum predicted contact elevations across the training-only cases, and `y` the directly logged contact. The nonnegative score is `max(L − y, y − U, 0)`. For `n` calibration groups and requested coverage `c`, the expansion is the `ceil((n + 1) × c)`-th smallest score. Missing predictions contribute unbounded scores. An out-of-range rank or an unbounded selected score gives no finite interval; the calculation never clamps the rank or substitutes a zero. For example, 90% coverage needs at least nine finite scores, and nine scores use their maximum.

The resulting interval `[L − q, U + q]` applies only to the same training-only predictor. Adding the calibration observations back into its fit would invalidate this calculation. Audit groups are excluded from both fitting and quantile selection. Their observed coverage is reported separately, including unavailable predictions and checks outside the training observation hulls. CSV/JSON retain split assignments, seed, removed records, scores and denominators. A single CSV metadata record carries the global partition and notes; sample rows repeat only their compact numeric context.

The split-conformal coverage statement is marginal over a new exchangeable observation group, conditional on the fixed model assumptions and eligible observed-contact population. It is not coverage at every location or simultaneously across the map. Geological observations can be spatially dependent and preferentially sampled; interpretations, unit rules and terrain can already encode information from the site. Changing the split or assumptions after viewing audit results also compromises an untouched audit. The displayed target is therefore not an unconditional reliability guarantee for the site.

Method: Angelopoulos and Bates, [A Gentle Introduction to Conformal Prediction and Distribution-Free Uncertainty Quantification](https://arxiv.org/abs/2107.07511).

## Investigation information and cost

The information mode treats the selected saved cases as a finite hypothesis set. It assumes that a successful future observation reports the contact-elevation bin `floor((elevation − origin) / resolution)` predicted by the true selected case. Prior case weights, bin resolution and elevation origin are explicit inputs. This is a noiseless, coarsened observation model: measurement error, model discrepancy and geological alternatives outside the selected cases are not estimated.

For selected proposed observations `S`, candidates are ranked by `I(C; B_x | B_S) / estimated cost`, where `C` is the case identity and `B` is the predicted bin. The calculation groups cases by their joint bin signatures and evaluates the weighted conditional entropy exactly. It averages over possible outcomes; it never assumes a particular favorable observation occurred. A redundant signature adds zero information, and cumulative information cannot exceed prior case entropy. Bins are sensitive to their origin: arbitrarily close predictions on opposite bin boundaries can be counted as distinguishable. Review that assumption and vary resolution/origin before using the result.

Costs combine the stated fixed charge and drilling rate with a depth estimate that reaches the contact under every selected case, plus the chosen buffer and any deeper design target. Unknown contact/ground predictions cannot create a finite depth or cost. The greedy plan respects the monetary budget, maximum location count and physical spacing, and stops when no affordable informative candidate remains. It does not claim a globally optimal programme or a calibrated reduction in geological uncertainty. Access, utilities, recovery, test type and actual drilling rates remain field-planning inputs.

Information utility follows the Bayesian experimental-design principle in Lindley (1956), [On a Measure of the Information Provided by an Experiment](https://doi.org/10.1214/aoms/1177728069). The implemented finite-case observation model and greedy budget rule are stated above rather than inferred from that reference.

## Architecture

### Reviewed core photographs

`src/corePhoto.ts` maps registered image rectangles to continuous recovered depth segments. Rows are straight and depth increases along their horizontal centerline in the selected direction. This linear mapping assumes a checked scale and negligible perspective distortion; a photograph alone cannot establish recovery positions or distinguish a natural break from drilling/handling damage. Unregistered spans remain absent from the accepted observations.

Core recovery is `100 × registered recovered length / drilled run length`. RQD is `100 × total qualifying sound length / drilled run length`, with a qualifying length of at least 0.100 m after explicitly reviewed mechanical joins. Unknown soundness, unknown breaks, invalid joins, overlapping depths or incomplete registration/recovery review prevent a reviewed result. Unsound material interrupts joined sound lengths; sound fragments are never joined through it. A continuous logging boundary can divide lithology within intact core without introducing a fracture or reducing the joined length. The metric threshold and centerline convention follow the [USBR Engineering Geology Field Manual, volume I, chapter 5](https://www.usbr.gov/tsc/techreferences/mands/geologyfieldmanual-vol1/chap05.pdf).

Acceptance creates immutable source-evidence records for the interpretation; later acceptance creates new records. The project keeps the current annotation draft separately from those snapshots. These records describe a manual photo assessment and never become laboratory/in-situ test values automatically. JSON and workspace import validate bounded annotations and references; the existing evidence image pool deduplicates photographs across revisions.

The existing geological kernel still infers ordered contacts through gaps and between holes, with vertical boreholes. Missing core is not an empty 3-D volume. This workflow supplies observations and review provenance; it does not reconstruct a surveyed 3-D core, estimate fracture orientation, or infer engineering strength from RGB pixels.

### Local core-image VLM experiment

A registered row or one of its existing pieces is cropped and resized locally before inference. `selectCoreAiRegion` in `src/coreAiCrop.ts` validates the selection and maps piece depths through `corePieceBox`. Right-to-left registration reverses image positions while retaining the piece's recorded start/end depths. The selected region, source image and registration are copied when the dialog opens; running models cannot retarget an existing result to another interval or change annotations.

`coreAiCropPlan` rounds the selected image rectangle outward to covering integer source pixels, clamped to the photograph. It scales that crop's long edge to 512 pixels, preserves its aspect ratio within pixel rounding, and centers it on a 512 × 512 neutral-gray frame. Small crops are interpolated upward, rather than left as small patches inside a mostly empty frame. The exact padded input is previewed and hashed. Original crop dimensions, scale, resized dimensions and padding are retained; gray padding is not an observation and enlargement adds no observed detail. The helper is independent of the browser so a benchmark can reproduce the crop geometry. These changes establish which pixels are presented, not an improvement in geological accuracy.

A fixed task prompt asks for visible observations and uncertainty; no accepted geological labels or engineering test values are supplied to the model. [SmolVLM 256M](https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct) and [500M](https://huggingface.co/HuggingFaceTB/SmolVLM-500M-Instruct) are general image-to-text models from Hugging Face, not core-specific classifiers. Results are temporary advisory text, with no route into the calculation kernel or acceptance records.

The browser worker uses Transformers.js 4.3.2 and the app's ONNX Runtime Web 1.31.1. The runtime dependency and version override were selected with the maintainer for local Hugging Face inference; a dedicated worker isolates its configuration from document OCR. Model repositories are pinned to immutable revisions. Downloading starts only on an explicit run; model sessions run sequentially and cancellation terminates the worker. Runtime assets are served with the app, model files come from Hugging Face, and source pixels remain local. The standalone HTML disables AI because these worker/runtime assets are not embedded.

Benchmark report format version 2 adds an explicit `selectedRegion` with its kind (`row` or `piece`), identifiers, depth limits, direction and normalized image box. `interval.from` and `interval.to` describe the analyzed selection; `interval.rowFrom` and `interval.rowTo` preserve the enclosing row's original registration, with `pieceId` present for a piece selection. `crop.normalizedBox` identifies the selected region, while `crop.pixels` identifies the covering source pixels. Preprocessing metadata records scale, whether the crop was enlarged, resized dimensions and padding. Version 1 reports described whole rows and had no separate piece-selection context.

Reports also identify model revisions and the fixed prompt, separate loading from generation time, and retain human usefulness/hallucination assessments without embedding photographs. They are individual browser observations, not a calibrated accuracy score or a measurement of total GPU memory. Geological model selection requires expert-reviewed real photographs held out by entire borehole/site, with lighting, camera, lithology and preparation variation. Demonstrating a benefit from closer piece crops additionally requires a controlled comparison against the corresponding full rows. Synthetic UI fixtures establish software behaviour only. Real iPhone Safari benchmarking remains a separate device check.

### Modules

- `src/coreBenchmark.ts`, `src/coreBenchmarkClient.ts`, `src/coreBenchmark.worker.ts`, `src/coreBenchmarkView.ts`: separate hosted Qwen device study, immutable image/model binding, bounded sequential runs, interruption/recovery and local evidence export. No project or acceptance API is imported. The [forty-case protocol](benchmarks/0.26.0-core-ai/README.md) separates compatibility, quality-mode execution and human grading; GPU memory and unverified physical-device claims remain unknown.
The modelling kernel has no rendering dependencies. It is tested in Node, and the viewer is a thin layer on top.

- `src/schema.ts`: the project schema (units, boreholes, logs, tests), with no data
- `src/geology.ts`: the reference datasets
- `src/tin.ts`: Delaunay triangulation (Bowyer–Watson with a ghost vertex, so the convex hull is always covered)
- `src/terrain.ts`: terrain grids (reading, interpolation and coarsening)
- `src/model.ts`: log interpretation, erosion, terrain, water table and horizon assembly
- `src/fields.ts`: stresses, earth pressures, measured properties on sections, and their colour scales
- `src/validation.ts`: leave-one-out cross-validation
- `src/ar.ts`: models for augmented reality (USDZ and GLB)
- `src/alignment.ts`: sections along an alignment, chainage, cross-sections square to the line, lines crossing straight sections, and the table by chainage
- `src/corridor.ts`: bounded station sampling, design-level readouts and corridor screening flags
- `src/corridorView.ts`, `src/corridorJob.ts`, `src/model.worker.ts`: corridor dashboard and cancelable offline calculation worker
- `src/investigation.ts`: candidate selection, spacing/depth constraints and monetary investigation budgets
- `src/information.ts`: exact weighted conditional entropy of finite-case contact-observation bins
- `src/investigationView.ts`, `src/investigationJob.ts`, `src/model.worker.ts`: pinned investigation-plan review and export, with a cancelable offline worker
- `src/landxml.ts`: LandXML and J-LandXML alignments (straights, arcs, clothoids, design profiles)
- `src/cpt.ts`: cone penetration tests: GEF, BRO and DOV readers, the friction ratio, readings at a depth and averages over depth
- `src/sbt.ts`: the soil behaviour type of CPTs (Robertson 2009) and the layers it gives
- `src/cptSvg.ts`: a CPT's log, for the read-out and the report
- `src/layout.ts`: the layout for phones and tablets (where the view is drawn, how the model is framed, how near a tap is to a borehole)
- `src/properties.ts`: the property catalogue and per-unit statistics
- `src/volume.ts`: closed unit-volume meshes
- `src/section.ts`: vertical sections
- `src/sectionSvg.ts`: 2-D section drawing and CSV export
- `src/report.ts`: the printable report
- `src/io.ts`: CSV, AGS4, borehole XML, CPT and JSON import and export
- `src/boringXml.ts`, `src/broXml.ts`, `src/dovXml.ts`, `src/xml.ts`: Japanese, Dutch and Flemish borehole XML, and a small XML reader
- `src/rules.ts`: units from logged descriptions
- `src/tables.ts`, `src/input.ts`: the Input data tab (tables, live preview, checks)
- `src/crs.ts`: coordinate systems (registry, suggestion and conversion)
- `src/tiles.ts`: map and elevation tiles, and terrain resampling
- `src/evidence.ts`: source records, correction/acceptance events and import validation
- `src/coreAi.ts`, `src/coreAiClient.ts`, `src/coreAi.worker.ts`, `src/coreAiView.ts`: local VLM experiment, cancellation, comparison and advisory report export
- `src/coreAiCrop.ts`: validated row/piece selection, direction-aware source-pixel bounds and reproducible aspect-preserving crop plans
- `src/corePhoto.ts`, `src/corePhotoView.ts`, `src/corePhotoTables.ts`: depth registration, reviewed RQD, photo-to-log acceptance, the local photo workspace and interval updates that preserve unfinished table rows
- `src/evidenceView.ts`: source-page inspector, independent of the PDF reader
- `src/groundwater.ts`: shared observation selection and groundwater policies
- `src/comparison.ts`: comparisons at fixed coordinates, matched by unit identity
- `src/comparisonJob.ts`, `src/model.worker.ts`: cancellable inline comparison worker
- `src/comparisonView.ts`: pinned-revision comparison controls and overlays
- `src/disagreement.ts`: complete selected-interpretation contact envelopes on fixed map/path samples
- `src/disagreementValidation.ts`: observed-contact validation with identity/location holdouts across every interpretation
- `src/calibration.ts`: training/calibration/audit group splits and conformal contact-envelope correction
- `src/disagreementView.ts`, `src/disagreementJob.ts`, `src/model.worker.ts`: pinned maps, section ranges, empirical checks and cancelable offline analysis
- `src/impact.ts`: changed-input inventories and prior-model checks against newly added borehole logs
- `src/impactJob.ts`, `src/model.worker.ts` (one shared inline worker for all numerical jobs), `src/modelJob.ts`: cancelable local numerical jobs, with source-page images excluded
- `src/impactView.ts`: new-data impact map, ranked boreholes, contact details and export
- `src/workspace.ts`: versioned drafts, immutable project revisions, restore and workspace JSON
- `src/storage.ts`: transactional browser saves and migration of earlier input-table saves
- `src/main.ts`: three.js viewer and interface
- `scripts/`: the generators of the synthetic datasets, of the real sites (Sakae, Antwerp, Maasvlakte, Creswick) and of the coordinate system registry and DOV code list, the cross-validation of the real sites, their models for augmented reality, and the offline single-file build
- `scripts/release-assets.mjs`, `.github/workflows/release.yml`: tag/version validation and immutable release-asset upload

## Development

```sh
npm ci
npm test         # unit tests (vitest)
npm run build    # type-check, then build dist/ and dist/geomodel3d-offline.html
npx playwright install chromium  # once, for UI checks
npm run test:ui  # desktop, mobile and standalone bundle checks (after build)
```

`npm run dev` starts Vite's development server. Where a local server cannot be used, build and open `dist/geomodel3d-offline.html` instead. [CONTRIBUTING.md](../CONTRIBUTING.md) explains how to submit a change.

## Deployment

Every push to `main` runs the tests, builds the site and publishes `dist/` to GitHub Pages (`.github/workflows/build.yml`). The output is static: `dist/` can be served from any static host, and `dist/geomodel3d-offline.html` needs no host at all.

## Planned

1. **Appearance**, data-bearing only:
   - standard lithology symbols in 3-D and in the SVG section;
   - terrain contours and hillshade;
   - fading where the model is inferred rather than logged.
2. **More physics:**
   - settlement and bearing estimates from the unit parameters;
   - earth pressures with surcharges, an excavation level and wall friction, and on sections;
   - property models in 3-D, not only on sections.
3. **More data:** ground parameters from CPTs (undrained shear strength, friction angle, relative density, stiffness; the correlations to be chosen); a reference site in the Americas once clearly licensed public data are found.
4. Faults; constrained TIN boundaries, pinch-out lines and geological map contacts.
5. Tunnel and road cross-section shapes, from given dimensions, on the sections; LandXML cross-sections and surfaces.
6. GeoJSON, DXF and LAS import; GeoTIFF terrain.
7. Streaming and level of detail for large models.
