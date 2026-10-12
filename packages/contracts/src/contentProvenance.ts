import { Schema } from "effect";
import { AggregateId, AggregateVersion, CorrelationId, UtcTimestamp } from "./events";
import { OctantMode } from "./modes";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

const opaqueLabel = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(128),
  Schema.filter((value) => !value.includes("/") && !value.includes("\\") && !value.includes("\0"), {
    message: () => "Content provenance labels must be opaque and path-free.",
  }),
);

const opaqueReference = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(512),
  Schema.filter((value) => !value.includes("/") && !value.includes("\\") && !value.includes("\0")),
);

/**
 * Provenance origin for journaled tool results and ingested content payloads.
 * See docs/security/security-architecture-threat-model.md § Untrusted-Content Policy.
 */
export const ContentOrigin = Schema.Literal(
  "tool-result",
  "external-content",
  "user",
  "provider-text",
);
export type ContentOrigin = typeof ContentOrigin.Type;

export const ContentProvenance = Schema.Struct({
  origin: ContentOrigin,
  sourceLabel: opaqueLabel,
}).annotations(strict);
export type ContentProvenance = typeof ContentProvenance.Type;

/**
 * Journaled ingestion record: provenance + opaque content reference only.
 * Raw bodies and secrets never enter the journal payload. The versioned event
 * `thread.external-content-ingested@1` carries this payload on the
 * `thread-external-content` aggregate (aggregate id = thread id).
 */
export const MAX_CONTENT_SOURCE_LABEL_LENGTH = 128;
export const MAX_CONTENT_REFERENCE_LENGTH = 512;
export const MAX_CONTENT_INGESTED_PAYLOAD_BYTES = 2_048;
export const MAX_NAMED_INGESTED_SOURCES = 64;

export const THREAD_EXTERNAL_CONTENT_AGGREGATE = "thread-external-content";
export const THREAD_EXTERNAL_CONTENT_EVENT_NAMES = {
  ingested: "thread.external-content-ingested@1",
  cleared: "thread.external-content-cleared@1",
} as const;

export const ContentIngestedPayload = Schema.Struct({
  threadId: AggregateId,
  correlationId: CorrelationId,
  provenance: ContentProvenance,
  contentReference: opaqueReference,
}).annotations(strict);
export type ContentIngestedPayload = typeof ContentIngestedPayload.Type;

// The same brand as the shell's `WindowId`. It is spelled here because the
// shell contract reaches this module through the tool catalog, and importing
// it back would close that loop.
const clearingWindowId = Schema.UUID.pipe(Schema.brand("WindowId"));

const ingestionCount = Schema.Int.pipe(Schema.positive());

/**
 * Journaled record that a person at a local window reviewed what a thread
 * read and took its mark away. `thread.external-content-cleared@1` carries it
 * on the same aggregate as the ingestions it clears; the envelope's actor and
 * time say who and when. It names what was cleared and never what was read.
 */
export const ContentClearedPayload = Schema.Struct({
  threadId: AggregateId,
  windowId: clearingWindowId,
  clearedSources: Schema.Array(opaqueLabel).pipe(Schema.maxItems(MAX_NAMED_INGESTED_SOURCES)),
  // Zero is allowed so a mark whose ingestion rows are gone can still be cleared.
  ingestionCount: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type ContentClearedPayload = typeof ContentClearedPayload.Type;

/**
 * Thread-lifetime taint projection over provenance events.
 * Once true, `externalContentIngested` does not clear on session/turn
 * boundaries; only a person's clear turns it false, until the next ingestion.
 */
export const ThreadExternalContentTaint = Schema.Struct({
  externalContentIngested: Schema.Boolean,
  ingestedSources: Schema.Array(opaqueLabel).pipe(Schema.maxItems(MAX_NAMED_INGESTED_SOURCES)),
}).annotations(strict);
export type ThreadExternalContentTaint = typeof ThreadExternalContentTaint.Type;

/** One source a thread took outside content from since it was last clear. */
export const ThreadExternalContentSource = Schema.Struct({
  sourceLabel: opaqueLabel,
  ingestionCount,
  // Absent for an ingestion projected before the host recorded its time.
  firstIngestedAt: Schema.optional(UtcTimestamp),
  lastIngestedAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type ThreadExternalContentSource = typeof ThreadExternalContentSource.Type;

/**
 * What a person reviews before clearing: the sources, how often and when each
 * was read, and the aggregate version a clear must name. Never content.
 */
export const ThreadExternalContentState = Schema.Struct({
  threadId: AggregateId,
  externalContentIngested: Schema.Boolean,
  version: AggregateVersion,
  ingestionCount: Schema.Int.pipe(Schema.nonNegative()),
  sources: Schema.Array(ThreadExternalContentSource).pipe(
    Schema.maxItems(MAX_NAMED_INGESTED_SOURCES),
  ),
}).annotations(strict);
export type ThreadExternalContentState = typeof ThreadExternalContentState.Type;

const threadScope = { mode: OctantMode, threadId: AggregateId };

/**
 * The one request shape of the local-only external-content route. A clear
 * names the version the person was shown, so an ingestion they have not seen
 * refuses it. Nothing here adds or edits a mark.
 */
export const ThreadExternalContentRequest = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("read"), ...threadScope }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("clear"),
    ...threadScope,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
);
export type ThreadExternalContentRequest = typeof ThreadExternalContentRequest.Type;

export const ThreadExternalContentClearRefusal = Schema.Literal(
  "unauthorized",
  "thread-unavailable",
  "turn-active",
  "turn-unconfirmed",
  "stale",
);
export type ThreadExternalContentClearRefusal = typeof ThreadExternalContentClearRefusal.Type;

/**
 * A decided outcome carries the state as it is now, so a surface can redraw.
 * A refusal for want of authority, or of a thread the window cannot reach,
 * carries none.
 */
export const ThreadExternalContentClearOutcome = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("cleared"),
    state: ThreadExternalContentState,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("already-clear"),
    state: ThreadExternalContentState,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: ThreadExternalContentClearRefusal,
    state: Schema.optional(ThreadExternalContentState),
  }).annotations(strict),
);
export type ThreadExternalContentClearOutcome = typeof ThreadExternalContentClearOutcome.Type;

export const decodeContentOrigin = Schema.decodeUnknownSync(ContentOrigin);
export const decodeContentProvenance = Schema.decodeUnknownSync(ContentProvenance);
export const decodeContentIngestedPayload = Schema.decodeUnknownSync(ContentIngestedPayload);
export const decodeThreadExternalContentTaint = Schema.decodeUnknownSync(
  ThreadExternalContentTaint,
);
export const decodeContentClearedPayload = Schema.decodeUnknownSync(ContentClearedPayload);
export const decodeThreadExternalContentState = Schema.decodeUnknownSync(
  ThreadExternalContentState,
);
export const decodeThreadExternalContentRequest = Schema.decodeUnknownSync(
  ThreadExternalContentRequest,
);
export const decodeThreadExternalContentClearOutcome = Schema.decodeUnknownSync(
  ThreadExternalContentClearOutcome,
);
