import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import {
  CanvasActor,
  CanvasBlockId,
  CanvasEdgeId,
  CanvasId,
  CanvasNodeId,
  CanvasSchemaVersion,
  CanvasSourceId,
  CanvasVersionId,
} from "./canvasIdentity";
import { CanvasActionBlock } from "./canvasActionBlock";

export * from "./canvasIdentity";
import { ChatThreadId } from "./chat";
import { CodeThreadId } from "./code";
import { WorkThreadId } from "./workThreads";
import { HostId } from "./host";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

// Canvas wire contracts are deliberately versioned independently from event
// envelopes. A decoder must reject a future version until its renderer and
// policy have been reviewed together. The current schema version is declared
// in `canvasIdentity.ts`: version 3 added the mockup block, version 4 the
// thread presentation, version 5 the treemap block, version 6 the heatmap
// block, version 7 the ranked bar-list block, version 8 the
// entity-relationship, swimlane, and mind map diagram kinds, version 9 the
// design block, version 10 the comparison matrix, version 11 the math
// block, and version 12 the mockup catalog, which the definition filters below admit only under those declared
// versions.

// These are renderer-facing aggregate limits. Per-field structural limits are
// also applied below; the domain policy re-checks the aggregate values before
// any definition can reach a renderer or persistence service.
export const CANVAS_MAX_DEPTH = 8;
export const CANVAS_MAX_BLOCKS = 128;
export const CANVAS_MAX_TEXT_BYTES = 256 * 1024;
export const CANVAS_MAX_TABLE_ROWS = 1_024;
export const CANVAS_MAX_SERIES = 64;
export const CANVAS_MAX_DIAGRAM_NODES = 512;
export const CANVAS_MAX_DIAGRAM_EDGES = 1_024;
export const CANVAS_MAX_DIAGRAM_GROUPS = 64;
export const CANVAS_MAX_IMAGES = 64;
export const CANVAS_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const CANVAS_MAX_SOURCE_ENTRIES = 128;
export const CANVAS_MAX_TABLE_COLUMNS = 64;
export const CANVAS_MAX_CHART_POINTS = 2_048;
export const CANVAS_MAX_TIMELINE_ITEMS = 512;
export const CANVAS_MAX_DIFF_HUNKS = 128;
export const CANVAS_MAX_DIFF_LINES = 4_096;
export const CANVAS_MAX_SUMMARY_ITEMS = 128;
export const CANVAS_MAX_TEXT_LENGTH = 32_768;
export const CANVAS_MAX_PLAN_PHASES = 32;
export const CANVAS_MAX_PLAN_TASKS = 256;
export const CANVAS_MAX_PLAN_TASK_DEPENDENCIES = 16;
export const CANVAS_MAX_PLAN_TASK_SOURCES = 8;
// A mockup is one screen, or a few states of it side by side. Version 3 held a
// single screen of 64 nodes at most six deep; the version-12 catalog adds
// layout containers (stack, row, grid), which cost a level each, and variants,
// which share the node budget, so a document declaring version 12 gets a
// deeper and larger tree. An older document keeps the older bounds.
export const CANVAS_MOCKUP_LEGACY_MAX_DEPTH = 6;
export const CANVAS_MOCKUP_LEGACY_MAX_NODES = 64;
export const CANVAS_MAX_MOCKUP_DEPTH = 8;
export const CANVAS_MAX_MOCKUP_NODES = 160;
export const CANVAS_MAX_MOCKUP_TEXT_LENGTH = 120;
export const CANVAS_MAX_MOCKUP_NOTE_LENGTH = 240;
export const CANVAS_MAX_MOCKUP_VARIANTS = 4;
export const CANVAS_MAX_MOCKUP_ANNOTATIONS = 12;
// A mockup table shows what a table holds, not its data: a few columns and a
// handful of rows are enough to read the shape.
export const CANVAS_MAX_MOCKUP_TABLE_COLUMNS = 6;
export const CANVAS_MAX_MOCKUP_TABLE_ROWS = 8;
export const CANVAS_MAX_MOCKUP_GRID_COLUMNS = 4;
export const CANVAS_MOCKUP_MIN_FRAME_EDGE = 240;
export const CANVAS_MOCKUP_MAX_FRAME_EDGE = 2_560;
export const CANVAS_MAX_TREEMAP_LEAVES = 4_096;
export const CANVAS_MAX_TREEMAP_DEPTH = 8;
export const CANVAS_MAX_TREEMAP_MEASURES = 8;
export const CANVAS_MAX_TREEMAP_LABEL_LENGTH = 120;
export const CANVAS_MAX_HEATMAP_ROWS = 256;
export const CANVAS_MAX_HEATMAP_COLUMNS = 256;
export const CANVAS_MAX_HEATMAP_CELLS = 16_384;
// Up to three years of days, leap days included, so a calendar heatmap can
// show a year of daily readings and a multi-year view without a silent
// truncation.
export const CANVAS_MAX_HEATMAP_DAYS = 3 * 366;
export const CANVAS_MAX_HEATMAP_NOTE_LENGTH = 120;
export const CANVAS_MAX_DESIGN_FRAMES = 24;
export const CANVAS_MAX_DESIGN_MARKUP_LENGTH = 32_768;
// A ranked list is read, not scrolled: the cap is what keeps a "hottest files"
// list from becoming the whole repository. The renderer shows a shorter top N
// and offers Show all up to this bound.
export const CANVAS_MAX_BAR_LIST_ROWS = 500;
// A metric sparkline is a glance at a recent trend, not a chart: a quarter of
// readings at a sample a day is enough, and past that the line is a smear.
export const CANVAS_MAX_METRIC_SPARKLINE_POINTS = 256;
// An entity-relationship entity is a table row set: a schema large enough to
// read still fits beside its neighbours, and past this the picture is a wall.
export const CANVAS_MAX_ER_ATTRIBUTES_PER_ENTITY = 64;
// Swimlane lanes are few and ordered; a process with more stages than this is
// a workflow chart, not a lane diagram.
export const CANVAS_MAX_SWIMLANE_LANES = 32;
// A mind map note is a remark beside a topic, not a paragraph; the cap keeps
// the tree readable when every node carries one.
export const CANVAS_MAX_MINDMAP_NOTE_LENGTH = 240;
// A comparison matrix is read across: a dozen options is already a wide table
// at phone width, and four dozen criteria is a long review. Past these the
// decision wants splitting, not a wider grid.
export const CANVAS_MAX_MATRIX_OPTIONS = 12;
export const CANVAS_MAX_MATRIX_CRITERIA = 48;
export const CANVAS_MAX_MATRIX_CELLS = CANVAS_MAX_MATRIX_OPTIONS * CANVAS_MAX_MATRIX_CRITERIA;
// A cell's text is a short reading ("EU only", "beta"); the reasoning behind it
// is a note, which is longer and is listed under the matrix.
export const CANVAS_MAX_MATRIX_CELL_TEXT_LENGTH = 120;
export const CANVAS_MAX_MATRIX_NOTE_LENGTH = 280;
// Weights are relative; a hundred is room for percentages without inviting
// figures whose size says nothing the ratio does not.
export const CANVAS_MAX_MATRIX_WEIGHT = 100;
// A formula is math markup someone reads, not a typeset paper: a thousand
// characters holds a long derivation line or a small aligned system. A
// paragraph with inline formulas is prose, so its runs share one budget the
// domain policy checks, and past these the reasoning wants several blocks.
export const CANVAS_MAX_MATH_SOURCE_LENGTH = 1_000;
export const CANVAS_MAX_MATH_RUNS = 48;
export const CANVAS_MAX_MATH_PARAGRAPH_LENGTH = 4_000;
export const CANVAS_MAX_MATH_CAPTION_LENGTH = 240;

// The schema version that introduced each version-gated block kind or hint. A
// document carrying one below the version that introduced it is a declared
// future version, not a corrupt one, so a rolled-back runtime refuses it cleanly.
export const CANVAS_MOCKUP_SCHEMA_VERSION = 3;
export const CANVAS_PRESENTATION_SCHEMA_VERSION = 4;
export const CANVAS_TREEMAP_SCHEMA_VERSION = 5;
export const CANVAS_HEATMAP_SCHEMA_VERSION = 6;
export const CANVAS_BAR_LIST_SCHEMA_VERSION = 7;
// The three remaining diagram kinds shipped as one slice and share a floor:
// they arrive together in the block catalog, so one bump admits them all.
export const CANVAS_DIAGRAM_KINDS_SCHEMA_VERSION = 8;
export const CANVAS_DESIGN_SCHEMA_VERSION = 9;
export const CANVAS_COMPARISON_MATRIX_SCHEMA_VERSION = 10;
export const CANVAS_MATH_SCHEMA_VERSION = 11;
// The mockup catalog: more devices, fidelity, the wider component set, node
// fields, variants, and callouts, and the larger node budget.
export const CANVAS_MOCKUP_CATALOG_SCHEMA_VERSION = 12;
// The metric's sparkline, goodDirection, and caption arrived with the bar list.
export const CANVAS_METRIC_TREND_SCHEMA_VERSION = 7;

/** Whether a block uses a metric field introduced at the metric-trend version. */
export function canvasMetricUsesTrendFields(block: {
  readonly kind?: unknown;
  readonly sparkline?: unknown;
  readonly goodDirection?: unknown;
  readonly caption?: unknown;
}): boolean {
  return (
    block.kind === "metric" &&
    (block.sparkline !== undefined ||
      block.goodDirection !== undefined ||
      block.caption !== undefined)
  );
}

// The version-3 mockup components and devices; everything else in the catalog
// arrived at version 12.
export const CANVAS_MOCKUP_LEGACY_COMPONENTS = [
  "window",
  "header",
  "sidebar",
  "list",
  "list-row",
  "form-field",
  "button",
  "toggle",
  "tabs",
  "card",
  "image-placeholder",
  "text",
] as const;
export const CANVAS_MOCKUP_LEGACY_DEVICES = ["desktop", "tablet", "phone"] as const;
const LEGACY_MOCKUP_COMPONENTS: ReadonlySet<unknown> = new Set(CANVAS_MOCKUP_LEGACY_COMPONENTS);
const LEGACY_MOCKUP_DEVICES: ReadonlySet<unknown> = new Set(CANVAS_MOCKUP_LEGACY_DEVICES);
const LEGACY_MOCKUP_NODE_FIELDS: ReadonlySet<string> = new Set([
  "nodeId",
  "component",
  "label",
  "parentId",
  "on",
]);

/**
 * Whether a mockup uses anything the version-12 catalog introduced: a newer
 * device, fidelity, variants, callouts, a catalog component or node field, or
 * more nodes than version 3 allowed. Reads loose fields so the share contract
 * and the domain's declared-version check can ask the same question.
 */
