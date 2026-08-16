import type { ChatThreadNavigationItem } from "../shell/navigationModel";

/**
 * Thread grouping shared by the Project sidebar and the Project Overview.
 *
 * Both surfaces answer the same question — which threads belong to this Project,
 * and which belong to no Project the mode knows about — so both ask it here. A
 * second implementation would let the two disagree about a thread whose
 * `projectId` names a Project the mode cannot see.
 */
export interface ProjectThreadGrouping {
  readonly byProjectId: ReadonlyMap<string, ReadonlyArray<ChatThreadNavigationItem>>;
  /** Threads with no Project, or whose Project this mode does not list. */
  readonly unfiled: ReadonlyArray<ChatThreadNavigationItem>;
}

export function groupThreadsByProject(
  threads: ReadonlyArray<ChatThreadNavigationItem>,
  projects: ReadonlyArray<{ readonly id: string }>,
): ProjectThreadGrouping {
  const known = new Set(projects.map((project) => String(project.id)));
  const byProjectId = new Map<string, ChatThreadNavigationItem[]>();
  const unfiled: ChatThreadNavigationItem[] = [];
  for (const thread of threads) {
    const projectId = thread.projectId;
    if (projectId === undefined || !known.has(projectId)) {
      unfiled.push(thread);
      continue;
    }
    const existing = byProjectId.get(projectId);
    if (existing === undefined) {
      byProjectId.set(projectId, [thread]);
    } else {
      existing.push(thread);
    }
  }
  return { byProjectId, unfiled };
}

/** The threads the sidebar nests under one Project, by the same rule. */
export function threadsInProject(
  threads: ReadonlyArray<ChatThreadNavigationItem>,
  projectId: string,
): ReadonlyArray<ChatThreadNavigationItem> {
  const id = String(projectId);
  return groupThreadsByProject(threads, [{ id }]).byProjectId.get(id) ?? [];
}

/**
 * Orders threads by the recency the host already reports, newest first, and
 * falls back to the title so equal or missing timestamps stay stable. This is
 * the ordering the sidebar activity view uses; nothing here derives a timestamp
 * the host did not send.
 */
export function orderThreadsByRecency(
  threads: ReadonlyArray<ChatThreadNavigationItem>,
): ReadonlyArray<ChatThreadNavigationItem> {
  return [...threads].sort((left, right) => {
    const leftUpdatedAt = left.updatedAt ?? "";
    const rightUpdatedAt = right.updatedAt ?? "";
    if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt.localeCompare(leftUpdatedAt);
    return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
  });
}
