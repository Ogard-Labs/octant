import { describe, expect, it, vi } from "vitest";
import { decodeThreadWakeup, decodeWindowId } from "@octant/contracts";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createThreadWakeupRouteHandler } from "./threadWakeupRoutes";

const windowId = decodeWindowId("93000000-0000-4000-8000-000000000002");
const threadId = "93000000-0000-4000-8000-000000000001";
const otherThreadId = "93000000-0000-4000-8000-000000000009";
const wakeupId = "93000000-0000-4000-8000-000000000003";
const capability = `${"B".repeat(42)}A`;

const wakeup = decodeThreadWakeup({
  id: wakeupId,
  mode: "code",
  threadId,
  providerToolName: "ScheduleWakeup",
  prompt: "Check the build.",
  schedule: { kind: "delay" },
  humanSchedule: "Once at 2026-11-14T12:05:00.000Z",
  createdAt: "2026-11-14T12:00:00.000Z",
  nextFireAt: "2026-11-14T12:05:00.000Z",
  status: "pending",
});

function setup(opens: (thread: string) => boolean) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const cancel = vi.fn(() => ({ kind: "thread-wakeup-updated" as const, wakeup }));
  const service = {
    list: vi.fn(() => [wakeup]),
    read: vi.fn(() => wakeup),
    cancel,
    runMissed: vi.fn(async () => ({
      kind: "thread-wakeup-refused" as const,
      message: "Only a missed wake-up can be run now.",
    })),
  };
  const handle = createThreadWakeupRouteHandler({
    service: () => service,
    windowAuthorityStore: store,
    canOpenThread: (_window, _mode, thread) => opens(thread),
    now: () => 1,
  });
  return { handle, service, cancel };
}

const authorized = { "x-octant-window-capability": capability };

describe("thread wake-up routes", () => {
  it("lists a thread's wake-ups only to an authenticated window that can open the thread", async () => {
    const { handle, service } = setup((thread) => thread === threadId);
    const url = `http://localhost/api/thread-wakeups?mode=code&threadId=${threadId}`;
    expect((await handle(new Request(url)))?.status).toBe(401);
    const listed = await handle(new Request(url, { headers: authorized }));
    expect(listed?.status).toBe(200);
    expect(await listed?.json()).toEqual({ wakeups: [wakeup] });
    const elsewhere = await handle(
      new Request(`http://localhost/api/thread-wakeups?mode=code&threadId=${otherThreadId}`, {
        headers: authorized,
      }),
    );
    expect(elsewhere?.status).toBe(403);
    expect(service.list).toHaveBeenCalledOnce();
  });

  it("cancels a wake-up as the person and refuses one whose thread this window cannot open", async () => {
    const post = () =>
      new Request("http://localhost/api/thread-wakeups/commands", {
        method: "POST",
        headers: { ...authorized, "content-type": "application/json" },
        body: JSON.stringify({ kind: "cancel-thread-wakeup", wakeupId }),
      });
    const allowed = setup(() => true);
    expect(await (await allowed.handle(post()))?.json()).toMatchObject({
      kind: "thread-wakeup-updated",
    });
    expect(allowed.cancel).toHaveBeenCalledWith(wakeupId, {
      kind: "local-user",
      actorId: expect.any(String),
    });

    const refused = setup(() => false);
    expect(await (await refused.handle(post()))?.json()).toMatchObject({
      kind: "thread-wakeup-refused",
    });
    expect(refused.cancel).not.toHaveBeenCalled();
  });
});
