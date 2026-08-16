import {
  AggregateId as AggregateIdSchema,
  AggregateVersion as AggregateVersionSchema,
  type AggregateVersion,
  type EnvironmentPresentationState,
  type EventEnvelope,
  type ShellSettings,
  type WindowId,
  type WindowWorkspace,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Projection } from "./projection";
import {
  decodePersistedEnvironmentPresentationReplaced,
  decodePersistedShellSettings,
  decodePersistedShellSettingsReplaced,
  decodePersistedWindowWorkspace,
  decodePersistedWorkspaceLayoutReplaced,
} from "./shellPersistenceSchema";
import type { SqliteConnection, SqliteStatement } from "./sqlitePort";

const SHELL_SCHEMA_VERSION = 1;
const SHELL_SETTINGS_KEY = "shell-settings";
const decodeAggregateId = Schema.decodeUnknownSync(AggregateIdSchema);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersionSchema);

export const SHELL_SETTINGS_AGGREGATE_ID = decodeAggregateId(
  "00000000-0000-4000-8000-000000000001",
);

export interface ProjectedShellSettings {
  readonly settings: ShellSettings;
  readonly aggregateVersion: AggregateVersion;
}

export interface ProjectedWindowWorkspace {
  readonly workspace: WindowWorkspace;
  readonly aggregateVersion: AggregateVersion;
}

export interface ProjectedEnvironmentPresentation {
  readonly presentation: EnvironmentPresentationState;
  readonly aggregateVersion: AggregateVersion;
}

interface ShellSettingsRow {
  readonly schema_version: number;
  readonly settings_json: string;
  readonly aggregate_version: number;
}

interface WindowWorkspaceRow {
  readonly schema_version: number;
  readonly workspace_json: string;
  readonly aggregate_version: number;
}

interface EnvironmentPresentationRow {
  readonly schema_version: number;
  readonly presentation_json: string;
  readonly aggregate_version: number;
}

export class ShellProjection implements Projection {
  readonly name = "shell";
  readonly dependencies: ReadonlyArray<string> = [];
  #settingsUpsertByConnection = new WeakMap<SqliteConnection, SqliteStatement>();
  #workspaceUpsertByConnection = new WeakMap<SqliteConnection, SqliteStatement>();
  #presentationUpsertByConnection = new WeakMap<SqliteConnection, SqliteStatement>();

  reset(connection: SqliteConnection): void {
    connection.exec(`
      DELETE FROM shell_settings_projection;
      DELETE FROM window_workspace_projection;
      DELETE FROM environment_presentation_projection;
    `);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventName === "shell.settings-replaced") {
      assertEnvelope(
        event.aggregateType === "shell-settings" &&
          event.aggregateId === SHELL_SETTINGS_AGGREGATE_ID,
      );
      const payload = decodePersistedShellSettingsReplaced(event.payload);
      this.#settingsUpsert(connection).run(
        SHELL_SETTINGS_KEY,
        SHELL_SCHEMA_VERSION,
        JSON.stringify(payload.settings),
        event.aggregateVersion,
      );
      return;
    }

    if (event.eventName === "workspace.layout-replaced") {
      const payload = decodePersistedWorkspaceLayoutReplaced(event.payload);
      assertEnvelope(
        event.aggregateType === "window-workspace" &&
          sameIdentity(event.aggregateId, payload.workspace.windowId) &&
          event.aggregateVersion === payload.workspace.version,
      );
      this.#workspaceUpsert(connection).run(
        payload.workspace.windowId,
        SHELL_SCHEMA_VERSION,
        JSON.stringify(payload.workspace),
        event.aggregateVersion,
      );
      return;
    }

    if (event.eventName === "shell.environment-presentation-replaced") {
      const payload = decodePersistedEnvironmentPresentationReplaced(event.payload);
      assertEnvelope(
        event.aggregateType === "environment-presentation" &&
          typeof event.aggregateId === "string" &&
          event.aggregateId.trim().length > 0,
      );
      this.#presentationUpsert(connection).run(
        event.aggregateId,
        SHELL_SCHEMA_VERSION,
        JSON.stringify(payload.presentation),
        event.aggregateVersion,
      );
    }
  }

  #settingsUpsert(connection: SqliteConnection): SqliteStatement {
    let statement = this.#settingsUpsertByConnection.get(connection);
    if (statement === undefined) {
      statement = connection.prepare(`
        INSERT INTO shell_settings_projection (
          projection_key, schema_version, settings_json, aggregate_version
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT (projection_key) DO UPDATE SET
          schema_version = excluded.schema_version,
          settings_json = excluded.settings_json,
          aggregate_version = excluded.aggregate_version
        WHERE excluded.aggregate_version > shell_settings_projection.aggregate_version
      `);
      this.#settingsUpsertByConnection.set(connection, statement);
    }
    return statement;
  }

  #workspaceUpsert(connection: SqliteConnection): SqliteStatement {
    let statement = this.#workspaceUpsertByConnection.get(connection);
    if (statement === undefined) {
      statement = connection.prepare(`
        INSERT INTO window_workspace_projection (
          window_id, schema_version, workspace_json, aggregate_version
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT (window_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          workspace_json = excluded.workspace_json,
          aggregate_version = excluded.aggregate_version
        WHERE excluded.aggregate_version > window_workspace_projection.aggregate_version
      `);
      this.#workspaceUpsertByConnection.set(connection, statement);
    }
    return statement;
  }

  #presentationUpsert(connection: SqliteConnection): SqliteStatement {
    let statement = this.#presentationUpsertByConnection.get(connection);
    if (statement === undefined) {
      statement = connection.prepare(`
        INSERT INTO environment_presentation_projection (
          window_id, schema_version, presentation_json, aggregate_version
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT (window_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          presentation_json = excluded.presentation_json,
          aggregate_version = excluded.aggregate_version
        WHERE excluded.aggregate_version > environment_presentation_projection.aggregate_version
      `);
      this.#presentationUpsertByConnection.set(connection, statement);
    }
    return statement;
  }
}

