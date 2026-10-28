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
  CanvasTableRowId,
  CanvasVersionId,
} from "./canvasIdentity";
import { CanvasActionBlock } from "./canvasActionBlock";

export * from "./canvasBrand";
export * from "./canvasIdentity";
import { CanvasDesignBrand } from "./canvasBrand";
import { ChatThreadId } from "./chat";
import { CodeThreadId } from "./code";
import { WorkThreadId } from "./workThreads";
import { HostId } from "./host";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { ImageArtifactId } from "./imageGeneration";
import { BrowserCaptureId } from "./browserAutomation";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

// Canvas wire contracts are deliberately versioned independently from event
// envelopes. A decoder must reject a future version until its renderer and
// policy have been reviewed together. The current schema version is declared
// in `canvasIdentity.ts`: version 3 added the mockup block, version 4 the
// thread presentation, version 5 the treemap block, version 6 the heatmap
// block, version 7 the ranked bar-list block, version 8 the
// entity-relationship, swimlane, and mind map diagram kinds, version 9 the
// design block, version 10 the comparison matrix, version 11 the math
// block, version 12 the mockup catalog, version 13 the stable table row
// id, version 14 the funnel, radar, and sankey chart types, version 15 the
// dashboard layout block, version 16 the design document size and workspace
// theme, version 17 a design's declared image assets, version 18 a design
// that runs script, version 19 the tabs and columns layout groups, diagram
// styles, and the plan's Gantt view, version 20 a Chat Canvas owned by
// its thread rather than a Chat Project, and version 21 design frame notes,
// brand tokens, captured-page assets, and diagram node icons, details, and
// nested groups, which the
// definition filters below admit only under those declared versions.

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
// A chart's callouts point at the few readings the story is about; past a
// dozen they cover the line they explain.
export const CANVAS_MAX_CHART_NOTES = 12;
export const CANVAS_MAX_CHART_NOTE_LENGTH = 40;
export const CANVAS_MAX_CHART_TITLE_LENGTH = 160;
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
// A frame, and the shared stylesheet, hold one whole screen: a running app
// window at 1440x900 puts its sidebar, panes, tabs, and its script in one
// frame, and a finished one ran past the old 32 KiB. 64 KiB holds that with
// room. The 256 KiB text budget still bounds the design as a whole (about
// three frames this large, or many smaller screens).
export const CANVAS_MAX_DESIGN_MARKUP_LENGTH = 65_536;
// Speaker or screen notes are prose a presenter reads, not markup: a page of
// text per frame.
export const CANVAS_MAX_DESIGN_NOTES_LENGTH = 2_000;
// A flow places screens, not copies, so its budgets are small references: as
// many screens as a design may hold frames, and four links per screen.
export const CANVAS_MAX_FLOW_SCREENS = 24;
export const CANVAS_MAX_FLOW_EDGES = 96;
// An edge label says what the transition is ("Run search"), not a sentence.
export const CANVAS_MAX_FLOW_LABEL_LENGTH = 80;
// A reusable component is a small fixed subtree: few definitions, each small,
// and their nodes count against the block's own node budget as well.
export const CANVAS_MAX_MOCKUP_DEFINITIONS = 8;
export const CANVAS_MAX_MOCKUP_DEFINITION_NODES = 24;
// A deck is an ordered set of references, so its budget is small: as many
// slides as a design may hold frames.
export const CANVAS_MAX_DECK_SLIDES = 24;
// A flow's callouts are the author's shortest notes, like a mockup's.
export const CANVAS_MAX_FLOW_ANNOTATIONS = 12;
export const CANVAS_MAX_FLOW_ANNOTATION_LENGTH = 240;
// A diagram node's detail is a subtitle under its label, not a paragraph.
export const CANVAS_MAX_DIAGRAM_DETAIL_LENGTH = 120;
// A group inside a group inside a group: deeper boundaries stop reading as
// zones and start reading as noise.
export const CANVAS_MAX_DIAGRAM_GROUP_DEPTH = 3;
// A design shows a few real pictures: a screenshot in a phone frame, a hero
// image, a team photo. The host reads and inlines every declared image each
// time the design is drawn, so the count and bytes are bounded per design.
// The design budget keeps one design's resolved images, base64-encoded in a
// JSON response, inside the 8 MiB a paired remote client's gateway forwards.
export const CANVAS_MAX_DESIGN_ASSETS = 12;
export const CANVAS_DESIGN_ASSET_MAX_BYTES = 3 * 1024 * 1024;
export const CANVAS_DESIGN_ASSETS_MAX_BYTES = 5 * 1024 * 1024;
/**
 * How frame markup and styles name a declared asset, in `src`, `srcset`, a CSS
 * `url()`, or an `image-set()` candidate: `octant-asset:hero`. The renderer
 * replaces each reference with the resolved image before the page is drawn.
 */
export const CANVAS_DESIGN_ASSET_SCHEME = "octant-asset:";
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
// A funnel is read stage by stage down one column: a dozen and a half stages
// is already a long process, and past that the drop-off between neighbours is
// too thin to see.
export const CANVAS_MAX_FUNNEL_STAGES = 16;
// A radar's spokes share one circle. Fewer than three is a line, not a shape;
// past sixteen the axis labels collide at the rim even in a wide column.
export const CANVAS_MIN_RADAR_AXES = 3;
export const CANVAS_MAX_RADAR_AXES = 16;
// A sankey is a picture of where a whole goes. Sixty-four nodes and a few
// hundred flows still lay out in columns a reader can follow; past that the
// bands are hairlines and the flows want a table.
export const CANVAS_MAX_SANKEY_NODES = 64;
export const CANVAS_MAX_SANKEY_LINKS = 256;
// A funnel stage, a radar axis, and a sankey node are drawn as labels beside
// their marks, so they are names rather than sentences.
export const CANVAS_MAX_CHART_CATEGORY_LABEL_LENGTH = 80;
// A dashboard is a glance, not a second document: at most 24 cells on a grid
// of at most four columns, so a wide window shows six rows of tiles and a
// phone a single column it can still scroll through.
export const CANVAS_MAX_DASHBOARD_CELLS = 24;
export const CANVAS_MAX_DASHBOARD_COLUMNS = 4;
export const CANVAS_DEFAULT_DASHBOARD_COLUMNS = 4;
// A tab strip is read at a glance: past a dozen labels it wraps or scrolls,
// and the document wants headings instead. A label names the pane, so it is a
// word or two rather than a sentence.
export const CANVAS_MAX_TABS_PANES = 12;
export const CANVAS_MAX_TABS_LABEL_LENGTH = 80;
// Two to four tracks side by side: one is not columns, and past four a track
// is narrower than a metric tile even on a wide display.
export const CANVAS_MIN_COLUMN_TRACKS = 2;
export const CANVAS_MAX_COLUMN_TRACKS = 4;

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
// A table row may carry a stable id, the identity a row comment anchors to.
export const CANVAS_TABLE_ROW_ID_SCHEMA_VERSION = 13;
// The funnel, radar, and sankey chart types shipped as one slice and share a
// floor, as the three diagram kinds do.
export const CANVAS_FLOW_CHARTS_SCHEMA_VERSION = 14;
// The dashboard layout block: a titled grid that places metric, progress,
// status, chart, and table blocks by id.
export const CANVAS_DASHBOARD_SCHEMA_VERSION = 15;
// A design drawn as a document that grows to its content, and a design drawn
// in the workspace theme.
export const CANVAS_DESIGN_DOCUMENT_SCHEMA_VERSION = 16;
// A design that declares the images its frames show.
export const CANVAS_DESIGN_ASSET_SCHEMA_VERSION = 17;
// A design that runs its own script, drawn in a frame the host serves.
export const CANVAS_DESIGN_RUNNING_SCHEMA_VERSION = 18;
// The tabs and columns layout groups, which name other blocks of the document.
export const CANVAS_LAYOUT_GROUPS_SCHEMA_VERSION = 19;
// Diagram styling (closed node roles, edge styles and tones, group tones) and
// the plan's Gantt view shipped with the layout groups and share their floor.
export const CANVAS_DIAGRAM_STYLES_SCHEMA_VERSION = CANVAS_LAYOUT_GROUPS_SCHEMA_VERSION;
// A Chat Canvas whose provenance names its thread and no Project
// (`projectId: null`): the Canvas belongs to the thread, as a Chat thread
// outside a Chat Project has no Project to hold it.
export const CANVAS_THREAD_OWNED_SCHEMA_VERSION = 20;
// The design fields wave 2 shares: a frame's notes, a design's brand tokens
// (`theme: "brand"`), a captured page as a design asset, and a diagram node's
// icon and detail with a group's parent group.
export const CANVAS_DESIGN_FIELDS_SCHEMA_VERSION = 21;
// A chart's own title and subtitle, and a point's callout note and emphasis.
export const CANVAS_CHART_CALLOUTS_SCHEMA_VERSION = 22;
// The flow block, which places mockup and design screens on a board with
// labeled edges between them.
export const CANVAS_FLOW_SCHEMA_VERSION = 23;
// The deck block, which presents the document's own screens and data blocks
// as one ordered set of slides.
export const CANVAS_DECK_SCHEMA_VERSION = 25;
// Flow annotations: numbered callouts pinned to a flow's screens.
export const CANVAS_FLOW_ANNOTATIONS_SCHEMA_VERSION = 26;
// The metric's sparkline, goodDirection, and caption arrived with the bar list.
export const CANVAS_METRIC_TREND_SCHEMA_VERSION = 7;

