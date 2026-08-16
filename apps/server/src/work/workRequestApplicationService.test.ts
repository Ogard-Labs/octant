import { describe, expect, it, vi } from "vitest";
import {
  decodeWorkRequest,
  decodeWorkRequestId,
  decodeWorkThreadId,
  decodeProjectId,
  decodeWindowId,
} from "@octant/contracts";
import {
  WorkRequestApplicationError,
  WorkRequestApplicationService,
} from "./workRequestApplicationService";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000801");
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const otherProjectId = decodeProjectId("00000000-0000-4000-8000-000000000904");
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

function fixture(
  overrides: {
    activeProjects?: ReadonlyArray<{ id: unknown; type: string }>;
    threads?: ReadonlyArray<{ id: unknown; projectId: unknown }>;
    requestsOverride?: Record<string, unknown>;
  } = {},
) {
  const projects = {
    bootstrap: vi.fn(async () => ({
      active: overrides.activeProjects ?? [{ id: projectId, type: "work" }],
      archived: [],
      availability: [],
      memory: [],
    })),
  };
  const threads = {
    bootstrap: vi.fn(async () => ({
      threads: overrides.threads ?? [{ id: threadId, projectId }],
    })),
  };
  const requests = {
    lookup: vi.fn(() => pendingRequest),
    listPending: vi.fn(() => [pendingRequest]),
    listForThread: vi.fn(() => [pendingRequest]),
    resolve: vi.fn(() => ({
      status: "ok" as const,
      request: { ...pendingRequest, status: "resolved" as const },
    })),
    cancel: vi.fn(() => ({
      status: "ok" as const,
      request: { ...pendingRequest, status: "cancelled" as const },
    })),
    ...overrides.requestsOverride,
  };
  const service = new WorkRequestApplicationService({
    requests: requests as never,
    projects: projects as never,
    threads: threads as never,
  });
  return { service, projects, threads, requests };
}

describe("WorkRequestApplicationService.list", () => {
  it("lists pending requests for an authorized Work Project", async () => {
    const { service, requests } = fixture();
    const list = await service.list(windowId, projectId);
    expect(list.requests).toHaveLength(1);
    expect(requests.listPending).toHaveBeenCalledWith(projectId);
  });

  it("rejects a Project the window cannot access", async () => {
    const { service } = fixture({ activeProjects: [] });
    await expect(service.list(windowId, projectId)).rejects.toBeInstanceOf(
      WorkRequestApplicationError,
    );
  });

  it("rejects a Project that is not a Work Project", async () => {
    const { service } = fixture({ activeProjects: [{ id: projectId, type: "chat" }] });
    await expect(service.list(windowId, projectId)).rejects.toBeInstanceOf(
      WorkRequestApplicationError,
    );
  });

  it("scopes the list to a thread when threadId is supplied", async () => {
    const { service, requests } = fixture();
    const list = await service.list(windowId, projectId, threadId);
    expect(list.requests).toHaveLength(1);
    expect(requests.listForThread).toHaveBeenCalledWith(projectId, threadId);
  });

  it("rejects a thread that does not belong to the requested Project", async () => {
    const { service } = fixture({ threads: [{ id: threadId, projectId: otherProjectId }] });
    await expect(service.list(windowId, projectId, threadId)).rejects.toBeInstanceOf(
      WorkRequestApplicationError,
    );
  });

  it("bounds the Project pending list to the 128 most recent requests before decoding", async () => {
    const requests = manyRequests(150);
    const { service } = fixture({ requestsOverride: { listPending: vi.fn(() => requests) } });
    const list = await service.list(windowId, projectId);
    expect(list.requests).toHaveLength(128);
    expect(list.requests[0]).toEqual(requests[149]);
    const oldest = requests.slice(0, 22).map((request) => request.requestId);
    for (const request of list.requests) {
      expect(oldest).not.toContain(request.requestId);
    }
  });

  it("bounds the thread-scoped pending list to 128 requests before decoding", async () => {
    const requests = manyRequests(150);
    const { service } = fixture({ requestsOverride: { listForThread: vi.fn(() => requests) } });
    const list = await service.list(windowId, projectId, threadId);
    expect(list.requests).toHaveLength(128);
    expect(list.requests[0]).toEqual(requests[149]);
  });
});

describe("WorkRequestApplicationService.execute", () => {
  it("resolves a request for an authorized Work Project", async () => {
    const { service, requests } = fixture();
    const result = await service.execute(windowId, {
      kind: "resolve-work-request",
      requestId,
      expectedVersion: pendingRequest.version,
      resolution: { kind: "approval", approved: true },
    });
    expect(result.kind).toBe("work-request-resolved");
    expect(requests.resolve).toHaveBeenCalled();
  });

  it("cancels a request for an authorized Work Project", async () => {
    const { service, requests } = fixture();
    const result = await service.execute(windowId, {
      kind: "cancel-work-request",
      requestId,
      expectedVersion: pendingRequest.version,
    });
    expect(result.kind).toBe("work-request-cancelled");
    expect(requests.cancel).toHaveBeenCalled();
  });

  it("throws not-found when the request does not exist", async () => {
    const { service } = fixture({ requestsOverride: { lookup: vi.fn(() => undefined) } });
    await expect(
      service.execute(windowId, {
        kind: "cancel-work-request",
        requestId,
        expectedVersion: pendingRequest.version,
      }),
    ).rejects.toMatchObject({ failure: { code: "not-found" } });
  });

  it("rejects a command for a Project the window cannot access", async () => {
    const { service } = fixture({ activeProjects: [] });
    await expect(
      service.execute(windowId, {
        kind: "cancel-work-request",
        requestId,
        expectedVersion: pendingRequest.version,
      }),
    ).rejects.toMatchObject({ failure: { code: "unauthorized" } });
  });

  it("propagates a service-level failure", async () => {
    const { service } = fixture({
      requestsOverride: {
        cancel: vi.fn(() => ({
          status: "failure" as const,
          failure: { code: "conflict", message: "already settled" },
        })),
      },
    });
    await expect(
      service.execute(windowId, {
        kind: "cancel-work-request",
        requestId,
        expectedVersion: pendingRequest.version,
      }),
    ).rejects.toMatchObject({ failure: { code: "conflict" } });
  });
});

function manyRequests(count: number): ReadonlyArray<typeof pendingRequest> {
  return Array.from({ length: count }, (_, index) =>
    decodeWorkRequest({
      ...pendingRequest,
      requestId: decodeWorkRequestId(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
      providerRequestId: `provider-req-${index}`,
      requestedAt: `2026-08-10T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
      version: 1,
    }),
  );
}
