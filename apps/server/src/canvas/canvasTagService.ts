import {
  AggregateId,
  CorrelationId,
  EventActor,
  EventId,
  CanvasTagAdded,
  CanvasTagRemoved,
  decodeCanvasId,
  decodeCanvasTagCommandResult,
  type CanvasId,
  type CanvasTagName,
  type CanvasTagCommandResult,
  type CanvasTagDenialCode,
  type CanvasTagEvent,
  type EventEnvelope,
  type UtcTimestamp,
} from "@octant/contracts";
import { CANVAS_TAG_ADDED, CANVAS_TAG_REMOVED } from "@octant/contracts/canvas-tags";
import {
  EMPTY_CANVAS_TAG_STATE,
  admitCanvasTagCommand,
  applyCanvasTagEvent,
  type CanvasTagState,
} from "@octant/domain";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { replayAggregateTypesInOrder } from "../persistence/journalHydration";
import { ConcurrencyConflict, DuplicateEventIdentity } from "../persistence/journalErrors";
import type { CanvasProjection, CanvasProjectionEntry } from "./canvasProjection";

export const CANVAS_TAG_AGGREGATE_TYPE = "canvas-tags";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

/** Register the Canvas tag journal frames so they can be appended and replayed. */
export function registerCanvasTagEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(CANVAS_TAG_ADDED, 1, CanvasTagAdded)
    .register(CANVAS_TAG_REMOVED, 1, CanvasTagRemoved);
}

type JournalPort = Pick<Journal, "append" | "replayAggregateType">;

export interface CanvasTagServiceOptions {
  readonly journal: JournalPort;
  readonly projection: Pick<CanvasProjection, "getById">;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
  readonly clock: () => UtcTimestamp;
}

export interface CanvasTagServiceDependencies {
  /**
   * Whether the Chat thread that owns a Project-less Canvas still holds it.
   * A tag is filed on a Canvas the person can still reach; a Canvas whose
   * thread is gone is not reachable and not taggable.
   */
  readonly threadHoldsCanvas: (entry: CanvasProjectionEntry) => boolean;
}

/**
 * Tags on a Canvas are journaled facts of one `canvas-tags` aggregate per
 * Canvas, beside the document: a tag never enters a Canvas version, so the
 * library's own facts never bump an artifact's `updatedAt` or mark outside
 * content. The service refuses a command from anywhere but a window on this
 * host; a paired device reads a listing's tags and changes none. The journal
 * stays the only source of truth, replayed through the same pure reducer.
 */
export class CanvasTagService {
  readonly #journal: JournalPort;
  readonly #projection: Pick<CanvasProjection, "getById">;
  readonly #uuid: () => string;
  readonly #actor: ReturnType<typeof decodeActor>;
  readonly #clock: () => UtcTimestamp;
  readonly #threadHoldsCanvas: CanvasTagServiceDependencies["threadHoldsCanvas"];
  readonly #state = new Map<string, CanvasTagState>();
  #replayed = false;

  constructor(options: CanvasTagServiceOptions, dependencies: CanvasTagServiceDependencies) {
    this.#journal = options.journal;
    this.#projection = options.projection;
    this.#uuid = options.uuid;
    this.#actor = decodeActor(options.actor);
    this.#clock = options.clock;
    this.#threadHoldsCanvas = dependencies.threadHoldsCanvas;
  }

  /** The tags one Canvas carries, as the library lists them. */
  tags(canvasId: CanvasId): ReadonlyArray<CanvasTagName> {
    return this.#stateFor(canvasId).tags;
  }

