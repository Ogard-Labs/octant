import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  EventActor,
  decodeNativeHarnessSlotCandidate,
  decodeProjectId,
  type NativeHarnessRoutingConfiguration,
} from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { registerNativeHarnessEvents } from "./nativeHarnessEvents";
import { NativeHarnessRoutingStore } from "./nativeHarnessRoutingStore";
import { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";

const directories: string[] = [];
const now = "2026-09-05T12:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});
const host = "00000000-0000-4000-8000-0000000000aa";
const candidate = (model: string) =>
  decodeNativeHarnessSlotCandidate({
    hostId: host,
    providerInstanceId: "00000000-0000-4000-8000-000000000001",
    modelId: model,
  });
const configuration = (
  slots: NativeHarnessRoutingConfiguration["slots"],
): NativeHarnessRoutingConfiguration => ({ slots, jobSlots: [] }) as never;

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-harness-store-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function journalFor(connection: SqliteConnection): Journal {
  return new Journal({
    connection,
    registry: registerNativeHarnessEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
}

function uuidFactory() {
  let counter = 0;
  return () => `aaaaaaaa-aaaa-4aaa-8aaa-${(++counter).toString(16).padStart(12, "0")}`;
}

describe("native harness routing store", () => {
  it("starts with bindings but no slots, and keeps a saved table across a restart", () => {
    const connection = openConnection();
    const uuid = uuidFactory();
    const store = new NativeHarnessRoutingStore({
      journal: journalFor(connection),
      uuid,
      actor,
      clock: () => now,
    });
    expect(store.host().configuration.slots).toEqual([]);
    expect(store.host().configuration.jobSlots.length).toBeGreaterThan(0);
    const updated = store.updateHost({
      configuration: {
        slots: [{ id: "default" as never, candidates: [candidate("big")] }],
        jobSlots: [{ job: "lead", slotId: "default" as never }],
      } as never,
      expectedVersion: 0 as never,
    });
    expect(updated.kind).toBe("routing-settings");
    const restarted = new NativeHarnessRoutingStore({
      journal: journalFor(connection),
      uuid,
      actor,
      clock: () => now,
    });
    expect(restarted.host().version).toBe(1);
    expect(restarted.host().configuration.slots[0]?.candidates[0]?.modelId).toBe("big");
  });

  it("refuses a stale update instead of overwriting a newer table", () => {
    const store = new NativeHarnessRoutingStore({
      journal: journalFor(openConnection()),
      uuid: uuidFactory(),
      actor,
      clock: () => now,
    });
    store.updateHost({ configuration: { slots: [], jobSlots: [] }, expectedVersion: 0 });
    const stale = store.updateHost({
      configuration: { slots: [], jobSlots: [] },
      expectedVersion: 0 as never,
    });
    expect(stale).toMatchObject({ kind: "routing-refused", reason: "stale-version" });
  });

  it("keeps a Project override apart from the host default and clears it on request", () => {
    const connection = openConnection();
    const uuid = uuidFactory();
    const store = new NativeHarnessRoutingStore({
      journal: journalFor(connection),
      uuid,
      actor,
      clock: () => now,
    });
    const projectId = decodeProjectId("00000000-0000-4000-8000-0000000000cc");
    const set = store.applyProjectCommand({
      kind: "set-project-routing-override",
      projectId,
      configuration: {
        slots: [{ id: "task" as never, candidates: [candidate("small")] }],
        jobSlots: [],
      },
      expectedVersion: 0 as never,
    });
    expect(set.kind).toBe("project-routing-override");
    expect(store.host().version).toBe(0);
    const restarted = new NativeHarnessRoutingStore({
      journal: journalFor(connection),
      uuid,
      actor,
      clock: () => now,
    });
    expect(restarted.projectOverride(projectId)?.configuration.slots[0]?.id).toBe("task");
    const cleared = restarted.applyProjectCommand({
      kind: "clear-project-routing-override",
      projectId,
      expectedVersion: 1 as never,
    });
    expect(cleared.kind).toBe("project-routing-override-cleared");
    expect(restarted.projectOverride(projectId)).toBeUndefined();
  });
});

describe("native harness session store", () => {
  it("journals a session's routes and follow-ups and rebuilds them after a restart", () => {
    const connection = openConnection();
    const threadId = "00000000-0000-4000-8000-000000000020";
    const uuid = uuidFactory();
    const store = new NativeHarnessSessionStore({
      journal: journalFor(connection),
      uuid,
      actor,
      clock: () => now,
    });
    store.ensure({
      threadId,
      mode: "code",
      leadSlotId: "default" as never,
      lead: candidate("big") as never,
    });
    store.recordRouteDecision(threadId, {
      kind: "primary",
      job: "researcher",
      slotId: "task" as never,
      candidate: candidate("small") as never,
      decidedAt: now as never,
      rejected: [],
    });
    store.recordFollowUps(threadId, {
      turnId: "00000000-0000-4000-8000-000000000031",
      suggestions: [
        {
          id: "00000000-0000-4000-8000-000000000041",
          title: "Add tests",
          prompt: "Write tests for the new parser.",
          target: "new-thread",
        },
      ],
    } as never);
    store.pause(threadId, "paused-by-advisor", "The diff touches the release script.");
    const restarted = new NativeHarnessSessionStore({
      journal: journalFor(connection),
      uuid,
      actor,
      clock: () => now,
    });
    const view = restarted.read(threadId);
    expect(view?.routes).toHaveLength(1);
    expect(view?.followUps?.suggestions[0]?.title).toBe("Add tests");
    expect(view?.session.status).toBe("paused-by-advisor");
    expect(restarted.resume(threadId)).toBe(true);
    expect(restarted.read(threadId)?.session.status).toBe("idle");
  });

  it("activates a follow-up once and refuses the second activation", () => {
    const threadId = "00000000-0000-4000-8000-000000000020";
    const store = new NativeHarnessSessionStore({
      journal: journalFor(openConnection()),
      uuid: uuidFactory(),
      actor,
      clock: () => now,
    });
    store.ensure({
      threadId,
      mode: "chat",
      leadSlotId: "default" as never,
      lead: candidate("big") as never,
    });
    const suggestionId = "00000000-0000-4000-8000-000000000041" as never;
    store.recordFollowUps(threadId, {
      turnId: "00000000-0000-4000-8000-000000000031",
      suggestions: [
        { id: suggestionId, title: "Next", prompt: "Do the next thing.", target: "same-thread" },
      ],
    } as never);
    const created = { kind: "same-thread", threadId } as const;
    expect(store.activateFollowUp(threadId, suggestionId, created)).toBe("activated");
    expect(store.activateFollowUp(threadId, suggestionId, created)).toBe("already-activated");
    expect(
      store.activateFollowUp(threadId, "00000000-0000-4000-8000-000000000099" as never, created),
    ).toBe("suggestion-not-found");
  });
});
