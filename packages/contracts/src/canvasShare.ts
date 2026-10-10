import { Schema } from "effect";
import {
  CANVAS_MAX_BAR_LIST_ROWS,
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
  CANVAS_MAX_TREEMAP_LEAVES,
  CANVAS_MAX_TREEMAP_MEASURES,
  CanvasActor,
  CanvasBarListScale,
  CanvasBlock,
  CanvasDiagramLayoutKind,
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
  canvasMockupUsesCatalog,
  decodeCanvasDefinition,
  type CanvasDefinition,
  type CanvasVersion,
} from "./canvas";
import { ActorId, UtcTimestamp } from "./events";
import { HostId } from "./host";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const boundedNonEmptyText = (maximum: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maximum));
const boundedText = (maximum: number) => Schema.String.pipe(Schema.maxLength(maximum));
const boundedToken = <B extends string>(brand: B) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(128),
    Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    Schema.brand(brand),
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
export const CANVAS_SHARE_SCHEMA_VERSION = 6 as const;
// The newest Canvas block version a share at this version names. Canvas
// version 13 added only the table row id, which a share drops, so a block
// authored at 13 shares as 12 and a version-6 reader still accepts it. A later
// Canvas bump that adds something a share carries bumps the share version.
export const CANVAS_SHARE_MAX_BLOCK_SCHEMA_VERSION = 12 as const;
export const CanvasShareSchemaVersion = Schema.Literal(1, 2, 3, 4, 5, CANVAS_SHARE_SCHEMA_VERSION);
export type CanvasShareSchemaVersion = typeof CanvasShareSchemaVersion.Type;

export const CanvasExportId = brandedUuid("CanvasExportId");
export type CanvasExportId = typeof CanvasExportId.Type;

/**
 * Static export is the only share surface for now. Authenticated browser
 * snapshots, public links, and remote audience controls are deferred.
 */
export const CanvasShareChannel = Schema.Literal("static-export");
export type CanvasShareChannel = typeof CanvasShareChannel.Type;

/** Consent may only be given by an authenticated local user, never system automation. */
export const CanvasShareLocalUserActor = Schema.Struct({
  kind: Schema.Literal("local-user"),
  actorId: ActorId,
}).annotations(strict);
export type CanvasShareLocalUserActor = typeof CanvasShareLocalUserActor.Type;

export const CanvasShareConsent = Schema.Struct({
  /** Explicit operator acknowledgement that an offline snapshot will leave the host. */
  acknowledgedOfflineSnapshot: Schema.Literal(true),
  /** Explicit operator acknowledgement that credentials and live host authority are excluded. */
  acknowledgedNoCredentials: Schema.Literal(true),
  acknowledgedAt: UtcTimestamp,
  acknowledgedBy: CanvasShareLocalUserActor,
}).annotations(strict);
export type CanvasShareConsent = typeof CanvasShareConsent.Type;

export const CanvasStaticExportRequest = Schema.Struct({
  schemaVersion: CanvasShareSchemaVersion,
  kind: Schema.Literal("canvas-static-export"),
  exportId: CanvasExportId,
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  expectedSequence: Schema.Int.pipe(Schema.positive()),
  hostId: HostId,
  projectId: ProjectId,
  channel: CanvasShareChannel,
  consent: CanvasShareConsent,
  /** Optional operator note stored with the export receipt; never used as authority. */
  note: Schema.optional(boundedNonEmptyText(512)),
}).annotations(strict);
export type CanvasStaticExportRequest = typeof CanvasStaticExportRequest.Type;

export const CanvasRedactedProvenance = Schema.Struct({
  hostId: HostId,
  projectId: ProjectId,
  mode: Schema.Literal("chat", "work", "code"),
  /** Thread identity is retained as an opaque id; path/credential fields are never present. */
  threadId: Schema.UUID,
  createdAt: UtcTimestamp,
  /** Provider/model identity is reduced to non-secret labels only. */
  providerLabel: boundedNonEmptyText(200),
  modelLabel: boundedNonEmptyText(200),
  actorKind: Schema.Literal("system", "local-user", "agent"),
}).annotations(strict);
export type CanvasRedactedProvenance = typeof CanvasRedactedProvenance.Type;