/**
 * Whether a provenance names a thread and no Project: a Chat Canvas that
 * belongs to its thread. Reads loose fields so the domain's declared-version
 * check can ask before the document decodes.
 */
export function canvasProvenanceIsThreadOwned(provenance: {
  readonly mode?: unknown;
  readonly projectId?: unknown;
}): boolean {
  return provenance.mode === "chat" && provenance.projectId === null;
}

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

/** Whether a block uses a chart field introduced at the chart-callouts version. */
export function canvasChartUsesCallouts(block: {
  readonly kind?: unknown;
  readonly title?: unknown;
  readonly subtitle?: unknown;
  readonly series?: unknown;
}): boolean {
  if (block.kind !== "chart") return false;
  return (
    block.title !== undefined ||
    block.subtitle !== undefined ||
    (Array.isArray(block.series) &&
      block.series.some(
        (series) =>
          typeof series === "object" &&
          series !== null &&
          anyItemCarries((series as Record<string, unknown>)["points"], ["note", "emphasis"]),
      ))
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
  // A Chat Canvas belongs to its thread's Chat Project, or, when the thread
  // is in none, to the thread alone (`projectId: null`, from
  // `CANVAS_THREAD_OWNED_SCHEMA_VERSION`). Work and Code always have a Project.
  Schema.Struct({
    ...CanvasProvenanceCommon,
    mode: Schema.Literal("chat"),
    projectId: Schema.NullOr(ProjectId),
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
  "dashboard",
  "tabs",
  "columns",
  "flow",
  "deck",
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
export const CanvasTableRowCells = Schema.Array(CanvasTableCell).pipe(
  Schema.maxItems(CANVAS_MAX_TABLE_COLUMNS),
);
export type CanvasTableRowCells = typeof CanvasTableRowCells.Type;

/**
 * A row that names itself, so a comment can stay on it.
 *
 * A bare list of cells has only its position, which a sort, a filter, or a
 * revision that inserts a row changes; the id is the author's and outlives
 * all three. A row without one cannot be commented on by itself. Ids are
 * unique within the table, which the domain policy checks.
 */
export const CanvasTableKeyedRow = Schema.Struct({
  id: CanvasTableRowId,
  cells: CanvasTableRowCells,
}).annotations(strict);
export type CanvasTableKeyedRow = typeof CanvasTableKeyedRow.Type;

export const CanvasTableRow = Schema.Union(CanvasTableRowCells, CanvasTableKeyedRow);
export type CanvasTableRow = typeof CanvasTableRow.Type;

/** A table row's values in column order, whether or not the row names itself. */
export function canvasTableRowCells(row: CanvasTableRow): CanvasTableRowCells {
  return "cells" in row ? row.cells : row;
}

/** The row's stable id, or undefined for a row that is only a list of cells. */
export function canvasTableRowId(row: CanvasTableRow): CanvasTableRowId | undefined {
  return "cells" in row ? row.id : undefined;
}

/** Whether a block is a table with a row that carries a stable id. */
export function canvasTableUsesRowIds(block: {
  readonly kind?: unknown;
  readonly rows?: unknown;
}): boolean {
  return (
    block.kind === "table" &&
    Array.isArray(block.rows) &&
    block.rows.some(
      (row: unknown) => typeof row === "object" && row !== null && !Array.isArray(row),
    )
  );
}

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
  "funnel",
  "radar",
  "sankey",
);
export type CanvasChartType = typeof CanvasChartType.Type;

/** Whether a block is a chart of a type introduced at the flow-charts version. */
export function canvasChartUsesFlowTypes(block: {
  readonly kind?: unknown;
  readonly chartType?: unknown;
}): boolean {
  return (
    block.kind === "chart" &&
    (block.chartType === "funnel" || block.chartType === "radar" || block.chartType === "sankey")
  );
}

const CanvasChartCategoryLabel = boundedNonEmptyText(CANVAS_MAX_CHART_CATEGORY_LABEL_LENGTH);

/**
 * One flow in a sankey: a quantity that moves from one named node to another.
 *
 * Nodes are named by their labels rather than declared apart, so a flow can
 * never point at a node the chart does not hold. Whether the flows form a
 * cycle, and whether each quantity is positive, is the domain policy's to
 * judge, so a refusal names the reason.
 */
export const CanvasChartLink = Schema.Struct({
  source: CanvasChartCategoryLabel,
  target: CanvasChartCategoryLabel,
  value: FiniteNumber,
}).annotations(strict);
export type CanvasChartLink = typeof CanvasChartLink.Type;

export const CanvasChartPoint = Schema.Struct({
  x: Schema.Union(FiniteNumber, CanvasText),
  y: FiniteNumber,
  /** A short callout drawn beside the point, such as "+344". */
  note: Schema.optional(boundedNonEmptyText(CANVAS_MAX_CHART_NOTE_LENGTH)),
  /** Marks the reading the chart is about; the rest of its series recedes. */
  emphasis: Schema.optional(Schema.Literal(true)),
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
 * A funnel is one series of labeled stages, a radar compares series across the
 * same labeled axes, and a sankey draws flows between named nodes instead of
 * series. Values a reader could still draw (a negative flow, a funnel that
 * widens) are left to the domain policy, which refuses them with a reason.
 */
// Callouts sit on one value axis drawn at the figure's width; a slice, a
// stage, an axis spoke, or a stacked segment has no single point to label.
const CHART_TYPES_WITH_CALLOUTS: ReadonlySet<string> = new Set([
  "line",
  "area",
  "scatter",
  "bar",
  "distribution",
]);

export function canvasChartSeriesIssue(block: {
  readonly chartType: string;
  readonly series: ReadonlyArray<{
    readonly points: ReadonlyArray<{
      readonly x: number | string;
      readonly y: number;
      readonly note?: string | undefined;
      readonly emphasis?: true | undefined;
    }>;
    readonly mark?: CanvasChartMark | undefined;
  }>;
  readonly links?: ReadonlyArray<{ readonly source: string; readonly target: string }> | undefined;
}): string | undefined {
  const marked = block.series.some((item) => item.mark !== undefined);
  if (block.chartType !== "bar-line" && marked) {
    return "Only a bar and line chart names a mark on its series.";
  }
  const called = block.series.flatMap((item) =>
    item.points.filter((point) => point.note !== undefined || point.emphasis !== undefined),
  );
  if (called.length > 0 && !CHART_TYPES_WITH_CALLOUTS.has(block.chartType)) {
    return "Only a line, area, scatter, bar, or distribution chart notes or emphasizes a point.";
  }
  if (called.filter((point) => point.note !== undefined).length > CANVAS_MAX_CHART_NOTES) {
    return `A chart carries at most ${String(CANVAS_MAX_CHART_NOTES)} point notes.`;
  }
  if (block.chartType === "sankey") return sankeyIssue(block.series.length, block.links);
  if (block.links !== undefined) return "Only a sankey chart carries links.";
  if (block.chartType === "pie" || block.chartType === "donut") {
    return partToWholeIssue(block.series);
  }
  if (block.chartType === "funnel") return funnelIssue(block.series);
  if (block.chartType === "radar") return radarIssue(block.series);
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

function sankeyIssue(
  seriesCount: number,
  links: ReadonlyArray<{ readonly source: string; readonly target: string }> | undefined,
): string | undefined {
  if (seriesCount > 0) return "A sankey chart draws links, not series.";
  if (links === undefined || links.length === 0) return "A sankey chart needs at least one link.";
  const nodes = new Set<string>();
  for (const link of links) {
    nodes.add(link.source);
    nodes.add(link.target);
  }
  if (nodes.size > CANVAS_MAX_SANKEY_NODES) {
    return `A sankey chart names at most ${String(CANVAS_MAX_SANKEY_NODES)} nodes.`;
  }
  return undefined;
}

/** Why a category label cannot name a funnel stage or a radar axis. */
function categoryLabelIssue(x: number | string, what: string): string | undefined {
  if (typeof x !== "string" || x.trim() === "") return `A ${what} needs a label.`;
  if (x.length > CANVAS_MAX_CHART_CATEGORY_LABEL_LENGTH) {
    return `A ${what} label is at most ${String(CANVAS_MAX_CHART_CATEGORY_LABEL_LENGTH)} characters.`;
  }
  return undefined;
}

function funnelIssue(
  series: ReadonlyArray<{
    readonly points: ReadonlyArray<{ readonly x: number | string; readonly y: number }>;
  }>,
): string | undefined {
  const only = series[0];
  if (series.length !== 1 || only === undefined) {
    return "A funnel chart needs one series of labeled stages.";
  }
  if (only.points.length > CANVAS_MAX_FUNNEL_STAGES) {
    return `A funnel chart has at most ${String(CANVAS_MAX_FUNNEL_STAGES)} stages.`;
  }
  const labels = new Set<string>();
  for (const point of only.points) {
    const issue = categoryLabelIssue(point.x, "funnel stage");
    if (issue !== undefined) return issue;
    if (labels.has(String(point.x))) return "A funnel chart lists each stage once.";
    labels.add(String(point.x));
  }
  return undefined;
}

function radarIssue(
  series: ReadonlyArray<{
    readonly points: ReadonlyArray<{ readonly x: number | string; readonly y: number }>;
  }>,
): string | undefined {
  const first = series[0];
  if (first === undefined) return "A radar chart needs at least one series.";
  if (first.points.length < CANVAS_MIN_RADAR_AXES || first.points.length > CANVAS_MAX_RADAR_AXES) {
    return `A radar chart has ${String(CANVAS_MIN_RADAR_AXES)} to ${String(CANVAS_MAX_RADAR_AXES)} axes.`;
  }
  const labels = new Set<string>();
  for (const point of first.points) {
    const issue = categoryLabelIssue(point.x, "radar axis");
    if (issue !== undefined) return issue;
    if (labels.has(String(point.x))) return "A radar chart lists each axis once.";
    labels.add(String(point.x));
  }
  const keys = first.points.map((point) => categoryKey(point.x));
  for (const item of series) {
    const itemKeys = item.points.map((point) => categoryKey(point.x));
    if (itemKeys.length !== keys.length || itemKeys.some((key, index) => key !== keys[index])) {
      return "Every radar series lists the same axes in the same order.";
    }
  }
  return undefined;
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
  /** The finding the chart shows, as a sentence; the Canvas names the subject. */
  title: Schema.optional(boundedNonEmptyText(CANVAS_MAX_CHART_TITLE_LENGTH)),
  /** What is measured and over which span. */
  subtitle: Schema.optional(boundedNonEmptyText(CANVAS_MAX_CHART_TITLE_LENGTH)),
  series: Schema.Array(CanvasChartSeries).pipe(Schema.maxItems(CANVAS_MAX_SERIES)),
  /** A sankey's flows; every other chart type omits it. */
  links: Schema.optional(
    Schema.Array(CanvasChartLink).pipe(Schema.maxItems(CANVAS_MAX_SANKEY_LINKS)),
  ),
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
/**
 * The node roles the layout draws as shapes: a process is a box, a decision a
 * diamond, a terminator a pill, and a node without a role the plain rounded
 * box. Before version 19 a role was free text no renderer read; a block that
 * declares version 19 or newer may only use these, and the domain policy
 * refuses anything else there. An older block keeps whatever it wrote and
 * draws every node as the plain box, even a role that names a shape.
 */
export const CANVAS_DIAGRAM_NODE_ROLES = ["process", "decision", "terminator"] as const;
export const CanvasDiagramNodeRole = Schema.Literal(...CANVAS_DIAGRAM_NODE_ROLES);
export type CanvasDiagramNodeRole = typeof CanvasDiagramNodeRole.Type;

/** Whether a line ends in an arrowhead, or is dashed to read as optional or async. */
export const CanvasDiagramEdgeStyle = Schema.Literal("line", "arrow", "dashed");
export type CanvasDiagramEdgeStyle = typeof CanvasDiagramEdgeStyle.Type;

/**
 * A diagram tone is a theme role, never a colour: neutral, the accent, and the
 * success, warning, and danger roles. A tone is emphasis beside the label and
 * the line style, never the only thing that carries a distinction.
 */
export const CanvasDiagramTone = Schema.Literal(
  "neutral",
  "accent",
  "success",
  "warning",
  "danger",
);
export type CanvasDiagramTone = typeof CanvasDiagramTone.Type;

/**
 * The generic infrastructure glyphs a diagram node may carry. The list is
 * closed and names kinds of thing, never a vendor or a product, so a renderer
 * draws its own glyph for each and an export needs no image.
 */
export const CANVAS_DIAGRAM_NODE_ICONS = [
  "client",
  "browser",
  "mobile",
  "server",
  "service",
  "database",
  "cache",
  "queue",
  "storage",
  "cdn",
  "gateway",
  "auth",
  "function",
  "external",
  "user",
  "analytics",
] as const;
export const CanvasDiagramNodeIcon = Schema.Literal(...CANVAS_DIAGRAM_NODE_ICONS);
export type CanvasDiagramNodeIcon = typeof CanvasDiagramNodeIcon.Type;

export const CanvasDiagramNode = Schema.Struct({
  nodeId: CanvasNodeId,
  label: CanvasLabel,
  role: Schema.optional(boundedToken("CanvasNodeRole")),
  icon: Schema.optional(CanvasDiagramNodeIcon),
  /** A short subtitle under the label, such as a technology or a port. */
  detail: Schema.optional(boundedNonEmptyText(CANVAS_MAX_DIAGRAM_DETAIL_LENGTH)),
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
  style: Schema.optional(CanvasDiagramEdgeStyle),
  tone: Schema.optional(CanvasDiagramTone),
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
  /** A region's tone, so a zone map reads as areas rather than outlines. */
  tone: Schema.optional(CanvasDiagramTone),
  /**
   * The group this one sits inside, so a cloud region can hold its zones. The
   * domain policy refuses an unknown parent, a cycle, and nesting deeper than
   * `CANVAS_MAX_DIAGRAM_GROUP_DEPTH`.
   */
  parentGroupId: Schema.optional(boundedToken("CanvasGroupId")),
}).annotations(strict);
export type CanvasDiagramGroup = typeof CanvasDiagramGroup.Type;

/**
 * Whether a block uses a diagram field introduced at the design-fields
 * version. Reads loose fields so the domain's declared-version check can ask
 * the same question of a document that did not decode.
 */
export function canvasDiagramUsesRichFields(block: {
  readonly kind?: unknown;
  readonly nodes?: unknown;
  readonly groups?: unknown;
}): boolean {
  if (block.kind !== "diagram") return false;
  return (
    anyItemCarries(block.nodes, ["icon", "detail"]) ||
    anyItemCarries(block.groups, ["parentGroupId"])
  );
}

/** Whether any item of a loosely read list sets one of the named fields. */
function anyItemCarries(items: unknown, fields: ReadonlyArray<string>): boolean {
  return (
    Array.isArray(items) &&
    items.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        fields.some((field) => (item as Record<string, unknown>)[field] !== undefined),
    )
  );
}

/** Whether a block uses a diagram field introduced at the diagram-styles version. */
export function canvasDiagramUsesStyles(block: {
  readonly kind?: unknown;
  readonly edges?: unknown;
  readonly groups?: unknown;
}): boolean {
  if (block.kind !== "diagram") return false;
  return anyItemCarries(block.edges, ["style", "tone"]) || anyItemCarries(block.groups, ["tone"]);
}

/** Whether a role is one the layout draws as a shape. */
export function isCanvasDiagramNodeRole(role: unknown): role is CanvasDiagramNodeRole {
  return CANVAS_DIAGRAM_NODE_ROLES.some((known) => known === role);
}

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

export const CanvasPlanView = Schema.Literal("checklist", "kanban", "timeline", "gantt");
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
// The library wave: controls a screen's chrome needs (search, breadcrumb,
// pagination, stepper, progress, slider, menu), its editorial shapes (hero,
// footer, media, map), and a conversation (chat, chat-message). Plus what a
// block may hold beside them: declared images and reusable definitions.
export const CANVAS_MOCKUP_LIBRARY_SCHEMA_VERSION = 24;
export const CANVAS_MOCKUP_LIBRARY_COMPONENTS = [
  "search",
  "breadcrumb",
  "pagination",
  "stepper",
  "progress",
  "slider",
  "menu",
  "footer",
  "hero",
  "media",
  "map",
  "chat",
  "chat-message",
  "instance",
] as const;
export const CanvasMockupComponent = Schema.Literal(
  ...CANVAS_MOCKUP_LEGACY_COMPONENTS,
  ...CANVAS_MOCKUP_CATALOG_COMPONENTS,
  ...CANVAS_MOCKUP_LIBRARY_COMPONENTS,
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
  /** A progress bar's or slider's reading, or a stepper's current step, 0 to 100. */
  progress: Schema.optional(Schema.Int.pipe(Schema.nonNegative(), Schema.lessThanOrEqualTo(100))),
  /** The reusable definition an instance places. */
  defId: Schema.optional(boundedToken("CanvasMockupDefId")),
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

/** One reusable local component: a fixed subtree placed by instances. */
export const CanvasMockupDefinition = Schema.Struct({
  defId: boundedToken("CanvasMockupDefId"),
  label: CanvasMockupText,
  nodes: Schema.Array(CanvasMockupNode).pipe(
    Schema.minItems(1),
    Schema.maxItems(CANVAS_MAX_MOCKUP_DEFINITION_NODES),
  ),
}).annotations(strict);
export type CanvasMockupDefinition = typeof CanvasMockupDefinition.Type;

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
  /** Local components this block's instances place. */
  definitions: Schema.optional(
    Schema.Array(CanvasMockupDefinition).pipe(Schema.maxItems(CANVAS_MAX_MOCKUP_DEFINITIONS)),
  ),
}).annotations(strict);
export type CanvasMockupBlock = typeof CanvasMockupBlock.Type;

/**
 * What a design frame is drawn as: a phone, a tablet, a desktop window or web
 * page, or a 16:9 slide, each at a fixed viewport, or a `document` as wide as
 * the Canvas column and as tall as its content, such as an article or a spec.
 */
export const CanvasDesignSize = Schema.Literal("phone", "tablet", "desktop", "slide", "document");
export type CanvasDesignSize = typeof CanvasDesignSize.Type;
/** The sizes drawn at a fixed viewport and scaled to fit. */
export type CanvasDesignDeviceSize = Exclude<CanvasDesignSize, "document">;

/**
 * Whether a design frame is drawn in Octant's theme (`workspace`: its colour
 * tokens, light or dark as the workspace is, its fonts, and the frame kit's
 * classes) or as the author's page alone (`none`). A document defaults to
 * `workspace`; a device size defaults to `none`, so a product screen keeps its
 * own brand. `brand` draws the page with the design's own `brand` tokens.
 */
export const CanvasDesignTheme = Schema.Literal("workspace", "none", "brand");
export type CanvasDesignTheme = typeof CanvasDesignTheme.Type;

/**
 * Whether a design uses anything version 13 introduced: the document size or
 * a declared theme. Reads loose fields so the domain's declared-version check
 * can ask the same question of a document that did not decode.
 */
export function canvasDesignUsesDocumentFields(block: {
  readonly kind?: unknown;
  readonly size?: unknown;
  readonly theme?: unknown;
}): boolean {
  return block.kind === "design" && (block.size === "document" || block.theme !== undefined);
}

/**
 * Whether a design declares image assets, which version 17 introduced. Reads
 * loose fields so the domain's declared-version check can ask the same
 * question of a document that did not decode.
 */
export function canvasDesignUsesAssets(block: {
  readonly kind?: unknown;
  readonly assets?: unknown;
}): boolean {
  return block.kind === "design" && block.assets !== undefined;
}

/**
 * Whether a design declares that it runs script, which version 18 introduced.
 * Reads loose fields so the domain's declared-version check can ask the same
 * question of a document that did not decode.
 */
export function canvasDesignRunsScript(block: {
  readonly kind?: unknown;
  readonly runsScript?: unknown;
}): boolean {
  return block.kind === "design" && block.runsScript !== undefined;
}

/**
 * Whether a design uses anything version 21 introduced: a frame's notes, the
 * brand theme or tokens, or a captured page as an asset. Reads loose fields
 * so the domain's declared-version check can ask the same question of a
 * document that did not decode.
 */
export function canvasDesignUsesDesignFields(block: {
  readonly kind?: unknown;
  readonly theme?: unknown;
  readonly brand?: unknown;
  readonly frames?: unknown;
  readonly assets?: unknown;
}): boolean {
  if (block.kind !== "design") return false;
  if (block.theme === "brand" || block.brand !== undefined) return true;
  if (anyItemCarries(block.frames, ["notes"])) return true;
  return (
    Array.isArray(block.assets) &&
    block.assets.some(
      (asset: unknown) =>
        typeof asset === "object" &&
        asset !== null &&
        (asset as { source?: { kind?: unknown } }).source?.kind === "browser-capture",
    )
  );
}

/** The CSS viewport each device size is drawn at. Authors lay frames out against it. */
export const CANVAS_DESIGN_VIEWPORT: Readonly<
  Record<CanvasDesignDeviceSize, { readonly width: number; readonly height: number }>
> = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
  slide: { width: 1920, height: 1080 },
};

export const CanvasDesignFrameId = boundedToken("CanvasDesignFrameId");
export const CanvasDesignMarkup = boundedText(CANVAS_MAX_DESIGN_MARKUP_LENGTH);

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
  /** Plain-text notes for the presenter or reviewer; shown as text, never as markup. */
  notes: Schema.optional(boundedNonEmptyText(CANVAS_MAX_DESIGN_NOTES_LENGTH)),
}).annotations(strict);
export type CanvasDesignFrame = typeof CanvasDesignFrame.Type;

/**
 * The name markup gives a declared asset after the scheme: `octant-asset:hero`.
 * Letters, digits, dots, dashes, and underscores, so a reference ends at the
 * quote, parenthesis, or space around it wherever it is written.
 */
export const CanvasDesignAssetId = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  Schema.brand("CanvasDesignAssetId"),
);
export type CanvasDesignAssetId = typeof CanvasDesignAssetId.Type;

/**
 * Where a declared image comes from. A `generated-image` is a completed image
 * an image job made in a thread of the Canvas's own Project, named by its
 * attachment id. A `project-file` is a path relative to the folder a Work
 * thread is bound to or the checkout a Code thread is bound to; a Chat
 * Project has no folder, so it never resolves one. The definition holds only
 * the reference: the host resolves it under the thread's authority each time
 * the design is drawn, and the bytes are never journaled. A `browser-capture`
 * names a screenshot the Browser kept for the Canvas's own thread; the Browser
 * is a Work and Code tool, so a Chat Canvas refuses it.
 */
export const CanvasDesignAssetSource = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("generated-image"),
    imageId: ImageArtifactId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("project-file"),
    path: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("browser-capture"),
    captureId: BrowserCaptureId,
  }).annotations(strict),
);
export type CanvasDesignAssetSource = typeof CanvasDesignAssetSource.Type;

