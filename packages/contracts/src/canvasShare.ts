import { EXPORT_SENSITIVE_QUERY_KEYS, isCanvasShareSafeText } from "./canvasExportText";
import { GuidString, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
export { isCanvasShareSafeText, isExportCredentialFreeText } from "./canvasExportText";
import { Schema } from "effect";
import {
  CANVAS_MAX_BAR_LIST_ROWS,
  CANVAS_MAX_CHOICE_PROMPT_LENGTH,
  CANVAS_MAX_CHOICE_SECTION_INTRO_LENGTH,
  CANVAS_MAX_CHOICE_SECTION_TITLE_LENGTH,
  CANVAS_MAX_DASHBOARD_CELLS,
  CANVAS_MAX_DESIGN_FRAMES,
  CANVAS_MAX_DIAGRAM_DETAIL_LENGTH,
  CANVAS_MAX_DASHBOARD_COLUMNS,
  CANVAS_MAX_CHART_CATEGORY_LABEL_LENGTH,
  CANVAS_MAX_FLOW_EDGES,
  CANVAS_MAX_FLOW_LABEL_LENGTH,
  CANVAS_MAX_DECK_SLIDES,
  CANVAS_MAX_FLOW_ANNOTATIONS,
  CANVAS_MAX_FLOW_ANNOTATION_LENGTH,
  CANVAS_MAX_FLOW_SCREENS,
  CANVAS_MAX_HEATMAP_CELLS,
  CANVAS_MAX_HEATMAP_COLUMNS,
  CANVAS_MAX_HEATMAP_DAYS,
  CANVAS_MAX_HEATMAP_ROWS,
  CANVAS_MAX_MATRIX_CELLS,
  CANVAS_MAX_MATRIX_CELL_TEXT_LENGTH,
  CANVAS_MAX_MATRIX_CRITERIA,
  CANVAS_MAX_MATRIX_NOTE_LENGTH,
  CANVAS_MAX_MATRIX_OPTIONS,
  CANVAS_MAX_MATRIX_WEIGHT,
  CANVAS_MAX_MATH_CAPTION_LENGTH,
  CANVAS_MAX_MATH_PARAGRAPH_LENGTH,
  CANVAS_MAX_MATH_RUNS,
  CANVAS_MAX_MATH_SOURCE_LENGTH,
  CANVAS_MAX_METRIC_SPARKLINE_POINTS,
  CANVAS_MAX_SANKEY_LINKS,
  CANVAS_MAX_TREEMAP_LEAVES,
  CANVAS_MAX_TREEMAP_MEASURES,
  CanvasActor,
  CanvasBarListScale,
  CanvasBlock,
  CanvasDesignBrand,
  CanvasDesignFrame,
  CanvasDesignFrameId,
  CanvasDesignMarkup,
  CanvasDesignSize,
  CanvasDesignTheme,
  CanvasDiagramLayoutKind,
  canvasChoiceUsesDecisionForm,
  canvasFlowUsesAnnotations,
  canvasMockupUsesLibrary,
  CanvasHeatmapDate,
  CanvasHeatmapScale,
  CanvasId,
  CanvasMatrixGlyph,
  CanvasMatrixPreference,
  CanvasMockupBlock,
  CanvasMetricDirection,
  CanvasNumberFormat,
  CanvasSchemaVersion,
  CanvasTableColumnDisplay,
  CanvasTreemapScale,
  CanvasVersionId,
  canvasChartSeriesIssue,
  canvasChartUsesFlowTypes,
  canvasMockupUsesCatalog,
  CANVAS_MAX_COLUMN_TRACKS,
  CANVAS_MAX_TABS_LABEL_LENGTH,
  CANVAS_MAX_TABS_PANES,
  CANVAS_MIN_COLUMN_TRACKS,
  isCanvasLayoutGroup,
  CanvasDiagramEdgeStyle,
  CanvasDiagramNodeIcon,
  CanvasDiagramTone,
  canvasDesignUsesDesignFields,
  canvasDiagramUsesRichFields,
  canvasDiagramUsesStyles,
  canvasPlanUsesGantt,
  decodeCanvasDefinition,
  CANVAS_DESIGN_ASSET_MAX_BYTES,
  CANVAS_MAX_DESIGN_ASSETS,
  CanvasDesignAssetId,
  CanvasDesignAssetMediaType,
  type CanvasDefinition,
  type CanvasVersion,
} from "./canvas";
import { ActorId, UtcTimestamp } from "./events";
import { CanvasChoiceQuestions } from "./questionnaire";
import { HostId } from "./host";
import { ProjectId } from "./projects";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const boundedNonEmptyText = (maximum: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maximum));
const boundedText = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));
const boundedToken = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.Trimmed.pipe(
    Schema.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(128),
      Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    ),
    Schema.brand<B>(brand),
  );