export function canvasMockupUsesCatalog(block: {
  readonly kind?: unknown;
  readonly device?: unknown;
  readonly size?: unknown;
  readonly fidelity?: unknown;
  readonly variants?: unknown;
  readonly annotations?: unknown;
  readonly nodes?: unknown;
}): boolean {
  if (block.kind !== "mockup") return false;
  if (!LEGACY_MOCKUP_DEVICES.has(block.device)) return true;
  if (
    block.size !== undefined ||
    block.fidelity !== undefined ||
    block.variants !== undefined ||
    block.annotations !== undefined
  ) {
    return true;
  }
  if (!Array.isArray(block.nodes)) return false;
  if (block.nodes.length > CANVAS_MOCKUP_LEGACY_MAX_NODES) return true;
  return block.nodes.some(
    (node: unknown) =>
      typeof node === "object" &&
      node !== null &&
      (!LEGACY_MOCKUP_COMPONENTS.has((node as { component?: unknown }).component) ||
        Object.keys(node).some((key) => !LEGACY_MOCKUP_NODE_FIELDS.has(key))),
  );
}

// Descriptive aliases keep budget names discoverable without creating a
// second source of truth.
export const CANVAS_MAX_ROWS = CANVAS_MAX_TABLE_ROWS;
export const CANVAS_MAX_NODE_EDGE_NODES = CANVAS_MAX_DIAGRAM_NODES;
export const CANVAS_MAX_NODE_EDGE_EDGES = CANVAS_MAX_DIAGRAM_EDGES;
export const CANVAS_MAX_PAYLOAD = CANVAS_MAX_PAYLOAD_BYTES;

export const DEFAULT_CANVAS_BUDGETS = {
  maxDepth: CANVAS_MAX_DEPTH,
  maxBlocks: CANVAS_MAX_BLOCKS,
  maxTextBytes: CANVAS_MAX_TEXT_BYTES,
  maxTableRows: CANVAS_MAX_TABLE_ROWS,
  maxSeries: CANVAS_MAX_SERIES,
  maxDiagramNodes: CANVAS_MAX_DIAGRAM_NODES,
  maxDiagramEdges: CANVAS_MAX_DIAGRAM_EDGES,
  maxImages: CANVAS_MAX_IMAGES,
  maxPayloadBytes: CANVAS_MAX_PAYLOAD_BYTES,
} as const;
export type CanvasBudgetLimits = typeof DEFAULT_CANVAS_BUDGETS;

const boundedText = (maxLength: number) => Schema.String.pipe(Schema.maxLength(maxLength));
const boundedNonEmptyText = (maxLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maxLength));
const boundedToken = <B extends string>(brand: B) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(128),
    Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    Schema.brand(brand),
  );

const FiniteNumber = Schema.Number.pipe(
  Schema.filter(Number.isFinite, { message: () => "Canvas numbers must be finite." }),
);
const CanvasText = boundedText(CANVAS_MAX_TEXT_LENGTH);
const CanvasNonEmptyText = boundedNonEmptyText(CANVAS_MAX_TEXT_LENGTH);
const CanvasLabel = boundedNonEmptyText(512);
const CanvasDisplayName = boundedNonEmptyText(256).pipe(
  Schema.filter((value) => !/[\\/]/.test(value), {
    message: () => "Canvas display names must not contain path separators.",
  }),
);
const CanvasUrl = Schema.String.pipe(
  Schema.maxLength(2_048),
  Schema.filter(
    (value) => {
      try {
        const parsed = new URL(value);
        return (
          (parsed.protocol === "http:" || parsed.protocol === "https:") &&
          parsed.username === "" &&
          parsed.password === ""
        );
      } catch {
        return false;
      }
    },
    { message: () => "Canvas links must be credential-free http(s) URLs." },
  ),
);
const CanvasOpaqueRef = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(256),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  Schema.filter((value) => !value.toLowerCase().startsWith("file:"), {
    message: () => "Canvas source references must be opaque tokens, not file URLs.",
  }),
  Schema.brand("CanvasOpaqueRef"),
);
export type CanvasOpaqueRef = typeof CanvasOpaqueRef.Type;

// ── Provenance and source manifest ──────────────────────────────────────────

const CanvasProvenanceCommon = {
  hostId: HostId,
  projectId: ProjectId,
  actor: CanvasActor,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId.pipe(Schema.maxLength(200)),
  createdAt: UtcTimestamp,
} as const;

export const CanvasProvenance = Schema.Union(
  Schema.Struct({
    ...CanvasProvenanceCommon,
    mode: Schema.Literal("chat"),
    threadId: ChatThreadId,
  }).annotations(strict),
  Schema.Struct({
    ...CanvasProvenanceCommon,
    mode: Schema.Literal("work"),
    threadId: WorkThreadId,
  }).annotations(strict),
  Schema.Struct({
    ...CanvasProvenanceCommon,
    mode: Schema.Literal("code"),
    threadId: CodeThreadId,
  }).annotations(strict),
);
export type CanvasProvenance = typeof CanvasProvenance.Type;

export const CanvasSourceKind = Schema.Literal(
  "attachment",
  "file",
  "artifact",
  "preview",
  "browser",
  "evidence",
  "image",
  "thread",
);
export type CanvasSourceKind = typeof CanvasSourceKind.Type;

export const CanvasSourceVersion = Schema.Struct({
  contentSha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  observedAt: UtcTimestamp,
}).annotations(strict);
export type CanvasSourceVersion = typeof CanvasSourceVersion.Type;

export const CanvasSourceManifestEntry = Schema.Struct({
  sourceId: CanvasSourceId,
  kind: CanvasSourceKind,
  hostId: HostId,
  projectId: ProjectId,
  opaqueRef: CanvasOpaqueRef,
  displayName: CanvasDisplayName,
  sourceVersion: Schema.optional(CanvasSourceVersion),
}).annotations(strict);
export type CanvasSourceManifestEntry = typeof CanvasSourceManifestEntry.Type;

export const CanvasSourceManifest = Schema.Array(CanvasSourceManifestEntry).pipe(
  Schema.maxItems(CANVAS_MAX_SOURCE_ENTRIES),
);
export type CanvasSourceManifest = typeof CanvasSourceManifest.Type;

// ── First-party block catalog ───────────────────────────────────────────────

const CanvasBlockFields = {
  blockId: CanvasBlockId,
  schemaVersion: CanvasSchemaVersion,
} as const;

export const CanvasBlockKind = Schema.Literal(
  "heading",
  "rich-text",
  "callout",
  "link",
  "divider",
  "citation",
  "metric",
  "progress",
  "status",
  "key-value",
  "table",
  "chart",
  "timeline",
  "diagram",
  "sequence",
  "state",
  "er",
  "swimlane",
  "mindmap",
  "code-excerpt",
  "pseudocode",
  "diff",
  "source-reference",
  "summary",
  "artifact-reference",
  "file-reference",
  "preview-reference",
  "browser-reference",
  "evidence-reference",
  "image",
  "plan",
  "mockup",
  "treemap",
  "heatmap",
  "design",
  "bar-list",
  "comparison-matrix",
  "math",
);
export type CanvasBlockKind = typeof CanvasBlockKind.Type;

export const CanvasHeadingBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("heading"),
  level: Schema.Int.pipe(Schema.between(1, 6)),
  text: CanvasNonEmptyText,
}).annotations(strict);
export type CanvasHeadingBlock = typeof CanvasHeadingBlock.Type;

export const CanvasRichTextBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("rich-text"),
  text: CanvasNonEmptyText,
}).annotations(strict);
export type CanvasRichTextBlock = typeof CanvasRichTextBlock.Type;

export const CanvasCalloutTone = Schema.Literal("info", "success", "warning", "danger");
export type CanvasCalloutTone = typeof CanvasCalloutTone.Type;

export const CanvasCalloutBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("callout"),
  tone: CanvasCalloutTone,
  title: Schema.optional(CanvasLabel),
  text: CanvasNonEmptyText,
}).annotations(strict);
export type CanvasCalloutBlock = typeof CanvasCalloutBlock.Type;

export const CanvasLinkBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("link"),
  label: CanvasLabel,
  href: CanvasUrl,
}).annotations(strict);
export type CanvasLinkBlock = typeof CanvasLinkBlock.Type;

export const CanvasDividerBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("divider"),
}).annotations(strict);
export type CanvasDividerBlock = typeof CanvasDividerBlock.Type;

export const CanvasCitationBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("citation"),
  sourceId: CanvasSourceId,
  label: CanvasLabel,
  quote: Schema.optional(CanvasText),
}).annotations(strict);
export type CanvasCitationBlock = typeof CanvasCitationBlock.Type;

/**
 * How a block presents a number.
 *
 * Absent reads as the default grouped decimal, so an author who does not care
 * gets locale grouping for free. `compact` is the short reading (1.36M),
 * `percent` reads the value as a ratio where 1 is 100%, `bytes` a base-1024
 * size, and `duration` a count of seconds. The formatter that reads this is
 * shared by charts, metrics, and tables, so one word means the same reading
 * everywhere it appears.
 */
export const CanvasNumberFormat = Schema.Literal(
  "number",
  "compact",
  "percent",
  "bytes",
  "duration",
);
export type CanvasNumberFormat = typeof CanvasNumberFormat.Type;

export const CanvasScalar = Schema.Union(CanvasText, FiniteNumber, Schema.Boolean, Schema.Null);
export type CanvasScalar = typeof CanvasScalar.Type;

/**
 * Which way a metric is good when it moves, so a delta's tone is never guessed.
 *
 * `up` means a larger reading is better (throughput), `down` a smaller one
 * (latency, failures), and `neutral` that the metric has no good side (a count
 * of open items that should simply be watched). Absent reads as neutral.
 */
export const CanvasMetricDirection = Schema.Literal("up", "down", "neutral");
export type CanvasMetricDirection = typeof CanvasMetricDirection.Type;

export const CanvasMetricBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("metric"),
  label: CanvasLabel,
  value: CanvasScalar,
  unit: Schema.optional(CanvasLabel),
  delta: Schema.optional(FiniteNumber),
  format: Schema.optional(CanvasNumberFormat),
  /**
   * A recent trend drawn beside the value. Wire numbers only; the renderer
   * reads them as one series and the static export draws the same line. The
   * array is bounded so a sparkline stays a glance rather than a chart.
   */
  sparkline: Schema.optional(
    Schema.Array(FiniteNumber).pipe(Schema.maxItems(CANVAS_MAX_METRIC_SPARKLINE_POINTS)),
  ),
  /** How a delta reads; absent means the arrow gives direction without a tone. */
  goodDirection: Schema.optional(CanvasMetricDirection),
  /** A short note under the value, e.g. "since last release". */
  caption: Schema.optional(CanvasText),
}).annotations(strict);
export type CanvasMetricBlock = typeof CanvasMetricBlock.Type;

export const CanvasProgressBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("progress"),
  label: CanvasLabel,
  value: FiniteNumber.pipe(Schema.between(0, 1)),
  detail: Schema.optional(CanvasText),
}).annotations(strict);
export type CanvasProgressBlock = typeof CanvasProgressBlock.Type;

export const CanvasStatusTone = Schema.Literal("neutral", "info", "success", "warning", "danger");
export type CanvasStatusTone = typeof CanvasStatusTone.Type;

export const CanvasStatusBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("status"),
  label: CanvasLabel,
  value: CanvasLabel,
  tone: CanvasStatusTone,
}).annotations(strict);
export type CanvasStatusBlock = typeof CanvasStatusBlock.Type;

