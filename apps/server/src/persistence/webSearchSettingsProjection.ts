import {
  WEB_SEARCH_SETTINGS_AGGREGATE_TYPE,
  WEB_SEARCH_SETTINGS_EVENT_NAME,
  decodeWebSearchSettings,
  decodeWebSearchSettingsChanged,
  type EventEnvelope,
  type WebSearchSettings,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

/** The one aggregate that holds the host's web search backends and data policy. */
export const WEB_SEARCH_SETTINGS_AGGREGATE_ID = Schema.decodeUnknownSync(
  Schema.UUID.pipe(Schema.brand("AggregateId")),
)("00000000-0000-4000-8000-000000000034");

export class WebSearchSettingsProjection implements Projection {
  readonly name = "web-search-settings";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec("DELETE FROM web_search_settings_projection;");
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (
      event.eventVersion !== 1 ||
      event.aggregateType !== WEB_SEARCH_SETTINGS_AGGREGATE_TYPE ||
      event.eventName !== WEB_SEARCH_SETTINGS_EVENT_NAME
    ) {
      return;
    }
    const change = decodeWebSearchSettingsChanged(event.payload);
    connection
      .prepare(
        `INSERT INTO web_search_settings_projection (
          singleton, settings_json, changed_at, aggregate_version, last_sequence
        ) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT (singleton) DO UPDATE SET
          settings_json = excluded.settings_json,
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
 * The settings the person saved, or `undefined` when they never saved any. A
 * stored value that no longer decodes reads as an empty list under the
 * strictest policy: no query should leave the host on settings Octant cannot
 * read, and the journal keeps what was written.
 */
export function readSavedWebSearchSettings(
  connection: SqliteConnection,
): WebSearchSettings | undefined {
  const row = connection
    .prepare("SELECT settings_json FROM web_search_settings_projection WHERE singleton = 1")
    .get() as { readonly settings_json: string } | undefined;
  if (row === undefined) return undefined;
  try {
    return decodeWebSearchSettings(JSON.parse(row.settings_json));
  } catch {
    return { policy: "eu-and-zdr", backends: [] };
  }
}
