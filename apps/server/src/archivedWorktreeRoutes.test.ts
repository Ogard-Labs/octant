import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ARCHIVED_WORKTREE_REMOVE_PATH,
  ARCHIVED_WORKTREES_PATH,
  createArchivedWorktreeRouteHandler,
} from "./archivedWorktreeRoutes";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const windowId = decodeWindowId("75000000-0000-4000-8000-000000000001");
const threadId = "75000000-0000-4000-8000-000000000002";
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop4";

function route() {
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId, capability, now: 0 });
  const list = vi.fn(async () => []);
  const remove = vi.fn(async () => ({ kind: "archived-worktree-removed" as const, threadId }));
  const handler = createArchivedWorktreeRouteHandler({
    worktrees: { list, remove } as never,
    windowAuthorityStore,
    now: () => 0,
  });
  return { handler, list, remove };
}

function request(path: string, method: string, body?: unknown, withCapability = true): Request {
  return new Request(`http://127.0.0.1:3100${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(withCapability ? { "x-octant-window-capability": capability } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("archived worktree routes", () => {
  it("lists and removes worktrees for a window on this host", async () => {
    const { handler, list, remove } = route();
    const listed = await handler(request(ARCHIVED_WORKTREES_PATH, "GET"));
    expect(listed?.status).toBe(200);
    expect(await listed?.json()).toEqual({ kind: "archived-worktrees", worktrees: [] });
    expect(list).toHaveBeenCalledOnce();
    const removed = await handler(
      request(ARCHIVED_WORKTREE_REMOVE_PATH, "POST", { threadId, confirmed: true }),
    );
    expect(removed?.status).toBe(200);
    expect(remove).toHaveBeenCalledWith(threadId);
  });

  it("refuses a caller without the window's capability", async () => {
    const { handler, list } = route();
    expect((await handler(request(ARCHIVED_WORKTREES_PATH, "GET", undefined, false)))?.status).toBe(
      401,
    );
    expect(list).not.toHaveBeenCalled();
  });

  it("shows a paired device neither the folders nor a way to delete them", async () => {
    const { handler, list, remove } = route();
    for (const remote of [
      request(ARCHIVED_WORKTREES_PATH, "GET"),
      request(ARCHIVED_WORKTREE_REMOVE_PATH, "POST", { threadId, confirmed: true }),
    ]) {
      bindPrincipalRouteContext(remote, {
        principal: { kind: "remote-device" } as never,
        scopeId: windowId,
      });
      const response = await handler(remote);
      expect(response?.status).toBe(403);
      expect(await response?.json()).toMatchObject({ reason: "unauthorized" });
    }
    expect(list).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses a removal that was not confirmed", async () => {
    const { handler, remove } = route();
    const response = await handler(request(ARCHIVED_WORKTREE_REMOVE_PATH, "POST", { threadId }));
    expect(response?.status).toBe(400);
    expect(remove).not.toHaveBeenCalled();
  });
});
