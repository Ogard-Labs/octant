import type { AgentRunAuthority, OctantMode } from "@octant/contracts";

/**
 * Conservative, mode-derived AgentRun authority ceilings.
 *
 * Mode ceilings are an upper bound only. Child admission also intersects the
 * parent thread's live effective grant via `clampAgentRunAuthority` /
 * `clampAgentRunAuthorityAgainstLiveGrant` (and
 * `resolveAgentRunLiveParentGrant` when the unified tool-call policy engine is
 * not yet available). A mode ceiling can only narrow; it never substitutes for
 * a narrower live grant.
 *
 * - Chat is research-only: no implicit filesystem, shell, git, or network
 *   authority, and execution stays plan-only.
 * - Work stays inside its OS-confined Project root: filesystem is
 *   available but shell/git are not implicitly granted.
 * - Code is the widest mode but is never full-access by default; it starts
 *   approval-gated like every other mode ceiling here.
 *
 * None of these ceilings persist permission grants across sessions
 * (`permissionPersistence` is always `current-session`), so a child never
 * silently inherits a standing project-default grant it was not explicitly
 * given.
 */
export function defaultAgentRunAuthorityCeilingForMode(mode: OctantMode): AgentRunAuthority {
  switch (mode) {
    case "chat":
      return {
        filesystem: false,
        shell: false,
        git: false,
        network: false,
        tools: true,
        subagents: true,
        executionPolicy: "plan",
        permissionPersistence: "current-session",
      };
    case "work":
      return {
        filesystem: true,
        shell: false,
        git: false,
        network: false,
        tools: true,
        subagents: true,
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
      };
    case "code":
      return {
        filesystem: true,
        shell: true,
        git: true,
        network: true,
        tools: true,
        subagents: true,
        // Absolute mode maximum: Full access is only reached when the parent
        // thread's live grant is itself full-access. Default live resolution
        // stays approval-gated via `resolveAgentRunLiveParentGrant`.
        executionPolicy: "full-access",
        permissionPersistence: "current-session",
      };
  }
}
