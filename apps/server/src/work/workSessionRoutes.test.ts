import { describe, expect, it, vi } from "vitest";
import { decodeWindowId, decodeWorkThreadId } from "@octant/contracts";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createWorkSessionRouteHandler } from "./workSessionRoutes";

const windowId = decodeWindowId("96000000-0000-4000-8000-000000000002");
const threadId = decodeWorkThreadId("96000000-0000-4000-8000-000000000001");
const otherThreadId = "96000000-0000-4000-8000-000000000009";
const capability = `${"W".repeat(42)}A`;
const authorized = { "x-octant-window-capability": capability };

function setup(isPerson: (window: string) => boolean = () => true) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const stopLiveTasks = vi.fn(async () => true);
  const nativeSessions = vi.fn(async () => ({ threadId, sessions: [] }));
  const adoptNativeSession = vi.fn(async () => ({
    kind: "work-native-session-adopted" as const,
    threadId,
    nativeSessionId: "outside-session-1",
  }));
  const handle = createWorkSessionRouteHandler({
    windowAuthorityStore: store,
    canOpenThread: (_window, thread) => String(thread) === String(threadId),
    liveTasks: () => ({
      tasks: [{ taskId: "bash-1", description: "bun run dev" }],
      turnRunning: false,
    }),
    stopLiveTasks,
    isPerson: (window) => isPerson(String(window)),
    nativeSessions,
    adoptNativeSession,
    now: () => 1,
  });
  return { handle, stopLiveTasks, nativeSessions, adoptNativeSession };
}

const adoption = (headers: Record<string, string>) =>
  new Request("http://localhost/api/work-native-sessions/adopt", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      kind: "adopt-work-native-session",
      threadId,
      nativeSessionId: "outside-session-1",
    }),
  });

describe("Work session routes", () => {
  it("lists a Work thread's live tasks only to an authenticated window that can open it", async () => {
    const { handle } = setup();
    const url = `http://localhost/api/work-live-tasks?threadId=${String(threadId)}`;
    expect((await handle(new Request(url)))?.status).toBe(401);
    const listed = await handle(new Request(url, { headers: authorized }));
    expect(await listed?.json()).toEqual({
      threadId,
      tasks: [{ taskId: "bash-1", description: "bun run dev" }],
      turnRunning: false,
    });
    const elsewhere = await handle(
      new Request(`http://localhost/api/work-live-tasks?threadId=${otherThreadId}`, {
        headers: authorized,
      }),
    );
    expect(elsewhere?.status).toBe(403);
  });

  it("stops a Work thread's live tasks for a window that can open it and refuses one that cannot", async () => {
    const { handle, stopLiveTasks } = setup();
    const stop = (thread: string, headers: Record<string, string> = authorized) =>
      handle(
        new Request("http://localhost/api/work-live-tasks/stop", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ kind: "stop-work-live-tasks", threadId: thread }),
        }),
      );
    expect((await stop(String(threadId), {}))?.status).toBe(401);
    expect((await stop(otherThreadId))?.status).toBe(403);
    expect(stopLiveTasks).not.toHaveBeenCalled();
    const stopped = await stop(String(threadId));
    expect(await stopped?.json()).toEqual({ kind: "work-live-tasks-stopped", stopped: true });
    expect(stopLiveTasks).toHaveBeenCalledWith(threadId);
  });

  it("lists and adopts outside sessions only for the person, never the host acting for a routine", async () => {
    const person = setup();
    const adopted = await person.handle(adoption(authorized));
    expect(await adopted?.json()).toMatchObject({ kind: "work-native-session-adopted" });
    expect(person.adoptNativeSession).toHaveBeenCalledWith(windowId, threadId, "outside-session-1");

    const routine = setup(() => false);
    expect((await routine.handle(adoption(authorized)))?.status).toBe(403);
    const listing = await routine.handle(
      new Request(`http://localhost/api/work-native-sessions?threadId=${String(threadId)}`, {
        headers: authorized,
      }),
    );
    expect(listing?.status).toBe(403);
    expect(routine.nativeSessions).not.toHaveBeenCalled();
    expect(routine.adoptNativeSession).not.toHaveBeenCalled();
    expect((await person.handle(adoption({})))?.status).toBe(401);
  });
});
