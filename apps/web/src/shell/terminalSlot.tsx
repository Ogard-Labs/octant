import type { PaneId, WorkspaceLayoutNode } from "@octant/contracts";
import { createContext, type ReactNode, type RefObject } from "react";

// The window's first load carries only this: where a terminal stands, and what
// the shell has open. Walking them (`terminalCycle`) loads with the terminal
// adapter, since only a running terminal can ask for it.

/** A running terminal's own element, set by the terminal adapter. */
export const TERMINAL_SURFACE_ATTRIBUTE = "data-terminal-surface";

export const BOTTOM_TERMINAL_SLOT = "bottom";
export const dockTerminalSlot = (tabId: string): string => `dock:${tabId}`;
export const paneTerminalSlot = (paneId: PaneId, surfaceId: string): string =>
  `pane:${paneId}:${surfaceId}`;

export interface TerminalDockFacts {
  /** The thread the dock and bottom panel belong to, when it is a Code thread. */
  readonly threadId: string | undefined;
  readonly tabs: ReadonlyArray<{ readonly id: string; readonly surface: string }>;
}

/** What the shell has open, as its newest render saw it. */
export interface TerminalShellFacts {
  /** The panes on screen; a pane a focused or narrow window hides is not in it. */
  readonly layout: WorkspaceLayoutNode | undefined;
  readonly narrow: boolean;
  readonly dock: TerminalDockFacts & {
    readonly open: boolean;
    /** Tabs standing as a card on the shelf, which are not terminals to type in. */
    readonly minimised: ReadonlyArray<string>;
  };
  readonly bottom: {
    readonly open: boolean;
    readonly tabs: ReadonlyArray<{ readonly surface: string }>;
    readonly shown: string | undefined;
  };
  readonly activatePane: (paneId: PaneId) => unknown;
  readonly selectDockTab: (tabId: string) => void;
  readonly openBottomTool: (surface: "terminal") => void;
}

/** One object for the life of the shell, so no terminal re-renders with it. */
export const TerminalShellContext = createContext<
  RefObject<TerminalShellFacts | undefined> | undefined
>(undefined);

/**
 * Names where the terminal inside stands. A terminal with no place (a card's
 * preview, Zen, a Project's own shell) is never cycled into.
 */
export const TerminalSlotContext = createContext<string | undefined>(undefined);

export function TerminalSlot(props: {
  readonly slot: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <TerminalSlotContext.Provider value={props.slot}>{props.children}</TerminalSlotContext.Provider>
  );
}