  /**
   * Admit and journal one tag command. `caller` is where the transport
   * authenticated the request from, never a field the request carries.
   */
  change(requestInput: unknown, caller: "local-window" | "remote-device"): CanvasTagCommandResult {
    if (caller !== "local-window") {
      return denied("unauthorized", "Tags can be changed from a window on this computer only.");
    }
    let canvasId: CanvasId;
    try {
      canvasId = decodeCanvasId((requestInput as { canvasId?: unknown } | null)?.canvasId);
    } catch {
      return denied("malformed-request", "Canvas tag command is malformed.");
    }
    const entry = this.#projection.getById(canvasId);
    if (entry === undefined) {
      return denied("unavailable", "Canvas is unavailable. Reopen it from the library.");
    }
    if (
      entry.currentVersion.definition.provenance.projectId === null &&
      !this.#threadHoldsCanvas(entry)
    ) {
      return denied("unavailable", "Canvas is unavailable. Reopen it from its thread.");
    }
    const state = this.#stateFor(canvasId);
    const admitted = admitCanvasTagCommand(withHostStamp(requestInput, this.#clock()), state);
    if (admitted.kind === "rejected") {
      return denied(admitted.code, admitted.message);
    }
    const event = toTagEvent(admitted.event);
    try {
      this.#append(canvasId, state, event);
    } catch (error) {
      if (error instanceof ConcurrencyConflict || error instanceof DuplicateEventIdentity) {
        return denied("stale-version", "Canvas tags changed on the host; try again.");
      }
      throw error;
    }
    const next = applyCanvasTagEvent(state, event);
    this.#state.set(String(canvasId), next);
    return decodeCanvasTagCommandResult({
      kind: "accepted",
      canvasId,
      sequence: next.sequence,
      tags: [...next.tags],
    });
  }

  #append(canvasId: CanvasId, state: CanvasTagState, event: CanvasTagEvent): void {
    this.#journal.append({
      aggregate: {
        aggregateType: CANVAS_TAG_AGGREGATE_TYPE,
        aggregateId: decodeAggregateId(String(canvasId)),
      },
      expectedVersion: state.sequence,
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: event.kind === "added" ? CANVAS_TAG_ADDED : CANVAS_TAG_REMOVED,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: this.#actor,
          occurredAt: occurredAtOf(event),
          payload: event.event,
        },
      ],
    });
  }

  #stateFor(canvasId: CanvasId): CanvasTagState {
    if (!this.#replayed) this.#replay();
    return this.#state.get(String(canvasId)) ?? EMPTY_CANVAS_TAG_STATE;
  }

  #replay(): void {
    this.#replayed = true;
    for (const envelope of replayAggregateTypesInOrder(this.#journal, [
      CANVAS_TAG_AGGREGATE_TYPE,
    ])) {
      const event = eventFromEnvelope(envelope);
      if (event === undefined) continue;
      const key = String(event.event.canvasId);
      this.#state.set(
        key,
        applyCanvasTagEvent(this.#state.get(key) ?? EMPTY_CANVAS_TAG_STATE, event),
      );
    }
  }
}

function eventFromEnvelope(envelope: EventEnvelope): CanvasTagEvent | undefined {
  try {
    if (envelope.eventName === CANVAS_TAG_ADDED) {
      return { kind: "added", event: decodeAdded(envelope.payload) };
    }
    if (envelope.eventName === CANVAS_TAG_REMOVED) {
      return { kind: "removed", event: decodeRemoved(envelope.payload) };
    }
    return undefined;
  } catch {
    // An undecodable frame is skipped rather than repaired into a tag the
    // policy never admitted; the journal stays authoritative.
    return undefined;
  }
}

function occurredAtOf(event: CanvasTagEvent): UtcTimestamp {
  return event.kind === "added" ? event.event.addedAt : event.event.removedAt;
}

type AdmittedEvent = Extract<
  ReturnType<typeof admitCanvasTagCommand>,
  { readonly kind: "accepted" }
>["event"];

function toTagEvent(event: AdmittedEvent): CanvasTagEvent {
  return "addedAt" in event ? { kind: "added", event } : { kind: "removed", event };
}

const decodeAdded = Schema.decodeUnknownSync(CanvasTagAdded);
const decodeRemoved = Schema.decodeUnknownSync(CanvasTagRemoved);

/**
 * The event's timestamp is the host's own clock, never a field the client
 * wrote: a tag is a fact of this host, and a client's clock is not authority
 * for when the person filed it.
 */
function withHostStamp(requestInput: unknown, now: UtcTimestamp): unknown {
  if (typeof requestInput !== "object" || requestInput === null) return requestInput;
  return { ...requestInput, issuedAt: now };
}

function denied(code: CanvasTagDenialCode, message: string): CanvasTagCommandResult {
  return decodeCanvasTagCommandResult({ kind: "denied", denialCode: code, message });
}
