import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { MentionableThreadId } from "./threadMentionIdentity";

/**
 * Chat's blocking ask: one instruction to a Chat thread the turn explicitly
 * mentions, answered with that thread's completed reply. Offered only when the
 * turn mentions a Chat thread; Work and Code threads are reached through their
 * own modes' threads tool, never through this one.
 */
export const THREAD_DIALOGUE_TOOL_NAME = "octant_ask_thread";

/** The bounded message a Chat provider may deliver to an explicitly mentioned Chat thread. */
export const ThreadDialogueMessageInput = Schema.Struct({
  targetThreadId: MentionableThreadId,
  message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(8_000)),
});
export type ThreadDialogueMessageInput = typeof ThreadDialogueMessageInput.Type;

export const ThreadDialogueResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("completed"),
    targetThreadId: MentionableThreadId,
    targetTitle: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(400)),
    response: Schema.String.check(Schema.isMaxLength(8_000)),
  }),
  Schema.Struct({
    status: Schema.Literal("waiting"),
    targetThreadId: MentionableThreadId,
    targetTitle: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(400)),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  }),
  Schema.Struct({
    status: Schema.Literals(["refused", "failed"]),
    targetThreadId: MentionableThreadId,
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  }),
]);
export type ThreadDialogueResult = typeof ThreadDialogueResult.Type;

export const decodeThreadDialogueMessageInput = Schema.decodeUnknownSync(
  ThreadDialogueMessageInput,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadDialogueResult = Schema.decodeUnknownSync(
  ThreadDialogueResult,
  STRICT_DECODE_OPTIONS,
);
