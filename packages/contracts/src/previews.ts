import { Schema } from "effect";
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { ProjectId } from "./projects";
import { CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const PreviewTargetId = brandedUuid("PreviewTargetId");
export type PreviewTargetId = typeof PreviewTargetId.Type;
export const PreviewHostId = brandedUuid("PreviewHostId");
export type PreviewHostId = typeof PreviewHostId.Type;
export const PreviewChunkId = brandedUuid("PreviewChunkId");
export type PreviewChunkId = typeof PreviewChunkId.Type;

/**
 * Opaque, server-resolved reference to a preview source. The renderer and
 * remote clients never receive a host filesystem path; the authoritative host
 * maps this token to a Project-confined source during resolution. The token
 * rejects path separators and `file:` URLs so a server bug cannot deliver a
 * renderer-facing path through this field.
 */
export const PreviewOpaqueRef = Schema.Trimmed.pipe(
  Schema.check(
    Schema.isNonEmpty(),
    Schema.makeFilter((value) => !/[\\/]/.test(value) && !value.startsWith("file:")),
  ),
  Schema.brand("PreviewOpaqueRef"),
);
export type PreviewOpaqueRef = typeof PreviewOpaqueRef.Type;

/**
 * Display name shown to the user. Constrained to a basename (no path
 * separators) so a directory path can never reach the renderer through it.
 */
export const PreviewDisplayName = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((value) => !/[\\/]/.test(value)),
);

export const PreviewTargetKind = Schema.Literals([
  "file",
  "attachment",
  "artifact-version",
  "validation-evidence",
]);
export type PreviewTargetKind = typeof PreviewTargetKind.Type;

export const PreviewTarget = Schema.Struct({
  targetId: PreviewTargetId,
  projectId: ProjectId,
  hostId: PreviewHostId,
  kind: PreviewTargetKind,
  opaqueRef: PreviewOpaqueRef,
  displayName: PreviewDisplayName,
  // Optional: for Code targets, the thread whose worktree the opaque ref was
  // minted for. Lets the pure authority policy fail closed across worktrees
  // within the same Code Project; the host still enforces worktree containment.
  boundCodeThreadId: Schema.optional(CodeThreadId),
});
export type PreviewTarget = typeof PreviewTarget.Type;

/** Complete source text only; preview chunks may be truncated or normalized. */
export const MAX_PREVIEW_EDITOR_BYTES = 5 * 1024 * 1024;
export const PreviewTextRequest = Schema.Struct({
  target: PreviewTarget,
  change: Schema.optional(
    Schema.Struct({
      revision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
      text: Schema.String.check(Schema.isMaxLength(MAX_PREVIEW_EDITOR_BYTES)),
    }),
  ),
});
export type PreviewTextRequest = typeof PreviewTextRequest.Type;
export const PreviewTextReply = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["ready", "saved"]),
    fileKey: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
    text: Schema.String.check(Schema.isMaxLength(MAX_PREVIEW_EDITOR_BYTES)),
    revision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  }),
  Schema.Struct({
    kind: Schema.Literals([
      "conflict",
      "unauthorized",
      "unavailable",
      "unsupported",
      "too-large",
      "failed",
    ]),
  }),
]);
export type PreviewTextReply = typeof PreviewTextReply.Type;
export const decodePreviewTextRequest = Schema.decodeUnknownSync(
  PreviewTextRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewTextReply = Schema.decodeUnknownSync(
  PreviewTextReply,
  STRICT_DECODE_OPTIONS,
);

/**
 * Source-version identity used for stale detection and source-versioned
 * structured selections. The content hash binds selections to the exact bytes
 * the user reviewed.
 */
export const ContentSha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  Schema.brand("ContentSha256"),
);
export type ContentSha256 = typeof ContentSha256.Type;

export const PreviewSourceVersion = Schema.Struct({
  contentSha256: ContentSha256,
  byteSize: NonNegativeInt,
  observedAt: UtcTimestamp,
});
export type PreviewSourceVersion = typeof PreviewSourceVersion.Type;

export const PreviewKind = Schema.Literals([
  "text",
  "markdown",
  "image",
  "pdf",
  "table",
  "workbook",
  "document",
  "slides",
  "unsupported",
]);
export type PreviewKind = typeof PreviewKind.Type;

