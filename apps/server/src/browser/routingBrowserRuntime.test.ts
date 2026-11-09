import { decodeBrowserPageScriptNativeCommand } from "@octant/contracts/browser-page-script";
import { decodeOwnerBrowserNativeCommand } from "@octant/contracts/owner-browser";
import { decodeHumanBrowserRequest } from "@octant/contracts/browser-presentation";
import { describe, expect, it, vi } from "vitest";
import { DesktopBrowserOwnerUnavailable } from "./desktopBrowserRuntime";
import { RoutingBrowserRuntime } from "./routingBrowserRuntime";
import {
  decodePersistentBrowserLeaseBinding,
  decodePersistentBrowserContextCreated,
} from "@octant/contracts/persistent-browser-owner";

const contextId = "60000000-0000-4000-8000-000000000001" as never;
const owner = {
  windowId: "90000000-0000-4000-8000-000000000001" as never,
  threadId: "10000000-0000-4000-8000-000000000001" as never,
};
const policy = {
  profileMode: "isolated" as const,
  allowedOrigins: ["https://example.com"],
  credentialFieldProtection: true,
  maxConcurrentTabs: 1,
  sessionTimeoutMs: 300_000,
};

function runtime(presentation: "native-live" | "headless" = "native-live") {
  let exit: (() => void) | undefined;
  return {
    available: vi.fn(async () => true),
    ownerControl: vi.fn(async () => ({ status: "refused" as const })),
    runPageScript: vi.fn(async () => ({
      status: "completed" as const,
      effect: "possible" as const,
      valueJson: "42",
    })),
    createContext: vi.fn(async () => presentation),
    inspectTarget: vi.fn(async () => ({ sensitive: false })),
    act: vi.fn(async () => ({ title: "Example" })),
    peek: vi.fn(async () => ({ title: "Example" })),
    closeContext: vi.fn(async () => undefined),
    closeAll: vi.fn(async () => undefined),
    onProcessExit: (listener: () => void) => {
      exit = listener;
      return () => {
        exit = undefined;
      };
    },
    exit: () => exit?.(),
  };
}

