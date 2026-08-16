import {
  decodeChatAttachmentId,
  decodeChatThreadId,
  type ChatAttachmentId,
  type ChatThreadId,
} from "@octant/contracts";
import {
  ManagedAttachmentStore,
  MAX_MANAGED_ATTACHMENT_DISPLAY_NAME_LENGTH,
  sanitizeManagedAttachmentDisplayName,
} from "../attachments/managedAttachmentStore";

export const MAX_CHAT_ATTACHMENT_BYTES = 26_214_400;
export const MAX_CHAT_ATTACHMENT_DISPLAY_NAME_LENGTH = MAX_MANAGED_ATTACHMENT_DISPLAY_NAME_LENGTH;

export class ChatAttachmentTooLarge extends Error {
  readonly category = "too-large" as const;

  constructor(readonly byteLength: number) {
    super(
      `Attachment is too large (${byteLength} bytes). The maximum size is ${MAX_CHAT_ATTACHMENT_BYTES} bytes.`,
    );
    this.name = "ChatAttachmentTooLarge";
  }
}

export class ChatAttachmentInvalidDisplayName extends Error {
  readonly category = "invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "ChatAttachmentInvalidDisplayName";
  }
}

export class ChatAttachmentEmpty extends Error {
  readonly category = "invalid" as const;

  constructor() {
    super("Attachment must not be empty.");
    this.name = "ChatAttachmentEmpty";
  }
}

export interface ChatAttachmentStaged {
  readonly chatThreadId: ChatThreadId;
  readonly chatAttachmentId: ChatAttachmentId;
  readonly displayName: string;
  readonly size: number;
  readonly hash: string;
  readonly stagedAt: string;
}

export interface ChatAttachmentFinalized {
  readonly chatThreadId: ChatThreadId;
  readonly chatAttachmentId: ChatAttachmentId;
  readonly displayName: string;
  readonly size: number;
  readonly hash: string;
  readonly finalizedAt: string;
}

export interface ChatAttachmentRecoveryOptions {
  readonly isFinalizedAttachmentReferenced?: (
    threadId: ChatThreadId,
    attachmentId: ChatAttachmentId,
  ) => boolean;
}

function chatManagedStore(dataDirectory: string): ManagedAttachmentStore {
  return new ManagedAttachmentStore(dataDirectory, {
    scopesDirectory: "threads",
    maxBytes: MAX_CHAT_ATTACHMENT_BYTES,
    decodeScopeId: (value) => String(decodeChatThreadId(value)),
    decodeAttachmentId: (value) => String(decodeChatAttachmentId(value)),
    tooLarge: (byteLength) => new ChatAttachmentTooLarge(byteLength),
    empty: () => new ChatAttachmentEmpty(),
    invalidDisplayName: (message) => new ChatAttachmentInvalidDisplayName(message),
  });
}

export function sanitizeChatAttachmentDisplayName(name: string): string {
  return sanitizeManagedAttachmentDisplayName(
    name,
    (message) => new ChatAttachmentInvalidDisplayName(message),
  );
}

/**
 * Chat's attachment bytes. The file handling — staging, digest-checked
 * finalization, confinement to a plain directory under the managed root, and
 * crash recovery — lives in the shared managed store; this class is the Chat
 * boundary that decodes Chat's own identifiers and keeps Chat's error types.
 */
export class ChatAttachmentStore {
  readonly #store: ManagedAttachmentStore;

  constructor(dataDirectory: string) {
    this.#store = chatManagedStore(dataDirectory);
  }

  async stage(input: {
    readonly chatThreadId: ChatThreadId;
    readonly chatAttachmentId: ChatAttachmentId;
    readonly displayName: string;
    readonly bytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<ChatAttachmentStaged> {
    const staged = await this.#store.stage({
      scopeId: String(input.chatThreadId),
      attachmentId: String(input.chatAttachmentId),
      displayName: input.displayName,
      bytes: input.bytes,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return {
      chatThreadId: decodeChatThreadId(staged.scopeId),
      chatAttachmentId: decodeChatAttachmentId(staged.attachmentId),
      displayName: staged.displayName,
      size: staged.size,
      hash: staged.hash,
      stagedAt: staged.stagedAt,
    };
  }

  async finalize(staged: ChatAttachmentStaged): Promise<ChatAttachmentFinalized> {
    const finalized = await this.#store.finalize({
      scopeId: String(staged.chatThreadId),
      attachmentId: String(staged.chatAttachmentId),
      displayName: staged.displayName,
      size: staged.size,
      hash: staged.hash,
      stagedAt: staged.stagedAt,
    });
    return {
      chatThreadId: decodeChatThreadId(finalized.scopeId),
      chatAttachmentId: decodeChatAttachmentId(finalized.attachmentId),
      displayName: finalized.displayName,
      size: finalized.size,
      hash: finalized.hash,
      finalizedAt: finalized.finalizedAt,
    };
  }

  read(finalized: ChatAttachmentFinalized): Promise<Uint8Array> {
    return this.#store.read({
      scopeId: String(finalized.chatThreadId),
      attachmentId: String(finalized.chatAttachmentId),
      displayName: finalized.displayName,
      size: finalized.size,
      hash: finalized.hash,
      finalizedAt: finalized.finalizedAt,
    });
  }

  remove(threadId: ChatThreadId, attachmentId: ChatAttachmentId): Promise<void> {
    return this.#store.remove(String(threadId), String(attachmentId));
  }

  recover(options: ChatAttachmentRecoveryOptions = {}): Promise<void> {
    const isReferenced = options.isFinalizedAttachmentReferenced;
    return this.#store.recover(
      isReferenced === undefined
        ? {}
        : {
            isFinalizedAttachmentReferenced: (scopeId, attachmentId) =>
              isReferenced(decodeChatThreadId(scopeId), decodeChatAttachmentId(attachmentId)),
          },
    );
  }

  hasTemporaryFiles(): Promise<boolean> {
    return this.#store.hasTemporaryFiles();
  }

  purgeThread(threadId: ChatThreadId): Promise<void> {
    return this.#store.purgeScope(String(threadId));
  }
}
