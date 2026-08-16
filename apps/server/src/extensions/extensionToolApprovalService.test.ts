import { describe, expect, it, vi } from "vitest";
import { ExtensionToolApprovalService } from "./extensionToolApprovalService";

const windowId = "44000000-0000-4000-8000-000000000001" as never;
const threadId = "44000000-0000-4000-8000-000000000002" as never;

function request(service: ExtensionToolApprovalService, signal?: AbortSignal) {
  return service.request({
    windowId,
    threadId,
    packageId: "44000000-0000-4000-8000-000000000003" as never,
    componentId: "server" as never,
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
