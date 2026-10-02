import type { AgentRun, AgentRunId, AgentRunLifecycleStatus } from "@octant/contracts";

/**
 * The recovery reason a run carries while it waits on sibling runs. Such a run
 * holds no capacity and no execution state, so a restart keeps it waiting and
 * the capacity queue never starts it.
 */
export const AGENT_RUN_DEPENDENCY_WAITING_REASON = "waiting-on-dependencies";

export type AgentRunDependencyDecision =
  /** The run has no dependencies, or is not parked on them; nothing to decide. */
  | { readonly kind: "not-waiting" }
  /** Some dependency is still on its way; the run keeps waiting. */
  | { readonly kind: "wait"; readonly pending: ReadonlyArray<AgentRunId> }
  /** Every dependency completed; the run may start. */
  | { readonly kind: "ready" }
  /** A dependency can no longer complete, so the run must never start. */
  | { readonly kind: "fail"; readonly recoveryReason: string };

/**
 * Whether a run parked on its dependencies may start, must keep waiting, or
 * can never run.
 *
 * Fail-fast covers what cannot come back: a dependency that failed or was
 * cancelled ends the dependent. An interrupted dependency does not — a restart
 * interrupts every running child, and a person can retry it — so the
 * dependent keeps waiting and the graph carries on if the retry completes.
 */
export function decideAgentRunDependencies(
  run: Pick<AgentRun, "lifecycleStatus" | "recoveryReason" | "dependsOn">,
  lookup: (runId: AgentRunId) => { readonly lifecycleStatus: AgentRunLifecycleStatus } | undefined,
): AgentRunDependencyDecision {
  const dependencies = run.dependsOn ?? [];
  if (
    dependencies.length === 0 ||
    run.lifecycleStatus !== "waiting" ||
    run.recoveryReason !== AGENT_RUN_DEPENDENCY_WAITING_REASON
  ) {
    return { kind: "not-waiting" };
  }
  const pending: AgentRunId[] = [];
  for (const dependencyId of dependencies) {
    const dependency = lookup(dependencyId);
    if (dependency === undefined) {
      return { kind: "fail", recoveryReason: `dependency-missing: ${String(dependencyId)}` };
    }
    if (dependency.lifecycleStatus === "failed" || dependency.lifecycleStatus === "cancelled") {
      return {
        kind: "fail",
        recoveryReason: `dependency-${dependency.lifecycleStatus}: ${String(dependencyId)}`,
      };
    }
    if (dependency.lifecycleStatus !== "completed") pending.push(dependencyId);
  }
  return pending.length === 0 ? { kind: "ready" } : { kind: "wait", pending };
}
