# Changelog

## 0.17.1 — 2026-10-30

### Fixed
- In a browser without WebGL 2 or WebGPU the page stayed blank. It now describes GeoModel3D and says what the 3-D view needs. The same description shows while the app loads, and without JavaScript.

### Changed
- For search engines:
  - a shorter title and description;
  - the app's name as the page's main heading, and a one-line description at the top of the help menu;
  - structured data that describe a free web app;
  - a sitemap with the app and the AR page. It no longer lists the offline file, a copy of the app. `robots.txt` is gone: search engines read it only at the root of a site, never in a project's folder on GitHub Pages.
- On phones, the browser's bar is white like the top bar instead of the old dark blue.

## 0.17.0 — 2026-10-21

Changes after feedback from users: the interface was hard to take in, the model jumped while it was turned, its sides did not match, and there was too much text.

### Fixed
- Turning the model no longer swaps the half shown. The model opened cut at the section, and the half kept was chosen from the camera on every frame. Turning past the section plane replaced one half with the other, so the model seemed to jump and its two sides to show different ground. The model now opens whole and solid. **Cut** on the section bar removes the part in front of the section, and the half it keeps stays as the model turns; **Flip** keeps the other half.
- In a solid model, boreholes and CPTs inside it are no longer picked through the units. A borehole shows its details at its collar.
- The 3-D view is drawn only in the part of the screen the panels leave, so no panel lies over it. Headless Chromium drew part of the canvas wrongly when large panels covered it.

### Changed
- A plainer interface:
  - a top bar with the tabs, **Import…**, **Export** and a help menu;
  - the site and its units in a panel on the left. The description is folded to three lines, and a site's notes are under **Notes** instead of in a box that opened with every site; the box still opens after an import, an error or an action;
  - what is drawn, the vertical exaggeration, the map and the terrain in one **View** menu over the model, with **See-through** for the translucent units;
  - the section's controls in a bar under the model, with the 2-D section under it. **Azimuth** and **Offset** are now **Direction** and **Position**;
  - light colours, the system's font and plain labels.
- Shorter texts: the site descriptions, the notes on CPT layers and unit rules, the Input data tab and the drop zone.
- The README is short. The guide, the methods, the data formats and the sites are in `docs/`.
- The demo GIF and the screenshots show the new interface.

### Removed
- The SVG and CSV buttons of the section bar; **Export** has them.

## 0.16.0 — 2026-10-16

### Added
- **Soil behaviour type of CPTs** (`src/sbt.ts`), by Robertson's normalised chart (Robertson 2009), reading by reading:
  - qt as the file gives it, else qc + u2 (1 − a) with the cone's net area ratio, else qc; the readers now take qt (GEF quantity 13, BRO `correctedConeResistance`, AGS4 `SCPT_QT`, CSV `qt`) and the net area ratio (GEF `MEASUREMENTVAR` 3, BRO `coneSurfaceQuotient`, DOV `net_area_ratio`, AGS4 `SCPG_CAR`);
  - the unit weight from the CPT (Robertson and Cabal 2010), σv0 from the start, u0 below the project's water table;
  - Ic iterated with n = 0.381 Ic + 0.05 σ′v0/pa − 0.15 (at most 1) and (pa/σ′v0)ⁿ at most 1.7, to 10⁻⁶; zones 2 to 7 by Ic.
  
  On three BRO CPTs it agrees with groundhog, an independent implementation, to 1.2 × 10⁻⁷ in Ic at all 5,562 readings, with no reading in another zone; the tests hold it to groundhog's results.
- **CPT layers:** runs of readings in one zone, joined where thinner than 0.5 m, become each CPT's layers, which take units by the unit rules (taken metre by metre on elevation). **Build the model with the CPT layers** in the Site panel adds them to the logs of the model; they show in the colours of their units in 3-D and on sections, and **Check the model** leaves them out in turn.
- **Unit rules for the CPT layers,** for projects whose units are given in their logs.
- **Sites with CPTs only:** CPT files far from the site shown make a project of their own, built from their layers, with units grouped by principal soil and a soil found above and below other units split into an upper and a lower unit.
- **Read-outs and report:** the soil behaviour type and Ic at a depth, and the unit of the layer there; a soil behaviour type column in the CPT logs, with a key in the report.
- **Field:** the soil behaviour type index Ic on sections.
- **Maasvlakte** is built with the layers of its 26 CPTs, interpreted by the same sequence as its boreholes. Cross-validation: the boreholes are predicted at 90.2 % of their logged metres, against 87.5 % without the CPT layers.
- `CITATION.cff` and a Citing section in the README.
- A demo GIF at the top of the README: Maasvlakte orbited, the section swept through it, then coloured by Ic.

