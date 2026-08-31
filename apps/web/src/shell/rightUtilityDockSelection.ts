import type { OctantMode } from "@octant/contracts/modes";
import {
  RIGHT_UTILITY_DOCK_SURFACES,
  type RightUtilityDockSurfaceId,
} from "./rightUtilityDockModel";

export type ThreadUtilityDockKey = `${OctantMode}:${string}`;

export interface ThreadUtilityDockState {
  readonly tabs: ReadonlyArray<RightUtilityDockSurfaceId>;
  readonly active?: RightUtilityDockSurfaceId;
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

export function selectThreadUtilityTab(
  states: ThreadUtilityDockStates,
  key: ThreadUtilityDockKey,
  surface: RightUtilityDockSurfaceId,
): ThreadUtilityDockStates {
  const current = threadUtilityDockState(states, key);
  const next = selectUtilityTabState(current, surface);
  return next === current ? states : replace(states, key, next);
}

export function closeThreadUtilityTab(
  states: ThreadUtilityDockStates,
  key: ThreadUtilityDockKey,
  surface: RightUtilityDockSurfaceId,
): ThreadUtilityDockStates {
  const current = threadUtilityDockState(states, key);
  const nextState = closeUtilityTabState(current, surface);
  if (nextState === current) return states;
  if (nextState.tabs.length === 0) {
    const next = new Map(states);
    next.delete(key);
    return next;
  }
  return replace(states, key, nextState);
}

export function openUtilityTabState(
  state: ThreadUtilityDockState,
  surface: RightUtilityDockSurfaceId,
): ThreadUtilityDockState {
  const tabs = state.tabs.includes(surface) ? state.tabs : [...state.tabs, surface];
  return { tabs, active: surface };
}

export function selectUtilityTabState(
  state: ThreadUtilityDockState,
  surface: RightUtilityDockSurfaceId,
): ThreadUtilityDockState {
  return state.tabs.includes(surface) ? { ...state, active: surface } : state;
}

export function closeUtilityTabState(
  state: ThreadUtilityDockState,
  surface: RightUtilityDockSurfaceId,
): ThreadUtilityDockState {
  const closedIndex = state.tabs.indexOf(surface);
  if (closedIndex < 0) return state;
  const tabs = state.tabs.filter((candidate) => candidate !== surface);
  const active =
    state.active === surface ? tabs[Math.min(closedIndex, tabs.length - 1)] : state.active;
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
  const tabs = state.tabs.filter((surface) => !surfaces.has(surface));
  if (tabs.length === state.tabs.length) return state;
  const active =
    state.active !== undefined && tabs.includes(state.active) ? state.active : tabs.at(-1);
  return { tabs, ...(active === undefined ? {} : { active }) };
}

export function retainAvailableUtilityTabs(
  state: ThreadUtilityDockState,
  available: ReadonlySet<RightUtilityDockSurfaceId>,
): ThreadUtilityDockState {
  const tabs = state.tabs.filter((surface) => available.has(surface));
  if (tabs.length === state.tabs.length) {
    if (state.active === undefined || available.has(state.active)) return state;
  }
  const active =
    state.active !== undefined && tabs.includes(state.active)
      ? state.active
      : tabs[tabs.length - 1];
  return { tabs, ...(active === undefined ? {} : { active }) };
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
): Record<string, { readonly tabs: ReadonlyArray<string>; readonly active?: string }> {
  const encoded: Record<
    string,
    { readonly tabs: ReadonlyArray<string>; readonly active?: string }
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
  const tabs: RightUtilityDockSurfaceId[] = [];
  for (const item of candidate.tabs) {
    const surface = decodeDockSurfaceId(item);
    if (surface !== undefined && !tabs.includes(surface)) tabs.push(surface);
  }
  const fallback = tabs[tabs.length - 1];
  if (fallback === undefined) return undefined;
  const activeCandidate = decodeDockSurfaceId(candidate.active);
  const active =
    activeCandidate !== undefined && tabs.includes(activeCandidate) ? activeCandidate : fallback;
  return { tabs, active };
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
