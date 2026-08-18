import { describe, expect, it } from "vitest";
import {
  evaluateBrowserAction,
  evaluateProfileMode,
  canRecordBrowserObservation,
  isContextExpired,
  shouldProtectCredentialField,
  remoteBrowserActionReach,
} from "./browserAutomationPolicy";
import type {
  BrowserActionRequest,
  BrowserContextRecord,
  BrowserObservation,
  ToolActionAuthority,
} from "@octant/contracts";

const authority: ToolActionAuthority = {
  hostId: "00000000-0000-4000-8000-000000000004" as any,
  mode: "work",
  projectId: "00000000-0000-4000-8000-000000000005" as any,
  providerInstanceId: "00000000-0000-4000-8000-000000000006" as any,
  extension: { kind: "core" },
};

const activeContext: BrowserContextRecord = {
  contextId: "00000000-0000-4000-8000-000000000001" as any,
  threadId: "00000000-0000-4000-8000-000000000010" as any,
  actionId: "00000000-0000-4000-8000-000000000002" as any,
  correlationId: "00000000-0000-4000-8000-000000000003" as any,
  authority,
  policy: {
    profileMode: "isolated",
    allowedOrigins: ["https://example.com"],
    credentialFieldProtection: true,
    maxConcurrentTabs: 4,
    sessionTimeoutMs: 300_000,
  },
  state: "active",
  createdAt: "2026-07-24T12:00:00.000Z" as any,
};

function makeRequest(overrides?: Partial<BrowserActionRequest>): BrowserActionRequest {
  return {
    actionId: "00000000-0000-4000-8000-000000000002" as any,
    contextId: "00000000-0000-4000-8000-000000000001" as any,
    correlationId: "00000000-0000-4000-8000-000000000003" as any,
    authority,
    kind: "navigate",
    target: "https://example.com/page",
    ...overrides,
  };
}

describe("evaluateBrowserAction", () => {
  it("allows matching authority and active context", () => {
    const result = evaluateBrowserAction(makeRequest(), activeContext, authority);
    expect(result.kind).toBe("allowed");
  });

  it("denies mismatched authority", () => {
    const otherAuthority: ToolActionAuthority = { ...authority, mode: "code" };
    const result = evaluateBrowserAction(makeRequest(), activeContext, otherAuthority);
    expect(result.kind).toBe("denied");
  });

  it("denies an action identity that does not match the owning context", () => {
    const result = evaluateBrowserAction(
      makeRequest({ actionId: "00000000-0000-4000-8000-000000000099" as any }),
      activeContext,
      authority,
    );
    expect(result).toEqual({
      kind: "denied",
      reason: "Action identity does not match the owning browser context.",
    });
  });

  it("denies a correlation identity that does not match the owning context", () => {
    const result = evaluateBrowserAction(
      makeRequest({ correlationId: "00000000-0000-4000-8000-000000000099" as any }),
      activeContext,
      authority,
    );
    expect(result).toEqual({
      kind: "denied",
      reason: "Action correlation does not match the owning browser context.",
    });
  });

  it("denies stopped context", () => {
    const stopped = { ...activeContext, state: "stopped" as const };
    const result = evaluateBrowserAction(makeRequest(), stopped, authority);
    expect(result.kind).toBe("denied");
  });

  it("denies navigation to disallowed origin", () => {
    const result = evaluateBrowserAction(
      makeRequest({ target: "https://evil.com/phish" }),
      activeContext,
      authority,
    );
    expect(result.kind).toBe("denied");
  });

  it("fails closed when the navigation allowlist is empty", () => {
    const openPolicy = {
      ...activeContext,
      policy: { ...activeContext.policy, allowedOrigins: [] },
    };
    const result = evaluateBrowserAction(
      makeRequest({ target: "https://anywhere.com" }),
      openPolicy,
      authority,
    );
    expect(result.kind).toBe("denied");
  });

  it("denies navigate without target", () => {
    const result = evaluateBrowserAction(
      makeRequest({ kind: "navigate", target: undefined }),
      activeContext,
      authority,
    );
    expect(result.kind).toBe("denied");
  });

  it("allows non-navigate actions without origin check", () => {
    const result = evaluateBrowserAction(
      makeRequest({ kind: "screenshot", target: undefined }),
      activeContext,
      authority,
    );
    expect(result.kind).toBe("allowed");
  });

  it("allows one normalized click point and supported focused keys", () => {
    expect(
      evaluateBrowserAction(
        makeRequest({ kind: "click", target: undefined, point: { x: 0.5, y: 0.25 } }),
        activeContext,
        authority,
      ).kind,
    ).toBe("allowed");
    expect(
      evaluateBrowserAction(
        makeRequest({ kind: "press", target: undefined, value: "Enter" }),
        activeContext,
        authority,
      ).kind,
    ).toBe("allowed");
  });

  it("rejects ambiguous clicks and unsupported focused keys", () => {
    expect(
      evaluateBrowserAction(
        makeRequest({ kind: "click", point: { x: 0.5, y: 0.25 } }),
        activeContext,
        authority,
      ).kind,
    ).toBe("denied");
    expect(
      evaluateBrowserAction(
        makeRequest({ kind: "press", target: undefined, value: "Meta+L" }),
        activeContext,
        authority,
      ).kind,
    ).toBe("denied");
  });
});

