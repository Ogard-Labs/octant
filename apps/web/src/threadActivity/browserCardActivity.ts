import { useSyncExternalStore } from "react";

/**
 * What a thread pane knows about the agent's Browser session, shared with the
 * dock beside it. The pane polls for the session already, and the dock's card
 * and the window's dock toggle need only the answer, so neither polls for it.
 */
interface BrowserActivityReport {
  /** The session's context, while the agent has a session in play. */
  readonly contextId: string | undefined;
  /** Whether the thread's shared Browser is on screen: a pane, a tile, or the bottom panel. */
  readonly inSight: boolean;
}

/**
 * Reports by thread, then by the pane that made them: two panes can show one
 * thread, and one of them going away must not retract the other's report.
 */
const reports = new Map<string, Map<symbol, BrowserActivityReport>>();
/**
 * Browser sessions whose card the person closed, by thread and context. Held
 * for the life of the page because the card remounts with its dock, and a card
 * that came back after being closed would not be closed.
 */
const dismissed = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Reports the thread's Browser session; the returned function withdraws the report. */
export function reportBrowserActivity(threadId: string, report: BrowserActivityReport): () => void {
  const owner = Symbol(threadId);
  const forThread = reports.get(threadId) ?? new Map<symbol, BrowserActivityReport>();
  forThread.set(owner, report);
  reports.set(threadId, forThread);
  notify();
  return () => {
    forThread.delete(owner);
    if (forThread.size === 0 && reports.get(threadId) === forThread) reports.delete(threadId);
    notify();
  };
}

/** Closes the card of this session, for as long as the page lives. */
export function dismissBrowserCard(threadId: string, contextId: string): void {
  dismissed.add(`${threadId}:${contextId}`);
  notify();
}

/**
 * Closes the card of the thread's live session, whether or not the Browser is
 * in sight: closing the Browser tab dismisses it for the session too.
 */
export function dismissLiveBrowserCard(threadId: string): void {
  const live = [...(reports.get(threadId)?.values() ?? [])].find(
    (report) => report.contextId !== undefined,
  );
  if (live?.contextId !== undefined) dismissBrowserCard(threadId, live.contextId);
}

/**
 * The context of the session whose card the dock should show without the
 * person minimising the Browser: the agent has a session, the Browser is out of
 * sight, and the person has not closed this session's card.
 */
export function agentBrowserCardContext(threadId: string | undefined): string | undefined {
  if (threadId === undefined) return undefined;
  const forThread = reports.get(threadId);
  if (forThread === undefined) return undefined;
  const all = [...forThread.values()];
  if (all.some((report) => report.inSight)) return undefined;
  const live = all.find((report) => report.contextId !== undefined);
  if (live?.contextId === undefined) return undefined;
  return dismissed.has(`${threadId}:${live.contextId}`) ? undefined : live.contextId;
}

export function useAgentBrowserCard(threadId: string | undefined): string | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => agentBrowserCardContext(threadId),
    () => undefined,
  );
}

/** Forgets every report and dismissal; tests start each case from a clean page. */
export function resetBrowserCardActivityForTests(): void {
  reports.clear();
  dismissed.clear();
  notify();
}
