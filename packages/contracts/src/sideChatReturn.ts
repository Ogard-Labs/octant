import { Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AggregateVersion, UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { MentionableThreadId } from "./threadMentionIdentity";

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export const MAX_SIDE_CHAT_DRAFT_RETURNS = 4;
export const MAX_SIDE_CHAT_RETURN_CHARACTERS = 32_000;
export const MAX_SIDE_CHAT_SOURCE_VERSION_FACTS = 128;

/** Versions observed by host reads, not a claim that independent reads were atomic. */
export const SideChatSourceVersionFact = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("aggregate"),
    aggregateType: Schema.Literals([
      "chat-thread",
      "work-thread",
      "work-turn",
      "code-thread",
      "code-operation",
    ]),
    id: GuidString,
    version: AggregateVersion,
  }),
  Schema.Struct({ kind: Schema.Literal("content"), id: GuidString, digest: Digest }),
]);
export type SideChatSourceVersionFact = typeof SideChatSourceVersionFact.Type;

/** Retained on the existing journaled Chat attempt that read this bounded context. */
export const SideChatSourceReceipt = Schema.Struct({
  sourceThreadId: MentionableThreadId,
  sourceMode: OctantMode,
  capturedAt: UtcTimestamp,
  contextDigest: Digest,
  threadVersionBefore: Schema.optional(AggregateVersion),
  threadVersionAfter: Schema.optional(AggregateVersion),
  versions: Schema.Array(SideChatSourceVersionFact).check(
    Schema.isMaxLength(MAX_SIDE_CHAT_SOURCE_VERSION_FACTS),
  ),
  versionsTruncated: Schema.Boolean,
  transcriptTruncated: Schema.Boolean,
  omissions: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512))).check(
    Schema.isMaxLength(16),
  ),
});
export type SideChatSourceReceipt = typeof SideChatSourceReceipt.Type;

/** Person-selected reply identity. Host re-resolves the link and immutable reply at every send. */
export const SideChatDraftReturnReference = Schema.Struct({
  sidecarThreadId: MentionableThreadId,
  sourceThreadId: MentionableThreadId,
  sourceMode: OctantMode,
  turnId: GuidString,
  attemptId: GuidString,
  answerDigest: Digest,
  sourceReceiptDigest: Schema.optional(Digest),
});
export type SideChatDraftReturnReference = typeof SideChatDraftReturnReference.Type;
export const SideChatDraftReturnReferences = Schema.Array(SideChatDraftReturnReference).check(
  Schema.isMaxLength(MAX_SIDE_CHAT_DRAFT_RETURNS),
);

export const SideChatDraftPrepared = Schema.Struct({
  kind: Schema.Literal("side-chat-draft-prepared"),
  reference: SideChatDraftReturnReference,
  destination: Schema.Struct({
    threadId: MentionableThreadId,
    mode: OctantMode,
    title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(400)),
    version: AggregateVersion,
    busy: Schema.optional(Schema.Boolean),
  }),
  text: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_SIDE_CHAT_RETURN_CHARACTERS + 8_000),
  ),
  omissions: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512))).check(
    Schema.isMaxLength(16),
  ),
});
export type SideChatDraftPrepared = typeof SideChatDraftPrepared.Type;
export const decodeSideChatSourceReceipt = Schema.decodeUnknownSync(
  SideChatSourceReceipt,
  STRICT_DECODE_OPTIONS,
);
export const decodeSideChatDraftReturnReference = Schema.decodeUnknownSync(
  SideChatDraftReturnReference,
  STRICT_DECODE_OPTIONS,
);
export const decodeSideChatDraftReturnReferences = Schema.decodeUnknownSync(
  SideChatDraftReturnReferences,
  STRICT_DECODE_OPTIONS,
);
export const decodeSideChatDraftPrepared = Schema.decodeUnknownSync(
  SideChatDraftPrepared,
  STRICT_DECODE_OPTIONS,
);
