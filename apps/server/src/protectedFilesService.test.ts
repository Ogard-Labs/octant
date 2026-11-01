import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { EventActor, decodeUtcTimestamp } from "@octant/contracts";
import {
  BUILT_IN_PROTECTED_FILES_REMOVED,
  PROTECTED_FILES_AGGREGATE_TYPE,
  decodeProtectedFilesCommand,
} from "@octant/contracts/protected-files";
import type { ProtectedFilesChoice } from "@octant/domain/secret-guard-policy";
import { AggregateHeadsProjection } from "./persistence/aggregateHeadsProjection";
import { EventRegistry } from "./persistence/eventRegistry";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { ProjectionRegistry } from "./persistence/projection";
import { openSqlite, type SqliteConnection } from "./persistence/sqlitePort";
import { ProtectedFilesService, registerProtectedFilesEvents } from "./protectedFilesService";

const now = "2026-10-31T10:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "99999999-9999-4999-8999-999999999999",
});
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-protected-files-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function service(connection: SqliteConnection) {
  const journal = new Journal({
    connection,
    registry: registerProtectedFilesEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  const applied: ProtectedFilesChoice[] = [];
  const files = new ProtectedFilesService({
    journal,
    locations: { platform: "darwin", home: "/Users/person" },
    apply: (choice) => applied.push(choice),
    uuid: () => crypto.randomUUID(),
    clock: () => decodeUtcTimestamp(now),
    actor,
  });
  return { files, journal, applied };
}

const command = (value: unknown) => decodeProtectedFilesCommand(value);

describe("protected files settings", () => {
  it("lists every built-in group with the paths it covers on this host", () => {
    const { files } = service(openConnection());
    const settings = files.settings();
    const ssh = settings.builtIns.find((group) => group.id === "ssh-private-keys");
    expect(ssh).toMatchObject({ label: "SSH private keys", channel: "ssh-agent", removed: false });
    expect(ssh?.paths).toContain("~/.ssh/id_* (not .pub)");
    expect(settings.added).toEqual([]);
  });

  it("adds a path, applies it to later launches, and keeps it after a restart", () => {
    const connection = openConnection();
    const first = service(connection);
    const result = first.files.change(
      command({ kind: "add-protected-path", path: "~/secrets", expectedVersion: 0 }),
    );
    expect(result).toMatchObject({ kind: "protected-files-settings" });
    expect(first.applied.at(-1)).toEqual({ added: ["~/secrets"], removed: [] });
    const restarted = service(connection);
    expect(restarted.files.settings()).toMatchObject({ added: ["~/secrets"], version: 1 });
    expect(restarted.applied.at(-1)).toEqual({ added: ["~/secrets"], removed: [] });
  });

  it("journals removing a built-in group with the confirmation, and restores it", () => {
    const connection = openConnection();
    const { files, journal } = service(connection);
    files.change(
      command({
        kind: "remove-built-in-protected-files",
        id: "cluster-configuration",
        confirmed: true,
        expectedVersion: 0,
      }),
    );
    const recorded = journal.replayAggregateType({
      aggregateType: PROTECTED_FILES_AGGREGATE_TYPE,
      afterSequence: 0,
      limit: 10,
    });
    expect(recorded.map((event) => [event.eventName, event.payload, event.actor.kind])).toEqual([
      [
        BUILT_IN_PROTECTED_FILES_REMOVED,
        { id: "cluster-configuration", confirmed: true },
        "local-user",
      ],
    ]);
    expect(
      files.settings().builtIns.find((group) => group.id === "cluster-configuration")?.removed,
    ).toBe(true);
    files.change(
      command({
        kind: "restore-built-in-protected-files",
        id: "cluster-configuration",
        expectedVersion: 1,
      }),
    );
    expect(files.choice()).toEqual({ added: [], removed: [] });
  });

  it("refuses removing a built-in group without the confirmation", () => {
    expect(() =>
      command({
        kind: "remove-built-in-protected-files",
        id: "ssh-private-keys",
        expectedVersion: 0,
      }),
    ).toThrow();
    expect(() =>
      command({
        kind: "remove-built-in-protected-files",
        id: "ssh-private-keys",
        confirmed: false,
        expectedVersion: 0,
      }),
    ).toThrow();
  });

  it("refuses a change made from a stale version or one already in place", () => {
    const { files } = service(openConnection());
    expect(
      files.change(command({ kind: "add-protected-path", path: "/opt/a", expectedVersion: 3 })),
    ).toMatchObject({ kind: "protected-files-refused", reason: "stale-version" });
    expect(
      files.change(command({ kind: "remove-protected-path", path: "/opt/a", expectedVersion: 0 })),
    ).toMatchObject({ kind: "protected-files-refused", reason: "no-change" });
  });

  it("refuses a relative or root path", () => {
    for (const path of ["relative", "/", "~/", "~/../x"]) {
      expect(() => command({ kind: "add-protected-path", path, expectedVersion: 0 })).toThrow();
    }
  });
});
