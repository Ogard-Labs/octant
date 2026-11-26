import { createHash } from "node:crypto";
import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  MAX_THREAD_LINKED_ISSUES,
  THREAD_LINKED_ISSUE_EVENT_NAMES,
  THREAD_LINKED_ISSUES_AGGREGATE,
  TRACKER_ISSUE_WRITE_RECORDED,
  TRACKER_ISSUE_WRITES_AGGREGATE,
  UtcTimestamp,
  decodeThreadIssueLinked,
  decodeThreadIssueUnlinked,
  decodeTrackerIssueWriteRecorded,
  type EventActor as EventActorValue,
  type EventEnvelope,
  type LinkedIssueRef,
  type LinkedIssueSource,
  type ThreadLinkedIssue,
  type TrackerIssueWriteRecorded,
} from "@octant/contracts";
import { sameLinkedIssue } from "@octant/domain/tracker-issue-write-policy";
import { Schema } from "effect";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import type { SqliteConnection } from "../persistence/sqlitePort";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const PAGE = 1_000;
const MAX_APPEND_ATTEMPTS = 3;

/** A write record as a caller states it; the store decodes it into the event. */
export type TrackerIssueWriteInput = Omit<TrackerIssueWriteRecorded, "threadId"> & {
  readonly threadId: string;
};

export type LinkIssueOutcome =
  | {
      readonly status: "linked" | "unchanged";
      readonly linkedIssues: ReadonlyArray<ThreadLinkedIssue>;
    }
  | { readonly status: "refused"; readonly reason: "too-many" };

export type UnlinkIssueOutcome =
  | { readonly status: "unlinked"; readonly linkedIssues: ReadonlyArray<ThreadLinkedIssue> }
  | { readonly status: "refused"; readonly reason: "not-linked" };

/** SHA-256 of a comment's text: what the journal keeps instead of the text. */
export function commentDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * A thread's linked issues and the tracker writes made for them, each on an
 * aggregate of its own keyed by the thread, so neither races the thread's
 * version. Both are folded from the journal on read: the journal is the
 * record, and there is nothing else to rebuild.
 */
export class ThreadLinkedIssueStore {
  readonly #journal: Pick<Journal, "append" | "replayAggregate">;
  readonly #connection: SqliteConnection;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: EventActorValue;

  constructor(options: {
    readonly journal: Pick<Journal, "append" | "replayAggregate">;
    readonly connection: SqliteConnection;
    readonly uuid: () => string;
    readonly clock: () => string;
    /** The host's own actor, for links and writes no person made. */
    readonly actor: EventActorValue;
  }) {
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = decodeActor(options.actor);
  }

  /** The thread's linked issues, oldest link first. */
  list(threadId: string): ReadonlyArray<ThreadLinkedIssue> {
    const linked: ThreadLinkedIssue[] = [];
    for (const event of this.#events(THREAD_LINKED_ISSUES_AGGREGATE, threadId)) {
      if (event.eventName === THREAD_LINKED_ISSUE_EVENT_NAMES.linked) {
        const payload = decodeThreadIssueLinked(event.payload);
        if (linked.some((entry) => sameLinkedIssue(entry.issue, payload.issue))) continue;
        linked.push({ issue: payload.issue, source: payload.source, linkedAt: payload.linkedAt });
      } else if (event.eventName === THREAD_LINKED_ISSUE_EVENT_NAMES.unlinked) {
        const payload = decodeThreadIssueUnlinked(event.payload);
        const index = linked.findIndex((entry) => sameLinkedIssue(entry.issue, payload.issue));
        if (index >= 0) linked.splice(index, 1);
      }
    }
    return linked;
  }

