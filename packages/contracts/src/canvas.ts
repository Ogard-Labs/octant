import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import {
  CanvasActor,
  CanvasBlockId,
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
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

// Canvas wire contracts are deliberately versioned independently from event
// envelopes. A decoder must reject a future version until its renderer and
// policy have been reviewed together.

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

export const CanvasScalar = Schema.Union(CanvasText, FiniteNumber, Schema.Boolean, Schema.Null);
export type CanvasScalar = typeof CanvasScalar.Type;

export const CanvasMetricBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("metric"),
  label: CanvasLabel,
  value: CanvasScalar,
  unit: Schema.optional(CanvasLabel),
  delta: Schema.optional(FiniteNumber),
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

export const CanvasChartType = Schema.Literal("line", "bar", "area", "scatter", "distribution");
export type CanvasChartType = typeof CanvasChartType.Type;

export const CanvasChartPoint = Schema.Struct({
  x: Schema.Union(FiniteNumber, CanvasText),
  y: FiniteNumber,
}).annotations(strict);
export type CanvasChartPoint = typeof CanvasChartPoint.Type;

export const CanvasChartSeries = Schema.Struct({
  seriesId: boundedToken("CanvasSeriesId"),
  label: CanvasLabel,
  points: Schema.NonEmptyArray(CanvasChartPoint).pipe(Schema.maxItems(CANVAS_MAX_CHART_POINTS)),
}).annotations(strict);
export type CanvasChartSeries = typeof CanvasChartSeries.Type;

export const CanvasChartBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("chart"),
  chartType: CanvasChartType,
  series: Schema.Array(CanvasChartSeries).pipe(Schema.maxItems(CANVAS_MAX_SERIES)),
}).annotations(strict);
export type CanvasChartBlock = typeof CanvasChartBlock.Type;

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

export const CanvasDiagramNode = Schema.Struct({
  nodeId: CanvasNodeId,
  label: CanvasLabel,
  role: Schema.optional(boundedToken("CanvasNodeRole")),
  x: Schema.optional(FiniteNumber),
  y: Schema.optional(FiniteNumber),
}).annotations(strict);
export type CanvasDiagramNode = typeof CanvasDiagramNode.Type;

export const CanvasDiagramEdge = Schema.Struct({
  edgeId: boundedToken("CanvasEdgeId"),
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
}).annotations(strict);
export type CanvasDiagramBlock = typeof CanvasDiagramBlock.Type;

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
  // Typed actions (Canvas D). The block is a declarative reference to an
  // allowlisted command; the server reauthorizes every action before any side
  // effect, so union membership never makes a definition executable.
  CanvasActionBlock,
);
export type CanvasBlock = typeof CanvasBlock.Type;

export const CanvasDefinition = Schema.Struct({
  schemaVersion: CanvasSchemaVersion,
  title: boundedNonEmptyText(256),
  provenance: CanvasProvenance,
  sourceManifest: CanvasSourceManifest,
  blocks: Schema.Array(CanvasBlock)
    .pipe(Schema.maxItems(CANVAS_MAX_BLOCKS))
    .pipe(
      Schema.filter(
        (blocks) => blocks.filter((block) => block.kind === "image").length <= CANVAS_MAX_IMAGES,
        { message: () => `Canvas image blocks exceed ${CANVAS_MAX_IMAGES}.` },
      ),
    ),
}).annotations(strict);
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
