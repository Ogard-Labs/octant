import {
  AutomationListResponse,
  decodeHostAnswer,
  type AutomationScheduledTrigger,
  type AutomationSummary,
} from "@octant/contracts";
import { MobileInboxFailure, type MobileRemoteTransport } from "./mobileInboxClient";

const ROUTINE_PAGE_LIMIT = 100;
/**
 * A Project's whole list is read page by page, as a window does, because the
 * host orders it by last change and counts archived routines too: one page
 * would let a busy Project's older routine drop out of its own thread's list.
 * The bound keeps a pathological Project from turning one read into a long walk.
 */
const MAX_ROUTINE_PAGES = 10;

/** One routine a thread set up, as a paired phone may show it: read only. */
export interface MobileThreadRoutine {
  readonly id: string;
  readonly name: string;
  readonly trigger: AutomationScheduledTrigger;
  readonly paused: boolean;
  readonly nextDueAt: string | null;
  /** A one-time turn sent back into this thread, not a new thread. */
  readonly followUp: boolean;
}

/**
 * The enabled and paused routines this thread created or follows up with, read
 * from the host over the paired session. A paired device may read routines
 * (the remote route policy classifies the read as a Project overview); it
 * changes none of them here, because resuming or editing a routine stays with
 * a window on the computer. A routine the Project lists for another thread is
 * left out, and so is a follow-up whose one run has started.
 */
export async function loadMobileThreadRoutines(
  transport: MobileRemoteTransport,
  thread: {
    readonly threadId: string;
    readonly mode: "work" | "code";
    readonly projectId: string;
  },
): Promise<ReadonlyArray<MobileThreadRoutine>> {
  const kept: AutomationSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_ROUTINE_PAGES; page += 1) {
    const query = new URLSearchParams({
      mode: thread.mode,
      projectId: thread.projectId,
      limit: String(ROUTINE_PAGE_LIMIT),
    });
    if (cursor !== undefined) query.set("cursor", cursor);
    const response = await transport.authenticatedFetch({
      method: "GET",
      path: "/api/automations/list",
      query: `?${query.toString()}`,
    });
    if (!response.ok) {
      throw new MobileInboxFailure(
        response.status === 403 ? "rejected" : "unavailable",
        "Could not load this thread's routines from the host.",
      );
    }
    let listed: AutomationListResponse;
    try {
      listed = decodeHostAnswer(AutomationListResponse)(await response.json());
    } catch {
      throw new MobileInboxFailure(
        "unavailable",
        "Could not load this thread's routines from the host. The host returned an invalid response.",
      );
    }
    for (const item of listed.items) {
      if (item.originThreadId === undefined || String(item.originThreadId) !== thread.threadId) {
        continue;
      }
      if (item.lifecycle !== "enabled" && item.lifecycle !== "paused") continue;
      // A follow-up whose one run has started is no longer still to come.
      if (item.targetPolicy === "same-thread" && item.latestRunLifecycle !== undefined) continue;
      kept.push(item);
    }
    if (listed.nextCursor === undefined) break;
    cursor = listed.nextCursor;
  }
  return kept
    .filter((item): item is AutomationSummary & { trigger: AutomationScheduledTrigger } =>
      isScheduled(item),
    )
    .sort((left, right) => dueOrder(left) - dueOrder(right))
    .map((item) => ({
      id: String(item.id),
      name: item.displayName,
      trigger: item.trigger,
      paused: item.lifecycle === "paused",
      nextDueAt: item.nextDueAt,
      followUp: item.targetPolicy === "same-thread",
    }));
}

/** A routine started by a schedule; an event or file routine has no time to show. */
function isScheduled(
  item: AutomationSummary,
): item is AutomationSummary & { trigger: AutomationScheduledTrigger } {
  return (
    item.trigger.kind === "once" ||
    item.trigger.kind === "interval" ||
    item.trigger.kind === "weekly-local"
  );
}

function dueOrder(item: AutomationSummary): number {
  return item.nextDueAt === null ? Number.POSITIVE_INFINITY : Date.parse(item.nextDueAt);
}
