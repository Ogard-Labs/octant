import {
  AggregateId as AggregateIdSchema,
  decodeProviderDefaults,
  decodeProviderDefaultsUpdated,
  decodeProviderCatalogUpdated,
  decodeProviderInstance,
  decodeProviderInstanceBinaryChanged,
  decodeProviderInstanceConfigurationChanged,
  decodeProviderInstanceCreated,
  decodeProviderInstanceEnabledChanged,
  decodeProviderInstanceRemoved,
  decodeProviderInstanceRenamed,
  type EventEnvelope,
  type ProviderDefaults,
  type ProviderCatalogSnapshot,
  type ProviderInstance,
  type ProviderInstanceId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Projection } from "../persistence/projection";
import type { SqliteConnection, SqliteStatement } from "../persistence/sqlitePort";
import {
  assertProviderProjectionSchema,
  PROVIDER_DEFAULTS_PROJECTION_KEY,
  PROVIDER_CATALOG_PROJECTION_SCHEMA_VERSION,
  PROVIDER_PROJECTION_SCHEMA_VERSION,
  type ProviderCatalogProjectionRow,
  type ProviderDefaultsProjectionRow,
  type ProviderInstanceProjectionRow,
} from "./providerPersistenceSchema";

const instanceDecoders = {
  "provider.instance-created@1": (payload: unknown) =>
    decodeProviderInstanceCreated(payload).instance,
  "provider.instance-renamed@1": (payload: unknown) =>
    decodeProviderInstanceRenamed(payload).instance,
  "provider.instance-binary-changed@1": (payload: unknown) =>
    decodeProviderInstanceBinaryChanged(payload).instance,
  "provider.instance-configuration-changed@1": (payload: unknown) =>
    decodeProviderInstanceConfigurationChanged(payload).instance,
  "provider.instance-enabled-changed@1": (payload: unknown) =>
    decodeProviderInstanceEnabledChanged(payload).instance,
} as const;

const decodeAggregateId = Schema.decodeUnknownSync(AggregateIdSchema);
export const PROVIDER_DEFAULTS_AGGREGATE_ID = decodeAggregateId(
  "00000000-0000-4000-8000-000000000003",
);

