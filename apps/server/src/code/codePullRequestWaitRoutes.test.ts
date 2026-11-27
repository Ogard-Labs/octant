import { describe, expect, it, vi } from "vitest";
import { decodeCodeThreadId, decodeWindowId } from "@octant/contracts";
import {
  decodeCodeProjectPullRequestSwitchTarget,
  decodeCodeThreadPullRequestWaits,
} from "@octant/contracts/code-project-pull-request-switches";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createCodePullRequestWaitRouteHandler } from "./codePullRequestWaitRoutes";

const windowId = decodeWindowId("95000000-0000-4000-8000-000000000002");
const threadId = decodeCodeThreadId("95000000-0000-4000-8000-000000000001");
const otherThreadId = "95000000-0000-4000-8000-000000000009";
const capability = `${"C".repeat(42)}A`;
const authorized = { "x-octant-window-capability": capability };
const target = decodeCodeProjectPullRequestSwitchTarget({
  projectId: "10000000-0000-4000-8000-000000000001",
  repositoryOwner: "octant",
  repositoryName: "octant",
  number: 372,
});
const { waits } = decodeCodeThreadPullRequestWaits({
  threadId,
  waits: [{ kind: "watch", target, since: "2026-11-25T10:00:00.000Z", paused: false }],
});

function setup(isPerson = true) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const threadWaits = vi.fn(() => waits);
  const stopThreadWait = vi.fn(() => true);
  const handle = createCodePullRequestWaitRouteHandler({
    windowAuthorityStore: store,
    canOpenThread: (_window, thread) => String(thread) === String(threadId),
    isPerson: () => isPerson,
    waits: { threadWaits, stopThreadWait },
    now: () => 1,
  });
  return { handle, threadWaits, stopThreadWait };
}

const read = (thread: string, headers: Record<string, string> = authorized) =>
  new Request(`http://localhost/api/code-thread-waits?threadId=${thread}`, { headers });
const stop = (
  over: Record<string, unknown> = {},
  headers: Record<string, string> = authorized,
): Request =>
  new Request("http://localhost/api/code-thread-waits/stop", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      kind: "stop-code-thread-pull-request-wait",
      threadId,
      wait: "watch",
      target,
      since: "2026-11-25T10:00:00.000Z",
      ...over,
    }),
  });

describe("Code thread pull-request wait routes", () => {
  it("lists a thread's waits only to an authenticated window that can open the thread", async () => {
    const { handle, threadWaits } = setup();
    expect((await handle(read(String(threadId), {})))?.status).toBe(401);
    expect((await handle(read(otherThreadId)))?.status).toBe(403);
    expect(threadWaits).not.toHaveBeenCalled();
    const listed = await handle(read(String(threadId)));
    expect(await listed?.json()).toEqual({ threadId, waits });
  });

  it("stops one named wait for the person at a window that can open the thread", async () => {
    const { handle, stopThreadWait } = setup();
    expect((await handle(stop({}, {})))?.status).toBe(401);
    expect((await handle(stop({ threadId: otherThreadId })))?.status).toBe(403);
    expect((await handle(stop({ windowId: String(windowId) })))?.status).toBe(400);
    expect(stopThreadWait).not.toHaveBeenCalled();

    const stopped = await handle(stop());
    expect(await stopped?.json()).toEqual({
      kind: "code-thread-pull-request-wait-stopped",
      stopped: true,
    });
    expect(stopThreadWait).toHaveBeenCalledWith({
      threadId,
      wait: "watch",
      target,
      since: "2026-11-25T10:00:00.000Z",
      actor: expect.objectContaining({ kind: "local-user" }),
    });
  });

  it("names the paired device that stopped a wait, never the local person", async () => {
    const { handle, stopThreadWait } = setup();
    const request = stop({}, {});
    bindPrincipalRouteContext(request, {
      principal: {
        kind: "remote-device",
        deviceId: "22222222-2222-4222-8222-222222222222",
      } as never,
      scopeId: windowId,
    });
    expect((await handle(request))?.status).toBe(200);
    expect(stopThreadWait).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({
          kind: "remote-device",
          deviceId: "22222222-2222-4222-8222-222222222222",
        }),
      }),
    );
  });

  it("refuses to stop a wait for a caller that is not the person", async () => {
    const { handle, stopThreadWait } = setup(false);
    expect((await handle(stop()))?.status).toBe(403);
    expect(stopThreadWait).not.toHaveBeenCalled();
  });
});
