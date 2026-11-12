import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AggregateHeadsProjection } from "./aggregateHeadsProjection";
import { EventRegistry } from "./eventRegistry";
import { Journal } from "./journal";
import { DISK_FULL_MESSAGE, JournalWriteFailed, persistenceFailureMessage } from "./journalErrors";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { ProjectionApplicationFailed, type Projection, ProjectionRegistry } from "./projection";
import { databaseStatus, rebuildAll } from "./recovery";
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

  it.each([false, true])(
    "fails an append on a full disk with nothing committed and says the disk is full (derived view: %s)",
    (derived) => {
      const connection = openConnection();
      connection.exec("CREATE TABLE fixture_projection (global_sequence INTEGER PRIMARY KEY)");
      const fullDisk: Projection = {
        name: "fixture-full-disk",
        dependencies: [],
        ...(derived ? { derived: true as const } : {}),
        reset: () => undefined,
        apply: (database, event) => {
          database
            .prepare("INSERT INTO fixture_projection (global_sequence) VALUES (?)")
            .run(event.globalSequence);
          throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
        },
      };
      const projections = new ProjectionRegistry()
        .register(new AggregateHeadsProjection())
        .register(fullDisk);
      const journal = createJournal(connection, projections);

      let failure: unknown;
      try {
        journal.append(appendRequest());
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(JournalWriteFailed);
      expect(failure).toMatchObject({ reason: "disk-full" });
      expect(
        persistenceFailureMessage(failure, "Chat persistence is temporarily unavailable."),
      ).toBe(DISK_FULL_MESSAGE);
      expect(DISK_FULL_MESSAGE).toContain("disk is full");
      for (const table of [
        "event_journal",
        "aggregate_heads",
        "fixture_projection",
        "projection_checkpoints",
        "event_quarantine",
      ]) {
        expect(connection.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({
          count: 0,
        });
      }
      connection.close();
    },
  );

  it("commits a Stop-shaped append when a derived view throws, holds that view, and a rebuild restores it", () => {
    const connection = openConnection();
    connection.exec("CREATE TABLE fixture_derived (global_sequence INTEGER PRIMARY KEY)");
    let broken = true;
    const derivedView: Projection = {
      name: "fixture-derived",
      dependencies: ["aggregate-heads"],
      derived: true,
      reset: (database) => database.exec("DELETE FROM fixture_derived"),
      apply: (database, event) => {
        database
          .prepare("INSERT INTO fixture_derived (global_sequence) VALUES (?)")
          .run(event.globalSequence);
        if (broken) throw new Error("derived view bug");
      },
    };
    const projections = new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(derivedView);
    const journal = createJournal(connection, projections);
    const count = (table: string) =>
      (connection.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number })
        .count;

    const stopped = journal.append(appendRequest());
    expect(stopped.lastSequence).toBe(1);
    expect(count("event_journal")).toBe(1);
    expect(count("aggregate_heads")).toBe(1);
    expect(count("fixture_derived")).toBe(0);
    expect(
      connection
        .prepare("SELECT projection_name, global_sequence, reason FROM event_quarantine")
        .all(),
    ).toEqual([
      {
        projection_name: "fixture-derived",
        global_sequence: 1,
        reason: "projection-application-failed",
      },
    ]);

    // Held: a later append skips it even once it would succeed, so the view
    // never reports current over the event it missed.
    broken = false;
    journal.append({
      ...appendRequest(),
      expectedVersion: 1,
      events: [{ ...appendRequest().events[0], eventId: "00000000-0000-4000-8000-000000000105" }],
    });
    expect(count("fixture_derived")).toBe(0);
    const held = databaseStatus({ connection, journal, projections });
    expect(held.state).toBe("current");
    expect(held.heldDerivedViews).toEqual(["fixture-derived"]);
    expect(held.projections).toContainEqual({ name: "fixture-derived", lastSequence: 0, lag: 2 });
    expect(held.projections).toContainEqual({ name: "aggregate-heads", lastSequence: 2, lag: 0 });

    expect(rebuildAll({ connection, journal, projections, clock: () => now })).toEqual({
      rebuilt: ["aggregate-heads", "fixture-derived"],
      journalHead: 2,
    });
    expect(count("fixture_derived")).toBe(2);
    const repaired = databaseStatus({ connection, journal, projections });
    expect(repaired.state).toBe("current");
    expect(repaired.heldDerivedViews).toBeUndefined();
    expect(repaired.quarantineCount).toBe(0);
    connection.close();
  });

  it("keeps a derived view held when a rebuild still cannot apply it", () => {
    const connection = openConnection();
    const derivedView: Projection = {
      name: "fixture-derived",
      dependencies: [],
      derived: true,
      reset: () => undefined,
      apply: () => {
        throw new Error("derived view bug");
      },
    };
    const projections = new ProjectionRegistry()
      .register(new AggregateHeadsProjection())
      .register(derivedView);
    const journal = createJournal(connection, projections);
    journal.append(appendRequest());

    expect(rebuildAll({ connection, journal, projections, clock: () => now })).toEqual({
      rebuilt: ["aggregate-heads"],
      journalHead: 1,
      held: ["fixture-derived"],
    });
    expect(databaseStatus({ connection, journal, projections }).heldDerivedViews).toEqual([
      "fixture-derived",
    ]);
    connection.close();
  });

  it("refuses an authoritative projection that depends on a derived view", () => {
    const derivedView: Projection = {
      name: "fixture-derived",
      dependencies: [],
      derived: true,
      reset: () => undefined,
      apply: () => undefined,
    };
    const dependent: Projection = {
      name: "fixture-dependent",
      dependencies: ["fixture-derived"],
      reset: () => undefined,
      apply: () => undefined,
    };
    expect(() => new ProjectionRegistry().register(derivedView).register(dependent)).toThrow(
      expect.objectContaining({ _tag: "AuthoritativeProjectionDependsOnDerived" }),
    );
  });
});
