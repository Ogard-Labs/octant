import { defineConfig } from "tsdown";

export const CLI_INTERNAL_RUNTIME_PATTERN = /^@octant(?:\/|$)/;

// The headless artifact ships this bundle as `bin/octant` with no workspace
// beside it, so first-party packages are bundled in. Third-party dependencies
// stay external and are vendored next to it by scripts/package-headless.ts.
export default defineConfig({
  deps: {
    alwaysBundle: [CLI_INTERNAL_RUNTIME_PATTERN],
    onlyBundle: false,
  },
  entry: ["src/bin.ts"],
  format: ["esm"],
  platform: "node",
  target: "es2024",
});
