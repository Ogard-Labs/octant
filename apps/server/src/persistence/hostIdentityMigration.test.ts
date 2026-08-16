import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { openSqlite } from "./sqlitePort";
import {
  HostIdentityMigrationRegistry,
  HostIdentityMigrationFailed,
  migrateLegacyHostIdentity,
  initializeFreshHostIdentity,
  type HostIdentityKeyStore,
} from "./hostIdentityMigration";

const directories: string[] = [];
const now = "2026-07-28T20:00:00.000Z";
const oldHostId = "local";
const newHostId = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function seedStore() {
  const directory = mkdtempSync(join(tmpdir(), "octant-host-migration-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "store.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  connection
    .prepare(
      "INSERT INTO event_journal (event_id, aggregate_type, aggregate_id, aggregate_version, event_name, event_version, host_id, correlation_id, actor_kind, actor_id, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "22222222-2222-4222-8222-222222222222",
      "fixture",
      "33333333-3333-4333-8333-333333333333",
      1,
      "fixture.host-bearing@1",
      1,
      oldHostId,
      "44444444-4444-4444-8444-444444444444",
      "system",
      "55555555-5555-4555-8555-555555555555",
      now,
      JSON.stringify({ hostId: oldHostId, value: "keep-this-value" }),
    );
  return { connection, directory };
}

const keyStore: HostIdentityKeyStore = {
  ensureKey: async () => ({ fingerprint: "a".repeat(64) }),
};

describe("migrateLegacyHostIdentity", () => {
  it("transforms the envelope and explicitly registered payload fields atomically", async () => {
    const { connection } = seedStore();
    const registry = new HostIdentityMigrationRegistry().register(
      "fixture.host-bearing@1",
      1,
      (payload, from, to) => ({
        ...(payload as Record<string, unknown>),
        hostId:
          String((payload as Record<string, unknown>).hostId) === from
            ? to
            : (payload as Record<string, unknown>).hostId,
      }),
    );
    await migrateLegacyHostIdentity({
      connection,
      keyStore,
      hostId: newHostId,
      displayName: "This Mac",
      clock: () => now,
      registry,
    });
    expect(connection.prepare("SELECT host_id FROM event_journal").get()).toEqual({
      host_id: newHostId,
    });
    expect(
      JSON.parse(
        String(
          (
            connection.prepare("SELECT payload_json FROM event_journal").get() as {
              payload_json: string;
            }
          ).payload_json,
        ),
      ),
    ).toEqual({
      hostId: newHostId,
      value: "keep-this-value",
    });
    expect(
      connection.prepare("SELECT host_id, key_fingerprint FROM host_identity_projection").get(),
    ).toEqual({
      host_id: newHostId,
      key_fingerprint: "a".repeat(64),
    });
    connection.close();
  });

  it("fails closed for an unknown event version without changing the store", async () => {
    const { connection } = seedStore();
    const before = connection.prepare("SELECT host_id, payload_json FROM event_journal").get();
    await expect(
      migrateLegacyHostIdentity({
        connection,
        keyStore,
        hostId: newHostId,
        displayName: "This Mac",
        clock: () => now,
        registry: new HostIdentityMigrationRegistry(),
      }),
    ).rejects.toBeInstanceOf(HostIdentityMigrationFailed);
    expect(connection.prepare("SELECT host_id, payload_json FROM event_journal").get()).toEqual(
      before,
    );
    expect(
      connection.prepare("SELECT count(*) AS count FROM host_identity_projection").get(),
    ).toEqual({ count: 0 });
    connection.close();
  });

  it("does not mutate local storage when Keychain identity is unavailable", async () => {
    const { connection } = seedStore();
    const unavailable: HostIdentityKeyStore = {
      ensureKey: async () => {
        throw new Error("private keychain diagnostic");
      },
    };
    await expect(
      migrateLegacyHostIdentity({
        connection,
        keyStore: unavailable,
        hostId: newHostId,
        displayName: "This Mac",
        clock: () => now,
        registry: new HostIdentityMigrationRegistry().register(
          "fixture.host-bearing@1",
          1,
          (p) => p,
        ),
      }),
    ).rejects.toBeInstanceOf(HostIdentityMigrationFailed);
    expect(connection.prepare("SELECT host_id FROM event_journal").get()).toEqual({
      host_id: oldHostId,
    });
    expect(
      connection.prepare("SELECT count(*) AS count FROM host_identity_projection").get(),
    ).toEqual({ count: 0 });
    connection.close();
  });

  it("rolls back the host row and envelope transforms on injected interruption", async () => {
    const { connection } = seedStore();
    const registry = new HostIdentityMigrationRegistry().register(
      "fixture.host-bearing@1",
      1,
      (p, from, to) => ({
        ...(p as Record<string, unknown>),
        hostId:
          from === (p as Record<string, unknown>).hostId
            ? to
            : (p as Record<string, unknown>).hostId,
      }),
    );
    await expect(
      migrateLegacyHostIdentity({
        connection,
        keyStore,
        hostId: newHostId,
        displayName: "This Mac",
        clock: () => now,
        registry,
        beforeCommit: () => {
          throw new Error("injected interruption");
        },
      }),
    ).rejects.toBeInstanceOf(HostIdentityMigrationFailed);
    expect(connection.prepare("SELECT host_id, payload_json FROM event_journal").get()).toEqual({
      host_id: oldHostId,
      payload_json: JSON.stringify({ hostId: oldHostId, value: "keep-this-value" }),
    });
    expect(
      connection.prepare("SELECT count(*) AS count FROM host_identity_projection").get(),
    ).toEqual({ count: 0 });
    connection.close();
  });

  it("rejects a cloned store whose persisted host key does not match", async () => {
    const { connection } = seedStore();
    connection
      .prepare(
        "INSERT INTO host_identity_projection (identity_key, host_id, display_name, key_fingerprint, key_generation, created_at) VALUES ('host', ?, ?, ?, 1, ?)",
      )
      .run("66666666-6666-4666-8666-666666666666", "This Mac", "c".repeat(64), now);
    await expect(
      migrateLegacyHostIdentity({
        connection,
        keyStore,
        hostId: newHostId,
        displayName: "This Mac",
        clock: () => now,
        registry: new HostIdentityMigrationRegistry().register(
          "fixture.host-bearing@1",
          1,
          (p) => p,
        ),
      }),
    ).rejects.toBeInstanceOf(HostIdentityMigrationFailed);
    expect(connection.prepare("SELECT host_id FROM event_journal").get()).toEqual({
      host_id: oldHostId,
    });
    connection.close();
  });

  it("is idempotent after a successful restart", async () => {
    const { connection } = seedStore();
    const registry = new HostIdentityMigrationRegistry().register(
      "fixture.host-bearing@1",
      1,
      (p, from, to) => ({
        ...(p as Record<string, unknown>),
        hostId:
          from === (p as Record<string, unknown>).hostId
            ? to
            : (p as Record<string, unknown>).hostId,
      }),
    );
    await migrateLegacyHostIdentity({
      connection,
      keyStore,
      hostId: newHostId,
      displayName: "This Mac",
      clock: () => now,
      registry,
    });
    await expect(
      migrateLegacyHostIdentity({
        connection,
        keyStore,
        hostId: newHostId,
        displayName: "This Mac",
        clock: () => now,
        registry,
      }),
    ).resolves.toMatchObject({ hostId: newHostId });
    expect(
      connection.prepare("SELECT count(*) AS count FROM host_identity_projection").get(),
    ).toEqual({ count: 1 });
    connection.close();
  });

  it("initializes a fresh store before any event is appended", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-fresh-host-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "store.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => now);
    await expect(
      initializeFreshHostIdentity({
        connection,
        keyStore,
        hostId: newHostId,
        displayName: "This Mac",
        clock: () => now,
      }),
    ).resolves.toMatchObject({ hostId: newHostId });
    expect(connection.prepare("SELECT host_id FROM host_identity_projection").get()).toEqual({
      host_id: newHostId,
    });
    connection.close();
  });
});
