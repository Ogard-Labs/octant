import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { EventRegistry } from "./eventRegistry";
import { ReplayEventInvalid } from "./journalErrors";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import {
  CheckpointAheadOfJournal,
  ProjectionQuarantined,
  ProjectionStorageFailed,
  type Projection,
  ProjectionRegistry,
  catchUpProjection,
  rebuildProjection,
} from "./projection";
import { openSqlite, type SqliteConnection, type SqliteStatement } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-07-13T10:00:00.000Z";
const ids = {
  aggregate: "00000000-0000-4000-8000-000000000201",
  actor: "00000000-0000-4000-8000-000000000202",
  correlation: "00000000-0000-4000-8000-000000000203",
  event1: "00000000-0000-4000-8000-000000000204",
  event2: "00000000-0000-4000-8000-000000000205",
  event3: "00000000-0000-4000-8000-000000000206",
} as const;

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-projection-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  connection.exec(`
    CREATE TABLE fixture_projection (
      global_sequence INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
  `);
  return connection;
}

function fixtureProjection(overrides: Partial<Projection> = {}): Projection {
  return {
    name: "fixture-projection",
    dependencies: [],
    reset: (connection) => connection.exec("DELETE FROM fixture_projection"),
    apply: (connection, event) => {
      const payload = event.payload as { value: string };
      connection
        .prepare(
          "INSERT INTO fixture_projection (global_sequence, value) VALUES (?, ?) ON CONFLICT (global_sequence) DO NOTHING",
        )
        .run(event.globalSequence, payload.value);
    },
    ...overrides,
  };
}

function createJournal(connection: SqliteConnection, projections = new ProjectionRegistry()) {
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

function pendingEvent(eventId: string, value: string) {
  return {
    eventId,
    eventName: "fixture.recorded",
    eventVersion: 1,
    correlationId: ids.correlation,
    actor: { kind: "system", actorId: ids.actor },
    occurredAt: now,
    payload: { value },
  };
}

function append(
  journal: Journal,
  events: ReadonlyArray<ReturnType<typeof pendingEvent>>,
  expectedVersion = 0,
) {
  return journal.append({
    aggregate: { aggregateType: "fixture", aggregateId: ids.aggregate },
    expectedVersion,
    events,
  });
}

function rows(connection: SqliteConnection) {
  return connection
    .prepare("SELECT global_sequence, value FROM fixture_projection ORDER BY global_sequence")
    .all();
}

function checkpoint(connection: SqliteConnection) {
  return connection
    .prepare(
      "SELECT projection_name, last_sequence, updated_at FROM projection_checkpoints WHERE projection_name = ?",
    )
    .get("fixture-projection");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ProjectionRegistry", () => {
  it("rejects duplicate projection names and unknown dependencies", () => {
    const projection = fixtureProjection();
    expect(() => new ProjectionRegistry().register(projection).register(projection)).toThrow();
    expect(() =>
      new ProjectionRegistry().register(
        fixtureProjection({ name: "dependent", dependencies: ["missing"] }),
      ),
    ).toThrow();
  });
});

