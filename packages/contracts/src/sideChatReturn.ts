import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { MentionableThreadId } from "./threadMentionIdentity";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Digest = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
export const MAX_SIDE_CHAT_DRAFT_RETURNS = 4;
export const MAX_SIDE_CHAT_RETURN_CHARACTERS = 32_000;
export const MAX_SIDE_CHAT_SOURCE_VERSION_FACTS = 128;

/** Versions observed by host reads, not a claim that independent reads were atomic. */
export const SideChatSourceVersionFact = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("aggregate"),
    aggregateType: Schema.Literal(
      "chat-thread",
      "work-thread",
      "work-turn",
      "code-thread",
      "code-operation",
    ),
    id: Schema.UUID,
    version: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("content"), id: Schema.UUID, digest: Digest }).annotations(
    strict,
  ),
);
export type SideChatSourceVersionFact = typeof SideChatSourceVersionFact.Type;

/** Retained on the existing journaled Chat attempt that read this bounded context. */
export const SideChatSourceReceipt = Schema.Struct({
  sourceThreadId: MentionableThreadId,
  sourceMode: OctantMode,
  capturedAt: UtcTimestamp,
  contextDigest: Digest,
  threadVersionBefore: Schema.optional(AggregateVersion),
  threadVersionAfter: Schema.optional(AggregateVersion),
  versions: Schema.Array(SideChatSourceVersionFact).pipe(
    Schema.maxItems(MAX_SIDE_CHAT_SOURCE_VERSION_FACTS),
  ),
  versionsTruncated: Schema.Boolean,
  transcriptTruncated: Schema.Boolean,
  omissions: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))).pipe(
    Schema.maxItems(16),
  ),
}).annotations(strict);
export type SideChatSourceReceipt = typeof SideChatSourceReceipt.Type;

/** Person-selected reply identity. Host re-resolves the link and immutable reply at every send. */
export const SideChatDraftReturnReference = Schema.Struct({
  sidecarThreadId: MentionableThreadId,
  sourceThreadId: MentionableThreadId,
  sourceMode: OctantMode,
  turnId: Schema.UUID,
  attemptId: Schema.UUID,
  answerDigest: Digest,
  sourceReceiptDigest: Schema.optional(Digest),
}).annotations(strict);
export type SideChatDraftReturnReference = typeof SideChatDraftReturnReference.Type;
export const SideChatDraftReturnReferences = Schema.Array(SideChatDraftReturnReference).pipe(
  Schema.maxItems(MAX_SIDE_CHAT_DRAFT_RETURNS),
);

export const SideChatDraftPrepared = Schema.Struct({
  kind: Schema.Literal("side-chat-draft-prepared"),
  reference: SideChatDraftReturnReference,
  destination: Schema.Struct({
    threadId: MentionableThreadId,
    mode: OctantMode,
    title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(400)),
    version: AggregateVersion,
    busy: Schema.optional(Schema.Boolean),
  }).annotations(strict),
  text: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(MAX_SIDE_CHAT_RETURN_CHARACTERS + 8_000),
  ),
  omissions: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))).pipe(
    Schema.maxItems(16),
  ),
}).annotations(strict);
export type SideChatDraftPrepared = typeof SideChatDraftPrepared.Type;
export const decodeSideChatSourceReceipt = Schema.decodeUnknownSync(SideChatSourceReceipt);
export const decodeSideChatDraftReturnReference = Schema.decodeUnknownSync(
  SideChatDraftReturnReference,
);
export const decodeSideChatDraftReturnReferences = Schema.decodeUnknownSync(
  SideChatDraftReturnReferences,
);
export const decodeSideChatDraftPrepared = Schema.decodeUnknownSync(SideChatDraftPrepared);
