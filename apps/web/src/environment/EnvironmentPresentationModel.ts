import {
  type EnvironmentPresentation,
  type EnvironmentPresentationState,
  type EnvironmentTabPresentation,
  type OctantMode,
  type WorkspaceTabId,
} from "@octant/contracts";
import { resolveEffectivePresentation } from "@octant/domain/shell-policy";

export function resolveTabPresentation(
  state: EnvironmentPresentationState,
  mode: OctantMode,
  tabId: WorkspaceTabId,
): EnvironmentPresentation {
  return resolveEffectivePresentation(state, mode, tabId);
}

export function replaceTabPresentation(
  state: EnvironmentPresentationState,
  tabId: WorkspaceTabId,
  presentation: EnvironmentPresentation,
): EnvironmentPresentationState {
  const without = state.byTab.filter((entry) => entry.tabId !== tabId);
  const next: EnvironmentTabPresentation = { tabId, presentation };
  return { ...state, byTab: [...without, next] };
}

export function clearTabPresentation(
  state: EnvironmentPresentationState,
  tabId: WorkspaceTabId,
): EnvironmentPresentationState {
  return { ...state, byTab: state.byTab.filter((entry) => entry.tabId !== tabId) };
}
