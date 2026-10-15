import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeWindowId,
  type ProviderInstance,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { providerKeyJournal, reconcileProviderKeyChanges } from "./providerKeyJournal";

const NOW = "2026-10-15T10:00:00.000Z";
const SECRET = "sk-must-never-reach-the-journal";
const GATEWAY_ID = "80000000-0000-4000-8000-000000000401";
const WINDOW = decodeWindowId("33333333-3333-4333-8333-333333333333");
const instanceId = decodeProviderInstanceId(GATEWAY_ID);

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function gateway(version: number): ProviderInstance {
  return decodeProviderInstance({
    id: GATEWAY_ID,
    displayName: "Private gateway",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://gateway.example/v1/",
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: ["model-a"],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function open(path: string): {
  connection: SqliteConnection;
  keyJournal: ReturnType<typeof providerKeyJournal>;
} {
  const connection = openSqlite(path);
  applyMigrations(connection, MIGRATIONS, () => NOW);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => NOW,
  });
  return {
    connection,
    keyJournal: providerKeyJournal({
      journal,
      connection,
      uuid: () => crypto.randomUUID(),
      now: () => NOW,
    }),
  };
}

function tempDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-provider-key-journal-"));
  directories.push(directory);
  return join(directory, "events.sqlite3");
}

describe("provider key journal", () => {
  it("holds a request without an outcome across a restart, and no key material", () => {
    const path = tempDatabase();
    const first = open(path);
    first.keyJournal
      .request({ instanceId, action: "set", instanceVersion: 2, windowId: WINDOW })
      .complete("stored");
    first.keyJournal.request({
      instanceId,
      action: "remove",
      instanceVersion: 2,
      windowId: WINDOW,
    });
    first.connection.close();

    const restarted = open(path);
    const unsettled = restarted.keyJournal.unsettled();
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]).toMatchObject({ action: "remove", instanceVersion: 2 });
    const rows = restarted.connection
      .prepare(
        "SELECT payload_json FROM event_journal WHERE event_name = 'provider-key.recorded@1'",
      )
      .all() as ReadonlyArray<{ payload_json: string }>;
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    restarted.connection.close();
  });

  it("settles a request left without an outcome by a crash, once", async () => {
    const path = tempDatabase();
    const first = open(path);
    first.keyJournal.request({
      instanceId,
      action: "remove",
      instanceVersion: 2,
      windowId: WINDOW,
    });
    first.connection.close();

    const restarted = open(path);
    const cleared: string[] = [];
    const reconcile = () =>
      reconcileProviderKeyChanges({
        journal: restarted.keyJournal,
        unsettled: restarted.keyJournal.unsettled(),
        readInstances: () => [gateway(2)],
        deleteKey: async (id) => {
          cleared.push(id);
        },
      });
    await reconcile();
    await reconcile();

    expect(cleared).toEqual([GATEWAY_ID]);
    expect(restarted.keyJournal.unsettled()).toEqual([]);
    restarted.connection.close();
  });

  it("clears a key a crashed set stored for an instance that changed, and keeps one for an unchanged instance", async () => {
    const path = tempDatabase();
    const first = open(path);
    first.keyJournal.request({ instanceId, action: "set", instanceVersion: 2, windowId: WINDOW });
    first.connection.close();

    const unchanged = open(path);
    const cleared: string[] = [];
    await reconcileProviderKeyChanges({
      journal: unchanged.keyJournal,
      unsettled: unchanged.keyJournal.unsettled(),
      readInstances: () => [gateway(2)],
      deleteKey: async (id) => void cleared.push(id),
    });
    expect(cleared).toEqual([]);
    expect(unchanged.keyJournal.unsettled()).toEqual([]);

    unchanged.keyJournal.request({
      instanceId,
      action: "set",
      instanceVersion: 2,
      windowId: WINDOW,
    });
    await reconcileProviderKeyChanges({
      journal: unchanged.keyJournal,
      unsettled: unchanged.keyJournal.unsettled(),
      readInstances: () => [gateway(3)],
      deleteKey: async (id) => void cleared.push(id),
    });
    expect(cleared).toEqual([GATEWAY_ID]);
    unchanged.connection.close();
  });

  it("keeps the key of a provider whose removal never happened, and retries an unreachable store", async () => {
    const { connection, keyJournal } = open(tempDatabase());
    keyJournal.request({
      instanceId,
      action: "remove-with-provider",
      instanceVersion: 2,
      windowId: WINDOW,
    });
    const deleted: string[] = [];
    await reconcileProviderKeyChanges({
      journal: keyJournal,
      unsettled: keyJournal.unsettled(),
      readInstances: () => [gateway(2)],
      deleteKey: async (id) => void deleted.push(id),
    });
    expect(deleted).toEqual([]);
    expect(keyJournal.unsettled()).toEqual([]);

    keyJournal.request({
      instanceId,
      action: "remove-with-provider",
      instanceVersion: 2,
      windowId: WINDOW,
    });
    await reconcileProviderKeyChanges({
      journal: keyJournal,
      unsettled: keyJournal.unsettled(),
      readInstances: () => [],
      deleteKey: async () => {
        throw new Error("locked");
      },
    });
    expect(keyJournal.unsettled()).toHaveLength(1);
    connection.close();
  });
});
