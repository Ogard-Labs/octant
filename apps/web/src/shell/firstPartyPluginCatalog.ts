import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import {
  FIRST_PARTY_PLUGIN_CATALOG,
  isFirstPartyPluginComponentId,
  type FirstPartyPluginComponentId,
} from "@octant/plugin-host/first-party-plugins";

export {
  FIRST_PARTY_PLUGIN_CATALOG,
  firstPartyContributions,
  isFirstPartyPluginComponentId,
  type FirstPartyPluginComponentId,
} from "@octant/plugin-host/first-party-plugins";

/**
 * Every first-party plugin on: what the renderer uses until the host's
 * extension snapshot has loaded, and for a plugin the host has no switch for.
 * It matches the server, where a missing row is the bundled default, so a
 * surface never flashes away while the snapshot is on its way.
 */
export const FIRST_PARTY_PLUGINS_EFFECTIVE: ReadonlyMap<FirstPartyPluginComponentId, boolean> =
  new Map(
    FIRST_PARTY_PLUGIN_CATALOG.flatMap((plugin) =>
      plugin.components.flatMap((component) => {
        const id = String(component.id);
        return isFirstPartyPluginComponentId(id) ? [[id, true] as const] : [];
      }),
    ),
  );

/**
 * Which first-party plugins are on, read from the host's extension snapshot.
 * Only the row the host wrote for a bundled plugin counts: a component is off
 * when that row says it is not effective, and on when the host has no row for
 * it. Without a snapshot every plugin is on.
 */
export function firstPartyPluginsEffectiveFromSnapshot(
  snapshot: Pick<ExtensionSnapshot, "packages"> | undefined,
): ReadonlyMap<FirstPartyPluginComponentId, boolean> {
  if (snapshot === undefined) return FIRST_PARTY_PLUGINS_EFFECTIVE;
  const effective = new Map(FIRST_PARTY_PLUGINS_EFFECTIVE);
  for (const plugin of FIRST_PARTY_PLUGIN_CATALOG) {
    const row = snapshot.packages.find(
      (candidate) =>
        String(candidate.extensionId) === String(plugin.extensionId) &&
        candidate.source.kind === "bundled",
    );
    if (row === undefined) continue;
    for (const component of row.components) {
      const id = String(component.component.id);
      if (!isFirstPartyPluginComponentId(id)) continue;
      effective.set(id, component.effectiveState.kind === "effective");
    }
  }
  return effective;
}
