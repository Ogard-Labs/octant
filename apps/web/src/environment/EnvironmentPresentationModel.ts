import {
  type EnvironmentPresentation,
  type EnvironmentPresentationState,
  type EnvironmentTabPresentation,
  type OctantMode,
  type WorkspaceTabId,
} from "@octant/contracts";
import {
  resolveEffectivePresentation,
  resolveEnvironmentPinnedWidth,
} from "@octant/domain/shell-policy";

export interface EnvironmentPresentationModel {
  readonly presentation: EnvironmentPresentation;
  readonly pinnedWidth: number;
}

export function resolveTabPresentation(
  state: EnvironmentPresentationState,
  mode: OctantMode,
  tabId: WorkspaceTabId,
): EnvironmentPresentationModel {
  return {
    presentation: resolveEffectivePresentation(state, mode, tabId),
    pinnedWidth: resolveEnvironmentPinnedWidth(state, tabId),
  };
}

export function replaceTabPresentation(
  state: EnvironmentPresentationState,
  tabId: WorkspaceTabId,
  presentation: EnvironmentPresentation,
  pinnedWidth?: number,
): EnvironmentPresentationState {
  const existing = state.byTab.find((entry) => entry.tabId === tabId);
  const without = state.byTab.filter((entry) => entry.tabId !== tabId);
  const resolvedWidth = pinnedWidth ?? (existing !== undefined ? existing.pinnedWidth : undefined);
  const next: EnvironmentTabPresentation = {
    tabId,
    presentation,
    pinnedWidth: resolveEnvironmentPinnedWidth(
      { ...state, byTab: [...without] },
      tabId,
      resolvedWidth,
    ),
  };
  return { ...state, byTab: [...without, next] };
}

export function clearTabPresentation(
  state: EnvironmentPresentationState,
  tabId: WorkspaceTabId,
): EnvironmentPresentationState {
  return { ...state, byTab: state.byTab.filter((entry) => entry.tabId !== tabId) };
}
