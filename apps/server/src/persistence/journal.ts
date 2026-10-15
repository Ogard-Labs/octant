import {
  AppendEventsRequest,
  EventActor,
  EventEnvelope as EventEnvelopeSchema,
  LOCAL_HOST_ID,
  ReplayCursor as ReplayCursorSchema,
  type CommittedAppend,
  type EventEnvelope,
  type ReplayCursor,
} from "@octant/contracts";
import { assignAggregateVersions } from "@octant/domain";
import { Schema } from "effect";
import { EventRegistry } from "./eventRegistry";
import {
  classifySqliteFailure,
  ConcurrencyConflict,
  DuplicateEventIdentity,
  EventPayloadInvalid,
  JournalInputInvalid,
  JournalWriteFailed,
  isSqliteStorageFailure,
  ReplayEventInvalid,
  ThreadIdInUse,
  UnknownEventName,
  UnsupportedEventVersion,
} from "./journalErrors";
import { ProjectionApplicationFailed, ProjectionRegistry } from "./projection";
import type { SqliteConnection, SqliteStatement } from "./sqlitePort";
import { threadIdHeldByAnotherMode, threadModeOfAggregateType } from "./threadIdentity";

export interface JournalAppendOptions {
  readonly beforeEvents?: (connection: SqliteConnection) => void | ReadonlyArray<unknown>;
}

export interface JournalOptions {
  readonly connection: SqliteConnection;
  readonly registry: EventRegistry;
  readonly projections: ProjectionRegistry;
  readonly clock: () => string;
  readonly onCommitted?: (append: CommittedAppend) => void;
}

interface AggregateHeadRow {
  readonly aggregate_version: number;
}

interface JournalRow {
  readonly global_sequence: number;
  readonly event_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly event_name: string;
  readonly event_version: number;
  readonly host_id: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly actor_json: string | null;
  readonly occurred_at: string;
  readonly payload_json: string;
}

interface PreparedEvent {
  readonly pending: Schema.Schema.Type<typeof AppendEventsRequest>["events"][number];
  readonly payload: unknown;
  readonly payloadJson: string;
}

export interface JournalCompatibilityIssue {
  readonly eventId: string;
  readonly globalSequence: number;
  readonly eventName: string;
  readonly eventVersion: number;
  readonly reason: ReplayEventInvalid["reason"];
}

export interface AggregateReplayCursor {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly afterVersion: number;
  readonly limit: number;
}

export type JournalCompatibility =
  | { readonly compatible: true }
  | { readonly compatible: false; readonly issue: JournalCompatibilityIssue };

const decodeAppendRequest = Schema.decodeUnknownSync(AppendEventsRequest);
const decodeReplayCursor = Schema.decodeUnknownSync(ReplayCursorSchema);
const decodeEventEnvelope = Schema.decodeUnknownSync(EventEnvelopeSchema);
const decodeEventActor = Schema.decodeUnknownSync(EventActor);

/** The index migration 61 adds; a journal opened on an older schema plans without it. */
const THREAD_KIND_INDEX = "event_journal_thread_kind_sequence";

function eventJournalHasIndex(connection: SqliteConnection, name: string): boolean {
  return (
    connection
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name) !== undefined
  );
}

function eventJournalHasActorJson(connection: SqliteConnection): boolean {
  return (
    connection
      .prepare(
        "SELECT 1 AS present FROM pragma_table_info('event_journal') WHERE name = 'actor_json'",
      )
      .get() !== undefined
  );
}

export class Journal {
  readonly #connection: SqliteConnection;
  readonly #registry: EventRegistry;
  readonly #projections: ProjectionRegistry;
  readonly #clock: () => string;
  readonly #onCommitted: ((append: CommittedAppend) => void) | undefined;
  readonly #committedListeners = new Set<(append: CommittedAppend) => void>();
  /** Appends inside `transaction`, published only once the whole unit commits. */
  #heldAppends: Array<CommittedAppend> | undefined;
  readonly #hasActorJson: boolean;
  readonly #selectHead: SqliteStatement;
  readonly #insertEvent: SqliteStatement;
  readonly #upsertCheckpoint: SqliteStatement;
  readonly #selectEventIdentity: SqliteStatement;
  readonly #selectHeadSequence: SqliteStatement;
  readonly #replayRows: SqliteStatement;
  readonly #replayAggregateTypeRows: SqliteStatement;
  readonly #replayNarrowedAggregateTypeRows: SqliteStatement;
  readonly #aggregateVersionRows: SqliteStatement;
  readonly #replayAggregateTypeThreadRows: SqliteStatement;
  readonly #aggregateTypeThreadHead: SqliteStatement;
  readonly #replayThreadAnchoredRows: SqliteStatement;
  readonly #replayAggregateRows: SqliteStatement;
  readonly #latestThreadKindRows: SqliteStatement;
  readonly #latestThreadResultRows: SqliteStatement;
  readonly #latestThreadKindPerAggregateRows: SqliteStatement;
  readonly #firstAggregateKindRow: SqliteStatement;

