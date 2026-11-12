import { describe, expect, it } from "vitest";
import {
  evaluateBrowserAction,
  canRecordBrowserObservation,
  isContextExpired,
  browserContextExpiresAt,
  shouldProtectCredentialField,
  originAllowed,
  parseBrowserKeyChord,
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

  it("lets a page that admits every site navigate to any http or https address", () => {
    const everySite = {
      ...activeContext,
      policy: { ...activeContext.policy, allowedOrigins: ["*"] },
    };
    expect(
      evaluateBrowserAction(makeRequest({ target: "https://anywhere.com" }), everySite, authority)
        .kind,
    ).toBe("allowed");
    expect(
      evaluateBrowserAction(makeRequest({ target: "file:///etc/hosts" }), everySite, authority)
        .kind,
    ).toBe("denied");
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
        makeRequest({ kind: "press", target: undefined, value: "Hyper+L" }),
        activeContext,
        authority,
      ).kind,
    ).toBe("denied");
  });

  it("runs an audit only when it names which audit, and takes that name on no other action", () => {
    const audit = (overrides: Partial<BrowserActionRequest>) =>
      evaluateBrowserAction(
        makeRequest({ kind: "audit", target: undefined, ...overrides }),
        activeContext,
        authority,
      ).kind;
    expect(audit({ auditKind: "accessibility" })).toBe("allowed");
    expect(audit({ auditKind: "performance" })).toBe("allowed");
    expect(audit({})).toBe("denied");
    expect(
      evaluateBrowserAction(
        makeRequest({ kind: "snapshot", target: undefined, auditKind: "performance" }),
        activeContext,
        authority,
      ).kind,
    ).toBe("denied");
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
  it("uses host-observed activity and the current handoff deadline without an absolute active cap", () => {
    const created = Date.parse(activeContext.createdAt);
    const activity = { lastActivityAt: created + 1_080_000, keptUntil: created + 1_200_000 };
    expect(browserContextExpiresAt(activeContext, activity)).toBe(created + 1_380_000);
    expect(isContextExpired(activeContext, created + 1_379_999, activity)).toBe(false);
    expect(isContextExpired(activeContext, created + 1_380_000, activity)).toBe(true);
    expect(
      browserContextExpiresAt(activeContext, {
        lastActivityAt: created,
        keptUntil: created + 660_000,
      }),
    ).toBe(created + 660_000);
    expect(
      browserContextExpiresAt(activeContext, {
        lastActivityAt: created,
        keptUntil: created + 120_000,
      }),
    ).toBe(created + 300_000);
  });

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
      "audit",
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

  it("keeps choosing options, dragging, uploading, and changing tabs on the host", () => {
    for (const kind of [
      "select",
      "drag",
      "upload",
      "tab-open",
      "tab-select",
      "tab-close",
    ] as const) {
      expect(remoteBrowserActionReach(kind).kind).toBe("denied");
    }
    expect(remoteBrowserActionReach("hover").kind).toBe("allowed");
    expect(remoteBrowserActionReach("tab-list").kind).toBe("allowed");
  });

  it("keeps recording the page with the host's agent", () => {
    expect(remoteBrowserActionReach("record-start").kind).toBe("denied");
    expect(remoteBrowserActionReach("record-stop").kind).toBe("denied");
  });
});

describe("which keys an agent may press", () => {
  it("reads a named key, a letter, or a chord of distinct modifiers and one key", () => {
    expect(parseBrowserKeyChord("Enter")).toEqual({ modifiers: [], key: "Enter" });
    expect(parseBrowserKeyChord("Control+A")).toEqual({ modifiers: ["Control"], key: "A" });
    expect(parseBrowserKeyChord("Meta+Shift+K")).toEqual({
      modifiers: ["Meta", "Shift"],
      key: "K",
    });
    expect(parseBrowserKeyChord("Shift+Tab")).toEqual({ modifiers: ["Shift"], key: "Tab" });
    expect(parseBrowserKeyChord("F12")).toEqual({ modifiers: [], key: "F12" });
  });

  it("refuses a repeated modifier, an unknown key, and text that is not a key", () => {
    for (const value of ["Control+Control+A", "Hyper+A", "Control+", "F13", "ab", "Control+ab"]) {
      expect(parseBrowserKeyChord(value)).toBeUndefined();
    }
  });
});

describe("originAllowed", () => {
  it("admits every http and https address under the any-site entry, and nothing else", () => {
    expect(originAllowed("https://one.example/a", ["*"])).toBe(true);
    expect(originAllowed("http://127.0.0.1:4321/", ["*"])).toBe(true);
    expect(originAllowed("file:///etc/hosts", ["*"])).toBe(false);
    expect(originAllowed("https://one.example/a", [])).toBe(false);
  });

  it("treats a site's www host and its bare host as one place", () => {
    expect(originAllowed("https://www.vg.no/", ["https://vg.no"])).toBe(true);
    expect(originAllowed("https://vg.no/front", ["https://www.vg.no"])).toBe(true);
  });

  it("lets an http allowlist entry cover the https page it upgrades to, never the reverse", () => {
    expect(originAllowed("https://example.com/", ["http://example.com"])).toBe(true);
    expect(originAllowed("http://example.com/", ["https://example.com"])).toBe(false);
  });

  it("keeps every other host and every port exact", () => {
    expect(originAllowed("https://login.vg.no/", ["https://vg.no"])).toBe(false);
    expect(originAllowed("https://evil-vg.no/", ["https://vg.no"])).toBe(false);
    expect(originAllowed("http://127.0.0.1:4321/", ["http://127.0.0.1:5173"])).toBe(false);
    expect(originAllowed("about:blank", ["https://vg.no"])).toBe(false);
  });
});
