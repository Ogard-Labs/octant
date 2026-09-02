import {
  decodeWorkRequest,
  decodeWorkThreadId,
  decodeProjectId,
  type WorkRequestCommandResult,
  type WorkRequestList,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { WorkRequestClientFailure, createWorkRequestClient } from "./workRequestClient";

const baseUrl = "http://127.0.0.1:13773";
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const threadId = decodeWorkThreadId("00000000-0000-4000-8000-000000000902");

const pending = decodeWorkRequest({
  requestId: "00000000-0000-4000-8000-000000000903",
  projectId,
  threadId,
  providerInstanceId: "00000000-0000-4000-8000-000000000904",
  providerSessionId: "00000000-0000-4000-8000-000000000906",
  providerRequestId: "provider-req-1",
  detail: { kind: "approval", action: "Run shell command", description: "Approve the build" },
  status: "pending",
  requestedAt: "2026-07-23T12:00:00.000Z",
  version: 1,
});

const listFixture: WorkRequestList = { requests: [pending] };

describe("createWorkRequestClient", () => {
  it("lists pending requests scoped to a Project", async () => {
    const fetch = vi.fn(async () =>
      Response.json(listFixture, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const client = createWorkRequestClient({ baseUrl, fetch, windowCapability: capability });
    await expect(client.list(projectId)).resolves.toEqual(listFixture);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/work/requests?projectId=${encodeURIComponent(String(projectId))}`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "x-octant-window-capability": capability }),
      }),
    );
  });

  it("lists requests scoped to a Project and thread", async () => {
    const fetch = vi.fn(async () =>
      Response.json(listFixture, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const client = createWorkRequestClient({ baseUrl, fetch, windowCapability: capability });
    await client.list(projectId, threadId);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/work/requests?projectId=${encodeURIComponent(String(projectId))}&threadId=${encodeURIComponent(String(threadId))}`,
      expect.anything(),
    );
  });

  it("preserves caller cancellation when a list request is aborted", async () => {
    const fetch = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const client = createWorkRequestClient({ baseUrl, fetch, windowCapability: capability });
    const controller = new AbortController();
    controller.abort();

    await expect(client.list(projectId, threadId, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("executes resolve/cancel commands", async () => {
    const result: WorkRequestCommandResult = {
      kind: "work-request-resolved",
      request: decodeWorkRequest({
        ...pending,
        status: "resolved",
        resolution: { kind: "approval", approved: true },
        settledAt: "2026-07-23T12:01:00.000Z",
        version: 2,
      }),
    };
    const fetch = vi.fn(async () =>
      Response.json(result, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const client = createWorkRequestClient({ baseUrl, fetch, windowCapability: capability });
    await expect(
      client.execute({
        kind: "resolve-work-request",
        requestId: pending.requestId,
        expectedVersion: pending.version,
        resolution: { kind: "approval", approved: true },
      }),
    ).resolves.toEqual(result);
  });

  it("maps typed request failures", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { code: "unauthorized", message: "Work request is unauthorized." },
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createWorkRequestClient({ baseUrl, fetch, windowCapability: capability });
    await expect(
      client.execute({
        kind: "cancel-work-request",
        requestId: pending.requestId,
        expectedVersion: pending.version,
      }),
    ).rejects.toMatchObject({
      name: "WorkRequestClientFailure",
      code: "unauthorized",
    } satisfies Partial<WorkRequestClientFailure>);
  });
});
