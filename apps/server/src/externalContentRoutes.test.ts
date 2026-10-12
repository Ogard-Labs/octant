import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventActor,
  THREAD_EXTERNAL_CONTENT_AGGREGATE,
  THREAD_EXTERNAL_CONTENT_EVENT_NAMES,
  decodeWindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalContentClearStore } from "./context/externalContentClearStore";
import { ExternalContentIngestionStore } from "./context/externalContentIngestionStore";
import {
  createExternalContentRouteHandler,
  inspectThreadAsMessageQueue,
  type ExternalContentThreadInspection,
} from "./externalContentRoutes";
import {
  createThreadMessageQueuePort,
  type ThreadMessageQueuePortDependencies,
} from "./messageQueue/threadMessageQueuePorts";
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
function openHost(inspection: ExternalContentThreadInspection = "idle") {
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
  const thread = { inspection };
  const inspectThread = vi.fn(async () => thread.inspection);
  const handler = createExternalContentRouteHandler({
    windowAuthorityStore,
    clears: new ExternalContentClearStore({
      journal,
      connection,
      uuid,
      clock,
      actor: decodeActor({ kind: "local-user", actorId }),
    }),
    inspectThread,
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
  return { handler, ingest, events, inspectThread, thread, connection };
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
    expect(host.inspectThread).toHaveBeenCalledWith({ windowId, mode: "code", threadId });
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
    host.thread.inspection = "unconfirmed";
    const unconfirmed = await host.handler(request(clear(1)));
    expect(await unconfirmed?.json()).toMatchObject({
      kind: "refused",
      reason: "turn-unconfirmed",
      state: { version: 1 },
    });
    expect((await host.handler(request(read)))?.status).toBe(200);

    host.thread.inspection = "unavailable";
    const unreadable = await host.handler(request(clear(1)));
    expect(await unreadable?.json()).toEqual({ kind: "refused", reason: "thread-unavailable" });
    expect((await host.handler(request(read)))?.status).toBe(404);

    host.thread.inspection = "idle";
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
    expect(host.inspectThread).not.toHaveBeenCalled();
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
    expect(host.inspectThread).not.toHaveBeenCalled();
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
    expect(host.inspectThread).not.toHaveBeenCalled();
    expect(host.events()).toHaveLength(1);
    host.connection.close();
  });
});

describe("the thread's own mode, read the way the message queue reads it", () => {
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
  const inspect = inspectThreadAsMessageQueue(createThreadMessageQueuePort(dependencies));
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
