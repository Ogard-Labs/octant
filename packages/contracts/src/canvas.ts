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
// thread presentation, version 5 the treemap block, and version 6 the design
// block, which the definition
// filters below admit only under those declared versions.

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
export const CANVAS_MAX_MOCKUP_DEPTH = 6;
export const CANVAS_MAX_MOCKUP_NODES = 64;
export const CANVAS_MAX_MOCKUP_TEXT_LENGTH = 120;
export const CANVAS_MAX_TREEMAP_LEAVES = 4_096;
export const CANVAS_MAX_TREEMAP_DEPTH = 8;
export const CANVAS_MAX_TREEMAP_MEASURES = 8;
export const CANVAS_MAX_TREEMAP_LABEL_LENGTH = 120;
export const CANVAS_MAX_DESIGN_FRAMES = 24;
export const CANVAS_MAX_DESIGN_MARKUP_LENGTH = 32_768;

// The schema version that introduced each version-gated block kind or hint. A
// document carrying one below the version that introduced it is a declared
// future version, not a corrupt one, so a rolled-back runtime refuses it cleanly.
export const CANVAS_MOCKUP_SCHEMA_VERSION = 3;
export const CANVAS_PRESENTATION_SCHEMA_VERSION = 4;
export const CANVAS_TREEMAP_SCHEMA_VERSION = 5;
export const CANVAS_DESIGN_SCHEMA_VERSION = 6;

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
  "design",
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

export const CanvasMetricBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("metric"),
  label: CanvasLabel,
  value: CanvasScalar,
  unit: Schema.optional(CanvasLabel),
  delta: Schema.optional(FiniteNumber),
  format: Schema.optional(CanvasNumberFormat),
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

export const CanvasTableColumn = Schema.Struct({
  id: boundedToken("CanvasTableColumnId"),
  label: CanvasLabel,
  type: CanvasTableColumnType,
  format: Schema.optional(CanvasNumberFormat),
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

export const CanvasMockupComponent = Schema.Literal(
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
);
export type CanvasMockupComponent = typeof CanvasMockupComponent.Type;

export const CanvasMockupDevice = Schema.Literal("desktop", "tablet", "phone");
export type CanvasMockupDevice = typeof CanvasMockupDevice.Type;

const CanvasMockupText = boundedNonEmptyText(CANVAS_MAX_MOCKUP_TEXT_LENGTH);
const CanvasMockupNodeId = boundedToken("CanvasMockupNodeId");

/**
 * One drawn part of a screen. The tree is a parent chain, not nested objects:
 * a nested screen lands past the Canvas depth budget before a settings screen
 * can name its rows.
 */
export const CanvasMockupNode = Schema.Struct({
  nodeId: CanvasMockupNodeId,
  component: CanvasMockupComponent,
  label: CanvasMockupText,
  parentId: Schema.optional(CanvasMockupNodeId),
  /** Drawn state of a toggle. The control is not live. */
  on: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type CanvasMockupNode = typeof CanvasMockupNode.Type;

export const CanvasMockupBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("mockup"),
  device: CanvasMockupDevice,
  title: CanvasMockupText,
  nodes: Schema.Array(CanvasMockupNode).pipe(Schema.maxItems(CANVAS_MAX_MOCKUP_NODES)),
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
    // thread presentation from version 4, a treemap from version 5, and a design
    // from version 6. A
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
        definition.schemaVersion >= CANVAS_DESIGN_SCHEMA_VERSION ||
        !definition.blocks.some((block) => block.kind === "design"),
      {
        message: () =>
          `Design blocks require Canvas schema version ${String(CANVAS_DESIGN_SCHEMA_VERSION)}.`,
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
