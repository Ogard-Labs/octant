import { describe, expect, it } from "vitest";
import {
  decodeComputerUsePolicy,
  decodeComputerUseSessionRecord,
  decodeComputerUseActionRequest,
  decodeComputerUseObservation,
  decodeComputerUseFailure,
  decodeComputerUseActionKind,
  decodeComputerUseSessionState,
  decodeComputerUseApprovalState,
  decodeComputerUseSensitiveFieldKind,
} from "./computerUse";

describe("ComputerUseActionKind", () => {
  it("accepts all valid kinds", () => {
    for (const kind of [
      "click",
      "type-text",
      "key-press",
      "scroll",
      "screenshot",
      "observe-window",
      "move-cursor",
      "drag",
    ] as const) {
      expect(decodeComputerUseActionKind(kind)).toBe(kind);
    }
  });
  it("rejects unknown kinds", () => {
    expect(() => decodeComputerUseActionKind("teleport")).toThrow();
  });
});

describe("ComputerUsePolicy", () => {
  it("decodes a valid policy", () => {
    const policy = decodeComputerUsePolicy({
      allowlist: [{ actionKind: "click", requiresApproval: true }],
      sensitiveFieldProtection: true,
      visibleStopControl: true,
      maxSessionDurationMs: 300_000,
      processOwnershipRequired: true,
    });
    expect(policy.allowlist).toHaveLength(1);
    expect(policy.sensitiveFieldProtection).toBe(true);
  });
  it("rejects zero maxSessionDurationMs", () => {
    expect(() =>
      decodeComputerUsePolicy({
        allowlist: [],
        sensitiveFieldProtection: true,
        visibleStopControl: true,
        maxSessionDurationMs: 0,
        processOwnershipRequired: true,
      }),
    ).toThrow();
  });
});

describe("ComputerUseSessionState", () => {
  it("accepts all valid states", () => {
    for (const state of [
      "requesting-approval",
      "active",
      "stopping",
      "stopped",
      "expired",
      "failed",
    ] as const) {
      expect(decodeComputerUseSessionState(state)).toBe(state);
    }
  });

  it("accepts every visible host-runtime lifecycle state", () => {
    for (const state of [
      "waiting-for-approval",
      "running",
      "stopping",
      "stopped",
      "interrupted",
      "failed",
      "completed",
    ] as const) {
      expect(decodeComputerUseSessionState(state)).toBe(state);
    }
  });
});

describe("ComputerUseApprovalState", () => {
  it("accepts all valid states", () => {
    for (const state of ["pending", "approved", "denied", "expired", "cancelled"] as const) {
      expect(decodeComputerUseApprovalState(state)).toBe(state);
    }
  });
});

describe("ComputerUseSensitiveFieldKind", () => {
  it("accepts all valid kinds", () => {
    for (const kind of [
      "password",
      "credit-card",
      "ssn",
      "otp",
      "private-key",
      "api-key",
    ] as const) {
      expect(decodeComputerUseSensitiveFieldKind(kind)).toBe(kind);
    }
  });
});

describe("ComputerUseSessionRecord", () => {
  it("decodes an active session", () => {
    const record = decodeComputerUseSessionRecord({
      sessionId: "00000000-0000-4000-8000-000000000001",
      actionId: "00000000-0000-4000-8000-000000000002",
      correlationId: "00000000-0000-4000-8000-000000000003",
      authority: {
        hostId: "00000000-0000-4000-8000-000000000004",
        mode: "work",
        projectId: "00000000-0000-4000-8000-000000000005",
        providerInstanceId: "00000000-0000-4000-8000-000000000006",
        extension: { kind: "core" },
      },
      policy: {
        allowlist: [],
        sensitiveFieldProtection: true,
        visibleStopControl: true,
        maxSessionDurationMs: 300_000,
        processOwnershipRequired: true,
      },
      state: "active",
      createdAt: "2026-07-24T12:00:00.000Z",
    });
    expect(record.state).toBe("active");
  });
});

describe("ComputerUseActionRequest", () => {
  it("decodes a click request", () => {
    const request = decodeComputerUseActionRequest({
      actionId: "00000000-0000-4000-8000-000000000002",
      sessionId: "00000000-0000-4000-8000-000000000001",
      correlationId: "00000000-0000-4000-8000-000000000003",
      authority: {
        hostId: "00000000-0000-4000-8000-000000000004",
        mode: "work",
        projectId: "00000000-0000-4000-8000-000000000005",
        providerInstanceId: "00000000-0000-4000-8000-000000000006",
        extension: { kind: "core" },
      },
      kind: "click",
      visibility: "visible",
      target: "button#submit",
    });
    expect(request.kind).toBe("click");
    expect(request.visibility).toBe("visible");
  });
});

describe("ComputerUseObservation", () => {
  it("decodes a fresh observation", () => {
    const obs = decodeComputerUseObservation({
      sessionId: "00000000-0000-4000-8000-000000000001",
      actionId: "00000000-0000-4000-8000-000000000002",
      correlationId: "00000000-0000-4000-8000-000000000003",
      authority: {
        hostId: "00000000-0000-4000-8000-000000000004",
        mode: "work",
        projectId: "00000000-0000-4000-8000-000000000005",
        providerInstanceId: "00000000-0000-4000-8000-000000000006",
        extension: { kind: "core" },
      },
      windowTitle: "My App",
      appName: "MyApp",
      observedAt: "2026-07-24T12:00:00.000Z",
      stale: false,
    });
    expect(obs.stale).toBe(false);
  });
});

describe("ComputerUseFailure", () => {
  it("decodes each failure category", () => {
    for (const category of [
      "invalid",
      "unauthorized",
      "unavailable",
      "approval-denied",
      "session-expired",
      "sensitive-field-protected",
      "action-not-allowed",
    ] as const) {
      const failure = decodeComputerUseFailure({ category, message: "test" });
      expect(failure.category).toBe(category);
    }
  });
});