export const PreviewChunkKind = Schema.Literals([
  "text",
  "markdown",
  "image",
  "pdf",
  "table",
  "workbook",
  "document",
  "slides",
]);
export type PreviewChunkKind = typeof PreviewChunkKind.Type;

export const PreviewDelimiter = Schema.Literals([",", "\t", ";", "|"]);
export type PreviewDelimiter = typeof PreviewDelimiter.Type;

export const PreviewFidelityLevel = Schema.Literals(["full", "limited"]);
export type PreviewFidelityLevel = typeof PreviewFidelityLevel.Type;

export const PreviewFidelity = Schema.Struct({
  level: PreviewFidelityLevel,
  notice: Schema.optional(NonEmptyTrimmedString),
}).check(
  Schema.makeFilter((fidelity) => fidelity.level === "full" || fidelity.notice !== undefined, {
    jsonSchema: {},
  }),
);
export type PreviewFidelity = typeof PreviewFidelity.Type;

/**
 * Bounded failure code for `failed` outcomes. Free-text exception messages
 * never cross the wire through `reason`; an optional sanitized `message` may
 * accompany the code when a human-readable hint is safe to surface.
 */
export const PreviewFailureCode = Schema.Literals([
  "decode-failed",
  "read-failed",
  "parse-failed",
  "cancelled",
  "unknown",
]);
export type PreviewFailureCode = typeof PreviewFailureCode.Type;

/**
 * Sanitized renderer-facing diagnostic text. Rejects path separators and
 * common URL schemes so absolute paths, source snippets, credentials, or
 * authority tokens cannot leak through failure messages.
 */
const PreviewSafeDiagnostic = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((value) => !/[\\/]/.test(value) && !/^(file|https?):/i.test(value)),
);

export const PreviewCapabilityFlags = Schema.Struct({
  canSearch: Schema.Boolean,
  canSelect: Schema.Boolean,
  canZoom: Schema.Boolean,
  canRevealInFinder: Schema.Boolean,
  canOpenExternally: Schema.Boolean,
  canQuickLook: Schema.Boolean,
  canEditInMonaco: Schema.Boolean,
});
export type PreviewCapabilityFlags = typeof PreviewCapabilityFlags.Type;

export const PreviewContentBounds = Schema.Struct({
  pages: Schema.optional(PositiveInt),
  worksheets: Schema.optional(PositiveInt),
  slides: Schema.optional(PositiveInt),
  rows: Schema.optional(PositiveInt),
  columns: Schema.optional(PositiveInt),
  blocks: Schema.optional(NonNegativeInt),
});
export type PreviewContentBounds = typeof PreviewContentBounds.Type;

export const PreviewManifest = Schema.Struct({
  target: PreviewTarget,
  sourceVersion: PreviewSourceVersion,
  kind: PreviewKind,
  sniffedMediaType: NonEmptyTrimmedString,
  byteSize: NonNegativeInt,
  fidelity: PreviewFidelity,
  capabilities: PreviewCapabilityFlags,
  bounds: PreviewContentBounds,
  producedAt: UtcTimestamp,
});
export type PreviewManifest = typeof PreviewManifest.Type;

export const PreviewChunkSequence = NonNegativeInt.pipe(Schema.brand("PreviewChunkSequence"));
export type PreviewChunkSequence = typeof PreviewChunkSequence.Type;

const LineRangeFields = {
  startLine: PositiveInt,
  endLine: PositiveInt,
} as const;

const RowRangeFields = {
  startRow: PositiveInt,
  endRow: PositiveInt,
} as const;

const ColumnRangeFields = {
  startColumn: PositiveInt,
  endColumn: PositiveInt,
} as const;

