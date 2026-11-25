import type { RefObject } from "react";
import {
  BOTTOM_TERMINAL_SLOT,
  dockTerminalSlot,
  TERMINAL_SURFACE_ATTRIBUTE,
  paneTerminalSlot,
  type TerminalShellFacts,
} from "./terminalSlot";
import type { PaneId, WorkspaceLayoutNode } from "@octant/contracts";

/** One place an open terminal stands, and the thread whose shell it shows. */
export type TerminalPlace = {
  readonly threadId: string;
  /** What the place is, for a reader of a test or a log. */
  readonly label: string;
} & (
  | { readonly kind: "pane"; readonly paneId: PaneId; readonly surfaceId: string }
  | { readonly kind: "bottom" }
  | { readonly kind: "dock"; readonly tabId: string }
);

export function terminalSlotKey(place: TerminalPlace): string {
  if (place.kind === "pane") return paneTerminalSlot(place.paneId, place.surfaceId);
  return place.kind === "bottom" ? BOTTOM_TERMINAL_SLOT : dockTerminalSlot(place.tabId);
}

export interface TerminalPlaceInput {
  /** The panes on screen; a pane a focused or narrow window hides is not in it. */
  readonly layout?: WorkspaceLayoutNode;
  /** The thread whose bottom panel is on screen with a Terminal among its tabs. */
  readonly bottomThreadId?: string;
  /** The dock on screen and the thread it belongs to. */
  readonly dock?: {
    readonly threadId: string;
    readonly tabs: ReadonlyArray<{ readonly id: string; readonly surface: string }>;
    /** Tabs standing as a card on the shelf, which are not terminals to type in. */
    readonly minimised: ReadonlyArray<string>;
  };
}

/**
 * Every open terminal the window has on screen or one tab behind it, in the
 * order cycling walks them: panes as laid out, then the bottom panel under the
 * thread, then the dock's sessions in tab order. A pane shows one surface, so a
 * terminal it has replaced is not open anywhere and is not listed.
 */
export function listThreadTerminals(input: TerminalPlaceInput): ReadonlyArray<TerminalPlace> {
  const places: Array<TerminalPlace> = [];
  const visit = (node: WorkspaceLayoutNode): void => {
    if (node.kind === "split") {
      visit(node.first);
      visit(node.second);
      return;
    }
    if (node.surface.kind !== "code-terminal") return;
    places.push({
      kind: "pane",
      paneId: node.paneId,
      surfaceId: String(node.surface.id),
      threadId: String(node.surface.threadId),
      label: `pane ${node.surface.title}`,
    });
  };
  if (input.layout !== undefined) visit(input.layout);
  const bottom = input.bottomThreadId;
  if (bottom !== undefined) {
    places.push({ kind: "bottom", threadId: bottom, label: "bottom panel" });
  }
  const dock = input.dock;
  for (const tab of dock?.tabs ?? []) {
    if (dock === undefined || tab.surface !== "terminal") continue;
    if (dock.minimised.includes(tab.id)) continue;
    // The panel's Terminal and the dock's first one are one view of one shell,
    // and it stands in one region at a time.
    if (bottom !== undefined && tab.id === "terminal") continue;
    places.push({
      kind: "dock",
      tabId: tab.id,
      threadId: dock.threadId,
      label: `dock ${tab.id}`,
    });
  }
  return places;
}

export interface TerminalCycle {
  /** Moves the caret from the terminal in `fromSlot` to the one beside it. */
  readonly cycle: (fromSlot: string, direction: "next" | "previous") => void;
  /**
   * A mounted terminal says how to take the caret, and whether it takes typing
   * (a shell that exited is a readable replay); the return value forgets it.
   */
  readonly register: (slot: string, focus: () => void, takesInput: boolean) => () => void;
}

/** How long a terminal brought to the front may take to attach and take the caret. */
const MOUNT_DEADLINE_MS = 15_000;

/**
 * Cycles the caret through one thread's terminals.
 *
 * `read` answers with what is open now and how to bring one forward. A session
 * behind another is not mounted until it is shown, so the caret waits for it,
 * and gives up if the person has gone anywhere else in the meantime: a terminal
 * that attaches late must never pull the keyboard out of the composer.
 */
