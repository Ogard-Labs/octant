import { Schema } from "effect";
import { MentionableThreadId } from "./threadMentionIdentity";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** The bounded message a Chat provider may deliver to an explicitly mentioned Chat thread. */
export const ThreadDialogueMessageInput = Schema.Struct({
  targetThreadId: MentionableThreadId,
  message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(8_000)),
}).annotations(strict);
export type ThreadDialogueMessageInput = typeof ThreadDialogueMessageInput.Type;

export const ThreadDialogueResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("completed"),
    targetThreadId: MentionableThreadId,
    targetTitle: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(400)),
    response: Schema.String.pipe(Schema.maxLength(8_000)),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("waiting"),
    targetThreadId: MentionableThreadId,
    targetTitle: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(400)),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024)),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused", "failed"),
    targetThreadId: MentionableThreadId,
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024)),
  }).annotations(strict),
).annotations(strict);
export type ThreadDialogueResult = typeof ThreadDialogueResult.Type;

export const decodeThreadDialogueMessageInput = Schema.decodeUnknownSync(
  ThreadDialogueMessageInput,
);
export const decodeThreadDialogueResult = Schema.decodeUnknownSync(ThreadDialogueResult);
