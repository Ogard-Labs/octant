import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventActor,
  THREAD_EXTERNAL_CONTENT_AGGREGATE,
  THREAD_EXTERNAL_CONTENT_EVENT_NAMES,
  decodeThreadMessageQueueCommand,
  decodeWindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalContentClearStore } from "./context/externalContentClearStore";
import { ExternalContentIngestionStore } from "./context/externalContentIngestionStore";
import {
  createExternalContentRouteHandler,
  threadStandingFromMessageQueue,
  type ExternalContentRouteDependencies,
} from "./externalContentRoutes";
import type { ThreadMessageQueueModePort } from "./messageQueue/threadMessageQueuePort";
import {
  createThreadMessageQueuePort,
  type ThreadMessageQueuePortDependencies,
} from "./messageQueue/threadMessageQueuePorts";
import {
  ThreadMessageQueueService,
  type ThreadTurnStanding,
} from "./messageQueue/threadMessageQueueService";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { createPhase1RuntimeRegistries } from "./persistence/runtimeRegistry";
import { openSqlite } from "./persistence/sqlitePort";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { createRemoteRoutePolicy } from "./remoteRoutePolicy";
import { ROUTINE_HOST_SCOPE_ID } from "./routineHostScope";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const now = Date.parse("2026-10-12T10:00:00.000Z");
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const windowId = decodeWindowId("44000000-0000-4000-8000-000000000001");
const threadId = "45000000-0000-4000-8000-000000000001";
const otherThreadId = "45000000-0000-4000-8000-000000000002";
const actorId = "46000000-0000-4000-8000-000000000001";
const correlationId = "47000000-0000-4000-8000-000000000001";
const path = "/api/thread-external-content";
const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The real journal, projection, and stores behind the route, and one registered window. */
function openHost(standing: ThreadTurnStanding = "idle") {
  const directory = mkdtempSync(join(tmpdir(), "octant-taint-routes-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => new Date(now).toISOString());
  const runtime = createPhase1RuntimeRegistries();
  let time = now;
  // Each event is a minute after the one before it.
  const clock = () => new Date((time += 60_000)).toISOString();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => new Date(now).toISOString(),
  });
  let nextEvent = 0;
  const uuid = () => `48000000-0000-4000-8000-${String(++nextEvent).padStart(12, "0")}`;
  const ingestions = new ExternalContentIngestionStore({
    journal,
    connection,
    uuid,
    clock,
    actor: decodeActor({ kind: "system", actorId }),
  });
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId, capability, now });
  const thread = { standing };
  const asked = vi.fn();
  const withThreadStanding: ExternalContentRouteDependencies["withThreadStanding"] = async (
    input,
    act,
  ) => {
    asked(input);
    return act(thread.standing);
  };
  const handler = createExternalContentRouteHandler({
    windowAuthorityStore,
    clears: new ExternalContentClearStore({
      journal,
      connection,
      uuid,
      clock,
      actor: decodeActor({ kind: "local-user", actorId }),
    }),
    withThreadStanding,
    now: () => now,
  });
  const ingest = (contentReference: string, sourceLabel: string, thread: string = threadId) =>
    ingestions.record({
      threadId: thread,
      provenance: { origin: "tool-result", sourceLabel },
      contentReference,
      correlationId,
      authorized: true,
    });
  const events = (thread: string = threadId) =>
    journal.replayAggregate({
      aggregateType: THREAD_EXTERNAL_CONTENT_AGGREGATE,
      aggregateId: thread,
      afterVersion: 0,
      limit: 100,
    });
  return { handler, ingest, events, asked, thread, connection };
}

