// Vite config for the EXPERIMENTAL viewer demo's browser test only (playwright.viewer.config.ts). Its own port and its own
// dependency cache, with the page's dependencies pre-bundled at start-up, so Vite never re-optimises (and reloads the page)
// mid-test and never touches the cache of another dev server running beside it. Not used by `npm run dev` or `vite build`.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  cacheDir: "node_modules/.vite-viewer",
  server: { port: 5207, strictPort: true, host: "127.0.0.1" },
  optimizeDeps: {
    entries: ["experiment/viewer/index.html"],
    include: ["react", "react-dom", "react-dom/client", "react/jsx-dev-runtime", "three", "three/examples/jsm/controls/TrackballControls.js"],
  },
  worker: { format: "es" },
});
