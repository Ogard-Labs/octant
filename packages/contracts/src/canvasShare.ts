import { Schema } from "effect";
import {
  CanvasActor,
  CanvasBlock,
  CanvasId,
  CanvasSchemaVersion,
  CanvasVersionId,
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

export const CANVAS_SHARE_SCHEMA_VERSION = 1 as const;
export const CanvasShareSchemaVersion = Schema.Literal(CANVAS_SHARE_SCHEMA_VERSION);
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
  actorKind: Schema.Literal("system", "local-user"),
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

const EXPORT_SECRET_VALUE_PATTERN =
  /(?:sk-(?:proj-)?[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|Basic\s+[A-Za-z0-9+/=]{8,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const EXPORT_SENSITIVE_QUERY_KEYS =
  /^(?:token|access_token|id_token|refresh_token|auth|authorization|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|api[_-]?key|key|password|passwd|secret|session|code|jwt)$/i;

const EXPORT_FILE_PATH_PATTERN =
  /(?:^|[\s"'`()\[\]{}<>|,;])(?:file:\/\/\/?[^\s"'`<>]+|\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|\.\.(?:\/|\\)|[A-Za-z]:\\[^\s"'`<>]*)/i;

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

export function isCanvasShareSafeText(value: string): boolean {
  if (EXPORT_SECRET_VALUE_PATTERN.test(value)) return false;
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
      }).annotations(strict),
    ).pipe(Schema.maxItems(64)),
    rows: Schema.Array(Schema.Array(ExportScalar).pipe(Schema.maxItems(64))).pipe(
      Schema.maxItems(1_024),
    ),
  }).annotations(strict),
  Schema.Struct({
    ...exportBlockFields,
    kind: Schema.Literal("chart"),
    chartType: Schema.Literal("line", "bar", "area", "scatter", "distribution"),
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
      }).annotations(strict),
    ).pipe(Schema.maxItems(64)),
  }).annotations(strict),
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
}).annotations(strict);
export type CanvasStaticExportDocument = typeof CanvasStaticExportDocument.Type;

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
