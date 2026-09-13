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
