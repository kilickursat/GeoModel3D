# Changelog

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