describe("projection replay", () => {
  it("initializes a missing checkpoint at zero for an empty journal", () => {
    const connection = openConnection();
    const journal = createJournal(connection);

    const result = catchUpProjection({
      connection,
      journal,
      projection: fixtureProjection(),
      clock: () => now,
    });

    expect(result).toEqual({
      projectionName: "fixture-projection",
      lastSequence: 0,
      updatedAt: now,
    });
    expect(checkpoint(connection)).toEqual({
      projection_name: "fixture-projection",
      last_sequence: 0,
      updated_at: now,
    });
    connection.close();
  });

  it("catches up a lagging projection in global-sequence order", () => {
    const connection = openConnection();
    const journal = createJournal(connection);
    append(journal, [pendingEvent(ids.event1, "one"), pendingEvent(ids.event2, "two")]);
    const projection = fixtureProjection();

    const result = catchUpProjection({ connection, journal, projection, clock: () => now });

    expect(rows(connection)).toEqual([
      { global_sequence: 1, value: "one" },
      { global_sequence: 2, value: "two" },
    ]);
    expect(result).toEqual({
      projectionName: "fixture-projection",
      lastSequence: 2,
      updatedAt: now,
    });
    connection.close();
  });

  it("does not change state when the same range is replayed twice", () => {
    const connection = openConnection();
    const journal = createJournal(connection);
    append(journal, [pendingEvent(ids.event1, "one")]);
    const projection = fixtureProjection();

    catchUpProjection({ connection, journal, projection, clock: () => now });
    catchUpProjection({ connection, journal, projection, clock: () => now });

    expect(rows(connection)).toEqual([{ global_sequence: 1, value: "one" }]);
    expect(checkpoint(connection)).toEqual({
      projection_name: "fixture-projection",
      last_sequence: 1,
      updated_at: now,
    });
    connection.close();
  });

  it("does not quarantine a checkpoint storage failure as an event failure", () => {
    const connection = openConnection();
    const journal = createJournal(connection);
    append(journal, [pendingEvent(ids.event1, "one")]);
    const storageFailure = Object.assign(new Error("private checkpoint failure"), {
      code: "SQLITE_IOERR",
    });
    const failedConnection: SqliteConnection = {
      ...connection,
      prepare: (sql) => {
        const statement = connection.prepare(sql);
        if (!sql.includes("INSERT INTO projection_checkpoints")) return statement;
        const failed: SqliteStatement = {
          get: (...parameters) => statement.get(...parameters),
          all: (...parameters) => statement.all(...parameters),
          run: () => {
            throw storageFailure;
          },
        };
        return failed;
      },
    };

    expect(() =>
      catchUpProjection({
        connection: failedConnection,
        journal,
        projection: fixtureProjection(),
        clock: () => now,
      }),
    ).toThrow(ProjectionStorageFailed);
    expect(rows(connection)).toEqual([]);
    expect(connection.prepare("SELECT count(*) AS count FROM event_quarantine").get()).toEqual({
      count: 0,
    });
    connection.close();
  });

  it.each(["SQLITE_IOERR", "SQLITE_BUSY"])(
    "rolls back catch-up storage failure %s without quarantining the event",
    (code) => {
      const connection = openConnection();
      const journal = createJournal(connection);
      append(journal, [pendingEvent(ids.event1, "one")]);
      const base = fixtureProjection();
      const privateSentinel = `private-${code.toLowerCase()}-catch-up`;
      const projection = fixtureProjection({
        apply: (database, event) => {
          base.apply(database, event);
          throw Object.assign(new Error(privateSentinel), { code });
        },
      });

      try {
        catchUpProjection({ connection, journal, projection, clock: () => now });
        throw new Error("expected catch-up to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectionStorageFailed);
        expect(error).not.toBeInstanceOf(ProjectionQuarantined);
        expect(String(error)).not.toContain(privateSentinel);
      }
      expect(rows(connection)).toEqual([]);
      expect(checkpoint(connection)).toMatchObject({ last_sequence: 0 });
      expect(connection.prepare("SELECT count(*) AS count FROM event_quarantine").get()).toEqual({
        count: 0,
      });
      connection.close();
    },
  );

  it("keeps a projection constraint bug on the projection quarantine path", () => {
    const connection = openConnection();
    const journal = createJournal(connection);
    append(journal, [pendingEvent(ids.event1, "one")]);
    const base = fixtureProjection();
    const projection = fixtureProjection({
      apply: (database, event) => {
        base.apply(database, event);
        throw Object.assign(new Error("private constraint details"), {
          code: "SQLITE_CONSTRAINT_UNIQUE",
        });
      },
    });

    expect(() => catchUpProjection({ connection, journal, projection, clock: () => now })).toThrow(
      ProjectionQuarantined,
    );
    expect(rows(connection)).toEqual([]);
    expect(connection.prepare("SELECT reason FROM event_quarantine").get()).toEqual({
      reason: "projection-application-failed",
    });
    connection.close();
  });

  it.each(["SQLITE_IOERR", "SQLITE_BUSY"])(
    "rolls back rebuild storage failure %s without quarantining the event",
    (code) => {
      const connection = openConnection();
      const journal = createJournal(connection);
      append(journal, [pendingEvent(ids.event1, "one")]);
      const base = fixtureProjection();
      const privateSentinel = `private-${code.toLowerCase()}-rebuild`;
      const projection = fixtureProjection({
        apply: (database, event) => {
          base.apply(database, event);
          throw Object.assign(new Error(privateSentinel), { code });
        },
      });

      try {
        rebuildProjection({ connection, journal, projection, clock: () => now });
        throw new Error("expected rebuild to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectionStorageFailed);
        expect(error).not.toBeInstanceOf(ProjectionQuarantined);
        expect(String(error)).not.toContain(privateSentinel);
      }
      expect(rows(connection)).toEqual([]);
      expect(checkpoint(connection)).toBeUndefined();
      expect(connection.prepare("SELECT count(*) AS count FROM event_quarantine").get()).toEqual({
        count: 0,
      });
      connection.close();
    },
  );

  it("rejects a checkpoint ahead of the journal head", () => {
    const connection = openConnection();
    const journal = createJournal(connection);
    connection
      .prepare(
        "INSERT INTO projection_checkpoints (projection_name, last_sequence, updated_at) VALUES (?, ?, ?)",
      )
      .run("fixture-projection", 1, now);

    expect(() =>
      catchUpProjection({
        connection,
        journal,
        projection: fixtureProjection(),
        clock: () => now,
      }),
    ).toThrow(CheckpointAheadOfJournal);
    expect(rows(connection)).toEqual([]);
    connection.close();
  });

  it("rebuilds projection state deterministically from sequence zero", () => {
    const connection = openConnection();
    const journal = createJournal(connection);
    append(journal, [pendingEvent(ids.event1, "one"), pendingEvent(ids.event2, "two")]);
    connection
      .prepare("INSERT INTO fixture_projection (global_sequence, value) VALUES (?, ?)")
      .run(99, "stale");
    connection
      .prepare(
        "INSERT INTO projection_checkpoints (projection_name, last_sequence, updated_at) VALUES (?, ?, ?)",
      )
      .run("fixture-projection", 1, now);

    rebuildProjection({
      connection,
      journal,
      projection: fixtureProjection(),
      clock: () => now,
    });

    expect(rows(connection)).toEqual([
      { global_sequence: 1, value: "one" },
      { global_sequence: 2, value: "two" },
    ]);
    expect(checkpoint(connection)).toMatchObject({ last_sequence: 2 });
    connection.close();
  });

  it("rolls back a failed rebuild and preserves the last valid projection", () => {
    const connection = openConnection();
    const journal = createJournal(connection);
    append(journal, [pendingEvent(ids.event1, "one"), pendingEvent(ids.event2, "two")]);
    const valid = fixtureProjection();
    catchUpProjection({ connection, journal, projection: valid, clock: () => now });
    const failing = fixtureProjection({
      apply: (database, event) => {
        if (event.globalSequence === 2) throw new Error("private projection details");
        valid.apply(database, event);
      },
    });

    expect(() =>
      rebuildProjection({ connection, journal, projection: failing, clock: () => now }),
    ).toThrow(ProjectionQuarantined);
    expect(rows(connection)).toEqual([
      { global_sequence: 1, value: "one" },
      { global_sequence: 2, value: "two" },
    ]);
    expect(checkpoint(connection)).toMatchObject({ last_sequence: 2 });
    expect(
      connection
        .prepare("SELECT projection_name, global_sequence, event_id, reason FROM event_quarantine")
        .all(),
    ).toEqual([
      {
        projection_name: "fixture-projection",
        global_sequence: 2,
        event_id: ids.event2,
        reason: "projection-application-failed",
      },
    ]);
    connection.close();
  });

  it("quarantines malformed JSON and stops before the bad sequence", () => {
    const connection = openConnection();
    const journal = createJournal(connection);
    append(journal, [pendingEvent(ids.event1, "one"), pendingEvent(ids.event2, "two")]);
    connection.exec("PRAGMA ignore_check_constraints = ON");
    connection
      .prepare("UPDATE event_journal SET payload_json = ? WHERE global_sequence = ?")
      .run("{private-malformed", 2);
    connection.exec("PRAGMA ignore_check_constraints = OFF");

    expect(() =>
      catchUpProjection({
        connection,
        journal,
        projection: fixtureProjection(),
        clock: () => now,
      }),
    ).toThrow(ProjectionQuarantined);
    expect(rows(connection)).toEqual([{ global_sequence: 1, value: "one" }]);
    expect(checkpoint(connection)).toMatchObject({ last_sequence: 1 });
    const quarantine = connection
      .prepare("SELECT projection_name, global_sequence, event_id, reason FROM event_quarantine")
      .get();
    expect(quarantine).toEqual({
      projection_name: "fixture-projection",
      global_sequence: 2,
      event_id: ids.event2,
      reason: "malformed-json",
    });
    expect(JSON.stringify(quarantine)).not.toContain("private-malformed");
    expect(() => journal.replay({ afterSequence: 1, limit: 1 } as never)).toThrow(
      ReplayEventInvalid,
    );
    connection.close();
  });

  it("quarantines an unsupported event version without mutating the journal", () => {
    const connection = openConnection();
    const journal = createJournal(connection);
    append(journal, [pendingEvent(ids.event1, "one")]);
    connection
      .prepare("UPDATE event_journal SET event_version = ? WHERE global_sequence = ?")
      .run(2, 1);
    const before = connection.prepare("SELECT * FROM event_journal").all();

    expect(() =>
      catchUpProjection({
        connection,
        journal,
        projection: fixtureProjection(),
        clock: () => now,
      }),
    ).toThrow(ProjectionQuarantined);
    expect(connection.prepare("SELECT * FROM event_journal").all()).toEqual(before);
    expect(connection.prepare("SELECT reason FROM event_quarantine").get()).toEqual({
      reason: "unsupported-event-version",
    });
    connection.close();
  });
});