export const CanvasStaticExportSourceEntry = Schema.Struct({
  sourceId: Schema.UUID,
  kind: boundedNonEmptyText(64),
  displayName: boundedNonEmptyText(256),
  /** Opaque reference only; never a filesystem path or live credential. */
  opaqueRef: boundedNonEmptyText(256),
}).annotations(strict);
export type CanvasStaticExportSourceEntry = typeof CanvasStaticExportSourceEntry.Type;

const exportBlockFields = {
  blockId: boundedToken("CanvasBlockId"),
  schemaVersion: CanvasSchemaVersion,
} as const;
const {
  blockId: _mockupBlockId,
  schemaVersion: _mockupSchemaVersion,
  ...exportMockupFields
} = CanvasMockupBlock.fields;

const EXPORT_SECRET_VALUE_PATTERN =
  /(?:sk-(?:proj-)?[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|Basic\s+[A-Za-z0-9+/=]{8,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const EXPORT_SENSITIVE_QUERY_KEYS =
  /^(?:token|access_token|id_token|refresh_token|auth|authorization|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|api[_-]?key|key|password|passwd|secret|session|code|jwt)$/i;

const EXPORT_FILE_PATH_PATTERN =
  /(?:^|[\s"'`()[\]{}<>|,;])(?:file:\/\/\/?[^\s"'`<>]+|\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|\.\.(?:\/|\\)|[A-Za-z]:\\[^\s"'`<>]*)/i;

/** Shared secret/path filter for every exported string surface (text, labels, notes). */
function extractCandidateUrls(value: string): string[] {
  const candidates = new Set<string>();
  const trimmed = value.trim();
  if (trimmed) candidates.add(trimmed);
  const embedded = value.match(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`<>]+/g) ?? [];
  for (const match of embedded) {
    candidates.add(match.replace(/[),.;]+$/g, ""));
  }
  return [...candidates];
}

/**
 * Whether `value` carries no credential-shaped text.
 *
 * The path half of `isCanvasShareSafeText` is deliberately left out: a local
 * destination's entire job is to tell the person which file it wrote or will
 * write, and that filter refuses any absolute path so a path can never leave
 * the host. Callers of this still bound the value themselves; what they gain
 * is the same secret scan every other exported string gets.
 */
export function isExportCredentialFreeText(value: string): boolean {
  return !EXPORT_SECRET_VALUE_PATTERN.test(value);
}

export function isCanvasShareSafeText(value: string): boolean {
  if (!isExportCredentialFreeText(value)) return false;
  if (EXPORT_FILE_PATH_PATTERN.test(value)) return false;
  for (const candidate of extractCandidateUrls(value)) {
    try {
      const parsed = new URL(candidate);
      // file: URLs disclose host filesystem locations even without credentials.
      if (parsed.protocol === "file:") return false;
      if (parsed.username || parsed.password) return false;
      for (const key of parsed.searchParams.keys()) {
        if (EXPORT_SENSITIVE_QUERY_KEYS.test(key)) return false;
      }
      // OAuth-style fragments may hide credentials only in the hash.
      if (parsed.hash.includes("=")) {
        const fragmentQuery = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
        const fragmentParams = new URLSearchParams(fragmentQuery);
        for (const key of fragmentParams.keys()) {
          if (EXPORT_SENSITIVE_QUERY_KEYS.test(key)) return false;
        }
      }
    } catch {
      // ignore non-URL candidates
    }
  }
  return true;
}

function exportTextHasNoSecrets(value: string): boolean {
  return isCanvasShareSafeText(value);
}

const ExportLabel = boundedNonEmptyText(512).pipe(
  Schema.filter((value) => exportTextHasNoSecrets(value), {
    message: () => "Canvas export labels must not contain secret-bearing text.",
  }),
);

const ExportText = boundedText(32_768).pipe(
  Schema.filter((value) => exportTextHasNoSecrets(value), {
    message: () => "Canvas export text must not contain secret-bearing values.",
  }),
);
const ExportNonEmptyText = boundedNonEmptyText(32_768).pipe(
  Schema.filter((value) => exportTextHasNoSecrets(value), {
    message: () => "Canvas export text must not contain secret-bearing values.",
  }),
);
const ExportMatrixNote = ExportText.pipe(Schema.maxLength(CANVAS_MAX_MATRIX_NOTE_LENGTH));
const exportMatrixCellFields = {
  criterionId: boundedToken("CanvasNodeId"),
  optionId: boundedToken("CanvasNodeId"),
  note: Schema.optional(ExportMatrixNote),
} as const;
const ExportMathSource = ExportNonEmptyText.pipe(Schema.maxLength(CANVAS_MAX_MATH_SOURCE_LENGTH));
const ExportUrl = Schema.String.pipe(
  Schema.maxLength(2_048),
  Schema.filter(
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
    { message: () => "Canvas export links must be credential-free http(s) URLs." },
  ),
);
const ExportScalar = Schema.Union(ExportText, Schema.Number, Schema.Boolean, Schema.Null);

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
export const CanvasStaticExportBlock = Schema.Union(
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("heading"),
    level: Schema.Int.pipe(Schema.between(1, 6)),
    text: ExportNonEmptyText,
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("rich-text"),
    text: ExportNonEmptyText,
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("callout"),
    tone: Schema.Literal("info", "success", "warning", "danger"),
    title: Schema.optional(ExportLabel),
    text: ExportNonEmptyText,
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("link"),
    label: ExportLabel,
    href: ExportUrl,
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("divider"),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("citation"),
    label: ExportLabel,
    quote: Schema.optional(ExportText),
  }).annotations(strict),
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
      Schema.Array(Schema.Number).pipe(Schema.maxItems(CANVAS_MAX_METRIC_SPARKLINE_POINTS)),
    ),
    goodDirection: Schema.optional(CanvasMetricDirection),
    caption: Schema.optional(ExportText),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("progress"),
    label: ExportLabel,
    value: Schema.Number.pipe(
      Schema.filter((value) => Number.isFinite(value) && value >= 0 && value <= 1, {
        message: () => "Canvas export progress values must be finite numbers between 0 and 1.",
      }),
    ),
    detail: Schema.optional(ExportText),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("status"),
    label: ExportLabel,
    value: ExportLabel,
    tone: Schema.Literal("neutral", "info", "success", "warning", "danger"),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("key-value"),
    entries: Schema.Array(
      Schema.Struct({
        key: ExportLabel,
        value: ExportScalar,
      }).annotations(strict),
    ).pipe(Schema.maxItems(128)),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("table"),
    columns: Schema.NonEmptyArray(
      Schema.Struct({
        id: boundedToken("CanvasTableColumnId"),
        label: ExportLabel,
        type: Schema.Literal("text", "number", "boolean", "date", "status"),
        format: Schema.optional(CanvasNumberFormat),
        display: Schema.optional(CanvasTableColumnDisplay),
      }).annotations(strict),
    ).pipe(Schema.maxItems(64)),
    rows: Schema.Array(Schema.Array(ExportScalar).pipe(Schema.maxItems(64))).pipe(
      Schema.maxItems(1_024),
    ),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("chart"),
    chartType: Schema.Literal(
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
    ),
    series: Schema.Array(
      Schema.Struct({
        seriesId: boundedToken("CanvasSeriesId"),
        label: ExportLabel,
        points: Schema.NonEmptyArray(
          Schema.Struct({
            x: Schema.Union(Schema.Number, ExportText),
            y: Schema.Number,
          }).annotations(strict),
        ).pipe(Schema.maxItems(2_048)),
        mark: Schema.optional(Schema.Literal("bar", "line")),
      }).annotations(strict),
    ).pipe(Schema.maxItems(64)),
    format: Schema.optional(CanvasNumberFormat),
  })
    .annotations(strict)
    .pipe(
      Schema.filter((block) => canvasChartSeriesIssue(block) === undefined, {
        message: () => "Chart series do not match the chart type.",
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
        status: Schema.optional(Schema.Literal("neutral", "info", "success", "warning", "danger")),
        detail: Schema.optional(ExportText),
      }).annotations(strict),
    ).pipe(Schema.maxItems(512)),
  }).annotations(strict),
  // A shared plan keeps its phases and tasks but drops each task's source ids,
  // which only resolve against the host that wrote it.
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("plan"),
    title: ExportLabel,
    view: Schema.optional(Schema.Literal("checklist", "kanban", "timeline")),
    phases: Schema.NonEmptyArray(
      Schema.Struct({
        phaseId: boundedToken("CanvasPlanPhaseId"),
        title: ExportLabel,
      }).annotations(strict),
    ).pipe(Schema.maxItems(32)),
    tasks: Schema.Array(
      Schema.Struct({
        taskId: boundedToken("CanvasPlanTaskId"),
        phaseId: boundedToken("CanvasPlanPhaseId"),
        title: ExportLabel,
        status: Schema.Literal("todo", "doing", "blocked", "done"),
        owner: Schema.optional(
          Schema.Struct({
            kind: Schema.Literal("person", "agent"),
            label: Schema.optional(ExportLabel),
          }).annotations(strict),
        ),
        estimate: Schema.optional(ExportLabel),
        notes: Schema.optional(ExportText),
        startAt: Schema.optional(UtcTimestamp),
        dueAt: Schema.optional(UtcTimestamp),
        dependsOn: Schema.optional(
          Schema.Array(boundedToken("CanvasPlanTaskId")).pipe(Schema.maxItems(16)),
        ),
      }).annotations(strict),
    ).pipe(Schema.maxItems(256)),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("diagram"),
    nodes: Schema.Array(
      Schema.Struct({
        nodeId: boundedToken("CanvasNodeId"),
        label: ExportLabel,
        role: Schema.optional(boundedToken("CanvasNodeRole")),
        x: Schema.optional(Schema.Number),
        y: Schema.optional(Schema.Number),
        positioned: Schema.optional(Schema.Literal(true)),
      }).annotations(strict),
    ).pipe(Schema.maxItems(512)),
    edges: Schema.Array(
      Schema.Struct({
        edgeId: boundedToken("CanvasEdgeId"),
        source: boundedToken("CanvasNodeId"),
        target: boundedToken("CanvasNodeId"),
        label: Schema.optional(ExportLabel),
      }).annotations(strict),
    ).pipe(Schema.maxItems(1_024)),
    groups: Schema.optional(
      Schema.Array(
        Schema.Struct({
          groupId: boundedToken("CanvasGroupId"),
          label: ExportLabel,
          nodeIds: Schema.Array(boundedToken("CanvasNodeId")).pipe(Schema.maxItems(512)),
        }).annotations(strict),
      ).pipe(Schema.maxItems(64)),
    ),
    flow: Schema.optional(Schema.Literal("down", "right")),
    layout: Schema.optional(CanvasDiagramLayoutKind),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("sequence"),
    participants: Schema.Array(
      Schema.Struct({
        participantId: boundedToken("CanvasNodeId"),
        label: ExportLabel,
      }).annotations(strict),
    ).pipe(Schema.maxItems(512)),
    messages: Schema.Array(
      Schema.Struct({
        messageId: boundedToken("CanvasEdgeId"),
        from: boundedToken("CanvasNodeId"),
        to: boundedToken("CanvasNodeId"),
        label: ExportLabel,
      }).annotations(strict),
    ).pipe(Schema.maxItems(1_024)),
    activations: Schema.optional(
      Schema.Array(
        Schema.Struct({
          activationId: boundedToken("CanvasActivationId"),
          participantId: boundedToken("CanvasNodeId"),
          startMessageId: boundedToken("CanvasEdgeId"),
          endMessageId: boundedToken("CanvasEdgeId"),
        }).annotations(strict),
      ).pipe(Schema.maxItems(512)),
    ),
    notes: Schema.optional(
      Schema.Array(
        Schema.Struct({
          noteId: boundedToken("CanvasNoteId"),
          text: ExportLabel,
          participantId: Schema.optional(boundedToken("CanvasNodeId")),
          afterMessageId: Schema.optional(boundedToken("CanvasEdgeId")),
        }).annotations(strict),
      ).pipe(Schema.maxItems(64)),
    ),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("state"),
    states: Schema.Array(
      Schema.Struct({
        stateId: boundedToken("CanvasNodeId"),
        label: ExportLabel,
        role: Schema.optional(Schema.Literal("initial", "final")),
        parentId: Schema.optional(boundedToken("CanvasNodeId")),
      }).annotations(strict),
    ).pipe(Schema.maxItems(512)),
    transitions: Schema.Array(
      Schema.Struct({
        transitionId: boundedToken("CanvasEdgeId"),
        source: boundedToken("CanvasNodeId"),
        target: boundedToken("CanvasNodeId"),
        label: ExportLabel,
      }).annotations(strict),
    ).pipe(Schema.maxItems(1_024)),
  }).annotations(strict),
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
          }).annotations(strict),
        ).pipe(Schema.maxItems(64)),
      }).annotations(strict),
    ).pipe(Schema.maxItems(512)),
    relationships: Schema.Array(
      Schema.Struct({
        relationshipId: boundedToken("CanvasEdgeId"),
        source: boundedToken("CanvasNodeId"),
        target: boundedToken("CanvasNodeId"),
        sourceCardinality: Schema.Literal("one", "zero-or-one", "many", "one-or-many"),
        targetCardinality: Schema.Literal("one", "zero-or-one", "many", "one-or-many"),
        label: Schema.optional(ExportLabel),
      }).annotations(strict),
    ).pipe(Schema.maxItems(1_024)),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("swimlane"),
    lanes: Schema.NonEmptyArray(
      Schema.Struct({
        laneId: boundedToken("CanvasSwimlaneLaneId"),
        label: ExportLabel,
        kind: Schema.optional(Schema.Literal("actor", "team")),
      }).annotations(strict),
    ).pipe(Schema.maxItems(32)),
    steps: Schema.Array(
      Schema.Struct({
        stepId: boundedToken("CanvasNodeId"),
        laneId: boundedToken("CanvasSwimlaneLaneId"),
        label: ExportLabel,
        decision: Schema.optional(Schema.Literal(true)),
      }).annotations(strict),
    ).pipe(Schema.maxItems(512)),
    connections: Schema.Array(
      Schema.Struct({
        connectionId: boundedToken("CanvasEdgeId"),
        source: boundedToken("CanvasNodeId"),
        target: boundedToken("CanvasNodeId"),
        label: Schema.optional(ExportLabel),
      }).annotations(strict),
    ).pipe(Schema.maxItems(1_024)),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("mindmap"),
    nodes: Schema.Array(
      Schema.Struct({
        nodeId: boundedToken("CanvasNodeId"),
        label: ExportLabel,
        parentId: Schema.optional(boundedToken("CanvasNodeId")),
        note: Schema.optional(ExportText),
      }).annotations(strict),
    ).pipe(Schema.maxItems(512)),
  }).annotations(strict),
  // A shared mockup is the live block as it stands: every field is drawn
  // data from closed sets or bounded text, and nothing in it resolves against
  // the host. The share policy still runs the secret filter over its text.
  Schema.Struct({
    ...exportBlockFields,
    ...exportMockupFields,
  }).annotations(strict),
  // A shared treemap or bar list keeps its readings but drops each leaf's or
  // row's source id, which only resolves against the host that wrote it.
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("treemap"),
    nodes: Schema.Array(
      Schema.Struct({
        nodeId: boundedToken("CanvasNodeId"),
        parentId: Schema.optional(boundedToken("CanvasNodeId")),
        label: ExportLabel,
        values: Schema.optional(
          Schema.Record({ key: boundedToken("CanvasTreemapMeasureId"), value: Schema.Number }),
        ),
      }).annotations(strict),
    ).pipe(Schema.maxItems(CANVAS_MAX_TREEMAP_LEAVES)),
    measures: Schema.NonEmptyArray(
      Schema.Struct({
        measureId: boundedToken("CanvasTreemapMeasureId"),
        label: ExportLabel,
        format: Schema.optional(CanvasNumberFormat),
      }).annotations(strict),
    ).pipe(Schema.maxItems(CANVAS_MAX_TREEMAP_MEASURES)),
    sizeBy: boundedToken("CanvasTreemapMeasureId"),
    colorBy: boundedToken("CanvasTreemapMeasureId"),
    colorScale: Schema.optional(CanvasTreemapScale),
    startNodeId: Schema.optional(boundedToken("CanvasNodeId")),
  }).annotations(strict),
  Schema.Struct({
    ...exportHeatmapFields,
    layout: Schema.Literal("matrix"),
    rows: Schema.NonEmptyArray(
      Schema.Struct({
        rowId: boundedToken("CanvasHeatmapRowId"),
        label: ExportLabel,
      }).annotations(strict),
    ).pipe(Schema.maxItems(CANVAS_MAX_HEATMAP_ROWS)),
    columns: Schema.NonEmptyArray(
      Schema.Struct({
        columnId: boundedToken("CanvasHeatmapColumnId"),
        label: ExportLabel,
      }).annotations(strict),
    ).pipe(Schema.maxItems(CANVAS_MAX_HEATMAP_COLUMNS)),
    cells: Schema.Array(
      Schema.Struct({
        rowId: boundedToken("CanvasHeatmapRowId"),
        columnId: boundedToken("CanvasHeatmapColumnId"),
        value: Schema.Number,
        note: Schema.optional(ExportText),
      }).annotations(strict),
    ).pipe(Schema.maxItems(CANVAS_MAX_HEATMAP_CELLS)),
  }).annotations(strict),
  Schema.Struct({
    ...exportHeatmapFields,
    layout: Schema.Literal("calendar"),
    days: Schema.NonEmptyArray(
      Schema.Struct({
        date: CanvasHeatmapDate,
        value: Schema.Number,
        note: Schema.optional(ExportText),
      }).annotations(strict),
    ).pipe(Schema.maxItems(CANVAS_MAX_HEATMAP_DAYS)),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("bar-list"),
    rows: Schema.NonEmptyArray(
      Schema.Struct({
        label: ExportLabel,
        value: Schema.Number,
        secondaryValue: Schema.optional(Schema.Number),
      }).annotations(strict),
    ).pipe(Schema.maxItems(CANVAS_MAX_BAR_LIST_ROWS)),
    valueLabel: Schema.optional(ExportLabel),
    secondaryLabel: Schema.optional(ExportLabel),
    format: Schema.optional(CanvasNumberFormat),
    secondaryFormat: Schema.optional(CanvasNumberFormat),
    scale: Schema.optional(CanvasBarListScale),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("comparison-matrix"),
    options: Schema.NonEmptyArray(
      Schema.Struct({
        optionId: boundedToken("CanvasNodeId"),
        label: ExportLabel,
        detail: Schema.optional(ExportMatrixNote),
      }).annotations(strict),
    ).pipe(Schema.maxItems(CANVAS_MAX_MATRIX_OPTIONS)),
    criteria: Schema.NonEmptyArray(
      Schema.Struct({
        criterionId: boundedToken("CanvasNodeId"),
        label: ExportLabel,
        weight: Schema.optional(Schema.Number.pipe(Schema.between(0, CANVAS_MAX_MATRIX_WEIGHT))),
        prefer: Schema.optional(CanvasMatrixPreference),
        detail: Schema.optional(ExportMatrixNote),
      }).annotations(strict),
    ).pipe(Schema.maxItems(CANVAS_MAX_MATRIX_CRITERIA)),
    cells: Schema.Array(
      Schema.Union(
        Schema.Struct({ ...exportMatrixCellFields, score: Schema.Number }).annotations(strict),
        Schema.Struct({
          ...exportMatrixCellFields,
          text: ExportLabel.pipe(Schema.maxLength(CANVAS_MAX_MATRIX_CELL_TEXT_LENGTH)),
        }).annotations(strict),
        Schema.Struct({ ...exportMatrixCellFields, glyph: CanvasMatrixGlyph }).annotations(strict),
      ),
    ).pipe(Schema.maxItems(CANVAS_MAX_MATRIX_CELLS)),
    scoreRange: Schema.optional(
      Schema.Struct({ min: Schema.Number, max: Schema.Number }).annotations(strict),
    ),
    recommendedOptionId: Schema.optional(boundedToken("CanvasNodeId")),
    recommendation: Schema.optional(
      ExportText.pipe(Schema.maxLength(CANVAS_MAX_MATRIX_NOTE_LENGTH * 2)),
    ),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("math"),
    layout: Schema.Literal("display"),
    source: ExportMathSource,
    caption: Schema.optional(ExportLabel.pipe(Schema.maxLength(CANVAS_MAX_MATH_CAPTION_LENGTH))),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("math"),
    layout: Schema.Literal("inline"),
    runs: Schema.NonEmptyArray(
      Schema.Union(
        Schema.Struct({
          text: ExportText.pipe(
            Schema.maxLength(CANVAS_MAX_MATH_PARAGRAPH_LENGTH),
            Schema.filter((value) => value.trim().length > 0),
          ),
        }).annotations(strict),
        Schema.Struct({ math: ExportMathSource }).annotations(strict),
      ),
    ).pipe(Schema.maxItems(CANVAS_MAX_MATH_RUNS)),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("code-excerpt"),
    language: boundedToken("CanvasLanguage"),
    code: ExportNonEmptyText,
    startLine: Schema.optional(Schema.Int.pipe(Schema.positive())),
    endLine: Schema.optional(Schema.Int.pipe(Schema.positive())),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("pseudocode"),
    code: ExportNonEmptyText,
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("diff"),
    hunks: Schema.Array(
      Schema.Struct({
        header: ExportLabel,
        lines: Schema.Array(
          Schema.Struct({
            kind: Schema.Literal("add", "remove", "context"),
            text: ExportText,
          }).annotations(strict),
        ).pipe(Schema.maxItems(4_096)),
      }).annotations(strict),
    ).pipe(Schema.maxItems(128)),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("source-reference"),
    label: ExportLabel,
    detail: Schema.optional(ExportText),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("summary"),
    summaryKind: Schema.Literal(
      "task",
      "thread",
      "subagent",
      "provider",
      "model",
      "usage",
      "test",
      "pull-request",
    ),
    title: ExportLabel,
    items: Schema.Array(
      Schema.Struct({
        label: ExportLabel,
        value: Schema.optional(ExportScalar),
        status: Schema.optional(Schema.Literal("neutral", "info", "success", "warning", "danger")),
      }).annotations(strict),
    ).pipe(Schema.maxItems(128)),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("artifact-reference"),
    label: ExportLabel,
    detail: Schema.optional(ExportText),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("file-reference"),
    label: ExportLabel,
    detail: Schema.optional(ExportText),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("preview-reference"),
    label: ExportLabel,
    detail: Schema.optional(ExportText),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("browser-reference"),
    label: ExportLabel,
    detail: Schema.optional(ExportText),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("evidence-reference"),
    label: ExportLabel,
    detail: Schema.optional(ExportText),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("image"),
    alt: ExportNonEmptyText,
    caption: Schema.optional(ExportText),
  }).annotations(strict),
);
export type CanvasStaticExportBlock = typeof CanvasStaticExportBlock.Type;

