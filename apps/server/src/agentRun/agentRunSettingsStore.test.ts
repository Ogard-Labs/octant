import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  AgentRunPolicySettings,
  CorrelationId,
  EventId,
  effectiveAgentRunConcurrency,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  AGENT_RUN_SETTINGS_AGGREGATE_ID,
  AGENT_RUN_SETTINGS_AGGREGATE_TYPE,
  AGENT_RUN_SETTINGS_UPDATED,
  AgentRunSettingsStore,
  AgentRunSettingsStoreError,
} from "./agentRunSettingsStore";

const directories: Array<string> = [];
const now = "2026-08-01T10:00:00.000Z";

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-agent-run-settings-store-"));
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

const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});

function createJournal(connection = openConnection()) {
  const registry = new EventRegistry().register(
    AGENT_RUN_SETTINGS_UPDATED,
    1,
    AgentRunPolicySettings,
  );
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  return new Journal({ connection, registry, projections, clock: () => now });
}

function createStore(journal = createJournal()): AgentRunSettingsStore {
  let counter = 0;
  const uuid = () => {
    counter += 1;
    return `aaaaaaaa-aaaa-4aaa-8aaa-${counter.toString(16).padStart(12, "0")}`;
  };
  return new AgentRunSettingsStore({ journal, uuid, actor, clock: () => now });
}

describe("AgentRunSettingsStore", () => {
  it("lets the agent start subagents on a host that never chose a posture", () => {
    const store = createStore();
    expect(store.current()).toEqual({ creationPosture: "automatic", version: 0, updatedAt: now });
  });

  it("reads a stored Ask as Off, since no one can start a subagent by hand any more", () => {
    const connection = openConnection();
    // A host that chose "Only when I start them" before that choice was removed.
    createJournal(connection).append({
      aggregate: {
        aggregateType: AGENT_RUN_SETTINGS_AGGREGATE_TYPE,
        aggregateId: AGENT_RUN_SETTINGS_AGGREGATE_ID,
      },
      expectedVersion: 0,
      events: [
        {
          eventId: Schema.decodeUnknownSync(EventId)("bbbbbbbb-bbbb-4bbb-8bbb-000000000001"),
          eventName: AGENT_RUN_SETTINGS_UPDATED,
          eventVersion: 1,
          correlationId: Schema.decodeUnknownSync(CorrelationId)(
            "bbbbbbbb-bbbb-4bbb-8bbb-000000000002",
          ),
          actor,
          occurredAt: now,
          payload: { creationPosture: "ask", version: 1, updatedAt: now },
        },
      ],
    });

    const store = createStore(createJournal(connection));
    expect(store.current()).toEqual({ creationPosture: "off", version: 1, updatedAt: now });
    // The next choice applies on top of the stored version, so it is not refused as stale.
    expect(store.update({ creationPosture: "automatic", expectedVersion: 1 }).version).toBe(2);
  });

  it("persists an update and reflects it immediately", () => {
    const store = createStore();
    const updated = store.update({ creationPosture: "off", expectedVersion: 0 });
    expect(updated.creationPosture).toBe("off");
    expect(updated.version).toBe(1);
    expect(store.current().creationPosture).toBe("off");
  });

  it("rejects a stale expected version rather than silently applying a change", () => {
    const store = createStore();
    store.update({ creationPosture: "automatic", expectedVersion: 0 });
    expect(() => store.update({ creationPosture: "off", expectedVersion: 0 })).toThrow(
      AgentRunSettingsStoreError,
    );
    // the earlier accepted value is untouched
    expect(store.current().creationPosture).toBe("automatic");
  });

  it("keeps the run-at-once limits a person chose across a posture change and a restart", () => {
    const journal = createJournal();
    const store = createStore(journal);
    expect(effectiveAgentRunConcurrency(store.current())).toEqual({ perThread: 4, onHost: 8 });
    store.update({
      creationPosture: "automatic",
      concurrency: { perThread: 6, onHost: 12 },
      expectedVersion: 0,
    });
    // Turning subagents off and on again leaves the limits alone.
    store.update({ creationPosture: "off", expectedVersion: 1 });
    expect(createStore(journal).current()).toMatchObject({
      creationPosture: "off",
      concurrency: { perThread: 6, onHost: 12 },
    });
  });

  it("refuses limits above the ceiling", () => {
    const store = createStore();
    expect(() =>
      store.update({
        creationPosture: "automatic",
        concurrency: { perThread: 17, onHost: 17 },
        expectedVersion: 0,
      }),
    ).toThrow(AgentRunSettingsStoreError);
  });

  it("rehydrates the latest posture from the journal after restart", () => {
    const connection = openConnection();
    const first = createStore(createJournal(connection));
    first.update({ creationPosture: "automatic", expectedVersion: 0 });

    const restarted = createStore(createJournal(connection));
    expect(restarted.current().creationPosture).toBe("automatic");
    expect(restarted.current().version).toBe(1);
  });

  it("rehydrates through the settings aggregate instead of scanning the global journal", () => {
    const journal = createJournal();
    const replay = vi.fn(() => {
      throw new Error("global journal replay must not be used for settings hydration");
    });
    const replayAggregate = vi.fn((cursor) => journal.replayAggregate(cursor));
    const scopedJournal = {
      append: journal.append.bind(journal),
      replay,
      replayAggregate,
    };

    const store = new AgentRunSettingsStore({
      journal: scopedJournal,
      uuid: () => "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      actor,
      clock: () => now,
    });

    expect(store.current().version).toBe(0);
    expect(replay).not.toHaveBeenCalled();
    expect(replayAggregate).toHaveBeenCalledWith({
      aggregateType: AGENT_RUN_SETTINGS_AGGREGATE_TYPE,
      aggregateId: AGENT_RUN_SETTINGS_AGGREGATE_ID,
      afterVersion: 0,
      limit: 1_000,
    });
  });
});
