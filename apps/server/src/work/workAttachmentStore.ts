import {
  MAX_WORK_ATTACHMENT_BYTES,
  MAX_WORK_ATTACHMENT_DISPLAY_NAME_LENGTH,
  MAX_WORK_TURN_ATTACHMENTS,
  decodeWorkAttachmentId,
  decodeWorkThreadId,
  type WorkAttachmentId,
  type WorkAttachmentMediaType,
  type WorkAttachmentReference,
  type WorkThreadId,
} from "@octant/contracts";
import {
  ManagedAttachmentStore,
  type ManagedAttachmentQueueResult,
  type QueuedAttachmentRelease,
} from "../attachments/managedAttachmentStore";

export type WorkQueuedAttachments =
  | { readonly status: "ok"; readonly attachments: ReadonlyArray<WorkAttachmentReference> }
  | Exclude<ManagedAttachmentQueueResult, { readonly status: "ok" }>;

export { MAX_WORK_ATTACHMENT_BYTES, MAX_WORK_ATTACHMENT_DISPLAY_NAME_LENGTH };

/**
 * How many staged-but-unsent images one thread may hold. Composing is the only
 * thing that stages, and a turn may carry `MAX_WORK_TURN_ATTACHMENTS`, so twice
 * that leaves room to swap a picture out mid-compose without letting a renderer
 * fill the disk by pasting in a loop.
 */
const MAX_PENDING_ATTACHMENTS_PER_THREAD = MAX_WORK_TURN_ATTACHMENTS * 2;

export class WorkAttachmentTooLarge extends Error {
  readonly category = "invalid" as const;

  constructor(readonly byteLength: number) {
    super(
      `Attachment is too large (${byteLength} bytes). The maximum size is ${MAX_WORK_ATTACHMENT_BYTES} bytes.`,
    );
    this.name = "WorkAttachmentTooLarge";
  }
}

export class WorkAttachmentInvalid extends Error {
  readonly category = "invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorkAttachmentInvalid";
  }
}

/**
 * The images a Work thread has staged for its next turn, and the bytes of the
 * ones its turns already sent.
 *
 * The renderer uploads bytes and is handed back nothing but the id it chose.
 * Every fact the journal later records about an attachment — its sanitized
 * name, its media type, its size, its digest — is decided here, from bytes this
 * process wrote, so a `start-work-thread-turn` naming an id can only send the
 * image the host itself accepted under that id.
 */
export class WorkAttachmentStore {
  readonly #store: ManagedAttachmentStore;
  readonly #pending = new Map<string, Map<string, WorkAttachmentReference>>();
  /** Uploads that have reserved a staging slot but not yet finalized. */
  readonly #inFlight = new Map<string, Set<string>>();
  readonly #queued = new Map<string, ReadonlyArray<WorkAttachmentReference>>();
  readonly #prepared = new Set<string>();
  readonly #discarding = new Set<string>();
  readonly #queueOperations = new Set<string>();

