import type { SidebarActivityMode } from "./activityViewModel";

export type ThreadSearchLifecycle = "active" | "archived" | "deleting" | "deleted";

/**
 * One thread the host already listed for this window. The caller maps the
 * current mode's server-authoritative thread list into this shape; title Search
 * never discovers threads of its own, so it can only ever show what the host
 * listed. Message-body hits arrive separately from the host transcript search.
 */
export interface ThreadSearchThread {
  readonly mode: SidebarActivityMode;
  readonly threadId: string;
  readonly title: string;
  readonly projectId?: string;
  readonly lifecycle: ThreadSearchLifecycle;
  readonly updatedAt?: string;
  /** Code only: the title of the coordinator this thread is a worker of. */
  readonly workerOf?: string;
}

export interface ThreadSearchProject {
  readonly id: string;
  readonly name: string;
}

/** The folder word shown beside a thread. A label, never a filter. */
export type ThreadSearchUnfiledLabel = "No Project" | "Unfiled" | "Recents";

export interface ThreadSearchMatchRange {
  readonly start: number;
  readonly end: number;
}

/**
 * One Search row. Title hits come from the host's listed threads; content hits
 * come from the authenticated transcript-search route and carry a snippet plus
 * the turn to reveal.
 */
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
  /** The result is a worker of the coordinator with this title; it wears the worker mark. */
  readonly workerOf?: string;
  readonly turnId?: string;
  /** Where the host found the text; absent on a title match made from the listed threads. */
  readonly field?: ThreadSearchField;
  /** The Canvas whose words matched, on a `canvas` hit, and its own title. */
  readonly canvasId?: string;
  readonly canvasTitle?: string;
  readonly snippet?: string;
  readonly matchRanges?: ReadonlyArray<ThreadSearchMatchRange>;
}

/** Where in a thread the host matched the text. */
export type ThreadSearchField = "title" | "prompt" | "reply" | "tool" | "canvas";

/** Which modes the overlay searches: every mode, or one. */
export type ThreadSearchScope = "all" | SidebarActivityMode;

/** One authorized hit from the host's search. */
export interface ThreadSearchContentHit {
  /** The hit's own mode; absent means the mode the overlay searches. */
  readonly mode?: SidebarActivityMode;
  readonly threadId: string;
  readonly title: string;
  readonly projectId?: string;
  readonly lifecycle: "active" | "archived";
  /** Absent on a title or Canvas match, which names no turn. */
  readonly turnId?: string;
  readonly field?: ThreadSearchField;
  readonly canvasId?: string;
  readonly canvasTitle?: string;
  readonly snippet: string;
  readonly matchRanges?: ReadonlyArray<ThreadSearchMatchRange>;
  readonly updatedAt?: string;
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
  /**
   * The modes searched. The listed threads belong to `mode`, so their title
   * matches show only when the scope includes it; the host's hits carry
   * their own mode. Defaults to `mode` alone.
   */
  readonly scope?: ThreadSearchScope;
  readonly query: string;
  readonly threads: ReadonlyArray<ThreadSearchThread>;
  readonly projects: ReadonlyArray<ThreadSearchProject>;
  readonly contentHits?: ReadonlyArray<ThreadSearchContentHit>;
  readonly contentTruncated?: boolean;
  readonly unfiledLabel?: ThreadSearchUnfiledLabel;
  readonly limit?: number;
}

/**
 * Thread search, in the current mode or across every mode.
 *
 * Title matches use only the threads the host already listed for this window.
 * The host's hits (titles, messages, and tool text, each in its own mode) join
 * the same live/archived groups with snippets and turn deep-links. Project,
 * `Recents`, and `Unfiled` remain folder words on a hit, never filters.
 */
