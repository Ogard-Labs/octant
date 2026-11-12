import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

/** The tools that get a button of their own in the title band, left to right. */
export const DOCK_TOOL_BUTTON_ORDER: ReadonlyArray<RightUtilityDockSurfaceId> = [
  "environment",
  "terminal",
  "review",
  "browser",
  "files",
];

/** Why a tool in the band cannot open yet while the pane's task has no thread. */
export const DOCK_TOOLS_AWAIT_TASK_START = "Available once the task starts";
const DOCK_TOOLS_CAPS_FULL = "Close a tool to make room";

/**
 * The Browser is one tool with pages. Showing it again returns to the page on
 * screen, else the focused one, else the page last shown, else the first.
 */
export function browserPageToShow(input: {
  readonly browserTabIds: ReadonlyArray<string>;
  readonly shownTabIds: ReadonlyArray<string>;
  readonly activeTabId?: string | undefined;
  readonly lastBrowserTabId?: string | undefined;
}): string | undefined {
  const isPage = (id: string | undefined): id is string =>
    id !== undefined && input.browserTabIds.includes(id);
  return (
    input.shownTabIds.find((id) => isPage(id)) ??
    (isPage(input.activeTabId) ? input.activeTabId : undefined) ??
    (isPage(input.lastBrowserTabId) ? input.lastBrowserTabId : undefined) ??
    input.browserTabIds[0]
  );
}

/** What pressing a tool's button does; the dock's own actions carry it out. */
export type DockToolPress =
  /** The tool is already shown in a closed (or reader-hidden) dock: bring the dock back. */
  | { readonly kind: "open-dock" }
  /** The tool is shown in the bottom panel while a reader hides it: leave the reader. */
  | { readonly kind: "reveal" }
  | { readonly kind: "open-beside" }
  | { readonly kind: "show-beside"; readonly tabId: string }
  | { readonly kind: "close"; readonly tabIds: ReadonlyArray<string> }
  | { readonly kind: "close-bottom" }
  | { readonly kind: "refused" };

export interface DockToolButton {
  readonly id: RightUtilityDockSurfaceId;
  readonly label: string;
  /** Shown, and the place that shows it is on screen. */
  readonly pressed: boolean;
  /** Open in the dock but not on screen in it. */
  readonly open: boolean;
  /** Why pressing does nothing; absent when it does something. */
  readonly disabledReason?: string;
  readonly press: DockToolPress;
}

export interface DockToolButtonsModel {
  /** The tools with a button of their own, in band order. */
  readonly buttons: ReadonlyArray<DockToolButton>;
  /** Every other tool the thread can use, in catalogue order, for the More menu. */
  readonly more: ReadonlyArray<DockToolButton>;
}

export const NO_DOCK_TOOL_BUTTONS: DockToolButtonsModel = { buttons: [], more: [] };

export interface DockToolButtonsInput {
  /** Tools this thread can use now, in catalogue order. */
  readonly surfaces: ReadonlyArray<{
    readonly id: RightUtilityDockSurfaceId;
    readonly label: string;
  }>;
  /** Tools a draft task will have once its thread exists. */
  readonly awaitingThread?: ReadonlyArray<{
    readonly id: RightUtilityDockSurfaceId;
    readonly label: string;
  }>;
  /** The dock's open tabs as the person sees them. */
  readonly tabs: ReadonlyArray<{
    readonly id: string;
    readonly surface: RightUtilityDockSurfaceId;
  }>;
  readonly shownTabIds: ReadonlyArray<string>;
  readonly activeTabId?: string | undefined;
  readonly lastBrowserTabId?: string | undefined;
  /** The dock is open for this thread, even if a reader is hiding it. */
  readonly dockOpen: boolean;
  /** The dock is on screen. */
  readonly dockPresentedOpen: boolean;
  /** Tools the open bottom panel holds. */
  readonly bottomHeld: ReadonlyArray<RightUtilityDockSurfaceId>;
  readonly bottomPresentedOpen: boolean;
  /** Both columns are at their limit, so a tool not shown has no room. */
  readonly capsFull: boolean;
}

function describeButton(
  tool: { readonly id: RightUtilityDockSurfaceId; readonly label: string },
  input: DockToolButtonsInput,
): DockToolButton {
  const tabs = input.tabs.filter((tab) => tab.surface === tool.id);
  const shown = tabs.filter((tab) => input.shownTabIds.includes(tab.id));
  const base = { id: tool.id, label: tool.label };
  const [firstShown] = shown;
  if (firstShown !== undefined) {
    return {
      ...base,
      pressed: input.dockPresentedOpen,
      open: false,
      press: input.dockPresentedOpen
        ? {
            kind: "close",
            // The Browser closes every page, as the dock's own close does; a
            // second shell is closed one at a time.
            tabIds: tool.id === "browser" ? tabs.map((tab) => tab.id) : [firstShown.id],
          }
        : { kind: "open-dock" },
    };
  }
  if (input.bottomHeld.includes(tool.id)) {
    return {
      ...base,
      pressed: input.bottomPresentedOpen,
      open: false,
      press: input.bottomPresentedOpen ? { kind: "close-bottom" } : { kind: "reveal" },
    };
  }
  if (input.capsFull) {
    return {
      ...base,
      pressed: false,
      open: tabs.length > 0,
      disabledReason: DOCK_TOOLS_CAPS_FULL,
      press: { kind: "refused" },
    };
  }
  if (tabs.length === 0) {
    return { ...base, pressed: false, open: false, press: { kind: "open-beside" } };
  }
  const tabId =
    tool.id === "browser"
      ? browserPageToShow({
          browserTabIds: tabs.map((tab) => tab.id),
          shownTabIds: input.shownTabIds,
          activeTabId: input.activeTabId,
          lastBrowserTabId: input.lastBrowserTabId,
        })
      : tabs[0]?.id;
  return {
    ...base,
    pressed: false,
    open: true,
    press: tabId === undefined ? { kind: "refused" } : { kind: "show-beside", tabId },
  };
}

/**
 * The row of tool buttons in the title band: which tools have a button, and
 * for each whether it reads pressed, open, or disabled and what pressing does.
 * The same model drives the buttons and the dispatcher, so what a button
 * promises is what a press does.
 */
export function buildDockToolButtons(input: DockToolButtonsInput): DockToolButtonsModel {
  const awaiting = input.awaitingThread ?? [];
  const tools = [
    ...input.surfaces,
    ...awaiting.filter((tool) => !input.surfaces.some((candidate) => candidate.id === tool.id)),
  ];
  const described = tools.map((tool): DockToolButton => {
    if (!input.surfaces.some((candidate) => candidate.id === tool.id)) {
      return {
        id: tool.id,
        label: tool.label,
        pressed: false,
        open: false,
        disabledReason: DOCK_TOOLS_AWAIT_TASK_START,
        press: { kind: "refused" },
      };
    }
    return describeButton(tool, input);
  });
  const dedicated = DOCK_TOOL_BUTTON_ORDER.flatMap((id) => {
    const button = described.find((candidate) => candidate.id === id);
    return button === undefined ? [] : [button];
  });
  return {
    buttons: dedicated,
    more: described.filter((button) => !DOCK_TOOL_BUTTON_ORDER.includes(button.id)),
  };
}
