import { dialog, Notification, screen, type BrowserWindow } from "electron";
import {
  MAX_BROWSER_CHOSEN_FILES,
  MAX_BROWSER_CHOSEN_PATH,
  type BrowserContextAction,
  type HumanBrowserPagePopup,
  type HumanBrowserPopupAnswer,
} from "@octant/contracts/browser-presentation";
import type { NativeMenuEntry } from "@octant/contracts/shell";
import { popupNativeMenu } from "./nativeContextMenus";
import type { NightlyPagePopupPlacement } from "./nightlyBrowserPresentation";

export const NIGHTLY_DIALOGS_ANSWERED_NOTICE =
  "A page kept opening dialogs, so Octant answered the rest for this page.";

/**
 * Open panels still on screen, per window. Electron's `showOpenDialog` takes no
 * abort signal and has no call that closes the panel, so a panel whose popup
 * Stable retired stays until the person closes it. Its result is then ignored,
 * and every later popup for that window waits for it instead of stacking a
 * second modal over it.
 */
const openPanels = new WeakMap<BrowserWindow, Promise<unknown>>();

/** Resolve undefined on abort; the awaited work may still settle later and is ignored. */
function unlessAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((done) => {
    const aborted = () => done(undefined);
    signal.addEventListener("abort", aborted, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        done(signal.aborted ? undefined : value);
      },
      () => {
        signal.removeEventListener("abort", aborted);
        done(undefined);
      },
    );
  });
}

/** The presentation route body bound; a longer file answer is refused before it is sent. */
const MAX_ANSWER_BYTES = 15_360;

type MenuPopup = Extract<HumanBrowserPagePopup, { kind: "select" | "context" }>;
export interface NightlyPageMenu {
  readonly items: ReadonlyArray<NativeMenuEntry>;
  /** The selected option's entry, placed under the anchor like a native select list. */
  readonly positioningItem: number | undefined;
  readonly answer: (id: string) => HumanBrowserPopupAnswer | undefined;
}

/**
 * Nightly's own native menu for a page select list or link menu. Page labels
 * are display copy only; a selected entry maps back to a fixed answer.
 */
export function nightlyPageMenu(popup: MenuPopup): NightlyPageMenu {
  if (popup.kind === "context") {
    const actions: ReadonlyArray<readonly [BrowserContextAction, string, boolean]> = [
      ["open-link", "Open Link in New Tab", popup.link],
      ["copy-link", "Copy Link Address", popup.link],
      ["copy-image", "Copy Image", popup.image],
      ["copy-image-address", "Copy Image Address", popup.image],
    ];
    const items: NativeMenuEntry[] = [];
    actions.forEach(([, label, offered], index) => {
      if (!offered) return;
      if (index === 2 && items.length > 0) items.push({ kind: "separator" });
      items.push({ kind: "item", id: String(index), label, enabled: true });
    });
    return {
      items,
      positioningItem: undefined,
      answer: (id) => {
        const action = actions[Number(id)];
        return action === undefined || !action[2] || !/^\d$/.test(id)
          ? undefined
          : { kind: "context", action: action[0] };
      },
    };
  }
  const items: NativeMenuEntry[] = [];
  let group: string | undefined;
  let positioningItem: number | undefined;
  popup.options.forEach((option, index) => {
    if (option.group !== group) {
      if (items.length > 0) items.push({ kind: "separator" });
      group = option.group;
      if (group !== undefined && group.trim() !== "")
        items.push({ kind: "item", id: `${String(index)}.0`, label: group, enabled: false });
    }
    if (index === popup.selectedIndex) positioningItem = items.length;
    items.push({
      kind: "radio",
      id: String(index),
      label: option.label.trim() === "" ? "—" : option.label,
      enabled: !option.disabled,
      checked: index === popup.selectedIndex,
    });
  });
  return {
    items,
    positioningItem,
    answer: (id) => {
      if (!/^\d{1,3}$/.test(id)) return undefined;
      const index = Number(id);
      return popup.options[index]?.disabled === false ? { kind: "select", index } : undefined;
    },
  };
}

/** Fixed copy around a page dialog; the page's own text is never the heading. */
export function nightlyPageDialog(popup: Extract<HumanBrowserPagePopup, { kind: "dialog" }>): {
  readonly message: string;
  readonly detail: string;
  readonly buttons: ReadonlyArray<string>;
  readonly cancelId: number;
} {
  if (popup.dialog === "beforeunload")
    return {
      message: "Leave this page?",
      detail: "Changes you made may not be saved.",
      buttons: ["Leave", "Stay"],
      cancelId: 1,
    };
  return {
    message: "This page says",
    detail: popup.message,
    buttons: popup.dialog === "confirm" ? ["OK", "Cancel"] : ["OK"],
    cancelId: popup.dialog === "confirm" ? 1 : 0,
  };
}