export const CanvasKeyValueEntry = Schema.Struct({
  key: CanvasLabel,
  value: CanvasScalar,
}).annotations(strict);
export type CanvasKeyValueEntry = typeof CanvasKeyValueEntry.Type;

export const CanvasKeyValueBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("key-value"),
  entries: Schema.Array(CanvasKeyValueEntry).pipe(Schema.maxItems(CANVAS_MAX_SUMMARY_ITEMS)),
}).annotations(strict);
export type CanvasKeyValueBlock = typeof CanvasKeyValueBlock.Type;

export const CanvasTableColumnType = Schema.Literal("text", "number", "boolean", "date", "status");
export type CanvasTableColumnType = typeof CanvasTableColumnType.Type;

/**
 * How a table column draws its cells.
 *
 * Absent reads as plain text. `bar` draws an in-cell bar whose length is the
 * value's share of the column's largest reading, `heat` tints the cell on the
 * shared sequential scale, and `status` reads each value as a badge. A bar or
 * a tint is presentation only: the value is always shown, so colour never
 * carries a reading on its own, and both fall back to the plain value under
 * forced colours.
 */
export const CanvasTableColumnDisplay = Schema.Literal("text", "bar", "heat", "status");
export type CanvasTableColumnDisplay = typeof CanvasTableColumnDisplay.Type;

// `format` and `display` are additive optional presentation fields on the
// existing table kind: they refine how a value is drawn, they never change its
// order or add a block kind. The repository treated `format` this way when it
// was added to the table, metric, and chart columns, so `display` follows the
// same ungated convention. They are the documented exception to gating new
// fields: because the struct is strict, a runtime rolled back past them
// refuses a document that uses them instead of drawing it as plain text.
export const CanvasTableColumn = Schema.Struct({
  id: boundedToken("CanvasTableColumnId"),
  label: CanvasLabel,
  type: CanvasTableColumnType,
  format: Schema.optional(CanvasNumberFormat),
  display: Schema.optional(CanvasTableColumnDisplay),
}).annotations(strict);
export type CanvasTableColumn = typeof CanvasTableColumn.Type;

export const CanvasTableCell = CanvasScalar;
export type CanvasTableCell = typeof CanvasTableCell.Type;
export const CanvasTableRow = Schema.Array(CanvasTableCell).pipe(
  Schema.maxItems(CANVAS_MAX_TABLE_COLUMNS),
);
export type CanvasTableRow = typeof CanvasTableRow.Type;

export const CanvasTableBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("table"),
  columns: Schema.NonEmptyArray(CanvasTableColumn).pipe(Schema.maxItems(CANVAS_MAX_TABLE_COLUMNS)),
  rows: Schema.Array(CanvasTableRow).pipe(Schema.maxItems(CANVAS_MAX_TABLE_ROWS)),
}).annotations(strict);
export type CanvasTableBlock = typeof CanvasTableBlock.Type;

export const CanvasChartType = Schema.Literal(
  "line",
  "bar",
  "area",
  "scatter",
  "distribution",
  "pie",
  "donut",
  "stacked-bar",
  "grouped-bar",
  "bar-line",
);
export type CanvasChartType = typeof CanvasChartType.Type;

export const CanvasChartPoint = Schema.Struct({
  x: Schema.Union(FiniteNumber, CanvasText),
  y: FiniteNumber,
}).annotations(strict);
export type CanvasChartPoint = typeof CanvasChartPoint.Type;

/** Which mark a series draws on a bar-and-line chart. Other chart types omit it. */
export const CanvasChartMark = Schema.Literal("bar", "line");
export type CanvasChartMark = typeof CanvasChartMark.Type;

export const CanvasChartSeries = Schema.Struct({
  seriesId: boundedToken("CanvasSeriesId"),
  label: CanvasLabel,
  points: Schema.NonEmptyArray(CanvasChartPoint).pipe(Schema.maxItems(CANVAS_MAX_CHART_POINTS)),
  mark: Schema.optional(CanvasChartMark),
}).annotations(strict);
export type CanvasChartSeries = typeof CanvasChartSeries.Type;

/**
 * Why a chart's series do not match its type, or undefined when they do.
 *
 * A pie or donut is one series of labeled, non-negative slices. Stacked and
 * grouped bars, and a bar-and-line chart, compare series across one shared
 * category order. Only a bar-and-line chart names each series as a bar or a line.
 */
export function canvasChartSeriesIssue(block: {
  readonly chartType: string;
  readonly series: ReadonlyArray<{
    readonly points: ReadonlyArray<{ readonly x: number | string; readonly y: number }>;
    readonly mark?: CanvasChartMark | undefined;
  }>;
}): string | undefined {
  const marked = block.series.some((item) => item.mark !== undefined);
  if (block.chartType !== "bar-line" && marked) {
    return "Only a bar and line chart names a mark on its series.";
  }
  if (block.chartType === "pie" || block.chartType === "donut") {
    return partToWholeIssue(block.series);
  }
  if (
    block.chartType === "stacked-bar" ||
    block.chartType === "grouped-bar" ||
    block.chartType === "bar-line"
  ) {
    return alignedSeriesIssue(block.chartType, block.series);
  }
  return undefined;
}

function categoryKey(x: number | string): string {
  return typeof x === "number" ? `n:${String(x)}` : `s:${x}`;
}

function partToWholeIssue(
  series: ReadonlyArray<{
    readonly points: ReadonlyArray<{ readonly x: number | string; readonly y: number }>;
  }>,
): string | undefined {
  const only = series[0];
  if (series.length !== 1 || only === undefined) {
    return "A pie or donut chart needs one series of labeled slices.";
  }
  const labels = new Set<string>();
  for (const point of only.points) {
    if (typeof point.x !== "string" || point.x.trim() === "") {
      return "A pie or donut slice needs a label.";
    }
    if (!Number.isFinite(point.y) || point.y < 0) {
      return "A pie or donut slice needs a value that is not negative.";
    }
    if (labels.has(point.x)) return "A pie or donut chart lists each slice once.";
    labels.add(point.x);
  }
  return undefined;
}

function alignedSeriesIssue(
  chartType: string,
  series: ReadonlyArray<{
    readonly points: ReadonlyArray<{ readonly x: number | string; readonly y: number }>;
    readonly mark?: CanvasChartMark | undefined;
  }>,
): string | undefined {
  if (series.length < 2) {
    return "This chart needs at least two series that share categories.";
  }
  if (chartType === "bar-line") {
    if (series.some((item) => item.mark === undefined)) {
      return "A bar and line chart names each series as a bar or a line.";
    }
    const marks = new Set(series.map((item) => item.mark));
    if (!marks.has("bar") || !marks.has("line")) {
      return "A bar and line chart needs at least one bar series and one line series.";
    }
  }
  const first = series[0];
  if (first === undefined) return "This chart needs at least two series that share categories.";
  const keys = first.points.map((point) => categoryKey(point.x));
  if (new Set(keys).size !== keys.length) return "Each series lists a category once.";
  for (const item of series) {
    const itemKeys = item.points.map((point) => categoryKey(point.x));
    if (itemKeys.length !== keys.length || itemKeys.some((key, index) => key !== keys[index])) {
      return "Every series lists the same categories in the same order.";
    }
    if (chartType === "stacked-bar") {
      for (const point of item.points) {
        if (!Number.isFinite(point.y) || point.y < 0) {
          return "A stacked bar value is not negative.";
        }
      }
    }
  }
  return undefined;
}

export const CanvasChartBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("chart"),
  chartType: CanvasChartType,
  series: Schema.Array(CanvasChartSeries).pipe(Schema.maxItems(CANVAS_MAX_SERIES)),
  /** How numeric axis values and readings read; absent groups by locale. */
  format: Schema.optional(CanvasNumberFormat),
})
  .annotations(strict)
  .pipe(
    Schema.filter((block) => canvasChartSeriesIssue(block) === undefined, {
      message: () => "Chart series do not match the chart type.",
    }),
  );
export type CanvasChartBlock = typeof CanvasChartBlock.Type;

/**
 * How a treemap colours its cells.
 *
 * `categorical` assigns a hue per top-level group; `sequential` and
 * `diverging` read the colour measure as an ordered value. Diverging centres
 * on the mid-point of the colour domain, so a reading above the middle takes
 * the positive family and one below it the negative family.
 */
export const CanvasTreemapScale = Schema.Literal("sequential", "diverging", "categorical");
export type CanvasTreemapScale = typeof CanvasTreemapScale.Type;

export const CanvasTreemapMeasureId = boundedToken("CanvasTreemapMeasureId");
export type CanvasTreemapMeasureId = typeof CanvasTreemapMeasureId.Type;

export const CanvasTreemapMeasure = Schema.Struct({
  measureId: CanvasTreemapMeasureId,
  label: CanvasLabel,
  format: Schema.optional(CanvasNumberFormat),
}).annotations(strict);
export type CanvasTreemapMeasure = typeof CanvasTreemapMeasure.Type;

/**
 * One node of a treemap hierarchy.
 *
 * A node names its parent rather than nesting its children: a nested tree at
 * the leaf budget would land past the Canvas depth budget before a repository
 * has named its packages. Values sit on leaves; a group's reading is the sum
 * of its children, so the picture never states a total the leaves do not.
 */
export const CanvasTreemapNode = Schema.Struct({
  nodeId: CanvasNodeId,
  parentId: Schema.optional(CanvasNodeId),
  label: boundedNonEmptyText(CANVAS_MAX_TREEMAP_LABEL_LENGTH),
  /** A leaf may name a manifest source; the host reauthorizes opening it. */
  sourceId: Schema.optional(CanvasSourceId),
  /** The leaf's value for each declared measure. Groups carry none. */
  values: Schema.optional(Schema.Record({ key: CanvasTreemapMeasureId, value: FiniteNumber })),
}).annotations(strict);
export type CanvasTreemapNode = typeof CanvasTreemapNode.Type;

export const CanvasTreemapBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("treemap"),
  nodes: Schema.Array(CanvasTreemapNode).pipe(Schema.maxItems(CANVAS_MAX_TREEMAP_LEAVES)),
  measures: Schema.NonEmptyArray(CanvasTreemapMeasure).pipe(
    Schema.maxItems(CANVAS_MAX_TREEMAP_MEASURES),
  ),
  /** The measure rectangles are sized by when the block first draws. */
  sizeBy: CanvasTreemapMeasureId,
  /** The measure cells are coloured by when the block first draws. */
  colorBy: CanvasTreemapMeasureId,
  colorScale: Schema.optional(CanvasTreemapScale),
  /** The node a static export starts from; absent draws the whole hierarchy. */
  startNodeId: Schema.optional(CanvasNodeId),
}).annotations(strict);
export type CanvasTreemapBlock = typeof CanvasTreemapBlock.Type;

/**
 * A grid coloured by value.
 *
 * A matrix names its rows and columns and carries a sparse cell per
 * coordinate; a calendar carries one reading per date. Both read a value
 * through the shared scale roles (`sequential` or `diverging`), and both draw
 * a missing coordinate apart from a zero: an absent cell is not a reading of
 * nothing.
 */
