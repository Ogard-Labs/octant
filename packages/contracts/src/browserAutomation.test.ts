import { describe, expect, it } from "vitest";
import {
  decodeBrowserContextPolicy,
  decodeBrowserContextRecord,
  decodeBrowserActionRequest,
  decodeBrowserObservation,
  decodeBrowserAutomationFailure,
  decodeBrowserProfileMode,
  decodeBrowserContextState,
  decodeBrowserActionKind,
} from "./browserAutomation";

describe("BrowserProfileMode", () => {
  it("accepts isolated and existing-profile", () => {
    expect(decodeBrowserProfileMode("isolated")).toBe("isolated");
    expect(decodeBrowserProfileMode("existing-profile")).toBe("existing-profile");
  });
  it("rejects unknown modes", () => {
    expect(() => decodeBrowserProfileMode("shared")).toThrow();
  });
});

describe("BrowserContextPolicy", () => {
  it("decodes a valid policy", () => {
    const policy = decodeBrowserContextPolicy({
      profileMode: "isolated",
      allowedOrigins: ["https://example.com"],
      credentialFieldProtection: true,
      maxConcurrentTabs: 4,
      sessionTimeoutMs: 300_000,
    });
    expect(policy.profileMode).toBe("isolated");
    expect(policy.credentialFieldProtection).toBe(true);
  });
  it("rejects zero maxConcurrentTabs", () => {
    expect(() =>
      decodeBrowserContextPolicy({
        profileMode: "isolated",
        allowedOrigins: [],
        credentialFieldProtection: true,
        maxConcurrentTabs: 0,
        sessionTimeoutMs: 300_000,
      }),
    ).toThrow();
  });
  it("rejects excessive sessionTimeoutMs", () => {
    expect(() =>
      decodeBrowserContextPolicy({
        profileMode: "isolated",
        allowedOrigins: [],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 9_999_999,
      }),
    ).toThrow();
  });
});

describe("BrowserContextState", () => {
  it("accepts all valid states", () => {
    for (const state of [
      "creating",
      "active",
      "stopping",
      "stopped",
      "expired",
      "failed",
    ] as const) {
      expect(decodeBrowserContextState(state)).toBe(state);
    }
  });
});

describe("BrowserContextRecord", () => {
  it("binds every browser context to one owning thread", () => {
    const record = decodeBrowserContextRecord({
      contextId: "00000000-0000-4000-8000-000000000001",
      threadId: "00000000-0000-4000-8000-000000000010",
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
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
      state: "active",
      createdAt: "2026-07-24T12:00:00.000Z",
    });
    expect(record.threadId).toBe("00000000-0000-4000-8000-000000000010");
  });

  it("decodes an active context", () => {
    const record = decodeBrowserContextRecord({
      contextId: "00000000-0000-4000-8000-000000000001",
      threadId: "00000000-0000-4000-8000-000000000010",
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
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 4,
        sessionTimeoutMs: 300_000,
      },
      state: "active",
      createdAt: "2026-07-24T12:00:00.000Z",
    });
    expect(record.state).toBe("active");
    expect(record.stoppedAt).toBeUndefined();
  });
  it("decodes a stopped context with reason", () => {
    const record = decodeBrowserContextRecord({
      contextId: "00000000-0000-4000-8000-000000000001",
      threadId: "00000000-0000-4000-8000-000000000010",
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
        profileMode: "isolated",
        allowedOrigins: [],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 60_000,
      },
      state: "stopped",
      createdAt: "2026-07-24T12:00:00.000Z",
      stoppedAt: "2026-07-24T12:05:00.000Z",
      stopReason: "user-requested",
    });
    expect(record.stopReason).toBe("user-requested");
  });
});

describe("BrowserActionKind", () => {
  it("accepts all valid kinds", () => {
    for (const kind of [
      "navigate",
      "click",
      "type",
      "press",
      "scroll",
      "screenshot",
      "extract-text",
      "wait",
      "close-tab",
    ] as const) {
      expect(decodeBrowserActionKind(kind)).toBe(kind);
    }
  });
});

