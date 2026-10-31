import {
  HOST_MEMORY_LIMITS_AGGREGATE_TYPE,
  HOST_MEMORY_LIMITS_EVENT_NAME,
  decodeHostMemoryLimits,
  decodeHostMemoryLimitsChanged,
  type EventEnvelope,
  type HostMemoryLimits,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

/** The one aggregate that holds the host's memory limits. */
export const HOST_MEMORY_LIMITS_AGGREGATE_ID = Schema.decodeUnknownSync(
  Schema.UUID.pipe(Schema.brand("AggregateId")),
)("00000000-0000-4000-8000-000000000033");

export class HostMemoryLimitsProjection implements Projection {
  readonly name = "host-memory-limits";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec("DELETE FROM host_memory_limits_projection;");
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (
      event.eventVersion !== 1 ||
      event.aggregateType !== HOST_MEMORY_LIMITS_AGGREGATE_TYPE ||
      event.eventName !== HOST_MEMORY_LIMITS_EVENT_NAME
    ) {
      return;
    }
    const change = decodeHostMemoryLimitsChanged(event.payload);
    connection
      .prepare(
        `INSERT INTO host_memory_limits_projection (
          singleton, limits_json, changed_at, aggregate_version, last_sequence
        ) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT (singleton) DO UPDATE SET
          limits_json = excluded.limits_json,
          changed_at = excluded.changed_at,
          aggregate_version = excluded.aggregate_version,
          last_sequence = excluded.last_sequence`,
      )
      .run(
        JSON.stringify(change.next),
        change.changedAt,
        event.aggregateVersion,
        event.globalSequence,
      );
  }
}

/**
 * The limits the person chose, or automatic when none was ever saved. A stored
 * value that no longer decodes reads as automatic too: the built-in limits are
 * the safe reading, and the journal keeps what was written.
 */
export function readHostMemoryLimits(connection: SqliteConnection): HostMemoryLimits {
  const row = connection
    .prepare("SELECT limits_json FROM host_memory_limits_projection WHERE singleton = 1")
    .get() as { readonly limits_json: string } | undefined;
  if (row === undefined) return { kind: "automatic" };
  try {
    return decodeHostMemoryLimits(JSON.parse(row.limits_json));
  } catch {
    return { kind: "automatic" };
  }
}
