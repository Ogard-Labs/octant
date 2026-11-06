import {
  decodeHumanBrowserRequest,
  type HumanBrowserRequest,
  type HumanBrowserResult,
  type HumanBrowserLayout,
  type BrowserCompositionId,
} from "@octant/contracts/browser-presentation";

import type { NativeMenuRequest, NativeMenuOutcome } from "@octant/contracts/shell";
import type {
  BrowserEditAction,
  BrowserEditMenuId,
  HumanBrowserPagePopup,
  HumanBrowserPopupAnswer,
} from "@octant/contracts/browser-presentation";

/** Where the person last pressed in the Browser image, in its page coordinates. */
export interface NightlyPagePopupPlacement {
  readonly pointer: { readonly x: number; readonly y: number } | undefined;
}

interface Presentation {
  readonly contextId: HumanBrowserRequest["contextId"];
  readonly threadId: HumanBrowserRequest["threadId"];
  readonly presentationId: Extract<HumanBrowserResult, { status: "attached" }>["presentationId"];
  layout: HumanBrowserLayout;
  menuEpoch: number;
}
interface NightlyBrowserPresentationOptions {
  readonly popupMenu?: (
    request: NativeMenuRequest,
    signal: AbortSignal,
  ) => Promise<NativeMenuOutcome>;
  /**
   * Shows a page popup Stable captured as Nightly's own native menu, sheet or
   * open panel, and returns the person's answer; undefined dismisses it.
   */
  readonly pagePopup?: (
    popup: HumanBrowserPagePopup,
    placement: NightlyPagePopupPlacement,
    signal: AbortSignal,
  ) => Promise<HumanBrowserPopupAnswer | undefined>;
  readonly current: () => boolean;
  readonly visible: () => boolean;
  readonly focused: () => boolean;
  readonly execute: (
    request: HumanBrowserRequest,
    signal: AbortSignal,
  ) => Promise<HumanBrowserResult>;
}
interface KeyboardMenu {
  readonly id: BrowserEditMenuId;
  readonly owner: Extract<HumanBrowserRequest, { kind: "input" }>;
  closing?: Promise<void>;
}
interface Pending {
  readonly inputEpoch: number;
  readonly menuEpoch: number;
  request: HumanBrowserRequest;
  readonly internal: boolean;
  readonly promise: Promise<HumanBrowserResult>;
  readonly resolve: (result: HumanBrowserResult) => void;
}
const refused = (): HumanBrowserResult => ({ status: "refused" });
const MAX_QUEUED_REQUESTS = 4;
const MAX_QUEUED_DISCRETE_INPUTS = 64;

/** Only an actual owned window can submit human display and input requests. */
export class NightlyBrowserPresentation {
  readonly #options: NightlyBrowserPresentationOptions;
  readonly #presentations = new Map<string, Presentation>();
  readonly #lifetime = new AbortController();
  readonly #queue: Pending[] = [];
  readonly #keyboardMenus = new Map<string, KeyboardMenu>();
  readonly #held = new Map<string, Extract<HumanBrowserRequest, { kind: "input" }>>();
  readonly #compositions = new Map<
    string,
    {
      readonly owner: Extract<HumanBrowserRequest, { kind: "composition" }>;
      readonly id: BrowserCompositionId;
      terminal: boolean;
    }
  >();
  readonly #popupWatches = new Map<string, AbortController>();
  readonly #popupTasks = new Set<Promise<void>>();
  readonly #popupOpen = new Set<string>();
  readonly #pointers = new Map<string, { readonly x: number; readonly y: number }>();
  #pageMenu: AbortController | undefined;
  #pageMenuPresentation: Presentation | undefined;
  readonly #pageMenuTasks = new Set<Promise<void>>();
  #active: Pending | undefined;
  #running: Promise<void> | undefined;
  #hide: Promise<void> | undefined;
  #hidden = false;
  #visibilityEpoch = 0;
  #inputEpoch = 0;

  constructor(options: NightlyBrowserPresentationOptions) {
    this.#options = options;
  }