export const PreviewChunkDescriptor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), ...LineRangeFields }),
  Schema.Struct({ kind: Schema.Literal("markdown"), ...LineRangeFields }),
  Schema.Struct({ kind: Schema.Literal("image") }),
  Schema.Struct({ kind: Schema.Literal("pdf"), page: PositiveInt }),
  Schema.Struct({ kind: Schema.Literal("table"), ...RowRangeFields }),
  Schema.Struct({
    kind: Schema.Literal("workbook"),
    worksheet: PositiveInt,
    ...RowRangeFields,
    ...ColumnRangeFields,
  }),
  Schema.Struct({ kind: Schema.Literal("document"), blockIndex: NonNegativeInt }),
  Schema.Struct({ kind: Schema.Literal("slides"), slide: PositiveInt }),
]).check(
  Schema.makeFilter((descriptor) => {
    switch (descriptor.kind) {
      case "text":
      case "markdown":
        return descriptor.endLine >= descriptor.startLine;
      case "table":
        return descriptor.endRow >= descriptor.startRow;
      case "workbook":
        return (
          descriptor.endRow >= descriptor.startRow && descriptor.endColumn >= descriptor.startColumn
        );
      default:
        return true;
    }
  }),
);
export type PreviewChunkDescriptor = typeof PreviewChunkDescriptor.Type;

const TextPayload = Schema.Struct({
  kind: Schema.Literal("text"),
  text: Schema.String,
  encoding: NonEmptyTrimmedString,
});

const MarkdownPayload = Schema.Struct({
  kind: Schema.Literal("markdown"),
  text: Schema.String,
  encoding: NonEmptyTrimmedString,
});

const ImagePayload = Schema.Struct({
  kind: Schema.Literal("image"),
  mediaType: NonEmptyTrimmedString,
  // Renderer-facing normalized preview data only: require a safe
  // `data:image/...;base64,...` URL so a malformed parser result cannot
  // trigger a renderer-side network or local-resource load.
  dataUrl: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isPattern(/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]*$/),
  ),
});

const PdfPayload = Schema.Struct({
  kind: Schema.Literal("pdf"),
  pageText: Schema.String,
  renderedRef: Schema.optional(NonEmptyTrimmedString),
});

const TablePayload = Schema.Struct({
  kind: Schema.Literal("table"),
  rows: Schema.Array(Schema.Array(Schema.String)),
  delimiter: PreviewDelimiter,
});

const WorkbookCellValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);
export type WorkbookCellValue = typeof WorkbookCellValue.Type;

const WorkbookPayload = Schema.Struct({
  kind: Schema.Literal("workbook"),
  worksheetName: NonEmptyTrimmedString,
  rows: Schema.Array(Schema.Array(WorkbookCellValue)),
});

const DocumentPayload = Schema.Struct({
  kind: Schema.Literal("document"),
  text: Schema.String,
});

const SlidesPayload = Schema.Struct({
  kind: Schema.Literal("slides"),
  slideText: Schema.String,
  renderedRef: Schema.optional(NonEmptyTrimmedString),
});

export const PreviewChunkPayload = Schema.Union([
  TextPayload,
  MarkdownPayload,
  ImagePayload,
  PdfPayload,
  TablePayload,
  WorkbookPayload,
  DocumentPayload,
  SlidesPayload,
]);
export type PreviewChunkPayload = typeof PreviewChunkPayload.Type;

export const PreviewChunk = Schema.Struct({
  chunkId: PreviewChunkId,
  targetId: PreviewTargetId,
  sourceVersion: PreviewSourceVersion,
  kind: PreviewChunkKind,
  sequence: PreviewChunkSequence,
  descriptor: PreviewChunkDescriptor,
  payload: PreviewChunkPayload,
  isFinal: Schema.Boolean,
}).check(
  Schema.makeFilter(
    (chunk) => chunk.descriptor.kind === chunk.kind && chunk.payload.kind === chunk.kind,
  ),
);
export type PreviewChunk = typeof PreviewChunk.Type;

const SelectionTargetFields = {
  targetId: PreviewTargetId,
  sourceVersion: PreviewSourceVersion,
} as const;

const OffsetRange = Schema.Struct({ startOffset: NonNegativeInt, endOffset: NonNegativeInt }).check(
  Schema.makeFilter((range) => range.endOffset >= range.startOffset),
);

