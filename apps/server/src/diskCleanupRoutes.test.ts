import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  HOST_WORKTREE_REMOVE_PATH,
  HOST_WORKTREES_PATH,
  HOST_WORKTREES_SCAN_PATH,
  XCODE_BUILD_DATA_PATH,
  XCODE_BUILD_DATA_REMOVE_PATH,
  createDiskCleanupRouteHandler,
} from "./diskCleanupRoutes";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const windowId = decodeWindowId("78000000-0000-4000-8000-000000000001");
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop4";
const worktree = {
  path: "/home/me/.agent/worktrees/fix",
  branch: "fix",
  detached: false,
  locked: false,
  missing: false,
  delivered: true,
  lastActivityMs: Date.parse("2026-11-01T00:00:00Z"),
  size: { bytes: 2048, complete: true },
  ownedByOctant: false,
};

function route() {
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId, capability, now: 0 });
  const scan = vi.fn(async () => ({
    complete: true,
    problems: [],
    repositories: [
      {
        path: "/home/me/code/app",
        commonDirectory: "/home/me/code/app/.git",
        worktrees: [
          worktree,
          { ...worktree, path: "/home/me/code/.octant-worktrees/x", ownedByOctant: true },
        ],
      },
    ],
  }));
  const remove = vi.fn(async () => ({ status: "removed" as const }));
  const derivedData = {
    available: true,
    list: vi.fn(async () => []),
    remove: vi.fn(async (name: string) =>
      name === "Gone-abc"
        ? ({ status: "removed" } as const)
        : ({ status: "refused", reason: "in-use" } as const),
    ),
  };
  const handler = createDiskCleanupRouteHandler({
    scan,
    remove,
    derivedData,
    windowAuthorityStore,
    now: () => 0,
  });
  return { handler, scan, remove, derivedData };
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

describe("disk cleanup routes", () => {
  it("scans once at a time, leaves Octant's own worktrees out, and drops a removed one", async () => {
    const { handler, scan, remove } = route();
    const [first, second] = await Promise.all([
      handler(request(HOST_WORKTREES_SCAN_PATH, "POST")),
      handler(request(HOST_WORKTREES_SCAN_PATH, "POST")),
    ]);
    expect(scan).toHaveBeenCalledOnce();
    expect(second?.status).toBe(200);
    const scanned = await first?.json();
    expect(scanned.repositories[0].worktrees.map((wt: { path: string }) => wt.path)).toEqual([
      worktree.path,
    ]);

    const removed = await handler(
      request(HOST_WORKTREE_REMOVE_PATH, "POST", {
        repositoryPath: "/home/me/code/app",
        worktreePath: worktree.path,
        confirmed: true,
      }),
    );
    expect(await removed?.json()).toEqual({ kind: "host-worktree-removed" });
    expect(remove).toHaveBeenCalledWith(
      { repositoryPath: "/home/me/code/app", worktreePath: worktree.path },
      expect.any(AbortSignal),
    );
    const after = await (await handler(request(HOST_WORKTREES_PATH, "GET")))?.json();
    expect(after.repositories).toEqual([]);
  });

  it("removes only the Xcode builds the host still finds unused", async () => {
    const { handler } = route();
    const response = await handler(
      request(XCODE_BUILD_DATA_REMOVE_PATH, "POST", {
        names: ["Gone-abc", "Fresh-def"],
        confirmed: true,
      }),
    );
    expect(await response?.json()).toEqual({
      kind: "xcode-build-data-removed",
      removed: ["Gone-abc"],
      kept: ["Fresh-def"],
    });
  });

  it("refuses a caller without the window's capability, and a paired device everything", async () => {
    const { handler, scan, remove, derivedData } = route();
    expect(
      (await handler(request(HOST_WORKTREES_SCAN_PATH, "POST", undefined, false)))?.status,
    ).toBe(401);
    for (const remote of [
      request(HOST_WORKTREES_PATH, "GET"),
      request(HOST_WORKTREES_SCAN_PATH, "POST"),
      request(XCODE_BUILD_DATA_PATH, "GET"),
      request(HOST_WORKTREE_REMOVE_PATH, "POST", {
        repositoryPath: "/r",
        worktreePath: "/w",
        confirmed: true,
      }),
    ]) {
      bindPrincipalRouteContext(remote, {
        principal: { kind: "remote-device" } as never,
        scopeId: windowId,
      });
      expect((await handler(remote))?.status).toBe(403);
    }
    expect(scan).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(derivedData.list).not.toHaveBeenCalled();
  });

  it("refuses a removal that was not confirmed", async () => {
    const { handler, remove } = route();
    const response = await handler(
      request(HOST_WORKTREE_REMOVE_PATH, "POST", { repositoryPath: "/r", worktreePath: "/w" }),
    );
    expect(response?.status).toBe(400);
    expect(remove).not.toHaveBeenCalled();
  });
});
