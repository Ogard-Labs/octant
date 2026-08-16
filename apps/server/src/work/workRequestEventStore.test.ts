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
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { WorkRequestEventStore } from "./workRequestEventStore";
import {
  decodeWorkRequestFrame,
  decodeWorkRequestId,
  UtcTimestamp,
  type WorkRequestFrame,
  type WorkRequestId,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";

const directories: Array<string> = [];
const now = "2026-08-10T08:00:00.000Z";

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-work-request-store-"));
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
  request: decodeWorkRequestId("11111111-1111-4111-8111-111111111111"),
  otherRequest: decodeWorkRequestId("99999999-9999-4999-8999-999999999999"),
  project: "22222222-2222-4222-8222-222222222222",
  thread: "33333333-3333-4333-8333-333333333333",
  provider: "44444444-4444-4444-8444-444444444444",
  actor: "55555555-5555-4555-8555-555555555555",
} as const;

const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });
const systemActor = Schema.decodeUnknownSync(EventActor)({ kind: "system", actorId: ids.actor });
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const requestedAt = "2026-08-10T08:00:00.000Z";
const settledAt = "2026-08-10T08:05:00.000Z";

function requestedFrame(version = 1, requestId: WorkRequestId = ids.request): WorkRequestFrame {
  return decodeWorkRequestFrame({
    kind: "requested",
    request: {
      requestId,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.provider,
      providerRequestId: "provider-req-1",
      detail: {
        kind: "approval",
        action: "run-terminal-command",
        description: "Run `bun install`.",
      },
      status: "pending",
      requestedAt,
      version,
    },
  });
}

function resolvedFrame(version = 2): WorkRequestFrame {
  return decodeWorkRequestFrame({
    kind: "resolved",
    request: {
      requestId: ids.request,
      projectId: ids.project,
      threadId: ids.thread,
      providerInstanceId: ids.provider,
      providerSessionId: ids.provider,
      providerRequestId: "provider-req-1",
      detail: {
        kind: "approval",
        action: "run-terminal-command",
        description: "Run `bun install`.",
      },
      status: "resolved",
      resolution: { kind: "approval", approved: true },
      requestedAt,
      settledAt,
      version,
    },
  });
}

function createStore(): WorkRequestEventStore {
  const connection = openConnection();
  const registry = new EventRegistry().register("work.request-recorded@1", 1, Schema.Unknown);
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  const journal = new Journal({ connection, registry, projections, clock: () => now });
  return new WorkRequestEventStore({ journal, uuid: createUuid() });
}

function append(
  store: WorkRequestEventStore,
  input: Omit<Parameters<WorkRequestEventStore["append"]>[0], "actor" | "occurredAt">,
) {
  return store.append({ ...input, occurredAt: decodeTimestamp(requestedAt), actor });
}

function createUuid(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const suffix = counter.toString(16).padStart(12, "0");
    return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
  };
}

