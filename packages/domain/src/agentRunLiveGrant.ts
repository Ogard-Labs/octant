import type { AgentRunAuthority, OctantMode } from "@octant/contracts";
import { defaultAgentRunAuthorityCeilingForMode } from "./agentRunAuthorityCeiling";
import {
  AgentRunPolicyRejected,
  clampAgentRunAuthority,
  clampAgentRunAuthorityAgainstLiveGrant,
} from "./agentRunPolicy";

/**
 * Server-resolved live parent-grant facts for child AgentRun clamping.
 *
 * These stand in for unified tool-call policy engine resolution where that
 * engine is not wired in: callers pass live grant facts already
 * observed from the parent thread, never client-supplied ceilings.
 */
export interface AgentRunLiveParentGrantFacts {
  readonly mode: OctantMode;
  readonly filesystem: boolean;
  readonly shell: boolean;
  readonly git: boolean;
  readonly network: boolean;
  readonly tools: boolean;
  readonly subagents: boolean;
  readonly executionPolicy: AgentRunAuthority["executionPolicy"];
  readonly permissionPersistence: AgentRunAuthority["permissionPersistence"];
}

/**
 * Resolve the parent's live effective grant, intersected with the mode
 * ceiling. Facts that claim wider authority than the mode allows fail closed.
 */
export function resolveAgentRunLiveParentGrant(
  facts: AgentRunLiveParentGrantFacts,
): AgentRunAuthority {
  const modeCeiling = defaultAgentRunAuthorityCeilingForMode(facts.mode);
  const claimed: AgentRunAuthority = {
    filesystem: facts.filesystem,
    shell: facts.shell,
    git: facts.git,
    network: facts.network,
    tools: facts.tools,
    subagents: facts.subagents,
    executionPolicy: facts.executionPolicy,
    permissionPersistence: facts.permissionPersistence,
  };
  try {
    return clampAgentRunAuthority({
      parentAuthority: modeCeiling,
      requestedAuthority: claimed,
    });
  } catch (error) {
    if (error instanceof AgentRunPolicyRejected && error.code === "authority-widening") {
      throw new AgentRunPolicyRejected(
        "authority-widening",
        "Live parent grant cannot exceed the mode authority ceiling.",
      );
    }
    throw error;
  }
}

/**
 * Clamp a child request against both the mode ceiling and the live parent
 * grant derived from server-resolved facts.
 */
export function clampAgentRunAuthorityFromLiveGrantFacts(input: {
  readonly facts: AgentRunLiveParentGrantFacts;
  readonly requestedAuthority: AgentRunAuthority;
  readonly projectCeiling?: AgentRunAuthority;
  readonly globalCeiling?: AgentRunAuthority;
}): AgentRunAuthority {
  const modeCeiling = defaultAgentRunAuthorityCeilingForMode(input.facts.mode);
  const liveParentGrant = resolveAgentRunLiveParentGrant(input.facts);
  return clampAgentRunAuthorityAgainstLiveGrant({
    modeCeiling,
    liveParentGrant,
    requestedAuthority: input.requestedAuthority,
    ...(input.projectCeiling === undefined ? {} : { projectCeiling: input.projectCeiling }),
    ...(input.globalCeiling === undefined ? {} : { globalCeiling: input.globalCeiling }),
  });
}