export const CanvasHeatmapScale = Schema.Literal("sequential", "diverging");
export type CanvasHeatmapScale = typeof CanvasHeatmapScale.Type;

export const CanvasHeatmapLayout = Schema.Literal("matrix", "calendar");
export type CanvasHeatmapLayout = typeof CanvasHeatmapLayout.Type;

export const CanvasHeatmapRowId = boundedToken("CanvasHeatmapRowId");
export type CanvasHeatmapRowId = typeof CanvasHeatmapRowId.Type;
export const CanvasHeatmapColumnId = boundedToken("CanvasHeatmapColumnId");
export type CanvasHeatmapColumnId = typeof CanvasHeatmapColumnId.Type;

export const CanvasHeatmapRow = Schema.Struct({
  rowId: CanvasHeatmapRowId,
  label: CanvasLabel,
}).annotations(strict);
export type CanvasHeatmapRow = typeof CanvasHeatmapRow.Type;

export const CanvasHeatmapColumn = Schema.Struct({
  columnId: CanvasHeatmapColumnId,
  label: CanvasLabel,
}).annotations(strict);
export type CanvasHeatmapColumn = typeof CanvasHeatmapColumn.Type;

const CanvasHeatmapNote = boundedText(CANVAS_MAX_HEATMAP_NOTE_LENGTH);

/**
 * One coloured reading at a row and column.
 *
 * A cell names its axes by id rather than by index, so the picture keeps the
 * author's labels when rows are sorted by total as view state, and a
 * coordinate that is not listed reads as missing rather than as zero.
 */
export const CanvasHeatmapCell = Schema.Struct({
  rowId: CanvasHeatmapRowId,
  columnId: CanvasHeatmapColumnId,
  value: FiniteNumber,
  note: Schema.optional(CanvasHeatmapNote),
}).annotations(strict);
export type CanvasHeatmapCell = typeof CanvasHeatmapCell.Type;

/** A calendar date as `YYYY-MM-DD`; a rolled-over value such as 2026-02-30 fails. */
export const CanvasHeatmapDate = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.filter(
    (value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    },
    { message: () => "A heatmap date must be a real calendar date." },
  ),
);
export type CanvasHeatmapDate = typeof CanvasHeatmapDate.Type;

export const CanvasHeatmapDay = Schema.Struct({
  date: CanvasHeatmapDate,
  value: FiniteNumber,
  note: Schema.optional(CanvasHeatmapNote),
}).annotations(strict);
export type CanvasHeatmapDay = typeof CanvasHeatmapDay.Type;

const CanvasHeatmapFields = {
  ...CanvasBlockFields,
  kind: Schema.Literal("heatmap"),
  /** The reading's name, shown on the legend and in the tooltip. */
  valueLabel: Schema.optional(CanvasLabel),
  /** How each reading reads; absent groups by locale. */
  format: Schema.optional(CanvasNumberFormat),
  scale: Schema.optional(CanvasHeatmapScale),
} as const;

export const CanvasHeatmapMatrixBlock = Schema.Struct({
  ...CanvasHeatmapFields,
  layout: Schema.Literal("matrix"),
  rows: Schema.NonEmptyArray(CanvasHeatmapRow).pipe(Schema.maxItems(CANVAS_MAX_HEATMAP_ROWS)),
  columns: Schema.NonEmptyArray(CanvasHeatmapColumn).pipe(
    Schema.maxItems(CANVAS_MAX_HEATMAP_COLUMNS),
  ),
  cells: Schema.Array(CanvasHeatmapCell).pipe(Schema.maxItems(CANVAS_MAX_HEATMAP_CELLS)),
}).annotations(strict);
export type CanvasHeatmapMatrixBlock = typeof CanvasHeatmapMatrixBlock.Type;

export const CanvasHeatmapCalendarBlock = Schema.Struct({
  ...CanvasHeatmapFields,
  layout: Schema.Literal("calendar"),
  days: Schema.NonEmptyArray(CanvasHeatmapDay).pipe(Schema.maxItems(CANVAS_MAX_HEATMAP_DAYS)),
}).annotations(strict);
export type CanvasHeatmapCalendarBlock = typeof CanvasHeatmapCalendarBlock.Type;

export const CanvasHeatmapBlock = Schema.Union(
  CanvasHeatmapMatrixBlock,
  CanvasHeatmapCalendarBlock,
);
export type CanvasHeatmapBlock = typeof CanvasHeatmapBlock.Type;

/**
 * How a bar list colours its bars.
 *
 * `neutral` draws every bar in the same ink, which is right when the ranking
 * itself is the point; `sequential` reads each bar's length through the shared
 * scale, which is right when the magnitude is. Absent reads as neutral.
 */
export const CanvasBarListScale = Schema.Literal("neutral", "sequential");
export type CanvasBarListScale = typeof CanvasBarListScale.Type;

/**
 * One ranked entry: a name, its magnitude, and an optional second reading.
 *
 * The label may be a path, which the renderer draws in the shared path style;
 * when the row names a manifest `sourceId`, it also offers Open file through
 * the allowlisted open-source action. Values are magnitudes, so a negative
 * value is refused: a bar's length cannot be less than none.
 */
export const CanvasBarListRow = Schema.Struct({
  label: CanvasLabel,
  value: FiniteNumber,
  secondaryValue: Schema.optional(FiniteNumber),
  sourceId: Schema.optional(CanvasSourceId),
}).annotations(strict);
export type CanvasBarListRow = typeof CanvasBarListRow.Type;

export const CanvasBarListBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("bar-list"),
  rows: Schema.NonEmptyArray(CanvasBarListRow).pipe(Schema.maxItems(CANVAS_MAX_BAR_LIST_ROWS)),
  /** The reading's name, shown in the tooltip and the table header. */
  valueLabel: Schema.optional(CanvasLabel),
  /** The second reading's name, when rows carry one. */
  secondaryLabel: Schema.optional(CanvasLabel),
  /** How each value reads; absent groups by locale. */
  format: Schema.optional(CanvasNumberFormat),
  /** How the second reading reads; defaults to the primary format. */
  secondaryFormat: Schema.optional(CanvasNumberFormat),
  scale: Schema.optional(CanvasBarListScale),
}).annotations(strict);
export type CanvasBarListBlock = typeof CanvasBarListBlock.Type;

/**
 * A comparison or decision matrix: options as columns, criteria as rows.
 *
 * Options and criteria take node identifiers so a comment can anchor to a
 * column or a row through the existing node anchor; the board contract has no
 * cell coordinate, so a cell is commented on through its row or column. A cell
 * names its coordinate by id, so a reader may reorder the options by their
 * weighted score as view state without moving a reading to another option.
 */
export const CanvasMatrixOptionId = CanvasNodeId;
export const CanvasMatrixCriterionId = CanvasNodeId;

const CanvasMatrixNote = boundedText(CANVAS_MAX_MATRIX_NOTE_LENGTH);

export const CanvasMatrixOption = Schema.Struct({
  optionId: CanvasMatrixOptionId,
  label: CanvasLabel,
  /** A short line under the option's name, e.g. "managed, EU region". */
  detail: Schema.optional(CanvasMatrixNote),
}).annotations(strict);
export type CanvasMatrixOption = typeof CanvasMatrixOption.Type;

/**
 * Which end of a criterion is good. `lower` turns the reading round before it
 * counts toward a weighted score, so a low cost or a "no" on lock-in scores
 * well. Absent reads as higher.
 */
export const CanvasMatrixPreference = Schema.Literal("higher", "lower");
export type CanvasMatrixPreference = typeof CanvasMatrixPreference.Type;

export const CanvasMatrixCriterion = Schema.Struct({
  criterionId: CanvasMatrixCriterionId,
  label: CanvasLabel,
  /** Relative importance; absent counts as 1, and 0 keeps the row out of the score. */
  weight: Schema.optional(FiniteNumber.pipe(Schema.between(0, CANVAS_MAX_MATRIX_WEIGHT))),
  prefer: Schema.optional(CanvasMatrixPreference),
  detail: Schema.optional(CanvasMatrixNote),
}).annotations(strict);
export type CanvasMatrixCriterion = typeof CanvasMatrixCriterion.Type;

export const CanvasMatrixGlyph = Schema.Literal("yes", "partial", "no");
export type CanvasMatrixGlyph = typeof CanvasMatrixGlyph.Type;

const CanvasMatrixCellCoordinate = {
  criterionId: CanvasMatrixCriterionId,
  optionId: CanvasMatrixOptionId,
  /** Why the cell reads as it does; listed under the matrix, numbered. */
  note: Schema.optional(CanvasMatrixNote),
} as const;

// One reading per cell: a score, a short text, or a yes / partial / no glyph.
// Each shape is strict, so a cell carrying two readings matches none of them
// and is refused rather than drawn as whichever the decoder tried first.
export const CanvasMatrixScoreCell = Schema.Struct({
  ...CanvasMatrixCellCoordinate,
  score: FiniteNumber,
}).annotations(strict);
export const CanvasMatrixTextCell = Schema.Struct({
  ...CanvasMatrixCellCoordinate,
  text: boundedNonEmptyText(CANVAS_MAX_MATRIX_CELL_TEXT_LENGTH),
}).annotations(strict);
export const CanvasMatrixGlyphCell = Schema.Struct({
  ...CanvasMatrixCellCoordinate,
  glyph: CanvasMatrixGlyph,
}).annotations(strict);
export const CanvasMatrixCell = Schema.Union(
  CanvasMatrixScoreCell,
  CanvasMatrixTextCell,
  CanvasMatrixGlyphCell,
);
export type CanvasMatrixCell = typeof CanvasMatrixCell.Type;

/** The scale scores are read on, e.g. 1 to 5. Absent spans zero to the largest score. */
export const CanvasMatrixScoreRange = Schema.Struct({
  min: FiniteNumber,
  max: FiniteNumber,
})
  .annotations(strict)
  .pipe(
    Schema.filter((range) => range.min < range.max, {
      message: () => "A comparison matrix score range must run from a lower to a higher score.",
    }),
  );
export type CanvasMatrixScoreRange = typeof CanvasMatrixScoreRange.Type;

export const CanvasComparisonMatrixBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("comparison-matrix"),
  options: Schema.NonEmptyArray(CanvasMatrixOption).pipe(
    Schema.maxItems(CANVAS_MAX_MATRIX_OPTIONS),
  ),
  criteria: Schema.NonEmptyArray(CanvasMatrixCriterion).pipe(
    Schema.maxItems(CANVAS_MAX_MATRIX_CRITERIA),
  ),
  cells: Schema.Array(CanvasMatrixCell).pipe(Schema.maxItems(CANVAS_MAX_MATRIX_CELLS)),
  scoreRange: Schema.optional(CanvasMatrixScoreRange),
  /** The option the author recommends; drawn apart, never inferred from the scores. */
  recommendedOptionId: Schema.optional(CanvasMatrixOptionId),
  /** Why the recommended option, in a sentence or two. */
  recommendation: Schema.optional(boundedText(CANVAS_MAX_MATRIX_NOTE_LENGTH * 2)),
}).annotations(strict);
export type CanvasComparisonMatrixBlock = typeof CanvasComparisonMatrixBlock.Type;

