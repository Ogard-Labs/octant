import type { AgentRun, AgentRunAuthority } from "@octant/contracts";

export interface AgentRunParentThreadFacts {
  readonly lifecycle: string;
  /** The Project the thread is in now; absent or null for a thread in none. */
  readonly projectId?: string | null | undefined;
}

/**
 * Whether the parent thread is still open and still in the Project the child
 * was routed under. Moving a thread to another Project during the wait would
 * otherwise start the child with the old Project's context and policy, which
 * the Resume route refuses for the same reason.
 */
export function parentThreadStillHostsRun(
  parent: AgentRunParentThreadFacts | undefined,
  run: Pick<AgentRun, "routingReceipt">,
): boolean {
  if (parent === undefined || parent.lifecycle !== "active") return false;
  return String(parent.projectId ?? "") === String(run.routingReceipt.projectId ?? "");
}

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
 * thread being active and still in the Project the child was routed under, and
 * the parent's live grant.
 */
export function currentParentAuthorityForWaiter(input: {
  readonly run: AgentRun;
  /** The setting "Let the agent start helper agents". */
  readonly startsHelpers: () => boolean;
  readonly isTainted: (run: AgentRun) => boolean;
  readonly parentThread: (run: AgentRun) => AgentRunParentThreadFacts | undefined;
  readonly parentLiveAuthority: (run: AgentRun) => AgentRunAuthority | undefined;
}): AgentRunAuthority | undefined {
  if (!input.startsHelpers()) return undefined;
  if (input.isTainted(input.run)) return undefined;
  if (!parentThreadStillHostsRun(input.parentThread(input.run), input.run)) return undefined;
  const live = input.parentLiveAuthority(input.run);
  return live?.subagents === true ? live : undefined;
}
