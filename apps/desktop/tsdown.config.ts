import { defineConfig } from "tsdown";

export const DESKTOP_PRELOAD_FORMAT = "cjs" as const;
export const DESKTOP_INTERNAL_RUNTIME_PATTERN = /^@octant(?:\/|$)/;

const shared = {
  platform: "node" as const,
  deps: {
    alwaysBundle: [DESKTOP_INTERNAL_RUNTIME_PATTERN],
    neverBundle: ["electron"],
    onlyBundle: false as const,
  },
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/main.ts"],
    format: ["esm"],
  },
  {
    ...shared,
    clean: false,
    entry: ["src/preload.ts"],
    format: [DESKTOP_PRELOAD_FORMAT],
  },
]);