/**
 * Math written in a TeX-like markup subset and drawn, never run.
 *
 * `display` is one formula set on its own line, with an optional caption that
 * names it for a reader who hears it rather than sees it. `inline` is a
 * paragraph of prose runs and formula runs, so a sentence can carry `x^2`
 * without the whole sentence becoming markup. The source is the reading: it
 * is what export writes, what an assistive reader can reach beside the drawn
 * MathML, and what a reader sees when a formula cannot be drawn. The domain
 * policy refuses the commands that would define macros, link, embed, or
 * recolour, so a formula cannot carry behaviour or step outside the theme.
 */
const CanvasMathSource = boundedNonEmptyText(CANVAS_MAX_MATH_SOURCE_LENGTH);

export const CanvasMathDisplayBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("math"),
  layout: Schema.Literal("display"),
  source: CanvasMathSource,
  /** What the formula is, e.g. "Bayes' theorem"; drawn under it and read first. */
  caption: Schema.optional(boundedNonEmptyText(CANVAS_MAX_MATH_CAPTION_LENGTH)),
}).annotations(strict);
export type CanvasMathDisplayBlock = typeof CanvasMathDisplayBlock.Type;

// One run is either prose or a formula. Each shape is strict, so a run naming
// both reads as neither and is refused rather than drawn as whichever matched.
// Prose keeps its edge spaces: they are what separate a word from the formula
// beside it, so a prose run need only hold something other than whitespace.
export const CanvasMathTextRun = Schema.Struct({
  text: boundedText(CANVAS_MAX_MATH_PARAGRAPH_LENGTH).pipe(
    Schema.filter((value) => value.trim().length > 0, {
      message: () => "A math paragraph's prose run must not be blank.",
    }),
  ),
}).annotations(strict);
export const CanvasMathFormulaRun = Schema.Struct({
  math: CanvasMathSource,
}).annotations(strict);
export const CanvasMathRun = Schema.Union(CanvasMathTextRun, CanvasMathFormulaRun);
export type CanvasMathRun = typeof CanvasMathRun.Type;

export const CanvasMathInlineBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("math"),
  layout: Schema.Literal("inline"),
  runs: Schema.NonEmptyArray(CanvasMathRun).pipe(Schema.maxItems(CANVAS_MAX_MATH_RUNS)),
}).annotations(strict);
export type CanvasMathInlineBlock = typeof CanvasMathInlineBlock.Type;

export type CanvasMathBlock = CanvasMathDisplayBlock | CanvasMathInlineBlock;

export const CanvasTimelineItem = Schema.Struct({
  itemId: boundedToken("CanvasTimelineItemId"),
  title: CanvasLabel,
  startAt: UtcTimestamp,
  endAt: Schema.optional(UtcTimestamp),
  status: Schema.optional(CanvasStatusTone),
  detail: Schema.optional(CanvasText),
}).annotations(strict);
export type CanvasTimelineItem = typeof CanvasTimelineItem.Type;

export const CanvasTimelineBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("timeline"),
  items: Schema.Array(CanvasTimelineItem).pipe(Schema.maxItems(CANVAS_MAX_TIMELINE_ITEMS)),
}).annotations(strict);
export type CanvasTimelineBlock = typeof CanvasTimelineBlock.Type;

// Diagram v2 fields: a node may carry an explicit user or agent placement, and
// a diagram may declare whether its layout is authoritative (manual) or
// generated (auto). Layout revisions mint a new immutable Canvas version with
// the authoring actor recorded in provenance.
export const CanvasDiagramNode = Schema.Struct({
  nodeId: CanvasNodeId,
  label: CanvasLabel,
  role: Schema.optional(boundedToken("CanvasNodeRole")),
  x: Schema.optional(FiniteNumber),
  y: Schema.optional(FiniteNumber),
  positioned: Schema.optional(Schema.Literal(true)),
}).annotations(strict);
export type CanvasDiagramNode = typeof CanvasDiagramNode.Type;

export const CanvasDiagramLayoutKind = Schema.Literal("auto", "manual");
export type CanvasDiagramLayoutKind = typeof CanvasDiagramLayoutKind.Type;

export const CanvasDiagramEdge = Schema.Struct({
  edgeId: CanvasEdgeId,
  source: CanvasNodeId,
  target: CanvasNodeId,
  label: Schema.optional(CanvasLabel),
}).annotations(strict);
export type CanvasDiagramEdge = typeof CanvasDiagramEdge.Type;

/**
 * A named box drawn around some of a diagram's nodes.
 *
 * Groups are what turn a graph into an architecture sketch: the boundary
 * between a client and a server is the point of the drawing, not decoration on
 * top of it. A node may sit in at most one group, so the boundary a reader sees
 * is the one the author meant.
 */
export const CanvasDiagramGroup = Schema.Struct({
  groupId: boundedToken("CanvasGroupId"),
  label: CanvasLabel,
  nodeIds: Schema.Array(CanvasNodeId).pipe(Schema.maxItems(CANVAS_MAX_DIAGRAM_NODES)),
}).annotations(strict);
export type CanvasDiagramGroup = typeof CanvasDiagramGroup.Type;

/** Which way the diagram reads. Layout follows it; it is never inferred. */
export const CanvasDiagramFlow = Schema.Literal("down", "right");
export type CanvasDiagramFlow = typeof CanvasDiagramFlow.Type;

export const CanvasDiagramBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("diagram"),
  nodes: Schema.Array(CanvasDiagramNode).pipe(Schema.maxItems(CANVAS_MAX_DIAGRAM_NODES)),
  edges: Schema.Array(CanvasDiagramEdge).pipe(Schema.maxItems(CANVAS_MAX_DIAGRAM_EDGES)),
  groups: Schema.optional(
    Schema.Array(CanvasDiagramGroup).pipe(Schema.maxItems(CANVAS_MAX_DIAGRAM_GROUPS)),
  ),
  flow: Schema.optional(CanvasDiagramFlow),
  layout: Schema.optional(CanvasDiagramLayoutKind),
}).annotations(strict);
export type CanvasDiagramBlock = typeof CanvasDiagramBlock.Type;

/**
 * A sequence diagram beside the generic node/edge board.
 *
 * Participants and messages use the board's node and edge identifiers so a
 * comment can anchor to either. Activations span messages in order on one
 * participant's lifeline. Notes are annotations, not a second graph. The
 * arrays are bounded by the diagram budgets: participants are nodes, messages
 * are edges, notes are groups.
 */
export const CanvasSequenceParticipant = Schema.Struct({
  participantId: CanvasNodeId,
  label: CanvasLabel,
}).annotations(strict);
export type CanvasSequenceParticipant = typeof CanvasSequenceParticipant.Type;

export const CanvasSequenceMessage = Schema.Struct({
  messageId: CanvasEdgeId,
  from: CanvasNodeId,
  to: CanvasNodeId,
  label: CanvasLabel,
}).annotations(strict);
export type CanvasSequenceMessage = typeof CanvasSequenceMessage.Type;

export const CanvasSequenceActivation = Schema.Struct({
  activationId: boundedToken("CanvasActivationId"),
  participantId: CanvasNodeId,
  startMessageId: CanvasEdgeId,
  endMessageId: CanvasEdgeId,
}).annotations(strict);
export type CanvasSequenceActivation = typeof CanvasSequenceActivation.Type;

export const CanvasSequenceNote = Schema.Struct({
  noteId: boundedToken("CanvasNoteId"),
  text: CanvasLabel,
  participantId: Schema.optional(CanvasNodeId),
  afterMessageId: Schema.optional(CanvasEdgeId),
}).annotations(strict);
export type CanvasSequenceNote = typeof CanvasSequenceNote.Type;

export const CanvasSequenceBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("sequence"),
  participants: Schema.Array(CanvasSequenceParticipant).pipe(
    Schema.maxItems(CANVAS_MAX_DIAGRAM_NODES),
  ),
  messages: Schema.Array(CanvasSequenceMessage).pipe(Schema.maxItems(CANVAS_MAX_DIAGRAM_EDGES)),
  activations: Schema.optional(
    Schema.Array(CanvasSequenceActivation).pipe(Schema.maxItems(CANVAS_MAX_DIAGRAM_NODES)),
  ),
  notes: Schema.optional(
    Schema.Array(CanvasSequenceNote).pipe(Schema.maxItems(CANVAS_MAX_DIAGRAM_GROUPS)),
  ),
}).annotations(strict);
export type CanvasSequenceBlock = typeof CanvasSequenceBlock.Type;

/**
 * A state diagram beside the generic node/edge board.
 *
 * Nesting is a parent id rather than a nested object, so a transition list
 * stays inside the Canvas depth budget. States are nodes and transitions are
 * edges, under the same budgets as a board. A transition names itself; an
 * initial or final state is a role, not a second block.
 */
export const CanvasStateRole = Schema.Literal("initial", "final");
export type CanvasStateRole = typeof CanvasStateRole.Type;

export const CanvasStateNode = Schema.Struct({
  stateId: CanvasNodeId,
  label: CanvasLabel,
  role: Schema.optional(CanvasStateRole),
  parentId: Schema.optional(CanvasNodeId),
}).annotations(strict);
export type CanvasStateNode = typeof CanvasStateNode.Type;

export const CanvasStateTransition = Schema.Struct({
  transitionId: CanvasEdgeId,
  source: CanvasNodeId,
  target: CanvasNodeId,
  label: CanvasLabel,
}).annotations(strict);
export type CanvasStateTransition = typeof CanvasStateTransition.Type;

export const CanvasStateBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("state"),
  states: Schema.Array(CanvasStateNode).pipe(Schema.maxItems(CANVAS_MAX_DIAGRAM_NODES)),
  transitions: Schema.Array(CanvasStateTransition).pipe(Schema.maxItems(CANVAS_MAX_DIAGRAM_EDGES)),
}).annotations(strict);
export type CanvasStateBlock = typeof CanvasStateBlock.Type;

/**
 * How many of one thing sit at one end of a relationship.
 *
 * The four cardinalities a data model needs: exactly one, at most one, any
 * number, and one or more. They are named rather than drawn as a number so the
 * picture and the export read the same word, and a rolled-back runtime that
 * never learned a new value still refuses it as a corrupt document.
 */
export const CanvasErCardinality = Schema.Literal("one", "zero-or-one", "many", "one-or-many");
export type CanvasErCardinality = typeof CanvasErCardinality.Type;

export const CanvasErAttribute = Schema.Struct({
  attributeId: boundedToken("CanvasErAttributeId"),
  name: CanvasLabel,
  /** The attribute's type, e.g. `uuid` or `text`. Free text, not a type system. */
  type: CanvasLabel,
  /** Whether the attribute is (part of) the entity's key. Absent reads as false. */
  key: Schema.optional(Schema.Literal(true)),
}).annotations(strict);
export type CanvasErAttribute = typeof CanvasErAttribute.Type;

