import {
  AggregateId,
  CanvasShareAccessLogged,
  CanvasShareSnapshotCreated,
  CanvasShareSnapshotRevoked,
  CorrelationId,
  EventActor,
  EventId,
  ReplayCursor,
  decodeCanvasShareAccessLogged,
  decodeCanvasShareSnapshotCreated,
  decodeCanvasShareSnapshotRecord,
  decodeCanvasShareSnapshotRevoked,
  type CanvasShareAccessLogEvent,
  type CanvasShareSnapshotRecord,
  type EventEnvelope,
  type UtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict, DuplicateEventIdentity } from "../persistence/journalErrors";

export const CANVAS_SHARE_AGGREGATE_TYPE = "canvas-share";
export const CANVAS_SHARE_SNAPSHOT_CREATED = "canvas.share-snapshot-created@1";
export const CANVAS_SHARE_SNAPSHOT_REVOKED = "canvas.share-snapshot-revoked@1";
export const CANVAS_SHARE_ACCESS_AGGREGATE_TYPE = "canvas-share-access";
export const CANVAS_SHARE_ACCESS_LOGGED = "canvas.share-access-logged@1";

const JOURNAL_REPLAY_BATCH_SIZE = 1_000;

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);

/** Register the Canvas share journal frames so they can be appended and replayed. */
export function registerCanvasShareEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(CANVAS_SHARE_SNAPSHOT_CREATED, 1, CanvasShareSnapshotCreated)
    .register(CANVAS_SHARE_SNAPSHOT_REVOKED, 1, CanvasShareSnapshotRevoked)
    .register(CANVAS_SHARE_ACCESS_LOGGED, 1, CanvasShareAccessLogged);
}

export class CanvasShareEventStoreError extends Error {
  override readonly name = "CanvasShareEventStoreError";
  readonly category: "invalid" | "journal-mismatch";

  constructor(category: CanvasShareEventStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

type JournalPort = Pick<Journal, "append" | "replay">;

export interface CanvasShareEventStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
}

export interface CanvasShareReplay {
  /** Snapshot lifecycle rebuilt in journal order; revocations already applied. */
  readonly records: ReadonlyArray<CanvasShareSnapshotRecord>;
  readonly accessEvents: ReadonlyArray<CanvasShareAccessLogEvent>;
}

/**
 * Server-authoritative Canvas share event store.
 *
 * One snapshot is one `canvas-share` aggregate: create is version 1 and the
 * owner's revocation is version 2, so a second revoke of the same snapshot
 * conflicts on the journal rather than appending a second truth. Each evaluated
 * access attempt is its own `canvas-share-access` aggregate keyed by its event
 * id, which keeps the auditable log append-only and independent of snapshot
 * lifecycle ordering. Replay rebuilds both from the journal alone.
 */
export class CanvasShareEventStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;

  constructor(options: CanvasShareEventStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    try {
      this.#actor = decodeActor(options.actor);
    } catch {
      throw new CanvasShareEventStoreError("invalid", "Canvas share event actor is invalid.");
    }
  }

