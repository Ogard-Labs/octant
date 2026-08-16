import type { EventEnvelope } from "@octant/contracts";
import type { Projection } from "./projection";
import type { SqliteConnection, SqliteStatement } from "./sqlitePort";

export class AggregateHeadsProjection implements Projection {
  readonly name = "aggregate-heads";
  readonly dependencies: ReadonlyArray<string> = [];
  #upsertByConnection = new WeakMap<SqliteConnection, SqliteStatement>();

  reset(connection: SqliteConnection): void {
    connection.exec("DELETE FROM aggregate_heads");
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    let upsert = this.#upsertByConnection.get(connection);
    if (upsert === undefined) {
      upsert = connection.prepare(`
        INSERT INTO aggregate_heads (
          aggregate_type, aggregate_id, aggregate_version, last_sequence
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT (aggregate_type, aggregate_id) DO UPDATE SET
          aggregate_version = excluded.aggregate_version,
          last_sequence = excluded.last_sequence
        WHERE excluded.last_sequence > aggregate_heads.last_sequence
      `);
      this.#upsertByConnection.set(connection, upsert);
    }
    upsert.run(
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.globalSequence,
    );
  }
}