/** An entity and its named attributes. Attributes nest one level, never deeper. */
export const CanvasErEntity = Schema.Struct({
  entityId: CanvasNodeId,
  label: CanvasLabel,
  attributes: Schema.Array(CanvasErAttribute).pipe(
    Schema.maxItems(CANVAS_MAX_ER_ATTRIBUTES_PER_ENTITY),
  ),
}).annotations(strict);
export type CanvasErEntity = typeof CanvasErEntity.Type;

/**
 * A relationship between two entities.
 *
 * Cardinality is named at each end, so a reader never has to infer "one to
 * many" from an arrow head the drawing happens to use. The label is optional;
 * a relationship without one is still a relationship.
 */
export const CanvasErRelationship = Schema.Struct({
  relationshipId: CanvasEdgeId,
  source: CanvasNodeId,
  target: CanvasNodeId,
  sourceCardinality: CanvasErCardinality,
  targetCardinality: CanvasErCardinality,
  label: Schema.optional(CanvasLabel),
}).annotations(strict);
export type CanvasErRelationship = typeof CanvasErRelationship.Type;

export const CanvasErBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("er"),
  entities: Schema.Array(CanvasErEntity).pipe(Schema.maxItems(CANVAS_MAX_DIAGRAM_NODES)),
  relationships: Schema.Array(CanvasErRelationship).pipe(Schema.maxItems(CANVAS_MAX_DIAGRAM_EDGES)),
}).annotations(strict);
export type CanvasErBlock = typeof CanvasErBlock.Type;

/** Who owns a lane: a person or role (`actor`) or a group (`team`). */
export const CanvasSwimlaneKind = Schema.Literal("actor", "team");
export type CanvasSwimlaneKind = typeof CanvasSwimlaneKind.Type;

/** A lane, ordered by its position in the block. Absent kind reads as `actor`. */
export const CanvasSwimlaneLane = Schema.Struct({
  laneId: boundedToken("CanvasSwimlaneLaneId"),
  label: CanvasLabel,
  kind: Schema.optional(CanvasSwimlaneKind),
}).annotations(strict);
export type CanvasSwimlaneLane = typeof CanvasSwimlaneLane.Type;

/**
 * A step in a lane. A decision step is a step with a branch, named as a flag
 * rather than a second block kind so the lane order is unaffected.
 */
export const CanvasSwimlaneStep = Schema.Struct({
  stepId: CanvasNodeId,
  laneId: boundedToken("CanvasSwimlaneLaneId"),
  label: CanvasLabel,
  decision: Schema.optional(Schema.Literal(true)),
}).annotations(strict);
export type CanvasSwimlaneStep = typeof CanvasSwimlaneStep.Type;

export const CanvasSwimlaneConnection = Schema.Struct({
  connectionId: CanvasEdgeId,
  source: CanvasNodeId,
  target: CanvasNodeId,
  label: Schema.optional(CanvasLabel),
}).annotations(strict);
export type CanvasSwimlaneConnection = typeof CanvasSwimlaneConnection.Type;

export const CanvasSwimlaneBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("swimlane"),
  lanes: Schema.NonEmptyArray(CanvasSwimlaneLane).pipe(Schema.maxItems(CANVAS_MAX_SWIMLANE_LANES)),
  steps: Schema.Array(CanvasSwimlaneStep).pipe(Schema.maxItems(CANVAS_MAX_DIAGRAM_NODES)),
  connections: Schema.Array(CanvasSwimlaneConnection).pipe(
    Schema.maxItems(CANVAS_MAX_DIAGRAM_EDGES),
  ),
}).annotations(strict);
export type CanvasSwimlaneBlock = typeof CanvasSwimlaneBlock.Type;

const CanvasMindmapNote = boundedText(CANVAS_MAX_MINDMAP_NOTE_LENGTH);

/**
 * One topic of a mind map.
 *
 * A topic names its parent rather than nesting: a nested tree would land past
 * the Canvas depth budget before a map named its branches. Exactly one topic
 * has no parent — the root — and the parent chain never loops.
 */
export const CanvasMindmapNode = Schema.Struct({
  nodeId: CanvasNodeId,
  label: CanvasLabel,
  parentId: Schema.optional(CanvasNodeId),
  note: Schema.optional(CanvasMindmapNote),
}).annotations(strict);
export type CanvasMindmapNode = typeof CanvasMindmapNode.Type;

export const CanvasMindmapBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("mindmap"),
  nodes: Schema.Array(CanvasMindmapNode).pipe(Schema.maxItems(CANVAS_MAX_DIAGRAM_NODES)),
}).annotations(strict);
export type CanvasMindmapBlock = typeof CanvasMindmapBlock.Type;

const CanvasLineNumber = Schema.Int.pipe(Schema.positive());

export const CanvasCodeExcerptBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("code-excerpt"),
  language: boundedToken("CanvasLanguage"),
  code: CanvasNonEmptyText,
  sourceId: Schema.optional(CanvasSourceId),
  startLine: Schema.optional(CanvasLineNumber),
  endLine: Schema.optional(CanvasLineNumber),
}).annotations(strict);
export type CanvasCodeExcerptBlock = typeof CanvasCodeExcerptBlock.Type;

export const CanvasPseudocodeBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("pseudocode"),
  code: CanvasNonEmptyText,
}).annotations(strict);
export type CanvasPseudocodeBlock = typeof CanvasPseudocodeBlock.Type;

export const CanvasDiffLine = Schema.Struct({
  kind: Schema.Literal("add", "remove", "context"),
  text: CanvasText,
}).annotations(strict);
export type CanvasDiffLine = typeof CanvasDiffLine.Type;

export const CanvasDiffHunk = Schema.Struct({
  header: CanvasLabel,
  lines: Schema.Array(CanvasDiffLine).pipe(Schema.maxItems(CANVAS_MAX_DIFF_LINES)),
}).annotations(strict);
export type CanvasDiffHunk = typeof CanvasDiffHunk.Type;

export const CanvasDiffBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("diff"),
  sourceId: Schema.optional(CanvasSourceId),
  hunks: Schema.Array(CanvasDiffHunk).pipe(Schema.maxItems(CANVAS_MAX_DIFF_HUNKS)),
}).annotations(strict);
export type CanvasDiffBlock = typeof CanvasDiffBlock.Type;

export const CanvasSourceReferenceBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("source-reference"),
  sourceId: CanvasSourceId,
  label: CanvasLabel,
  detail: Schema.optional(CanvasText),
}).annotations(strict);
export type CanvasSourceReferenceBlock = typeof CanvasSourceReferenceBlock.Type;

export const CanvasSummaryKind = Schema.Literal(
  "task",
  "thread",
  "subagent",
  "provider",
  "model",
  "usage",
  "test",
  "pull-request",
);
export type CanvasSummaryKind = typeof CanvasSummaryKind.Type;

export const CanvasSummaryItem = Schema.Struct({
  label: CanvasLabel,
  value: Schema.optional(CanvasScalar),
  status: Schema.optional(CanvasStatusTone),
}).annotations(strict);
export type CanvasSummaryItem = typeof CanvasSummaryItem.Type;

export const CanvasSummaryBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("summary"),
  summaryKind: CanvasSummaryKind,
  title: CanvasLabel,
  items: Schema.Array(CanvasSummaryItem).pipe(Schema.maxItems(CANVAS_MAX_SUMMARY_ITEMS)),
}).annotations(strict);
export type CanvasSummaryBlock = typeof CanvasSummaryBlock.Type;

// A plan is phases of tasks that the person and the agent both work in. A
// task's links are manifest source ids (a thread, PR, file, or source the
// Canvas already declares), never free paths or URLs, so a plan carries no
// authority the manifest does not. `view` is the author's preferred view; a
// reader may switch it without revising the Canvas.
//
// Tasks sit in one list that names each task's phase rather than nesting
// inside phases: nested, a task's dependency list lands past the Canvas depth
// budget the policy enforces on every version envelope.
export const CanvasPlanTaskStatus = Schema.Literal("todo", "doing", "blocked", "done");
export type CanvasPlanTaskStatus = typeof CanvasPlanTaskStatus.Type;

export const CanvasPlanView = Schema.Literal("checklist", "kanban", "timeline");
export type CanvasPlanView = typeof CanvasPlanView.Type;

export const CanvasPlanOwner = Schema.Struct({
  kind: Schema.Literal("person", "agent"),
  label: Schema.optional(CanvasLabel),
}).annotations(strict);
export type CanvasPlanOwner = typeof CanvasPlanOwner.Type;

export const CanvasPlanTaskId = boundedToken("CanvasPlanTaskId");
export type CanvasPlanTaskId = typeof CanvasPlanTaskId.Type;

export const CanvasPlanPhaseId = boundedToken("CanvasPlanPhaseId");
export type CanvasPlanPhaseId = typeof CanvasPlanPhaseId.Type;

export const CanvasPlanPhase = Schema.Struct({
  phaseId: CanvasPlanPhaseId,
  title: CanvasLabel,
}).annotations(strict);
export type CanvasPlanPhase = typeof CanvasPlanPhase.Type;

export const CanvasPlanTask = Schema.Struct({
  taskId: CanvasPlanTaskId,
  phaseId: CanvasPlanPhaseId,
  title: CanvasLabel,
  status: CanvasPlanTaskStatus,
  owner: Schema.optional(CanvasPlanOwner),
  estimate: Schema.optional(boundedNonEmptyText(64)),
  /** Acceptance notes: what done means for this task. */
  notes: Schema.optional(CanvasText),
  startAt: Schema.optional(UtcTimestamp),
  dueAt: Schema.optional(UtcTimestamp),
  dependsOn: Schema.optional(
    Schema.Array(CanvasPlanTaskId).pipe(Schema.maxItems(CANVAS_MAX_PLAN_TASK_DEPENDENCIES)),
  ),
  sourceIds: Schema.optional(
    Schema.Array(CanvasSourceId).pipe(Schema.maxItems(CANVAS_MAX_PLAN_TASK_SOURCES)),
  ),
}).annotations(strict);
export type CanvasPlanTask = typeof CanvasPlanTask.Type;

/**
 * The closed component catalog: the version-3 components plus these, which
 * arrived with the catalog at version 12. A form field is the labelled text
 * input; there is no separate input component.
 */
export const CANVAS_MOCKUP_CATALOG_COMPONENTS = [
  "stack",
  "row",
  "grid",
  "heading",
  "select",
  "checkbox",
  "table",
  "avatar",
  "badge",
  "icon",
  "nav",
  "modal",
  "toast",
] as const;
export const CanvasMockupComponent = Schema.Literal(
  ...CANVAS_MOCKUP_LEGACY_COMPONENTS,
  ...CANVAS_MOCKUP_CATALOG_COMPONENTS,
);
export type CanvasMockupComponent = typeof CanvasMockupComponent.Type;

/**
 * Where the screen is shown. `desktop` is a native window, `browser` a web
 * page with a blank address bar, `dock-panel` a narrow tool panel, and
 * `custom` a frame of the block's own `size`.
 */
export const CanvasMockupDevice = Schema.Literal(
  ...CANVAS_MOCKUP_LEGACY_DEVICES,
  "browser",
  "dock-panel",
  "custom",
);
export type CanvasMockupDevice = typeof CanvasMockupDevice.Type;

