import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  ReplayCursor,
  decodeWorkResearchBriefId,
  decodeWorkResearchFrame,
  type WorkResearchBriefId,
  type WorkResearchFrame,
  type EventEnvelope,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";

export const WORK_RESEARCH_RECORDED = "work.research-recorded@1";
export const MAX_WORK_RESEARCH_REPLAY_LIMIT = 256;
const JOURNAL_REPLAY_BATCH_SIZE = 1_000;
const MAX_JOURNAL_SCAN_EVENTS = 100_000;

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);

type JournalPort = Pick<Journal, "append" | "replay" | "replayAggregateType">;

export class WorkResearchEventStoreError extends Error {
  override readonly name = "WorkResearchEventStoreError";
  readonly category: "invalid" | "journal-mismatch";

  constructor(category: WorkResearchEventStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface WorkResearchEventStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
}

export interface AppendWorkResearchInput {
  readonly briefId: WorkResearchBriefId;
  readonly expectedVersion: number;
  readonly frame: WorkResearchFrame;
}

export interface ReplayWorkResearchInput {
  readonly briefId: WorkResearchBriefId;
  readonly afterVersion: number;
  readonly limit: number;
}

export type WorkResearchReplay =
  | {
      readonly status: "ok";
      readonly frames: ReadonlyArray<WorkResearchFrame>;
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

export type WorkResearchReplayAll =
  | { readonly status: "ok"; readonly frames: ReadonlyArray<WorkResearchFrame> }
  | { readonly status: "snapshot-required"; readonly reason: "scan-limit" };

/**
 * Server-authoritative Work research event store. Appends one
 * `work.research-recorded@1` event per successful brief transition; the
 * aggregate is the brief and the aggregate version is the brief `version`,
 * backing optimistic concurrency on `expectedVersion`. Replay rebuilds the
 * research frames for a brief idempotently so projections can reconstruct
 * brief state after reconnect or restart.
 */
export class WorkResearchEventStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;

  constructor(options: WorkResearchEventStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    try {
      this.#actor = decodeActor(options.actor);
      decodeActorId(this.#actor.actorId);
    } catch {
      throw new WorkResearchEventStoreError("invalid", "Work research event actor is invalid.");
    }
  }

  append(input: AppendWorkResearchInput): WorkResearchFrame {
    let frame: WorkResearchFrame;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    let eventId: typeof EventId.Type;
    let correlationId: typeof CorrelationId.Type;
    try {
      const briefId = decodeWorkResearchBriefId(input.briefId);
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      aggregateId = decodeAggregateId(briefId);
      eventId = decodeEventId(this.#uuid());
      correlationId = decodeCorrelationId(this.#uuid());
      frame = decodeWorkResearchFrame(input.frame);
      if (frame.transition.brief.briefId !== briefId) {
        throw new Error("frame brief id does not match the append request");
      }
      if (frame.transition.brief.version !== expectedVersion + 1) {
        throw new Error("frame version must be one greater than the expected head");
      }
      if (frame.sequence !== frame.transition.brief.version) {
        throw new Error("frame sequence must match the transition brief version");
      }
    } catch {
      throw new WorkResearchEventStoreError("invalid", "Work research append is invalid.");
    }

    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: "work-research", aggregateId },
        expectedVersion,
        events: [
          {
            eventId,
            eventName: WORK_RESEARCH_RECORDED,
            eventVersion: 1,
            correlationId,
            actor: this.#actor,
            occurredAt: frame.occurredAt,
            payload: frame,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new WorkResearchEventStoreError(
          "invalid",
          "Work research expected version does not match the current brief head.",
        );
      }
      throw error;
    }

    const envelope = committed.events[0];
    const expectedAggregateVersion = expectedVersion + 1;
    if (
      committed.events.length !== 1 ||
      envelope === undefined ||
      envelope.aggregateType !== "work-research" ||
      envelope.aggregateId !== aggregateId ||
      envelope.aggregateVersion !== expectedAggregateVersion ||
      envelope.eventName !== WORK_RESEARCH_RECORDED ||
      envelope.eventVersion !== 1 ||
      !sameFrame(envelope.payload, frame)
    ) {
      throw new WorkResearchEventStoreError(
        "journal-mismatch",
        "Committed Work research event does not match its append.",
      );
    }
    return frame;
  }

  replay(input: ReplayWorkResearchInput): WorkResearchReplay {
    let briefId: WorkResearchBriefId;
    try {
      briefId = decodeWorkResearchBriefId(input.briefId);
      if (
        !Number.isSafeInteger(input.afterVersion) ||
        input.afterVersion < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_WORK_RESEARCH_REPLAY_LIMIT
      ) {
        throw new Error("invalid cursor or limit");
      }
    } catch {
      throw new WorkResearchEventStoreError("invalid", "Work research replay is invalid.");
    }

    const frames: Array<WorkResearchFrame> = [];
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
        if (!isRequestedAggregate(envelope, briefId)) continue;
        if (envelope.eventName !== WORK_RESEARCH_RECORDED || envelope.eventVersion !== 1) {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }

        let frame: WorkResearchFrame;
        try {
          frame = decodeWorkResearchFrame(envelope.payload);
        } catch {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }
        if (frame.transition.brief.briefId !== briefId) {
          return { status: "snapshot-required", reason: "identity-mismatch" };
        }
        const version = frame.transition.brief.version;
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
      nextCursor: frames.at(-1)?.transition.brief.version ?? input.afterVersion,
    };
  }

  /**
   * Replays all research frames across every brief from the authoritative
   * journal, in version order per brief. Used to hydrate the in-memory
   * projection after restart or reconnect before the service serves commands.
   * Frames are grouped by briefId and sorted by version within each group.
   * The aggregate-type query reads only `work-research` history, so unrelated
   * journal growth on a long-lived host can never abort research hydration.
   * Returns `snapshot-required` with reason `scan-limit` only when the research
   * history itself exceeds `MAX_JOURNAL_SCAN_EVENTS`, so hydration fails closed
   * instead of silently truncating; callers must then report research
   * unavailable rather than serving the partially rebuilt projection.
   */
  replayAll(): WorkResearchReplayAll {
    const byBrief = new Map<WorkResearchBriefId, Array<WorkResearchFrame>>();
    let afterSequence = 0;
    let scannedEvents = 0;
    let hitScanLimit = false;

    for (;;) {
      const batch = this.#journal.replayAggregateType({
        aggregateType: "work-research",
        afterSequence,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      });
      if (batch.length === 0) break;

      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        scannedEvents += 1;
        if (scannedEvents > MAX_JOURNAL_SCAN_EVENTS) {
          hitScanLimit = true;
          break;
        }
        if (envelope.eventName !== WORK_RESEARCH_RECORDED || envelope.eventVersion !== 1) {
          continue;
        }
        let frame: WorkResearchFrame;
        try {
          frame = decodeWorkResearchFrame(envelope.payload);
        } catch {
          continue;
        }
        const briefId = frame.transition.brief.briefId;
        let list = byBrief.get(briefId);
        if (list === undefined) {
          list = [];
          byBrief.set(briefId, list);
        }
        list.push(frame);
      }

      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
      if (hitScanLimit) break;
    }

    if (hitScanLimit) {
      return { status: "snapshot-required", reason: "scan-limit" };
    }

    const all: Array<WorkResearchFrame> = [];
    for (const list of byBrief.values()) {
      list.sort((a, b) => a.transition.brief.version - b.transition.brief.version);
      for (const frame of list) all.push(frame);
    }
    return { status: "ok", frames: all };
  }
}

function isRequestedAggregate(envelope: EventEnvelope, briefId: WorkResearchBriefId): boolean {
  return (
    envelope.aggregateType === "work-research" && String(envelope.aggregateId) === String(briefId)
  );
}

function sameFrame(left: unknown, right: WorkResearchFrame): boolean {
  try {
    return JSON.stringify(decodeWorkResearchFrame(left)) === JSON.stringify(right);
  } catch {
    return false;
  }
}
