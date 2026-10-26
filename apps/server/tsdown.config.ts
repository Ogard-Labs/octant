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
    ],
    onlyBundle: false,
  },
  // The SSH executor is its own entry, so `octant executor --stdio` on a
  // target loads none of the server and opens no store. The headless artifact
  // ships it as `lib/server/sshTarget/executorMain.mjs`.
  entry: ["src/main.ts", "src/sshTarget/executorMain.ts"],
  format: ["esm"],
  platform: "node",
  target: "es2024",
});
