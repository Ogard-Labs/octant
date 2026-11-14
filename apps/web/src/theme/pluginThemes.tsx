import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { effectiveContributedThemes } from "@octant/plugin-host/themes";
import type { ThemePreset } from "@octant/theme";
import { createContext, useContext } from "react";
import { useHostExtensionSnapshotReading } from "../shell/firstPartyPluginsEffective";

const NO_PLUGIN_THEMES: ReadonlyArray<ThemePreset> = [];

/**
 * The themes installed, trusted and enabled plugins contribute, already
 * validated by the theme schema. Anything rendered outside the shell sees
 * none.
 */
export const PluginThemesContext = createContext<ReadonlyArray<ThemePreset>>(NO_PLUGIN_THEMES);

export function usePluginThemes(): ReadonlyArray<ThemePreset> {
  return useContext(PluginThemesContext);
}

function readPluginThemes(snapshot: ExtensionSnapshot): ReadonlyArray<ThemePreset> {
  const themes = effectiveContributedThemes(snapshot.packages);
  return themes.length === 0 ? NO_PLUGIN_THEMES : themes;
}

// The host re-sends whole rows, so a theme counts as unchanged only when its
// id and every colour match; a plugin update that recolours a theme repaints.
function samePluginThemes(
  current: ReadonlyArray<ThemePreset>,
  next: ReadonlyArray<ThemePreset>,
): boolean {
  return JSON.stringify(current) === JSON.stringify(next);
}

/**
 * Reads the contributed themes from the host's extension snapshot whenever an
 * extension changes, so switching a plugin off removes its themes at once.
 * Until the first answer the list is empty: a stored plugin theme draws the
 * default theme for that moment rather than one the host has not confirmed.
 */
export function useHostPluginThemes(
  client: ExtensionClient,
  changeRevision: number,
): ReadonlyArray<ThemePreset> {
  return useHostExtensionSnapshotReading(
    client,
    changeRevision,
    NO_PLUGIN_THEMES,
    readPluginThemes,
    samePluginThemes,
  );
}