export const CanvasDesignAsset = Schema.Struct({
  assetId: CanvasDesignAssetId,
  source: CanvasDesignAssetSource,
  /** What the image shows, for the author's own reference and the warnings. */
  description: Schema.optional(CanvasMockupText),
}).annotations(strict);
export type CanvasDesignAsset = typeof CanvasDesignAsset.Type;

/**
 * Screens of an app or site, or the slides of a deck, written as HTML and CSS.
 * `styles` is one stylesheet every frame shares. `assets` declares the images
 * the frames and styles may name with `octant-asset:<assetId>`. `runsScript`
 * makes the design a running prototype: its inline script and event handlers
 * run in a frame the host serves with its own policy, which still loads
 * nothing from the network. A design without it runs nothing.
 */
export const CanvasDesignBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("design"),
  title: CanvasMockupText,
  size: CanvasDesignSize,
  theme: Schema.optional(CanvasDesignTheme),
  brand: Schema.optional(CanvasDesignBrand),
  runsScript: Schema.optional(Schema.Literal(true)),
  styles: Schema.optional(CanvasDesignMarkup),
  assets: Schema.optional(
    Schema.Array(CanvasDesignAsset).pipe(Schema.maxItems(CANVAS_MAX_DESIGN_ASSETS)),
  ),
  frames: Schema.Array(CanvasDesignFrame).pipe(
    Schema.minItems(1),
    Schema.maxItems(CANVAS_MAX_DESIGN_FRAMES),
  ),
}).annotations(strict);
export type CanvasDesignBlock = typeof CanvasDesignBlock.Type;

