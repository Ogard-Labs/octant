import "../styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Schema } from "effect";
import {
  CANVAS_SCHEMA_VERSION,
  CanvasDesignAssetResolution,
  decodeCanvasBlock,
} from "@octant/contracts/canvas";
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
  designBriefExample,
  launchGanttExample,
  opsDashboardExampleBlocks,
  releaseHealthBoardExampleBlocks,
} from "@octant/domain";
import { DEFAULT_DARK_TOKENS, DEFAULT_LIGHT_TOKENS, getThemePreset } from "@octant/theme";
import { CanvasDocument } from "./CanvasDocument";
import type { DesignAssetRuntime } from "./blocks/designDocument";

const decodeCanvasDesignAssetResolution = Schema.decodeUnknownSync(CanvasDesignAssetResolution);
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

/**
 * A phone mockup that shows a Project screenshot by asset id beside one the
 * host refused, so a capture shows the inlined image and the placeholder.
 * The harness stands in for the host: it answers with fixture bytes, and the
 * frame still loads nothing.
 */
const assetMockupBlock = decodeCanvasBlock({
  ...base,
  schemaVersion: 17,
  blockId: "asset-mockup",
  kind: "design",
  title: "Release notes app",
  size: "phone",
  theme: "workspace",
  styles: [
    "body { margin: 0; font-family: var(--oct-font-body); color: var(--oct-fg); }",
    ".screen { padding: 28px 24px; }",
    ".screen h1 { font-size: 26px; margin: 0 0 8px; }",
    ".screen p { margin: 0 0 18px; color: var(--oct-muted); }",
    ".shot { display: block; width: 100%; border-radius: 18px; border: 1px solid var(--oct-border); }",
    ".hero { height: 220px; border-radius: 18px; background: url(octant-asset:hero) center / cover; }",
  ].join("\n"),
  assets: [
    { assetId: "home-shot", source: { kind: "project-file", path: "screens/home.png" } },
    { assetId: "hero", source: { kind: "project-file", path: "../outside/hero.png" } },
  ],
  frames: [
    {
      frameId: "home",
      title: "Home screenshot",
      html: '<div class="screen"><h1>What shipped</h1><p>The home screen, as it runs today.</p><img class="shot" src="octant-asset:home-shot" alt="Home screen"></div>',
    },
    {
      frameId: "hero",
      title: "Refused hero",
      html: '<div class="screen"><h1>Launch hero</h1><p>An image outside the folder draws a placeholder.</p><div class="hero" role="img" aria-label="Hero"></div></div>',
    },
  ],
});

const HOME_SHOT_PNG =
  "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";

const harnessDesignAssets: DesignAssetRuntime = {
  resolve: async (blockId) =>
    blockId === "asset-mockup"
      ? [
          { assetId: "home-shot", status: "resolved", mediaType: "image/png", data: HOME_SHOT_PNG },
          { assetId: "hero", status: "unavailable", reason: "refused" },
        ].map((entry) => decodeCanvasDesignAssetResolution(entry))
      : undefined,
};

const designBlocks = [
  articleBlock,
  searchSpecExampleBlock,
  onboardingFlowExampleBlock,
  assetMockupBlock,
];

const mockupBlocks = [
  settingsScreenExampleBlock,
  notificationStatesExampleBlock,
  membersMockup,
  dashboardMockup,
];

// Flow charts beyond the describe examples: a deeper sankey whose flows skip a
// column, a lone radar series, and a funnel with long stage names.
const budgetSankey = chart({
  ...base,
  blockId: "chart-sankey-budget",
  kind: "chart",
  chartType: "sankey",
  format: "compact",
  series: [],
  links: [
    { source: "Revenue", target: "Product", value: 6_400_000 },
    { source: "Revenue", target: "Services", value: 2_100_000 },
    { source: "Product", target: "Engineering", value: 3_200_000 },
    { source: "Product", target: "Hosting", value: 1_400_000 },
    { source: "Product", target: "Margin", value: 1_800_000 },
    { source: "Services", target: "Support staff", value: 1_500_000 },
    { source: "Services", target: "Margin", value: 600_000 },
    { source: "Engineering", target: "Salaries", value: 2_700_000 },
    { source: "Engineering", target: "Tools", value: 500_000 },
    { source: "Hosting", target: "Compute", value: 1_000_000 },
    { source: "Hosting", target: "Storage", value: 400_000 },
  ],
});

const loneRadar = chart({
  ...base,
  blockId: "chart-radar-lone",
  kind: "chart",
  chartType: "radar",
  format: "percent",
  series: [
    {
      seriesId: "coverage",
      label: "Coverage",
      points: [
        { x: "Contracts", y: 0.92 },
        { x: "Domain", y: 0.88 },
        { x: "Server", y: 0.71 },
        { x: "Web renderer", y: 0.64 },
        { x: "Desktop", y: 0.42 },
        { x: "Mobile", y: 0.35 },
        { x: "Scripts", y: 0.55 },
      ],
    },
  ],
});

