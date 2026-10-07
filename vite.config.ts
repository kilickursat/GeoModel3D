import {defineConfig} from "vite";

// Relative asset URLs: the same build works on GitHub Pages (/GeoModel3D/), any static host or sub-path.
// Bare "three" resolves to the WebGPU build so the viewer and the three.js add-ons share one module.
export default defineConfig({
  base:"./",
  resolve:{alias:[{find:/^three$/,replacement:"three/webgpu"}]},
  build:{target:"es2022",chunkSizeWarningLimit:1500},
  // Geometry tests build full models; allow slower CI machines.
  test:{testTimeout:20000}
});