  appendSnapshotCreated(input: {
    readonly record: CanvasShareSnapshotRecord;
    readonly occurredAt: UtcTimestamp;
  }): EventEnvelope {
    const payload = decodeCanvasShareSnapshotCreated({ record: input.record });
    const aggregateId = decodeAggregateId(payload.record.snapshotId);
    return this.#append({
      aggregateType: CANVAS_SHARE_AGGREGATE_TYPE,
      aggregateId,
      expectedVersion: 0,
      committedVersion: 1,
      eventName: CANVAS_SHARE_SNAPSHOT_CREATED,
      occurredAt: input.occurredAt,
      payload,
      label: "Canvas share snapshot create",
    });
  }

  appendSnapshotRevoked(input: {
    /** Decoded against the revoked frame contract before it is journaled. */
    readonly revocation: unknown;
    readonly occurredAt: UtcTimestamp;
  }): EventEnvelope {
    const payload = decodeCanvasShareSnapshotRevoked(input.revocation);
    const aggregateId = decodeAggregateId(payload.snapshotId);
    return this.#append({
      aggregateType: CANVAS_SHARE_AGGREGATE_TYPE,
      aggregateId,
      expectedVersion: 1,
      committedVersion: 2,
      eventName: CANVAS_SHARE_SNAPSHOT_REVOKED,
      occurredAt: input.occurredAt,
      payload,
      label: "Canvas share snapshot revoke",
    });
  }

  appendAccessLogged(input: {
    readonly event: CanvasShareAccessLogEvent;
    readonly occurredAt: UtcTimestamp;
  }): EventEnvelope {
    const payload = decodeCanvasShareAccessLogged({ event: input.event });
    const aggregateId = decodeAggregateId(payload.event.eventId);
    return this.#append({
      aggregateType: CANVAS_SHARE_ACCESS_AGGREGATE_TYPE,
      aggregateId,
      expectedVersion: 0,
      committedVersion: 1,
      eventName: CANVAS_SHARE_ACCESS_LOGGED,
      occurredAt: input.occurredAt,
      payload,
      label: "Canvas share access log",
    });
  }

  /**
   * Rebuild share state from the journal. Replay is idempotent: applying the
   * same frames again yields the same records, and an undecodable frame is
   * skipped rather than silently repaired into a share that was never admitted.
   */
  replay(): CanvasShareReplay {
    const records = new Map<string, CanvasShareSnapshotRecord>();
    const accessEvents: CanvasShareAccessLogEvent[] = [];
    let afterSequence = 0;
    while (true) {
      const batch = this.#journal.replay(
        decodeReplayCursor({ afterSequence, limit: JOURNAL_REPLAY_BATCH_SIZE }),
      );
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        try {
          if (envelope.eventName === CANVAS_SHARE_SNAPSHOT_CREATED) {
            const record = decodeCanvasShareSnapshotCreated(envelope.payload).record;
            records.set(String(record.snapshotId), record);
            continue;
          }
          if (envelope.eventName === CANVAS_SHARE_SNAPSHOT_REVOKED) {
            const revocation = decodeCanvasShareSnapshotRevoked(envelope.payload);
            const record = records.get(String(revocation.snapshotId));
            // A revocation without its created frame revokes nothing: the shared
            // document only ever enters state through an admitted create.
            if (record === undefined) continue;
            records.set(
              String(revocation.snapshotId),
              decodeCanvasShareSnapshotRecord({
                ...record,
                status: "revoked",
                revokedAt: revocation.revokedAt,
              }),
            );
            continue;
          }
          if (envelope.eventName === CANVAS_SHARE_ACCESS_LOGGED) {
            accessEvents.push(decodeCanvasShareAccessLogged(envelope.payload).event);
          }
        } catch {
          // Ignore undecodable frames; the journal remains authoritative.
        }
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
    return { records: [...records.values()], accessEvents };
  }

  #append(input: {
    readonly aggregateType: string;
    readonly aggregateId: typeof AggregateId.Type;
    readonly expectedVersion: number;
    readonly committedVersion: number;
    readonly eventName: string;
    readonly occurredAt: UtcTimestamp;
    readonly payload: unknown;
    readonly label: string;
  }): EventEnvelope {
    const eventId = decodeEventId(this.#uuid());
    const correlationId = decodeCorrelationId(this.#uuid());
    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: input.aggregateType, aggregateId: input.aggregateId },
        expectedVersion: input.expectedVersion,
        events: [
          {
            eventId,
            eventName: input.eventName,
            eventVersion: 1,
            correlationId,
            actor: this.#actor,
            occurredAt: input.occurredAt,
            payload: input.payload,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new CanvasShareEventStoreError(
          "invalid",
          `${input.label} does not match the current share head.`,
        );
      }
      if (error instanceof DuplicateEventIdentity) {
        throw new CanvasShareEventStoreError(
          "invalid",
          `${input.label} identity is already committed.`,
        );
      }
      throw error;
    }
    const envelope = committed.events[0];
    if (
      envelope === undefined ||
      envelope.aggregateType !== input.aggregateType ||
      envelope.aggregateId !== input.aggregateId ||
      envelope.aggregateVersion !== input.committedVersion ||
      envelope.eventName !== input.eventName ||
      envelope.eventVersion !== 1
    ) {
      throw new CanvasShareEventStoreError(
        "journal-mismatch",
        `Committed ${input.label} event does not match its append.`,
      );
    }
    return envelope;
  }
}
