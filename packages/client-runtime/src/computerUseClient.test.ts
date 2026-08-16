import type {
  ComputerUseApprovalDecisionRequest,
  ComputerUseSessionScope,
} from "@octant/contracts/computer-use";
import { describe, expect, it, vi } from "vitest";
import { createComputerUseClient } from "./computerUseClient";

const scope = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  threadId: "20000000-0000-4000-8000-000000000001",
  authority: {
    hostId: "30000000-0000-4000-8000-000000000001",
    mode: "work",
    projectId: "40000000-0000-4000-8000-000000000001",
    rootId: "50000000-0000-4000-8000-000000000001",
    providerInstanceId: "60000000-0000-4000-8000-000000000001",
    extension: { kind: "core" },
  },
} as ComputerUseSessionScope;
const view = {
  ...scope,
  requestedBy: { kind: "local-user", actorId: "70000000-0000-4000-8000-000000000001" },
  state: "waiting-for-approval",
  sequence: 1,
  pendingApproval: {
    approvalId: "80000000-0000-4000-8000-000000000001",
    actionId: "90000000-0000-4000-8000-000000000001",
    expiresAt: "2026-07-27T21:01:00.000Z",
    summary: "click in Preview",
  },
  events: [
    {
      sequence: 1,
      kind: "approval-requested",
      occurredAt: "2026-07-27T21:00:00.000Z",
      detail: "One-time approval is required.",
    },
  ],
} as const;

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("computerUseClient", () => {
  it("uses one authenticated transport for inspect, approval, and stop", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, _init) =>
      response(new URL(String(input)).pathname.endsWith("/sessions") ? [view] : view),
    );
    const client = createComputerUseClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: "window-capability",
    });
    const decision = {
      ...scope,
      actionId: view.pendingApproval.actionId,
      approvalId: view.pendingApproval.approvalId,
      decision: "approved",
    } as ComputerUseApprovalDecisionRequest;

    await expect(client.list()).resolves.toEqual([view]);
    await expect(client.inspect(scope)).resolves.toEqual(view);
    await expect(client.decide(decision)).resolves.toEqual(view);
    await expect(client.stop(scope)).resolves.toEqual(view);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/computer-use/sessions",
      "/api/computer-use/inspect",
      "/api/computer-use/approvals",
      "/api/computer-use/stop",
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({
        method: "POST",
        headers: { "x-octant-window-capability": "window-capability" },
      });
    }
  });

  it("preserves denial and interruption categories", async () => {
    const denied = createComputerUseClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () =>
        response({ category: "approval-denied", message: "Approval expired." }, 403),
      ),
      windowCapability: "window-capability",
    });
    await expect(denied.inspect(scope)).rejects.toMatchObject({ category: "approval-denied" });

    const controller = new AbortController();
    controller.abort();
    const interrupted = createComputerUseClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () => {
        throw new DOMException("Aborted", "AbortError");
      }),
      windowCapability: "window-capability",
    });
    await expect(interrupted.inspect(scope, controller.signal)).rejects.toMatchObject({
      category: "interrupted",
    });
  });

  it("fails protocol-closed for invalid success payloads", async () => {
    const client = createComputerUseClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () => response({ ...view, threadId: "other-thread" })),
      windowCapability: "window-capability",
    });
    await expect(client.inspect(scope)).rejects.toMatchObject({ category: "protocol" });
  });
});
