import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeMemoryEntryId,
  decodeProject,
  decodeProjectId,
  type EventEnvelope,
  type MemoryEntry,
  type Project,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import {
  ProjectProjection,
  readMemoryEntry,
  readProject,
  readProjectMemory,
  readProjects,
  searchProjects,
} from "./projectProjection";
import { ProjectionQuarantined, rebuildProjection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite, type SqliteConnection } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-07-14T10:00:00.000Z";
const ids = {
  actor: "60000000-0000-4000-8000-000000000001",
  correlation: "60000000-0000-4000-8000-000000000002",
  chat: decodeProjectId("60000000-0000-4000-8000-000000000003"),
  work: decodeProjectId("60000000-0000-4000-8000-000000000004"),
  memory: decodeMemoryEntryId("60000000-0000-4000-8000-000000000005"),
  successor: decodeMemoryEntryId("60000000-0000-4000-8000-000000000006"),
} as const;

const actor = { kind: "local-user" as const, actorId: ids.actor };
const chat = project({ id: ids.chat, name: "Zeta notes", rank: "1/2" });
const work = project({
  id: ids.work,
  name: "Alpha Workspace",
  rank: "1/10",
  type: "work",
  pinned: true,
});

function project(input: {
  readonly id: string;
  readonly name: string;
  readonly rank: string;
  readonly type?: "chat" | "work";
  readonly pinned?: boolean;
  readonly lifecycle?: "active" | "archived";
  readonly version?: number;
}): Project {
  const common = {
    id: input.id,
    name: input.name,
    lifecycle: input.lifecycle ?? "active",
    pinned: input.pinned ?? false,
    rank: input.rank,
    version: input.version ?? 1,
    createdAt: now,
    updatedAt: now,
  };
  if ((input.type ?? "chat") === "chat") return decodeProject({ ...common, type: "chat" });
  const revision = {
    revisionId: "60000000-0000-4000-8000-000000000007",
    revision: 1,
    currentBinding: { canonicalRoot: "/tmp/alpha" },
    actor,
    changedAt: now,
  };
  return decodeProject({
    ...common,
    type: "work",
    binding: revision.currentBinding,
    bindingHistory: [revision],
  });
}