  invoke(raw: unknown): Promise<HumanBrowserResult> {
    try {
      const request = decodeHumanBrowserRequest(raw);
      if (
        [
          "edit-menu",
          "edit-menu-watch",
          "edit-menu-action",
          "edit-menu-dismiss",
          "edit-menu-keyboard",
          "popup",
          "popup-answer",
          "popup-dismiss",
          "popup-watch",
        ].includes(request.kind)
      )
        return Promise.resolve(refused());
      return this.#enqueue(request, false);
    } catch {
      return Promise.resolve(refused());
    }
  }

  surfaceCommand(raw: unknown, kind: "command" | "tab"): Promise<HumanBrowserResult> {
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("contextId" in raw) ||
      !("threadId" in raw) ||
      !("command" in raw) ||
      typeof raw.contextId !== "string" ||
      typeof raw.threadId !== "string" ||
      Object.keys(raw).some((key) => !["contextId", "threadId", "command"].includes(key))
    )
      return Promise.resolve(refused());
    const owned = this.#presentations.get(raw.contextId);
    if (owned === undefined || String(owned.threadId) !== raw.threadId)
      return Promise.resolve(refused());
    return this.invoke({
      contextId: owned.contextId,
      threadId: owned.threadId,
      presentationId: owned.presentationId,
      kind,
      command: raw.command,
    });
  }

  #enqueue(request: HumanBrowserRequest, internal: boolean): Promise<HumanBrowserResult> {
    if (this.#lifetime.signal.aborted) return Promise.resolve(refused());
    const composition = request.kind === "composition" ? request.composition : undefined;
    const activeComposition = this.#compositions.get(String(request.contextId));
    const terminal = composition?.phase === "commit" || composition?.phase === "cancel";
    if (composition !== undefined && request.kind === "composition") {
      if (composition.phase === "begin") {
        if (activeComposition !== undefined) return Promise.resolve(refused());
      } else {
        if (
          activeComposition?.id !== composition.compositionId ||
          activeComposition.owner.presentationId !== request.presentationId
        )
          return Promise.resolve(refused());
        if (activeComposition.terminal) {
          const queued = this.#queue.find(
            (entry) =>
              entry.request.kind === "composition" &&
              entry.request.composition.phase !== "begin" &&
              entry.request.composition.compositionId === activeComposition.id &&
              ["commit", "cancel"].includes(entry.request.composition.phase),
          );
          if (internal && composition.phase === "cancel") {
            if (
              queued !== undefined &&
              queued.request.kind === "composition" &&
              queued.request.composition.phase === "cancel"
            )
              return queued.promise;
            if (queued !== undefined) {
              this.#queue.splice(this.#queue.indexOf(queued), 1);
              queued.resolve(refused());
            }
            activeComposition.terminal = false;
          } else return Promise.resolve(refused());
        }
      }
    }
    const replaceable = replaceableKey(request);
    const existing =
      replaceable === undefined
        ? undefined
        : this.#queue.find((pending) => replaceableKey(pending.request) === replaceable);
    if (existing !== undefined) {
      existing.request = request;
      return existing.promise;
    }
    const release = releaseKey(request);
    if (release !== undefined) {
      const held =
        this.#held.has(release) ||
        downKey(this.#active?.request) === release ||
        this.#queue.some((pending) => downKey(pending.request) === release);
      if (!held) return Promise.resolve(refused());
      const queued = this.#queue.find((pending) => releaseKey(pending.request) === release);
      if (queued !== undefined) return queued.promise;
    }
    // A person's discrete key, character, button and wheel events are not
    // expendable like frames and pointer motion: dropping one while a frame
    // request is slow leaves the page with incomplete text. They queue under
    // their own larger bound so a burst of typing is delivered in order, while
    // other requests keep the small bound.
    const discrete = discreteInput(request);
    if (
      !internal &&
      release === undefined &&
      !terminal &&
      this.#queue.filter(
        (pending) =>
          !pending.internal &&
          releaseKey(pending.request) === undefined &&
          discreteInput(pending.request) === discrete,
      ).length >= (discrete ? MAX_QUEUED_DISCRETE_INPUTS : MAX_QUEUED_REQUESTS)
    )
      return Promise.resolve(refused());
    if (terminal && activeComposition !== undefined) activeComposition.terminal = true;
    let resolve: Pending["resolve"] = () => {};
    const promise = new Promise<HumanBrowserResult>((done) => {
      resolve = done;
    });
    const pending: Pending = {
      request,
      internal,
      promise,
      resolve,
      inputEpoch: this.#inputEpoch,
      menuEpoch: this.#presentations.get(String(request.contextId))?.menuEpoch ?? 0,
    };
    if (internal) this.#queue.unshift(pending);
    else if (release !== undefined) {
      // Preserve down/character/up order while bypassing replaceable motion.
      let after = 0;
      for (let index = 0; index < this.#queue.length; index += 1) {
        const queued = this.#queue[index];
        if (queued?.request.kind === "input" && queued.request.input.type !== "mouseMove")
          after = index + 1;
      }
      this.#queue.splice(after, 0, pending);
    } else this.#queue.push(pending);
    this.#running ??= this.#drain();
    return promise;
  }

  async #drain(): Promise<void> {
    // Defer once so assigning #running precedes a synchronously empty queue.
    await Promise.resolve();
    while (this.#queue.length > 0) {
      const pending = this.#queue.shift();
      if (pending === undefined) break;
      this.#active = pending;
      pending.resolve(
        await this.#dispatch(
          pending.request,
          pending.internal,
          pending.inputEpoch,
          pending.menuEpoch,
        ).catch(refused),
      );
      this.#active = undefined;
    }
    this.#running = undefined;
  }

  async #dispatch(
    request: HumanBrowserRequest,
    internal: boolean,
    queuedEpoch: number,
    queuedMenuEpoch: number,
  ): Promise<HumanBrowserResult> {
    if (
      !internal &&
      request.kind === "input" &&
      menuKeyDown(request.input) &&
      queuedEpoch !== this.#inputEpoch
    )
      return refused();
    if (!this.#options.current() || this.#lifetime.signal.aborted) return refused();
    const owned = this.#presentations.get(String(request.contextId));
    if (
      request.kind !== "attach" &&
      (owned?.presentationId !== request.presentationId ||
        String(owned.threadId) !== String(request.threadId))
    )
      return refused();
    if (
      !internal &&
      request.kind === "input" &&
      ["keyDown", "char", "mouseDown"].includes(request.input.type) &&
      (queuedMenuEpoch !== owned?.menuEpoch || this.#pageMenuPresentation === owned)
    ) {
      // A native popup can consume releases without blurring the window. New
      // presses belong to that popup; only already-owned releases reach the page.
      if (request.input.type === "mouseDown" && this.#pageMenuPresentation === owned)
        this.#pageMenu?.abort();
      return refused();
    }
    if (
      !internal &&
      request.kind === "input" &&
      ["keyDown", "char", "mouseDown"].includes(request.input.type) &&
      owned !== undefined &&
      this.#popupOpen.has(String(owned.presentationId))
    )
      return refused();
    if (
      ["attach", "layout", "detach", "command", "tab"].includes(request.kind) ||
      (request.kind === "input" &&
        (request.input.type === "mouseDown" || menuKeyDown(request.input)))
    )
      this.#pageMenu?.abort();
    const hiding = request.kind === "layout" && !request.layout.visible;
    if (!hiding && request.kind !== "detach" && (this.#hidden || !this.#options.visible()))
      return refused();
    if (
      (request.kind === "input" || request.kind === "editor" || request.kind === "composition") &&
      !this.#options.focused() &&
      !(
        internal &&
        (releaseKey(request) !== undefined ||
          (request.kind === "composition" && request.composition.phase === "cancel"))
      )
    )
      return refused();
    if (
      request.kind === "composition" &&
      request.composition.phase !== "begin" &&
      this.#compositions.get(String(request.contextId))?.id !== request.composition.compositionId
    )
      return refused();
    if (request.kind === "attach" && this.#presentations.size >= 16 && owned === undefined)
      return refused();
    if (downKey(request) !== undefined && this.#held.size >= 32) return refused();
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(2_000)]);
    const keyboard = this.#keyboardMenus.get(String(request.contextId));
    const inputEpoch = this.#inputEpoch;
    let returnedKeyboard: KeyboardMenu | undefined;
    let result = await new Promise<HumanBrowserResult>((resolve) => {
      const aborted = () => resolve(refused());
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) {
        signal.removeEventListener("abort", aborted);
        resolve(refused());
        return;
      }
      void this.#options
        .execute(request, signal)
        .then(resolve, () => resolve(refused()))
        .finally(() => signal.removeEventListener("abort", aborted));
    });
    if (!this.#options.current() || this.#lifetime.signal.aborted || signal.aborted)
      return refused();
    if (result.status === "edit-menu-pending") {
      if (
        request.kind !== "input" ||
        request.input.type !== "keyDown" ||
        !menuKeyDown(request.input) ||
        internal
      )
        return refused();
      returnedKeyboard = { id: result.menuId, owner: request };
      this.#keyboardMenus.set(String(request.contextId), returnedKeyboard);
      result = { status: "accepted" };
    }
    if ((result.status === "attached" && request.kind === "attach") || request.kind === "detach") {
      if (keyboard !== undefined) await this.#retireKeyboard(keyboard);
      for (const [key, held] of this.#held)
        if (String(held.contextId) === String(request.contextId)) this.#held.delete(key);
    }
    if (result.status === "attached" && request.kind === "attach") {
      if (owned !== undefined) this.#stopPopupWatch(owned);
      const attached: Presentation = {
        contextId: request.contextId,
        threadId: request.threadId,
        presentationId: result.presentationId,
        layout: { width: 800, height: 600, visible: false },
        menuEpoch: 0,
      };
      this.#presentations.set(String(request.contextId), attached);
      this.#startPopupWatch(attached);
    }
    if (request.kind === "layout" && owned !== undefined && result.status === "accepted")
      owned.layout = request.layout;
    if (request.kind === "detach") {
      if (owned !== undefined) this.#stopPopupWatch(owned);
      this.#presentations.delete(String(request.contextId));
      this.#compositions.delete(String(request.contextId));
    }
    if (request.kind === "attach" && result.status === "attached")
      this.#compositions.delete(String(request.contextId));
    if (request.kind === "composition") {
      if (request.composition.phase === "begin" && result.status === "composition-started")
        this.#compositions.set(String(request.contextId), {
          owner: request,
          id: result.compositionId,
          terminal: false,
        });
      else if (request.composition.phase === "cancel" || request.composition.phase === "commit")
        this.#compositions.delete(String(request.contextId));
    }
    if (request.kind === "input" && result.status === "accepted") {
      if (request.input.type === "mouseDown")
        this.#pointers.set(String(request.presentationId), {
          x: request.input.x,
          y: request.input.y,
        });
      const down = downKey(request);
      const up = releaseKey(request);
      if (down !== undefined) this.#held.set(down, request);
      if (up !== undefined) this.#held.delete(up);
    }
    if (
      (request.kind === "frame" || request.kind === "input") &&
      (this.#hidden ||
        !this.#options.visible() ||
        (request.kind === "input" &&
          !this.#options.focused() &&
          !(internal && releaseKey(request) !== undefined)) ||
        (returnedKeyboard !== undefined && inputEpoch !== this.#inputEpoch))
    ) {
      if (returnedKeyboard !== undefined) {
        const retiring = this.#retireKeyboard(returnedKeyboard);
        const original = returnedKeyboard.owner;
        if (original.input.type === "keyDown") {
          const released = await this.#options
            .execute(
              { ...original, input: { ...original.input, type: "keyUp" } },
              AbortSignal.timeout(1000),
            )
            .catch(refused);
          const held = downKey(original);
          if (
            released.status === "accepted" &&
            held !== undefined &&
            this.#held.get(held) === original
          )
            this.#held.delete(held);
        }
        await retiring;
      }
      return refused();
    }
    if (request.kind === "frame" && result.status === "refused") this.#pageMenu?.abort();
    if (
      keyboard !== undefined &&
      this.#keyboardMenus.get(String(request.contextId)) === keyboard &&
      request.kind === "input" &&
      request.input.type === "keyUp" &&
      keyboard.owner.input.type === "keyDown" &&
      request.input.keyCode === keyboard.owner.input.keyCode &&
      result.status === "accepted" &&
      !internal
    ) {
      const task = this.#openPageMenu(request, keyboard);
      this.#pageMenuTasks.add(task);
      void task.finally(() => this.#pageMenuTasks.delete(task));
    }

    if (
      request.kind === "input" &&
      request.input.type === "mouseUp" &&
      request.input.button === "right" &&
      result.status === "accepted"
    ) {
      const task = this.#openPageMenu(request);
      this.#pageMenuTasks.add(task);
      void task.finally(() => this.#pageMenuTasks.delete(task));
    }
    return result.status === "edit-menu" ? refused() : result;
  }

  async #openPageMenu(
    owner: Extract<HumanBrowserRequest, { kind: "input" }>,
    keyboard?: KeyboardMenu,
  ): Promise<void> {
    const popup = this.#options.popupMenu;
    if (popup === undefined) {
      if (keyboard !== undefined) await this.#retireKeyboard(keyboard);
      return;
    }
    const presentation = this.#presentations.get(String(owner.contextId));
    if (presentation?.presentationId !== owner.presentationId) return;
    this.#pageMenu?.abort();
    const owned = new AbortController();
    this.#pageMenu = owned;
    this.#pageMenuPresentation = presentation;
    presentation.menuEpoch++;
    const signal = AbortSignal.any([owned.signal, this.#lifetime.signal]);
    const current = () =>
      !signal.aborted &&
      this.#pageMenu === owned &&
      this.#options.current() &&
      this.#options.visible() &&
      !this.#hidden &&
      this.#presentations.get(String(owner.contextId))?.presentationId === owner.presentationId;
    const base = {
      contextId: owner.contextId,
      threadId: owner.threadId,
      presentationId: owner.presentationId,
    };
    const execute = (request: HumanBrowserRequest) =>
      this.#options
        .execute(request, AbortSignal.any([signal, AbortSignal.timeout(1500)]))
        .catch(refused);
    let menu: Extract<HumanBrowserResult, { status: "edit-menu" }> | undefined;
    try {
      if (keyboard !== undefined) {
        if (!current() || !this.#options.focused()) return;
        const activated = await execute({
          ...base,
          kind: "edit-menu-keyboard",
          menuId: keyboard.id,
        });
        if (activated.status !== "accepted" || !current() || !this.#options.focused()) return;
      }
      const end = Date.now() + 750;
      while (current() && Date.now() < end) {
        const result = await execute({ ...base, kind: "edit-menu" });
        if (result.status === "edit-menu") {
          menu = result;
          break;
        }
        if (result.status !== "idle") return;
        await new Promise<void>((done) => setTimeout(done, 25));
      }
      if (menu === undefined || !current() || !this.#options.focused()) return;
      // Release modifiers/buttons before AppKit can consume their physical ups.
      // Keep this scoped to the captured presentation and never activate cleanup.
      for (const request of [...this.#held.values()]) {
        if (
          String(request.contextId) !== String(owner.contextId) ||
          request.presentationId !== owner.presentationId
        )
          continue;
        const event = request.input;
        let released: HumanBrowserResult;
        if (event.type === "keyDown")
          released = await this.#enqueue({ ...request, input: { ...event, type: "keyUp" } }, true);
        else if (event.type === "mouseDown")
          released = await this.#enqueue(
            { ...request, input: { ...event, type: "mouseUp" } },
            true,
          );
        else continue;
        if (released.status !== "accepted" || !current()) return;
      }
      const selectedMenu = menu;
      const actions: ReadonlyArray<readonly [BrowserEditAction, string]> = [
        ["undo", "Undo"],
        ["redo", "Redo"],
        ["cut", "Cut"],
        ["copy", "Copy"],
        ["paste", "Paste"],
        ["selectAll", "Select All"],
      ];
      const watch = (async () => {
        while (current()) {
          const result = await execute({
            ...base,
            kind: "edit-menu-watch",
            menuId: selectedMenu.menuId,
          });
          if (result.status !== "accepted") {
            owned.abort();
            break;
          }
        }
      })();
      const outcome = await popup(
        {
          x: 0,
          y: 0,
          items: actions.map(([action, label], index) => ({
            kind: "item",
            id: String(index),
            label,
            enabled: selectedMenu.flags[action],
          })),
        },
        signal,
      );
      if (outcome.kind === "selected" && current() && this.#options.focused()) {
        const action = actions.find((_entry, index) => String(index) === outcome.id)?.[0];
        if (action !== undefined)
          await execute({ ...base, kind: "edit-menu-action", menuId: selectedMenu.menuId, action });
      }
      owned.abort();
      await watch;
    } catch {
      /* A retired native popup cannot revive its source. */
    } finally {
      owned.abort();
      presentation.menuEpoch++;
      if (this.#pageMenu === owned) {
        this.#pageMenu = undefined;
        this.#pageMenuPresentation = undefined;
      }
      if (keyboard !== undefined) await this.#retireKeyboard(keyboard);
      if (menu !== undefined)
        await this.#options
          .execute(
            { ...base, kind: "edit-menu-dismiss", menuId: menu.menuId },
            AbortSignal.timeout(1000),
          )
          .catch(refused);
    }
  }

  #startPopupWatch(presentation: Presentation): void {
    if (this.#options.pagePopup === undefined || this.#lifetime.signal.aborted) return;
    const owned = new AbortController();
    this.#popupWatches.set(String(presentation.presentationId), owned);
    const task = this.#watchPopups(
      presentation,
      AbortSignal.any([owned.signal, this.#lifetime.signal]),
    ).catch(() => undefined);
    this.#popupTasks.add(task);
    void task.finally(() => this.#popupTasks.delete(task));
  }

  #stopPopupWatch(presentation: Presentation): void {
    const key = String(presentation.presentationId);
    this.#popupWatches.get(key)?.abort();
    this.#popupWatches.delete(key);
    this.#pointers.delete(key);
  }

  /**
   * Ask Stable for the next page popup of one presentation and show it locally.
   * Stable holds the request open briefly, so an idle page costs one bounded
   * request at a time; a hidden or unfocused window asks for nothing.
   */
  async #watchPopups(presentation: Presentation, signal: AbortSignal): Promise<void> {
    const present = this.#options.pagePopup;
    if (present === undefined) return;
    const base = {
      contextId: presentation.contextId,
      threadId: presentation.threadId,
      presentationId: presentation.presentationId,
    };
    const key = String(presentation.presentationId);
    const current = () =>
      !signal.aborted &&
      this.#options.current() &&
      this.#presentations.get(String(presentation.contextId)) === presentation;
    const pause = (ms: number) =>
      new Promise<void>((done) => {
        const timer = setTimeout(finish, ms);
        function finish() {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          done();
        }
        signal.addEventListener("abort", finish, { once: true });
      });
    let shownId: string | undefined;
    const presentable = () =>
      !this.#hidden &&
      this.#options.visible() &&
      this.#options.focused() &&
      presentation.layout.visible;
    while (current()) {
      if (!presentable()) {
        await pause(250);
        continue;
      }
      const next = await this.#options
        .execute({ ...base, kind: "popup" }, AbortSignal.any([signal, AbortSignal.timeout(2_000)]))
        .catch(refused);
      if (!current()) return;
      if (next.status !== "popup") {
        if (next.status !== "idle") await pause(250);
        continue;
      }
      // The poll is held open; the window may have lost focus or hidden while
      // it waited. The popup stays pending in Stable for the next focused poll.
      if (!presentable()) continue;
      const popup = next.popup;
      // A popup already shown and still pending is never shown again; Stable
      // retires or replaces it.
      if (String(popup.id) === shownId) {
        await pause(250);
        continue;
      }
      shownId = String(popup.id);
      const shown = new AbortController();
      const popupSignal = AbortSignal.any([signal, shown.signal]);
      // Close Nightly's own sheet or menu as soon as Stable retires the popup,
      // as when the page closed its own dialog.
      const retired = (async () => {
        while (!popupSignal.aborted) {
          const started = Date.now();
          const watched = await this.#options
            .execute(
              { ...base, kind: "popup-watch", popupId: popup.id },
              AbortSignal.any([popupSignal, AbortSignal.timeout(2_000)]),
            )
            .catch(refused);
          if (popupSignal.aborted) return;
          if (watched.status !== "accepted") {
            shown.abort();
            return;
          }
          // Stable holds a watch open; one that returns at once must not spin.
          if (Date.now() - started < 50) await pause(250);
        }
      })();
      this.#popupOpen.add(key);
      presentation.menuEpoch++;
      let answer: HumanBrowserPopupAnswer | undefined;
      try {
        // AppKit can consume the physical releases of keys and buttons held
        // when a native popup opens; release them in the page first.
        for (const request of [...this.#held.values()]) {
          if (request.presentationId !== presentation.presentationId) continue;
          const event = request.input;
          if (event.type === "keyDown")
            await this.#enqueue({ ...request, input: { ...event, type: "keyUp" } }, true);
          else if (event.type === "mouseDown")
            await this.#enqueue({ ...request, input: { ...event, type: "mouseUp" } }, true);
        }
        if (!current()) return;
        answer = await present(popup, { pointer: this.#pointers.get(key) }, popupSignal).catch(
          () => undefined,
        );
      } finally {
        const retiredByStable = shown.signal.aborted;
        shown.abort();
        await retired;
        this.#popupOpen.delete(key);
        presentation.menuEpoch++;
        if (retiredByStable) answer = undefined;
      }
      // An answer needs the same live presentation; Stable refuses a stale one.
      if (answer !== undefined && current())
        await this.#options
          .execute(
            { ...base, kind: "popup-answer", popupId: popup.id, answer },
            AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(2_000)]),
          )
          .catch(refused);
      else
        await this.#options
          .execute(
            { ...base, kind: "popup-dismiss", popupId: popup.id },
            AbortSignal.timeout(1_000),
          )
          .catch(refused);
    }
  }

  #retireKeyboard(owned: KeyboardMenu): Promise<void> {
    if (this.#keyboardMenus.get(String(owned.owner.contextId)) === owned)
      this.#keyboardMenus.delete(String(owned.owner.contextId));
    return (owned.closing ??= this.#options
      .execute(
        {
          contextId: owned.owner.contextId,
          threadId: owned.owner.threadId,
          presentationId: owned.owner.presentationId,
          kind: "edit-menu-dismiss",
          menuId: owned.id,
        },
        AbortSignal.timeout(1000),
      )
      .then(
        () => undefined,
        () => undefined,
      ));
  }

  async releaseInputs(): Promise<void> {
    this.#inputEpoch++;
    this.#pageMenu?.abort();
    const keyboardCleanup = [...this.#keyboardMenus.values()].map((owned) =>
      this.#retireKeyboard(owned),
    );
    for (const owned of [...this.#compositions.values()]) {
      await this.#enqueue(
        { ...owned.owner, composition: { phase: "cancel", compositionId: owned.id } },
        true,
      );
    }
    for (const request of [...this.#held.values()]) {
      if (request.input.type !== "keyDown" && request.input.type !== "mouseDown") continue;
      const event = request.input;
      let result: HumanBrowserResult;
      if (event.type === "keyDown")
        result = await this.#enqueue({ ...request, input: { ...event, type: "keyUp" } }, true);
      else if (event.type === "mouseDown")
        result = await this.#enqueue({ ...request, input: { ...event, type: "mouseUp" } }, true);
      else continue;
      if (result.status !== "accepted")
        console.warn("Octant could not confirm Browser input release.");
    }
    await Promise.all(keyboardCleanup);
  }

  show(): void {
    this.#visibilityEpoch += 1;
    this.#hidden = false;
  }

  hide(): Promise<void> {
    this.#inputEpoch++;
    this.#pageMenu?.abort();
    const keyboardCleanup = [...this.#keyboardMenus.values()].map((owned) =>
      this.#retireKeyboard(owned),
    );
    if (this.#hidden && this.#hide !== undefined) return this.#hide;
    this.#hidden = true;
    const epoch = ++this.#visibilityEpoch;
    if (this.#hide !== undefined) return this.#hide.then(() => this.hide());
    this.#hide = (async () => {
      await Promise.all(keyboardCleanup);
      for (const owned of this.#presentations.values()) {
        if (epoch !== this.#visibilityEpoch || this.#lifetime.signal.aborted) break;
        const result = await this.#enqueue(
          {
            contextId: owned.contextId,
            threadId: owned.threadId,
            presentationId: owned.presentationId,
            kind: "layout",
            layout: { ...owned.layout, visible: false },
          },
          true,
        );
        if (result.status !== "accepted")
          console.warn("Octant could not confirm hidden Browser presentation cleanup.");
      }
      if (epoch === this.#visibilityEpoch && this.#hidden) {
        this.#held.clear();
        this.#compositions.clear();
      }
    })().finally(() => {
      this.#hide = undefined;
    });
    return this.#hide;
  }

  async close(): Promise<void> {
    this.#inputEpoch++;
    this.#pageMenu?.abort();
    const keyboardCleanup = [...this.#keyboardMenus.values()].map((owned) =>
      this.#retireKeyboard(owned),
    );
    this.#lifetime.abort();
    this.#presentations.clear();
    this.#compositions.clear();
    this.#held.clear();
    await this.#running;
    await this.#hide;
    await Promise.all(this.#pageMenuTasks);
    await Promise.all(this.#popupTasks);
    await Promise.all(keyboardCleanup);
  }
}

function replaceableKey(request: HumanBrowserRequest): string | undefined {
  if (request.kind === "composition" && request.composition.phase === "update")
    return `composition:${request.contextId}:${request.presentationId}:${request.composition.compositionId}`;
  if (request.kind === "frame" || (request.kind === "input" && request.input.type === "mouseMove"))
    return `${request.kind}:${request.contextId}:${request.presentationId}`;
  return undefined;
}
function discreteInput(request: HumanBrowserRequest): boolean {
  return (
    request.kind === "input" &&
    request.input.type !== "mouseMove" &&
    releaseKey(request) === undefined
  );
}
function downKey(request: HumanBrowserRequest | undefined): string | undefined {
  if (request?.kind !== "input") return undefined;
  if (request.input.type === "keyDown") return `${request.contextId}:key:${request.input.keyCode}`;
  if (request.input.type === "mouseDown")
    return `${request.contextId}:button:${request.input.button}`;
  return undefined;
}
function releaseKey(request: HumanBrowserRequest): string | undefined {
  if (request.kind !== "input") return undefined;
  if (request.input.type === "keyUp") return `${request.contextId}:key:${request.input.keyCode}`;
  if (request.input.type === "mouseUp")
    return `${request.contextId}:button:${request.input.button}`;
  return undefined;
}

function menuKeyDown(input: Extract<HumanBrowserRequest, { kind: "input" }>["input"]): boolean {
  return (
    input.type === "keyDown" &&
    (input.keyCode === "ContextMenu" ||
      (input.keyCode === "F10" && input.modifiers?.includes("shift") === true))
  );
}
