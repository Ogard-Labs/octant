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

const PLUGIN_OWNED_SETTINGS_SECTION_IDS: ReadonlySet<string> = new Set(
  SETTINGS_SECTION_CONTRIBUTIONS.map((contribution) => contribution.sectionId),
);

/**
 * Stand-in for the server's first-party plugin activation state, shared by
 * the sidebar and Settings so both trace through the same source. Both
 * plugins are seeded and gated server-side (ADR 0001 step 4), but this stays
 * a constant rather than a live query: the board's sidebar contribution
 * spans Work and Code while its compatibility is Code-only, and GitHub's
 * settings section is host-scoped while its compatibility is Code-only, so a
 * single boolean per component can't represent a mode-scoped effective state
 * correctly. Live wiring needs a small per-mode query design of its own and
 * is deferred (see docs/decisions/0001-plugin-architecture.md).
 */
export const FIRST_PARTY_PLUGINS_EFFECTIVE: ReadonlyMap<FirstPartyPluginComponentId, boolean> =
  new Map([
    ["board", true],
    ["github-integration", true],
  ]);

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

/**
 * Whether a Settings section should be listed. Sections no plugin owns are
 * always available; a plugin-owned section (e.g. `github`) is available only
 * when its contributing component is effective.
 */
export function isPluginSettingsSectionAvailable(
  sectionId: string,
  effective: ReadonlyMap<FirstPartyPluginComponentId, boolean>,
): boolean {
  if (!PLUGIN_OWNED_SETTINGS_SECTION_IDS.has(sectionId)) return true;
  return resolveSettingsSectionContributions(effective).has(sectionId);
}
