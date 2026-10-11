import "../styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import {
  chartExampleBlocks,
  treemapExampleBlocks,
  heatmapExampleBlocks,
  barListExampleBlocks,
  comparisonMatrixExampleBlocks,
  mathExampleBlocks,
  metricExampleBlocks,
  notificationStatesExampleBlock,
  onboardingFlowExampleBlock,
  searchSpecExampleBlock,
  settingsScreenExampleBlock,
  orderSchemaBlock,
  supportFlowBlock,
  releaseMindmapBlock,
} from "@octant/domain";
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
  goodDirection: "up",
  sparkline: [980_000, 1_010_000, 1_120_000, 1_180_000, 1_360_000],
  caption: "since last release",
});

const hotFiles = decodeCanvasBlock({
  ...base,
  blockId: "bar-list-qa",
  kind: "bar-list",
  valueLabel: "Edits",
  secondaryLabel: "Lines",
  format: "number",
  scale: "sequential",
  rows: [
    { label: "apps/web/src/canvas/blocks/ChartBlock.tsx", value: 41, secondaryValue: 1189 },
    { label: "packages/domain/src/canvasPolicy.ts", value: 33, secondaryValue: 1255 },
    { label: "apps/server/src/canvas/artifactRender.ts", value: 27, secondaryValue: 769 },
    { label: "packages/contracts/src/canvas.ts", value: 19, secondaryValue: 1290 },
    { label: "apps/web/src/styles/canvas.css", value: 16, secondaryValue: 2607 },
    { label: "packages/theme/src/chartScales.ts", value: 12, secondaryValue: 507 },
    { label: "apps/web/src/canvas/ChartTooltip.tsx", value: 10, secondaryValue: 360 },
    { label: "packages/domain/src/canvasHeatmapLayout.ts", value: 8, secondaryValue: 359 },
    { label: "apps/web/src/canvas/blocks/TreemapBlock.tsx", value: 6, secondaryValue: 670 },
    { label: "packages/domain/src/canvasBarListLayout.ts", value: 4, secondaryValue: 210 },
    { label: "apps/server/src/canvas/canvasAgentTools.ts", value: 3, secondaryValue: 817 },
    { label: "packages/contracts/src/canvasIdentity.ts", value: 2, secondaryValue: 65 },
  ],
});