describe("RoutingBrowserRuntime", () => {
  it("keeps execution pages native and forgets their routing only after confirmed release", async () => {
    const binding = decodePersistentBrowserLeaseBinding({
      ownerId: "10000000-0000-4000-8000-000000000001",
      grantId: "10000000-0000-4000-8000-000000000002",
      executionId: "10000000-0000-4000-8000-000000000003",
      threadId: "10000000-0000-4000-8000-000000000004",
      mode: "code",
      projectId: "10000000-0000-4000-8000-000000000005",
      providerId: "provider",
      modelId: "model",
      authorityRevision: "revision",
      profile: { kind: "personal" },
      origins: ["https://example.com"],
      expiresAt: "2026-11-07T20:30:00.000Z",
    });
    const receipt = decodePersistentBrowserContextCreated({
      status: "created",
      ownerId: binding.ownerId,
      leaseId: binding.grantId,
    });
    if (receipt.status !== "created") throw new Error("Expected a created receipt");
    const release = vi.fn(async (): Promise<"closed" | "unconfirmed"> => "unconfirmed");
    const native = {
      ...runtime(),
      persistentOwner: {
        status: async () => ({ status: "ready" as const, ownerId: binding.ownerId }),
        configure: async () => ({ status: "disabled" as const }),
        createContext: vi.fn(async () => receipt),
        release,
      },
    };
    const headless = runtime("headless");
    const router = new RoutingBrowserRuntime({ native, headless });
    await router.persistentOwner?.createContext(
      contextId,
      { ...policy, profile: binding.profile },
      new AbortController().signal,
      binding,
    );
    expect(await router.persistentOwner?.release(receipt.leaseId)).toBe("unconfirmed");
    await router.act(contextId, { kind: "snapshot" } as never, new AbortController().signal);
    expect(native.act).toHaveBeenCalledOnce();
    release.mockResolvedValue("closed");
    await router.persistentOwner?.release(receipt.leaseId);
    expect(() =>
      router.act(contextId, { kind: "snapshot" } as never, new AbortController().signal),
    ).toThrow("stale or unknown");
    expect(headless.createContext).not.toHaveBeenCalled();
  });
  it("refuses native-only control for a headless fallback instead of borrowing the native owner's page", async () => {
    const native = runtime();
    native.available.mockResolvedValue(false);
    const headless = runtime("headless");
    const router = new RoutingBrowserRuntime({ native, headless });
    await router.createContext(contextId, policy, new AbortController().signal, owner);
    const command = decodeBrowserPageScriptNativeCommand({
      operation: "prepare",
      contextId,
      owner,
      source: "42",
      expectedUrl: "https://example.com/",
    });
    expect(await router.runPageScript(command, new AbortController().signal)).toMatchObject({
      status: "refused",
      effect: "none",
    });
    expect(native.runPageScript).not.toHaveBeenCalled();
    expect(headless.runPageScript).not.toHaveBeenCalled();
    expect(
      await router.ownerControl(
        decodeOwnerBrowserNativeCommand({ operation: "inspect", contextId, owner }),
        new AbortController().signal,
      ),
    ).toEqual({ status: "refused" });
    expect(native.ownerControl).not.toHaveBeenCalled();
    expect(headless.ownerControl).not.toHaveBeenCalled();
    await router.closeAll();
  });

  it("presents only the recorded native owner and suppresses a result after owner closure", async () => {
    let finish: (() => void) | undefined;
    const held = new Promise<void>((done) => {
      finish = done;
    });
    const humanPresentation = vi.fn(async () => {
      await held;
      return { status: "idle" as const };
    });
    const native = { ...runtime(), humanPresentation };
    const headless = {
      ...runtime("headless"),
      humanPresentation: vi.fn(async () => ({ status: "idle" as const })),
    };
    const router = new RoutingBrowserRuntime({ native, headless });
    const request = decodeHumanBrowserRequest({
      kind: "attach",
      contextId,
      threadId: owner.threadId,
    });
    const signal = new AbortController().signal;
    expect(await router.humanPresentation(request, owner.windowId, signal)).toEqual({
      status: "refused",
    });
    native.available.mockResolvedValueOnce(false);
    await router.createContext(contextId, policy, signal, owner);
    expect(await router.humanPresentation(request, owner.windowId, signal)).toEqual({
      status: "refused",
    });
    expect(headless.humanPresentation).not.toHaveBeenCalled();
    await router.closeContext(contextId);
    await router.createContext(contextId, policy, signal, owner);
    const pending = router.humanPresentation(request, owner.windowId, signal);
    await router.closeContext(contextId);
    finish?.();
    expect(await pending).toEqual({ status: "refused" });
    expect(humanPresentation).toHaveBeenCalledOnce();
  });

  it("uses the native page for a verified Electron owner", async () => {
    const native = runtime();
    const headless = runtime("headless");
    const router = new RoutingBrowserRuntime({ native, headless });
    await expect(
      router.createContext(contextId, policy, new AbortController().signal, owner),
    ).resolves.toBe("native-live");
    await router.act(contextId, { kind: "extract-text" } as never, new AbortController().signal);
    expect(native.createContext).toHaveBeenCalledOnce();
    expect(native.act).toHaveBeenCalledOnce();
    expect(headless.createContext).not.toHaveBeenCalled();
  });

  it("uses headless Playwright only when the owner is not a native Project window", async () => {
    const native = runtime();
    native.createContext.mockRejectedValueOnce(new DesktopBrowserOwnerUnavailable());
    const headless = runtime("headless");
    const router = new RoutingBrowserRuntime({ native, headless });
    await expect(
      router.createContext(contextId, policy, new AbortController().signal, owner),
    ).resolves.toBe("headless");
    await router.act(contextId, { kind: "extract-text" } as never, new AbortController().signal);
    expect(headless.createContext).toHaveBeenCalledOnce();
    expect(headless.act).toHaveBeenCalledOnce();
  });

  it("uses headless directly when the native broker is unavailable", async () => {
    const native = runtime();
    native.available.mockResolvedValueOnce(false);
    const headless = runtime("headless");
    const router = new RoutingBrowserRuntime({ native, headless });

    await expect(
      router.createContext(contextId, policy, new AbortController().signal, owner),
    ).resolves.toBe("headless");

    expect(native.createContext).not.toHaveBeenCalled();
    expect(headless.createContext).toHaveBeenCalledOnce();
  });

  it("peeks through the backend that holds the page", async () => {
    const native = runtime();
    const headless = runtime("headless");
    const router = new RoutingBrowserRuntime({ native, headless });
    await router.createContext(contextId, policy, new AbortController().signal, owner);
    await router.peek(contextId, new AbortController().signal);
    expect(native.peek).toHaveBeenCalledWith(contextId, expect.any(AbortSignal));
    expect(headless.peek).not.toHaveBeenCalled();
  });

  it("scopes a backend process exit to contexts owned by that backend", async () => {
    const native = runtime();
    native.createContext
      .mockResolvedValueOnce("native-live")
      .mockRejectedValueOnce(new DesktopBrowserOwnerUnavailable());
    const headless = runtime("headless");
    const router = new RoutingBrowserRuntime({ native, headless });
    const headlessContext = "60000000-0000-4000-8000-000000000002" as never;
    await router.createContext(contextId, policy, new AbortController().signal, owner);
    await router.createContext(headlessContext, policy, new AbortController().signal, owner);
    const exited = vi.fn();
    router.onProcessExit(exited);

    headless.exit();

    expect(exited).toHaveBeenCalledWith([headlessContext]);
  });
});