const longFunnel = chart({
  ...base,
  blockId: "chart-funnel-long",
  kind: "chart",
  chartType: "funnel",
  series: [
    {
      seriesId: "review",
      label: "Pull requests",
      points: [
        { x: "Opened against main", y: 240 },
        { x: "Passed required checks on the first run", y: 168 },
        { x: "Approved without changes requested", y: 96 },
        { x: "Merged through the queue", y: 90 },
      ],
    },
  ],
});

const dashboardBlocks = [...opsDashboardExampleBlocks, ...releaseHealthBoardExampleBlocks];

const flowBlocks = [
  ...chartExampleBlocks.filter(
    (block) =>
      block.chartType === "funnel" || block.chartType === "radar" || block.chartType === "sankey",
  ),
  budgetSankey,
  loneRadar,
  longFunnel,
];

// A table wide enough to scroll sideways in the main tab, with row ids so the
// comment gutter draws, for the grouping and pinning capture.
const wideTable = decodeCanvasBlock({
  ...base,
  blockId: "table-services",
  kind: "table",
  columns: [
    { id: "service", label: "Service", type: "text" },
    { id: "owner", label: "Owner", type: "text" },
    { id: "region", label: "Region", type: "text" },
    { id: "state", label: "State", type: "text", display: "status" },
    { id: "requests", label: "Requests", type: "number", format: "compact", display: "bar" },
    { id: "errors", label: "Errors", type: "number", display: "heat" },
    { id: "p95", label: "p95 (ms)", type: "number" },
    { id: "cost", label: "Monthly cost (USD)", type: "number" },
    { id: "uptime", label: "Uptime", type: "number", format: "percent" },
    { id: "release", label: "Last release", type: "text" },
  ],
  rows: [
    {
      id: "gateway",
      cells: [
        "API gateway",
        "Platform",
        "eu-north-1",
        "Ready",
        1_360_000,
        3,
        120,
        4200,
        0.9995,
        "2026-10-02",
      ],
    },
    {
      id: "search",
      cells: [
        "Search indexer",
        "Discovery",
        "us-east-1",
        "Blocked",
        980_000,
        7,
        840,
        3100,
        0.991,
        "2026-09-18",
      ],
    },
    {
      id: "billing",
      cells: [
        "Billing worker",
        "Payments",
        "eu-north-1",
        "Ready",
        300_000,
        0,
        160,
        900,
        0.9999,
        "2026-10-08",
      ],
    },
    {
      id: "media",
      cells: [
        "Media resizer",
        "Platform",
        "us-west-2",
        "Warning",
        420_000,
        12,
        2300,
        2600,
        0.987,
        "2026-09-30",
      ],
    },
    {
      id: "notify",
      cells: [
        "Notifications",
        "Messaging",
        "eu-north-1",
        "Ready",
        150_000,
        2,
        90,
        450,
        0.9992,
        "2026-10-05",
      ],
    },
    {
      id: "export",
      cells: [
        "Export jobs",
        "Discovery",
        "us-east-1",
        "Blocked",
        12_000,
        5,
        5400,
        300,
        0.97,
        "2026-08-27",
      ],
    },
  ],
});

const tableComments = {
  openCounts: new Map([["table-services", 3]]),
  openRowCounts: new Map([
    [
      "table-services",
      new Map([
        ["search", 2],
        ["gateway", 1],
      ]),
    ],
  ]),
  onOpen: () => undefined,
};

// `?only=mockup` draws the mockups alone, `?only=flow` the funnel, radar, and
// sankey charts alone, `?only=table` the grouped and pinned table alone,
// `?only=dashboard` the two example dashboards, `?only=design` the designs,
// and `?only=layout` the tabbed design brief and a Gantt plan, so their
// capture is not a page of every chart.
const only = new URLSearchParams(window.location.search).get("only");

const layoutBlocks = [...designBriefExample, launchGanttExample].map((block) =>
  decodeCanvasBlock(block),
);

const definition =
  only === "mockup"
    ? { ...canvasFixture, blocks: mockupBlocks }
    : only === "flow"
      ? { ...canvasFixture, blocks: flowBlocks }
      : only === "table"
        ? { ...canvasFixture, blocks: [wideTable] }
        : only === "dashboard"
          ? { ...canvasFixture, blocks: dashboardBlocks }
          : only === "design"
            ? { ...canvasFixture, blocks: designBlocks }
            : only === "layout"
              ? { ...canvasFixture, blocks: layoutBlocks }
              : {
                  ...canvasFixture,
                  blocks: [
                    line,
                    bar,
                    area,
                    scatter,
                    distribution,
                    ...chartExampleBlocks,
                    budgetSankey,
                    loneRadar,
                    longFunnel,
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
                    ...dashboardBlocks,
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
      <CanvasDocument
        definition={definition}
        designAssetRuntime={harnessDesignAssets}
        {...(only === "table" ? { comments: tableComments } : {})}
      />
    </main>
  </StrictMode>,
);
