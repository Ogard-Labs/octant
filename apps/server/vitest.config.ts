import { defineConfig } from "vitest/config";

const processFileGlobs = [
  "src/**/*Process*.test.ts",
  "src/**/*process*.test.ts",
  "src/**/*.smoke.test.ts",
];

/**
 * Evidence suites drive real provider binaries or credentials and skip
 * themselves unless the matching `OCTANT_*` environment variables are set.
 * They are not part of `bun run test`; run them on demand with
 * `bun run test:evidence`.
 */
const evidenceFileGlobs = ["src/**/*Smoke.integration.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: [...processFileGlobs, ...evidenceFileGlobs],
        },
      },
      {
        test: {
          name: "process",
          include: processFileGlobs,
          exclude: evidenceFileGlobs,
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
      {
        test: {
          name: "evidence",
          include: evidenceFileGlobs,
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
    ],
  },
});
