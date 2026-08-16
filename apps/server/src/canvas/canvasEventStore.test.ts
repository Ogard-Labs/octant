import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  CANVAS_SCHEMA_VERSION,
  CanvasCreated,
  CanvasVersionAppended,
  decodeCanvasId,
  decodeCanvasVersion,
  type CanvasVersion,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  CANVAS_AGGREGATE_TYPE,
  CANVAS_CREATED,
  CANVAS_VERSION_APPENDED,
  CanvasEventStore,
  CanvasEventStoreError,
} from "./canvasEventStore";
import { CanvasProjection } from "./canvasProjection";

const directories: Array<string> = [];
const now = "2026-08-01T21:00:00.000Z";
const later = "2026-08-01T21:01:00.000Z";

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-canvas-store-"));
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
  canvas: "11111111-1111-4111-8111-111111111111",
  canvasB: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  version: "22222222-2222-4222-8222-222222222222",
  version2: "33333333-3333-4333-8333-333333333333",
  version3: "44444444-4444-4444-8444-444444444444",
  source: "55555555-5555-4555-8555-555555555555",
  project: "66666666-6666-4666-8666-666666666666",
  thread: "77777777-7777-4777-8777-777777777777",
  provider: "88888888-8888-4888-8888-888888888888",
  actor: "99999999-9999-4999-8999-999999999999",
} as const;

const canvasId = decodeCanvasId(ids.canvas);
const canvasIdB = decodeCanvasId(ids.canvasB);

const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });

const provenance = {
  mode: "chat",
  hostId: "local",
  projectId: ids.project,
  threadId: ids.thread,
  actor: { kind: "local-user", actorId: ids.actor },
  providerInstanceId: ids.provider,
  modelId: "octant-test-model",
  createdAt: now,
} as const;

const source = {
  sourceId: ids.source,
  kind: "attachment",
  hostId: "local",
  projectId: ids.project,
  opaqueRef: "source-token-1",
  displayName: "notes.md",
} as const;

const definition = {
  schemaVersion: CANVAS_SCHEMA_VERSION,
  title: "Canvas event store fixture",
  provenance,
  sourceManifest: [source],
  blocks: [
    {
      blockId: "block-1",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "heading",
      level: 1,
      text: "A bounded Canvas",
    },
  ],
} as const;

function version(overrides: Record<string, unknown> = {}): CanvasVersion {
  return decodeCanvasVersion({
    schemaVersion: CANVAS_SCHEMA_VERSION,
    canvasId: ids.canvas,
    versionId: ids.version,
    sequence: 1,
    definition,
    createdBy: provenance.actor,
    createdAt: now,
    ...overrides,
  });
}

function createStore(connection = openConnection()): CanvasEventStore {
  const registry = new EventRegistry()
    .register(CANVAS_CREATED, 1, CanvasCreated)
    .register(CANVAS_VERSION_APPENDED, 1, CanvasVersionAppended);
  const projections = new ProjectionRegistry()
    .register(new AggregateHeadsProjection())
    .register(new CanvasProjection());
  const journal = new Journal({
    connection,
    registry,
    projections,
    clock: () => now,
  });
  let counter = 0;
  const uuid = () => {
    counter += 1;
    const suffix = counter.toString(16).padStart(12, "0");
    return `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`;
  };
  return new CanvasEventStore({ journal, uuid, actor });
}

