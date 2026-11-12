import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";
import {
  MINIMISABLE_DOCK_SURFACES,
  moveUtilityTile,
  showUtilityTabBelow,
  type DockTileLayout,
  type DockTileMove,
  type ThreadUtilityDockState,
} from "./rightUtilityDockSelection";

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
  /** The drawer shows one tool: a press replaces it with a tool that has no tab yet. */
  | { readonly kind: "open" }
  /** The drawer shows one tool: a press replaces it with an open one. */
  | { readonly kind: "select"; readonly tabId: string }
  | { readonly kind: "close"; readonly tabIds: ReadonlyArray<string> }
  /**
   * The Browser or Terminal is shown and pressed again: it becomes a card on
   * the shelf instead of closing, so its session or shell keeps running in view.
   */
  | { readonly kind: "minimise"; readonly tabId: string }
  /** The tool is a card on the shelf: bring it back as a tile, and the dock with it. */
  | { readonly kind: "restore"; readonly tabId: string }
  | { readonly kind: "close-bottom" }
  /** The bottom panel holds the tool behind its active one: show it there. */
  | { readonly kind: "select-bottom" }
  | { readonly kind: "refused" };

/** One row of a tool button's context menu. */
export interface DockToolMenuItem {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

const MOVES: ReadonlyArray<{ readonly direction: DockTileMove; readonly label: string }> = [
  { direction: "left", label: "Move left" },
  { direction: "right", label: "Move right" },
  { direction: "up", label: "Move up" },
  { direction: "down", label: "Move down" },
];

export interface DockToolButton {
  readonly id: RightUtilityDockSurfaceId;
  readonly label: string;
  /** Shown, and the place that shows it is on screen. */
  readonly pressed: boolean;
  /** Open in the dock but not on screen in it. */
  readonly open: boolean;
  /** Open, and standing as a card on the shelf; a press brings it back. */
  readonly minimised?: boolean;
  /** Why pressing does nothing; absent when it does something. */
  readonly disabledReason?: string;
  /** What a press does that the name does not say: it shows in the focused tile's place. */
  readonly note?: string;
  readonly press: DockToolPress;
  /**
   * The open tab the tool stands for: the one shown, else the Browser's page
   * to return to. It is what arranging and dragging act on; absent while the
   * tool has no tab in the dock.
   */
  readonly tabId?: string;
  /** Every open tab of the tool (a Browser's pages, a second shell). */
  readonly tabIds: ReadonlyArray<string>;
  /** What the button's context menu offers, in order; empty means no menu. */
  readonly menu: ReadonlyArray<DockToolMenuItem>;
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
  /** The open tabs whose tool is a card on the shelf. Empty where no shelf is drawn. */
  readonly minimised?: ReadonlyArray<string>;
  /**
   * The dock draws a shelf, so the Browser and the Terminal can be minimised:
   * not in the drawer, and not where the thread has no shelf.
   */
  readonly shelfDrawn?: boolean;
  readonly activeTabId?: string | undefined;
  readonly lastBrowserTabId?: string | undefined;
  /** The dock is open for this thread, even if a reader is hiding it. */
  readonly dockOpen: boolean;
  /** The dock is the one-tool drawer: a press replaces the tool in front. */
  readonly narrow?: boolean;
  /** The tiles the dock shows, which arranging a tool starts from. */
  readonly layout?: DockTileLayout | undefined;
  /** The dock is on screen. */
  readonly dockPresentedOpen: boolean;
  /** Tools the open bottom panel holds. */
  readonly bottomHeld: ReadonlyArray<RightUtilityDockSurfaceId>;
  readonly bottomPresentedOpen: boolean;
  /** The tool the bottom panel shows; it holds others behind it as tabs. */
  readonly bottomActive?: RightUtilityDockSurfaceId | undefined;
  /** Both columns are at their limit, so a tool not shown has no room. */
  readonly capsFull: boolean;
}

function describeButton(
  tool: { readonly id: RightUtilityDockSurfaceId; readonly label: string },
  input: DockToolButtonsInput,
): DockToolButton {
  const tabs = input.tabs.filter((tab) => tab.surface === tool.id);
  const tabIds = tabs.map((tab) => tab.id);
  const shown = tabs.filter((tab) => input.shownTabIds.includes(tab.id));
  const narrow = input.narrow === true;
  const [firstShown] = shown;
  const tabId =
    firstShown !== undefined
      ? firstShown.id
      : tool.id === "browser"
        ? browserPageToShow({
            browserTabIds: tabIds,
            shownTabIds: input.shownTabIds,
            activeTabId: input.activeTabId,
            lastBrowserTabId: input.lastBrowserTabId,
          })
        : tabs[0]?.id;
  const base = {
    id: tool.id,
    label: tool.label,
    tabIds,
    ...(tabId === undefined ? {} : { tabId }),
  };
  const minimisable =
    input.shelfDrawn === true && !narrow && MINIMISABLE_DOCK_SURFACES.has(tool.id);
  const cards = input.minimised ?? [];
  const cardTab = minimisable ? tabs.find((tab) => cards.includes(tab.id)) : undefined;
  const menu = (): ReadonlyArray<DockToolMenuItem> =>
    toolMenu(tool, input, tabId, firstShown !== undefined, minimisable, cardTab !== undefined);
  if (cardTab !== undefined && firstShown === undefined) {
    // A tool is a card whole, so any of its tabs stands for it.
    return {
      ...base,
      pressed: false,
      open: true,
      minimised: true,
      menu: menu(),
      press: { kind: "restore", tabId: tabId ?? cardTab.id },
    };
  }
  if (firstShown !== undefined) {
    return {
      ...base,
      pressed: input.dockPresentedOpen,
      open: false,
      menu: menu(),
      press: input.dockPresentedOpen
        ? minimisable
          ? { kind: "minimise", tabId: firstShown.id }
          : {
              kind: "close",
              // The Browser closes every page, as the dock's own close does; a
              // second shell is closed one at a time.
              tabIds: tool.id === "browser" ? tabIds : [firstShown.id],
            }
        : { kind: "open-dock" },
    };
  }
  if (input.bottomHeld.includes(tool.id)) {
    // The panel shows one of its tools at a time. Only that one is on screen,
    // so only it reads pressed and closes; a tool behind it is open but not
    // shown, and a press brings it to the front.
    if (input.bottomActive !== undefined && input.bottomActive !== tool.id) {
      return {
        ...base,
        pressed: false,
        open: true,
        menu: menu(),
        press: { kind: "select-bottom" },
      };
    }
    return {
      ...base,
      pressed: input.bottomPresentedOpen,
      open: false,
      menu: menu(),
      press: input.bottomPresentedOpen ? { kind: "close-bottom" } : { kind: "reveal" },
    };
  }
  // The drawer shows one tool, and a full set of tiles has no room for another:
  // there a press shows the tool in the focused tile's place. The tool it
  // replaces is hidden from view, not closed.
  const replacing = narrow || input.capsFull;
  const focused = input.tabs.find((tab) => tab.id === input.activeTabId);
  const focusedLabel = input.surfaces.find((candidate) => candidate.id === focused?.surface)?.label;
  const note =
    input.capsFull && !narrow
      ? `Shows in place of ${focusedLabel ?? "the focused tool"}`
      : undefined;
  if (tabs.length === 0) {
    return {
      ...base,
      pressed: false,
      open: false,
      menu: menu(),
      ...(note === undefined ? {} : { note }),
      press: replacing ? { kind: "open" } : { kind: "open-beside" },
    };
  }
  return {
    ...base,
    pressed: false,
    open: true,
    menu: menu(),
    ...(note === undefined ? {} : { note }),
    press:
      tabId === undefined
        ? { kind: "refused" }
        : replacing
          ? { kind: "select", tabId }
          : { kind: "show-beside", tabId },
  };
}

/**
 * What the tool's button offers on a right click: where to put it among the
 * tiles, minimising to a card, a new shell or page for the two repeatable
 * tools, and closing it.
 * What does not apply is left out; a placement the caps refuse stays listed
 * but disabled, as the dock's own menu did.
 */
function toolMenu(
  tool: { readonly id: RightUtilityDockSurfaceId; readonly label: string },
  input: DockToolButtonsInput,
  tabId: string | undefined,
  shown: boolean,
  minimisable: boolean,
  isCard: boolean,
): ReadonlyArray<DockToolMenuItem> {
  const items: DockToolMenuItem[] = [];
  const narrow = input.narrow === true;
  // A card has no tile to arrange; pressing its button shows it.
  if (tabId !== undefined && !narrow && !isCard) {
    const state: ThreadUtilityDockState = {
      tabs: input.tabs,
      ...(input.activeTabId === undefined ? {} : { active: input.activeTabId }),
      ...(input.layout === undefined ? {} : { layout: input.layout }),
    };
    if (!shown) {
      items.push({
        value: "below",
        label: "Show below",
        disabled: showUtilityTabBelow(state, tabId) === state,
      });
    } else if (input.layout !== undefined) {
      items.push(
        { value: "alone", label: "Show alone" },
        { value: "hide", label: "Hide from view" },
      );
      for (const move of MOVES) {
        if (moveUtilityTile(state, tabId, move.direction) !== state) {
          items.push({ value: `move-${move.direction}`, label: move.label });
        }
      }
    }
  }
  if (minimisable && shown) items.push({ value: "minimise", label: "Minimise to card" });
  if (tool.id === "terminal") items.push({ value: "new", label: "New Terminal" });
  if (tool.id === "browser") items.push({ value: "new", label: "New Browser page" });
  if (tabId !== undefined) items.push({ value: "close", label: `Close ${tool.label}` });
  return items;
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
        tabIds: [],
        menu: [],
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
