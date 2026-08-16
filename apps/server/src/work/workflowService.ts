import {
  UtcTimestamp,
  decodeWorkflow,
  decodeWorkflowId,
  type WorkThreadId,
  type Workflow,
  type WorkflowFrame,
  type WorkflowId,
  type ProjectId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { WorkflowProjection } from "./workflowProjection";

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

/**
 * The honest thread-lifecycle vocabulary this service reacts to. `active`
 * covers a newly created or reactivated thread; completion is an explicit,
 * user-confirmed signal and is never inferred from archiving;
 * `archived` is only a pause and leaves an in-flight workflow `active`;
 * `deleting`/`deleted` are the thread's removal states. No Code board, Git,
 * or coding-test vocabulary is used.
 */
export type WorkflowThreadLifecycle = "active" | "archived" | "deleting" | "deleted";

/**
 * An authoritative lifecycle fact in thread-journal order. Reconciliation
 * consumes the full history, rather than only the current thread snapshot,
 * so a lost workflow append can be rebuilt after later thread changes.
 */
export interface WorkflowThreadLifecycleFact {
  readonly projectId: ProjectId;
  readonly relatedThreadId: WorkThreadId;
  readonly label: string;
  readonly lifecycle: WorkflowThreadLifecycle | "completed";
}

export interface WorkflowThreadSourcePort {
  listFacts(): ReadonlyArray<WorkflowThreadLifecycleFact>;
}

export interface WorkflowEventStorePort {
  append(input: {
    readonly workflowId: WorkflowId;
    readonly expectedVersion: number;
    readonly frame: WorkflowFrame;
  }): WorkflowFrame;
  replayAll():
    | {
        readonly status: "ok";
        readonly frames: ReadonlyArray<WorkflowFrame>;
      }
    | { readonly status: "snapshot-required"; readonly reason: string };
}

export interface WorkflowServiceOptions {
  readonly projection: WorkflowProjection;
  readonly eventStore: WorkflowEventStorePort;
  readonly threads: WorkflowThreadSourcePort;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export class WorkflowServiceError extends Error {
  override readonly name = "WorkflowServiceError";
}

/**
 * Server-authoritative Work workflow service. This is a downstream side
 * channel driven by already-authorized Work thread lifecycle facts — it
 * never performs its own authority check and never affects whether a thread
 * command succeeds. `recordThreadLifecycle` is idempotent: calling it
 * repeatedly with the same resulting lifecycle for a thread (e.g. on every
 * rename) starts or transitions a workflow at most once per real lifecycle
 * change, because it always compares against the latest known workflow for
 * that thread. Archiving a thread is only a pause and never completes its
 * workflow; completion happens only on an explicit, user-confirmed
 * completion signal. A thread's `active` state starts a *new* workflow
 * identity only when the previous workflow for that thread (if any) is
 * terminal, so a reopened thread after a real completion gets its own
 * bounded workflow rather than resurrecting a completed one.
 */
export class WorkflowService {
  readonly #projection: WorkflowProjection;
  readonly #eventStore: WorkflowEventStorePort;
  readonly #threads: WorkflowThreadSourcePort;
  readonly #uuid: () => string;
  readonly #clock: () => string;

  constructor(options: WorkflowServiceOptions) {
    this.#projection = options.projection;
    this.#eventStore = options.eventStore;
    this.#threads = options.threads;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
  }

  /**
   * Replays all journaled workflow frames, then reconciles the projection
   * against the authoritative thread lifecycle history. Call once after
   * restart or reconnect before serving Overview reads. Throws if the event
   * store reports `snapshot-required`, so hydration fails closed instead of
   * serving a partially rebuilt projection.
   */
  hydrate(): void {
    const result = this.#eventStore.replayAll();
    if (result.status !== "ok") {
      throw new WorkflowServiceError(
        "Work workflow hydration failed; a malformed frame or scan-limit requires a snapshot rebuild.",
      );
    }
    for (const frame of result.frames) {
      this.#projection.apply(frame);
    }
    try {
      this.#reconcile(this.#threads.listFacts());
    } catch {
      // A later hydration retries if the thread source is temporarily unavailable.
    }
  }

  #reconcile(facts: ReadonlyArray<WorkflowThreadLifecycleFact>): void {
    const archivedThreads = new Set<string>();
    const periodIndexes = new Map<string, number>();
    for (const fact of facts) {
      const threadKey = String(fact.relatedThreadId);
      const periodIndex = periodIndexes.get(threadKey) ?? 0;
      const workflowForPeriod = this.#projection.listForThread(fact.relatedThreadId)[periodIndex];
      if (fact.lifecycle === "completed") {
        if (workflowForPeriod?.lifecycle === "active") {
          this.#transition(workflowForPeriod, "completed");
        }
        continue;
      }
      if (fact.lifecycle === "archived") {
        archivedThreads.add(threadKey);
        continue;
      }
      if (fact.lifecycle === "active") {
        if (archivedThreads.has(threadKey)) {
          periodIndexes.set(threadKey, periodIndex + 1);
        }
        const nextPeriodIndex = periodIndexes.get(threadKey) ?? periodIndex;
        const expectedWorkflow = this.#projection.listForThread(fact.relatedThreadId)[
          nextPeriodIndex
        ];
        if (expectedWorkflow === undefined) {
          this.recordThreadLifecycle({ ...fact, lifecycle: "active" });
        }
        archivedThreads.delete(threadKey);
        continue;
      }
      this.recordThreadLifecycle({ ...fact, lifecycle: fact.lifecycle });
    }
  }

  listByProject(projectId: ProjectId): ReadonlyArray<Workflow> {
    return this.#projection.listByProject(projectId);
  }

  hasActiveForThread(projectId: ProjectId, threadId: WorkThreadId): boolean {
    return this.#projection.hasActiveForThread(projectId, threadId);
  }

  /**
   * Reacts to a Work thread's current lifecycle fact. Never throws: a
   * workflow-tracking failure (a concurrent conflict, a journal write
   * failure) is swallowed so it can never break the authoritative thread
   * command that already succeeded before this was called. The workflow
   * projection simply falls behind until the next lifecycle change retries
   * it, rather than corrupting or blocking Work thread state.
   */
  recordThreadLifecycle(input: {
    readonly projectId: ProjectId;
    readonly relatedThreadId: WorkThreadId;
    readonly label: string;
    readonly lifecycle: WorkflowThreadLifecycle;
  }): void {
    try {
      const latest = this.#projection.latestForThread(input.relatedThreadId);
      if (input.lifecycle === "active") {
        if (latest !== undefined && latest.lifecycle === "active") return;
        this.#start(input);
        return;
      }
      // Archiving is only a pause: it carries no confirmation that the
      // delivery target was satisfied, so it never completes the workflow.
      // The active workflow is left in place and a reactivated thread
      // continues the same bounded work period.
      if (input.lifecycle === "archived") return;
      if (latest === undefined || latest.lifecycle !== "active") return;
      this.#transition(latest, "cancelled");
    } catch {
      // Best-effort side channel; see class doc.
    }
  }

  /**
   * Completes an active workflow only after a caller has an explicit,
   * user-confirmed delivery-target signal. Thread archiving is intentionally
   * not such a signal.
   */
  confirmCompletion(input: { readonly relatedThreadId: WorkThreadId }): void {
    try {
      const latest = this.#projection.latestForThread(input.relatedThreadId);
      if (latest === undefined || latest.lifecycle !== "active") return;
      this.#transition(latest, "completed");
    } catch {
      // Best-effort side channel; see class doc.
    }
  }

  #start(input: {
    readonly projectId: ProjectId;
    readonly relatedThreadId: WorkThreadId;
    readonly label: string;
  }): void {
    const now = decodeTimestamp(this.#clock());
    const workflow: Workflow = decodeWorkflow({
      workflowId: decodeWorkflowId(this.#uuid()),
      projectId: input.projectId,
      relatedThreadId: input.relatedThreadId,
      label: workflowLabel(input.label),
      lifecycle: "active",
      startedAt: now,
      updatedAt: now,
      version: 1,
    });
    const frame: WorkflowFrame = { kind: "started", workflow };
    this.#append(workflow.workflowId, 0, frame);
  }

  #transition(current: Workflow, lifecycle: "completed" | "cancelled"): void {
    const now = decodeTimestamp(this.#clock());
    const workflow: Workflow = decodeWorkflow({
      ...current,
      lifecycle,
      updatedAt: now,
      version: current.version + 1,
    });
    const frame: WorkflowFrame =
      lifecycle === "completed" ? { kind: "completed", workflow } : { kind: "cancelled", workflow };
    this.#append(workflow.workflowId, current.version, frame);
  }

  #append(workflowId: WorkflowId, expectedVersion: number, frame: WorkflowFrame): void {
    const committed = this.#eventStore.append({
      workflowId,
      expectedVersion,
      frame,
    });
    this.#projection.apply(committed);
  }
}

/** Thread titles are unbounded; workflow labels must always fit their wire contract. */
function workflowLabel(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= 512) return trimmed;
  return `${trimmed.slice(0, 511).trimEnd()}…`;
}
