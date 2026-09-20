# GeoModel3D

Browser-native geological modelling engine built with TypeScript and Three.js.

## v0.1 prototype

The first prototype demonstrates:

- Synthetic borehole data
- Lithology interval parsing
- Geological contact extraction
- IDW interpolation
- Delaunay triangulation
- 3D geological surface rendering
- Borehole visualization
- Lithology colouring
- Interactive clipping plane
- Sample TBM alignment and trajectory

## Run

```bash
npm install
npm run dev
```

Then open the local Vite URL.

## Architecture

```
Boreholes -> Contacts -> Interpolation -> Geological Surface -> Three.js
                                                   |
                                                   +-> TBM alignment
```

The geological core is deliberately separated from the rendering layer so future implementations can add kriging, RBF interpolation, volumetric cells, uncertainty fields, and TBM/AI coupling without rewriting the viewer.

## Roadmap

1. Multiple geological horizons and volumes
2. Fault surfaces
3. RMR/GSI/UCS/RQD property fields
4. Arbitrary geological sections
5. Tunnel-aligned coordinate system
6. TBM operational data sampling
7. Geological uncertainty
8. Online/recursive geological updating

## License

MIT