  constructor(options: JournalOptions) {
    this.#connection = options.connection;
    this.#registry = options.registry;
    this.#projections = options.projections;
    this.#clock = options.clock;
    this.#onCommitted = options.onCommitted;
    this.#hasActorJson = eventJournalHasActorJson(options.connection);
    this.#selectHead = options.connection.prepare(`
      SELECT aggregate_version
      FROM aggregate_heads
      WHERE aggregate_type = ? AND aggregate_id = ?
    `);
    // Pre-v41 upgrade fixtures construct Journal before `actor_json` exists.
    // Production paths always migrate first; recreate Journal after schema upgrades.
    this.#insertEvent = this.#hasActorJson
      ? options.connection.prepare(`
      INSERT INTO event_journal (
        event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, host_id, correlation_id, causation_id,
        actor_kind, actor_id, actor_json, occurred_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      : options.connection.prepare(`
      INSERT INTO event_journal (
        event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, host_id, correlation_id, causation_id,
        actor_kind, actor_id, occurred_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#upsertCheckpoint = options.connection.prepare(`
      INSERT INTO projection_checkpoints (projection_name, last_sequence, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (projection_name) DO UPDATE SET
        last_sequence = excluded.last_sequence,
        updated_at = excluded.updated_at
    `);
    this.#selectEventIdentity = options.connection.prepare(`
      SELECT event_id FROM event_journal WHERE event_id = ?
    `);
    this.#selectHeadSequence = options.connection.prepare(`
      SELECT coalesce(max(global_sequence), 0) AS head_sequence FROM event_journal
    `);
    const actorJsonSelect = this.#hasActorJson ? "actor_json" : "NULL AS actor_json";
    this.#replayRows = options.connection.prepare(`
      SELECT
        global_sequence, event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, host_id, correlation_id, causation_id, actor_kind,
        actor_id, ${actorJsonSelect}, occurred_at, payload_json
      FROM event_journal
      WHERE global_sequence > ?
      ORDER BY global_sequence ASC
      LIMIT ?
    `);
    // `aggregate_version > 0` is always true; it is the condition of the
    // (type, sequence) index (migration 79), which only a query that repeats
    // it may use. That index returns the type's rows already in journal order.
    this.#replayAggregateTypeRows = options.connection.prepare(`
      SELECT
        global_sequence, event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, host_id, correlation_id, causation_id, actor_kind,
        actor_id, ${actorJsonSelect}, occurred_at, payload_json
      FROM event_journal
      WHERE aggregate_type = ? AND global_sequence > ? AND aggregate_version > 0
      ORDER BY global_sequence ASC
      LIMIT ?
    `);
    // The same read with rows a caller has no use for left out in SQL, so
    // they are never parsed or decoded: a startup that needs a few kinds of
    // record from an aggregate type no longer decodes every row of it. Each
    // narrowing is skipped when its parameter is NULL. A payload that is not
    // JSON never reaches `json_extract`, which would fail the whole query;
    // the prefix narrowing keeps such a row instead, so #decodeRow throws
    // `malformed-json` for it exactly as the unnarrowed read does.
    this.#replayNarrowedAggregateTypeRows = options.connection.prepare(`
      SELECT
        global_sequence, event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, host_id, correlation_id, causation_id, actor_kind,
        actor_id, ${actorJsonSelect}, occurred_at, payload_json
      FROM event_journal
      WHERE aggregate_type = ? AND global_sequence > ? AND aggregate_version > 0
        AND (? IS NULL OR event_name = ?)
        AND (? IS NULL OR event_name <> ?)
        AND (? IS NULL OR CASE WHEN json_valid(payload_json)
          THEN substr(json_extract(payload_json, ?), 1, length(?)) = ? ELSE 1 END)
      ORDER BY global_sequence ASC
      LIMIT ?
    `);
    // Every aggregate of a type with the version of its newest event, read
    // from the unique (type, id, version) index without touching a payload.
    this.#aggregateVersionRows = options.connection.prepare(`
      SELECT aggregate_id, max(aggregate_version) AS aggregate_version
      FROM event_journal
      WHERE aggregate_type = ?
      GROUP BY aggregate_id
    `);
    // Filters on the payload's `threadId` in SQL so a per-thread read never
    // decodes other threads' rows: a dogfooding host whose journal was 94%
    // code-checkout observations made every thread history read exhaust its
    // scan bound on rows that were never the thread's. The `'$.threadId'` key
    // is the same payload ownership rule thread purge already relies on, and
    // every returned row still goes through the registered schema in
    // #decodeRow before a caller sees it.
    this.#latestThreadKindRows = options.connection.prepare(`
      SELECT global_sequence, event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, host_id, correlation_id, causation_id, actor_kind,
        actor_id, ${actorJsonSelect}, occurred_at, payload_json
      FROM event_journal
      WHERE aggregate_type = ? AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadId') END = ?
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.event.kind') END = ?
        AND global_sequence < ?
      ORDER BY global_sequence DESC LIMIT ?
    `);
    // The same newest-first thread read keyed on an operation result's kind,
    // through the result-kind index (migration 63), optionally narrowed to
    // one mutation so a reader looking for the newest restore does not decode
    // every commit and push result before it.
    this.#latestThreadResultRows = options.connection.prepare(`
      SELECT global_sequence, event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, host_id, correlation_id, causation_id, actor_kind,
        actor_id, ${actorJsonSelect}, occurred_at, payload_json
      FROM event_journal
      WHERE aggregate_type = ? AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadId') END = ?
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.event.result.kind') END = ?
        AND (? IS NULL OR CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.event.result.mutation') END = ?)
        AND global_sequence < ?
      ORDER BY global_sequence DESC LIMIT ?
    `);
    // The last event of one kind of each aggregate that recorded an anchor
    // event of the thread before a sequence, in the order the anchors were
    // journaled: a Code turn's own usage figure is its last report, the turns
    // are the operations that started one, and a fold over them must run in
    // turn order even when an older turn's report landed after a newer one's.
    // Membership is by the anchor, not by where the report landed. The anchor
    // grouping reads the thread's anchors and the report grouping reads every
    // report of that kind the thread holds, both through the thread-kind
    // index; only the chosen rows decode. The index is named because the
    // grouping by aggregate made the planner prefer the aggregate's own index,
    // which walked every row of the type on the host and parsed each payload:
    // 176 ms for a 40-turn thread among a million Code rows, 0.07 ms on the
    // thread-kind index for the same rows. The host never runs ANALYZE, so
    // the planner has nothing better to go on.
    const threadKindIndex = eventJournalHasIndex(options.connection, THREAD_KIND_INDEX)
      ? `INDEXED BY ${THREAD_KIND_INDEX}`
      : "";
    this.#latestThreadKindPerAggregateRows = options.connection.prepare(`
      SELECT anchors.anchor_sequence AS anchor_sequence,
        event.global_sequence, event.event_id, event.aggregate_type, event.aggregate_id,
        event.aggregate_version, event.event_name, event.event_version, event.host_id,
        event.correlation_id, event.causation_id, event.actor_kind, event.actor_id,
        ${this.#hasActorJson ? "event.actor_json" : "NULL AS actor_json"}, event.occurred_at,
        event.payload_json
      FROM (
        SELECT aggregate_id, min(global_sequence) AS anchor_sequence
        FROM event_journal ${threadKindIndex}
        WHERE aggregate_type = ?
          AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadId') END = ?
          AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.event.kind') END = ?
          AND global_sequence < ?
        GROUP BY aggregate_id
      ) AS anchors
      JOIN (
        SELECT aggregate_id, max(global_sequence) AS last_sequence
        FROM event_journal ${threadKindIndex}
        WHERE aggregate_type = ?
          AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadId') END = ?
          AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.event.kind') END = ?
        GROUP BY aggregate_id
      ) AS latest ON latest.aggregate_id = anchors.aggregate_id
      JOIN event_journal AS event ON event.global_sequence = latest.last_sequence
      WHERE anchors.anchor_sequence > ?
      ORDER BY anchors.anchor_sequence ASC
      LIMIT ?
    `);
    // One aggregate's first event of a kind, walking its own unique index in
    // version order so the read stops at the match instead of parsing every
    // event the aggregate recorded after it.
    this.#firstAggregateKindRow = options.connection.prepare(`
      SELECT global_sequence, event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, host_id, correlation_id, causation_id, actor_kind,
        actor_id, ${actorJsonSelect}, occurred_at, payload_json
      FROM event_journal
      WHERE aggregate_type = ? AND aggregate_id = ?
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.event.kind') END = ?
      ORDER BY aggregate_version ASC
      LIMIT 1
    `);
    // The thread predicate is spelled exactly as the expression in the thread
    // indexes, because SQLite only uses an expression index for a textually
    // identical expression. The bare `json_extract` form this replaced
    // searched on `aggregate_type` alone and read every code-operation row's
    // payload, on every batch of every thread's history read. The
    // (type, thread, sequence) index (migration 80) returns the rows after the
    // cursor already in order.
    this.#replayAggregateTypeThreadRows = options.connection.prepare(`
      SELECT
        global_sequence, event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, host_id, correlation_id, causation_id, actor_kind,
        actor_id, ${actorJsonSelect}, occurred_at, payload_json
      FROM event_journal
      WHERE aggregate_type = ?
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadId') END = ?
        AND global_sequence > ?
      ORDER BY global_sequence ASC
      LIMIT ?
    `);
    // The size and newest row of the same thread slice, counted on the index
    // alone without reading a payload.
    this.#aggregateTypeThreadHead = options.connection.prepare(`
      SELECT count(*) AS event_count, coalesce(max(global_sequence), 0) AS last_sequence
      FROM event_journal
      WHERE aggregate_type = ?
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadId') END = ?
    `);
    // The same thread slice, narrowed in SQL to the aggregates that recorded
    // an event of one kind, plus rows whose event carries a result of one
    // kind. A reader that folds per-operation history (the Code conversation)
    // ignores every other row, and a thread whose journal was flooded with
    // one-event terminal attaches had 19,026 of those: decoding each one in
    // JavaScript held the event loop for over a second per read.
    //
    // Each half is its own indexed lookup, so SQLite never visits the rows it
    // leaves out. Spelled as one `OR` over the thread slice, the planner
    // walked every row of the thread and parsed each payload to test the
    // result kind — and the flood rows are themselves operation results — so
    // one read could still examine an unbounded suffix. The turn half reads
    // by operation id through the aggregate's unique index; the result half
    // reads the result-kind index (migration 63).
    this.#replayThreadAnchoredRows = options.connection.prepare(`
      SELECT
        global_sequence, event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, host_id, correlation_id, causation_id, actor_kind,
        actor_id, ${actorJsonSelect}, occurred_at, payload_json
      FROM event_journal
      WHERE global_sequence IN (
        SELECT global_sequence FROM event_journal
        WHERE aggregate_type = ?
          AND aggregate_id IN (
            SELECT aggregate_id FROM event_journal
            WHERE aggregate_type = ?
              AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadId') END = ?
              AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.event.kind') END = ?
          )
          AND global_sequence > ?
        UNION ALL
        SELECT global_sequence FROM event_journal
        WHERE aggregate_type = ?
          AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadId') END = ?
          AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.event.result.kind') END = ?
          AND global_sequence > ?
      )
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadId') END = ?
      ORDER BY global_sequence ASC
      LIMIT ?
    `);
    this.#replayAggregateRows = options.connection.prepare(`
      SELECT
        global_sequence, event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, host_id, correlation_id, causation_id, actor_kind,
        actor_id, ${actorJsonSelect}, occurred_at, payload_json
      FROM event_journal
      WHERE aggregate_type = ? AND aggregate_id = ? AND aggregate_version > ?
      ORDER BY aggregate_version ASC
      LIMIT ?
    `);
  }

  append(input: unknown, options?: JournalAppendOptions): CommittedAppend {
    let request: Schema.Schema.Type<typeof AppendEventsRequest>;
    try {
      request = decodeAppendRequest(bindLocalHostAuthority(input));
    } catch {
      throw new JournalInputInvalid({ operation: "append" });
    }

    const prepareEvent = (
      pending: Schema.Schema.Type<typeof AppendEventsRequest>["events"][number],
    ): PreparedEvent => {
      const payload = this.#registry.decode(
        pending.eventName,
        pending.eventVersion,
        pending.payload,
      );
      const payloadJson = serializeJsonPayload(payload, pending.eventName, pending.eventVersion);
      return { pending, payload, payloadJson };
    };
    const prepared = request.events.map(prepareEvent);
    const duplicateInputId = findDuplicate(prepared.map(({ pending }) => pending.eventId));

    let committed: CommittedAppend;
    try {
      committed = this.#connection.transaction(() => {
        const head = this.#selectHead.get(
          request.aggregate.aggregateType,
          request.aggregate.aggregateId,
        ) as AggregateHeadRow | undefined;
        let allPrepared = prepared;
        try {
          const additional = options?.beforeEvents?.(this.#connection) ?? [];
          const decodedAdditional =
            additional.length === 0
              ? []
              : decodeAppendRequest(
                  bindLocalHostAuthority({
                    ...request,
                    events: additional,
                  }),
                ).events;
          allPrepared = [...prepared, ...decodedAdditional.map(prepareEvent)];
        } catch {
          throw new JournalWriteFailed({ operation: "append" });
        }

        const duplicateInputEventId = findDuplicate(
          allPrepared.map(({ pending }) => pending.eventId),
        );
        if (duplicateInputEventId !== undefined) {
          throw new DuplicateEventIdentity({ eventId: duplicateInputEventId });
        }
        const existingEvent = allPrepared.find(
          ({ pending }) => this.#selectEventIdentity.get(pending.eventId) !== undefined,
        );
        if (existingEvent !== undefined) {
          throw new DuplicateEventIdentity({ eventId: existingEvent.pending.eventId });
        }

        // Checked here, inside the append's transaction, so every path that
        // starts a thread is covered and two creations racing on one id
        // cannot both pass.
        const threadMode = threadModeOfAggregateType(request.aggregate.aggregateType);
        if (
          head === undefined &&
          threadMode !== undefined &&
          threadIdHeldByAnotherMode(this.#connection, threadMode, request.aggregate.aggregateId)
        ) {
          throw new ThreadIdInUse({
            aggregateType: request.aggregate.aggregateType,
            aggregateId: request.aggregate.aggregateId,
          });
        }

        const actualVersion = head?.aggregate_version ?? 0;
        const assignment = assignAggregateVersions(
          request.expectedVersion,
          actualVersion,
          allPrepared.length,
        );
        if (!assignment.ok) {
          throw new ConcurrencyConflict({
            aggregateType: request.aggregate.aggregateType,
            aggregateId: request.aggregate.aggregateId,
            expectedVersion: assignment.expectedVersion,
            actualVersion: assignment.actualVersion,
          });
        }

        const events = allPrepared.map(
          ({ pending, payload, payloadJson }, index): EventEnvelope => {
            const aggregateVersion = assignment.versions[index];
            if (aggregateVersion === undefined) {
              throw new JournalWriteFailed({ operation: "append" });
            }
            if (
              !this.#hasActorJson &&
              pending.actor.kind !== "system" &&
              pending.actor.kind !== "local-user"
            ) {
              throw new JournalWriteFailed({ operation: "append" });
            }
            const result = this.#hasActorJson
              ? this.#insertEvent.run(
                  pending.eventId,
                  request.aggregate.aggregateType,
                  request.aggregate.aggregateId,
                  aggregateVersion,
                  pending.eventName,
                  pending.eventVersion,
                  pending.hostId,
                  pending.correlationId,
                  pending.causationId ?? null,
                  pending.actor.kind,
                  pending.actor.actorId,
                  serializeActorJson(pending.actor),
                  pending.occurredAt,
                  payloadJson,
                )
              : this.#insertEvent.run(
                  pending.eventId,
                  request.aggregate.aggregateType,
                  request.aggregate.aggregateId,
                  aggregateVersion,
                  pending.eventName,
                  pending.eventVersion,
                  pending.hostId,
                  pending.correlationId,
                  pending.causationId ?? null,
                  pending.actor.kind,
                  pending.actor.actorId,
                  pending.occurredAt,
                  payloadJson,
                );
            const globalSequence = Number(result.lastInsertRowid);
            return decodeEventEnvelope({
              ...pending,
              payload,
              globalSequence,
              aggregateType: request.aggregate.aggregateType,
              aggregateId: request.aggregate.aggregateId,
              aggregateVersion,
            });
          },
        ) as [EventEnvelope, ...Array<EventEnvelope>];

        const lastEvent = events.at(-1);
        if (lastEvent === undefined) {
          throw new JournalWriteFailed({ operation: "append" });
        }
        for (const event of events) {
          for (const projection of this.#projections.all()) {
            try {
              projection.apply(this.#connection, event);
            } catch (error) {
              if (isSqliteStorageFailure(error)) throw error;
              throw new ProjectionApplicationFailed({
                projectionName: projection.name,
                eventId: event.eventId,
                globalSequence: event.globalSequence,
              });
            }
          }
        }
        // One checkpoint row per projection per append, not per event: the
        // whole append commits or rolls back together, so the intermediate
        // sequences were never observable, and a streamed turn appends one
        // event per text delta across ~24 projections.
        const checkpointAt = this.#clock();
        for (const projection of this.#projections.all()) {
          this.#upsertCheckpoint.run(projection.name, lastEvent.globalSequence, checkpointAt);
        }

        return {
          events,
          firstSequence: events[0].globalSequence,
          lastSequence: lastEvent.globalSequence,
          aggregateVersion: lastEvent.aggregateVersion,
        };
      })();
    } catch (error) {
      if (
        error instanceof ConcurrencyConflict ||
        error instanceof DuplicateEventIdentity ||
        error instanceof ProjectionApplicationFailed ||
        error instanceof ThreadIdInUse
      ) {
        throw error;
      }
      const sqliteFailure = classifySqliteFailure(error);
      const isUniqueConstraint = sqliteFailure === "unique-constraint";
      const isWriteRace = sqliteFailure === "write-race";
      if (!isUniqueConstraint && !isWriteRace) {
        throw new JournalWriteFailed({ operation: "append" });
      }

      try {
        if (isUniqueConstraint) {
          const duplicateId =
            duplicateInputId ??
            prepared.find(
              ({ pending }) => this.#selectEventIdentity.get(pending.eventId) !== undefined,
            )?.pending.eventId;
          if (duplicateId !== undefined) {
            throw new DuplicateEventIdentity({ eventId: duplicateId });
          }
        }

        const currentHead = this.#selectHead.get(
          request.aggregate.aggregateType,
          request.aggregate.aggregateId,
        ) as AggregateHeadRow | undefined;
        const actualVersion = currentHead?.aggregate_version ?? 0;
        if (actualVersion !== request.expectedVersion) {
          throw new ConcurrencyConflict({
            aggregateType: request.aggregate.aggregateType,
            aggregateId: request.aggregate.aggregateId,
            expectedVersion: request.expectedVersion,
            actualVersion,
          });
        }
      } catch (classificationError) {
        if (
          classificationError instanceof DuplicateEventIdentity ||
          classificationError instanceof ConcurrencyConflict
        ) {
          throw classificationError;
        }
      }
      throw new JournalWriteFailed({ operation: "append" });
    }

    if (this.#heldAppends === undefined) this.#publish(committed);
    else this.#heldAppends.push(committed);
    return committed;
  }

  /**
   * Runs `body` as one unit: every append inside it, to any aggregate, commits
   * or rolls back together, and none is published until all of them have
   * committed. A subscriber never sees an append that a later failure in the
   * same unit took back. A unit inside a unit joins the outer one.
   */
  transaction<A>(body: () => A): A {
    if (this.#heldAppends !== undefined) return body();
    const held: Array<CommittedAppend> = [];
    this.#heldAppends = held;
    let result: A;
    try {
      result = this.#connection.transaction(body)();
    } finally {
      this.#heldAppends = undefined;
    }
    for (const committed of held) this.#publish(committed);
    return result;
  }

  #publish(committed: CommittedAppend): void {
    try {
      this.#onCommitted?.(committed);
    } catch {
      // Publication is best-effort after commit. The durable journal remains
      // authoritative, so a subscriber failure cannot change append success.
    }
    for (const listener of this.#committedListeners) {
      try {
        listener(committed);
      } catch {
        // One runtime observer cannot change the committed journal or starve peers.
      }
    }
  }

  subscribeCommitted(listener: (append: CommittedAppend) => void): () => void {
    this.#committedListeners.add(listener);
    return () => this.#committedListeners.delete(listener);
  }

  replay(cursor: ReplayCursor): ReadonlyArray<EventEnvelope> {
    let decodedCursor: ReplayCursor;
    try {
      decodedCursor = decodeReplayCursor(cursor);
    } catch {
      throw new JournalInputInvalid({ operation: "replay" });
    }

    return (
      this.#replayRows.all(decodedCursor.afterSequence, decodedCursor.limit) as Array<JournalRow>
    ).map((row) => this.#decodeRow(row));
  }

  /**
   * An aggregate type's events in journal order. The optional narrowings
   * leave rows out before they are read: only one event name, every event
   * name but one, or only rows whose payload value at `path` (dotted keys),
   * read as text, starts with `prefix`. The prefix test may let through a row
   * whose value is not a string, so a caller checks what it reads; every row
   * returned still decodes through the registered schema.
   */
  replayAggregateType(cursor: {
    readonly aggregateType: string;
    readonly afterSequence: number;
    readonly limit: number;
    readonly eventName?: string;
    readonly exceptEventName?: string;
    readonly payloadPrefix?: { readonly path: string; readonly prefix: string };
  }): ReadonlyArray<EventEnvelope> {
    if (
      cursor.aggregateType.trim().length === 0 ||
      !Number.isSafeInteger(cursor.afterSequence) ||
      cursor.afterSequence < 0 ||
      !Number.isSafeInteger(cursor.limit) ||
      cursor.limit < 1 ||
      cursor.limit > 1_000 ||
      cursor.eventName?.trim().length === 0 ||
      cursor.exceptEventName?.trim().length === 0 ||
      (cursor.payloadPrefix !== undefined &&
        (!PAYLOAD_PATH_PATTERN.test(cursor.payloadPrefix.path) ||
          cursor.payloadPrefix.prefix.length === 0))
    ) {
      throw new JournalInputInvalid({ operation: "replay" });
    }
    if (
      cursor.eventName === undefined &&
      cursor.exceptEventName === undefined &&
      cursor.payloadPrefix === undefined
    ) {
      return (
        this.#replayAggregateTypeRows.all(
          cursor.aggregateType,
          cursor.afterSequence,
          cursor.limit,
        ) as Array<JournalRow>
      ).map((row) => this.#decodeRow(row));
    }
    const eventName = cursor.eventName ?? null;
    const exceptEventName = cursor.exceptEventName ?? null;
    const path = cursor.payloadPrefix === undefined ? null : `$.${cursor.payloadPrefix.path}`;
    const prefix = cursor.payloadPrefix?.prefix ?? null;
    return (
      this.#replayNarrowedAggregateTypeRows.all(
        cursor.aggregateType,
        cursor.afterSequence,
        eventName,
        eventName,
        exceptEventName,
        exceptEventName,
        path,
        path,
        prefix,
        prefix,
        cursor.limit,
      ) as Array<JournalRow>
    ).map((row) => this.#decodeRow(row));
  }

  /**
   * Every aggregate of a type and the version of its newest event: what a
   * replay of every row of the type would leave as each aggregate's version,
   * without decoding any of them.
   */
  aggregateVersions(
    aggregateType: string,
  ): ReadonlyArray<{ readonly aggregateId: string; readonly aggregateVersion: number }> {
    if (aggregateType.trim().length === 0) throw new JournalInputInvalid({ operation: "replay" });
    return (
      this.#aggregateVersionRows.all(aggregateType) as Array<{
        readonly aggregate_id: string;
        readonly aggregate_version: number;
      }>
    ).map((row) => ({ aggregateId: row.aggregate_id, aggregateVersion: row.aggregate_version }));
  }

  replayAggregateTypeForThread(cursor: {
    readonly aggregateType: string;
    readonly threadId: string;
    readonly afterSequence: number;
    readonly limit: number;
  }): ReadonlyArray<EventEnvelope> {
    if (
      cursor.aggregateType.trim().length === 0 ||
      cursor.threadId.trim().length === 0 ||
      !Number.isSafeInteger(cursor.afterSequence) ||
      cursor.afterSequence < 0 ||
      !Number.isSafeInteger(cursor.limit) ||
      cursor.limit < 1 ||
      cursor.limit > 1_000
    ) {
      throw new JournalInputInvalid({ operation: "replay" });
    }
    return (
      this.#replayAggregateTypeThreadRows.all(
        cursor.aggregateType,
        cursor.threadId,
        cursor.afterSequence,
        cursor.limit,
      ) as Array<JournalRow>
    ).map((row) => this.#decodeRow(row));
  }

  /**
   * How many rows `replayAggregateTypeForThread` would return for a thread
   * from the start, and the newest one's sequence (0 for none). A reader that
   * keeps a thread's history compares these with what it read to tell whether
   * rows were appended or removed since, without reading any of them.
   */
  aggregateTypeThreadHead(slice: { readonly aggregateType: string; readonly threadId: string }): {
    readonly eventCount: number;
    readonly lastSequence: number;
  } {
    if (slice.aggregateType.trim().length === 0 || slice.threadId.trim().length === 0) {
      throw new JournalInputInvalid({ operation: "replay" });
    }
    const row = this.#aggregateTypeThreadHead.get(slice.aggregateType, slice.threadId) as {
      readonly event_count: number;
      readonly last_sequence: number;
    };
    return { eventCount: row.event_count, lastSequence: row.last_sequence };
  }

  /**
   * One thread's slice of an aggregate type, restricted to every row of an
   * aggregate that recorded an event of `anchorKind` and to rows whose event
   * carries a result of `resultKind`, in journal order. Rows are still decoded
   * through the registered schema; the filter only decides which rows are read.
   */
  replayThreadAnchoredRows(cursor: {
    readonly aggregateType: string;
    readonly threadId: string;
    readonly anchorKind: string;
    readonly resultKind: string;
    readonly afterSequence: number;
    readonly limit: number;
  }): ReadonlyArray<EventEnvelope> {
    if (
      cursor.aggregateType.trim().length === 0 ||
      cursor.threadId.trim().length === 0 ||
      cursor.anchorKind.trim().length === 0 ||
      cursor.resultKind.trim().length === 0 ||
      !Number.isSafeInteger(cursor.afterSequence) ||
      cursor.afterSequence < 0 ||
      !Number.isSafeInteger(cursor.limit) ||
      cursor.limit < 1 ||
      cursor.limit > 1_000
    ) {
      throw new JournalInputInvalid({ operation: "replay" });
    }
    return (
      this.#replayThreadAnchoredRows.all(
        cursor.aggregateType,
        cursor.aggregateType,
        cursor.threadId,
        cursor.anchorKind,
        cursor.afterSequence,
        cursor.aggregateType,
        cursor.threadId,
        cursor.resultKind,
        cursor.afterSequence,
        cursor.threadId,
        cursor.limit,
      ) as Array<JournalRow>
    ).map((row) => this.#decodeRow(row));
  }

  /**
   * A thread's newest events of one kind, newest first. `beforeSequence`, when
   * given, is exclusive: a reader that walks back asks below the oldest row it
   * already holds.
   */
  latestThreadEvents(input: {
    readonly aggregateType: string;
    readonly threadId: string;
    readonly kind: string;
    readonly limit: number;
    readonly beforeSequence?: number;
  }): ReadonlyArray<EventEnvelope> {
    if (
      input.aggregateType.trim().length === 0 ||
      input.threadId.trim().length === 0 ||
      input.kind.trim().length === 0 ||
      !validBound(input.beforeSequence) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1_000
    )
      throw new JournalInputInvalid({ operation: "replay" });
    return (
      this.#latestThreadKindRows.all(
        input.aggregateType,
        input.threadId,
        input.kind,
        input.beforeSequence ?? Number.MAX_SAFE_INTEGER,
        input.limit,
      ) as Array<JournalRow>
    ).map((row) => this.#decodeRow(row));
  }

  /**
   * A thread's newest events carrying a result of one kind, and of one
   * `mutation` when given, newest first, below an exclusive sequence.
   */
  latestThreadResults(input: {
    readonly aggregateType: string;
    readonly threadId: string;
    readonly resultKind: string;
    readonly mutation?: string;
    readonly limit: number;
    readonly beforeSequence?: number;
  }): ReadonlyArray<EventEnvelope> {
    if (
      input.aggregateType.trim().length === 0 ||
      input.threadId.trim().length === 0 ||
      input.resultKind.trim().length === 0 ||
      (input.mutation !== undefined && input.mutation.trim().length === 0) ||
      !validBound(input.beforeSequence) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1_000
    )
      throw new JournalInputInvalid({ operation: "replay" });
    return (
      this.#latestThreadResultRows.all(
        input.aggregateType,
        input.threadId,
        input.resultKind,
        input.mutation ?? null,
        input.mutation ?? null,
        input.beforeSequence ?? Number.MAX_SAFE_INTEGER,
        input.limit,
      ) as Array<JournalRow>
    ).map((row) => this.#decodeRow(row));
  }

  /**
   * The last event of `kind` of every aggregate that recorded an `anchorKind`
   * event of the thread below `anchorBeforeSequence`, each with the sequence
   * of that anchor, in anchor order, a batch at a time after
   * `afterAnchorSequence`. An aggregate with no event of `kind` is left out.
   */
  latestThreadEventPerAggregate(input: {
    readonly aggregateType: string;
    readonly threadId: string;
    readonly kind: string;
    readonly anchorKind: string;
    readonly anchorBeforeSequence: number;
    readonly afterAnchorSequence: number;
    readonly limit: number;
  }): ReadonlyArray<{ readonly anchorSequence: number; readonly event: EventEnvelope }> {
    if (
      input.aggregateType.trim().length === 0 ||
      input.threadId.trim().length === 0 ||
      input.kind.trim().length === 0 ||
      input.anchorKind.trim().length === 0 ||
      !validBound(input.anchorBeforeSequence) ||
      !Number.isSafeInteger(input.afterAnchorSequence) ||
      input.afterAnchorSequence < 0 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1_000
    )
      throw new JournalInputInvalid({ operation: "replay" });
    return (
      this.#latestThreadKindPerAggregateRows.all(
        input.aggregateType,
        input.threadId,
        input.anchorKind,
        input.anchorBeforeSequence,
        input.aggregateType,
        input.threadId,
        input.kind,
        input.afterAnchorSequence,
        input.limit,
      ) as Array<JournalRow & { readonly anchor_sequence: number }>
    ).map((row) => ({ anchorSequence: row.anchor_sequence, event: this.#decodeRow(row) }));
  }

  /** One aggregate's first event of a kind, or undefined when it recorded none. */
  firstAggregateEvent(input: {
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly kind: string;
  }): EventEnvelope | undefined {
    if (
      input.aggregateType.trim().length === 0 ||
      input.aggregateId.trim().length === 0 ||
      input.kind.trim().length === 0
    )
      throw new JournalInputInvalid({ operation: "replay" });
    const row = this.#firstAggregateKindRow.get(
      input.aggregateType,
      input.aggregateId,
      input.kind,
    ) as JournalRow | undefined;
    return row === undefined ? undefined : this.#decodeRow(row);
  }

  replayAggregate(cursor: AggregateReplayCursor): ReadonlyArray<EventEnvelope> {
    if (
      cursor.aggregateType.trim().length === 0 ||
      cursor.aggregateId.trim().length === 0 ||
      !Number.isSafeInteger(cursor.afterVersion) ||
      cursor.afterVersion < 0 ||
      !Number.isSafeInteger(cursor.limit) ||
      cursor.limit < 1 ||
      cursor.limit > 1_000
    ) {
      throw new JournalInputInvalid({ operation: "replay" });
    }
    return (
      this.#replayAggregateRows.all(
        cursor.aggregateType,
        cursor.aggregateId,
        cursor.afterVersion,
        cursor.limit,
      ) as Array<JournalRow>
    ).map((row) => this.#decodeRow(row));
  }

  headSequence(): number {
    return (this.#selectHeadSequence.get() as { readonly head_sequence: number }).head_sequence;
  }

  inspectCompatibility(batchSize = 100): JournalCompatibility {
    const limit =
      Number.isSafeInteger(batchSize) && batchSize >= 1 && batchSize <= 1000 ? batchSize : 100;
    const journalHead = this.headSequence();
    let afterSequence = 0;

    while (afterSequence < journalHead) {
      let events: ReadonlyArray<EventEnvelope>;
      try {
        events = this.replay(decodeReplayCursor({ afterSequence, limit }));
      } catch (error) {
        if (error instanceof ReplayEventInvalid) {
          return {
            compatible: false,
            issue: {
              eventId: error.eventId,
              globalSequence: error.globalSequence,
              eventName: error.eventName,
              eventVersion: error.eventVersion,
              reason: error.reason,
            },
          };
        }
        throw error;
      }

      const committed = events.filter((event) => event.globalSequence <= journalHead);
      const lastEvent = committed.at(-1);
      if (lastEvent === undefined) break;
      afterSequence = lastEvent.globalSequence;
    }

    return { compatible: true };
  }

  #decodeRow(row: JournalRow): EventEnvelope {
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(row.payload_json);
    } catch {
      throw replayEventInvalid(row, "malformed-json");
    }

    let payload: unknown;
    try {
      payload = this.#registry.decodePersisted(row.event_name, row.event_version, parsedPayload);
    } catch (error) {
      if (error instanceof UnknownEventName) {
        throw replayEventInvalid(row, "unknown-event-name");
      }
      if (error instanceof UnsupportedEventVersion) {
        throw replayEventInvalid(row, "unsupported-event-version");
      }
      throw replayEventInvalid(row, "event-payload-invalid");
    }

    try {
      return decodeEventEnvelope({
        eventId: row.event_id,
        globalSequence: row.global_sequence,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        aggregateVersion: row.aggregate_version,
        eventName: row.event_name,
        eventVersion: row.event_version,
        hostId: row.host_id,
        correlationId: row.correlation_id,
        ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
        actor: decodeJournalActor(row),
        occurredAt: row.occurred_at,
        payload,
      });
    } catch {
      throw replayEventInvalid(row, "event-envelope-invalid");
    }
  }
}

function serializeActorJson(actor: Schema.Schema.Type<typeof EventActor>): string {
  return JSON.stringify(actor);
}

function decodeJournalActor(row: JournalRow): Schema.Schema.Type<typeof EventActor> {
  if (row.actor_json !== null && row.actor_json !== undefined && row.actor_json.length > 0) {
    return decodeEventActor(JSON.parse(row.actor_json));
  }
  // Pre-migration rows only stored kind + actorId (system / local-user).
  return decodeEventActor({ kind: row.actor_kind, actorId: row.actor_id });
}

function bindLocalHostAuthority(input: unknown): unknown {
  if (typeof input !== "object" || input === null || !("events" in input)) return input;
  const events = (input as { readonly events?: unknown }).events;
  if (!Array.isArray(events)) return input;
  return {
    ...input,
    events: events.map((event) =>
      typeof event === "object" && event !== null ? { hostId: LOCAL_HOST_ID, ...event } : event,
    ),
  };
}

function replayEventInvalid(
  row: JournalRow,
  reason: ConstructorParameters<typeof ReplayEventInvalid>[0]["reason"],
): ReplayEventInvalid {
  return new ReplayEventInvalid({
    eventId: row.event_id,
    globalSequence: row.global_sequence,
    eventName: row.event_name,
    eventVersion: row.event_version,
    reason,
  });
}

function serializeJsonPayload(payload: unknown, eventName: string, eventVersion: number): string {
  try {
    if (!isJsonValue(payload)) throw new Error("not JSON");
    const encoded = JSON.stringify(payload);
    if (encoded === undefined) throw new Error("not JSON");
    JSON.parse(encoded);
    return encoded;
  } catch {
    throw new EventPayloadInvalid({ eventName, eventVersion });
  }
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;

  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry, index) => index in value && isJsonValue(entry, ancestors))
    : (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null) &&
      Object.values(value).every((entry) => isJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function findDuplicate(values: ReadonlyArray<string>): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

/** Dotted payload keys a narrowed replay may read, so a caller cannot write its own JSON path. */
const PAYLOAD_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** An optional exclusive sequence bound: absent, or a positive safe integer. */
function validBound(sequence: number | undefined): boolean {
  return sequence === undefined || (Number.isSafeInteger(sequence) && sequence > 0);
}
