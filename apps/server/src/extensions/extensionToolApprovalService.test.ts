import { describe, expect, it, vi } from "vitest";
import { isRoutineHostScope, ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import type { WindowId } from "@octant/contracts";
import {
  ExtensionToolApprovalService,
  MAX_PENDING_APPROVALS,
  type ExtensionToolApprovalAnswerer,
} from "./extensionToolApprovalService";

const windowId = "44000000-0000-4000-8000-000000000001" as never;
const threadId = "44000000-0000-4000-8000-000000000002" as never;
const projectId = "44000000-0000-4000-8000-000000000007";

function atWindow(scopeId: WindowId): ExtensionToolApprovalAnswerer {
  return { kind: "local-window", scopeId };
}

function atDevice(scopeId: WindowId): ExtensionToolApprovalAnswerer {
  return { kind: "remote-device", scopeId };
}

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
    expect(service.list(atWindow(windowId))).toEqual([
      expect.objectContaining({
        approvalId: "44000000-0000-4000-8000-000000000004",
        threadId,
        providerToolName: "plugin__server__read",
        mcpToolName: "read",
        inputJson: '{"path":"README.md"}',
      }),
    ]);

    expect(
      service.decide(atWindow("44000000-0000-4000-8000-000000000009" as never), {
        approvalId: "44000000-0000-4000-8000-000000000004",
        decision: "approved",
      }),
    ).toBe(false);
    expect(
      service.decide(atWindow(windowId), {
        approvalId: "44000000-0000-4000-8000-000000000004",
        decision: "approved",
      }),
    ).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(service.list(atWindow(windowId))).toEqual([]);
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

    expect(service.list(atWindow(windowId))).toHaveLength(1);
    expect(service.list(atWindow(otherProjectWindow))).toEqual([]);
    const decision = {
      approvalId: "44000000-0000-4000-8000-000000000005",
      decision: "approved" as const,
    };
    expect(service.decide(atWindow(otherProjectWindow), decision)).toBe(false);
    expect(service.decide(atWindow(windowId), decision)).toBe(true);
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
    expect(service.list(atWindow(ROUTINE_HOST_SCOPE_ID))).toEqual([]);
    expect(service.list(atWindow("44000000-0000-4000-8000-000000000008" as never))).toEqual([]);
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
    expect(service.list(atWindow(windowId))).toHaveLength(1);
    service.revokeWindow(windowId);
    await expect(revoked).resolves.toBe(false);
    expect(service.list(atWindow(windowId))).toEqual([]);
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
      expect(service.list(atWindow(windowId))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a prompt the clock has passed, though its timer has not fired yet", async () => {
    // A timer fires late behind a busy event loop or across a machine's
    // sleep, so the clock, not the timer, decides when a prompt's time is up.
    let now = Date.parse("2026-08-09T06:00:00.000Z");
    let minted = 0;
    const service = new ExtensionToolApprovalService({
      uuid: () => {
        minted += 1;
        return `44000000-0000-4000-8000-${String(minted).padStart(12, "0")}`;
      },
      now: () => now,
      ttlMs: 1_000,
    });
    const stale = request(service);
    now += 1_000;

    expect(service.list(atWindow(windowId))).toEqual([]);
    await expect(stale).resolves.toBe(false);
    expect(
      service.decide(atWindow(windowId), {
        approvalId: "44000000-0000-4000-8000-000000000001",
        decision: "approved",
      }),
    ).toBe(false);

    const answeredLate = request(service);
    now += 1_000;
    expect(
      service.decide(atWindow(windowId), {
        approvalId: "44000000-0000-4000-8000-000000000002",
        decision: "approved",
      }),
    ).toBe(false);
    await expect(answeredLate).resolves.toBe(false);

    const held = Array.from({ length: MAX_PENDING_APPROVALS }, () => request(service));
    now += 1_000;
    const afterSleep = request(service);
    expect(service.list(atWindow(windowId))).toHaveLength(1);
    await expect(Promise.all(held)).resolves.toEqual(Array(MAX_PENDING_APPROVALS).fill(false));
    service.revokeWindow(windowId);
    await expect(afterSleep).resolves.toBe(false);
  });

  it("denies a tool approval past the waiting cap at once, and frees a slot when one is answered or expires", async () => {
    vi.useFakeTimers();
    const consoleMethods = ["debug", "error", "info", "log", "warn"] as const;
    const spies = consoleMethods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      let minted = 0;
      const service = new ExtensionToolApprovalService({
        uuid: () => {
          minted += 1;
          return `44000000-0000-4000-8000-${String(minted).padStart(12, "0")}`;
        },
        now: () => Date.parse("2026-08-09T06:00:00.000Z"),
        ttlMs: 1_000,
      });
      const earliest = request(service);
      await vi.advanceTimersByTimeAsync(500);
      const rest = Array.from({ length: MAX_PENDING_APPROVALS - 1 }, () => request(service));
      expect(service.list(atWindow(windowId))).toHaveLength(MAX_PENDING_APPROVALS);

      const mintedAtCap = minted;
      let outcome: boolean | "pending" = "pending";
      const overflow = request(service).then((approved) => {
        outcome = approved;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe(false);
      await overflow;
      // No approval id is minted, so the refused call is not stored or recorded.
      expect(minted).toBe(mintedAtCap);
      expect(service.list(atWindow(windowId))).toHaveLength(MAX_PENDING_APPROVALS);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      await expect(earliest).resolves.toBe(false);
      expect(service.list(atWindow(windowId))).toHaveLength(MAX_PENDING_APPROVALS - 1);
      const afterExpiry = request(service);
      expect(service.list(atWindow(windowId))).toHaveLength(MAX_PENDING_APPROVALS);

      const answeredId = `44000000-0000-4000-8000-${String(minted).padStart(12, "0")}`;
      expect(
        service.decide(atWindow(windowId), {
          approvalId: answeredId,
          decision: "denied",
        }),
      ).toBe(true);
      await expect(afterExpiry).resolves.toBe(false);
      expect(service.list(atWindow(windowId))).toHaveLength(MAX_PENDING_APPROVALS - 1);
      const afterAnswer = request(service);
      expect(service.list(atWindow(windowId))).toHaveLength(MAX_PENDING_APPROVALS);

      service.revokeWindow(windowId);
      await expect(afterAnswer).resolves.toBe(false);
      await Promise.all(rest);
    } finally {
      for (const spy of spies) spy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("extension tool approval from a paired device", () => {
  const deviceScope = "44000000-0000-4000-8000-0000000000d1" as WindowId;
  const otherDeviceScope = "44000000-0000-4000-8000-0000000000d2" as WindowId;
  const localWindow = "44000000-0000-4000-8000-0000000000e1" as WindowId;
  const approvalId = "44000000-0000-4000-8000-0000000000f1";

  function pairedService(
    options: {
      readonly threadStands?: () => boolean;
      readonly paired?: (scope: WindowId) => boolean;
      readonly ttlMs?: number;
      readonly now?: () => number;
    } = {},
  ) {
    return new ExtensionToolApprovalService({
      uuid: () => approvalId,
      now: options.now ?? (() => Date.parse("2026-10-15T06:00:00.000Z")),
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      isHostScope: isRoutineHostScope,
      isPairedDeviceScope:
        options.paired ?? ((scope) => [deviceScope, otherDeviceScope].includes(scope)),
      threadAuthorityIsCurrent: (thread, project) =>
        (options.threadStands?.() ?? true) &&
        String(thread) === String(threadId) &&
        project === projectId,
      // Only the local window bound to the prompt's Project reaches the thread.
      windowCanReachThread: (scope, thread, project) =>
        String(scope) === String(localWindow) &&
        String(thread) === String(threadId) &&
        project === projectId,
    });
  }

  function requestFrom(
    service: ExtensionToolApprovalService,
    scope: WindowId,
    remember?: () => boolean,
  ) {
    return service.request({
      windowId: scope,
      threadId,
      projectId,
      extensionId: "44000000-0000-4000-8000-00000000000a",
      packageId: "44000000-0000-4000-8000-000000000003" as never,
      componentId: "server" as never,
      serverName: "server",
      providerToolName: "plugin__server__read",
      mcpToolName: "read",
      inputJson: "{}",
      ...(remember === undefined ? {} : { remember }),
    });
  }

  it("lets a paired device approve its own turn's prompt once, and the call proceeds", async () => {
    const service = pairedService();
    const pending = requestFrom(service, deviceScope);

    expect(service.list(atDevice(deviceScope))).toEqual([
      expect.objectContaining({ approvalId, threadId, rememberable: false }),
    ]);
    expect(service.decide(atDevice(deviceScope), { approvalId, decision: "approved" })).toBe(true);
    await expect(pending).resolves.toBe(true);
  });

  it("lets a paired device deny its own turn's prompt", async () => {
    const service = pairedService();
    const pending = requestFrom(service, deviceScope);
    expect(service.decide(atDevice(deviceScope), { approvalId, decision: "denied" })).toBe(true);
    await expect(pending).resolves.toBe(false);
  });

  it("refuses a paired device's answer that asks to be remembered, and leaves the call waiting", async () => {
    const service = pairedService();
    const remember = vi.fn(() => true);
    const pending = requestFrom(service, deviceScope, remember);

    expect(
      service.decide(atDevice(deviceScope), { approvalId, decision: "approved", remember: true }),
    ).toBe(false);
    expect(remember).not.toHaveBeenCalled();
    expect(service.list(atDevice(deviceScope))).toHaveLength(1);
    expect(service.decide(atDevice(deviceScope), { approvalId, decision: "approved" })).toBe(true);
    await expect(pending).resolves.toBe(true);
  });

  it("refuses a paired device a prompt another device, a local window, or the host raised", async () => {
    const service = pairedService();
    for (const scope of [otherDeviceScope, localWindow, ROUTINE_HOST_SCOPE_ID]) {
      const pending = requestFrom(service, scope);
      expect(service.list(atDevice(deviceScope))).toEqual([]);
      expect(service.decide(atDevice(deviceScope), { approvalId, decision: "approved" })).toBe(
        false,
      );
      service.revokeWindow(scope);
      await expect(pending).resolves.toBe(false);
    }
  });

  it("refuses a paired device its own prompt once the thread no longer stands in the Project", async () => {
    let stands = true;
    const service = pairedService({ threadStands: () => stands });
    const pending = requestFrom(service, deviceScope);
    stands = false;

    expect(service.list(atDevice(deviceScope))).toEqual([]);
    expect(service.decide(atDevice(deviceScope), { approvalId, decision: "approved" })).toBe(false);
    service.revokeWindow(deviceScope);
    await expect(pending).resolves.toBe(false);
  });

  it("lets a local window that may drive the thread answer a paired device's prompt, once only", async () => {
    const service = pairedService();
    const remember = vi.fn(() => true);
    const pending = requestFrom(service, deviceScope, remember);
    const elsewhere = "44000000-0000-4000-8000-0000000000e2" as WindowId;

    expect(service.list(atWindow(elsewhere))).toEqual([]);
    expect(service.decide(atWindow(elsewhere), { approvalId, decision: "approved" })).toBe(false);
    expect(service.list(atWindow(localWindow))).toHaveLength(1);
    expect(
      service.decide(atWindow(localWindow), { approvalId, decision: "approved", remember: true }),
    ).toBe(false);
    expect(remember).not.toHaveBeenCalled();
    expect(service.decide(atWindow(localWindow), { approvalId, decision: "approved" })).toBe(true);
    await expect(pending).resolves.toBe(true);
  });

  it("keeps a revoked device's prompt from a local window", async () => {
    const service = pairedService({ paired: () => false });
    const pending = requestFrom(service, deviceScope);
    expect(service.list(atWindow(localWindow))).toEqual([]);
    service.revokeWindow(deviceScope);
    await expect(pending).resolves.toBe(false);
  });

  it("denies a paired device's prompt that nobody answers in time", async () => {
    vi.useFakeTimers();
    try {
      const service = pairedService({ ttlMs: 1_000, now: Date.now });
      const pending = requestFrom(service, deviceScope);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toBe(false);
      expect(service.list(atDevice(deviceScope))).toEqual([]);
      expect(service.decide(atDevice(deviceScope), { approvalId, decision: "approved" })).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
