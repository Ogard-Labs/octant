import type { AgentRun, AgentRunAuthority } from "@octant/contracts";

/**
 * What a child that waited for a provider slot may start under, read when its
 * slot frees and not when it was admitted. Nothing here is remembered from the
 * wait's start: a parent that was tainted, archived, or stripped of the right to
 * start helpers since, or whose grant was narrowed, must not see its child
 * start under the grant it had earlier. Any `undefined` means the parent no
 * longer lets the child start; the caller ends the wait.
 *
 * These are the same facts a fresh delegation and an explicit Retry read:
 * the helper-agent setting, the thread's untrusted-content taint, the parent
 * thread being active, and the parent's live grant.
 */
export function currentParentAuthorityForWaiter(input: {
  readonly run: AgentRun;
  /** The setting "Let the agent start helper agents". */
  readonly startsHelpers: () => boolean;
  readonly isTainted: (run: AgentRun) => boolean;
  readonly isParentActive: (run: AgentRun) => boolean;
  readonly parentLiveAuthority: (run: AgentRun) => AgentRunAuthority | undefined;
}): AgentRunAuthority | undefined {
  if (!input.startsHelpers()) return undefined;
  if (input.isTainted(input.run)) return undefined;
  if (!input.isParentActive(input.run)) return undefined;
  const live = input.parentLiveAuthority(input.run);
  return live?.subagents === true ? live : undefined;
}