describe("WorkRequestEventStore", () => {
  it("appends a requested frame and returns the committed frame", () => {
    const store = createStore();
    const frame = append(store, {
      requestId: ids.request,
      expectedVersion: 0,
      frame: requestedFrame(1),
    });
    expect(frame.kind).toBe("requested");
    expect(frame.request.version).toBe(1);
  });

  it("uses the supplied actor and transition time in the journal envelope", () => {
    let recordedActor: typeof EventActor.Type | undefined;
    let recordedAt: string | undefined;
    const journal = {
      append: (input: any) => {
        recordedActor = input.events[0]?.actor;
        recordedAt = input.events[0]?.occurredAt;
        return {
          events: [
            {
              ...input.events[0],
              aggregateType: input.aggregate.aggregateType,
              aggregateId: input.aggregate.aggregateId,
              aggregateVersion: input.expectedVersion + 1,
            },
          ],
        };
      },
      replay: () => [],
      replayAggregateType: () => [],
    };
    const store = new WorkRequestEventStore({ journal: journal as never, uuid: createUuid() });

    store.append({
      requestId: ids.request,
      expectedVersion: 0,
      frame: requestedFrame(1),
      occurredAt: decodeTimestamp(settledAt),
      actor: systemActor,
    });

    expect(recordedActor).toEqual(systemActor);
    expect(recordedAt).toBe(settledAt);
  });

  it("rejects an append whose expected version does not match the current head", () => {
    const store = createStore();
    append(store, { requestId: ids.request, expectedVersion: 0, frame: requestedFrame(1) });
    expect(() =>
      append(store, { requestId: ids.request, expectedVersion: 0, frame: resolvedFrame(2) }),
    ).toThrow();
  });

  it("appends a resolved frame when the expected version matches the current head", () => {
    const store = createStore();
    append(store, { requestId: ids.request, expectedVersion: 0, frame: requestedFrame(1) });
    const frame = append(store, {
      requestId: ids.request,
      expectedVersion: 1,
      frame: resolvedFrame(2),
    });
    expect(frame.kind).toBe("resolved");
  });

  it("rejects an append whose frame version is not one greater than the expected head", () => {
    const store = createStore();
    expect(() =>
      append(store, { requestId: ids.request, expectedVersion: 0, frame: requestedFrame(2) }),
    ).toThrow();
  });

  it("rejects an append whose frame request id does not match the request", () => {
    const store = createStore();
    const mismatched = requestedFrame(1, ids.otherRequest);
    expect(() =>
      append(store, { requestId: ids.request, expectedVersion: 0, frame: mismatched }),
    ).toThrow();
  });

  it("appends through the real phase1 runtime registry, not only a test-only registry", () => {
    const connection = openConnection();
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const store = new WorkRequestEventStore({ journal, uuid: createUuid() });
    const frame = append(store, {
      requestId: ids.request,
      expectedVersion: 0,
      frame: requestedFrame(1),
    });
    expect(frame.kind).toBe("requested");
    expect(frame.request.version).toBe(1);
    const replay = store.replay({ requestId: ids.request, afterVersion: 0, limit: 10 });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.frames).toHaveLength(1);
  });

  it("replays frames for a request in version order", () => {
    const store = createStore();
    append(store, { requestId: ids.request, expectedVersion: 0, frame: requestedFrame(1) });
    append(store, { requestId: ids.request, expectedVersion: 1, frame: resolvedFrame(2) });
    const replay = store.replay({ requestId: ids.request, afterVersion: 0, limit: 10 });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.frames).toHaveLength(2);
    expect(replay.frames[0]?.kind).toBe("requested");
    expect(replay.frames[1]?.kind).toBe("resolved");
    expect(replay.nextCursor).toBe(2);
  });

  it("replays no frames for an unknown request", () => {
    const store = createStore();
    const replay = store.replay({ requestId: ids.request, afterVersion: 0, limit: 10 });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.frames).toHaveLength(0);
  });

  it("rejects an invalid replay limit", () => {
    const store = createStore();
    expect(() => store.replay({ requestId: ids.request, afterVersion: 0, limit: 0 })).toThrow();
  });

  it("replays all request frames across requests in version order", () => {
    const store = createStore();
    append(store, { requestId: ids.request, expectedVersion: 0, frame: requestedFrame(1) });
    append(store, {
      requestId: ids.otherRequest,
      expectedVersion: 0,
      frame: requestedFrame(1, ids.otherRequest),
    });
    append(store, { requestId: ids.request, expectedVersion: 1, frame: resolvedFrame(2) });
    const result = store.replayAll();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.frames).toHaveLength(3);
    const requestFrames = result.frames.filter((f) => f.request.requestId === ids.request);
    expect(requestFrames).toHaveLength(2);
    expect(requestFrames[0]?.request.version).toBe(1);
    expect(requestFrames[1]?.request.version).toBe(2);
  });

  it("replays no frames from an empty journal", () => {
    const store = createStore();
    const result = store.replayAll();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.frames).toHaveLength(0);
  });

  it("replays request events without scanning unrelated journal history", () => {
    let aggregateReads = 0;
    const journal = {
      append: () => undefined,
      replay: () => {
        throw new Error("global replay must not be used for request hydration");
      },
      replayAggregateType: (cursor: { aggregateType: string }) => {
        expect(cursor.aggregateType).toBe("work-request");
        aggregateReads += 1;
        return aggregateReads === 1
          ? [
              {
                aggregateType: cursor.aggregateType,
                aggregateId: String(ids.request),
                aggregateVersion: 1,
                eventName: "work.request-recorded@1",
                eventVersion: 1,
                payload: requestedFrame(1),
              },
            ]
          : [];
      },
    };
    const store = new WorkRequestEventStore({
      journal: journal as never,
      uuid: createUuid(),
    });
    const result = store.replayAll();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.frames).toHaveLength(1);
    expect(aggregateReads).toBe(1);
  });

  it("fails closed when a full replay frame does not match its aggregate identity", () => {
    let reads = 0;
    const journal = {
      append: () => undefined,
      replay: () => [],
      replayAggregateType: () => {
        reads += 1;
        return reads === 1
          ? [
              {
                globalSequence: 1,
                aggregateType: "work-request",
                aggregateId: String(ids.otherRequest),
                aggregateVersion: 1,
                eventName: "work.request-recorded@1",
                eventVersion: 1,
                payload: requestedFrame(1, ids.request),
              },
            ]
          : [];
      },
    };
    const store = new WorkRequestEventStore({
      journal: journal as never,
      uuid: createUuid(),
    });
    expect(store.replayAll()).toEqual({ status: "snapshot-required", reason: "identity-mismatch" });
  });
});
