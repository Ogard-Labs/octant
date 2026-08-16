import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  ReplayCursor,
  decodeWorkArtifactId,
  decodeWorkArtifactMutationFrame,
  type WorkArtifactId,
  type WorkArtifactMutationFrame,
  type EventEnvelope,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";

export const WORK_ARTIFACT_MUTATION_RECORDED = "work.artifact-mutation-recorded@1";
export const MAX_WORK_REPLAY_LIMIT = 256;
const JOURNAL_REPLAY_BATCH_SIZE = 1_000;
const MAX_JOURNAL_SCAN_EVENTS = 10_000;

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursor);

type JournalPort = Pick<Journal, "append" | "replay">;

export class WorkMutationEventStoreError extends Error {
  override readonly name = "WorkMutationEventStoreError";
  readonly category: "invalid" | "journal-mismatch";

  constructor(category: WorkMutationEventStoreError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface WorkMutationEventStoreOptions {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: typeof EventActor.Type;
}

export interface AppendWorkMutationInput {
  readonly artifactId: WorkArtifactId;
  readonly expectedSequence: number;
  readonly frame: WorkArtifactMutationFrame;
}

export interface ReplayWorkMutationsInput {
  readonly artifactId: WorkArtifactId;
  readonly afterSequence: number;
  readonly limit: number;
}

export type WorkMutationReplay =
  | {
      readonly status: "ok";
      readonly frames: ReadonlyArray<WorkArtifactMutationFrame>;
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
 * Server-authoritative Work mutation event store. Appends one
 * `work.artifact-mutation-recorded@1` event per successful mutation; the
 * aggregate is the artifact and the aggregate version is the per-artifact
 * version sequence, backing optimistic concurrency on `expectedSequence`.
 * Replay rebuilds the mutation frames for an artifact idempotently so
 * projections can reconstruct artifact state after reconnect or restart.
 */
export class WorkMutationEventStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;

  constructor(options: WorkMutationEventStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    void options.clock;
    try {
      this.#actor = decodeActor(options.actor);
      decodeActorId(this.#actor.actorId);
    } catch {
      throw new WorkMutationEventStoreError("invalid", "Work mutation event actor is invalid.");
    }
  }

  append(input: AppendWorkMutationInput): WorkArtifactMutationFrame {
    let frame: WorkArtifactMutationFrame;
    let aggregateId: typeof AggregateId.Type;
    let expectedVersion: typeof AggregateVersion.Type;
    let eventId: typeof EventId.Type;
    let correlationId: typeof CorrelationId.Type;
    try {
      const artifactId = decodeWorkArtifactId(input.artifactId);
      expectedVersion = decodeAggregateVersion(input.expectedSequence);
      aggregateId = decodeAggregateId(artifactId);
      eventId = decodeEventId(this.#uuid());
      correlationId = decodeCorrelationId(this.#uuid());
      frame = decodeWorkArtifactMutationFrame(input.frame);
    } catch {
      throw new WorkMutationEventStoreError("invalid", "Work mutation append is invalid.");
    }

    let committed;
    try {
      committed = this.#journal.append({
        aggregate: { aggregateType: "work-artifact", aggregateId },
        expectedVersion,
        events: [
          {
            eventId,
            eventName: WORK_ARTIFACT_MUTATION_RECORDED,
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
        throw new WorkMutationEventStoreError(
          "invalid",
          "Work mutation expected sequence does not match the current artifact head.",
        );
      }
      throw error;
    }

    const envelope = committed.events[0];
    const expectedSequence = expectedVersion + 1;
    if (
      committed.events.length !== 1 ||
      envelope === undefined ||
      envelope.aggregateType !== "work-artifact" ||
      envelope.aggregateId !== aggregateId ||
      envelope.aggregateVersion !== expectedSequence ||
      envelope.eventName !== WORK_ARTIFACT_MUTATION_RECORDED ||
      envelope.eventVersion !== 1 ||
      !sameFrame(envelope.payload, frame)
    ) {
      throw new WorkMutationEventStoreError(
        "journal-mismatch",
        "Committed Work mutation event does not match its append.",
      );
    }
    return frame;
  }

  replay(input: ReplayWorkMutationsInput): WorkMutationReplay {
    let artifactId: WorkArtifactId;
    try {
      artifactId = decodeWorkArtifactId(input.artifactId);
      if (
        !Number.isSafeInteger(input.afterSequence) ||
        input.afterSequence < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_WORK_REPLAY_LIMIT
      ) {
        throw new Error("invalid cursor or limit");
      }
    } catch {
      throw new WorkMutationEventStoreError("invalid", "Work mutation replay is invalid.");
    }

    const frames: Array<WorkArtifactMutationFrame> = [];
    let expectedSequence = 1;
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
        if (!isRequestedAggregate(envelope, artifactId)) continue;
        if (envelope.eventName !== WORK_ARTIFACT_MUTATION_RECORDED || envelope.eventVersion !== 1) {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }

        let frame: WorkArtifactMutationFrame;
        try {
          frame = decodeWorkArtifactMutationFrame(envelope.payload);
        } catch {
          return { status: "snapshot-required", reason: "invalid-frame" };
        }
        if (frame.sequence !== expectedSequence || envelope.aggregateVersion !== frame.sequence) {
          return { status: "snapshot-required", reason: "gap" };
        }
        expectedSequence += 1;
        if (frame.sequence > input.afterSequence) frames.push(frame);
        if (frames.length === input.limit) break;
      }

      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }

    if (input.afterSequence >= expectedSequence) {
      return { status: "snapshot-required", reason: "cursor-ahead" };
    }
    return {
      status: "ok",
      frames,
      nextCursor: frames.at(-1)?.sequence ?? input.afterSequence,
    };
  }
}

function isRequestedAggregate(envelope: EventEnvelope, artifactId: WorkArtifactId): boolean {
  return (
    envelope.aggregateType === "work-artifact" &&
    String(envelope.aggregateId) === String(artifactId)
  );
}

function sameFrame(left: unknown, right: WorkArtifactMutationFrame): boolean {
  try {
    return JSON.stringify(decodeWorkArtifactMutationFrame(left)) === JSON.stringify(right);
  } catch {
    return false;
  }
}
