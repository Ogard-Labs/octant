import type { AgentProfile, AgentProfileId } from "@octant/contracts/agent-profile";
import { createContext, useContext, type ReactNode } from "react";

const AgentProfileNamesContext = createContext<ReadonlyArray<AgentProfile>>([]);

/**
 * Publishes the saved profiles so a thread deep in the workspace can name the
 * one it was started under. The thread records only the identifier; the name
 * lives with the profile and is looked up here rather than carried down through
 * every workspace layer that has no other use for it.
 */
export function AgentProfileNamesProvider(props: {
  readonly children: ReactNode;
  readonly profiles: ReadonlyArray<AgentProfile>;
}) {
  return (
    <AgentProfileNamesContext.Provider value={props.profiles}>
      {props.children}
    </AgentProfileNamesContext.Provider>
  );
}

/**
 * The display name of the profile a thread started under, or undefined when it
 * started without one or that profile has since been deleted. A deleted profile
 * leaves the thread's authority exactly where it was — the narrowing happened
 * once, at creation — so the name simply stops being shown rather than the
 * thread claiming a profile that no longer exists.
 */
export function useAgentProfileName(profileId: AgentProfileId | undefined): string | undefined {
  const profiles = useContext(AgentProfileNamesContext);
  if (profileId === undefined) return undefined;
  return profiles.find((profile) => String(profile.id) === String(profileId))?.displayName;
}
