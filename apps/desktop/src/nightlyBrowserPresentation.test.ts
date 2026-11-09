import { describe, expect, it, vi } from "vitest";
import {
  decodeHumanBrowserRequest,
  decodeBrowserPresentationId,
  decodeBrowserCompositionId,
  decodeBrowserEditMenuId,
  decodeBrowserPagePopupId,
  type HumanBrowserRequest,
  type HumanBrowserResult,
} from "@octant/contracts/browser-presentation";
import { NightlyBrowserPresentation } from "./nightlyBrowserPresentation";

const id = decodeBrowserPresentationId("00000000-0000-4000-8000-000000000801");
const owner = {
  contextId: "00000000-0000-4000-8000-000000000802",
  threadId: "00000000-0000-4000-8000-000000000803",
};
const input = (type: "keyDown" | "keyUp" | "char") => ({
  ...owner,
  presentationId: id,
  kind: "input",
  frameSequence: 1,
  input: { type, keyCode: "a" },
});

describe("Nightly main human window ownership", () => {
  it("releases source modifiers before a popup and keeps its new presses out of that source", async () => {
    const menuId = decodeBrowserEditMenuId("00000000-0000-4000-8000-000000000848");
    const calls: HumanBrowserRequest[] = [];
    let dismiss = () => {};
    let popupCount = 0;
    let releaseFrame = () => {};
    const heldFrame = new Promise<void>((done) => {
      releaseFrame = done;
    });
    const main = new NightlyBrowserPresentation({
      current: () => true,
      visible: () => true,
      focused: () => true,
      popupMenu: async () => {
        popupCount++;
        expect(
          calls.some(
            (r) => r.kind === "input" && r.input.type === "keyUp" && r.input.keyCode === "Shift",
          ),
        ).toBe(true);
        await new Promise<void>((done) => {
          dismiss = done;
        });
        return { kind: "dismissed" };
      },
      execute: async (request, signal) => {
        calls.push(request);
        if (request.kind === "frame") {
          await heldFrame;
          return { status: "idle" };
        }
        if (request.kind === "attach") return { status: "attached", presentationId: id };
        if (
          request.kind === "input" &&
          request.input.type === "keyDown" &&
          request.input.keyCode === "F10"
        )
          return { status: "edit-menu-pending", menuId };
        if (request.kind === "edit-menu")
          return {
            status: "edit-menu",
            menuId,
            flags: {
              undo: false,
              redo: false,
              cut: false,
              copy: false,
              paste: false,
              selectAll: true,
            },
          };
        if (request.kind === "edit-menu-watch") {
          await new Promise<void>((done) => {
            if (signal.aborted) done();
            else signal.addEventListener("abort", () => done(), { once: true });
          });
          return { status: "refused" };
        }
        return { status: "accepted" };
      },
    });
    const key = (type: "keyDown" | "keyUp" | "char", keyCode: string) => ({
      ...owner,
      presentationId: id,
      kind: "input",
      frameSequence: 1,
      input: { type, keyCode, modifiers: ["shift"] },
    });
    try {
      await main.invoke({ ...owner, kind: "attach" });
      await main.invoke(key("keyDown", "Shift"));
      await main.invoke(key("keyDown", "F10"));
      await main.invoke(key("keyUp", "F10"));
      await vi.waitFor(() => expect(popupCount).toBe(1));
      const before = calls.length;
      expect(await main.invoke(key("keyDown", "F10"))).toEqual({ status: "refused" });
      expect(await main.invoke(key("char", "x"))).toEqual({ status: "refused" });
      expect(calls.slice(before).some((r) => r.kind === "input")).toBe(false);
      const other = { ...owner, contextId: "00000000-0000-4000-8000-000000000849" };
      await main.invoke({ ...other, kind: "attach" });
      expect(await main.invoke({ ...key("keyDown", "a"), ...other })).toEqual({
        status: "accepted",
      });
      const frame = main.invoke({
        ...owner,
        presentationId: id,
        kind: "frame",
        acknowledgement: 0,
      });
      await vi.waitFor(() => expect(calls.some((r) => r.kind === "frame")).toBe(true));
      const queuedDown = main.invoke(key("keyDown", "F10"));
      dismiss();
      await vi.waitFor(() => expect(calls.some((r) => r.kind === "edit-menu-dismiss")).toBe(true));
      releaseFrame();
      await frame;
      expect(await queuedDown).toEqual({ status: "refused" });
      expect(await main.invoke(key("keyDown", "F10"))).toEqual({ status: "accepted" });
      await main.releaseInputs();
      expect(calls.filter((r) => r.kind === "edit-menu-keyboard")).toHaveLength(1);
    } finally {
      releaseFrame();
      dismiss();
      await main.releaseInputs();
      await main.close();
    }
  });

  it("refuses a menu down queued before a blur and refocus cycle", async () => {
    const menuId = decodeBrowserEditMenuId("00000000-0000-4000-8000-000000000838");
    let focused = true;
    let unblock = () => {};
    const blocked = new Promise<void>((done) => {
      unblock = done;
    });
    const calls: HumanBrowserRequest[] = [];
    const main = new NightlyBrowserPresentation({
      current: () => true,
      visible: () => true,
      focused: () => focused,
      execute: async (request) => {
        calls.push(request);
        if (request.kind === "attach") return { status: "attached", presentationId: id };
        if (request.kind === "frame") {
          await blocked;
          return { status: "idle" };
        }
        if (request.kind === "input" && request.input.type === "keyDown")
          return { status: "edit-menu-pending", menuId };
        return { status: "accepted" };
      },
    });
    try {
      await main.invoke({ ...owner, kind: "attach" });
      const frame = main.invoke({
        ...owner,
        presentationId: id,
        kind: "frame",
        acknowledgement: 0,
      });
      await vi.waitFor(() => expect(calls.some((request) => request.kind === "frame")).toBe(true));
      const down = main.invoke({
        ...owner,
        presentationId: id,
        kind: "input",
        frameSequence: 1,
        input: { type: "keyDown", keyCode: "F10", modifiers: ["shift"] },
      });
      focused = false;
      await main.releaseInputs();
      focused = true;
      unblock();
      await frame;
      expect(await down).toEqual({ status: "refused" });
      expect(
        calls.some((request) => request.kind === "input" && request.input.type === "keyDown"),
      ).toBe(false);
      expect(calls.some((request) => request.kind === "edit-menu-keyboard")).toBe(false);
    } finally {
      unblock();
      await main.releaseInputs();
      await main.close();
    }
  });

  it("activates one private menu intent on the matching user release without trusting release modifiers", async () => {
    const pendingId = decodeBrowserEditMenuId("00000000-0000-4000-8000-000000000828");
    const menuId = decodeBrowserEditMenuId("00000000-0000-4000-8000-000000000829");
    const calls: HumanBrowserRequest[] = [];
    const main = new NightlyBrowserPresentation({
      current: () => true,
      visible: () => true,
      focused: () => true,
      popupMenu: async () => ({ kind: "selected", id: "5" }),
      execute: async (request, signal) => {
        calls.push(request);
        if (request.kind === "attach") return { status: "attached", presentationId: id };
        if (request.kind === "input" && request.input.type === "keyDown")
          return { status: "edit-menu-pending", menuId: pendingId };
        if (request.kind === "edit-menu")
          return {
            status: "edit-menu",
            menuId,
            flags: {
              undo: false,
              redo: false,
              cut: false,
              copy: false,
              paste: false,
              selectAll: true,
            },
          };
        if (request.kind === "edit-menu-watch") {
          await new Promise<void>((done) => {
            if (signal.aborted) done();
            else signal.addEventListener("abort", () => done(), { once: true });
          });
          return { status: "refused" };
        }
        return { status: "accepted" };
      },
    });
    await main.invoke({ ...owner, kind: "attach" });
    expect(
      await main.invoke({
        ...owner,
        presentationId: id,
        kind: "edit-menu-keyboard",
        menuId: pendingId,
      }),
    ).toEqual({ status: "refused" });
    expect(
      await main.invoke({
        ...owner,
        presentationId: id,
        kind: "input",
        frameSequence: 1,
        input: { type: "keyDown", keyCode: "F10", modifiers: ["shift"] },
      }),
    ).toEqual({ status: "accepted" });
    expect(
      await main.invoke({
        ...owner,
        presentationId: id,
        kind: "input",
        frameSequence: 1,
        input: { type: "keyUp", keyCode: "F10", modifiers: [] },
      }),
    ).toEqual({ status: "accepted" });
    await vi.waitFor(() =>
      expect(calls.some((request) => request.kind === "edit-menu-action")).toBe(true),
    );
    expect(calls.filter((request) => request.kind === "edit-menu-keyboard")).toEqual([
      { ...owner, presentationId: id, kind: "edit-menu-keyboard", menuId: pendingId },
    ]);
    expect(calls.find((request) => request.kind === "edit-menu-action")).toEqual({
      ...owner,
      presentationId: id,
      kind: "edit-menu-action",
      menuId,
      action: "selectAll",
    });
    await main.close();
  });

  it.each([false, true])(
    "releases and retires a late pending key after focus loss with focus returned %s",
    async (refocused) => {
      let focused = true;
      const menuId = decodeBrowserEditMenuId("00000000-0000-4000-8000-000000000819");
      let finish: (result: HumanBrowserResult) => void = () => {};
      const held = new Promise<HumanBrowserResult>((done) => {
        finish = done;
      });
      const calls: HumanBrowserRequest[] = [];
      const main = new NightlyBrowserPresentation({
        current: () => true,
        visible: () => true,
        focused: () => focused,
        execute: async (request) => {
          calls.push(request);
          if (request.kind === "attach") return { status: "attached", presentationId: id };
          if (request.kind === "input" && request.input.type === "keyDown") return held;
          return { status: "accepted" };
        },
      });
      await main.invoke({ ...owner, kind: "attach" });
      const pending = main.invoke({
        ...owner,
        presentationId: id,
        kind: "input",
        frameSequence: 1,
        input: { type: "keyDown", keyCode: "F10", modifiers: ["shift"] },
      });
      await vi.waitFor(() => expect(calls.some((request) => request.kind === "input")).toBe(true));
      focused = false;
      await main.releaseInputs();
      focused = refocused;
      finish({ status: "edit-menu-pending", menuId });
      expect(await pending).toEqual({ status: "refused" });
      expect(calls.some((request) => request.kind === "edit-menu-keyboard")).toBe(false);
      expect(
        calls.some((request) => request.kind === "edit-menu-dismiss" && request.menuId === menuId),
      ).toBe(true);
      expect(
        calls.some(
          (request) =>
            request.kind === "input" &&
            request.input.type === "keyUp" &&
            request.input.keyCode === "F10",
        ),
      ).toBe(true);
      await main.close();
    },
  );

  it("sanitizes a pending menu key and cleanup sends only releases and exact dismissal", async () => {
    const menuId = decodeBrowserEditMenuId("00000000-0000-4000-8000-000000000818");
    const calls: HumanBrowserRequest[] = [];
    const main = new NightlyBrowserPresentation({
      current: () => true,
      visible: () => true,
      focused: () => true,
      execute: async (request) => {
        calls.push(request);
        if (request.kind === "attach") return { status: "attached", presentationId: id };
        if (request.kind === "input" && request.input.type === "keyDown")
          return { status: "edit-menu-pending", menuId };
        return { status: "accepted" };
      },
    });
    await main.invoke({ ...owner, kind: "attach" });
    expect(
      await main.invoke({
        ...owner,
        presentationId: id,
        kind: "input",
        frameSequence: 1,
        input: { type: "keyDown", keyCode: "F10", modifiers: ["shift"] },
      }),
    ).toEqual({ status: "accepted" });
    await main.releaseInputs();
    expect(calls.some((request) => request.kind === "edit-menu-keyboard")).toBe(false);
    expect(
      calls.some((request) => request.kind === "edit-menu-dismiss" && request.menuId === menuId),
    ).toBe(true);
    expect(
      calls
        .filter((request) => request.kind === "input")
        .map((request) => (request.kind === "input" ? request.input.type : undefined)),
    ).toEqual(["keyDown", "keyUp"]);
    await main.close();
  });

  it("opens a fixed page menu only from accepted pointer intent and cancels on source retirement", async () => {
    const menuId = decodeBrowserEditMenuId("00000000-0000-4000-8000-000000000809");
    let retire: (() => void) | undefined;
    const retired = new Promise<void>((done) => {
      retire = done;
    });
    let popupSignal: AbortSignal | undefined;
    const requests: HumanBrowserRequest[] = [];
    const main = new NightlyBrowserPresentation({
      current: () => true,
      visible: () => true,
      focused: () => true,
      popupMenu: async (_request, signal) => {
        popupSignal = signal;
        await new Promise<void>((done) => {
          if (signal.aborted) done();
          else signal.addEventListener("abort", () => done(), { once: true });
        });
        return { kind: "dismissed" };
      },
      execute: async (request) => {
        requests.push(request);
        if (request.kind === "attach") return { status: "attached", presentationId: id };
        if (request.kind === "edit-menu")
          return {
            status: "edit-menu",
            menuId,
            flags: {
              undo: true,
              redo: false,
              cut: false,
              copy: false,
              paste: false,
              selectAll: true,
            },
          };
        if (request.kind === "edit-menu-watch") {
          await retired;
          return { status: "refused" };
        }
        return { status: "accepted" };
      },
    });
    await main.invoke({ ...owner, kind: "attach" });
    expect(
      await main.invoke({
        ...owner,
        presentationId: id,
        kind: "edit-menu-action",
        menuId,
        action: "copy",
      }),
    ).toEqual({ status: "refused" });
    expect(requests).toHaveLength(1);
    await main.invoke({
      ...owner,
      presentationId: id,
      kind: "input",
      frameSequence: 1,
      input: { type: "mouseDown", x: 10, y: 20, button: "right", clickCount: 1 },
    });
    await main.invoke({
      ...owner,
      presentationId: id,
      kind: "input",
      frameSequence: 1,
      input: { type: "mouseUp", x: 10, y: 20, button: "right", clickCount: 1 },
    });
    await vi.waitFor(() => expect(popupSignal).toBeDefined());
    retire?.();
    await vi.waitFor(() => expect(popupSignal?.aborted).toBe(true));
    await vi.waitFor(() =>
      expect(requests.some((request) => request.kind === "edit-menu-dismiss")).toBe(true),
    );
    expect(requests.some((request) => request.kind === "edit-menu-action")).toBe(false);
    await main.close();
  });

  it("refuses hidden, unfocused or retired owners and renderer-supplied ownership flags before dispatch", async () => {
    let visible = true;
    let focused = false;
    let current = true;
    const calls: HumanBrowserRequest[] = [];
    const main = new NightlyBrowserPresentation({
      visible: () => visible,
      focused: () => focused,
      current: () => current,
      execute: async (request) => {
        calls.push(request);
        return request.kind === "attach"
          ? { status: "attached", presentationId: id }
          : { status: "accepted" };
      },
    });
    await main.invoke({ ...owner, kind: "attach" });
    expect(await main.invoke(input("char"))).toEqual({ status: "refused" });
    expect(await main.invoke({ ...input("char"), focused: true })).toEqual({ status: "refused" });
    focused = true;
    visible = false;
    expect(await main.invoke(input("char"))).toEqual({ status: "refused" });
    visible = true;
    current = false;
    expect(await main.invoke(input("char"))).toEqual({ status: "refused" });
    current = true;
    visible = true;
    focused = false;
    expect(
      await main.invoke({
        ...owner,
        kind: "composition",
        presentationId: id,
        composition: { phase: "begin", editorId: "00000000-0000-4000-8000-000000000805" },
      }),
    ).toEqual({ status: "refused" });
    expect(calls).toHaveLength(1);
    await main.close();
  });

  it("coalesces pointer floods without dropping character or release events", async () => {
    const calls: HumanBrowserRequest[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const main = new NightlyBrowserPresentation({
      visible: () => true,
      focused: () => true,
      current: () => true,
      execute: async (request) => {
        calls.push(request);
        if (request.kind === "attach") return { status: "attached", presentationId: id };
        if (request.kind === "frame") await held;
        return { status: "accepted" };
      },
    });
    await main.invoke({ ...owner, kind: "attach" });
    const frame = main.invoke({ ...owner, kind: "frame", presentationId: id, acknowledgement: 0 });
    await Promise.resolve();
    const moves = Array.from({ length: 100 }, (_, x) =>
      main.invoke({
        ...owner,
        kind: "input",
        presentationId: id,
        frameSequence: 1,
        input: { type: "mouseMove", x, y: 1, button: "left", clickCount: 0 },
      }),
    );
    const down = main.invoke(input("keyDown"));
    const char = main.invoke(input("char"));
    const up = main.invoke(input("keyUp"));
    release?.();
    expect(await down).toEqual({ status: "accepted" });
    expect(await char).toEqual({ status: "accepted" });
    expect(await up).toEqual({ status: "accepted" });
    await frame;
    await Promise.all(moves);
    expect(
      calls
        .filter((request) => request.kind === "input")
        .map((request) => (request.kind === "input" ? request.input.type : "")),
    ).toEqual(["mouseMove", "keyDown", "char", "keyUp"]);
    await main.close();
  });

  it("keeps a composition terminal operation ordered after its newest update during a pointer flood", async () => {
    const calls: HumanBrowserRequest[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const compositionId = decodeBrowserCompositionId("00000000-0000-4000-8000-000000000804");
    const editorId = "00000000-0000-4000-8000-000000000805";
    const main = new NightlyBrowserPresentation({
      current: () => true,
      visible: () => true,
      focused: () => true,
      execute: async (request) => {
        calls.push(request);
        if (request.kind === "attach") return { status: "attached", presentationId: id };
        if (request.kind === "composition" && request.composition.phase === "begin")
          return { status: "composition-started", compositionId };
        if (request.kind === "frame") await held;
        return { status: "accepted" };
      },
    });
    await main.invoke({ ...owner, kind: "attach" });
    expect(
      await main.invoke({
        ...owner,
        kind: "composition",
        presentationId: id,
        composition: { phase: "begin", editorId },
      }),
    ).toEqual({ status: "composition-started", compositionId });
    const frame = main.invoke({ ...owner, kind: "frame", presentationId: id, acknowledgement: 0 });
    await Promise.resolve();
    const pending = Array.from({ length: 40 }, (_, n) =>
      main.invoke({
        ...owner,
        kind: "input",
        presentationId: id,
        frameSequence: 1,
        input: { type: "mouseMove", x: n, y: 1, button: "left", clickCount: 0 },
      }),
    );
    pending.push(main.invoke({ ...owner, kind: "editor", presentationId: id }));
    pending.push(main.invoke({ ...owner, kind: "state", presentationId: id }));
    const update = main.invoke({
      ...owner,
      kind: "composition",
      presentationId: id,
      composition: {
        phase: "update",
        compositionId,
        text: "é",
        selectionStart: 1,
        selectionEnd: 1,
      },
    });
    const committed = main.invoke({
      ...owner,
      kind: "composition",
      presentationId: id,
      composition: { phase: "commit", compositionId, text: "é" },
    });
    release?.();
    expect(await update).toEqual({ status: "accepted" });
    expect(await committed).toEqual({ status: "accepted" });
    await frame;
    await Promise.all(pending);
    expect(
      calls
        .filter((request) => request.kind === "composition")
        .map((request) => request.composition.phase),
    ).toEqual(["begin", "update", "commit"]);
    await main.close();
  });

  it("delivers every keystroke typed while a frame request is delayed", async () => {
    const calls: HumanBrowserRequest[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const main = new NightlyBrowserPresentation({
      visible: () => true,
      focused: () => true,
      current: () => true,
      execute: async (request) => {
        calls.push(request);
        if (request.kind === "attach") return { status: "attached", presentationId: id };
        if (request.kind === "frame") await held;
        return { status: "accepted" };
      },
    });
    await main.invoke({ ...owner, kind: "attach" });
    const frame = main.invoke({ ...owner, kind: "frame", presentationId: id, acknowledgement: 0 });
    await Promise.resolve();
    const typed = ["a", "b", "c", "d", "e"].flatMap((keyCode) =>
      (["keyDown", "char", "keyUp"] as const).map((type) =>
        main.invoke({ ...input(type), input: { type, keyCode } }),
      ),
    );
    release?.();
    expect(await Promise.all(typed)).toEqual(typed.map(() => ({ status: "accepted" })));
    await frame;
    expect(
      calls
        .filter((request) => request.kind === "input")
        .map((request) =>
          request.kind === "input" && request.input.type === "char" ? request.input.keyCode : "",
        )
        .filter((keyCode) => keyCode !== ""),
    ).toEqual(["a", "b", "c", "d", "e"]);
    await main.close();
  });

  it("hides more than four presentations without competing for the public queue", async () => {
    const hidden: string[] = [];
    const main = new NightlyBrowserPresentation({
      visible: () => true,
      focused: () => true,
      current: () => true,
      execute: async (request): Promise<HumanBrowserResult> => {
        if (request.kind === "attach") return { status: "attached", presentationId: id };
        if (request.kind === "layout" && !request.layout.visible)
          hidden.push(String(request.contextId));
        return { status: "accepted" };
      },
    });
    for (let n = 0; n < 8; n += 1)
      await main.invoke(
        decodeHumanBrowserRequest({
          ...owner,
          contextId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
          kind: "attach",
        }),
      );
    await Promise.all([main.hide(), main.hide()]);
    expect(new Set(hidden).size).toBe(8);
    expect(await main.invoke(input("char"))).toEqual({ status: "refused" });
    await main.close();
  });
});

describe("page popups in Nightly's embedded Browser", () => {
  const popupId = decodeBrowserPagePopupId("00000000-0000-4000-8000-000000000901");
  async function presented(
    present: NonNullable<ConstructorParameters<typeof NightlyBrowserPresentation>[0]["pagePopup"]>,
    popup: HumanBrowserResult = {
      status: "popup",
      popup: { kind: "dialog", id: popupId, dialog: "confirm", message: "Leave?" },
    },
    stable: {
      readonly focused?: () => boolean;
      readonly watch?: () => Promise<HumanBrowserResult>;
      readonly offerAgain?: boolean;
      /** Held before Stable answers a popup poll, as its bounded wait is. */
      readonly beforePopup?: () => Promise<void>;
    } = {},
  ) {
    const calls: HumanBrowserRequest[] = [];
    let offered = false;
    const main = new NightlyBrowserPresentation({
      current: () => true,
      visible: () => true,
      focused: stable.focused ?? (() => true),
      pagePopup: present,
      execute: async (request) => {
        calls.push(request);
        if (request.kind === "attach") return { status: "attached", presentationId: id };
        if (request.kind === "popup-watch" && stable.watch !== undefined) return stable.watch();
        if (request.kind === "popup") {
          await stable.beforePopup?.();
          if (offered && stable.offerAgain !== true) {
            await new Promise((done) => setTimeout(done, 20));
            return { status: "idle" };
          }
          offered = true;
          return popup;
        }
        return { status: "accepted" };
      },
    });
    await main.invoke({ ...owner, kind: "attach" });
    await main.invoke({
      ...owner,
      presentationId: id,
      kind: "layout",
      layout: { width: 800, height: 600, visible: true },
    });
    return { main, calls };
  }

  it("releases a held page button before the native popup and refuses its later physical release", async () => {
    let offer = () => {};
    const heldPoll = new Promise<void>((done) => {
      offer = done;
    });
    const shown = vi.fn(async () => undefined);
    const { main, calls } = await presented(shown, undefined, { beforePopup: () => heldPoll });
    const pointer = (type: "mouseDown" | "mouseUp") => ({
      ...owner,
      presentationId: id,
      kind: "input",
      frameSequence: 1,
      input: { type, x: 120, y: 120, button: "left", clickCount: 1 },
    });
    try {
      expect(await main.invoke(pointer("mouseDown"))).toEqual({ status: "accepted" });
      offer();
      await vi.waitFor(() => expect(shown).toHaveBeenCalledTimes(1));
      const releases = () =>
        calls.filter((request) => request.kind === "input" && request.input.type === "mouseUp");
      expect(releases()).toHaveLength(1);
      expect(await main.invoke(pointer("mouseUp"))).toEqual({ status: "refused" });
      expect(releases()).toHaveLength(1);
    } finally {
      offer();
      await main.close();
    }
  });

  it("shows a captured dialog natively and returns the person's answer once", async () => {
    const shown = vi.fn(async () => ({ kind: "dialog" as const, accept: true }));
    const { main, calls } = await presented(shown);
    await vi.waitFor(() =>
      expect(calls.filter((request) => request.kind === "popup-answer")).toHaveLength(1),
    );
    expect(shown).toHaveBeenCalledTimes(1);
    expect(calls.find((request) => request.kind === "popup-answer")).toMatchObject({
      popupId,
      answer: { kind: "dialog", accept: true },
    });
    await main.close();
  });

  it("dismisses a popup the person closed without choosing", async () => {
    const { main, calls } = await presented(async () => undefined);
    await vi.waitFor(() =>
      expect(calls.some((request) => request.kind === "popup-dismiss")).toBe(true),
    );
    expect(calls.some((request) => request.kind === "popup-answer")).toBe(false);
    await main.close();
  });

  it("keeps the person's new presses out of the page while a popup is open", async () => {
    let close: (answer: undefined) => void = () => {};
    const { main, calls } = await presented(
      (_popup, _placement, signal) =>
        new Promise((done) => {
          close = done;
          signal.addEventListener("abort", () => done(undefined), { once: true });
        }),
    );
    await vi.waitFor(() => expect(calls.some((request) => request.kind === "popup")).toBe(true));
    await new Promise((done) => setTimeout(done, 10));
    expect(await main.invoke(input("keyDown"))).toEqual({ status: "refused" });
    close(undefined);
    await vi.waitFor(() =>
      expect(calls.some((request) => request.kind === "popup-dismiss")).toBe(true),
    );
    expect(await main.invoke(input("keyDown"))).toEqual({ status: "accepted" });
    await main.close();
  });

  it("closes an open popup when its presentation detaches and answers nothing", async () => {
    const shown = vi.fn(
      (_popup: unknown, _placement: unknown, signal: AbortSignal) =>
        new Promise<undefined>((done) => {
          signal.addEventListener("abort", () => done(undefined), { once: true });
        }),
    );
    const { main, calls } = await presented(shown);
    await vi.waitFor(() => expect(shown).toHaveBeenCalled());
    await main.invoke({ ...owner, presentationId: id, kind: "detach" });
    await vi.waitFor(() =>
      expect(calls.some((request) => request.kind === "popup-dismiss")).toBe(true),
    );
    expect(calls.some((request) => request.kind === "popup-answer")).toBe(false);
    await main.close();
  });

  it("refuses popup requests from the renderer", async () => {
    const { main, calls } = await presented(async () => undefined);
    for (const raw of [
      { ...owner, presentationId: id, kind: "popup" },
      { ...owner, presentationId: id, kind: "popup-dismiss", popupId },
      {
        ...owner,
        presentationId: id,
        kind: "popup-answer",
        popupId,
        answer: { kind: "dialog", accept: true },
      },
    ])
      expect(await main.invoke(decodeHumanBrowserRequest(raw))).toEqual({ status: "refused" });
    expect(calls.filter((request) => request.kind === "popup-answer")).toHaveLength(0);
    await main.close();
  });

  it("closes its own sheet when Stable retires the popup", async () => {
    let retire: (result: HumanBrowserResult) => void = () => {};
    const shown = vi.fn(
      (_popup: unknown, _placement: unknown, signal: AbortSignal) =>
        new Promise<{ kind: "dialog"; accept: boolean } | undefined>((done) => {
          signal.addEventListener("abort", () => done({ kind: "dialog", accept: true }), {
            once: true,
          });
        }),
    );
    const { main, calls } = await presented(shown, undefined, {
      watch: () =>
        new Promise((done) => {
          retire = done;
        }),
    });
    await vi.waitFor(() => expect(shown).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(calls.some((request) => request.kind === "popup-watch")).toBe(true),
    );
    retire({ status: "refused" });
    // The sheet closed because the page closed its dialog: nothing is answered.
    await vi.waitFor(() =>
      expect(calls.some((request) => request.kind === "popup-dismiss")).toBe(true),
    );
    expect(calls.some((request) => request.kind === "popup-answer")).toBe(false);
    await main.close();
  });

  it("never shows the same pending popup twice", async () => {
    const shown = vi.fn(async () => undefined);
    const { main, calls } = await presented(shown, undefined, { offerAgain: true });
    await vi.waitFor(() =>
      expect(calls.filter((request) => request.kind === "popup").length).toBeGreaterThan(2),
    );
    expect(shown).toHaveBeenCalledTimes(1);
    await main.close();
  });

  it("asks Stable for nothing while its window is not focused", async () => {
    const shown = vi.fn(async () => undefined);
    const { main, calls } = await presented(shown, undefined, { focused: () => false });
    await new Promise((done) => setTimeout(done, 300));
    expect(calls.some((request) => request.kind === "popup")).toBe(false);
    expect(shown).not.toHaveBeenCalled();
    await main.close();
  });

  it("leaves a popup pending when the window lost focus while the poll waited", async () => {
    let focused = true;
    let answerPoll: () => void = () => {};
    const held = new Promise<void>((done) => {
      answerPoll = done;
    });
    const shown = vi.fn(async () => undefined);
    const { main, calls } = await presented(shown, undefined, {
      focused: () => focused,
      offerAgain: true,
      beforePopup: () => held,
    });
    await vi.waitFor(() => expect(calls.some((request) => request.kind === "popup")).toBe(true));
    // The held poll resolves after focus moved away.
    focused = false;
    answerPoll();
    await new Promise((done) => setTimeout(done, 100));
    expect(shown).not.toHaveBeenCalled();
    expect(calls.some((request) => request.kind === "popup-dismiss")).toBe(false);
    focused = true;
    await vi.waitFor(() => expect(shown).toHaveBeenCalledTimes(1));
    await main.close();
  });
});

describe("the accessibility mirror in Nightly's embedded Browser", () => {
  const read = { ...owner, presentationId: id, kind: "accessibility", revision: 0 } as const;
  const press = {
    ...owner,
    presentationId: id,
    kind: "accessibility-action",
    revision: 1,
    nodeId: "0-2",
    action: { action: "press" },
  } as const;
  const mirrored: HumanBrowserResult = {
    status: "accessibility",
    update: {
      kind: "full",
      revision: 1,
      rootId: "0-1",
      truncated: false,
      nodes: [
        { id: "0-1", role: "document", children: ["0-2"] },
        { id: "0-2", role: "button", name: "Save", children: [] },
      ],
    },
  };
  async function presented(
    options: {
      readonly assistive?: () => boolean;
      readonly focused?: () => boolean;
      readonly visibleLayout?: boolean;
      readonly hold?: Promise<void>;
    } = {},
  ) {
    const calls: HumanBrowserRequest[] = [];
    const main = new NightlyBrowserPresentation({
      current: () => true,
      visible: () => true,
      focused: options.focused ?? (() => true),
      assistiveTechnology: options.assistive ?? (() => true),
      execute: async (request) => {
        calls.push(request);
        if (request.kind === "attach") return { status: "attached", presentationId: id };
        if (request.kind === "accessibility") {
          await options.hold;
          return mirrored;
        }
        return { status: "accepted" };
      },
    });
    await main.invoke({ ...owner, kind: "attach" });
    await main.invoke({
      ...owner,
      presentationId: id,
      kind: "layout",
      layout: { width: 800, height: 600, visible: options.visibleLayout ?? true },
    });
    return { main, calls };
  }

  it("asks Stable for the mirror and acts through it only while an assistive technology is on", async () => {
    let on = false;
    const { main, calls } = await presented({ assistive: () => on });
    expect(await main.invoke(read)).toEqual({ status: "refused" });
    expect(await main.invoke(press)).toEqual({ status: "refused" });
    expect(calls.some((request) => request.kind.startsWith("accessibility"))).toBe(false);
    on = true;
    expect(await main.invoke(read)).toEqual(mirrored);
    expect(await main.invoke(press)).toEqual({ status: "accepted" });
    await main.close();
  });

  it("asks for nothing while the Browser view is hidden and acts only while focused", async () => {
    const hidden = await presented({ visibleLayout: false });
    expect(await hidden.main.invoke(read)).toEqual({ status: "refused" });
    expect(hidden.calls.some((request) => request.kind === "accessibility")).toBe(false);
    await hidden.main.close();
    const unfocused = await presented({ focused: () => false });
    expect(await unfocused.main.invoke(press)).toEqual({ status: "refused" });
    expect(unfocused.calls.some((request) => request.kind === "accessibility-action")).toBe(false);
    await unfocused.main.close();
  });

  it("holds one mirror ask open without delaying the person's typing", async () => {
    let release = () => {};
    const hold = new Promise<void>((done) => {
      release = done;
    });
    const { main } = await presented({ hold });
    const pending = main.invoke(read);
    // A second ask for the same presentation while one is held is refused.
    expect(await main.invoke(read)).toEqual({ status: "refused" });
    expect(await main.invoke(input("keyDown"))).toEqual({ status: "accepted" });
    release();
    expect(await pending).toEqual(mirrored);
    await main.close();
  });
});
