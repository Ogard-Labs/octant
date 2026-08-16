import type {
  ComputerUseActionRequest,
  ComputerUsePolicy,
  EventActor,
  ToolActionAuthority,
  WindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ComputerUseRuntimeError,
  createComputerUseRuntime,
  type ComputerUseEvidenceEvent,
  type ComputerUseNativeAdapter,
} from "./computerUseRuntime";

const ownerWindowId = "10000000-0000-4000-8000-000000000001" as WindowId;
const otherWindowId = "10000000-0000-4000-8000-000000000002" as WindowId;
const threadId = "20000000-0000-4000-8000-000000000001";
const requestedBy = {
  kind: "local-user",
  actorId: "30000000-0000-4000-8000-000000000001",
} as EventActor;
const authority = {
  hostId: "40000000-0000-4000-8000-000000000001",
  mode: "work",
  projectId: "50000000-0000-4000-8000-000000000001",
  rootId: "60000000-0000-4000-8000-000000000001",
  providerInstanceId: "70000000-0000-4000-8000-000000000001",
  extension: { kind: "core" },
} as ToolActionAuthority;
const request = {
  actionId: "80000000-0000-4000-8000-000000000001",
  sessionId: "90000000-0000-4000-8000-000000000001",
  correlationId: "a0000000-0000-4000-8000-000000000001",
  authority,
  kind: "click",
  visibility: "visible",
  target: "AXButton:Continue",
} as ComputerUseActionRequest;
const policy: ComputerUsePolicy = {
  allowlist: [{ actionKind: "click", targetApp: "Preview", requiresApproval: true }],
  sensitiveFieldProtection: true,
  visibleStopControl: true,
  maxSessionDurationMs: 300_000,
  processOwnershipRequired: true,
};

function fixture(options?: {
  readonly observation?: Awaited<ReturnType<ComputerUseNativeAdapter["observe"]>>;
  readonly observe?: ComputerUseNativeAdapter["observe"];
  readonly execute?: ComputerUseNativeAdapter["execute"];
  readonly record?: (event: ComputerUseEvidenceEvent) => void | Promise<void>;
}) {
  let now = Date.parse("2026-07-27T20:00:00.000Z");
  let id = 0;
  const recorded: ComputerUseEvidenceEvent[] = [];
  const adapter: ComputerUseNativeAdapter = {
    observe: vi.fn(
      options?.observe ??
        (async () =>
          Promise.resolve(
            options?.observation ?? {
              targetApp: "Preview",
              windowTitle: "Issue 373 QA",
              reference: "computer-use-observation-1",
            },
          )),
    ),
    execute: vi.fn(
      options?.execute ?? (async () => ({ reference: "computer-use-action-result-1" })),
    ),
    cleanup: vi.fn(async () => true),
  };
  const runtime = createComputerUseRuntime({
    adapter,
    evidence: {
      record: async (event) => {
        await options?.record?.(event);
        recorded.push(event);
      },
    },
    uuid: () => `b0000000-0000-4000-8000-${(++id).toString().padStart(12, "0")}`,
    clock: () => new Date(now).toISOString(),
    approvalTtlMs: 60_000,
  });
  return {
    adapter,
    recorded,
    runtime,
    advance: (milliseconds: number) => (now += milliseconds),
  };
}