/** Whether a plan names the Gantt view, which arrived at the diagram-styles version. */
export function canvasPlanUsesGantt(block: {
  readonly kind?: unknown;
  readonly view?: unknown;
}): boolean {
  return block.kind === "plan" && block.view === "gantt";
}

/** The image types a design asset may resolve to, read from the bytes. */
export const CanvasDesignAssetMediaType = Schema.Literal(
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
);
export type CanvasDesignAssetMediaType = typeof CanvasDesignAssetMediaType.Type;

/**
 * Why a declared asset is drawn as a placeholder. `missing`: nothing by that
 * reference exists, or it was deleted. `refused`: it exists but lies outside
 * this Canvas's authority, such as another Project's image, a path that
 * leaves the folder, or a file asked for in Chat. `too-large`: past the
 * per-image budget. `design-budget`: the design's earlier images already
 * spent its budget. `not-an-image`: the bytes are not a PNG, JPEG, GIF, or
 * WebP.
 */
export const CanvasDesignAssetUnavailableReason = Schema.Literal(
  "missing",
  "refused",
  "too-large",
  "design-budget",
  "not-an-image",
);
export type CanvasDesignAssetUnavailableReason = typeof CanvasDesignAssetUnavailableReason.Type;

export const CanvasDesignAssetResolution = Schema.Union(
  Schema.Struct({
    assetId: CanvasDesignAssetId,
    status: Schema.Literal("resolved"),
    mediaType: CanvasDesignAssetMediaType,
    // Base64 of at most the per-image budget.
    data: Schema.String.pipe(
      Schema.maxLength(Math.ceil(CANVAS_DESIGN_ASSET_MAX_BYTES / 3) * 4),
      Schema.pattern(/^[A-Za-z0-9+/]*={0,2}$/),
    ),
  }).annotations(strict),
  Schema.Struct({
    assetId: CanvasDesignAssetId,
    status: Schema.Literal("unavailable"),
    reason: CanvasDesignAssetUnavailableReason,
  }).annotations(strict),
);
export type CanvasDesignAssetResolution = typeof CanvasDesignAssetResolution.Type;

