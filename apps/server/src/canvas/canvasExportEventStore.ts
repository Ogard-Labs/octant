import {
  AggregateId,
  CanvasExportRecorded,
  CorrelationId,
  EventActor,
  EventId,
  ReplayCursor,
  decodeCanvasExportRecorded,
  type CanvasExportRecorded as CanvasExportRecord,
  type EventEnvelope,
  type UtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict, DuplicateEventIdentity } from "../persistence/journalErrors";

export const CANVAS_EXPORT_AGGREGATE_TYPE = "canvas-export";
export const CANVAS_EXPORT_RECORDED = "canvas.export@1";

const JOURNAL_REPLAY_BATCH_SIZE = 1_000;

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);

/** Register the Canvas export journal frame so it can be appended and replayed. */
export function registerCanvasExportEvents(registry: EventRegistry): EventRegistry {
  return registry.register(CANVAS_EXPORT_RECORDED, 1, CanvasExportRecorded);
}

export class CanvasExportEventStoreError extends Error {
  override readonly name = "CanvasExportEventStoreError";
  readonly category: "invalid" | "journal-mismatch";

  constructor(category: CanvasExportEventStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

type JournalPort = Pick<Journal, "append" | "replay">;

export interface CanvasExportEventStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
}

/**
 * One completed export is one `canvas-export` aggregate at version 1.
 * Replay rebuilds the records from the journal alone, in commit order.
 */
export class CanvasExportEventStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;

  constructor(options: CanvasExportEventStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    try {
      this.#actor = decodeActor(options.actor);
    } catch {
      throw new CanvasExportEventStoreError("invalid", "Canvas export event actor is invalid.");
    }
  }

  append(input: {
    readonly record: CanvasExportRecord;
    readonly occurredAt: UtcTimestamp;
  }): EventEnvelope {
    const payload = decodeCanvasExportRecorded(input.record);
    const aggregateId = decodeAggregateId(payload.exportId);
    const eventId = decodeEventId(this.#uuid());
    const correlationId = decodeCorrelationId(this.#uuid());
    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: CANVAS_EXPORT_AGGREGATE_TYPE, aggregateId },
        expectedVersion: 0,
        events: [
          {
            eventId,
            eventName: CANVAS_EXPORT_RECORDED,
            eventVersion: 1,
            correlationId,
            actor: this.#actor,
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
      envelope.aggregateVersion !== 1 ||
      envelope.eventName !== CANVAS_EXPORT_RECORDED
    ) {
      throw new CanvasExportEventStoreError(
        "journal-mismatch",
        "Committed canvas export event does not match its append.",
      );
    }
    return envelope;
  }

  /**
   * Rebuild completed exports from the journal. An undecodable frame is skipped
   * rather than repaired into an export that was never admitted.
   */
  replay(): ReadonlyArray<CanvasExportRecord> {
    const records: CanvasExportRecord[] = [];
    let afterSequence = 0;
    while (true) {
      const batch = this.#journal.replay(
        decodeReplayCursor({ afterSequence, limit: JOURNAL_REPLAY_BATCH_SIZE }),
      );
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        if (envelope.eventName !== CANVAS_EXPORT_RECORDED) continue;
        try {
          records.push(decodeCanvasExportRecorded(envelope.payload));
        } catch {
          // The journal remains authoritative; a frame that no longer decodes
          // is not rewritten into a different export.
        }
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
    return records;
  }
}