export function createTerminalCycle(
  read: () => {
    readonly places: ReadonlyArray<TerminalPlace>;
    readonly show: (place: TerminalPlace) => void;
  },
): TerminalCycle {
  const mounted = new Map<string, { readonly focus: () => void; readonly takesInput: boolean }>();
  let abandonPending: (() => void) | undefined;
  let pending: { readonly slot: string; readonly threadId: string } | undefined;

  const forgetPending = (): void => {
    pending = undefined;
    abandonPending?.();
    abandonPending = undefined;
  };
  const caretIsFree = (): boolean => {
    const active = globalThis.document?.activeElement;
    return (
      active === null ||
      active === undefined ||
      active === globalThis.document.body ||
      active.closest(`[${TERMINAL_SURFACE_ATTRIBUTE}]`) !== null
    );
  };

  return {
    cycle: (fromSlot, direction) => {
      const { places, show } = read();
      const from = places.find((place) => terminalSlotKey(place) === fromSlot);
      if (from === undefined) return;
      // A pane draws only what it holds, so one with no running terminal has
      // nowhere to type. A session behind a tab mounts when shown, and one that
      // turns out to have exited still takes the caret, so the chord goes on.
      const open = places.filter((place) => {
        if (place.threadId !== from.threadId) return false;
        const key = terminalSlotKey(place);
        return place.kind !== "pane" || key === fromSlot || mounted.get(key)?.takesInput === true;
      });
      const index = open.findIndex((place) => terminalSlotKey(place) === fromSlot);
      if (index < 0 || open.length < 2) return;
      const target = open[(index + (direction === "next" ? 1 : -1) + open.length) % open.length];
      if (target === undefined) return;
      const slot = terminalSlotKey(target);
      forgetPending();
      show(target);
      const standing = mounted.get(slot);
      if (standing !== undefined) {
        standing.focus();
        return;
      }
      pending = { slot, threadId: from.threadId };
      const abandon = (): void => forgetPending();
      const deadline = setTimeout(abandon, MOUNT_DEADLINE_MS);
      globalThis.document?.addEventListener("pointerdown", abandon, true);
      abandonPending = () => {
        clearTimeout(deadline);
        globalThis.document?.removeEventListener("pointerdown", abandon, true);
      };
    },
    register: (slot, focus, takesInput) => {
      const standing = { focus, takesInput };
      mounted.set(slot, standing);
      if (pending?.slot === slot) {
        const { threadId } = pending;
        forgetPending();
        // A dock tab's name repeats from thread to thread.
        const sameThread = read().places.some(
          (place) => terminalSlotKey(place) === slot && place.threadId === threadId,
        );
        if (sameThread && caretIsFree()) focus();
      }
      return () => {
        if (mounted.get(slot) === standing) mounted.delete(slot);
      };
    },
  };
}

/** What the shell's facts come to: the places, and how to bring one forward. */
function readShell(facts: TerminalShellFacts): {
  readonly places: ReadonlyArray<TerminalPlace>;
  readonly show: (place: TerminalPlace) => void;
} {
  const { bottom, dock, layout } = facts;
  // The narrow window's dock is a modal drawer, with the panes inert behind it.
  const panes = facts.narrow && dock.open ? undefined : layout;
  const bottomThreadId =
    bottom.open && bottom.tabs.some((tab) => tab.surface === "terminal")
      ? dock.threadId
      : undefined;
  return {
    places: listThreadTerminals({
      ...(panes === undefined ? {} : { layout: panes }),
      ...(bottomThreadId === undefined ? {} : { bottomThreadId }),
      ...(dock.threadId === undefined || !dock.open
        ? {}
        : { dock: { threadId: dock.threadId, tabs: dock.tabs, minimised: dock.minimised } }),
    }),
    show: (place) => {
      if (place.kind === "pane") void facts.activatePane(place.paneId);
      else if (place.kind === "dock") facts.selectDockTab(place.tabId);
      else if (bottom.shown !== "terminal") facts.openBottomTool("terminal");
    },
  };
}

const cycles = new WeakMap<object, TerminalCycle>();

/** The one cycle a shell's terminals share. */
export function terminalCycleFor(shell: RefObject<TerminalShellFacts | undefined>): TerminalCycle {
  let cycle = cycles.get(shell);
  if (cycle === undefined) {
    cycle = createTerminalCycle(() =>
      shell.current === undefined
        ? { places: [], show: () => undefined }
        : readShell(shell.current),
    );
    cycles.set(shell, cycle);
  }
  return cycle;
}
