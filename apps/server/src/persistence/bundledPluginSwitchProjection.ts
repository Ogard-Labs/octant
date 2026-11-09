import type { EventEnvelope } from "@octant/contracts/events";
import {
  BUNDLED_PLUGIN_SWITCH_AGGREGATE,
  BUNDLED_PLUGIN_SWITCH_EVENT_NAMES,
  decodeBundledPluginSwitched,
} from "@octant/contracts/extension-events";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

export const BUNDLED_PLUGIN_SWITCH_PROJECTION = "bundled-plugin-switches";

/**
 * The switch a person last set for each plugin built into Octant, rebuilt
 * from the switch events. A later event for the same plugin replaces the
 * earlier one, so a replay lands on the same answer.
 */
export class BundledPluginSwitchProjection implements Projection {
  readonly name = BUNDLED_PLUGIN_SWITCH_PROJECTION;
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec("DELETE FROM bundled_plugin_switch_projection;");
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1 || event.aggregateType !== BUNDLED_PLUGIN_SWITCH_AGGREGATE) return;
    if (event.eventName !== BUNDLED_PLUGIN_SWITCH_EVENT_NAMES.switched) return;
    const change = decodeBundledPluginSwitched(event.payload);
    if (String(change.extensionId) !== String(event.aggregateId)) {
      throw new Error("Bundled plugin switch does not match its plugin.");
    }
    connection
      .prepare(
        `INSERT INTO bundled_plugin_switch_projection (
          extension_id, desired, aggregate_version, last_sequence
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT (extension_id) DO UPDATE SET
          desired = excluded.desired,
          aggregate_version = excluded.aggregate_version,
          last_sequence = excluded.last_sequence
        WHERE excluded.aggregate_version > bundled_plugin_switch_projection.aggregate_version`,
      )
      .run(
        String(change.extensionId),
        change.desired ? 1 : 0,
        event.aggregateVersion,
        event.globalSequence,
      );
  }
}

/**
 * The switch for one bundled plugin and the version a change must name. A
 * plugin nobody switched is on at version 0.
 */
export function readBundledPluginSwitch(
  connection: SqliteConnection,
  extensionId: string,
): { readonly desired: boolean; readonly stateVersion: number } {
  const row = connection
    .prepare(
      `SELECT desired, aggregate_version FROM bundled_plugin_switch_projection
       WHERE extension_id = ?`,
    )
    .get(extensionId) as
    | { readonly desired: number; readonly aggregate_version: number }
    | undefined;
  return row === undefined
    ? { desired: true, stateVersion: 0 }
    : { desired: row.desired === 1, stateVersion: row.aggregate_version };
}