describe("evaluateProfileMode", () => {
  it("allows isolated mode always", () => {
    expect(evaluateProfileMode("isolated", activeContext.policy).kind).toBe("allowed");
  });

  it("denies existing-profile when policy is isolated", () => {
    const result = evaluateProfileMode("existing-profile", activeContext.policy);
    expect(result.kind).toBe("denied");
  });

  it("allows existing-profile when policy opts in", () => {
    const policy = { ...activeContext.policy, profileMode: "existing-profile" as const };
    expect(evaluateProfileMode("existing-profile", policy).kind).toBe("allowed");
  });
});

describe("canRecordBrowserObservation", () => {
  it("returns true for matching observation", () => {
    const obs: BrowserObservation = {
      contextId: activeContext.contextId,
      actionId: activeContext.actionId,
      correlationId: activeContext.correlationId,
      authority,
      observedAt: "2026-07-24T12:01:00.000Z" as any,
      stale: false,
    };
    expect(canRecordBrowserObservation(obs, activeContext)).toBe(true);
  });

  it("returns false for mismatched context", () => {
    const obs: BrowserObservation = {
      contextId: "00000000-0000-4000-8000-000000000099" as any,
      actionId: activeContext.actionId,
      correlationId: activeContext.correlationId,
      authority,
      observedAt: "2026-07-24T12:01:00.000Z" as any,
      stale: false,
    };
    expect(canRecordBrowserObservation(obs, activeContext)).toBe(false);
  });
});

describe("isContextExpired", () => {
  it("returns false within timeout", () => {
    const createdAt = new Date("2026-07-24T12:00:00.000Z").getTime();
    expect(isContextExpired(activeContext, createdAt + 60_000)).toBe(false);
  });

  it("returns true after timeout", () => {
    const createdAt = new Date("2026-07-24T12:00:00.000Z").getTime();
    expect(isContextExpired(activeContext, createdAt + 300_001)).toBe(true);
  });

  it("returns false for stopped context", () => {
    const stopped = { ...activeContext, state: "stopped" as const };
    expect(isContextExpired(stopped, Date.now())).toBe(false);
  });
});

describe("shouldProtectCredentialField", () => {
  it("returns true when policy enables protection", () => {
    expect(shouldProtectCredentialField(activeContext, "password")).toBe(true);
  });

  it("returns false when policy disables protection", () => {
    const noProtection = {
      ...activeContext,
      policy: { ...activeContext.policy, credentialFieldProtection: false },
    };
    expect(shouldProtectCredentialField(noProtection, "password")).toBe(false);
  });
});

describe("what a paired device may do in the host's browser", () => {
  it("lets a companion client tap, press, scroll, and read the page it is watching", () => {
    for (const kind of [
      "click",
      "press",
      "scroll",
      "screenshot",
      "extract-text",
      "wait",
    ] as const) {
      expect(remoteBrowserActionReach(kind)).toEqual({ kind: "allowed" });
    }
  });

  it("keeps pointing the browser somewhere new on the host", () => {
    expect(remoteBrowserActionReach("navigate")).toEqual({
      kind: "denied",
      reason: "Navigating the host's browser is not a remote action.",
    });
  });

  it("keeps typing into the page and closing its tabs on the host", () => {
    expect(remoteBrowserActionReach("type").kind).toBe("denied");
    expect(remoteBrowserActionReach("close-tab").kind).toBe("denied");
  });
});
