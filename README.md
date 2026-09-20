# GeoModel3D

**Project-agnostic, browser-native 3D geological modelling engine.**

GeoModel3D is an open foundation for constructing, interrogating and visualising subsurface geological models from heterogeneous geological observations.

## Prototype 0.2
- TypeScript + Three.js + Vite
- Six synthetic boreholes
- Five geological units: Alluvium, Weathered Rock, Sandstone, Mudstone, Granite
- Borehole-derived geological contacts
- IDW-interpolated horizons
- 3D borehole logs
- Generic underground alignment object
- Interactive vertical clipping control

The reference dataset is synthetic; it is intended to exercise the modelling pipeline, not represent a real site.

## Core concept
Data → observations → contacts → surfaces → volumes → properties → sections → 3D model

Potential inputs: boreholes, geological maps, survey data, point clouds, CSV, GeoJSON, DXF, LAS and structured observations extracted from reports.

## Planned packages
packages/geology-core
packages/geology-import
packages/geology-interpolation
packages/geology-surface
packages/geology-volume
packages/geology-section
packages/geology-analysis
packages/geology-three

## Deployment
This is a static Vite application. `npm install && npm run build` produces `dist/`, deployable to GitHub Pages, Cloudflare Pages, Vercel, Netlify or equivalent static hosting. No backend is required for the core viewer.

## Roadmap
1. Real geological reference datasets
2. TIN/constrained surfaces
3. Geological volumes and pinch-outs
4. Arbitrary section planes
5. Generic properties and uncertainty
6. CSV/GeoJSON/DXF/LAS import
7. Geological map draping
8. Large-model streaming/LOD
9. WebGPU acceleration
10. Optional AI/document extraction input pipeline

## License
MIT