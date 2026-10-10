import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The browser only ever talks to same-origin /api. Vite proxies it to the NEXUS API on the server side.
// changeOrigin stays false so the API sees the preview Host header that matches the browser's Origin.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": { target: process.env.NEXUS_API_URL ?? "http://127.0.0.1:8787", changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
});
