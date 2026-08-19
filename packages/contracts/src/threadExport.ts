/**
 * Server-authoritative export of one thread.
 *
 * The bundle is what the journal holds for that thread, cut at a named
 * instant, in the same inspectable JSON shape an artifact bundle uses. It is
 * not a host-wide dump, not a legal package, and not a renderer-assembled
 * Markdown file.
 */

import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { HostId } from "./host";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
const PositiveInt = Schema.Int.pipe(Schema.positive());

export const THREAD_EXPORT_FORMAT = "octant.thread-bundle/1" as const;
export const ThreadExportFormat = Schema.Literal(THREAD_EXPORT_FORMAT);
export type ThreadExportFormat = typeof ThreadExportFormat.Type;

/**
 * Opaque thread identity. Chat, Work, and Code each brand their own id; the
 * export names the mode beside a UUID so it does not have to re-brand three
 * ways. Path separators and schemes are refused so a host path cannot ride
 * this field.
 */
export const ThreadExportId = Schema.UUID.pipe(
  Schema.filter((value) => !/[\\/]/.test(value) && !/^(file|https?):/i.test(value)),
);
export type ThreadExportId = typeof ThreadExportId.Type;

export const ThreadExportRequest = Schema.Struct({
  mode: OctantMode,
  threadId: ThreadExportId,
}).annotations(strict);
export type ThreadExportRequest = typeof ThreadExportRequest.Type;

export const ThreadExportTranscriptRole = Schema.Literal("user", "assistant");
export type ThreadExportTranscriptRole = typeof ThreadExportTranscriptRole.Type;

export const ThreadExportTranscriptStatus = Schema.Literal(
  "completed",
  "running",
  "waiting",
  "interrupted",
  "failed",
  "cancelled",
  "unreadable",
);
export type ThreadExportTranscriptStatus = typeof ThreadExportTranscriptStatus.Type;

export const ThreadExportTranscriptEntry = Schema.Struct({
  role: ThreadExportTranscriptRole,
  text: Schema.String.pipe(Schema.maxLength(1_000_000)),
  occurredAt: UtcTimestamp,
  status: ThreadExportTranscriptStatus,
}).annotations(strict);
export type ThreadExportTranscriptEntry = typeof ThreadExportTranscriptEntry.Type;

export const ThreadExportTranscript = Schema.Struct({
  entries: Schema.Array(ThreadExportTranscriptEntry),
  activeCount: NonNegativeInt,
  revisedCount: NonNegativeInt,
}).annotations(strict);
export type ThreadExportTranscript = typeof ThreadExportTranscript.Type;

export const ThreadExportArtifact = Schema.Struct({
  canvasId: Schema.NonEmptyTrimmedString,
  versionId: Schema.NonEmptyTrimmedString,
  sequence: PositiveInt,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  kind: Schema.Literal("document", "diagram", "chart", "table", "code", "mixed"),
  updatedAt: UtcTimestamp,
  definition: Schema.Unknown,
}).annotations(strict);
export type ThreadExportArtifact = typeof ThreadExportArtifact.Type;

export const ThreadExportAttachment = Schema.Struct({
  displayName: Schema.NonEmptyTrimmedString,
  mediaType: Schema.NonEmptyTrimmedString,
  byteLength: NonNegativeInt,
  status: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type ThreadExportAttachment = typeof ThreadExportAttachment.Type;

export const ThreadExportCitation = Schema.Struct({
  sourceTitle: Schema.NonEmptyTrimmedString,
  sourceUrl: Schema.NonEmptyTrimmedString,
  retrievedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadExportCitation = typeof ThreadExportCitation.Type;

export const ThreadExportCompletion = Schema.Struct({
  deliveryTarget: Schema.NonEmptyTrimmedString,
  satisfactionEvidence: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096)),
}).annotations(strict);
export type ThreadExportCompletion = typeof ThreadExportCompletion.Type;

export const ThreadExportEvidence = Schema.Struct({
  artifacts: Schema.Array(ThreadExportArtifact),
  attachments: Schema.Array(ThreadExportAttachment),
  citations: Schema.Array(ThreadExportCitation),
  completion: Schema.optional(ThreadExportCompletion),
}).annotations(strict);
export type ThreadExportEvidence = typeof ThreadExportEvidence.Type;

export const ThreadExportBranchOrigin = Schema.Struct({
  threadId: Schema.NonEmptyTrimmedString,
  sourceVersion: NonNegativeInt,
  carriedTurnCount: NonNegativeInt,
  occurredAt: UtcTimestamp,
}).annotations(strict);
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
}).annotations(strict);
export type ThreadExportProvenance = typeof ThreadExportProvenance.Type;

export const ThreadExportOmissionKind = Schema.Literal(
  "attachment-bytes",
  "superseded-turns",
  "in-progress",
  "unreadable-content",
  "truncated-conversation",
  "bulk-outside-journal",
);
export type ThreadExportOmissionKind = typeof ThreadExportOmissionKind.Type;

export const ThreadExportOmission = Schema.Struct({
  kind: ThreadExportOmissionKind,
  count: PositiveInt,
}).annotations(strict);
export type ThreadExportOmission = typeof ThreadExportOmission.Type;

export const ThreadExportHeader = Schema.Struct({
  format: ThreadExportFormat,
  threadId: ThreadExportId,
  mode: OctantMode,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(400)),
  projectId: Schema.optional(ProjectId),
  hostId: HostId,
  version: NonNegativeInt,
  sequence: NonNegativeInt,
  generatedAt: UtcTimestamp,
}).annotations(strict);
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
}).annotations(strict);
export type ThreadExportBundle = typeof ThreadExportBundle.Type;

export const ThreadExportOutcome = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("exported"),
    bundle: ThreadExportBundle,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literal("not-found", "unauthorized"),
  }).annotations(strict),
);
export type ThreadExportOutcome = typeof ThreadExportOutcome.Type;

export const decodeThreadExportRequest = Schema.decodeUnknownSync(ThreadExportRequest);
export const decodeThreadExportBundle = Schema.decodeUnknownSync(ThreadExportBundle);
export const decodeThreadExportOutcome = Schema.decodeUnknownSync(ThreadExportOutcome);
