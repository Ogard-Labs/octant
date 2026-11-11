import type { OctantMode } from "@octant/contracts/modes";
import { decodeBrowserContextId, decodeWorkspaceTabId } from "@octant/contracts";
import {
  RIGHT_UTILITY_DOCK_SURFACES,
  type RightUtilityDockSurfaceId,
} from "./rightUtilityDockModel";

export type ThreadUtilityDockKey = `${OctantMode}:${string}`;

export interface ThreadUtilityDockTab {
  /**
   * A window-local presentation identity. Singleton tools use their surface id;
   * repeatable Browser and Terminal tools use a UUID so their process/context
   * state cannot collapse into the first tab.
   */
  readonly id: string;
  readonly surface: RightUtilityDockSurfaceId;
  readonly browserContextId?: string;
}

/**
 * One shown tool. `share` is its fraction of the column it stands in; the
 * shares of a column's tiles add up to one.
 */
export interface DockTile {
  readonly tabId: string;
  readonly share: number;
}

/** Tiles stacked top to bottom. `share` is the column's fraction of the width. */
export interface DockTileColumn {
  readonly share: number;
  readonly tiles: ReadonlyArray<DockTile>;
}

/**
 * Which open tools the dock shows together, left column first. A layout exists
 * only while it holds two or more tiles: one tile is the dock's ordinary
 * single-tool view, and storing it would make two spellings of the same state.
 */
export interface DockTileLayout {
  readonly columns: ReadonlyArray<DockTileColumn>;
}

export interface ThreadUtilityDockState {
  readonly tabs: ReadonlyArray<ThreadUtilityDockTab>;
  /** With a layout, always the tab of the focused tile. */
  readonly active?: string;
  readonly layout?: DockTileLayout;
}

/**
 * Past two columns each tile gets too little width for a tool that needs a
 * page or a shell, and past three tiles a column gets too little height.
 */
export const MAX_DOCK_TILE_COLUMNS = 2;
export const MAX_DOCK_TILES_PER_COLUMN = 3;
/** The smallest fraction a column or a tile may keep when its divider is moved. */
export const MIN_DOCK_TILE_SHARE = 0.15;

export type ThreadUtilityDockStates = ReadonlyMap<ThreadUtilityDockKey, ThreadUtilityDockState>;

const EMPTY_DOCK_STATE: ThreadUtilityDockState = { tabs: [] };

export function threadUtilityDockKey(mode: OctantMode, threadId: string): ThreadUtilityDockKey {
  return `${mode}:${threadId}`;
}

export function threadUtilityDockState(
  states: ThreadUtilityDockStates,
  key: ThreadUtilityDockKey,
): ThreadUtilityDockState {
  return states.get(key) ?? EMPTY_DOCK_STATE;
}

export function openThreadUtilityTab(
  states: ThreadUtilityDockStates,
  key: ThreadUtilityDockKey,
  surface: RightUtilityDockSurfaceId,
): ThreadUtilityDockStates {
  const current = threadUtilityDockState(states, key);
  return replace(states, key, openUtilityTabState(current, surface));
}

export function addThreadUtilityTab(
  states: ThreadUtilityDockStates,
  key: ThreadUtilityDockKey,
  surface: RightUtilityDockSurfaceId,
  instanceId: string,
  browserContextId?: string,
): ThreadUtilityDockStates {
  const current = threadUtilityDockState(states, key);
  return replace(states, key, addUtilityTabState(current, surface, instanceId, browserContextId));
}

export function selectThreadUtilityTab(
  states: ThreadUtilityDockStates,
  key: ThreadUtilityDockKey,
  tabId: string,
): ThreadUtilityDockStates {
  const current = threadUtilityDockState(states, key);
  const next = selectUtilityTabState(current, tabId);
  return next === current ? states : replace(states, key, next);
}

export function closeThreadUtilityTab(
  states: ThreadUtilityDockStates,
  key: ThreadUtilityDockKey,
  tabId: string,
): ThreadUtilityDockStates {
  const current = threadUtilityDockState(states, key);
  const nextState = closeUtilityTabState(current, tabId);
  if (nextState === current) return states;
  if (nextState.tabs.length === 0) {
    const next = new Map(states);
    next.delete(key);
    return next;
  }
  return replace(states, key, nextState);
}

