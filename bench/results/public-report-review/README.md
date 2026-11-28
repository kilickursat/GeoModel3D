# Public report browser checks, 28 November 2026

These checks follow selected public PDFs from import and source review through the input tables and, where the logs support it, a Three.js model. Depths and elevations below are in metres. They are development cases. A correct transcription can still yield a poor prediction between boreholes.

## Four previously unbenchmarked Tochigi logs

Source and credit: Tochigi Prefecture, Department of Land Development (栃木県 県土整備部), ボーリング柱状図, archive 1. The four unmodified PDF members are 11801031401.pdf through 11801031404.pdf. The publisher's BODIK metadata identifies the licence as CC BY 2.1 JP. [Dataset](https://data.bodik.jp/dataset/090000_boring-log) · [Licence metadata](https://data.bodik.jp/api/3/action/package_show?id=090000_boring-log) · [Licence](https://creativecommons.org/licenses/by/2.1/jp/)

All four one-page PDFs were selected together in the production app's PDF importer. The review showed no flagged fields. The following values were compared with the printed header and base-depth columns. This comparison covers all four IDs, coordinate pairs, collar elevations, final depths and all 16 interval bases. It does not establish a reference lithostratigraphic correlation.

| PDF suffix | Log | Latitude / longitude on page | Collar | Final | Printed and imported interval bases |
|---|---|---|---:|---:|---|
| 01 | B-2 | 36°36′59″ N, 139°48′03″ E | 200.64 | 9.07 | 1.95, 5.95, 9.07 |
| 02 | B-3 | 36°37′01″ N, 139°48′30″ E | 201.88 | 11.07 | 3.95, 7.25, 11.07 |
| 03 | B-4 | 36°36′59″ N, 139°48′30″ E | 200.11 | 11.11 | 0.50, 1.50, 7.40, 11.11 |
| 04 | B-1 | 36°36′58″ N, 139°48′30″ E | 200.82 | 11.12 | 1.50, 3.95, 5.80, 8.50, 9.30, 11.12 |

Using the reviewed values without editing produced four boreholes, five grouped units, six horizons and a 3.10 ha footprint. Initially the editor converted the collars into EPSG:6677 and then discarded that identifier because the project's CRS text field was blank. With the fix the viewer displays EPSG:6677, the map remains off and the import, build and cross-validation generate zero external requests. The browser test used Chromium's WebGL 2 fallback with external requests intercepted.

Leaving each collar out puts only B-4 inside the other collars. At B-4, the model predicted the top of rock and cemented soil 2.2 m above the logged contact and matched the logged unit over 60.6% of logged depth. The other three checks extrapolate beyond the remaining collars. Fill and volcanic ash appear in only one hole each. These numbers describe this site and grouping only. [Chromium model and holdout results](tochigi-118010314.png)

