// Vite config for the EXPERIMENTAL board-capture page's browser test only (playwright.recon.config.ts). Its own port, its own
// dependency cache, the page's dependencies pre-bundled at start-up (so Vite never re-optimises and reloads the page mid-test,
// and never touches another dev server's cache), and /api proxied to the test's own backend. Not used by `npm run dev` or
// `vite build`; on a desktop or a phone the page is served by the normal dev server (see src/experimental/recon/README.md).
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.GLOVESIZE_API_URL ?? "http://127.0.0.1:8831";

export default defineConfig({
  plugins: [react()],
  cacheDir: "node_modules/.vite-recon",
  server: { port: 5231, strictPort: true, host: "127.0.0.1", proxy: { "/api": { target: api, changeOrigin: false } } },
  optimizeDeps: {
    entries: ["experiment/recon/index.html"],
    include: ["react", "react-dom", "react-dom/client", "react/jsx-dev-runtime", "three", "three/examples/jsm/controls/TrackballControls.js", "@mediapipe/tasks-vision"],
    exclude: ["@techstark/opencv-js"],
  },
  worker: { format: "es" },
});
