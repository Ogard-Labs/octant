import { describe, expect, it } from "vitest";
import { BrowserToolApprovalService } from "./browserToolApprovalService";

const windowId = "10000000-0000-4000-8000-000000000001" as never;
const authority = {
  hostId: "20000000-0000-4000-8000-000000000001",
  mode: "chat",
  providerInstanceId: "30000000-0000-4000-8000-000000000001",
  extension: { kind: "core" },
} as never;

describe("BrowserToolApprovalService", () => {
  it("binds one approval to its requesting window and exact origin", async () => {
    const service = new BrowserToolApprovalService({
      uuid: () => "40000000-0000-4000-8000-000000000001",
      now: () => Date.parse("2026-09-09T10:00:00.000Z"),
      authorityIsCurrent: () => true,
    });
    const pending = service.request({
      windowId,
      threadId: "50000000-0000-4000-8000-000000000001",
      authority,
      origin: "https://example.com",
    });
    expect(service.list(windowId)).toEqual([
      expect.objectContaining({
        approvalId: "40000000-0000-4000-8000-000000000001",
        threadId: "50000000-0000-4000-8000-000000000001",
        mode: "chat",
        origin: "https://example.com",
      }),
    ]);
    expect(
      service.decide("60000000-0000-4000-8000-000000000001" as never, {
        approvalId: "40000000-0000-4000-8000-000000000001" as never,
        decision: "approved",
      }),
    ).toBe(false);
    expect(
      service.decide(windowId, {
        approvalId: "40000000-0000-4000-8000-000000000001" as never,
        decision: "approved",
      }),
    ).toBe(true);
    await expect(pending).resolves.toBe("approved");
    expect(service.list(windowId)).toEqual([]);
  });

  it("cancels pending approvals on abort and window revocation", async () => {
    const service = new BrowserToolApprovalService({
      uuid: () => crypto.randomUUID(),
      now: Date.now,
      authorityIsCurrent: () => true,
    });
    const controller = new AbortController();
    const cancelled = service.request({
      windowId,
      threadId: "50000000-0000-4000-8000-000000000001",
      authority,
      origin: "https://example.com",
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).resolves.toBe("cancelled");
    const revoked = service.request({
      windowId,
      threadId: "50000000-0000-4000-8000-000000000001",
      authority,
      origin: "https://example.com",
    });
    service.revokeWindow(windowId);
    await expect(revoked).resolves.toBe("cancelled");
  });

  it("expires an approval at decision time even when its timer has not fired", async () => {
    let now = Date.parse("2026-09-09T10:00:00.000Z");
    const service = new BrowserToolApprovalService({
      uuid: () => "40000000-0000-4000-8000-000000000005",
      now: () => now,
      ttlMs: 1_000,
      authorityIsCurrent: () => true,
    });
    const pending = service.request({
      windowId,
      threadId: "50000000-0000-4000-8000-000000000001",
      authority,
      origin: "https://example.com",
    });
    now += 1_001;
    expect(
      service.decide(windowId, {
        approvalId: "40000000-0000-4000-8000-000000000005" as never,
        decision: "approved",
      }),
    ).toBe(false);
    await expect(pending).resolves.toBe("expired");
  });
});
