import type { Workflow, WorkflowFrame, WorkflowId } from "@octant/contracts/work-workflows";
import type { WorkThreadId } from "@octant/contracts/work-threads";
import type { ProjectId } from "@octant/contracts/projects";

/**
 * Rebuildable in-memory Work workflow projection. The workflow service
 * replays journaled `WorkflowFrame` events into this projection to
 * reconstruct workflow identity, lifecycle, owning Project, and related
 * thread. The projection is idempotent: replaying the same frame sequence
 * produces identical state, so reconnect or restart rebuilds workflow state
 * from the authoritative event journal without a separate store. A frame
 * whose version is not strictly newer than the current head is ignored, so a
 * reconnect/duplicate subscription can never roll a terminal workflow
 * (completed/cancelled) back to an earlier version.
 */
interface WorkflowEntry {
  readonly workflow: Workflow;
  // Monotonic application order. `updatedAt` alone cannot totally order two
  // workflows applied within the same clock tick (e.g. a thread completed
  // and immediately reopened), so bounded ordering falls back to the order
  // frames were actually applied from the journal.
  readonly appliedSequence: number;
}

export class WorkflowProjection {
  readonly #workflows = new Map<WorkflowId, WorkflowEntry>();
  #appliedCounter = 0;

  apply(frame: WorkflowFrame): void {
    const workflow = frame.workflow;
    const existing = this.#workflows.get(workflow.workflowId);
    if (existing !== undefined && workflow.version <= existing.workflow.version) {
      return;
    }
    this.#appliedCounter += 1;
    this.#workflows.set(workflow.workflowId, { workflow, appliedSequence: this.#appliedCounter });
  }

  lookup(workflowId: WorkflowId): Workflow | undefined {
    return this.#workflows.get(workflowId)?.workflow;
  }

  /**
   * The most recently updated workflow bound to the given thread, across
   * every workflow instance that thread has ever had (active or terminal).
   * Used by the workflow service to decide whether a thread lifecycle change
   * should start a new workflow or transition an existing one.
   */
  latestForThread(threadId: WorkThreadId): Workflow | undefined {
    let latest: WorkflowEntry | undefined;
    for (const entry of this.#workflows.values()) {
      if (String(entry.workflow.relatedThreadId) !== String(threadId)) continue;
      if (latest === undefined || entry.appliedSequence > latest.appliedSequence) {
        latest = entry;
      }
    }
    return latest?.workflow;
  }

  listForThread(threadId: WorkThreadId): ReadonlyArray<Workflow> {
    return [...this.#workflows.values()]
      .filter((entry) => String(entry.workflow.relatedThreadId) === String(threadId))
      .sort((left, right) => left.appliedSequence - right.appliedSequence)
      .map((entry) => entry.workflow);
  }

  /**
   * Active workflows for a Project, most recently updated first, bounded to
   * 64 entries — matching the Overview projection's other section caps.
   * Terminal (completed/cancelled) records are filtered out before sorting
   * and slicing so recently finished work can never displace an older but
   * still-active workflow from the bounded list.
   */
  listByProject(projectId: ProjectId): ReadonlyArray<Workflow> {
    return [...this.#workflows.values()]
      .filter((entry) => String(entry.workflow.projectId) === String(projectId))
      .filter((entry) => entry.workflow.lifecycle === "active")
      .sort((left, right) => (isNewer(left, right) ? -1 : isNewer(right, left) ? 1 : 0))
      .slice(0, 64)
      .map((entry) => entry.workflow);
  }

  hasActiveForThread(projectId: ProjectId, threadId: WorkThreadId): boolean {
    for (const entry of this.#workflows.values()) {
      if (
        String(entry.workflow.projectId) === String(projectId) &&
        String(entry.workflow.relatedThreadId) === String(threadId) &&
        entry.workflow.lifecycle === "active"
      ) {
        return true;
      }
    }
    return false;
  }

  snapshot(): ReadonlyMap<WorkflowId, Workflow> {
    const result = new Map<WorkflowId, Workflow>();
    for (const [id, entry] of this.#workflows) result.set(id, entry.workflow);
    return result;
  }
}

function isNewer(candidate: WorkflowEntry, than: WorkflowEntry): boolean {
  const byTimestamp = candidate.workflow.updatedAt.localeCompare(than.workflow.updatedAt);
  if (byTimestamp !== 0) return byTimestamp > 0;
  return candidate.appliedSequence > than.appliedSequence;
}
