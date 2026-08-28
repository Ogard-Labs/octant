import type { OctantMode } from "@octant/contracts/modes";
import type {
  ExtensionAppearancePresetContribution,
  ExtensionBoardViewContribution,
  ExtensionContribution,
  ExtensionPreviewViewerContribution,
  ExtensionPreviewViewerKind,
  ExtensionSettingsSectionContribution,
  ExtensionSidebarDestinationContribution,
  ExtensionThreadPaneContribution,
  ExtensionWorkspaceTabContribution,
} from "@octant/contracts/extensions";
import {
  firstPartyContributions,
  FIRST_PARTY_PLUGINS_EFFECTIVE,
  isFirstPartyPluginComponentId,
  type FirstPartyPluginComponentId,
} from "./firstPartyPluginCatalog";
import type { SidebarNavigationDescriptorId } from "./navigationModel";

export {
  FIRST_PARTY_PLUGINS_EFFECTIVE,
  type FirstPartyPluginComponentId,
} from "./firstPartyPluginCatalog";

const HOST_APPEARANCE_PRESET_IDS = new Set(["system", "light", "dark"]);
const HOST_PREVIEW_VIEWER_KINDS = new Set<ExtensionPreviewViewerKind>([
  "text",
  "markdown",
  "image",
]);

function catalog(): ReadonlyArray<ExtensionContribution> {
  return firstPartyContributions();
}

function isEffective(
  componentId: string,
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean>,
): boolean {
  return isFirstPartyPluginComponentId(componentId) && (effective.get(componentId) ?? false);
}

function contributionsOf<T extends ExtensionContribution>(
  point: T["point"],
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean>,
): ReadonlyArray<T> {
  return catalog().filter(
    (contribution): contribution is T =>
      contribution.point === point && isEffective(contribution.componentId, effective),
  );
}

function isSidebarDestinationId(value: string): value is SidebarNavigationDescriptorId {
  return (
    value === "thread-board" ||
    value === "pull-requests" ||
    value === "github-issues" ||
    value === "linear-issues"
  );
}

/**
 * Which sidebar destinations the effective first-party plugins contribute
 * for the given mode. Pure and mode-scoped so it composes with whatever else
 * gates a destination (e.g. whether the caller has wired an action handler
 * for it); it does not decide availability on its own.
 */
export function resolveSidebarContributions(
  mode: OctantMode,
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean>,
): ReadonlySet<SidebarNavigationDescriptorId> {
  return new Set(
    contributionsOf<ExtensionSidebarDestinationContribution>("sidebar.destination", effective)
      .filter((contribution) => contribution.modes.includes(mode))
      .map((contribution) => contribution.destinationId)
      .filter(isSidebarDestinationId),
  );
}

/** Returns the full contribution records for effective sidebar destinations. */
export function resolveSidebarDestinationContributions(
  mode: OctantMode,
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean> = FIRST_PARTY_PLUGINS_EFFECTIVE,
): ReadonlyArray<ExtensionSidebarDestinationContribution> {
  return contributionsOf<ExtensionSidebarDestinationContribution>(
    "sidebar.destination",
    effective,
  ).filter((contribution) => contribution.modes.includes(mode));
}

/** Looks up the full contribution record for an effective sidebar destination. */
export function resolveSidebarDestinationContribution(
  destinationId: string,
  mode: OctantMode,
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean> = FIRST_PARTY_PLUGINS_EFFECTIVE,
): ExtensionSidebarDestinationContribution | undefined {
  return resolveSidebarDestinationContributions(mode, effective).find(
    (contribution) => contribution.destinationId === destinationId,
  );
}

/** Which settings section ids the effective first-party plugins contribute. */
export function resolveSettingsSectionContributions(
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean>,
): ReadonlySet<string> {
  return new Set(
    contributionsOf<ExtensionSettingsSectionContribution>("settings.section", effective).map(
      (contribution) => contribution.sectionId,
    ),
  );
}

/**
 * Host-owned settings sections stay visible. A section that a plugin
 * contributes is present only while that component is effective.
 */
export function isSettingsSectionAvailable(
  sectionId: string,
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean> = FIRST_PARTY_PLUGINS_EFFECTIVE,
): boolean {
  const contributed = catalog()
    .filter(
      (contribution): contribution is ExtensionSettingsSectionContribution =>
        contribution.point === "settings.section",
    )
    .map((contribution) => contribution.sectionId);
  if (!contributed.includes(sectionId)) return true;
  return resolveSettingsSectionContributions(effective).has(sectionId);
}

/**
 * Looks up the contribution metadata for a plugin-contributed settings section.
 * Returns undefined for host-owned sections that do not come from the catalog.
 */
export function resolveSettingsSectionContribution(
  sectionId: string,
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean> = FIRST_PARTY_PLUGINS_EFFECTIVE,
): ExtensionSettingsSectionContribution | undefined {
  return contributionsOf<ExtensionSettingsSectionContribution>("settings.section", effective).find(
    (contribution) => contribution.sectionId === sectionId,
  );
}

export function resolveWorkspaceTabContributions(
  mode: OctantMode,
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean>,
): ReadonlySet<string> {
  return new Set(
    contributionsOf<ExtensionWorkspaceTabContribution>("workspace.tab", effective)
      .filter((contribution) => contribution.modes.includes(mode))
      .map((contribution) => contribution.tabId),
  );
}

export function resolveThreadPaneContributions(
  mode: OctantMode,
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean>,
): ReadonlySet<string> {
  return new Set(
    contributionsOf<ExtensionThreadPaneContribution>("thread.pane", effective)
      .filter((contribution) => contribution.modes.includes(mode))
      .map((contribution) => contribution.paneId),
  );
}

export function resolveBoardViewContributions(
  mode: OctantMode,
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean>,
): ReadonlySet<string> {
  if (mode !== "work" && mode !== "code") return new Set();
  return new Set(
    contributionsOf<ExtensionBoardViewContribution>("board.view", effective)
      .filter((contribution) => contribution.modes.includes(mode))
      .map((contribution) => contribution.viewId),
  );
}

export function resolveAppearancePresetContributions(
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean>,
): ReadonlySet<string> {
  return new Set(
    contributionsOf<ExtensionAppearancePresetContribution>("appearance.preset", effective).map(
      (contribution) => contribution.presetId,
    ),
  );
}

/**
 * Host built-in presets remain available. Plugin-contributed presets appear
 * only while their appearance-pack component is effective.
 */
export function isAppearancePresetAvailable(
  presetId: string,
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean> = FIRST_PARTY_PLUGINS_EFFECTIVE,
): boolean {
  if (HOST_APPEARANCE_PRESET_IDS.has(presetId)) return true;
  return resolveAppearancePresetContributions(effective).has(presetId);
}

export function resolvePreviewViewerContributions(
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean>,
): ReadonlySet<ExtensionPreviewViewerKind> {
  return new Set(
    contributionsOf<ExtensionPreviewViewerContribution>("preview.viewer", effective).flatMap(
      (contribution) => contribution.kinds,
    ),
  );
}

/**
 * Host primitive viewers stay available. Structured kinds come from the
 * preview-viewers package and disappear when that component is not effective.
 */
export function isPreviewViewerAvailable(
  kind: string,
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean> = FIRST_PARTY_PLUGINS_EFFECTIVE,
): boolean {
  if (kind === "unsupported") return true;
  if (HOST_PREVIEW_VIEWER_KINDS.has(kind as ExtensionPreviewViewerKind)) return true;
  return resolvePreviewViewerContributions(effective).has(kind as ExtensionPreviewViewerKind);
}