function request(body: unknown, headers: Record<string, string> = {}, target = path) {
  return new Request(`http://127.0.0.1${target}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const read = { kind: "read", mode: "code", threadId } as const;
const clear = (expectedVersion: number) =>
  ({ kind: "clear", mode: "code", threadId, expectedVersion }) as const;

describe("the local-only thread external-content route", () => {
  it("shows a local window the sources with counts and times and the version a clear must name", async () => {
    const host = openHost();
    host.ingest("page-1", "web-fetch");
    host.ingest("mcp-result-1", "mcp-tool");
    host.ingest("page-2", "web-fetch");

    const response = await host.handler(request(read));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      threadId,
      externalContentIngested: true,
      version: 3,
      ingestionCount: 3,
      sources: [
        {
          sourceLabel: "web-fetch",
          ingestionCount: 2,
          firstIngestedAt: "2026-10-12T10:01:00.000Z",
          lastIngestedAt: "2026-10-12T10:03:00.000Z",
        },
        {
          sourceLabel: "mcp-tool",
          ingestionCount: 1,
          firstIngestedAt: "2026-10-12T10:02:00.000Z",
          lastIngestedAt: "2026-10-12T10:02:00.000Z",
        },
      ],
    });
    expect(host.asked).toHaveBeenCalledWith({ windowId, mode: "code", threadId });
    host.connection.close();
  });

  it("clears at the version shown and journals the window that did it", async () => {
    const host = openHost();
    host.ingest("page-1", "web-fetch");

    const response = await host.handler(request(clear(1)));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      kind: "cleared",
      state: {
        threadId,
        externalContentIngested: false,
        version: 2,
        ingestionCount: 0,
        sources: [],
      },
    });
    expect(host.events().at(-1)).toMatchObject({
      eventName: THREAD_EXTERNAL_CONTENT_EVENT_NAMES.cleared,
      actor: { kind: "local-user", actorId },
      payload: { threadId, windowId, clearedSources: ["web-fetch"], ingestionCount: 1 },
    });
    host.connection.close();
  });

  it("refuses a running or queued turn, a thread it cannot read, and a stale version, and journals nothing", async () => {
    const host = openHost("active");
    host.ingest("page-1", "web-fetch");

    const busy = await host.handler(request(clear(1)));
    expect(busy?.status).toBe(200);
    expect(await busy?.json()).toMatchObject({ kind: "refused", reason: "turn-active" });

    // Its last turn ended without the host learning how: still readable, not clearable.
    host.thread.standing = "unconfirmed";
    const unconfirmed = await host.handler(request(clear(1)));
    expect(await unconfirmed?.json()).toMatchObject({
      kind: "refused",
      reason: "turn-unconfirmed",
      state: { version: 1 },
    });
    expect((await host.handler(request(read)))?.status).toBe(200);

    host.thread.standing = "unavailable";
    const unreadable = await host.handler(request(clear(1)));
    expect(await unreadable?.json()).toEqual({ kind: "refused", reason: "thread-unavailable" });
    expect((await host.handler(request(read)))?.status).toBe(404);

    host.thread.standing = "idle";
    host.ingest("page-2", "web-fetch");
    const stale = await host.handler(request(clear(1)));
    expect(await stale?.json()).toMatchObject({
      kind: "refused",
      reason: "stale",
      state: { version: 2, ingestionCount: 2 },
    });
    expect(host.events()).toHaveLength(2);
    host.connection.close();
  });

  it("answers already clear for an unmarked thread and journals nothing", async () => {
    const host = openHost();
    const response = await host.handler(request(clear(0)));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      kind: "already-clear",
      state: { externalContentIngested: false, version: 0 },
    });
    expect(host.events()).toEqual([]);
    host.connection.close();
  });

  it("refuses a malformed body before it looks at the thread, and journals nothing", async () => {
    const host = openHost();
    host.ingest("page-1", "web-fetch");
    for (const body of [
      "{",
      "",
      [],
      { kind: "clear", mode: "code", threadId },
      { kind: "clear", mode: "code", threadId, expectedVersion: "1" },
      { kind: "clear", mode: "code", threadId, expectedVersion: 1, force: true },
      { kind: "clear", mode: "code", threadId, expectedVersion: 1, windowId },
      { kind: "clear", mode: "plan", threadId, expectedVersion: 1 },
      { kind: "clear", mode: "code", threadId: "thread-1", expectedVersion: 1 },
      { kind: "ingest", mode: "code", threadId },
      { kind: "read", mode: "code", threadId, otherThreadId },
    ]) {
      expect((await host.handler(request(body)))?.status).toBe(400);
    }
    expect((await host.handler(request({ ...clear(1), pad: "x".repeat(8_192) })))?.status).toBe(
      413,
    );
    expect(
      (await host.handler(request(clear(1), {}, `${path}?threadId=${threadId}`)))?.status,
    ).toBe(400);
    expect(host.asked).not.toHaveBeenCalled();
    expect(host.events()).toHaveLength(1);
    host.connection.close();
  });

  it("refuses a request with no window capability, another method, and a foreign origin", async () => {
    const host = openHost();
    host.ingest("page-1", "web-fetch");
    expect(
      (await host.handler(request(clear(1), { "x-octant-window-capability": "" })))?.status,
    ).toBe(401);
    expect(
      (await host.handler(request(clear(1), { origin: "https://evil.example" })))?.status,
    ).toBe(400);
    expect(
      (
        await host.handler(
          new Request(`http://127.0.0.1${path}`, {
            headers: { "x-octant-window-capability": capability },
          }),
        )
      )?.status,
    ).toBe(405);
    expect(await host.handler(request(clear(1), {}, `${path}/clear`))).toBeUndefined();
    expect(host.events()).toHaveLength(1);
    host.connection.close();
  });

  it("refuses a paired device at the handler, for the read and for the clear", async () => {
    const host = openHost();
    host.ingest("page-1", "web-fetch");
    for (const body of [read, clear(1)]) {
      const remote = request(body, { "x-octant-window-capability": "" });
      bindPrincipalRouteContext(remote, {
        principal: {
          kind: "remote-device",
          hostId: "local",
          deviceId: "55000000-0000-4000-8000-000000000001",
          credentialGeneration: 1,
          origin: "https://remote.example",
          protocolVersion: 1,
          capabilityDigest: "a".repeat(64),
          sessionId: "55000000-0000-4000-8000-000000000002",
        } as never,
        scopeId: decodeWindowId("55000000-0000-4000-8000-000000000001"),
      });
      const response = await host.handler(remote);
      expect(response?.status).toBe(401);
      expect(await response?.json()).toMatchObject({ category: "unauthorized" });
    }
    expect(host.asked).not.toHaveBeenCalled();
    expect(host.events()).toHaveLength(1);
    host.connection.close();
  });

  it("refuses the host's own scope, so no routine, goal loop, resume, or child delivery clears", async () => {
    const host = openHost();
    host.ingest("page-1", "web-fetch");
    const hostRun = request(clear(1), { "x-octant-window-capability": "" });
    bindPrincipalRouteContext(hostRun, {
      principal: {
        kind: "local-window",
        windowId: String(ROUTINE_HOST_SCOPE_ID),
        capabilityGeneration: 0,
      },
      scopeId: ROUTINE_HOST_SCOPE_ID,
    });
    expect((await host.handler(hostRun))?.status).toBe(401);
    expect(host.asked).not.toHaveBeenCalled();
    expect(host.events()).toHaveLength(1);
    host.connection.close();
  });
});