  link(
    threadId: string,
    issue: LinkedIssueRef,
    source: LinkedIssueSource,
    actor?: EventActorValue,
  ): LinkIssueOutcome {
    return this.#appendDeciding<LinkIssueOutcome>(
      THREAD_LINKED_ISSUES_AGGREGATE,
      threadId,
      actor,
      () => {
        const current = this.list(threadId);
        if (current.some((entry) => sameLinkedIssue(entry.issue, issue))) {
          return { outcome: { status: "unchanged", linkedIssues: current } };
        }
        if (current.length >= MAX_THREAD_LINKED_ISSUES) {
          return { outcome: { status: "refused", reason: "too-many" } };
        }
        const linkedAt = decodeTimestamp(this.#clock());
        return {
          eventName: THREAD_LINKED_ISSUE_EVENT_NAMES.linked,
          payload: { threadId, issue, source, linkedAt },
          outcome: {
            status: "linked",
            linkedIssues: [...current, { issue, source, linkedAt }],
          },
        };
      },
    );
  }

  unlink(threadId: string, issue: LinkedIssueRef, actor?: EventActorValue): UnlinkIssueOutcome {
    return this.#appendDeciding<UnlinkIssueOutcome>(
      THREAD_LINKED_ISSUES_AGGREGATE,
      threadId,
      actor,
      () => {
        const current = this.list(threadId);
        if (!current.some((entry) => sameLinkedIssue(entry.issue, issue))) {
          return { outcome: { status: "refused", reason: "not-linked" } };
        }
        return {
          eventName: THREAD_LINKED_ISSUE_EVENT_NAMES.unlinked,
          payload: { threadId, issue },
          outcome: {
            status: "unlinked",
            linkedIssues: current.filter((entry) => !sameLinkedIssue(entry.issue, issue)),
          },
        };
      },
    );
  }

  /** Every tracker write recorded for the thread, oldest first. */
  writes(threadId: string): ReadonlyArray<TrackerIssueWriteRecorded> {
    return this.#events(TRACKER_ISSUE_WRITES_AGGREGATE, threadId)
      .filter((event) => event.eventName === TRACKER_ISSUE_WRITE_RECORDED)
      .map((event) => decodeTrackerIssueWriteRecorded(event.payload));
  }

  recordWrite(record: TrackerIssueWriteInput, actor?: EventActorValue): void {
    this.#appendDeciding(TRACKER_ISSUE_WRITES_AGGREGATE, String(record.threadId), actor, () => ({
      eventName: TRACKER_ISSUE_WRITE_RECORDED,
      payload: decodeTrackerIssueWriteRecorded(record),
      outcome: undefined,
    }));
  }

  #events(aggregateType: string, threadId: string): ReadonlyArray<EventEnvelope> {
    const events: EventEnvelope[] = [];
    let afterVersion = 0;
    for (;;) {
      const page = this.#journal.replayAggregate({
        aggregateType,
        aggregateId: threadId,
        afterVersion,
        limit: PAGE,
      });
      events.push(...page);
      const last = page.at(-1);
      if (page.length < PAGE || last === undefined) return events;
      afterVersion = last.aggregateVersion;
    }
  }

  /**
   * Decides against the aggregate as it stands and appends at that version;
   * a writer that got there first makes it decide again.
   */
  #appendDeciding<T>(
    aggregateType: string,
    threadId: string,
    actor: EventActorValue | undefined,
    decide: () => {
      readonly eventName?: string;
      readonly payload?: unknown;
      readonly outcome: T;
    },
  ): T {
    const aggregateId = decodeAggregateId(threadId);
    for (let attempt = 0; ; attempt += 1) {
      const expectedVersion = decodeAggregateVersion(
        readAggregateVersion(this.#connection, aggregateType, aggregateId),
      );
      const decision = decide();
      if (decision.eventName === undefined) return decision.outcome;
      try {
        this.#journal.append({
          aggregate: { aggregateType, aggregateId },
          expectedVersion,
          events: [
            {
              eventId: decodeEventId(this.#uuid()),
              eventName: decodeEventName(decision.eventName),
              eventVersion: 1,
              correlationId: decodeCorrelationId(this.#uuid()),
              actor: actor ?? this.#actor,
              occurredAt: decodeTimestamp(this.#clock()),
              payload: decision.payload,
            },
          ],
        });
        return decision.outcome;
      } catch (error) {
        if (error instanceof ConcurrencyConflict && attempt + 1 < MAX_APPEND_ATTEMPTS) continue;
        throw error;
      }
    }
  }
}
