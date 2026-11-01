import type { EventEnvelope } from "@octant/contracts/events";
import {
  THREAD_NATIVE_SETUP_AGGREGATE,
  THREAD_NATIVE_SETUP_EVENT_NAMES,
  decodeThreadNativeSetupChanged,
  type ThreadNativeSetupChoice,
} from "@octant/contracts/thread-native-setup";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

export const THREAD_NATIVE_SETUP_PROJECTION = "thread-native-setup";

/**
 * Each thread's own choice about its provider's native setup, rebuilt from
 * the change events. A later event for the same thread replaces the earlier
 * one; `inherit` keeps its row so a replay lands on the same answer whichever
 * event it reaches last.
 */
export class ThreadNativeSetupProjection implements Projection {
  readonly name = THREAD_NATIVE_SETUP_PROJECTION;
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec("DELETE FROM thread_native_setup_projection;");
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1 || event.aggregateType !== THREAD_NATIVE_SETUP_AGGREGATE) return;
    if (event.eventName !== THREAD_NATIVE_SETUP_EVENT_NAMES.changed) return;
    const change = decodeThreadNativeSetupChanged(event.payload);
    if (change.threadId !== String(event.aggregateId)) {
      throw new Error("Thread native setup choice does not match its thread.");
    }
    connection
      .prepare(
        `INSERT INTO thread_native_setup_projection (
          thread_id, choice, aggregate_version, last_sequence
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT (thread_id) DO UPDATE SET
          choice = excluded.choice,
          aggregate_version = excluded.aggregate_version,
          last_sequence = excluded.last_sequence
        WHERE excluded.aggregate_version > thread_native_setup_projection.aggregate_version`,
      )
      .run(change.threadId, change.choice, event.aggregateVersion, event.globalSequence);
  }
}

/** The thread's own choice, or undefined when it inherits. */
export function readThreadNativeSetup(
  connection: SqliteConnection,
  threadId: string,
): Exclude<ThreadNativeSetupChoice, "inherit"> | undefined {
  const row = connection
    .prepare("SELECT choice FROM thread_native_setup_projection WHERE thread_id = ?")
    .get(threadId) as { readonly choice: ThreadNativeSetupChoice } | undefined;
  return row === undefined || row.choice === "inherit" ? undefined : row.choice;
}
