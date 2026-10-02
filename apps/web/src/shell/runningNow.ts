import type { CodeBoardCard } from "@octant/contracts";
import {
  threadRowActivity,
  type ChatThreadNavigationItem,
  type ThreadProviderIdentity,
} from "./navigationModel";

const RUNNING_NOW_LIMIT = 4;

/**
 * One executing thread on a start screen. Every field is something the host
 * already projects for the thread; a field the host does not know is absent
 * rather than filled in, so a card never claims more than the host said.
 */
export interface RunningNowCard {
  readonly threadId: string;
  readonly projectId?: string;
  readonly title: string;
  readonly projectName?: string;
  /** Code only: the branch the thread's checkout is on. */
  readonly branch?: string;
  readonly provider?: ThreadProviderIdentity;
  /** The host's own latest line about what the thread is doing. */
  readonly latestActivity?: string;
  /**
   * When the thread last moved. The host keeps no turn start time on the
   * board or in navigation, so the card says how long ago it was active
   * rather than how long it has run.
   */
  readonly activeAt?: string;
}

/**
 * Threads that finished a turn the person has not opened since. A running
 * thread is not waiting for review yet, and a snoozed or completed one left
 * the list on purpose, the same rule the sidebar's To review count follows.
 */
export function reviewWaitingCount(threads: ReadonlyArray<ChatThreadNavigationItem>): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.shelf !== undefined) continue;
    if (threadRowActivity(thread) === "working") continue;
    if (thread.unread === true) count += 1;
  }
  return count;
}

/** The Code board's executing cards, which carry the branch and the host's activity line. */
export function runningCardsFromBoard(
  cards: ReadonlyArray<CodeBoardCard>,
  lookup: {
    readonly projectNames: ReadonlyMap<string, string>;
    readonly providers: ReadonlyMap<string, ThreadProviderIdentity>;
  },
): ReadonlyArray<RunningNowCard> {
  return cards
    .filter((card) => card.executing)
    .slice(0, RUNNING_NOW_LIMIT)
    .map((card) => {
      const projectName = lookup.projectNames.get(String(card.projectId));
      const provider = lookup.providers.get(String(card.providerInstanceId));
      const branch =
        card.worktree.kind === "available" && card.worktree.head.kind === "branch"
          ? card.worktree.head.name
          : undefined;
      return {
        threadId: String(card.threadId),
        projectId: String(card.projectId),
        title: card.title,
        ...(projectName === undefined ? {} : { projectName }),
        ...(branch === undefined ? {} : { branch }),
        ...(provider === undefined ? {} : { provider }),
        ...(card.childAgents.latestSummary === undefined
          ? {}
          : { latestActivity: card.childAgents.latestSummary }),
        ...(card.lastMeaningfulActivityAt === null
          ? {}
          : { activeAt: card.lastMeaningfulActivityAt }),
      };
    });
}

/** A row is running only while the host projects it as executing; a rested row never is. */
function isRunningThread(thread: ChatThreadNavigationItem): boolean {
  return thread.shelf === undefined && threadRowActivity(thread) === "working";
}

/** How many navigation rows are running, however many cards the screen has room for. */
export function runningThreadCount(threads: ReadonlyArray<ChatThreadNavigationItem>): number {
  return threads.filter(isRunningThread).length;
}

/**
 * Executing threads read from navigation rows, for a mode with no board card
 * to read (Work). A row is running only while the host projects it as
 * executing, and a rested row never is.
 */
export function runningCardsFromNavigation(
  threads: ReadonlyArray<ChatThreadNavigationItem>,
  projectNames: ReadonlyMap<string, string>,
): ReadonlyArray<RunningNowCard> {
  return threads
    .filter(isRunningThread)
    .toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, RUNNING_NOW_LIMIT)
    .map((thread) => {
      const projectName =
        thread.projectId === undefined ? undefined : projectNames.get(thread.projectId);
      return {
        threadId: thread.threadId,
        title: thread.title,
        ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
        ...(projectName === undefined ? {} : { projectName }),
        ...(thread.provider === undefined ? {} : { provider: thread.provider }),
        ...(thread.updatedAt === undefined ? {} : { activeAt: thread.updatedAt }),
      };
    });
}
