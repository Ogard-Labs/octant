import {
  GOAL_LOOP_AGGREGATE_TYPE,
  GOAL_LOOP_EVENT_NAMES,
  NATIVE_HARNESS_SESSION_AGGREGATE_TYPE,
  NATIVE_HARNESS_SESSION_EVENT_NAMES,
  THREAD_WAKEUP_AGGREGATE,
  THREAD_WAKEUP_CHANGED,
  USAGE_RESUME_SETTLED,
  UtcTimestamp,
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeNativeHarnessApproval,
  decodeNativeHarnessSession,
  decodeThreadWakeupChanged,
  decodeWorkThreadId,
} from "@octant/contracts";
import { reapsStaleProviderSession } from "@octant/domain";
import { transitionChatAttempt } from "@octant/domain/chat-policy";
import { Schema } from "effect";

const decodeUtcTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
import {
  AUTOMATION_BLOCKED,
  AUTOMATION_DEFINITION_AGGREGATE_TYPE,
  AUTOMATION_DEFINITION_CREATED,
  AUTOMATION_DEFINITION_EXHAUSTED,
  AUTOMATION_DEFINITION_LIFECYCLE_CHANGED,
  AUTOMATION_DEFINITION_UPDATED,
} from "../automation/automationEventStore";
import {
  COORDINATOR_WAKE_AGGREGATE_TYPE,
  COORDINATOR_WAKE_EVENT_NAMES,
  createCoordinatorWakeJournal,
} from "../coordinator/coordinatorWakeJournal";
import { THREAD_MESSAGE_QUEUE_CHANGED } from "../messageQueue/threadMessageQueuePersistence";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import {
  WorkThreadProjection,
  hydrateWorkThreadProjectionFromJournal,
} from "../work/workThreadProjection";
import {
  WorkTurnProjection,
  hydrateWorkTurnProjectionFromJournal,
} from "../work/workTurnProjection";
import { AggregateHeadsProjection } from "./aggregateHeadsProjection";
import {
  ChatProjection,
  readChatThread,
  readChatThreads,
  readChatThreadView,
} from "./chatProjection";
import { CodeProjection, readCodeThread } from "./codeProjection";
import { listPendingUsageResumes, UsageResumeProjection } from "./usageResumeProjection";
import type { EventRegistry } from "./eventRegistry";
import { Journal } from "./journal";
import { ProjectionRegistry, rebuildProjections } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

/**
 * Settles the work that was running in Octant when its store was copied, so
 * nothing imported runs in Nightly until the person starts it
 * (docs/design/nightly-app.md#importing-from-octant). Each change is an event
 * this build already writes for the same situation after its own restart,
 * appended to the snapshot through Nightly's journal and so decoded by
 * Nightly's registry: a pending wake-up becomes missed, an enabled routine is
 * blocked as made on another host, a running goal loop is held after
 * restart, an open coordinator wake is held, every queued message is
 * cancelled, every pending approval is cancelled, and every Chat answer and
 * Work turn still running is interrupted, as a restart leaves them, so
 * Nightly's start finds none to continue. Restart continuations
 * and queued message bodies live outside the journal and are not copied.
 *
 * Every settling event carries the import's id as its correlation id. That
 * marks it as the import's, on Octant's line rather than Nightly's: a later
 * import that finds only such events at the end of a stream Octant went on
 * with drops them and takes Octant's own events instead.
 */
