import { defineConfig } from "tsdown";

export const SERVER_INTERNAL_RUNTIME_PATTERN = /^@octant(?:\/|$)/;
export const MEDIATION_STANDALONE_RUNTIME_PATTERN = /./;

const runtime = {
  format: "esm" as const,
  platform: "node" as const,
  target: "es2024" as const,
};

export default defineConfig([
  {
    ...runtime,
    deps: {
      alwaysBundle: [
        SERVER_INTERNAL_RUNTIME_PATTERN,
        // The packaged app ships a fixed allowlist of external dependencies, and
        // this one is not in it: leaving it external made the server fail to start
        // outside a repository checkout.
        /^@modelcontextprotocol\//,
        // KaTeX typesets exported math; it is bundled for the same reason.
        /^katex(?:\/|$)/,
        // MCP input schemas are compiled on demand. Keep Ajv in a lazy bundled
        // chunk so packaged runtimes do not need a separately shipped module.
        /^ajv(?:\/|$)/,
      ],
      onlyBundle: false,
    },
    entry: {
      main: "src/main.ts",
      dbMaintenance: "src/maintenanceCli.ts",
      canvasExportWorker: "src/canvas/canvasExportWorker.mjs",
    },
  },
  // These entry points are copied by content hash into private host storage.
  // Build each as its own complete file: neither node_modules nor a shared
  // chunk remains beside it after relocation.
  {
    ...runtime,
    clean: false,
    deps: { alwaysBundle: [MEDIATION_STANDALONE_RUNTIME_PATTERN], onlyBundle: false },
    entry: { linuxMediationWorker: "src/process/linuxMediationWorker.ts" },
  },
  {
    ...runtime,
    clean: false,
    deps: { alwaysBundle: [MEDIATION_STANDALONE_RUNTIME_PATTERN], onlyBundle: false },
    entry: { linuxMediationSupervisor: "src/process/linuxMediationSupervisor.ts" },
  },
]);
