import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayCursor } from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AggregateHeadsProjection } from "./aggregateHeadsProjection";
import { EventRegistry } from "./eventRegistry";
import {
  ConcurrencyConflict,
  DuplicateEventIdentity,
  EventPayloadInvalid,
  JournalWriteFailed,
  UnknownEventName,
  UnsupportedEventVersion,
} from "./journalErrors";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { ProjectionRegistry } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { SHELL_SETTINGS_AGGREGATE_ID } from "./shellProjection";
import { openSqlite, type SqliteConnection, type SqliteStatement } from "./sqlitePort";

const directories: Array<string> = [];
const fixturePayload = Schema.Struct({
  value: Schema.String,
  threadId: Schema.optional(Schema.String),
});
const replayCursor = Schema.decodeUnknownSync(ReplayCursor);

const ids = {
  aggregate: "00000000-0000-4000-8000-000000000001",
  actor: "00000000-0000-4000-8000-000000000002",
  correlation: "00000000-0000-4000-8000-000000000003",
  event1: "00000000-0000-4000-8000-000000000004",
  event2: "00000000-0000-4000-8000-000000000005",
  event3: "00000000-0000-4000-8000-000000000006",
} as const;

function openMigratedConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-journal-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-07-13T10:00:00.000Z");
  return connection;
}

function pendingEvent(
  eventId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventId,
    eventName: "fixture.recorded",
    eventVersion: 1,
    correlationId: ids.correlation,
    actor: { kind: "system", actorId: ids.actor },
    occurredAt: "2026-07-13T10:00:00.000Z",
    payload: { value: eventId },
    ...overrides,
  };
}

function appendRequest(events: ReadonlyArray<Record<string, unknown>>, expectedVersion = 0) {
  return {
    aggregate: { aggregateType: "fixture", aggregateId: ids.aggregate },
    expectedVersion,
    events,
  };
}

function createJournal(
  connection: SqliteConnection,
  onCommitted?: ConstructorParameters<typeof Journal>[0]["onCommitted"],
) {
  const registry = new EventRegistry().register("fixture.recorded", 1, fixturePayload);
  return new Journal({
    connection,
    registry,
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => "2026-07-13T10:00:00.000Z",
    ...(onCommitted === undefined ? {} : { onCommitted }),
  });
}

