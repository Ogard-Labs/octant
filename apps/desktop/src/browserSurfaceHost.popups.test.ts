import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeHumanBrowserRequest,
  type HumanBrowserResult,
} from "@octant/contracts/browser-presentation";
import { describe, expect, it, vi } from "vitest";
import { createBrowserSurfaceHost, type BrowserSurfaceViewPort } from "./browserSurfaceHost";

const contextId = "60000000-0000-4000-8000-000000000001";
const threadId = "10000000-0000-4000-8000-000000000001";
type Protocol = (event: unknown, method: string, params: unknown, sessionId?: string) => void;

/** A hidden Stable Browser window for a native client, with its protocol and page events. */
async function presentedSurface(options: { readonly agentAttached?: boolean } = {}) {
  const pageListeners = new Map<string, Array<(...args: readonly unknown[]) => void>>();
  const protocol = new Set<Protocol>();
  let attached = options.agentAttached === true;
  let heldSelect: unknown = null;
  const answered: Array<{ token: string; index: number }> = [];
  const dismissedSelects: string[] = [];
  let finishLoad: () => void = () => {};
  const commands: Array<{ method: string; params: unknown }> = [];
  const writeText = vi.fn();
  const webContents: BrowserSurfaceViewPort["webContents"] = {
    id: 801,
    capturePage: vi.fn(async () => ({ isEmpty: () => false, toJPEG: () => new Uint8Array([1]) })),
    close: vi.fn(),
    copyImageAt: vi.fn(),
    debugger: {
      attach: vi.fn(() => {
        attached = true;
      }),
      detach: vi.fn(() => {
        attached = false;
      }),
      isAttached: () => attached,
      sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        commands.push({ method, params });
        return undefined;
      }),
      on: (_event, listener) => void protocol.add(listener),
      removeListener: (_event, listener) => void protocol.delete(listener),
    },
    executeJavaScriptInIsolatedWorld: vi.fn(async (_world, scripts) => {
      const code = scripts[0]?.code ?? "";
      if (code.includes("bridge.read()") && code.includes("octantBrowserSelect")) return heldSelect;
      const dismissed = /dismiss\("([^"]+)"\)/.exec(code);
      if (dismissed !== null) {
        dismissedSelects.push(dismissed[1] ?? "");
        heldSelect = null;
        return true;
      }
      const answer = /answer\("([^"]+)", (\d+)\)/.exec(code);
      if (answer !== null) {
        answered.push({ token: answer[1] ?? "", index: Number(answer[2]) });
        heldSelect = null;
        return true;
      }
      return undefined;
    }),
    getTitle: () => "Example",
    getURL: () => "https://example.com/",
    isDestroyed: () => false,
    isLoading: () => false,
    // An agent's navigation holds the page until the test lets it finish.
    loadURL: vi.fn(
      () =>
        new Promise<undefined>((done) => {
          finishLoad = () => done(undefined);
        }),
    ),
    mainFrame: { framesInSubtree: [] },
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn(),
    },
    on: (event, listener) => {
      pageListeners.set(event, [...(pageListeners.get(event) ?? []), listener]);
    },
    reload: vi.fn(),
    session: {
      on: vi.fn(),
      setCertificateVerifyProc: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: { onErrorOccurred: vi.fn(), onCompleted: vi.fn() },
    },
    setWindowOpenHandler: vi.fn(),
    stop: vi.fn(),
  } as BrowserSurfaceViewPort["webContents"];
  let receive:
    | ((image: { getSize(): { width: number; height: number }; toJPEG(): Uint8Array }) => void)
    | undefined;
  const host = createBrowserSurfaceHost({
    isEmbeddedOwner: () => true,
    isOwnerWindowAvailable: () => true,
    clipboard: { writeText },
    createView: () => ({
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      close: vi.fn(),
      webContents,
      human: {
        input: vi.fn(),
        visible: vi.fn(),
        bounds: vi.fn(),
        frames: (listener) => {
          receive = listener;
          return () => {};
        },
      },
    }),
  });
  await host.createContext({
    contextId,
    owner: { windowId: "window-a", threadId },
    policy: {
      profileMode: "isolated",
      profile: { kind: "personal" },
      allowedOrigins: ["https://example.com"],
      credentialFieldProtection: true,
      maxConcurrentTabs: 2,
      sessionTimeoutMs: 300_000,
    },
  });
  const attachedResult = await host.humanPresentation(
    decodeHumanBrowserRequest({ contextId, threadId, kind: "attach" }),
    "window-a",
  );
  if (attachedResult.status !== "attached") throw new Error("Expected a presentation");
  const send = (raw: Readonly<Record<string, unknown>>): Promise<HumanBrowserResult> =>
    host.humanPresentation(
      decodeHumanBrowserRequest({
        contextId,
        threadId,
        presentationId: attachedResult.presentationId,
        ...raw,
      }),
      "window-a",
    );
  await send({ kind: "layout", layout: { width: 800, height: 600, visible: true } });
  receive?.({ getSize: () => ({ width: 800, height: 600 }), toJPEG: () => new Uint8Array([1]) });
  await send({ kind: "frame", acknowledgement: 0 });
  const emitPage = (event: string, ...args: readonly unknown[]) => {
    for (const listener of pageListeners.get(event) ?? []) listener(...args);
  };
  return {
    host,
    send,
    commands,
    answered,
    dismissedSelects,
    writeText,
    /** Start an agent action that holds the page until `finish` is called. */
    agentNavigation: (dialog?: {
      readonly action: "accept" | "dismiss";
      readonly text?: string;
    }) => {
      const action = host
        .act(contextId, {
          kind: "navigate",
          target: "https://example.com/next",
          ...(dialog === undefined ? {} : { dialog }),
        })
        .catch(() => undefined);
      return {
        action,
        finish: async () => {
          await vi.waitFor(() => expect(webContents.loadURL).toHaveBeenCalled());
          finishLoad();
          await action;
        },
      };
    },
    webContents,
    attached: () => attached,
    holdSelect: (value: unknown) => {
      heldSelect = value;
    },
    emit: (method: string, params: unknown) => {
      for (const listener of protocol) listener({}, method, params);
    },
    emitPage,
    press: (button: "left" | "right" = "left") =>
      send({
        kind: "input",
        frameSequence: 1,
        input: { type: "mouseDown", x: 20, y: 20, button, clickCount: 1 },
      }),
  };
}
const popupOf = (result: HumanBrowserResult) => {
  if (result.status !== "popup") throw new Error(`Expected a popup, got ${result.status}`);
  return result.popup;
};