  constructor(dataDirectory: string) {
    this.#store = new ManagedAttachmentStore(dataDirectory, {
      scopesDirectory: "work-threads",
      maxBytes: MAX_WORK_ATTACHMENT_BYTES,
      decodeScopeId: (value) => String(decodeWorkThreadId(value)),
      decodeAttachmentId: (value) => String(decodeWorkAttachmentId(value)),
      tooLarge: (byteLength) => new WorkAttachmentTooLarge(byteLength),
      empty: () => new WorkAttachmentInvalid("Attachment must not be empty."),
      invalidDisplayName: (message) => new WorkAttachmentInvalid(message),
    });
  }

  /**
   * Accept one image for a thread and hold its reference until a turn sends it.
   *
   * Staging and finalization happen together: a Work attachment is complete the
   * moment the upload request that carried it returns, so there is no half-file
   * for a later turn to send.
   */
  async stage(input: {
    readonly threadId: WorkThreadId;
    readonly attachmentId: WorkAttachmentId;
    readonly displayName: string;
    readonly mediaType: WorkAttachmentMediaType;
    readonly bytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<WorkAttachmentReference> {
    const threadKey = String(input.threadId);
    const attachmentKey = String(input.attachmentId);
    // Reserve the slot before the first await: concurrent uploads must count
    // against the same per-thread budget, not each read the pre-upload size.
    const pending = this.#pending.get(threadKey);
    const inFlight = this.#inFlight.get(threadKey) ?? new Set<string>();
    const occupied = new Set([
      ...[...(pending?.keys() ?? [])].filter((id) => !this.#prepared.has(`${threadKey}/${id}`)),
      ...inFlight,
    ]);
    if (occupied.size >= MAX_PENDING_ATTACHMENTS_PER_THREAD && !occupied.has(attachmentKey)) {
      throw new WorkAttachmentInvalid("Too many attachments are staged for this thread.");
    }
    if (inFlight.has(attachmentKey))
      throw new WorkAttachmentInvalid("Attachment upload is already in progress.");
    inFlight.add(attachmentKey);
    this.#inFlight.set(threadKey, inFlight);
    try {
      const staged = await this.#store.stage({
        scopeId: threadKey,
        attachmentId: attachmentKey,
        displayName: input.displayName,
        bytes: input.bytes,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const finalized = await this.#store.finalize(staged);
      const reference: WorkAttachmentReference = {
        attachmentId: input.attachmentId,
        displayName: finalized.displayName,
        mediaType: input.mediaType,
        byteLength: finalized.size,
        digest: finalized.hash,
      };
      const scope = this.#pending.get(threadKey) ?? new Map<string, WorkAttachmentReference>();
      scope.set(attachmentKey, reference);
      this.#pending.set(threadKey, scope);
      return reference;
    } finally {
      inFlight.delete(attachmentKey);
      if (inFlight.size === 0) this.#inFlight.delete(threadKey);
    }
  }

  /**
   * Turn the ids a turn named into the references the journal will record, or
   * report the first id this host cannot vouch for.
   */
  peek(
    threadId: WorkThreadId,
    attachmentIds: ReadonlyArray<WorkAttachmentId>,
  ):
    | { readonly status: "ok"; readonly attachments: ReadonlyArray<WorkAttachmentReference> }
    | { readonly status: "unknown"; readonly attachmentId: WorkAttachmentId } {
    const scope = this.#pending.get(String(threadId));
    const attachments: WorkAttachmentReference[] = [];
    for (const attachmentId of attachmentIds) {
      if (
        this.#discarding.has(`${threadId}/${attachmentId}`) ||
        (this.isQueued(threadId, attachmentId) &&
          !this.#prepared.has(`${threadId}/${attachmentId}`))
      ) {
        return { status: "unknown", attachmentId };
      }
      const reference = scope?.get(String(attachmentId));
      if (reference === undefined) return { status: "unknown", attachmentId };
      attachments.push(reference);
    }
    return { status: "ok", attachments };
  }

  /**
   * Forget the staging slots a turn has taken over. The bytes stay: the turn's
   * journalled reference is what reads them back. Only the per-thread staging
   * budget is freed.
   */
  release(threadId: WorkThreadId, attachmentIds: ReadonlyArray<WorkAttachmentId>): void {
    const threadKey = String(threadId);
    const scope = this.#pending.get(threadKey);
    if (scope === undefined) return;
    for (const attachmentId of attachmentIds) {
      scope.delete(String(attachmentId));
      this.#prepared.delete(`${threadKey}/${attachmentId}`);
    }
    if (scope.size === 0) this.#pending.delete(threadKey);
  }

  /**
   * Read one attached image back. The caller supplies the size and digest the
   * journal recorded, so bytes are served only when they are still the bytes
   * the turn was sent — a corrupted or swapped file fails rather than renders.
   */
  read(
    threadId: WorkThreadId,
    input: {
      readonly attachmentId: WorkAttachmentId;
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

  async discard(threadId: WorkThreadId, attachmentId: WorkAttachmentId): Promise<void> {
    if (this.isQueued(threadId, attachmentId)) {
      throw new WorkAttachmentInvalid("Attachment belongs to a queued message.");
    }
    // A turn has taken released slots over; late composer cleanup cannot erase them.
    if (!this.#pending.get(String(threadId))?.has(String(attachmentId))) return;
    const key = `${threadId}/${attachmentId}`;
    if (this.#discarding.has(key))
      throw new WorkAttachmentInvalid("Attachment removal is already in progress.");
    this.#discarding.add(key);
    try {
      await this.#store.remove(String(threadId), String(attachmentId));
      this.release(threadId, [attachmentId]);
    } finally {
      this.#discarding.delete(key);
    }
  }

  /** Reserve before persisting the queue payload; roll back with disposition draft. */
  claimQueued(
    threadId: WorkThreadId,
    ownerId: string,
    attachmentIds: ReadonlyArray<WorkAttachmentId>,
  ): WorkQueuedAttachments {
    const key = `${threadId}/${ownerId}`;
    if (this.#queueOperations.has(key)) return { status: "refused", reason: "busy" };
    const existing = this.#queued.get(key);
    if (existing !== undefined) {
      return existing.length === attachmentIds.length &&
        existing.every((ref, index) => String(ref.attachmentId) === String(attachmentIds[index]))
        ? { status: "ok", attachments: existing }
        : { status: "refused", reason: "owner-conflict" };
    }
    const pending = this.peek(threadId, attachmentIds);
    if (pending.status !== "ok") return { status: "refused", reason: "unavailable" };
    const pinned = this.restoreQueuedOwnership(threadId, ownerId, pending.attachments);
    return pinned.status === "ok" ? { status: "ok", attachments: pending.attachments } : pinned;
  }

  /** Only a durable enqueue acknowledgement transfers the draft's staging slots. */
  commitQueued(threadId: WorkThreadId, ownerId: string): ManagedAttachmentQueueResult {
    if (this.#queueOperations.has(`${threadId}/${ownerId}`))
      return { status: "refused", reason: "busy" };
    const references = this.#queued.get(`${threadId}/${ownerId}`);
    if (references === undefined) return { status: "refused", reason: "unknown-owner" };
    this.release(
      threadId,
      references
        .map((ref) => ref.attachmentId)
        .filter((id) => !this.#prepared.has(`${threadId}/${id}`)),
    );
    return { status: "ok" };
  }

  restoreQueuedOwnership(
    threadId: WorkThreadId,
    ownerId: string,
    references: ReadonlyArray<WorkAttachmentReference>,
  ): ManagedAttachmentQueueResult {
    const key = `${threadId}/${ownerId}`;
    if (this.#queueOperations.has(key)) return { status: "refused", reason: "busy" };
    const existing = this.#queued.get(key);
    if (
      existing !== undefined &&
      (existing.length !== references.length ||
        existing.some((ref, index) => {
          const candidate = references[index];
          return (
            candidate === undefined ||
            String(ref.attachmentId) !== String(candidate.attachmentId) ||
            ref.displayName !== candidate.displayName ||
            ref.mediaType !== candidate.mediaType ||
            ref.byteLength !== candidate.byteLength ||
            ref.digest !== candidate.digest
          );
        }))
    ) {
      return { status: "refused", reason: "owner-conflict" };
    }
    const result = this.#store.pinQueued(
      String(threadId),
      ownerId,
      references.map((ref) => ({
        scopeId: String(threadId),
        attachmentId: String(ref.attachmentId),
        displayName: ref.displayName,
        size: ref.byteLength,
        hash: ref.digest,
        finalizedAt: new Date(0).toISOString(),
      })),
    );
    if (result.status === "ok" && existing === undefined)
      this.#queued.set(
        key,
        references.map((ref) => ({ ...ref })),
      );
    return result;
  }

  async prepareQueued(threadId: WorkThreadId, ownerId: string): Promise<WorkQueuedAttachments> {
    const key = `${threadId}/${ownerId}`;
    if (this.#queueOperations.has(key)) return { status: "refused", reason: "busy" };
    const references = this.#queued.get(key);
    if (references === undefined) return { status: "refused", reason: "unknown-owner" };
    this.#queueOperations.add(key);
    this.release(
      threadId,
      references.map((ref) => ref.attachmentId),
    );
    try {
      const verified = await this.#store.verifyQueued(String(threadId), ownerId);
      if (verified.status !== "ok") return verified;
      if (this.#queued.get(key) !== references)
        return { status: "refused", reason: "unknown-owner" };
      const pending =
        this.#pending.get(String(threadId)) ?? new Map<string, WorkAttachmentReference>();
      for (const ref of references) {
        pending.set(String(ref.attachmentId), ref);
        this.#prepared.add(`${threadId}/${ref.attachmentId}`);
      }
      if (pending.size > 0) this.#pending.set(String(threadId), pending);
      return { status: "ok", attachments: references };
    } finally {
      this.#queueOperations.delete(key);
    }
  }

  async releaseQueued(
    threadId: WorkThreadId,
    ownerId: string,
    options: QueuedAttachmentRelease<WorkAttachmentId>,
  ): Promise<ManagedAttachmentQueueResult> {
    const key = `${threadId}/${ownerId}`;
    if (this.#queueOperations.has(key)) return { status: "refused", reason: "busy" };
    const references = this.#queued.get(key);
    this.#queueOperations.add(key);
    try {
      const result = await this.#store.releaseQueued(
        String(threadId),
        ownerId,
        options.disposition === "removed"
          ? {
              disposition: "removed",
              isTurnOwned: (id) => options.isTurnOwned(decodeWorkAttachmentId(id)),
            }
          : options,
      );
      if (result.status === "ok") {
        if (options.disposition !== "draft")
          this.release(threadId, references?.map((ref) => ref.attachmentId) ?? []);
        for (const ref of references ?? [])
          this.#prepared.delete(`${threadId}/${ref.attachmentId}`);
        this.#queued.delete(key);
      }
      return result;
    } finally {
      this.#queueOperations.delete(key);
    }
  }

  isQueued(threadId: WorkThreadId, attachmentId: WorkAttachmentId): boolean {
    return this.#store.isQueued(String(threadId), String(attachmentId));
  }

  /**
   * Clear half-written uploads left by a crash. Finalized images are kept:
   * their references live in the event journal.
   */
  recover(): Promise<void> {
    return this.#store.recover();
  }

  /** Removes every attachment file this thread staged or sent. */
  purgeThread(threadId: WorkThreadId): Promise<void> {
    const threadKey = String(threadId);
    this.#pending.delete(threadKey);
    this.#inFlight.delete(threadKey);
    return this.#store.purgeScope(threadKey);
  }
}