/** The real message queue over a port, on its own journal. */
function openQueue(port: ThreadMessageQueueModePort) {
  const directory = mkdtempSync(join(tmpdir(), "octant-taint-queue-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  const clock = () => new Date(now).toISOString();
  applyMigrations(connection, MIGRATIONS, clock);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock,
  });
  const queue = new ThreadMessageQueueService({
    connection,
    journal,
    port,
    actor: decodeActor({ kind: "local-user", actorId }),
    clock,
  });
  return { connection, journal, queue, clock };
}

describe("the thread's own mode, read through its message queue", () => {
  const live = { thread: true, window: true, mode: true, project: true, executing: false };
  const turns: Array<{ turnId: string; status: string }> = [];
  const codeWorks: Array<{ work: { kind: string; id: string; state: string } }> = [];
  const dependencies = {
    persistence: {
      readChatThread: () =>
        live.thread
          ? { id: threadId, lifecycle: "active", providerInstanceId: actorId }
          : undefined,
      readChatThreadView: () => undefined,
      readCodeThread: () => ({
        id: threadId,
        lifecycle: "active",
        providerInstanceId: actorId,
        projectId: otherThreadId,
      }),
      readCodeRuntimeWorks: () => codeWorks,
      readCodeCheckout: () => undefined,
      readProject: () => undefined,
      readProviderInstance: () => undefined,
    },
    journal: { replayAggregate: () => [] },
    chat: { isTurnActive: () => live.executing, read: vi.fn(), execute: vi.fn() },
    work: {
      readThread: () => ({ id: threadId, lifecycle: "active", providerInstanceId: actorId }),
      listTurns: () => turns,
      startFirstTurn: vi.fn(),
    },
    code: {},
    isModeEnabled: () => live.mode,
    isWindowLive: () => live.window,
    canAccess: () => live.project,
    attachments: {
      retain: () => ({ status: "retained" }),
      commit: () => undefined,
      release: async () => ({ status: "released" }),
      prepare: async () => true,
    },
  } as unknown as ThreadMessageQueuePortDependencies;
  let opened: ReturnType<typeof openQueue>;
  beforeEach(() => {
    opened = openQueue(createThreadMessageQueuePort(dependencies));
  });
  afterEach(() => {
    opened.queue.dispose();
    opened.connection.close();
  });
  const inspect = (input: {
    readonly windowId: typeof windowId;
    readonly mode: "chat" | "work" | "code";
    readonly threadId: string;
  }) => threadStandingFromMessageQueue(opened.queue)(input, (standing) => standing);
  const chat = { windowId, mode: "chat", threadId } as const;
  const work = { windowId, mode: "work", threadId } as const;
  const code = { windowId, mode: "code", threadId } as const;

  it("is idle with no turn in flight and active while one is queued, running, or waiting", async () => {
    expect(await inspect(chat)).toBe("idle");
    // Chat reports a queued or streaming attempt, or an execution it still owns.
    live.executing = true;
    expect(await inspect(chat)).toBe("active");
    live.executing = false;

    expect(await inspect(work)).toBe("idle");
    for (const status of ["running", "waiting"]) {
      turns.splice(0, turns.length, { turnId: correlationId, status });
      expect(await inspect(work)).toBe("active");
    }
    for (const status of ["completed", "failed", "cancelled"]) {
      turns.splice(0, turns.length, { turnId: correlationId, status });
      expect(await inspect(work)).toBe("idle");
    }
  });

  it("is unconfirmed when a Code turn ended without the host learning how", async () => {
    const turn = (state: string) => ({ work: { kind: "provider-turn", id: correlationId, state } });
    codeWorks.splice(0, codeWorks.length, turn("ambiguous"));
    expect(await inspect(code)).toBe("unconfirmed");
    codeWorks.splice(0, codeWorks.length, turn("ambiguous"), turn("running"));
    expect(await inspect(code)).toBe("active");
    codeWorks.splice(0, codeWorks.length, turn("ambiguous"), turn("completed"));
    expect(await inspect(code)).toBe("idle");
    for (const state of ["interrupted", "failed"]) {
      codeWorks.splice(0, codeWorks.length, turn(state));
      expect(await inspect(code)).toBe("idle");
    }
  });

  it("is unavailable for a missing thread, a closed window, a mode switched off, and a Project out of reach", async () => {
    for (const fact of ["thread", "window", "mode", "project"] as const) {
      live[fact] = false;
      expect(await inspect(chat)).toBe("unavailable");
      live[fact] = true;
    }
    expect(await inspect(chat)).toBe("idle");
  });
});

