import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AggregateHeadsProjection } from "./aggregateHeadsProjection";
import { EventRegistry } from "./eventRegistry";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { ProjectionQuarantined, type Projection, ProjectionRegistry } from "./projection";
import {
  IsolatedProjectionRebuildRejected,
  databaseStatus,
  rebuildAll,
  rebuildProjectionByName,
  verifyDatabase,
} from "./recovery";
import { openSqlite, type SqliteConnection } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-07-13T10:00:00.000Z";
const ids = {
  aggregate: "00000000-0000-4000-8000-000000000701",
  actor: "00000000-0000-4000-8000-000000000702",
  correlation: "00000000-0000-4000-8000-000000000703",
  event1: "00000000-0000-4000-8000-000000000704",
  event2: "00000000-0000-4000-8000-000000000705",
} as const;

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-recovery-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
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

function appendTwo(journal: Journal): void {
  journal.append({
    aggregate: { aggregateType: "fixture", aggregateId: ids.aggregate },
    expectedVersion: 0,
    events: [
      {
        eventId: ids.event1,
        eventName: "fixture.recorded",
        eventVersion: 1,
        correlationId: ids.correlation,
        actor: { kind: "system", actorId: ids.actor },
        occurredAt: now,
        payload: { value: "private-one" },
      },
      {
        eventId: ids.event2,
        eventName: "fixture.recorded",
        eventVersion: 1,
        correlationId: ids.correlation,
        actor: { kind: "system", actorId: ids.actor },
        occurredAt: now,
        payload: { value: "private-two" },
      },
    ],
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database recovery", () => {
  it("reports migration level, journal head, aggregate count, checkpoints, lag, and quarantine count", () => {
    const connection = openConnection();
    const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
    const journal = createJournal(connection, projections);
    appendTwo(journal);

    expect(databaseStatus({ connection, journal, projections })).toEqual({
      migrationVersion: MIGRATIONS.at(-1)!.version,
      journalHead: 2,
      aggregateCount: 1,
      projections: [{ name: "aggregate-heads", lastSequence: 2, lag: 0 }],
      quarantineCount: 0,
      integrity: "ok",
      state: "current",
    });
    connection.close();
  });

  it("returns valid for a consistent store after PRAGMA integrity_check", () => {
    const connection = openConnection();
    const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
    const journal = createJournal(connection, projections);
    appendTwo(journal);

    expect(verifyDatabase({ connection, journal, projections })).toEqual({
      valid: true,
      state: "current",
      integrity: "ok",
      issues: [],
    });
    connection.close();
  });

  it("reports aggregate version gaps without exposing payloads or aggregate identities", () => {
    const connection = openConnection();
    const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
    const journal = createJournal(connection, projections);
    appendTwo(journal);
    connection
      .prepare("UPDATE event_journal SET aggregate_version = 3 WHERE global_sequence = 2")
      .run();

    const result = verifyDatabase({ connection, journal, projections });

    expect(result.valid).toBe(false);
    expect(result.state).toBe("invalid");
    expect(result.issues).toContainEqual({
      kind: "aggregate-version-gap",
      aggregateType: "fixture",
      expectedVersion: 2,
      actualVersion: 3,
    });
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(JSON.stringify(result)).not.toContain(ids.aggregate);
    connection.close();
  });

  it("rejects contiguous aggregate versions that are reversed in committed sequence order", () => {
    const connection = openConnection();
    const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
    const journal = createJournal(connection, projections);
    appendTwo(journal);
    connection
      .prepare("UPDATE event_journal SET aggregate_version = 3 WHERE global_sequence = 2")
      .run();
    connection
      .prepare("UPDATE event_journal SET aggregate_version = 2 WHERE global_sequence = 1")
      .run();
    connection
      .prepare("UPDATE event_journal SET aggregate_version = 1 WHERE global_sequence = 2")
      .run();
    connection.prepare("UPDATE aggregate_heads SET aggregate_version = 2, last_sequence = 2").run();

    const result = verifyDatabase({ connection, journal, projections });

    expect(result.valid).toBe(false);
    expect(result.state).toBe("invalid");
    expect(result.issues).toContainEqual({
      kind: "aggregate-version-gap",
      aggregateType: "fixture",
      expectedVersion: 1,
      actualVersion: 2,
    });
    expect(result.issues).toContainEqual({
      kind: "aggregate-head-mismatch",
      aggregateType: "fixture",
      journalVersion: 2,
      headVersion: 2,
      journalSequence: 1,
      headSequence: 2,
    });
    connection.close();
  });

  it("reports aggregate-head mismatches and checkpoints ahead of the journal", () => {
    const connection = openConnection();
    const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
    const journal = createJournal(connection, projections);
    appendTwo(journal);
    connection.prepare("UPDATE aggregate_heads SET aggregate_version = 1").run();
    connection
      .prepare("UPDATE projection_checkpoints SET last_sequence = 3 WHERE projection_name = ?")
      .run("aggregate-heads");

    const result = verifyDatabase({ connection, journal, projections });

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      kind: "aggregate-head-mismatch",
      aggregateType: "fixture",
      journalVersion: 2,
      headVersion: 1,
      journalSequence: 2,
      headSequence: 2,
    });
    expect(result.issues).toContainEqual({
      kind: "checkpoint-ahead",
      projectionName: "aggregate-heads",
      lastSequence: 3,
      journalHead: 2,
    });
    connection.close();
  });

  it("counts aggregates from the journal and reports missing heads as invalid", () => {
    const connection = openConnection();
    const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
    const journal = createJournal(connection, projections);
    appendTwo(journal);
    connection.prepare("DELETE FROM aggregate_heads").run();

    expect(databaseStatus({ connection, journal, projections })).toMatchObject({
      aggregateCount: 1,
      state: "invalid",
    });
    connection.close();
  });

  it("reports a gap plus balanced missing and orphan heads as invalid status", () => {
    const connection = openConnection();
    const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
    const journal = createJournal(connection, projections);
    appendTwo(journal);
    connection
      .prepare("UPDATE event_journal SET aggregate_version = 3 WHERE global_sequence = 2")
      .run();
    connection.prepare("DELETE FROM aggregate_heads").run();
    connection
      .prepare(
        "INSERT INTO aggregate_heads (aggregate_type, aggregate_id, aggregate_version, last_sequence) VALUES (?, ?, ?, ?)",
      )
      .run("orphan", "00000000-0000-4000-8000-000000000799", 3, 2);

    expect(databaseStatus({ connection, journal, projections })).toMatchObject({
      aggregateCount: 1,
      state: "invalid",
    });
    connection.close();
  });

  it("reports quarantined and lagging states without claiming a store is current", () => {
    const connection = openConnection();
    const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
    const journal = createJournal(connection, projections);
    appendTwo(journal);
    connection
      .prepare(
        "INSERT INTO event_quarantine (projection_name, global_sequence, event_id, reason, observed_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("aggregate-heads", 1, ids.event1, "event-payload-invalid", now);

    expect(databaseStatus({ connection, journal, projections }).state).toBe("quarantined");
    expect(verifyDatabase({ connection, journal, projections })).toMatchObject({
      valid: false,
      state: "quarantined",
    });
    connection.prepare("DELETE FROM event_quarantine").run();
    connection
      .prepare("UPDATE projection_checkpoints SET last_sequence = 1 WHERE projection_name = ?")
      .run("aggregate-heads");
    expect(databaseStatus({ connection, journal, projections }).state).toBe("lagging");
    connection.close();
  });

  it("rebuilds all projections in dependency order", () => {
    const connection = openConnection();
    const journal = createJournal(connection, new ProjectionRegistry());
    appendTwo(journal);
    const calls: Array<string> = [];
    const first = trackingProjection("first", [], calls);
    const second = trackingProjection("second", ["first"], calls);
    const projections = new ProjectionRegistry().register(first).register(second);

    const result = rebuildAll({ connection, journal, projections, clock: () => now });

    expect(result).toEqual({ rebuilt: ["first", "second"], journalHead: 2 });
    expect(calls.filter((call) => call.startsWith("reset:"))).toEqual([
      "reset:first",
      "reset:second",
    ]);
    connection.close();
  });

  it("retires quarantine observations for every successfully rebuilt projection", () => {
    const connection = openConnection();
    const journal = createJournal(connection, new ProjectionRegistry());
    appendTwo(journal);
    const projections = new ProjectionRegistry()
      .register(trackingProjection("first", [], []))
      .register(trackingProjection("second", ["first"], []));
    seedQuarantine(connection, "first", 1, ids.event1);
    seedQuarantine(connection, "second", 2, ids.event2);

    rebuildAll({ connection, journal, projections, clock: () => now });

    expect(connection.prepare("SELECT * FROM event_quarantine").all()).toEqual([]);
    connection.close();
  });

  it("retires only the quarantine observations for an isolated rebuilt projection", () => {
    const connection = openConnection();
    const journal = createJournal(connection, new ProjectionRegistry());
    appendTwo(journal);
    const projections = new ProjectionRegistry()
      .register(trackingProjection("first", [], []))
      .register(trackingProjection("second", [], []));
    seedQuarantine(connection, "first", 1, ids.event1);
    seedQuarantine(connection, "second", 2, ids.event2);

    rebuildProjectionByName({
      connection,
      journal,
      projections,
      clock: () => now,
      projectionName: "first",
    });

    expect(
      connection.prepare("SELECT projection_name, global_sequence FROM event_quarantine").all(),
    ).toEqual([{ projection_name: "second", global_sequence: 2 }]);
    connection.close();
  });

  it("rolls back every projection and checkpoint when a later full rebuild fails", () => {
    const connection = openConnection();
    connection.exec(`
      CREATE TABLE first_projection (global_sequence INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE second_projection (global_sequence INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `);
    const journal = createJournal(connection, new ProjectionRegistry());
    appendTwo(journal);
    connection.prepare("INSERT INTO first_projection VALUES (?, ?)").run(99, "stable-first");
    connection.prepare("INSERT INTO second_projection VALUES (?, ?)").run(99, "stable-second");
    connection
      .prepare(
        "INSERT INTO projection_checkpoints (projection_name, last_sequence, updated_at) VALUES (?, ?, ?), (?, ?, ?)",
      )
      .run("first", 0, now, "second", 0, now);
    const first = tableProjection("first", "first_projection", []);
    const secondBase = tableProjection("second", "second_projection", ["first"]);
    const second: Projection = {
      ...secondBase,
      apply: (database, event) => {
        secondBase.apply(database, event);
        throw new Error("private second projection failure");
      },
    };
    const projections = new ProjectionRegistry().register(first).register(second);
    seedQuarantine(connection, "first", 1, ids.event1);
    seedQuarantine(connection, "second", 2, ids.event2);
    const beforeFirst = connection.prepare("SELECT * FROM first_projection").all();
    const beforeSecond = connection.prepare("SELECT * FROM second_projection").all();
    const beforeCheckpoints = connection
      .prepare("SELECT * FROM projection_checkpoints ORDER BY projection_name")
      .all();
    const quarantineBefore = connection
      .prepare("SELECT * FROM event_quarantine ORDER BY projection_name, global_sequence")
      .all();

    expect(() => rebuildAll({ connection, journal, projections, clock: () => now })).toThrow(
      ProjectionQuarantined,
    );

    expect(connection.prepare("SELECT * FROM first_projection").all()).toEqual(beforeFirst);
    expect(connection.prepare("SELECT * FROM second_projection").all()).toEqual(beforeSecond);
    expect(
      connection.prepare("SELECT * FROM projection_checkpoints ORDER BY projection_name").all(),
    ).toEqual(beforeCheckpoints);
    expect(connection.prepare("SELECT count(*) AS count FROM event_journal").get()).toEqual({
      count: 2,
    });
    expect(
      connection
        .prepare(
          "SELECT * FROM event_quarantine WHERE (projection_name = 'first' AND global_sequence = 1) OR (projection_name = 'second' AND global_sequence = 2) ORDER BY projection_name",
        )
        .all(),
    ).toEqual(quarantineBefore);
    connection.close();
  });

  it("rejects isolated rebuild when dependencies do not permit it", () => {
    const connection = openConnection();
    const journal = createJournal(connection, new ProjectionRegistry());
    const projections = new ProjectionRegistry()
      .register(trackingProjection("base", [], []))
      .register(trackingProjection("dependent", ["base"], []));

    expect(() =>
      rebuildProjectionByName({
        connection,
        journal,
        projections,
        clock: () => now,
        projectionName: "base",
      }),
    ).toThrow(IsolatedProjectionRebuildRejected);
    connection.close();
  });
});

function trackingProjection(
  name: string,
  dependencies: ReadonlyArray<string>,
  calls: Array<string>,
): Projection {
  return {
    name,
    dependencies,
    reset: () => calls.push(`reset:${name}`),
    apply: (_connection, event) => calls.push(`apply:${name}:${event.globalSequence}`),
  };
}

function tableProjection(
  name: string,
  table: "first_projection" | "second_projection",
  dependencies: ReadonlyArray<string>,
): Projection {
  return {
    name,
    dependencies,
    reset: (connection) => connection.exec(`DELETE FROM ${table}`),
    apply: (connection, event) => {
      connection
        .prepare(`INSERT INTO ${table} (global_sequence, value) VALUES (?, ?)`)
        .run(event.globalSequence, name);
    },
  };
}

function seedQuarantine(
  connection: SqliteConnection,
  projectionName: string,
  globalSequence: number,
  eventId: string,
): void {
  connection
    .prepare(
      "INSERT INTO event_quarantine (projection_name, global_sequence, event_id, reason, observed_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(projectionName, globalSequence, eventId, "event-payload-invalid", now);
}
