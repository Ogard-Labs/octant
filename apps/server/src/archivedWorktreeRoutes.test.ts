import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ARCHIVED_WORKTREE_REMOVE_PATH,
  ARCHIVED_WORKTREES_PATH,
  CLEANED_UP_WORKTREE_RESTORE_PATH,
  CLEANED_UP_WORKTREES_PATH,
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
  const listCleanedUp = vi.fn(async () => []);
  const restore = vi.fn(async () => ({ kind: "cleaned-up-worktree-restored" as const, threadId }));
  const handler = createArchivedWorktreeRouteHandler({
    worktrees: { list, remove } as never,
    cleanedUp: { list: listCleanedUp, restore } as never,
    windowAuthorityStore,
    now: () => 0,
  });
  return { handler, list, remove, listCleanedUp, restore };
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

  it("lists and removes worktrees for a person-paired device while refusing hub-introduced and restricted devices", async () => {
    const { handler, list, remove } = route();
    for (const admittedBy of [undefined, "hub-roster"] as const) {
      for (const remote of [
        request(ARCHIVED_WORKTREES_PATH, "GET"),
        request(ARCHIVED_WORKTREE_REMOVE_PATH, "POST", { threadId, confirmed: true }),
      ]) {
        bindPrincipalRouteContext(remote, {
          principal: {
            kind: "remote-device",
            ...(admittedBy === undefined ? {} : { admittedBy }),
          } as never,
          scopeId: windowId,
        });
        const response = await handler(remote);
        expect(response?.status).toBe(403);
        expect(await response?.json()).toMatchObject({ reason: "unauthorized" });
      }
    }
    expect(list).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();

    const listReq = request(ARCHIVED_WORKTREES_PATH, "GET");
    bindPrincipalRouteContext(listReq, {
      principal: { kind: "remote-device", admittedBy: "host-person" } as never,
      scopeId: windowId,
    });
    expect((await handler(listReq))?.status).toBe(200);
    const removeReq = request(ARCHIVED_WORKTREE_REMOVE_PATH, "POST", {
      threadId,
      confirmed: true,
    });
    bindPrincipalRouteContext(removeReq, {
      principal: { kind: "remote-device", admittedBy: "host-person" } as never,
      scopeId: windowId,
    });
    expect((await handler(removeReq))?.status).toBe(200);
    expect(list).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(threadId);
  });

  it("refuses a removal that was not confirmed", async () => {
    const { handler, remove } = route();
    const response = await handler(request(ARCHIVED_WORKTREE_REMOVE_PATH, "POST", { threadId }));
    expect(response?.status).toBe(400);
    expect(remove).not.toHaveBeenCalled();
  });

  it("lists and restores cleaned-up worktrees for a window on this host, and refuses a malformed or unconfirmed restore", async () => {
    const { handler, listCleanedUp, restore } = route();
    const listed = await handler(request(CLEANED_UP_WORKTREES_PATH, "GET"));
    expect(listed?.status).toBe(200);
    expect(await listed?.json()).toEqual({ kind: "cleaned-up-worktrees", worktrees: [] });
    expect(listCleanedUp).toHaveBeenCalledOnce();
    const restored = await handler(
      request(CLEANED_UP_WORKTREE_RESTORE_PATH, "POST", { threadId, confirmed: true }),
    );
    expect(restored?.status).toBe(200);
    expect(restore).toHaveBeenCalledWith(threadId);
    for (const body of [{ threadId }, { threadId, confirmed: false }, { confirmed: true }]) {
      const refused = await handler(request(CLEANED_UP_WORKTREE_RESTORE_PATH, "POST", body));
      expect(refused?.status).toBe(400);
      expect(await refused?.json()).toMatchObject({ reason: "malformed" });
    }
    expect(restore).toHaveBeenCalledOnce();
  });

  it("restores for a person-paired device while refusing hub-introduced and restricted devices, and callers without the capability", async () => {
    const { handler, listCleanedUp, restore } = route();
    expect(
      (await handler(request(CLEANED_UP_WORKTREES_PATH, "GET", undefined, false)))?.status,
    ).toBe(401);
    for (const admittedBy of [undefined, "hub-roster"] as const) {
      for (const remote of [
        request(CLEANED_UP_WORKTREES_PATH, "GET"),
        request(CLEANED_UP_WORKTREE_RESTORE_PATH, "POST", { threadId, confirmed: true }),
      ]) {
        bindPrincipalRouteContext(remote, {
          principal: {
            kind: "remote-device",
            ...(admittedBy === undefined ? {} : { admittedBy }),
          } as never,
          scopeId: windowId,
        });
        const response = await handler(remote);
        expect(response?.status).toBe(403);
        expect(await response?.json()).toMatchObject({ reason: "unauthorized" });
      }
    }
    expect(listCleanedUp).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    const paired = request(CLEANED_UP_WORKTREE_RESTORE_PATH, "POST", { threadId, confirmed: true });
    bindPrincipalRouteContext(paired, {
      principal: { kind: "remote-device", admittedBy: "host-person" } as never,
      scopeId: windowId,
    });
    expect((await handler(paired))?.status).toBe(200);
    expect(restore).toHaveBeenCalledWith(threadId);
  });
});