export function buildThreadSearchResults(
  input: BuildThreadSearchResultsInput,
): ThreadSearchResults {
  const needle = normalize(input.query);
  const limit = input.limit ?? THREAD_SEARCH_GROUP_LIMIT;
  const projectNames = new Map(input.projects.map((project) => [project.id, project.name]));
  const unfiledLabel = input.unfiledLabel ?? "No Project";

  const scope = input.scope ?? input.mode;
  const titleMatches = input.threads
    .filter((thread) => thread.mode === input.mode && (scope === "all" || scope === input.mode))
    .filter((thread) => thread.lifecycle === "active" || thread.lifecycle === "archived")
    .filter((thread) => needle === "" || normalize(thread.title).includes(needle))
    .sort(compareThreads);

  // A host title match for a thread the listed titles already matched would
  // print the same row twice.
  const listedTitles = new Set(titleMatches.map((thread) => `${thread.mode}:${thread.threadId}`));
  const contentMatches =
    needle !== ""
      ? (input.contentHits ?? []).filter(
          (hit) =>
            (hit.lifecycle === "active" || hit.lifecycle === "archived") &&
            !(
              hit.field === "title" && listedTitles.has(`${hit.mode ?? input.mode}:${hit.threadId}`)
            ),
        )
      : [];

  const liveTitle = titleMatches.filter((thread) => thread.lifecycle !== "archived");
  const archivedTitle = titleMatches.filter((thread) => thread.lifecycle === "archived");
  const liveContent = contentMatches.filter((hit) => hit.lifecycle !== "archived");
  const archivedContent = contentMatches.filter((hit) => hit.lifecycle === "archived");

  const groups: ThreadSearchGroup[] = [];
  const liveHits = mergeGroupHits(
    input.mode,
    liveTitle,
    liveContent,
    projectNames,
    unfiledLabel,
    limit,
  );
  if (liveHits.hits.length > 0) {
    groups.push({ id: "threads", label: "Threads", hits: liveHits.hits });
  }
  const archivedHits = mergeGroupHits(
    input.mode,
    archivedTitle,
    archivedContent,
    projectNames,
    unfiledLabel,
    limit,
  );
  if (archivedHits.hits.length > 0) {
    groups.push({ id: "archived", label: "Archived", hits: archivedHits.hits });
  }
  const hitCount = groups.reduce((total, group) => total + group.hits.length, 0);
  const truncated =
    liveHits.truncated ||
    archivedHits.truncated ||
    input.contentTruncated === true ||
    hitCount <
      liveTitle.length + archivedTitle.length + liveContent.length + archivedContent.length;
  return { groups, hitCount, truncated };
}

/** Flat hit order for arrow-key navigation across both groups. */
export function flattenThreadSearchHits(
  results: ThreadSearchResults,
): ReadonlyArray<ThreadSearchHit> {
  return results.groups.flatMap((group) => group.hits);
}

function mergeGroupHits(
  mode: SidebarActivityMode,
  titleThreads: ReadonlyArray<ThreadSearchThread>,
  contentHits: ReadonlyArray<ThreadSearchContentHit>,
  projectNames: ReadonlyMap<string, string>,
  unfiledLabel: ThreadSearchUnfiledLabel,
  limit: number,
): { readonly hits: ReadonlyArray<ThreadSearchHit>; readonly truncated: boolean } {
  const titleHits = titleThreads.map((thread) => toTitleHit(thread, projectNames, unfiledLabel));
  const bodyHits = contentHits.map((hit) =>
    toContentHit(hit.mode ?? mode, hit, projectNames, unfiledLabel),
  );
  // Title rows first so a known thread stays easy to open; content rows follow
  // with their snippets rather than replacing the title match.
  const merged = [...titleHits, ...bodyHits];
  return { hits: merged.slice(0, limit), truncated: merged.length > limit };
}

function toTitleHit(
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
    ...(thread.workerOf === undefined ? {} : { workerOf: thread.workerOf }),
  };
}

function toContentHit(
  mode: SidebarActivityMode,
  hit: ThreadSearchContentHit,
  projectNames: ReadonlyMap<string, string>,
  unfiledLabel: ThreadSearchUnfiledLabel,
): ThreadSearchHit {
  const folderLabel =
    hit.projectId === undefined ? unfiledLabel : (projectNames.get(hit.projectId) ?? unfiledLabel);
  return {
    threadId: hit.threadId,
    mode,
    title: hit.title,
    ...(hit.projectId === undefined ? {} : { projectId: hit.projectId }),
    folderLabel,
    archived: hit.lifecycle === "archived",
    ...(hit.turnId === undefined ? {} : { turnId: hit.turnId }),
    ...(hit.field === undefined ? {} : { field: hit.field }),
    ...(hit.canvasId === undefined ? {} : { canvasId: hit.canvasId }),
    ...(hit.canvasTitle === undefined ? {} : { canvasTitle: hit.canvasTitle }),
    // A title match's snippet is the title the row already shows.
    ...(hit.field === "title" ? {} : { snippet: hit.snippet }),
    ...(hit.field === "title" || hit.matchRanges === undefined || hit.matchRanges.length === 0
      ? {}
      : { matchRanges: hit.matchRanges }),
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
