import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const ConversationInputPurpose = Schema.Literal(
  "child-delegation",
  "provider-switch",
  "rewind",
  "fork",
  "branch",
  "fork-merge-back",
);
export type ConversationInputPurpose = typeof ConversationInputPurpose.Type;
export const ConversationInputPolicy = Schema.Literal("preserve", "text-only");
export type ConversationInputPolicy = typeof ConversationInputPolicy.Type;
export const MAX_CONVERSATION_INPUTS = 8;
export const MAX_CONVERSATION_INPUT_BYTES = 32 * 1024 * 1024;

export const ConversationInputReference = Schema.Struct({
  source: Schema.Struct({
    mode: Schema.Literal("chat", "work", "code"),
    threadId: Schema.UUID,
    attachmentId: Schema.UUID,
  }).annotations(strict),
  displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  mediaType: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  byteLength: Schema.Int.pipe(Schema.between(1, 26_214_400)),
  digest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
}).annotations(strict);
export type ConversationInputReference = typeof ConversationInputReference.Type;
export const ConversationInputOmissionReason = Schema.Literal(
  "person-excluded",
  "unsupported",
  "missing",
  "changed",
  "source-unavailable",
  "too-many",
  "too-large",
);
export type ConversationInputOmissionReason = typeof ConversationInputOmissionReason.Type;
export const ConversationInputManifest = Schema.Struct({
  version: Schema.Literal(1),
  purpose: ConversationInputPurpose,
  items: Schema.Array(
    Schema.Union(
      Schema.Struct({
        status: Schema.Literal("included"),
        input: ConversationInputReference,
      }).annotations(strict),
      Schema.Struct({
        status: Schema.Literal("omitted"),
        input: ConversationInputReference,
        reason: ConversationInputOmissionReason,
      }).annotations(strict),
    ),
  ).pipe(Schema.maxItems(MAX_CONVERSATION_INPUTS)),
}).annotations(strict);
export type ConversationInputManifest = typeof ConversationInputManifest.Type;
export const decodeConversationInputReference = Schema.decodeUnknownSync(
  ConversationInputReference,
);
export const decodeConversationInputManifest = Schema.decodeUnknownSync(ConversationInputManifest);
