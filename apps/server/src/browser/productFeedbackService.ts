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

  constructor(options: ProductFeedbackServiceOptions) {
    this.#options = options;
    const actor = decodeActor(options.actor);
    decodeActorId(actor.actorId);
    this.#actor = actor;
  }

  async list(windowId: WindowId, threadId: string): Promise<ReadonlyArray<ProductFeedbackNote>> {
    if (!(await this.#options.canAccessThread(windowId, threadId))) return [];
    return this.#options.readNotes(threadId);
  }

  async execute(windowId: WindowId, input: unknown): Promise<ProductFeedbackCommandResult> {
    let command;
    try {
      command = decodeProductFeedbackCommand(input);
    } catch {
      throw new ProductFeedbackError("invalid", "Product feedback command is invalid.");
    }
    if (command.kind === "discard-product-feedback") return this.#discard(windowId, command);
    return this.#capture(windowId, command);
  }

  async #capture(
    windowId: WindowId,
    command: Extract<
      ReturnType<typeof decodeProductFeedbackCommand>,
      { kind: "capture-product-feedback" }
    >,
  ): Promise<ProductFeedbackCommandResult> {
    if (!(await this.#options.canAccessThread(windowId, command.threadId))) {
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
      })
      .catch(() => ({ status: "unavailable" as const }));
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
      mode: command.mode,
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
    this.#append(note, 0, "feedback.note-captured@1", { kind: "feedback-captured", note });
    return { kind: "feedback-captured", note };
  }

  async #discard(
    windowId: WindowId,
    command: Extract<
      ReturnType<typeof decodeProductFeedbackCommand>,
      { kind: "discard-product-feedback" }
    >,
  ): Promise<ProductFeedbackCommandResult> {
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
    this.#append(discarded, current.version, "feedback.note-discarded@1", {
      kind: "feedback-discarded",
      note: discarded,
    });
    return { kind: "feedback-discarded", note: discarded };
  }

  /**
   * Hand a thread's waiting notes to the turn about to run, and record that
   * each one went. A note is carried exactly once: marking it delivered is the
   * same journal write the turn's identity is recorded in, so a note cannot be
   * silently sent twice or lost between two turns.
   */
  deliver(input: {
    readonly threadId: string;
    readonly operationId: string;
  }): ReadonlyArray<ProductFeedbackNote> {
    const pending = this.#options
      .readNotes(input.threadId)
      .filter((note) => note.lifecycle === "pending");
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
      } catch {
        // A note the journal would not take is not carried. Losing it from this
        // turn is honest; sending it without recording that it went is not.
        continue;
      }
      delivered.push(next);
    }
    return delivered;
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