/**
 * One design's declared images as the host resolved them for this reader,
 * now. Never stored: a reader asks again each time it draws the design.
 */
export const CanvasDesignAssetsOutcome = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("ready"),
    canvasId: CanvasId,
    versionId: CanvasVersionId,
    blockId: CanvasBlockId,
    assets: Schema.Array(CanvasDesignAssetResolution).pipe(
      Schema.maxItems(CANVAS_MAX_DESIGN_ASSETS),
    ),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("unauthorized"), canvasId: CanvasId }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    canvasId: CanvasId,
    reason: boundedNonEmptyText(512),
  }).annotations(strict),
);
export type CanvasDesignAssetsOutcome = typeof CanvasDesignAssetsOutcome.Type;

// ── Flow ──────────────────────────────────────────────────────────────────────
//
// A flow composes screens the document already holds into one board: each
// screen is a reference (a mockup variant, or one frame of a design that runs
// no script), and the edges are the transitions between them. The block owns
// the graph alone — the mockup or design keeps the screen's content — so the
// board is cheap inside the block budget and a revision to a screen shows on
// every flow that names it.

/**
 * Whether a mockup uses anything the library wave added: one of its
 * components, a node's progress reading or definition reference, or reusable
 * definitions. Reads loose fields so the domain's declared-version check can
 * ask the same question of a document that did not decode.
 */
export function canvasMockupUsesLibrary(block: {
  readonly kind?: unknown;
  readonly nodes?: unknown;
  readonly definitions?: unknown;
}): boolean {
  if (block.kind !== "mockup") return false;
  if (block.definitions !== undefined) return true;
  const library = new Set<string>(CANVAS_MOCKUP_LIBRARY_COMPONENTS);
  const nodes: ReadonlyArray<unknown> = Array.isArray(block.nodes) ? block.nodes : [];
  return nodes.some(
    (node) =>
      typeof node === "object" &&
      node !== null &&
      (("component" in node && typeof node.component === "string" && library.has(node.component)) ||
        ("defId" in node && node.defId !== undefined) ||
        ("progress" in node && node.progress !== undefined)),
  );
}

/**
 * The mockup components a flow edge may start from. A hotspot is a control a
 * person could tap, so the interactive list is closed: naming one is data the
 * renderer can draw as a link without a script, and a text or image node is
 * refused rather than guessed at.
 */
export const CANVAS_FLOW_HOTSPOT_COMPONENTS = [
  "button",
  "list-row",
  "nav",
  "tabs",
  "select",
  "checkbox",
  "toggle",
  "search",
  "menu",
  "pagination",
  "stepper",
  "slider",
] as const;
export type CanvasFlowHotspotComponent = (typeof CANVAS_FLOW_HOTSPOT_COMPONENTS)[number];
export const CanvasFlowHotspotComponent = Schema.Literal(...CANVAS_FLOW_HOTSPOT_COMPONENTS);

/**
 * One screen on the board: a mockup block at one variant (absent is its
 * single frame), or one frame of a design that runs no script. `x` and `y`
 * are a journaled placement, set by a person's drag through the layout-revise
 * path, and `positioned` says the placement is authoritative.
 */