// Share wire contracts version independently from Canvas wire contracts, and
// the same way: the accept list covers every historical version plus the
// current one, so a rolled-forward snapshot stays readable here, while a
// rolled-back runtime whose literal stops at the older number refuses a
// document that declares the newer version cleanly at the schemaVersion field
// — before any block decodes — instead of partially decoding it. Each gated
// kind or field below is admitted only in a document declaring the version that
// introduced it, so an older document carrying one is refused, not misdrawn.
//
// Version 2 accompanies Canvas schema version 3: a share may carry a mockup.
export const CANVAS_SHARE_MOCKUP_SCHEMA_VERSION = 2;
// Version 3 catches the share up with the Canvas data visuals: treemap,
// heatmap, and bar-list blocks, a chart's and a table column's number format,
// a table column's display, and a board's own layout (a diagram's `layout` and
// a node's `positioned`). Until then a Canvas holding any of them could not be
// shared at all.
export const CANVAS_SHARE_VISUALS_SCHEMA_VERSION = 3;
// Version 4 accompanies Canvas schema version 10: a share may carry a
// comparison matrix.
export const CANVAS_SHARE_COMPARISON_MATRIX_SCHEMA_VERSION = 4;
// Version 5 accompanies Canvas schema version 11: a share may carry math.
export const CANVAS_SHARE_MATH_SCHEMA_VERSION = 5;
// Version 6 accompanies Canvas schema version 12: a shared mockup may use the
// catalog (devices, fidelity, components, node fields, variants, callouts).
export const CANVAS_SHARE_MOCKUP_CATALOG_SCHEMA_VERSION = 6;
// Version 7 accompanies Canvas schema version 14: a share may carry a funnel,
// a radar, or a sankey chart, and a sankey's links.
export const CANVAS_SHARE_FLOW_CHARTS_SCHEMA_VERSION = 7;
// Version 8 accompanies Canvas schema version 15: a share may carry a
// dashboard, which names the blocks it places by their ids in the same share.
export const CANVAS_SHARE_DASHBOARD_SCHEMA_VERSION = 8;
// Version 9 accompanies Canvas schema version 19: a share may carry tabs and
// columns, which name the shared blocks they hold, a diagram's edge styles and
// tones and its group tones, and a plan's Gantt view.
export const CANVAS_SHARE_LAYOUT_GROUPS_SCHEMA_VERSION = 9;
// Version 10 carries a design's frames: its markup, shared as the author wrote
// it. No new Canvas version accompanies it; a reader that never learned to
// draw a shared frame under the frame policy refuses version 10 as a future
// version, so a frame never reaches a viewer that would draw it any other way.
export const CANVAS_SHARE_FRAMES_SCHEMA_VERSION = 10;
// Version 11 carries what Canvas version 21 added to a share: a design's brand
// tokens and a diagram node's icon and detail with a group's parent. A frame's
// presenter notes and a captured-page asset are not carried; the schema still
// accepts notes so a version-11 document stays decodable if that changes.
export const CANVAS_SHARE_DESIGN_FIELDS_SCHEMA_VERSION = 11;
// Version 12 carries the flow block, which places mockup and design screens
// the same share holds. Version 13 carries the mockup library: its new
// components, the progress field, and reusable definitions. A chart's
// callouts stay stripped as before: the public share service refuses a share
// format it does not know, and each bump is what teaches it.
export const CANVAS_SHARE_FLOW_SCHEMA_VERSION = 12;
export const CANVAS_SHARE_MOCKUP_LIBRARY_SCHEMA_VERSION = 13;
// Version 14 carries the deck block: its slides are references to blocks the
// same share holds, and its notes are the presenter's, which never leave.
// Version 15 carries a flow's callouts. Version 16 carries the choice block,
// which a reader of a share sees and cannot answer: a share has no thread.
export const CANVAS_SHARE_DECK_SCHEMA_VERSION = 14;
export const CANVAS_SHARE_FLOW_ANNOTATIONS_SCHEMA_VERSION = 15;
export const CANVAS_SHARE_CHOICE_SCHEMA_VERSION = 16;
// Version 17 carries a decision form's sections and its questions' `allowNote`,
// with Canvas schema version 29. A share never carries a person's answers.
export const CANVAS_SHARE_DECISION_FORM_SCHEMA_VERSION = 17;
// Version 18 carries the images a document displays (maintainer decision,
// 2026-11-22): an image block's generated image and the images a design
// declares, as bytes in the document's `images`, with Canvas schema version
// 30. A reader that never learned to draw them refuses the
// version rather than drawing a block without its picture.
export const CANVAS_SHARE_IMAGES_SCHEMA_VERSION = 18;
export const CANVAS_SHARE_SCHEMA_VERSION = 18 as const;
// The newest Canvas block version a share at this version names. Canvas
// version 13 added only the table row id, which a share drops, so share
// version 6 named a block authored at 13 as 12. Version 14 adds chart types a
// share carries, so share version 7 named blocks up to 14, and version 15 adds
// the dashboard, so share version 8 named blocks up to 15. Canvas versions 16
// through 18 add only design fields (the document size and theme, image
// assets, then running script), and a share refuses a design, so they changed
// nothing a share carries. Version 19 adds tabs and columns, so share version
// 9 names blocks up to 19. Version 20 changes only a Canvas's provenance (a
// Chat Canvas owned by its thread, which is never shared), so a block authored
// at 20 is shared as 19. Version 21 adds design notes and brand tokens and the
// richer diagram fields, which a share carries, so share version 11 names
// blocks up to 21. Version 23 adds the flow block, which a share carries
// whole, so share version 12 names blocks up to 23. Version 27 adds the
// choice block, so share version 16 names blocks up to 27. Version 29 adds a
// decision form's sections and notes, so share version 17 names blocks up to
// 29. Version 30 adds an image block's generated image, which share version
// 18 carries, so it names blocks up to 30. A later Canvas bump that adds
// something a share carries bumps the share version again.
export const CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION = 30 as const;
export const CanvasShareSchemaVersion = Schema.Literals([
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  CANVAS_SHARE_SCHEMA_VERSION,
]);
export type CanvasShareSchemaVersion = typeof CanvasShareSchemaVersion.Type;

export const CanvasExportId = brandedUuid("CanvasExportId");
export type CanvasExportId = typeof CanvasExportId.Type;

/**
 * The static export channel. Public links are an export destination of their
 * own (see canvasPublicShare.ts), not a share channel.
 */
export const CanvasShareChannel = Schema.Literal("static-export");
export type CanvasShareChannel = typeof CanvasShareChannel.Type;

/** Consent may only be given by an authenticated local user, never system automation. */
export const CanvasShareLocalUserActor = Schema.Struct({
  kind: Schema.Literal("local-user"),
  actorId: ActorId,
});
export type CanvasShareLocalUserActor = typeof CanvasShareLocalUserActor.Type;

export const CanvasShareConsent = Schema.Struct({
  /** Explicit operator acknowledgement that an offline snapshot will leave the host. */
  acknowledgedOfflineSnapshot: Schema.Literal(true),
  /** Explicit operator acknowledgement that credentials and live host authority are excluded. */
  acknowledgedNoCredentials: Schema.Literal(true),
  /**
   * Explicit operator acknowledgement that a design's markup leaves as
   * written. The secret filter reads values, not markup, so a Canvas that
   * holds a design is shared only with this.
   */
  acknowledgedMarkupSharedAsWritten: Schema.optional(Schema.Literal(true)),
  acknowledgedAt: UtcTimestamp,
  acknowledgedBy: CanvasShareLocalUserActor,
});
export type CanvasShareConsent = typeof CanvasShareConsent.Type;

export const CanvasStaticExportRequest = Schema.Struct({
  schemaVersion: CanvasShareSchemaVersion,
  kind: Schema.Literal("canvas-static-export"),
  exportId: CanvasExportId,
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  expectedSequence: PositiveInt,
  hostId: HostId,
  projectId: ProjectId,
  channel: CanvasShareChannel,
  consent: CanvasShareConsent,
  /** Optional operator note stored with the export receipt; never used as authority. */
  note: Schema.optional(boundedNonEmptyText(512)),
});
export type CanvasStaticExportRequest = typeof CanvasStaticExportRequest.Type;

export const CanvasRedactedProvenance = Schema.Struct({
  hostId: HostId,
  projectId: ProjectId,
  mode: Schema.Literals(["chat", "work", "code"]),
  /** Thread identity is retained as an opaque id; path/credential fields are never present. */
  threadId: GuidString,
  createdAt: UtcTimestamp,
  /** Provider/model identity is reduced to non-secret labels only. */
  providerLabel: boundedNonEmptyText(200),
  modelLabel: boundedNonEmptyText(200),
  actorKind: Schema.Literals(["system", "local-user", "agent"]),
});
export type CanvasRedactedProvenance = typeof CanvasRedactedProvenance.Type;

