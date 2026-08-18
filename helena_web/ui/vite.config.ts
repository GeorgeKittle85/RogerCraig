import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Python server owns port 7995 and serves `dist/` from there, so the built
// app and the API are always same-origin. `npm run dev` runs Vite separately
// and proxies the API back to it, which keeps hot reload working.
const BACKEND = process.env.HELENA_WEB_URL ?? "http://127.0.0.1:7995";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true, ws: false },
    },
  },
});
