import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { keepFontsAsFiles } from "./vite.fonts";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const workspacePackagesDir = path.resolve(rootDir, "../../packages");

/** Whether a module is a workspace package's own source, judged from this checkout's root. */
function isWorkspacePackageSource(id: string): boolean {
  const relative = path.relative(workspacePackagesDir, id);
  return (
    !relative.startsWith("..") && !path.isAbsolute(relative) && relative.split(/[\\/]/)[1] === "src"
  );
}

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
  "src/theme/appBackdropAscii.test.ts",
  "src/theme/appBackdropCharacters.test.ts",
  "src/theme/appBackdropFlowing.test.ts",
  "src/theme/appBackdropPrint.test.ts",
  "src/thread/threadExport.test.ts",
  "src/voice/voiceRecorder.test.ts",
  "src/work/useWorkThreadNavigation.test.ts",
];

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    assetsInlineLimit: keepFontsAsFiles,
    rollupOptions: {
      treeshake: {
        // The contract schemas are top-level `Schema` calls Rolldown cannot
        // prove pure, and the workspace packages' barrels re-export every
        // module, so a single import kept every schema a touched file
        // defines. This marks those calls pure and every workspace package's
        // sources side-effect-free for the window build only — the server
        // and desktop bundles read package.json and are unchanged — saving
        // about 108 KiB of initial gzip. Any package module the window
        // imports must therefore do no work at import time; entry scripts
        // that do (the CLI's) are never imported here.
        manualPureFunctions: ["Schema"],
        moduleSideEffects: (id) => !isWorkspacePackageSource(id),
      },
    },
  },
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
