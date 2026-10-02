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
 * One checkout a Project's threads run in, as the tree draws it.
 *
 * `primary` is the folder the Project is bound to. The host reports it as an
 * `existing-worktree` because it is a Git working tree it did not create, and
 * only a worktree the host made for a thread (`managed-worktree`) is another
 * place to work. A thread with no checkout chip has no branch to name, so its
 * group carries none.
 */
export interface CheckoutThreadGroup {
  readonly key: string;
  readonly kind: "primary" | "worktree";
  readonly branch?: string;
  readonly threads: ReadonlyArray<ChatThreadNavigationItem>;
}

/**
 * Splits one Project's threads by the checkout they run in, or answers
 * `undefined` when there is nothing to split.
 *
 * A Project whose threads all share a checkout is the common case, and a
 * heading that only restates it on every Project is noise. The level exists
 * only where it separates something. Groups keep the order their first thread
 * arrived in, primary checkouts first, so the tree order the caller chose still
 * decides which thread leads.
 */
export function groupThreadsByCheckout(
  threads: ReadonlyArray<ChatThreadNavigationItem>,
): ReadonlyArray<CheckoutThreadGroup> | undefined {
  const byKey = new Map<
    string,
    { readonly group: CheckoutThreadGroup; readonly members: ChatThreadNavigationItem[] }
  >();
  for (const thread of threads) {
    const chip = thread.checkoutChip;
    const key = chip === undefined ? "none" : `${chip.checkoutKind}\0${chip.label}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.members.push(thread);
      continue;
    }
    const members = [thread];
    byKey.set(key, {
      members,
      group: {
        key,
        kind: chip?.checkoutKind === "managed-worktree" ? "worktree" : "primary",
        ...(chip === undefined ? {} : { branch: chip.label }),
        threads: members,
      },
    });
  }
  if (byKey.size < 2) return undefined;
  const groups = [...byKey.values()].map((entry) => entry.group);
  return [
    ...groups.filter((group) => group.kind === "primary"),
    ...groups.filter((group) => group.kind === "worktree"),
  ];
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
