/**
 * Fork lineage among the threads a list already shows.
 *
 * A parent id that names no visible thread is an explicit missing origin, not a
 * root: archived, deleted, and purged sources stay in the provenance the client
 * holds, and pretending they never existed would hide that the thread is a fork.
 */

export interface LineageThread {
  readonly threadId: string;
  readonly title: string;
  readonly lineageParentThreadId?: string;
}

export type LineageAncestor =
  | { readonly kind: "origin-unavailable" }
  | { readonly kind: "thread"; readonly threadId: string; readonly title: string };

export interface LineageDescendant {
  readonly threadId: string;
  readonly title: string;
}

function threadKey(threadId: string): string {
  return String(threadId);
}

function indexById(threads: ReadonlyArray<LineageThread>): ReadonlyMap<string, LineageThread> {
  const byId = new Map<string, LineageThread>();
  for (const thread of threads) {
    byId.set(threadKey(thread.threadId), thread);
  }
  return byId;
}

/**
 * Origin-first ancestor chain for a visible thread. Stops at a missing parent
 * with an explicit unavailable origin, and stops if a parent id repeats so a
 * cyclic chain cannot walk forever. Contracts already refuse self-reference;
 * the visited set is the renderer's last line if that invariant is ever broken.
 */
export function threadAncestorChain(
  threadId: string,
  threads: ReadonlyArray<LineageThread>,
): ReadonlyArray<LineageAncestor> {
  const byId = indexById(threads);
  const start = byId.get(threadKey(threadId));
  if (start === undefined) return [];
  const walked: LineageAncestor[] = [];
  const visited = new Set<string>([threadKey(threadId)]);
  let current: LineageThread | undefined = start;
  while (current?.lineageParentThreadId !== undefined) {
    const parentId = threadKey(current.lineageParentThreadId);
    if (visited.has(parentId)) break;
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (parent === undefined) {
      walked.push({ kind: "origin-unavailable" });
      break;
    }
    walked.push({
      kind: "thread",
      threadId: threadKey(parent.threadId),
      title: parent.title,
    });
    current = parent;
  }
  return walked.reverse();
}

/** Direct forks of a thread, titled in stable order. Grandchildren are omitted. */
export function threadDirectDescendants(
  threadId: string,
  threads: ReadonlyArray<LineageThread>,
): ReadonlyArray<LineageDescendant> {
  const parentId = threadKey(threadId);
  const descendants: LineageDescendant[] = [];
  for (const thread of threads) {
    if (
      thread.lineageParentThreadId !== undefined &&
      threadKey(thread.lineageParentThreadId) === parentId
    ) {
      descendants.push({ threadId: threadKey(thread.threadId), title: thread.title });
    }
  }
  return descendants.sort((left, right) =>
    left.title.localeCompare(right.title, undefined, { sensitivity: "base" }),
  );
}

/**
 * Whether a row should carry the fork mark: it was forked, or another visible
 * thread names it as parent. A thread with neither provenance nor forks does
 * not.
 */
export function threadHasLineage(
  thread: LineageThread,
  threads: ReadonlyArray<LineageThread>,
): boolean {
  if (thread.lineageParentThreadId !== undefined) return true;
  const id = threadKey(thread.threadId);
  return threads.some(
    (candidate) =>
      candidate.lineageParentThreadId !== undefined &&
      threadKey(candidate.lineageParentThreadId) === id,
  );
}

/** Title of a visible parent, or absent when the parent is no longer in the list. */
export function lineageParentTitle(
  thread: LineageThread,
  threads: ReadonlyArray<LineageThread>,
): string | undefined {
  if (thread.lineageParentThreadId === undefined) return undefined;
  const parent = indexById(threads).get(threadKey(thread.lineageParentThreadId));
  return parent?.title;
}
