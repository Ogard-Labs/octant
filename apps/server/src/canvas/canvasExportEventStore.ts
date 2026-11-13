import {
  AggregateId,
  CanvasExportIntentRecorded,
  CanvasExportNoticeDismissed,
  CanvasExportRecorded,
  CorrelationId,
  EventActor,
  EventId,
  decodeCanvasExportIntentRecorded,
  decodeCanvasExportNoticeDismissed,
  decodeCanvasExportRecorded,
  type CanvasExportIntentRecorded as CanvasExportIntent,
  type CanvasExportNoticeDismissed as CanvasExportDismissal,
  type CanvasExportRecorded as CanvasExportRecord,
  type EventEnvelope,
  type UtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { replayAggregateTypesInOrder } from "../persistence/journalHydration";
import { ConcurrencyConflict, DuplicateEventIdentity } from "../persistence/journalErrors";

export const CANVAS_EXPORT_AGGREGATE_TYPE = "canvas-export";
export const CANVAS_EXPORT_RECORDED = "canvas.export@1";
export const CANVAS_EXPORT_INTENT_RECORDED = "canvas.export-intent@1";
export const CANVAS_EXPORT_NOTICE_DISMISSED = "canvas.export-notice-dismissed@1";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

/** Register the Canvas export journal frame so it can be appended and replayed. */
export function registerCanvasExportEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(CANVAS_EXPORT_RECORDED, 1, CanvasExportRecorded)
    .register(CANVAS_EXPORT_INTENT_RECORDED, 1, CanvasExportIntentRecorded)
    .register(CANVAS_EXPORT_NOTICE_DISMISSED, 1, CanvasExportNoticeDismissed);
}

export class CanvasExportEventStoreError extends Error {
  override readonly name = "CanvasExportEventStoreError";
  readonly category: "invalid" | "journal-mismatch";

  constructor(category: CanvasExportEventStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

type JournalPort = Pick<Journal, "append" | "replayAggregateType">;

export interface CanvasExportEventStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
}

/**
 * One export is one `canvas-export` aggregate: its intent at version 1,
 * journaled before the destination is called, then its outcome at version 2,
 * and, for an unconfirmed export the person dismissed, that dismissal at 3.
 * Exports journaled before intents existed hold only the outcome at version 1.
 * Replay rebuilds both from the journal alone, in commit order.
 * The actor is supplied per append, derived from the authenticated transport
 * principal, so a remote approval never replays as a local one.
 */
export class CanvasExportEventStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;

  constructor(options: CanvasExportEventStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
  }

  /** Journal the approved export before its destination is called. */
  recordIntent(input: {
    readonly intent: CanvasExportIntent;
    readonly occurredAt: UtcTimestamp;
    readonly actor: typeof EventActor.Type;
  }): EventEnvelope {
    const payload = decodeCanvasExportIntentRecorded(input.intent);
    return this.#appendAt(payload.exportId, 0, CANVAS_EXPORT_INTENT_RECORDED, payload, input);
  }

  /** Journal the outcome of an export whose intent is already recorded. */
  append(input: {
    readonly record: CanvasExportRecord;
    readonly occurredAt: UtcTimestamp;
    readonly actor: typeof EventActor.Type;
  }): EventEnvelope {
    const payload = decodeCanvasExportRecorded(input.record);
    return this.#appendAt(payload.exportId, 1, CANVAS_EXPORT_RECORDED, payload, input);
  }

  /**
   * Journal the person's dismissal of a settled unconfirmed export. Expecting
   * version 2 refuses an export whose outcome was never journaled, and a
   * second dismissal of the same export.
   */
  appendNoticeDismissed(input: {
    readonly dismissal: CanvasExportDismissal;
    readonly occurredAt: UtcTimestamp;
    readonly actor: typeof EventActor.Type;
  }): EventEnvelope {
    const payload = decodeCanvasExportNoticeDismissed(input.dismissal);
    return this.#appendAt(payload.exportId, 2, CANVAS_EXPORT_NOTICE_DISMISSED, payload, input);
  }

  #appendAt(
    exportId: string,
    expectedVersion: 0 | 1 | 2,
    eventName:
      | typeof CANVAS_EXPORT_RECORDED
      | typeof CANVAS_EXPORT_INTENT_RECORDED
      | typeof CANVAS_EXPORT_NOTICE_DISMISSED,
    payload: CanvasExportRecord | CanvasExportIntent | CanvasExportDismissal,
    input: { readonly occurredAt: UtcTimestamp; readonly actor: typeof EventActor.Type },
  ): EventEnvelope {
    let actor: typeof EventActor.Type;
    try {
      actor = decodeActor(input.actor);
    } catch {
      throw new CanvasExportEventStoreError("invalid", "Canvas export event actor is invalid.");
    }
    const aggregateId = decodeAggregateId(exportId);
    const eventId = decodeEventId(this.#uuid());
    const correlationId = decodeCorrelationId(this.#uuid());
    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: CANVAS_EXPORT_AGGREGATE_TYPE, aggregateId },
        expectedVersion,
        events: [
          {
            eventId,
            eventName,
            eventVersion: 1,
            correlationId,
            actor,
            occurredAt: input.occurredAt,
            payload,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict || error instanceof DuplicateEventIdentity) {
        throw new CanvasExportEventStoreError(
          "invalid",
          "Canvas export does not match the current journal head.",
        );
      }
      throw error;
    }
    const envelope = committed.events[0];
    if (
      envelope === undefined ||
      envelope.aggregateType !== CANVAS_EXPORT_AGGREGATE_TYPE ||
      envelope.aggregateId !== aggregateId ||
      envelope.aggregateVersion !== expectedVersion + 1 ||
      envelope.eventName !== eventName
    ) {
      throw new CanvasExportEventStoreError(
        "journal-mismatch",
        "Committed canvas export event does not match its append.",
      );
    }
    return envelope;
  }

  /** Rebuild completed exports from the journal, in commit order. */
  replay(): ReadonlyArray<CanvasExportRecord> {
    return this.replayAll().records;
  }

  /**
   * Rebuild completed exports and the intents that never reached an outcome.
   * An undecodable frame is skipped rather than repaired into an export that
   * was never admitted.
   */
  replayAll(): {
    readonly records: ReadonlyArray<CanvasExportRecord>;
    readonly unsettled: ReadonlyArray<CanvasExportIntent>;
    readonly dismissed: ReadonlySet<string>;
  } {
    const dismissed = new Set<string>();
    const records: CanvasExportRecord[] = [];
    const intents = new Map<string, CanvasExportIntent>();
    for (const envelope of replayAggregateTypesInOrder(this.#journal, [
      CANVAS_EXPORT_AGGREGATE_TYPE,
    ])) {
      try {
        if (envelope.eventName === CANVAS_EXPORT_INTENT_RECORDED) {
          const intent = decodeCanvasExportIntentRecorded(envelope.payload);
          intents.set(String(intent.exportId), intent);
        } else if (envelope.eventName === CANVAS_EXPORT_RECORDED) {
          const record = decodeCanvasExportRecorded(envelope.payload);
          intents.delete(String(record.exportId));
          records.push(record);
        } else if (envelope.eventName === CANVAS_EXPORT_NOTICE_DISMISSED) {
          dismissed.add(String(decodeCanvasExportNoticeDismissed(envelope.payload).exportId));
        }
      } catch {
        // The journal remains authoritative; a frame that no longer decodes
        // is not rewritten into a different export.
      }
    }
    return { records, unsettled: [...intents.values()], dismissed };
  }
}