export function updateThreadUtilityTabBrowserContext(
  states: ThreadUtilityDockStates,
  key: ThreadUtilityDockKey,
  tabId: string,
  browserContextId: string,
): ThreadUtilityDockStates {
  const current = threadUtilityDockState(states, key);
  const next = updateUtilityTabBrowserContext(current, tabId, browserContextId);
  return next === current ? states : replace(states, key, next);
}

export function openUtilityTabState(
  state: ThreadUtilityDockState,
  surface: RightUtilityDockSurfaceId,
): ThreadUtilityDockState {
  // Repeatable surfaces keep every instance, so "open" names the singleton
  // identity rather than whichever instance happens to be first: an agent
  // session announced for the thread must land on the shared Browser tab,
  // not on a dedicated context a link open created.
  const existing = state.tabs.find((tab) => tab.id === surface);
  if (existing !== undefined) return focusTab(state, existing.id);
  const tab = singletonUtilityTab(surface);
  return focusTab({ ...state, tabs: [...state.tabs, tab] }, tab.id);
}

export function addUtilityTabState(
  state: ThreadUtilityDockState,
  surface: RightUtilityDockSurfaceId,
  instanceId: string,
  browserContextId?: string,
): ThreadUtilityDockState {
  if (surface !== "browser" && surface !== "terminal") {
    return openUtilityTabState(state, surface);
  }
  const tab: ThreadUtilityDockTab = {
    id: instanceId,
    surface,
    ...(surface === "browser" && browserContextId !== undefined ? { browserContextId } : {}),
  };
  return focusTab(
    { ...state, tabs: [...state.tabs.filter((candidate) => candidate.id !== instanceId), tab] },
    tab.id,
  );
}

export function selectUtilityTabState(
  state: ThreadUtilityDockState,
  tabId: string,
): ThreadUtilityDockState {
  return focusTab(state, tabId);
}

export function closeUtilityTabState(
  state: ThreadUtilityDockState,
  tabId: string,
): ThreadUtilityDockState {
  const closedIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (closedIndex < 0) return state;
  const tabs = state.tabs.filter((candidate) => candidate.id !== tabId);
  if (state.layout !== undefined) {
    return settle(tabs, state.layout, state.active, neighbourTile(state, tabId));
  }
  const active =
    state.active === tabId ? tabs[Math.min(closedIndex, tabs.length - 1)]?.id : state.active;
  return settle(tabs, undefined, active);
}

/**
 * Removes tools presented in another shell region while preserving the
 * remaining region's order and selected tool. A tool can only be rendered in
 * one region at a time, so callers use this when the bottom panel is open.
 */
export function removeUtilityTabs(
  state: ThreadUtilityDockState,
  surfaces: ReadonlySet<RightUtilityDockSurfaceId>,
): ThreadUtilityDockState {
  const tabs = state.tabs.filter((tab) => !surfaces.has(tab.surface));
  if (tabs.length === state.tabs.length) return state;
  return settle(tabs, state.layout, state.active);
}

export function retainAvailableUtilityTabs(
  state: ThreadUtilityDockState,
  available: ReadonlySet<RightUtilityDockSurfaceId>,
): ThreadUtilityDockState {
  const tabs = state.tabs.filter((tab) => available.has(tab.surface));
  if (tabs.length === state.tabs.length) {
    if (state.active === undefined || tabs.some((tab) => tab.id === state.active)) return state;
  }
  return settle(tabs, state.layout, state.active);
}

/** The tabs the dock body shows, in layout order, or just the active tab. */
export function shownUtilityTabIds(state: ThreadUtilityDockState): ReadonlyArray<string> {
  if (state.layout !== undefined) return layoutTabIds(state.layout);
  return state.active === undefined || !state.tabs.some((tab) => tab.id === state.active)
    ? []
    : [state.active];
}

