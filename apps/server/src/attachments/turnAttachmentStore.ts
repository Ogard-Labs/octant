import {
  ManagedAttachmentStore,
  type ManagedAttachmentQueueResult,
  type QueuedAttachmentRelease,
} from "./managedAttachmentStore";

/**
 * What one turn-attachment reference carries, in every mode: the id the
 * renderer chose, the sanitized name, the accepted media type, and the size
 * and digest this process measured. Modes brand these fields differently, so
 * the generic store constrains its reference to this shape and each mode
 * builds its own branded type through the descriptor.
 */
export interface TurnAttachmentReferenceShape<AttachmentId, MediaType> {
  readonly attachmentId: AttachmentId;
  readonly displayName: string;
  readonly mediaType: MediaType;
  readonly byteLength: number;
  readonly digest: string;
}

/** The per-mode facts a turn-attachment store is built from. */
export interface TurnAttachmentStoreDescriptor<
  ThreadId extends string,
  AttachmentId extends string,
  MediaType,
  Reference extends TurnAttachmentReferenceShape<AttachmentId, MediaType>,
> {
  /** The managed store's scopes directory for this mode's threads. */
  readonly scopesDirectory: string;
  readonly maxBytes: number;
  /**
   * How many attachments one turn may carry. Composing is the only thing
   * that stages, so twice this leaves room to swap a picture out mid-compose
   * without letting a renderer fill the disk by pasting in a loop.
   */
  readonly maxTurnAttachments: number;
  readonly decodeThreadId: (value: unknown) => ThreadId;
  readonly decodeAttachmentId: (value: unknown) => AttachmentId;
  readonly tooLarge: (byteLength: number) => Error;
  readonly invalid: (message: string) => Error;
  /** Builds the mode's branded reference from the facts this store measured. */
  readonly buildReference: (parts: {
    readonly attachmentId: AttachmentId;
    readonly displayName: string;
    readonly mediaType: MediaType;
    readonly byteLength: number;
    readonly digest: string;
  }) => Reference;
}

export type TurnQueuedAttachments<Reference> =
  | { readonly status: "ok"; readonly attachments: ReadonlyArray<Reference> }
  | Exclude<ManagedAttachmentQueueResult, { readonly status: "ok" }>;

/**
 * The attachments a thread has staged for its next turn, and the bytes of the
 * ones its turns already sent — once per mode, not once per mode file.
 *
 * The renderer uploads bytes and is handed back nothing but the id it chose.
 * Every fact the journal later records about an attachment — its sanitized
 * name, its media type, its size, its digest — is decided here, from bytes
 * this process wrote, so a turn naming an id can only send the image the host
 * itself accepted under that id.
 */
export class TurnAttachmentStore<
  ThreadId extends string,
  AttachmentId extends string,
  MediaType,
  Reference extends TurnAttachmentReferenceShape<AttachmentId, MediaType>,
