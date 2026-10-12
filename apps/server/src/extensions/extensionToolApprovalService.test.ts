import { describe, expect, it, vi } from "vitest";
import { isRoutineHostScope, ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import { ExtensionToolApprovalService } from "./extensionToolApprovalService";

const windowId = "44000000-0000-4000-8000-000000000001" as never;
const threadId = "44000000-0000-4000-8000-000000000002" as never;
const projectId = "44000000-0000-4000-8000-000000000007";

function request(service: ExtensionToolApprovalService, signal?: AbortSignal) {
  return service.request({
    windowId,
    threadId,
    extensionId: "44000000-0000-4000-8000-00000000000a",
    packageId: "44000000-0000-4000-8000-000000000003" as never,
    componentId: "server" as never,
    serverName: "server",
    providerToolName: "plugin__server__read",
    mcpToolName: "read",
    inputJson: '{"path":"README.md"}',
    ...(signal === undefined ? {} : { signal }),
  });
}

describe("extension tool approval service", () => {
  it("binds a one-time decision to the requesting window and exact pending request", async () => {
    const service = new ExtensionToolApprovalService({
      uuid: () => "44000000-0000-4000-8000-000000000004",
      now: () => Date.parse("2026-08-09T06:00:00.000Z"),
    });
    const pending = request(service);
    expect(service.list(windowId)).toEqual([
      expect.objectContaining({
        approvalId: "44000000-0000-4000-8000-000000000004",
        threadId,
        providerToolName: "plugin__server__read",
        mcpToolName: "read",
        inputJson: '{"path":"README.md"}',
      }),
    ]);

    expect(
      service.decide("44000000-0000-4000-8000-000000000009" as never, {
        approvalId: "44000000-0000-4000-8000-000000000004",
        decision: "approved",
      }),
    ).toBe(false);
    expect(
      service.decide(windowId, {
        approvalId: "44000000-0000-4000-8000-000000000004",
        decision: "approved",
      }),
    ).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(service.list(windowId)).toEqual([]);
  });

  it("offers a host-resumed turn's extension approval to a window bound to its Project", async () => {
    const otherProjectWindow = "44000000-0000-4000-8000-000000000008" as never;
    const service = new ExtensionToolApprovalService({
      uuid: () => "44000000-0000-4000-8000-000000000005",
      now: () => Date.parse("2026-08-09T06:00:00.000Z"),
      isHostScope: isRoutineHostScope,
      // Only a window bound to the Project the prompt recorded reaches it.
      windowCanReachThread: (scope, thread, project) =>
        String(scope) === String(windowId) &&
        String(thread) === String(threadId) &&
        project === projectId,
    });
    const pending = service.request({
      windowId: ROUTINE_HOST_SCOPE_ID,
      threadId,
      projectId,
      extensionId: "44000000-0000-4000-8000-00000000000a",
      packageId: "44000000-0000-4000-8000-000000000003" as never,
      componentId: "server" as never,
      serverName: "server",
      providerToolName: "plugin__server__read",
      mcpToolName: "read",
      inputJson: "{}",
    });

    expect(service.list(windowId)).toHaveLength(1);
    expect(service.list(otherProjectWindow)).toEqual([]);
    const decision = {
      approvalId: "44000000-0000-4000-8000-000000000005",
      decision: "approved" as const,
    };
    expect(service.decide(otherProjectWindow, decision)).toBe(false);
    expect(service.decide(windowId, decision)).toBe(true);
    await expect(pending).resolves.toBe(true);
  });

  it("keeps a window's own extension approval from the host scope", () => {
    const service = new ExtensionToolApprovalService({
      uuid: () => "44000000-0000-4000-8000-000000000006",
      now: () => Date.parse("2026-08-09T06:00:00.000Z"),
      isHostScope: isRoutineHostScope,
      windowCanReachThread: () => true,
    });
    void request(service);
    expect(service.list(ROUTINE_HOST_SCOPE_ID)).toEqual([]);
    expect(service.list("44000000-0000-4000-8000-000000000008" as never)).toEqual([]);
    service.revokeWindow(windowId);
  });

  it("denies and removes pending requests on caller abort or window revocation", async () => {
    const service = new ExtensionToolApprovalService({
      uuid: () => crypto.randomUUID(),
      now: Date.now,
    });
    const controller = new AbortController();
    const aborted = request(service, controller.signal);
    controller.abort();
    await expect(aborted).resolves.toBe(false);

    const revoked = request(service);
    expect(service.list(windowId)).toHaveLength(1);
    service.revokeWindow(windowId);
    await expect(revoked).resolves.toBe(false);
    expect(service.list(windowId)).toEqual([]);
  });

  it("expires unanswered approval requests", async () => {
    vi.useFakeTimers();
    try {
      const service = new ExtensionToolApprovalService({
        uuid: () => crypto.randomUUID(),
        now: Date.now,
        ttlMs: 1_000,
      });
      const pending = request(service);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toBe(false);
      expect(service.list(windowId)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
