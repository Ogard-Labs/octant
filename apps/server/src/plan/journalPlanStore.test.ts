import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { PlanService, PlanServiceError } from "./planService";
import { JournalPlanStore } from "./journalPlanStore";

const now = "2026-08-18T09:00:00.000Z";
const directories: Array<string> = [];
const connections: Array<SqliteConnection> = [];

const ids = {
  thread: "3f100000-0000-4000-8000-000000000001",
  otherThread: "3f100000-0000-4000-8000-000000000002",
  plan: "3f100000-0000-4000-8000-000000000003",
  otherPlan: "3f100000-0000-4000-8000-000000000004",
  revision: "3f100000-0000-4000-8000-000000000005",
  nextRevision: "3f100000-0000-4000-8000-000000000006",
  otherRevision: "3f100000-0000-4000-8000-000000000007",
  stepOne: "3f100000-0000-4000-8000-000000000008",
  stepTwo: "3f100000-0000-4000-8000-000000000009",
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
  const directory = mkdtempSync(join(tmpdir(), "octant-plan-store-"));
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

async function seed(service: PlanService): Promise<void> {
  await service.execute({
    kind: "propose-thread-plan",
    threadId: ids.thread,
    expectedVersion: 0,
    planId: ids.plan,
    revisionId: ids.revision,
    title: "Land the replay fix",
    steps: [
      { stepId: ids.stepOne, title: "Reproduce the gap", rationale: "The report is vague." },
      { stepId: ids.stepTwo, title: "Fix the projection" },
    ],
  });
  await service.execute({
    kind: "approve-thread-plan",
    threadId: ids.thread,
    expectedVersion: 1,
    planId: ids.plan,
    revisionId: ids.revision,
  });
  await service.execute({
    kind: "set-thread-plan-step-status",
    threadId: ids.thread,
    expectedVersion: 2,
    planId: ids.plan,
    stepId: ids.stepOne,
    status: "done",
  });
  await service.execute({
    kind: "propose-thread-plan",
    threadId: ids.otherThread,
    expectedVersion: 0,
    planId: ids.otherPlan,
    revisionId: ids.otherRevision,
    title: "A different thread's plan",
    steps: [{ stepId: ids.stepOne, title: "Its own first step" }],
  });
}

describe("JournalPlanStore", () => {
  it("gives a plan back exactly as it was after the host restarts", async () => {
    const path = storePath();
    const first = openJournal(path);
    const before = new JournalPlanStore({ journal: first.journal });
    await seed(new PlanService({ store: before, clock: () => now }));
    const beforeThread = before.read(ids.thread);
    first.close();

    const second = openJournal(path);
    const after = new JournalPlanStore({ journal: second.journal }).read(ids.thread);

    expect(after).toEqual(beforeThread);
    expect(after.plan?.status).toBe("approved");
    expect(after.plan?.steps.map((step) => step.status)).toEqual(["done", "pending"]);
  });

  it("keeps each thread's plan to itself", async () => {
    const journal = openJournal(storePath()).journal;
    const store = new JournalPlanStore({ journal });
    await seed(new PlanService({ store, clock: () => now }));

    expect(store.read(ids.otherThread).plan?.title).toBe("A different thread's plan");
    expect(store.read("3f100000-0000-4000-8000-0000000000ff")).toEqual({
      plan: null,
      history: [],
    });
  });

  it("refuses a command built on a version the journal has already moved past", async () => {
    const journal = openJournal(storePath()).journal;
    const service = new PlanService({
      store: new JournalPlanStore({ journal }),
      clock: () => now,
    });
    await seed(service);

    await expect(
      service.execute({
        kind: "approve-thread-plan",
        threadId: ids.thread,
        expectedVersion: 1,
        planId: ids.plan,
        revisionId: ids.revision,
      }),
    ).rejects.toBeInstanceOf(PlanServiceError);
  });
});