export const CanvasFlowScreen = Schema.Struct({
  screenId: CanvasNodeId,
  blockId: CanvasBlockId,
  /** One variant of a mockup; absent is its single frame. */
  variantId: Schema.optional(CanvasMockupVariantId),
  /** One frame of a design that runs no script; required when the block is a design. */
  frameId: Schema.optional(CanvasDesignFrameId),
  x: Schema.optional(FiniteNumber),
  y: Schema.optional(FiniteNumber),
  positioned: Schema.optional(Schema.Literal(true)),
}).annotations(strict);
export type CanvasFlowScreen = typeof CanvasFlowScreen.Type;

/**
 * One transition between two screens of the same flow. `fromNodeId` names the
 * hotspot the person taps, a node of the from-screen's mockup from the
 * interactive list; absent is a screen-level link, and a design screen has no
 * hotspots, so an edge from one always omits it.
 */
/** A numbered callout pinned to a flow screen; its number is its place in the list, and a comment on it anchors to the screen's node. */
export const CanvasFlowAnnotation = Schema.Struct({
  nodeId: CanvasNodeId,
  note: boundedNonEmptyText(CANVAS_MAX_FLOW_ANNOTATION_LENGTH),
}).annotations(strict);
export type CanvasFlowAnnotation = typeof CanvasFlowAnnotation.Type;

export const CanvasFlowEdge = Schema.Struct({
  edgeId: CanvasEdgeId,
  fromScreenId: CanvasNodeId,
  toScreenId: CanvasNodeId,
  fromNodeId: Schema.optional(CanvasNodeId),
  label: Schema.optional(boundedNonEmptyText(CANVAS_MAX_FLOW_LABEL_LENGTH)),
  tone: Schema.optional(CanvasDiagramTone),
}).annotations(strict);
export type CanvasFlowEdge = typeof CanvasFlowEdge.Type;

/**
 * A flow block: the screens of one app or site, connected. The layout is
 * `auto` until a person drags a screen, which journals `manual` positions,
 * exactly as a diagram board does.
 */
export const CanvasFlowBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("flow"),
  title: CanvasLabel,
  layout: Schema.optional(CanvasDiagramLayoutKind),
  screens: Schema.Array(CanvasFlowScreen).pipe(
    Schema.minItems(1),
    Schema.maxItems(CANVAS_MAX_FLOW_SCREENS),
  ),
  edges: Schema.Array(CanvasFlowEdge).pipe(Schema.maxItems(CANVAS_MAX_FLOW_EDGES)),
  annotations: Schema.optional(
    Schema.Array(CanvasFlowAnnotation).pipe(Schema.maxItems(CANVAS_MAX_FLOW_ANNOTATIONS)),
  ),
}).annotations(strict);
export type CanvasFlowBlock = typeof CanvasFlowBlock.Type;

/** Whether a flow carries callouts, which arrived at the annotations version. */
export function canvasFlowUsesAnnotations(block: {
  readonly kind?: unknown;
  readonly annotations?: unknown;
}): boolean {
  return block.kind === "flow" && Array.isArray(block.annotations) && block.annotations.length > 0;
}

// ── Deck ──────────────────────────────────────────────────────────────────────
//
// A deck presents what the document already holds, in the order the author
// chooses: a design's frame, a mockup screen, or a data block, each with the
// presenter's own notes. It references rather than copies, so a slide keeps
// its block's one definition, comments, and identity, and Present walks the
// set across blocks.

/** The block kinds a slide may show. */
export const CANVAS_DECK_SLIDE_KINDS = [
  "design",
  "mockup",
  "chart",
  "table",
  "metric",
  "progress",
  "status",
] as const;
export type CanvasDeckSlideKind = (typeof CANVAS_DECK_SLIDE_KINDS)[number];

/**
 * One slide: a block the document holds, with the frames and variants named
 * where the block has them, and the presenter's own notes, which never
 * leave the host.
 */
export const CanvasDeckSlide = Schema.Struct({
  slideId: CanvasNodeId,
  blockId: CanvasBlockId,
  /** A design slide names the frame it shows; required for a design. */
  frameId: Schema.optional(CanvasDesignFrameId),
  /** A mockup slide names the variant it shows; required when the mockup declares variants. */
  variantId: Schema.optional(CanvasMockupVariantId),
  notes: Schema.optional(boundedNonEmptyText(CANVAS_MAX_DESIGN_NOTES_LENGTH)),
}).annotations(strict);
export type CanvasDeckSlide = typeof CanvasDeckSlide.Type;

export const CanvasDeckBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("deck"),
  title: CanvasLabel,
  slides: Schema.Array(CanvasDeckSlide).pipe(
    Schema.minItems(2),
    Schema.maxItems(CANVAS_MAX_DECK_SLIDES),
  ),
}).annotations(strict);
export type CanvasDeckBlock = typeof CanvasDeckBlock.Type;

/**
 * Where the host serves a running design's page. A reader never names a
 * design here: the only query is a ticket the host issued for one Canvas
 * version, design, and start frame.
 */
export const CANVAS_DESIGN_PAGE_PATH = "/api/canvas/design-page";
/**
 * How long a running design's ticket lasts. The reader loads the page as soon
 * as it holds the ticket, so a few seconds is enough, and a ticket copied out
 * of a frame's address is useless almost at once.
 */
export const CANVAS_DESIGN_RUN_TICKET_TTL_MS = 10_000;
/**
 * The bridge a running page talks to its host through. The host writes the
 * bridge script first in the page; it posts the page's height, its script
 * errors, and a heartbeat every interval, and nothing else. Agent script can
 * post the same messages, so the host treats each one as a claim to bound,
 * never as a command.
 */
export const CANVAS_DESIGN_BRIDGE_CHANNEL = "octant-design-frame@1";
export const CANVAS_DESIGN_HEARTBEAT_INTERVAL_MS = 1_000;
export const CANVAS_DESIGN_BRIDGE_MAX_ERROR_LENGTH = 280;

export const CanvasDesignRunRequest = Schema.Struct({
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  blockId: CanvasBlockId,
  /** The frame the page opens on; the design's first frame when omitted. */
  frameId: Schema.optional(CanvasDesignFrameId),
}).annotations(strict);
export type CanvasDesignRunRequest = typeof CanvasDesignRunRequest.Type;

/**
 * A running design's page, offered to one reader once. `page` is a path on
 * the host holding a single-use ticket; the reader loads it in a frame
 * sandboxed to `allow-scripts` alone, so the page's origin is opaque.
 */
export const CanvasDesignRunOutcome = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("ready"),
    canvasId: CanvasId,
    versionId: CanvasVersionId,
    blockId: CanvasBlockId,
    page: Schema.String.pipe(
      Schema.pattern(/^\/api\/canvas\/design-page\?ticket=[A-Za-z0-9_-]{43}$/),
    ),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("unauthorized"), canvasId: CanvasId }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    canvasId: CanvasId,
    reason: boundedNonEmptyText(512),
  }).annotations(strict),
);
export type CanvasDesignRunOutcome = typeof CanvasDesignRunOutcome.Type;

/**
 * Asks to run the page a thread's tool call published (a Claude artifact),
 * from the host's own snapshot of it. The host finds the snapshot in that
 * thread's journal under the window's read authority; nothing the request
 * carries becomes the page.
 */
export const PublishedSnapshotRunRequest = Schema.Struct({
  mode: Schema.Literal("work", "code"),
  threadId: Schema.UUID,
  toolCallId: boundedNonEmptyText(255),
}).annotations(strict);
export type PublishedSnapshotRunRequest = typeof PublishedSnapshotRunRequest.Type;

/** A published snapshot's running page, offered once, under the design page's rules. */
export const PublishedSnapshotRunOutcome = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("ready"),
    page: Schema.String.pipe(
      Schema.pattern(/^\/api\/canvas\/design-page\?ticket=[A-Za-z0-9_-]{43}$/),
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: boundedNonEmptyText(512),
  }).annotations(strict),
);
export type PublishedSnapshotRunOutcome = typeof PublishedSnapshotRunOutcome.Type;

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

