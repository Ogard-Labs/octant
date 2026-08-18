import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { ThreadCheckpointError } from "./checkpoint/threadCheckpointService";
import { createThreadCheckpointRouteHandler } from "./threadCheckpointRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const windowId = decodeWindowId("11111111-1111-4111-8111-111111111111");
const capability = `${"A".repeat(42)}A`;
const threadId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";

function handler(
  checkpoints: {
    readonly list?: ReturnType<typeof vi.fn>;
    readonly execute?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const list = checkpoints.list ?? vi.fn(async () => []);
  const execute = checkpoints.execute ?? vi.fn(async () => ({ kind: "checkpoint-marked" }));
  return {
    list,
    execute,
    handle: createThreadCheckpointRouteHandler({
      windowAuthorityStore: store,
      checkpoints: { list, execute } as never,
      now: () => 0,
    }),
  };
}

const markBody = JSON.stringify({
  kind: "mark-thread-checkpoint",
  anchor: { mode: "chat", threadId, turnId },
  label: "Before the rewrite",
});

describe("checkpoint routes", () => {
  it("answers a thread's checkpoints to the window that authenticated", async () => {
    const { handle, list } = handler();

    const response = await handle(
      new Request(`http://127.0.0.1/api/checkpoints?threadId=${threadId}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ checkpoints: [] });
    expect(list).toHaveBeenCalledWith(windowId, threadId);
  });

  it("refuses a request that carries no window capability", async () => {
    const { handle, execute } = handler();

    const response = await handle(
      new Request("http://127.0.0.1/api/checkpoints/commands", {
        method: "POST",
        body: markBody,
      }),
    );

    expect(response?.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a request that did not come from loopback", async () => {
    const { handle, execute } = handler();

    const response = await handle(
      new Request("http://octant.example/api/checkpoints/commands", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: markBody,
      }),
    );

    expect(response?.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("hands the command to the service under the authenticated window", async () => {
    const { handle, execute } = handler();

    const response = await handle(
      new Request("http://127.0.0.1/api/checkpoints/commands", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: markBody,
      }),
    );

    expect(response?.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(windowId, {
      kind: "mark-thread-checkpoint",
      anchor: { mode: "chat", threadId, turnId },
      label: "Before the rewrite",
    });
  });

  it("reports a checkpoint that moved under the caller as a conflict", async () => {
    const { handle } = handler({
      execute: vi.fn(async () => {
        throw new ThreadCheckpointError("conflict", "Checkpoint has changed since it was read.");
      }),
    });

    const response = await handle(
      new Request("http://127.0.0.1/api/checkpoints/commands", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: markBody,
      }),
    );

    expect(response?.status).toBe(409);
  });

  it("leaves paths it does not own to the rest of the server", async () => {
    const { handle } = handler();

    expect(await handle(new Request("http://127.0.0.1/api/chat"))).toBeUndefined();
  });
});
