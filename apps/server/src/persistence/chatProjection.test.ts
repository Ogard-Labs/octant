import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeChatThread,
  decodeChatThreadId,
  decodeChatTurnId,
  type ChatSettings,
  type ChatThread,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { rebuildProjection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite, type SqliteConnection } from "./sqlitePort";
import {
  CHAT_SETTINGS_AGGREGATE_ID,
  readChatContent,
  readChatSettings,
  readChatThread,
  readChatThreads,
  readChatThreadView,
  readChatThreadWindow,
  CHAT_THREAD_WINDOW_BYTES,
  readChatNavigation,
  readPendingChatPurges,
  readThreadFollowUp,
  readThreadWorkList,
  searchChatThreads,
  purgeThreadContent,
  writeChatContent,
} from "./chatProjection";

const directories: Array<string> = [];
const now = "2026-07-19T12:00:00.000Z";
const ids = {
  actor: "82000000-0000-4000-8000-000000000001",
  correlation: "82000000-0000-4000-8000-000000000002",
  provider: "82000000-0000-4000-8000-000000000003",
  thread: "82000000-0000-4000-8000-000000000010",
  threadB: "82000000-0000-4000-8000-000000000011",
  turn: "82000000-0000-4000-8000-000000000020",
  attempt: "82000000-0000-4000-8000-000000000021",
  retryAttempt: "82000000-0000-4000-8000-000000000022",
  content: "82000000-0000-4000-8000-000000000030",
  manifest: "82000000-0000-4000-8000-000000000040",
  session: "82000000-0000-4000-8000-000000000041",
  workItem: "82000000-0000-4000-8000-000000000050",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-chat-projection-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function chatRuntime() {
  const runtime = createPhase1RuntimeRegistries();
  const projection = runtime.projections.get("chat");
  if (projection === undefined) throw new Error("chat projection must be registered");
  return { runtime, projection };
}

function journal(connection: SqliteConnection) {
  const { runtime } = chatRuntime();
  return new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
}

function pending(eventName: string, payload: unknown, eventId = crypto.randomUUID()) {
  return {
    eventId,
    eventName,
    eventVersion: 1,
    correlationId: ids.correlation,
    actor: { kind: "system" as const, actorId: ids.actor },
    occurredAt: now,
    payload,
  };
}

function thread(overrides: Record<string, unknown> = {}): ChatThread {
  return decodeChatThread({
    id: ids.thread,
    title: "Provider-neutral Chat",
    lifecycle: "active",
    providerInstanceId: ids.provider,
    modelId: "model-a",
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Be calm, direct, and useful.",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function settings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    defaultProviderInstanceId: ids.provider,
    defaultModelId: "model-a",
    defaultResearchEnabled: false,
    defaultResearchRouting: "automatic",
    defaultPersonalityInstructions: "Be calm.",
    version: 1,
    updatedAt: now,
    ...overrides,
  } as ChatSettings;
}

function digest(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

describe("ChatProjection", () => {
  it("projects settings, threads, turns, and content reads", () => {
    const connection = openConnection();
    const store = journal(connection);
    const created = thread();
    const body = "hello world";
    const contentDigest = digest(body);

    store.append({
      aggregate: { aggregateType: "chat-settings", aggregateId: CHAT_SETTINGS_AGGREGATE_ID },
      expectedVersion: 0,
      events: [
        pending("chat.settings-updated@1", {
          kind: "settings-updated",
          settings: settings(),
        }),
      ],
    });
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 0,
      events: [
        pending("chat.thread-created@1", {
          kind: "thread-created",
          thread: created,
        }),
      ],
    });
    store.append(
      {
        aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
        expectedVersion: 1,
        events: [
          pending("chat.turn-created@1", {
            kind: "turn-created",
            turn: {
              id: ids.turn,
              threadId: ids.thread,
              sequence: 1,
              userMessageRef: {
                contentId: ids.content,
                digest: contentDigest,
                byteLength: body.length,
              },
              attachmentIds: [],
              attempts: [
                {
                  id: ids.attempt,
                  turnId: ids.turn,
                  threadId: ids.thread,
                  providerInstanceId: ids.provider,
                  providerSessionId: ids.session,
                  modelId: "model-a",
                  contextManifestId: ids.manifest,
                  outcome: "completed",
                  responseRefs: [],
                  citationIds: [],
                  createdAt: now,
                  updatedAt: now,
                },
              ],
              createdAt: now,
            },
          }),
        ],
      },
      {
        beforeEvents(inner) {
          writeChatContent(inner, {
            contentId: ids.content,
            threadId: ids.thread,
            role: "user",
            body,
            digest: contentDigest,
            byteLength: body.length,
          });
        },
      },
    );

    expect(readChatSettings(connection)?.settings.defaultModelId).toBe("model-a");
    expect(readChatThread(connection, decodeChatThreadId(ids.thread))?.title).toBe(
      "Provider-neutral Chat",
    );
    expect(readChatThreads(connection)).toHaveLength(1);
    expect(readChatNavigation(connection)).toEqual([
      {
        id: decodeChatThreadId(ids.thread),
        title: "Provider-neutral Chat",
        providerInstanceId: ids.provider,
        updatedAt: now,
        lastSequence: expect.any(Number),
        followUpOpen: false,
        executing: false,
      },
    ]);
    expect(readChatThreadView(connection, decodeChatThreadId(ids.thread))?.turns).toHaveLength(1);
    expect(readChatContent(connection, ids.content)).toMatchObject({
      body,
      role: "user",
      digest: contentDigest,
    });
    expect(searchChatThreads(connection, "provider-neutral")).toHaveLength(1);

    expect(() =>
      writeChatContent(connection, {
        contentId: ids.content,
        threadId: ids.thread,
        role: "user",
        body: "mutated body",
        digest: digest("mutated body"),
        byteLength: "mutated body".length,
      }),
    ).toThrow();
    expect(readChatContent(connection, ids.content)?.body).toBe(body);

    connection
      .prepare("UPDATE chat_thread_projection SET schema_version = 2 WHERE thread_id = ?")
      .run(ids.thread);
    expect(() => readChatThreads(connection)).toThrow("unsupported Chat projection schema version");
    expect(() => searchChatThreads(connection, "provider-neutral")).toThrow(
      "unsupported Chat projection schema version",
    );
    connection
      .prepare("UPDATE chat_thread_projection SET schema_version = 1 WHERE thread_id = ?")
      .run(ids.thread);
    connection
      .prepare("UPDATE chat_turn_projection SET schema_version = 2 WHERE turn_id = ?")
      .run(ids.turn);
    expect(() => readChatThreadView(connection, decodeChatThreadId(ids.thread))).toThrow(
      "unsupported Chat projection schema version",
    );
    connection.close();
  });

  it("tracks pending purges and tombstones deleted threads without requiring purged bodies on rebuild", () => {
    const connection = openConnection();
    const { projection } = chatRuntime();
    const store = journal(connection);
    const created = thread();
    const body = "purge me";
    const contentDigest = digest(body);

    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 0,
      events: [pending("chat.thread-created@1", { kind: "thread-created", thread: created })],
    });
    store.append(
      {
        aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
        expectedVersion: 1,
        events: [
          pending("chat.turn-created@1", {
            kind: "turn-created",
            turn: {
              id: ids.turn,
              threadId: ids.thread,
              sequence: 1,
              userMessageRef: {
                contentId: ids.content,
                digest: contentDigest,
                byteLength: body.length,
              },
              attachmentIds: [],
              attempts: [],
              createdAt: now,
            },
          }),
        ],
      },
      {
        beforeEvents(inner) {
          writeChatContent(inner, {
            contentId: ids.content,
            threadId: ids.thread,
            role: "user",
            body,
            digest: contentDigest,
            byteLength: body.length,
          });
        },
      },
    );
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 2,
      events: [
        pending("chat.deletion-requested@1", {
          kind: "deletion-requested",
          threadId: ids.thread,
          requestedAt: now,
        }),
      ],
    });
    connection
      .prepare(
        `
          INSERT INTO chat_turn_route_projection (
            turn_id, thread_id, schema_version, decision_json, aggregate_version, decided_at, last_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(ids.turn, ids.thread, 1, "{}", 1, now, 1);

    expect(readPendingChatPurges(connection)).toEqual([
      {
        threadId: decodeChatThreadId(ids.thread),
        requestedAt: now,
        lastSequence: 3,
      },
    ]);
    expect(readChatThread(connection, decodeChatThreadId(ids.thread))?.lifecycle).toBe("deleting");

    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 3,
      events: [
        pending("chat.deleted@1", {
          kind: "deleted",
          threadId: ids.thread,
          deletedAt: "2026-07-19T12:05:00.000Z",
        }),
      ],
    });

    expect(readChatContent(connection, ids.content)).toBeUndefined();
    expect(
      connection
        .prepare("SELECT COUNT(*) AS count FROM chat_turn_route_projection WHERE thread_id = ?")
        .get(ids.thread),
    ).toEqual({ count: 0 });
    expect(readChatThreads(connection)).toHaveLength(0);
    expect(readChatThread(connection, decodeChatThreadId(ids.thread))?.lifecycle).toBe("deleted");
    expect(readPendingChatPurges(connection)).toEqual([]);
    expect(
      connection
        .prepare(
          "SELECT state, requested_at, completed_at FROM chat_purge_projection WHERE thread_id = ?",
        )
        .get(ids.thread),
    ).toEqual({
      state: "completed",
      requested_at: now,
      completed_at: "2026-07-19T12:05:00.000Z",
    });

    rebuildProjection({ connection, journal: store, projection, clock: () => now });

    expect(readChatThread(connection, decodeChatThreadId(ids.thread))?.lifecycle).toBe("deleted");
    expect(readChatContent(connection, ids.content)).toBeUndefined();
    expect(
      connection
        .prepare("SELECT COUNT(*) AS count FROM chat_turn_route_projection WHERE thread_id = ?")
        .get(ids.thread),
    ).toEqual({ count: 0 });
    connection.close();
  });

  it("purges chat_turn_route_projection rows when a thread is deleted", () => {
    const connection = openConnection();
    const store = journal(connection);

    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 0,
      events: [pending("chat.thread-created@1", { kind: "thread-created", thread: thread() })],
    });

    connection
      .prepare(
        `
          INSERT INTO chat_turn_route_projection (
            turn_id, thread_id, schema_version, decision_json, aggregate_version, decided_at, last_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        ids.turn,
        ids.thread,
        1,
        JSON.stringify({
          threadId: ids.thread,
          turnId: ids.turn,
          decision: {
            kind: "waiting",
            request: {},
            mode: "chat",
            activeHostId: ids.provider,
            parentCandidate: {},
            eligibility: [],
            reason: "no-eligible-candidate",
            message: "none",
          },
          decidedAt: now,
        }),
        1,
        now,
        1,
      );

    const routeCount = () =>
      (
        connection
          .prepare("SELECT COUNT(*) AS count FROM chat_turn_route_projection WHERE thread_id = ?")
          .get(ids.thread) as { readonly count: number }
      ).count;
    expect(routeCount()).toBe(1);

    purgeThreadContent(connection, ids.thread);

    expect(routeCount()).toBe(0);
    connection.close();
  });

  it("adds a retry attempt to the projected turn and thread view", () => {
    const connection = openConnection();
    const store = journal(connection);

    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 0,
      events: [pending("chat.thread-created@1", { kind: "thread-created", thread: thread() })],
    });
    store.append(
      {
        aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
        expectedVersion: 1,
        events: [
          pending("chat.turn-created@1", {
            kind: "turn-created",
            turn: {
              id: ids.turn,
              threadId: ids.thread,
              sequence: 1,
              userMessageRef: {
                contentId: ids.content,
                digest: digest("retry me"),
                byteLength: "retry me".length,
              },
              attachmentIds: [],
              attempts: [
                {
                  id: ids.attempt,
                  turnId: ids.turn,
                  threadId: ids.thread,
                  providerInstanceId: ids.provider,
                  providerSessionId: ids.session,
                  modelId: "model-a",
                  contextManifestId: ids.manifest,
                  outcome: "failed",
                  responseRefs: [],
                  citationIds: [],
                  createdAt: now,
                  updatedAt: now,
                },
              ],
              createdAt: now,
            },
          }),
        ],
      },
      {
        beforeEvents(inner) {
          writeChatContent(inner, {
            contentId: ids.content,
            threadId: ids.thread,
            role: "user",
            body: "retry me",
            digest: digest("retry me"),
            byteLength: "retry me".length,
          });
        },
      },
    );
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 2,
      events: [
        pending("chat.attempt-updated@1", {
          kind: "attempt-updated",
          attempt: {
            id: ids.retryAttempt,
            turnId: ids.turn,
            threadId: ids.thread,
            providerInstanceId: ids.provider,
            providerSessionId: "82000000-0000-4000-8000-000000000042",
            modelId: "model-a",
            contextManifestId: "82000000-0000-4000-8000-000000000043",
            outcome: "queued",
            responseRefs: [],
            citationIds: [],
            createdAt: now,
            updatedAt: now,
          },
        }),
      ],
    });

    expect(
      readChatThreadView(connection, decodeChatThreadId(ids.thread))?.turns[0]?.attempts.map(
        ({ id }) => id,
      ),
    ).toEqual([ids.attempt, ids.retryAttempt]);
    expect(readChatNavigation(connection)).toEqual([
      expect.objectContaining({
        id: decodeChatThreadId(ids.thread),
        executing: true,
      }),
    ]);
    connection.close();
  });

  it("projects work lists and follow-up with stable ordering and acknowledgement", () => {
    const connection = openConnection();
    const { projection } = chatRuntime();
    const store = journal(connection);

    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 0,
      events: [pending("chat.thread-created@1", { kind: "thread-created", thread: thread() })],
    });
    store.append({
      aggregate: { aggregateType: "thread-work-list", aggregateId: ids.thread },
      expectedVersion: 0,
      events: [
        pending("thread.work-updated@1", {
          kind: "work-updated",
          workItem: {
            id: ids.workItem,
            threadId: ids.thread,
            title: "Beta",
            status: "pending",
            position: 1,
            origin: "agent",
            version: 1,
            createdAt: now,
            updatedAt: now,
          },
        }),
        pending("thread.work-updated@1", {
          kind: "work-updated",
          workItem: {
            id: "82000000-0000-4000-8000-000000000051",
            threadId: ids.thread,
            title: "Alpha",
            status: "pending",
            position: 0,
            origin: "user",
            version: 2,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ],
    });
    store.append({
      aggregate: { aggregateType: "thread-follow-up", aggregateId: ids.thread },
      expectedVersion: 0,
      events: [
        pending("thread.follow-up-updated@1", {
          kind: "follow-up-updated",
          followUp: {
            threadId: ids.thread,
            state: "open",
            origin: "automatic",
            reason: "Blocked on approval",
            triggerSequence: 5,
            acknowledgedThroughSequence: 0,
            createdAt: now,
          },
        }),
      ],
    });
    store.append({
      aggregate: { aggregateType: "thread-follow-up", aggregateId: ids.thread },
      expectedVersion: 1,
      events: [
        pending("thread.follow-up-updated@1", {
          kind: "follow-up-updated",
          followUp: {
            threadId: ids.thread,
            state: "completed",
            origin: "automatic",
            reason: "Blocked on approval",
            triggerSequence: 5,
            acknowledgedThroughSequence: 5,
            createdAt: now,
            completedAt: "2026-07-19T12:05:00.000Z",
          },
        }),
      ],
    });

    const threadId = decodeChatThreadId(ids.thread);
    expect(readThreadWorkList(connection, threadId).items.map((item) => item.title)).toEqual([
      "Alpha",
      "Beta",
    ]);
    expect(readThreadWorkList(connection, threadId).items[1]?.origin).toBe("agent");
    expect(readThreadFollowUp(connection, threadId)).toMatchObject({
      state: "completed",
      acknowledgedThroughSequence: 5,
    });
    expect(readChatThreadView(connection, threadId)).toMatchObject({
      workListVersion: 2,
      followUpVersion: 2,
    });

    rebuildProjection({ connection, journal: store, projection, clock: () => now });

    expect(readThreadWorkList(connection, threadId).items.map((item) => item.title)).toEqual([
      "Alpha",
      "Beta",
    ]);
    expect(readThreadFollowUp(connection, threadId)?.acknowledgedThroughSequence).toBe(5);
    expect(readChatThreadView(connection, threadId)).toMatchObject({
      workListVersion: 2,
      followUpVersion: 2,
    });
    connection.close();
  });

  it("rebuilds thread metadata deterministically for active threads", () => {
    const connection = openConnection();
    const { projection } = chatRuntime();
    const store = journal(connection);
    const first = thread({ id: ids.thread, title: "Alpha" });
    const second = thread({
      id: ids.threadB,
      title: "Beta search",
      updatedAt: "2026-07-19T12:10:00.000Z",
    });

    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
      expectedVersion: 0,
      events: [pending("chat.thread-created@1", { kind: "thread-created", thread: first })],
    });
    store.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: ids.threadB },
      expectedVersion: 0,
      events: [pending("chat.thread-created@1", { kind: "thread-created", thread: second })],
    });
    const body = "survives projection rebuild";
    writeChatContent(connection, {
      contentId: ids.content,
      threadId: ids.thread,
      role: "user",
      body,
      digest: digest(body),
      byteLength: body.length,
    });

    rebuildProjection({ connection, journal: store, projection, clock: () => now });

    expect(readChatThreads(connection).map((entry) => entry.title)).toEqual([
      "Beta search",
      "Alpha",
    ]);
    expect(searchChatThreads(connection, "beta")).toHaveLength(1);
    expect(readChatContent(connection, ids.content)?.body).toBe(body);
    connection.close();
  });

  describe("thread windows", () => {
    const threadId = decodeChatThreadId(ids.thread);
    const turnId = (index: number) => `83000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const contentId = (index: number, role: "user" | "assistant") =>
      `84000000-0000-4000-8${role === "user" ? "0" : "1"}00-${String(index).padStart(12, "0")}`;

    /**
     * A thread of `count` exchanges journaled through the projection, each a
     * message and a completed reply. `supersedes` maps a turn's index to the
     * index of the earlier turn its message revised.
     */
    function seedThread(
      count: number,
      options: {
        readonly supersedes?: ReadonlyMap<number, number>;
        readonly bodyOf?: (index: number) => string;
        readonly replyOf?: (index: number) => string;
      } = {},
    ): SqliteConnection {
      const connection = openConnection();
      const store = journal(connection);
      store.append({
        aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
        expectedVersion: 0,
        events: [pending("chat.thread-created@1", { kind: "thread-created", thread: thread() })],
      });
      for (let index = 0; index < count; index += 1) {
        const prompt = options.bodyOf?.(index) ?? `Message ${String(index)}`;
        const reply = options.replyOf?.(index) ?? `Reply ${String(index)}`;
        const revised = options.supersedes?.get(index);
        store.append(
          {
            aggregate: { aggregateType: "chat-thread", aggregateId: ids.thread },
            expectedVersion: index + 1,
            events: [
              pending("chat.turn-created@1", {
                kind: "turn-created",
                turn: {
                  id: turnId(index),
                  threadId: ids.thread,
                  sequence: index + 1,
                  userMessageRef: {
                    contentId: contentId(index, "user"),
                    digest: digest(prompt),
                    byteLength: Buffer.byteLength(prompt),
                  },
                  attachmentIds: [],
                  ...(revised === undefined ? {} : { supersedes: turnId(revised) }),
                  attempts: [
                    {
                      id: `85000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
                      turnId: turnId(index),
                      threadId: ids.thread,
                      providerInstanceId: ids.provider,
                      providerSessionId: ids.session,
                      modelId: "model-a",
                      contextManifestId: ids.manifest,
                      outcome: "completed",
                      responseRefs: [
                        {
                          contentId: contentId(index, "assistant"),
                          digest: digest(reply),
                          byteLength: Buffer.byteLength(reply),
                        },
                      ],
                      citationIds: [],
                      createdAt: now,
                      updatedAt: now,
                    },
                  ],
                  createdAt: now,
                },
              }),
            ],
          },
          {
            beforeEvents(inner) {
              for (const [role, body] of [
                ["user", prompt],
                ["assistant", reply],
              ] as const) {
                writeChatContent(inner, {
                  contentId: contentId(index, role),
                  threadId: ids.thread,
                  role,
                  body,
                  digest: digest(body),
                  byteLength: Buffer.byteLength(body),
                });
              }
            },
          },
        );
      }
      return connection;
    }

    function window(
      connection: SqliteConnection,
      limit: number,
      anchor:
        | { readonly kind: "newest" }
        | { readonly kind: "before" | "after" | "through"; readonly index: number } = {
        kind: "newest",
      },
    ) {
      const read = readChatThreadWindow(connection, threadId, {
        limit,
        anchor:
          anchor.kind === "newest"
            ? anchor
            : { kind: anchor.kind, turnId: decodeChatTurnId(turnId(anchor.index)) },
      });
      if (read.kind !== "window") throw new Error(`Expected a window, read ${read.kind}.`);
      return read.window;
    }

    const turnIndexes = (view: { readonly turns: ReadonlyArray<{ readonly id: string }> }) =>
      view.turns.map((turn) => Number(String(turn.id).slice(-12)));

    it("opens on the newest active turns without reading earlier message bodies", () => {
      const connection = seedThread(10);
      // Remove the earlier bodies: a read that touched them would fail.
      for (let index = 0; index < 7; index += 1) {
        connection
          .prepare("DELETE FROM chat_content_store WHERE content_id IN (?, ?)")
          .run(contentId(index, "user"), contentId(index, "assistant"));
      }
      expect(() => readChatThreadView(connection, threadId)).toThrow();

      const newest = window(connection, 3);

      expect(turnIndexes(newest.view)).toEqual([7, 8, 9]);
      expect(newest.view.contents.map((content) => content.body).toSorted()).toEqual([
        "Message 7",
        "Message 8",
        "Message 9",
        "Reply 7",
        "Reply 8",
        "Reply 9",
      ]);
      expect(newest).toMatchObject({
        version: 1,
        hasEarlier: true,
        hasLater: false,
        supersededTurnCount: 0,
      });
      connection.close();
    });

    it("returns the page before, after, or ending with a named turn", () => {
      const connection = seedThread(10);

      const before = window(connection, 3, { kind: "before", index: 7 });
      expect(turnIndexes(before.view)).toEqual([4, 5, 6]);
      expect(before).toMatchObject({ hasEarlier: true, hasLater: true });

      const through = window(connection, 3, { kind: "through", index: 2 });
      expect(turnIndexes(through.view)).toEqual([0, 1, 2]);
      expect(through).toMatchObject({ hasEarlier: false, hasLater: true });

      const after = window(connection, 3, { kind: "after", index: 6 });
      expect(turnIndexes(after.view)).toEqual([7, 8, 9]);
      expect(after).toMatchObject({ hasEarlier: true, hasLater: false });
      connection.close();
    });

    it("pages over active turns only and counts the turns an edit superseded", () => {
      // Turn 5 revises turn 2, which leaves 2, 3, and 4 out of the conversation.
      const connection = seedThread(6, { supersedes: new Map([[5, 2]]) });

      const newest = window(connection, 2);
      expect(turnIndexes(newest.view)).toEqual([1, 5]);
      expect(newest).toMatchObject({ hasEarlier: true, supersededTurnCount: 3 });
      expect(turnIndexes(window(connection, 2, { kind: "before", index: 1 }).view)).toEqual([0]);
      connection.close();
    });

    it("answers stale for an anchor that is superseded or not in the thread", () => {
      const connection = seedThread(6, { supersedes: new Map([[5, 2]]) });

      for (const anchor of [3, 40]) {
        expect(
          readChatThreadWindow(connection, threadId, {
            limit: 3,
            anchor: { kind: "before", turnId: decodeChatTurnId(turnId(anchor)) },
          }),
        ).toEqual({ kind: "stale" });
      }
      expect(
        readChatThreadWindow(connection, decodeChatThreadId(ids.threadB), {
          limit: 3,
          anchor: { kind: "newest" },
        }),
      ).toEqual({ kind: "missing" });
      connection.close();
    });

    it("stops short of its limit once its encoded turns pass the page budget", () => {
      // Each body is encoded twice, as text and as parts, so three of these
      // pass the budget and two do not.
      const large = "x".repeat(Math.ceil(CHAT_THREAD_WINDOW_BYTES / 5));
      const connection = seedThread(4, {
        bodyOf: (index) => (index >= 1 ? `${large}${String(index)}` : "small"),
      });

      const newest = window(connection, 30);
      expect(turnIndexes(newest.view)).toEqual([2, 3]);
      expect(newest.hasEarlier).toBe(true);
      expect(turnIndexes(window(connection, 30, { kind: "before", index: 2 }).view)).toEqual([
        0, 1,
      ]);

      // One turn larger than the whole budget still makes a page of its own.
      const huge = "y".repeat(900_000);
      const oversized = seedThread(2, {
        bodyOf: (index) => (index === 1 ? huge : "small"),
        replyOf: (index) => (index === 1 ? huge : "small"),
      });
      expect(turnIndexes(window(oversized, 30).view)).toEqual([1]);
      connection.close();
      oversized.close();
    });

    it("carries the page's own attachments, sources, and route receipts", () => {
      const connection = seedThread(6);
      const insertAttachment = (id: string, turn: number | undefined) =>
        connection
          .prepare(
            `INSERT INTO chat_attachment_projection (
               attachment_id, thread_id, turn_id, schema_version, attachment_json,
               aggregate_version, last_sequence
             ) VALUES (?, ?, ?, 1, ?, 1, 1)`,
          )
          .run(
            id,
            ids.thread,
            turn === undefined ? null : turnId(turn),
            JSON.stringify({
              id,
              threadId: ids.thread,
              ...(turn === undefined ? {} : { turnId: turnId(turn) }),
              displayName: "notes.txt",
              mediaType: "text/plain",
              byteLength: 4,
              digest: digest("note"),
              status: turn === undefined ? "pending" : "finalized",
              createdAt: now,
            }),
          );
      insertAttachment("86000000-0000-4000-8000-000000000001", 1);
      insertAttachment("86000000-0000-4000-8000-000000000002", undefined);
      const citationId = "87000000-0000-4000-8000-000000000001";
      connection
        .prepare(
          `INSERT INTO chat_citation_projection (
             citation_id, thread_id, turn_id, attempt_id, schema_version, citation_json,
             aggregate_version, last_sequence
           ) VALUES (?, ?, ?, ?, 1, ?, 1, 1)`,
        )
        .run(
          citationId,
          ids.thread,
          turnId(1),
          `85000000-0000-4000-8000-${"1".padStart(12, "0")}`,
          JSON.stringify({
            citationId,
            threadId: ids.thread,
            turnId: turnId(1),
            attemptId: `85000000-0000-4000-8000-${"1".padStart(12, "0")}`,
            sourceTitle: "Source",
            sourceUrl: "https://example.com/",
            backend: "searxng",
            retrievedAt: now,
          }),
        );
      const candidate = (modelId: string) => ({
        hostId: "local",
        providerInstanceId: ids.provider,
        modelId,
      });
      const insertDecision = (decisionTurnId: string) =>
        connection
          .prepare(
            `INSERT INTO chat_turn_route_projection (
               turn_id, thread_id, schema_version, decision_json, aggregate_version,
               decided_at, last_sequence
             ) VALUES (?, ?, 1, ?, 1, ?, 1)`,
          )
          .run(
            decisionTurnId,
            ids.thread,
            JSON.stringify({
              threadId: ids.thread,
              turnId: decisionTurnId,
              decision: {
                kind: "waiting",
                request: {
                  pool: {
                    candidates: [candidate("model-a"), candidate("model-b")],
                    mixedVendorEnabled: false,
                    fallbackAllowed: false,
                    higherCostFallbackAllowed: false,
                  },
                  requiredCapabilities: [],
                },
                mode: "chat",
                activeHostId: "local",
                parentCandidate: candidate("model-a"),
                eligibility: [
                  {
                    candidate: candidate("model-a"),
                    eligible: false,
                    reasons: ["provider-not-ready"],
                  },
                  {
                    candidate: candidate("model-b"),
                    eligible: false,
                    reasons: ["provider-not-ready"],
                  },
                ],
                reason: "no-eligible-candidate",
                message: "No model in the pool is ready.",
              },
              decidedAt: now,
            }),
            now,
          );
      insertDecision(turnId(1));
      // A waiting receipt whose turn the host never accepted.
      const neverAccepted = "88000000-0000-4000-8000-000000000001";
      insertDecision(neverAccepted);

      const newest = window(connection, 3);
      expect(newest.view.attachments.map((attachment) => attachment.id)).toEqual([
        "86000000-0000-4000-8000-000000000002",
      ]);
      expect(newest.view.citations).toEqual([]);
      expect(newest.view.routeDecisions?.map((decision) => decision.turnId)).toEqual([
        neverAccepted,
      ]);

      const earlier = window(connection, 3, { kind: "before", index: 3 });
      expect(turnIndexes(earlier.view)).toEqual([0, 1, 2]);
      expect(earlier.view.attachments.map((attachment) => attachment.id)).toEqual([
        "86000000-0000-4000-8000-000000000001",
      ]);
      expect(earlier.view.citations.map((citation) => citation.citationId)).toEqual([citationId]);
      expect(earlier.view.routeDecisions?.map((decision) => decision.turnId)).toEqual([turnId(1)]);
      connection.close();
    });
  });
});
