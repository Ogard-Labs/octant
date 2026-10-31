import {
  decodeToolActionRequest,
  type BrowserContextId,
  type BrowserContextPolicy,
  type BrowserProfile,
  type BrowserThreadId,
  type ToolActionAuthority,
  type WindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { BrowserAutomationService } from "./browserAutomationService";
import { BrowserProfileUnavailableError, type BrowserRuntimePort } from "./browserRuntimePort";
import { RoutingBrowserRuntime } from "./routingBrowserRuntime";

const windowId = "10000000-0000-4000-8000-000000000001" as WindowId;
const hostScope = "10000000-0000-4000-8000-0000000000ff" as WindowId;
const thread = "20000000-0000-4000-8000-000000000001" as BrowserThreadId;
const projectId = "50000000-0000-4000-8000-000000000001" as never;
const otherProjectId = "50000000-0000-4000-8000-000000000002" as never;

const authority = (mode: ToolActionAuthority["mode"] = "work"): ToolActionAuthority =>
  ({
    hostId: "40000000-0000-4000-8000-000000000001",
    mode,
    projectId,
    ...(mode === "chat" ? {} : { rootId: "60000000-0000-4000-8000-000000000001" }),
    providerInstanceId: "70000000-0000-4000-8000-000000000001",
    extension: { kind: "core" },
  }) as never;

const action = (mode: ToolActionAuthority["mode"] = "work") =>
  decodeToolActionRequest({
    actionId: "80000000-0000-4000-8000-000000000001",
    correlationId: "90000000-0000-4000-8000-000000000001",
    capability: { id: "browser-automation", version: 1 },
    authority: authority(mode),
    intent: "Open an isolated browser context.",
    approval: { kind: "not-required" },
  });

const policy = (profile?: BrowserProfile): BrowserContextPolicy => ({
  profileMode: "isolated",
  ...(profile === undefined ? {} : { profile }),
  allowedOrigins: ["https://example.com"],
  credentialFieldProtection: true,
  maxConcurrentTabs: 1,
  sessionTimeoutMs: 300_000,
});

function harness(options: { readonly native?: boolean } = {}) {
  const open = new Set<BrowserContextId>();
  const runtime: BrowserRuntimePort = {
    available: vi.fn(async () => true),
    nativeAvailable: vi.fn(async () => options.native ?? true),
    createContext: vi.fn(async (contextId) => void open.add(contextId)),
    inspectTarget: vi.fn(async () => ({ sensitive: false })),
    act: vi.fn(async () => ({ url: "https://example.com/", title: "Example" })),
    closeContext: vi.fn(async (contextId) => void open.delete(contextId)),
    closeAll: vi.fn(async () => undefined),
  };
  let sequence = 0;
  const service = new BrowserAutomationService({
    runtime,
    authority: { canAccessWindow: () => true, resolve: (_thread, mode) => authority(mode) },
    isUnattendedScope: (scope) => scope === hostScope,
    uuid: () => `30000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    clock: () => "2026-10-31T12:00:00.000Z",
    now: () => Date.parse("2026-10-31T12:00:00.000Z"),
    schedule: () => () => undefined,
  });
  return { service, runtime, open };
}

describe("Browser profile authority", () => {
  it("opens a page in the Project's profile for the person and records the profile on the context", async () => {
    const { service, runtime } = harness();

    const snapshot = await service.create({
      windowId,
      threadId: thread,
      action: action(),
      policy: policy({ kind: "project", projectId }),
    });

    expect(snapshot.context).toMatchObject({
      state: "active",
      policy: { profile: { kind: "project", projectId } },
    });
    expect(runtime.createContext).toHaveBeenCalledTimes(1);
  });

  it("refuses a paired device with profile-not-local before any runtime is asked", async () => {
    const { service, runtime } = harness();

    const snapshot = await service.create({
      windowId,
      threadId: thread,
      action: action(),
      policy: policy({ kind: "personal" }),
      profileCaller: "remote-device",
    });

    expect(snapshot.failure).toMatchObject({
      category: "policy-denied",
      reason: "profile-not-local",
    });
    expect(runtime.createContext).not.toHaveBeenCalled();
  });

  it("refuses a routine or subagent scope and a terminal grant with profile-needs-a-person", async () => {
    const { service, runtime } = harness();

    for (const input of [
      { windowId: hostScope },
      { windowId, profileCaller: "terminal-grant" as const },
    ]) {
      const snapshot = await service.create({
        threadId: thread,
        action: action(),
        policy: policy({ kind: "personal" }),
        ...input,
      });
      expect(snapshot.failure).toMatchObject({
        category: "policy-denied",
        reason: "profile-needs-a-person",
      });
    }
    expect(runtime.createContext).not.toHaveBeenCalled();
  });

  it("still lets an unattended scope open a Private page", async () => {
    const { service } = harness();

    const snapshot = await service.create({
      windowId: hostScope,
      threadId: thread,
      action: action(),
      policy: policy(),
    });

    expect(snapshot.context?.state).toBe("active");
  });

  it("refuses a profile page with profile-unavailable when the desktop Browser is not there", async () => {
    const { service, runtime } = harness({ native: false });

    const snapshot = await service.create({
      windowId,
      threadId: thread,
      action: action(),
      policy: policy({ kind: "personal" }),
    });

    expect(snapshot.failure).toMatchObject({
      category: "unavailable",
      reason: "profile-unavailable",
    });
    expect(runtime.createContext).not.toHaveBeenCalled();
  });

  it("refuses another Project's profile and any profile for Chat", async () => {
    const { service, runtime } = harness();

    const other = await service.create({
      windowId,
      threadId: thread,
      action: action(),
      policy: policy({ kind: "project", projectId: otherProjectId }),
    });
    const chat = await service.create({
      windowId,
      threadId: thread,
      action: action("chat"),
      policy: policy({ kind: "personal" }),
    });

    expect(other.failure).toMatchObject({ reason: "profile-unavailable" });
    expect(chat.failure).toMatchObject({ reason: "profile-unavailable" });
    expect(runtime.createContext).not.toHaveBeenCalled();
  });

  it("reports a runtime that cannot hold the store as profile-unavailable", async () => {
    const { service, runtime } = harness();
    vi.mocked(runtime.createContext).mockRejectedValueOnce(new BrowserProfileUnavailableError());

    const snapshot = await service.create({
      windowId,
      threadId: thread,
      action: action(),
      policy: policy({ kind: "personal" }),
    });

    expect(snapshot.failure).toMatchObject({
      category: "unavailable",
      reason: "profile-unavailable",
    });
  });

  it("closes only the contexts of the profile the person signed out of", async () => {
    const { service, runtime } = harness();
    const personal = await service.create({
      windowId,
      threadId: thread,
      action: action(),
      policy: policy({ kind: "personal" }),
    });
    // A dedicated Open lives beside the thread's own context, so a Private page
    // can coexist with the profile page.
    const privatePage = await service.create({
      windowId,
      threadId: thread,
      action: action(),
      policy: policy(),
      dedicated: true,
    });

    await service.closeProfile({ kind: "personal" });

    expect(runtime.closeContext).toHaveBeenCalledWith(personal.context?.contextId);
    expect(runtime.closeContext).not.toHaveBeenCalledWith(privatePage.context?.contextId);
    expect(service.profileOf(privatePage.context!.contextId)).toBeUndefined();
  });
});

describe("Routing runtime and stored profiles", () => {
  function pair(options: { readonly nativeUp: boolean; readonly ownerGone?: boolean }) {
    const native: BrowserRuntimePort = {
      available: async () => options.nativeUp,
      createContext: vi.fn(async () => {
        if (options.ownerGone === true) {
          const { DesktopBrowserOwnerUnavailable } = await import("./desktopBrowserRuntime");
          throw new DesktopBrowserOwnerUnavailable();
        }
        return "native-live" as const;
      }),
      inspectTarget: vi.fn(),
      act: vi.fn(),
      closeContext: vi.fn(),
      closeAll: vi.fn(),
    };
    const headless: BrowserRuntimePort = {
      available: async () => true,
      createContext: vi.fn(async () => "headless" as const),
      inspectTarget: vi.fn(),
      act: vi.fn(),
      closeContext: vi.fn(),
      closeAll: vi.fn(),
    };
    return { native, headless, routing: new RoutingBrowserRuntime({ native, headless }) };
  }
  const context = "30000000-0000-4000-8000-000000000001" as BrowserContextId;
  const signal = new AbortController().signal;
  const owner = { windowId, threadId: thread };

  it("never falls back to a headless page for a stored profile", async () => {
    for (const scenario of [{ nativeUp: false }, { nativeUp: true, ownerGone: true }]) {
      const { routing, headless } = pair(scenario);
      await expect(
        routing.createContext(context, policy({ kind: "personal" }), signal, owner),
      ).rejects.toBeInstanceOf(BrowserProfileUnavailableError);
      expect(headless.createContext).not.toHaveBeenCalled();
    }
  });

  it("still falls back to headless for a Private page", async () => {
    const { routing, headless } = pair({ nativeUp: false });

    await expect(routing.createContext(context, policy(), signal, owner)).resolves.toBe("headless");
    expect(headless.createContext).toHaveBeenCalledTimes(1);
  });
});