describe("BrowserActionRequest", () => {
  it("decodes a navigate request", () => {
    const request = decodeBrowserActionRequest({
      actionId: "00000000-0000-4000-8000-000000000002",
      contextId: "00000000-0000-4000-8000-000000000001",
      correlationId: "00000000-0000-4000-8000-000000000003",
      authority: {
        hostId: "00000000-0000-4000-8000-000000000004",
        mode: "work",
        projectId: "00000000-0000-4000-8000-000000000005",
        providerInstanceId: "00000000-0000-4000-8000-000000000006",
        extension: { kind: "core" },
      },
      kind: "navigate",
      target: "https://example.com",
    });
    expect(request.kind).toBe("navigate");
    expect(request.target).toBe("https://example.com");
  });

  it("decodes bounded interactive preview input and rejects invalid points", () => {
    const base = {
      actionId: "00000000-0000-4000-8000-000000000002",
      contextId: "00000000-0000-4000-8000-000000000001",
      correlationId: "00000000-0000-4000-8000-000000000003",
      authority: {
        hostId: "00000000-0000-4000-8000-000000000004",
        mode: "work",
        projectId: "00000000-0000-4000-8000-000000000005",
        providerInstanceId: "00000000-0000-4000-8000-000000000006",
        extension: { kind: "core" },
      },
      kind: "click",
      expectedObservationRevision: 7,
    } as const;
    expect(decodeBrowserActionRequest({ ...base, point: { x: 0.5, y: 0.25 } }).point).toEqual({
      x: 0.5,
      y: 0.25,
    });
    expect(() => decodeBrowserActionRequest({ ...base, point: { x: 1.1, y: 0.25 } })).toThrow();
    expect(decodeBrowserActionRequest({ ...base, kind: "type", value: " " }).value).toBe(" ");
  });
});

describe("BrowserObservation", () => {
  it("decodes a fresh observation", () => {
    const obs = decodeBrowserObservation({
      contextId: "00000000-0000-4000-8000-000000000001",
      actionId: "00000000-0000-4000-8000-000000000002",
      correlationId: "00000000-0000-4000-8000-000000000003",
      authority: {
        hostId: "00000000-0000-4000-8000-000000000004",
        mode: "work",
        projectId: "00000000-0000-4000-8000-000000000005",
        providerInstanceId: "00000000-0000-4000-8000-000000000006",
        extension: { kind: "core" },
      },
      url: "https://example.com",
      title: "Example",
      extractedText: "Visible page content",
      screenshotDataUrl: "data:image/jpeg;base64,AQID",
      observedAt: "2026-07-24T12:00:00.000Z",
      stale: false,
    });
    expect(obs.stale).toBe(false);
    expect(obs.extractedText).toBe("Visible page content");
    expect(obs.screenshotDataUrl).toBe("data:image/jpeg;base64,AQID");
  });
  it("decodes a stale observation", () => {
    const obs = decodeBrowserObservation({
      contextId: "00000000-0000-4000-8000-000000000001",
      actionId: "00000000-0000-4000-8000-000000000002",
      correlationId: "00000000-0000-4000-8000-000000000003",
      authority: {
        hostId: "00000000-0000-4000-8000-000000000004",
        mode: "work",
        projectId: "00000000-0000-4000-8000-000000000005",
        providerInstanceId: "00000000-0000-4000-8000-000000000006",
        extension: { kind: "core" },
      },
      observedAt: "2026-07-24T12:00:00.000Z",
      stale: true,
    });
    expect(obs.stale).toBe(true);
  });
});

describe("BrowserAutomationFailure", () => {
  it("decodes each failure category", () => {
    for (const category of [
      "invalid",
      "unauthorized",
      "unavailable",
      "policy-denied",
      "context-expired",
      "credential-protected",
      "interrupted",
      "failed",
      "stale",
    ] as const) {
      const failure = decodeBrowserAutomationFailure({ category, message: "test" });
      expect(failure.category).toBe(category);
    }
  });
});
