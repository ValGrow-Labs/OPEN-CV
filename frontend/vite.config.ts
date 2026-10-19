/// <reference types="vitest/config" />
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `npm run dev` proxies /api to the FastAPI backend on :8000.
// `npm run dev:https` serves over HTTPS on the LAN so phones can grant camera access
// (browsers only expose cameras on secure origins or localhost).
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "https" ? [basicSsl()] : [])],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8000", changeOrigin: false } },
  },
  preview: {
    proxy: { "/api": { target: "http://127.0.0.1:8000", changeOrigin: false } },
  },
  optimizeDeps: { exclude: ["@techstark/opencv-js"] },
  build: { chunkSizeWarningLimit: 12000 },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    testTimeout: 30000,
  },
}));