export const PreviewSelection = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text"),
    ...SelectionTargetFields,
    ...LineRangeFields,
  }),
  Schema.Struct({
    kind: Schema.Literal("markdown"),
    ...SelectionTargetFields,
    ...LineRangeFields,
  }),
  Schema.Struct({
    kind: Schema.Literal("pdf"),
    ...SelectionTargetFields,
    page: PositiveInt,
    textRange: Schema.optional(OffsetRange),
  }),
  Schema.Struct({
    kind: Schema.Literal("table"),
    ...SelectionTargetFields,
    ...RowRangeFields,
    ...ColumnRangeFields,
  }),
  Schema.Struct({
    kind: Schema.Literal("workbook"),
    ...SelectionTargetFields,
    worksheet: PositiveInt,
    ...RowRangeFields,
    ...ColumnRangeFields,
  }),
  Schema.Struct({
    kind: Schema.Literal("document"),
    ...SelectionTargetFields,
    blockIndex: NonNegativeInt,
    textRange: Schema.optional(OffsetRange),
  }),
  Schema.Struct({
    kind: Schema.Literal("slides"),
    ...SelectionTargetFields,
    slide: PositiveInt,
  }),
]).check(
  Schema.makeFilter((selection) => {
    switch (selection.kind) {
      case "text":
      case "markdown":
        return selection.endLine >= selection.startLine;
      case "table":
      case "workbook":
        return (
          selection.endRow >= selection.startRow && selection.endColumn >= selection.startColumn
        );
      default:
        return true;
    }
  }),
);
export type PreviewSelection = typeof PreviewSelection.Type;

/**
 * A bounded, source-versioned preview selection attached to the composer as
 * explicit agent context. The selection carries only the opaque target
 * identity and the bounded range; the host reauthorizes the target and
 * rechecks the source version at send time. The renderer never synthesizes
 * selections, paths, or file bodies.
 */
export const PreviewContextSelectionId = brandedUuid("PreviewContextSelectionId");
export type PreviewContextSelectionId = typeof PreviewContextSelectionId.Type;

export const PreviewContextSelection = Schema.Struct({
  id: PreviewContextSelectionId,
  selection: PreviewSelection,
  displayName: PreviewDisplayName,
});
export type PreviewContextSelection = typeof PreviewContextSelection.Type;

export const decodePreviewContextSelectionId = Schema.decodeUnknownSync(
  PreviewContextSelectionId,
  STRICT_DECODE_OPTIONS,
);

export const PreviewViewerMode = Schema.Literals(["preview", "raw"]);
export type PreviewViewerMode = typeof PreviewViewerMode.Type;

export const PreviewViewerScroll = Schema.Struct({
  x: NonNegativeInt,
  y: NonNegativeInt,
});
export type PreviewViewerScroll = typeof PreviewViewerScroll.Type;

export const PreviewViewerState = Schema.Struct({
  targetId: PreviewTargetId,
  sourceVersion: PreviewSourceVersion,
  scroll: Schema.optional(PreviewViewerScroll),
  zoom: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  page: Schema.optional(PositiveInt),
  worksheet: Schema.optional(PositiveInt),
  slide: Schema.optional(PositiveInt),
  delimiter: Schema.optional(PreviewDelimiter),
  mode: Schema.optional(PreviewViewerMode),
});
export type PreviewViewerState = typeof PreviewViewerState.Type;

export const PreviewOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready"), manifest: PreviewManifest }).check(
    Schema.makeFilter(
      (outcome) =>
        outcome.manifest.fidelity.level === "full" && outcome.manifest.kind !== "unsupported",
    ),
  ),
  Schema.Struct({
    kind: Schema.Literal("unsupported"),
    target: PreviewTarget,
    mediaType: Schema.optional(NonEmptyTrimmedString),
    canOpenExternally: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("limited-fidelity"),
    manifest: PreviewManifest,
  }).check(Schema.makeFilter((outcome) => outcome.manifest.fidelity.level === "limited")),
  Schema.Struct({
    kind: Schema.Literal("locked"),
    target: PreviewTarget,
    canOpenExternally: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("too-large"),
    target: PreviewTarget,
    byteSize: NonNegativeInt,
    limit: PositiveInt,
    canOpenExternally: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("stale"),
    target: PreviewTarget,
    knownVersion: PreviewSourceVersion,
  }),
  Schema.Struct({ kind: Schema.Literal("unauthorized"), targetId: PreviewTargetId }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), target: PreviewTarget }),
  Schema.Struct({
    kind: Schema.Literal("interrupted"),
    target: PreviewTarget,
    canRetry: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    target: PreviewTarget,
    reason: PreviewFailureCode,
    message: Schema.optional(PreviewSafeDiagnostic),
  }),
]);
export type PreviewOutcome = typeof PreviewOutcome.Type;

