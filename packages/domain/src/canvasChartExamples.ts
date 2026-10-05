import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import type { CanvasChartBlock } from "@octant/contracts/canvas";

/**
 * Charts an agent is shown when it asks how to draw one.
 * Wire shape, not a branded block: describe returns these objects as-is.
 */
export const revenueShareExample = {
  blockId: "revenue-share",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "chart" as const,
  chartType: "pie" as const,
  series: [
    {
      seriesId: "revenue",
      label: "Revenue",
      points: [
        { x: "Product", y: 42 },
        { x: "Services", y: 28 },
        { x: "Support", y: 12 },
      ],
    },
  ],
};

export const costSplitExample = {
  blockId: "cost-split",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "chart" as const,
  chartType: "donut" as const,
  series: [
    {
      seriesId: "cost",
      label: "Cost",
      points: [
        { x: "Compute", y: 18 },
        { x: "Storage", y: 7 },
        { x: "Network", y: 4 },
      ],
    },
  ],
};

export const quarterlyStackExample = {
  blockId: "quarterly-stack",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "chart" as const,
  chartType: "stacked-bar" as const,
  series: [
    {
      seriesId: "product",
      label: "Product",
      points: [
        { x: "Q1", y: 10 },
        { x: "Q2", y: 14 },
        { x: "Q3", y: 12 },
      ],
    },
    {
      seriesId: "services",
      label: "Services",
      points: [
        { x: "Q1", y: 6 },
        { x: "Q2", y: 8 },
        { x: "Q3", y: 9 },
      ],
    },
  ],
};

export const quarterlyGroupExample = {
  blockId: "quarterly-group",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "chart" as const,
  chartType: "grouped-bar" as const,
  series: [
    {
      seriesId: "east",
      label: "East",
      points: [
        { x: "Q1", y: 8 },
        { x: "Q2", y: 11 },
        { x: "Q3", y: 9 },
      ],
    },
    {
      seriesId: "west",
      label: "West",
      points: [
        { x: "Q1", y: 5 },
        { x: "Q2", y: 7 },
        { x: "Q3", y: 10 },
      ],
    },
  ],
};

export const revenueAndMarginExample = {
  blockId: "revenue-margin",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "chart" as const,
  chartType: "bar-line" as const,
  series: [
    {
      seriesId: "revenue",
      label: "Revenue",
      mark: "bar" as const,
      points: [
        { x: "Q1", y: 40 },
        { x: "Q2", y: 52 },
        { x: "Q3", y: 48 },
      ],
    },
    {
      seriesId: "margin",
      label: "Margin",
      mark: "line" as const,
      points: [
        { x: "Q1", y: 12 },
        { x: "Q2", y: 15 },
        { x: "Q3", y: 11 },
      ],
    },
  ],
};

export const chartExamples = [
  revenueShareExample,
  costSplitExample,
  quarterlyStackExample,
  quarterlyGroupExample,
  revenueAndMarginExample,
] as const;

function chartBlock(value: unknown): CanvasChartBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "chart") {
    throw new Error("Chart example did not decode as a chart block.");
  }
  return block;
}

export const chartExampleBlocks = chartExamples.map(chartBlock);
