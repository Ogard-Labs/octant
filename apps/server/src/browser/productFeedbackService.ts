import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  MAX_PENDING_PRODUCT_FEEDBACK_NOTES,
  UtcTimestamp,
  decodeProductFeedbackCommand,
  decodeProductFeedbackNote,
  decodeProductFeedbackNoteId,
  decodeProductFeedbackPreview,
  decodeProductFeedbackPointObservation,
  decodeProductFeedbackCropAnswer,
  type EventActor as EventActorValue,
  type ProductFeedbackCommandResult,
  type ProductFeedbackCrop,
  type ProductFeedbackNote,
  type ProductFeedbackNoteId,
} from "@octant/contracts";
import type { WindowId } from "@octant/contracts/shell";
import { productFeedbackProvenance } from "@octant/domain";
import { Schema } from "effect";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import type { Journal } from "../persistence/journal";
import type { BrowserPointObservation } from "./browserRuntimePort";
import { ProductFeedbackPreviewStore } from "./productFeedbackPreviewStore";

export interface ProductFeedbackExecutionContext {
  readonly admissionCurrent: () => boolean;
  readonly signal?: AbortSignal;
}

class FeedbackCommitRetired extends Error {}

interface FeedbackThreadScope {
  readonly mode: "work" | "code";
  readonly current: () => boolean;
}

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export class ProductFeedbackError extends Error {
  readonly category: "invalid" | "conflict";

  constructor(category: ProductFeedbackError["category"], message: string) {
    super(message);
    this.name = "ProductFeedbackError";
    this.category = category;
  }
}

/** The browser surface, reduced to the one thing a note needs from it. */
export interface ProductFeedbackBrowserPort {
  readonly describePoint: (input: {
    readonly windowId: WindowId;
    readonly threadId: string;
    readonly contextId: string;
    readonly point: { readonly x: number; readonly y: number };
    readonly selectionId?: string;
    readonly expectedObservationRevision?: number;
    readonly current?: () => boolean;
    readonly signal?: AbortSignal;
  }) => Promise<BrowserPointObservation | { readonly status: "unavailable" }>;
}

/** Where a crop is kept: outside the journal, referenced from it. */
export interface ProductFeedbackCropStore {
  readonly put: (dataUrl: string) => ProductFeedbackCrop;
  readonly read: (crop: ProductFeedbackCrop) => string | undefined;
}

export interface ProductFeedbackServiceOptions {
  readonly journal: Pick<Journal, "append">;
  readonly browser: ProductFeedbackBrowserPort;
  readonly crops: ProductFeedbackCropStore;
  readonly readNote: (noteId: ProductFeedbackNoteId) => ProductFeedbackNote | undefined;
  readonly readNotes: (threadId: string) => ReadonlyArray<ProductFeedbackNote>;
  /** Whether this window may see the thread the note is being left on. */
  readonly canAccessThread: (windowId: WindowId, threadId: string) => Promise<boolean>;
  /** Host-resolved mode and live ownership; never inferred from a renderer mode. */
  readonly resolveThread?: (
    windowId: WindowId,
    threadId: string,
  ) => Promise<FeedbackThreadScope | undefined>;
  /** Existing journal transaction on the same connection as crops and taint. */
  readonly transaction?: <A>(body: () => A) => A;
  readonly recordExternalContentIngestion?: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: EventActorValue;
}

/**
 * Notes a user points at the running product.
 *
 * The gesture is "this, here, is wrong". The client sends where it tapped and
 * what it wants to say; the host resolves the element and cuts the picture
 * itself, after checking that this caller may look at this thread's browser at
 * all. Nothing about the element is ever taken from the caller, so a note can
 * neither name an element from a page its author could not see nor claim an
 * identity the page never had.
 *
 * A note is data with provenance, never a second instruction channel: the
 * comment is credited to the user and everything read off the page is marked
 * external content, and the turn that carries a note quotes it under that
 * framing rather than blending it into the prompt.
 */
export class ProductFeedbackService {
  readonly #options: ProductFeedbackServiceOptions;
  readonly #actor: EventActorValue;
  readonly #previews: ProductFeedbackPreviewStore;