function assertEnvelope(condition: boolean): asserts condition {
  if (!condition) throw new Error("shell projection event envelope is inconsistent");
}

function sameIdentity(left: string, right: string): boolean {
  return left === right;
}

export function readShellSettings(
  connection: SqliteConnection,
): ProjectedShellSettings | undefined {
  const row = connection
    .prepare(`
      SELECT schema_version, settings_json, aggregate_version
      FROM shell_settings_projection
      WHERE projection_key = ?
    `)
    .get(SHELL_SETTINGS_KEY) as ShellSettingsRow | undefined;
  if (row === undefined) return undefined;
  assertCurrentSchema(row.schema_version);
  return {
    settings: decodePersistedShellSettings(JSON.parse(row.settings_json)),
    aggregateVersion: decodeAggregateVersion(row.aggregate_version),
  };
}

export function readWindowWorkspace(
  connection: SqliteConnection,
  windowId: WindowId,
): ProjectedWindowWorkspace | undefined {
  const row = connection
    .prepare(`
      SELECT schema_version, workspace_json, aggregate_version
      FROM window_workspace_projection
      WHERE window_id = ?
    `)
    .get(windowId) as WindowWorkspaceRow | undefined;
  if (row === undefined) return undefined;
  return decodeWorkspaceRow(row);
}

export function readWindowWorkspaces(
  connection: SqliteConnection,
): ReadonlyArray<ProjectedWindowWorkspace> {
  const rows = connection
    .prepare(`
      SELECT schema_version, workspace_json, aggregate_version
      FROM window_workspace_projection
      ORDER BY window_id
    `)
    .all() as ReadonlyArray<WindowWorkspaceRow>;
  return rows.map(decodeWorkspaceRow);
}

export function readEnvironmentPresentation(
  connection: SqliteConnection,
  windowId: WindowId,
): ProjectedEnvironmentPresentation | undefined {
  const row = connection
    .prepare(`
      SELECT schema_version, presentation_json, aggregate_version
      FROM environment_presentation_projection
      WHERE window_id = ?
    `)
    .get(windowId) as EnvironmentPresentationRow | undefined;
  if (row === undefined) return undefined;
  assertCurrentSchema(row.schema_version);
  return {
    presentation: decodePersistedEnvironmentPresentationReplaced({
      presentation: JSON.parse(row.presentation_json),
    }).presentation,
    aggregateVersion: decodeAggregateVersion(row.aggregate_version),
  };
}

function decodeWorkspaceRow(row: WindowWorkspaceRow): ProjectedWindowWorkspace {
  assertCurrentSchema(row.schema_version);
  return {
    workspace: decodePersistedWindowWorkspace(JSON.parse(row.workspace_json)),
    aggregateVersion: decodeAggregateVersion(row.aggregate_version),
  };
}

function assertCurrentSchema(schemaVersion: number): void {
  if (schemaVersion !== SHELL_SCHEMA_VERSION) {
    throw new Error("unsupported shell projection schema version");
  }
}
