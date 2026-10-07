import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import type { CanvasBarListBlock } from "@octant/contracts/canvas";

/**
 * Ranked lists an agent is shown when it asks how to draw one.
 *
 * Wire shape, not a branded block: describe returns these objects as-is. The
 * agent gathers the numbers with its own tools; a Canvas reads nothing, so the
 * example carries only the labels and the readings, never a path the host has
 * not been given. A row that should offer Open file names a manifest source id
 * the author already holds; these examples name none, because creation attaches
 * no sources.
 */

/** The files changed most in a recent window, ranked largest first. */
export const hottestFilesExample = {
  blockId: "hottest-files",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "bar-list" as const,
  valueLabel: "Edits",
  secondaryLabel: "Lines",
  format: "number" as const,
  secondaryFormat: "compact" as const,
  scale: "sequential" as const,
  rows: [
    { label: "apps/web/src/canvas/blocks/ChartBlock.tsx", value: 41, secondaryValue: 1189 },
    { label: "packages/domain/src/canvasPolicy.ts", value: 33, secondaryValue: 1255 },
    { label: "apps/server/src/canvas/artifactRender.ts", value: 27, secondaryValue: 769 },
    { label: "packages/contracts/src/canvas.ts", value: 19, secondaryValue: 1290 },
    { label: "apps/web/src/styles/canvas.css", value: 12, secondaryValue: 2607 },
  ],
} as const;

/** The slowest tests in a suite, ranked by their duration in seconds. */
export const slowestTestsExample = {
  blockId: "slowest-tests",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "bar-list" as const,
  valueLabel: "Duration",
  format: "duration" as const,
  rows: [
    { label: "canvasPolicy.test.ts", value: 4.2 },
    { label: "artifactRender.test.ts", value: 2.6 },
    { label: "canvasHeatmapLayout.test.ts", value: 1.1 },
    { label: "ChartBlock.test.tsx", value: 0.7 },
  ],
} as const;

export const barListExamples = [hottestFilesExample, slowestTestsExample] as const;

function barListBlock(value: unknown): CanvasBarListBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "bar-list") {
    throw new Error("Bar-list example did not decode as a bar-list block.");
  }
  return block;
}

export const barListExampleBlocks: ReadonlyArray<CanvasBarListBlock> =
  barListExamples.map(barListBlock);
export const hottestFilesBlock = barListBlock(hottestFilesExample);
