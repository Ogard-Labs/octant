import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  ReplayCursor,
  UtcTimestamp,
  decodeWorkRequestFrame,
  decodeWorkRequestId,
  type WorkRequestFrame,
  type WorkRequestId,
  type EventEnvelope,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";

export const WORK_REQUEST_RECORDED = "work.request-recorded@1";
export const MAX_WORK_REQUEST_REPLAY_LIMIT = 256;
const JOURNAL_REPLAY_BATCH_SIZE = 1_000;
const MAX_JOURNAL_SCAN_EVENTS = 100_000;

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

type JournalPort = Pick<Journal, "append" | "replay">;
type RequestReplayJournalPort = Pick<Journal, "replayAggregateType">;

export class WorkRequestEventStoreError extends Error {
  override readonly name = "WorkRequestEventStoreError";
  readonly category: "invalid" | "journal-mismatch";

  constructor(category: WorkRequestEventStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface WorkRequestEventStoreOptions {
  readonly journal: JournalPort & RequestReplayJournalPort;
  readonly uuid: () => string;
}

export interface AppendWorkRequestInput {
  readonly requestId: WorkRequestId;
  readonly expectedVersion: number;
  readonly frame: WorkRequestFrame;
  /** The service-clock time at which this request transition occurred. */
  readonly occurredAt: typeof UtcTimestamp.Type;
  /** The authoritative actor for this exact request transition. */
  readonly actor: typeof EventActor.Type;
}

export interface ReplayWorkRequestInput {
  readonly requestId: WorkRequestId;
  readonly afterVersion: number;
  readonly limit: number;
}

export type WorkRequestReplay =
  | {
      readonly status: "ok";
      readonly frames: ReadonlyArray<WorkRequestFrame>;
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

export type WorkRequestReplayAll =
  | { readonly status: "ok"; readonly frames: ReadonlyArray<WorkRequestFrame> }
  | {
      readonly status: "snapshot-required";
      readonly reason: "gap" | "identity-mismatch" | "invalid-frame";
    };

/**
 * Server-authoritative Work request event store. Appends one
 * `work.request-recorded@1` event per request transition; the aggregate is
 * the request and the aggregate version is the request `version`, backing
 * optimistic concurrency on `expectedVersion`. Replay rebuilds the request
 * frames for a request idempotently so the projection can reconstruct
 * pending/settled state after reconnect or restart.
 */
export class WorkRequestEventStore {
  readonly #journal: JournalPort & RequestReplayJournalPort;
  readonly #uuid: () => string;

  constructor(options: WorkRequestEventStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
  }

  append(input: AppendWorkRequestInput): WorkRequestFrame {
    let frame: WorkRequestFrame;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    let eventId: typeof EventId.Type;
    let correlationId: typeof CorrelationId.Type;
    let actor: typeof EventActor.Type;
    let occurredAt: typeof UtcTimestamp.Type;
    try {
      const requestId = decodeWorkRequestId(input.requestId);
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      aggregateId = decodeAggregateId(requestId);
      eventId = decodeEventId(this.#uuid());
      correlationId = decodeCorrelationId(this.#uuid());
      frame = decodeWorkRequestFrame(input.frame);
      actor = decodeActor(input.actor);
      decodeActorId(actor.actorId);
      occurredAt = decodeTimestamp(input.occurredAt);
      if (frame.request.requestId !== requestId) {
        throw new Error("frame request id does not match the append request");
      }
      if (frame.request.version !== expectedVersion + 1) {
        throw new Error("frame version must be one greater than the expected head");
      }
    } catch {
      throw new WorkRequestEventStoreError("invalid", "Work request append is invalid.");
    }

    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: "work-request", aggregateId },
        expectedVersion,
        events: [
          {
            eventId,
            eventName: WORK_REQUEST_RECORDED,
            eventVersion: 1,
            correlationId,
            actor,
            occurredAt,
            payload: frame,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new WorkRequestEventStoreError(
          "invalid",
          "Work request expected version does not match the current request head.",
        );
      }
      throw error;
    }

    const envelope = committed.events[0];
    const expectedAggregateVersion = expectedVersion + 1;
    if (
      committed.events.length !== 1 ||
      envelope === undefined ||
      envelope.aggregateType !== "work-request" ||
      envelope.aggregateId !== aggregateId ||
      envelope.aggregateVersion !== expectedAggregateVersion ||
      envelope.eventName !== WORK_REQUEST_RECORDED ||
      envelope.eventVersion !== 1 ||
      !sameFrame(envelope.payload, frame)
    ) {
      throw new WorkRequestEventStoreError(
        "journal-mismatch",
        "Committed Work request event does not match its append.",
      );
    }
    return frame;
  }

  replay(input: ReplayWorkRequestInput): WorkRequestReplay {
    let requestId: WorkRequestId;
    try {
      requestId = decodeWorkRequestId(input.requestId);
      if (
        !Number.isSafeInteger(input.afterVersion) ||
        input.afterVersion < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_WORK_REQUEST_REPLAY_LIMIT
      ) {
        throw new Error("invalid cursor or limit");
      }
    } catch {
      throw new WorkRequestEventStoreError("invalid", "Work request replay is invalid.");
    }

    const frames: Array<WorkRequestFrame> = [];
    let expectedVersion = 1;
    let afterSequence = 0;
    let scannedEvents = 0;

    while (frames.length < input.limit) {
      const batch = this.#journal.replay(
        decodeReplayCursor({ afterSequence, limit: JOURNAL_REPLAY_BATCH_SIZE }),
      );
      if (batch.length === 0) break;

      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        scannedEvents += 1;
        if (scannedEvents > MAX_JOURNAL_SCAN_EVENTS) {
          return { status: "snapshot-required", reason: "scan-limit" };
        }
        if (!isRequestedAggregate(envelope, requestId)) continue;
        if (envelope.eventName !== WORK_REQUEST_RECORDED || envelope.eventVersion !== 1) {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }

        let frame: WorkRequestFrame;
        try {
          frame = decodeWorkRequestFrame(envelope.payload);
        } catch {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }
        if (frame.request.requestId !== requestId) {
          return { status: "snapshot-required", reason: "identity-mismatch" };
        }
        const version = frame.request.version;
        if (version !== expectedVersion || envelope.aggregateVersion !== version) {
          return { status: "snapshot-required", reason: "gap" };
        }
        expectedVersion = version + 1;
        if (version > input.afterVersion) frames.push(frame);
        if (frames.length === input.limit) break;
      }

      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }

    if (input.afterVersion >= expectedVersion) {
      return { status: "snapshot-required", reason: "cursor-ahead" };
    }
    return {
      status: "ok",
      frames,
      nextCursor: frames.at(-1)?.request.version ?? input.afterVersion,
    };
  }

  /**
   * Replays all request frames across every request from the authoritative
   * journal, in version order per request. The aggregate-type query avoids
   * scanning unrelated historical events, so a large general journal cannot
   * abort request hydration during server startup.
   */
  replayAll(): WorkRequestReplayAll {
    const byRequest = new Map<
      WorkRequestId,
      { readonly frames: Array<WorkRequestFrame>; nextVersion: number }
    >();
    let afterSequence = 0;

    for (;;) {
      const batch = this.#journal.replayAggregateType({
        aggregateType: "work-request",
        afterSequence,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      });
      if (batch.length === 0) break;

      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        if (envelope.eventName !== WORK_REQUEST_RECORDED || envelope.eventVersion !== 1) {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }
        let frame: WorkRequestFrame;
        try {
          frame = decodeWorkRequestFrame(envelope.payload);
        } catch {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }
        const requestId = frame.request.requestId;
        if (
          String(envelope.aggregateId) !== String(requestId) ||
          envelope.aggregateVersion !== frame.request.version
        ) {
          return { status: "snapshot-required", reason: "identity-mismatch" };
        }
        let replay = byRequest.get(requestId);
        if (replay === undefined) {
          replay = { frames: [], nextVersion: 1 };
          byRequest.set(requestId, replay);
        }
        if (frame.request.version !== replay.nextVersion) {
          return { status: "snapshot-required", reason: "gap" };
        }
        replay.frames.push(frame);
        replay.nextVersion += 1;
      }

      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }

    const all: Array<WorkRequestFrame> = [];
    for (const replay of byRequest.values()) {
      for (const frame of replay.frames) all.push(frame);
    }
    return { status: "ok", frames: all };
  }
}

function isRequestedAggregate(envelope: EventEnvelope, requestId: WorkRequestId): boolean {
  return (
    envelope.aggregateType === "work-request" && String(envelope.aggregateId) === String(requestId)
  );
}

function sameFrame(left: unknown, right: WorkRequestFrame): boolean {
  try {
    return JSON.stringify(decodeWorkRequestFrame(left)) === JSON.stringify(right);
  } catch {
    return false;
  }
}