export const CanvasStaticExportDocument = Schema.Struct({
  schemaVersion: CanvasShareSchemaVersion,
  kind: Schema.Literal("canvas-static-export-document"),
  exportId: CanvasExportId,
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  sequence: Schema.Int.pipe(Schema.positive()),
  exportedAt: UtcTimestamp,
  title: boundedNonEmptyText(256).pipe(
    Schema.filter((value) => isCanvasShareSafeText(value), {
      message: () => "Canvas export document titles must not contain secrets or host paths.",
    }),
  ),
  channel: Schema.Literal("static-export", "authenticated-snapshot"),
  sharingEnabled: Schema.Literal(true),
  provenance: CanvasRedactedProvenance,
  sourceManifest: Schema.Array(CanvasStaticExportSourceEntry).pipe(Schema.maxItems(128)),
  /**
   * Blocks are restricted to the sanitized first-party export union. Unknown
   * kinds, future schema versions, and source-bound authority fields fail closed.
   */
  blocks: Schema.Array(CanvasStaticExportBlock).pipe(Schema.maxItems(128)),
  threatModelId: Schema.Literal(
    "canvas-share-static-export-v1",
    "canvas-share-authenticated-snapshot-v1",
  ),
})
  .annotations(strict)
  .pipe(
    // Same version gate as the live definition: mockup blocks are declared by
    // share version 2, which accompanies Canvas schema version 3. A v1
    // document carrying one is refused at decode, not partially rendered.
    Schema.filter(
      (document) =>
        document.schemaVersion >= CANVAS_SHARE_MOCKUP_SCHEMA_VERSION ||
        !document.blocks.some((block) => block.kind === "mockup"),
      { message: () => "Mockup blocks require Canvas share version 2." },
    ),
    Schema.filter(
      (document) =>
        document.schemaVersion >= CANVAS_SHARE_VISUALS_SCHEMA_VERSION ||
        !document.blocks.some(exportBlockUsesVisuals),
      {
        message: () =>
          "Treemap, heatmap, and bar-list blocks, number formats on charts and table columns, table column displays, and a board's own layout require Canvas share version 3.",
      },
    ),
    Schema.filter(
      (document) =>
        document.schemaVersion >= CANVAS_SHARE_COMPARISON_MATRIX_SCHEMA_VERSION ||
        !document.blocks.some((block) => block.kind === "comparison-matrix"),
      { message: () => "Comparison matrix blocks require Canvas share version 4." },
    ),
    Schema.filter(
      (document) =>
        document.schemaVersion >= CANVAS_SHARE_MATH_SCHEMA_VERSION ||
        !document.blocks.some((block) => block.kind === "math"),
      { message: () => "Math blocks require Canvas share version 5." },
    ),
    Schema.filter(
      (document) =>
        document.schemaVersion >= CANVAS_SHARE_MOCKUP_CATALOG_SCHEMA_VERSION ||
        !document.blocks.some(canvasMockupUsesCatalog),
      { message: () => "A mockup that uses the catalog requires Canvas share version 6." },
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
  sequence: Schema.Int.pipe(Schema.positive()),
  exportedAt: UtcTimestamp,
  channel: CanvasShareChannel,
  document: CanvasStaticExportDocument,
  /** Validated dual-consent evidence retained for the operator receipt. */
  consent: CanvasShareConsent,
  /** Optional operator note preserved from the explicit export request. */
  note: Schema.optional(
    boundedNonEmptyText(512).pipe(
      Schema.filter((value) => exportTextHasNoSecrets(value), {
        message: () => "Canvas export notes must not contain secret-bearing or host-path text.",
      }),
    ),
  ),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (receipt) =>
        receipt.channel === "static-export" &&
        receipt.document.channel === "static-export" &&
        receipt.document.threatModelId === "canvas-share-static-export-v1",
      {
        message: () =>
          "Canvas static export receipts must embed only static-export documents and threat models.",
      },
    ),
  );
export type CanvasStaticExportReceipt = typeof CanvasStaticExportReceipt.Type;

export const decodeCanvasStaticExportRequest = Schema.decodeUnknownSync(CanvasStaticExportRequest);
export const decodeCanvasStaticExportDocument = Schema.decodeUnknownSync(
  CanvasStaticExportDocument,
);
export const decodeCanvasStaticExportReceipt = Schema.decodeUnknownSync(CanvasStaticExportReceipt);
export const decodeCanvasShareConsent = Schema.decodeUnknownSync(CanvasShareConsent);
export const decodeCanvasStaticExportBlock = Schema.decodeUnknownSync(CanvasStaticExportBlock);

/** Helper retained for policy tests that need to re-decode a local definition. */
export function decodeCanvasDefinitionForShare(value: unknown): CanvasDefinition {
  return decodeCanvasDefinition(value);
}

export type { CanvasActor, CanvasBlock, CanvasVersion };
