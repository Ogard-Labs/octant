import type { CodeBoardCard, CodeBoardStatus, CodeBoardStatusReason } from "@octant/contracts";
import {
  groupThreadBoardCards,
  threadBoardStatusLabel,
  threadBoardStatusReasonLabel,
  type GroupThreadBoardCardsOptions,
  type ThreadBoardColumn,
  type ThreadBoardGrouping,
  type ThreadBoardProjectRef,
} from "../threadBoard/threadBoardGrouping";

export type CodeBoardGrouping = ThreadBoardGrouping;
export type CodeBoardColumn = ThreadBoardColumn<CodeBoardCard>;
export type CodeBoardProjectRef = ThreadBoardProjectRef;
export type GroupCodeBoardCardsOptions = GroupThreadBoardCardsOptions;

export const codeBoardStatusLabel = threadBoardStatusLabel;
export const codeBoardStatusReasonLabel = threadBoardStatusReasonLabel;

export function groupCodeBoardCards(
  cards: readonly CodeBoardCard[],
  grouping: CodeBoardGrouping,
  options: GroupCodeBoardCardsOptions,
): readonly CodeBoardColumn[] {
  return groupThreadBoardCards(cards, grouping, options);
}

export type { CodeBoardStatus, CodeBoardStatusReason };

/**
 * The window's coordinators, by id, with their titles. A card carries its
 * worker's coordinator id from the host; the title comes from the window's
 * thread list, since a title is the thread's own and the board read names
 * only the worker (docs/design/workspace.md#coordinators). The designated
 * planner is listed, because it reads as a coordinator.
 */
export interface CodeBoardCoordinators {
  readonly titleByCoordinator: ReadonlyMap<string, string>;
}

/**
 * The coordinator title each worker in the window's thread list belongs to,
 * for the "via <coordinator>" label on a worker's Needs you and Inbox rows.
 */
export function coordinatorTitleByWorker(
  threads: ReadonlyArray<{
    readonly threadId: string;
    readonly title: string;
    readonly coordinator?: true;
    readonly coordinatorThreadId?: string;
  }>,
): ReadonlyMap<string, string> {
  const { titleByCoordinator } = codeBoardCoordinators(threads);
  const byWorker = new Map<string, string>();
  for (const thread of threads) {
    if (thread.coordinatorThreadId === undefined) continue;
    const title = titleByCoordinator.get(String(thread.coordinatorThreadId));
    if (title !== undefined) byWorker.set(String(thread.threadId), title);
  }
  return byWorker;
}

export function codeBoardCoordinators(
  threads: ReadonlyArray<{
    readonly threadId: string;
    readonly title: string;
    readonly coordinator?: true;
  }>,
): CodeBoardCoordinators {
  return {
    titleByCoordinator: new Map(
      threads
        .filter((thread) => thread.coordinator === true)
        .map((thread) => [String(thread.threadId), thread.title]),
    ),
  };
}