/** The person's chosen files, or undefined when they exceed what the page may be handed. */
export function nightlyChosenFiles(
  paths: ReadonlyArray<string>,
  multiple: boolean,
): HumanBrowserPopupAnswer | undefined {
  if (
    paths.length === 0 ||
    paths.length > (multiple ? MAX_BROWSER_CHOSEN_FILES : 1) ||
    paths.some(
      (path) =>
        !path.startsWith("/") ||
        path.length > MAX_BROWSER_CHOSEN_PATH ||
        path.includes("\0") ||
        !path.isWellFormed(),
    ) ||
    new TextEncoder().encode(JSON.stringify(paths)).byteLength > MAX_ANSWER_BYTES
  )
    return undefined;
  return { kind: "file", paths: [...paths] };
}

/**
 * Show a page popup in Nightly's own window: a select list or link menu as a
 * native menu at the press, a page dialog as a sheet on the window, and a
 * file chooser as Nightly's own open panel.
 */
export async function presentNightlyPagePopup(
  window: BrowserWindow,
  popup: HumanBrowserPagePopup,
  placement: NightlyPagePopupPlacement,
  signal: AbortSignal,
): Promise<HumanBrowserPopupAnswer | undefined> {
  if (window.isDestroyed() || signal.aborted) return undefined;
  const panel = openPanels.get(window);
  if (panel !== undefined) {
    await unlessAborted(panel, signal);
    if (window.isDestroyed() || signal.aborted) return undefined;
  }
  if (popup.kind === "select" || popup.kind === "context") {
    const menu = nightlyPageMenu(popup);
    const zoom = window.webContents.getZoomFactor();
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getContentBounds();
    let x = (cursor.x - bounds.x) / zoom;
    let y = (cursor.y - bounds.y) / zoom;
    // The pointer's page point and the cursor give the Browser image's origin,
    // so a select list opens at its own field rather than wherever the cursor is.
    if (popup.kind === "select" && placement.pointer !== undefined) {
      x += popup.anchor.x - placement.pointer.x;
      y +=
        popup.anchor.y -
        placement.pointer.y +
        (process.platform === "darwin" ? 0 : popup.anchor.height);
    }
    const outcome = await popupNativeMenu(window, { x, y, items: menu.items }, signal, {
      maxEntries: 1_024,
      ...(process.platform === "darwin" && menu.positioningItem !== undefined
        ? { positioningItem: menu.positioningItem }
        : {}),
    });
    return outcome.kind === "selected" ? menu.answer(outcome.id) : undefined;
  }
  if (popup.kind === "dialog") {
    // Electron has no sheet scoped to part of a window, so a page dialog is
    // window-modal; Stable's per-load dialog limit keeps a page from
    // holding the window this way.
    const shown = nightlyPageDialog(popup);
    const { response } = await dialog.showMessageBox(window, {
      type: "none",
      message: shown.message,
      detail: shown.detail,
      buttons: [...shown.buttons],
      defaultId: 0,
      cancelId: shown.cancelId,
      noLink: true,
      signal,
    });
    if (signal.aborted) return undefined;
    return { kind: "dialog", accept: response === 0 };
  }
  if (popup.kind === "notice") {
    // Told once and without a modal, so the page cannot hold the window this way.
    if (Notification.isSupported())
      new Notification({ title: "Octant Nightly", body: NIGHTLY_DIALOGS_ANSWERED_NOTICE }).show();
    return undefined;
  }
  const opened = dialog.showOpenDialog(window, {
    properties: popup.multiple ? ["openFile", "multiSelections"] : ["openFile"],
  });
  const settled = opened.then(
    () => undefined,
    () => undefined,
  );
  openPanels.set(window, settled);
  void settled.then(() => {
    if (openPanels.get(window) === settled) openPanels.delete(window);
  });
  // A retired chooser stops waiting at once; the panel's later choice reaches nothing.
  const chosen = await unlessAborted(opened, signal);
  if (chosen === undefined || chosen.canceled || signal.aborted) return undefined;
  return nightlyChosenFiles(chosen.filePaths, popup.multiple);
}
