import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { GoalService, GoalServiceError } from "./goalService";
import { JournalGoalStore, THREAD_GOAL_AGGREGATE_TYPE } from "./journalGoalStore";

const now = "2026-08-15T09:00:00.000Z";
const directories: Array<string> = [];
const connections: Array<SqliteConnection> = [];

const ids = {
  goal: "3f000000-0000-4000-8000-000000000001",
  revision: "3f000000-0000-4000-8000-000000000002",
  nextRevision: "3f000000-0000-4000-8000-000000000003",
  thread: "3f000000-0000-4000-8000-000000000004",
  otherGoal: "3f000000-0000-4000-8000-000000000005",
  otherRevision: "3f000000-0000-4000-8000-000000000006",
  otherThread: "3f000000-0000-4000-8000-000000000007",
} as const;

afterEach(() => {
  for (const connection of connections.splice(0)) {
    try {
      connection.close();
    } catch {
      // Already closed by the test that exercised a restart.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function storePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-goal-store-"));
  directories.push(directory);
  return join(directory, "octant.sqlite3");
}

function openJournal(path: string): { readonly journal: Journal; readonly close: () => void } {
  const connection = openSqlite(path);
  connections.push(connection);
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  return {
    journal: new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    }),
    close: () => connection.close(),
  };
}

async function seedGoals(service: GoalService): Promise<void> {
  await service.execute({
    kind: "create-thread-goal",
    threadId: ids.thread,
    expectedVersion: 0,
    goalId: ids.goal,
    revisionId: ids.revision,
    objective: "Make Goals durable",
    budget: { turnBudget: 4 },
  });
  await service.execute({
    kind: "revise-thread-goal",
    threadId: ids.thread,
    expectedVersion: 1,
    goalId: ids.goal,
    revisionId: ids.nextRevision,
    objective: "Make Goals durable across restart",
    budget: { turnBudget: 8 },
  });
  await service.execute({
    kind: "record-thread-goal-usage",
    threadId: ids.thread,
    expectedVersion: 2,
    goalId: ids.goal,
    deltaTokens: 120,
    deltaElapsedMs: 4_000,
    deltaTurns: 1,
  });
  await service.execute({
    kind: "create-thread-goal",
    threadId: ids.otherThread,
    expectedVersion: 0,
    goalId: ids.otherGoal,
    revisionId: ids.otherRevision,
    objective: "Second thread keeps its own Goal",
    budget: {},
  });
}

describe("JournalGoalStore", () => {
  it("rebuilds the identical aggregate from the journal after a restart", async () => {
    const path = storePath();
    const first = openJournal(path);
    const before = new JournalGoalStore({ journal: first.journal });
    await seedGoals(new GoalService({ store: before, clock: () => now }));
    const beforeThread = before.read(ids.thread);
    const beforeOther = before.read(ids.otherThread);
    expect(beforeThread.goal?.version).toBe(3);
    expect(beforeThread.history).toHaveLength(2);
    first.close();

    const second = openJournal(path);
    const after = new JournalGoalStore({ journal: second.journal });

    expect(after.read(ids.thread)).toEqual(beforeThread);
    expect(after.read(ids.otherThread)).toEqual(beforeOther);
    expect(after.read("3f000000-0000-4000-8000-0000000000ff")).toEqual({ goal: null, history: [] });
  });

  it("keeps commanding the rebuilt Goal without reusing a spent version", async () => {
    const path = storePath();
    const first = openJournal(path);
    await seedGoals(
      new GoalService({
        store: new JournalGoalStore({ journal: first.journal }),
        clock: () => now,
      }),
    );
    first.close();

    const second = openJournal(path);
    const service = new GoalService({
      store: new JournalGoalStore({ journal: second.journal }),
      clock: () => now,
    });

    await expect(
      service.execute({
        kind: "pause-thread-goal",
        threadId: ids.thread,
        expectedVersion: 1,
        goalId: ids.goal,
      }),
    ).rejects.toMatchObject({ category: "stale" });

    const paused = await service.execute({
      kind: "pause-thread-goal",
      threadId: ids.thread,
      expectedVersion: 3,
      goalId: ids.goal,
    });
    expect(paused.goal.status).toBe("paused");
    expect(paused.goal.version).toBe(4);
  });

  it("replays idempotently so a rebuilt store never doubles history", async () => {
    const path = storePath();
    const opened = openJournal(path);
    const store = new JournalGoalStore({ journal: opened.journal });
    await seedGoals(new GoalService({ store, clock: () => now }));

    const rebuiltOnce = new JournalGoalStore({ journal: opened.journal });
    const rebuiltTwice = new JournalGoalStore({ journal: opened.journal });

    expect(rebuiltOnce.read(ids.thread)).toEqual(store.read(ids.thread));
    expect(rebuiltTwice.read(ids.thread)).toEqual(rebuiltOnce.read(ids.thread));
  });

  it("reports a moved journal head as stale instead of overwriting it", async () => {
    const path = storePath();
    const opened = openJournal(path);
    const store = new JournalGoalStore({ journal: opened.journal });
    const service = new GoalService({ store, clock: () => now });
    const created = await service.execute({
      kind: "create-thread-goal",
      threadId: ids.thread,
      expectedVersion: 0,
      goalId: ids.goal,
      revisionId: ids.revision,
      objective: "Concurrency stays optimistic",
      budget: {},
    });

    // A second writer advances the durable head under the in-memory view.
    opened.journal.append({
      aggregate: { aggregateType: THREAD_GOAL_AGGREGATE_TYPE, aggregateId: ids.thread },
      expectedVersion: 1,
      events: [
        {
          eventId: randomUUID(),
          eventName: "thread.goal-updated@1",
          eventVersion: 1,
          correlationId: randomUUID(),
          actor: { kind: "system", actorId: "00000000-0000-4000-8000-000000000876" },
          occurredAt: now,
          payload: {
            goal: { ...created.goal, status: "paused", version: 2 },
            history: created.history,
          },
        },
      ],
    });

    await expect(
      service.execute({
        kind: "pause-thread-goal",
        threadId: ids.thread,
        expectedVersion: 1,
        goalId: ids.goal,
      }),
    ).rejects.toMatchObject({ name: "GoalServiceError", category: "stale" });
  });

  it("fails closed and retains the last durable Goal when the journal write fails", async () => {
    const path = storePath();
    const opened = openJournal(path);
    let failAppend = false;
    const store = new JournalGoalStore({
      journal: {
        append: (input, options) => {
          if (failAppend) throw new Error("journal unavailable");
          return opened.journal.append(input, options);
        },
        replayAggregateType: (cursor) => opened.journal.replayAggregateType(cursor),
      },
    });
    const service = new GoalService({ store, clock: () => now });
    const created = await service.execute({
      kind: "create-thread-goal",
      threadId: ids.thread,
      expectedVersion: 0,
      goalId: ids.goal,
      revisionId: ids.revision,
      objective: "Never drop a Goal",
      budget: {},
    });

    failAppend = true;
    await expect(
      service.execute({
        kind: "pause-thread-goal",
        threadId: ids.thread,
        expectedVersion: 1,
        goalId: ids.goal,
      }),
    ).rejects.toBeInstanceOf(GoalServiceError);

    expect(store.read(ids.thread).goal).toEqual(created.goal);
    failAppend = false;
    expect(new JournalGoalStore({ journal: opened.journal }).read(ids.thread).goal).toEqual(
      created.goal,
    );
  });
});