export function settleOctantInFlightWork(input: {
  readonly connection: SqliteConnection;
  readonly registry: EventRegistry;
  readonly importId: string;
  readonly clock: () => string;
  readonly uuid: () => string;
}): number {
  // Only aggregate heads are kept current: the snapshot's own projections are
  // never read again, and the merged store rebuilds every one of them.
  const journal = new Journal({
    connection: input.connection,
    registry: input.registry,
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: input.clock,
  });
  const append = (
    aggregateType: string,
    aggregateId: string,
    expectedVersion: number,
    events: ReadonlyArray<{ readonly eventName: string; readonly payload: unknown }>,
  ): number => {
    journal.append({
      aggregate: { aggregateType, aggregateId },
      expectedVersion,
      events: events.map((event) => ({
        eventId: input.uuid(),
        eventName: event.eventName,
        eventVersion: 1,
        correlationId: input.importId,
        actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
        occurredAt: input.clock(),
        payload: event.payload,
      })),
    });
    return events.length;
  };

  let settled = 0;
  // The views settling reads, rebuilt in the snapshot because the
  // snapshot's own were Octant's and may predate Nightly's migrations; the
  // aggregate heads every append below reads come with them.
  rebuildProjections({
    connection: input.connection,
    journal,
    projections: [
      new AggregateHeadsProjection(),
      new ChatProjection(),
      new CodeProjection(),
      new UsageResumeProjection(),
    ],
    clock: input.clock,
  });
  settled += settleUsageResumes(input.connection, journal, append, input.clock);
  settled += settleChatAttempts(input.connection, append, input.clock);
  settled += settleWakeups(input.connection, append);
  settled += settleAutomations(input.connection, append, input.clock);
  settled += settleGoalLoops(input.connection, append);
  settled += settleQueues(input.connection, append);
  settled += settleApprovals(input.connection, append, input.clock);
  settled += settleWorkTurns(journal, append, input.clock);
  const open = createCoordinatorWakeJournal({
    journal,
    connection: input.connection,
    clock: input.clock,
  }).open();
  for (const wake of open) {
    const head = (
      input.connection
        .prepare(
          `SELECT coalesce(max(aggregate_version), 0) AS head FROM event_journal
           WHERE aggregate_type = ? AND aggregate_id = ?`,
        )
        .get(COORDINATOR_WAKE_AGGREGATE_TYPE, wake.threadId) as { readonly head: number }
    ).head;
    settled += append(COORDINATOR_WAKE_AGGREGATE_TYPE, wake.threadId, head, [
      {
        eventName: COORDINATOR_WAKE_EVENT_NAMES.settled,
        payload: { wakeId: wake.wakeId, outcome: "held" },
      },
    ]);
  }
  return settled;
}

const IMPORTED_RESUME_DETAIL =
  "Brought from Octant, which scheduled this resume; Nightly does not continue it by itself.";

/**
 * Every resume Octant scheduled for a usage-limited stop settles invalidated,
 * as the host settles one whose premise no longer holds, so Nightly's resume
 * service arms none for imported work. Like the host's own settle
 * (UsageResumeService and the mode ports' settleUpdate), a Chat, Work or Code
 * thread's row comes with it at the next version, because those threads
 * carry their stream's version and refuse a command against a stale one.
 */
function settleUsageResumes(
  connection: SqliteConnection,
  journal: Journal,
  append: Append,
  clock: () => string,
): number {
  const workThreads = new WorkThreadProjection();
  const hydrated = hydrateWorkThreadProjectionFromJournal({
    replay: (cursor) =>
      journal.replayAggregateType({
        aggregateType: cursor.aggregateType ?? "work-thread",
        afterSequence: cursor.afterSequence,
        limit: cursor.limit,
      }),
    projection: workThreads,
  });
  if (hydrated !== "ok") throw new Error("The snapshot's Work threads could not be read whole.");
  let settled = 0;
  for (const pending of listPendingUsageResumes(connection)) {
    const head = streamHead(connection, pending.aggregateType, pending.threadId);
    const usageResume = {
      record: pending.record,
      status: "invalidated",
      detail: IMPORTED_RESUME_DETAIL,
    };
    const thread =
      pending.aggregateType === "chat-thread"
        ? readChatThread(connection, decodeChatThreadId(pending.threadId))
        : pending.aggregateType === "work-thread"
          ? workThreads.read(decodeWorkThreadId(pending.threadId))
          : pending.aggregateType === "code-thread"
            ? readCodeThread(connection, decodeCodeThreadId(pending.threadId))
            : undefined;
    const threadUpdate =
      thread === undefined
        ? []
        : [
            {
              eventName: `${pending.aggregateType.slice(0, -"-thread".length)}.thread-updated@1`,
              payload: {
                kind: "thread-updated",
                thread: { ...thread, usageResume, version: head + 2, updatedAt: clock() },
              },
            },
          ];
    settled += append(pending.aggregateType, pending.threadId, head, [
      {
        eventName: USAGE_RESUME_SETTLED,
        payload: { resume: pending.record, outcome: "invalidated", detail: IMPORTED_RESUME_DETAIL },
      },
      ...threadUpdate,
    ]);
  }
  return settled;
}

/**
 * Every Chat answer the journal still reads as running is interrupted, the
 * way the host's own start reaps the ones its previous run was giving
 * (ChatService.reapStaleProviderSessions).
 */
function settleChatAttempts(
  connection: SqliteConnection,
  append: Append,
  clock: () => string,
): number {
  const now = Date.parse(clock());
  let settled = 0;
  for (const thread of readChatThreads(connection)) {
    const view = readChatThreadView(connection, thread.id);
    for (const attempt of view?.turns.flatMap((turn) => turn.attempts) ?? []) {
      const disposition = reapsStaleProviderSession({
        attempt,
        ownedByThisProcess: false,
        now,
        staleAfterMs: 0,
      });
      if (disposition.kind === "retain") continue;
      const interrupted = transitionChatAttempt(attempt, {
        outcome: "interrupted",
        updatedAt: decodeUtcTimestamp(clock()),
      });
      settled += append(
        "chat-thread",
        String(thread.id),
        streamHead(connection, "chat-thread", String(thread.id)),
        [
          {
            eventName: "chat.attempt-updated@1",
            payload: { kind: "attempt-updated", attempt: interrupted },
          },
        ],
      );
    }
  }
  return settled;
}

