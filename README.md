# GeoModel3D

**Project-agnostic, browser-native 3D geological modelling engine.**

GeoModel3D is an open foundation for constructing, interrogating and visualising subsurface geological models from heterogeneous geological observations.

## Prototype 0.3

The core viewer now represents geology as explicit 3D model primitives rather than only interpolated display grids:

- TypeScript + Three.js + Vite
- Six synthetic boreholes
- Five geological units
- Triangulated (TIN) geological horizons
- Closed geological volumes between adjacent horizons
- 3D borehole logs
- Vertical section plane with computed horizon intersections
- Interactive volume visibility and section offset

The reference dataset remains synthetic. It exercises the modelling kernel and is not a real geological site.

## Model pipeline

Boreholes → contacts → TIN horizons → geological volumes → sections → Three.js

The current volume builder assumes each demo borehole contains the same ordered lithological stack. The data model is intentionally small so it can be replaced with real heterogeneous observations later.

## Architecture

Core modelling logic is separated from the viewer:

- `src/geology.ts` — observation schema and reference dataset
- `src/tin.ts` — browser-native 2D Delaunay triangulation
- `src/volume.ts` — TIN surface and closed-volume geometry
- `src/model.ts` — horizon/volume assembly
- `src/section.ts` — triangle/plane section intersection
- `src/main.ts` — Three.js rendering and interaction

## Planned next

1. Real public geological datasets and import adapters
2. Missing/eroded units, pinch-outs and unconformities
3. Constrained TIN boundaries and geological map contacts
4. Generic numeric properties and uncertainty fields
5. CSV/GeoJSON/DXF/LAS import
6. Arbitrary section orientation and section export
7. Geological map draping
8. Streaming/LOD for large models
9. WebGPU renderer path
10. Optional AI/document extraction input pipeline for Georeport3D

## Deployment

This remains a static Vite application. `npm install && npm run build` produces `dist/` for GitHub Pages, Cloudflare Pages, Vercel, Netlify or equivalent static hosting.

## License

MIT
