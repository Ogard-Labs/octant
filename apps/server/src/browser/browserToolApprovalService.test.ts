import { describe, expect, it, vi } from "vitest";
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

  it("reports a new prompt and every way it leaves the waiting list", async () => {
    vi.useFakeTimers();
    try {
      const lists: Array<number> = [];
      const service = new BrowserToolApprovalService({
        uuid: () => crypto.randomUUID(),
        now: Date.now,
        ttlMs: 1_000,
        authorityIsCurrent: () => true,
        onChanged: () => lists.push(service.list(windowId).length),
      });
      const ask = (origin: string, signal?: AbortSignal) =>
        service.request({
          windowId,
          threadId,
          authority,
          origin,
          ...(signal === undefined ? {} : { signal }),
        });
      const controller = new AbortController();
      const threadId = "50000000-0000-4000-8000-000000000001";
      const first = ask("https://one.example");
      expect(lists).toEqual([1]);
      service.decide(windowId, {
        approvalId: service.list(windowId)[0]?.approvalId as never,
        decision: "approved",
      });
      await expect(first).resolves.toBe("approved");
      expect(lists).toEqual([1, 0]);

      const second = ask("https://two.example", controller.signal);
      controller.abort();
      await expect(second).resolves.toBe("cancelled");
      expect(lists).toEqual([1, 0, 1, 0]);

      const third = ask("https://three.example");
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(third).resolves.toBe("expired");
      expect(lists).toEqual([1, 0, 1, 0, 1, 0]);

      const fourth = ask("https://four.example");
      service.revokeWindow(windowId);
      await expect(fourth).resolves.toBe("cancelled");
      expect(lists).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);

      const fifth = ask("https://five.example");
      service.close();
      await expect(fifth).resolves.toBe("cancelled");
      expect(lists).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    } finally {
      vi.useRealTimers();
    }
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

describe("BrowserToolApprovalService for signed-in pages", () => {
  const threadId = "50000000-0000-4000-8000-000000000001";
  const personal = { kind: "personal" } as const;

  type Remember = (origin: string, windowId: never, profile: unknown) => void;
  function service(rememberOrigin: Remember, remembered: Array<string> = []) {
    return new BrowserToolApprovalService({
      uuid: () => "40000000-0000-4000-8000-000000000001",
      now: () => Date.parse("2026-10-31T10:00:00.000Z"),
      authorityIsCurrent: () => true,
      rememberOrigin: rememberOrigin as never,
      isOriginRemembered: (origin, profile) =>
        remembered.includes(`${origin}|${profile?.kind ?? "private"}`),
      isHostScope: isRoutineHostScope,
    });
  }

  it("names the profile in the prompt the person sees", async () => {
    const approvals = service(vi.fn<Remember>());
    void approvals.request({
      windowId,
      threadId,
      authority,
      origin: "https://github.com",
      profile: personal,
    });

    expect(approvals.list(windowId)).toEqual([
      expect.objectContaining({ origin: "https://github.com", profile: personal }),
    ]);
  });

  it("remembers the pair on Always allow and tells the grant which profile it covers", async () => {
    const rememberOrigin = vi.fn<Remember>();
    const approvals = service(rememberOrigin);
    const pending = approvals.request({
      windowId,
      threadId,
      authority,
      origin: "https://github.com",
      profile: personal,
    });

    approvals.decide(windowId, {
      approvalId: approvals.list(windowId)[0]?.approvalId as never,
      decision: "approved",
      remember: true,
    });

    await expect(pending).resolves.toBe("approved");
    expect(rememberOrigin).toHaveBeenCalledWith("https://github.com", windowId, personal);
  });

  it("does not remember anything for approve once", async () => {
    const rememberOrigin = vi.fn<Remember>();
    const approvals = service(rememberOrigin);
    void approvals.request({
      windowId,
      threadId,
      authority,
      origin: "https://github.com",
      profile: personal,
    });

    approvals.decide(windowId, {
      approvalId: approvals.list(windowId)[0]?.approvalId as never,
      decision: "approved",
    });

    expect(rememberOrigin).not.toHaveBeenCalled();
  });

  it("answers isRemembered for the exact pair only", () => {
    const approvals = service(vi.fn<Remember>(), [
      "https://github.com|personal",
      "https://example.com|private",
    ]);

    expect(approvals.isRemembered("https://github.com", personal)).toBe(true);
    expect(approvals.isRemembered("https://github.com")).toBe(false);
    expect(approvals.isRemembered("https://example.com", personal)).toBe(false);
    expect(approvals.isRemembered("https://example.com")).toBe(true);
  });

  it("knows the routine host scope is unattended and a window is not", () => {
    const approvals = service(vi.fn<Remember>());

    expect(approvals.isUnattendedScope(ROUTINE_HOST_SCOPE_ID)).toBe(true);
    expect(approvals.isUnattendedScope(windowId)).toBe(false);
  });
});