export const CanvasStaticExportSourceEntry = Schema.Struct({
  sourceId: GuidString,
  kind: boundedNonEmptyText(64),
  displayName: boundedNonEmptyText(256),
  /** Opaque reference only; never a filesystem path or live credential. */
  opaqueRef: boundedNonEmptyText(256),
});
export type CanvasStaticExportSourceEntry = typeof CanvasStaticExportSourceEntry.Type;

/**
 * A share's own name for one image it carries, unrelated to any id on the
 * host: the share leaves without host, Project, thread, or image identity.
 */
export const CanvasShareImageRef = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^image-[1-9][0-9]?$/)),
  Schema.brand("CanvasShareImageRef"),
);
export type CanvasShareImageRef = typeof CanvasShareImageRef.Type;

/** At most this many images, each within the design image cap. */
export const CANVAS_SHARE_MAX_IMAGES = 32;
/** All of a share's images together, the same budget a saved HTML file has. */
export const CANVAS_SHARE_IMAGES_MAX_BYTES = 4 * 1024 * 1024;

/**
 * One image a share carries: a raster the host sniffed from the bytes, never
 * SVG, with its bytes as base64 and their SHA-256, which the approval card
 * shows so approving it names exactly the images that leave.
 */
const shareImageFields = {
  imageRef: CanvasShareImageRef,
  mediaType: CanvasDesignAssetMediaType,
  byteLength: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: CANVAS_DESIGN_ASSET_MAX_BYTES }),
  ),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
} as const;
const shareImageData = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(Math.ceil(CANVAS_DESIGN_ASSET_MAX_BYTES / 3) * 4),
  Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
);

export const CanvasShareImage = Schema.Struct({
  ...shareImageFields,
  data: shareImageData,
});
export type CanvasShareImage = typeof CanvasShareImage.Type;

/**
 * An image as a shared snapshot document holds it. The snapshot the host
 * journals names each image by its digest without its bytes, which the host
 * keeps in its managed store for that snapshot and adds when the snapshot is
 * read, so the journal never holds image bytes and a reader sees exactly the
 * bytes that were shared.
 */
export const CanvasShareImageEntry = Schema.Struct({
  ...shareImageFields,
  data: Schema.optional(shareImageData),
});
export type CanvasShareImageEntry = typeof CanvasShareImageEntry.Type;

/** The bytes base64 `data` holds, from its length and padding. */
function shareImageDecodedBytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/**
 * Whether a share's images hold together: each image's bytes match its
 * declared length, every reference names an image the share carries, no
 * image is carried that nothing shows, and all of them fit the budget.
 */
export function canvasShareImagesAreConsistent(document: {
  readonly blocks: ReadonlyArray<{
    readonly kind: string;
    readonly imageRef?: string | undefined;
    readonly assets?: ReadonlyArray<{ readonly imageRef: string }> | undefined;
  }>;
  readonly images?: ReadonlyArray<CanvasShareImageEntry> | undefined;
}): boolean {
  const images = document.images ?? [];
  const carried = new Set(images.map((image) => String(image.imageRef)));
  if (carried.size !== images.length) return false;
  const named = new Set<string>();
  for (const block of document.blocks) {
    if (block.kind === "image" && block.imageRef !== undefined) named.add(block.imageRef);
    if (block.kind === "design") {
      for (const asset of block.assets ?? []) named.add(asset.imageRef);
    }
  }
  if (named.size !== carried.size || [...named].some((ref) => !carried.has(ref))) return false;
  let total = 0;
  for (const image of images) {
    if (
      image.data !== undefined &&
      (image.data.length % 4 !== 0 || shareImageDecodedBytes(image.data) !== image.byteLength)
    ) {
      return false;
    }
    total += image.byteLength;
  }
  return total <= CANVAS_SHARE_IMAGES_MAX_BYTES;
}

/** Whether a document carries anything share version 18 introduced. */
function carriesShareImages(document: {
  readonly blocks: ReadonlyArray<{
    readonly kind: string;
    readonly imageRef?: string | undefined;
    readonly assets?: ReadonlyArray<unknown> | undefined;
  }>;
  readonly images?: ReadonlyArray<unknown> | undefined;
}): boolean {
  return (
    (document.images ?? []).length > 0 ||
    document.blocks.some(
      (block) =>
        (block.kind === "image" && block.imageRef !== undefined) ||
        (block.kind === "design" && block.assets !== undefined),
    )
  );
}

const exportBlockFields = {
  blockId: boundedToken("CanvasBlockId"),
  schemaVersion: CanvasSchemaVersion,
} as const;
const {
  blockId: _mockupBlockId,
  schemaVersion: _mockupSchemaVersion,
  ...exportMockupFields
} = CanvasMockupBlock.fields;

function exportTextHasNoSecrets(value: string): boolean {
  return isCanvasShareSafeText(value);
}

const ExportLabel = boundedNonEmptyText(512).check(
  Schema.makeFilter((value) => exportTextHasNoSecrets(value), {
    message: "Canvas export labels must not contain secret-bearing text.",
  }),
);

const ExportText = boundedText(32_768).check(
  Schema.makeFilter((value) => exportTextHasNoSecrets(value), {
    message: "Canvas export text must not contain secret-bearing values.",
  }),
);
const ExportNonEmptyText = boundedNonEmptyText(32_768).check(
  Schema.makeFilter((value) => exportTextHasNoSecrets(value), {
    message: "Canvas export text must not contain secret-bearing values.",
  }),
);
const ExportMatrixNote = ExportText.check(Schema.isMaxLength(CANVAS_MAX_MATRIX_NOTE_LENGTH));
const exportMatrixCellFields = {
  criterionId: boundedToken("CanvasNodeId"),
  optionId: boundedToken("CanvasNodeId"),
  note: Schema.optional(ExportMatrixNote),
} as const;
const ExportMathSource = ExportNonEmptyText.check(
  Schema.isMaxLength(CANVAS_MAX_MATH_SOURCE_LENGTH),
);
const ExportUrl = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter(
    (value) => {
      try {
        const parsed = new URL(value);
        if (
          !(
            (parsed.protocol === "http:" || parsed.protocol === "https:") &&
            parsed.username === "" &&
            parsed.password === ""
          )
        ) {
          return false;
        }
        for (const key of parsed.searchParams.keys()) {
          if (EXPORT_SENSITIVE_QUERY_KEYS.test(key)) return false;
        }
        return exportTextHasNoSecrets(value);
      } catch {
        return false;
      }
    },
    { message: "Canvas export links must be credential-free http(s) URLs." },
  ),
);
const ExportScalar = Schema.Union([ExportText, Schema.Number, Schema.Boolean, Schema.Null]);

const exportHeatmapFields = {
  ...exportBlockFields,
  kind: Schema.Literal("heatmap"),
  valueLabel: Schema.optional(ExportLabel),
  format: Schema.optional(CanvasNumberFormat),
  scale: Schema.optional(CanvasHeatmapScale),
} as const;

