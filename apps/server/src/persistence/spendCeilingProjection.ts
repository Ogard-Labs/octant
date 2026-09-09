import {
  SPEND_CEILING_AGGREGATE_TYPE,
  SPEND_CEILING_EVENT_NAMES,
  decodeSpendCeilingCleared,
  decodeSpendCeilingOverrunRecorded,
  decodeSpendCeilingRaised,
  decodeSpendCeilingSet,
  decodeSpendCeilingState,
  type EventEnvelope,
  type SpendCeilingScope,
  type SpendCeilingState,
} from "@octant/contracts";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";
import {
  spendCeilingScopeKey,
  type SpendCeilingProjectionRow,
} from "./spendCeilingPersistenceSchema";

export class SpendCeilingProjection implements Projection {
  readonly name = "spend-ceilings";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec("DELETE FROM spend_ceiling_projection;");
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1 || event.aggregateType !== SPEND_CEILING_AGGREGATE_TYPE) {
      return;
    }
    if (event.eventName === SPEND_CEILING_EVENT_NAMES.set) {
      this.#upsert(connection, event, decodeSpendCeilingSet(event.payload).ceiling);
      return;
    }
    if (event.eventName === SPEND_CEILING_EVENT_NAMES.raised) {
      this.#upsert(connection, event, decodeSpendCeilingRaised(event.payload).ceiling);
      return;
    }
    if (event.eventName === SPEND_CEILING_EVENT_NAMES.cleared) {
      const payload = decodeSpendCeilingCleared(event.payload);
      connection
        .prepare("DELETE FROM spend_ceiling_projection WHERE scope_kind = ? AND scope_key = ?")
        .run(payload.scope.kind, scopeKey(payload.scope));
      return;
    }
    if (event.eventName === SPEND_CEILING_EVENT_NAMES.overrunRecorded) {
      const payload = decodeSpendCeilingOverrunRecorded(event.payload);
      const existing = readSpendCeiling(connection, payload.scope);
      if (existing === undefined) return;
      this.#upsert(connection, event, {
        ...existing,
        overrun: {
          reservedTokens: payload.reservedTokens,
          observedTokens: payload.observedTokens,
          recordedAt: payload.recordedAt,
        },
      });
    }
  }

  #upsert(connection: SqliteConnection, event: EventEnvelope, ceiling: SpendCeilingState): void {
    connection
      .prepare(
        `INSERT INTO spend_ceiling_projection (
          scope_kind, scope_key, thread_type, window_json, policy_json, overrun_json,
          set_at, set_by_json, aggregate_version, last_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (scope_kind, scope_key) DO UPDATE SET
          thread_type = excluded.thread_type,
          window_json = excluded.window_json,
          policy_json = excluded.policy_json,
          overrun_json = excluded.overrun_json,
          set_at = excluded.set_at,
          set_by_json = excluded.set_by_json,
          aggregate_version = excluded.aggregate_version,
          last_sequence = excluded.last_sequence
        WHERE excluded.last_sequence > spend_ceiling_projection.last_sequence`,
      )
      .run(
        ceiling.scope.kind,
        scopeKey(ceiling.scope),
        ceiling.scope.kind === "thread" ? ceiling.scope.threadType : null,
        JSON.stringify(ceiling.window),
        JSON.stringify(ceiling.policy),
        ceiling.overrun === undefined ? null : JSON.stringify(ceiling.overrun),
        ceiling.setAt,
        JSON.stringify(ceiling.setBy),
        ceiling.version,
        event.globalSequence,
      );
  }
}

function scopeKey(scope: SpendCeilingScope): string {
  return spendCeilingScopeKey({
    kind: scope.kind,
    id: scope.kind === "project" ? String(scope.projectId) : String(scope.threadId),
  });
}

export function readSpendCeiling(
  connection: SqliteConnection,
  scope: SpendCeilingScope,
): SpendCeilingState | undefined {
  const row = connection
    .prepare("SELECT * FROM spend_ceiling_projection WHERE scope_kind = ? AND scope_key = ?")
    .get(scope.kind, scopeKey(scope)) as SpendCeilingProjectionRow | undefined;
  if (row === undefined) return undefined;
  return decodeRow(row);
}

function decodeRow(row: SpendCeilingProjectionRow): SpendCeilingState {
  const scope: SpendCeilingScope =
    row.scope_kind === "project"
      ? { kind: "project", projectId: row.scope_key as never }
      : {
          kind: "thread",
          threadType: row.thread_type ?? "chat-thread",
          threadId: row.scope_key,
        };
  return decodeSpendCeilingState({
    scope,
    window: JSON.parse(row.window_json) as unknown,
    policy: JSON.parse(row.policy_json) as unknown,
    version: row.aggregate_version,
    setAt: row.set_at,
    setBy: JSON.parse(row.set_by_json) as unknown,
    ...(row.overrun_json === null ? {} : { overrun: JSON.parse(row.overrun_json) as unknown }),
  });
}