describe("CanvasEventStore", () => {
  it("appends a Canvas create at aggregate version 1 with correct event identity", () => {
    const store = createStore();
    const v1 = version();
    const envelope = store.appendCreate({
      canvasId,
      version: v1,
      occurredAt: now as never,
    });
    expect(envelope.aggregateType).toBe(CANVAS_AGGREGATE_TYPE);
    expect(envelope.aggregateId).toBe(ids.canvas);
    expect(envelope.aggregateVersion).toBe(1);
    expect(envelope.eventName).toBe(CANVAS_CREATED);
    expect(envelope.eventVersion).toBe(1);
    expect(envelope.payload).toEqual({ canvasId: ids.canvas, version: v1 });
  });

  it("appends a version with optimistic concurrency at the next aggregate version", () => {
    const store = createStore();
    const v1 = version();
    store.appendCreate({ canvasId, version: v1, occurredAt: now as never });
    const v2 = version({ versionId: ids.version2, sequence: 2, createdAt: later });
    const envelope = store.appendVersion({
      canvasId,
      current: v1,
      next: v2,
      occurredAt: later as never,
    });
    expect(envelope.aggregateVersion).toBe(2);
    expect(envelope.eventName).toBe(CANVAS_VERSION_APPENDED);
    expect(envelope.payload).toEqual({ canvasId: ids.canvas, version: v2 });
  });

  it("rejects a version append with a stale expected version (optimistic concurrency)", () => {
    const store = createStore();
    const v1 = version();
    store.appendCreate({ canvasId, version: v1, occurredAt: now as never });
    const v2 = version({ versionId: ids.version2, sequence: 2, createdAt: later });
    store.appendVersion({ canvasId, current: v1, next: v2, occurredAt: later as never });
    const v3 = version({ versionId: ids.version3, sequence: 3, createdAt: later });
    expect(() =>
      store.appendVersion({ canvasId, current: v1, next: v3, occurredAt: later as never }),
    ).toThrow(CanvasEventStoreError);
  });

  it("rejects a duplicate create for the same canvas id", () => {
    const store = createStore();
    store.appendCreate({ canvasId, version: version(), occurredAt: now as never });
    expect(() =>
      store.appendCreate({ canvasId, version: version(), occurredAt: now as never }),
    ).toThrow(CanvasEventStoreError);
  });

  it("rejects a create whose first version is not sequence 1", () => {
    const store = createStore();
    expect(() =>
      store.appendCreate({
        canvasId,
        version: version({ sequence: 2 }),
        occurredAt: now as never,
      }),
    ).toThrow(CanvasEventStoreError);
  });

  it("rejects a version append that does not increment sequence by one", () => {
    const store = createStore();
    const v1 = version();
    store.appendCreate({ canvasId, version: v1, occurredAt: now as never });
    expect(() =>
      store.appendVersion({
        canvasId,
        current: v1,
        next: version({ versionId: ids.version2, sequence: 3 }),
        occurredAt: later as never,
      }),
    ).toThrow(CanvasEventStoreError);
  });

  it("rejects a version append whose canvasId does not match the current canvas", () => {
    const store = createStore();
    const v1 = version();
    store.appendCreate({ canvasId, version: v1, occurredAt: now as never });
    expect(() =>
      store.appendVersion({
        canvasId,
        current: v1,
        next: version({ canvasId: ids.canvasB, versionId: ids.version2, sequence: 2 }),
        occurredAt: later as never,
      }),
    ).toThrow(CanvasEventStoreError);
  });

  it("replays a canvas's events in order after restart from journal truth", () => {
    const connection = openConnection();
    const first = createStore(connection);
    const v1 = version();
    first.appendCreate({ canvasId, version: v1, occurredAt: now as never });
    const v2 = version({ versionId: ids.version2, sequence: 2, createdAt: later });
    first.appendVersion({ canvasId, current: v1, next: v2, occurredAt: later as never });
    const v3 = version({ versionId: ids.version3, sequence: 3, createdAt: later });
    first.appendVersion({ canvasId, current: v2, next: v3, occurredAt: later as never });

    const restarted = createStore(connection);
    const replay = restarted.replayCanvas({ canvasId, afterVersion: 0, limit: 10 });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.events.map((event) => event.eventName)).toEqual([
      CANVAS_CREATED,
      CANVAS_VERSION_APPENDED,
      CANVAS_VERSION_APPENDED,
    ]);
    expect(replay.events.map((event) => event.aggregateVersion)).toEqual([1, 2, 3]);
    expect(replay.nextCursor).toBe(3);
  });

  it("replays only events after the requested version cursor", () => {
    const connection = openConnection();
    const first = createStore(connection);
    const v1 = version();
    first.appendCreate({ canvasId, version: v1, occurredAt: now as never });
    const v2 = version({ versionId: ids.version2, sequence: 2, createdAt: later });
    first.appendVersion({ canvasId, current: v1, next: v2, occurredAt: later as never });

    const restarted = createStore(connection);
    const replay = restarted.replayCanvas({ canvasId, afterVersion: 1, limit: 10 });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.events.map((event) => event.eventName)).toEqual([CANVAS_VERSION_APPENDED]);
    expect(replay.nextCursor).toBe(2);
  });

  it("isolates replay to the requested canvas id", () => {
    const connection = openConnection();
    const first = createStore(connection);
    first.appendCreate({ canvasId, version: version(), occurredAt: now as never });
    first.appendCreate({
      canvasId: canvasIdB,
      version: version({ canvasId: ids.canvasB }),
      occurredAt: now as never,
    });

    const restarted = createStore(connection);
    const replay = restarted.replayCanvas({ canvasId: canvasIdB, afterVersion: 0, limit: 10 });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]!.aggregateId).toBe(ids.canvasB);
  });

  it("reports a snapshot-required gap when a version append appears without a preceding create", () => {
    const connection = openConnection();
    // Append a raw canvas.version-appended event without a create to simulate a
    // corrupted/partial journal where the create was lost. The replay scanner
    // must report a gap rather than silently accepting the orphan version.
    const registry = new EventRegistry()
      .register(CANVAS_CREATED, 1, CanvasCreated)
      .register(CANVAS_VERSION_APPENDED, 1, CanvasVersionAppended);
    const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
    const journal = new Journal({
      connection,
      registry,
      projections,
      clock: () => now,
    });
    const orphanVersion = version({ versionId: ids.version2, sequence: 2 });
    journal.append({
      aggregate: { aggregateType: CANVAS_AGGREGATE_TYPE, aggregateId: canvasId as never },
      expectedVersion: 0,
      events: [
        {
          eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          eventName: CANVAS_VERSION_APPENDED,
          eventVersion: 1,
          correlationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now as never,
          payload: { canvasId: ids.canvas, version: orphanVersion },
        },
      ],
    });

    const scanner = createStore(connection);
    const replay = scanner.replayCanvas({ canvasId, afterVersion: 0, limit: 10 });
    expect(replay.status).toBe("snapshot-required");
    if (replay.status === "snapshot-required") {
      expect(replay.reason).toBe("gap");
    }
  });

  it("rejects an invalid create payload before appending", () => {
    const store = createStore();
    expect(() =>
      store.appendCreate({
        canvasId,
        version: { ...version(), canvasId: "not-a-uuid" } as never,
        occurredAt: now as never,
      }),
    ).toThrow(CanvasEventStoreError);
  });
});
