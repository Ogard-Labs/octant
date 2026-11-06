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
/** Selected text can cover 24 messages, each carrying up to 16 Chat inputs. */
export const MAX_CONVERSATION_INPUT_SELECTIONS = 384;
export const MAX_CONVERSATION_INPUT_BYTES = 32 * 1024 * 1024;

export const ConversationInputReference = Schema.Struct({
  source: Schema.Struct({
    mode: Schema.Literal("chat", "work", "code"),
    threadId: Schema.UUID,
    attachmentId: Schema.UUID,
    projectId: Schema.optional(Schema.NullOr(Schema.UUID)),
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
  omittedUnlistedInputs: Schema.optional(
    Schema.Int.pipe(Schema.between(1, MAX_CONVERSATION_INPUT_SELECTIONS)),
  ),
  sourceMetadataUnavailable: Schema.optional(Schema.Literal(true)),
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
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (manifest) =>
        manifest.items.length + (manifest.omittedUnlistedInputs ?? 0) <=
          MAX_CONVERSATION_INPUT_SELECTIONS &&
        ((manifest.omittedUnlistedInputs === undefined &&
          manifest.sourceMetadataUnavailable === undefined) ||
          manifest.items.every((item) => item.status === "omitted")),
    ),
  );
export type ConversationInputManifest = typeof ConversationInputManifest.Type;
export const decodeConversationInputReference = Schema.decodeUnknownSync(
  ConversationInputReference,
);
export const decodeConversationInputManifest = Schema.decodeUnknownSync(ConversationInputManifest);

/** Journal-safe reference; the manifest itself stays in the destination's purgeable scope. */
export const ConversationInputReceipt = Schema.Struct({
  snapshotId: Schema.UUID,
  purpose: ConversationInputPurpose,
  policy: ConversationInputPolicy,
  byteLength: Schema.Int.pipe(Schema.between(1, 131072)),
  digest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  included: Schema.Int.pipe(Schema.between(0, MAX_CONVERSATION_INPUTS)),
  omitted: Schema.Int.pipe(Schema.between(0, MAX_CONVERSATION_INPUT_SELECTIONS)),
  sourceMetadataUnavailable: Schema.optional(Schema.Literal(true)),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (receipt) =>
        (receipt.included + receipt.omitted > 0 || receipt.sourceMetadataUnavailable === true) &&
        receipt.included + receipt.omitted <= MAX_CONVERSATION_INPUT_SELECTIONS,
    ),
  );
export type ConversationInputReceipt = typeof ConversationInputReceipt.Type;
export const decodeConversationInputReceipt = Schema.decodeUnknownSync(ConversationInputReceipt);

export const ConversationInputQuery = Schema.Struct({
  mode: Schema.Literal("chat", "work", "code"),
  threadId: Schema.UUID,
  admissionId: Schema.UUID,
  snapshotId: Schema.UUID,
}).annotations(strict);
export type ConversationInputQuery = typeof ConversationInputQuery.Type;
export const decodeConversationInputQuery = Schema.decodeUnknownSync(ConversationInputQuery);
export const ConversationInputReading = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("available"),
    manifest: ConversationInputManifest,
  }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("unavailable") }).annotations(strict),
);
export type ConversationInputReading = typeof ConversationInputReading.Type;
export const decodeConversationInputReading = Schema.decodeUnknownSync(ConversationInputReading);
