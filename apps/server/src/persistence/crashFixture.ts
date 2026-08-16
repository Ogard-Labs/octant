import { writeSync } from "node:fs";
import { Schema } from "effect";
import { AggregateHeadsProjection } from "./aggregateHeadsProjection";
import { EventRegistry } from "./eventRegistry";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { type Projection, ProjectionRegistry } from "./projection";
import { openSqlite, type SqliteConnection } from "./sqlitePort";

const now = "2026-07-13T10:00:00.000Z";
const ids = {
  aggregate: "00000000-0000-4000-8000-000000000801",
  actor: "00000000-0000-4000-8000-000000000802",
  correlation: "00000000-0000-4000-8000-000000000803",
  event: "00000000-0000-4000-8000-000000000804",
} as const;

function pauseAfterSynchronization(): never {
  writeSync(1, "OCTANT_CRASH_READY\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("unreachable");
}

class BeforeCommitPauseProjection implements Projection {
  readonly name = "crash-before-commit";
  readonly dependencies = ["aggregate-heads"];

  reset(_connection: SqliteConnection): void {}

  apply(_connection: SqliteConnection): void {
    pauseAfterSynchronization();
  }
}

const mode = Bun.argv[2];
const databasePath = Bun.argv[3];
if (
  (mode !== "before-commit" && mode !== "after-commit" && mode !== "synchronization-failure") ||
  databasePath === undefined
) {
  process.exitCode = 2;
} else if (mode === "synchronization-failure") {
  writeSync(1, "OCTANT_CRASH_SYNC_FAILURE\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} else {
  const connection = openSqlite(databasePath);
  applyMigrations(connection, MIGRATIONS, () => now);
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  if (mode === "before-commit") projections.register(new BeforeCommitPauseProjection());

  const journal = new Journal({
    connection,
    projections,
    registry: new EventRegistry().register(
      "fixture.recorded",
      1,
      Schema.Struct({ value: Schema.String }),
    ),
    clock: () => now,
    ...(mode === "after-commit" ? { onCommitted: pauseAfterSynchronization } : {}),
  });

  journal.append({
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
        payload: { value: "synthetic-crash-fixture" },
      },
    ],
  });
}
