import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { decodeUtcTimestamp } from "@octant/contracts";
import { PendingQuestionDeferral } from "@octant/contracts/pending-requests";
import { pendingQuestionDeferrals } from "./pendingQuestionDeferrals";
import { Journal } from "./persistence/journal";
import { EventRegistry } from "./persistence/eventRegistry";
import { ProjectionRegistry } from "./persistence/projection";
import { AggregateHeadsProjection } from "./persistence/aggregateHeadsProjection";
import { openSqlite } from "./persistence/sqlitePort";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";

it("replays only a question key and wake time, including explicit early wake", () => {
  const folder = mkdtempSync(join(tmpdir(), "octant-question-deferral-"));
  const connection = openSqlite(join(folder, "journal.sqlite"));
  try {
    applyMigrations(connection, MIGRATIONS, () => new Date().toISOString());
    const journal = new Journal({
      connection,
      registry: new EventRegistry().register(
        "pending-question.deferred@1",
        1,
        PendingQuestionDeferral,
      ),
      projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
      clock: () => new Date().toISOString(),
    });
    const key = "a".repeat(64);
    const until = decodeUtcTimestamp(new Date(Date.now() + 3600000).toISOString());
    pendingQuestionDeferrals(journal, connection).record({ key, until });
    const restarted = pendingQuestionDeferrals(journal, connection);
    expect(restarted.read(key)).toBe(until);
    restarted.record({ key, until: null });
    expect(pendingQuestionDeferrals(journal, connection).read(key)).toBeUndefined();
    expect(
      journal
        .replayAggregateType({
          aggregateType: "pending-question-deferral",
          afterSequence: 0,
          limit: 10,
        })
        .map((event) => event.payload),
    ).toEqual([
      { key, until },
      { key, until: null },
    ]);
  } finally {
    connection.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
