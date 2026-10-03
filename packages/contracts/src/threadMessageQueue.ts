import { Schema } from "effect";
import { SendChatTurnCommand } from "./chat";
import { CodeAttachmentId, MAX_CODE_TURN_ATTACHMENTS } from "./code";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ExtensionSelection } from "./extensions";
import { FileMentionPathInput, MAX_FILE_MENTIONS_PER_TURN } from "./fileMention";
import { OctantMode } from "./modes";
import { ProviderExecutionPolicy } from "./providers";
import { MentionableThreadId, MAX_THREAD_MENTIONS_PER_TURN } from "./threadMentionIdentity";
import { StartWorkThreadTurnCommand } from "./workTurns";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const MAX_THREAD_MESSAGE_QUEUE_ITEMS = 32;
export const MAX_THREAD_MESSAGE_QUEUE_PROMPT_CHARACTERS = 200_000;
export const MAX_THREAD_MESSAGE_QUEUE_ITEM_BYTES = 1024 * 1024;
export const MAX_THREAD_MESSAGE_QUEUE_BYTES = 4 * 1024 * 1024;
export const ThreadQueueMessageId = Schema.UUID.pipe(Schema.brand("ThreadQueueMessageId"));
export type ThreadQueueMessageId = typeof ThreadQueueMessageId.Type;
export const ThreadMessageQueueRequestId = Schema.UUID.pipe(
  Schema.brand("ThreadMessageQueueRequestId"),
);
export type ThreadMessageQueueRequestId = typeof ThreadMessageQueueRequestId.Type;
export const ThreadMessageQueueScope = Schema.Struct({
  mode: OctantMode,
  threadId: MentionableThreadId,
}).annotations(strict);
export type ThreadMessageQueueScope = typeof ThreadMessageQueueScope.Type;
export const ThreadMessageQueuePrompt = Schema.String.pipe(
  Schema.maxLength(MAX_THREAD_MESSAGE_QUEUE_PROMPT_CHARACTERS),
);
const chat = SendChatTurnCommand.fields;
const work = StartWorkThreadTurnCommand.fields;
export const ThreadMessageQueuePayload = Schema.Union(
  Schema.Struct({
    mode: Schema.Literal("chat"),
    prompt: ThreadMessageQueuePrompt,
    attachmentIds: chat.attachmentIds,
    previewSelections: chat.previewSelections,
    canvasSelections: chat.canvasSelections,
    extensionSelections: chat.extensionSelections,
    threadMentionIds: chat.threadMentionIds,
  }).annotations(strict),
  Schema.Struct({
    mode: Schema.Literal("work"),
    prompt: ThreadMessageQueuePrompt,
    attachmentIds: work.attachmentIds,
    extensionSelections: work.extensionSelections,
    computerUseSelection: work.computerUseSelection,
    threadMentionIds: work.threadMentionIds,
    fileMentionPaths: work.fileMentionPaths,
  }).annotations(strict),
  Schema.Struct({
    mode: Schema.Literal("code"),
    prompt: ThreadMessageQueuePrompt,
    attachmentIds: Schema.optional(
      Schema.Array(CodeAttachmentId).pipe(Schema.maxItems(MAX_CODE_TURN_ATTACHMENTS)),
    ),
    extensionSelections: Schema.optional(
      Schema.Array(ExtensionSelection).pipe(Schema.maxItems(32)),
    ),
    computerUseSelection: Schema.optional(ExtensionSelection),
    threadMentionIds: Schema.optional(
      Schema.Array(MentionableThreadId).pipe(Schema.maxItems(MAX_THREAD_MENTIONS_PER_TURN)),
    ),
    fileMentionPaths: Schema.optional(
      Schema.Array(FileMentionPathInput).pipe(Schema.maxItems(MAX_FILE_MENTIONS_PER_TURN)),
    ),
    executionPolicy: Schema.optional(ProviderExecutionPolicy),
  }).annotations(strict),
).pipe(
  Schema.filter(
    (value) =>
      value.prompt.trim().length > 0 ||
      (value.mode === "chat" && (value.attachmentIds?.length ?? 0) > 0),
  ),
  Schema.filter(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      MAX_THREAD_MESSAGE_QUEUE_ITEM_BYTES,
  ),
);
export type ThreadMessageQueuePayload = typeof ThreadMessageQueuePayload.Type;
export const ThreadMessageQueueHoldReason = Schema.Literal(
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
);
export type ThreadMessageQueueHoldReason = typeof ThreadMessageQueueHoldReason.Type;
export const ThreadMessageQueueRefusalReason = Schema.Union(
  ThreadMessageQueueHoldReason,
  Schema.Literal(
    "unauthorized",
    "not-found",
    "not-editable",
    "invalid-order",
    "queue-full",
    "invalid-payload",
    "storage-unavailable",
  ),
);
export type ThreadMessageQueueRefusalReason = typeof ThreadMessageQueueRefusalReason.Type;
export const ThreadMessageQueueItem = Schema.Struct({
  messageId: ThreadQueueMessageId,
  status: Schema.Literal("queued", "dispatching", "accepted"),
  revision: AggregateVersion,
  createdAt: UtcTimestamp,
  /** Missing private content is explicit; metadata cannot recreate it. */
  payload: Schema.optional(ThreadMessageQueuePayload),
}).annotations(strict);
export type ThreadMessageQueueItem = typeof ThreadMessageQueueItem.Type;
export const ThreadMessageQueueSnapshot = Schema.Struct({
  scope: ThreadMessageQueueScope,
  version: AggregateVersion,
  paused: Schema.Boolean,
  holdReason: Schema.optional(ThreadMessageQueueHoldReason),
  items: Schema.Array(ThreadMessageQueueItem).pipe(Schema.maxItems(MAX_THREAD_MESSAGE_QUEUE_ITEMS)),
}).annotations(strict);
export type ThreadMessageQueueSnapshot = typeof ThreadMessageQueueSnapshot.Type;
const command = {
  scope: ThreadMessageQueueScope,
  requestId: ThreadMessageQueueRequestId,
  expectedVersion: AggregateVersion,
};
export const ThreadMessageQueueCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("enqueue"),
    ...command,
    messageId: ThreadQueueMessageId,
    payload: ThreadMessageQueuePayload,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("edit"),
    ...command,
    messageId: ThreadQueueMessageId,
    prompt: ThreadMessageQueuePrompt,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("reorder"),
    ...command,
    messageIds: Schema.Array(ThreadQueueMessageId).pipe(
      Schema.maxItems(MAX_THREAD_MESSAGE_QUEUE_ITEMS),
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remove"),
    ...command,
    messageId: ThreadQueueMessageId,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("pause", "resume"), ...command }).annotations(strict),
).pipe(
  Schema.filter((value) => value.kind !== "enqueue" || value.scope.mode === value.payload.mode),
);
export type ThreadMessageQueueCommand = typeof ThreadMessageQueueCommand.Type;
export const ThreadMessageQueueResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("applied", "duplicate", "conflict"),
    requestId: ThreadMessageQueueRequestId,
    snapshot: ThreadMessageQueueSnapshot,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    requestId: ThreadMessageQueueRequestId,
    reason: ThreadMessageQueueRefusalReason,
  }).annotations(strict),
);
export type ThreadMessageQueueResult = typeof ThreadMessageQueueResult.Type;
export const ThreadMessageQueueReadResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("ready"),
    snapshot: ThreadMessageQueueSnapshot,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: ThreadMessageQueueRefusalReason,
  }).annotations(strict),
);
export type ThreadMessageQueueReadResult = typeof ThreadMessageQueueReadResult.Type;
export const decodeThreadQueueMessageId = Schema.decodeUnknownSync(ThreadQueueMessageId);
export const decodeThreadMessageQueueScope = Schema.decodeUnknownSync(ThreadMessageQueueScope);
export const decodeThreadMessageQueuePayload = Schema.decodeUnknownSync(ThreadMessageQueuePayload);
export const decodeThreadMessageQueueCommand = Schema.decodeUnknownSync(ThreadMessageQueueCommand);
export const decodeThreadMessageQueueSnapshot = Schema.decodeUnknownSync(
  ThreadMessageQueueSnapshot,
);
export const decodeThreadMessageQueueResult = Schema.decodeUnknownSync(ThreadMessageQueueResult);
export const decodeThreadMessageQueueReadResult = Schema.decodeUnknownSync(
  ThreadMessageQueueReadResult,
);
