import { describe, expect, it } from "vitest";
import {
  evaluateComputerUseAction,
  isSessionExpired,
  canRecordComputerUseObservation,
  isSensitiveFieldProtectionEnabled,
  requiresVisibleStop,
  requiresProcessOwnership,
} from "./computerUsePolicy";
import type {
  ComputerUseActionRequest,
  ComputerUseObservation,
  ComputerUseSessionRecord,
  ToolActionAuthority,
} from "@octant/contracts";

const authority: ToolActionAuthority = {
  hostId: "00000000-0000-4000-8000-000000000004" as any,
  mode: "work",
  projectId: "00000000-0000-4000-8000-000000000005" as any,
  providerInstanceId: "00000000-0000-4000-8000-000000000006" as any,
  extension: { kind: "core" },
};

const activeSession: ComputerUseSessionRecord = {
  sessionId: "00000000-0000-4000-8000-000000000001" as any,
  actionId: "00000000-0000-4000-8000-000000000002" as any,
  correlationId: "00000000-0000-4000-8000-000000000003" as any,
  authority,
  policy: {
    allowlist: [
      { actionKind: "click", requiresApproval: false },
      { actionKind: "screenshot", requiresApproval: false },
      { actionKind: "type-text", requiresApproval: true },
    ],
    sensitiveFieldProtection: true,
    visibleStopControl: true,
    maxSessionDurationMs: 300_000,
    processOwnershipRequired: true,
  },
  state: "active",
  approvalId: "00000000-0000-4000-8000-000000000010" as any,
  createdAt: "2026-07-24T12:00:00.000Z" as any,
};

function makeRequest(overrides?: Partial<ComputerUseActionRequest>): ComputerUseActionRequest {
  return {
    actionId: "00000000-0000-4000-8000-000000000002" as any,
    sessionId: "00000000-0000-4000-8000-000000000001" as any,
    correlationId: "00000000-0000-4000-8000-000000000003" as any,
    authority,
    kind: "click",
    visibility: "visible",
    ...overrides,
  };
}

describe("evaluateComputerUseAction", () => {
  it("allows matching authority and active session", () => {
    expect(evaluateComputerUseAction(makeRequest(), activeSession, authority).kind).toBe("allowed");
  });

  it("denies mismatched authority", () => {
    const other: ToolActionAuthority = { ...authority, mode: "code" };
    expect(evaluateComputerUseAction(makeRequest(), activeSession, other).kind).toBe("denied");
  });

  it("denies an action or correlation that does not match the session", () => {
    expect(
      evaluateComputerUseAction(
        makeRequest({ actionId: "00000000-0000-4000-8000-000000000099" as any }),
        activeSession,
        authority,
      ),
    ).toEqual({ kind: "denied", reason: "Action identity does not match the session." });
    expect(
      evaluateComputerUseAction(
        makeRequest({ correlationId: "00000000-0000-4000-8000-000000000099" as any }),
        activeSession,
        authority,
      ),
    ).toEqual({ kind: "denied", reason: "Action correlation does not match the session." });
  });

  it("denies hidden background actions", () => {
    expect(
      evaluateComputerUseAction(
        makeRequest({ visibility: "background" }),
        activeSession,
        authority,
      ),
    ).toEqual({ kind: "denied", reason: "Computer-use actions must remain visible." });
  });

  it("enforces an app-specific allowlist entry", () => {
    const appScoped = {
      ...activeSession,
      policy: {
        ...activeSession.policy,
        allowlist: [
          { actionKind: "click" as const, targetApp: "Preview", requiresApproval: false },
        ],
      },
    };
    expect(
      evaluateComputerUseAction(
        makeRequest({ target: "Safari::AXButton:Continue" }),
        appScoped,
        authority,
        "Safari",
      ),
    ).toEqual({ kind: "denied", reason: "Target app 'Safari' is not allowlisted for 'click'." });
    expect(
      evaluateComputerUseAction(
        makeRequest({ target: "Preview::AXButton:Continue" }),
        appScoped,
        authority,
        "Preview",
      ).kind,
    ).toBe("allowed");
  });

  it("denies stopped session", () => {
    const stopped = { ...activeSession, state: "stopped" as const };
    expect(evaluateComputerUseAction(makeRequest(), stopped, authority).kind).toBe("denied");
  });

  it("denies action not in allowlist", () => {
    expect(
      evaluateComputerUseAction(makeRequest({ kind: "drag" }), activeSession, authority).kind,
    ).toBe("denied");
  });

  it("denies approval-required action without approval", () => {
    const noApproval = { ...activeSession, approvalId: undefined };
    expect(
      evaluateComputerUseAction(makeRequest({ kind: "type-text" }), noApproval, authority).kind,
    ).toBe("denied");
  });

  it("allows approval-required action with approval", () => {
    expect(
      evaluateComputerUseAction(makeRequest({ kind: "type-text" }), activeSession, authority).kind,
    ).toBe("allowed");
  });
});

describe("isSessionExpired", () => {
  it("returns false within timeout", () => {
    const createdAt = new Date("2026-07-24T12:00:00.000Z").getTime();
    expect(isSessionExpired(activeSession, createdAt + 60_000)).toBe(false);
  });

  it("returns true after timeout", () => {
    const createdAt = new Date("2026-07-24T12:00:00.000Z").getTime();
    expect(isSessionExpired(activeSession, createdAt + 300_001)).toBe(true);
  });

  it("returns false for stopped session", () => {
    expect(isSessionExpired({ ...activeSession, state: "stopped" as const }, Date.now())).toBe(
      false,
    );
  });
});

describe("canRecordComputerUseObservation", () => {
  it("returns true for matching observation", () => {
    const obs: ComputerUseObservation = {
      sessionId: activeSession.sessionId,
      actionId: activeSession.actionId,
      correlationId: activeSession.correlationId,
      authority,
      observedAt: "2026-07-24T12:01:00.000Z" as any,
      stale: false,
    };
    expect(canRecordComputerUseObservation(obs, activeSession)).toBe(true);
  });

  it("returns false for mismatched session", () => {
    const obs: ComputerUseObservation = {
      sessionId: "00000000-0000-4000-8000-000000000099" as any,
      actionId: activeSession.actionId,
      correlationId: activeSession.correlationId,
      authority,
      observedAt: "2026-07-24T12:01:00.000Z" as any,
      stale: false,
    };
    expect(canRecordComputerUseObservation(obs, activeSession)).toBe(false);
  });
});

describe("isSensitiveFieldProtectionEnabled", () => {
  it("returns true when policy enables protection", () => {
    expect(isSensitiveFieldProtectionEnabled(activeSession, "password")).toBe(true);
  });

  it("returns false when policy disables protection", () => {
    const noProtection = {
      ...activeSession,
      policy: { ...activeSession.policy, sensitiveFieldProtection: false },
    };
    expect(isSensitiveFieldProtectionEnabled(noProtection, "password")).toBe(false);
  });
});

describe("requiresVisibleStop", () => {
  it("returns true when policy requires it", () => {
    expect(requiresVisibleStop(activeSession)).toBe(true);
  });
});

describe("requiresProcessOwnership", () => {
  it("returns true when policy requires it", () => {
    expect(requiresProcessOwnership(activeSession)).toBe(true);
  });
});
