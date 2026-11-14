import { describe, expect, it, vi } from "vitest";
import { decodeCodeThreadId, decodeWindowId } from "@octant/contracts";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createCodeSessionRouteHandler } from "./codeSessionRoutes";

const windowId = decodeWindowId("95000000-0000-4000-8000-000000000002");
const threadId = decodeCodeThreadId("95000000-0000-4000-8000-000000000001");
const otherThreadId = "95000000-0000-4000-8000-000000000009";
const capability = `${"C".repeat(42)}A`;
const authorized = { "x-octant-window-capability": capability };

function setup() {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const stopLiveTasks = vi.fn(async () => true);
  const handle = createCodeSessionRouteHandler({
    windowAuthorityStore: store,
    canOpenThread: (_window, thread) => String(thread) === String(threadId),
    liveTasks: () => ({
      tasks: [{ taskId: "bash-1", description: "bun run dev" }],
      turnRunning: false,
    }),
    stopLiveTasks,
    now: () => 1,
  });
  return { handle, stopLiveTasks };
}

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
});