The GitHub Pages deployment of merge commit `edf820c` was checked with the same four originals at 03:36 UTC on 28 November. Its entry asset was `index-C6k3L7gT.js`. WebGL 2 drew the collars and layers. All 16 interval bases, the coordinate system and the B-4 holdout results were reproduced. Chromium intercepted 94 basemap tile requests from the startup sample. After report import began there were zero external request attempts through validation. [Deployment](https://github.com/kilickursat/GeoModel3D/actions/runs/46103146065)

## Hirosaki scanned log

Hirosaki City (弘前市), オープンデータひろさき 地質・測量, Ringo No. 1, page 1. The publisher grants CC BY 4.0. [Dataset and terms](https://www.city.hirosaki.aomori.jp/gaiyou/opendata/od-chisitsu-sokuryo.html) · [Source PDF](https://www.city.hirosaki.aomori.jp/gaiyou/opendata/files/20170308_hirosaki_ringo_boringutyuujouzu1.pdf) · [Licence](https://creativecommons.org/licenses/by/4.0/)

On the printed log, water was 0.20 m. The neighbouring SPT column contains 1.15 m. With the same locally recognized text, the old reader returned 1.15 m and the revised reader leaves groundwater empty. OCR recognized the groundwater heading but missed the measurement and date. Confidence on the adjacent SPT number could not resolve its column. The engineer still needs to transcribe the water observation from the page.

With fresh local WASM OCR on all eight Ringo pages, the benchmark reconstructed four boreholes. The earlier reader assigned 1.15 m to all four. The updated reader left all four values empty. The draft reference depths are 0.20, 1.80, 1.25 and 2.30 m. Depth-weighted material agreement was 34.22% on this scan set. It remains a poor candidate for unattended import.

## Eight-hole Tochigi project 120080167

Source and credit are the same Tochigi Prefecture dataset and CC BY 2.1 JP terms linked above. The repository's manifest names each original PDF member. [Manifest](../../manifest/sources.json)

All eight logs were imported together in Chromium. The eight IDs, collar coordinate pairs, ground elevations, final depths, 36 interval boundaries and 76 SPT depth/blows/penetration triples matched the draft reference. The pages contain eleven groundwater observations. The review retained eight, one per hole.

On thin layers the material labels could shift into the next interval even though the numeric boundary depths were correct. The reader fitted depth to the centres of the printed scale labels, which sat below the drawn tick positions. The fix uses a vertical correction only when at least three distinct printed boundary depths and their ruled edges support it. It keeps named soil and remarks separate. On BV-3 this restored fill at 0–0.70 m, topsoil at 0.70–1.20 m, cemented clay at 1.20–2.90 m and clay-mixed gravel at 2.90–10.33 m.

Under the broad engineering grouping used for this browser review, acceptable automatic unit proposals increased from 21/36 to 30/36. Two proposals were still wrong and four required entry. Separately, the benchmark's depth-weighted material score against the draft key rose from 46.61% to 74.73%. The scoring methods answer different questions.

For the model run the reviewer distinguished cemented clay from the other units. A six-unit, seven-horizon model drew in Three.js with a 1.15 ha footprint. At the two interior holdouts, 36.8% of logged metres matched the predicted unit and the mean absolute ground-elevation error was 5.0 m. The other six collars required extrapolation. Repeated units also meant the modeled sequence disagreed with some measured intervals even at a known collar. Model-input correctness alone cannot establish the correlation between logs.

## Flemish DOV reports

Source and credit: Databank Ondergrond Vlaanderen (DOV), Flemish Government, consulted 28 November 2026. The reports are available under the Flemish Model Licence for Free Reuse v1.0. [Licence](https://overheid.vlaanderen.be/sites/default/files/documenten/ict-egov/licenties/hergebruik/modellicentie_gratis_hergebruik_v1_0.html) · [1931 record](https://www.dov.vlaanderen.be/data/boring/1931-084105) · [1948 record](https://www.dov.vlaanderen.be/data/boring/1948-120680) · [2016 record](https://www.dov.vlaanderen.be/data/boring/2016-147736) · [GEO-69/355-A record](https://www.dov.vlaanderen.be/data/boring/1969-010172)

Three newly selected Antwerp reports originally all appeared as “Page 1”. That caused duplicate-ID errors. After recognizing the Dutch Proefnummer field, the three printed identifiers appeared automatically. In both runs all 37 interval endpoints and their descriptions, and each collar's X, Y, ground elevation and final depth matched the printed tables. The Dutch term “Aangevulde grond” and French “Terrain rapporté” now both map to made ground. The resulting model built without manual edits: three holes, five units, six horizons and a 14.30 ha footprint. Its single vertical order still assigned 66.39 m of out-of-order intervals in B100 to gravel, including a logged clay layer. Separate stratigraphic units and geological correlation are needed before using those solids for quantities.

On the separate two-page GEO-69/355-A report the corrected reader preserved all twelve intervals, a 24 m final depth, a 1.42 m collar elevation and a 1.30 m water depth. It skipped the interpretation appendix without starting OCR and requested material review for two “idem” rows that refer to preceding descriptions. The projected coordinates were retained on a local grid until a CRS is supplied.

Before the modeling fix, that single reviewed borehole generated an assumed 25 m lateral extension and zero peat volume despite peat logged at 1–3 m. Its clay/peat/sand sequence recurred in a different order further down. The browser and A4 report now show all twelve measured intervals with no modeled footprint or volume estimates in this case. Multi-hole models identify how many intervals were assigned a different unit by the correlation. The individual depths and substitutions are recorded in the model notes.

On the correlation-review branch, a fresh import of the three Antwerp PDFs reproduced 84.91 matching metres and 66.39 metres assigned to a different unit out of 151.30 logged metres. Assigning only B100's 84–92 m sand interval to a trial lower sand bed at the bottom of the order increased collar agreement to 92.91 m. The remaining 58.39 m in five intervals kept the quantities provisional. The trial tests the effect of one interpretation on known collars. Lateral extent needs separate geological evidence.

## Engineering validation priorities

| Decision | Evidence to require |
|---|---|
| Accept a measurement | Store the page, box, unit, datum, observation date and original text. Check water observations independently of SPT, especially when columns are adjacent. Keep unreadable values missing. Preserve the full time series where a log records multiple water levels. |
| Accept a correlation | Give each interpreted stratigraphic occurrence its own identifier. Keep the original material description and measurement alongside it. Let a reviewer correlate occurrences across holes, mark pinch-outs and leave relationships unknown. Repeated clay beds may need different identifiers. |
| Use a solid for quantities | Intersect the proposed model with every contributing collar. Report misplaced contacts in metres, substituted intervals and thickness, gaps, assumed footprint, and extrapolated quantities. Require an explicit engineering disposition of each material mismatch before approving volumes. |
| Claim predictive performance | Set tolerances for the intended design decision before testing. Freeze independently reviewed keys, keep sites or survey groups together, and withhold entire spatial groups. Report absolute contact errors, material agreement by logged thickness, unplaced holes, abstentions and false measurements separately by layout, language and scan quality. Separate interior prediction from extrapolation. |
| Release a new browser build | Replay the public cases through import, review, model, export and reopen. Verify known geometry in actual rendered pixels on physical WebGPU adapters and WebGL 2, and watch network traffic from private import onward. Record app, browser, driver and reference versions with the measurements. |

The checked examples include strong transcription results and metre-scale geometric errors on the same project. The repository’s benchmark reference labels remain drafts. Professional review of independent ground truth and intended-use tolerances is still required for an engineering validation claim.