/** Every Work turn still accepted or running fails as cut off, the way the host's own start settles them. */
function settleWorkTurns(journal: Journal, append: Append, clock: () => string): number {
  const turns = new WorkTurnProjection();
  const hydrated = hydrateWorkTurnProjectionFromJournal({
    replay: (cursor) =>
      journal.replayAggregateType({
        aggregateType: cursor.aggregateType ?? "work-turn",
        afterSequence: cursor.afterSequence,
        limit: cursor.limit,
      }),
    projection: turns,
  });
  if (hydrated !== "ok") throw new Error("The snapshot's Work turns could not be read whole.");
  let settled = 0;
  for (const turn of turns.markInterruptedOnRestart(clock())) {
    settled += append("work-turn", String(turn.requestId), turn.journaledVersion, [
      { eventName: "work.turn-updated@1", payload: turn.settlement },
    ]);
  }
  return settled;
}

function streamHead(
  connection: SqliteConnection,
  aggregateType: string,
  aggregateId: string,
): number {
  return (
    connection
      .prepare(
        `SELECT coalesce(max(aggregate_version), 0) AS head FROM event_journal
         WHERE aggregate_type = ? AND aggregate_id = ?`,
      )
      .get(aggregateType, aggregateId) as { readonly head: number }
  ).head;
}

type Append = (
  aggregateType: string,
  aggregateId: string,
  expectedVersion: number,
  events: ReadonlyArray<{ readonly eventName: string; readonly payload: unknown }>,
) => number;

interface StreamRow {
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly event_name: string;
  readonly payload_json: string;
}

/** Every event of one aggregate type, each aggregate's in version order. */
function streams(
  connection: SqliteConnection,
  aggregateType: string,
): ReadonlyMap<string, ReadonlyArray<StreamRow>> {
  const rows = connection
    .prepare(
      `SELECT aggregate_id, aggregate_version, event_name, payload_json FROM event_journal
       WHERE aggregate_type = ? ORDER BY aggregate_id, aggregate_version`,
    )
    .all(aggregateType) as ReadonlyArray<StreamRow>;
  const byAggregate = new Map<string, Array<StreamRow>>();
  for (const row of rows) {
    const stream = byAggregate.get(row.aggregate_id) ?? [];
    stream.push(row);
    byAggregate.set(row.aggregate_id, stream);
  }
  return byAggregate;
}

function headVersion(stream: ReadonlyArray<StreamRow>): number {
  return stream.at(-1)?.aggregate_version ?? 0;
}

function settleWakeups(connection: SqliteConnection, append: Append): number {
  let settled = 0;
  for (const [aggregateId, stream] of streams(connection, THREAD_WAKEUP_AGGREGATE)) {
    const last = stream.at(-1);
    if (last === undefined || last.event_name !== THREAD_WAKEUP_CHANGED) continue;
    const { wakeup } = decodeThreadWakeupChanged(JSON.parse(last.payload_json));
    if (wakeup.status !== "pending") continue;
    settled += append(THREAD_WAKEUP_AGGREGATE, aggregateId, headVersion(stream), [
      {
        eventName: THREAD_WAKEUP_CHANGED,
        payload: { wakeup: { ...wakeup, status: "missed" }, change: "missed" },
      },
    ]);
  }
  return settled;
}

const decodeDefinitionLifecycle = Schema.decodeUnknownSync(
  Schema.Struct({ automation: Schema.Struct({ lifecycle: Schema.String }) }),
);

function settleAutomations(
  connection: SqliteConnection,
  append: Append,
  clock: () => string,
): number {
  let settled = 0;
  for (const [aggregateId, stream] of streams(connection, AUTOMATION_DEFINITION_AGGREGATE_TYPE)) {
    let lifecycle: string | undefined;
    for (const row of stream) {
      if (
        row.event_name === AUTOMATION_DEFINITION_CREATED ||
        row.event_name === AUTOMATION_DEFINITION_UPDATED ||
        row.event_name === AUTOMATION_DEFINITION_LIFECYCLE_CHANGED
      ) {
        lifecycle = decodeDefinitionLifecycle(JSON.parse(row.payload_json)).automation.lifecycle;
      } else if (row.event_name === AUTOMATION_DEFINITION_EXHAUSTED) {
        lifecycle = "exhausted";
      } else if (row.event_name === AUTOMATION_BLOCKED) {
        lifecycle = "paused";
      }
    }
    if (lifecycle !== "enabled") continue;
    // A routine blocked as `host-mismatch` is paused until its person resumes
    // it, the state the host itself records for a routine that names a host
    // other than this one.
    settled += append(AUTOMATION_DEFINITION_AGGREGATE_TYPE, aggregateId, headVersion(stream), [
      {
        eventName: AUTOMATION_BLOCKED,
        payload: { automationId: aggregateId, reason: "host-mismatch", recordedAt: clock() },
      },
    ]);
  }
  return settled;
}