describe("ComputerUseRuntime", () => {
  it("executes a representative visible action only after exact one-time approval", async () => {
    const { adapter, advance, recorded, runtime } = fixture();
    const waiting = await runtime.start({
      ownerWindowId,
      threadId,
      requestedBy,
      request,
      policy,
    });

    expect(waiting).toMatchObject({
      sessionId: request.sessionId,
      threadId,
      requestedBy,
      authority,
      state: "waiting-for-approval",
      pendingApproval: { actionId: request.actionId },
    });
    expect(adapter.execute).not.toHaveBeenCalled();

    const completed = await runtime.decide({
      ownerWindowId,
      threadId,
      authority,
      sessionId: request.sessionId,
      actionId: request.actionId,
      approvalId: waiting.pendingApproval!.approvalId,
      decision: "approved",
    });

    expect(completed.state).toBe("completed");
    expect(completed.pendingApproval).toBeUndefined();
    expect(adapter.execute).toHaveBeenCalledOnce();
    expect(recorded.map(({ event }) => event.kind)).toEqual([
      "session-started",
      "observation-recorded",
      "approval-requested",
      "approval-approved",
      "observation-recorded",
      "action-started",
      "action-completed",
      "cleanup-completed",
    ]);

    await expect(
      runtime.decide({
        ownerWindowId,
        threadId,
        authority,
        sessionId: request.sessionId,
        actionId: request.actionId,
        approvalId: waiting.pendingApproval!.approvalId,
        decision: "approved",
      }),
    ).rejects.toMatchObject({ category: "approval-denied" });
    expect(adapter.execute).toHaveBeenCalledOnce();
    expect(runtime.list(ownerWindowId)).toHaveLength(1);
    advance(5 * 60_000 + 1);
    expect(runtime.list(ownerWindowId)).toEqual([]);
  });

  it("rejects expired, mismatched, denied, and cross-client approvals without executing", async () => {
    const { adapter, advance, runtime } = fixture();
    const waiting = await runtime.start({ ownerWindowId, threadId, requestedBy, request, policy });
    const approvalId = waiting.pendingApproval!.approvalId;

    await expect(
      runtime.decide({
        ownerWindowId: otherWindowId,
        threadId,
        authority,
        sessionId: request.sessionId,
        actionId: request.actionId,
        approvalId,
        decision: "approved",
      }),
    ).rejects.toMatchObject({ category: "unauthorized" });
    await expect(
      runtime.decide({
        ownerWindowId,
        threadId: "20000000-0000-4000-8000-000000000099",
        authority,
        sessionId: request.sessionId,
        actionId: request.actionId,
        approvalId,
        decision: "approved",
      }),
    ).rejects.toMatchObject({ category: "unauthorized" });
    advance(60_001);
    await expect(
      runtime.decide({
        ownerWindowId,
        threadId,
        authority,
        sessionId: request.sessionId,
        actionId: request.actionId,
        approvalId,
        decision: "approved",
      }),
    ).rejects.toMatchObject({ category: "approval-denied" });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("fails closed before execution when the host observes a protected field", async () => {
    const { adapter, runtime } = fixture({
      observation: {
        targetApp: "Preview",
        sensitiveFieldKind: "password",
        reference: "redacted-sensitive-field",
      },
    });
    const typingRequest = { ...request, kind: "type-text" as const, value: "not-recorded" };
    const typingPolicy = {
      ...policy,
      allowlist: [
        { actionKind: "type-text" as const, targetApp: "Preview", requiresApproval: false },
      ],
    };

    const view = await runtime.start({
      ownerWindowId,
      threadId,
      requestedBy,
      request: typingRequest,
      policy: typingPolicy,
    });

    expect(view.state).toBe("failed");
    expect(view.events.find(({ kind }) => kind === "session-failed")?.detail).toBe(
      "Sensitive field is protected.",
    );
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("replays lifecycle to the same client and denies another client or authority", async () => {
    const { runtime } = fixture();
    const waiting = await runtime.start({ ownerWindowId, threadId, requestedBy, request, policy });
    expect(
      runtime.inspect({ ownerWindowId, threadId, authority, sessionId: request.sessionId }),
    ).toEqual(waiting);
    expect(
      runtime.inspect({
        ownerWindowId: otherWindowId,
        threadId,
        authority,
        sessionId: request.sessionId,
      }),
    ).toBeUndefined();
    expect(
      runtime.inspect({
        ownerWindowId,
        threadId,
        authority: {
          ...authority,
          providerInstanceId: "70000000-0000-4000-8000-000000000099" as never,
        },
        sessionId: request.sessionId,
      }),
    ).toBeUndefined();
    expect(runtime.list(ownerWindowId)).toEqual([waiting]);
    expect(runtime.list(otherWindowId)).toEqual([]);
  });

  it("stops an in-flight action, aborts only its owned process, and records cleanup", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const execute = vi.fn(async (_request, _observation, signal: AbortSignal) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
      return { reference: "unreachable" };
    });
    const { adapter, runtime } = fixture({ execute });
    const noApprovalPolicy = {
      ...policy,
      allowlist: [{ actionKind: "click" as const, targetApp: "Preview", requiresApproval: false }],
    };
    const starting = runtime.start({
      ownerWindowId,
      threadId,
      requestedBy,
      request,
      policy: noApprovalPolicy,
    });
    await running;

    const stopped = await runtime.stop({
      ownerWindowId,
      threadId,
      authority,
      sessionId: request.sessionId,
    });
    await starting;

    expect(stopped.state).toBe("stopped");
    expect(execute.mock.calls[0]?.[2].aborted).toBe(true);
    expect(adapter.cleanup).toHaveBeenCalledWith(request.sessionId);
  });

  it("records process death as interrupted and never completed", async () => {
    const { runtime } = fixture({
      execute: async () => {
        throw Object.assign(new Error("native helper exited"), { category: "process-died" });
      },
    });
    const view = await runtime.start({
      ownerWindowId,
      threadId,
      requestedBy,
      request,
      policy: {
        ...policy,
        allowlist: [{ actionKind: "click", targetApp: "Preview", requiresApproval: false }],
      },
    });

    expect(view.state).toBe("interrupted");
    expect(view.events.some(({ kind }) => kind === "action-completed")).toBe(false);
    expect(view.events.at(-2)?.kind).toBe("session-interrupted");
  });

  it("re-observes after approval and denies an app switch before the side effect", async () => {
    const observe = vi
      .fn<ComputerUseNativeAdapter["observe"]>()
      .mockResolvedValueOnce({ targetApp: "Preview", reference: "observation-before-approval" })
      .mockResolvedValueOnce({ targetApp: "Safari", reference: "observation-after-approval" });
    const { adapter, runtime } = fixture({ observe });
    const waiting = await runtime.start({ ownerWindowId, threadId, requestedBy, request, policy });
    const result = await runtime.decide({
      ownerWindowId,
      threadId,
      authority,
      sessionId: request.sessionId,
      actionId: request.actionId,
      approvalId: waiting.pendingApproval!.approvalId,
      decision: "approved",
    });

    expect(result.state).toBe("failed");
    expect(adapter.observe).toHaveBeenCalledTimes(2);
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(result.events.find(({ kind }) => kind === "session-failed")?.detail).toContain(
      "changed after approval",
    );
  });

  it("does not execute and cleans up when authoritative evidence recording fails", async () => {
    const { adapter, runtime } = fixture({
      record: async ({ event }) => {
        if (event.kind === "action-started") throw new Error("journal unavailable");
      },
    });
    const result = await runtime.start({
      ownerWindowId,
      threadId,
      requestedBy,
      request,
      policy: {
        ...policy,
        allowlist: [{ actionKind: "click", targetApp: "Preview", requiresApproval: false }],
      },
    });

    expect(result.state).toBe("failed");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(adapter.cleanup).toHaveBeenCalledWith(request.sessionId);
  });

  it("revokes pending approvals and interrupts only sessions owned by the rotated window", async () => {
    const { adapter, runtime } = fixture();
    await runtime.start({ ownerWindowId, threadId, requestedBy, request, policy });
    await runtime.revokeWindow(ownerWindowId);

    const revoked = runtime.inspect({
      ownerWindowId,
      threadId,
      authority,
      sessionId: request.sessionId,
    });
    expect(revoked?.state).toBe("interrupted");
    expect(revoked?.pendingApproval).toBeUndefined();
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(adapter.cleanup).toHaveBeenCalledWith(request.sessionId);
  });

  it("expires a running session at its policy duration and aborts the owned action", async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const execute = vi.fn(async (_request, _observation, signal: AbortSignal) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
      return { reference: "unreachable" };
    });
    const { runtime } = fixture({ execute });
    const starting = runtime.start({
      ownerWindowId,
      threadId,
      requestedBy,
      request,
      policy: {
        ...policy,
        maxSessionDurationMs: 20,
        allowlist: [{ actionKind: "click", targetApp: "Preview", requiresApproval: false }],
      },
    });
    await running;
    try {
      await vi.advanceTimersByTimeAsync(21);
      const result = await starting;
      expect(result.state).toBe("interrupted");
      expect(execute.mock.calls[0]?.[2].aborted).toBe(true);
      expect(result.events.find(({ kind }) => kind === "session-interrupted")?.detail).toBe(
        "Computer-use session duration expired.",
      );
    } finally {
      await runtime.stop({ ownerWindowId, threadId, authority, sessionId: request.sessionId });
      vi.useRealTimers();
    }
  });

  it("lets expiry win while approval evidence is still being persisted", async () => {
    vi.useFakeTimers();
    let approvalStarted!: () => void;
    let releaseApproval!: () => void;
    const started = new Promise<void>((resolve) => (approvalStarted = resolve));
    const blocked = new Promise<void>((resolve) => (releaseApproval = resolve));
    const { adapter, runtime } = fixture({
      record: async ({ event }) => {
        if (event.kind !== "approval-approved") return;
        approvalStarted();
        await blocked;
      },
    });
    const expiringPolicy = { ...policy, maxSessionDurationMs: 20 };
    const waiting = await runtime.start({
      ownerWindowId,
      threadId,
      requestedBy,
      request,
      policy: expiringPolicy,
    });
    const deciding = runtime.decide({
      ownerWindowId,
      threadId,
      authority,
      sessionId: request.sessionId,
      actionId: request.actionId,
      approvalId: waiting.pendingApproval!.approvalId,
      decision: "approved",
    });
    await started;
    try {
      await vi.advanceTimersByTimeAsync(21);
      releaseApproval();
      const result = await deciding;
      expect(result.state).toBe("interrupted");
      expect(adapter.execute).not.toHaveBeenCalled();
    } finally {
      releaseApproval();
      await runtime.stop({ ownerWindowId, threadId, authority, sessionId: request.sessionId });
      vi.useRealTimers();
    }
  });

  it("uses typed fail-closed errors", () => {
    expect(new ComputerUseRuntimeError("unauthorized", "no")).toMatchObject({
      name: "ComputerUseRuntimeError",
      category: "unauthorized",
    });
  });
});