/**
 * Sanitized first-party export blocks. Live sourceId authority is never present.
 * Unsupported or secret-bearing shapes must fail closed at decode time.
 */
export const CanvasStaticExportBlock = Schema.Union([
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("heading"),
    level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
    text: ExportNonEmptyText,
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("rich-text"),
    text: ExportNonEmptyText,
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("callout"),
    tone: Schema.Literals(["info", "success", "warning", "danger"]),
    title: Schema.optional(ExportLabel),
    text: ExportNonEmptyText,
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("link"),
    label: ExportLabel,
    href: ExportUrl,
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("divider"),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("citation"),
    label: ExportLabel,
    quote: Schema.optional(ExportText),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("metric"),
    label: ExportLabel,
    value: ExportScalar,
    unit: Schema.optional(ExportLabel),
    delta: Schema.optional(Schema.Number),
    // The reading fields a metric gained after the share contract was first
    // written; without them a shared metric that names any of them was refused.
    format: Schema.optional(CanvasNumberFormat),
    sparkline: Schema.optional(
      Schema.Array(Schema.Number).check(Schema.isMaxLength(CANVAS_MAX_METRIC_SPARKLINE_POINTS)),
    ),
    goodDirection: Schema.optional(CanvasMetricDirection),
    caption: Schema.optional(ExportText),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("progress"),
    label: ExportLabel,
    value: Schema.Number.check(
      Schema.makeFilter((value) => Number.isFinite(value) && value >= 0 && value <= 1, {
        message: "Canvas export progress values must be finite numbers between 0 and 1.",
      }),
    ),
    detail: Schema.optional(ExportText),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("status"),
    label: ExportLabel,
    value: ExportLabel,
    tone: Schema.Literals(["neutral", "info", "success", "warning", "danger"]),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("key-value"),
    entries: Schema.Array(
      Schema.Struct({
        key: ExportLabel,
        value: ExportScalar,
      }),
    ).check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("table"),
    columns: Schema.NonEmptyArray(
      Schema.Struct({
        id: boundedToken("CanvasTableColumnId"),
        label: ExportLabel,
        type: Schema.Literals(["text", "number", "boolean", "date", "status"]),
        format: Schema.optional(CanvasNumberFormat),
        display: Schema.optional(CanvasTableColumnDisplay),
      }),
    ).check(Schema.isMaxLength(64)),
    rows: Schema.Array(Schema.Array(ExportScalar).check(Schema.isMaxLength(64))).check(
      Schema.isMaxLength(1_024),
    ),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("chart"),
    chartType: Schema.Literals([
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
    ]),
    series: Schema.Array(
      Schema.Struct({
        seriesId: boundedToken("CanvasSeriesId"),
        label: ExportLabel,
        points: Schema.NonEmptyArray(
          Schema.Struct({
            x: Schema.Union([Schema.Number, ExportText]),
            y: Schema.Number,
          }),
        ).check(Schema.isMaxLength(2_048)),
        mark: Schema.optional(Schema.Literals(["bar", "line"])),
      }),
    ).check(Schema.isMaxLength(64)),
    links: Schema.optional(
      Schema.Array(
        Schema.Struct({
          source: ExportLabel.check(Schema.isMaxLength(CANVAS_MAX_CHART_CATEGORY_LABEL_LENGTH)),
          target: ExportLabel.check(Schema.isMaxLength(CANVAS_MAX_CHART_CATEGORY_LABEL_LENGTH)),
          value: Schema.Number,
        }),
      ).check(Schema.isMaxLength(CANVAS_MAX_SANKEY_LINKS)),
    ),
    format: Schema.optional(CanvasNumberFormat),
  }).check(
    Schema.makeFilter((block) => canvasChartSeriesIssue(block) === undefined, {
      message: "Chart series do not match the chart type.",
    }),
  ),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("timeline"),
    items: Schema.Array(
      Schema.Struct({
        itemId: boundedToken("CanvasTimelineItemId"),
        title: ExportLabel,
        startAt: UtcTimestamp,
        endAt: Schema.optional(UtcTimestamp),
        status: Schema.optional(
          Schema.Literals(["neutral", "info", "success", "warning", "danger"]),
        ),
        detail: Schema.optional(ExportText),
      }),
    ).check(Schema.isMaxLength(512)),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("plan"),
    title: ExportLabel,
    view: Schema.optional(Schema.Literals(["checklist", "kanban", "timeline", "gantt"])),
    phases: Schema.NonEmptyArray(
      Schema.Struct({
        phaseId: boundedToken("CanvasPlanPhaseId"),
        title: ExportLabel,
      }),
    ).check(Schema.isMaxLength(32)),
    tasks: Schema.Array(
      Schema.Struct({
        taskId: boundedToken("CanvasPlanTaskId"),
        phaseId: boundedToken("CanvasPlanPhaseId"),
        title: ExportLabel,
        status: Schema.Literals(["todo", "doing", "blocked", "done"]),
        owner: Schema.optional(
          Schema.Struct({
            kind: Schema.Literals(["person", "agent"]),
            label: Schema.optional(ExportLabel),
          }),
        ),
        estimate: Schema.optional(ExportLabel),
        notes: Schema.optional(ExportText),
        startAt: Schema.optional(UtcTimestamp),
        dueAt: Schema.optional(UtcTimestamp),
        dependsOn: Schema.optional(
          Schema.Array(boundedToken("CanvasPlanTaskId")).check(Schema.isMaxLength(16)),
        ),
      }),
    ).check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("diagram"),
    nodes: Schema.Array(
      Schema.Struct({
        nodeId: boundedToken("CanvasNodeId"),
        label: ExportLabel,
        role: Schema.optional(boundedToken("CanvasNodeRole")),
        icon: Schema.optional(CanvasDiagramNodeIcon),
        detail: Schema.optional(boundedNonEmptyText(CANVAS_MAX_DIAGRAM_DETAIL_LENGTH)),
        x: Schema.optional(Schema.Number),
        y: Schema.optional(Schema.Number),
        positioned: Schema.optional(Schema.Literal(true)),
      }),
    ).check(Schema.isMaxLength(512)),
    edges: Schema.Array(
      Schema.Struct({
        edgeId: boundedToken("CanvasEdgeId"),
        source: boundedToken("CanvasNodeId"),
        target: boundedToken("CanvasNodeId"),
        label: Schema.optional(ExportLabel),
        style: Schema.optional(CanvasDiagramEdgeStyle),
        tone: Schema.optional(CanvasDiagramTone),
      }),
    ).check(Schema.isMaxLength(1_024)),
    groups: Schema.optional(
      Schema.Array(
        Schema.Struct({
          groupId: boundedToken("CanvasGroupId"),
          label: ExportLabel,
          nodeIds: Schema.Array(boundedToken("CanvasNodeId")).check(Schema.isMaxLength(512)),
          tone: Schema.optional(CanvasDiagramTone),
          parentGroupId: Schema.optional(boundedToken("CanvasGroupId")),
        }),
      ).check(Schema.isMaxLength(64)),
    ),
    flow: Schema.optional(Schema.Literals(["down", "right"])),
    layout: Schema.optional(CanvasDiagramLayoutKind),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("sequence"),
    participants: Schema.Array(
      Schema.Struct({
        participantId: boundedToken("CanvasNodeId"),
        label: ExportLabel,
      }),
    ).check(Schema.isMaxLength(512)),
    messages: Schema.Array(
      Schema.Struct({
        messageId: boundedToken("CanvasEdgeId"),
        from: boundedToken("CanvasNodeId"),
        to: boundedToken("CanvasNodeId"),
        label: ExportLabel,
      }),
    ).check(Schema.isMaxLength(1_024)),
    activations: Schema.optional(
      Schema.Array(
        Schema.Struct({
          activationId: boundedToken("CanvasActivationId"),
          participantId: boundedToken("CanvasNodeId"),
          startMessageId: boundedToken("CanvasEdgeId"),
          endMessageId: boundedToken("CanvasEdgeId"),
        }),
      ).check(Schema.isMaxLength(512)),
    ),
    notes: Schema.optional(
      Schema.Array(
        Schema.Struct({
          noteId: boundedToken("CanvasNoteId"),
          text: ExportLabel,
          participantId: Schema.optional(boundedToken("CanvasNodeId")),
          afterMessageId: Schema.optional(boundedToken("CanvasEdgeId")),
        }),
      ).check(Schema.isMaxLength(64)),
    ),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("state"),
    states: Schema.Array(
      Schema.Struct({
        stateId: boundedToken("CanvasNodeId"),
        label: ExportLabel,
        role: Schema.optional(Schema.Literals(["initial", "final"])),
        parentId: Schema.optional(boundedToken("CanvasNodeId")),
      }),
    ).check(Schema.isMaxLength(512)),
    transitions: Schema.Array(
      Schema.Struct({
        transitionId: boundedToken("CanvasEdgeId"),
        source: boundedToken("CanvasNodeId"),
        target: boundedToken("CanvasNodeId"),
        label: ExportLabel,
      }),
    ).check(Schema.isMaxLength(1_024)),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("er"),
    entities: Schema.Array(
      Schema.Struct({
        entityId: boundedToken("CanvasNodeId"),
        label: ExportLabel,
        attributes: Schema.Array(
          Schema.Struct({
            attributeId: boundedToken("CanvasErAttributeId"),
            name: ExportLabel,
            type: ExportLabel,
            key: Schema.optional(Schema.Literal(true)),
          }),
        ).check(Schema.isMaxLength(64)),
      }),
    ).check(Schema.isMaxLength(512)),
    relationships: Schema.Array(
      Schema.Struct({
        relationshipId: boundedToken("CanvasEdgeId"),
        source: boundedToken("CanvasNodeId"),
        target: boundedToken("CanvasNodeId"),
        sourceCardinality: Schema.Literals(["one", "zero-or-one", "many", "one-or-many"]),
        targetCardinality: Schema.Literals(["one", "zero-or-one", "many", "one-or-many"]),
        label: Schema.optional(ExportLabel),
      }),
    ).check(Schema.isMaxLength(1_024)),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("swimlane"),
    lanes: Schema.NonEmptyArray(
      Schema.Struct({
        laneId: boundedToken("CanvasSwimlaneLaneId"),
        label: ExportLabel,
        kind: Schema.optional(Schema.Literals(["actor", "team"])),
      }),
    ).check(Schema.isMaxLength(32)),
    steps: Schema.Array(
      Schema.Struct({
        stepId: boundedToken("CanvasNodeId"),
        laneId: boundedToken("CanvasSwimlaneLaneId"),
        label: ExportLabel,
        decision: Schema.optional(Schema.Literal(true)),
      }),
    ).check(Schema.isMaxLength(512)),
    connections: Schema.Array(
      Schema.Struct({
        connectionId: boundedToken("CanvasEdgeId"),
        source: boundedToken("CanvasNodeId"),
        target: boundedToken("CanvasNodeId"),
        label: Schema.optional(ExportLabel),
      }),
    ).check(Schema.isMaxLength(1_024)),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("mindmap"),
    nodes: Schema.Array(
      Schema.Struct({
        nodeId: boundedToken("CanvasNodeId"),
        label: ExportLabel,
        parentId: Schema.optional(boundedToken("CanvasNodeId")),
        note: Schema.optional(ExportText),
      }),
    ).check(Schema.isMaxLength(512)),
  }),
  Schema.Struct({
    ...exportBlockFields,
    ...exportMockupFields,
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("treemap"),
    nodes: Schema.Array(
      Schema.Struct({
        nodeId: boundedToken("CanvasNodeId"),
        parentId: Schema.optional(boundedToken("CanvasNodeId")),
        label: ExportLabel,
        values: Schema.optional(
          Schema.Record(boundedToken("CanvasTreemapMeasureId"), Schema.Number),
        ),
      }),
    ).check(Schema.isMaxLength(CANVAS_MAX_TREEMAP_LEAVES)),
    measures: Schema.NonEmptyArray(
      Schema.Struct({
        measureId: boundedToken("CanvasTreemapMeasureId"),
        label: ExportLabel,
        format: Schema.optional(CanvasNumberFormat),
      }),
    ).check(Schema.isMaxLength(CANVAS_MAX_TREEMAP_MEASURES)),
    sizeBy: boundedToken("CanvasTreemapMeasureId"),
    colorBy: boundedToken("CanvasTreemapMeasureId"),
    colorScale: Schema.optional(CanvasTreemapScale),
    startNodeId: Schema.optional(boundedToken("CanvasNodeId")),
  }),
  Schema.Struct({
    ...exportHeatmapFields,
    layout: Schema.Literal("matrix"),
    rows: Schema.NonEmptyArray(
      Schema.Struct({
        rowId: boundedToken("CanvasHeatmapRowId"),
        label: ExportLabel,
      }),
    ).check(Schema.isMaxLength(CANVAS_MAX_HEATMAP_ROWS)),
    columns: Schema.NonEmptyArray(
      Schema.Struct({
        columnId: boundedToken("CanvasHeatmapColumnId"),
        label: ExportLabel,
      }),
    ).check(Schema.isMaxLength(CANVAS_MAX_HEATMAP_COLUMNS)),
    cells: Schema.Array(
      Schema.Struct({
        rowId: boundedToken("CanvasHeatmapRowId"),
        columnId: boundedToken("CanvasHeatmapColumnId"),
        value: Schema.Number,
        note: Schema.optional(ExportText),
      }),
    ).check(Schema.isMaxLength(CANVAS_MAX_HEATMAP_CELLS)),
  }),
  Schema.Struct({
    ...exportHeatmapFields,
    layout: Schema.Literal("calendar"),
    days: Schema.NonEmptyArray(
      Schema.Struct({
        date: CanvasHeatmapDate,
        value: Schema.Number,
        note: Schema.optional(ExportText),
      }),
    ).check(Schema.isMaxLength(CANVAS_MAX_HEATMAP_DAYS)),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("bar-list"),
    rows: Schema.NonEmptyArray(
      Schema.Struct({
        label: ExportLabel,
        value: Schema.Number,
        secondaryValue: Schema.optional(Schema.Number),
      }),
    ).check(Schema.isMaxLength(CANVAS_MAX_BAR_LIST_ROWS)),
    valueLabel: Schema.optional(ExportLabel),
    secondaryLabel: Schema.optional(ExportLabel),
    format: Schema.optional(CanvasNumberFormat),
    secondaryFormat: Schema.optional(CanvasNumberFormat),
    scale: Schema.optional(CanvasBarListScale),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("comparison-matrix"),
    options: Schema.NonEmptyArray(
      Schema.Struct({
        optionId: boundedToken("CanvasNodeId"),
        label: ExportLabel,
        detail: Schema.optional(ExportMatrixNote),
      }),
    ).check(Schema.isMaxLength(CANVAS_MAX_MATRIX_OPTIONS)),
    criteria: Schema.NonEmptyArray(
      Schema.Struct({
        criterionId: boundedToken("CanvasNodeId"),
        label: ExportLabel,
        weight: Schema.optional(
          Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: CANVAS_MAX_MATRIX_WEIGHT })),
        ),
        prefer: Schema.optional(CanvasMatrixPreference),
        detail: Schema.optional(ExportMatrixNote),
      }),
    ).check(Schema.isMaxLength(CANVAS_MAX_MATRIX_CRITERIA)),
    cells: Schema.Array(
      Schema.Union([
        Schema.Struct({ ...exportMatrixCellFields, score: Schema.Number }),
        Schema.Struct({
          ...exportMatrixCellFields,
          text: ExportLabel.check(Schema.isMaxLength(CANVAS_MAX_MATRIX_CELL_TEXT_LENGTH)),
        }),
        Schema.Struct({ ...exportMatrixCellFields, glyph: CanvasMatrixGlyph }),
      ]),
    ).check(Schema.isMaxLength(CANVAS_MAX_MATRIX_CELLS)),
    scoreRange: Schema.optional(Schema.Struct({ min: Schema.Number, max: Schema.Number })),
    recommendedOptionId: Schema.optional(boundedToken("CanvasNodeId")),
    recommendation: Schema.optional(
      ExportText.check(Schema.isMaxLength(CANVAS_MAX_MATRIX_NOTE_LENGTH * 2)),
    ),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("math"),
    layout: Schema.Literal("display"),
    source: ExportMathSource,
    caption: Schema.optional(ExportLabel.check(Schema.isMaxLength(CANVAS_MAX_MATH_CAPTION_LENGTH))),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("math"),
    layout: Schema.Literal("inline"),
    runs: Schema.NonEmptyArray(
      Schema.Union([
        Schema.Struct({
          text: ExportText.check(
            Schema.isMaxLength(CANVAS_MAX_MATH_PARAGRAPH_LENGTH),
            Schema.makeFilter((value) => value.trim().length > 0),
          ),
        }),
        Schema.Struct({ math: ExportMathSource }),
      ]),
    ).check(Schema.isMaxLength(CANVAS_MAX_MATH_RUNS)),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("code-excerpt"),
    language: boundedToken("CanvasLanguage"),
    code: ExportNonEmptyText,
    startLine: Schema.optional(PositiveInt),
    endLine: Schema.optional(PositiveInt),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("pseudocode"),
    code: ExportNonEmptyText,
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("diff"),
    hunks: Schema.Array(
      Schema.Struct({
        header: ExportLabel,
        lines: Schema.Array(
          Schema.Struct({
            kind: Schema.Literals(["add", "remove", "context"]),
            text: ExportText,
          }),
        ).check(Schema.isMaxLength(4_096)),
      }),
    ).check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("source-reference"),
    label: ExportLabel,
    detail: Schema.optional(ExportText),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("summary"),
    summaryKind: Schema.Literals([
      "task",
      "thread",
      "subagent",
      "provider",
      "model",
      "usage",
      "test",
      "pull-request",
    ]),
    title: ExportLabel,
    items: Schema.Array(
      Schema.Struct({
        label: ExportLabel,
        value: Schema.optional(ExportScalar),
        status: Schema.optional(
          Schema.Literals(["neutral", "info", "success", "warning", "danger"]),
        ),
      }),
    ).check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("artifact-reference"),
    label: ExportLabel,
    detail: Schema.optional(ExportText),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("file-reference"),
    label: ExportLabel,
    detail: Schema.optional(ExportText),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("preview-reference"),
    label: ExportLabel,
    detail: Schema.optional(ExportText),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("browser-reference"),
    label: ExportLabel,
    detail: Schema.optional(ExportText),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("evidence-reference"),
    label: ExportLabel,
    detail: Schema.optional(ExportText),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("dashboard"),
    title: ExportLabel,
    columns: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: CANVAS_MAX_DASHBOARD_COLUMNS })),
    ),
    cells: Schema.NonEmptyArray(
      Schema.Struct({
        blockId: boundedToken("CanvasBlockId"),
        span: Schema.optional(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: CANVAS_MAX_DASHBOARD_COLUMNS })),
        ),
      }),
    ).check(Schema.isMaxLength(CANVAS_MAX_DASHBOARD_CELLS)),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("image"),
    alt: ExportNonEmptyText,
    caption: Schema.optional(ExportText),
    /** The picture, from share version 18: one of the document's `images`. */
    imageRef: Schema.optional(CanvasShareImageRef),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("tabs"),
    panes: Schema.Array(
      Schema.Struct({
        label: ExportLabel.check(Schema.isMaxLength(CANVAS_MAX_TABS_LABEL_LENGTH)),
        blockIds: Schema.NonEmptyArray(boundedToken("CanvasBlockId")).check(
          Schema.isMaxLength(128),
        ),
      }),
    ).check(Schema.isMinLength(2), Schema.isMaxLength(CANVAS_MAX_TABS_PANES)),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("columns"),
    tracks: Schema.Array(
      Schema.Struct({
        blockIds: Schema.NonEmptyArray(boundedToken("CanvasBlockId")).check(
          Schema.isMaxLength(128),
        ),
      }),
    ).check(
      Schema.isMinLength(CANVAS_MIN_COLUMN_TRACKS),
      Schema.isMaxLength(CANVAS_MAX_COLUMN_TRACKS),
    ),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("design"),
    title: ExportNonEmptyText,
    size: CanvasDesignSize,
    theme: Schema.optional(CanvasDesignTheme),
    brand: Schema.optional(CanvasDesignBrand),
    runsScript: Schema.optional(Schema.Literal(true)),
    styles: Schema.optional(CanvasDesignMarkup),
    frames: Schema.Array(CanvasDesignFrame).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(CANVAS_MAX_DESIGN_FRAMES),
    ),
    /**
     * From share version 18, the declared images the frames name as
     * `octant-asset:<assetId>`, each one of the document's `images`. A
     * declared image the host could not resolve is not listed and draws as a
     * placeholder.
     */
    assets: Schema.optional(
      Schema.Array(
        Schema.Struct({
          assetId: CanvasDesignAssetId,
          imageRef: CanvasShareImageRef,
        }),
      ).check(Schema.isMaxLength(CANVAS_MAX_DESIGN_ASSETS)),
    ),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("deck"),
    title: ExportLabel,
    slides: Schema.Array(
      Schema.Struct({
        slideId: boundedToken("CanvasNodeId"),
        blockId: boundedToken("CanvasBlockId"),
        frameId: Schema.optional(CanvasDesignFrameId),
        variantId: Schema.optional(boundedToken("CanvasMockupVariantId")),
      }),
    ).check(Schema.isMinLength(2), Schema.isMaxLength(CANVAS_MAX_DECK_SLIDES)),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("choice"),
    prompt: ExportNonEmptyText.check(Schema.isMaxLength(CANVAS_MAX_CHOICE_PROMPT_LENGTH)),
    questions: CanvasChoiceQuestions.check(
      Schema.makeFilter(
        (questions) =>
          questions.every(
            (question) =>
              exportTextHasNoSecrets(question.prompt) &&
              question.options.every(
                (option) =>
                  exportTextHasNoSecrets(option.label) &&
                  (option.description === undefined || exportTextHasNoSecrets(option.description)),
              ),
          ),
        { message: "Canvas export questions must not contain secret-bearing text." },
      ),
    ),
    // Sections group and title the questions; like the questions, they leave
    // as text and are checked for secret-bearing words.
    sections: Schema.optional(
      Schema.Array(
        Schema.Struct({
          id: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
          title: ExportNonEmptyText.check(
            Schema.isMaxLength(CANVAS_MAX_CHOICE_SECTION_TITLE_LENGTH),
          ),
          intro: Schema.optional(
            ExportNonEmptyText.check(Schema.isMaxLength(CANVAS_MAX_CHOICE_SECTION_INTRO_LENGTH)),
          ),
          questionIds: Schema.Array(
            Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
          ).check(Schema.isMinLength(1)),
        }),
      ).check(
        Schema.isMinLength(1),
        Schema.makeFilter(
          (sections) =>
            sections.every(
              (section) =>
                exportTextHasNoSecrets(section.title) &&
                (section.intro === undefined || exportTextHasNoSecrets(section.intro)),
            ),
          { message: "Canvas export sections must not contain secret-bearing text." },
        ),
      ),
    ),
  }),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("flow"),
    title: ExportLabel,
    layout: CanvasDiagramLayoutKind,
    annotations: Schema.optional(
      Schema.Array(
        Schema.Struct({
          nodeId: boundedToken("CanvasNodeId"),
          note: boundedNonEmptyText(CANVAS_MAX_FLOW_ANNOTATION_LENGTH),
        }),
      ).check(Schema.isMaxLength(CANVAS_MAX_FLOW_ANNOTATIONS)),
    ),
    screens: Schema.Array(
      Schema.Struct({
        screenId: boundedToken("CanvasNodeId"),
        blockId: boundedToken("CanvasBlockId"),
        variantId: Schema.optional(boundedToken("CanvasMockupVariantId")),
        frameId: Schema.optional(CanvasDesignFrameId),
        x: Schema.optional(Schema.Number),
        y: Schema.optional(Schema.Number),
        positioned: Schema.optional(Schema.Literal(true)),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(CANVAS_MAX_FLOW_SCREENS)),
    edges: Schema.Array(
      Schema.Struct({
        edgeId: boundedToken("CanvasEdgeId"),
        fromScreenId: boundedToken("CanvasNodeId"),
        toScreenId: boundedToken("CanvasNodeId"),
        fromNodeId: Schema.optional(boundedToken("CanvasNodeId")),
        label: Schema.optional(ExportLabel.check(Schema.isMaxLength(CANVAS_MAX_FLOW_LABEL_LENGTH))),
        tone: Schema.optional(CanvasDiagramTone),
      }),
    ).check(Schema.isMaxLength(CANVAS_MAX_FLOW_EDGES)),
  }),
]);
export type CanvasStaticExportBlock = typeof CanvasStaticExportBlock.Type;

