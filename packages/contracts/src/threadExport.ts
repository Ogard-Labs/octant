/**
 * Server-authoritative export of one thread.
 *
 * The bundle is what the journal holds for that thread, cut at a named
 * instant, in the same inspectable JSON shape an artifact bundle uses. It is
 * not a host-wide dump, not a legal package, and not a renderer-assembled
 * Markdown file.
 */

import { Schema } from "effect";
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { BrowserCaptureId } from "./browserAutomation";
import { UtcTimestamp } from "./events";
import { HostId } from "./host";
import { ImageArtifactId, ImageJobId } from "./imageGeneration";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { ThreadExportToolCall } from "./threadToolCallRecords";
import { VideoClipRecord, VideoJobId } from "./videoGeneration";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const THREAD_EXPORT_FORMAT = "octant.thread-bundle/1" as const;
export const ThreadExportFormat = Schema.Literal(THREAD_EXPORT_FORMAT);
export type ThreadExportFormat = typeof ThreadExportFormat.Type;

/**
 * Opaque thread identity. Chat, Work, and Code each brand their own id; the
 * export names the mode beside a UUID so it does not have to re-brand three
 * ways. Path separators and schemes are refused so a host path cannot ride
 * this field.
 */
export const ThreadExportId = Schema.String.check(
  Schema.isGUID(),
  Schema.makeFilter((value) => !/[\\/]/.test(value) && !/^(file|https?):/i.test(value)),
);
export type ThreadExportId = typeof ThreadExportId.Type;

export const ThreadExportRequest = Schema.Struct({
  mode: OctantMode,
  threadId: ThreadExportId,
});
export type ThreadExportRequest = typeof ThreadExportRequest.Type;

export const ThreadExportTranscriptRole = Schema.Literals(["user", "assistant"]);
export type ThreadExportTranscriptRole = typeof ThreadExportTranscriptRole.Type;

export const ThreadExportTranscriptStatus = Schema.Literals([
  "completed",
  "running",
  "waiting",
  "interrupted",
  "failed",
  "cancelled",
  "unreadable",
]);
export type ThreadExportTranscriptStatus = typeof ThreadExportTranscriptStatus.Type;

export const ThreadExportTranscriptEntry = Schema.Struct({
  role: ThreadExportTranscriptRole,
  text: Schema.String.check(Schema.isMaxLength(1_000_000)),
  occurredAt: UtcTimestamp,
  status: ThreadExportTranscriptStatus,
});
export type ThreadExportTranscriptEntry = typeof ThreadExportTranscriptEntry.Type;

export const ThreadExportTranscript = Schema.Struct({
  entries: Schema.Array(ThreadExportTranscriptEntry),
  activeCount: NonNegativeInt,
  revisedCount: NonNegativeInt,
});
export type ThreadExportTranscript = typeof ThreadExportTranscript.Type;

export const ThreadExportArtifact = Schema.Struct({
  canvasId: NonEmptyTrimmedString,
  versionId: NonEmptyTrimmedString,
  sequence: PositiveInt,
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  kind: Schema.Literals(["document", "diagram", "chart", "table", "code", "mixed"]),
  updatedAt: UtcTimestamp,
  definition: Schema.Unknown,
});
export type ThreadExportArtifact = typeof ThreadExportArtifact.Type;

export const ThreadExportAttachmentGeneration = Schema.Struct({
  jobId: ImageJobId,
  profileInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  promptHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  parentAttachmentId: Schema.optional(ImageArtifactId),
});
export type ThreadExportAttachmentGeneration = typeof ThreadExportAttachmentGeneration.Type;

/**
 * Where a Browser capture came from: the page it pictures and when it was
 * taken. The page URL and title are personal data, so they ride only on an
 * export of the thread that kept the capture.
 */
export const ThreadExportAttachmentCapture = Schema.Struct({
  captureId: BrowserCaptureId,
  origin: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  url: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  title: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024))),
  capturedAt: UtcTimestamp,
});
export type ThreadExportAttachmentCapture = typeof ThreadExportAttachmentCapture.Type;

export const ThreadExportAttachment = Schema.Struct({
  displayName: NonEmptyTrimmedString,
  mediaType: NonEmptyTrimmedString,
  byteLength: NonNegativeInt,
  status: NonEmptyTrimmedString,
  generation: Schema.optional(ThreadExportAttachmentGeneration),
  capture: Schema.optional(ThreadExportAttachmentCapture),
});
export type ThreadExportAttachment = typeof ThreadExportAttachment.Type;

export const ThreadExportCitation = Schema.Struct({
  sourceTitle: NonEmptyTrimmedString,
  sourceUrl: NonEmptyTrimmedString,
  retrievedAt: UtcTimestamp,
});
export type ThreadExportCitation = typeof ThreadExportCitation.Type;

export const ThreadExportCompletion = Schema.Struct({
  deliveryTarget: NonEmptyTrimmedString,
  satisfactionEvidence: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
});
export type ThreadExportCompletion = typeof ThreadExportCompletion.Type;

