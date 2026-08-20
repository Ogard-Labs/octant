import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCodeCheckoutId } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { readCodeCheckout, readCodeCheckoutAggregateVersion } from "./codeProjection";
import { Journal } from "./journal";
import { compactSupersededCheckoutObservations } from "./journalCompaction";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { rebuildAll, verifyDatabase } from "./recovery";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-08-20T09:00:00.000Z";
const ids = {
  actor: "82000000-0000-4000-8000-000000000001",
  checkout: "82000000-0000-4000-8000-000000000002",
  otherCheckout: "82000000-0000-4000-8000-000000000003",
} as const;
const repositoryId = `repo_${"a".repeat(64)}`;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "octant-journal-compaction-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  return {
    connection,
    projections: runtime.projections,
    journal: new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    }),
  };
}

function checkoutIdentity(input: {
  readonly checkoutId: string;
  readonly availability: "available" | "unavailable" | "waiting";
  readonly observedAt: string;
}) {
  return {
    id: input.checkoutId,
    repositoryId,
    kind: "existing-worktree",
    availability: input.availability,
    head: { kind: "branch", name: "main", oid: "b".repeat(40) },
    observedAt: input.observedAt,
  } as const;
}

let eventCounter = 0;

function appendObserved(
  journal: Journal,
  input: {
    readonly checkoutId: string;
    readonly expectedVersion: number;
    readonly availability: "available" | "unavailable" | "waiting";
    readonly observedAt: string;
    readonly causationId?: string;
  },
): string {
  eventCounter += 1;
  const eventId = `82000000-0000-4000-8000-${String(100 + eventCounter).padStart(12, "0")}`;
  journal.append({
    aggregate: { aggregateType: "code-checkout", aggregateId: input.checkoutId },
    expectedVersion: input.expectedVersion,
    events: [
      {
        eventId,
        eventName: "code.checkout-observed@1",
        eventVersion: 1,
        correlationId: `82000000-0000-4000-8000-${String(500 + eventCounter).padStart(12, "0")}`,
        ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
        actor: { kind: "local-user", actorId: ids.actor },
        occurredAt: input.observedAt,
        payload: {
          kind: "checkout-observed",
          checkout: checkoutIdentity(input),
        },
      },
    ],
  });
  return eventId;
}

interface JournalRow {
  readonly global_sequence: number;
  readonly event_id: string;
  readonly aggregate_version: number;
  readonly event_name: string;
}

function journalRows(connection: ReturnType<typeof openStore>["connection"]): Array<JournalRow> {
  return connection
    .prepare(`
      SELECT global_sequence, event_id, aggregate_version, event_name
      FROM event_journal
      ORDER BY global_sequence ASC
    `)
    .all() as Array<JournalRow>;
}

