import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import type { CanvasMetricBlock } from "@octant/contracts/canvas";

/**
 * A tile row of headline numbers an agent is shown when it asks how to draw
 * one.
 *
 * Wire shape, not a branded block: describe returns these objects as-is. The
 * rows are consecutive metric blocks, which the document gathers side by side
 * as a responsive tile row. Each names how its value reads, which way is good
 * so a delta's tone is never guessed, a short recent trend, and a caption.
 * The agent gathers the numbers with its own tools.
 */

export const repositoryFileCountExample = {
  blockId: "repo-file-count",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "metric" as const,
  label: "Files",
  value: 4_182,
  format: "number" as const,
  caption: "tracked in this checkout",
} as const;

export const repositoryLinesExample = {
  blockId: "repo-lines",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "metric" as const,
  label: "Lines of code",
  value: 1_360_000,
  format: "compact" as const,
  delta: 12_400,
  goodDirection: "up" as const,
  sparkline: [1.2, 1.24, 1.27, 1.3, 1.31, 1.34, 1.36],
  caption: "since last release",
} as const;

export const repositoryCoverageExample = {
  blockId: "repo-coverage",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "metric" as const,
  label: "Coverage",
  value: 0.86,
  format: "percent" as const,
  delta: -0.02,
  goodDirection: "up" as const,
  sparkline: [0.9, 0.89, 0.9, 0.88, 0.87, 0.86, 0.86],
} as const;

/** Three consecutive metrics read as one repo-stats tile row. */
export const repoStatsTileRowExamples = [
  repositoryFileCountExample,
  repositoryLinesExample,
  repositoryCoverageExample,
] as const;

export const metricExamples = repoStatsTileRowExamples;

function metricBlock(value: unknown): CanvasMetricBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "metric") {
    throw new Error("Metric example did not decode as a metric block.");
  }
  return block;
}

export const metricExampleBlocks: ReadonlyArray<CanvasMetricBlock> =
  metricExamples.map(metricBlock);
