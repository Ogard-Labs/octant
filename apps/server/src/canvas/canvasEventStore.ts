import {
  AggregateId,
  AggregateVersion,
  CANVAS_AGGREGATE_TYPE,
  CANVAS_CREATED,
  CANVAS_VERSION_APPENDED,
  decodeCanvasActionReceiptRecorded,
  decodeCanvasRefreshReceiptRecorded,
  decodeCanvasRefreshReceipt,
  CorrelationId,
  EventActor,
  EventId,
  ReplayCursor,
  decodeCanvasCreated,
  decodeCanvasId,
  decodeCanvasVersion,
  decodeCanvasVersionAppended,
  type CanvasActionReceipt,
  type CanvasCreated,
  type CanvasRefreshReceipt,
  type CanvasId,
  type CanvasVersion,
  type CanvasVersionAppended,
  type EventEnvelope,
  type UtcTimestamp,
} from "@octant/contracts";
import { assertCanvasCreate, assertCanvasVersionAppend } from "@octant/domain";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict, DuplicateEventIdentity } from "../persistence/journalErrors";

export { CANVAS_AGGREGATE_TYPE, CANVAS_CREATED, CANVAS_VERSION_APPENDED };
export const MAX_CANVAS_REPLAY_LIMIT = 256;
export const CANVAS_REFRESH_RECEIPT_RECORDED = "canvas.refresh-receipt-recorded@1";
export const CANVAS_REFRESH_AGGREGATE_TYPE = "canvas-refresh";
export const CANVAS_ACTION_RECEIPT_RECORDED = "canvas.action-receipt-recorded@1";
export const CANVAS_ACTION_AGGREGATE_TYPE = "canvas-action";
const JOURNAL_REPLAY_BATCH_SIZE = 1_000;
const MAX_JOURNAL_SCAN_EVENTS = 100_000;

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);

type JournalPort = Pick<Journal, "append" | "replay">;

export class CanvasEventStoreError extends Error {
  override readonly name = "CanvasEventStoreError";
  readonly category: "invalid" | "journal-mismatch";

  constructor(category: CanvasEventStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface CanvasEventStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
}

export interface AppendCanvasCreateInput {
  readonly canvasId: CanvasId;
  readonly version: CanvasVersion;
  readonly occurredAt: UtcTimestamp;
}

export interface AppendCanvasVersionInput {
  readonly canvasId: CanvasId;
  readonly current: CanvasVersion;
  readonly next: CanvasVersion;
  readonly occurredAt: UtcTimestamp;
  readonly refreshReceipt?: CanvasRefreshReceipt;
}

export interface AppendCanvasRefreshReceiptInput {
  readonly receipt: CanvasRefreshReceipt;
  readonly occurredAt: UtcTimestamp;
}

export interface AppendCanvasActionReceiptInput {
  readonly receipt: CanvasActionReceipt;
  readonly occurredAt: UtcTimestamp;
}

export interface ReplayCanvasInput {
  readonly canvasId: CanvasId;
  readonly afterVersion: number;
  readonly limit: number;
}

export type CanvasReplay =
  | {
      readonly status: "ok";
      readonly events: ReadonlyArray<EventEnvelope>;
      readonly nextCursor: number;
    }
  | {
      readonly status: "snapshot-required";
      readonly reason:
        | "gap"
        | "identity-mismatch"
        | "invalid-frame"
        | "cursor-ahead"
        | "scan-limit";
    };

/**
 * Server-authoritative Canvas event store. Appends Canvas create/version
 * lifecycle events to the journal with optimistic concurrency on the Canvas
 * aggregate version (which equals the version sequence). Replay rebuilds
 * Canvas history for projection catch-up after reconnect/restart and reports
 * gaps or identity mismatch rather than silently repairing them.
 */
export class CanvasEventStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;

  constructor(options: CanvasEventStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    try {
      this.#actor = decodeActor(options.actor);
    } catch {
      throw new CanvasEventStoreError("invalid", "Canvas event actor is invalid.");
    }
  }

