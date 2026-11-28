import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatAttempt,
  EventActor,
  decodeUtcTimestamp,
  type OctantMode,
  type ProviderInstanceId,
  type WindowId,
} from "@octant/contracts";
import { Schema, Struct } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { createPersonMemoryAccess } from "./personMemoryAccess";
import { CODE_BACKGROUND_EVENT_KINDS, latestEventAt, newestTurnUpdate } from "./personMemoryWiring";
import { createPersonMemoryCutOff, type ConversationOwnership } from "./personMemoryRefresh";
import { PersonMemoryStore, registerPersonMemoryEvents } from "./personMemoryStore";

const T0 = "2026-11-01T10:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "99999999-9999-4999-8999-999999999999",
});
const THREAD = "aaaaaaaa-0000-4000-8000-000000000001";
const PROVIDER = "33333333-3333-4333-8333-333333333333" as ProviderInstanceId;
const HOST_PROVIDER = "33333333-3333-4333-8333-333333333334" as ProviderInstanceId;
const WINDOW = "cccccccc-0000-4000-8000-000000000001" as WindowId;
const HOST_WINDOW = "cccccccc-0000-4000-8000-000000000003" as WindowId;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "octant-person-memory-refresh-"));
  directories.push(directory);
  const connection: SqliteConnection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => T0);
  const journal = new Journal({
    connection,
    registry: registerPersonMemoryEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => T0,
  });
  let now = T0;
  const store = new PersonMemoryStore({
    connection,
    journal,
    uuid: () => crypto.randomUUID(),
    clock: () => decodeUtcTimestamp(now),
    actor,
  });
  const ownership = (providerInstanceId: string): ConversationOwnership =>
    providerInstanceId === HOST_PROVIDER ? "host" : "provider";
  const cutOff = createPersonMemoryCutOff({ connection, ownership, store });
  const access = createPersonMemoryAccess({
    store,
    cutOff,
    projectLabel: () => undefined,
    isRestrictedDeviceScope: () => false,
  });
  let version = 0;
  const insert = (
    aggregateType: string,
    aggregateId: string,
    eventName: string,
    at: string,
    payload: unknown,
  ) => {
    version += 1;
    connection
      .prepare(
        `INSERT INTO event_journal (event_id, aggregate_type, aggregate_id, aggregate_version,
           event_name, event_version, correlation_id, actor_kind, actor_id, occurred_at, payload_json)
         VALUES (?, ?, ?, ?, ?, 1, ?, 'system', 'system', ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        aggregateType,
        aggregateId,
        // One aggregate per row keeps versions of each aggregate valid.
        aggregateType === "chat-thread" ||
          aggregateType === "context-ledger" ||
          aggregateType === "native-harness-transcript"
          ? (
              connection
                .prepare(
                  "SELECT COUNT(*) AS n FROM event_journal WHERE aggregate_type = ? AND aggregate_id = ?",
                )
                .get(aggregateType, aggregateId) as { n: number }
            ).n + 1
          : 1,
        eventName,
        crypto.randomUUID(),
        at,
        JSON.stringify(payload),
      );
  };
  const chatTurn = (at: string, session: string, resumed: boolean) =>
    insert("chat-thread", THREAD, "chat.turn-created@1", at, {
      kind: "turn-created",
      turn: {
        threadId: THREAD,
        attempts: [
          {
            providerSessionId: session,
            ...(resumed ? { resumeCursor: { kind: "opaque" } } : {}),
          },
        ],
      },
    });
  const learn = (at: string, content: string) => {
    now = at;
    store.saveFromOpenThread({
      source: {
        mode: "code",
        threadId: "bbbbbbbb-0000-4000-8000-000000000009" as never,
        title: "Elsewhere" as never,
        providerInstanceId: PROVIDER,
      },
      kind: "preference",
      content,
    });
  };
  const scope = (overrides: Record<string, unknown> = {}) => ({
    mode: "chat" as OctantMode,
    threadId: THREAD,
    createdAt: T0,
    providerInstanceId: PROVIDER,
    windowId: WINDOW as WindowId | undefined,
    ...overrides,
  });
  return {
    connection,
    journal,
    store,
    access,
    cutOff,
    insert,
    chatTurn,
    learn,
    scope,
    setNow: (at: string) => (now = at),
  };
}

describe("when a long-lived thread sees newer entries", () => {
  it("keeps the block byte-identical on consecutive turns of one session, and shows a new entry only after a new session starts", () => {
    const f = fixture();
    f.learn("2026-11-01T09:00:00.000Z", "I prefer tabs.");
    f.chatTurn("2026-11-01T10:00:01.000Z", "session-a", false);
    const first = f.access.blockFor(f.scope());
    f.learn("2026-11-01T11:00:00.000Z", "I prefer short answers.");
    f.chatTurn("2026-11-01T11:05:00.000Z", "session-a", true);
    const resumed = f.access.blockFor(f.scope());

    expect(resumed).toBe(first);
    expect(resumed).not.toContain("short answers");

    // The next turn starts a new session that does not resume the earlier one:
    // its block is built, then the turn is journaled.
    f.setNow("2026-11-01T12:00:00.000Z");
    const fresh = f.access.blockFor(f.scope({ startsFreshSession: true }));
    f.chatTurn("2026-11-01T12:00:01.000Z", "session-b", false);
    expect(fresh).toContain("I prefer short answers.");
    expect(fresh).toContain("I prefer tabs.");
    // And stays the same for the resumed turns that follow.
    expect(f.access.blockFor(f.scope())).toBe(fresh);
    f.chatTurn("2026-11-01T12:05:00.000Z", "session-b", true);
    expect(f.access.blockFor(f.scope())).toBe(fresh);
  });

  it("shows the new entry to the turn that itself starts the new session", () => {
    const f = fixture();
    f.chatTurn("2026-11-01T10:00:01.000Z", "session-a", false);
    f.learn("2026-11-01T11:00:00.000Z", "I prefer short answers.");
    f.setNow("2026-11-01T11:30:00.000Z");

    expect(f.access.blockFor(f.scope())).toBeUndefined();
    expect(f.access.blockFor(f.scope({ startsFreshSession: true }))).toContain(
      "I prefer short answers.",
    );
  });

  it("refreshes at a finished compaction and at the harness compacting its own session, and not for a failed one", () => {
    const f = fixture();
    f.chatTurn("2026-11-01T10:00:01.000Z", "session-a", false);
    f.learn("2026-11-01T11:00:00.000Z", "I prefer short answers.");
    expect(f.access.blockFor(f.scope())).toBeUndefined();

    f.insert(
      "context-ledger",
      THREAD,
      "context.compaction-failed@1",
      "2026-11-01T11:10:00.000Z",
      {},
    );
    expect(f.access.blockFor(f.scope())).toBeUndefined();

    f.insert(
      "native-harness-transcript",
      "some-other-session",
      "native-harness-transcript-compacted@1",
      "2026-11-01T11:20:00.000Z",
      {},
    );
    expect(f.access.blockFor(f.scope())).toBeUndefined();

    f.insert(
      "native-harness-transcript",
      "session-a",
      "native-harness-transcript-compacted@1",
      "2026-11-01T11:30:00.000Z",
      {},
    );
    expect(f.access.blockFor(f.scope())).toContain("short answers");

    const g = fixture();
    g.chatTurn("2026-11-01T10:00:01.000Z", "session-a", false);
    g.learn("2026-11-01T11:00:00.000Z", "I prefer short answers.");
    g.insert(
      "context-ledger",
      THREAD,
      "context.compaction-completed@1",
      "2026-11-01T11:40:00.000Z",
      {},
    );
    expect(g.access.blockFor(g.scope())).toContain("short answers");
  });

  it("refreshes a provider that keeps no session of its own at compaction only", () => {
    const f = fixture();
    const hostOwned = { providerInstanceId: HOST_PROVIDER };
    f.chatTurn("2026-11-01T10:00:01.000Z", "session-a", false);
    f.learn("2026-11-01T11:00:00.000Z", "I prefer short answers.");
    // Every turn of such a provider is a new session; none is a refresh point.
    f.chatTurn("2026-11-01T12:00:00.000Z", "session-b", false);
    expect(f.access.blockFor(f.scope(hostOwned))).toBeUndefined();
    expect(f.access.blockFor(f.scope({ ...hostOwned, startsFreshSession: true }))).toBeUndefined();

    f.insert(
      "context-ledger",
      THREAD,
      "context.compaction-completed@1",
      "2026-11-01T12:30:00.000Z",
      {},
    );
    expect(f.access.blockFor(f.scope(hostOwned))).toContain("short answers");
  });

  it("refreshes a Work and a Code thread at a new session, and at the harness compacting the newest session only", () => {
    const f = fixture();
    f.learn("2026-11-01T11:00:00.000Z", "I prefer short answers.");
    const workTurn = (at: string, session: string) =>
      f.insert("work-turn", crypto.randomUUID(), "work.turn-accepted@1", at, {
        kind: "turn-accepted",
        threadId: THREAD,
        providerSessionId: session,
      });
    const codeReady = (at: string, session: string) =>
      f.insert("code-operation", crypto.randomUUID(), "code.operation-event-recorded@1", at, {
        threadId: THREAD,
        event: { kind: "provider-session-ready", sessionId: session },
      });
    const harnessCompacted = (session: string, at: string) =>
      f.insert(
        "native-harness-transcript",
        session,
        "native-harness-transcript-compacted@1",
        at,
        {},
      );

    workTurn("2026-11-01T10:00:01.000Z", "work-a");
    workTurn("2026-11-01T10:30:00.000Z", "work-a");
    expect(f.access.blockFor(f.scope({ mode: "work" }))).toBeUndefined();
    f.setNow("2026-11-01T12:00:00.000Z");
    const fresh = f.access.blockFor(f.scope({ mode: "work", startsFreshSession: true }));
    workTurn("2026-11-01T12:00:01.000Z", "work-b");
    expect(fresh).toContain("short answers");
    expect(f.access.blockFor(f.scope({ mode: "work" }))).toBe(fresh);

    codeReady("2026-11-01T10:00:01.000Z", "code-a");
    codeReady("2026-11-01T10:30:00.000Z", "code-a");
    expect(f.access.blockFor(f.scope({ mode: "code" }))).toBeUndefined();
    codeReady("2026-11-01T12:00:01.000Z", "code-b");
    // Only the session the thread's newest turn runs on can refresh it.
    harnessCompacted("code-a", "2026-11-01T12:10:00.000Z");
    expect(f.access.blockFor(f.scope({ mode: "code" }))).toBeUndefined();
    harnessCompacted("code-b", "2026-11-01T12:20:00.000Z");
    expect(f.access.blockFor(f.scope({ mode: "code" }))).toContain("short answers");
  });

  it("keeps a new session's block the same on the turn after it, though an entry was saved while the turn was being journaled", () => {
    const f = fixture();
    f.chatTurn("2026-11-01T10:00:01.000Z", "session-a", false);
    f.learn("2026-11-01T11:00:00.000Z", "I prefer short answers.");
    // The block is built at 12:00:00, the turn is journaled a little later, and
    // in between another thread saves an entry.
    f.setNow("2026-11-01T12:00:00.000Z");
    const first = f.access.blockFor(f.scope({ startsFreshSession: true }));
    f.learn("2026-11-01T12:00:00.500Z", "I prefer dark themes.");
    f.chatTurn("2026-11-01T12:00:01.000Z", "session-b", false);

    expect(first).toContain("short answers");
    expect(first).not.toContain("dark themes");
    expect(f.access.blockFor(f.scope())).toBe(first);
    // Still the same for a host-started turn and after a restart.
    expect(f.access.blockFor(f.scope({ windowId: HOST_WINDOW }))).toBe(first);
    const restarted = new PersonMemoryStore({
      connection: f.connection,
      journal: f.journal,
      uuid: () => crypto.randomUUID(),
      clock: () => decodeUtcTimestamp("2026-11-02T00:00:00.000Z"),
      actor,
    });
    const after = createPersonMemoryAccess({
      store: restarted,
      cutOff: createPersonMemoryCutOff({
        connection: f.connection,
        ownership: () => "provider",
        store: restarted,
      }),
      projectLabel: () => undefined,
    }).blockFor(f.scope());
    expect(after).toBe(first);
    restarted.close();
  });

  it("treats a Chat retry that starts a session of its own as a refresh point, so the next turn keeps its block", () => {
    const f = fixture();
    f.chatTurn("2026-11-01T10:00:01.000Z", "session-a", false);
    f.learn("2026-11-01T11:00:00.000Z", "I prefer short answers.");
    // The retry adds an attempt on a new session to the turn the thread has.
    f.setNow("2026-11-01T12:00:00.000Z");
    const retried = f.access.blockFor(f.scope({ startsFreshSession: true }));
    f.insert("chat-thread", THREAD, "chat.attempt-updated@1", "2026-11-01T12:00:01.000Z", {
      kind: "attempt-updated",
      attempt: { providerSessionId: "session-b" },
    });

    expect(retried).toContain("short answers");
    // The next turn builds its block before it is journaled; a subagent of the
    // retried turn reads through its lead.
    expect(f.access.blockFor(f.scope())).toBe(retried);
    expect(f.access.childBlockFor(f.scope())).toBe(retried);
    f.chatTurn("2026-11-01T12:05:00.000Z", "session-b", true);
    expect(f.access.blockFor(f.scope())).toBe(retried);
  });

  it("reads the cut with keyed lookups of one row each, however long the thread", () => {
    const readCut = (turns: number) => {
      const f = fixture();
      for (let turn = 0; turn < turns; turn += 1) {
        const at = new Date(Date.parse(T0) + (turn + 1) * 60_000).toISOString();
        f.chatTurn(at, "session-a", turn > 0);
      }
      const statements: string[] = [];
      const plans: string[] = [];
      const watched = new Proxy(f.connection, {
        get(target, property) {
          const value = Reflect.get(target, property) as unknown;
          if (property !== "prepare")
            return typeof value === "function" ? value.bind(target) : value;
          return (sql: string) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                const member = Reflect.get(statementTarget, statementProperty) as unknown;
                if (statementProperty !== "get" && statementProperty !== "all") {
                  return typeof member === "function" ? member.bind(statementTarget) : member;
                }
                return (...params: Array<unknown>) => {
                  statements.push(sql);
                  for (const row of target
                    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
                    .all(...params) as ReadonlyArray<{ readonly detail: string }>) {
                    plans.push(row.detail);
                  }
                  return (member as (...args: ReadonlyArray<unknown>) => unknown).apply(
                    statementTarget,
                    params,
                  );
                };
              },
            });
          };
        },
      });
      for (const mode of ["chat", "work", "code"] as const) {
        createPersonMemoryCutOff({
          connection: watched,
          ownership: () => "provider",
          store: f.store,
        })(f.scope({ mode }));
      }
      return { statements, plans };
    };

    const short = readCut(3);
    const long = readCut(300);

    // The same statements however many turns the thread has, none paging its history.
    expect(long.statements).toEqual(short.statements);
    expect(long.statements.filter((sql) => /OFFSET/i.test(sql))).toEqual([]);
    // Every step searches an index; none scans the table or sorts the thread's rows.
    expect(long.plans.length).toBeGreaterThan(5);
    expect(
      long.plans.every((detail) => detail.startsWith("SEARCH") && detail.includes("USING INDEX")),
    ).toBe(true);
    expect(long.plans.filter((detail) => /SCAN|TEMP B-TREE/.test(detail))).toEqual([]);
  });

  it("gives a turn the host starts and a subagent through its lead the same block", () => {
    const f = fixture();
    f.learn("2026-11-01T09:00:00.000Z", "I prefer tabs.");
    f.chatTurn("2026-11-01T10:00:01.000Z", "session-a", false);
    f.learn("2026-11-01T11:00:00.000Z", "I prefer short answers.");
    f.setNow("2026-11-01T12:00:00.000Z");
    f.access.blockFor(f.scope({ startsFreshSession: true }));
    f.chatTurn("2026-11-01T12:00:01.000Z", "session-b", false);

    const person = f.access.blockFor(f.scope());
    const hostStarted = f.access.blockFor(f.scope({ windowId: HOST_WINDOW }));
    const child = f.access.childBlockFor(f.scope());

    expect(person).toContain("short answers");
    expect(hostStarted).toBe(person);
    expect(child).toBe(person);
  });

  it("gives the same block after a restart", () => {
    const f = fixture();
    f.learn("2026-11-01T09:00:00.000Z", "I prefer tabs.");
    f.chatTurn("2026-11-01T10:00:01.000Z", "session-a", false);
    f.learn("2026-11-01T11:00:00.000Z", "I prefer short answers.");
    f.setNow("2026-11-01T12:00:00.000Z");
    f.access.blockFor(f.scope({ startsFreshSession: true }));
    f.chatTurn("2026-11-01T12:00:01.000Z", "session-b", false);
    const before = f.access.blockFor(f.scope());

    const restarted = new PersonMemoryStore({
      connection: f.connection,
      journal: f.journal,
      uuid: () => crypto.randomUUID(),
      clock: () => decodeUtcTimestamp("2026-11-02T00:00:00.000Z"),
      actor,
    });
    const after = createPersonMemoryAccess({
      store: restarted,
      cutOff: createPersonMemoryCutOff({
        connection: f.connection,
        ownership: () => "provider",
        store: restarted,
      }),
      projectLabel: () => undefined,
    }).blockFor(f.scope());

    expect(after).toBe(before);
    restarted.close();
  });

  it("changes a thread's block far less often than the entries it could show, measured on a fixed fixture", () => {
    // Twenty turns of one thread with an entry learned elsewhere after every
    // second turn, one new session every ten turns and one compaction.
    const f = fixture();
    let session = "session-0";
    const blocks: Array<string | undefined> = [];
    const cutAtEveryTurn: Array<string | undefined> = [];
    let entries = 0;
    for (let turn = 0; turn < 20; turn += 1) {
      const at = `2026-11-01T${String(10 + Math.floor(turn / 2)).padStart(2, "0")}:${turn % 2 === 0 ? "00" : "30"}:00.000Z`;
      if (turn % 2 === 0) {
        entries += 1;
        f.learn(
          `2026-11-01T${String(10 + Math.floor(turn / 2)).padStart(2, "0")}:10:00.000Z`,
          `Entry ${String(entries)} about tabs.`,
        );
      }
      const fresh = turn === 0 || turn === 10;
      if (fresh) session = `session-${String(turn)}`;
      f.setNow(at);
      if (turn === 15) f.insert("context-ledger", THREAD, "context.compaction-completed@1", at, {});
      blocks.push(f.access.blockFor(f.scope({ startsFreshSession: fresh })));
      f.chatTurn(at, session, !fresh);
      // What cutting at the turn itself would send: every new entry changes it.
      cutAtEveryTurn.push(f.access.blockFor(f.scope({ createdAt: at })));
    }
    const changes = (list: ReadonlyArray<string | undefined>) =>
      list.slice(1).filter((block, index) => block !== list[index]).length;
    const creationOnly = blocks.map(() => undefined);

    // Cut at creation alone (the earlier behaviour) never changes within a thread
    // and never shows any entry learned after it began; the refresh points (the
    // second session at turn 10 and the compaction at turn 15) change it exactly
    // when the model's context is rebuilt.
    expect(changes(creationOnly)).toBe(0);
    expect(changes(blocks)).toBe(2);
    expect(changes(cutAtEveryTurn)).toBeGreaterThan(changes(blocks) * 3);
    // Measured on this fixture: 0 changes before, 2 after, against the turn-by-turn cut's count below.
    expect(changes(cutAtEveryTurn)).toBe(10);
    expect((blocks.at(-1)?.split("\n").length ?? 1) - 1).toBe(8);
  });
});

describe("when a thread was last active", () => {
  it("reads the end of the newest turn, not only when the last message began, through one indexed row", () => {
    const f = fixture();
    f.chatTurn("2026-11-01T10:30:00.000Z", "session-a", false);
    f.insert("chat-thread", THREAD, "chat.attempt-updated@1", "2026-11-01T11:00:00.000Z", {
      kind: "attempt-updated",
      attempt: { providerSessionId: "session-a" },
    });
    f.insert(
      "code-operation",
      crypto.randomUUID(),
      "code.operation-event-recorded@1",
      "2026-11-01T10:40:00.000Z",
      {
        threadId: THREAD,
        event: { kind: "turn-finished" },
      },
    );
    f.insert(
      "code-operation",
      crypto.randomUUID(),
      "code.operation-event-recorded@1",
      "2026-11-01T10:50:00.000Z",
      {
        threadId: "bbbbbbbb-0000-4000-8000-000000000002",
        event: { kind: "turn-finished" },
      },
    );

    expect(
      latestEventAt(f.connection, {
        aggregateType: "chat-thread",
        aggregateId: THREAD,
        eventName: "chat.turn-created@1",
      }),
    ).toBe("2026-11-01T10:30:00.000Z");
    expect(latestEventAt(f.connection, { aggregateType: "chat-thread", aggregateId: THREAD })).toBe(
      "2026-11-01T11:00:00.000Z",
    );
    expect(latestEventAt(f.connection, { aggregateType: "code-operation", threadId: THREAD })).toBe(
      "2026-11-01T10:40:00.000Z",
    );
    expect(
      latestEventAt(f.connection, { aggregateType: "chat-thread", aggregateId: "nobody" }),
    ).toBeUndefined();
  });

  it("does not count a terminal's output or state change as a Code thread's activity", () => {
    const f = fixture();
    const record = (at: string, kind: string) =>
      f.insert("code-operation", crypto.randomUUID(), "code.operation-event-recorded@1", at, {
        threadId: THREAD,
        event: { kind },
      });
    record("2026-11-01T10:40:00.000Z", "turn-finished");
    // A dev server left running in the thread's terminal writes after the turn ended.
    record("2026-11-01T11:30:00.000Z", "terminal-output");
    record("2026-11-01T11:40:00.000Z", "terminal-state-changed");

    expect(
      latestEventAt(f.connection, {
        aggregateType: "code-operation",
        threadId: THREAD,
        exceptKinds: CODE_BACKGROUND_EVENT_KINDS,
      }),
    ).toBe("2026-11-01T10:40:00.000Z");
    expect(latestEventAt(f.connection, { aggregateType: "code-operation", threadId: THREAD })).toBe(
      "2026-11-01T11:40:00.000Z",
    );
  });

  it("reads a Work thread's newest change from every turn, not the last one accepted", () => {
    expect(
      newestTurnUpdate([
        { updatedAt: "2026-11-01T12:00:00.000Z" },
        { updatedAt: "2026-11-01T10:30:00.000Z" },
      ]),
    ).toBe("2026-11-01T12:00:00.000Z");
    expect(newestTurnUpdate([])).toBeUndefined();
  });

  it("proves a Chat attempt always names its provider session, so the newest attempt event cannot hide it", () => {
    expect(() =>
      Schema.decodeUnknownSync(ChatAttempt.mapFields(Struct.pick(["providerSessionId"])))({}),
    ).toThrow();
  });
});
