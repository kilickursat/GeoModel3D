# Six-borehole continuation and holdout trial

Tochigi Prefecture, Department of Land Development (栃木県 県土整備部), published the six original logs numbered `11901049601.pdf` through `11901049606.pdf` in archive 1 of ボーリング柱状図 under CC BY 2.1 JP. The tables in the reference file are our transcriptions of the originals. The archive SHA-256 is `83775cf99ae483bb4ed68d757f8e4630314d0994eb4ed66900abbd4082ac0ebe`. [Publisher and archives](https://data.bodik.jp/dataset/090000_boring-log) · [Licence metadata](https://data.bodik.jp/api/3/action/package_show?id=090000_boring-log) · [Licence terms](https://creativecommons.org/licenses/by/2.1/jp/)

## Reproducing the review

1. Set the intended use and acceptable errors before opening the results. For a spatial prediction, first set aside `11901049603.pdf`. Import only the other five PDFs into an empty project. These five logs supply the unit order. Save the model before opening the held-out log.
2. From the original logs, record each identifier, coordinate pair, collar elevation, drilled length and sequence of material interval base depths. Five files have a continuation page. Check a boundary against its soil-name column, printed thickness and base elevation. Preserve separate occurrences of the same material. For the held-out log, identify the shallowest interval explicitly labelled 砂礫 (GS) and record its top elevation.
3. Compare the five-hole model's ground and top of Gravel at the published held-out coordinates with those two source elevations. Record the sign as predicted minus observed. Check the horizontal and vertical references and the geological justification for treating the first GS beds as the same horizon. The coordinates have whole-second precision. This case supplies one interior prediction.
4. For a separate extraction test, open all six PDFs in the hosted document reader, select every page and inspect the review without editing. Compare the resulting 47 bases and the field source boxes with the originals. In a fresh import of `11901049606.pdf`, omit page 2 and check that review identifies the unlogged tail while keeping its deeper drilled length.

The original fields and target were frozen before the first app run. The reference SHA-256 is `59bf39543d9d67cd11015165f42d1730c9d48f2ddba45da08a73c716693108c8`. The full-document trial at revision `666a376` recovered all six header sets and 40 of 47 bases. The review reported no missing terminal intervals. Published short continuation strips contained legible native text, metric depths, thicknesses and base elevations, alongside an SPT scale. This survey became a development case when its failures were used to repair the reader. Independent engineering review is pending. The linked reference discloses the source values. [Open after blind review](reference.json)

## Browser replay after the repair

The reviewed six-hole project contained all 47 printed bases. The seven recovered endpoints retained boxes on the original second pages. The reviewed identifiers, coordinates, collar elevations and drilled lengths matched the frozen fields at printed precision. In the deliberately incomplete last PDF, the review preserved the drilled length of 18.20 m and flagged the unlogged interval below 12.40 m. No external requests occurred during the measured import and build. The built-in example attempted map tiles on startup.

The six-hole model reported 20 of the 47 source intervals as reassigned under its global stratigraphic order. They included recurring sand, gravel and clay intervals. An accurate list of borehole measurements still requires geological correlation before using this model for volumes or design.

The separate five-PDF project excluded the held-out log and its unit order. We transformed the held-out coordinates independently with GDAL and sampled both the model probe and the rendered mesh inside the training hull. Open the numerical result after recording your source interpretations and acceptance criteria. [Spatial comparison](holdout.json)

## Transfer to other Tochigi logs

A second comparison used 26 other original files from the same licensed archive. The ordered base depths, checked against printed thickness and elevation, matched the full extraction on 22 files. The other four still had extra or missing interpreted depths on their first sheet. The reader flags those intervals for source review. A three-page log retained its 20 printed bases and existing descriptions. These are development checks from one publisher. [Per-file source comparison](transfer-checks.json)

## Reviewed-bed backend replay

The five-PDF export contains 38 measured intervals over 87.54 m. Before a geotechnical reviewer assigns distinct beds, the five-hole interpretation still substitutes another material over 7.85 m in ten intervals. On the separate six-PDF export the corresponding results are 80.59 m in 20 of 47 intervals. The blank worksheet leaves these observations and the project unchanged. A decision with an intentionally incorrect PDF hash was rejected. Saving and reopening retained each interval, its evidence record and its source boxes. [Source-only five-hole worksheet](blind/training-bed-assignments.csv) · [Replay results](bed-review-replay.json)

The replay freezes a model from the five-PDF project at the published collar coordinates before reading the six-hole export. It scores the withheld log using that fixed training unit order. The grade at the collar is eligible for a ground-elevation comparison. Repeated Gravel intervals leave the bed identity ambiguous, so the new validation omits its top from contact-error statistics. The underlying provisional surface still produces the earlier numerical prediction. The reported material overlap agrees with an independent intersection of predicted elevation bands and measured intervals. These checks validate the handling of incomplete correlation decisions in this development survey. Human review of bed continuity and design tolerances remains pending.

To repeat from the repository root, save the separate five-PDF and six-PDF projects described above using the original source files, before completing any bed assignments. The following command reads the projects in that order. It prints counts and checks without printing the held-out geology or prediction values. Fresh browser exports may have different JSON hashes because evidence records get new IDs; the runner verifies each original PDF hash in both projects.

```sh
node_modules/.bin/esbuild bench/runner/tochigi-bed-review.ts --bundle --platform=node --format=esm --outfile=.cache/tochigi-bed-review.mjs
node .cache/tochigi-bed-review.mjs five-pdf-project.json six-pdf-project.json
```