export const ThreadExportEvidence = Schema.Struct({
  artifacts: Schema.Array(ThreadExportArtifact),
  attachments: Schema.Array(ThreadExportAttachment),
  citations: Schema.Array(ThreadExportCitation),
  completion: Schema.optional(ThreadExportCompletion),
  /**
   * The thread's kept tool-call records, oldest first. Absent on a bundle cut
   * before they existed, for a thread that kept none, and on an export a
   * paired device asked for.
   */
  toolCalls: Schema.optional(Schema.Array(ThreadExportToolCall)),
});
export type ThreadExportEvidence = typeof ThreadExportEvidence.Type;

export const ThreadExportBranchOrigin = Schema.Struct({
  threadId: NonEmptyTrimmedString,
  sourceVersion: NonNegativeInt,
  carriedTurnCount: NonNegativeInt,
  occurredAt: UtcTimestamp,
});
export type ThreadExportBranchOrigin = typeof ThreadExportBranchOrigin.Type;

export const ThreadExportProvenance = Schema.Struct({
  mode: OctantMode,
  threadId: ThreadExportId,
  hostId: HostId,
  projectId: Schema.optional(ProjectId),
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  branchedFrom: Schema.optional(ThreadExportBranchOrigin),
});
export type ThreadExportProvenance = typeof ThreadExportProvenance.Type;

export const ThreadExportOmissionKind = Schema.Literals([
  "attachment-bytes",
  "superseded-turns",
  "in-progress",
  "unreadable-content",
  "truncated-conversation",
  "bulk-outside-journal",
]);
export type ThreadExportOmissionKind = typeof ThreadExportOmissionKind.Type;

export const ThreadExportOmission = Schema.Struct({
  kind: ThreadExportOmissionKind,
  count: PositiveInt,
});
export type ThreadExportOmission = typeof ThreadExportOmission.Type;

export const ThreadExportHeader = Schema.Struct({
  format: ThreadExportFormat,
  threadId: ThreadExportId,
  mode: OctantMode,
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(400)),
  projectId: Schema.optional(ProjectId),
  hostId: HostId,
  version: NonNegativeInt,
  sequence: NonNegativeInt,
  generatedAt: UtcTimestamp,
});
export type ThreadExportHeader = typeof ThreadExportHeader.Type;

/**
 * One thread, as a portable cut of what the journal holds.
 *
 * The `octant` header is the same kind of identity an artifact bundle
 * carries: which thing, which version, which host, and when the cut was
 * taken. The rest is inspectable JSON with no filesystem path and no secret.
 */
export const ThreadExportBundle = Schema.Struct({
  octant: ThreadExportHeader,
  transcript: ThreadExportTranscript,
  evidence: ThreadExportEvidence,
  provenance: ThreadExportProvenance,
  omissions: Schema.Array(ThreadExportOmission),
});
export type ThreadExportBundle = typeof ThreadExportBundle.Type;

export const ThreadExportOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("exported"),
    bundle: ThreadExportBundle,
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["not-found", "unauthorized"]),
  }),
]);
export type ThreadExportOutcome = typeof ThreadExportOutcome.Type;

export const THREAD_EXPORT_PATH = "/api/threads/export";
export const THREAD_VIDEO_ARCHIVE_PATH = "/api/threads/export/video-archive";
export const THREAD_VIDEO_ARCHIVE_QUERY = "videoArchive";
export const THREAD_VIDEO_ARCHIVE_FORMAT = "octant.thread-bundle/2";

export const ThreadVideoArchiveManifest = Schema.Struct({
  format: Schema.Literal(THREAD_VIDEO_ARCHIVE_FORMAT),
  thread: ThreadExportBundle,
  clips: Schema.NonEmptyArray(
    Schema.Struct({
      clipId: VideoClipRecord.fields.clipId,
      jobId: VideoJobId,
      size: VideoClipRecord.fields.size,
      hash: VideoClipRecord.fields.hash,
    }),
  ),
});
export type ThreadVideoArchiveManifest = typeof ThreadVideoArchiveManifest.Type;

export const ThreadVideoArchiveDownload = Schema.Struct({
  kind: Schema.Literal("archive-ready"),
  url: Schema.String.check(
    Schema.isPattern(/^\/api\/threads\/export\/video-archive\?ticket=[A-Za-z0-9_-]{43}$/),
  ),
  size: PositiveInt,
  clipCount: PositiveInt,
});
export type ThreadVideoArchiveDownload = typeof ThreadVideoArchiveDownload.Type;

export const ThreadVideoArchiveOffer = Schema.Union([
  ThreadVideoArchiveDownload,
  ThreadExportOutcome,
]);
export type ThreadVideoArchiveOffer = typeof ThreadVideoArchiveOffer.Type;

export const decodeThreadExportRequest = Schema.decodeUnknownSync(
  ThreadExportRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadExportBundle = Schema.decodeUnknownSync(
  ThreadExportBundle,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadExportOutcome = Schema.decodeUnknownSync(
  ThreadExportOutcome,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadVideoArchiveManifest = Schema.decodeUnknownSync(
  ThreadVideoArchiveManifest,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadVideoArchiveOffer = Schema.decodeUnknownSync(
  ThreadVideoArchiveOffer,
  STRICT_DECODE_OPTIONS,
);
