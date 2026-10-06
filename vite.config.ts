import {defineConfig} from "vite";

// Relative asset URLs: the same build works on GitHub Pages (/GeoModel3D/), any static host or sub-path.
export default defineConfig({
  base:"./",
  build:{chunkSizeWarningLimit:900}
});
