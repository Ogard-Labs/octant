import { Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";

export const ConversationInputPurpose = Schema.Literals([
  "child-delegation",
  "provider-switch",
  "rewind",
  "fork",
  "branch",
  "fork-merge-back",
]);
export type ConversationInputPurpose = typeof ConversationInputPurpose.Type;
export const ConversationInputPolicy = Schema.Literals(["preserve", "text-only"]);
export type ConversationInputPolicy = typeof ConversationInputPolicy.Type;
export const MAX_CONVERSATION_INPUTS = 8;
/** Selected text can cover 24 messages, each carrying up to 16 Chat inputs. */
export const MAX_CONVERSATION_INPUT_SELECTIONS = 384;
export const MAX_CONVERSATION_INPUT_BYTES = 32 * 1024 * 1024;

export const ConversationInputReference = Schema.Struct({
  source: Schema.Struct({
    mode: Schema.Literals(["chat", "work", "code"]),
    threadId: GuidString,
    attachmentId: GuidString,
    projectId: Schema.optional(Schema.NullOr(GuidString)),
  }),
  displayName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  mediaType: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  byteLength: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 26_214_400 })),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type ConversationInputReference = typeof ConversationInputReference.Type;
export const ConversationInputOmissionReason = Schema.Literals([
  "person-excluded",
  "unsupported",
  "missing",
  "changed",
  "source-unavailable",
  "too-many",
  "too-large",
]);
export type ConversationInputOmissionReason = typeof ConversationInputOmissionReason.Type;
export const ConversationInputManifest = Schema.Struct({
  version: Schema.Literal(1),
  purpose: ConversationInputPurpose,
  omittedUnlistedInputs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CONVERSATION_INPUT_SELECTIONS })),
  ),
  sourceMetadataUnavailable: Schema.optional(Schema.Literal(true)),
  items: Schema.Array(
    Schema.Union([
      Schema.Struct({
        status: Schema.Literal("included"),
        input: ConversationInputReference,
      }),
      Schema.Struct({
        status: Schema.Literal("omitted"),
        input: ConversationInputReference,
        reason: ConversationInputOmissionReason,
      }),
    ]),
  ).check(Schema.isMaxLength(MAX_CONVERSATION_INPUTS)),
}).check(
  Schema.makeFilter(
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
  STRICT_DECODE_OPTIONS,
);
export const decodeConversationInputManifest = Schema.decodeUnknownSync(
  ConversationInputManifest,
  STRICT_DECODE_OPTIONS,
);

/** Journal-safe reference; the manifest itself stays in the destination's purgeable scope. */
export const ConversationInputReceipt = Schema.Struct({
  snapshotId: GuidString,
  purpose: ConversationInputPurpose,
  policy: ConversationInputPolicy,
  byteLength: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 131072 })),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  included: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_CONVERSATION_INPUTS })),
  omitted: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_CONVERSATION_INPUT_SELECTIONS }),
  ),
  sourceMetadataUnavailable: Schema.optional(Schema.Literal(true)),
}).check(
  Schema.makeFilter(
    (receipt) =>
      (receipt.included + receipt.omitted > 0 || receipt.sourceMetadataUnavailable === true) &&
      receipt.included + receipt.omitted <= MAX_CONVERSATION_INPUT_SELECTIONS,
  ),
);
export type ConversationInputReceipt = typeof ConversationInputReceipt.Type;
export const decodeConversationInputReceipt = Schema.decodeUnknownSync(
  ConversationInputReceipt,
  STRICT_DECODE_OPTIONS,
);

export const ConversationInputQuery = Schema.Struct({
  mode: Schema.Literals(["chat", "work", "code"]),
  threadId: GuidString,
  admissionId: GuidString,
  snapshotId: GuidString,
});
export type ConversationInputQuery = typeof ConversationInputQuery.Type;
export const decodeConversationInputQuery = Schema.decodeUnknownSync(
  ConversationInputQuery,
  STRICT_DECODE_OPTIONS,
);
export const ConversationInputReading = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    manifest: ConversationInputManifest,
  }),
  Schema.Struct({ status: Schema.Literal("unavailable") }),
]);
export type ConversationInputReading = typeof ConversationInputReading.Type;
export const decodeConversationInputReading = Schema.decodeUnknownSync(
  ConversationInputReading,
  STRICT_DECODE_OPTIONS,
);