describe("compactSupersededCheckoutObservations", () => {
  it("compacts repeated identical checkout observations down to the last of each run and replay of the compacted journal serves the identical checkout state", () => {
    const { connection, journal, projections } = openStore();
    try {
      // A reconnect loop journals the same available worktree over and over,
      // then a real transition to waiting and back: only the last observation
      // of each identical run carries state any reader can distinguish.
      const times = [1, 2, 3, 4, 5, 6].map((minute) => `2026-08-20T09:0${minute}:00.000Z`);
      appendObserved(journal, {
        checkoutId: ids.checkout,
        expectedVersion: 0,
        availability: "available",
        observedAt: times[0]!,
      });
      appendObserved(journal, {
        checkoutId: ids.checkout,
        expectedVersion: 1,
        availability: "available",
        observedAt: times[1]!,
      });
      const keptFirstRun = appendObserved(journal, {
        checkoutId: ids.checkout,
        expectedVersion: 2,
        availability: "available",
        observedAt: times[2]!,
      });
      const keptTransition = appendObserved(journal, {
        checkoutId: ids.checkout,
        expectedVersion: 3,
        availability: "waiting",
        observedAt: times[3]!,
      });
      appendObserved(journal, {
        checkoutId: ids.checkout,
        expectedVersion: 4,
        availability: "available",
        observedAt: times[4]!,
      });
      const keptHead = appendObserved(journal, {
        checkoutId: ids.checkout,
        expectedVersion: 5,
        availability: "available",
        observedAt: times[5]!,
      });
      // A second checkout with a single observation has nothing redundant.
      appendObserved(journal, {
        checkoutId: ids.otherCheckout,
        expectedVersion: 0,
        availability: "available",
        observedAt: times[5]!,
      });

      const checkoutId = decodeCodeCheckoutId(ids.checkout);
      const before = readCodeCheckout(connection, checkoutId);
      expect(before?.observedAt).toBe(times[5]);
      expect(verifyDatabase({ connection, journal, projections }).valid).toBe(true);

      const report = compactSupersededCheckoutObservations(connection);
      expect(report).toEqual({ checkoutsCompacted: 1, eventsRemoved: 3 });

      // The surviving stream keeps the last observation of each run, keeps its
      // global sequences, and is renumbered contiguously from 1.
      const rows = journalRows(connection).filter((row) => row.event_name.startsWith("code."));
      expect(
        rows
          .filter((row) => row.global_sequence <= 6)
          .map(({ event_id, aggregate_version, global_sequence }) => ({
            event_id,
            aggregate_version,
            global_sequence,
          })),
      ).toEqual([
        { event_id: keptFirstRun, aggregate_version: 1, global_sequence: 3 },
        { event_id: keptTransition, aggregate_version: 2, global_sequence: 4 },
        { event_id: keptHead, aggregate_version: 3, global_sequence: 6 },
      ]);

      // The projected checkout is untouched by compaction.
      expect(readCodeCheckout(connection, checkoutId)).toEqual(before);
      expect(readCodeCheckoutAggregateVersion(connection, checkoutId)).toBe(3);

      // Replaying the compacted journal from scratch serves the identical
      // checkout state the original journal produced.
      rebuildAll({ connection, journal, projections, clock: () => now });
      expect(readCodeCheckout(connection, checkoutId)).toEqual(before);
      expect(verifyDatabase({ connection, journal, projections }).valid).toBe(true);

      // Concurrency continues cleanly from the renumbered head.
      appendObserved(journal, {
        checkoutId: ids.checkout,
        expectedVersion: 3,
        availability: "unavailable",
        observedAt: "2026-08-20T09:07:00.000Z",
      });
      expect(readCodeCheckout(connection, checkoutId)?.availability).toBe("unavailable");

      // Compaction is idempotent: a compacted journal has nothing left to remove.
      expect(compactSupersededCheckoutObservations(connection)).toEqual({
        checkoutsCompacted: 0,
        eventsRemoved: 0,
      });
    } finally {
      connection.close();
    }
  });

  it("leaves a journal with nothing redundant untouched", () => {
    const { connection, journal } = openStore();
    try {
      appendObserved(journal, {
        checkoutId: ids.checkout,
        expectedVersion: 0,
        availability: "available",
        observedAt: "2026-08-20T09:01:00.000Z",
      });
      appendObserved(journal, {
        checkoutId: ids.checkout,
        expectedVersion: 1,
        availability: "waiting",
        observedAt: "2026-08-20T09:02:00.000Z",
      });
      appendObserved(journal, {
        checkoutId: ids.checkout,
        expectedVersion: 2,
        availability: "available",
        observedAt: "2026-08-20T09:03:00.000Z",
      });

      const before = journalRows(connection);
      expect(compactSupersededCheckoutObservations(connection)).toEqual({
        checkoutsCompacted: 0,
        eventsRemoved: 0,
      });
      expect(journalRows(connection)).toEqual(before);
    } finally {
      connection.close();
    }
  });

  it("keeps an observation that a later event names as its cause", () => {
    const { connection, journal } = openStore();
    try {
      const causeEventId = appendObserved(journal, {
        checkoutId: ids.checkout,
        expectedVersion: 0,
        availability: "available",
        observedAt: "2026-08-20T09:01:00.000Z",
      });
      appendObserved(journal, {
        checkoutId: ids.checkout,
        expectedVersion: 1,
        availability: "available",
        observedAt: "2026-08-20T09:02:00.000Z",
        causationId: causeEventId,
      });

      const before = journalRows(connection);
      expect(compactSupersededCheckoutObservations(connection)).toEqual({
        checkoutsCompacted: 0,
        eventsRemoved: 0,
      });
      expect(journalRows(connection)).toEqual(before);
    } finally {
      connection.close();
    }
  });
});
