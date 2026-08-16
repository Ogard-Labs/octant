import type { OctantMode } from "@octant/contracts/modes";
import type { SidebarNavigationDescriptorId } from "./navigationModel";

/**
 * First-party plugin components that can contribute a sidebar destination or
 * settings section. Narrower than the general extension component id space
 * on purpose: only the two component kinds ADR 0001 step 4 converts land
 * here (see docs/decisions/0001-plugin-architecture.md).
 */
export type FirstPartyPluginComponentId = "board" | "github-integration";

export interface PluginSidebarContribution {
  readonly componentId: FirstPartyPluginComponentId;
  readonly destinationId: SidebarNavigationDescriptorId;
  readonly modes: ReadonlyArray<OctantMode>;
}

export interface PluginSettingsSectionContribution {
  readonly componentId: FirstPartyPluginComponentId;
  readonly sectionId: string;
}

const SIDEBAR_CONTRIBUTIONS: ReadonlyArray<PluginSidebarContribution> = [
  { componentId: "board", destinationId: "thread-board", modes: ["work", "code"] },
  { componentId: "github-integration", destinationId: "pull-requests", modes: ["code"] },
];

const SETTINGS_SECTION_CONTRIBUTIONS: ReadonlyArray<PluginSettingsSectionContribution> = [
  { componentId: "github-integration", sectionId: "github" },
];

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
    SIDEBAR_CONTRIBUTIONS.filter(
      (contribution) =>
        contribution.modes.includes(mode) && (effective.get(contribution.componentId) ?? false),
    ).map((contribution) => contribution.destinationId),
  );
}

/** Which settings section ids the effective first-party plugins contribute. */
export function resolveSettingsSectionContributions(
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean>,
): ReadonlySet<string> {
  return new Set(
    SETTINGS_SECTION_CONTRIBUTIONS.filter(
      (contribution) => effective.get(contribution.componentId) ?? false,
    ).map((contribution) => contribution.sectionId),
  );
}
