import type { WindowWorkspace, WorkspaceLayoutNode } from "@octant/contracts";

/**
 * Window-local memory of Browser sessions the shell has already offered.
 *
 * The activity preview remounts with its pane, so a component ref cannot be
 * the record of that offer: returning to the thread looked like a first
 * appearance and reopened a Browser the person had just left.
 */

export type BrowserActivityRevealDecision = "reveal" | "ignore";

export interface BrowserActivityAnnouncementStore {
  remember(threadId: string, sessionIds: ReadonlyArray<string>): BrowserActivityRevealDecision;
}

export function createBrowserActivityAnnouncementStore(): BrowserActivityAnnouncementStore {
  const announcedByThread = new Map<string, Set<string>>();
  return {
    remember(threadId, sessionIds) {
      const announced = announcedByThread.get(threadId) ?? new Set<string>();
      const decision = decideBrowserActivityReveal({
        announcedSessionIds: announced,
        activeSessionIds: sessionIds,
      });
      announcedByThread.set(threadId, decision.nextAnnouncedSessionIds);
      return decision.decision;
    },
  };
}

export function decideBrowserActivityReveal(input: {
  readonly announcedSessionIds: ReadonlySet<string>;
  readonly activeSessionIds: ReadonlyArray<string>;
}): {
  readonly decision: BrowserActivityRevealDecision;
  readonly nextAnnouncedSessionIds: Set<string>;
} {
  const nextAnnouncedSessionIds = new Set(input.announcedSessionIds);
  if (input.activeSessionIds.length === 0) {
    return { decision: "ignore", nextAnnouncedSessionIds };
  }
  const unseen = input.activeSessionIds.filter((id) => !input.announcedSessionIds.has(id));
  if (unseen.length === 0) {
    return { decision: "ignore", nextAnnouncedSessionIds };
  }
  for (const id of input.activeSessionIds) nextAnnouncedSessionIds.add(id);
  const overlap = input.activeSessionIds.some((id) => input.announcedSessionIds.has(id));
  return { decision: overlap ? "ignore" : "reveal", nextAnnouncedSessionIds };
}

/**
 * Whether some pane of the workspace shows this thread's shared Browser. A pane
 * bound to one host-opened context (a link or a local server) is a view of its
 * own page, not of the agent's session, so it does not count.
 */
export function threadHasBrowserSurface(workspace: WindowWorkspace, threadId: string): boolean {
  return (["chat", "work", "code"] as const).some((mode) =>
    layoutHasThreadBrowser(workspace.layouts[mode], threadId),
  );
}

function layoutHasThreadBrowser(layout: WorkspaceLayoutNode, threadId: string): boolean {
  if (layout.kind === "pane") {
    return (
      layout.surface.kind === "browser" &&
      layout.surface.contextId === undefined &&
      layout.surface.threadId !== undefined &&
      String(layout.surface.threadId) === String(threadId)
    );
  }
  return (
    layoutHasThreadBrowser(layout.first, threadId) ||
    layoutHasThreadBrowser(layout.second, threadId)
  );
}
