import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// API and tracking redirects are proxied to the running Express agent on :3500
// so the dashboard can run as a normal SPA in dev without CORS gymnastics.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3500",
      "/r": "http://localhost:3500",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