  constructor(options: ProductFeedbackServiceOptions) {
    this.#options = options;
    this.#previews = new ProductFeedbackPreviewStore(() =>
      Date.parse(decodeTimestamp(options.clock())),
    );
    const actor = decodeActor(options.actor);
    decodeActorId(actor.actorId);
    this.#actor = actor;
  }

  async list(
    windowId: WindowId,
    threadId: string,
    execution?: ProductFeedbackExecutionContext,
  ): Promise<ReadonlyArray<ProductFeedbackNote>> {
    const scope = await this.#options.resolveThread?.(windowId, threadId);
    if (
      (this.#options.resolveThread !== undefined && scope === undefined) ||
      !(await this.#options.canAccessThread(windowId, threadId)) ||
      scope?.current() === false ||
      execution?.signal?.aborted ||
      execution?.admissionCurrent() === false
    )
      return [];
    return this.#options.readNotes(threadId);
  }

  async readCropForNote(
    windowId: WindowId,
    noteId: string,
    execution: ProductFeedbackExecutionContext,
  ): Promise<string | undefined> {
    const original = this.#options.readNote(decodeProductFeedbackNoteId(noteId));
    if (original === undefined || original.lifecycle === "discarded") return undefined;
    const scope = await this.#scope(windowId, original.threadId, execution);
    if (scope === undefined) return undefined;
    const latest = this.#options.readNote(original.id);
    if (
      latest === undefined ||
      latest.threadId !== original.threadId ||
      latest.mode !== scope.mode ||
      latest.lifecycle === "discarded" ||
      latest.crop === undefined
    )
      return undefined;
    const data = this.#options.crops.read(latest.crop);
    if (execution.signal?.aborted || !execution.admissionCurrent() || !scope.current())
      return undefined;
    try {
      return decodeProductFeedbackCropAnswer({ dataUrl: data }).dataUrl;
    } catch {
      return undefined;
    }
  }

  async execute(
    windowId: WindowId,
    input: unknown,
    execution?: ProductFeedbackExecutionContext,
  ): Promise<ProductFeedbackCommandResult> {
    let command;
    try {
      command = decodeProductFeedbackCommand(input);
    } catch {
      throw new ProductFeedbackError("invalid", "Product feedback command is invalid.");
    }
    if (command.kind === "prepare-product-feedback")
      return this.#prepare(windowId, command, execution);
    if (command.kind === "commit-product-feedback")
      return this.#commitPreview(windowId, command, execution);
    if (command.kind === "cancel-product-feedback-preview") {
      if (
        execution?.signal?.aborted ||
        execution?.admissionCurrent() !== true ||
        this.#previews.read(command.previewId, windowId, command.threadId) === undefined
      )
        return { kind: "feedback-refused", reason: "preview-expired" };
      this.#previews.release(command.previewId);
      return { kind: "feedback-preview-cancelled", previewId: command.previewId };
    }
    if (command.kind === "update-product-feedback")
      return this.#update(windowId, command, execution);
    if (command.kind === "discard-product-feedback")
      return this.#discard(windowId, command, execution);
    return this.#capture(windowId, command, execution);
  }

  async #scope(
    windowId: WindowId,
    threadId: string,
    execution: ProductFeedbackExecutionContext | undefined,
  ): Promise<FeedbackThreadScope | undefined> {
    if (execution?.signal?.aborted || execution?.admissionCurrent() !== true) return undefined;
    const scope = await this.#options.resolveThread?.(windowId, threadId);
    return scope !== undefined &&
      !execution.signal?.aborted &&
      execution.admissionCurrent() &&
      scope.current()
      ? scope
      : undefined;
  }

  async #prepare(
    windowId: WindowId,
    command: Extract<
      ReturnType<typeof decodeProductFeedbackCommand>,
      { kind: "prepare-product-feedback" }
    >,
    execution: ProductFeedbackExecutionContext | undefined,
  ): Promise<ProductFeedbackCommandResult> {
    const scope = await this.#scope(windowId, command.threadId, execution);
    if (scope === undefined || execution === undefined)
      return { kind: "feedback-refused", reason: "thread-unavailable" };
    const admissionCurrent = execution.admissionCurrent;
    const current = () => admissionCurrent() && scope.current();
    const id = this.#options.uuid();
    const expiresAt = this.#previews.reserve({ id, windowId, threadId: command.threadId, current });
    if (expiresAt === undefined)
      return { kind: "feedback-refused", reason: "preview-limit-reached" };
    let retained = false;
    try {
      const observed = decodeProductFeedbackPointObservation(
        await this.#options.browser.describePoint({
          windowId,
          threadId: command.threadId,
          contextId: command.contextId,
          point: command.point,
          ...(command.selectionId === undefined ? {} : { selectionId: command.selectionId }),
          ...(command.expectedObservationRevision === undefined
            ? {}
            : { expectedObservationRevision: command.expectedObservationRevision }),
          current,
          ...(execution.signal === undefined ? {} : { signal: execution.signal }),
        }),
      );
      if (execution.signal?.aborted || !current())
        return { kind: "feedback-refused", reason: "thread-unavailable" };
      if (observed.status === "unavailable")
        return { kind: "feedback-refused", reason: "surface-unavailable" };
      if (observed.status === "no-element")
        return { kind: "feedback-refused", reason: "element-unavailable" };
      const preview = decodeProductFeedbackPreview({
        id,
        threadId: command.threadId,
        mode: scope.mode,
        element: {
          kind: "browser-element",
          ...observed.element,
          ...(observed.url === undefined ? {} : { url: observed.url }),
          ...(observed.title === undefined ? {} : { title: observed.title }),
        },
        ...(observed.cropDataUrl === undefined ? {} : { cropDataUrl: observed.cropDataUrl }),
        provenance: productFeedbackProvenance({ surface: "browser" }),
        capturedAt: decodeTimestamp(this.#options.clock()),
        expiresAt: new Date(expiresAt).toISOString(),
      });
      retained = this.#previews.put(id, preview);
      if (!retained) return { kind: "feedback-refused", reason: "preview-limit-reached" };
      const saved = this.#previews.read(id, windowId, command.threadId);
      if (saved === undefined || execution.signal?.aborted || !current())
        return { kind: "feedback-refused", reason: "thread-unavailable" };
      return { kind: "feedback-prepared", preview: saved };
    } catch {
      return { kind: "feedback-refused", reason: "capture-unavailable" };
    } finally {
      if (!retained || execution.signal?.aborted || !current()) this.#previews.release(id);
    }
  }

  async #commitPreview(
    windowId: WindowId,
    command: Extract<
      ReturnType<typeof decodeProductFeedbackCommand>,
      { kind: "commit-product-feedback" }
    >,
    execution: ProductFeedbackExecutionContext | undefined,
  ): Promise<ProductFeedbackCommandResult> {
    const scope = await this.#scope(windowId, command.threadId, execution);
    if (scope === undefined || execution === undefined)
      return { kind: "feedback-refused", reason: "thread-unavailable" };
    const preview = this.#previews.read(command.previewId, windowId, command.threadId);
    if (preview === undefined) return { kind: "feedback-refused", reason: "preview-expired" };
    if (scope.mode !== preview.mode)
      return { kind: "feedback-refused", reason: "thread-unavailable" };
    const transaction = this.#options.transaction;
    const recordIngestion = this.#options.recordExternalContentIngestion;
    if (transaction === undefined || recordIngestion === undefined)
      return { kind: "feedback-refused", reason: "capture-unavailable" };
    try {
      const result = transaction((): ProductFeedbackCommandResult => {
        if (
          this.#options.readNotes(command.threadId).filter((note) => note.lifecycle === "pending")
            .length >= MAX_PENDING_PRODUCT_FEEDBACK_NOTES
        )
          return { kind: "feedback-refused", reason: "note-limit-reached" };
        const noteId = command.noteId ?? decodeProductFeedbackNoteId(this.#options.uuid());
        if (this.#options.readNote(noteId) !== undefined)
          throw new ProductFeedbackError("conflict", "Product feedback note ID is already in use.");
        if (execution.signal?.aborted || !execution.admissionCurrent() || !scope.current())
          throw new FeedbackCommitRetired();
        let crop: ProductFeedbackCrop | undefined;
        if (preview.cropDataUrl !== undefined) {
          try {
            crop = this.#options.crops.put(preview.cropDataUrl);
          } catch {
            /* Keep the comment and exact element without an unavailable crop. */
          }
        }
        const timestamp = decodeTimestamp(this.#options.clock());
        const note = decodeProductFeedbackNote({
          id: noteId,
          threadId: preview.threadId,
          mode: preview.mode,
          comment: command.comment,
          element: preview.element,
          ...(crop === undefined ? {} : { crop }),
          provenance: preview.provenance,
          lifecycle: "pending",
          included: true,
          capturedAt: preview.capturedAt,
          version: 1,
          updatedAt: timestamp,
        });
        if (
          execution.signal?.aborted ||
          !execution.admissionCurrent() ||
          !scope.current() ||
          this.#previews.read(command.previewId, windowId, command.threadId) === undefined
        )
          throw new FeedbackCommitRetired();
        const ingestion = recordIngestion({
          threadId: note.threadId,
          provenance: note.provenance.element,
          contentReference: String(note.id),
          correlationId: this.#options.uuid(),
          authorized: true,
        });
        if (ingestion.kind !== "recorded" && ingestion.kind !== "already-recorded")
          throw new ProductFeedbackError(
            "invalid",
            "Product feedback capture could not be marked as outside content.",
          );
        if (execution.signal?.aborted || !execution.admissionCurrent() || !scope.current())
          throw new FeedbackCommitRetired();
        this.#append(note, 0, "feedback.note-captured@1", { kind: "feedback-captured", note });
        return { kind: "feedback-captured", note };
      });
      if (result.kind === "feedback-captured") this.#previews.release(command.previewId);
      return result;
    } catch (error) {
      if (error instanceof FeedbackCommitRetired)
        return { kind: "feedback-refused", reason: "thread-unavailable" };
      throw error;
    }
  }

  async #update(
    windowId: WindowId,
    command: Extract<
      ReturnType<typeof decodeProductFeedbackCommand>,
      { kind: "update-product-feedback" }
    >,
    execution: ProductFeedbackExecutionContext | undefined,
  ): Promise<ProductFeedbackCommandResult> {
    const original = this.#options.readNote(command.noteId);
    if (original === undefined)
      throw new ProductFeedbackError("invalid", "Product feedback note was not found.");
    const scope = await this.#scope(windowId, original.threadId, execution);
    if (scope === undefined || execution === undefined)
      return { kind: "feedback-refused", reason: "thread-unavailable" };
    const current = this.#options.readNote(command.noteId);
    if (
      current === undefined ||
      current.threadId !== original.threadId ||
      current.mode !== scope.mode ||
      current.lifecycle !== "pending" ||
      current.version !== command.expectedVersion
    )
      throw new ProductFeedbackError("conflict", "Product feedback note has changed.");
    const note = decodeProductFeedbackNote({
      ...current,
      ...(command.comment === undefined ? {} : { comment: command.comment }),
      ...(command.included === undefined ? {} : { included: command.included }),
      version: current.version + 1,
      updatedAt: decodeTimestamp(this.#options.clock()),
    });
    if (execution.signal?.aborted || !execution.admissionCurrent() || !scope.current())
      return { kind: "feedback-refused", reason: "thread-unavailable" };
    this.#append(note, current.version, "feedback.note-updated@1", {
      kind: "feedback-updated",
      note,
    });
    return { kind: "feedback-updated", note };
  }

  revokeWindow(windowId: WindowId): void {
    this.#previews.revokeWindow(windowId);
  }
  purgeThread(threadId: string): void {
    this.#previews.purgeThread(threadId);
  }
  close(): void {
    this.#previews.close();
  }
  revalidatePreviews(): void {
    this.#previews.revalidate();
  }

  async #capture(
    windowId: WindowId,
    command: Extract<
      ReturnType<typeof decodeProductFeedbackCommand>,
      { kind: "capture-product-feedback" }
    >,
    execution?: ProductFeedbackExecutionContext,
  ): Promise<ProductFeedbackCommandResult> {
    const scope = await this.#options.resolveThread?.(windowId, command.threadId);
    const current = () =>
      execution?.signal?.aborted !== true &&
      execution?.admissionCurrent() !== false &&
      scope?.current() !== false;
    if (
      (this.#options.resolveThread !== undefined && scope === undefined) ||
      !current() ||
      !(await this.#options.canAccessThread(windowId, command.threadId)) ||
      !current()
    ) {
      return { kind: "feedback-refused", reason: "thread-unavailable" };
    }
    const pending = this.#options
      .readNotes(command.threadId)
      .filter((note) => note.lifecycle === "pending");
    if (pending.length >= MAX_PENDING_PRODUCT_FEEDBACK_NOTES) {
      return { kind: "feedback-refused", reason: "note-limit-reached" };
    }

    const observed = await this.#options.browser
      .describePoint({
        windowId,
        threadId: command.threadId,
        contextId: command.contextId,
        point: command.point,
        current,
        ...(execution?.signal === undefined ? {} : { signal: execution.signal }),
      })
      .catch(() => ({ status: "unavailable" as const }));
    if (!current()) return { kind: "feedback-refused", reason: "thread-unavailable" };
    if (observed.status === "unavailable") {
      return { kind: "feedback-refused", reason: "surface-unavailable" };
    }
    if (observed.status === "no-element") {
      return { kind: "feedback-refused", reason: "element-unavailable" };
    }

    // A crop that cannot be stored costs the note its picture, never the note:
    // the words and the element identity are the point.
    let crop: ProductFeedbackCrop | undefined;
    if (observed.cropDataUrl !== undefined) {
      try {
        crop = this.#options.crops.put(observed.cropDataUrl);
      } catch {
        crop = undefined;
      }
    }

    const noteId = command.noteId ?? decodeProductFeedbackNoteId(this.#options.uuid());
    if (this.#options.readNote(noteId) !== undefined) {
      throw new ProductFeedbackError("conflict", "Product feedback note ID is already in use.");
    }
    const timestamp = decodeTimestamp(this.#options.clock());
    const note = decodeProductFeedbackNote({
      id: noteId,
      threadId: command.threadId,
      mode: scope?.mode ?? command.mode,
      comment: command.comment,
      element: {
        kind: "browser-element",
        selector: observed.element.selector,
        ...(observed.element.role === undefined ? {} : { role: observed.element.role }),
        ...(observed.element.accessibleName === undefined
          ? {}
          : { accessibleName: observed.element.accessibleName }),
        ...(observed.element.text === undefined ? {} : { text: observed.element.text }),
        ...(observed.url === undefined ? {} : { url: observed.url }),
        ...(observed.title === undefined ? {} : { title: observed.title }),
        bounds: observed.element.bounds,
        ...(observed.element.context === undefined ? {} : { context: observed.element.context }),
      },
      ...(crop === undefined ? {} : { crop }),
      provenance: productFeedbackProvenance({ surface: "browser" }),
      lifecycle: "pending",
      capturedAt: timestamp,
      version: 1,
      updatedAt: timestamp,
    });
    const ingested = this.#options.recordExternalContentIngestion?.({
      threadId: command.threadId,
      provenance: note.provenance.element,
      contentReference: String(note.id),
      correlationId: this.#options.uuid(),
      authorized: true,
    });
    if (ingested?.kind === "refused") {
      throw new ProductFeedbackError("invalid", "Product feedback capture is invalid.");
    }
    if (!current()) return { kind: "feedback-refused", reason: "thread-unavailable" };
    this.#append(note, 0, "feedback.note-captured@1", { kind: "feedback-captured", note });
    return { kind: "feedback-captured", note };
  }

  async #discard(
    windowId: WindowId,
    command: Extract<
      ReturnType<typeof decodeProductFeedbackCommand>,
      { kind: "discard-product-feedback" }
    >,
    execution?: ProductFeedbackExecutionContext,
  ): Promise<ProductFeedbackCommandResult> {
    const original = this.#options.readNote(command.noteId);
    const scope =
      original === undefined
        ? undefined
        : await this.#options.resolveThread?.(windowId, original.threadId);
    const admissionCurrent = () =>
      execution?.signal?.aborted !== true &&
      execution?.admissionCurrent() !== false &&
      scope?.current() !== false;
    if (!admissionCurrent() || (this.#options.resolveThread !== undefined && scope === undefined))
      return { kind: "feedback-refused", reason: "thread-unavailable" };
    const current = this.#options.readNote(command.noteId);
    if (
      current === undefined ||
      !(await this.#options.canAccessThread(windowId, current.threadId))
    ) {
      throw new ProductFeedbackError("invalid", "Product feedback note was not found.");
    }
    if (current.version !== command.expectedVersion) {
      throw new ProductFeedbackError("conflict", "Product feedback note has changed.");
    }
    const discarded = decodeProductFeedbackNote({
      ...current,
      lifecycle: "discarded",
      version: current.version + 1,
      updatedAt: decodeTimestamp(this.#options.clock()),
    });
    if (!admissionCurrent()) return { kind: "feedback-refused", reason: "thread-unavailable" };
    this.#append(discarded, current.version, "feedback.note-discarded@1", {
      kind: "feedback-discarded",
      note: discarded,
    });
    return { kind: "feedback-discarded", note: discarded };
  }

  /**
   * Hand a thread's waiting notes to the turn about to run, and record that
   * each one went. Call synchronously after the turn's final admission check:
   * refused preparation leaves notes pending, while an admitted or uncertain
   * delivery keeps its journaled claim so another turn cannot send it again.
   */
  deliver(input: {
    readonly threadId: string;
    readonly operationId: string;
    readonly selected?: ReadonlyArray<{ readonly noteId: string; readonly version: number }>;
  }): ReadonlyArray<ProductFeedbackNote> {
    const all = this.pendingForTurn(input.threadId);
    const selected = input.selected;
    if (
      selected !== undefined &&
      (selected.length > MAX_PENDING_PRODUCT_FEEDBACK_NOTES ||
        new Set(selected.map((ref) => ref.noteId)).size !== selected.length ||
        selected.some(
          (ref) => !all.some((note) => note.id === ref.noteId && note.version === ref.version),
        ))
    )
      return [];
    const pending =
      selected === undefined
        ? all
        : all.filter((note) => selected.some((ref) => ref.noteId === note.id));
    if (selected !== undefined && this.#options.transaction === undefined) return [];
    const claim = () => {
      const delivered: ProductFeedbackNote[] = [];
      for (const note of pending) {
        const timestamp = decodeTimestamp(this.#options.clock());
        const next = decodeProductFeedbackNote({
          ...note,
          lifecycle: "delivered",
          deliveredAt: timestamp,
          version: note.version + 1,
          updatedAt: timestamp,
        });
        try {
          this.#append(next, note.version, "feedback.note-delivered@1", {
            kind: "feedback-delivered",
            note: next,
            operationId: input.operationId,
          });
        } catch (error) {
          if (selected !== undefined) throw error;
          // A note the journal would not take is not carried. Losing it from this
          // turn is honest; sending it without recording that it went is not.
          continue;
        }
        delivered.push(next);
      }
      return delivered;
    };
    return selected !== undefined && this.#options.transaction !== undefined
      ? this.#options.transaction(claim)
      : claim();
  }

  /** Host-only preparation; reading does not claim or mark a note delivered. */
  pendingForTurn(threadId: string): ReadonlyArray<ProductFeedbackNote> {
    return this.#options
      .readNotes(threadId)
      .filter((note) => note.lifecycle === "pending" && note.included !== false);
  }

  /** The picture a note kept, when one was stored and is still there. */
  readCrop(note: ProductFeedbackNote): string | undefined {
    return note.crop === undefined ? undefined : this.#options.crops.read(note.crop);
  }

  #append(
    note: ProductFeedbackNote,
    expectedVersion: number,
    eventName: string,
    payload: unknown,
  ): void {
    this.#options.journal.append({
      aggregate: {
        aggregateType: "product-feedback-note",
        aggregateId: decodeAggregateId(String(note.id)),
      },
      expectedVersion: decodeAggregateVersion(expectedVersion),
      events: [
        {
          eventId: decodeEventId(this.#options.uuid()),
          eventName: decodeEventName(eventName),
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#options.uuid()),
          actor: this.#actor,
          occurredAt: decodeTimestamp(this.#options.clock()),
          payload,
        },
      ],
    });
  }
}
