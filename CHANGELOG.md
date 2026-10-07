# Changelog

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