/**
 * The block kinds a dashboard may place. A dashboard is never among them, so
 * a grid never holds a grid; neither does prose, a diagram, or an action,
 * which read as a document rather than at a glance.
 */
export const CANVAS_DASHBOARD_CELL_KINDS = [
  "metric",
  "progress",
  "status",
  "chart",
  "table",
] as const;
export type CanvasDashboardCellKind = (typeof CANVAS_DASHBOARD_CELL_KINDS)[number];

/**
 * One place on the grid. It names a block elsewhere in the same document
 * rather than holding a copy, so the block keeps its own id, its comments,
 * and its one definition; `span` is how many columns it takes on a wide grid.
 */
export const CanvasDashboardCell = Schema.Struct({
  blockId: CanvasBlockId,
  span: Schema.optional(Schema.Int.pipe(Schema.between(1, CANVAS_MAX_DASHBOARD_COLUMNS))),
}).annotations(strict);
export type CanvasDashboardCell = typeof CanvasDashboardCell.Type;

/**
 * A KPI dashboard: a titled grid of the document's metric, progress, status,
 * chart, and table blocks. The grid is drawn where the dashboard sits, its
 * cells in the order listed, and each placed block is drawn there instead of
 * at its own position. A layout block rather than a document-level field, so
 * it is version-gated, revised, commented on, and described like every other
 * kind, and a Canvas can hold a dashboard beside ordinary prose.
 */
export const CanvasDashboardBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("dashboard"),
  /** Names the region a screen reader lands on. */
  title: CanvasLabel,
  /** Columns on a wide grid; absent means four. Narrow widths draw one. */
  columns: Schema.optional(Schema.Int.pipe(Schema.between(1, CANVAS_MAX_DASHBOARD_COLUMNS))),
  cells: Schema.NonEmptyArray(CanvasDashboardCell).pipe(
    Schema.maxItems(CANVAS_MAX_DASHBOARD_CELLS),
  ),
}).annotations(strict);
export type CanvasDashboardBlock = typeof CanvasDashboardBlock.Type;

/**
 * Layout groups: tabs and columns arrange blocks the document already holds.
 *
 * A group names its children by block id rather than nesting them, so every
 * child keeps the identity a comment anchors to and a revision edits, and the
 * version envelope stays inside the depth budget. Groups are one level deep:
 * the domain policy refuses a child that is itself a group, a child named
 * twice, and a name that holds no block. Which tab is selected is the
 * reader's view state; it is never part of the document.
 */
export const CanvasTabsPane = Schema.Struct({
  label: boundedNonEmptyText(CANVAS_MAX_TABS_LABEL_LENGTH),
  blockIds: Schema.NonEmptyArray(CanvasBlockId).pipe(Schema.maxItems(CANVAS_MAX_BLOCKS)),
}).annotations(strict);
export type CanvasTabsPane = typeof CanvasTabsPane.Type;

export const CanvasTabsBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("tabs"),
  panes: Schema.Array(CanvasTabsPane).pipe(
    Schema.minItems(2),
    Schema.maxItems(CANVAS_MAX_TABS_PANES),
  ),
}).annotations(strict);
export type CanvasTabsBlock = typeof CanvasTabsBlock.Type;

export const CanvasColumnTrack = Schema.Struct({
  blockIds: Schema.NonEmptyArray(CanvasBlockId).pipe(Schema.maxItems(CANVAS_MAX_BLOCKS)),
}).annotations(strict);
export type CanvasColumnTrack = typeof CanvasColumnTrack.Type;

export const CanvasColumnsBlock = Schema.Struct({
  ...CanvasBlockFields,
  kind: Schema.Literal("columns"),
  tracks: Schema.Array(CanvasColumnTrack).pipe(
    Schema.minItems(CANVAS_MIN_COLUMN_TRACKS),
    Schema.maxItems(CANVAS_MAX_COLUMN_TRACKS),
  ),
}).annotations(strict);
export type CanvasColumnsBlock = typeof CanvasColumnsBlock.Type;

export type CanvasLayoutGroupBlock = CanvasTabsBlock | CanvasColumnsBlock;

/** Whether a block is a layout group, which may name children but never be one. */
export function isCanvasLayoutGroup(block: { readonly kind?: unknown }): boolean {
  return block.kind === "tabs" || block.kind === "columns";
}

/** The child block ids a layout group names, in reading order. */
export function canvasLayoutGroupChildIds(
  block: CanvasLayoutGroupBlock,
): ReadonlyArray<CanvasBlockId> {
  return block.kind === "tabs"
    ? block.panes.flatMap((pane) => pane.blockIds)
    : block.tracks.flatMap((track) => track.blockIds);
}

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
  CanvasDashboardBlock,
  // Typed actions (Canvas D). The block is a declarative reference to an
  // allowlisted command; the server reauthorizes every action before any side
  // effect, so union membership never makes a definition executable.
  CanvasActionBlock,
  CanvasTabsBlock,
  CanvasColumnsBlock,
  CanvasFlowBlock,
  CanvasDeckBlock,
);
export type CanvasBlock = typeof CanvasBlock.Type;

// Where the author asked the originating thread to show a Canvas. `inline`
// asks for the document in the conversation; `sidebar` shows a card that opens
// it beside the thread. On a definition this is the request as asked, not
// where the thread shows it: a Canvas asked for inline that holds a block the
// thread does not draw is a sidebar Canvas, so a reader places it by the
// effective value (the thread reference card's `presentation`), never by this
// field alone. Either way the Canvas is one journaled object: the hint never
// copies it.
export const CanvasPresentation = Schema.Literal("inline", "sidebar");
export type CanvasPresentation = typeof CanvasPresentation.Type;

/**
 * The loose shape the version gates read: enough of a definition to ask
 * whether it carries a gated kind or hint, without requiring it to decode.
 */
interface CanvasVersionGateInput {
  readonly schemaVersion: number;
  readonly presentation?: unknown;
  readonly provenance: unknown;
  readonly blocks: ReadonlyArray<Record<string, unknown>>;
}

/** One version floor: what a document must not carry before the version that introduced it. */
interface CanvasVersionGate {
  /** The Canvas schema version that introduced the gated thing. */
  readonly since: number;
  /** Whether the document carries the gated thing. */
  readonly carries: (definition: CanvasVersionGateInput) => boolean;
  /** What the floor requires, as the author reads it. */
  readonly requirement: string;
}

const ofKind =
  (kind: string) =>
  (definition: CanvasVersionGateInput): boolean =>
    definition.blocks.some((block) => block.kind === kind);

/**
 * Every version floor the definition schema holds, in the order they shipped.
 * `carries` reads loose shapes, so the check asks the same question of a
 * document that did not decode.
 */
