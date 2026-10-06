import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { EventActor, type TurnMetrics, type TurnMetricsRecord } from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { registerTurnMetricsEvents, TurnMetricsStore } from "./turnMetricsStore";

const directories: string[] = [];
const now = "2026-10-06T12:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});
const threadA = "00000000-0000-4000-8000-000000000020";
const threadB = "00000000-0000-4000-8000-000000000021";
const projectA = "00000000-0000-4000-8000-0000000000aa";
const projectB = "00000000-0000-4000-8000-0000000000bb";
const provider = "00000000-0000-4000-8000-000000000001";

const exact: TurnMetrics = {
  precision: "exact",
  wallMs: 10_000,
  timeToFirstTokenMs: 1_000,
  decodeOutputTokens: 100,
  decodeMs: 2_000,
  toolMs: 0,
  modelCalls: 1,
};
const approximate: TurnMetrics = {
  precision: "approximate",
  wallMs: 30_000,
  timeToFirstTokenMs: 3_000,
  decodeOutputTokens: 100,
  decodeMs: 8_000,
  toolMs: 12_000,
  modelCalls: 1,
};

function turn(overrides: Record<string, unknown> = {}): TurnMetricsRecord {
  return {
    threadId: threadA,
    mode: "code",
    projectId: projectA,
    providerInstanceId: provider,
    modelId: "model-a",
    stopReason: "end-of-turn",
    usage: { inputTokens: 1_000, outputTokens: 100, cacheReadInputTokens: 800 },
    metrics: exact,
    startedAt: "2026-10-06T12:00:00.000Z",
    endedAt: "2026-10-06T12:00:10.000Z",
    ...overrides,
  } as never;
}

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-turn-metrics-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

let counter = 0;

function storeOn(connection: SqliteConnection): TurnMetricsStore {
  return new TurnMetricsStore({
    journal: new Journal({
      connection,
      registry: registerTurnMetricsEvents(new EventRegistry()),
      projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
      clock: () => now,
    }),
    uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${(++counter).toString(16).padStart(12, "0")}`,
    actor,
    clock: () => now,
  });
}

const everything = { kind: "projects", projectIds: [projectA, projectB] } as const;

describe("turn metrics store", () => {
  it("gives a restarted host the same session totals the live one had", () => {
    const connection = openConnection();
    const live = storeOn(connection);
    live.record(turn());
    live.record(
      turn({
        metrics: approximate,
        usage: { inputTokens: 500, outputTokens: 100 },
        startedAt: "2026-10-06T12:01:00.000Z",
        endedAt: "2026-10-06T12:01:30.000Z",
      }),
    );
    live.record(turn({ stopReason: "failed", metrics: { precision: "unavailable", wallMs: 900 } }));

    const restarted = storeOn(connection);

    const expected = live.summarize({ subjectAggregateId: threadA }, everything);
    expect(restarted.summarize({ subjectAggregateId: threadA }, everything)).toEqual(expected);
    expect(expected?.metrics).toMatchObject({
      turns: 3,
      measuredTurns: 2,
      precision: "approximate",
      decodeOutputTokens: 200,
      decodeMs: 10_000,
    });
    expect(expected?.usage).toEqual({
      inputTokens: 2_500,
      outputTokens: 300,
      cacheReadInputTokens: 1_600,
    });
  });

  it("keeps writing on the thread's own aggregate after a restart", () => {
    const connection = openConnection();
    storeOn(connection).record(turn());
    const restarted = storeOn(connection);

    restarted.record(turn({ endedAt: "2026-10-06T12:05:00.000Z" }));

    expect(storeOn(connection).summarize({}, everything)?.turnCount).toBe(2);
  });

  it("answers only for the Projects the reader is in", () => {
    const store = storeOn(openConnection());
    store.record(turn());
    store.record(turn({ threadId: threadB, projectId: projectB as never }));

    expect(store.summarize({}, { kind: "projects", projectIds: [projectA] })?.turnCount).toBe(1);
    expect(store.summarize({}, { kind: "projects", projectIds: [] })).toBeUndefined();
    expect(store.summarize({}, { kind: "unfiled" })).toBeUndefined();
  });

  it("reads the turns of threads no Project owns only for an unfiled reader", () => {
    const store = storeOn(openConnection());
    const { projectId: _projectId, ...unfiledChat } = turn({ mode: "chat" });
    store.record(unfiledChat as never);

    expect(store.summarize({}, { kind: "unfiled" })?.turnCount).toBe(1);
    expect(store.summarize({}, everything)).toBeUndefined();
  });

  it("narrows a read to a thread, a provider, a mode or a time range", () => {
    const store = storeOn(openConnection());
    store.record(turn());
    store.record(
      turn({
        threadId: threadB,
        mode: "work",
        modelId: "model-b" as never,
        endedAt: "2026-10-07T12:00:00.000Z",
        startedAt: "2026-10-07T11:59:00.000Z",
      }),
    );

    expect(store.summarize({ subjectAggregateId: threadB }, everything)?.turnCount).toBe(1);
    expect(store.summarize({ modelId: "model-a" }, everything)?.turnCount).toBe(1);
    expect(store.summarize({ mode: "work" }, everything)?.turnCount).toBe(1);
    expect(store.summarize({ from: "2026-10-07T00:00:00.000Z" }, everything)?.turnCount).toBe(1);
    expect(store.summarize({ subjectAggregateType: "chat-thread" }, everything)).toBeUndefined();
  });

  it("returns the recent tail but totals every turn", () => {
    const store = storeOn(openConnection());
    for (let index = 0; index < 55; index += 1) {
      const second = String(index).padStart(2, "0");
      store.record(
        turn({
          startedAt: `2026-10-06T12:00:${second}.000Z`,
          endedAt: `2026-10-06T12:00:${second}.500Z`,
        }),
      );
    }

    const summary = store.summarize({}, everything);

    expect(summary?.turns).toHaveLength(50);
    expect(summary?.turnCount).toBe(55);
    expect(summary?.metrics.turns).toBe(55);
    expect(summary?.turns.at(-1)?.endedAt).toBe("2026-10-06T12:00:54.500Z");
  });
});
