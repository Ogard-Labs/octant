import type { EventEnvelope } from "@octant/contracts/events";
import {
  EXTENSION_PROJECT_PIN_AGGREGATE,
  EXTENSION_PROJECT_PIN_EVENT_NAMES,
  decodeExtensionProjectPinChanged,
} from "@octant/contracts/extension-events";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

export const EXTENSION_PROJECT_PIN_PROJECTION = "extension-project-pins";

interface PinRow {
  readonly project_id: string;
  readonly extension_id: string;
}

/**
 * Which plugins are pinned to which Projects, rebuilt from the pin events.
 * A later event for the same Project and plugin replaces the earlier one;
 * an unpin keeps its row with `pinned = 0` so a replay lands on the same
 * answer whichever event it reaches last.
 */
export class ExtensionProjectPinProjection implements Projection {
  readonly name = EXTENSION_PROJECT_PIN_PROJECTION;
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec("DELETE FROM extension_project_pin_projection;");
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1 || event.aggregateType !== EXTENSION_PROJECT_PIN_AGGREGATE) return;
    if (event.eventName !== EXTENSION_PROJECT_PIN_EVENT_NAMES.changed) return;
    const change = decodeExtensionProjectPinChanged(event.payload);
    if (String(change.projectId) !== String(event.aggregateId)) {
      throw new Error("Extension Project pin does not match its Project.");
    }
    connection
      .prepare(
        `INSERT INTO extension_project_pin_projection (
          project_id, extension_id, pinned, aggregate_version, last_sequence
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (project_id, extension_id) DO UPDATE SET
          pinned = excluded.pinned,
          aggregate_version = excluded.aggregate_version,
          last_sequence = excluded.last_sequence
        WHERE excluded.aggregate_version > extension_project_pin_projection.aggregate_version`,
      )
      .run(
        String(change.projectId),
        String(change.extensionId),
        change.pinned ? 1 : 0,
        event.aggregateVersion,
        event.globalSequence,
      );
  }
}

/** The pinned plugins of one Project, or of every Project when none is named. */
export function readExtensionProjectPins(
  connection: SqliteConnection,
  projectId?: string,
): ReadonlyArray<{ readonly projectId: string; readonly extensionId: string }> {
  const rows = (
    projectId === undefined
      ? connection
          .prepare(
            `SELECT project_id, extension_id FROM extension_project_pin_projection
             WHERE pinned = 1 ORDER BY project_id, extension_id`,
          )
          .all()
      : connection
          .prepare(
            `SELECT project_id, extension_id FROM extension_project_pin_projection
             WHERE pinned = 1 AND project_id = ? ORDER BY extension_id`,
          )
          .all(projectId)
  ) as PinRow[];
  return rows.map((row) => ({ projectId: row.project_id, extensionId: row.extension_id }));
}
