import {
  decodeWorkThread,
  decodeWorkThreadId,
  decodeProjectId,
  decodeWindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createWorkThreadRouteHandler } from "./workThreadRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("73000000-0000-4000-8000-000000000001");
const projectId = decodeProjectId("73000000-0000-4000-8000-000000000002");
const threadId = decodeWorkThreadId("73000000-0000-4000-8000-000000000003");
const now = "2026-07-26T22:00:00.000Z";

describe("Work thread routes", () => {
  it("returns an authenticated Work thread bootstrap", async () => {
    const bootstrap = vi.fn(async () => ({ threads: [thread()] }));
    const route = routeFixture({ bootstrap });

    const response = await route(request("/api/work/threads/bootstrap"));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ threads: [thread()] });
    expect(bootstrap).toHaveBeenCalledWith(windowId);
  });

  it("executes Work thread commands for an authenticated window", async () => {
    const execute = vi.fn(async () => ({ kind: "thread-created", thread: thread() }));
    const route = routeFixture({ execute });
    const command = {
      kind: "create-work-thread",
      threadId,
      projectId,
      title: "Draft brief",
      providerInstanceId: "73000000-0000-4000-8000-000000000004",
      modelId: "model-a",
      hostId: "local",
      bindingRevisionId: "72000000-0000-4000-8000-000000000008",
    };

    const response = await route(
      request("/api/work/threads/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ kind: "thread-created", thread: thread() });
    expect(execute).toHaveBeenCalledWith(windowId, command);
  });

  it("rejects missing capability and caller-supplied window identity", async () => {
    const route = routeFixture({});

    expect((await route(new Request("http://127.0.0.1/api/work/threads/bootstrap")))?.status).toBe(
      401,
    );

    expect(
      (
        await route(
          request(`/api/work/threads/bootstrap?windowId=${encodeURIComponent(String(windowId))}`),
        )
      )?.status,
    ).toBe(400);

    expect(
      (
        await route(
          request("/api/work/threads/commands", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              kind: "rename-work-thread",
              threadId,
              expectedVersion: 1,
              title: "Renamed",
              windowId,
            }),
          }),
        )
      )?.status,
    ).toBe(400);
  });

  it("maps Work thread failures to typed HTTP responses", async () => {
    const execute = vi.fn(async () => {
      throw {
        failure: {
          category: "stale",
          message: "Work thread changed; reload and retry.",
        },
      };
    });
    const route = routeFixture({ execute });

    const response = await route(
      request("/api/work/threads/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "change-work-thread-lifecycle",
          threadId,
          expectedVersion: 1,
          lifecycle: "archived",
        }),
      }),
    );

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      category: "stale",
      message: "Work thread changed; reload and retry.",
    });
  });
});

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("x-octant-window-capability")) {
    headers.set("x-octant-window-capability", capability);
  }
  return new Request(`http://127.0.0.1${path}`, { ...init, headers });
}

function routeFixture(overrides: Record<string, unknown>) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const service = {
    bootstrap: vi.fn(async () => ({ threads: [] })),
    execute: vi.fn(async () => ({ kind: "thread-created", thread: thread() })),
    ...overrides,
  } as never;
  return createWorkThreadRouteHandler({
    service,
    windowAuthorityStore: store,
    now: () => 1,
  });
}

function thread() {
  return decodeWorkThread({
    id: threadId,
    projectId,
    title: "Draft brief",
    lifecycle: "active",
    providerInstanceId: "73000000-0000-4000-8000-000000000004",
    modelId: "model-a",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}
