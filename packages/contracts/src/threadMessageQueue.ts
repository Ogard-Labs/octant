import { ConversationInputPolicy } from "./conversationInputs";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeReviewFindingReferences } from "./codeOperations";
import { SideChatDraftReturnReferences } from "./sideChatReturn";
import { Schema } from "effect";
import { SendChatTurnCommand } from "./chat";
import { CodeAttachmentId, MAX_CODE_TURN_ATTACHMENTS } from "./code";
import { ComputerUseDestinationSelection } from "./desktopLease";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ExtensionSelection } from "./extensions";
import { FileMentionPathInput, MAX_FILE_MENTIONS_PER_TURN } from "./fileMention";
import { OctantMode } from "./modes";
import { ProviderExecutionPolicy } from "./providers";
import { MentionableThreadId, MAX_THREAD_MENTIONS_PER_TURN } from "./threadMentionIdentity";
import { StartWorkThreadTurnCommand } from "./workTurns";

export const MAX_THREAD_MESSAGE_QUEUE_ITEMS = 32;
export const MAX_THREAD_MESSAGE_QUEUE_PROMPT_CHARACTERS = 200_000;
export const MAX_THREAD_MESSAGE_QUEUE_ITEM_BYTES = 1024 * 1024;
export const MAX_THREAD_MESSAGE_QUEUE_BYTES = 4 * 1024 * 1024;
export const ThreadQueueMessageId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("ThreadQueueMessageId"),
);
export type ThreadQueueMessageId = typeof ThreadQueueMessageId.Type;
export const ThreadMessageQueueRequestId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("ThreadMessageQueueRequestId"),
);
export type ThreadMessageQueueRequestId = typeof ThreadMessageQueueRequestId.Type;
export const ThreadMessageQueueScope = Schema.Struct({
  mode: OctantMode,
  threadId: MentionableThreadId,
});
export type ThreadMessageQueueScope = typeof ThreadMessageQueueScope.Type;
export const ThreadMessageQueuePrompt = Schema.String.check(
  Schema.isMaxLength(MAX_THREAD_MESSAGE_QUEUE_PROMPT_CHARACTERS),
);
const chat = SendChatTurnCommand.fields;
const work = StartWorkThreadTurnCommand.fields;
export const ThreadMessageQueuePayload = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("chat"),
    contextInputPolicy: chat.contextInputPolicy,
    prompt: ThreadMessageQueuePrompt,
    typedByPerson: Schema.optional(Schema.Literal(true)),
    attachmentIds: chat.attachmentIds,
    previewSelections: chat.previewSelections,
    canvasSelections: chat.canvasSelections,
    extensionSelections: chat.extensionSelections,
    threadMentionIds: chat.threadMentionIds,
    sideChatReturns: chat.sideChatReturns,
  }),
  Schema.Struct({
    mode: Schema.Literal("work"),
    contextInputPolicy: work.contextInputPolicy,
    prompt: ThreadMessageQueuePrompt,
    typedByPerson: Schema.optional(Schema.Literal(true)),
    attachmentIds: work.attachmentIds,
    extensionSelections: work.extensionSelections,
    computerUseSelection: work.computerUseSelection,
    threadMentionIds: work.threadMentionIds,
    sideChatReturns: work.sideChatReturns,
    fileMentionPaths: work.fileMentionPaths,
  }),
  Schema.Struct({
    mode: Schema.Literal("code"),
    contextInputPolicy: Schema.optional(ConversationInputPolicy),
    reviewFindingReferences: Schema.optional(CodeReviewFindingReferences),
    sideChatReturns: Schema.optional(SideChatDraftReturnReferences),
    prompt: ThreadMessageQueuePrompt,
    typedByPerson: Schema.optional(Schema.Literal(true)),
    attachmentIds: Schema.optional(
      Schema.Array(CodeAttachmentId).check(Schema.isMaxLength(MAX_CODE_TURN_ATTACHMENTS)),
    ),
    extensionSelections: Schema.optional(
      Schema.Array(ExtensionSelection).check(Schema.isMaxLength(32)),
    ),
    computerUseSelection: Schema.optional(ExtensionSelection),
    computerUseDestination: Schema.optional(ComputerUseDestinationSelection),
    threadMentionIds: Schema.optional(
      Schema.Array(MentionableThreadId).check(Schema.isMaxLength(MAX_THREAD_MENTIONS_PER_TURN)),
    ),
    fileMentionPaths: Schema.optional(
      Schema.Array(FileMentionPathInput).check(Schema.isMaxLength(MAX_FILE_MENTIONS_PER_TURN)),
    ),
    executionPolicy: Schema.optional(ProviderExecutionPolicy),
  }),
]).check(
  Schema.makeFilter(
    (value) =>
      value.prompt.trim().length > 0 ||
      (value.mode === "chat" && (value.attachmentIds?.length ?? 0) > 0),
  ),
  Schema.makeFilter(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      MAX_THREAD_MESSAGE_QUEUE_ITEM_BYTES,
  ),
);
export type ThreadMessageQueuePayload = typeof ThreadMessageQueuePayload.Type;
export const ThreadMessageQueueHoldReason = Schema.Literals([
  "paused",
  "host-restart",
  "delivery-unknown",
  "binding-changed",
  "authority-revoked",
  "cancelled",
  "failed",
  "thread-unavailable",
  "content-unavailable",
  "admission-refused",
]);
export type ThreadMessageQueueHoldReason = typeof ThreadMessageQueueHoldReason.Type;
export const ThreadMessageQueueRefusalReason = Schema.Union([
  ThreadMessageQueueHoldReason,
  Schema.Literals([
    "unauthorized",
    "not-found",
    "not-editable",
    "invalid-order",
    "queue-full",
    "invalid-payload",
    "storage-unavailable",
  ]),
]);
export type ThreadMessageQueueRefusalReason = typeof ThreadMessageQueueRefusalReason.Type;
export const ThreadMessageQueueItem = Schema.Struct({
  messageId: ThreadQueueMessageId,
  status: Schema.Literals(["queued", "dispatching", "accepted"]),
  revision: AggregateVersion,
  createdAt: UtcTimestamp,
  /** Missing private content is explicit; metadata cannot recreate it. */
  payload: Schema.optional(ThreadMessageQueuePayload),
  /**
   * The message is offered to the thread's running turn and its runtime has
   * not answered yet, so it cannot be edited, removed or moved until it either
   * leaves the queue or waits again. Host memory only; never journaled.
   */
  steering: Schema.optional(Schema.Literal(true)),
  /**
   * The person chose Queue for this message: it is never offered to the turn
   * that is running and waits for the next one, until they choose Send now.
   */
  waitsForNextTurn: Schema.optional(Schema.Literal(true)),
});
export type ThreadMessageQueueItem = typeof ThreadMessageQueueItem.Type;
export const ThreadMessageQueueSnapshot = Schema.Struct({
  scope: ThreadMessageQueueScope,
  version: AggregateVersion,
  paused: Schema.Boolean,
  holdReason: Schema.optional(ThreadMessageQueueHoldReason),
  items: Schema.Array(ThreadMessageQueueItem).check(
    Schema.isMaxLength(MAX_THREAD_MESSAGE_QUEUE_ITEMS),
  ),
});
export type ThreadMessageQueueSnapshot = typeof ThreadMessageQueueSnapshot.Type;
const command = {
  scope: ThreadMessageQueueScope,
  requestId: ThreadMessageQueueRequestId,
  expectedVersion: AggregateVersion,
};
export const ThreadMessageQueueCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("enqueue"),
    ...command,
    messageId: ThreadQueueMessageId,
    payload: ThreadMessageQueuePayload,
    /** Absent: steer where the running turn's runtime steers. */
    timing: Schema.optional(Schema.Literal("next-turn")),
  }),
  Schema.Struct({
    kind: Schema.Literal("edit"),
    ...command,
    messageId: ThreadQueueMessageId,
    prompt: ThreadMessageQueuePrompt,
    typedByPerson: Schema.optional(Schema.Literal(true)),
  }),
  Schema.Struct({
    kind: Schema.Literal("reorder"),
    ...command,
    messageIds: Schema.Array(ThreadQueueMessageId).check(
      Schema.isMaxLength(MAX_THREAD_MESSAGE_QUEUE_ITEMS),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("remove"),
    ...command,
    messageId: ThreadQueueMessageId,
  }),
  Schema.Struct({
    kind: Schema.Literal("send-now"),
    ...command,
    messageId: ThreadQueueMessageId,
  }),
  Schema.Struct({ kind: Schema.Literals(["pause", "resume"]), ...command }),
]).check(
  Schema.makeFilter((value) => value.kind !== "enqueue" || value.scope.mode === value.payload.mode),
);
export type ThreadMessageQueueCommand = typeof ThreadMessageQueueCommand.Type;
export const ThreadMessageQueueResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literals(["applied", "duplicate", "conflict"]),
    requestId: ThreadMessageQueueRequestId,
    snapshot: ThreadMessageQueueSnapshot,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    requestId: ThreadMessageQueueRequestId,
    reason: ThreadMessageQueueRefusalReason,
    /** What the host tells the person when the reason alone would not: the thread's worktree was cleaned up. */
    message: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512))),
  }),
]);
export type ThreadMessageQueueResult = typeof ThreadMessageQueueResult.Type;
export const ThreadMessageQueueReadResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    snapshot: ThreadMessageQueueSnapshot,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: ThreadMessageQueueRefusalReason,
  }),
]);
export type ThreadMessageQueueReadResult = typeof ThreadMessageQueueReadResult.Type;
export const decodeThreadQueueMessageId = Schema.decodeUnknownSync(
  ThreadQueueMessageId,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadMessageQueueScope = Schema.decodeUnknownSync(
  ThreadMessageQueueScope,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadMessageQueuePayload = Schema.decodeUnknownSync(
  ThreadMessageQueuePayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadMessageQueueCommand = Schema.decodeUnknownSync(
  ThreadMessageQueueCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadMessageQueueSnapshot = Schema.decodeUnknownSync(
  ThreadMessageQueueSnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadMessageQueueResult = Schema.decodeUnknownSync(
  ThreadMessageQueueResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadMessageQueueReadResult = Schema.decodeUnknownSync(
  ThreadMessageQueueReadResult,
  STRICT_DECODE_OPTIONS,
);
