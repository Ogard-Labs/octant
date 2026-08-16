import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { WorkflowEventStore } from "./workflowEventStore";
import {
  decodeWorkflowFrame,
  decodeWorkflowId,
  type WorkflowFrame,
  type WorkflowId,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";

const directories: Array<string> = [];
const now = "2026-08-10T08:00:00.000Z";

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-work-workflow-store-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const ids = {
  workflow: decodeWorkflowId("11111111-1111-4111-8111-111111111111"),
  otherWorkflow: decodeWorkflowId("99999999-9999-4999-8999-999999999999"),
  project: "22222222-2222-4222-8222-222222222222",
  thread: "33333333-3333-4333-8333-333333333333",
  actor: "55555555-5555-4555-8555-555555555555",
} as const;

const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });
const startedAt = "2026-08-10T08:00:00.000Z";
const updatedAt = "2026-08-10T08:05:00.000Z";

function startedFrame(version = 1, workflowId: WorkflowId = ids.workflow): WorkflowFrame {
  return decodeWorkflowFrame({
    kind: "started",
    workflow: {
      workflowId,
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "active",
      startedAt,
      updatedAt: startedAt,
      version,
    },
  });
}

function completedFrame(version = 2): WorkflowFrame {
  return decodeWorkflowFrame({
    kind: "completed",
    workflow: {
      workflowId: ids.workflow,
      projectId: ids.project,
      relatedThreadId: ids.thread,
      label: "Draft the launch brief",
      lifecycle: "completed",
      startedAt,
      updatedAt,
      version,
    },
  });
}

interface JournalLike {
  append: (request: {
    readonly aggregate: { readonly aggregateType: string; readonly aggregateId: string };
    readonly expectedVersion: number;
    readonly events: ReadonlyArray<{
      readonly eventId: string;
      readonly eventName: string;
      readonly eventVersion: number;
      readonly correlationId: string;
      readonly actor: { readonly kind: "local-user"; readonly actorId: string };
      readonly occurredAt: string;
      readonly payload: unknown;
    }>;
  }) => unknown;
  replay: Journal["replay"];
}

function createJournal(): JournalLike {
  const connection = openConnection();
  const registry = new EventRegistry().register("work.workflow-recorded@1", 1, Schema.Unknown);
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  return new Journal({
    connection,
    registry,
    projections,
    clock: () => now,
  }) as unknown as JournalLike;
}

let counter = 0;
function uuid(): string {
  counter += 1;
  const suffix = counter.toString(16).padStart(12, "0");
  return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
}

function createStore(journal: JournalLike = createJournal()): WorkflowEventStore {
  return new WorkflowEventStore({ journal: journal as unknown as Journal, uuid, actor });
}

