import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeProviderInstance,
  decodeProviderCatalogSnapshot,
  type EventEnvelope,
  type ProviderDefaults,
  type ProviderInstance,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { PROVIDER_PROJECTION_SCHEMA_VERSION } from "./providerPersistenceSchema";
import {
  readProviderDefaults,
  readProviderCatalog,
  readProviderCatalogs,
  readProviderInstance,
  readProviderInstances,
  PROVIDER_DEFAULTS_AGGREGATE_ID,
} from "./providerProjection";

const directories: Array<string> = [];
const now = "2026-07-14T10:00:00.000Z";
const ids = {
  actor: "70000000-0000-4000-8000-000000000001",
  correlation: "70000000-0000-4000-8000-000000000002",
  instance: "70000000-0000-4000-8000-000000000003",
} as const;
const actor = { kind: "local-user" as const, actorId: ids.actor };

function instance(overrides: Record<string, unknown> = {}): ProviderInstance {
  return decodeProviderInstance({
    id: ids.instance,
    displayName: "OpenCode local",
    driverKind: "opencode",
    configuration: { kind: "opencode-cli", binaryPath: "/opt/homebrew/bin/opencode" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-provider-projection-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function envelope(input: {
  readonly eventName: string;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly aggregateVersion?: number;
  readonly payload: unknown;
}): EventEnvelope {
  return {
    eventId: crypto.randomUUID(),
    globalSequence: 1,
    aggregateType: input.aggregateType ?? "provider-instance",
    aggregateId: input.aggregateId ?? ids.instance,
    aggregateVersion: input.aggregateVersion ?? 1,
    eventName: input.eventName,
    eventVersion: 1,
    correlationId: ids.correlation,
    actor,
    occurredAt: now,
    payload: input.payload,
  } as EventEnvelope;
}

function providerProjection() {
  const runtime = createPhase1RuntimeRegistries();
  const projection = runtime.projections.get("providers");
  if (projection === undefined) throw new Error("Provider projection must be registered");
  return { runtime, projection };
}

function readRawInstances(connection: SqliteConnection): ReadonlyArray<ProviderInstance> {
  const rows = connection
    .prepare("SELECT instance_json FROM provider_instance_projection ORDER BY instance_id")
    .all() as ReadonlyArray<{ readonly instance_json: string }>;
  return rows.map(({ instance_json }) => JSON.parse(instance_json) as ProviderInstance);
}

function readRawDefaults(connection: SqliteConnection): ProviderDefaults | undefined {
  const row = connection
    .prepare(
      "SELECT defaults_json FROM provider_defaults_projection WHERE projection_key = 'provider-defaults'",
    )
    .get() as { readonly defaults_json: string } | undefined;
  return row === undefined ? undefined : (JSON.parse(row.defaults_json) as ProviderDefaults);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ProviderProjection", () => {
  it("returns current-session defaults before a defaults event exists", () => {
    const connection = openConnection();
    expect(readProviderDefaults(connection)).toEqual({
      permissionPersistence: "current-session",
      version: 0,
    });
    expect(readProviderInstances(connection)).toEqual([]);
    connection.close();
  });

  it("rebuilds provider instances and defaults from versioned events", () => {
    const connection = openConnection();
    const { runtime, projection } = providerProjection();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const created = instance();
    const renamed = instance({ displayName: "OpenCode primary", version: 2 });
    journal.append({
      aggregate: { aggregateType: "provider-instance", aggregateId: ids.instance },
      expectedVersion: 0,
      events: [pending("provider.instance-created@1", { instance: created })],
    });
    journal.append({
      aggregate: { aggregateType: "provider-instance", aggregateId: ids.instance },
      expectedVersion: 1,
      events: [pending("provider.instance-renamed@1", { instance: renamed })],
    });
    journal.append({
      aggregate: {
        aggregateType: "provider-defaults",
        aggregateId: PROVIDER_DEFAULTS_AGGREGATE_ID,
      },
      expectedVersion: 0,
      events: [
        pending("provider.defaults-updated@1", {
          defaults: { permissionPersistence: "project-default", version: 1 },
        }),
      ],
    });

    expect(readRawInstances(connection)).toEqual([renamed]);
    expect(readProviderInstances(connection)).toEqual([renamed]);
    expect(readProviderInstance(connection, renamed.id)).toEqual(renamed);
    expect(readRawDefaults(connection)).toEqual({
      permissionPersistence: "project-default",
      version: 1,
    });
    projection.reset(connection);
    expect(readRawInstances(connection)).toEqual([]);
    expect(readRawDefaults(connection)).toBeUndefined();
    rebuildProjection({ connection, journal, projection, clock: () => now });
    expect(readRawInstances(connection)).toEqual([renamed]);
    expect(readRawDefaults(connection)?.permissionPersistence).toBe("project-default");
    connection.close();
  });

  it("replays a versioned model catalog with manual ordering and invalidation state", () => {
    const connection = openConnection();
    const { runtime, projection } = providerProjection();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const catalog = decodeProviderCatalogSnapshot({
      instanceId: ids.instance,
      version: 1,
      models: [],
      manualModelOrder: ["manual-model"],
      invalidated: false,
      updatedAt: now,
    });

    journal.append({
      aggregate: { aggregateType: "provider-catalog", aggregateId: ids.instance },
      expectedVersion: 0,
      events: [pending("provider.catalog-updated@1", { snapshot: catalog })],
    });

    expect(readProviderCatalog(connection, catalog.instanceId)).toEqual(catalog);
    expect(readProviderCatalogs(connection)).toEqual([catalog]);
    projection.reset(connection);
    expect(readProviderCatalog(connection, catalog.instanceId)).toBeUndefined();
    rebuildProjection({ connection, journal, projection, clock: () => now });
    expect(readProviderCatalog(connection, catalog.instanceId)).toEqual(catalog);
    connection.close();
  });

  it("replays complete OpenAI-compatible configuration changes", () => {
    const connection = openConnection();
    const { runtime, projection } = providerProjection();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const created = instance({
      displayName: "Private gateway",
      driverKind: "openai-compatible",
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://gateway.example/v1/",
        authentication: "bearer",
        protocol: "auto",
        manualModelIds: ["model-a"],
      },
    });
    const changed = instance({
      ...created,
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "http://127.0.0.1:11434/v1/",
        authentication: "none",
        protocol: "responses",
        manualModelIds: ["model-b"],
      },
      version: 2,
    });
    journal.append({
      aggregate: { aggregateType: "provider-instance", aggregateId: ids.instance },
      expectedVersion: 0,
      events: [pending("provider.instance-created@1", { instance: created })],
    });
    journal.append({
      aggregate: { aggregateType: "provider-instance", aggregateId: ids.instance },
      expectedVersion: 1,
      events: [pending("provider.instance-configuration-changed@1", { instance: changed })],
    });

    expect(readProviderInstance(connection, changed.id)).toEqual(changed);
    projection.reset(connection);
    rebuildProjection({ connection, journal, projection, clock: () => now });
    expect(readProviderInstance(connection, changed.id)).toEqual(changed);
    connection.close();
  });

  it("applies and replays strict Codex creation without a projection schema change", () => {
    const connection = openConnection();
    const { runtime, projection } = providerProjection();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const codex = instance({
      displayName: "Codex local",
      driverKind: "codex",
      configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
    });
    journal.append({
      aggregate: { aggregateType: "provider-instance", aggregateId: ids.instance },
      expectedVersion: 0,
      events: [pending("provider.instance-created@1", { instance: codex })],
    });

    expect(readProviderInstance(connection, codex.id)).toEqual(codex);
    expect(readRawInstanceMetadata(connection)).toEqual({
      driver_kind: "codex",
      schema_version: PROVIDER_PROJECTION_SCHEMA_VERSION,
    });
    projection.reset(connection);
    rebuildProjection({ connection, journal, projection, clock: () => now });
    expect(readProviderInstance(connection, codex.id)).toEqual(codex);
    expect(readRawInstanceMetadata(connection)).toEqual({
      driver_kind: "codex",
      schema_version: PROVIDER_PROJECTION_SCHEMA_VERSION,
    });
    connection.close();
  });

  it("applies and replays non-secret Claude creation and configuration changes", () => {
    const connection = openConnection();
    const { runtime, projection } = providerProjection();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const created = instance({
      displayName: "Claude local",
      driverKind: "claude",
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/opt/homebrew/bin/claude",
        authentication: "subscription",
      },
    });
    const changed = instance({
      ...created,
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/usr/local/bin/claude",
        authentication: "api-key",
      },
      version: 2,
    });
    journal.append({
      aggregate: { aggregateType: "provider-instance", aggregateId: ids.instance },
      expectedVersion: 0,
      events: [pending("provider.instance-created@1", { instance: created })],
    });
    journal.append({
      aggregate: { aggregateType: "provider-instance", aggregateId: ids.instance },
      expectedVersion: 1,
      events: [pending("provider.instance-configuration-changed@1", { instance: changed })],
    });

    expect(readProviderInstance(connection, changed.id)).toEqual(changed);
    expect(JSON.stringify(readRawInstances(connection))).not.toMatch(
      /apiKey|oauthToken|credential|account/,
    );
    projection.reset(connection);
    rebuildProjection({ connection, journal, projection, clock: () => now });
    expect(readProviderInstance(connection, changed.id)).toEqual(changed);
    connection.close();
  });

  it.each([
    [
      "mismatched configuration",
      { configuration: { kind: "opencode-cli", binaryPath: "/opt/homebrew/bin/codex" } },
    ],
    ["an excess secret field", { token: "must-not-persist" }],
  ])("rejects a Codex creation snapshot with %s", (_name, malformed) => {
    const connection = openConnection();
    const { projection } = providerProjection();
    const codex = {
      ...instance(),
      displayName: "Codex local",
      driverKind: "codex",
      configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
      ...malformed,
    };

    expect(() =>
      projection.apply(
        connection,
        envelope({ eventName: "provider.instance-created@1", payload: { instance: codex } }),
      ),
    ).toThrow();
    expect(readRawInstances(connection)).toEqual([]);
    connection.close();
  });

  it("applies updates in aggregate-version order and stays idempotent", () => {
    const connection = openConnection();
    const { projection } = providerProjection();
    const renamed = instance({ displayName: "OpenCode primary", version: 2 });
    projection.apply(
      connection,
      envelope({
        eventName: "provider.instance-renamed@1",
        aggregateVersion: 2,
        payload: { instance: renamed },
      }),
    );
    projection.apply(
      connection,
      envelope({ eventName: "provider.instance-created@1", payload: { instance: instance() } }),
    );
    projection.apply(
      connection,
      envelope({
        eventName: "provider.instance-renamed@1",
        aggregateVersion: 2,
        payload: { instance: renamed },
      }),
    );
    expect(readRawInstances(connection)).toEqual([renamed]);
    connection.close();
  });

  it("persists binary and enabled updates and removes only the matching aggregate version", () => {
    const connection = openConnection();
    const { projection } = providerProjection();
    const changedBinary = instance({
      configuration: { kind: "opencode-cli", binaryPath: "/usr/local/bin/opencode" },
      version: 2,
    });
    const disabled = instance({ ...changedBinary, enabled: false, version: 3 });
    for (const event of [
      envelope({ eventName: "provider.instance-created@1", payload: { instance: instance() } }),
      envelope({
        eventName: "provider.instance-binary-changed@1",
        aggregateVersion: 2,
        payload: { instance: changedBinary },
      }),
      envelope({
        eventName: "provider.instance-enabled-changed@1",
        aggregateVersion: 3,
        payload: { instance: disabled },
      }),
    ]) {
      projection.apply(connection, event);
    }
    expect(readRawInstances(connection)).toEqual([disabled]);
    expect(() =>
      projection.apply(
        connection,
        envelope({
          eventName: "provider.instance-removed@1",
          aggregateVersion: 4,
          payload: { instanceId: ids.instance, version: 3 },
        }),
      ),
    ).toThrow("Provider projection event envelope is inconsistent");
    expect(readRawInstances(connection)).toEqual([disabled]);
    projection.apply(
      connection,
      envelope({
        eventName: "provider.instance-removed@1",
        aggregateVersion: 4,
        payload: { instanceId: ids.instance, version: 4 },
      }),
    );
    expect(readRawInstances(connection)).toEqual([]);
    connection.close();
  });

  it("does not resurrect a removed instance from a stale snapshot", () => {
    const connection = openConnection();
    const { runtime, projection } = providerProjection();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    journal.append({
      aggregate: { aggregateType: "provider-instance", aggregateId: ids.instance },
      expectedVersion: 0,
      events: [pending("provider.instance-created@1", { instance: instance() })],
    });
    journal.append({
      aggregate: { aggregateType: "provider-instance", aggregateId: ids.instance },
      expectedVersion: 1,
      events: [pending("provider.instance-removed@1", { instanceId: ids.instance, version: 2 })],
    });

    projection.apply(
      connection,
      envelope({ eventName: "provider.instance-created@1", payload: { instance: instance() } }),
    );

    expect(readProviderInstance(connection, instance().id)).toBeUndefined();
    connection.close();
  });

  it.each([
    ["wrong aggregate type", { aggregateType: "project" }],
    ["wrong aggregate ID", { aggregateId: "70000000-0000-4000-8000-000000000004" }],
    ["payload version mismatch", { aggregateVersion: 2 }],
  ])("rejects an inconsistent instance envelope with %s", (_name, override) => {
    const connection = openConnection();
    const { projection } = providerProjection();
    expect(() =>
      projection.apply(
        connection,
        envelope({
          eventName: "provider.instance-created@1",
          payload: { instance: instance() },
          ...override,
        }),
      ),
    ).toThrow("Provider projection event envelope is inconsistent");
    expect(readRawInstances(connection)).toEqual([]);
    connection.close();
  });
});

function pending(eventName: string, payload: unknown) {
  return {
    eventId: crypto.randomUUID(),
    eventName,
    eventVersion: 1,
    correlationId: ids.correlation,
    actor,
    occurredAt: now,
    payload,
  };
}

function readRawInstanceMetadata(connection: SqliteConnection) {
  return connection
    .prepare("SELECT driver_kind, schema_version FROM provider_instance_projection")
    .get() as { readonly driver_kind: string; readonly schema_version: number };
}
