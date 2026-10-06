# GeoModel3D

**Project-agnostic, browser-native 3D geological modelling engine.**

GeoModel3D builds layer-cake geological models from borehole logs in the browser: TIN horizons, closed unit volumes and vertical sections, with no server and nothing to install.

- **Live:** https://kilickursat.github.io/GeoModel3D/
- **Offline:** [geomodel3d-offline.html](https://kilickursat.github.io/GeoModel3D/geomodel3d-offline.html) is a single self-contained file that opens from disk, for networks where hosted pages or local servers are not an option.

![Synthetic valley model cut at a section, with the 2-D section view](docs/screenshot.png)

## Version 0.4

- **Heterogeneous logs.** Units missing from a log pinch out. Holes that stop above deeper units are honoured without inventing contacts.
- **Data-driven projects.** The stratigraphic column (order, names, colours) comes from the data.
- **Import** CSV tables, AGS4, Georeport3D extraction JSON and GeoModel3D project JSON, by file picker or drag and drop. Every row that cannot be used is reported.
- **Sections** at any azimuth and offset:
  - a filled section in 3-D;
  - an optional cut-away of the model;
  - a 2-D section view, exportable as SVG or CSV.
- **Unit volumes** in m³, vertical exaggeration, unit visibility, borehole labels and hover details.
- **Two synthetic reference datasets.** They exercise the modelling kernel and are not real sites.

## How a model is built

Boreholes → contacts → TIN horizons → closed unit volumes → sections

1. **Stratigraphic column.** Units are ordered youngest (top) to oldest (bottom). A project can declare the order. Otherwise it is inferred from the logs: if unit A lies directly above unit B in any hole, A comes first. Logs that disagree are reported.
2. **Reading a log.** Each borehole gives the elevation of every contact it shows. A unit missing between two logged units has zero thickness at that hole (pinch-out or erosion). A unit logged out of order below a younger one is modelled as the younger unit and reported. A contact inside an unlogged gap is placed at the middle of the gap and reported.
3. **End of hole.** The base of the last unit a hole enters is not observed. Below it, horizons are inferred by stacking unit thicknesses, interpolated by inverse-distance weighting from holes that logged those units completely. The base of that last unit is kept below the end of the hole.
4. **Model base.** The lowest unit closes at a flat base at the deepest end of hole, or at the project's `base` elevation if one is given.
5. **Horizons.** All horizons share one Delaunay triangulation of the borehole collars. Thickness varies linearly between holes, and the model covers the convex hull of the boreholes without extrapolating beyond it.
6. **Volumes.** Each unit is a closed, outward-facing shell between its top and base horizons. Its volume is exact for this piecewise-linear model: triangle area × mean vertex thickness.
7. **Sections.** A vertical plane cuts every horizon along the same triangulation edges, so the unit polygons line up. Boreholes within a buffer are projected onto the section. A horizon segment is dashed unless it was logged at both ends.

## Importing data

Use **Import data…** or drop files on the page. Files are read in the browser and are not uploaded anywhere.

| Format | What is read |
|---|---|
| CSV, one table | One row per interval: hole id, x, y, z, from, to, unit, and optionally the final depth. |
| CSV, several tables | Collars (hole id, x, y, z, optional depth) and intervals (hole id, from, to, unit), plus an optional units table (unit, name, colour) whose row order is the stratigraphic column. |
| AGS4 (`.ags`) | `LOCA`: `LOCA_NATE`/`LOCA_NATN`, with the local grid as a fallback, ground level `LOCA_GL` and final depth `LOCA_FDEP`. `GEOL`: `GEOL_TOP`/`GEOL_BASE`, with the unit from `GEOL_GEOL`, `GEOL_GEO2` or `GEOL_LEG`. Unit names come from `ABBR`. |
| Georeport3D extraction JSON | `collar` easting/northing/elevation, `total_depth`, and `intervals` (`depth_from`, `depth_to`, `lithology`). A borehole without a complete collar is reported and not placed; coordinates are never invented. |
| GeoModel3D project JSON | The format written by **Export → Project (JSON)**. |

CSV headers are matched case-insensitively against common names:
- **Hole id:** `Hole ID`, `BH`, `LOCA_ID`
- **x:** `Easting`, `x`
- **y:** `Northing`, `y`
- **z:** `Elevation`, `RL`, `Ground level`, `z`
- **From / to:** `Depth From`/`Top` and `Depth To`/`Base`
- **Unit:** `Unit`, `Formation`, `Lithology`

Comma, semicolon and tab delimiters are detected, and decimal commas are accepted in semicolon files. Coordinates must be in one projected coordinate system, in metres.

A minimal project file:

```json
{
  "format": "geomodel3d-project",
  "version": 1,
  "name": "My site",
  "crs": "EPSG:6677",
  "units": [
    {"id": "MG", "name": "Made ground", "color": "#7d6f86"},
    {"id": "MS", "name": "Mudstone", "color": "#6f7686"}
  ],
  "boreholes": [
    {"id": "BH-01", "x": 456732.2, "y": 3987210.6, "z": 124.6, "depth": 35,
     "intervals": [{"from": 0, "to": 3.2, "unit": "MG"}, {"from": 3.2, "to": 30, "unit": "MS"}]}
  ]
}
```

**Export** writes:
- **Project (JSON):** the format above.
- **Boreholes (CSV):** also usable as an import template.
- **Section (SVG):** a vector drawing.
- **Section (CSV):** distance, x, y and the elevation of every horizon along the section.

## Architecture

The modelling kernel has no rendering dependencies. It is tested in Node, and the viewer is a thin layer on top.

- `src/geology.ts` — project schema and the synthetic reference datasets
- `src/tin.ts` — Delaunay triangulation (Bowyer–Watson with a ghost vertex, so the convex hull is always covered)
- `src/model.ts` — log interpretation and horizon assembly
- `src/volume.ts` — closed unit-volume meshes
- `src/section.ts` — vertical sections
- `src/sectionSvg.ts` — 2-D section drawing and CSV export
- `src/io.ts` — CSV, AGS4 and JSON import and export
- `src/main.ts` — Three.js viewer and interface
- `scripts/make-valley-demo.mjs` — generator for the synthetic valley dataset
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

Done in 0.4: import adapters (CSV, AGS4, Georeport3D), missing units and pinch-outs, sections at any orientation with export.

Next:

1. Reference models from real public site-investigation data (e.g. published AGS4 files)
2. Unconformities, erosional surfaces and faults
3. Constrained TIN boundaries, pinch-out lines and geological map contacts
4. Generic numeric properties and uncertainty fields
5. GeoJSON, DXF and LAS import
6. Fence diagrams for boreholes along an alignment (tunnels, roads)
7. Geological map draping
8. Streaming and level of detail for large models
9. WebGPU renderer path
10. Provenance display for Georeport3D extractions

## License

Apache-2.0 — see [LICENSE](LICENSE).
