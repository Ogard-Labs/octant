import { describe, expect, it, vi } from "vitest";
import { createExtensionBridge, type ExtensionWorkerPort } from "./browserExtensionBridge";

const profile = { kind: "personal" } as const;
const tabsChannel = "tabs";
const actionChannel = "action";

function setup(
  identity: { extensionId: string; seesTabAddresses: boolean } | null = {
    extensionId: "x".repeat(32),
    seesTabAddresses: true,
  },
) {
  const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
  const worker: ExtensionWorkerPort = {
    scope: "chrome-extension://electron-1/",
    ipc: { handle: (channel, listener) => void handlers.set(channel, listener) },
    send: vi.fn(),
  };
  let running: ((details: { versionId: number }) => void) | undefined;
  const session = {
    registerPreloadScript: vi.fn(() => "id"),
    serviceWorkers: {
      on: vi.fn(
        (_event: "running-status-changed", listener: (details: { versionId: number }) => void) => {
          running = listener;
        },
      ),
      getWorkerFromVersionID: vi.fn(() => worker),
      startWorkerForScope: vi.fn(async () => worker),
    },
  };
  const tabs = {
    handle: vi.fn(async (_caller: unknown, request: unknown) =>
      (request as { method: string }).method === "query"
        ? { ok: true as const, value: [{ id: 5, active: true }] }
        : { ok: true as const, value: null },
    ),
  };
  const store = {
    extensionOfElectronId: vi.fn((_profile: unknown, electronId: string) =>
      electronId === "electron-1" ? (identity ?? undefined) : undefined,
    ),
    extensionActionScope: vi.fn(() => "chrome-extension://electron-1/" as string | undefined),
  };
  const bridge = createExtensionBridge({
    preloadPath: "/app/preload.cjs",
    tabsChannel,
    actionChannel,
    sessionFor: () => session,
    store,
    tabs,
  });
  return { bridge, worker, handlers, session, tabs, store, running: () => running };
}

describe("the extension bridge", () => {
  it("answers a popup of an enabled extension in the popup's window and profile", async () => {
    const { bridge, tabs } = setup();
    const popup = { windowId: "w1", profile, extensionId: "x".repeat(32) };
    const answer = await bridge.answerPopup(popup, "chrome-extension://electron-1/popup.html", {
      method: "query",
      args: [],
    });

    expect(answer).toMatchObject({ ok: true });
    expect(tabs.handle).toHaveBeenCalledWith(
      { profile, windowId: "w1", seesTabAddresses: true },
      { method: "query", args: [] },
    );
  });

  it("refuses a page that is not an open popup, or whose address is another extension's", async () => {
    const { bridge, tabs } = setup();
    const popup = { windowId: "w1", profile, extensionId: "x".repeat(32) };
    const request = { method: "query", args: [] };

    expect(
      await bridge.answerPopup(undefined, "chrome-extension://electron-1/p.html", request),
    ).toMatchObject({ ok: false });
    expect(await bridge.answerPopup(popup, "https://example.com/", request)).toMatchObject({
      ok: false,
    });
    expect(
      await bridge.answerPopup(popup, "chrome-extension://electron-2/p.html", request),
    ).toMatchObject({ ok: false });
    expect(
      await bridge.answerPopup(
        { ...popup, extensionId: "y".repeat(32) },
        "chrome-extension://electron-1/p.html",
        request,
      ),
    ).toMatchObject({ ok: false });
    expect(tabs.handle).not.toHaveBeenCalled();
  });

  it("attaches the worker preload to a profile's session once and serves only extension workers", async () => {
    const { bridge, session, running, worker, handlers, tabs } = setup();
    bridge.attachProfile(profile);
    bridge.attachProfile(profile);
    expect(session.registerPreloadScript).toHaveBeenCalledOnce();
    expect(session.registerPreloadScript).toHaveBeenCalledWith({
      type: "service-worker",
      filePath: "/app/preload.cjs",
    });

    running()?.({ versionId: 1 });
    bridge.useWindow(profile, "w2");
    const answer = await handlers.get(tabsChannel)?.({}, { method: "query", args: [] });
    expect(answer).toMatchObject({ ok: true });
    expect(tabs.handle).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: "w2" }),
      expect.anything(),
    );

    const website = { ...worker, scope: "https://example.com/", ipc: { handle: vi.fn() } };
    session.serviceWorkers.getWorkerFromVersionID.mockReturnValue(website);
    running()?.({ versionId: 2 });
    expect(website.ipc.handle).not.toHaveBeenCalled();
  });

  it("sees no pages from a worker until the person has used the profile's extensions button", async () => {
    const { bridge, running, handlers, tabs } = setup();
    bridge.attachProfile(profile);
    running()?.({ versionId: 1 });
    await handlers.get(tabsChannel)?.({}, { method: "query", args: [] });
    expect(tabs.handle).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: "" }),
      expect.anything(),
    );
  });

  it("refuses a worker whose extension is no longer enabled in the profile", async () => {
    const { bridge, running, handlers } = setup(null);
    bridge.attachProfile(profile);
    running()?.({ versionId: 1 });
    expect(await handlers.get(tabsChannel)?.({}, { method: "query", args: [] })).toMatchObject({
      ok: false,
    });
  });

  it("sends the active tab to an action extension's worker when its button is clicked", async () => {
    const { bridge, worker, session } = setup();
    const clicked = await bridge.clickAction(profile, "w1", "x".repeat(32));

    expect(clicked).toBe(true);
    expect(session.serviceWorkers.startWorkerForScope).toHaveBeenCalledWith(
      "chrome-extension://electron-1/",
    );
    expect(worker.send).toHaveBeenCalledWith(actionChannel, { id: 5, active: true });
  });

  it("does nothing for a click when there is no action, no enabled extension or no page", async () => {
    const none = setup();
    none.store.extensionActionScope.mockReturnValue(undefined);
    expect(await none.bridge.clickAction(profile, "w1", "x".repeat(32))).toBe(false);

    const gone = setup(null);
    expect(await gone.bridge.clickAction(profile, "w1", "x".repeat(32))).toBe(false);

    const empty = setup();
    empty.tabs.handle.mockResolvedValue({ ok: true, value: [] as never });
    expect(await empty.bridge.clickAction(profile, "w1", "x".repeat(32))).toBe(false);
    expect(empty.worker.send).not.toHaveBeenCalled();
  });
});