export const decodePreviewTargetId = Schema.decodeUnknownSync(
  PreviewTargetId,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewHostId = Schema.decodeUnknownSync(PreviewHostId, STRICT_DECODE_OPTIONS);
export const decodePreviewChunkId = Schema.decodeUnknownSync(PreviewChunkId, STRICT_DECODE_OPTIONS);
export const decodePreviewOpaqueRef = Schema.decodeUnknownSync(
  PreviewOpaqueRef,
  STRICT_DECODE_OPTIONS,
);
export const decodeContentSha256 = Schema.decodeUnknownSync(ContentSha256, STRICT_DECODE_OPTIONS);
export const decodePreviewTarget = Schema.decodeUnknownSync(PreviewTarget, STRICT_DECODE_OPTIONS);
export const decodePreviewSourceVersion = Schema.decodeUnknownSync(
  PreviewSourceVersion,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewFidelity = Schema.decodeUnknownSync(
  PreviewFidelity,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewCapabilityFlags = Schema.decodeUnknownSync(
  PreviewCapabilityFlags,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewContentBounds = Schema.decodeUnknownSync(
  PreviewContentBounds,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewManifest = Schema.decodeUnknownSync(
  PreviewManifest,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewChunkDescriptor = Schema.decodeUnknownSync(
  PreviewChunkDescriptor,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewChunkPayload = Schema.decodeUnknownSync(
  PreviewChunkPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewChunk = Schema.decodeUnknownSync(PreviewChunk, STRICT_DECODE_OPTIONS);
export const decodePreviewSelection = Schema.decodeUnknownSync(
  PreviewSelection,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewViewerState = Schema.decodeUnknownSync(
  PreviewViewerState,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewOutcome = Schema.decodeUnknownSync(PreviewOutcome, STRICT_DECODE_OPTIONS);

/**
 * Renderer request to open a preview for an opaque target. The server
 * re-resolves the opaque ref to a confined path, re-authorizes against the
 * active host/mode/Project, and returns a typed `PreviewOutcome`. An optional
 * `knownVersion` enables stale detection: when the source changed since the
 * caller last saw it, the outcome is `stale` rather than a fresh `ready`.
 */
export const PreviewOpenRequest = Schema.Struct({
  target: PreviewTarget,
  knownVersion: Schema.optional(PreviewSourceVersion),
});
export type PreviewOpenRequest = typeof PreviewOpenRequest.Type;

/**
 * Renderer request to refresh an already-open preview. Semantically an open
 * with a mandatory `knownVersion`: the server re-authorizes and re-resolves,
 * surfacing `stale` when the source version changed. It never starts a fresh
 * preview of an unknown source.
 */
export const PreviewRefreshRequest = Schema.Struct({
  target: PreviewTarget,
  knownVersion: PreviewSourceVersion,
});
export type PreviewRefreshRequest = typeof PreviewRefreshRequest.Type;

/**
 * Renderer request for the next bounded batch of preview chunks. The server
 * re-authorizes and re-resolves, re-checks the source version against the
 * caller's recorded version (stale mid-stream aborts), and emits at most
 * `maxChunks` decoded chunks starting after `afterSequence`. The final chunk
 * carries `isFinal: true`.
 */
export const PreviewChunksRequest = Schema.Struct({
  target: PreviewTarget,
  sourceVersion: PreviewSourceVersion,
  afterSequence: PreviewChunkSequence,
  maxChunks: Schema.optional(PositiveInt),
});
export type PreviewChunksRequest = typeof PreviewChunksRequest.Type;

/**
 * Renderer request to cancel an in-flight chunk stream. The server
 * re-authorizes the target before aborting its server-side stream state so a
 * revoked window cannot use cancellation to probe target existence.
 */
export const PreviewCancelRequest = Schema.Struct({
  target: PreviewTarget,
});
export type PreviewCancelRequest = typeof PreviewCancelRequest.Type;

/**
 * Reply to a chunks request. Success carries a bounded batch; every failure
 * branch is a distinct typed outcome that mirrors `PreviewOutcome` minus the
 * `ready`/`limited-fidelity`/`locked`/`too-large` branches (those surface at
 * open time, not during streaming). Unauthorized discloses only the target id.
 */
export const PreviewChunksReply = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("chunks"), chunks: Schema.Array(PreviewChunk) }),
  Schema.Struct({ kind: Schema.Literal("unauthorized"), targetId: PreviewTargetId }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), target: PreviewTarget }),
  Schema.Struct({
    kind: Schema.Literal("stale"),
    target: PreviewTarget,
    knownVersion: PreviewSourceVersion,
  }),
  Schema.Struct({
    kind: Schema.Literal("interrupted"),
    target: PreviewTarget,
    canRetry: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    target: PreviewTarget,
    reason: PreviewFailureCode,
    message: Schema.optional(PreviewSafeDiagnostic),
  }),
  Schema.Struct({
    kind: Schema.Literal("unsupported"),
    target: PreviewTarget,
    mediaType: Schema.optional(NonEmptyTrimmedString),
    canOpenExternally: Schema.Boolean,
  }),
]);
export type PreviewChunksReply = typeof PreviewChunksReply.Type;

/**
 * Reply to a cancel request. `cancelled` confirms an in-flight stream was
 * aborted; `not-found` means no stream was active for the target; unauthorized
 * discloses only the target id.
 */
export const PreviewCancelReply = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("cancelled") }),
  Schema.Struct({ kind: Schema.Literal("not-found") }),
  Schema.Struct({ kind: Schema.Literal("unauthorized"), targetId: PreviewTargetId }),
]);
export type PreviewCancelReply = typeof PreviewCancelReply.Type;

