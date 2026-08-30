import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const domTestFilesWithoutJsx = [
  "src/code/monacoRuntime.test.ts",
  "src/code/xtermRuntime.test.ts",
  "src/polling/documentVisibility.test.ts",
  "src/preview/usePreviewController.test.ts",
  "src/settings/useSettingsRoute.test.ts",
  "src/shell/useLaunchSession.test.ts",
  "src/thread/threadExport.test.ts",
  "src/work/useWorkThreadNavigation.test.ts",
];

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "web-node",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: domTestFilesWithoutJsx,
          maxWorkers: 2,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "web-dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx", ...domTestFilesWithoutJsx],
          exclude: ["src/App.test.tsx"],
          maxWorkers: 2,
          sequence: { groupOrder: 0 },
          setupFiles: ["./src/testSetup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "web-app",
          environment: "jsdom",
          include: ["src/App.test.tsx"],
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
          setupFiles: ["./src/testSetup.ts"],
        },
      },
    ],
  },
});