const table = decodeCanvasBlock({
  ...base,
  blockId: "table-assets",
  kind: "table",
  columns: [
    { id: "asset", label: "Asset", type: "text" },
    { id: "requests", label: "Requests", type: "number", format: "compact", display: "bar" },
    { id: "errors", label: "Errors", type: "number", display: "heat" },
    { id: "p95", label: "p95", type: "number", format: "duration" },
    { id: "state", label: "State", type: "text", display: "status" },
  ],
  rows: [
    ["apps/web/src/canvas/blocks/TableBlock.tsx", 1_360_000, 3, 3725, "Ready"],
    ["packages/domain/src/canvasPolicy.ts", 300_000, 0, 160, "Ready"],
    ["apps/server/src/canvas/artifactRender.ts", 980_000, 7, 240, "Blocked"],
    ["apps/web/src/styles/canvas.css", 60_000, 12, 45, "Ready"],
    ["packages/contracts/src/canvas.ts", 420_000, 1, 90, "Ready"],
    ["packages/theme/src/chartScales.ts", 150_000, 5, 30, "Warning"],
    ["apps/web/src/canvas/ChartTooltip.tsx", 88_000, 2, 12, "Ready"],
    ["scripts/capture-canvas-charts.ts", 12_000, 0, 8, "Ready"],
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

// Mockups beyond the describe examples: a styled browser page with a table
// under a confirmation modal, and a custom-size dashboard grid in a wireframe.
const membersMockup = decodeCanvasBlock({
  ...base,
  blockId: "mockup-members",
  kind: "mockup",
  device: "browser",
  fidelity: "styled",
  title: "Members",
  nodes: [
    { nodeId: "page", component: "stack", label: "Members" },
    { nodeId: "bar", component: "row", label: "Toolbar", parentId: "page" },
    { nodeId: "title", component: "heading", label: "Members", parentId: "bar" },
    {
      nodeId: "count",
      component: "badge",
      label: "3 seats left",
      tone: "warning",
      parentId: "bar",
    },
    {
      nodeId: "invite",
      component: "button",
      label: "Invite",
      icon: "plus",
      tone: "accent",
      parentId: "bar",
    },
    {
      nodeId: "people",
      component: "table",
      label: "People",
      columns: ["Name", "Role", "Last active"],
      rows: [
        ["Ada Lovelace", "Owner", "Today"],
        ["Grace Hopper", "Member", "Yesterday"],
        ["Alan Turing", "Member", "Last week"],
      ],
      parentId: "page",
    },
    { nodeId: "remove", component: "modal", label: "Remove Grace Hopper?", parentId: "page" },
    {
      nodeId: "remove-copy",
      component: "text",
      label: "They lose access to every project.",
      parentId: "remove",
    },
    { nodeId: "remove-actions", component: "row", label: "Actions", parentId: "remove" },
    { nodeId: "keep", component: "button", label: "Cancel", parentId: "remove-actions" },
    {
      nodeId: "confirm",
      component: "button",
      label: "Remove",
      tone: "danger",
      parentId: "remove-actions",
    },
  ],
  annotations: [{ nodeId: "confirm", note: "Removing the last owner is refused." }],
});

const dashboardMockup = decodeCanvasBlock({
  ...base,
  blockId: "mockup-dashboard",
  kind: "mockup",
  device: "custom",
  size: { width: 640, height: 400 },
  title: "Usage",
  nodes: [
    { nodeId: "page", component: "stack", label: "Usage" },
    { nodeId: "title", component: "heading", label: "This month", parentId: "page" },
    { nodeId: "tiles", component: "grid", label: "Tiles", gridColumns: 3, parentId: "page" },
    { nodeId: "t1", component: "card", label: "Requests", parentId: "tiles" },
    { nodeId: "t2", component: "card", label: "Errors", parentId: "tiles" },
    { nodeId: "t3", component: "card", label: "Spend", parentId: "tiles" },
    {
      nodeId: "chart",
      component: "image-placeholder",
      label: "Requests per day",
      parentId: "page",
    },
    {
      nodeId: "saved",
      component: "toast",
      label: "Report saved",
      tone: "success",
      parentId: "page",
    },
  ],
});

/**
 * A long article drawn as a themed document: headings, a lede, prose, a
 * quote, a list, a figure caption, cards, a callout, and code, so a capture
 * shows the kit's reading rhythm and that the page grows to its content.
 */
const articleBlock = decodeCanvasBlock({
  ...base,
  blockId: "article",
  kind: "design",
  title: "Why local-first",
  size: "document",
  frames: [
    {
      frameId: "article",
      title: "Article",
      html: [
        '<article class="oct-article">',
        '<p class="oct-eyebrow">Essay · 6 min read</p>',
        "<h1>Why a workspace should keep working offline</h1>",
        '<p class="oct-lede">The network is a convenience, not a dependency. Here is what changes when the work lives on your machine first.</p>',
        "<p>Every tool that waits on a server before it shows you your own notes teaches you to wait. A local-first workspace answers from disk, then reconciles. The difference is not speed alone: it is that nothing you wrote is ever hostage to a connection.</p>",
        "<h2>What stays on the machine</h2>",
        "<p>Threads, Canvases, and the journal that records them are written locally before anything else happens. A remote client reads them through the host, under the same authority the host enforces for itself.</p>",
        "<ul><li>The event journal is the source of truth.</li><li>Projections are rebuilt from it and can be thrown away.</li><li>Exports are explicit and name what leaves.</li></ul>",
        '<blockquote>"Offline is not an edge case. It is the case where you find out what you actually own."</blockquote>',
        '<div class="oct-grid"><div class="oct-card"><p class="oct-card__title">Journal</p><p>Append-only, replayable, and the only thing that is authoritative.</p></div><div class="oct-card"><p class="oct-card__title">Projections</p><p>Fast to read and safe to rebuild whenever the schema moves.</p></div><div class="oct-card"><p class="oct-card__title">Exports</p><p>Written on request, with the reader named before anything leaves.</p></div></div>',
        "<h2>What it costs</h2>",
        "<p>Conflict resolution moves from the server into the client, and every schema change needs a story for documents written by an older version. That is why each Canvas carries a schema version, and why an older runtime refuses a newer document instead of guessing.</p>",
        '<div class="oct-callout"><p class="oct-callout__title">Rule of thumb</p><p>If a feature cannot explain what it does with no network, it is not finished.</p></div>',
        '<pre class="oct-code"><code>if (declared > SUPPORTED) refuse("unsupported-schema-version");</code></pre>',
        "<h3>Further reading</h3>",
        '<p>The architecture notes cover persistence and replay in more depth; see <a href="#article">the top of this essay</a> for the summary.</p>',
        "<hr>",
        '<p class="oct-muted">Written for the Octant team. Comments welcome.</p>',
        "</article>",
      ].join(""),
    },
  ],
});

const designBlocks = [articleBlock, searchSpecExampleBlock, onboardingFlowExampleBlock];

const mockupBlocks = [
  settingsScreenExampleBlock,
  notificationStatesExampleBlock,
  membersMockup,
  dashboardMockup,
];

// `?only=mockup` draws the mockups alone, and `?only=design` the designs,
// so their capture is not a page of every chart.
const only = new URLSearchParams(window.location.search).get("only");

const definition =
  only === "mockup"
    ? { ...canvasFixture, blocks: mockupBlocks }
    : only === "design"
      ? { ...canvasFixture, blocks: designBlocks }
      : {
          ...canvasFixture,
          blocks: [
            line,
            bar,
            area,
            scatter,
            distribution,
            ...chartExampleBlocks,
            ...treemapExampleBlocks,
            ...heatmapExampleBlocks,
            ...barListExampleBlocks,
            hotFiles,
            ...comparisonMatrixExampleBlocks,
            ...mathExampleBlocks,
            ...metricExampleBlocks,
            metric,
            table,
            timeline,
            orderSchemaBlock,
            supportFlowBlock,
            releaseMindmapBlock,
            ...mockupBlocks,
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
