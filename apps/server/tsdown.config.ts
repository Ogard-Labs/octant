import { defineConfig } from "tsdown";

export const SERVER_INTERNAL_RUNTIME_PATTERN = /^@octant(?:\/|$)/;

export default defineConfig({
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
  format: ["esm"],
  platform: "node",
  target: "es2024",
});
