import {
  decodeWorkRequest,
  decodeWorkRequestId,
  decodeWorkThreadId,
  decodeProjectId,
  decodeWindowId,
  type WorkRequestCommandResult,
  type WorkRequestList,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { createWorkRequestRouteHandler } from "./workRequestRoutes";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000801");
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const threadId = decodeWorkThreadId("00000000-0000-4000-8000-000000000902");
const requestId = decodeWorkRequestId("00000000-0000-4000-8000-000000000903");

const pendingRequest = decodeWorkRequest({
  requestId,
  projectId,
  threadId,
  providerInstanceId: "00000000-0000-4000-8000-000000000905",
  providerSessionId: "00000000-0000-4000-8000-000000000906",
  providerRequestId: "provider-req-1",
  detail: { kind: "approval", action: "run-terminal-command", description: "Run `bun install`." },
  status: "pending",
  requestedAt: "2026-08-10T08:00:00.000Z",
  version: 1,
});

describe("Work request routes", () => {
  it("rejects missing window capability on list", async () => {
    const route = routeFixture();
    const response = await route(
      new Request(`http://127.0.0.1/api/work/requests?projectId=${projectId}`),
    );
    expect(response?.status).toBe(401);
  });

  it("lists pending requests for an authenticated window", async () => {
    const list = vi.fn(async (): Promise<WorkRequestList> => ({ requests: [pendingRequest] }));
    const route = routeFixture({ list });
    const response = await route(request(`/api/work/requests?projectId=${projectId}`));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ requests: [pendingRequest] });
    expect(list).toHaveBeenCalledWith(windowId, projectId, undefined);
  });

  it("scopes the list by threadId when supplied", async () => {
    const list = vi.fn(async (): Promise<WorkRequestList> => ({ requests: [pendingRequest] }));
    const route = routeFixture({ list });
    await route(request(`/api/work/requests?projectId=${projectId}&threadId=${threadId}`));
    expect(list).toHaveBeenCalledWith(windowId, projectId, threadId);
  });

  it("rejects a list request missing projectId", async () => {
    const route = routeFixture();
    const response = await route(request("/api/work/requests"));
    expect(response?.status).toBe(400);
  });

  it("executes resolve commands for an authenticated window", async () => {
    const execute = vi.fn(
      async (): Promise<WorkRequestCommandResult> => ({
        kind: "work-request-resolved",
        request: {
          ...pendingRequest,
          status: "resolved",
          resolution: { kind: "approval", approved: true },
          settledAt: "2026-08-10T08:05:00.000Z",
          version: 2,
        } as never,
      }),
    );
    const route = routeFixture({ execute });
    const command = {
      kind: "resolve-work-request",
      requestId,
      expectedVersion: 1,
      resolution: { kind: "approval", approved: true },
    };
    const response = await route(
      request("/api/work/requests/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      }),
    );
    expect(response?.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(windowId, command);
  });

  it("maps request failures to typed HTTP responses", async () => {
    const execute = vi.fn(async () => {
      throw requestFailure("not-found", "Work request was not found.");
    });
    const route = routeFixture({ execute });
    const response = await route(
      request("/api/work/requests/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "cancel-work-request",
          requestId,
          expectedVersion: 1,
        }),
      }),
    );
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({
      code: "not-found",
      message: "Work request was not found.",
    });
  });

  it("rejects a request that supplies window identity", async () => {
    const route = routeFixture();
    const response = await route(
      request(`/api/work/requests?projectId=${projectId}&windowId=sneaky`),
    );
    expect(response?.status).toBe(400);
  });

  it("never exposes host paths or authority tokens in list responses", async () => {
    const route = routeFixture({
      list: async () => ({ requests: [pendingRequest] }),
    });
    const body = JSON.stringify(
      await (await route(request(`/api/work/requests?projectId=${projectId}`)))?.json(),
    );
    expect(body).not.toMatch(/canonicalRoot|bindingReceipt|file:|\\\\/);
  });
});

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("x-octant-window-capability")) {
    headers.set("x-octant-window-capability", capability);
  }
  return new Request(`http://127.0.0.1${path}`, { ...init, headers });
}

function routeFixture(overrides: Record<string, unknown> = {}) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const service = {
    list: vi.fn(async () => ({ requests: [] })),
    execute: vi.fn(async () => ({
      kind: "work-request-cancelled",
      request: {
        ...pendingRequest,
        status: "cancelled",
        settledAt: "2026-08-10T08:05:00.000Z",
        version: 2,
      },
    })),
    ...overrides,
  };
  return createWorkRequestRouteHandler({
    service: service as never,
    windowAuthorityStore: store,
    now: () => 1,
  });
}

function requestFailure(
  code: "not-found" | "unauthorized",
  message: string,
): Error & { failure: unknown } {
  const error = new Error(message) as Error & { failure: unknown };
  error.failure = { code, message };
  return error;
}
