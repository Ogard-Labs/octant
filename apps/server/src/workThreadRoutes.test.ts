import {
  decodeWorkThread,
  decodeWorkThreadId,
  decodeProjectId,
  decodeWindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRemoteDevicePrincipal } from "./clientPrincipal";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { createWorkThreadRouteHandler } from "./workThreadRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("73000000-0000-4000-8000-000000000001");
const projectId = decodeProjectId("73000000-0000-4000-8000-000000000002");
const threadId = decodeWorkThreadId("73000000-0000-4000-8000-000000000003");
const now = "2026-07-26T22:00:00.000Z";

describe("Work thread routes", () => {
  it("returns an authenticated Work thread bootstrap", async () => {
    const bootstrap = vi.fn(async () => ({ threads: [thread()], runtime: [] }));
    const route = routeFixture({ bootstrap });

    const response = await route(request("/api/work/threads/bootstrap"));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ threads: [thread()], runtime: [] });
    expect(bootstrap).toHaveBeenCalledWith(windowId);
  });

  it("returns projection-only Work navigation for the authenticated window", async () => {
    const navigation = vi.fn(async () => ({ threads: [thread()], runtime: [] }));
    const route = routeFixture({ navigation });

    const response = await route(request("/api/work/navigation"));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ threads: [thread()], runtime: [] });
    expect(navigation).toHaveBeenCalledWith(windowId);
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

  it("refuses a paired device turning on Claude artifacts for a thread, and lets it choose Canvas", async () => {
    const execute = vi.fn(async () => ({ kind: "thread-updated", thread: thread() }));
    const route = routeFixture({ execute });
    const remoteDeviceId = "73000000-0000-4000-8000-000000000020";
    const fromDevice = (documentDelivery: "canvas" | "native-artifacts") => {
      const remote = request("/api/work/threads/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "change-work-thread-document-delivery",
          threadId,
          expectedVersion: 1,
          documentDelivery,
        }),
      });
      bindPrincipalRouteContext(remote, {
        principal: createRemoteDevicePrincipal({
          hostId: "local" as never,
          deviceId: remoteDeviceId as never,
          credentialGeneration: 1,
          origin: "https://octant.invalid",
          protocolVersion: 1,
          capabilityDigest: "b".repeat(64),
          sessionId: "73000000-0000-4000-8000-000000000021" as never,
        }),
        scopeId: remoteDeviceId as never,
      });
      return remote;
    };

    const refused = await route(fromDevice("native-artifacts"));
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toMatchObject({ category: "unauthorized" });
    expect(execute).not.toHaveBeenCalled();

    expect((await route(fromDevice("canvas")))?.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("refuses a paired device raising a Work thread or the Work default to Full access, and lets it lower one", async () => {
    const execute = vi.fn(async () => ({ kind: "thread-updated", thread: thread() }));
    const route = routeFixture({ execute });
    const remoteDeviceId = "73000000-0000-4000-8000-000000000020";
    const fromDevice = (command: Record<string, unknown>) => {
      const remote = request("/api/work/threads/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      bindPrincipalRouteContext(remote, {
        principal: createRemoteDevicePrincipal({
          hostId: "local" as never,
          deviceId: remoteDeviceId as never,
          credentialGeneration: 1,
          origin: "https://octant.invalid",
          protocolVersion: 1,
          capabilityDigest: "b".repeat(64),
          sessionId: "73000000-0000-4000-8000-000000000021" as never,
        }),
        scopeId: remoteDeviceId as never,
      });
      return remote;
    };
    const access = (level: string) => ({
      kind: "change-work-thread-access",
      threadId,
      expectedVersion: 1,
      access: level,
    });

    for (const raise of [
      access("full-access"),
      { kind: "update-work-settings", expectedVersion: 1, defaultAccess: "full-access" },
    ]) {
      const refused = await route(fromDevice(raise));
      expect(refused?.status).toBe(403);
      expect(await refused?.json()).toMatchObject({ category: "unauthorized" });
    }
    expect(execute).not.toHaveBeenCalled();

    expect((await route(fromDevice(access("ask-first"))))?.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();

    const local = await route(
      request("/api/work/threads/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(access("full-access")),
      }),
    );
    expect(local?.status).toBe(200);
  });

  it("refuses a paired device starting a thread from a terminal session on this host", async () => {
    const execute = vi.fn(async () => ({ kind: "thread-created", thread: thread() }));
    const route = routeFixture({ execute });
    const remoteDeviceId = "73000000-0000-4000-8000-000000000030";
    const fromDevice = (withSession: boolean) => {
      const remote = request("/api/work/threads/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "create-work-thread",
          threadId,
          projectId,
          title: "Draft brief",
          providerInstanceId: "73000000-0000-4000-8000-000000000004",
          modelId: "model-a",
          hostId: "local",
          bindingRevisionId: "72000000-0000-4000-8000-000000000008",
          ...(withSession
            ? {
                terminalSession: {
                  provider: "claude",
                  sessionId: "0b4c1f2e-1111-4111-8111-111111111111",
                },
              }
            : {}),
        }),
      });
      bindPrincipalRouteContext(remote, {
        principal: createRemoteDevicePrincipal({
          hostId: "local" as never,
          deviceId: remoteDeviceId as never,
          credentialGeneration: 1,
          origin: "https://octant.invalid",
          protocolVersion: 1,
          capabilityDigest: "b".repeat(64),
          sessionId: "73000000-0000-4000-8000-000000000031" as never,
        }),
        scopeId: remoteDeviceId as never,
      });
      return remote;
    };

    const refused = await route(fromDevice(true));
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toMatchObject({ category: "unauthorized" });
    expect(execute).not.toHaveBeenCalled();

    expect((await route(fromDevice(false)))?.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects missing capability and caller-supplied window identity", async () => {
    const route = routeFixture({});

    expect((await route(new Request("http://127.0.0.1/api/work/threads/bootstrap")))?.status).toBe(
      401,
    );
    expect((await route(new Request("http://127.0.0.1/api/work/navigation")))?.status).toBe(401);

    expect(
      (
        await route(
          request(`/api/work/navigation?windowId=${encodeURIComponent(String(windowId))}`),
        )
      )?.status,
    ).toBe(400);

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

  it("queries the Work Thread Board for an authenticated window", async () => {
    const view = {
      version: 1,
      query: { version: 1, statuses: ["ready", "in-progress", "waiting", "done"] },
      cards: [],
      generatedAt: now,
    };
    const queryBoard = vi.fn(() => view);
    const route = routeFixture({ queryBoard });

    expect(
      (
        await route(
          new Request("http://127.0.0.1/api/work/board", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ version: 1 }),
          }),
        )
      )?.status,
    ).toBe(401);

    const response = await route(
      request("/api/work/board", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, statuses: ["waiting"] }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(view);
    expect(queryBoard).toHaveBeenCalledWith(windowId, { version: 1, statuses: ["waiting"] });
  });

  it("rejects an invalid Work board query and caller-supplied window identity", async () => {
    const queryBoard = vi.fn(() => ({
      version: 1,
      query: { version: 1 },
      cards: [],
      generatedAt: now,
    }));
    const route = routeFixture({ queryBoard });

    expect(
      (
        await route(
          request("/api/work/board", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ version: 1, statuses: ["blocked"] }),
          }),
        )
      )?.status,
    ).toBe(400);
    expect(queryBoard).not.toHaveBeenCalled();

    expect(
      (
        await route(
          request("/api/work/board", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ version: 1, windowId }),
          }),
        )
      )?.status,
    ).toBe(400);
    expect(queryBoard).not.toHaveBeenCalled();
  });

  it("reports the board unavailable when no board service is mounted", async () => {
    const route = routeFixture({});
    const response = await route(
      request("/api/work/board", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1 }),
      }),
    );
    expect(response?.status).toBe(503);
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
    bootstrap: vi.fn(async () => ({ threads: [], runtime: [] })),
    navigation: vi.fn(async () => ({ threads: [], runtime: [] })),
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
