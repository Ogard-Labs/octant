import { decodeProjectId, decodeWindowId, LOCAL_HOST_ID } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRootlessThreadRouteHandler } from "./rootlessThreadRoutes";
import { RootlessThreadServiceError } from "./rootlessThreadService";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000701");
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000702");
const threadId = "00000000-0000-4000-8000-000000000710";
const attachmentId = "00000000-0000-4000-8000-000000000711";

describe("rootless thread routes", () => {
  it("dispatches atomic start, lookup, and cancellation through authenticated routes", async () => {
    const turn = {
      requestId: "00000000-0000-4000-8000-000000000720",
      threadId,
      turnId: "00000000-0000-4000-8000-000000000721",
      status: "running",
      prompt: "Draft a launch brief",
      capabilities: {
        workspace: "rootless",
        rootBackedTools: {
          availability: "unavailable",
          reason:
            "Attach a folder to use filesystem, shell, Git, worktree, test, preview, office mutation, external editor, or delivery tools.",
        },
      },
      acceptedAt: "2026-07-29T10:00:00.000Z",
      updatedAt: "2026-07-29T10:00:00.000Z",
    };
    const startFirstTurn = vi.fn().mockResolvedValue({ kind: "accepted", turn });
    const lookupFirstTurn = vi.fn().mockReturnValue({ kind: "accepted", turn });
    const cancelFirstTurn = vi.fn().mockResolvedValue({
      kind: "turn-cancelled",
      requestId: turn.requestId,
      threadId,
      turnId: turn.turnId,
      status: "cancelled",
    });
    const route = routeFixture({ startFirstTurn, lookupFirstTurn, cancelFirstTurn });
    const startCommand = {
      kind: "start-rootless-thread-turn",
      requestId: turn.requestId,
      threadId,
      turnId: turn.turnId,
      title: "Unfiled brief",
      prompt: turn.prompt,
      context: {
        hostId: "local",
        mode: "work",
        providerInstanceId: "00000000-0000-4000-8000-000000000703",
        modelId: "model-a",
        workspace: { kind: "rootless" },
      },
    };

    const start = await route(
      new Request("http://127.0.0.1/api/rootless/turns", {
        method: "POST",
        headers: {
          "x-octant-window-capability": capability,
          "content-type": "application/json",
        },
        body: JSON.stringify(startCommand),
      }),
    );
    expect(start?.status).toBe(202);
    expect(await start?.json()).toMatchObject({ kind: "accepted" });
    expect(startFirstTurn).toHaveBeenCalledWith(windowId, startCommand);

    const lookup = await route(
      new Request(`http://127.0.0.1/api/rootless/turns/${turn.requestId}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(lookup?.status).toBe(200);
    expect(lookupFirstTurn).toHaveBeenCalledWith(turn.requestId);

    const cancelCommand = {
      kind: "cancel-rootless-turn",
      requestId: turn.requestId,
      threadId,
      turnId: turn.turnId,
    };
    const cancel = await route(
      new Request("http://127.0.0.1/api/rootless/turns/cancel", {
        method: "POST",
        headers: {
          "x-octant-window-capability": capability,
          "content-type": "application/json",
        },
        body: JSON.stringify(cancelCommand),
      }),
    );
    expect(cancel?.status).toBe(200);
    expect(cancelFirstTurn).toHaveBeenCalledWith(cancelCommand);
  });

  it("returns compatible projects for an authenticated lookup", async () => {
    const entries = [{ projectId, displayName: "Docs", rootPath: "/tmp/docs" }];
    const route = routeFixture({ lookupCompatibleProjects: vi.fn().mockResolvedValue(entries) });

    const response = await route(
      new Request("http://127.0.0.1/api/rootless/compatible-projects", {
        method: "POST",
        headers: {
          "x-octant-window-capability": capability,
          "content-type": "application/json",
        },
        body: JSON.stringify({ threadId, mode: "work", hostId: "local" }),
      }),
    );

    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.entries).toEqual(entries);
  });

  it("dispatches an authenticated rootless creation command", async () => {
    const created = {
      kind: "thread-created",
      threadId,
      mode: "work",
      title: "Unfiled brief",
      workspace: { kind: "rootless" },
      createdAt: "2026-07-25T10:00:00.000Z",
    };
    const createThread = vi.fn().mockResolvedValue(created);
    const route = routeFixture({ createThread });
    const command = {
      kind: "create-rootless-thread",
      threadId,
      title: "Unfiled brief",
      context: {
        hostId: "local",
        mode: "work",
        providerInstanceId: "00000000-0000-4000-8000-000000000703",
        modelId: "model-a",
        workspace: { kind: "rootless" },
      },
    };

    const response = await route(
      new Request("http://127.0.0.1/api/rootless/threads", {
        method: "POST",
        headers: {
          "x-octant-window-capability": capability,
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(created);
    expect(createThread).toHaveBeenCalledWith(windowId, command);
  });

  it("rejects a lookup with an invalid body", async () => {
    const route = routeFixture({});
    const response = await route(
      new Request("http://127.0.0.1/api/rootless/compatible-projects", {
        method: "POST",
        headers: {
          "x-octant-window-capability": capability,
          "content-type": "application/json",
        },
        body: JSON.stringify({ invalid: true }),
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const route = routeFixture({});
    const response = await route(
      new Request("http://127.0.0.1/api/rootless/compatible-projects", {
        method: "POST",
        headers: { "x-octant-window-capability": "wrong", "content-type": "application/json" },
        body: JSON.stringify({ threadId, mode: "work", hostId: "local" }),
      }),
    );
    expect(response?.status).toBe(401);
  });

  it("returns the attached result for a successful attach-folder", async () => {
    const attached = {
      kind: "attached",
      attachmentId,
      threadId,
      projectId,
      attachedAt: "2026-07-25T10:00:00.000Z",
    };
    const route = routeFixture({ attachFolder: vi.fn().mockResolvedValue(attached) });

    const response = await route(
      new Request("http://127.0.0.1/api/rootless/attach-folder", {
        method: "POST",
        headers: {
          "x-octant-window-capability": capability,
          "content-type": "application/json",
        },
        body: JSON.stringify({ threadId, projectId, receiptId: "valid-receipt", attachmentId }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(attached);
  });

  it("returns a typed conflict for a concurrent-turn denial", async () => {
    const route = routeFixture({
      attachFolder: vi
        .fn()
        .mockRejectedValue(
          new RootlessThreadServiceError(
            "conflict",
            "Cannot attach during an active turn.",
            "concurrent-turn",
          ),
        ),
    });

    const response = await route(
      new Request("http://127.0.0.1/api/rootless/attach-folder", {
        method: "POST",
        headers: {
          "x-octant-window-capability": capability,
          "content-type": "application/json",
        },
        body: JSON.stringify({ threadId, projectId, receiptId: "valid-receipt", attachmentId }),
      }),
    );

    expect(response?.status).toBe(409);
    const body = await response?.json();
    expect(body.category).toBe("conflict");
    expect(body.reason).toBe("concurrent-turn");
  });

  it("returns 404 for a not-found thread", async () => {
    const route = routeFixture({
      attachFolder: vi
        .fn()
        .mockRejectedValue(new RootlessThreadServiceError("not-found", "Thread was not found.")),
    });

    const response = await route(
      new Request("http://127.0.0.1/api/rootless/attach-folder", {
        method: "POST",
        headers: {
          "x-octant-window-capability": capability,
          "content-type": "application/json",
        },
        body: JSON.stringify({ threadId, projectId, receiptId: "valid-receipt", attachmentId }),
      }),
    );

    expect(response?.status).toBe(404);
  });

  it("returns 503 for an unavailable service", async () => {
    const route = routeFixture({
      attachFolder: vi.fn().mockRejectedValue(new Error("boom")),
    });

    const response = await route(
      new Request("http://127.0.0.1/api/rootless/attach-folder", {
        method: "POST",
        headers: {
          "x-octant-window-capability": capability,
          "content-type": "application/json",
        },
        body: JSON.stringify({ threadId, projectId, receiptId: "valid-receipt", attachmentId }),
      }),
    );

    expect(response?.status).toBe(503);
  });

  it("returns the thread list with recents, all, and unfiled groups", async () => {
    const listResult = {
      recents: [
        {
          threadId,
          title: "Unfiled brief",
          mode: "work",
          hostId: LOCAL_HOST_ID,
          providerInstanceId: "00000000-0000-4000-8000-000000000703",
          modelId: "model-a",
          workspaceKind: "rootless" as const,
          createdAt: "2026-07-25T10:00:00.000Z",
          updatedAt: "2026-07-25T10:00:00.000Z",
        },
      ],
      all: [
        {
          threadId,
          title: "Unfiled brief",
          mode: "work",
          hostId: LOCAL_HOST_ID,
          providerInstanceId: "00000000-0000-4000-8000-000000000703",
          modelId: "model-a",
          workspaceKind: "rootless" as const,
          createdAt: "2026-07-25T10:00:00.000Z",
          updatedAt: "2026-07-25T10:00:00.000Z",
        },
      ],
      unfiled: [
        {
          threadId,
          title: "Unfiled brief",
          mode: "work",
          hostId: LOCAL_HOST_ID,
          providerInstanceId: "00000000-0000-4000-8000-000000000703",
          modelId: "model-a",
          workspaceKind: "rootless" as const,
          createdAt: "2026-07-25T10:00:00.000Z",
          updatedAt: "2026-07-25T10:00:00.000Z",
        },
      ],
    };
    const route = routeFixture({ listThreads: vi.fn().mockReturnValue(listResult) });

    const response = await route(
      new Request("http://127.0.0.1/api/rootless/threads", {
        method: "GET",
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.recents).toHaveLength(1);
    expect(body.all).toHaveLength(1);
    expect(body.unfiled).toHaveLength(1);
  });

  it("returns an empty thread list when no threads exist", async () => {
    const route = routeFixture({});
    const response = await route(
      new Request("http://127.0.0.1/api/rootless/threads", {
        method: "GET",
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.recents).toEqual([]);
    expect(body.all).toEqual([]);
    expect(body.unfiled).toEqual([]);
  });

  it("rejects an unauthenticated rootless thread list", async () => {
    const listThreads = vi.fn().mockReturnValue({ recents: [], all: [], unfiled: [] });
    const route = routeFixture({ listThreads });
    const response = await route(
      new Request("http://127.0.0.1/api/rootless/threads", { method: "GET" }),
    );

    expect(response?.status).toBe(401);
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("rejects POST on the threads list endpoint", async () => {
    const route = routeFixture({});
    const response = await route(
      new Request("http://127.0.0.1/api/rootless/threads", {
        method: "POST",
        headers: {
          "x-octant-window-capability": capability,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("returns 503 when the thread list service throws", async () => {
    const route = routeFixture({
      listThreads: vi.fn().mockImplementation(() => {
        throw new Error("boom");
      }),
    });
    const response = await route(
      new Request("http://127.0.0.1/api/rootless/threads", {
        method: "GET",
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(response?.status).toBe(503);
  });

  it("rejects non-loopback hosts", async () => {
    const route = routeFixture({});
    const response = await route(
      new Request("http://example.com/api/rootless/compatible-projects", {
        method: "POST",
        headers: {
          "x-octant-window-capability": capability,
          "content-type": "application/json",
        },
        body: JSON.stringify({ threadId, mode: "work", hostId: "local" }),
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("returns undefined for unrelated paths", async () => {
    const route = routeFixture({});
    const response = await route(
      new Request("http://127.0.0.1/api/other", {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(response).toBeUndefined();
  });
});

function routeFixture(overrides: Record<string, unknown>) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const service = {
    listThreads: vi.fn().mockReturnValue({ recents: [], all: [], unfiled: [] }),
    createThread: vi.fn().mockResolvedValue({}),
    startFirstTurn: vi.fn().mockResolvedValue({}),
    lookupFirstTurn: vi.fn().mockReturnValue({}),
    cancelFirstTurn: vi.fn().mockResolvedValue({}),
    lookupCompatibleProjects: vi.fn().mockResolvedValue([]),
    attachFolder: vi.fn().mockResolvedValue({ kind: "attached" }),
    ...overrides,
  } as never;
  return createRootlessThreadRouteHandler({
    service,
    windowAuthorityStore: store,
    now: () => 0,
  });
}
