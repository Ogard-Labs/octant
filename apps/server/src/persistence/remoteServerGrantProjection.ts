import {
  REMOTE_SERVER_GRANT_CLOSED,
  REMOTE_SERVER_GRANT_OPENED,
  decodeRemoteServerGrantClosedPayload,
  decodeRemoteServerGrantOpenedPayload,
  type EventEnvelope,
  type RemoteServerGrantOpenedPayload,
} from "@octant/contracts";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

/**
 * Which remote server grants the journal records as open.
 *
 * A grant is bound to a proxy session that lives only in the host's memory, so
 * no grant outlives the host. The one question asked of this view is what a
 * starting host must close: every row still `open` is a grant whose session is
 * gone. Each event writes the whole row, so replay lands on the same state
 * however often it runs.
 */
export class RemoteServerGrantProjection implements Projection {
  readonly name = "remote-server-grant";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(`DELETE FROM remote_server_grant_projection;`);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    if (event.eventName === REMOTE_SERVER_GRANT_OPENED) {
      const opened = decodeRemoteServerGrantOpenedPayload(event.payload);
      write(connection, event, opened, "open", null);
      return;
    }
    if (event.eventName === REMOTE_SERVER_GRANT_CLOSED) {
      const closed = decodeRemoteServerGrantClosedPayload(event.payload);
      write(connection, event, closed, "closed", closed.reason);
    }
  }
}

function write(
  connection: SqliteConnection,
  event: EventEnvelope,
  grant: RemoteServerGrantOpenedPayload,
  state: "open" | "closed",
  reason: string | null,
): void {
  connection
    .prepare(
      `INSERT OR REPLACE INTO remote_server_grant_projection (
         grant_id, aggregate_id, device_id, thread_id, port, state, close_reason, last_sequence
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      String(grant.grantId),
      String(event.aggregateId),
      String(grant.deviceId),
      String(grant.threadId),
      Number(grant.port),
      state,
      reason,
      event.globalSequence,
    );
}

export interface OpenRemoteServerGrantRecord {
  /** The journal aggregate the grant's events live on. */
  readonly aggregateId: string;
  readonly grant: RemoteServerGrantOpenedPayload;
}

/** Grants the journal records as open, oldest first. */
export function readOpenRemoteServerGrants(
  connection: SqliteConnection,
): ReadonlyArray<OpenRemoteServerGrantRecord> {
  const rows = connection
    .prepare(
      `SELECT grant_id, aggregate_id, device_id, thread_id, port FROM remote_server_grant_projection
       WHERE state = 'open' ORDER BY last_sequence ASC`,
    )
    .all() as ReadonlyArray<{
    readonly grant_id: string;
    readonly aggregate_id: string;
    readonly device_id: string;
    readonly thread_id: string;
    readonly port: number;
  }>;
  return rows.map((row) => ({
    aggregateId: row.aggregate_id,
    grant: decodeRemoteServerGrantOpenedPayload({
      grantId: row.grant_id,
      deviceId: row.device_id,
      threadId: row.thread_id,
      port: row.port,
    }),
  }));
}