export class ProviderProjection implements Projection {
  readonly name = "providers";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];
  #instanceUpsertByConnection = new WeakMap<SqliteConnection, SqliteStatement>();
  #instanceRemoveByConnection = new WeakMap<SqliteConnection, SqliteStatement>();
  #defaultsUpsertByConnection = new WeakMap<SqliteConnection, SqliteStatement>();
  #catalogUpsertByConnection = new WeakMap<SqliteConnection, SqliteStatement>();
  #aggregateHeadByConnection = new WeakMap<SqliteConnection, SqliteStatement>();

  reset(connection: SqliteConnection): void {
    connection.exec(`
      DELETE FROM provider_instance_projection;
      DELETE FROM provider_defaults_projection;
      DELETE FROM provider_catalog_projection;
    `);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (isInstanceSnapshotEvent(event.eventName)) {
      assertEnvelope(event.eventVersion === 1 && event.aggregateType === "provider-instance");
      const instance = instanceDecoders[event.eventName as keyof typeof instanceDecoders](
        event.payload,
      );
      assertEnvelope(
        String(instance.id) === String(event.aggregateId) &&
          instance.version === event.aggregateVersion,
      );
      if (this.#isStale(connection, event)) return;
      this.#upsertInstance(connection, instance);
      return;
    }

    if (event.eventName === "provider.instance-removed@1") {
      assertEnvelope(event.eventVersion === 1 && event.aggregateType === "provider-instance");
      const removed = decodeProviderInstanceRemoved(event.payload);
      assertEnvelope(
        String(removed.instanceId) === String(event.aggregateId) &&
          removed.version === event.aggregateVersion,
      );
      if (this.#isStale(connection, event)) return;
      this.#removeInstance(connection, removed.instanceId, removed.version);
      return;
    }

    if (event.eventName === "provider.defaults-updated@1") {
      assertEnvelope(
        event.eventVersion === 1 &&
          event.aggregateType === "provider-defaults" &&
          event.aggregateId === PROVIDER_DEFAULTS_AGGREGATE_ID,
      );
      const defaults = decodeProviderDefaultsUpdated(event.payload).defaults;
      assertEnvelope(defaults.version === event.aggregateVersion);
      if (this.#isStale(connection, event)) return;
      this.#upsertDefaults(connection, defaults);
      return;
    }

    if (event.eventName === "provider.catalog-updated@1") {
      assertEnvelope(event.eventVersion === 1 && event.aggregateType === "provider-catalog");
      const snapshot = decodeProviderCatalogUpdated(event.payload).snapshot;
      assertEnvelope(
        String(snapshot.instanceId) === String(event.aggregateId) &&
          snapshot.version === event.aggregateVersion,
      );
      if (this.#isStale(connection, event)) return;
      this.#upsertCatalog(connection, snapshot);
    }
  }

  #isStale(connection: SqliteConnection, event: EventEnvelope): boolean {
    let statement = this.#aggregateHeadByConnection.get(connection);
    if (statement === undefined) {
      statement = connection.prepare(`
        SELECT aggregate_version
        FROM aggregate_heads
        WHERE aggregate_type = ? AND aggregate_id = ?
      `);
      this.#aggregateHeadByConnection.set(connection, statement);
    }
    const row = statement.get(event.aggregateType, event.aggregateId) as
      | { readonly aggregate_version: number }
      | undefined;
    return row !== undefined && event.aggregateVersion < row.aggregate_version;
  }

  #upsertInstance(connection: SqliteConnection, instance: ProviderInstance): void {
    let statement = this.#instanceUpsertByConnection.get(connection);
    if (statement === undefined) {
      statement = connection.prepare(`
        INSERT INTO provider_instance_projection (
          instance_id, schema_version, driver_kind, enabled, instance_json, aggregate_version
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (instance_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          driver_kind = excluded.driver_kind,
          enabled = excluded.enabled,
          instance_json = excluded.instance_json,
          aggregate_version = excluded.aggregate_version
        WHERE excluded.aggregate_version > provider_instance_projection.aggregate_version
      `);
      this.#instanceUpsertByConnection.set(connection, statement);
    }
    statement.run(
      instance.id,
      PROVIDER_PROJECTION_SCHEMA_VERSION,
      instance.driverKind,
      instance.enabled ? 1 : 0,
      JSON.stringify(instance),
      instance.version,
    );
  }

  #removeInstance(
    connection: SqliteConnection,
    instanceId: ProviderInstanceId,
    aggregateVersion: number,
  ): void {
    let statement = this.#instanceRemoveByConnection.get(connection);
    if (statement === undefined) {
      statement = connection.prepare(`
        DELETE FROM provider_instance_projection
        WHERE instance_id = ? AND aggregate_version < ?
      `);
      this.#instanceRemoveByConnection.set(connection, statement);
    }
    statement.run(instanceId, aggregateVersion);
  }

  #upsertDefaults(connection: SqliteConnection, defaults: ProviderDefaults): void {
    let statement = this.#defaultsUpsertByConnection.get(connection);
    if (statement === undefined) {
      statement = connection.prepare(`
        INSERT INTO provider_defaults_projection (
          projection_key, schema_version, defaults_json, aggregate_version
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT (projection_key) DO UPDATE SET
          schema_version = excluded.schema_version,
          defaults_json = excluded.defaults_json,
          aggregate_version = excluded.aggregate_version
        WHERE excluded.aggregate_version > provider_defaults_projection.aggregate_version
      `);
      this.#defaultsUpsertByConnection.set(connection, statement);
    }
    statement.run(
      PROVIDER_DEFAULTS_PROJECTION_KEY,
      PROVIDER_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(defaults),
      defaults.version,
    );
  }

  #upsertCatalog(connection: SqliteConnection, snapshot: ProviderCatalogSnapshot): void {
    let statement = this.#catalogUpsertByConnection.get(connection);
    if (statement === undefined) {
      statement = connection.prepare(`
        INSERT INTO provider_catalog_projection (
          instance_id, schema_version, catalog_json, aggregate_version
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT (instance_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          catalog_json = excluded.catalog_json,
          aggregate_version = excluded.aggregate_version
        WHERE excluded.aggregate_version > provider_catalog_projection.aggregate_version
      `);
      this.#catalogUpsertByConnection.set(connection, statement);
    }
    statement.run(
      snapshot.instanceId,
      PROVIDER_CATALOG_PROJECTION_SCHEMA_VERSION,
      JSON.stringify(snapshot),
      snapshot.version,
    );
  }
}

