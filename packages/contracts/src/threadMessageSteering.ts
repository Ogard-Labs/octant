import { Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import { MentionableThreadId } from "./threadMentionIdentity";
import { TrackerMentions } from "./trackerMention";

/** As long as a queued message's prompt may be, so a steered one is shown whole. */
export const MAX_THREAD_MESSAGE_STEERED_BODY_CHARACTERS = 200_000;
/** One running turn lists this many of the person's steered messages, then no more. */
export const MAX_THREAD_MESSAGES_STEERED_PER_TURN = 32;

/**
 * A message the person sent into a Work or Code thread while its turn ran,
 * which the runtime took into that turn rather than a turn of its own
 * (maintainer decision, 2026-11-21). The turn carries it so the transcript
 * shows what the person said, and when, inside the turn that heard it.
 * `messageId` is the queue message it was sent as.
 */
export const ThreadMessageSteeredIntoTurn = Schema.Struct({
  messageId: GuidString,
  body: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_THREAD_MESSAGE_STEERED_BODY_CHARACTERS),
  ),
  steeredAt: UtcTimestamp,
  /** The pull requests and issues the message mentioned; absent when it mentioned none. */
  trackerMentions: Schema.optional(TrackerMentions),
});
export type ThreadMessageSteeredIntoTurn = typeof ThreadMessageSteeredIntoTurn.Type;

export const ThreadMessagesSteeredIntoTurn = Schema.Array(ThreadMessageSteeredIntoTurn).check(
  Schema.isMaxLength(MAX_THREAD_MESSAGES_STEERED_PER_TURN),
);

/**
 * The journaled record of one steered message: the thread, the turn it
 * entered (a Work request id or a Code operation id), and what the person
 * wrote. Each mode's transcript read attaches it to the named turn.
 */
export const ThreadMessageSteered = Schema.Struct({
  kind: Schema.Literal("thread-message-steered"),
  mode: Schema.Literals(["work", "code"]),
  threadId: MentionableThreadId,
  turnKey: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  ...ThreadMessageSteeredIntoTurn.fields,
});
export type ThreadMessageSteered = typeof ThreadMessageSteered.Type;
export const decodeThreadMessageSteered = Schema.decodeUnknownSync(
  ThreadMessageSteered,
  STRICT_DECODE_OPTIONS,
);
