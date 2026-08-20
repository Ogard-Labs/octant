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
  UnknownEventName,
  UnsupportedEventVersion,
} from "./journalErrors";
import { ProjectionApplicationFailed, ProjectionRegistry } from "./projection";
import type { SqliteConnection, SqliteStatement } from "./sqlitePort";

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
  readonly #hasActorJson: boolean;
  readonly #selectHead: SqliteStatement;
  readonly #insertEvent: SqliteStatement;
  readonly #upsertCheckpoint: SqliteStatement;
  readonly #selectEventIdentity: SqliteStatement;
  readonly #selectHeadSequence: SqliteStatement;
  readonly #replayRows: SqliteStatement;
  readonly #replayAggregateTypeRows: SqliteStatement;
  readonly #replayAggregateTypeThreadRows: SqliteStatement;
  readonly #replayAggregateRows: SqliteStatement;

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
    this.#replayAggregateTypeRows = options.connection.prepare(`
      SELECT
        global_sequence, event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, host_id, correlation_id, causation_id, actor_kind,
        actor_id, ${actorJsonSelect}, occurred_at, payload_json
      FROM event_journal
      WHERE aggregate_type = ? AND global_sequence > ?
      ORDER BY global_sequence ASC
      LIMIT ?
    `);
    // Filters on the payload's `threadId` in SQL so a per-thread read never
    // decodes other threads' rows: a dogfooding host whose journal was 94%
    // code-checkout observations made every thread history read exhaust its
    // scan bound on rows that were never the thread's. The `'$.threadId'` key
    // is the same payload ownership rule thread purge already relies on, and
    // every returned row still goes through the registered schema in
    // #decodeRow before a caller sees it.
    this.#replayAggregateTypeThreadRows = options.connection.prepare(`
      SELECT
        global_sequence, event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, host_id, correlation_id, causation_id, actor_kind,
        actor_id, ${actorJsonSelect}, occurred_at, payload_json
      FROM event_journal
      WHERE aggregate_type = ?
        AND json_extract(payload_json, '$.threadId') = ?
        AND global_sequence > ?
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
            this.#upsertCheckpoint.run(projection.name, event.globalSequence, this.#clock());
          }
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
        error instanceof ProjectionApplicationFailed
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

    try {
      this.#onCommitted?.(committed);
    } catch {
      // Publication is best-effort after commit. The durable journal remains
      // authoritative, so a subscriber failure cannot change append success.
    }
    return committed;
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

  replayAggregateType(cursor: {
    readonly aggregateType: string;
    readonly afterSequence: number;
    readonly limit: number;
  }): ReadonlyArray<EventEnvelope> {
    if (
      cursor.aggregateType.trim().length === 0 ||
      !Number.isSafeInteger(cursor.afterSequence) ||
      cursor.afterSequence < 0 ||
      !Number.isSafeInteger(cursor.limit) ||
      cursor.limit < 1 ||
      cursor.limit > 1_000
    ) {
      throw new JournalInputInvalid({ operation: "replay" });
    }
    return (
      this.#replayAggregateTypeRows.all(
        cursor.aggregateType,
        cursor.afterSequence,
        cursor.limit,
      ) as Array<JournalRow>
    ).map((row) => this.#decodeRow(row));
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