### Changed
- Cross-validation, its markers, its CSV (with a kind column) and its report page cover the CPT layers the model is built with.
- The project file keeps qt, the net area ratio, the CPT layers, `cptLayers` and `cptRules`; the Input data tab keeps them too.

### Fixed
- The section bar no longer runs its items into each other on screens 901 to 1380 px wide (the vertical exaggeration ran into **Colour**), along a line too.
- The 3-D read-out no longer follows the mouse while a button is held to orbit or pan.

## 0.15.0 — 2026-10-15

### Added
- **Cone penetration tests (CPT).** CPTs are read with the boreholes, or added to the site shown, from:
  - **GEF** files (GEF-CPT-Report): the columns by their quantity number, with the depth corrected for inclination where given, missing values, separators and units; the position in RD New (`#XYID` 31000) or an EPSG code, and the start level (`#ZID`, NAP).
  - **BRO** CPT XML (IMBRO and IMBRO/A), in the order of the parameters the file lists, placed in RD New or by the standardized ETRS89 position, with notes for a start at the water bed or a datum other than NAP.
  - **DOV** CPT XML (`data/sondering/…`), in Belgian Lambert 72 and TAW; DOV's pore pressure `u` is shown as u2, with a note.
  - **AGS4** `SCPG` and `SCPT`, at their `LOCA` location, in the units of the `UNIT` row; a file with CPTs and no logs adds them to the site shown.
  - **CSV** tables of readings, with the position on the rows or in a collar table imported with them; pressures in kPa, MPa, bar, tsf, ksf or psi are converted. Template `docs/templates/cpt.csv`.

  Positions are converted to the project's coordinate system. CPTs far from the boreholes belong to another site and are left out, with a note; a CPT read again replaces the one of the same name.