function rowCount(connection: SqliteConnection, table: string): number {
  return (connection.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number })
    .count;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Journal", () => {
  it("rejects unknown event names and unsupported versions before opening a transaction", () => {
    const connection = openMigratedConnection();
    let transactionCount = 0;
    const tracked: SqliteConnection = {
      ...connection,
      transaction: (body) => {
        transactionCount += 1;
        return connection.transaction(body);
      },
    };
    const journal = createJournal(tracked);

    expect(() =>
      journal.append(appendRequest([pendingEvent(ids.event1, { eventName: "fixture.missing" })])),
    ).toThrow(UnknownEventName);
    expect(() =>
      journal.append(appendRequest([pendingEvent(ids.event1, { eventVersion: 2 })])),
    ).toThrow(UnsupportedEventVersion);
    expect(transactionCount).toBe(0);
    connection.close();
  });

  it("rejects a payload that does not match its registered schema", () => {
    const connection = openMigratedConnection();
    const journal = createJournal(connection);

    expect(() =>
      journal.append(appendRequest([pendingEvent(ids.event1, { payload: { value: 1 } })])),
    ).toThrow(EventPayloadInvalid);
    expect(rowCount(connection, "event_journal")).toBe(0);
    connection.close();
  });

  it("rejects a legacy shell settings payload at the current append boundary", () => {
    const connection = openMigratedConnection();
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => "2026-07-13T10:00:00.000Z",
    });

    expect(() =>
      journal.append({
        aggregate: { aggregateType: "shell-settings", aggregateId: SHELL_SETTINGS_AGGREGATE_ID },
        expectedVersion: 0,
        events: [
          pendingEvent(ids.event1, {
            eventName: "shell.settings-replaced",
            payload: {
              settings: {
                chatEnabled: true,
                workEnabled: true,
                sidebarWidth: 280,
                sidebarMaterial: "system",
              },
            },
          }),
        ],
      }),
    ).toThrow(EventPayloadInvalid);
    expect(rowCount(connection, "event_journal")).toBe(0);
    expect(rowCount(connection, "aggregate_heads")).toBe(0);
    expect(rowCount(connection, "shell_settings_projection")).toBe(0);
    connection.close();
  });

  it("appends and replays current shell settings values unchanged", () => {
    const connection = openMigratedConnection();
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => "2026-07-13T10:00:00.000Z",
    });
    const payload = {
      settings: {
        chatEnabled: true,
        workEnabled: true,
        sidebarWidth: 280,
        contextSidebarWidth: 640,
        firstRunOnboarding: "pending",
        automaticUpdateChecks: true,
        lastContextSurface: "project-memory",
        sidebarMaterial: "system",
        modeSwitcherPresentation: "dropdown",
        navigatorAssistant: {},
        projectViewSwitcherPresentation: "dropdown",
        userProfile: { accent: "indigo", avatar: { kind: "initials" } },
        sidebarBackground: {
          kind: "none",
          overlayColor: "#1a1a1c",
          overlayOpacity: 100,
          vibrancyMode: "off",
        },
        environmentPresentationByMode: { chat: "hidden", work: "floating", code: "floating" },
      },
    } as const;

    const committed = journal.append({
      aggregate: { aggregateType: "shell-settings", aggregateId: SHELL_SETTINGS_AGGREGATE_ID },
      expectedVersion: 0,
      events: [
        pendingEvent(ids.event1, {
          eventName: "shell.settings-replaced",
          payload,
        }),
      ],
    });

    expect(committed.events[0]?.payload).toEqual(payload);
    expect(journal.replay(replayCursor({ afterSequence: 0, limit: 10 }))[0]?.payload).toEqual(
      payload,
    );
    connection.close();
  });

  it.each([
    [
      "cyclic",
      () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      },
    ],
    ["bigint", () => ({ value: 1n })],
    ["undefined", () => ({ value: undefined })],
    ["function", () => ({ value: () => "private" })],
    ["symbol", () => ({ value: Symbol("private") })],
  ])("rejects %s and other non-JSON payloads before opening a transaction", (_name, payload) => {
    const connection = openMigratedConnection();
    let transactionCount = 0;
    const tracked: SqliteConnection = {
      ...connection,
      transaction: (body) => {
        transactionCount += 1;
        return connection.transaction(body);
      },
    };
    const registry = new EventRegistry().register("fixture.any", 1, Schema.Unknown);
    const journal = new Journal({
      connection: tracked,
      registry,
      projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
      clock: () => "2026-07-13T10:00:00.000Z",
    });

    expect(() =>
      journal.append(
        appendRequest([pendingEvent(ids.event1, { eventName: "fixture.any", payload: payload() })]),
      ),
    ).toThrow(EventPayloadInvalid);
    expect(transactionCount).toBe(0);
    connection.close();
  });

  it("appends one event at aggregate version one and global sequence one", () => {
    const connection = openMigratedConnection();
    const published: Array<unknown> = [];
    const journal = createJournal(connection, (append) => published.push(append));

    const committed = journal.append(appendRequest([pendingEvent(ids.event1)]));

    expect(committed.firstSequence).toBe(1);
    expect(committed.lastSequence).toBe(1);
    expect(committed.aggregateVersion).toBe(1);
    expect(committed.events[0]).toMatchObject({
      eventId: ids.event1,
      globalSequence: 1,
      aggregateVersion: 1,
      payload: { value: ids.event1 },
    });
    expect(published).toEqual([committed]);
    expect(rowCount(connection, "aggregate_heads")).toBe(1);
    connection.close();
  });

  it("persists and replays remote-device and agent EventActor attribution", () => {
    const connection = openMigratedConnection();
    const journal = createJournal(connection);
    const deviceId = "10000000-0000-4000-8000-000000000010";
    const providerInstanceId = "10000000-0000-4000-8000-000000000011";
    const threadId = "10000000-0000-4000-8000-000000000012";

    journal.append(
      appendRequest([
        pendingEvent(ids.event1, {
          actor: { kind: "remote-device", actorId: ids.actor, deviceId },
        }),
      ]),
    );
    journal.append(
      appendRequest(
        [
          pendingEvent(ids.event2, {
            actor: {
              kind: "agent",
              actorId: ids.actor,
              providerInstanceId,
              threadId,
            },
          }),
        ],
        1,
      ),
    );

    const replayed = journal.replay(replayCursor({ afterSequence: 0, limit: 10 }));
    expect(replayed[0]?.actor).toEqual({
      kind: "remote-device",
      actorId: ids.actor,
      deviceId,
    });
    expect(replayed[1]?.actor).toEqual({
      kind: "agent",
      actorId: ids.actor,
      providerInstanceId,
      threadId,
    });
    const stored = connection
      .prepare("SELECT actor_kind, actor_json FROM event_journal ORDER BY global_sequence")
      .all() as Array<{ actor_kind: string; actor_json: string }>;
    expect(stored[0]?.actor_kind).toBe("remote-device");
    expect(JSON.parse(stored[0]!.actor_json)).toMatchObject({ deviceId });
    expect(stored[1]?.actor_kind).toBe("agent");
    expect(JSON.parse(stored[1]!.actor_json)).toMatchObject({ providerInstanceId, threadId });
    connection.close();
  });

  it("contains a post-commit notification failure and returns the committed append", () => {
    const connection = openMigratedConnection();
    const privateSentinel = "private-publisher-sentinel";
    const journal = createJournal(connection, () => {
      throw new Error(privateSentinel);
    });

    let committed: ReturnType<Journal["append"]> | undefined;
    expect(() => {
      committed = journal.append(appendRequest([pendingEvent(ids.event1)]));
    }).not.toThrow();

    expect(committed).toMatchObject({ firstSequence: 1, lastSequence: 1, aggregateVersion: 1 });
    expect(journal.replay(replayCursor({ afterSequence: 0, limit: 10 }))).toHaveLength(1);
    expect(rowCount(connection, "event_journal")).toBe(1);
    expect(rowCount(connection, "aggregate_heads")).toBe(1);
    connection.close();
  });

  it("appends a same-aggregate batch with contiguous versions and sequences", () => {
    const connection = openMigratedConnection();
    const journal = createJournal(connection);

    const committed = journal.append(
      appendRequest([pendingEvent(ids.event1), pendingEvent(ids.event2)]),
    );

    expect(committed.events.map((event) => event.aggregateVersion)).toEqual([1, 2]);
    expect(committed.events.map((event) => event.globalSequence)).toEqual([1, 2]);
    expect(committed).toMatchObject({ firstSequence: 1, lastSequence: 2, aggregateVersion: 2 });
    expect(journal.headSequence()).toBe(2);
    connection.close();
  });

  it("returns ConcurrencyConflict and writes nothing for a stale expected version", () => {
    const connection = openMigratedConnection();
    const journal = createJournal(connection);
    journal.append(appendRequest([pendingEvent(ids.event1)]));

    expect(() => journal.append(appendRequest([pendingEvent(ids.event2)], 0))).toThrow(
      ConcurrencyConflict,
    );
    expect(rowCount(connection, "event_journal")).toBe(1);
    connection.close();
  });

  it("converts an aggregate-version race into ConcurrencyConflict", () => {
    const connection = openMigratedConnection();
    createJournal(connection).append(appendRequest([pendingEvent(ids.event1)]));
    const secondSequence = Number(
      connection
        .prepare(`
          INSERT INTO event_journal (
            event_id, aggregate_type, aggregate_id, aggregate_version,
            event_name, event_version, correlation_id, causation_id,
            actor_kind, actor_id, occurred_at, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          ids.event2,
          "fixture",
          ids.aggregate,
          2,
          "fixture.recorded",
          1,
          ids.correlation,
          null,
          "system",
          ids.actor,
          "2026-07-13T10:00:00.000Z",
          JSON.stringify({ value: ids.event2 }),
        ).lastInsertRowid,
    );
    const raced: SqliteConnection = {
      ...connection,
      transaction: (body) => () => {
        try {
          return connection.transaction(body)();
        } catch (error) {
          connection
            .prepare(`
              UPDATE aggregate_heads
              SET aggregate_version = 2, last_sequence = ?
              WHERE aggregate_type = ? AND aggregate_id = ?
            `)
            .run(secondSequence, "fixture", ids.aggregate);
          throw error;
        }
      },
    };
    const journal = createJournal(raced);

    expect(() => journal.append(appendRequest([pendingEvent(ids.event3)], 1))).toThrow(
      ConcurrencyConflict,
    );
    expect(rowCount(connection, "event_journal")).toBe(2);
    connection.close();
  });

  it("classifies a real two-connection WAL snapshot race as ConcurrencyConflict", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-journal-race-"));
    directories.push(directory);
    const path = join(directory, "events.sqlite3");
    const firstConnection = openSqlite(path);
    applyMigrations(firstConnection, MIGRATIONS, () => "2026-07-13T10:00:00.000Z");
    const secondConnection = openSqlite(path);
    const secondJournal = createJournal(secondConnection);
    let competingAppendStarted = false;
    const racedConnection: SqliteConnection = {
      ...firstConnection,
      prepare: (sql) => {
        const statement = firstConnection.prepare(sql);
        if (!sql.includes("SELECT aggregate_version")) return statement;
        const wrapped: SqliteStatement = {
          run: (...parameters) => statement.run(...parameters),
          all: (...parameters) => statement.all(...parameters),
          get: (...parameters) => {
            const result = statement.get(...parameters);
            if (!competingAppendStarted) {
              competingAppendStarted = true;
              secondJournal.append(appendRequest([pendingEvent(ids.event1)]));
            }
            return result;
          },
        };
        return wrapped;
      },
    };
    const firstJournal = createJournal(racedConnection);

    expect(() => firstJournal.append(appendRequest([pendingEvent(ids.event2)]))).toThrow(
      ConcurrencyConflict,
    );
    expect(firstJournal.headSequence()).toBe(1);
    expect(rowCount(firstConnection, "event_journal")).toBe(1);
    firstConnection.close();
    secondConnection.close();
  });

  it("does not infer duplicate or concurrency failures from state after an unrelated error", () => {
    const connection = openMigratedConnection();
    createJournal(connection).append(appendRequest([pendingEvent(ids.event1)]));
    const unrelatedFailure = Object.assign(new Error("private-storage-sentinel"), {
      code: "SQLITE_IOERR",
    });
    const failed: SqliteConnection = {
      ...connection,
      transaction: () => () => {
        throw unrelatedFailure;
      },
    };
    const journal = createJournal(failed);

    try {
      journal.append(appendRequest([pendingEvent(ids.event1)], 0));
      throw new Error("expected append to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(JournalWriteFailed);
      expect(error).not.toBeInstanceOf(DuplicateEventIdentity);
      expect(error).not.toBeInstanceOf(ConcurrencyConflict);
      expect(String(error)).not.toContain("private-storage-sentinel");
    }
    expect(rowCount(connection, "event_journal")).toBe(1);
    connection.close();
  });

  it("returns DuplicateEventIdentity without duplicating a committed event", () => {
    const connection = openMigratedConnection();
    const journal = createJournal(connection);
    journal.append(appendRequest([pendingEvent(ids.event1)]));

    expect(() => journal.append(appendRequest([pendingEvent(ids.event1)], 1))).toThrow(
      DuplicateEventIdentity,
    );
    expect(rowCount(connection, "event_journal")).toBe(1);
    connection.close();
  });

  it("rolls back the complete batch when any insert fails", () => {
    const connection = openMigratedConnection();
    const journal = createJournal(connection);

    expect(() =>
      journal.append(appendRequest([pendingEvent(ids.event1), pendingEvent(ids.event1)])),
    ).toThrow(DuplicateEventIdentity);
    expect(rowCount(connection, "event_journal")).toBe(0);
    expect(rowCount(connection, "aggregate_heads")).toBe(0);
    connection.close();
  });

  it("replays committed events strictly after the cursor in ascending bounded order", () => {
    const connection = openMigratedConnection();
    const journal = createJournal(connection);
    journal.append(appendRequest([pendingEvent(ids.event1), pendingEvent(ids.event2)]));

    expect(
      journal.replay(replayCursor({ afterSequence: 0, limit: 1 })).map((event) => event.eventId),
    ).toEqual([ids.event1]);
    expect(
      journal.replay(replayCursor({ afterSequence: 1, limit: 10 })).map((event) => event.eventId),
    ).toEqual([ids.event2]);
    connection.close();
  });

  it("replays one aggregate without scanning unrelated global journal rows", () => {
    const connection = openMigratedConnection();
    const journal = createJournal(connection);
    const unrelatedAggregate = "00000000-0000-4000-8000-000000000099";
    journal.append(appendRequest([pendingEvent(ids.event1), pendingEvent(ids.event2)]));
    journal.append({
      aggregate: { aggregateType: "fixture", aggregateId: unrelatedAggregate },
      expectedVersion: 0,
      events: [pendingEvent(ids.event3)],
    });

    expect(
      journal
        .replayAggregate({
          aggregateType: "fixture",
          aggregateId: ids.aggregate,
          afterVersion: 1,
          limit: 10,
        })
        .map((event) => ({ id: event.eventId, version: event.aggregateVersion })),
    ).toEqual([{ id: ids.event2, version: 2 }]);
    connection.close();
  });

  it("replays one aggregate type without scanning unrelated aggregate types", () => {
    const connection = openMigratedConnection();
    const journal = createJournal(connection);
    journal.append(appendRequest([pendingEvent(ids.event1), pendingEvent(ids.event2)]));
    journal.append({
      aggregate: {
        aggregateType: "other-fixture",
        aggregateId: "00000000-0000-4000-8000-000000000099",
      },
      expectedVersion: 0,
      events: [pendingEvent(ids.event3)],
    });

    expect(
      journal
        .replayAggregateType({ aggregateType: "fixture", afterSequence: 0, limit: 10 })
        .map((event) => event.eventId),
    ).toEqual([ids.event1, ids.event2]);
    connection.close();
  });

  it("replays one thread's slice of an aggregate type without other threads' rows", () => {
    const connection = openMigratedConnection();
    const journal = createJournal(connection);
    const threadA = "00000000-0000-4000-8000-0000000000aa";
    const threadB = "00000000-0000-4000-8000-0000000000bb";
    journal.append(
      appendRequest([
        pendingEvent(ids.event1, { payload: { value: "a1", threadId: threadA } }),
        pendingEvent(ids.event2, { payload: { value: "b1", threadId: threadB } }),
        pendingEvent(ids.event3, { payload: { value: "a2", threadId: threadA } }),
      ]),
    );
    // Same thread named in the payload, but a different aggregate type: a
    // thread-scoped read of one stream must not pick it up.
    journal.append({
      aggregate: {
        aggregateType: "other-fixture",
        aggregateId: "00000000-0000-4000-8000-000000000099",
      },
      expectedVersion: 0,
      events: [
        pendingEvent("00000000-0000-4000-8000-000000000007", {
          payload: { value: "a3", threadId: threadA },
        }),
      ],
    });

    const cursor = (afterSequence: number) => ({
      aggregateType: "fixture",
      threadId: threadA,
      afterSequence,
      limit: 10,
    });
    expect(journal.replayAggregateTypeForThread(cursor(0)).map((event) => event.eventId)).toEqual([
      ids.event1,
      ids.event3,
    ]);
    expect(journal.replayAggregateTypeForThread(cursor(1)).map((event) => event.eventId)).toEqual([
      ids.event3,
    ]);
    connection.close();
  });

  it("rolls back content and event writes when beforeEvents fails inside the transaction", () => {
    const connection = openMigratedConnection();
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => "2026-07-13T10:00:00.000Z",
    });
    const threadId = "81000000-0000-4000-8000-000000000001";
    const contentId = "81000000-0000-4000-8000-000000000002";

    journal.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: threadId },
      expectedVersion: 0,
      events: [
        pendingEvent(ids.event1, {
          eventName: "chat.thread-created@1",
          payload: {
            kind: "thread-created",
            thread: {
              id: threadId,
              title: "Atomic content",
              lifecycle: "active",
              providerInstanceId: "81000000-0000-4000-8000-000000000003",
              modelId: "model-a",
              researchEnabled: false,
              researchRouting: "automatic",
              personalityInstructions: "Be calm.",
              version: 1,
              createdAt: "2026-07-13T10:00:00.000Z",
              updatedAt: "2026-07-13T10:00:00.000Z",
            },
          },
        }),
      ],
    });

    expect(() =>
      journal.append(
        {
          aggregate: { aggregateType: "chat-thread", aggregateId: threadId },
          expectedVersion: 1,
          events: [
            pendingEvent(ids.event2, {
              eventName: "chat.thread-updated@1",
              payload: {
                kind: "thread-updated",
                thread: {
                  id: threadId,
                  title: "Atomic content updated",
                  lifecycle: "active",
                  providerInstanceId: "81000000-0000-4000-8000-000000000003",
                  modelId: "model-a",
                  researchEnabled: false,
                  researchRouting: "automatic",
                  personalityInstructions: "Be calm.",
                  version: 2,
                  createdAt: "2026-07-13T10:00:00.000Z",
                  updatedAt: "2026-07-13T10:05:00.000Z",
                },
              },
            }),
          ],
        },
        {
          beforeEvents(innerConnection) {
            innerConnection
              .prepare(
                "INSERT INTO chat_content_store (content_id, thread_id, content_role, body_text, digest, byte_length) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .run(
                contentId,
                threadId,
                "user",
                "hello",
                "a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3",
                5,
              );
            throw new Error("fixture failure");
          },
        },
      ),
    ).toThrow(JournalWriteFailed);
    expect(String(new JournalWriteFailed({ operation: "append" }))).not.toContain(
      "fixture failure",
    );
    expect(rowCount(connection, "chat_content_store")).toBe(0);
    expect(rowCount(connection, "event_journal")).toBe(1);
    connection.close();
  });
});
