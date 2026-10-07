import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// The Canvas preview page the host screenshots for an agent. It is a separate
// build into its own folder under dist so the app's own chunks and stylesheet
// order are left exactly as they are; it runs after the app build, which
// empties dist first.
export default defineConfig({
  base: "./",
  // The page needs none of the app's icons or backgrounds.
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
  build: {
    outDir: "dist/canvas-preview",
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(rootDir, "canvas-preview.html"),
    },
  },
});
