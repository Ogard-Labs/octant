import type { OctantMode } from "@octant/contracts/modes";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

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
