import { defineConfig } from "tsdown";

export const SERVER_INTERNAL_RUNTIME_PATTERN = /^@octant(?:\/|$)/;

export default defineConfig({
  deps: {
    alwaysBundle: [SERVER_INTERNAL_RUNTIME_PATTERN],
    onlyBundle: false,
  },
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "es2024",
});
