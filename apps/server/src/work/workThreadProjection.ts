import {
  WorkThreadCreated as WorkThreadCreatedSchema,
  WorkThreadUpdated as WorkThreadUpdatedSchema,
  WorkThreadCompletionConfirmed as WorkThreadCompletionConfirmedSchema,
  type WorkThread,
  type WorkThreadCompletionConfirmed,
  type WorkThreadCreated,
  type WorkThreadId,
  type WorkThreadUpdated,
  type ProjectId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { WorkflowThreadLifecycleFact } from "./workflowService";

const decodeWorkThreadCreated = Schema.decodeUnknownSync(WorkThreadCreatedSchema);
const decodeWorkThreadUpdated = Schema.decodeUnknownSync(WorkThreadUpdatedSchema);
const decodeWorkThreadCompletionConfirmed = Schema.decodeUnknownSync(
  WorkThreadCompletionConfirmedSchema,
);

export class WorkThreadProjection {
  readonly #threads = new Map<WorkThreadId, WorkThread>();
  readonly #lifecycleFacts: Array<WorkflowThreadLifecycleFact> = [];

  apply(event: WorkThreadCreated | WorkThreadUpdated | WorkThreadCompletionConfirmed): void {
    const thread =
      event.kind === "thread-created"
        ? decodeWorkThreadCreated(event).thread
        : event.kind === "thread-updated"
          ? decodeWorkThreadUpdated(event).thread
          : decodeWorkThreadCompletionConfirmed(event).thread;
    this.#threads.set(thread.id, thread);
    this.#lifecycleFacts.push({
      projectId: thread.projectId,
      relatedThreadId: thread.id,
      label: thread.title,
      lifecycle: event.kind === "thread-completion-confirmed" ? "completed" : thread.lifecycle,
    });
  }

  read(threadId: WorkThreadId): WorkThread | undefined {
    return this.#threads.get(threadId);
  }

  list(): ReadonlyArray<WorkThread> {
    return [...this.#threads.values()]
      .filter((thread) => thread.lifecycle !== "deleted")
      .sort(
        (left, right) => right.updatedAt.localeCompare(left.updatedAt) || compareIds(left, right),
      );
  }

  /**
   * Every applied thread lifecycle fact in journal order. Used by workflow
   * reconciliation to rebuild side-channel transitions that were lost after
   * the authoritative thread append committed.
   */
  listLifecycleFacts(): ReadonlyArray<WorkflowThreadLifecycleFact> {
    return [...this.#lifecycleFacts];
  }

  listByProject(projectId: ProjectId): ReadonlyArray<WorkThread> {
    return this.list().filter((thread) => String(thread.projectId) === String(projectId));
  }
}

export function hydrateWorkThreadProjectionFromJournal(input: {
  readonly replay: (cursor: { afterSequence: number; limit: number }) => ReadonlyArray<{
    readonly globalSequence: number;
    readonly aggregateType: string;
    readonly eventName: string;
    readonly eventVersion: number;
    readonly payload: unknown;
  }>;
  readonly projection: WorkThreadProjection;
  readonly maxScan?: number;
}): void {
  const maxScan = input.maxScan ?? 100_000;
  let afterSequence = 0;
  let scanned = 0;
  for (;;) {
    const batch = input.replay({ afterSequence, limit: 1_000 });
    if (batch.length === 0) break;
    for (const envelope of batch) {
      afterSequence = envelope.globalSequence;
      scanned += 1;
      if (scanned > maxScan) return;
      if (
        envelope.aggregateType !== "work-thread" ||
        envelope.eventVersion !== 1 ||
        (envelope.eventName !== "work.thread-created@1" &&
          envelope.eventName !== "work.thread-updated@1" &&
          envelope.eventName !== "work.thread-completion-confirmed@1")
      ) {
        continue;
      }
      try {
        input.projection.apply(
          envelope.eventName === "work.thread-created@1"
            ? decodeWorkThreadCreated(envelope.payload)
            : envelope.eventName === "work.thread-updated@1"
              ? decodeWorkThreadUpdated(envelope.payload)
              : decodeWorkThreadCompletionConfirmed(envelope.payload),
        );
      } catch {
        // Ignore malformed historical records during best-effort hydration.
      }
    }
    if (batch.length < 1_000) break;
  }
}

function compareIds(left: WorkThread, right: WorkThread): number {
  return String(left.id).localeCompare(String(right.id));
}