const CANVAS_VERSION_GATES: readonly CanvasVersionGate[] = [
  {
    since: CANVAS_MOCKUP_SCHEMA_VERSION,
    carries: ofKind("mockup"),
    requirement: `Mockup blocks require Canvas schema version ${String(CANVAS_MOCKUP_SCHEMA_VERSION)} or newer.`,
  },
  {
    since: CANVAS_THREAD_OWNED_SCHEMA_VERSION,
    carries: (definition) =>
      typeof definition.provenance === "object" &&
      definition.provenance !== null &&
      canvasProvenanceIsThreadOwned(definition.provenance),
    requirement: `A Canvas owned by its thread requires Canvas schema version ${String(CANVAS_THREAD_OWNED_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_PRESENTATION_SCHEMA_VERSION,
    carries: (definition) => definition.presentation !== undefined,
    requirement: `A thread presentation requires Canvas schema version ${String(CANVAS_PRESENTATION_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_TREEMAP_SCHEMA_VERSION,
    carries: ofKind("treemap"),
    requirement: `Treemap blocks require Canvas schema version ${String(CANVAS_TREEMAP_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_HEATMAP_SCHEMA_VERSION,
    carries: ofKind("heatmap"),
    requirement: `Heatmap blocks require Canvas schema version ${String(CANVAS_HEATMAP_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_BAR_LIST_SCHEMA_VERSION,
    carries: ofKind("bar-list"),
    requirement: `Bar-list blocks require Canvas schema version ${String(CANVAS_BAR_LIST_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_DIAGRAM_KINDS_SCHEMA_VERSION,
    carries: (definition) =>
      definition.blocks.some(
        (block) => block.kind === "er" || block.kind === "swimlane" || block.kind === "mindmap",
      ),
    requirement: `Entity-relationship, swimlane, and mind map blocks require Canvas schema version ${String(CANVAS_DIAGRAM_KINDS_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_METRIC_TREND_SCHEMA_VERSION,
    carries: (definition) => definition.blocks.some(canvasMetricUsesTrendFields),
    requirement: `A metric sparkline, goodDirection, or caption requires Canvas schema version ${String(CANVAS_METRIC_TREND_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_DESIGN_SCHEMA_VERSION,
    carries: ofKind("design"),
    requirement: `Design blocks require Canvas schema version ${String(CANVAS_DESIGN_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_COMPARISON_MATRIX_SCHEMA_VERSION,
    carries: ofKind("comparison-matrix"),
    requirement: `Comparison matrix blocks require Canvas schema version ${String(CANVAS_COMPARISON_MATRIX_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_MATH_SCHEMA_VERSION,
    carries: ofKind("math"),
    requirement: `Math blocks require Canvas schema version ${String(CANVAS_MATH_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_MOCKUP_CATALOG_SCHEMA_VERSION,
    carries: (definition) => definition.blocks.some(canvasMockupUsesCatalog),
    requirement: `A mockup's catalog components, devices, fidelity, variants, callouts, or more than ${String(CANVAS_MOCKUP_LEGACY_MAX_NODES)} nodes require Canvas schema version ${String(CANVAS_MOCKUP_CATALOG_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_TABLE_ROW_ID_SCHEMA_VERSION,
    carries: (definition) => definition.blocks.some(canvasTableUsesRowIds),
    requirement: `A table row id requires Canvas schema version ${String(CANVAS_TABLE_ROW_ID_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_FLOW_CHARTS_SCHEMA_VERSION,
    carries: (definition) => definition.blocks.some(canvasChartUsesFlowTypes),
    requirement: `Funnel, radar, and sankey charts require Canvas schema version ${String(CANVAS_FLOW_CHARTS_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_DASHBOARD_SCHEMA_VERSION,
    carries: ofKind("dashboard"),
    requirement: `Dashboard blocks require Canvas schema version ${String(CANVAS_DASHBOARD_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_DESIGN_DOCUMENT_SCHEMA_VERSION,
    carries: (definition) => definition.blocks.some(canvasDesignUsesDocumentFields),
    requirement: `A design document size or theme requires Canvas schema version ${String(CANVAS_DESIGN_DOCUMENT_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_DESIGN_ASSET_SCHEMA_VERSION,
    carries: (definition) => definition.blocks.some(canvasDesignUsesAssets),
    requirement: `Design assets require Canvas schema version ${String(CANVAS_DESIGN_ASSET_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_DESIGN_RUNNING_SCHEMA_VERSION,
    carries: (definition) => definition.blocks.some(canvasDesignRunsScript),
    requirement: `A design that runs script requires Canvas schema version ${String(CANVAS_DESIGN_RUNNING_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_LAYOUT_GROUPS_SCHEMA_VERSION,
    carries: (definition) => definition.blocks.some(isCanvasLayoutGroup),
    requirement: `Tabs and columns require Canvas schema version ${String(CANVAS_LAYOUT_GROUPS_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_DIAGRAM_STYLES_SCHEMA_VERSION,
    carries: (definition) =>
      definition.blocks.some(
        (block) => canvasDiagramUsesStyles(block) || canvasPlanUsesGantt(block),
      ),
    requirement: `Diagram edge styles and tones, group tones, and the plan's Gantt view require Canvas schema version ${String(CANVAS_DIAGRAM_STYLES_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_DESIGN_FIELDS_SCHEMA_VERSION,
    carries: (definition) =>
      definition.blocks.some(
        (block) => canvasDesignUsesDesignFields(block) || canvasDiagramUsesRichFields(block),
      ),
    requirement: `Frame notes, brand tokens, captured-page assets, and diagram icons, details, and nested groups require Canvas schema version ${String(CANVAS_DESIGN_FIELDS_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_CHART_CALLOUTS_SCHEMA_VERSION,
    carries: (definition) => definition.blocks.some(canvasChartUsesCallouts),
    requirement: `A chart title, subtitle, point note, or point emphasis requires Canvas schema version ${String(CANVAS_CHART_CALLOUTS_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_FLOW_SCHEMA_VERSION,
    carries: ofKind("flow"),
    requirement: `Flow blocks require Canvas schema version ${String(CANVAS_FLOW_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_MOCKUP_LIBRARY_SCHEMA_VERSION,
    carries: (definition) => definition.blocks.some(canvasMockupUsesLibrary),
    requirement: `The mockup library requires Canvas schema version ${String(CANVAS_MOCKUP_LIBRARY_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_DECK_SCHEMA_VERSION,
    carries: ofKind("deck"),
    requirement: `A deck block requires Canvas schema version ${String(CANVAS_DECK_SCHEMA_VERSION)}.`,
  },
  {
    since: CANVAS_FLOW_ANNOTATIONS_SCHEMA_VERSION,
    carries: (definition) => definition.blocks.some(canvasFlowUsesAnnotations),
    requirement: `Flow callouts require Canvas schema version ${String(CANVAS_FLOW_ANNOTATIONS_SCHEMA_VERSION)}.`,
  },
];

/**
 * Whether a document carries nothing a later floor introduced than it
 * declares. The decode filter below and the domain's declared-version check
 * both ask this one question, so a new gate is one row in the table.
 */
export function canvasCarriesNoLaterFloor(definition: CanvasVersionGateInput): boolean {
  return CANVAS_VERSION_GATES.every(
    (gate) => definition.schemaVersion >= gate.since || !gate.carries(definition),
  );
}

/** The floor a document failed, as the author reads it; the first failing floor wins. */
export function canvasLaterFloorMessage(actual: unknown): string {
  if (typeof actual === "object" && actual !== null) {
    const candidate = actual as CanvasVersionGateInput;
    if (typeof candidate.schemaVersion === "number" && Array.isArray(candidate.blocks)) {
      const failed = CANVAS_VERSION_GATES.find(
        (gate) => candidate.schemaVersion < gate.since && gate.carries(candidate),
      );
      if (failed !== undefined) return failed.requirement;
    }
  }
  return "A block or field in this Canvas requires a newer Canvas schema version than the document declares.";
}

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
    // Version-gated blocks and hints: a rolled-back runtime that never
    // learned a kind or hint must see a document carrying it as a declared
    // future version, not as a document that failed to decode. Each gate
    // keeps its own floor so an earlier document stays valid. The gates are
    // data, not a pipe of filters: the chain of `Schema.filter` steps once
    // crossed Effect's inference-depth cliff (a definition's type degraded to
    // unknown in downstream typechecks), and a table cannot — a new floor is
    // a new row.
    Schema.filter((definition) => canvasCarriesNoLaterFloor(definition), {
      message: (issue) => canvasLaterFloorMessage(issue.actual),
    }),
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
export const decodeCanvasDesignAssetsOutcome = Schema.decodeUnknownSync(CanvasDesignAssetsOutcome);
export const decodeCanvasDesignRunRequest = Schema.decodeUnknownSync(CanvasDesignRunRequest);
export const decodeCanvasDesignRunOutcome = Schema.decodeUnknownSync(CanvasDesignRunOutcome);
export const decodePublishedSnapshotRunRequest = Schema.decodeUnknownSync(
  PublishedSnapshotRunRequest,
);
export const decodePublishedSnapshotRunOutcome = Schema.decodeUnknownSync(
  PublishedSnapshotRunOutcome,
);

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
