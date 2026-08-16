import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  ReplayCursor,
  decodeWorkPromotionFrame,
  decodeWorkPromotionProposalId,
  type WorkPromotionFrame,
  type WorkPromotionProposalId,
  type EventEnvelope,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";

export const WORK_PROMOTION_RECORDED = "work.promotion-recorded@1";
export const MAX_WORK_PROMOTION_REPLAY_LIMIT = 256;
const JOURNAL_REPLAY_BATCH_SIZE = 1_000;
const MAX_JOURNAL_SCAN_EVENTS = 100_000;

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);

type JournalPort = Pick<Journal, "append" | "replay">;

export class WorkPromotionEventStoreError extends Error {
  override readonly name = "WorkPromotionEventStoreError";
  readonly category: "invalid" | "journal-mismatch";

  constructor(category: WorkPromotionEventStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface WorkPromotionEventStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly actor: typeof EventActor.Type;
}

export interface AppendWorkPromotionInput {
  readonly proposalId: WorkPromotionProposalId;
  readonly expectedVersion: number;
  readonly frame: WorkPromotionFrame;
}

export interface ReplayWorkPromotionInput {
  readonly proposalId: WorkPromotionProposalId;
  readonly afterVersion: number;
  readonly limit: number;
}

export type WorkPromotionReplay =
  | {
      readonly status: "ok";
      readonly frames: ReadonlyArray<WorkPromotionFrame>;
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

export type WorkPromotionReplayAll =
  | { readonly status: "ok"; readonly frames: ReadonlyArray<WorkPromotionFrame> }
  | { readonly status: "snapshot-required"; readonly reason: "scan-limit" };

/**
 * Server-authoritative Work promotion event store. Appends one
 * `work.promotion-recorded@1` event per promotion transition; the aggregate
 * is the proposal and the aggregate version is the proposal `version`, backing
 * optimistic concurrency on `expectedVersion`. Replay rebuilds the promotion
 * frames for a proposal idempotently so projections can reconstruct proposal
 * state after reconnect or restart.
 */
export class WorkPromotionEventStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;

  constructor(options: WorkPromotionEventStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    try {
      this.#actor = decodeActor(options.actor);
      decodeActorId(this.#actor.actorId);
    } catch {
      throw new WorkPromotionEventStoreError("invalid", "Work promotion event actor is invalid.");
    }
  }

  append(input: AppendWorkPromotionInput): WorkPromotionFrame {
    let frame: WorkPromotionFrame;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    let eventId: typeof EventId.Type;
    let correlationId: typeof CorrelationId.Type;
    try {
      const proposalId = decodeWorkPromotionProposalId(input.proposalId);
      expectedVersion = decodeAggregateVersion(input.expectedVersion);
      aggregateId = decodeAggregateId(proposalId);
      eventId = decodeEventId(this.#uuid());
      correlationId = decodeCorrelationId(this.#uuid());
      frame = decodeWorkPromotionFrame(input.frame);
      if (frame.proposal.proposalId !== proposalId) {
        throw new Error("frame proposal id does not match the append request");
      }
      if (frame.proposal.version !== expectedVersion + 1) {
        throw new Error("frame version must be one greater than the expected head");
      }
    } catch {
      throw new WorkPromotionEventStoreError("invalid", "Work promotion append is invalid.");
    }

    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: "work-promotion", aggregateId },
        expectedVersion,
        events: [
          {
            eventId,
            eventName: WORK_PROMOTION_RECORDED,
            eventVersion: 1,
            correlationId,
            actor: this.#actor,
            occurredAt: frame.proposal.decidedAt ?? frame.proposal.proposedAt,
            payload: frame,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        throw new WorkPromotionEventStoreError(
          "invalid",
          "Work promotion expected version does not match the current proposal head.",
        );
      }
      throw error;
    }

    const envelope = committed.events[0];
    const expectedAggregateVersion = expectedVersion + 1;
    if (
      committed.events.length !== 1 ||
      envelope === undefined ||
      envelope.aggregateType !== "work-promotion" ||
      envelope.aggregateId !== aggregateId ||
      envelope.aggregateVersion !== expectedAggregateVersion ||
      envelope.eventName !== WORK_PROMOTION_RECORDED ||
      envelope.eventVersion !== 1 ||
      !sameFrame(envelope.payload, frame)
    ) {
      throw new WorkPromotionEventStoreError(
        "journal-mismatch",
        "Committed Work promotion event does not match its append.",
      );
    }
    return frame;
  }

  replay(input: ReplayWorkPromotionInput): WorkPromotionReplay {
    let proposalId: WorkPromotionProposalId;
    try {
      proposalId = decodeWorkPromotionProposalId(input.proposalId);
      if (
        !Number.isSafeInteger(input.afterVersion) ||
        input.afterVersion < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_WORK_PROMOTION_REPLAY_LIMIT
      ) {
        throw new Error("invalid cursor or limit");
      }
    } catch {
      throw new WorkPromotionEventStoreError("invalid", "Work promotion replay is invalid.");
    }

    const frames: Array<WorkPromotionFrame> = [];
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
        if (!isRequestedAggregate(envelope, proposalId)) continue;
        if (envelope.eventName !== WORK_PROMOTION_RECORDED || envelope.eventVersion !== 1) {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }

        let frame: WorkPromotionFrame;
        try {
          frame = decodeWorkPromotionFrame(envelope.payload);
        } catch {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }
        if (frame.proposal.proposalId !== proposalId) {
          return { status: "snapshot-required", reason: "identity-mismatch" };
        }
        const version = frame.proposal.version;
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
      nextCursor: frames.at(-1)?.proposal.version ?? input.afterVersion,
    };
  }

  /**
   * Replays all promotion frames across every proposal from the authoritative
   * journal, in version order per proposal. Used to hydrate the in-memory
   * projection after restart or reconnect before the service serves commands.
   * Frames are grouped by proposalId and sorted by version within each group.
   * Returns `snapshot-required` with reason `scan-limit` if the global journal
   * exceeds `MAX_JOURNAL_SCAN_EVENTS` before all promotion frames are collected,
   * so hydration fails closed instead of silently truncating.
   */
  replayAll(): WorkPromotionReplayAll {
    const byProposal = new Map<WorkPromotionProposalId, Array<WorkPromotionFrame>>();
    let afterSequence = 0;
    let scannedEvents = 0;
    let hitScanLimit = false;

    for (;;) {
      const batch = this.#journal.replay(
        decodeReplayCursor({ afterSequence, limit: JOURNAL_REPLAY_BATCH_SIZE }),
      );
      if (batch.length === 0) break;

      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        scannedEvents += 1;
        if (scannedEvents > MAX_JOURNAL_SCAN_EVENTS) {
          hitScanLimit = true;
          break;
        }
        if (envelope.aggregateType !== "work-promotion") continue;
        if (envelope.eventName !== WORK_PROMOTION_RECORDED || envelope.eventVersion !== 1) {
          continue;
        }
        let frame: WorkPromotionFrame;
        try {
          frame = decodeWorkPromotionFrame(envelope.payload);
        } catch {
          continue;
        }
        const proposalId = frame.proposal.proposalId;
        let list = byProposal.get(proposalId);
        if (list === undefined) {
          list = [];
          byProposal.set(proposalId, list);
        }
        list.push(frame);
      }

      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
      if (hitScanLimit) break;
    }

    if (hitScanLimit) {
      return { status: "snapshot-required", reason: "scan-limit" };
    }

    const all: Array<WorkPromotionFrame> = [];
    for (const list of byProposal.values()) {
      list.sort((a, b) => a.proposal.version - b.proposal.version);
      for (const frame of list) all.push(frame);
    }
    return { status: "ok", frames: all };
  }
}

function isRequestedAggregate(
  envelope: EventEnvelope,
  proposalId: WorkPromotionProposalId,
): boolean {
  return (
    envelope.aggregateType === "work-promotion" &&
    String(envelope.aggregateId) === String(proposalId)
  );
}

function sameFrame(left: unknown, right: WorkPromotionFrame): boolean {
  try {
    return JSON.stringify(decodeWorkPromotionFrame(left)) === JSON.stringify(right);
  } catch {
    return false;
  }
}
