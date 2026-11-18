import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProviderDriverKind, decodeProviderInstanceId } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { JournalProviderSessionOwnership } from "./providerSessionHolds";

const now = "2026-11-18T09:00:00.000Z";
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000a01");
const otherInstanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000a02");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function openStore(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-opencode-holds-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function insertEvent(connection: SqliteConnection, payload: unknown): void {
  connection
    .prepare(
      `INSERT INTO event_journal (
        event_id, aggregate_type, aggregate_id, aggregate_version, event_name, event_version,
        correlation_id, actor_kind, actor_id, occurred_at, payload_json, host_id
      ) VALUES (?, 'fixture', ?, 1, 'fixture.planted@1', 1, ?, 'system', ?, ?, ?, 'local')`,
    )
    .run(
      randomUUID(),
      randomUUID(),
      randomUUID(),
      String(instanceId),
      now,
      JSON.stringify(payload),
    );
}

const cursor = (value: string, instance?: string) => ({
  driverKind: "opencode",
  value,
  ...(instance === undefined
    ? {}
    : {
        binding: {
          instanceId: instance,
          sessionId: randomUUID(),
          projectRoot: "/work/project",
          mode: "code",
          modelId: "anthropic/claude-sonnet",
        },
      }),
});

describe("Provider session ownership from the journal", () => {
  it("holds every session a journaled cursor of the kind names, for every instance of the kind, including ones journaled after the first read", () => {
    const connection = openStore();
    // A Code operation's session, and a Work thread's adopted session.
    insertEvent(connection, {
      threadId: "t1",
      event: { kind: "provider-session-ready", resumeCursor: cursor("ses_code", instanceId) },
    });
    insertEvent(connection, {
      thread: { adoptedSession: { resumeCursor: cursor("ses_work", instanceId) } },
    });
    // Another account of the same runtime shares its session store.
    insertEvent(connection, { resumeCursor: cursor("ses_other_account", otherInstanceId) });
    insertEvent(connection, { resumeCursor: cursor("ses_unbound") });
    insertEvent(connection, { resumeCursor: { driverKind: "pi", value: "pi_session" } });
    const ownership = new JournalProviderSessionOwnership(connection);
    expect([...ownership.held(decodeProviderDriverKind("opencode"))].sort()).toEqual([
      "ses_code",
      "ses_other_account",
      "ses_unbound",
      "ses_work",
    ]);
    expect([...ownership.held(decodeProviderDriverKind("pi"))]).toEqual(["pi_session"]);
    insertEvent(connection, { resumeCursor: cursor("ses_later", instanceId) });
    expect(ownership.held(decodeProviderDriverKind("opencode")).has("ses_later")).toBe(true);
  });
});
