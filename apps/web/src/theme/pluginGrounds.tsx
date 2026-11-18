import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { groundContributions, type ContributedGround } from "@octant/plugin-host/grounds";
import type { ThemePreset } from "@octant/theme";
import { createContext, useContext, type ReactNode } from "react";
import { useHostExtensionSnapshotReading } from "../shell/firstPartyPluginsEffective";
import { PluginThemesContext } from "./pluginThemes";

const NO_PLUGIN_GROUNDS: ReadonlyArray<ContributedGround> = [];

/**
 * The character grounds installed, trusted and enabled plugins offer, as data.
 * Anything rendered outside the shell sees none.
 */
export const PluginGroundsContext =
  createContext<ReadonlyArray<ContributedGround>>(NO_PLUGIN_GROUNDS);

export function usePluginGrounds(): ReadonlyArray<ContributedGround> {
  return useContext(PluginGroundsContext);
}

function readPluginGrounds(snapshot: ExtensionSnapshot): ReadonlyArray<ContributedGround> {
  const grounds = groundContributions(snapshot.packages);
  return grounds.length === 0 ? NO_PLUGIN_GROUNDS : grounds;
}

function samePluginGrounds(
  current: ReadonlyArray<ContributedGround>,
  next: ReadonlyArray<ContributedGround>,
): boolean {
  return JSON.stringify(current) === JSON.stringify(next);
}

/**
 * Reads the contributed grounds from the host's extension snapshot whenever an
 * extension changes, so switching a plugin off removes its grounds from the
 * menu at once. A ground the person already picked is their own copy and is
 * unaffected.
 */
export function useHostPluginGrounds(
  client: ExtensionClient,
  changeRevision: number,
): ReadonlyArray<ContributedGround> {
  return useHostExtensionSnapshotReading(
    client,
    changeRevision,
    NO_PLUGIN_GROUNDS,
    readPluginGrounds,
    samePluginGrounds,
  );
}

/** What installed, trusted and enabled plugins contribute to Settings: themes and grounds. */
export function PluginContributionsProvider(props: {
  readonly themes: ReadonlyArray<ThemePreset>;
  readonly grounds: ReadonlyArray<ContributedGround>;
  readonly children: ReactNode;
}) {
  return (
    <PluginThemesContext.Provider value={props.themes}>
      <PluginGroundsContext.Provider value={props.grounds}>
        {props.children}
      </PluginGroundsContext.Provider>
    </PluginThemesContext.Provider>
  );
}
