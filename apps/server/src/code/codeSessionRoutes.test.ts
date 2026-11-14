import { describe, expect, it, vi } from "vitest";
import { decodeCodeNativeSessionId, decodeCodeThreadId, decodeWindowId } from "@octant/contracts";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createCodeSessionRouteHandler } from "./codeSessionRoutes";

const windowId = decodeWindowId("95000000-0000-4000-8000-000000000002");
const threadId = decodeCodeThreadId("95000000-0000-4000-8000-000000000001");
const otherThreadId = "95000000-0000-4000-8000-000000000009";
const capability = `${"C".repeat(42)}A`;
const authorized = { "x-octant-window-capability": capability };

function setup(isPerson: (window: string) => boolean = () => true) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const stopLiveTasks = vi.fn(async () => true);
  const adopt = vi.fn(async () => ({
    kind: "code-native-session-adopted" as const,
    threadId,
    nativeSessionId: decodeCodeNativeSessionId("outside-session-1"),
  }));
  const handle = createCodeSessionRouteHandler({
    isPerson: (window) => isPerson(String(window)),
    nativeSessions: () => ({
      list: async () => ({ threadId, sessions: [] }),
      adopt,
    }),
    windowAuthorityStore: store,
    canOpenThread: (_window, thread) => String(thread) === String(threadId),
    liveTasks: () => ({
      tasks: [{ taskId: "bash-1", description: "bun run dev" }],
      turnRunning: false,
    }),
    stopLiveTasks,
    now: () => 1,
  });
  return { handle, stopLiveTasks, adopt };
}

const adoption = (headers: Record<string, string>) =>
  new Request("http://localhost/api/code-native-sessions/adopt", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      kind: "adopt-code-native-session",
      threadId,
      nativeSessionId: "outside-session-1",
    }),
  });

describe("Code live task routes", () => {
  it("lists a thread's live tasks only to an authenticated window that can open the thread", async () => {
    const { handle } = setup();
    const url = `http://localhost/api/code-live-tasks?threadId=${String(threadId)}`;
    expect((await handle(new Request(url)))?.status).toBe(401);
    const listed = await handle(new Request(url, { headers: authorized }));
    expect(await listed?.json()).toEqual({
      threadId,
      tasks: [{ taskId: "bash-1", description: "bun run dev" }],
      turnRunning: false,
    });
    const elsewhere = await handle(
      new Request(`http://localhost/api/code-live-tasks?threadId=${otherThreadId}`, {
        headers: authorized,
      }),
    );
    expect(elsewhere?.status).toBe(403);
  });

  it("stops a thread's live tasks for a window that can open it and refuses one that cannot", async () => {
    const { handle, stopLiveTasks } = setup();
    const stop = (thread: string, headers: Record<string, string> = authorized) =>
      handle(
        new Request("http://localhost/api/code-live-tasks/stop", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ kind: "stop-code-live-tasks", threadId: thread }),
        }),
      );
    expect((await stop(String(threadId), {}))?.status).toBe(401);
    expect((await stop(otherThreadId))?.status).toBe(403);
    expect(stopLiveTasks).not.toHaveBeenCalled();
    const stopped = await stop(String(threadId));
    expect(await stopped?.json()).toEqual({ kind: "code-live-tasks-stopped", stopped: true });
    expect(stopLiveTasks).toHaveBeenCalledWith(threadId);
  });

  it("refuses an adoption from a client that is not paired with this host", async () => {
    const { handle, adopt } = setup();
    expect((await handle(adoption({})))?.status).toBe(401);
    expect(
      (await handle(adoption({ "x-octant-window-capability": `${"D".repeat(42)}A` })))?.status,
    ).toBe(401);
    expect(adopt).not.toHaveBeenCalled();
  });

  it("refuses an adoption the host would make for a routine rather than the person", async () => {
    const { handle, adopt } = setup(() => false);
    expect((await handle(adoption(authorized)))?.status).toBe(403);
    expect(adopt).not.toHaveBeenCalled();
  });

  it("starts a thread from a session at the person's request", async () => {
    const { handle, adopt } = setup();
    const answered = await handle(adoption(authorized));
    expect(await answered?.json()).toMatchObject({ kind: "code-native-session-adopted" });
    expect(adopt).toHaveBeenCalledWith(windowId, threadId, "outside-session-1");
  });
});
