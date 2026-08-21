import { Schema } from "effect";
import { AggregateId, CorrelationId } from "./events";

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
} as const;

export const ContentIngestedPayload = Schema.Struct({
  threadId: AggregateId,
  correlationId: CorrelationId,
  provenance: ContentProvenance,
  contentReference: opaqueReference,
}).annotations(strict);
export type ContentIngestedPayload = typeof ContentIngestedPayload.Type;

/**
 * Thread-lifetime taint projection over provenance events.
 * Once true, `externalContentIngested` does not clear on session/turn boundaries.
 */
export const ThreadExternalContentTaint = Schema.Struct({
  externalContentIngested: Schema.Boolean,
  ingestedSources: Schema.Array(opaqueLabel).pipe(Schema.maxItems(MAX_NAMED_INGESTED_SOURCES)),
}).annotations(strict);
export type ThreadExternalContentTaint = typeof ThreadExternalContentTaint.Type;

export const decodeContentOrigin = Schema.decodeUnknownSync(ContentOrigin);
export const decodeContentProvenance = Schema.decodeUnknownSync(ContentProvenance);
export const decodeContentIngestedPayload = Schema.decodeUnknownSync(ContentIngestedPayload);
export const decodeThreadExternalContentTaint = Schema.decodeUnknownSync(
  ThreadExternalContentTaint,
);