export const CanvasStaticExportDocument = Schema.Struct({
  schemaVersion: CanvasShareSchemaVersion,
  kind: Schema.Literal("canvas-static-export-document"),
  exportId: CanvasExportId,
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  sequence: PositiveInt,
  exportedAt: UtcTimestamp,
  title: boundedNonEmptyText(256).check(
    Schema.makeFilter((value) => isCanvasShareSafeText(value), {
      message: "Canvas export document titles must not contain secrets or host paths.",
    }),
  ),
  channel: Schema.Literals(["static-export", "authenticated-snapshot"]),
  sharingEnabled: Schema.Literal(true),
  provenance: CanvasRedactedProvenance,
  sourceManifest: Schema.Array(CanvasStaticExportSourceEntry).check(Schema.isMaxLength(128)),
  /**
   * Blocks are restricted to the sanitized first-party export union. Unknown
   * kinds, future schema versions, and source-bound authority fields fail closed.
   */
  blocks: Schema.Array(CanvasStaticExportBlock).check(Schema.isMaxLength(128)),
  /** The images the blocks display, from share version 18. */
  images: Schema.optional(
    Schema.Array(CanvasShareImageEntry).check(Schema.isMaxLength(CANVAS_SHARE_MAX_IMAGES)),
  ),
  threatModelId: Schema.Literals([
    "canvas-share-static-export-v1",
    "canvas-share-authenticated-snapshot-v1",
  ]),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (document) =>
        document.schemaVersion >= CANVAS_SHARE_IMAGES_SCHEMA_VERSION ||
        !carriesShareImages(document),
      { message: "Shared images require Canvas share version 18." },
    ),
    Schema.makeFilter((document) => canvasShareImagesAreConsistent(document), {
      message:
        "A share's images must each be named by a block, match their length, and fit the image budget.",
    }),
  ), // Same version gate as the live definition: mockup blocks are declared by
  // share version 2, which accompanies Canvas schema version 3. A v1
  // document carrying one is refused at decode, not partially rendered.
  Schema.check(
    Schema.makeFilter(
      (document) =>
        document.schemaVersion >= CANVAS_SHARE_MOCKUP_SCHEMA_VERSION ||
        !document.blocks.some((block) => block.kind === "mockup"),
      { message: "Mockup blocks require Canvas share version 2." },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (document) =>
        document.schemaVersion >= CANVAS_SHARE_VISUALS_SCHEMA_VERSION ||
        !document.blocks.some(exportBlockUsesVisuals),
      {
        message:
          "Treemap, heatmap, and bar-list blocks, number formats on charts and table columns, table column displays, and a board's own layout require Canvas share version 3.",
      },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (document) =>
        document.schemaVersion >= CANVAS_SHARE_COMPARISON_MATRIX_SCHEMA_VERSION ||
        !document.blocks.some((block) => block.kind === "comparison-matrix"),
      { message: "Comparison matrix blocks require Canvas share version 4." },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (document) =>
        document.schemaVersion >= CANVAS_SHARE_MATH_SCHEMA_VERSION ||
        !document.blocks.some((block) => block.kind === "math"),
      { message: "Math blocks require Canvas share version 5." },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (document) =>
        document.schemaVersion >= CANVAS_SHARE_MOCKUP_CATALOG_SCHEMA_VERSION ||
        !document.blocks.some(canvasMockupUsesCatalog),
      { message: "A mockup that uses the catalog requires Canvas share version 6." },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (document) =>
        document.schemaVersion >= CANVAS_SHARE_FLOW_CHARTS_SCHEMA_VERSION ||
        !document.blocks.some(canvasChartUsesFlowTypes),
      { message: "Funnel, radar, and sankey charts require Canvas share version 7." },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (document) =>
        document.schemaVersion >= CANVAS_SHARE_DASHBOARD_SCHEMA_VERSION ||
        !document.blocks.some((block) => block.kind === "dashboard"),
      { message: "Dashboard blocks require Canvas share version 8." },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (document) =>
        document.schemaVersion >= CANVAS_SHARE_LAYOUT_GROUPS_SCHEMA_VERSION ||
        !document.blocks.some(
          (block) =>
            isCanvasLayoutGroup(block) ||
            canvasDiagramUsesStyles(block) ||
            canvasPlanUsesGantt(block),
        ),
      {
        message:
          "Tabs, columns, diagram edge styles and tones, group tones, and the plan's Gantt view require Canvas share version 9.",
      },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (document) =>
        document.schemaVersion >= CANVAS_SHARE_FRAMES_SCHEMA_VERSION ||
        !document.blocks.some((block) => block.kind === "design"),
      { message: "Design frames require Canvas share version 10." },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (document) =>
        document.schemaVersion >= CANVAS_SHARE_DESIGN_FIELDS_SCHEMA_VERSION ||
        !document.blocks.some(
          (block) => canvasDesignUsesDesignFields(block) || canvasDiagramUsesRichFields(block),
        ),
      {
        message:
          "Brand tokens and diagram icons, details, and nested groups require Canvas share version 11.",
      },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      (document) =>
        (document.schemaVersion >= CANVAS_SHARE_FLOW_SCHEMA_VERSION ||
          !document.blocks.some((block) => block.kind === "flow")) &&
        (document.schemaVersion >= CANVAS_SHARE_MOCKUP_LIBRARY_SCHEMA_VERSION ||
          !document.blocks.some((block) => canvasMockupUsesLibrary(block))) &&
        (document.schemaVersion >= CANVAS_SHARE_DECK_SCHEMA_VERSION ||
          !document.blocks.some((block) => block.kind === "deck")) &&
        (document.schemaVersion >= CANVAS_SHARE_FLOW_ANNOTATIONS_SCHEMA_VERSION ||
          !document.blocks.some((block) => canvasFlowUsesAnnotations(block))) &&
        (document.schemaVersion >= CANVAS_SHARE_CHOICE_SCHEMA_VERSION ||
          !document.blocks.some((block) => block.kind === "choice")) &&
        (document.schemaVersion >= CANVAS_SHARE_DECISION_FORM_SCHEMA_VERSION ||
          !document.blocks.some((block) => canvasChoiceUsesDecisionForm(block))),
      {
        message:
          "Flow blocks require Canvas share version 12, the mockup library requires Canvas share version 13, a deck block requires Canvas share version 14, flow callouts require Canvas share version 15, a choice block requires Canvas share version 16, and a decision form's sections and notes require Canvas share version 17.",
      },
    ),
  ),
);
export type CanvasStaticExportDocument = typeof CanvasStaticExportDocument.Type;