/**
 * Shows an open tab in its own tile to the right of the focused one and
 * focuses it. Two columns are the most there are, so with both present the tab
 * goes below in the last column instead; a full column refuses it.
 */
export function showUtilityTabBeside(
  state: ThreadUtilityDockState,
  tabId: string,
): ThreadUtilityDockState {
  return place(state, tabId, "beside");
}

/** Shows an open tab in its own tile under the focused one and focuses it. */
export function showUtilityTabBelow(
  state: ThreadUtilityDockState,
  tabId: string,
): ThreadUtilityDockState {
  return place(state, tabId, "below");
}

/** Shows one tool again, leaving every other tool open in the strip. */
export function showUtilityTabAlone(
  state: ThreadUtilityDockState,
  tabId: string,
): ThreadUtilityDockState {
  if (!state.tabs.some((tab) => tab.id === tabId)) return state;
  if (state.layout === undefined && state.active === tabId) return state;
  return settle(state.tabs, undefined, tabId);
}

/**
 * Takes a tile out of view without closing its tool: the tab stays in the
 * strip, so the tool can be shown again and keeps its place.
 */
export function hideUtilityTile(
  state: ThreadUtilityDockState,
  tabId: string,
): ThreadUtilityDockState {
  const layout = state.layout;
  if (layout === undefined || !layoutTabIds(layout).includes(tabId)) return state;
  return settle(
    state.tabs,
    withoutTile(layout, tabId),
    state.active === tabId ? neighbourTile(state, tabId) : state.active,
  );
}

/** Sets the columns' fractions of the width, in column order. */
export function resizeUtilityTileColumns(
  state: ThreadUtilityDockState,
  shares: ReadonlyArray<number>,
): ThreadUtilityDockState {
  const layout = state.layout;
  if (layout === undefined || shares.length !== layout.columns.length) return state;
  const next = clampShares(shares);
  if (next === undefined) return state;
  return {
    ...state,
    layout: {
      columns: layout.columns.map((column, index) => ({ ...column, share: at(next, index) })),
    },
  };
}

/** Sets the fractions of one column's height its tiles take, top to bottom. */
export function resizeUtilityTileColumn(
  state: ThreadUtilityDockState,
  columnIndex: number,
  shares: ReadonlyArray<number>,
): ThreadUtilityDockState {
  const layout = state.layout;
  const column = layout?.columns[columnIndex];
  if (layout === undefined || column === undefined || shares.length !== column.tiles.length) {
    return state;
  }
  const next = clampShares(shares);
  if (next === undefined) return state;
  return {
    ...state,
    layout: {
      columns: layout.columns.map((candidate, index) =>
        index === columnIndex
          ? {
              ...candidate,
              tiles: candidate.tiles.map((tile, tileIndex) => ({
                ...tile,
                share: at(next, tileIndex),
              })),
            }
          : candidate,
      ),
    },
  };
}

/**
 * Opens a tool and shows it beside the focused tile in one step, so the tool
 * never takes the focused tile's place first. A repeatable tool always gets a
 * new tab; a singleton reuses its tab if one is open.
 */
export function openUtilityTabBesideState(
  state: ThreadUtilityDockState,
  surface: RightUtilityDockSurfaceId,
  instanceId: string,
): ThreadUtilityDockState {
  const repeatable = surface === "browser" || surface === "terminal";
  const existing = repeatable ? undefined : state.tabs.find((tab) => tab.id === surface);
  const tab: ThreadUtilityDockTab =
    existing ?? (repeatable ? { id: instanceId, surface } : singletonUtilityTab(surface));
  const tabs = existing === undefined ? [...state.tabs, tab] : state.tabs;
  // A cap refusing the tile leaves the tool open in the strip, not shown.
  return place({ ...state, tabs }, tab.id, "beside");
}

/** Columns of tiles a state shows: one for the single-tool view. */
export function shownTileColumns(state: ThreadUtilityDockState): number {
  return state.layout?.columns.length ?? 1;
}

/**
 * Applies a tile change to the layout the person can see and keeps the stored
 * tabs. A tool the bottom panel holds is dropped from the displayed dock, and
 * a divider or a cap that counted its hidden tile would disagree with what is
 * drawn: shares would no longer match the tiles, and a hidden tile would use a
 * slot.
 */
