import type { SidebarActivityMode } from "./activityViewModel";

export type ThreadSearchLifecycle = "active" | "archived" | "deleting" | "deleted";

/**
 * One thread the host already listed for this window. The caller maps the
 * current mode's server-authoritative thread list into this shape; Search never
 * discovers threads of its own, so it can only ever show what the host listed.
 */
export interface ThreadSearchThread {
  readonly mode: SidebarActivityMode;
  readonly threadId: string;
  readonly title: string;
  readonly projectId?: string;
  readonly lifecycle: ThreadSearchLifecycle;
  readonly updatedAt?: string;
}

export interface ThreadSearchProject {
  readonly id: string;
  readonly name: string;
}

/** The folder word shown beside a thread. A label, never a filter. */
export type ThreadSearchUnfiledLabel = "Unfiled" | "Recents";

export interface ThreadSearchHit {
  readonly threadId: string;
  readonly mode: SidebarActivityMode;
  readonly title: string;
  /**
   * The source thread's own Project. Opening a hit must pass this through, or
   * a cross-Project open dispatches a plain open-tab that the
   * server-authoritative workspace policy rightly rejects.
   */
  readonly projectId?: string;
  readonly folderLabel: string;
  readonly archived: boolean;
}

export type ThreadSearchGroupId = "threads" | "archived";

export interface ThreadSearchGroup {
  readonly id: ThreadSearchGroupId;
  readonly label: string;
  readonly hits: ReadonlyArray<ThreadSearchHit>;
}

export interface ThreadSearchResults {
  readonly groups: ReadonlyArray<ThreadSearchGroup>;
  readonly hitCount: number;
  /** True when a group was truncated, so the overlay can say so plainly. */
  readonly truncated: boolean;
}

/** Bound on hits rendered per group; the overlay reports truncation in words. */
export const THREAD_SEARCH_GROUP_LIMIT = 50;

export interface BuildThreadSearchResultsInput {
  readonly mode: SidebarActivityMode;
  readonly query: string;
  readonly threads: ReadonlyArray<ThreadSearchThread>;
  readonly projects: ReadonlyArray<ThreadSearchProject>;
  readonly unfiledLabel?: ThreadSearchUnfiledLabel;
  readonly limit?: number;
}

/**
 * Current-mode thread search.
 *
 * Search finds threads, not Project records: a Project name, `Recents`, and
 * `Unfiled` are folder words printed on a hit, never a filter and never an
 * authority boundary — a thread outside every Project, or in a Project the
 * current sidebar view does not show, still matches. The only exclusions are
 * the other modes (Chat, Work, and Code never mix) and threads the host has
 * already retired, so a named Code view or a collapsed section cannot hide a
 * hit. Archived matches are grouped after live ones rather than dropped.
 */
export function buildThreadSearchResults(
  input: BuildThreadSearchResultsInput,
): ThreadSearchResults {
  const needle = normalize(input.query);
  const limit = input.limit ?? THREAD_SEARCH_GROUP_LIMIT;
  const projectNames = new Map(input.projects.map((project) => [project.id, project.name]));
  const unfiledLabel = input.unfiledLabel ?? "Unfiled";

  const matches = input.threads
    .filter((thread) => thread.mode === input.mode)
    .filter((thread) => thread.lifecycle === "active" || thread.lifecycle === "archived")
    .filter((thread) => needle === "" || normalize(thread.title).includes(needle))
    .sort(compareThreads);

  const live = matches.filter((thread) => thread.lifecycle !== "archived");
  const archived = matches.filter((thread) => thread.lifecycle === "archived");
  const groups: ThreadSearchGroup[] = [];
  if (live.length > 0) {
    groups.push({
      id: "threads",
      label: "Threads",
      hits: live.slice(0, limit).map((thread) => toHit(thread, projectNames, unfiledLabel)),
    });
  }
  if (archived.length > 0) {
    groups.push({
      id: "archived",
      label: "Archived",
      hits: archived.slice(0, limit).map((thread) => toHit(thread, projectNames, unfiledLabel)),
    });
  }
  const hitCount = groups.reduce((total, group) => total + group.hits.length, 0);
  return { groups, hitCount, truncated: hitCount < live.length + archived.length };
}

/** Flat hit order for arrow-key navigation across both groups. */
export function flattenThreadSearchHits(
  results: ThreadSearchResults,
): ReadonlyArray<ThreadSearchHit> {
  return results.groups.flatMap((group) => group.hits);
}

function toHit(
  thread: ThreadSearchThread,
  projectNames: ReadonlyMap<string, string>,
  unfiledLabel: ThreadSearchUnfiledLabel,
): ThreadSearchHit {
  const folderLabel =
    thread.projectId === undefined
      ? unfiledLabel
      : (projectNames.get(thread.projectId) ?? unfiledLabel);
  return {
    threadId: thread.threadId,
    mode: thread.mode,
    title: thread.title,
    ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
    folderLabel,
    archived: thread.lifecycle === "archived",
  };
}

function compareThreads(left: ThreadSearchThread, right: ThreadSearchThread): number {
  const leftStamp = left.updatedAt ?? "";
  const rightStamp = right.updatedAt ?? "";
  if (leftStamp !== rightStamp) return rightStamp.localeCompare(leftStamp);
  return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
