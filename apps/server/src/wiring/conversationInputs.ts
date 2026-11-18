import { ConversationInputTransfer } from "../attachments/conversationInputTransfer";
import type { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
import { decodeProviderInstanceId, isAcpAgentKind } from "@octant/contracts";
import {
  decodeChatAttachmentId,
  decodeChatThreadId,
  decodeCodeAttachmentId,
  decodeCodeThreadId,
  decodeWorkAttachmentId,
  decodeWorkThreadId,
  type ProviderObservedState,
} from "@octant/contracts";
import type { ConversationInputReference } from "@octant/contracts/conversation-inputs";
import { attachmentMediaTypeToModality } from "@octant/provider-sdk/chat-conformance";
import { ChatAttachmentStore } from "../chat/chatAttachmentStore";
import { readChatThreadView } from "../chat/chatService";
import { CodeAttachmentStore } from "../code/codeAttachmentStore";
import type { PersistenceService } from "../persistence/persistenceService";
import { WorkAttachmentStore } from "../work/workAttachmentStore";
import type { WorkThreadProjection } from "../work/workThreadProjection";

export function supportsConversationInput(
  observed: ProviderObservedState | undefined,
  modelId: string,
  mediaType: string,
): boolean {
  if (observed?.capabilities.nativeAttachments !== "supported") return false;
  const modality = attachmentMediaTypeToModality(mediaType);
  return (
    modality !== undefined &&
    observed.models.some(
      (model) => String(model.id) === modelId && model.inputModalities.includes(modality),
    )
  );
}

/**
 * Whether a Work or Code turn sends an attached file that is not an image as
 * it is, rather than naming its path in the thread's attachments folder.
 * OpenCode hands a file part to its model, so a PDF goes natively where the
 * thread's model reads documents. An ACP agent that advertised embedded
 * context takes a document (text, PDF, office file) as an embedded `resource`
 * block, which its models list as reading documents. The Claude Code, Codex
 * and Pi adapters send images alone, so every other file of theirs is named
 * by path, as is any file a document reader is not handed (an archive, a
 * binary).
 */
export function providerTakesFileNatively(
  driverKind: string | undefined,
  observed: ProviderObservedState | undefined,
  modelId: string,
  mediaType: string,
): boolean {
  if (driverKind === "opencode")
    return (
      mediaType === "application/pdf" && supportsConversationInput(observed, modelId, mediaType)
    );
  return (
    driverKind !== undefined &&
    isAcpAgentKind(driverKind) &&
    supportsConversationInput(observed, modelId, mediaType)
  );
}

/** Reads only a reference previously selected by the authorized conversation reader. */
export function conversationInputSource(
  persistence: PersistenceService,
  workThreads: WorkThreadProjection,
) {
  const chat = new ChatAttachmentStore(persistence.dataDirectory);
  const work = new WorkAttachmentStore(persistence.dataDirectory);
  const code = new CodeAttachmentStore(persistence.dataDirectory);
  const ownerCurrent = (source: {
    readonly mode: "chat" | "work" | "code";
    readonly threadId: string;
    readonly projectId?: string | null | undefined;
  }): boolean => {
    const thread =
      source.mode === "chat"
        ? persistence.readChatThread(decodeChatThreadId(source.threadId))
        : source.mode === "work"
          ? workThreads.read(decodeWorkThreadId(source.threadId))
          : persistence.readCodeThread(decodeCodeThreadId(source.threadId));
    return (
      thread !== undefined &&
      thread.lifecycle !== "deleting" &&
      thread.lifecycle !== "deleted" &&
      (source.projectId === undefined ||
        (source.projectId === null
          ? thread.projectId === undefined
          : String(thread.projectId) === source.projectId))
    );
  };
  const current = (reference: ConversationInputReference) => ownerCurrent(reference.source);
  // A Chat source's attachment must still be the finalized one the reference recorded.
  const chatAttachmentOf = (reference: ConversationInputReference) =>
    readChatThreadView(
      persistence,
      decodeChatThreadId(reference.source.threadId),
    )?.attachments.find(
      (item) =>
        String(item.id) === reference.source.attachmentId &&
        item.status === "finalized" &&
        item.digest === reference.digest &&
        item.byteLength === reference.byteLength &&
        item.mediaType === reference.mediaType,
    );
  return {
    current,
    ownerCurrent,
    /**
     * The recorded size of a reference `read` would not refuse by its scope or
     * its records, without reading the bytes. A file changed under the same
     * record is found only by `read`, which checks the digest.
     */
    size: (reference: ConversationInputReference): number | undefined => {
      if (!current(reference)) return undefined;
      if (reference.source.mode === "chat" && chatAttachmentOf(reference) === undefined) {
        return undefined;
      }
      return reference.byteLength;
    },
    read: async (reference: ConversationInputReference): Promise<Uint8Array | undefined> => {
      if (!current(reference)) return undefined;
      const source = reference.source;
      if (source.mode === "chat") {
        const threadId = decodeChatThreadId(source.threadId);
        const attachment = chatAttachmentOf(reference);
        if (attachment === undefined) return undefined;
        return chat.read({
          chatThreadId: threadId,
          chatAttachmentId: decodeChatAttachmentId(source.attachmentId),
          displayName: attachment.displayName,
          size: reference.byteLength,
          hash: reference.digest,
          finalizedAt: attachment.createdAt,
        });
      }
      return source.mode === "work"
        ? work.read(decodeWorkThreadId(source.threadId), {
            attachmentId: decodeWorkAttachmentId(source.attachmentId),
            byteLength: reference.byteLength,
            digest: reference.digest,
          })
        : code.read(decodeCodeThreadId(source.threadId), {
            attachmentId: decodeCodeAttachmentId(source.attachmentId),
            byteLength: reference.byteLength,
            digest: reference.digest,
          });
    },
  };
}

export function createConversationInputTransfer(
  persistence: PersistenceService,
  workThreads: WorkThreadProjection,
  providers: ProviderRuntimeRegistry,
) {
  const source = conversationInputSource(persistence, workThreads);
  return new ConversationInputTransfer({
    dataDirectory: persistence.dataDirectory,
    ownerCurrent: source.ownerCurrent,
    sourceCurrent: source.current,
    read: source.read,
    supports: (target, mediaType) =>
      supportsConversationInput(
        providers.observedState(decodeProviderInstanceId(target.providerInstanceId)),
        target.modelId,
        mediaType,
      ),
  });
}
