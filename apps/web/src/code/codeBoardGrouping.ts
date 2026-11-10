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
 * Which threads are coordinators and which coordinator each worker belongs to,
 * read from the window's thread list because the board read does not carry
 * the role (docs/design/workspace.md#coordinators).
 */
export interface CodeBoardCoordinatorLineage {
  readonly coordinatorThreadIds: ReadonlySet<string>;
  readonly coordinatorTitleByWorker: ReadonlyMap<string, string>;
}

export function codeBoardCoordinatorLineage(
  threads: ReadonlyArray<{
    readonly threadId: string;
    readonly title: string;
    readonly coordinator?: true;
    readonly coordinatorThreadId?: string;
  }>,
): CodeBoardCoordinatorLineage {
  const titles = new Map(
    threads
      .filter((thread) => thread.coordinator === true)
      .map((thread) => [String(thread.threadId), thread.title]),
  );
  const coordinatorTitleByWorker = new Map<string, string>();
  for (const thread of threads) {
    if (thread.coordinatorThreadId === undefined) continue;
    const title = titles.get(String(thread.coordinatorThreadId));
    if (title !== undefined) coordinatorTitleByWorker.set(String(thread.threadId), title);
  }
  return { coordinatorThreadIds: new Set(titles.keys()), coordinatorTitleByWorker };
}
