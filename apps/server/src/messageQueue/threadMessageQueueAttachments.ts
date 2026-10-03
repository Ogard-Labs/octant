import {
  ChatAttachmentId,
  ChatThreadId,
  CodeAttachmentReference,
  CodeThreadId,
  MAX_CHAT_TURN_ATTACHMENTS,
  MAX_CODE_TURN_ATTACHMENTS,
  MAX_WORK_TURN_ATTACHMENTS,
  ThreadQueueMessageId,
  UtcTimestamp,
  WorkAttachmentReference,
  WorkThreadId,
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeWorkThreadId,
  type ChatAttachment,
} from "@octant/contracts";
import { Schema } from "effect";
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_DISPLAY_NAME_LENGTH,
  type ChatAttachmentStore,
} from "../chat/chatAttachmentStore";
import type { CodeAttachmentStore } from "../code/codeAttachmentStore";
import type { WorkAttachmentStore } from "../work/workAttachmentStore";
import type {
  ManagedAttachmentQueueResult,
  QueuedAttachmentRelease,
} from "../attachments/managedAttachmentStore";
import {
  MAX_THREAD_MESSAGE_QUEUE_PRIVATE_CONTEXT_BYTES,
  type ThreadMessageQueueModePort,
  type ThreadMessageQueueResource,
} from "./threadMessageQueuePort";

const chatReference = Schema.Struct({
  chatThreadId: ChatThreadId,
  chatAttachmentId: ChatAttachmentId,
  displayName: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(MAX_CHAT_ATTACHMENT_DISPLAY_NAME_LENGTH),
  ),
  size: Schema.Int.pipe(Schema.greaterThan(0), Schema.lessThanOrEqualTo(MAX_CHAT_ATTACHMENT_BYTES)),
  hash: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  finalizedAt: UtcTimestamp,
});
const privateContext = Schema.Union(
  Schema.Struct({
    mode: Schema.Literal("chat"),
    threadId: ChatThreadId,
    messageId: ThreadQueueMessageId,
    attachments: Schema.Array(chatReference).pipe(Schema.maxItems(MAX_CHAT_TURN_ATTACHMENTS)),
  }),
  Schema.Struct({
    mode: Schema.Literal("code"),
    threadId: CodeThreadId,
    messageId: ThreadQueueMessageId,
    attachments: Schema.Array(CodeAttachmentReference).pipe(
      Schema.maxItems(MAX_CODE_TURN_ATTACHMENTS),
    ),
  }),
  Schema.Struct({
    mode: Schema.Literal("work"),
    threadId: WorkThreadId,
    messageId: ThreadQueueMessageId,
    attachments: Schema.Array(WorkAttachmentReference).pipe(
      Schema.maxItems(MAX_WORK_TURN_ATTACHMENTS),
    ),
  }),
);
type PrivateContext = typeof privateContext.Type;
const decodePrivateContext = Schema.decodeUnknownSync(privateContext, {
  onExcessProperty: "error",
});

export interface ThreadMessageQueueAttachmentOptions {
  readonly chatStore: ChatAttachmentStore;
  readonly codeStore: CodeAttachmentStore;
  readonly workStore: WorkAttachmentStore;
  readonly readChatAttachment: (
    threadId: typeof ChatThreadId.Type,
    attachmentId: typeof ChatAttachmentId.Type,
  ) => ChatAttachment | undefined;
  readonly isTurnOwned: (
    mode: ThreadMessageQueueResource["scope"]["mode"],
    threadId: ThreadMessageQueueResource["scope"]["threadId"],
    attachmentId: string,
  ) => boolean;
}

export interface ThreadMessageQueueAttachments extends Pick<
  ThreadMessageQueueModePort,
  "retain" | "commit" | "release"
> {
  readonly prepare: (input: ThreadMessageQueueResource) => Promise<boolean>;
}

function matches(input: ThreadMessageQueueResource, context: PrivateContext): boolean {
  if (
    input.scope.mode !== input.payload.mode ||
    context.mode !== input.scope.mode ||
    String(context.threadId) !== String(input.scope.threadId) ||
    String(context.messageId) !== String(input.messageId)
  )
    return false;
  const ids =
    context.mode === "chat"
      ? context.attachments.map((ref) => String(ref.chatAttachmentId))
      : context.attachments.map((ref) => String(ref.attachmentId));
  const expected = input.payload.attachmentIds?.map(String) ?? [];
  return (
    new Set(ids).size === ids.length &&
    ids.length === expected.length &&
    ids.every((id, index) => id === expected[index]) &&
    (context.mode !== "chat" ||
      context.attachments.every((ref) => String(ref.chatThreadId) === String(context.threadId)))
  );
}

function parse(input: ThreadMessageQueueResource): PrivateContext | undefined {
  if (
    input.privateContextJson === undefined ||
    new TextEncoder().encode(input.privateContextJson).byteLength >
      MAX_THREAD_MESSAGE_QUEUE_PRIVATE_CONTEXT_BYTES
  )
    return undefined;
  try {
    const context = decodePrivateContext(JSON.parse(input.privateContextJson));
    return matches(input, context) ? context : undefined;
  } catch {
    return undefined;
  }
}

