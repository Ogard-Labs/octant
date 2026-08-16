import {
  AggregateId as AggregateIdSchema,
  decodeThemeSettings,
  decodeThemeSettingsUpdated,
  type EventEnvelope,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Projection } from "./projection";
import type { SqliteConnection, SqliteStatement } from "./sqlitePort";
import {
  assertThemeProjectionSchema,
  THEME_PROJECTION_SCHEMA_VERSION,
  THEME_SETTINGS_KEY,
  type ProjectedThemeSettings,
} from "./themePersistenceSchema";

export type { ProjectedThemeSettings } from "./themePersistenceSchema";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateIdSchema);
export const THEME_SETTINGS_AGGREGATE_ID = decodeAggregateId(
  "00000000-0000-4000-8000-000000000020",
);

const THEME_EVENTS = new Set(["theme.settings-updated@1"]);

export class ThemeProjection implements Projection {
  readonly name = "theme";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];
  #upsertByConnection = new WeakMap<SqliteConnection, SqliteStatement>();

  reset(connection: SqliteConnection): void {
    connection.exec("DELETE FROM theme_settings_projection;");
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (!THEME_EVENTS.has(event.eventName)) return;
    if (event.eventName !== "theme.settings-updated@1") return;
    if (
      event.aggregateType !== "theme-settings" ||
      event.aggregateId !== THEME_SETTINGS_AGGREGATE_ID
    ) {
      throw new Error("Theme projection event envelope is inconsistent");
    }
    const settings = decodeThemeSettingsUpdated(event.payload).settings;
    this.upsert(connection).run(
      THEME_SETTINGS_KEY,
      THEME_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(settings),
      event.aggregateVersion,
    );
  }

  private upsert(connection: SqliteConnection): SqliteStatement {
    const cached = this.#upsertByConnection.get(connection);
    if (cached !== undefined) return cached;
    const statement = connection.prepare(`
      INSERT INTO theme_settings_projection (
        projection_key, schema_version, settings_json, aggregate_version
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT (projection_key) DO UPDATE SET
        schema_version = excluded.schema_version,
        settings_json = excluded.settings_json,
        aggregate_version = excluded.aggregate_version
      WHERE excluded.aggregate_version > theme_settings_projection.aggregate_version
    `);
    this.#upsertByConnection.set(connection, statement);
    return statement;
  }
}

export function readThemeSettings(
  connection: SqliteConnection,
): ProjectedThemeSettings | undefined {
  const row = connection
    .prepare(`
    SELECT schema_version, settings_json, aggregate_version
    FROM theme_settings_projection
    WHERE projection_key = ?
  `)
    .get(THEME_SETTINGS_KEY) as
    | {
        readonly schema_version: number;
        readonly settings_json: string;
        readonly aggregate_version: number;
      }
    | undefined;
  if (row === undefined) return undefined;
  assertThemeProjectionSchema(row.schema_version);
  return {
    settings: decodeThemeSettings(JSON.parse(row.settings_json)),
    aggregateVersion: row.aggregate_version,
  };
}