export function changeDisplayedUtilityState(
  stored: ThreadUtilityDockState,
  displayed: ThreadUtilityDockState,
  change: (state: ThreadUtilityDockState) => ThreadUtilityDockState,
): ThreadUtilityDockState {
  const next = change(displayed);
  if (next === displayed) return stored;
  const known = new Set(stored.tabs.map((tab) => tab.id));
  return {
    ...next,
    tabs: [...stored.tabs, ...next.tabs.filter((tab) => !known.has(tab.id))],
  };
}

/** The bottom panel shows one tool at a time, so a layout never belongs to it. */
export function withoutTileLayout(state: ThreadUtilityDockState): ThreadUtilityDockState {
  if (state.layout === undefined) return state;
  return { tabs: state.tabs, ...(state.active === undefined ? {} : { active: state.active }) };
}

export function updateUtilityTabBrowserContext(
  state: ThreadUtilityDockState,
  tabId: string,
  browserContextId: string,
): ThreadUtilityDockState {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (
      tab.id !== tabId ||
      tab.surface !== "browser" ||
      tab.browserContextId === browserContextId
    ) {
      return tab;
    }
    changed = true;
    return { ...tab, browserContextId };
  });
  return changed ? { ...state, tabs } : state;
}

function layoutTabIds(layout: DockTileLayout): ReadonlyArray<string> {
  return layout.columns.flatMap((column) => column.tiles.map((tile) => tile.tabId));
}

function at(values: ReadonlyArray<number>, index: number): number {
  return values[index] ?? 0;
}

/**
 * The tile that takes focus when `tabId`'s tile leaves: the one that now stands
 * in its place in layout order, or the last one if it was last.
 */
function neighbourTile(state: ThreadUtilityDockState, tabId: string): string | undefined {
  const order = state.layout === undefined ? [] : layoutTabIds(state.layout);
  const index = order.indexOf(tabId);
  const rest = order.filter((candidate) => candidate !== tabId);
  return rest[Math.min(Math.max(index, 0), rest.length - 1)];
}

/**
 * Focuses an open tab. Beside a layout, a tab that is shown takes focus where
 * it stands; a Browser page goes into the Browser tile, since every page is
 * one Browser tool and a second Browser tile would show the same tool twice;
 * any other hidden tab replaces the focused tile's tool.
 */
function focusTab(state: ThreadUtilityDockState, tabId: string): ThreadUtilityDockState {
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (tab === undefined) return state;
  const layout = state.layout;
  if (layout === undefined) {
    return state.active === tabId ? state : { ...state, active: tabId };
  }
  const shown = layoutTabIds(layout);
  if (shown.includes(tabId)) return state.active === tabId ? state : { ...state, active: tabId };
  const replaced = tab.surface === "browser" ? browserTileTabId(state) : undefined;
  return { ...state, active: tabId, layout: replaceTile(layout, replaced ?? state.active, tabId) };
}

function browserTileTabId(state: ThreadUtilityDockState): string | undefined {
  if (state.layout === undefined) return undefined;
  return layoutTabIds(state.layout).find(
    (id) => state.tabs.find((tab) => tab.id === id)?.surface === "browser",
  );
}

function replaceTile(
  layout: DockTileLayout,
  replaced: string | undefined,
  tabId: string,
): DockTileLayout {
  return {
    columns: layout.columns.map((column) => ({
      ...column,
      tiles: column.tiles.map((tile) => (tile.tabId === replaced ? { ...tile, tabId } : tile)),
    })),
  };
}

function withoutTile(layout: DockTileLayout, tabId: string): DockTileLayout {
  return {
    columns: layout.columns.map((column) => ({
      ...column,
      tiles: column.tiles.filter((tile) => tile.tabId !== tabId),
    })),
  };
}

/**
 * Brings a layout back to its invariants after tabs or tiles left: tiles of
 * tabs that are gone are dropped, emptied columns go, shares are rescaled to
 * add up, fewer than two tiles is no layout, and the active tab is a shown one.
 */
