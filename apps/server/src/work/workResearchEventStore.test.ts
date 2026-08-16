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
import { WorkResearchEventStore } from "./workResearchEventStore";
import {
  decodeWorkResearchBriefId,
  decodeWorkResearchFrame,
  decodeWorkResearchRequestId,
  type WorkResearchBriefId,
  type WorkResearchFrame,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";

const directories: Array<string> = [];
const now = "2026-07-24T08:00:00.000Z";

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-work-research-eventstore-"));
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
  brief: decodeWorkResearchBriefId("11111111-1111-4111-8111-111111111111"),
  request: decodeWorkResearchRequestId("55555555-5555-4555-8555-555555555555"),
  project: "66666666-6666-4666-8666-666666666666",
  actor: "77777777-7777-4777-8777-777777777777",
} as const;

const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });

function briefCreatedFrame(
  version = 1,
  briefId: WorkResearchBriefId = ids.brief,
): WorkResearchFrame {
  return decodeWorkResearchFrame({
    requestId: ids.request,
    projectId: ids.project,
    sequence: version,
    occurredAt: now,
    transition: {
      kind: "brief-created",
      brief: {
        briefId,
        projectId: ids.project,
        questions: ["What are the tradeoffs?"],
        sourcePolicy: {
          allowedKinds: ["web", "file", "user-reference", "mail-export"],
          maxSources: 8,
          excerptByteBudget: 64_000,
        },
        notes: [],
        deliverables: ["report"],
        status: "draft",
        createdBy: { kind: "local-user", actorId: ids.actor },
        createdAt: now,
        version,
      },
    },
  });
}

function createStore(): WorkResearchEventStore {
  const connection = openConnection();
  const registry = new EventRegistry().register("work.research-recorded@1", 1, Schema.Unknown);
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  const journal = new Journal({ connection, registry, projections, clock: () => now });
  let counter = 0;
  const uuid = () => {
    counter += 1;
    const suffix = counter.toString(16).padStart(12, "0");
    return `cccccccc-cccc-4ccc-8ccc-${suffix}`;
  };
  return new WorkResearchEventStore({ journal, uuid, actor });
}

describe("WorkResearchEventStore", () => {
  it("appends a brief-created frame and returns the committed frame", () => {
    const store = createStore();
    const frame = store.append({
      briefId: ids.brief,
      expectedVersion: 0,
      frame: briefCreatedFrame(1),
    });
    expect(frame.transition.kind).toBe("brief-created");
    expect(frame.transition.brief.version).toBe(1);
  });

  it("rejects an append whose expected version does not match the current head (optimistic concurrency)", () => {
    const store = createStore();
    store.append({ briefId: ids.brief, expectedVersion: 0, frame: briefCreatedFrame(1) });
    expect(() =>
      store.append({ briefId: ids.brief, expectedVersion: 0, frame: briefCreatedFrame(2) }),
    ).toThrow();
  });

  it("replays frames for a brief in version order", () => {
    const store = createStore();
    store.append({ briefId: ids.brief, expectedVersion: 0, frame: briefCreatedFrame(1) });
    store.append({ briefId: ids.brief, expectedVersion: 1, frame: briefCreatedFrame(2) });
    const replay = store.replay({ briefId: ids.brief, afterVersion: 0, limit: 16 });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.frames.length).toBe(2);
    expect(replay.frames[0]?.transition.brief.version).toBe(1);
    expect(replay.frames[1]?.transition.brief.version).toBe(2);
    expect(replay.nextCursor).toBe(2);
  });

  it("replays all frames across briefs grouped by brief id", () => {
    const store = createStore();
    const otherBrief = decodeWorkResearchBriefId("99999999-9999-4999-8999-999999999999");
    store.append({ briefId: ids.brief, expectedVersion: 0, frame: briefCreatedFrame(1) });
    store.append({
      briefId: otherBrief,
      expectedVersion: 0,
      frame: briefCreatedFrame(1, otherBrief),
    });
    const replay = store.replayAll();
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.frames.length).toBe(2);
  });

  it("hydrates briefs from a host whose unrelated journal history exceeds the global scan cap", () => {
    // A long-lived host accumulates far more unrelated events than research
    // events. Research hydration must stay bounded by its own aggregate
    // history, so an ordinary restart never reports `snapshot-required` and
    // never leaves durable briefs unreadable.
    let globalBatches = 0;
    let aggregateBatches = 0;
    const journal = {
      append: () => {
        throw new Error("append must not be used during hydration");
      },
      replay: () => {
        globalBatches += 1;
        if (globalBatches > 200) return [];
        return Array.from({ length: 1_000 }, (_unused, index) => ({
          globalSequence: (globalBatches - 1) * 1_000 + index + 1,
          aggregateType: "work-turn",
          aggregateId: ids.project,
          aggregateVersion: 1,
          eventName: "work.turn-accepted@1",
          eventVersion: 1,
          payload: {},
        }));
      },
      replayAggregateType: (cursor: { readonly aggregateType: string }) => {
        expect(cursor.aggregateType).toBe("work-research");
        aggregateBatches += 1;
        return aggregateBatches === 1
          ? [
              {
                globalSequence: 250_000,
                aggregateType: "work-research",
                aggregateId: String(ids.brief),
                aggregateVersion: 1,
                eventName: "work.research-recorded@1",
                eventVersion: 1,
                payload: briefCreatedFrame(1),
              },
            ]
          : [];
      },
    };
    const store = new WorkResearchEventStore({
      journal: journal as never,
      uuid: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      actor,
    });

    const replay = store.replayAll();

    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.frames.length).toBe(1);
    expect(replay.frames[0]?.transition.brief.briefId).toBe(ids.brief);
  });

  it("rejects a frame whose brief id does not match the append request", () => {
    const store = createStore();
    const otherBrief = decodeWorkResearchBriefId("99999999-9999-4999-8999-999999999999");
    expect(() =>
      store.append({
        briefId: ids.brief,
        expectedVersion: 0,
        frame: briefCreatedFrame(1, otherBrief),
      }),
    ).toThrow();
  });
});