function memory(
  input: {
    readonly id?: string;
    readonly status?: "active" | "superseded" | "retracted";
    readonly version?: number;
  } = {},
): MemoryEntry {
  const common = {
    id: input.id ?? ids.memory,
    projectId: ids.chat,
    kind: "decision" as const,
    content: "Use deterministic replay.",
    provenance: { kind: "user-authored" as const },
    author: actor,
    version: input.version ?? 1,
    createdAt: now,
    updatedAt: now,
  };
  if (input.status === "superseded") {
    return { ...common, status: "superseded", supersededBy: ids.successor } as MemoryEntry;
  }
  if (input.status === "retracted") {
    return {
      ...common,
      status: "retracted",
      retractionReason: "Decision changed",
      retractedBy: actor,
      retractedAt: now,
    } as MemoryEntry;
  }
  return { ...common, status: "active" } as MemoryEntry;
}

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-project-projection-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function envelope(input: {
  readonly eventName: string;
  readonly aggregateType: "project" | "project-memory";
  readonly aggregateId?: string;
  readonly aggregateVersion?: number;
  readonly payload: unknown;
}): EventEnvelope {
  return {
    eventId: crypto.randomUUID(),
    globalSequence: 1,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId ?? ids.chat,
    aggregateVersion: input.aggregateVersion ?? 1,
    eventName: input.eventName,
    eventVersion: 1,
    correlationId: ids.correlation,
    actor,
    occurredAt: now,
    payload: input.payload,
  } as EventEnvelope;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ProjectProjection", () => {
  it("stores decoded Project snapshots and sorts by pin, rational rank, and ID", () => {
    const connection = openConnection();
    const projection = new ProjectProjection();
    projection.apply(
      connection,
      envelope({
        eventName: "project.created@1",
        aggregateType: "project",
        payload: { project: chat },
      }),
    );
    projection.apply(
      connection,
      envelope({
        eventName: "project.created@1",
        aggregateType: "project",
        aggregateId: ids.work,
        payload: { project: work },
      }),
    );

    expect(readProject(connection, ids.chat)).toEqual(chat);
    expect(readProjects(connection, { lifecycle: "active" })).toEqual([work, chat]);
    expect(readProjects(connection, { type: "chat", lifecycle: "active" })).toEqual([chat]);
    expect(searchProjects(connection, "alpha", { lifecycle: "active" })).toEqual([work]);
    expect(searchProjects(connection, "/TMP/ALPHA", { lifecycle: "active" })).toEqual([work]);
    connection.close();
  });

  it("replays the canonical Code Project access policy event", () => {
    const connection = openConnection();
    const projection = new ProjectProjection();
    const code = decodeProject({
      ...work,
      type: "code",
      codeAccessPersistence: "project-default",
      version: 2,
    });
    projection.apply(
      connection,
      envelope({
        eventName: "project.code-access-changed@1",
        aggregateType: "project",
        aggregateId: code.id,
        aggregateVersion: code.version,
        payload: { project: code },
      }),
    );

    expect(readProject(connection, code.id)).toEqual(code);
    connection.close();
  });

  it("keeps archived Projects explicit and ignores stale or duplicate snapshots", () => {
    const connection = openConnection();
    const projection = new ProjectProjection();
    const archived = decodeProject({ ...chat, lifecycle: "archived", version: 2 });
    projection.apply(
      connection,
      envelope({
        eventName: "project.lifecycle-changed@1",
        aggregateType: "project",
        aggregateVersion: 2,
        payload: { project: archived },
      }),
    );
    projection.apply(
      connection,
      envelope({
        eventName: "project.created@1",
        aggregateType: "project",
        aggregateVersion: 1,
        payload: { project: chat },
      }),
    );
    projection.apply(
      connection,
      envelope({
        eventName: "project.lifecycle-changed@1",
        aggregateType: "project",
        aggregateVersion: 2,
        payload: { project: archived },
      }),
    );

    expect(readProjects(connection, { lifecycle: "active" })).toEqual([]);
    expect(readProjects(connection, { lifecycle: "archived" })).toEqual([archived]);
    expect(readProject(connection, ids.chat)).toEqual(archived);
    connection.close();
  });

  it("preserves active memory, immutable history, supersession, retraction, and transfer provenance", () => {
    const connection = openConnection();
    const projection = new ProjectProjection();
    const first = memory();
    const previous = memory({ status: "superseded", version: 2 });
    const successor = memory({ id: ids.successor, version: 1 });
    projection.apply(
      connection,
      envelope({
        eventName: "memory.entry-created@1",
        aggregateType: "project-memory",
        payload: { entry: first },
      }),
    );
    projection.apply(
      connection,
      envelope({
        eventName: "memory.entry-superseded@1",
        aggregateType: "project-memory",
        aggregateVersion: 2,
        payload: { previousEntry: previous, entry: successor },
      }),
    );

    expect(readMemoryEntry(connection, ids.chat, ids.memory)).toEqual(previous);
    expect(readProjectMemory(connection, ids.chat)).toEqual({
      projectId: ids.chat,
      active: [successor],
      history: [previous],
    });

    const retracted = memory({ id: ids.successor, status: "retracted", version: 2 });
    projection.apply(
      connection,
      envelope({
        eventName: "memory.entry-retracted@1",
        aggregateType: "project-memory",
        aggregateVersion: 3,
        payload: { entry: retracted },
      }),
    );

    const transferred = {
      ...memory({ id: "60000000-0000-4000-8000-000000000008" }),
      provenance: {
        kind: "transferred" as const,
        sourceProjectId: ids.work,
        sourceEntryId: "60000000-0000-4000-8000-000000000009",
        destinationProjectId: ids.chat,
        transferredBy: actor,
        transferredAt: now,
        selectedContent: "Use deterministic replay.",
      },
    };
    projection.apply(
      connection,
      envelope({
        eventName: "memory.entry-transferred@1",
        aggregateType: "project-memory",
        aggregateVersion: 4,
        payload: { entry: transferred },
      }),
    );
    expect(readMemoryEntry(connection, ids.chat, transferred.id)).toEqual(transferred);
    expect(readProjectMemory(connection, ids.chat)).toEqual({
      projectId: ids.chat,
      active: [transferred],
      history: [previous, retracted],
    });
    connection.close();
  });

  it.each([2, 3])(
    "ignores an aggregate version %i event that introduces an unseen entry after memory reached version 3",
    (staleVersion) => {
      const connection = openConnection();
      const projection = new ProjectProjection();
      const previous = memory({ status: "superseded", version: 2 });
      const successor = memory({ id: ids.successor });
      projection.apply(
        connection,
        envelope({
          eventName: "memory.entry-created@1",
          aggregateType: "project-memory",
          aggregateVersion: 1,
          payload: { entry: memory() },
        }),
      );
      projection.apply(
        connection,
        envelope({
          eventName: "memory.entry-superseded@1",
          aggregateType: "project-memory",
          aggregateVersion: 2,
          payload: { previousEntry: previous, entry: successor },
        }),
      );

      expect(readMemoryEntry(connection, ids.chat, ids.memory)).toEqual(previous);
      expect(readMemoryEntry(connection, ids.chat, ids.successor)).toEqual(successor);

      projection.apply(
        connection,
        envelope({
          eventName: "memory.entry-retracted@1",
          aggregateType: "project-memory",
          aggregateVersion: 3,
          payload: { entry: memory({ id: ids.successor, status: "retracted", version: 2 }) },
        }),
      );
      const unseenEntry = memory({ id: "60000000-0000-4000-8000-000000000013" });
      projection.apply(
        connection,
        envelope({
          eventName: "memory.entry-created@1",
          aggregateType: "project-memory",
          aggregateVersion: staleVersion,
          payload: { entry: unseenEntry },
        }),
      );

      expect(readMemoryEntry(connection, ids.chat, unseenEntry.id)).toBeUndefined();
      connection.close();
    },
  );

  it.each([
    ["wrong aggregate type", { aggregateType: "project" as const }],
    ["wrong aggregate ID", { aggregateId: ids.work }],
  ])("rejects a memory event with %s before writing", (_name, override) => {
    const connection = openConnection();
    const projection = new ProjectProjection();
    expect(() =>
      projection.apply(
        connection,
        envelope({
          eventName: "memory.entry-created@1",
          aggregateType: "project-memory",
          payload: { entry: memory() },
          ...override,
        }),
      ),
    ).toThrow();
    expect(readProjectMemory(connection, ids.chat).active).toEqual([]);
    connection.close();
  });

  it.each([
    ["wrong aggregate type", { aggregateType: "project-memory" as const }],
    ["wrong aggregate ID", { aggregateId: ids.work }],
    ["payload version mismatch", { aggregateVersion: 2 }],
  ])("rejects a Project event with %s before writing", (_name, override) => {
    const connection = openConnection();
    const projection = new ProjectProjection();
    expect(() =>
      projection.apply(
        connection,
        envelope({
          eventName: "project.created@1",
          aggregateType: "project",
          payload: { project: chat },
          ...override,
        }),
      ),
    ).toThrow();
    expect(readProject(connection, ids.chat)).toBeUndefined();
    connection.close();
  });

  it("resets both tables and rebuilds them deterministically from the journal", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    journal.append({
      aggregate: { aggregateType: "project", aggregateId: ids.chat },
      expectedVersion: 0,
      events: [
        {
          eventId: "60000000-0000-4000-8000-000000000010",
          eventName: "project.created@1",
          eventVersion: 1,
          correlationId: ids.correlation,
          actor,
          occurredAt: now,
          payload: { project: chat },
        },
      ],
    });
    journal.append({
      aggregate: { aggregateType: "project-memory", aggregateId: ids.chat },
      expectedVersion: 0,
      events: [
        {
          eventId: "60000000-0000-4000-8000-000000000012",
          eventName: "memory.entry-created@1",
          eventVersion: 1,
          correlationId: ids.correlation,
          actor,
          occurredAt: now,
          payload: { entry: memory() },
        },
      ],
    });
    const projection = runtime.projections.get("projects")!;
    projection.reset(connection);
    expect(readProject(connection, ids.chat)).toBeUndefined();
    expect(readProjectMemory(connection, ids.chat).active).toEqual([]);
    rebuildProjection({ connection, journal, projection, clock: () => now });
    expect(readProject(connection, ids.chat)).toEqual(chat);
    expect(readProjectMemory(connection, ids.chat).active).toEqual([memory()]);
    connection.close();
  });

  it("quarantines replayed events whose envelope identity conflicts with the payload", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    connection
      .prepare(`INSERT INTO event_journal (
      event_id, aggregate_type, aggregate_id, aggregate_version, event_name, event_version,
      correlation_id, causation_id, actor_kind, actor_id, occurred_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "60000000-0000-4000-8000-000000000011",
        "project",
        ids.work,
        1,
        "project.created@1",
        1,
        ids.correlation,
        null,
        actor.kind,
        actor.actorId,
        now,
        JSON.stringify({ project: chat }),
      );

    expect(() =>
      rebuildProjection({
        connection,
        journal,
        projection: runtime.projections.get("projects")!,
        clock: () => now,
      }),
    ).toThrow(ProjectionQuarantined);
    expect(
      connection
        .prepare("SELECT reason FROM event_quarantine WHERE projection_name = 'projects'")
        .get(),
    ).toEqual({ reason: "projection-application-failed" });
    connection.close();
  });
});