  appendCreate(input: AppendCanvasCreateInput): EventEnvelope {
    let canvasId: CanvasId;
    let aggregateId: typeof AggregateId.Type;
    let eventId: typeof EventId.Type;
    let correlationId: typeof CorrelationId.Type;
    let payload: CanvasCreated;
    let version: CanvasVersion;
    try {
      canvasId = decodeCanvasId(input.canvasId);
      version = assertCanvasCreate(canvasId, input.version);
      aggregateId = decodeAggregateId(canvasId);
      eventId = decodeEventId(this.#uuid());
      correlationId = decodeCorrelationId(this.#uuid());
      payload = decodeCanvasCreated({ canvasId, version });
    } catch {
      throw new CanvasEventStoreError("invalid", "Canvas create append is invalid.");
    }

    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: CANVAS_AGGREGATE_TYPE, aggregateId },
        expectedVersion: 0,
        events: [
          {
            eventId,
            eventName: CANVAS_CREATED,
            eventVersion: 1,
            correlationId,
            actor: this.#actor,
            occurredAt: input.occurredAt,
            payload,
          },
        ],
      });
    } catch (error) {
      throw this.#wrapConcurrency(error);
    }

    return this.#assertCommitted(
      committed.events[0],
      aggregateId,
      version.sequence,
      CANVAS_CREATED,
      "Canvas create",
    );
  }

  appendVersion(input: AppendCanvasVersionInput): EventEnvelope {
    let canvasId: CanvasId;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    let eventId: typeof EventId.Type;
    let correlationId: typeof CorrelationId.Type;
    let payload: CanvasVersionAppended;
    let next: CanvasVersion;
    try {
      canvasId = decodeCanvasId(input.canvasId);
      next = assertCanvasVersionAppend(canvasId, input.current, input.next);
      expectedVersion = decodeAggregateVersion(input.current.sequence);
      aggregateId = decodeAggregateId(canvasId);
      eventId = decodeEventId(this.#uuid());
      correlationId = decodeCorrelationId(this.#uuid());
      payload = decodeCanvasVersionAppended({
        canvasId,
        version: next,
        ...(input.refreshReceipt === undefined ? {} : { refreshReceipt: input.refreshReceipt }),
      });
      if (next.sequence !== expectedVersion + 1) {
        throw new Error("version sequence must be one greater than expected head");
      }
    } catch {
      throw new CanvasEventStoreError("invalid", "Canvas version append is invalid.");
    }

    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: CANVAS_AGGREGATE_TYPE, aggregateId },
        expectedVersion,
        events: [
          {
            eventId,
            eventName: CANVAS_VERSION_APPENDED,
            eventVersion: 1,
            correlationId,
            actor: this.#actor,
            occurredAt: input.occurredAt,
            payload,
          },
        ],
      });
    } catch (error) {
      throw this.#wrapConcurrency(error);
    }

    return this.#assertCommitted(
      committed.events[0],
      aggregateId,
      next.sequence,
      CANVAS_VERSION_APPENDED,
      "Canvas version append",
    );
  }

  appendRefreshReceipt(input: AppendCanvasRefreshReceiptInput): EventEnvelope {
    const receipt = decodeCanvasRefreshReceiptRecorded({ receipt: input.receipt }).receipt;
    const aggregateId = decodeAggregateId(receipt.requestId);
    const eventId = decodeEventId(this.#uuid());
    const correlationId = decodeCorrelationId(this.#uuid());
    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: CANVAS_REFRESH_AGGREGATE_TYPE, aggregateId },
        expectedVersion: 0,
        events: [
          {
            eventId,
            eventName: CANVAS_REFRESH_RECEIPT_RECORDED,
            eventVersion: 1,
            correlationId,
            actor: this.#actor,
            occurredAt: input.occurredAt,
            payload: { receipt },
          },
        ],
      });
    } catch (error) {
      throw this.#wrapConcurrency(error);
    }
    return this.#assertCommitted(
      committed.events[0],
      aggregateId,
      1,
      CANVAS_REFRESH_RECEIPT_RECORDED,
      "Canvas refresh receipt",
      CANVAS_REFRESH_AGGREGATE_TYPE,
    );
  }

  appendActionReceipt(input: AppendCanvasActionReceiptInput): EventEnvelope {
    const receipt = decodeCanvasActionReceiptRecorded({ receipt: input.receipt }).receipt;
    const aggregateId = decodeAggregateId(receipt.requestId);
    const eventId = decodeEventId(this.#uuid());
    const correlationId = decodeCorrelationId(this.#uuid());
    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: CANVAS_ACTION_AGGREGATE_TYPE, aggregateId },
        expectedVersion: 0,
        events: [
          {
            eventId,
            eventName: CANVAS_ACTION_RECEIPT_RECORDED,
            eventVersion: 1,
            correlationId,
            actor: this.#actor,
            occurredAt: input.occurredAt,
            payload: { receipt },
          },
        ],
      });
    } catch (error) {
      throw this.#wrapConcurrency(error);
    }
    return this.#assertCommitted(
      committed.events[0],
      aggregateId,
      1,
      CANVAS_ACTION_RECEIPT_RECORDED,
      "Canvas action receipt",
      CANVAS_ACTION_AGGREGATE_TYPE,
    );
  }

  replayActionReceipts(): ReadonlyArray<CanvasActionReceipt> {
    const receipts: CanvasActionReceipt[] = [];
    let afterSequence = 0;
    while (true) {
      const batch = this.#journal.replay(
        decodeReplayCursor({ afterSequence, limit: JOURNAL_REPLAY_BATCH_SIZE }),
      );
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        if (envelope.eventName !== CANVAS_ACTION_RECEIPT_RECORDED) continue;
        try {
          receipts.push(decodeCanvasActionReceiptRecorded(envelope.payload).receipt);
        } catch {
          // Ignore malformed cache entries; lifecycle state remains journaled.
        }
      }
    }
    return receipts;
  }

  replayRefreshReceipts(): ReadonlyArray<CanvasRefreshReceipt> {
    const receipts: CanvasRefreshReceipt[] = [];
    let afterSequence = 0;
    while (true) {
      const batch = this.#journal.replay(
        decodeReplayCursor({ afterSequence, limit: JOURNAL_REPLAY_BATCH_SIZE }),
      );
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        if (envelope.eventName !== CANVAS_REFRESH_RECEIPT_RECORDED) continue;
        try {
          receipts.push(decodeCanvasRefreshReceiptRecorded(envelope.payload).receipt);
        } catch {
          // Ignore malformed cache entries; lifecycle state remains journaled.
        }
      }
      for (const envelope of batch) {
        if (envelope.eventName !== CANVAS_VERSION_APPENDED) continue;
        try {
          const payload = decodeCanvasVersionAppended(envelope.payload);
          if (payload.refreshReceipt !== undefined) {
            receipts.push(decodeCanvasRefreshReceipt(payload.refreshReceipt));
          }
        } catch {
          // Ignore malformed cache entries; lifecycle state remains journaled.
        }
      }
    }
    return receipts;
  }

  replayCanvas(input: ReplayCanvasInput): CanvasReplay {
    let canvasId: CanvasId;
    try {
      canvasId = decodeCanvasId(input.canvasId);
      if (
        !Number.isSafeInteger(input.afterVersion) ||
        input.afterVersion < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_CANVAS_REPLAY_LIMIT
      ) {
        throw new Error("invalid cursor");
      }
    } catch {
      throw new CanvasEventStoreError("invalid", "Canvas replay is invalid.");
    }

    const events: EventEnvelope[] = [];
    let expectedVersion = 1;
    let afterSequence = 0;
    let scannedEvents = 0;
    let sawCreate = input.afterVersion > 0;

    while (events.length < input.limit) {
      const batch = this.#journal.replay(
        decodeReplayCursor({ afterSequence, limit: JOURNAL_REPLAY_BATCH_SIZE }),
      );
      if (batch.length === 0) break;
      for (const envelope of batch) {
        scannedEvents += 1;
        if (scannedEvents > MAX_JOURNAL_SCAN_EVENTS) {
          return { status: "snapshot-required", reason: "scan-limit" };
        }
        afterSequence = envelope.globalSequence;
        if (!isCanvasAggregate(envelope, canvasId)) continue;
        if (envelope.aggregateVersion <= input.afterVersion) {
          sawCreate = true;
          expectedVersion = envelope.aggregateVersion + 1;
          continue;
        }
        if (envelope.eventName === CANVAS_CREATED) {
          if (envelope.aggregateVersion !== 1) {
            return { status: "snapshot-required", reason: "gap" };
          }
          if (!this.#decodePayloadSafe(envelope)) {
            return { status: "snapshot-required", reason: "invalid-frame" };
          }
          sawCreate = true;
          expectedVersion = 2;
          events.push(envelope);
          if (events.length >= input.limit) break;
          continue;
        }
        if (!sawCreate) {
          return { status: "snapshot-required", reason: "gap" };
        }
        if (envelope.aggregateVersion < expectedVersion) {
          continue;
        }
        if (envelope.aggregateVersion > expectedVersion) {
          if (expectedVersion === 1 && input.afterVersion + 1 === envelope.aggregateVersion) {
            expectedVersion = envelope.aggregateVersion;
          } else {
            return { status: "snapshot-required", reason: "gap" };
          }
        }
        if (!this.#decodePayloadSafe(envelope)) {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }
        events.push(envelope);
        expectedVersion = envelope.aggregateVersion + 1;
        if (events.length >= input.limit) break;
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }

    return {
      status: "ok",
      events,
      nextCursor:
        events.length === 0 ? input.afterVersion : events[events.length - 1]!.aggregateVersion,
    };
  }

  #decodePayloadSafe(envelope: EventEnvelope): boolean {
    try {
      if (envelope.eventName === CANVAS_CREATED) {
        const payload = decodeCanvasCreated(envelope.payload);
        decodeCanvasVersion(payload.version);
        return true;
      }
      if (envelope.eventName === CANVAS_VERSION_APPENDED) {
        const payload = decodeCanvasVersionAppended(envelope.payload);
        decodeCanvasVersion(payload.version);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  #wrapConcurrency(error: unknown): CanvasEventStoreError {
    if (error instanceof ConcurrencyConflict) {
      return new CanvasEventStoreError(
        "invalid",
        "Canvas expected version does not match the current head.",
      );
    }
    if (error instanceof DuplicateEventIdentity) {
      return new CanvasEventStoreError("invalid", "Canvas event identity is already committed.");
    }
    throw error;
  }

  #assertCommitted(
    envelope: EventEnvelope | undefined,
    aggregateId: typeof AggregateId.Type,
    aggregateVersion: number,
    eventName: string,
    label: string,
    aggregateType = CANVAS_AGGREGATE_TYPE,
  ): EventEnvelope {
    if (
      envelope === undefined ||
      envelope.aggregateType !== aggregateType ||
      envelope.aggregateId !== aggregateId ||
      envelope.aggregateVersion !== aggregateVersion ||
      envelope.eventName !== eventName ||
      envelope.eventVersion !== 1
    ) {
      throw new CanvasEventStoreError(
        "journal-mismatch",
        `Committed ${label} event does not match its append.`,
      );
    }
    return envelope;
  }
}

function isCanvasAggregate(envelope: EventEnvelope, canvasId: CanvasId): boolean {
  return (
    envelope.aggregateType === CANVAS_AGGREGATE_TYPE &&
    String(envelope.aggregateId) === String(canvasId)
  );
}