function settle(
  tabs: ReadonlyArray<ThreadUtilityDockTab>,
  layout: DockTileLayout | undefined,
  active: string | undefined,
  preferred?: string,
): ThreadUtilityDockState {
  const open = new Set(tabs.map((tab) => tab.id));
  const columns = (layout?.columns ?? []).flatMap((column) => {
    const tiles = column.tiles.filter((tile) => open.has(tile.tabId));
    return tiles.length === 0 ? [] : [{ ...column, tiles: rescaleTiles(tiles) }];
  });
  const shown = columns.flatMap((column) => column.tiles.map((tile) => tile.tabId));
  const candidates = [active, preferred];
  const focused =
    shown.length > 0
      ? (candidates.find((id) => id !== undefined && shown.includes(id)) ?? shown[0])
      : (candidates.find((id) => id !== undefined && open.has(id)) ?? tabs.at(-1)?.id);
  const next: ThreadUtilityDockState = focused === undefined ? { tabs } : { tabs, active: focused };
  return shown.length < 2 ? next : { ...next, layout: { columns: rescaleColumns(columns) } };
}

function rescaleTiles(tiles: ReadonlyArray<DockTile>): ReadonlyArray<DockTile> {
  const total = tiles.reduce((sum, tile) => sum + tile.share, 0);
  return tiles.map((tile) => ({ ...tile, share: tile.share / total }));
}

function rescaleColumns(columns: ReadonlyArray<DockTileColumn>): ReadonlyArray<DockTileColumn> {
  const total = columns.reduce((sum, column) => sum + column.share, 0);
  return columns.map((column) => ({ ...column, share: column.share / total }));
}

/**
 * Adds a tab as a tile next to or under the focused one. A tab already shown is
 * moved, so the capacity it frees counts. A request the caps cannot take
 * returns the state unchanged.
 */
function place(
  state: ThreadUtilityDockState,
  tabId: string,
  direction: "beside" | "below",
): ThreadUtilityDockState {
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (tab === undefined) return state;
  if (state.active === undefined) return { ...state, active: tabId };
  if (state.active === tabId) return state;
  // The Browser rule is read from what is on screen, which is the active tab
  // alone while no layout exists: two Browser tiles would show one tool twice.
  const browserShown =
    state.layout === undefined
      ? state.tabs.find((candidate) => candidate.id === state.active)?.surface === "browser"
      : browserTileTabId(state) !== undefined;
  if (tab.surface === "browser" && browserShown) return focusTab(state, tabId);
  const base: DockTileLayout = state.layout ?? {
    columns: [{ share: 1, tiles: [{ tabId: state.active, share: 1 }] }],
  };
  const columns = withoutTile(base, tabId).columns.filter((column) => column.tiles.length > 0);
  const focusedColumn = columns.findIndex((column) =>
    column.tiles.some((tile) => tile.tabId === state.active),
  );
  const focusedColumnTiles = columns[focusedColumn]?.tiles ?? [];
  const focusedRow = focusedColumnTiles.findIndex((tile) => tile.tabId === state.active);
  if (focusedColumn < 0) return state;

  const toNewColumn = direction === "beside" && columns.length < MAX_DOCK_TILE_COLUMNS;
  if (toNewColumn) {
    const added: DockTileColumn = { share: 1 / (columns.length + 1), tiles: [{ tabId, share: 1 }] };
    const scaled = columns.map((column) => ({
      ...column,
      share: (column.share * columns.length) / (columns.length + 1),
    }));
    return settle(
      state.tabs,
      {
        columns: [...scaled.slice(0, focusedColumn + 1), added, ...scaled.slice(focusedColumn + 1)],
      },
      tabId,
    );
  }
  // "Beside" with both columns present falls back to below in the last column.
  const targetColumn = direction === "beside" ? columns.length - 1 : focusedColumn;
  const target = columns[targetColumn];
  if (target === undefined || target.tiles.length >= MAX_DOCK_TILES_PER_COLUMN) return state;
  const row = targetColumn === focusedColumn ? focusedRow + 1 : target.tiles.length;
  const count = target.tiles.length;
  const scaled = target.tiles.map((tile) => ({
    ...tile,
    share: (tile.share * count) / (count + 1),
  }));
  const tiles = [...scaled.slice(0, row), { tabId, share: 1 / (count + 1) }, ...scaled.slice(row)];
  return settle(
    state.tabs,
    {
      columns: columns.map((column, index) =>
        index === targetColumn ? { ...column, tiles } : column,
      ),
    },
    tabId,
  );
}

