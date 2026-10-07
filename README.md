# GeoModel3D

**Project-agnostic, browser-native 3D geological modelling engine.**

GeoModel3D builds layer-cake geological models from borehole logs in the browser: TIN horizons, closed unit volumes and vertical sections, with no server and nothing to install.

- **Live:** https://kilickursat.github.io/GeoModel3D/
- **Offline:** [geomodel3d-offline.html](https://kilickursat.github.io/GeoModel3D/geomodel3d-offline.html) is a single self-contained file that opens from disk, for networks where hosted pages or local servers are not an option.

![A real site: 75 KuniJiban boreholes at Sakae, Yokohama, modelled over GSI terrain with OpenStreetMap around it](docs/screenshot.png)

## Version 0.6

- **Real sites on real maps, anywhere.** A project declares its coordinate system: an EPSG code from 477 national and UTM systems, or a PROJ definition. Terrain is fetched for the site (GSI 5 m and 10 m DEM in Japan, Terrain Tiles worldwide), and OpenStreetMap or a national map is draped around the model. See [Coordinate systems, terrain and maps](#coordinate-systems-terrain-and-maps).
- **Japanese borehole logs.** Import the electronic-delivery borehole XML (電子納品, as served by KuniJiban): positions, soil and rock descriptions, SPT N-values and water levels.
- **Unit rules.** Units are assigned to logged descriptions by rules on the description, the SPT N-value and the elevation, edited in the viewer.
- **A real reference site:** 75 KuniJiban boreholes at Sakae, Yokohama, interpreted into Fill, Alluvium, Kanto Loam, Pleistocene sediments and the Kazusa Group.
- **Adaptive refinement.** The triangulation is refined by longest-edge bisection, so the ground follows the terrain between distant boreholes as closely as between near ones.
- **PDF reports** (0.6.1). **Export → Report (PDF)** lays out an A3 or A4 report and opens the print dialog; choose *Save as PDF*. It holds the 3-D view with a title block and the units, the section as vector graphics at a round vertical exaggeration, and the boreholes, unit rules and notes. It prints with the system's fonts, so names in any script come out right.

Since 0.5:
- **Terrain.** Import a terrain grid (ESRI ASCII `.asc` or gridded `.xyz`). The ground follows it, corrected so every surveyed collar keeps its elevation, and the present topography cuts the units below it.
- **Erosional units.** Mark a unit as erosive and its base cuts older units, as a buried channel does, instead of the older units thinning towards it.
- **Unit properties.** Unit weight, saturated unit weight and the source of the values, imported, exported and shown with each unit.
- **WebGPU rendering** with TSL node materials, falling back to WebGL 2; see [Rendering](#rendering).

Since 0.4:
- **Heterogeneous logs.** Units missing from a log pinch out. Holes that stop above deeper units are honoured without inventing contacts.
- **Data-driven projects.** The stratigraphic column (order, names, colours) comes from the data.
- **Import** CSV tables, AGS4, Georeport3D extraction JSON and GeoModel3D project JSON, by file picker or drag and drop. Every row that cannot be used is reported.
- **Sections** at any azimuth and offset:
  - a filled section in 3-D;
  - an optional cut-away of the model;
  - a 2-D section view, exportable as SVG or CSV.
- **Unit volumes** in m³, vertical exaggeration, unit visibility, borehole labels and hover details.
- **Three synthetic reference datasets** (valley, buried channel, layer-cake). They exercise the modelling kernel and are not real sites; their unit weights are illustrative and labelled as such. See [Reference datasets](#reference-datasets).

## How a model is built

Boreholes → contacts → TIN horizons → closed unit volumes → sections

1. **Units from descriptions.** Where logs give soil or rock descriptions (borehole XML), the project's unit rules assign each interval a unit: the first rule whose pattern matches the description, and whose N-value and elevation ranges contain the interval's median SPT N-value and top elevation. Descriptions that no rule matches become units of their own and are reported.
2. **Stratigraphic column.** Units are ordered youngest (top) to oldest (bottom). A project can declare the order. Otherwise it is inferred from the logs: if unit A lies directly above unit B in any hole, A comes first. Logs that disagree are reported.
3. **Reading a log.** Each borehole gives the elevation of every contact it shows. A unit missing between two logged units has zero thickness at that hole, so it thins to zero towards it from the holes that logged it (it pinches out). A unit logged out of order below a younger one is modelled as the younger unit and reported. A contact inside an unlogged gap is placed at the middle of the gap and reported.
4. **Erosion.** If the unit directly above a contact is marked erosive, the units missing below it were eroded, not thinned. Their original surfaces at that hole are estimated from the holes that logged them, never below the erosion surface, and then cut by it.
5. **End of hole.** The base of the last unit a hole enters is not observed. Below it, horizons are inferred by stacking unit thicknesses, interpolated by inverse-distance weighting from holes that logged those units completely. The base of that last unit is kept below the end of the hole.
6. **Model base.** The lowest unit closes at a flat base at the deepest end of hole, or at the project's `base` elevation if one is given.
7. **Horizons.** All horizons share one Delaunay triangulation of the borehole collars, and the model covers the convex hull of the boreholes without extrapolating beyond it. Between holes, horizons are linear. With terrain or erosive units, the triangulation is refined by longest-edge bisection until no edge is longer than the terrain cell (or a fraction of the site, within about 80,000 triangles), so the ground follows the terrain and erosion surfaces cut sharply everywhere, also between distant boreholes. Where a horizon meets the one above it or the model base, that line is added to the triangulation, so pinch-outs and outcrops run straight across triangles instead of stepping along their edges.
8. **Terrain.** The ground follows the terrain grid. The grid is corrected by the difference between each surveyed collar and the grid, interpolated between boreholes, so collars keep their surveyed elevations; collars more than 1 m off are reported. Where the ground lies above the surface through the collars, the extra height is made of what the top 5 m of the surrounding boreholes is made of: each unit takes its share of that depth, interpolated between boreholes. A thin topsoil therefore takes little of it, and a unit absent from the top of every surrounding borehole takes none. Where it lies below, every horizon is kept at or below the ground, which removes units from the top where the topography cuts below them.
9. **Volumes.** Each unit is a closed, outward-facing shell between its top and base horizons. Its volume is exact for this piecewise-linear model: triangle area × mean vertex thickness.
10. **Sections.** A vertical plane cuts every horizon along the same triangulation edges, so the unit polygons line up. Boreholes within a buffer are projected onto the section. A horizon segment is dashed unless it was logged at the boreholes around it.

## Importing data

Use **Import data…** or drop files on the page. Files are read in the browser and are not uploaded anywhere.

| Format | What is read |
|---|---|
| CSV, one table | One row per interval: hole id, x and y (or latitude and longitude), z, from, to, unit, and optionally the final depth. |
| CSV, several tables | Collars (hole id, x and y or latitude and longitude, z, optional depth) and intervals (hole id, from, to, unit), plus an optional units table whose row order is the stratigraphic column: unit, name, colour, erosive (yes/no), unit weight, saturated unit weight (kN/m³) and source. |
| Terrain grid (`.asc`, `.xyz`) | An ESRI ASCII grid, or `x y z` points on a regular grid. It attaches to boreholes imported with it, or to the project already loaded. Grids above one million cells are averaged down. |
| AGS4 (`.ags`) | `LOCA`: `LOCA_NATE`/`LOCA_NATN`, or `LOCA_LAT`/`LOCA_LON`, with the local grid as a fallback, ground level `LOCA_GL` and final depth `LOCA_FDEP`; a recognised `LOCA_GREF` (such as `OSGB` or `EPSG:27700`) sets the coordinate system. `GEOL`: `GEOL_TOP`/`GEOL_BASE`, with the unit from `GEOL_GEOL`, `GEOL_GEO2` or `GEOL_LEG`. Unit names come from `ABBR`. |
| Japanese borehole XML (`.xml`) | Logs in the electronic-delivery format (地質・土質調査成果電子納品要領, versions 2 to 4), as delivered with Japanese public-works site investigations and downloadable from [KuniJiban](https://www.kunijiban.pwri.go.jp): position and geodetic datum, collar elevation, soil and rock descriptions, SPT tests and water levels. Select all of a project's logs at once. Units come from the current project's unit rules or, for a new project, from a first grouping of the soil names by principal material. |
| Georeport3D extraction JSON | `collar` easting/northing/elevation, `total_depth`, and `intervals` (`depth_from`, `depth_to`, `lithology`). A borehole without a complete collar is reported and not placed; coordinates are never invented. |
| GeoModel3D project JSON | The format written by **Export → Project (JSON)**. |

CSV headers are matched case-insensitively against common names:
- **Hole id:** `Hole ID`, `BH`, `LOCA_ID`
- **x:** `Easting`, `x`
- **y:** `Northing`, `y`
- **Latitude / longitude:** `Latitude`/`Lat`, `Longitude`/`Lon`
- **z:** `Elevation`, `RL`, `Ground level`, `z`
- **From / to:** `Depth From`/`Top` and `Depth To`/`Base`
- **Unit:** `Unit`, `Formation`, `Lithology`

Comma, semicolon and tab delimiters are detected, and decimal commas are accepted in semicolon files. Files are decoded as UTF-8, in the encoding an XML file declares, or as Shift_JIS, the encoding Japanese spreadsheets save CSV in.

x and y are eastings and northings in metres in one projected coordinate system. Latitude and longitude (WGS 84, or a national realisation that agrees with it to within a metre or two, such as JGD2011, ETRS89, GDA2020 or NAD83) are converted to the project's system.

A minimal project file:

```json
{
  "format": "geomodel3d-project",
  "version": 1,
  "name": "My site",
  "crs": "WGS 84 / UTM zone 54N",
  "crsCode": "EPSG:32654",
  "units": [
    {"id": "MG", "name": "Made ground", "color": "#7d6f86", "gamma": 19, "source": "Site investigation report, table 4"},
    {"id": "CG", "name": "Channel gravel", "color": "#d08a4c", "erosive": true},
    {"id": "MS", "name": "Mudstone", "color": "#6f7686", "gamma": 23, "gammaSat": 23.5}
  ],
  "boreholes": [
    {"id": "BH-01", "x": 456732.2, "y": 3987210.6, "z": 124.6, "depth": 35,
     "intervals": [{"from": 0, "to": 3.2, "unit": "MG"}, {"from": 3.2, "to": 30, "unit": "MS"}]}
  ],
  "terrain": {"x0": 456725, "y0": 3987205, "dx": 5, "dy": 5, "ncols": 3, "nrows": 2,
              "z": [124.1, 124.3, 124.8, 123.9, null, 124.5]}
}
```

Unit weights are in kN/m³ and optional; record where they come from in `source`. Terrain cells run west to east from the south-west cell centre (`x0`, `y0`); `null` marks a cell without data. `crsCode` georeferences the project with a code from the registry; a system that is not in it can be given as a PROJ definition in `crsProj4`.

Projects imported from descriptions also keep `rules` (`match`, `unit`, and optionally `minN`, `maxN`, `minZ`, `maxZ`), each interval's logged description as `name`, and each borehole's `lon`, `lat`, `spt` (depth, blows, penetration in mm) and `water` (depth, date).

**Export** writes:
- **Project (JSON):** the format above.
- **Boreholes (CSV):** also usable as an import template.
- **Section (SVG):** a vector drawing at a round vertical exaggeration.
- **Report (PDF, A3 or A4):** opens the print dialog with the report described above; choose *Save as PDF*.
- **Section (CSV):** distance, x, y and the elevation of every horizon along the section.

## Coordinate systems, terrain and maps

- **Coordinate system.** Type an EPSG code, a system or a country into the **Coordinates** field, or paste a PROJ definition. The registry (`src/data/crs.json`, built by `scripts/make-crs-registry.mjs`) holds 477 projected systems in metres from the EPSG dataset:
  - the national systems of about forty countries, among them all nineteen Japanese plane rectangular zones (JGD2011, JGD2000 and the Tokyo datum);
  - the British, Irish, Dutch, Belgian, French, Swiss, Austrian, Italian, Polish and Nordic grids;
  - ETRS89 and NAD83 UTM zones, US State Plane zones in metres, MGA, NZTM, SVY21, HK1980, and the Korean, Taiwanese and Chinese CGCS2000 zones;
  - every WGS 84 UTM zone.
- **Suggested systems.** Positions given as latitude and longitude are placed in the system in current use where the site lies (the national system, else the UTM zone). Boreholes keep their latitude and longitude, so choosing another system places them again; for data given only in projected coordinates, choosing a system declares what they are.
- **Accuracy.** Conversions use PROJ definitions (proj4js) and match the GSI survey calculator to the millimetre in the Japanese zones. Older datums whose official transformations use grid files (OSTN15, BETA2007, TKY2JGD and others) are shifted with the EPSG Helmert parameters instead, to the accuracy (1–9 m) noted with each system. This affects placing latitude and longitude, and the map, not coordinates already in the system. Systems in feet are not offered.
- **Terrain.** **Fetch terrain** builds a terrain grid over the model and a margin around it, resampled into the project's system: the GSI 5 m (laser survey) and 10 m DEMs in Japan, and Terrain Tiles worldwide (about 30 m, finer where national surveys are included). Where a finer source has gaps, the next one fills them.
- **Map.** **Map** drapes OpenStreetMap, or in Japan GSI's pale map or aerial photographs, over the terrain around the model, translucent and drawn before the model so it never hides it.
- **Privacy.** Fetching terrain and showing the map send tile requests for the site's area to those servers. Imported data may be confidential, so nothing is requested for them until you click **Fetch terrain** or tick **Map**. The bundled Sakae site, which is public, fetches its terrain and map when opened.
- **Credits.** Every source on screen is credited at the bottom of the view; see [Data sources](#data-sources).

## Rendering

The viewer uses three.js's `WebGPURenderer` with TSL node materials, so one shader description serves both the WebGPU and the WebGL 2 backends.

- **WebGPU is the default backend** wherever the browser offers it; elsewhere the viewer runs on WebGL 2. Add `?backend=webgl` to the address, or use the link under the display options, to force WebGL 2. The toolbar shows which backend is running.
- **The cut-away is a shader mask**, so it behaves identically on both backends.
- **Frames are drawn only when something changes**, so an idle model costs nothing. This matters on machines without a graphics card.
- **Exact colours** shows units unlit in their legend colours, for reading colours rather than shapes.
- **The model opens cut at a section**: opaque units with the section face toward you. Untick "Cut at section" for the see-through view.
- **Terrain around the model** is clipped exactly at the model's footprint, limited to a margin of a quarter of the model's size, drawn translucent and before the model, so it never veils it.

## Reference datasets

- **Sakae, Yokohama (real site).** 75 borehole logs from MLIT road surveys around Sakae-ku, Yokohama (Yokohama Circular South Route, Ken-O-Do and Yokohama-Shonan Road), from KuniJiban, in JGD2011 / Japan Plane Rectangular CS IX. The logs name no formations, so the units are an interpretation by unit rules of the logged names, SPT N-values and elevations:
  - **Fill**: fill, topsoil and pavement;
  - **Alluvium** (erosive): organic soils, clay and silt with N < 5, and sand and gravel with N < 20, below the 25 m valley floors;
  - **Kanto Loam**: volcanic ash soils;
  - **Pleistocene sediments**: the other soils;
  - **Kazusa Group**: from the first mudstone, cemented silt or layer with N ≥ 50 (the bearing stratum).

  Layers out of this order in a log (dense beds within softer ones, for instance) are modelled with the unit above and listed in the notes. Five rock-core logs that describe mudstone from the collar, where every neighbouring log shows 10–15 m of soft alluvium first, are left out. `scripts/make-sakae-site.ts` downloads the logs and builds the dataset.
- **Synthetic valley, buried channel and layer-cake.** Generated by the scripts in `scripts/`; they exercise the modelling kernel and are not real sites. The channel generator also writes the true geometry the tests compare against.

## Architecture

The modelling kernel has no rendering dependencies. It is tested in Node, and the viewer is a thin layer on top.

- `src/geology.ts` — project schema and the reference datasets
- `src/tin.ts` — Delaunay triangulation (Bowyer–Watson with a ghost vertex, so the convex hull is always covered)
- `src/terrain.ts` — terrain grids: reading, interpolation and coarsening
- `src/model.ts` — log interpretation, erosion, terrain and horizon assembly
- `src/volume.ts` — closed unit-volume meshes
- `src/section.ts` — vertical sections
- `src/sectionSvg.ts` — 2-D section drawing and CSV export
- `src/report.ts` — the printable report
- `src/io.ts` — CSV, AGS4, borehole XML and JSON import and export
- `src/boringXml.ts`, `src/xml.ts` — Japanese borehole logs, and a small XML reader
- `src/rules.ts` — units from logged descriptions
- `src/crs.ts` — coordinate systems: registry, suggestion and conversion
- `src/tiles.ts` — map and elevation tiles, and terrain resampling
- `src/main.ts` — Three.js viewer and interface
- `scripts/make-valley-demo.mjs`, `scripts/make-channel-demo.mjs` — generators for the synthetic datasets; the channel generator also writes the true geometry used in the tests
- `scripts/make-sakae-site.ts` — the Sakae reference site from KuniJiban
- `scripts/make-crs-registry.mjs` — the coordinate system registry from the EPSG dataset
- `scripts/build-single.mjs` — offline single-file build

## Development

```sh
npm ci
npm test         # unit tests (vitest)
npm run build    # type-check, then build dist/ and dist/geomodel3d-offline.html
```

`npm run dev` starts Vite's development server. Where a local server cannot be used, build and open `dist/geomodel3d-offline.html` instead.

## Deployment

Every push to `main` runs the tests, builds the site and publishes `dist/` to GitHub Pages (`.github/workflows/build.yml`). The output is static: `dist/` can be served from any static host, and `dist/geomodel3d-offline.html` needs no host at all.

## Roadmap

Done:
- **0.4:** import adapters (CSV, AGS4, Georeport3D), missing units and pinch-outs, sections at any orientation with export.
- **0.5:** terrain, erosional units, unit properties, WebGPU rendering (the default since 0.5.2).
- **0.6:** coordinate systems, fetched terrain and maps, Japanese borehole XML, unit rules, a real reference site, adaptive refinement, PDF reports.

Next:

1. **Appearance**, data-bearing only:
   - standard lithology symbols in 3-D and in the SVG section;
   - optional natural-looking rock textures;
   - terrain contours and hillshade;
   - fading where the model is inferred rather than logged.
2. **Physics fields** from the unit properties:
   - vertical stress, pore pressure and effective stress on volumes and sections;
   - a groundwater surface from the water levels in the logs;
   - horizontal stress only where K0 is given.
3. A choice, per unit, of where a missing unit pinches out (at the borehole that lacks it, or between boreholes).
4. Reference sites in other countries (published AGS4 data, the Dutch BRO).
5. Faults; constrained TIN boundaries, pinch-out lines and geological map contacts.
6. Fence diagrams for boreholes along an alignment (tunnels, roads).
7. GeoJSON, DXF and LAS import; GeoTIFF terrain.
8. Streaming and level of detail for large models.
9. Provenance display for Georeport3D extractions.

## Data sources

- **Borehole logs** of the Sakae site and the test fixtures: 国土地盤情報検索サイト「KuniJiban」の地盤情報 (KuniJiban; MLIT, PWRI and PARI). Under the KuniJiban terms of use, individual logs carry no copyright and may be copied and redistributed, provided their source is shown. No copyright is claimed on them here, and the Apache-2.0 licence does not apply to them.
- **Coordinate systems:** derived from the EPSG Geodetic Parameter Dataset (© IOGP), retrieved through epsg.io.
- **Terrain and maps,** fetched in the browser and not stored here: 地理院タイル (GSI tiles, Geospatial Information Authority of Japan); Terrain Tiles (Mapzen, on AWS Open Data; [sources](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)); map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.

## License

Apache-2.0 — see [LICENSE](LICENSE). The data listed under [Data sources](#data-sources) keep their own terms.
