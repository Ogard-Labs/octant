import {
  USAGE_RESUME_CANCELLED,
  USAGE_RESUME_SCHEDULED,
  USAGE_RESUME_SETTLED,
  WorkThreadCreated as WorkThreadCreatedSchema,
  WorkThreadUpdated as WorkThreadUpdatedSchema,
  WorkThreadCompletionConfirmed as WorkThreadCompletionConfirmedSchema,
  decodeUsageResumeCancelled,
  decodeUsageResumeScheduled,
  decodeUsageResumeSettled,
  decodeWorkSettingsUpdated,
  type UsageResumeThreadState,
  type WorkSettings,
  type WorkSettingsUpdated,
  type WorkThread,
  type WorkThreadCompletionConfirmed,
  type WorkThreadCreated,
  type WorkThreadId,
  type WorkThreadUpdated,
  type ProjectId,
} from "@octant/contracts";
import { Schema } from "effect";
import { hydrateJournalProjection } from "../persistence/journalHydration";
import type { WorkflowThreadLifecycleFact } from "./workflowService";

const decodeWorkThreadCreated = Schema.decodeUnknownSync(WorkThreadCreatedSchema);
const decodeWorkThreadUpdated = Schema.decodeUnknownSync(WorkThreadUpdatedSchema);
const decodeWorkThreadCompletionConfirmed = Schema.decodeUnknownSync(
  WorkThreadCompletionConfirmedSchema,
);

export class WorkThreadProjection {
  readonly #threads = new Map<WorkThreadId, WorkThread>();
  readonly #lifecycleFacts: Array<WorkflowThreadLifecycleFact> = [];
  #settings: WorkSettings | undefined;

  /** Work's defaults for new threads, as last journaled; undefined until first saved. */
  settings(): WorkSettings | undefined {
    return this.#settings;
  }

  applySettings(event: WorkSettingsUpdated): void {
    const settings = decodeWorkSettingsUpdated(event).settings;
    if (this.#settings !== undefined && settings.version <= this.#settings.version) return;
    this.#settings = settings;
  }

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

  /**
   * The thread's recovery state, keyed apart from the journaled thread copy:
   * `usage-resume.*` events land on this aggregate without embedding into a
   * `thread-updated` payload, so this map — not the stored thread — is the
   * authoritative read. `read`/`list` merge it over any embedded copy.
   */
  readonly #usageResumeByThread = new Map<string, UsageResumeThreadState>();

  read(threadId: WorkThreadId): WorkThread | undefined {
    const thread = this.#threads.get(threadId);
    return thread === undefined ? undefined : this.#withUsageResume(thread);
  }

  forget(threadId: WorkThreadId): void {
    this.#threads.delete(threadId);
    this.#usageResumeByThread.delete(String(threadId));
  }

  list(): ReadonlyArray<WorkThread> {
    return [...this.#threads.values()]
      .filter((thread) => thread.lifecycle !== "deleted")
      .sort(
        (left, right) => right.updatedAt.localeCompare(left.updatedAt) || compareIds(left, right),
      )
      .map((thread) => this.#withUsageResume(thread));
  }

  #withUsageResume(thread: WorkThread): WorkThread {
    const usageResume = this.#usageResumeByThread.get(String(thread.id));
    const { usageResume: _embedded, ...rest } = thread;
    return usageResume === undefined ? rest : { ...rest, usageResume };
  }

  applyUsageResume(event: { readonly eventName: string; readonly payload: unknown }): void {
    if (event.eventName === USAGE_RESUME_SCHEDULED) {
      const { resume } = decodeUsageResumeScheduled(event.payload);
      this.#usageResumeByThread.set(resume.threadId, { record: resume, status: "scheduled" });
      return;
    }
    if (event.eventName === USAGE_RESUME_CANCELLED) {
      const { resume } = decodeUsageResumeCancelled(event.payload);
      this.#usageResumeByThread.delete(resume.threadId);
      return;
    }
    if (event.eventName === USAGE_RESUME_SETTLED) {
      const settled = decodeUsageResumeSettled(event.payload);
      this.#usageResumeByThread.set(settled.resume.threadId, {
        record: settled.resume,
        status: settled.outcome,
        ...(settled.detail === undefined ? {} : { detail: settled.detail }),
      });
    }
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
  readonly replay: (cursor: {
    afterSequence: number;
    limit: number;
    aggregateType?: string;
  }) => ReadonlyArray<{
    readonly globalSequence: number;
    readonly aggregateType?: string;
    readonly eventName: string;
    readonly eventVersion: number;
    readonly payload: unknown;
  }>;
  readonly projection: WorkThreadProjection;
  readonly maxScan?: number;
}): "ok" | "snapshot-required" {
  return hydrateJournalProjection({
    replay: input.replay,
    aggregateType: "work-thread",
    ...(input.maxScan === undefined ? {} : { maxScan: input.maxScan }),
    apply: (envelope) => {
      if (
        (envelope.aggregateType !== undefined && envelope.aggregateType !== "work-thread") ||
        envelope.eventVersion !== 1
      ) {
        return;
      }
      if (
        envelope.eventName === USAGE_RESUME_SCHEDULED ||
        envelope.eventName === USAGE_RESUME_CANCELLED ||
        envelope.eventName === USAGE_RESUME_SETTLED
      ) {
        try {
          input.projection.applyUsageResume({
            eventName: envelope.eventName,
            payload: envelope.payload,
          });
        } catch {
          // Ignore malformed historical records during best-effort hydration.
        }
        return;
      }
      if (
        envelope.eventName !== "work.thread-created@1" &&
        envelope.eventName !== "work.thread-updated@1" &&
        envelope.eventName !== "work.thread-completion-confirmed@1"
      ) {
        return;
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
    },
  });
}

/** Rebuilds Work's defaults from their own journal aggregate. */
export function hydrateWorkSettingsFromJournal(input: {
  readonly replay: Parameters<typeof hydrateWorkThreadProjectionFromJournal>[0]["replay"];
  readonly projection: WorkThreadProjection;
  readonly maxScan?: number;
}): "ok" | "snapshot-required" {
  return hydrateJournalProjection({
    replay: input.replay,
    aggregateType: "work-settings",
    ...(input.maxScan === undefined ? {} : { maxScan: input.maxScan }),
    apply: (envelope) => {
      if (
        (envelope.aggregateType !== undefined && envelope.aggregateType !== "work-settings") ||
        envelope.eventVersion !== 1 ||
        envelope.eventName !== "work.settings-updated@1"
      ) {
        return;
      }
      try {
        input.projection.applySettings(decodeWorkSettingsUpdated(envelope.payload));
      } catch {
        // Ignore malformed historical records during best-effort hydration.
      }
    },
  });
}

function compareIds(left: WorkThread, right: WorkThread): number {
  return String(left.id).localeCompare(String(right.id));
}