/**
 * Normalises fractions to add up to one with none under the floor. Returns
 * nothing when a value is not a positive finite number.
 */
function clampShares(shares: ReadonlyArray<number>): ReadonlyArray<number> | undefined {
  if (shares.some((share) => !Number.isFinite(share) || share <= 0)) return undefined;
  const count = shares.length;
  if (count === 0) return undefined;
  if (MIN_DOCK_TILE_SHARE * count >= 1) return shares.map(() => 1 / count);
  const total = shares.reduce((sum, share) => sum + share, 0);
  const result = shares.map((share) => share / total);
  const floored = new Set<number>();
  // Pinning one share to the floor shrinks what the rest may take, which can
  // push another under it, so the pass repeats until none moves.
  for (let pass = 0; pass <= count; pass += 1) {
    const free = result.flatMap((share, index) => (floored.has(index) ? [] : [index]));
    const freeTotal = free.reduce((sum, index) => sum + at(result, index), 0);
    const room = 1 - MIN_DOCK_TILE_SHARE * floored.size;
    const under = free.filter(
      (index) => (at(result, index) / freeTotal) * room < MIN_DOCK_TILE_SHARE,
    );
    if (under.length === 0) {
      for (const index of free) result[index] = (at(result, index) / freeTotal) * room;
      break;
    }
    for (const index of under) floored.add(index);
    for (const index of floored) result[index] = MIN_DOCK_TILE_SHARE;
  }
  return result;
}

function singletonUtilityTab(surface: RightUtilityDockSurfaceId): ThreadUtilityDockTab {
  return { id: surface, surface };
}

function replace(
  states: ThreadUtilityDockStates,
  key: ThreadUtilityDockKey,
  state: ThreadUtilityDockState,
): ThreadUtilityDockStates {
  const next = new Map(states);
  next.set(key, state);
  return next;
}

export interface UtilityDockPresentation {
  readonly open: boolean;
  readonly threads: ThreadUtilityDockStates;
}

function utilityDockStorageKey(windowId: string): string {
  return `octant.shell.utility-dock.${windowId}.v1`;
}

function bottomPanelToolsStorageKey(windowId: string): string {
  return `octant.shell.bottom-panel-tools.${windowId}.v1`;
}

/**
 * Per-window dock open-tool state. Authority and processes stay on the server;
 * this is only which tools this window last showed for each thread.
 */
export function readUtilityDockPresentation(
  scope: { readonly localStorage?: Storage },
  windowId: string,
  /**
   * What an unset window shows. A new window starts with the workspace as the
   * only primary region. Opening a tool or restoring an explicit prior choice
   * reveals the dock; an empty third column is not useful state.
   */
  defaultOpen = false,
): UtilityDockPresentation {
  return readDockPresentationRecord(scope, utilityDockStorageKey(windowId), true, defaultOpen);
}

/**
 * Whether this window has ever been told to show or hide the dock. `undefined`
 * means it has not, so the caller decides from the window it is actually in
 * rather than from a value frozen before the viewport was measured.
 */
