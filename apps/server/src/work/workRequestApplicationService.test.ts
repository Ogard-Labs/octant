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
import { WorkRequestProjection } from "./workRequestProjection";
import { WorkRequestService } from "./workRequestService";

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
    threads?: ReadonlyArray<{ id: unknown; projectId: unknown; title?: string }>;
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

describe("WorkRequestApplicationService.listPendingForWindow", () => {
  it("lists the pending requests of every Work Project and thread the window can open", async () => {
    const { service } = fixture({ threads: [{ id: threadId, projectId, title: "Report" }] });
    expect(await service.listPendingForWindow(windowId)).toEqual([
      {
        mode: "work",
        kind: "approval",
        projectId,
        threadId,
        threadTitle: "Report",
        text: "Run `bun install`.",
        requestedAt: pendingRequest.requestedAt,
        answer: { requestId, expectedVersion: 1 },
      },
    ]);
  });

  it("omits a Project the window cannot access and one that is not a Work Project", async () => {
    const { service, requests } = fixture({
      activeProjects: [{ id: otherProjectId, type: "chat" }],
      threads: [{ id: threadId, projectId, title: "Report" }],
    });
    expect(await service.listPendingForWindow(windowId)).toEqual([]);
    expect(requests.listPending).not.toHaveBeenCalled();
  });

  it("omits a request on a thread the window's thread list does not hold", async () => {
    const { service } = fixture({
      threads: [{ id: threadId, projectId: otherProjectId, title: "Elsewhere" }],
    });
    expect(await service.listPendingForWindow(windowId)).toEqual([]);
  });

  it("answers through resolve-work-request with the listed handle, then lists it no more", async () => {
    const projection = new WorkRequestProjection();
    const frames: unknown[] = [];
    const requests = new WorkRequestService({
      projects: {
        projectType: () => "work",
        isActiveWorkProject: (id: unknown) => String(id) === String(projectId),
        workCanonicalRoot: () => "/work",
        threadProjectId: () => projectId,
        threadProviderInstanceId: () => pendingRequest.providerInstanceId,
      },
      projection,
      eventStore: {
        append: (input: { frame: unknown }) => {
          frames.push(input.frame);
          return input.frame;
        },
        replayAll: () => ({ status: "ok", frames }),
      },
      actor: { kind: "local-user", actorId: "55555555-5555-4555-8555-555555555555" },
      clock: () => "2026-08-10T08:00:00.000Z",
    } as never);
    requests.record({
      requestId,
      projectId,
      threadId,
      providerInstanceId: pendingRequest.providerInstanceId,
      providerSessionId: pendingRequest.providerSessionId,
      providerCallbackId: "provider-req-1",
      detail: { kind: "user-input", prompt: "Which format?", options: ["PDF", "DOCX"] },
    });
    const service = new WorkRequestApplicationService({
      requests,
      projects: {
        bootstrap: async () => ({ active: [{ id: projectId, type: "work" }] }),
      },
      threads: {
        bootstrap: async () => ({ threads: [{ id: threadId, projectId, title: "Report" }] }),
      },
    });

    const [listed] = await service.listPendingForWindow(windowId);
    if (listed?.mode !== "work" || listed.kind !== "question") {
      throw new Error("Expected a Work question.");
    }
    expect(listed.options).toEqual([{ label: "PDF" }, { label: "DOCX" }]);
    await expect(
      service.execute(windowId, {
        kind: "resolve-work-request",
        requestId: listed.answer.requestId,
        expectedVersion: listed.answer.expectedVersion,
        resolution: { kind: "user-input", answer: "PDF" },
      }),
    ).resolves.toMatchObject({ kind: "work-request-resolved" });
    expect(await service.listPendingForWindow(windowId)).toEqual([]);
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
