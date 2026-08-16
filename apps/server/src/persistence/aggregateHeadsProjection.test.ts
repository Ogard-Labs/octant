import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AggregateHeadsProjection } from "./aggregateHeadsProjection";
import { EventRegistry } from "./eventRegistry";
import { Journal } from "./journal";
import { JournalWriteFailed } from "./journalErrors";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { ProjectionApplicationFailed, type Projection, ProjectionRegistry } from "./projection";
import { openSqlite, type SqliteConnection } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-07-13T10:00:00.000Z";
const ids = {
  aggregate: "00000000-0000-4000-8000-000000000101",
  actor: "00000000-0000-4000-8000-000000000102",
  correlation: "00000000-0000-4000-8000-000000000103",
  event: "00000000-0000-4000-8000-000000000104",
} as const;

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-aggregate-heads-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function appendRequest() {
  return {
    aggregate: { aggregateType: "fixture", aggregateId: ids.aggregate },
    expectedVersion: 0,
    events: [
      {
        eventId: ids.event,
        eventName: "fixture.recorded",
        eventVersion: 1,
        correlationId: ids.correlation,
        actor: { kind: "system", actorId: ids.actor },
        occurredAt: now,
        payload: { value: "saved" },
      },
    ],
  };
}

function createJournal(connection: SqliteConnection, projections: ProjectionRegistry): Journal {
  return new Journal({
    connection,
    projections,
    registry: new EventRegistry().register(
      "fixture.recorded",
      1,
      Schema.Struct({ value: Schema.String }),
    ),
    clock: () => now,
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("AggregateHeadsProjection", () => {
  it("applies every committed event and advances its checkpoint atomically", () => {
    const connection = openConnection();
    const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
    const journal = createJournal(connection, projections);

    journal.append(appendRequest());

    expect(
      connection
        .prepare(
          "SELECT aggregate_version, last_sequence FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?",
        )
        .get("fixture", ids.aggregate),
    ).toEqual({ aggregate_version: 1, last_sequence: 1 });
    expect(
      connection
        .prepare(
          "SELECT last_sequence, updated_at FROM projection_checkpoints WHERE projection_name = ?",
        )
        .get("aggregate-heads"),
    ).toEqual({ last_sequence: 1, updated_at: now });
    connection.close();
  });

  it("rolls back the journal append when an inline projection throws", () => {
    const connection = openConnection();
    connection.exec("CREATE TABLE fixture_projection (global_sequence INTEGER PRIMARY KEY)");
    const throwingProjection: Projection = {
      name: "fixture-throwing",
      dependencies: [],
      reset: () => undefined,
      apply: (database, event) => {
        database
          .prepare("INSERT INTO fixture_projection (global_sequence) VALUES (?)")
          .run(event.globalSequence);
        throw new Error("private projection details");
      },
    };
    const projections = new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(throwingProjection);
    const journal = createJournal(connection, projections);

    try {
      journal.append(appendRequest());
      throw new Error("expected append to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectionApplicationFailed);
      expect(String(error)).not.toContain("private projection details");
    }
    expect(connection.prepare("SELECT count(*) AS count FROM event_journal").get()).toEqual({
      count: 0,
    });
    expect(connection.prepare("SELECT count(*) AS count FROM aggregate_heads").get()).toEqual({
      count: 0,
    });
    expect(connection.prepare("SELECT count(*) AS count FROM fixture_projection").get()).toEqual({
      count: 0,
    });
    expect(
      connection.prepare("SELECT count(*) AS count FROM projection_checkpoints").get(),
    ).toEqual({ count: 0 });
    expect(connection.prepare("SELECT count(*) AS count FROM event_quarantine").get()).toEqual({
      count: 0,
    });
    connection.close();
  });

  it.each(["SQLITE_IOERR", "SQLITE_BUSY"])(
    "classifies inline projection storage failure %s as a redacted journal write failure",
    (code) => {
      const connection = openConnection();
      connection.exec("CREATE TABLE fixture_projection (global_sequence INTEGER PRIMARY KEY)");
      const privateSentinel = `private-${code.toLowerCase()}-details`;
      const storageProjection: Projection = {
        name: "fixture-storage",
        dependencies: [],
        reset: () => undefined,
        apply: (database, event) => {
          database
            .prepare("INSERT INTO fixture_projection (global_sequence) VALUES (?)")
            .run(event.globalSequence);
          throw Object.assign(new Error(privateSentinel), { code });
        },
      };
      const projections = new ProjectionRegistry()
        .register(new AggregateHeadsProjection())
        .register(storageProjection);
      const journal = createJournal(connection, projections);

      try {
        journal.append(appendRequest());
        throw new Error("expected append to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(JournalWriteFailed);
        expect(error).not.toBeInstanceOf(ProjectionApplicationFailed);
        expect(String(error)).not.toContain(privateSentinel);
      }
      expect(connection.prepare("SELECT count(*) AS count FROM event_journal").get()).toEqual({
        count: 0,
      });
      expect(connection.prepare("SELECT count(*) AS count FROM aggregate_heads").get()).toEqual({
        count: 0,
      });
      expect(connection.prepare("SELECT count(*) AS count FROM fixture_projection").get()).toEqual({
        count: 0,
      });
      expect(
        connection.prepare("SELECT count(*) AS count FROM projection_checkpoints").get(),
      ).toEqual({ count: 0 });
      expect(connection.prepare("SELECT count(*) AS count FROM event_quarantine").get()).toEqual({
        count: 0,
      });
      connection.close();
    },
  );
});
