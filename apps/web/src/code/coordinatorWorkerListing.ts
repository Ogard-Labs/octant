import type {
  CoordinatorWorkerListing,
  CoordinatorWorkerListingByProject,
} from "@octant/contracts";
import { threadRowStatusInput, type ChatThreadNavigationItem } from "../shell/navigationModel";

/** Both off: a coordinator's workers live inside the coordinator's own thread. */
export const WORKERS_UNLISTED: CoordinatorWorkerListing = { sidebar: false, board: false };

/**
 * Where a Project's coordinators' workers are listed outside the coordinator
 * (docs/design/workspace.md#coordinators). The Project's own choice wins over
 * Settings; neither set means both off. This only decides listing: a worker's
 * authority, and who sees its requests, never depend on it.
 */
export function workerListingFor(
  settings:
    | {
        readonly coordinatorWorkerListing?: CoordinatorWorkerListing | undefined;
        readonly coordinatorWorkerListingByProject?: CoordinatorWorkerListingByProject | undefined;
      }
    | undefined,
  projectId: string | undefined,
): CoordinatorWorkerListing {
  const own =
    projectId === undefined
      ? undefined
      : (
          settings?.coordinatorWorkerListingByProject as
            | Readonly<Record<string, CoordinatorWorkerListing | undefined>>
            | undefined
        )?.[projectId];
  return own ?? settings?.coordinatorWorkerListing ?? WORKERS_UNLISTED;
}

/**
 * The Code rows the sidebar lists. With Show workers off for a worker's
 * Project, the worker is left out of the list, under its coordinator and among
 * the other threads alike, and its coordinator row carries how many of the
 * hidden workers are working and how many need the person, so the row's counts
 * still cover every request (docs/design/workspace.md#coordinators). A worker
 * whose coordinator is not listed stays an ordinary row. Needs you, Inbox and
 * search read the full list, never this one.
 */
export function sidebarThreadsWithWorkers(
  threads: ReadonlyArray<ChatThreadNavigationItem>,
  settings: Parameters<typeof workerListingFor>[0],
): ReadonlyArray<ChatThreadNavigationItem> {
  // Only a coordinator the Project tree lists can hold its workers: a put-away
  // coordinator sits on the Put away shelf, and its unfinished workers stay
  // ordinary Project rows, as the workspace specification keeps them.
  const coordinatorIds = new Set(
    threads
      .filter((thread) => thread.coordinator === true && thread.shelf !== "completed")
      .map((thread) => thread.threadId),
  );
  if (coordinatorIds.size === 0) return threads;
  const hidden = new Map<string, { working: number; attention: number }>();
  const listed: ChatThreadNavigationItem[] = [];
  for (const thread of threads) {
    const coordinatorId = thread.coordinatorThreadId;
    if (
      thread.coordinator === true ||
      coordinatorId === undefined ||
      !coordinatorIds.has(coordinatorId) ||
      workerListingFor(settings, thread.projectId).sidebar
    ) {
      listed.push(thread);
      continue;
    }
    const counts = hidden.get(coordinatorId) ?? { working: 0, attention: 0 };
    const facts = threadRowStatusInput(thread);
    if (facts.working) counts.working += 1;
    if (facts.attention) counts.attention += 1;
    hidden.set(coordinatorId, counts);
  }
  if (hidden.size === 0) return threads;
  return listed.map((thread) => {
    const counts = hidden.get(thread.threadId);
    return counts === undefined ? thread : { ...thread, hiddenWorkers: counts };
  });
}