/** The nominal frame each preset is drawn at, in CSS pixels. */
export const CANVAS_MOCKUP_DEVICE_SIZE: Readonly<
  Record<
    Exclude<CanvasMockupDevice, "custom">,
    { readonly width: number; readonly height: number | undefined }
  >
> = {
  desktop: { width: 1280, height: 800 },
  browser: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
  // A dock panel is as tall as the window it sits in, so it has no height of
  // its own and grows with its content.
  "dock-panel": { width: 360, height: undefined },
};

/**
 * `wireframe` draws neutral ink and hairlines only. `styled` draws the same
 * tree with the active theme's tokens: accent, tones, and surfaces.
 */
export const CanvasMockupFidelity = Schema.Literal("wireframe", "styled");
export type CanvasMockupFidelity = typeof CanvasMockupFidelity.Type;

/** A semantic tone for a button, badge, or toast; the theme decides the colour. */
export const CanvasMockupTone = Schema.Literal("neutral", "accent", "success", "warning", "danger");
export type CanvasMockupTone = typeof CanvasMockupTone.Type;

/**
 * The bundled icon set. Names are meanings, not a vendor's glyph names; each
 * surface maps them to its own drawing.
 */
export const CanvasMockupIcon = Schema.Literal(
  "search",
  "settings",
  "user",
  "bell",
  "home",
  "plus",
  "close",
  "check",
  "chevron-right",
  "chevron-down",
  "menu",
  "more",
  "mail",
  "lock",
  "calendar",
  "folder",
  "file",
  "trash",
  "edit",
  "star",
  "share",
  "filter",
  "info",
  "warning",
);
export type CanvasMockupIcon = typeof CanvasMockupIcon.Type;

const CanvasMockupText = boundedNonEmptyText(CANVAS_MAX_MOCKUP_TEXT_LENGTH);
const CanvasMockupCell = boundedText(CANVAS_MAX_MOCKUP_TEXT_LENGTH);
const CanvasMockupNodeId = boundedToken("CanvasMockupNodeId");
export const CanvasMockupVariantId = boundedToken("CanvasMockupVariantId");
export type CanvasMockupVariantId = typeof CanvasMockupVariantId.Type;
const CanvasMockupFrameEdge = Schema.Int.pipe(
  Schema.greaterThanOrEqualTo(CANVAS_MOCKUP_MIN_FRAME_EDGE),
  Schema.lessThanOrEqualTo(CANVAS_MOCKUP_MAX_FRAME_EDGE),
);

/**
 * One drawn part of a screen. The tree is a parent chain, not nested objects:
 * a nested screen lands past the Canvas depth budget before a settings screen
 * can name its rows. Each optional field belongs to the components the domain
 * policy names; none of them carries markup, a style, or an image source.
 */
export const CanvasMockupNode = Schema.Struct({
  nodeId: CanvasMockupNodeId,
  component: CanvasMockupComponent,
  label: CanvasMockupText,
  parentId: Schema.optional(CanvasMockupNodeId),
  /** Drawn state of a toggle or checkbox, or the current row of a list or nav. Not live. */
  on: Schema.optional(Schema.Boolean),
  /** The variant a top-level node is drawn in. Children inherit their root's. */
  variantId: Schema.optional(CanvasMockupVariantId),
  /** The text shown inside a form field or select. */
  value: Schema.optional(CanvasMockupText),
  tone: Schema.optional(CanvasMockupTone),
  icon: Schema.optional(CanvasMockupIcon),
  /** A table's column headings and its rows of cells. */
  columns: Schema.optional(
    Schema.Array(CanvasMockupText).pipe(
      Schema.minItems(1),
      Schema.maxItems(CANVAS_MAX_MOCKUP_TABLE_COLUMNS),
    ),
  ),
  rows: Schema.optional(
    Schema.Array(
      Schema.Array(CanvasMockupCell).pipe(Schema.maxItems(CANVAS_MAX_MOCKUP_TABLE_COLUMNS)),
    ).pipe(Schema.maxItems(CANVAS_MAX_MOCKUP_TABLE_ROWS)),
  ),
  /** How many columns a grid lays its children in. */
  gridColumns: Schema.optional(
    Schema.Int.pipe(
      Schema.greaterThanOrEqualTo(1),
      Schema.lessThanOrEqualTo(CANVAS_MAX_MOCKUP_GRID_COLUMNS),
    ),
  ),
}).annotations(strict);
export type CanvasMockupNode = typeof CanvasMockupNode.Type;

/** One frame of a side-by-side set: a state (Empty, Error) or an alternative (A, B). */
export const CanvasMockupVariant = Schema.Struct({
  variantId: CanvasMockupVariantId,
  label: CanvasMockupText,
}).annotations(strict);
export type CanvasMockupVariant = typeof CanvasMockupVariant.Type;

/**
 * A numbered callout pinned to a node. Its number is its place in the list,
 * and the node it names is the comment anchor a reader replies on.
 */
export const CanvasMockupAnnotation = Schema.Struct({
  nodeId: CanvasMockupNodeId,
  note: boundedNonEmptyText(CANVAS_MAX_MOCKUP_NOTE_LENGTH),
}).annotations(strict);
export type CanvasMockupAnnotation = typeof CanvasMockupAnnotation.Type;

export const CanvasMockupBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("mockup"),
  device: CanvasMockupDevice,
  /** The frame of a `custom` device. Presets carry their own size. */
  size: Schema.optional(
    Schema.Struct({ width: CanvasMockupFrameEdge, height: CanvasMockupFrameEdge }).annotations(
      strict,
    ),
  ),
  fidelity: Schema.optional(CanvasMockupFidelity),
  title: CanvasMockupText,
  variants: Schema.optional(
    Schema.Array(CanvasMockupVariant).pipe(
      Schema.minItems(2),
      Schema.maxItems(CANVAS_MAX_MOCKUP_VARIANTS),
    ),
  ),
  nodes: Schema.Array(CanvasMockupNode).pipe(Schema.maxItems(CANVAS_MAX_MOCKUP_NODES)),
  annotations: Schema.optional(
    Schema.Array(CanvasMockupAnnotation).pipe(Schema.maxItems(CANVAS_MAX_MOCKUP_ANNOTATIONS)),
  ),
}).annotations(strict);
export type CanvasMockupBlock = typeof CanvasMockupBlock.Type;

/**
 * The viewport a design frame is drawn at, in CSS pixels: a phone, a tablet,
 * a desktop window or web page, or a 16:9 slide.
 */
export const CanvasDesignSize = Schema.Literal("phone", "tablet", "desktop", "slide");
export type CanvasDesignSize = typeof CanvasDesignSize.Type;

/** The CSS viewport each size is drawn at. Authors lay frames out against it. */
export const CANVAS_DESIGN_VIEWPORT: Readonly<
  Record<CanvasDesignSize, { readonly width: number; readonly height: number }>
> = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
  slide: { width: 1920, height: 1080 },
};

const CanvasDesignFrameId = boundedToken("CanvasDesignFrameId");
const CanvasDesignMarkup = boundedText(CANVAS_MAX_DESIGN_MARKUP_LENGTH);

/**
 * One screen or slide. `html` is the body of a static page and `frameId` is
 * the fragment other frames link to (`href="#checkout"`). The markup is drawn
 * in a sandboxed frame that runs no script and loads nothing from the network;
 * the domain policy refuses markup that would need either.
 */
export const CanvasDesignFrame = Schema.Struct({
  frameId: CanvasDesignFrameId,
  title: CanvasMockupText,
  html: CanvasDesignMarkup,
}).annotations(strict);
export type CanvasDesignFrame = typeof CanvasDesignFrame.Type;

/**
 * Screens of an app or site, or the slides of a deck, written as HTML and CSS.
 * `styles` is one stylesheet every frame shares.
 */
export const CanvasDesignBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("design"),
  title: CanvasMockupText,
  size: CanvasDesignSize,
  styles: Schema.optional(CanvasDesignMarkup),
  frames: Schema.Array(CanvasDesignFrame).pipe(
    Schema.minItems(1),
    Schema.maxItems(CANVAS_MAX_DESIGN_FRAMES),
  ),
}).annotations(strict);
export type CanvasDesignBlock = typeof CanvasDesignBlock.Type;

export const CanvasPlanBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("plan"),
  title: CanvasLabel,
  view: Schema.optional(CanvasPlanView),
  phases: Schema.NonEmptyArray(CanvasPlanPhase).pipe(Schema.maxItems(CANVAS_MAX_PLAN_PHASES)),
  tasks: Schema.Array(CanvasPlanTask).pipe(Schema.maxItems(CANVAS_MAX_PLAN_TASKS)),
}).annotations(strict);
export type CanvasPlanBlock = typeof CanvasPlanBlock.Type;

const CanvasReferenceFields = {
  ...CanvasBlockFields,
  sourceId: CanvasSourceId,
  label: CanvasLabel,
  detail: Schema.optional(CanvasText),
} as const;

export const CanvasArtifactReferenceBlock = Schema.Struct({
  ...CanvasReferenceFields,
  kind: Schema.Literal("artifact-reference"),
}).annotations(strict);
export type CanvasArtifactReferenceBlock = typeof CanvasArtifactReferenceBlock.Type;

export const CanvasFileReferenceBlock = Schema.Struct({
  ...CanvasReferenceFields,
  kind: Schema.Literal("file-reference"),
}).annotations(strict);
export type CanvasFileReferenceBlock = typeof CanvasFileReferenceBlock.Type;

export const CanvasPreviewReferenceBlock = Schema.Struct({
  ...CanvasReferenceFields,
  kind: Schema.Literal("preview-reference"),
}).annotations(strict);
export type CanvasPreviewReferenceBlock = typeof CanvasPreviewReferenceBlock.Type;

export const CanvasBrowserReferenceBlock = Schema.Struct({
  ...CanvasReferenceFields,
  kind: Schema.Literal("browser-reference"),
}).annotations(strict);
export type CanvasBrowserReferenceBlock = typeof CanvasBrowserReferenceBlock.Type;

export const CanvasEvidenceReferenceBlock = Schema.Struct({
  ...CanvasReferenceFields,
  kind: Schema.Literal("evidence-reference"),
}).annotations(strict);
export type CanvasEvidenceReferenceBlock = typeof CanvasEvidenceReferenceBlock.Type;

export const CanvasImageBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("image"),
  sourceId: CanvasSourceId,
  alt: CanvasNonEmptyText,
  caption: Schema.optional(CanvasText),
}).annotations(strict);
export type CanvasImageBlock = typeof CanvasImageBlock.Type;