const decodeLoopStarted = Schema.decodeUnknownSync(
  Schema.Struct({ loop: Schema.Struct({ status: Schema.String }) }),
);

function settleGoalLoops(connection: SqliteConnection, append: Append): number {
  let settled = 0;
  for (const [aggregateId, stream] of streams(connection, GOAL_LOOP_AGGREGATE_TYPE)) {
    let running = false;
    for (const row of stream) {
      if (row.event_name === GOAL_LOOP_EVENT_NAMES.started) {
        running = decodeLoopStarted(JSON.parse(row.payload_json)).loop.status === "running";
      } else if (
        row.event_name === GOAL_LOOP_EVENT_NAMES.paused ||
        row.event_name === GOAL_LOOP_EVENT_NAMES.stopped
      ) {
        running = false;
      } else if (row.event_name === GOAL_LOOP_EVENT_NAMES.resumed) {
        running = true;
      }
    }
    if (!running) continue;
    settled += append(GOAL_LOOP_AGGREGATE_TYPE, aggregateId, headVersion(stream), [
      {
        eventName: GOAL_LOOP_EVENT_NAMES.paused,
        payload: { loopId: aggregateId, reason: "held-after-restart" },
      },
    ]);
  }
  return settled;
}

const decodeQueueChanged = Schema.decodeUnknownSync(
  Schema.Struct({
    threadId: Schema.String,
    state: Schema.Struct({
      version: Schema.Number,
      items: Schema.Array(Schema.Struct({ messageId: Schema.String })),
    }),
  }),
);

function settleQueues(connection: SqliteConnection, append: Append): number {
  let settled = 0;
  for (const [aggregateId, stream] of streams(connection, "thread-message-queue")) {
    const last = stream.at(-1);
    if (last === undefined || last.event_name !== THREAD_MESSAGE_QUEUE_CHANGED) continue;
    const raw = JSON.parse(last.payload_json) as { readonly state: Record<string, unknown> };
    const changed = decodeQueueChanged(raw);
    if (changed.state.items.length === 0) continue;
    // One settlement per message, each a whole new queue state whose
    // version is its own aggregate version, as the queue writes them.
    const rawItems = raw.state.items as ReadonlyArray<unknown>;
    const events = changed.state.items.map((item, index) => ({
      eventName: THREAD_MESSAGE_QUEUE_CHANGED,
      payload: {
        threadId: changed.threadId,
        state: {
          ...raw.state,
          version: headVersion(stream) + index + 1,
          items: rawItems.slice(index + 1),
        },
        settled: { messageId: item.messageId, status: "cancelled" },
      },
    }));
    settled += append("thread-message-queue", aggregateId, headVersion(stream), events);
  }
  return settled;
}

const decodeApprovalSettled = Schema.decodeUnknownSync(
  Schema.Struct({ approvalId: Schema.String }),
);

function settleApprovals(
  connection: SqliteConnection,
  append: Append,
  clock: () => string,
): number {
  const names = NATIVE_HARNESS_SESSION_EVENT_NAMES;
  let settled = 0;
  for (const [aggregateId, stream] of streams(connection, NATIVE_HARNESS_SESSION_AGGREGATE_TYPE)) {
    let sessionId: string | undefined;
    const pending = new Set<string>();
    for (const row of stream) {
      if (row.event_name === names.started) {
        sessionId = String(decodeNativeHarnessSession(JSON.parse(row.payload_json)).id);
        pending.clear();
      } else if (row.event_name === names.approvalAsked) {
        const approval = decodeNativeHarnessApproval(JSON.parse(row.payload_json));
        if (approval.status === "pending") pending.add(String(approval.id));
      } else if (row.event_name === names.approvalSettled) {
        pending.delete(decodeApprovalSettled(JSON.parse(row.payload_json)).approvalId);
      }
    }
    if (sessionId === undefined || pending.size === 0) continue;
    const settledAt = clock();
    settled += append(
      NATIVE_HARNESS_SESSION_AGGREGATE_TYPE,
      aggregateId,
      headVersion(stream),
      [...pending].map((approvalId) => ({
        eventName: names.approvalSettled,
        payload: { sessionId, approvalId, status: "cancelled", settledAt },
      })),
    );
  }
  return settled;
}