/** Attachment ownership is host-local; the queue persists only these trusted references. */
export function createThreadMessageQueueAttachments(
  options: ThreadMessageQueueAttachmentOptions,
): ThreadMessageQueueAttachments {
  function capture(input: ThreadMessageQueueResource): PrivateContext | undefined {
    const messageId = input.messageId;
    switch (input.payload.mode) {
      case "chat": {
        const threadId = decodeChatThreadId(input.scope.threadId);
        const attachments: Array<typeof chatReference.Type> = [];
        for (const id of input.payload.attachmentIds ?? []) {
          const ref = options.readChatAttachment(threadId, id);
          if (
            ref === undefined ||
            ref.status !== "finalized" ||
            String(ref.threadId) !== String(threadId) ||
            String(ref.id) !== String(id)
          )
            return undefined;
          attachments.push({
            chatThreadId: threadId,
            chatAttachmentId: id,
            displayName: ref.displayName,
            size: ref.byteLength,
            hash: ref.digest,
            finalizedAt: ref.createdAt,
          });
        }
        return { mode: "chat", threadId, messageId, attachments };
      }
      case "code": {
        const threadId = decodeCodeThreadId(input.scope.threadId);
        const found = options.codeStore.peek(threadId, input.payload.attachmentIds ?? []);
        return found.status === "ok"
          ? { mode: "code", threadId, messageId, attachments: found.attachments }
          : undefined;
      }
      case "work": {
        const threadId = decodeWorkThreadId(input.scope.threadId);
        const found = options.workStore.peek(threadId, input.payload.attachmentIds ?? []);
        return found.status === "ok"
          ? { mode: "work", threadId, messageId, attachments: found.attachments }
          : undefined;
      }
    }
  }

  function pin(
    context: PrivateContext,
    reason: "enqueue" | "restore",
  ): ManagedAttachmentQueueResult {
    const owner = String(context.messageId);
    switch (context.mode) {
      case "chat":
        return reason === "enqueue"
          ? options.chatStore.claimQueued(context.threadId, owner, context.attachments)
          : options.chatStore.restoreQueuedOwnership(context.threadId, owner, context.attachments);
      case "code":
        return reason === "enqueue"
          ? options.codeStore.claimQueued(
              context.threadId,
              owner,
              context.attachments.map((ref) => ref.attachmentId),
            )
          : options.codeStore.restoreQueuedOwnership(context.threadId, owner, context.attachments);
      case "work":
        return reason === "enqueue"
          ? options.workStore.claimQueued(
              context.threadId,
              owner,
              context.attachments.map((ref) => ref.attachmentId),
            )
          : options.workStore.restoreQueuedOwnership(context.threadId, owner, context.attachments);
    }
  }

  const retain: ThreadMessageQueueModePort["retain"] = (input) => {
    if (input.scope.mode !== input.payload.mode)
      return { status: "refused", reason: "invalid-payload" };
    // Validate and bound everything before pinning: a refused synchronous retain owns nothing.
    const context = input.reason === "restore" ? parse(input) : capture(input);
    if (context === undefined) return { status: "refused", reason: "content-unavailable" };
    const privateContextJson = JSON.stringify(context);
    if (parse({ ...input, privateContextJson }) === undefined)
      return { status: "refused", reason: "content-unavailable" };
    const result = pin(context, input.reason);
    return result.status === "ok"
      ? { status: "retained", privateContextJson }
      : { status: "refused", reason: "content-unavailable" };
  };

  const commit: ThreadMessageQueueModePort["commit"] = (input) => {
    const context = parse(input);
    if (context === undefined)
      throw new Error("A committed queue message must have retained attachment metadata.");
    const result =
      context.mode === "code"
        ? options.codeStore.commitQueued(context.threadId, String(input.messageId))
        : context.mode === "work"
          ? options.workStore.commitQueued(context.threadId, String(input.messageId))
          : { status: "ok" };
    if (result.status !== "ok")
      throw new Error("A committed queue message must retain its attachment ownership.");
  };

  const release: ThreadMessageQueueModePort["release"] = async (input) => {
    const context = parse(input);
    if (context === undefined) return { status: "refused" };
    const disposition: QueuedAttachmentRelease<string> =
      input.reason === "accepted"
        ? { disposition: "turn" }
        : input.reason === "rollback"
          ? { disposition: "draft" }
          : {
              disposition: "removed",
              isTurnOwned: (id) => options.isTurnOwned(context.mode, input.scope.threadId, id),
            };
    const owner = String(input.messageId);
    const result =
      context.mode === "chat"
        ? await options.chatStore.releaseQueued(context.threadId, owner, disposition)
        : context.mode === "code"
          ? await options.codeStore.releaseQueued(context.threadId, owner, disposition)
          : await options.workStore.releaseQueued(context.threadId, owner, disposition);
    return result.status === "ok" ? { status: "released" } : { status: "refused" };
  };

  return {
    retain,
    commit,
    release,
    prepare: async (input) => {
      const context = parse(input);
      if (context === undefined) return false;
      const owner = String(input.messageId);
      const result =
        context.mode === "chat"
          ? await options.chatStore.prepareQueued(context.threadId, owner)
          : context.mode === "code"
            ? await options.codeStore.prepareQueued(context.threadId, owner)
            : await options.workStore.prepareQueued(context.threadId, owner);
      return result.status === "ok";
    },
  };
}
