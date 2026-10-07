import "../styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import { chartExampleBlocks, treemapExampleBlocks } from "@octant/domain";
import { DEFAULT_DARK_TOKENS, DEFAULT_LIGHT_TOKENS, getThemePreset } from "@octant/theme";
import { CanvasDocument } from "./CanvasDocument";
import { canvasFixture } from "./test-fixtures";

/**
 * Rendered QA harness for the shared data-visualisation style.
 *
 * Renders every Canvas chart kind beside a metric, a table, and a timeline so a
 * headless capture can record how they read in each theme. The script
 * `scripts/capture-canvas-charts.ts` drives it; this page makes no network
 * calls and holds no theme logic of its own beyond applying a token set.
 */

const base = { schemaVersion: CANVAS_SCHEMA_VERSION } as const;

function chart(value: unknown) {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "chart") throw new Error("Harness fixture is not a chart.");
  return block;
}

const line = chart({
  ...base,
  blockId: "chart-line",
  kind: "chart",
  chartType: "line",
  format: "compact",
  series: [
    {
      seriesId: "requests",
      label: "Requests",
      points: [
        { x: "Mon", y: 120_000 },
        { x: "Tue", y: 1_350_000 },
        { x: "Wed", y: 980_000 },
      ],
    },
  ],
});

const bar = chart({
  ...base,
  blockId: "chart-bar",
  kind: "chart",
  chartType: "bar",
  format: "compact",
  series: [
    {
      seriesId: "signups",
      label: "Signups",
      points: [
        { x: "Mon", y: 3200 },
        { x: "Tue", y: 4100 },
        { x: "Wed", y: 3600 },
      ],
    },
  ],
});

const area = chart({
  ...base,
  blockId: "chart-area",
  kind: "chart",
  chartType: "area",
  series: [
    {
      seriesId: "latency",
      label: "Latency",
      points: [
        { x: 1, y: 120 },
        { x: 2, y: 90 },
        { x: 3, y: 150 },
      ],
    },
  ],
});

const scatter = chart({
  ...base,
  blockId: "chart-scatter",
  kind: "chart",
  chartType: "scatter",
  series: [
    {
      seriesId: "samples",
      label: "Samples",
      points: [
        { x: 1, y: 12 },
        { x: 2, y: 18 },
        { x: 3, y: 15 },
        { x: 4, y: 22 },
      ],
    },
  ],
});

const distribution = chart({
  ...base,
  blockId: "chart-distribution",
  kind: "chart",
  chartType: "distribution",
  series: [
    {
      seriesId: "size",
      label: "Size",
      points: Array.from({ length: 20 }, (_value, index) => ({
        x: index,
        y: Math.round(50 + 40 * Math.sin(index / 2)),
      })),
    },
  ],
});

const metric = decodeCanvasBlock({
  ...base,
  blockId: "metric-requests",
  kind: "metric",
  label: "Requests this month",
  value: 1_360_000,
  format: "compact",
  delta: 42_000,
});

const table = decodeCanvasBlock({
  ...base,
  blockId: "table-assets",
  kind: "table",
  columns: [
    { id: "asset", label: "Asset", type: "text" },
    { id: "size", label: "Size", type: "number", format: "bytes" },
    { id: "requests", label: "Requests", type: "number", format: "compact" },
    { id: "p95", label: "p95", type: "number", format: "duration" },
  ],
  rows: [
    ["bundle.js", 1_536_000, 1_360_000, 3725],
    ["styles.css", 245_760, 980_000, 160],
    ["hero.png", 1_048_576, 120_000, 45],
  ],
});

const timeline = decodeCanvasBlock({
  ...base,
  blockId: "timeline-releases",
  kind: "timeline",
  items: [
    {
      itemId: "r1",
      title: "Cut 0.4 branch",
      startAt: "2026-09-01T09:00:00.000Z",
      status: "success",
    },
    { itemId: "r2", title: "Beta rollout", startAt: "2026-09-15T09:00:00.000Z", status: "info" },
  ],
});

const definition = {
  ...canvasFixture,
  blocks: [
    line,
    bar,
    area,
    scatter,
    distribution,
    ...chartExampleBlocks,
    ...treemapExampleBlocks,
    metric,
    table,
    timeline,
  ],
};

type ChartThemeScenario = "default-light" | "default-dark" | "vivid" | "contrast";

function applyScenario(scenario: ChartThemeScenario): void {
  const root = document.documentElement;
  const lagoon = getThemePreset("lagoon");
  const resolved =
    scenario === "default-light"
      ? { tokens: DEFAULT_LIGHT_TOKENS, mode: "light" as const, style: "default", increased: false }
      : scenario === "default-dark"
        ? { tokens: DEFAULT_DARK_TOKENS, mode: "dark" as const, style: "default", increased: false }
        : scenario === "vivid"
          ? {
              tokens: lagoon?.tokens.dark ?? DEFAULT_DARK_TOKENS,
              mode: "dark" as const,
              style: "vivid",
              increased: false,
            }
          : {
              tokens: DEFAULT_DARK_TOKENS,
              mode: "dark" as const,
              style: "default",
              increased: true,
            };
  for (const [role, color] of Object.entries(resolved.tokens)) {
    root.style.setProperty(`--octant-${role}`, color);
  }
  root.dataset.octantThemeMode = resolved.mode;
  root.dataset.octantStyle = resolved.style;
  root.dataset.octantIncreasedContrast = String(resolved.increased);
  root.dataset.octantReducedMotion = "false";
  root.style.colorScheme = resolved.mode;
}

declare global {
  interface Window {
    __applyChartTheme?: (scenario: ChartThemeScenario) => void;
  }
}
window.__applyChartTheme = applyScenario;
applyScenario("default-light");

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Chart visuals evidence root is missing");

createRoot(rootElement).render(
  <StrictMode>
    <main data-canvas-chart-evidence="all">
      <CanvasDocument definition={definition} />
    </main>
  </StrictMode>,
);
