import type { AgentProfileClient } from "@octant/client-runtime";
import type { AgentProfile } from "@octant/contracts/agent-profile";
import { useEffect, useState } from "react";

/** Saved records remain available to existing thread labels and the automation catalog. */
export function useAgentProfiles(client: AgentProfileClient): ReadonlyArray<AgentProfile> {
  const [profiles, setProfiles] = useState<ReadonlyArray<AgentProfile>>([]);
  useEffect(() => {
    let cancelled = false;
    setProfiles([]);
    void client.list().then(
      (loaded) => {
        if (!cancelled) setProfiles(loaded);
      },
      () => {
        if (!cancelled) setProfiles([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);
  return profiles;
}