/** Whether a shared block uses a kind or field introduced at share version 3. */
function exportBlockUsesVisuals(block: CanvasStaticExportBlock): boolean {
  switch (block.kind) {
    case "treemap":
    case "heatmap":
    case "bar-list":
      return true;
    case "chart":
      return block.format !== undefined;
    case "table":
      return block.columns.some(
        (column) => column.format !== undefined || column.display !== undefined,
      );
    case "diagram":
      return (
        block.layout !== undefined || block.nodes.some((node) => node.positioned !== undefined)
      );
    default:
      return false;
  }
}

export const CanvasStaticExportReceipt = Schema.Struct({
  schemaVersion: CanvasShareSchemaVersion,
  kind: Schema.Literal("canvas-static-export-receipt"),
  exportId: CanvasExportId,
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  sequence: PositiveInt,
  exportedAt: UtcTimestamp,
  channel: CanvasShareChannel,
  document: CanvasStaticExportDocument,
  /** Validated dual-consent evidence retained for the operator receipt. */
  consent: CanvasShareConsent,
  /** Optional operator note preserved from the explicit export request. */
  note: Schema.optional(
    boundedNonEmptyText(512).check(
      Schema.makeFilter((value) => exportTextHasNoSecrets(value), {
        message: "Canvas export notes must not contain secret-bearing or host-path text.",
      }),
    ),
  ),
}).check(
  Schema.makeFilter(
    (receipt) =>
      receipt.channel === "static-export" &&
      receipt.document.channel === "static-export" &&
      receipt.document.threatModelId === "canvas-share-static-export-v1",
    {
      message:
        "Canvas static export receipts must embed only static-export documents and threat models.",
    },
  ),
);
export type CanvasStaticExportReceipt = typeof CanvasStaticExportReceipt.Type;

export const decodeCanvasStaticExportRequest = Schema.decodeUnknownSync(
  CanvasStaticExportRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasStaticExportDocument = Schema.decodeUnknownSync(
  CanvasStaticExportDocument,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasStaticExportReceipt = Schema.decodeUnknownSync(
  CanvasStaticExportReceipt,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasShareConsent = Schema.decodeUnknownSync(
  CanvasShareConsent,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasStaticExportBlock = Schema.decodeUnknownSync(
  CanvasStaticExportBlock,
  STRICT_DECODE_OPTIONS,
);

/** Helper retained for policy tests that need to re-decode a local definition. */
export function decodeCanvasDefinitionForShare(value: unknown): CanvasDefinition {
  return decodeCanvasDefinition(value);
}

export type { CanvasActor, CanvasBlock, CanvasVersion };