export const CanvasBlock = Schema.Union(
  CanvasHeadingBlock,
  CanvasRichTextBlock,
  CanvasCalloutBlock,
  CanvasLinkBlock,
  CanvasDividerBlock,
  CanvasCitationBlock,
  CanvasMetricBlock,
  CanvasProgressBlock,
  CanvasStatusBlock,
  CanvasKeyValueBlock,
  CanvasTableBlock,
  CanvasChartBlock,
  CanvasTimelineBlock,
  CanvasDiagramBlock,
  CanvasSequenceBlock,
  CanvasStateBlock,
  CanvasErBlock,
  CanvasSwimlaneBlock,
  CanvasMindmapBlock,
  CanvasCodeExcerptBlock,
  CanvasPseudocodeBlock,
  CanvasDiffBlock,
  CanvasSourceReferenceBlock,
  CanvasSummaryBlock,
  CanvasArtifactReferenceBlock,
  CanvasFileReferenceBlock,
  CanvasPreviewReferenceBlock,
  CanvasBrowserReferenceBlock,
  CanvasEvidenceReferenceBlock,
  CanvasImageBlock,
  CanvasMockupBlock,
  CanvasDesignBlock,
  CanvasPlanBlock,
  CanvasTreemapBlock,
  // A heatmap has two layouts with different shapes, so both structs join the
  // union directly rather than nesting a union: the block catalog derives one
  // kind per member, and a nested union would hide its members from it.
  CanvasHeatmapMatrixBlock,
  CanvasHeatmapCalendarBlock,
  CanvasBarListBlock,
  CanvasComparisonMatrixBlock,
  CanvasMathDisplayBlock,
  CanvasMathInlineBlock,
  // Typed actions (Canvas D). The block is a declarative reference to an
  // allowlisted command; the server reauthorizes every action before any side
  // effect, so union membership never makes a definition executable.
  CanvasActionBlock,
);
export type CanvasBlock = typeof CanvasBlock.Type;

// Where the originating thread shows a Canvas. `inline` draws the document in
// the conversation; `sidebar` shows a card that opens it beside the thread.
// Either way the Canvas is one journaled object: the hint never copies it.
export const CanvasPresentation = Schema.Literal("inline", "sidebar");
export type CanvasPresentation = typeof CanvasPresentation.Type;

export const CanvasDefinition = Schema.Struct({
  schemaVersion: CanvasSchemaVersion,
  title: boundedNonEmptyText(256),
  provenance: CanvasProvenance,
  sourceManifest: CanvasSourceManifest,
  presentation: Schema.optional(CanvasPresentation),
  blocks: Schema.Array(CanvasBlock)
    .pipe(Schema.maxItems(CANVAS_MAX_BLOCKS))
    .pipe(
      Schema.filter(
        (blocks) => blocks.filter((block) => block.kind === "image").length <= CANVAS_MAX_IMAGES,
        { message: () => `Canvas image blocks exceed ${CANVAS_MAX_IMAGES}.` },
      ),
    ),
})
  .annotations(strict)
  .pipe(
    // Version-gated blocks and hints: a mockup is admitted from version 3, the
    // thread presentation from version 4, a treemap from version 5, a heatmap
    // from version 6, a bar list and the metric trend fields from version 7, a
    // design from version 9, a comparison matrix from version 10, math from
    // version 11, and the mockup catalog from version 12. A
    // rolled-back runtime that never learned a kind or hint must see a document
    // carrying it as a declared future version, not as a document that failed
    // to decode. Each keeps its own floor so an earlier document stays valid.
    Schema.filter(
      (definition) =>
        definition.schemaVersion >= CANVAS_MOCKUP_SCHEMA_VERSION ||
        !definition.blocks.some((block) => block.kind === "mockup"),
      {
        message: () =>
          `Mockup blocks require Canvas schema version ${String(CANVAS_MOCKUP_SCHEMA_VERSION)} or newer.`,
      },
    ),
    Schema.filter(
      (definition) =>
        definition.schemaVersion >= CANVAS_PRESENTATION_SCHEMA_VERSION ||
        definition.presentation === undefined,
      {
        message: () =>
          `A thread presentation requires Canvas schema version ${String(CANVAS_PRESENTATION_SCHEMA_VERSION)}.`,
      },
    ),
    Schema.filter(
      (definition) =>
        definition.schemaVersion >= CANVAS_TREEMAP_SCHEMA_VERSION ||
        !definition.blocks.some((block) => block.kind === "treemap"),
      {
        message: () =>
          `Treemap blocks require Canvas schema version ${String(CANVAS_TREEMAP_SCHEMA_VERSION)}.`,
      },
    ),
    Schema.filter(
      (definition) =>
        definition.schemaVersion >= CANVAS_HEATMAP_SCHEMA_VERSION ||
        !definition.blocks.some((block) => block.kind === "heatmap"),
      {
        message: () =>
          `Heatmap blocks require Canvas schema version ${String(CANVAS_HEATMAP_SCHEMA_VERSION)}.`,
      },
    ),
    Schema.filter(
      (definition) =>
        definition.schemaVersion >= CANVAS_BAR_LIST_SCHEMA_VERSION ||
        !definition.blocks.some((block) => block.kind === "bar-list"),
      {
        message: () =>
          `Bar-list blocks require Canvas schema version ${String(CANVAS_BAR_LIST_SCHEMA_VERSION)}.`,
      },
    ),
    // The entity-relationship, swimlane, and mind map kinds shipped together,
    // so one floor admits them all.
    Schema.filter(
      (definition) =>
        definition.schemaVersion >= CANVAS_DIAGRAM_KINDS_SCHEMA_VERSION ||
        !definition.blocks.some(
          (block) => block.kind === "er" || block.kind === "swimlane" || block.kind === "mindmap",
        ),
      {
        message: () =>
          `Entity-relationship, swimlane, and mind map blocks require Canvas schema version ${String(CANVAS_DIAGRAM_KINDS_SCHEMA_VERSION)}.`,
      },
    ),
    Schema.filter(
      (definition) =>
        definition.schemaVersion >= CANVAS_METRIC_TREND_SCHEMA_VERSION ||
        !definition.blocks.some(canvasMetricUsesTrendFields),
      {
        message: () =>
          `A metric sparkline, goodDirection, or caption requires Canvas schema version ${String(CANVAS_METRIC_TREND_SCHEMA_VERSION)}.`,
      },
    ),
    Schema.filter(
      (definition) =>
        definition.schemaVersion >= CANVAS_DESIGN_SCHEMA_VERSION ||
        !definition.blocks.some((block) => block.kind === "design"),
      {
        message: () =>
          `Design blocks require Canvas schema version ${String(CANVAS_DESIGN_SCHEMA_VERSION)}.`,
      },
    ),
    Schema.filter(
      (definition) =>
        definition.schemaVersion >= CANVAS_COMPARISON_MATRIX_SCHEMA_VERSION ||
        !definition.blocks.some((block) => block.kind === "comparison-matrix"),
      {
        message: () =>
          `Comparison matrix blocks require Canvas schema version ${String(CANVAS_COMPARISON_MATRIX_SCHEMA_VERSION)}.`,
      },
    ),
    Schema.filter(
      (definition) =>
        definition.schemaVersion >= CANVAS_MATH_SCHEMA_VERSION ||
        !definition.blocks.some((block) => block.kind === "math"),
      {
        message: () =>
          `Math blocks require Canvas schema version ${String(CANVAS_MATH_SCHEMA_VERSION)}.`,
      },
    ),
    Schema.filter(
      (definition) =>
        definition.schemaVersion >= CANVAS_MOCKUP_CATALOG_SCHEMA_VERSION ||
        !definition.blocks.some(canvasMockupUsesCatalog),
      {
        message: () =>
          `A mockup's catalog components, devices, fidelity, variants, callouts, or more than ${String(CANVAS_MOCKUP_LEGACY_MAX_NODES)} nodes require Canvas schema version ${String(CANVAS_MOCKUP_CATALOG_SCHEMA_VERSION)}.`,
      },
    ),
  );
export type CanvasDefinition = typeof CanvasDefinition.Type;

export const CanvasVersion = Schema.Struct({
  schemaVersion: CanvasSchemaVersion,
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  sequence: Schema.Int.pipe(Schema.positive()),
  definition: CanvasDefinition,
  createdBy: CanvasActor,
  createdAt: UtcTimestamp,
}).annotations(strict);
export type CanvasVersion = typeof CanvasVersion.Type;

// ── Decoders ────────────────────────────────────────────────────────────────

export const decodeCanvasId = Schema.decodeUnknownSync(CanvasId);
export const decodeCanvasVersionId = Schema.decodeUnknownSync(CanvasVersionId);
export const decodeCanvasSourceId = Schema.decodeUnknownSync(CanvasSourceId);
export const decodeCanvasBlockId = Schema.decodeUnknownSync(CanvasBlockId);
export const decodeCanvasSchemaVersion = Schema.decodeUnknownSync(CanvasSchemaVersion);
export const decodeCanvasActor = Schema.decodeUnknownSync(CanvasActor);
export const decodeCanvasProvenance = Schema.decodeUnknownSync(CanvasProvenance);
export const decodeCanvasSourceVersion = Schema.decodeUnknownSync(CanvasSourceVersion);
export const decodeCanvasSourceManifestEntry = Schema.decodeUnknownSync(CanvasSourceManifestEntry);
export const decodeCanvasSourceManifest = Schema.decodeUnknownSync(CanvasSourceManifest);
export const decodeCanvasBlockKind = Schema.decodeUnknownSync(CanvasBlockKind);
export const decodeCanvasBlock = Schema.decodeUnknownSync(CanvasBlock);
export const decodeCanvasDefinition = Schema.decodeUnknownSync(CanvasDefinition);
export const decodeCanvasVersion = Schema.decodeUnknownSync(CanvasVersion);
export const decodeCanvasPresentation = Schema.decodeUnknownSync(CanvasPresentation);
export const decodeCanvasDiagramLayoutKind = Schema.decodeUnknownSync(CanvasDiagramLayoutKind);
export const decodeCanvasPlanTaskId = Schema.decodeUnknownSync(CanvasPlanTaskId);
export const decodeCanvasNodeId = Schema.decodeUnknownSync(CanvasNodeId);

// ── Journaled lifecycle events ──────────────────────────────────────────────
//
// Canvas lifecycle is persisted as authoritative journal events. Each event
// carries the immutable CanvasVersion envelope defined by A1, so projections
// and replay never need to re-derive version identity. Event payloads contain
// only bounded Canvas data, provenance, and opaque source references — never
// secrets, credentials, or executable code.

export const CanvasCreated = Schema.Struct({
  canvasId: CanvasId,
  version: CanvasVersion,
}).annotations(strict);
export type CanvasCreated = typeof CanvasCreated.Type;

export const CanvasVersionAppended = Schema.Struct({
  canvasId: CanvasId,
  version: CanvasVersion,
  // Optional refresh receipt is carried in the same journal event as the
  // version so successful refreshes are idempotent across crash boundaries.
  refreshReceipt: Schema.optional(Schema.Unknown),
}).annotations(strict);
export type CanvasVersionAppended = typeof CanvasVersionAppended.Type;

export const CANVAS_AGGREGATE_TYPE = "canvas";
export const CANVAS_CREATED = "canvas.created@1";
export const CANVAS_VERSION_APPENDED = "canvas.version-appended@1";

export const CANVAS_EVENT_NAMES = [CANVAS_CREATED, CANVAS_VERSION_APPENDED] as const;
export type CanvasEventName = (typeof CANVAS_EVENT_NAMES)[number];

export const decodeCanvasCreated = Schema.decodeUnknownSync(CanvasCreated);
export const decodeCanvasVersionAppended = Schema.decodeUnknownSync(CanvasVersionAppended);