export const decodePreviewOpenRequest = Schema.decodeUnknownSync(
  PreviewOpenRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewRefreshRequest = Schema.decodeUnknownSync(
  PreviewRefreshRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewChunksRequest = Schema.decodeUnknownSync(
  PreviewChunksRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewCancelRequest = Schema.decodeUnknownSync(
  PreviewCancelRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewChunksReply = Schema.decodeUnknownSync(
  PreviewChunksReply,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewCancelReply = Schema.decodeUnknownSync(
  PreviewCancelReply,
  STRICT_DECODE_OPTIONS,
);

/**
 * External-application preview handoff kinds. The renderer requests exactly
 * one authenticated command per affordance: reveal the confined export in
 * Finder, open a Quick Look panel, or open it in the system default
 * application. Every request carries only the opaque target ref; no host path
 * and no generic shell-open ever crosses the wire.
 */
export const PreviewHandoffKind = Schema.Literals([
  "reveal-in-finder",
  "quick-look",
  "open-external",
]);
export type PreviewHandoffKind = typeof PreviewHandoffKind.Type;

/**
 * Renderer request for an authenticated external-application preview handoff.
 * The server re-resolves the opaque ref to a confined path, re-authorizes the
 * target against the active host/mode/Project, and fails closed in plan mode
 * and for remote least-authority principals. Success replies never carry a
 * host path; the authenticated desktop bridge resolves the ref again for
 * native execution.
 */
export const PreviewHandoffRequest = Schema.Struct({
  target: PreviewTarget,
  kind: PreviewHandoffKind,
});
export type PreviewHandoffRequest = typeof PreviewHandoffRequest.Type;

/**
 * Reply to a handoff request. `done` confirms the command was authorized and
 * dispatched without disclosing a path. `unauthorized` discloses only the
 * opaque target id; `unavailable` surfaces a missing source or offline host;
 * `failed` carries a bounded reason and sanitized message (cancellation
 * reports reason `cancelled`).
 */
export const PreviewHandoffReply = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("done"),
    handoffKind: PreviewHandoffKind,
  }),
  Schema.Struct({ kind: Schema.Literal("unauthorized"), targetId: PreviewTargetId }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), target: PreviewTarget }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    reason: PreviewFailureCode,
    message: Schema.optional(PreviewSafeDiagnostic),
  }),
]);
export type PreviewHandoffReply = typeof PreviewHandoffReply.Type;

export const decodePreviewHandoffRequest = Schema.decodeUnknownSync(
  PreviewHandoffRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodePreviewHandoffReply = Schema.decodeUnknownSync(
  PreviewHandoffReply,
  STRICT_DECODE_OPTIONS,
);
