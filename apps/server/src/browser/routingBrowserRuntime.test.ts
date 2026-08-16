import { describe, expect, it, vi } from "vitest";
import { DesktopBrowserOwnerUnavailable } from "./desktopBrowserRuntime";
import { RoutingBrowserRuntime } from "./routingBrowserRuntime";

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
    createContext: vi.fn(async () => presentation),
    inspectTarget: vi.fn(async () => ({ sensitive: false })),
    act: vi.fn(async () => ({ title: "Example" })),
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