export function readUtilityDockOpen(
  scope: { readonly localStorage?: Storage },
  windowId: string,
): boolean | undefined {
  try {
    const raw = scope.localStorage?.getItem(utilityDockStorageKey(windowId));
    if (raw === undefined || raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return undefined;
    if (!isRecord(parsed)) return undefined;
    const candidate = parsed;
    return typeof candidate.open === "boolean" ? candidate.open : undefined;
  } catch {
    return undefined;
  }
}

export function writeUtilityDockPresentation(
  scope: { readonly localStorage?: Storage },
  windowId: string,
  presentation: UtilityDockPresentation,
): void {
  writeJson(scope, utilityDockStorageKey(windowId), {
    open: presentation.open === true,
    threads: encodeDockStates(presentation.threads, true),
  });
}

export function readBottomPanelToolPresentation(
  scope: { readonly localStorage?: Storage },
  windowId: string,
): ThreadUtilityDockStates {
  return readDockPresentationRecord(
    scope,
    bottomPanelToolsStorageKey(windowId),
    false,
    false,
    false,
  ).threads;
}

export function writeBottomPanelToolPresentation(
  scope: { readonly localStorage?: Storage },
  windowId: string,
  threads: ThreadUtilityDockStates,
): void {
  writeJson(scope, bottomPanelToolsStorageKey(windowId), {
    threads: encodeDockStates(threads, false),
  });
}

function readDockPresentationRecord(
  scope: { readonly localStorage?: Storage },
  storageKey: string,
  readOpen: boolean,
  defaultOpen = false,
  tiled = true,
): UtilityDockPresentation {
  // A window that has never been told otherwise follows the caller's default.
  // The dock and bottom panel both start closed; a tool selection or an
  // explicit restored preference is what earns another workspace region.
  const unset = { open: readOpen && defaultOpen, threads: new Map() };
  try {
    const raw = scope.localStorage?.getItem(storageKey);
    if (raw === undefined || raw === null) {
      return unset;
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return unset;
    }
    if (!isRecord(parsed)) return unset;
    const candidate = parsed;
    return {
      open: readOpen && (typeof candidate.open === "boolean" ? candidate.open : defaultOpen),
      threads: decodeDockStates(candidate.threads, tiled),
    };
  } catch {
    return unset;
  }
}

function writeJson(
  scope: { readonly localStorage?: Storage },
  storageKey: string,
  value: unknown,
): void {
  try {
    scope.localStorage?.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Presentation persistence is best-effort.
  }
}

interface StoredDockState {
  readonly tabs: ReadonlyArray<ThreadUtilityDockTab>;
  readonly active?: string;
  readonly layout?: DockTileLayout;
}

function encodeDockStates(
  states: ThreadUtilityDockStates,
  tiled: boolean,
): Record<string, StoredDockState> {
  const encoded: Record<string, StoredDockState> = {};
  for (const [key, state] of states) {
    if (state.tabs.length === 0) continue;
    encoded[key] = {
      tabs: [...state.tabs],
      ...(state.active === undefined ? {} : { active: state.active }),
      ...(tiled && state.layout !== undefined ? { layout: state.layout } : {}),
    };
  }
  return encoded;
}

function decodeDockStates(value: unknown, tiled: boolean): ThreadUtilityDockStates {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return new Map();
  const next = new Map<ThreadUtilityDockKey, ThreadUtilityDockState>();
  for (const [key, state] of Object.entries(value)) {
    if (!isThreadUtilityDockKey(key)) continue;
    const decoded = decodeDockState(state, tiled);
    if (decoded === undefined) continue;
    next.set(key, decoded);
  }
  return next;
}

function decodeDockState(value: unknown, tiled: boolean): ThreadUtilityDockState | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value;
  if (!Array.isArray(candidate.tabs)) return undefined;
  const tabs: ThreadUtilityDockTab[] = [];
  for (const item of candidate.tabs) {
    const tab = decodeDockTab(item);
    if (tab !== undefined && !tabs.some((candidate) => candidate.id === tab.id)) tabs.push(tab);
  }
  const fallback = tabs[tabs.length - 1]?.id;
  if (fallback === undefined) return undefined;
  const activeCandidate = typeof candidate.active === "string" ? candidate.active : undefined;
  const active =
    activeCandidate !== undefined && tabs.some((tab) => tab.id === activeCandidate)
      ? activeCandidate
      : fallback;
  const layout = tiled ? decodeDockLayout(candidate.layout, tabs) : undefined;
  if (layout === undefined) return { tabs, active };
  const shown = layoutTabIds(layout);
  return { tabs, active: shown.includes(active) ? active : (shown[0] ?? active), layout };
}