describe("WorkflowEventStore", () => {
  it("appends a started frame and returns the committed frame", () => {
    const store = createStore();
    const frame = store.append({
      workflowId: ids.workflow,
      expectedVersion: 0,
      frame: startedFrame(1),
    });
    expect(frame.kind).toBe("started");
    expect(frame.workflow.version).toBe(1);
  });

  it("rejects an append whose expected version does not match the current head", () => {
    const store = createStore();
    store.append({ workflowId: ids.workflow, expectedVersion: 0, frame: startedFrame(1) });
    expect(() =>
      store.append({ workflowId: ids.workflow, expectedVersion: 0, frame: completedFrame(2) }),
    ).toThrow();
  });

  it("appends a completed frame when the expected version matches the current head", () => {
    const store = createStore();
    store.append({ workflowId: ids.workflow, expectedVersion: 0, frame: startedFrame(1) });
    const frame = store.append({
      workflowId: ids.workflow,
      expectedVersion: 1,
      frame: completedFrame(2),
    });
    expect(frame.kind).toBe("completed");
  });

  it("rejects an append whose frame version is not one greater than the expected head", () => {
    const store = createStore();
    expect(() =>
      store.append({ workflowId: ids.workflow, expectedVersion: 0, frame: startedFrame(2) }),
    ).toThrow();
  });

  it("rejects an append whose frame workflow id does not match the request", () => {
    const store = createStore();
    const mismatchedFrame = startedFrame(1, ids.otherWorkflow);
    expect(() =>
      store.append({ workflowId: ids.workflow, expectedVersion: 0, frame: mismatchedFrame }),
    ).toThrow();
  });

  it("replays all workflow frames across workflows in version order", () => {
    const store = createStore();
    store.append({ workflowId: ids.workflow, expectedVersion: 0, frame: startedFrame(1) });
    store.append({
      workflowId: ids.otherWorkflow,
      expectedVersion: 0,
      frame: startedFrame(1, ids.otherWorkflow),
    });
    store.append({ workflowId: ids.workflow, expectedVersion: 1, frame: completedFrame(2) });
    const result = store.replayAll();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.frames).toHaveLength(3);
    const workflowFrames = result.frames.filter((f) => f.workflow.workflowId === ids.workflow);
    expect(workflowFrames).toHaveLength(2);
    expect(workflowFrames[0]?.workflow.version).toBe(1);
    expect(workflowFrames[1]?.workflow.version).toBe(2);
  });

  it("replays no frames from an empty journal", () => {
    const store = createStore();
    const result = store.replayAll();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.frames).toHaveLength(0);
  });

  it("fails closed when a journaled frame does not decode as a workflow frame", () => {
    const journal = createJournal();
    // Bypass the store to write a structurally invalid payload directly, as
    // if a future incompatible writer or storage corruption produced it.
    journal.append({
      aggregate: { aggregateType: "work-workflow", aggregateId: String(ids.workflow) },
      expectedVersion: 0,
      events: [
        {
          eventId: uuid(),
          eventName: "work.workflow-recorded@1",
          eventVersion: 1,
          correlationId: uuid(),
          actor: { kind: "local-user", actorId: ids.actor },
          occurredAt: now,
          payload: { kind: "started", workflow: { not: "a workflow" } },
        },
      ],
    });
    const store = createStore(journal);
    const result = store.replayAll();
    expect(result.status).toBe("snapshot-required");
    if (result.status !== "snapshot-required") return;
    expect(result.reason).toBe("invalid-frame");
  });

  it("fails closed when a frame's declared version disagrees with its journaled aggregate version", () => {
    const journal = createJournal();
    journal.append({
      aggregate: { aggregateType: "work-workflow", aggregateId: String(ids.workflow) },
      expectedVersion: 0,
      events: [
        {
          eventId: uuid(),
          eventName: "work.workflow-recorded@1",
          eventVersion: 1,
          correlationId: uuid(),
          actor: { kind: "local-user", actorId: ids.actor },
          occurredAt: now,
          payload: startedFrame(1),
        },
      ],
    });
    journal.append({
      aggregate: { aggregateType: "work-workflow", aggregateId: String(ids.workflow) },
      expectedVersion: 1,
      events: [
        {
          eventId: uuid(),
          eventName: "work.workflow-recorded@1",
          eventVersion: 1,
          correlationId: uuid(),
          actor: { kind: "local-user", actorId: ids.actor },
          occurredAt: now,
          // Declares version 3 even though this is only the second committed
          // event for this workflow (true aggregate version 2).
          payload: {
            kind: "completed",
            workflow: {
              workflowId: ids.workflow,
              projectId: ids.project,
              relatedThreadId: ids.thread,
              label: "Draft the launch brief",
              lifecycle: "completed",
              startedAt,
              updatedAt,
              version: 3,
            },
          },
        },
      ],
    });
    const store = createStore(journal);
    const result = store.replayAll();
    expect(result.status).toBe("snapshot-required");
    if (result.status !== "snapshot-required") return;
    expect(result.reason).toBe("identity-mismatch");
  });

  it("fails closed when a frame's workflow id disagrees with its journal aggregate id", () => {
    const journal = createJournal();
    journal.append({
      aggregate: { aggregateType: "work-workflow", aggregateId: String(ids.workflow) },
      expectedVersion: 0,
      events: [
        {
          eventId: uuid(),
          eventName: "work.workflow-recorded@1",
          eventVersion: 1,
          correlationId: uuid(),
          actor: { kind: "local-user", actorId: ids.actor },
          occurredAt: now,
          // Aggregate id says ids.workflow but the payload claims otherWorkflow.
          payload: startedFrame(1, ids.otherWorkflow),
        },
      ],
    });
    const store = createStore(journal);
    const result = store.replayAll();
    expect(result.status).toBe("snapshot-required");
    if (result.status !== "snapshot-required") return;
    expect(result.reason).toBe("identity-mismatch");
  });

  it("fails closed when a later frame changes immutable workflow history", () => {
    const journal = createJournal();
    journal.append({
      aggregate: { aggregateType: "work-workflow", aggregateId: String(ids.workflow) },
      expectedVersion: 0,
      events: [
        {
          eventId: uuid(),
          eventName: "work.workflow-recorded@1",
          eventVersion: 1,
          correlationId: uuid(),
          actor: { kind: "local-user", actorId: ids.actor },
          occurredAt: now,
          payload: startedFrame(1),
        },
      ],
    });
    journal.append({
      aggregate: { aggregateType: "work-workflow", aggregateId: String(ids.workflow) },
      expectedVersion: 1,
      events: [
        {
          eventId: uuid(),
          eventName: "work.workflow-recorded@1",
          eventVersion: 1,
          correlationId: uuid(),
          actor: { kind: "local-user", actorId: ids.actor },
          occurredAt: updatedAt,
          payload: {
            kind: "completed",
            workflow: {
              ...completedFrame(2).workflow,
              projectId: "44444444-4444-4444-8444-444444444444",
            },
          },
        },
      ],
    });

    const result = createStore(journal).replayAll();
    expect(result).toEqual({ status: "snapshot-required", reason: "identity-mismatch" });
  });

  it("fails closed when a terminal workflow receives another transition", () => {
    const journal = createJournal();
    journal.append({
      aggregate: { aggregateType: "work-workflow", aggregateId: String(ids.workflow) },
      expectedVersion: 0,
      events: [
        {
          eventId: uuid(),
          eventName: "work.workflow-recorded@1",
          eventVersion: 1,
          correlationId: uuid(),
          actor: { kind: "local-user", actorId: ids.actor },
          occurredAt: now,
          payload: startedFrame(1),
        },
      ],
    });
    journal.append({
      aggregate: { aggregateType: "work-workflow", aggregateId: String(ids.workflow) },
      expectedVersion: 1,
      events: [
        {
          eventId: uuid(),
          eventName: "work.workflow-recorded@1",
          eventVersion: 1,
          correlationId: uuid(),
          actor: { kind: "local-user", actorId: ids.actor },
          occurredAt: updatedAt,
          payload: completedFrame(2),
        },
      ],
    });
    journal.append({
      aggregate: { aggregateType: "work-workflow", aggregateId: String(ids.workflow) },
      expectedVersion: 2,
      events: [
        {
          eventId: uuid(),
          eventName: "work.workflow-recorded@1",
          eventVersion: 1,
          correlationId: uuid(),
          actor: { kind: "local-user", actorId: ids.actor },
          occurredAt: updatedAt,
          payload: {
            kind: "cancelled",
            workflow: {
              ...completedFrame(2).workflow,
              lifecycle: "cancelled",
              version: 3,
            },
          },
        },
      ],
    });

    const result = createStore(journal).replayAll();
    expect(result).toEqual({ status: "snapshot-required", reason: "identity-mismatch" });
  });

  it("does not apply the scan limit to unrelated global journal history", () => {
    let calls = 0;
    const journal: JournalLike = {
      append: () => undefined,
      replay: (cursor) => {
        calls += 1;
        if (calls > 100) return [];
        return Array.from({ length: 1_000 }, (_, index) => ({
          globalSequence: cursor.afterSequence + index + 1,
          aggregateType: "other-aggregate",
        })) as never;
      },
    };

    expect(createStore(journal).replayAll()).toEqual({ status: "ok", frames: [] });
  });
});
