import { describe, expect, it, vi } from "vitest";
import { installExtensionBridge } from "./extensionBridgeShim";

function world(extra: Record<string, unknown> = {}) {
  const nativeSend = vi.fn(async () => "delivered");
  const chrome: Record<string, unknown> = {
    runtime: {},
    tabs: { sendMessage: nativeSend, reload: vi.fn() },
    ...extra,
  };
  return { chrome, nativeSend };
}

describe("an extension's chrome.tabs", () => {
  it("offers only the tab calls Octant answers and drops the rest", () => {
    const { chrome } = world();
    installExtensionBridge({ chrome }, vi.fn(), undefined);
    const tabs = chrome.tabs as Record<string, unknown>;
    expect(Object.keys(tabs).sort()).toEqual(["create", "get", "query", "sendMessage", "update"]);
    expect(tabs.reload).toBeUndefined();
  });

  it("answers a promise call and a callback call from the app", async () => {
    const { chrome } = world();
    const call = vi.fn(async () => [{ id: 4 }]);
    installExtensionBridge({ chrome }, call, undefined);
    const tabs = chrome.tabs as { query: (...args: unknown[]) => unknown };
    expect(await tabs.query({ active: true })).toEqual([{ id: 4 }]);
    expect(call).toHaveBeenCalledWith("query", [{ active: true }]);

    const seen = await new Promise((resolve) => tabs.query({ active: true }, resolve));
    expect(seen).toEqual([{ id: 4 }]);
  });

  it("reports a refusal through lastError to a callback", async () => {
    const { chrome } = world();
    installExtensionBridge(
      { chrome },
      vi.fn(async () => Promise.reject(new Error("No tab"))),
      undefined,
    );
    const tabs = chrome.tabs as { get: (...args: unknown[]) => unknown };
    const message = await new Promise((resolve) =>
      tabs.get(9, () =>
        resolve((chrome.runtime as { lastError?: { message: string } }).lastError?.message),
      ),
    );
    expect(message).toBe("No tab");
    expect((chrome.runtime as { lastError?: unknown }).lastError).toBeUndefined();
  });

  it("messages a tab only after the app says it is one of the profile's pages", async () => {
    const { chrome, nativeSend } = world();
    const call = vi.fn(async (method: string) => {
      if (method === "authorize") throw new Error("No tab with id: 9.");
      return null;
    });
    installExtensionBridge({ chrome }, call, undefined);
    const tabs = chrome.tabs as { sendMessage: (...args: unknown[]) => Promise<unknown> };
    await expect(tabs.sendMessage(9, { hello: 1 })).rejects.toThrow("No tab with id: 9.");
    expect(nativeSend).not.toHaveBeenCalled();

    call.mockImplementation(async () => null);
    await expect(tabs.sendMessage(3, { hello: 1 })).resolves.toBe("delivered");
    expect(nativeSend).toHaveBeenCalledWith(3, { hello: 1 });
  });

  it("fails sendMessage when the runtime has no messaging to deliver with", async () => {
    const chrome: Record<string, unknown> = { runtime: {} };
    installExtensionBridge(
      { chrome },
      vi.fn(async () => null),
      undefined,
    );
    const tabs = chrome.tabs as { sendMessage: (...args: unknown[]) => Promise<unknown> };
    await expect(tabs.sendMessage(3, {})).rejects.toThrow("not supported");
  });

  it("runs from its source text alone, as it does in a page's main world", async () => {
    const { chrome } = world();
    const call = vi.fn(async () => []);
    const standalone = new Function(
      `return (${installExtensionBridge.toString()})`,
    )() as typeof installExtensionBridge;
    standalone({ chrome }, call, undefined);
    await (chrome.tabs as { query: (q: unknown) => Promise<unknown> }).query({});
    expect(call).toHaveBeenCalledWith("query", [{}]);
  });
});

describe("an extension's global", () => {
  it("is patched in the realm the function runs in when no scope is given", async () => {
    const { chrome } = world();
    const holder = globalThis as { chrome?: unknown };
    holder.chrome = chrome;
    try {
      installExtensionBridge(
        null,
        vi.fn(async () => []),
        undefined,
      );
      expect(Object.keys(chrome.tabs as object)).toContain("query");
    } finally {
      delete holder.chrome;
    }
  });
});

describe("an extension's chrome.action.onClicked", () => {
  function clicks() {
    let deliver: (tab: unknown) => void = () => undefined;
    return {
      source: { on: (listener: (tab: unknown) => void) => void (deliver = listener) },
      click: (tab: unknown) => deliver(tab),
    };
  }

  it("calls the extension's listener with the tab that was clicked on", () => {
    const { chrome } = world();
    const { source, click } = clicks();
    installExtensionBridge({ chrome }, vi.fn(), source);
    const listener = vi.fn();
    (chrome.action as { onClicked: { addListener: (l: unknown) => void } }).onClicked.addListener(
      listener,
    );
    click({ id: 2 });
    expect(listener).toHaveBeenCalledWith({ id: 2 });
  });

  it("keeps a click that arrives before the worker adds its listener", () => {
    const { chrome } = world();
    const { source, click } = clicks();
    installExtensionBridge({ chrome }, vi.fn(), source);
    click({ id: 2 });
    const listener = vi.fn();
    (chrome.action as { onClicked: { addListener: (l: unknown) => void } }).onClicked.addListener(
      listener,
    );
    expect(listener).toHaveBeenCalledWith({ id: 2 });
  });

  it("stops calling a listener that was removed and survives one that throws", () => {
    const { chrome } = world();
    const { source, click } = clicks();
    installExtensionBridge({ chrome }, vi.fn(), source);
    const onClicked = (chrome.action as { onClicked: Record<string, (l: unknown) => unknown> })
      .onClicked;
    const broken = vi.fn(() => {
      throw new Error("boom");
    });
    const kept = vi.fn();
    const removed = vi.fn();
    onClicked.addListener?.(broken);
    onClicked.addListener?.(removed);
    onClicked.addListener?.(kept);
    onClicked.removeListener?.(removed);
    click({ id: 2 });
    expect(kept).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
    expect(onClicked.hasListener?.(kept)).toBe(true);
  });
});