function isInstanceSnapshotEvent(eventName: string): eventName is keyof typeof instanceDecoders {
  return eventName in instanceDecoders;
}

function assertEnvelope(condition: boolean): asserts condition {
  if (!condition) throw new Error("Provider projection event envelope is inconsistent");
}

export function readProviderInstance(
  connection: SqliteConnection,
  instanceId: ProviderInstanceId,
): ProviderInstance | undefined {
  const row = connection
    .prepare(`
      SELECT instance_id, schema_version, driver_kind, enabled,
             instance_json, aggregate_version
      FROM provider_instance_projection
      WHERE instance_id = ?
    `)
    .get(instanceId) as ProviderInstanceProjectionRow | undefined;
  return row === undefined ? undefined : decodeInstanceRow(row);
}

export function readProviderInstances(
  connection: SqliteConnection,
): ReadonlyArray<ProviderInstance> {
  const rows = connection
    .prepare(`
      SELECT instance_id, schema_version, driver_kind, enabled,
             instance_json, aggregate_version
      FROM provider_instance_projection
      ORDER BY instance_id
    `)
    .all() as ReadonlyArray<ProviderInstanceProjectionRow>;
  return rows.map(decodeInstanceRow);
}

export function readProviderDefaults(connection: SqliteConnection): ProviderDefaults {
  const row = connection
    .prepare(`
      SELECT projection_key, schema_version, defaults_json, aggregate_version
      FROM provider_defaults_projection
      WHERE projection_key = ?
    `)
    .get(PROVIDER_DEFAULTS_PROJECTION_KEY) as ProviderDefaultsProjectionRow | undefined;
  if (row === undefined) {
    return decodeProviderDefaults({ permissionPersistence: "current-session", version: 0 });
  }
  assertProviderProjectionSchema(row.schema_version);
  assertEnvelope(row.projection_key === PROVIDER_DEFAULTS_PROJECTION_KEY);
  const defaults = decodeProviderDefaults(JSON.parse(row.defaults_json));
  assertEnvelope(defaults.version === row.aggregate_version);
  return defaults;
}

export function readProviderCatalog(
  connection: SqliteConnection,
  instanceId: ProviderInstanceId,
): ProviderCatalogSnapshot | undefined {
  const row = connection
    .prepare(`
      SELECT instance_id, schema_version, catalog_json, aggregate_version
      FROM provider_catalog_projection
      WHERE instance_id = ?
    `)
    .get(instanceId) as ProviderCatalogProjectionRow | undefined;
  return row === undefined ? undefined : decodeCatalogRow(row);
}

export function readProviderCatalogs(
  connection: SqliteConnection,
): ReadonlyArray<ProviderCatalogSnapshot> {
  const rows = connection
    .prepare(`
      SELECT instance_id, schema_version, catalog_json, aggregate_version
      FROM provider_catalog_projection
      ORDER BY instance_id
    `)
    .all() as ReadonlyArray<ProviderCatalogProjectionRow>;
  return rows.map(decodeCatalogRow);
}

function decodeInstanceRow(row: ProviderInstanceProjectionRow): ProviderInstance {
  assertProviderProjectionSchema(row.schema_version);
  const instance = decodeProviderInstance(JSON.parse(row.instance_json));
  assertEnvelope(
    String(instance.id) === row.instance_id &&
      instance.driverKind === row.driver_kind &&
      instance.enabled === (row.enabled === 1) &&
      instance.version === row.aggregate_version,
  );
  return instance;
}

function decodeCatalogRow(row: ProviderCatalogProjectionRow): ProviderCatalogSnapshot {
  if (row.schema_version !== PROVIDER_CATALOG_PROJECTION_SCHEMA_VERSION) {
    throw new Error("unsupported provider catalog projection schema version");
  }
  const snapshot = decodeProviderCatalogUpdated({
    snapshot: JSON.parse(row.catalog_json),
  }).snapshot;
  assertEnvelope(
    String(snapshot.instanceId) === row.instance_id && snapshot.version === row.aggregate_version,
  );
  return snapshot;
}
