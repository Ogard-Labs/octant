import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import type { CanvasTreemapBlock } from "@octant/contracts/canvas";

/**
 * The hierarchy an agent is shown when it asks how to draw one.
 *
 * Wire shape, not a branded block: describe returns these objects as-is. The
 * agent gathers the numbers with its own tools; a Canvas reads nothing, so the
 * example carries only the structure and the readings, never a path.
 */
export const repositoryMapExample = {
  blockId: "repository-map",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "treemap" as const,
  measures: [
    { measureId: "loc", label: "Lines of code", format: "compact" as const },
    { measureId: "edits60", label: "Edits (60 days)", format: "number" as const },
    { measureId: "files", label: "Files", format: "number" as const },
  ],
  sizeBy: "loc",
  colorBy: "edits60",
  colorScale: "sequential" as const,
  nodes: [
    { nodeId: "octant", label: "octant" },
    { nodeId: "packages", label: "packages", parentId: "octant" },
    {
      nodeId: "contracts",
      label: "contracts",
      parentId: "packages",
      values: { loc: 38_400, edits60: 42, files: 61 },
    },
    {
      nodeId: "domain",
      label: "domain",
      parentId: "packages",
      values: { loc: 52_100, edits60: 61, files: 84 },
    },
    {
      nodeId: "theme",
      label: "theme",
      parentId: "packages",
      values: { loc: 9_400, edits60: 18, files: 21 },
    },
    { nodeId: "apps", label: "apps", parentId: "octant" },
    {
      nodeId: "web",
      label: "web",
      parentId: "apps",
      values: { loc: 210_300, edits60: 120, files: 318 },
    },
    {
      nodeId: "server",
      label: "server",
      parentId: "apps",
      values: { loc: 96_200, edits60: 74, files: 176 },
    },
    {
      nodeId: "desktop",
      label: "desktop",
      parentId: "apps",
      values: { loc: 41_000, edits60: 33, files: 72 },
    },
    { nodeId: "scripts", label: "scripts", parentId: "octant" },
    {
      nodeId: "build",
      label: "build",
      parentId: "scripts",
      values: { loc: 6_200, edits60: 9, files: 14 },
    },
    {
      nodeId: "release",
      label: "release",
      parentId: "scripts",
      values: { loc: 3_100, edits60: 4, files: 9 },
    },
  ],
};

/**
 * The same shape with a categorical scale: a hue per top-level group, so the
 * picture reads as which subsystem a leaf belongs to rather than how much.
 */
export const coverageMapExample = {
  blockId: "coverage-map",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "treemap" as const,
  measures: [
    { measureId: "loc", label: "Lines of code", format: "compact" as const },
    { measureId: "covered", label: "Covered", format: "percent" as const },
  ],
  sizeBy: "loc",
  colorBy: "covered",
  colorScale: "categorical" as const,
  nodes: [
    { nodeId: "src", label: "src" },
    { nodeId: "shell", label: "shell", parentId: "src" },
    {
      nodeId: "sidebar",
      label: "sidebar",
      parentId: "shell",
      values: { loc: 8_400, covered: 0.82 },
    },
    {
      nodeId: "composer",
      label: "composer",
      parentId: "shell",
      values: { loc: 11_200, covered: 0.67 },
    },
    { nodeId: "canvas", label: "canvas", parentId: "src" },
    {
      nodeId: "blocks",
      label: "blocks",
      parentId: "canvas",
      values: { loc: 19_600, covered: 0.91 },
    },
    {
      nodeId: "runtime",
      label: "runtime",
      parentId: "canvas",
      values: { loc: 7_300, covered: 0.58 },
    },
  ],
};

export const treemapExamples = [repositoryMapExample, coverageMapExample] as const;

function treemapBlock(value: unknown): CanvasTreemapBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "treemap") {
    throw new Error("Treemap example did not decode as a treemap block.");
  }
  return block;
}

export const treemapExampleBlocks = treemapExamples.map(treemapBlock);
export const repositoryMapBlock = treemapBlock(repositoryMapExample);
