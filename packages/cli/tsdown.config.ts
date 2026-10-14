import { defineConfig } from "tsdown";

export const CLI_INTERNAL_RUNTIME_PATTERN = /^@octant(?:\/|$)/;

export default defineConfig([
  // The headless artifact ships this bundle as `bin/octant` with no workspace
  // beside it, so first-party packages are bundled in. Third-party dependencies
  // stay external and are vendored next to it by scripts/package-headless.ts.
  {
    deps: {
      alwaysBundle: [CLI_INTERNAL_RUNTIME_PATTERN],
      onlyBundle: false,
    },
    entry: ["src/bin.ts"],
    format: ["esm"],
    platform: "node",
    target: "es2024",
  },
  // The desktop app ships this one file as the terminal's `octant` (only
  // `octant mcp`). Nothing is vendored beside it, so every dependency is
  // bundled in.
  {
    deps: {
      alwaysBundle: [/./],
      onlyBundle: false,
    },
    entry: ["src/terminalLauncherMain.ts"],
    format: ["esm"],
    platform: "node",
    target: "es2024",
  },
]);