describe("page popups in Stable's hidden Browser window", () => {
  it("holds a page dialog for the person and answers it once", async () => {
    const surface = await presentedSurface();
    expect(surface.commands.map(({ method }) => method)).toEqual(
      expect.arrayContaining(["Page.enable", "Page.setInterceptFileChooserDialog"]),
    );
    surface.emit("Page.javascriptDialogOpening", { type: "confirm", message: "x".repeat(5_000) });
    const popup = popupOf(await surface.send({ kind: "popup" }));
    expect(popup).toMatchObject({ kind: "dialog", dialog: "confirm" });
    if (popup.kind !== "dialog") throw new Error("Expected a dialog");
    expect(popup.message.length).toBe(2_048);
    surface.emit("Page.javascriptDialogOpening", { type: "alert", message: "Second" });
    expect(popupOf(await surface.send({ kind: "popup" })).id).toBe(popup.id);
    expect(
      await surface.send({
        kind: "popup-answer",
        popupId: popup.id,
        answer: { kind: "dialog", accept: true },
      }),
    ).toEqual({ status: "accepted" });
    expect(
      await surface.send({
        kind: "popup-answer",
        popupId: popup.id,
        answer: { kind: "dialog", accept: false },
      }),
    ).toEqual({ status: "refused" });
    expect(
      surface.commands.filter(({ method }) => method === "Page.handleJavaScriptDialog"),
    ).toEqual([
      // The second dialog was dismissed rather than replacing the first.
      { method: "Page.handleJavaScriptDialog", params: { accept: false } },
      { method: "Page.handleJavaScriptDialog", params: { accept: true } },
    ]);
    surface.host.closeContext(contextId);
  });

  it("answers a page prompt as Stable's own Browser does, without showing it", async () => {
    const surface = await presentedSurface();
    surface.emit("Page.javascriptDialogOpening", { type: "prompt", message: "Name?" });
    expect(await surface.send({ kind: "popup" })).toEqual({ status: "idle" });
    expect(surface.commands).toContainEqual({
      method: "Page.handleJavaScriptDialog",
      params: { accept: false },
    });
    surface.host.closeContext(contextId);
  });

  it("refuses an answer after the page navigated", async () => {
    const surface = await presentedSurface();
    surface.emit("Page.javascriptDialogOpening", { type: "alert", message: "Hello" });
    const popup = popupOf(await surface.send({ kind: "popup" }));
    surface.emitPage("did-start-loading");
    surface.emit("Page.javascriptDialogClosed", { result: false });
    expect(
      await surface.send({
        kind: "popup-answer",
        popupId: popup.id,
        answer: { kind: "dialog", accept: true },
      }),
    ).toEqual({ status: "refused" });
    surface.host.closeContext(contextId);
  });

  it("offers a held select only after the person's own press and applies the chosen option", async () => {
    const surface = await presentedSurface();
    const held = {
      token: "90000000-0000-4000-8000-000000000001",
      age: 0,
      anchor: { x: 10, y: 10, width: 120, height: 24 },
      selectedIndex: 0,
      options: [
        { label: "Small", disabled: false },
        { label: "Large", disabled: false, group: "Sizes" },
      ],
    };
    surface.holdSelect(held);
    // An agent's click holds a select too, but no person pressed: nothing is offered.
    expect(await surface.send({ kind: "popup" })).toEqual({ status: "idle" });
    expect(await surface.press()).toMatchObject({ status: "accepted" });
    const popup = popupOf(await surface.send({ kind: "popup" }));
    expect(popup).toMatchObject({ kind: "select", selectedIndex: 0 });
    expect(JSON.stringify(popup)).not.toContain(held.token);
    expect(
      await surface.send({
        kind: "popup-answer",
        popupId: popup.id,
        answer: { kind: "select", index: 1 },
      }),
    ).toEqual({ status: "accepted" });
    expect(surface.answered).toEqual([{ token: held.token, index: 1 }]);
    surface.host.closeContext(contextId);
  });

  it("refuses a select list past the option bound", async () => {
    const surface = await presentedSurface();
    surface.holdSelect({
      token: "90000000-0000-4000-8000-000000000002",
      age: 0,
      anchor: { x: 0, y: 0, width: 10, height: 10 },
      selectedIndex: 0,
      options: Array.from({ length: 513 }, () => ({ label: "x", disabled: false })),
    });
    await surface.press();
    expect(await surface.send({ kind: "popup" })).toEqual({ status: "idle" });
    surface.host.closeContext(contextId);
  });

  it("keeps link addresses in Stable and copies the chosen one there", async () => {
    const surface = await presentedSurface();
    await surface.press("right");
    surface.emitPage(
      "context-menu",
      {},
      {
        frame: surface.webContents.mainFrame,
        isEditable: false,
        linkURL: "https://example.com/next",
        mediaType: "none",
        x: 20,
        y: 20,
      },
    );
    const popup = popupOf(await surface.send({ kind: "popup" }));
    expect(popup).toEqual({ kind: "context", id: popup.id, link: true, image: false });
    expect(
      await surface.send({
        kind: "popup-answer",
        popupId: popup.id,
        answer: { kind: "context", action: "copy-image" },
      }),
    ).toEqual({ status: "refused" });
    expect(
      await surface.send({
        kind: "popup-answer",
        popupId: popup.id,
        answer: { kind: "context", action: "copy-link" },
      }),
    ).toEqual({ status: "accepted" });
    expect(surface.writeText).toHaveBeenCalledWith("https://example.com/next");
    surface.host.closeContext(contextId);
  });

  it("hands the page only existing files the person chose for its own chooser", async () => {
    const surface = await presentedSurface();
    const folder = await mkdtemp(join(tmpdir(), "octant-chooser-"));
    try {
      const file = join(folder, "report.txt");
      await writeFile(file, "fixture");
      await surface.press();
      surface.emit("Page.fileChooserOpened", { mode: "selectSingle", backendNodeId: 7 });
      let popup = popupOf(await surface.send({ kind: "popup" }));
      expect(popup).toMatchObject({ kind: "file", multiple: false });
      expect(
        await surface.send({
          kind: "popup-answer",
          popupId: popup.id,
          answer: { kind: "file", paths: [join(folder, "missing.txt")] },
        }),
      ).toEqual({ status: "refused" });
      await surface.press();
      surface.emit("Page.fileChooserOpened", { mode: "selectSingle", backendNodeId: 7 });
      popup = popupOf(await surface.send({ kind: "popup" }));
      expect(
        await surface.send({
          kind: "popup-answer",
          popupId: popup.id,
          answer: { kind: "file", paths: [file] },
        }),
      ).toEqual({ status: "accepted" });
      expect(surface.commands).toContainEqual({
        method: "DOM.setFileInputFiles",
        params: { files: [file], backendNodeId: 7 },
      });
    } finally {
      surface.host.closeContext(contextId);
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("never offers a select an agent's press held, nor one older than the person's press", async () => {
    const surface = await presentedSurface();
    const select = (age: number) => ({
      token: "90000000-0000-4000-8000-000000000003",
      age,
      anchor: { x: 0, y: 0, width: 10, height: 10 },
      selectedIndex: 0,
      options: [{ label: "Small", disabled: false }],
    });
    await surface.press();
    // A hold from long before the person's press is not theirs.
    surface.holdSelect(select(5_000));
    expect(await surface.send({ kind: "popup" })).toEqual({ status: "idle" });
    expect(surface.dismissedSelects).toEqual(["90000000-0000-4000-8000-000000000003"]);
    // A hold made while an agent action held the page is not theirs either.
    await surface.press();
    const started = Date.now();
    const agent = surface.agentNavigation();
    await agent.finish();
    surface.holdSelect(select(Date.now() - started + 1));
    expect(await surface.send({ kind: "popup" })).toEqual({ status: "idle" });
    surface.host.closeContext(contextId);
  });

  it("refuses a select whose groups would not fit one native menu", async () => {
    const surface = await presentedSurface();
    surface.holdSelect({
      token: "90000000-0000-4000-8000-000000000004",
      age: 0,
      anchor: { x: 0, y: 0, width: 10, height: 10 },
      selectedIndex: 0,
      // 400 options alternating between two groups need 1,199 menu entries.
      options: Array.from({ length: 400 }, (_, index) => ({
        label: "x",
        disabled: false,
        group: index % 2 === 0 ? "A" : "B",
      })),
    });
    await surface.press();
    expect(await surface.send({ kind: "popup" })).toEqual({ status: "idle" });
    expect(surface.dismissedSelects).toEqual(["90000000-0000-4000-8000-000000000004"]);
    surface.host.closeContext(contextId);
  });

  it("hands a person's open dialog to an agent action that starts, so the action is not stalled", async () => {
    const surface = await presentedSurface();
    surface.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Delete?" });
    const popup = popupOf(await surface.send({ kind: "popup" }));
    const watching = surface.send({ kind: "popup-watch", popupId: popup.id });
    const agent = surface.agentNavigation();
    expect(await watching).toEqual({ status: "refused" });
    expect(surface.commands).toContainEqual({
      method: "Page.handleJavaScriptDialog",
      params: { accept: false },
    });
    await agent.finish();
    expect(await surface.send({ kind: "popup" })).toEqual({ status: "idle" });
    surface.host.closeContext(contextId);
  });

  it("answers the first dialog an agent action raises as the agent said, and the next by the fixed rule", async () => {
    const surface = await presentedSurface();
    const agent = surface.agentNavigation({ action: "accept", text: "Ada" });
    await vi.waitFor(() => expect(surface.webContents.loadURL).toHaveBeenCalled());
    surface.emit("Page.javascriptDialogOpening", { type: "prompt", message: "Your name?" });
    surface.emit("Page.javascriptDialogOpening", { type: "prompt", message: "And again?" });
    const answers = surface.commands.filter(
      (command) => command.method === "Page.handleJavaScriptDialog",
    );
    expect(answers.map((command) => command.params)).toEqual([
      { accept: true, promptText: "Ada" },
      { accept: false },
    ]);
    await agent.finish();
    surface.host.closeContext(contextId);
  });

  it("withholds an agent's text from a prompt that asks for a credential", async () => {
    const surface = await presentedSurface();
    const agent = surface.agentNavigation({ action: "accept", text: "hunter2" });
    await vi.waitFor(() => expect(surface.webContents.loadURL).toHaveBeenCalled());
    surface.emit("Page.javascriptDialogOpening", {
      type: "prompt",
      message: "Enter your password",
    });
    expect(
      surface.commands
        .filter((command) => command.method === "Page.handleJavaScriptDialog")
        .map((command) => command.params),
    ).toEqual([{ accept: false }]);
    await agent.finish();
    surface.host.closeContext(contextId);
  });

  it("answers a burst of page dialogs by policy and tells the person once", async () => {
    const surface = await presentedSurface();
    for (let index = 0; index < 3; index += 1) {
      surface.emit("Page.javascriptDialogOpening", { type: "alert", message: String(index) });
      const popup = popupOf(await surface.send({ kind: "popup" }));
      await surface.send({
        kind: "popup-answer",
        popupId: popup.id,
        answer: { kind: "dialog", accept: true },
      });
    }
    surface.emit("Page.javascriptDialogOpening", { type: "confirm", message: "again" });
    const notice = popupOf(await surface.send({ kind: "popup" }));
    expect(notice).toMatchObject({ kind: "notice", notice: "dialogs-answered" });
    expect(await surface.send({ kind: "popup-dismiss", popupId: notice.id })).toEqual({
      status: "accepted",
    });
    surface.emit("Page.javascriptDialogOpening", { type: "alert", message: "more" });
    expect(await surface.send({ kind: "popup" })).toEqual({ status: "idle" });
    // Waiting out the burst window does not earn the page its sheets back.
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 11_000);
    try {
      surface.emit("Page.javascriptDialogOpening", { type: "alert", message: "after a pause" });
      expect(await surface.send({ kind: "popup" })).toEqual({ status: "idle" });
    } finally {
      clock.mockRestore();
    }
    // A new document load starts with sheets again.
    surface.emitPage("did-start-navigation");
    surface.emit("Page.javascriptDialogOpening", { type: "alert", message: "new page" });
    expect(popupOf(await surface.send({ kind: "popup" }))).toMatchObject({
      kind: "dialog",
      message: "new page",
    });
    const answers = surface.commands.filter(
      ({ method }) => method === "Page.handleJavaScriptDialog",
    );
    // Three answered by the person, then by policy: confirm dismissed, the
    // alerts before and after the pause accepted.
    expect(answers.slice(3, 6).map(({ params }) => params)).toEqual([
      { accept: false },
      { accept: true },
      { accept: true },
    ]);
    surface.host.closeContext(contextId);
  });

  it("does not hand chosen files to a page while an agent action holds it", async () => {
    const surface = await presentedSurface();
    const folder = await mkdtemp(join(tmpdir(), "octant-chooser-"));
    try {
      const file = join(folder, "report.txt");
      await writeFile(file, "fixture");
      await surface.press();
      surface.emit("Page.fileChooserOpened", { mode: "selectSingle", backendNodeId: 9 });
      const popup = popupOf(await surface.send({ kind: "popup" }));
      const answering = surface.send({
        kind: "popup-answer",
        popupId: popup.id,
        answer: { kind: "file", paths: [file] },
      });
      const agent = surface.agentNavigation();
      await vi.waitFor(() => expect(surface.webContents.loadURL).toHaveBeenCalled());
      await new Promise((done) => setTimeout(done, 50));
      expect(surface.commands.some(({ method }) => method === "DOM.setFileInputFiles")).toBe(false);
      await agent.finish();
      await answering;
    } finally {
      surface.host.closeContext(contextId);
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("leaves a debugger someone else attached alone", async () => {
    const surface = await presentedSurface({ agentAttached: true });
    expect(surface.commands).toEqual([]);
    surface.emit("Page.javascriptDialogOpening", { type: "alert", message: "Theirs" });
    expect(await surface.send({ kind: "popup" })).toEqual({ status: "idle" });
    surface.host.closeContext(contextId);
  });

  it("releases its own protocol attachment when the page closes", async () => {
    const surface = await presentedSurface();
    expect(surface.attached()).toBe(true);
    surface.host.closeContext(contextId);
    expect(surface.attached()).toBe(false);
  });
});
