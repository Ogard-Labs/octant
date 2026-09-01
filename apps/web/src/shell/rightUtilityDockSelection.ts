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

export interface ThreadUtilityDockState {
  readonly tabs: ReadonlyArray<ThreadUtilityDockTab>;
  readonly active?: string;
}

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
): ThreadUtilityDockStates {
  const current = threadUtilityDockState(states, key);
  return replace(states, key, addUtilityTabState(current, surface, instanceId));
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
  const existing = state.tabs.find((tab) => tab.surface === surface);
  if (existing !== undefined) return { ...state, active: existing.id };
  const tab = singletonUtilityTab(surface);
  return { tabs: [...state.tabs, tab], active: tab.id };
}

export function addUtilityTabState(
  state: ThreadUtilityDockState,
  surface: RightUtilityDockSurfaceId,
  instanceId: string,
): ThreadUtilityDockState {
  if (surface !== "browser" && surface !== "terminal") {
    return openUtilityTabState(state, surface);
  }
  const tab = { id: instanceId, surface };
  return {
    tabs: [...state.tabs.filter((candidate) => candidate.id !== instanceId), tab],
    active: tab.id,
  };
}

export function selectUtilityTabState(
  state: ThreadUtilityDockState,
  tabId: string,
): ThreadUtilityDockState {
  return state.tabs.some((tab) => tab.id === tabId) ? { ...state, active: tabId } : state;
}

export function closeUtilityTabState(
  state: ThreadUtilityDockState,
  tabId: string,
): ThreadUtilityDockState {
  const closedIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (closedIndex < 0) return state;
  const tabs = state.tabs.filter((candidate) => candidate.id !== tabId);
  const active =
    state.active === tabId ? tabs[Math.min(closedIndex, tabs.length - 1)]?.id : state.active;
  return { tabs, ...(active === undefined ? {} : { active }) };
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
  const active =
    state.active !== undefined && tabs.some((tab) => tab.id === state.active)
      ? state.active
      : tabs.at(-1)?.id;
  return { tabs, ...(active === undefined ? {} : { active }) };
}

export function retainAvailableUtilityTabs(
  state: ThreadUtilityDockState,
  available: ReadonlySet<RightUtilityDockSurfaceId>,
): ThreadUtilityDockState {
  const tabs = state.tabs.filter((tab) => available.has(tab.surface));
  if (tabs.length === state.tabs.length) {
    if (state.active === undefined || tabs.some((tab) => tab.id === state.active)) return state;
  }
  const active =
    state.active !== undefined && tabs.some((tab) => tab.id === state.active)
      ? state.active
      : tabs[tabs.length - 1]?.id;
  return { tabs, ...(active === undefined ? {} : { active }) };
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
    threads: encodeDockStates(presentation.threads),
  });
}

export function readBottomPanelToolPresentation(
  scope: { readonly localStorage?: Storage },
  windowId: string,
): ThreadUtilityDockStates {
  return readDockPresentationRecord(scope, bottomPanelToolsStorageKey(windowId), false).threads;
}

export function writeBottomPanelToolPresentation(
  scope: { readonly localStorage?: Storage },
  windowId: string,
  threads: ThreadUtilityDockStates,
): void {
  writeJson(scope, bottomPanelToolsStorageKey(windowId), {
    threads: encodeDockStates(threads),
  });
}

function readDockPresentationRecord(
  scope: { readonly localStorage?: Storage },
  storageKey: string,
  readOpen: boolean,
  defaultOpen = false,
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
      threads: decodeDockStates(candidate.threads),
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

function encodeDockStates(
  states: ThreadUtilityDockStates,
): Record<
  string,
  { readonly tabs: ReadonlyArray<ThreadUtilityDockTab>; readonly active?: string }
> {
  const encoded: Record<
    string,
    { readonly tabs: ReadonlyArray<ThreadUtilityDockTab>; readonly active?: string }
  > = {};
  for (const [key, state] of states) {
    if (state.tabs.length === 0) continue;
    encoded[key] = {
      tabs: [...state.tabs],
      ...(state.active === undefined ? {} : { active: state.active }),
    };
  }
  return encoded;
}

function decodeDockStates(value: unknown): ThreadUtilityDockStates {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return new Map();
  const next = new Map<ThreadUtilityDockKey, ThreadUtilityDockState>();
  for (const [key, state] of Object.entries(value)) {
    if (!isThreadUtilityDockKey(key)) continue;
    const decoded = decodeDockState(state);
    if (decoded === undefined) continue;
    next.set(key, decoded);
  }
  return next;
}

function decodeDockState(value: unknown): ThreadUtilityDockState | undefined {
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
  return { tabs, active };
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