> {
  readonly #store: ManagedAttachmentStore;
  readonly #pending = new Map<string, Map<string, Reference>>();
  /** Uploads that have reserved a staging slot but not yet finalized. */
  readonly #inFlight = new Map<string, Set<string>>();
  readonly #queued = new Map<string, ReadonlyArray<Reference>>();
  readonly #prepared = new Set<string>();
  readonly #discarding = new Set<string>();
  readonly #queueOperations = new Set<string>();
  readonly #maxPendingPerThread: number;
  readonly #decodeAttachmentId: TurnAttachmentStoreDescriptor<
    ThreadId,
    AttachmentId,
    MediaType,
    Reference
  >["decodeAttachmentId"];
  readonly #invalid: TurnAttachmentStoreDescriptor<
    ThreadId,
    AttachmentId,
    MediaType,
    Reference
  >["invalid"];
  readonly #buildReference: TurnAttachmentStoreDescriptor<
    ThreadId,
    AttachmentId,
    MediaType,
    Reference
  >["buildReference"];

  constructor(
    dataDirectory: string,
    descriptor: TurnAttachmentStoreDescriptor<ThreadId, AttachmentId, MediaType, Reference>,
  ) {
    this.#store = new ManagedAttachmentStore(dataDirectory, {
      scopesDirectory: descriptor.scopesDirectory,
      maxBytes: descriptor.maxBytes,
      decodeScopeId: (value) => descriptor.decodeThreadId(value),
      decodeAttachmentId: (value) => descriptor.decodeAttachmentId(value),
      tooLarge: descriptor.tooLarge,
      empty: () => descriptor.invalid("Attachment must not be empty."),
      invalidDisplayName: (message) => descriptor.invalid(message),
    });
    this.#maxPendingPerThread = descriptor.maxTurnAttachments * 2;
    this.#decodeAttachmentId = descriptor.decodeAttachmentId;
    this.#invalid = descriptor.invalid;
    this.#buildReference = descriptor.buildReference;
  }

  /**
   * Accept one image for a thread and hold its reference until a turn sends it.
   *
   * Staging and finalization happen together: an attachment is complete the
   * moment the upload request that carried it returns, so there is no half-file
   * for a later turn to send.
   */
  async stage(input: {
    readonly threadId: ThreadId;
    readonly attachmentId: AttachmentId;
    readonly displayName: string;
    readonly mediaType: MediaType;
    readonly bytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<Reference> {
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
    if (occupied.size >= this.#maxPendingPerThread && !occupied.has(attachmentKey)) {
      throw this.#invalid("Too many attachments are staged for this thread.");
    }
    if (inFlight.has(attachmentKey))
      throw this.#invalid("Attachment upload is already in progress.");
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
      const reference = this.#buildReference({
        attachmentId: input.attachmentId,
        displayName: finalized.displayName,
        mediaType: input.mediaType,
        byteLength: finalized.size,
        digest: finalized.hash,
      });
      const scope = this.#pending.get(threadKey) ?? new Map<string, Reference>();
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
    threadId: ThreadId,
    attachmentIds: ReadonlyArray<AttachmentId>,
  ):
    | { readonly status: "ok"; readonly attachments: ReadonlyArray<Reference> }
    | { readonly status: "unknown"; readonly attachmentId: AttachmentId } {
    const scope = this.#pending.get(String(threadId));
    const attachments: Reference[] = [];
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
  release(threadId: ThreadId, attachmentIds: ReadonlyArray<AttachmentId>): void {
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
    threadId: ThreadId,
    input: {
      readonly attachmentId: AttachmentId;
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

  async discard(threadId: ThreadId, attachmentId: AttachmentId): Promise<void> {
    if (this.isQueued(threadId, attachmentId)) {
      throw this.#invalid("Attachment belongs to a queued message.");
    }
    // A turn has taken released slots over; late composer cleanup cannot erase them.
    if (!this.#pending.get(String(threadId))?.has(String(attachmentId))) return;
    const key = `${threadId}/${attachmentId}`;
    if (this.#discarding.has(key))
      throw this.#invalid("Attachment removal is already in progress.");
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
    threadId: ThreadId,
    ownerId: string,
    attachmentIds: ReadonlyArray<AttachmentId>,
  ): TurnQueuedAttachments<Reference> {
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
  commitQueued(threadId: ThreadId, ownerId: string): ManagedAttachmentQueueResult {
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
    threadId: ThreadId,
    ownerId: string,
    references: ReadonlyArray<Reference>,
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

  async prepareQueued(
    threadId: ThreadId,
    ownerId: string,
  ): Promise<TurnQueuedAttachments<Reference>> {
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
      const pending = this.#pending.get(String(threadId)) ?? new Map<string, Reference>();
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
    threadId: ThreadId,
    ownerId: string,
    options: QueuedAttachmentRelease<AttachmentId>,
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
              isTurnOwned: (id) => options.isTurnOwned(this.#decodeAttachmentId(id)),
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

  isQueued(threadId: ThreadId, attachmentId: AttachmentId): boolean {
    return this.#store.isQueued(String(threadId), String(attachmentId));
  }

  /**
   * Clear half-written uploads left by a crash. Finalized images are kept:
   * their references live in the event journal, and the transcript reads them
   * back long after the turn that sent them.
   */
  recover(): Promise<void> {
    return this.#store.recover();
  }

  /** Removes every attachment file this thread staged or sent. */
  purgeThread(threadId: ThreadId): Promise<void> {
    const threadKey = String(threadId);
    this.#pending.delete(threadKey);
    this.#inFlight.delete(threadKey);
    return this.#store.purgeScope(threadKey);
  }
}
