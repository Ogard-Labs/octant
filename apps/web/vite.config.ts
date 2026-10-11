import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { keepFontsAsFiles } from "./vite.fonts";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// OCTANT_TEST_ASYNC_STRESS=1 makes tests that read async-rendered state too
// early fail far more often; see src/asyncStress.test-support.ts. Diagnostic only.
const domSetupFiles =
  process.env.OCTANT_TEST_ASYNC_STRESS === "1"
    ? ["./src/testSetup.ts", "./src/asyncStress.test-support.ts"]
    : ["./src/testSetup.ts"];

const domTestFilesWithoutJsx = [
  "src/apple/useAppleSimulatorPaneOffer.test.ts",
  "src/android/useAndroidEmulatorPaneOffer.test.ts",
  "src/code/monacoRuntime.test.ts",
  "src/code/xtermRuntime.test.ts",
  "src/polling/documentVisibility.test.ts",
  "src/preview/usePreviewController.test.ts",
  "src/settings/useSettingsRoute.test.ts",
  "src/shell/useLaunchSession.test.ts",
  "src/shell/useShellPresentation.test.ts",
  "src/thread/threadExport.test.ts",
  "src/voice/voiceRecorder.test.ts",
  "src/work/useWorkThreadNavigation.test.ts",
];

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  build: { assetsInlineLimit: keepFontsAsFiles },
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
          setupFiles: domSetupFiles,
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
          setupFiles: domSetupFiles,
        },
      },
    ],
  },
});
