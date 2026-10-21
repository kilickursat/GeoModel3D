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

## Architecture

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
- `src/main.ts`: three.js viewer and interface
- `scripts/`: the generators of the synthetic datasets, of the real sites (Sakae, Antwerp, Maasvlakte, Creswick) and of the coordinate system registry and DOV code list, the cross-validation of the real sites, their models for augmented reality, and the offline single-file build

## Development

```sh
npm ci
npm test         # unit tests (vitest)
npm run build    # type-check, then build dist/ and dist/geomodel3d-offline.html
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