- **CPTs in 3-D:** an axis from the start to the deepest reading, with the cone resistance drawn out from it on a panel that turns to face the camera; **CPTs** in the View panel shows or hides them. Hovering, or tapping on a phone, gives the readings at that depth and the CPT's log over the units of the model there.
- **CPTs on sections and profiles:** each CPT within reach is projected onto the section with its qc to the right and its friction ratio to the left, on one scale given under the section. Over a trace, the read-out gives its readings at that level.
- **CPT fields:** qc, fs, Rf and u2 colour the section like the laboratory results, from the means of the readings over 0.5 m interpolated within each unit.
- **Along a line**, the table by chainage gives qc at the crown and invert, or at the design level, and the nearest CPT with its distance.
- **Report:** a page with the logs of the CPTs on the section, their readings by unit of the model, and a list of the CPTs. The chainage page gives qc at the design levels and the nearest CPT.
- **Export → CPTs (CSV)**, one row per reading; the project file keeps the CPTs.
- **The Maasvlakte site has 26 BRO CPTs:** of those made since 2018, of quality class 1 or 2 and at least 30 m deep, the deepest in each 400 m square, with a reading every 0.1 m (`scripts/make-rotterdam-site.ts`).
- `src/cpt.ts` (readers and what follows from the readings), `src/cptSvg.ts` (a CPT's log).

### Changed
- Names on a section stay within the drawing.
- The Input data tab keeps a project's lines and CPTs when it is rebuilt from the tables, while the coordinate system stays the same; a note says when they are left out.

## 0.14.0 — 2026-10-14

### Added
- **LandXML and J-LandXML alignments.** Import the LandXML 1.2 file that road, rail and tunnel design software writes, or a J-LandXML file (the Japanese standard for 3-D design data built on it).
  - Each alignment's straights, circular arcs and spirals become its centreline, followed to within 2 cm, with chainage from the stations. Clothoids are integrated from their curvature and kept to the end the file gives; spirals of other types are drawn as clothoids, with a note. Points may be given or referred to by name.
  - The design profile (the points of vertical intersection with their parabolic vertical curves) becomes the design level. Circular and unsymmetrical vertical curves are drawn as symmetrical parabolas of their length, with a note.
  - Lengths in feet or US survey feet are converted. The coordinate system the file names (an EPSG code, or a J-LandXML zone of the Japanese plane rectangular system with its datum: `9(X,Y)` on JGD2011 is EPSG:6677) is converted to the project's.
  - Station equations are not applied, with a note: chainage runs on along the line.
- **Lines across straight sections.** A straight section marks the project's lines that cross it, with the chainage and the design levels at the crossing: a bar from invert to crown, or a tick at a single level. It shows on the section face, the 2-D section, the SVG and the report.

### Changed
- **Cross-section** turns the camera to look square at the new section, aimed at the line crossing it.

## 0.13.0 — 2026-10-14

### Added
- **Sections along a line.** A section can follow a tunnel, road, railway, pipeline or dike instead of running straight: **Section → Line**.
  - The 2-D section becomes the longitudinal profile by chainage, with the line's bends dotted and its design levels drawn: a band from crown to invert, or a single level. In 3-D the section face follows the line, the units are drawn see-through around it, and the chainage is labelled along the ground.
  - **Lines are read** from CSV (points by `x`, `y` or `lat`, `lon`, with optional `chainage` in metres or as `12+345.6`, kilometres under `km` or `KP`), GeoJSON (LineString and MultiLineString) and DXF (LWPOLYLINE and POLYLINE, arcs followed within 2 cm).
  - **Design levels** come with the points (`crown` and `invert`, `axis` and `diameter`, or one `level`), or by chainage alone in a second CSV.
  - **Draw a line…** adds points where the model is clicked or tapped; near a borehole the point is its collar, so a line through boreholes gives a fence section.
  - **Chainage** on the section bar marks a point on the profile and in 3-D, and **Cross-section** cuts square to the line there.
  - **Chainage table (CSV)**, a row every 1–100 m: ground, water table, each unit's thickness and, with design levels, the cover, the water above the crown and the units at crown and invert. Between crown and invert, each unit's share of the height gives the mixed faces along a tunnel. The PDF report gets a page of it, and names the stretches where the line is outside the model.
  - **Alignment (CSV)** exports a line; the project file keeps them.
- `src/alignment.ts`: the section along a line, exact as the straight one is, with a sample at every edge of the triangulation the line crosses and at each of its points. A straight line gives the straight section exactly, which the tests check.
- The buried-channel demo has a synthetic tunnel across the channel.

### Changed
- The section bar has a **Line** choice before the azimuth; it packs closer on screens up to 1,180 pixels across.
- The terrain and map status of the previous site is cleared when another site is opened.

## 0.12.0 — 2026-10-13

### Added
- **A layout for phones and tablets.** On a phone, held either way, and on a tablet held upright, the model fills the screen and the panels no longer cover it.
  - A bar at the bottom opens **Site**, **Section**, **View** and **Files** one at a time, as sheets, and the model moves into the part of the screen the sheet leaves free. A sheet closes with its ×, with its button in the bar, or when pulled down. Held sideways, the sheets open from the left.
  - The name of the site shown sits under the title, and opens the Site sheet.
  - The notes fold to one line under the title and open when tapped; an error still opens in full.
  - The 2-D section opens across the top, or on the right when the phone is on its side; its button sits in the title row of the Section sheet.
  - The credits keep to one line, and open in full when tapped.
- **Tap for details on touch screens.** A tap on the model shows what a mouse shows on hover: the logged interval of a borehole, or the unit, its depth and the stresses there. A tap within a finger's width of a borehole picks it. A finger moved along the 2-D section reads it, and the read-out stays when the finger lifts.
- On a touch screen, the tip in the panel describes the gestures: one finger orbits, two fingers pinch to zoom and pan.

### Changed
- On a phone the model is framed in the room between the title bar and the bar at the bottom, by its width when the phone is upright, and borehole labels are shown for up to 20 boreholes.
- When a panel opens or closes, the view moves to the free part of the screen over a fifth of a second.
- Clicking the title of the notes folds them.
- On screens up to 1,260 pixels across, the notes open below the tabs instead of over them; up to 1,180 pixels, the section bar packs closer, so its values no longer overlap.
- On a touch screen, text fields in the Input data tab use 16 px type, so the page does not zoom into a field when it is tapped.
- A section drawn narrower than about 500 pixels, as on a phone, names its ends A and A′ without their coordinates and shortens its axis title, so the labels no longer run into each other.

## 0.11.0 — 2026-10-13

### Added
- **Models for augmented reality** ([#14](https://github.com/kilickursat/GeoModel3D/issues/14)). **Export → 3-D model for AR (USDZ)** and **Export → 3-D model (GLB)** give the model as the viewer shows it: the same vertical exaggeration, without the hidden units, 30 cm across and standing on its base, with a pin at each borehole.
  - On an iPhone or iPad the USDZ opens in AR Quick Look, anchored to a horizontal surface; elsewhere it downloads. The GLB serves Android, web viewers and 3-D software such as Blender.
  - The model is built on a coarser mesh and keeps only the outside of the visible units, about 20,000 triangles for the larger sites; a hidden unit leaves a closed gap.
  - Each file carries the credits of its data.
- **The bundled sites in AR** at `ar/` on the site: GLB and USDZ for the four real sites, written by `scripts/make-ar-models.ts` during the build, with a page that opens them in AR Quick Look on iPhone and iPad and in Scene Viewer on Android. The GLBs pass the Khronos glTF validator with no errors or warnings.

### Changed
- The model builder takes the number of triangles its mesh is refined to.

## 0.10.0 — 2026-10-13

### Added
- **Check the model: leave-one-out cross-validation** ([#13](https://github.com/kilickursat/GeoModel3D/issues/13)). Each borehole in turn is left out, the model is built from the others, and the borehole's log is compared with what that model predicts at its collar. The panel reports:
  - the share of the logged metres predicted in the unit logged;
  - for each surface (the ground and every unit top), the bias, mean absolute and RMS errors and the largest error;
  - the boreholes outside the outline of the others apart, as extrapolations;
  - the boreholes furthest from their prediction, as logs to check; a click moves the section through one.
  Markers over the collars show each borehole's mean error, the read-out gives its result, **Errors (CSV)** saves every contact, and the PDF report gets a page with the results. On the bundled sites, 51.7 % (Creswick) to 87.5 % (Maasvlakte 2) of the logged metres are predicted in the unit logged.
- `crossValidate` and `crossValidation` in `src/validation.ts`, and `scripts/check-sites.ts`, which prints the results for the real sites.

### Changed
- **Antwerp:** three boreholes of 1987, GEO-87/185-B1, B2 and B3, are left out, now 170 boreholes. DOV records their collar heights with an unknown method, 20 m above the surveyed collar of the borehole nine metres away, and their logs put the top of the Boom Formation 20 m above the boreholes around them; the cross-validation and the collar check against the terrain both pointed to them.
- The Antwerp description says that its terrain is fetched with **Fetch terrain**, not when the project opens.
- The model builder can be given a probe point: the borehole triangulation gets a node there instead of being refined, and the horizons there are those of the refined model. Cross-validation builds each model this way, a few milliseconds per borehole instead of a second or more.
- The project schema is in `src/schema.ts`, without the datasets, which `src/geology.ts` keeps.

## 0.9.1 — 2026-10-13

### Fixed
- **Lengths in feet, centimetres or millimetres** ([#12](https://github.com/kilickursat/GeoModel3D/issues/12)). A CSV header such as `Elevation (ft)` or `Depth From (cm)` was read as metres, with no note. Such lengths are now converted to metres, to the millimetre, and the notes name the columns converted:
  - `ft` and `feet` are the international foot, `US ft` the US survey foot;
  - any other unit, such as `m`, `mbgl` or `mAOD`, is read as metres, as before; SPT penetration stays in millimetres;
  - AGS4 lengths whose UNIT row gives these units are converted too;
  - eastings and northings converted from feet come with a note to choose the metric version of their coordinate system.
- **Import notes in the Input data tab.** Files imported there had their notes counted in the status line but not shown; they are now listed under Checks while the case is open.

## 0.9.0 — 2026-10-09

### Added
- **Earth pressures** in the Input data tab. **Earth pressure: Drained** or **Undrained** turns the profile of the borehole shown into the active, at-rest and passive pressures on a smooth vertical wall with level ground (Rankine):
  - drained: effective pressures from c′ and φ′, with the water pressure u besides them;
  - undrained: total pressures, σv ∓ 2su in the units given an su, and drained pressures plus u in the others;
  - where the soil would pull on the wall, the active pressure is cut off (zero effective pressure), and the notes give the depths;
  - units without the parameters are left out and named, and a c′ that is not given is taken as 0 and said so;
  - the hover read-out and the table of values at the contacts follow the view.

### Changed
- c′, φ′ and su now give a result; E and k remain design values, kept with the model and reported.
- The worked example gives the soft clay φ′ = 23°, and the made ground and sand c′ = 0.
- On the stress profile, σ′h steps across a contact where K0 changes, instead of breaking off there.

## 0.8.1 — 2026-10-09

### Added
- **Contributing:** a contribution guide (`CONTRIBUTING.md`) on setting up, testing and submitting a change, with the rules for adding data; a code of conduct; issue templates for bugs, feature requests and data sources; and a pull request template.
- **Sponsoring:** a section in the README, with the project's Patreon page and an e-mail contact for sponsors.

### Changed
- **Notes on collars and the terrain grid.** When more than ten collars are more than 1 m off the terrain grid, after any consistent offset, one note now gives how many and their typical scatter (a robust standard deviation), and only the collars more than three times that scatter off are listed. With fetched terrain, Creswick opened with 121 notes and now has 5, Sakae has 46 instead of 61, and Antwerp 26 instead of 170. Every collar still keeps its surveyed height.

## 0.8.0 — 2026-10-09

### Added
- **Input data tab.** A tab next to the 3-D model where your own case is entered and modelled, replacing the data editor dialog:
  - start from a new case, a worked example, the dataset shown, imported files, or the case saved in this browser;
  - steps for the project (with the coordinate system, assumed groundwater depth, model base and model extent), boreholes, logs, water levels, SPT, tests, and units with γ, γsat, c′, φ′, su, E, k and K0;
  - a live preview: the boreholes in plan with the model outline, one borehole's log with σv, u, σ′v and σ′h down it (with a hover read-out and a table of values at the contacts), and the importer's and the model's checks;
  - **Build model** shows the case in 3-D; **Save case (JSON)** and **Download table (CSV)** keep copies, and the case is kept in this browser between visits;
  - reachable from the tabs, the toolbar (**Enter your own data…**), the dataset list, and the link `#input`.
- **Model extent.** A project's `margin` extends the model beyond its outermost boreholes. One or two boreholes, or boreholes in a line, which enclose no area, now give a model over an extent of their own instead of none. A single borehole may be typed without a position or ground level.
- **Horizontal effective stress** σ′h = K0 · σ′v on sections and in read-outs, for units given a K0 (new `K0` property; a `K0` column in the units table and template).
- **A real site in Australia:** the Creswick deep leads, Victoria: 150 groundwater bores from the National Groundwater Information System (Bureau of Meteorology, CC BY 3.0 AU), with the hydrostratigraphic interpretation of the Victorian Department of Primary Industries, in GDA94 / MGA zone 54 with AHD heights.

### Changed
- **Pinch-outs** stay at the borehole that lacks the unit; the README now states the rule and why the alternative was not adopted.
- The camera, terrain margin and map extent follow the model's footprint rather than the boreholes', so an extended model is framed whole.
- Imported or typed datasets are listed as "Your data: …".

### Removed
- The **Edit data…** dialog, superseded by the Input data tab.
- Personal data from the Japanese test fixtures: the survey engineers' names and registration numbers and the contractor's telephone number are now empty, and a test keeps them so.

## 0.7.0 — 2026-10-08

### Added
- **Real sites in Belgium and the Netherlands**, next to Sakae, Japan:
  - **Antwerp:** 173 DOV boreholes with their formal lithostratigraphy (made ground, Quaternary deposits, and the Kattendijk, Berchem and Boom formations), in Belgian Lambert 72 with TAW heights.
  - **Maasvlakte 2, Port of Rotterdam:** 100 BRO geotechnical boreholes with 3,188 laboratory results and 56 groundwater levels, in RD New with NAP heights.
- **Laboratory and in-situ test results.** Boreholes carry test results:
  - water content, unit weight, Atterberg limits, fines, organic content, su, qu, UCS, c′, φ′, E, k, qc, Vs, RQD or any named property;
  - read from CSV (a table with one column per property, or with property and value columns), AGS4 (`LNMC`, `LDEN`, `LLPL`, `GRAG`, `TRIT`, `LVAN`, `LPEN`, `IVAN`, `TREG`, `SHBG`, `RUCS`, `PTST`) and BRO files;
  - summarised per unit in the report.

  Units carry design values (c′, φ′, su, E, k…).
- **Groundwater and stresses.**
  - A water table runs through the water levels in the logs, or lies at an assumed depth.
  - Sections can be coloured by vertical total stress, pore water pressure or vertical effective stress, or by a measured property interpolated within each unit.
  - Hovering over a section reads out the unit, depth and stresses.
  - The field can be exported on a grid as CSV, and the report gains a page for it and a ground-parameters table.
- **Data editor.** **Edit data…** opens the project as tables:
  - settings, boreholes, logs, water levels, SPT, tests and units;
  - cells pasted from a spreadsheet;
  - units filled in from descriptions;
  - a CSV download per table.

  Apply checks typed data as the importer checks files.
- **Dutch BRO and Flemish DOV borehole XML.** BRO (BHR-GT) gives positions, NAP levels, layers, groundwater levels and laboratory determinations. DOV gives boreholes and their interpretations: formal stratigraphy by formation, else Quaternary or informal stratigraphy, descriptions or geotechnical coding.
- **AGS4:** SPT N-values (`ISPT`) and water strikes (`WSTG`, `WSTD`). Logs with descriptions but no unit codes (`GEOL_DESC`) are modelled.
- **CSV:** SPT and water-level tables, a water depth column on the collars, and descriptions on the intervals.
- **Descriptions grouped by principal soil** (Made ground, Peat, Clay, Silt, Sand, Gravel, rock types), in English, Dutch, French, German, Spanish, Portuguese and Italian, when logs carry no unit codes.
- **Templates** for every CSV table in `docs/templates`, and a README section on preparing data.
- **A map without terrain.** Without a terrain grid, a georeferenced model shows its map on a plane at the collars' median elevation.

### Changed
- **Logs that begin below the collar:** the contacts above their first unit are now inferred from the neighbouring boreholes. Before, the topmost unit was given the upper half of the unlogged part.
- **Collar-to-terrain offsets:** a consistent offset between collars and a terrain grid, as with another height datum, is reported once instead of for every borehole.
- **Exports:** the borehole CSV export includes descriptions and water depths, and a tests CSV export is added.
- **Page:** the page has a fuller description and a preview image for links and search engines.

### Fixed
- **Datum shifts:** latitudes and longitudes in RD New (Netherlands) and Luxembourg TM were placed about 170 m off. The PROJ strings from epsg.io carried Molodensky-Badekas parameters without their rotation point. Both now use the equivalent Helmert parameters, and tests check RD New against BRO positions and Belgian Lambert 72 against DOV's Lambert 2008 coordinates.
- **Hidden units:** units hidden in the legend were still drawn on the 3-D section face and in the 2-D section.
- **Colours:** Made Ground in the valley dataset, and the colour given to fill units, were nearly the grey of Mudstone.

## 0.6.1 — 2026-10-07

### Added
- **PDF reports.** **Export → Report (PDF, A3 or A4)** opens the print dialog with a report to save as PDF:
  - an overview with the 3-D view (on white, cropped to the model), a title block giving the coordinate system, ground, data source, date and version, and the units with their volumes and properties;
  - the section as vector graphics, at a round vertical exaggeration;
  - the unit rules when the units come from descriptions, the boreholes with positions, depths, water levels and SPT tests, and the notes on the model.

  It prints with the system's fonts, so Japanese and other scripts need no embedded fonts.

### Changed
- Exported SVG sections are drawn at a round vertical exaggeration (1, 2, 2.5, 5, 10…) instead of filling the drawing.
- Section drawings name fonts with Japanese glyphs after the Latin ones.

## 0.6.0 — 2026-10-07

### Added
- **Coordinate systems.** A project can declare its coordinate system: an EPSG code from a registry of 477 projected systems in metres, or a PROJ definition.
  - The registry covers the national systems of about forty countries and every WGS 84 UTM zone. It is generated from the EPSG dataset and works offline.
  - Positions given as latitude and longitude are placed in the system suggested for the site. Choosing another system places them again.
  - Conversions match the GSI survey calculator to the millimetre in the Japanese zones. Where the official transformation needs a grid file, the EPSG Helmert parameters are used and their accuracy is noted.
- **Terrain for any site.** **Fetch terrain** builds a grid around the model from GSI 5 m and 10 m DEM tiles in Japan and Terrain Tiles worldwide.
- **Maps.** **Map** drapes OpenStreetMap, or GSI maps and aerial photographs in Japan, over the terrain around the model. Imported data may be confidential, so nothing is requested from tile servers for them until asked. Every source shown is credited.
- **Japanese borehole XML** (電子納品, versions 2 to 4, as served by KuniJiban): position and datum, collar elevation, soil and rock descriptions, SPT tests and water levels.
- **Latitude and longitude** in CSV tables and AGS4 files (`LOCA_LAT`, `LOCA_LON`); a recognised `LOCA_GREF` sets the coordinate system.
- **Unit rules** assign units to logged descriptions by pattern, median SPT N-value and elevation, and can be edited in the viewer. New Japanese logs start from a grouping of the soil names by principal material.
- **A real reference site,** opened by default: 75 KuniJiban boreholes at Sakae, Yokohama, interpreted into Fill, Alluvium, Kanto Loam, Pleistocene sediments and the Kazusa Group.
- Borehole tooltips show the logged description, SPT N-values, water level and latitude and longitude.

### Changed
- Triangulations are refined by longest-edge bisection instead of a uniform subdivision, so long thin triangles between distant boreholes follow the terrain as closely as short ones.
- Terrain above the surface through the collars is made of what the top 5 m of the surrounding boreholes is made of, instead of all going to the unit at the surface. A thin topsoil no longer thickens on every ridge between boreholes.
- The automatic vertical exaggeration stops at ×5, and borehole labels are shown by default up to 40 boreholes.
- Long notices fold away the rest of their lines.
- Files are decoded as UTF-8, in the encoding an XML file declares, or as Shift_JIS.
- The offline single-file build grows from about 1.1 MB to 1.4 MB.

## 0.5.2 — 2026-10-07

### Fixed
- With terrain, where the ground lies above the surface between the collars, all the extra height went to the youngest unit. Thin units such as made ground thickened between boreholes, or appeared between boreholes that did not log them. The extra height now goes to the units at the surface of the surrounding boreholes. In the valley dataset, made ground falls from 29,540 to 20,738 m³.
- Since 0.5 the default section followed the subdivided mesh instead of the borehole layout, so it could turn when the mesh changed. It follows the borehole layout again; the valley opens at 077° instead of 080°.
- Pinch-outs and outcrops stepped along the triangle edges, which made them look jagged from above. The line where a horizon meets the one above it is now added to the mesh, so they run straight. Unit volumes are now exact for the cut surfaces, not just for their values at the mesh nodes.

### Changed
- WebGPU is the default backend wherever the browser offers it; elsewhere the viewer runs on WebGL 2 as before. `?backend=webgl` forces WebGL 2.
- The renderer link in the toolbar no longer breaks across two lines.

## 0.5.1 — 2026-10-06

### Fixed
- In the see-through view, the terrain was drawn over the translucent model and veiled it, so the model looked buried in the ground. The terrain is now drawn before the model.
- The terrain overlapped the model along the footprint edge. It is now clipped exactly at the footprint, and its collar correction is taken from the footprint boundary, so it meets the model's ground without a step.

### Changed
- The viewer opens cut at the section, with opaque units, instead of in the see-through view.
- The terrain shown around the model is limited to a margin of a quarter of the model's size.
- The "use WebGPU" link is hidden where WebGPU is unavailable.

## 0.5.0 — 2026-10-06

### Added
- **Terrain grids** (ESRI ASCII `.asc`, gridded `.xyz`), imported with boreholes or onto the loaded project.
  - The ground follows the grid, corrected so that surveyed collars keep their elevations.
  - Horizons are cut where the topography lies below them.
  - Collars more than 1 m from the grid, and boreholes outside it, are reported.
- **Erosional units.** Where an erosive unit removed older units from a log, those units are cut at its base instead of thinning towards it. On a synthetic buried channel with known geometry, this lowers the error of the truncated surfaces 2–5×.
- **Subdivided triangulation** where terrain or erosion needs it. Without either, models are unchanged.
- **Unit properties:** unit weight, saturated unit weight and their source, in unit tables and project JSON, with range checks.
- **Viewer:**
  - terrain beyond the model, drawn translucent and cut with it;
  - an erosive tag in the legend;
  - unit properties in the legend and on hover;
  - an "Exact colours" mode;
  - the active rendering backend shown in the toolbar.
- **Synthetic buried-channel dataset**, with its true geometry as a test fixture. The valley dataset gains a 5 m terrain grid with an incised stream. Both carry illustrative unit weights labelled as not measured.

### Changed
- The viewer runs on three.js r186's `WebGPURenderer` with TSL node materials.
  - WebGL 2 remains the default backend; WebGPU is opt-in with `?backend=webgpu` until it has been checked on real hardware.
  - The cut-away is a shader mask, identical on both backends.
- Frames are drawn only after something changes. On a software renderer, the idle loop went from 4 to 60 frames per second.
- The offline single-file build grows from 547 kB to about 1.1 MB.

## 0.4.0 — 2026-10-06

### Added
- Heterogeneous borehole logs. A unit missing from a log has zero thickness at that hole, so it pinches out between boreholes. Below the last unit a hole enters, horizons are inferred from neighbouring logs and kept below the end of the hole. The lowest unit closes at a model base.
- Data-driven projects: the stratigraphic column (order, names, colours) is data instead of a fixed TypeScript type.
- Import by file picker or drag and drop, with a report of everything that could not be used:
  - CSV, as one table or as collar, interval and unit tables.
  - AGS4 (`LOCA`, `GEOL`, `ABBR`).
  - Georeport3D extraction JSON.
  - GeoModel3D project JSON.
- Export: project JSON, boreholes CSV, section SVG and section CSV.
- Sections at any azimuth and offset, shown as a filled cut in 3-D and in a 2-D section view. The model can be cut away at the section.
- Unit volumes in m³, vertical exaggeration, unit visibility, borehole labels and hover details.
- A second synthetic dataset (valley) with pinch-outs, locally absent units and holes that stop above bedrock.
- Unit tests (vitest) for triangulation, model building, volumes, sections, section drawing and import.
- An offline single-file build (`dist/geomodel3d-offline.html`) and deployment to GitHub Pages.

### Fixed
- The project did not build: TypeScript rejected `main.ts`, and CI stopped before the build because no lock file was committed.
- The model was drawn on its side: the viewer used three.js's Y-up camera while elevations are stored in z.
- Delaunay triangulation dropped thin triangles along the convex hull. This affected a quarter of random borehole layouts and two thirds of the hull of boreholes along a curved alignment.
- A unit missing from a borehole was placed 1 m below ground, so horizons could cross.
- Volume side walls faced inwards.
- The README stated an MIT licence; the project is licensed under Apache-2.0.

## 0.3.0 — 2026-09-24
- TIN horizons, closed volumes between adjacent horizons, and a vertical section kernel.

## 0.2.0 — 2026-09-20
- Project-agnostic engine framing; synthetic dataset with six boreholes and five units; interpolated horizons.

## 0.1.0 — 2026-09-20
- Prototype: Three.js viewer with three interpolated horizons from five synthetic boreholes.
