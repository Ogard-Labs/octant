import {
  MAX_CODE_ATTACHMENT_BYTES,
  MAX_CODE_ATTACHMENT_DISPLAY_NAME_LENGTH,
  MAX_CODE_TURN_ATTACHMENTS,
  decodeCodeAttachmentId,
  decodeCodeThreadId,
  type CodeAttachmentId,
  type CodeAttachmentMediaType,
  type CodeAttachmentReference,
  type CodeThreadId,
} from "@octant/contracts";
import { ManagedAttachmentStore } from "../attachments/managedAttachmentStore";

export { MAX_CODE_ATTACHMENT_BYTES, MAX_CODE_ATTACHMENT_DISPLAY_NAME_LENGTH };

/**
 * How many staged-but-unsent images one thread may hold. Composing is the only
 * thing that stages, and a turn may carry `MAX_CODE_TURN_ATTACHMENTS`, so twice
 * that leaves room to swap a picture out mid-compose without letting a renderer
 * fill the disk by pasting in a loop.
 */
const MAX_PENDING_ATTACHMENTS_PER_THREAD = MAX_CODE_TURN_ATTACHMENTS * 2;

export class CodeAttachmentTooLarge extends Error {
  readonly category = "invalid" as const;

  constructor(readonly byteLength: number) {
    super(
      `Attachment is too large (${byteLength} bytes). The maximum size is ${MAX_CODE_ATTACHMENT_BYTES} bytes.`,
    );
    this.name = "CodeAttachmentTooLarge";
  }
}

export class CodeAttachmentInvalid extends Error {
  readonly category = "invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "CodeAttachmentInvalid";
  }
}

/**
 * The images a Code thread has staged for its next turn, and the bytes of the
 * ones its turns already sent.
 *
 * The renderer uploads bytes and is handed back nothing but the id it chose.
 * Every fact the journal later records about an attachment — its sanitized
 * name, its media type, its size, its digest — is decided here, from bytes this
 * process wrote, so a `start-provider-turn` naming an id can only send the
 * image the host itself accepted under that id.
 */
export class CodeAttachmentStore {
  readonly #store: ManagedAttachmentStore;
  readonly #pending = new Map<string, Map<string, CodeAttachmentReference>>();

  constructor(dataDirectory: string) {
    this.#store = new ManagedAttachmentStore(dataDirectory, {
      scopesDirectory: "code-threads",
      maxBytes: MAX_CODE_ATTACHMENT_BYTES,
      decodeScopeId: (value) => String(decodeCodeThreadId(value)),
      decodeAttachmentId: (value) => String(decodeCodeAttachmentId(value)),
      tooLarge: (byteLength) => new CodeAttachmentTooLarge(byteLength),
      empty: () => new CodeAttachmentInvalid("Attachment must not be empty."),
      invalidDisplayName: (message) => new CodeAttachmentInvalid(message),
    });
  }

  /**
   * Accept one image for a thread and hold its reference until a turn sends it.
   *
   * Staging and finalization happen together: a Code attachment is complete the
   * moment the upload request that carried it returns, so there is no half-file
   * for a later turn to send.
   */
  async stage(input: {
    readonly threadId: CodeThreadId;
    readonly attachmentId: CodeAttachmentId;
    readonly displayName: string;
    readonly mediaType: CodeAttachmentMediaType;
    readonly bytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<CodeAttachmentReference> {
    const threadKey = String(input.threadId);
    const pending = this.#pending.get(threadKey);
    if (
      pending !== undefined &&
      pending.size >= MAX_PENDING_ATTACHMENTS_PER_THREAD &&
      !pending.has(String(input.attachmentId))
    ) {
      throw new CodeAttachmentInvalid("Too many attachments are staged for this thread.");
    }
    const staged = await this.#store.stage({
      scopeId: threadKey,
      attachmentId: String(input.attachmentId),
      displayName: input.displayName,
      bytes: input.bytes,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const finalized = await this.#store.finalize(staged);
    const reference: CodeAttachmentReference = {
      attachmentId: input.attachmentId,
      displayName: finalized.displayName,
      mediaType: input.mediaType,
      byteLength: finalized.size,
      digest: finalized.hash,
    };
    const scope = this.#pending.get(threadKey) ?? new Map<string, CodeAttachmentReference>();
    scope.set(String(input.attachmentId), reference);
    this.#pending.set(threadKey, scope);
    return reference;
  }

  /**
   * Turn the ids a turn named into the references the journal will record, or
   * report the first id this host cannot vouch for.
   */
  peek(
    threadId: CodeThreadId,
    attachmentIds: ReadonlyArray<CodeAttachmentId>,
  ):
    | { readonly status: "ok"; readonly attachments: ReadonlyArray<CodeAttachmentReference> }
    | { readonly status: "unknown"; readonly attachmentId: CodeAttachmentId } {
    const scope = this.#pending.get(String(threadId));
    const attachments: CodeAttachmentReference[] = [];
    for (const attachmentId of attachmentIds) {
      const reference = scope?.get(String(attachmentId));
      if (reference === undefined) return { status: "unknown", attachmentId };
      attachments.push(reference);
    }
    return { status: "ok", attachments };
  }

  /**
   * Forget the staging slots a turn has taken over. The bytes stay: the turn's
   * journalled reference is what reads them back, and the transcript shows the
   * image long after the send. Only the per-thread staging budget is freed.
   */
  release(threadId: CodeThreadId, attachmentIds: ReadonlyArray<CodeAttachmentId>): void {
    const threadKey = String(threadId);
    const scope = this.#pending.get(threadKey);
    if (scope === undefined) return;
    for (const attachmentId of attachmentIds) scope.delete(String(attachmentId));
    if (scope.size === 0) this.#pending.delete(threadKey);
  }

  /**
   * Read one attached image back. The caller supplies the size and digest the
   * journal recorded, so bytes are served only when they are still the bytes
   * the turn was sent — a corrupted or swapped file fails rather than renders.
   */
  read(
    threadId: CodeThreadId,
    input: {
      readonly attachmentId: CodeAttachmentId;
      readonly byteLength: number;
      readonly digest: string;
    },
  ): Promise<Uint8Array> {
    return this.#store.read({
      scopeId: String(threadId),
      attachmentId: String(input.attachmentId),
      // The stored name plays no part in reading; the digest and size decide.
      displayName: "attachment",
      size: input.byteLength,
      hash: input.digest,
      finalizedAt: new Date(0).toISOString(),
    });
  }

  async discard(threadId: CodeThreadId, attachmentId: CodeAttachmentId): Promise<void> {
    this.#pending.get(String(threadId))?.delete(String(attachmentId));
    await this.#store.remove(String(threadId), String(attachmentId));
  }

  /**
   * Clear half-written uploads left by a crash. Finalized images are kept:
   * their references live in the event journal, and the transcript reads them
   * back long after the turn that sent them.
   */
  recover(): Promise<void> {
    return this.#store.recover();
  }
}
