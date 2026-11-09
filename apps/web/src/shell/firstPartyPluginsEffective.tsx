import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import { createContext, useContext, useEffect, useState } from "react";
import { documentIsVisible } from "../polling/documentVisibility";
import {
  FIRST_PARTY_PLUGINS_EFFECTIVE,
  firstPartyPluginsEffectiveFromSnapshot,
  type FirstPartyPluginComponentId,
} from "./firstPartyPluginCatalog";

type EffectiveMap = ReadonlyMap<FirstPartyPluginComponentId, boolean>;

/**
 * Which first-party plugins are on for this window. The shell provides the
 * host's answer; anything rendered outside it sees every plugin on.
 */
export const FirstPartyPluginsEffectiveContext = createContext<EffectiveMap>(
  FIRST_PARTY_PLUGINS_EFFECTIVE,
);

export function useFirstPartyPluginsEffective(): EffectiveMap {
  return useContext(FirstPartyPluginsEffectiveContext);
}

/**
 * Reads which first-party plugins are on from the host's extension snapshot.
 * It reads once, again whenever the host reports an extension change
 * (`changeRevision`), and when the window becomes visible; it never polls.
 * Until the first answer, and after a failed read, it keeps what it last
 * knew, starting with every plugin on, so a surface is not hidden only
 * because the snapshot is on its way. A read that changes nothing keeps the
 * same map, so consumers do not re-render.
 */
export function useHostFirstPartyPluginsEffective(
  client: ExtensionClient,
  changeRevision: number,
): EffectiveMap {
  const [effective, setEffective] = useState<EffectiveMap>(FIRST_PARTY_PLUGINS_EFFECTIVE);
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!documentIsVisible()) return;
      try {
        const next = firstPartyPluginsEffectiveFromSnapshot(await client.snapshot());
        if (active) setEffective((current) => (sameEffective(current, next) ? current : next));
      } catch {
        // Keep the last answer: an unreachable extension service is not a
        // switch turned off.
      }
    };
    void load();
    if (typeof document === "undefined") {
      return () => {
        active = false;
      };
    }
    const loadWhenVisible = () => void load();
    document.addEventListener("visibilitychange", loadWhenVisible);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", loadWhenVisible);
    };
  }, [client, changeRevision]);
  return effective;
}

function sameEffective(current: EffectiveMap, next: EffectiveMap): boolean {
  if (current.size !== next.size) return false;
  for (const [id, on] of next) if (current.get(id) !== on) return false;
  return true;
}
