import { describe, expect, it, vi } from "vitest";
import {
  decodeWindowId,
  type ThreadMessageQueueCommand,
  type ThreadMessageQueueResult,
} from "@octant/contracts";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createThreadMessageQueueRouteHandler } from "./threadMessageQueueRoutes";

const windowId = decodeWindowId("92000000-0000-4000-8000-000000000002");
const threadId = "92000000-0000-4000-8000-000000000001";
const capability = "A".repeat(43);
const enqueue = {
  kind: "enqueue",
  scope: { mode: "chat", threadId },
  expectedVersion: 0,
  requestId: "92000000-0000-4000-8000-000000000003",
  messageId: "92000000-0000-4000-8000-000000000004",
  payload: { mode: "chat", prompt: "Please continue." },
};

function setup() {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const read = vi.fn(async () => ({ status: "refused", reason: "unauthorized" }) as const);
  const execute = vi.fn(
    async (
      _windowId: typeof windowId,
      command: ThreadMessageQueueCommand,
    ): Promise<ThreadMessageQueueResult> => ({
      status: "refused",
      reason: "unauthorized",
      requestId: command.requestId,
    }),
  );
  const handle = createThreadMessageQueueRouteHandler({
    service: { read, execute },
    windowAuthorityStore: store,
    now: () => 1,
  });
  return { read, execute, handle };
}

describe("message queue routes", () => {
  it("authenticates before reading queued private content", async () => {
    const { handle, read } = setup();
    const denied = await handle(
      new Request(`http://localhost/api/thread-message-queue?mode=chat&threadId=${threadId}`),
    );
    expect(denied?.status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    const allowed = await handle(
      new Request(`http://localhost/api/thread-message-queue?mode=chat&threadId=${threadId}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(allowed?.status).toBe(200);
    expect(read).toHaveBeenCalledWith(windowId, { mode: "chat", threadId });
    expect(await allowed?.json()).toEqual({ status: "refused", reason: "unauthorized" });
    expect(allowed?.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses injected authority and foreign origins without mutating the queue", async () => {
    const { handle, execute } = setup();
    const post = (body: unknown, origin = "http://localhost") =>
      new Request("http://localhost/api/thread-message-queue/commands", {
        method: "POST",
        headers: { "x-octant-window-capability": capability, origin },
        body: JSON.stringify(body),
      });
    expect((await handle(post({ ...enqueue, windowId })))?.status).toBe(400);
    expect((await handle(post(enqueue, "https://untrusted.example")))?.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("bounds received bytes even when content length understates the request", async () => {
    const { handle, execute } = setup();
    const result = await handle(
      new Request("http://localhost/api/thread-message-queue/commands", {
        method: "POST",
        headers: { "x-octant-window-capability": capability, "content-length": "1" },
        body: " ".repeat(1024 * 1024 + 4097),
      }),
    );
    expect(result?.status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
  });
});