/**
 * A stored layout is read as untrusted: a record from an older build, another
 * window or a hand edit must still open to a dock that obeys the caps and shows
 * only open tools, so anything else is dropped rather than repaired in place.
 */
function decodeDockLayout(
  value: unknown,
  tabs: ReadonlyArray<ThreadUtilityDockTab>,
): DockTileLayout | undefined {
  if (!isRecord(value) || !Array.isArray(value.columns)) return undefined;
  const taken = new Set<string>();
  let browserShown = false;
  const columns: { share: unknown; tiles: ReadonlyArray<DockTile> }[] = [];
  for (const item of value.columns) {
    if (columns.length >= MAX_DOCK_TILE_COLUMNS) break;
    if (!isRecord(item) || !Array.isArray(item.tiles)) continue;
    const tiles: { tabId: string; share: unknown }[] = [];
    for (const entry of item.tiles) {
      if (tiles.length >= MAX_DOCK_TILES_PER_COLUMN) break;
      if (!isRecord(entry) || typeof entry.tabId !== "string" || taken.has(entry.tabId)) continue;
      const tab = tabs.find((candidate) => candidate.id === entry.tabId);
      if (tab === undefined || (tab.surface === "browser" && browserShown)) continue;
      taken.add(tab.id);
      if (tab.surface === "browser") browserShown = true;
      tiles.push({ tabId: tab.id, share: entry.share });
    }
    if (tiles.length === 0) continue;
    const tileShares = decodeShares(tiles.map((tile) => tile.share));
    columns.push({
      share: item.share,
      tiles: tiles.map((tile, index) => ({ tabId: tile.tabId, share: at(tileShares, index) })),
    });
  }
  const columnShares = decodeShares(columns.map((column) => column.share));
  const shown = columns.reduce((sum, column) => sum + column.tiles.length, 0);
  if (shown < 2) return undefined;
  return {
    columns: columns.map((column, index) => ({ ...column, share: at(columnShares, index) })),
  };
}

/** Shares that cannot be trusted become equal ones; the rest are rescaled to add up. */
function decodeShares(shares: ReadonlyArray<unknown>): ReadonlyArray<number> {
  const valid = shares.every(
    (share) => typeof share === "number" && Number.isFinite(share) && share > 0,
  );
  if (!valid) return shares.map(() => 1 / shares.length);
  const numbers = shares.filter((share): share is number => typeof share === "number");
  return clampShares(numbers) ?? numbers.map(() => 1 / numbers.length);
}

function decodeDockTab(value: unknown): ThreadUtilityDockTab | undefined {
  // v1 stored only surface ids. Preserve them as stable singleton identities.
  const legacySurface = decodeDockSurfaceId(value);
  if (legacySurface !== undefined) return singletonUtilityTab(legacySurface);
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const surface = decodeDockSurfaceId(value.surface);
  if (surface === undefined) return undefined;
  if ((surface === "browser" || surface === "terminal") && value.id !== surface) {
    try {
      decodeWorkspaceTabId(value.id);
    } catch {
      return undefined;
    }
  }
  let browserContextId: string | undefined;
  if (surface === "browser" && typeof value.browserContextId === "string") {
    try {
      browserContextId = String(decodeBrowserContextId(value.browserContextId));
    } catch {
      browserContextId = undefined;
    }
  }
  return {
    id: value.id,
    surface,
    ...(browserContextId === undefined ? {} : { browserContextId }),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeDockSurfaceId(value: unknown): RightUtilityDockSurfaceId | undefined {
  const canonical = value === "changes" ? "review" : value;
  if (typeof canonical !== "string") return undefined;
  return RIGHT_UTILITY_DOCK_SURFACES.find((surface) => surface.id === canonical)?.id;
}

function isThreadUtilityDockKey(value: string): value is ThreadUtilityDockKey {
  const separator = value.indexOf(":");
  if (separator <= 0) return false;
  const mode = value.slice(0, separator);
  return (mode === "chat" || mode === "work" || mode === "code") && value.length > separator + 1;
}
