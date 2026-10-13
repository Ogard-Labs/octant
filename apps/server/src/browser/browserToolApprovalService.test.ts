import { describe, expect, it } from "vitest";
import { isRoutineHostScope, ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
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

  it("a browser approval from a routine's Work turn reaches an open local window", async () => {
    const otherProjectWindow = "60000000-0000-4000-8000-000000000002" as never;
    const remembered: Array<unknown> = [];
    const service = new BrowserToolApprovalService({
      uuid: () => "40000000-0000-4000-8000-000000000002",
      now: () => Date.parse("2026-09-09T10:00:00.000Z"),
      // The routine's thread lives in the Project the open window is bound to;
      // the host scope runs the thread; another Project's window cannot see it.
      authorityIsCurrent: (_threadId, _authority, scope) =>
        String(scope) === String(windowId) || isRoutineHostScope(scope),
      rememberOrigin: (origin, scope) => remembered.push([origin, scope]),
      isHostScope: isRoutineHostScope,
    });
    const pending = service.request({
      windowId: ROUTINE_HOST_SCOPE_ID,
      threadId: "50000000-0000-4000-8000-000000000002",
      authority,
      origin: "https://example.com",
    });

    expect(service.list(windowId)).toEqual([
      expect.objectContaining({ approvalId: "40000000-0000-4000-8000-000000000002" }),
    ]);
    expect(service.list(otherProjectWindow)).toEqual([]);
    const decision = {
      approvalId: "40000000-0000-4000-8000-000000000002" as never,
      decision: "approved" as const,
      remember: true,
    };
    expect(service.decide(otherProjectWindow, decision)).toBe(false);
    expect(service.decide(windowId, decision)).toBe(true);
    await expect(pending).resolves.toBe("approved");
    expect(remembered).toEqual([["https://example.com", windowId]]);
  });

  it("keeps a window's own approval from every other window, the host scope included", () => {
    const service = new BrowserToolApprovalService({
      uuid: () => "40000000-0000-4000-8000-000000000003",
      now: () => Date.parse("2026-09-09T10:00:00.000Z"),
      authorityIsCurrent: () => true,
      isHostScope: isRoutineHostScope,
    });
    void service.request({
      windowId,
      threadId: "50000000-0000-4000-8000-000000000001",
      authority,
      origin: "https://example.com",
    });
    expect(service.list(ROUTINE_HOST_SCOPE_ID)).toEqual([]);
    expect(service.list("60000000-0000-4000-8000-000000000002" as never)).toEqual([]);
    service.close();
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

  it("denies a pending approval when its window loses Project scope", async () => {
    let scopeAvailable = true;
    const service = new BrowserToolApprovalService({
      uuid: () => "40000000-0000-4000-8000-000000000004",
      now: () => Date.parse("2026-09-09T10:00:00.000Z"),
      authorityIsCurrent: (_threadId, _authority, candidateWindowId) =>
        scopeAvailable && candidateWindowId === windowId,
    });
    const pending = service.request({
      windowId,
      threadId: "50000000-0000-4000-8000-000000000001",
      authority,
      origin: "https://example.com",
    });
    scopeAvailable = false;
    expect(
      service.decide(windowId, {
        approvalId: "40000000-0000-4000-8000-000000000004" as never,
        decision: "approved",
      }),
    ).toBe(false);
    await expect(pending).resolves.toBe("denied");
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

  it("remembers an origin only when an approved answer asks to", async () => {
    const remembered: Array<{ origin: string; window: string }> = [];
    const service = new BrowserToolApprovalService({
      uuid: () => crypto.randomUUID(),
      now: Date.now,
      authorityIsCurrent: () => true,
      rememberOrigin: (origin, rememberedWindowId) =>
        remembered.push({ origin, window: rememberedWindowId }),
      isOriginRemembered: (origin) => remembered.some((entry) => entry.origin === origin),
    });
    const first = service.request({
      windowId,
      threadId: "50000000-0000-4000-8000-000000000001",
      authority,
      origin: "https://example.com",
    });
    service.decide(windowId, {
      approvalId: service.list(windowId)[0]?.approvalId as never,
      decision: "approved",
      remember: true,
    });
    await expect(first).resolves.toBe("approved");
    expect(remembered).toEqual([{ origin: "https://example.com", window: windowId }]);
    expect(service.isRemembered("https://example.com")).toBe(true);
    expect(service.isRemembered("https://other.example")).toBe(false);

    const second = service.request({
      windowId,
      threadId: "50000000-0000-4000-8000-000000000001",
      authority,
      origin: "https://second.example",
    });
    service.decide(windowId, {
      approvalId: service.list(windowId)[0]?.approvalId as never,
      decision: "denied",
      remember: true,
    });
    await expect(second).resolves.toBe("denied");
    expect(remembered).toHaveLength(1);
  });
});
