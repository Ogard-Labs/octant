import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  EventActor,
  decodeNativeHarnessSlotCandidate,
  decodeNativeHarnessTurnRecord,
  type NativeHarnessTurnRecord,
} from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { registerNativeHarnessEvents } from "./nativeHarnessEvents";
import { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";

const directories: string[] = [];
const now = "2026-10-06T12:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});
const threadId = "00000000-0000-4000-8000-000000000020";
const lead = decodeNativeHarnessSlotCandidate({
  hostId: "00000000-0000-4000-8000-0000000000aa",
  providerInstanceId: "00000000-0000-4000-8000-000000000001",
  modelId: "frontier-large",
});
let counter = 0;
const uuid = () => `bbbbbbbb-bbbb-4bbb-8bbb-${(++counter).toString(16).padStart(12, "0")}`;

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-harness-session-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function storeOn(connection: SqliteConnection): NativeHarnessSessionStore {
  return new NativeHarnessSessionStore({
    journal: new Journal({
      connection,
      registry: registerNativeHarnessEvents(new EventRegistry()),
      projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
      clock: () => now,
    }),
    uuid,
    actor,
    clock: () => now,
  });
}

function turn(
  sessionId: string,
  sequence: number,
  overrides: Record<string, unknown>,
): NativeHarnessTurnRecord {
  return decodeNativeHarnessTurnRecord({
    turnId: uuid(),
    sessionId,
    sequence,
    job: "lead",
    route: {
      kind: "primary",
      job: "lead",
      slotId: "default",
      candidate: lead,
      decidedAt: now,
      rejected: [],
    },
    toolCalls: 0,
    stopReason: "end-of-turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    startedAt: "2026-10-06T12:00:00.000Z",
    endedAt: "2026-10-06T12:00:10.000Z",
    ...overrides,
  });
}

describe("native harness session totals", () => {
  it("rebuilds the same usage and timing totals after a restart", () => {
    const connection = openConnection();
    const live = storeOn(connection);
    const session = live.ensure({
      threadId,
      mode: "code",
      leadSlotId: "default" as never,
      lead,
    });
    live.recordTurn(
      threadId,
      turn(session.id, 1, {
        usage: {
          inputTokens: 1_000,
          outputTokens: 100,
          cacheReadInputTokens: 800,
          reasoningTokens: 20,
        },
        metrics: {
          precision: "exact",
          wallMs: 10_000,
          timeToFirstTokenMs: 1_000,
          decodeOutputTokens: 100,
          decodeMs: 2_000,
          toolMs: 0,
          modelCalls: 1,
        },
      }),
    );
    live.recordTurn(
      threadId,
      turn(session.id, 2, {
        stopReason: "provider-failure",
        usage: { inputTokens: 500, outputTokens: 0 },
        metrics: { precision: "unavailable", wallMs: 3_000 },
      }),
    );

    const restarted = storeOn(connection);

    const expected = live.read(threadId)?.session;
    const replayed = restarted.read(threadId)?.session;
    expect({
      usage: replayed?.usage,
      metrics: replayed?.metrics,
      turns: replayed?.turnsRun,
    }).toEqual({ usage: expected?.usage, metrics: expected?.metrics, turns: expected?.turnsRun });
    expect(expected?.usage).toEqual({
      inputTokens: 1_500,
      outputTokens: 100,
      cacheReadInputTokens: 800,
      reasoningTokens: 20,
    });
    expect(expected?.metrics).toEqual({
      turns: 2,
      measuredTurns: 1,
      precision: "exact",
      decodeOutputTokens: 100,
      decodeMs: 2_000,
      toolMs: 0,
      timeToFirstTokenTotalMs: 1_000,
    });
  });

  it("keeps counting turns recorded before timing was kept without inventing timing for them", () => {
    const store = storeOn(openConnection());
    const session = store.ensure({ threadId, mode: "code", leadSlotId: "default" as never, lead });

    store.recordTurn(
      threadId,
      turn(session.id, 1, { usage: { inputTokens: 10, outputTokens: 2 } }),
    );

    const read = store.read(threadId)?.session;
    expect(read?.turnsRun).toBe(1);
    expect(read?.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(read?.metrics).toBeUndefined();
  });
});