describe("a thread with a message still in its queue", () => {
  it("refuses the clear while a moving or paused queue holds a message, and clears once it is empty", async () => {
    // An idle Chat thread as its own mode sees it: no attempt queued or running.
    const port = createThreadMessageQueuePort({
      persistence: {
        readChatThread: () => ({
          id: threadId,
          lifecycle: "active",
          providerInstanceId: actorId,
        }),
        readChatThreadView: () => undefined,
        readProject: () => undefined,
        readProviderInstance: () => undefined,
      },
      journal: { replayAggregate: () => [] },
      chat: { isTurnActive: () => false, read: vi.fn(), execute: vi.fn() },
      isModeEnabled: () => true,
      isWindowLive: () => true,
      canAccess: () => true,
      attachments: {
        retain: () => ({ status: "retained" }),
        commit: () => undefined,
        release: async () => ({ status: "released" }),
        prepare: async () => true,
      },
    } as unknown as ThreadMessageQueuePortDependencies);
    // A send that is still being admitted when the clear arrives.
    const admitted = Promise.withResolvers<void>();
    const { connection, journal, queue, clock } = openQueue({
      ...port,
      inspect: async (input) => {
        if (input.intent === "enqueue") await admitted.promise;
        return port.inspect(input);
      },
    });
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId, capability, now });
    const handler = createExternalContentRouteHandler({
      windowAuthorityStore,
      clears: new ExternalContentClearStore({
        journal,
        connection,
        uuid: randomUUID,
        clock,
        actor: decodeActor({ kind: "local-user", actorId }),
      }),
      withThreadStanding: threadStandingFromMessageQueue(queue),
      now: () => now,
    });
    new ExternalContentIngestionStore({
      journal,
      connection,
      uuid: randomUUID,
      clock,
      actor: decodeActor({ kind: "system", actorId }),
    }).record({
      threadId,
      provenance: { origin: "tool-result", sourceLabel: "web-fetch" },
      contentReference: "page-1",
      correlationId,
      authorized: true,
    });
    const scope = { mode: "chat", threadId } as const;
    const messageId = randomUUID();
    const command = (body: Record<string, unknown>) =>
      queue.execute(
        windowId,
        decodeThreadMessageQueueCommand({ scope, requestId: randomUUID(), ...body }),
      );
    const marks = () =>
      journal.replayAggregate({
        aggregateType: THREAD_EXTERNAL_CONTENT_AGGREGATE,
        aggregateId: threadId,
        afterVersion: 0,
        limit: 100,
      });
    const chatClear = { kind: "clear", mode: "chat", threadId, expectedVersion: 1 };
    const refusedAsActive = {
      kind: "refused",
      reason: "turn-active",
      state: { externalContentIngested: true, version: 1 },
    };

    // A clear arrives while a send is in flight. The queue orders them, so the
    // clear waits for the send and is answered with the message it queued.
    const sending = command({
      kind: "enqueue",
      expectedVersion: 0,
      messageId,
      payload: { mode: "chat", prompt: "and then deploy it" },
    });
    const racing = handler(request(chatClear));
    const answered = vi.fn();
    void racing.then(answered);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).not.toHaveBeenCalled();
    expect(marks()).toHaveLength(1);
    admitted.resolve();
    expect(await sending).toMatchObject({ status: "applied" });
    expect(await (await racing)?.json()).toMatchObject(refusedAsActive);

    // Paused, the mode still sees no turn, but the thread owes the queued message.
    expect(await command({ kind: "pause", expectedVersion: 1 })).toMatchObject({
      status: "applied",
      snapshot: { paused: true, items: [{ status: "queued" }] },
    });
    expect(await (await handler(request(chatClear)))?.json()).toMatchObject(refusedAsActive);
    // The sources stay readable while the clear waits.
    expect((await handler(request({ kind: "read", mode: "chat", threadId })))?.status).toBe(200);
    expect(marks()).toHaveLength(1);

    expect(await command({ kind: "remove", expectedVersion: 2, messageId })).toMatchObject({
      status: "applied",
      snapshot: { items: [] },
    });
    const cleared = await handler(request(chatClear));
    expect(await cleared?.json()).toMatchObject({ kind: "cleared" });
    expect(marks()).toHaveLength(2);
    queue.dispose();
    connection.close();
  });
});

describe("the private listener and the thread external-content route", () => {
  const origin = "https://octant.example:8443";

  it("answers a paired device 404 before authentication and refuses to be configured otherwise", () => {
    const policy = createRemoteRoutePolicy({ origin });
    for (const target of [path, `${path}/clear`]) {
      const decision = policy.inspect(
        new Request(`${origin}${target}`, {
          method: "POST",
          headers: { host: "octant.example:8443", origin, "content-type": "application/json" },
          body: JSON.stringify(clear(1)),
        }),
      );
      expect(decision).toMatchObject({ kind: "reject", facts: { surface: "local-only" } });
    }
    expect(() =>
      createRemoteRoutePolicy({
        origin,
        authenticatedRoutes: [
          {
            id: "thread-external-content",
            match: { kind: "exact", path },
            surface: "authenticated-product",
            methods: ["POST"],
          },
        ],
      }),
    ).toThrow("local-only");
  });
});
